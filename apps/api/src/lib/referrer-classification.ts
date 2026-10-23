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
