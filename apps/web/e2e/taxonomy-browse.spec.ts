import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext } from '@playwright/test';

// AECI-61 / Phase 2.15 — taxonomy browse pages: /categories/:slug,
// /disciplines/:slug, /phases/:slug. The three routes share one component +
// resolver, so the spec parametrizes over the kinds. For each it verifies SSR
// render (title "{name} tools — AEC Integrations", canonical, breadcrumb,
// product table), the §4 browse cache headers/tags (route:browse + {type}:{slug}
// + embedded product: tags), product-row navigation, accessibility, and a real
// HTTP 404 for an unknown slug.
//
// Valid slugs are discovered from GET /api/taxonomy (proxied to the API via the
// SSR Worker service binding), so the spec stays seed-agnostic: render/nav
// assertions skip when a kind has no seeded terms; the 404 path needs no data.

type Kind = { kind: string; segment: string; listKey: 'categories' | 'disciplines' | 'phases' };

const KINDS: Kind[] = [
  { kind: 'category', segment: 'categories', listKey: 'categories' },
  { kind: 'discipline', segment: 'disciplines', listKey: 'disciplines' },
  { kind: 'phase', segment: 'phases', listKey: 'phases' },
];

type Term = { slug: string; name: string; product_count: number };

async function firstTerm(
  request: APIRequestContext,
  listKey: Kind['listKey'],
): Promise<Term | null> {
  const res = await request.get('/api/taxonomy');
  if (!res.ok()) return null;
  const body = (await res.json()) as Record<string, Term[]>;
  return body[listKey]?.[0] ?? null;
}

for (const { kind, segment, listKey } of KINDS) {
  test.describe(`/${segment}/:slug — ${kind} browse (AECI-61)`, () => {
    test(`renders SSR HTML with the "{name} tools" title, canonical, breadcrumb, and product table`, async ({
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
      expect(html, 'canonical <link> must point at the slug URL').toMatch(
        new RegExp(`rel="canonical"[^>]+href="https://aecintegrations\\.com/${segment}/[^"]+"`),
      );
      expect(html, 'breadcrumb must mention Home').toMatch(/Home/);
      expect(html, 'products table must render').toMatch(/<table[^>]+aria-label[^>]*>/);
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

      await page.goto(`/${segment}/${term!.slug}`);
      await expect(page.locator('app-root')).toBeAttached();

      const firstProduct = page.locator('tr[aec-product-card] a[href^="/products/"]').first();
      test.skip((await firstProduct.count()) === 0, 'no product rows rendered');

      const href = await firstProduct.getAttribute('href');
      expect(href).toMatch(/^\/products\/[^/]+$/);
      await firstProduct.click();
      await expect(page).toHaveURL(/\/products\/[^/]+$/);
    });

    test('has zero axe AA violations', async ({ page, request }) => {
      const term = await firstTerm(request, listKey);
      test.skip(term === null, `no ${kind} terms seeded in this environment`);

      await page.goto(`/${segment}/${term!.slug}`);
      await expect(page.locator('app-root')).toBeAttached();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      expect(results.violations, formatViolations(results.violations)).toEqual([]);
    });

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
