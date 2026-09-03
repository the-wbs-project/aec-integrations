/**
 * App-wide "what is the signed-in visitor's `profiles.role`?" probe — the single
 * owner of the header's `GET /api/account` round trip.
 *
 * Extracted from `AdminStatus` (AECI-617) when the site header grew a SECOND
 * role-gated door beside the first: `AdminStatus` and `VendorStatus` were each
 * probing the same endpoint for the same `role` field, and only the admin one had
 * ever been made self-healing. Now both derive from this one signal, so a single
 * probe answers both questions and one `ensureProbed()` re-arms both doors.
 *
 * Like `SessionStatus` (Phase 5 §4.4 / §8) this MUST stay neutral during SSR and
 * pre-hydration so the header's URL-keyed cached HTML is visitor-state-neutral:
 * `role()` defaults to `null` and role-gated affordances only appear client-side.
 * The probe is gated on `SessionStatus.signedIn()` — itself the cache-neutral,
 * browser-only auth flag — so it can never fire during SSR (`signedIn` is always
 * false there) and anonymous visitors never hit any account endpoint.
 *
 * Detection rides the cheap "me" endpoint, never a role-gated one: a single
 * `GET /api/account` (open to any signed-in user) returns `role` **and**, for an
 * admin, `pending_reviews`. A non-admin therefore never reaches (and never 403s
 * on) `/api/admin/*`, and an admin gets both answers in ONE round trip.
 *
 * ── The three properties a naive "fetch once" lacks (AECI-617) ───────────────
 *
 *   1. **Self-healing.** The probe latches on SUCCESS, not on dispatch. A latch
 *      set before awaiting (with errors swallowed) means one 401 / JWKS blip /
 *      timeout suppresses the affordance for the entire life of the page — SPA
 *      navigation never re-runs it. A failed probe here leaves the latch open:
 *      it retries once on a short delay, and `ensureProbed()` lets a menu re-try
 *      on open, the exact moment the answer is needed.
 *   2. **One hop.** See `pending_reviews` above.
 *   3. **Instant on repeat visits.** The resolved role is cached in
 *      `sessionStorage` and applied the moment `signedIn()` flips, so a second
 *      page load in a tab paints role affordances with ZERO network. This is
 *      deliberately NOT a cookie and NOT server-side: the header renders on
 *      cacheable, URL-keyed routes, so any server-rendered role state would
 *      poison the edge cache for the next visitor (§8). `sessionStorage` never
 *      reaches the SSR Worker at all — the same reasoning behind
 *      `analytics/consent.ts` and `waitlist-welcome.service.ts`.
 *
 * The cached hint is applied from inside the `signedIn()` effect, never at
 * construction: `SessionStatus` only flips `signedIn` in `afterNextRender`, so the
 * hint lands strictly AFTER hydration and can't desync the hydrated DOM.
 *
 * Role is cached for the UI only. It is never an authorization input: the server
 * re-reads `profiles.role` + `banned_at` from D1 on EVERY request
 * (`AUTH_AND_RLS.md` §4.5), which is exactly why role must not be cached in KV on
 * the API side — a demoted or banned admin would keep real authority for the TTL.
 * Here the worst case is a stale menu whose every destination is still gated
 * server-side (the `/admin` + `/vendor` SSR redirects and resolvers,
 * `requireAdmin()` / `requireVendor()` on the API).
 */
import { Injectable, effect, inject, signal } from '@angular/core';

import type { AccountProfileResponse } from '@aeci/shared';

import { AccountApi } from '../account/account-api';

import { SessionStatus } from './session-status';

/** `sessionStorage` key holding the last successfully probed `profiles.role`. */
const ROLE_STORAGE_KEY = 'aeci.role';

/** Delay before the single in-probe retry — long enough to outlast a cold-isolate
 *  JWKS fetch or a dropped connection, short enough to stay imperceptible. */
const RETRY_DELAY_MS = 800;

/** Read the cached role. Returns null during SSR (no `sessionStorage`) and in
 *  private-mode / storage-disabled browsers, which throw on access. */
function readCachedRole(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(ROLE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeCachedRole(role: string): void {
  try {
    globalThis.sessionStorage?.setItem(ROLE_STORAGE_KEY, role);
  } catch {
    // Storage unavailable — the in-memory signal still drives this page load.
  }
}

function clearCachedRole(): void {
  try {
    globalThis.sessionStorage?.removeItem(ROLE_STORAGE_KEY);
  } catch {
    // Nothing to do; the in-memory signal is already the source of truth.
  }
}

@Injectable({ providedIn: 'root' })
export class RoleStatus {
  private readonly session = inject(SessionStatus);
  private readonly accountApi = inject(AccountApi);

  private readonly _role = signal<string | null>(null);
  private readonly _profile = signal<AccountProfileResponse | null>(null);

  /**
   * The signed-in visitor's `profiles.role`, or `null` during SSR / before the
   * post-hydration probe (or its cached hint) resolves — a UI hint only; every
   * real gate is server-side.
   */
  readonly role = this._role.asReadonly();

  /**
   * The last SUCCESSFULLY probed `GET /api/account` payload, for consumers that
   * need a field beyond `role` (`AdminStatus` seeds the pending-review badge from
   * `pending_reviews`). Stays `null` when `role()` came from the cached hint
   * rather than a live probe — a consumer that needs the payload must tolerate
   * that and wait for the probe to land.
   */
  readonly profile = this._profile.asReadonly();

  /** True once a probe has SUCCEEDED for the current session. A failed probe
   *  leaves this false so the answer can still be re-fetched. */
  private resolved = false;

  /** The in-flight probe, shared by every consumer so two doors in one menu
   *  can't double-fetch. Cleared on settle. */
  private inFlight: Promise<void> | null = null;

  /** Whether `signedIn()` has ever been true. Distinguishes "confirmed signed
   *  out" from the pre-hydration default, which is also `false`. */
  private sawSession = false;

  constructor() {
    // Browser-only by construction: the sole trigger is `signedIn()`, which never
    // becomes true during SSR (SessionStatus stays false there), so this effect
    // fires no network and bakes no visitor state into cached HTML.
    effect(() => {
      if (this.session.signedIn()) {
        this.sawSession = true;
        // Zero-network hint from a prior successful probe in this tab (see the
        // class docblock). Post-hydration by construction.
        const cached = readCachedRole();
        if (cached !== null) this._role.set(cached);
        void this.ensureProbed();
        return;
      }
      // `false` is ALSO the pre-hydration default, so only a true→false
      // transition means "signed out" (or a stale cookie corrected back to
      // neutral). Forgetting on the initial default would wipe the cached hint
      // before the effect that wants to read it ever runs.
      if (this.sawSession) {
        this.sawSession = false;
        this.forget();
      }
    });
  }

  /**
   * Probe if we haven't got a confirmed answer yet, coalescing concurrent calls
   * onto one request. Safe to call repeatedly — a no-op once resolved.
   *
   * The header menus call this when they open: if the post-hydration probe
   * failed, the retry happens at the moment the visitor actually asks to see the
   * menu, rather than never.
   */
  ensureProbed(): Promise<void> {
    // The `signedIn()` guard lives here, not at the call sites, so this stays
    // safe to call from any nav interaction: an anonymous visitor opening the
    // account menu must never touch an account endpoint.
    if (this.resolved || !this.session.signedIn()) return Promise.resolve();
    this.inFlight ??= this.reconcile().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** One probe with a single bounded retry. Never throws — a total failure just
   *  leaves the neutral default in place with the latch still open. */
  private async reconcile(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const me = await this.accountApi.getProfile();
        this.resolved = true;
        this._role.set(me.role);
        this._profile.set(me);
        writeCachedRole(me.role);
        return;
      } catch {
        // Transient (cold-isolate JWKS fetch, dropped connection, a stale access
        // token the Supabase SDK is mid-refresh on) → back off once and retry.
        if (attempt === 0) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    // Both attempts failed. `resolved` stays false, so `ensureProbed()` (menu
    // open, or a later `signedIn()` transition) tries again. Any cached hint is
    // kept: it's a UI hint, and the server gates every destination behind it.
  }

  /** Reset to the neutral default and forget the cached role. */
  private forget(): void {
    this.resolved = false;
    this._role.set(null);
    this._profile.set(null);
    clearCachedRole();
  }
}
