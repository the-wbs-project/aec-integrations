# 2026-09 WAF host-scope extension (AECI-659)

Extend the three Cloudflare WAF rules on the `aecintegrations.com` zone from
`staging.` + `demo.` to also cover **`www.aecintegrations.com`** (live production) and
**`prod.aecintegrations.com`**, and widen Rule A to cover the two lead-capture endpoints.

`docs/waf-rate-limits.md` is the source of truth for the rule definitions. This
directory is the mechanism that gets them onto the zone — nothing here invents a rule.

## The gap this closes

Every rule was host-scoped to `staging.` + `demo.` when it was written (AECI-242,
pre-launch). The apex cutover (AECI-247/277) moved production to `www.`, which is in
**none** of those expressions, and no cutover step extended them. So since go-live:

- `POST /api/requests/*` (claim + correction) — no 5/min cap on production.
- `POST /api/reviews` — no 5/min cap on production.
- `/products`, `/vendors` + their JSON APIs — no scraper challenge on production.
- `POST /api/subscribe` and `POST /api/feedback` — never had a rule on **any** host,
  and the API Worker applies no rate-limiting middleware. A fresh subscribe fires two
  real Resend emails (operator alert + subscriber welcome), so a scripted loop burns
  Resend quota and mails third parties from our domain.

Measured 2026-08-26 (`GET /products`, `python-requests` UA vs a browser UA):

```
HOST                               scraperUA  browserUA
www.aecintegrations.com            200        200        <- live production, NO rule
prod.aecintegrations.com           200        200        <- indexable dup, NO rule
demo.aecintegrations.com           403        200        <- rule works here
```

It read as "no attacks" rather than "no rules" because `aeci.waf.ratelimit.blocked`
(AECI-262) host-scopes on `PUBLIC_SITE_URL`, which is `www.` in production — so the
metric was structurally pinned at ~0. **No code change is needed** for it to start
reporting; the rules are the only missing piece.

## What changes

The host set, on all three rules:

```
{"staging.aecintegrations.com" "demo.aecintegrations.com" "www.aecintegrations.com" "prod.aecintegrations.com"}
```

The bare apex is deliberately absent — it 301s to `www.` at the edge, so no request
under the apex host ever reaches a path these rules match. `prod.` **is** included: it
still serves production content. (That it does so at all is a separate problem — it is
an indexable duplicate of `www.` and wants a 301 or Cloudflare Access. Not this issue.)

Plus one path broadening, on Rule A only:

```
starts_with(http.request.uri.path, "/api/requests/")
  or http.request.uri.path eq "/api/subscribe"
  or http.request.uri.path eq "/api/feedback"
```

Cloudflare **Pro caps the zone at 2 rate-limit rules** and both slots are spent, so the
lead-capture endpoints get covered by widening an existing predicate rather than by a
third rule. The three families share one 5-per-minute counter, which is fine: nobody
legitimately submits five forms in a minute.

Everything else — IP characteristic, 5 requests / 60 s, Block with a 1 h mitigation
timeout, Managed Challenge on the scraper rule — is unchanged and is carried through
verbatim from the live rule.

## Credentials

```
CF_ZONE_ID          the aecintegrations.com zone id (the same value CI pushes to the Workers)
CF_WAF_API_TOKEN    Zone WAF: Read for snapshot.mjs, Zone WAF: Edit for apply.mjs --apply
```

This is **not** `CF_ANALYTICS_API_TOKEN` (`Zone Analytics: Read`, the Datadog poll) and
not `CF_PURGE_API_TOKEN` (`Zone.Cache Purge`). Neither has WAF permission — reusing one
gets a `403` from the Rulesets API. Mint a separate token; it is an operator token and is
not held by CI.

### Where to put them

**Plain shell environment variables, for the length of the session.** These scripts read
`process.env` directly — nothing here loads `.dev.vars`, and `.dev.vars` is the wrong home
anyway: it is the Workers' *runtime* secret file, and no Worker has any use for a
WAF-editing token. Don't persist it there.

Mint the token at Cloudflare → **My Profile → API Tokens → Create Token → Create Custom
Token**: Permissions **Zone → WAF → Edit** (use **Read** if you only want to run
`snapshot.mjs`), Zone Resources **Include → Specific zone → aecintegrations.com**.

Then, from the repo root:

```bash
read -rs "CF_WAF_API_TOKEN?Cloudflare Zone WAF token: " && export CF_WAF_API_TOKEN && echo
export CF_ZONE_ID="$(curl -s -H "Authorization: Bearer $CF_WAF_API_TOKEN" 'https://api.cloudflare.com/client/v4/zones?name=aecintegrations.com' | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])')"
```

`read -rs` keeps the token out of shell history (zsh syntax; on bash use
`read -rsp 'Cloudflare Zone WAF token: ' CF_WAF_API_TOKEN`). The zone id is not a secret —
it is also on the zone's **Overview** page in the Cloudflare dashboard, right-hand sidebar
under **Zone ID** — but the lookup above saves a tab. It is the same value CI holds as the
`CF_ZONE_ID` GitHub secret and pushes to each Worker; GitHub secrets are write-only, so you
cannot read it back from there.

Nothing needs to be added to `.dev.vars`, `.env`, or CI. Close the shell when you are done.

`verify.mjs` needs no Cloudflare token at all — it makes ordinary public requests. It
does need `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` to reach `staging.`, which
sits behind Cloudflare Access (`docs/access.md`); without them that host is skipped.

## Run it

```bash
node scripts/ops/2026-09-waf-host-scope/verify.mjs
node scripts/ops/2026-09-waf-host-scope/snapshot.mjs
node scripts/ops/2026-09-waf-host-scope/apply.mjs
node scripts/ops/2026-09-waf-host-scope/apply.mjs --apply
node scripts/ops/2026-09-waf-host-scope/verify.mjs
```

1. **`verify.mjs`** first, to capture the before state — the `HOST scraperUA browserUA`
   table above, reproduced live.
2. **`snapshot.mjs`** — read-only. Writes `snapshot-<UTC>.json` next to the script
   (gitignored: it carries the live expressions of every rule on the zone, including
   the three this change does not touch) and prints both rulesets, the resolved id and
   migration state of each target rule, and the **ordering check**.
3. **`apply.mjs`** with no flags — a dry run. Prints a before/after expression pair per
   rule and writes nothing.
4. **`apply.mjs --apply`** — the write.
5. **`verify.mjs`** again — expect `403` / `200` on all four hosts.

Then confirm attribution in Cloudflare **Security → Events** filtered to host
`www.aecintegrations.com`, and update the "Deployed state" section of
`docs/waf-rate-limits.md` with the dated result.

### Exit codes

| Script | 0 | 1 | 2 |
|---|---|---|---|
| `snapshot.mjs` | snapshot written, ordering clean | a blocking `skip` rule was found | usage / credentials |
| `apply.mjs` | nothing left to do, or `--apply` succeeded | dry run found changes to make | usage / credentials / drift |
| `verify.mjs` | every probed host behaves | a host does not | usage |

## Why the ordering check exists

A custom rule with the **Skip** action terminates ruleset evaluation. Three preserved
rules live above the scraper rule on this zone ("Skip WAF for stack-test subdomain",
"Block scanner probes", "Blocker 2"), and the first is exactly that shape. If a Skip
sat above the scraper rule and matched `www.`, the host-set extension would land and
silently do nothing. `snapshot.mjs` flags any enabled `skip` rule above the scraper rule
that names one of the new hosts — or that carries no `http.host` predicate at all, which
matches every host by definition. It is deliberately crude: a false positive costs a
glance, a miss costs the whole change.

## Why `apply.mjs` refuses rather than guesses

It does not compute the new expression by string surgery on whatever happens to be
live. `rules.mjs` declares the exact `before` and `after` forms, transcribed from
`docs/waf-rate-limits.md` §1–§2. A live rule equal to `after` is reported
`already-current` and skipped (so re-running is safe); a rule equal to `before` is
migrated; **a rule equal to neither aborts the entire run before any write**, printing
all three expressions. That case means someone edited the rule in the dashboard without
updating the doc — reconcile the doc and `rules.mjs` first. Nothing here will overwrite
an expression it does not recognise, and no run can leave the zone half-migrated.

Each rule is updated with its own `PATCH /rulesets/{id}/rules/{rule_id}`, never a
whole-ruleset `PUT` — a `PUT` would put the three preserved custom rules and their
**order** at risk.

## Rollback

There is no `--revert`. Re-PATCH each rule's `expression` back to the value in
`snapshot-<UTC>.json` — that file is the revert artifact, which is why step 2 runs
before step 4. The three rule ids are in the snapshot and in `docs/waf-rate-limits.md`
"Deployed state". Two fields change, not one: **Rule A's `description` is rewritten in the
same `PATCH`** (it claimed "matches spec §15.1 exactly", which stops being true once the
lead-capture paths are folded in), so restore that from the snapshot too or Rule A ends up
labelled for a scope it no longer has. Rule B and the scraper rule need only `expression`.
Nothing else — action, thresholds, characteristics, `ref`, position — is touched.

## Verifying the rate limit (manual, staging only)

`verify.mjs` deliberately does **not** probe the rate-limit rules. Tripping one blocks
the calling IP from those endpoints for a full hour, and on production those endpoints
send real email. Test on **staging**:

```bash
for i in $(seq 1 6); do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://staging.aecintegrations.com/api/subscribe \
    -H "Content-Type: application/json" \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -d '{}'
done
```

Requests 1–5 return `400` (Zod rejects the empty body, so nothing is written and no mail
is sent) and the 6th returns `429`. The `-d '{}'` trick is what makes this safe to run
against a live host at all — use it if you ever must probe production.
