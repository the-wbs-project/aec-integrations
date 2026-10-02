import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { VendorEntitlementBlock } from '@aeci/shared';

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
 * Not the public "Active on AECi" account label (`vendor-account-badge.ts`).
 * That one describes the company's account on public pages. This one names a
 * product's plan inside the portal.
 */
@Component({
  selector: 'aec-vendor-plan-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span [class]="cls()" [attr.data-plan]="name()">{{ label() }}</span>`,
  styles: [':host { display: inline-flex; }'],
})
export class VendorPlanBadge {
  readonly plan = input.required<VendorEntitlementBlock>();

  protected readonly name = computed(() => planName(this.plan()));
  protected readonly label = computed(() => planLabel(this.name()));

  protected readonly cls = computed(() => {
    const base =
      'inline-flex w-fit items-center whitespace-nowrap rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]';
    return this.name() === 'managed'
      ? `${base} border-(--border-strong) bg-(--surface-sunken) text-(--text-primary)`
      : `${base} border-(--border-default) bg-(--surface-base) text-(--text-secondary)`;
  });
}
