import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { AEC_ICONS, type AecIconName, type IconShape } from './icon-registry';

/** Icon size as a Tailwind step: 4 is 16px, 5 is 20px, 6 is 24px. */
export type AecIconSize = 4 | 5 | 6;

// Whole class names, so Tailwind's scanner sees every one.
const SIZE_CLASS: Record<AecIconSize, string> = {
  4: 'h-4 w-4',
  5: 'h-5 w-5',
  6: 'h-6 w-6',
};

/**
 * `AecIcon` (AECI-1753) - the one icon component. Ruling 34 (ADR 0056): a custom
 * set at 1.75 stroke. The drawings live in `icon-registry.ts`.
 *
 * Decorative: `<aec-icon name="search" />`, hidden from assistive tech.
 * Meaningful: `<aec-icon name="alert-circle" label="Needs review" />`, announced
 * as an image with that name.
 *
 * ACCESSIBILITY
 * With no `label` the SVG is `aria-hidden="true"` and has no name. That is
 * correct whenever visible text beside the icon already says the same thing. When
 * the icon is the only carrier of meaning, pass `label` (already localised by
 * the caller): the SVG becomes `role="img"` with that accessible name. A blank
 * label counts as no label, so a meaningful icon can never render as an image
 * with an empty name. `focusable="false"` keeps legacy Edge from tabbing in.
 *
 * RENDERING
 * Shapes are real SVG elements built from data, so the server renders them and
 * nothing goes through `innerHTML`. Colour is `currentColor` and nothing else:
 * set it with a text colour class on the parent. The host is `display: contents`,
 * so a class on `<aec-icon>` does not reach the SVG. Use `size` and `mirrorRtl`.
 *
 * The registry is one object, so every icon ships whenever any icon is used. It
 * is plain data of a few KB, which is cheaper than a lazy-loaded chunk per icon.
 *
 * Light theme only.
 */
@Component({
  selector: 'aec-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [class]="svgClass()"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      focusable="false"
      [attr.aria-hidden]="accessibleName() ? null : 'true'"
      [attr.role]="accessibleName() ? 'img' : null"
      [attr.aria-label]="accessibleName()"
    >
      @for (shape of shapes(); track $index) {
        @if (shape.k === 'p') {
          <path [attr.d]="shape.d" />
        } @else if (shape.k === 'c') {
          <circle [attr.cx]="shape.cx" [attr.cy]="shape.cy" [attr.r]="shape.r" />
        } @else {
          <rect
            [attr.x]="shape.x"
            [attr.y]="shape.y"
            [attr.width]="shape.w"
            [attr.height]="shape.h"
            [attr.rx]="shape.rx"
          />
        }
      }
    </svg>
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class AecIcon {
  /** Which drawing. A name that is not in the registry fails to compile. */
  readonly name = input.required<AecIconName>();

  /** Tailwind size step. Default 5 (20px). */
  readonly size = input<AecIconSize>(5);

  /**
   * The accessible name, already localised. Omit it for a decorative icon.
   * Provide it when the icon carries meaning that nothing beside it states.
   */
  readonly label = input<string | undefined>(undefined);

  /**
   * Flip the drawing in right-to-left text. Set it for an icon that points along
   * the line, such as an arrow or a chevron.
   */
  readonly mirrorRtl = input(false);

  protected readonly accessibleName = computed(() => this.label()?.trim() || null);

  protected readonly shapes = computed<readonly IconShape[]>(() => AEC_ICONS[this.name()] ?? []);

  protected readonly svgClass = computed(() => {
    const size = SIZE_CLASS[this.size()];
    return `shrink-0 ${size}${this.mirrorRtl() ? ' rtl:-scale-x-100' : ''}`;
  });
}
