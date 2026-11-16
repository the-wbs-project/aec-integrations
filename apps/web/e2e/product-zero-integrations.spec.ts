/**
 * AECI-1786: a product with no integrations on record, in the raw SSR HTML.
 *
 * The page is edge-cached by URL, so the zero state has to reach a crawler with no
 * JavaScript and has to be the same bytes for every visitor. This reads raw HTML with
 * `request.get`, as `field-captions-ssr.spec.ts` does: no browser, no hydration.
 *
 * Self-activating: it reads the API first and skips loudly when the database under test
 * has no such product. The local seed (`apps/api/seed/catalog.sql`) gives `autocad` no
 * integrations, a vendor (Autodesk) and no integrations page link.
 */
import { expect, test } from '@playwright/test';

const SLUG = 'autocad';
const SESSION_COOKIE = 'sb-local-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJmYWtlIn0';

/** The `#integrations` section's markup, exactly as serialized. */
function integrationsSection(html: string): string {
  const match = html.match(/<section\b[^>]*\bid="integrations"[\s\S]*?<\/section>/);
  return match?.[0] ?? '';
}

/** Text of the markup, with tags and comments gone and whitespace collapsed. */
function text(markup: string): string {
  return markup
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

test.describe('zero-integration product in the raw SSR HTML (AECI-1786)', () => {
  test('prints the four legal-reviewed strings and none of the absent controls', async ({
    request,
  }) => {
    const api = await request.get(`/api/products/${SLUG}`);
    test.skip(!api.ok(), `no ${SLUG} product in this database`);
    const product = await api.json();
    test.skip(
      product.integration_count !== 0 ||
        product.integrations_as_source.length > 0 ||
        product.integrations_as_target.length > 0 ||
        product.integrations_as_connector.length > 0 ||
        product.reachable_pair_count > 0 ||
        !product.vendor ||
        !!product.tool_integrations_url,
      `${SLUG} is not a zero-integration product with a vendor and no integrations page here`,
    );

    const res = await request.get(`/products/${SLUG}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    const section = integrationsSection(html);
    const sectionText = text(section);

    expect(sectionText).toContain(`We have no integrations for ${product.name} on record`);
    expect(sectionText).toContain(
      'Not on record means we have not found one. It is not proof that none exists.',
    );
    expect(sectionText).toContain(
      'An API is not an integration. We list an integration only when we can show that one exists.',
    );
    expect(sectionText).toContain(
      `We have not found an integrations page published by ${product.vendor.name}.`,
    );
    expect(sectionText).toContain('It does exist');
    expect(section).toContain(`href="/products/${SLUG}/correction"`);

    // The absent controls: no filter panel, no Cards or Table toggle, no list, no scope note.
    expect(section).not.toContain('integrations-filter-panel');
    expect(section).not.toContain('aec-listing-view-toggle');
    expect(section).not.toContain('integrations-filter');
    expect(section).not.toContain('aec-product-integration-cards');
    expect(sectionText).not.toContain('Only partners listed');
    expect(sectionText).not.toContain('Integrations (0)');
    // No category chart (ruling R3, decision 19), and never "does not integrate".
    expect(html).not.toMatch(/does not integrate/i);
    // The section nav drops the absent Extensions entry.
    expect(html).not.toContain('href="#extensions"');
  });

  test('the zero state is the same bytes with a session cookie', async ({ request }) => {
    const api = await request.get(`/api/products/${SLUG}`);
    test.skip(!api.ok(), `no ${SLUG} product in this database`);

    const anon = integrationsSection(await (await request.get(`/products/${SLUG}`)).text());
    const signedIn = integrationsSection(
      await (
        await request.get(`/products/${SLUG}`, { headers: { cookie: SESSION_COOKIE } })
      ).text(),
    );
    expect(anon).not.toBe('');
    expect(signedIn).toBe(anon);
  });
});
