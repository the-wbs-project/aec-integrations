/**
 * AECI-1418 — the ownership-sync queue is bound in EVERY wrangler block, its consumer
 * matches the code's retry budget, and every deployed tier creates the queue and pushes
 * the receiver secrets.
 *
 * Queue bindings are not inherited from the top level into a named env, and the PR
 * suite runs no `wrangler deploy`. A block that forgets the producer leaves a tier
 * where every ownership change is silently unsent (`outcome:unbound`), and a deploy
 * against a queue nobody created fails at promote time, after merge. This file is
 * the gate for both.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { OWNERSHIP_SYNC_MAX_RETRIES, OWNERSHIP_SYNC_QUEUE_PREFIX } from './lib/ownership-sync';

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
  { label: 'base (local dev)', queue: 'aeci-ownership-sync-local', block: config.queues },
  ...(['staging', 'demo', 'production'] as const).map((env) => ({
    label: env,
    queue: `aeci-ownership-sync-${env}`,
    block: config.env[env]?.queues,
  })),
];

describe('AECI-1418: OWNERSHIP_SYNC_QUEUE in every wrangler block', () => {
  it.each(BLOCKS)('$label binds the producer', ({ queue, block }) => {
    expect(block?.producers).toContainEqual({ queue, binding: 'OWNERSHIP_SYNC_QUEUE' });
    expect(queue.startsWith(OWNERSHIP_SYNC_QUEUE_PREFIX)).toBe(true);
  });

  it.each(BLOCKS)('$label consumes it with the code retry budget', ({ queue, block }) => {
    expect(block?.consumers?.find((c) => c.queue === queue)).toEqual({
      queue,
      max_batch_size: 1,
      max_retries: OWNERSHIP_SYNC_MAX_RETRIES,
      max_concurrency: 1,
    });
  });
});

describe('AECI-1418: CI creates the queue and pushes the receiver secrets', () => {
  it.each([
    ['deploy.yml', 'staging', 'STAGING'],
    ['promote-to-demo.yml', 'demo', 'DEMO'],
    ['promote-to-prod.yml', 'production', 'PRODUCTION'],
  ])('%s', (file, env, suffix) => {
    const raw = readWorkflow(file);
    expect(raw).toContain(`create_queue aeci-ownership-sync-${env}`);
    expect(raw).toContain(`wrangler secret put REVIEW_APP_OWNERSHIP_URL --env ${env}`);
    expect(raw).toContain(`wrangler secret put REVIEW_APP_OWNERSHIP_TOKEN --env ${env}`);
    // require-secrets.sh checks the VALUE, so a listed name must also be mapped.
    expect(raw).toContain(
      `REVIEW_APP_OWNERSHIP_URL_${suffix}: \${{ secrets.REVIEW_APP_OWNERSHIP_URL_${suffix} }}`,
    );
    const recommended = raw.match(/^\s*RECOMMENDED_SECRETS:\s*'([^']*)'/m)?.[1] ?? '';
    expect(recommended.split(/\s+/)).toEqual(
      expect.arrayContaining([
        `REVIEW_APP_OWNERSHIP_URL_${suffix}`,
        `REVIEW_APP_OWNERSHIP_TOKEN_${suffix}`,
      ]),
    );
  });
});
