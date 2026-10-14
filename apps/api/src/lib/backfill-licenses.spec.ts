/**
 * The E1.5 license back-fill core (AECI-1354): the planner, the SQL builders and the
 * report. Pure: the end-to-end run over a real migrated database, with all four
 * entitlement statuses, is in `test/d1.spec.ts`.
 */

import { describe, expect, it } from 'vitest';

import {
  BACKFILL_LICENSES_NAMESPACE,
  BILLING_ACCOUNT_BACKFILLED_ACTION,
  backfillIds,
  buildLicenseDriftSql,
  buildOwnedProductsSql,
  buildVendorStatements,
  buildVendorsSql,
  countBackfill,
  entitlementDrift,
  formatLicenseBackfillReport,
  planLicenseBackfill,
  URL_NAMESPACE,
  uuidv5,
  type BackfillVendorRow,
  type OwnedProductRow,
} from './backfill-licenses';

const NOW = '2026-10-14T12:00:00.000Z';

function vendor(over: Partial<BackfillVendorRow> & { id: string }): BackfillVendorRow {
  return {
    slug: over.id,
    company_name: over.id,
    verified: 0,
    seat_count: 1,
    account_id: null,
    license_count: 0,
    ent_id: null,
    ent_tier: null,
    ent_status: null,
    ent_period_start: null,
    ent_period_end: null,
    ent_invoice_ref: null,
    ent_amount: null,
    ent_granted_by: null,
    ent_granted_at: null,
    ent_ended_at: null,
    ent_updated_at: null,
    ...over,
  };
}

/** A vendor with an entitlement row in `status`, verified to match the mirror. */
function entitled(
  id: string,
  status: 'active' | 'pending' | 'expired' | 'revoked',
  over: Partial<BackfillVendorRow> = {},
): BackfillVendorRow {
  return vendor({
    id,
    verified: status === 'active' ? 1 : 0,
    ent_id: `ent-${id}`,
    ent_tier: 'verified',
    ent_status: status,
    ent_period_start: '2026-01-01',
    ent_period_end: '2027-01-01',
    ent_invoice_ref: 'INV-1',
    ent_granted_at: '2026-01-02T00:00:00.000Z',
    ent_ended_at: status === 'expired' || status === 'revoked' ? '2026-09-01T00:00:00.000Z' : null,
    ...over,
  });
}

const owns = (vendorId: string, productId: string, licensed = 0): OwnedProductRow => ({
  vendor_id: vendorId,
  product_id: productId,
  licensed,
});

describe('uuidv5', () => {
  it('matches the RFC 9562 test vector', async () => {
    const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(await uuidv5('www.example.com', DNS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('pins the back-fill namespace to its derivation', async () => {
    expect(await uuidv5('https://aecintegrations.com/ops/backfill-licenses', URL_NAMESPACE)).toBe(
      BACKFILL_LICENSES_NAMESPACE,
    );
  });

  it('mints the same ids every run', async () => {
    expect(await backfillIds.license('v1', 'e1', 0)).toBe(await backfillIds.license('v1', 'e1', 0));
    expect(await backfillIds.license('v1', 'e1', 0)).not.toBe(
      await backfillIds.license('v1', 'e1', 1),
    );
    expect(await backfillIds.account('v1')).not.toBe(await backfillIds.audit('v1'));
  });

  it('rejects a namespace that is not a UUID', async () => {
    await expect(uuidv5('x', 'nope')).rejects.toThrow(RangeError);
  });
});

describe('entitlementDrift', () => {
  it('names both directions and passes every agreeing shape', () => {
    expect(entitlementDrift(vendor({ id: 'a', verified: 1 }))).toContain('no entitlement row');
    expect(entitlementDrift(entitled('b', 'revoked', { verified: 1 }))).toContain("'revoked'");
    expect(entitlementDrift(entitled('c', 'active', { verified: 0 }))).toContain('verified = 0');
    for (const s of ['active', 'pending', 'expired', 'revoked'] as const) {
      expect(entitlementDrift(entitled(s, s))).toBeNull();
    }
    expect(entitlementDrift(vendor({ id: 'free' }))).toBeNull();
  });
});

describe('planLicenseBackfill', () => {
  it('maps an active row to one live license per owned product, in product-id order', async () => {
    const plan = await planLicenseBackfill(
      [entitled('v1', 'active')],
      [owns('v1', 'p2'), owns('v1', 'p1')],
      { now: NOW },
    );
    const [p] = plan.vendors;
    expect(p?.outcome).toBe('write');
    expect(p?.createAccount).toBe(true);
    expect(p?.accountId).toBe(await backfillIds.account('v1'));
    expect(p?.licenses.map((l) => l.assignedProductId)).toEqual(['p1', 'p2']);
    expect(p?.licenses[0]).toMatchObject({
      id: await backfillIds.license('v1', 'ent-v1', 0),
      source: 'invoice',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2027-01-01T00:00:00.000Z',
      endedAt: null,
      endReason: null,
      reference: 'INV-1',
      assignedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(p?.plan).toEqual({ tier: 'verified', status: 'active' });
    expect(p?.perpetual).toBe(false);
  });

  it('maps a perpetual row to complimentary, ends_at NULL, and flags it', async () => {
    const plan = await planLicenseBackfill(
      [entitled('v1', 'active', { ent_period_end: null, ent_amount: 'USD 5,000' })],
      [],
      { now: NOW },
    );
    const [p] = plan.vendors;
    expect(p?.perpetual).toBe(true);
    expect(p?.licenses).toHaveLength(1);
    expect(p?.licenses[0]).toMatchObject({
      source: 'complimentary',
      endsAt: null,
      assignedProductId: null,
    });
  });

  it('maps expired and revoked rows to ENDED licenses that keep their products', async () => {
    const plan = await planLicenseBackfill(
      [entitled('ex', 'expired'), entitled('rv', 'revoked', { ent_ended_at: null })],
      [owns('ex', 'p1'), owns('rv', 'p2', 1)],
      { now: NOW },
    );
    const [ex, rv] = plan.vendors;
    expect(ex?.licenses).toEqual([
      expect.objectContaining({
        endedAt: '2026-09-01T00:00:00.000Z',
        endReason: 'lapsed',
        assignedProductId: 'p1',
      }),
    ]);
    // No `ended_at` on the row: the term end stands in. A live license elsewhere on
    // the product does not matter to an ended one.
    expect(rv?.licenses).toEqual([
      expect.objectContaining({
        endedAt: '2027-01-01T00:00:00.000Z',
        endReason: 'revoked',
        assignedProductId: 'p2',
      }),
    ]);
    expect(rv?.plan).toEqual({ tier: 'verified', status: 'revoked' });
  });

  it('gives a pending row an account and no license', async () => {
    const plan = await planLicenseBackfill([entitled('v1', 'pending')], [owns('v1', 'p1')], {
      now: NOW,
    });
    expect(plan.vendors[0]).toMatchObject({ outcome: 'write', createAccount: true, licenses: [] });
  });

  it('gives a seat-only vendor an account, and skips it once it has one', async () => {
    const first = await planLicenseBackfill([vendor({ id: 'free' })], [], { now: NOW });
    expect(first.vendors[0]).toMatchObject({ outcome: 'write', licenses: [] });
    expect(first.vendors[0]?.plan).toEqual({ tier: 'none', status: 'none' });

    const again = await planLicenseBackfill([vendor({ id: 'free', account_id: 'ba-x' })], [], {
      now: NOW,
    });
    expect(again.vendors[0]?.outcome).toBe('nothing-to-write');
  });

  it('puts licenses on the existing account without creating one', async () => {
    const plan = await planLicenseBackfill(
      [entitled('v1', 'active', { account_id: 'ba-existing' })],
      [],
      { now: NOW },
    );
    expect(plan.vendors[0]).toMatchObject({ createAccount: false, accountId: 'ba-existing' });
    expect(plan.vendors[0]?.licenses).toHaveLength(1);
  });

  it('skips a vendor that already carries a license', async () => {
    const plan = await planLicenseBackfill(
      [entitled('v1', 'active', { license_count: 1, account_id: 'ba' })],
      [owns('v1', 'p1')],
      { now: NOW },
    );
    expect(plan.vendors[0]).toMatchObject({ outcome: 'already-licensed', licenses: [] });
  });

  it('refuses mirror drift in both directions and writes nothing for it', async () => {
    const plan = await planLicenseBackfill(
      [vendor({ id: 'fwd', verified: 1 }), entitled('rev', 'active', { verified: 0 })],
      [owns('rev', 'p1')],
      { now: NOW },
    );
    expect(plan.vendors.map((v) => v.outcome)).toEqual(['refused', 'refused']);
    for (const v of plan.vendors) {
      expect(buildVendorStatements(v, { now: NOW })).toEqual([]);
    }
  });

  it('leaves a product another live license holds unassigned, and never double-assigns in one run', async () => {
    const plan = await planLicenseBackfill(
      [entitled('a', 'active'), entitled('b', 'active')],
      [owns('a', 'held', 1), owns('a', 'shared'), owns('b', 'shared')],
      { now: NOW },
    );
    const [a, b] = plan.vendors;
    expect(a?.licenses.map((l) => l.assignedProductId)).toEqual(['shared', null]);
    expect(a?.heldElsewhere).toEqual(['held']);
    expect(b?.licenses.map((l) => l.assignedProductId)).toEqual([null]);
    expect(b?.heldElsewhere).toEqual(['shared']);
  });
});

describe('buildVendorStatements', () => {
  it('writes account, licenses, then one guarded audit row', async () => {
    const plan = await planLicenseBackfill(
      [entitled('v1', 'active', { company_name: "O'Brien & Co" })],
      [owns('v1', 'p1')],
      { now: NOW },
    );
    const p = plan.vendors[0]!;
    const stmts = buildVendorStatements(p, { now: NOW, operator: 'ops@example.com' });
    expect(stmts).toHaveLength(3);
    expect(stmts[0]).toMatch(/^INSERT INTO "billing_accounts"/);
    expect(stmts[0]).toContain("'O''Brien & Co'");
    expect(stmts[0]).toContain('WHERE NOT EXISTS');
    expect(stmts[1]).toMatch(/^INSERT INTO "licenses"/);
    expect(stmts[1]).toContain('NOT IN');
    expect(stmts[2]).toMatch(/^INSERT INTO "audit_log"/);
    expect(stmts[2]).toContain(`'${BILLING_ACCOUNT_BACKFILLED_ACTION}'`);
    expect(stmts[2]).toContain(`"id" = '${p.auditId}'`);
    expect(stmts[2]).toContain('ops@example.com');
  });

  it('omits the account insert when the vendor has one', async () => {
    const plan = await planLicenseBackfill([entitled('v1', 'active', { account_id: 'ba' })], [], {
      now: NOW,
    });
    const stmts = buildVendorStatements(plan.vendors[0]!, { now: NOW });
    expect(stmts.map((s) => s.split(' ')[2])).toEqual(['"licenses"', '"audit_log"']);
  });

  it('reads that are pure SELECTs', () => {
    for (const sql of [buildVendorsSql(), buildOwnedProductsSql(), buildLicenseDriftSql()]) {
      expect(sql.trimStart()).toMatch(/^SELECT/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    }
  });
});

describe('formatLicenseBackfillReport', () => {
  it('lists the perpetual rows, the zero-product vendors and the refused drift, with counts', async () => {
    const plan = await planLicenseBackfill(
      [
        entitled('perpetual-co', 'active', { ent_period_end: null }),
        entitled('dated-co', 'active'),
        entitled('gone-co', 'revoked'),
        vendor({ id: 'drift-co', verified: 1 }),
        entitled('done-co', 'active', { license_count: 2, account_id: 'ba' }),
      ],
      [owns('dated-co', 'p1'), owns('dated-co', 'p2'), owns('gone-co', 'p3')],
      { now: NOW },
    );
    expect(countBackfill(plan)).toEqual({
      vendorsInScope: 5,
      vendorsToWrite: 3,
      accountsToCreate: 3,
      liveLicenses: 3,
      endedLicenses: 1,
      assigned: 3,
      unassigned: 1,
      auditRows: 3,
      alreadyLicensed: 1,
      nothingToWrite: 0,
      refused: 1,
    });
    const report = formatLicenseBackfillReport(plan);
    expect(report).toContain('Perpetual rows (period_end NULL, licenses carry ends_at NULL): 1');
    expect(report).toContain('~ perpetual-co (perpetual-co)');
    expect(report).toContain('Zero-product vendors (one unassigned license): 1');
    expect(report).toContain('0 perpetual-co (perpetual-co)');
    expect(report).toContain('Mirror drift, refused and not repaired: 1');
    expect(report).toContain('! drift-co (drift-co): verified = 1 with no entitlement row');
    expect(report).toContain(
      '+ dated-co (dated-co): new account, entitlement active, 2 live, 0 ended',
    );
    expect(report).toContain(
      '+ gone-co (gone-co): new account, entitlement revoked, 0 live, 1 ended',
    );
    expect(report).not.toContain('done-co (done-co):');
  });

  it('says none for every empty list', async () => {
    const report = formatLicenseBackfillReport(await planLicenseBackfill([], [], { now: NOW }));
    expect(report.match(/\(none\)/g)).toHaveLength(4);
  });
});
