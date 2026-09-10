import { Component, input } from '@angular/core';

/**
 * A non-interactive category chip for the product card grid.
 *
 * Distinct from the shared `TaxonomyBadge` on purpose: that component is an
 * `<a>`, and the card grid wraps the WHOLE card in a single link to
 * `/products/:slug`. Nesting an anchor inside an anchor is invalid HTML and an
 * axe failure, so the grid needs a chip that renders the category as plain
 * styled text, not a link. The table view (rows are not whole-row links) keeps
 * using the real `TaxonomyBadge`.
 *
 * Same surface as `TaxonomyBadge` minus the hover/link affordances.
 *
 * **Chip metrics are shared, not per-component** (`DESIGN.md` §Badges, AECI-841).
 * `px-2.5 py-1` / `0.75rem` / `font-medium` / `tracking-[0.01em]` renders 29px,
 * which is what `RoleBadge` renders — and the two sit in the SAME flex row in
 * `ProductCardGrid`, so a divergence here is immediately visible as two peers at
 * two heights. This chip was `px-2.5 py-0.5`; it moved when `RoleBadge` did.
 */
@Component({
  selector: 'aec-category-chip',
  template: `
    <span
      class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-2.5 py-1 text-[0.75rem] font-medium tracking-[0.01em]
        text-(--text-secondary)"
      >{{ name() }}</span
    >
  `,
})
export class CategoryChip {
  readonly name = input.required<string>();
}
