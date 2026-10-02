/**
 * The checklist reads (AECI-1217 / `STAGE_2_PAID_TIERS_SPEC.md` §13.10).
 *
 *   GET /api/vendor/checklist
 *   GET /api/vendor/products/:id/checklist
 *
 * Real migrations on in-memory SQLite. Every scenario runs as a seat with no plan
 * (Free) and as a Managed seat, because the plan is the one input that changes a
 * score. Until per-product plans exist the product's plan is the vendor's
 * entitlement (§13.7), so a "Free product" is a product read by a Free seat.
 */

import { VendorChecklistResponseSchema, VendorProductChecklistResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV } from '../test/helpers';
import {
  createVendorChecklistHandler,
  createVendorProductChecklistHandler,
} from './vendor-checklist';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SEEN = '2026-09-01T00:00:00.000Z';

const VENDOR = uuid(1);
const OTHER = uuid(2);

const P_ONE = uuid(10); // VENDOR's, "Revit"
const P_TWO = uuid(11); // VENDOR's, "ACC", sorts first by name
const P_PARTNER = uuid(12); // OTHER's
const P_BRIDGE = uuid(13); // OTHER's connector product
const P_FOREIGN = uuid(14); // OTHER's, never reachable by VENDOR

const DO_RFIS = uuid(50);

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const FREE = seat(1, VENDOR);
const MANAGED: AuthzVariables['auth'] = {
  ...seat(1, VENDOR),
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'autodesk', companyName: 'Autodesk' },
    { id: OTHER, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: P_ONE, slug: 'revit', name: 'Revit' },
    { id: P_TWO, slug: 'acc', name: 'ACC' },
    { id: P_PARTNER, slug: 'microstation', name: 'MicroStation' },
    { id: P_BRIDGE, slug: 'bridge', name: 'Bridge', productRole: 'connector' },
    { id: P_FOREIGN, slug: 'openroads', name: 'OpenRoads' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_ONE, vendorId: VENDOR, isPrimary: true },
    { productId: P_TWO, vendorId: VENDOR, isPrimary: true },
    { productId: P_PARTNER, vendorId: OTHER, isPrimary: true },
    { productId: P_BRIDGE, vendorId: OTHER, isPrimary: true },
    { productId: P_FOREIGN, vendorId: OTHER, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: FREE.userId, role: 'vendor_admin', vendorId: VENDOR },
    { id: uuid(103), role: 'vendor_admin', vendorId: OTHER },
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 });
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/checklist', createVendorChecklistHandler(t.factory));
  a.get('/api/vendor/products/:id/checklist', createVendorProductChecklistHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function get(
  auth: AuthzVariables['auth'],
  path: string,
): Promise<{ status: number; body: JsonBody; res: Response }> {
  const res = await app(auth).request(path, { method: 'GET' }, TEST_ENV);
  return { status: res.status, body: (await res.json()) as JsonBody, res };
}

const vendorChecklist = async (auth: AuthzVariables['auth']) => {
  const { status, body } = await get(auth, '/api/vendor/checklist');
  expect(status).toBe(200);
  expect(() => VendorChecklistResponseSchema.parse(body)).not.toThrow();
  return body;
};
const productChecklist = async (auth: AuthzVariables['auth'], id = P_ONE) => {
  const { status, body } = await get(auth, `/api/vendor/products/${id}/checklist`);
  expect(status).toBe(200);
  expect(() => VendorProductChecklistResponseSchema.parse(body)).not.toThrow();
  return body;
};
const stepStatus = (body: JsonBody, key: string): string =>
  (body.steps as JsonBody[]).find((step) => step.key === key)!.status;

/** Stamp the two "Looks right" product steps, as the AECI-1216 routes would. */
async function checkProduct(id: string) {
  await t.db
    .update(products)
    .set({ maintainedBy: 'vendor', lastReviewedAt: SEEN, integrationsReviewedAt: SEEN })
    .where(eq(products.id, id));
}

/** A seeded row naming VENDOR as builder, unclaimed, on P_ONE ↔ P_PARTNER. */
function seededRow(id: string, extra: Partial<typeof integrations.$inferInsert> = {}) {
  return {
    id,
    sourceProductId: P_ONE,
    targetProductId: P_PARTNER,
    builtByVendorId: VENDOR,
    ...extra,
  };
}

/** An owner contest by OTHER on an `integrations` row. */
function ownerContest(id: string, integrationId: string, status = 'open') {
  return {
    id,
    integrationId,
    field: 'owner',
    currentValue: VENDOR,
    proposedValue: null,
    reason: 'An SI offers this one.',
    submitterVendorId: OTHER,
    routedTo: 'aeci',
    ownerVendorId: VENDOR,
    status,
  };
}

// ─── The plan decides only the data-flows step ───────────────────────────────

describe('a Free product and a Managed product', () => {
  beforeEach(async () => {
    await checkProduct(P_ONE);
    // A claimed row with one unanswered claim: the only thing left on P_ONE is
    // "Confirm data flows".
    await t.db
      .insert(integrations)
      .values(seededRow(uuid(20), { claimedAt: SEEN, maintainedBy: 'vendor' }));
    await t.db.insert(claims).values({
      id: uuid(40),
      integrationId: uuid(20),
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    });
  });

  it('reads "3 of 3" and complete on Free, with data flows optional', async () => {
    const body = await productChecklist(FREE);
    expect(body).toMatchObject({
      product_id: P_ONE,
      product_slug: 'revit',
      done: 3,
      total: 3,
      complete: true,
      plan: { tier: 'unclaimed', status: null },
    });
    expect(body.steps).toEqual([
      { key: 'product_details', status: 'done', counts: true },
      { key: 'integration_list', status: 'done', counts: true },
      { key: 'claim_integrations', status: 'done', counts: true },
      { key: 'confirm_data_flows', status: 'optional', counts: false },
    ]);
  });

  it('reads "3 of 4" on Managed, with data flows to do', async () => {
    const body = await productChecklist(MANAGED);
    expect(body).toMatchObject({ done: 3, total: 4, complete: false, plan: { tier: 'verified' } });
    expect(body.steps[3]).toEqual({ key: 'confirm_data_flows', status: 'todo', counts: true });
  });

  it('reads "4 of 4" on Managed once the vendor answers the claim', async () => {
    await t.db.insert(attestations).values({
      id: uuid(60),
      claimId: uuid(40),
      source: 'vendor_a',
      asserted: true,
      attestedByVendorId: VENDOR,
    });
    expect(await productChecklist(MANAGED)).toMatchObject({ done: 4, total: 4, complete: true });
  });

  it('carries the same plan block and score into the vendor read', async () => {
    const free = await vendorChecklist(FREE);
    const one = free.products.find((p: JsonBody) => p.product_id === P_ONE);
    expect(one).toMatchObject({ product_slug: 'revit', done: 3, total: 3, complete: true });
    expect(one.plan).toEqual((await productChecklist(FREE)).plan);
    expect(one).not.toHaveProperty('steps');

    const managed = await vendorChecklist(MANAGED);
    expect(managed.products.find((p: JsonBody) => p.product_id === P_ONE)).toMatchObject({
      done: 3,
      total: 4,
      complete: false,
    });
  });
});

// ─── Check product details / Check the integration list ──────────────────────

describe('the two "Looks right" product steps', () => {
  it('are both to do on an untouched product', async () => {
    const body = await productChecklist(FREE);
    expect(stepStatus(body, 'product_details')).toBe('todo');
    expect(stepStatus(body, 'integration_list')).toBe('todo');
    expect(body).toMatchObject({ done: 1, total: 3, complete: false });
  });

  it('needs maintained_by = vendor as well as a review date for product details', async () => {
    await t.db
      .update(products)
      .set({ lastReviewedAt: SEEN, maintainedBy: 'aeci' })
      .where(eq(products.id, P_ONE));
    expect(stepStatus(await productChecklist(FREE), 'product_details')).toBe('todo');
  });

  it('completes the integration list from the product column alone', async () => {
    await t.db.update(products).set({ integrationsReviewedAt: SEEN }).where(eq(products.id, P_ONE));
    expect(stepStatus(await productChecklist(FREE), 'integration_list')).toBe('done');
  });
});

// ─── Claim or say "not ours" ─────────────────────────────────────────────────

describe('"Claim or say not ours"', () => {
  const claimStep = async (auth: AuthzVariables['auth'], id = P_ONE) =>
    stepStatus(await productChecklist(auth, id), 'claim_integrations');

  it('is to do while a seeded row naming the vendor is unclaimed', async () => {
    await t.db.insert(integrations).values(seededRow(uuid(20)));
    expect(await claimStep(FREE)).toBe('todo');
    expect(await claimStep(MANAGED)).toBe('todo');
  });

  it('counts the row against the product on either endpoint, and not against another', async () => {
    await t.db
      .insert(integrations)
      .values(seededRow(uuid(20), { sourceProductId: P_PARTNER, targetProductId: P_ONE }));
    expect(await claimStep(FREE, P_ONE)).toBe('todo');
    expect(await claimStep(FREE, P_TWO)).toBe('done');
  });

  it('is done once the row is claimed', async () => {
    await t.db
      .insert(integrations)
      .values(seededRow(uuid(20), { claimedAt: SEEN, maintainedBy: 'vendor' }));
    expect(await claimStep(FREE)).toBe('done');
  });

  it('ignores a row another vendor is named on', async () => {
    await t.db.insert(integrations).values(seededRow(uuid(20), { builtByVendorId: OTHER }));
    expect(await claimStep(FREE)).toBe('done');
  });

  it('ignores a row with no builder on file', async () => {
    await t.db.insert(integrations).values(seededRow(uuid(20), { builtByVendorId: null }));
    expect(await claimStep(FREE)).toBe('done');
  });

  it('ignores a row under an open owner contest', async () => {
    await t.db.insert(integrations).values(seededRow(uuid(20)));
    await t.db.insert(integrationFieldChallenges).values(ownerContest(uuid(70), uuid(20)));
    expect(await claimStep(FREE)).toBe('done');
  });

  it('counts the row again once that owner contest is declined', async () => {
    await t.db.insert(integrations).values(seededRow(uuid(20)));
    await t.db
      .insert(integrationFieldChallenges)
      .values(ownerContest(uuid(70), uuid(20), 'declined'));
    expect(await claimStep(FREE)).toBe('todo');
  });

  it('is not satisfied by an open contest on a different field', async () => {
    await t.db.insert(integrations).values(seededRow(uuid(20)));
    await t.db.insert(integrationFieldChallenges).values({
      ...ownerContest(uuid(70), uuid(20)),
      field: 'website',
      proposedValue: 'https://x.test',
    });
    expect(await claimStep(FREE)).toBe('todo');
  });

  it('counts the connector arm: a row the product powers', async () => {
    // P_TWO stands in as VENDOR's connector product here.
    await t.db.insert(integrations).values(
      seededRow(uuid(20), {
        sourceProductId: P_PARTNER,
        targetProductId: P_FOREIGN,
        poweredByProductId: P_TWO,
      }),
    );
    expect(await claimStep(MANAGED, P_TWO)).toBe('todo');
  });

  it('counts a connector-powered row on Managed only, since Free cannot claim it', async () => {
    await t.db
      .insert(integrations)
      .values(seededRow(uuid(20), { mechanismKind: 'iPaaS', poweredByProductId: P_BRIDGE }));
    expect(await claimStep(FREE)).toBe('done');
    expect(await claimStep(MANAGED)).toBe('todo');
  });

  it('counts an unclaimed evidenced pair on Managed only', async () => {
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(30),
      connectorProductId: P_BRIDGE,
      productAId: P_ONE,
      productBId: P_PARTNER,
      builtByVendorId: VENDOR,
    });
    expect(await claimStep(FREE)).toBe('done');
    expect(await claimStep(MANAGED)).toBe('todo');
  });

  it('ignores an evidenced pair under an open owner contest', async () => {
    await t.db.insert(connectorEvidencedPairs).values({
      id: uuid(30),
      connectorProductId: P_BRIDGE,
      productAId: P_ONE,
      productBId: P_PARTNER,
      builtByVendorId: VENDOR,
    });
    await t.db.insert(integrationFieldChallenges).values({
      ...ownerContest(uuid(70), uuid(20)),
      integrationId: null,
      evidencedPairId: uuid(30),
    });
    expect(await claimStep(MANAGED)).toBe('done');
  });
});

// ─── Confirm data flows ──────────────────────────────────────────────────────

describe('"Confirm data flows" on Managed', () => {
  const flowsStep = async (id = P_ONE) =>
    stepStatus(await productChecklist(MANAGED, id), 'confirm_data_flows');

  async function rowWithClaim(extra: Partial<typeof integrations.$inferInsert> = {}) {
    await t.db
      .insert(integrations)
      .values(seededRow(uuid(20), { claimedAt: SEEN, maintainedBy: 'vendor', ...extra }));
    await t.db.insert(claims).values({
      id: uuid(40),
      integrationId: uuid(20),
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    });
  }
  const attest = (extra: Partial<typeof attestations.$inferInsert> = {}) =>
    t.db.insert(attestations).values({
      id: uuid(60),
      claimId: uuid(40),
      source: 'vendor_a',
      asserted: true,
      attestedByVendorId: VENDOR,
      ...extra,
    });

  it('is done with no claims, the vacuous case', async () => {
    await t.db
      .insert(integrations)
      .values(seededRow(uuid(20), { claimedAt: SEEN, maintainedBy: 'vendor' }));
    expect(await flowsStep()).toBe('done');
  });

  it('is to do while a claim has no attestation by the vendor', async () => {
    await rowWithClaim();
    expect(await flowsStep()).toBe('todo');
  });

  it('is done by a denial too, because a denial is an answer', async () => {
    await rowWithClaim();
    await attest({ asserted: false });
    expect(await flowsStep()).toBe('done');
  });

  it('is to do again when the attestation is retracted', async () => {
    await rowWithClaim();
    await attest({ retractedAt: SEEN });
    expect(await flowsStep()).toBe('todo');
  });

  it('is not satisfied by the other vendor or by AECi', async () => {
    await rowWithClaim();
    await t.db.insert(attestations).values([
      { id: uuid(61), claimId: uuid(40), source: 'aeci', asserted: true },
      {
        id: uuid(62),
        claimId: uuid(40),
        source: 'vendor_b',
        asserted: true,
        attestedByVendorId: OTHER,
      },
    ]);
    expect(await flowsStep()).toBe('todo');
  });

  it('ignores a claim on a connector-powered row, which nobody may attest', async () => {
    await rowWithClaim({ mechanismKind: 'iPaaS', poweredByProductId: P_BRIDGE });
    expect(await flowsStep()).toBe('done');
  });

  it('ignores a claim on a retired row', async () => {
    await rowWithClaim({ retiredAt: SEEN, retiredBy: 'owner' });
    expect(await flowsStep()).toBe('done');
  });

  it('applies to the product on the other endpoint, and not to an unrelated one', async () => {
    await rowWithClaim({ sourceProductId: P_PARTNER, targetProductId: P_ONE });
    expect(await flowsStep(P_ONE)).toBe('todo');
    expect(await flowsStep(P_TWO)).toBe('done');
  });
});

// ─── The vendor steps ────────────────────────────────────────────────────────

describe('GET /api/vendor/checklist', () => {
  it('lists the vendor steps and every owned product, by name', async () => {
    const body = await vendorChecklist(FREE);
    expect(body.steps).toEqual([
      { key: 'company_details', status: 'todo', counts: true },
      { key: 'finish_products', status: 'todo', counts: true },
      { key: 'invite_colleague', status: 'optional', counts: false },
    ]);
    expect(body).toMatchObject({ done: 0, total: 2, complete: false });
    expect(body.products.map((p: JsonBody) => p.product_slug)).toEqual(['acc', 'revit']);
  });

  it('completes company details from the vendor row', async () => {
    await t.db
      .update(vendors)
      .set({ maintainedBy: 'vendor', lastReviewedAt: SEEN })
      .where(eq(vendors.id, VENDOR));
    expect(stepStatus(await vendorChecklist(FREE), 'company_details')).toBe('done');
  });

  it('finishes products only when every product is complete', async () => {
    await checkProduct(P_ONE);
    expect(stepStatus(await vendorChecklist(FREE), 'finish_products')).toBe('todo');
    await checkProduct(P_TWO);
    const body = await vendorChecklist(FREE);
    expect(stepStatus(body, 'finish_products')).toBe('done');
    expect(body.products.every((p: JsonBody) => p.complete)).toBe(true);
  });

  it('finishes products vacuously for a vendor with none', async () => {
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR));
    const body = await vendorChecklist(FREE);
    expect(body.products).toEqual([]);
    expect(stepStatus(body, 'finish_products')).toBe('done');
  });

  it('marks the invite done for any invite row, even a revoked one', async () => {
    await t.db.insert(vendorSeatInvites).values({
      vendorId: VENDOR,
      email: 'colleague@autodesk.test',
      expiresAt: SEEN,
      revokedAt: SEEN,
    });
    expect(stepStatus(await vendorChecklist(FREE), 'invite_colleague')).toBe('done');
  });

  it('marks the invite done for a second seat', async () => {
    await t.db.insert(profiles).values({ id: uuid(102), role: 'vendor_admin', vendorId: VENDOR });
    expect(stepStatus(await vendorChecklist(FREE), 'invite_colleague')).toBe('done');
  });

  it('does not count a reviewer profile pointing at the vendor as a seat', async () => {
    await t.db.insert(profiles).values({ id: uuid(102), role: 'reviewer', vendorId: VENDOR });
    expect(stepStatus(await vendorChecklist(FREE), 'invite_colleague')).toBe('optional');
  });

  it('answers 404 when the seat outlived its vendor row', async () => {
    const { status } = await get({ ...FREE, vendorId: uuid(9) }, '/api/vendor/checklist');
    expect(status).toBe(404);
  });

  it('is private and never stored, like every vendor read', async () => {
    const { res } = await get(FREE, '/api/vendor/checklist');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

// ─── Ownership ───────────────────────────────────────────────────────────────

describe('GET /api/vendor/products/:id/checklist ownership', () => {
  it.each([
    ['another vendor product', P_FOREIGN],
    ['an unknown id', uuid(999)],
  ])('answers a flat 404 for %s', async (_label, id) => {
    const { status, body } = await get(MANAGED, `/api/vendor/products/${id}/checklist`);
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('reads nothing about a foreign product past the ownership wave', async () => {
    const spy = vi.spyOn(t.raw, 'prepare');
    await get(MANAGED, `/api/vendor/products/${P_FOREIGN}/checklist`);
    const facts = spy.mock.calls.map((c) => String(c[0])).filter((s) => /from "claims"/i.test(s));
    expect(facts).toEqual([]);
    spy.mockRestore();
  });

  it('is private and never stored', async () => {
    const { res } = await get(FREE, `/api/vendor/products/${P_ONE}/checklist`);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

// ─── Batching ────────────────────────────────────────────────────────────────

describe('batching', () => {
  /** Give VENDOR `n` more products, each with a seeded row and a claim on it. */
  async function addProducts(n: number, from: number) {
    for (let i = 0; i < n; i++) {
      const productId = uuid(from + i);
      const integrationId = uuid(from + 1000 + i);
      await t.db.insert(products).values({ id: productId, slug: `p-${from + i}`, name: `P ${i}` });
      await t.db.insert(productVendors).values({ productId, vendorId: VENDOR, isPrimary: true });
      await t.db
        .insert(integrations)
        .values(seededRow(integrationId, { sourceProductId: productId }));
      await t.db.insert(claims).values({
        id: uuid(from + 2000 + i),
        integrationId,
        dataObjectId: DO_RFIS,
        direction: 'a_to_b',
      });
    }
  }

  async function statementsFor(path: string): Promise<number> {
    const spy = vi.spyOn(t.raw, 'prepare');
    const { status } = await get(MANAGED, path);
    expect(status).toBe(200);
    const n = spy.mock.calls.length;
    spy.mockRestore();
    return n;
  }

  it('costs the same number of statements for two products as for twelve', async () => {
    const two = await statementsFor('/api/vendor/checklist');
    await addProducts(10, 3000);
    const body = await vendorChecklist(MANAGED);
    expect(body.products).toHaveLength(12);
    // Each added product has one unclaimed row, so none is complete. This proves
    // the twelve-product read attributed rows rather than returning empty facts.
    expect(body.products.filter((p: JsonBody) => p.complete)).toHaveLength(0);
    expect(await statementsFor('/api/vendor/checklist')).toBe(two);
  });

  it('runs seven statements for the vendor read', async () => {
    await addProducts(4, 3000);
    expect(await statementsFor('/api/vendor/checklist')).toBe(7);
  });

  it('runs the ownership wave plus three fact reads for the product read', async () => {
    expect(await statementsFor(`/api/vendor/products/${P_ONE}/checklist`)).toBe(6);
  });
});
