/**
 * AECI-1614: the field captions are in the SSR HTML and carry no visitor state.
 *
 * Product and pair pages are edge-cached by URL, so a caption has to reach a crawler with
 * no JavaScript and has to be the same bytes for everyone. This reads raw HTML with
 * `request.get`, the same way as `detail-deferred-hydration.spec.ts`: no browser, no
 * hydration. The repo has no in-process SSR harness.
 *
 * Self-activating, like that spec: it reads the API first and asserts against what the
 * database under test holds, then skips loudly on a database with no caption. The local
 * seed (`apps/api/seed/catalog.sql`) gives `revit` the `updated` form and `bluebeam-revu`
 * the `until` form.
 */
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';

const SESSION_COOKIE =
  'sb-local-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJmYWtlIn0; aeci_pair_view=basic';

/** Every rendered caption element, in document order, exactly as serialized. */
function captionMarkup(html: string): string[] {
  return html.match(/<aec-field-caption\b[\s\S]*?<\/aec-field-caption>/g) ?? [];
}

/** Text of the markup, with tags and comments gone and whitespace collapsed. */
function captionText(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function productCaptions(request: APIRequestContext, slug: string) {
  const res: APIResponse = await request.get(`/api/products/${slug}`);
  if (!res.ok()) return null;
  const body = await res.json();
  return body.captions ?? null;
}

test.describe('field captions in the raw SSR HTML (AECI-1614)', () => {
  test('the updated form is in the HTML, and the markup ignores a session cookie', async ({
    request,
  }) => {
    const captions = await productCaptions(request, 'revit');
    test.skip(!captions?.description, 'no captioned product in this database');

    const anon = await request.get('/products/revit');
    expect(anon.status()).toBe(200);
    const anonMarkup = captionMarkup(await anon.text());
    const anonText = anonMarkup.map(captionText);
    expect(anonText.join(' | ')).toMatch(
      /Maintained by Autodesk · updated [A-Z][a-z]+ \d{1,2}, \d{4}/,
    );

    const signedIn = await request.get('/products/revit', {
      headers: { cookie: SESSION_COOKIE },
    });
    expect(signedIn.status()).toBe(200);
    expect(captionMarkup(await signedIn.text())).toEqual(anonMarkup);
  });

  test('the until form and a sourced correction are in the HTML', async ({ request }) => {
    const captions = await productCaptions(request, 'bluebeam-revu');
    test.skip(captions?.managed?.form !== 'until', 'no ended plan in this database');

    const html = await (await request.get('/products/bluebeam-revu')).text();
    const text = captionMarkup(html).map(captionText).join(' | ');
    expect(text).toMatch(/Maintained by Bluebeam until [A-Z][a-z]+ \d{1,2}, \d{4}/);
    // A description stays editable on Free, so it never takes `until`.
    expect(text).toMatch(/Maintained by Bluebeam · updated/);
    expect(text).toMatch(/Website: Corrected by AEC Integrations on [A-Z][a-z]+ \d{1,2}, \d{4}/);
    expect(html).toContain('href="https://www.bluebeam.com/company/"');
  });

  test('a pair page carries the mechanism caption, cookie or not', async ({ request }) => {
    const path = '/products/revit/integrations/navisworks';
    const pair = await request.get(`/api${path}`);
    test.skip(!pair.ok(), 'no such pair in this database');
    const body = await pair.json();
    test.skip(!body.mechanisms?.some((m: { caption?: unknown }) => m.caption), 'no captioned row');

    const anonMarkup = captionMarkup(await (await request.get(path)).text());
    expect(anonMarkup.map(captionText).join(' | ')).toMatch(/Maintained by Autodesk · updated/);
    const signedIn = await request.get(path, { headers: { cookie: SESSION_COOKIE } });
    expect(captionMarkup(await signedIn.text())).toEqual(anonMarkup);
  });
});
