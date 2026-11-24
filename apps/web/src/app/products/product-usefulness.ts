import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ProductUsefulness } from '@aeci/shared';

import { AecCard } from '../shared/card/card';
import { AecIcon } from '../shared/icon/icon';

/**
 * AECI-170 — the "How teams use it" section on the product detail page
 * (`/products/:slug`), rendered between the About and Integrations sections.
 *
 * Narrative value text grouped two ways — **By audience** and **By phase** —
 * from `ProductDetail.usefulness` (API_CONTRACTS §5.1, Phase 2 spec §7.2).
 *
 * `usefulness` is `null` for any product nobody has written one for, so the
 * parent only mounts this component via `@if (p.usefulness; as u)`. Two writers
 * fill it: promote, since AECI-172, and — since AECI-963 — the vendor, in the
 * portal. The `host [hidden]` binding handles the other empty case — a non-null
 * `usefulness` whose facets carry no usable points (e.g. every group has zero
 * `points`). `[hidden]` (preflight `display:none !important`) collapses the host
 * box entirely, so the parent's `space-y-12` rhythm is undisturbed.
 *
 * The host carries `class: 'block'` because a custom-element host defaults to
 * `display:inline`, and Tailwind v4's `space-y-12` puts `margin-block-end` on
 * `& > :not(:last-child)` — a block margin that inline boxes ignore.
 *
 * **Group names are taxonomy labels, not free text**, whichever writer filled
 * them: both resolve the canonical `{ slug, name }` from the taxonomy row, and
 * the vendor wire shape cannot carry a `name` at all. That is what makes it safe
 * to interpolate one here as a `<dt>` (ADR 0033).
 *
 * **Vendor-written copy is attributed in the page's provenance panel** (AECI-1666; it sat
 * under this section from AECI-1614 until then). "How teams use it: Maintained by
 * {vendor} · updated {date}" is in "About this listing", so a reader never takes the
 * vendor's own words for AECi's (STAGE_2_5_SPEC.md §12.1, ADR 0033).
 *
 * Order is the API's: audiences alphabetical, phases in lifecycle order, points
 * as the writer chose them (`apps/api/src/lib/usefulness-order.ts`). This
 * component never re-sorts.
 *
 * **Layout (AECI-1780, mock-up 6 `.use-row`).** One row per facet: "By audience", then
 * "By phase". Each group is a white card (`aecCard`) holding its name and its points,
 * each point after a Forest tick. The facet label is a small heading above its cards at
 * every width, so the cards get the full row (2026-11-24: the 170px side column left a
 * blank strip and squeezed the cards). Cards run three across from `lg`, two from `md`
 * and one below, never more columns than the facet has cards, so one or two groups fill
 * the row. A facet with no usable points is not rendered, and neither is a group
 * with no points. Group names and points are data (interpolation, no `innerHTML`). Only
 * the static labels are i18n-wrapped. Points use `--text-primary`. Heading order is `h2`
 * (section), then `h3` (facet), then a `<dl>` per group.
 */
@Component({
  selector: 'aec-product-usefulness',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecCard, AecIcon, NgTemplateOutlet],
  host: { class: 'block', '[hidden]': '!hasContent()' },
  template: `
    @if (hasContent()) {
      <section aria-labelledby="usefulness-title" class="space-y-8">
        <!-- Mock-up 6 band head (AECI-1720 restore): the small label and "How teams use
             {product}". The mock-up's intro line is not built: it can read as a claim about
             who wrote the section, which "About this listing" contradicts. The label repeats the
             heading, so it is hidden from assistive technology. -->
        <div>
          <p
            aria-hidden="true"
            class="aec-overline mb-3 text-(--text-secondary)"
            i18n="@@products.detail.usefulness.kicker"
          >
            How teams use it
          </p>
          <h2 id="usefulness-title">
            <span
              class="font-display text-t-36 leading-[1.1] font-semibold tracking-[-0.02em] text-(--text-primary)"
              i18n="@@products.detail.usefulness.heading"
              >How teams use {{ productName() }}</span
            >
          </h2>
        </div>

        <ng-template #groupList let-groups>
          <div [class]="cardGridClass(groups.length)" data-testid="usefulness-cards">
            @for (group of groups; track group.slug) {
              <dl aecCard class="m-0 space-y-3 p-6" data-testid="usefulness-group">
                <dt class="font-display text-t-20 font-semibold text-(--text-primary)">
                  {{ group.name }}
                </dt>
                <dd class="m-0">
                  <!-- role="list": Safari drops list semantics from a list-none list. -->
                  <ul class="m-0 grid list-none gap-3 p-0" role="list">
                    @for (point of group.points; track $index) {
                      <li class="flex gap-2 text-t-16 leading-normal text-(--text-primary)">
                        <aec-icon
                          name="check"
                          decorative
                          [size]="4"
                          class="mt-1 shrink-0 text-(--accent-primary)"
                        />
                        <span class="min-w-0">{{ point }}</span>
                      </li>
                    }
                  </ul>
                </dd>
              </dl>
            }
          </div>
        </ng-template>

        @if (audienceGroups().length > 0) {
          <div [class]="rowClass" data-testid="usefulness-row">
            <h3 [class]="labelClass">
              <aec-icon name="users" decorative [size]="5" class="text-(--accent-primary)" />
              <span
                class="font-display text-t-20 font-semibold"
                i18n="@@products.detail.usefulness.byAudience"
                >By audience</span
              >
            </h3>
            <ng-container
              [ngTemplateOutlet]="groupList"
              [ngTemplateOutletContext]="{ $implicit: audienceGroups() }"
            ></ng-container>
          </div>
        }
        @if (phaseGroups().length > 0) {
          <div [class]="rowClass" data-testid="usefulness-row">
            <h3 [class]="labelClass">
              <aec-icon name="gantt" decorative [size]="5" class="text-(--accent-primary)" />
              <span
                class="font-display text-t-20 font-semibold"
                i18n="@@products.detail.usefulness.byPhase"
                >By phase</span
              >
            </h3>
            <ng-container
              [ngTemplateOutlet]="groupList"
              [ngTemplateOutletContext]="{ $implicit: phaseGroups() }"
            ></ng-container>
          </div>
        }
      </section>
    }
  `,
})
export class ProductUsefulnessSection {
  readonly data = input.required<ProductUsefulness>();
  /** The page product's name, for the heading "How teams use {product}" (AECI-1720). */
  readonly productName = input.required<string>();

  /** One facet's row: the label above its cards at every width, so the cards get the full row. */
  protected readonly rowClass = 'grid gap-4';

  /** The facet label: glyph and serif name in a row, above the cards. */
  protected readonly labelClass = 'm-0 flex items-center gap-2 text-(--text-primary)';

  /**
   * The card grid for one facet. Never more columns than cards, so one or two groups
   * fill the row instead of leaving empty columns beside them.
   */
  protected cardGridClass(count: number): string {
    const base = 'grid gap-4 md:gap-6';
    if (count <= 1) return base;
    if (count === 2) return `${base} md:grid-cols-2`;
    return `${base} md:grid-cols-2 lg:grid-cols-3`;
  }

  protected readonly audienceGroups = computed(() =>
    this.data().audiences.filter((g) => g.points.length > 0),
  );
  protected readonly phaseGroups = computed(() =>
    this.data().phases.filter((g) => g.points.length > 0),
  );
  protected readonly hasContent = computed(
    () => this.audienceGroups().length > 0 || this.phaseGroups().length > 0,
  );
}
