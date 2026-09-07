//
// rules.mjs — the declarative description of the three WAF rules AECI-807 narrows,
// removing `prod.aecintegrations.com` from each expression's host set.
//
// docs/waf-rate-limits.md is the SOURCE OF TRUTH for these expressions. The literals
// below are transcribed from its §1/§2 tables; if you change one there, change it
// here in the same PR (and vice versa). Nothing in this directory invents a rule —
// apply.mjs refuses to touch any rule whose live expression is not one of the exact
// forms declared here, so a dashboard edit that drifted from the doc surfaces as an
// abort rather than as a silently mangled expression.
//
// This is the SECOND migration of these same three rules. The first was AECI-659
// (`../2026-09-waf-host-scope/`), which widened them from staging+demo to also cover
// `www.` and `prod.`. That directory's `before`/`after` pair is the historical record
// of that operation and is deliberately left untouched; this one's `before` is that
// one's `after`. Run them in order, or not at all — apply.mjs here aborts on a rule
// still carrying the pre-AECI-659 two-host form rather than skipping a generation.
//
// The API helpers are shared with the AECI-659 directory rather than copied: they are
// generic Rulesets-API plumbing with no operation-specific content, and two divergent
// copies of a `PATCH` helper is how a rollback goes wrong.
//

export {
  RULESETS,
  UsageError,
  cf,
  credentials,
  getRuleset,
  writableRule,
} from '../2026-09-waf-host-scope/rules.mjs';

import { RULESETS as _RULESETS } from '../2026-09-waf-host-scope/rules.mjs';
void _RULESETS; // re-exported above; imported here only to fail fast on a moved sibling

/**
 * The host set before AECI-807 (the AECI-659 four-host form) and after.
 *
 * `prod.aecintegrations.com` is removed because the hostname itself is being retired:
 * `apps/web/wrangler.jsonc` `env.production` no longer routes it, so the term matches
 * nothing. Leaving a dead host in a WAF expression is not neutral — it is the same
 * class of staleness AECI-659 existed to fix, read from the other direction, and the
 * next person auditing coverage has to prove the host is gone before they can ignore
 * the term.
 *
 * The other three are unchanged and stay unchanged: `www.` is live production,
 * `demo.` is the public showcase, `staging.` is Access-gated but still worth the
 * rules. The bare apex remains deliberately absent — it 301s to `www.` at the edge,
 * so a request never reaches a path these rules match under the apex host.
 */
export const OLD_HOSTS = [
  'staging.aecintegrations.com',
  'demo.aecintegrations.com',
  'www.aecintegrations.com',
  'prod.aecintegrations.com',
];
export const NEW_HOSTS = [
  'staging.aecintegrations.com',
  'demo.aecintegrations.com',
  'www.aecintegrations.com',
];

const hostClause = (hosts) => `http.host in {${hosts.map((h) => `"${h}"`).join(' ')}}`;

// Rule A's path predicate, in its post-AECI-659 form. UNCHANGED by this operation —
// only the host set moves. It is spelled out rather than imported so that a live rule
// is still compared against a complete literal, which is the whole point of this file.
const RULE_A_PATHS =
  'starts_with(http.request.uri.path, "/api/requests/") or http.request.uri.path eq "/api/subscribe" or http.request.uri.path eq "/api/feedback"';

const ruleAExpr = (hosts) =>
  `(${hostClause(hosts)}) and (http.request.method eq "POST") and (${RULE_A_PATHS})`;

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
 * `before`  — the exact post-AECI-659 expression, per the doc.
 * `after`   — the same expression with `prod.` dropped from the host set.
 *
 * No `description` field on any of them, deliberately: AECI-659 rewrote Rule A's label
 * because folding in the lead-capture paths made the old one false. Narrowing the host
 * set makes nothing false — none of the three labels names a host — so nothing here
 * touches a description, and a run of this script leaves them exactly as they are.
 *
 * A live rule matching `after` is already migrated (apply.mjs reports `already-current`
 * and skips it, so the script is idempotent). A live rule matching neither is drift:
 * apply.mjs aborts rather than guessing. The most likely such drift is a rule still on
 * the pre-AECI-659 two-host form — run that directory first.
 */
export const TARGETS = [
  {
    key: 'rule-a',
    ruleset: 'ratelimit',
    label: 'Rule A — POST /api/requests/* + /api/subscribe + /api/feedback (5/IP/min, block 1h)',
    marker: '/api/requests/',
    before: ruleAExpr(OLD_HOSTS),
    after: ruleAExpr(NEW_HOSTS),
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
