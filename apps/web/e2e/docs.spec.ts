/**
 * AECI-1248 — the docs shell: `/docs` home, a section index, an article, the
 * prev/next pager, and the explicit route table's 404 for unknown paths.
 *
 * The manifest, components and noindex-by-path rules are pinned in the
 * `src/app/docs/*.component.spec.ts` specs and `src/server.spec.ts`; this
 * proves the real routes render, link together and stay accessible.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  attachConsoleCapture,
  expectConsoleClean,
  waitForHydrationSettle,
} from './console-capture';

test.describe('/docs shell — AECI-1248', () => {
  test('SSR-renders the home, a section and an article on the static-page cache', async ({
    request,
  }) => {
    for (const path of ['/docs', '/docs/reviewers', '/docs/reviewers/requests-and-corrections']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(res.headers()['cache-tag'] ?? '', path).toContain('route:index');
    }
    const home = await (await request.get('/docs')).text();
    expect(home).toContain('Help center');
    expect(home).toContain('/docs/reviewers/requests-and-corrections');
  });

  test('keeps the vendor guide noindex, its bare section index included', async ({ request }) => {
    for (const path of ['/docs/vendors', '/docs/vendors/your-seat']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(res.headers()['x-robots-tag'] ?? '', path).toContain('noindex');
    }
  });

  test('an unknown docs path is a real 404', async ({ request }) => {
    for (const path of ['/docs/nope', '/docs/vendors/nope', '/docs/faq']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
  });

  // AECI-1249 — the reader pages. Indexable, so the page meta must not carry
  // noindex (the env-level X-Robots-Tag is a separate, per-tier gate).
  const READER_PAGES: readonly (readonly [string, string])[] = [
    ['/docs/getting-started/what-aeci-is', 'What AECi is'],
    ['/docs/getting-started/reading-an-integration-page', 'Reading an integration page'],
    ['/docs/getting-started/taxonomy', 'How listings are classified'],
    ['/docs/trust/how-ranking-works', 'How ranking works'],
    ['/docs/trust/the-account-label', 'The account label'],
    ['/docs/trust/agreement-states', 'Agreement states'],
  ];

  test('SSR-renders the six reader pages with their titles (AECI-1249)', async ({ request }) => {
    for (const [path, title] of READER_PAGES) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      expect(html, path).toMatch(new RegExp(`<h1[^>]*>\\s*${title}\\s*</h1>`));
      expect(html, path).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    }
  });

  test('walks home → section → article, then the pager and breadcrumb', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Help center');
    await waitForHydrationSettle(page);

    await page.locator('[data-section="vendors"] h3 a').click();
    await expect(page).toHaveURL(/\/docs\/vendors$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vendor guide');

    await page.locator('main a[href="/docs/vendors/claiming-your-listing"]').first().click();
    await expect(page).toHaveURL(/\/docs\/vendors\/claiming-your-listing$/);

    const pager = page.getByRole('navigation', { name: 'Previous and next articles' });
    await pager.getByRole('link', { name: /Next/ }).click();
    await expect(page).toHaveURL(/\/docs\/vendors\/your-seat$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your seat');

    await pager.getByRole('link', { name: /Previous/ }).click();
    await expect(page).toHaveURL(/\/docs\/vendors\/claiming-your-listing$/);

    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Docs' })
      .click();
    await expect(page).toHaveURL(/\/docs$/);
  });

  for (const path of [
    '/docs',
    '/docs/reviewers',
    '/docs/vendors/your-seat',
    '/docs/trust/how-ranking-works',
  ]) {
    test(`${path} has zero axe violations at WCAG AA and a clean console`, async ({ page }) => {
      const capture = attachConsoleCapture(page);
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.locator('app-root')).toBeAttached();
      await waitForHydrationSettle(page);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      expect(results.violations).toEqual([]);
      expectConsoleClean(capture, `GET ${path}`);
    });
  }
});
