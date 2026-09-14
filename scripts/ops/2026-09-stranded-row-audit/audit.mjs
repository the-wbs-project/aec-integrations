#!/usr/bin/env node
//
// audit.mjs — find production D1 rows whose UPSTREAM curation record is gone or
// rejected, and report what each one is still exposing publicly (AECI-767).
//
// STRICTLY READ-ONLY. There is no --apply flag and no write path: SELECTs against D1,
// read-only MCP tools against the review app (mcp-client.mjs enforces the allow-list).
// Retraction stays a separate, authorized action — `pnpm --filter @aeci/api
// ops:retract-product` for a product, the datatool prune for integrations.
//
// ─── WHY A ROW CAN BE STRANDED ────────────────────────────────────────────────
//
// docs/REVIEW_APP_PROMOTE_API.md §5.1: "A promote can create and update rows. It can
// never delete one." So when a curator deletes a curation record, or moves it to
// `rejected`, the D1 row it produced stays live, indexable and un-updatable. AECI-593
// (2 Polycam edges) and AECI-685 (the dead `bluebeam` vendor) are the two instances
// found by eye. This sweep is the measurement AECI-595 needs to be prioritised.
//
// ─── WHY THE SWEEP RUNS UPSTREAM-FIRST ────────────────────────────────────────
//
// D1 STORES NO UPSTREAM RECORD ID (docs/REVIEW_APP_PROMOTE_API.md:71; AECI-562 was
// canceled on purpose — no curation-tool key in the public schema). The only link is
// the `supabaseId` the REVIEW APP holds. So there is no D1 → upstream walk available:
// the sweep must enumerate upstream, build the set of D1 ids upstream still CLAIMS,
// and treat the D1 rows outside that set as stranded.
//
// ─── THIS *IS* THE DAILY STRAND AUDIT, SINCE AECI-796 ─────────────────────────
//
// scripts/ops/2026-08-promote-strand-audit/ computed the same set difference as its
// `stray` bucket, reading Airtable directly, and was what the daily workflow ran. Its
// transport was decommissioned and its audit.mjs was deleted on 2026-09-08; the workflow
// now runs THIS file. That lane was never a duplicate of this one — it lacked the three
// things below, which is why the replacement went this direction rather than the reverse.
//
//   1. It sub-classifies WHY the claim is gone — DELETED upstream vs REJECTED
//      upstream. A rejected record is invisible to every ordinary MCP read tool
//      (`list_products` excludes them with no opt-in), so `find_product` with
//      `include_rejected` is the only way to tell the two apart.
//   2. It walks the TRANSITIVE damage: a stranded product strands its integrations,
//      which strand their claims and attestations.
//   3. It reports PUBLIC REACHABILITY and the retraction CASCADE per row.
//
// ─── BUCKETS ─────────────────────────────────────────────────────────────────
//
//   productRejectedUpstream       D1 product no live upstream record claims, and
//                                 find_product(include_rejected) finds it REJECTED.
//                                 The headline class: a public page asserting
//                                 something the catalogue has ruled out.
//   productDeletedUpstream        D1 product no upstream record claims at all.
//   vendorNoLiveProducts          D1 vendor with zero products (the AECI-685 shape).
//   vendorSourceGone              D1 vendor no upstream vendor record claims.
//   integrationSourceGone         D1 integration whose id no upstream record carries
//                                 (the AECI-593 shape).
//   integrationEndpointStranded   Integration whose source / target / built_by /
//                                 powered_by resolves to a row stranded above.
//   orphanChildren                Claims + attestations hanging off any stranded
//                                 integration. Derived, reported for the cascade.
//   evidencedPairSourceGone       `connector_evidenced_pairs` row whose id no upstream
//                                 record carries. The AECI-897 bucket — see below.
//   pendingRetractions            A record DELETED upstream whose public row this repo
//                                 has not removed yet (AECI-882). Not a stranded row —
//                                 the ruling already exists; the consumer has not run.
//                                 Entries on HELD_RETRACTIONS are reported but do NOT
//                                 make the run dirty.
//
// ─── `connector_evidenced_pairs` IS IN SCOPE, SINCE AECI-897 ──────────────────
//
// It was not, and the exclusion cost a real miss. This sweep read GREEN on 2026-09-10 and
// again on 2026-09-11, immediately after 215 rows were deleted upstream with none removed
// from the public site. Every one of the 215 was in this table. A check that cannot see a
// whole table is worse than no check, because it reads as coverage.
//
// The recorded reason was that classifying pairs against `list_integrations` "would report
// all of them, every run". That was MEASURED against production on 2026-09-14 and is wrong
// by 60 of 62:
//
//     upstream integrations carrying a supabaseId   1,010
//     D1 connector_evidenced_pairs                     62
//       ...claimed upstream                            60
//       ...unclaimed                                    2
//
// The comparand is sound because the ids are the SAME ids. The product promote arm writes
// a pair row under the caller's `supabaseId` verbatim and reports it back on
// `response.integrations[]`, which the review app stores in the same
// `supabase_integration_id` column `list_integrations` projects. This table is not fed by
// the connector-catalog arm at all (§3a writes `connector_pairs`, a different table); it
// is fed by the product arm routing `integrations[]` off `poweredByProduct` (§3.4a).
//
// If that ever stops being true, every row goes unclaimed at once — which is the comparand
// BREAKING, not 62 findings. `comparandLooksBroken` in `classify.mjs` catches that shape
// and routes it to exit 2.
//
// The classification itself lives in `classify.mjs` so it can be tested:
// `apps/api/src/test/strand-classify.spec.ts`.
//
// ONLY `--env production` IS MEANINGFUL, for the reason both sibling lanes give: the
// review app holds PRODUCTION uuids in its `supabase*` fields — there is one curation
// base, not one per tier — so pointing this at staging/demo/preview compares them
// against an unrelated seeded catalog and reports near-total mismatch.
//
// USAGE (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + AECI_MCP_TOKEN):
//   node scripts/ops/2026-09-stranded-row-audit/audit.mjs
//   node scripts/ops/2026-09-stranded-row-audit/audit.mjs --json --out report.json
//
// EXIT CODES — three-valued since AECI-796, and 2 is NOT a pass:
//   0  clean and complete
//   1  stranded rows found (any bucket non-empty)
//   2  could not check — missing credential, bad args, INCOMPLETE SWEEP, or a crash
//
// This runs daily in CI. `.github/workflows/promote-strand-audit.yml` is the caller, and
// the full contract for why it is scheduled rather than a PR check lives in that file's
// header. Anything that changes the exit codes or the flags changes that workflow too.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  attachTwins,
  classifyRows,
  comparandLooksBroken,
  evidencedPairEndpoints,
  evidencedPairEntry,
  integrationEndpoints,
  integrationEntry,
} from './classify.mjs';
import { listAll, mapWithConcurrency, openMcpSession } from './mcp-client.mjs';

// A THROW IS "COULD NOT CHECK", NOT "FOUND NOTHING" — and not "found something" either.
//
// Node exits 1 on an uncaught throw, which is this script's "stranded rows found" code. So a
// wrangler failure, a dead MCP handshake or an unreachable D1 would arrive at a scheduled
// consumer wearing the costume of a real finding, and the operator would go looking for a
// stranded row that was never reported. Route every unexpected failure to 2 instead, which
// means exactly one thing: the sweep did not complete, so its verdict is not usable.
//
// This matters more since AECI-796 wired the lane into `.github/workflows/promote-strand-audit.yml`.
// Registered before any work starts so it also covers the MCP handshake.
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, (err) => {
    console.error(`\nerror (${signal}): ${err?.stack ?? err}`);
    console.error('the sweep did not complete — this is NOT a clean result. Exit 2.');
    process.exit(2);
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const WRANGLER = join(ROOT, 'apps', 'api', 'node_modules', '.bin', 'wrangler');
const CONFIG = join(ROOT, 'apps', 'api', 'wrangler.jsonc');

const ENVS = ['preview', 'staging', 'demo', 'production'];
const BUCKETS = [
  'productRejectedUpstream',
  'productDeletedUpstream',
  'vendorNoLiveProducts',
  'vendorSourceGone',
  'integrationSourceGone',
  'integrationEndpointStranded',
  // AECI-897. The same set difference as `integrationSourceGone`, over the OTHER anchor
  // table. Its own bucket rather than folded in, because its repair is different: see the
  // `--ids-out` legend — nothing in this repo can delete one on an operator's say-so.
  'evidencedPairSourceGone',
  // AECI-882. NOT a stranded-row class — this one is an unconsumed RETRACTION: a record
  // the curator deleted whose public row this repo has not yet removed. It is in BUCKETS
  // so it flows through the summary table, the report and the exit code like any other
  // finding, but its repair is a different tool (see the id-list header below).
  //
  // It belongs here rather than in a second workflow because the two checks answer
  // different questions over the same catalog and are cheapest read together. This sweep
  // is a STOCK check: it compares what exists on both sides today, so it catches a row
  // however long ago it was stranded, but it can only infer THAT something went missing.
  // The feed is an EVENT check: it says what was deleted and WHY, in the curator's own
  // words, but journals forward only. `docs/REVIEW_APP_PROMOTE_API.md` §5.1 argues for
  // running them alongside each other, and this is what that looks like.
  'pendingRetractions',
];

/**
 * Pending retractions that are held on a RECORDED decision, keyed by `supabaseId`.
 *
 * These are reported every run and excluded from the dirty verdict. Without this the job
 * would be red every day for as long as the hold lasts, and a permanently red guard is
 * one nobody reads — which would hide the NEXT retraction behind the two we already know
 * about. That is the failure mode, not the noise.
 *
 * A hold is not an exemption in perpetuity. Each entry names the issue that clears it, and
 * when that issue ships the entry is deleted from here and the consumer run takes the row.
 * If you are adding one, the bar is the same as `docs/CODE_REVIEW_EXEMPTIONS.md`: a written
 * reason and a named way out.
 */
// EMPTY since 2026-09-14 (AECI-909). The two Agave ERP Sync ids that lived here were
// released once both of their recorded conditions were met: AECI-891 reached production on
// `b5a75c93`, and AECI-910 pushed the 21 re-anchored claims onto the reach-tier
// `connector_pairs` rows. The consumer then deleted, verified and confirmed both entries,
// and this map was emptied in the SAME change.
//
// Emptying it is not tidying. A discharged hold left in place is worse than no hold at
// all: the bucket would report "2, both held" forever, the run would stay green, and the
// NEXT retraction to arrive would sit invisible behind two ids nobody re-reads. If you
// release a hold, delete its entry in the same commit as the run that released it.
const HELD_RETRACTIONS = {};

// Read concurrency against the review app. get_product responses are large (~75KB),
// and the server rate-limits: eight in flight tripped a 429 partway through the first
// production run (2026-09-07). Three plus the client's backoff completes cleanly.
// Override with AECI_MCP_CONCURRENCY if the server's limits change.
const MCP_CONCURRENCY = Number(process.env.AECI_MCP_CONCURRENCY ?? 3);

/**
 * Upstream product statuses that could hold a `supabaseId`, i.e. that a promote could
 * ever have touched.
 *
 * The authoritative vocabulary is SEVEN values (review app `server/status.ts:47-56`),
 * confirmed by the review app 2026-09-07:
 *
 *   unreviewed · needs_attention · approved · on_hold · promoted · retracted · rejected
 *
 * Production counts that day, over 1,586 products: unreviewed 1216 + 34 blank,
 * promoted 247, rejected 51, on_hold 22, needs_attention 16, approved 0, retracted 0.
 * A BLANK field means `unreviewed`, not missing — which is why a naive read counts
 * 1,250 unreviewed, and why 1,586 − 51 rejected = the 1,535 `list_products` returns.
 *
 * `retracted` is in the enum but **used by nothing** — zero rows, no writer, and no
 * reader in the promote path. It is included below as reserved, not because it is live.
 * `rejected` is excluded because `list_products` hides those unconditionally; they are
 * reached by the `find_product` second pass instead.
 *
 * `unreviewed` is excluded from the default cohort because it is 80% of the catalog
 * and has never been promoted. That is not a blind spot: a D1 row left unclaimed by
 * this cohort goes through the `find_product` second pass below, which reaches every
 * status INCLUDING rejected. So the cohort is an optimisation over the common case,
 * not the audit's actual reach. `--all-statuses` resolves every listed row instead.
 */
const RESOLVABLE_STATUSES = new Set([
  'promoted',
  'approved',
  'on_hold',
  'needs_attention',
  'retracted',
]);

// ─── args ────────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    'usage: audit.mjs [--env <preview|staging|demo|production>] [--json] [--out <path>]\n' +
      '                 [--ids-out <path>] [--all-statuses] [--cache <path>] [--refresh-cache]',
  );
  process.exit(2);
}

let env = 'production';
let asJson = false;
let outPath = null;
let idsOutPath = null;
let allStatuses = false;
let cachePath = join(HERE, '.upstream-cache.json');
let refreshCache = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--env') env = process.argv[++i];
  else if (arg.startsWith('--env=')) env = arg.slice('--env='.length);
  else if (arg === '--json') asJson = true;
  else if (arg === '--out') outPath = process.argv[++i];
  else if (arg.startsWith('--out=')) outPath = arg.slice('--out='.length);
  else if (arg === '--ids-out') idsOutPath = process.argv[++i];
  else if (arg.startsWith('--ids-out=')) idsOutPath = arg.slice('--ids-out='.length);
  else if (arg === '--all-statuses') allStatuses = true;
  else if (arg === '--cache') cachePath = process.argv[++i];
  else if (arg.startsWith('--cache=')) cachePath = arg.slice('--cache='.length);
  else if (arg === '--refresh-cache') refreshCache = true;
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
if (!process.env.AECI_MCP_TOKEN) {
  usage(
    'AECI_MCP_TOKEN is not set. It is injected from the Conductor keychain\n' +
      '  (.conductor/settings.local.toml → [environment_variables]) and is the same\n' +
      '  bearer .mcp.json uses for the `aeci-review` server. Export it and re-run.',
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

/** SQLite string-literal escape, mirroring `apps/api/src/lib/retract-product.ts`. */
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ─── reachability ────────────────────────────────────────────────────────────
//
// TWO GATES, AND THEY ARE NOT THE SAME ONE.
//
//   Page + sitemap — gated on NOTHING. The public read handlers apply no
//   `promotion_status` filter (apps/api/src/routes/products.ts; `buildProductsWhere`
//   in apps/api/src/lib/drizzle-helpers.ts has no status clause) and the sitemap pages
//   those same endpoints. So for a product or vendor, "publicly reachable" IS "the row
//   exists". Every row this script reports is live; `url` records where, not whether.
//
//   Search — stricter, and DERIVED here from the shipped membership predicate rather
//   than queried, so this sweep needs no Algolia credential: a product/vendor is
//   indexed iff `promotion_status = 'promoted'`, an integration iff BOTH endpoints are
//   (apps/api/src/lib/algolia-sync.ts). In practice the two gates collapse, because
//   nothing in this repo ever writes 'retracted'/'rejected' into D1 — retraction is a
//   hard delete — so the realistic stranded row is promoted, indexed and live.
//   `apps/api/src/lib/algolia-orphans.ts` is the tool that answers the index-TRUTH
//   question if the derived answer is ever doubted.

const productUrl = (slug) => `/products/${slug}`;
const vendorUrl = (slug) => `/vendors/${slug}`;
const pairUrl = (a, b) => `/products/${a}/integrations/${b}`;

// ─── upstream ────────────────────────────────────────────────────────────────

// The upstream phase used to cost ~300 `get_product`/`get_vendor` calls (it is ~64 since
// the 2026-09-08 upstream projection change — see the fast path) against a
// rate-limited production curation DB, so its result is snapshotted to
// `.upstream-cache.json` (gitignored) and reused. Deleting the file, or passing
// `--refresh-cache`, re-reads upstream. The cache records `fetchedAt`: it is a
// convenience for iterating on the D1 half of the sweep within one sitting, NOT a
// substitute for a fresh read — the README says so, and every published measurement
// must come from a run whose cache is same-day.
const cache =
  !refreshCache && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : null;
if (cache) {
  console.error(`note: reusing upstream snapshot from ${cachePath} (fetched ${cache.fetchedAt}).`);
  console.error('      pass --refresh-cache for a fresh read of the review app.\n');
}

// The session is opened either way: the cache covers the expensive ENUMERATION, but
// the `find_product` second pass below is driven by the D1 side and must always run
// live — it is the only read that can see a rejected record.
const session = await openMcpSession();

// 1. Every upstream product. `list_products` EXCLUDES rejected rows unconditionally —
//    that exclusion is the property this whole audit turns on.
const { rows: upstreamProducts, total: upstreamProductTotal } = cache
  ? { rows: cache.upstreamProducts, total: cache.upstreamProductTotal }
  : await listAll(session, 'list_products');
const productCohort = allStatuses
  ? upstreamProducts
  : upstreamProducts.filter((r) => RESOLVABLE_STATUSES.has(r.promotionStatus ?? ''));

// 2. Resolve the cohort to its `supabaseId`s. get_product is the ONLY tool that
//    exposes them; list_products does not.
const productByRecId = new Map();
/** How many records came free off the list vs. cost a per-record call. See the fast path. */
const fastPath = { products: null, vendors: null };
/**
 * Reads the review app failed to serve, so a clean verdict cannot hide behind them.
 * Three shapes, one meaning — "could not check", which forces exit 2 at the bottom:
 *   { kind: 'product',        recId }  a `get_product` that failed
 *   { kind: 'vendor',         recId }  a `get_vendor` that failed
 *   { kind: 'product-lookup', d1Id }   a `find_product` that failed, so the D1 row was
 *                                      left UNCLASSIFIED rather than filed as stranded
 */
const unresolvedUpstream = [];

/** One read, retried — the curation DB intermittently fails a tool query outright. */
async function callWithRetry(tool, args, attempts = 3) {
  let lastErr;
  for (let n = 1; n <= attempts; n++) {
    try {
      return await session.callTool(tool, args);
    } catch (err) {
      lastErr = err;
      if (n < attempts) await new Promise((r) => setTimeout(r, 2 ** n * 500));
    }
  }
  throw lastErr;
}

async function resolveProduct(recId) {
  if (!recId) return null;
  if (!productByRecId.has(recId)) {
    let p;
    try {
      p = await callWithRetry('get_product', { record_id: recId });
    } catch (err) {
      unresolvedUpstream.push({ kind: 'product', recId, error: err.message });
      console.error(`warning: get_product(${recId}) failed — ${err.message}`);
      return null;
    }
    productByRecId.set(recId, {
      recId,
      name: p.name ?? null,
      website: p.website ?? null,
      supabaseId: p.supabaseId ?? null,
      supabaseSlug: p.supabaseSlug ?? null,
      promotionStatus: p.promotionStatus ?? null,
      vendorRecIds: (p.vendors ?? []).map((v) => v.id),
      reviewUrl: p.reviewUrl ?? null,
    });
  }
  return productByRecId.get(recId);
}
if (cache) {
  for (const p of cache.products) productByRecId.set(p.recId, p);
} else {
  // OPPORTUNISTIC FAST PATH — LIVE SINCE 2026-09-08. The review app added `supabaseId` /
  // `supabaseSlug` to the `list_products` / `list_vendors` projections, so most list rows
  // now carry everything this sweep needs and the per-record fan-out is mostly dead weight.
  // Measured on the first CI run: 252 of 290 products and 167 of 193 vendors came off the
  // list, leaving ~64 `get_product` / `get_vendor` calls instead of ~300.
  //
  // It was written as a detector rather than a switch, and stays one: a row that already
  // carries `supabaseId` is used directly, and only the rest fall through to `get_product`.
  // So an upstream regression degrades to the old ~300-call path instead of misreporting.
  // The `fastPath:` line printed at the end of every run says which path was taken —
  // `fromList: 0` means the projection regressed.
  const needsResolve = [];
  for (const row of productCohort) {
    if (row.supabaseId) {
      productByRecId.set(row.id, {
        recId: row.id,
        name: row.name ?? null,
        website: row.website ?? null,
        supabaseId: row.supabaseId,
        supabaseSlug: row.supabaseSlug ?? null,
        promotionStatus: row.promotionStatus ?? null,
        vendorRecIds: (row.vendors ?? []).map((v) => v.id),
        reviewUrl: row.reviewUrl ?? null,
      });
    } else {
      needsResolve.push(row.id);
    }
  }
  fastPath.products = {
    fromList: productCohort.length - needsResolve.length,
    viaGetProduct: needsResolve.length,
  };
  await mapWithConcurrency(needsResolve, MCP_CONCURRENCY, resolveProduct);
}

/** D1 product id → the upstream record claiming it. */
const claimedProducts = new Map();
for (const p of productByRecId.values()) if (p.supabaseId) claimedProducts.set(p.supabaseId, p);

// 3. Vendors. A D1 vendor row exists only because a promoted product referenced its
//    upstream vendor, so the cohort's vendor links are the complete candidate set.
const { rows: upstreamVendors, total: upstreamVendorTotal } = cache
  ? { rows: cache.upstreamVendors, total: cache.upstreamVendorTotal }
  : await listAll(session, 'list_vendors');
const upstreamVendorByRecId = new Map(upstreamVendors.map((v) => [v.id, v]));

const vendorRecIds = [...new Set([...productByRecId.values()].flatMap((p) => p.vendorRecIds))];
const vendorByRecId = new Map();
if (cache) for (const v of cache.vendors) vendorByRecId.set(v.recId, v);
// Same opportunistic fast path for vendors (see the products block above).
const vendorNeedsResolve = [];
if (!cache) {
  for (const recId of vendorRecIds) {
    const listRow = upstreamVendorByRecId.get(recId);
    if (listRow?.supabaseId) {
      vendorByRecId.set(recId, {
        recId,
        companyName: listRow.companyName ?? null,
        supabaseId: listRow.supabaseId,
        supabaseSlug: listRow.supabaseSlug ?? null,
        toolCount: listRow.toolCount ?? null,
        reviewUrl: listRow.reviewUrl ?? null,
      });
    } else {
      vendorNeedsResolve.push(recId);
    }
  }
  fastPath.vendors = {
    fromList: vendorRecIds.length - vendorNeedsResolve.length,
    viaGetVendor: vendorNeedsResolve.length,
  };
}
if (!cache)
  await mapWithConcurrency(vendorNeedsResolve, MCP_CONCURRENCY, async (recId) => {
    let v;
    try {
      v = await callWithRetry('get_vendor', { record_id: recId });
    } catch (err) {
      unresolvedUpstream.push({ kind: 'vendor', recId, error: err.message });
      console.error(`warning: get_vendor(${recId}) failed — ${err.message}`);
      return;
    }
    vendorByRecId.set(recId, {
      recId,
      companyName: v.companyName ?? null,
      supabaseId: v.supabaseId ?? null,
      supabaseSlug: v.supabaseSlug ?? null,
      // `toolCount` is the upstream live-product count — the AECI-685 signal.
      toolCount: v.toolCount ?? upstreamVendorByRecId.get(recId)?.toolCount ?? null,
      reviewUrl: v.reviewUrl ?? null,
    });
  });
const claimedVendors = new Map();
for (const v of vendorByRecId.values()) if (v.supabaseId) claimedVendors.set(v.supabaseId, v);

// 4. Integrations. These rows carry `supabaseId` DIRECTLY, so this axis costs no
//    per-row calls at all.
//
//    Absence semantics, not null: `list_integrations` and `get_integration` run the
//    SAME hydrator upstream (`server/hydrate.ts:687-711`), and the field is omitted
//    from the JSON when the column is empty — so a row without it has never been
//    promoted. Do not conclude from a missing key that the tool cannot return it.
//    The asymmetry used to be on `list_products`, which hand-projected a subset without
//    `supabaseId`; that is why the product axis still carries a `get_product` fallback.
//    Upstream added it on 2026-09-08, so that fallback now fires for a minority of rows
//    rather than all of them — see the fast path above.
const { rows: upstreamIntegrations, total: upstreamIntegrationTotal } = cache
  ? { rows: cache.upstreamIntegrations, total: cache.upstreamIntegrationTotal }
  : await listAll(session, 'list_integrations');

if (!cache) {
  writeFileSync(
    cachePath,
    `${JSON.stringify(
      {
        fetchedAt: new Date().toISOString(),
        cohort: allStatuses ? 'all' : [...RESOLVABLE_STATUSES].join(' | '),
        upstreamProductTotal,
        upstreamVendorTotal,
        upstreamIntegrationTotal,
        upstreamProducts,
        upstreamVendors,
        upstreamIntegrations,
        products: [...productByRecId.values()],
        vendors: [...vendorByRecId.values()],
      },
      null,
      2,
    )}\n`,
  );
}
const claimedIntegrations = new Map();
for (const r of upstreamIntegrations) if (r.supabaseId) claimedIntegrations.set(r.supabaseId, r);

// ─── prod ────────────────────────────────────────────────────────────────────

const d1Products = readD1(
  `SELECT id, slug, name, website, promotion_status, created_at FROM products`,
);
// NOTE: every count here is a GROUP BY aggregate joined in JS, never a correlated
// subquery per row. The obvious `(SELECT count(*) … WHERE c.integration_id = i.id)`
// form over 927 integrations tripped D1's CPU limit outright
// ("D1 DB exceeded its CPU time limit and was reset", code 7429) on 2026-09-07.
const d1Vendors = readD1(
  `SELECT v.id, v.slug, v.company_name AS name, v.promotion_status, v.verified
   FROM vendors v`,
);
const vendorProductCounts = new Map(
  readD1(`SELECT vendor_id, count(*) AS n FROM product_vendors GROUP BY vendor_id`).map((r) => [
    r.vendor_id,
    r.n,
  ]),
);
for (const v of d1Vendors) v.product_count = vendorProductCounts.get(v.id) ?? 0;

const d1Integrations = readD1(
  `SELECT id, name, mechanism_kind, source_product_id, target_product_id,
          built_by_vendor_id, powered_by_product_id
   FROM integrations`,
);
const claimCounts = new Map(
  readD1(`SELECT integration_id, count(*) AS n FROM claims WHERE integration_id IS NOT NULL
          GROUP BY integration_id`).map((r) => [r.integration_id, r.n]),
);
const attestationCounts = new Map(
  readD1(`SELECT c.integration_id AS integration_id, count(*) AS n
          FROM attestations a JOIN claims c ON c.id = a.claim_id
          WHERE c.integration_id IS NOT NULL
          GROUP BY c.integration_id`).map((r) => [r.integration_id, r.n]),
);
for (const i of d1Integrations) {
  i.claim_count = claimCounts.get(i.id) ?? 0;
  i.attestation_count = attestationCounts.get(i.id) ?? 0;
}
// AECI-897: the full projection, not a count. Column mapping mirrors the retraction
// consumer (`scripts/ops/2026-09-retraction-consumer/consume.mjs`), which is the only
// other code in the repo that reads both anchor tables as one shape: endpoints are
// `product_a_id` / `product_b_id`, the mechanism label is `mechanism_name` (no
// `mechanism_kind` column exists here), and the connector is a third product.
const d1EvidencedPairs = readD1(
  `SELECT id, name, mechanism_name, product_a_id, product_b_id,
          connector_product_id, built_by_vendor_id
   FROM connector_evidenced_pairs`,
);
const evidencedPairCount = d1EvidencedPairs.length;
// GROUP BY aggregates joined in JS, for the same reason the `integrations` counts above
// are: the correlated per-row form tripped D1's CPU limit outright on 2026-09-07.
const pairClaimCounts = new Map(
  readD1(`SELECT connector_evidenced_pair_id, count(*) AS n FROM claims
          WHERE connector_evidenced_pair_id IS NOT NULL
          GROUP BY connector_evidenced_pair_id`).map((r) => [r.connector_evidenced_pair_id, r.n]),
);
const pairAttestationCounts = new Map(
  readD1(`SELECT c.connector_evidenced_pair_id AS pair_id, count(*) AS n
          FROM attestations a JOIN claims c ON c.id = a.claim_id
          WHERE c.connector_evidenced_pair_id IS NOT NULL
          GROUP BY c.connector_evidenced_pair_id`).map((r) => [r.pair_id, r.n]),
);
for (const e of d1EvidencedPairs) {
  e.claim_count = pairClaimCounts.get(e.id) ?? 0;
  e.attestation_count = pairAttestationCounts.get(e.id) ?? 0;
}

const productById = new Map(d1Products.map((p) => [p.id, p]));
const vendorById = new Map(d1Vendors.map((v) => [v.id, v]));

// ─── classify ────────────────────────────────────────────────────────────────

const buckets = Object.fromEntries(BUCKETS.map((b) => [b, []]));

// PRODUCTS. Anything the cohort does not claim goes through find_product, which is the
// only read that can see a rejected row — and which also covers the statuses the
// cohort skipped, so skipping them cannot produce a false "deleted".
const unclaimedProducts = d1Products.filter((p) => !claimedProducts.has(p.id));
const reclaimed = [];
await mapWithConcurrency(unclaimedProducts, MCP_CONCURRENCY, async (row) => {
  // No initializer: the catch below returns rather than falling through with an empty
  // list, so every path that reaches the loop has assigned this.
  let matches;
  try {
    const found = await callWithRetry('find_product', {
      name: row.name,
      ...(row.website ? { website: row.website } : {}),
      include_rejected: true,
      limit: 5,
    });
    // Shape: { matches: [{ product: {...}, confidence, reasons }], total } — the
    // record is NESTED under `product`, and that is where promotionStatus lives.
    matches = (found?.matches ?? []).map((m) => ({
      ...m.product,
      confidence: m.confidence ?? null,
      reasons: m.reasons ?? [],
    }));
  } catch (err) {
    // COULD NOT CHECK — so do not classify, and do not let the run report clean.
    //
    // `find_product` is the ONLY read that can tell a deleted upstream record from a
    // rejected one, so a failure here leaves this row genuinely unknown. Falling
    // through with `matches = []` would file it as `productDeletedUpstream`: a phantom
    // finding at exit 1, and — worse — an id in the rollback-ready list that a later
    // authorized retraction is meant to consume verbatim. Returning instead leaves the
    // row unaccounted for, which trips BOTH incompleteness signals (`unresolvedUpstream`
    // here, `reconciles` at the report) and lands the run on exit 2. Same line every
    // other upstream read in this file draws.
    //
    // `d1Id`, not `recId`: the whole point is that no upstream record id was found.
    unresolvedUpstream.push({
      kind: 'product-lookup',
      d1Id: row.id,
      name: row.name,
      error: err.message,
    });
    console.error(
      `warning: find_product("${row.name}") failed — ${err.message}\n` +
        `         ${row.id} is UNCLASSIFIED, not stranded. The sweep is incomplete.`,
    );
    return;
  }

  // Resolve each candidate far enough to see whether it actually points at this row.
  for (const m of matches) {
    const resolved = await resolveProduct(m.id);
    if (resolved?.supabaseId === row.id) {
      // Not stranded after all: the record exists, it is simply in a status the
      // cohort skipped. Record it so the reconciliation still balances.
      claimedProducts.set(row.id, resolved);
      reclaimed.push({
        id: row.id,
        slug: row.slug,
        recordId: resolved.recId,
        promotionStatus: resolved.promotionStatus,
      });
      return;
    }
  }

  const rejected = matches.find((m) => (m.promotionStatus ?? '') === 'rejected');
  const entry = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    promotionStatus: row.promotion_status,
    createdAt: row.created_at,
    url: productUrl(row.slug),
    inAlgolia: row.promotion_status === 'promoted',
    upstream: rejected
      ? {
          recordId: rejected.id ?? null,
          name: rejected.name ?? null,
          promotionStatus: 'rejected',
          confidence: rejected.confidence ?? null,
          reviewUrl: rejected.reviewUrl ?? null,
        }
      : null,
    candidates: matches.map((m) => ({
      recordId: m.id ?? null,
      name: m.name ?? null,
      promotionStatus: m.promotionStatus ?? null,
      confidence: m.confidence ?? null,
      reasons: m.reasons ?? [],
    })),
  };
  if (rejected) buckets.productRejectedUpstream.push(entry);
  else buckets.productDeletedUpstream.push(entry);
});

const strandedProductIds = new Set(
  [...buckets.productRejectedUpstream, ...buckets.productDeletedUpstream].map((e) => e.id),
);

// VENDORS. Two independent signals, deliberately kept apart: a vendor with no products
// is the AECI-685 shape (visible from D1 alone), while an unclaimed vendor is the
// upstream-record-gone shape.
//
// A zero-product vendor is BY CONSTRUCTION outside the resolved cohort (which is built
// from the vendors that promoted products link to), so `claimedVendors` cannot speak
// for it. Fall back to a name match over the full `list_vendors` enumeration — already
// in memory, no extra calls — so the report can distinguish "upstream record still
// exists but now has zero tools" (the real AECI-685 shape) from "record gone".
const normalise = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase();
const upstreamVendorByName = new Map();
for (const v of upstreamVendors) {
  const key = normalise(v.companyName);
  if (key && !upstreamVendorByName.has(key)) upstreamVendorByName.set(key, v);
}

for (const v of d1Vendors) {
  const claimed = claimedVendors.get(v.id) ?? null;
  const byName = claimed ? null : (upstreamVendorByName.get(normalise(v.name)) ?? null);
  const upstream = claimed
    ? claimed
    : byName
      ? {
          recId: byName.id,
          companyName: byName.companyName,
          supabaseId: null,
          toolCount: byName.toolCount ?? null,
          reviewUrl: byName.reviewUrl ?? null,
          matchedBy: 'name',
        }
      : null;
  const entry = {
    id: v.id,
    slug: v.slug,
    name: v.name,
    promotionStatus: v.promotion_status,
    verified: Boolean(v.verified),
    d1ProductCount: v.product_count,
    upstreamToolCount: upstream?.toolCount ?? null,
    url: vendorUrl(v.slug),
    inAlgolia: v.promotion_status === 'promoted',
    upstream: upstream
      ? {
          recordId: upstream.recId,
          name: upstream.companyName,
          reviewUrl: upstream.reviewUrl,
          matchedBy: upstream.matchedBy ?? 'supabaseId',
        }
      : null,
  };
  if (v.product_count === 0) buckets.vendorNoLiveProducts.push(entry);
  else if (!claimed) buckets.vendorSourceGone.push(entry);
}
const strandedVendorIds = new Set(
  [...buckets.vendorNoLiveProducts, ...buckets.vendorSourceGone].map((e) => e.id),
);

// EDGES — BOTH ANCHOR TABLES (AECI-897).
//
// The delivered tier spans two tables and they are summed on every public surface, so a
// sweep over one of them measures half the catalogue while reporting on all of it. The
// classification is identical for both; only the column names and the entry builder
// differ, and both live in `classify.mjs`.
const slugOf = (id) => productById.get(id)?.slug ?? null;
const promotedOf = (id) => productById.get(id)?.promotion_status === 'promoted';
const entryDeps = { slugOf, promotedOf };
const claimedIds = new Set(claimedIntegrations.keys());

const intgClass = classifyRows({
  rows: d1Integrations,
  entryFor: integrationEntry,
  claimedIds,
  strandedProductIds,
  strandedVendorIds,
  endpointsOf: integrationEndpoints,
  deps: entryDeps,
});
buckets.integrationSourceGone.push(...intgClass.sourceGone);
buckets.integrationEndpointStranded.push(...intgClass.endpointStranded);

const pairClass = classifyRows({
  rows: d1EvidencedPairs,
  entryFor: evidencedPairEntry,
  claimedIds,
  strandedProductIds,
  strandedVendorIds,
  endpointsOf: evidencedPairEndpoints,
  deps: entryDeps,
});
buckets.evidencedPairSourceGone.push(...pairClass.sourceGone);
// A pair whose endpoints or connector are stranded is the same defect as an integration
// whose are, so it rides the existing bucket. `table` on every entry is what keeps the
// two distinguishable once they are mixed.
buckets.integrationEndpointStranded.push(...pairClass.endpointStranded);

// DID THE COMPARISON BREAK? If upstream ever stops projecting `supabaseId`, or excludes
// connector-powered edges from `list_integrations`, every pair row goes unclaimed at once.
// That is the check failing, not the catalogue vanishing, and reporting it as N stranded
// rows would point an operator at a live table. Exit 2 — "could not check" — is the same
// line every other upstream read in this file draws.
if (
  comparandLooksBroken({
    tableSize: d1EvidencedPairs.length,
    unclaimed: pairClass.sourceGone.length,
  })
) {
  unresolvedUpstream.push({
    kind: 'comparand',
    error:
      `every one of ${d1EvidencedPairs.length} connector_evidenced_pairs rows is unclaimed ` +
      `by list_integrations. Measured 60/62 CLAIMED on 2026-09-14, so this is far more ` +
      `likely the upstream projection changing than a whole-table retraction. NOT reported ` +
      `as findings — re-check that list_integrations still carries supabaseId for ` +
      `connector-powered edges before trusting any verdict here.`,
  });
}

// Which row on the OTHER table covers the same product pair (AECI-888). Decoration, not
// detection — see `attachTwins`. Runs over every edge finding in one pass.
attachTwins({
  findings: [
    ...buckets.integrationSourceGone,
    ...buckets.integrationEndpointStranded,
    ...buckets.evidencedPairSourceGone,
  ],
  integrationRows: d1Integrations,
  pairRows: d1EvidencedPairs,
});

// ORPHANED CHILDREN. Derived from the three edge buckets — claims and attestations are
// wholly owned by their anchor (`claims.integration_id`, `claims.connector_evidenced_pair_id`
// and `attestations.claim_id` all cascade), so they cannot be stranded independently.
//
// BOTH anchor columns are read (AECI-897). A pair's claims hang off
// `connector_evidenced_pair_id`, so the single-column form reported zero cascade for every
// evidenced finding — understating what a retraction would cost by exactly the rows that
// make it dangerous. `connector_pair_id` is deliberately NOT here: that third arm is the
// REACHABLE tier (AECI-891) and this sweep classifies delivered rows only.
const strandedEdges = [
  ...buckets.integrationSourceGone,
  ...buckets.integrationEndpointStranded,
  ...buckets.evidencedPairSourceGone,
];
const orphanChildren = {
  claims: strandedEdges.reduce((n, e) => n + e.cascade.claims, 0),
  attestations: strandedEdges.reduce((n, e) => n + e.cascade.attestations, 0),
  claimIds: [],
};
if (strandedEdges.length > 0) {
  const inList = strandedEdges.map((e) => lit(e.id)).join(', ');
  orphanChildren.claimIds = readD1(
    `SELECT id, integration_id, connector_evidenced_pair_id FROM claims
     WHERE integration_id IN (${inList}) OR connector_evidenced_pair_id IN (${inList})`,
  );
}

// RETRACTION FOOTPRINT for each stranded product. Same shape as `buildFootprintSql`
// in apps/api/src/lib/retract-product.ts, so the "what would this cost" answer stays
// in lockstep with the tool that would actually perform the retraction.
const strandedProducts = [...buckets.productRejectedUpstream, ...buckets.productDeletedUpstream];
for (const entry of strandedProducts) {
  const p = lit(entry.id);
  // Scoped to ONE product id, so each subquery is index-bounded — unlike the whole-table
  // correlated form above, this is cheap, and the bucket is small by construction.
  const [row] = readD1(`SELECT
    (SELECT count(*) FROM "integrations" WHERE "source_product_id" = ${p} OR "target_product_id" = ${p}) AS integrations,
    (SELECT count(*) FROM "integrations" WHERE "powered_by_product_id" = ${p}) AS powered_by,
    (SELECT count(*) FROM "reviews" WHERE "product_id" = ${p}) AS reviews,
    (SELECT count(*) FROM "page_views" WHERE "product_id" = ${p}) AS page_views,
    (SELECT count(*) FROM "product_vendors" WHERE "product_id" = ${p}) AS product_vendors,
    (SELECT count(*) FROM "product_extensions" WHERE "product_id" = ${p} OR "host_product_id" = ${p}) AS product_extensions;`);
  // Claims/attestations come from the aggregates already in memory, so the deep
  // three-level nesting that tripped the CPU limit is never issued at all.
  const edges = d1Integrations.filter(
    (i) => i.source_product_id === entry.id || i.target_product_id === entry.id,
  );
  entry.cascade = {
    ...row,
    claims: edges.reduce((n, i) => n + i.claim_count, 0),
    attestations: edges.reduce((n, i) => n + i.attestation_count, 0),
  };
}

// ─── pending retractions (AECI-882) ──────────────────────────────────────────
//
// Read the feed on the session this sweep already holds. Every entry is a public row that
// upstream has deleted and this repo still serves, whichever table holds it.
//
// Since AECI-897 the stock buckets cover both anchor tables too, so this bucket is no
// longer the ONLY thing that can see a retracted pair. It is still not redundant: the
// stock buckets are a set difference and can only infer that something went missing,
// while the feed carries the curator's ruling and its reason. Stock and event, not one
// check twice.
//
// `url` is deliberately left unset. The endpoint slugs are not on a journal entry, so
// this sweep cannot resolve a public URL for one without a lookup it has no budget for,
// and guessing would overstate `publiclyReachable`. The consumer resolves the row and
// reports the real cascade; this check only has to say the count is not zero.
{
  const { rows: pending } = await listAll(session, 'list_retractions', {});
  for (const e of pending) {
    buckets.pendingRetractions.push({
      id: e.supabaseId,
      name: e.name,
      // Which repair applies. The consumer handles `integration` only and parks the rest;
      // a `product` entry goes through `ops:retract-product` instead. `vendor` never
      // appears — AECI-685 refuses the upstream delete while a supabase id is attached.
      entity: e.entity ?? null,
      journalEntry: e.id,
      upstreamRecord: e.rowId,
      deletedAt: e.deletedAt,
      reason: e.reason,
      held: HELD_RETRACTIONS[e.supabaseId] ?? null,
    });
  }
  const held = buckets.pendingRetractions.filter((e) => e.held);
  if (held.length) {
    console.log(`\npendingRetractions: ${held.length} held on a recorded decision (not dirty):`);
    for (const e of held) console.log(`  ${e.id}  ${e.held}`);
  }
}

// ─── report ──────────────────────────────────────────────────────────────────

// Held retractions are reported but do not make the run dirty — see HELD_RETRACTIONS.
// Everything else in every bucket does.
const dirty = BUCKETS.some((b) =>
  b === 'pendingRetractions'
    ? buckets[b].some((e) => !HELD_RETRACTIONS[e.id])
    : buckets[b].length > 0,
);

// Every D1 product must be either claimed upstream or in a stranded bucket. If this
// fails a class of row is being dropped on the floor and a clean verdict cannot be
// trusted — so it is reported, not assumed.
const productsAccounted =
  d1Products.filter((p) => claimedProducts.has(p.id)).length +
  buckets.productRejectedUpstream.length +
  buckets.productDeletedUpstream.length;

// The same accounting over the delivered tier (AECI-897). Without it the new axis passes
// VACUOUSLY — which is the exact failure being fixed: a table that is read but never
// reconciled reports clean whether or not the read worked. Every edge row must be either
// claimed upstream or in a source-gone bucket. `integrationEndpointStranded` is NOT a term
// here: those rows ARE claimed, so they are already counted on the left.
const edgesAccounted =
  d1Integrations.filter((i) => claimedIntegrations.has(i.id)).length +
  d1EvidencedPairs.filter((e) => claimedIntegrations.has(e.id)).length +
  buckets.integrationSourceGone.length +
  buckets.evidencedPairSourceGone.length;
const edgeTotal = d1Integrations.length + d1EvidencedPairs.length;

const report = {
  env,
  database: `aeci-app-${env}`,
  source:
    'review-app MCP (list_products + get_product + get_vendor + list_integrations + find_product + list_retractions)',
  // Stamped by the caller's clock, not by anything in the data — this is a snapshot.
  measuredAt: new Date().toISOString(),
  cohort: allStatuses ? 'all listed statuses' : [...RESOLVABLE_STATUSES].join(' | '),
  upstream: {
    products: upstreamProductTotal,
    productsResolved: productByRecId.size,
    vendors: upstreamVendorTotal,
    vendorsResolved: vendorByRecId.size,
    integrations: upstreamIntegrationTotal,
    integrationsCarryingAnId: claimedIntegrations.size,
  },
  prod: {
    products: d1Products.length,
    vendors: d1Vendors.length,
    integrations: d1Integrations.length,
    // In scope since AECI-897, and summed with `integrations` on every public surface.
    connectorEvidencedPairs: evidencedPairCount,
  },
  productsAccounted,
  edgesAccounted,
  edgeTotal,
  reconciles: productsAccounted === d1Products.length && edgesAccounted === edgeTotal,
  // Rows the cohort missed but `find_product` proved are still claimed upstream.
  // Populated once the upstream list projections carry `supabaseId` — see the fast path.
  fastPath,
  reclaimedByFindProduct: reclaimed,
  // Upstream reads the review app could not serve. A non-empty list means the sweep
  // is INCOMPLETE, in either of two ways: a D1 vendor may be listed as stranded purely
  // because its record could not be read, and a D1 product whose `find_product` failed
  // is deliberately left out of every bucket AND out of `productsAccounted`, so it
  // fails `reconciles` too. Never publish a measurement with this non-empty.
  unresolvedUpstream,
  clean: !dirty && unresolvedUpstream.length === 0,
  buckets,
  orphanChildren,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(`\nstranded row audit — aeci-app-${env} vs the review app`);
  console.log(`measured ${report.measuredAt}   cohort: ${report.cohort}\n`);
  console.log(
    `upstream: ${report.upstream.products} products (${report.upstream.productsResolved} resolved), ` +
      `${report.upstream.vendors} vendors (${report.upstream.vendorsResolved} resolved), ` +
      `${report.upstream.integrations} integrations (${report.upstream.integrationsCarryingAnId} carry an id)`,
  );
  console.log(
    `prod:     ${report.prod.products} products, ${report.prod.vendors} vendors, ` +
      `${report.prod.integrations} integrations + ${report.prod.connectorEvidencedPairs} evidenced pairs ` +
      `(${report.edgesAccounted}/${report.edgeTotal} accounted)`,
  );
  // The one line that says whether the upstream `list_products` / `list_vendors` projection
  // has started carrying `supabaseId`. `fromList` climbing off zero is the whole difference
  // between ~8 paged reads and ~300 per-record calls, and it happens with no commit here — so
  // in a scheduled run (AECI-796) this has to be visible in the log rather than inferred from
  // how long the job took. Both halves stay null when the run reused a cache.
  if (fastPath.products || fastPath.vendors) {
    const lane = (f) =>
      f ? `{fromList: ${f.fromList}, viaGet: ${f.viaGetProduct ?? f.viaGetVendor}}` : 'cached';
    console.log(`fastPath: products ${lane(fastPath.products)}, vendors ${lane(fastPath.vendors)}`);
  }
  console.log('');
  for (const b of BUCKETS) console.log(`${pad(b, 30)}${num(buckets[b].length, 6)}`);
  console.log(
    `${pad('orphanChildren', 30)}${num(`${orphanChildren.claims}c / ${orphanChildren.attestations}a`, 6)}\n`,
  );

  for (const b of BUCKETS) {
    if (buckets[b].length === 0) continue;
    console.log(`${b} (${buckets[b].length}):`);
    for (const entry of buckets[b]) console.log(`  ${JSON.stringify(entry)}`);
    console.log('');
  }

  const publiclyReachable = BUCKETS.flatMap((b) => buckets[b]).filter((e) => e.url);
  console.log(`publicly reachable stranded rows: ${publiclyReachable.length}`);
  for (const e of publiclyReachable) {
    console.log(`  ${e.url}${e.inAlgolia ? '  [in search]' : ''}`);
  }

  if (unresolvedUpstream.length > 0) {
    console.log(
      `\nWARNING: ${unresolvedUpstream.length} upstream record(s) could not be read — ` +
        'the sweep is INCOMPLETE and this measurement must not be published. Re-run.',
    );
  }
  if (!report.reconciles) {
    console.log(
      `\nWARNING: ${productsAccounted}/${d1Products.length} products accounted for — ` +
        'a class of row is unclassified and this verdict cannot be trusted.',
    );
  }
  console.log(
    dirty ? '\nRESULT: stranded rows found.' : '\nRESULT: clean — every row is claimed upstream.',
  );
}

const stamp = report.measuredAt.replace(/[:.]/g, '-');
const target = outPath ?? join(HERE, `report-${stamp}.json`);
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);

// The rollback-ready id list: one id per line, grouped by class, so a later authorized
// retraction consumes exactly what this run measured rather than a re-derived set.
// `--ids-out` exists for the same reason `--out` does: this file is production catalog
// content, and the CI caller (AECI-796) writes every artifact to RUNNER_TEMP rather than
// into the checkout. The default stays beside the script for an operator run.
const idListPath = idsOutPath ?? join(HERE, `stranded-ids-${stamp}.txt`);
const idLines = [
  `# stranded row audit — ${report.database} — ${report.measuredAt}`,
  '# READ-ONLY OUTPUT. Retraction is a separate authorized action, and the repair is NOT',
  '# the same for every bucket. Read the class before acting on an id:',
  '#   products     → pnpm --filter @aeci/api ops:retract-product',
  '#   integrations → the datatool POST /api/prune-integrations',
  '#   connector_evidenced_pairs → NO TOOL. Escalate by hand (AECI-897).',
  '#     Neither ops:retract-product nor the datatool prune can touch that table, and',
  '#     the retraction consumer only acts on journal entries, so a strand finding never',
  '#     reaches it. Confirm the ruling upstream, have the curator delete the record so',
  '#     the journal carries it, then let consume.mjs execute it. Do not hand-DELETE:',
  '#     that skips the audit_log row and the count reconcile, which is what made the',
  '#     2026-09-07 cleanup a one-off nobody can replay.',
  '# pendingRetractions is a DIFFERENT class with a different repair — those ids are not',
  '# stranded rows to rule on, they are deletions already ruled on upstream:',
  '#   node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production',
  ...BUCKETS.flatMap((b) =>
    buckets[b].length === 0
      ? []
      : ['', `# ${b} (${buckets[b].length})`, ...buckets[b].map((e) => e.id)],
  ),
];
writeFileSync(idListPath, `${idLines.join('\n')}\n`);

if (!asJson) console.log(`\nreport written to ${target}\nid list written to ${idListPath}`);

// EXIT CODES ARE THREE-VALUED, AND 2 IS NOT A PASS (AECI-796).
//
//   0  clean and complete — every row is claimed upstream
//   1  stranded rows found — at least one bucket is non-empty
//   2  could not check — missing token, bad args, an incomplete sweep, or a crash
//
// `incomplete` outranks `dirty` deliberately. A sweep that could not read part of upstream,
// or whose product classes do not reconcile, produces a bucket list that cannot be trusted in
// EITHER direction: a row may be listed only because its record was unreadable, and a row may
// be missing for the same reason. Reporting that as 1 invites triage of a phantom finding;
// reporting it as 0 is the false-clean this whole issue is about. `report.clean` has always
// accounted for `unresolvedUpstream`; until now the exit code did not, so a run where every
// upstream read failed exited 0.
//
// One case is stronger than "do not trust this": a product whose `find_product` failed is
// left out of every bucket entirely, because the id list beside this report is what an
// authorized retraction consumes verbatim and an unverified id has no business in it. That
// omission is what fails `reconciles`, so the two clauses below are not redundant.
//
// Matches scripts/ci/posthog-liveness-sweep.sh, which draws the same 1-vs-2 line for the same
// reason: "the sweep could not run" is not "the thing being swept is fine".
const incomplete = unresolvedUpstream.length > 0 || !report.reconciles;
process.exit(incomplete ? 2 : dirty ? 1 : 0);
