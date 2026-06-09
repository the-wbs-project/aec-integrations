import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-61 / AECI-157 — the three taxonomy flat-index pages (`/categories`,
// `/audiences`, `/phases`): every term with its product count, rendered as an
// editorial card grid. One generalized `TaxonomyIndexPage` serves all three.
// Verifies SSR render (title, canonical, breadcrumb), the §4 cache headers/tags,
// accessibility, and that a card navigates to its `/{segment}/:slug` browse page.
//
// Resilient to a populated or empty local DB: card-navigation and count
// assertions only run when at least one term is seeded for that facet.

interface Facet {
  segment: 'categories' | 'audiences' | 'phases';
  title: string;
  /** Key into `GET /api/taxonomy`. */
  apiKey: 'categories' | 'audiences' | 'phases';
}

const FACETS: Facet[] = [
  { segment: 'categories', title: 'Categories', apiKey: 'categories' },
  { segment: 'audiences', title: 'Audiences', apiKey: 'audiences' },
  { segment: 'phases', title: 'Phases', apiKey: 'phases' },
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
        Array<{ slug: string }>
      >;
      const terms = taxonomy[facet.apiKey] ?? [];
      test.skip(terms.length === 0, `no ${facet.segment} seeded in this environment`);

      await page.goto(path);
      await expect(page.locator('app-root')).toBeAttached();

      // Scope to the <main id="main"> content region: the shared header taxonomy
      // flyout (AECI-155) renders the same `/{segment}/:slug` links in the global
      // <header>, which sits outside #main. An unscoped selector would also match
      // those ~10 flyout links and inflate the count (AECI-164).
      const cards = page.locator(`#main a[href^="${path}/"]`);
      await expect(cards).toHaveCount(terms.length);
      await expect(cards.first()).toContainText(/\bproducts\b/);
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
