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
      /<link[^>]+rel="canonical"[^>]+href="https:\/\/aecintegrations\.com\/preview\/vendor-detail"/,
    );

    // OG/Twitter tags are present.
    expect(html, 'og:title must be set').toMatch(
      /<meta[^>]+property="og:title"[^>]+content="[^"]*Procore[^"]*"/,
    );
    expect(html, 'og:url must be set').toMatch(
      /<meta[^>]+property="og:url"[^>]+content="https:\/\/aecintegrations\.com\/preview\/vendor-detail"/,
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
