import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';

import { chooseSort, chooseView } from './listing-toolbar';

// AECI-61 / Phase 2.15 / AECI-544 — taxonomy browse pages: /categories/:slug,
// /audiences/:slug, /phases/:slug, /trades/:slug. The four routes share one
// component + resolver, so the spec parametrizes over the kinds. For each it verifies SSR
// render (title "{name} tools — AEC Integrations", canonical, breadcrumb,
// product table), the §4 browse cache headers/tags (route:browse + {type}:{slug}
// + embedded product: tags), product-row navigation, accessibility, and a real
// HTTP 404 for an unknown slug.
//
// Valid slugs are discovered from GET /api/taxonomy (proxied to the API via the
// SSR Worker service binding), so the spec stays seed-agnostic: render/nav
// assertions skip when a kind has no seeded terms; the 404 path needs no data.

type Kind = {
  kind: string;
  segment: string;
  listKey: 'categories' | 'audiences' | 'phases' | 'trades';
};

const KINDS: Kind[] = [
  { kind: 'category', segment: 'categories', listKey: 'categories' },
  { kind: 'audience', segment: 'audiences', listKey: 'audiences' },
  { kind: 'phase', segment: 'phases', listKey: 'phases' },
  { kind: 'trade', segment: 'trades', listKey: 'trades' },
];

type Term = { slug: string; name: string; product_count: number };

/**
 * A term to exercise the page with. Prefers one that actually carries products
 * so the products-table assertions have something to bite on — load-bearing for
 * trades, whose closed 34-term vocabulary is seeded ahead of the tagging, so the
 * first term is usually empty and renders the "nothing tagged yet" panel instead
 * of a table (AECI-544). Falls back to the first term when none has products.
 */
async function firstTerm(
  request: APIRequestContext,
  listKey: Kind['listKey'],
): Promise<Term | null> {
  const res = await request.get('/api/taxonomy');
  if (!res.ok()) return null;
  const body = (await res.json()) as Record<string, Term[]>;
  const terms = body[listKey] ?? [];
  return terms.find((t) => t.product_count > 0) ?? terms[0] ?? null;
}

/** A term with NO products, for the empty-state assertions. `null` if none. */
async function emptyTerm(
  request: APIRequestContext,
  listKey: Kind['listKey'],
): Promise<Term | null> {
  const res = await request.get('/api/taxonomy');
  if (!res.ok()) return null;
  const body = (await res.json()) as Record<string, Term[]>;
  return (body[listKey] ?? []).find((t) => t.product_count === 0) ?? null;
}

for (const { kind, segment, listKey } of KINDS) {
  test.describe(`/${segment}/:slug — ${kind} browse (AECI-61)`, () => {
    test(`renders SSR HTML with the "{name} tools" title, canonical, breadcrumb, and product grid`, async ({
      request,
    }) => {
      const term = await firstTerm(request, listKey);
      test.skip(term === null, `no ${kind} terms seeded in this environment`);

      const res = await request.get(`/${segment}/${term!.slug}`);
      expect(res.status()).toBe(200);
      const html = await res.text();

      // Browse-kind meta suffix is " tools · AEC Integrations".
      expect(html, '<title> must use the browse suffix').toMatch(
        /<title[^>]*>[^<]*tools[^<]*· AEC Integrations[^<]*<\/title>/i,
      );
      expect(html, 'term name must render in the <h1>').toContain(term!.name);
      // Canonical is self-referential — the serving origin, not a hardcoded apex (ADR 0011).
      const origin = new URL(res.url()).origin;
      const canonical = html.match(/rel="canonical"[^>]+href="([^"]+)"/)?.[1];
      expect(canonical, 'canonical <link> must point at the slug URL on the serving origin').toBe(
        `${origin}/${segment}/${term!.slug}`,
      );
      expect(html, 'breadcrumb must mention Home').toMatch(/Home/);
      // AECI-657 — the toolbar SSRs regardless of data, and the default view is
      // the card grid (matching /products), not the table.
      expect(html, 'sort dropdown must render').toMatch(/<select[^>]+id="aec-listing-sort-/);
      expect(html, 'view toggle must render (aria-pressed)').toMatch(/aria-pressed/);
      expect(html, 'card grid is the default view').toMatch(/<aec-product-card-grid/);
    });

    // AECI-657 — the table is still the other half of the toggle; ?view=table is
    // the pre-existing rendering, so this pins that it did not regress.
    test('?view=table SSRs the product table instead of the grid', async ({ request }) => {
      const term = await firstTerm(request, listKey);
      test.skip(term === null, `no ${kind} terms seeded in this environment`);
      test.skip(term!.product_count === 0, `${kind} "${term?.slug}" has no products`);

      const res = await request.get(`/${segment}/${term!.slug}?view=table`);
      expect(res.status()).toBe(200);
      const html = await res.text();

      expect(html, 'products table must render').toMatch(/<table[^>]+aria-label[^>]*>/);
      expect(html, 'the card grid must not render in the table view').not.toMatch(
        /<aec-product-card-grid/,
      );
    });

    // The §4.5 gap this issue closed: the page had no sort control at all.
    test('the sort dropdown updates ?sort= and reflects the choice', async ({ page, request }) => {
      const term = await firstTerm(request, listKey);
      test.skip(term === null, `no ${kind} terms seeded in this environment`);

      await page.goto(`/${segment}/${term!.slug}`);
      await expect(page.locator('app-root')).toBeAttached();

      await chooseSort(page, 'integrations');
    });

    test('the view toggle switches cards ↔ table and reflects ?view=', async ({
      page,
      request,
    }) => {
      const term = await firstTerm(request, listKey);
      test.skip(term === null, `no ${kind} terms seeded in this environment`);
      test.skip(term!.product_count === 0, `${kind} "${term?.slug}" has no products`);

      await page.goto(`/${segment}/${term!.slug}`);
      await expect(page.locator('app-root')).toBeAttached();

      await chooseView(page, 'Table');
      await expect(page.locator('table[aria-label="Products"]')).toBeVisible();

      await chooseView(page, 'Cards');
      await expect(page.locator('table[aria-label="Products"]')).toHaveCount(0);
    });

    test('a term with no products renders the empty panel, not an empty table', async ({
      page,
      request,
    }) => {
      // AECI-544 — "No products match these filters" is a lie when no filter is
      // applied, and filter chrome over an empty set is noise. Most reachable on
      // trades; the assertion is kind-agnostic.
      const term = await emptyTerm(request, listKey);
      test.skip(term === null, `no empty ${kind} term seeded in this environment`);

      await page.goto(`/${segment}/${term!.slug}`);
      await expect(page.locator('app-root')).toBeAttached();

      await expect(page.getByText(`No products are tagged ${term!.name} yet.`)).toBeVisible();
      await expect(page.locator('#main table')).toHaveCount(0);
      await expect(page.locator('aec-facet-sidebar')).toHaveCount(0);
      await expect(
        page.locator('#main').getByRole('link', { name: 'Browse all products' }),
      ).toBeVisible();
    });

    test('emits §4 browse cache headers — s-maxage=300, max-age=0, route:browse + entity tag', async ({
      request,
    }) => {
      const term = await firstTerm(request, listKey);
      test.skip(term === null, `no ${kind} terms seeded in this environment`);

      const res = await request.get(`/${segment}/${term!.slug}`);
      expect(res.status()).toBe(200);

      const cacheControl = res.headers()['cache-control'] ?? '';
      expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=300');
      expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=0');

      const cacheTag = res.headers()['cache-tag'] ?? '';
      expect(cacheTag, `got: ${cacheTag}`).toContain('route:browse');
      expect(cacheTag, `got: ${cacheTag}`).toContain(`${kind}:${term!.slug}`);
      if (term!.product_count > 0) {
        // Each shown product contributes an embedded product:{slug} tag (§3).
        expect(cacheTag, `got: ${cacheTag}`).toContain('product:');
      }
    });

    test('clicking a product row navigates to /products/:slug', async ({ page, request }) => {
      const term = await firstTerm(request, listKey);
      test.skip(term === null, `no ${kind} terms seeded in this environment`);
      test.skip(term!.product_count === 0, `${kind} "${term?.slug}" has no products`);

      // Pinned to the table view: the row component only renders there now that
      // cards is the default (AECI-657).
      await page.goto(`/${segment}/${term!.slug}?view=table`);
      await expect(page.locator('app-root')).toBeAttached();

      const firstProduct = page.locator('tr[aec-product-card] a[href^="/products/"]').first();
      test.skip((await firstProduct.count()) === 0, 'no product rows rendered');

      const href = await firstProduct.getAttribute('href');
      expect(href).toMatch(/^\/products\/[^/]+$/);
      await firstProduct.click();
      await expect(page).toHaveURL(/\/products\/[^/]+$/);
    });

    // AECI-657 — BOTH views are scanned. The toggle made the table a state a
    // reader reaches by choice rather than the only rendering, and a violation
    // behind a toggle is still a violation; scanning only the default would have
    // left half the surface uncovered the moment the toggle shipped.
    for (const view of ['cards', 'table'] as const) {
      test(`has zero axe AA violations (?view=${view})`, async ({ page, request }) => {
        const term = await firstTerm(request, listKey);
        test.skip(term === null, `no ${kind} terms seeded in this environment`);

        await page.goto(`/${segment}/${term!.slug}?view=${view}`);
        await expect(page.locator('app-root')).toBeAttached();

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        expect(results.violations, formatViolations(results.violations)).toEqual([]);
      });
    }

    test('unknown slug returns a real HTTP 404 with the route:404 tag', async ({ request }) => {
      const res = await request.get(`/${segment}/__aeci61-no-such-slug__`);
      expect(res.status(), 'missing term must be a real 404').toBe(404);
      const cacheTag = res.headers()['cache-tag'] ?? '';
      expect(cacheTag, `got: ${cacheTag}`).toContain('route:404');
    });
  });
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
