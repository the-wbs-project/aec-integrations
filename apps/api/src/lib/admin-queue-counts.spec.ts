/**
 * `readAdminQueueCounts` (AECI-922; `ADMIN_PANEL_SPEC.md` §5.0c) against the in-memory
 * D1 harness. Pins the `pending_requests` sum: every section of `/admin/requests` adds
 * its open rows, and a claim never does. AECI-1373 added the fourth term, open
 * early-unassign requests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  licenseReleaseRequests,
  listingRequests,
  productRequests,
  vendorRequests,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { readAdminQueueCounts } from './admin-queue-counts';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'bentley', companyName: 'Bentley' });
});
afterEach(() => t.dispose());

async function seedReleaseRequests(statuses: readonly string[]) {
  const accountId = await seedBillingAccount(t.db, VENDOR);
  for (const [i, status] of statuses.entries()) {
    const licenseId = await seedLicense(t.db, VENDOR);
    await t.db.insert(licenseReleaseRequests).values({
      id: u(300 + i),
      licenseId,
      vendorId: VENDOR,
      billingAccountId: accountId,
      reason: 'Retired',
      status,
    });
  }
}

describe('readAdminQueueCounts: pending_requests', () => {
  it('is zero on an empty database', async () => {
    expect(await readAdminQueueCounts(t.db)).toMatchObject({
      pending_requests: 0,
      pending_claims: 0,
    });
  });

  it('sums open corrections, listing, product and early-unassign requests, never claims', async () => {
    await t.db.insert(vendorRequests).values([
      {
        kind: 'correction',
        status: 'open',
        targetType: 'product',
        targetId: crypto.randomUUID(),
        submitterEmail: 'a@example.com',
        body: 'A correction body that is long enough.',
      },
      {
        kind: 'claim',
        status: 'open',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'b@example.com',
        body: '',
      },
    ]);
    await t.db.insert(listingRequests).values({
      listingName: 'Field Notes',
      website: 'https://fieldnotes.example.com',
      submitterEmail: 'c@example.com',
    });
    await t.db.insert(productRequests).values({
      vendorId: VENDOR,
      requestedBy: u(100),
      contextProductId: u(10),
      name: 'OpenRoads',
      maker: 'Bentley',
    });
    await seedReleaseRequests(['open', 'open', 'approved', 'declined']);

    const counts = await readAdminQueueCounts(t.db);
    // 1 correction + 1 listing + 1 product + 2 open release requests.
    expect(counts.pending_requests).toBe(5);
    expect(counts.pending_claims).toBe(1);
  });

  it('drops a release request from the count once it is decided', async () => {
    await seedReleaseRequests(['open']);
    expect((await readAdminQueueCounts(t.db)).pending_requests).toBe(1);
    await t.db.update(licenseReleaseRequests).set({ status: 'approved' });
    expect((await readAdminQueueCounts(t.db)).pending_requests).toBe(0);
  });
});
