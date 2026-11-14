/**
 * The pure half of the Suspension section (AECI-1623): money, the refusal Terminate shows,
 * and the error sentences. Kept out of the components so a spec can pin each rule alone.
 */
import type { VendorSuspension } from '@aeci/shared';

import { FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';

/** `AbuseCostEntryRequestSchema` and `TerminateVendorRequestSchema`: the amount cap. */
const MAX_AMOUNT_CENTS = 100_000_000;

/** Integer cents as dollars: `12345` is `$123.45`. A recovery reads `-$50.00`. */
export function formatCents(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat($localize.locale ?? 'en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

/**
 * A typed dollar amount as integer cents, or `null` when it is not one. Accepts `1200`,
 * `1,200.50` and `$1200.5`. String arithmetic, because `19.99 * 100` is not `1999` in
 * floating point. Over the API's cap is `null`.
 */
export function parseDollarsToCents(raw: string): number | null {
  const value = raw.trim().replace(/^\$/, '');
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/.test(value)) return null;
  const [whole = '0', fraction = ''] = value.replaceAll(',', '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents <= MAX_AMOUNT_CENTS ? cents : null;
}

const utcDay = (iso: string): number => Math.floor(Date.parse(iso) / 86_400_000);

/**
 * The pre-cost refund of one invoice-paid subscription, for the live preview only. The
 * server computes the real one at Terminate. This mirrors `grossRefundCents` in
 * `apps/api/src/lib/vendor-termination-refund.ts` for the one line an invoice payment has:
 * paid x unused days / term days, in whole UTC days, the suspension day counted as unused.
 */
export function manualGrossCents(
  paidCents: number,
  startsAt: string,
  endsAt: string,
  suspendedAt: string,
): number {
  if (paidCents <= 0) return 0;
  const start = utcDay(startsAt);
  const termDays = Math.max(1, utcDay(endsAt) - start);
  const usedDays = Math.min(termDays, Math.max(0, utcDay(suspendedAt) - start));
  return Math.min(paidCents, Math.round((paidCents * (termDays - usedDays)) / termDays));
}

/** The current stage's notice has no confirmed send. Stage 2 is current once its finding exists. */
export function currentNoticeUnconfirmed(s: VendorSuspension): boolean {
  return s.stage_2_finding !== null ? s.stage_2_notice_sent_at === null : s.notice_sent_at === null;
}

/**
 * Why Terminate must wait, or `null` when it may run. The same order as `terminateRefusal`
 * in `routes/admin-vendor-suspension.ts`. The API sends the answer as `can_terminate` and
 * not the reason, so it is read back from the state: `can_start_stage_2` is what says
 * stage 1 has elapsed, because the server's clock decides that and not this browser's.
 */
export function terminateBlockedReason(s: VendorSuspension): string | null {
  if (s.can_terminate) return null;
  if (s.notice_sent_at === null) {
    return $localize`:@@admin.vendors.suspension.terminate.blocked.noNotice:The notice has not been confirmed sent, so the window has not started. Re-send it.`;
  }
  if (s.stage_2_finding === null) {
    return s.can_start_stage_2
      ? $localize`:@@admin.vendors.suspension.terminate.blocked.needsStage2:A false-claim suspension needs stage 2 first: 7 more business days to prove identity and authority.`
      : $localize`:@@admin.vendors.suspension.terminate.blocked.windowOpen:The window of 7 business days is still open.`;
  }
  if (s.stage_2_notice_sent_at === null) {
    return $localize`:@@admin.vendors.suspension.terminate.blocked.noStage2Notice:The stage 2 notice has not been confirmed sent, so its window has not started. Re-send it.`;
  }
  return $localize`:@@admin.vendors.suspension.terminate.blocked.stage2Open:The stage 2 window of 7 business days is still open.`;
}

/** The API's error code, structurally: the admin area is lazily chunked (`http-status.ts`). */
function errorCode(err: unknown): string | null {
  const body = (err as { error?: { error?: { code?: unknown } } } | null)?.error;
  return typeof body?.error?.code === 'string' ? body.error.code : null;
}

export function isErrorCode(err: unknown, code: string): boolean {
  return errorCode(err) === code;
}

function errorStatus(err: unknown): unknown {
  return (err as { status?: unknown } | null)?.status;
}

/**
 * The error the state may be behind on: the page should reload. Everything the API answers
 * 409 is that, whichever write it was.
 */
export function isStaleError(err: unknown): boolean {
  return errorStatus(err) === 409;
}

/** One sentence per outcome the operator can act on. Every one of these saved nothing. */
export function suspensionErrorMessage(err: unknown): string {
  switch (errorCode(err)) {
    case 'VENDOR_SUSPENSION_STATE':
      return $localize`:@@admin.vendors.suspension.error.state:This suspension changed since the page loaded, so nothing was saved. Check the current state.`;
    case 'VENDOR_SUSPENSION_WINDOW_OPEN':
      return $localize`:@@admin.vendors.suspension.error.windowOpen:The window has not elapsed, so nothing was saved. There is no early path.`;
    case 'VENDOR_TERMINATION_REFUND_CHANGED':
      return $localize`:@@admin.vendors.suspension.error.refundChanged:The refund or the cost changed since this page loaded, so nothing was saved. Check the new numbers.`;
    case 'VENDOR_TERMINATION_STRIPE_UNAVAILABLE':
      return $localize`:@@admin.vendors.suspension.error.stripe:We could not read this vendor's payments from Stripe, so nothing was saved. Try again shortly.`;
    case 'VENDOR_SEATS_CHANGED':
      return $localize`:@@admin.vendors.suspension.error.seats:This vendor's seats changed while the request ran, so nothing was saved. Check the page and try again.`;
    case 'VENDOR_PROPOSALS_CHANGED':
      return $localize`:@@admin.vendors.suspension.error.proposals:A new product proposal for this vendor arrived while the request ran, so nothing was saved. Check the page and try again.`;
  }
  switch (errorStatus(err)) {
    case 400:
    case 422:
      return $localize`:@@admin.vendors.suspension.error.invalid:Check the fields and try again. Nothing was saved.`;
    case 403:
      return $localize`:@@admin.vendors.suspension.error.forbidden:You do not have permission to change this suspension.`;
    case 404:
      return $localize`:@@admin.vendors.suspension.error.notFound:We could not find that record. Reload the page.`;
    case 429:
      return $localize`:@@admin.vendors.suspension.error.rateLimited:Too many changes at once. Wait a minute, then try again.`;
  }
  return $localize`:@@admin.vendors.suspension.error.failed:Something went wrong. Please try again.`;
}

const BUTTON_BASE =
  'cursor-pointer rounded-(--radius-sm) border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/** The sibling controls' button, so this section reads as part of the same page. */
export const SUSPENSION_BUTTON = `${BUTTON_BASE} border-(--border-default) text-(--text-primary)`;
/** The confirm step of an action that cannot be undone from this screen. */
export const SUSPENSION_CONFIRM_BUTTON = `${BUTTON_BASE} border-(--text-primary) bg-(--text-primary) text-(--surface-base)`;
export const SUSPENSION_INPUT = `mt-2 ${FIELD_INPUT_CLASS}`;
