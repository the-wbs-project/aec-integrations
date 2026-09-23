import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1092 — `0049_rainy_puma.sql`, the two-arm anchor on
 * `integration_field_challenges` (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13).
 *
 * The migration is a TABLE REBUILD: `integration_id` loses its NOT NULL, a second
 * anchor `evidenced_pair_id` arrives, and a sum-form CHECK holds exactly one of them.
 * A rebuild is only safe because nothing references this table, and the generated
 * form had three defects the committed file corrects by hand (see its header). These
 * tests hold every one of those decisions:
 *
 *   1. The committed statement order: the D1 pragma, CREATE __new, an explicit-column
 *      copy that never reads `evidenced_pair_id` from the old table, DROP, RENAME,
 *      then the indexes. No `foreign_keys=` pragma.
 *   2. Applied to a SEEDED pre-0049 database, every contest survives with every
 *      column, including the AECI-1009 protest data, and lands in the integrations arm.
 *   3. The anchor CHECK refuses both "neither" and "both", and accepts either arm.
 *   4. Both hand-written protest CHECKs from 0047 are in the live DDL and enforced.
 *   5. Every index is present, and the evidenced open-contest key is enforced.
 *   6. Deleting either anchor parent cascades its contests, and deleting a profile
 *      still nulls the protest profile columns.
 */
const MIGRATION = '0049_rainy_puma.sql';
const NOW = '2026-09-23T00:00:00.000Z';

const stripComments = (s: string): string =>
  s
    .split('\n')
    .filter((line) => !line.startsWith('--'))
    .join('\n')
    .trim();

const count = (t: TestDb, table: string): number =>
  (t.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

const ddl = (t: TestDb): string =>
  (
    t.raw
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'integration_field_challenges'`,
      )
      .get() as { sql: string }
  ).sql;

function seedParents(t: TestDb): void {
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);
  for (const [id, slug] of [
    ['v1', 'v1'],
    ['v2', 'v2'],
  ] as const) {
    run(
      `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES (?,?,?,?,?)`,
      id,
      slug,
      slug.toUpperCase(),
      NOW,
      NOW,
    );
  }
  for (const [id, slug] of [
    ['p1', 'a'],
    ['p2', 'b'],
    ['p3', 'c'],
  ] as const) {
    run(
      `INSERT INTO products (id, slug, name, created_at, updated_at) VALUES (?,?,?,?,?)`,
      id,
      slug,
      slug.toUpperCase(),
      NOW,
      NOW,
    );
  }
  run(`INSERT INTO profiles (id, created_at, updated_at) VALUES ('u1', ?, ?)`, NOW, NOW);
  run(
    `INSERT INTO workflow_instances (id, workflow_type, entity_id, current_state, initiated_at)
       VALUES ('w1','correction_request','f1','declined',?)`,
    NOW,
  );
  run(
    `INSERT INTO workflow_instances (id, workflow_type, entity_id, current_state, initiated_at)
       VALUES ('w2','correction_request','f1','open',?)`,
    NOW,
  );
  run(
    `INSERT INTO integrations (id, source_product_id, target_product_id, created_at, updated_at)
       VALUES ('i1','p1','p2',?,?)`,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO connector_evidenced_pairs
       (id, connector_product_id, product_a_id, product_b_id, created_at, updated_at)
     VALUES ('e1','p3','p1','p2',?,?)`,
    NOW,
    NOW,
  );
}

/** Every column a pre-0049 contest carries, protest data included. */
const PROTESTED_ROW = {
  id: 'f1',
  integration_id: 'i1',
  field: 'name',
  current_value: 'Old',
  proposed_value: 'New',
  reason: 'Wrong name',
  submitter_vendor_id: 'v1',
  submitted_by: 'u1',
  routed_to: 'owner',
  owner_vendor_id: 'v2',
  status: 'declined',
  decision_note: 'No',
  decided_by: 'u1',
  decided_at: NOW,
  upstream_linear_issue_id: null,
  upstream_linear_issue_url: null,
  workflow_id: 'w1',
  protest_status: 'open',
  protest_basis: 'declined',
  protest_reason: 'It is wrong',
  protest_evidence: '["https://example.com/a"]',
  protested_by: 'u1',
  protested_at: NOW,
  protest_reply_due_at: '2026-10-07T00:00:00.000Z',
  protest_reply: 'It is right',
  protest_reply_evidence: '[]',
  protest_replied_by: 'u1',
  protest_replied_at: NOW,
  protest_decision_note: null,
  protest_decided_by: null,
  protest_decided_at: null,
  protest_workflow_id: 'w2',
  created_at: NOW,
  updated_at: NOW,
} as const;

const PLAIN_ROW = {
  ...PROTESTED_ROW,
  id: 'f2',
  field: 'docs_url',
  current_value: null,
  proposed_value: 'https://example.com/docs',
  submitted_by: null,
  routed_to: 'aeci',
  owner_vendor_id: null,
  status: 'accepted',
  decided_by: null,
  upstream_linear_issue_id: 'lin_1',
  upstream_linear_issue_url: 'https://linear.app/x/issue/AECI-1',
  workflow_id: null,
  protest_status: null,
  protest_basis: null,
  protest_reason: null,
  protest_evidence: null,
  protested_by: null,
  protested_at: null,
  protest_reply_due_at: null,
  protest_reply: null,
  protest_reply_evidence: null,
  protest_replied_by: null,
  protest_replied_at: null,
  protest_workflow_id: null,
} as const;

function insertRow(t: TestDb, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  t.raw
    .prepare(
      `INSERT INTO integration_field_challenges (${cols.join(', ')}) VALUES (${cols
        .map(() => '?')
        .join(', ')})`,
    )
    .run(...cols.map((c) => row[c]));
}

async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  seedParents(t);
  insertRow(t, PROTESTED_ROW);
  insertRow(t, PLAIN_ROW);
  return t;
}

describe(`${MIGRATION} — the committed statement order`, () => {
  it('rebuilds in the safe order, with the D1 pragma and an explicit-column copy', () => {
    const statements = statementsForMigration(MIGRATION).map(stripComments);
    expect(statements[0]).toBe('PRAGMA defer_foreign_keys = true;');
    expect(statements[1]).toMatch(/^CREATE TABLE `__new_integration_field_challenges`/);
    expect(statements[2]).toMatch(/^INSERT INTO `__new_integration_field_challenges`/);
    expect(statements[3]).toBe('DROP TABLE `integration_field_challenges`;');
    expect(statements[4]).toBe(
      'ALTER TABLE `__new_integration_field_challenges` RENAME TO `integration_field_challenges`;',
    );
    for (const sql of statements.slice(5)) expect(sql).toMatch(/^CREATE (UNIQUE )?INDEX /);
    for (const sql of statements) expect(sql).not.toMatch(/PRAGMA foreign_keys/i);

    // The copy never reads the new column from the old table (the generated form
    // did, and would have aborted), and names the same columns on both sides.
    const copy = statements[2]!;
    const [into, select] = copy.split(' SELECT ');
    expect(select).not.toContain('evidenced_pair_id');
    expect(into).not.toContain('evidenced_pair_id');
    const listed = (s: string) => s.slice(s.indexOf('(') + 1, s.indexOf(')'));
    expect(listed(into!)).toBe(select!.slice(0, select!.indexOf(' FROM ')));
  });
});

describe(`${MIGRATION} — applied to seeded data`, () => {
  it('keeps every contest, and every protest column, in the integrations arm', async () => {
    const t = await seedPreMigration();
    try {
      t.applyMigration(MIGRATION);
      expect(count(t, 'integration_field_challenges')).toBe(2);
      const read = (id: string) =>
        t.raw.prepare(`SELECT * FROM integration_field_challenges WHERE id = ?`).get(id);
      expect(read('f1')).toEqual({ ...PROTESTED_ROW, evidenced_pair_id: null });
      expect(read('f2')).toEqual({ ...PLAIN_ROW, evidenced_pair_id: null });
      // The parents are untouched: the rebuild drops a CHILD, which fires nothing.
      expect(count(t, 'integrations')).toBe(1);
      expect(count(t, 'connector_evidenced_pairs')).toBe(1);
      expect(count(t, 'workflow_instances')).toBe(2);
    } finally {
      t.dispose();
    }
  });
});

describe(`${MIGRATION} — constraints at HEAD`, () => {
  it('holds exactly one anchor, in both directions', async () => {
    const t = await makeTestDb();
    try {
      seedParents(t);
      const base = { ...PLAIN_ROW, upstream_linear_issue_id: null, status: 'open' };
      expect(() => insertRow(t, { ...base, id: 'n1', integration_id: null })).toThrow(/CHECK/);
      expect(() => insertRow(t, { ...base, id: 'n2', evidenced_pair_id: 'e1' })).toThrow(/CHECK/);
      expect(() => insertRow(t, { ...base, id: 'ok1' })).not.toThrow();
      expect(() =>
        insertRow(t, { ...base, id: 'ok2', integration_id: null, evidenced_pair_id: 'e1' }),
      ).not.toThrow();
      expect(ddl(t)).toContain(
        `CONSTRAINT "integration_field_challenges_anchor_check" CHECK((("integration_id" IS NOT NULL) + ("evidenced_pair_id" IS NOT NULL)) = 1)`,
      );
    } finally {
      t.dispose();
    }
  });

  it('keeps both hand-written protest CHECKs from 0047, and enforces them', async () => {
    const t = await makeTestDb();
    try {
      seedParents(t);
      insertRow(t, PROTESTED_ROW);
      const text = ddl(t);
      expect(text).toContain(
        `CONSTRAINT "integration_field_challenges_protest_status_check" CHECK ("protest_status" IN ('open', 'upheld', 'rejected', 'withdrawn'))`,
      );
      expect(text).toContain(
        `CONSTRAINT "integration_field_challenges_protest_basis_check" CHECK ("protest_basis" IN ('declined', 'silence'))`,
      );
      const set = (col: string, value: string) =>
        t.raw
          .prepare(`UPDATE integration_field_challenges SET ${col} = ? WHERE id = 'f1'`)
          .run(value);
      expect(() => set('protest_status', 'rejected')).not.toThrow();
      expect(() => set('protest_status', 'pending')).toThrow(/CHECK/);
      expect(() => set('protest_basis', 'silence')).not.toThrow();
      expect(() => set('protest_basis', 'late')).toThrow(/CHECK/);
    } finally {
      t.dispose();
    }
  });

  it('has every index, and one open contest per field per vendor on each arm', async () => {
    const t = await makeTestDb();
    try {
      const indexes = t.raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
             AND tbl_name = 'integration_field_challenges' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(indexes).toEqual([
        'integration_field_challenges_open_evidenced_key',
        'integration_field_challenges_open_key',
        'integration_field_challenges_owner_idx',
        'integration_field_challenges_protest_idx',
        'integration_field_challenges_queue_idx',
        'integration_field_challenges_submitter_idx',
      ]);

      // The three partial indexes keep their WHERE clauses: a regenerated index
      // without one would turn "one OPEN contest" into "one contest ever".
      const indexSql = (name: string) =>
        (
          t.raw
            .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
            .get(name) as { sql: string }
        ).sql;
      expect(indexSql('integration_field_challenges_open_key')).toMatch(
        /\(`integration_id`,`field`,`submitter_vendor_id`\) WHERE "status" = 'open'$/,
      );
      expect(indexSql('integration_field_challenges_open_evidenced_key')).toMatch(
        /\(`evidenced_pair_id`,`field`,`submitter_vendor_id`\) WHERE "status" = 'open' AND "evidenced_pair_id" IS NOT NULL$/,
      );
      expect(indexSql('integration_field_challenges_protest_idx')).toMatch(
        /\(`protest_status`,`protested_at`\) WHERE "protest_status" IS NOT NULL$/,
      );

      seedParents(t);
      const open = {
        ...PLAIN_ROW,
        upstream_linear_issue_id: null,
        status: 'open',
        integration_id: null,
        evidenced_pair_id: 'e1',
      };
      insertRow(t, { ...open, id: 'e-a' });
      expect(() => insertRow(t, { ...open, id: 'e-b' })).toThrow(/UNIQUE/);
      // A closed row never blocks a new one, and the integrations arm is separate.
      expect(() => insertRow(t, { ...open, id: 'e-c', status: 'withdrawn' })).not.toThrow();
      expect(() =>
        insertRow(t, { ...open, id: 'i-a', integration_id: 'i1', evidenced_pair_id: null }),
      ).not.toThrow();
    } finally {
      t.dispose();
    }
  });

  it('cascades from either anchor, and still nulls the protest profile columns', async () => {
    const t = await makeTestDb();
    try {
      seedParents(t);
      insertRow(t, PROTESTED_ROW);
      insertRow(t, {
        ...PLAIN_ROW,
        id: 'f3',
        integration_id: null,
        evidenced_pair_id: 'e1',
        upstream_linear_issue_id: null,
      });
      t.raw.prepare(`DELETE FROM profiles WHERE id = 'u1'`).run();
      expect(
        t.raw
          .prepare(
            `SELECT submitted_by, decided_by, protested_by, protest_replied_by, protest_decided_by
               FROM integration_field_challenges WHERE id = 'f1'`,
          )
          .get(),
      ).toEqual({
        submitted_by: null,
        decided_by: null,
        protested_by: null,
        protest_replied_by: null,
        protest_decided_by: null,
      });
      t.raw.prepare(`DELETE FROM connector_evidenced_pairs WHERE id = 'e1'`).run();
      expect(count(t, 'integration_field_challenges')).toBe(1);
      t.raw.prepare(`DELETE FROM integrations WHERE id = 'i1'`).run();
      expect(count(t, 'integration_field_challenges')).toBe(0);
    } finally {
      t.dispose();
    }
  });
});
