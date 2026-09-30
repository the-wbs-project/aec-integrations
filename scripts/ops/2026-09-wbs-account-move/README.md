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
| Resources created on WBS | Not started. Run `create-resources.sh` |
| Config PR (branch `aeci-1163-wbs-account-move`) | Open, not merged. It merges at the cutover, not before |
| Zone staged on WBS | Not started |
| Old zone Pro plan removed | Not started. It sets the cutover date. See Phase 4 step 0 |
| Rehearsal | Not started |
| Cutover | Not scheduled |

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

## Phase 3: rehearsal (AECI-1165)

Deploy the whole stack to WBS with the custom-domain routes removed, and serve it on `thewbsproject.workers.dev`. Load it with a copy of production data. Time every step.

Export the production D1 from the old account:

```bash
cd "$(mktemp -d)" && CLOUDFLARE_ACCOUNT_ID=e62ec9d8012c3e0c225f8e4dbab76b79 npx -y wrangler@4.123.0 d1 export aeci-app-production --remote --output prod.sql && pwd
```

Import it into the WBS staging D1, from the same directory:

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

## Phase 4: cutover (AECI-1166)

0. Before the window, the old zone must have no plan or add-on subscriptions left. Look up the Pro billing date in the old account under Billing → Subscriptions. Cancel Pro at least 24 hours before that date. Book the cutover for the day Pro ends.

   We do not know whether Cloudflare accepts the move while a cancellation is only scheduled. If it does, the cutover can come earlier. Ask Cloudflare support, or try the registrar move once the cancellation is scheduled.
1. Freeze writes. Stop promotes in the review app and stop admin edits.
2. Deploy the old API with its cron triggers removed. Crons on the old account keep firing until the old Workers are gone.
3. Drain the old queues and Workflows.
4. Export and import all four D1 databases, and copy R2. Use the rehearsal commands with the matching database names.
5. Submit the registrar move from the old account: Domain Registration → Manage → Configuration. Approve it in the WBS account.
6. Point the domain at the WBS nameservers. Confirm the WBS zone shows Active.
7. Merge the config PR. Deploy staging, demo and production. `wrangler deploy` binds the custom domains.
8. Verify each of these:
   - `/api/version`
   - `/_version`
   - Home and a pair page
   - Magic-link sign-in
   - One promote
   - One `/admin/purge`
9. Unfreeze. Leave the old stack deployed and read-only for 48 hours, while resolvers still hold the old nameservers.

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
