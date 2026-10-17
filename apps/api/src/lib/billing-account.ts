/**
 * The billing account a vendor's Managed licenses sit on (AECI-1351, E1.2 of
 * `docs/VENDOR_SIGNUP_PROCESS.md` §5; decisions 16 and 18 in §2, step 2 in §3).
 *
 * One row per vendor today (`billing_accounts_vendor_key`). It is created by the
 * batch that seats the vendor's first owner: the claim approval
 * (`routes/admin-claims.ts`, Free and Managed alike) and the operator's provision-seat
 * route (`routes/admin-vendors.ts`). A later seat on a vendor that already has an
 * account writes nothing here, which is the §2.3 second-seat posture. Until AECI-1358
 * the entitlement activate's license dual-write (`lib/vendor-entitlement.ts`,
 * AECI-1353) composed it too. That module is deleted.
 *
 * D1 has no interactive transactions. Like `lib/audit.ts` and `lib/vendor-grant.ts`,
 * the builder RETURNS the statements plus the audit entry the caller forwards after
 * the commit, so the account row and its `audit_log` row land in the caller's one
 * `db.batch` with the seat (§26.1).
 *
 * ── WHY A PRELOAD, NOT `ON CONFLICT DO NOTHING` ────────────────────────────────
 * The caller reads the account first (`loadBillingAccount`) and the builder branches
 * in TS. `ON CONFLICT DO NOTHING` would still emit the audit row, which would then
 * record a creation that did not happen. Two first approvals racing on one vendor
 * both see no account. The second batch then trips the unique index and rolls back
 * whole, seat included, and the operator's retry re-plans against the committed row.
 * That is the race the entitlement INSERT already has.
 *
 * ── WHAT IT NEVER TOUCHES ──────────────────────────────────────────────────────
 * No statement here names `vendors`, so a second seat cannot move
 * `vendors.updated_at` through this module. `billing_email` is NULL on a new account.
 * An owner may set or clear it from the Billing tab (`billingEmailStatements`,
 * AECI-1389), and decision 16's default-at-checkout still applies when E9 lands.
 *
 * ── THE BILLING EMAIL (AECI-1389) ───────────────────────────────────────────────
 * `billingEmailStatements` is the one writer of `billing_email` outside checkout.
 * It follows the seat-invite precedent (`lib/vendor-seat-invites.ts`): the address
 * goes in the audit row's before/after state, because the row's job is to say which
 * address invoices went to and when that changed. The vendor's history read copies
 * field NAMES only, never the values (`lib/vendor-history.ts`). The account
 * holder's erasure nulls a matching address (`routes/account.ts`).
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { billingAccounts } from '../db/schema';
import { auditInsert, type BatchStmt } from './audit';

/** `audit_log.entity_type` for every billing-account row (`DATABASE_SCHEMA.md` §8.6b).
 *  `entity_id` is the ACCOUNT id; `audit_log.vendor_id` names the vendor. */
export const BILLING_ACCOUNT_ENTITY_TYPE = 'billing_account';

/** The audit action for a new account. Registered in `@aeci/shared/audit-vendor-actions`. */
export const BILLING_ACCOUNT_CREATED_ACTION = 'billing_account.created';

/** The audit action for a billing email change. Registered in `@aeci/shared/audit-vendor-actions`. */
export const BILLING_ACCOUNT_EMAIL_CHANGED_ACTION = 'billing_account.email_changed';

/** The preloaded account. `null` = the vendor has none yet. */
export interface BillingAccountBefore {
  id: string;
}

/** Statements plus the forwarding entry. Both empty on the no-op path. */
export interface BillingAccountBatch {
  stmts: BatchStmt[];
  /** `null` when the vendor already has an account: nothing changed, nothing to audit. */
  auditEntry: AuditLogEntry | null;
  /** The new account's id, or `null` on the no-op path. */
  billingAccountId: string | null;
}

/** The shared no-op result. Frozen so a caller cannot mutate the shared instance. */
const NO_OP: BillingAccountBatch = Object.freeze({
  stmts: Object.freeze([]) as unknown as BatchStmt[],
  auditEntry: null,
  billingAccountId: null,
});

export interface EnsureBillingAccountParams {
  vendorId: string;
  /** The account's display name: the vendor's company name. */
  name: string;
  /** `profiles.id` of whoever caused the creation (the approving admin). No FK. */
  createdBy: string | null;
  actorType: AuditLogEntry['actorType'];
  /** The preloaded account (`loadBillingAccount`). Truthy → the whole call is a no-op. */
  existing: BillingAccountBefore | null;
  /** ISO timestamp for `created_at` / `updated_at`. Normalised here. */
  now: string;
  /** The vendor's plan before this write, for the audit row's snapshot columns. */
  vendorPlan: VendorPlanSnapshot;
  /** `metadata.source`, so the row reads as part of the caller's action. */
  source: string;
  /** The claim this came from, when it came from one. */
  sourceRequestId?: string | null;
}

/**
 * Read the vendor's billing account. The one read this module owns, so each caller
 * does not re-derive the lookup. Single-row lookup on `billing_accounts_vendor_key`.
 */
export async function loadBillingAccount(
  db: Db,
  vendorId: string,
): Promise<BillingAccountBefore | null> {
  const row = await db.query.billingAccounts.findFirst({
    columns: { id: true },
    where: eq(billingAccounts.vendorId, vendorId),
  });
  return row ?? null;
}

/**
 * The account INSERT and its `billing_account.created` audit row, or nothing when the
 * vendor already has an account. Compose the result into the seat-grant batch.
 */
export function ensureBillingAccountStatements(
  db: Db,
  p: EnsureBillingAccountParams,
): BillingAccountBatch {
  if (p.existing) return NO_OP;

  const id = crypto.randomUUID();
  const now = new Date(p.now).toISOString();

  const auditEntry: AuditLogEntry = {
    actorId: p.createdBy,
    actorType: p.actorType,
    action: BILLING_ACCOUNT_CREATED_ACTION,
    entityType: BILLING_ACCOUNT_ENTITY_TYPE,
    entityId: id,
    vendorId: p.vendorId,
    vendorPlan: p.vendorPlan,
    beforeState: null,
    afterState: { vendor_id: p.vendorId, name: p.name, billing_email: null },
    metadata: {
      source: p.source,
      vendorId: p.vendorId,
      ...(p.sourceRequestId ? { source_request_id: p.sourceRequestId } : {}),
    },
  };

  const stmts: BatchStmt[] = [
    db.insert(billingAccounts).values({
      id,
      vendorId: p.vendorId,
      name: p.name,
      billingEmail: null,
      createdBy: p.createdBy,
      createdAt: now,
      updatedAt: now,
    }),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry, billingAccountId: id };
}

/** The account as the billing email writer needs it. */
export interface BillingAccountEmailBefore {
  id: string;
  billingEmail: string | null;
}

/**
 * Read the vendor's billing account with its current billing email. The same
 * single-row lookup as {@link loadBillingAccount}, with the one column the email
 * writer compares against.
 */
export async function loadBillingAccountEmail(
  db: Db,
  vendorId: string,
): Promise<BillingAccountEmailBefore | null> {
  const row = await db.query.billingAccounts.findFirst({
    columns: { id: true, billingEmail: true },
    where: eq(billingAccounts.vendorId, vendorId),
  });
  return row ?? null;
}

/** Trimmed and lower-cased, so the erasure match in `routes/account.ts` compares
 *  like with like. Blank is `null`. The request Zod does the same; this is the
 *  builder's own guarantee. */
export function normalizeBillingEmail(email: string | null): string | null {
  const trimmed = email?.trim().toLowerCase() ?? '';
  return trimmed === '' ? null : trimmed;
}

export interface BillingEmailParams {
  billingAccountId: string;
  vendorId: string;
  /** The stored value before this write (`loadBillingAccountEmail`). */
  before: string | null;
  /** The new value. `null` clears it. Normalised here. */
  email: string | null;
  /** ISO timestamp for `updated_at`. Normalised here. */
  now: string;
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
  /** The vendor's plan at write time, for the audit row's snapshot columns. */
  vendorPlan: VendorPlanSnapshot;
  /** `metadata.source`. The vendor portal's `'vendor-portal'`. */
  source: string;
}

/** Statements plus the forwarding entry, and the value now stored. */
export interface BillingEmailBatch {
  stmts: BatchStmt[];
  /** `null` when the address did not change: nothing written, nothing audited. */
  auditEntry: AuditLogEntry | null;
  /** The stored value after the batch commits. */
  billingEmail: string | null;
}

/**
 * Set or clear an account's billing email (AECI-1389, decision 16). One UPDATE and
 * its `billing_account.email_changed` audit row, filed under the account with
 * `vendor_id` stamped. No statements when the normalised value equals `before`, so
 * saving the form twice writes one row.
 */
export function billingEmailStatements(db: Db, p: BillingEmailParams): BillingEmailBatch {
  const email = normalizeBillingEmail(p.email);
  if (email === p.before) return { stmts: [], auditEntry: null, billingEmail: email };

  const now = new Date(p.now).toISOString();
  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: BILLING_ACCOUNT_EMAIL_CHANGED_ACTION,
    entityType: BILLING_ACCOUNT_ENTITY_TYPE,
    entityId: p.billingAccountId,
    vendorId: p.vendorId,
    vendorPlan: p.vendorPlan,
    beforeState: { billing_email: p.before },
    afterState: { billing_email: email },
    metadata: { source: p.source, vendorId: p.vendorId },
  };

  return {
    stmts: [
      db
        .update(billingAccounts)
        .set({ billingEmail: email, updatedAt: now })
        .where(eq(billingAccounts.id, p.billingAccountId)),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
    billingEmail: email,
  };
}
