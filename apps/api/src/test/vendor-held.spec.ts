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
  guardedAnchorDeleteSql,
  isVendorHeld,
  notVendorHeldSql,
  tableDdlOrThrow,
  vendorHeldColumnsSql,
  vendorHeldRefusals,
  // @ts-expect-error — plain-ESM ops module, deliberately untyped.
} from '../../../../scripts/ops/2026-09-retraction-consumer/vendor-held.mjs';
import {
  classifyRows,
  evidencedPairEndpoints,
  evidencedPairEntry,
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

  it('finds both on connector_evidenced_pairs after 0048, and neither before it (AECI-1088)', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (t.raw.prepare(DDL_SQL).get('connector_evidenced_pairs') as { sql: string }).sql;
      expect(vendorHeldColumnsSql('e', ddl)).toBe('e.claimed_at AS claimedAt, e.origin AS origin');
    } finally {
      t.dispose();
    }
    const pre = await makeTestDb({ upToExclusive: '0048_majestic_mentallo.sql' });
    try {
      const ddl = (pre.raw.prepare(DDL_SQL).get('connector_evidenced_pairs') as { sql: string })
        .sql;
      expect(vendorHeldColumnsSql('e', ddl)).toBe('NULL AS claimedAt, NULL AS origin');
    } finally {
      pre.dispose();
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

describe('an empty table-definition read is could-not-check (AECI-1005 review)', () => {
  it('throws rather than falling back to an empty definition', () => {
    expect(() => tableDdlOrThrow([], 'integrations')).toThrow(/could not read/);
    expect(() => tableDdlOrThrow([{ sql: '' }], 'integrations')).toThrow(/could not read/);
    expect(() => tableDdlOrThrow(undefined, 'integrations')).toThrow(/could not read/);
    expect(tableDdlOrThrow([{ sql: 'CREATE TABLE x (a text)' }], 'x')).toBe(
      'CREATE TABLE x (a text)',
    );
  });
});

describe('the consumer DELETE re-checks vendor-held at write time (AECI-1005 review)', () => {
  it('keeps a row claimed after the plan, and is a no-op clause before 0044', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (t.raw.prepare(DDL_SQL).get('integrations') as { sql: string }).sql;
      const clause = notVendorHeldSql(ddl);
      expect(clause).toBe(` AND "claimed_at" IS NULL AND "origin" <> 'vendor'`);
      const now = '2026-09-22T00:00:00.000Z';
      for (const [id, slug] of [
        ['p1', 'a'],
        ['p2', 'b'],
      ]) {
        t.raw
          .prepare(
            `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, slug, slug, now, now);
      }
      t.raw
        .prepare(
          `INSERT INTO integrations (id, source_product_id, target_product_id, claimed_at, created_at, updated_at)
             VALUES ('i1', 'p1', 'p2', ?, ?, ?)`,
        )
        .run(now, now, now);
      t.raw.prepare(`DELETE FROM integrations WHERE id IN ('i1')${clause}`).run();
      expect(t.raw.prepare('SELECT count(*) AS n FROM integrations').get()).toEqual({ n: 1 });
    } finally {
      t.dispose();
    }
    const pre = await makeTestDb({ upToExclusive: '0044_slippery_edwin_jarvis.sql' });
    try {
      const ddl = (pre.raw.prepare(DDL_SQL).get('integrations') as { sql: string }).sql;
      expect(notVendorHeldSql(ddl)).toBe('');
    } finally {
      pre.dispose();
    }
  });
});

describe('the consumer DELETEs on connector_evidenced_pairs keep vendor-held pairs (AECI-1088)', () => {
  const NOW = '2026-09-23T00:00:00.000Z';

  it('deletes an AECi-seeded pair with its children and keeps a claimed and a vendor-created one', async () => {
    const t = await makeTestDb();
    try {
      const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
      for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'c']) {
        run(
          `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          id,
          id,
          id,
          NOW,
          NOW,
        );
      }
      run(
        `INSERT INTO taxonomy_data_objects (id, slug, name, display_order, created_at, updated_at)
           VALUES ('do1','rfis','RFIs',10,?,?)`,
        NOW,
        NOW,
      );
      const pair = (id: string, a: string, claimedAt: string | null, origin: string) => {
        run(
          `INSERT INTO connector_evidenced_pairs
             (id, connector_product_id, product_a_id, product_b_id, claimed_at, origin, created_at, updated_at)
           VALUES (?, 'c', ?, 'p5', ?, ?, ?, ?)`,
          id,
          a,
          claimedAt,
          origin,
          NOW,
          NOW,
        );
        run(
          `INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction, created_at, updated_at)
             VALUES (?, ?, 'do1', 'a_to_b', ?, ?)`,
          `claim-${id}`,
          id,
          NOW,
          NOW,
        );
        run(
          `INSERT INTO attestations (id, claim_id, source, asserted, created_at, updated_at)
             VALUES (?, ?, 'aeci', 1, ?, ?)`,
          `att-${id}`,
          `claim-${id}`,
          NOW,
          NOW,
        );
      };
      pair('seeded', 'p1', null, 'aeci');
      pair('claimed', 'p2', NOW, 'aeci');
      pair('vendor', 'p3', null, 'vendor');

      const ddl = (t.raw.prepare(DDL_SQL).get('connector_evidenced_pairs') as { sql: string }).sql;
      const statements = guardedAnchorDeleteSql({
        table: 'connector_evidenced_pairs',
        anchorColumn: 'connector_evidenced_pair_id',
        ph: `'seeded', 'claimed', 'vendor'`,
        keep: notVendorHeldSql(ddl),
      });
      for (const statement of statements) t.raw.prepare(statement).run();

      const ids = (table: string) =>
        (t.raw.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map(
          (r) => r.id,
        );
      expect(ids('connector_evidenced_pairs')).toEqual(['claimed', 'vendor']);
      expect(ids('claims')).toEqual(['claim-claimed', 'claim-vendor']);
      expect(ids('attestations')).toEqual(['att-claimed', 'att-vendor']);
    } finally {
      t.dispose();
    }
  });

  it('renders the integrations DELETEs exactly as before the helper existed', () => {
    const keep = ` AND "claimed_at" IS NULL AND "origin" <> 'vendor'`;
    expect(
      guardedAnchorDeleteSql({
        table: 'integrations',
        anchorColumn: 'integration_id',
        ph: `'a'`,
        keep,
      }),
    ).toEqual([
      `DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (SELECT id FROM integrations WHERE id IN ('a')${keep}));`,
      `DELETE FROM claims WHERE integration_id IN (SELECT id FROM integrations WHERE id IN ('a')${keep});`,
      `DELETE FROM integrations WHERE id IN ('a')${keep};`,
    ]);
  });
});

describe('the strand audit never reports a vendor-held PAIR as source-gone (AECI-1088)', () => {
  const pairRow = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: id,
    mechanism_name: 'Agave',
    product_a_id: 'p1',
    product_b_id: 'p2',
    connector_product_id: 'c',
    built_by_vendor_id: null,
    claim_count: 0,
    attestation_count: 0,
    ...extra,
  });
  const deps = { slugOf: (id: string) => id, promotedOf: () => true };

  it('buckets claimed and vendor-created pairs as vendorHeld', () => {
    const out = classifyRows({
      rows: [
        pairRow('seeded-orphan', { claimedAt: null, origin: 'aeci' }),
        pairRow('claimed', { claimedAt: '2026-09-23T00:00:00.000Z', origin: 'aeci' }),
        pairRow('vendor-created', { claimedAt: null, origin: 'vendor' }),
      ],
      entryFor: evidencedPairEntry,
      claimedIds: new Set<string>(),
      strandedProductIds: new Set<string>(),
      strandedVendorIds: new Set<string>(),
      endpointsOf: evidencedPairEndpoints,
      deps,
    });
    expect(out.sourceGone.map((e: { id: string }) => e.id)).toEqual(['seeded-orphan']);
    expect(out.vendorHeld.map((e: { id: string }) => e.id)).toEqual(['claimed', 'vendor-created']);
  });
});
