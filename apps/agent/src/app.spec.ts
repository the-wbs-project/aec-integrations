import { describe, expect, it } from 'vitest';

import app from './app';
import type { Env } from './env';

/**
 * The one question this file exists to answer: does the access gate actually
 * cover the FLUE AGENT MOUNTS, or only the routes this app declares itself?
 *
 * Flue's `createAgentRouter()` returns an ordinary Hono sub-app and `app.route()`
 * merges its routes into the parent router. Hono dispatches matching handlers in
 * REGISTRATION order, so a wildcard middleware registered before the `route()`
 * calls runs ahead of every merged handler. That is an ordering property, not a
 * structural one — which is exactly why it is asserted rather than assumed. Move
 * `app.use('*', requireAccess())` below the mounts in `src/app.ts` and these
 * tests go red instead of the agent going open.
 */

const ENV = { TOOL_TOKEN: 'secret' } as Env;

const AGENT_PATHS = ['/agents/catalog/conversation-1', '/agents/catalog-claude/conversation-1'];

describe('the app gate', () => {
  it.each(AGENT_PATHS)('403s %s with no credential', async (path) => {
    const res = await app.request(path, { method: 'GET' }, ENV);
    expect(res.status).toBe(403);
  });

  it.each(AGENT_PATHS)('403s a POST to %s with no credential', async (path) => {
    // Guards: a conversation is DRIVEN by POST, so the read path being shut is
    // only half the answer.
    const res = await app.request(
      path,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      ENV,
    );
    expect(res.status).toBe(403);
  });

  it.each(AGENT_PATHS)('403s %s with a WRONG token', async (path) => {
    const res = await app.request(path, { headers: { Authorization: 'Bearer wrong' } }, ENV);
    expect(res.status).toBe(403);
  });

  it('403s an unknown path too, rather than 404ing it', async () => {
    // Guards: a 404 on an unauthenticated request leaks which routes exist.
    const res = await app.request('/agents/nope', {}, ENV);
    expect(res.status).toBe(403);
  });

  it('403s /health as well — nothing on this Worker is public', async () => {
    const res = await app.request('/health', {}, ENV);
    expect(res.status).toBe(403);
  });

  it('lets /health through WITH the token, proving the gate is not blanket-denying', async () => {
    // Guards: the negative tests above would pass just as well if every route
    // 403'd unconditionally. This is the control.
    const res = await app.request('/health', { headers: { Authorization: 'Bearer secret' } }, ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('403s the chat page at / with no credential', async () => {
    // Guards: the test chat page is inlined into the Worker bundle rather than
    // served from a Cloudflare `assets` binding precisely so this holds. Assets
    // are served AHEAD of the Worker, so an `assets` binding would put an
    // ungated page on a Worker whose premise is that nothing here is public.
    const res = await app.request('/', {}, ENV);
    expect(res.status).toBe(403);
  });

  it('serves the chat page at / WITH the token', async () => {
    const res = await app.request('/', { headers: { Authorization: 'Bearer secret' } }, ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // The page is only useful if it addresses BOTH mounts; a silently
    // single-model page would make the spike's comparison impossible.
    expect(html).toContain('/agents/catalog-claude');
    expect(html).toContain('view=updates');
  });

  it('reaches the Flue router WITH the token', async () => {
    // Guards: the same control for the mounted agents. Anything other than 403
    // proves the request got PAST the gate and into Flue's router; what Flue
    // then answers for a non-existent conversation is its business, not ours.
    //
    // This test prints a Flue error to stderr ("Agent route invoked before the
    // runtime was configured"). That line IS the evidence: it can only be
    // emitted from inside the mounted router, so seeing it proves the gate
    // forwarded the request rather than short-circuiting it.
    for (const path of AGENT_PATHS) {
      const res = await app.request(path, { headers: { Authorization: 'Bearer secret' } }, ENV);
      expect(res.status).not.toBe(403);
    }
  });
});
