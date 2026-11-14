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
 * Search is a 44px pill on the Forest ground from `lg` (AECI-1772, clash 29). It
 * sits after the wordmark and takes the free width up to 460px. Below `lg` the
 * mobile menu carries search. Ctrl+/ or Cmd+/ focuses the pill from anywhere
 * (`search-shortcut.ts` records why it is not a bare "/", WCAG 2.1.4).
 *
 * The row is Browse, How we rank, For vendors (DESIGN.md §5, clash 26; AECI-1774).
 * "Browse" is a link to `/products` that also discloses the Browse menu
 * (`browse-menu.ts`): All products, the key categories, then Categories, Phases,
 * Audiences and Trades, each with a "See all" link to its index. Home left the
 * row (the wordmark goes home). Products is "All products" in the menu.
 *
 * While the menu is open the page behind dims. The dimmer is a sibling of
 * `<header>`, under it (`z-30` against the header's `z-40`), so the Forest bar
 * stays bright. It is decorative and `aria-hidden`, it traps nothing, and a click
 * on it closes the menu. It is outside the menu's host, so the pointer moving
 * onto it counts as leaving the menu.
 *
 * **The row is public-only, and closed.** Secondary destinations (Updates,
 * Roadmap, About, Contact) and Legal are in the footer, and the `/admin` IA is
 * reached by a single "Admin portal" door in the account menu (`user-menu.ts`).
 * A new secondary destination goes to the **footer**; a new *primary* one needs
 * a re-measure at 1024px, not just an insert (DESIGN.md §Navigation).
 *
 * The active route is weight 600 plus `aria-current`: `page` on an exact match
 * (How we rank, For vendors), `true` for a section (Browse, on the indexes and
 * their detail pages). Colour never carries it alone, and the label reserves its
 * 600 width so the row does not shift.
 *
 * The same link set renders in the overlay (`nav-menu.ts`) and footer, so only
 * one `<nav aria-label="Primary">` is ever in the a11y tree at a given width (the
 * inline nav is `display:none` below `lg`; the overlay nav never mounts at `lg+`).
 *
 * Spec: DESIGN.md §5 (Navigation, "The header on Forest"); §2 (Forest grounds);
 * §16 Phase 1 ("Basic layout shell"); §21 (a11y).
 */
import { DOCUMENT } from '@angular/common';
import { Component, inject, viewChild } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';

import { SessionStatus } from '../auth/session-status';
import { injectSignInQueryParams } from '../auth/sign-in-link';
import { SearchAutocomplete } from '../search/search-autocomplete';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { navigateToSearchQuery, navigateToSuggestion } from './search-submit';

import { BrandLogo } from './brand-logo';
import { BrowseMenu } from './browse-menu';
import { HEADER_LINK, HEADER_LINK_ACTIVE, ON_FOREST_FOCUS_RING } from './header-link-classes';
import { NavMenu } from './nav-menu';
import { isSearchShortcut, SEARCH_SHORTCUT_ARIA } from './search-shortcut';
import { UserMenu } from './user-menu';

@Component({
  selector: 'aec-site-header',
  imports: [
    RouterLink,
    RouterLinkActive,
    BrandLogo,
    NavMenu,
    BrowseMenu,
    SearchAutocomplete,
    UserMenu,
  ],
  // A global listener, not a field's: the shortcut works from anywhere. Document
  // listeners are never replayed, so it needs no replay guard.
  host: { '(document:keydown)': 'onDocumentKeydown($event)' },
  template: `
    <!-- relative: the Browse panel's containing block, so it spans the header.
         z-40: above the page dimmer (z-30) while the menu is open. -->
    <header class="relative z-40 bg-(--accent-primary) text-(--text-on-brand)">
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
          The search pill (AECI-1772, clash 29). It sits after the wordmark and
          takes the free width, up to 460px, so it is the one flexible part of the
          row. Below lg the mobile menu carries search. The pill needs the same
          lg handover as the inline nav: if either moves, move both.
        -->
        <aec-search-autocomplete
          class="hidden max-w-[460px] min-w-60 flex-1 lg:block"
          inputId="header-search"
          inputClass="w-full"
          inputHeightClass="h-11"
          [fieldClass]="pillField"
          [focusRingClass]="focusRing"
          [pill]="true"
          [shortcutHint]="shortcutHint"
          [keyShortcuts]="shortcutAria"
          (querySubmitted)="onSearchQuery($event)"
          (suggestionChosen)="onSuggestion($event)"
        />
        <!--
          AECI-544: the inline nav takes over from the hamburger at lg, not md.
          AECI-1771 re-measured it on Forest and it still does not fit at md.
          If this ever moves, three classes move together: this lg:flex,
          aec-nav-menu's lg:hidden and the search pill's lg:block. A mismatch
          renders two Primary nav landmarks (or none), or leaves a band with no
          search.
        -->
        <nav
          class="hidden items-center gap-1 lg:ms-auto lg:flex"
          i18n-aria-label="@@app.nav.primary.aria"
          aria-label="Primary"
        >
          <aec-browse-menu />
          <a
            routerLink="/docs/trust/how-ranking-works"
            [routerLinkActive]="activeClass"
            ariaCurrentWhenActive="page"
            [class]="linkClass"
            [attr.data-label]="labels.howWeRank"
            >{{ labels.howWeRank }}</a
          >
          <a
            routerLink="/vendor-program"
            [routerLinkActive]="activeClass"
            ariaCurrentWhenActive="page"
            [class]="linkClass"
            [attr.data-label]="labels.forVendors"
            >{{ labels.forVendors }}</a
          >
        </nav>
        <div class="hidden items-center gap-3 md:flex">
          <!-- Auth affordance. Neutral "Sign in" is the SSR/pre-hydration
               default (cache-safe); SessionStatus flips to the account menu
               after hydration when a session is present (Phase 5 §4.4). The
               menu (Account / Admin / Sign out + the pending-review badge) is
               its own component (AECI-259). Sign in is the Bone main button on
               Forest: Forest text on Bone 11.03:1, on its hover fill 9.46:1.
               The account menu is lazy (AECI-1774, bundle budget). It only ever
               mounts in the browser, after the session probe, so no server HTML
               changes. The placeholder holds its 44px circle while it loads. -->
          @if (session.signedIn()) {
            @defer (on immediate) {
              <aec-user-menu />
            } @placeholder {
              <span aria-hidden="true" class="block h-11 w-11 shrink-0"></span>
            }
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
    @if (browse()?.expanded()) {
      <div
        aria-hidden="true"
        data-browse-dimmer
        class="fixed inset-0 z-30 bg-(--scrim)"
        (click)="browse()?.dismiss()"
      ></div>
    }
  `,
})
export class SiteHeader {
  /** The Browse menu, for the dimmer. Absent below `lg` only in layout, never in the DOM. */
  protected readonly browse = viewChild(BrowseMenu);
  protected readonly session = inject(SessionStatus);
  /** `?return=<this page>` so signing in lands back here, not on `/`. */
  protected readonly signInParams = injectSignInQueryParams();
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  protected readonly linkClass = HEADER_LINK;
  protected readonly activeClass = HEADER_LINK_ACTIVE;
  /** The header search field's one ring set: Bone, 3px at 3px, on Forest. */
  protected readonly focusRing = ON_FOREST_FOCUS_RING;
  protected readonly labels = {
    howWeRank: $localize`:@@app.nav.howWeRank:How we rank`,
    forVendors: $localize`:@@app.nav.forVendors:For vendors`,
  };
  /** The Bone main button at the header's compact width: 44px high, 16px sides. */
  protected readonly signInClass =
    'inline-flex min-h-11 shrink-0 items-center rounded-control bg-(--accent-warm) px-4 text-sm font-semibold whitespace-nowrap text-(--accent-primary) transition-colors hover:bg-(--surface-on-brand-hover) ' +
    ON_FOREST_FOCUS_RING;

  /**
   * The pill's surface on Forest (clash 29): the 10% Bone wash with the strong
   * 4.01:1 edge (a wash alone is 1.33:1), the 16% wash on hover, Bone ink, and
   * secondary ink for the placeholder (6.00:1). The edge is the unlayered
   * `aec-on-brand-edge` class, because a `border-(--x)` utility loses to the
   * global `*` rule.
   */
  protected readonly pillField =
    'rounded-pill border aec-on-brand-edge bg-(--surface-on-brand-wash) px-4 text-t-16 text-(--text-on-brand) transition-colors hover:bg-(--surface-on-brand-wash-hover) aec-on-brand-placeholder';
  protected readonly shortcutHint = $localize`:@@app.header.search.shortcutHint:Ctrl /`;
  protected readonly shortcutAria = SEARCH_SHORTCUT_ARIA;

  private readonly search = viewChild(SearchAutocomplete);

  /**
   * Ctrl+/ or Cmd+/ focuses the search from anywhere on the page (AECI-1772).
   * It stands down in a field, with a dialog open, and when the pill is not laid
   * out (below `lg`, where the mobile menu carries search). The key press is
   * consumed so the browser does nothing else with it.
   */
  protected onDocumentKeydown(event: KeyboardEvent): void {
    const search = this.search();
    if (!search?.isVisible() || search.isFocused()) return;
    if (!isSearchShortcut(event, this.document)) return;
    event.preventDefault();
    search.focusInput();
  }

  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }
}
