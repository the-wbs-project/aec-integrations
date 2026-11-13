/**
 * AECI-1713 — `POST /api/page-views/browser-evidence` is mounted on the REAL Worker
 * behind the `token` rate-limit bucket keyed by IP, the same registration as
 * `POST /api/page-views/turnstile` (`waf-rate-limits.md` §6.2).
 *
 * Drives `worker.fetch`. No `DB` binding is set, so the deferred UPDATE fails inside
 * `waitUntil`, where it is counted and swallowed. The response is still a 204.
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
