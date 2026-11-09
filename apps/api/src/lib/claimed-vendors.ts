/**
 * "Does this vendor own its record?" — the single definition (AECI-1415, ADR 0042).
 *
 * A vendor is OWNED while `vendors.owned_at` is non-null. Ownership flips to the
 * vendor at claim approval (and at an admin seat provision), in the grant's own
 * batch, and covers the vendor row, every product joined to it and the integrations
 * it owns. It is STORED, not derived from seats (ruled 2026-10-19 on AECI-1341):
 *
 * - Seat loss never moves it. A revoke, a ban or an account erasure of the last seat
 *   ends the edit right only. The records stay vendor-owned and frozen.
 * - A license lapse never moves it either. Seat and plan stay orthogonal.
 * - Only the admin "Return records to AECi" action clears it
 *   (`POST /api/admin/vendors/:id/return-to-aeci`). It exists for a mistaken
 *   approval and nothing else.
 *
 * Before AECI-1415 this file answered "claimed" from seat presence (an unbanned
 * `vendor_admin` profile, AECI-520). That made a last-seat revoke hand the record
 * back to promote. Migration `0083` backfilled `owned_at` for every vendor with a
 * `vendor_admin` seat, banned or not (ruled 2026-10-19: a ban never moves ownership).
 *
 * Edit rights are a different question and stay seat-based: the `requireVendor()`
 * guard, notification recipients and contest routing all read `profiles`.
 *
 * ── CLAIMED IS NOT OWNED (AECI-1618) ─────────────────────────────────────────
 * A vendor is CLAIMED while it is owned and its claim has not ended: `owned_at IS NOT
 * NULL AND claim_ended_at IS NULL`. A product is claimed if any joined vendor is. Seat
 * loss ends the claim and leaves ownership alone, so promote keeps refusing the records
 * while public pages read Unclaimed. A suspension changes neither.
 *
 * Consumers: the promote ownership fence (`routes/promote.ts`) and the AECi field
 * override's "vendor-held" test (`routes/admin-field-overrides.ts`).
 */

import type { ClaimStatus } from '@aeci/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, productVendors, vendors } from '../db/schema';
import type { BatchStmt } from './audit';

/** `profiles.role` value that marks a vendor-portal seat. */
export const VENDOR_ADMIN_ROLE = 'vendor_admin';

/** Ids per `IN (...)` lookup. D1 caps bound parameters per query at 100. */
const ID_CHUNK = 80;

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function chunk<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) out.push(items.slice(i, i + ID_CHUNK));
  return out;
}

/** The claim columns of a vendor row. Absent reads as unclaimed, so a read that forgot
 *  to select them hides a logo rather than shows one. */
export interface VendorClaimState {
  ownedAt?: string | null;
  claimEndedAt?: string | null;
}

/** The claimed test, for a row in hand. */
export function isVendorClaimed(row: VendorClaimState): boolean {
  return Boolean(row.ownedAt) && !row.claimEndedAt;
}

export function claimStatusOf(claimed: boolean): ClaimStatus {
  return claimed ? 'claimed' : 'unclaimed';
}

/**
 * The claimed test as a correlated scalar on a product read: 1 when any joined vendor is
 * claimed. Spread into a relational `extras`, where drizzle re-aliases `products.id` per
 * nesting level. On a leaf level it renders as a bare `"id"`, so the vendor test sits in
 * an inner `IN (SELECT ...)`: `product_vendors` has no `id` column to shadow it, and
 * `vendors.id` is out of scope for it.
 */
export const claimedProductExtra = {
  claimed:
    sql<number>`EXISTS (SELECT 1 FROM product_vendors cpv WHERE cpv.product_id = ${products.id} AND cpv.vendor_id IN (SELECT cv.id FROM vendors cv WHERE cv.owned_at IS NOT NULL AND cv.claim_ended_at IS NULL))`.as(
      'claimed',
    ),
};

/** Products in `productIds` that a claimed vendor other than `vendorId` holds. */
export async function loadProductsClaimedByAnother(
  db: Db,
  vendorId: string,
  productIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const ids of chunk(unique(productIds))) {
    const rows = await db
      .selectDistinct({ productId: productVendors.productId })
      .from(productVendors)
      .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
      .where(
        and(
          inArray(productVendors.productId, ids),
          ne(productVendors.vendorId, vendorId),
          isNotNull(vendors.ownedAt),
          isNull(vendors.claimEndedAt),
        ),
      );
    for (const row of rows) found.add(row.productId);
  }
  return found;
}

/**
 * Narrow `candidateIds` to the vendors that own their record (`owned_at` set).
 *
 * Returns an empty set for an empty candidate list without touching D1. Drizzle's
 * `inArray` with `[]` emits degenerate SQL, so the short-circuit is required.
 */
export async function loadOwnedVendorIds(
  db: Db,
  candidateIds: readonly string[],
): Promise<Set<string>> {
  const owned = new Set<string>();
  for (const ids of chunk(unique(candidateIds))) {
    const rows = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(inArray(vendors.id, ids), isNotNull(vendors.ownedAt)));
    for (const row of rows) owned.add(row.id);
  }
  return owned;
}

/**
 * Narrow `productIds` to the OWNED products: those joined (`product_vendors`) to at
 * least one owned vendor. A co-owned product is owned when any joined vendor is
 * owned (ruling Q3, 2026-10-19).
 */
export async function loadOwnedProductIds(
  db: Db,
  productIds: readonly string[],
): Promise<Set<string>> {
  const owned = new Set<string>();
  for (const ids of chunk(unique(productIds))) {
    const rows = await db
      .selectDistinct({ productId: productVendors.productId })
      .from(productVendors)
      .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
      .where(and(inArray(productVendors.productId, ids), isNotNull(vendors.ownedAt)));
    for (const row of rows) owned.add(row.productId);
  }
  return owned;
}

/**
 * The vendor that holds a company or product record, or `null` when none does: the
 * §11d.5 held test (`STAGE_2_VENDOR_PORTAL_SPEC.md`), the same one the AECi correction
 * route runs. A company is held when it owns its record. A product is held when any
 * joined vendor is owned (the promote fence's `productBlocked`, ruling Q3); the primary
 * vendor wins, then the lowest id, so the pick is stable.
 */
export async function loadRecordHolderVendorId(
  db: Db,
  kind: 'vendor' | 'product',
  id: string,
): Promise<string | null> {
  if (kind === 'vendor') return (await loadOwnedVendorIds(db, [id])).has(id) ? id : null;
  const [row] = await db
    .select({ vendorId: productVendors.vendorId })
    .from(productVendors)
    .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
    .where(and(eq(productVendors.productId, id), isNotNull(vendors.ownedAt)))
    .orderBy(desc(productVendors.isPrimary), asc(productVendors.vendorId))
    .limit(1);
  return row?.vendorId ?? null;
}

/**
 * The ownership stamp: `owned_at = now` when it is not set yet. Pushed into the
 * batch of every grant of an owner seat, the claim approval
 * (`PATCH /api/admin/claims/:id`) and the admin provision
 * (`POST /api/admin/vendors/:id/seats`). Guarded on `owned_at IS NULL`, so a grant on
 * an already-owned vendor matches no row. The grant's own audit row records it
 * (`metadata.ownership_stamped`).
 *
 * Since AECI-1618 public lists show a logo only while claimed, so a stamp that lands
 * changes the public record. It stamps `updated_at` on the vendor and its products, so
 * the nightly Algolia push sees the flip. The products go first because their guard
 * reads `owned_at IS NULL`. A grant on an already-owned vendor still moves neither.
 *
 * Not in `lib/vendor-grant.ts`: that module is fenced from naming `vendors` at all,
 * to protect the `verified` mirror (`vendor-grant.spec.ts`).
 */
export function stampOwnershipStatements(db: Db, vendorId: string, now: string): BatchStmt[] {
  return [
    db
      .update(products)
      .set({ updatedAt: now })
      .where(
        and(
          inArray(
            products.id,
            db
              .select({ id: productVendors.productId })
              .from(productVendors)
              .where(eq(productVendors.vendorId, vendorId)),
          ),
          sql`EXISTS (SELECT 1 FROM ${vendors} WHERE ${vendors.id} = ${vendorId} AND ${vendors.ownedAt} IS NULL)`,
        ),
      ),
    db
      .update(vendors)
      .set({ ownedAt: now, updatedAt: now })
      .where(and(eq(vendors.id, vendorId), isNull(vendors.ownedAt))),
  ];
}

/**
 * The vendor's `owned_at` now. A seat grant that re-plans after losing the
 * first-account race (AECI-1380) reads it again: the rival seat stamped ownership in
 * its own batch, so this grant's stamp matches no row and its audit row must not say
 * `ownership_stamped`. `null` for an unowned or missing vendor.
 */
export async function loadVendorOwnedAt(db: Db, vendorId: string): Promise<string | null> {
  const row = await db.query.vendors.findFirst({
    columns: { ownedAt: true },
    where: eq(vendors.id, vendorId),
  });
  return row?.ownedAt ?? null;
}

/** The token the promote ownership sentinel raises with. `json()` on it is malformed
 *  JSON, so the whole batch rolls back. */
export const VENDOR_OWNED_DURING_PROMOTE_TOKEN = 'vendor-owned-during-promote';

/**
 * The commit-time half of the promote ownership fence (AECI-1415). The plan-time half
 * reads `owned_at` before the batch, so a claim approval that commits between that
 * read and the batch would otherwise let promote overwrite a record the vendor now
 * owns. These statements abort the batch when any vendor in `vendorIds` is owned, or
 * any product in `productIds` is joined to an owned vendor, at commit time.
 *
 * The caller passes only what the plan treated as unowned AND writes. Chunked under
 * D1's 100-parameter cap. Same mechanism as `promoteClaimFenceSentinel`
 * (`lib/integration-claims.ts`), FROM a one-row constant so each guard is evaluated
 * once. A promote batch raises "malformed JSON" from several sentinels, so the caller
 * re-reads ownership to tell this one apart (`routes/promote.ts`).
 */
export function promoteOwnershipSentinels(
  db: Db,
  vendorIds: readonly string[],
  productIds: readonly string[],
): BatchStmt[] {
  const stmts: BatchStmt[] = [];
  const raise = (condition: SQL) =>
    db
      .select({
        guard: sql`CASE WHEN ${condition} THEN json(${VENDOR_OWNED_DURING_PROMOTE_TOKEN}) END`,
      })
      .from(sql`(SELECT 1)`);
  for (const ids of chunk(unique(vendorIds))) {
    stmts.push(
      raise(
        sql`EXISTS (SELECT 1 FROM ${vendors} WHERE ${inArray(vendors.id, ids)} AND ${vendors.ownedAt} IS NOT NULL)`,
      ),
    );
  }
  for (const ids of chunk(unique(productIds))) {
    stmts.push(
      raise(
        sql`EXISTS (SELECT 1 FROM ${productVendors} INNER JOIN ${vendors} ON ${vendors.id} = ${productVendors.vendorId} WHERE ${inArray(productVendors.productId, ids)} AND ${vendors.ownedAt} IS NOT NULL)`,
      ),
    );
  }
  return stmts;
}
