import { Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterOutlet,
} from '@angular/router';
import { filter, map } from 'rxjs';

import type { VendorMeResponse } from '@aeci/shared';

import { RequestDrawer } from '../requests/request-drawer';
import { ViewPublicLink } from '../shared/view-public-link/view-public-link';

import { VendorPortalAnnouncer } from './vendor-announcer';
import { VENDOR_NAV_ITEMS, VENDOR_PRODUCT_NAV_ITEMS, type VendorNavItem } from './vendor-nav';
import { VendorPortalNav } from './vendor-portal-nav';

/**
 * Concept A — the vendor portal shell (AECI-522): a breadcrumb, a title, one
 * section nav, and one content panel.
 *
 * ── ONE HEADER THAT FOLLOWS THE CONTEXT (§6.11) ─────────────────────────────
 * The header describes whichever thing the page is about, and there is only ever
 * one of it:
 *
 *   - vendor context: `Vendor › Acme`, the company as the `h1`, the vendor's
 *     public page, and the vendor tabs (Overview / Profile / Products / Messages
 *     / Seats);
 *   - product context (`…/products/:productSlug/*`, for a product this vendor
 *     owns): `Vendor › Acme › Products › Revit`, the product as the `h1`, the
 *     product's public page, a "Back to Acme" link, and the product tabs
 *     (Profile / Categories / Trades / Audiences / Phases / Integrations) in place of the vendor tabs.
 *
 * It used to render the vendor header and tab row always, and the product page
 * stacked its own `h2`, public link and a segmented second row under them. Two
 * headings and two nav rows of different sizes made it unclear which one was in
 * charge. The product page is now only an outlet plus its not-found notice.
 *
 * A URL naming a product the vendor does NOT own stays in vendor context: the
 * page says so, and a header asserting that product would contradict it.
 *
 * The context is read from the router rather than passed up by the product
 * page, because the shell sits ABOVE the outlet and a child cannot hand its
 * parent a value without a service — and a second injectable is what the
 * preview's DI shadow would then have to provide (`vendor-product-context.ts`
 * records the same trade-off).
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
  imports: [RouterLink, RouterOutlet, VendorPortalNav, ViewPublicLink, RequestDrawer],
  template: `
    @let m = me();
    <section class="mx-auto w-full max-w-7xl px-6 py-10 md:px-8">
      <header class="pb-4">
        <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <nav i18n-aria-label="@@vendor.breadcrumb.aria" aria-label="Breadcrumb">
            <ol class="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-sm">
              <li>
                <a routerLink="overview" [class]="crumbLinkClass" i18n="@@vendor.breadcrumb.vendor"
                  >Vendor</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              @if (product(); as p) {
                <li>
                  <a routerLink="overview" [class]="crumbLinkClass">{{ m.vendor.company_name }}</a>
                </li>
                <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
                <li>
                  <a
                    routerLink="products"
                    [class]="crumbLinkClass"
                    i18n="@@vendor.breadcrumb.products"
                    >Products</a
                  >
                </li>
                <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
                <li class="min-w-0 break-words text-(--text-primary)" aria-current="page">
                  {{ p.name }}
                </li>
              } @else {
                <li class="min-w-0 break-words text-(--text-primary)" aria-current="page">
                  {{ m.vendor.company_name }}
                </li>
              }
            </ol>
          </nav>
          @if (product()) {
            <a routerLink="overview" [class]="crumbLinkClass">{{ backLabel() }}</a>
          }
        </div>
        <!--
          The link sits BESIDE the h1, never inside it (AECI-960, section 6.7).
          Inside, its text would join the page heading, which is the one string a
          screen reader uses to say what this page is, and it would break the
          spec assertion that the h1 reads exactly the title. One per page, so
          the uniform "View public page" accessible name is unambiguous here and
          needs no destination-naming aria-label. The integrations tab is the
          case that does.
        -->
        <div class="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h1
            class="font-display text-3xl font-semibold tracking-tight text-(--text-primary) md:text-4xl"
          >
            {{ product()?.name ?? m.vendor.company_name }}
          </h1>
          <aec-view-public-link [href]="publicHref()" />
        </div>
      </header>

      <aec-vendor-portal-nav [items]="navItems()" [ariaLabel]="navLabel()" />

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

      <!--
        The portal's correction drawer (AECI-967, section 6.9). Mounted once in
        the shell, like the live region and for the same reason: the shell
        survives every section change, and the sections that raise a correction
        (the product form's rename hint, the conflict lane) are two router hops
        apart. It renders nothing until an aecRequestTrigger opens it, and it
        never opens during SSR.

        This is the portal's answer to "I need to leave and file something":
        an overlay, not a navigation. The portal holds unsaved form state and
        apps/web has no CanDeactivate guard, so a same-tab trip to
        /products/:slug/correction would silently discard an edit. The
        anchors keep that URL as their no-JS fallback, with the new-tab
        treatment, because THAT path does navigate.
      -->
      <aec-request-drawer />
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorDashboardTabbed {
  readonly me = input.required<VendorMeResponse>();

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  /** The `:productSlug` somewhere below this shell's route, or null. Re-read on
   *  every completed navigation, because moving between products reuses the
   *  shell. */
  private readonly productSlug = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => productSlugBelow(this.route.snapshot)),
    ),
    { initialValue: productSlugBelow(this.route.snapshot) },
  );

  /** The product the header is about: only an OWNED product switches context. */
  protected readonly product = computed(() => {
    const slug = this.productSlug();
    if (slug === null) return null;
    return this.me().products.find((p) => p.slug === slug) ?? null;
  });

  protected readonly publicHref = computed(() => {
    const p = this.product();
    return p ? `/products/${p.slug}` : `/vendors/${this.me().vendor.slug}`;
  });

  /** One row: the vendor sections, or the open product's. Product paths are
   *  prefixed here because the row renders from the portal's route. */
  protected readonly navItems = computed<readonly VendorNavItem[]>(() => {
    const p = this.product();
    if (!p) return VENDOR_NAV_ITEMS;
    return VENDOR_PRODUCT_NAV_ITEMS.map((item) => ({
      ...item,
      path: `products/${p.slug}/${item.path}`,
    }));
  });

  /** `$localize` at the call site: an interpolated `i18n-aria-label` emits no
   *  attribute in this toolchain. */
  protected readonly navLabel = computed(() => {
    const p = this.product();
    return p
      ? $localize`:@@vendor.productNav.aria:${p.name}:product: sections`
      : $localize`:@@vendor.nav.aria:Portal sections`;
  });

  protected readonly backLabel = computed(
    () => $localize`:@@vendor.breadcrumb.back:← Back to ${this.me().vendor.company_name}:vendor:`,
  );

  protected readonly crumbLinkClass =
    'text-(--text-secondary) no-underline hover:text-(--accent-primary) ' +
    'focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-(--accent-primary)';

  /** The single live region's text (§6.3). Read-only here: the shell renders the
   *  channel, it does not decide what goes into it. */
  protected readonly liveMessage = inject(VendorPortalAnnouncer).message;
}

/** Walks the primary child chain for the first `:productSlug`. Exactly one route
 *  in the chain declares it, so "first" and "the one" are the same thing. */
function productSlugBelow(snapshot: ActivatedRouteSnapshot | undefined): string | null {
  for (let r: ActivatedRouteSnapshot | null | undefined = snapshot; r; r = r.firstChild) {
    // `params`, not `paramMap`: a stubbed route in a spec may carry a bare snapshot.
    const slug = r.params?.['productSlug'] as string | undefined;
    if (slug) return slug;
  }
  return null;
}
