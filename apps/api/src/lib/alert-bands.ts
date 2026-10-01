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

/**
 * Which band a row of age `ageMinutes` is in (AECI-1203). The dedupe key of a
 * band-throttled alert carries it, so a queue retry or a double cron tick inside one
 * window re-derives the same key and the send ledger refuses the second email.
 *
 * - `null` below the first band: the row has not earned an email yet.
 * - `i` for `bands[i] <= age < bands[i + 1]`.
 * - Past the last band, `bands.length - 1 + n`, where `n` counts the `repeatMinutes`
 *   boundaries (multiples of `repeatMinutes`, measured from age 0, as in
 *   {@link crossedBand}) in `(lastBand, age]`.
 *
 * So for the sweep's `[60, 360]` with a daily repeat: 60 min is 0, 6 h is 1, 24 h is 2,
 * 48 h is 3. For the stale check's `[1440]` with a daily repeat: 24 h is 0 and 48 h is
 * 1, because a repeat boundary that coincides with the last band is that band's own
 * email, exactly as {@link crossedBand} sends one email there, not two.
 *
 * Every age at which {@link crossedBand} says "email" starts a new index, so one key
 * per index is one email per crossing.
 */
export function bandIndex(
  ageMinutes: number,
  bands: readonly number[],
  repeatMinutes: number,
): number | null {
  const lastBand = bands[bands.length - 1];
  if (lastBand === undefined || bands[0] === undefined || ageMinutes < bands[0]) return null;
  if (ageMinutes < lastBand) {
    let index = 0;
    while (index + 1 < bands.length && ageMinutes >= bands[index + 1]!) index++;
    return index;
  }
  const repeats = Math.floor(ageMinutes / repeatMinutes) - Math.floor(lastBand / repeatMinutes);
  return bands.length - 1 + repeats;
}

/**
 * The send-ledger dedupe key for a band-throttled digest (AECI-1203):
 * `{template}:{requestId}:{bandIndex}` for one row, and the rows' `{requestId}:{band}`
 * pairs sorted and joined by `,` for several. The digest is one email, so it takes one
 * key, and the sort makes the key independent of read order. A replay that sees the
 * same rows in the same bands builds the same key and sends nothing.
 *
 * The trade: a replay that sees a DIFFERENT set (a row cleared between the two runs)
 * builds a different key and sends the smaller digest. That needs a retry to straddle
 * a state change inside one 15-minute window, and it re-sends an alert, never loses one.
 */
export function bandDigestKey(
  template: string,
  rows: ReadonlyArray<{ requestId: string; band: number }>,
): string {
  // Binary order on purpose: these are ids, not names (`API_CONTRACTS.md` §3.2).
  const parts = rows
    .map((r) => `${r.requestId}:${r.band}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `${template}:${parts.join(',')}`;
}
