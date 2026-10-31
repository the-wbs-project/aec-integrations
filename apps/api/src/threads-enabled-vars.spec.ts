/**
 * AECI-1553: the private row threads release switch (`STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.16).
 *
 * `THREADS_ENABLED` is a plain wrangler var. Vars are not inherited into a named env,
 * so a block that drops it reads as "threads off" with no error. This pins the value in
 * all four blocks, and the rule that only `"true"` is on.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { threadsEnabled } from './lib/claim-threads';

const RAW = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

/** Whole-line comments and trailing commas only, as `stripe-secrets-ci.spec.ts`. */
const config = JSON.parse(
  RAW.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1'),
) as {
  vars?: Record<string, string>;
  env: Record<string, { vars?: Record<string, string> }>;
};

const VAR_BLOCKS = [
  { label: 'base (local dev)', vars: config.vars, value: 'true' },
  { label: 'staging', vars: config.env.staging?.vars, value: 'true' },
  { label: 'demo', vars: config.env.demo?.vars, value: 'true' },
  { label: 'production', vars: config.env.production?.vars, value: 'false' },
];

describe('THREADS_ENABLED in every wrangler block (AECI-1553)', () => {
  it.each(VAR_BLOCKS)('$label sets THREADS_ENABLED to "$value"', ({ vars, value }) => {
    expect(vars?.THREADS_ENABLED).toBe(value);
  });
});

describe('threadsEnabled', () => {
  it('is on only for exactly "true"', () => {
    expect(threadsEnabled({ THREADS_ENABLED: 'true' })).toBe(true);
    expect(threadsEnabled({ THREADS_ENABLED: 'false' })).toBe(false);
    expect(threadsEnabled({ THREADS_ENABLED: 'TRUE' })).toBe(false);
    expect(threadsEnabled({ THREADS_ENABLED: ' true' })).toBe(false);
    expect(threadsEnabled({ THREADS_ENABLED: '' })).toBe(false);
    expect(threadsEnabled({})).toBe(false);
  });
});
