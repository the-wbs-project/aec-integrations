import { Component, input, output } from '@angular/core';

import { AecIcon } from '../shared/icon/icon';

import type { IntegrationArrangement } from './integration-category-groups';

// The Cards/Table toggle's own button recipe (`listing-view-toggle.ts`), so the two
// segmented controls in the filter panel read as one kind of control.
const BTN_BASE =
  'inline-flex items-center gap-1.5 rounded-(--radius-sm) px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * AECI-1783: "By category" or "One list", the long integration list's arrangement.
 *
 * Mock-up 7 draws it beside the Cards/Table toggle. It shows only on a long list in the
 * card view. Like the view, it is component state and never the URL, so the cached page
 * is the same for every visitor and always renders the grouped arrangement (ruling R3
 * decision 20). It reorders nothing: both arrangements keep the lane order.
 */
@Component({
  selector: 'aec-integration-arrangement-toggle',
  imports: [AecIcon],
  template: `
    <div
      role="group"
      class="inline-flex gap-1 rounded-(--radius-md) border border-(--border-default)
        bg-(--surface-raised) p-1"
      i18n-aria-label="@@products.detail.body.integrations.arrange.aria"
      aria-label="Arrange integrations"
      data-testid="integrations-arrangement"
    >
      <button
        type="button"
        [class]="btnClass('grouped')"
        [attr.aria-pressed]="arrangement() === 'grouped'"
        (click)="arrangementChange.emit('grouped')"
      >
        <aec-icon name="layers" decorative [size]="4" />
        <span i18n="@@products.detail.body.integrations.arrange.grouped">By category</span>
      </button>
      <button
        type="button"
        [class]="btnClass('one-list')"
        [attr.aria-pressed]="arrangement() === 'one-list'"
        (click)="arrangementChange.emit('one-list')"
      >
        <aec-icon name="rows" decorative [size]="4" />
        <span i18n="@@products.detail.body.integrations.arrange.oneList">One list</span>
      </button>
    </div>
  `,
})
export class IntegrationArrangementToggle {
  readonly arrangement = input.required<IntegrationArrangement>();
  readonly arrangementChange = output<IntegrationArrangement>();

  protected btnClass(value: IntegrationArrangement): string {
    return this.arrangement() === value
      ? `${BTN_BASE} bg-(--accent-primary) text-(--surface-base)`
      : `${BTN_BASE} text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
