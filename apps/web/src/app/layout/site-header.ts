/**
 * Site header, on a Forest ground (AECI-1771).
 *
 * Responsive: below `lg` it is a minimal `[☰ wordmark]` bar. The hamburger
 * `aec-nav-menu` (its own `lg:hidden` host) opens an overlay that holds the
 * links, search, and Sign-in. At `lg+` the hamburger drops out and those
 * affordances render inline: a centered primary `<nav>` with the directory
 * links, plus a right-side cluster (search, Sign-in CTA).
 *
 * Forest ground (`--accent-primary`), Bone ink (`--text-on-brand`), hover wash
 * `--surface-on-brand-wash`, Bone focus ring (`--focus-ring-on-brand`). There is
 * no rule under the bar. The wordmark is the reversed file (`tone="on-dark"`).
 * Class sets live in `header-link-classes.ts`.
 *
 * Search is the one affordance that changes SHAPE rather than just appearing:
 * icon-collapsed (`aec-search-trigger`) through the `lg`-`xl` band, then the
 * inline `w-52` box at `xl+`. See `search-trigger.ts` for the width budget.
 *
 * The row is Home, Products, Categories, Trades, Audiences, Phases. The ruled
 * row is Browse, How we rank, For vendors (DESIGN.md §5, clash 26), but the
 * Browse menu that carries the facets does not exist until AECI-1774. Removing
 * the facet flyouts first would strand `/categories`, `/trades`, `/audiences`
 * and `/phases` for a desktop visitor, so the row stays as it was until that
 * menu lands. Each taxonomy entry links to its facet index AND opens a
 * `aec-nav-flyout-trigger` flyout of the top values by count.
 *
 * **The row is public-only, and closed.** Secondary destinations (Updates,
 * Roadmap, About, Contact) and Legal are in the footer, and the `/admin` IA is
 * reached by a single "Admin portal" door in the account menu (`user-menu.ts`).
 * A new secondary destination goes to the **footer**; a new *primary* one needs
 * a re-measure at 1024px, not just an insert (DESIGN.md §Navigation).
 *
 * The active route is weight 600 plus `aria-current`: `page` on an exact match,
 * `true` for a section. Colour never carries it alone, and the label reserves
 * its 600 width so the row does not shift.
 *
 * The same link set renders in the overlay (`nav-menu.ts`) and footer, so only
 * one `<nav aria-label="Primary">` is ever in the a11y tree at a given width (the
 * inline nav is `display:none` below `lg`; the overlay nav never mounts at `lg+`).
 *
 * Spec: DESIGN.md §5 (Navigation, "The header on Forest"); §2 (Forest grounds);
 * §16 Phase 1 ("Basic layout shell"); §21 (a11y).
 */
import { Component, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { SessionStatus } from '../auth/session-status';
import { injectSignInQueryParams } from '../auth/sign-in-link';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { SearchAutocomplete } from '../search/search-autocomplete';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { navigateToSearchQuery, navigateToSuggestion } from './search-submit';

import { BrandLogo } from './brand-logo';
import { HEADER_LINK, HEADER_LINK_ACTIVE, ON_FOREST_FOCUS_RING } from './header-link-classes';
import { NavFlyoutTrigger } from './nav-flyout-trigger';
import { NavMenu } from './nav-menu';
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
    SearchAutocomplete,
    SearchTrigger,
    UserMenu,
  ],
  template: `
    <header class="bg-(--accent-primary) text-(--text-on-brand)">
      <!--
        The gaps are load-bearing, not taste. AECI-1771 measured the row on Forest
        at 768, 1024 and 1280px, signed out. The signed-in widths are an
        estimate, not a measurement. DESIGN.md §Navigation has the table. Re-measure at 1024 before adding anything to this row.
      -->
      <div
        class="mx-auto flex max-w-7xl items-center gap-3 px-8 py-2.5 md:gap-8 md:py-4 lg:gap-4 xl:gap-8"
      >
        <aec-nav-menu />
        <aec-brand-logo tone="on-dark" [responsive]="true" />
        <!--
          AECI-544: the inline nav takes over from the hamburger at lg, not md.
          AECI-1771 re-measured it on Forest and it still does not fit at md.
          If this ever moves, three classes move together: this lg:flex,
          aec-nav-menu's lg:hidden and aec-search-trigger's lg:block. A mismatch
          renders two Primary nav landmarks (or none), or leaves a band with no
          search.
        -->
        <nav
          class="hidden flex-1 items-center justify-center gap-1 lg:flex"
          i18n-aria-label="@@app.nav.primary.aria"
          aria-label="Primary"
        >
          <a
            routerLink="/"
            [routerLinkActive]="activeClass"
            [routerLinkActiveOptions]="{ exact: true }"
            ariaCurrentWhenActive="page"
            [class]="linkClass"
            [attr.data-label]="labels.home"
            >{{ labels.home }}</a
          >
          <a
            routerLink="/products"
            [routerLinkActive]="activeClass"
            [ariaCurrentWhenActive]="true"
            [class]="linkClass"
            [attr.data-label]="labels.products"
            >{{ labels.products }}</a
          >
          <aec-nav-flyout-trigger kind="category" [items]="taxonomy.categoriesTop10()" />
          <aec-nav-flyout-trigger kind="trade" [items]="taxonomy.tradesTop10()" />
          <aec-nav-flyout-trigger kind="audience" [items]="taxonomy.audiencesTop10()" />
          <aec-nav-flyout-trigger kind="phase" [items]="taxonomy.phasesAll()" />
        </nav>
        <div class="hidden items-center gap-3 md:flex">
          <!--
            Search renders at every width, but in three different sizes:
              below lg: inside the hamburger overlay (aec-nav-menu)
              lg to xl: the icon-collapsed aec-search-trigger
              xl+: the inline w-52 box below
            aec-search-trigger owns its own "hidden lg:block xl:hidden" band, so
            the three mounts hand off without a gap. The search pill is
            AECI-1772's. Here the box is only kept legible and focusable on
            Forest: a white field, and a Bone ring (the shipped Forest ring is
            invisible on this ground).
          -->
          <aec-search-trigger />
          <!-- The 36px white field is an interim. AECI-1772 replaces it with
               the 44px pill. -->
          <aec-search-autocomplete
            class="hidden xl:block"
            inputId="header-search"
            [focusRingClass]="focusRing"
            (querySubmitted)="onSearchQuery($event)"
            (suggestionChosen)="onSuggestion($event)"
          />
          <!-- Auth affordance. Neutral "Sign in" is the SSR/pre-hydration
               default (cache-safe); SessionStatus flips to the account menu
               after hydration when a session is present (Phase 5 §4.4). The
               menu (Account / Admin / Sign out + the pending-review badge) is
               its own component (AECI-259). Sign in is the Bone main button on
               Forest: Forest text on Bone 11.03:1, on its hover fill 9.46:1. -->
          @if (session.signedIn()) {
            <aec-user-menu />
          } @else {
            <a
              routerLink="/auth/login"
              [queryParams]="signInParams()"
              [class]="signInClass"
              i18n="@@app.header.signIn"
            >
              Sign in
            </a>
          }
        </div>
      </div>
    </header>
  `,
})
export class SiteHeader {
  protected readonly taxonomy = inject(TaxonomyNavStore);
  protected readonly session = inject(SessionStatus);
  /** `?return=<this page>` so signing in lands back here, not on `/`. */
  protected readonly signInParams = injectSignInQueryParams();
  private readonly router = inject(Router);

  protected readonly linkClass = HEADER_LINK;
  protected readonly activeClass = HEADER_LINK_ACTIVE;
  /** The header search field's one ring set: Bone, 3px at 3px, on Forest. */
  protected readonly focusRing = ON_FOREST_FOCUS_RING;
  protected readonly labels = {
    home: $localize`:@@app.nav.home:Home`,
    products: $localize`:@@app.nav.products:Products`,
  };
  /** The Bone main button at the header's compact width: 44px high, 16px sides. */
  protected readonly signInClass =
    'inline-flex min-h-11 shrink-0 items-center rounded-control bg-(--accent-warm) px-4 text-sm font-semibold whitespace-nowrap text-(--accent-primary) transition-colors hover:bg-(--surface-on-brand-hover) ' +
    ON_FOREST_FOCUS_RING;

  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }
}
