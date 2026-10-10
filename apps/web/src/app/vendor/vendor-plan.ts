import { formatCurrency } from '@angular/common';

import type { VendorEntitlementBlock } from '@aeci/shared';
import {
  EXPIRY_WARNING_DAYS,
  MANAGED_LIST_PRICE_CENTS,
  planPriceDisplay,
  type PlanPriceOverrides,
} from '@aeci/shared/entitlements';

/**
 * The Free plan's state rules, in one place (AECI-1218,
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §13).
 *
 * "Free" is the `unclaimed` tier and "Managed" is `verified` (§13.2). A plan
 * block names Managed only when it is `active` over a tier this build knows, the
 * same fail-closed rule as `tierFor`. Everything else is Free, and the
 * difference between Free states is what the vendor is told, never what they
 * may do: the capability list on the block decides that.
 *
 * Pure functions over a {@link VendorEntitlementBlock}, so the plan badge, the
 * product plan panel, the overview summary and the pilot-ended banner cannot
 * describe the same block two ways.
 */

/** The two plans the portal names. Nothing beyond Managed is shown (decision 9). */
export type PlanName = 'free' | 'managed';

/**
 * The panel states.
 *
 *  - `managed`  active Managed, term far off or none.
 *  - `expiring` active Managed, term inside `EXPIRY_WARNING_DAYS`.
 *  - `pending`  a Managed row arranged but not switched on. Free until it is.
 *  - `ended`    a row that ended (`expired` / `revoked`). On Free (decision 8).
 *  - `free`     no row at all (`status: null`), or an active row over a tier this
 *               build does not know (fail closed). On Free, nothing ended.
 */
export type PlanState = 'managed' | 'expiring' | 'pending' | 'ended' | 'free';

const DAY_MS = 86_400_000;

/** Is this block Managed? `active` alone is not enough (fail closed). */
export function isManaged(plan: VendorEntitlementBlock): boolean {
  return plan.status === 'active' && plan.tier !== 'unclaimed';
}

export function planName(plan: VendorEntitlementBlock): PlanName {
  return isManaged(plan) ? 'managed' : 'free';
}

/** Whole days from `now` to `period_end`, floored at 0. `null` with no term. */
export function daysRemaining(plan: VendorEntitlementBlock, now: number): number | null {
  const end = parseDate(plan.period_end);
  if (end === null) return null;
  return Math.max(0, Math.ceil((end.getTime() - now) / DAY_MS));
}

export function planState(plan: VendorEntitlementBlock, now: number): PlanState {
  if (isManaged(plan)) {
    const days = daysRemaining(plan, now);
    return days !== null && days <= EXPIRY_WARNING_DAYS ? 'expiring' : 'managed';
  }
  // `active` over a tier this build does not know grants only the Free
  // capabilities. Nothing ended, so it reads as Free, not as a plan that ended.
  if (plan.status === null || plan.status === 'active') return 'free';
  if (plan.status === 'pending') return 'pending';
  return 'ended';
}

/**
 * The pilot-ended banner's rule (§13.11): the status is `expired` or `revoked`.
 * Never `null`, which is a vendor that never had a plan.
 */
export function planHasEnded(plan: VendorEntitlementBlock | null | undefined): boolean {
  return plan?.status === 'expired' || plan?.status === 'revoked';
}

/** A parsed ISO date, or `null` for none or an unparseable value. */
export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The plan badge's text. "Free" and "Managed" are product names, so they are
 *  translatable like every other label. */
export function planLabel(name: PlanName): string {
  return name === 'managed'
    ? $localize`:@@vendor.plan.name.managed:Managed`
    : $localize`:@@vendor.plan.name.free:Free`;
}

/**
 * Decision 10, word for word (§13.1), as reworded on 2026-10-09 (AECI-1265,
 * marketing review B2: "or what we verify" dropped). Every plan panel carries
 * it. One string with one id, so no panel can drift from it.
 */
export function noPlanChangesLine(): string {
  return $localize`:@@vendor.plan.decision10:No plan changes where you rank or appear, or whether a review is published.`;
}

/**
 * A cents amount as US dollars in the reader's locale. Whole dollars show no
 * cents ("$25"), anything else shows two decimals ("$12.50"), so an override
 * reads like the default sentence.
 */
export function formatPlanPrice(cents: number, locale: string): string {
  const digits = cents % 100 === 0 ? '1.0-0' : '1.2-2';
  return formatCurrency(cents / 100, locale, '$', 'USD', digits);
}

/**
 * The plan panel's price line (ruling 2026-10-08, `STAGE_2_PAID_TIERS_SPEC.md`
 * §13.13). Display only. Precedence: an admin message replaces the whole
 * sentence, else an admin price replaces the amount, else the default list
 * price (`MANAGED_LIST_PRICE_CENTS`, "Managed is $25 a month per product.").
 * The vendor panel and the admin preview both call this, so they cannot differ.
 *
 * The message is returned as plain text. Callers interpolate it, never bind it
 * as HTML.
 */
export function planPriceSentence(
  price: PlanPriceOverrides | null | undefined,
  locale: string,
): string {
  const display = planPriceDisplay(price);
  if (display.kind === 'message') return display.text;
  const cents = display.kind === 'price' ? display.cents : MANAGED_LIST_PRICE_CENTS;
  const amount = formatPlanPrice(cents, locale);
  return $localize`:@@vendor.plan.price:Managed is ${amount}:AMOUNT: a month per product.`;
}
