/**
 * The daily per-vendor snapshot (AECI-1210, `DATABASE_SCHEMA.md` §9.12).
 *
 * Most vendor numbers are a current state that overwrites itself: seats, plan,
 * open contests, confirmations. Without a daily copy there is no trend. This job
 * writes one `vendor_activity_daily` row per ACTIVATED vendor per UTC day.
 *
 * Shape of a run:
 *
 *  1. Eight grouped reads, one `db.batch` round trip, each `GROUP BY vendor_id`.
 *     Never one query per vendor.
 *  2. The activated set is derived from three of those reads: a vendor with at
 *     least one unbanned seat, an entitlement row, or a live invite. A catalog
 *     vendor with none of these gets no row.
 *  3. One `db.batch` of chunked upserts on `(day, vendor_id)`. A same-day rerun
 *     replaces the rows and adds none.
 *
 * Log-class and audit-exempt (ADR 0022, `STAGE_1_SPEC.md` §26.1): every number
 * is derived from rows already in D1 and a rerun reproduces it. It never deletes:
 * a vendor that drops out of the activated set between two same-day runs keeps
 * the first run's row, because a scheduled `DELETE` would not be audit-exempt.
 *
 * Day semantics. `day` is yesterday, UTC, at run time (the cron fires 00:30). The
 * activity counts cover whole days ending on `day`. Every other count is a stock
 * read at `computedAt`, about 30 minutes after `day` ended.
 *
 * Operator-only: `lib/ranking-firewall.spec.ts` keeps it out of every ranking,
 * search, home-stats and listing path. It sends nothing.
 */

import { tierFor } from '@aeci/shared/entitlements';
import { and, count, eq, gte, isNotNull, isNull, lte, max, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  attestations,
  integrationFieldChallenges,
  productVendors,
  products,
  profiles,
  userActivityDaily,
  vendorActivityDaily,
  vendorEntitlements,
  vendorSeatInvites,
} from '../db/schema';
import { shiftDay } from './admin-analytics';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import { chunked } from './promote-claims';
import { isChecked } from './vendor-checklist';
import { liveInvites } from './vendor-seat-invites';

/** The heartbeat, emitted on every run including failures (`scheduled.ts`). */
export const VENDOR_SNAPSHOT_RUN_METRIC = 'aeci.vendor_snapshot.run';

/**
 * Rows per upsert statement. D1 caps a statement at 100 bound parameters and a
 * row binds 16 columns, so 6 rows is 96. Sized off the documented limit, not a
 * local run: the test harness allows far more, so a spec would pass at any size
 * (`lib/asn-registry.ts` has the same note).
 */
export const UPSERT_ROWS_PER_STATEMENT = 6;

/** The trailing windows the active-user columns cover, ending on `day`. */
export const ACTIVE_WINDOW_DAYS = { d1: 1, d7: 7, d30: 30 } as const;

export type VendorSnapshotRow = typeof vendorActivityDaily.$inferInsert;

export interface VendorSnapshotResult {
  day: string;
  /** Rows written: one per activated vendor. */
  vendors: number;
}

/** The snapshot day for a run at `now`: the prior complete UTC day. */
export function snapshotDayFor(now: Date): string {
  return shiftDay(now.toISOString().slice(0, 10), -1);
}

/** A grouped count keyed by vendor id. */
type VendorCount = { vendorId: string | null; n: number };

function byVendor(rows: readonly VendorCount[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.vendorId !== null) out.set(row.vendorId, Number(row.n));
  }
  return out;
}

/**
 * Compute the rows for `day`, read at `now`. Pure reads, no writes.
 *
 * Exported apart from {@link runVendorSnapshot} so each count is testable against
 * fixture rows without asserting on the write.
 */
export async function computeVendorSnapshot(
  db: Db,
  day: string,
  now: Date,
): Promise<VendorSnapshotRow[]> {
  const nowIso = now.toISOString();
  const from7 = shiftDay(day, -(ACTIVE_WINDOW_DAYS.d7 - 1));
  const from30 = shiftDay(day, -(ACTIVE_WINDOW_DAYS.d30 - 1));

  const [
    seatRows,
    inviteRows,
    entitlementRows,
    activityRows,
    ownedRows,
    filedRows,
    attestationRows,
    productRows,
  ] = await db.batch([
    // Seats. `seatsOf` (routes/vendor-shared.ts) counts banned seats on purpose,
    // for the roster. A trend of usable seats must not, so this adds the ban term.
    db
      .select({ vendorId: profiles.vendorId, n: count() })
      .from(profiles)
      .where(
        and(
          eq(profiles.role, VENDOR_ADMIN_ROLE),
          isNotNull(profiles.vendorId),
          isNull(profiles.bannedAt),
        ),
      )
      .groupBy(profiles.vendorId),
    db
      .select({ vendorId: vendorSeatInvites.vendorId, n: count() })
      .from(vendorSeatInvites)
      .where(liveInvites(nowIso))
      .groupBy(vendorSeatInvites.vendorId),
    // `vendor_id` is unique on this table, so this is one row per vendor.
    db
      .select({
        vendorId: vendorEntitlements.vendorId,
        tier: vendorEntitlements.tier,
        status: vendorEntitlements.status,
      })
      .from(vendorEntitlements),
    // Distinct users over three trailing windows in one pass over 30 days. A
    // `CASE` with no `ELSE` yields NULL outside the window, and `count(DISTINCT …)`
    // ignores NULL.
    db
      .select({
        vendorId: userActivityDaily.vendorId,
        d1: sql<number>`count(DISTINCT CASE WHEN ${userActivityDaily.day} = ${day} THEN ${userActivityDaily.userId} END)`,
        d7: sql<number>`count(DISTINCT CASE WHEN ${userActivityDaily.day} >= ${from7} THEN ${userActivityDaily.userId} END)`,
        d30: sql<number>`count(DISTINCT ${userActivityDaily.userId})`,
      })
      .from(userActivityDaily)
      .where(
        and(
          eq(userActivityDaily.role, VENDOR_ADMIN_ROLE),
          isNotNull(userActivityDaily.vendorId),
          gte(userActivityDaily.day, from30),
          lte(userActivityDaily.day, day),
        ),
      )
      .groupBy(userActivityDaily.vendorId),
    db
      .select({ vendorId: integrationFieldChallenges.ownerVendorId, n: count() })
      .from(integrationFieldChallenges)
      .where(
        and(
          eq(integrationFieldChallenges.status, 'open'),
          isNotNull(integrationFieldChallenges.ownerVendorId),
        ),
      )
      .groupBy(integrationFieldChallenges.ownerVendorId),
    db
      .select({ vendorId: integrationFieldChallenges.submitterVendorId, n: count() })
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.status, 'open'))
      .groupBy(integrationFieldChallenges.submitterVendorId),
    db
      .select({ vendorId: attestations.attestedByVendorId, n: count() })
      .from(attestations)
      .where(and(isNull(attestations.retractedAt), isNotNull(attestations.attestedByVendorId)))
      .groupBy(attestations.attestedByVendorId),
    // Grouped by the two facts the checklist predicate reads, so `isChecked`
    // decides each group in TS and the two definitions cannot drift. Within a
    // group split on `last_reviewed_at IS NOT NULL`, `max()` is non-null exactly
    // when every row in the group has it set.
    db
      .select({
        vendorId: productVendors.vendorId,
        maintainedBy: products.maintainedBy,
        lastReviewedAt: max(products.lastReviewedAt),
        n: count(),
      })
      .from(productVendors)
      .innerJoin(products, eq(products.id, productVendors.productId))
      .groupBy(
        productVendors.vendorId,
        products.maintainedBy,
        sql`${products.lastReviewedAt} IS NOT NULL`,
      ),
  ]);

  const seats = byVendor(seatRows);
  const invites = byVendor(inviteRows);
  const owned = byVendor(ownedRows);
  const filed = byVendor(filedRows);
  const attested = byVendor(attestationRows);
  const entitlements = new Map(entitlementRows.map((r) => [r.vendorId, r]));
  const activity = new Map(activityRows.map((r) => [r.vendorId, r]));

  const productsTotal = new Map<string, number>();
  const productsConfirmed = new Map<string, number>();
  for (const row of productRows) {
    const n = Number(row.n);
    productsTotal.set(row.vendorId, (productsTotal.get(row.vendorId) ?? 0) + n);
    if (isChecked({ maintainedBy: row.maintainedBy, lastReviewedAt: row.lastReviewedAt })) {
      productsConfirmed.set(row.vendorId, (productsConfirmed.get(row.vendorId) ?? 0) + n);
    }
  }

  // The activated set. Seats here are unbanned seats, so a vendor whose only seat
  // is banned, with no plan row and no live invite, is not activated.
  const activated = new Set<string>([...seats.keys(), ...entitlements.keys(), ...invites.keys()]);

  const computedAt = nowIso;
  return [...activated].sort().map((vendorId): VendorSnapshotRow => {
    const entitlement = entitlements.get(vendorId) ?? null;
    const act = activity.get(vendorId);
    return {
      day,
      vendorId,
      seats: seats.get(vendorId) ?? 0,
      pendingInvites: invites.get(vendorId) ?? 0,
      activeUsers1d: Number(act?.d1 ?? 0),
      activeUsers7d: Number(act?.d7 ?? 0),
      activeUsers30d: Number(act?.d30 ?? 0),
      entitlementTier: entitlement?.tier ?? null,
      entitlementStatus: entitlement?.status ?? null,
      effectiveTier: tierFor(entitlement),
      openContestsOwned: owned.get(vendorId) ?? 0,
      openContestsFiled: filed.get(vendorId) ?? 0,
      dataFlowsConfirmed: attested.get(vendorId) ?? 0,
      productsTotal: productsTotal.get(vendorId) ?? 0,
      productsConfirmed: productsConfirmed.get(vendorId) ?? 0,
      computedAt,
    };
  });
}

/**
 * Upsert the rows in one atomic `db.batch`, {@link UPSERT_ROWS_PER_STATEMENT} per
 * statement. On a `(day, vendor_id)` conflict every value column is replaced, so a
 * rerun of the same day leaves exactly one row per vendor.
 */
export async function writeVendorSnapshot(
  db: Db,
  rows: readonly VendorSnapshotRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const statements = chunked(rows, UPSERT_ROWS_PER_STATEMENT).map((chunk) =>
    db
      .insert(vendorActivityDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [vendorActivityDaily.day, vendorActivityDaily.vendorId],
        set: {
          seats: sql`excluded.seats`,
          pendingInvites: sql`excluded.pending_invites`,
          activeUsers1d: sql`excluded.active_users_1d`,
          activeUsers7d: sql`excluded.active_users_7d`,
          activeUsers30d: sql`excluded.active_users_30d`,
          entitlementTier: sql`excluded.entitlement_tier`,
          entitlementStatus: sql`excluded.entitlement_status`,
          effectiveTier: sql`excluded.effective_tier`,
          openContestsOwned: sql`excluded.open_contests_owned`,
          openContestsFiled: sql`excluded.open_contests_filed`,
          dataFlowsConfirmed: sql`excluded.data_flows_confirmed`,
          productsTotal: sql`excluded.products_total`,
          productsConfirmed: sql`excluded.products_confirmed`,
          computedAt: sql`excluded.computed_at`,
        },
      }),
  );
  const [first, ...rest] = statements;
  await db.batch([first!, ...rest]);
}

/** Compute and write the snapshot for the day before `now`. Throws on a D1 failure. */
export async function runVendorSnapshot(db: Db, now: Date): Promise<VendorSnapshotResult> {
  const day = snapshotDayFor(now);
  const rows = await computeVendorSnapshot(db, day, now);
  await writeVendorSnapshot(db, rows);
  return { day, vendors: rows.length };
}
