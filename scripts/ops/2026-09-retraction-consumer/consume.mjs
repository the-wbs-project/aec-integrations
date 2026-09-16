#!/usr/bin/env node
//
// consume.mjs — consume the review app's retraction feed: delete the live AECi rows it
// names, verify they are gone, and only then confirm the journal entries (AECI-882 /
// AECI-811, and AECI-878 folded in as one of the entries).
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
//
// Promote has no delete semantics (`docs/REVIEW_APP_PROMOTE_API.md` §5.1): it can create
// and update rows, never remove one. So when a curator deletes a curation record, the
// live D1 row stays on the public site, and the review app's `supabase_integration_id`
// is the only surviving pointer to it. The review app journals every such delete and
// exposes the journal as `list_retractions`; this repo has never read it.
//
// As of 2026-09-13 that journal holds 216 pending entries, 0 confirmed. 215 resolve to
// `connector_evidenced_pairs` and 1 to `integrations` (AECI-878). All of them render on
// the public site today as delivered integrations.
//
// ─── THE ONE UNSAFE MOVE, AND WHY THE ORDER IS NOT NEGOTIABLE ────────────────
//
// `confirm_retractions` stamps `synced_at`, which drops the entry out of the default
// feed. An entry confirmed but never deleted is a live public row that NOTHING in either
// system can find again: the curation record is gone, so the journal entry is the only
// copy of its `supabaseId`, and confirming discards it. That is unrecoverable, and it is
// the opposite failure from leaving an entry open — an unconfirmed entry is simply
// re-reported forever, and re-deleting an already-deleted row is a no-op.
//
// Enforced structurally: `confirmRetractions()` takes the object `verifyDeleted()`
// returns, `verifyDeleted()` only returns one after re-reading BOTH tables and seeing
// zero rows, and there is exactly one call site. `scripts/ops/**` has no test harness
// (`scripts/ops/2026-09-stranded-row-audit/README.md`), so this is a structural
// guarantee, not a typechecked or unit-tested one. Do not add a second call site.
//
// ─── THE SECOND COHORT SOURCE: --ruling (AECI-916) ───────────────────────────
//
// Everything above describes the JOURNAL cohort, which is the normal one. There is a
// second, and it exists because the journal cannot reach every stranded row.
//
// A journal entry is only written when the deleted upstream record carried a
// `supabase_integration_id`. If that pointer was never stored — the promote created the
// row and returned its id, and the review app did not write the id back — then deleting
// the record upstream journals NOTHING. The live AECi row is now unreachable from both
// sides: no upstream record claims it, and no feed entry names it. The daily strand
// audit's `evidencedPairSourceGone` bucket can SEE such a row, and until this mode existed
// nothing could remove it.
//
// AECI-916 is the worked case and the reason this mode is here. Two Aquifer-powered
// HeavyJob pairs were created by HeavyJob's 2026-09-09 promote
// (`rec8tPLsT5ezww4L3-mttso2i2-5379ce2d`) as the only two `operation: 'created'` rows in a
// 23-integration job. Their ids were in the served ID map and `skipped[]` was empty. The
// write-back did not land. AECI-889 batch 3 then deleted both upstream records, which
// journalled nothing, and the issue's original "confirm upstream → journal → consumer"
// repair path closed at that moment.
//
// So `--ruling <file>` REPLACES the journal read as the cohort. The file names the ids, the
// operator's reason, and the ticket. Everything else in this script is unchanged: both
// tables on resolve and again on verify, the EXPECTED shape pin, the MAX_CASCADE ceiling,
// the sentinel, one `audit_log` row per id, the count repair, the timestamped rollback.
//
// FOUR DIFFERENCES, and each one is a refusal rather than a behaviour change:
//
//   1. `confirm_retractions` is NEVER called. There is no journal entry to confirm, so the
//      script does not open a write session at all. `verifyDeleted()` still gates the run
//      to completion — it is what proves the delete landed — its token simply feeds the
//      report instead of a confirm.
//   2. A ruled id that resolves in NEITHER table is a refusal. In journal mode an absent
//      row is ordinary (`alreadyGone`): the feed is a record of the past and the row may
//      have been taken already. A ruling is a statement about rows the operator has just
//      measured, so an id that is not there means the ruling was written against a state
//      that has moved, which is the same failure `missingHolds` refuses on.
//   3. `--ruling` with a NON-EMPTY journal is a refusal. The two cohorts must never mix.
//      Drain the feed first: journal entries carry `confirm_retractions` obligations that a
//      ruling run would delete the rows for and never discharge, leaving entries pending
//      against rows that no longer exist and an operator re-running the consumer forever.
//   4. `--ruling` with `--confirm-already-gone` or `--detect-only` is a refusal. Both are
//      journal verbs and mean nothing here.
//
// THE RULING FILE (JSON, committed — it IS the ruling record):
//
//   {
//     "issue": "AECI-916",
//     "reason": "<the ruling, in full prose, one copy per audit row>",
//     "rulingSource": "<where the decision came from and how it was established>",
//     "noUpstreamRuling": false,
//     "ids": ["<uuid>", "…"]
//   }
//
// `noUpstreamRuling` is REQUIRED and has no default, deliberately. It is the AECI-795
// distinction — "an upstream ruling exists, it just is not in the journal" versus "nobody
// recorded a ruling anywhere" — and it lands verbatim in every audit row. A default would
// let an operator ship the wrong one of those two without ever deciding.
//
// ─── WHY BOTH TABLES ─────────────────────────────────────────────────────────
//
// A journal entry carries a `supabaseId` and nothing that says which table holds it. The
// AECI-721 migration `0027` moved connector-powered edges out of `integrations` into
// `connector_evidenced_pairs` with their ids VERBATIM, so the same id can be in either.
// 215 of the 216 are in the pairs table, which is why a single-table consumer would
// clear one row and silently conclude the other 215 were already gone — and then confirm
// them. Both tables are read on resolve AND on verify.
//
// ─── AND WHY ONLY THOSE TWO TABLES ───────────────────────────────────────────
//
// The feed journals `entity: 'product' | 'integration' | 'vendor'`. This lane handles the
// integration class ONLY, and step 1b parks the rest rather than running them through a
// resolve that structurally cannot find them. Without that split a `product` entry looks
// exactly like an edge that is already gone, and `--confirm-already-gone` would confirm it
// — discarding the curator's ruling while the live `products` row stays. Parked entries are
// never deleted and never confirmed, so they are simply re-reported until
// `ops:retract-product` takes them.
//
// This is the FIRST code path in the repo that deletes from `connector_evidenced_pairs`.
// Neither the datatool prune (`apps/datatool/src/prune-integrations.ts`, which only
// counts the table for the count repair) nor `apps/api/src/lib/retract-product.ts` can
// touch it. The only precedent is one row, by hand, in
// `scripts/ops/2026-09-roofr-qbo-connector-orphan/README.md`.
//
// ─── WHY A SCRIPT AND NOT THE DATATOOL ───────────────────────────────────────
//
// Same reason as the four retraction lanes before it: `POST /api/prune-integrations` is
// gated by Cloudflare Access or a `TOOL_TOKEN` bearer, neither of which is provisioned in
// an operator workspace, while `CLOUDFLARE_API_TOKEN` is. It also cannot delete an
// evidenced pair at all. This is the fourth route-around; see `apps/datatool/README.md`.
//
// USAGE (from the repo root; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID +
// AECI_MCP_TOKEN — the token is required in BOTH modes, because ruling mode still reads the
// journal to prove it is empty):
//   node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production
//   node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production --apply \
//        --allow-production --confirm-count 214
//   node scripts/ops/2026-09-retraction-consumer/consume.mjs --env production \
//        --ruling scripts/ops/2026-09-retraction-consumer/rulings/aeci-916-heavyjob-aquifer.json
//
// Dry-run by default: it reads, reports, writes `preflight.json` + `rollback.sql` next to
// itself, and changes nothing on either side.
//
// EXIT CODES — three-valued, and 2 is NOT a pass. Same contract as the daily strand
// audit, because the same kind of consumer reads both:
//   0  clean and complete (or: dry run completed, nothing written)
//   1  a refusal, or --detect-only found pending entries
//   2  could not check — missing credential, bad args, incomplete read, or a crash
//
// ONLY `--env production` IS MEANINGFUL. The review app holds PRODUCTION uuids in its
// `supabase*` fields — there is one curation catalog, not one per tier — so pointing this
// at staging/demo/preview resolves nothing and would report all 216 as `alreadyGone`.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listAll, openMcpSession } from './mcp-client.mjs';

// A THROW IS "COULD NOT CHECK", NOT "FOUND NOTHING" — and not "found something" either.
// Node exits 1 on an uncaught throw, which is this script's refusal code. Route every
// unexpected failure to 2 instead, which means exactly one thing: the run did not
// complete, so its verdict is not usable. Registered before any work so it also covers
// the MCP handshake.
for (const signal of ['uncaughtException', 'unhandledRejection']) {
  process.on(signal, (err) => {
    console.error(`\nerror (${signal}): ${err?.stack ?? err}`);
    console.error('the run did not complete — this is NOT a clean result. Exit 2.');
    process.exit(2);
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const API_DIR = join(REPO_ROOT, 'apps', 'api');

const TOOL_PATH = 'scripts/ops/2026-09-retraction-consumer/consume.mjs';
const OPERATOR = 'chrisw@thewbsproject.com';

const D1_ENVS = {
  preview: { db: 'aeci-app-preview', flags: ['--env', 'preview'] },
  staging: { db: 'aeci-app-staging', flags: ['--env', 'staging'] },
  demo: { db: 'aeci-app-demo', flags: ['--env', 'demo'] },
  production: { db: 'aeci-app-production', flags: ['--env', 'production'] },
};

// ─── The editorial half, carried as constants ────────────────────────────────
//
// "Which rows go" is an editorial decision, not something to derive from a query. These
// mirror the operator's standing ruling and the run REFUSES if reality has moved away
// from them, rather than adapting to the new reality on its own.
//
// EVERY NUMBER BELOW IS RE-PINNED PER RUN, AND RESET TO ZERO AFTER IT. The 2026-09-13 run
// (AECI-882) was authorised against a 216-entry feed at a ceiling of 1 / 1; the 2026-09-14
// run (AECI-909) against the 2 entries that run held back, at 21 / 21; the second 2026-09-14
// run (AECI-889 batch 1, Agave) against 17 / 17 / 0 at 169 / 169; the third (AECI-889
// batches 2 + 3, Trimble App Xchange and Aquifer, taken in ONE run) against 21 / 21 / 0 at
// 4 / 4. All four authorisations are spent, so everything is back to zero and the next run
// refuses until an operator measures the cohort in front of them. An authorisation carried
// over from a previous cohort is not a guard — a later cohort of the same shape would match
// it by coincidence. The run record lives in this lane's README; the guard holds only what
// the NEXT run is allowed to do.

/**
 * Entries held back on a recorded decision, keyed by `supabaseId` — the AECi row id,
 * because that is what this script deletes.
 *
 * EMPTY since 2026-09-14 (AECI-909). The two Agave ERP Sync connector pairs that lived
 * here carried all 21 claims in the AECI-852 pairs population, and they were held because
 * the public promote contract had no way to land a claim anchored to a connector pair.
 * Both release conditions that hold named are now met, and neither was taken on trust:
 *
 *   1. AECI-891 reached PRODUCTION on `b5a75c93`, promoted 2026-09-13 23:31 UTC.
 *   2. AECI-910 — which replaced AECI-907 when the cross-repo ticket was split — pushed
 *      the 21 re-anchored claims. Verified against a live apply response reading
 *      `claims created 0, updated 0, unchanged 21, deleted 0, skipped 0`, NOT against a
 *      `complete` status. Zero `kind: claim` entries in `skipped[]`.
 *
 * Measured here against production before the run: 12 claims + 12 attestations on
 * connector pair `recR26YP4tgDvNj6V` (Procore ↔ Foundation) and 9 + 9 on
 * `reczhKqHUJZTSlUI2` (Autodesk Build ↔ Foundation) — the same two product pairs the
 * deleted rows named, so the cohort is superseded rather than lost.
 *
 * A hold is not an exemption in perpetuity. If you add one, name the issue that clears it
 * and give it a release condition that can actually be evaluated. The wording here was
 * corrected once already, because "when AECI-891 ships" would have held these forever:
 * that issue delivers the claim anchor, and the reach-tier render is AECI-716, unbuilt.
 */
const HOLD = {};
const HOLD_REASON =
  "No hold is active. If you add an id to HOLD, replace this string with that entry's " +
  'recorded reason and the issue that clears it — it is written verbatim into ' +
  'preflight-*.json, which is the only place a future operator will look for it.';

/**
 * The production shape this run is authorised against. A mismatch means production moved,
 * and the right response is to stop and re-establish the ruling rather than to delete
 * whatever is there now.
 *
 * ZERO, the resting state. The AECI-809 run pinned it to `3 / 0 / 3` — three native edges
 * retired by the Autodesk Construction Cloud → Forma product merge — and this reset is part
 * of that same change, per the standing rule. Zero is the only pin
 * that fails closed: a shape carried over from the cohort that just ran is not a guard, because
 * a later cohort of the same size matches it by coincidence. The AECI-889 batch-1 run was
 * authorised against `17 / 17 / 0` and the batches 2 + 3 run against `21 / 21 / 0`, and
 * leaving either here would have let the next cohort of that size match by coincidence and
 * pass unruled. AECI-889's I24 batches DO journal deletes — Agave, Trimble App Xchange and
 * Aquifer are done, Kroo and the MindCloud check remain, Zapier is deferred — so the next
 * operator re-measures these three (and `MAX_CASCADE`) from the cohort they actually see.
 * What ran before is in this lane's README, not in the guard.
 *
 * IT BINDS IN RULING MODE TOO, and that is not redundant with `--confirm-count`. The count
 * gate proves the operator knows how many rows the plan holds; this gate proves the rows are
 * in the TABLE the ruling was measured against. A ruling written against two evidenced pairs
 * that now resolve as one pair and one `integrations` row would clear `--confirm-count 2` and
 * fail here, which is right — a cross-table move happened under it and the cascade shape it
 * was measured against no longer holds.
 *
 * `total` counts the INTEGRATION-CLASS cohort, not the raw feed. Parked entries (see step
 * 1b) are outside the cohort and cannot move it; a ruling cohort has none by construction.
 * An empty feed never reaches this gate in journal mode — the run returns at the
 * `feed.length === 0` check well before it.
 */
const EXPECTED = { total: 0, inPairs: 0, inIntegrations: 0 };

/**
 * The cascade ceiling: the most curation data a single run is authorised to let go. ZERO,
 * so any plan that would cascade even one claim refuses until an operator raises it
 * deliberately for a cohort they have measured.
 *
 * It is reset to zero after every run for the same reason `EXPECTED` is. It did NOT move
 * for AECI-916 or for AECI-957: both dry runs read `0 claims, 0 attestations`, which the
 * resting ceiling already permits, and a run that needs no raise should not get one.
 * AECI-809 raised it to `7 / 7`, and that run is the one to read if your cohort is a product
 * MERGE rather than a retirement, because its three rows needed TWO different proofs. Two were
 * collision losers and were proved superseded per pair against the surviving product's edge —
 * compared object by object AND direction by direction, which is what caught one claim widening
 * from `b_to_a` to `both` that a 2 = 2 count match would have hidden. The third was the
 * self-edge BETWEEN the two merging records, and it has no post-merge counterpart by
 * construction: the boundary its claims crossed stops existing. For that row the proof is a
 * named human's ruling that the claims are rename artifacts (AECI-809, 2026-09-15), not a
 * superseding row. Do not generalise that to any row whose counterpart you merely failed to
 * find — it applies to a self-edge of the merge itself and nothing else.
 * AECI-889 batch 1 legitimately raised it to `169 / 169`, the largest this lane has
 * authorised — but that belonged to those 17 ids only. Left at 169 it would have
 * silently pre-authorised 169
 * rulings' worth of cascade for whatever arrives next, which is the one edit in this lane
 * that can destroy data. The batches 2 + 3 run that followed needed only `4 / 4`, which is
 * the same point from the other side: a 21-row cohort is not a bigger cascade than a
 * 17-row one, so the ceiling has to come from the rows, never from the row COUNT.
 *
 * Raising it is a ruling, not a measurement. Before you do: confirm BY COUNT that every
 * claim it will cascade away already exists somewhere else — and confirm it PER PAIR, not
 * in aggregate. A run whose total matches but whose per-pair split does not is a run that
 * destroys rulings on one pair and over-counts another, and the aggregate cannot see it.
 *
 * The AECI-889 batch-1 precedent is the shape to copy. Upstream `reanchor_claims` moved all
 * 169 claims onto reach-tier `connector_pairs` rows through the AECI-891 third claim arm
 * (`claims.connector_pair_id`), and each of the 17 evidenced pairs was joined to its
 * `connector_pairs` twin — via `connector_stub_mappings` on both stubs, same catalogue, same
 * two products — and the two claim counts compared row by row. 169 = 169, zero pairs without
 * a twin, zero twins short. The whole reach population was then re-counted after the delete
 * and read 190 both times. Without that check this guard is the only thing standing between
 * a run and rulings that exist nowhere else on earth.
 *
 * Batches 2 + 3 ran the identical join over all 21 rows even though only ONE carried claims.
 * That is deliberate: 20 rows reading `0 delivered / 0 reach` is evidence, and running the
 * join only on the row you already believe carries claims assumes the delivered count you
 * are trying to check. Every one of the 21 resolved to a twin, and the one live App Xchange
 * pair matched 4 = 4 object for object and direction for direction.
 */
const MAX_CASCADE = { claims: 0, attestations: 0 };

/**
 * The AECI-878 negative sentinel. The upstream ruling that retracted
 * `viewpoint-spectrum → unanet-crm-aec` explicitly preserved the REAL Unanet ↔ Viewpoint
 * edge, which is the Vista one. Asserted present in BOTH orientations before and after —
 * `orphansWithoutATwin`-style checks are orientation-blind, so a one-way query would miss
 * a survivor sitting the other way round.
 */
const SENTINEL_PAIR = ['unanet-crm-aec', 'viewpoint-vista'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids per `IN (…)` list. D1 has real statement limits; 50 is well inside them. */
const ID_CHUNK = 50;
/** Entries per write call. Each chunk is one audit row per id plus its deletes. */
const WRITE_CHUNK = 25;
/** `confirm_retractions` caps `entry_ids` at 200. */
const CONFIRM_CHUNK = 200;

// ─── SQL helpers ─────────────────────────────────────────────────────────────

/**
 * Ids are interpolated, not bound — `wrangler d1 execute` has no bind parameters. That is
 * safe only because every id here came from the review app as a uuid; this assertion is
 * what keeps it that way if the source ever changes.
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

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const num = (v) => (typeof v === 'number' ? v : Number(v ?? 0));

// ─── D1 I/O ──────────────────────────────────────────────────────────────────

/** Read path: one statement, no string literals, so `--command` is safe and cheap. */
function d1Read(target, sql) {
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
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute failed (${res.status}):\n${res.stderr || res.stdout}`);
  }
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`No JSON in wrangler output:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start))[0]?.results ?? [];
}

/**
 * Write path: `--file`, NOT `--command`.
 *
 * The audit rows embed each curator's `reason` verbatim, and those contain semicolons
 * ("…stays live until retracted; this journal entry carries its id"). Verified against a
 * local D1 on 2026-09-13 that wrangler's statement splitter is quote-aware and leaves a
 * semicolon inside a string literal intact, through `--file`. A file also sidesteps argv
 * length limits entirely, which a 25-row audit+delete batch would otherwise flirt with.
 */
function d1Write(target, sql, scratchDir, label) {
  const path = join(scratchDir, `${label}.sql`);
  writeFileSync(path, sql);
  const res = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', target.db, ...target.flags, '--remote', '--json', '--file', path],
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    throw new Error(
      `wrangler d1 execute --file failed (${res.status}):\n${res.stderr || res.stdout}`,
    );
  }
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`No JSON in wrangler output:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start));
}

// ─── The audit row ───────────────────────────────────────────────────────────

/**
 * One `audit_log` row per deleted row, not one summary row per run.
 *
 * ADR 0022 §37 prescribes a single `retention.pruned` summary row for SCHEDULED deletes.
 * This is not that. It is an operator action, and every row carries its OWN editorial
 * ruling in the curator's own words. A summary row would discard 214 distinct rulings
 * that exist nowhere else on earth — the upstream record is deleted, so `reason`,
 * `rowId` and `name` cannot be looked up again from either system once this entry is
 * confirmed. Preserving them here is the single thing the feed makes possible that the
 * daily set-difference sweep cannot.
 *
 * `created_at` is supplied explicitly and is NOT optional: it is NOT NULL with no
 * SQL-level DEFAULT, because `createdAt()` (`apps/api/src/db/schema.ts`) uses Drizzle's
 * `$defaultFn`, which only runs in application code. Omitting it fails with
 * SQLITE_CONSTRAINT_NOTNULL, and inside a multi-statement batch that surfaces as an
 * opaque `{"D1_RESET_DO":true}` with no statement and no constraint name.
 *
 * `action` is 'integration.deleted' for BOTH tables, matching the AECI-593 / 794 / 795
 * rows so the action vocabulary stays queryable. `metadata.table` says which table it
 * actually came from.
 *
 * RULING MODE WRITES A DIFFERENT PROVENANCE BLOCK, NOT A THINNER ONE (AECI-916). There is no
 * journal entry, so `retraction_journal` would be a block of nulls — and a null-filled block
 * reads like a lost record rather than an absent one. It is replaced by `operator_ruling`,
 * carrying the file's issue, reason, source and the committed path, so `metadata.source`
 * alone tells a future auditor which cohort a row came from and where to go next.
 */
function buildAuditInsert({ entry, table, row, cascade, affectedProductIds, ruling }) {
  const beforeState = { table, row, cascade };
  const provenance = ruling
    ? {
        source: 'operator-ruling',
        issue: ruling.issue,
        sub_issue: null,
        // The ruling, verbatim. No upstream record and no journal entry hold these ids any
        // more, so this and the committed file are the only account of why the rows went.
        operator_ruling: {
          issue: ruling.issue,
          reason: ruling.reason,
          ruling_source: ruling.rulingSource,
          ruling_file: ruling.path,
        },
        ruling_source: ruling.rulingSource,
        // Stated by the operator in the ruling file rather than assumed either way.
        no_upstream_ruling: ruling.noUpstreamRuling,
      }
    : {
        source: 'retraction-journal',
        issue: 'AECI-882',
        sub_issue: entry.supabaseId === AECI_878_ID ? 'AECI-878' : 'AECI-811',
        // The feed entry, verbatim. The upstream record is gone; this is the only copy.
        retraction_journal: {
          entry_id: entry.id,
          upstream_record_id: entry.rowId,
          name_as_it_stood: entry.name,
          entity: entry.entity,
          deleted_at: entry.deletedAt,
          carrier_product_ids: entry.carrierProductIds,
          reason: entry.reason,
        },
        ruling_source: `review-app retraction_journal entry ${entry.id} (upstream record ${entry.rowId}), deleted ${entry.deletedAt}`,
        // False for every row in a journal run: each one carries a curator's recorded
        // reason. AECI-795 is the counterexample this field exists for.
        no_upstream_ruling: false,
      };
  const metadata = {
    ...provenance,
    operator: OPERATOR,
    tool: TOOL_PATH,
    table,
    affected_product_ids: affectedProductIds,
    rollback: 'scripts/ops/2026-09-retraction-consumer/rollback-<run stamp>.sql',
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
    sqlLiteral(entry.supabaseId),
    sqlLiteral(JSON.stringify(beforeState)),
    sqlLiteral(JSON.stringify(metadata)),
    sqlLiteral(new Date().toISOString()),
  ];
  return `INSERT INTO "audit_log" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${vals.join(',')});`;
}

/** The one `integrations` entry, named so the audit metadata can attribute it. */
const AECI_878_ID = '6a5fbeab-fa85-4fd7-9088-5bdc04f92fa1';

// ─── The ruling file (AECI-916) ──────────────────────────────────────────────

/**
 * Read and validate an operator ruling. Returns `{ issue, reason, rulingSource,
 * noUpstreamRuling, ids, path }`, or throws — and every throw here lands on exit 2 via the
 * top-level handler, which is right: a malformed ruling is "could not check", not a refusal
 * to act on a well-formed one.
 *
 * VALIDATION IS STRICT BECAUSE THE FILE IS THE ONLY RECORD. In journal mode the curator's
 * reason is fetched live from the feed and cannot be mistyped here. In ruling mode this file
 * is the sole source of the `reason` and `ruling_source` that go into every `audit_log` row,
 * and once the rows are deleted those strings are the only surviving account of why. An
 * empty `reason` would produce two audit rows saying nothing, which is indistinguishable
 * from the hand-DELETE this mode exists to replace.
 *
 * `noUpstreamRuling` must be an actual boolean. `?? false` would be the wrong default in the
 * one direction that matters: it would silently claim an upstream ruling exists for a row
 * whose deletion nobody recorded anywhere, which is the exact assertion AECI-795 refused to
 * make.
 */
function readRulingFile(rulingPath) {
  const abs = isAbsolute(rulingPath) ? rulingPath : join(process.cwd(), rulingPath);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ruling file ${abs}: ${err?.message ?? err}`);
  }

  const str = (field) => {
    const v = parsed?.[field];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`Ruling file ${abs}: "${field}" must be a non-empty string.`);
    }
    return v.trim();
  };

  const issue = str('issue');
  if (!/^AECI-\d+$/.test(issue)) {
    throw new Error(`Ruling file ${abs}: "issue" must look like AECI-123, got "${issue}".`);
  }
  const reason = str('reason');
  const rulingSource = str('rulingSource');

  if (typeof parsed?.noUpstreamRuling !== 'boolean') {
    throw new Error(
      `Ruling file ${abs}: "noUpstreamRuling" must be true or false, explicitly.\n` +
        '  false = an upstream ruling exists, it just never reached the journal.\n' +
        '  true  = nobody recorded a ruling anywhere; the operator is making one (AECI-795).\n' +
        'There is no default: the wrong one of these is a false claim in every audit row.',
    );
  }

  const ids = parsed?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error(`Ruling file ${abs}: "ids" must be a non-empty array.`);
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new Error(`Ruling file ${abs}: "${id}" is not a UUID.`);
    }
  }
  const lowered = ids.map((id) => id.toLowerCase());
  const dupes = lowered.filter((id, i) => lowered.indexOf(id) !== i);
  if (dupes.length) {
    throw new Error(`Ruling file ${abs}: duplicate id(s): ${[...new Set(dupes)].join(', ')}`);
  }

  // Repo-relative when the file is in the repo, absolute otherwise. A ruling SHOULD be
  // committed under `rulings/`, but a scratch file outside the tree must not end up in every
  // audit row as `../../../../../../tmp/x.json`, which names nothing a reader can resolve.
  const rel = relative(REPO_ROOT, abs);
  return {
    issue,
    reason,
    rulingSource,
    noUpstreamRuling: parsed.noUpstreamRuling,
    ids,
    path: rel && !rel.startsWith('..') ? rel : abs,
  };
}

/**
 * Project the ruling onto the same entry shape the feed produces, so every downstream stage
 * — resolve, hold, cascade, sentinel, rollback, audit, verify — runs unchanged.
 *
 * `id` is null and that is load-bearing: it is the JOURNAL ENTRY id, the only thing
 * `confirmRetractions()` accepts, and there is none here. Anything that tried to confirm a
 * ruling cohort would be handing it a list of nulls, which `confirm_retractions` would
 * reject — but the real guarantee is that main() never builds a confirm token in this mode,
 * checked below at the single call site.
 */
function rulingEntries(ruling) {
  return ruling.ids.map((supabaseId) => ({
    id: null,
    entity: 'integration',
    supabaseId,
    rowId: null,
    name: null,
    carrierProductIds: [],
    reason: ruling.reason,
    deletedAt: null,
  }));
}

// ─── The confirm gate ────────────────────────────────────────────────────────

/**
 * Re-read BOTH tables for every id this run deleted, plus the orphan-claim check, and
 * return a verification token only if every one is gone.
 *
 * This is the ONLY producer of the object `confirmRetractions` accepts. Returning `null`
 * rather than throwing is deliberate: the caller must handle "not verified" as a normal
 * outcome and exit 1, because the rows may be half-deleted and the correct response is to
 * leave every entry unconfirmed and let the next run re-report them.
 */
function verifyDeleted(target, deleted) {
  const ids = deleted.map((d) => d.entry.supabaseId);
  if (ids.length === 0) return { entryIds: [], verifiedAt: new Date().toISOString(), count: 0 };

  let leftoverIntegrations = 0;
  let leftoverPairs = 0;
  let orphanClaims = 0;
  for (const part of chunk(ids, ID_CHUNK)) {
    const ph = sqlIdList(part);
    const [row] = d1Read(
      target,
      `SELECT
         (SELECT COUNT(*) FROM integrations WHERE id IN (${ph})) AS i,
         (SELECT COUNT(*) FROM connector_evidenced_pairs WHERE id IN (${ph})) AS p,
         (SELECT COUNT(*) FROM claims
           WHERE integration_id IN (${ph}) OR connector_evidenced_pair_id IN (${ph})) AS c`,
    );
    leftoverIntegrations += num(row?.i);
    leftoverPairs += num(row?.p);
    orphanClaims += num(row?.c);
  }

  console.log(
    `\nverify: integrations left ${leftoverIntegrations}, pairs left ${leftoverPairs}, ` +
      `orphan claims ${orphanClaims} (all must be 0)`,
  );
  if (leftoverIntegrations || leftoverPairs || orphanClaims) return null;

  return {
    entryIds: deleted.map((d) => d.entry.id),
    verifiedAt: new Date().toISOString(),
    count: deleted.length,
  };
}

/**
 * Confirm the journal entries. Takes ONLY the token `verifyDeleted` returns — there is no
 * overload that takes ids. If you are reading this because you want to confirm something
 * without deleting it, re-read this file's header: that is the one unrecoverable move.
 *
 * OPENS ITS OWN SESSION, deliberately. The first production run of this lane (2026-09-13)
 * read the feed, spent ~4 minutes deleting 214 rows across 9 batches, and then died on
 * `fetch failed` at the first confirm: the `mcp-session-id` minted before the delete phase
 * had gone stale. Reusing the read session couples the write's success to how long the
 * delete took, which grows with the size of the feed — the worst possible thing to make
 * fragile, since a failure here leaves rows deleted and entries unconfirmed.
 *
 * That failure was survivable exactly as designed: nothing was confirmed, the feed still
 * listed all 216, and the re-run recognised its own `audit_log` rows and confirmed from
 * the `goneWithOurAudit` bucket. A fresh session removes the need to rely on that.
 */
async function confirmRetractions(verification) {
  if (!verification || !Array.isArray(verification.entryIds)) {
    throw new Error('confirmRetractions requires a token from verifyDeleted(). Refusing.');
  }
  // A ruling cohort has no journal entries, so its synthesised entries carry `id: null`
  // (AECI-916). main() never reaches this function in that mode; this is the belt to that
  // brace, and it throws rather than filtering because a partially-null list means the two
  // cohorts have been mixed somewhere upstream of here.
  if (verification.entryIds.some((id) => typeof id !== 'string' || id === '')) {
    throw new Error(
      'confirmRetractions was handed a non-journal entry id. A ruling cohort must never\n' +
        'be confirmed — there is nothing upstream to acknowledge. Refusing.',
    );
  }
  const session = await openMcpSession();
  const results = [];
  for (const part of chunk(verification.entryIds, CONFIRM_CHUNK)) {
    const res = await session.callWriteTool('confirm_retractions', { entry_ids: part });
    results.push(res);
    console.log(
      `confirm: requested ${part.length}, confirmed ${res?.confirmed?.length ?? res?.confirmed ?? '?'}`,
    );
  }
  return results;
}

// ─── Args ────────────────────────────────────────────────────────────────────

function readValueFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function usage() {
  console.log(`
consume.mjs — consume the review app's retraction feed (AECI-882).

  --env <name>              preview | staging | demo | production (default production)
  --apply                   perform the writes. Dry-run otherwise.
  --allow-production        required on top of --apply when --env production
  --confirm-count <n>       must equal the resolved plan size, or the run refuses
  --detect-only             read and report, exit 1 if anything is pending
  --confirm-already-gone    also confirm integration-class entries whose row is absent with
                            no audit row from this lane. Read the header before using it.
                            Parked (non-integration) entries are never confirmed by it.
  --ruling <file>           OPERATOR-RULING MODE (AECI-916). Take the cohort from a JSON
                            ruling file instead of the retraction journal, for rows no
                            journal entry can ever name. confirm_retractions is never
                            called. Refuses if the journal is non-empty, if a ruled id
                            resolves in neither table, or alongside --detect-only /
                            --confirm-already-gone. See this file's header for the format.
  -h, --help

Exit: 0 clean · 1 refusal or pending found · 2 could not check.
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    usage();
    return 0;
  }
  const envName = readValueFlag(argv, '--env') ?? 'production';
  const target = D1_ENVS[envName];
  if (!target) {
    console.error(`Invalid --env "${envName}". Expected: ${Object.keys(D1_ENVS).join(', ')}.`);
    return 2;
  }
  const apply = argv.includes('--apply');
  const detectOnly = argv.includes('--detect-only');
  const confirmAlreadyGone = argv.includes('--confirm-already-gone');
  const confirmCountRaw = readValueFlag(argv, '--confirm-count');
  const rulingPath = readValueFlag(argv, '--ruling');

  // ─── Ruling-mode flag conflicts, refused before anything is read ───────────
  // Both flags below are JOURNAL verbs. `--detect-only` reports what is pending in the feed,
  // and a ruling cohort is never in the feed. `--confirm-already-gone` confirms entries, and
  // this mode never confirms anything. Silently ignoring either would be worse than
  // refusing: an operator who typed `--confirm-already-gone` believes something upstream is
  // being acknowledged, and nothing would be.
  let ruling = null;
  if (rulingPath !== undefined) {
    if (rulingPath === '' || rulingPath.startsWith('--')) {
      console.error('--ruling requires a file path. Exit 2.');
      return 2;
    }
    if (detectOnly) {
      console.error('--ruling and --detect-only are mutually exclusive: a ruling cohort is');
      console.error('never in the feed, so there is nothing for detect-only to detect.');
      return 1;
    }
    if (confirmAlreadyGone) {
      console.error('--ruling and --confirm-already-gone are mutually exclusive: ruling mode');
      console.error('never calls confirm_retractions, so the flag would silently do nothing.');
      return 1;
    }
    ruling = readRulingFile(rulingPath);
  }

  if (apply && envName === 'production' && !argv.includes('--allow-production')) {
    console.error('Refusing to write PRODUCTION without --allow-production.');
    return 1;
  }
  if (!process.env.AECI_MCP_TOKEN) {
    console.error('AECI_MCP_TOKEN is not set — the feed cannot be read. Exit 2.');
    return 2;
  }
  if (!process.env.CLOUDFLARE_API_TOKEN && !process.env.CLOUDFLARE_ACCOUNT_ID) {
    console.error('Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (or `wrangler login`).');
    return 2;
  }
  if (envName !== 'production') {
    console.warn(
      `\nWARNING: --env ${envName}. The review app holds PRODUCTION uuids, so every entry\n` +
        'will resolve to nothing here. Only --env production is meaningful.\n',
    );
  }

  console.log(
    `# ${ruling ? `${ruling.issue} operator ruling` : 'AECI-882 retraction'} consumer — ` +
      `${target.db} (${apply ? 'APPLY' : detectOnly ? 'detect-only' : 'dry-run'})\n`,
  );
  if (ruling) {
    console.log(`ruling file: ${ruling.path}`);
    console.log(`  issue:              ${ruling.issue}`);
    console.log(`  ids:                ${ruling.ids.length}`);
    console.log(`  noUpstreamRuling:   ${ruling.noUpstreamRuling}`);
    console.log(`  rulingSource:       ${ruling.rulingSource}`);
    console.log(`  reason:             ${ruling.reason}\n`);
  }

  // ─── 1. Read the feed ──────────────────────────────────────────────────────
  //
  // Read in BOTH modes. In journal mode it is the cohort. In ruling mode it is the
  // mixing guard: a ruling run that deleted rows while entries were pending would leave
  // those entries un-confirmable against rows that no longer exist, and the next journal run
  // would route them through `goneUnexplained` — where only `--confirm-already-gone`, the
  // one flag ruling mode forbids, could clear them. Drain the feed first, always.
  const session = await openMcpSession();
  const { rows: feed, total } = await listAll(session, 'list_retractions', {});
  console.log(`feed: ${feed.length} pending entries (server total ${total})`);
  if (feed.length !== total) {
    console.error(`Drained ${feed.length} but the server reports ${total}. Incomplete read.`);
    return 2;
  }

  let entries;
  let parked = [];

  if (ruling) {
    if (feed.length > 0) {
      console.error(`\nRefusing: --ruling was given but the retraction journal holds`);
      console.error(`${feed.length} pending entries. The two cohorts must never mix.`);
      console.error('Drain the feed first with an ordinary run, then re-run with --ruling.');
      return 1;
    }
    console.log('feed is empty, so the ruling cohort cannot collide with a journal one.\n');
    entries = rulingEntries(ruling);
    console.log(`ruling cohort: ${entries.length} ids`);
  } else {
    if (feed.length === 0) {
      // An empty feed is a RESULT, not silence. This line is what makes a quiet run
      // distinguishable from a run that never happened.
      console.log('\nFeed is empty: nothing pending. The public site matches the review app.');
      return 0;
    }
    const missingId = feed.filter((e) => !e.supabaseId);
    if (missingId.length) {
      console.error(`${missingId.length} entries carry no supabaseId — cannot resolve. Exit 2.`);
      return 2;
    }
  }

  // ─── 1b. Park everything that is not an integration-class entry ────────────
  //
  // The feed journals `entity: 'product' | 'integration' | 'vendor'`, not just edges.
  // This lane resolves a `supabaseId` against `integrations` + `connector_evidenced_pairs`
  // and NOTHING else, so a `product` entry resolves to nothing here — which is
  // indistinguishable, at this layer, from an edge that is already gone.
  //
  // That mattered in exactly one direction. Such an entry would land in `alreadyGone`,
  // then in `goneUnexplained`, and `--confirm-already-gone` would CONFIRM it: `synced_at`
  // stamped, entry out of the feed, curator `reason` and upstream record id gone forever,
  // while the live `products` row it names is untouched. The row itself is still findable
  // (the daily sweep's `productDeletedUpstream` bucket is a stock check and sees products),
  // so the loss is the RULING, which is the one thing §4 of ADR 0030 says this lane exists
  // to preserve.
  //
  // So they are parked, never resolved and never confirmed. Leaving them pending is the
  // harmless direction: they are re-reported every run until the right tool takes them
  // (`pnpm --filter @aeci/api ops:retract-product` for a product; a vendor never appears —
  // AECI-685 refuses the upstream delete while a supabase id is attached).
  //
  // A MISSING `entity` is parked too, deliberately. If the upstream projection ever drops
  // the field this run does nothing at all and says so, rather than deleting rows whose
  // class it can no longer establish.
  //
  // RULING MODE SKIPS THIS SPLIT, because there is nothing to split: `rulingEntries()` mints
  // `entity: 'integration'` on every id by construction. The class question the feed poses —
  // "is this a product, an edge, or a vendor?" — is answered here by the resolve step
  // instead, which refuses outright if a ruled id is in neither delivered-tier table. That
  // is strictly stricter than parking: a ruled product id stops the run rather than being
  // quietly set aside.
  if (!ruling) {
    entries = feed.filter((e) => e.entity === 'integration');
    parked = feed.filter((e) => e.entity !== 'integration');
  }
  if (parked.length) {
    console.warn(`\nparked: ${parked.length} entries are not integration-class. Not this lane's`);
    console.warn('work — they are neither deleted nor confirmed, so they stay in the feed.');
    console.table(
      parked.map((e) => ({
        id: e.supabaseId,
        entry: e.id,
        entity: e.entity ?? '(absent)',
        name: e.name,
      })),
    );
    console.warn('  product → pnpm --filter @aeci/api ops:retract-product');
  }
  if (entries.length === 0) {
    console.log('\nNothing integration-class is pending. Nothing for this lane to do.');
    return parked.length > 0 ? 1 : 0;
  }

  // ─── 2. Resolve against BOTH tables ────────────────────────────────────────
  const byId = new Map(entries.map((e) => [String(e.supabaseId).toLowerCase(), e]));
  const allIds = entries.map((e) => e.supabaseId);

  const integrationRows = [];
  const pairRows = [];
  for (const part of chunk(allIds, ID_CHUNK)) {
    const ph = sqlIdList(part);
    integrationRows.push(
      ...d1Read(
        target,
        `SELECT i.id AS id, s.slug AS aSlug, t.slug AS bSlug, i.name AS name,
                i.mechanism_kind AS mechanismKind, i.source_product_id AS p1,
                i.target_product_id AS p2, NULL AS p3,
                (SELECT COUNT(*) FROM claims WHERE integration_id = i.id) AS claims,
                (SELECT COUNT(*) FROM attestations WHERE claim_id IN
                   (SELECT id FROM claims WHERE integration_id = i.id)) AS attestations
           FROM integrations i
           LEFT JOIN products s ON s.id = i.source_product_id
           LEFT JOIN products t ON t.id = i.target_product_id
          WHERE i.id IN (${ph})`,
      ),
    );
    pairRows.push(
      ...d1Read(
        target,
        `SELECT e.id AS id, a.slug AS aSlug, b.slug AS bSlug, e.name AS name,
                e.mechanism_name AS mechanismKind, e.product_a_id AS p1,
                e.product_b_id AS p2, e.connector_product_id AS p3,
                (SELECT COUNT(*) FROM claims WHERE connector_evidenced_pair_id = e.id) AS claims,
                (SELECT COUNT(*) FROM attestations WHERE claim_id IN
                   (SELECT id FROM claims WHERE connector_evidenced_pair_id = e.id)) AS attestations
           FROM connector_evidenced_pairs e
           LEFT JOIN products a ON a.id = e.product_a_id
           LEFT JOIN products b ON b.id = e.product_b_id
          WHERE e.id IN (${ph})`,
      ),
    );
  }

  const resolved = new Map();
  for (const r of integrationRows)
    resolved.set(String(r.id).toLowerCase(), { table: 'integrations', row: r });
  for (const r of pairRows) {
    const k = String(r.id).toLowerCase();
    if (resolved.has(k)) {
      // Both tables hold this id. That contradicts the AECI-721 single-table invariant
      // and means a delete would be ambiguous. Stop; do not guess which one goes.
      console.error(`\nid ${r.id} is present in BOTH tables. That violates the AECI-721`);
      console.error('single-table invariant and this run cannot decide which row goes. Exit 2.');
      return 2;
    }
    resolved.set(k, { table: 'connector_evidenced_pairs', row: r });
  }

  const inIntegrations = [];
  const inPairs = [];
  const alreadyGone = [];
  for (const [k, entry] of byId) {
    const hit = resolved.get(k);
    if (!hit) alreadyGone.push({ entry });
    else if (hit.table === 'integrations') inIntegrations.push({ entry, ...hit });
    else inPairs.push({ entry, ...hit });
  }

  console.log(
    `resolve: integrations ${inIntegrations.length}, connector_evidenced_pairs ${inPairs.length}, ` +
      `already gone ${alreadyGone.length}`,
  );

  // ─── 2a. Ruling mode: an unresolvable id is a REFUSAL, not a bucket ────────
  //
  // In journal mode an absent row is ordinary. The feed is a record of the past, so the row
  // may have been taken by an earlier run, by `ops:retract-product`, or by a cross-table
  // move — which is why step 2b exists to tell those apart.
  //
  // A ruling is the opposite kind of statement: it names rows the operator measured, now, and
  // ruled on. An id that resolves to nothing means the file was written against a state that
  // has already moved, and the same reasoning that refuses a `HOLD` entry missing from the
  // plan applies with more force here — a hold that misses only fails to protect a row, while
  // a ruling that misses means the operator is authorising a delete whose target they cannot
  // see. It also catches the two cheap mistakes this mode invites: a typo'd uuid, and an id
  // pasted from an audit report of rows that are already gone.
  if (ruling && alreadyGone.length) {
    console.error(`\nRefusing: ${alreadyGone.length} ruled id(s) resolve in NEITHER table:`);
    for (const g of alreadyGone) console.error(`  ${g.entry.supabaseId}`);
    console.error(
      '\nA ruling names rows that exist. An id that resolves to nothing means the file was\n' +
        'written against a state that has moved, or the id is wrong. Re-measure and re-rule.',
    );
    return 1;
  }

  const shapeOk =
    entries.length === EXPECTED.total &&
    inPairs.length === EXPECTED.inPairs &&
    inIntegrations.length === EXPECTED.inIntegrations;
  if (!shapeOk) {
    console.warn(
      `\nSHAPE MISMATCH. Authorised against integration-class total ${EXPECTED.total} / pairs ` +
        `${EXPECTED.inPairs} / integrations ${EXPECTED.inIntegrations}.\n` +
        'Production has moved since the ruling these numbers were pinned against.',
    );
  }

  // ─── 2b. Split alreadyGone on whether WE deleted it ────────────────────────
  // A crashed earlier run of this lane leaves rows deleted but entries unconfirmed. Those
  // are provably safe to confirm, because this lane's own audit row is the proof. An
  // absent row with NO such audit row is something else entirely and is never confirmed
  // without the explicit flag.
  const goneWithOurAudit = [];
  const goneUnexplained = [];
  if (alreadyGone.length) {
    const auditedIds = new Set();
    for (const part of chunk(
      alreadyGone.map((g) => g.entry.supabaseId),
      ID_CHUNK,
    )) {
      const ph = sqlIdList(part);
      for (const r of d1Read(
        target,
        `SELECT DISTINCT entity_id AS id FROM audit_log
          WHERE entity_id IN (${ph}) AND action = 'integration.deleted'
            AND json_extract(metadata, '$.tool') = '${TOOL_PATH}'`,
      )) {
        auditedIds.add(String(r.id).toLowerCase());
      }
    }
    for (const g of alreadyGone) {
      if (auditedIds.has(String(g.entry.supabaseId).toLowerCase())) goneWithOurAudit.push(g);
      else goneUnexplained.push(g);
    }
    console.log(
      `  already gone: ${goneWithOurAudit.length} deleted by this lane (safe to confirm), ` +
        `${goneUnexplained.length} unexplained`,
    );
  }

  // ─── 3. Apply the hold list ────────────────────────────────────────────────
  const live = [...inIntegrations, ...inPairs];
  const held = [];
  const plan = [];
  for (const item of live) {
    if (HOLD[item.entry.supabaseId]) held.push(item);
    else plan.push(item);
  }
  const missingHolds = Object.keys(HOLD).filter(
    (id) => !live.some((l) => l.entry.supabaseId === id),
  );

  console.log(`\nplan: ${plan.length} to delete, ${held.length} held`);
  console.table(
    held.map((h) => ({
      id: h.entry.supabaseId,
      name: h.entry.name,
      table: h.table,
      claims: num(h.row.claims),
      attestations: num(h.row.attestations),
    })),
  );
  if (missingHolds.length) {
    console.error(
      `\n${missingHolds.length} held id(s) are NOT in the resolved plan:\n  ${missingHolds.join('\n  ')}\n` +
        'The hold list was written against a state that no longer exists. Refusing.',
    );
    return 1;
  }

  // ─── 3b. The cascade ceiling ───────────────────────────────────────────────
  const cascade = plan.reduce(
    (acc, p) => ({
      claims: acc.claims + num(p.row.claims),
      attestations: acc.attestations + num(p.row.attestations),
    }),
    { claims: 0, attestations: 0 },
  );
  const withClaims = plan.filter((p) => num(p.row.claims) > 0);
  console.log(`cascade: ${cascade.claims} claims, ${cascade.attestations} attestations`);
  if (withClaims.length) {
    console.log('rows in the plan that carry claims:');
    console.table(
      withClaims.map((p) => ({
        id: p.entry.supabaseId,
        name: p.entry.name,
        table: p.table,
        claims: num(p.row.claims),
        attestations: num(p.row.attestations),
      })),
    );
  }

  // ─── 4. Affected products, sentinel, rollback ──────────────────────────────
  const affectedByEntry = new Map();
  const affected = new Set();
  for (const p of plan) {
    const ids = [p.row.p1, p.row.p2, p.row.p3].filter(Boolean).map(String);
    affectedByEntry.set(p.entry.supabaseId, ids);
    for (const id of ids) affected.add(id);
  }
  console.log(`affected products: ${affected.size}`);

  const sentinelBefore = readSentinel(target);
  console.log('\nAECI-878 negative sentinel (unanet-crm-aec ↔ viewpoint-vista), must survive:');
  console.table(sentinelBefore);
  if (sentinelBefore.length === 0) {
    console.error('\nThe sentinel edge is absent. That is not the state this ruling was made');
    console.error('against — the AECI-878 ruling explicitly preserved it. Refusing.');
    return 1;
  }

  // Artifact names are TIMESTAMPED, never stable.
  //
  // The first production run (2026-09-13) wrote `rollback.sql` with all 214 row bodies,
  // died at the confirm step, and the recovery run — whose plan was empty — overwrote it
  // with a 13-line stub. The undo for a completed destructive run was destroyed by a
  // later run of the same script. A stable filename is fine for a lane that runs once;
  // this one is designed to be re-run, so it must never clobber.
  //
  // Nothing is written when the plan is empty: there is nothing to roll back, and a stub
  // file that LOOKS like a rollback is worse than no file.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rollbackPath = plan.length ? writeRollback(target, plan, stamp, ruling) : null;
  console.log(
    rollbackPath ? `rollback written: ${rollbackPath}` : 'rollback: skipped (empty plan)',
  );

  const preflight = {
    issue: ruling ? ruling.issue : 'AECI-882',
    mode: ruling ? 'operator-ruling' : 'retraction-journal',
    tool: TOOL_PATH,
    env: envName,
    db: target.db,
    at: new Date().toISOString(),
    // Written verbatim so the preflight is self-contained: a future operator reading only
    // this file sees the whole ruling, not a path they then have to resolve at some commit.
    ruling: ruling
      ? {
          file: ruling.path,
          issue: ruling.issue,
          reason: ruling.reason,
          rulingSource: ruling.rulingSource,
          noUpstreamRuling: ruling.noUpstreamRuling,
          ids: ruling.ids,
        }
      : null,
    feed: {
      pending: feed.length,
      serverTotal: total,
      integrationClass: entries.length,
      parked: parked.map((e) => ({ id: e.supabaseId, entry: e.id, entity: e.entity ?? null })),
    },
    resolve: {
      inIntegrations: inIntegrations.length,
      inPairs: inPairs.length,
      alreadyGone: alreadyGone.length,
      goneWithOurAudit: goneWithOurAudit.length,
      goneUnexplained: goneUnexplained.length,
    },
    expected: EXPECTED,
    shapeOk,
    planned: plan.length,
    held: held.map((h) => ({
      id: h.entry.supabaseId,
      entry: h.entry.id,
      name: h.entry.name,
      claims: num(h.row.claims),
      attestations: num(h.row.attestations),
      reason: HOLD_REASON,
    })),
    cascade,
    maxCascade: MAX_CASCADE,
    affectedProducts: affected.size,
    sentinel: { pair: SENTINEL_PAIR, before: sentinelBefore },
  };
  const preflightPath = join(HERE, `preflight-${stamp}.json`);
  writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`);
  console.log(`preflight written: ${preflightPath}`);

  if (detectOnly) {
    console.log(
      `\nDetect-only: ${feed.length} entries pending (${entries.length} integration-class, ` +
        `${parked.length} parked). Nothing written.`,
    );
    return feed.length > 0 ? 1 : 0;
  }

  if (!apply) {
    console.log(`\nDry run. Nothing was written to D1 or to the review app.`);
    console.log(
      `Re-run with: ${ruling ? `--ruling ${ruling.path} ` : ''}--apply --allow-production ` +
        `--confirm-count ${plan.length}`,
    );
    return 0;
  }

  // ─── 5. Gates that only bind on --apply ────────────────────────────────────
  // The shape gate binds only when there is something to DELETE. It exists to stop a
  // destructive run against data that has moved since the ruling; a run with an empty
  // plan destroys nothing, and refusing it would block the one recovery path that matters
  // — confirming entries whose rows this lane already deleted. That is not hypothetical:
  // the first production run died between the delete and the confirm, and the recovery
  // run legitimately saw a shape of 216 pending / 2 live / 214 already gone.
  if (plan.length > 0 && !shapeOk) {
    console.error('\nRefusing to apply against a shape that does not match the recorded ruling.');
    return 1;
  }
  if (cascade.claims > MAX_CASCADE.claims || cascade.attestations > MAX_CASCADE.attestations) {
    console.error(
      `\nCascade ceiling exceeded: ${cascade.claims} claims / ${cascade.attestations} attestations ` +
        `against a ceiling of ${MAX_CASCADE.claims} / ${MAX_CASCADE.attestations}.\n` +
        'A row nobody has ruled on is about to lose curation data. Refusing.',
    );
    return 1;
  }
  const confirmCount = Number(confirmCountRaw);
  if (!Number.isInteger(confirmCount)) {
    console.error(`\n--confirm-count is required to apply. The plan is ${plan.length} rows.`);
    return 1;
  }
  if (confirmCount !== plan.length) {
    console.error(
      `\n--confirm-count ${confirmCount} does not match the resolved plan of ${plan.length}.\n` +
        'The feed moved between the dry run and this one. Re-read it before applying.',
    );
    return 1;
  }

  // ─── 6. Execute ────────────────────────────────────────────────────────────
  const scratch = mkdtempSync(join(tmpdir(), 'aeci-retract-'));
  const deleted = [];
  const batches = chunk(plan, WRITE_CHUNK);
  console.log(`\nDeleting ${plan.length} rows in ${batches.length} batches…`);

  for (const [i, batch] of batches.entries()) {
    const sql = [];
    for (const p of batch) {
      sql.push(
        buildAuditInsert({
          entry: p.entry,
          table: p.table,
          row: p.row,
          cascade: { claims: num(p.row.claims), attestations: num(p.row.attestations) },
          affectedProductIds: affectedByEntry.get(p.entry.supabaseId) ?? [],
          ruling,
        }),
      );
    }
    // Child → parent, per table. Explicit because D1 does not guarantee FK enforcement is
    // on for a given `wrangler d1 execute`, so this works the same with cascades on or off.
    const intIds = batch.filter((p) => p.table === 'integrations').map((p) => p.entry.supabaseId);
    const pairIds = batch
      .filter((p) => p.table === 'connector_evidenced_pairs')
      .map((p) => p.entry.supabaseId);
    if (intIds.length) {
      const ph = sqlIdList(intIds);
      sql.push(
        `DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph}));`,
        `DELETE FROM claims WHERE integration_id IN (${ph});`,
        `DELETE FROM integrations WHERE id IN (${ph});`,
      );
    }
    if (pairIds.length) {
      const ph = sqlIdList(pairIds);
      sql.push(
        `DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE connector_evidenced_pair_id IN (${ph}));`,
        `DELETE FROM claims WHERE connector_evidenced_pair_id IN (${ph});`,
        `DELETE FROM connector_evidenced_pairs WHERE id IN (${ph});`,
      );
    }
    d1Write(target, `${sql.join('\n')}\n`, scratch, `delete-${i}`);
    deleted.push(...batch);
    console.log(
      `  batch ${i + 1}/${batches.length}: ${batch.length} rows (${deleted.length} total)`,
    );
  }

  // ─── 7. Count repair + updated_at bump ─────────────────────────────────────
  // The AECI-721 rule: DELIVERED edges regardless of which table holds them. Omitting the
  // `connector_evidenced_pairs` term would write the pre-AECI-721 answer back over a
  // correct count. `powered_by_product_id` is NOT in the expression, matching
  // `computeExpected` in `apps/api/src/lib/recompute-counts.ts`.
  //
  // `updated_at` is bumped so the 08:00 incremental Algolia sync's watermark window picks
  // these products up and the corrected count reaches their index records —
  // `reconcile-product-counts.ts` does not bump it, which is the residue the Roofr lane
  // recorded. The bump also moves each page's sitemap `<lastmod>`, which is correct: the
  // content genuinely changed.
  const now = new Date().toISOString();
  const productIds = [...affected];
  console.log(
    `\nRepairing integration_count + bumping updated_at on ${productIds.length} products…`,
  );
  for (const [i, part] of chunk(productIds, WRITE_CHUNK).entries()) {
    const sql = part
      .map(
        (pid) =>
          `UPDATE products SET integration_count =
             ((SELECT COUNT(*) FROM integrations WHERE source_product_id = '${pid}' OR target_product_id = '${pid}')
              + (SELECT COUNT(*) FROM connector_evidenced_pairs
                   WHERE product_a_id = '${pid}' OR product_b_id = '${pid}' OR connector_product_id = '${pid}')),
             updated_at = '${now}'
           WHERE id = '${pid}';`,
      )
      .join('\n');
    d1Write(target, `${sql}\n`, scratch, `counts-${i}`);
  }

  // ─── 8. Verify ─────────────────────────────────────────────────────────────
  const sentinelAfter = readSentinel(target);
  const sentinelIntact =
    sentinelAfter.length === sentinelBefore.length &&
    sentinelBefore.every((b) => sentinelAfter.some((a) => String(a.id) === String(b.id)));
  console.log('\nsentinel after:');
  console.table(sentinelAfter);
  if (!sentinelIntact) {
    console.error('\nThe AECI-878 sentinel edge changed. Refusing to confirm anything. Exit 1.');
    return 1;
  }

  const verification = verifyDeleted(target, deleted);
  if (!verification) {
    console.error('\nVerification FAILED. Rows may be half-deleted.');
    console.error('NOTHING has been confirmed upstream, so every entry is still in the feed');
    console.error('and a re-run will re-report it. That is the safe side of this failure.');
    return 1;
  }

  // ─── 9. Confirm — only now, and never in ruling mode ───────────────────────
  //
  // This is the one call site, and the `if` is the whole difference between the two modes.
  // A ruling cohort has no journal entries, so there is nothing upstream to acknowledge and
  // no write session is opened at all — the MCP token is read-only for the entire run.
  // `verifyDeleted()` still ran above and still had to pass; its token feeds the report
  // rather than a confirm. That ordering is deliberate: the verify is what proves the delete
  // landed, and it is load-bearing in both modes even though only one of them confirms.
  let confirmedCount = 0;
  if (ruling) {
    console.log('\nRuling mode: no journal entries to confirm. Nothing is written upstream.');
  } else {
    const toConfirm = [...deleted];
    for (const g of goneWithOurAudit) toConfirm.push(g);
    if (confirmAlreadyGone) toConfirm.push(...goneUnexplained);
    const confirmToken = {
      ...verification,
      entryIds: toConfirm.map((d) => d.entry.id),
      count: toConfirm.length,
    };
    console.log(`\nConfirming ${confirmToken.entryIds.length} journal entries…`);
    await confirmRetractions(confirmToken);
    confirmedCount = confirmToken.entryIds.length;
  }

  // ─── 10. Report ────────────────────────────────────────────────────────────
  const after = d1Read(
    target,
    `SELECT
       (SELECT COUNT(*) FROM integrations) AS integrations,
       (SELECT COUNT(*) FROM connector_evidenced_pairs) AS pairs,
       (SELECT COUNT(*) FROM claims) AS claims,
       (SELECT COUNT(*) FROM attestations) AS attestations`,
  );
  console.log('\nafter:');
  console.table(after);
  console.log(
    `\nDone. ${deleted.length} rows deleted, ${held.length} held, ` +
      `${confirmedCount} entries confirmed` +
      `${ruling ? ` (ruling mode — nothing to confirm, ${ruling.issue})` : ''}.`,
  );
  console.log("\nNext, from this directory's README:");
  console.log(
    '  1. measure + purge Algolia orphans (the nightly sweep caps at 50 and will refuse)',
  );
  console.log(
    '  2. RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production',
  );
  console.log('  3. POST /admin/purge with the tags the README lists');
  return 0;
}

/** The sentinel pair, queried in BOTH orientations across BOTH tables. */
function readSentinel(target) {
  const [a, b] = SENTINEL_PAIR.map((s) => `'${s}'`);
  return d1Read(
    target,
    `SELECT i.id AS id, s.slug AS aSlug, t.slug AS bSlug, i.mechanism_kind AS kind, 'integrations' AS src
       FROM integrations i
       JOIN products s ON s.id = i.source_product_id
       JOIN products t ON t.id = i.target_product_id
      WHERE s.slug IN (${a},${b}) AND t.slug IN (${a},${b})
      UNION ALL
     SELECT e.id AS id, pa.slug AS aSlug, pb.slug AS bSlug, e.mechanism_name AS kind, 'pairs' AS src
       FROM connector_evidenced_pairs e
       JOIN products pa ON pa.id = e.product_a_id
       JOIN products pb ON pb.id = e.product_b_id
      WHERE pa.slug IN (${a},${b}) AND pb.slug IN (${a},${b})`,
  );
}

/**
 * Rollback SQL, written on the dry run too — D1 has no undo at the statement level.
 *
 * The database-level undo that DOES exist is Cloudflare D1 Time Travel, which keeps a
 * 30-day window and restores the WHOLE database to a bookmark rather than selected rows.
 * That is the backstop when this file is missing; see the lane README for the bookmark
 * captured before the 2026-09-13 run.
 *
 * Replay order is parent → child so the FKs hold, and `INSERT OR IGNORE` makes a re-run
 * safe. `claims.anchor_id` is omitted on purpose: it is a STORED generated column
 * (AECI-721) and SQLite refuses an INSERT that supplies it.
 *
 * Read the caveat in the emitted file before replaying it. Recreating these rows restores
 * the STRANDED state, not curator control — no upstream record carries these ids any
 * more, so nothing can ever update or re-delete them through a promote.
 */
function writeRollback(target, plan, stamp, ruling) {
  const intIds = plan.filter((p) => p.table === 'integrations').map((p) => p.entry.supabaseId);
  const pairIds = plan
    .filter((p) => p.table === 'connector_evidenced_pairs')
    .map((p) => p.entry.supabaseId);

  const lines = [
    ruling
      ? `-- Rollback for the ${ruling.issue} operator-ruling run of the retraction consumer.`
      : '-- Rollback for the AECI-882 retraction-consumer run.',
    '-- Replay order is parent -> child so the FKs hold; INSERT OR IGNORE makes re-runs safe.',
    '-- `claims.anchor_id` is omitted on purpose: it is a STORED generated column (AECI-721)',
    '-- and SQLite refuses an INSERT that supplies it.',
    '--',
    '-- Recreating these rows does NOT restore integration_count: re-run',
    '--   RECONCILE_ENV=production pnpm --filter @aeci/api db:reconcile-counts -- --fix --allow-production',
    '--',
    '-- AND NOTE WHAT REPLAYING THIS ACTUALLY RESTORES: the STRANDED state, not curator',
    '-- control. Every id below was deleted UPSTREAM first, so no curation record carries',
    '-- it any more and no future promote can reach, update or remove it. If one of these',
    '-- edges turns out to be real, re-materialise it upstream with current evidence and',
    '-- promote it, rather than replaying this file.',
    ...(ruling
      ? [
          '--',
          `-- OPERATOR RULING (${ruling.issue}), file ${ruling.path}:`,
          `--   ${ruling.reason}`,
          `-- Source: ${ruling.rulingSource}`,
          `-- no_upstream_ruling: ${ruling.noUpstreamRuling}`,
          '--',
          '-- These ids were never in the retraction journal, which is WHY this ran on a',
          '-- ruling. Replaying the file recreates rows that no journal entry and no upstream',
          '-- record will ever name again, so the daily strand audit will report them as',
          '-- findings the moment they are back.',
        ]
      : []),
    '',
  ];

  for (const [table, ids, claimCol] of [
    ['integrations', intIds, 'integration_id'],
    ['connector_evidenced_pairs', pairIds, 'connector_evidenced_pair_id'],
  ]) {
    if (!ids.length) continue;
    const rows = [];
    const claims = [];
    const attestations = [];
    for (const part of chunk(ids, ID_CHUNK)) {
      const ph = sqlIdList(part);
      rows.push(...d1Read(target, `SELECT * FROM ${table} WHERE id IN (${ph}) ORDER BY id`));
      claims.push(
        ...d1Read(target, `SELECT * FROM claims WHERE ${claimCol} IN (${ph}) ORDER BY id`),
      );
      attestations.push(
        ...d1Read(
          target,
          `SELECT * FROM attestations WHERE claim_id IN
             (SELECT id FROM claims WHERE ${claimCol} IN (${ph})) ORDER BY id`,
        ),
      );
    }
    lines.push(
      `-- ${table}: ${rows.length}, claims: ${claims.length}, attestations: ${attestations.length}`,
      ...rows.map((r) => toInsert(table, r)),
      ...claims.map((r) => toInsert('claims', r)),
      ...attestations.map((r) => toInsert('attestations', r)),
      '',
    );
  }

  const path = join(HERE, `rollback-${stamp}.sql`);
  writeFileSync(path, lines.join('\n'));
  return path;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
