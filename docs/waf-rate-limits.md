# Cloudflare WAF — rate limits & scraper block on the public endpoints

Operator runbook for the WAF rate-limiting and scraper-blocking rules that protect
the public write / abuse-prone surface (the Phase 5/6 endpoints), on the
`aecintegrations.com` zone. The rules are **live** — see [Deployed state](#deployed-state).
This doc is the source of truth for their definitions and is where you inspect,
re-tune, or reproduce them (in the dashboard under **Security → WAF**, or via the
Rulesets API).

**Referenced by:** [`STAGE_1_SPEC.md`](./STAGE_1_SPEC.md) §15.1; Linear AECI-242 (Phase 7.7). Companion to [`access.md`](./access.md) (Cloudflare Access on the same zone).

> **Why not config-as-code in CI?** AECI-242's acceptance criteria asked for
> config-as-code (Terraform / CF API). For launch the rules were applied directly
> via the CF Rulesets API (a one-time, reviewed apply) with **this runbook** as the
> source of truth, rather than standing up a Terraform/CI pipeline: the repo has no
> Terraform, the rule set is small and rarely changes, and pre-launch abuse risk is
> low. Re-introducing a CI apply step (mirroring the Algolia/cache-purge "PUT
> declarative config to the CF Rulesets API" pattern) is a clean later upgrade if
> churn justifies it. **If you change a rule in the dashboard, update this doc in
> the same PR.**
>
> **Partial follow-through (AECI-659, 2026-09):** the host-set extension shipped as a
> checked-in operator script, [`scripts/ops/2026-09-waf-host-scope/`](../scripts/ops/2026-09-waf-host-scope/README.md)
> — snapshot, dry-run diff, idempotent per-rule `PATCH`, and a re-runnable probe. It is
> not a CI apply and does not make the rules config-as-code, but it does make a host-set
> change diffable, revertible, and reproducible instead of a hand-typed dashboard edit.

---

## Deployed state

Applied to zone `aecintegrations.com` via the CF Rulesets API (token scoped to
`Zone WAF: Edit`).

### Original apply (2026-06-23, AECI-242)

**Rate-limiting (`http_ratelimit`, ruleset `6ba381516e4c4c37af85631a68b04ef6`) — 2 of 2 Pro slots:**

- `d5ed0440ab64408d881d890bf10767a5` — **Rule A**, "/api/requests/\* submissions (per IP)",
  5 / 60 s per IP, block 1 h.
- `45a1fd5d771a4b96bc204012f5965b5d` — **Rule B** (added AECI-242), "/api/reviews submissions
  (per IP)", 5 / 60 s per IP, block 1 h.

> A prior broad rule, **"API Limited"** (`/api/*`, 50 req / 10 s per IP), was removed
> to free the second slot for the dedicated reviews rule. Consequence: there is no
> longer a blanket `/api/*` volumetric guard — the read APIs and the
> `/api/page-views` beacon now rely on the managed WAF ruleset + edge caching, not a
> rate-limit rule. The two slots are intentionally spent on the two abuse-prone
> write endpoints.

**Custom rules (`http_request_firewall_custom`, ruleset `974122bb23af4354a215724d9c7e8436`):**

- Existing, **preserved** (indices 0–2, evaluated before the scraper rule):
  `a61d606e4b144118a923abb5ecdfd535` "Skip WAF for stack-test subdomain" (scoped to
  `stack-test.aecintegrations.com` only, so it cannot short-circuit the app hosts),
  `bc961c9f6c2e4e02ba2429d06f8f1dc2` "Block scanner probes",
  `4781ac7e149247baa5b4119274119821` "Blocker 2".
- `319173bafcf749fdbf9b739480d71ded` — **Scraper-UA Managed Challenge** (added AECI-242), index 3,
  on `/products`,`/vendors` + their JSON APIs (§2).

**Managed WAF (`http_request_firewall_managed`):** Cloudflare managed ruleset + OWASP
core (paranoia L2/L3 disabled) — active, untouched.

Live verification at the time (`demo.`): `python-requests` UA on `/products` → **403**
(challenged); normal browser UA on `/products` → **200**; `python-requests` on `/` →
**200** (scraper rule correctly scoped to `/products`,`/vendors`).

### Host-set extension to production (2026-09, AECI-659)

The rules above were written pre-launch and host-scoped to `staging.` + `demo.` only.
The apex cutover (AECI-247/277) moved production to **`www.aecintegrations.com`**, which
was in **none** of the expressions, and no cutover step extended them — so from go-live
until this change, live production had **no rate limiting and no scraper block**. The
`aeci.waf.ratelimit.blocked` metric read ~0 and looked like "no attacks" when it was
really "no rules" (§5).

Measured before the fix (2026-08-26, `GET /products`, `python-requests` UA vs browser UA):

```
HOST                               scraperUA  browserUA
www.aecintegrations.com            200        200        <- live production, NO rule
prod.aecintegrations.com           200        200        <- indexable dup, NO rule
demo.aecintegrations.com           403        200        <- rule works here
```

**Applied 2026-09-03**, via `apply.mjs --apply` against ruleset versions 4 (rate-limiting)
and 16 (custom); all three live expressions matched the documented pre-change form exactly,
so nothing had drifted. `verify.mjs` immediately after:

```
HOST                               scraperUA  browserUA
staging.aecintegrations.com        —          —          skipped (no Access service token)
demo.aecintegrations.com           403        200        ok — challenged
www.aecintegrations.com            403        200        ok — challenged
prod.aecintegrations.com           403        200        ok — challenged
```

What changed: the host set on **all three** rules (§1 Rule A, §1 Rule B, §2 scraper) and
one path broadening on Rule A only (`/api/subscribe` + `/api/feedback`, which had never
been covered on any host). Thresholds, actions, characteristics, and block durations are
untouched. Rule A's dashboard description was rewritten in the same `PATCH`: it read
"matches spec §15.1 exactly", which stopped being true once the lead-capture paths were
folded in. One knock-on: `scripts/check-ssr-listings.sh` curls `/products`, so it now
sends a browser UA rather than being silently challenged (§2). Applied with
[`scripts/ops/2026-09-waf-host-scope/`](../scripts/ops/2026-09-waf-host-scope/README.md).
The Rule B and scraper rule ids recorded above were unrecorded here until `snapshot.mjs`
resolved them (2026-09-03).

> The bare apex `aecintegrations.com` is deliberately **not** in the host set: it 301s to
> `www.` at the edge, so a request never reaches a path these rules match under the apex
> host. `prod.aecintegrations.com` **is** covered — it still serves production content.
> That it does so at all is a separate problem (an indexable duplicate of `www.`; it wants
> a 301 or Cloudflare Access) tracked on its own issue.

---

## Scope

| Host | On zone `aecintegrations.com`? | Covered by these rules? |
|---|---|---|
| `www.aecintegrations.com` (SSR Worker, **production** — the live public site) | yes | **yes** (host-scoped; added 2026-09, AECI-659) |
| `prod.aecintegrations.com` (SSR Worker, production — internal host, an indexable duplicate of `www.`) | yes | **yes** (host-scoped; added 2026-09, AECI-659) |
| `demo.aecintegrations.com` (SSR Worker, the public **showcase** tier — no-index, *not* production) | yes | **yes** (host-scoped) |
| `staging.aecintegrations.com` (SSR Worker, staging) | yes | **yes** (host-scoped) |
| `aecintegrations.com` (bare apex) | yes | **no** — 301s to `www.` at the edge, so no request under this host reaches a matched path |
| `*.aec-integrations.workers.dev` (PR previews) | no (workers.dev, not a zone) | n/a — WAF rules require a zone; previews are gated by [Cloudflare Access](./access.md) instead |

> Until 2026-09 this table said `www.` was "the landing site, deliberately excluded" and
> called `demo.` production. Both statements went stale at the apex cutover and together
> they are why the gap AECI-659 found survived so long: the coverage claim read as true.
> `demo.` is the public showcase; **`www.` is production.**

**Everything is one zone.** Staging, demo, and production share `aecintegrations.com`, so
**WAF rules are zone-wide**. Every rule below is scoped with
`http.host in {"staging.aecintegrations.com" "demo.aecintegrations.com" "www.aecintegrations.com" "prod.aecintegrations.com"}`
so it applies to every app host and never to a hostname the app does not serve. There is
no way to give staging its own independent WAF surface short of a separate zone.

**The public ingress is the SSR Worker** (`apps/web`). It re-proxies `/api/*`
same-origin to the private API Worker over a service binding (per `STAGE_1_SPEC.md`
§15.2), so Cloudflare evaluates these rules against the public paths
(`/api/reviews`, `/api/requests/*`, `/products/*`, …) at the SSR hostname **before**
the request reaches any Worker. The API Worker has no public ingress of its own and
cannot be reached directly.

---

## Plan constraints (Cloudflare **Pro**) — read before editing

These shape every threshold below; they are not tunable without a plan upgrade:

- **Rate-limiting rules count by client IP only.** Per-user / per-JWT / per-header
  counting is an Enterprise ("Advanced Rate Limiting") feature. We cannot express
  "per authenticated user" or "per email" as a WAF rule.
- **Maximum 2 rate-limiting rules** per zone. Both slots are used below. WAF
  **custom rules** (the scraper block) are a *separate, larger* quota and do not
  consume a rate-limit slot.
- **The counting period maxes at 1 minute** on Pro — the dashboard dropdown offers
  *10 seconds* or *1 minute*, **not** 1 hour — and request counts must be whole
  numbers. **A true per-hour limit is therefore not expressible as a WAF rule.**
  The rules below are **per-minute burst caps**: they stop scripted floods but not
  slow-drip abuse spread across an hour. A real hourly cap would require in-Worker
  state (a KV / Durable Object counter keyed by IP or user) — deliberately out of
  scope here (see §3). *(The **block** duration after a trip is a separate field and
  **does** support up to 1 hour — both rules use a 1 h block.)*
- Numeric bot *score* (`cf.bot_management.score`) requires the paid Bot Management
  add-on. The free `cf.client.bot` verified-bot **boolean** is available and is what
  the scraper rule uses.

---

## 0. Preconditions

1. Sign in to Cloudflare → select the **AEC Integrations** account
   (`e62ec9d8012c3e0c225f8e4dbab76b79`) → zone **`aecintegrations.com`**.
2. **Review existing rules first.** `STAGE_1_SPEC.md` §15.1 notes "existing WAF
   rules in place." Go to **Security → WAF → Rate limiting rules** and confirm how
   many of the 2 Pro slots are already used, and **Security → WAF → Custom rules**
   for any existing scraper/UA rule. Edit/replace rather than duplicate; do not
   exceed the 2-rule rate-limit cap.

---

## 1. Rate-limiting rules — Security → WAF → Rate limiting rules (2 of 2 Pro slots)

For each rule, in the dashboard: **Create rule** → name it → paste the expression
into the **"If incoming requests match… → Edit expression"** box → set **"with the
same characteristics" = IP** → set the rate and action as listed.

### Rule A — `/api/requests/*` + the two lead-capture POSTs (per IP)

| Field | Value |
|---|---|
| Expression | `(http.host in {"staging.aecintegrations.com" "demo.aecintegrations.com" "www.aecintegrations.com" "prod.aecintegrations.com"}) and (http.request.method eq "POST") and (starts_with(http.request.uri.path, "/api/requests/") or http.request.uri.path eq "/api/subscribe" or http.request.uri.path eq "/api/feedback")` |
| Count characteristics | **IP** |
| Rate | **5 requests** per **1 minute** (whole number; 1 min is the longest period Pro allows) |
| Action | **Block** |
| Duration (mitigation timeout) | **1 hour** (3600 s) — block duration supports up to 1 h even though the counting period caps at 1 min |

`starts_with(…, "/api/requests/")` covers the current `claim` and `correction`
submissions and any future request submission added under that prefix. These are
anonymous POSTs. The spec wants "5 submissions per IP **per hour**"; the Pro
dashboard can only count per **minute**, so this is a per-minute burst cap (5/min)
rather than the spec's hourly cap — see §3. A human filling a form never approaches
5/min; a script flooding the endpoint does.

**Why `/api/subscribe` + `/api/feedback` ride this rule (AECI-659, 2026-09).** The two
lead-capture endpoints had **no** rate limit anywhere — not on any host, and the API
Worker applies no rate-limiting middleware. A fresh subscribe fires **two real Resend
sends** (operator alert + subscriber welcome, AECI-327), so a scripted loop burns Resend
quota *and* mails third parties from our domain. Pro caps the zone at **2** rate-limit
rules and both slots are spent, so they are covered by widening this predicate rather
than by a third rule. The three families share one 5-per-minute counter — acceptable,
because nobody legitimately submits five forms in a minute, and the failure mode of the
shared counter (a form submitter briefly blocked after four request submissions) is far
cheaper than an uncapped mailer.

### Rule B — `/api/reviews` submissions (per IP — proxy for the spec's per-user limit)

| Field | Value |
|---|---|
| Expression | `(http.host in {"staging.aecintegrations.com" "demo.aecintegrations.com" "www.aecintegrations.com" "prod.aecintegrations.com"}) and (http.request.method eq "POST") and (http.request.uri.path eq "/api/reviews")` |
| Count characteristics | **IP** |
| Rate | **5 requests** per **1 minute** (whole number; 1 min is the longest period Pro allows) |
| Action | **Block** |
| Duration (mitigation timeout) | **1 hour** (3600 s) — block duration supports up to 1 h even though the counting period caps at 1 min |

The spec's literal "3 per **authenticated user** per hour" cannot be expressed on
Pro on two counts: per-user counting is Enterprise-only (so this is a **per-IP**
approximation), and the window maxes at 1 minute (so it's a per-minute burst cap,
not hourly). `5/IP/min` clears any real user — reviews are already auth-gated,
deduplicated (one review per product per user), toxicity-scored, and
moderation-gated, so this is a coarse flood backstop, not the only control.

> **2-slot trade-off (decision taken).** Both rate-limit slots are now spent on the
> two write endpoints (Rule A requests, Rule B reviews). The earlier broad
> "API Limited" rule (`/api/*`, 50 / 10 s) was removed to make room, so there is no
> general write backstop now. If you later prefer a broad backstop over a dedicated
> reviews rule, swap Rule B for: match
> `(http.host in {…}) and (http.request.method eq "POST") and (not http.request.uri.path eq "/api/webhooks/linear")`,
> count by IP, **200 requests per 1 minute**, action **Managed Challenge**. There
> are only 2 slots — pick one.

### Deliberately **not** rate-limited

- **`POST /api/page-views`** — a fire-and-forget analytics beacon that fires on
  every page load and returns 204. A per-IP cap would throttle legitimate analytics
  for normal browsing. (If abused, use the tunable Managed-Challenge backstop above,
  which tolerates normal cadence.)
- **`POST /api/webhooks/linear`** — server-to-server from a single Linear egress IP
  and HMAC-verified (`LINEAR_WEBHOOK_SIGNING_SECRET`). A per-IP limit would drop
  legitimate Linear deliveries/retries once volume rises; the HMAC signature is the
  gate. Leave it unmatched by both the rate-limit rules and the scraper rule.

---

## 2. Scraper block — Security → WAF → Custom rules (separate quota)

Create a custom rule. **When incoming requests match** → paste the expression →
**Then take action = Managed Challenge.**

| Field | Value |
|---|---|
| Expression | `(http.host in {"staging.aecintegrations.com" "demo.aecintegrations.com" "www.aecintegrations.com" "prod.aecintegrations.com"}) and (not cf.client.bot) and (starts_with(http.request.uri.path, "/products") or starts_with(http.request.uri.path, "/vendors") or http.request.uri.path eq "/api/products" or http.request.uri.path eq "/api/vendors") and (lower(http.user_agent) contains "scrapy" or lower(http.user_agent) contains "python-requests" or lower(http.user_agent) contains "httpx" or lower(http.user_agent) contains "curl" or lower(http.user_agent) contains "wget" or lower(http.user_agent) contains "go-http-client" or lower(http.user_agent) contains "java/" or lower(http.user_agent) contains "okhttp" or lower(http.user_agent) contains "node-fetch" or lower(http.user_agent) contains "scraper" or http.user_agent eq "")` |
| Action | **Managed Challenge** |

Why it is shaped this way:

- **`not cf.client.bot` first** — Cloudflare's verified-bot list (Googlebot,
  Bingbot, etc.) is excluded up front, so search-engine crawlers are never
  challenged and SEO is unaffected.
- **Specific tool/library UA tokens only.** We match scripting clients
  (`scrapy`, `python-requests`, `httpx`, `curl`, `wget`, `go-http-client`,
  `java/`, `okhttp`, `node-fetch`), the literal `scraper` token, and the empty-UA
  case. We **deliberately do NOT match generic `bot` / `crawler` / `spider`
  substrings** — many legitimate-but-unverified crawlers (smaller search engines,
  SEO and monitoring tools) carry those words without `cf.client.bot=true`, and
  blocking them would hurt discoverability. `STAGE_1_SPEC.md` §15.1 says "block
  *known scraper* user agents," i.e. tools, not generic words.
- **Managed Challenge, not Block** — a human on an exotic/misclassified UA gets a
  solvable challenge instead of a hard 403. Lower false-positive blast radius.
- **Paths are browse/detail + their JSON APIs only.** `/api/health`,
  `/api/version`, `/_version`, `/admin/purge` are **not** in the path list, so our
  CI monitoring (`scripts/smoke-test.sh`, the health/version probes — all `curl`)
  is unaffected. `/api/webhooks/linear` is likewise absent, so Linear's webhook is
  never challenged.
- **One operator script does hit a matched path, and must send a browser UA.**
  `scripts/check-ssr-listings.sh` (AECI-746 crawler-visibility probe) curls `/products`.
  Under `curl`'s default UA it is challenged, falls into its own SKIP branch, and exits
  **0** with a reassuring "PASS, with 2 page(s) skipped" — a silent false negative on the
  exact regression it exists to catch. It now sends a browser UA for that reason
  (AECI-659). Any future probe of `/products` or `/vendors` needs the same treatment;
  probes of `/api/health` / `/api/version` do not.

---

## 3. What these rules intentionally do NOT cover

| Spec §15.1 item | Status here | Where it actually lives |
|---|---|---|
| `/api/requests/*` 5/IP/**hr** | ⚠️ approximated as 5/IP/**min** (Rule A) | Pro caps the window at 1 min; a true hourly cap needs in-Worker KV/DO state (out of scope) |
| *(not in the spec)* `/api/subscribe` + `/api/feedback` | ✅ **added** to Rule A (AECI-659) | 5/IP/min, shared with the `/api/requests/*` counter — §1 Rule A. Beyond the four §15.1 bullets: the spec predates the lead-capture endpoints moving into the API Worker (AECI-257) and their Resend sends (AECI-327). |
| `/api/reviews` 3/**user**/hr | ⚠️ approximated as 5/**IP**/**min** (Rule B) | per-user is Enterprise-only on WAF *and* the window caps at 1 min; existing dedup + moderation are the real per-user controls |
| magic-link 5/**email**/hr | ❌ not in CF | **Supabase → Authentication → Rate Limits** — the request goes browser→Supabase and never reaches Cloudflare (owner-managed, out of scope for AECI-242) |
| block known scraper UAs | ✅ §2 custom rule | this runbook |
| the vendor portal's own paths | ✅ clear (was broken by a MANAGED rule) | §3a below — a managed rule 403'd every path containing `/vendor/` zone-wide; **resolved 2026-08-26**, kept as the detection recipe |

---

## 3a. Managed-rule collision — every path containing `/vendor/` was 403'd

**Status: RESOLVED 2026-08-26. Re-verified 2026-09-03 — does not reproduce.** It was
never one of our rules. Kept in full as the **detection + fix recipe**, because the
rule belongs to a Cloudflare-managed ruleset we do not version and it can re-fire on
a ruleset update.

Re-verification, 2026-09-03 (same curl method, `www`):

```bash
/vendor            → 404    /vendor/x/overview → 404    /vendors/autodesk → 200
/api/vendor/me     → 404    /foo/vendor/bar    → 404   ← the substring control
```

No "Attention Required" 403 page on any of them. A skip rule was evidently added, or
the managed rule retuned, after the original finding. (At the time of that check `/vendor`
itself 404'd on `www` because the portal code had not merged to `main`. **The Stage 2 merge
landed 2026-09-03**, so once a prod promote carries it, `/vendor` resolves — a 403 there is
the WAF again, and a 404 is a real routing bug rather than the dark launch.)

**If it recurs, everything below is the original finding — treat it as the runbook.**

---

Originally verified 2026-08-26 (morning) by curl: any request whose path contains the literal
`/vendor/` gets the Cloudflare "Attention Required / Sorry, you have been blocked"
403 page on **every** host in the zone — `www`, `staging`, `demo`, `stage2`. It is
case-sensitive (`/api/VENDOR/seats` passes) and substring-based (`/apix/vendor/x`
and `/foo/vendor/bar` are blocked too). `/vendor` with no trailing segment is fine,
and `/vendors/<slug>` is fine.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://www.aecintegrations.com/vendor           # 404 — fine
curl -s -o /dev/null -w '%{http_code}\n' https://www.aecintegrations.com/vendor/x/overview # 403 — blocked
curl -s -o /dev/null -w '%{http_code}\n' https://www.aecintegrations.com/vendors/autodesk  # 200 — fine
```

Almost certainly a **Cloudflare Managed Ruleset** rule (the Composer/PHPUnit
`vendor/` directory-traversal / RCE family), not a custom rule of ours — §1 and §2
above are host-scoped to staging/demo and target `/products` and `/vendors`. The
read-only CF API token in this repo can read neither the managed rulesets nor
`firewallEventsAdaptive`, so the rule ID has to come from the dashboard:
**Security → Events**, filter `Action = Block` and path contains `/vendor/`.

**Blast radius, in the order it was discovered:**

1. **Every browser-side `/api/vendor/*` call.** Seats, the
   `GET /api/vendor/updates` live-sync poll, notifications, integrations,
   data-objects, and every profile / product / attestation write. The portal
   *looked* alive because `/vendor` SSRs through `vendorMeResolver` →
   the `env.API` **service binding**, which never crosses the edge. First visible
   symptom is "Could not load the seat list"; the store's `catch` swallows the
   status, so nothing is logged.
2. **The portal page loads themselves**, since the AECI-522 §6.2 routing change
   moved the surface to `/vendor/:vendorSlug/<section>`
   (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2). Bare `/vendor` 302'd straight into a
   403'd path, so the portal was unreachable on the zone — not merely degraded.

**Why CI never caught it:** e2e runs against `localhost` and `workers.dev` preview
URLs, which are outside the zone and carry no zone WAF.

**Fix (dashboard access required) — if it recurs:** add a WAF **skip / exception**
for that managed rule scoped to the portal's own paths —

```
starts_with(http.request.uri.path, "/api/vendor/")
  or starts_with(http.request.uri.path, "/vendor/")
```

Scope the exception to that one managed rule, not to the whole ruleset. Re-verify
with the three curls above (expect `404 / 200-or-303 / 200`).

---

## 4. Verification

The rules are live on all four app hosts (verified 2026-09-03 — see
[Deployed state](#deployed-state)); re-run these checks any time after a change. Against **staging** (behind [Cloudflare Access](./access.md)),
send the service-token headers on every request:

```
-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

Checks (confirm rule attribution in **Security → Events** after each):

1. **Legit flows are not throttled.** One normal `POST /api/reviews` and one
   `POST /api/requests/claim` from your IP → succeed, no Block. Paginate
   `GET /products?page=1..N` and `GET /api/products` with a **normal browser UA**
   → never challenged.
2. **Rate limit fires.** Loop the same write >5× within one minute from one IP →
   the 6th is Blocked (HTTP 429 / challenge interstitial). Confirm the event is
   attributed to Rule A or B.
3. **Scraper rule fires only on tool UAs.** `GET /products` with
   `-A "python-requests/2.31"` → Managed Challenge; the same path with a real
   browser UA → passes. (Verified bots like Googlebot pass via `cf.client.bot`;
   validate that from real Search-Console traffic rather than spoofing.)
4. **Exclusions hold.** `POST /api/webhooks/linear` and `POST /api/page-views` are
   never rate-limited; Linear deliveries continue (watch the
   `aeci.webhooks.linear.receipt` metric). Re-run `scripts/smoke-test.sh` and the
   health/version probes against staging → all green (their paths aren't in any
   rule).
5. **Host-scoping holds on every app host.** Run the scraper probe across all four
   hosts and expect `403` (challenged) / `200` (browser) on each:

   ```bash
   node scripts/ops/2026-09-waf-host-scope/verify.mjs
   ```

   This is check 3 above, automated across the host set — it is the check that found
   AECI-659, so a before/after pair is directly comparable. It is read-only and sends
   no email. `staging.` needs `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` or it
   is skipped. A host reading `200 / 200` is **not covered** by the scraper rule.

Repeat the legit-flow + exclusion spot-checks on **production** (`www.`) after any
rule change.

> **Never trip a rate limit against production.** Six trips block your IP from those
> endpoints for an hour, and on production `/api/subscribe` sends real mail. Test the
> rate limit on **staging** (check 2). If you genuinely must probe production, POST an
> invalid body (`-d '{}'`): Zod rejects at validation before any write or send, so
> requests 1–5 return `400` and only the 6th returns `429`.

---

## 5. Observability

- **CF Security Events (free on Pro):** every Block / Managed Challenge appears in
  **Security → Events**, filterable by rule, action, host, and IP. This is the
  operator surface for live triage — the per-IP / per-request detail the metrics plane does
  **not** carry. That is true of PostHog: the
  aggregation below is a count per mitigation group, not per request.
- **The metrics plane (AECI-262):** a scheduled **CF GraphQL Analytics → `submitCount`** shim
  surfaces the same events as a metric so they sit alongside the `aeci.*` catalog
  and can drive an alert (Enterprise Logpush — the "push" alternative — is not on
  our Pro plan, so we poll). The API Worker's hourly cron
  (`apps/api/src/scheduled.ts` `runWafMetricsJob`, the `'0 * * * *'` trigger) reads
  the **previous clock hour** of the zone's `firewallEventsAdaptiveGroups` over the
  GraphQL Analytics API (`packages/shared/src/cloudflare-analytics.ts`) and emits:
  - **`aeci.waf.ratelimit.blocked`** (count) — one point per mitigation group,
    tagged `rule` (the rule id), `action` (`block` / `managed_challenge` / …),
    `host`, and `source` (`ratelimit` / `firewallcustom`). The value is the event
    count, so query with `sum:` (`sum:aeci.waf.ratelimit.blocked{}.as_count()`).
    Non-mitigation actions (`allow` / `log` / `skip`) are dropped.
  - **`aeci.waf.poll`** (count) — a per-run heartbeat, `outcome:ok|failed|skipped_no_creds`;
    the always-emitted `outcome:ok` series is the cron-liveness signal.

  The live alert is the PostHog alert **AECi — WAF rate-limit / challenge spike**
  (`observability/posthog/alerts.json`, >2,000/1 h — the retired Datadog monitor's
  500/15 m rescaled for the hourly window), which fires on a
  sustained spike. Under ADR 0024 it ports to a PostHog alert at **hourly** cadence
  (`POSTHOG_MIGRATION_SPEC.md` §5) — a real, accepted loss of detection speed on this
  signal. Its liveness half is different: `aeci.waf.poll`'s no-data monitor has no PostHog
  equivalent and moves to the AECI-647 external CI liveness sweep. **Both metrics are
  vendor-independent** — `CF_ZONE_ID` / `CF_ANALYTICS_API_TOKEN` and the poll itself are
  untouched by the migration. See `docs/OBSERVABILITY.md` for the catalog + alert and
  `docs/RUNBOOKS.md` for triage.

  **Token:** the poll needs `CF_ANALYTICS_API_TOKEN` — a Cloudflare token scoped to
  **`Zone Analytics: Read`** on `aecintegrations.com` (a narrow, read-only scope,
  distinct from the retired `Zone.Cache Purge` purge token, so it is its own secret). It reuses the
  existing `CF_ZONE_ID` — which, until 2026-08-12, was a **manual** `wrangler secret
  put` that had never been placed on any API Worker, so the poll no-op'd even after
  `CF_ANALYTICS_API_TOKEN` was provisioned. `CF_ZONE_ID` is now CI-pushed by all three
  deploy/promote workflows; since WC-10 retired `CF_PURGE_API_TOKEN`, this poll is the
  only thing that still reads it. Because the analytics token is zone-scoped and the zone is
  shared across envs, it is a **single un-suffixed GitHub secret** (like
  `SUPABASE_ANON_KEY` / `ALGOLIA_APP_ID`): `gh secret set CF_ANALYTICS_API_TOKEN`.
  CI then pushes it to each env's Worker (`deploy.yml` → staging, `promote-to-demo.yml`
  → demo, `promote-to-prod.yml` → production — graceful warn-skip, no hard gate).
  Absent → the poll logs `outcome:skipped_no_creds` and no-ops (fail-safe).

  **Per-env host scoping.** All app envs share the one `aecintegrations.com` zone,
  so each env's poll filters `firewallEventsAdaptiveGroups` to its **own** host
  (derived from `PUBLIC_SITE_URL`) to avoid counting the same zone-wide events under
  each `env:` tag. The production Worker ships
  `PUBLIC_SITE_URL=https://www.aecintegrations.com` (`apps/api/wrangler.jsonc`), so the
  production poll queries the **`www.`** host.

  **This metric cannot distinguish "no attacks" from "no rules" — and that is how
  AECI-659 hid.** From the apex cutover until 2026-09 the §1/§2 rules were host-scoped
  to `staging.` + `demo.` only, so `www.` generated zero mitigation events and the
  production series read ~0 while production was in fact entirely unprotected. Since the
  host-set extension (2026-09) the production poll reports real mitigations for `www.`.
  If it ever returns to a flat ~0, **re-run
  `scripts/ops/2026-09-waf-host-scope/verify.mjs` before concluding the zone is quiet** —
  a `200 / 200` row means the rules stopped covering the host, not that the attacks
  stopped.

  `prod.aecintegrations.com` is covered by the rules but counted by **no** env's poll:
  each env filters on its own `PUBLIC_SITE_URL` and no env points at `prod.`. Its
  mitigations are visible in **Security → Events** only.

---

## Maintenance

This doc is the source of truth for the rule definitions. If you add, remove, or
re-tune a rule in the dashboard, update the matching section here in the same PR.
Remember the 2-rule rate-limit cap and keep every expression host-scoped to the **four**
app hosts in the Scope table above.

**When a new public hostname starts serving the app, it needs adding to all three
expressions in the same change.** DNS alone does not carry these rules — that omission at
the apex cutover is exactly what AECI-659 fixed, and it went unnoticed for months because
the observability metric reads ~0 either way. `docs/launch-cutover-runbook.md` §3 now
carries the action step, and
[`scripts/ops/2026-09-waf-host-scope/`](../scripts/ops/2026-09-waf-host-scope/README.md)
is the mechanism (edit its `NEW_HOSTS` and re-run).
