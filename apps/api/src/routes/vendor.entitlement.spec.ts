/**
 * The entitlement gate on `/api/vendor/*` (AECI-611 —
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §4).
 *
 * Like `vendor.authz-matrix.spec.ts` and unlike `vendor.spec.ts`, this composes
 * the **real** `requireVendor()` guard with the **real** handlers over the
 * in-memory D1 harness, driven by genuinely signed JWTs. That matters here more
 * than anywhere: the tier is produced by the guard's `leftJoin`, so a spec that
 * stubbed `c.set('auth', …)` would be asserting its own fixture rather than the
 * mechanism. Every tier below is the one the middleware actually derived from
 * seeded `licenses` rows (AECI-1355; it was `vendor_entitlements` before).
 *
 * Three personas, one per plan state that behaves differently:
 *
 *   PAID      — a live license on its product (Managed). Every write works.
 *   LAPSED    — its only license ended (`revoked`, or `expired` for a lapse).
 *               Resolves to the Free plan: reads 200, company details and the
 *               four `listing_tier` product fields write, every Managed-only
 *               field 403s (AECI-1214, §13.3).
 *   UNCLAIMED — no license at all. Same as LAPSED, but with a null term readout
 *               rather than a lapsed one. The connector catalogue seat is this
 *               persona.
 *
 * Plus the AECI-1355 acceptance case: one vendor, two products, one license.
 *
 * ── The invariant this file exists for ──────────────────────────────────────
 * **Reads are NEVER gated** (§4.3 / §10 R13). `/vendor` is gated by
 * `vendorMeResolver`, which maps 401/403/404 onto a 404 render. Capability-
 * gating `GET /api/vendor/me` would therefore 404 the ENTIRE dashboard for a
 * vendor whose entitlement lapsed — so the one cohort being asked to renew
 * would be the one cohort that cannot see the renewal notice. It is a one-line
 * mistake with total blast radius, which is why it is an acceptance criterion
 * with its own test rather than a convention. Do not delete these cases without
 * reopening §4.3.
 */

import {
  ApiErrorCode,
  UpdateVendorProductSchema,
  UpdateVendorProfileSchema,
  VendorMeResponseSchema,
} from '@aeci/shared';
import {
  CAPABILITIES,
  PRODUCT_FIELD_CAPABILITIES,
  TIERS,
  VENDOR_FIELD_CAPABILITIES,
  capabilitiesFor,
  hasCapability,
  type Capability,
  type EntitlementTier,
} from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  productCategories,
  productVendors,
  products,
  profiles,
  licenses,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireVendor, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { seedLicense } from '../test/licenses';
import {
  PRODUCT_COLUMN_MAP,
  VENDOR_COLUMN_MAP,
  assertFieldsEntitled,
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
  createVendorSeatsHandler,
  splitPatch,
} from './vendor';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { ENV: 'staging', SUPABASE_URL } as Env;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_PAID = uuid(1);
const VENDOR_LAPSED = uuid(2);
const VENDOR_UNCLAIMED = uuid(3);

const PRODUCT_PAID = uuid(10);
const PRODUCT_LAPSED = uuid(11);
const PRODUCT_UNCLAIMED = uuid(12);
/** A second product of the PAID vendor, with no license of its own (AECI-1355). */
const PRODUCT_PAID_FREE = uuid(13);

const SEAT_PAID = uuid(100);
const SEAT_LAPSED = uuid(101);
const SEAT_UNCLAIMED = uuid(102);

const CAT_BIM = uuid(200);

let t: TestDb;
let jwks: TestJwks;

beforeEach(async () => {
  t = await makeTestDb();
  jwks = await makeTestJwks();

  // `verified` mirrors "any live license" (§2.1, AECI-1352) — seeded together,
  // never one side alone, or the fixture describes a drifted state.
  await t.db.insert(vendors).values([
    {
      id: VENDOR_PAID,
      slug: 'autodesk',
      companyName: 'Autodesk',
      description: 'Paid blurb',
      verified: true,
    },
    {
      id: VENDOR_LAPSED,
      slug: 'bentley',
      companyName: 'Bentley',
      description: 'Lapsed blurb',
      verified: false,
    },
    {
      id: VENDOR_UNCLAIMED,
      slug: 'trimble',
      companyName: 'Trimble',
      description: 'Unclaimed blurb',
      verified: false,
    },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT_PAID, slug: 'revit', name: 'Revit', description: 'Paid product' },
    { id: PRODUCT_LAPSED, slug: 'microstation', name: 'MicroStation', description: 'Lapsed' },
    { id: PRODUCT_UNCLAIMED, slug: 'tekla', name: 'Tekla', description: 'Unclaimed' },
  ]);
  await seedLicense(t.db, VENDOR_PAID, {
    productId: PRODUCT_PAID,
    endsAt: '2027-01-01T00:00:00.000Z',
  });
  // Pulled for cause. The license survives the revocation with its assignment
  // (decision 14) — that is what lets the dashboard say WHY.
  await seedLicense(t.db, VENDOR_LAPSED, {
    productId: PRODUCT_LAPSED,
    endsAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-02T00:00:00.000Z',
    endReason: 'revoked',
  });
  // VENDOR_UNCLAIMED deliberately gets NO license.
  await t.db.insert(productVendors).values([
    { productId: PRODUCT_PAID, vendorId: VENDOR_PAID, isPrimary: true },
    { productId: PRODUCT_LAPSED, vendorId: VENDOR_LAPSED, isPrimary: true },
    { productId: PRODUCT_UNCLAIMED, vendorId: VENDOR_UNCLAIMED, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_PAID, role: 'vendor_admin', vendorId: VENDOR_PAID },
    { id: SEAT_LAPSED, role: 'vendor_admin', vendorId: VENDOR_LAPSED },
    { id: SEAT_UNCLAIMED, role: 'vendor_admin', vendorId: VENDOR_UNCLAIMED },
  ]);
  await t.db.insert(taxonomyCategories).values([{ id: CAT_BIM, slug: 'bim', name: 'BIM' }]);
});
afterEach(() => t.dispose());

function makeApp() {
  const guard = { getKey: jwks.getKey, dbFor: t.factory };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/vendor/me', requireVendor(guard), createVendorMeHandler(t.factory));
  app.get(
    '/api/vendor/seats',
    requireVendor(guard),
    createVendorSeatsHandler(t.factory, async () => new Map()),
  );
  app.patch(
    '/api/vendor/profile',
    requireVendor(guard),
    createUpdateVendorProfileHandler(t.factory),
  );
  app.patch(
    '/api/vendor/products/:id',
    requireVendor(guard),
    createUpdateVendorProductHandler(t.factory),
  );
  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  path: string,
  method: string,
  sub: string,
  body?: unknown,
): Promise<{ status: number; body: JsonBody }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL })}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await makeApp().request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    ENV,
    fakeExecutionContext(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as JsonBody };
}

const auditRows = () => t.db.select().from(auditLog);

// ─── THE INVARIANT: reads are never gated ────────────────────────────────────

describe('reads are NEVER gated (§4.3 / R13 — invariant)', () => {
  /** Every non-granting entitlement state, including the one that has no row.
   *  All three must READ exactly like a paid vendor. */
  const LOCKED_OUT: ReadonlyArray<{ label: string; sub: string; slug: string }> = [
    { label: 'revoked', sub: SEAT_LAPSED, slug: 'bentley' },
    { label: 'no entitlement row', sub: SEAT_UNCLAIMED, slug: 'trimble' },
  ];

  it.each(LOCKED_OUT)(
    'GET /api/vendor/me returns 200 for a $label vendor, with the DOWNGRADED block',
    async ({ sub, slug }) => {
      const { status, body } = await call('/api/vendor/me', 'GET', sub);

      // 200 — NOT 403, and above all NOT 404. `vendorMeResolver` turns any of
      // 401/403/404 into a 404 render, so anything but 200 here erases the
      // dashboard (and the renewal notice) for exactly this cohort.
      expect(status).toBe(200);
      expect(() => VendorMeResponseSchema.parse(body)).not.toThrow();
      expect(body.vendor.slug).toBe(slug);

      // The block is present and honestly downgraded to the Free capabilities,
      // so the dashboard can gate its forms off one field instead of guessing.
      expect(body.entitlement.tier).toBe('unclaimed');
      expect(body.entitlement.capabilities).toEqual([...capabilitiesFor('unclaimed')]);
      // Each product's plan is its own (§13.7, AECI-1355). Here no product holds
      // a live license either, so each is Free too.
      expect(body.products.length).toBeGreaterThan(0);
      for (const product of body.products) {
        expect(product.plan.tier).toBe('unclaimed');
        expect(product.plan.capabilities).toEqual([...capabilitiesFor('unclaimed')]);
      }
    },
  );

  it('GET /api/vendor/me carries the lapsed TERM, so the dashboard can say why', async () => {
    const { body } = await call('/api/vendor/me', 'GET', SEAT_LAPSED);
    // Not merely "locked" — "revoked, term ended 2026-01-01". A renewal notice
    // needs the status and the date, which is why the session keeps the term
    // readout even when the tier is downgraded.
    expect(body.entitlement.status).toBe('revoked');
    expect(body.entitlement.period_end).toBe('2026-01-01T00:00:00.000Z');
  });

  it('GET /api/vendor/me carries ended_at for the pilot-ended banner (§13.11), on every product too', async () => {
    const { body } = await call('/api/vendor/me', 'GET', SEAT_LAPSED);
    expect(() => VendorMeResponseSchema.parse(body)).not.toThrow();
    expect(body.entitlement.ended_at).toBe('2026-01-02T00:00:00.000Z');
    // The product whose license ended carries its own date (§13.7).
    for (const product of body.products) {
      expect(product.plan.ended_at).toBe('2026-01-02T00:00:00.000Z');
    }
  });

  it('GET /api/vendor/me distinguishes "never had one" from "lost it"', async () => {
    const { body } = await call('/api/vendor/me', 'GET', SEAT_UNCLAIMED);
    // `null` status = no row at all. A vendor that never bought is a different
    // conversation from one whose term lapsed, and the dashboard needs to tell
    // them apart from this payload alone.
    expect(body.entitlement.status).toBeNull();
    expect(body.entitlement.period_end).toBeNull();
    expect(body.entitlement.ended_at).toBeNull();
  });

  it.each(LOCKED_OUT)('GET /api/vendor/seats returns 200 for a $label vendor', async ({ sub }) => {
    // The seat roster is how a locked-out vendor sees who to ask about renewing.
    const { status, body } = await call('/api/vendor/seats', 'GET', sub);
    expect(status).toBe(200);
    expect(Array.isArray(body.seats)).toBe(true);
  });

  // The AC names `revoked` AND `expired`; they are different end reasons (pulled
  // for cause vs. lapsed amicably) and the read must survive both. A license has
  // no `pending` state (AECI-1355), so the third entitlement status has no case.
  it.each([
    ['lapsed', 'expired'],
    ['released', 'expired'],
  ])('GET /api/vendor/me returns 200 for a license ended as %s (%s)', async (endReason, status) => {
    await t.db.update(licenses).set({ endReason });

    const read = await call('/api/vendor/me', 'GET', SEAT_LAPSED);
    expect(read.status).toBe(200);
    expect(() => VendorMeResponseSchema.parse(read.body)).not.toThrow();
    expect(read.body.entitlement.tier).toBe('unclaimed');
    expect(read.body.entitlement.status).toBe(status);

    // …and a Managed-only write is still refused, so every non-granting
    // status lands on the Free plan, not just the one seeded above.
    const write = await call(`/api/vendor/products/${PRODUCT_LAPSED}`, 'PATCH', SEAT_LAPSED, {
      api_docs_url: 'https://x.test/api',
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
  });

  it('serves the paid vendor the FULL block — the launch behaviour is unchanged', async () => {
    const { status, body } = await call('/api/vendor/me', 'GET', SEAT_PAID);
    expect(status).toBe(200);
    expect(body.entitlement).toEqual({
      tier: 'verified',
      status: 'active',
      period_end: '2027-01-01T00:00:00.000Z',
      ended_at: null,
      capabilities: [...CAPABILITIES],
    });
    for (const product of body.products) expect(product.plan).toEqual(body.entitlement);
  });

  it('carries no price block (AECI-1357)', async () => {
    // The override is retired (VENDOR_SIGNUP_PROCESS.md §2 decision 8) and its table
    // dropped (migration 0081).
    const { status, body } = await call('/api/vendor/me', 'GET', SEAT_UNCLAIMED);
    expect(status).toBe(200);
    expect(() => VendorMeResponseSchema.parse(body)).not.toThrow();
    expect(body.entitlement).not.toHaveProperty('price');
    for (const product of body.products) expect(product.plan).not.toHaveProperty('price');

    // The product PATCH response carries the same block.
    const write = await call(`/api/vendor/products/${PRODUCT_UNCLAIMED}`, 'PATCH', SEAT_UNCLAIMED, {
      description: 'Edited',
    });
    expect(write.status).toBe(200);
    expect(write.body.product.plan).not.toHaveProperty('price');
  });

  it('builds the block from the SESSION — no extra query, and it cannot disagree', async () => {
    // The tier in the readout is the same field `requireCapability` asserts on,
    // so "the dashboard says you can edit" and "the write 403s" cannot diverge.
    const paid = await call('/api/vendor/me', 'GET', SEAT_PAID);
    const write = await call('/api/vendor/profile', 'PATCH', SEAT_PAID, { description: 'ok' });
    expect(paid.body.entitlement.capabilities).toContain('profile.edit');
    expect(write.status).toBe(200);

    const lapsedRead = await call('/api/vendor/me', 'GET', SEAT_LAPSED);
    const lapsedWrite = await call(`/api/vendor/products/${PRODUCT_LAPSED}`, 'PATCH', SEAT_LAPSED, {
      tool_integrations_url: 'https://x.test/int',
    });
    expect(lapsedRead.body.products[0].plan.capabilities).not.toContain('product.edit');
    expect(lapsedWrite.status).toBe(403);
  });
});

// ─── The Free / Managed split on writes (AECI-1214) ──────────────────────────

/**
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.3. A seat with no plan (`unclaimed`, which a
 * lapsed row also resolves to) edits company details and the four product fields
 * that feed `listing_tier`. Everything else on the product stays Managed-only.
 * The connector catalogue seat is a "no entitlement row" seat, so it is covered
 * by the same persona (ruling 2026-10-02).
 */
const NO_PLAN: ReadonlyArray<{ label: string; sub: string; productId: string; vendorId: string }> =
  [
    { label: 'revoked', sub: SEAT_LAPSED, productId: PRODUCT_LAPSED, vendorId: VENDOR_LAPSED },
    {
      label: 'no entitlement row',
      sub: SEAT_UNCLAIMED,
      productId: PRODUCT_UNCLAIMED,
      vendorId: VENDOR_UNCLAIMED,
    },
  ];

/** Each Managed-only product field, sent alone, and the capability its 403 names. */
const MANAGED_ONLY: ReadonlyArray<{ field: string; value: unknown; capability: string }> = [
  { field: 'tool_integrations_url', value: 'https://x.test/int', capability: 'product.edit' },
  { field: 'api_docs_url', value: 'https://x.test/api', capability: 'product.edit' },
  {
    field: 'usefulness',
    value: { audiences: [{ slug: 'architects', points: ['x'] }], phases: [] },
    capability: 'product.usefulness.edit',
  },
  { field: 'audience_slugs', value: ['architects'], capability: 'product.taxonomy.edit' },
  { field: 'phase_slugs', value: ['design'], capability: 'product.taxonomy.edit' },
  { field: 'trade_slugs', value: ['electrical'], capability: 'product.taxonomy.edit' },
];

describe('a seat with no plan edits the Free fields (§13.3)', () => {
  for (const persona of NO_PLAN) {
    it(`PATCH /api/vendor/profile → 200 for a ${persona.label} vendor`, async () => {
      const { status, body } = await call('/api/vendor/profile', 'PATCH', persona.sub, {
        description: 'Free blurb',
        headquarters: 'Denver, CO',
        website: 'https://free.example',
      });
      expect(status).toBe(200);
      expect(body.vendor.description).toBe('Free blurb');

      const [row] = await t.db.select().from(vendors).where(eq(vendors.id, persona.vendorId));
      expect(row?.headquarters).toBe('Denver, CO');
      const audits = await auditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0]?.action).toBe('vendor.updated');
    });

    it(`PATCH /api/vendor/products/:id → 200 for the Free fields, ${persona.label}`, async () => {
      const { status, body } = await call(
        `/api/vendor/products/${persona.productId}`,
        'PATCH',
        persona.sub,
        {
          description: 'Free product blurb',
          website: 'https://p.example',
          category_slugs: ['bim'],
        },
      );
      expect(status).toBe(200);
      expect(body.product.description).toBe('Free product blurb');
      expect(body.product.website).toBe('https://p.example');
      expect(body.product.category_slugs).toEqual(['bim']);
      // The echo carries this product's plan, so the form's gates re-derive from
      // the same block the write was checked against (§13.7).
      expect(body.product.plan.tier).toBe('unclaimed');
      expect(body.product.plan.capabilities).toEqual([...capabilitiesFor('unclaimed')]);

      const cats = await t.db
        .select()
        .from(productCategories)
        .where(eq(productCategories.productId, persona.productId));
      expect(cats).toHaveLength(1);
    });

    for (const managed of MANAGED_ONLY) {
      it(`refuses ${managed.field} alone with 403 naming it, ${persona.label}`, async () => {
        const { status, body } = await call(
          `/api/vendor/products/${persona.productId}`,
          'PATCH',
          persona.sub,
          { [managed.field]: managed.value },
        );
        expect(status).toBe(403);
        expect(body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
        expect(body.error.details).toEqual({
          capability: managed.capability,
          tier: 'unclaimed',
          fields: [managed.field],
        });
      });
    }
  }

  it('refuses a mixed Free + Managed request WHOLE, naming every denied field', async () => {
    const { status, body } = await call(
      `/api/vendor/products/${PRODUCT_UNCLAIMED}`,
      'PATCH',
      SEAT_UNCLAIMED,
      {
        description: 'would be allowed',
        category_slugs: ['bim'],
        trade_slugs: ['electrical'],
        api_docs_url: 'https://x.test/api',
      },
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    // Sorted, so the body is deterministic; the capability is the first one's.
    expect(body.error.details).toEqual({
      capability: 'product.edit',
      tier: 'unclaimed',
      fields: ['api_docs_url', 'trade_slugs'],
    });

    // Nothing half-applied: not the allowed column, not the allowed facet.
    const [product] = await t.db.select().from(products).where(eq(products.id, PRODUCT_UNCLAIMED));
    expect(product?.description).toBe('Unclaimed');
    const cats = await t.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.productId, PRODUCT_UNCLAIMED));
    expect(cats).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 403, not 400, for a denied facet carrying an unknown slug', async () => {
    // The field gate runs before term resolution, so an unentitled caller never
    // spends the read and never learns which slugs exist.
    const { status, body } = await call(
      `/api/vendor/products/${PRODUCT_UNCLAIMED}`,
      'PATCH',
      SEAT_UNCLAIMED,
      { trade_slugs: ['no-such-trade'] },
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
  });

  it('still rejects an empty request as a validation failure', async () => {
    const { status, body } = await call(
      `/api/vendor/products/${PRODUCT_UNCLAIMED}`,
      'PATCH',
      SEAT_UNCLAIMED,
      {},
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    const profile = await call('/api/vendor/profile', 'PATCH', SEAT_UNCLAIMED, {});
    expect(profile.status).toBe(400);
  });

  it('answers 404 — NOT 403 — when a no-plan vendor targets a product it does not own', async () => {
    // Ownership settles BEFORE the field gate, so a 403 can never confirm that
    // another vendor's product exists. Both a Free and a Managed field are tried.
    for (const body of [{ description: 'hijacked' }, { api_docs_url: 'https://x.test/api' }]) {
      const res = await call(`/api/vendor/products/${PRODUCT_PAID}`, 'PATCH', SEAT_UNCLAIMED, body);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    }
    const [product] = await t.db.select().from(products).where(eq(products.id, PRODUCT_PAID));
    expect(product?.description).toBe('Paid product');
  });
});

describe('a Managed seat edits every field', () => {
  it('writes the Free and the Managed fields together', async () => {
    const profile = await call('/api/vendor/profile', 'PATCH', SEAT_PAID, {
      description: 'New blurb',
    });
    expect(profile.status).toBe(200);
    expect(profile.body.vendor.description).toBe('New blurb');

    const product = await call(`/api/vendor/products/${PRODUCT_PAID}`, 'PATCH', SEAT_PAID, {
      description: 'New product blurb',
      api_docs_url: 'https://x.test/api',
      tool_integrations_url: 'https://x.test/int',
      category_slugs: ['bim'],
      trade_slugs: [],
    });
    expect(product.status).toBe(200);
    expect(product.body.product.description).toBe('New product blurb');
    expect(product.body.product.api_docs_url).toBe('https://x.test/api');
    expect(product.body.product.category_slugs).toEqual(['bim']);
    expect(product.body.product.plan).toEqual({
      tier: 'verified',
      status: 'active',
      period_end: '2027-01-01T00:00:00.000Z',
      ended_at: null,
      capabilities: [...CAPABILITIES],
    });
  });

  it('rejects a BANNED seat before any entitlement question (AECI-524 ordering)', async () => {
    await t.db.insert(profiles).values({
      id: uuid(103),
      role: 'vendor_admin',
      vendorId: VENDOR_PAID,
      bannedAt: '2026-07-01T00:00:00.000Z',
      banReason: 'Portal abuse',
    });
    const { status, body } = await call('/api/vendor/profile', 'PATCH', uuid(103), {
      description: 'x',
    });
    // The ONLY thing that can reject this is the ban — and it must be the plain
    // FORBIDDEN with the ban reason, not an ENTITLEMENT_REQUIRED.
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(body.error.message).toBe('Portal abuse');
  });
});

// ─── Per-product plans (AECI-1355) ───────────────────────────────────────────

/**
 * The E1.6 acceptance case (`docs/VENDOR_SIGNUP_PROCESS.md` §3 step 6): a vendor
 * with two products and ONE license assigned to the first. Managed fields write
 * on the licensed product and answer `403 ENTITLEMENT_REQUIRED` on the other,
 * with the same `details` shape the no-plan seat gets.
 */
describe('one license, two products: the plan is per product', () => {
  beforeEach(async () => {
    await t.db
      .insert(products)
      .values({ id: PRODUCT_PAID_FREE, slug: 'navisworks', name: 'Navisworks' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_PAID_FREE, vendorId: VENDOR_PAID, isPrimary: false });
  });

  it('writes Managed fields on the licensed product and 403s them on the other', async () => {
    const managed = {
      api_docs_url: 'https://x.test/api',
      usefulness: { audiences: [], phases: [] },
    };
    const licensed = await call(
      `/api/vendor/products/${PRODUCT_PAID}`,
      'PATCH',
      SEAT_PAID,
      managed,
    );
    expect(licensed.status).toBe(200);
    expect(licensed.body.product.plan.tier).toBe('verified');

    const other = await call(
      `/api/vendor/products/${PRODUCT_PAID_FREE}`,
      'PATCH',
      SEAT_PAID,
      managed,
    );
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    // The same shape as a seat with no plan at all: the product's tier, the
    // first denied field's capability, every denied field.
    expect(other.body.error.details).toEqual({
      capability: 'product.edit',
      tier: 'unclaimed',
      fields: ['api_docs_url', 'usefulness'],
    });
    const noPlan = await call(
      `/api/vendor/products/${PRODUCT_UNCLAIMED}`,
      'PATCH',
      SEAT_UNCLAIMED,
      managed,
    );
    expect(Object.keys(noPlan.body.error.details).sort()).toEqual(
      Object.keys(other.body.error.details).sort(),
    );
    expect(noPlan.body.error.message).toBe(other.body.error.message);

    // Nothing landed on the refused product.
    const [row] = await t.db.select().from(products).where(eq(products.id, PRODUCT_PAID_FREE));
    expect(row?.apiDocsUrl).toBeNull();

    // The Free fields still write on the unlicensed product.
    const free = await call(`/api/vendor/products/${PRODUCT_PAID_FREE}`, 'PATCH', SEAT_PAID, {
      description: 'Free edit',
    });
    expect(free.status).toBe(200);
  });

  it('GET /api/vendor/me is ungated and shows each product its own plan', async () => {
    const { status, body } = await call('/api/vendor/me', 'GET', SEAT_PAID);
    expect(status).toBe(200);
    expect(() => VendorMeResponseSchema.parse(body)).not.toThrow();
    // The vendor block: any live license makes the vendor verified.
    expect(body.entitlement.tier).toBe('verified');
    const plans = Object.fromEntries(
      (body.products as JsonBody[]).map((p) => [p.id, p.plan as JsonBody]),
    );
    expect(plans[PRODUCT_PAID]).toEqual(body.entitlement);
    expect(plans[PRODUCT_PAID_FREE]).toEqual({
      tier: 'unclaimed',
      status: null,
      period_end: null,
      ended_at: null,
      capabilities: [...capabilitiesFor('unclaimed')],
    });
  });

  it('an unassigned license makes the vendor verified and no product Managed', async () => {
    await t.db.update(licenses).set({ assignedProductId: null, assignedAt: null });
    const me = await call('/api/vendor/me', 'GET', SEAT_PAID);
    expect(me.body.entitlement.tier).toBe('verified');
    for (const product of me.body.products) expect(product.plan.tier).toBe('unclaimed');
    const write = await call(`/api/vendor/products/${PRODUCT_PAID}`, 'PATCH', SEAT_PAID, {
      api_docs_url: 'https://x.test/api',
    });
    expect(write.status).toBe(403);
    // Company details are a vendor-level write, held on every plan.
    const profile = await call('/api/vendor/profile', 'PATCH', SEAT_PAID, { description: 'ok' });
    expect(profile.status).toBe(200);
  });
});

/**
 * Ruled 2026-10-14 (`docs/VENDOR_SIGNUP_PROCESS.md` §2): only the payer gets
 * Managed rights. A co-owned product is Managed only for the vendor whose billing
 * account holds its license; the other owner stays Free on it.
 */
describe('a co-owned product is Managed only for the vendor that pays for it', () => {
  beforeEach(async () => {
    // VENDOR_UNCLAIMED co-owns PRODUCT_PAID, whose license is on VENDOR_PAID's account.
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_PAID, vendorId: VENDOR_UNCLAIMED, isPrimary: false });
  });

  it('GET /api/vendor/me shows the co-owned product as Free to the non-paying owner', async () => {
    const { status, body } = await call('/api/vendor/me', 'GET', SEAT_UNCLAIMED);
    expect(status).toBe(200);
    const coOwned = (body.products as JsonBody[]).find((p) => p.id === PRODUCT_PAID);
    expect(coOwned?.plan).toEqual({
      tier: 'unclaimed',
      status: null,
      period_end: null,
      ended_at: null,
      capabilities: [...capabilitiesFor('unclaimed')],
    });
    // The payer still sees it Managed.
    const payer = await call('/api/vendor/me', 'GET', SEAT_PAID);
    const paid = (payer.body.products as JsonBody[]).find((p) => p.id === PRODUCT_PAID);
    expect(paid?.plan.tier).toBe('verified');
  });

  it('refuses the non-paying owner a Managed field on the co-owned product, same 403 shape', async () => {
    const res = await call(`/api/vendor/products/${PRODUCT_PAID}`, 'PATCH', SEAT_UNCLAIMED, {
      api_docs_url: 'https://x.test/api',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    expect(res.body.error.details).toEqual({
      capability: 'product.edit',
      tier: 'unclaimed',
      fields: ['api_docs_url'],
    });
    const payer = await call(`/api/vendor/products/${PRODUCT_PAID}`, 'PATCH', SEAT_PAID, {
      api_docs_url: 'https://x.test/api',
    });
    expect(payer.status).toBe(200);
  });
});

// ─── The second axis: the field-granular allow-list ──────────────────────────

/** A tier this build does not know. `capabilitiesFor` gives it nothing, which is
 *  the only way left to exercise a denial on `VENDOR_COLUMN_MAP`. */
const UNKNOWN_TIER = 'enterprise' as EntitlementTier;

/**
 * §13.3's table, written out by hand rather than read from the maps, so this
 * checks the maps against the spec and not against themselves.
 */
const SPEC_PRODUCT_FIELDS: Readonly<Record<string, Capability>> = {
  description: 'product.listing.edit',
  website: 'product.listing.edit',
  logo_url: 'product.listing.edit',
  tool_integrations_url: 'product.edit',
  api_docs_url: 'product.edit',
  usefulness: 'product.usefulness.edit',
};

describe('splitPatch — the entitlement allow-list (§3.3b)', () => {
  it('THROWS on an unentitled field and never silently drops it', () => {
    // The bug class this prevents: `vendor-profile-form.ts` runs a dirty-diff
    // and re-seeds its baseline from the response echo. A dropped field makes
    // the form settle CLEAN on a value that never reached the database.
    let thrown: unknown;
    try {
      splitPatch({ description: 'x', website: 'https://y.test' }, VENDOR_COLUMN_MAP, UNKNOWN_TIER);
    } catch (e) {
      thrown = e;
    }
    const err = thrown as { status: number; code: string; details: JsonBody };
    expect(err.status).toBe(403);
    expect(err.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    // EVERY denied field is named.
    expect(err.details.fields).toEqual(['description', 'website']);
  });

  it('passes the whole patch through for an entitled tier', () => {
    const { columns, provided } = splitPatch(
      { description: 'x', founded_year: 1982 },
      VENDOR_COLUMN_MAP,
      'verified',
    );
    expect(columns).toEqual({ description: 'x', foundedYear: 1982 });
    expect(provided.sort()).toEqual(['description', 'founded_year']);
  });

  it('still ignores keys that are not columns (the taxonomy arrays)', () => {
    const { columns, provided } = splitPatch(
      { description: 'x', category_slugs: ['bim'] },
      PRODUCT_COLUMN_MAP,
      'verified',
    );
    expect(columns).toEqual({ description: 'x' });
    expect(provided).toEqual(['description']);
  });

  it('refuses a mixed patch whole and reports the denied field’s capability', () => {
    // `website` is Free and `api_docs_url` is Managed. The Free one does not
    // slip through: the whole patch is refused, naming only the denied field.
    let details: JsonBody = {};
    try {
      splitPatch(
        { website: 'https://y.test', api_docs_url: null },
        PRODUCT_COLUMN_MAP,
        'unclaimed',
      );
    } catch (e) {
      details = (e as { details: JsonBody }).details;
    }
    expect(details.fields).toEqual(['api_docs_url']);
    expect(details.capability).toBe('product.edit');
  });

  // Per field, per tier: the column maps against §13.3.
  for (const tier of TIERS) {
    for (const [field, capability] of Object.entries(SPEC_PRODUCT_FIELDS)) {
      const allowed = hasCapability(tier, capability);
      it(`product ${field} is ${allowed ? 'allowed' : 'denied'} for ${tier}`, () => {
        const run = () => splitPatch({ [field]: null }, PRODUCT_COLUMN_MAP, tier);
        if (allowed) {
          expect(run().provided).toEqual([field]);
        } else {
          expect(run).toThrow(expect.objectContaining({ status: 403 }));
        }
      });
    }
    for (const field of Object.keys(UpdateVendorProfileSchema.shape)) {
      it(`company ${field} is allowed for ${tier} (decision 3)`, () => {
        expect(splitPatch({ [field]: null }, VENDOR_COLUMN_MAP, tier).provided).toEqual([field]);
      });
    }
  }

  it('maps each product column to exactly the §13.3 capability', () => {
    expect(
      Object.fromEntries(Object.entries(PRODUCT_COLUMN_MAP).map(([f, e]) => [f, e.capability])),
    ).toEqual(SPEC_PRODUCT_FIELDS);
  });
});

describe('assertFieldsEntitled — the facet axis (§13.3)', () => {
  const facetCapability = (field: string) =>
    PRODUCT_FIELD_CAPABILITIES[field as keyof typeof PRODUCT_FIELD_CAPABILITIES];

  it('gates categories on product.categories.edit and the rest on product.taxonomy.edit', () => {
    expect(facetCapability('category_slugs')).toBe('product.categories.edit');
    for (const field of ['audience_slugs', 'phase_slugs', 'trade_slugs']) {
      expect(facetCapability(field)).toBe('product.taxonomy.edit');
    }
  });

  it('lets unclaimed send categories and refuses the other three facets', () => {
    expect(() =>
      assertFieldsEntitled({ category_slugs: ['bim'] }, facetCapability, 'unclaimed'),
    ).not.toThrow();
    for (const field of ['audience_slugs', 'phase_slugs', 'trade_slugs']) {
      expect(() => assertFieldsEntitled({ [field]: [] }, facetCapability, 'unclaimed')).toThrow(
        expect.objectContaining({ status: 403 }),
      );
      expect(() =>
        assertFieldsEntitled({ [field]: [] }, facetCapability, 'verified'),
      ).not.toThrow();
    }
  });

  it('skips keys the table does not know', () => {
    expect(() => assertFieldsEntitled({ name: 'x' }, facetCapability, UNKNOWN_TIER)).not.toThrow();
  });
});

// ─── The shared tables match the wire schemas ────────────────────────────────

describe('the field → capability tables match the edit schemas', () => {
  // `@aeci/shared/entitlements` may not import zod (its rule 1), so the tables
  // there cannot be typed against the schemas. This is what keeps them in step:
  // a field added to a schema but not to its table would be written with no gate.
  it('VENDOR_FIELD_CAPABILITIES covers UpdateVendorProfileSchema exactly', () => {
    expect(Object.keys(VENDOR_FIELD_CAPABILITIES).sort()).toEqual(
      Object.keys(UpdateVendorProfileSchema.shape).sort(),
    );
    expect(Object.keys(VENDOR_COLUMN_MAP).sort()).toEqual(
      Object.keys(UpdateVendorProfileSchema.shape).sort(),
    );
  });

  it('PRODUCT_FIELD_CAPABILITIES covers UpdateVendorProductSchema exactly', () => {
    expect(Object.keys(PRODUCT_FIELD_CAPABILITIES).sort()).toEqual(
      Object.keys(UpdateVendorProductSchema.shape).sort(),
    );
  });
});

// ─── The launch guarantee ────────────────────────────────────────────────────

describe('the two allow-list axes agree', () => {
  it.each([
    ['VENDOR_COLUMN_MAP', VENDOR_COLUMN_MAP],
    ['PRODUCT_COLUMN_MAP', PRODUCT_COLUMN_MAP],
  ])('every field in %s maps to a capability the verified tier holds', (_label, map) => {
    // What makes "a Managed vendor can edit everything" true rather than hoped-for.
    const entries = Object.entries(map);
    expect(entries.length).toBeGreaterThan(0);
    for (const [field, { capability }] of entries) {
      expect(hasCapability('verified', capability), `${field} → ${capability}`).toBe(true);
    }
  });

  it.each([
    ['VENDOR_COLUMN_MAP', VENDOR_COLUMN_MAP],
    ['PRODUCT_COLUMN_MAP', PRODUCT_COLUMN_MAP],
  ])('every capability named in %s is in the frozen registry', (_label, map) => {
    // A typo'd id would fail closed and lock a field for EVERY tier.
    for (const [, { capability }] of Object.entries(map)) {
      expect(CAPABILITIES).toContain(capability);
    }
  });

  it('the unclaimed tier holds exactly the Free capabilities', () => {
    expect(capabilitiesFor('unclaimed')).toEqual([
      'profile.edit',
      'product.listing.edit',
      'product.categories.edit',
    ]);
  });
});
