/**
 * AECI-1283 — `/vendor-program` end-to-end smoke (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §2).
 *
 * Pins the real HTTP 200, the /about static-page cache headers
 * (`s-maxage=86400`, `Cache-Tag: route:index`), indexable meta with the absolute
 * share card, the SSR-rendered hero, the sitemap entry, the footer link in, and
 * that `/vendors` still 301s to `/products` (§1.1 decision 6).
 *
 * AECI-1284 to 1286 add the page body: the heading order (§3), the phone bar's
 * visibility rules (§4.1, asked for by AECI-1285), and axe on the full page at
 * desktop and phone widths. Find your product (§6, AECI-1287) was removed on
 * 2026-10-12: the claim dialog starts with Find it, and
 * `vendor-program-claim-dialog.spec.ts` covers that step against a mocked index.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { waitForHydrationSettle } from './console-capture';
import { expectNoSidewaysScroll } from './no-sideways-scroll';

test.describe('/vendor-program — AECI-1283 to 1287', () => {
  test('GET /vendor-program returns 200 with the static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get('/vendor-program', { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');

    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the hero, with no Find your product section, indexable with the share card', async ({
    request,
  }) => {
    const html = await (await request.get('/vendor-program')).text();
    expect(html).toContain(
      'Your products may already be listed here. Make sure buyers read your version.',
    );
    expect(html).not.toContain('id="find-your-product"');
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    expect(html).toMatch(/<link[^>]+rel="canonical"[^>]+href="https?:\/\/[^"]+\/vendor-program"/);
    expect(html).toMatch(
      /<meta[^>]+property="og:image"[^>]+content="https?:\/\/[^"]+\/branding\/vendor-program-og\.png"/,
    );
    expect(html).toMatch(/<meta[^>]+property="og:image:alt"/);

    const card = await request.get('/branding/vendor-program-og.png');
    expect(card.status()).toBe(200);
    expect(card.headers()['content-type']).toContain('image/png');
  });

  test('is listed in sitemap.xml', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/vendor-program<\/loc>/);
  });

  test('is reachable from the footer Company nav', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const company = page.getByRole('navigation', { name: 'Company' });
    await company.getByRole('link', { name: 'For vendors' }).click();

    await expect(page).toHaveURL(/\/vendor-program$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Your products may already be listed here.',
    );
  });

  for (const width of [1280, 375]) {
    test(`has zero axe violations at WCAG 2.2 AA at ${width}px, FAQ open`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 667 : 900 });
      await page.goto('/vendor-program');
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);
      // Open every answer so axe reads them too.
      await page
        .locator('#vp-faq details')
        .evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      expect(results.violations).toEqual([]);
    });
  }

  test('/vendors still 301s to /products', async ({ request }) => {
    const res = await request.get('/vendors', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location'] ?? '').toMatch(/\/products$/);
  });

  test('the hero pair sits on the first screen at 375px and at desktop', async ({ page }) => {
    for (const size of [
      { width: 375, height: 667 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.goto('/vendor-program');
      const hero = page.locator('aec-plan-cta-actions');
      // AECI-1293: one claim control. E8.1 (ruled 2026-10-19): no contact link on the hero.
      await expect(hero.getByRole('link', { name: 'Claim your listing' })).toBeInViewport({
        ratio: 1,
      });
      await expect(hero.getByRole('link', { name: 'Contact us' })).toHaveCount(0);
    }
  });

  // AECI-1285's e2e: the phone bar hides while a full call to action is on screen
  // and never covers the closing panel.
  test('phone bar: hidden by the hero and the panel, shown between them', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);
    const bar = page.getByRole('region', { name: 'Managed plan' });
    // `behavior: 'instant'` overrides the page's `html { scroll-behavior: smooth }`.
    // A smooth scroll lets an assertion pass mid-animation, before the scroll lands.
    const scrollTo = (selector: string) =>
      page
        .locator(selector)
        .evaluate((el) => el.scrollIntoView({ block: 'start', behavior: 'instant' }));

    // The hero pair is on screen.
    await expect(bar).toBeHidden();

    // Past the hero, no full call to action on screen.
    await scrollTo('#vp-managed');
    await expect(bar).toBeVisible();

    // The plan cards are a full call to action.
    await scrollTo('#vp-plans');
    await expect(bar).toBeHidden();

    // Just before the closing panel comes on screen. The FAQ is shorter than a
    // phone screen, so scrolling to its heading already shows the panel's top.
    await page.locator('aec-plan-cta-panel').evaluate((el) =>
      window.scrollTo({
        top: el.getBoundingClientRect().top + window.scrollY - window.innerHeight - 1,
        behavior: 'instant',
      }),
    );
    await expect(bar).toBeVisible();

    // The closing panel.
    await scrollTo('aec-plan-cta-panel');
    await expect(bar).toBeHidden();

    // The very end of the page. Whether the panel is still on screen here depends
    // on the footer's height, so assert the rule, not the layout: the bar shows
    // exactly when the panel is off screen.
    await page.evaluate(() =>
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const shown = !!document.querySelector('[role="region"][aria-label="Managed plan"]');
          const panel = document.querySelector('aec-plan-cta-panel')?.getBoundingClientRect();
          const panelOnScreen = !!panel && panel.bottom > 0 && panel.top < window.innerHeight;
          return shown !== panelOnScreen;
        }),
      )
      .toBe(true);
  });

  // Full width at desktop (spec section 11, 2026-10-12): no rail, and no section
  // leaves the right half of the container blank. 1024px starts the `lg` band, where
  // the split layouts begin and the room is tightest. 1440px is past the 1328px page
  // wrap, the widest layout. 1280px sits inside the same band and proved nothing new.
  for (const width of [1024, 1440]) {
    test(`at ${width}px every section reaches the right half, with no rail`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/vendor-program');
      await waitForHydrationSettle(page);
      await expect(page.locator('aec-plan-cta-rail')).toHaveCount(0);

      const reach = await page.evaluate(() => {
        const hero = document.querySelector('aec-vendor-program section')!;
        const sections = [
          hero,
          ...document.querySelectorAll(
            '#vp-what-changes, #vp-free, #vp-managed, #vp-plans, #vp-sorting, #vp-faq, aec-plan-cta-panel section',
          ),
        ];
        // AECI-1802: the hero sits in the Bone band's 1328px page wrap, gutters 48px from lg.
        const container = hero.closest('.max-w-\\[1328px\\]')!.getBoundingClientRect();
        const left = container.left + 48;
        const inner = container.width - 96;
        return sections.map((section) => {
          // The right edge of the furthest visible text or control in the section.
          let right = 0;
          const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) right = Math.max(right, rect.right);
          }
          for (const el of section.querySelectorAll('input, a, summary, [data-testid="vp-how"]')) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0) right = Math.max(right, rect.right);
          }
          return { id: section.id || section.tagName, share: (right - left) / inner };
        });
      });
      for (const { id, share } of reach) {
        expect(share, `${id} stops at ${Math.round(share * 100)}% of the width`).toBeGreaterThan(
          0.75,
        );
      }
    });
  }

  // One desktop page load serves five checks. The hero claim runs last because it
  // opens the claim dialog over the page.
  test('at desktop: headings, plan cards, closing panel, docs link, then the hero claim', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/vendor-program');
    await waitForHydrationSettle(page);

    await test.step('one h1, then one h2 per section in the section 3 order', async () => {
      const headings = await page
        .locator('main h1, main h2')
        .evaluateAll((all) => all.map((h) => `${h.tagName}:${h.textContent?.trim()}`));
      expect(headings).toEqual([
        'H1:Your products may already be listed here. Make sure buyers read your version.',
        'H2:What changes when you claim',
        'H2:What a free claim gets you',
        'H2:What Managed adds',
        'H2:Free and Managed',
        'H2:How listings are sorted',
        'H2:Questions vendors ask',
        'H2:Tell the full story of your product',
      ]);
    });

    // Ruling A7 (2026-11-16): the plan cards take the shared card frame. The Managed
    // card keeps its 2px Forest border, and the buttons stay one width and one line.
    await test.step('the plan cards are the shared card, the Managed one with a 2px Forest border', async () => {
      await page.waitForFunction(() => document.getAnimations().length === 0);
      const frame = (plan: string) =>
        page.locator(`aec-plan-cards [data-plan-card="${plan}"]`).evaluate((e) => {
          const c = getComputedStyle(e);
          return {
            radius: c.borderTopLeftRadius,
            border: c.borderTopWidth,
            shadow: c.boxShadow !== 'none',
          };
        });
      expect(await frame('free')).toEqual({ radius: '24px', border: '1px', shadow: true });
      expect(await frame('managed')).toEqual({ radius: '24px', border: '2px', shadow: true });
      const managedColor = await page
        .locator('aec-plan-cards [data-plan-card="managed"]')
        .evaluate((e) => {
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.fillStyle = getComputedStyle(e).borderTopColor;
          ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)].join(',');
        });
      expect(managedColor).toBe('30,58,47');
      const buttons = page.locator('aec-plan-cards [data-plan-card] a[aecButton]');
      const [a, b] = [(await buttons.nth(0).boundingBox())!, (await buttons.nth(1).boundingBox())!];
      expect(a.width).toBe(b.width);
      expect(a.y).toBe(b.y);
    });

    await test.step('the closing panel is the one Forest card, in Bone ink', async () => {
      const panel = page.locator('aec-plan-cta-panel section');
      const [ground, ink, radius] = await panel.evaluate((el) => {
        const cs = getComputedStyle(el);
        return [cs.backgroundColor, cs.color, cs.borderTopLeftRadius];
      });
      const token = (name: string) =>
        page.evaluate((n) => {
          const probe = document.createElement('div');
          probe.style.color = `var(${n})`;
          document.body.appendChild(probe);
          const value = getComputedStyle(probe).color;
          probe.remove();
          return value;
        }, name);
      expect(ground).toBe(await token('--accent-primary'));
      expect(ink).toBe(await token('--text-on-brand'));
      expect(radius).toBe('24px');
      const heading = page.locator('#plans-cta-heading');
      expect(await heading.evaluate((el) => getComputedStyle(el).color)).toBe(
        await token('--text-on-brand'),
      );
    });

    // Ruling 2026-10-12: a docs link opens a new tab on the real docs page, and its
    // href survives <base href>. The claim links stay in this tab.
    await test.step('docs links open the docs in a new tab', async () => {
      const link = page.locator('#vp-sorting').getByRole('link', { name: /How ranking works/ });
      await expect(link).toHaveAttribute('href', '/docs/trust/how-ranking-works');
      const [tab] = await Promise.all([context.waitForEvent('page'), link.click()]);
      await tab.waitForLoadState();
      expect(new URL(tab.url()).pathname).toBe('/docs/trust/how-ranking-works');
      await expect(page).toHaveURL(/\/vendor-program$/);
      await tab.close();
    });

    // AECI-1293: the hero claim opens the claim dialog in place. Its href is the
    // no-JS target, the search page (2026-10-12, when Find your product was removed).
    await test.step('the hero claim opens the claim dialog, with the search page as its no-JS target', async () => {
      const claim = page
        .locator('aec-plan-cta-actions')
        .getByRole('link', { name: 'Claim your listing' });
      await expect(claim).toHaveAttribute('href', '/search');
      await expect(async () => {
        await claim.click();
        await expect(page.getByRole('dialog', { name: 'Claim your company' })).toBeVisible({
          timeout: 2000,
        });
      }).toPass();
      await expect(page).toHaveURL(/\/vendor-program$/);
    });
  });

  // AECI-1802: the /about recipe. One Bone band (the hero), one Forest feature card
  // (the closing panel), and nothing scrolls sideways on a phone. The listing request
  // page has no Bone band since the AECI-1720 layout pass: its form comes first.
  for (const [path, bands] of [
    ['/vendor-program', 1],
    ['/vendor-program/list-your-product', 0],
  ] as const) {
    // 320px only: no breakpoint sits between 320 and 390, and the band count does not
    // depend on width.
    test(`${path} has ${bands} Bone band and fits at 320px`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(path);
      await waitForHydrationSettle(page);
      await expect(page.locator('.aec-bone-band')).toHaveCount(bands);
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(page.locator('aec-bone-band h1')).toHaveCount(bands);
      await expectNoSidewaysScroll(page);
    });
  }
});
