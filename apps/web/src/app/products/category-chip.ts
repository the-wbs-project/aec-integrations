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
 * Visual parity with `TaxonomyBadge` minus the hover/link affordances. Both
 * themes via tokens.
 */
@Component({
  selector: 'aec-category-chip',
  template: `
    <span
      class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-2.5 py-0.5 text-xs font-medium tracking-[0.01em]
        text-(--text-secondary)"
      >{{ name() }}</span
    >
  `,
})
export class CategoryChip {
  readonly name = input.required<string>();
}
