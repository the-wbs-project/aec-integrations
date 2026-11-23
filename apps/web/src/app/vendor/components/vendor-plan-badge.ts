import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { VendorEntitlementBlock } from '@aeci/shared';

import { Chip, type ChipTone } from '../../shared/chip/chip';
import { planLabel, planName } from '../vendor-plan';

/**
 * One product's plan, as a label: "Free" or "Managed" (AECI-1218,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18, decision 2).
 *
 * It reads the product's own `plan` block, never `me().entitlement` (§13.7).
 * Text only, never colour alone, so it reads the same to a screen reader. The
 * Managed label is a filled chip and the Free one an outlined chip, which is the
 * whole visual difference: neither is a warning, so neither borrows a status
 * colour.
 *
 * Portal only, never a public marker. The public "Active on AEC Integrations"
 * account label was removed (AECI-1264, marketing review B1).
 */
@Component({
  selector: 'aec-vendor-plan-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Chip],
  template: `<aec-chip density="dense" [tone]="tone()" [attr.data-plan]="name()">{{
    label()
  }}</aec-chip>`,
  styles: [':host { display: inline-flex; }'],
})
export class VendorPlanBadge {
  readonly plan = input.required<VendorEntitlementBlock>();

  protected readonly name = computed(() => planName(this.plan()));
  protected readonly label = computed(() => planLabel(this.name()));

  /** Managed is the stronger edge on a sunken fill. Free is the quiet outline. */
  protected readonly tone = computed<ChipTone>(() =>
    this.name() === 'managed' ? 'strong-sunken' : 'quiet',
  );
}
