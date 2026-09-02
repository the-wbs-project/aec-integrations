/**
 * Referrer classification for `page_views` (AECI-526 follow-up).
 *
 * So the daily digest can answer "did we get traffic from LinkedIn / Twitter / Google
 * / other search engines?", each capture is tagged with a coarse traffic **source**
 * derived from the eyeball's HTTP `Referer`. The SSR Worker forwards that header on
 * full-document loads (`server-runtime.ts` `firePageView`) — the arrival path where an
 * external referrer actually exists; in-app SPA navigations are same-origin and fold
 * into "Direct".
 *
 * `classifyReferrer(referrer, selfHosts)` returns `{ source, host }`, persisted onto
 * each row as `referrer_source` (the digest group key) + `referrer` (the host only —
 * never the full URL/query, for privacy). `source` is never null: no/malformed/
 * same-origin referrer → "Direct"; a known host → its label; anything else → "Other".
 *
 * Best-effort by nature: browser Referrer-Policy and privacy tools strip or downgrade
 * the header, so real external traffic is UNDER-counted (a stripped LinkedIn click
 * lands in "Direct"). Historical rows captured before this shipped have no referrer
 * data and are simply excluded from the digest table (there is nothing to backfill —
 * the header was never stored).
 */

export interface ReferrerClass {
  /** Coarse traffic source: "Direct", a named site ("LinkedIn"), or "Other". */
  source: string;
  /** The external referrer host (lower-cased, no `www.`-strip), or null for Direct/self. */
  host: string | null;
}

/** Known referrer hosts → source label (first hit wins). Matched against the full
 *  hostname so subdomains (news.google.com, m.facebook.com) still resolve. */
const SOURCES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)google\./i, 'Google'],
  [/(^|\.)bing\.com$/i, 'Bing'],
  [/(^|\.)duckduckgo\.com$/i, 'DuckDuckGo'],
  [/(^|\.)yahoo\.com$|(^|\.)search\.yahoo\./i, 'Yahoo'],
  [/(^|\.)ecosia\.org$/i, 'Ecosia'],
  [/(^|\.)search\.brave\.com$/i, 'Brave Search'],
  [/(^|\.)yandex\./i, 'Yandex'],
  [/(^|\.)baidu\.com$/i, 'Baidu'],
  [/(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/i, 'LinkedIn'],
  [/(^|\.)t\.co$|(^|\.)twitter\.com$|(^|\.)x\.com$/i, 'Twitter/X'],
  [/(^|\.)facebook\.com$|(^|\.)fb\.com$|(^|\.)fb\.me$/i, 'Facebook'],
  [/(^|\.)instagram\.com$/i, 'Instagram'],
  [/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i, 'YouTube'],
  [/(^|\.)reddit\.com$|(^|\.)redd\.it$/i, 'Reddit'],
  [/(^|\.)news\.ycombinator\.com$/i, 'Hacker News'],
  [/(^|\.)github\.com$/i, 'GitHub'],
  [/(^|\.)t\.me$|(^|\.)telegram\./i, 'Telegram'],
  [/(^|\.)bsky\.app$|(^|\.)bluesky\./i, 'Bluesky'],
];

/**
 * Every label in {@link SOURCES}, deduped and frozen — i.e. the sources that are a
 * NAMED external site, excluding both `Direct` and `Other` (AECI-683).
 *
 * This is the "corroborated human" population the digest reports beside its upper
 * and lower bounds. A search engine or social network sending a real `Referer` is
 * the one server-side signal automation rarely bothers to fake: a rotating-proxy
 * pool sends no `Referer` at all, which is why 87 of the 2026-08-26 digest's 102
 * "human" views landed in `Direct`.
 *
 * Derived from the table rather than restated, so a source added above joins this
 * set automatically instead of quietly failing to.
 *
 * **Two honesty caveats that must travel with any number computed from this.**
 * It is a FLOOR, not a count of people: browser Referrer-Policy and privacy tools
 * strip the header, and every stripped referral lands in `Direct`. And a referrer
 * is a CLAIM — nothing verifies it and nothing can, since only the host is stored
 * (§9.7); production holds a confirmed forged `www.youtube.com` row. `Other` is
 * excluded precisely because it is an open bucket that a forger controls entirely.
 */
export const NAMED_REFERRER_SOURCES: readonly string[] = Object.freeze([
  ...new Set(SOURCES.map(([, name]) => name)),
]);

/** Classify one page-view capture's traffic source from its `Referer` header.
 *  `selfHosts` are the site's own hostnames (arrivals from these are same-origin
 *  internal navigation → "Direct"). */
export function classifyReferrer(
  referrer: string | null,
  selfHosts: readonly string[],
): ReferrerClass {
  if (!referrer) return { source: 'Direct', host: null };

  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return { source: 'Direct', host: null }; // malformed / relative → treat as Direct
  }
  if (!host) return { source: 'Direct', host: null };

  const bare = host.replace(/^www\./, '');
  if (selfHosts.some((h) => host === h || bare === h || host.endsWith(`.${h}`))) {
    return { source: 'Direct', host: null }; // same-origin / internal navigation
  }

  for (const [re, name] of SOURCES) {
    if (re.test(host)) return { source: name, host };
  }
  return { source: 'Other', host };
}
