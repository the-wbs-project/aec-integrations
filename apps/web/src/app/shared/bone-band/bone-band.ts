import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  booleanAttribute,
  inject,
  input,
  isDevMode,
} from '@angular/core';

/**
 * AECI-1766 - the one Bone band of a page (DESIGN.md §2 "Bone: one band per
 * page", §4 "The detail page band shell", clash 2, ADR 0056). A frame, not a
 * page: it paints the ground, holds the page wrap and sets the band rhythm. The
 * caller owns every word. Content is projected, with no named slots.
 *
 * Wrap and rhythm are the mock-up's (mock-ups 6 to 8, `.band`): the 1328px wrap
 * with 24, 32 and 48px gutters, and 96px of padding above and below, 64px below
 * `md`. `first` is the mock-up's `.band.first`: 48px above (32px below `md`) for
 * the first band under the section nav.
 *
 * The ground is `--accent-warm`. Ink on it: `--text-primary` 17.70:1,
 * `--text-secondary` 6.91:1, Forest 11.03:1. `--text-tertiary` is 4.32:1 and is
 * never used on Bone. A control's edge is `--border-field` (3.31:1). The default
 * Forest focus ring is 11.03:1 and needs no override. Do not use
 * `--surface-on-brand-hover` here: it is the hover of the Bone button on Forest.
 *
 * The band does not move on load and reads nothing about the visitor, so cached
 * SSR HTML is identical for every visitor. Forced colours drops the fill, so
 * `styles.css` (`.aec-bone-band`) gives it a system-colour edge above and below.
 *
 * "One per page" is a usage rule. In dev mode, a second `aec-bone-band` in the
 * document logs an error after the first browser render. Production never logs.
 */
@Component({
  selector: 'aec-bone-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="aec-bone-band bg-(--accent-warm) text-(--text-primary)">
      <div
        class="mx-auto w-full max-w-[1328px] px-6 pb-16 md:px-8 md:pb-24 lg:px-12"
        [class]="first() ? 'pt-8 md:pt-12' : 'pt-16 md:pt-24'"
      >
        <ng-content />
      </div>
    </div>
  `,
})
export class BoneBand {
  /** The first band under the section nav: 48px above, 32px below `md`. */
  readonly first = input(false, { transform: booleanAttribute });

  private readonly doc = inject(DOCUMENT);

  constructor() {
    if (isDevMode()) {
      // Browser only: `afterNextRender` never runs on the server.
      afterNextRender(() => {
        const count = this.doc.querySelectorAll('aec-bone-band').length;
        if (count > 1) {
          console.error(
            `DESIGN.md §2: one Bone band per page, found ${count} <aec-bone-band> elements.`,
          );
        }
      });
    }
  }
}
