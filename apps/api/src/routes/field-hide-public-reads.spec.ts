/**
 * A hidden value renders on no public read (AECI-1238 section B, §11d.7). The write is
 * `admin-field-hides.spec.ts`; this file is every read that could publish the value:
 * the vendor detail and list, the product detail with its vendor facts, captions and
 * endpoint rows, the pair page, the integrations list and legacy detail, and every
 * Algolia record type. The mask is `lib/field-hide-mask.ts`.
 *
 * The seed puts the same value on a sibling record with no hide, so a mask that blanks
 * a whole read instead of one field fails too. The hide rows carry a private reason,
 * note and source, and the last case proves none of them reaches any payload.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectorEvidencedPairs,
  fieldHides,
  fieldOverrides,
  integrations,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import { indexEntity } from '../lib/algolia-sync';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createIntegrationDetailHandler,
  createIntegrationsListHandler,
  createProductPairHandler,
} from './integrations';
import { createProductDetailHandler } from './products';
import { createVendorDetailHandler, createVendorsListHandler } from './vendors';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const V_HELD = u(1); // owned, carries the hides
const V_OTHER = u(2); // same values, no hide
const P_HELD = u(10); // V_HELD's product, carries the hides
const P_PARTNER = u(11); // V_OTHER's product, same description, no hide
const P_CONNECTOR = u(12);
const I_HELD = u(20); // P_HELD -> P_PARTNER, hidden docs_url and mechanism_name
const PAIR = u(21); // evidenced pair P_HELD / P_PARTNER via P_CONNECTOR, hidden description
const OWNED_AT = '2026-10-01T00:00:00.000Z';
const EDITED_AT = '2026-10-20T00:00:00.000Z';

const PRIVATE = {
  reason: 'A reader sent a source saying this is wrong.',
  internalNote: 'PRIVATE-NOTE-do-not-publish',
  sourceUrl: 'https://private-source.example/complaint',
};

function hide(n: number, entityType: string, entityId: string, field: string) {
  return {
    id: u(n),
    entityType,
    entityId,
    field,
    ...PRIVATE,
    receivedAt: '2026-11-02',
    vendorId: V_HELD,
    setBy: u(99),
    setAt: '2026-11-03T00:00:00.000Z',
  };
}

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  const company = {
    description: 'We make construction software.',
    website: 'https://example.com',
    headquarters: 'Austin, TX',
    foundedYear: 2001,
    companySize: '51-200',
    ownershipType: 'private',
    promotionStatus: 'promoted',
    ownedAt: OWNED_AT,
  } as const;
  await t.db.insert(vendors).values([
    { id: V_HELD, slug: 'held-co', companyName: 'Held Co', ...company },
    { id: V_OTHER, slug: 'other-co', companyName: 'Other Co', ...company },
  ]);
  await t.db.insert(products).values([
    {
      id: P_HELD,
      slug: 'held-tool',
      name: 'Held Tool',
      description: 'A tool for site teams.',
      website: 'https://held.example',
      descriptionEditedAt: EDITED_AT,
      promotionStatus: 'promoted',
    },
    {
      id: P_PARTNER,
      slug: 'partner-tool',
      name: 'Partner Tool',
      description: 'A tool for site teams.',
      website: 'https://partner.example',
      promotionStatus: 'promoted',
    },
    {
      id: P_CONNECTOR,
      slug: 'bridge',
      name: 'Bridge',
      productRole: 'connector',
      promotionStatus: 'promoted',
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_HELD, vendorId: V_HELD, isPrimary: true },
    { productId: P_PARTNER, vendorId: V_OTHER, isPrimary: true },
  ]);
  await t.db.insert(integrations).values({
    id: I_HELD,
    name: 'Held link',
    sourceProductId: P_HELD,
    targetProductId: P_PARTNER,
    mechanismKind: 'api',
    mechanismName: 'Held REST API',
    description: 'Syncs RFIs.',
    docsUrl: 'https://held.example/docs',
    listingUrl: 'https://held.example/listing',
  });
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    connectorProductId: P_CONNECTOR,
    productAId: P_HELD,
    productBId: P_PARTNER,
    direction: 'a_to_b',
    mechanismName: 'Bridge recipe',
    description: 'Moves submittals.',
  });
  // A standing AECi correction (older than the hide) on the company website: its
  // "Corrected by" entry must go while the field is hidden.
  await t.db.insert(fieldOverrides).values({
    id: u(30),
    entityType: 'vendor',
    entityId: V_HELD,
    field: 'website',
    value: 'https://example.com',
    sourceUrl: 'https://public.example/correction',
    reason: 'Fixed a typo.',
    setAt: '2026-10-25T00:00:00.000Z',
    liftedAt: '2026-10-26T00:00:00.000Z',
  });
  await t.db
    .insert(fieldHides)
    .values([
      hide(40, 'vendor', V_HELD, 'description'),
      hide(41, 'vendor', V_HELD, 'headquarters'),
      hide(42, 'vendor', V_HELD, 'founded_year'),
      hide(43, 'vendor', V_HELD, 'company_size'),
      hide(44, 'vendor', V_HELD, 'website'),
      hide(45, 'product', P_HELD, 'description'),
      hide(46, 'integration', I_HELD, 'docs_url'),
      hide(47, 'integration', I_HELD, 'mechanism_name'),
      hide(48, 'connector_evidenced_pair', PAIR, 'description'),
    ]);
});
afterEach(() => t.dispose());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;

async function get(
  path: string,
  url: string,
  handler: Parameters<typeof buildAppWithHandler>[0]['handler'],
): Promise<{ status: number; body: JsonBody; text: string }> {
  const res = await buildAppWithHandler({ method: 'get', path, handler }).request(
    url,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const vendorDetail = (slug: string) =>
  get('/api/vendors/:slug', `/api/vendors/${slug}`, createVendorDetailHandler(t.factory));
const productDetail = (slug: string) =>
  get('/api/products/:slug', `/api/products/${slug}`, createProductDetailHandler(t.factory));
const pairPage = () =>
  get(
    '/api/products/:slug/integrations/:otherSlug',
    '/api/products/held-tool/integrations/partner-tool',
    createProductPairHandler(t.factory),
  );

describe('a hidden value renders on no public read (AECI-1238 §11d.7)', () => {
  it('the vendor page nulls each hidden value and its fact, and names it under review', async () => {
    const { status, body } = await vendorDetail('held-co');
    expect(status).toBe(200);
    expect(body.description).toBeNull();
    expect(body.website).toBeNull();
    expect(body.headquarters).toBeNull();
    expect(body.founded_year).toBeNull();
    expect(body.company_facts.headquarters).toBeNull();
    expect(body.company_facts.founded_year).toBeNull();
    expect(body.company_facts.company_size).toBeNull();
    // An unhidden fact still shows.
    expect(body.company_facts.ownership_type).toMatchObject({ value: 'private' });
    expect(body.corrections.map((c: JsonBody) => c.field)).not.toContain('website');
    expect(body.under_review).toEqual([
      'company_size',
      'description',
      'founded_year',
      'headquarters',
      'website',
    ]);

    const other = await vendorDetail('other-co');
    expect(other.body.description).toBe('We make construction software.');
    expect(other.body.company_facts.headquarters).toMatchObject({ value: 'Austin, TX' });
    expect(other.body.under_review).toBeUndefined();
  });

  it('the vendor list nulls the two facts a card shows, silently', async () => {
    const { body } = await get('/api/vendors', '/api/vendors', createVendorsListHandler(t.factory));
    const bySlug = new Map(body.data.map((v: JsonBody) => [v.slug, v]));
    expect(bySlug.get('held-co')).toMatchObject({ headquarters: null, founded_year: null });
    expect(bySlug.get('other-co')).toMatchObject({
      headquarters: 'Austin, TX',
      founded_year: 2001,
    });
    expect(body.data[0]).not.toHaveProperty('under_review');
  });

  it('the product page nulls the description, drops its captions and masks vendor_facts', async () => {
    const { status, body } = await productDetail('held-tool');
    expect(status).toBe(200);
    expect(body.description).toBeNull();
    expect(body.website).toBe('https://held.example');
    expect(body.under_review).toEqual(['description']);
    // No "Corrected by" and no "Maintained by" speaks for the hidden description.
    expect(body.captions.description).toBeNull();
    // The company's hidden size is gone from the vendor card; ownership stays.
    expect(body.vendor_facts).toEqual({ company_size: null, ownership_type: 'private' });

    const partner = await productDetail('partner-tool');
    expect(partner.body.description).toBe('A tool for site teams.');
    expect(partner.body.vendor_facts.company_size).toBe('51-200');
  });

  it('the product page masks its endpoint rows by row id', async () => {
    const { body } = await productDetail('partner-tool');
    const rows = [...body.integrations_as_source, ...body.integrations_as_target];
    const held = rows.find((r: JsonBody) => r.id === I_HELD);
    expect(held.mechanism_name).toBeNull();
    expect(held.under_review).toEqual(['docs_url', 'mechanism_name']);
    const pair = rows.find((r: JsonBody) => r.id === PAIR);
    expect(pair.mechanism_name).toBe('Bridge recipe');
    expect(pair.under_review).toEqual(['description']);
  });

  it('the pair page masks each mechanism by id', async () => {
    const { status, body } = await pairPage();
    expect(status).toBe(200);
    const byId = new Map(body.mechanisms.map((m: JsonBody) => [m.id, m]));
    const held = byId.get(I_HELD) as JsonBody;
    expect(held.docs_url).toBeNull();
    expect(held.mechanism_name).toBeNull();
    expect(held.listing_url).toBe('https://held.example/listing');
    expect(held.description).toBe('Syncs RFIs.');
    expect(held.under_review).toEqual(['docs_url', 'mechanism_name']);
    const pair = byId.get(PAIR) as JsonBody;
    expect(pair.description).toBeNull();
    expect(pair.under_review).toEqual(['description']);
  });

  it('the integrations list and the legacy detail mask the row', async () => {
    const list = await get(
      '/api/integrations',
      '/api/integrations',
      createIntegrationsListHandler(t.factory),
    );
    const row = list.body.data.find((r: JsonBody) => r.id === I_HELD);
    expect(row.mechanism_name).toBeNull();
    expect(list.body.data.find((r: JsonBody) => r.id === PAIR).mechanism_name).toBe(
      'Bridge recipe',
    );
    const detail = await get(
      '/api/integrations/:id',
      `/api/integrations/${I_HELD}`,
      createIntegrationDetailHandler(t.factory),
    );
    expect(detail.body).toMatchObject({
      docs_url: null,
      mechanism_name: null,
      description: 'Syncs RFIs.',
    });
  });

  it('a cleared hide masks nothing', async () => {
    await t.db
      .update(fieldHides)
      .set({ clearedAt: '2026-11-04T00:00:00.000Z', clearKind: 'restored' })
      .where(eq(fieldHides.entityId, P_HELD));
    const { body } = await productDetail('held-tool');
    expect(body.description).toBe('A tool for site teams.');
    expect(body.captions.description).toMatchObject({ form: 'updated', date: EDITED_AT });
    expect(body.under_review).toBeUndefined();

    await t.db
      .update(fieldHides)
      .set({ clearedAt: '2026-11-04T00:00:00.000Z', clearKind: 'restored' })
      .where(eq(fieldHides.entityId, V_HELD));
    const vendor = await vendorDetail('held-co');
    expect(vendor.body.website).toBe('https://example.com');
    expect(vendor.body.corrections.map((c: JsonBody) => c.field)).toContain('website');
    expect(vendor.body.company_facts.headquarters).toMatchObject({ value: 'Austin, TX' });
  });

  it('no public payload carries the hide reason, internal note or source', async () => {
    const texts = [
      (await vendorDetail('held-co')).text,
      (await get('/api/vendors', '/api/vendors', createVendorsListHandler(t.factory))).text,
      (await productDetail('held-tool')).text,
      (await productDetail('partner-tool')).text,
      (await pairPage()).text,
      (
        await get(
          '/api/integrations',
          '/api/integrations',
          createIntegrationsListHandler(t.factory),
        )
      ).text,
    ];
    for (const text of texts) {
      expect(text).not.toContain(PRIVATE.reason);
      expect(text).not.toContain(PRIVATE.internalNote);
      expect(text).not.toContain(PRIVATE.sourceUrl);
      expect(text).not.toContain('received_at');
    }
  });
});

describe('a hidden value never reaches Algolia (AECI-1238 §11d.7)', () => {
  async function pushed(entity: 'products' | 'vendors' | 'integrations', ids: string[]) {
    const bodies: JsonBody[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ taskID: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await indexEntity(
      t.db,
      fetchImpl,
      { appId: 'APP', apiKey: 'write-key' },
      'staging',
      entity,
      { type: 'ids', ids },
    );
    expect(result.ok).toBe(true);
    const records = new Map<string, JsonBody>();
    for (const body of bodies) {
      for (const request of body.requests) records.set(request.body.objectID, request.body);
    }
    return records;
  }

  it('the vendor record nulls the hidden description, headquarters and year', async () => {
    const records = await pushed('vendors', [V_HELD, V_OTHER]);
    expect(records.get(V_HELD)).toMatchObject({
      description: null,
      headquarters: null,
      founded_year: null,
    });
    expect(records.get(V_OTHER)).toMatchObject({
      description: 'We make construction software.',
      headquarters: 'Austin, TX',
    });
    // The tier reads the stored values, so a hide does not move a rank.
    expect(records.get(V_HELD).listing_tier).toBe(records.get(V_OTHER).listing_tier);
  });

  it('the product record nulls the hidden description', async () => {
    const records = await pushed('products', [P_HELD, P_PARTNER]);
    expect(records.get(P_HELD).description).toBeNull();
    expect(records.get(P_PARTNER).description).toBe('A tool for site teams.');
  });

  it('both integration arms null their hidden fields', async () => {
    const records = await pushed('integrations', [I_HELD, PAIR]);
    expect(records.get(I_HELD)).toMatchObject({ mechanism_name: null, description: 'Syncs RFIs.' });
    expect(records.get(PAIR)).toMatchObject({ mechanism_name: 'Bridge recipe', description: null });
  });

  it('a cleared hide indexes the value again', async () => {
    await t.db
      .update(fieldHides)
      .set({ clearedAt: '2026-11-04T00:00:00.000Z', clearKind: 'vendor_edit' })
      .where(eq(fieldHides.entityId, P_HELD));
    const records = await pushed('products', [P_HELD]);
    expect(records.get(P_HELD).description).toBe('A tool for site teams.');
  });
});
