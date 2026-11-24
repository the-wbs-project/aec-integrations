import { expect, test, type Page } from './fixtures';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

import { untilHydrated } from './hydration';
import { sectionNavProduct } from './section-nav-product';

/**
 * AECI-1768: the sticky section bar (`shared/section-nav/section-nav.ts`), and AECI-1843: its
 * links keep the query string, so a click is never a page load.
 *
 * Each test opens a seeded product whose page has an Integrations entry and is tall enough to
 * scroll. The walk matters: the thin local seed puts short products first. It runs once per
 * worker in `section-nav-product.ts` (AECI-2027), and each test reuses the path it found.
 */
async function productPath(page: Page): Promise<string> {
  const { seeded, path } = await sectionNavProduct(page);
  test.skip(!seeded, 'no products seeded in this environment');
  test.skip(!path, 'no seeded product is tall enough for the section nav');
  return path!;
}

async function openProduct(page: Page, query = ''): Promise<string> {
  const path = await productPath(page);
  await page.goto(`${path}${query}`);
  await expect(page.locator('aec-product-detail')).toBeVisible();
  return path;
}

/** Waits for hydration and for the hydrated hrefs (the server drops the query). */
async function hydrated(page: Page, path: string, query = ''): Promise<void> {
  const nav = page.locator('aec-section-nav');
  await untilHydrated(nav);
  await expect(nav.locator('a[data-section-id="integrations"]')).toHaveAttribute(
    'href',
    `${path}${query}#integrations`,
    { timeout: 15_000 },
  );
}

/**
 * Waits for every finite animation to finish, so a computed style read is not mid-transition
 * (first-paint transitions, until AECI-1854). Looping skeleton pulses are ignored.
 */
async function animationsSettled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.getAnimations().filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
            .length,
      ),
    )
    .toBe(0);
}

/** Records `scrollY` on every frame until `stopSampler`. */
async function startSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ys: number[]; __run: boolean };
    w.__ys = [Math.round(window.scrollY)];
    w.__run = true;
    const tick = () => {
      w.__ys.push(Math.round(window.scrollY));
      if (w.__run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Waits until `scrollY` is still, then returns the distinct offsets the sampler saw. */
async function settledOffsets(page: Page): Promise<number[]> {
  let last = -1;
  await expect
    .poll(
      async () => {
        const y = await page.evaluate(() => Math.round(window.scrollY));
        const still = y === last;
        last = y;
        return still;
      },
      { intervals: [200], timeout: 10_000 },
    )
    .toBe(true);
  return page.evaluate(() => {
    const w = window as unknown as { __ys: number[]; __run: boolean };
    w.__run = false;
    return w.__ys.filter((y, i, a) => i === 0 || y !== a[i - 1]);
  });
}

function countDocumentLoads(page: Page): () => number {
  let loads = 0;
  page.on('request', (r) => {
    if (r.resourceType() === 'document') loads++;
  });
  return () => loads;
}

/** A token's computed colour, as the browser serialises it, read from a probe element. */
const tokenColor = (page: Page, token: string) =>
  page.evaluate((t) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${t})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, token);

const navBottom = (page: Page) =>
  page.evaluate(() => document.querySelector('aec-section-nav')!.getBoundingClientRect().bottom);

test.describe('section nav (AECI-1768, AECI-1843)', () => {
  // AECI-2027 kept only the query case. It makes every check the bare-path case made, and
  // also proves the query is kept. The bare path is covered in scroll-restoration.spec.ts:
  // "a section-nav click animates and lands the section below the nav" (animates, heading
  // below the bar) and "a second section link clicked mid-glide lands on the second
  // section" (same document).
  for (const query of ['?utm_source=e2e&utm_campaign=nov']) {
    test(`a click animates in place with no page load, query kept`, async ({ page }) => {
      const path = await openProduct(page, query);
      await hydrated(page, path, query);
      await page.evaluate(() => {
        (window as unknown as { __mark: boolean }).__mark = true;
        window.scrollTo({ top: 0, behavior: 'instant' });
      });
      const loads = countDocumentLoads(page);

      await startSampler(page);
      await page.locator('aec-section-nav a[data-section-id="integrations"]').click();
      await expect(page).toHaveURL(`${path}${query}#integrations`);
      const offsets = await settledOffsets(page);

      expect(loads(), 'a section click must not load a document').toBe(0);
      expect(await page.evaluate(() => (window as unknown as { __mark?: boolean }).__mark)).toBe(
        true,
      );
      expect(offsets.length, `the jump animates, saw ${offsets.join(', ')}`).toBeGreaterThan(2);
      const gap = await page.evaluate(
        () =>
          document.getElementById('integrations-title')!.getBoundingClientRect().top -
          document.querySelector('aec-section-nav')!.getBoundingClientRect().bottom,
      );
      expect(gap, 'the heading lands below the bar').toBeGreaterThanOrEqual(0);
      await expect(
        page.locator('aec-section-nav a[data-section-id="integrations"]'),
      ).toHaveAttribute('aria-current', 'location');
    });
  }

  test('under reduced motion a click jumps without animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const path = await openProduct(page);
    await hydrated(page, path);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    // At 720px the hero can push the bar just below the fold (AECI-1720's taller ratings
    // panel), and Playwright's own scroll to the link would then read as a first step.
    // Bring the link into view before sampling, so only the jump itself is measured.
    const link = page.locator('aec-section-nav a[data-section-id="integrations"]');
    await link.scrollIntoViewIfNeeded();
    await startSampler(page);
    await link.click();
    const offsets = await settledOffsets(page);
    expect(offsets).toHaveLength(2);
    expect(offsets[1]).toBeGreaterThan(0);
  });

  // AECI-2020: the stuck name is a link to #top. A click scrolls back to the page start in the
  // same document, and the bar returns to rest with the first link current.
  test('a click on the stuck name goes back to the top with no page load', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const path = await openProduct(page);
    await hydrated(page, path);
    const nav = page.locator('aec-section-nav');
    await page.evaluate(() =>
      document.getElementById('integrations')!.scrollIntoView({ behavior: 'instant' }),
    );
    await expect(nav).toHaveAttribute('data-stuck', '');
    const loads = countDocumentLoads(page);

    await nav.getByTestId('section-nav-top').click();
    await expect(page).toHaveURL(`${path}#top`);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    expect(loads(), 'the click must not load a document').toBe(0);
    await expect(nav).not.toHaveAttribute('data-stuck', '');
    await expect(nav.locator('nav a').first()).toHaveAttribute('aria-current', 'location');
  });

  test('aria-current follows the scroll', async ({ page }) => {
    const path = await openProduct(page);
    await hydrated(page, path);
    const current = page.locator('aec-section-nav a[aria-current="location"]');
    await expect(current).toHaveCount(1);
    const first = await current.getAttribute('data-section-id');

    await page.evaluate(() =>
      document.getElementById('reviews')!.scrollIntoView({ behavior: 'instant' }),
    );
    await expect(current).toHaveAttribute('data-section-id', 'reviews');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(current).toHaveAttribute('data-section-id', first!);
  });

  test('a deep link lands the section below the bar and marks it current', async ({ page }) => {
    const path = await openProduct(page);
    // A fresh document load, not a same-document hash change from the page openProduct left.
    await page.goto('about:blank');
    await page.goto(`${path}#reviews`);
    await untilHydrated(page.locator('aec-section-nav'));
    await expect(page.locator('#reviews-title')).toBeInViewport();
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            document.getElementById('reviews-title')!.getBoundingClientRect().top -
            document.querySelector('aec-section-nav')!.getBoundingClientRect().bottom,
        ),
      )
      .toBeGreaterThanOrEqual(0);
    // Near the top too, not just somewhere below the bar (the bound the removed
    // scroll-restoration `#integrations` deep-link test held, AECI-2027).
    expect(
      await page.locator('#reviews').evaluate((el) => el.getBoundingClientRect().top),
    ).toBeLessThan(160);
    await expect(page.locator('aec-section-nav a[aria-current="location"]')).toHaveAttribute(
      'data-section-id',
      'reviews',
    );
  });

  // AECI-1849 is not fixed here. These pin what Back and Forward do today: the URL and the
  // document are right. Where Back lands is recorded as an annotation, not asserted.
  test('Back and Forward move between the jump and the page in one document', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const path = await openProduct(page);
    await hydrated(page, path);
    await page.evaluate(() => {
      (window as unknown as { __mark: boolean }).__mark = true;
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.locator('aec-section-nav a[data-section-id="integrations"]').click();
    await expect(page).toHaveURL(`${path}#integrations`);
    const jumped = await page.evaluate(() => Math.round(window.scrollY));

    await page.goBack();
    await expect(page).toHaveURL(path);
    // A fixed wait on purpose. Where Back lands is recorded, not asserted, because
    // it is wrong today (AECI-1849). With no right value to wait for, the pause
    // only lets the scroll restore finish.
    await page.waitForTimeout(500);
    const back = await page.evaluate(() => Math.round(window.scrollY));
    test.info().annotations.push({
      type: 'AECI-1849',
      description: `reduced motion: jump at ${jumped}px, Back landed at ${back}px (0 is correct)`,
    });

    await page.goForward();
    await expect(page).toHaveURL(`${path}#integrations`);
    expect(await page.evaluate(() => (window as unknown as { __mark?: boolean }).__mark)).toBe(
      true,
    );
  });

  test('keyboard: Tab to a link and Enter jumps; a control reached by Tab is not hidden under the bar', async ({
    page,
  }) => {
    const path = await openProduct(page);
    await hydrated(page, path);
    const link = page.locator('aec-section-nav a[data-section-id="integrations"]');
    await link.focus();
    await expect(link).toBeFocused();
    const ring = await link.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBe('2px');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${path}#integrations`);

    // WCAG 2.4.11. Put a focusable control after the bar just under the stuck bar, focus the
    // control after it without scrolling, then Shift+Tab back onto it.
    const pair = await page.evaluate(() => {
      // Room to scroll any control up under the bar on a short seeded page.
      const spacer = document.createElement('div');
      spacer.style.height = '200vh';
      document.body.appendChild(spacer);
      window.scrollTo({ top: 0, behavior: 'instant' });
      const nav = document.querySelector('aec-section-nav')!;
      const restBottom = nav.getBoundingClientRect().bottom;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const all = [
        ...document.querySelectorAll<HTMLElement>(
          'aec-section-nav ~ * a[href], aec-section-nav ~ * button',
        ),
      ].filter(
        // The metadata aside is sticky itself, so its controls never pass under the bar.
        (el) => el.getClientRects().length > 0 && el.tabIndex >= 0 && !el.closest('aside'),
      );
      // A control the page can scroll to 20px from the top, with the bar stuck by then.
      const at = all.findIndex((el, i) => {
        const top = el.getBoundingClientRect().top;
        return i + 1 < all.length && top > restBottom + 120 && top - 20 <= maxScroll;
      });
      if (at < 0) return null;
      all[at]!.setAttribute('data-e2e-target', '');
      all[at + 1]!.setAttribute('data-e2e-next', '');
      return true;
    });
    test.skip(!pair, 'no focusable pair far enough down this page');
    // Deferred blocks render as they scroll in and move the target, so place it twice.
    const placeUnderBar = () =>
      page.evaluate(() => {
        const target = document.querySelector<HTMLElement>('[data-e2e-target]')!;
        const next = document.querySelector<HTMLElement>('[data-e2e-next]')!;
        next.focus({ preventScroll: true });
        const top = target.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: top - 20, behavior: 'instant' });
      });
    await placeUnderBar();
    // A fixed wait on purpose. The deferred blocks that render as they scroll in give
    // no signal the test can name, so the pause lets them render before the second
    // placement.
    await page.waitForTimeout(500);
    await placeUnderBar();
    // Stuck, and covering the target.
    expect(
      await page.locator('[data-e2e-target]').evaluate((el) => el.getBoundingClientRect().top),
    ).toBeLessThan(await navBottom(page));
    test.info().annotations.push({
      type: 'before',
      description: JSON.stringify(
        await page.evaluate(() => ({
          y: scrollY,
          t: document.querySelector('[data-e2e-target]')!.getBoundingClientRect().top,
          tag: document.querySelector('[data-e2e-target]')!.outerHTML.slice(0, 120),
          sm: getComputedStyle(document.querySelector('[data-e2e-target]')!).scrollMarginTop,
        })),
      ),
    });
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('[data-e2e-target]')).toBeFocused();
    const top = await page
      .locator('[data-e2e-target]')
      .evaluate((el) => el.getBoundingClientRect().top);
    test.info().annotations.push({
      type: 'after',
      description: JSON.stringify({
        top,
        y: await page.evaluate(() => scrollY),
        nb: await navBottom(page),
      }),
    });
    expect(top, 'the focused control clears the bar').toBeGreaterThanOrEqual(await navBottom(page));
  });

  test('the stuck bar leads with our wordmark, is solid, and never shows a vendor logo', async ({
    page,
  }) => {
    // 1280x900: the width and height the AECI-1778 band-shell step was written at.
    await page.setViewportSize({ width: 1280, height: 900 });
    const path = await openProduct(page);
    await hydrated(page, path);
    const nav = page.locator('aec-section-nav');
    const brand = nav.getByTestId('section-nav-brand');
    await expect(brand).toHaveCount(0);
    await animationsSettled(page);

    const readSurface = () =>
      nav.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          position: s.position,
          top: s.top,
          background: s.backgroundColor,
          backdrop: s.backdropFilter,
          shadow: s.boxShadow,
          border: s.borderBottomWidth,
          borderColor: s.borderBottomColor,
          zIndex: s.zIndex,
        };
      });
    // AECI-1778: the product page's bar is clear at rest (rest="clear"), so the Bone band runs
    // through it. The solid surface is asserted once it sticks, below.
    expect(await readSurface()).toEqual({
      position: 'sticky',
      top: '0px',
      background: 'rgba(0, 0, 0, 0)',
      backdrop: 'none',
      shadow: 'none',
      border: '1px',
      borderColor: 'rgba(0, 0, 0, 0)',
      zIndex: '20',
    });
    // The header is not sticky, so the bar is the only bar at the top.
    expect(
      await page
        .locator('header')
        .first()
        .evaluate((el) => getComputedStyle(el).position),
    ).not.toMatch(/sticky|fixed/);

    await page.evaluate(() =>
      document.getElementById('reviews')!.scrollIntoView({ behavior: 'instant' }),
    );
    await expect(nav).toHaveAttribute('data-stuck', '');
    await expect(brand).toBeVisible();
    await animationsSettled(page);
    expect(await readSurface()).toEqual({
      position: 'sticky',
      top: '0px',
      background: await tokenColor(page, '--surface-base'),
      backdrop: 'none',
      shadow: 'none',
      border: '1px',
      borderColor: await tokenColor(page, '--border-default'),
      zIndex: '20',
    });
    const home = brand.getByRole('link', { name: 'AEC Integrations home' });
    await expect(home).toHaveAttribute('href', '/');
    const name = await page.locator('aec-product-detail h1').first().innerText();
    await expect(brand).toContainText(name.trim());
    const srcs = await nav
      .locator('img')
      .evaluateAll((imgs) => imgs.map((i) => new URL((i as HTMLImageElement).src).pathname));
    for (const src of srcs) expect(src).toMatch(/^\/branding\/(wordmark|monogram-light)\.svg$/);
    // 72px, plus the 1px hairline under it.
    expect(Math.round(await navBottom(page))).toBe(73);

    // The current item: weight 600, primary ink, a 3px Clay bar. Others stay at 400.
    await animationsSettled(page);
    const current = nav.locator('a[aria-current="location"]');
    const look = await current.evaluate((el) => {
      const s = getComputedStyle(el);
      const bar = getComputedStyle(el, '::after');
      return { weight: s.fontWeight, bar: bar.backgroundColor, h: bar.height, t: bar.transform };
    });
    expect(look.weight).toBe('600');
    expect(look.bar).toBe(await tokenColor(page, '--accent-secondary'));
    expect(look.h).toBe('3px');
    const other = nav.locator('nav a:not([aria-current])').first();
    expect(await other.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('400');

    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await expect(nav).not.toHaveAttribute('data-stuck', '');
    await expect(brand).toHaveCount(0);

    // AECI-1778: on the product band shell the bar is clear at rest, so the Bone band runs
    // through it, and solid white with its hairline once stuck. Only colours change, so nothing
    // moves. AECI-2027 folded this check in from its own test, which opened the same product at
    // the same width. It sets its own scroll positions, so it runs last.
    await test.step('is clear on Bone at rest and solid white with a hairline when stuck', async () => {
      await expect(nav).toHaveAttribute('data-rest', 'clear');
      await page.evaluate(() => {
        const n = document.querySelector('aec-section-nav')!;
        window.scrollTo({
          top: n.getBoundingClientRect().top + scrollY - 200,
          behavior: 'instant',
        });
      });
      await expect(nav).not.toHaveAttribute('data-stuck', '');
      await animationsSettled(page);
      const read = () =>
        nav.evaluate((el) => {
          // Computed colours can come back as oklch(); paint each onto a canvas to read sRGB.
          const ctx = document.createElement('canvas').getContext('2d')!;
          const rgb = (c: string) => {
            ctx.clearRect(0, 0, 1, 1);
            ctx.fillStyle = c;
            ctx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
            return a === 0 ? 'rgba(0, 0, 0, 0)' : `rgb(${r}, ${g}, ${b})`;
          };
          const s = getComputedStyle(el);
          // The colour behind the bar: its parent's ground.
          const ground = getComputedStyle(el.parentElement!).backgroundColor;
          const link = el.querySelector('nav a:not([aria-current])') ?? el.querySelector('nav a')!;
          return {
            bg: rgb(s.backgroundColor),
            edge: rgb(s.borderBottomColor),
            edgeWidth: s.borderBottomWidth,
            ground: rgb(ground),
            link: rgb(getComputedStyle(link).color),
            height: el.getBoundingClientRect().height,
          };
        });
      const rest = await read();
      expect(rest.bg).toBe('rgba(0, 0, 0, 0)');
      expect(rest.edge).toBe('rgba(0, 0, 0, 0)');
      expect(rest.ground).toBe('rgb(245, 242, 234)');
      expect(contrastOf(rest.link, rest.ground)).toBeGreaterThan(6.5);
      // The Forest focus ring on Bone.
      expect(contrastOf('rgb(30, 58, 47)', rest.ground)).toBeGreaterThan(11);

      await page.evaluate(() =>
        document.getElementById('reviews')!.scrollIntoView({ behavior: 'instant' }),
      );
      await expect(nav).toHaveAttribute('data-stuck', '');
      await animationsSettled(page);
      const stuck = await read();
      expect(stuck.bg).toBe('rgb(255, 255, 255)');
      expect(stuck.edge).not.toBe('rgba(0, 0, 0, 0)');
      // Same border width and height at rest and stuck: the swap moves nothing.
      expect(stuck.edgeWidth).toBe(rest.edgeWidth);
      expect(stuck.height).toBe(rest.height);
    });
  });

  test('on a 390px phone the row scrolls sideways inside the bar, and the page does not', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const path = await openProduct(page);
    await hydrated(page, path);
    const nav = page.locator('aec-section-nav');
    const row = nav.locator('.aec-section-nav-row');

    await page.evaluate(() =>
      document.getElementById('reviews')!.scrollIntoView({ behavior: 'instant' }),
    );
    await expect(nav).toHaveAttribute('data-stuck', '');
    expect(Math.round(await navBottom(page))).toBe(65);
    // Below md the stuck bar shows the monogram and no name.
    await expect(nav.getByTestId('section-nav-brand').locator('img:visible')).toHaveAttribute(
      'src',
      /monogram-light\.svg/,
    );

    await expectNoSidewaysScroll(page, 'the page itself never scrolls sideways');

    const dims = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    test.skip(dims.sw <= dims.cw, 'this product has too few sections to overflow at 390px');
    // The overflow cue, and the current link scrolled into the row.
    await expect(row).toHaveClass(/aec-fade-end|aec-fade-start/);
    const current = nav.locator('a[aria-current="location"]');
    await expect(current).toHaveAttribute('data-section-id', 'reviews');
    await expect
      .poll(() =>
        current.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const box = el.closest('.aec-section-nav-row')!.getBoundingClientRect();
          return r.left >= box.left - 1 && r.right <= box.right + 1;
        }),
      )
      .toBe(true);
  });

  for (const [label, width] of [
    ['320px', 320],
    ['200% zoom on a 1280px screen', 640],
  ] as const) {
    test(`stays usable at ${label}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      const path = await openProduct(page);
      await hydrated(page, path);
      await expectNoSidewaysScroll(page);
      const last = page.locator('aec-section-nav nav li:last-child a');
      await last.focus();
      await expect(last).toBeInViewport();
      const box = (await last.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    });
  }

  for (const width of [900, 1100, 1300]) {
    test(`nothing clips at ${width}px: every link can be reached`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const path = await openProduct(page);
      await hydrated(page, path);
      await page.evaluate(() =>
        document.getElementById('reviews')!.scrollIntoView({ behavior: 'instant' }),
      );
      await expect(page.locator('aec-section-nav')).toHaveAttribute('data-stuck', '');
      const links = page.locator('aec-section-nav nav a');
      for (let i = 0; i < (await links.count()); i++) {
        await links.nth(i).focus();
        await expect(links.nth(i)).toBeInViewport({ ratio: 1 });
      }
    });
  }

  // The product page is cached on its path. Ignored params, cookies and headers must not
  // change a byte of the nav.
  test('the server renders the same nav for every request on one cache key', async ({
    page,
    request,
  }) => {
    const path = await productPath(page);
    const navOf = async (url: string, headers: Record<string, string> = {}) => {
      const html = await (await request.get(url, { headers })).text();
      const m = html.match(/<aec-section-nav[\s\S]*?<\/aec-section-nav>/);
      expect(m, `section nav in ${url}`).not.toBeNull();
      return m![0];
    };
    const base = await navOf(path);
    expect(base).toContain(`href="${path}#integrations"`);
    // The server never renders the stuck state: no brand cluster, no data-stuck.
    expect(base).not.toContain('data-testid="section-nav-brand"');
    expect(base).not.toMatch(/<aec-section-nav[^>]*data-stuck/);
    expect(await navOf(`${path}?utm_source=mail&fbclid=1`)).toBe(base);
    expect(await navOf(`${path}?view=basic`)).toBe(base);
    expect(
      await navOf(path, {
        cookie: 'aeci_consent=all; sb-x-auth-token=abc',
        'accept-language': 'de',
      }),
    ).toBe(base);
  });

  // AECI-1768 review: the brand cluster arrives on stick without moving the links in layout.
  for (const width of [1280, 390]) {
    test(`sticking and unsticking cause no layout shift at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const path = await openProduct(page);
      await hydrated(page, path);
      // Let every deferred block below render first, so only the bar can move.
      await page.evaluate(async () => {
        const step = () => new Promise((r) => setTimeout(r, 150));
        for (let y = 0; y < document.documentElement.scrollHeight; y += 400) {
          window.scrollTo({ top: y, behavior: 'instant' });
          await step();
        }
        window.scrollTo({ top: 0, behavior: 'instant' });
        await step();
      });
      // A fixed wait on purpose. The deferred blocks give no signal the test can
      // name, so the pause lets the last of them render before the observer starts.
      await page.waitForTimeout(500);
      await page.evaluate(() => {
        const w = window as unknown as { __cls: number };
        w.__cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__cls += (e as unknown as { value: number }).value;
        }).observe({ type: 'layout-shift', buffered: false });
      });
      const stickAt = await page.evaluate(
        () => document.querySelector('aec-section-nav')!.getBoundingClientRect().top + scrollY,
      );
      for (let pass = 0; pass < 2; pass++) {
        for (const y of [stickAt - 120, stickAt + 40, stickAt + 300, stickAt + 40, stickAt - 120]) {
          await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
          // A fixed wait on purpose. The test proves that sticking causes no layout
          // shift, so each position needs a window for a shift to show up in.
          await page.waitForTimeout(250);
          if (y === stickAt + 300) {
            await expect(page.locator('aec-section-nav')).toHaveAttribute('data-stuck', '');
          }
        }
      }
      await expect(page.locator('aec-section-nav')).not.toHaveAttribute('data-stuck', '');
      const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
      test.info().annotations.push({ type: 'cls', description: `${width}px: ${cls}` });
      expect(cls, `layout shift while sticking at ${width}px`).toBeLessThanOrEqual(0.001);
    });
  }

  // AECI-1768 review: Chrome does not scroll a partly visible focus target, so the row does.
  for (const width of [320, 390]) {
    for (const state of ['at rest', 'stuck'] as const) {
      test(`at ${width}px ${state}, every focused link sits fully inside the row, clear of the fades`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        const path = await openProduct(page);
        await hydrated(page, path);
        const nav = page.locator('aec-section-nav');
        if (state === 'stuck') {
          await page.evaluate(() =>
            document.getElementById('reviews')!.scrollIntoView({ behavior: 'instant' }),
          );
          await expect(nav).toHaveAttribute('data-stuck', '');
          await expect(nav.getByTestId('section-nav-brand')).toBeVisible();
        } else {
          await page.evaluate(() => {
            const n = document.querySelector('aec-section-nav')!;
            window.scrollTo({
              top: n.getBoundingClientRect().top + scrollY - 200,
              behavior: 'instant',
            });
          });
          await expect(nav).not.toHaveAttribute('data-stuck', '');
        }
        const links = nav.locator('nav a');
        const count = await links.count();
        await links.first().focus();
        for (let i = 0; i < count; i++) {
          if (i > 0) await page.keyboard.press('Tab');
          await expect(links.nth(i)).toBeFocused();
          // The row scrolls the focused link into view. Retry the read until it has.
          await expect(async () => {
            const fit = await links.nth(i).evaluate((a) => {
              const row = a.closest('.aec-section-nav-row')!;
              const r = a.getBoundingClientRect();
              const box = row.getBoundingClientRect();
              const brand = document.querySelector('[data-testid="section-nav-brand"]');
              const start = Math.max(
                box.left,
                brand ? brand.getBoundingClientRect().right : box.left,
              );
              // A fade is drawn only when the row's mask is on (it steps aside under focus).
              const masked = getComputedStyle(row).maskImage !== 'none';
              const fadeStart = masked && row.classList.contains('aec-fade-start') ? 40 : 0;
              const fadeEnd = masked && row.classList.contains('aec-fade-end') ? 40 : 0;
              return {
                left: Math.round(r.left - (start + fadeStart)),
                right: Math.round(box.right - fadeEnd - r.right),
              };
            });
            expect(fit.left, `link ${i} clears the start edge`).toBeGreaterThanOrEqual(-1);
            expect(fit.right, `link ${i} clears the end edge`).toBeGreaterThanOrEqual(-1);
          }).toPass({ timeout: 5_000 });
        }
      });
    }
  }

  // AECI-1768 review: a sticky aside taller than the space under the bar loses its foot.
  // AECI-1778 moved the product page onto the band shell, where the metadata is the facts
  // card in the page flow. It never sticks, at any height, so it can never lose its foot
  // under the bar. The column shell's sticky aside (`.aec-detail-aside`) stays for the
  // vendor page, which has no section bar.
  test('the facts card never sticks under the bar on the band shell', async ({ page }) => {
    for (const height of [600, 900]) {
      await page.setViewportSize({ width: 1280, height });
      const path = await openProduct(page);
      await hydrated(page, path);
      await animationsSettled(page);
      const aside = page.locator('aec-detail-layout aside');
      const position = await aside.evaluate((el) => getComputedStyle(el).position);
      expect(position, `at ${height}px`).toBe('relative');
      expect(await aside.evaluate((el) => el.classList.contains('aec-detail-aside'))).toBe(false);
    }
  });
});

function contrastOf(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = c
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number);
    const lin = (v: number) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(bl!);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/**
 * AECI-2012 (Chris, 2026-11-23): the ruling 41 trial tag is out of the stuck bar. On an
 * unclaimed listing and a claimed one alike, the stuck bar shows our wordmark and the name from
 * md, our monogram below it, and never "Unclaimed". The hero keeps the Unclaimed note.
 *
 * AECI-2027 cut the matrix to `revit` at 768 and 320, the first width of md and the narrowest
 * width below it. Those two pin the name shown from md and hidden below it. The other cases
 * repeated cover elsewhere. `products-detail.spec.ts` sticks the bar for revit and the claimed
 * fixture-procore at 1440 and 390 and asserts no tag, no "Unclaimed" text and no sideways
 * scroll. The bar heights are asserted at 1280 and 390 earlier in this file.
 */
test.describe('no Unclaimed tag in the stuck bar (AECI-2012)', () => {
  const UNCLAIMED = 'revit';
  const CLAIMED = 'fixture-procore';

  test.beforeEach(async ({ page, request }) => {
    // Any PostHog request is answered here, so nothing leaves the machine.
    await page.route(
      (url) => url.hostname === 'posthog.com' || url.hostname.endsWith('.posthog.com'),
      (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    const status = async (slug: string) => {
      const res = await request.get(`/api/products/${slug}`);
      if (!res.ok()) return null;
      return ((await res.json()) as { claim_status?: string }).claim_status ?? null;
    };
    const [u, c] = await Promise.all([status(UNCLAIMED), status(CLAIMED)]);
    test.skip(
      u !== 'unclaimed' || c !== 'claimed',
      `seed missing: ${UNCLAIMED}=${u}, ${CLAIMED}=${c}`,
    );
  });

  for (const width of [768, 320]) {
    test(`${UNCLAIMED}: the stuck bar has no tag at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/products/${UNCLAIMED}`);
      const nav = page.locator('aec-section-nav');
      await untilHydrated(nav);
      await page.evaluate(() =>
        document.getElementById('integrations')!.scrollIntoView({ behavior: 'instant' }),
      );
      await expect(nav).toHaveAttribute('data-stuck', '');
      await expect(nav.getByTestId('section-nav-unclaimed')).toHaveCount(0);
      expect(await nav.evaluate((el) => (el as HTMLElement).innerText)).not.toContain('Unclaimed');
      const name = nav.getByTestId('section-nav-name');
      if (width >= 768) await expect(name).toBeVisible();
      else await expect(name).toBeHidden();
      await expectNoSidewaysScroll(page);
      expect(Math.round(await navBottom(page))).toBe(width >= 768 ? 73 : 65);
    });
  }

  test('the server HTML carries no tag, so the cached page is the same for every visitor', async ({
    request,
  }) => {
    for (const slug of [UNCLAIMED, CLAIMED]) {
      const html = await (await request.get(`/products/${slug}`)).text();
      expect(html).toContain('<aec-section-nav');
      expect(html).not.toContain('section-nav-unclaimed');
    }
  });
});
