/**
 * Page-view collection-method changes (AECI-1346), the code form of
 * `docs/POST_LAUNCH_MONITORING.md` §3d.
 *
 * A change to HOW `page_views` rows are written moves every count built on them,
 * with no change in traffic. §3d is the dated record. This constant is what the
 * readers consume: `/admin/overview` and the 05:00 digest flag a window that
 * spans a row, and never blend across it.
 *
 * `collection-method-changes.spec.ts` parses the §3d table and asserts it equals
 * this list. A new doc row without a code row, or the reverse, fails CI. So a new
 * row is one PR that edits both.
 *
 * Two treatments, decided per row by `arrivalsComparable`:
 *
 *  - `false`: the classifier-seam treatment. Day-over-day class deltas (and the
 *    digest's crawler delta) that span the row are suppressed.
 *  - `true`: informational. The note fires and the chart draws the boundary, but
 *    the deltas stand, because §3d records that arrival counts stay comparable.
 */

/** The deployed tiers (`ENV` values). Local dev is none of them. */
export type DeployTier = 'staging' | 'demo' | 'production';

export interface CollectionMethodChange {
  /** When the change deployed, ISO 8601 UTC. */
  at: string;
  /** The tier it deployed to. */
  tier: DeployTier;
  /** The deploy's short commit SHA, as §3d prints it. */
  sha: string;
  /** The Linear issue that shipped it. */
  issue: string;
  /** One line naming the change. Repeated in the note and the email. */
  summary: string;
  /** Whether arrival counts stay comparable across the change (§3d's last column). */
  arrivalsComparable: boolean;
}

export const COLLECTION_METHOD_CHANGES: readonly CollectionMethodChange[] = [
  {
    at: '2026-10-21T10:38:00.000Z',
    tier: 'staging',
    sha: 'faa81a01f',
    issue: 'AECI-1297',
    summary: 'the SSR gateway writes the arrival row on a cache hit as well as a miss',
    arrivalsComparable: false,
  },
  {
    at: '2026-10-22T02:40:00.000Z',
    tier: 'demo',
    sha: '957951a08',
    issue: 'AECI-1443',
    summary: 'native cache enabled; arrival rows survive a cache hit',
    arrivalsComparable: true,
  },
  {
    at: '2026-10-22T03:53:00.000Z',
    tier: 'production',
    sha: '88cedfbc3',
    issue: 'AECI-1443',
    summary: 'native cache enabled; arrival rows survive a cache hit',
    arrivalsComparable: true,
  },
  {
    at: '2026-10-23T04:02:00.000Z',
    tier: 'staging',
    sha: 'fedd6e1e7',
    issue: 'AECI-1460',
    summary:
      'residual and AutomationExclusion retired; traffic.page_views_human_after_automation frozen',
    arrivalsComparable: true,
  },
  {
    at: '2026-10-26T01:30:00.000Z',
    tier: 'demo',
    sha: '08033ebd6',
    issue: 'AECI-1460',
    summary:
      'residual and AutomationExclusion retired; traffic.page_views_human_after_automation frozen',
    arrivalsComparable: true,
  },
  {
    at: '2026-10-26T08:15:00.000Z',
    tier: 'production',
    sha: '0cb6f1203',
    issue: 'AECI-1460',
    summary:
      'residual and AutomationExclusion retired; traffic.page_views_human_after_automation frozen',
    arrivalsComparable: true,
  },
];

/**
 * The rows for this tier whose `at` falls in `[startIso, endIso)`, oldest first.
 *
 * `env` is the raw `ENV` var. Anything other than `staging`, `demo` or
 * `production` is a local run and matches no row: a local D1 never had the
 * deployed tier's collection history.
 */
export function collectionMethodSeam(
  env: string | undefined | null,
  window: { startIso: string; endIso: string },
  changes: readonly CollectionMethodChange[] = COLLECTION_METHOD_CHANGES,
): CollectionMethodChange[] {
  const startMs = Date.parse(window.startIso);
  const endMs = Date.parse(window.endIso);
  return changes
    .filter((c) => {
      if (c.tier !== env) return false;
      const at = Date.parse(c.at);
      return at >= startMs && at < endMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** True when any of `rows` breaks comparability. */
export function anyNotComparable(rows: readonly CollectionMethodChange[]): boolean {
  return rows.some((r) => !r.arrivalsComparable);
}
