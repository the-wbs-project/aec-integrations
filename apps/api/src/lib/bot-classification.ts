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
 * Cloudflare ASNs that are cloud / hosting / VPN / scanner networks — never consumer
 * eyeball ISPs. A browser-looking UA from one of these is a headless scraper, not a
 * visitor. The value is the label surfaced in the digest. Not exhaustive; extend as
 * new offenders appear, and keep `scripts/ops/backfill-page-view-bots.sql` in sync
 * (a spec asserts the two match exactly, so drift fails CI).
 *
 * Membership rule — the ASN's registered holder must be a hosting / cloud / CDN / VPN
 * / scanning business, so that NO residential subscriber can sit behind it. Verify a
 * candidate before adding it:
 *   curl -s "https://stat.ripe.net/data/as-overview/data.json?resource=AS<n>" | jq .data.holder
 * Deliberately EXCLUDED, with reasons, because each carries real humans:
 *   - AS714 Apple — Applebot self-names in its UA, and iCloud Private Relay egresses here.
 *   - AS22616 Zscaler and other corporate security proxies — that IS the office's browser.
 *   - AS208323 Applied Privacy / Tor exits — anonymity ≠ automation.
 *   - AS16591 Google Fiber, AS9808 China Mobile, AS58466 CHINANET IDC and every other
 *     mixed consumer/IDC network — a false positive deletes a human from the digest.
 *   - Tier-1 transit (AS3356 Lumen, AS6762 Sparkle, AS5511 Orange) — carries everyone.
 * The list below was assembled from the prod `page_views` ASN census on 2026-08-04
 * (every offender with recorded traffic) plus the major clouds/CDNs seen elsewhere.
 */
const DATACENTER_ASNS: ReadonlyMap<number, string> = new Map([
  // — Hyperscale clouds —
  [16509, 'Datacenter (AWS)'],
  [14618, 'Datacenter (AWS)'],
  [7224, 'Datacenter (AWS)'],
  [8987, 'Datacenter (AWS)'],
  [15169, 'Datacenter (Google)'],
  [19527, 'Datacenter (Google)'],
  [396982, 'Datacenter (Google Cloud)'],
  [139070, 'Datacenter (Google Cloud)'],
  [8075, 'Datacenter (Microsoft)'],
  [8068, 'Datacenter (Microsoft)'],
  [8069, 'Datacenter (Microsoft)'],
  [12076, 'Datacenter (Microsoft)'],
  [13335, 'Datacenter (Cloudflare)'],
  [31898, 'Datacenter (Oracle Cloud)'],
  [36351, 'Datacenter (IBM Cloud)'],
  [45102, 'Datacenter (Alibaba)'],
  [37963, 'Datacenter (Alibaba)'],
  [24429, 'Datacenter (Alibaba)'],
  [132203, 'Datacenter (Tencent)'],
  [45090, 'Datacenter (Tencent)'],
  [133478, 'Datacenter (Tencent)'],
  [55990, 'Datacenter (Huawei Cloud)'],
  [136907, 'Datacenter (Huawei Cloud)'],
  // — CDN / edge networks —
  [20940, 'Datacenter (Akamai)'],
  [63949, 'Datacenter (Akamai/Linode)'],
  [54113, 'Datacenter (Fastly)'],
  [60068, 'Datacenter (CDN77/DataCamp)'],
  [212238, 'Datacenter (CDN77/DataCamp)'],
  [202422, 'Datacenter (G-Core)'],
  // — Mainstream VPS / dedicated hosting —
  [16276, 'Datacenter (OVH)'],
  [24940, 'Datacenter (Hetzner)'],
  [213230, 'Datacenter (Hetzner)'],
  [212317, 'Datacenter (Hetzner)'],
  [14061, 'Datacenter (DigitalOcean)'],
  [20473, 'Datacenter (Vultr)'],
  [12876, 'Datacenter (Scaleway)'],
  [51167, 'Datacenter (Contabo)'],
  [197540, 'Datacenter (netcup)'],
  [214996, 'Datacenter (netcup)'],
  [8560, 'Datacenter (IONOS)'],
  [47583, 'Datacenter (Hostinger)'],
  [19318, 'Datacenter (InterServer)'],
  [22612, 'Datacenter (Namecheap)'],
  [26496, 'Datacenter (GoDaddy)'],
  [60781, 'Datacenter (Leaseweb)'],
  [16265, 'Datacenter (Leaseweb)'],
  [30633, 'Datacenter (Leaseweb)'],
  [395954, 'Datacenter (Leaseweb)'],
  [49981, 'Datacenter (WorldStream)'],
  [9009, 'Datacenter (M247)'],
  [62610, 'Datacenter (Zenlayer)'],
  [21859, 'Datacenter (Zenlayer)'],
  [36352, 'Datacenter (ColoCrossing)'],
  [47007, 'Datacenter (Colocation America)'],
  [46261, 'Datacenter (QuickPacket)'],
  [8100, 'Datacenter (QuadraNet)'],
  [18779, 'Datacenter (EGIHosting)'],
  [202425, 'Datacenter (IP Volume)'],
  [46475, 'Datacenter (Limestone Networks)'],
  [26548, 'Datacenter (PureVoltage)'],
  [42708, 'Datacenter (Glesys)'],
  [39351, 'Datacenter (31173 Services)'],
  [51747, 'Datacenter (Internet Vikings)'],
  [204770, 'Datacenter (Cherry Servers)'],
  [60404, 'Datacenter (Liteserver)'],
  [34343, 'Datacenter (Eweka)'],
  [14956, 'Datacenter (RouterHosting)'],
  [64286, 'Datacenter (LogicWeb)'],
  [203020, 'Datacenter (HostRoyale)'],
  [207990, 'Datacenter (HostRoyale)'],
  [200373, 'Datacenter (3xK Tech)'],
  [47890, 'Datacenter (Unmanaged Ltd)'],
  [51852, 'Datacenter (Private Layer)'],
  [51396, 'Datacenter (pfcloud)'],
  [210644, 'Datacenter (Aeza)'],
  [57523, 'Datacenter (Chang Way)'],
  // — Smaller VPS / proxy networks seen crawling prod —
  [142430, 'Datacenter (DIGI VPS)'],
  [150303, 'Datacenter (SoloRDP)'],
  [48090, 'Datacenter (DMZHost)'],
  [213790, 'Datacenter (Limited Network)'],
  [211590, 'Datacenter (Bucklog)'],
  [219502, 'Datacenter (Storm Industries)'],
  [213250, 'Datacenter (ITP-Solutions)'],
  [211693, 'Datacenter (NolimitCloud)'],
  [203919, 'Datacenter (LumaDock)'],
  [203363, 'Datacenter (Kuroit)'],
  [43180, 'Datacenter (Trunk Networks)'],
  [202412, 'Datacenter (Omegatech)'],
  [197769, 'Datacenter (VPS Dedicated)'],
  [62240, 'Datacenter (Clouvider)'],
  [62164, 'Datacenter (Heymman)'],
  [137409, 'Datacenter (GSL Networks)'],
  [135377, 'Datacenter (UCloud HK)'],
  [206804, 'Datacenter (EstNOC)'],
  [50245, 'Datacenter (Serverel)'],
  [22295, 'Datacenter (Advin Services)'],
  [197170, 'Datacenter (TechTies)'],
  [400529, 'Datacenter (Infraly)'],
  [399629, 'Datacenter (BL Networks)'],
  [205759, 'Datacenter (Ghosty Networks)'],
  [141039, 'Datacenter (PacketHub)'],
  [136787, 'Datacenter (PacketHub)'],
  [53514, 'Datacenter (UHQ Services)'],
  // — Internet-wide scanners / research crawlers —
  [398324, 'Censys (scanner)'],
  [398722, 'Censys (scanner)'],
  [213412, 'ONYPHE (scanner)'],
  [211298, 'Driftnet (scanner)'],
  // — Link-preview fetchers (a bot, but not a datacenter) —
  [40793, 'LinkedIn (link preview)'],
  [62041, 'Telegram (link preview)'],
]);

/** The `[asn, label]` pairs of `DATACENTER_ASNS`, in declaration order. Exposed so the
 *  spec can assert `scripts/ops/backfill-page-view-bots.sql` mirrors this table exactly
 *  (and so an ops script can regenerate that SQL) without exporting a mutable Map. */
export function datacenterAsnEntries(): ReadonlyArray<readonly [number, string]> {
  return [...DATACENTER_ASNS.entries()];
}

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
