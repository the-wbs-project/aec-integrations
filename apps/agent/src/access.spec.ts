import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { requireAccess, type AccessVariables } from './access';
import type { Env } from './env';

/**
 * `src/access.ts` is a BYTE-FOR-BYTE copy of `apps/datatool/src/access.ts`.
 * Divergence between the two copies is the risk this spike carries, so the first
 * test here is a file comparison, not a behaviour assertion.
 */

function appWith(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();
  app.use('*', requireAccess());
  app.get('/guarded', (c) => c.json({ operator: c.get('operator') }));
  return (headers: Record<string, string> = {}) => app.request('/guarded', { headers }, env as Env);
}

describe('requireAccess', () => {
  it('is identical to the datatool copy', async () => {
    const { readFileSync } = await import('node:fs');
    const mine = readFileSync(new URL('./access.ts', import.meta.url), 'utf8');
    const theirs = readFileSync(new URL('../../datatool/src/access.ts', import.meta.url), 'utf8');
    expect(mine).toBe(theirs);
  });

  it('FAILS CLOSED with no credential at all', async () => {
    // Guards: the whole gate. A Flue agent router has no built-in auth, so an
    // open default here means anyone who can reach a conversation URL can drive it.
    const res = await appWith({ TOOL_TOKEN: 'secret' })();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'FORBIDDEN',
        message: 'Cloudflare Access (or a valid tool token) required',
      },
    });
  });

  it('fails closed when NOTHING is configured either', async () => {
    // Guards: an unconfigured Worker must be shut, not open. `TOOL_TOKEN` is
    // optional, and absent means the bearer path cannot authenticate anyone.
    const res = await appWith({})({ Authorization: 'Bearer anything' });
    expect(res.status).toBe(403);
  });

  it('rejects a wrong bearer token', async () => {
    const res = await appWith({ TOOL_TOKEN: 'secret' })({ Authorization: 'Bearer wrong' });
    expect(res.status).toBe(403);
  });

  it('rejects a non-Bearer scheme carrying the right value', async () => {
    const res = await appWith({ TOOL_TOKEN: 'secret' })({ Authorization: 'Basic secret' });
    expect(res.status).toBe(403);
  });

  it('accepts the shared-secret bearer and records the operator', async () => {
    const res = await appWith({ TOOL_TOKEN: 'secret' })({ Authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ operator: 'tool-token' });
  });

  it('fails closed on an unverifiable Access assertion', async () => {
    // Guards: a forged or expired JWT must fall through to 403, never through.
    const res = await appWith({
      ACCESS_AUD: 'aud-value',
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
    })({ 'Cf-Access-Jwt-Assertion': 'not.a.jwt' });
    expect(res.status).toBe(403);
  });

  it('ignores an Access assertion when the team domain is a placeholder', async () => {
    const res = await appWith({
      ACCESS_AUD: 'aud-value',
      ACCESS_TEAM_DOMAIN: 'REPLACE_WITH_TEAM',
    })({ 'Cf-Access-Jwt-Assertion': 'anything' });
    expect(res.status).toBe(403);
  });
});
