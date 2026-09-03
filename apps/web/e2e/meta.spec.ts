import { TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';
import { expect, test } from '@playwright/test';

// AECI-51 / Phase 2.5 — verifies MetaService writes title, canonical, OG, and
// JSON-LD into the initial SSR HTML (before hydration). The preview route
// `/preview/vendor-detail` is wired to call MetaService against a fixture so
// we can exercise the full pipeline end-to-end without a real entity page.
//
// Preview routes are blocked at the SSR Worker for `ENV=production`
// (`isPreviewPath` in `server-runtime.ts`); against a production deployment
// these checks would 404. Local dev (`pnpm dev:bound`) and PR preview Workers
// both run with `ENV=preview`, so this spec runs against both.

test.describe('MetaService SSR output (/preview/vendor-detail)', () => {
  test('SSR HTML contains title, canonical, OG tags, and JSON-LD', async ({ request }) => {
    const res = await request.get('/preview/vendor-detail');
    expect(res.status(), 'preview route should render').toBe(200);
    const html = await res.text();

    // Title carries the entity name + localized suffix.
    expect(html, '<title> must include the fixture company name').toMatch(
      /<title[^>]*>[^<]*Procore[^<]*· AEC Integrations[^<]*<\/title>/i,
    );

    // Canonical link is present and query-stripped.
    expect(html, 'canonical <link> must be in <head>').toMatch(
      /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.aecintegrations\.com\/preview\/vendor-detail"/,
    );

    // OG/Twitter tags are present.
    expect(html, 'og:title must be set').toMatch(
      /<meta[^>]+property="og:title"[^>]+content="[^"]*Procore[^"]*"/,
    );
    expect(html, 'og:url must be set').toMatch(
      /<meta[^>]+property="og:url"[^>]+content="https:\/\/www\.aecintegrations\.com\/preview\/vendor-detail"/,
    );
    expect(html, 'og:image must fall back to the brand monogram').toMatch(
      /<meta[^>]+property="og:image"[^>]+content="\/branding\/monogram-light\.svg"/,
    );
    expect(html, 'twitter:card must be summary_large_image').toMatch(
      /<meta[^>]+name="twitter:card"[^>]+content="summary_large_image"/,
    );

    // JSON-LD script tag for the vendor block.
    const jsonLdMatch = html.match(
      /<script[^>]+type="application\/ld\+json"[^>]+data-aeci-jsonld="vendor"[^>]*>([\s\S]*?)<\/script>/,
    );
    expect(jsonLdMatch, 'vendor JSON-LD <script> must be in SSR HTML').not.toBeNull();
    const ld = JSON.parse(jsonLdMatch![1]);
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@type']).toBe('Organization');
    expect(ld.name).toBe('Procore');
    expect(ld.url).toBe('https://www.procore.com');
    expect(ld.foundingDate).toBe('2002');
    expect(ld.address).toBe('Carpinteria, CA, US');
  });
});

// AECI-546 — the trade publication gate's indexability half. Asserted on the
// `<meta name="robots">` tag in the SSR HTML, NOT on `X-Robots-Tag`: that header
// is the environment-wide pre-launch block (`robots-policy.ts`) and is present on
// every page here regardless, so it can't distinguish a gated term from a
// published one.
test.describe('trade publication gate → robots meta (/trades/:slug)', () => {
  const robotsMeta = (html: string) =>
    html.match(/<meta[^>]+name="robots"[^>]+content="([^"]*)"/)?.[1] ?? null;

  test('a sub-floor trade page renders 200 + noindex; a published one renders no robots tag', async ({
    request,
  }) => {
    const trades = await (await request.get('/api/trades')).json();
    const terms = (trades.data ?? []) as { slug: string; product_count: number }[];
    const published = terms.find((t) => t.product_count >= TRADE_PUBLISH_MIN_PRODUCTS);
    const unpublished = terms.find((t) => t.product_count < TRADE_PUBLISH_MIN_PRODUCTS);
    test.skip(
      !published || !unpublished,
      'needs one trade each side of the floor (the local seed provides both)',
    );

    // Sub-floor: still a real 200 — the URL is permanent across the gate, so
    // crossing the floor needs no redirect — but not indexable.
    const subFloor = await request.get(`/trades/${unpublished!.slug}`);
    expect(subFloor.status(), 'a sub-floor trade page must NOT 404').toBe(200);
    expect(robotsMeta(await subFloor.text())).toContain('noindex');

    // Published: no robots tag at all, i.e. indexable.
    const gated = await request.get(`/trades/${published!.slug}`);
    expect(gated.status()).toBe(200);
    expect(robotsMeta(await gated.text())).toBeNull();
  });

  // The index lists published terms only, but is itself always indexable — it is
  // how a crawler finds a term the moment it crosses the floor.
  test('the /trades index is always indexable', async ({ request }) => {
    const res = await request.get('/trades');
    expect(res.status()).toBe(200);
    expect(robotsMeta(await res.text())).toBeNull();
  });
});

// ── AECI-518 — product-PAIR structured data in the SSR HTML ──────────────────
// The Stage 2 resolution of the §9.2 "no clean schema.org type" deferral
// (decision record: `STAGE_2_SPEC.md` §8.7). SSR is the SEO-relevant path, so it
// is the one asserted here; the emission gate and the builders are covered by
// `products-pair.resolver.component.spec.ts` and `meta.helpers.spec.ts`.
//
// Catalog-dependent, so it resolves a real pair the same way
// `products-pair.spec.ts` does rather than pinning fixture slugs, and skips when
// the local/CI DB has no integration to build one from.

/** Resolve a real pair from the live catalog. Mirrors `products-pair.spec.ts`. */
async function findPair(
  request: import('@playwright/test').APIRequestContext,
): Promise<{ context: string; other: string } | null> {
  const res = await request.get('/api/integrations?perPage=25');
  if (!res.ok()) return null;
  const body = (await res.json()) as {
    data?: { source?: { slug?: string }; target?: { slug?: string } }[];
  };
  for (const row of body.data ?? []) {
    const context = row.source?.slug;
    const other = row.target?.slug;
    if (context && other && context !== other) return { context, other };
  }
  return null;
}

function readJsonLd(html: string, kind: string): Record<string, unknown> | null {
  const match = html.match(
    new RegExp(
      `<script[^>]+type="application/ld\\+json"[^>]+data-aeci-jsonld="${kind}"[^>]*>([\\s\\S]*?)</script>`,
    ),
  );
  return match ? (JSON.parse(match[1]) as Record<string, unknown>) : null;
}

test.describe('product-PAIR JSON-LD (AECI-518)', () => {
  test('SSR HTML carries the WebPage + BreadcrumbList blocks, cross-linked by @id', async ({
    request,
  }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');

    const path = `/products/${pair!.context}/integrations/${pair!.other}`;
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    const html = await res.text();

    const page = readJsonLd(html, 'pair');
    expect(page, 'pair WebPage JSON-LD must be in the SSR HTML').not.toBeNull();
    expect(page!['@context']).toBe('https://schema.org');
    expect(page!['@type']).toBe('WebPage');

    const crumbs = readJsonLd(html, 'breadcrumb');
    expect(crumbs, 'BreadcrumbList JSON-LD must be in the SSR HTML').not.toBeNull();
    expect(crumbs!['@type']).toBe('BreadcrumbList');

    // The cross-reference is what makes the two blocks one graph.
    expect((page!['breadcrumb'] as { '@id': string })['@id']).toBe(crumbs!['@id']);

    // `about` names both endpoint products, and each `@id` is the URI the
    // product's OWN detail page publishes — the graph edge this epic exists for.
    const about = page!['about'] as { '@id': string; url: string; name: string }[];
    expect(about).toHaveLength(2);
    for (const slug of [pair!.context, pair!.other]) {
      expect(about.some((n) => n['@id'].endsWith(`/products/${slug}#product`))).toBe(true);
    }

    // No product/vendor block rides along from any other route (the `clearJsonLd`
    // invariant), and the page's own canonical is what the WebPage reports.
    expect(readJsonLd(html, 'product')).toBeNull();
    expect(readJsonLd(html, 'vendor')).toBeNull();
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/)?.[1];
    expect(page!['url']).toBe(canonical);
  });

  test('a product detail page publishes the @id the pair page references', async ({ request }) => {
    const pair = await findPair(request);
    test.skip(pair === null, 'no integration in the local catalog to build a pair from');

    const res = await request.get(`/products/${pair!.context}`);
    expect(res.status()).toBe(200);
    const ld = readJsonLd(await res.text(), 'product');

    expect(ld, 'product SoftwareApplication JSON-LD must be in the SSR HTML').not.toBeNull();
    expect(ld!['@id']).toMatch(new RegExp(`/products/${pair!.context}#product$`));
  });
});
