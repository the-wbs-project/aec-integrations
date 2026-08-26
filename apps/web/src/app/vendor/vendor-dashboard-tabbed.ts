import { Component, inject, input } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import type { VendorMeResponse } from '@aeci/shared';

import { VendorPortalAnnouncer } from './vendor-announcer';
import { VendorPortalNav } from './vendor-portal-nav';

/**
 * Concept A — the vendor portal shell (AECI-522): the section nav (Vendor
 * Overview / Profile / Products / Integrations / Seats) over one content panel.
 *
 * The nav was a side rail modelled on the admin shell and is now a horizontal
 * tab row above the content (`vendor-portal-nav.ts`, which also explains why
 * Products is a filterable dropdown rather than a link). The shell keeps only
 * the header, the nav, the outlet and the live region.
 *
 * ── THE SECTIONS ARE CHILD ROUTES NOW ───────────────────────────────────────
 * They started as an in-page `@switch` over a `Tab` signal, explicitly "no child
 * routes", so that the same component could render both in the dev-only preview
 * and on the real gated page. The cost of that was the whole of the browser's
 * navigation model: every section was the same URL, so nothing was linkable,
 * bookmarkable or shareable, Back left the portal entirely rather than returning
 * to the previous section, and a reload always landed on Overview. The portal
 * now mounts `VENDOR_SECTION_ROUTES` (`vendor.routes.ts`) under
 * `/vendor/:vendorSlug`, and this shell renders the nav + `<router-outlet/>`.
 *
 * The preview keeps working because the nav links are **relative**: `routerLink`
 * resolves against the `ActivatedRoute` of whichever route created the ancestor
 * that renders this shell — `/vendor/:vendorSlug` on the real surface,
 * `/preview/vendor-dashboard` in the preview — so one template serves both, with
 * no "am I previewing" branch anywhere.
 *
 * The vendor slug is in the URL (`/vendor/acme/products/revit`) rather than
 * implied by the session. Today one seat maps to exactly one `vendor_id`, so the
 * slug is derivable and the bare `/vendor` redirects to it; naming it anyway is
 * what makes the address describe the page, and it is the seam a future
 * multi-vendor seat needs. `vendorMeResolver` 404s a slug that is not the
 * session's, so the URL can never render someone else's dashboard.
 *
 * The shell stays presentational: it renders the company name, the nav, and the
 * live region. The §8 capability gate moved down to the routed sections with the
 * forms it gates (`vendor-capabilities.ts`), where it is read from
 * `VendorPortalStore` and re-derives on every refetched `me` — see
 * `docs/STAGE_2_REALTIME_SPEC.md` §6.1. Nothing here may latch `me` at
 * construction.
 *
 * ── THE ONE LIVE REGION (AECI-631 / §6.3) ───────────────────────────────────
 * The portal's single polite live region lives HERE, at the bottom of the shell,
 * and is fed by {@link VendorPortalAnnouncer}. It used to live inside
 * `vendor-integrations-section.ts`, with a second `role="status"` in
 * `vendor-integration-card.ts`; two regions on one page make announcements race
 * and duplicate. The shell is the right home because it outlives every section
 * change — the router destroys and re-creates the outlet's component exactly as
 * the `@switch` destroyed its branch, and the shell survives both — so the region
 * is persistent-and-mutated (which announces far more reliably than one that is
 * inserted) and is present from first paint rather than appearing only after a
 * section's fetch lands.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-dashboard-tabbed',
  imports: [RouterOutlet, VendorPortalNav],
  template: `
    @let m = me();
    <section class="mx-auto w-full max-w-7xl px-6 py-10 md:px-8">
      <header class="pb-4">
        <p class="aec-overline text-(--text-secondary)" i18n="@@vendor.eyebrow">Vendor</p>
        <h1
          class="mt-2 font-display text-3xl font-semibold tracking-tight text-(--text-primary) md:text-4xl"
        >
          {{ m.vendor.company_name }}
        </h1>
      </header>

      <aec-vendor-portal-nav [products]="m.products" />

      <div class="min-w-0">
        <router-outlet />
      </div>

      <!--
        THE portal's live region. One, polite, sr-only, and always in the DOM so
        a message is a mutation rather than an insertion. It sits in the shell
        because the shell survives every section change: a region that lived in a
        section would be destroyed mid-announcement when the outlet swapped, and
        a second region anywhere on the page would make two utterances compete
        for one event. Nothing writes to it directly; everything goes through
        VendorPortalAnnouncer. Failures are the opposite case and stay lane-local
        and role="alert", beside the control that failed.

        sr-only is also what satisfies the no-layout-shift rule: an announcement
        occupies no space, so it can never move a control out from under a
        pointer already travelling toward it.
      -->
      <p class="sr-only" role="status">{{ liveMessage() }}</p>
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorDashboardTabbed {
  readonly me = input.required<VendorMeResponse>();

  /** The single live region's text (§6.3). Read-only here: the shell renders the
   *  channel, it does not decide what goes into it. */
  protected readonly liveMessage = inject(VendorPortalAnnouncer).message;
}
