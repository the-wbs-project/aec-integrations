/**
 * The words of the plan calls to action (`plan-cta.ts`), as pure functions: the price
 * and term lines `/vendor-program` and the docs Plans page share, and the closing
 * panel's copy.
 *
 * Split out of the components in AECI-1619 so the Plans snapshot
 * (`docs/plans-snapshot.ts`) prints exactly what the "Getting Managed" panel says, from
 * the same source. The snapshot spec fails on any change to them. No Angular component
 * import: plain Vitest runs it with `@angular/localize/init`. `$localize` runs on each
 * call, never at module init.
 */
import { MANAGED_ANNUAL_PRICE_CENTS, MANAGED_LIST_PRICE_CENTS } from '@aeci/shared/entitlements';

import { formatPlanPrice } from '../../vendor/vendor-plan';

/** `$25 USD a month per product`, from the list price. */
export function managedPriceLine(locale: string): string {
  const amount = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  return $localize`:@@app.docs.plans.cta.priceLine:${amount}:AMOUNT: USD a month per product`;
}

/**
 * `$25 USD a month or $250 USD a year per product.`, the closing panel's terms (spec
 * §4.1), from the two price constants. USD stays on each amount: vendors outside the
 * US read these pages. No payment method (E8.2, 2026-10-19).
 */
export function managedTermsLine(locale: string): string {
  const monthly = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  const annual = formatPlanPrice(MANAGED_ANNUAL_PRICE_CENTS, locale);
  return $localize`:@@planCta.terms:${monthly}:MONTHLY: USD a month or ${annual}:ANNUAL: USD a year per product.`;
}

/**
 * The term, beside the price in What Managed adds on `/vendor-program` (E8.2
 * 2026-10-19): monthly is month to month with no commitment, and the first charge
 * carries a 14-day full refund. The closing panel says it shorter in its own string
 * since 2026-10-24 (spec §4.1).
 */
export function managedTermLine(): string {
  return $localize`:@@planCta.term:Monthly has no commitment: cancel any time. We refund in full if you ask within 14 days of the first charge.`;
}

/**
 * Annual renewal, under the price on `/vendor-program` (spec §3 item 4, E8.2
 * 2026-10-19). The docs Plans page says it in Markdown, and
 * `vendor-program-copy.component.spec.ts` pins the two together sentence by sentence.
 */
export function managedRenewalLine(): string {
  return $localize`:@@planCta.renewal:An annual subscription renews each year unless you opt out before the renewal date. Forty-five days before that date, we email every seat and your billing email the date, the price, the subscription count and any change to the terms. A new price never applies mid-term.`;
}

/**
 * The vendor program FAQ's "What does Managed cost?" answer (E8.2, 2026-10-19): both
 * prices from the two constants, monthly with no commitment, annual renewal and the
 * 14-day refund. AECI-1396 (2026-10-28) added the payment method: by card through
 * Stripe, from the Billing tab.
 */
export function managedCostAnswer(locale: string): string {
  const monthly = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  const annual = formatPlanPrice(MANAGED_ANNUAL_PRICE_CENTS, locale);
  return $localize`:@@vendorProgram.faq.billing.a:Managed costs ${monthly}:MONTHLY: USD a month or ${annual}:ANNUAL: USD a year per product. Monthly has no commitment: cancel any time. An annual subscription renews each year unless you opt out before the renewal date. We refund in full if you ask within 14 days of the first charge. You pay by card through Stripe, from the Billing tab.`;
}

/** The closing panel's statements (`PlanCtaPanelComponent`, `placement: bottom`). */
export interface PlanCtaPanelCopy {
  readonly heading: string;
  /** Both list prices (`managedTermsLine`). */
  readonly terms: string;
  readonly term: string;
  readonly safety: string;
  /** The two next steps, shown while the button opens the claim dialog. */
  readonly steps: readonly [string, string];
}

/** The closing panel's copy in `locale`. */
export function planCtaPanelCopy(locale: string): PlanCtaPanelCopy {
  return {
    heading: $localize`:@@app.docs.plans.cta.heading:Tell the full story of your product`,
    terms: managedTermsLine(locale),
    term: $localize`:@@app.docs.plans.cta.term:Monthly, cancel any time. Full refund within 14 days.`,
    safety: $localize`:@@app.docs.plans.cta.safety:If a plan ends, your text stays unless you ask us to remove it.`,
    steps: [
      $localize`:@@planCta.step.find:Find your listing and send your claim.`,
      $localize`:@@planCta.step.review:We review it and email you the result.`,
    ],
  };
}
