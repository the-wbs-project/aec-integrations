/**
 * Site header.
 *
 * Responsive: below `lg` it is a minimal `[☰ wordmark]` bar — the hamburger
 * `aec-nav-menu` (its own `lg:hidden` host) opens an overlay that holds the
 * links, search, and Sign-in. At `lg+` the hamburger drops out and those
 * affordances render inline: a centered primary `<nav>` with the directory
 * links, plus a right-side cluster (search, Sign-in CTA), over a warm Bone
 * "shelf" that reads as editorial structure rather than chrome.
 *
 * Search is the one affordance that changes SHAPE rather than just appearing:
 * icon-collapsed (`aec-search-trigger`) through the `lg`–`xl` band, then the
 * inline `w-52` box at `xl+`. That band used to render no search at all — the
 * hamburger ended at `lg` and the box started at `xl` — and the box genuinely
 * doesn't fit at 1024px, so the icon is what closes the gap. See
 * `search-trigger.ts` for the width budget.
 *
 * The row is Home · Products · Categories▾ · Trades▾ · Audiences▾ · Phases▾ ·
 * More▾. AECI-158 re-pointed the directory at the taxonomy; Vendors /
 * Integrations were removed from the primary nav AND the footer (AECI-160, PO
 * decision) — they stay reachable via `sitemap.xml`, detail-page breadcrumbs,
 * and search. Each taxonomy entry links to its facet index AND opens a
 * `aec-nav-flyout-trigger` flyout of the top values by count.
 *
 * `aec-nav-more-trigger` is the overflow menu and the last item in the row: it
 * carries every destination that isn't a primary directory surface (Updates,
 * Roadmap, About, Contact, Legal) plus the full `/admin` section for an admin.
 * Updates lived in the primary row until that menu landed; secondary
 * destinations go there from now on rather than widening this row.
 *
 * The same link set renders in the overlay (`nav-menu.ts`) and footer, so only
 * one `<nav aria-label="Primary">` is ever in the a11y tree at a given width (the
 * inline nav is `display:none` below `lg`; the overlay nav never mounts at `lg+`).
 *
 * Spec: DESIGN.md §5 (Navigation); §16 Phase 1 ("Basic layout shell"); §3.1
 * (route inventory drives nav); §2a (theming); §21 (a11y).
 */
import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { SessionStatus } from '../auth/session-status';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { SearchAutocomplete } from '../search/search-autocomplete';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { navigateToSearchQuery, navigateToSuggestion } from './search-submit';

import { BrandLogo } from './brand-logo';
import { NavFlyoutTrigger } from './nav-flyout-trigger';
import { NavMenu } from './nav-menu';
import { NavMoreTrigger } from './nav-more-trigger';
import { SearchTrigger } from './search-trigger';
import { UserMenu } from './user-menu';

@Component({
  selector: 'aec-site-header',
  imports: [
    RouterLink,
    RouterLinkActive,
    BrandLogo,
    NavMenu,
    NavFlyoutTrigger,
    NavMoreTrigger,
    SearchAutocomplete,
    SearchTrigger,
    UserMenu,
  ],
  template: `
    <header class="bg-(--surface-base)">
      <!--
        The lg-band gaps (lg:gap-6 here, gap-3.5 on the nav) are load-bearing,
        not taste. Measured at 1024px, signed out (the worst case: "Sign in" is
        wider than the account icon):
          before the search icon, at gap-5/gap-8: fits, nav box 598 vs content
            597, i.e. 1px of slack
          with the search icon, at gap-5/gap-8: scrollWidth exceeds clientWidth
            by 29px, so the row clips
          with the search icon, at gap-3.5/gap-6: fits, nav box 562 vs content
            561, back to the same 1px
        So these two gap steps are what pay for the 36px control; they buy back
        exactly what it costs and nothing more. At xl+ the gaps go back up, where
        there is room. Re-measure at 1024 before adding anything to this row.
      -->
      <div class="mx-auto flex max-w-7xl items-center gap-3 px-8 py-5 md:gap-8 lg:gap-6 xl:gap-8">
        <aec-nav-menu />
        <aec-brand-logo />
        <!--
          AECI-544: the inline nav takes over from the hamburger at lg, not md.
          With four taxonomy flyouts it needs ~650px; at 768px only ~350px is
          left after the wordmark and the sign-in button, so the last items were
          clipped out of the viewport (already true of Phases before trades
          joined). aec-nav-menu is lg:hidden to match, and it already lists
          every facet, so nothing becomes unreachable between md and lg.
          The row is still measured: "More" replaced the Updates link (net width
          ~neutral), and any further top-level item needs a re-measure at 1024px,
          not just an insert. Secondary destinations belong in More.
          Measured item widths at gap-3.5 (1024px, en-US): Home 37 · Products 56
          · Categories 96 · Trades 70 · Audiences 93 · Phases 73 · More 52, plus
          6 gaps of 14 = 561, in a 561px box. There is no headroom left at lg:
          the next item added here has to displace one, and demoting Home into
          the wordmark (which already links to "/") is the cheapest ~51px.
        -->
        <nav
          class="hidden flex-1 items-center justify-center gap-3.5 text-sm font-medium lg:flex xl:gap-7"
          i18n-aria-label="@@app.nav.primary.aria"
          aria-label="Primary"
        >
          <a
            routerLink="/"
            routerLinkActive="text-(--accent-primary)"
            [routerLinkActiveOptions]="{ exact: true }"
            class="text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.home"
          >
            Home
          </a>
          <a
            routerLink="/products"
            routerLinkActive="text-(--accent-primary)"
            class="text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.products"
          >
            Products
          </a>
          <aec-nav-flyout-trigger kind="category" [items]="taxonomy.categoriesTop10()" />
          <aec-nav-flyout-trigger kind="trade" [items]="taxonomy.tradesTop10()" />
          <aec-nav-flyout-trigger kind="audience" [items]="taxonomy.audiencesTop10()" />
          <aec-nav-flyout-trigger kind="phase" [items]="taxonomy.phasesAll()" />
          <aec-nav-more-trigger />
        </nav>
        <div class="hidden items-center gap-3 md:flex">
          <!--
            Search renders at every width, but in three different sizes, because
            the row's slack varies by ~250px across the desktop range:
              below lg → inside the hamburger overlay (aec-nav-menu)
              lg – xl  → the icon-collapsed aec-search-trigger (~36px; the box
                         does not fit; at 1024px the row has ~1px spare)
              xl+      → the inline w-52 box below
            aec-search-trigger owns its own "hidden lg:block xl:hidden" band, so
            the three mounts hand off without a gap. They did NOT before: the
            hamburger stopped at lg and this box started at xl, leaving 1024-1279
            with no search affordance at all.
          -->
          <aec-search-trigger />
          <aec-search-autocomplete
            class="hidden xl:block"
            inputId="header-search"
            (querySubmitted)="onSearchQuery($event)"
            (suggestionChosen)="onSuggestion($event)"
          />
          <!-- Auth affordance. Neutral "Sign in" is the SSR/pre-hydration
               default (cache-safe); SessionStatus flips to the account menu
               after hydration when a session is present (Phase 5 §4.4). The
               menu (Account / Admin / Sign out + the pending-review badge) is
               its own component (AECI-259). -->
          @if (session.signedIn()) {
            <aec-user-menu />
          } @else {
            <a
              routerLink="/auth/login"
              class="inline-flex shrink-0 items-center rounded-(--radius-md) bg-(--accent-primary) px-4 py-1.5 text-sm font-medium whitespace-nowrap text-(--surface-base) hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@app.header.signIn"
            >
              Sign in
            </a>
          }
        </div>
      </div>
      <div class="h-1 w-full bg-(--accent-warm)" aria-hidden="true"></div>
    </header>
  `,
})
export class SiteHeader {
  protected readonly taxonomy = inject(TaxonomyNavStore);
  protected readonly session = inject(SessionStatus);
  private readonly router = inject(Router);

  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }
}
