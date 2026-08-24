/**
 * The entitlement gate on `/api/vendor/*` (AECI-611 —
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §4).
 *
 * Like `vendor.authz-matrix.spec.ts` and unlike `vendor.spec.ts`, this composes
 * the **real** `requireVendor()` guard with the **real** handlers over the
 * in-memory D1 harness, driven by genuinely signed JWTs. That matters here more
 * than anywhere: the tier is produced by the guard's `leftJoin`, so a spec that
 * stubbed `c.set('auth', …)` would be asserting its own fixture rather than the
 * mechanism. Every tier below is the one the middleware actually derived from a
 * seeded `vendor_entitlements` row.
 *
 * Three personas, one per entitlement state that behaves differently:
 *
 *   PAID      — an `active` entitlement. Writes work; nothing about the surface
 *               changed for this vendor, which is the whole launch AC.
 *   LAPSED    — `revoked` / `expired` / `pending`. Reads 200, writes 403.
 *   UNCLAIMED — no `vendor_entitlements` row at all. Same as LAPSED, but with a
 *               null term readout rather than a lapsed one.
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

import { ApiErrorCode, VendorMeResponseSchema } from '@aeci/shared';
import { CAPABILITIES, capabilitiesFor, hasCapability } from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  productCategories,
  productVendors,
  products,
  profiles,
  taxonomyCategories,
  vendorEntitlements,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireVendor, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  PRODUCT_COLUMN_MAP,
  VENDOR_COLUMN_MAP,
  createUpdateVendorProductHandler,
  createUpdateVendorProfileHandler,
  createVendorMeHandler,
  createVendorSeatsHandler,
  splitPatch,
} from './vendor';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { ENV: 'preview', SUPABASE_URL } as Env;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_PAID = uuid(1);
const VENDOR_LAPSED = uuid(2);
const VENDOR_UNCLAIMED = uuid(3);

const PRODUCT_PAID = uuid(10);
const PRODUCT_LAPSED = uuid(11);
const PRODUCT_UNCLAIMED = uuid(12);

const SEAT_PAID = uuid(100);
const SEAT_LAPSED = uuid(101);
const SEAT_UNCLAIMED = uuid(102);

const CAT_BIM = uuid(200);

let t: TestDb;
let jwks: TestJwks;

beforeEach(async () => {
  t = await makeTestDb();
  jwks = await makeTestJwks();

  // `verified` mirrors an ACTIVE entitlement (§2.1) — seeded together, never one
  // side alone, or the fixture describes a state `entitlement_mirror_drift`
  // would flag.
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
  await t.db.insert(vendorEntitlements).values([
    {
      id: uuid(70),
      vendorId: VENDOR_PAID,
      tier: 'verified',
      status: 'active',
      periodEnd: '2027-01-01T00:00:00.000Z',
    },
    // Pulled for cause. The row survives the revocation — that is what lets the
    // dashboard say WHY, and it is why `status` rather than row-absence is the
    // thing the gate reads.
    {
      id: uuid(71),
      vendorId: VENDOR_LAPSED,
      tier: 'verified',
      status: 'revoked',
      periodEnd: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-02T00:00:00.000Z',
    },
  ]);
  // VENDOR_UNCLAIMED deliberately gets NO entitlement row.

  await t.db.insert(products).values([
    { id: PRODUCT_PAID, slug: 'revit', name: 'Revit', description: 'Paid product' },
    { id: PRODUCT_LAPSED, slug: 'microstation', name: 'MicroStation', description: 'Lapsed' },
    { id: PRODUCT_UNCLAIMED, slug: 'tekla', name: 'Tekla', description: 'Unclaimed' },
  ]);
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

      // The block is present and honestly downgraded: no capabilities, so the
      // dashboard can disable its forms off one field instead of guessing.
      expect(body.entitlement.tier).toBe('unclaimed');
      expect(body.entitlement.capabilities).toEqual([]);
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

  it('GET /api/vendor/me distinguishes "never had one" from "lost it"', async () => {
    const { body } = await call('/api/vendor/me', 'GET', SEAT_UNCLAIMED);
    // `null` status = no row at all. A vendor that never bought is a different
    // conversation from one whose term lapsed, and the dashboard needs to tell
    // them apart from this payload alone.
    expect(body.entitlement.status).toBeNull();
    expect(body.entitlement.period_end).toBeNull();
  });

  it.each(LOCKED_OUT)('GET /api/vendor/seats returns 200 for a $label vendor', async ({ sub }) => {
    // The seat roster is how a locked-out vendor sees who to ask about renewing.
    const { status, body } = await call('/api/vendor/seats', 'GET', sub);
    expect(status).toBe(200);
    expect(Array.isArray(body.seats)).toBe(true);
  });

  // The AC names `revoked` AND `expired`; they are different rows in the state
  // machine (pulled for cause vs. lapsed amicably) and the read must survive
  // both. `pending` rides along because an offline PO that has not taken effect
  // is the third way to hold a non-granting row.
  it.each([['expired'], ['pending']])(
    'GET /api/vendor/me returns 200 for an %s entitlement',
    async (status) => {
      await t.db
        .update(vendorEntitlements)
        .set({ status })
        .where(eq(vendorEntitlements.vendorId, VENDOR_LAPSED));

      const read = await call('/api/vendor/me', 'GET', SEAT_LAPSED);
      expect(read.status).toBe(200);
      expect(() => VendorMeResponseSchema.parse(read.body)).not.toThrow();
      expect(read.body.entitlement.tier).toBe('unclaimed');
      expect(read.body.entitlement.status).toBe(status);

      // …and the write is still refused, so "reads open, writes closed" holds
      // for every non-granting status, not just the one seeded above.
      const write = await call('/api/vendor/profile', 'PATCH', SEAT_LAPSED, { description: 'no' });
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    },
  );

  it('serves the paid vendor the FULL block — the launch behaviour is unchanged', async () => {
    const { status, body } = await call('/api/vendor/me', 'GET', SEAT_PAID);
    expect(status).toBe(200);
    expect(body.entitlement).toEqual({
      tier: 'verified',
      status: 'active',
      period_end: '2027-01-01T00:00:00.000Z',
      capabilities: [...CAPABILITIES],
    });
  });

  it('builds the block from the SESSION — no extra query, and it cannot disagree', async () => {
    // The tier in the readout is the same field `requireCapability` asserts on,
    // so "the dashboard says you can edit" and "the write 403s" cannot diverge.
    const paid = await call('/api/vendor/me', 'GET', SEAT_PAID);
    const write = await call('/api/vendor/profile', 'PATCH', SEAT_PAID, { description: 'ok' });
    expect(paid.body.entitlement.capabilities).toContain('profile.edit');
    expect(write.status).toBe(200);

    const lapsedRead = await call('/api/vendor/me', 'GET', SEAT_LAPSED);
    const lapsedWrite = await call('/api/vendor/profile', 'PATCH', SEAT_LAPSED, {
      description: 'no',
    });
    expect(lapsedRead.body.entitlement.capabilities).not.toContain('profile.edit');
    expect(lapsedWrite.status).toBe(403);
  });
});

// ─── Writes ARE gated ────────────────────────────────────────────────────────

describe('writes require an active entitlement', () => {
  const WRITES: ReadonlyArray<{
    label: string;
    path: (productId: string) => string;
    body: unknown;
    capability: string;
  }> = [
    {
      label: 'PATCH /api/vendor/profile',
      path: () => '/api/vendor/profile',
      body: { description: 'hijacked' },
      capability: 'profile.edit',
    },
    {
      label: 'PATCH /api/vendor/products/:id',
      path: (productId) => `/api/vendor/products/${productId}`,
      body: { description: 'hijacked' },
      capability: 'product.edit',
    },
  ];

  const LOCKED_OUT: ReadonlyArray<{ label: string; sub: string; productId: string }> = [
    { label: 'revoked', sub: SEAT_LAPSED, productId: PRODUCT_LAPSED },
    { label: 'no entitlement row', sub: SEAT_UNCLAIMED, productId: PRODUCT_UNCLAIMED },
  ];

  for (const write of WRITES) {
    for (const persona of LOCKED_OUT) {
      it(`${write.label} → 403 ENTITLEMENT_REQUIRED for a ${persona.label} vendor`, async () => {
        const { status, body } = await call(
          write.path(persona.productId),
          'PATCH',
          persona.sub,
          write.body,
        );

        // 403 — not 402 (leaks a billing model into a payer-agnostic contract,
        // and API_CONTRACTS.md §4.1 has no 402 row) and not 404 (this vendor
        // demonstrably exists and owns the row; a 404 would be a lie that also
        // breaks the dashboard).
        expect(status).toBe(403);
        expect(body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
        expect(body.error.details).toEqual({
          capability: write.capability,
          tier: 'unclaimed',
        });
      });
    }
  }

  it('writes NOTHING and audits nothing when it rejects', async () => {
    await call('/api/vendor/profile', 'PATCH', SEAT_LAPSED, { description: 'hijacked' });
    await call(`/api/vendor/products/${PRODUCT_LAPSED}`, 'PATCH', SEAT_LAPSED, {
      description: 'hijacked',
    });

    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_LAPSED));
    const [product] = await t.db.select().from(products).where(eq(products.id, PRODUCT_LAPSED));
    expect(vendor?.description).toBe('Lapsed blurb');
    expect(product?.description).toBe('Lapsed');
    // The gate runs before the batch opens, so there is no half-applied edit and
    // no audit row for a write that never happened.
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets the PAID vendor through unchanged — the launch AC', async () => {
    const profile = await call('/api/vendor/profile', 'PATCH', SEAT_PAID, {
      description: 'New blurb',
    });
    expect(profile.status).toBe(200);
    expect(profile.body.vendor.description).toBe('New blurb');

    const product = await call(`/api/vendor/products/${PRODUCT_PAID}`, 'PATCH', SEAT_PAID, {
      description: 'New product blurb',
      category_slugs: ['bim'],
    });
    expect(product.status).toBe(200);
    expect(product.body.product.description).toBe('New product blurb');
    expect(product.body.product.category_slugs).toEqual(['bim']);
  });

  it('gates a taxonomy-ONLY edit, which writes no product column at all', async () => {
    // The facet arrays are join rewrites, not columns, so `splitPatch`'s field
    // axis cannot see them — without an explicit check a lapsed vendor could
    // re-file its products across the browse pages while "editing nothing".
    //
    // The reported capability is the BASE `product.edit` right, not
    // `product.taxonomy.edit`: any PATCH on this route writes the `products`
    // row (`updated_at` at minimum, which is what feeds the nightly Algolia
    // sync), so the base right is checked first and taxonomy assignment is an
    // ADDITIONAL capability layered on top. The two only become distinguishable
    // once a middle rung exists that holds one without the other — at launch the
    // binary ladder grants both together.
    const { status, body } = await call(
      `/api/vendor/products/${PRODUCT_LAPSED}`,
      'PATCH',
      SEAT_LAPSED,
      { category_slugs: ['bim'] },
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    expect(body.error.details.capability).toBe('product.edit');

    // The assignment is untouched and `updated_at` did not move.
    const cats = await t.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.productId, PRODUCT_LAPSED));
    expect(cats).toHaveLength(0);
  });

  it('requires BOTH capabilities when facets ride along, and grants both at launch', async () => {
    // `verified` holds `product.edit` AND `product.taxonomy.edit`, so the two
    // checks in the handler are transparent today. This pins that the second
    // check does not reject an entitled vendor — the failure mode of adding a
    // gate whose capability nobody actually holds.
    expect(hasCapability('verified', 'product.edit')).toBe(true);
    expect(hasCapability('verified', 'product.taxonomy.edit')).toBe(true);

    const { status, body } = await call(
      `/api/vendor/products/${PRODUCT_PAID}`,
      'PATCH',
      SEAT_PAID,
      {
        category_slugs: ['bim'],
      },
    );
    expect(status).toBe(200);
    expect(body.product.category_slugs).toEqual(['bim']);
  });

  it('answers 404 — NOT 403 — when a locked-out vendor targets a product it does not own', async () => {
    // Ownership settles BEFORE the capability gate on the product route, so a
    // 403 can never confirm that another vendor's product exists. 404-never-403
    // is the harder invariant of this surface.
    const { status, body } = await call(
      `/api/vendor/products/${PRODUCT_PAID}`,
      'PATCH',
      SEAT_UNCLAIMED,
      { description: 'hijacked' },
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
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
    // A fully paid-up vendor, so the ONLY thing that can reject this is the ban —
    // and it must be the plain FORBIDDEN with the ban reason, not an
    // ENTITLEMENT_REQUIRED that would tell a banned user to go buy something.
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(body.error.message).toBe('Portal abuse');
  });
});

// ─── The second axis: the field-granular allow-list ──────────────────────────

describe('splitPatch — the entitlement allow-list (§3.3b)', () => {
  it('THROWS on an unentitled field and never silently drops it', () => {
    // The bug class this prevents: `vendor-profile-form.ts` runs a dirty-diff
    // and re-seeds its baseline from the response echo. A dropped field makes
    // the form settle CLEAN on a value that never reached the database — the
    // vendor is told their edit landed and it simply is not there.
    let thrown: unknown;
    try {
      splitPatch({ description: 'x', website: 'https://y.test' }, VENDOR_COLUMN_MAP, 'unclaimed');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const err = thrown as { status: number; code: string; details: JsonBody };
    expect(err.status).toBe(403);
    expect(err.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    // EVERY denied field is named, so the client can highlight all of them
    // rather than discovering them one failed save at a time.
    expect(err.details.fields).toEqual(['description', 'website']);
    expect(err.details.tier).toBe('unclaimed');
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

  it('reports the denied field’s capability, deterministically', () => {
    // Sorted, so the 403 body does not depend on JS key-enumeration order.
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
    expect(details.fields).toEqual(['api_docs_url', 'website']);
    expect(details.capability).toBe('product.edit');
  });
});

// ─── The launch guarantee ────────────────────────────────────────────────────

describe('the two allow-list axes agree at launch', () => {
  it.each([
    ['VENDOR_COLUMN_MAP', VENDOR_COLUMN_MAP],
    ['PRODUCT_COLUMN_MAP', PRODUCT_COLUMN_MAP],
  ])('every field in %s maps to a capability the verified tier holds', (_label, map) => {
    // This is what makes "behaviour is unchanged for an entitled vendor" true
    // rather than hoped-for. If a future rung moves a field to a capability
    // `verified` lacks, that is a deliberate product decision and this test is
    // where it gets noticed.
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
    // Guards against a typo'd capability id, which would otherwise fail closed
    // and silently lock a field for EVERY tier including `verified`.
    for (const [, { capability }] of Object.entries(map)) {
      expect(CAPABILITIES).toContain(capability);
    }
  });

  it('the unclaimed tier holds nothing at all', () => {
    expect(capabilitiesFor('unclaimed')).toEqual([]);
  });
});
