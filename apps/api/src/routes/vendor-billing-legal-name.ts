/**
 * `PUT /api/vendor/billing/legal-name` (AECI-1625): an owner seat sets or clears its
 * company's legal name, `vendors.legal_name`. A checkout acceptance records it
 * (`loadCheckoutSigner`, `VENDOR_SIGNUP_PROCESS.md` §4). Contract:
 * `packages/shared/src/api/vendor-billing.ts`, `API_CONTRACTS.md` §6.14.
 *
 * ── GATES, IN ORDER ─────────────────────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')` at registration. Then
 * `requireSeatOwner()` here: the legal name binds the company at checkout, which is an
 * owner's act (decision 10), so a member seat gets `403`. The vendor id comes from the
 * session, never the request. No capability gate: the fourth named exception of
 * `API_CONTRACTS.md` §6.14 invariant 3.
 *
 *   - Body: `{ legal_name: string | null }`, at most 200 characters, trimmed with inner
 *     whitespace collapsed. `null` or blank clears it. Anything else is `400`.
 *
 * ── ONE BATCH, AUDIT ONLY ───────────────────────────────────────────────────────
 * The UPDATE and its `vendor.legal_name_changed` audit row (`vendorLegalNameStatements`).
 * An unchanged value writes nothing. No message to the other owners and no cache purge:
 * no public page reads the column. Another owner sees the new value on the next load.
 */

import {
  UpdateVendorLegalNameRequestSchema,
  UpdateVendorLegalNameResponseSchema,
  type UpdateVendorLegalNameResponse,
} from '@aeci/shared';

import { getDb } from '../db/client';
import { notFoundError } from '../errors';
import { json } from '../http';
import type { BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { loadVendorLegalName, vendorLegalNameStatements } from '../lib/vendor-legal-name';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  requireSeatOwner,
  sessionVendorId,
  sessionVendorPlan,
  type VendorContext,
} from './vendor-shared';

/** `PUT /api/vendor/billing/legal-name`. */
export function createUpdateVendorLegalNameHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    await requireSeatOwner(
      db,
      session.userId,
      vendorId,
      "Only a vendor account owner can change the company's legal name",
    );

    const payload = await parseJsonBody(c, UpdateVendorLegalNameRequestSchema);

    const vendor = await loadVendorLegalName(db, vendorId);
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    const batch = vendorLegalNameStatements(db, {
      vendorId,
      before: vendor.legalName,
      legalName: payload.legal_name,
      actorId: session.userId,
      actorType: auditActorType(session),
      vendorPlan: sessionVendorPlan(c),
      source: AUDIT_SOURCE,
    });
    if (batch.auditEntry) {
      await db.batch(batch.stmts as BatchTuple);
      afterVendorWrite(c, [], batch.auditEntry);
    }

    const body: UpdateVendorLegalNameResponse = { legal_name: batch.legalName };
    validateResponseInDev(c.env, () => UpdateVendorLegalNameResponseSchema.parse(body));
    return json(body);
  };
}
