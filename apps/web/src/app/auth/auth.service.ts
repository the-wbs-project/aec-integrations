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

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { safeReturnPath } from './return-path';
import { readSupabaseConfig } from './supabase-config';

@Injectable({ providedIn: 'root' })
export class AuthService {
  /** `undefined` = not yet constructed; `null` = env unconfigured. */
  private client: SupabaseClient | null | undefined;

  /** True when the SSR-injected public Supabase config is present and valid. */
  isConfigured(): boolean {
    return readSupabaseConfig() !== null;
  }

  /**
   * Sends the magic-link email. The link lands on
   * `/auth/callback?return=<validated path>`; `shouldCreateUser` keeps the
   * passwordless flow signup-capable (Phase 5 has no separate register page).
   * Throws on transport/Supabase errors — the caller renders the retryable
   * error notice.
   */
  async sendMagicLink(email: string, returnPath: string | null): Promise<void> {
    const { error } = await this.requireClient().auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: this.callbackUrl(returnPath),
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
    const { error } = await this.requireClient().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: this.callbackUrl(returnPath) },
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
    const { error } = await this.requireClient().auth.signOut();
    if (error) throw error;
  }

  /**
   * The absolute callback URL both flows redirect to. The return path is
   * re-validated here (defense in depth — the component already validates at
   * the route boundary) so no caller can thread an off-site value through.
   */
  private callbackUrl(returnPath: string | null): string {
    const url = new URL('/auth/callback', globalThis.location.origin);
    url.searchParams.set('return', safeReturnPath(returnPath));
    return url.toString();
  }

  /** Lazily constructs the browser client; throws when env is unconfigured. */
  private requireClient(): SupabaseClient {
    if (this.client === undefined) {
      const cfg = readSupabaseConfig();
      this.client = cfg ? createBrowserClient(cfg.url, cfg.anonKey) : null;
    }
    if (this.client === null) throw new Error('Supabase auth is not configured');
    return this.client;
  }
}
