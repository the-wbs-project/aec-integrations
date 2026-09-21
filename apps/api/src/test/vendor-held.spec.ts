/**
 * The ops lanes' vendor-held rule (AECI-1005 / ADR 0035): the retraction consumer's
 * `vendor-held.mjs` and the strand audit's use of it through `classify.mjs`.
 *
 * Lives here for the reason `strand-classify.spec.ts` does: `scripts/ops/**` has no
 * test harness, and these modules are pure. Three things are pinned:
 *
 *   1. The plain-JS copy of the rule agrees with the API Worker's `isVendorHeld`.
 *   2. The DDL probe finds the 0044 columns on a migrated database and does NOT find
 *      them on a database that predates 0044, and the projection it builds runs on
 *      both. That is what keeps a daily audit green while production lags `main`.
 *   3. The consumer refuses a vendor-held row unless it is on HOLD, and the audit never
 *      reports one as source-gone.
 */

import { describe, expect, it } from 'vitest';

import { isVendorHeld as apiIsVendorHeld } from '../lib/integration-claims';
import {
  ddlHasColumn,
  isVendorHeld,
  vendorHeldColumnsSql,
  vendorHeldRefusals,
  // @ts-expect-error — plain-ESM ops module, deliberately untyped.
} from '../../../../scripts/ops/2026-09-retraction-consumer/vendor-held.mjs';
import {
  classifyRows,
  integrationEndpoints,
  integrationEntry,
  // @ts-expect-error — plain-ESM ops module, deliberately untyped.
} from '../../../../scripts/ops/2026-09-stranded-row-audit/classify.mjs';
import { makeTestDb } from './d1';

const DDL_SQL = `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`;

describe('isVendorHeld — the plain-JS copy agrees with the API Worker', () => {
  const cases = [
    { claimedAt: null, origin: 'aeci' },
    { claimedAt: '2026-09-21T00:00:00.000Z', origin: 'aeci' },
    { claimedAt: null, origin: 'vendor' },
    { claimedAt: '2026-09-21T00:00:00.000Z', origin: 'vendor' },
  ];
  it.each(cases)('%o', (row) => {
    expect(isVendorHeld(row)).toBe(apiIsVendorHeld(row));
    // And the snake-case spelling a raw `SELECT *` row carries.
    expect(isVendorHeld({ claimed_at: row.claimedAt, origin: row.origin })).toBe(
      apiIsVendorHeld(row),
    );
  });

  it('treats a row from a pre-0044 database (no such keys) as not held', () => {
    expect(isVendorHeld({ id: 'x' })).toBe(false);
  });
});

describe('the DDL probe', () => {
  it('finds both columns after 0044, and projects them', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (t.raw.prepare(DDL_SQL).get('integrations') as { sql: string }).sql;
      expect(ddlHasColumn(ddl, 'claimed_at')).toBe(true);
      expect(ddlHasColumn(ddl, 'origin')).toBe(true);
      const sql = vendorHeldColumnsSql('i', ddl);
      expect(sql).toBe('i.claimed_at AS claimedAt, i.origin AS origin');
      expect(() => t.raw.prepare(`SELECT ${sql} FROM integrations i`).all()).not.toThrow();
    } finally {
      t.dispose();
    }
  });

  it('finds neither before 0044, and projects NULLs that still run', async () => {
    const t = await makeTestDb({ upToExclusive: '0044_slippery_edwin_jarvis.sql' });
    try {
      const ddl = (t.raw.prepare(DDL_SQL).get('integrations') as { sql: string }).sql;
      expect(ddlHasColumn(ddl, 'claimed_at')).toBe(false);
      expect(ddlHasColumn(ddl, 'origin')).toBe(false);
      const sql = vendorHeldColumnsSql('i', ddl);
      expect(sql).toBe('NULL AS claimedAt, NULL AS origin');
      expect(() => t.raw.prepare(`SELECT ${sql} FROM integrations i`).all()).not.toThrow();
    } finally {
      t.dispose();
    }
  });

  it('never finds them on connector_evidenced_pairs, which has neither', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (t.raw.prepare(DDL_SQL).get('connector_evidenced_pairs') as { sql: string }).sql;
      expect(vendorHeldColumnsSql('e', ddl)).toBe('NULL AS claimedAt, NULL AS origin');
    } finally {
      t.dispose();
    }
  });

  it('does not mistake a name inside a CHECK for a column', () => {
    expect(ddlHasColumn('CREATE TABLE x (a text, CHECK ("origin" IN (\'a\')))', 'origin')).toBe(
      false,
    );
  });
});

describe('the retraction consumer refuses vendor-held rows', () => {
  const item = (id: string, row: Record<string, unknown>) => ({
    entry: { supabaseId: id },
    table: 'integrations',
    row,
  });
  const live = [
    item('a', { claimedAt: null, origin: 'aeci' }),
    item('b', { claimedAt: '2026-09-21T00:00:00.000Z', origin: 'aeci' }),
    item('c', { claimedAt: null, origin: 'vendor' }),
  ];

  it('names every vendor-held row in the cohort', () => {
    expect(
      vendorHeldRefusals(live).map((i: { entry: { supabaseId: string } }) => i.entry.supabaseId),
    ).toEqual(['b', 'c']);
  });

  it('lets a HELD vendor-held row through, because HOLD never deletes or confirms', () => {
    expect(
      vendorHeldRefusals(live, { b: 'owner claimed it' }).map(
        (i: { entry: { supabaseId: string } }) => i.entry.supabaseId,
      ),
    ).toEqual(['c']);
  });
});

describe('the strand audit never reports a vendor-held row as source-gone', () => {
  const row = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: id,
    mechanism_kind: 'native',
    source_product_id: 'p1',
    target_product_id: 'p2',
    built_by_vendor_id: null,
    powered_by_product_id: null,
    claim_count: 0,
    attestation_count: 0,
    ...extra,
  });
  const deps = { slugOf: (id: string) => id, promotedOf: () => true };

  it('buckets it as vendorHeld, and still reports the AECi-seeded orphan beside it', () => {
    const out = classifyRows({
      rows: [
        row('seeded-orphan', { claimedAt: null, origin: 'aeci' }),
        row('claimed', { claimedAt: '2026-09-21T00:00:00.000Z', origin: 'aeci' }),
        row('vendor-created', { claimedAt: null, origin: 'vendor' }),
      ],
      entryFor: integrationEntry,
      claimedIds: new Set<string>(),
      strandedProductIds: new Set<string>(),
      strandedVendorIds: new Set<string>(),
      endpointsOf: integrationEndpoints,
      deps,
    });
    expect(out.sourceGone.map((e: { id: string }) => e.id)).toEqual(['seeded-orphan']);
    expect(out.vendorHeld.map((e: { id: string }) => e.id)).toEqual(['claimed', 'vendor-created']);
  });

  it('still reports a stranded ENDPOINT on a vendor-held row, marked so nobody deletes the edge', () => {
    const out = classifyRows({
      rows: [row('claimed', { claimedAt: '2026-09-21T00:00:00.000Z', origin: 'aeci' })],
      entryFor: integrationEntry,
      claimedIds: new Set(['claimed']),
      strandedProductIds: new Set(['p2']),
      strandedVendorIds: new Set<string>(),
      endpointsOf: integrationEndpoints,
      deps,
    });
    expect(out.endpointStranded).toEqual([
      expect.objectContaining({ id: 'claimed', vendorHeld: true }),
    ]);
  });
});
