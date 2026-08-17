/**
 * Unit coverage for the attestation-authority seam (AECI-603 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §2).
 *
 * This helper is the authorization for every §5 write — there is no RLS on app tables,
 * so a wrong answer here is a wrong answer about who may speak for a product. Its
 * failure modes are asymmetric: a false positive lets a vendor attest on an integration
 * it does not own (forging one half of a "Vendor-confirmed" signal), and a 403-shaped
 * miss leaks that another vendor's integration exists. Both are pinned below,
 * including the property that "owns neither endpoint" and "no such integration" are
 * *indistinguishable* to the caller.
 *
 * The two schema facts the §2.1 table exists for are covered explicitly: a vendor owning
 * BOTH endpoints gets both slots, and two vendor accounts owning the same product both
 * resolve the same slot.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { Db } from '../db/client';
import { integrations, productVendors, products, vendors } from '../db/schema';
import { ApiError } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  assertClaimProvenance,
  claimProvenance,
  resolveAttestationSlots,
  resolveAttestationSlotsForVendor,
  slotsForOwnership,
  vendorsForIntegrationSlots,
} from './attestation-authority';

const V_SOURCE = '11111111-1111-4111-8111-111111111111';
const V_TARGET = '22222222-2222-4222-8222-222222222222';
const V_BOTH = '33333333-3333-4333-8333-333333333333';
const V_OUTSIDER = '44444444-4444-4444-8444-444444444444';
/** A second account's vendor that co-owns the SOURCE product (`product_vendors` is m2m). */
const V_CO_OWNER = '55555555-5555-4555-8555-555555555555';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V_SOURCE, slug: 'autodesk', companyName: 'Autodesk' },
    { id: V_TARGET, slug: 'bentley', companyName: 'Bentley' },
    { id: V_BOTH, slug: 'procore', companyName: 'Procore' },
    { id: V_OUTSIDER, slug: 'deltek', companyName: 'Deltek' },
    { id: V_CO_OWNER, slug: 'trimble', companyName: 'Trimble' },
  ]);
  await t.db.insert(products).values([
    { id: 'p-src', slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: 'p-tgt', slug: 'navisworks', name: 'Navisworks', promotionStatus: 'promoted' },
    { id: 'p-own-a', slug: 'procore-a', name: 'Procore A', promotionStatus: 'promoted' },
    { id: 'p-own-b', slug: 'procore-b', name: 'Procore B', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(integrations).values([
    // i-main: endpoint A = p-src (V_SOURCE + V_CO_OWNER), endpoint B = p-tgt (V_TARGET).
    { id: 'i-main', sourceProductId: 'p-src', targetProductId: 'p-tgt' },
    // i-intra: both endpoints owned by the SAME vendor — the §2.1 both-endpoints case.
    { id: 'i-intra', sourceProductId: 'p-own-a', targetProductId: 'p-own-b' },
    // i-foreign: touches neither p-src nor p-tgt owners.
    { id: 'i-foreign', sourceProductId: 'p-own-a', targetProductId: 'p-tgt' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: 'p-src', vendorId: V_SOURCE },
    { productId: 'p-src', vendorId: V_CO_OWNER, isPrimary: false },
    { productId: 'p-tgt', vendorId: V_TARGET },
    { productId: 'p-own-a', vendorId: V_BOTH },
    { productId: 'p-own-b', vendorId: V_BOTH },
  ]);
});
afterEach(() => t.dispose());

/** Await a call expected to reject, and hand back the `ApiError` it threw. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('slotsForOwnership', () => {
  it('maps the §2.1 ownership table, source before target', () => {
    expect(slotsForOwnership(true, false)).toEqual(['vendor_a']);
    expect(slotsForOwnership(false, true)).toEqual(['vendor_b']);
    expect(slotsForOwnership(true, true)).toEqual(['vendor_a', 'vendor_b']);
    expect(slotsForOwnership(false, false)).toEqual([]);
  });
});

describe('resolveAttestationSlots', () => {
  it('gives vendor_a to the source-product owner, with both endpoint ids', async () => {
    const authority = await resolveAttestationSlots(t.db, V_SOURCE, 'i-main');
    expect(authority).toEqual({
      integrationId: 'i-main',
      sourceProductId: 'p-src',
      targetProductId: 'p-tgt',
      slots: ['vendor_a'],
    });
  });

  it('gives vendor_b to the target-product owner', async () => {
    const authority = await resolveAttestationSlots(t.db, V_TARGET, 'i-main');
    expect(authority.slots).toEqual(['vendor_b']);
  });

  it('gives BOTH slots when one vendor owns both endpoints', async () => {
    // `product_vendors` is many-to-many, so this is reachable — an intra-portfolio
    // integration. §4 is what stops it rendering as bilateral agreement; the helper's
    // job is only to say the vendor may write both slots.
    const authority = await resolveAttestationSlots(t.db, V_BOTH, 'i-intra');
    expect(authority.slots).toEqual(['vendor_a', 'vendor_b']);
  });

  it('404s — not 403s — when the vendor owns neither endpoint', async () => {
    // A 403 would confirm the integration exists. `routes/vendor.ts`'s non-disclosure
    // rule (AECI-520): a vendor must not be able to probe another vendor's surface.
    const err = await rejection(resolveAttestationSlots(t.db, V_OUTSIDER, 'i-main'));
    expect(err.status).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toEqual({ resource: 'integration', id: 'i-main' });
  });

  it('answers a nonexistent integration IDENTICALLY to one the vendor does not own', async () => {
    // The indistinguishability IS the security property — if these two ever diverge,
    // the 404 becomes an existence oracle. Everything but the echoed id must match.
    const notOwned = await rejection(resolveAttestationSlots(t.db, V_OUTSIDER, 'i-main'));
    const ghost = await rejection(resolveAttestationSlots(t.db, V_SOURCE, 'i-ghost'));
    expect(ghost.status).toBe(notOwned.status);
    expect(ghost.code).toBe(notOwned.code);
    expect(notOwned.message).toBe('integration not found: i-main');
    expect(ghost.message).toBe('integration not found: i-ghost');
    expect(ghost.details).toEqual({ resource: 'integration', id: 'i-ghost' });
  });

  it('resolves the same slot for two different vendors owning the same product', async () => {
    // `profiles.vendor_id` is many-to-one and `product_vendors` is many-to-many, so two
    // identities can target one slot. The helper does not arbitrate — the
    // `attestations_slot_key` partial unique index makes it last-write-wins.
    const first = await resolveAttestationSlots(t.db, V_SOURCE, 'i-main');
    const second = await resolveAttestationSlots(t.db, V_CO_OWNER, 'i-main');
    expect(first.slots).toEqual(['vendor_a']);
    expect(second.slots).toEqual(['vendor_a']);
  });

  it('scopes per integration — owning one endpoint elsewhere grants nothing here', async () => {
    // V_BOTH owns p-own-a, which is i-foreign's SOURCE — so it gets vendor_a there…
    expect((await resolveAttestationSlots(t.db, V_BOTH, 'i-foreign')).slots).toEqual(['vendor_a']);
    // …but owning p-own-a says nothing about i-main.
    await expect(resolveAttestationSlots(t.db, V_BOTH, 'i-main')).rejects.toThrow(
      'integration not found',
    );
  });
});

describe('resolveAttestationSlotsForVendor', () => {
  it('returns the whole attestable surface when no scope is given', async () => {
    const map = await resolveAttestationSlotsForVendor(t.db, V_BOTH);
    expect([...map.keys()].sort()).toEqual(['i-foreign', 'i-intra']);
    expect(map.get('i-intra')?.slots).toEqual(['vendor_a', 'vendor_b']);
    expect(map.get('i-foreign')?.slots).toEqual(['vendor_a']);
  });

  it('scopes to the requested ids and silently omits non-owned ones', async () => {
    // A list endpoint filters by lookup rather than by catching — only the
    // single-integration form owns the 404.
    const map = await resolveAttestationSlotsForVendor(t.db, V_TARGET, {
      integrationIds: ['i-main', 'i-intra', 'i-does-not-exist'],
    });
    expect([...map.keys()]).toEqual(['i-main']);
    expect(map.get('i-main')?.slots).toEqual(['vendor_b']);
  });

  it('returns an empty map for a vendor that owns nothing', async () => {
    expect(await resolveAttestationSlotsForVendor(t.db, V_OUTSIDER)).toEqual(new Map());
  });

  it('short-circuits an empty explicit scope without touching D1', async () => {
    // Load-bearing, not an optimization: Drizzle's `inArray` with `[]` emits degenerate
    // SQL. A db that throws on any query proves the short-circuit runs first.
    const exploding = {
      select: () => {
        throw new Error('resolveAttestationSlotsForVendor queried D1 for an empty scope');
      },
    } as unknown as Db;
    expect(
      await resolveAttestationSlotsForVendor(exploding, V_SOURCE, { integrationIds: [] }),
    ).toEqual(new Map());
  });

  it('de-duplicates the requested ids', async () => {
    const map = await resolveAttestationSlotsForVendor(t.db, V_SOURCE, {
      integrationIds: ['i-main', 'i-main', 'i-main'],
    });
    expect(map.size).toBe(1);
  });
});

describe('claimProvenance', () => {
  it('pairs a vendor id with origin=vendor', () => {
    expect(claimProvenance(V_SOURCE)).toEqual({ origin: 'vendor', createdByVendorId: V_SOURCE });
  });

  it('pairs an absent vendor with origin=aeci (promote and every legacy row)', () => {
    expect(claimProvenance(null)).toEqual({ origin: 'aeci', createdByVendorId: null });
    expect(claimProvenance(undefined)).toEqual({ origin: 'aeci', createdByVendorId: null });
    // An empty string is not an id — it must not produce a 'vendor' row with no vendor.
    expect(claimProvenance('')).toEqual({ origin: 'aeci', createdByVendorId: null });
  });
});

describe('assertClaimProvenance', () => {
  it('accepts both legal combinations', () => {
    expect(() => assertClaimProvenance({ origin: 'aeci', createdByVendorId: null })).not.toThrow();
    expect(() =>
      assertClaimProvenance({ origin: 'vendor', createdByVendorId: V_SOURCE }),
    ).not.toThrow();
  });

  it('rejects origin=vendor with no vendor id', () => {
    // The §2.2 biconditional is application-enforced, so this assertion is the only
    // thing standing between a hand-assembled write and an unattributable vendor claim.
    expect(() => assertClaimProvenance({ origin: 'vendor', createdByVendorId: null })).toThrow(
      /provenance invariant violated/,
    );
  });

  it('rejects origin=aeci carrying a vendor id', () => {
    expect(() => assertClaimProvenance({ origin: 'aeci', createdByVendorId: V_SOURCE })).toThrow(
      /provenance invariant violated/,
    );
  });

  it('raises a 500, not a validation error — it is a programming fault, not bad input', () => {
    const err = (() => {
      try {
        assertClaimProvenance({ origin: 'vendor', createdByVendorId: null });
      } catch (e) {
        return e as ApiError;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.status).toBe(500);
    expect(err?.code).toBe('INTERNAL_ERROR');
  });
});

// ─── The inverse lookup (§7 / AECI-302) ──────────────────────────────────────

describe('vendorsForIntegrationSlots', () => {
  it('returns nothing for an empty scope, without querying', async () => {
    expect(await vendorsForIntegrationSlots(t.db as Db, [])).toEqual(new Map());
  });

  it('maps each slot to the vendors that own that endpoint', async () => {
    const map = await vendorsForIntegrationSlots(t.db as Db, ['i-main']);
    expect(map.get('i-main')?.slots).toEqual({
      // p-src is co-owned, so the A slot has two vendors — the m2m case the
      // detectors must nudge in full rather than picking one.
      vendor_a: [V_SOURCE, V_CO_OWNER].sort(),
      vendor_b: [V_TARGET],
    });
  });

  it('puts a both-endpoints vendor in BOTH slots (the §2.1 intra-portfolio case)', async () => {
    const map = await vendorsForIntegrationSlots(t.db as Db, ['i-intra']);
    expect(map.get('i-intra')?.slots).toEqual({ vendor_a: [V_BOTH], vendor_b: [V_BOTH] });
  });

  it('leaves a slot empty when nobody has claimed that product', async () => {
    await t.db.insert(products).values({ id: 'p-orphan', slug: 'orphan', name: 'Orphan' });
    await t.db
      .insert(integrations)
      .values({ id: 'i-orphan', sourceProductId: 'p-src', targetProductId: 'p-orphan' });

    const map = await vendorsForIntegrationSlots(t.db as Db, ['i-orphan']);
    // An unclaimed endpoint has nobody to nudge — an empty slot, not an error, and
    // never a 404: this runs from a cron with no caller to disclose anything to.
    expect(map.get('i-orphan')?.slots.vendor_b).toEqual([]);
  });

  it('is the mirror of resolveAttestationSlotsForVendor', async () => {
    const forward = await resolveAttestationSlotsForVendor(t.db as Db, V_SOURCE);
    const inverse = await vendorsForIntegrationSlots(t.db as Db, [...forward.keys()]);

    for (const [integrationId, authority] of forward) {
      for (const slot of authority.slots) {
        expect(inverse.get(integrationId)?.slots[slot]).toContain(V_SOURCE);
      }
    }
  });

  it('carries both endpoint product ids, like the forward resolver', async () => {
    const entry = (await vendorsForIntegrationSlots(t.db as Db, ['i-main'])).get('i-main');
    expect(entry).toMatchObject({
      integrationId: 'i-main',
      sourceProductId: 'p-src',
      targetProductId: 'p-tgt',
    });
  });
});
