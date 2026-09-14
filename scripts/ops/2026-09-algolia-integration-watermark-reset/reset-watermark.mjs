#!/usr/bin/env node
//
// reset-watermark.mjs — force ONE full sweep of the `integrations` entity in the
// nightly Algolia incremental sync, by resetting that entity's watermark field to
// the epoch sentinel (AECI-880).
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// `apps/api/src/lib/algolia-sync.ts` keeps one `stats_cache` row, keyed
// `algolia_sync_watermark`, holding a per-entity ISO timestamp:
//
//   { "products": "…", "vendors": "…", "integrations": "…" }
//
// The 08:00 UTC cron pushes only rows whose own `updated_at` falls in
// `(watermark[entity], cutoff]`. `readWatermark()` treats a MISSING field as
// `new Date(0).toISOString()` — the epoch sentinel — which makes the next run a
// self-healing full sweep of that entity's whole membership.
//
// Migration `0027` moved the connector-evidenced-pair population between tables
// with their ids AND their `updated_at` verbatim, so every one of those rows sits
// permanently behind the `integrations` watermark. The nightly window has never
// reached them and never will. They are in the D1 membership count and not in the
// index, which is the +277 (now ~22) drift AECI-880 reports. Writing the sentinel
// back is the documented catch-up path.
//
// ─── WHAT IT TOUCHES, AND WHAT IT MUST NOT ───────────────────────────────────
//
// ONE field of ONE row. `products` and `vendors` keep their current timestamps and
// are rewritten byte-identical. Resetting all three would sweep the full catalog
// through Algolia for no reason and burn operations on an app whose index quota is
// already exhausted.
//
// The write is a targeted UPDATE of `stats_cache."value"`, not an upsert of the
// whole row, and it is guarded by a `WHERE "value" = '<the exact JSON we read>'`
// predicate. That makes it a compare-and-swap: if the 08:00 sync (or anything else)
// rewrites the row between the read and the write, the UPDATE matches zero rows and
// the script fails loudly rather than clobbering a newer fence.
//
// `stats_cache` is derived state, so ADR 0022 owes NO `audit_log` row here. Do not
// add one — the audit builders are for domain state.
//
// ─── ORDER OF OPERATIONS FOR THE OPERATOR ────────────────────────────────────
//
//   1. Dry run (default) — prints the row as it stands.
//   2. `--apply --allow-production` — writes the sentinel.
//   3. Wait for the next 08:00 UTC `algolia-sync` cron. There is no HTTP or queue
//      entry point that invokes the sync for one entity: the only producer of the
//      `sync` job is `scheduled.ts`'s cron dispatch. The datatool's
//      `POST /api/reindex` is the equivalent full rebuild if a click is preferred.
//   4. Confirm with the drift report:
//        ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=… CLOUDFLARE_API_TOKEN=… \
//          pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production
//      `integrations` drift must read 0. Then the `data-quality` cron (04:00 UTC)
//      must report `algolia_index_drift` clean on two consecutive days.
//
// One caution carried over from the AECI-882 note: the nightly orphan sweep's
// safety cap is `maxDeletes: 50` / `maxFraction: 0.2` and it deletes NOTHING above
// that. This script only ADDS records to the index, so the cap is not in play — but
// do not pair it with a large deletion in the same window.
//
// ─── USAGE ───────────────────────────────────────────────────────────────────
//
//   node scripts/ops/2026-09-algolia-integration-watermark-reset/reset-watermark.mjs \
//     --env production
//
//   node scripts/ops/2026-09-algolia-integration-watermark-reset/reset-watermark.mjs \
//     --env production --apply --allow-production
//
// Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (or a `wrangler login`)
// with D1 read+write on the target account.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'apps', 'api');

/** Must match `ALGOLIA_WATERMARK_KEY` in `apps/api/src/lib/algolia-sync.ts`. */
const WATERMARK_KEY = 'algolia_sync_watermark';

/** Must match `EPOCH_ISO` in the same file: `new Date(0).toISOString()`. */
const EPOCH_ISO = new Date(0).toISOString();

/** Must match `INDEX_ENTITIES` in `packages/shared/src/algolia.ts`. */
const INDEX_ENTITIES = ['products', 'vendors', 'integrations'];

/**
 * The one field this script resets. Named `integrations`, plural — the ticket text
 * says "the integration entity", but the JSON key the sync reads is the plural
 * `INDEX_ENTITIES` member. Resetting a singular `integration` key would write a
 * field nothing reads and change nothing.
 */
const TARGET_ENTITY = 'integrations';

const D1_ENVS = {
  preview: { db: 'aeci-app-preview', flags: ['--env', 'preview'] },
  staging: { db: 'aeci-app-staging', flags: ['--env', 'staging'] },
  demo: { db: 'aeci-app-demo', flags: ['--env', 'demo'] },
  production: { db: 'aeci-app-production', flags: ['--env', 'production'] },
};

// ─── D1 I/O ──────────────────────────────────────────────────────────────────

function runWrangler(target, args, label) {
  const res = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', target.db, ...target.flags, '--remote', '--json', ...args],
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(
      `wrangler d1 execute (${label}) failed with ${res.status}:\n${res.stderr || res.stdout}`,
    );
  }
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`No JSON in wrangler output (${label}):\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start));
}

/** Read path: one statement, no embedded literals, so `--command` is safe. */
function d1Read(target, sql) {
  return runWrangler(target, ['--command', sql], 'read')[0]?.results ?? [];
}

/**
 * Write path: `--file`, not `--command`.
 *
 * The UPDATE embeds two JSON documents as SQL string literals. Those contain `"` and
 * `:` and could contain a `;` if a future watermark value ever did; wrangler's
 * statement splitter is quote-aware through `--file`, and a file also sidesteps argv
 * length limits. Same reasoning as the retraction consumer's `d1Write`.
 */
function d1Write(target, sql, scratchDir, label) {
  const path = join(scratchDir, `${label}.sql`);
  writeFileSync(path, sql);
  return runWrangler(target, ['--file', path], label);
}

function sqlLiteral(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function usage() {
  console.log(`
reset-watermark.mjs — force one full Algolia sweep of the "${TARGET_ENTITY}" entity (AECI-880)

  --env <preview|staging|demo|production>   target D1 (required)
  --apply                                   perform the write. Dry-run otherwise.
  --allow-production                        required on top of --apply when --env production
  --help

Resets stats_cache['${WATERMARK_KEY}'].${TARGET_ENTITY} to ${EPOCH_ISO}.
Leaves the other entities untouched. Writes no audit_log row (ADR 0022: derived state).
`);
}

function readValueFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    return 0;
  }

  const envName = (readValueFlag(argv, '--env') ?? '').trim();
  const target = D1_ENVS[envName];
  if (!target) {
    console.error(
      `--env must be one of: ${Object.keys(D1_ENVS).join(', ')}. Got: ${envName || '(unset)'}`,
    );
    return 1;
  }

  const apply = argv.includes('--apply');
  if (apply && envName === 'production' && !argv.includes('--allow-production')) {
    console.error('Refusing to write PRODUCTION without --allow-production.');
    return 1;
  }
  if (!process.env.CLOUDFLARE_API_TOKEN && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.warn(
      '⚠  Neither CLOUDFLARE_API_TOKEN nor CLOUDFLARE_ACCOUNT_ID is set — wrangler --remote will need an interactive login.',
    );
  }

  console.log(`Target: ${target.db} (--env ${envName}) — ${apply ? 'APPLY' : 'dry-run'}\n`);

  // ─── 1. Read the row ───────────────────────────────────────────────────────
  const rows = d1Read(
    target,
    `SELECT "key", "value", "computed_at" FROM "stats_cache" WHERE "key" = ${sqlLiteral(WATERMARK_KEY)};`,
  );
  if (rows.length === 0) {
    // Not an error state for the SYNC — a missing row already means a full sweep of
    // all three entities on the next run. But it is not what this script was asked to
    // do, and writing the row from scratch would reset products and vendors too.
    console.error(
      `No stats_cache row keyed "${WATERMARK_KEY}" on ${target.db}.\n` +
        'A missing row already reads as epoch for ALL THREE entities, so the next 08:00 sync\n' +
        'will sweep everything. Nothing to do here — do not create the row by hand.',
    );
    return 1;
  }

  const row = rows[0];
  const rawValue = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    console.error(`stats_cache["${WATERMARK_KEY}"].value is not valid JSON:\n${rawValue}`);
    return 1;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`stats_cache["${WATERMARK_KEY}"].value is not a JSON object:\n${rawValue}`);
    return 1;
  }

  console.log('BEFORE');
  console.log(`  computed_at : ${row.computed_at}`);
  for (const entity of INDEX_ENTITIES) {
    const v = parsed[entity];
    console.log(`  ${entity.padEnd(12)}: ${v ?? '(absent → already epoch)'}`);
  }
  const extras = Object.keys(parsed).filter((k) => !INDEX_ENTITIES.includes(k));
  if (extras.length > 0) console.log(`  (unrecognised fields, preserved: ${extras.join(', ')})`);
  console.log(`  raw         : ${rawValue}\n`);

  if (parsed[TARGET_ENTITY] === EPOCH_ISO) {
    console.log(`"${TARGET_ENTITY}" is already at the epoch sentinel. Nothing to do.`);
    return 0;
  }

  // ─── 2. Build the next value ───────────────────────────────────────────────
  // Spread-then-override: every other field survives byte-for-byte, including any
  // key a future entity adds. Only `${TARGET_ENTITY}` moves.
  const next = { ...parsed, [TARGET_ENTITY]: EPOCH_ISO };
  const nextValue = JSON.stringify(next);

  console.log('AFTER (proposed)');
  for (const entity of INDEX_ENTITIES) {
    const changed = entity === TARGET_ENTITY;
    console.log(
      `  ${entity.padEnd(12)}: ${next[entity] ?? '(absent)'}${changed ? '   ← reset' : ''}`,
    );
  }
  console.log(`  raw         : ${nextValue}\n`);

  if (!apply) {
    console.log(
      `Dry run. Re-run with --apply${envName === 'production' ? ' --allow-production' : ''} to write.`,
    );
    return 0;
  }

  // ─── 3. Compare-and-swap ───────────────────────────────────────────────────
  // `computed_at` is deliberately NOT touched. It is the admin panel's derived
  // "when did the algolia-sync cron last run" signal (`CRON_DERIVATIONS` in
  // `routes/admin-system.ts`); stamping it here would report a sync that never
  // happened. `writeWatermark` will set it honestly on the next real run.
  const scratch = mkdtempSync(join(tmpdir(), 'aeci-880-'));
  const sql =
    `UPDATE "stats_cache" SET "value" = ${sqlLiteral(nextValue)}\n` +
    `  WHERE "key" = ${sqlLiteral(WATERMARK_KEY)} AND "value" = ${sqlLiteral(rawValue)};\n`;
  const result = d1Write(target, sql, scratch, 'reset');
  const meta = result[0]?.meta ?? {};
  console.log(
    `  write meta  : changes=${meta.changes ?? '?'} rows_written=${meta.rows_written ?? '?'} changed_db=${meta.changed_db ?? '?'}\n`,
  );

  // **Do not gate on `meta.changes === 1`.** Measured against production D1 on
  // 2026-09-14: this exact single-row UPDATE reported `changes: 2`. D1's `changes`
  // is not SQLite's `changes()` — the same divergence AECI-581 hit, where an upsert
  // reported no `meta.changes` at all. An equality gate here fails a write that
  // succeeded, and the operator then re-runs a mutation they already applied.
  //
  // `changed_db` is the honest signal that SOMETHING was written, and the verify
  // read below is the authority on WHAT. Only a write that touched nothing is a
  // hard stop here, because that is the compare-and-swap losing its race.
  if (meta.changed_db === false) {
    console.error(
      'The UPDATE wrote nothing — its `WHERE "value" = …` predicate matched no row.\n' +
        'The row changed between the read and the write; most likely the 08:00 sync ran.\n' +
        'Nothing was written. Re-run the dry run, read the new value, then retry.',
    );
    return 1;
  }

  // ─── 4. Verify ─────────────────────────────────────────────────────────────
  const after = d1Read(
    target,
    `SELECT "value", "computed_at" FROM "stats_cache" WHERE "key" = ${sqlLiteral(WATERMARK_KEY)};`,
  );
  const afterRaw =
    typeof after[0]?.value === 'string' ? after[0].value : JSON.stringify(after[0]?.value);
  const afterParsed = JSON.parse(afterRaw);
  console.log('AFTER (verified from D1)');
  console.log(`  computed_at : ${after[0]?.computed_at}`);
  for (const entity of INDEX_ENTITIES) {
    console.log(`  ${entity.padEnd(12)}: ${afterParsed[entity] ?? '(absent)'}`);
  }
  console.log(`  raw         : ${afterRaw}\n`);

  if (afterParsed[TARGET_ENTITY] !== EPOCH_ISO) {
    console.error(`Verification failed: "${TARGET_ENTITY}" is not at the epoch sentinel.`);
    return 1;
  }
  for (const entity of INDEX_ENTITIES) {
    if (entity === TARGET_ENTITY) continue;
    if (afterParsed[entity] !== parsed[entity]) {
      console.error(
        `Verification failed: "${entity}" changed. Expected ${parsed[entity]}, got ${afterParsed[entity]}.`,
      );
      return 1;
    }
  }

  console.log(
    `Done. The next 08:00 UTC algolia-sync cron will sweep the whole "${TARGET_ENTITY}" membership.\n` +
      'Then confirm with:\n' +
      '  pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env production\n' +
      `and watch the data-quality cron's algolia_index_drift line for two consecutive clean runs.`,
  );
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
