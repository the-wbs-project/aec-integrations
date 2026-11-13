/**
 * AECI-1620 — the legal-notice queue is bound in EVERY wrangler block, its consumer
 * matches the code's retry budget, and every deployed tier creates the queue.
 *
 * Queue bindings are not inherited from the top level into a named env, and the PR
 * suite runs no `wrangler deploy`. A block that forgets the producer leaves a tier where
 * a publish sends no notice (`outcome:unbound`), and a deploy against a queue nobody
 * created fails at promote time, after merge. This file is the gate for both, on the
 * `wrangler-ownership-sync.spec.ts` pattern.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LEGAL_NOTICE_MAX_RETRIES, LEGAL_NOTICE_QUEUE_PREFIX } from './lib/legal-notice';

const RAW = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');
const readWorkflow = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');

type QueueBlock = {
  producers?: { queue: string; binding: string }[];
  consumers?: {
    queue: string;
    max_batch_size?: number;
    max_retries?: number;
    max_concurrency?: number;
  }[];
};

/** Whole-line comments and trailing commas only, as `wrangler-ratelimits.spec.ts`. */
const config = JSON.parse(
  RAW.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1'),
) as { queues?: QueueBlock; env: Record<string, { queues?: QueueBlock }> };

const BLOCKS: { label: string; queue: string; block: QueueBlock | undefined }[] = [
  { label: 'base (local dev)', queue: 'aeci-legal-notice-local', block: config.queues },
  ...(['staging', 'demo', 'production'] as const).map((env) => ({
    label: env,
    queue: `aeci-legal-notice-${env}`,
    block: config.env[env]?.queues,
  })),
];

describe('AECI-1620: LEGAL_NOTICE_QUEUE in every wrangler block', () => {
  it.each(BLOCKS)('$label binds the producer', ({ queue, block }) => {
    expect(block?.producers).toContainEqual({ queue, binding: 'LEGAL_NOTICE_QUEUE' });
    expect(queue.startsWith(LEGAL_NOTICE_QUEUE_PREFIX)).toBe(true);
  });

  it.each(BLOCKS)('$label consumes it with the code retry budget', ({ queue, block }) => {
    expect(block?.consumers?.find((c) => c.queue === queue)).toEqual({
      queue,
      max_batch_size: 1,
      max_retries: LEGAL_NOTICE_MAX_RETRIES,
      max_concurrency: 1,
    });
  });
});

describe('AECI-1620: CI creates the queue', () => {
  it.each([
    ['deploy.yml', 'staging'],
    ['promote-to-demo.yml', 'demo'],
    ['promote-to-prod.yml', 'production'],
  ])('%s', (file, env) => {
    expect(readWorkflow(file)).toContain(`create_queue aeci-legal-notice-${env}`);
  });
});
