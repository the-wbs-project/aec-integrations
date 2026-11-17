/**
 * AECI-1713 — `POST /api/page-views/browser-evidence` is mounted on the REAL Worker
 * behind the `token` rate-limit bucket keyed by IP, on the `page-views` sub-budget it
 * shares with `POST /api/page-views/turnstile` (`waf-rate-limits.md` §6.2). The last
 * block floods one side and shows the other side's counter is untouched, against a
 * limiter that counts per key the way the binding does.
 *
 * Drives `worker.fetch`. No `DB` binding is set, so the deferred UPDATE fails inside
 * `waitUntil`, where it is counted and swallowed. The response is still a 204.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import worker from '../index';
import { fakeExecutionContext } from '../test/helpers';

function limiter(success: boolean): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success };
    },
  };
}

function post(
  env: Partial<Env>,
  body: unknown = { cf_ray: '8c1a2b3c4d5e6f70-IAD', evidence: 'ran' },
) {
  return worker.fetch(
    new Request('https://api/api/page-views/browser-evidence', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify(body),
    }),
    { ENV: 'staging', ...env } as Env,
    fakeExecutionContext(),
  );
}

describe('POST /api/page-views/browser-evidence registration', () => {
  it('asks the token bucket, keyed by the client IP on the page-views sub-budget, and 204s', async () => {
    const token = limiter(true);
    const write = limiter(true);
    const res = await post({ TOKEN_RATE_LIMIT: token, WRITE_RATE_LIMIT: write });

    expect(res.status).toBe(204);
    expect(token.keys).toEqual(['staging:ip:203.0.113.9:page-views']);
    expect(write.keys).toEqual([]);
  });

  it('429s when the token bucket refuses', async () => {
    const token = limiter(false);
    const res = await post({ TOKEN_RATE_LIMIT: token });

    expect(res.status).toBe(429);
    expect(token.keys).toHaveLength(1);
  });

  it('400s an invalid evidence word through the central error middleware', async () => {
    const res = await post(
      { TOKEN_RATE_LIMIT: limiter(true) },
      { cf_ray: '8c1a2b3c4d5e6f70', evidence: 'human' },
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('VALIDATION_FAILED');
  });
});

/** A `RateLimit` that counts per key, `limit` per key, like the binding in one window. */
function countingLimiter(limit: number): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  const counts = new Map<string, number>();
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      const used = counts.get(key) ?? 0;
      if (used >= limit) return { success: false };
      counts.set(key, used + 1);
      return { success: true };
    },
  };
}

function postTo(path: string, env: Partial<Env>, body: unknown) {
  return worker.fetch(
    new Request(`https://api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify(body),
    }),
    { ENV: 'staging', ...env } as Env,
    fakeExecutionContext(),
  );
}

const RAY_OK = '8c1a2b3c4d5e6f70-IAD';
const EVIDENCE = ['/api/page-views/browser-evidence', { cf_ray: RAY_OK, evidence: 'ran' }] as const;
const VERDICT = ['/api/page-views/turnstile', { cf_ray: RAY_OK, token: '0.tok' }] as const;
// `/api/unsubscribe` stands in for the whole shared `token` counter. Every route on
// it is `by: 'ip'` with no tag, so seat-invite accept, request confirm and the mutes
// spend this exact key. Seat-invite accept itself sits behind `requireAuth()`.
const UNSUBSCRIBE = ['/api/unsubscribe', { token: 'not-a-real-token' }] as const;

describe('the page-view reports and the shared token counter do not spend each other', () => {
  // No `DB` binding, so the unsubscribe handler 500s past the limiter. Only the
  // limiter's answer matters here, so its error log and the trip warn are muted.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('a flood of reports leaves the shared token counter untouched', async () => {
    const token = countingLimiter(10);
    const env = { TOKEN_RATE_LIMIT: token };

    for (let i = 0; i < 5; i++) {
      expect((await postTo(EVIDENCE[0], env, EVIDENCE[1])).status).toBe(204);
      expect((await postTo(VERDICT[0], env, VERDICT[1])).status).toBe(204);
    }
    expect((await postTo(EVIDENCE[0], env, EVIDENCE[1])).status).toBe(429);

    const res = await postTo(UNSUBSCRIBE[0], env, UNSUBSCRIBE[1]);
    expect(res.status).not.toBe(429);
    expect(token.keys.at(-1)).toBe('staging:ip:203.0.113.9');
  });

  it('a flood on the shared token counter leaves the reports their own budget', async () => {
    const token = countingLimiter(10);
    const env = { TOKEN_RATE_LIMIT: token };

    for (let i = 0; i < 10; i++) {
      expect((await postTo(UNSUBSCRIBE[0], env, UNSUBSCRIBE[1])).status).not.toBe(429);
    }
    expect((await postTo(UNSUBSCRIBE[0], env, UNSUBSCRIBE[1])).status).toBe(429);

    expect((await postTo(EVIDENCE[0], env, EVIDENCE[1])).status).toBe(204);
    expect((await postTo(VERDICT[0], env, VERDICT[1])).status).toBe(204);
    expect(token.keys.slice(-2)).toEqual([
      'staging:ip:203.0.113.9:page-views',
      'staging:ip:203.0.113.9:page-views',
    ]);
  });
});
