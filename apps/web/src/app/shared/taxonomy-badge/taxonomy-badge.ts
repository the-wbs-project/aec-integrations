import { Component, computed, input } from '@angular/core';
import { Chip } from '../chip/chip';

/**
 * Phase 2 §11.2 — `TaxonomyBadge`. A chip-style link to a category /
 * audience / phase / trade browse page. Used by detail-page metadata sidebars
 * (product, vendor, integration) and by `ProductCard`.
 *
 * Since AECI-1763 it renders `aec-chip` (default density, `link`): a pill with a
 * 1px `border-default` edge that hovers to `border-strong` and Forest text, with
 * the shared 3px focus ring. The recipe lives in `.aec-chip` in `styles.css`.
 *
 * Count (AECI-184): an optional `[count]` renders a trailing product count
 * inside the same chip ("{name} {count}"). The count is `tabular-nums` in
 * `--text-secondary`. When `count` is omitted the chip is name-only.
 *
 * Accessibility:
 *   - Renders as `<a>` so it's keyboard-focusable by default
 *   - Visible label text is `[name]`. When a `[count]` is shown, the link gets an
 *     explicit `aria-label` ("{name} {n} products") so its accessible name is the
 *     clean, un-smushed string. The visible label remains a substring of the
 *     accessible name (WCAG 2.5.3 Label in Name).
 *
 * Term chips keep the caller's order (`display_order`); this component sorts nothing.
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
  imports: [Chip],
  template: `
    <aec-chip [link]="routerLink()" [ariaLabel]="ariaLabel()">
      <span>{{ name() }}</span>
      @if (count() !== undefined) {
        <span class="tabular-nums text-(--text-secondary)">{{ count() }}</span>
      }
    </aec-chip>
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
