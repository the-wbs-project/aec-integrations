/**
 * The license write module (AECI-1352, E1.3; `docs/VENDOR_SIGNUP_PROCESS.md` §2
 * decisions 5, 6, 11, 12, 14, 15 and §3 steps 5 to 7). The ONE module that writes
 * `licenses`: E4 (admin grants and approvals), E5 (vendor assignment), E6 (term end)
 * and E9 (Stripe) call these builders and add no second license writer.
 *
 * Like `lib/vendor-entitlement.ts`, every builder is PURE: it takes the state the
 * caller pre-read plus `now`, and RETURNS the Drizzle statements and the audit
 * entries for the caller's `db.batch([...])`. The license writes, their `audit_log`
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
 * SAME statement, built by {@link reconcileVerifiedMirror}:
 *
 *   UPDATE vendors
 *      SET verified = EXISTS(live license on any billing account of the vendor),
 *          updated_at = :now
 *    WHERE id = :vendorId AND verified <> EXISTS(...same...)
 *
 * It is idempotent and order-free: it reads the license rows the batch has just
 * written, so two batches against one vendor, applied in either order, leave
 * `verified` equal to the truth. The `<>` guard keeps the R2 rule
 * (`vendor-entitlement.ts`): `updated_at` moves IFF `verified` moves. It is the only
 * `vendors` statement this module emits, which is why `MIRROR_WRITE_EXEMPT` in
 * `eslint.config.base.mjs` lists this file beside `vendor-entitlement.ts` until E1.9
 * retires the old writer.
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
 * double-applied or resurrect an ended license. The pre-read is the no-op gate. As
 * in `vendor-entitlement.ts`, a race lost between the read and the commit leaves the
 * guarded UPDATE matching zero rows while its audit row still lands. That is the
 * accepted cost of D1 having no interactive transactions.
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
  LICENSE_REVOKED_REASON,
  LICENSE_SOURCES,
  licensePlanSnapshot,
  type LicenseEnding,
  type LicenseSource,
} from '@aeci/shared/entitlements';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts, licenses, vendors } from '../db/schema';
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
} as const;

/** The end action per ending. */
const END_ACTION: Record<LicenseEnding, string> = {
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

/** EXISTS(a live license on any billing account of the vendor). */
function liveLicenseExists(vendorId: string) {
  return sql`exists (select 1 from ${licenses} inner join ${billingAccounts} on ${billingAccounts.id} = ${licenses.billingAccountId} where ${billingAccounts.vendorId} = ${vendorId} and ${licenses.endedAt} is null)`;
}

/**
 * The mirror reconcile: the ONLY `vendors` statement this module emits, identical
 * across every builder. Idempotent; moves `updated_at` only when `verified` moves.
 * Exported for the reconcile's own tests and for E1.4's dual-write.
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
  source: LicenseSource;
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
  /** Caller-chosen ids (E1.5's back-fill uses UUIDv5). Length must equal `count`. */
  licenseIds?: readonly string[];
}

/**
 * Grant N licenses on a billing account (§3 step 5; E4.1, E9, E1.4's dual-write).
 * N INSERTs, one audit row each, then the reconcile. Every date is normalised.
 */
export function grantLicensesStatements(db: Db, p: GrantLicensesParams): LicenseBatch {
  if (!Number.isInteger(p.count) || p.count < 0) {
    throw new RangeError(`license count must be a non-negative integer: ${p.count}`);
  }
  if (p.count === 0) return NO_OP;
  if (!(LICENSE_SOURCES as readonly string[]).includes(p.source)) {
    throw new RangeError(`unknown license source: ${String(p.source)}`);
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
      source: p.source,
      startsAt,
      endsAt,
      endedAt: null,
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
 * (decision 11; E4.3). The license goes back to the pool, still live. Clears
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
 * vendor's: a no-op.
 */
export function setReleaseAtRenewalStatements(db: Db, p: SetReleaseAtRenewalParams): LicenseBatch {
  const before = findLicense(p, p.licenseId);
  if (!before || before.endedAt !== null || before.releaseAtRenewal === p.release) return NO_OP;

  const now = toIsoTimestamp(p.now);
  const after: LicenseBefore = { ...before, releaseAtRenewal: p.release };
  const stmt = db
    .update(licenses)
    .set({ releaseAtRenewal: p.release, updatedAt: now })
    .where(and(eq(licenses.id, before.id), isNull(licenses.endedAt)));
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
  /** Why (decision 15: a ban, an owner cancel). Written when `cancel`, cleared when not. */
  cancelReason?: string | null;
}

/**
 * Flag live licenses to end at term end instead of renewing (decision 15; E4.5 on a
 * ban, E9 on an owner cancel), or clear the flag. One statement and one audit row per
 * license that actually changes. Nothing changes: a no-op.
 */
export function setCancelAtTermEndStatements(db: Db, p: SetCancelAtTermEndParams): LicenseBatch {
  const now = toIsoTimestamp(p.now);
  const reason = p.cancel ? (p.cancelReason ?? null) : null;
  const action = p.cancel
    ? LICENSE_ACTION.cancelAtTermEndSet
    : LICENSE_ACTION.cancelAtTermEndCleared;

  const changed: LicenseBefore[] = [];
  const writes: { stmt: BatchStmt; entry: AuditLogEntry }[] = [];
  for (const id of new Set(p.licenseIds)) {
    const before = findLicense(p, id);
    if (!before || before.endedAt !== null) continue;
    if (before.cancelAtTermEnd === p.cancel && before.cancelReason === reason) continue;
    const after: LicenseBefore = { ...before, cancelAtTermEnd: p.cancel, cancelReason: reason };
    changed.push(after);
    const stmt = db
      .update(licenses)
      .set({ cancelAtTermEnd: p.cancel, cancelReason: reason, updatedAt: now })
      .where(and(eq(licenses.id, before.id), isNull(licenses.endedAt)));
    writes.push({ stmt, entry: licenseEntry(p, now, action, before, after) });
  }
  return assemble(db, p, now, writes, replaced(p, changed));
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
  /** How they end: E6 lapse, E4.4 release, E4.2 revoke. Picks the default action, and
   *  `revoked` stamps `cancel_reason` (see `LICENSE_ENDINGS`). */
  ending: LicenseEnding;
}

/**
 * End live licenses (terminal). Stamps `ended_at = now`. NEVER touches
 * `assigned_product_id`: an ended license keeps its product as history (decision 14),
 * and the product's edit right goes because the gate finds no live license. One
 * guarded `WHERE ended_at IS NULL` statement and one audit row per license, then the
 * reconcile, which drops `verified` when the last live license ends.
 *
 * No live target: a no-op. Re-ending an ended license is never possible: there is no
 * un-end, a new license is a new grant.
 */
export function endLicensesStatements(db: Db, p: EndLicensesParams): LicenseBatch {
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
  const revoked = p.ending === 'revoked';

  const changed: LicenseBefore[] = [];
  const writes: { stmt: BatchStmt; entry: AuditLogEntry }[] = [];
  for (const before of targets) {
    const after: LicenseBefore = {
      ...before,
      endedAt: now,
      ...(revoked ? { cancelReason: LICENSE_REVOKED_REASON } : {}),
    };
    changed.push(after);
    const stmt = db
      .update(licenses)
      .set({
        endedAt: now,
        ...(revoked ? { cancelReason: LICENSE_REVOKED_REASON } : {}),
        updatedAt: now,
      })
      .where(and(eq(licenses.id, before.id), isNull(licenses.endedAt)));
    const entry = licenseEntry(p, now, END_ACTION[p.ending], before, after);
    (entry.metadata as Record<string, unknown>).ending = p.ending;
    writes.push({ stmt, entry });
  }
  return assemble(db, p, now, writes, replaced(p, changed));
}
