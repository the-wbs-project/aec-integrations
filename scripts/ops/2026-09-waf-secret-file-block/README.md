# 2026-09 WAF scanner probe block (AECI-1138)

Adds two Cloudflare WAF custom rules on the `aecintegrations.com` zone. They block scanner
requests for secret files, config files, framework build output and other stacks' endpoints at
the edge, before they reach the SSR Worker.

`docs/waf-rate-limits.md` §2a is the source of truth: both expressions (as ` ```wirefilter `
blocks), the reason, the evidence, the design rules and the checked exclusions. This directory
holds the check and the apply bodies. Nothing here invents a rule.

| File | What it does | Touches Cloudflare? |
|---|---|---|
| `cf-expr.mjs` | Evaluates the Cloudflare expression subset our rules use | No |
| `check-corpus.mjs` | Runs all four Block rules from the doc against every legitimate path, the observed 404s and a probe list | No |
| `payload.mjs` | Prints the Rulesets API body for rule 1 or rule 2, expression read from the doc | No |
| `pull-404s.mjs` | Pulls the production 404 paths from Workers Logs | Read only |
| `observed-404s-2026-09.json` | The 2026-09-21..28 pull: 1,575 paths, 8,452 requests, 4,536 from AS396982. Paths and counts only | No |

## 1. Re-run the check

Do this before applying, after any rule edit, and after any bulk catalog import. It needs the
prod slug list. Both queries are read-only `SELECT`s. D1 caps a compound `SELECT` at five terms,
so there are two.

```bash
cd apps/api
npx wrangler d1 execute aeci-app-production --env production --remote --json --command "SELECT 'p' k, slug FROM products UNION ALL SELECT 'v', slug FROM vendors UNION ALL SELECT 'r', from_slug FROM slug_redirects" | jq -r '.[0].results[] | "\(.k) \(.slug)"' > /tmp/aeci-slugs.txt
npx wrangler d1 execute aeci-app-production --env production --remote --json --command "SELECT 'c' k, slug FROM taxonomy_categories UNION ALL SELECT 'a', slug FROM taxonomy_audiences UNION ALL SELECT 'ph', slug FROM taxonomy_phases UNION ALL SELECT 't', slug FROM taxonomy_trades" | jq -r '.[0].results[] | "\(.k) \(.slug)"' >> /tmp/aeci-slugs.txt
cd ../..
node scripts/ops/2026-09-waf-secret-file-block/check-corpus.mjs /tmp/aeci-slugs.txt
```

Pass condition: the last line ends `failures=0` and the exit code is 0. Result on 2026-09-28:

```
coverage AS396982 scanner: 4251/4536 logged 404s blocked (93.7%), 81 paths not matched
coverage all callers: 5083/8452 logged 404s blocked (60.1%), 1154 paths not matched
legit=3779 observed-legit=842 probes=50 slugs=597 failures=0
```

To see what is still unmatched, set `SHOW_MISSED=scanner_as396982` or `SHOW_MISSED=requests`.

To measure against fresh traffic, pull the last week's 404s and pass the file as the second
argument. `CF_READONLY_API_TOKEN` must be an account token with **Workers Observability: Read**.

```bash
node scripts/ops/2026-09-waf-secret-file-block/pull-404s.mjs 7 > /tmp/observed-404s.json
node scripts/ops/2026-09-waf-secret-file-block/check-corpus.mjs /tmp/aeci-slugs.txt /tmp/observed-404s.json
```

## 2. Apply — pick one route

Rule 1 goes directly after "Blocker 2". Rule 2 goes directly after rule 1.

### Dashboard

1. Cloudflare → account **The WBS Project** → zone **aecintegrations.com**.
2. **Security → WAF → Custom rules → Create rule.**
3. Rule name: `Block secret-file probes (AECI-1138)`.
4. **When incoming requests match** → **Edit expression**. Paste the matching ` ```wirefilter `
   block from `docs/waf-rate-limits.md` §2a. Copy it from the doc, not from a chat transcript.
5. **Then take action** → **Block**.
6. **Place at** → **Custom** → after **Blocker 2**. **Deploy.**
7. Repeat for `Block framework and endpoint probes (AECI-1138)`, placed after the rule you just
   created.
8. Copy both rule ids. §2a and Deployed state need them.

### Rulesets API

The token needs **Zone → WAF → Edit** on `aecintegrations.com`. `CF_READONLY_API_TOKEN` cannot do
this. Set `CF_WAF_API_TOKEN` and `CF_ZONE_ID` exactly as
`scripts/ops/2026-09-waf-host-scope/README.md` → "Credentials" describes.

Confirm the custom-rules entry point is still ruleset `0052017b9bf44ceaad5888bf9d6c3d97`, and list
its rules in order. This is a read.

```bash
curl -s -H "Authorization: Bearer $CF_WAF_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/rulesets/phases/http_request_firewall_custom/entrypoint" | jq '{id: .result.id, version: .result.version, rules: [.result.rules[] | {id, description, action, enabled}]}'
```

The `id` must be `0052017b9bf44ceaad5888bf9d6c3d97`, and `2e2e7ae15d69446a872dcb142e7ed82c`
("Blocker 2") must be in the list. If either is not true, stop and re-read the zone first.

Create rule 1. The last line prints its id.

```bash
node scripts/ops/2026-09-waf-secret-file-block/payload.mjs 1 > /tmp/aeci-1138-rule-1.json
curl -s -X POST -H "Authorization: Bearer $CF_WAF_API_TOKEN" -H "Content-Type: application/json" --data @/tmp/aeci-1138-rule-1.json "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/rulesets/0052017b9bf44ceaad5888bf9d6c3d97/rules" | jq -r '.success, (.errors | tostring), (.result.rules[] | select(.description == "Block secret-file probes (AECI-1138)") | .id)'
```

Put that id in `AECI_1138_RULE_1_ID`, then create rule 2 after it.

```bash
node scripts/ops/2026-09-waf-secret-file-block/payload.mjs 2 "$AECI_1138_RULE_1_ID" > /tmp/aeci-1138-rule-2.json
curl -s -X POST -H "Authorization: Bearer $CF_WAF_API_TOKEN" -H "Content-Type: application/json" --data @/tmp/aeci-1138-rule-2.json "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/rulesets/0052017b9bf44ceaad5888bf9d6c3d97/rules" | jq -r '.success, (.errors | tostring), (.result.rules[] | select(.description == "Block framework and endpoint probes (AECI-1138)") | .id)'
```

## 3. Confirm it is blocking

Each probe should return **403**. Each control should return **200**.

```bash
for p in /terraform.tfstate /firebase-adminsdk.json /backup.sql.gz /.vite/manifest.json /api/config /inngest /.env; do printf '%-28s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "https://www.aecintegrations.com$p")"; done
for p in /robots.txt /sitemap.xml /products/procore /.well-known/traffic-advice; do printf '%-28s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' -A 'Mozilla/5.0' "https://www.aecintegrations.com$p")"; done
```

`/.env` already reads 403 before the apply, because "Blocker 2" matches it. The other six probes
read 404 before and 403 after. `/.well-known/traffic-advice` is a control that should read 404,
not 403: the carve-out lets it through and the app has no such file. If the product slug in the
controls has been retired, substitute any live one.

Then read **Security → Events** (the dashboard may label it **Security → Analytics → Events**).
Filter:

- **Rule ID** equals either new rule id.
- **Host** equals `www.aecintegrations.com`.
- Time range: the last 24 hours.

After the next scanner burst you should see a one-minute column of **Block** events from
ASN 396982. Add **ASN equals 396982** to isolate it. Do **not** put the ASN in the rule.

A week later, re-run §1 with a fresh `pull-404s.mjs` file. The scanner's logged 404s should fall
to roughly the unmatched 6%: generic names and random strings.

## Rollback

Disable either rule in the dashboard (the toggle on the Custom rules list). Or delete by id:

```bash
curl -s -X DELETE -H "Authorization: Bearer $CF_WAF_API_TOKEN" "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/rulesets/0052017b9bf44ceaad5888bf9d6c3d97/rules/$AECI_1138_RULE_ID" | jq '{success, errors}'
```

Set `AECI_1138_RULE_ID` to the id of the rule you are removing before running it.
