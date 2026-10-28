import type { StripeBillingInterval } from '@aeci/shared';

import { readVendorApiError } from '../vendor-api-error';

/** The three owner writes the Billing tab sends to Stripe (AECI-1502, E9.4). */
export type StripeBillingAction = 'checkout' | 'add' | 'portal';

/** A mapped refusal: the copy, and whether the tab's billing read is now stale. */
export interface StripeBillingError {
  readonly message: string;
  /** A `409`: the account's subscription is not what this tab showed. The section
   *  re-reads billing so the panel shows the right controls. */
  readonly stale: boolean;
}

function intervalLabel(interval: unknown): string | null {
  if (interval === 'year') return $localize`:@@vendor.billing.stripe.interval.yearly:yearly`;
  if (interval === 'month') return $localize`:@@vendor.billing.stripe.interval.monthly:monthly`;
  return null;
}

function genericMessage(action: StripeBillingAction): string {
  switch (action) {
    case 'checkout':
      return $localize`:@@vendor.billing.stripe.error.checkout:Could not open the Stripe payment page. Try again.`;
    case 'add':
      return $localize`:@@vendor.billing.stripe.error.add:Could not add the licenses. Try again.`;
    case 'portal':
      return $localize`:@@vendor.billing.stripe.error.portal:Could not open billing in Stripe. Try again.`;
  }
}

/**
 * Map a refusal from checkout, add or portal onto copy that says what happened and
 * what to do next. Every code `apps/api/src/routes/vendor-billing-stripe.ts` throws
 * has its own line. Anything unrecognised gets the action's generic line.
 */
export function stripeBillingErrorMessage(
  err: unknown,
  action: StripeBillingAction,
): StripeBillingError {
  const info = readVendorApiError(err);
  const stale = (message: string): StripeBillingError => ({ message, stale: true });
  const plain = (message: string): StripeBillingError => ({ message, stale: false });
  if (!info) return plain(genericMessage(action));

  const billedAs = intervalLabel(info.details?.['interval']);
  switch (info.code) {
    case 'STRIPE_UNAVAILABLE':
      return plain(
        $localize`:@@vendor.billing.stripe.error.unavailable:Paying by card is not available right now. If you need licenses before it is, you will need to contact AEC Integrations.`,
      );
    case 'STRIPE_SUBSCRIPTION_EXISTS':
      return stale(
        billedAs
          ? $localize`:@@vendor.billing.stripe.error.exists:Your company already has a card subscription, billed ${billedAs}:INTERVAL:. If you want more licenses, you will need to add them to that subscription.`
          : $localize`:@@vendor.billing.stripe.error.existsPlain:Your company already has a card subscription. If you want more licenses, you will need to add them to that subscription.`,
      );
    case 'LICENSE_INTERVAL_MISMATCH':
      return stale(
        billedAs
          ? $localize`:@@vendor.billing.stripe.error.interval:Your company's licenses are billed ${billedAs}:INTERVAL:. New licenses join the same subscription, so they are billed ${billedAs}:INTERVAL: too.`
          : $localize`:@@vendor.billing.stripe.error.intervalPlain:Your company's licenses are billed on a different schedule. New licenses join the same subscription and its schedule.`,
      );
    case 'STRIPE_SUBSCRIPTION_REQUIRED':
      return stale(
        $localize`:@@vendor.billing.stripe.error.required:Your company has no active card subscription, so there is nothing to add to or manage. If you want licenses, you will need to buy them first.`,
      );
    case 'DEPENDENCY_FAILURE':
      return plain(
        $localize`:@@vendor.billing.stripe.error.dependency:Stripe did not answer. Nothing was charged. Try again in a minute.`,
      );
    case 'RATE_LIMITED':
      return plain(
        $localize`:@@vendor.billing.stripe.error.rate:Too many attempts in a short time. Try again in a minute.`,
      );
    case 'VALIDATION_FAILED':
      return plain(
        $localize`:@@vendor.billing.stripe.error.quantity:Enter a number of licenses from 1 to 100.`,
      );
  }
  switch (info.status) {
    case 403:
      return plain(
        $localize`:@@vendor.billing.stripe.error.forbidden:Only an account owner can pay for licenses or manage billing.`,
      );
    case 429:
      return plain(
        $localize`:@@vendor.billing.stripe.error.rate:Too many attempts in a short time. Try again in a minute.`,
      );
    case 409:
      return stale(genericMessage(action));
    default:
      return plain(genericMessage(action));
  }
}

/** The interval as a sentence fragment ("billed yearly"), for the subscription line. */
export function billedIntervalLabel(interval: StripeBillingInterval): string {
  return interval === 'year'
    ? $localize`:@@vendor.billing.stripe.billedYearly:Billed yearly`
    : $localize`:@@vendor.billing.stripe.billedMonthly:Billed monthly`;
}
