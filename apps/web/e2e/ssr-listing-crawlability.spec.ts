/**
 * AECI-746 — listing pages must ship product links in their SERVER-RENDERED HTML.
 *
 * The regression guard for a defect that was invisible for months precisely
 * because every browser-based test passed: `/products` and the taxonomy browse
 * pages rendered correctly once JavaScript ran, and shipped an error document
 * ("Couldn't load products. Refresh to try again.") to anything that did not.
 * That is every crawler on its first pass. Googlebot reached 12% of the sitemap in
 * August 2026 against Bingbot's 65%, because Bing is pushed URLs via IndexNow and
 * never had to crawl a hub page.
 *
 * **These tests use `request`, never `page`, and that is the whole point.**
 * `request.get()` performs a plain HTTP GET and runs no JavaScript, so it sees
 * exactly what a crawler sees. A `page.goto()` version of this test would have
 * passed throughout the entire period the bug was live. If someone later
 * "modernizes" this file onto the `page` fixture, it stops testing anything.
 */
import { expect, test } from '@playwright/test';

/** The literal copy of the error branch these pages used to render. */
const ERROR_COPY = "Couldn't load products";

/** Product-detail links in raw markup. The listing grid emits one per card. */
function productLinkCount(html: string): number {
  return new Set(html.match(/href="\/products\/[a-z0-9-]+"/g) ?? []).size;
}

/**
 * One page per SHAPE of listing surface, not per URL.
 *
 * `/products` is the flat catalogue. The taxonomy hubs take a materially
 * different code path — their request is scoped to a term resolved earlier in the
 * same resolver, so a sibling resolver would build its URL before the term
 * existed — and can therefore break independently of `/products`.
 */
const LISTING_PAGES = [
  { path: '/products', label: 'flat catalogue' },
  { path: '/products?sort=name', label: 'flat catalogue, non-default sort' },
  { path: '/categories/project-management', label: 'category hub' },
  { path: '/audiences/general-contracting', label: 'audience hub' },
  { path: '/phases/construction', label: 'phase hub' },
] as const;

test.describe('SSR listing crawlability (AECI-746)', () => {
  for (const { path, label } of LISTING_PAGES) {
    test(`${path} ships product links to a crawler (${label})`, async ({ request }) => {
      const response = await request.get(path);
      expect(response.status()).toBe(200);

      const html = await response.text();

      // Assert the error copy FIRST. It is the specific failure being guarded,
      // and naming it makes a regression self-diagnosing rather than just "0 links".
      expect(
        html,
        `${path} server-rendered its error branch — a crawler sees no catalogue here`,
      ).not.toContain(ERROR_COPY);

      expect(
        productLinkCount(html),
        `${path} server-rendered zero product links; crawlers cannot reach the catalogue through it`,
      ).toBeGreaterThan(0);
    });
  }

  test('the prefetched payload is transferred, so hydration does not refetch', async ({
    request,
  }) => {
    // The second half of the fix: the server parks its response in TransferState
    // under the exact request line, and the client spends it once on hydration
    // instead of issuing the same GET again. Asserted on the serialized state
    // rather than by counting network calls, because this must hold for the
    // no-JavaScript case too.
    const html = await (await request.get('/products')).text();
    // The key is JSON-escaped inside the `ng-state` script tag (`/` -> `\u002F`),
    // so assert on the prefix only. It is unique to this mechanism: nothing else
    // in the app writes an `aeci.api:` TransferState key.
    expect(html).toContain('aeci.api:');
  });
});
