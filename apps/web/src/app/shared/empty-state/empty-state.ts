import { Component } from '@angular/core';

/**
 * The empty state on a list: a sunken panel at the card radius, text only, no
 * dashed edge (AECI-1793, mock-up 10, R5 row 4). Every browse list draws it the
 * same way, so a reader learns it once (DESIGN.md "The Same-Behavior Rule").
 *
 * The host projects the words: a plain sentence, or a lead line, a sentence and
 * a link. Text is left-aligned and secondary. The words are the page's own.
 */
@Component({
  selector: 'aec-empty-state',
  host: { class: 'block rounded-card bg-(--surface-sunken) p-8 text-t-16 text-(--text-secondary)' },
  template: `<ng-content />`,
})
export class EmptyState {}
