import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

// AECI-142 / Phase 3.9 — the /search page. Search runs browser-side against
// Algolia with the search-only key; CI / local-bound has no provisioned Algolia
// key, so the page naturally exercises the GRACEFUL-DEGRADATION path (the
// `window.__AECI_ALGOLIA__` bootstrap is absent → "temporarily unavailable"
// notice after hydration). We therefore assert the SSR shell, the non-cacheable
// + noindex headers/meta, accessibility in both themes, and the header search
// entry point — but NOT live results.

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:8788';
const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe('/search — search page (AECI-142)', () => {
  test('renders the SSR shell: title, search box, and entity tablist', async ({ request }) => {
    const res = await request.get('/search');
    expect(res.status(), 'GET /search must return 200').toBe(200);
    const html = await res.text();

    expect(html, '<h1>Search</h1> must render SSR-side').toMatch(/<h1[^>]*>[^<]*Search[^<]*<\/h1>/i);
    expect(html, 'a search input named q must render').toMatch(
      /<input[^>]+name="q"[^>]+type="search"|<input[^>]+type="search"[^>]+name="q"/,
    );
    expect(html, 'an ARIA tablist must render').toMatch(/role="tablist"/);
    expect((html.match(/role="tab"/g) ?? []).length, 'three entity tabs').toBeGreaterThanOrEqual(3);
  });

  test('is non-cacheable (private, no-store) and noindex', async ({ request }) => {
    const res = await request.get('/search');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `Cache-Control must be no-store; got: ${cacheControl}`).toContain(
      'no-store',
    );
    expect(cacheControl, `Cache-Control must be private; got: ${cacheControl}`).toContain('private');

    const html = await res.text();
    expect(html, 'robots noindex meta must be present').toMatch(
      /<meta[^>]+name="robots"[^>]+content="noindex"/,
    );
  });

  test('has zero axe AA violations (light)', async ({ page }) => {
    await page.goto('/search');
    await expect(page.locator('app-search-page')).toBeAttached();

    const violations = await aaViolations(page);
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  test('has zero axe AA violations (dark)', async ({ page, context }) => {
    await gotoDark(page, context, '/search');

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

async function aaViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(WCAG_AA_TAGS)
    // The footer carries separately-tracked dark-theme contrast debt (same
    // carve-out as phase2-a11y.spec.ts). The header IS scanned.
    .exclude('aec-site-footer')
    .analyze();
  return results.violations;
}

async function gotoDark(page: Page, context: BrowserContext, path: string): Promise<void> {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: 'theme',
      value: 'dark',
      domain: url.hostname,
      path: '/',
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('theme', 'dark');
    } catch {
      /* storage blocked — ignore */
    }
  });
  await page.goto(path);
  await page.waitForFunction(() => document.documentElement.classList.contains('theme-dark'));
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
