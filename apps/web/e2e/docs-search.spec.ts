/**
 * AECI-1270 — the per-guide docs search box, against a live docs index.
 *
 * Needs `window.__AECI_ALGOLIA__` with a `docsIndex`, and that index pushed
 * (`scripts/algolia/push-docs.mjs`). The file skips before any page load when the
 * server injects no docs config (CI's dev:bound). Each test skips, saying why, when
 * the index answers nothing (not pushed yet, or a
 * key that does not reach it, as on a local run before the first push). Run it by hand against staging after the first
 * push:
 *
 *   PLAYWRIGHT_BASE_URL=https://staging.aecintegrations.com pnpm --filter @aeci/web exec playwright test e2e/docs-search.spec.ts
 *
 * The box's wiring (filter per guide, keyboard, no-config) is pinned in
 * `src/app/docs/docs-search.component.spec.ts`; this proves the real index
 * answers each guide with only that guide's pages.
 */
import { expect, test, type Page } from './fixtures';

/**
 * Why the live test cannot run here, or `null` when it can. Skips with no
 * config (CI), and when the docs index answers nothing: not pushed yet, or the
 * key does not reach it. One read query, the same one the box sends.
 */
async function docsSearchUnavailable(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const cfg = (
      window as { __AECI_ALGOLIA__?: { appId?: string; searchKey?: string; docsIndex?: string } }
    ).__AECI_ALGOLIA__;
    if (!cfg?.appId || !cfg.searchKey || !cfg.docsIndex) return 'no docs search config';
    const res = await fetch(
      `https://${cfg.appId}-dsn.algolia.net/1/indexes/${cfg.docsIndex}/query`,
      {
        method: 'POST',
        headers: { 'X-Algolia-Application-Id': cfg.appId, 'X-Algolia-API-Key': cfg.searchKey },
        body: JSON.stringify({ query: '', hitsPerPage: 1 }),
      },
    ).catch(() => null);
    if (!res?.ok) return `${cfg.docsIndex} not readable (HTTP ${res?.status ?? 'error'})`;
    const body = (await res.json()) as { nbHits?: number };
    return body.nbHits ? null : `${cfg.docsIndex} is empty (not pushed yet)`;
  });
}

const CASES = [
  { start: '/docs', label: 'Search General', query: 'review', prefix: /^\/docs\/(?!vendors)/ },
  {
    start: '/docs/vendors',
    label: 'Search For vendors',
    query: 'seat',
    prefix: /^\/docs\/vendors(\/|#|$)/,
  },
] as const;

test.describe('/docs search box — AECI-1270 (requires a pushed docs index)', () => {
  // Skip the whole file before any page load when the server injects no docs
  // search config, as in CI (AECI-2027). The config ships inline in the SSR HTML,
  // so one request reads it. The per-test check below still covers an index that
  // is configured but empty or unreadable, which needs the browser to query it.
  test.beforeAll(async ({ request }) => {
    const html = await (await request.get('/docs')).text();
    test.skip(!/__AECI_ALGOLIA__=[^<]*"docsIndex":"[^"]+"/.test(html), 'no docs search config');
  });

  for (const { start, label, query, prefix } of CASES) {
    test(`${label} finds pages in its own guide only`, async ({ page }) => {
      await page.goto(start);
      const unavailable = await docsSearchUnavailable(page);
      test.skip(unavailable !== null, unavailable ?? '');

      const input = page.getByRole('combobox', { name: label });
      await expect(input).toBeVisible();
      await input.fill(query);

      const options = page.getByRole('option');
      await expect(options.first()).toBeVisible();
      await input.press('Enter');

      await expect(page).toHaveURL((url) => prefix.test(url.pathname + url.hash));
      await expect(page.locator('main h1, article h1').first()).toBeVisible();
    });
  }
});
