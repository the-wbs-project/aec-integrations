/**
 * `isOperatorRequest()` — the ingest-time operator verdict (`ADMIN_PANEL_SPEC.md`
 * §13 **D13**). Uses the shared offline JWKS (`test/auth.ts`) so tokens verify
 * with no network, and the in-memory D1 harness for the `profiles.role` read.
 *
 * The properties under test are the three the module header commits to: the
 * verdict is server-derived (a claimed role is ignored), anonymous traffic costs
 * nothing (no D1 read at all), and every failure resolves to `false` rather than
 * throwing into the caller's `waitUntil`.
 */

import { Hono } from 'hono';
import type { JWTVerifyGetKey } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { profiles } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeTestJwks } from '../test/auth';
import { isOperatorRequest } from './operator-session';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ADMIN_ID = '00000000-0000-4000-8000-00000000ad11';
const USER_ID = '00000000-0000-4000-8000-000000000001';

let getKey: JWTVerifyGetKey;
let mintToken: (opts: { sub: string; supabaseUrl: string; expiresIn?: string }) => Promise<string>;

beforeAll(async () => {
  const jwks = await makeTestJwks();
  getKey = jwks.getKey;
  mintToken = jwks.mintToken;
});

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values([
    { id: ADMIN_ID, role: 'admin' },
    { id: USER_ID, role: 'reviewer' },
  ]);
});
afterEach(() => t.dispose());

/** Run `isOperatorRequest` inside a real Hono context so cookie parsing and
 *  header access match production exactly. */
async function ask(
  headers: Record<string, string>,
  env: Partial<Env> = { SUPABASE_URL },
): Promise<boolean> {
  let verdict: boolean | undefined;
  const app = new Hono<{ Bindings: Env }>();
  app.get('/', async (c) => {
    verdict = await isOperatorRequest(c, t.db, { getKey });
    return c.body(null, 204);
  });
  await app.request('/', { headers }, env as Env);
  return verdict as boolean;
}

describe('isOperatorRequest', () => {
  it('is true for a verified admin session sent as a bearer token', async () => {
    const token = await mintToken({ sub: ADMIN_ID, supabaseUrl: SUPABASE_URL });
    expect(await ask({ Authorization: `Bearer ${token}` })).toBe(true);
  });

  it('is true for a verified admin session sent as the browser session cookie', async () => {
    // The shape `@supabase/ssr` writes and the `/api/*` passthrough forwards —
    // the browser tracker's POST arrives this way, never as a bearer.
    const token = await mintToken({ sub: ADMIN_ID, supabaseUrl: SUPABASE_URL });
    const value = `base64-${btoa(JSON.stringify({ access_token: token }))}`;
    expect(await ask({ cookie: `sb-test-auth-token=${value}` })).toBe(true);
  });

  it('is false for a verified NON-admin session', async () => {
    // A signed-in visitor is real traffic. Only the operator is excluded.
    const token = await mintToken({ sub: USER_ID, supabaseUrl: SUPABASE_URL });
    expect(await ask({ Authorization: `Bearer ${token}` })).toBe(false);
  });

  it('is false for an anonymous request, without touching D1', async () => {
    let reads = 0;
    const counting = new Proxy(t.db, {
      get(target, prop, receiver) {
        reads += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }) as typeof t.db;

    let verdict: boolean | undefined;
    const app = new Hono<{ Bindings: Env }>();
    app.get('/', async (c) => {
      verdict = await isOperatorRequest(c, counting, { getKey });
      return c.body(null, 204);
    });
    await app.request('/', {}, { SUPABASE_URL } as Env);

    expect(verdict).toBe(false);
    // The fast path must return before it reaches for the client at all —
    // `page_views` is the hottest write path in the app.
    expect(reads).toBe(0);
  });

  it('is false when the role is only CLAIMED, never verified', async () => {
    // `profiles.role` is re-read from D1 (as `lib/authz.ts` does), so a token
    // asserting admin for a non-admin subject decides nothing.
    const token = await mintToken({ sub: USER_ID, supabaseUrl: SUPABASE_URL });
    expect(await ask({ Authorization: `Bearer ${token}`, 'x-aeci-role': 'admin' })).toBe(false);
  });

  it('is false for an expired token, a garbage token, and an unknown subject', async () => {
    const expired = await mintToken({
      sub: ADMIN_ID,
      supabaseUrl: SUPABASE_URL,
      expiresIn: '-1h',
    });
    expect(await ask({ Authorization: `Bearer ${expired}` })).toBe(false);
    expect(await ask({ Authorization: 'Bearer not-a-jwt' })).toBe(false);

    const orphan = await mintToken({
      sub: '00000000-0000-4000-8000-0000000000ff',
      supabaseUrl: SUPABASE_URL,
    });
    expect(await ask({ Authorization: `Bearer ${orphan}` })).toBe(false);
  });

  it('is false when SUPABASE_URL is unset', async () => {
    const token = await mintToken({ sub: ADMIN_ID, supabaseUrl: SUPABASE_URL });
    expect(await ask({ Authorization: `Bearer ${token}` }, {})).toBe(false);
  });

  it('resolves false rather than throwing when the profile read fails', async () => {
    // Runs inside the caller's fire-and-forget `waitUntil`: a D1 hiccup must cost
    // the flag, never the page-view row.
    const token = await mintToken({ sub: ADMIN_ID, supabaseUrl: SUPABASE_URL });
    t.dispose();
    await expect(ask({ Authorization: `Bearer ${token}` })).resolves.toBe(false);
    t = await makeTestDb(); // so afterEach's dispose stays valid
  });
});
