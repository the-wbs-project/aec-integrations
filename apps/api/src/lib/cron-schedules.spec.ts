/**
 * The two vocabularies in `cron-schedules.ts` must stay in bijection.
 *
 * `Record<ScheduledJob, AdminCronJob>` already makes a MISSING key a compile
 * error. What it cannot catch is a duplicated or mistyped *value* — two
 * dispatcher jobs mapped onto the same `AdminCronJob`, or one mapped onto an id
 * the read side never looks for. Either would silently drop a cron out of the
 * §5.6 liveness table (AECI-583), which is exactly the failure the table exists
 * to make visible.
 */

import { describe, expect, it } from 'vitest';

import { ADMIN_CRON_JOB, CRON_JOBS, CRON_SCHEDULES } from './cron-schedules';

describe('ADMIN_CRON_JOB', () => {
  it('maps the eight dispatcher jobs onto the eight AdminCronJob ids, one to one', () => {
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
