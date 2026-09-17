#!/usr/bin/env node
//
// AECI-996 — re-anchor claims on connector-evidenced pairs whose stored A/B order is the
// reverse of the integration's source → target.
//
// ─── THE DEFECT ───────────────────────────────────────────────────────────────
//
// `connector_evidenced_pairs` stores `product_a_id < product_b_id`. A claim's direction and
// its attestations' `vendor_a` / `vendor_b` slots are read against that A/B. Until the
// AECI-996 fix every write path copied them across from the payload's source → target
// unchanged, so on a pair whose source sorts second every one-way claim pointed backwards
// and every vendor slot named the other endpoint's vendor.
//
// ─── THE SOURCE END NEVER COMES FROM THE PAIR ROW ─────────────────────────────
//
// The pair row cannot say which endpoint was the source: that fact is the thing it threw
// away. Operator ruling on AECI-996: derive it from
//
//   1. the review app's integration record (`sourceProduct`, matched on `supabaseId`), or
//   2. the pair's `integration.created` / `connector_evidenced_pair.created` audit row,
//      when that row's state names a source product.
//
// When both answer and disagree, the pair is a CONFLICT and is skipped. When neither
// answers, it is UNRESOLVED and is skipped. Both are listed.
//
// ─── IDEMPOTENT TWO WAYS ──────────────────────────────────────────────────────
//
//   - It writes its own audit rows (`claim.reframed` / `attestation.reframed`, metadata
//     `source = 'ops-repair-aeci-996'`). A pair holding any reframe audit row, from this
//     script or from a post-deploy promote move, is skipped whole. Every generated UPDATE
//     is guarded on its own op key as well.
//   - It skips any claim updated after the deploy timestamp. Those rows were written by
//     the fixed code and are already in the pair's frame. The default timestamp is the
//     commit that added the fix to `origin/main`, which is never later than any
//     environment's deploy of it, so an error here SKIPS a claim rather than flipping a
//     correct one back. Skipped claims are listed.
//
// The flip itself is `planClaimReframe` from apps/api/src/lib/claim-frame.ts, imported
// directly (Node type stripping) — the same planner promote runs, so this repair and the
// code path that prevents a recurrence cannot drift.
//
// ─── USAGE ───────────────────────────────────────────────────────────────────
//
// Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and AECI_MCP_TOKEN.
//
//   node scripts/ops/2026-09-evidenced-claim-direction-repair/repair.mjs --env production
//   node scripts/ops/2026-09-evidenced-claim-direction-repair/repair.mjs --env production --apply --allow-production
//
// Flags: --env <preview|staging|demo|production>  --apply  --allow-production
//        --deployed-at <ISO timestamp>  (overrides the git-derived default)

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planClaimReframe,
  reframeOpAudit,
  renderReframeSql,
} from '../../../apps/api/src/lib/claim-frame.ts';
import { listAll, openMcpSession } from './mcp-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const WRANGLER = join(ROOT, 'apps', 'api', 'node_modules', '.bin', 'wrangler');
const CONFIG = join(ROOT, 'apps', 'api', 'wrangler.jsonc');
const FIX_FILE = 'apps/api/src/lib/claim-frame.ts';
const SOURCE_TAG = 'ops-repair-aeci-996';
const MCP_CONCURRENCY = 4;

// ─── args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const env = value('--env');
const apply = flag('--apply');
const allowProduction = flag('--allow-production');
if (!['preview', 'staging', 'demo', 'production'].includes(env ?? '')) {
  console.error(
    'usage: repair.mjs --env <preview|staging|demo|production> [--apply] [--allow-production] [--deployed-at <ISO>]',
  );
  process.exit(2);
}
if (env === 'production' && apply && !allowProduction) {
  console.error('REFUSING: production writes need --allow-production.');
  process.exit(1);
}

function gitFixTimestamp() {
  execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: ROOT });
  const out = execFileSync(
    'git',
    ['log', 'origin/main', '--diff-filter=A', '--format=%cI', '--', FIX_FILE],
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  if (!out) {
    console.error(
      `REFUSING: ${FIX_FILE} is not on origin/main, so the fix has not merged and no environment runs it.`,
    );
    process.exit(1);
  }
  return new Date(out.split('\n').at(-1)).toISOString();
}

const deployedAtArg = value('--deployed-at');
if (deployedAtArg !== undefined && Number.isNaN(Date.parse(deployedAtArg))) {
  console.error(`--deployed-at is not a timestamp: ${deployedAtArg}`);
  process.exit(2);
}
const deployedAt = deployedAtArg ? new Date(deployedAtArg).toISOString() : gitFixTimestamp();

// ─── D1 ──────────────────────────────────────────────────────────────────────

/** Read via `--command`. `--file` returns an import summary and no rows. */
function readD1(sql) {
  const out = execFileSync(
    WRANGLER,
    [
      'd1',
      'execute',
      `aeci-app-${env}`,
      '--env',
      env,
      '--remote',
      '--json',
      '--config',
      CONFIG,
      '--command',
      sql,
    ],
    { cwd: join(ROOT, 'apps', 'api'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d+Z$/, 'Z');
const outDir = join(HERE, 'backups', `${stamp}-${env}`);
mkdirSync(outDir, { recursive: true });

console.log(`== target: aeci-app-${env}`);
console.log(`   mode:   ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(
  `   skip claims updated after: ${deployedAt}${deployedAtArg ? '' : ' (fix commit on origin/main)'}`,
);

const pairs = readD1(`
  SELECT p.id, p.product_a_id, p.product_b_id, pa.slug AS a_slug, pb.slug AS b_slug
  FROM connector_evidenced_pairs p
  JOIN products pa ON pa.id = p.product_a_id
  JOIN products pb ON pb.id = p.product_b_id
  WHERE p.id IN (SELECT connector_evidenced_pair_id FROM claims WHERE connector_evidenced_pair_id IS NOT NULL)`);
const claimRows = readD1(`
  SELECT c.id, c.connector_evidenced_pair_id AS pair_id, c.data_object_id, d.slug AS data_object_slug,
         c.direction, c.origin, c.created_by_vendor_id, c.created_at, c.updated_at
  FROM claims c JOIN taxonomy_data_objects d ON d.id = c.data_object_id
  WHERE c.connector_evidenced_pair_id IS NOT NULL`);
const attestationRows = readD1(`
  SELECT a.id, a.claim_id, a.source, a.retracted_at, a.asserted, a.introduced_at, a.deprecated_at,
         a.introduced_version_id, a.deprecated_version_id, a.attested_by_vendor_id, a.note, a.created_at
  FROM attestations a JOIN claims c ON c.id = a.claim_id
  WHERE c.connector_evidenced_pair_id IS NOT NULL`);
const creationAudits = readD1(`
  SELECT entity_id, action, before_state, after_state, created_at FROM audit_log
  WHERE action IN ('integration.created', 'connector_evidenced_pair.created')
    AND entity_id IN (SELECT connector_evidenced_pair_id FROM claims WHERE connector_evidenced_pair_id IS NOT NULL)`);
// ANY reframe audit row, not only this script's: a promote cross-table move after the
// deploy re-anchors a pair's claims too, and on a `both` claim it touches only attestation
// slots, which leaves the claim's `updated_at` alone. The deploy-timestamp rule alone would
// flip those slots back.
const priorReframes = readD1(`
  SELECT DISTINCT entity_type, entity_id FROM audit_log
  WHERE action IN ('claim.reframed', 'attestation.reframed')`);
writeFileSync(
  join(outDir, 'snapshot.json'),
  `${JSON.stringify({ deployedAt, pairs, claimRows, attestationRows, creationAudits, priorReframes }, null, 2)}\n`,
);

// ─── source end: the review app ──────────────────────────────────────────────

const pairIds = new Set(pairs.map((p) => p.id));
const session = await openMcpSession();
const { rows: upstreamIntegrations } = await listAll(session, 'list_integrations');
const upstreamByPair = new Map(
  upstreamIntegrations
    .filter((r) => r.supabaseId && pairIds.has(r.supabaseId))
    .map((r) => [r.supabaseId, r]),
);
const productUuid = new Map();
{
  const { rows } = await listAll(session, 'list_products');
  for (const row of rows) if (row.supabaseId) productUuid.set(row.id, row.supabaseId);
  const missing = [
    ...new Set(
      [...upstreamByPair.values()]
        .flatMap((r) => [r.sourceProduct?.id, r.targetProduct?.id])
        .filter((id) => id && !productUuid.has(id)),
    ),
  ];
  for (let i = 0; i < missing.length; i += MCP_CONCURRENCY) {
    await Promise.all(
      missing.slice(i, i + MCP_CONCURRENCY).map(async (recId) => {
        const p = await session.callTool('get_product', { record_id: recId });
        productUuid.set(recId, p.supabaseId ?? null);
      }),
    );
  }
}

// ─── source end: the creation audit row ──────────────────────────────────────

function auditSource(pairId) {
  for (const row of creationAudits.filter((r) => r.entity_id === pairId)) {
    for (const raw of [row.after_state, row.before_state]) {
      if (!raw) continue;
      try {
        const state = JSON.parse(raw);
        const id = state?.sourceProductId ?? state?.source_product_id;
        if (typeof id === 'string') return id;
      } catch {
        // Not JSON: no answer from this row.
      }
    }
  }
  return null;
}

// ─── plan ────────────────────────────────────────────────────────────────────

const reframedIds = new Set(priorReframes.map((r) => `${r.entity_type}:${r.entity_id}`));
const claimsByPair = new Map();
for (const c of claimRows) {
  const list = claimsByPair.get(c.pair_id) ?? [];
  list.push(c);
  claimsByPair.set(c.pair_id, list);
}
const attestationsByClaim = new Map();
for (const a of attestationRows) {
  const list = attestationsByClaim.get(a.claim_id) ?? [];
  list.push(a);
  attestationsByClaim.set(a.claim_id, list);
}
const toReframeClaim = (c) => ({
  id: c.id,
  dataObjectId: c.data_object_id,
  direction: c.direction,
  origin: c.origin,
  createdByVendorId: c.created_by_vendor_id,
  createdAt: c.created_at,
  attestations: (attestationsByClaim.get(c.id) ?? []).map((a) => ({
    id: a.id,
    claimId: a.claim_id,
    source: a.source,
    retractedAt: a.retracted_at,
    asserted: a.asserted === 1 || a.asserted === true,
    introducedAt: a.introduced_at,
    deprecatedAt: a.deprecated_at,
    introducedVersionId: a.introduced_version_id,
    deprecatedVersionId: a.deprecated_version_id,
    attestedByVendorId: a.attested_by_vendor_id,
    note: a.note,
    createdAt: a.created_at,
  })),
});
const isOneWay = (d) => d === 'a_to_b' || d === 'b_to_a';

const report = {
  pairsWithClaims: pairs.length,
  oneWayClaimsOnPairs: claimRows.filter((c) => isOneWay(c.direction)).length,
  notReversed: [],
  reversed: [],
  unresolved: [],
  conflicts: [],
  endpointsDiffer: [],
  alreadyRepaired: [],
  skippedUpdatedAfterDeploy: [],
  blockedByPostDeployClaim: [],
  collisions: [],
};
const now = new Date().toISOString();
const forward = [];
const rollback = [];
let oneWayOnReversed = 0;
let opCount = 0;

for (const pair of [...pairs].sort((a, b) => a.id.localeCompare(b.id))) {
  const label = `${pair.a_slug} <> ${pair.b_slug} (${pair.id})`;
  const up = upstreamByPair.get(pair.id);
  const reviewSource = up ? (productUuid.get(up.sourceProduct?.id) ?? null) : null;
  const reviewTarget = up ? (productUuid.get(up.targetProduct?.id) ?? null) : null;
  const fromAudit = auditSource(pair.id);
  if (reviewSource && fromAudit && reviewSource !== fromAudit) {
    report.conflicts.push({ pair: label, reviewApp: reviewSource, auditRow: fromAudit });
    continue;
  }
  const source = reviewSource ?? fromAudit;
  const via = reviewSource ? 'review-app' : fromAudit ? 'audit-row' : null;
  if (!source) {
    report.unresolved.push(label);
    continue;
  }
  const ends = new Set([pair.product_a_id, pair.product_b_id]);
  if (!ends.has(source) || (reviewTarget && !ends.has(reviewTarget))) {
    report.endpointsDiffer.push({ pair: label, source, target: reviewTarget, via });
    continue;
  }
  const pairClaims = claimsByPair.get(pair.id) ?? [];
  if (source === pair.product_a_id) {
    report.notReversed.push(label);
    continue;
  }
  oneWayOnReversed += pairClaims.filter((c) => isOneWay(c.direction)).length;
  const alreadyReframed = pairClaims.some(
    (c) =>
      reframedIds.has(`claim:${c.id}`) ||
      (attestationsByClaim.get(c.id) ?? []).some((a) => reframedIds.has(`attestation:${a.id}`)),
  );
  if (alreadyReframed) {
    report.alreadyRepaired.push(label);
    continue;
  }

  const late = pairClaims.filter((c) => c.updated_at > deployedAt);
  let eligible = pairClaims.filter((c) => c.updated_at <= deployedAt);
  for (const c of late) {
    report.skippedUpdatedAfterDeploy.push({
      pair: label,
      claimId: c.id,
      dataObject: c.data_object_slug,
      direction: c.direction,
      origin: c.origin,
      updatedAt: c.updated_at,
    });
  }
  // A pre-deploy claim whose flip lands on a post-deploy claim's identity would collide
  // with a row this run must not touch. Both say the same thing in different frames;
  // that is a curation call, so list it and leave both.
  const blocked = eligible.filter(
    (c) =>
      isOneWay(c.direction) &&
      late.some(
        (l) =>
          l.data_object_id === c.data_object_id &&
          l.direction !== c.direction &&
          isOneWay(l.direction),
      ),
  );
  for (const c of blocked) {
    report.blockedByPostDeployClaim.push({
      pair: label,
      claimId: c.id,
      dataObject: c.data_object_slug,
      direction: c.direction,
    });
  }
  eligible = eligible.filter((c) => !blocked.includes(c));

  const plan = planClaimReframe(eligible.map(toReframeClaim));
  if (!plan.ops.length) continue;
  report.reversed.push({
    pair: label,
    via,
    oneWayClaims: eligible.filter((c) => isOneWay(c.direction)).length,
    ops: plan.ops.length,
  });
  const slugOf = new Map(pairClaims.map((c) => [c.id, c.data_object_slug]));
  for (const collision of plan.collisions) {
    report.collisions.push(
      collision.kind === 'claim'
        ? {
            pair: label,
            kind: 'claim',
            dataObject: slugOf.get(collision.claimIds[0]),
            claimIds: collision.claimIds,
          }
        : {
            pair: label,
            kind: 'attestation',
            dataObject: slugOf.get(collision.claimId),
            claimId: collision.claimId,
            attestationIds: collision.attestationIds,
          },
    );
  }

  const emit = (ops, sink, tag) => {
    renderReframeSql(ops, now).forEach((updateSql, i) => {
      const op = ops[i];
      const audit = reframeOpAudit(op);
      const opKey = `${tag}:${pair.id}:${i}`;
      const guard =
        `NOT EXISTS (SELECT 1 FROM audit_log WHERE entity_type = ${lit(audit.entityType)} ` +
        `AND entity_id = ${lit(audit.entityId)} AND json_extract(metadata, '$.opKey') = ${lit(opKey)})`;
      const metadata = {
        source: tag,
        runId: stamp,
        pairId: pair.id,
        opKey,
        sourceEnd: via,
        deployedAt,
      };
      sink.push(`${updateSql.replace(/;$/, '')} AND ${guard};`);
      sink.push(
        'INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, created_at) ' +
          `SELECT ${lit(randomUUID())}, NULL, 'system', ${lit(audit.action)}, ${lit(audit.entityType)}, ${lit(audit.entityId)}, ` +
          `${lit(JSON.stringify(audit.beforeState))}, ${lit(JSON.stringify(audit.afterState))}, ${lit(JSON.stringify(metadata))}, ${lit(now)} ` +
          `WHERE ${guard};`,
      );
    });
  };
  emit(plan.ops, forward, SOURCE_TAG);
  // The flip is its own inverse, so the rollback is the planner run on its own output.
  emit(planClaimReframe(plan.after).ops, rollback, `${SOURCE_TAG}-rollback`);
  opCount += plan.ops.length;
}

// ─── report ──────────────────────────────────────────────────────────────────

const summary = {
  pairsWithClaims: report.pairsWithClaims,
  oneWayClaimsOnPairs: report.oneWayClaimsOnPairs,
  oneWayClaimsOnReversedPairs: oneWayOnReversed,
  pairsNotReversed: report.notReversed.length,
  pairsToRepair: report.reversed.length,
  opsToWrite: opCount,
  collisions: report.collisions.length,
  unresolved: report.unresolved.length,
  conflicts: report.conflicts.length,
  endpointsDiffer: report.endpointsDiffer.length,
  alreadyRepaired: report.alreadyRepaired.length,
  skippedUpdatedAfterDeploy: report.skippedUpdatedAfterDeploy.length,
  blockedByPostDeployClaim: report.blockedByPostDeployClaim.length,
};
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ summary, ...report }, null, 2)}\n`);
const header = `-- AECI-996 evidenced-pair claim reframe, run ${stamp}, env ${env}\n-- applied with \`wrangler d1 execute --file\` (atomic D1 import)\n`;
writeFileSync(join(outDir, 'repair.sql'), `${header}${forward.join('\n')}\n`);
writeFileSync(join(outDir, 'rollback.sql'), `${header}${rollback.join('\n')}\n`);

console.log('\n-- summary --');
console.table(summary);
const list = (title, rows) => {
  if (!rows.length) return;
  console.log(`\n-- ${title} (${rows.length}) --`);
  for (const row of rows) console.log(`  ${typeof row === 'string' ? row : JSON.stringify(row)}`);
};
list('collisions (resolved by swapping contents)', report.collisions);
list('pairs to repair', report.reversed);
list('unresolved: no review-app record and no usable audit row', report.unresolved);
list('conflicts: review app and audit row disagree', report.conflicts);
list('endpoints differ from the pair row', report.endpointsDiffer);
list('already repaired', report.alreadyRepaired);
list('skipped: claim updated after the deploy timestamp', report.skippedUpdatedAfterDeploy);
list('blocked: flip would land on a post-deploy claim', report.blockedByPostDeployClaim);
console.log(`\n   artifacts: ${outDir}/{snapshot.json,report.json,repair.sql,rollback.sql}`);

if (!apply) {
  console.log('\nDRY-RUN — nothing written.');
  process.exit(0);
}
if (!forward.length) {
  console.log('\nNothing to write.');
  process.exit(0);
}

console.log('\n-- applying repair.sql --');
execFileSync(
  WRANGLER,
  [
    'd1',
    'execute',
    `aeci-app-${env}`,
    '--env',
    env,
    '--remote',
    '--config',
    CONFIG,
    '--file',
    join(outDir, 'repair.sql'),
  ],
  { cwd: join(ROOT, 'apps', 'api'), stdio: 'inherit' },
);
const written = readD1(`
  SELECT action, COUNT(*) AS n FROM audit_log
  WHERE json_extract(metadata, '$.runId') = '${stamp}' AND json_extract(metadata, '$.source') = '${SOURCE_TAG}'
  GROUP BY action`);
console.log('\n-- audit rows written by this run --');
console.table(written);
console.log(
  '\nDONE. Re-run the dry run: every repaired pair should now list under "already repaired".',
);
