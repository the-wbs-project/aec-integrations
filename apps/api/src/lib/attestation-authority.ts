/**
 * "Which attestation slot is this caller's?" — the single definition
 * (AECI-603 / `STAGE_2_ATTESTATIONS_SPEC.md` §2).
 *
 * Stage 1.5 reserved `attestations.source IN ('aeci','vendor_a','vendor_b')` but never
 * said who may write `vendor_a` versus `vendor_b`. This module is that rule. Authority
 * derives from **product ownership**, never from anything the client sends — the
 * AECI-520 `vendor_id`-scoping invariant extended to a two-slot model. `vendor_a` /
 * `vendor_b` are the integration's endpoint-A / endpoint-B vendors, where
 * **A = `integrations.source_product_id`** and **B = `target_product_id`**
 * (`STAGE_1_5_SPEC.md` §3.2), and ownership lives in `product_vendors`:
 *
 *   | `product_vendors` row exists for…      | may attest      |
 *   | -------------------------------------- | --------------- |
 *   | the integration's `source_product_id`  | `vendor_a`      |
 *   | the integration's `target_product_id`  | `vendor_b`      |
 *   | **both** endpoints                     | **both** slots  |
 *   | neither                                | **404**, not 403 |
 *
 * **404, not 403** is the non-disclosure rule (`routes/vendor.ts` header): a vendor must
 * not be able to probe for the existence of another vendor's integration. So
 * `resolveAttestationSlots` answers "you own neither endpoint" and "no such integration"
 * *identically* — that indistinguishability is the security property, not an accident of
 * the implementation. Callers must run it in its own wave, before any other read or
 * write, so a validation error can never win a `Promise.all` race and answer a request
 * that should have been a flat 404 (the reason spelled out on
 * `createUpdateVendorProductHandler`).
 *
 * Two schema facts make the rule non-trivial and are why the seam exists at all:
 * `product_vendors` is many-to-many, so one vendor can own **both** endpoints of an
 * integration; and `profiles.vendor_id` is many-to-one, so two accounts can target the
 * same slot. Neither is resolved here — they are resolved *downstream*, and both
 * downstream rules depend on this one being computed in exactly one place:
 *
 *   - §4 narrows `confirmed` to two **distinct** `attested_by_vendor_id` values, so a
 *     company owning both endpoints affirming both slots still renders `single_source`.
 *   - The `attestations_slot_key` partial unique index makes two accounts on the same
 *     vendor last-write-wins on a slot instead of stacking duplicate votes.
 *
 * Every §5 write path and every §7 detector resolves through this module; nothing
 * re-derives the rule inline. That includes the *inverse* lookup §7 needs (slot → which
 * vendors occupy it, for notification recipients): `vendorsForIntegrationSlots`
 * (AECI-302) is a different query — it has no vendor to filter on — but it folds its
 * rows through the same `slotsForOwnership`, so the §2.1 table has one implementation.
 *
 * The claim-provenance invariant lives here too, for the same reason: it is the other
 * half of "who may write what", and it is enforced in application code by deliberate
 * choice (§2.2 — a two-column D1 CHECK is possible, but the rule belongs in one place).
 */

import { and, eq, inArray, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrations, productVendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';

/** The two vendor-writable `attestations.source` values (`STAGE_1_5_SPEC.md` §3.3). */
export const ATTESTATION_SLOTS = ['vendor_a', 'vendor_b'] as const;

export type AttestationSlot = (typeof ATTESTATION_SLOTS)[number];

/** One integration a vendor may attest on, with the slots that vendor owns. */
export interface AttestationAuthority {
  integrationId: string;
  /** Endpoint A — `integrations.source_product_id`. Maps to the `vendor_a` slot. */
  sourceProductId: string;
  /** Endpoint B — `integrations.target_product_id`. Maps to the `vendor_b` slot. */
  targetProductId: string;
  /** Never empty: an entry only exists when the vendor owns at least one endpoint. */
  slots: readonly AttestationSlot[];
}

/**
 * The §2.1 rule itself, as a pure function over the two ownership booleans. Exported so
 * §7's inverse lookup and any future caller share this table rather than restating it.
 * Slot order is stable (`vendor_a` before `vendor_b`) so callers can compare arrays.
 */
export function slotsForOwnership(ownsSource: boolean, ownsTarget: boolean): AttestationSlot[] {
  const slots: AttestationSlot[] = [];
  if (ownsSource) slots.push('vendor_a');
  if (ownsTarget) slots.push('vendor_b');
  return slots;
}

/**
 * One query for both public entry points, so the rule is computed once.
 *
 * One join rather than two round trips (fetch the integration, then probe ownership):
 * the Worker pays for every D1 hop, and folding both into a single INNER JOIN also
 * collapses "integration does not exist" and "vendor owns neither endpoint" into the
 * same empty result — which is exactly the answer the 404 rule wants, with no branch
 * that could accidentally distinguish them. `integrationIds` omitted means "the caller's
 * whole attestable surface" (the §5 list endpoint); passing it scopes to those ids.
 */
async function loadAuthorities(
  db: Db,
  vendorId: string,
  integrationIds?: readonly string[],
): Promise<Map<string, AttestationAuthority>> {
  const scope = integrationIds && [...new Set(integrationIds)];
  // Drizzle's `inArray` with `[]` emits degenerate SQL, and an empty explicit scope has
  // one correct answer anyway — so short-circuit rather than query.
  if (scope && scope.length === 0) return new Map();

  const rows = await db
    .select({
      integrationId: integrations.id,
      sourceProductId: integrations.sourceProductId,
      targetProductId: integrations.targetProductId,
      ownedProductId: productVendors.productId,
    })
    .from(integrations)
    // INNER, not LEFT: a row only matters when the caller owns one of the endpoints.
    // The join predicate carries the vendor filter so a non-owned integration produces
    // no rows at all — see the 404 note in the header.
    .innerJoin(
      productVendors,
      and(
        eq(productVendors.vendorId, vendorId),
        or(
          eq(productVendors.productId, integrations.sourceProductId),
          eq(productVendors.productId, integrations.targetProductId),
        ),
      ),
    )
    .where(scope ? inArray(integrations.id, scope) : undefined);

  // An integration whose endpoints the vendor owns BOTH yields two rows — fold them.
  const owned = new Map<string, { row: (typeof rows)[number]; productIds: Set<string> }>();
  for (const row of rows) {
    const entry = owned.get(row.integrationId);
    if (entry) entry.productIds.add(row.ownedProductId);
    else owned.set(row.integrationId, { row, productIds: new Set([row.ownedProductId]) });
  }

  const out = new Map<string, AttestationAuthority>();
  for (const [integrationId, { row, productIds }] of owned) {
    out.set(integrationId, {
      integrationId,
      sourceProductId: row.sourceProductId,
      targetProductId: row.targetProductId,
      slots: slotsForOwnership(
        productIds.has(row.sourceProductId),
        productIds.has(row.targetProductId),
      ),
    });
  }
  return out;
}

/**
 * Resolve the caller's permitted slots on ONE integration.
 *
 * Throws `notFoundError('integration', …)` — a **404, never a 403** — both when the
 * vendor owns neither endpoint and when the integration does not exist. Run it before
 * any other read or write on the request, in its own wave.
 */
export async function resolveAttestationSlots(
  db: Db,
  vendorId: string,
  integrationId: string,
): Promise<AttestationAuthority> {
  const authority = (await loadAuthorities(db, vendorId, [integrationId])).get(integrationId);
  if (!authority) throw notFoundError('integration', { id: integrationId });
  return authority;
}

/**
 * The batched variant — one query for many integrations (§5's list endpoint, §7's
 * detector sweep). Omit `integrationIds` for the caller's entire attestable surface;
 * pass it to scope to a known set.
 *
 * Never throws: integrations the vendor does not own are simply absent from the map, so
 * a list endpoint filters by lookup instead of by catching. The single-integration form
 * above is the one that owns the 404.
 */
export async function resolveAttestationSlotsForVendor(
  db: Db,
  vendorId: string,
  opts?: { integrationIds?: readonly string[] },
): Promise<Map<string, AttestationAuthority>> {
  return loadAuthorities(db, vendorId, opts?.integrationIds);
}

// ─────────────────────── The inverse lookup: slot → vendors (§7) ───────────────────────

/** Which vendors occupy each slot of one integration. Either slot may be empty — an
 *  unclaimed product simply has no `product_vendors` row, and that *is* the signal
 *  `silent-counterparty` reads (nobody to nudge). Vendor ids are sorted so a caller's
 *  output is deterministic. */
export interface IntegrationSlotVendors {
  integrationId: string;
  sourceProductId: string;
  targetProductId: string;
  slots: Readonly<Record<AttestationSlot, readonly string[]>>;
}

/**
 * The §7 detector sweep's inverse of {@link resolveAttestationSlotsForVendor}: given
 * integrations, which vendors sit in `vendor_a` / `vendor_b`?
 *
 * The two directions cannot share a query — this one has no vendor to filter on, which
 * is the whole point — but they **must** share the §2.1 ownership table, so both fold
 * their rows through `slotsForOwnership`. The 404 non-disclosure rule does not apply
 * here: this runs from a cron with no caller to disclose anything to, so an unowned
 * endpoint is an empty slot rather than an error.
 */
export async function vendorsForIntegrationSlots(
  db: Db,
  integrationIds: readonly string[],
): Promise<Map<string, IntegrationSlotVendors>> {
  const scope = [...new Set(integrationIds)];
  // Same short-circuit as `loadAuthorities`: `inArray` with `[]` emits degenerate SQL.
  if (scope.length === 0) return new Map();

  const rows = await db
    .select({
      integrationId: integrations.id,
      sourceProductId: integrations.sourceProductId,
      targetProductId: integrations.targetProductId,
      ownedProductId: productVendors.productId,
      vendorId: productVendors.vendorId,
    })
    .from(integrations)
    .innerJoin(
      productVendors,
      or(
        eq(productVendors.productId, integrations.sourceProductId),
        eq(productVendors.productId, integrations.targetProductId),
      ),
    )
    .where(inArray(integrations.id, scope));

  const acc = new Map<string, { row: (typeof rows)[number]; a: Set<string>; b: Set<string> }>();
  for (const row of rows) {
    let entry = acc.get(row.integrationId);
    if (!entry) {
      entry = { row, a: new Set(), b: new Set() };
      acc.set(row.integrationId, entry);
    }
    // One ownership row at a time — a vendor owning BOTH endpoints arrives as two rows
    // and lands in both slots, which is exactly §2.1's both-endpoints case.
    for (const slot of slotsForOwnership(
      row.ownedProductId === row.sourceProductId,
      row.ownedProductId === row.targetProductId,
    )) {
      (slot === 'vendor_a' ? entry.a : entry.b).add(row.vendorId);
    }
  }

  const out = new Map<string, IntegrationSlotVendors>();
  for (const [integrationId, { row, a, b }] of acc) {
    out.set(integrationId, {
      integrationId,
      sourceProductId: row.sourceProductId,
      targetProductId: row.targetProductId,
      slots: { vendor_a: [...a].sort(), vendor_b: [...b].sort() },
    });
  }
  return out;
}

// ───────────────────────────── Claim provenance (§2.2) ─────────────────────────────

/**
 * The `claims.origin` / `claims.created_by_vendor_id` pair, as a type that cannot
 * express the illegal combinations. `origin` is for **write arbitration** (§3 filters
 * promote's deletes on it) and the AECi ops view — it is explicitly not a reader-facing
 * trust badge, and a vendor-created claim renders through the same §4 agreement states
 * as an AECi-seeded one.
 */
export type ClaimProvenance =
  | { origin: 'aeci'; createdByVendorId: null }
  | { origin: 'vendor'; createdByVendorId: string };

/**
 * Build the provenance pair from the writing vendor (or `null` for AECi/promote).
 *
 * Prefer this over assembling the two columns by hand: it makes
 * `origin = 'vendor' ⟺ created_by_vendor_id IS NOT NULL` unrepresentable-wrong rather
 * than merely checked. The invariant is application-enforced by choice (§2.2) — D1 could
 * carry a two-column CHECK, but the rule belongs in one place.
 */
export function claimProvenance(vendorId: string | null | undefined): ClaimProvenance {
  return vendorId
    ? { origin: 'vendor', createdByVendorId: vendorId }
    : { origin: 'aeci', createdByVendorId: null };
}

/**
 * Defence in depth for paths that assemble the pair by hand (promote's ingest, a
 * migration backfill, a future admin tool). A violation is a programming error, not
 * bad client input, so it surfaces as a 500 rather than a validation failure — it must
 * be loud and it must never be blamed on the caller.
 */
export function assertClaimProvenance(row: {
  origin: string;
  createdByVendorId: string | null;
}): void {
  const vendorOrigin = row.origin === 'vendor';
  const hasVendor = row.createdByVendorId !== null;
  if (vendorOrigin !== hasVendor) {
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      `claim provenance invariant violated: origin='${row.origin}' with created_by_vendor_id ${
        hasVendor ? 'set' : 'null'
      }`,
    );
  }
}
