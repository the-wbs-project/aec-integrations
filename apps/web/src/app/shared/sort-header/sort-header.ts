import { Component, computed, input, output } from '@angular/core';

/**
 * A sortable column header for the admin tables (AECI-694).
 *
 * ── CLICKING SELECTS A SORT; IT DOES NOT TOGGLE A DIRECTION ──────────────────
 * Direction is fixed per key on the server (`apps/api/src/lib/sort.ts`, per
 * `STAGE_1_PHASE_2_SPEC.md` §7.4: `created` and `updated` descend, `name`
 * ascends), and there is no `order` parameter on any list endpoint. So the arrow
 * is a STATEMENT of how this column sorts, not a control that flips it, and
 * clicking an already-active header is a no-op rather than a reversal. Building
 * a toggle affordance over a one-way API would be a lie the first time someone
 * clicked it twice. `aria-sort` reports that same fixed direction, which is what
 * makes the promise honest for assistive tech too.
 *
 * ── WHY AN ATTRIBUTE SELECTOR ON A REAL `<th>` ──────────────────────────────
 * The same reason `tr[aec-product-card]` is an attribute directive: a custom
 * ELEMENT inside table context is foster-parented out by the HTML tree builder,
 * so `<aec-sort-header>` between `<tr>` and its cells would be relocated before
 * Angular ever saw it. Callers write `<th scope="col" aec-sort-header …>` and
 * keep `scope` visible in their own markup next to the plain headers.
 *
 * Only columns the API can genuinely order by get one of these. A header that
 * looks clickable and reorders 25 of 4,000 rows is worse than a plain header,
 * which is why the non-sortable columns stay plain `<th>` text with no hover
 * state (`ADMIN_PANEL_SPEC.md` §5.8 makes the same call for Last sign-in, which
 * is fetched per-id AFTER the ORDER BY has chosen the page).
 */
@Component({
  // Attribute selector is required so the rendered DOM is a literal `<th>` —
  // a custom element directly inside a `<tr>` is foster-parented out by the
  // HTML tree builder. The selector still carries the `aec-` prefix so it
  // satisfies the namespacing intent of the rule below. Same pattern as
  // `tr[aec-product-card]` here, and as `tr[cdk-row]` in Angular CDK.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'th[aec-sort-header]',
  host: { '[attr.aria-sort]': 'ariaSort()' },
  template: `
    <button
      type="button"
      (click)="select()"
      class="-mx-1 inline-flex cursor-pointer items-center gap-1 rounded-(--radius-sm) px-1 py-0.5 font-bold transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      [class.text-(--text-primary)]="isActive()"
      [class.text-(--text-secondary)]="!isActive()"
    >
      <span>{{ label() }}</span>
      @if (isActive()) {
        <span aria-hidden="true">{{ direction() === 'ascending' ? '↑' : '↓' }}</span>
      }
    </button>
  `,
})
export class SortHeader {
  /** The sort key this column sends to the API. */
  readonly sortKey = input.required<string>();

  /** Visible header text. Sentence case, per the DESIGN.md Sentence-Case Rule,
   *  which explicitly exempts table headers from the overline treatment. */
  readonly label = input.required<string>();

  /** The key currently in effect, from the host component's sort signal. */
  readonly activeSort = input.required<string>();

  /** How the SERVER orders this key. Not a state this control owns. */
  readonly direction = input.required<'ascending' | 'descending'>();

  readonly sortChange = output<string>();

  protected readonly isActive = computed(() => this.sortKey() === this.activeSort());

  protected readonly ariaSort = computed<'ascending' | 'descending' | 'none'>(() =>
    this.isActive() ? this.direction() : 'none',
  );

  protected select(): void {
    if (this.isActive()) return;
    this.sortChange.emit(this.sortKey());
  }
}
