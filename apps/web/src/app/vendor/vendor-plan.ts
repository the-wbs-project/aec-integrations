import { formatCurrency } from '@angular/common';

import type { VendorEntitlementBlock } from '@aeci/shared';
import {
  EXPIRY_WARNING_DAYS,
  MANAGED_ANNUAL_PRICE_CENTS,
  MANAGED_LIST_PRICE_CENTS,
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
 *  - `expiring` active Managed, end day inside `EXPIRY_WARNING_DAYS`, today or later.
 *  - `overdue`  active Managed whose end day has already passed (AECI-1408). The
 *               daily lapse job (`VENDOR_SIGNUP_PROCESS.md` §3 step 10) has not
 *               ended the license yet, so it is still Managed for a few hours.
 *  - `pending`  a Managed row arranged but not switched on. Free until it is.
 *  - `ended`    a row that ended (`expired` / `revoked`). On Free (decision 8).
 *  - `free`     no row at all (`status: null`), or an active row over a tier this
 *               build does not know (fail closed). On Free, nothing ended.
 */
export type PlanState = 'managed' | 'expiring' | 'overdue' | 'pending' | 'ended' | 'free';

const DAY_MS = 86_400_000;

/** Is this block Managed? `active` alone is not enough (fail closed). */
export function isManaged(plan: VendorEntitlementBlock): boolean {
  return plan.status === 'active' && plan.tier !== 'unclaimed';
}

export function planName(plan: VendorEntitlementBlock): PlanName {
  return isManaged(plan) ? 'managed' : 'free';
}

/**
 * Calendar days from today to the end day, both read in UTC: 0 on the end day
 * itself, 1 the day before, -1 the day after. `null` with no term.
 *
 * Signed, so an end day that has passed is told apart from one that is today.
 * The floored {@link daysRemaining} reads 0 for both, which made the panel say
 * "Managed ends today" every day after the end date (AECI-1408). UTC on both
 * sides, the zone the dates format in, so the SSR and hydration renders agree.
 */
export function signedDaysRemaining(plan: VendorEntitlementBlock, now: number): number | null {
  const end = parseDate(plan.period_end);
  if (end === null) return null;
  return Math.round((utcDay(end.getTime()) - utcDay(now)) / DAY_MS);
}

/** {@link signedDaysRemaining} floored at 0. `null` with no term. */
export function daysRemaining(plan: VendorEntitlementBlock, now: number): number | null {
  const days = signedDaysRemaining(plan, now);
  return days === null ? null : Math.max(0, days);
}

/** Midnight UTC of the day holding `ms`. */
function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function planState(plan: VendorEntitlementBlock, now: number): PlanState {
  if (isManaged(plan)) {
    const days = signedDaysRemaining(plan, now);
    if (days === null || days > EXPIRY_WARNING_DAYS) return 'managed';
    return days < 0 ? 'overdue' : 'expiring';
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

/**
 * How long the product-ended banner shows after the product's license ended
 * (AECI-1408, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). Long enough to be seen,
 * short enough not to nag forever. A product choice, safe to change.
 */
export const PRODUCT_ENDED_BANNER_DAYS = 90;

/**
 * The product-ended banner's rule: this product's plan is `ended` (the
 * {@link planState} rule: `expired` or `revoked`) and its `ended_at` is within
 * the last {@link PRODUCT_ENDED_BANNER_DAYS} days. A block with no readable
 * `ended_at` never shows it, because the banner states the date.
 */
export function productEndedRecently(plan: VendorEntitlementBlock, now: number): boolean {
  if (planState(plan, now) !== 'ended') return false;
  const ended = parseDate(plan.ended_at);
  if (ended === null) return false;
  return now - ended.getTime() <= PRODUCT_ENDED_BANNER_DAYS * DAY_MS;
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
 * cents ("$25"), anything else shows two decimals ("$12.50").
 */
export function formatPlanPrice(cents: number, locale: string): string {
  const digits = cents % 100 === 0 ? '1.0-0' : '1.2-2';
  return formatCurrency(cents / 100, locale, '$', 'USD', digits);
}

/**
 * The plan panel's price line: Managed's two list prices, from
 * `MANAGED_LIST_PRICE_CENTS` and `MANAGED_ANNUAL_PRICE_CENTS` ("Managed is $25 a
 * month or $250 a year per product."). Display only: nothing bills from it. The
 * per-vendor price override is retired (AECI-1357, `VENDOR_SIGNUP_PROCESS.md` §2
 * decision 8), so every vendor reads the same line.
 */
export function planPriceSentence(locale: string): string {
  const monthly = formatPlanPrice(MANAGED_LIST_PRICE_CENTS, locale);
  const annual = formatPlanPrice(MANAGED_ANNUAL_PRICE_CENTS, locale);
  return $localize`:@@vendor.plan.prices:Managed is ${monthly}:MONTHLY: a month or ${annual}:ANNUAL: a year per product.`;
}
