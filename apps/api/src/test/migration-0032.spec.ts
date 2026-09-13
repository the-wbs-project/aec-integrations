import { CONNECTOR_PAIR_SURFACES } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-906 — `0032_mute_gateway.sql` widens the `connector_pairs.surface` CHECK with
 * a fourth value, `derived`.
 *
 * ── WHY THIS FILE IS SMALL, AND `migration-0027.spec.ts` IS NOT ────────────────
 * Both migrations are destructive table recreates, because SQLite has no
 * `ALTER … ALTER CONSTRAINT` and drizzle-kit answers a CHECK change with
 * `CREATE __new_X` → copy → `DROP TABLE X` → rename. In SQLite `DROP TABLE` performs
 * an implicit DELETE that FIRES foreign-key actions, and `PRAGMA defer_foreign_keys`
 * defers violation *reporting*, not cascade *actions* — which is how 0027 would have
 * destroyed 1,697 claims in generated order.
 *
 * That hazard needs a CHILD holding a cascading FK to the recreated table. **Nothing
 * references `connector_pairs`**: its three FKs all point outward, and dropping a
 * child fires nothing on its parents. So 0032 is safe in GENERATED order and needs no
 * hand-assembled statement sequence. The containment is the absence of children, and
 * the last case below is what notices if that ever stops being true.
 *
 * `docs/migrations.md` §3.3a rule 3 still applies: a recreate that applies cleanly to
 * an empty table proves nothing. Every case seeds the pre-migration shape (the harness
 * stops before 0032), applies the one migration, and asserts what survived.
 */

const MIGRATION = '0032_mute_gateway.sql';

const CATALOG = 'cat-agave';
const CONNECTOR = 'p-agave';

/** The three surfaces that existed BEFORE this migration — all that 0031 accepts. */
const PRE_SURFACES = ['curated', 'generated', 'unknown'] as const;

async function seedPreMigration(): Promise<TestDb> {
  const t = await makeTestDb({ upToExclusive: MIGRATION });
  const now = '2026-09-01T00:00:00.000Z';
  const run = (sql: string, ...args: unknown[]) => t.raw.prepare(sql).run(...args);

  run(
    `INSERT INTO products (id, slug, name, product_role, created_at, updated_at)
       VALUES (?,'agave-erp-sync','Agave ERP Sync','connector',?,?)`,
    CONNECTOR,
    now,
    now,
  );
  run(
    `INSERT INTO connector_catalogs (id, connector_product_id, created_at, updated_at)
       VALUES (?,?,?,?)`,
    CATALOG,
    CONNECTOR,
    now,
    now,
  );
  // Canonical ordering is a CHECK, so these slugs are chosen to sort the way the ids
  // below pair them: s-a < s-b < s-c < s-d.
  for (const id of ['s-a', 's-b', 's-c', 's-d']) {
    run(
      `INSERT INTO connector_stubs
         (id, catalog_id, slug, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)`,
      id,
      CATALOG,
      id,
      now,
      now,
      now,
      now,
    );
  }

  // One pair per pre-existing surface, each carrying a distinguishable URL, so a copy
  // that silently dropped or reordered a column shows up as a wrong value rather than
  // as a right-looking count.
  PRE_SURFACES.forEach((surface, i) => {
    run(
      `INSERT INTO connector_pairs
         (id, catalog_id, stub_a_id, stub_b_id, url_a_to_b, url_b_to_a, surface,
          classified_at, first_seen_at, last_seen_at, removed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `pr-${surface}`,
      CATALOG,
      's-a',
      ['s-b', 's-c', 's-d'][i]!,
      `https://useagave.com/${surface}/a-to-b`,
      `https://useagave.com/${surface}/b-to-a`,
      surface,
      `2026-08-0${i + 1}T00:00:00.000Z`,
      now,
      now,
      null,
      now,
      now,
    );
  });
  return t;
}

const rows = (t: TestDb, sql: string, ...args: unknown[]): Record<string, unknown>[] =>
  t.raw.prepare(sql).all(...args) as Record<string, unknown>[];

describe(`${MIGRATION} — against seeded data`, () => {
  it('rejects `derived` BEFORE the migration — the defect this closes', async () => {
    const t = await seedPreMigration();

    // Not a hypothetical: the review app already writes 669 rows carrying this value,
    // and the connector promote arm commits a whole page in one `db.batch`. ONE row
    // failing the CHECK rolls the entire page back, so the sync is a silent no-op
    // rather than a partial write.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO connector_pairs
             (id, catalog_id, stub_a_id, stub_b_id, surface,
              first_seen_at, last_seen_at, created_at, updated_at)
           VALUES ('pr-new',?, 's-b','s-c','derived','x','x','x','x')`,
        )
        .run(CATALOG),
    ).toThrow(/CHECK constraint/i);

    t.dispose();
  });

  it('copies every row and every column through the recreate', async () => {
    const t = await seedPreMigration();
    const before = rows(t, 'SELECT * FROM connector_pairs ORDER BY id');
    expect(before.length).toBe(3);

    t.applyMigration(MIGRATION);

    // Deep equality across all 13 columns, not a count: the copy is an explicit
    // column list, and a column dropped from it would still leave three rows.
    expect(rows(t, 'SELECT * FROM connector_pairs ORDER BY id')).toEqual(before);
    t.dispose();
  });

  it('accepts `derived` after the migration, and still rejects a junk surface', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    const insert = (id: string, stubB: string, surface: string) =>
      t.raw
        .prepare(
          `INSERT INTO connector_pairs
             (id, catalog_id, stub_a_id, stub_b_id, surface,
              first_seen_at, last_seen_at, created_at, updated_at)
           VALUES (?,?, 's-b', ?, ?, 'x','x','x','x')`,
        )
        .run(id, CATALOG, stubB, surface);

    insert('pr-derived', 's-c', 'derived');
    expect(rows(t, `SELECT surface FROM connector_pairs WHERE id = 'pr-derived'`)[0]?.surface).toBe(
      'derived',
    );

    // The half that matters as much: widening is not opening. `reachable` is the
    // plausible-looking near-miss — it is what `derived` MEANS, and it is not a
    // member of the vocabulary.
    for (const junk of ['reachable', 'DERIVED', 'inferred', '']) {
      expect(() => insert(`pr-junk-${junk}`, 's-d', junk)).toThrow(/CHECK constraint/i);
    }
    t.dispose();
  });

  it('keeps the D1 CHECK in lockstep with `CONNECTOR_PAIR_SURFACES`', async () => {
    const t = await makeTestDb();

    // Behavioural, not textual: every member of the shared list must actually insert.
    // The two spellings drift silently otherwise — the TypeScript enum widens, the
    // Zod parse passes, and the row dies at the database with a constraint error the
    // promote path reports as a failed page.
    CONNECTOR_PAIR_SURFACES.forEach((surface, i) => {
      t.raw
        .prepare(
          `INSERT INTO products (id, slug, name, product_role, created_at, updated_at)
             VALUES (?,?,?, 'connector', 'x','x')`,
        )
        .run(`p-${i}`, `conn-${i}`, `Connector ${i}`);
      t.raw
        .prepare(
          `INSERT INTO connector_catalogs (id, connector_product_id, created_at, updated_at)
             VALUES (?,?, 'x','x')`,
        )
        .run(`c-${i}`, `p-${i}`);
      for (const stub of ['s-a', 's-b']) {
        t.raw
          .prepare(
            `INSERT INTO connector_stubs
               (id, catalog_id, slug, first_seen_at, last_seen_at, created_at, updated_at)
             VALUES (?,?,?, 'x','x','x','x')`,
          )
          .run(`${stub}-${i}`, `c-${i}`, stub);
      }
      t.raw
        .prepare(
          `INSERT INTO connector_pairs
             (id, catalog_id, stub_a_id, stub_b_id, surface,
              first_seen_at, last_seen_at, created_at, updated_at)
           VALUES (?,?,?,?,?, 'x','x','x','x')`,
        )
        .run(`pr-${i}`, `c-${i}`, `s-a-${i}`, `s-b-${i}`, surface);
    });

    expect(rows(t, 'SELECT COUNT(*) n FROM connector_pairs')[0]?.n).toBe(
      CONNECTOR_PAIR_SURFACES.length,
    );
    t.dispose();
  });

  it('keeps all three OUTBOUND cascades, and gains no inbound child', async () => {
    const t = await seedPreMigration();
    t.applyMigration(MIGRATION);

    // The recreate rewrites the FK clauses from scratch, and drizzle-kit is known to
    // drop ON DELETE actions silently (docs/migrations.md §0). Assert the shipped DDL,
    // not the schema literal.
    const fks = rows(t, 'PRAGMA foreign_key_list(connector_pairs)').map((r) => [
      r.from,
      r.table,
      r.on_delete,
    ]);
    expect(fks).toEqual(
      expect.arrayContaining([
        ['catalog_id', 'connector_catalogs', 'CASCADE'],
        ['stub_a_id', 'connector_stubs', 'CASCADE'],
        ['stub_b_id', 'connector_stubs', 'CASCADE'],
      ]),
    );
    expect(fks.length).toBe(3);

    // And the cascade still FIRES — a surviving clause that no longer acts is the
    // failure the assertion above cannot see.
    t.raw.prepare('DELETE FROM connector_catalogs WHERE id = ?').run(CATALOG);
    expect(rows(t, 'SELECT COUNT(*) n FROM connector_pairs')[0]?.n).toBe(0);

    // THE CONTAINMENT, AS OF 0032. This migration is safe in drizzle-kit's generated
    // order only because nothing held a cascading FK INTO `connector_pairs`, so its
    // `DROP TABLE` could reach no live row anywhere.
    //
    // Read the scope carefully: the harness stops at `upToExclusive` and this case
    // therefore asserts the schema as `0032` left it. It CANNOT fail when a later
    // migration adds a child, and one already has — `0033` (AECI-891) gave `claims` a
    // `connector_pair_id`, so at HEAD the answer is `['claims']` and a future
    // `connector_pairs` recreate needs 0027's hand-assembled ordering. The guard that
    // watches HEAD is in `d1.spec.ts`; this one only certifies that 0032 itself was
    // safe when it ran.
    const inbound = rows(
      t,
      `SELECT m.name FROM sqlite_master m WHERE m.type = 'table'
         AND m.name NOT LIKE 'sqlite_%'
         AND EXISTS (SELECT 1 FROM pragma_foreign_key_list(m.name) f
                     WHERE f."table" = 'connector_pairs')`,
    );
    expect(inbound).toEqual([]);

    // Same claim, read off the committed SQL rather than the live schema, so a
    // regenerated migration that reintroduces a child is caught at review time too.
    //
    // Comment lines are stripped first. The file's own header tells the next reader to
    // run `grep -rn "REFERENCES connector_pairs"`, and it quotes the pragma it replaced
    // — so matching the raw text would fail on the prose that documents the rule rather
    // than on a real child FK or a real pragma.
    const sql = statementsForMigration(MIGRATION)
      .join('\n')
      .replace(/^\s*--.*$/gm, '');
    expect(sql).not.toMatch(/REFERENCES\s+[`"]?connector_pairs/i);
    // And the D1 pragma edit (docs/migrations.md §3.3a rule 1) is still applied —
    // regenerating this file reintroduces `PRAGMA foreign_keys=OFF`, which D1 ignores.
    expect(sql).toMatch(/PRAGMA defer_foreign_keys = true/);
    expect(sql).not.toMatch(/PRAGMA foreign_keys/);

    t.dispose();
  });
});
