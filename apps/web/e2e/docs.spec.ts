/**
 * AECI-1248 — the docs shell: `/docs` home, a section index, an article, the
 * prev/next pager, and the explicit route table's 404 for unknown paths.
 * AECI-1259 — the DeepWiki-style layout: the sidebar tree, the small-screen
 * menu, the "On this page" rail and its fragment links.
 * AECI-1265 — the help center and the vendor guide: two trees from one manifest.
 * AECI-1271 — the General / For vendors guide toggle at the top of the sidebar.
 *
 * AECI-1253 — the vendor guide is indexable, like every help page.
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

  test('serves the vendor guide indexable like a help page, its section index included (AECI-1253)', async ({
    request,
  }) => {
    // The env-wide X-Robots-Tag is a per-tier gate (absent only where
    // ALLOW_INDEXING is "true"). The vendor guide must get exactly what a help
    // page gets in this env, and no robots meta of its own.
    const helpHeader = (await request.get('/docs/reviewers', { maxRedirects: 0 })).headers()[
      'x-robots-tag'
    ];
    // AECI-1271: overview and claiming moved into the vendor guide at the same URLs.
    for (const path of [
      '/docs/vendors',
      '/docs/vendors/your-seat',
      '/docs/vendors/overview',
      '/docs/vendors/claiming-your-listing',
      '/docs/vendors/connector-vendors',
      '/docs/vendors/plans',
    ]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
      expect(res.headers()['x-robots-tag'], path).toBe(helpHeader);
      expect(await res.text(), path).not.toMatch(/<meta[^>]+name="robots"/);
    }
  });

  test('an unknown docs path is a real 404', async ({ request }) => {
    // `/docs/trust/the-account-label` never shipped, so it has no redirect (AECI-1264).
    for (const path of [
      '/docs/nope',
      '/docs/vendors/nope',
      '/docs/faq',
      '/docs/trust/the-account-label',
    ]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(404);
    }
  });

  // AECI-1264 — the plans page was renamed. Its old URL is live in production, so
  // it answers a permanent redirect to the new one, and the new one renders.
  test('the old plans URL 301s to /docs/vendors/plans', async ({ request }) => {
    const res = await request.get('/docs/vendors/plans-and-the-account-label', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(new URL(res.headers()['location'] ?? '', 'http://x').pathname).toBe(
      '/docs/vendors/plans',
    );
    const target = await request.get('/docs/vendors/plans', { maxRedirects: 0 });
    expect(target.status()).toBe(200);
    expect(await target.text()).toMatch(/<h1[^>]*>\s*Plans\s*<\/h1>/);
  });

  // AECI-1249 — the reader pages. Indexable, so the page meta must not carry
  // noindex (the env-level X-Robots-Tag is a separate, per-tier gate).
  const READER_PAGES: readonly (readonly [string, string])[] = [
    ['/docs/getting-started/about-aec-integrations', 'About AEC Integrations'],
    ['/docs/getting-started/reading-an-integration-page', 'Reading an integration page'],
    ['/docs/getting-started/checking-before-you-buy', 'Checking an integration before you buy'],
    ['/docs/getting-started/taxonomy', 'How listings are classified'],
    ['/docs/trust/how-ranking-works', 'How ranking works'],
    ['/docs/trust/agreement-states', 'Agreement states'],
  ];

  test('SSR-renders the reader pages with their titles (AECI-1249)', async ({ request }) => {
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

    await page.locator('main div[data-section="reviewers"] h3 a').click();
    await expect(page).toHaveURL(/\/docs\/reviewers$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reviewer guide');

    // The section index's own list, not the sidebar's link to the same page.
    await page.locator('main ol h2 a[href="/docs/reviewers/writing-a-review"]').click();
    await expect(page).toHaveURL(/\/docs\/reviewers\/writing-a-review$/);

    const pager = page.getByRole('navigation', { name: 'Previous and next articles' });
    await pager.getByRole('link', { name: /Next/ }).click();
    await expect(page).toHaveURL(/\/docs\/reviewers\/requests-and-corrections$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Requests and corrections');

    await pager.getByRole('link', { name: /Previous/ }).click();
    await expect(page).toHaveURL(/\/docs\/reviewers\/writing-a-review$/);

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

    await tree.getByRole('link', { name: 'Agreement states', exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/trust\/agreement-states$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agreement states');
    await expect(tree.locator('a[aria-current="page"]')).toHaveText('Agreement states');
  });

  // AECI-1271 — /docs opens on General. The toggle reaches the vendor guide,
  // whose first pages are overview and claiming, and comes back.
  test('the guide toggle switches between General and For vendors', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/docs');
    await waitForHydrationSettle(page);
    const guides = page.getByRole('navigation', { name: 'Guides' });
    await expect(guides.locator('a[aria-current="true"]')).toHaveText('General');
    const help = page.getByRole('navigation', { name: 'Help center' });
    await expect(help.getByRole('link', { name: 'Your seat' })).toHaveCount(0);

    await guides.getByRole('link', { name: 'For vendors' }).click();
    await expect(page).toHaveURL(/\/docs\/vendors$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vendor guide');
    await expect(guides.locator('a[aria-current="true"]')).toHaveText('For vendors');
    const guide = page.getByRole('navigation', { name: 'Vendor guide' });
    await expect(guide).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Help center' })).toHaveCount(0);
    await expect(page.locator('#current-limits')).toHaveText('Current limits');

    await guide.getByRole('link', { name: 'Claiming your vendor listing', exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/vendors\/claiming-your-listing$/);
    await expect(guide.locator('a[aria-current="page"]')).toHaveText(
      'Claiming your vendor listing',
    );
    await expect(guides.locator('a[aria-current="true"]')).toHaveText('For vendors');

    await guides.getByRole('link', { name: 'General' }).click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('navigation', { name: 'Help center' })).toBeVisible();
    await expect(guides.locator('a[aria-current="true"]')).toHaveText('General');
  });

  test('SSR-renders the toggle and the vendor guide tree on its pages', async ({ request }) => {
    for (const path of ['/docs/vendors/your-seat', '/docs/vendors/claiming-your-listing']) {
      const html = await (await request.get(path)).text();
      expect(html, path).toMatch(/<nav[^>]+aria-label="Guides"/);
      expect(html, path).toMatch(/<a(?=[^>]*href="\/docs\/vendors")(?=[^>]*aria-current="true")/);
      expect(html, path).toMatch(/<nav[^>]+aria-label="Vendor guide"/);
      expect(html, path).not.toMatch(/<nav[^>]+aria-label="Help center"/);
      expect(html, path).not.toContain('Back to the help center');
    }
    const help = await (await request.get('/docs/trust/how-ranking-works')).text();
    // Attribute order is the renderer's, so match both attributes on one tag.
    expect(help).toMatch(/<a(?=[^>]*href="\/docs")(?=[^>]*aria-current="true")/);
    expect(help).not.toContain('data-section="vendors"');
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
    '/docs/vendors',
    '/docs/vendors/overview',
    '/docs/vendors/your-seat',
    '/docs/vendors/plans',
    '/docs/vendors/connector-vendors',
    '/docs/getting-started/checking-before-you-buy',
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
