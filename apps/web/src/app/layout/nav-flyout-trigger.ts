import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { NavFlyoutList } from './nav-flyout-list';
import { facetNavLabel, facetViewAllLabel } from './taxonomy-nav-copy';

/**
 * One taxonomy entry in the desktop primary nav (AECI-158): a label that links
 * to the facet index, plus an adjacent disclosure button that reveals the
 * top-N value flyout (`NavFlyoutList`). Used at `md+` in `site-header.ts`.
 *
 * Two distinct controls by design — the link navigates, the button discloses —
 * so the semantics stay unambiguous for assistive tech (a link that also owns a
 * popup is muddy). The disclosure carries `aria-expanded` / `aria-controls` /
 * `aria-haspopup`; the panel is `[hidden]` when closed so its links are never
 * silently tabbable.
 *
 * Open/close:
 *   - pointer: hover the host opens, leaving closes (the panel's transparent
 *     `pt-2` bridge keeps the trigger→panel path inside the host, so there is no
 *     dead gap to fall through);
 *   - keyboard: the button toggles (native Enter/Space), Escape closes and
 *     returns focus to the button, and focus leaving the host closes.
 *
 * i18n lives here, keyed by `kind` via `$localize` switches (the same pattern
 * `TaxonomyBrowsePage` uses for its breadcrumb labels), so the parent passes
 * only `kind` + `items`. The flyout *values* are client-only (the store is
 * browser-gated), so on the server this renders just the SSR-crawlable index
 * link + an empty, hidden panel — no visitor state reaches cached HTML.
 */
@Component({
  selector: 'aec-nav-flyout-trigger',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, NavFlyoutList],
  host: {
    class: 'relative inline-flex items-center',
    '(mouseenter)': 'open()',
    '(mouseleave)': 'close()',
    '(focusout)': 'onFocusOut($event)',
    '(keydown.escape)': 'onEscape($event)',
  },
  template: `
    <a
      [routerLink]="indexPath()"
      routerLinkActive="text-(--accent-primary)"
      class="text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >{{ label() }}</a
    >
    <button
      type="button"
      class="ms-1 inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-(--radius-sm) text-(--text-secondary) transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      [attr.aria-expanded]="isOpen()"
      [attr.aria-controls]="panelId()"
      aria-haspopup="true"
      [attr.aria-label]="triggerAria()"
      (click)="toggle()"
    >
      <svg
        aria-hidden="true"
        class="h-4 w-4 transition-transform"
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
    </button>

    <div [id]="panelId()" [hidden]="!isOpen()" class="absolute top-full start-0 z-50 pt-2">
      <div
        class="w-64 rounded-md border border-(--border-default) bg-(--surface-raised) p-2 shadow-lg"
      >
        <aec-nav-flyout-list [items]="items()" [kind]="kind()" [viewAllLabel]="viewAllLabel()" />
      </div>
    </div>
  `,
})
export class NavFlyoutTrigger {
  readonly kind = input.required<TaxonomyKind>();
  readonly items = input.required<readonly TaxonomyTermWithCount[]>();

  protected readonly indexPath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);
  protected readonly panelId = computed(() => `nav-flyout-${this.kind()}`);

  /** Top-level label (also the index link text). */
  protected readonly label = computed(() => facetNavLabel(this.kind()));

  /** "View all <facet>" footer link in the flyout. */
  protected readonly viewAllLabel = computed(() => facetViewAllLabel(this.kind()));

  /** Accessible name for the disclosure button. */
  protected readonly triggerAria = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@app.nav.flyout.categories.aria:Categories menu`;
      case 'audience':
        return $localize`:@@app.nav.flyout.audiences.aria:Audiences menu`;
      case 'phase':
        return $localize`:@@app.nav.flyout.phases.aria:Phases menu`;
    }
  });

  private readonly openSig = signal(false);
  protected readonly isOpen = this.openSig.asReadonly();

  protected open(): void {
    this.openSig.set(true);
  }

  protected close(): void {
    this.openSig.set(false);
  }

  protected toggle(): void {
    this.openSig.update((v) => !v);
  }

  /** Close when focus leaves the host entirely (e.g. Tab past the last link). */
  protected onFocusOut(event: FocusEvent): void {
    const host = event.currentTarget as HTMLElement;
    if (!host.contains(event.relatedTarget as Node | null)) this.close();
  }

  /** Escape closes the flyout and returns focus to the disclosure button. */
  protected onEscape(event: Event): void {
    if (!this.isOpen()) return;
    this.close();
    const host = event.currentTarget as HTMLElement;
    host.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();
  }
}
