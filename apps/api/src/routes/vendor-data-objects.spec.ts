/**
 * `GET /api/vendor/data-objects` (AECI-606 / `STAGE_2_ATTESTATIONS_SPEC.md` §6).
 *
 * Per the repo split, this spec stubs `c.set('auth', …)` and exercises the
 * handler; the real `requireVendor()` guard cells live in
 * `vendor.authz-matrix.spec.ts`.
 *
 * Three assertions here are guards rather than coverage:
 *
 *  - **The exact key set.** `aliases` / `id` / `display_order` are withheld on
 *    purpose (see `DataObjectOptionSchema`). Asserting the key set, not just the
 *    presence of the ones we want, is what makes a later "just add aliases so we
 *    can filter client-side" fail here rather than ship.
 *  - **NULL `display_order` sorts LAST.** SQLite sorts NULLs first; the claim
 *    ordering in `vendor-attestations.ts` coerces null to `MAX_SAFE_INTEGER` and
 *    therefore sorts them last. All 27 seeded terms carry an order, so a
 *    divergence would be invisible until someone hand-inserted a row. This pins
 *    the *wire* order, which the dashboard picker no longer renders directly —
 *    it alphabetizes by label client-side (`vendor-add-claim-form.ts`) — so this
 *    assertion is what keeps the endpoint's own contract defined.
 *  - **Two vendors get identical bodies.** The one `/api/vendor/*` route with no
 *    `vendor_id` filter, deliberately. Pinning the sameness means a later
 *    "restore the missing scope filter" edit fails loudly instead of reading as
 *    a fix.
 */

import { ListDataObjectsResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { taxonomyDataObjects, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createListDataObjectsHandler } from './vendor-data-objects';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const SEAT = uuid(100);

let t: TestDb;

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'ops@autodesk.test',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'autodesk', companyName: 'Autodesk' },
    { id: OTHER_VENDOR, slug: 'bentley', companyName: 'Bentley' },
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth'] = AUTH) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/data-objects', createListDataObjectsHandler(t.factory));
  return a;
}

async function get(auth?: AuthzVariables['auth']) {
  const res = await app(auth).request(
    '/api/vendor/data-objects',
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { res, body: (await res.json()) as { data_objects: Record<string, unknown>[] } };
}

/** Seed a vocabulary row. `aliases` is always populated so the "never on the
 *  wire" assertion is testing an exclusion rather than an absence. */
async function term(over: {
  n: number;
  slug: string;
  name?: string;
  description?: string | null;
  displayOrder?: number | null;
}) {
  await t.db.insert(taxonomyDataObjects).values({
    id: uuid(over.n),
    slug: over.slug,
    name: over.name ?? over.slug.toUpperCase(),
    description: over.description === undefined ? `The ${over.slug} flow.` : over.description,
    displayOrder: over.displayOrder === undefined ? null : over.displayOrder,
    aliases: ['Alias One', 'Alias Two'],
  });
}

describe('GET /api/vendor/data-objects', () => {
  it('returns an empty list rather than a 500 when the vocabulary is unseeded', async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body.data_objects).toEqual([]);
  });

  it('returns slug / name / description and nothing else', async () => {
    await term({ n: 10, slug: 'rfis', name: 'RFIs', displayOrder: 110 });

    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body.data_objects).toHaveLength(1);
    // The key set, not just the values: `aliases`, `id` and `display_order` are
    // withheld by contract, and this is what enforces it.
    expect(Object.keys(body.data_objects[0]).sort()).toEqual(['description', 'name', 'slug']);
    expect(body.data_objects[0]).toEqual({
      slug: 'rfis',
      name: 'RFIs',
      description: 'The rfis flow.',
    });
  });

  it('carries a null description through', async () => {
    await term({ n: 10, slug: 'rfis', description: null, displayOrder: 110 });

    const { body } = await get();

    expect(body.data_objects[0].description).toBeNull();
  });

  it('orders by display_order, then slug as the tie-break', async () => {
    // Inserted out of order, and two share a display_order so the tie-break is
    // exercised rather than incidentally satisfied.
    await term({ n: 12, slug: 'submittals', displayOrder: 120 });
    await term({ n: 11, slug: 'drawings', displayOrder: 20 });
    await term({ n: 13, slug: 'costs', displayOrder: 120 });
    await term({ n: 10, slug: 'models', displayOrder: 10 });

    const { body } = await get();

    expect(body.data_objects.map((d) => d.slug)).toEqual([
      'models', // 10
      'drawings', // 20
      'costs', // 120, tie-break by slug
      'submittals', // 120
    ]);
  });

  it('sorts a null display_order LAST, matching the claim ordering', async () => {
    // SQLite sorts NULLs first by default; `createListVendorIntegrationsHandler`
    // coerces null to MAX_SAFE_INTEGER and sorts them last. If these two ever
    // disagree, the picker's rows and the tab's lanes disagree.
    await term({ n: 11, slug: 'unordered', displayOrder: null });
    await term({ n: 10, slug: 'models', displayOrder: 10 });

    const { body } = await get();

    expect(body.data_objects.map((d) => d.slug)).toEqual(['models', 'unordered']);
  });

  it('returns an identical body to a different vendor — the route is deliberately unscoped', async () => {
    await term({ n: 10, slug: 'models', displayOrder: 10 });
    await term({ n: 11, slug: 'rfis', displayOrder: 110 });

    const mine = await get();
    const theirs = await get({ ...AUTH, userId: uuid(101), vendorId: OTHER_VENDOR });

    expect(theirs.res.status).toBe(200);
    expect(theirs.body).toEqual(mine.body);
  });

  it('serves an unverified vendor — reading the vocabulary is not the gated capability', async () => {
    await t.db.insert(vendors).values({
      id: uuid(3),
      slug: 'unverified-co',
      companyName: 'Unverified Co',
      verified: false,
    });
    await term({ n: 10, slug: 'models', displayOrder: 10 });

    const { res, body } = await get({ ...AUTH, userId: uuid(102), vendorId: uuid(3) });

    expect(res.status).toBe(200);
    expect(body.data_objects.map((d) => d.slug)).toEqual(['models']);
  });

  it('emits a body the shared response schema accepts', async () => {
    await term({ n: 10, slug: 'models', displayOrder: 10 });
    await term({ n: 11, slug: 'unordered', displayOrder: null });

    const { body } = await get();

    expect(() => ListDataObjectsResponseSchema.parse(body)).not.toThrow();
  });
});
