/**
 * The Google re-crawl priority tiers (AECI-945 / §20.2).
 *
 * ─── Why this is ordering rather than filtering ───────────────────────────────
 *
 * Google's Search Console "Request Indexing" action has a per-property daily
 * ceiling. It is real, Google does not publish the number, and Google changes it
 * without notice. A heavy curation session can exhaust it outright.
 *
 * Two ways to live inside a cap: drop the low-value work, or rank it. **This
 * module ranks.** A filter is silently lossy — the operator never sees what was
 * discarded, so a rule that turns out to be wrong is undetectable. Ranking keeps
 * everything, spends the quota top-down, and simply leaves tier 4 unreached on a
 * busy week. The failure mode is "I didn't get to it", which is visible on the
 * screen, rather than "it never existed".
 *
 * ─── The tiers ────────────────────────────────────────────────────────────────
 *
 * The ranking is a **diagonal over two axes**, which is why it lands on four
 * tiers rather than three:
 *
 *   page type   →  product (0)  ·  vendor (1)  ·  pair (2)
 *   change class →  page is new (1)  ·  material edit (2)  ·  minor edit (bottom)
 *
 * so a vendor page sits exactly one tier below the same event on a product page,
 * and an integration-pair page one below that. Tier 4 is the bucket that may
 * never be reached.
 *
 *   1  a new product page
 *   2  a new vendor page, or a material change to an existing product page
 *   3  a new pair page, a newly published trade page, or a material change to a
 *      vendor page
 *   4  a change to an existing pair page, or any minor edit anywhere
 *
 * ─── Why a MAP and not a formula ──────────────────────────────────────────────
 *
 * `pageTypeRank + changeClassRank` reproduces the table above exactly, and is
 * tempting. It is rejected on purpose: the moment one reason needs to sit
 * somewhere the formula does not put it — and `trade.published` is already that
 * case, since a trade page is neither product nor vendor nor pair — the formula
 * has to be rewritten rather than edited. A map is what a re-tune touches, and a
 * re-tune is expected (see `POST_LAUNCH_MONITORING.md`'s tunable-threshold
 * table for how this repo treats numbers like these).
 *
 * The map is **exhaustive over {@link GscRecrawlReason} at the type level**, so a
 * new reason cannot ship untiered — adding a member to the union without adding
 * a row here is a compile error, not a row that silently sorts as `undefined`.
 */

/**
 * Why a URL is on the worklist.
 *
 * A stable slug rather than prose, because it is read twice: once by
 * {@link GSC_RECRAWL_PRIORITY} to assign the tier, and once by the operator as
 * the screen's "why is this here" column.
 *
 * `*.minor` covers an edit that changes the page without changing what it says —
 * a logo swap, a link change. It is deliberately a separate reason from
 * `*.updated` rather than a flag, so the tier lookup stays a single map read.
 */
export type GscRecrawlReason =
  | 'product.created'
  | 'product.updated'
  | 'product.minor'
  | 'vendor.created'
  | 'vendor.updated'
  | 'vendor.minor'
  | 'pair.created'
  | 'pair.updated'
  | 'trade.published';

/** Highest priority a row can carry. Lower number sorts first. */
export const GSC_RECRAWL_MIN_PRIORITY = 1;

/** Lowest priority a row can carry — the may-never-be-reached bucket. */
export const GSC_RECRAWL_MAX_PRIORITY = 4;

/**
 * Reason → tier. The single place a re-tune happens.
 *
 * Typed as `Record<GscRecrawlReason, number>` rather than inferred, which is what
 * makes the exhaustiveness a compile error rather than a runtime `undefined`.
 */
export const GSC_RECRAWL_PRIORITY: Record<GscRecrawlReason, number> = {
  // Tier 1 — a product page that did not exist before. The highest-value thing
  // the catalogue produces, and the only reason that gets this tier.
  'product.created': 1,

  // Tier 2 — a new vendor page, or a product page whose copy actually changed.
  'vendor.created': 2,
  'product.updated': 2,

  // Tier 3 — a new pair page, a trade page crossing the publication floor into
  // indexability, or a vendor page whose copy changed.
  'pair.created': 3,
  'trade.published': 3,
  'vendor.updated': 3,

  // Tier 4 — an edit to an already-indexed pair page, and every minor edit.
  // Queued so nothing is lost, ranked last so nothing above it waits.
  'pair.updated': 4,
  'product.minor': 4,
  'vendor.minor': 4,
};

/** The tier for `reason`. Total over the union by construction. */
export function gscRecrawlPriority(reason: GscRecrawlReason): number {
  return GSC_RECRAWL_PRIORITY[reason];
}

/**
 * One URL to request indexing for, with the reason that put it there.
 *
 * `priority` is deliberately NOT a field: it is derived from `reason` at the
 * moment of insert, so a call site cannot disagree with the map.
 */
export interface GscRecrawlEntry {
  url: string;
  reason: GscRecrawlReason;
}

/**
 * Collapse duplicate URLs, keeping the **most important** reason for each.
 *
 * A single promote can reach the same URL twice — a product that is both created
 * and has a trade published, say. Emitting both would violate the table's unique
 * index and force the conflict path to arbitrate something the caller already
 * knows. Resolving it here means the INSERT's `DO UPDATE` only ever arbitrates
 * between *separate* writes, which is the case it exists for.
 *
 * Ties keep the first occurrence, which is stable because every deriver walks the
 * response in a fixed order.
 */
export function dedupeByBestPriority(entries: readonly GscRecrawlEntry[]): GscRecrawlEntry[] {
  const best = new Map<string, GscRecrawlEntry>();
  for (const entry of entries) {
    const existing = best.get(entry.url);
    if (!existing || gscRecrawlPriority(entry.reason) < gscRecrawlPriority(existing.reason)) {
      best.set(entry.url, entry);
    }
  }
  return [...best.values()];
}
