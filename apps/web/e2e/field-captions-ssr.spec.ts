/**
 * AECI-1614, AECI-1666: the provenance lines are in the SSR HTML, inside the one
 * "About this listing" panel, and carry no visitor state.
 *
 * Product and pair pages are edge-cached by URL, so the panel has to reach a crawler with
 * no JavaScript and has to be the same bytes for everyone. This reads raw HTML with
 * `request.get`, the same way as `detail-deferred-hydration.spec.ts`: no browser, no
 * hydration. The repo has no in-process SSR harness.
 *
 * The page renders two copies of the panel, a sidebar card and a closed native
 * `<details>`, and CSS hides one per width. Both are plain HTML, so both are checked.
 *
 * Self-activating, like that spec: it reads the API first and asserts against what the
 * database under test holds, then skips loudly on a database with no caption. The local
 * seed (`apps/api/seed/catalog.sql`) gives `revit` the `updated` form and `bluebeam-revu`
 * the `until` form and a removal (AECI-1628).
 */
import { expect, test, type APIRequestContext, type APIResponse } from './fixtures';

const SESSION_COOKIE =
  'sb-local-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJmYWtlIn0; aeci_pair_view=basic';

const PANEL = /<aec-listing-provenance\b[\s\S]*?<\/aec-listing-provenance>/g;

/** Every panel copy, in document order, exactly as serialized. */
function panelMarkup(html: string): string[] {
  return html.match(PANEL) ?? [];
}

/** Text of the markup, with tags and comments gone and whitespace collapsed. */
function panelText(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** AECI-1666: no caption, correction or header chip outside the panel. */
function expectNothingInline(html: string): void {
  const outside = html.replace(PANEL, '');
  expect(outside).not.toContain('<aec-field-caption');
  expect(outside).not.toContain('<aec-maintenance-marker');
}

async function productCaptions(request: APIRequestContext, slug: string) {
  const res: APIResponse = await request.get(`/api/products/${slug}`);
  if (!res.ok()) return null;
  const body = await res.json();
  return body.captions ?? null;
}

test.describe('the provenance panel in the raw SSR HTML (AECI-1666)', () => {
  test('the updated form is in the panel, and the panel ignores a session cookie', async ({
    request,
  }) => {
    const captions = await productCaptions(request, 'revit');
    test.skip(!captions?.description, 'no captioned product in this database');

    const anon = await request.get('/products/revit');
    expect(anon.status()).toBe(200);
    const anonHtml = await anon.text();
    const anonMarkup = panelMarkup(anonHtml);
    expect(anonMarkup).toHaveLength(2);
    expect(anonMarkup.filter((m) => m.includes('data-testid="listing-provenance"'))).toHaveLength(
      1,
    );
    expect(anonMarkup[0]).toContain('About this listing');
    expect(anonMarkup.map(panelText).join(' | ')).toMatch(
      /About: Maintained by Autodesk · updated [A-Z][a-z]+ \d{1,2}, \d{4}/,
    );
    expectNothingInline(anonHtml);

    const signedIn = await request.get('/products/revit', {
      headers: { cookie: SESSION_COOKIE },
    });
    expect(signedIn.status()).toBe(200);
    expect(panelMarkup(await signedIn.text())).toEqual(anonMarkup);
  });

  test('the until form and a sourced correction are in the panel', async ({ request }) => {
    const captions = await productCaptions(request, 'bluebeam-revu');
    test.skip(captions?.managed?.form !== 'until', 'no ended plan in this database');

    const html = await (await request.get('/products/bluebeam-revu')).text();
    const text = panelMarkup(html).map(panelText).join(' | ');
    expect(text).toMatch(/Maintained by Bluebeam until [A-Z][a-z]+ \d{1,2}, \d{4}/);
    // A description stays editable on Free, so it never takes `until`.
    expect(text).toMatch(/About: Maintained by Bluebeam · updated/);
    expect(text).toMatch(/Website: Corrected by AEC Integrations on [A-Z][a-z]+ \d{1,2}, \d{4}/);
    expect(panelMarkup(html).join('')).toContain('href="https://www.bluebeam.com/company/"');
    expectNothingInline(html);
  });

  // AECI-1628, AECI-1666 ruling 1: a removal is listed in the panel only. The seed records
  // one on Bluebeam Revu's API docs link.
  test('a removal is in the panel, and the panel ignores a session cookie', async ({ request }) => {
    const captions = await productCaptions(request, 'bluebeam-revu');
    test.skip(
      !captions?.corrections?.some((c: { cleared?: boolean }) => c.cleared),
      'no removal in this database',
    );

    const anon = await request.get('/products/bluebeam-revu');
    expect(anon.status()).toBe(200);
    const anonMarkup = panelMarkup(await anon.text());
    expect(anonMarkup.map(panelText).join(' | ')).toMatch(
      /API documentation: Removed by AEC Integrations on [A-Z][a-z]+ \d{1,2}, \d{4}/,
    );
    const signedIn = await request.get('/products/bluebeam-revu', {
      headers: { cookie: SESSION_COOKIE },
    });
    expect(panelMarkup(await signedIn.text())).toEqual(anonMarkup);
  });

  test('a pair page carries the mechanism caption in its panel, cookie or not', async ({
    request,
  }) => {
    const path = '/products/revit/integrations/navisworks';
    const pair = await request.get(`/api${path}`);
    test.skip(!pair.ok(), 'no such pair in this database');
    const body = await pair.json();
    test.skip(!body.mechanisms?.some((m: { caption?: unknown }) => m.caption), 'no captioned row');

    const html = await (await request.get(path)).text();
    const anonMarkup = panelMarkup(html);
    expect(anonMarkup.map(panelText).join(' | ')).toMatch(/Maintained by Autodesk · updated/);
    expectNothingInline(html);
    const signedIn = await request.get(path, { headers: { cookie: SESSION_COOKIE } });
    expect(panelMarkup(await signedIn.text())).toEqual(anonMarkup);
  });

  // Ruling 2026-11-17: every listing shows the panel, including one AECi maintains alone.
  test('an AECi-only product still carries the panel and its record line', async ({ request }) => {
    const res = await request.get('/api/products/autocad');
    test.skip(!res.ok(), 'no such product in this database');
    const body = await res.json();
    const captions = body.captions ?? {};
    test.skip(
      body.maintenance?.maintained_by !== 'aeci' ||
        Object.values(captions).some((v) => (Array.isArray(v) ? v.length > 0 : Boolean(v))),
      'autocad is not AECi-only in this database',
    );

    const html = await (await request.get('/products/autocad')).text();
    const markup = panelMarkup(html);
    expect(markup).toHaveLength(2);
    for (const copy of markup) {
      expect(copy.split('>')[0]).not.toMatch(/\shidden(=|\s|$)/);
      expect(panelText(copy)).toMatch(/^About this listing AEC Integrations maintained/);
    }
  });
});
