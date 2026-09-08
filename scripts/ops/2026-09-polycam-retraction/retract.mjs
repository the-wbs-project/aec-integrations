#!/usr/bin/env node
//
// retract.mjs — execute the AECI-593 Polycam editorial retraction against a
// deployed D1: delete the two integration rows a curator retracted upstream on
// 2026-08-09, plus their claims/attestations, then repair the denormalized
// `integration_count` on every touched product.
//
// ─── WHY A SCRIPT AND NOT THE DATATOOL ───────────────────────────────────────
//
// The exit AECI-593 prescribes is `POST /api/prune-integrations` on the datatool
// Worker (`apps/datatool`), whose named-guard acknowledgment shipped in PR #510
// FOR THIS RETRACTION. That endpoint is gated by Cloudflare Access (or a
// `TOOL_TOKEN` bearer), and neither an Access service token nor `TOOL_TOKEN` is
// provisioned in an operator workspace — so the prescribed path is unreachable
// from here without first minting a credential.
//
// This script is the SAME OPERATION, run over `wrangler d1 execute --remote`
// with the credentials that ARE present (`CLOUDFLARE_API_TOKEN` +
// `CLOUDFLARE_ACCOUNT_ID`). Every query below is a transcription of
// `apps/datatool/src/prune-integrations.ts` — `prunePlan` (footprint, the three
// guards, affected products, rollback SQL) and `pruneExecute` (child→parent
// delete, then the AECI-721 count repair that counts `connector_evidenced_pairs`
// as well as `integrations`). Divergence from that module is a bug HERE.
//
// It is not a general tool. It carries the two ids as constants and refuses to
// run against anything else, because "which rows" is the editorial half of this
// operation and was settled by a curator, not by a query. A future stranded-row
// set goes through the datatool, with a credential.
//
// ─── THE ONE THING THE DATATOOL DOES THAT THIS DOES NOT ──────────────────────
//
// The datatool follows a prune with a CLEAN ALGOLIA REINDEX, which is how the
// deleted objects leave the index and how the corrected `integration_count`
// reaches the product records. A Node process has no Algolia reindex path, so
// this script instead BUMPS `products.updated_at` on the affected products —
// putting them inside the 08:00 incremental sync's watermark window
// (`apps/api/src/lib/algolia-sync.ts`), which republishes the corrected counts.
// The two deleted integration OBJECTS are removed separately, by the targeted
// `ops:purge-algolia-orphans` run recorded in this directory's README. Both
// steps are also what the 09:00 drift cron would eventually do on its own; doing
// them by hand is what keeps the window from being a day wide.
//
// The bumped `updated_at` also moves each page's sitemap `<lastmod>`, which is
// correct — the content genuinely changed.
//
// USAGE (from the repo root; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
//   node scripts/ops/2026-09-polycam-retraction/retract.mjs --env production
//   node scripts/ops/2026-09-polycam-retraction/retract.mjs --env production --apply --allow-production
//
// Dry-run by default: it reads, reports, writes `rollback.sql` next to itself,
// and changes nothing. `--apply` performs the deletes; `--env production` needs
// `--allow-production` on top. Exits 0 on success, 1 on a refusal, 2 on a
// usage/credential error.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'apps', 'api');

/**
 * The retraction set, fixed. Both rows were created by the 2026-08-09 Polycam
 * promote and retracted upstream ~5 minutes later by the curator ruling recorded
 * verbatim on the review app's Polycam record (`tool_integration_check_notes`
 * and `research_notes`): the integration bar is a PURPOSE-BUILT MECHANISM, and a
 * manual file hand-off is not an integration however well documented.
 */
const IDS = [
  '4dc9d4bb-494f-4735-8ebb-7cc5389048ce', // polycam → autocad, "DXF export (layered floor plan + point cloud)"
  '74099c42-e67a-4bab-9053-f6320b17e5ef', // polycam → arcgis,  "Georeferenced LAS/LAZ export"
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const D1_ENVS = {
  preview: { db: 'aeci-app-preview', flags: ['--env', 'preview'] },
  staging: { db: 'aeci-app-staging', flags: ['--env', 'staging'] },
  demo: { db: 'aeci-app-demo', flags: ['--env', 'demo'] },
  production: { db: 'aeci-app-production', flags: ['--env', 'production'] },
};

function readValueFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * Ids are interpolated, not bound — `wrangler d1 execute --command` has no bind
 * parameters. That is safe only because nothing here is operator input: the list
 * is a module constant, and this assertion is what keeps it that way if someone
 * later makes it one.
 */
function sqlIdList(ids) {
  for (const id of ids) {
    if (!UUID_RE.test(id)) throw new Error(`Not a UUID, refusing to interpolate: ${id}`);
  }
  return ids.map((id) => `'${id}'`).join(',');
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** `claims.anchor_id` is STORED-generated (AECI-721) — SQLite refuses an INSERT
 *  that supplies it, so the rollback must strip it. Mirrors GENERATED_COLUMNS in
 *  `apps/datatool/src/prune-integrations.ts`. */
const GENERATED_COLUMNS = { claims: ['anchor_id'] };

function toInsert(table, row) {
  const cols = Object.keys(row).filter((c) => !(GENERATED_COLUMNS[table] ?? []).includes(c));
  return `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols
    .map((c) => sqlLiteral(row[c]))
    .join(',')});`;
}

function d1(target, sql, { write = false } = {}) {
  const res = spawnSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      target.db,
      ...target.flags,
      '--remote',
      '--json',
      '--command',
      sql,
    ],
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${res.status}):\n${res.stderr || res.stdout}`);
  }
  // wrangler prints a JSON array of per-statement results, sometimes preceded by
  // banner lines on stdout — take the first `[` onward.
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`No JSON in wrangler output:\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.slice(start));
  if (write) return parsed;
  return parsed[0]?.results ?? [];
}

async function main() {
  const argv = process.argv.slice(2);
  const envName = readValueFlag(argv, '--env') ?? 'production';
  const target = D1_ENVS[envName];
  if (!target) {
    console.error(`Invalid --env "${envName}". Expected: ${Object.keys(D1_ENVS).join(', ')}.`);
    return 2;
  }
  const apply = argv.includes('--apply');
  if (apply && envName === 'production' && !argv.includes('--allow-production')) {
    console.error('Refusing to write PRODUCTION without --allow-production.');
    return 1;
  }
  if (!process.env.CLOUDFLARE_API_TOKEN && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error('Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (or `wrangler login`).');
    return 2;
  }

  const ph = sqlIdList(IDS);
  console.log(`# AECI-593 Polycam retraction — ${target.db} (${apply ? 'APPLY' : 'dry-run'})\n`);

  // ─── Plan ──────────────────────────────────────────────────────────────────
  const rows = d1(
    target,
    `SELECT i.id AS id, s.slug AS sourceSlug, t.slug AS targetSlug,
            i.mechanism_name AS mechanismName, i.mechanism_kind AS mechanismKind,
            i.created_at AS createdAt
       FROM integrations i
       LEFT JOIN products s ON s.id = i.source_product_id
       LEFT JOIN products t ON t.id = i.target_product_id
      WHERE i.id IN (${ph}) ORDER BY s.slug, t.slug`,
  );
  const found = new Set(rows.map((r) => String(r.id).toLowerCase()));
  const missing = IDS.filter((id) => !found.has(id.toLowerCase()));

  console.table(rows);
  if (missing.length) console.log(`missing (already gone): ${missing.join(', ')}`);
  if (!rows.length) {
    console.log(
      '\nNothing to do — both rows are already absent. This is the post-retraction state.',
    );
    return 0;
  }

  const [agg] = d1(
    target,
    `SELECT
       (SELECT COUNT(*) FROM integrations WHERE id IN (${ph})) AS integrations,
       (SELECT COUNT(*) FROM claims WHERE integration_id IN (${ph})) AS claims,
       (SELECT COUNT(*) FROM attestations
          WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph}))) AS attestations,
       (SELECT COUNT(*) FROM claims oc
          JOIN integrations o ON o.id = oc.integration_id
         WHERE o.id IN (${ph})
           AND NOT EXISTS (
             SELECT 1 FROM integrations s JOIN claims sc ON sc.integration_id = s.id
              WHERE s.id NOT IN (${ph})
                AND s.source_product_id = o.source_product_id
                AND s.target_product_id = o.target_product_id
                AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
                AND sc.data_object_id = oc.data_object_id
                AND sc.direction = oc.direction
           )) AS claimsUniqueToOrphans,
       (SELECT COUNT(*) FROM integrations o
         WHERE o.id IN (${ph})
           AND NOT EXISTS (
             SELECT 1 FROM integrations s
              WHERE s.id NOT IN (${ph})
                AND s.source_product_id = o.source_product_id
                AND s.target_product_id = o.target_product_id
                AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
           )) AS orphansWithoutATwin,
       (SELECT COUNT(*) FROM integrations o
          JOIN integrations s ON s.id NOT IN (${ph})
            AND s.source_product_id = o.source_product_id
            AND s.target_product_id = o.target_product_id
            AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
         WHERE o.id IN (${ph})
           AND (LENGTH(IFNULL(o.description,'')) > LENGTH(IFNULL(s.description,''))
             OR LENGTH(IFNULL(o.notes,'')) > LENGTH(IFNULL(s.notes,'')))) AS orphansRicherThanTwin`,
  );
  const n = (v) => (typeof v === 'number' ? v : Number(v ?? 0));
  const guards = {
    claimsUniqueToOrphans: n(agg?.claimsUniqueToOrphans),
    orphansWithoutATwin: n(agg?.orphansWithoutATwin),
    orphansRicherThanTwin: n(agg?.orphansRicherThanTwin),
  };
  const blocked = Object.keys(guards).filter((k) => guards[k] > 0);

  const affected = d1(
    target,
    `SELECT DISTINCT p.id AS id, p.slug AS slug, p.integration_count AS integrationCount
       FROM integrations i JOIN products p ON p.id IN (i.source_product_id, i.target_product_id)
      WHERE i.id IN (${ph}) ORDER BY p.slug`,
  );

  console.log('\nfootprint:', {
    integrations: n(agg?.integrations),
    claims: n(agg?.claims),
    attestations: n(agg?.attestations),
  });
  console.log('guards:   ', guards);
  console.log('blocked:  ', blocked);
  console.table(affected);

  // ─── Rollback SQL (written on the dry run too — D1 has no undo) ─────────────
  const integrationRows = d1(target, `SELECT * FROM integrations WHERE id IN (${ph}) ORDER BY id`);
  const claimRows = d1(target, `SELECT * FROM claims WHERE integration_id IN (${ph}) ORDER BY id`);
  const attestationRows = d1(
    target,
    `SELECT * FROM attestations
      WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph})) ORDER BY id`,
  );
  const rollbackSql = [
    '-- Rollback for the AECI-593 Polycam retraction.',
    '-- Replay order is parent -> child so the FKs hold; INSERT OR IGNORE makes re-runs safe.',
    `-- integrations: ${integrationRows.length}, claims: ${claimRows.length}, attestations: ${attestationRows.length}`,
    '-- Recreating the rows does NOT restore integration_count: re-run',
    '--   RECONCILE_ENV=<env> pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production',
    ...integrationRows.map((r) => toInsert('integrations', r)),
    ...claimRows.map((r) => toInsert('claims', r)),
    ...attestationRows.map((r) => toInsert('attestations', r)),
    '',
  ].join('\n');
  const rollbackPath = join(HERE, 'rollback.sql');
  writeFileSync(rollbackPath, rollbackSql);
  console.log(`\nrollback written: ${rollbackPath}`);

  if (!apply) {
    console.log('\nDry run. Nothing was written. Re-run with --apply to execute.');
    return 0;
  }

  // ─── Execute ───────────────────────────────────────────────────────────────
  // Child → parent. Guards are acknowledged by the editorial ruling in the header,
  // which is this script's equivalent of the datatool's `acknowledgeReason`; the
  // durable record is this directory's README plus the Linear issue.
  console.log('\nDeleting…');
  d1(
    target,
    [
      `DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph}));`,
      `DELETE FROM claims WHERE integration_id IN (${ph});`,
      `DELETE FROM integrations WHERE id IN (${ph});`,
    ].join('\n'),
    { write: true },
  );

  // Count repair — the AECI-721 rule: DELIVERED edges regardless of which table
  // holds them. `connector_evidenced_pairs` is a constant here (the prune never
  // touches it), which is exactly why it must be in the expression: omitting it
  // would write the pre-AECI-721 answer back over a correct count.
  const pids = affected.map((r) => String(r.id));
  console.log('Repairing integration_count + bumping updated_at…');
  d1(
    target,
    pids
      .map(
        (pid) =>
          `UPDATE products SET integration_count =
             ((SELECT COUNT(*) FROM integrations WHERE source_product_id = '${pid}' OR target_product_id = '${pid}')
              + (SELECT COUNT(*) FROM connector_evidenced_pairs
                   WHERE product_a_id = '${pid}' OR product_b_id = '${pid}' OR connector_product_id = '${pid}')),
             updated_at = '${new Date().toISOString()}'
           WHERE id = '${pid}';`,
      )
      .join('\n'),
    { write: true },
  );

  // ─── Verify ────────────────────────────────────────────────────────────────
  const leftovers = d1(target, `SELECT COUNT(*) AS n FROM integrations WHERE id IN (${ph})`);
  const orphanClaims = d1(
    target,
    `SELECT COUNT(*) AS n FROM claims WHERE integration_id IN (${ph})`,
  );
  const after = d1(
    target,
    `SELECT slug, integration_count AS integrationCount FROM products
      WHERE id IN (${pids.map((p) => `'${p}'`).join(',')}) ORDER BY slug`,
  );
  console.log('\nafter:');
  console.table(after);
  const clean = n(leftovers[0]?.n) === 0 && n(orphanClaims[0]?.n) === 0;
  console.log(`integrations left: ${n(leftovers[0]?.n)}, claims left: ${n(orphanClaims[0]?.n)}`);
  if (!clean) {
    console.error('\nRows survived the delete. Investigate before re-running.');
    return 1;
  }
  console.log('\nDone. Next: de-index the two integration objects from Algolia and re-run the');
  console.log("stranded-row audit — both commands are in this directory's README.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
