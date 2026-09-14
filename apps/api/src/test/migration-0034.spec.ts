import { describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from './d1';

/**
 * AECI-921 — `0034_sloppy_dakota_north.sql` against NON-EMPTY data.
 *
 * `docs/migrations.md` §3.3a rule 3: "Verify against non-empty data, not just a
 * fresh DB. A recreate that applies cleanly to an empty table proves nothing."
 * That warning is unusually literal here — see the second guard below.
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────
 * The migration recreates `integrations`, which sits at the top of a TWO-level
 * cascade: `integrations` → `claims` → `attestations`, both ON DELETE CASCADE.
 * drizzle-kit's recreate is `CREATE __new_integrations` → copy → `DROP TABLE
 * integrations` → rename, and in SQLite `DROP TABLE` performs an implicit DELETE
 * that FIRES foreign-key actions — `PRAGMA defer_foreign_keys` defers violation
 * *reporting*, not cascade *actions*. Same table and same chain as
 * `0027_powerful_killraven.sql`, which measured 1,697 claims and 1,697
 * attestations destroyed in generated order.
 *
 * The second thing guarded is the BACKFILL, and it is what makes the generated
 * order fail loudly rather than quietly here: the copy is a straight `SELECT
 * "direction"`, so every existing row carries `one-way` or `bidirectional` into a
 * table whose CHECK admits neither. On an EMPTY database that INSERT touches no
 * rows and the file applies clean. On a real one it aborts. A local "it worked"
 * is therefore evidence of nothing at all, which is exactly the shape of mistake
 * rule 3 exists to catch.
 *
 * The third is the re-spelling's MEANING. `one-way` → `a_to_b` is exact, not
 * approximate, because `one-way` has always meant "flows from this row's source
 * to its target" and A is defined as that same `source_product_id`. This
 * migration must change no row's meaning; correcting the genuinely-inverted rows
 * is AECI-920's job, upstream.
 */

const MIGRATION = '0034_sloppy_dakota_north.sql';

const NOW = '2026-09-14T00:00:00.000Z';

const PROCORE = 'p-procore';
const SAGE = 'p-sage';
const REVIT = 'p-revit';
const BIM360 = 'p-bim360';

/** One integration per pre-migration direction value, including the NULL case. */
const EDGE_ONE_WAY = 'i-procore-sage';
const EDGE_BIDIRECTIONAL = 'i-revit-bim360';
const EDGE_NULL = 'i-procore-revit';

const rows = (t: TestDb, sql: string): Record<string, unknown>[] =>
  t.raw.prepare(sql).all() as Record<string, unknown>[];
const one = (t: TestDb, sql: string) => rows(t, sql)[0]!;

/**
 * Seeds the pre-0034 world: three integrations spanning every legal direction
 * value, two of them carrying claims and attestations so a cascade anywhere shows
 * up as a missing row rather than a subtle count difference.
 */
async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);

  for (const [id, slug, name] of [
    [PROCORE, 'procore', 'Procore'],
    [SAGE, 'sage-intacct', 'Sage Intacct'],
    [REVIT, 'revit', 'Revit'],
    [BIM360, 'bim-360', 'BIM 360'],
  ] as const) {
    run(
      `INSERT INTO products (id, slug, name, product_role, created_at, updated_at)
         VALUES (?,?,?,'application',?,?)`,
      id,
      slug,
      name,
      NOW,
      NOW,
    );
  }

  for (const [id, source, target, direction] of [
    [EDGE_ONE_WAY, PROCORE, SAGE, 'one-way'],
    [EDGE_BIDIRECTIONAL, REVIT, BIM360, 'bidirectional'],
    [EDGE_NULL, PROCORE, REVIT, null],
  ] as const) {
    run(
      `INSERT INTO integrations
         (id, name, source_product_id, target_product_id, mechanism_kind, direction,
          maintained_by, created_at, updated_at)
       VALUES (?, 'seeded', ?, ?, 'native', ?, 'aeci', ?, ?)`,
      id,
      source,
      target,
      direction,
      NOW,
      NOW,
    );
  }

  for (const [id, slug, name] of [
    ['d-rfis', 'rfis', 'RFIs'],
    ['d-budgets', 'budgets', 'Budgets'],
  ] as const) {
    run(
      `INSERT INTO taxonomy_data_objects (id, slug, name, created_at, updated_at)
         VALUES (?,?,?,?,?)`,
      id,
      slug,
      name,
      NOW,
      NOW,
    );
  }

  // Two claims on each of two anchors, one attestation each.
  for (const [claimId, anchor, dataObjectId, direction] of [
    ['c-ow-rfis', EDGE_ONE_WAY, 'd-rfis', 'a_to_b'],
    ['c-ow-budgets', EDGE_ONE_WAY, 'd-budgets', 'b_to_a'],
    ['c-bi-rfis', EDGE_BIDIRECTIONAL, 'd-rfis', 'both'],
    ['c-bi-budgets', EDGE_BIDIRECTIONAL, 'd-budgets', 'a_to_b'],
  ] as const) {
    run(
      `INSERT INTO claims (id, integration_id, data_object_id, direction, origin, created_at, updated_at)
         VALUES (?,?,?,?,'aeci',?,?)`,
      claimId,
      anchor,
      dataObjectId,
      direction,
      NOW,
      NOW,
    );
    run(
      `INSERT INTO attestations (id, claim_id, source, asserted, created_at, updated_at)
         VALUES (?,?, 'aeci', 1, ?, ?)`,
      `at-${claimId}`,
      claimId,
      NOW,
      NOW,
    );
  }
  return t;
}

describe(`${MIGRATION} — against seeded data`, () => {
  it('destroys no integration, no claim and no attestation (the two-level cascade)', async () => {
    const t = await seedPreMigration();
    const before = one(
      t,
      `SELECT (SELECT COUNT(*) FROM integrations) i,
              (SELECT COUNT(*) FROM claims) c,
              (SELECT COUNT(*) FROM attestations) a`,
    );
    expect(before).toEqual({ i: 3, c: 4, a: 4 });

    t.applyMigration(MIGRATION);

    // Conserved in BOTH directions — none destroyed, none duplicated by the
    // carry-and-restore.
    expect(
      one(
        t,
        `SELECT (SELECT COUNT(*) FROM integrations) i,
                (SELECT COUNT(*) FROM claims) c,
                (SELECT COUNT(*) FROM attestations) a`,
      ),
    ).toEqual({ i: 3, c: 4, a: 4 });
    t.dispose();
  });

  it('re-spells every direction without changing a row s meaning', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    // `one-way` -> `a_to_b` is exact: both mean "flows from this row's source to
    // its target". NULL stays NULL — "nobody established it" is a legal state.
    expect(rows(t, `SELECT id, direction FROM integrations ORDER BY id`)).toEqual([
      { id: EDGE_NULL, direction: null },
      { id: EDGE_ONE_WAY, direction: 'a_to_b' },
      { id: EDGE_BIDIRECTIONAL, direction: 'both' },
    ]);
    t.dispose();
  });

  it('leaves the endpoints of every row exactly where they were', async () => {
    // The migration RE-SPELLS. It must not reorder an endpoint, because that is
    // how you would "fix" an inverted row here instead of upstream — and 6 of the
    // 20 rows in AECI-920's probe were already correct, so a blanket flip breaks
    // working data.
    const t = await seedPreMigration();
    const before = rows(
      t,
      `SELECT id, source_product_id, target_product_id FROM integrations ORDER BY id`,
    );

    t.applyMigration(MIGRATION);

    expect(
      rows(t, `SELECT id, source_product_id, target_product_id FROM integrations ORDER BY id`),
    ).toEqual(before);
    t.dispose();
  });

  it('preserves every claim id, its anchor_id, and the attestation that resolves to it', async () => {
    const t = await seedPreMigration();
    const before = rows(t, `SELECT id, anchor_id, direction FROM claims ORDER BY id`);

    t.applyMigration(MIGRATION);

    // `claims.direction` is NOT rewritten by this migration — it already spoke
    // this vocabulary. `anchor_id` is recomputed by the generated column, not
    // copied, and identical values are what keep `claims_identity_key`, every
    // `audit_log` row and every attestation resolving.
    expect(rows(t, `SELECT id, anchor_id, direction FROM claims ORDER BY id`)).toEqual(before);

    expect(
      rows(
        t,
        `SELECT c.id cid, a.id aid FROM claims c JOIN attestations a ON a.claim_id = c.id
         ORDER BY c.id`,
      ),
    ).toEqual([
      { cid: 'c-bi-budgets', aid: 'at-c-bi-budgets' },
      { cid: 'c-bi-rfis', aid: 'at-c-bi-rfis' },
      { cid: 'c-ow-budgets', aid: 'at-c-ow-budgets' },
      { cid: 'c-ow-rfis', aid: 'at-c-ow-rfis' },
    ]);
    t.dispose();
  });

  it('accepts b_to_a afterwards — the value the old vocabulary could not express', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    // THE POINT OF THE WHOLE CHANGE. An edge whose builder is the data consumer
    // keeps its authorship-ordered endpoints and says the flow runs the other
    // way (AECI-920).
    t.raw.prepare(`UPDATE integrations SET direction = 'b_to_a' WHERE id = ?`).run(EDGE_ONE_WAY);
    expect(
      one(t, `SELECT direction FROM integrations WHERE id = '${EDGE_ONE_WAY}'`).direction,
    ).toBe('b_to_a');
    t.dispose();
  });

  it('rejects the legacy spellings afterwards', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    for (const legacy of ['one-way', 'bidirectional']) {
      expect(() =>
        t.raw.prepare(`UPDATE integrations SET direction = ? WHERE id = ?`).run(legacy, EDGE_NULL),
      ).toThrow(/CHECK constraint failed/);
    }
    t.dispose();
  });

  it('still rejects an out-of-vocabulary value', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    expect(() =>
      t.raw.prepare(`UPDATE integrations SET direction = 'sideways' WHERE id = ?`).run(EDGE_NULL),
    ).toThrow(/CHECK constraint failed/);
    t.dispose();
  });

  it('keeps `integrations` childless of anything but `claims`', async () => {
    // The order in the migration file is written for exactly one inbound FK. If
    // this list grows, the next recreate of this table needs more carry tables —
    // read the migration's header before adding one. The at-HEAD twin of this
    // assertion lives in `d1.spec.ts`, which is what can still fail after a later
    // migration adds a child; this one is pinned to the schema as 0034 left it.
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    const inbound = t.raw
      .prepare(
        `SELECT m.name FROM sqlite_master m WHERE m.type = 'table'
           AND m.name NOT LIKE 'sqlite_%'
           AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name) f
                       WHERE f."table" = 'integrations')
         ORDER BY m.name`,
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(inbound).toEqual(['claims']);
    t.dispose();
  });

  it('leaves no carry table behind', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    expect(
      rows(t, `SELECT name FROM sqlite_master WHERE name LIKE '__carry_%' OR name LIKE '__new_%'`),
    ).toEqual([]);
    t.dispose();
  });

  it('recreates every index the table had', async () => {
    const t = await seedPreMigration();
    const before = rows(
      t,
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='integrations'
         AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    );

    t.applyMigration(MIGRATION);

    // A recreate silently drops every index with the old table. Six of them here,
    // two partial — and a missing one costs a full scan without ever failing.
    expect(
      rows(
        t,
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='integrations'
           AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ),
    ).toEqual(before);
    expect(before).toHaveLength(6);
    t.dispose();
  });
});
