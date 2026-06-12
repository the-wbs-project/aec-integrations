import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// AECI-142 / Phase 3.9 — the /search page. Search runs browser-side against
// Algolia with the search-only key; CI / local-bound has no provisioned Algolia
// key, so the page naturally exercises the GRACEFUL-DEGRADATION path (the
// `window.__AECI_ALGOLIA__` bootstrap is absent → "temporarily unavailable"
// notice after hydration). We therefore assert the SSR shell, the non-cacheable
// + noindex headers/meta, accessibility, and the header search entry point —
// but NOT live results.

const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('/search — search page (AECI-142)', () => {
  test('renders the SSR shell: title, search box, and entity tablist', async ({ request }) => {
    const res = await request.get('/search');
    expect(res.status(), 'GET /search must return 200').toBe(200);
    const html = await res.text();

    expect(html, '<h1>Search</h1> must render SSR-side').toMatch(
      /<h1[^>]*>[^<]*Search[^<]*<\/h1>/i,
    );
    expect(html, 'a search input named q must render').toMatch(
      /<input[^>]+name="q"[^>]+type="search"|<input[^>]+type="search"[^>]+name="q"/,
    );
    expect(html, 'an ARIA tablist must render').toMatch(/role="tablist"/);
    expect((html.match(/role="tab"/g) ?? []).length, 'two entity tabs').toBe(2);
  });

  test('is non-cacheable (private, no-store) and noindex', async ({ request }) => {
    const res = await request.get('/search');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `Cache-Control must be no-store; got: ${cacheControl}`).toContain(
      'no-store',
    );
    expect(cacheControl, `Cache-Control must be private; got: ${cacheControl}`).toContain(
      'private',
    );

    const html = await res.text();
    expect(html, 'robots noindex meta must be present').toMatch(
      /<meta[^>]+name="robots"[^>]+content="noindex"/,
    );
  });

  test('has zero axe AA violations', async ({ page }) => {
    await page.goto('/search');
    await expect(page.locator('app-search-page')).toBeAttached();

    const violations = await aaViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test('the header search box navigates to /search?q=', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const input = page.locator('form[role="search"] input[name="q"]').first();
    test.skip((await input.count()) === 0, 'header search not present at this viewport');

    await input.fill('revit');
    await input.press('Enter');

    await expect(page).toHaveURL(/\/search\?.*q=revit/);
    await expect(page.locator('app-search-page h1')).toHaveText(/Search/);
  });
});

// AECI-145 / Phase 3.12 — the live-Algolia leg of "search → results → click
// result lands on the detail page". This needs a provisioned Algolia search key
// (the `window.__AECI_ALGOLIA__` bootstrap), which CI's dev:bound does NOT have,
// so every test here self-skips in CI and runs only locally/preview when
// `.dev.vars` supplies search creds. The CI-deterministic embodiment of this
// flow (facet refine → result click → detail h1, via the API-backed /products
// path) lives in facets.spec.ts.
test.describe('/search — live results (requires Algolia; local/preview only)', () => {
  test('search box → product results → result click lands on the detail page', async ({ page }) => {
    await page.goto('/search');
    const hasAlgolia = await page.evaluate(() =>
      Boolean((globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__),
    );
    test.skip(!hasAlgolia, 'Algolia not provisioned (CI dev:bound) — live results unavailable');

    // Products is the default tab. Type a broad query and wait for hits to land.
    await page.locator('#search-input').fill('a');

    const firstHit = page.locator('aec-search-product-card a[href^="/products/"]').first();
    await firstHit.waitFor({ timeout: 8000 }).catch(() => {});
    test.skip((await firstHit.count()) === 0, 'no product hits for this query in the live index');

    await firstHit.click();
    await expect(page).toHaveURL(/\/products\/[^/?#]+$/);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  });
});

async function aaViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).analyze();
  return results.violations;
}

function formatViolations(
  violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations'],
): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `[${v.impact ?? '?'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))\n` +
        v.nodes.map((n) => `  - ${n.target.join(', ')}\n    ${n.failureSummary ?? ''}`).join('\n'),
    )
    .join('\n\n');
}
