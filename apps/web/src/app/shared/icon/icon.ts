import { Component, booleanAttribute, computed, effect, input, isDevMode } from '@angular/core';

import { AEC_ICONS, type AecIconName, type IconShape } from './icon-registry';

/** Icon size as a Tailwind step: 3.5 is 14px, 4 is 16px, 5 is 20px, 6 is 24px. */
export type AecIconSize = 3.5 | 4 | 5 | 6;

// Whole class names, so Tailwind's scanner sees every one.
const SIZE_CLASS: Record<AecIconSize, string> = {
  3.5: 'h-3.5 w-3.5',
  4: 'h-4 w-4',
  5: 'h-5 w-5',
  6: 'h-6 w-6',
};

/**
 * `AecIcon` (AECI-1753) - the one icon component. Ruling 34 (ADR 0056): a custom
 * set at 1.75 stroke. The drawings live in `icon-registry.ts`.
 *
 * Every use states its intent, and the compiler checks it. The selector is
 * `aec-icon[label], aec-icon[decorative]`, so an `<aec-icon>` with neither fails
 * with NG8001 and a nameless icon button cannot be written by accident.
 *
 * Decorative: `<aec-icon name="search" decorative />`, hidden from assistive tech.
 * Meaningful: `<aec-icon name="alert-circle" label="Needs review" />` or
 * `[label]="text"`, announced as an image with that name.
 *
 * ACCESSIBILITY
 * `decorative` makes the SVG `aria-hidden="true"` with no name. Use it whenever
 * visible text beside the icon says the same thing, and for an icon inside a
 * control that has its own name. `label` (already localised by the caller)
 * makes the SVG `role="img"` with that accessible name. A blank bound label
 * falls back to decorative so the page never carries an image with an empty
 * name, and warns in dev mode so the bug is seen. `decorative` wins if both are
 * given. `focusable="false"` keeps legacy Edge from tabbing in.
 *
 * RENDERING
 * Shapes are real SVG elements built from data, so the server renders them and
 * nothing goes through `innerHTML`. Colour is `currentColor` and nothing else:
 * set it with a text colour class on the parent. The host is `display: contents`,
 * so size and margin classes on `<aec-icon>` do not apply, while inherited
 * properties such as `color` do. Use `size` and `mirrorRtl`, and put spacing on
 * a wrapper.
 *
 * The registry is one object, so every icon ships whenever any icon is used. It
 * is plain data of a few KB, which is cheaper than a lazy-loaded chunk per icon.
 *
 * Light theme only.
 */
@Component({
  selector: 'aec-icon[label], aec-icon[decorative]',
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

  /** Tailwind size step: 3.5, 4, 5 or 6. Default 5 (20px). */
  readonly size = input<AecIconSize>(5);

  /**
   * The accessible name, already localised. Give it when the icon carries meaning
   * that nothing beside it states. Use `decorative` instead when it does not.
   */
  readonly label = input<string | null | undefined>(undefined);

  /**
   * Marks the icon as decoration. Write it as a bare attribute: `decorative`.
   */
  readonly decorative = input(false, { transform: booleanAttribute });

  /**
   * Flip the drawing in right-to-left text. Set it for an icon that points along
   * the line, such as an arrow or a chevron.
   */
  readonly mirrorRtl = input(false);

  protected readonly accessibleName = computed(() =>
    this.decorative() ? null : this.label()?.trim() || null,
  );

  constructor() {
    // A bound label that resolves blank is a bug in the caller. Say so in dev.
    // Never in production: the icon degrades to decorative instead.
    effect(() => {
      if (isDevMode() && !this.decorative() && !this.accessibleName()) {
        console.warn(
          `aec-icon "${this.name()}" has a blank label and renders as decorative. ` +
            'Pass a label, or use the decorative attribute.',
        );
      }
    });
  }

  protected readonly shapes = computed<readonly IconShape[]>(() => AEC_ICONS[this.name()] ?? []);

  protected readonly svgClass = computed(() => {
    const size = SIZE_CLASS[this.size()];
    return `shrink-0 ${size}${this.mirrorRtl() ? ' rtl:-scale-x-100' : ''}`;
  });
}
