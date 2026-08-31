#!/usr/bin/env node
//
// audit.mjs — find prod integrations whose review-app source row carries a
// `powered_by` but whose D1 row has `powered_by_product_id` NULL, and classify each
// one by whether it is actually safe to backfill (AECI-706).
//
// STRICTLY READ-ONLY. There is no --apply flag and no write path: SELECTs against D1,
// read-only MCP tools against the review app (mcp-client.mjs enforces the allow-list).
// The write lives in backfill.sh, which consumes this script's --json report.
//
// ─── WHY THE FK IS NULL ───────────────────────────────────────────────────────
//
// The promote ingest resolves the FK through `resolveProduct` (promote.ts), which
// returns null when the referenced connector is not in D1 yet:
//
//     const poweredByProductId = intg.poweredByProduct
//       ? await resolveProduct(intg.poweredByProduct)
//       : null;
//
// Unlike the endpoint path twenty lines above it — which pushes a `skipped[]` entry
// and abandons the row — an unresolvable powered-by is dropped SILENTLY: no
// `skipped[]`, no `staleSupabaseIds`, no metric. The integration is still written,
// just without its connector. §3.4 of docs/REVIEW_APP_PROMOTE_API.md constrains only
// the two ENDPOINTS ("the other endpoint must already be promoted"); it says nothing
// about the connector, and that silence is the ordering gap.
//
// This matters now because the FK is the ROUTING KEY for the powered-edge migration:
// an edge with a NULL powered_by cannot be migrated to "via {connector}".
//
// ─── WHY THIS IS NOT A ONE-LINE `UPDATE … WHERE powered_by IS NULL` ───────────
//
// Because a NULL FK is not the only way prod can be behind upstream. The AECI-671
// connector-normalisation sweep (2026-08-27) also re-typed `mechanism_kind`
// native→iPaaS, SWAPPED source/target on Kroo's rows, and regenerated names; AECI-698
// re-typed the Agave rows. A row that is stale on orientation as well as on the FK
// would get a CORRECT routing key written onto a BACKWARDS edge — worse than the NULL
// it replaces, and invisible afterwards.
//
// So the sweep classifies on full-row congruence over the fields promote owns, and
// only `backfillable` (FK is the ONLY difference) is safe for a D1 write. `divergent`
// rows are a re-promote's job, and backfill.sh refuses to run while any exist.
//
// ─── BUCKETS ─────────────────────────────────────────────────────────────────
//
//   backfillable        upstream FK set; edge in prod; connector in prod; prod FK
//                       NULL; every other promote-owned field already matches.
//                       → safe to UPDATE. This is backfill.sh's cohort.
//   divergent           as above, but name/mechanism_kind/direction/endpoints also
//                       differ. → re-promote the endpoint product; never poke.
//   connectorUnpromoted upstream FK set, edge in prod, connector NOT promoted.
//                       → blocked by the on_hold decision (Zapier/Workato et al).
//   edgeUnpromoted      upstream powered edge has no prod row at all.
//                       → needs a promote, not a backfill.
//   mismatch            prod FK is set but points somewhere other than upstream.
//                       → investigate by hand; never auto-corrected.
//
// ONLY `--env production` IS MEANINGFUL, for the same reason the strand audit says so:
// the review app holds PRODUCTION uuids in its `supabase*` fields — there is one
// curation base, not one per tier — so pointing this at staging/demo/preview compares
// those ids against an unrelated seeded catalog and reports near-total mismatch.
//
// USAGE (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + AECI_MCP_TOKEN):
//   node scripts/ops/2026-08-powered-by-backfill/audit.mjs
//   node scripts/ops/2026-08-powered-by-backfill/audit.mjs --json --out report.json
//
// Exits 0 when there is nothing to do, 1 when any bucket is non-empty, 2 on a
// usage/credential error.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listAll, mapWithConcurrency, openMcpSession } from './mcp-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const WRANGLER = join(ROOT, 'apps', 'api', 'node_modules', '.bin', 'wrangler');
const CONFIG = join(ROOT, 'apps', 'api', 'wrangler.jsonc');

const ENVS = ['preview', 'staging', 'demo', 'production'];
const BUCKETS = ['backfillable', 'divergent', 'mismatch', 'connectorUnpromoted', 'edgeUnpromoted'];
// Read concurrency against the review app. get_product responses are large (~75KB);
// eight in flight keeps the sweep quick without hammering the curation DB.
const MCP_CONCURRENCY = 8;

// ─── args ────────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    'usage: audit.mjs [--env <preview|staging|demo|production>] [--json] [--out <path>]',
  );
  process.exit(2);
}

let env = 'production';
let asJson = false;
let outPath = null;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--env') env = process.argv[++i];
  else if (arg.startsWith('--env=')) env = arg.slice('--env='.length);
  else if (arg === '--json') asJson = true;
  else if (arg === '--out') outPath = process.argv[++i];
  else if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length);
  else if (arg === '-h' || arg === '--help') usage();
  else usage(`unknown arg: ${arg}`);
}
if (!ENVS.includes(env)) usage(`--env must be one of ${ENVS.join(' | ')}`);
if (env !== 'production') {
  console.error(
    `warning: --env ${env} — the review app holds PRODUCTION uuids (one curation base\n` +
      `         for all tiers), so every bucket below will be noise. Only\n` +
      `         --env production is a real audit.\n`,
  );
}

// ─── readers ─────────────────────────────────────────────────────────────────

/** Run one SELECT against the deployed D1 and return its rows. */
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
    { cwd: join(ROOT, 'apps', 'api'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // wrangler prints its banner on stderr, but a stray line on stdout would break
  // JSON.parse — slice from the first bracket rather than trusting the whole buffer.
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

// ─── congruence ──────────────────────────────────────────────────────────────

/**
 * Fields promote owns and would rewrite. Compared only where upstream holds a
 * non-null value, because `integrationEditableData` runs the payload through
 * `compact()` — an omitted field leaves the stored value untouched, so a null
 * upstream field is not evidence of drift.
 */
function fieldDifferences(upstream, d1Row, endpointUuid) {
  const diffs = [];
  const cmp = (field, want, got) => {
    if (want === null || want === undefined) return;
    if (String(want) !== String(got ?? '')) diffs.push({ field, upstream: want, prod: got });
  };
  cmp('name', upstream.name, d1Row.name);
  cmp('mechanism_kind', upstream.mechanismKind, d1Row.mechanism_kind);
  cmp('direction', upstream.direction, d1Row.direction);
  // Endpoints are always sent by the review app, so a mismatch here is real drift —
  // and it is the one that makes a bare FK write dangerous (AECI-671 swapped Kroo's).
  cmp('source_product_id', endpointUuid(upstream.sourceProduct?.id), d1Row.source_product_id);
  cmp('target_product_id', endpointUuid(upstream.targetProduct?.id), d1Row.target_product_id);
  return diffs;
}

// ─── sweep ───────────────────────────────────────────────────────────────────

const session = await openMcpSession();

// 1. Every upstream integration, filtered to those carrying a powered_by. This total
//    is the number the issue asks us to reconcile against ("326 powered edges").
const { rows: allUpstream, total: upstreamTotal } = await listAll(session, 'list_integrations');
const upstreamPowered = allUpstream.filter((r) => r.poweredByProduct?.id);

// 2. Resolve each distinct connector rec id to its D1 uuid. get_product is the only
//    tool that exposes `supabaseId`; list_products does not.
const productCache = new Map();
async function resolveProduct(recId) {
  if (!recId) return null;
  if (!productCache.has(recId)) {
    const p = await session.callTool('get_product', { record_id: recId });
    productCache.set(recId, {
      recId,
      name: p.name,
      supabaseId: p.supabaseId ?? null,
      supabaseSlug: p.supabaseSlug ?? null,
      promotionStatus: p.promotionStatus ?? null,
      productRole: p.productRole ?? null,
    });
  }
  return productCache.get(recId);
}

const connectorRecIds = [...new Set(upstreamPowered.map((r) => r.poweredByProduct.id))];
await mapWithConcurrency(connectorRecIds, MCP_CONCURRENCY, resolveProduct);

// 3. Prod side.
const d1Integrations = new Map(
  readD1(
    `SELECT id, name, mechanism_kind, direction, source_product_id, target_product_id,
            powered_by_product_id
     FROM integrations`,
  ).map((r) => [r.id, r]),
);
const d1Products = new Map(
  readD1(`SELECT id, slug, product_role FROM products`).map((r) => [r.id, r]),
);

// 4. Classify. Candidates are resolved lazily so the expensive endpoint lookups only
//    happen for rows that could actually be written.
const buckets = Object.fromEntries(BUCKETS.map((b) => [b, []]));
const candidates = [];
let alreadyCorrect = 0;

for (const up of upstreamPowered) {
  const connector = productCache.get(up.poweredByProduct.id);
  const entry = {
    integrationId: up.supabaseId ?? null,
    upstreamId: up.id,
    name: up.name ?? null,
    connector: { recId: connector.recId, name: connector.name, productId: connector.supabaseId },
  };

  const d1Row = up.supabaseId ? d1Integrations.get(up.supabaseId) : undefined;
  if (!d1Row) {
    buckets.edgeUnpromoted.push({ ...entry, reason: 'no prod row for this upstream edge' });
    continue;
  }
  if (!connector.supabaseId || !d1Products.has(connector.supabaseId)) {
    buckets.connectorUnpromoted.push({
      ...entry,
      reason: `connector "${connector.name}" is ${connector.promotionStatus ?? 'unpromoted'}`,
    });
    continue;
  }
  if (d1Row.powered_by_product_id) {
    if (d1Row.powered_by_product_id === connector.supabaseId) {
      alreadyCorrect++;
    } else {
      buckets.mismatch.push({
        ...entry,
        prodPoweredBy: d1Row.powered_by_product_id,
        prodPoweredBySlug: d1Products.get(d1Row.powered_by_product_id)?.slug ?? null,
      });
    }
    continue; // prod already holds a value — nothing for a backfill to write
  }
  candidates.push({ up, d1Row, connector, entry });
}

// Endpoint rec→uuid, for candidates only.
const endpointRecIds = [
  ...new Set(
    candidates.flatMap((c) => [c.up.sourceProduct?.id, c.up.targetProduct?.id]).filter(Boolean),
  ),
];
await mapWithConcurrency(endpointRecIds, MCP_CONCURRENCY, resolveProduct);
const endpointUuid = (recId) => productCache.get(recId)?.supabaseId ?? null;

for (const { up, d1Row, connector, entry } of candidates) {
  const diffs = fieldDifferences(up, d1Row, endpointUuid);
  const enriched = {
    ...entry,
    connectorSlug: d1Products.get(connector.supabaseId)?.slug ?? null,
    sourceSlug: d1Products.get(d1Row.source_product_id)?.slug ?? null,
    targetSlug: d1Products.get(d1Row.target_product_id)?.slug ?? null,
  };
  if (diffs.length > 0) buckets.divergent.push({ ...enriched, differences: diffs });
  else buckets.backfillable.push(enriched);
}

// ─── report ──────────────────────────────────────────────────────────────────

const dirty = BUCKETS.some((b) => buckets[b].length > 0);
// Every upstream powered edge must land in exactly one of: already correct, or one of
// the five buckets. If this ever fails, a class of row is being dropped on the floor
// and the "nothing to do" verdict cannot be trusted — so it is reported, not assumed.
const accounted = alreadyCorrect + BUCKETS.reduce((n, b) => n + buckets[b].length, 0);
const prodPoweredRows = [...d1Integrations.values()].filter((r) => r.powered_by_product_id).length;

const report = {
  env,
  database: `aeci-app-${env}`,
  source: 'review-app MCP (list_integrations + get_product)',
  // Stamped by the caller's clock, not by anything in the data — this is a snapshot.
  measuredAt: new Date().toISOString(),
  upstreamIntegrations: upstreamTotal,
  upstreamPowered: upstreamPowered.length,
  prodIntegrations: d1Integrations.size,
  prodPowered: prodPoweredRows,
  alreadyCorrect,
  // Prod rows carrying an FK that the upstream powered set does not cover at all —
  // upstream cleared a powered_by, or the row is unreachable from the review app.
  prodPoweredNotUpstream: prodPoweredRows - alreadyCorrect,
  accounted,
  reconciles: accounted === upstreamPowered.length,
  clean: !dirty,
  counts: Object.fromEntries(BUCKETS.map((b) => [b, buckets[b].length])),
  buckets,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(`\npowered_by backfill audit — aeci-app-${env} vs the review app`);
  console.log(`measured ${report.measuredAt}\n`);
  console.log(
    `upstream integrations ${report.upstreamIntegrations}, of which powered ${report.upstreamPowered}`,
  );
  console.log(
    `prod integrations     ${report.prodIntegrations}, of which powered ${report.prodPowered}`,
  );
  console.log(
    `  of the powered upstream edges, ${report.alreadyCorrect} already correct in prod` +
      (report.prodPoweredNotUpstream > 0
        ? `; ${report.prodPoweredNotUpstream} prod FK(s) not in the upstream powered set`
        : '') +
      '\n',
  );
  for (const b of BUCKETS) console.log(`${pad(b, 22)}${num(buckets[b].length, 6)}`);
  console.log('');
  for (const b of BUCKETS) {
    if (buckets[b].length === 0) continue;
    console.log(`${b} (${buckets[b].length}):`);
    for (const entry of buckets[b]) console.log(`  ${JSON.stringify(entry)}`);
    console.log('');
  }
  console.log(
    report.reconciles
      ? `reconciles: ${report.alreadyCorrect} correct + ${accounted - report.alreadyCorrect} bucketed = ${report.upstreamPowered} upstream powered`
      : `WARNING: ${accounted} accounted vs ${report.upstreamPowered} upstream powered — rows are unclassified.`,
  );
  console.log(
    buckets.backfillable.length > 0
      ? `RESULT: ${buckets.backfillable.length} row(s) safe to backfill — see backfill.sh.`
      : 'RESULT: nothing safe to backfill.',
  );
}

const target = outPath ?? join(HERE, `report-${report.measuredAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
if (!asJson) console.log(`\nreport written to ${target}`);

// NOT `process.exit()`. The --json payload is far larger than a pipe buffer, and
// process.exit() tears the process down without flushing a pending async write — so
// `audit.mjs --json | …` silently delivers TRUNCATED JSON. Setting exitCode lets Node
// drain stdout and exit on its own.
process.exitCode = dirty ? 1 : 0;
