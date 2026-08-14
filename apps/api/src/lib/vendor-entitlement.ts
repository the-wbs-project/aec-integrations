/**
 * The `vendor_entitlements` ↔ `vendors.verified` mirror — the SOLE writer of either
 * side (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.1/§2.3).
 *
 * D1 has no interactive transactions — only atomic `db.batch([...])`. Like
 * `lib/audit.ts` and `lib/vendor-grant.ts`, each builder RETURNS the Drizzle
 * statements (plus the audit entry the caller forwards to Datadog post-commit)
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
 * on `vendors` anywhere else (Guard 1); the `entitlement_mirror_drift` data-quality
 * check (`lib/data-quality.ts`, 04:00 UTC) is the run-time backstop (Guard 2).
 *
 * ── `vendors.updated_at` MOVES IFF `vendors.verified` MOVES (R2) ────────────────
 * It is stamped EXPLICITLY, never left to `$onUpdate`, and it rides inside the same
 * guarded `WHERE verified = <old>` — so a second-seat grant, a renewal, and a
 * drifted self-heal all leave it alone (no needless nightly Algolia re-push), while a
 * real flip in EITHER direction bumps it. The un-verify direction is the one AECI-529
 * never reasoned about: without the bump, a lapsed vendor keeps a Verified badge in
 * search indefinitely.
 *
 * ── NO WORKFLOW ROW ────────────────────────────────────────────────────────────
 * Entitlement changes write no `workflow_instances` row. `workflow_instances_type_check`
 * is a closed CHECK and opening it on SQLite is a full table rebuild (§1.2 / R1). That
 * is why the return type is `EntitlementBatch` and not `ClaimBatch` — there is no
 * `workflowEntry` field to tempt anyone.
 *
 * ── SEAM FOR §5 (AECI-532) ─────────────────────────────────────────────────────
 * The admin set/renew/clear endpoint adds `renewEntitlementStatements` here: it writes
 * term + arrangement columns on an ALREADY-active row and MUST NOT emit a `vendors`
 * statement, because the mirror does not move on a renewal (R2). `activate` cannot
 * serve that case — per the §2.3 matrix an already-active row emits nothing at all.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, ne } from 'drizzle-orm';

import type { Db } from '../db/client';
import { vendorEntitlements, vendors } from '../db/schema';
import { auditInsert, type BatchStmt } from './audit';

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
}

/** The shared no-op result. Frozen so a caller cannot mutate the shared instance. */
const NO_OP: EntitlementBatch = Object.freeze({
  stmts: [],
  auditEntry: null,
  verifiedFlipped: false,
  entitlementCreated: false,
  reactivated: false,
});

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
  /** `profiles.id` of the granting admin — the eighth inbound FK (R6). */
  grantedBy?: string | null;
  /** The claim this came from, when it came from one (§6). */
  sourceRequestId?: string | null;
  arrangement?: EntitlementArrangement;
  /** Override the audit action (the claim path uses its own vocabulary). */
  action?: string;
  /** Override `metadata.source`. */
  source?: string;
  reason?: string | null;
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
}

/**
 * Preload the vendor's entitlement row. The ONE read this module owns, so §5, §6 and
 * §8 do not each re-derive the `findFirst` (the duplicated-construction failure §2.5
 * calls out for cache tags). Single-row lookup on `vendor_entitlements_vendor_key`.
 */
export async function loadEntitlement(db: Db, vendorId: string): Promise<EntitlementBefore | null> {
  const row = await db.query.vendorEntitlements.findFirst({
    columns: { id: true, tier: true, status: true, periodEnd: true },
    where: eq(vendorEntitlements.vendorId, vendorId),
  });
  return row ?? null;
}

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
      vendor_id: p.vendorId,
      verified_flipped: verifiedFlipped,
      entitlement_created: entitlementCreated,
      ...(reactivated ? { reactivated: true } : {}),
      ...(Object.keys(a).length > 0 ? { arrangement: a } : {}),
      ...(p.sourceRequestId ? { source_request_id: p.sourceRequestId } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
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

  const stmts: BatchStmt[] = [
    entitlementStmt,
    db
      .update(vendors)
      .set({ verified: true, updatedAt: p.now })
      .where(and(eq(vendors.id, p.vendorId), eq(vendors.verified, false))),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry, verifiedFlipped, entitlementCreated, reactivated };
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
 * exists to demand.
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
      vendor_id: p.vendorId,
      verified_flipped: verifiedFlipped,
      terminal_status: p.terminal,
      // Explicit in the trail: clearing an entitlement leaves every seat in place
      // (§5.2). A reader of the audit log should not have to infer that.
      seats_untouched: true,
      ...(p.reason ? { reason: p.reason } : {}),
    },
  };

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
  ];

  return { stmts, auditEntry, verifiedFlipped, entitlementCreated: false, reactivated: false };
}
