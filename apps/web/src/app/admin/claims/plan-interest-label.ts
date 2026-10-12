import type { PlanInterest } from '@aeci/shared';

import { planLabel } from '../../vendor/vendor-plan';

/**
 * A claimant's answer to "Which plan are you interested in?" (AECI-1293,
 * `VENDOR_PROGRAM_PAGE_SPEC.md` §15.5), as the reviewer reads it on `/admin/claims`
 * and `/admin/requests`. `null` is "Not answered", never a default plan: the approve
 * form's radios stay unselected whatever this says (`STAGE_2_PAID_TIERS_SPEC.md` §13.6).
 */
export function planInterestLabel(value: PlanInterest | null): string {
  switch (value) {
    case 'free':
      return planLabel('free');
    case 'managed':
      return planLabel('managed');
    case 'not_sure':
      return $localize`:@@admin.planInterest.notSure:Not sure yet`;
    default:
      return $localize`:@@admin.planInterest.none:Not answered`;
  }
}
