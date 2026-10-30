/**
 * Every claim delete detaches and closes the private row thread on the claim
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §15.5, AECI-1542).
 *
 * WHY. `claim_threads.claim_id` is `ON DELETE SET NULL`, not a cascade, so a delete
 * that forgets the thread fails silently: the thread stays open with no claim, no
 * `anchor_snapshot` and no `thread.closed` row. A claim goes either by a DELETE of
 * `claims` or by a cascade from a parent row. This spec reads the parents off the
 * LATEST drizzle-kit snapshot, so a new cascade into `claims` widens the scan in the
 * PR that adds it. It then greps the source for a DELETE of any of those tables.
 *
 * FIXING A FAILURE. A new file deletes claims, directly or by cascade. Put the thread
 * detach in the same batch, BEFORE the DELETE: `planClaimRemovedThreadCloses` when the
 * claims are planned one by one, `claimRemovedThreadDetachWhere` when the delete is
 * set-based (both `lib/claim-thread-lifecycle.ts`). Raw-SQL lanes copy it
 * (`retract-product.ts`, the datatool prune, `vendor-held.mjs`). Then add the file to
 * `ALLOWED` with the marker its detach carries. A one-off ops script may instead
 * refuse on a tier with `claim_threads`, with `AECI-1542: refuse` as the marker.
 *
 * The grain is the file, not the call site. A file on the list that adds a second
 * delete passes; the review and the file's own tests catch that one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

interface SnapshotFk {
  tableFrom: string;
  tableTo: string;
  onDelete?: string;
}
interface Snapshot {
  tables: Record<string, { foreignKeys?: Record<string, SnapshotFk> }>;
}

const API_DIR = process.cwd();
const REPO = join(API_DIR, '..', '..');
const META_DIR = join(API_DIR, 'migrations', 'meta');

/** The roots a claim delete can live in. `apps/web` never writes D1. */
const SCAN_ROOTS = ['apps/api/src', 'apps/api/seed', 'apps/datatool/src', 'scripts'];
const SCAN_EXT = /\.(ts|mjs|js|sql|sh)$/;
const SKIP = /(^|\/)(node_modules|migrations|test|dist|\.wrangler)(\/|$)|\.spec\.ts$/;

/**
 * Each file that deletes claims, and the text that proves it handles the thread.
 * The marker is the detach helper it calls, or its copy, or its refusal.
 */
const ALLOWED: Record<string, { marker: string; how: string }> = {
  'apps/api/src/lib/promote-claims.ts': {
    marker: 'planClaimRemovedThreadCloses(',
    how: 'promote reconcile: per-claim detach with a race guard',
  },
  'apps/api/src/lib/promote-connector-catalog.ts': {
    marker: 'planClaimRemovedThreadCloses(',
    how: 'connector-catalog arm: per-claim detach',
  },
  'apps/api/src/routes/promote.ts': {
    marker: 'claimRemovedThreadDetachWhere(',
    how: 'stale-twin DELETEs: set-based detach. The two cross-table moves re-home claims first',
  },
  'apps/api/src/lib/retract-product.ts': {
    marker: 'threadDetachUpdate(',
    how: 'product retraction: raw-SQL detach before the claims DELETE',
  },
  'apps/datatool/src/prune-integrations.ts': {
    marker: 'claimThreadDetachStatements(',
    how: 'datatool prune: raw-SQL copy of the set-based detach',
  },
  'scripts/ops/2026-09-retraction-consumer/vendor-held.mjs': {
    marker: 'claimThreadDetachSql(',
    how: 'retraction consumer: raw-SQL copy, emitted by guardedAnchorDeleteSql',
  },
  'scripts/ops/2026-07-prod-catalog-reset/reset.sql': {
    marker: 'aeci_1542_guard',
    how: 'retired one-off: raises on a tier with claim_threads',
  },
  'scripts/ops/2026-08-orphan-integration-cleanup/cleanup.sh': {
    marker: 'AECI-1542: refuse',
    how: 'retired one-off: refuses on a tier with claim_threads',
  },
  'scripts/ops/2026-09-polycam-retraction/retract.mjs': {
    marker: 'AECI-1542: refuse',
    how: 'retired one-off: refuses on a tier with claim_threads',
  },
  'scripts/ops/2026-09-procore-followup-retraction/retract.mjs': {
    marker: 'AECI-1542: refuse',
    how: 'retired one-off: refuses on a tier with claim_threads',
  },
  'scripts/ops/2026-09-dynamics-monday-retraction/retract.mjs': {
    marker: 'AECI-1542: refuse',
    how: 'retired one-off: refuses on a tier with claim_threads',
  },
  'apps/api/seed/version-diff-fixtures.sql': {
    marker: "DELETE FROM claims WHERE id LIKE 'e0000000-",
    how: 'local seed fixture: resets its own fixture claims, which never carry a thread',
  },
};

function latestSnapshot(): Snapshot {
  const file = readdirSync(META_DIR)
    .filter((f) => /^\d+_snapshot\.json$/.test(f))
    .sort()
    .at(-1);
  if (!file) throw new Error(`no drizzle-kit snapshot under ${META_DIR}`);
  return JSON.parse(readFileSync(join(META_DIR, file), 'utf8')) as Snapshot;
}

/** `claims` plus every table whose DELETE cascades into it, transitively. */
function claimDeletingTables(snapshot: Snapshot): Set<string> {
  const fks = Object.values(snapshot.tables).flatMap((t) => Object.values(t.foreignKeys ?? {}));
  const out = new Set(['claims']);
  for (let grew = true; grew; ) {
    grew = false;
    for (const fk of fks) {
      if (fk.onDelete === 'cascade' && out.has(fk.tableFrom) && !out.has(fk.tableTo)) {
        out.add(fk.tableTo);
        grew = true;
      }
    }
  }
  return out;
}

const camel = (snake: string) => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function deletePattern(tables: Set<string>): RegExp {
  const raw = [...tables].join('|');
  const drizzle = [...tables].map(camel).join('|');
  return new RegExp(
    `DELETE\\s+FROM\\s+["\`]?(?:${raw})["\`]?(?![\\w])|\\.delete\\(\\s*(?:${drizzle})\\s*\\)`,
    'i',
  );
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(REPO, path);
    if (SKIP.test(rel)) continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SCAN_EXT.test(name)) out.push(rel);
  }
}

describe('every claim delete detaches the thread (AECI-1542, §15.5)', () => {
  const tables = claimDeletingTables(latestSnapshot());
  const pattern = deletePattern(tables);
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO, root), files);
  const deleting = files.filter((f) => pattern.test(readFileSync(join(REPO, f), 'utf8'))).sort();

  it('reads the cascade parents of claims off the snapshot', () => {
    // The anchor tables, and products above them. If this shrinks, the scan is blind.
    for (const t of ['claims', 'integrations', 'connector_evidenced_pairs', 'products'])
      expect(tables.has(t), t).toBe(true);
  });

  it('finds the known delete sites, so the scan is not vacuous', () => {
    expect(deleting).toContain('apps/api/src/lib/promote-claims.ts');
    expect(deleting).toContain('apps/datatool/src/prune-integrations.ts');
  });

  it(`allows only files that handle the thread (tables: ${[...tables].sort().join(', ')})`, () => {
    const unlisted = deleting.filter((f) => !(f in ALLOWED));
    expect(
      unlisted,
      'file(s) delete claims, directly or by cascade, and are not on ALLOWED. See the header.',
    ).toEqual([]);
  });

  it('each allowed file still carries its marker', () => {
    const missing = Object.entries(ALLOWED)
      .filter(([f]) => deleting.includes(f))
      .filter(([f, { marker }]) => !readFileSync(join(REPO, f), 'utf8').includes(marker))
      .map(([f]) => f);
    expect(missing, 'allowed file(s) no longer carry their thread-detach marker').toEqual([]);
  });

  it('names no file that no longer deletes claims', () => {
    const stale = Object.keys(ALLOWED).filter((f) => !deleting.includes(f));
    expect(stale, 'ALLOWED names a file with no claim delete. Remove it.').toEqual([]);
  });
});
