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
  /** AECI-1865: the API counted a different number of unused subscriptions than the
   *  tab showed. Not stale: the form stays where it is, the tab re-reads billing so the
   *  warning shows the new count, and focus goes to the cleared box. */
  readonly recount?: boolean;
  /** With `recount`: the counts the API used, from `details`, when it sent them. The tab
   *  warns from these until the next purchase, because its own read can lag them (a
   *  webhook still in flight). */
  readonly counts?: { readonly pool: number; readonly productsWithout: number };
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
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
      return $localize`:@@vendor.billing.stripe.error.add:Could not add the subscriptions. Try again.`;
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
        $localize`:@@vendor.billing.stripe.error.unavailable:Paying by card is not available right now. If you need subscriptions before it is, you will need to contact AEC Integrations.`,
      );
    case 'STRIPE_SUBSCRIPTION_EXISTS':
      return stale(
        billedAs
          ? $localize`:@@vendor.billing.stripe.error.exists:Your company already has a Stripe plan, billed ${billedAs}:INTERVAL:. If you want more subscriptions, you will need to add them to that plan.`
          : $localize`:@@vendor.billing.stripe.error.existsPlain:Your company already has a Stripe plan. If you want more subscriptions, you will need to add them to that plan.`,
      );
    case 'LICENSE_INTERVAL_MISMATCH':
      return stale(
        billedAs
          ? $localize`:@@vendor.billing.stripe.error.interval:Your company's subscriptions are billed ${billedAs}:INTERVAL:. New subscriptions join the same Stripe plan, so they are billed ${billedAs}:INTERVAL: too.`
          : $localize`:@@vendor.billing.stripe.error.intervalPlain:Your company's subscriptions are billed on a different schedule. New subscriptions join the same Stripe plan and its schedule.`,
      );
    case 'STRIPE_SUBSCRIPTION_REQUIRED':
      return stale(
        $localize`:@@vendor.billing.stripe.error.required:Your company has no active Stripe plan, so there is nothing to add to or manage. If you want subscriptions, you will need to buy them first.`,
      );
    case 'STRIPE_PAYMENT_INCOMPLETE':
      // Only add raises it. Not stale: the subscription is what the tab shows, so the
      // message stays in the dialog and the owner can try again.
      return plain(
        $localize`:@@vendor.billing.stripe.error.paymentIncomplete:Your card was not charged, so no subscriptions were added. Check your payment method with Manage billing in Stripe, then try again.`,
      );
    case 'UNUSED_SUBSCRIPTIONS_UNACKNOWLEDGED': {
      const pool = countOf(info.details?.['pool']);
      const productsWithout = countOf(info.details?.['products_without_subscription']);
      return {
        message: $localize`:@@vendor.billing.stripe.error.unused:The number of unused subscriptions has changed. Check the warning, then tick the box again.`,
        stale: false,
        recount: true,
        ...(pool !== null && productsWithout !== null ? { counts: { pool, productsWithout } } : {}),
      };
    }
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
        $localize`:@@vendor.billing.stripe.error.quantity:Enter a number of subscriptions from 1 to 100.`,
      );
  }
  switch (info.status) {
    case 403:
      return plain(
        $localize`:@@vendor.billing.stripe.error.forbidden:Only an account owner can pay for subscriptions or manage billing.`,
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
