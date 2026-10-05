# Move AECi to The WBS Project Cloudflare account (AECI-1161)

This is the operator runbook for moving every AECi Cloudflare resource off the old account and onto the WBS account. The epic is AECI-1161. The phase issues are AECI-1162 to AECI-1167. The review app has its own issue, AECI-1168.

| | Account | Account id | workers.dev | Nameservers |
|---|---|---|---|---|
| From | AEC Integrations | `e62ec9d8012c3e0c225f8e4dbab76b79` | `aec-integrations.workers.dev` | `wally`, `conrad` |
| To | The WBS Project | `004dc1af737b22a8aa83b3550fa9b9d3` | `thewbsproject.workers.dev` | `amalia`, `bjorn` |

The approach is to redeploy fresh on the WBS account, then copy the data. Nothing is moved in place.

The domain is registered at Cloudflare Registrar. It moves between accounts with the inter-account registrar move. That move carries no zone configuration.

## Status

| Step | Status |
|---|---|
| DNSSEC off on `aecintegrations.com` | Done 2026-09-30. 1.1.1.1 no longer returns a DS record |
| Rate-limit `namespace_id` collision check | Clear. None of the local WBS configs declares `ratelimits` |
| Resources created on WBS | Done 2026-09-30. The ids are in `ids.json` and wired into the api, agent, datatool and web wrangler files on this branch |
| Config PR (branch `aeci-1163-wbs-account-move`) | Merged 2026-10-01 as #870, before the cutover, with staging on workers.dev under `WBS-INTERIM`. The interim lines were reverted after the cutover |
| Zone staged on WBS | Done. DNS imported and trimmed. The three M365 CNAMEs are DNS only. The Bing `verify.bing.com` CNAME was missing from the import and was added 2026-10-04 |
| WAF on WBS | Done 2026-09-30 through the dashboard. 3 custom rules, 2 rate-limit rules, Managed + OWASP are active. The Pending zone accepted them. See "WAF rule map" |
| Old zone Pro plan removed | Pro and the "Smart Shield Argo Zone Level Plan - Basic" add-on were cancelled before the 2026-10-08 renewal. The scheduled cancellation did not block the registrar move |
| Review app service binding | None (review agent, 2026-09-30). The review app calls AECi over the public URL, so the two apps don't have to deploy in lockstep |
| Bot settings on WBS | Done. The two Pending-zone items (cutover step 6b) were confirmed 2026-10-05: Bot Preference Sync off, continuous script monitoring on. See "Bot settings" |
| Rehearsal | Done 2026-10-01. See "Rehearsal result" |
| Cutover | Done 2026-10-04 for production and demo. See "Cutover result". The review app (AECI-1168) moves separately |
| Production D1 region | The move created `aeci-app-production` in APAC. AECI-839 re-homes production onto `aeci-app-production-us` in ENAM. See `scripts/ops/2026-10-prod-d1-us-move/` |

## Why the config PR waits for the cutover

`account_id` sits at the top of each wrangler file, so it applies to every environment. Staging deploys from `main` on every merge.

If the PR merged early, the next staging deploy would go to the WBS account. The custom domain `staging.aecintegrations.com` cannot bind there until the zone has moved, so that deploy fails.

Until the cutover, deploy to the WBS account by hand from this branch.

## Phase 1: create resources (AECI-1163)

The script creates the following on the WBS account:
- 4 D1 databases
- 8 KV namespaces
- 4 R2 buckets
- 21 Queues

It skips anything that already exists. It pins the WBS account id and runs wrangler from an empty directory, so it cannot read the old `account_id`. It writes `ids.json` next to itself. Hand that file back and the ids go into the wrangler files.

Sign wrangler in as a user with WBS account access first.

```bash
scripts/ops/2026-09-wbs-account-move/create-resources.sh
```

Workflows, Durable Objects and custom domains are created by `wrangler deploy`, not by this script.

## Phase 2: stage the zone on WBS (AECI-1164)

Do these steps by hand in the dashboard:

What a Pending zone accepts, per Cloudflare's docs (checked 2026-09-30):

| Change | On a Pending zone? | Source |
|---|---|---|
| DNS records | Yes | Standard onboarding. Cloudflare answers DNS for Pending zones on the assigned nameservers |
| Enterprise plan | Yes | Required first. The registrar move needs the domain added with a plan selected |
| WAF rules, rate-limit rules, bot settings | Not confirmed | Test it: create one rule on the Pending zone |
| Worker custom domains | **No** | "To add a Custom Domain, you must have an active Cloudflare zone" |

The custom domains therefore bind at the cutover, after the zone activates. That bind is the only real gap in service. It is kept to minutes by pre-deploying everything else (see the weekend schedule).

1. Export DNS from the old zone: DNS → Records → Import and Export → Export.
2. Record every dashboard-only setting. There is no API export for these:
   - Security → Bots (Super Bot Fight Mode, AI bots, JavaScript detections)
   - Security → WAF → Managed rules
   - AI Crawl Control
   - Web Analytics
   - Email Routing (`unsubscribe@`)
   - SSL/TLS mode
3. In the WBS account, add `aecintegrations.com` as a website and assign the Enterprise plan. It stays Pending until the nameservers change. Adding the domain here is safe while it is still live on the old account. It is the documented first step of a move.

   The old zone's **Pro plan is a separate matter**, and so is any other zone add-on. Cloudflare requires both to be gone before the move. Do not cancel Pro in this phase:
   - A Pro cancellation only takes effect at the end of the billing period.
   - While Pro is still active, the old zone keeps its WAF managed rules, both rate-limit rules and Super Bot Fight Mode.
   - Once it lapses, the site has none of those.

   Time the cancellation so Pro ends on the cutover day (Phase 4, step 0).
4. Import the DNS file. Before importing, delete these hostnames from the file:
   - `aecintegrations.com`
   - `www`
   - `staging`
   - `demo`
   - `stack-test`

   Those are Worker custom domains. `wrangler deploy` creates their records. A pre-existing record blocks the custom domain from binding.
5. Keep these records:
   - The M365 MX record
   - The Resend records `send.`, `resend._domainkey` and `_dmarc`
   - `review.`
   - Any Search Console TXT record
6. Rebuild the WAF custom rules and the two rate-limit rules. The expressions are in `docs/waf-rate-limits.md`. Port them 1:1. Enterprise lifts the Pro limit of two rate-limit rules, but redesigning them is separate work.
7. Put the new ruleset and rule ids into `scripts/ops/2026-09-waf-host-scope/rules.mjs` and `docs/waf-rate-limits.md`.

## WAF rule map (copied 2026-09-30)

The source rules are in `waf-export.json`, read from the old zone's dashboard. Each re-typed expression matched the original's character count.

| Rule | Old id | WBS id |
|---|---|---|
| Blocker Rule 1 (Block) | `bc961c9f6c2e4e02ba2429d06f8f1dc2` | `b154c36f480f4f639cb6e614cf75de69` |
| Blocker Rule 2 (Block, 403) | `4781ac7e149247baa5b4119274119821` | `2e2e7ae15d69446a872dcb142e7ed82c` |
| Scraper-UA (Managed Challenge) | `319173bafcf749fdbf9b739480d71ded` | `44749706cd6540d686ba27122176d0cc` |
| Rate limit A: requests, subscribe, feedback (5/60 s per IP, 429, 1 h) | `d5ed0440ab64408d881d890bf10767a5` | `826151ccbc464f4095f7dfedfa8f51ac` |
| Rate limit B: reviews (5/60 s per IP, 429, 1 h) | `45a1fd5d771a4b96bc204012f5965b5d` | `0ec84d97047740beb3ee1e6035301491` |
| Cloudflare Managed Ruleset | default config | default config |
| OWASP Core (Medium 40+, PL1, Block) | same | same |

- Not copied: "Skip WAF for stack-test subdomain". `stack-test` is retired and is not in the WBS DNS.
- Carried over as-is: the host lists still name `prod.aecintegrations.com`, which is retired (AECI-807). Narrowing them is separate work.
- Ruleset ids, read through the API on 2026-10-05: custom `0052017b9bf44ceaad5888bf9d6c3d97`, rate limit `eaec1f752ded4f6e9a16b1ec70c2b087`. `rules.mjs` and `docs/waf-rate-limits.md` pin them.

## Bot settings (compared 2026-09-30)

| Setting | Old zone | WBS | Action |
|---|---|---|---|
| SBFM: JavaScript Detections | On | Was off | **Turned on** |
| SBFM: WordPress / static resource protection | Off / Off | Off / Off | Match |
| SBFM: definitely automated | Allow | Allow | Match |
| SBFM: likely automated | Not on Pro | Allow | Allow does nothing |
| SBFM: verified bots | On | On | Match |
| AI bot policies: Search / Agent / Training | Allow / Allow / Allow | Allow / Allow / Allow | Match |
| AI Crawl Control: per-crawler blocks | None of 32 | Not enabled, so none | Match |
| AI Labyrinth | Off | Off | Match |
| Challenge passage | 30 min | 30 min | Match |
| Browser integrity check | On | On | Match |
| Email obfuscation / hotlink / leaked-credentials | On / Off / Off | On / Off / Off | Match |
| **Continuous script monitoring** | On | Off | **Cutover step.** The toggle does not save on a Pending zone |
| **Bot Preference Sync** (prepends robots.txt) | Off | On | **Cutover step.** Turning it off does not save on a Pending zone. It must go off, or Cloudflare rewrites our robots.txt |

## Phase 3: rehearsal (AECI-1165)

### Access, before anything is deployed

There is one self-hosted Access app on the WBS Zero Trust org (`the-wbs-project.cloudflareaccess.com`):

| Setting | Value |
|---|---|
| Name | `AECi Non-Prod` |
| Destinations | `aeci-*.thewbsproject.workers.dev` and `staging.aecintegrations.com` |
| Allow policy | One-time PIN for chrisw@ and billh@ |
| Service Auth policy | Service token `aeci-gh-actions` |

The `aeci-*` wildcard covers every AECi Worker and every PR preview, and none of the other WBS apps. Its AUD goes into `ACCESS_AUD` in both blocks of `apps/agent/wrangler.jsonc` and in `apps/datatool/wrangler.jsonc`. Until then they carry the old AUDs and fail closed (403).

### Rehearsal deploy

`deploy-rehearsal.sh` deploys the api and web Workers for one environment to WBS:
- `strip-config.mjs` removes every cron trigger and route, so there are no duplicate jobs and no domain conflict.
- The web Worker is served on workers.dev.
- `ALLOW_INDEXING` is forced to `false`, so a production copy can never be indexed.

Worker secrets are **on hold** (Chris, 2026-09-30). Until they are set, anything that needs Algolia, Resend or Supabase admin runs in its warn-and-skip mode.

```bash
scripts/ops/2026-09-wbs-account-move/deploy-rehearsal.sh production
```


Deploy the whole stack to WBS with the custom-domain routes removed, and serve it on `thewbsproject.workers.dev`. Load it with a copy of production data. Time every step.

Export the production D1 from the old account:

```bash
cd "$(mktemp -d)" && CLOUDFLARE_ACCOUNT_ID=e62ec9d8012c3e0c225f8e4dbab76b79 npx -y wrangler@4.123.0 d1 export aeci-app-production --remote --output prod.sql && pwd
```

Reorder it so every table exists before any rows go in. A raw export fails with `no such table: main.profiles`, because `audit_log` rows reference `profiles`. Then split any statement over D1's 100 KB limit with `split-long-statements.py`. Three `promote_jobs` rows were over the limit, and a raw import reset with `D1_RESET_DO`. Then put the rows in foreign-key order with `order-by-fk.py`. D1 checks foreign keys per statement, so the dump's `defer_foreign_keys` does not help. Test locally with `PRAGMA foreign_keys=ON` and the defer line removed, and compare the `.dump` hash against a plain local import. Then import the final file:

```bash
CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 npx -y wrangler@4.123.0 d1 execute aeci-app-staging --remote --file prod.sql
```

Check the import:
- Compare row counts table by table against the source.
- The export includes the `d1_migrations` table, so the imported database starts at the same migration level.

Copy the R2 uploads bucket-to-bucket with rclone, using an S3 API token on each account.

## Weekend schedule

Visitors only lose service between two moments: the WBS zone going Active, and the three `aeci-web-*` Workers binding their custom domains. Everything else moves while the old site keeps serving.

| When | Work | Visitor impact |
|---|---|---|
| Weekdays before | Resources, secrets and the pending zone are staged. The rehearsal has passed. All Workers are deployed on WBS **with crons removed and without routes**, so there is no duplicate cron email and no route conflict | None |
| Friday | Confirm the Pro plan state (Phase 4 step 0). Deploy the old API with crons removed | None |
| Saturday early (low traffic) | Freeze writes. Run the final D1 export/import and R2 copy (minutes, the data is small). Submit the registrar move, approve it, confirm the nameservers, then press Re-check now until Active | None. The old site still serves, read-only |
| Saturday, right after Active | Deploy the three web Workers with routes (about 1 min each). Put the crons back on the WBS API. Verify | **A few minutes** on the apex, www, demo and staging |
| Saturday to Monday | Resolver caches drain to the new nameservers | Unknown until the account team answers the question below |
| Monday | Swap the GitHub secrets. Merge the config PR. Normal CI resumes | None |

Open question for the WBS account team: once a zone is Moved, does the old account keep answering DNS for it? If yes, cached visitors read the old, frozen site until their cache expires. If no, they get errors until then. Most resolvers cap nameserver caching well below the `.com` 48 h maximum.

### Rehearsal result (2026-10-01)

- D1 import into `aeci-app-production` matched production on every counted table: page_views 123070, audit_log 78889, products 334, vendors 221, integrations 1108, claims 2397, migrations 53. It took three passes; see the three prep scripts.
- Smoke test through Access, all 200:
  - `/_version`, `/api/version`, `/api/products`, `/api/vendors`, `/api/integrations`
  - `/`, `/products`, a product page, a vendor page
  - `/vendors` and `/integrations` 301 to `/products`, the same as live
  - Every page sent `x-robots-tag: noindex, nofollow`
- Not tested: search (Algolia), email (Resend), Supabase admin, R2 logos. The secrets are on hold and R2 is not copied yet.

## CI on WBS before cutover (from 2026-10-01)

CI deploys to WBS once the GitHub secrets are swapped and this branch is on `main`. Until the zone moves:
- **Staging** serves on `aeci-web-staging.thewbsproject.workers.dev`. Its custom-domain route is commented out, and the staging smoke and health checks point there. All of it is tagged `WBS-INTERIM`.
- **PR previews and the preview env** work unchanged, on workers.dev.
- **Do not run promote-to-demo or promote-to-prod.** Demo and production cannot bind their domains on WBS yet. Production stays on the old account at `2380b367`.
- `CF_ZONE_ID` and `CF_ANALYTICS_API_TOKEN` keep their old-zone values until the zone moves.

## Phase 4: cutover (AECI-1166)

`cutover.sh` runs the scripted steps one at a time. Each step pins its account, so a token for the wrong account fails instead of writing anywhere. Commands, in order, per environment. Do production last, because it is the one with live traffic.

| # | Token | Command | What it does |
|---|---|---|---|
| a | old | `cutover.sh stop-old-crons production` | Empties the old API's cron schedules through the Workers API. No code is redeployed and the web Worker is untouched. It does not use `wrangler triggers deploy`, because that also syncs queue consumers and fails on queues that exist only on WBS |
| b | old | `cutover.sh export production` | Exports, runs the three prep scripts, proves the prepared file loads with strict foreign keys and is identical to the raw export, and writes expected row counts. About 4 min |
| c | WBS | `cutover.sh reset production` | Restores the WBS database to empty, or skips if already empty |
| d | WBS | `cutover.sh import production` | Imports, then compares every table's row count against the export. Exits non-zero on any mismatch |
| e | | (dashboard) | Registrar move, approve, wait for Active. Then the Worker Access check (step 6a) and the dashboard toggles (6b) |
| f | WBS | `cutover.sh bind production` | Full deploy of api and web: crons back on, custom domains bound |
| g | | `cutover.sh verify` | www 200 on the new sha, apex 301, demo 200, staging 302 to WBS Access |

**Before step f for staging:** revert the interim staging change. Every line is tagged `WBS-INTERIM`: `git grep -n WBS-INTERIM`. Restore the `routes` block in `apps/web/wrangler.jsonc`, drop its `workers_dev: true`, and put `https://staging.aecintegrations.com` back in deploy, refresh-staging, promote-to-demo and browserstack.

Repeat a–d and f for `staging` and `demo`. Not scripted yet: Worker secrets (on hold).

R2 goes across with `copy-r2.sh ENV`. It lists the old bucket with the old-account token, copies each object with `wrangler r2 object get`/`put` (the put uses the WBS OAuth login), skips objects already on WBS at the same size, and fails if any are missing afterwards. No S3 keys are needed. Pass `--dry-run` to list without copying. On 2026-10-04 the old buckets held one object in total, in `aeci-uploads-demo`.


0. Cancel Pro and the Smart Shield Argo add-on on the old zone before 2026-10-07. Cancelling only stops the 2026-10-08 renewal, and Pro keeps working until then. Per Cloudflare's docs, a Pro plan does not block the move:
   - "Remove a domain" requires a Free downgrade for Enterprise only.
   - The Registrar inter-account move lists DNSSEC, lock state and a target plan as prerequisites, not the source plan.

   So the cutover can happen before Pro ends, and the unused Pro days are forfeited. Confirm this when submitting the registrar move. If it is refused, the fallback is the first Saturday after 2026-10-08.
1. Freeze writes. Stop promotes in the review app and stop admin edits.
2. Deploy the old API with its cron triggers removed. Crons on the old account keep firing until the old Workers are gone.
3. Drain the old queues and Workflows.
4. Reset each WBS D1 database to empty, then import. The rehearsal already filled `aeci-app-production`, and a dump cannot import over existing tables. Before the rehearsal import, record the empty bookmark with `wrangler d1 time-travel info`. At cutover, run `wrangler d1 time-travel restore` to that bookmark, then import the fresh export. Do the same for each database. Then copy R2.
   Use the rehearsal commands with the matching database names.
5. Submit the registrar move from the old account: Domain Registration → Manage → Configuration. Approve it in the WBS account.
6. Point the domain at the WBS nameservers. Confirm the WBS zone shows Active.
6a. **Before binding the production and demo custom domains,** check Worker Access on `aeci-web-production` (Workers → aeci-web-production → Access). On 2026-10-01 it was set to "All traffic: require login on every URL". That was a workaround, because the `aeci-*` hostname app sent no login code. If it is still on "All traffic", `www.aecintegrations.com` will demand a login. Scope it to workers.dev and previews only, or turn it off.
6b. On the now-Active WBS zone, turn on continuous script monitoring and turn off Bot Preference Sync.
7. Merge the config PR. Deploy staging, demo and production. `wrangler deploy` binds the custom domains.
8. Verify each of these:
   - `/api/version`
   - `/_version`
   - Home and a pair page
   - Magic-link sign-in
   - One promote
   - One `/admin/purge`
9. Unfreeze. Leave the old stack deployed and read-only for 48 hours, while resolvers still hold the old nameservers.

### Cutover result (2026-10-04)

| Step | UTC |
|---|---|
| Production export finished | 04:10 |
| `.com` delegation changed to amalia/bjorn | 04:22:38 |
| WBS zone Active, old zone Moved | 04:26:13 |
| Demo promoted | 04:37:58 |
| Production promoted | 04:43:40 |

- The outage was about 17 minutes, from zone Active to the production bind. Every host returned 530 in between.
- Production and demo were bound with `promote-to-demo` and `promote-to-prod` on `cc3e921a`, not with `cutover.sh bind`. `main` was 21 commits and six migrations (0053 to 0058) ahead of production. `bind` applies no migrations and puts no secrets. The promote lane does both.
- The registrar move set the `.com` nameservers itself. Nothing was edited by hand. After the delegation changed, the zone stayed Pending until "Check nameservers now" was pressed.
- Before activation, every Cloudflare nameserver pair answered with the active zone's records. That answers the resolver open question above: there is no drain window.
- The first demo promote failed with `No access to the specified resource` on `/zones/…/workers/routes`. The WBS `aeci-github-actions` token had no zone grants. Adding Zone Read, Workers Routes Edit and DNS Edit fixed it. See `docs/CICD_PLAN.md` §7.1.
- `stop-old-crons` failed on its first run. `wrangler triggers deploy` also syncs queue consumers and rejected `aeci-vendor-snapshot-staging`, which exists only on WBS. The step now uses the Workers schedules API.
- Rows written on the old site after 04:10 UTC are not on WBS. The 2026-10-04 diff found no domain rows, only 22 `page_views` rows (04:10 to 04:26), mostly bots. Chris ruled to drop them (AECI-1166, AECI-1167).
- `staging.aecintegrations.com` served publicly after the cutover until it was added to the `AECi Non-Prod` Access app on 2026-10-05 (AECI-1166).

## Phase 5: follow-through (AECI-1167)

- Supabase redirect allow-list: add `https://*.thewbsproject.workers.dev/**`.
- Re-verify the Resend domain, Search Console, Bing and the IndexNow key file.
- Swap the GitHub secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`
  - `CF_ZONE_ID`
  - `CF_ANALYTICS_API_TOKEN`
- Mint new operator tokens: `CF_WAF_API_TOKEN` and `CF_READONLY_API_TOKEN`.
- After 30 days, delete everything left on the old account:
  - Workers, D1, KV, R2
  - `landing-page`, `aec-stack-test`, `aeci-prod-snapshots`

## Lost in the move

Take a final export of each item before anything on the old account is deleted.

- D1 time-travel history
- Workers Logs
- Zone analytics history
- Workflow instance history
- The agent spike's AI Gateway credits and AI Search instances
