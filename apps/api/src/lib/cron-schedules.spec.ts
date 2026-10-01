/**
 * The two vocabularies in `cron-schedules.ts` must stay in bijection — and every
 * schedule must stay byte-equal to `wrangler.jsonc`.
 *
 * `Record<ScheduledJob, AdminCronJob>` already makes a MISSING key a compile
 * error. What it cannot catch is a duplicated or mistyped *value* — two
 * dispatcher jobs mapped onto the same `AdminCronJob`, or one mapped onto an id
 * the read side never looks for. Either would silently drop a cron out of the
 * §5.6 liveness table (AECI-583), which is exactly the failure the table exists
 * to make visible.
 *
 * The `wrangler.jsonc` check (AECI-584) covers the older and worse failure the
 * file's header has always warned about in prose: `scheduled.ts` `switch`es on
 * `controller.cron`, so a trigger registered with Cloudflare that does not match
 * a constant here fires forever and dispatches nothing. Nothing throws, no test
 * fails, and the only symptom is a job that silently stopped running.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ADMIN_CRON_JOB, CRON_JOBS, CRON_SCHEDULES } from './cron-schedules';

/** The three env blocks that declare `triggers.crons` (staging, demo,
 *  production). Base config and `preview` deliberately declare none, so PR
 *  previews run no crons. */
const TRIGGER_BLOCKS = 3;

/** Read as text rather than parsed: `wrangler.jsonc` carries comments and
 *  trailing commas, and the point of this test is the literal string anyway. */
function wranglerConfig(): string {
  // cwd is the `apps/api` package when vitest runs (see `test/d1.ts`).
  return readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8');
}

describe('CRON_SCHEDULES ↔ wrangler.jsonc', () => {
  const config = wranglerConfig();
  /** Every `"<expr>",` line inside a `crons` array. */
  const declared = [...config.matchAll(/^\s{10}"([^"]+)",$/gm)].map((m) => m[1]);

  it.each(Object.entries(CRON_SCHEDULES))(
    '%s (%s) is registered in all three env trigger blocks',
    (_job, expression) => {
      expect(declared.filter((c) => c === expression)).toHaveLength(TRIGGER_BLOCKS);
    },
  );

  it('registers no trigger without a matching constant — an unroutable cron', () => {
    const known = new Set(Object.values(CRON_SCHEDULES));
    expect([...new Set(declared)].filter((c) => !known.has(c))).toEqual([]);
  });

  it('declares exactly the expected number of entries across the three blocks', () => {
    expect(declared).toHaveLength(CRON_JOBS.length * TRIGGER_BLOCKS);
  });
});

describe('ADMIN_CRON_JOB', () => {
  it('maps every dispatcher job onto an AdminCronJob id, one to one', () => {
    const mapped = Object.values(ADMIN_CRON_JOB);
    expect(mapped).toHaveLength(CRON_JOBS.length);
    // Set equality both ways: catches a duplicate value AND an id no cron writes.
    expect(new Set(mapped)).toEqual(new Set(CRON_JOBS));
  });

  it('only produces ids the schedule table knows', () => {
    for (const job of Object.values(ADMIN_CRON_JOB)) {
      expect(CRON_SCHEDULES[job]).toBeDefined();
    }
  });
});

describe('CRON_JOBS ↔ the PostHog liveness registry', () => {
  /**
   * Crons deliberately held out of `liveness.crons` until production has emitted their
   * first heartbeat. The CI sweep reads production, so a cron that has never run there
   * reports MISSING on every sweep and fails the scheduled job red.
   *
   * - `protest-reply-reminder` (AECI-1205): re-add it to `liveness.crons` once
   *   `aeci.contest.protest_reminder.job` appears in production. A follow-up issue
   *   tracks the move. Delete it from this list in the same commit.
   */
  const LIVENESS_PENDING: readonly string[] = ['protest-reply-reminder'];

  const config = JSON.parse(
    readFileSync(
      join(process.cwd(), '..', '..', 'observability', 'posthog', 'project-config.json'),
      'utf8',
    ),
  ) as {
    liveness: { crons: Array<{ job: string }>; pendingFirstHeartbeat?: Array<{ job: string }> };
  };
  const watched = config.liveness.crons.map((c) => c.job);
  const pending = (config.liveness.pendingFirstHeartbeat ?? []).map((c) => c.job);

  it('watches every cron, except the ones pending a first production heartbeat', () => {
    const expected = CRON_JOBS.filter((job) => !LIVENESS_PENDING.includes(job));
    expect(new Set(watched)).toEqual(new Set(expected));
    expect(watched).toHaveLength(expected.length);
  });

  it('keeps a pending cron out of the sweep and parks its entry in pendingFirstHeartbeat', () => {
    for (const job of LIVENESS_PENDING) {
      expect(watched).not.toContain(job);
      expect(pending).toContain(job);
    }
    expect(new Set(pending)).toEqual(new Set(LIVENESS_PENDING));
  });
});
