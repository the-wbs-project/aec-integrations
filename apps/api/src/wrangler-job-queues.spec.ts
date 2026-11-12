/**
 * AECI-1587 — a thrown job emails only on its last queue attempt, and a Worker cannot
 * read `max_retries`. If a consumer's value and the constant drift, the alert fires
 * while a retry is still coming, or never fires at all. This file is the gate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SCHEDULED_JOB_MAX_RETRIES } from './lib/cron-failure-alert';

const RAW = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

const CONSUMERS = [...RAW.matchAll(/"queue":\s*"(aeci-[^"]+)"[^}]*?"max_retries":\s*(\d+)/g)]
  .map((m) => ({ queue: m[1]!, maxRetries: Number(m[2]) }))
  // The ownership-sync and legal-notice queues are not scheduled-job queues and have
  // their own retry budgets (their own wrangler specs pin them).
  .filter(
    (c) => !c.queue.startsWith('aeci-ownership-sync-') && !c.queue.startsWith('aeci-legal-notice-'),
  );

describe('scheduled-job queue consumers', () => {
  it('finds the consumers it means to check', () => {
    expect(CONSUMERS.length).toBeGreaterThan(0);
    expect(CONSUMERS.map((c) => c.queue)).toContain('aeci-stripe-reconcile-production');
  });

  it('all retry exactly SCHEDULED_JOB_MAX_RETRIES times', () => {
    for (const { queue, maxRetries } of CONSUMERS) {
      expect(maxRetries, queue).toBe(SCHEDULED_JOB_MAX_RETRIES);
    }
  });
});
