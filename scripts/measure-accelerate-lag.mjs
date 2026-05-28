#!/usr/bin/env node
// One-off diagnostic harness — measures Prisma Accelerate's introspected
// schema-cache lag after `supabase db push` adds a column on the dev/staging
// DB. See docs/deployment-issues.md item #6 for the symptom being measured.
//
// NOT production code. Refuses to run against the prod hostname or prod
// Supabase project. Reverted after measurement per the cleanup checklist in
// .context/staging-bootstrap-for-lag-probe.md.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ──────────────────────────────────────────────────────────────────────────
// Constants — these are the hard-coded production-refusal guard values.
// Changing them moves the blast radius. Don't.
// ──────────────────────────────────────────────────────────────────────────

const REQUIRED_STAGING_HOSTNAME = 'staging.aecintegrations.com';
const REQUIRED_DEV_PROJECT_REF = 'lfqxneqihbejrkufvafw';
const REQUIRED_WRANGLER_ENV = 'staging';
const CONFIRMATION_PHRASE = 'proceed-staging-lag-probe';

const PROBE_COLUMN_DB = '_lag_probe';
const PROBE_COLUMN_PRISMA = 'lagProbe';
const CYCLES = 5;
const INTER_CYCLE_GAP_MS = 120_000; // 2 minutes (user's brief)
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_MS = 15 * 60_000; // 15 minutes (user's brief)
const COLUMN_GONE_MAX_MS = 15 * 60_000;
const POST_GONE_BUFFER_MS = 60_000; // additional safety after Accelerate forgets

const REPO_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');
const OUTPUT_DIR = join(REPO_ROOT, '.context');

// Prepend node_modules/.bin to PATH so `supabase` resolves when the script is
// invoked directly via `node scripts/...` (without pnpm-exec wrapping).
const BIN_DIR = join(REPO_ROOT, 'node_modules', '.bin');
process.env.PATH = `${BIN_DIR}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`;

// ──────────────────────────────────────────────────────────────────────────
// Tee'd logging — every line goes to terminal AND .context/lag-run-<ts>.log
// ──────────────────────────────────────────────────────────────────────────

const RUN_TS = utcTimestampForFilename();
let logStream;

function log(msg, level = 'info') {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  stdout.write(line + '\n');
  logStream?.write(line + '\n');
}

function fatal(msg) {
  log(msg, 'fatal');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────
// Subprocess helper — argv array, no shell interpolation.
// ──────────────────────────────────────────────────────────────────────────

function runCli(cmd, args, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
    });
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code === 0) {
        resolveP({ stdout: stdoutBuf, stderr: stderrBuf });
      } else {
        rejectP(
          new Error(
            `${cmd} ${args.join(' ')} exited with code ${code}\n--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
          ),
        );
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// HTTP helper — Access service-token headers baked in.
// ──────────────────────────────────────────────────────────────────────────

function probeUrl(path) {
  const host = process.env.STAGING_HOST ?? `https://${REQUIRED_STAGING_HOSTNAME}`;
  return `${host.replace(/\/$/, '')}${path}`;
}

async function probeFetch(path) {
  const res = await fetch(probeUrl(path), {
    headers: {
      'CF-Access-Client-Id': process.env.CF_ACCESS_CLIENT_ID ?? '',
      'CF-Access-Client-Secret': process.env.CF_ACCESS_CLIENT_SECRET ?? '',
      'User-Agent': 'aeci-lag-probe-harness/1',
    },
    // The harness deliberately follows redirects = false so we can detect
    // Access challenges (302 to cloudflareaccess.com) as a distinct failure
    // from upstream 5xx.
    redirect: 'manual',
  });
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* keep null */
  }
  return {
    status: res.status,
    headers: res.headers,
    body,
    json,
    cfRay: res.headers.get('cf-ray') ?? '',
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Production-refusal guard. Hard fail if anything looks like prod.
// ──────────────────────────────────────────────────────────────────────────

function assertNotProduction() {
  const host = process.env.STAGING_HOST ?? `https://${REQUIRED_STAGING_HOSTNAME}`;
  let parsed;
  try {
    parsed = new URL(host);
  } catch {
    fatal(`STAGING_HOST is not a valid URL: ${host}`);
  }
  if (parsed.host !== REQUIRED_STAGING_HOSTNAME) {
    fatal(
      `Refusing to run: STAGING_HOST.host = "${parsed.host}", expected "${REQUIRED_STAGING_HOSTNAME}" exactly.`,
    );
  }
  if (process.env.SUPABASE_DEV_PROJECT_REF !== REQUIRED_DEV_PROJECT_REF) {
    fatal(
      `Refusing to run: SUPABASE_DEV_PROJECT_REF = "${process.env.SUPABASE_DEV_PROJECT_REF ?? '<unset>'}", expected "${REQUIRED_DEV_PROJECT_REF}".`,
    );
  }
  if (process.env.WRANGLER_ENV !== REQUIRED_WRANGLER_ENV) {
    fatal(
      `Refusing to run: WRANGLER_ENV = "${process.env.WRANGLER_ENV ?? '<unset>'}", expected "${REQUIRED_WRANGLER_ENV}".`,
    );
  }
  const lower = host.toLowerCase();
  for (const banned of ['prod', 'production', 'www.aecintegrations.com']) {
    if (lower.includes(banned)) {
      fatal(`Refusing to run: STAGING_HOST contains banned substring "${banned}".`);
    }
  }
  // Apex without staging. prefix.
  if (/\/\/aecintegrations\.com(\/|$)/i.test(host)) {
    fatal(`Refusing to run: STAGING_HOST is the apex aecintegrations.com (production).`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Pre-flight checks. Abort on first failure.
// ──────────────────────────────────────────────────────────────────────────

async function preflight() {
  log('Pre-flight 1/9: required env vars');
  for (const key of [
    'CF_ACCESS_CLIENT_ID',
    'CF_ACCESS_CLIENT_SECRET',
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_DEV_PROJECT_REF',
    'WRANGLER_ENV',
  ]) {
    if (!process.env[key]) fatal(`Missing required env var: ${key}`);
  }

  log('Pre-flight 2/9: production-refusal guard');
  assertNotProduction();

  log('Pre-flight 3/9: supabase CLI sees dev project');
  const projects = await runCli('supabase', ['projects', 'list', '--output', 'json']);
  let projectsJson;
  try {
    projectsJson = JSON.parse(projects.stdout);
  } catch {
    fatal(`supabase projects list returned non-JSON:\n${projects.stdout}`);
  }
  if (!projectsJson.some((p) => p.id === REQUIRED_DEV_PROJECT_REF)) {
    fatal(`supabase projects list does not include ${REQUIRED_DEV_PROJECT_REF}`);
  }

  log('Pre-flight 4/9: supabase migration list --linked');
  // Linking state is the user's responsibility (per docs/environments.md).
  // We just verify the CLI can talk to whichever project is linked.
  await runCli('supabase', ['migration', 'list', '--linked']);

  log('Pre-flight 5/9: supabase/migrations/ is clean (no WIP)');
  const gitStatus = await runCli('git', ['status', '--porcelain', 'supabase/migrations/']);
  if (gitStatus.stdout.trim() !== '') {
    fatal(
      `supabase/migrations/ has uncommitted changes; refusing to push throwaway migrations on top:\n${gitStatus.stdout}`,
    );
  }

  log('Pre-flight 6/9: GET /api/health → 200 with db: ok');
  const health = await probeFetch('/api/health');
  if (health.status !== 200)
    fatal(`/api/health returned ${health.status}: ${health.body.slice(0, 200)}`);
  if (health.json?.db !== 'ok')
    fatal(`/api/health did not report db:ok: ${JSON.stringify(health.json)}`);

  log('Pre-flight 7/9: GET /api/version → 200 with SHA');
  const version = await probeFetch('/api/version');
  if (version.status !== 200)
    fatal(`/api/version returned ${version.status}: ${version.body.slice(0, 200)}`);
  if (typeof version.json?.sha !== 'string' || version.json.sha === 'unknown')
    fatal(`/api/version did not report a real SHA: ${JSON.stringify(version.json)}`);
  log(`  staging is on commit ${version.json.sha} (deployed ${version.json.deployedAt})`);

  log('Pre-flight 8/9: GET /api/lag-probe-baseline → 200 ok:true');
  const baseline = await probeFetch('/api/lag-probe-baseline');
  if (baseline.status !== 200 || baseline.json?.ok !== true) {
    fatal(
      `/api/lag-probe-baseline did not return 200 ok:true. Got ${baseline.status} ${baseline.body.slice(0, 300)}\n` +
        `Either the probe handler is not deployed yet, or Prisma is failing on a basic typed query.`,
    );
  }

  log('Pre-flight 9/9: GET /api/lag-probe → 503 (cold pre-state, column not added)');
  const probe = await probeFetch('/api/lag-probe');
  if (probe.status === 200) {
    fatal(
      `/api/lag-probe returned 200 BEFORE the probe column was added. Either ${PROBE_COLUMN_DB} ` +
        `already exists in the dev DB, or Accelerate is still caching it from a previous run. ` +
        `Drop the column manually and wait for the cache to expire before re-running.`,
    );
  }
  if (probe.status !== 503) {
    log(
      `WARN: /api/lag-probe returned ${probe.status}, expected 503. The handler may not be ` +
        `discriminating PrismaClientValidationError correctly. Continuing — the harness will ` +
        `still measure "first 200" which is the metric we care about.`,
      'warn',
    );
  }

  log('Pre-flight passed ✓');
}

// ──────────────────────────────────────────────────────────────────────────
// Migration file helpers. Names sort lexicographically by UTC timestamp so
// `supabase db push --linked --include-all` applies them in order.
// ──────────────────────────────────────────────────────────────────────────

function migrationTimestamp() {
  const d = new Date();
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0')
  );
}

async function writeAddMigration(cycle) {
  const ts = migrationTimestamp();
  const path = join(MIGRATIONS_DIR, `${ts}_lag_probe_add_${cycle}.sql`);
  await writeFile(
    path,
    `-- THROWAWAY: lag-probe cycle ${cycle} add. Reverted by the next migration in this pair.\n` +
      `ALTER TABLE public.vendors ADD COLUMN IF NOT EXISTS ${PROBE_COLUMN_DB} text;\n`,
  );
  // 1-second guarantee that the drop timestamp sorts after this one.
  await new Promise((r) => setTimeout(r, 1100));
  return path;
}

async function writeDropMigration(cycle) {
  const ts = migrationTimestamp();
  const path = join(MIGRATIONS_DIR, `${ts}_lag_probe_drop_${cycle}.sql`);
  await writeFile(
    path,
    `-- THROWAWAY: lag-probe cycle ${cycle} drop. Pairs with the preceding add.\n` +
      `ALTER TABLE public.vendors DROP COLUMN IF EXISTS ${PROBE_COLUMN_DB};\n`,
  );
  return path;
}

async function cleanupResidualMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  const residuals = entries.filter((f) => /lag_probe/.test(f));
  for (const f of residuals) {
    await rm(join(MIGRATIONS_DIR, f));
    log(`  removed residual ${f}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Polling loops.
// ──────────────────────────────────────────────────────────────────────────

async function pollUntilProbeAccepts({ maxMs, label }) {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < maxMs) {
    attempts += 1;
    const res = await probeFetch('/api/lag-probe');
    if (res.status === 200 && res.json?.ok === true) {
      return {
        success: true,
        elapsedMs: Date.now() - start,
        attempts,
        cfRay: res.cfRay,
        status: res.status,
      };
    }
    if (attempts % 15 === 0) {
      // Every ~30s log progress + liveness-check the baseline endpoint
      const elapsedS = Math.round((Date.now() - start) / 1000);
      log(`  [${label}] still polling at ${elapsedS}s, last status=${res.status}`);
      const baseline = await probeFetch('/api/lag-probe-baseline');
      if (baseline.status !== 200) {
        throw new Error(
          `Baseline endpoint went unhealthy mid-poll (status=${baseline.status}). Aborting.`,
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    success: false,
    elapsedMs: Date.now() - start,
    attempts,
    cfRay: '',
    status: 0,
  };
}

async function pollUntilProbeRejects({ maxMs, label }) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await probeFetch('/api/lag-probe');
    // Either 503 (Accelerate rejects unknown field) or 500 (Postgres rejects
    // the column reference after we drop it) — both count as "probe is
    // rejected", i.e. Accelerate no longer believes the column exists OR the
    // underlying DB rejected it. We're looking for ANY non-200.
    if (res.status !== 200) {
      const elapsedS = Math.round((Date.now() - start) / 1000);
      log(`  [${label}] probe is rejected at ${elapsedS}s (status=${res.status})`);
      return { success: true, elapsedMs: Date.now() - start };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { success: false, elapsedMs: Date.now() - start };
}

// ──────────────────────────────────────────────────────────────────────────
// Single measurement cycle.
// ──────────────────────────────────────────────────────────────────────────

async function runCycle(cycle) {
  log(`──── Cycle ${cycle}/${CYCLES} ────`);

  log(`  writing ADD migration for cycle ${cycle}`);
  const addFile = await writeAddMigration(cycle);
  log(`  ${addFile}`);

  log('  supabase db push --linked --include-all');
  const T0 = Date.now();
  try {
    await runCli('supabase', ['db', 'push', '--linked', '--include-all'], {
      // --yes flag may or may not exist depending on CLI version; we pass
      // --include-all which is non-interactive. If the CLI ever introduces a
      // prompt here, switch to --debug to surface it.
    });
  } catch (err) {
    await rm(addFile).catch(() => {});
    throw new Error(`Cycle ${cycle} ADD push failed: ${err.message}`);
  }
  const t0Ts = new Date(T0).toISOString();
  log(`  T0 = ${t0Ts}`);

  log('  polling /api/lag-probe until Accelerate accepts the typed query');
  const poll = await pollUntilProbeAccepts({
    maxMs: MAX_POLL_MS,
    label: `cycle-${cycle}`,
  });
  const T1 = Date.now();
  const t1Ts = new Date(T1).toISOString();

  let row;
  if (poll.success) {
    log(`  ✓ cycle ${cycle}: ${(poll.elapsedMs / 1000).toFixed(1)}s, cf-ray=${poll.cfRay}`);
    row = {
      run_id: cycle,
      T0_iso: t0Ts,
      success_time_iso: t1Ts,
      elapsed_seconds: poll.elapsedMs / 1000,
      cf_ray: poll.cfRay,
      status_code_at_success: poll.status,
      hit_cap: false,
    };
  } else {
    log(`  ✗ cycle ${cycle}: hit ${MAX_POLL_MS / 1000}s cap without success`, 'warn');
    row = {
      run_id: cycle,
      T0_iso: t0Ts,
      success_time_iso: '',
      elapsed_seconds: poll.elapsedMs / 1000,
      cf_ray: '',
      status_code_at_success: 0,
      hit_cap: true,
    };
  }

  // Always run DROP, even if we hit the cap — leaves the DB clean for next cycle.
  log('  writing DROP migration');
  const dropFile = await writeDropMigration(cycle);
  try {
    await runCli('supabase', ['db', 'push', '--linked', '--include-all']);
  } catch (err) {
    log(`  WARN: DROP push failed: ${err.message}. Manual cleanup required.`, 'warn');
  }

  // INTENTIONALLY do not unlink addFile/dropFile here. `supabase db push`
  // refuses to push when local files are missing relative to the remote
  // history table — deleting between cycles caused 2-5 to error in the first
  // harness run. Files are removed wholesale at teardown.

  return row;
}

// ──────────────────────────────────────────────────────────────────────────
// Wait between cycles for the cache to forget the column.
// ──────────────────────────────────────────────────────────────────────────

async function waitForColumnGone() {
  log('  waiting for Accelerate cache to forget the column (cold reset)…');
  const r = await pollUntilProbeRejects({
    maxMs: COLUMN_GONE_MAX_MS,
    label: 'between-cycles',
  });
  if (!r.success) {
    log(
      `  WARN: probe still accepted after ${COLUMN_GONE_MAX_MS / 1000}s — next cycle's ` +
        `measurement may be a warm-cache reading rather than cold.`,
      'warn',
    );
  }
  log(`  + ${POST_GONE_BUFFER_MS / 1000}s buffer before next cycle`);
  await sleep(POST_GONE_BUFFER_MS);
}

// ──────────────────────────────────────────────────────────────────────────
// CSV + summary.
// ──────────────────────────────────────────────────────────────────────────

async function writeCsv(rows) {
  const path = join(OUTPUT_DIR, `lag-measurements-${RUN_TS}.csv`);
  const header =
    'run_id,T0_iso,success_time_iso,elapsed_seconds,cf_ray,status_code_at_success,hit_cap,errored,error';
  const body = rows
    .map((r) =>
      [
        r.run_id,
        r.T0_iso,
        r.success_time_iso,
        r.elapsed_seconds,
        r.cf_ray,
        r.status_code_at_success,
        r.hit_cap,
        r.errored ?? false,
        (r.error ?? '').replace(/\n/g, ' ').slice(0, 200),
      ]
        .map((v) =>
          typeof v === 'string' && (v.includes(',') || v.includes('"'))
            ? `"${v.replace(/"/g, '""')}"`
            : String(v),
        )
        .join(','),
    )
    .join('\n');
  await writeFile(path, `${header}\n${body}\n`);
  log(`CSV written: ${path}`);
  return path;
}

function summarize(rows) {
  const success = rows.filter((r) => !r.hit_cap && !r.errored);
  const elapsed = success.map((r) => r.elapsed_seconds);
  if (elapsed.length === 0) {
    return {
      min: null,
      max: null,
      mean: null,
      median: null,
      p95: null,
      successCount: 0,
      capCount: rows.filter((r) => r.hit_cap).length,
      errorCount: rows.filter((r) => r.errored).length,
      anyHitCap: rows.some((r) => r.hit_cap),
      anyErrored: rows.some((r) => r.errored),
    };
  }
  const sorted = [...elapsed].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
  const p95Index = Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length));
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean,
    median,
    p95: sorted[p95Index],
    successCount: success.length,
    capCount: rows.filter((r) => r.hit_cap).length,
    errorCount: rows.filter((r) => r.errored).length,
    anyHitCap: rows.some((r) => r.hit_cap),
    anyErrored: rows.some((r) => r.errored),
  };
}

function recommendation(stats) {
  if (stats.successCount === 0) {
    return 'No successful cycles. Nothing to recommend; investigate the per-cycle errors above.';
  }
  if (stats.anyHitCap) {
    return `One or more cycles exceeded ${MAX_POLL_MS / 1000}s. Recommend NOT using sleep — implement Prisma Platform schema-refresh API or drop Accelerate (see docs/deployment-issues.md §"What needs to happen" options 2 and 3).`;
  }
  let caveat = '';
  if (stats.anyErrored) {
    caveat = ` Caveat: ${stats.errorCount}/${stats.successCount + stats.errorCount} cycle(s) errored before measuring — interpret with caution; re-run if you want a full distribution.`;
  }
  if (stats.max < 600) {
    return `Use 'sleep N' with N = ${Math.ceil(stats.max + 30)}s as the post-push wait in db-migrate-dev (deploy.yml). Buffer of 30s on top of observed max (${stats.max.toFixed(1)}s).${caveat}`;
  }
  return `Lag too variable (max=${stats.max.toFixed(1)}s). Evaluate Prisma Platform schema-refresh API or removing Accelerate before re-enabling db-migrate-dev.${caveat}`;
}

function printSummary(rows, stats) {
  log('═══════════════════════════════════════════════════════════════');
  log('Per-cycle results:');
  for (const r of rows) {
    if (r.errored) {
      log(`  cycle ${r.run_id}: ERRORED — ${r.error ?? '(no message)'}`);
    } else if (r.hit_cap) {
      log(`  cycle ${r.run_id}: CAP HIT after ${r.elapsed_seconds.toFixed(1)}s`);
    } else {
      log(
        `  cycle ${r.run_id}: ${r.elapsed_seconds.toFixed(1)}s, cf-ray=${r.cf_ray}, status=${r.status_code_at_success}`,
      );
    }
  }
  log('───────────────────────────────────────────────────────────────');
  log(
    `successes: ${stats.successCount} / cap-hits: ${stats.capCount} / errored: ${stats.errorCount}`,
  );
  if (stats.min != null) {
    log(`min:    ${stats.min.toFixed(1)}s`);
    log(`max:    ${stats.max.toFixed(1)}s`);
    log(`mean:   ${stats.mean.toFixed(1)}s`);
    log(`median: ${stats.median.toFixed(1)}s`);
    log(`p95:    ${stats.p95.toFixed(1)}s`);
  }
  if (stats.anyHitCap) log('!! at least one cycle hit the 15-min cap', 'warn');
  if (stats.anyErrored) log('!! at least one cycle errored before producing a measurement', 'warn');
  log('───────────────────────────────────────────────────────────────');
  log(`RECOMMENDATION: ${recommendation(stats)}`);
  log('═══════════════════════════════════════════════════════════════');
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers.
// ──────────────────────────────────────────────────────────────────────────

function utcTimestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function confirm(prompt) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${prompt} (type "yes" to continue) > `)).trim();
    if (answer !== 'yes') fatal('Aborted by user.');
  } finally {
    rl.close();
  }
}

async function fingerprintAndConfirm() {
  const host = process.env.STAGING_HOST ?? `https://${REQUIRED_STAGING_HOSTNAME}`;
  log('═══════════════════════════════════════════════════════════════');
  log('LAG-PROBE HARNESS — production-refusal fingerprint');
  log(`  STAGING_HOST            : ${host}`);
  log(`  SUPABASE_DEV_PROJECT_REF: ${process.env.SUPABASE_DEV_PROJECT_REF}`);
  log(`  WRANGLER_ENV            : ${process.env.WRANGLER_ENV}`);
  log('═══════════════════════════════════════════════════════════════');
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`Type exactly "${CONFIRMATION_PHRASE}" to confirm: `)).trim();
    if (answer !== CONFIRMATION_PHRASE) fatal('Confirmation phrase mismatch. Aborted.');
  } finally {
    rl.close();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// --print-patches mode — prints the diffs needed before deploy.
// ──────────────────────────────────────────────────────────────────────────

function printPatches() {
  const lagProbeTs = `import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import { getPrisma } from '../prisma';

// THROWAWAY — measure-accelerate-lag harness only. Reverted after the run.
// Both handlers fire a typed Prisma query so they hit Accelerate's introspected
// schema cache (the thing being measured). Raw \$queryRawUnsafe would bypass it.

export function createLagProbeBaselineHandler(): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const prisma = getPrisma(c.env);
    const cfRay = c.req.raw.headers.get('cf-ray') ?? '';
    try {
      const row = await prisma.vendor.findFirst({ select: { name: true } });
      return json({ ok: true, value: row?.name ?? null, cfRay });
    } catch (error) {
      const err = error as { name?: string; message?: string };
      return json({ ok: false, error: { name: err.name ?? 'Error', message: err.message ?? '' }, cfRay }, { status: 500 });
    }
  };
}

export function createLagProbeHandler(): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const prisma = getPrisma(c.env);
    const cfRay = c.req.raw.headers.get('cf-ray') ?? '';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- throwaway field, schema.prisma is hand-edited for this harness
      const row = await (prisma.vendor as any).findFirst({ select: { lagProbe: true } });
      return json({ ok: true, value: row?.lagProbe ?? null, cfRay });
    } catch (error) {
      const err = error as { name?: string; message?: string };
      const isValidation = (err.name ?? '').includes('Validation') || (err.message ?? '').includes('Unknown field');
      return json(
        { ok: false, error: { name: err.name ?? 'Error', message: err.message ?? '' }, cfRay },
        { status: isValidation ? 503 : 500 },
      );
    }
  };
}
`;

  const indexPatch = `
# Patch apps/api/src/index.ts:
#
# At the top, add the import next to createHealthHandler:
#   import { createLagProbeBaselineHandler, createLagProbeHandler } from './routes/lag-probe';
#
# In the legacy-routes block (around lines 25-27), add:
#   app.get('/api/lag-probe-baseline', createLagProbeBaselineHandler());
#   app.get('/api/lag-probe', createLagProbeHandler());
#
# These go on the LEGACY sub-router (not phase28) so they bypass the §3.3 envelope.
`;

  const schemaPatch = `
# Patch apps/api/prisma/schema.prisma:
#
# Inside model Vendor (around line 66, near contactEmail), add one line:
#
#   lagProbe String? @map("_lag_probe")
#
# Then from apps/api/:
#   pnpm prisma:generate    # or: pnpm exec prisma generate
`;

  log('--- apps/api/src/routes/lag-probe.ts (new file) ---');
  log(lagProbeTs);
  log(indexPatch);
  log(schemaPatch);
  log(
    'Apply the three edits, then redeploy the API Worker with `pnpm deploy:staging` from apps/api/.',
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Main.
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const preflightOnly = args.includes('--preflight-only');
  const printPatchesMode = args.includes('--print-patches');

  if (printPatchesMode) {
    printPatches();
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const logPath = join(OUTPUT_DIR, `lag-run-${RUN_TS}.log`);
  logStream = createWriteStream(logPath, { flags: 'a' });
  log(`Log: ${logPath}`);

  assertNotProduction();
  await preflight();

  if (preflightOnly) {
    log('--preflight-only set; exiting 0.');
    return;
  }

  await fingerprintAndConfirm();
  await confirm('Probe route is deployed and pre-flight passed. Start 5-cycle measurement?');

  const rows = [];
  for (let i = 1; i <= CYCLES; i++) {
    try {
      const row = await runCycle(i);
      rows.push(row);
    } catch (err) {
      log(`Cycle ${i} aborted: ${err.message}`, 'error');
      rows.push({
        run_id: i,
        T0_iso: '',
        success_time_iso: '',
        elapsed_seconds: 0,
        cf_ray: '',
        status_code_at_success: 0,
        hit_cap: false,
        errored: true,
        error: err.message,
      });
    }
    if (i < CYCLES) {
      await waitForColumnGone();
    }
  }

  await writeCsv(rows);
  const stats = summarize(rows);
  printSummary(rows, stats);

  await confirm('Measurement complete. Ready to remove any residual throwaway migration files?');
  await cleanupResidualMigrations();
  log('Done. Run the cleanup checklist in .context/staging-bootstrap-for-lag-probe.md §Reverse.');
}

main().catch((err) => {
  log(`FATAL: ${err.stack ?? err.message}`, 'fatal');
  process.exit(1);
});
