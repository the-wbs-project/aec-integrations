#!/usr/bin/env node
//
// retract.mjs — execute the AECI-794 retraction against a deployed D1: delete the
// stranded `procore-project-management → followup-crm` integration row, plus its
// claims/attestations, write the audit row, and repair the denormalized
// `integration_count` on both endpoint products.
//
// ─── WHY THIS ROW GOES ───────────────────────────────────────────────────────
//
// It is duplicate residue from a deliberate upstream merge. Two records existed;
// one was merged away under AECI-699 because both cited the same evidence page
// (`marketplace.procore.com/apps/followup-crm`) — "one artifact filed twice, not
// two". The ruling is recorded verbatim on the SURVIVING upstream record
// `rec1HRURkiFzAPUkn`, whose `supabaseId` is `111ed9fc-…` — the reverse-orientation
// row still live in D1. `8f5365f9-…` is the deleted mirror.
//
// Promote has no delete semantics (`docs/REVIEW_APP_PROMOTE_API.md` §5.1), so
// nothing will ever update or remove this row, and a re-promote of either endpoint
// would mint a second copy beside it.
//
// ─── WHY A SCRIPT AND NOT THE DATATOOL ───────────────────────────────────────
//
// Same reason as AECI-593: `POST /api/prune-integrations` is gated by Cloudflare
// Access or a `TOOL_TOKEN` bearer, and neither is provisioned in an operator
// workspace, while `CLOUDFLARE_API_TOKEN` is. Every query below is a transcription
// of `apps/datatool/src/prune-integrations.ts` — `prunePlan` (footprint, the three
// guards, affected products, rollback SQL) and `pruneExecute` (child→parent delete,
// then the AECI-721 count repair that counts `connector_evidenced_pairs` too).
// Divergence from that module is a bug HERE. This is the second route-around; see
// `apps/datatool/README.md`.
//
// ─── TWO DELIBERATE DIVERGENCES FROM THE POLYCAM LANE ────────────────────────
//
// 1. THE AUDIT ROW IS IN THE SAME BATCH AS THE DELETE, ahead of it. Polycam wrote
//    its two `audit_log` rows by hand AFTERWARDS, and its own README calls that
//    weaker: "nothing forced it to exist, and it would simply be missing if the
//    operator had forgotten." Following the Bluebeam pattern
//    (`scripts/ops/2026-09-bluebeam-vendor-retraction/apply.sql`) puts it in the
//    same `wrangler d1 execute` call, which is the closest raw SQL gets to the
//    §26.1 in-batch invariant.
//
// 2. THE GUARDS ARE ENFORCED, NOT JUST PRINTED. Polycam computed the guards and
//    then deleted regardless. Here the blocked set must match ACK_GUARDS exactly,
//    mirroring the datatool's `acknowledgeGuards` exact-match contract: naming a
//    guard that reads zero proves the plan being acknowledged is not the plan that
//    just ran, so the run refuses.
//
// ─── WHY BOTH GUARDS TRIP, AND WHY THAT IS NOT A REASON TO STOP ──────────────
//
// AECI-794 predicted `orphansWithoutATwin` would read 0 because a twin survives.
// It reads 1. The datatool's twin test matches on
// (source_product_id, target_product_id, mechanism_name) — it is ORIENTATION-BLIND,
// and this pair also disagrees on `mechanism_name` (NULL vs `FollowUp CRM "Push to
// Procore"`). `claimsUniqueToOrphans` reads 2 for the same reason plus an exact
// `direction` match, and `a_to_b` is not `both`.
//
// The content check that the guard is a proxy for was done directly instead, and it
// passes: the mirror asserts Documents and Directory & Contacts `a_to_b`; the
// survivor asserts those same two data objects as `both`, plus RFIs and Bids &
// Tenders. The mirror's claims are strictly subsumed. See `preflight.json`.
//
// ─── THE ONE THING THE DATATOOL DOES THAT THIS DOES NOT ──────────────────────
//
// The datatool follows a prune with a CLEAN ALGOLIA REINDEX. A Node process has no
// reindex path, so this script instead BUMPS `products.updated_at` on both affected
// products, putting them inside the 08:00 incremental sync's watermark window
// (`apps/api/src/lib/algolia-sync.ts`) so the corrected `integration_count` reaches
// their Algolia records. The deleted integration OBJECT is removed separately by the
// targeted `ops:purge-algolia-orphans` run in this directory's README.
//
// The bumped `updated_at` also moves each page's sitemap `<lastmod>`, which is
// correct — the content genuinely changed.
//
// USAGE (from the repo root; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
//   node scripts/ops/2026-09-procore-followup-retraction/retract.mjs --env production
//   node scripts/ops/2026-09-procore-followup-retraction/retract.mjs --env production --apply --allow-production
//
// Dry-run by default: it reads, reports, writes `rollback.sql` next to itself, and
// changes nothing. `--apply` performs the writes; `--env production` needs
// `--allow-production` on top. Exits 0 on success, 1 on a refusal, 2 on a
// usage/credential error.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'apps', 'api');

/**
 * The retraction set, fixed at one row. Carried as a constant, not derived from a
 * query, because "which row" is the editorial half of this operation and was settled
 * by a curator under AECI-699.
 */
const IDS = [
  '8f5365f9-b759-4605-8aab-b6aac352512d', // procore-project-management → followup-crm, `partner`
];

/** The reverse-orientation survivor. Read-only here: asserted untouched after the run. */
const SURVIVOR_ID = '111ed9fc-5f1c-4041-8c83-05427dc35588';

/**
 * The guards expected to trip, in `PRUNE_GUARD_NAMES` order. Exact match required —
 * this is the local equivalent of the datatool's `acknowledgeGuards`.
 */
const ACK_GUARDS = ['claimsUniqueToOrphans', 'orphansWithoutATwin'];

const ACK_REASON =
  'AECI-794: duplicate residue from the deliberate AECI-699 upstream merge. Both rows cited ' +
  'the same evidence page (marketplace.procore.com/apps/followup-crm) — one artifact filed ' +
  'twice, not two. The surviving upstream record rec1HRURkiFzAPUkn carries supabaseId ' +
  '111ed9fc-… (the reverse-orientation row, kept), so 8f5365f9-… is the deleted mirror and no ' +
  'promote can ever reach it. Both guards are false positives of an orientation-blind twin ' +
  'test: the mirror asserts Documents and Directory & Contacts a_to_b, and the survivor ' +
  'asserts both of those as `both`, so the mirror adds nothing and loses nothing.';

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
 * parameters. That is safe only because nothing here is operator input: the list is a
 * module constant, and this assertion is what keeps it that way if someone later
 * makes it one.
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

/** `claims.anchor_id` is STORED-generated (AECI-721) — SQLite refuses an INSERT that
 *  supplies it, so the rollback must strip it. Mirrors GENERATED_COLUMNS in
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

/**
 * The `audit_log` INSERT, built in JS so it can be inspected on the dry run and
 * executed in the same call as the DELETE.
 *
 * `created_at` is supplied explicitly and is NOT optional: it is NOT NULL with no
 * SQL-level DEFAULT, because `createdAt()` (`apps/api/src/db/schema.ts`) uses
 * Drizzle's `$defaultFn`, which only runs in application code. Omitting it fails with
 * SQLITE_CONSTRAINT_NOTNULL, and inside a multi-statement batch that surfaces as an
 * opaque `{"D1_RESET_DO":true}` with no statement and no constraint name.
 *
 * `actor_id` stays NULL and `actor_type` is 'admin': this is an operator action taken
 * outside a session. `action` is 'integration.deleted', matching the AECI-593 Polycam
 * rows so the action vocabulary stays queryable.
 */
function buildAuditInsert({ row, footprint, guards, claims }) {
  const beforeState = {
    id: row.id,
    source_slug: row.sourceSlug,
    target_slug: row.targetSlug,
    name: row.name,
    mechanism_kind: row.mechanismKind,
    mechanism_name: row.mechanismName,
    direction: row.direction,
    created_at: row.createdAt,
    built_by_vendor_id: row.builtByVendorId,
    powered_by_product_id: row.poweredByProductId,
    cascade: { claims: footprint.claims, attestations: footprint.attestations },
    claims,
  };
  const metadata = {
    issue: 'AECI-794',
    upstream_issue: 'AECI-699',
    operator: 'chrisw@thewbsproject.com',
    tool: 'scripts/ops/2026-09-procore-followup-retraction/retract.mjs',
    acknowledged_guards: ACK_GUARDS,
    acknowledge_reason: ACK_REASON,
    surviving_row: SURVIVOR_ID,
    surviving_upstream_record: 'rec1HRURkiFzAPUkn',
    deleted_mirror_upstream_record: 'rec4hd0vorc4G2ljN',
    guards,
    rollback: 'scripts/ops/2026-09-procore-followup-retraction/rollback.sql',
  };
  const cols = [
    'id',
    'actor_id',
    'actor_type',
    'action',
    'entity_type',
    'entity_id',
    'before_state',
    'metadata',
    'created_at',
  ];
  const vals = [
    sqlLiteral(randomUUID()),
    'NULL',
    sqlLiteral('admin'),
    sqlLiteral('integration.deleted'),
    sqlLiteral('integration'),
    sqlLiteral(row.id),
    sqlLiteral(JSON.stringify(beforeState)),
    sqlLiteral(JSON.stringify(metadata)),
    sqlLiteral(new Date().toISOString()),
  ];
  return `INSERT INTO "audit_log" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${vals.join(',')});`;
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
  console.log(
    `# AECI-794 procore→followup-crm retraction — ${target.db} (${apply ? 'APPLY' : 'dry-run'})\n`,
  );

  // ─── Plan ──────────────────────────────────────────────────────────────────
  const rows = d1(
    target,
    `SELECT i.id AS id, s.slug AS sourceSlug, t.slug AS targetSlug, i.name AS name,
            i.mechanism_name AS mechanismName, i.mechanism_kind AS mechanismKind,
            i.direction AS direction, i.created_at AS createdAt,
            i.built_by_vendor_id AS builtByVendorId,
            i.powered_by_product_id AS poweredByProductId
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
    console.log('\nNothing to do — the row is already absent. This is the post-retraction state.');
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
  const footprint = {
    integrations: n(agg?.integrations),
    claims: n(agg?.claims),
    attestations: n(agg?.attestations),
  };
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

  // The claims being destroyed, named — this is the evidence that the tripped
  // `claimsUniqueToOrphans` guard is a false positive, and it goes into `before_state`.
  const claimRowsNamed = d1(
    target,
    `SELECT d.slug AS dataObject, c.direction AS direction, c.origin AS origin
       FROM claims c LEFT JOIN taxonomy_data_objects d ON d.id = c.data_object_id
      WHERE c.integration_id IN (${ph}) ORDER BY d.slug`,
  );
  const survivorClaims = d1(
    target,
    `SELECT d.slug AS dataObject, c.direction AS direction
       FROM claims c LEFT JOIN taxonomy_data_objects d ON d.id = c.data_object_id
      WHERE c.integration_id = '${SURVIVOR_ID}' ORDER BY d.slug`,
  );

  console.log('\nfootprint:', footprint);
  console.log('guards:   ', guards);
  console.log('blocked:  ', blocked);
  console.log('acked:    ', ACK_GUARDS);
  console.table(affected);
  console.log('\nclaims being deleted (mirror):');
  console.table(claimRowsNamed);
  console.log('claims on the surviving row (kept):');
  console.table(survivorClaims);

  // ─── Rollback SQL (written on the dry run too — D1 has no undo) ─────────────
  const integrationRows = d1(target, `SELECT * FROM integrations WHERE id IN (${ph}) ORDER BY id`);
  const claimRows = d1(target, `SELECT * FROM claims WHERE integration_id IN (${ph}) ORDER BY id`);
  const attestationRows = d1(
    target,
    `SELECT * FROM attestations
      WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph})) ORDER BY id`,
  );
  const rollbackSql = [
    '-- Rollback for the AECI-794 procore-project-management → followup-crm retraction.',
    '-- Replay order is parent -> child so the FKs hold; INSERT OR IGNORE makes re-runs safe.',
    `-- integrations: ${integrationRows.length}, claims: ${claimRows.length}, attestations: ${attestationRows.length}`,
    '-- `claims.anchor_id` is omitted on purpose: it is a STORED generated column (AECI-721)',
    '-- and SQLite refuses an INSERT that supplies it.',
    '-- Recreating the rows does NOT restore integration_count: re-run',
    '--   RECONCILE_ENV=<env> pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production',
    '-- and note that replaying this recreates the STRANDED state, not curator control —',
    '-- the upstream record would still need recreating with this uuid in supabase_integration_id.',
    ...integrationRows.map((r) => toInsert('integrations', r)),
    ...claimRows.map((r) => toInsert('claims', r)),
    ...attestationRows.map((r) => toInsert('attestations', r)),
    '',
  ].join('\n');
  const rollbackPath = join(HERE, 'rollback.sql');
  writeFileSync(rollbackPath, rollbackSql);
  console.log(`\nrollback written: ${rollbackPath}`);

  // ─── Guard acknowledgment, exact match ─────────────────────────────────────
  const sameSet =
    blocked.length === ACK_GUARDS.length && blocked.every((g) => ACK_GUARDS.includes(g));
  if (!sameSet) {
    console.error(
      `\nGuard set changed since this script was written.\n  blocked now: [${blocked.join(', ')}]\n  acknowledged: [${ACK_GUARDS.join(', ')}]\n` +
        'Refusing. Re-establish the ruling against the new reading before editing ACK_GUARDS.',
    );
    return 1;
  }

  const auditInsert = buildAuditInsert({
    row: rows[0],
    footprint,
    guards,
    claims: claimRowsNamed,
  });

  if (!apply) {
    console.log('\naudit_log INSERT that would run first, in the same call as the delete:\n');
    console.log(auditInsert);
    console.log('\nDry run. Nothing was written. Re-run with --apply to execute.');
    return 0;
  }

  // ─── Execute ───────────────────────────────────────────────────────────────
  // Audit row first (so it exists even if a later statement fails), then child →
  // parent. The explicit child-first order matters because D1 does not guarantee FK
  // enforcement is on for a given `wrangler d1 execute`, so this works the same with
  // cascades on or off.
  console.log('\nWriting audit row + deleting…');
  d1(
    target,
    [
      auditInsert,
      `DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph}));`,
      `DELETE FROM claims WHERE integration_id IN (${ph});`,
      `DELETE FROM integrations WHERE id IN (${ph});`,
    ].join('\n'),
    { write: true },
  );

  // Count repair — the AECI-721 rule: DELIVERED edges regardless of which table holds
  // them. `connector_evidenced_pairs` is a constant here (the prune never touches it),
  // which is exactly why it must be in the expression: omitting it would write the
  // pre-AECI-721 answer back over a correct count.
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
  const survivor = d1(target, `SELECT COUNT(*) AS n FROM integrations WHERE id = '${SURVIVOR_ID}'`);
  const survivorClaimCount = d1(
    target,
    `SELECT COUNT(*) AS n FROM claims WHERE integration_id = '${SURVIVOR_ID}'`,
  );
  const auditRow = d1(
    target,
    `SELECT id, action, actor_type, entity_id, created_at FROM audit_log
      WHERE entity_id IN (${ph}) AND action = 'integration.deleted' ORDER BY created_at DESC LIMIT 1`,
  );
  const after = d1(
    target,
    `SELECT slug, integration_count AS integrationCount FROM products
      WHERE id IN (${pids.map((p) => `'${p}'`).join(',')}) ORDER BY slug`,
  );
  console.log('\nafter:');
  console.table(after);
  console.log('audit row:');
  console.table(auditRow);
  console.log(
    `integrations left: ${n(leftovers[0]?.n)}, claims left: ${n(orphanClaims[0]?.n)}, ` +
      `survivor present: ${n(survivor[0]?.n)}, survivor claims: ${n(survivorClaimCount[0]?.n)}`,
  );

  const clean =
    n(leftovers[0]?.n) === 0 &&
    n(orphanClaims[0]?.n) === 0 &&
    n(survivor[0]?.n) === 1 &&
    n(survivorClaimCount[0]?.n) === 4 &&
    auditRow.length === 1;
  if (!clean) {
    console.error('\nPost-conditions not met. Investigate before re-running.');
    return 1;
  }
  console.log('\nDone. Next: de-index the deleted integration object from Algolia and re-run the');
  console.log("stranded-row audit — both commands are in this directory's README.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
