/**
 * The license write module (AECI-1352, E1.3; `docs/VENDOR_SIGNUP_PROCESS.md` §2
 * decisions 5, 6, 11, 12, 14, 15 and §3 steps 5 to 7). The ONE module that writes
 * `licenses`: E4 (admin grants and approvals), E5 (vendor assignment), E6 (term end)
 * and E9 (Stripe) call these builders and add no second license writer. Two ops
 * lanes reach a deployed D1 only through raw SQL over `wrangler d1 execute`, so they
 * are the exceptions: the one-off E1.5 back-fill (`lib/backfill-licenses.ts`,
 * AECI-1354), which reuses {@link licenseTermsForEntitlement} so the two cannot map
 * one row two ways, and `ops:retract-product` (`lib/retract-product.ts`), which
 * unassigns a retracted product's licenses with `license.unassigned` rows in this
 * module's shape. The `DELETE /api/account` erasure batch (`routes/account.ts`) also
 * nulls `granted_by`, the AUTH_AND_RLS.md §8 rule for no-FK actor columns. Today the
 * only caller is the entitlement builders' dual-write (`lib/vendor-entitlement.ts`,
 * AECI-1353).
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
 * double-applied or resurrect an ended license. The pre-read is the no-op gate. A
 * race lost between the read and the commit leaves the guarded UPDATE matching zero
 * rows while its audit row still lands. That is the accepted cost of D1 having no
 * interactive transactions.
 *
 * `grantLicensesStatements` is the exception: its INSERTs have no guard, so two
 * grants from one pre-read both land. A caller must tie a grant to a write that can
 * only apply once. The entitlement activate does (AECI-1353): its reactivation
 * carries `entitlementActivatedSentinel` and its first grant the entitlement's
 * unique key, so the losing batch rolls back whole (`vendor-entitlement.ts`).
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
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

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
}

/**
 * Move the term of live licenses: `ends_at`, and optionally `source` and `reference`
 * (E1.4's dual-write of an entitlement renewal; E9's Stripe renewal later). One
 * guarded `WHERE ended_at IS NULL` statement and one `license.term_changed` audit row
 * per license that actually changes, then the reconcile. A license whose `ends_at`
 * moves gets `expiry_notice_sent_at` cleared: the expiry-notice fence is per term,
 * so a new term earns its own notice. Nothing changes: a no-op.
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
      .where(and(eq(licenses.id, before.id), isNull(licenses.endedAt)));
    writes.push({ stmt, entry: licenseEntry(p, now, LICENSE_ACTION.termChanged, before, after) });
  }
  return assemble(db, p, now, writes, replaced(p, changed));
}

// ─── The entitlement mapping (E1.4 dual-write, E1.5 back-fill) ──────────────

/** The `vendor_entitlements` columns the mapping reads. */
export interface EntitlementTermsInput {
  periodStart?: string | null;
  periodEnd: string | null;
  invoiceRef?: string | null;
  amount?: string | null;
}

/** A license's source, dates and reference, derived from an entitlement. */
export interface LicenseTerms {
  source: LicenseSource;
  /** The entitlement's `period_start`, normalised with {@link toIsoTimestamp}. `null`
   *  when it has none: the grant then starts at its own `now`. Only a grant reads it;
   *  re-terming a live license never moves `starts_at`. */
  startsAt: string | null;
  /** Normalised with {@link toIsoTimestamp}. `null` = open-ended. */
  endsAt: string | null;
  /** The entitlement's `invoice_ref`, or `null` when it has none. */
  reference: string | null;
}

/** A text column counts as set when it holds something other than whitespace. */
function isSet(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The one mapping from an entitlement row to the licenses that mirror it (ruling
 * 2026-10-14, `docs/VENDOR_SIGNUP_PROCESS.md` §2):
 *
 *  - `period_end` NULL → `complimentary`, `ends_at` NULL, whatever `invoice_ref` or
 *    `amount` say. A perpetual invoice row must not read as "invoice, monthly".
 *  - otherwise → `invoice` when `invoice_ref` or `amount` is set, else
 *    `complimentary`; `ends_at` = `period_end`.
 *
 * `starts_at` is `period_start` when set (ruling 2026-10-14, orchestrator), else the
 * grant time. `reference` is the `invoice_ref` in both cases. E1.4's dual-write and E1.5's
 * back-fill both call this, so the two cannot map one row two ways.
 */
export function licenseTermsForEntitlement(e: EntitlementTermsInput): LicenseTerms {
  const reference = isSet(e.invoiceRef) ? e.invoiceRef : null;
  const startsAt = isSet(e.periodStart) ? toIsoTimestamp(e.periodStart) : null;
  if (e.periodEnd === null || e.periodEnd === undefined) {
    return { source: 'complimentary', startsAt, endsAt: null, reference };
  }
  const invoiced = isSet(e.invoiceRef) || isSet(e.amount);
  return {
    source: invoiced ? 'invoice' : 'complimentary',
    startsAt,
    endsAt: toIsoTimestamp(e.periodEnd),
    reference,
  };
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
}

/**
 * End live licenses (terminal). Stamps `ended_at = now` and `end_reason`. NEVER touches
 * `assigned_product_id`: an ended license keeps its product as history (decision 14),
 * and the product's edit right goes because the gate finds no live license. Nor
 * `cancel_reason`, which records why a live license was set not to renew. One guarded
 * `WHERE ended_at IS NULL` statement and one audit row per license, then the
 * reconcile, which drops `verified` when the last live license ends.
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

  const changed: LicenseBefore[] = [];
  const writes: { stmt: BatchStmt; entry: AuditLogEntry }[] = [];
  for (const before of targets) {
    const after: LicenseBefore = { ...before, endedAt: now, endReason: p.endReason };
    changed.push(after);
    const stmt = db
      .update(licenses)
      .set({ endedAt: now, endReason: p.endReason, updatedAt: now })
      .where(and(eq(licenses.id, before.id), isNull(licenses.endedAt)));
    writes.push({ stmt, entry: licenseEntry(p, now, END_ACTION[p.endReason], before, after) });
  }
  return assemble(db, p, now, writes, replaced(p, changed));
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
