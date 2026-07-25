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
 *
 * Two personas (each a real account in the shared Supabase project, with a matching D1
 * profile from `apps/api/seed/auth-fixtures.sql` so the gated pages authorize):
 *   - `admin`  → `test@thewbsproject.com`, `role='admin'` (drives `authed-console.spec.ts`).
 *   - `vendor` → a `role='vendor_admin'` account with a non-null `vendor_id` (drives
 *     `vendor-dashboard.spec.ts`, AECI-522).
 *
 * Env (read from `process.env`; for local runs `playwright.config.ts` hydrates these
 * from `apps/web/.dev.vars`):
 *   SUPABASE_URL, SUPABASE_ANON_KEY, and one credential pair per persona —
 *   admin: SUPABASE_TEST_USER_EMAIL / SUPABASE_TEST_USER_PASSWORD,
 *   vendor: SUPABASE_VENDOR_TEST_USER_EMAIL / SUPABASE_VENDOR_TEST_USER_PASSWORD.
 */
import { createServerClient } from '@supabase/ssr';
import type { BrowserContext } from '@playwright/test';

/** The element type Playwright's `context.addCookies()` accepts. */
type PlaywrightCookie = Parameters<BrowserContext['addCookies']>[0][number];

export type SessionPersona = 'admin' | 'vendor';

const BASE_ENV = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'] as const;

/** The email/password env-var names for each persona's credential pair. */
const CREDENTIAL_ENV: Record<
  SessionPersona,
  { readonly email: string; readonly password: string }
> = {
  admin: { email: 'SUPABASE_TEST_USER_EMAIL', password: 'SUPABASE_TEST_USER_PASSWORD' },
  vendor: {
    email: 'SUPABASE_VENDOR_TEST_USER_EMAIL',
    password: 'SUPABASE_VENDOR_TEST_USER_PASSWORD',
  },
};

/** The required env vars that are unset for `persona` (base + its credential pair). */
export function authEnvMissing(persona: SessionPersona = 'admin'): string[] {
  const creds = CREDENTIAL_ENV[persona];
  return [...BASE_ENV, creds.email, creds.password].filter((k) => !process.env[k]);
}

/**
 * Mint a session for the given `persona`'s test user and return Playwright cookies scoped
 * to `baseURL`'s host (for `context.addCookies()`). `null` when unconfigured or sign-in
 * fails — the caller should `test.skip` on a null result.
 */
export async function mintSessionCookies(
  baseURL: string,
  persona: SessionPersona = 'admin',
): Promise<PlaywrightCookie[] | null> {
  const missing = authEnvMissing(persona);
  if (missing.length > 0) {
    console.warn(
      `[auth-session] Missing env for ${persona}: ${missing.join(', ')}. ` +
        `${persona === 'vendor' ? 'Vendor-dashboard' : 'Authed-console'} cases will be SKIPPED. ` +
        'See docs/environments.md (SUPABASE_TEST_USER_* / SUPABASE_VENDOR_TEST_USER_*).',
    );
    return null;
  }
  const creds = CREDENTIAL_ENV[persona];

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
    email: process.env[creds.email] as string,
    password: process.env[creds.password] as string,
  });

  if (error || !data.session || jar.size === 0) {
    console.warn(
      `[auth-session] Sign-in failed for ${persona} (${error?.message ?? 'no session / no cookies set'}). ` +
        `${persona === 'vendor' ? 'Vendor-dashboard' : 'Authed-console'} cases will be SKIPPED.`,
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
