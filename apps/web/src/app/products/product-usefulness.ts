import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import type { ProductUsefulness } from '@aeci/shared';

/**
 * AECI-170 — the "How teams use it" section on the product detail page
 * (`/products/:slug`), rendered between the About and Integrations sections.
 *
 * Narrative value text grouped two ways — **By audience** and **By phase** —
 * from `ProductDetail.usefulness` (API_CONTRACTS §5.1, Phase 2 spec §7.2).
 *
 * Ships **inert**: `usefulness` is a typed `null` stub for every product until
 * the data pipeline lands (AECI-169), so the parent only mounts this component
 * via `@if (p.usefulness; as u)`. The `host [hidden]` binding handles the other
 * empty case — a non-null `usefulness` whose facets carry no usable points
 * (e.g. every group has zero `points`). `[hidden]` (preflight
 * `display:none !important`) collapses the host box entirely, so the parent's
 * `space-y-12` rhythm is undisturbed: a `display:none` element generates no box
 * and its margin is moot, leaving no extra gap behind.
 *
 * The host carries `class: 'block'` because a custom-element host defaults to
 * `display:inline`, and Tailwind v4's `space-y-12` puts `margin-block-end` on
 * `& > :not(:last-child)` — a block margin that inline boxes ignore. Without a
 * block host the populated section would lose its 3rem gap above the following
 * Integrations section (matches the `aec-*` host pattern, cf. logo-or-initial).
 *
 * Layout: two columns on `md+`; a single populated side goes full-width. Groups
 * with no points are dropped. Group names / points are data (interpolation, no
 * `innerHTML`); only the static labels are i18n-wrapped. Body text uses
 * `--text-secondary` (never `--text-tertiary` — fails WCAG AA, AECI-166/149).
 * Heading order is `h2` (section) → `h3` (column) → `<dl>` (group).
 */
@Component({
  selector: 'aec-product-usefulness',
  imports: [NgTemplateOutlet],
  host: { class: 'block', '[hidden]': '!hasContent()' },
  template: `
    @if (hasContent()) {
      <section aria-labelledby="usefulness-title" class="space-y-4">
        <h2
          id="usefulness-title"
          class="font-display text-2xl font-semibold text-(--text-primary)"
          i18n="@@products.detail.body.usefulness"
        >
          How teams use it
        </h2>

        <ng-template #groupList let-groups>
          @for (group of groups; track group.slug) {
            <dl class="space-y-1">
              <dt class="font-bold text-(--text-primary)">{{ group.name }}</dt>
              <dd>
                <ul class="list-disc space-y-1 ps-5">
                  @for (point of group.points; track $index) {
                    <li class="text-(--text-secondary) leading-relaxed">{{ point }}</li>
                  }
                </ul>
              </dd>
            </dl>
          }
        </ng-template>

        <div [class]="gridClass()">
          @if (audienceGroups().length > 0) {
            <div class="space-y-4">
              <h3
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.usefulness.byAudience"
              >
                By audience
              </h3>
              <ng-container
                [ngTemplateOutlet]="groupList"
                [ngTemplateOutletContext]="{ $implicit: audienceGroups() }"
              ></ng-container>
            </div>
          }
          @if (phaseGroups().length > 0) {
            <div class="space-y-4">
              <h3
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.usefulness.byPhase"
              >
                By phase
              </h3>
              <ng-container
                [ngTemplateOutlet]="groupList"
                [ngTemplateOutletContext]="{ $implicit: phaseGroups() }"
              ></ng-container>
            </div>
          }
        </div>
      </section>
    }
  `,
})
export class ProductUsefulnessSection {
  readonly data = input.required<ProductUsefulness>();

  protected readonly audienceGroups = computed(() =>
    this.data().audiences.filter((g) => g.points.length > 0),
  );
  protected readonly phaseGroups = computed(() =>
    this.data().phases.filter((g) => g.points.length > 0),
  );
  protected readonly hasContent = computed(
    () => this.audienceGroups().length > 0 || this.phaseGroups().length > 0,
  );
  protected readonly twoColumns = computed(
    () => this.audienceGroups().length > 0 && this.phaseGroups().length > 0,
  );

  /** Single column unless both facets are populated. */
  protected readonly gridClass = computed(() =>
    this.twoColumns() ? 'grid gap-8 md:grid-cols-2' : 'grid gap-8',
  );
}
