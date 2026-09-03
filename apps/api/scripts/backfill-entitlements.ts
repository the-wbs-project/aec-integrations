/**
 * backfill-entitlements.ts — Tier-0 ops CLI that restores the §2.1 mirror invariant on
 * a deployed D1 after AECI-609's `vendor_entitlements` table lands
 * (`docs/STAGE_2_PAID_TIERS_SPEC.md` §2.4). This is the Node shell around the tested
 * core (`src/lib/backfill-entitlements.ts`): it supplies argv, the
 * `wrangler d1 execute` I/O, credentials, and `console`. Same shape as
 * `retract-product.ts` / `purge-algolia-orphans.ts`.
 *
 * WHY IT EXISTS. Rows already `verified = 1` from the Airtable/claim era assert "this
 * vendor is verified" with no entitlement row behind them, which violates the mirror
 * the moment §2 ships. `docs/migrations.md` (~:128, ~:249) keeps migrations declarative,
 * so a one-off data backfill is a script run explicitly per environment — and it has to
 * be per-environment anyway, because the fixture seeds never run remotely.
 *
 * WHAT IT DOES (on `--apply`):
 *   1. Reads FORWARD drift  — `verified = 1` with no entitlement row.
 *   2. Reads REVERSE drift  — an `active` entitlement on a `verified = 0` vendor.
 *   3. Inserts a perpetual, TERMLESS `active` row for each forward-drifted vendor
 *      (null period bounds, so the partial expiry index and the §7 cron ignore them).
 *   4. Re-reads the forward drift and asserts it is now empty.
 *
 * SAFETY:
 *   - Dry-run by default; `--apply` performs the writes.
 *   - Refuses `production` writes without `--allow-production`.
 *   - **Refuses to run at all when there is REVERSE drift**, unless
 *     `--ignore-reverse-drift`. It never writes `vendors.verified` — moving the mirror
 *     outside `src/lib/vendor-entitlement.ts` is exactly what §2.1 forbids, and an ops
 *     script is not exempt. Reverse drift means a batch half-landed and wants a human.
 *   - Idempotent: every INSERT carries a `WHERE NOT EXISTS` re-guard, so a partially
 *     completed run can simply be re-run.
 *   - Emits NO `audit_log` row (there is no handler; same as `retract-product.ts`). The
 *     `notes` column carries the provenance instead.
 *
 * PROOF IT LANDED is the `entitlement_mirror_drift` data-quality check (Guard 2, 04:00
 * UTC): "the backfill ran on staging but not demo" is otherwise invisible until a
 * reader notices a missing badge. Run this on EVERY deployed tier.
 *
 * USAGE (from apps/api; remote needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
 *   # dry-run — report both drift directions, write nothing:
 *   pnpm --filter @aeci/api ops:backfill-entitlements -- --env staging
 *   # apply:
 *   pnpm --filter @aeci/api ops:backfill-entitlements -- --env staging --apply
 *   # production requires the extra guard flag:
 *   pnpm --filter @aeci/api ops:backfill-entitlements -- --env production --apply --allow-production
 *   # against the local seeded D1:
 *   pnpm --filter @aeci/api ops:backfill-entitlements -- --local
 */

import { spawnSync } from 'node:child_process';

import {
  buildBackfillStatements,
  buildForwardDriftSql,
  buildReverseDriftSql,
  formatBackfillReport,
  type DriftedVendorRow,
  type ReverseDriftRow,
} from '../src/lib/backfill-entitlements';

// ─── Args + target resolution ────────────────────────────────────────────────

const D1_ENVS = ['preview', 'staging', 'demo', 'production'] as const;
type D1Env = (typeof D1_ENVS)[number];

interface Target {
  label: string;
  db: string;
  flags: string[];
  remote: boolean;
  env: D1Env | undefined;
}

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function resolveTarget(argv: string[]): Target {
  if (argv.includes('--local')) {
    return {
      label: 'local',
      db: 'aeci-app-preview',
      flags: ['--local'],
      remote: false,
      env: undefined,
    };
  }
  const env = readValueFlag(argv, '--env');
  if (!env || !(D1_ENVS as readonly string[]).includes(env)) {
    throw new Error(
      `Set --env ${D1_ENVS.join('|')} (or --local for the seeded local D1). Got: ${env ?? '(unset)'}.`,
    );
  }
  const e = env as D1Env;
  return { label: e, db: `aeci-app-${e}`, flags: ['--env', e, '--remote'], remote: true, env: e };
}

// ─── Wrangler I/O (mirrors retract-product.ts) ───────────────────────────────

interface D1ExecResult<T> {
  results: T[];
  success: boolean;
  meta?: { changes?: number };
}

function parseWranglerJson<T>(stdout: string): D1ExecResult<T>[] {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as D1ExecResult<T>[];
}

function wranglerMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

const WRANGLER_HINT =
  'Run this through pnpm from apps/api so the workspace wrangler is on PATH: pnpm --filter @aeci/api ops:backfill-entitlements -- <flags>';

function runD1<T>(target: Target, sql: string): D1ExecResult<T>[] {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', target.db, ...target.flags, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) {
    if (wranglerMissing(res.error)) throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    throw res.error;
  }
  if (res.status !== 0) {
    const hint = target.remote
      ? `Check CLOUDFLARE_API_TOKEN (Account→D1→Edit) + CLOUDFLARE_ACCOUNT_ID, and that "${target.db}" exists for --env ${target.label}.`
      : 'Set up the local D1 first:  pnpm --filter @aeci/api db:setup:local';
    throw new Error(
      `wrangler d1 execute failed on "${target.db}" (exit ${res.status}).\n${hint}\n\n${res.stderr}`,
    );
  }
  return parseWranglerJson<T>(res.stdout);
}

const rowsOf = <T>(results: D1ExecResult<T>[]): T[] => results[0]?.results ?? [];

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const ignoreReverse = argv.includes('--ignore-reverse-drift');
  const target = resolveTarget(argv);

  if (target.remote && !process.env.CLOUDFLARE_API_TOKEN) {
    console.warn('⚠  CLOUDFLARE_API_TOKEN is unset — wrangler --remote will fail to authenticate.');
  }
  if (apply && target.label === 'production' && !argv.includes('--allow-production')) {
    console.error(
      'Refusing to --apply against PRODUCTION without --allow-production. Re-run with both if intended.',
    );
    return 1;
  }

  console.log('── backfill-entitlements ───────────────────────────────────');
  console.log(`Target: ${target.db} (${target.label})`);
  console.log(`Mode:   ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log('');

  const forward = rowsOf(runD1<DriftedVendorRow>(target, buildForwardDriftSql()));
  const reverse = rowsOf(runD1<ReverseDriftRow>(target, buildReverseDriftSql()));

  console.log(formatBackfillReport(forward, reverse));
  console.log('');

  if (reverse.length > 0 && !ignoreReverse) {
    console.error(
      'Refusing to proceed with reverse drift present. This script never writes vendors.verified,\n' +
        'so it cannot repair it (STAGE_2_PAID_TIERS_SPEC.md §2.1). Investigate those vendors, then\n' +
        're-run — or pass --ignore-reverse-drift to backfill the forward half regardless.',
    );
    return 1;
  }

  if (forward.length === 0) {
    console.log(`✓ Nothing to backfill — ${target.db} already satisfies the mirror invariant.`);
    return 0;
  }

  if (!apply) {
    console.log(`Dry run: would insert ${forward.length} perpetual, termless 'active' row(s).`);
    console.log('Re-run with --apply to write them.');
    return 0;
  }

  const now = new Date().toISOString();
  const ids = forward.map(() => crypto.randomUUID());
  const statements = buildBackfillStatements(forward, { now, ids });
  runD1(target, statements.join('\n'));

  const remaining = rowsOf(runD1<DriftedVendorRow>(target, buildForwardDriftSql()));
  if (remaining.length > 0) {
    console.error(
      `✗ ${remaining.length} vendor(s) still drifted after the write — the backfill did not fully land.`,
    );
    return 1;
  }

  console.log(`✓ Inserted ${forward.length} entitlement row(s) into ${target.db}.`);
  console.log('');
  console.log(
    'Note: this writes no audit_log row (Tier 0 — there is no handler to route it through);\n' +
      'the `notes` column carries the provenance. Confirm on the next 04:00 UTC data-quality\n' +
      'run that `entitlement_mirror_drift` reports 0 for this tier — that is the proof it landed.',
  );
  return 0;
}

// Entrypoint guard — importing this module (e.g. in tests) must not run main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
