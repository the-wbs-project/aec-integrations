/**
 * The words on the Free and Managed plan cards (`plan-cards.ts`), as pure data.
 *
 * Split out of the component in AECI-1619 so the Plans snapshot
 * (`docs/plans-snapshot.ts`) can print exactly what the cards say without
 * loading Angular. The component renders these strings, and the snapshot spec
 * fails on any change to them, so the cards and the recorded Plans page cannot
 * drift apart.
 *
 * No Angular import: plain Vitest runs it with `@angular/localize/init`.
 * `$localize` runs on each call, never at module init.
 */
import { MANAGED_LIST_PRICE_CENTS } from '@aeci/shared/entitlements';

import { formatPlanPrice, planLabel } from '../../vendor/vendor-plan';

/** One card's words. */
export interface PlanCardCopy {
  readonly name: string;
  readonly summary: string;
  /** Set on Managed only: the formatted monthly list price. */
  readonly price?: string;
  /** The line beside the price ("USD a month per product") or in its place. */
  readonly unit: string;
  /** The label above the highlight list. */
  readonly includes: string;
  readonly highlights: readonly string[];
}

/** Both cards, Free first. */
export interface PlanCardsCopy {
  readonly free: PlanCardCopy;
  readonly managed: PlanCardCopy;
}

/** The two plan cards' copy in `locale`. */
export function planCardsCopy(locale: string): PlanCardsCopy {
  return {
    free: {
      name: planLabel('free'),
      summary: $localize`:@@app.docs.plans.free.summary:Keep your listing accurate.`,
      unit: $localize`:@@app.docs.plans.free.unit:Available for all products`,
      includes: $localize`:@@app.docs.plans.free.includes:Includes`,
      highlights: [
        $localize`:@@app.docs.plans.free.h1:Keep your company details and logo current`,
        $localize`:@@app.docs.plans.free.h2:Keep each product's description, website and categories current`,
        $localize`:@@app.docs.plans.free.h3:Claim and maintain the integrations you build`,
        $localize`:@@app.docs.plans.free.h4:Invite your colleagues`,
        $localize`:@@app.docs.plans.free.h5:Answer reviews in public`,
      ],
    },
    managed: {
      name: planLabel('managed'),
      summary: $localize`:@@app.docs.plans.managed.summary:Tell the full story of each product.`,
      price: formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale),
      unit: $localize`:@@app.docs.plans.managed.unit:USD a month per product`,
      includes: $localize`:@@app.docs.plans.managed.includes:Everything in Free, plus`,
      highlights: [
        $localize`:@@app.docs.plans.managed.h1:"How teams use it", in your own words`,
        $localize`:@@app.docs.plans.managed.h2:The trades, audiences and phases you serve`,
        $localize`:@@app.docs.plans.managed.integrationDetail:Integration detail: extra links and the data each integration moves.`,
        $localize`:@@app.docs.plans.managed.h7:Search engines notified when you update a page`,
      ],
    },
  };
}
