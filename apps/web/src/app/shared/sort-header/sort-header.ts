import { Component, computed, input, output } from '@angular/core';

/**
 * A sortable column header for the admin tables (AECI-694).
 *
 * ── CLICKING AN INACTIVE HEADER SELECTS IT; CLICKING THE ACTIVE ONE FLIPS ────
 * First click on a column sorts it by that column's NATURAL direction — the one
 * an operator wants first, and the one a bare `?sort=` has always produced
 * (`name` ascends, `updated` descends). Clicking the column that is already
 * active reverses it, sending `order` alongside `sort`.
 *
 * This control originally did NOT flip: direction was fixed per key server-side
 * with no `order` parameter anywhere, so clicking an active header was a
 * deliberate no-op and the arrow was a STATEMENT of how the column sorts. That
 * held while the API could order by two keys. It stopped holding when the admin
 * vendor list grew to seven: an arrow on a clickable header reads as a toggle to
 * every operator who has ever used one, and a control that silently does nothing
 * on the second click is a worse lie than the one the old rule was avoiding. The
 * API gained `order` (`apps/api/src/lib/sort.ts`) and this control gained the
 * flip.
 *
 * `aria-sort` reports the LIVE direction, so the promise stays honest for
 * assistive tech — and because the button's accessible name now has to say what
 * the next click will do, the sr-only hint below is not decoration.
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
      <!--
        The arrow is aria-hidden, so without this a screen-reader user hears the
        same button name before and after a flip. aria-sort on the host says what
        the CURRENT order is; this says what pressing it will DO, which is the
        part a sort control has to promise. (No backticks in this comment: it is
        inside a template literal, and one would close it.)
      -->
      <span class="sr-only">{{ actionHint() }}</span>
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

  /**
   * The direction currently in effect for this key — the LIVE one, including a
   * flip the operator has applied. Still not state this control owns: the host
   * holds it, because the host is what talks to the API.
   */
  readonly direction = input.required<'ascending' | 'descending'>();

  /** The key, and the direction to apply to it. An inactive header emits its own
   *  natural direction; the active header emits the opposite of the current one. */
  readonly sortChange = output<{ key: string; order: 'asc' | 'desc' }>();

  protected readonly isActive = computed(() => this.sortKey() === this.activeSort());

  protected readonly ariaSort = computed<'ascending' | 'descending' | 'none'>(() =>
    this.isActive() ? this.direction() : 'none',
  );

  /** What the NEXT press does, for the accessible name. */
  protected readonly actionHint = computed(() => {
    if (!this.isActive()) return $localize`:@@sortHeader.hint.sort:sort by this column`;
    return this.direction() === 'ascending'
      ? $localize`:@@sortHeader.hint.toDescending:sorted ascending, press to sort descending`
      : $localize`:@@sortHeader.hint.toAscending:sorted descending, press to sort ascending`;
  });

  /**
   * An inactive header adopts its own natural direction rather than inheriting
   * whatever the previous column was sorted by — moving from "Updated ↓" to
   * "Vendor" must give A–Z, not Z–A. The host supplies that natural direction
   * through `direction`, which for an inactive header is exactly what it would
   * be if selected.
   */
  protected select(): void {
    if (!this.isActive()) {
      this.sortChange.emit({
        key: this.sortKey(),
        order: this.direction() === 'ascending' ? 'asc' : 'desc',
      });
      return;
    }
    this.sortChange.emit({
      key: this.sortKey(),
      order: this.direction() === 'ascending' ? 'desc' : 'asc',
    });
  }
}
