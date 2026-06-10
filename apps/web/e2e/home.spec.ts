import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// AECI-184 — Phase 4.9 home "Browse by" grids. Three count-chip subsections
// (category / audience / project phase) reading the LIVE aggregate taxonomy
// (`GET /api/taxonomy`, resolved SSR-side), each chip linking to its
// `/{segment}/:slug` browse page, plus a "View all" link to the facet index.
// Verifies SSR render, the §4 home cache headers/tags (s-maxage=900,
// route:index + taxonomy), live counts, navigation, and accessibility.
//
// Resilient to a populated or empty local DB: count/navigation assertions only
// run when at least one term is seeded for that facet.

interface Facet {
  segment: 'categories' | 'audiences' | 'phases';
  /** Key into `GET /api/taxonomy`. */
  apiKey: 'categories' | 'audiences' | 'phases';
  heading: string;
  /** Top-N cap the home applies (categories/audiences), or null for "show all". */
  cap: number | null;
}

const FACETS: Facet[] = [
  { segment: 'categories', apiKey: 'categories', heading: 'Browse by category', cap: 10 },
  { segment: 'audiences', apiKey: 'audiences', heading: 'Browse by audience', cap: 10 },
  { segment: 'phases', apiKey: 'phases', heading: 'Browse by project phase', cap: null },
];

test.describe('/ — home "Browse by" grids (AECI-184)', () => {
  test('SSR-renders the three browse headings', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), 'GET / must return 200').toBe(200);
    const html = await res.text();
    for (const facet of FACETS) {
      expect(html, `SSR HTML must include "${facet.heading}"`).toContain(facet.heading);
    }
  });

  test('emits §4 home cache headers — public, max-age=300, s-maxage=900, Cache-Tag route:index,taxonomy', async ({
    request,
  }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);

    const cacheControl = res.headers()['cache-control'] ?? '';
    expect(cacheControl, `got: ${cacheControl}`).toContain('s-maxage=900');
    expect(cacheControl, `got: ${cacheControl}`).toContain('max-age=300');

    const cacheTag = res.headers()['cache-tag'] ?? '';
    expect(cacheTag, `got: ${cacheTag}`).toContain('route:index');
    expect(cacheTag, `got: ${cacheTag}`).toContain('taxonomy');
  });

  for (const facet of FACETS) {
    test(`${facet.segment}: renders top chips with live counts linking to browse pages`, async ({
      page,
      request,
    }) => {
      const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
        string,
        Array<{ slug: string }>
      >;
      const terms = taxonomy[facet.apiKey] ?? [];
      test.skip(terms.length === 0, `no ${facet.segment} seeded in this environment`);

      const expected = facet.cap === null ? terms.length : Math.min(terms.length, facet.cap);

      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();

      // Scope to <main id="main">: the global header taxonomy flyout (AECI-155)
      // renders the same `/{segment}/:slug` links outside the content region, and
      // the "View all" link is `/{segment}` (no trailing slug) so it's excluded.
      const chips = page.locator(`#main a[href^="/${facet.segment}/"]`);
      await expect(chips).toHaveCount(expected);
      // Each chip shows a numeric product count ("{name} {count}").
      await expect(chips.first()).toContainText(/\d/);
    });

    test(`${facet.segment}: "View all" links to the facet index`, async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();

      const viewAll = page.locator(`#main a[href="/${facet.segment}"]`);
      await expect(viewAll).toHaveCount(1);
      await viewAll.click();
      await expect(page).toHaveURL(new RegExp(`/${facet.segment}$`));
    });
  }

  test('clicking a chip navigates to its browse page', async ({ page, request }) => {
    const taxonomy = (await (await request.get('/api/taxonomy')).json()) as Record<
      string,
      Array<{ slug: string }>
    >;
    test.skip(
      (taxonomy['categories'] ?? []).length === 0,
      'no categories seeded in this environment',
    );

    await page.goto('/');
    await expect(page.locator('app-root')).toBeAttached();

    const firstChip = page.locator('#main a[href^="/categories/"]').first();
    const href = await firstChip.getAttribute('href');
    expect(href, 'chip must link to /categories/:slug').toMatch(/^\/categories\/[^/]+$/);
    await firstChip.click();
    await expect(page).toHaveURL(/\/categories\/[^/]+$/);
  });

  // Both themes (the page is token-driven, no `dark:` markup): axe reads computed
  // styles, so toggling `.theme-dark` genuinely re-checks dark-theme contrast.
  for (const theme of ['light', 'dark'] as const) {
    test(`has zero axe AA violations (${theme} theme)`, async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('app-root')).toBeAttached();
      if (theme === 'dark') {
        await page.evaluate(() => document.documentElement.classList.add('theme-dark'));
      }

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });
  }
});

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
