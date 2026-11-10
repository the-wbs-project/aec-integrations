/**
 * The two clocks of a value hide (AECI-1238, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.7):
 * hide within two business days of receiving the request, decide within five. Both run
 * from `field_hides.received_at` through `businessWindowEnd`, so the admin list, the
 * audit row and the `field_hide_decision_overdue` check agree to the millisecond.
 */

import { FIELD_HIDE_DECIDE_BUSINESS_DAYS, FIELD_HIDE_DUE_BUSINESS_DAYS } from '@aeci/shared';

import { businessWindowEnd } from './business-days';

/**
 * The instant to count from. The admin form sends a bare date (`2026-11-06`), which
 * `Date` reads as UTC midnight: the evening BEFORE in New York, where business days are
 * counted, so every due would land a day early. A bare date is read as noon Eastern on
 * that day instead. An instant passes through.
 */
export function receivedInstant(receivedAt: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(receivedAt) ? `${receivedAt}T17:00:00.000Z` : receivedAt;
}

/** The two dues of a hide, from when AECi received the request. */
export function fieldHideDues(receivedAt: string): { hideDue: string; decideDue: string } {
  const start = receivedInstant(receivedAt);
  return {
    hideDue: businessWindowEnd(start, FIELD_HIDE_DUE_BUSINESS_DAYS),
    decideDue: businessWindowEnd(start, FIELD_HIDE_DECIDE_BUSINESS_DAYS),
  };
}
