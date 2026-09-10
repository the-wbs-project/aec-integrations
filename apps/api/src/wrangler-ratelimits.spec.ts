/**
 * AECI-773 — every rate-limit bucket must be bound in EVERY wrangler block.
 *
 * `ratelimits` is **not inherited** from the top-level config into a named
 * environment. Wrangler's own config schema says so verbatim: *"This field is
 * not automatically inherited from the top level environment, and so must be
 * specified in every named environment."* So a bucket declared once at the top
 * is bound on exactly ZERO deployed Workers. Nothing throws, no other test
 * fails, and the only symptom is a limit that never limits.
 *
 * That is AECI-659's shape reproduced in a config file — live production ran
 * with no rate limiting and no scraper block for months because a hostname was
 * missing from three expressions, and `aeci.waf.ratelimit.blocked` read ~0,
 * which looks exactly like "no attacks" when it means "no rules".
 *
 * Nothing else would catch it. The PR suite runs no `wrangler deploy --dry-run`,
 * so a malformed or missing `env.production` block surfaces at the prod promote,
 * after merge. This file is the gate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RATE_LIMIT_BUCKETS, type RateLimitBucket } from './rate-limit-middleware';

const WRANGLER_PATH = join(__dirname, '..', 'wrangler.jsonc');
const RAW = readFileSync(WRANGLER_PATH, 'utf8');

/** Every named environment that is actually deployed. */
const ENV_NAMES = ['preview', 'staging', 'demo', 'production'] as const;

type RateLimitEntry = {
  name: string;
  namespace_id: string;
  simple: { limit: number; period: number };
};

/**
 * Strip whole-line `//` comments and trailing commas. Safe only because every
 * comment in this file is on its own line — asserted below, so if that ever
 * stops being true this parser says so loudly instead of passing on a mis-parse.
 */
function parseWrangler(): {
  ratelimits?: RateLimitEntry[];
  env: Record<string, { ratelimits?: RateLimitEntry[] }>;
} {
  const stripped = RAW.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as ReturnType<typeof parseWrangler>;
}

const config = parseWrangler();

/** base + the four named envs, in the order they appear. */
function allBlocks(): { label: string; entries: RateLimitEntry[] }[] {
  return [
    { label: 'base', entries: config.ratelimits ?? [] },
    ...ENV_NAMES.map((name) => ({
      label: name,
      entries: config.env[name]?.ratelimits ?? [],
    })),
  ];
}

describe('wrangler.jsonc ratelimits', () => {
  it('has no inline comments, so the parser above is sound', () => {
    const offenders = RAW.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => {
        const idx = line.indexOf('//');
        if (idx <= 0) return false;
        if (line.slice(Math.max(0, idx - 1), idx + 2) === '://') return false;
        return line.slice(0, idx).trim().length > 0;
      });
    expect(offenders.map((o) => o.n)).toEqual([]);
  });

  it('declares every bucket in ALL FIVE blocks — this is the whole point of the file', () => {
    for (const bucket of Object.keys(RATE_LIMIT_BUCKETS) as RateLimitBucket[]) {
      const binding = RATE_LIMIT_BUCKETS[bucket].binding;
      for (const { label, entries } of allBlocks()) {
        expect(
          entries.map((e) => e.name),
          `${binding} missing from the "${label}" block — it would be bound nowhere`,
        ).toContain(binding);
      }
    }
  });

  it('keeps every threshold in lockstep with RATE_LIMIT_BUCKETS', () => {
    // Catches a tier tuned in isolation while TypeScript still claims 30/60.
    for (const bucket of Object.keys(RATE_LIMIT_BUCKETS) as RateLimitBucket[]) {
      const spec = RATE_LIMIT_BUCKETS[bucket];
      for (const { label, entries } of allBlocks()) {
        const entry = entries.find((e) => e.name === spec.binding);
        expect(entry?.simple, `${spec.binding} in "${label}"`).toEqual({
          limit: spec.limit,
          period: spec.period,
        });
      }
    }
  });

  it('uses only the periods the platform accepts', () => {
    // `simple.period` is a strict enum of 10 or 60. It is the one field where a
    // plausible-looking value (600) means something entirely different rather
    // than failing outright.
    for (const { label, entries } of allBlocks()) {
      for (const entry of entries) {
        expect([10, 60], `${entry.name} in "${label}"`).toContain(entry.simple.period);
      }
    }
  });

  it('isolates counters: a distinct namespace_id per (bucket, environment)', () => {
    // Counters are shared ACCOUNT-WIDE by namespace_id, across Workers — the
    // sibling aec-integrations-review app already ships this binding on the same
    // account. A duplicated id silently merges two counters.
    const seen = new Map<string, string>();
    for (const { label, entries } of allBlocks()) {
      if (label === 'base') continue; // base deliberately mirrors preview
      for (const entry of entries) {
        const owner = seen.get(entry.namespace_id);
        expect(owner, `namespace_id ${entry.namespace_id} is used twice`).toBeUndefined();
        seen.set(entry.namespace_id, `${label}/${entry.name}`);
      }
    }
    expect(seen.size).toBe(ENV_NAMES.length * Object.keys(RATE_LIMIT_BUCKETS).length);
  });

  it('mirrors preview in the base block, like kv_namespaces and workflows do', () => {
    // So bare `wrangler dev` and `pnpm dev:bound --env preview` share one
    // local counter instead of quietly diverging.
    const base = config.ratelimits ?? [];
    const preview = config.env.preview?.ratelimits ?? [];
    expect(base).toEqual(preview);
  });

  it('declares no bucket the code does not read', () => {
    // Dead config is the same disease read backwards — cf. `prod.` left in a WAF
    // expression after the hostname was retired.
    const known = Object.values(RATE_LIMIT_BUCKETS).map((b) => b.binding as string);
    for (const { label, entries } of allBlocks()) {
      for (const entry of entries) {
        expect(known, `"${label}" declares ${entry.name}, which nothing reads`).toContain(
          entry.name,
        );
      }
    }
  });
});
