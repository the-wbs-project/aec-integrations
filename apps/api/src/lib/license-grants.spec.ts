/**
 * The grant builders (AECI-1615), against the in-memory D1 harness. The routes'
 * specs cover the HTTP answers; this one pins the batch the activation builds.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agreementAcceptances, licenseGrants, licenses, profiles, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedBillingAccount } from '../test/licenses';
import type { BatchTuple } from './audit';
import {
  activateLicenseGrantStatements,
  closeLicenseGrantStatements,
  createLicenseGrantStatements,
  grantLicenseIds,
  type LicenseGrantRow,
} from './license-grants';

const VENDOR = '11111111-1111-4111-8111-111111111111';
const GRANT = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-10T12:00:00.000Z';
const ADMIN = '00000000-0000-4000-8000-000000000900';
const OWNER = '00000000-0000-4000-8000-000000000100';

let t: TestDb;
let accountId: string;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
  await t.db.insert(profiles).values([
    { id: ADMIN, role: 'admin' },
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
  ]);
  accountId = await seedBillingAccount(t.db, VENDOR);
});
afterEach(() => t.dispose());

function created() {
  return createLicenseGrantStatements(t.db, {
    actorId: ADMIN,
    actorType: 'admin',
    id: GRANT,
    billingAccountId: accountId,
    vendorId: VENDOR,
    kind: 'grant',
    source: 'invoice',
    quantity: 3,
    startsAt: null,
    endsAt: '2027-06-30',
    reference: 'PO-1',
    notes: null,
    items: [],
    termsVersion: '1.1',
    grantedBy: ADMIN,
    now: NOW,
    vendorPlan: null,
    auditSource: 'admin-license',
  });
}

const activation = (grant: LicenseGrantRow) =>
  activateLicenseGrantStatements(t.db, {
    actorId: OWNER,
    actorType: 'user',
    grant,
    now: NOW,
    vendorLicenses: [],
    vendorWasVerified: false,
    licensedProductIds: new Set(),
    ownedProductIds: new Set(),
    auditSource: 'vendor-portal',
    acceptance: {
      method: 'portal_checkbox',
      email: 'owner@acme.example',
      profileId: OWNER,
      signer: { name: 'Owner', title: 'CEO', companyLegalName: 'Acme, Inc.' },
      seatRole: 'owner',
    },
  });

describe('activateLicenseGrantStatements', () => {
  it('flips the grant first, guards it, then the acceptance, the licenses and the grant audit', async () => {
    const create = created();
    const batch = await activation(create.row);
    expect(batch.licenseIds).toEqual(await grantLicenseIds(GRANT, 3));
    expect(batch.auditEntries.map((e) => e.action)).toEqual([
      'agreement.accepted',
      'license.granted',
      'license.granted',
      'license.granted',
      'license_grant.accepted',
    ]);
    expect(batch.verifiedFlipped).toBe(true);
    expect(batch.groups).toEqual([{ endsAt: '2027-06-30T00:00:00.000Z', count: 3 }]);

    await t.db.batch([...create.stmts, ...batch.stmts] as BatchTuple);
    const [grant] = await t.db.select().from(licenseGrants);
    expect(grant).toMatchObject({ status: 'accepted', acceptanceId: batch.acceptanceId });
    const [acceptance] = await t.db.select().from(agreementAcceptances);
    expect(acceptance).toMatchObject({ id: batch.acceptanceId, licenseGrantId: GRANT });
    expect(await t.db.select().from(licenses)).toHaveLength(3);
  });

  it('a second activation of the same grant aborts on the sentinel, writing nothing', async () => {
    const create = created();
    await t.db.batch([...create.stmts, ...(await activation(create.row)).stmts] as BatchTuple);
    // Built from the stale pending row, as a racing request would.
    const again = await activation(create.row);
    await expect(t.db.batch(again.stmts as BatchTuple)).rejects.toThrow(/malformed JSON/i);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(1);
    expect(await t.db.select().from(licenses)).toHaveLength(3);
  });

  it('refuses a grant that is not pending before any statement exists', async () => {
    await expect(activation({ ...created().row, status: 'withdrawn' })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('a withdraw after an accept matches nothing and aborts', async () => {
    const create = created();
    await t.db.batch([...create.stmts, ...(await activation(create.row)).stmts] as BatchTuple);
    const close = closeLicenseGrantStatements(t.db, {
      actorId: ADMIN,
      actorType: 'admin',
      grant: create.row,
      status: 'withdrawn',
      now: NOW,
      reason: 'late',
      vendorPlan: null,
      auditSource: 'admin-license',
    });
    await expect(t.db.batch(close.stmts as BatchTuple)).rejects.toThrow(/malformed JSON/i);
    const [grant] = await t.db.select().from(licenseGrants);
    expect(grant!.status).toBe('accepted');
  });
});
