/**
 * AECI-235 — mint a REAL Supabase session for authed e2e (`authed-console.spec.ts`).
 *
 * Reuses the capture-only cookie-jar recipe from `apps/web/scripts/mint-dev-session.mjs`:
 * `@supabase/ssr`'s `createServerClient` does the session encoding + chunking, so the
 * cookies handed to Playwright are byte-for-byte what a browser would send back. That
 * matters because a *forged* cookie only passes the SSR presence gate — it never
 * reaches the client's `@supabase/ssr` `getSession()`, so the page can't hydrate to a
 * real signed-in state, and the SSR-side admin authz (`adminSummaryResolver` ->
 * `GET /api/admin/summary`, verified vs Supabase JWKS) rejects it. A real minted
 * session clears both.
 *
 * Returns `null` (→ the spec skips, never red) when any required env var is absent or
 * sign-in fails — matching the skip-when-unconfigured posture of `auth-whoami.spec.ts`.
 * The test user must be `test@thewbsproject.com` (an admin account in the shared
 * Supabase project), with a matching `role='admin'` D1 profile from
 * `apps/api/seed/auth-fixtures.sql` so the admin pages authorize.
 *
 * Env (read from `process.env`; for local runs `playwright.config.ts` hydrates these
 * from `apps/web/.dev.vars`):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_TEST_USER_EMAIL, SUPABASE_TEST_USER_PASSWORD
 */
import { createServerClient } from '@supabase/ssr';
import type { BrowserContext } from '@playwright/test';

/** The element type Playwright's `context.addCookies()` accepts. */
type PlaywrightCookie = Parameters<BrowserContext['addCookies']>[0][number];

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_TEST_USER_EMAIL',
  'SUPABASE_TEST_USER_PASSWORD',
] as const;

/** The required env vars that are unset (empty → returns all four). */
export function authEnvMissing(): string[] {
  return REQUIRED_ENV.filter((k) => !process.env[k]);
}

/**
 * Mint a session for the configured test user and return Playwright cookies scoped to
 * `baseURL`'s host (for `context.addCookies()`). `null` when unconfigured or sign-in
 * fails — the caller should `test.skip` on a null result.
 */
export async function mintSessionCookies(baseURL: string): Promise<PlaywrightCookie[] | null> {
  const missing = authEnvMissing();
  if (missing.length > 0) {
    console.warn(
      `[auth-session] Missing env: ${missing.join(', ')}. Authed-console cases will be SKIPPED. ` +
        'See docs/environments.md (SUPABASE_TEST_USER_*).',
    );
    return null;
  }

  const host = new URL(baseURL).hostname;
  const secure = new URL(baseURL).protocol === 'https:';

  // Capture-only jar — the library's storage adapter produces the real cookies
  // (`sb-<ref>-auth-token[.0/.1]`, `base64-` prefix, chunked as needed).
  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env['SUPABASE_URL'] as string,
    process.env['SUPABASE_ANON_KEY'] as string,
    {
      cookies: {
        getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const { name, value } of cookies) jar.set(name, value);
        },
      },
    },
  );

  const { data, error } = await supabase.auth.signInWithPassword({
    email: process.env['SUPABASE_TEST_USER_EMAIL'] as string,
    password: process.env['SUPABASE_TEST_USER_PASSWORD'] as string,
  });

  if (error || !data.session || jar.size === 0) {
    console.warn(
      `[auth-session] Sign-in failed (${error?.message ?? 'no session / no cookies set'}). ` +
        'Authed-console cases will be SKIPPED.',
    );
    return null;
  }

  return [...jar.entries()].map(([name, value]) => ({
    name,
    value,
    domain: host,
    path: '/',
    secure,
    sameSite: 'Lax' as const,
  }));
}
