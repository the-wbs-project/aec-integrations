/**
 * The `vendor_entitlements` ↔ `vendors.verified` mirror — the SOLE writer of either
 * side (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.1/§2.3). During the license
 * transition `lib/license.ts` is a second writer of `verified` only, through its
 * mirror reconcile (AECI-1352), and this module leaves `MIRROR_WRITE_EXEMPT` at E1.9.
 *
 * AECI-1375 retired the admin set / renew / clear route (`PATCH /api/admin/vendors/:id/
 * entitlement`), so the activate, renew and deactivate builders below have no route
 * caller left; the claim approval still reads `loadEntitlement`. "The §5 handler" in
 * the notes below is that retired route. E1.9 deletes this module with the table.
 *
 * D1 has no interactive transactions — only atomic `db.batch([...])`. Like
 * `lib/audit.ts` and `lib/vendor-grant.ts`, each builder RETURNS the Drizzle
 * statements (plus the audit entry the caller forwards post-commit — §26.5, PostHog
 * beside Datadog for the AECI-639 dual-run)
 * rather than executing them, so the entitlement row, the mirror flip, and the
 * `audit_log` row all commit or roll back as one unit (§26.1 — no state change
 * without an audit row).
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────────
 * `vendors.verified = true` IFF a `vendor_entitlements` row exists with
 * `status = 'active'`. This module never emits one side of that *iff* without the
 * other. `vendor_entitlements_vendor_key` is UNIQUE, which is what lets each write be
 * a guarded single-row `UPDATE … WHERE <current state>` and therefore safe under
 * concurrency without a transaction. An ESLint `no-restricted-syntax` rule
 * (`eslint.config.base.mjs`) rejects a `.set({ verified })` / `.values({ verified })`
 * on `vendors` anywhere else (Guard 1). The run-time backstop (Guard 2) is
 * `license_mirror_drift` (`lib/data-quality.ts`, 04:00 UTC), which checks the bit
 * against live licenses. `entitlement_mirror_drift` was retired 2026-10-17 (AECI-1375).
 *
 * ── `vendors.updated_at` MOVES IFF `vendors.verified` MOVES (R2) ────────────────
 * It is stamped EXPLICITLY, never left to `$onUpdate`, and it rides inside the same
 * guarded `WHERE verified = <old>` — so a second-seat grant, a renewal, and a
 * drifted self-heal all leave it alone (no needless nightly Algolia re-push), while a
 * real flip in EITHER direction bumps it. Since AECI-1266 the Algolia vendor record
 * carries no `verified` field, so the bump no longer serves its freshness. It stays
 * because the vendor portal's `GET /api/vendor/updates` cursor reads `updated_at` and
 * the portal shows the mirror (`api/vendor-updates.ts`), and because the R2 rule is
 * cheap to keep and costly to re-derive.
 *
 * ── NO WORKFLOW ROW ────────────────────────────────────────────────────────────
 * Entitlement changes write no `workflow_instances` row. `workflow_instances_type_check`
 * is a closed CHECK and opening it on SQLite is a full table rebuild (§1.2 / R1). That
 * is why the return type is `EntitlementBatch` and not `ClaimBatch` — there is no
 * `workflowEntry` field to tempt anyone.
 *
 * ── SEAM FOR §5 (AECI-532) ─────────────────────────────────────────────────────
 * `renewEntitlementStatements` (added by AECI-532) writes term + arrangement columns
 * on an ALREADY-active row and emits no guarded `vendors` flip, because the mirror
 * does not move on a renewal (R2). `activate` cannot serve that case — per the §2.3
 * matrix an already-active row emits nothing at all.
 *
 * ── THE DUAL-WRITE (AECI-1353, E1.4) ───────────────────────────────────────────
 * Until the switch-over (E1.6), `vendor_entitlements` stays the readers' truth and
 * `billing_accounts` + `licenses` must match it. Each builder therefore also emits
 * the matching `lib/license.ts` batch, in the SAME `db.batch`, after its own
 * statements and audit row:
 *
 *   | builder    | license side                                                  |
 *   |------------|---------------------------------------------------------------|
 *   | activate   | ensure the billing account, then grant one license per owned  |
 *   |            | product (min 1, unassigned); or re-term live ones, never a    |
 *   |            | second grant                                                  |
 *   | renew      | re-term the live licenses (`ends_at`, `source`, `reference`)  |
 *   | deactivate | end the live licenses: `revoked` → `revoked`, `expired` →     |
 *   |            | `lapsed`                                                      |
 *
 * Source and `ends_at` follow `licenseTermsForEntitlement` (the 2026-10-14 mapping
 * rule). Every license batch ends with `reconcileVerifiedMirror`, which sets
 * `verified = EXISTS(live license)`. It runs AFTER this module's guarded flip, and
 * both converge on the same value, so the reconcile matches no row and
 * `vendors.updated_at` still moves exactly once, with the bit (R2). The license rows
 * carry their own audit rows (`entity_type = 'billing_account'`), returned in
 * `licenseAuditEntries` for the caller to forward. A no-op entitlement write is a
 * no-op on both sides. `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.3.
 *
 * ── A LOST ACTIVATE RACE WRITES NOTHING (AECI-1353) ────────────────────────────
 * A reactivation's entitlement UPDATE is guarded on `status <> 'active'`, but the
 * license INSERTs that follow it are not guarded on anything. Two `set`s (or two
 * Managed claim approvals) built from one pre-read of a revoked vendor would both
 * grant: the loser's UPDATE matches no row while its licenses still land, which
 * leaves two sets of live licenses, or trips `licenses_live_product_idx`. So the
 * reactivation branch puts {@link entitlementActivatedSentinel} directly after its
 * UPDATE, and the loser's whole batch rolls back. The caller answers
 * `409 ENTITLEMENT_CHANGED` ({@link isEntitlementChangedError}). The INSERT branch
 * needs no sentinel: the loser's second INSERT trips `vendor_entitlements_vendor_key`
 * and rolls its batch back on its own, and the same predicate recognises that error.
 * Renew and deactivate keep no sentinel. Their license writes are UPDATEs guarded on
 * `ended_at IS NULL`, so a lost race changes no license, and only the audit rows the
 * `license.ts` header accepts land.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, ne, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { vendorEntitlements, vendors } from '../db/schema';
import { ApiError } from '../errors';
import { auditInsert, type BatchStmt } from './audit';
import {
  ensureBillingAccountStatements,
  loadBillingAccount,
  type BillingAccountBefore,
} from './billing-account';
import { ONE_ROW } from './integration-claims';
import {
  endLicensesStatements,
  grantLicensesStatements,
  licenseTermsForEntitlement,
  loadOwnedProductLicenseState,
  loadVendorLicenses,
  setLicensesTermStatements,
  type LicenseBatch,
  type LicenseBefore,
  type LicenseWriteContext,
  type OwnedProductLicenseState,
} from './license';
import { vendorPlanSnapshot } from '@aeci/shared/entitlements';

/** The one status that mirrors onto `vendors.verified`. */
const ACTIVE = 'active';

/**
 * `audit_log.entity_type` for every row this module writes. `entity_type` is
 * deliberately unconstrained (see the `auditLog` schema comment), so this costs
 * nothing. `entity_id` is the VENDOR id, NOT the entitlement row id — §2.1 makes
 * `audit_log_entity_idx` (entity_type, entity_id, created_at) the history ledger, and
 * that only works if every row in a vendor's grant/renew/lapse trail shares a key.
 */
export const ENTITLEMENT_ENTITY_TYPE = 'vendor_entitlement';

/** Default `metadata.source`. The claim path (§6) passes `'admin-moderation'` so its
 *  two audit rows share a tag; the §5 endpoint takes this default. */
const ENTITLEMENT_AUDIT_SOURCE = 'admin-entitlement';

/** Default audit actions, matching the §5 vocabulary. */
export const ENTITLEMENT_ACTION = {
  set: 'vendor_entitlement.set',
  renewed: 'vendor_entitlement.renewed',
  cleared: 'vendor_entitlement.cleared',
} as const;

/**
 * The offline PO/invoice arrangement, in WIRE (snake_case) shape — a structural
 * superset of `ClaimEntitlement` (`@aeci/shared`), so §6 can pass the claim body
 * through unchanged and §5 can pass its Zod-parsed body unchanged.
 */
export interface EntitlementArrangement {
  payer?: string;
  amount?: string;
  terms?: string;
  arranged_by?: string;
  invoice_ref?: string;
  notes?: string;
  period_start?: string;
  period_end?: string;
}

/** The preloaded `vendor_entitlements` row — the columns the TS branch and the audit
 *  before-state need. `null` = the vendor has never had an entitlement. */
export interface EntitlementBefore {
  id: string;
  tier: string;
  status: string;
  periodEnd: string | null;
  /** Read by the renew dual-write, which maps the term AFTER a partial patch onto the
   *  licenses (`licenseTermsForEntitlement`). Optional so a hand-built fixture with
   *  no arrangement still type-checks; `loadEntitlement` always fills them. */
  invoiceRef?: string | null;
  amount?: string | null;
}

/**
 * The license-side pre-read every builder takes during the dual-write period
 * (AECI-1353, E1.4). `loadLicenseDualWrite` returns exactly this.
 */
export interface LicenseDualWriteBefore {
  /** The vendor's billing account. `null` = none yet: activate creates it. */
  billingAccount: BillingAccountBefore | null;
  /** Every license on the vendor's billing accounts (`loadVendorLicenses`). */
  vendorLicenses: readonly LicenseBefore[];
  /** The vendor's owned products, and whether a live license already holds each. */
  ownedProducts: readonly OwnedProductLicenseState[];
}

/**
 * Statements + the forwarding entry an entitlement write produces. Mirrors
 * `ClaimBatch` (`lib/vendor-grant.ts`) with two deliberate differences: `auditEntry`
 * is NULLABLE (a no-op writes nothing, so §26.1 requires no row) and there is no
 * `workflowEntry` at all (§1.2 / R1).
 */
export interface EntitlementBatch {
  stmts: BatchStmt[];
  /** `null` on the no-op paths (§2.3 row 2). Nothing changed, so nothing to audit
   *  and nothing to forward. */
  auditEntry: AuditLogEntry | null;
  /** Whether the guarded `vendors` UPDATE will actually move the bit. Drives the
   *  response body and whether the caller enqueues the Cache-Tag purge. */
  verifiedFlipped: boolean;
  /** INSERT (true) vs guarded UPDATE (false). Feeds `ClaimGrantSummary.entitlement_created`
   *  in §6. */
  entitlementCreated: boolean;
  /** An inactive row was flipped back to `active` (a re-claim after revoke). */
  reactivated: boolean;
  /** The dual-write's audit rows, in batch order: the `billing_account.created` row
   *  when activate created the account, then one row per license written. The caller
   *  forwards them post-commit beside `auditEntry`. Empty when nothing license-side
   *  changed. */
  licenseAuditEntries: AuditLogEntry[];
  /** The id of the billing account this batch CREATES, or `null` when it creates
   *  none. A caller that also composes `ensureBillingAccountStatements` (the claim
   *  approval) passes it as that builder's `existing`, so exactly one account INSERT
   *  lands in the batch. */
  billingAccountCreatedId: string | null;
  /** The batch carries {@link entitlementActivatedSentinel}: a reactivation that
   *  aborts when another writer activated the row first. A caller that sees the
   *  batch fail checks {@link isEntitlementChangedError} and answers
   *  {@link entitlementChangedError}. */
  raceGuarded: boolean;
}

/** The shared no-op result. Frozen, arrays included, so a caller cannot mutate it. */
const NO_OP: EntitlementBatch = Object.freeze({
  stmts: Object.freeze([]) as unknown as BatchStmt[],
  auditEntry: null,
  verifiedFlipped: false,
  entitlementCreated: false,
  reactivated: false,
  licenseAuditEntries: Object.freeze([]) as unknown as AuditLogEntry[],
  billingAccountCreatedId: null,
  raceGuarded: false,
});

/** The token {@link entitlementActivatedSentinel} raises on. */
const ENTITLEMENT_CHANGED_TOKEN = 'entitlement-changed';

/**
 * A batch statement that ABORTS an activate whose guarded UPDATE matched no row. Put
 * it directly after that UPDATE: `changes()` reads the statement before it. It fires
 * when another activate committed between this batch's pre-read and its commit, so
 * the license grant behind it cannot land a second set of licenses.
 *
 * `json('entitlement-changed')` is malformed JSON, so the whole batch rolls back.
 * Same mechanism as `claimRaceSentinel` (`lib/integration-claims.ts`), and FROM a
 * one-row constant for the same reason: the guard always evaluates exactly once.
 */
export function entitlementActivatedSentinel(db: Db): BatchStmt {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${ENTITLEMENT_CHANGED_TOKEN}) END` })
    .from(ONE_ROW);
}

/**
 * True for the error a lost activate race raises, in D1 or SQLite: the
 * {@link entitlementActivatedSentinel} abort on the reactivation branch, or the
 * `vendor_entitlements_vendor_key` violation on the INSERT branch. SQLite reports
 * the sentinel only as "malformed JSON", so a caller must use this only on a batch
 * whose other statements call `json()` nowhere, or disambiguate first
 * (`routes/admin-claims.ts` re-reads the row).
 */
export function isEntitlementChangedError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(ENTITLEMENT_CHANGED_TOKEN)) return true;
    if (/UNIQUE constraint failed: vendor_entitlements\.vendor_id/i.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** `409 ENTITLEMENT_CHANGED`: another writer activated the entitlement first, and
 *  this batch wrote nothing. */
export function entitlementChangedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.ENTITLEMENT_CHANGED,
    "This vendor's entitlement changed while the request ran, so nothing was saved. Reload and try again.",
  );
}

export interface ActivateEntitlementParams {
  vendorId: string;
  /** Capability-registry tier id. `'verified'` is the launch entry rung (§3.1). */
  tier: string;
  /** ISO timestamp for `granted_at`, `updated_at`, and the mirror stamp. */
  now: string;
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
  /** The preloaded row (`loadEntitlement`). ACTIVE → the whole call is a no-op. */
  existing: EntitlementBefore | null;
  /** The vendor's `verified` BEFORE the write. Drives `verified_flipped`, and lets a
   *  drifted `verified = 1`-with-no-row vendor self-heal without churning `updated_at`. */
  vendorWasVerified: boolean;
  /** `profiles.id` of the granting admin — one of the ten inbound FKs to
   *  `profiles` (R6). `AUTH_AND_RLS.md` §8 is the live register; count it there
   *  rather than here, because an ordinal in a comment goes stale every time a
   *  table is added (this one has already been renumbered twice). */
  grantedBy?: string | null;
  /** The claim this came from, when it came from one (§6). */
  sourceRequestId?: string | null;
  arrangement?: EntitlementArrangement;
  /** Override the audit action (the claim path uses its own vocabulary). */
  action?: string;
  /** Override `metadata.source`. */
  source?: string;
  reason?: string | null;
  /** Extra audit metadata, merged after the built-in keys. The claim path passes
   *  `{ plan: 'managed' }` so both of its audit rows carry the plan (AECI-1215). */
  extraMetadata?: Record<string, unknown>;
  /** The license-side pre-read (`loadLicenseDualWrite`). */
  licenses: LicenseDualWriteBefore;
  /** The vendor's company name: the name of a billing account this batch creates. */
  vendorName: string;
}

export interface RenewEntitlementParams {
  vendorId: string;
  now: string;
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
  /** The preloaded row. Anything but ACTIVE → the whole call is a no-op (the §5
   *  handler maps that to 422 — there is no term to extend). */
  existing: EntitlementBefore | null;
  /** Only the keys PRESENT are written (see `partialArrangementColumns`). */
  arrangement?: EntitlementArrangement;
  action?: string;
  source?: string;
  reason?: string | null;
  /** The license-side pre-read (`loadLicenseDualWrite`). Only `vendorLicenses` is read. */
  licenses: LicenseDualWriteBefore;
}

export interface DeactivateEntitlementParams {
  vendorId: string;
  /** `'expired'` = term lapsed amicably; `'revoked'` = pulled for cause. `'pending'`
   *  is not a terminal state and is deliberately not reachable from here. */
  terminal: 'expired' | 'revoked';
  now: string;
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
  existing: EntitlementBefore | null;
  vendorWasVerified: boolean;
  action?: string;
  source?: string;
  reason?: string | null;
  /** The license-side pre-read (`loadLicenseDualWrite`). Only `vendorLicenses` is read. */
  licenses: LicenseDualWriteBefore;
}

/**
 * Preload the vendor's entitlement row. The ONE read this module owns, so §5, §6 and
 * §8 do not each re-derive the `findFirst` (the duplicated-construction failure §2.5
 * calls out for cache tags). Single-row lookup on `vendor_entitlements_vendor_key`.
 */
export async function loadEntitlement(db: Db, vendorId: string): Promise<EntitlementBefore | null> {
  const row = await db.query.vendorEntitlements.findFirst({
    columns: {
      id: true,
      tier: true,
      status: true,
      periodEnd: true,
      invoiceRef: true,
      amount: true,
    },
    where: eq(vendorEntitlements.vendorId, vendorId),
  });
  return row ?? null;
}

/**
 * Pre-read the license side of the dual-write: the billing account, every license on
 * it, and the owned products with their live-license state. One wave of three reads.
 */
export async function loadLicenseDualWrite(
  db: Db,
  vendorId: string,
): Promise<LicenseDualWriteBefore> {
  const [billingAccount, vendorLicenses, ownedProducts] = await Promise.all([
    loadBillingAccount(db, vendorId),
    loadVendorLicenses(db, vendorId),
    loadOwnedProductLicenseState(db, vendorId),
  ]);
  return { billingAccount, vendorLicenses, ownedProducts };
}

/** The ids of the vendor's live licenses in the pre-read. */
function liveLicenseIds(d: LicenseDualWriteBefore): string[] {
  return d.vendorLicenses.filter((l) => l.endedAt === null).map((l) => l.id);
}

/** Tag every dual-write license audit row, so the ledger says why the license moved. */
const DUAL_WRITE_METADATA = { dual_write: 'vendor_entitlement' } as const;

/** Map the wire arrangement onto the table's columns. Every key is written (as null
 *  when absent) so a re-activation cannot inherit a stale previous term. */
function arrangementColumns(a: EntitlementArrangement) {
  return {
    payer: a.payer ?? null,
    amount: a.amount ?? null,
    terms: a.terms ?? null,
    arrangedBy: a.arranged_by ?? null,
    invoiceRef: a.invoice_ref ?? null,
    notes: a.notes ?? null,
    periodStart: a.period_start ?? null,
    periodEnd: a.period_end ?? null,
  };
}

/**
 * Map only the arrangement keys the caller actually PROVIDED onto columns — the
 * deliberate divergence from `arrangementColumns`, which writes every key (as null
 * when absent).
 *
 * Activate needs the write-everything shape so a re-activation cannot inherit a stale
 * previous term. Renew needs the opposite: an admin extending a term sends
 * `{ period_end }` and must not thereby wipe the `invoice_ref` and `payer` recorded at
 * grant time. `undefined` (key absent from the Zod-parsed body) means "leave alone";
 * an explicitly-sent empty string is a value like any other.
 */
function partialArrangementColumns(a: EntitlementArrangement) {
  const map = {
    payer: a.payer,
    amount: a.amount,
    terms: a.terms,
    arrangedBy: a.arranged_by,
    invoiceRef: a.invoice_ref,
    notes: a.notes,
    periodStart: a.period_start,
    periodEnd: a.period_end,
  };
  return Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined)) as Partial<
    Record<keyof typeof map, string>
  >;
}

/**
 * The ACTIVATE batch (§2.3). Three preloaded branches, chosen in TS — NOT
 * `onConflictDoUpdate`, so the second-seat case emits genuinely nothing:
 *
 *   | preloaded state       | entitlement stmts       | `vendors` stmts    |
 *   |-----------------------|-------------------------|--------------------|
 *   | no row                | INSERT                  | guarded flip → 1   |
 *   | row `active`          | NONE                    | NONE               |
 *   | row exists, inactive  | guarded UPDATE → active | guarded flip → 1   |
 *
 * Row 2 is the critical one: an INSERT there would violate
 * `vendor_entitlements_vendor_key` and ROLL BACK THE ENTIRE SEAT GRANT. Preloading and
 * emitting nothing is what keeps `admin-claims.spec.ts`'s second-seat assertions
 * (`vendor.updatedAt === OLD_TS`) passing byte-for-byte.
 *
 * The `vendors` flip is guarded on `verified = false`, so a DRIFTED vendor
 * (`verified = 1` with no entitlement row — the pre-backfill state) gets its row
 * without a needless `updated_at` bump. That is R2's "a write that does not move the
 * mirror must not move the Algolia watermark".
 */
export function activateEntitlementStatements(
  db: Db,
  p: ActivateEntitlementParams,
): EntitlementBatch {
  // §2.3 row 2 — already active. Zero statements, null audit entry, no purge.
  if (p.existing?.status === ACTIVE) return NO_OP;

  const a = p.arrangement ?? {};
  const columns = arrangementColumns(a);
  const reactivated = p.existing !== null;
  const entitlementCreated = !reactivated;
  const verifiedFlipped = !p.vendorWasVerified;

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: p.action ?? ENTITLEMENT_ACTION.set,
    entityType: ENTITLEMENT_ENTITY_TYPE,
    entityId: p.vendorId,
    // AECI-1192 / AECI-1193: the plan BEFORE this write; after_state holds the new one.
    vendorId: p.vendorId,
    vendorPlan: vendorPlanSnapshot(p.existing, p.now),
    beforeState: {
      tier: p.existing?.tier ?? null,
      status: p.existing?.status ?? null,
      period_end: p.existing?.periodEnd ?? null,
      vendor_verified: p.vendorWasVerified,
    },
    afterState: {
      tier: p.tier,
      status: ACTIVE,
      period_end: columns.periodEnd,
      vendor_verified: true,
    },
    metadata: {
      source: p.source ?? ENTITLEMENT_AUDIT_SOURCE,
      vendorId: p.vendorId,
      verified_flipped: verifiedFlipped,
      entitlement_created: entitlementCreated,
      ...(reactivated ? { reactivated: true } : {}),
      ...(Object.keys(a).length > 0 ? { arrangement: a } : {}),
      ...(p.sourceRequestId ? { source_request_id: p.sourceRequestId } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
      ...p.extraMetadata,
    },
  };

  const entitlementStmt: BatchStmt = entitlementCreated
    ? db.insert(vendorEntitlements).values({
        vendorId: p.vendorId,
        tier: p.tier,
        status: ACTIVE,
        grantedBy: p.grantedBy ?? null,
        grantedAt: p.now,
        sourceRequestId: p.sourceRequestId ?? null,
        createdAt: p.now,
        updatedAt: p.now,
        ...columns,
      })
    : db
        .update(vendorEntitlements)
        .set({
          tier: p.tier,
          status: ACTIVE,
          // Re-activation clears the terminal stamp AND the §7 idempotency fence, so
          // the new term earns its own expiry notice.
          endedAt: null,
          expiryNoticeSentAt: null,
          grantedBy: p.grantedBy ?? null,
          grantedAt: p.now,
          sourceRequestId: p.sourceRequestId ?? null,
          updatedAt: p.now,
          ...columns,
        })
        // Guarded on the CURRENT state, so a concurrent activate cannot double-apply.
        .where(
          and(eq(vendorEntitlements.vendorId, p.vendorId), ne(vendorEntitlements.status, ACTIVE)),
        );

  // ── The dual-write (AECI-1353) ─────────────────────────────────────────────
  // The account first, so the license INSERTs below find their FK parent.
  const account = ensureBillingAccountStatements(db, {
    vendorId: p.vendorId,
    name: p.vendorName,
    createdBy: p.actorId,
    actorType: p.actorType,
    existing: p.licenses.billingAccount,
    now: p.now,
    vendorPlan: vendorPlanSnapshot(p.existing, p.now),
    source: p.source ?? ENTITLEMENT_AUDIT_SOURCE,
    sourceRequestId: p.sourceRequestId ?? null,
  });
  const billingAccountId = p.licenses.billingAccount?.id ?? account.billingAccountId;
  if (billingAccountId === null) {
    // Unreachable: ensure returns an id whenever `existing` is null.
    throw new Error('activateEntitlementStatements: no billing account to grant on');
  }
  const terms = licenseTermsForEntitlement({
    periodStart: columns.periodStart,
    periodEnd: columns.periodEnd,
    invoiceRef: columns.invoiceRef,
    amount: columns.amount,
  });
  const licenseCtx = dualWriteContext(p, p.vendorWasVerified);
  const live = liveLicenseIds(p.licenses);
  // Never a double grant. A vendor that already holds live licenses (a reactivation
  // whose old licenses were never ended, or licenses granted by another path) keeps
  // them, re-termed to this activation's arrangement, so they still equal the row.
  const licenseBatch: LicenseBatch =
    live.length > 0
      ? setLicensesTermStatements(db, {
          ...licenseCtx,
          licenseIds: live,
          endsAt: terms.endsAt,
          licenseSource: terms.source,
          reference: terms.reference,
        })
      : grantLicensesStatements(db, {
          ...licenseCtx,
          billingAccountId,
          // One per owned product, at least one (unassigned) when it owns none.
          count: Math.max(1, p.licenses.ownedProducts.length),
          licenseSource: terms.source,
          // `period_start` when the row has one, else the grant time.
          ...(terms.startsAt ? { startsAt: terms.startsAt } : {}),
          endsAt: terms.endsAt,
          reference: terms.reference,
          grantedBy: p.grantedBy ?? null,
          // A product another account's live license already holds stays unassigned:
          // the partial unique index would otherwise roll back the whole batch.
          productIds: p.licenses.ownedProducts.filter((o) => !o.licensed).map((o) => o.productId),
        });

  // Order is load-bearing. The entitlement statements and their audit row come first,
  // so the `vendors` flip below runs before the license reconcile. Both land on
  // `verified = true`: the flip moves the bit (and `updated_at`), and the reconcile
  // then finds `verified` equal to EXISTS(live license) and matches no row (R2).
  //
  // The sentinel sits directly after a reactivation's guarded UPDATE, before any
  // license statement: a lost race aborts the batch instead of granting a second set.
  const stmts: BatchStmt[] = [
    entitlementStmt,
    ...(reactivated ? [entitlementActivatedSentinel(db)] : []),
    db
      .update(vendors)
      .set({ verified: true, updatedAt: p.now })
      .where(and(eq(vendors.id, p.vendorId), eq(vendors.verified, false))),
    auditInsert(db, auditEntry),
    ...account.stmts,
    ...licenseBatch.stmts,
  ];

  return {
    stmts,
    auditEntry,
    verifiedFlipped,
    entitlementCreated,
    reactivated,
    licenseAuditEntries: [
      ...(account.auditEntry ? [account.auditEntry] : []),
      ...licenseBatch.auditEntries,
    ],
    billingAccountCreatedId: account.billingAccountId,
    raceGuarded: reactivated,
  };
}

/** The license builders' context for one entitlement write. */
function dualWriteContext(
  p: {
    vendorId: string;
    now: string;
    actorId: string | null;
    actorType: AuditLogEntry['actorType'];
    source?: string;
    reason?: string | null;
    licenses: LicenseDualWriteBefore;
  },
  vendorWasVerified: boolean,
): LicenseWriteContext {
  return {
    vendorId: p.vendorId,
    now: p.now,
    actorId: p.actorId,
    actorType: p.actorType,
    vendorLicenses: p.licenses.vendorLicenses,
    vendorWasVerified,
    // The license rows carry the entitlement row's `metadata.source`, so one action
    // reads as one action across both ledgers.
    source: p.source ?? ENTITLEMENT_AUDIT_SOURCE,
    reason: p.reason ?? null,
    extraMetadata: { ...DUAL_WRITE_METADATA },
  };
}

/**
 * The RENEW batch (§5 / AECI-532) — extend the term of an ALREADY-active entitlement.
 *
 * Two properties make this a separate builder rather than a flag on `activate`:
 *
 *  1. **It emits no guarded `vendors` flip.** The mirror is already `true` and stays
 *     `true`, so there is nothing to flip — and per R2 a write that does not move the
 *     mirror must not move `vendors.updated_at` either, or every renewal schedules a
 *     needless nightly Algolia re-push of an unchanged record. This is why the module's
 *     *iff* is not violated by a builder that touches only one table: it touches
 *     NEITHER side of the mirror, it edits the term the active row carries. The one
 *     `vendors` statement it can carry is the dual-write's license reconcile, when the
 *     vendor has live licenses to re-term. That statement is guarded on
 *     `verified <> EXISTS(live license)`, so on an active row it matches nothing.
 *  2. **It patches, it does not replace.** `activate` writes every arrangement column
 *     (null when absent) so a re-activation cannot inherit a stale term; renew writes
 *     only the keys supplied, so extending a term keeps the PO reference recorded at
 *     grant time. See `partialArrangementColumns`.
 *
 * A missing or non-active row is a NO-OP — `activate` is the builder for that case, and
 * the §5 handler 422s rather than silently promoting a renew into a grant.
 *
 * `expiry_notice_sent_at` is cleared **only when a new `period_end` is supplied**: the
 * §7 fence is per-TERM, so a new term must earn its own notice, while an
 * arrangement-only edit (correcting an invoice ref) must not re-arm a warning the
 * vendor already received.
 */
export function renewEntitlementStatements(db: Db, p: RenewEntitlementParams): EntitlementBatch {
  if (p.existing === null || p.existing.status !== ACTIVE) return NO_OP;

  const a = p.arrangement ?? {};
  const columns = partialArrangementColumns(a);
  const newPeriodEnd = columns.periodEnd ?? p.existing.periodEnd;

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: p.action ?? ENTITLEMENT_ACTION.renewed,
    entityType: ENTITLEMENT_ENTITY_TYPE,
    entityId: p.vendorId,
    // AECI-1192 / AECI-1193: the plan BEFORE this write; after_state holds the new one.
    vendorId: p.vendorId,
    vendorPlan: vendorPlanSnapshot(p.existing, p.now),
    beforeState: {
      tier: p.existing.tier,
      status: ACTIVE,
      period_end: p.existing.periodEnd,
      // Unchanged by construction — stated on both sides so the ledger reads the same
      // for a renewal as for a grant.
      vendor_verified: true,
    },
    afterState: {
      tier: p.existing.tier,
      status: ACTIVE,
      period_end: newPeriodEnd,
      vendor_verified: true,
    },
    metadata: {
      source: p.source ?? ENTITLEMENT_AUDIT_SOURCE,
      vendorId: p.vendorId,
      // Explicit: a renewal never moves the mirror, so it never moves the Algolia
      // watermark either (R2).
      verified_flipped: false,
      entitlement_created: false,
      ...(Object.keys(a).length > 0 ? { arrangement: a } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
    },
  };

  // ── The dual-write (AECI-1353) ─────────────────────────────────────────────
  // Map the row as it will stand AFTER this patch onto the vendor's live licenses:
  // `ends_at`, `source` and `reference` follow the mapping rule. A vendor with no live
  // license (an entitlement the E1.5 back-fill has not reached yet) gets nothing
  // here: renew extends a term, it never grants. `vendorWasVerified` is `true`
  // because renew only runs on an active row, whose mirror is true (the prediction
  // only; the reconcile reads the real bit).
  const has = (key: keyof typeof columns) => columns[key] !== undefined;
  const terms = licenseTermsForEntitlement({
    periodEnd: newPeriodEnd,
    invoiceRef: has('invoiceRef') ? columns.invoiceRef : (p.existing.invoiceRef ?? null),
    amount: has('amount') ? columns.amount : (p.existing.amount ?? null),
  });
  const licenseBatch = setLicensesTermStatements(db, {
    ...dualWriteContext(p, true),
    licenseIds: liveLicenseIds(p.licenses),
    endsAt: terms.endsAt,
    licenseSource: terms.source,
    reference: terms.reference,
  });

  const stmts: BatchStmt[] = [
    db
      .update(vendorEntitlements)
      .set({
        ...columns,
        ...(columns.periodEnd !== undefined ? { expiryNoticeSentAt: null } : {}),
        updatedAt: p.now,
      })
      // Guarded on the CURRENT state: a concurrent clear wins and the renew no-ops
      // rather than resurrecting the term on a row that just went terminal.
      .where(
        and(eq(vendorEntitlements.vendorId, p.vendorId), eq(vendorEntitlements.status, ACTIVE)),
      ),
    auditInsert(db, auditEntry),
    // The license reconcile rides at the end. It cannot move the mirror of an active
    // row with live licenses, so `vendors.updated_at` stays put (R2).
    ...licenseBatch.stmts,
  ];

  return {
    stmts,
    auditEntry,
    verifiedFlipped: false,
    entitlementCreated: false,
    reactivated: false,
    licenseAuditEntries: licenseBatch.auditEntries,
    billingAccountCreatedId: null,
    raceGuarded: false,
  };
}

/**
 * The DEACTIVATE batch (§2.3): guarded `UPDATE … WHERE status = 'active'` + guarded
 * `UPDATE vendors … WHERE verified = 1` + the audit row, in one batch.
 *
 * A missing or already-inactive row is a NO-OP — the §5 handler maps that to a 422
 * `INVALID_STATE_TRANSITION` idempotency response. It deliberately does NOT "self-heal"
 * a drifted `verified = 1` with no active row by clearing the bit: that would be a
 * mirror write with no entitlement transition behind it. Down-drift is repaired by the
 * `ops:backfill-entitlements` script (§2.4), which the `entitlement_mirror_drift` check
 * existed to demand until AECI-1375 retired it.
 *
 * NOTE the asymmetry with a SEAT revoke (`revokeSeatStatements`): clearing an
 * entitlement does NOT revoke seats. Logins and the dashboard survive, read-only
 * (§5.2). These are three orthogonal "take it away" actions and confusing them is a
 * foreseeable incident.
 */
export function deactivateEntitlementStatements(
  db: Db,
  p: DeactivateEntitlementParams,
): EntitlementBatch {
  if (p.existing === null || p.existing.status !== ACTIVE) return NO_OP;

  const verifiedFlipped = p.vendorWasVerified;

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: p.action ?? ENTITLEMENT_ACTION.cleared,
    entityType: ENTITLEMENT_ENTITY_TYPE,
    entityId: p.vendorId,
    // AECI-1192 / AECI-1193: the plan BEFORE this write; after_state holds the new one.
    vendorId: p.vendorId,
    vendorPlan: vendorPlanSnapshot(p.existing, p.now),
    beforeState: {
      tier: p.existing.tier,
      status: ACTIVE,
      period_end: p.existing.periodEnd,
      vendor_verified: p.vendorWasVerified,
    },
    afterState: {
      tier: p.existing.tier,
      status: p.terminal,
      period_end: p.existing.periodEnd,
      vendor_verified: false,
    },
    metadata: {
      source: p.source ?? ENTITLEMENT_AUDIT_SOURCE,
      vendorId: p.vendorId,
      verified_flipped: verifiedFlipped,
      terminal_status: p.terminal,
      // Explicit in the trail: clearing an entitlement leaves every seat in place
      // (§5.2). A reader of the audit log should not have to infer that.
      seats_untouched: true,
      ...(p.reason ? { reason: p.reason } : {}),
    },
  };

  // ── The dual-write (AECI-1353) ─────────────────────────────────────────────
  // End every live license. `revoked` (pulled for cause) ends them `revoked`;
  // `expired` (the term ran out) ends them `lapsed`, E6's word for the same thing.
  // During the dual-write period every live license mirrors this one row, so all of
  // them go. A vendor with none (not yet back-filled) gets nothing here.
  const licenseBatch = endLicensesStatements(db, {
    ...dualWriteContext(p, p.vendorWasVerified),
    target: { licenseIds: liveLicenseIds(p.licenses) },
    endReason: p.terminal === 'revoked' ? 'revoked' : 'lapsed',
  });

  // As in activate, the guarded flip runs before the reconcile. Both land on
  // `verified = false`: the flip moves the bit and `updated_at`, and the reconcile
  // then matches no row because no live license is left.
  const stmts: BatchStmt[] = [
    db
      .update(vendorEntitlements)
      .set({ status: p.terminal, endedAt: p.now, updatedAt: p.now })
      .where(
        and(eq(vendorEntitlements.vendorId, p.vendorId), eq(vendorEntitlements.status, ACTIVE)),
      ),
    db
      .update(vendors)
      .set({ verified: false, updatedAt: p.now })
      .where(and(eq(vendors.id, p.vendorId), eq(vendors.verified, true))),
    auditInsert(db, auditEntry),
    ...licenseBatch.stmts,
  ];

  return {
    stmts,
    auditEntry,
    verifiedFlipped,
    entitlementCreated: false,
    reactivated: false,
    licenseAuditEntries: licenseBatch.auditEntries,
    billingAccountCreatedId: null,
    raceGuarded: false,
  };
}
