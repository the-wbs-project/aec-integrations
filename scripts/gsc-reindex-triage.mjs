#!/usr/bin/env node
// GSC re-index triage: step 0 of docs/gsc-reindex-playbook.md.
//
// The MANUAL fallback for the daily gsc_inspect cron (AECI-1236,
// apps/api/src/lib/gsc-inspect-job.ts). Use it when the cron did not run, or to
// check the queue by hand. It applies the same rule as the cron.
//
// Reads the /admin/reindex worklist, asks the Search Console URL Inspection API
// about every row, and clears the rows that need no manual request. What is left
// in the queue is exactly the work the browser loop still has to do.
//
// A row is cleared ("done") only when Google reports the page indexed AND its
// last crawl is strictly after the row's last_changed_at, so Google has already
// seen the latest change. Never compare with queued_at: a re-enqueue does not
// refresh it, so a page edited again after the crawl would look done. Before
// migration 0064 there is no last_changed_at, and the script clears nothing.
//
// A page Google could not fetch (404 and the like) is NOT cleared, matching the
// cron (ADR 0030: never infer a delete from absence). Every other row is left
// for the manual loop.
//
// Clearing goes through DELETE /api/admin/reindex/:id, the same call as the Done
// button, so each clear writes its audit_log row attributed to the admin whose
// session token is supplied. Never clear rows with a direct D1 delete.
//
// Dry run by default. Pass --apply to clear rows.
//
// Inspection results are kept in .context/gsc-triage/state.json, keyed by row
// id. A row inspected within the recheck window is not inspected again: a done
// row is cleared from its saved result, a request row is left alone. This keeps
// repeat runs inside the URL Inspection quota of 2,000 calls a day, and lets a
// dry run followed by --apply cost one inspection per row, not two. A URL that
// is queued again gets a new row id, so it is always inspected fresh.
//
// Environment:
//   AECI_ADMIN_TOKEN   Supabase access token (JWT) of an admin session, or
//   AECI_ADMIN_COOKIE  the Cookie request header of a signed-in admin browser
//                      tab, copied from DevTools. One of the two is required,
//                      except on a --from-d1 dry run. Either expires about an
//                      hour after sign-in or refresh.
//   GSC_SA_KEY_JSON    The service-account key itself, as JSON text. The
//                      account needs read access to the GSC property.
//   GSC_SA_KEY         Or a path to the key file. Used only when
//                      GSC_SA_KEY_JSON is unset. Default
//                      ~/.config/aeci/gsc-sa.json.
//   AECI_ORIGIN        Default https://www.aecintegrations.com.
//   GSC_SITE           Default sc-domain:aecintegrations.com.
//
// Flags:
//   --apply            Clear the rows marked done. Without it nothing is written.
//   --from-d1          Read the worklist from production D1 with a read-only
//                      SELECT through wrangler, instead of the admin API. Uses
//                      the wrangler OAuth login on The WBS Project account.
//                      Clearing still goes through the admin API.
//   --limit N          Inspect only the first N rows of the worklist.
//   --priority N       Only rows of this priority tier (1 to 4).
//   --recheck-hours N  Re-inspect rows whose saved result is older than N
//                      hours. Default 72, the cron's three days.
//   --fresh            Ignore saved results and inspect every row.
//   --out PATH         Report file. Default .context/gsc-triage/<timestamp>.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    'from-d1': { type: 'boolean', default: false },
    limit: { type: 'string' },
    priority: { type: 'string' },
    'recheck-hours': { type: 'string', default: '72' },
    fresh: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const ORIGIN = (process.env.AECI_ORIGIN ?? 'https://www.aecintegrations.com').replace(/\/$/, '');
const SITE = process.env.GSC_SITE ?? 'sc-domain:aecintegrations.com';
const KEY_PATH = process.env.GSC_SA_KEY ?? join(homedir(), '.config/aeci/gsc-sa.json');
const ADMIN_TOKEN = process.env.AECI_ADMIN_TOKEN;
const ADMIN_COOKIE = process.env.AECI_ADMIN_COOKIE;
// URL Inspection allows 600 calls a minute per property. Four in flight stays
// well under it.
const INSPECT_CONCURRENCY = 4;
const PER_PAGE = 100;
const RECHECK_MS = Number(args['recheck-hours']) * 3600e3;
const TRIAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.context', 'gsc-triage');
const STATE_PATH = join(TRIAGE_DIR, 'state.json');

function fail(message) {
  console.error(`gsc-reindex-triage: ${message}`);
  process.exit(1);
}

// The Cloudflare account that holds aeci-app-production since the 2026-09
// account move (scripts/ops/2026-09-wbs-account-move).
const D1_ACCOUNT_ID = process.env.AECI_D1_ACCOUNT_ID ?? '004dc1af737b22a8aa83b3550fa9b9d3';
const D1_DATABASE = process.env.AECI_D1_DATABASE ?? 'aeci-app-production';

if (!ADMIN_TOKEN && !ADMIN_COOKIE && (args.apply || !args['from-d1'])) {
  fail('set AECI_ADMIN_TOKEN or AECI_ADMIN_COOKIE. See docs/gsc-reindex-playbook.md, step 0.');
}
// The API reads a bearer token first, then the Supabase session cookies.
const ADMIN_AUTH = ADMIN_TOKEN
  ? { authorization: `Bearer ${ADMIN_TOKEN}` }
  : { cookie: ADMIN_COOKIE };

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

async function gscToken() {
  let key;
  const source = process.env.GSC_SA_KEY_JSON ? 'GSC_SA_KEY_JSON' : KEY_PATH;
  try {
    key = JSON.parse(process.env.GSC_SA_KEY_JSON ?? readFileSync(KEY_PATH, 'utf8'));
  } catch (err) {
    fail(`cannot read the GSC service-account key from ${source}: ${err.message}`);
  }
  if (!key.client_email || !key.private_key) {
    fail(`the GSC service-account key from ${source} has no client_email or private_key.`);
  }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j = await res.json();
  if (!j.access_token) fail(`GSC token exchange failed: ${res.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

async function adminFetch(path, init = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      ...ADMIN_AUTH,
      accept: 'application/json',
      ...init.headers,
    },
  });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    fail(
      `admin API answered ${res.status} on ${path}. The token is missing admin rights or has expired.`,
    );
  }
  return res;
}

// Same columns and order as GET /api/admin/reindex: priority, inspection bucket,
// never crawled first, then age, then id.
// Run from the OS temp dir, because inside apps/api wrangler takes that
// wrangler.jsonc's settings. CLOUDFLARE_API_TOKEN is dropped so the OAuth login
// is used: the token in Conductor's environment reaches only the old account.
function readWorklistFromD1() {
  const priority = args.priority ? Number(args.priority) : null;
  if (priority !== null && !Number.isInteger(priority)) fail('--priority must be a number.');
  // Before migration 0064 the inspection columns do not exist either, so the
  // fallback read orders by priority, age and id only.
  const inspectionOrder = `
      CASE WHEN inspect_reason IS NULL THEN 1 WHEN inspect_reason = 'page_fetch_failed' THEN 2 ELSE 0 END ASC,
      CASE WHEN inspect_reason IS NOT NULL AND last_crawl_at IS NULL THEN 0 ELSE 1 END ASC,`;
  const query = (columns, withInspection = true) =>
    `SELECT ${columns} FROM gsc_recrawl_queue${
      priority === null ? '' : ` WHERE priority = ${priority}`
    } ORDER BY priority ASC,${withInspection ? inspectionOrder : ''} queued_at ASC, id ASC`;
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: D1_ACCOUNT_ID };
  delete env.CLOUDFLARE_API_TOKEN;
  const execute = (sql) => {
    const run = spawnSync(
      'npx',
      ['wrangler', 'd1', 'execute', D1_DATABASE, '--remote', '--json', '--command', sql],
      { cwd: tmpdir(), env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    try {
      return { parsed: JSON.parse(run.stdout), run };
    } catch {
      return { parsed: null, run };
    }
  };
  const base = 'id, url, priority, reason, source, queued_at';
  let { parsed, run } = execute(query(`${base}, last_changed_at`));
  // Before migration 0064 the column does not exist. Read without it; decide()
  // then clears nothing, because it cannot tell which change Google saw.
  if (/no such column: last_changed_at/.test(`${run.stdout}${run.stderr}`)) {
    console.error(
      'last_changed_at is missing (migration 0064 not applied). Nothing will be cleared.',
    );
    ({ parsed, run } = execute(query(base, false)));
  }
  if (!Array.isArray(parsed) || parsed[0]?.success !== true) {
    fail(
      `wrangler d1 execute failed (exit ${run.status}).\n${(run.stderr || run.stdout).slice(-600)}`,
    );
  }
  const rows = parsed[0].results;
  return { rows, total: rows.length };
}

// Read the whole worklist before clearing anything. Deleting while paging by
// offset would shift later rows onto pages already read.
async function readWorklist() {
  const rows = [];
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) });
    if (args.priority) qs.set('priority', args.priority);
    const res = await adminFetch(`/api/admin/reindex?${qs}`);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('application/json')) {
      const text = await res.text();
      fail(
        `worklist read failed: ${res.status} ${type}. A non-JSON body is usually a Cloudflare challenge.\n${text.slice(0, 300)}`,
      );
    }
    const body = await res.json();
    rows.push(...body.data);
    if (body.data.length < PER_PAGE || rows.length >= body.total)
      return { rows, total: body.total };
  }
}

async function inspect(accessToken, url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    let j;
    try {
      res = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: url, siteUrl: SITE }),
      });
      j = await res.json();
    } catch (err) {
      // A dropped connection or a non-JSON 5xx page. Retry, then record the row
      // as an error so one bad response cannot end the run.
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      return { error: `network: ${err.cause?.code ?? err.message}` };
    }
    if (res.ok) return { result: j.inspectionResult?.indexStatusResult ?? {} };
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    return {
      error: `${res.status} ${j.error?.message ?? ''}`.trim(),
      fatal: res.status === 401 || res.status === 403,
      // Still 429 after two waits: the daily quota is spent. Stop inspecting,
      // but clear what was already decided.
      halt: res.status === 429,
    };
  }
}

const FETCH_FAILED = new Set([
  'SOFT_404',
  'BLOCKED_ROBOTS_TXT',
  'NOT_FOUND',
  'ACCESS_DENIED',
  'SERVER_ERROR',
  'REDIRECT_ERROR',
  'ACCESS_FORBIDDEN',
  'BLOCKED_4XX',
  'INTERNAL_CRAWL_ERROR',
  'INVALID_URL',
]);

// Mirrors decideInspection in apps/api/src/lib/gsc-inspection.ts.
function decide(row, r) {
  const crawl = r.lastCrawlTime ? Date.parse(r.lastCrawlTime) : NaN;
  if (r.verdict === 'PASS' && Number.isFinite(crawl)) {
    if (!row.last_changed_at) {
      return { decision: 'request', why: 'cannot tell: no last_changed_at (pre-0064)' };
    }
    if (crawl > Date.parse(row.last_changed_at)) {
      return { decision: 'done', why: 'crawled after change' };
    }
  }
  if (r.pageFetchState && FETCH_FAILED.has(r.pageFetchState)) {
    return { decision: 'request', why: `page fetch failed (${r.pageFetchState})` };
  }
  if (r.verdict === 'PASS') return { decision: 'request', why: 'crawl predates change' };
  return { decision: 'request', why: r.coverageState ?? 'not indexed' };
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let stop = false;
  async function worker() {
    while (!stop && next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      if (out[i]?.fatal || out[i]?.halt) stop = true;
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.filter(Boolean);
}

const { rows: worklist, total } = args['from-d1'] ? readWorklistFromD1() : await readWorklist();
const rows = args.limit ? worklist.slice(0, Number(args.limit)) : worklist;
console.error(
  `Worklist: ${total} rows. Inspecting ${rows.length}. ${args.apply ? 'APPLY: clearing done rows.' : 'Dry run.'}`,
);

const state =
  !args.fresh && existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {};
const startedAt = Date.now();
// A saved result is reused only while the page has not changed since: a newer
// last_changed_at makes the saved decision stale.
const savedFor = (row) => {
  const saved = state[row.id];
  if (!saved || startedAt - Date.parse(saved.inspectedAt) >= RECHECK_MS) return null;
  return (saved.last_changed_at ?? null) === (row.last_changed_at ?? null) ? saved : null;
};
const toInspect = rows.filter((row) => !savedFor(row));
const reused = rows
  .filter((row) => savedFor(row))
  .map((row) => ({ ...savedFor(row), reused: true }));
console.error(
  `Reusing ${reused.length} results from the last ${args['recheck-hours']} h. Inspecting ${toInspect.length}.`,
);

// Errors are not saved, so the next run retries them. Rows no longer in the
// worklist are dropped, which keeps the file the size of the queue. The file is
// rewritten every 25 results, so a crash loses at most that many inspections.
const liveIds = new Set(worklist.map((row) => row.id));
const nextState = Object.fromEntries(
  Object.entries(state).filter(([id]) => liveIds.has(Number(id))),
);
mkdirSync(TRIAGE_DIR, { recursive: true });
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(nextState));

const accessToken = toInspect.length ? await gscToken() : null;
let inspected = 0;
const fresh = await mapWithConcurrency(toInspect, INSPECT_CONCURRENCY, async (row) => {
  const base = {
    id: row.id,
    url: row.url,
    priority: row.priority,
    reason: row.reason,
    queued_at: row.queued_at,
    last_changed_at: row.last_changed_at ?? null,
  };
  const { result: r, error, fatal, halt } = await inspect(accessToken, row.url);
  if (++inspected % 50 === 0) console.error(`  inspected ${inspected}/${toInspect.length}`);
  if (error) return { ...base, decision: 'error', why: error, fatal, halt };
  const result = {
    ...base,
    ...decide(row, r),
    verdict: r.verdict,
    coverage: r.coverageState ?? null,
    lastCrawl: r.lastCrawlTime ?? null,
    pageFetchState: r.pageFetchState ?? null,
    inspectedAt: new Date().toISOString(),
  };
  nextState[row.id] = result;
  if (inspected % 25 === 0) saveState();
  return result;
});
const results = [...reused, ...fresh];
saveState();

if (results.some((x) => x.fatal)) {
  console.error('Search Console refused the service account. Stopped before clearing anything.');
}
if (fresh.some((x) => x.halt)) {
  console.error(
    'Search Console quota is spent for today. Stopped inspecting. Rows not reached stay queued.',
  );
}

let cleared = 0;
if (args.apply && !results.some((x) => x.fatal)) {
  for (const x of results.filter((r) => r.decision === 'done')) {
    const res = await adminFetch(`/api/admin/reindex/${x.id}`, { method: 'DELETE' });
    await res.body?.cancel();
    // 404 means the row was already cleared, by hand or by a newer edit's
    // replacement. Either way it is no longer in the queue.
    x.cleared = res.status === 204 || res.status === 404;
    if (!x.cleared) x.clearError = res.status;
    if (x.cleared) {
      cleared++;
      delete nextState[x.id];
    }
  }
  saveState();
}

const count = (d) => results.filter((x) => x.decision === d).length;
const summary = {
  ranAt: new Date().toISOString(),
  apply: args.apply,
  worklistTotal: total,
  inspected: fresh.length,
  reused: reused.length,
  done: count('done'),
  cleared,
  request: count('request'),
  error: count('error'),
};

const outPath = args.out ?? join(TRIAGE_DIR, `${summary.ranAt.replace(/[:.]/g, '-')}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2));

for (const x of results) {
  console.log([x.decision, x.why, x.lastCrawl?.slice(0, 16) ?? '', x.url].join('\t'));
}
console.error(`\n${JSON.stringify(summary, null, 2)}\nReport: ${outPath}`);
if (!args.apply && summary.done > 0)
  console.error(`Re-run with --apply to clear the ${summary.done} done rows.`);
