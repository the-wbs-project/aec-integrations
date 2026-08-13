#!/usr/bin/env node
//
// audit.mjs — cross-reference a deployed D1 against the AEC Integrations Airtable
// base and report every row on either side without a valid counterpart link.
//
// STRICTLY READ-ONLY. There is no --apply flag and no write path: the script issues
// SELECTs against D1 and GETs against Airtable. Healing is a separate, deliberate
// operator action (see README.md).
//
// Promote keys identity SOLELY on the caller-supplied `supabaseId`
// (apps/api/src/routes/promote.ts — "Present and still resolvable → update; absent →
// create"). D1 stores no Airtable record id, so the ONLY link between the two sides
// is the `supabase_*_id` column Airtable holds. That link can break two ways:
//
//   stray    — a D1 row no Airtable record points at. Unreachable: no future promote
//              will ever update it, and a re-promote of its product mints a duplicate.
//   dangling — an Airtable id whose D1 row is gone (retracted, pruned, deleted).
//              Since AECI-568 the ingest falls back to CREATE on these rather than
//              silently no-op-updating, so they self-heal on the next promote — but
//              until then Airtable is asserting a link that does not exist.
//
// plus the pre-AECI-563 timeout-strand signature:
//
//   stranded — an Airtable record that looks promoted (a `last_promoted_at`, or a
//              promoted/verified/retracted `promotion_status`) yet carries no id. The
//              commit landed; the response carrying the ids was lost.
//   pendingJobMarkers — a row still carrying `promote_job_id`. Uncollected job; the
//              hourly reconcile sweep (AECI-570) should have taken it.
//   duplicatePointers — one D1 id referenced by more than one Airtable record.
//
// CLAIMS ARE DELIBERATELY OUT OF SCOPE. The ingest replaces an integration's claims
// wholesale on every promote (delete-by-integration then re-insert with fresh UUIDs),
// so a written-back `supabase_claim_id` is invalidated by the very next re-promote.
// Claim rows are wholly owned by their integration and cannot be orphaned
// independently of it — auditing them would report all of them, every time.
//
// ONLY `--env production` IS MEANINGFUL. Airtable's `supabase_*_id` columns hold
// PRODUCTION uuids — there is one curation base, not one per tier — so pointing this
// at staging/demo/preview compares those ids against an unrelated seeded catalog and
// reports near-total mismatch. The flag exists so the script can be re-aimed if that
// ever changes; it warns loudly otherwise.
//
// USAGE (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + AIRTABLE_TOKEN):
//   node scripts/ops/2026-08-promote-strand-audit/audit.mjs
//   node scripts/ops/2026-08-promote-strand-audit/audit.mjs --json
//
// Exits 0 when every axis is clean, 1 when any mismatch is found (so it can be wired
// to a cron later), 2 on a usage/credential error.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const WRANGLER = join(ROOT, 'apps', 'api', 'node_modules', '.bin', 'wrangler');

const ENVS = ['preview', 'staging', 'demo', 'production'];
const AIRTABLE_BASE = 'appy81IdGJY6Fngf9';

/**
 * The three linkable axes. `table`/`idField` are Airtable's; `d1Table` is D1's.
 *
 * `promotedStatuses` are the `promotion_status` values that imply "this was pushed
 * live at some point" — a record in one of them with no id is stranded. Airtable's
 * other values (pending/ready/on_hold/rejected/needs_attention) never carried an id.
 * Only Products has the field; vendors and integrations ride their product's promote.
 */
const AXES = [
  {
    key: 'products',
    label: 'Products',
    table: 'Products',
    idField: 'supabase_product_id',
    d1Table: 'products',
    nameField: 'Name',
    statusField: 'promotion_status',
    promotedStatuses: ['promoted', 'verified', 'retracted'],
    promotedAtField: 'last_promoted_at',
    jobMarkerField: 'promote_job_id',
  },
  {
    key: 'vendors',
    label: 'Vendors',
    table: 'Vendors',
    idField: 'supabase_vendor_id',
    d1Table: 'vendors',
    nameField: 'company_name',
  },
  {
    key: 'integrations',
    label: 'Integrations',
    table: 'Integrations',
    idField: 'supabase_integration_id',
    d1Table: 'integrations',
    nameField: 'Name',
  },
];

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
    `warning: --env ${env} — Airtable holds PRODUCTION uuids (one curation base for all\n` +
      `         tiers), so every bucket below will be noise. Only --env production is\n` +
      `         a real audit.\n`,
  );
}

const airtableToken = process.env.AIRTABLE_TOKEN;
if (!airtableToken) {
  usage(
    "AIRTABLE_TOKEN is not set. It is NOT in this repo's .dev.vars — it lives in the " +
      'review app (apps/review-app/.dev.vars in aec-integrations-review), or mint a ' +
      'read-only PAT scoped to data.records:read on the AEC Integrations base.',
  );
}

// ─── readers ─────────────────────────────────────────────────────────────────

/** One column of one D1 table, as a trimmed non-empty string array. */
function readD1Column(table, column) {
  const out = execFileSync(
    WRANGLER,
    [
      'd1',
      'execute',
      `aeci-app-${env}`,
      '--remote',
      '--json',
      '--command',
      `SELECT ${column} FROM ${table}`,
    ],
    { cwd: join(ROOT, 'apps', 'api'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // wrangler prints its banner on stderr, but a stray line on stdout would break
  // JSON.parse — slice from the first bracket rather than trusting the whole buffer.
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0].results.map((r) => String(r[column] ?? '').trim()).filter(Boolean);
}

/** Every record of an Airtable table, paging on `offset`, as `{ id, fields }`. */
async function readAirtableTable(table, fields) {
  const records = [];
  let offset;
  do {
    const url = new URL(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(table)}`,
    );
    url.searchParams.set('pageSize', '100');
    for (const f of fields) url.searchParams.append('fields[]', f);
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${airtableToken}` } });
    if (!res.ok) {
      throw new Error(`Airtable ${table} → ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    const body = await res.json();
    records.push(...body.records.map((r) => ({ id: r.id, fields: r.fields ?? {} })));
    offset = body.offset;
  } while (offset);
  return records;
}

// ─── audit ───────────────────────────────────────────────────────────────────

/** Airtable single-selects come back as a plain string over the REST API. */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

async function auditAxis(axis) {
  const wanted = [axis.idField, axis.nameField];
  if (axis.statusField) wanted.push(axis.statusField);
  if (axis.promotedAtField) wanted.push(axis.promotedAtField);
  if (axis.jobMarkerField) wanted.push(axis.jobMarkerField);

  const [d1Ids, records] = await Promise.all([
    Promise.resolve(readD1Column(axis.d1Table, 'id')),
    readAirtableTable(axis.table, wanted),
  ]);

  const d1Set = new Set(d1Ids);
  /** supabaseId → the Airtable records claiming it (>1 ⇒ a duplicate pointer). */
  const byId = new Map();
  const stranded = [];
  const pendingJobMarkers = [];

  for (const rec of records) {
    const id = str(rec.fields[axis.idField]);
    const name = str(rec.fields[axis.nameField]);
    const status = axis.statusField ? str(rec.fields[axis.statusField]) : '';

    if (axis.jobMarkerField && str(rec.fields[axis.jobMarkerField])) {
      pendingJobMarkers.push({
        recordId: rec.id,
        name,
        jobId: str(rec.fields[axis.jobMarkerField]),
      });
    }

    if (id) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ recordId: rec.id, name, status });
      continue;
    }
    // No id. Stranded only if the record claims to have been pushed live — either a
    // promote timestamp or a status that only a promote sets.
    const looksPromoted =
      (axis.promotedAtField && str(rec.fields[axis.promotedAtField])) ||
      (axis.promotedStatuses && axis.promotedStatuses.includes(status));
    if (looksPromoted) stranded.push({ recordId: rec.id, name, status });
  }

  const dangling = [];
  const duplicatePointers = [];
  for (const [id, holders] of byId) {
    if (!d1Set.has(id)) dangling.push({ supabaseId: id, holders });
    if (holders.length > 1) duplicatePointers.push({ supabaseId: id, holders });
  }
  const stray = d1Ids.filter((id) => !byId.has(id)).map((id) => ({ supabaseId: id }));

  return {
    axis: axis.key,
    label: axis.label,
    d1Rows: d1Ids.length,
    airtableRecords: records.length,
    airtableLinked: byId.size,
    stranded,
    stray,
    dangling,
    duplicatePointers,
    pendingJobMarkers,
  };
}

const BUCKETS = ['stranded', 'stray', 'dangling', 'duplicatePointers', 'pendingJobMarkers'];

const results = [];
for (const axis of AXES) results.push(await auditAxis(axis));

const dirty = results.some((r) => BUCKETS.some((b) => r[b].length > 0));
const report = {
  env,
  database: `aeci-app-${env}`,
  airtableBase: AIRTABLE_BASE,
  // Stamped by the caller's clock, not by anything in the data — this is a snapshot.
  measuredAt: new Date().toISOString(),
  clean: !dirty,
  axes: results,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  console.log(`\npromote strand audit — aeci-app-${env} vs Airtable ${AIRTABLE_BASE}`);
  console.log(`measured ${report.measuredAt}\n`);
  console.log(
    `${pad('axis', 14)}${num('D1', 6)}${num('linked', 8)}${num('stranded', 10)}${num('stray', 7)}${num('dangling', 10)}${num('dup', 5)}${num('pending', 9)}`,
  );
  for (const r of results) {
    console.log(
      `${pad(r.label, 14)}${num(r.d1Rows, 6)}${num(r.airtableLinked, 8)}${num(r.stranded.length, 10)}${num(r.stray.length, 7)}${num(r.dangling.length, 10)}${num(r.duplicatePointers.length, 5)}${num(r.pendingJobMarkers.length, 9)}`,
    );
  }
  console.log('\nClaims are excluded by design — see the header comment and README.\n');

  for (const r of results) {
    for (const bucket of BUCKETS) {
      if (r[bucket].length === 0) continue;
      console.log(`${r.label} → ${bucket} (${r[bucket].length}):`);
      for (const entry of r[bucket]) console.log(`  ${JSON.stringify(entry)}`);
      console.log('');
    }
  }
  console.log(dirty ? 'RESULT: mismatches found.' : 'RESULT: clean — every row links both ways.');
}

const target = outPath ?? join(HERE, `report-${report.measuredAt.replace(/[:.]/g, '-')}.json`);
writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
if (!asJson) console.log(`\nreport written to ${target}`);

process.exit(dirty ? 1 : 0);
