/**
 * `PATCH /api/vendor/connector-stub-mappings/:id` — the connector seat's mapping edit
 * (AECI-724, `STAGE_2_SPEC.md` §8.9(1)–(2)), against the REAL `requireVendor()` guard
 * and the in-memory D1 harness, with genuinely signed JWTs.
 *
 * What is pinned:
 *
 *   - **A seat is the whole gate.** The seat under test has NO `vendor_entitlements` row
 *     (the AECI-740 provisioned shape) and still writes. There is no capability to hold.
 *   - **Ownership is a 404, and it comes first.** Another vendor's catalogue, a vendor
 *     that owns the connector product only as a non-connector role, and an unknown id
 *     all answer the same 404 — before the managed-by 409, so a non-owner cannot learn
 *     whether a catalogue has been handed over.
 *   - **The owner's review-managed catalogue is a 409**, not a write.
 *   - **The echo is vendor-shaped (AECI-1127).** No curation `notes` key, and
 *     `decided_by` is the kind (`vendor`), not the stored `vendor:{slug}`.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorCatalogs,
  connectorStubMappings,
  connectorStubs,
  productVendors,
  products,
  profiles,
  vendorEntitlements,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import { requireVendor, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { createVendorUpdateConnectorStubMappingHandler } from './vendor-connector-stub-mappings';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SUPABASE_URL = 'https://test-project.supabase.co';
const CONNECTOR_ID = u(1);
const PROCORE_ID = u(2);
const AUTODESK_ID = u(3);
const AGAVE_VENDOR = u(10);
const OTHER_VENDOR = u(11);
const AGAVE_SEAT = u(500);
const OTHER_SEAT = u(501);
const CATALOG_ID = 'fx-cat-agave';
const STUB_ID = 'fx-stub-ag-procore';
const MAPPING_ID = 'fx-map-ag-1';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const CURATION_NOTE = 'reviewer: confirm against the vendor listing';

let t: TestDb;
let jwks: TestJwks;
beforeAll(async () => {
  jwks = await makeTestJwks();
});
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

async function seed(opts: { managedBy?: 'review' | 'vendor'; connectorRole?: string } = {}) {
  await t.db.insert(products).values([
    {
      id: CONNECTOR_ID,
      slug: 'agave',
      name: 'Agave',
      productRole: opts.connectorRole ?? 'connector',
      promotionStatus: 'promoted',
    },
    { id: PROCORE_ID, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    {
      id: AUTODESK_ID,
      slug: 'autodesk-build',
      name: 'Autodesk Build',
      promotionStatus: 'promoted',
    },
  ]);
  await t.db.insert(vendors).values([
    { id: AGAVE_VENDOR, slug: 'agave-inc', companyName: 'Agave Inc' },
    { id: OTHER_VENDOR, slug: 'other-ipaas', companyName: 'Other iPaaS' },
  ]);
  await t.db.insert(productVendors).values({ productId: CONNECTOR_ID, vendorId: AGAVE_VENDOR });
  // Two seats, neither with an entitlement row: the §8.9(2) shape.
  await t.db.insert(profiles).values([
    { id: AGAVE_SEAT, role: 'vendor_admin', vendorId: AGAVE_VENDOR },
    { id: OTHER_SEAT, role: 'vendor_admin', vendorId: OTHER_VENDOR },
  ]);
  await t.db.insert(connectorCatalogs).values({
    id: CATALOG_ID,
    connectorProductId: CONNECTOR_ID,
    managedBy: opts.managedBy ?? 'vendor',
  });
  await t.db.insert(connectorStubs).values({
    id: STUB_ID,
    catalogId: CATALOG_ID,
    slug: 'procore',
    firstSeenAt: OLD_TS,
    lastSeenAt: OLD_TS,
  });
  await t.db.insert(connectorStubMappings).values({
    id: MAPPING_ID,
    stubId: STUB_ID,
    catalogId: CATALOG_ID,
    productId: PROCORE_ID,
    status: 'mapped',
    confidence: 'high',
    decidedBy: 'auto-name-match',
    notes: CURATION_NOTE,
  });
}

function guardedApp() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.patch(
    '/api/vendor/connector-stub-mappings/:id',
    requireVendor({ getKey: jwks.getKey, dbFor: t.factory }),
    createVendorUpdateConnectorStubMappingHandler(t.factory),
  );
  return a;
}

async function call(opts: { as?: string; id?: string; body?: unknown } = {}) {
  const token = opts.as ? await jwks.mintToken({ sub: opts.as, supabaseUrl: SUPABASE_URL }) : null;
  return guardedApp().request(
    `/api/vendor/connector-stub-mappings/${opts.id ?? MAPPING_ID}`,
    {
      method: 'PATCH',
      body: JSON.stringify(opts.body ?? { productId: AUTODESK_ID }),
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    },
    { ENV: 'preview', SUPABASE_URL } as Env,
    fakeExecutionContext(),
  );
}

const readMapping = async () =>
  (
    await t.db.select().from(connectorStubMappings).where(eq(connectorStubMappings.id, MAPPING_ID))
  )[0];

const errorCode = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe('PATCH /api/vendor/connector-stub-mappings/:id — the owner seat', () => {
  it('writes with NO entitlement row: a seat is the whole gate', async () => {
    await seed();
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);

    const res = await call({ as: AGAVE_SEAT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mapping: { decided_by: string; publishable: boolean } };
    expect(body.mapping.decided_by).toBe('vendor');
    expect(body.mapping.publishable).toBe(true);

    expect((await readMapping())?.productId).toBe(AUTODESK_ID);
    expect((await readMapping())?.decidedBy).toBe('vendor:agave-inc');
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'connector_mapping.updated',
      actorId: AGAVE_SEAT,
      actorType: 'user',
      entityType: 'connector_catalog',
      entityId: CATALOG_ID,
    });
    // `vendor_id` is what lets the admin vendor audit tab reach a row filed under a
    // catalogue.
    expect(audits[0]?.metadata).toMatchObject({
      source: 'vendor-portal',
      vendor_id: AGAVE_VENDOR,
      mapping_id: MAPPING_ID,
    });
    // Still no entitlement: nothing here opens one.
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
  });

  it('echoes the vendor mapping shape: no notes key, decided_by as a kind (AECI-1127)', async () => {
    await seed();
    const res = await call({ as: AGAVE_SEAT });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      catalog_id: string;
      stub_id: string;
      changed: boolean;
      mapping: Record<string, unknown>;
    };
    expect(body).toMatchObject({ catalog_id: CATALOG_ID, stub_id: STUB_ID, changed: true });
    expect(body.mapping).not.toHaveProperty('notes');
    expect(body.mapping).not.toHaveProperty('checked_at');
    expect(JSON.stringify(body)).not.toContain(CURATION_NOTE);
    // The kind, not the raw column value the row now stores.
    expect(body.mapping.decided_by).toBe('vendor');
    expect(JSON.stringify(body)).not.toContain('vendor:agave-inc');
    // The note is untouched in the row; it is only kept off the wire.
    expect((await readMapping())?.notes).toBe(CURATION_NOTE);
  });

  it('keeps the vendor shape on the unchanged 200 no-op', async () => {
    await seed();
    const res = await call({ as: AGAVE_SEAT, body: { productId: PROCORE_ID } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; mapping: Record<string, unknown> };
    expect(body.changed).toBe(false);
    expect(body.mapping).not.toHaveProperty('notes');
    // The untouched row is still the name-match pass's proposal.
    expect(body.mapping.decided_by).toBe('automatic');
  });

  it("409s CATALOG_REVIEW_MANAGED on the owner's own review-managed catalogue", async () => {
    await seed({ managedBy: 'review' });
    const res = await call({ as: AGAVE_SEAT });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('CATALOG_REVIEW_MANAGED');
    expect((await readMapping())?.productId).toBe(PROCORE_ID);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('PATCH /api/vendor/connector-stub-mappings/:id — ownership is a 404, first', () => {
  it('404s another vendor seat, even on a vendor-managed catalogue', async () => {
    await seed();
    const res = await call({ as: OTHER_SEAT });
    expect(res.status).toBe(404);
    expect((await readMapping())?.productId).toBe(PROCORE_ID);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('404s another vendor seat on a REVIEW-managed catalogue — never the 409', async () => {
    // The ordering cell: a 409 here would tell a non-owner the catalogue exists and has
    // not been handed over.
    await seed({ managedBy: 'review' });
    expect((await call({ as: OTHER_SEAT })).status).toBe(404);
  });

  it('404s when the owned product is not connector-role', async () => {
    await seed({ connectorRole: 'application' });
    expect((await call({ as: AGAVE_SEAT })).status).toBe(404);
  });

  it('404s an unknown mapping id', async () => {
    await seed();
    expect((await call({ as: AGAVE_SEAT, id: 'recNope' })).status).toBe(404);
  });

  it('404s before parsing the body, so a bad body cannot probe ownership', async () => {
    await seed();
    expect((await call({ as: OTHER_SEAT, body: { notes: 'x' } })).status).toBe(404);
  });
});

describe('PATCH /api/vendor/connector-stub-mappings/:id — guard cells', () => {
  it('401s with no token', async () => {
    await seed();
    expect((await call()).status).toBe(401);
  });

  it('403s a site admin — admins use the /api/admin/* twin', async () => {
    await seed();
    await t.db.insert(profiles).values({ id: u(900), role: 'admin' });
    expect((await call({ as: u(900) })).status).toBe(403);
  });

  it('403s a banned seat', async () => {
    await seed();
    await t.db.update(profiles).set({ bannedAt: OLD_TS }).where(eq(profiles.id, AGAVE_SEAT));
    expect((await call({ as: AGAVE_SEAT })).status).toBe(403);
  });
});

describe('route registration', () => {
  it('is mounted on the vendor sub-router and guarded — 401, not 404', async () => {
    const res = await worker.fetch(
      new Request(`https://api/api/vendor/connector-stub-mappings/${MAPPING_ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ confidence: 'low' }),
        headers: { 'content-type': 'application/json' },
      }),
      { ENV: 'preview', SUPABASE_URL } as Env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});
