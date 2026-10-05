/**
 * Shared assertion for the AECI-1184 cause linkage at each vendor write site.
 *
 * A handler that buffers a recrawl must also leave a cause row per queued URL,
 * naming the session vendor and the vendor's own product. Each call-site spec
 * calls this after its "buffers into both queues" case, so a site that drops the
 * product (or names a product the vendor does not sell) fails where it lives.
 */

import { and, eq } from 'drizzle-orm';
import { expect } from 'vitest';

import { productVendors, recrawlQueueCauses } from '../db/schema';

import type { TestDb } from './d1';

/** Assert every cause is a vendor cause for `vendorId`, on both channels, naming
 *  a product `vendorId` sells. Returns the causes for any site-specific check. */
export async function expectVendorCauses(t: TestDb, vendorId: string) {
  const causes = await t.db.select().from(recrawlQueueCauses);
  expect(new Set(causes.map((c) => c.channel))).toEqual(new Set(['indexnow', 'gsc']));
  for (const cause of causes) {
    expect(cause).toMatchObject({ source: 'vendor', vendorId, promoteJobId: null });
    expect(cause.auditLogId).not.toBeNull();
    expect(cause.productId).not.toBeNull();
    const owned = await t.db
      .select()
      .from(productVendors)
      .where(
        and(eq(productVendors.productId, cause.productId!), eq(productVendors.vendorId, vendorId)),
      );
    expect(owned).toHaveLength(1);
  }
  return causes;
}

/** Assert every cause is an AECi admin cause: no vendor, no product. */
export async function expectAdminCauses(t: TestDb) {
  const causes = await t.db.select().from(recrawlQueueCauses);
  expect(causes.length).toBeGreaterThan(0);
  for (const cause of causes) {
    expect(cause).toMatchObject({ source: 'admin', vendorId: null, productId: null });
    expect(cause.auditLogId).not.toBeNull();
  }
  return causes;
}
