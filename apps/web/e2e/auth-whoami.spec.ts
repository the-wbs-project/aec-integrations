/**
 * AECI-193 — /auth/whoami auth-spike smoke (THROWAWAY; removed in Phase 5.5).
 *
 * Runs against the bound dev stack (`pnpm dev:bound`). The route proves the
 * cookie → `@supabase/ssr` session → bearer → JWKS chain end to end. e2e
 * covers the unauthenticated path only:
 *
 *   - env unprovisioned (no SUPABASE_ANON_KEY on the Worker) → 503
 *     `auth_not_configured` → the suite test.skip()s itself, so a not-yet-
 *     provisioned environment stays green;
 *   - provisioned, no session cookie → 401 `unauthenticated`, with
 *     `Cache-Control: private, no-store` so a credentialed response is never
 *     cached.
 *
 * The 200 path needs a real session and stays manual: mint one with
 * `apps/web/scripts/mint-dev-session.mjs` and replay the printed `Cookie:`
 * header (see docs/environments.md → "Local dev: Supabase auth (Phase 5)").
 */
import { expect, test } from '@playwright/test';

test.describe('GET /auth/whoami', () => {
  test('401 without a session, non-cacheable (or skip when unconfigured)', async ({ request }) => {
    const res = await request.get('/auth/whoami', { maxRedirects: 0 });

    if (res.status() === 503) {
      const body = await res.json();
      expect(body.error).toBe('auth_not_configured');
      test.skip(true, 'Supabase auth env not provisioned on this Worker (503).');
      return;
    }

    expect(res.status()).toBe(401);
    expect(res.headers()['cache-control']).toBe('private, no-store');
    const body = await res.json();
    expect(body.error).toBe('unauthenticated');
  });
});
