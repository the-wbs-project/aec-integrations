/**
 * Every foreign key into `vendors` must carry an explicit handling decision in
 * `retract-vendor.ts` (AECI-1226).
 *
 * WHY. D1 enforces foreign keys and cascades them, so a new table with
 * `ON DELETE CASCADE` into `vendors` is deleted silently by the vendor DELETE: no
 * footprint count, no refusal, no tombstone. That is how `review_responses` and the
 * contests a vendor filed went uncounted until this issue. This spec reads the LATEST
 * drizzle-kit snapshot, which is regenerated with every migration, so the failure lands
 * in the PR that adds the FK. Same contract as `retract-product-fk-coverage.spec.ts`.
 *
 * FIXING A FAILURE. Decide what a vendor retraction does with the new rows, add the
 * `table.column` key to `VENDOR_FK_HANDLING`, and make `buildVendorFootprintSql` /
 * `classifyVendorRetraction` / `buildVendorDeleteStatements` do it. Adding the key alone
 * makes this spec pass and the tool wrong, so `retract-vendor.spec.ts` should grow a
 * case for it too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildVendorDeleteStatements,
  parseVendorFootprint,
  VENDOR_FK_HANDLING,
  type RawVendorFootprintRow,
} from './retract-vendor';

interface SnapshotFk {
  tableFrom: string;
  tableTo: string;
  columnsFrom: string[];
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

function fksIntoVendors(snapshot: Snapshot): string[] {
  const keys: string[] = [];
  for (const def of Object.values(snapshot.tables)) {
    for (const fk of Object.values(def.foreignKeys ?? {})) {
      if (fk.tableTo !== 'vendors') continue;
      for (const col of fk.columnsFrom) keys.push(`${fk.tableFrom}.${col}`);
    }
  }
  return [...new Set(keys)].sort();
}

/** The widest plan: every table present, as at HEAD. */
const PLAN = buildVendorDeleteStatements({
  vendor: { id: 'v', slug: 'v', company_name: 'v', promotion_status: 'promoted', verified: 0 },
  // Only the tombstone JSON reads the footprint; its values do not shape the plan.
  footprint: parseVendorFootprint({} as RawVendorFootprintRow),
  auditId: 'a',
  now: '2026-01-01T00:00:00.000Z',
});

describe('retract-vendor FK coverage (AECI-1226)', () => {
  const { file, snapshot } = latestSnapshot();

  it(`has a handling decision for every FK into vendors (${file})`, () => {
    const actual = fksIntoVendors(snapshot);
    const unhandled = actual.filter((k) => !(k in VENDOR_FK_HANDLING));
    expect(
      unhandled,
      'FK(s) into vendors with no decision in VENDOR_FK_HANDLING — a vendor retraction would cascade them silently',
    ).toEqual([]);
    const stale = Object.keys(VENDOR_FK_HANDLING).filter((k) => !actual.includes(k));
    expect(stale, 'VENDOR_FK_HANDLING names an FK the schema no longer has').toEqual([]);
  });

  it('deletes explicitly from every table whose outcome is delete', () => {
    for (const [key, outcome] of Object.entries(VENDOR_FK_HANDLING)) {
      if (outcome !== 'delete') continue;
      const [table, column] = key.split('.');
      expect(
        PLAN.some((s) => s.startsWith(`DELETE FROM "${table}" WHERE "${column}" = `)),
        key,
      ).toBe(true);
    }
  });

  it('NULLs explicitly every column whose outcome is detach', () => {
    for (const [key, outcome] of Object.entries(VENDOR_FK_HANDLING)) {
      if (outcome !== 'detach') continue;
      const [table, column] = key.split('.');
      expect(
        PLAN.some((s) => s.startsWith(`UPDATE "${table}" SET "${column}" = NULL WHERE `)),
        key,
      ).toBe(true);
    }
  });

  it('never names a refused or fk-action table in the plan', () => {
    for (const [key, outcome] of Object.entries(VENDOR_FK_HANDLING)) {
      if (outcome !== 'refuse' && outcome !== 'fk-action') continue;
      const table = key.split('.')[0]!;
      // `integrations` is the parent of nothing here, but its name is a prefix of
      // `integration_*` tables, so match the quoted identifier.
      expect(PLAN.join('\n'), key).not.toContain(`"${table}"`);
    }
  });

  it('never deletes page_views (log-class, detached)', () => {
    expect(VENDOR_FK_HANDLING['page_views.vendor_id']).toBe('detach');
    expect(PLAN.some((s) => s.startsWith('DELETE FROM "page_views"'))).toBe(false);
  });
});
