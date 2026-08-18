/**
 * build-rollback.mjs — turn the JSON row dumps `cleanup.sh` captures into a
 * replayable `rollback.sql`.
 *
 * D1 has no undo, so the backup IS the undo: this emits one INSERT per captured
 * row, parent → child (integrations, then claims, then attestations), which is
 * the reverse of the delete order and satisfies the FKs on replay.
 *
 * Input:  a backup dir holding integrations.json / claims.json / attestations.json,
 *         each the raw `wrangler d1 execute --json` envelope.
 * Output: SQL on stdout.
 *
 *   node build-rollback.mjs <backup-dir> > <backup-dir>/rollback.sql
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: build-rollback.mjs <backup-dir>');
  process.exit(2);
}

/** `wrangler d1 execute --json` returns [{ results: [...], success, meta }]. */
function rows(file) {
  const raw = readFileSync(join(dir, file), 'utf8');
  // wrangler prints a banner before the JSON; slice from the first `[`.
  const start = raw.indexOf('[');
  if (start === -1) return [];
  const parsed = JSON.parse(raw.slice(start));
  return parsed.flatMap((r) => r.results ?? []);
}

/** SQLite literal. Numbers stay bare; everything else is a quoted string. */
function lit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replaceAll("'", "''")}'`;
}

function emit(table, list) {
  if (list.length === 0) {
    console.log(`-- ${table}: no rows captured`);
    return;
  }
  const cols = Object.keys(list[0]);
  console.log(`-- ${table}: ${list.length} row(s)`);
  for (const row of list) {
    const values = cols.map((c) => lit(row[c])).join(', ');
    // OR IGNORE so a partial replay (some rows already restored) is safe to re-run.
    console.log(
      `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${values});`,
    );
  }
}

console.log('-- rollback for scripts/ops/2026-08-orphan-integration-cleanup');
console.log('-- parent → child order so the FKs hold on replay.');
console.log(`-- generated from ${dir}`);
console.log();
emit('integrations', rows('integrations.json'));
console.log();
emit('claims', rows('claims.json'));
console.log();
emit('attestations', rows('attestations.json'));
