/**
 * The tested core of `scripts/backfill-traffic-classifications.ts` (AECI-1444,
 * `DATABASE_SCHEMA.md` §9.7): one operator push that classifies a range of past
 * `page_views` days at the current classifier version.
 *
 * The script sends ONE `traffic_classify` message with `trafficClassify: { day,
 * through }` onto the tier's `aeci-traffic-classify-{env}` queue through the
 * Cloudflare Queues HTTP publish endpoint. The Worker's consumer classifies `day`
 * and sends the next day itself, so the whole range runs one day per invocation on
 * the same path as the nightly job. Each day leaves a `job_runs` row with
 * `detail.backfill`. Same shape as `backfill-ownership-sync.ts`.
 *
 * The range is checked here with the consumer's own `backfillRefusal`, so the script
 * refuses what the consumer would refuse. It reads no D1. The operator reads the
 * earliest day with {@link EARLIEST_DAY_SQL}, from wherever the tier's D1 is readable.
 *
 * No `audit_log` row: `page_view_classifications` is derived and log-class (ADR 0022).
 */

import type { ScheduledJobMessage } from '../env';
import { queuePublishUrl } from './backfill-ownership-sync';
import { backfillRefusal, type BackfillRefusal } from './traffic-classification-writer';

/** The read-only query for the earliest surviving `page_views` day. */
export const EARLIEST_DAY_SQL =
  'SELECT substr(min(created_at), 1, 10) AS earliest_day FROM page_views;';

/** The days in `[from, through]`, inclusive. Both are already validated. */
export function backfillDayCount(from: string, through: string): number {
  return Math.round((Date.parse(through) - Date.parse(from)) / 86_400_000) + 1;
}

export type TrafficBackfillPlan =
  | { ok: true; message: ScheduledJobMessage; days: number }
  | { ok: false; refusal: BackfillRefusal };

/** The first message of the chain, or the refusal the consumer would return. */
export function planTrafficBackfill(
  range: { from: string; through: string },
  now: Date,
): TrafficBackfillPlan {
  const refusal = backfillRefusal({ day: range.from, through: range.through }, now);
  if (refusal) return { ok: false, refusal };
  return {
    ok: true,
    days: backfillDayCount(range.from, range.through),
    message: {
      job: 'traffic_classify',
      trigger: 'manual',
      enqueuedAt: now.toISOString(),
      trafficClassify: { day: range.from, through: range.through },
    },
  };
}

/** What each refusal means, in the operator's terms. */
export const REFUSAL_TEXT: Record<BackfillRefusal, string> = {
  malformed_day: '--from and --through must be real YYYY-MM-DD dates.',
  day_after_through: '--from is after --through.',
  too_old:
    '--from is more than 370 days ago. Its swarm prior or operator-anchor lookback may reach pruned rows.',
  evidence_open:
    '--through has not closed yet. A day closes 30 minutes after it ends (the SPA follow-up margin).',
};

export interface PublishResult {
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * Publish the one message. The response body is always read, so none is left
 * open. Never throws: a failure is returned, and the caller exits non-zero.
 */
export async function publishTrafficBackfill(args: {
  fetch: typeof fetch;
  accountId: string;
  queueId: string;
  apiToken: string;
  message: ScheduledJobMessage;
}): Promise<PublishResult> {
  try {
    const res = await args.fetch(queuePublishUrl(args.accountId, args.queueId), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body: args.message, content_type: 'json' }),
    });
    const text = await res.text();
    let success = res.ok;
    try {
      success = success && (JSON.parse(text) as { success?: boolean }).success !== false;
    } catch {
      // A non-JSON 2xx is treated by status alone.
    }
    return { ok: success, status: res.status, ...(success ? {} : { error: text.slice(0, 300) }) };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── Argv (pure, so the gates are unit-tested) ───────────────────────────────

export const TRAFFIC_BACKFILL_ENVS = ['staging', 'demo', 'production'] as const;
export type TrafficBackfillEnv = (typeof TRAFFIC_BACKFILL_ENVS)[number];

export type TrafficBackfillArgs =
  | {
      ok: true;
      env: TrafficBackfillEnv;
      queue: string;
      from: string;
      through: string;
      apply: boolean;
      queueId?: string;
    }
  | { ok: false; error: string };

function readValueFlag(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

/**
 * Parse and gate the CLI. Refusals, in order:
 *  - no `--env staging|demo|production`. There is no `--local`: the local queue
 *    lives inside `wrangler dev` and has no publish endpoint outside it;
 *  - no `--from` or `--through`;
 *  - `--apply` on production without `--allow-production`;
 *  - `--apply` without `--queue-id` (from `wrangler queues info`).
 * The range itself is checked by {@link planTrafficBackfill}, against the clock.
 */
export function parseTrafficBackfillArgs(argv: readonly string[]): TrafficBackfillArgs {
  const apply = argv.includes('--apply');
  const env = readValueFlag(argv, '--env');
  if (!env || !(TRAFFIC_BACKFILL_ENVS as readonly string[]).includes(env)) {
    return {
      ok: false,
      error: `Set --env ${TRAFFIC_BACKFILL_ENVS.join('|')}. Got: ${env ?? '(unset)'}.`,
    };
  }
  const e = env as TrafficBackfillEnv;
  const queue = `aeci-traffic-classify-${e}`;
  const from = readValueFlag(argv, '--from');
  const through = readValueFlag(argv, '--through');
  if (!from || !through) {
    return { ok: false, error: 'Set --from YYYY-MM-DD and --through YYYY-MM-DD (inclusive).' };
  }
  if (apply && e === 'production' && !argv.includes('--allow-production')) {
    return {
      ok: false,
      error:
        'Refusing to --apply against PRODUCTION without --allow-production. Re-run with both if intended.',
    };
  }
  const queueId = readValueFlag(argv, '--queue-id');
  if (apply && !queueId) {
    return {
      ok: false,
      error: `--apply needs --queue-id. Read it with: pnpm exec wrangler queues info ${queue}`,
    };
  }
  return { ok: true, env: e, queue, from, through, apply, ...(queueId ? { queueId } : {}) };
}
