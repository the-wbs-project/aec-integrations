#!/usr/bin/env node
//
// AECI-1064 — re-promote the endpoints of the 39 live edges that lost their Zapier or
// Workato attribution, so each one gains `powered_by` and moves from `integrations` to
// `connector_evidenced_pairs`.
//
// ─── WHY A RE-PROMOTE IS THE ONLY REPAIR ─────────────────────────────────────
//
// Zapier and Workato were parked (AECI-700) when these edges were promoted, so promote
// could not resolve their `poweredByProduct` and wrote the rows with a NULL
// `powered_by_product_id` (AECI-1032). Both connectors went live on 2026-09-23. That alone
// repairs nothing: "promoting the connector alone does not repair edges already in the
// database, because promote is product-driven and those edges belong to their endpoints'
// bundles" (docs/REVIEW_APP_PROMOTE_API.md §3.4). Re-promoting an endpoint re-sends the
// edge with a now-resolvable connector, and §3.4a moves it: "an edge you promoted earlier
// as an accountable-party integration that now names a third-party `poweredByProduct` is
// **moved** by that push".
//
// ─── SUBCOMMANDS ─────────────────────────────────────────────────────────────
//
//   manifest   derive the edge ids and the endpoint products. Read-only.
//   preflight  snapshot the edges, their claims and the connector rows. Read-only.
//   dry-run    per product, what a promote will change. Read-only.
//   apply      promote_product per product, serialized. WRITES PRODUCTION.
//   verify     re-read the edges and diff against the preflight snapshot. Read-only.
//
// All D1 reads use `wrangler d1 execute --remote --command`. `--file` returns an import
// summary and no rows, so a query through it fails silently.
//
// ─── APPLY GUARDS ────────────────────────────────────────────────────────────
//
//   1. --confirm-count must equal the number of products this run will promote.
//   2. Both connector rows must exist in production with product_role = 'connector'.
//   3. Before each promote, get_promote_status(record_id) must be `idle`. A pending
//      marker means the next promote_product would re-collect the old job (AECI-1095).
//   4. After each promote, the prod `promote_jobs` ledger must hold exactly one NEW job
//      id for that product, minted after the call started. `promote_product` returns no
//      job id when it finishes inline, so the ledger is the only place to read it. A
//      replay writes no new ledger row, which is how AECI-1095 was found.
//   5. The result must be `status: ok`, with no `replayed` key and no connector
//      published as a side effect. `partial` leaves the pending marker, so it stops the
//      run too.
//   6. Every manifest edge incident to the product must now sit in
//      `connector_evidenced_pairs`, unless the result skipped it.
//
// Any guard failing stops the run. Completed products are recorded in promote-jobs.json
// and a re-run skips them, so the operator resumes with the smaller --confirm-count.
//
// ─── USAGE ───────────────────────────────────────────────────────────────────
//
// Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and AECI_MCP_TOKEN.
//
//   node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs manifest
//   node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs preflight
//   node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs dry-run
//   node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs apply --confirm-count 14
//   node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs verify

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listAll, openMcpSession } from './mcp-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const WRANGLER = join(ROOT, 'apps', 'api', 'node_modules', '.bin', 'wrangler');
const CONFIG = join(ROOT, 'apps', 'api', 'wrangler.jsonc');
const ENV = 'production';
const DB = `aeci-app-${ENV}`;

/** The two connectors. Review-app record id → production product id. */
const CONNECTORS = {
  recdsJWp651jBwrBW: { name: 'Zapier', supabaseId: '4e0e4400-2ad3-43e6-a4cb-0c3392473259' },
  recH4fhVn8TXnev2K: { name: 'Workato', supabaseId: '6023cc70-a234-4dca-ab66-6aed72d2b798' },
};

const FILES = {
  manifest: join(HERE, 'manifest.json'),
  preflight: join(HERE, 'preflight-rows.json'),
  dryRun: join(HERE, 'dry-run.json'),
  jobs: join(HERE, 'promote-jobs.json'),
  verify: join(HERE, 'verify-rows.json'),
};

/** A job id is `<rec>-<base36 ms>-<hash>`. Allow this much clock skew against its mint time. */
const MINT_SKEW_MS = 60_000;
/** How long to poll a job that promote_product handed back as `pending`. */
const POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 3_000;

// ─── args ────────────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const value = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const COMMANDS = ['manifest', 'preflight', 'dry-run', 'apply', 'verify'];
if (!COMMANDS.includes(cmd ?? '')) {
  console.error(`usage: repromote.mjs <${COMMANDS.join('|')}> [--confirm-count <n>]`);
  process.exit(2);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Read via `--command`. `--file` returns an import summary and no rows. */
function readD1(sql) {
  const out = execFileSync(
    WRANGLER,
    ['d1', 'execute', DB, '--env', ENV, '--remote', '--json', '--config', CONFIG, '--command', sql],
    { cwd: join(ROOT, 'apps', 'api'), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const sqlList = (ids) => ids.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(',');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byName = (a, b) =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.rec < b.rec ? -1 : 1);

function requireFile(path, producer) {
  if (!existsSync(path)) {
    console.error(`${path} is missing. Run \`repromote.mjs ${producer}\` first.`);
    process.exit(1);
  }
  return readJson(path);
}

/** Refuse unless both connector rows are live in production as `connector`. */
function checkConnectorPreconditions() {
  const ids = Object.values(CONNECTORS).map((c) => c.supabaseId);
  const rows = readD1(
    `SELECT id, slug, name, product_role, promotion_status FROM products WHERE id IN (${sqlList(ids)})`,
  );
  const problems = [];
  for (const c of Object.values(CONNECTORS)) {
    const row = rows.find((r) => r.id === c.supabaseId);
    if (!row) problems.push(`${c.name} (${c.supabaseId}) has no products row in production`);
    else if (row.product_role !== 'connector')
      problems.push(
        `${c.name} has product_role = ${JSON.stringify(row.product_role)}, not 'connector'`,
      );
  }
  return { rows, problems };
}

/** Where each edge id sits in production, with the columns the move changes. */
function locateEdges(ids) {
  if (ids.length === 0) return { integrations: [], pairs: [] };
  const integrations = readD1(
    `SELECT * FROM integrations WHERE id IN (${sqlList(ids)}) ORDER BY id`,
  );
  const pairs = readD1(
    `SELECT * FROM connector_evidenced_pairs WHERE id IN (${sqlList(ids)}) ORDER BY id`,
  );
  return { integrations, pairs };
}

function claimsFor(ids) {
  if (ids.length === 0) return [];
  return readD1(
    `SELECT id, integration_id, connector_evidenced_pair_id, data_object_id, direction, origin
       FROM claims
      WHERE integration_id IN (${sqlList(ids)}) OR connector_evidenced_pair_id IN (${sqlList(ids)})
      ORDER BY id`,
  );
}

// ─── manifest ────────────────────────────────────────────────────────────────

async function buildManifest() {
  const session = await openMcpSession();

  // 1. Upstream: every integration powered by Zapier or Workato that carries a prod id.
  const upstream = [];
  const totals = {};
  for (const [rec, c] of Object.entries(CONNECTORS)) {
    const { rows, total } = await listAll(session, 'list_integrations', {
      powered_by_product_id: rec,
    });
    totals[c.name] = { upstream: total, withProductionId: rows.filter((r) => r.supabaseId).length };
    upstream.push(...rows.map((r) => ({ ...r, connectorRec: rec })));
  }
  const live = upstream.filter((r) => r.supabaseId);

  // 2. Production: match on id, keep rows with powered_by_product_id IS NULL and retired_at IS NULL.
  const { integrations, pairs } = locateEdges(live.map((r) => r.supabaseId));
  const intById = new Map(integrations.map((r) => [r.id, r]));
  const pairIds = new Set(pairs.map((r) => r.id));

  const edges = [];
  const excluded = [];
  for (const u of live) {
    const selfRef =
      u.sourceProduct?.id === u.connectorRec || u.targetProduct?.id === u.connectorRec;
    const row = intById.get(u.supabaseId);
    const base = {
      id: u.supabaseId,
      rec: u.id,
      name: u.name,
      connector: CONNECTORS[u.connectorRec].name,
      source: { rec: u.sourceProduct?.id, name: u.sourceProduct?.name },
      target: { rec: u.targetProduct?.id, name: u.targetProduct?.name },
    };
    let reason = null;
    if (selfRef) reason = 'self-referential (Convention A): stays in integrations by design';
    else if (pairIds.has(u.supabaseId)) reason = 'already in connector_evidenced_pairs';
    else if (!row) reason = 'production id resolves in neither table';
    else if (row.retired_at != null) reason = `retired in production at ${row.retired_at}`;
    else if (row.powered_by_product_id != null)
      reason = `integrations row already has powered_by_product_id = ${row.powered_by_product_id}`;
    if (reason) excluded.push({ ...base, reason });
    else edges.push(base);
  }
  edges.sort((a, b) => (a.id < b.id ? -1 : 1));

  // 3. The endpoint products. Promoting either end of an edge carries it (§3.4), so the
  //    run promotes a covering subset, not every endpoint: fewer promotes, a smaller blast
  //    radius, and every edge still sent at least once. Operator ruling 2026-09-23 on
  //    AECI-1064: cut from all 36 endpoints to the greedy cover.
  const endpoints = new Map();
  for (const e of edges) {
    for (const end of [e.source, e.target]) {
      const p = endpoints.get(end.rec) ?? { rec: end.rec, name: end.name, edges: [] };
      p.edges.push(e.id);
      endpoints.set(end.rec, p);
    }
  }
  const allEndpoints = [...endpoints.values()].sort(byName);
  const cover = new Set(greedyCover(edges));
  const productList = allEndpoints.filter((p) => cover.has(p.rec));

  // The cover must carry every edge, or the run silently leaves one behind.
  const carried = new Set(productList.flatMap((p) => p.edges));
  const uncarried = edges.filter((e) => !carried.has(e.id));
  if (uncarried.length) {
    console.error(
      `REFUSING: the cover misses ${uncarried.length} edge(s): ${uncarried.map((e) => e.id).join(', ')}`,
    );
    process.exit(1);
  }

  const manifest = {
    issue: 'AECI-1064',
    generated_at: new Date().toISOString(),
    target: `${DB} (read-only derivation)`,
    rule:
      'upstream integrations whose powered_by is Zapier or Workato and which store a production id, ' +
      'matched to production integrations rows with powered_by_product_id IS NULL AND retired_at IS NULL; ' +
      'products = greedy cover of those edges over their endpoints',
    connectors: CONNECTORS,
    totals: {
      ...totals,
      edges: edges.length,
      edgesByConnector: countBy(edges, (e) => e.connector),
      products: productList.length,
      allEndpointProducts: allEndpoints.length,
      edgesCarriedByTwoProducts: edges.filter(
        (e) => cover.has(e.source.rec) && cover.has(e.target.rec),
      ).length,
      excluded: excluded.length,
    },
    product_record_ids: productList.map((p) => p.rec),
    edge_ids: edges.map((e) => e.id),
    products: productList,
    edges,
    excluded,
    all_endpoint_record_ids: allEndpoints.map((p) => p.rec),
  };
  writeJson(FILES.manifest, manifest);

  console.log(`Manifest → ${FILES.manifest}`);
  console.log(`  upstream: ${JSON.stringify(totals)}`);
  console.log(`  edges: ${edges.length} ${JSON.stringify(manifest.totals.edgesByConnector)}`);
  console.log(
    `  endpoint products: ${allEndpoints.length}; covering subset promoted: ${productList.length}`,
  );
  console.log(
    `  every edge carried: yes (${manifest.totals.edgesCarriedByTwoProducts} by both endpoints)`,
  );
  console.log(`  excluded: ${excluded.length}`);
  for (const x of excluded)
    console.log(`    ${x.id}  ${x.source.name} → ${x.target.name} | ${x.connector} | ${x.reason}`);
  console.log(`\n${productList.length} product record ids:`);
  for (const p of productList)
    console.log(
      `  ${p.rec}  ${p.name}  (${p.edges.length} edge${p.edges.length === 1 ? '' : 's'})`,
    );
  console.log(`\n${edges.length} edge ids:`);
  for (const e of edges) {
    const via = productList
      .filter((p) => p.rec === e.source.rec || p.rec === e.target.rec)
      .map((p) => p.name);
    console.log(
      `  ${e.id}  ${e.source.name} → ${e.target.name} | ${e.connector} | carried by ${via.join(' + ')}`,
    );
  }
}

function countBy(items, key) {
  const out = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return out;
}

/** Greedy set cover: products that together carry every edge. Ties break on record id. */
function greedyCover(edges) {
  const left = new Set(edges.map((e) => e.id));
  const chosen = [];
  while (left.size) {
    const tally = new Map();
    for (const e of edges) {
      if (!left.has(e.id)) continue;
      for (const rec of [e.source.rec, e.target.rec]) tally.set(rec, (tally.get(rec) ?? 0) + 1);
    }
    const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    chosen.push(best);
    for (const e of edges) if (e.source.rec === best || e.target.rec === best) left.delete(e.id);
  }
  return chosen;
}

// ─── preflight ───────────────────────────────────────────────────────────────

function preflight() {
  const manifest = requireFile(FILES.manifest, 'manifest');
  const ids = manifest.edge_ids;
  const { rows: connectorRows, problems } = checkConnectorPreconditions();
  const { integrations, pairs } = locateEdges(ids);
  const claims = claimsFor(ids);
  const snapshot = {
    issue: 'AECI-1064',
    taken_at: new Date().toISOString(),
    target: DB,
    connector_products: connectorRows,
    connector_preconditions: problems.length ? problems : 'ok',
    counts: {
      edges: ids.length,
      in_integrations: integrations.length,
      in_connector_evidenced_pairs: pairs.length,
      claims: claims.length,
    },
    integrations,
    connector_evidenced_pairs: pairs,
    claims,
  };
  writeJson(FILES.preflight, snapshot);
  console.log(`Preflight → ${FILES.preflight}`);
  console.log(
    `  connectors: ${problems.length ? problems.join('; ') : 'both present, product_role = connector'}`,
  );
  console.log(`  ${JSON.stringify(snapshot.counts)}`);
  const stray = integrations.filter((r) => r.powered_by_product_id != null || r.retired_at != null);
  if (integrations.length !== ids.length || pairs.length || stray.length) {
    console.log('  WARNING: the edges no longer match the manifest rule. Re-run `manifest`.');
  }
}

// ─── dry-run ─────────────────────────────────────────────────────────────────

/**
 * Predict, per product, what one promote_product will do. The prediction follows the
 * promote contract: an edge is sent only when its far endpoint is promoted (§3.4); a
 * never-promoted edge with no owner is withheld by the review app (AECI-1014); a live
 * edge with no owner is sent with a warning; a resolvable third-party connector routes
 * the edge to connector_evidenced_pairs (§3.4a); a claimed row is skipped (§4b).
 */
async function dryRun() {
  const manifest = requireFile(FILES.manifest, 'manifest');
  const session = await openMcpSession();
  const { problems } = checkConnectorPreconditions();

  // Every promoted product upstream, so a far endpoint and a connector can be classified.
  const { rows: promoted } = await listAll(session, 'list_products', {
    promotion_status: 'promoted',
    fields: ['supabaseId', 'productRole'],
  });
  const promotedRec = new Map(promoted.filter((p) => p.supabaseId).map((p) => [p.id, p]));

  const manifestEdges = new Set(manifest.edge_ids);
  const perProduct = [];
  for (const p of manifest.products) {
    const detail = await session.callTool('get_product', {
      record_id: p.rec,
      fields: [
        'supabaseId',
        'researchStatus',
        'promotionStatus',
        'integrationsAsSource',
        'integrationsAsTarget',
      ],
    });
    const status = await session.callTool('get_promote_status', { record_id: p.rec });
    const all = [...(detail.integrationsAsSource ?? []), ...(detail.integrationsAsTarget ?? [])];
    perProduct.push({ p, detail, status, all });
  }

  // One production read for every live edge on these products.
  const liveIds = [
    ...new Set(perProduct.flatMap((x) => x.all.map((i) => i.supabaseId).filter(Boolean))),
  ];
  const { integrations, pairs } = locateEdges(liveIds);
  const intById = new Map(integrations.map((r) => [r.id, r]));
  const pairById = new Map(pairs.map((r) => [r.id, r]));

  const report = [];
  const noOwner = [];
  const blockers = [];
  for (const { p, detail, status, all } of perProduct) {
    const entry = {
      rec: p.rec,
      name: p.name,
      supabase_id: detail.supabaseId ?? null,
      research_status: detail.researchStatus,
      promotion_status: detail.promotionStatus,
      promote_marker: status.status,
      manifest_edges: p.edges,
      will_move_to_pairs: [],
      will_update_in_place: [],
      will_create: [],
      withheld_no_owner: [],
      sent_without_owner: [],
      connector_parked: [],
      claimed_skip: [],
      not_sent_far_endpoint_unpromoted: 0,
    };
    if (detail.researchStatus !== 'Researched')
      blockers.push(`${p.name}: research_status is ${detail.researchStatus}`);
    if (!detail.supabaseId) blockers.push(`${p.name}: has no production id`);
    if (status.status !== 'idle')
      blockers.push(`${p.name}: promote marker is ${status.status} (AECI-1095)`);

    const seen = new Set();
    for (const i of all) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      const farRec = i.sourceProduct?.id === p.rec ? i.targetProduct?.id : i.sourceProduct?.id;
      const farName = i.sourceProduct?.id === p.rec ? i.targetProduct?.name : i.sourceProduct?.name;
      const label = { rec: i.id, id: i.supabaseId ?? null, name: i.name, far: farName };
      const hasOwner = Boolean(i.builtBy);
      const conRec = i.poweredByProduct?.id;
      const conThirdParty =
        conRec && conRec !== i.sourceProduct?.id && conRec !== i.targetProduct?.id;
      const conLive = conRec ? promotedRec.has(conRec) : false;

      if (!hasOwner) {
        noOwner.push({
          product: p.name,
          ...label,
          live: Boolean(i.supabaseId),
          far_promoted: promotedRec.has(farRec),
          owner_ruled_empty: i.ownerRuledEmpty?.reason ?? null,
          powered_by: i.poweredByProduct?.name ?? null,
        });
      }

      if (!i.supabaseId) {
        if (!promotedRec.has(farRec)) entry.not_sent_far_endpoint_unpromoted++;
        else if (!hasOwner && !i.ownerRuledEmpty) entry.withheld_no_owner.push(label);
        else entry.will_create.push({ ...label, powered_by: i.poweredByProduct?.name ?? null });
        continue;
      }

      const row = intById.get(i.supabaseId);
      const pair = pairById.get(i.supabaseId);
      if (
        (row && row.claimed_at) ||
        (row && row.maintained_by === 'vendor') ||
        (pair && pair.maintained_by === 'vendor')
      ) {
        entry.claimed_skip.push(label);
        continue;
      }
      if (!hasOwner && !i.ownerRuledEmpty) entry.sent_without_owner.push(label);
      if (conThirdParty && !conLive)
        entry.connector_parked.push({ ...label, connector: i.poweredByProduct.name });
      if (conThirdParty && conLive && row) {
        entry.will_move_to_pairs.push({
          ...label,
          connector: i.poweredByProduct.name,
          in_manifest: manifestEdges.has(i.supabaseId),
        });
      } else {
        entry.will_update_in_place.push({
          ...label,
          table: pair ? 'connector_evidenced_pairs' : row ? 'integrations' : 'neither',
        });
      }
    }
    report.push(entry);
  }

  const moves = new Map();
  for (const e of report) for (const m of e.will_move_to_pairs) moves.set(m.id, m);
  const manifestMoves = [...moves.values()].filter((m) => m.in_manifest);
  const collateral = [...moves.values()].filter((m) => !m.in_manifest);
  const manifestNotMoving = manifest.edge_ids.filter((id) => !moves.has(id));
  const creates = new Map();
  for (const e of report) for (const c of e.will_create) creates.set(c.rec, { ...c, via: e.name });
  const withheld = new Map();
  for (const e of report)
    for (const w of e.withheld_no_owner) withheld.set(w.rec, { ...w, via: e.name });
  const sentNoOwner = new Map();
  for (const e of report) for (const w of e.sent_without_owner) sentNoOwner.set(w.rec, w);
  const parked = new Map();
  for (const e of report) for (const w of e.connector_parked) parked.set(w.rec, w);
  const claimed = new Map();
  for (const e of report) for (const w of e.claimed_skip) claimed.set(w.rec, w);
  const noOwnerUnique = [...new Map(noOwner.map((n) => [n.rec, n])).values()];

  const summary = {
    products: report.length,
    connector_preconditions: problems.length ? problems : 'ok',
    blockers,
    manifest_edges_moving: manifestMoves.length,
    manifest_edges_not_moving: manifestNotMoving,
    collateral_moves: collateral.length,
    creates: creates.size,
    withheld_no_owner: withheld.size,
    sent_without_owner: sentNoOwner.size,
    connector_parked: parked.size,
    claimed_skip: claimed.size,
    integrations_with_no_owner: noOwnerUnique.length,
    no_owner_ruling_cites_aeci_700: noOwnerUnique.filter(
      (n) => n.live && /AECI-700/.test(n.owner_ruled_empty ?? ''),
    ).length,
  };
  const out = {
    issue: 'AECI-1064',
    generated_at: new Date().toISOString(),
    target: `${DB} (read-only prediction)`,
    summary,
    collateral_moves: collateral,
    creates: [...creates.values()],
    no_owner: noOwnerUnique,
    connector_parked: [...parked.values()],
    claimed_skip: [...claimed.values()],
    products: report,
  };
  writeJson(FILES.dryRun, out);

  console.log(`Dry run → ${FILES.dryRun}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    '\nPer product: move / update-in-place / create / withheld / sent-no-owner / parked / claimed',
  );
  for (const e of report) {
    console.log(
      `  ${e.name.padEnd(34)} ${String(e.will_move_to_pairs.length).padStart(3)} ${String(e.will_update_in_place.length).padStart(4)} ` +
        `${String(e.will_create.length).padStart(3)} ${String(e.withheld_no_owner.length).padStart(3)} ` +
        `${String(e.sent_without_owner.length).padStart(3)} ${String(e.connector_parked.length).padStart(3)} ${String(e.claimed_skip.length).padStart(3)}` +
        `  marker=${e.promote_marker}`,
    );
  }
  if (collateral.length) {
    console.log(
      '\nCollateral moves (not in the manifest, will also move to connector_evidenced_pairs):',
    );
    for (const c of collateral) console.log(`  ${c.id}  ${c.name} | via ${c.connector}`);
  }
  if (creates.size) {
    console.log('\nNew integrations a promote would create:');
    for (const c of creates.values())
      console.log(
        `  ${c.rec}  ${c.name} (via ${c.via})${c.powered_by ? ` | powered by ${c.powered_by}` : ''}`,
      );
  }
  // The full no-owner list is in dry-run.json. The console shows only rows a promote of
  // these products actually sends or withholds; a row whose far endpoint is unpromoted is
  // never sent, so the owner gate never sees it.
  const touched = noOwnerUnique.filter((n) => n.live || n.far_promoted);
  const staleRuling = touched.filter((n) => /AECI-700/.test(n.owner_ruled_empty ?? ''));
  console.log(
    `\nIntegrations on these products with no owner: ${noOwnerUnique.length} ` +
      `(${noOwnerUnique.length - touched.length} never sent: far endpoint unpromoted)`,
  );
  console.log(
    `  withheld by the owner gate (AECI-1014), curation work, not failures: ${withheld.size}`,
  );
  for (const w of withheld.values()) console.log(`    ${w.rec}  ${w.name} [${w.via}]`);
  console.log(`  live, sent with an owner warning: ${sentNoOwner.size}`);
  for (const w of sentNoOwner.values()) console.log(`    ${w.rec}  ${w.name}`);
  console.log(
    `  live, owner ruled empty: ${touched.filter((n) => n.live && n.owner_ruled_empty).length}`,
  );
  console.log(
    `    of which the ruling cites AECI-700 (the park this run ends): ${staleRuling.length}`,
  );
  for (const n of staleRuling)
    console.log(`    ${n.rec}  ${n.name} [${n.product}] via ${n.powered_by ?? 'no connector'}`);
  if (parked.size) {
    console.log(
      `\nSent without their connector (connector not promoted, connectorsParked): ${parked.size}`,
    );
    for (const w of parked.values()) console.log(`  ${w.rec}  ${w.name} | ${w.connector}`);
  }
  if (blockers.length) {
    console.log('\nBLOCKERS (apply will refuse):');
    for (const b of blockers) console.log(`  ${b}`);
  }
}

// ─── apply ───────────────────────────────────────────────────────────────────

function ledgerJobs(rec) {
  return readD1(
    `SELECT job_id, created_at FROM promote_jobs WHERE job_id LIKE '${rec}-%' ORDER BY created_at`,
  );
}

function mintTime(jobId) {
  const parts = jobId.split('-');
  const ms = parseInt(parts[1] ?? '', 36);
  return Number.isFinite(ms) ? ms : null;
}

/** The single write path in this lane. Returns a job record; throws on any guard failure. */
async function promoteOne(session, product, seenJobIds, manifestEdges, edgeRec) {
  const record = { rec: product.rec, name: product.name, started_at: new Date().toISOString() };

  const before = await session.callTool('get_promote_status', { record_id: product.rec });
  if (before.status !== 'idle') {
    throw new GuardError(
      `${product.name}: get_promote_status is "${before.status}", not idle. A pending marker ` +
        'means promote_product would re-collect the old job and send nothing (AECI-1095). ' +
        'Finish it with get_promote_status first.',
      record,
    );
  }
  const ledgerBefore = new Set(ledgerJobs(product.rec).map((r) => r.job_id));
  const t0 = Date.now();

  const result = await session.callWriteTool('promote_product', { record_id: product.rec });
  record.raw = result;
  if (result?.isError)
    throw new GuardError(`${product.name}: promote_product failed: ${result.message}`, record);

  let final = result;
  let pendingJobId = null;
  if (result.status === 'pending') {
    pendingJobId = result.job_id;
    for (
      let i = 0;
      i < POLL_ATTEMPTS && ['pending', 'queued', 'running'].includes(final.status);
      i++
    ) {
      await sleep(POLL_INTERVAL_MS);
      final = await session.callTool('get_promote_status', { job_id: pendingJobId });
    }
    record.collected = final;
  }

  // Freshness: exactly one new ledger row for this product, minted after t0.
  const ledgerAfter = ledgerJobs(product.rec);
  const fresh = ledgerAfter.filter((r) => !ledgerBefore.has(r.job_id));
  record.job_id = fresh.length === 1 ? fresh[0].job_id : null;
  record.job_created_at = fresh.length === 1 ? fresh[0].created_at : null;
  if (fresh.length !== 1) {
    throw new GuardError(
      `${product.name}: expected exactly one new promote_jobs row, found ${fresh.length}. ` +
        'No new row means the call replayed an existing job and sent nothing (AECI-1095).',
      record,
    );
  }
  const jobId = fresh[0].job_id;
  const minted = mintTime(jobId);
  if (minted == null || minted < t0 - MINT_SKEW_MS) {
    throw new GuardError(
      `${product.name}: job ${jobId} was minted before this call started.`,
      record,
    );
  }
  if (pendingJobId && pendingJobId !== jobId) {
    throw new GuardError(
      `${product.name}: pending job ${pendingJobId} is not the new ledger row ${jobId}.`,
      record,
    );
  }
  if (seenJobIds.has(jobId))
    throw new GuardError(`${product.name}: job ${jobId} was already used in this run.`, record);
  seenJobIds.add(jobId);

  if (final.replayed)
    throw new GuardError(
      `${product.name}: result carries replayed=${JSON.stringify(final.replayed)}.`,
      record,
    );
  record.status = final.status;
  record.operation = final.product?.operation ?? null;
  record.skipped = final.skipped ?? [];
  record.withheld = result.withheld ?? final.withheld ?? [];
  record.warnings = result.warnings ?? final.warnings ?? [];
  record.unresolvedLinks = final.unresolvedLinks ?? [];
  record.connectorsParked = result.connectorsParked ?? final.connectorsParked ?? [];
  record.connectorsPromoted = result.connectorsPromoted ?? final.connectorsPromoted ?? [];
  record.retriedAfter = final.retriedAfter ?? null;
  if (final.status !== 'ok') {
    throw new GuardError(
      `${product.name}: status is "${final.status}", not ok. Stop and read the result.`,
      record,
    );
  }
  if (record.connectorsPromoted.length) {
    throw new GuardError(
      `${product.name}: promote published connector(s) as a side effect: ` +
        `${record.connectorsPromoted.map((c) => c.name).join(', ')}. Review before continuing.`,
      record,
    );
  }

  // Every manifest edge on this product must now be a pair row.
  const mine = product.edges.filter((id) => manifestEdges.has(id));
  const { integrations, pairs } = locateEdges(mine);
  // A skipped[] entry names the edge by its payload `ref` (the review-app record id) or by
  // its production id, depending on the kind. Accept either.
  const skippedKeys = new Set(
    record.skipped.flatMap((s) => [s.supabaseId, s.id, s.ref].filter(Boolean)),
  );
  const stuck = mine.filter(
    (id) =>
      !skippedKeys.has(id) &&
      !skippedKeys.has(edgeRec.get(id)) &&
      (integrations.some((r) => r.id === id) || !pairs.some((r) => r.id === id)),
  );
  record.edges_moved = mine.length - stuck.length;
  record.edges_stuck = stuck;
  if (stuck.length) {
    throw new GuardError(
      `${product.name}: ${stuck.length} manifest edge(s) did not move: ${stuck.join(', ')}.`,
      record,
    );
  }
  record.finished_at = new Date().toISOString();
  return record;
}

class GuardError extends Error {
  constructor(message, record) {
    super(message);
    this.record = record;
  }
}

async function apply() {
  const manifest = requireFile(FILES.manifest, 'manifest');
  const jobs = existsSync(FILES.jobs)
    ? readJson(FILES.jobs)
    : {
        issue: 'AECI-1064',
        target: `${DB} (via review-app promote_product, serialized)`,
        jobs: [],
      };
  const done = new Set(jobs.jobs.filter((j) => j.status === 'ok' && !j.error).map((j) => j.rec));

  // Smallest blast radius first, as the 2026-09 mechanism re-promote did: the first
  // promotes prove the move on products that send the fewest edges.
  const dry = requireFile(FILES.dryRun, 'dry-run');
  if (dry.summary.blockers.length) {
    console.error(
      `REFUSING: the dry run reported blockers:\n  ${dry.summary.blockers.join('\n  ')}`,
    );
    process.exit(1);
  }
  const sent = new Map(
    dry.products.map((d) => [
      d.rec,
      d.will_move_to_pairs.length + d.will_update_in_place.length + d.will_create.length,
    ]),
  );
  const todo = manifest.products
    .filter((p) => !done.has(p.rec))
    .sort((a, b) => (sent.get(a.rec) ?? 0) - (sent.get(b.rec) ?? 0) || byName(a, b));

  const confirm = Number(value('--confirm-count'));
  if (!Number.isInteger(confirm) || confirm !== todo.length) {
    console.error(
      `REFUSING: --confirm-count must equal the ${todo.length} product(s) this run will promote ` +
        `(${done.size} already done in promote-jobs.json). Got ${value('--confirm-count') ?? 'nothing'}.`,
    );
    process.exit(1);
  }
  const { problems } = checkConnectorPreconditions();
  if (problems.length) {
    console.error(`REFUSING: connector preconditions failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  const session = await openMcpSession();
  const manifestEdges = new Set(manifest.edge_ids);
  const edgeRec = new Map(manifest.edges.map((e) => [e.id, e.rec]));
  const seenJobIds = new Set(jobs.jobs.map((j) => j.job_id).filter(Boolean));
  let n = jobs.jobs.length;
  for (const product of todo) {
    n++;
    process.stdout.write(`[${n}] ${product.name} (${product.rec}) … `);
    try {
      const record = await promoteOne(session, product, seenJobIds, manifestEdges, edgeRec);
      jobs.jobs.push({ n, ...record });
      writeJson(FILES.jobs, jobs);
      console.log(
        `ok job=${record.job_id} moved=${record.edges_moved} skipped=${record.skipped.length} ` +
          `withheld=${record.withheld.length} parked=${record.connectorsParked.length}`,
      );
    } catch (e) {
      const record = e instanceof GuardError ? e.record : { rec: product.rec, name: product.name };
      jobs.jobs.push({ n, ...record, error: e.message });
      writeJson(FILES.jobs, jobs);
      console.log('STOPPED');
      console.error(`\n${e.message}\nRecorded in ${FILES.jobs}. Nothing further was promoted.`);
      process.exit(1);
    }
  }
  console.log(`\nAll ${todo.length} promoted. Run \`repromote.mjs verify\`.`);
}

// ─── verify ──────────────────────────────────────────────────────────────────

function verify() {
  const manifest = requireFile(FILES.manifest, 'manifest');
  const before = requireFile(FILES.preflight, 'preflight');
  const ids = manifest.edge_ids;
  const expectConnector = new Map(
    manifest.edges.map((e) => [
      e.id,
      Object.values(CONNECTORS).find((c) => c.name === e.connector).supabaseId,
    ]),
  );
  const { integrations, pairs } = locateEdges(ids);
  const claims = claimsFor(ids);
  const beforeInt = new Map(before.integrations.map((r) => [r.id, r]));
  const pairById = new Map(pairs.map((r) => [r.id, r]));

  const rows = ids.map((id) => {
    const was = beforeInt.get(id);
    const pair = pairById.get(id);
    const stillInt = integrations.some((r) => r.id === id);
    const claimsBefore = before.claims.filter(
      (c) => c.integration_id === id || c.connector_evidenced_pair_id === id,
    ).length;
    const claimsAfter = claims.filter((c) => c.connector_evidenced_pair_id === id).length;
    const claimsLeftOnInt = claims.filter((c) => c.integration_id === id).length;
    const ok =
      Boolean(pair) &&
      !stillInt &&
      pair.connector_product_id === expectConnector.get(id) &&
      claimsAfter === claimsBefore &&
      claimsLeftOnInt === 0;
    const changed =
      was && pair
        ? Object.keys(pair).filter(
            (k) =>
              k in was && k !== 'updated_at' && JSON.stringify(was[k]) !== JSON.stringify(pair[k]),
          )
        : [];
    return {
      id,
      name: was?.name ?? pair?.name ?? null,
      before: {
        table: was ? 'integrations' : 'missing',
        powered_by: was?.powered_by_product_id ?? null,
      },
      after: {
        table: pair ? 'connector_evidenced_pairs' : stillInt ? 'integrations' : 'missing',
        connector_product_id: pair?.connector_product_id ?? null,
      },
      expected_connector: expectConnector.get(id),
      claims: {
        before: claimsBefore,
        after_on_pair: claimsAfter,
        left_on_integration: claimsLeftOnInt,
      },
      fields_changed: changed,
      ok,
    };
  });

  const jobs = existsSync(FILES.jobs) ? readJson(FILES.jobs).jobs : [];
  const jobIds = jobs.map((j) => j.job_id).filter(Boolean);
  const ledger = jobIds.length
    ? readD1(`SELECT job_id FROM promote_jobs WHERE job_id IN (${sqlList(jobIds)})`)
    : [];

  const summary = {
    edges: ids.length,
    ok: rows.filter((r) => r.ok).length,
    in_pairs: pairs.length,
    still_in_integrations: integrations.length,
    wrong_connector: rows.filter(
      (r) => r.after.connector_product_id && r.after.connector_product_id !== r.expected_connector,
    ).length,
    claims_before: before.claims.length,
    claims_on_pairs_after: claims.filter((c) => ids.includes(c.connector_evidenced_pair_id)).length,
    promote_jobs_recorded: jobIds.length,
    promote_jobs_in_ledger: ledger.length,
  };
  writeJson(FILES.verify, {
    issue: 'AECI-1064',
    verified_at: new Date().toISOString(),
    target: DB,
    summary,
    rows,
    integrations,
    connector_evidenced_pairs: pairs,
    claims,
  });

  console.log(`Verify → ${FILES.verify}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nDiff against preflight (before → after):');
  for (const r of rows) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    console.log(
      `  ${mark} ${r.id}  ${r.before.table}/powered_by=${r.before.powered_by ?? 'NULL'} → ` +
        `${r.after.table}/connector=${r.after.connector_product_id ?? 'NULL'}  ` +
        `claims ${r.claims.before}→${r.claims.after_on_pair}` +
        (r.fields_changed.length ? `  changed: ${r.fields_changed.join(',')}` : ''),
    );
  }
  process.exit(summary.ok === ids.length ? 0 : 1);
}

// ─── main ────────────────────────────────────────────────────────────────────

if (cmd === 'manifest') await buildManifest();
else if (cmd === 'preflight') preflight();
else if (cmd === 'dry-run') await dryRun();
else if (cmd === 'apply') await apply();
else if (cmd === 'verify') verify();
