/**
 * The one writer of `vendors.legal_name` (AECI-1625, `DATABASE_SCHEMA.md` §4.1,
 * `VENDOR_SIGNUP_PROCESS.md` §4). Three callers, each appending the statements to its
 * own `db.batch` (§26.1):
 *
 *   - the claim approval (`routes/admin-claims.ts`), with `onlyIfEmpty`: the claim's
 *     `company_legal_name` fills the column only while it is NULL, so a later claimant
 *     never undoes an owner's or an admin's correction (ruled on AECI-1625);
 *   - `PUT /api/vendor/billing/legal-name`, an owner seat;
 *   - `PUT /api/admin/vendors/:id/billing/legal-name`, an admin.
 *
 * Every write carries its `vendor.legal_name_changed` audit row. The value is a fact
 * about the company, not personal data, so the row carries it. `vendors.updated_at` is
 * held: no public page reads the column, and that stamp feeds the sitemap and the
 * "recently updated" sort. No cache purge for the same reason.
 *
 * Promote never writes the column: `PromoteVendorSchema` strips unknown keys and the
 * vendor upsert names its columns (`REVIEW_APP_PROMOTE_API.md` §4a).
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { normalizeVendorLegalName } from '@aeci/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { vendors } from '../db/schema';
import { auditInsert, auditInsertWhere, type BatchStmt } from './audit';

export const VENDOR_LEGAL_NAME_CHANGED_ACTION = 'vendor.legal_name_changed';

/** Keeps `vendors.updated_at` as it was. The column's `$onUpdate` would stamp it, and the
 *  sitemap and the "recently updated" sort read it (the `brand-asset-removal.ts` rule). */
const HOLD_UPDATED_AT = sql`${vendors.updatedAt}`;

export interface VendorLegalNameParams {
  vendorId: string;
  /** The stored value before this write. */
  before: string | null;
  /** The new value. Blank or `null` clears it. Normalised here. */
  legalName: string | null;
  /**
   * The claim approval's rule: write only while the column is NULL. Both statements are
   * then guarded on `legal_name IS NULL`, the audit row first so it reads the
   * pre-update state, and a non-NULL `before` plans nothing.
   */
  onlyIfEmpty?: boolean;
  actorId: string | null;
  actorType: AuditLogEntry['actorType'];
  vendorPlan: VendorPlanSnapshot;
  /** `metadata.source`: `'vendor-portal'`, `'admin-vendors-billing'` or the claim's. */
  source: string;
  /** The claim whose legal name filled the column, on the approval path. */
  sourceRequestId?: string;
}

export interface VendorLegalNameBatch {
  stmts: BatchStmt[];
  /** `null` when nothing is written. */
  auditEntry: AuditLogEntry | null;
  /** The value stored after the batch commits, as this plan sees it. */
  legalName: string | null;
}

export function vendorLegalNameStatements(db: Db, p: VendorLegalNameParams): VendorLegalNameBatch {
  const legalName = normalizeVendorLegalName(p.legalName);
  if (legalName === p.before) return { stmts: [], auditEntry: null, legalName };
  if (p.onlyIfEmpty && (p.before !== null || legalName === null)) {
    return { stmts: [], auditEntry: null, legalName: p.before };
  }

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: VENDOR_LEGAL_NAME_CHANGED_ACTION,
    entityType: 'vendor',
    entityId: p.vendorId,
    vendorId: p.vendorId,
    vendorPlan: p.vendorPlan,
    beforeState: { legal_name: p.before },
    afterState: { legal_name: legalName },
    metadata: {
      source: p.source,
      vendorId: p.vendorId,
      ...(p.sourceRequestId ? { requestId: p.sourceRequestId } : {}),
    },
  };

  if (p.onlyIfEmpty) {
    const stillEmpty = and(eq(vendors.id, p.vendorId), isNull(vendors.legalName));
    return {
      stmts: [
        auditInsertWhere(db, auditEntry, { from: vendors, where: stillEmpty }),
        db.update(vendors).set({ legalName, updatedAt: HOLD_UPDATED_AT }).where(stillEmpty),
      ],
      auditEntry,
      legalName,
    };
  }

  return {
    stmts: [
      db
        .update(vendors)
        .set({ legalName, updatedAt: HOLD_UPDATED_AT })
        .where(eq(vendors.id, p.vendorId)),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
    legalName,
  };
}

/** The stored legal name, or `null` for an unknown vendor. */
export async function loadVendorLegalName(
  db: Db,
  vendorId: string,
): Promise<{ legalName: string | null } | null> {
  const row = await db.query.vendors.findFirst({
    columns: { legalName: true },
    where: eq(vendors.id, vendorId),
  });
  return row ?? null;
}
