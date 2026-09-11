/**
 * Age-band alert throttling — "has this row crossed a threshold since the last
 * sweep?" (AECI-854, generalised by AECI-862).
 *
 * Two periodic jobs email an operator about rows that stay in a bad state: the
 * §6.7 reconciliation sweep (a request whose Linear issue was never created) and
 * the §6.2 claim-staleness check (a ticket nobody has started). Both face the same
 * hazard. Unthrottled, the reconciliation sweep sent **96 identical messages a
 * day, per row, forever**, against the Resend account that also carries Supabase
 * magic links — so a long outage could burn the allowance and stop sign-in.
 *
 * The fix is stateless on purpose: no `alerted_at` column, no migration,
 * consistent with ADR 0013's "no DLQ; the cadence re-runs". A row is emailed when
 * a threshold falls inside the window this run covers, which is derivable from
 * `created_at` and the cadence alone.
 *
 * The arithmetic lives here rather than in either caller because it is the part
 * that is easy to get subtly wrong — an off-by-one in the window comparison either
 * double-sends or skips a band silently — and it deserves one implementation with
 * one set of tests. `reconciliation-sweep.ts` re-exports its own bound form
 * (`crossedAlertBand`) so its existing callers and spec are unchanged.
 */

/**
 * Did a row of age `ageMinutes` cross one of `bands` within the last
 * `sinceMinutes`, or a `repeatMinutes` boundary past the final band?
 *
 * `sinceMinutes` is the job's cadence, so consecutive runs tile the timeline
 * without overlap: each threshold is crossed in exactly one window, hence exactly
 * one email.
 *
 * The trade this makes: a SKIPPED run (queue hiccup, a missed cron) can miss a
 * band, deferring that row's email to the next boundary. Accepted, because only
 * the EMAIL is throttled — callers keep their metric and their log unthrottled, so
 * the PostHog alert and the admin console are unaffected.
 *
 * `bands` must be ascending. The final-band guard is what stops a row younger than
 * the last band being caught by the day-zero `repeatMinutes` boundary.
 */
export function crossedBand(
  ageMinutes: number,
  sinceMinutes: number,
  bands: readonly number[],
  repeatMinutes: number,
): boolean {
  const previousAge = ageMinutes - sinceMinutes;
  for (const band of bands) {
    if (previousAge < band && ageMinutes >= band) return true;
  }
  const lastBand = bands[bands.length - 1];
  if (lastBand === undefined || ageMinutes < lastBand) return false;
  return Math.floor(previousAge / repeatMinutes) < Math.floor(ageMinutes / repeatMinutes);
}
