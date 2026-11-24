/**
 * AECI-1863: hydration keeps the server's product grid and pagination footer.
 *
 * The listing's data arrives through `httpResource`, which hands back its
 * first value a microtask after the first client render. Before the fix that
 * render had no items, so the results block took its "Loading products…"
 * branch. Hydration then removed the server's grid and footer from the DOM and
 * inserted them again about 10ms later, at roughly 250ms after load. The fix
 * reads the server's page from TransferState on the first client render
 * (`paginated-index-controller.ts`), so that render matches the server's.
 *
 * The probe tags the grid and footer as soon as they parse and records every
 * removal of either, and every "Loading products…" line added, until the page
 * has settled. A removal and re-insert of the same node still counts.
 */
import { expect, test } from './fixtures';

import { untilHydrated } from './hydration';

interface Probe {
  removed: string[];
  loadingAdded: number;
}

async function probe(page: import('@playwright/test').Page, path: string): Promise<Probe> {
  await page.addInitScript(() => {
    const w = window as unknown as { __probe: Probe };
    w.__probe = { removed: [], loadingAdded: 0 };
    let watched: Element[] = [];
    new MutationObserver((mutations) => {
      if (watched.length === 0) {
        const grid = document.querySelector('aec-product-card-grid');
        const footer = document.querySelector('aec-pagination-footer');
        if (grid && footer) watched = [grid, footer];
      }
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          for (const el of watched) {
            if (node === el || node.contains(el)) w.__probe.removed.push(el.tagName);
          }
        }
        for (const node of m.addedNodes) {
          if (node.textContent?.includes('Loading products')) w.__probe.loadingAdded++;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(path);
  await untilHydrated(page.locator('aec-listing-toolbar button[role="combobox"]'));
  // A fixed wait on purpose. The probe records removals that must not happen, so a
  // window has to pass after hydration before the test can say none did.
  await page.waitForTimeout(1_500);
  return page.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
}

test.describe('listing grid survives hydration (AECI-1863)', () => {
  test('/products keeps its server grid and footer', async ({ page, request }) => {
    const res = await request.get('/api/products?perPage=1&page=1');
    const total = ((await res.json()) as { total?: number }).total ?? 0;
    test.skip(total === 0, 'no products seeded in this environment');

    const result = await probe(page, '/products');
    expect(result.removed, 'grid and footer nodes removed during hydration').toEqual([]);
    expect(result.loadingAdded, '"Loading products…" inserted during hydration').toBe(0);
  });

  test('a taxonomy term page keeps its server grid and footer', async ({ page, request }) => {
    const taxonomy = (await (await request.get('/api/taxonomy')).json()) as {
      categories?: Array<{ slug: string; product_count: number }>;
    };
    const term = (taxonomy.categories ?? []).find((t) => t.product_count > 0);
    test.skip(!term, 'no category with products in this environment');

    const result = await probe(page, `/categories/${term!.slug}`);
    expect(result.removed, 'grid and footer nodes removed during hydration').toEqual([]);
    expect(result.loadingAdded, '"Loading products…" inserted during hydration').toBe(0);
  });
});
