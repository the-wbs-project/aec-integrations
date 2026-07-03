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
 * hydration via the browser-only `AuthService.isSignedIn()` probe. Exactly the
 * pattern `ReviewCta` (AECI-201) uses for the review CTA.
 *
 * `providedIn: 'root'` (singleton) so the desktop header (`site-header.ts`) and
 * the mobile overlay (`nav-menu.ts`) share one reconciled value — they never
 * disagree, and the ~58 kB `@supabase/ssr` SDK loads at most once (and only
 * when an auth cookie is actually present; see `AuthService.isSignedIn`).
 */
@Injectable({ providedIn: 'root' })
export class SessionStatus {
  private readonly auth = inject(AuthService);

  private readonly _signedIn = signal(false);

  /**
   * Whether the visitor has a session. `false` during SSR / before the
   * post-hydration probe resolves (the cache-neutral default), then the probed
   * truth. A UI hint only — every real gate is server-side (`/account` SSR
   * redirect, `POST /api/*` `requireAuth`).
   */
  readonly signedIn = this._signedIn.asReadonly();

  constructor() {
    // Browser-only (never during SSR), so the session read can't poison the
    // cached HTML. The async probe is dispatched via `void` to keep the
    // callback synchronous (`() => void`), matching `ReviewCta`.
    afterNextRender(() => void this.reconcile());
  }

  private async reconcile(): Promise<void> {
    if (!this.auth.isConfigured()) return; // unconfigured env → stay neutral
    try {
      this._signedIn.set(await this.auth.isSignedIn());
    } catch {
      // Any probe failure → keep the neutral default; the "Sign in" link works.
    }
  }
}
