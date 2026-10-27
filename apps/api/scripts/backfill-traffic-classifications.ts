/**
 * backfill-traffic-classifications.ts — classify past `page_views` days at the current
 * classifier version (AECI-1444; `docs/DATABASE_SCHEMA.md` §9.7, runbook in
 * `docs/RUNBOOKS.md` "Backfill traffic classifications"). The Node shell around the
 * tested core (`src/lib/backfill-traffic-classifications.ts`): argv, the Queues HTTP
 * publish, and `console`. Same shape as `backfill-ownership-sync.ts`.
 *
 * WHAT IT DOES:
 *   1. Checks the range with the consumer's own rules (format, order, the 370-day
 *      limit, and a closed follow-up window on `--through`).
 *   2. Prints the one message it would send. That is the whole dry run.
 *   3. On `--apply`, publishes `{ job: 'traffic_classify', trafficClassify: { day,
 *      through } }` onto `aeci-traffic-classify-{env}`. The Worker's consumer
 *      classifies `day`, then sends `day + 1` itself until `through`. Each day writes
 *      one `job_runs` row with `detail.backfill`. Check those rows for progress.
 *
 * SAFETY:
 *   - Dry run by default; `--apply` publishes.
 *   - Refuses production without `--allow-production`. Each tier's run needs Chris's
 *     go-ahead on the day, after an `ops:traffic-shadow` dry run over the range.
 *   - Reads no D1 and calls nothing but the Queues API. Re-runnable: a day already
 *     at the current version writes nothing.
 *
 * USAGE (from apps/api; `--apply` needs CLOUDFLARE_API_TOKEN with Queues Edit, and
 * CLOUDFLARE_ACCOUNT_ID):
 *   pnpm --filter @aeci/api ops:backfill-traffic-classifications -- --env staging --from 2026-06-20 --through 2026-10-23
 *   pnpm --filter @aeci/api ops:backfill-traffic-classifications -- --env staging --from 2026-06-20 --through 2026-10-23 --apply --queue-id <id>
 *   pnpm --filter @aeci/api ops:backfill-traffic-classifications -- --env production --from 2026-06-20 --through 2026-10-23 --apply --allow-production --queue-id <id>
 *
 * The queue id comes from `pnpm exec wrangler queues info aeci-traffic-classify-<env>`.
 *
 * Exit codes: 0 clean · 1 a publish failed or a refusal · 2 usage.
 */

import {
  EARLIEST_DAY_SQL,
  parseTrafficBackfillArgs,
  planTrafficBackfill,
  publishTrafficBackfill,
  REFUSAL_TEXT,
} from '../src/lib/backfill-traffic-classifications';

export async function main(argv: string[]): Promise<number> {
  const args = parseTrafficBackfillArgs(argv);
  if (!args.ok) {
    console.error(args.error);
    return 2;
  }
  const { env, queue, from, through, apply, queueId } = args;

  console.log('── backfill-traffic-classifications ────────────────────────');
  console.log(`Target: ${queue} (${env})`);
  console.log(`Range:  ${from} → ${through}`);
  console.log(`Mode:   ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log('');

  const plan = planTrafficBackfill({ from, through }, new Date());
  if (!plan.ok) {
    console.error(`✗ Refused (${plan.refusal}): ${REFUSAL_TEXT[plan.refusal]}`);
    return 1;
  }
  console.log(`${plan.days} day(s), one consumer invocation each. First message:`);
  console.log(`  ${JSON.stringify(plan.message)}`);
  console.log('');

  if (!apply) {
    console.log(`The earliest surviving day on the tier's D1: ${EARLIEST_DAY_SQL}`);
    console.log(
      `Dry run: would enqueue 1 message on ${queue}. Re-run with --apply --queue-id <id>.`,
    );
    return 0;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Queues Edit) to --apply.');
    return 2;
  }
  const result = await publishTrafficBackfill({
    fetch,
    accountId,
    queueId: queueId!,
    apiToken,
    message: plan.message,
  });
  if (!result.ok) {
    console.error(`✗ Publish failed: HTTP ${result.status ?? 'none'} ${result.error ?? ''}`);
    return 1;
  }
  console.log(
    `✓ Enqueued on ${queue}. The chain ends at the job_runs row whose detail.day is ${through}.`,
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
