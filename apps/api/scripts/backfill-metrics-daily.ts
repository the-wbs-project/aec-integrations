/**
 * backfill-metrics-daily.ts — reconstruct the pre-snapshot segment of
 * `metrics_daily` on a deployed (or local) D1 (AECI-581 / `ADMIN_PANEL_SPEC.md`
 * §7.1).
 *
 * The 00:15 UTC snapshot cron can only tell the truth from the day it starts
 * running; this fills in the days before it from `page_views`, `audit_log`, and
 * `products.created_at`. It is the Node shell around the tested core
 * (`src/lib/metrics-backfill.ts`): it supplies argv, the `wrangler d1 execute`
 * I/O, and `console`. Same shape as `retract-product.ts` /
 * `reconcile-product-counts.ts`.
 *
 * WHAT IT DOES (on `--apply`):
 *   1. Zero-fills every `(day, metric)` in the range — §7.4's pruning cron may
 *      not delete a `page_views` day the snapshot never captured, so a quiet day
 *      needs a row too.
 *   2. Aggregates the eight flow series into those rows. Five land as `measured`,
 *      three (the `audit_log`-derived catalog series) as `reconstructed`.
 *
 * It writes only flow metrics. Stocks — catalog totals, queue depths, subscriber
 * counts — are NOT backfilled: §4 shows a past total is unrecoverable (827
 * `integration.created` events back 496 live rows), so a reconstruction would be
 * wrong rather than approximate. Those series begin at the first cron run.
 *
 * SAFETY:
 *   - Dry-run by default; `--apply` performs the writes.
 *   - Refuses `production` writes without `--allow-production`.
 *   - **Refuses a range containing unclassified page views** (`is_bot IS NULL`)
 *     unless `--force`. Those rows read as human, and `metrics_daily` is kept
 *     indefinitely, so backfilling over them would freeze an inflated human count
 *     into the long memory permanently. Fix first, on the same tier:
 *       wrangler d1 execute <db> --env <env> --remote \
 *         --file=../../scripts/ops/backfill-page-view-bots.sql
 *   - Re-runnable: every write is an upsert keyed `(day, metric)`, and a
 *     `reconstructed` row can never overwrite a `measured` one — so a real
 *     snapshot survives any number of re-runs.
 *   - Emits NO `audit_log` row (derived bookkeeping — ADR 0022 / §13 D11).
 *
 * USAGE (from the repo root; remote needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
 *   # dry-run over everything reconstructible, against production:
 *   pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env production
 *   # apply an explicit range (production requires the extra guard flag):
 *   pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env production \
 *     --from 2026-06-23 --to 2026-08-12 --apply --allow-production
 *   # against the seeded local D1:
 *   pnpm --filter @aeci/api ops:backfill-metrics-daily -- --local --apply
 */

import { spawnSync } from 'node:child_process';

import {
  BACKFILL_SERIES,
  buildAggregateStatements,
  buildCoverageProbe,
  buildMetricsBackfillStatements,
  buildProductsCrossCheck,
  buildRangeProbe,
  buildUnclassifiedProbe,
  buildZeroFillStatements,
  daysInRange,
  type BackfillRange,
} from '../src/lib/metrics-backfill';

// ─── Args + target resolution ────────────────────────────────────────────────

const D1_ENVS = ['preview', 'staging', 'demo', 'production'] as const;
type D1Env = (typeof D1_ENVS)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Target {
  label: string;
  db: string;
  flags: string[];
  remote: boolean;
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
    return { label: 'local', db: 'aeci-app-preview', flags: ['--local'], remote: false };
  }
  const env = readValueFlag(argv, '--env');
  if (!env || !(D1_ENVS as readonly string[]).includes(env)) {
    throw new Error(
      `Set --env ${D1_ENVS.join('|')} (or --local for the seeded local D1). Got: ${env ?? '(unset)'}.`,
    );
  }
  const e = env as D1Env;
  return { label: e, db: `aeci-app-${e}`, flags: ['--env', e, '--remote'], remote: true };
}

function readDayFlag(argv: string[], name: string): string | undefined {
  const value = readValueFlag(argv, name);
  if (value === undefined) return undefined;
  if (!DAY_RE.test(value)) throw new Error(`${name} must be YYYY-MM-DD. Got: ${value}`);
  return value;
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
  'Run via pnpm so wrangler is on PATH:\n  pnpm --filter @aeci/api ops:backfill-metrics-daily -- …';

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

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
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

  console.log('── backfill-metrics-daily ──────────────────────────────────');
  console.log(`Mode:  ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(
    `DB:    ${target.db}${target.remote ? ` (--env ${target.label}, remote)` : ' (local)'}`,
  );

  // 1. Resolve the range. Default: everything there is anything to reconstruct for.
  const probed = runD1<{ first_day: string | null; last_day: string | null }>(
    target,
    buildRangeProbe(),
  )[0]?.results[0];
  const fromDay = readDayFlag(argv, '--from') ?? probed?.first_day ?? undefined;
  const toDay = readDayFlag(argv, '--to') ?? probed?.last_day ?? undefined;
  if (!fromDay || !toDay) {
    console.log('');
    console.log('Nothing to reconstruct: no page views, audit events, products, or profiles.');
    return 0;
  }
  if (fromDay > toDay) {
    console.error(`Empty range: --from ${fromDay} is after --to ${toDay}.`);
    return 1;
  }
  const range: BackfillRange = { fromDay, toDay, computedAt: new Date().toISOString() };
  const days = daysInRange(range);
  console.log(
    `Range: ${fromDay} → ${toDay} (${days.length} day(s) × ${BACKFILL_SERIES.length} metrics)`,
  );
  console.log('');

  // 2. The AECI-582 gate. `metrics_daily` is kept indefinitely, so a traffic
  //    backfill over unclassified rows is a permanent error, not a temporary one.
  const unclassified =
    runD1<{ unclassified: number }>(target, buildUnclassifiedProbe(range))[0]?.results[0]
      ?.unclassified ?? 0;
  if (unclassified > 0) {
    console.warn(
      `⚠  ${unclassified} page view(s) in this range have no bot classification and read as HUMAN.`,
    );
    if (!force) {
      console.error(
        '\nRefusing without --force. Run the AECI-582 classifier on this tier first:\n' +
          `     wrangler d1 execute ${target.db} ${target.flags.join(' ')} \\\n` +
          '       --file=../../scripts/ops/backfill-page-view-bots.sql\n' +
          'metrics_daily is retained indefinitely, so backfilling now would freeze the wrong\n' +
          'human/bot split into the long memory permanently.',
      );
      return 1;
    }
    console.warn('   --force set: proceeding; the traffic split for those days WILL be wrong.\n');
  } else {
    console.log('✓ Bot classification: every page view in the range is classified.');
  }

  // 3. The §7.1 cross-check on the exact series — a verification, never a source.
  const cross = runD1<{ products: number; product_created_events: number }>(
    target,
    buildProductsCrossCheck(),
  )[0]?.results[0];
  if (cross) {
    console.log(
      `✓ Products cross-check: ${cross.products} row(s) vs ${cross.product_created_events} ` +
        `product.created event(s). catalog.products_created is backfilled from products.created_at ` +
        `(exact — §4), so an audit-log shortfall here is expected, not a defect.`,
    );
  }
  console.log('');

  // 4. Provenance, stated before anything is written.
  console.log('Series provenance:');
  for (const s of BACKFILL_SERIES) {
    console.log(
      `  ${s.source === 'measured' ? '✓' : '~'} ${s.metric.padEnd(30)} ${s.source} — ${s.rationale}`,
    );
  }
  console.log('');

  const zeroFill = buildZeroFillStatements(range);
  const aggregates = buildAggregateStatements(range);

  // 5. Dry run stops here.
  if (!apply) {
    console.log(
      `DRY RUN — nothing written. On --apply: ${zeroFill.length} zero-fill statement(s) ` +
        `covering ${days.length * BACKFILL_SERIES.length} (day, metric) pair(s), then ` +
        `${aggregates.length} aggregate statement(s).`,
    );
    console.log(
      'Existing rows are safe: zero-fill is DO NOTHING, and a reconstructed value never overwrites a measured one.',
    );
    console.log('Re-run with --apply to write them.');
    return 0;
  }

  // 6. Apply. One statement per execute so a failure names itself.
  const statements = buildMetricsBackfillStatements(range);
  for (const [i, sql] of statements.entries()) {
    runD1<unknown>(target, sql);
    if ((i + 1) % 10 === 0 || i === statements.length - 1) {
      console.log(`   … ${i + 1}/${statements.length} statement(s)`);
    }
  }

  // 7. Confirm by counting rows, NOT by summing `meta.changes` — D1 does not
  //    populate `changes` for an `INSERT … ON CONFLICT`, so a change count would
  //    read 0 on a run that wrote thousands of rows.
  const coverage = runD1<{ rows_total: number; days_covered: number; reconstructed: number }>(
    target,
    buildCoverageProbe(range),
  )[0]?.results[0];
  console.log('');
  console.log(`✓ ${statements.length} statement(s) applied to ${target.db}.`);
  if (coverage) {
    console.log(
      `  metrics_daily now holds ${coverage.rows_total} row(s) across ${coverage.days_covered}/${days.length} ` +
        `day(s) in this range; ${coverage.reconstructed} carry source='reconstructed'.`,
    );
  }
  console.log('   (No audit_log row — derived bookkeeping, ADR 0022 / §13 D11.)');
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
