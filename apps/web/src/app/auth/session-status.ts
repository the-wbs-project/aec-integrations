import { Injectable, afterNextRender, inject, signal } from '@angular/core';

import { AuthService } from './auth.service';

/**
 * App-wide signed-in status for the header's auth affordance (Phase 5 §4.4:
 * "the header's signed-in state — avatar/menu vs 'Sign in' — is client-hydrated
 * so the header stays cache-neutral on cacheable pages").
 *
 * The site header renders on every page, including cacheable, URL-keyed ones,
 * so its SSR HTML must be visitor-state-neutral (§8). This store therefore
 * stays `signedIn() === false` during SSR and pre-hydration — the header paints
 * the neutral "Sign in" link for everyone — and reconciles **once** after
 * hydration. Exactly the pattern `ReviewCta` (AECI-201) uses for the review CTA.
 *
 * Reconciliation is two-step so the header flips the instant hydration runs —
 * not a beat later. Right after the OAuth/magic-link callback the browser lands
 * on a (cacheable, hence neutral-rendered) page with a fresh, JS-readable
 * `sb-<ref>-auth-token` cookie; the SYNCHRONOUS cookie-presence check flips the
 * header immediately, before the ~58 kB `@supabase/ssr` SDK even loads. The
 * async `AuthService.sessionSnapshot()` probe then confirms (or corrects a stale
 * cookie back to neutral) and supplies the session's email. Without the synchronous step the header stayed on
 * "Sign in" until the dynamic import + `getSession()` resolved, so a just-signed-
 * in visitor saw the wrong affordance on their landing page until they navigated.
 *
 * `providedIn: 'root'` (singleton) so the desktop header (`site-header.ts`) and
 * the mobile overlay (`nav-menu.ts`) share one reconciled value — they never
 * disagree, and the ~58 kB `@supabase/ssr` SDK loads at most once (and only
 * when an auth cookie is actually present; see `AuthService.sessionSnapshot`).
 */
@Injectable({ providedIn: 'root' })
export class SessionStatus {
  private readonly auth = inject(AuthService);

  private readonly _signedIn = signal(false);

  private readonly _email = signal<string | null>(null);

  /**
   * Whether the visitor has a session. `false` during SSR / before the
   * post-hydration probe resolves (the cache-neutral default), then the probed
   * truth. A UI hint only — every real gate is server-side (`/account` SSR
   * redirect, `POST /api/*` `requireAuth`).
   */
  readonly signedIn = this._signedIn.asReadonly();

  /**
   * The signed-in visitor's email, or `null` for an anonymous visitor / during
   * SSR + pre-hydration (same cache-neutral default as `signedIn`). Comes from
   * the same probe, so it costs no extra request. Consumers use it to skip
   * asking for something the session already knows — the claim/correction forms
   * prefill their email field from it.
   *
   * Note it stays `null` for the synchronous cookie-presence hint above: a
   * cookie proves a session exists but carries no readable email, so the email
   * only lands once the async snapshot resolves.
   */
  readonly email = this._email.asReadonly();

  constructor() {
    // Browser-only (never during SSR), so the session read can't poison the
    // cached HTML. The async probe is dispatched via `void` to keep the
    // callback synchronous (`() => void`), matching `ReviewCta`.
    afterNextRender(() => void this.reconcile());
  }

  private async reconcile(): Promise<void> {
    if (!this.auth.isConfigured()) return; // unconfigured env → stay neutral

    // Instant hint: a session cookie is present → paint the account menu the
    // moment hydration runs, WITHOUT waiting on the ~58 kB `@supabase/ssr`
    // dynamic import. This is what flips the header on the callback landing page
    // itself instead of a beat later. `httpOnly:false` on the auth cookie makes
    // it readable here (see `AuthService.hasSessionCookie`).
    if (this.auth.hasSessionCookie()) this._signedIn.set(true);

    try {
      // Confirm against the cookie-derived session: a present-but-stale cookie
      // corrects back to neutral, and the fast-path in `sessionSnapshot()` means
      // an absent cookie resolves without loading the SDK at all. One read yields
      // both the flag and the email.
      const { signedIn, email } = await this.auth.sessionSnapshot();
      this._signedIn.set(signedIn);
      this._email.set(email);
    } catch {
      // Probe failed (e.g. the SDK chunk didn't load) → keep the synchronous
      // cookie hint. Cookie-present stays "signed in" (a UI hint only; every
      // real gate is server-side), cookie-absent stays neutral. The "Sign in"
      // link still works either way.
    }
  }
}
