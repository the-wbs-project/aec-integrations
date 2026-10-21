/**
 * backfill-ownership-sync.ts — send one ownership message per already-owned vendor
 * (AECI-1418, ruling Q7 on AECI-1341; `docs/REVIEW_APP_PROMOTE_API.md` §4d). The Node
 * shell around the tested core (`src/lib/backfill-ownership-sync.ts`): argv, the
 * `wrangler d1 execute` read, the Queues HTTP publish, and `console`. Same shape as the
 * retired `backfill-licenses.ts`.
 *
 * WHAT IT DOES:
 *   1. Reads every vendor with `owned_at` set (or the one `--vendor` names).
 *   2. Prints them. That is the whole dry run.
 *   3. On `--apply`, publishes one `{ vendorId, reason: 'backfill', enqueuedAt }`
 *      message per vendor onto `aeci-ownership-sync-{env}`. The Worker's consumer
 *      then reads each vendor's current state and PUTs it to the review app, writing
 *      an `ownership_sync_deliveries` row per attempt. Check those rows for the result.
 *
 * SAFETY:
 *   - Dry run by default; `--apply` publishes.
 *   - Refuses production without `--allow-production`. Its prod run needs Chris's
 *     go-ahead on the day, and AECI-1412 (the receiver) must be live first.
 *   - Refuses `--apply` with `--local`: the local queue lives inside `wrangler dev`.
 *   - Writes nothing to D1 and calls nothing but the Queues API. Re-runnable: the
 *     record is the whole current state, so a second send converges to the same place.
 *
 * USAGE (from apps/api; remote needs CLOUDFLARE_API_TOKEN with Queues Edit + D1 Read,
 * and CLOUDFLARE_ACCOUNT_ID):
 *   pnpm --filter @aeci/api ops:backfill-ownership-sync -- --local
 *   pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env staging
 *   pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env staging --apply --queue-id <id>
 *   pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env production --apply --allow-production --queue-id <id>
 *   pnpm --filter @aeci/api ops:backfill-ownership-sync -- --env staging --vendor <uuid>
 *
 * The queue id comes from `pnpm exec wrangler queues info aeci-ownership-sync-<env>`.
 *
 * Exit codes: 0 clean · 1 a publish failed or a refusal · 2 usage.
 */

import { spawnSync } from 'node:child_process';

import {
  buildOwnedVendorsSql,
  formatBackfillReport,
  parseBackfillArgs,
  planOwnershipBackfill,
  publishOwnershipMessages,
  type BackfillOwnedVendorRow,
  type BackfillTarget,
} from '../src/lib/backfill-ownership-sync';

interface D1ExecResult<T> {
  results: T[];
  success: boolean;
}

const WRANGLER_HINT =
  'Run this through pnpm from apps/api so the workspace wrangler is on PATH: pnpm --filter @aeci/api ops:backfill-ownership-sync -- <flags>';

function runD1<T>(target: BackfillTarget, sql: string): T[] {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', target.db, ...target.flags, '--json', '--command', sql],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    }
    throw res.error;
  }
  if (res.status !== 0) {
    const hint = target.remote
      ? `Check CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, and that "${target.db}" exists for --env ${target.label}.`
      : 'Set up the local D1 first:  pnpm --filter @aeci/api db:setup:local';
    throw new Error(
      `wrangler d1 execute failed on "${target.db}" (exit ${res.status}).\n${hint}\n\n${res.stderr}`,
    );
  }
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${res.stdout}`);
  return (JSON.parse(res.stdout.slice(start)) as D1ExecResult<T>[])[0]?.results ?? [];
}

export async function main(argv: string[]): Promise<number> {
  const args = parseBackfillArgs(argv);
  if (!args.ok) {
    console.error(args.error);
    return 2;
  }
  const { target, apply, vendorId, queueId } = args;

  console.log('── backfill-ownership-sync ─────────────────────────────────');
  console.log(`Target: ${target.db} → ${target.queue} (${target.label})`);
  console.log(`Mode:   ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log('');

  const rows = runD1<BackfillOwnedVendorRow>(target, buildOwnedVendorsSql(vendorId));
  console.log(formatBackfillReport(rows));
  console.log('');
  if (vendorId && rows.length === 0) {
    console.error(`✗ No vendor ${vendorId} on ${target.db}.`);
    return 1;
  }
  const messages = planOwnershipBackfill(rows, new Date());
  if (messages.length === 0) {
    console.log(`✓ Nothing to send from ${target.label}.`);
    return 0;
  }
  if (!apply) {
    console.log(
      `Dry run: would enqueue ${messages.length} message(s) on ${target.queue}. Re-run with --apply --queue-id <id>.`,
    );
    return 0;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Queues Edit) to --apply.');
    return 2;
  }
  const outcomes = await publishOwnershipMessages({
    fetch,
    accountId,
    queueId: queueId!,
    apiToken,
    messages,
  });
  const failed = outcomes.filter((o) => !o.ok);
  for (const o of failed) {
    console.error(`  ✗ ${o.vendorId}: HTTP ${o.status ?? 'none'} ${o.error ?? ''}`);
  }
  console.log(
    `${failed.length === 0 ? '✓' : '✗'} Enqueued ${outcomes.length - failed.length} of ${outcomes.length} on ${target.queue}. Check ownership_sync_deliveries for the deliveries.`,
  );
  return failed.length === 0 ? 0 : 1;
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
