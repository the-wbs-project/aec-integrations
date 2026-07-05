import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductIntegrationItem, ProductLink } from '@aeci/shared';

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
 * Three columns + a trailing affordance:
 *   1. **Direction** — leads the row (a glance conveys the relationship): a
 *      prominent accent arrow + label, context-relative to *this* page's product
 *      — `→ Outbound` (data leaves it), `← Inbound` (data arrives), `⇄ Both`.
 *      Always visible (incl. below `md`). The value is the server-precomputed,
 *      claims-aware `context_direction` (`STAGE_1_5_SPEC.md` §3.2), so it can't
 *      contradict the pair page; `–` when unknown (no claims, no stored direction).
 *   2. **Integrates with** — the *other* product (monogram via `LogoOrInitial` +
 *      a name link to that product's page). Always visible. Below `md` the
 *      Connection column collapses and the mechanism surfaces here as a muted
 *      sublabel (mirrors `ProductCard`'s vendor sublabel at the same breakpoint).
 *   3. **Connection** — the `mechanism_kind` badge (shared `mechanismKindLabel()`)
 *      plus the optional `mechanism_name`. Hidden below `md`. `–` when absent.
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
    // `group` lets the below-`md` mechanism sublabel step tertiary→secondary
    // when the row fill goes muted on hover / focus-within.
    class:
      'group relative text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <!-- Direction leads the row (always visible, incl. below md): the flow
         relative to THIS page's product, precomputed server-side as
         context_direction (claims-aware, §3.2). Prominent accent arrow +
         label; em-dash when unknown. The stretched row overlay (in the next
         cell) covers this cell too, so a click here still opens the pair page. -->
    <td class="px-4 py-3 align-middle">
      @if (direction().token) {
        <span class="inline-flex items-center gap-2">
          <span
            class="font-display inline-block text-xl leading-none text-(--accent-primary) rtl:-scale-x-100"
            aria-hidden="true"
            >{{ direction().glyph }}</span
          >
          <span class="text-(--text-secondary)">{{ direction().label }}</span>
        </span>
      } @else {
        <span
          class="text-(--text-secondary)"
          i18n="@@products.detail.integrations.direction.none"
          i18n-aria-label="@@products.detail.integrations.direction.none.aria"
          aria-label="Direction not listed"
          >–</span
        >
      }
    </td>
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
          <!-- Below md the Connection <td> is hidden, so the mechanism surfaces
               here as a muted sublabel. Tertiary at rest (4.83:1 on white);
               group-hover / group-focus-within step it to secondary once the row
               fill goes muted (DESIGN.md §"Tertiary": never on muted). -->
          @if (mechanismKindLabel(); as label) {
            <span
              class="mt-0.5 text-xs text-(--text-tertiary) transition-colors group-hover:text-(--text-secondary) group-focus-within:text-(--text-secondary) md:hidden"
              >{{ label }}</span
            >
          }
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
        @if (mechanismKindLabel(); as label) {
          <span
            class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) px-2.5 py-0.5 text-xs font-bold tracking-[0.01em]"
            >{{ label }}</span
          >
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

  /** RouterLink to the product-PAIR page, this product as the context slug. */
  protected readonly pairLink = computed(() => [
    '/products',
    this.contextSlug(),
    'integrations',
    this.other().slug,
  ]);

  // Shared with the /search + /integrations surfaces via `mechanism-labels.ts`
  // (AECI-142) so the `$localize` id set can't drift between them.
  protected readonly mechanismKindLabel = computed(() =>
    mechanismKindLabel(this.integration().mechanism_kind),
  );

  protected readonly direction = computed(() =>
    contextDirectionLabel(this.integration().context_direction),
  );

  // Built in TS (not an interpolated i18n-aria-label, which emits no attribute)
  // so the overlay link has a real accessible name naming the partner.
  protected readonly pairAriaLabel = computed(
    () =>
      $localize`:@@products.detail.integrations.row.aria:View the ${this.other().name}:PARTNER: integration`,
  );
}
