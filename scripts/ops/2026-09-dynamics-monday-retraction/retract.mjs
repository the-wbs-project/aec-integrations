#!/usr/bin/env node
//
// retract.mjs — execute the AECI-795 retraction against a deployed D1: delete the
// stranded `microsoft-dynamics-365 → monday-com` integration row, plus its claim and
// attestation, write the audit row, and repair the denormalized `integration_count`
// on both endpoint products.
//
// ─── WHY THIS ROW GOES ───────────────────────────────────────────────────────
//
// Because nothing can defend it. It is the third and last row from the AECI-767
// sweep, and it is a different class from the two before it:
//
//   AECI-593 (polycam)  — a curator note recorded the editorial retraction.
//   AECI-794 (procore)  — a merge note on the SURVIVING record recorded the merge.
//   AECI-795 (this one) — NO ruling exists on either side.
//
// The edge was materialised in the 2026-07 Dynamics 365 sweep (its note lists
// "monday" among what it seeded) and is gone upstream today: D365 has 14
// integrations, none to monday.com; monday.com has 49, none to Dynamics. The review
// app suspects the AECI-700/701 Zapier-convention change — one `target=Zapier` edge
// instead of N per-pair tiles, which matches this row's `iPaaS` kind — but it
// EXPLICITLY DECLINES to assert that, because it cannot be proven from the data.
// Nothing in this script or its audit row asserts it either.
//
// So the ruling is an OPERATOR ruling taken after escalating to the catalog owner,
// which is what `docs/RUNBOOKS.md` prescribes for a stray with no recorded ruling —
// not a transcription of a curator note. Recorded on AECI-795, 2026-09-07:
// "It has no upstream record and no defence; if the edge is real it should be
// re-materialised deliberately with current evidence, not adopted from a stranded
// row." Adopting would mint an upstream record to justify a D1 row whose only
// evidence is that it exists.
//
// Promote has no delete semantics (`docs/REVIEW_APP_PROMOTE_API.md` §5.1), so
// nothing will ever update or remove this row, and a re-promote of either endpoint
// would mint a second copy beside it.
//
// ─── THE ROW THIS IS NOT ─────────────────────────────────────────────────────
//
// The single most likely operator error here is deleting the wrong `monday.com
// (ipaas)`. The upstream record that carries that NAME (`recgbcRYqUf2OvSZf`) points
// at a DIFFERENT uuid, `048952ee-…`, which is live on the unrelated
// `adp-workforce-now → monday-com` pair. That row is healthy, reachable and staying.
//
// AECI-794 asserted a positive sentinel (its reverse-orientation survivor must
// remain). There is no survivor on this pair, so this script asserts a NEGATIVE one
// instead: `048952ee-…` must still be present, still on the ADP pair, with its claim
// count unchanged. If it moves, the run refuses.
//
// ─── WHY A SCRIPT AND NOT THE DATATOOL ───────────────────────────────────────
//
// Same reason as AECI-593 and AECI-794: `POST /api/prune-integrations` is gated by
// Cloudflare Access or a `TOOL_TOKEN` bearer, and neither is provisioned in an
// operator workspace, while `CLOUDFLARE_API_TOKEN` is. Every query below is a
// transcription of `apps/datatool/src/prune-integrations.ts` — `prunePlan`
// (footprint, the three guards, affected products, rollback SQL) and `pruneExecute`
// (child→parent delete, then the AECI-721 count repair that counts
// `connector_evidenced_pairs` too). Divergence from that module is a bug HERE.
// This is the THIRD consecutive route-around; see `apps/datatool/README.md`.
//
// ─── WHY THE GUARDS TRIP, AND WHY THAT IS NOT THE EVIDENCE ───────────────────
//
// `orphansWithoutATwin` trips, and here it is a TRUE positive — there genuinely is
// no other row on this pair. `claimsUniqueToOrphans` trips for the same reason.
// `orphansRicherThanTwin` needs a twin to JOIN against, so it must read 0.
//
// That reading is still not what justifies the delete. `orphansWithoutATwin` is
// orientation-blind and `mechanism_name`-sensitive (AECI-794 is the worked example
// of it reading 1 on a row that plainly had a twin), so the guard sheet cannot
// classify a stray either way. The ruling above is what justifies it.
//
// So the script runs the direct check the guards cannot: any other `integrations`
// row whose two endpoints are these two products, in EITHER orientation. That query
// must return nothing, and the run REFUSES if it does not — the guard sheet would
// read identically either way, so enforcing it here is what holds up ACK_REASON's
// "there is no twin on this pair" and the audit row's `twin: null`.
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
//   node scripts/ops/2026-09-dynamics-monday-retraction/retract.mjs --env production
//   node scripts/ops/2026-09-dynamics-monday-retraction/retract.mjs --env production --apply --allow-production
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
 * on AECI-795 after escalating to the catalog owner.
 */
const IDS = [
  '2e6ad5bf-5590-4222-9710-23d43a625f12', // microsoft-dynamics-365 → monday-com, `iPaaS`
];

/**
 * The NEGATIVE sentinel — the unrelated row that shares this one's name. It is what
 * the surviving upstream record `recgbcRYqUf2OvSZf` actually points at, it lives on
 * the `adp-workforce-now → monday-com` pair, and it must be untouched by this run.
 * Read-only here: captured before, asserted identical after.
 */
const NOT_THIS_ROW_ID = '048952ee-15b8-4437-9146-df40061e9484';
const NOT_THIS_ROW_PAIR = 'adp-workforce-now → monday-com';

/**
 * The guards expected to trip, in `PRUNE_GUARD_NAMES` order. Exact match required —
 * this is the local equivalent of the datatool's `acknowledgeGuards`.
 */
const ACK_GUARDS = ['claimsUniqueToOrphans', 'orphansWithoutATwin'];

const ACK_REASON =
  'AECI-795: operator ruling, DELETE, taken after escalating to the catalog owner because NO ' +
  'ruling is recorded on either side. The edge was materialised in the 2026-07 Dynamics 365 ' +
  'sweep and no upstream record carries this id today, so no promote can ever reach it. The ' +
  'review app suspects the AECI-700/701 Zapier-convention change and explicitly declines to ' +
  'assert it, so no cause is claimed here. Both guards are TRUE positives — there is no twin ' +
  'on this pair — but they are not the evidence; the ruling is. The similarly named upstream ' +
  'record recgbcRYqUf2OvSZf points at 048952ee-…, a different and healthy row on the unrelated ' +
  'adp-workforce-now → monday-com pair, which this run leaves untouched. If the edge is real it ' +
  'should be re-materialised deliberately with current evidence, not adopted from a stranded row.';

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
 * outside a session. `action` is 'integration.deleted', matching the AECI-593 and
 * AECI-794 rows so the action vocabulary stays queryable.
 *
 * `metadata.suspected_cause` carries `asserted: false` deliberately. The review app
 * declined to assert the AECI-700/701 link, and an audit row is the wrong place to
 * upgrade a suspicion into a finding.
 */
function buildAuditInsert({ row, footprint, guards, claims, strandWindow, notThisRow }) {
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
    issue: 'AECI-795',
    operator: 'chrisw@thewbsproject.com',
    tool: 'scripts/ops/2026-09-dynamics-monday-retraction/retract.mjs',
    acknowledged_guards: ACK_GUARDS,
    acknowledge_reason: ACK_REASON,
    no_upstream_ruling: true,
    ruling_source: 'operator ruling on AECI-795, 2026-09-07, after escalating to the catalog owner',
    suspected_cause: {
      issues: ['AECI-700', 'AECI-701'],
      asserted: false,
      corroboration:
        "the row is a per-pair Zapier tile on its own data — mechanism_name 'Zapier connector', " +
        'listing_url and notes evidence both zapier.com/apps/microsoft-dynamics-crm/integrations/monday ' +
        '— which is exactly the shape AECI-700/701 replaces with one target=Zapier edge. Consistent ' +
        'with that cause, not proof of it: nothing records why this row went.',
    },
    // Safe as a constant: the run refuses before this point if the direct
    // both-orientations pair query returns anything.
    twin: null,
    not_this_row: {
      id: NOT_THIS_ROW_ID,
      pair: NOT_THIS_ROW_PAIR,
      upstream_record: 'recgbcRYqUf2OvSZf',
      note: 'shares the name `monday.com (ipaas)`; healthy, unrelated, untouched',
      claims_before: notThisRow.claims,
    },
    strand_window: strandWindow,
    guards,
    rollback: 'scripts/ops/2026-09-dynamics-monday-retraction/rollback.sql',
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
  const notThisPh = sqlIdList([NOT_THIS_ROW_ID]);
  console.log(
    `# AECI-795 microsoft-dynamics-365 → monday-com retraction — ${target.db} (${apply ? 'APPLY' : 'dry-run'})\n`,
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

  // Every other row on the same pair, in EITHER orientation. The guards are
  // orientation-blind, so this is the direct check the guard sheet cannot make:
  // it must come back empty for "no twin" to be true rather than merely reported.
  // Enforced below, next to the guard acknowledgment — printing it was not enough.
  const pairRows = d1(
    target,
    `SELECT i.id AS id, s.slug AS sourceSlug, t.slug AS targetSlug,
            i.mechanism_kind AS mechanismKind, i.mechanism_name AS mechanismName
       FROM integrations i
       JOIN products s ON s.id = i.source_product_id
       JOIN products t ON t.id = i.target_product_id
      WHERE i.id NOT IN (${ph})
        AND s.slug IN ('microsoft-dynamics-365','monday-com')
        AND t.slug IN ('microsoft-dynamics-365','monday-com')
      ORDER BY s.slug, t.slug`,
  );

  // The claim being destroyed, named — goes into `before_state`.
  const claimRowsNamed = d1(
    target,
    `SELECT d.slug AS dataObject, c.direction AS direction, c.origin AS origin
       FROM claims c LEFT JOIN taxonomy_data_objects d ON d.id = c.data_object_id
      WHERE c.integration_id IN (${ph}) ORDER BY d.slug`,
  );

  // The negative sentinel — the unrelated same-named row. Captured before, asserted
  // identical after.
  const [notThisRowBefore] = d1(
    target,
    `SELECT i.id AS id, s.slug AS sourceSlug, t.slug AS targetSlug, i.name AS name,
            (SELECT COUNT(*) FROM claims WHERE integration_id = i.id) AS claims
       FROM integrations i
       LEFT JOIN products s ON s.id = i.source_product_id
       LEFT JOIN products t ON t.id = i.target_product_id
      WHERE i.id IN (${notThisPh})`,
  );
  if (!notThisRowBefore) {
    console.error(
      `\nThe unrelated same-named row ${NOT_THIS_ROW_ID} is not present in ${target.db}.\n` +
        'That is not the state this ruling was made against. Refusing.',
    );
    return 1;
  }
  const notThisRow = {
    id: String(notThisRowBefore.id),
    sourceSlug: String(notThisRowBefore.sourceSlug),
    targetSlug: String(notThisRowBefore.targetSlug),
    claims: n(notThisRowBefore.claims),
  };

  // The strand window — `audit_log.entity_id` carries no FK, so the promote history
  // of this row survives its deletion and is readable now.
  const auditHistory = d1(
    target,
    `SELECT action, COUNT(*) AS n, MIN(created_at) AS firstAt, MAX(created_at) AS lastAt
       FROM audit_log WHERE entity_id IN (${ph}) GROUP BY action ORDER BY action`,
  );
  const lastTouch = auditHistory
    .map((r) => String(r.lastAt ?? ''))
    .filter(Boolean)
    .sort()
    .pop();
  const strandWindow = {
    createdAt: rows[0]?.createdAt ?? null,
    lastAuditedAt: lastTouch ?? null,
    auditRowsBefore: auditHistory.reduce((sum, r) => sum + n(r.n), 0),
    note: 'audit_log.entity_id has no FK, so these rows survive the delete',
  };

  console.log('\nfootprint:', footprint);
  console.log('guards:   ', guards);
  console.log('blocked:  ', blocked);
  console.log('acked:    ', ACK_GUARDS);
  console.table(affected);
  console.log('\nclaims being deleted:');
  console.table(claimRowsNamed);
  console.log(`other rows on this pair, either orientation (expect NONE): ${pairRows.length}`);
  if (pairRows.length) console.table(pairRows);
  console.log('\nNOT this row — the unrelated same-named edge, must be untouched:');
  console.table([notThisRow]);
  console.log('\naudit_log history for this id (survives the delete):');
  console.table(auditHistory);

  // ─── Rollback SQL (written on the dry run too — D1 has no undo) ─────────────
  const integrationRows = d1(target, `SELECT * FROM integrations WHERE id IN (${ph}) ORDER BY id`);
  const claimRows = d1(target, `SELECT * FROM claims WHERE integration_id IN (${ph}) ORDER BY id`);
  const attestationRows = d1(
    target,
    `SELECT * FROM attestations
      WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph})) ORDER BY id`,
  );
  const rollbackSql = [
    '-- Rollback for the AECI-795 microsoft-dynamics-365 → monday-com retraction.',
    '-- Replay order is parent -> child so the FKs hold; INSERT OR IGNORE makes re-runs safe.',
    `-- integrations: ${integrationRows.length}, claims: ${claimRows.length}, attestations: ${attestationRows.length}`,
    '-- `claims.anchor_id` is omitted on purpose: it is a STORED generated column (AECI-721)',
    '-- and SQLite refuses an INSERT that supplies it.',
    '-- Recreating the rows does NOT restore integration_count: re-run',
    '--   RECONCILE_ENV=<env> pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production',
    '-- and note that replaying this recreates the STRANDED state, not curator control —',
    '-- no upstream record has ever carried this uuid, so there is nothing to restore it to.',
    '-- If the edge turns out to be real, re-materialise it upstream with current evidence',
    '-- and promote it, rather than replaying this file.',
    ...integrationRows.map((r) => toInsert('integrations', r)),
    ...claimRows.map((r) => toInsert('claims', r)),
    ...attestationRows.map((r) => toInsert('attestations', r)),
    '',
  ].join('\n');
  const rollbackPath = join(HERE, 'rollback.sql');
  writeFileSync(rollbackPath, rollbackSql);
  console.log(`\nrollback written: ${rollbackPath}`);

  // ─── The direct twin check, enforced ───────────────────────────────────────
  // `orphansWithoutATwin` cannot tell "only copy" from "reverse-orientation duplicate",
  // and it is `mechanism_name`-sensitive, so it reads 1 in BOTH cases (AECI-794 is the
  // worked example). That means the guard sheet below would pass unchanged if a twin
  // appeared, while ACK_REASON and `metadata.twin` both assert there is none. This is
  // the check that actually holds that assertion up, so it refuses rather than reports.
  if (pairRows.length) {
    console.error(
      `\n${pairRows.length} row(s) survive on this pair in some orientation.\n` +
        'The AECI-795 ruling was made against a pair with no twin, and the audit row would\n' +
        'record `twin: null`. That is not the state this ruling was made against. Refusing.',
    );
    return 1;
  }

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
    strandWindow,
    notThisRow,
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
  // pre-AECI-721 answer back over a correct count. `powered_by_product_id` is NOT in
  // the expression, matching `computeExpected` in `apps/api/src/lib/recompute-counts.ts`
  // — a connector's own count comes from `connector_evidenced_pairs`, never from the
  // `integrations` rows it powers.
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
  const [notThisRowAfter] = d1(
    target,
    `SELECT i.id AS id, s.slug AS sourceSlug, t.slug AS targetSlug,
            (SELECT COUNT(*) FROM claims WHERE integration_id = i.id) AS claims
       FROM integrations i
       LEFT JOIN products s ON s.id = i.source_product_id
       LEFT JOIN products t ON t.id = i.target_product_id
      WHERE i.id IN (${notThisPh})`,
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
  console.log('NOT this row, after:');
  console.table(notThisRowAfter ? [notThisRowAfter] : []);
  const sentinelIntact =
    !!notThisRowAfter &&
    String(notThisRowAfter.sourceSlug) === notThisRow.sourceSlug &&
    String(notThisRowAfter.targetSlug) === notThisRow.targetSlug &&
    n(notThisRowAfter.claims) === notThisRow.claims;
  console.log(
    `integrations left: ${n(leftovers[0]?.n)}, claims left: ${n(orphanClaims[0]?.n)}, ` +
      `sentinel intact: ${sentinelIntact}`,
  );

  const clean =
    n(leftovers[0]?.n) === 0 &&
    n(orphanClaims[0]?.n) === 0 &&
    sentinelIntact &&
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
