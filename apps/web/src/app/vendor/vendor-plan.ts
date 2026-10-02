import type { VendorEntitlementBlock } from '@aeci/shared';
import { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';

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
 * Decision 10, word for word (§13.1). Every plan panel carries it. One string
 * with one id, so no panel can drift from it.
 */
export function noPlanChangesLine(): string {
  return $localize`:@@vendor.plan.decision10:No plan changes where you rank or appear, whether a review is published, or what we verify.`;
}
