/**
 * AECI-1673 — `/accessibility` end-to-end coverage (counsel Q40, ruling 22).
 *
 * A static, indexable, CACHEABLE content page on the /methodology pattern. This
 * pins the real HTTP 200, the static-page cache headers, the self-referential
 * canonical with no noindex, the SSR-rendered body, the footer Legal link in, and
 * the issue's done-when: zero axe violations at WCAG 2.1 AA on the page itself.
 *
 * **Hidden until AECI-1687.** `ACCESSIBILITY_STATEMENT_PUBLISHED` is `false`, so the
 * published-page block below is skipped and the hidden-state block runs instead.
 * AECI-1687's last step flips the flag, removes the `.skip`, and deletes the
 * hidden-state block.
 *
 * It also holds the regression cases of the redesign accessibility gate (AECI-1818),
 * which the issue asked to land here.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';
import { routeFakeAlgolia } from './fake-algolia';
import { untilHydrated } from './hydration';

/**
 * Presets a consent decision before any page script runs, so the analytics
 * consent banner never mounts over the footer (the `e2e/legal.spec.ts` rule).
 * The key mirrors `CONSENT_STORAGE_KEY` in `src/app/analytics/consent.ts`.
 */
async function presetConsent(page: Page): Promise<void> {
  await page.addInitScript(() => {
    globalThis.localStorage.setItem('aeci_analytics_consent', 'denied');
  });
}

// AECI-1687 — while the statement is hidden, nothing reaches it.
test.describe('/accessibility hidden until AECI-1687', () => {
  test('404s, is not in the footer, and is not in the sitemap', async ({ page, request }) => {
    const res = await request.get('/accessibility', { maxRedirects: 0 });
    expect(res.status()).toBe(404);

    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();
    await expect(page.locator('footer a[href="/accessibility"]')).toHaveCount(0);

    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).not.toMatch(/<loc>[^<]+\/accessibility<\/loc>/);
  });
});

// AECI-1818: the two WCAG 2.2 AA defects the redesign accessibility gate found, guarded
// on the rendered page because jsdom has no layout and no cascade.
test.describe('redesign accessibility gate (AECI-1818)', () => {
  // WCAG 2.4.11 Focus Not Obscured. On a first visit the fixed consent banner covered
  // up to 27 focus stops at 320px: Tab scrolled each one only as far as the viewport's
  // bottom edge, which is under the banner.
  test('a Tab never leaves the focused control hidden under the consent banner at 320px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto('/products/fixture-procore');
    const banner = page.getByRole('region', { name: 'Analytics consent' });
    await expect(banner).toBeVisible();
    await waitForHydrationSettle(page);

    const hidden: string[] = [];
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press('Tab');
      const covered = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const card = document.querySelector('[aria-label="Analytics consent"] .aec-popover');
        if (!el || !card || card.contains(el) || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const b = card.getBoundingClientRect();
        // Entirely under the banner card: the 2.4.11 failure.
        const under = r.top >= b.top && r.bottom <= b.bottom + 1;
        return under ? (el.innerText || el.getAttribute('aria-label') || el.tagName).trim() : null;
      });
      if (covered) hidden.push(covered);
    }
    expect(hidden, 'focused controls fully hidden under the consent banner').toEqual([]);
  });

  // The rule above stays out of modals: the open menu paints above the banner, so the
  // banner cannot hide its focus, and the margin once scrolled the locked page behind it.
  test('with the banner up, Tab through the open menu at 844 by 390 is never under the banner and the page stays put', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto('/products/fixture-procore');
    await expect(page.getByRole('region', { name: 'Analytics consent' })).toBeVisible();
    await waitForHydrationSettle(page);
    const toggle = page.getByRole('button', { name: 'Menu', exact: true });
    await expect(async () => {
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 1000 });
    }).toPass();
    const panel = page.locator('#nav-menu-panel');
    for (const name of ['Categories', 'Phases', 'Audiences', 'Trades']) {
      await panel.getByRole('button', { name }).click();
    }

    const hidden: string[] = [];
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const covered = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top?.closest('[aria-label="Analytics consent"]')
          ? (el.innerText || el.tagName).trim()
          : null;
      });
      if (covered) hidden.push(covered);
    }
    expect(hidden, 'menu controls painted under the consent banner').toEqual([]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  // WCAG 2.4.7 Focus Visible. The results panel is a Tab stop (`tabindex="0"`) and had
  // `focus-visible:outline-none`, so focus landed on it with nothing drawn.
  test('/search draws a focus ring on the results panel and names both search landmarks', async ({
    page,
  }) => {
    await presetConsent(page);
    await routeFakeAlgolia(page);
    await page.goto('/search?q=fake');
    const panel = page.locator('#search-tabpanel');
    await expect(panel).toBeVisible();
    await waitForHydrationSettle(page);

    // A key press first, so the scripted focus counts as keyboard focus.
    await page.keyboard.press('Shift');
    await panel.focus();
    await expect(panel).toBeFocused();
    const ring = await panel.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { style: cs.outlineStyle, width: cs.outlineWidth };
    });
    expect(ring).toEqual({ style: 'solid', width: '3px' });

    const names = await page.getByRole('search').evaluateAll((forms) =>
      forms.map((f) => {
        const by = f.getAttribute('aria-labelledby');
        return (
          f.getAttribute('aria-label') ??
          document.getElementById(by ?? '')?.textContent ??
          ''
        ).trim();
      }),
    );
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

// Skipped until AECI-1687 publishes the page.
test.describe.skip('/accessibility — AECI-1673', () => {
  test('GET /accessibility returns 200 with the static-page cache headers + route:index tag', async ({
    request,
  }) => {
    const res = await request.get('/accessibility', { maxRedirects: 0 });
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=86400');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=3600');
    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
  });

  test('SSR-renders the statement body', async ({ request }) => {
    const html = await (await request.get('/accessibility')).text();
    expect(html).toContain('Accessibility statement');
    expect(html).toContain('aec-prose');
    expect(html).toContain('We aim to conform to the Web Content Accessibility Guidelines');
    expect(html).toContain('href="mailto:support@aecintegrations.com"');
    expect(html).toContain('We reply within 10 business days.');
  });

  test('is indexable — self-referential canonical, no noindex robots meta', async ({
    page,
    request,
  }) => {
    const html = await (await request.get('/accessibility')).text();
    expect(html).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);

    await page.goto('/accessibility');
    await expect(page).toHaveTitle('Accessibility statement · AEC Integrations');
    const canonical = page.locator('head link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    await expect(canonical).toHaveAttribute('href', /\/accessibility$/);
  });

  test('is reachable from the footer Legal nav', async ({ page }) => {
    await presetConsent(page);
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const link = page
      .getByRole('navigation', { name: 'Legal' })
      .getByRole('link', { name: 'Accessibility', exact: true });
    await untilHydrated(link);
    await link.click();

    await expect(page).toHaveURL(/\/accessibility$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Accessibility statement');
  });

  test('has zero axe violations at WCAG 2.1 AA', async ({ page }) => {
    await page.goto('/accessibility');
    await expect(page.locator('app-root')).toBeAttached();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    expect(results.violations).toEqual([]);
  });

  test('renders with no console errors or page errors', async ({ page }) => {
    const capture = attachConsoleCapture(page);
    const res = await page.goto('/accessibility');
    expect(res?.status()).toBe(200);
    await expect(page.locator('app-root')).toBeAttached();
    await waitForHydrationSettle(page);
    expectConsoleClean(capture, 'GET /accessibility');
  });
});
