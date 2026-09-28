import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { IM_STYLES, ImPairMark, ImPill } from './im-ui';
import {
  VIEWER,
  integrationStatus,
  sharedSummary,
  type ImIntegration,
} from './integration-manager.fixtures';

/**
 * The compact summary every list concept shows for one integration: the other
 * product, its company, one plain status with what it means, and one line saying
 * what is shared. Spans only, so it can sit inside a button or a link.
 */
@Component({
  selector: 'aec-im-row-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImPill, ImPairMark],
  styles: [IM_STYLES, ':host { display: block; min-width: 0; }'],
  template: `
    @let i = integration();
    @let s = status();
    <span class="flex min-w-0 items-start gap-4">
      <aec-im-pair-mark [left]="viewer" [right]="i.other.name" />
      <span class="block min-w-0 flex-1">
        <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span [id]="nameId()" class="font-display text-lg font-semibold text-(--text-primary)">{{
            i.other.name
          }}</span>
          <span class="text-sm text-(--text-secondary)">by {{ i.other.vendor }}</span>
        </span>
        <span class="mt-1 block text-sm text-(--text-primary)">{{ shared() }}</span>
        @if (!compact()) {
          <span class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <aec-im-pill [label]="s.label" [tone]="s.tone" />
            <span class="text-sm text-(--text-secondary)">{{ s.explain }}</span>
          </span>
        } @else {
          <span class="mt-2 block"><aec-im-pill [label]="s.label" [tone]="s.tone" /></span>
        }
      </span>
    </span>
  `,
})
export class ImRowSummary {
  readonly integration = input.required<ImIntegration>();
  /** Pill only, no explanation line (B's narrow list). */
  readonly compact = input(false);
  /** Id on the product name, for a row button's accessible name. */
  readonly nameId = input<string | null>(null);

  protected readonly viewer = VIEWER.product;
  protected readonly status = computed(() => integrationStatus(this.integration()));
  protected readonly shared = computed(() => sharedSummary(this.integration()));
}
