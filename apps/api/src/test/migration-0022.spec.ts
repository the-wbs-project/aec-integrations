import { describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from './d1';

/**
 * AECI-721 PR-B — `0022_powerful_killraven.sql` against NON-EMPTY data.
 *
 * `docs/migrations.md` §3.3a rule 3: "Verify against non-empty data, not just a
 * fresh DB. A recreate that applies cleanly to an empty table proves nothing."
 * Every case here seeds the PRE-migration shape (the harness stops before 0022),
 * then applies the one migration and asserts what survived.
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────
 * The migration recreates two tables that sit at the top of a two-level cascade:
 * `integrations` → `claims` (ON DELETE CASCADE) → `attestations` (ON DELETE
 * CASCADE). drizzle-kit's recreate is `CREATE __new_X` → copy → `DROP TABLE X` →
 * rename, and in SQLite `DROP TABLE` performs an implicit DELETE that FIRES
 * foreign-key actions — `PRAGMA defer_foreign_keys` defers violation *reporting*,
 * not cascade *actions*. Applied in the generated order, this migration would
 * silently destroy every claim and every attestation in the database: 1,697 of
 * each in production, including vendor-supplied evidence that cannot be
 * reconstructed from anything.
 *
 * The hand-assembled order (carry tables, children emptied deepest-first, parent
 * dropped only once childless) is what prevents that, and the first case below is
 * what fails if someone reorders the file or regenerates it.
 */

const MIGRATION = '0022_powerful_killraven.sql';

const AGAVE = 'p-agave';
const PROCORE = 'p-procore';
const SAGE = 'p-sage';
const AQUIFER = 'p-aquifer';
const ADP = 'p-adp';

/** The four edge shapes that behave differently under the routing predicate. */
const MOVES = 'i-moves'; // powered by a third product → migrates
const MOVES_REV = 'i-moves-rev'; // ditto, seeded the other way round
const SELF_REF = 'i-selfref'; // Convention A: powered_by IS an endpoint → stays
const UNPOWERED = 'i-ipaas-null'; // iPaaS with no FK (Zapier-shaped) → stays
const DIRECT = 'i-direct'; // ordinary native edge → stays

async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const now = '2026-08-01T00:00:00.000Z';
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);

  run(
    `INSERT INTO vendors (id, slug, company_name, created_at, updated_at)
       VALUES ('v-agave','agave','Agave',?,?)`,
    now,
    now,
  );
  for (const [id, slug, name, role] of [
    [AGAVE, 'agave-erp-sync', 'Agave ERP Sync', 'connector'],
    [PROCORE, 'procore', 'Procore', 'application'],
    [SAGE, 'sage-intacct', 'Sage Intacct', 'application'],
    [AQUIFER, 'aquifer', 'Aquifer', 'connector'],
    [ADP, 'adp', 'ADP Workforce Now', 'application'],
  ] as const) {
    run(
      `INSERT INTO products (id, slug, name, product_role, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      id,
      slug,
      name,
      role,
      now,
      now,
    );
  }

  const edge = (
    id: string,
    src: string,
    tgt: string,
    kind: string | null,
    poweredBy: string | null,
    direction: string | null,
  ) =>
    run(
      `INSERT INTO integrations
         (id, name, source_product_id, target_product_id, mechanism_kind, mechanism_name,
          direction, built_by_vendor_id, powered_by_product_id, listing_url, maintained_by,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      `edge ${id}`,
      src,
      tgt,
      kind,
      'Agave ERP Sync',
      direction,
      poweredBy ? 'v-agave' : null,
      poweredBy,
      'https://useagave.com/x',
      'aeci',
      now,
      now,
    );

  // TWO moving edges, seeded in opposite orientations, so BOTH branches of the
  // direction CASE run. `p-procore` < `p-sage` lexically, so MOVES has its source in
  // canonical slot A (→ `a_to_b`) and MOVES_REV has its source in slot B (→ `b_to_a`).
  // One edge could only ever have proved half the mapping.
  edge(MOVES, PROCORE, SAGE, 'marketplace-app', AGAVE, 'one-way');
  edge(MOVES_REV, SAGE, ADP, 'marketplace-app', AGAVE, 'one-way');
  edge(SELF_REF, ADP, AQUIFER, 'iPaaS', AQUIFER, 'bidirectional');
  edge(UNPOWERED, PROCORE, ADP, 'iPaaS', null, null);
  edge(DIRECT, SAGE, ADP, 'native', null, 'bidirectional');

  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, created_at, updated_at)
       VALUES ('d-rfis','rfis','RFIs',?,?)`,
    now,
    now,
  );
  run(
    `INSERT INTO taxonomy_data_objects (id, slug, name, created_at, updated_at)
       VALUES ('d-budgets','budgets','Budgets',?,?)`,
    now,
    now,
  );

  // One claim + one attestation on each edge, so a cascade that fires anywhere is
  // visible as a missing row rather than as a subtle count difference.
  for (const [claimId, integrationId, dataObjectId] of [
    ['c-moves', MOVES, 'd-rfis'],
    ['c-moves-2', MOVES, 'd-budgets'],
    ['c-moves-rev', MOVES_REV, 'd-rfis'],
    ['c-selfref', SELF_REF, 'd-rfis'],
    ['c-unpowered', UNPOWERED, 'd-rfis'],
    ['c-direct', DIRECT, 'd-rfis'],
  ] as const) {
    run(
      `INSERT INTO claims (id, integration_id, data_object_id, direction, origin, created_at, updated_at)
       VALUES (?,?,?,'a_to_b','aeci',?,?)`,
      claimId,
      integrationId,
      dataObjectId,
      now,
      now,
    );
    run(
      `INSERT INTO attestations (id, claim_id, source, asserted, created_at, updated_at)
       VALUES (?,?, 'aeci', 1, ?, ?)`,
      `at-${claimId}`,
      claimId,
      now,
      now,
    );
  }
  return t;
}

const rows = (t: TestDb, sql: string): Record<string, unknown>[] =>
  t.raw.prepare(sql).all() as Record<string, unknown>[];
const one = (t: TestDb, sql: string) => rows(t, sql)[0]!;

describe(`${MIGRATION} — against seeded data`, () => {
  it('destroys no claim and no attestation (the two-level cascade)', async () => {
    const t = await seedPreMigration();
    const before = one(
      t,
      `SELECT
      (SELECT COUNT(*) FROM claims) c, (SELECT COUNT(*) FROM attestations) a,
      (SELECT COUNT(*) FROM integrations) i`,
    );
    expect(before).toEqual({ c: 6, a: 6, i: 5 });

    t.applyMigration(MIGRATION);

    const after = one(
      t,
      `SELECT
      (SELECT COUNT(*) FROM claims) c, (SELECT COUNT(*) FROM attestations) a,
      (SELECT COUNT(*) FROM integrations) i,
      (SELECT COUNT(*) FROM connector_evidenced_pairs) e`,
    );
    // Claims and attestations are CONSERVED — none created, none destroyed. The
    // edge count falls by exactly the one that moved, and the delivered total
    // (integrations + evidenced) is unchanged at 4, which is the count-neutrality
    // the whole two-PR split exists to guarantee.
    expect(after).toEqual({ c: 6, a: 6, i: 3, e: 2 });
    t.dispose();
  });

  it('preserves each claim id, and its attestation still resolves', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    const ids = rows(
      t,
      `SELECT c.id AS cid, a.id AS aid FROM claims c
                           JOIN attestations a ON a.claim_id = c.id ORDER BY c.id`,
    );
    expect(ids.map((r) => r.cid)).toEqual([
      'c-direct',
      'c-moves',
      'c-moves-2',
      'c-moves-rev',
      'c-selfref',
      'c-unpowered',
    ]);
    expect(ids.map((r) => r.aid)).toEqual([
      'at-c-direct',
      'at-c-moves',
      'at-c-moves-2',
      'at-c-moves-rev',
      'at-c-selfref',
      'at-c-unpowered',
    ]);
    t.dispose();
  });

  it('re-homes the moved claims and leaves anchor_id unchanged', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    const moved = rows(
      t,
      `SELECT id, integration_id, connector_evidenced_pair_id, anchor_id
         FROM claims WHERE id LIKE 'c-moves%' ORDER BY id`,
    );
    expect(moved).toHaveLength(3);
    for (const row of moved) {
      const expected = row.id === 'c-moves-rev' ? MOVES_REV : MOVES;
      expect(row.integration_id).toBeNull();
      expect(row.connector_evidenced_pair_id).toBe(expected);
      // The id-preservation trick: the evidenced pair took the edge's id verbatim,
      // so the claim's IDENTITY column never changed value — only which column
      // holds it. `claims_identity_key` sees no change at all.
      expect(row.anchor_id).toBe(expected);
    }

    // Everything else stays anchored on `integrations`, still with a live FK.
    const stayed = rows(
      t,
      `SELECT id, integration_id, connector_evidenced_pair_id, anchor_id
         FROM claims WHERE id NOT LIKE 'c-moves%' ORDER BY id`,
    );
    expect(stayed).toHaveLength(3);
    for (const row of stayed) {
      expect(row.connector_evidenced_pair_id).toBeNull();
      expect(row.anchor_id).toBe(row.integration_id);
    }
    t.dispose();
  });

  it('moves ONLY the non-self-referential powered edge', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    expect(rows(t, `SELECT id FROM integrations ORDER BY id`).map((r) => r.id)).toEqual(
      [DIRECT, UNPOWERED, SELF_REF].sort(),
    );
    // Convention A stays: `powered_by` equal to an endpoint is deliberate, and the
    // destination's distinct-connector CHECK would refuse it anyway.
    expect(
      one(t, `SELECT powered_by_product_id p FROM integrations WHERE id = '${SELF_REF}'`).p,
    ).toBe(AQUIFER);
    // The Zapier-shaped edge keeps `iPaaS` — the value is NOT dropped from the CHECK.
    expect(one(t, `SELECT mechanism_kind k FROM integrations WHERE id = '${UNPOWERED}'`).k).toBe(
      'iPaaS',
    );
    t.dispose();
  });

  it('canonicalises the pair and re-encodes direction losslessly, both ways', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    const pair = one(t, `SELECT * FROM connector_evidenced_pairs WHERE id = '${MOVES}'`);
    expect(pair.connector_product_id).toBe(AGAVE);
    // MIN/MAX, so `product_a_id < product_b_id` (the CHECK) regardless of which
    // endpoint was the source.
    expect(pair.product_a_id).toBe(PROCORE < SAGE ? PROCORE : SAGE);
    expect(pair.product_b_id).toBe(PROCORE < SAGE ? SAGE : PROCORE);
    // Seeded `one-way` PROCORE → SAGE, and `p-procore` < `p-sage`, so the source
    // landed in slot A.
    expect(pair.direction).toBe('a_to_b');

    // The mirror: seeded `one-way` SAGE → ADP, and `p-adp` < `p-sage`, so the source
    // is slot B. `b_to_a` is precisely the information canonicalisation would
    // otherwise discard — a straight copy of `one-way` could not express it.
    const rev = one(t, `SELECT * FROM connector_evidenced_pairs WHERE id = '${MOVES_REV}'`);
    expect(rev.product_a_id).toBe(ADP);
    expect(rev.product_b_id).toBe(SAGE);
    expect(rev.direction).toBe('b_to_a');

    // And `bidirectional` → `both`, which is orientation-free. Asserted on the
    // self-referential edge's shape via a direct insert rather than the migration,
    // since that edge deliberately does not move.
    expect(one(t, `SELECT direction d FROM integrations WHERE id = '${SELF_REF}'`).d).toBe(
      'bidirectional',
    );
    // Evidence and accountability ride along: the listing URL and the builder are
    // what make this the DELIVERED tier rather than a derived one.
    expect(pair.listing_url).toBe('https://useagave.com/x');
    expect(pair.built_by_vendor_id).toBe('v-agave');
    expect(pair.maintained_by).toBe('aeci');
    t.dispose();
  });

  it('accepts `integrator` after the migration, and still refuses a bad kind', async () => {
    const t = await seedPreMigration();
    // The value AECI-712 verified the old CHECK refuses — the reason this migration
    // is on the critical path for AECI-698's upstream re-key.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO integrations (id, source_product_id, target_product_id, mechanism_kind,
           maintained_by, created_at, updated_at)
         VALUES ('i-x', ?, ?, 'integrator', 'aeci', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
        )
        .run(PROCORE, SAGE),
    ).toThrow();

    t.applyMigration(MIGRATION);

    t.raw
      .prepare(
        `INSERT INTO integrations (id, source_product_id, target_product_id, mechanism_kind,
         maintained_by, created_at, updated_at)
       VALUES ('i-x', ?, ?, 'integrator', 'aeci', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      )
      .run(PROCORE, SAGE);
    expect(one(t, `SELECT mechanism_kind k FROM integrations WHERE id = 'i-x'`).k).toBe(
      'integrator',
    );

    // The CHECK is widened, not removed.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO integrations (id, source_product_id, target_product_id, mechanism_kind,
           maintained_by, created_at, updated_at)
         VALUES ('i-y', ?, ?, 'not-a-kind', 'aeci', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
        )
        .run(PROCORE, SAGE),
    ).toThrow();
    t.dispose();
  });

  it('enforces exactly-one-anchor, and keeps the identity key working across both', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);
    const stamp = '2026-08-01T00:00:00.000Z';

    // Both anchors set.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO claims (id, integration_id, connector_evidenced_pair_id, data_object_id,
           direction, origin, created_at, updated_at)
         VALUES ('c-bad', ?, ?, 'd-rfis', 'both', 'aeci', ?, ?)`,
        )
        .run(DIRECT, MOVES, stamp, stamp),
    ).toThrow();

    // Neither anchor set — the case a plain nullable column would have allowed.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO claims (id, data_object_id, direction, origin, created_at, updated_at)
         VALUES ('c-bad2', 'd-rfis', 'both', 'aeci', ?, ?)`,
        )
        .run(stamp, stamp),
    ).toThrow();

    // The identity key still bites on an evidenced-anchored duplicate. This is what
    // the STORED generated column buys: with a plain nullable `integration_id` in the
    // index, SQLite's NULLs-are-distinct rule would have let this through.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO claims (id, connector_evidenced_pair_id, data_object_id, direction,
           origin, created_at, updated_at)
         VALUES ('c-dupe', ?, 'd-rfis', 'a_to_b', 'aeci', ?, ?)`,
        )
        .run(MOVES, stamp, stamp),
    ).toThrow();
    t.dispose();
  });

  it('cascades from the evidenced pair to its re-homed claims and attestations', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);
    t.raw.pragma('foreign_keys = ON');

    // The cascade must survive the re-home: deleting the pair takes its claims and
    // their attestations, exactly as deleting the integration used to.
    t.raw.prepare(`DELETE FROM connector_evidenced_pairs WHERE id = ?`).run(MOVES);
    const after = one(
      t,
      `SELECT
      (SELECT COUNT(*) FROM claims) c, (SELECT COUNT(*) FROM attestations) a`,
    );
    expect(after).toEqual({ c: 4, a: 4 });
    t.dispose();
  });
});
