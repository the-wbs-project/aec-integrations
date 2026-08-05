import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Phase 2 §11.2 — `TaxonomyBadge`. A chip-style link to a category /
 * audience / phase browse page. Used by detail-page metadata sidebars
 * (product, vendor, integration) and by `ProductCard` / `IntegrationCard`
 * once those land.
 *
 * Visual spec:
 *   - Surface: `surface-raised` fill (light) / `dark-surface-raised` (dark)
 *   - Border: 0.5px `border-default`, raises to 1px `border-strong` on hover
 *   - Text: `text-primary`, shifts to `accent-primary` on hover (Forest in
 *     light, Dark Forest in dark) — matches the link-color contract from
 *     `DESIGN.md` §"Forest-Anchor Rule"
 *   - Typography: Atkinson Hyperlegible Next medium (500) / 13px — a lighter weight
 *     than the `label` role (700); taxonomy chips are navigational tags, not
 *     button affordances. See `DESIGN.md` §5 → "Tags / taxonomy chips".
 *   - Shape: `rounded.sm` (4px) — chips, not pills (the pill shape is
 *     reserved for vendor-verified badges per the DESIGN.md badge specs)
 *
 * Count (AECI-184): an optional `[count]` renders a trailing product count
 * inside the same chip ("{name} {count}") — the home "Browse by" count-chip the
 * design doc specifies (`home-direction.md` §"Section rhythm") IS this chip plus
 * a count, so the home reuses it rather than rebuilding. The count is
 * `tabular-nums` in `--text-secondary` (AA-safe; the issue mandates secondary,
 * not the AA-failing `--text-tertiary`). When `count` is omitted the chip is
 * unchanged — the detail-sidebar usages render name-only.
 *
 * Accessibility:
 *   - Renders as `<a>` so it's keyboard-focusable by default
 *   - Visible focus ring via `:focus-visible` matching the global
 *     focus-ring elevation token
 *   - Visible label text is `[name]`. When a `[count]` is shown, the link gets an
 *     explicit `aria-label` ("{name} {n} products") so its accessible name is the
 *     clean, un-smushed string (Angular strips the inter-element whitespace, so
 *     relying on concatenated child text would announce "{name}{n}"). The visible
 *     label remains a substring of the accessible name (WCAG 2.5.3 Label in Name).
 *
 * Anchor-Site Rule (DESIGN.md §"Named Rules"): pulled from the same Mobbin
 * reference site selected for the product detail surface — see the
 * `Mobbin anchor:` line on the AECI-57 commit / Linear issue.
 */
/**
 * The four taxonomy facets (STAGE_1_SPEC.md §5.5). `trade` — "what work does
 * your company sell?" — joined in AECI-544. This union is the canonical one:
 * it keys `KIND_PATH_SEGMENT`, the facet-sidebar dimension table, and the
 * per-kind `$localize` switches across the nav, browse, and meta layers, so
 * adding a facet here surfaces every site the compiler needs you to visit.
 */
export type TaxonomyKind = 'category' | 'audience' | 'phase' | 'trade';

@Component({
  selector: 'aec-taxonomy-badge',
  imports: [RouterLink],
  template: `
    <a
      [routerLink]="routerLink()"
      [attr.aria-label]="ariaLabel()"
      class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-medium tracking-[0.01em]
        text-(--text-primary) no-underline transition-colors duration-150
        hover:border-(--border-strong) hover:text-(--accent-primary)
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary)
        focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
    >
      <span>{{ name() }}</span>
      @if (count() !== undefined) {
        <span class="tabular-nums text-(--text-secondary)">{{ count() }}</span>
      }
    </a>
  `,
  styles: `
    :host {
      display: inline-block;
    }
  `,
})
export class TaxonomyBadge {
  readonly kind = input.required<TaxonomyKind>();
  readonly slug = input.required<string>();
  readonly name = input.required<string>();
  /** Optional product count rendered inside the chip (AECI-184 home grids). */
  readonly count = input<number | undefined>(undefined);

  /**
   * Explicit link accessible name when a count is shown ("{name} {n} products"),
   * else `null` so the link falls back to its visible `[name]` text. Authored on
   * the anchor because Angular strips the whitespace between the name and count
   * spans, which would otherwise smush the announced name to "{name}{n}".
   */
  protected readonly ariaLabel = computed(() => {
    const c = this.count();
    return c === undefined
      ? null
      : $localize`:@@taxonomy.badge.count.aria:${this.name()}:NAME: ${c}:COUNT: products`;
  });

  protected readonly routerLink = computed(() => {
    const k = this.kind();
    const s = this.slug();
    switch (k) {
      case 'category':
        return ['/categories', s];
      case 'audience':
        return ['/audiences', s];
      case 'phase':
        return ['/phases', s];
      // Trade chips link even when the term is below the publication floor —
      // the tag is true, the page just isn't promoted (TRADES_VOCABULARY §6).
      case 'trade':
        return ['/trades', s];
    }
  });
}
