/**
 * The license write module (AECI-1352, E1.3; `docs/VENDOR_SIGNUP_PROCESS.md` §2
 * decisions 5, 6, 11, 12, 14, 15 and §3 steps 5 to 7). The ONE module that writes
 * `licenses`: E4 (admin grants and approvals), E5 (vendor assignment), E6 (term end)
 * and E9 (Stripe) call these builders and add no second license writer. One ops lane
 * reaches a deployed D1 only through raw SQL over `wrangler d1 execute`, so it is the
 * exception: `ops:retract-product` (`lib/retract-product.ts`), which unassigns a
 * retracted product's licenses with `license.unassigned` rows in this module's shape.
 * The `DELETE /api/account` erasure batch (`routes/account.ts`) also nulls
 * `granted_by`, the AUTH_AND_RLS.md §8 rule for no-FK actor columns.
 *
 * As built (AECI-1358, 2026-10-17): the entitlement builders' dual-write
 * (`lib/vendor-entitlement.ts`, AECI-1353) and the E1.5 back-fill
 * (`lib/backfill-licenses.ts`, AECI-1354) are deleted, and with them the
 * `licenseTermsForEntitlement` mapping they shared. The admin license routes
 * (`routes/admin-licenses.ts`) are the callers now.
 *
 * Every builder is PURE: it takes the state the caller pre-read plus `now`, and
 * RETURNS the Drizzle statements and the audit entries for the caller's
 * `db.batch([...])`. The license writes, their `audit_log`
 * rows and the mirror reconcile commit or roll back as one unit (§26.1). The caller
 * forwards `auditEntries` post-commit.
 *
 * ── ONE AUDIT ROW PER LICENSE WRITTEN ──────────────────────────────────────────
 * Rows file under the ACCOUNT, not the license: `entity_type = 'billing_account'`,
 * `entity_id` = the billing account id, `metadata.license_id` names the license
 * (`DATABASE_SCHEMA.md` §8.6c). `audit_log.vendor_id` is always filled, `product_id`
 * when the license is (or was) on a product. `vendor_tier` and
 * `vendor_entitlement_status` record the plan BEFORE the write, from
 * `licensePlanSnapshot` over the pre-read licenses; `after_state` holds the change.
 *
 * ── THE MIRROR RECONCILE ───────────────────────────────────────────────────────
 * `vendors.verified` stays a denormalized mirror. Every non-no-op batch ends with the
 * SAME statement, built by {@link reconcileVerifiedMirror}. The one exception is
 * {@link expiryNoticeStampStatements}, the expiry-notice fence, which cannot move
 * liveness (see it):
 *
 *   UPDATE vendors
 *      SET verified = EXISTS(live license on any billing account of the vendor),
 *          updated_at = :now
 *    WHERE id = :vendorId AND verified <> EXISTS(...same...)
 *
 * It is idempotent and order-free: it reads the license rows the batch has just
 * written, so two batches against one vendor, applied in either order, leave
 * `verified` equal to the truth. The `<>` guard keeps the R2 rule
 * (`STAGE_2_PAID_TIERS_SPEC.md` §2.1): `updated_at` moves IFF `verified` moves. It is
 * the only `vendors` statement this module emits, which is why `MIRROR_WRITE_EXEMPT`
 * in `eslint.config.base.mjs` lists this file. Since AECI-1358 it is the only file
 * there.
 *
 * `verifiedFlipped` on the result is a PREDICTION from the pre-read state (the
 * caller's `vendorWasVerified` and `vendorLicenses`). The SQL is the truth: a
 * concurrent batch can move the bit between the read and the commit, and the
 * reconcile then does the right thing whatever the prediction said. Use the
 * prediction for the response body and the purge decision, never as a fact.
 *
 * ── GUARDED WRITES, AND WHAT A LOST RACE COSTS ─────────────────────────────────
 * Each license UPDATE is guarded on the state it expects (`ended_at IS NULL`, and
 * `assigned_product_id IS NULL` for an assign), so a concurrent write cannot be
 * double-applied or resurrect an ended license. The pre-read is the no-op gate. A
 * race lost between the read and the commit leaves the guarded UPDATE matching zero
 * rows while its audit row still lands. That is the accepted cost of D1 having no
 * interactive transactions.
 *
 * `grantLicensesStatements` is the exception: its INSERTs have no guard, so two
 * grants from one pre-read both land. A caller must tie a grant to a write that can
 * only apply once. The admin grant does: it passes UUIDv5 `licenseIds` minted from
 * its grant id, so a replay trips the primary key and the losing batch rolls back
 * whole (`routes/admin-licenses.ts`). The entitlement activate did the same with a
 * sentinel until AECI-1358 deleted it.
 *
 * ── DATES ──────────────────────────────────────────────────────────────────────
 * Every date written goes through {@link toIsoTimestamp} (`new Date(x).toISOString()`).
 * `ends_at` is compared lexically by E6's index scan, which is sound only if every
 * writer stores the one full ISO spelling: `2027-01-31` would sort before
 * `2027-01-31T00:00:00.000Z` (epic finding 5).
 *
 * ── LIVE IS STORED STATE ───────────────────────────────────────────────────────
 * Live means `ended_at IS NULL`, nothing else (§8.6c). An ended license keeps its
 * `assigned_product_id` (decision 14, the hand-back): `endLicensesStatements` never
 * names that column.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import {
  LICENSE_CANCEL_REASONS,
  LICENSE_END_REASONS,
  LICENSE_SOURCES,
  licensePlanSnapshot,
  type LicenseCancelReason,
  type LicenseEndReason,
  type LicenseSource,
} from '@aeci/shared/entitlements';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts, licenses, productVendors, vendors } from '../db/schema';
import { auditInsert, type BatchStmt } from './audit';

/** `audit_log.entity_type` for every row this module writes. `entity_id` is the
 *  BILLING ACCOUNT id, so an account's whole license trail shares one index key. */
export const LICENSE_ENTITY_TYPE = 'billing_account';

/** Default `metadata.source`. A caller with its own vocabulary passes `source`. */
const LICENSE_AUDIT_SOURCE = 'admin-license';

/** The audit actions this module writes by default. */
export const LICENSE_ACTION = {
  granted: 'license.granted',
  assigned: 'license.assigned',
  unassigned: 'license.unassigned',
  releaseAtRenewalSet: 'license.release_at_renewal_set',
  releaseAtRenewalCleared: 'license.release_at_renewal_cleared',
  cancelAtTermEndSet: 'license.cancel_at_term_end_set',
  cancelAtTermEndCleared: 'license.cancel_at_term_end_cleared',
  lapsed: 'license.lapsed',
  released: 'license.released',
  revoked: 'license.revoked',
  termChanged: 'license.term_changed',
} as const;

/** The end action per end reason. */
const END_ACTION: Record<LicenseEndReason, string> = {
  lapsed: LICENSE_ACTION.lapsed,
  released: LICENSE_ACTION.released,
  revoked: LICENSE_ACTION.revoked,
};

/**
 * A pre-read license row: the columns the builders branch on and the audit records.
 * {@link loadVendorLicenses} returns exactly this.
 */
export interface LicenseBefore {
  id: string;
  billingAccountId: string;
  source: string;
  startsAt: string;
  endsAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  reference: string | null;
  stripeSubscriptionId: string | null;
  assignedProductId: string | null;
  assignedAt: string | null;
  releaseAtRenewal: boolean;
  cancelAtTermEnd: boolean;
  cancelReason: string | null;
}

/** What every builder returns. */
export interface LicenseBatch {
  stmts: BatchStmt[];
  /** One per license written, in the same order as their statements. Empty on a no-op. */
  auditEntries: AuditLogEntry[];
  /** The PREDICTED move of `vendors.verified`, from the pre-read state. The reconcile
   *  statement is the truth (see the module comment). */
  verifiedFlipped: boolean;
}

/** The shared no-op result. Frozen, arrays included, so no caller can mutate it. */
const NO_OP: LicenseBatch = Object.freeze({
  stmts: Object.freeze([]) as unknown as BatchStmt[],
  auditEntries: Object.freeze([]) as unknown as AuditLogEntry[],
  verifiedFlipped: false,
});

/** The context every builder takes. */
export interface LicenseWriteContext {
  vendorId: string;
  /** The write time. Normalised with `toISOString()`. */
  now: string | Date;
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
  /** EVERY license on EVERY billing account of the vendor, as pre-read
   *  ({@link loadVendorLicenses}). Feeds the plan snapshot, the flip prediction and,
   *  for the single-license builders, the lookup that proves the license is this
   *  vendor's. */
  vendorLicenses: readonly LicenseBefore[];
  /** `vendors.verified` as pre-read. Drives the `verifiedFlipped` prediction only. */
  vendorWasVerified: boolean;
  /** Override the audit action. */
  action?: string;
  /** Override `metadata.source`. */
  source?: string;
  reason?: string | null;
  /** Extra audit metadata, merged after the built-in keys. */
  extraMetadata?: Record<string, unknown>;
}

/**
 * Normalise a date to the one stored spelling, `YYYY-MM-DDTHH:mm:ss.sssZ`. A date-only
 * input reads as UTC midnight (`2027-01-31` → `2027-01-31T00:00:00.000Z`). Throws on
 * an unparseable value: a builder must never store a date E6 cannot compare.
 */
export function toIsoTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`license date is not a valid date: ${String(value)}`);
  }
  return date.toISOString();
}

/** `toIsoTimestamp`, passing `null` through (a monthly `ends_at`). */
function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIsoTimestamp(value);
}

/**
 * Pre-read every license on every billing account of a vendor. The one read this
 * module owns, so E4, E5, E6 and E9 do not each re-derive the join.
 */
export async function loadVendorLicenses(db: Db, vendorId: string): Promise<LicenseBefore[]> {
  return db
    .select({
      id: licenses.id,
      billingAccountId: licenses.billingAccountId,
      source: licenses.source,
      startsAt: licenses.startsAt,
      endsAt: licenses.endsAt,
      endedAt: licenses.endedAt,
      endReason: licenses.endReason,
      reference: licenses.reference,
      stripeSubscriptionId: licenses.stripeSubscriptionId,
      assignedProductId: licenses.assignedProductId,
      assignedAt: licenses.assignedAt,
      releaseAtRenewal: licenses.releaseAtRenewal,
      cancelAtTermEnd: licenses.cancelAtTermEnd,
      cancelReason: licenses.cancelReason,
    })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .where(eq(billingAccounts.vendorId, vendorId))
    .orderBy(licenses.createdAt, licenses.id);
}

/** One product the vendor owns, and whether a live license (any account's) holds it. */
export interface OwnedProductLicenseState {
  productId: string;
  /** A live license is already assigned to it. The partial unique index
   *  `licenses_live_product_idx` would reject a second, so a grant leaves it unassigned. */
  licensed: boolean;
}

/**
 * Pre-read the vendor's owned products (every `product_vendors` row, the same set
 * `ownedProductIds` in `routes/vendor-shared.ts` scopes by) and whether each already
 * holds a live license. "Any account's" matters for a co-owned product: another
 * vendor's live license on it would otherwise fail the whole grant batch on the
 * partial unique index. Ordered by product id so a grant assigns deterministically.
 */
export async function loadOwnedProductLicenseState(
  db: Db,
  vendorId: string,
): Promise<OwnedProductLicenseState[]> {
  return db
    .select({
      productId: productVendors.productId,
      licensed:
        sql<boolean>`exists (select 1 from ${licenses} where ${licenses.assignedProductId} = ${productVendors.productId} and ${licenses.endedAt} is null)`.mapWith(
          Boolean,
        ),
    })
    .from(productVendors)
    .where(eq(productVendors.vendorId, vendorId))
    .orderBy(productVendors.productId);
}

/**
 * The number of LIVE licenses (`ended_at IS NULL`) on every billing account of the
 * OUTER query's vendor, as a correlated scalar subquery. Select it from `vendors`:
 * it reads `"vendors"."id"`. Spelled out with aliases because on a one-table select
 * Drizzle renders `${col}` without its table, which is ambiguous (`id`) inside a
 * joined subquery. One definition read by the `license_mirror_drift` check
 * (`lib/data-quality.ts`) and the admin vendor list (AECI-1375), so the column an
 * operator sorts by and the drift finding count the same thing.
 */
export function liveLicenseCountSql(): SQL<number> {
  return sql<number>`(select count(*) from "licenses" l inner join "billing_accounts" b on b."id" = l."billing_account_id" where b."vendor_id" = "vendors"."id" and l."ended_at" is null)`;
}

/** EXISTS(a live license on any billing account of the vendor). */
function liveLicenseExists(vendorId: string) {
  return sql`exists (select 1 from ${licenses} inner join ${billingAccounts} on ${billingAccounts.id} = ${licenses.billingAccountId} where ${billingAccounts.vendorId} = ${vendorId} and ${licenses.endedAt} is null)`;
}

/**
 * A batch statement that ABORTS the batch when the vendor still holds a live license
 * at that point in the batch. A last-license revoke or lapse puts it after its license
 * UPDATEs (`planLastLicenseReroute` in `lib/integration-contests.ts`), so a grant that
 * commits between the pre-read and the batch cannot leave the vendor licensed with its contests re-routed away
 * (AECI-1375). `json(...)` on a non-JSON string is malformed JSON, so the whole batch
 * rolls back. Reads only; it is not a `vendors` statement.
 */
export function noLiveLicenseSentinel(db: Db, vendorId: string): BatchStmt {
  return db
    .select({
      guard: sql`CASE WHEN ${liveLicenseExists(vendorId)} THEN json('license-still-live') END`,
    })
    .from(sql`(SELECT 1)`);
}

/**
 * The inverse of {@link noLiveLicenseSentinel}: ABORTS the batch when the vendor holds
 * NO live license at that point in the batch. A revoke or lapse that read another live
 * license, and so planned no re-route, puts it after its license UPDATEs: two ends racing on a
 * vendor's last two licenses would otherwise both commit and leave its owner-routed
 * contests with an owner who can no longer decide them (AECI-1375).
 */
export function liveLicenseRemainsSentinel(db: Db, vendorId: string): BatchStmt {
  return db
    .select({
      guard: sql`CASE WHEN NOT ${liveLicenseExists(vendorId)} THEN json('no-live-license') END`,
    })
    .from(sql`(SELECT 1)`);
}

/**
 * The mirror reconcile: the ONLY `vendors` statement this module emits, identical
 * across every builder. Idempotent; moves `updated_at` only when `verified` moves.
 * Exported for the reconcile's own tests.
 */
export function reconcileVerifiedMirror(db: Db, vendorId: string, now: string | Date): BatchStmt {
  return db
    .update(vendors)
    .set({ verified: liveLicenseExists(vendorId), updatedAt: toIsoTimestamp(now) })
    .where(
      and(eq(vendors.id, vendorId), sql`${vendors.verified} <> ${liveLicenseExists(vendorId)}`),
    );
}

/** The license as an audit before/after state. Snake case, like the other ledgers. */
function licenseState(l: LicenseBefore) {
  return {
    source: l.source,
    starts_at: l.startsAt,
    ends_at: l.endsAt,
    ended_at: l.endedAt,
    end_reason: l.endReason,
    reference: l.reference,
    stripe_subscription_id: l.stripeSubscriptionId,
    assigned_product_id: l.assignedProductId,
    release_at_renewal: l.releaseAtRenewal,
    cancel_at_term_end: l.cancelAtTermEnd,
    cancel_reason: l.cancelReason,
  };
}

/**
 * Build the batch from the per-license changes: each license statement, then one audit
 * row per license, then the reconcile. `after` is the license set as it will stand
 * once the batch commits, which is what the flip prediction reads.
 */
function assemble(
  db: Db,
  ctx: LicenseWriteContext,
  now: string,
  writes: { stmt: BatchStmt; entry: AuditLogEntry }[],
  after: readonly LicenseBefore[],
): LicenseBatch {
  if (writes.length === 0) return NO_OP;
  const liveAfter = after.some((l) => l.endedAt === null);
  const verifiedFlipped = liveAfter !== ctx.vendorWasVerified;
  for (const { entry } of writes) {
    (entry.metadata as Record<string, unknown>).verified_flipped = verifiedFlipped;
  }
  const stmts: BatchStmt[] = [
    ...writes.map((w) => w.stmt),
    ...writes.map((w) => auditInsert(db, w.entry)),
    reconcileVerifiedMirror(db, ctx.vendorId, now),
  ];
  return { stmts, auditEntries: writes.map((w) => w.entry), verifiedFlipped };
}

/** One audit entry for one license. `before` null = the license is new. */
function licenseEntry(
  ctx: LicenseWriteContext,
  now: string,
  defaultAction: string,
  before: LicenseBefore | null,
  after: LicenseBefore,
): AuditLogEntry {
  return {
    actorId: ctx.actorId,
    actorType: ctx.actorType,
    action: ctx.action ?? defaultAction,
    entityType: LICENSE_ENTITY_TYPE,
    entityId: after.billingAccountId,
    vendorId: ctx.vendorId,
    // The product the license is on after the write, else the one it was on.
    productId: after.assignedProductId ?? before?.assignedProductId ?? null,
    // The plan BEFORE this write; after_state holds the change.
    vendorPlan: licensePlanSnapshot(ctx.vendorLicenses, now),
    beforeState: before ? licenseState(before) : null,
    afterState: licenseState(after),
    metadata: {
      source: ctx.source ?? LICENSE_AUDIT_SOURCE,
      ...(ctx.reason ? { reason: ctx.reason } : {}),
      ...ctx.extraMetadata,
      // After the spread: a caller's extra metadata must not rename the license.
      license_id: after.id,
    },
  };
}

/** Find a license on this vendor. `undefined` = not this vendor's: a no-op, never a
 *  write against another vendor's license. */
function findLicense(ctx: LicenseWriteContext, licenseId: string): LicenseBefore | undefined {
  return ctx.vendorLicenses.find((l) => l.id === licenseId);
}

/** `vendorLicenses` with one row replaced, for the prediction. */
function replaced(ctx: LicenseWriteContext, next: readonly LicenseBefore[]): LicenseBefore[] {
  const byId = new Map(next.map((l) => [l.id, l]));
  return ctx.vendorLicenses.map((l) => byId.get(l.id) ?? l);
}

// ─── Grant ──────────────────────────────────────────────────────────────────

export interface GrantLicensesParams extends LicenseWriteContext {
  /** The vendor's billing account. E1.2 creates it at claim approval. PRECONDITION:
   *  it must belong to `vendorId` (read it with `loadBillingAccount(vendorId)`). This
   *  builder cannot check that without a read, and a foreign account would put the
   *  licenses on another vendor while reconciling and auditing this one. */
  billingAccountId: string;
  /** How many licenses. 0 is a no-op. */
  count: number;
  /** Where the licenses come from. Named apart from the context's `source`, which is
   *  the AUDIT `metadata.source` tag. */
  licenseSource: LicenseSource;
  /** Defaults to `now`. */
  startsAt?: string | Date;
  /** The scheduled end. `null` = monthly (renews until cancelled). */
  endsAt: string | Date | null;
  /** Invoice number, PO or grant note. */
  reference?: string | null;
  stripeSubscriptionId?: string | null;
  termsVersion?: string | null;
  /** `profiles.id` of the granting admin. No FK. */
  grantedBy?: string | null;
  /** Assign the first `productIds.length` new licenses, in order, at grant. The
   *  partial unique index rejects the whole batch if one already holds a live license. */
  productIds?: readonly string[];
  /** Caller-chosen ids (the admin grant uses UUIDv5). Length must equal `count`. */
  licenseIds?: readonly string[];
}

/**
 * Grant N licenses on a billing account (§3 step 5; E4.1, E9).
 * N INSERTs, one audit row each, then the reconcile. Every date is normalised.
 */
export function grantLicensesStatements(db: Db, p: GrantLicensesParams): LicenseBatch {
  if (!Number.isInteger(p.count) || p.count < 0) {
    throw new RangeError(`license count must be a non-negative integer: ${p.count}`);
  }
  if (p.count === 0) return NO_OP;
  if (!(LICENSE_SOURCES as readonly string[]).includes(p.licenseSource)) {
    throw new RangeError(`unknown license source: ${String(p.licenseSource)}`);
  }
  const productIds = p.productIds ?? [];
  if (productIds.length > p.count) {
    throw new RangeError('more products than licenses to assign at grant');
  }
  if (new Set(productIds).size !== productIds.length) {
    throw new RangeError('a product may hold only one live license');
  }
  if (p.licenseIds && p.licenseIds.length !== p.count) {
    throw new RangeError('licenseIds must have one id per license');
  }

  const now = toIsoTimestamp(p.now);
  const startsAt = toIsoTimestamp(p.startsAt ?? now);
  const endsAt = toIsoOrNull(p.endsAt);

  const created: LicenseBefore[] = [];
  const writes: { stmt: BatchStmt; entry: AuditLogEntry }[] = [];
  for (let i = 0; i < p.count; i++) {
    const productId = productIds[i] ?? null;
    const row: LicenseBefore = {
      id: p.licenseIds?.[i] ?? crypto.randomUUID(),
      billingAccountId: p.billingAccountId,
      source: p.licenseSource,
      startsAt,
      endsAt,
      endedAt: null,
      endReason: null,
      reference: p.reference ?? null,
      stripeSubscriptionId: p.stripeSubscriptionId ?? null,
      assignedProductId: productId,
      assignedAt: productId ? now : null,
      releaseAtRenewal: false,
      cancelAtTermEnd: false,
      cancelReason: null,
    };
    created.push(row);
    const stmt = db.insert(licenses).values({
      ...row,
      termsVersion: p.termsVersion ?? null,
      grantedBy: p.grantedBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    writes.push({ stmt, entry: licenseEntry(p, now, LICENSE_ACTION.granted, null, row) });
  }
  return assemble(db, p, now, writes, [...p.vendorLicenses, ...created]);
}

// ─── Term ───────────────────────────────────────────────────────────────────

export interface SetLicensesTermParams extends LicenseWriteContext {
  /** The licenses to re-term. Ids not on this vendor, and ended licenses, are skipped. */
  licenseIds: readonly string[];
  /** The new scheduled end. `null` = monthly (renews until cancelled). */
  endsAt: string | Date | null;
  /** The new license source. Absent = leave each license's source alone. Named apart
   *  from the context's `source`, which is the AUDIT `metadata.source`. */
  licenseSource?: LicenseSource;
  /** The new reference. Absent = leave alone; `null` clears it. */
  reference?: string | null;
  /**
   * Also guard the UPDATE on the `ends_at`, `source` and `reference` the caller read
   * (NULL-safe), so it matches no row when a concurrent edit moved any of them. Pair it
   * with a `changedOneRowSentinel` after the UPDATE to roll the lost race back. Off by
   * default: the entitlement re-term and renewal keep the `ended_at IS NULL` guard only.
   */
  expectUnchanged?: boolean;
}

/** `column IS value`, NULL-safe: `IS NULL` for a null, `=` otherwise. */
function sameAs(column: typeof licenses.endsAt | typeof licenses.reference, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

/**
 * Move the term of live licenses: `ends_at`, and optionally `source` and `reference`
 * (the admin term edit; E9's Stripe renewal later). One
 * guarded `WHERE ended_at IS NULL` statement and one `license.term_changed` audit row
 * per license that actually changes, then the reconcile. A license whose `ends_at`
 * moves gets `expiry_notice_sent_at` cleared: the expiry-notice fence is per term,
 * so a new term earns its own notice. Nothing changes: a no-op. `expectUnchanged`
 * widens the guard to the values read (the admin license edit, AECI-1371).
 */
export function setLicensesTermStatements(db: Db, p: SetLicensesTermParams): LicenseBatch {
  if (
    p.licenseSource !== undefined &&
    !(LICENSE_SOURCES as readonly string[]).includes(p.licenseSource)
  ) {
    throw new RangeError(`unknown license source: ${String(p.licenseSource)}`);
  }
  const now = toIsoTimestamp(p.now);
  const endsAt = toIsoOrNull(p.endsAt);

  const changed: LicenseBefore[] = [];
  const writes: { stmt: BatchStmt; entry: AuditLogEntry }[] = [];
  for (const id of new Set(p.licenseIds)) {
    const before = findLicense(p, id);
    if (!before || before.endedAt !== null) continue;
    const after: LicenseBefore = {
      ...before,
      endsAt,
      source: p.licenseSource ?? before.source,
      reference: p.reference === undefined ? before.reference : p.reference,
    };
    const termMoved = after.endsAt !== before.endsAt;
    if (!termMoved && after.source === before.source && after.reference === before.reference) {
      continue;
    }
    changed.push(after);
    const stmt = db
      .update(licenses)
      .set({
        endsAt: after.endsAt,
        source: after.source,
        reference: after.reference,
        ...(termMoved ? { expiryNoticeSentAt: null } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(licenses.id, before.id),
          isNull(licenses.endedAt),
          ...(p.expectUnchanged
            ? [
                sameAs(licenses.endsAt, before.endsAt),
                eq(licenses.source, before.source),
                sameAs(licenses.reference, before.reference),
              ]
            : []),
        ),
      );
    writes.push({ stmt, entry: licenseEntry(p, now, LICENSE_ACTION.termChanged, before, after) });
  }
  return assemble(db, p, now, writes, replaced(p, changed));
}

// ─── Assign / unassign ──────────────────────────────────────────────────────

export interface AssignLicenseParams extends LicenseWriteContext {
  licenseId: string;
  productId: string;
}

/**
 * Put a live, unassigned license on a product (§3 step 6; E5). Guarded
 * `WHERE assigned_product_id IS NULL AND ended_at IS NULL`, so it never moves a license
 * off a product (decision 11: a license stays until renewal) and never revives an
 * ended one. A license that is not this vendor's, ended, or already assigned is a
 * no-op. The partial unique index rejects the batch if the product already holds a
 * live license; the caller should pre-check that for a clean error.
 */
export function assignLicenseStatements(db: Db, p: AssignLicenseParams): LicenseBatch {
  const before = findLicense(p, p.licenseId);
  if (!before || before.endedAt !== null || before.assignedProductId !== null) return NO_OP;

  const now = toIsoTimestamp(p.now);
  const after: LicenseBefore = { ...before, assignedProductId: p.productId, assignedAt: now };
  const stmt = db
    .update(licenses)
    .set({ assignedProductId: p.productId, assignedAt: now, updatedAt: now })
    .where(
      and(eq(licenses.id, before.id), isNull(licenses.assignedProductId), isNull(licenses.endedAt)),
    );
  return assemble(
    db,
    p,
    now,
    [{ stmt, entry: licenseEntry(p, now, LICENSE_ACTION.assigned, before, after) }],
    replaced(p, [after]),
  );
}

export interface UnassignLicenseParams extends LicenseWriteContext {
  licenseId: string;
}

/**
 * Take a live license off its product early: the admin-approved early release
 * (decision 11; E4.4's approve). The license goes back to the pool, still live. Clears
 * `release_at_renewal`, which only means something on an assigned license. Guarded on
 * the product it was on, so a concurrent reassignment is not undone. Unassigned,
 * ended, or not this vendor's: a no-op.
 */
export function unassignLicenseStatements(db: Db, p: UnassignLicenseParams): LicenseBatch {
  const before = findLicense(p, p.licenseId);
  if (!before || before.endedAt !== null || before.assignedProductId === null) return NO_OP;

  const now = toIsoTimestamp(p.now);
  const after: LicenseBefore = {
    ...before,
    assignedProductId: null,
    assignedAt: null,
    releaseAtRenewal: false,
  };
  const stmt = db
    .update(licenses)
    .set({ assignedProductId: null, assignedAt: null, releaseAtRenewal: false, updatedAt: now })
    .where(
      and(
        eq(licenses.id, before.id),
        eq(licenses.assignedProductId, before.assignedProductId),
        isNull(licenses.endedAt),
      ),
    );
  return assemble(
    db,
    p,
    now,
    [{ stmt, entry: licenseEntry(p, now, LICENSE_ACTION.unassigned, before, after) }],
    replaced(p, [after]),
  );
}

// ─── Flags ──────────────────────────────────────────────────────────────────

export interface SetReleaseAtRenewalParams extends LicenseWriteContext {
  licenseId: string;
  release: boolean;
}

/**
 * Flag (or unflag) a live license "release at renewal" (decision 11; E5). The slot
 * stays on its product until renewal, then E6 frees it. No change, ended, or not this
 * vendor's: a no-op. Setting the flag also needs an assigned license, since the flag
 * only means something on one: an unassigned license is a no-op, and the UPDATE is
 * guarded on the product the pre-read saw, so an early unassign (or a reassignment)
 * committed between the read and the batch matches nothing rather than leaving the
 * flag on a pool license (AECI-1388). Clearing is allowed on any live license.
 */
export function setReleaseAtRenewalStatements(db: Db, p: SetReleaseAtRenewalParams): LicenseBatch {
  const before = findLicense(p, p.licenseId);
  if (!before || before.endedAt !== null || before.releaseAtRenewal === p.release) return NO_OP;
  if (p.release && before.assignedProductId === null) return NO_OP;

  const now = toIsoTimestamp(p.now);
  const after: LicenseBefore = { ...before, releaseAtRenewal: p.release };
  const stmt = db
    .update(licenses)
    .set({ releaseAtRenewal: p.release, updatedAt: now })
    .where(
      and(
        eq(licenses.id, before.id),
        isNull(licenses.endedAt),
        ...(p.release && before.assignedProductId !== null
          ? [eq(licenses.assignedProductId, before.assignedProductId)]
          : []),
      ),
    );
  const action = p.release
    ? LICENSE_ACTION.releaseAtRenewalSet
    : LICENSE_ACTION.releaseAtRenewalCleared;
  return assemble(
    db,
    p,
    now,
    [{ stmt, entry: licenseEntry(p, now, action, before, after) }],
    replaced(p, [after]),
  );
}

export interface SetCancelAtTermEndParams extends LicenseWriteContext {
  /** The licenses to flag. Ids not on this vendor, and ended licenses, are skipped. */
  licenseIds: readonly string[];
  cancel: boolean;
  /** Why (decision 15), from `LICENSE_CANCEL_REASONS`. Written when `cancel`, cleared
   *  when not. A value outside the vocabulary throws. */
  cancelReason?: string | null;
  /** Touch only licenses whose `cancel_reason` is this (`null` = none). Both a pre-read
   *  filter and a guard on each UPDATE, so a flag another writer set between the read
   *  and the commit is not overwritten or cleared. E4.5's unban clears only
   *  `vendor-banned` flags this way (AECI-1374). */
  ifCancelReason?: string | null;
}

/**
 * Flag live licenses to end at term end instead of renewing (decision 15; E4.5 on a
 * ban, E9 on an owner cancel), or clear the flag. One statement and one audit row per
 * license that actually changes. Nothing changes: a no-op.
 */
export function setCancelAtTermEndStatements(db: Db, p: SetCancelAtTermEndParams): LicenseBatch {
  const now = toIsoTimestamp(p.now);
  const reason = p.cancel ? (p.cancelReason ?? null) : null;
  if (reason !== null && !(LICENSE_CANCEL_REASONS as readonly string[]).includes(reason)) {
    throw new RangeError(`unknown license cancel reason: ${String(reason)}`);
  }
  const guarded = p.ifCancelReason !== undefined;
  const expected = p.ifCancelReason ?? null;
  const action = p.cancel
    ? LICENSE_ACTION.cancelAtTermEndSet
    : LICENSE_ACTION.cancelAtTermEndCleared;

  const changed: LicenseBefore[] = [];
  const writes: { stmt: BatchStmt; entry: AuditLogEntry }[] = [];
  for (const id of new Set(p.licenseIds)) {
    const before = findLicense(p, id);
    if (!before || before.endedAt !== null) continue;
    if (guarded && before.cancelReason !== expected) continue;
    if (before.cancelAtTermEnd === p.cancel && before.cancelReason === reason) continue;
    const after: LicenseBefore = { ...before, cancelAtTermEnd: p.cancel, cancelReason: reason };
    changed.push(after);
    const stmt = db
      .update(licenses)
      .set({ cancelAtTermEnd: p.cancel, cancelReason: reason, updatedAt: now })
      .where(
        and(
          eq(licenses.id, before.id),
          isNull(licenses.endedAt),
          ...(guarded
            ? [
                expected === null
                  ? isNull(licenses.cancelReason)
                  : eq(licenses.cancelReason, expected),
              ]
            : []),
        ),
      );
    writes.push({ stmt, entry: licenseEntry(p, now, action, before, after) });
  }
  return assemble(db, p, now, writes, replaced(p, changed));
}

/** The `cancel_reason` the ban of a vendor's last unbanned seat writes (AECI-1374). */
export const VENDOR_BANNED_CANCEL_REASON: LicenseCancelReason = 'vendor-banned';

export interface ClearVendorBannedFlagsParams {
  vendorId: string;
  now: string | Date;
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
  /** `metadata.source` on each audit row. */
  source?: string;
  extraMetadata?: Record<string, unknown>;
}

/**
 * The vendor has an unbanned `vendor_admin` seat again, so the `vendor-banned` flags
 * come off (decision 15). One implementation for both ways back: the unban
 * (`routes/admin-reviewers.ts`, AECI-1374) and every new seat grant
 * (`planSeatGrantReturn` in `lib/vendor-handback.ts`, ruled 2026-10-15). Clears only
 * live licenses whose reason is `vendor-banned`; each UPDATE is guarded on that reason.
 * Reads the vendor's licenses, and `vendors.verified` only when a flag is set.
 * Nothing flagged: a no-op, with no statement and no audit row.
 */
export async function clearVendorBannedFlagsStatements(
  db: Db,
  p: ClearVendorBannedFlagsParams,
): Promise<LicenseBatch> {
  const vendorLicenses = await loadVendorLicenses(db, p.vendorId);
  const flagged = vendorLicenses.filter(
    (l) => l.endedAt === null && l.cancelReason === VENDOR_BANNED_CANCEL_REASON,
  );
  if (flagged.length === 0) return NO_OP;
  const vendorRow = await db.query.vendors.findFirst({
    columns: { verified: true },
    where: eq(vendors.id, p.vendorId),
  });
  return setCancelAtTermEndStatements(db, {
    vendorId: p.vendorId,
    now: p.now,
    actorId: p.actorId,
    actorType: p.actorType,
    vendorLicenses,
    vendorWasVerified: vendorRow?.verified ?? false,
    ...(p.source ? { source: p.source } : {}),
    ...(p.extraMetadata ? { extraMetadata: p.extraMetadata } : {}),
    licenseIds: flagged.map((l) => l.id),
    cancel: false,
    ifCancelReason: VENDOR_BANNED_CANCEL_REASON,
  });
}

// ─── End ────────────────────────────────────────────────────────────────────

export type EndLicensesTarget =
  | { licenseIds: readonly string[] }
  | { stripeSubscriptionId: string };

export interface EndLicensesParams extends LicenseWriteContext {
  /** Which licenses: by id, or every live license on one Stripe subscription. Either
   *  way the targets are selected from the pre-read `vendorLicenses`, so every
   *  license ended has its audit row. */
  target: EndLicensesTarget;
  /** Why they end (`LICENSE_END_REASONS`): E6 lapse, a reduction's release, E4.2 revoke.
   *  Stored in `end_reason` and picks the default audit action. */
  endReason: LicenseEndReason;
  /**
   * Also guard each UPDATE on this exact `ends_at`, the term the caller scanned
   * (AECI-1404). An admin extend that moved the term between the read and the batch
   * then matches no row, so the extend wins. Pair it with a `changedOneRowSentinel`
   * after the UPDATE to roll the lost race back. Mirrors `expectUnchanged` on
   * {@link setLicensesTermStatements}. A target whose pre-read `ends_at` differs is
   * skipped. Absent: the `ended_at IS NULL` guard only (the admin revoke).
   */
  expectEndsAt?: string;
}

type LicenseWrite = { stmt: BatchStmt; entry: AuditLogEntry };

/**
 * The end writes for `targets`, guarded as {@link endLicensesStatements} says.
 * `expectAssigned` (the lapse, AECI-1336) also guards each UPDATE on the pre-read
 * `assigned_product_id` (NULL-safe), `release_at_renewal` and `cancel_at_term_end`.
 * A vendor assign, unassign, release flag or cancel flag that commits between the read
 * and the batch then matches no row, and the caller's `changedOneRowSentinel` rolls the
 * batch back so the retry re-reads: the flags decide the end reason and the carry-over.
 */
function endWrites(
  db: Db,
  ctx: LicenseWriteContext,
  now: string,
  targets: readonly LicenseBefore[],
  endReason: LicenseEndReason,
  expectEndsAt: string | undefined,
  expectAssigned = false,
): { writes: LicenseWrite[]; changed: LicenseBefore[] } {
  const changed: LicenseBefore[] = [];
  const writes: LicenseWrite[] = [];
  for (const before of targets) {
    if (before.endedAt !== null) continue;
    if (expectEndsAt !== undefined && before.endsAt !== expectEndsAt) continue;
    const after: LicenseBefore = { ...before, endedAt: now, endReason };
    changed.push(after);
    const stmt = db
      .update(licenses)
      .set({ endedAt: now, endReason, updatedAt: now })
      .where(
        and(
          eq(licenses.id, before.id),
          isNull(licenses.endedAt),
          ...(expectEndsAt !== undefined ? [eq(licenses.endsAt, expectEndsAt)] : []),
          ...(expectAssigned
            ? [
                before.assignedProductId === null
                  ? isNull(licenses.assignedProductId)
                  : eq(licenses.assignedProductId, before.assignedProductId),
                eq(licenses.releaseAtRenewal, before.releaseAtRenewal),
                eq(licenses.cancelAtTermEnd, before.cancelAtTermEnd),
              ]
            : []),
        ),
      );
    writes.push({ stmt, entry: licenseEntry(ctx, now, END_ACTION[endReason], before, after) });
  }
  return { writes, changed };
}

/**
 * End live licenses (terminal). Stamps `ended_at = now` and `end_reason`. NEVER touches
 * `assigned_product_id`: an ended license keeps its product as history (decision 14),
 * and the product's edit right goes because the gate finds no live license. Nor
 * `cancel_reason`, which records why a live license was set not to renew. One guarded
 * `WHERE ended_at IS NULL` statement (plus `ends_at = :expectEndsAt` when given) and
 * one audit row per license, then the reconcile, which drops `verified` when the last
 * live license ends.
 *
 * No live target: a no-op. Re-ending an ended license is never possible: there is no
 * un-end, a new license is a new grant.
 */
export function endLicensesStatements(db: Db, p: EndLicensesParams): LicenseBatch {
  if (!(LICENSE_END_REASONS as readonly string[]).includes(p.endReason)) {
    throw new RangeError(`unknown license end reason: ${String(p.endReason)}`);
  }
  const now = toIsoTimestamp(p.now);
  const wanted =
    'licenseIds' in p.target
      ? (() => {
          const ids = new Set(p.target.licenseIds);
          return (l: LicenseBefore) => ids.has(l.id);
        })()
      : (() => {
          const sub = p.target.stripeSubscriptionId;
          return (l: LicenseBefore) => l.stripeSubscriptionId === sub;
        })();
  const targets = p.vendorLicenses.filter((l) => l.endedAt === null && wanted(l));
  const { writes, changed } = endWrites(db, p, now, targets, p.endReason, p.expectEndsAt);
  return assemble(db, p, now, writes, replaced(p, changed));
}

// ─── Term end (E6, AECI-1404) ───────────────────────────────────────────────

export interface LapseTermParams extends LicenseWriteContext {
  /** The billing account whose term ended. */
  billingAccountId: string;
  /** The term's `ends_at`, exactly as scanned. Selects the licenses and guards every
   *  end UPDATE (`expectEndsAt`). */
  endsAt: string;
  /**
   * Products that must not carry over (AECI-1405), pre-checked by the caller: a
   * product another live license already holds (any account, so a co-owned product
   * licensed by its other vendor), or one the vendor no longer owns. Absent: none.
   */
  noCarryProductIds?: ReadonlySet<string>;
}

/** One license a term end ended. */
export interface EndedLicense {
  licenseId: string;
  /** The product it was on, or null for a pool license. */
  productId: string | null;
  /** `released` when it was flagged release-at-renewal, else `lapsed`. */
  cause: 'lapsed' | 'released';
}

/** One product moved onto a pool license at term end (decision 12). */
export interface CarriedProduct {
  productId: string;
  /** The lapsing license it was on. */
  fromLicenseId: string;
  /** The pool license it is on now. */
  toLicenseId: string;
}

/** {@link lapseTermStatements}' result: the batch, plus what it ends and carries. */
export interface LapseTermBatch extends LicenseBatch {
  ended: EndedLicense[];
  carried: CarriedProduct[];
  /** Products that could carry outnumbered the pool, so some dropped to Free while
   *  the ones assigned longest kept a license. */
  fewerLicenses: boolean;
  /** The products that lost the carry-over: candidates the pool ran out before. Empty
   *  unless `fewerLicenses`. The caller adds the email's extra line only when every
   *  product in the `lapsed` email is one of these. */
  shortProductIds: string[];
}

/** `assigned_at ASC, id ASC`; a missing `assigned_at` sorts last. Binary order: these
 *  are ISO timestamps and ids, not display text. */
function byAssignedAt(a: LicenseBefore, b: LicenseBefore): number {
  const ka = a.assignedAt ?? '￿';
  const kb = b.assignedAt ?? '￿';
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The carry-over at term end (AECI-1405; `VENDOR_SIGNUP_PROCESS.md` decision 12, ruled
 * 2026-10-19): fewer licenses than products means the products assigned longest keep
 * one. Pure: it returns the writes for {@link lapseTermStatements} to put after the
 * end UPDATEs, so the old license is ended before its product is assigned again and
 * the partial unique index `licenses_live_product_idx` holds.
 *
 *  - The products to carry are the term's assigned licenses, minus any flagged
 *    `release_at_renewal` or `cancel_at_term_end` and any in `noCarry`, sorted by
 *    `assigned_at ASC, id ASC`.
 *  - The pool is `pool` in the order given. The caller passes the account's live,
 *    unassigned licenses whose `ends_at` is NULL or later than now, in
 *    `created_at ASC, id ASC` order ({@link loadVendorLicenses}' order).
 *  - Each carried product gets an assign on the next pool license, guarded like
 *    {@link assignLicenseStatements}, audited `license.assigned` with
 *    `metadata.carried_from` = the lapsing license.
 *  - The pool license takes the lapsing license's `assigned_at`, not now (ruling A,
 *    2026-10-19): the oldest assignment keeps a license, so seniority survives the move.
 *    The audit row's `after_state.assigned_at` records it.
 */
export function carryOverStatements(
  db: Db,
  ctx: LicenseWriteContext,
  now: string,
  term: readonly LicenseBefore[],
  pool: readonly LicenseBefore[],
  noCarry: ReadonlySet<string>,
): {
  writes: LicenseWrite[];
  changed: LicenseBefore[];
  carried: CarriedProduct[];
  /** Candidates the pool ran out before, when at least one product carried. */
  short: string[];
} {
  const candidates = term
    .filter(
      (l) =>
        l.endedAt === null &&
        l.assignedProductId !== null &&
        !l.releaseAtRenewal &&
        !l.cancelAtTermEnd &&
        !noCarry.has(l.assignedProductId),
    )
    .sort(byAssignedAt);
  const writes: LicenseWrite[] = [];
  const changed: LicenseBefore[] = [];
  const carried: CarriedProduct[] = [];
  for (let i = 0; i < candidates.length && i < pool.length; i++) {
    const from = candidates[i]!;
    const to = pool[i]!;
    const productId = from.assignedProductId!;
    // Ruling A (2026-10-19): the product keeps its seniority. The spare takes the
    // original `assigned_at`, so the next shortfall still ranks it by its first assign.
    const assignedAt = from.assignedAt ?? now;
    const after: LicenseBefore = { ...to, assignedProductId: productId, assignedAt };
    changed.push(after);
    carried.push({ productId, fromLicenseId: from.id, toLicenseId: to.id });
    const stmt = db
      .update(licenses)
      .set({ assignedProductId: productId, assignedAt, updatedAt: now })
      .where(
        and(eq(licenses.id, to.id), isNull(licenses.assignedProductId), isNull(licenses.endedAt)),
      );
    const entry = licenseEntry(ctx, now, LICENSE_ACTION.assigned, to, after);
    (entry.metadata as Record<string, unknown>).carried_from = from.id;
    // The kept seniority is the one `assigned_at` this ledger records: a carry is the
    // only assign that does not stamp `now`.
    (entry.afterState as Record<string, unknown>).assigned_at = assignedAt;
    writes.push({ stmt, entry });
  }
  const short =
    carried.length > 0
      ? candidates.slice(carried.length).map((l) => l.assignedProductId as string)
      : [];
  return { writes, changed, carried, short };
}

/**
 * End one term (`VENDOR_SIGNUP_PROCESS.md` §3 steps 9 and 10, decisions 11 and 12): every
 * live license on `billingAccountId` whose `ends_at` is the scanned `endsAt`. An
 * assigned license flagged `release_at_renewal` ends `released`. Every other one ends
 * `lapsed`. Then {@link carryOverStatements} moves the products it can onto the
 * account's live pool licenses (AECI-1405). The daily term-end job
 * (`lib/license-lapse.ts`) is the caller.
 *
 * ONE batch for the whole term, so a term is never half-ended: the end UPDATEs first,
 * then the carry-over assigns, then one audit row per license written, then ONE mirror
 * reconcile with ONE `verifiedFlipped` prediction over the whole term, not one per
 * composed step. Every end UPDATE is guarded on `ended_at IS NULL`, the scanned
 * `ends_at`, and the pre-read `assigned_product_id`, `release_at_renewal` and
 * `cancel_at_term_end`, so an admin extend or revoke, or a vendor assign or flag, that
 * commits first wins. A `source = 'stripe'` license is left out:
 * the Stripe webhook ends it (decision 13). Nothing matches: a no-op.
 */
export function lapseTermStatements(db: Db, p: LapseTermParams): LapseTermBatch {
  const now = toIsoTimestamp(p.now);
  // A Stripe license is never on the term (decision 13): the Stripe webhook (E9) owns
  // its end, so the lapse neither ends it nor carries its product. It may still be a
  // pool license below and receive a carried product.
  const term = p.vendorLicenses.filter(
    (l) =>
      l.billingAccountId === p.billingAccountId &&
      l.endedAt === null &&
      l.endsAt === p.endsAt &&
      l.source !== 'stripe',
  );
  const releasing = term.filter((l) => l.releaseAtRenewal && l.assignedProductId !== null);
  const lapsing = term.filter((l) => !releasing.includes(l));

  const released = endWrites(db, p, now, releasing, 'released', p.endsAt, true);
  const lapsed = endWrites(db, p, now, lapsing, 'lapsed', p.endsAt, true);
  const changed = [...released.changed, ...lapsed.changed];
  if (changed.length === 0) {
    return {
      ...assemble(db, p, now, [], []),
      ended: [],
      carried: [],
      fewerLicenses: false,
      shortProductIds: [],
    };
  }

  // Live, unassigned, and not ending by now: `vendorLicenses` is in `created_at, id` order.
  const pool = p.vendorLicenses.filter(
    (l) =>
      l.billingAccountId === p.billingAccountId &&
      l.endedAt === null &&
      l.assignedProductId === null &&
      (l.endsAt === null || l.endsAt > now),
  );
  const carry = carryOverStatements(db, p, now, term, pool, p.noCarryProductIds ?? new Set());

  const batch = assemble(
    db,
    p,
    now,
    [...released.writes, ...lapsed.writes, ...carry.writes],
    replaced(p, [...changed, ...carry.changed]),
  );
  const ended: EndedLicense[] = changed.map((l) => ({
    licenseId: l.id,
    productId: l.assignedProductId,
    cause: l.endReason === 'released' ? 'released' : 'lapsed',
  }));
  return {
    ...batch,
    ended,
    carried: carry.carried,
    fewerLicenses: carry.short.length > 0,
    shortProductIds: carry.short,
  };
}

// ─── The expiry-notice fence (E1.7) ─────────────────────────────────────────

/** Ids per fence-stamp statement. D1 caps bound parameters per query at 100, and an
 *  account can hold more licenses than that on one term. */
export const EXPIRY_STAMP_CHUNK = 50;

export interface ExpiryNoticeStampParams {
  /** The licenses one notice covered: one billing account's live licenses on one term. */
  licenseIds: readonly string[];
  /** The term the notice was about, exactly as scanned. */
  endsAt: string;
  /** The stamp. Normalised with `toIsoTimestamp`. */
  now: string | Date;
}

/**
 * Stamp `expiry_notice_sent_at` on the licenses one term-end notice covered (AECI-1356,
 * `lib/entitlement-expiry.ts`). The one license write that carries NO audit row of its
 * own and NO mirror reconcile, and the exception to the module comment above:
 *
 *  - the fence does not move liveness, so `vendors.verified` cannot change, and
 *    `STAGE_2_PAID_TIERS_SPEC.md` §7.3 forbids the warning batch any `vendors` statement;
 *  - the caller writes ONE audit row per notice (per account and term), not one per
 *    license, so it owns the audit entry.
 *
 * The SET names `expiry_notice_sent_at` and `updated_at` only. The WHERE is guarded on
 * `ends_at` as scanned: a renewal that moved the term between the scan and this write
 * cleared the stamp for the NEW term, and must not have it re-stamped by a notice about
 * the old one. It deliberately does not name `ended_at`: stamping a license that ended
 * in the same window is harmless (nothing reads an ended license's fence, and a license
 * never comes back), and §7.3's test holds the batch to naming neither `ended_at` nor
 * `assigned_product_id`. One statement per {@link EXPIRY_STAMP_CHUNK} ids.
 */
export function expiryNoticeStampStatements(db: Db, p: ExpiryNoticeStampParams): BatchStmt[] {
  const now = toIsoTimestamp(p.now);
  const ids = [...new Set(p.licenseIds)];
  const stmts: BatchStmt[] = [];
  for (let i = 0; i < ids.length; i += EXPIRY_STAMP_CHUNK) {
    stmts.push(
      db
        .update(licenses)
        .set({ expiryNoticeSentAt: now, updatedAt: now })
        .where(
          and(
            inArray(licenses.id, ids.slice(i, i + EXPIRY_STAMP_CHUNK)),
            eq(licenses.endsAt, p.endsAt),
          ),
        ),
    );
  }
  return stmts;
}
