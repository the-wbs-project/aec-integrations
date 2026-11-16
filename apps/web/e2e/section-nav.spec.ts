import { expect, test, type Page } from '@playwright/test';

import { untilHydrated } from './hydration';

/**
 * AECI-1768: the sticky section bar (`shared/section-nav/section-nav.ts`), and AECI-1843: its
 * links keep the query string, so a click is never a page load.
 *
 * Each test opens a seeded product whose page has an Integrations entry and is tall enough to
 * scroll. The walk matters: the thin local seed puts short products first.
 */
async function openProduct(page: Page, query = ''): Promise<string> {
  await page.goto('/products');
  const rows = page.locator('#main a[href^="/products/"]');
  await rows
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 })
    .catch(() => {});
  test.skip((await rows.count()) === 0, 'no products seeded in this environment');
  const hrefs = (
    await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute('href')).filter((h): h is string => !!h && !h.includes('#')),
    )
  ).slice(0, 10);
  // Prefer a page with four or more sections, so the row can overflow on a phone.
  let fallback: string | null = null;
  for (const href of [...new Set(hrefs)]) {
    await page.goto(`${href}${query}`);
    await expect(page.locator('aec-product-detail')).toBeVisible();
    if ((await page.locator('aec-section-nav a[data-section-id="integrations"]').count()) === 0) {
      continue;
    }
    const tall = await page.evaluate(
      () => document.documentElement.scrollHeight > window.innerHeight * 1.6,
    );
    if (!tall) continue;
    if ((await page.locator('aec-section-nav nav a').count()) >= 4) return href;
    fallback ??= href;
  }
  test.skip(!fallback, 'no seeded product is tall enough for the section nav');
  await page.goto(`${fallback}${query}`);
  return fallback!;
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
  for (const query of ['', '?utm_source=e2e&utm_campaign=nov']) {
    test(`a click animates in place with no page load${query ? ', query kept' : ''}`, async ({
      page,
    }) => {
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
    await startSampler(page);
    await page.locator('aec-section-nav a[data-section-id="integrations"]').click();
    const offsets = await settledOffsets(page);
    expect(offsets).toHaveLength(2);
    expect(offsets[1]).toBeGreaterThan(0);
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
    const path = await openProduct(page);
    await hydrated(page, path);
    const nav = page.locator('aec-section-nav');
    const brand = nav.getByTestId('section-nav-brand');
    await expect(brand).toHaveCount(0);
    await animationsSettled(page);

    const surface = await nav.evaluate((el) => {
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
    expect(surface).toEqual({
      position: 'sticky',
      top: '0px',
      background: await tokenColor(page, '--surface-base'),
      backdrop: 'none',
      shadow: 'none',
      border: '1px',
      borderColor: await tokenColor(page, '--border-default'),
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

    const page_overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(page_overflow, 'the page itself never scrolls sideways').toBeLessThanOrEqual(0);

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
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
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
    const path = await openProduct(page);
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
          await page.waitForTimeout(50);
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
