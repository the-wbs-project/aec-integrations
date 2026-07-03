/**
 * Site header.
 *
 * Responsive: below `md` it is a minimal `[☰ wordmark]` bar — the hamburger
 * `aec-nav-menu` (its own `md:hidden` host) opens an overlay that holds the
 * links, search, and Sign-in. At `md+` the hamburger drops out and those
 * affordances render inline: a centered primary `<nav>` with the directory
 * links, plus a right-side cluster (search at `lg+`, Sign-in CTA), over a warm
 * Bone "shelf" that reads as editorial structure rather than chrome.
 *
 * AECI-158 re-points the directory at the taxonomy: Home · Products ·
 * Categories▾ · Audiences▾ · Phases▾. Vendors / Integrations were removed from
 * the primary nav AND the footer (AECI-160, PO decision) — they stay reachable
 * via `sitemap.xml`, detail-page breadcrumbs, and search. The three taxonomy
 * entries each link to their facet index AND open a
 * `aec-nav-flyout-trigger` flyout of the top values by count. The same link set
 * renders in the overlay (`nav-menu.ts`) and footer, so only one
 * `<nav aria-label="Primary">` is ever in the a11y tree at a given width (the
 * inline nav is `display:none` below `md`; the overlay nav never mounts at `md+`).
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
    UserMenu,
  ],
  template: `
    <header class="bg-(--surface-base)">
      <div class="mx-auto flex max-w-7xl items-center gap-3 px-8 py-5 md:gap-8">
        <aec-nav-menu />
        <aec-brand-logo />
        <nav
          class="hidden flex-1 items-center justify-center gap-7 text-sm font-medium md:flex"
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
          <aec-nav-flyout-trigger kind="audience" [items]="taxonomy.audiencesTop10()" />
          <aec-nav-flyout-trigger kind="phase" [items]="taxonomy.phasesAll()" />
        </nav>
        <div class="hidden items-center gap-3 md:flex">
          <aec-search-autocomplete
            class="hidden lg:block"
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
              class="inline-flex items-center rounded-(--radius-md) bg-(--accent-primary) px-4 py-1.5 text-sm font-medium text-(--surface-base) hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
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
