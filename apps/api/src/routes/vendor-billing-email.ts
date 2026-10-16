/**
 * `PUT /api/vendor/billing/email` (AECI-1389, E5.3 of AECI-1335): an owner seat sets
 * or clears the billing email on its vendor's billing account
 * (`docs/VENDOR_SIGNUP_PROCESS.md` §2 decision 16). Contract:
 * `packages/shared/src/api/vendor-billing.ts`, `API_CONTRACTS.md` §6.14.
 *
 * ── GATES, IN ORDER ─────────────────────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')` at registration. Then
 * `requireSeatOwner()` here: billing is an owner's act (decision 10), so a member
 * seat gets `403`. The vendor id comes from the session, never the request. No
 * capability gate: the fourth named exception of `API_CONTRACTS.md` §6.14
 * invariant 3.
 *
 *   - Body: `{ billing_email: string | null }`, the seat-invite address rule,
 *     trimmed and lower-cased. `null` clears it. Anything else is `400`.
 *   - The vendor has no billing account: `404 NOT_FOUND`. That is an E1 back-fill
 *     defect, not a caller error, and the GET reports it as `billing_account: null`.
 *
 * ── ONE BATCH, AUDIT ONLY ───────────────────────────────────────────────────────
 * The UPDATE and its `billing_account.email_changed` audit row
 * (`billingEmailStatements`). An unchanged value writes nothing. Ruling 2026-10-16:
 * the change is audit-only. No message goes to the other owners, and no cache tag
 * is purged because no public page reads the address. No realtime scope moves
 * either: another owner sees the new value on the next load
 * (`STAGE_2_REALTIME_SPEC.md`).
 */

import {
  UpdateBillingEmailRequestSchema,
  UpdateBillingEmailResponseSchema,
  type UpdateBillingEmailResponse,
} from '@aeci/shared';

import { getDb } from '../db/client';
import { notFoundError } from '../errors';
import { json } from '../http';
import type { BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { billingEmailStatements, loadBillingAccountEmail } from '../lib/billing-account';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  requireSeatOwner,
  sessionVendorId,
  sessionVendorPlan,
  type VendorContext,
} from './vendor-shared';

/** `PUT /api/vendor/billing/email`. */
export function createUpdateBillingEmailHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    // 1. Owner seats only (decision 10).
    await requireSeatOwner(
      db,
      session.userId,
      vendorId,
      'Only a vendor account owner can change the billing email',
    );

    // 2. Shape.
    const payload = await parseJsonBody(c, UpdateBillingEmailRequestSchema);

    // 3. The vendor's one account (`billing_accounts_vendor_key`).
    const account = await loadBillingAccountEmail(db, vendorId);
    if (!account) throw notFoundError('billing_account', { id: vendorId });

    // 4. The write. The builder stamps `vendor_id` and the session's plan itself, the
    // seat-invite pattern, because `auditInsert` builds the row inside the builder.
    const batch = billingEmailStatements(db, {
      billingAccountId: account.id,
      vendorId,
      before: account.billingEmail,
      email: payload.billing_email,
      now: new Date().toISOString(),
      actorId: session.userId,
      actorType: auditActorType(session),
      vendorPlan: sessionVendorPlan(c),
      source: AUDIT_SOURCE,
    });
    if (batch.auditEntry) {
      await db.batch(batch.stmts as BatchTuple);
      // No tags: nothing public reads the address. The tail forwards the audit row.
      afterVendorWrite(c, [], batch.auditEntry);
    }

    const body: UpdateBillingEmailResponse = {
      billing_account: { id: account.id, billing_email: batch.billingEmail },
    };
    validateResponseInDev(c.env, () => UpdateBillingEmailResponseSchema.parse(body));
    return json(body);
  };
}
