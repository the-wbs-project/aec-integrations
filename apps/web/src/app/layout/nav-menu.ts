/**
 * Primary navigation menu — the small-screen hamburger (below `md`).
 *
 * A labelled hamburger trigger (to the left of the wordmark in `site-header.ts`)
 * opens a CDK-overlay dropdown that is the home for all site chrome on small
 * screens: Home + Products links, the three taxonomy facets as tap-to-expand
 * disclosure sections (Categories / Audiences / Phases), search, the theme
 * button group, and the Sign-in CTA. The component is hidden at `md+` via its
 * `md:hidden` host class — at those widths the same affordances render as the
 * inline desktop nav in `site-header.ts` (with hover flyouts). Both surfaces
 * share `NavFlyoutList` + the `@@app.nav.*` copy (`taxonomy-nav-copy.ts`), so
 * the link sets cannot drift. AECI-158/159 re-pointed the nav at the taxonomy;
 * Vendors / Integrations were removed from the nav AND the footer (AECI-160, PO
 * decision) — reachable via `sitemap.xml`, detail-page breadcrumbs, and search.
 *
 * The overlay is `BrnPopover` (extends `BrnDialog`), which supplies the CDK
 * overlay, focus trap, Escape / outside-click close, and focus-return-to-trigger
 * — and reflects `aria-expanded` / `aria-haspopup` / `aria-controls` on the
 * trigger automatically. Same primitive used at `preview/vendor-detail`.
 *
 * SSR-safe: the dropdown content lives in an `ng-template` that only mounts in
 * the CDK overlay on click (always client-side), so the server renders just the
 * static, visitor-state-neutral toggle button — including the embedded theme
 * toggle, which therefore never bakes per-visitor theme state into cached HTML.
 * (The taxonomy values likewise only appear client-side; the SSR-crawlable
 * facet links live on the desktop bar + the footer.)
 *
 * The toggle is the canonical Lucide `menu` glyph inlined as SVG with
 * `stroke="currentColor"` so it themes via `--text-primary` (DESIGN.md: Lucide
 * icons exclusively — no icon library needed for a single glyph).
 *
 * Spec: DESIGN.md §5 (Navigation); §21 (a11y); AECI-96/158/159.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { AuthService } from '../auth/auth.service';
import { SessionStatus } from '../auth/session-status';
import { signOutAndGoHome } from '../auth/sign-out';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { SearchAutocomplete } from '../search/search-autocomplete';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { NavFlyoutList } from './nav-flyout-list';
import { navigateToSearchQuery, navigateToSuggestion } from './search-submit';
import { facetNavLabel, facetViewAllLabel } from './taxonomy-nav-copy';

@Component({
  selector: 'aec-nav-menu',
  // Hamburger is the small-screen affordance only; at `md+` the inline desktop
  // nav in `site-header.ts` takes over, so the trigger (and its overlay) are
  // removed from the layout above `md`.
  host: { class: 'md:hidden' },
  imports: [
    RouterLink,
    RouterLinkActive,
    BrnPopover,
    BrnPopoverContent,
    BrnPopoverTrigger,
    NavFlyoutList,
    SearchAutocomplete,
  ],
  template: `
    <button
      brnPopoverTrigger
      [brnPopoverTriggerFor]="menu"
      type="button"
      class="relative inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-(--border-default) bg-(--surface-raised) text-(--text-primary) transition-colors hover:border-(--border-strong) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      i18n-aria-label="@@app.nav.menu.toggle.aria"
      aria-label="Open menu"
      [attr.aria-describedby]="showBadge() ? 'aec-nav-menu-pending' : null"
    >
      <svg
        aria-hidden="true"
        class="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="4" x2="20" y1="6" y2="6" />
        <line x1="4" x2="20" y1="12" y2="12" />
        <line x1="4" x2="20" y1="18" y2="18" />
      </svg>
      <!-- Pending-review badge: parity with the desktop user icon, so an admin
           sees there's moderation work without opening the menu (AECI-259). -->
      @if (showBadge()) {
        <span
          class="absolute -end-1 -top-1 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.625rem] font-bold leading-none text-(--surface-base) ring-2 ring-(--surface-base) bg-(--color-status-error)"
          aria-hidden="true"
          >{{ badgeText() }}</span
        >
        <span id="aec-nav-menu-pending" class="sr-only" i18n="@@admin.shell.nav.pendingCount"
          >{{ pending() }} reviews pending moderation</span
        >
      }
    </button>

    <brn-popover #menu="brnPopover" class="contents" align="start" [sideOffset]="8">
      <ng-template brnPopoverContent>
        <nav
          class="w-[min(92vw,18rem)] rounded-md border border-(--border-default) bg-(--surface-raised) p-2 text-(--text-primary) shadow-lg"
          i18n-aria-label="@@app.nav.primary.aria"
          aria-label="Primary"
        >
          <a
            routerLink="/"
            routerLinkActive="text-(--accent-primary)"
            [routerLinkActiveOptions]="{ exact: true }"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.home"
          >
            Home
          </a>
          <a
            routerLink="/products"
            routerLinkActive="text-(--accent-primary)"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.products"
          >
            Products
          </a>
          <!-- AECI-536: mailing-list signup destination for external links. -->
          <a
            routerLink="/updates"
            routerLinkActive="text-(--accent-primary)"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.updates"
          >
            Updates
          </a>

          @for (section of sections(); track section.kind) {
            <div>
              <button
                type="button"
                (click)="toggleSection(section.kind)"
                [attr.aria-expanded]="isOpen(section.kind)"
                [attr.aria-controls]="panelId(section.kind)"
                class="flex w-full cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <span>{{ section.label }}</span>
                <svg
                  aria-hidden="true"
                  class="h-4 w-4 transition-transform"
                  [class.rotate-180]="isOpen(section.kind)"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              @if (isOpen(section.kind)) {
                <div [id]="panelId(section.kind)" class="ps-2 pb-1">
                  <aec-nav-flyout-list
                    [items]="section.items"
                    [kind]="section.kind"
                    [viewAllLabel]="section.viewAll"
                    (navigate)="menu.close()"
                  />
                </div>
              }
            </div>
          }

          <aec-search-autocomplete
            class="mt-1 block px-1 pb-1"
            inputId="mobile-search"
            inputClass="w-full"
            (querySubmitted)="onSearchQuery($event); menu.close()"
            (suggestionChosen)="onSuggestion($event); menu.close()"
          />
          <div class="mt-1 flex flex-col gap-2 border-t border-(--border-default) px-1 pt-2">
            <!-- Neutral "Sign in" is the cache-safe SSR default; SessionStatus
                 swaps to the account block after hydration (Phase 5 §4.4), and
                 AdminStatus reveals the admin section/badge for admins (AECI-259). -->
            @if (session.signedIn()) {
              <a
                routerLink="/account"
                (click)="menu.close()"
                class="flex w-full items-center justify-center gap-2 rounded-md border border-(--border-strong) bg-(--surface-raised) px-4 py-2 text-sm font-medium text-(--text-primary) hover:border-(--accent-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@app.header.account"
              >
                <svg
                  aria-hidden="true"
                  class="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                Account
              </a>

              @if (adminStatus.isAdmin()) {
                <p
                  class="aec-overline px-3 pt-1 text-(--text-secondary)"
                  i18n="@@admin.shell.eyebrow"
                >
                  Admin
                </p>
                <a
                  routerLink="/admin/reviews"
                  (click)="menu.close()"
                  class="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                >
                  <span i18n="@@admin.shell.nav.reviews">Review queue</span>
                  @if (pending() > 0) {
                    <span class="text-(--text-secondary)" aria-hidden="true"
                      >({{ pending() }})</span
                    >
                  }
                </a>
                <a
                  routerLink="/admin/reviewers"
                  (click)="menu.close()"
                  class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@admin.shell.nav.reviewers"
                >
                  Reviewer bans
                </a>
              }

              <button
                type="button"
                (click)="onSignOut()"
                class="block w-full cursor-pointer rounded-md px-3 py-2 text-start text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@app.header.signOut"
              >
                Sign out
              </button>
              @if (signOutFailed()) {
                <p
                  class="px-3 text-xs text-(--color-status-error)"
                  i18n="@@app.header.signOut.failed"
                >
                  Couldn’t sign out. Try again.
                </p>
              }
            } @else {
              <a
                routerLink="/auth/login"
                (click)="menu.close()"
                class="flex w-full items-center justify-center rounded-md bg-(--accent-primary) px-4 py-2 text-sm font-medium text-(--surface-base) hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@app.header.signIn"
              >
                Sign in
              </a>
            }
          </div>
        </nav>
      </ng-template>
    </brn-popover>
  `,
})
export class NavMenu {
  private readonly taxonomy = inject(TaxonomyNavStore);
  protected readonly session = inject(SessionStatus);
  protected readonly adminStatus = inject(AdminStatus);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Live pending-review count (0 until the admin probe seeds the store). */
  protected readonly pending = computed(() => this.summaryStore.pendingReviews() ?? 0);

  /** The trigger badge shows only for an admin with pending reviews. */
  protected readonly showBadge = computed(() => this.adminStatus.isAdmin() && this.pending() > 0);

  /** Capped so the badge can't grow unbounded; the in-menu "(N)" stays exact. */
  protected readonly badgeText = computed(() =>
    this.pending() > 9 ? '9+' : String(this.pending()),
  );

  protected readonly signOutFailed = signal(false);

  protected async onSignOut(): Promise<void> {
    this.signOutFailed.set(false);
    const ok = await signOutAndGoHome(this.auth);
    if (!ok) this.signOutFailed.set(true);
  }

  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }

  protected readonly sections = computed(() => [
    {
      kind: 'category' as const,
      label: facetNavLabel('category'),
      viewAll: facetViewAllLabel('category'),
      items: this.taxonomy.categoriesTop10(),
    },
    {
      kind: 'audience' as const,
      label: facetNavLabel('audience'),
      viewAll: facetViewAllLabel('audience'),
      items: this.taxonomy.audiencesTop10(),
    },
    {
      kind: 'phase' as const,
      label: facetNavLabel('phase'),
      viewAll: facetViewAllLabel('phase'),
      items: this.taxonomy.phasesAll(),
    },
  ]);

  private readonly openSections = signal<ReadonlySet<TaxonomyKind>>(new Set());

  protected panelId(kind: TaxonomyKind): string {
    return `m-nav-flyout-${kind}`;
  }

  protected isOpen(kind: TaxonomyKind): boolean {
    return this.openSections().has(kind);
  }

  protected toggleSection(kind: TaxonomyKind): void {
    const next = new Set(this.openSections());
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    this.openSections.set(next);
  }
}
