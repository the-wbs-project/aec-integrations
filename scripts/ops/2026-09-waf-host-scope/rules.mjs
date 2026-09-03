//
// rules.mjs — the declarative description of the three WAF rules AECI-659 touches,
// plus the Cloudflare Rulesets API helpers the three scripts share.
//
// docs/waf-rate-limits.md is the SOURCE OF TRUTH for these expressions. The literals
// below are transcribed from its §1/§2 tables; if you change one there, change it
// here in the same PR (and vice versa). Nothing in this directory invents a rule —
// apply.mjs refuses to touch any rule whose live expression is not one of the exact
// forms declared here, so a dashboard edit that drifted from the doc surfaces as an
// abort rather than as a silently mangled expression.
//

/** Zone-level ruleset ids (docs/waf-rate-limits.md "Deployed state"). */
export const RULESETS = {
  ratelimit: '6ba381516e4c4c37af85631a68b04ef6',
  custom: '974122bb23af4354a215724d9c7e8436',
};

/**
 * The host set before AECI-659 (staging + demo only) and after.
 *
 * `www.` is live production since the apex cutover (AECI-247/277) and was in NONE of
 * the expressions — the whole bug. `prod.` serves production content too (an
 * indexable duplicate; its own fix is a separate issue) so it is covered here.
 * The bare apex is deliberately absent: it 301s to `www.` at the edge, so a request
 * never reaches a path these rules match under the apex host.
 */
export const OLD_HOSTS = ['staging.aecintegrations.com', 'demo.aecintegrations.com'];
export const NEW_HOSTS = [
  'staging.aecintegrations.com',
  'demo.aecintegrations.com',
  'www.aecintegrations.com',
  'prod.aecintegrations.com',
];

const hostClause = (hosts) => `http.host in {${hosts.map((h) => `"${h}"`).join(' ')}}`;

// Rule A's path predicate. AECI-659 widens it from the /api/requests/ prefix alone to
// also cover the two lead-capture endpoints, which never had a rule anywhere. Pro caps
// the zone at 2 rate-limit rules and both slots are spent, so widening an existing
// predicate is the only way to cover them without giving something else up. The three
// families share one counter — fine, nobody legitimately submits five forms a minute.
const RULE_A_PATHS_OLD = 'starts_with(http.request.uri.path, "/api/requests/")';
const RULE_A_PATHS_NEW =
  'starts_with(http.request.uri.path, "/api/requests/") or http.request.uri.path eq "/api/subscribe" or http.request.uri.path eq "/api/feedback"';

const ruleAExpr = (hosts, paths) =>
  `(${hostClause(hosts)}) and (http.request.method eq "POST") and (${paths})`;

const ruleBExpr = (hosts) =>
  `(${hostClause(hosts)}) and (http.request.method eq "POST") and (http.request.uri.path eq "/api/reviews")`;

const SCRAPER_PATHS =
  'starts_with(http.request.uri.path, "/products") or starts_with(http.request.uri.path, "/vendors") or http.request.uri.path eq "/api/products" or http.request.uri.path eq "/api/vendors"';

// Specific tool/library UA tokens only — deliberately NOT generic bot/crawler/spider
// substrings, which many legitimate-but-unverified crawlers carry. See §2 of the doc.
const SCRAPER_UAS = [
  'scrapy',
  'python-requests',
  'httpx',
  'curl',
  'wget',
  'go-http-client',
  'java/',
  'okhttp',
  'node-fetch',
  'scraper',
]
  .map((token) => `lower(http.user_agent) contains "${token}"`)
  .join(' or ');

const scraperExpr = (hosts) =>
  `(${hostClause(hosts)}) and (not cf.client.bot) and (${SCRAPER_PATHS}) and (${SCRAPER_UAS} or http.user_agent eq "")`;

/**
 * The three rules to migrate.
 *
 * `marker`  — a substring unique to this rule within its ruleset, used only to locate
 *             the rule (and to produce a useful diff when its expression has drifted).
 * `description` — optional. When present, the rule's dashboard description is rewritten
 *             alongside the expression. Only Rule A declares one: its live description
 *             claimed it "matches spec §15.1 exactly", which stops being true once the
 *             lead-capture paths are folded in. A rule whose label misdescribes what it
 *             covers is how this whole class of drift starts.
 * `before`  — the exact pre-AECI-659 expression, per the doc.
 * `after`   — the exact post-AECI-659 expression. This is what gets written.
 *
 * A live rule matching `after` is already migrated (apply.mjs reports `already-current`
 * and skips it, so the script is idempotent). A live rule matching neither is drift:
 * apply.mjs aborts rather than guessing.
 */
export const TARGETS = [
  {
    key: 'rule-a',
    ruleset: 'ratelimit',
    label: 'Rule A — POST /api/requests/* + /api/subscribe + /api/feedback (5/IP/min, block 1h)',
    marker: '/api/requests/',
    description:
      '/api/requests/* + /api/subscribe + /api/feedback submissions (per IP) — spec §15.1 plus the two lead-capture endpoints (AECI-659)',
    before: ruleAExpr(OLD_HOSTS, RULE_A_PATHS_OLD),
    after: ruleAExpr(NEW_HOSTS, RULE_A_PATHS_NEW),
  },
  {
    key: 'rule-b',
    ruleset: 'ratelimit',
    label: 'Rule B — POST /api/reviews (5/IP/min, block 1h)',
    marker: '"/api/reviews"',
    before: ruleBExpr(OLD_HOSTS),
    after: ruleBExpr(NEW_HOSTS),
  },
  {
    key: 'scraper',
    ruleset: 'custom',
    label: 'Scraper-UA Managed Challenge — /products, /vendors + their JSON APIs',
    marker: 'python-requests',
    before: scraperExpr(OLD_HOSTS),
    after: scraperExpr(NEW_HOSTS),
  },
];

/**
 * Server-owned fields the Rulesets API rejects on write — stripped before a PATCH
 * echoes a rule back. `ref` is deliberately NOT stripped: it is writable, it is how
 * rules stay correlated across versions, and dropping it would reset it.
 */
const READ_ONLY_RULE_FIELDS = ['id', 'version', 'last_updated', 'categories'];

export function writableRule(rule) {
  const out = { ...rule };
  for (const field of READ_ONLY_RULE_FIELDS) delete out[field];
  return out;
}

const API = 'https://api.cloudflare.com/client/v4';

export function credentials() {
  const zone = process.env.CF_ZONE_ID;
  const token = process.env.CF_WAF_API_TOKEN;
  if (!zone || !token) {
    throw new UsageError(
      'CF_ZONE_ID and CF_WAF_API_TOKEN must both be set.\n' +
        '  CF_ZONE_ID          — the aecintegrations.com zone id (same value CI pushes to the Workers).\n' +
        '  CF_WAF_API_TOKEN    — a Cloudflare API token scoped to Zone WAF: Read (snapshot) or Zone WAF: Edit (apply).',
    );
  }
  return { zone, token };
}

export class UsageError extends Error {}

/** Minimal Cloudflare API caller. Throws on a non-2xx or a `success: false` envelope. */
export async function cf(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    const detail =
      body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') ?? `HTTP ${res.status}`;
    throw new Error(`Cloudflare API ${init.method ?? 'GET'} ${path} failed — ${detail}`);
  }
  return body.result;
}

export const getRuleset = (token, zone, rulesetId) =>
  cf(token, `/zones/${zone}/rulesets/${rulesetId}`);
