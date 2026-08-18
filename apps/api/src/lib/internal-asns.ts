/**
 * `ANALYTICS_INTERNAL_ASNS` — the admin panel's **read-time** internal-traffic
 * filter (AECI-574 / `ADMIN_PANEL_SPEC.md` §13 **D10**).
 *
 * ─── This module is deliberately NOT `lib/bot-classification.ts` ─────────────
 *
 * `DATACENTER_ASNS` (over there) writes `is_bot` at ingest: permanent,
 * unreviewable, and destructive of a real person's row — which is why its
 * membership doctrine is strict ("NO residential subscriber can sit behind it …
 * a false positive deletes a human from the digest").
 *
 * This list is a different kind of object: a `WHERE` clause evaluated when a
 * chart is drawn. Nothing stored changes, it is toggleable per query, and it is
 * trivially reversible. That doctrine therefore does not transfer — and the two
 * lists must stay separate concepts. Three constraints are binding, and a review
 * checks all three:
 *
 *   1. **Query-time only.** Never touches `is_bot`, never runs at ingest, never
 *      enters `scripts/ops/backfill-page-view-bots.sql`.
 *   2. **Show both numbers, never substitute.** Callers report the unfiltered
 *      count as the primary figure and only ever ADD the filtered one beside it
 *      (`AdminCount` in `@aeci/shared`). §1.1 forbids reporting the filtered
 *      figure as *the* figure.
 *   3. **Declare the seam, ship it unset.** No ASN is hardcoded anywhere. Absent
 *      var → {@link parseInternalAsns} returns `[]` → the filter is unavailable
 *      and the UI hides the toggle.
 */

import { isNull, notInArray, or, type SQL } from 'drizzle-orm';

import { pageViews } from '../db/schema';

/**
 * Parse the env var into ASNs. Lenient by design, mirroring the `parseRecipients`
 * splitter (`lib/email.ts`) — the only list-var precedent in this Worker:
 * comma / semicolon / whitespace separated, an optional case-insensitive `AS`
 * prefix tolerated, non-numeric entries dropped rather than fatal, order
 * preserved, duplicates collapsed.
 *
 * A misconfigured var degrades to "fewer ASNs excluded", never to a 500 on an
 * operator's dashboard.
 *
 * @returns the configured ASNs; `[]` when unset/blank/all-junk, which callers
 *   read as **filter unavailable**.
 */
export function parseInternalAsns(raw: string | undefined): number[] {
  if (!raw) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const token of raw.split(/[,;\s]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    // `AS23700` and `23700` are the same ASN written two ways; operators copy
    // either form out of a WHOIS lookup or the §14.2 census.
    const digits = trimmed.replace(/^as/i, '');
    if (!/^\d+$/.test(digits)) continue;
    const asn = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(asn) || asn <= 0 || seen.has(asn)) continue;
    seen.add(asn);
    out.push(asn);
  }
  return out;
}

/**
 * The `WHERE` fragment that excludes internal traffic from a `page_views` query.
 *
 * **The NULL trap this exists to avoid:** a bare `cf_asn NOT IN (…)` evaluates to
 * NULL — i.e. *not true*, i.e. excluded — for every row whose `cf_asn` is NULL.
 * Cloudflare does not always populate the ASN, so a naive predicate would
 * silently delete real human rows from the filtered count and make the
 * "excluding internal" figure understate reality. The `IS NULL OR NOT IN` shape
 * keeps unknown-ASN rows in.
 *
 * @returns the predicate, or `undefined` when there is nothing to exclude (so
 *   the caller can spread it into `and(...)` unconditionally).
 */
export function excludeInternalAsns(asns: readonly number[]): SQL | undefined {
  if (asns.length === 0) return undefined;
  return or(isNull(pageViews.cfAsn), notInArray(pageViews.cfAsn, [...asns]));
}
