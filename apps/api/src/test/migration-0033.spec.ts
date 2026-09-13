import { describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from './d1';

/**
 * AECI-891 — `0033_solid_nightcrawler.sql` against NON-EMPTY data.
 *
 * `docs/migrations.md` §3.3a rule 3: "Verify against non-empty data, not just a
 * fresh DB. A recreate that applies cleanly to an empty table proves nothing."
 * Every case here seeds the PRE-migration shape (the harness stops before 0033),
 * then applies the one migration and asserts what survived.
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────
 * The migration recreates `claims`, which sits at the top of a one-level cascade:
 * `claims` → `attestations` (ON DELETE CASCADE). drizzle-kit's recreate is
 * `CREATE __new_claims` → copy → `DROP TABLE claims` → rename, and in SQLite
 * `DROP TABLE` performs an implicit DELETE that FIRES foreign-key actions —
 * `PRAGMA defer_foreign_keys` defers violation *reporting*, not cascade *actions*.
 * Applied in the generated order this migration destroys every attestation in the
 * database, roughly 1,872 rows in production, while the claims themselves survive
 * the copy. That asymmetry is what makes the loss quiet: the table everyone looks
 * at still has its rows.
 *
 * The hand-assembled order (carry tables, the child emptied before the parent is
 * dropped) is what prevents that, and the first case below is what fails if
 * someone reorders the file or regenerates it.
 *
 * The second thing guarded is the CHECK's FORM. `claims_anchor_check` went from
 * `a <> b` to a sum of three `IS NOT NULL` booleans, because `a <> b <> c` parses
 * as `(a <> b) <> c` and is TRUE when all three anchors are set — the obvious
 * three-arm translation would have admitted exactly the row it looks like it
 * forbids. The `rejects` case proves the sum form catches it.
 */

const MIGRATION = '0033_solid_nightcrawler.sql';

const NOW = '2026-09-13T00:00:00.000Z';

const PROCORE = 'p-procore';
const SAGE = 'p-sage';
const AGAVE = 'p-agave';

/** One anchor of each pre-existing kind, plus the one this migration adds. */
const EDGE = 'i-procore-sage'; // `integrations` — the delivered accountable-party tier
const EVIDENCED = 'e-agave-procore-sage'; // `connector_evidenced_pairs` — delivered, connector-powered
const REACHED = 'recCP0000000001'; // `connector_pairs` — the REACHABLE tier, new here

const rows = (t: TestDb, sql: string): Record<string, unknown>[] =>
  t.raw.prepare(sql).all() as Record<string, unknown>[];
const one = (t: TestDb, sql: string) => rows(t, sql)[0]!;

/**
 * Seeds the pre-0033 world: both delivered anchors carrying claims and
 * attestations, plus a fully-formed `connector_pairs` row that NOTHING can point
 * at yet. That row is the target the migration makes reachable.
 */
async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);

  run(
    `INSERT INTO vendors (id, slug, company_name, created_at, updated_at)
       VALUES ('v-agave','agave','Agave',?,?)`,
    NOW,
    NOW,
  );
  for (const [id, slug, name, role] of [
    [PROCORE, 'procore', 'Procore', 'application'],
    [SAGE, 'sage-intacct', 'Sage Intacct', 'application'],
    [AGAVE, 'agave-erp-sync', 'Agave ERP Sync', 'connector'],
  ] as const) {
    run(
      `INSERT INTO products (id, slug, name, product_role, created_at, updated_at)
         VALUES (?,?,?,?,?,?)`,
      id,
      slug,
      name,
      role,
      NOW,
      NOW,
    );
  }

  run(
    `INSERT INTO integrations
       (id, name, source_product_id, target_product_id, mechanism_kind, direction,
        maintained_by, created_at, updated_at)
     VALUES (?, 'Procore ↔ Sage', ?, ?, 'native', 'bidirectional', 'aeci', ?, ?)`,
    EDGE,
    PROCORE,
    SAGE,
    NOW,
    NOW,
  );
  run(
    `INSERT INTO connector_evidenced_pairs
       (id, connector_product_id, product_a_id, product_b_id, name, built_by_vendor_id,
        direction, listing_url, maintained_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Agave: Procore ↔ Sage', 'v-agave', 'both',
             'https://useagave.com/x', 'aeci', ?, ?)`,
    EVIDENCED,
    AGAVE,
    PROCORE < SAGE ? PROCORE : SAGE,
    PROCORE < SAGE ? SAGE : PROCORE,
    NOW,
    NOW,
  );

  // The reachable tier: a catalogue, two stubs and the pair the third anchor targets.
  run(
    `INSERT INTO connector_catalogs (id, connector_product_id, managed_by, created_at, updated_at)
       VALUES ('recCAT000000001', ?, 'review', ?, ?)`,
    AGAVE,
    NOW,
    NOW,
  );
  for (const [id, slug] of [
    ['recSTUB00000001', 'procore'],
    ['recSTUB00000002', 'sage-intacct'],
  ] as const) {
    run(
      `INSERT INTO connector_stubs (id, catalog_id, slug, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (?, 'recCAT000000001', ?, ?, ?, ?, ?)`,
      id,
      slug,
      NOW,
      NOW,
      NOW,
      NOW,
    );
  }
  run(
    `INSERT INTO connector_pairs
       (id, catalog_id, stub_a_id, stub_b_id, surface, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES (?, 'recCAT000000001', 'recSTUB00000001', 'recSTUB00000002', 'derived', ?, ?, ?, ?)`,
    REACHED,
    NOW,
    NOW,
    NOW,
    NOW,
  );

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

  // Two claims on each pre-existing anchor, one attestation each — so a cascade
  // that fires anywhere shows up as a missing row, not a subtle count difference.
  for (const [claimId, column, anchor, dataObjectId] of [
    ['c-edge-rfis', 'integration_id', EDGE, 'd-rfis'],
    ['c-edge-budgets', 'integration_id', EDGE, 'd-budgets'],
    ['c-evi-rfis', 'connector_evidenced_pair_id', EVIDENCED, 'd-rfis'],
    ['c-evi-budgets', 'connector_evidenced_pair_id', EVIDENCED, 'd-budgets'],
  ] as const) {
    run(
      `INSERT INTO claims (id, ${column}, data_object_id, direction, origin, created_at, updated_at)
         VALUES (?,?,?,'a_to_b','aeci',?,?)`,
      claimId,
      anchor,
      dataObjectId,
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

/** Insert a claim on exactly one of the three anchors. Returns the thrower. */
const insertClaim = (
  t: TestDb,
  id: string,
  cols: Partial<
    Record<'integration_id' | 'connector_evidenced_pair_id' | 'connector_pair_id', string>
  >,
  dataObjectId = 'd-rfis',
  direction = 'both',
) => {
  const names = Object.keys(cols);
  const list = [
    'id',
    ...names,
    'data_object_id',
    'direction',
    'origin',
    'created_at',
    'updated_at',
  ];
  const placeholders = list.map(() => '?').join(',');
  return () =>
    t.raw
      .prepare(`INSERT INTO claims (${list.join(',')}) VALUES (${placeholders})`)
      .run(
        id,
        ...names.map((n) => cols[n as keyof typeof cols]!),
        dataObjectId,
        direction,
        'aeci',
        NOW,
        NOW,
      );
};

describe(`${MIGRATION} — against seeded data`, () => {
  it('destroys no claim and no attestation (the cascade into attestations)', async () => {
    const t = await seedPreMigration();
    const before = one(
      t,
      `SELECT (SELECT COUNT(*) FROM claims) c, (SELECT COUNT(*) FROM attestations) a`,
    );
    expect(before).toEqual({ c: 4, a: 4 });

    t.applyMigration(MIGRATION);

    // Conserved in BOTH directions — none destroyed, none duplicated by the
    // carry-and-restore. In the generated order `a` is 0 here and `c` is still 4.
    const after = one(
      t,
      `SELECT (SELECT COUNT(*) FROM claims) c, (SELECT COUNT(*) FROM attestations) a`,
    );
    expect(after).toEqual({ c: 4, a: 4 });
    t.dispose();
  });

  it('preserves every claim id, its anchor_id, and the attestation that resolves to it', async () => {
    const t = await seedPreMigration();
    const before = rows(t, `SELECT id, anchor_id FROM claims ORDER BY id`);

    t.applyMigration(MIGRATION);

    // `anchor_id` is recomputed by the new three-way coalesce, not copied — the
    // carry table's column is never selected. Identical values are what keep
    // `claims_identity_key`, every `audit_log` row and every attestation resolving.
    expect(rows(t, `SELECT id, anchor_id FROM claims ORDER BY id`)).toEqual(before);
    expect(before.map((r) => r.anchor_id)).toEqual([EDGE, EDGE, EVIDENCED, EVIDENCED]);

    const joined = rows(
      t,
      `SELECT c.id cid, a.id aid FROM claims c JOIN attestations a ON a.claim_id = c.id ORDER BY c.id`,
    );
    expect(joined.map((r) => r.cid)).toEqual([
      'c-edge-budgets',
      'c-edge-rfis',
      'c-evi-budgets',
      'c-evi-rfis',
    ]);
    expect(joined.map((r) => r.aid)).toEqual([
      'at-c-edge-budgets',
      'at-c-edge-rfis',
      'at-c-evi-budgets',
      'at-c-evi-rfis',
    ]);
    t.dispose();
  });

  it('leaves every restored claim on its original anchor, with the new arm NULL', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    // This migration MOVES no claim. It only makes the third arm available.
    const all = rows(
      t,
      `SELECT id, integration_id, connector_evidenced_pair_id, connector_pair_id
         FROM claims ORDER BY id`,
    );
    expect(all.every((r) => r.connector_pair_id === null)).toBe(true);
    expect(all.filter((r) => r.integration_id === EDGE)).toHaveLength(2);
    expect(all.filter((r) => r.connector_evidenced_pair_id === EVIDENCED)).toHaveLength(2);
    t.dispose();
  });

  it('rejects a claim on `connector_pairs` BEFORE the migration, and accepts it after', async () => {
    const t = await seedPreMigration();
    // No such column yet — this is the capability the migration adds.
    expect(insertClaim(t, 'c-reach', { connector_pair_id: REACHED })).toThrow();

    t.applyMigration(MIGRATION);

    insertClaim(t, 'c-reach', { connector_pair_id: REACHED })();
    expect(one(t, `SELECT connector_pair_id p FROM claims WHERE id = 'c-reach'`).p).toBe(REACHED);
    t.dispose();
  });

  it('accepts each of the three anchors, one at a time', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    // Distinct data objects and directions so `claims_identity_key` is not what is
    // being tested here — only the CHECK.
    insertClaim(t, 'c-arm-a', { integration_id: EDGE }, 'd-rfis', 'both')();
    insertClaim(t, 'c-arm-b', { connector_evidenced_pair_id: EVIDENCED }, 'd-rfis', 'both')();
    insertClaim(t, 'c-arm-c', { connector_pair_id: REACHED }, 'd-rfis', 'both')();

    expect(
      rows(t, `SELECT id FROM claims WHERE id LIKE 'c-arm-%' ORDER BY id`).map((r) => r.id),
    ).toEqual(['c-arm-a', 'c-arm-b', 'c-arm-c']);
    t.dispose();
  });

  it('rejects zero anchors, and rejects any TWO — which is why the CHECK is a sum', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    // Zero anchors: the case a plain nullable column would have allowed.
    expect(insertClaim(t, 'c-none', {})).toThrow();

    // Each of the three pairs, and all three at once. The all-three case is the
    // reason `<>` was abandoned: SQLite parses `a <> b <> c` as `(a <> b) <> c`,
    // which is TRUE when every arm is set, so a naive three-arm `<>` would have
    // ACCEPTED the most broken row of the set.
    expect(
      insertClaim(t, 'c-ab', { integration_id: EDGE, connector_evidenced_pair_id: EVIDENCED }),
    ).toThrow();
    expect(insertClaim(t, 'c-ac', { integration_id: EDGE, connector_pair_id: REACHED })).toThrow();
    expect(
      insertClaim(t, 'c-bc', {
        connector_evidenced_pair_id: EVIDENCED,
        connector_pair_id: REACHED,
      }),
    ).toThrow();
    expect(
      insertClaim(t, 'c-abc', {
        integration_id: EDGE,
        connector_evidenced_pair_id: EVIDENCED,
        connector_pair_id: REACHED,
      }),
    ).toThrow();

    // The parse itself, asserted directly rather than described: three TRUEs chained
    // with `<>` evaluate to 1, i.e. "constraint satisfied".
    expect(one(t, `SELECT ((1 <> 1) <> 1) AS v`).v).toBe(1);
    // The shipped form on the same input evaluates to 0, i.e. "constraint violated".
    expect(one(t, `SELECT ((1 + 1 + 1) = 1) AS v`).v).toBe(0);
    t.dispose();
  });

  it('resolves anchor_id to the connector-pair id, and the identity key bites on it', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    insertClaim(t, 'c-reach', { connector_pair_id: REACHED }, 'd-rfis', 'both')();
    // The third arm participates in the coalesce, so a reach-anchored claim has a
    // real identity value rather than a NULL one.
    expect(one(t, `SELECT anchor_id a FROM claims WHERE id = 'c-reach'`).a).toBe(REACHED);

    // And therefore the unique index sees the duplicate. With a plain nullable FK in
    // the index instead of the STORED generated column, SQLite's NULLs-are-distinct
    // rule would have waved this through.
    expect(
      insertClaim(t, 'c-reach-dupe', { connector_pair_id: REACHED }, 'd-rfis', 'both'),
    ).toThrow();

    // A different data object on the same anchor is a different claim, not a dupe.
    insertClaim(t, 'c-reach-2', { connector_pair_id: REACHED }, 'd-budgets', 'both')();
    expect(one(t, `SELECT COUNT(*) n FROM claims WHERE connector_pair_id = '${REACHED}'`).n).toBe(
      2,
    );
    t.dispose();
  });

  it('cascades from the connector pair to its claims and their attestations', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);
    t.raw.pragma('foreign_keys = ON');

    insertClaim(t, 'c-reach', { connector_pair_id: REACHED }, 'd-rfis', 'both')();
    t.raw
      .prepare(
        `INSERT INTO attestations (id, claim_id, source, asserted, created_at, updated_at)
           VALUES ('at-c-reach','c-reach','aeci',1,?,?)`,
      )
      .run(NOW, NOW);

    // The cascade is what keeps `claims_anchor_check` a DB CHECK rather than an
    // application rule: no anchor is ever nulled out from under a live row, so the
    // constraint can never fail an unrelated delete.
    t.raw.prepare(`DELETE FROM connector_pairs WHERE id = ?`).run(REACHED);
    expect(
      one(t, `SELECT (SELECT COUNT(*) FROM claims) c, (SELECT COUNT(*) FROM attestations) a`),
    ).toEqual({ c: 4, a: 4 });
    t.dispose();
  });
});
