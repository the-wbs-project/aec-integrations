/**
 * Algolia ↔ Supabase index-drift reconciliation — CLI / CI runner (AECI-140).
 *
 * Counts the **promoted** product / vendor / integration rows in Supabase and
 * the object count of each matching Algolia index, and reports any per-index
 * mismatch. The comparison rule lives in `src/lib/algolia-drift.ts` — this is a
 * thin runner around `findAlgoliaIndexDrift` (the daily 09:00 UTC = 04:00 EST run
 * is the Worker cron in `src/scheduled.ts`; §23.1).
 *
 * Two surfaces use this CLI:
 *   - the `deploy-staging` job's report-only post-deploy hook (CICD §3.2 step 5),
 *   - manual / incident triage.
 *
 * Connection: like the bulk-sync + reconcile-counts scripts this is a Node CLI
 * (never deployed). It uses the VANILLA `@prisma/client` over `DIRECT_URL`
 * (privileged Postgres role) — NOT Accelerate / `@prisma/client/edge`, which is
 * the Worker-runtime rule. Algolia is counted with the dependency-free
 * `createAlgoliaCounter` (a single search query), so no SDK is needed.
 *
 * Report-only — no auto-remediation (§23.1; humans triage). To repair drift,
 * re-run the AECI-138 bulk sync:
 *   pnpm --filter @aeci/api db:algolia-bulk-sync -- --env <env>
 *
 * Usage:
 *   pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env <preview|staging|production> [--locale en-US]
 *
 * Exit codes: 0 on success (clean OR drift — the Datadog monitor on
 * `aeci.algolia.index_drift` is the alert, not a red run); 1 only on operational
 * failure (missing `DIRECT_URL`, an invalid `--env`, or an Algolia API error
 * when creds are present). Missing `ALGOLIA_APP_ID` / `ALGOLIA_ADMIN_KEY` → clean
 * SKIP (exit 0), mirroring `scripts/algolia/apply-settings.mjs`.
 *
 * Required env: DIRECT_URL. Optional: ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY (skip
 * when absent), DD_API_KEY / DD_SITE (Datadog), DD_ENV / ENV (env tag default).
 */

import { appendFileSync } from 'node:fs';

import type { AlgoliaEnv } from '@aeci/shared/algolia';

import {
  createAlgoliaCounter,
  findAlgoliaIndexDrift,
  formatDriftTable,
  type AlgoliaIndexDrift,
  type DriftCountPrisma,
} from '../src/lib/algolia-drift';

const VALID_ENVS: readonly AlgoliaEnv[] = ['development', 'preview', 'staging', 'production'];

type CliClient = DriftCountPrisma & { $disconnect(): Promise<void> };

function parseEnv(): AlgoliaEnv | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--env');
  const raw = idx >= 0 ? args[idx + 1] : (process.env.DD_ENV ?? process.env.ENV);
  if (raw && (VALID_ENVS as readonly string[]).includes(raw)) return raw as AlgoliaEnv;
  return null;
}

function parseLocale(): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--locale');
  return idx >= 0 ? args[idx + 1] : undefined;
}

/** Best-effort Datadog signal. Emits the `aeci.algolia.index_drift` gauge for
 * every entity (0 when clean, so a no-data monitor can tell "ran clean" from
 * "didn't run"), and an error-status log when any index drifts. No-op when
 * `DD_API_KEY` is unset. */
async function emitDatadog(env: string, rows: AlgoliaIndexDrift[]): Promise<void> {
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return;
  const site = process.env.DD_SITE || 'us5.datadoghq.com';
  const baseTags = ['app:aeci', 'service:aeci-api', 'source:reconcile-algolia-drift', `env:${env}`];
  const headers = { 'content-type': 'application/json', 'dd-api-key': apiKey };
  const timestamp = Math.floor(Date.now() / 1000);

  const metric = fetch(`https://api.${site}/api/v2/series`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      series: rows.map((r) => ({
        metric: 'aeci.algolia.index_drift',
        type: 3, // gauge
        points: [{ timestamp, value: r.drift }],
        tags: [...baseTags, `entity:${r.entity}`, `index:${r.indexName}`],
      })),
    }),
  }).catch((e) => console.warn('datadog: metric submit failed', e));

  const drifted = rows.filter((r) => r.drift !== 0);
  const log =
    drifted.length > 0
      ? fetch(`https://http-intake.logs.${site}/api/v2/logs`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            message: `Algolia index drift on ${env}: ${drifted
              .map((d) => `${d.indexName} ${d.drift > 0 ? '+' : ''}${d.drift}`)
              .join(', ')}`,
            status: 'error',
            service: 'aeci-api',
            ddsource: 'cli',
            ddtags: baseTags.join(','),
            drift: drifted,
          }),
        }).catch((e) => console.warn('datadog: log submit failed', e))
      : Promise.resolve();

  await Promise.allSettled([metric, log]);
}

/** Append a Markdown summary to the GitHub Actions step summary, if present. */
function writeStepSummary(env: string, rows: AlgoliaIndexDrift[]): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const drifted = rows.filter((r) => r.drift !== 0);
  const lines = [
    `### Algolia index drift — \`${env}\``,
    '',
    '| entity | index | supabase | algolia | drift |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rows.map(
      (r) => `| ${r.entity} | \`${r.indexName}\` | ${r.supabase} | ${r.algolia} | ${r.drift} |`,
    ),
    '',
    drifted.length > 0
      ? `⚠️ ${drifted.length} index(es) drifted (report-only). Repair: \`pnpm --filter @aeci/api db:algolia-bulk-sync -- --env ${env}\`.`
      : '✓ No drift — every index matches its promoted Supabase rows.',
    '',
  ];
  try {
    appendFileSync(file, lines.join('\n'));
  } catch (e) {
    console.warn('step summary: write failed', e);
  }
}

export async function main(): Promise<number> {
  const env = parseEnv();
  if (!env) {
    console.error(
      `--env is required and must be one of ${VALID_ENVS.join(' | ')} (or set DD_ENV / ENV).`,
    );
    return 1;
  }
  const locale = parseLocale();

  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) {
    console.error('Missing required env: DIRECT_URL (set in apps/api/.dev.vars).');
    return 1;
  }

  const appId = process.env.ALGOLIA_APP_ID;
  const adminKey = process.env.ALGOLIA_ADMIN_KEY;
  if (!appId || !adminKey) {
    console.warn(
      '⚠ ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY not set — skipping Algolia index-drift check.',
    );
    return 0;
  }

  // Vanilla client over DIRECT_URL (privileged role). NOT Accelerate / edge —
  // that rule is for the Worker runtime, not this CLI.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: directUrl }) as unknown as CliClient;
  const algolia = createAlgoliaCounter(appId, adminKey);

  try {
    const rows = await findAlgoliaIndexDrift({ prisma, algolia }, { env, locale });
    console.log(`Algolia index drift — env=${env}, locale=${locale ?? 'en-US'}:`);
    console.log(formatDriftTable(rows));

    await emitDatadog(env, rows);
    writeStepSummary(env, rows);

    const drifted = rows.filter((r) => r.drift !== 0);
    if (drifted.length > 0) {
      for (const r of drifted) {
        console.warn(
          `::warning::Algolia index drift on ${env}: ${r.indexName} ${r.drift > 0 ? '+' : ''}${
            r.drift
          } (supabase=${r.supabase}, algolia=${r.algolia})`,
        );
      }
      console.warn(
        `Report-only — re-run the bulk sync to repair: pnpm --filter @aeci/api db:algolia-bulk-sync -- --env ${env}`,
      );
    } else {
      console.log('✓ No Algolia index drift — every index matches its promoted Supabase rows.');
    }
    // Report-only: drift does NOT fail the run (the Datadog monitor alerts).
    return 0;
  } catch (error) {
    console.error('reconcile-algolia-drift: failed to compare indexes', error);
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('reconcile-algolia-drift.ts');

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('reconcile-algolia-drift: fatal', err);
      process.exitCode = 1;
    });
}
