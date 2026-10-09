/**
 * AECI-1248 — the docs shell: `/docs` home, a section index, an article, the
 * prev/next pager, and the explicit route table's 404 for unknown paths.
 * AECI-1259 — the DeepWiki-style layout: the sidebar tree, the small-screen
 * menu, the "On this page" rail and its fragment links.
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

  // AECI-1250 — the reviewer and account pages. Indexable, like the reader pages.
  const REVIEWER_AND_ACCOUNT_PAGES: readonly (readonly [string, string])[] = [
    ['/docs/reviewers/writing-a-review', 'Writing a review'],
    ['/docs/account/signing-in', 'Signing in'],
    ['/docs/account/your-data', 'Your account and your data'],
  ];

  test('SSR-renders the reviewer and account pages with their titles (AECI-1250)', async ({
    request,
  }) => {
    for (const [path, title] of REVIEWER_AND_ACCOUNT_PAGES) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      expect(html, path).toMatch(new RegExp(`<h1[^>]*>\\s*${title}\\s*</h1>`));
      expect(html, path).not.toMatch(/<meta[^>]+name="robots"[^>]+content="noindex"/);
    }
  });

  test('/docs/account is a section page listing both account pages (AECI-1250)', async ({
    request,
  }) => {
    const res = await request.get('/docs/account', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-tag'] ?? '').toContain('route:index');
    const html = await res.text();
    expect(html).toMatch(/<h1[^>]*>\s*Your account\s*<\/h1>/);
    expect(html).toContain('/docs/account/signing-in');
    expect(html).toContain('/docs/account/your-data');
  });

  test('walks home → section → article, then the pager and breadcrumb', async ({ page }) => {
    await page.goto('/docs');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Help center');
    await waitForHydrationSettle(page);

    await page.locator('main div[data-section="vendors"] h3 a').click();
    await expect(page).toHaveURL(/\/docs\/vendors$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vendor guide');

    // The section index's own list, not the sidebar's link to the same page.
    await page.locator('main ol h2 a[href="/docs/vendors/claiming-your-listing"]').click();
    await expect(page).toHaveURL(/\/docs\/vendors\/claiming-your-listing$/);

    const pager = page.getByRole('navigation', { name: 'Previous and next articles' });
    await pager.getByRole('link', { name: /Next/ }).click();
    await expect(page).toHaveURL(/\/docs\/vendors\/your-seat$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your seat');

    await pager.getByRole('link', { name: /Previous/ }).click();
    await expect(page).toHaveURL(/\/docs\/vendors\/claiming-your-listing$/);

    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Help center' })
      .click();
    await expect(page).toHaveURL(/\/docs$/);
  });

  // AECI-1259 — the sidebar is in the SSR HTML, current item included, so the
  // edge-cached page is the same for every visitor.
  test('SSR-renders the sidebar with the current page marked', async ({ request }) => {
    const html = await (await request.get('/docs/trust/how-ranking-works')).text();
    expect(html).toMatch(/<nav[^>]+aria-label="Help center"/);
    expect(html).toMatch(/href="\/docs\/trust\/how-ranking-works"[^>]*aria-current="page"/);
    // The small-screen panel ships closed.
    expect(html).toMatch(/aria-controls="docs-nav-panel"[^>]*aria-expanded="false"/);
    // Heading ids are in the SSR HTML, so a deep link works before hydration.
    expect(html).toContain('id="what-does-not-count"');
  });

  test('the sidebar navigates and moves aria-current (AECI-1259)', async ({ page }) => {
    await page.goto('/docs/trust/how-ranking-works');
    await waitForHydrationSettle(page);
    const tree = page.getByRole('navigation', { name: 'Help center' });
    await expect(tree.locator('a[aria-current="page"]')).toHaveText('How ranking works');

    await tree.getByRole('link', { name: 'The account label', exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/trust\/the-account-label$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The account label');
    await expect(tree.locator('a[aria-current="page"]')).toHaveText('The account label');
  });

  test('the rail links jump to their heading (AECI-1259)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs/trust/how-ranking-works');
    await waitForHydrationSettle(page);
    const rail = page.getByRole('navigation', { name: 'On this page' });
    // The nav box is empty by design (its list is absolutely placed), so assert
    // on the dashes the reader actually sees.
    await expect(rail.locator('.aec-docs-toc-dash').first()).toBeVisible();
    const link = rail.getByRole('link', { name: 'What does not count' });
    await expect(link).toHaveAttribute('href', '/docs/trust/how-ranking-works#what-does-not-count');
    // Keyboard opens the rail: the focused link's label becomes visible.
    await link.focus();
    await expect(link.locator('.aec-docs-toc-label')).toBeVisible();
    await link.press('Enter');
    await expect(page).toHaveURL(/how-ranking-works#what-does-not-count$/);
    await expect(page.locator('#what-does-not-count')).toBeInViewport();
  });

  test('below lg the menu button opens and closes the sidebar (AECI-1259)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/docs/trust/how-ranking-works');
    await waitForHydrationSettle(page);
    const button = page.getByRole('button', { name: 'Docs menu' });
    const tree = page.getByRole('navigation', { name: 'Help center' });
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(tree).toBeHidden();
    // Also no rail on a phone.
    await expect(page.locator('.aec-docs-toc-dash').first()).toBeHidden();

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(tree).toBeVisible();

    await tree.getByRole('link', { name: 'Agreement states' }).click();
    await expect(page).toHaveURL(/\/docs\/trust\/agreement-states$/);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(tree).toBeHidden();
  });

  for (const path of [
    '/docs',
    '/docs/trust',
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

      // wcag22aa since AECI-1259: the rail's closed links must meet the 24px target size.
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
      expectConsoleClean(capture, `GET ${path}`);
    });
  }
});
