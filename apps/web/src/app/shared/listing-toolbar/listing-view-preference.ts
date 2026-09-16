import { Injectable, inject, signal } from '@angular/core';

import { SessionStatus } from '../../auth/session-status';
import { RoleStatus } from '../../auth/role-status';
import { AccountApi } from '../../account/account-api';
import type { ListingView } from './listing-toolbar';

/**
 * Client-only persistence of the Cards/Table listing choice (AECI-988; `?view=` on
 * `/products` + taxonomy browse) so it survives navigation and becomes the
 * default on the next visit.
 *
 * **Two stores, one rule each.** Signed in → `profiles.listing_view_preference`
 * via `PATCH /api/account` (present-key-only patch: the toggle never re-sends
 * the display name). Signed out → the `aeci_listing_view` cookie, mirroring the
 * pair page's `aeci_pair_view` precedent (`products-pair.ts`). The cookie is
 * ALSO written on a signed-in toggle, so the preference survives a later
 * sign-out — but a signed-in read always prefers the profile, which is the
 * user-scoped store.
 *
 * CACHE-NEUTRALITY (§9.1a / `CACHE_STRATEGY.md` §6.1): every read and write
 * happens post-hydration in the browser. The cookie is read ONLY in
 * `afterNextRender` and the profile arrives only through the already
 * cache-neutral `RoleStatus` probe — so SSR never sees either store, the
 * URL-keyed edge entry stays shared, and the cookie is deliberately NOT in
 * `VISITOR_STATE_COOKIES` (that list is for cookies SSR *does* read). The
 * deep-linkable `?view=` URL param remains the source of truth; the remembered
 * preference only supplies the default when the URL carries no `?view=`.
 */
const LISTING_VIEW_COOKIE = 'aeci_listing_view';
const LISTING_VIEW_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function readListingViewCookie(): ListingView | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [name, value] = part.split('=');
    if (name?.trim() === LISTING_VIEW_COOKIE) {
      const v = value?.trim();
      if (v === 'cards' || v === 'table') return v;
    }
  }
  return null;
}

function writeListingViewCookie(view: ListingView): void {
  if (typeof document === 'undefined') return;
  // `Secure` only over HTTPS so local http dev (jsdom too) still persists it.
  const secure = globalThis.location?.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${LISTING_VIEW_COOKIE}=${view}; path=/; max-age=${LISTING_VIEW_COOKIE_MAX_AGE}; samesite=lax${secure}`;
}

@Injectable({ providedIn: 'root' })
export class ListingViewPreference {
  private readonly session = inject(SessionStatus);
  private readonly role = inject(RoleStatus);
  private readonly accountApi = inject(AccountApi);

  /**
   * The last view this tab handed to `PATCH /api/account`, or `null` before any
   * signed-in toggle. Set optimistically on the click rather than on the PATCH
   * resolving: the user's stated choice is the local truth either way (the
   * cookie already holds it), and waiting would leave the stale-profile window
   * open for exactly as long as the request takes.
   */
  private readonly lastPersisted = signal<ListingView | null>(null);

  /**
   * The remembered default for a signed-in visitor, or `null` when the probe
   * hasn't landed (or never set one). Reads the `RoleStatus` profile — the
   * same single `GET /api/account` round trip the header already makes — so
   * seeding the view costs no extra request. Callers must tolerate `null`
   * while the probe is in flight (`ensureProbed()` resolves first).
   *
   * A toggle made in THIS tab wins over that profile. `RoleStatus` probes once
   * per page load and is never re-fetched after our PATCH, so its snapshot goes
   * stale the moment the user toggles — and on the next SPA navigation to a
   * listing page `ensureProbed()` resolves instantly from the latch and would
   * hand back the pre-toggle value, silently reverting the choice the user just
   * made. `lastPersisted` is the in-tab correction.
   */
  rememberedFromProfile(): ListingView | null {
    const local = this.lastPersisted();
    if (local !== null) return local;
    const pref = this.role.profile()?.listing_view_preference;
    return pref === 'cards' || pref === 'table' ? pref : null;
  }

  /** The remembered default for an anonymous visitor (or a signed-in one whose
   *  probe failed), or `null`. Browser-only by construction — SSR has no
   *  `document`. */
  rememberedFromCookie(): ListingView | null {
    return readListingViewCookie();
  }

  /** The remembered default for whoever is here: the profile when
   *  signed in, else the cookie. `null` when nothing is remembered. */
  remembered(): ListingView | null {
    return this.session.signedIn() ? this.rememberedFromProfile() : this.rememberedFromCookie();
  }

  /**
   * Remember a fresh choice. The cookie is written synchronously so the very
   * next navigation (same tab or a later session, signed in or not) sees it;
   * the profile write rides the account PATCH fire-and-forget — a failed
   * write swallows (the cookie still covers this browser, and the toggle
   * itself never depended on the write landing).
   */
  persist(view: ListingView): void {
    writeListingViewCookie(view);
    if (this.session.signedIn()) {
      // Signed-in only: when signed out nothing is written to a profile, so the
      // cookie is the whole story and a `lastPersisted` set here would outrank
      // the real profile of whoever signs in next in this tab.
      this.lastPersisted.set(view);
      void this.accountApi.updateProfile({ listing_view_preference: view }).catch(() => {
        // Swallowed deliberately: the URL `?view=` is already the live truth
        // and the cookie holds the local default; re-PATCHing on a later
        // toggle is the self-healing path.
      });
    }
  }
}
