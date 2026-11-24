/**
 * AECI-1877: routes every keyboard spec installs before it loads a surface.
 *
 * The signed-in surfaces run as real test accounts in the shared Supabase
 * project, and they hold the account delete and ban dialogs. A walk presses
 * Escape and Tab, never a confirm control, but a guard is cheaper than trusting
 * that. `guardWrites` aborts every request that is not a read, on any origin:
 * the app's own API, Supabase (a sign-out would end the CI session too), and
 * analytics. A route a spec adds after this one runs first, so a stub still answers.
 */
import type { Page } from '@playwright/test';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Abort every non-read request. Register before any stub. */
export async function guardWrites(page: Page): Promise<void> {
  await page.route('**/*', (route) =>
    READS.has(route.request().method()) ? route.fallback() : route.abort('blockedbyclient'),
  );
}

/**
 * A fixed Algolia for the header search box, so its suggestion list opens on
 * every run with the same rows and no query reaches a live index. The same
 * stand-in as `mockMenuSearch` in `e2e/nav-menu.spec.ts`. Register after
 * `guardWrites`: Algolia queries are POSTs.
 */
export async function fakeHeaderSearch(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __AECI_ALGOLIA__: unknown }).__AECI_ALGOLIA__ = {
      appId: 'E2ETEST',
      searchKey: 'e2e',
      indexes: { products: 'products', vendors: 'vendors', integrations: 'integrations' },
    };
  });
  await page.route('**/1/indexes/*/queries**', async (route) => {
    const body = route.request().postDataJSON() as { requests: { query?: string }[] };
    const query = body.requests[0]?.query ?? '';
    const products = Array.from({ length: 3 }, (_, i) => ({
      objectID: `p${i}`,
      name: `Fixture product ${i + 1}`,
      slug: `fixture-product-${i + 1}`,
      vendor_name: 'Fixture Vendor',
    }));
    const vendors = Array.from({ length: 2 }, (_, i) => ({
      objectID: `v${i}`,
      company_name: `Fixture vendor ${i + 1}`,
      slug: `fixture-vendor-${i + 1}`,
    }));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          { hits: products, nbHits: products.length, query, params: '', index: 'products' },
          { hits: vendors, nbHits: vendors.length, query, params: '', index: 'vendors' },
        ],
      }),
    });
  });
}
