/**
 * Browser-side Supabase auth entry points for the login page (AECI-194 /
 * Phase 5.3): magic-link email + Google OAuth, both redirecting back through
 * `/auth/callback?return=<path>` (the AECI-195 exchange surface).
 *
 * Uses `@supabase/ssr`'s `createBrowserClient` — NOT bare `supabase-js` — on
 * purpose: it stores the PKCE verifier and session in the same cookie format
 * the AECI-193 server client (`server/auth/supabase-server-client.ts`) reads,
 * which is exactly the compatibility that adapter preserves by passing cookie
 * names through verbatim. The server-side `exchangeCodeForSession` in the
 * callback depends on it.
 *
 * Browser-only: the client reads `window.__AECI_SUPABASE__` (the SSR-injected
 * public config) and `location.origin`. Callers guard the platform —
 * `LoginPage` only invokes these methods from user events / `afterNextRender`,
 * which never run during SSR. `isConfigured()` doubles as the
 * graceful-degradation probe: `false` means the env has no Supabase config and
 * the login UI renders its "temporarily unavailable" notice.
 */
import { Injectable } from '@angular/core';

import type { SupabaseClient } from '@supabase/supabase-js';

import { safeReturnPath } from './return-path';
import { readSupabaseConfig } from './supabase-config';

/**
 * True when a Supabase auth-token cookie is present (`sb-<ref>-auth-token`,
 * possibly chunked `…-auth-token.0`). Lets `isSignedIn()` answer "no" for
 * anonymous visitors WITHOUT loading the ~58 kB browser SDK — see
 * `requireClient()` (AECI-221). Browser-only; returns false during SSR.
 */
function hasSupabaseAuthCookie(): boolean {
  if (typeof document === 'undefined') return false;
  return /(?:^|;\s*)sb-[^=;]*-auth-token(?:\.\d+)?=/.test(document.cookie);
}

/** What a single cookie-derived session read yields. `email` is `null` when
 *  there's no session or the session carries no email claim. */
export interface SessionSnapshot {
  readonly signedIn: boolean;
  readonly email: string | null;
  /** `auth.users.id` (the JWT `sub`), or `null` with no session. This is the
   *  value `Analytics.identify()` sends to PostHog (`docs/ANALYTICS.md` §8) and
   *  the one the API Worker records as `posthogDistinctId`; the two only join if
   *  they are the same value. */
  readonly userId: string | null;
}

/** The "no session" answer — also what an unconfigured env resolves to. */
const ANONYMOUS_SNAPSHOT: SessionSnapshot = { signedIn: false, email: null, userId: null };

@Injectable({ providedIn: 'root' })
export class AuthService {
  /** `undefined` = not yet constructed; `null` = env unconfigured. */
  private client: SupabaseClient | null | undefined;

  /** True when the SSR-injected public Supabase config is present and valid. */
  isConfigured(): boolean {
    return readSupabaseConfig() !== null;
  }

  /**
   * Cheap, synchronous "is a Supabase session cookie present?" check — the same
   * *presence* signal the SSR auth-gate uses, with no Auth-server round-trip and
   * no browser-SDK load. Used by the review form's post-hydration gate to decide
   * whether to raise the sign-in pop-up: an absent cookie means the visitor is
   * clearly not signed in. A present-but-stale cookie falls through to the form,
   * where the API's `requireAuth` 401 is the backstop (and `POST /api/reviews`
   * stays the real enforcement point). Browser-only; returns `false` during SSR.
   */
  hasSessionCookie(): boolean {
    return hasSupabaseAuthCookie();
  }

  /**
   * Browser-only snapshot of the cookie-derived session: whether one exists and
   * the email it carries. One `getSession()` serves both, so `SessionStatus` can
   * reconcile the header affordance AND the signed-in email (used to prefill the
   * claim/correction forms' email field, so a signed-in visitor never retypes an
   * address the session already knows) without probing twice.
   *
   * Same guarantees as `isSignedIn()`: never call it during SSR (it would bake
   * visitor state into the URL-keyed edge cache; §8), it's a UI hint only — every
   * real gate is server-side — and an unconfigured env resolves to the anonymous
   * snapshot rather than throwing.
   *
   * `email` is the same value `GET /api/account` reports (both read the session's
   * JWT claim), so the prefill agrees with the account page without a round-trip.
   * It can be `null` on a session with no email claim.
   */
  async sessionSnapshot(): Promise<SessionSnapshot> {
    if (!this.isConfigured()) return ANONYMOUS_SNAPSHOT;
    // Anonymous fast-path: no auth cookie → not signed in, and the browser SDK
    // never loads. This is the cacheable detail-page case (and the Lighthouse
    // measurement) where `ReviewCta` probes every load — so `@supabase/ssr`
    // stays out of the detail-page JS budget (AECI-221). A logged-in visitor
    // (cookie present) falls through and loads the SDK to verify the session.
    if (!hasSupabaseAuthCookie()) return ANONYMOUS_SNAPSHOT;
    const client = await this.requireClient();
    const {
      data: { session },
    } = await client.auth.getSession();
    if (!session) return ANONYMOUS_SNAPSHOT;
    return { signedIn: true, email: session.user.email ?? null, userId: session.user.id };
  }

  /**
   * Browser-only probe for "is there a signed-in session right now?", used by
   * the cache-neutral review CTA (AECI-201) to flip from its neutral SSR
   * default to a personalized label *after* hydration — never during SSR (that
   * would bake visitor state into the URL-keyed edge cache; §8). Reads the
   * cookie-derived session via `getSession()` (no Auth-server round-trip) — a
   * UI hint only; the real gate is the server-side route guard on
   * `/products/:slug/review` and `POST /api/reviews`. Returns `false` (not a
   * throw) when auth is unconfigured so the caller simply stays neutral. Call
   * only from `afterNextRender`/user events, never from SSR.
   */
  async isSignedIn(): Promise<boolean> {
    return (await this.sessionSnapshot()).signedIn;
  }

  /**
   * The signed-in visitor's Supabase user id, or `null` when there is no
   * session (or auth is unconfigured, or the cookie is stale). Browser-only,
   * same rules as {@link isSignedIn}. Both read {@link sessionSnapshot}, so the
   * session is read once and the answers can never disagree.
   *
   * The value is `auth.users.id`, i.e. the JWT `sub`. That identity matters
   * beyond the UI: it is what `Analytics.identify()` sends to PostHog
   * (`docs/ANALYTICS.md` §8) and what the API Worker records as
   * `posthogDistinctId` on its logs, and the two only join if they are the same
   * value. Anything else would mint a person that does not exist.
   *
   * Carries the same anonymous fast-path as before: with no auth cookie the
   * ~58 kB `@supabase/ssr` SDK is never loaded (AECI-221) — the cacheable
   * detail-page case, where `ReviewCta` probes on every load.
   */
  async currentUserId(): Promise<string | null> {
    return (await this.sessionSnapshot()).userId;
  }

  /**
   * Sends the magic-link email. The link lands on
   * `/auth/callback?return=<validated path>`; `shouldCreateUser` keeps the
   * passwordless flow signup-capable (Phase 5 has no separate register page).
   * Throws on transport/Supabase errors — the caller renders the retryable
   * error notice.
   */
  async sendMagicLink(email: string, returnPath: string | null): Promise<void> {
    const { error } = await (
      await this.requireClient()
    ).auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: this.callbackUrl(returnPath, 'magic_link'),
        shouldCreateUser: true,
      },
    });
    if (error) throw error;
  }

  /**
   * Starts the Google OAuth flow — navigates the browser away to Google and
   * back to `/auth/callback?return=<validated path>`. Resolves just before
   * the redirect; throws on errors raised before navigation.
   */
  async signInWithGoogle(returnPath: string | null): Promise<void> {
    const { error } = await (
      await this.requireClient()
    ).auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: this.callbackUrl(returnPath, 'google') },
    });
    if (error) throw error;
  }

  /**
   * Signs the browser session out (AECI-202 / Phase 5.11): clears the
   * `sb-<ref>-auth-token` cookie via `@supabase/ssr` so the SSR auth-gate blocks
   * re-entry to `/account` and the (now-stale) JWT can't be replayed. A no-op
   * when the env is unconfigured. Throws on Supabase errors so the caller can
   * surface a retryable notice. Used by the account page's sign-out + the
   * post-deletion cleanup.
   */
  async signOut(): Promise<void> {
    if (!this.isConfigured()) return;
    const { error } = await (await this.requireClient()).auth.signOut();
    if (error) throw error;
  }

  /**
   * The absolute callback URL both flows redirect to. The return path is
   * re-validated here (defense in depth — the component already validates at
   * the route boundary) so no caller can thread an off-site value through.
   * `method` is carried so the callback can tag the `aeci.auth.signin` metric
   * by sign-in method (AECI-206) — it's observability only, never trusted.
   */
  private callbackUrl(returnPath: string | null, method: 'magic_link' | 'google'): string {
    const url = new URL('/auth/callback', globalThis.location.origin);
    url.searchParams.set('return', safeReturnPath(returnPath));
    url.searchParams.set('method', method);
    return url.toString();
  }

  /**
   * Lazily constructs the browser client; throws when env is unconfigured.
   * `@supabase/ssr` is loaded via a dynamic `import()` (not a static top-level
   * import) so the ~58 kB auth SDK ships in its own chunk that loads only when a
   * client is actually needed — a signed-in session probe, or the login/account
   * flows — never on an anonymous detail-page render (AECI-221).
   */
  private async requireClient(): Promise<SupabaseClient> {
    if (this.client === undefined) {
      const cfg = readSupabaseConfig();
      if (cfg) {
        const { createBrowserClient } = await import('@supabase/ssr');
        this.client = createBrowserClient(cfg.url, cfg.anonKey);
      } else {
        this.client = null;
      }
    }
    if (this.client === null) throw new Error('Supabase auth is not configured');
    return this.client;
  }
}
