/**
 * Traffic classification for `page_views` (AECI-526 follow-up).
 *
 * The daily analytics digest must separate human visitors from crawlers/bots, but
 * the two clean signals are unavailable: the Cloudflare Pro plan yields no bot score
 * (`cf_bot_score` is always null — see `home-stats.ts`) and the ingest path never
 * captures an authenticated `user_id`. So we classify from what we DO have at
 * ingest: the raw User-Agent (which names the crawler) and the Cloudflare ASN (which
 * unmasks headless scrapers that spoof a browser UA from a datacenter).
 *
 * `classifyTraffic(ua, asn)` returns `{ isBot, botName }`, persisted onto each
 * `page_views` row (`is_bot` / `bot_name`). The digest then reports human-only counts
 * and a "Crawler activity" breakdown grouped by `bot_name`. The raw UA is discarded
 * after hashing, so this MUST run at ingest — historical rows can only be
 * re-classified by ASN alone (`classifyTraffic(null, asn)`, which is what the
 * `scripts/ops/backfill-page-view-bots.sql` one-time backfill mirrors).
 *
 * This is a maintained heuristic, not ground truth: a residential-proxy botnet can
 * read as human, and a real visitor on a corporate VPN / cloud egress can read as a
 * bot. It is decisive against the search / SEO / LLM crawlers that dominate
 * pre-launch traffic; the eventual human source of truth is the PostHog join
 * (AECI-239).
 */

export interface TrafficClass {
  /** True when the request looks automated (named crawler UA, generic bot UA, or datacenter ASN). */
  isBot: boolean;
  /** Human-readable source when `isBot` — a crawler name ("Googlebot") or a datacenter
   *  org ("Datacenter (AWS)"); null for humans. Used as the digest's crawler group key. */
  botName: string | null;
}

/** Named crawlers, matched against the User-Agent (first hit wins). Ordered by
 *  specificity so a UA carrying several tokens gets the most useful label. */
const NAMED_BOTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/googlebot|google-inspectiontool|storebot-google|google-extended|apis-google/i, 'Googlebot'],
  [/bingbot|bingpreview|adidxbot|msnbot/i, 'Bingbot'],
  [/applebot/i, 'Applebot'],
  [/duckduckbot|duckduckgo/i, 'DuckDuckBot'],
  [/yandex(bot|images|webmaster)/i, 'YandexBot'],
  [/baiduspider/i, 'Baiduspider'],
  [/gptbot/i, 'GPTBot (OpenAI)'],
  [/oai-searchbot|chatgpt-user/i, 'OpenAI'],
  [/claudebot|claude-web|anthropic-ai/i, 'ClaudeBot (Anthropic)'],
  [/perplexitybot|perplexity-user/i, 'PerplexityBot'],
  [/amazonbot/i, 'Amazonbot'],
  [/bytespider|bytedance/i, 'Bytespider (ByteDance)'],
  [/meta-externalagent|facebookexternalhit|facebookbot/i, 'Meta'],
  [/ahrefsbot/i, 'AhrefsBot'],
  [/semrushbot/i, 'SemrushBot'],
  [/mj12bot/i, 'MJ12bot'],
  [/dotbot/i, 'DotBot'],
  [/petalbot/i, 'PetalBot'],
  [/dataforseobot/i, 'DataForSeoBot'],
  [/censysinspect|censys/i, 'Censys (scanner)'],
  [/uptimerobot|pingdom|statuscake|site24x7|newrelicpinger/i, 'Uptime monitor'],
];

/** Generic automation tokens for anything left that self-identifies as non-human.
 *  Intentionally excludes "preview" (matches "Safari Technology Preview") and bare
 *  "scan" (over-broad); "bot" is broad but browser UAs never contain it. */
const GENERIC_BOT_RE =
  /bot|crawl|spider|scraper|slurp|headless|phantom|python-requests|python-urllib|go-http-client|node-fetch|okhttp|libwww|httpclient|scanner|facebookexternalhit|curl\/|wget\//i;

/**
 * Cloudflare ASNs that are cloud / hosting / scanner networks — never consumer
 * eyeball ISPs. A browser-looking UA from one of these is a headless scraper, not a
 * visitor. The value is the label surfaced in the digest. Not exhaustive; extend as
 * new offenders appear, and keep `scripts/ops/backfill-page-view-bots.sql` in sync.
 * Apple (AS714) is deliberately EXCLUDED — Applebot self-names in its UA, and iCloud
 * Private Relay egress (real humans) must not be swept up.
 */
const DATACENTER_ASNS: ReadonlyMap<number, string> = new Map([
  [16509, 'Datacenter (AWS)'],
  [14618, 'Datacenter (AWS)'],
  [15169, 'Datacenter (Google)'],
  [396982, 'Datacenter (Google Cloud)'],
  [19527, 'Datacenter (Google)'],
  [8075, 'Datacenter (Microsoft)'],
  [8068, 'Datacenter (Microsoft)'],
  [13335, 'Datacenter (Cloudflare)'],
  [14061, 'Datacenter (DigitalOcean)'],
  [16276, 'Datacenter (OVH)'],
  [24940, 'Datacenter (Hetzner)'],
  [45102, 'Datacenter (Alibaba)'],
  [37963, 'Datacenter (Alibaba)'],
  [24429, 'Datacenter (Alibaba)'],
  [132203, 'Datacenter (Tencent)'],
  [45090, 'Datacenter (Tencent)'],
  [9009, 'Datacenter (M247)'],
  [20473, 'Datacenter (Vultr)'],
  [63949, 'Datacenter (Akamai/Linode)'],
  [31898, 'Datacenter (Oracle Cloud)'],
  [12876, 'Datacenter (Scaleway)'],
  [398324, 'Censys (scanner)'],
  [202425, 'Datacenter (IP Volume)'],
  [46261, 'Datacenter (QuadraNet)'],
  [18779, 'Datacenter (EGIHosting)'],
]);

/** Classify one page-view capture as human or bot from its User-Agent + ASN. */
export function classifyTraffic(ua: string | null, asn: number | null): TrafficClass {
  if (ua) {
    for (const [re, name] of NAMED_BOTS) {
      if (re.test(ua)) return { isBot: true, botName: name };
    }
    if (GENERIC_BOT_RE.test(ua)) return { isBot: true, botName: 'Other bot' };
  }
  if (asn !== null) {
    const label = DATACENTER_ASNS.get(asn);
    if (label) return { isBot: true, botName: label };
  }
  return { isBot: false, botName: null };
}
