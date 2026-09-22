/**
 * Every foreign key into `products` — and into every table the retraction lane
 * deletes from — must carry an explicit handling decision in `retract-product.ts`
 * (AECI-687).
 *
 * WHY. D1 enforces foreign keys and cascades them, so a new table with
 * `ON DELETE CASCADE` into `products` is deleted silently by the product DELETE:
 * no footprint count, no refusal, no tombstone. That is how
 * `connector_evidenced_pairs` and `connector_catalogs` went unhandled until this
 * issue, and it would happen again the next time a table points at a product.
 * This spec reads the LATEST drizzle-kit snapshot, which is regenerated with every
 * migration, so the failure lands in the PR that adds the FK.
 *
 * FIXING A FAILURE. Decide what a product retraction does with the new rows, add
 * the `table.column` key to `PRODUCT_FK_HANDLING` (or `CASCADE_CHILD_HANDLING` for
 * a child of a row the lane deletes), and make `buildFootprintSql` /
 * `classifyRetraction` / `buildDeleteStatements` do it. Adding the key alone makes
 * this spec pass and the tool wrong, so the harness test in
 * `retract-product.spec.ts` should grow a row for it too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildDeleteStatements,
  CASCADE_CHILD_HANDLING,
  parseFootprint,
  PRODUCT_FK_HANDLING,
  type RawFootprintRow,
} from './retract-product';

interface SnapshotFk {
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
  onDelete?: string;
}
interface Snapshot {
  tables: Record<string, { foreignKeys?: Record<string, SnapshotFk> }>;
}

const META_DIR = join(process.cwd(), 'migrations', 'meta');

function latestSnapshot(): { file: string; snapshot: Snapshot } {
  const file = readdirSync(META_DIR)
    .filter((f) => /^\d+_snapshot\.json$/.test(f))
    .sort()
    .at(-1);
  if (!file) throw new Error(`no drizzle-kit snapshot under ${META_DIR}`);
  return { file, snapshot: JSON.parse(readFileSync(join(META_DIR, file), 'utf8')) as Snapshot };
}

function fksInto(snapshot: Snapshot, tables: Set<string>): string[] {
  const keys: string[] = [];
  for (const def of Object.values(snapshot.tables)) {
    for (const fk of Object.values(def.foreignKeys ?? {})) {
      if (!tables.has(fk.tableTo)) continue;
      for (const col of fk.columnsFrom) keys.push(`${fk.tableFrom}.${col}`);
    }
  }
  return [...new Set(keys)].sort();
}

/** Tables the delete plan removes rows from, read off the plan itself so a new
 *  delete target is covered without editing this spec. */
function deletedTables(): Set<string> {
  const stmts = buildDeleteStatements({
    product: { id: 'p', slug: 'p', name: 'p', promotion_status: 'promoted' },
    // Only the tombstone JSON reads the footprint; its values do not shape the plan.
    footprint: parseFootprint({} as RawFootprintRow),
    auditId: 'a',
    now: '2026-01-01T00:00:00.000Z',
    // The widest plan: with the flag, the pair table is a delete target too.
    deleteEvidencedPairs: true,
  });
  const out = new Set<string>();
  for (const s of stmts) {
    const m = /^DELETE FROM "([a-z_]+)"/.exec(s);
    if (m) out.add(m[1]!);
  }
  return out;
}

describe('retract-product FK coverage (AECI-687)', () => {
  const { file, snapshot } = latestSnapshot();

  it(`has a handling decision for every FK into products (${file})`, () => {
    const actual = fksInto(snapshot, new Set(['products']));
    const unhandled = actual.filter((k) => !(k in PRODUCT_FK_HANDLING));
    expect(
      unhandled,
      `FK(s) into products with no decision in PRODUCT_FK_HANDLING — a product retraction would cascade them silently`,
    ).toEqual([]);
    const stale = Object.keys(PRODUCT_FK_HANDLING).filter((k) => !actual.includes(k));
    expect(stale, 'PRODUCT_FK_HANDLING names an FK the schema no longer has').toEqual([]);
  });

  it(`has a handling decision for every FK into a table the plan deletes from (${file})`, () => {
    const tables = deletedTables();
    tables.delete('products');
    expect(tables.size).toBeGreaterThan(0);
    const actual = fksInto(snapshot, tables);
    // An FK into a deleted table that is itself an FK into products is already
    // decided above (e.g. product_extensions.host_product_id).
    const unhandled = actual.filter(
      (k) => !(k in CASCADE_CHILD_HANDLING) && !(k in PRODUCT_FK_HANDLING),
    );
    expect(
      unhandled,
      `FK(s) into ${[...tables].join(', ')} with no decision in CASCADE_CHILD_HANDLING`,
    ).toEqual([]);
    const stale = Object.keys(CASCADE_CHILD_HANDLING).filter((k) => !actual.includes(k));
    expect(stale, 'CASCADE_CHILD_HANDLING names an FK the schema no longer has').toEqual([]);
  });

  it('keeps a connector catalogue a hard refusal', () => {
    expect(PRODUCT_FK_HANDLING['connector_catalogs.connector_product_id']).toBe('refuse');
    expect(PRODUCT_FK_HANDLING['connector_stub_mappings.product_id']).toBe('refuse');
  });

  it('puts every connector-evidenced pair FK behind its own flag, not --force (AECI-904)', () => {
    for (const col of ['connector_product_id', 'product_a_id', 'product_b_id'])
      expect(PRODUCT_FK_HANDLING[`connector_evidenced_pairs.${col}`]).toBe('flag-tombstone');
  });

  it('never deletes page_views (log-class, detached)', () => {
    expect(PRODUCT_FK_HANDLING['page_views.product_id']).toBe('detach');
    expect(deletedTables().has('page_views')).toBe(false);
  });

  it('deletes from every table whose FK outcome says it deletes', () => {
    const tables = deletedTables();
    for (const [key, outcome] of Object.entries({
      ...PRODUCT_FK_HANDLING,
      ...CASCADE_CHILD_HANDLING,
    })) {
      if (
        outcome === 'force-tombstone' ||
        outcome === 'flag-tombstone' ||
        outcome === 'facet' ||
        outcome === 'cascade-child'
      ) {
        expect(tables.has(key.split('.')[0]!), key).toBe(true);
      }
    }
  });
});
