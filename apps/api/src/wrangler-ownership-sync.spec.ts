/**
 * AECI-1418 — the ownership-sync queue is bound in EVERY wrangler block, its consumer
 * matches the code's retry budget, and every deployed tier creates the queue and pushes
 * the receiver secrets. AECI-1427 — production requires the pair; staging and demo
 * stay warn-only.
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

import {
  mirrorSchemaVersion,
  OWNERSHIP_SYNC_MAX_RETRIES,
  OWNERSHIP_SYNC_QUEUE_PREFIX,
} from './lib/ownership-sync';

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
) as {
  queues?: QueueBlock;
  vars?: Record<string, string>;
  env: Record<string, { queues?: QueueBlock; vars?: Record<string, string> }>;
};

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

describe('AECI-1413: REVIEW_APP_MIRROR_SCHEMA in every wrangler block', () => {
  // Vars are not inherited into a named env either. Production sends v2 since AECI-1455,
  // when the review receiver v2 went live there. The other tiers stay "1": a receiver that
  // does not parse v2 answers 400, and a 400 is permanent.
  const VARS = [
    { label: 'base (local dev)', vars: config.vars, schema: '1' },
    ...(['staging', 'demo'] as const).map((env) => ({
      label: env,
      vars: config.env[env]?.vars,
      schema: '1',
    })),
    { label: 'production', vars: config.env.production?.vars, schema: '2' },
  ];

  it.each(VARS)('$label sends schema v$schema', ({ vars, schema }) => {
    expect(vars?.REVIEW_APP_MIRROR_SCHEMA).toBe(schema);
    expect(mirrorSchemaVersion(vars ?? {})).toBe(Number(schema));
  });
});

/** Pull the space-separated names of a `KEY: '…'` line out of a workflow. */
function secretList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
  if (!match) throw new Error(`${key} not found in workflow`);
  return match[1].split(/\s+/).filter(Boolean);
}

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
    expect(raw).toContain(
      `REVIEW_APP_OWNERSHIP_TOKEN_${suffix}: \${{ secrets.REVIEW_APP_OWNERSHIP_TOKEN_${suffix} }}`,
    );
  });
});

describe('AECI-1427: the receiver pair is REQUIRED on production only (ruling D4)', () => {
  const PAIR = (suffix: string) => [
    `REVIEW_APP_OWNERSHIP_URL_${suffix}`,
    `REVIEW_APP_OWNERSHIP_TOKEN_${suffix}`,
  ];

  it('production preflight requires both and no longer recommends them', () => {
    const raw = readWorkflow('promote-to-prod.yml');
    expect(secretList(raw, 'REQUIRED_SECRETS')).toEqual(expect.arrayContaining(PAIR('PRODUCTION')));
    for (const name of PAIR('PRODUCTION')) {
      expect(secretList(raw, 'RECOMMENDED_SECRETS')).not.toContain(name);
    }
  });

  it('production re-asserts both on the live Worker after deploy', () => {
    // The only check that reads the deployed Worker, so the only one that catches a
    // push that silently no-op'd or a secret deleted out of band.
    expect(secretList(readWorkflow('promote-to-prod.yml'), 'REQUIRED_WORKER_SECRETS')).toEqual(
      expect.arrayContaining(['REVIEW_APP_OWNERSHIP_URL', 'REVIEW_APP_OWNERSHIP_TOKEN']),
    );
  });

  it('the production push step fails rather than skips', () => {
    const raw = readWorkflow('promote-to-prod.yml');
    const start = raw.indexOf(
      '- name: Push REVIEW_APP_OWNERSHIP_URL + TOKEN to API Worker (production)',
    );
    expect(start).toBeGreaterThan(-1);
    const step = raw.slice(start);
    const body = step.slice(0, step.indexOf('- name:', 1));
    expect(body).toContain('::error::');
    expect(body).toContain('exit 1');
    expect(body).not.toContain('::warning::');
  });

  it.each([
    ['deploy.yml', 'STAGING'],
    ['promote-to-demo.yml', 'DEMO'],
  ])('%s stays warn-only', (file, suffix) => {
    // Staging has no receiver. Demo stays unconfigured by ruling D5.
    const raw = readWorkflow(file);
    expect(secretList(raw, 'RECOMMENDED_SECRETS')).toEqual(expect.arrayContaining(PAIR(suffix)));
    for (const name of PAIR(suffix)) {
      expect(secretList(raw, 'REQUIRED_SECRETS')).not.toContain(name);
    }
  });
});
