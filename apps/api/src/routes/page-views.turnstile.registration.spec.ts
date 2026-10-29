/**
 * AECI-1457 — `POST /api/page-views/turnstile` is mounted on the REAL Worker behind
 * the `token` rate-limit bucket keyed by IP, the same registration as
 * `/api/unsubscribe` (`waf-rate-limits.md` §6). Each accepted post spends one
 * siteverify subrequest, so the limiter is what bounds a scripted loop.
 *
 * Drives `worker.fetch`. No `TURNSTILE_SECRET_KEY` is set, so an allowed post
 * schedules a deferred no-op and touches no database.
 */

import { describe, expect, it } from 'vitest';

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

function post(env: Partial<Env>) {
  return worker.fetch(
    new Request('https://api/api/page-views/turnstile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ cf_ray: '8c1a2b3c4d5e6f70-IAD', token: '0.tok' }),
    }),
    { ENV: 'staging', ...env } as Env,
    fakeExecutionContext(),
  );
}

describe('POST /api/page-views/turnstile registration', () => {
  it('asks the token bucket, keyed by the client IP, and 204s when allowed', async () => {
    const token = limiter(true);
    const write = limiter(true);
    const res = await post({ TOKEN_RATE_LIMIT: token, WRITE_RATE_LIMIT: write });

    expect(res.status).toBe(204);
    expect(token.keys).toEqual(['staging:ip:203.0.113.9']);
    expect(write.keys).toEqual([]);
  });

  it('429s when the token bucket refuses', async () => {
    const token = limiter(false);
    const res = await post({ TOKEN_RATE_LIMIT: token });

    expect(res.status).toBe(429);
    expect(token.keys).toHaveLength(1);
  });
});
