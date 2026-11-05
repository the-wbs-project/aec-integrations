import { Component, afterNextRender, computed, effect, inject, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { VendorMeResponse } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { NotFound } from '../not-found/not-found';
import { VendorDashboardTabbed } from './vendor-dashboard-tabbed';
import { isVendorSuspendedGate, type VendorSuspendedGate } from './vendor-gate';
import { VendorLiveSync } from './vendor-live-sync';
import { VendorPortalStore } from './vendor-portal-store';
import { VendorSuspendedNotice } from './vendor-suspended-notice';

/** What `vendorMeResolver` leaves on the route. */
type ResolvedMe = VendorMeResponse | VendorSuspendedGate | null;

/**
 * AECI-522 — the vendor-portal LAYOUT route at `/vendor/:vendorSlug`: the gate,
 * the head, the store, the live sync, and the shell that renders the section
 * children (`vendor.routes.ts`). Data comes from `vendorMeResolver` via
 * `route.data['me']`:
 *
 *   - `me === null` → the caller is NOT a vendor admin, OR the `:vendorSlug` in
 *     the URL is not this session's vendor. The resolver has already set
 *     `RESPONSE_INIT.status = 404` + the noindex 404 meta; render the global
 *     `<aec-not-found/>` so the surface is never revealed, with the URL left
 *     intact. (`requireVendor()` rejects reviewers, banned seats,
 *     null-`vendor_id` seats, AND site admins. An unauthenticated caller is NOT
 *     in that set — since AECI-954 the resolver redirects a 401 to
 *     `/auth/login?return=<url>` and this component never renders.)
 *   - `me` set → seed {@link VendorPortalStore} and render the dashboard shell
 *     (the PO-chosen tabbed IA, AECI-522, on child routes since the portal gained
 *     real URLs).
 *   - a {@link VendorSuspendedGate} → the vendor is suspended (AECI-1623). Render
 *     `<aec-vendor-suspended-notice/>`, no store seed, no live sync. The same notice
 *     takes over when a portal already open hears of the suspension from a poll or a
 *     refetch ({@link VendorPortalStore.suspended}), so the seat never sits on a dead
 *     dashboard.
 *
 * The parent route's resolver runs once per entry into the portal — moving
 * between sections changes only the child, so a section switch costs no
 * round-trip and never re-seeds the store.
 *
 * ── WHY THE STORE IS PROVIDED HERE (AECI-628) ───────────────────────────────
 * This page is the surface owner: it holds the resolved payload and it is the
 * ancestor of every section. Providing `VendorPortalStore` on the component (not
 * `providedIn: 'root'`) means the store resolves the same `VendorApi` binding the
 * sections do — which is what lets the dev-only preview keep shadowing
 * `VendorApi` with `PreviewVendorApi` and get a working store for free. It also
 * scopes portal state to the portal: `/vendor` is never edge-cached, and none of
 * this may leak into a cacheable SSR component.
 *
 * The gate decision stays on the RESOLVED value, not on `store.me()`. They agree
 * (the store is seeded synchronously below), but "the resolver said this caller
 * is not a vendor" and "the store has not loaded yet" are different facts and
 * only the first one may render a 404.
 *
 * `/vendor` is a private, never-edge-cached surface (cookie-forwarded
 * non-cacheable SSR branch, no `Cache-Tag`), so on the success path we set a
 * `robots: noindex` head + a title — mirroring `/admin`. On the not-found path the
 * resolver already set the noindex 404 head, so we leave it.
 */
@Component({
  selector: 'aec-vendor-page',
  imports: [NotFound, VendorDashboardTabbed, VendorSuspendedNotice],
  providers: [VendorPortalStore, VendorLiveSync],
  template: `
    @if (suspended(); as gate) {
      <aec-vendor-suspended-notice [vendorName]="gate.vendorName" />
    } @else if (resolved() === null) {
      <aec-not-found />
    } @else if (me(); as m) {
      <aec-vendor-dashboard-tabbed [me]="m" />
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorPage {
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);
  private readonly store = inject(VendorPortalStore);
  private readonly liveSync = inject(VendorLiveSync);
  private readonly analytics = inject(Analytics);

  /** Resolved data. `vendorMeResolver` runs server-side and on hydration reads
   *  from `TransferState`; the snapshot value is the SSR-resolved payload (or
   *  null for a non-vendor / not-found). */
  protected readonly resolved = toSignal<ResolvedMe, ResolvedMe>(
    this.route.data.pipe(map((d) => (d['me'] ?? null) as ResolvedMe)),
    { initialValue: (this.route.snapshot.data['me'] ?? null) as ResolvedMe },
  );

  /** The resolver said so, or a read in a portal already open did. */
  protected readonly suspended = computed<VendorSuspendedGate | null>(() => {
    const resolved = this.resolved();
    return isVendorSuspendedGate(resolved) ? resolved : this.store.suspended();
  });

  /** What actually renders. The store owns it from here on, so a revalidation
   *  (AECI-629) or an optimistic write moves the dashboard without a reload. */
  protected readonly me = this.store.me;

  constructor() {
    // Seed synchronously so the FIRST render pass — including SSR — already has
    // the payload. An effect alone would not have run by then.
    const resolved = this.resolved();
    const initial = isVendorSuspendedGate(resolved) ? null : resolved;
    if (initial) this.store.seed(initial);

    // And re-seed if the resolver emits again (an in-app navigation back to
    // `/vendor` re-runs it). `seed()` no-ops on the identical object, so the
    // hydration re-emit costs nothing.
    effect(() => {
      const next = this.resolved();
      if (next && !isVendorSuspendedGate(next)) untracked(() => this.store.seed(next));
    });

    // Private surface. An effect, because a portal already open can flip to the notice,
    // and the title must then stop saying "Vendor portal". Effects also run in the SSR
    // render, so the head ships with the 403.
    effect(() => {
      if (!this.suspended()) return;
      this.titleSvc.setTitle(
        $localize`:@@vendor.suspended.metaTitle:Account suspended · AEC Integrations`,
      );
      this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    });

    // Success path only: private surface → noindex + a real title. The not-found
    // path's head is owned by the resolver (`setNotFoundMeta`), so leave it.
    if (initial) {
      this.titleSvc.setTitle($localize`:@@vendor.metaTitle:Vendor portal · AEC Integrations`);
      this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });

      // AECI-629 — the revalidation loop, browser-only and success-path only.
      // `afterNextRender` keeps it off the server (the SSR Worker has no
      // visibility state and no business holding a timer), and gating it on
      // `initial` keeps it off the 404 branch, where there is no session to poll
      // with and `GET /api/vendor/updates` would only 401. Teardown is the
      // service's own `DestroyRef` hook.
      afterNextRender(() => {
        this.liveSync.start();

        // AECI-649 / §AW8 — the vendor group (`docs/ANALYTICS.md` §8). THIS is
        // where the vendor identity is actually resolved: `initial` is the
        // payload `GET /api/vendor/me` returned through `requireVendor()`, so a
        // group is only ever asserted for a caller the API confirmed is a seat
        // on that vendor. A route-name guess would group anyone who typed
        // `/vendor`, including the 404 branch above.
        //
        // Guarded to the success path and to `afterNextRender` for the same two
        // reasons as the live sync: the 404 branch has no vendor, and the SSR
        // pass has no business writing analytics identity. `Analytics` holds it
        // until consent is granted and no-ops on a repeat navigation.
        this.analytics.groupVendor({
          id: initial.vendor.id,
          name: initial.vendor.company_name,
        });
      });
    }
  }
}
