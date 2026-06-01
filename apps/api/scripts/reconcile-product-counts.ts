/**
 * Denormalized product-count reconciliation (AECI-104).
 *
 * Recomputes `integration_count`, `review_count`, `rating_overall_avg`, and
 * `rating_onboarding_avg` for every product from the source rows
 * (`integrations` / `reviews`) and reports any product whose stored columns have
 * drifted. The aggregation rule lives in `src/lib/product-counts.ts` — this is a
 * thin CLI/CI runner around `findProductCountDrift` / `recomputeProductCounts`.
 *
 * Connection: like the bulk-migrate script this is a Node CLI (never deployed).
 * It uses the VANILLA `@prisma/client` over `DIRECT_URL` (privileged Postgres
 * role, bypassing RLS) — NOT Accelerate / `@prisma/client/edge`.
 *
 * Usage:
 *   pnpm --filter @aeci/api db:reconcile-counts            # report-only
 *   pnpm --filter @aeci/api db:reconcile-counts -- --fix   # repair drift in place
 *
 * Exit codes: 0 = no drift (or drift fixed and re-verified clean), 1 = drift
 * found (report-only) or drift remained after --fix. The non-zero exit fails the
 * scheduled CI job; the script also emits a Datadog metric (and a log on drift)
 * when `DD_API_KEY` is set, so a monitor can alert independently.
 *
 * Required env (apps/api/.dev.vars or shell): DIRECT_URL.
 * Optional: DD_API_KEY / DD_SITE (Datadog), DD_ENV / ENV (drift metric tag).
 *
 * ── Future: scheduled CI guard (already wired) ──────────────────────────────
 * `.github/workflows/reconcile-counts.yml` runs this report-only against
 * staging/prod (`DIRECT_URL_STAGING` / `DIRECT_URL_PRODUCTION`) on a daily cron.
 * Never run `--fix` in CI — repair is a deliberate, reviewed action.
 */

import { findProductCountDrift, recomputeProductCounts } from '../src/lib/product-counts';
import type { DriftClient, ProductCountDrift, RecomputeClient } from '../src/lib/product-counts';

type ReconcileClient = DriftClient &
  RecomputeClient & {
    $transaction<T>(fn: (tx: RecomputeClient) => Promise<T>): Promise<T>;
    $disconnect(): Promise<void>;
  };

function formatDriftTable(drift: ProductCountDrift[]): string {
  const header = 'product_id                            field                stored      expected';
  const rows = drift.map(
    (d) =>
      `${d.productId.padEnd(36)}  ${d.field.padEnd(19)}  ${String(d.stored).padStart(8)}  ${String(
        d.expected,
      ).padStart(8)}`,
  );
  return [header, ...rows].join('\n');
}

/** Best-effort Datadog signal. Emits a gauge `aeci.product_counts.drift` always
 * (0 when clean, so a no-data monitor can tell "ran clean" from "didn't run"),
 * and an error-status log when drift is present. No-op when `DD_API_KEY` unset. */
async function emitDatadog(driftCount: number, drift: ProductCountDrift[]): Promise<void> {
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return;
  const site = process.env.DD_SITE || 'us5.datadoghq.com';
  const env = process.env.DD_ENV || process.env.ENV || 'unknown';
  const tags = [`env:${env}`, 'app:aeci', 'service:aeci-api', 'source:reconcile-counts'];
  const headers = { 'content-type': 'application/json', 'dd-api-key': apiKey };

  const metric = fetch(`https://api.${site}/api/v2/series`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      series: [
        {
          metric: 'aeci.product_counts.drift',
          type: 3, // gauge
          points: [{ timestamp: Math.floor(Date.now() / 1000), value: driftCount }],
          tags,
        },
      ],
    }),
  }).catch((e) => console.warn('datadog: metric submit failed', e));

  const log =
    driftCount > 0
      ? fetch(`https://http-intake.logs.${site}/api/v2/logs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message: `product-count drift detected: ${driftCount} field(s) across ${
              new Set(drift.map((d) => d.productId)).size
            } product(s)`,
            status: 'error',
            service: 'aeci-api',
            ddsource: 'cli',
            ddtags: tags.join(','),
            drift,
          }),
        }).catch((e) => console.warn('datadog: log submit failed', e))
      : Promise.resolve();

  await Promise.allSettled([metric, log]);
}

export async function main(): Promise<number> {
  const fix = process.argv.includes('--fix');
  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) {
    console.error('Missing required env: DIRECT_URL (set in apps/api/.dev.vars).');
    return 1;
  }

  // Vanilla client over DIRECT_URL (privileged role). NOT Accelerate / edge —
  // that rule is for the Worker runtime, not this CLI.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: directUrl }) as unknown as ReconcileClient;

  try {
    let drift = await findProductCountDrift(prisma);

    if (drift.length === 0) {
      console.log('✓ No product-count drift. All denormalized columns match source rows.');
      await emitDatadog(0, drift);
      return 0;
    }

    const productCount = new Set(drift.map((d) => d.productId)).size;
    console.error(
      `✗ Product-count drift detected: ${drift.length} field(s) across ${productCount} product(s).`,
    );
    console.error(formatDriftTable(drift));
    await emitDatadog(drift.length, drift);

    if (!fix) {
      console.error(
        '\nRun with --fix to repair in place: pnpm --filter @aeci/api db:reconcile-counts -- --fix',
      );
      return 1;
    }

    const driftedIds = [...new Set(drift.map((d) => d.productId))];
    console.log(`\nRepairing ${driftedIds.length} product(s)…`);
    await prisma.$transaction((tx) => recomputeProductCounts(tx, driftedIds));

    drift = await findProductCountDrift(prisma);
    if (drift.length > 0) {
      console.error(`✗ Drift remained after --fix: ${drift.length} field(s). Investigate.`);
      console.error(formatDriftTable(drift));
      return 1;
    }
    console.log('✓ Repaired — all products now match source rows.');
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('reconcile-product-counts.ts');

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('reconcile-product-counts: fatal', err);
      process.exitCode = 1;
    });
}
