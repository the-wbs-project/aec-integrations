/**
 * Who an admin or system audit row is ABOUT (AECI-1192 / AECI-1193,
 * `DATABASE_SCHEMA.md` §8.4).
 *
 * A vendor-actor row takes its vendor and plan from the session
 * (`vendorAuditEntry` in `routes/vendor-shared.ts`). An AECi admin or a cron has
 * no vendor session, so it reads the vendor that HOLDS the entity at write time,
 * and that vendor's plan, here. The reads are single-row lookups on unique or
 * leading-column indexes, and callers run them in the same wave as the reads
 * they already make.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { vendorPlanSnapshot } from '@aeci/shared/entitlements';
import { asc, desc, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productVendors } from '../db/schema';
import { loadEntitlement } from './vendor-entitlement';

/** The two `AuditLogEntry` fields that say which vendor a row is about. */
export type VendorAuditStamp = Required<Pick<AuditLogEntry, 'vendorId' | 'vendorPlan'>>;

/** No vendor holds the entity: both columns stay NULL. */
export const NO_VENDOR_STAMP: VendorAuditStamp = { vendorId: null, vendorPlan: null };

/**
 * The vendor and its current plan, for an audit row about something it holds.
 * `null` in, both columns NULL out: an unowned entity has no vendor to name.
 */
export async function vendorAuditStamp(
  db: Db,
  vendorId: string | null | undefined,
): Promise<VendorAuditStamp> {
  if (!vendorId) return NO_VENDOR_STAMP;
  return { vendorId, vendorPlan: vendorPlanSnapshot(await loadEntitlement(db, vendorId)) };
}

/**
 * The vendor that holds a product: its primary `product_vendors` owner, else the
 * lowest vendor id among its owners, else `null` for an unowned product. A
 * co-owned product names one holder. The other owners' own writes carry their
 * own `vendor_id`.
 */
export async function productHolderVendorId(db: Db, productId: string): Promise<string | null> {
  const rows = await db
    .select({ vendorId: productVendors.vendorId })
    .from(productVendors)
    .where(eq(productVendors.productId, productId))
    .orderBy(desc(productVendors.isPrimary), asc(productVendors.vendorId))
    .limit(1);
  return rows[0]?.vendorId ?? null;
}

/** {@link vendorAuditStamp} for the vendor holding one product. */
export async function productAuditStamp(db: Db, productId: string): Promise<VendorAuditStamp> {
  return vendorAuditStamp(db, await productHolderVendorId(db, productId));
}
