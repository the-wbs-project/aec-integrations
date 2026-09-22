/**
 * The duplicate-integration rule (AECI-1012, ruled 2026-09-22; built in AECI-1011).
 *
 * A **strong match** for a candidate integration is an existing `integrations` row
 * with:
 *
 *   1. the same two products, in EITHER orientation. Upstream orients rows by
 *      builder, not by flow, and a vendor-created row runs from the vendor's own
 *      product, so a twin may be stored B → A. The prune guards were
 *      orientation-blind and that is how AECI-794's reverse twin got past them;
 *   2. the same connector: `powered_by_product_id` equal, NULL equal to NULL. A
 *      vendor-created row never has one (decision 9);
 *   3. an owner that is the candidate's owner, or unknown on either side. Two
 *      vendors can each sell an integration for one pair (the Concur case), so the
 *      owner is part of the identity; an unknown owner matches anything, so the
 *      420-row owner backfill gap cannot hide a real duplicate.
 *
 * Mechanism name is never in the key. **Mechanism kind is in promote's key only**
 * (ruled 2026-09-22 on AECI-1012): promote skips a twin only when it is also the
 * same `mechanism_kind` (NULL equal to NULL), so a curated `marketplace-app` row
 * beside a vendor's `native` row for the same pair is two integrations, not one. The
 * vendor create's warning leaves the kind out ({@link TwinCandidate.mechanismKind}
 * undefined), because a vendor fixing a wrong kind on its own row must still be
 * told about its curated twin.
 *
 * Two callers, one rule, so they cannot drift:
 *
 *   - the vendor create (`routes/vendor-integration-create.ts`) WARNS with every
 *     strong match, curated or vendor-held, live or retired, with no kind in the
 *     key. It never refuses (AECI-1003 decision 10);
 *   - promote (`routes/promote.ts`) SKIPS a write that would leave a curated row
 *     strongly matching a **vendor-held** row, live or retired, with the kind in the
 *     key, and reports it as `VENDOR_OWNED_TWIN`. Three writes can do that: an
 *     insert, a de-route out of `connector_evidenced_pairs`, and an UPDATE that
 *     changes any key field of an unclaimed row (its endpoints, connector,
 *     `mechanism_kind` or owner). It never deletes
 *     anything, and curated-versus-curated behaviour is unchanged.
 *
 * `connector_evidenced_pairs` is not searched. Every row there is connector-powered
 * by construction, so it can never be vendor-held and never shares "no connector"
 * with a vendor row (rule 2).
 */

import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrations, vendors } from '../db/schema';
import { ONE_ROW } from './integration-claims';

/** `skipped[].reason` for an insert promote refused because a vendor holds its twin.
 *  A constant, not a sentence, so the review app can branch on it. */
export const VENDOR_OWNED_TWIN = 'VENDOR_OWNED_TWIN';

export interface TwinCandidate {
  /** The candidate's two endpoints, in any order. */
  readonly productIds: readonly [string, string];
  /** The candidate's connector, or `null` for none. */
  readonly poweredByProductId: string | null;
  /** The candidate's owner, or `null` when unknown (matches any owner). */
  readonly ownerVendorId: string | null;
  /**
   * The candidate's `mechanism_kind`, NULL equal to NULL. Promote sets it (ruled
   * 2026-09-22). `undefined` leaves the kind out of the key, which is the vendor
   * create's broader warning.
   */
  readonly mechanismKind?: string | null;
}

/** Vendor-held: claimed, or created by a vendor. `isVendorHeld` in SQL. */
export const vendorHeldIntegrationWhere: SQL = or(
  isNotNull(integrations.claimedAt),
  eq(integrations.origin, 'vendor'),
)!;

/** The strong-match predicate over `integrations`, for {@link TwinCandidate}. */
export function strongMatchWhere(candidate: TwinCandidate): SQL {
  const [a, b] = candidate.productIds;
  const clauses: SQL[] = [
    or(
      and(eq(integrations.sourceProductId, a), eq(integrations.targetProductId, b)),
      and(eq(integrations.sourceProductId, b), eq(integrations.targetProductId, a)),
    )!,
    candidate.poweredByProductId === null
      ? isNull(integrations.poweredByProductId)
      : eq(integrations.poweredByProductId, candidate.poweredByProductId),
  ];
  if (candidate.mechanismKind !== undefined) {
    clauses.push(
      candidate.mechanismKind === null
        ? isNull(integrations.mechanismKind)
        : eq(integrations.mechanismKind, candidate.mechanismKind),
    );
  }
  if (candidate.ownerVendorId !== null) {
    clauses.push(
      or(
        isNull(integrations.builtByVendorId),
        eq(integrations.builtByVendorId, candidate.ownerVendorId),
      )!,
    );
  }
  return and(...clauses)!;
}

export interface StrongMatchRow {
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  sourceProductId: string;
  targetProductId: string;
  builtByVendorId: string | null;
  ownerName: string | null;
  claimedAt: string | null;
  origin: string;
  retiredAt: string | null;
}

/**
 * Every strong match for `candidate`, in ONE query, oldest first. `vendorHeldOnly`
 * narrows to the rows promote must not twin.
 */
export async function findStrongMatches(
  db: Db,
  candidate: TwinCandidate,
  opts: { vendorHeldOnly?: boolean } = {},
): Promise<StrongMatchRow[]> {
  const where = opts.vendorHeldOnly
    ? and(strongMatchWhere(candidate), vendorHeldIntegrationWhere)
    : strongMatchWhere(candidate);
  return db
    .select({
      id: integrations.id,
      name: integrations.name,
      mechanismKind: integrations.mechanismKind,
      mechanismName: integrations.mechanismName,
      sourceProductId: integrations.sourceProductId,
      targetProductId: integrations.targetProductId,
      builtByVendorId: integrations.builtByVendorId,
      ownerName: vendors.companyName,
      claimedAt: integrations.claimedAt,
      origin: integrations.origin,
      retiredAt: integrations.retiredAt,
    })
    .from(integrations)
    .leftJoin(vendors, eq(vendors.id, integrations.builtByVendorId))
    .where(where)
    .orderBy(integrations.createdAt, integrations.id);
}

/**
 * The commit-time half of promote's `VENDOR_OWNED_TWIN` guard. Pushed immediately
 * ahead of each `integrations` write the guard checked (an INSERT, a de-route move, or
 * an UPDATE that changes a key field); ABORTS the whole batch when a
 * vendor-held strong match exists by the time the batch runs, i.e. a vendor created
 * (or claimed) the twin after the plan read. Same shape as the AECI-1005
 * `promoteClaimFenceSentinel`: the job errors with
 * `VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE`, and a re-push plans against the new row
 * and skips the insert. Selects FROM `ONE_ROW`, so it evaluates exactly once.
 */
export function vendorOwnedTwinSentinel(db: Db, candidate: TwinCandidate) {
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (
        SELECT 1 FROM ${integrations}
        WHERE ${strongMatchWhere(candidate)} AND ${vendorHeldIntegrationWhere}
      ) THEN json('vendor-owned-twin-during-promote') END`,
    })
    .from(ONE_ROW);
}

/**
 * Does any of `candidates` have a vendor-held strong match now? The post-failure
 * re-read that tells a {@link vendorOwnedTwinSentinel} abort apart from an AECI-1005
 * `promoteClaimFenceSentinel` abort.
 *
 * Both sentinels raise the same SQLite error ("malformed JSON"), and SQLite does not
 * echo the argument, so the message cannot say which one fired. Both mean
 * "nothing was written, re-push", so the re-read only picks the more precise code.
 * Sequential reads, never a fan-out.
 */
export async function anyVendorOwnedTwin(
  db: Db,
  candidates: readonly TwinCandidate[],
): Promise<boolean> {
  for (const candidate of candidates) {
    const hit = await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(strongMatchWhere(candidate), vendorHeldIntegrationWhere))
      .limit(1);
    if (hit.length > 0) return true;
  }
  return false;
}
