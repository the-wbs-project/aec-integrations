import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  ContextDirection,
  IntegrationMechanismKind,
  ProductIntegrationItem,
  ProductLink,
} from '@aeci/shared';

import { contextDirectionLabel, mechanismKindLabel } from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * Row representation of one of a product's integrations, slotted into the
 * integrations `<table>` on the product-detail page (`product-detail.ts`).
 * Replaces the former stack of bordered "{integration name} · with {partner}"
 * cards (hard to scan, and an invalid `<a>`-inside-`<a>`) with a real,
 * column-aligned table row.
 *
 * Uses an attribute selector on `<tr>` so the rendered markup is a valid `<tr>`
 * child of `<tbody>` — a custom element directly inside `<tbody>` is
 * foster-parented out by the browser's HTML tree builder (same pattern as
 * `ProductCard` / `IntegrationCard` / Angular CDK's `tr[cdk-row]`).
 *
 * Two columns + a trailing affordance:
 *   1. **Integrates with** — the *other* product (monogram via `LogoOrInitial` +
 *      a name link to that product's page), over a muted meta line carrying the
 *      **direction** at every width and, below `md`, the mechanism as well.
 *   2. **Connection** — the `mechanism_kind` badge (shared `mechanismKindLabel()`)
 *      plus the optional `mechanism_name`. Hidden below `md`, where it folds into
 *      the meta line above. `–` when absent.
 *
 * **Direction used to be its own leading column, and AECI-853 folded it into the
 * meta line.** The trade is measured, not aesthetic. That column's intrinsic
 * width was 121px — 32px padding, a 20px decorative glyph, an 8px gap, and only
 * 61px of actual label — and it was the difference between a table that needs
 * 44rem and one that needs 34rem. 34rem fits the 608px body column at `lg`, so
 * removing it is what let `DetailLayout` dock the metadata sidebar at 1024px
 * instead of 1280px (see the grid comment in `layouts/detail-layout.ts`). It is
 * close to free vertically: rows carrying a `mechanism_name` are already two
 * lines tall because the Connection cell stacks badge over name, so the meta
 * line costs 0px there and 6px on badge-only rows.
 *
 * This **reverses** §13.3's "direction leads the row so the relationship reads
 * at a glance" and its "Direction / Integrates with / Connection columns" list;
 * both carry the dated amendment. What did NOT change: the value is still the
 * server-precomputed, claims-aware `context_direction` (`STAGE_1_5_SPEC.md`
 * §3.2), so it still cannot contradict the pair page, and `–` still means
 * unknown (no claims, no stored direction).
 *
 * The meta line opens with an `sr-only` "Direction:" prefix. Removing the `<th>`
 * removed the only thing that told a screen reader what "Outbound" was a
 * property OF; without the prefix it reads as a bare word trailing the partner
 * name. The mechanism half needs no such prefix — it only appears below `md`,
 * where it sits beside a direction that is already labelled.
 *
 * Row click → the product-PAIR page `/products/:contextSlug/integrations/:other`
 * (context = *this* page's product, so the direction stays context-relative). To
 * keep the whole row clickable *and* still expose a distinct link to the partner
 * product without nesting `<a>`s, it uses the accessible stretched-link pattern:
 * the pair-page link is an `absolute inset-0` overlay against the `relative`
 * `<tr>` host, and the partner-product link sits on top (`relative z-10`) so its
 * own activation wins. Two sibling links, zero nesting.
 */
@Component({
  // Attribute selector so the rendered DOM is a literal `<tr>` (see class doc).
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-product-integration-row]',
  imports: [RouterLink, LogoOrInitial],
  host: {
    // `relative` anchors the stretched pair-page overlay to the whole row.
    // `group` lets the meta line under the partner name step tertiary→secondary
    // when the row fill goes muted on hover / focus-within.
    class:
      'group relative text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <!-- No "relative" on this cell: the pair-page overlay below must anchor to
         the relative <tr> host (see class doc), not this cell, so it spans the
         whole row. A relative <td> would intercept inset-0 (as the nearest
         positioned ancestor) and shrink the click target to this cell alone. -->
    <td class="px-4 py-3 font-medium">
      <span class="flex items-center gap-3">
        <aec-logo-or-initial [src]="other().logo_url" [name]="other().name" size="sm" />
        <span class="flex min-w-0 flex-col">
          <!-- Secondary link to the partner product page. relative + z-10 lifts
               it above the stretched row overlay so its own click wins. -->
          <a
            [routerLink]="['/products', other().slug]"
            class="relative z-10 w-fit rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >{{ other().name }}</a
          >
          <!-- The meta line under the partner name. Direction lives here at
               every width (AECI-853); the mechanism joins it only below md,
               where the Connection <td> is hidden. Tertiary at rest (4.83:1 on
               white); group-hover / group-focus-within step it to secondary
               once the row fill goes muted (DESIGN.md §"Tertiary": never on
               muted). -->
          <span
            class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-(--text-tertiary) transition-colors group-hover:text-(--text-secondary) group-focus-within:text-(--text-secondary)"
          >
            <!-- Direction, context-relative to THIS page's product and
                 precomputed server-side (claims-aware, §3.2), so it can never
                 contradict the pair page. The sr-only prefix replaces the
                 accessible name the removed Direction <th> used to supply;
                 without it "Outbound" reads as a bare word beside the partner
                 name. The glyph stays accent-coloured: it is the one visual
                 cue left now that the column is gone. -->
            <span class="inline-flex items-center gap-1">
              <span class="sr-only" i18n="@@products.detail.integrations.direction.srLabel"
                >Direction:</span
              >
              @if (direction().token) {
                <span
                  class="inline-block leading-none text-(--accent-primary) rtl:-scale-x-100"
                  aria-hidden="true"
                  >{{ direction().glyph }}</span
                >
                <span>{{ direction().label }}</span>
              } @else {
                <span
                  i18n="@@products.detail.integrations.direction.none"
                  i18n-aria-label="@@products.detail.integrations.direction.none.aria"
                  aria-label="Direction not listed"
                  >–</span
                >
              }
            </span>
            <!-- Below md the Connection <td> is hidden, so the mechanism joins
                 this same line rather than stacking a second sublabel. The
                 separator is carried with it so it cannot orphan. -->
            @if (mechanismSublabel(); as label) {
              <span class="md:hidden" aria-hidden="true">·</span>
              <span class="md:hidden">{{ label }}</span>
            }
          </span>
        </span>
      </span>
      <!-- Stretched overlay: the whole row navigates to the product-PAIR page.
           Absolute against the relative tr host, so it covers every cell;
           kept below the partner link (which is z-10) so that link stays live. -->
      <a
        [routerLink]="pairLink()"
        [attr.aria-label]="pairAriaLabel()"
        class="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
      ></a>
    </td>
    <td class="hidden px-4 py-3 text-(--text-secondary) md:table-cell">
      <span class="flex flex-col items-start gap-1">
        @if (mechanismKindLabels().length > 0) {
          <span class="flex flex-wrap items-center gap-1">
            @for (label of mechanismKindLabels(); track label) {
              <span
                class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) px-2.5 py-0.5 text-xs font-bold tracking-[0.01em]"
                >{{ label }}</span
              >
            }
          </span>
        } @else {
          <span
            class="text-(--text-secondary)"
            i18n="@@products.detail.integrations.mechanism.none"
            i18n-aria-label="@@products.detail.integrations.mechanism.none.aria"
            aria-label="Mechanism not listed"
            >–</span
          >
        }
        @if (integration().mechanism_name; as name) {
          <span class="text-xs text-(--text-secondary)">{{ name }}</span>
        }
      </span>
    </td>
    <td class="px-4 py-3 text-end align-middle">
      <span class="text-(--text-tertiary) inline-block rtl:-scale-x-100" aria-hidden="true">→</span>
    </td>
  `,
})
export class ProductIntegrationRow {
  /** The integration row (mechanism + server-precomputed `context_direction`). */
  readonly integration = input.required<ProductIntegrationItem>();
  /** The *other* product — the endpoint that is not this page's product. */
  readonly other = input.required<ProductLink>();
  /** This page's product slug; the pair-page context (keeps direction relative). */
  readonly contextSlug = input.required<string>();
  /**
   * Merged facts for a **collapsed** row — set only by the Via lane, where one
   * row stands for one (connector, partner) and may cover several edges (§13.3).
   * `undefined` (the default) means "this row is one edge", and the row reads
   * `integration()` for both. `null` is a legitimate merged direction (unknown),
   * which is why the sentinel is `undefined` rather than `null`.
   */
  readonly mergedMechanismKinds = input<readonly IntegrationMechanismKind[] | undefined>(undefined);
  readonly mergedDirection = input<ContextDirection | null | undefined>(undefined);

  /** RouterLink to the product-PAIR page, this product as the context slug. */
  protected readonly pairLink = computed(() => [
    '/products',
    this.contextSlug(),
    'integrations',
    this.other().slug,
  ]);

  // Shared with the /search + /integrations surfaces via `mechanism-labels.ts`
  // (AECI-142) so the `$localize` id set can't drift between them. A row may
  // carry several kinds once collapsed; an unlabelled kind is dropped rather
  // than rendered blank.
  protected readonly mechanismKindLabels = computed(() => {
    const kinds = this.mergedMechanismKinds();
    const source =
      kinds ?? (this.integration().mechanism_kind ? [this.integration().mechanism_kind!] : []);
    return source.map((kind) => mechanismKindLabel(kind)).filter((label) => label !== '');
  });

  /** Below `md` the Connection column is hidden, so the kinds join the meta
   *  line under the partner name, after the direction. */
  protected readonly mechanismSublabel = computed(() => this.mechanismKindLabels().join(' · '));

  protected readonly direction = computed(() => {
    const merged = this.mergedDirection();
    return contextDirectionLabel(
      merged === undefined ? this.integration().context_direction : merged,
    );
  });

  // Built in TS (not an interpolated i18n-aria-label, which emits no attribute)
  // so the overlay link has a real accessible name naming the partner.
  protected readonly pairAriaLabel = computed(
    () =>
      $localize`:@@products.detail.integrations.row.aria:View the ${this.other().name}:PARTNER: integration`,
  );
}
