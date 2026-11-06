/**
 * `vendorLegalNameStatements` (AECI-1625): the one writer of `vendors.legal_name`. The
 * claim approval's `onlyIfEmpty` rule is the part a route spec cannot isolate: the
 * column fills only while NULL, and the guard holds in SQL when a rival write commits
 * between the read and the batch.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import type { BatchTuple } from './audit';
import { vendorLegalNameStatements, type VendorLegalNameParams } from './vendor-legal-name';

const VENDOR = '00000000-0000-4000-8000-000000000001';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
});
afterEach(() => t.dispose());

const params = (over: Partial<VendorLegalNameParams>): VendorLegalNameParams => ({
  vendorId: VENDOR,
  before: null,
  legalName: 'Acme, Inc.',
  actorId: null,
  actorType: 'admin',
  vendorPlan: { tier: 'none', status: 'none' },
  source: 'admin-claims',
  ...over,
});

const stored = async () =>
  (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR)))[0]!.legalName;

describe('vendorLegalNameStatements', () => {
  it('fills an empty column with its audit row when onlyIfEmpty', async () => {
    const batch = vendorLegalNameStatements(
      t.db,
      params({ onlyIfEmpty: true, sourceRequestId: 'req-1' }),
    );
    expect(batch.stmts).toHaveLength(2);
    await t.db.batch(batch.stmts as BatchTuple);
    expect(await stored()).toBe('Acme, Inc.');
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({ action: 'vendor.legal_name_changed', entityId: VENDOR });
    expect(audit!.metadata).toMatchObject({ requestId: 'req-1' });
  });

  it('plans nothing when onlyIfEmpty and a name is already stored', () => {
    const batch = vendorLegalNameStatements(
      t.db,
      params({ onlyIfEmpty: true, before: 'Acme Corporation', legalName: 'Acme Inc' }),
    );
    expect(batch).toEqual({ stmts: [], auditEntry: null, legalName: 'Acme Corporation' });
  });

  it('plans nothing when onlyIfEmpty and the claim had no legal name', () => {
    const batch = vendorLegalNameStatements(t.db, params({ onlyIfEmpty: true, legalName: null }));
    expect(batch.stmts).toHaveLength(0);
  });

  it('writes neither row when a rival write filled the column after the read', async () => {
    const batch = vendorLegalNameStatements(t.db, params({ onlyIfEmpty: true }));
    await t.db.update(vendors).set({ legalName: 'Rival LLC' }).where(eq(vendors.id, VENDOR));
    await t.db.batch(batch.stmts as BatchTuple);
    expect(await stored()).toBe('Rival LLC');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('overwrites without onlyIfEmpty, the edit routes', async () => {
    await t.db.update(vendors).set({ legalName: 'Acme Inc' }).where(eq(vendors.id, VENDOR));
    const batch = vendorLegalNameStatements(t.db, params({ before: 'Acme Inc' }));
    await t.db.batch(batch.stmts as BatchTuple);
    expect(await stored()).toBe('Acme, Inc.');
  });

  it('leaves vendors.updated_at alone: no public page reads the column', async () => {
    const before = (await t.db.select().from(vendors))[0]!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await t.db.batch(vendorLegalNameStatements(t.db, params({})).stmts as BatchTuple);
    expect((await t.db.select().from(vendors))[0]!.updatedAt).toBe(before);
  });
});
