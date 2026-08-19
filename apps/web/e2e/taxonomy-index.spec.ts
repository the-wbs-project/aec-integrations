import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';

// AECI-61 / AECI-157 / AECI-544 — the four taxonomy flat-index pages
// (`/categories`, `/audiences`, `/phases`, `/trades`): every term with its
// product count, rendered as an editorial card grid. One generalized
// `TaxonomyIndexPage` serves all four.
// Verifies SSR render (title, canonical, breadcrumb), the §4 cache headers/tags,
// accessibility, and that a card navigates to its `/{segment}/:slug` browse page.
//
// Resilient to a populated or empty local DB: card-navigation and count
// assertions only run when at least one term is seeded for that facet.

interface Facet {
  segment: 'categories' | 'audiences' | 'phases' | 'trades';
  title: string;
  /** Key into `GET /api/taxonomy`. */
  apiKey: 'categories' | 'audiences' | 'phases' | 'trades';
  /**
   * Minimum `product_count` for a term to be LISTED on the index. Only trades
   * have a publication floor (`TRADE_PUBLISH_MIN_PRODUCTS`,
   * TRADES_VOCABULARY.md §6) — the API returns every term ungated and the page
   * filters, so the expected card count is the filtered count, not the raw one.
   */
  publishFloor: number;
}

const FACETS: Facet[] = [
  { segment: 'categories', title: 'Categories', apiKey: 'categories', publishFloor: 0 },
  { segment: 'audiences', title: 'Audiences', apiKey: 'audiences', publishFloor: 0 },
  { segment: 'phases', title: 'Phases', apiKey: 'phases', publishFloor: 0 },
  {
    segment: 'trades',
    title: 'Trades',
    apiKey: 'trades',
    publishFloor: TRADE_PUBLISH_MIN_PRODUCTS,
  },
];

for (const facet of FACETS) {
  const path = `/${facet.segment}`;

  test.describe(`${path} — taxonomy index (AECI-157)`, () => {
    test('renders SSR HTML with title, canonical, breadcrumb, and the heading', async ({
      request,
    }) => {
      const res = await request.get(path);
      expect(res.status(), `GET ${path} must return 200`).toBe(200);
      const html = await res.text();

      expect(html, `<title> must include "${facet.title} · AEC Integrations"`).toMatch(
        new RegExp(`<title[^>]*>[^<]*${facet.title}[^<]*· AEC Integrations[^<]*</title>`, 'i'),
      );
      // Canonical is self-referential — the serving origin, not a hardcoded apex (ADR 0011).
      const origin = new URL(res.url()).origin;
      const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1];
      expect(canonical, `canonical <link> must point at ${path} on the serving origin`).toBe(
        `${origin}${path}`,
      );
      expect(html, 'og:type must be "website" for an index page').toMatch(
        /<meta[^>]+property="og:type"[^>]+content="website"/,
      );
      expect(html).toMatch(new RegExp(`<h1[^>]*>[^<]*${facet.title}[^<]*</h1>`, 'i'));
      expect(html, 'breadcrumb must mention Home').toMatch(/Home/);
    });

    test(`emits §4 cache headers — s-maxage=300, max-age=0, Cache-Tag route:index,index:${facet.segment},taxonomy`, async ({
      request,
    }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);

      const cacheControl = res.headers()['cache-control'] ?? '';
      expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=300');
      expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=0');

      const cacheTag = res.headers()['cache-tag'] ?? '';
      expect(cacheTag, `got: ${cacheTag}`).toContain('route:index');
      expect(cacheTag, `got: ${cacheTag}`).toContain(`index:${facet.segment}`);
      expect(cacheTag, `got: ${cacheTag}`).toContain('taxonomy');
    });

    test('lists every term with a product count', async ({ page, request }) => {
      const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
        string,
        Array<{ slug: string; product_count: number }>
      >;
      const terms = (taxonomy[facet.apiKey] ?? []).filter(
        (t) => t.product_count >= facet.publishFloor,
      );
      test.skip(terms.length === 0, `no listable ${facet.segment} seeded in this environment`);

      await page.goto(path);
      await expect(page.locator('app-root')).toBeAttached();

      // Scope to the <main id="main"> content region: the shared header taxonomy
      // flyout (AECI-155) renders the same `/{segment}/:slug` links in the global
      // <header>, which sits outside #main. An unscoped selector would also match
      // those ~10 flyout links and inflate the count (AECI-164).
      const cards = page.locator(`#main a[href^="${path}/"]`);
      await expect(cards).toHaveCount(terms.length);
      // `products?` — the card says "1 product" in the singular, so an
      // environment whose first term happens to carry exactly one would fail a
      // plural-only match.
      await expect(cards.first()).toContainText(/\bproducts?\b/);
    });

    test('clicking a card navigates to the browse page', async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('app-root')).toBeAttached();

      // Scope to #main so the header flyout's `/{segment}/:slug` links (AECI-155)
      // — hidden, outside the content region — can't be `.first()` (AECI-164).
      const firstCard = page.locator(`#main a[href^="${path}/"]`).first();
      test.skip((await firstCard.count()) === 0, `no ${facet.segment} seeded in this environment`);

      const href = await firstCard.getAttribute('href');
      expect(href, `card link must point at ${path}/:slug`).toMatch(new RegExp(`^${path}/[^/]+$`));
      await firstCard.click();
      await expect(page).toHaveURL(new RegExp(`${path}/[^/]+$`));
    });

    test('sorts the grid by name and by product count without a navigation', async ({
      page,
      request,
    }) => {
      const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
        string,
        Array<{ slug: string; name: string; product_count: number; integration_count?: number }>
      >;
      const terms = (taxonomy[facet.apiKey] ?? []).filter(
        (t) => t.product_count >= facet.publishFloor,
      );
      test.skip(terms.length < 2, `needs 2+ listable ${facet.segment} to observe an ordering`);

      await page.goto(path);
      await expect(page.locator('app-root')).toBeAttached();

      const cards = page.locator(`#main a[href^="${path}/"]`);
      const slugs = async () =>
        (await cards.evaluateAll((links) =>
          links.map((l) => l.getAttribute('href')?.split('/').pop() ?? ''),
        )) as string[];

      // Read through `expect.poll`, never a bare `await slugs()`: a click sets a
      // signal and Angular reconciles the `@for` asynchronously, so a one-shot
      // `evaluateAll` can snapshot the grid mid-move and see a short list.
      // Polling asserts the settled order, which is the actual claim.
      const expectOrder = async (expected: string[], label: string) =>
        expect.poll(slugs, { message: `grid must settle into ${label} order` }).toEqual(expected);

      const apiOrder = terms.map((t) => t.slug);
      // Derived from `name`, not from the slug: a slug is a transliteration
      // (`Punch List & QA/QC` becomes `punch-list-qa-qc`), so slug order and
      // display-name order are not the same sequence in general.
      const alphabetical = [...terms]
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
        .map((t) => t.slug);
      const byProducts = [...terms]
        .sort(
          (a, b) =>
            b.product_count - a.product_count ||
            (b.integration_count ?? 0) - (a.integration_count ?? 0) ||
            a.name.localeCompare(b.name, 'en'),
        )
        .map((t) => t.slug);

      // Each facet's DEFAULT is what SSR emitted: the curated sequence for
      // phases, A→Z for the other three (which do not offer `Sequence` at all).
      const isPhases = facet.segment === 'phases';
      await expectOrder(isPhases ? apiOrder : alphabetical, isPhases ? 'the API sequence' : 'A→Z');

      const optionLabels = await page
        .locator('#main fieldset button')
        .evaluateAll((bs) => bs.map((b) => b.textContent?.trim() ?? ''));
      expect(optionLabels).toEqual(
        isPhases ? ['Sequence', 'A → Z', 'Products'] : ['A → Z', 'Products'],
      );

      await page.getByRole('button', { name: 'Products', exact: true }).click();
      // Sorting must reorder, never add or drop a card, so the set is invariant.
      await expect.poll(async () => [...(await slugs())].sort()).toEqual([...apiOrder].sort());
      await expectOrder(byProducts, 'product count');

      // Reordering is local: no navigation, so the URL is untouched and the edge
      // cache key cannot fork on a sort choice.
      expect(new URL(page.url()).pathname).toBe(path);
      expect(new URL(page.url()).search).toBe('');

      await page.getByRole('button', { name: 'A → Z', exact: true }).click();
      await expectOrder(alphabetical, 'alphabetical');

      if (isPhases) {
        await page.getByRole('button', { name: 'Sequence', exact: true }).click();
        await expectOrder(apiOrder, 'the API sequence again');
      }
    });

    test('has zero axe AA violations', async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('app-root')).toBeAttached();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(results.violations, formatViolations(results.violations)).toEqual([]);
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
