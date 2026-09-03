import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { NavDisclosure } from './nav-disclosure';
import { NavFlyoutList } from './nav-flyout-list';
import { facetNavLabel, facetViewAllLabel } from './taxonomy-nav-copy';

/**
 * One taxonomy entry in the desktop primary nav (AECI-158): a clean text link
 * that navigates to the facet index and reveals the top-N value flyout
 * (`NavFlyoutList`) on hover/keyboard interaction, styled in the clean editorial
 * convention of Yahoo Finance navigation without separate arrow buttons that
 * cause spacing issues. Used at `lg+` in `site-header.ts`.
 *
 * The single link navigates on click and discloses on hover/keyboard. The link
 * carries `aria-expanded` / `aria-controls` / `aria-haspopup`; the panel is
 * `[hidden]` when closed so its links are never silently tabbable. Pressing
 * ArrowDown opens the flyout and focuses the first value link; Escape closes
 * and returns focus to this link.
 *
 * Open/close behaviour (hover, Escape, focusout) comes from the shared
 * `NavDisclosure` base.
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
  // Hover / focusout / Escape listeners are inherited from `NavDisclosure`.
  host: { class: 'relative inline-flex items-center' },
  template: `
    <a
      [routerLink]="indexPath()"
      routerLinkActive="text-(--accent-primary)"
      [class.text-(--accent-primary)]="isOpen()"
      [attr.aria-expanded]="isOpen()"
      [attr.aria-controls]="panelId()"
      aria-haspopup="true"
      (click)="close()"
      (keydown.arrowdown)="onArrowDown($event)"
      class="cursor-pointer text-(--text-primary) transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >{{ label() }}</a
    >

    <div [id]="panelId()" [hidden]="!isOpen()" class="absolute top-full start-0 z-50 pt-2">
      <div
        class="w-64 rounded-md border border-(--border-default) bg-(--surface-raised) p-2 shadow-lg"
      >
        <aec-nav-flyout-list
          [items]="items()"
          [kind]="kind()"
          [viewAllLabel]="viewAllLabel()"
          (navigate)="close()"
        />
      </div>
    </div>
  `,
})
export class NavFlyoutTrigger extends NavDisclosure {
  readonly kind = input.required<TaxonomyKind>();
  readonly items = input.required<readonly TaxonomyTermWithCount[]>();

  protected readonly indexPath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);
  protected readonly panelId = computed(() => `nav-flyout-${this.kind()}`);

  /** Top-level label (also the index link text). */
  protected readonly label = computed(() => facetNavLabel(this.kind()));

  /** "View all <facet>" footer link in the flyout. */
  protected readonly viewAllLabel = computed(() => facetViewAllLabel(this.kind()));

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /**
   * ArrowDown opens the panel and moves focus to its first value link.
   *
   * The focus has to wait for the render that clears `[hidden]`: zoneless change
   * detection is scheduled on a macrotask (`setTimeout`/`requestAnimationFrame`),
   * so a microtask would still find a `display: none` panel and `focus()` would
   * be a silent no-op. `afterNextRender` also notifies the scheduler, so the pass
   * happens even when the panel was already open from hover.
   */
  protected onArrowDown(event: Event): void {
    event.preventDefault();
    this.open();
    afterNextRender(
      () => {
        const panel = this.host.nativeElement.querySelector<HTMLElement>(`#${this.panelId()}`);
        panel?.querySelector<HTMLAnchorElement>('a')?.focus();
      },
      { injector: this.injector },
    );
  }
}
