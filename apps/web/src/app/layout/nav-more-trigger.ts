import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { AdminStatus } from '../admin/admin-status';
import { ADMIN_NAV_GROUPS } from '../admin/admin-nav';
import { AdminSummaryStore } from '../admin/admin-summary.store';

import { moreSiteGroups, moreTriggerAria, moreTriggerLabel } from './more-menu-links';
import { NavDisclosure } from './nav-disclosure';
import { NavMoreList } from './nav-more-list';

/**
 * The "More" overflow entry in the desktop primary nav — the last item in the
 * row, holding every destination that isn't a primary directory surface:
 * Updates · Roadmap · About · Contact, the Legal group, and (for an admin) the
 * full nine-screen `/admin` section.
 *
 * Unlike `NavFlyoutTrigger` this is a **button-only** trigger: there is no
 * `/more` page to link to, so the label itself is the disclosure. Open/close
 * behaviour is the shared `NavDisclosure` contract (hover, Escape, focusout), so
 * it matches the four taxonomy flyouts beside it.
 *
 * The panel is anchored `end-0` — it is the last item in the centered nav row
 * and the admin variant is two columns wide, so a `start-0` panel would run off
 * the right edge at `lg`.
 *
 * **Cache-neutral.** `AdminStatus.isAdmin()` is `false` during SSR / pre-hydration
 * (§8), so the server renders only the public groups — no admin path ever reaches
 * cached HTML. Those public links DO render server-side (the panel is `[hidden]`,
 * not unmounted), which keeps `/updates`, `/roadmap`, `/about`, `/contact`, and
 * `/legal/*` crawlable from the header.
 *
 * The red pending-review badge lives here (it moved off the account menu with
 * the admin links): an admin sees there is moderation work without opening the
 * menu, and the exact count renders beside "Review queue" inside.
 */
@Component({
  selector: 'aec-nav-more-trigger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Hover / focusout / Escape listeners are inherited from `NavDisclosure`.
  host: { class: 'relative inline-flex items-center' },
  imports: [NavMoreList],
  template: `
    <button
      type="button"
      class="relative inline-flex cursor-pointer items-center gap-1 rounded-(--radius-sm) whitespace-nowrap text-(--text-primary) transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      [attr.aria-expanded]="isOpen()"
      aria-controls="nav-more-panel"
      aria-haspopup="true"
      [attr.aria-label]="triggerAria()"
      [attr.aria-describedby]="showBadge() ? 'aec-nav-more-pending' : null"
      (click)="toggle()"
    >
      {{ label() }}
      <!-- shrink-0: the trigger is a flex item in a width-budgeted row, and
           without it the chevron is the first thing squashed (it renders as a
           half-drawn glyph). -->
      <svg
        aria-hidden="true"
        class="h-4 w-4 shrink-0 transition-transform"
        [class.rotate-180]="isOpen()"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
      @if (showBadge()) {
        <span
          class="absolute -end-2 -top-2 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.625rem] font-bold leading-none text-(--surface-base) ring-2 ring-(--surface-base) bg-(--color-status-error)"
          aria-hidden="true"
          >{{ badgeText() }}</span
        >
        <span id="aec-nav-more-pending" class="sr-only" i18n="@@admin.shell.nav.pendingCount"
          >{{ pending() }} reviews pending moderation</span
        >
      }
    </button>

    <div id="nav-more-panel" [hidden]="!isOpen()" class="absolute top-full end-0 z-50 pt-2">
      <div [class]="panelClass()">
        <div>
          <aec-nav-more-list [groups]="siteGroups" />
        </div>
        @if (adminStatus.isAdmin()) {
          <div class="border-s border-(--border-default) ps-2">
            <!-- Column title, deliberately NOT an overline: the groups beneath it
                 are overlines, and two stacked overlines read as one flat level.
                 Sentence-case label per the Sentence-Case Rule. -->
            <p
              class="px-3 pt-2 pb-1 text-sm font-semibold text-(--text-primary)"
              i18n="@@admin.shell.eyebrow"
            >
              Admin
            </p>
            <aec-nav-more-list [groups]="adminGroups" [pendingCount]="pending()" />
          </div>
        }
      </div>
    </div>
  `,
})
export class NavMoreTrigger extends NavDisclosure {
  protected readonly adminStatus = inject(AdminStatus);
  private readonly summaryStore = inject(AdminSummaryStore);

  protected readonly siteGroups = moreSiteGroups();
  protected readonly adminGroups = ADMIN_NAV_GROUPS;

  protected readonly label = computed(() => moreTriggerLabel());
  protected readonly triggerAria = computed(() => moreTriggerAria());

  /**
   * One column for a visitor (and every SSR render); two for an admin, so the
   * seventeen-entry menu doesn't run past the bottom of a short laptop viewport.
   * Built as one string rather than a static `class` plus a binding so there's
   * no static/bound merge order to reason about.
   */
  protected readonly panelClass = computed(() => {
    const base = 'rounded-md border border-(--border-default) bg-(--surface-raised) p-2 shadow-lg';
    return this.adminStatus.isAdmin()
      ? `${base} grid w-[34rem] grid-cols-2 items-start gap-x-4`
      : `${base} w-56`;
  });

  /** Live pending-review count (0 until the admin probe seeds the store). */
  protected readonly pending = computed(() => this.summaryStore.pendingReviews() ?? 0);

  /** The badge shows only for an admin with pending reviews. */
  protected readonly showBadge = computed(() => this.adminStatus.isAdmin() && this.pending() > 0);

  /** Capped so the badge can't grow unbounded; the in-menu "(N)" stays exact. */
  protected readonly badgeText = computed(() =>
    this.pending() > 9 ? '9+' : String(this.pending()),
  );
}
