import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-991 — `0041_shocking_maggott.sql` against NON-EMPTY data.
 *
 * `docs/migrations.md` §3.3a rule 3: a recreate that applies cleanly to an empty
 * table proves nothing. Each case below seeds the PRE-migration shape (the harness
 * stops before 0041), applies the one migration, and asserts what survived.
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ────────────────────────────────────
 *
 * Two things, and the first is not the usual one. `integration_endpoint_moves` has
 * no cascade children, so the DROP here is safe in a way 0027's and 0033's were not.
 * What is easy to lose is the **carry**: the ids have to become slugs, re-sorted,
 * because id order and slug order are unrelated and the new CHECK is on the slugs.
 * A regenerated file is a bare DROP + CREATE that applies perfectly cleanly and
 * leaves the table empty — no error, no rollback, every redirect silently gone.
 * That is the same failure shape as 0039's seeded rows.
 *
 * The second is the point of the whole change: after this migration, deleting a
 * product must NOT delete the move rows that name it.
 */
const MIGRATION = '0041_shocking_maggott.sql';

const NOW = '2026-09-16T00:00:00.000Z';

const ACC = 'p-acc'; // autodesk-construction-cloud — the endpoint that retires
const FORMA = 'p-forma'; // autodesk-forma — where its edges went
const POWERBI = 'p-powerbi'; // power-bi — the partner that did not move
const EDGE = 'i-acc-powerbi';

const rows = (t: TestDb, sql: string): Record<string, unknown>[] =>
  t.raw.prepare(sql).all() as Record<string, unknown>[];

/**
 * The pre-0041 world: three products and one id-keyed move row saying the edge left
 * the (ACC, Power BI) pair.
 *
 * Note the id order is the REVERSE of the slug order here, deliberately —
 * `p-acc` < `p-forma` < `p-powerbi` by id, while `autodesk-construction-cloud` <
 * `power-bi` by slug is a different comparison. A column-for-column copy would be
 * indistinguishable from a correct one on a fixture where the two agree.
 */
async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);

  for (const [id, slug, name] of [
    [ACC, 'autodesk-construction-cloud', 'Autodesk Construction Cloud'],
    [FORMA, 'autodesk-forma', 'Autodesk Forma'],
    [POWERBI, 'power-bi', 'Power BI'],
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
  run(
    `INSERT INTO integrations
       (id, name, source_product_id, target_product_id, mechanism_kind, direction,
        maintained_by, created_at, updated_at)
     VALUES (?, 'Forma ↔ Power BI', ?, ?, 'native', 'both', 'aeci', ?, ?)`,
    EDGE,
    FORMA,
    POWERBI,
    NOW,
    NOW,
  );
  // The move row as 0038 stored it: two product IDS in canonical id order.
  const [idA, idB] = [ACC, POWERBI].sort();
  run(
    `INSERT INTO integration_endpoint_moves
       (integration_id, from_product_a_id, from_product_b_id, moved_at)
     VALUES (?,?,?,?)`,
    EDGE,
    idA,
    idB,
    NOW,
  );
  return t;
}

describe(`${MIGRATION} — slug-keyed endpoint moves`, () => {
  it('carries every row across, translated to slugs in canonical SLUG order', async () => {
    const t = await seedPreMigration();
    try {
      t.applyMigration(MIGRATION);
      expect(rows(t, 'SELECT * FROM integration_endpoint_moves')).toEqual([
        {
          integration_id: EDGE,
          from_product_a_slug: 'autodesk-construction-cloud',
          from_product_b_slug: 'power-bi',
          moved_at: NOW,
        },
      ]);
    } finally {
      t.dispose();
    }
  });

  it('still carries its INSERT…SELECT in the committed file', async () => {
    // Asserted on the FILE, not only on the applied result, so the failure names the
    // cause. A regenerated file loses the carry silently — it applies clean and empty.
    const statements = statementsForMigration(MIGRATION);
    const carry = statements.filter((s) =>
      /INSERT OR IGNORE INTO `__new_integration_endpoint_moves`/.test(s),
    );
    expect(carry).toHaveLength(1);
    expect(carry[0]).toMatch(/JOIN `products`/);
  });

  it('keeps the move row when the endpoint product is retracted — the whole point', async () => {
    const t = await seedPreMigration();
    try {
      // BEFORE: the FK cascade deletes the redirect along with the product. This is
      // the defect, reproduced, so the assertion below is a real difference.
      t.raw.pragma('foreign_keys = ON');
      t.raw.prepare('DELETE FROM products WHERE id = ?').run(ACC);
      expect(rows(t, 'SELECT * FROM integration_endpoint_moves')).toEqual([]);
    } finally {
      t.dispose();
    }

    const after = await seedPreMigration();
    try {
      after.applyMigration(MIGRATION);
      after.raw.pragma('foreign_keys = ON');
      after.raw.prepare('DELETE FROM products WHERE id = ?').run(ACC);
      // AFTER: the row names slugs, nothing owns it, and the redirect survives.
      expect(rows(after, 'SELECT from_product_a_slug FROM integration_endpoint_moves')).toEqual([
        { from_product_a_slug: 'autodesk-construction-cloud' },
      ]);
    } finally {
      after.dispose();
    }
  });

  it('leaves no foreign key on the recreated table', async () => {
    const t = await seedPreMigration();
    try {
      t.applyMigration(MIGRATION);
      expect(
        rows(t, `SELECT * FROM pragma_foreign_key_list('integration_endpoint_moves')`),
      ).toEqual([]);
      // And the lookup index came back — it is dropped with the old table.
      expect(
        rows(
          t,
          `SELECT name FROM sqlite_master WHERE type='index'
             AND name='integration_endpoint_moves_from_idx'`,
        ),
      ).toHaveLength(1);
    } finally {
      t.dispose();
    }
  });
});
