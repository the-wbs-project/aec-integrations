# ADR 0036: Move every Cloudflare resource to The WBS Project account

- Status: Accepted
- Date: 2026-09-30. The cutover ran on Sunday 2026-10-04, one day after the planned Saturday.
- Issue: AECI-1161 (phase issues AECI-1162 to AECI-1167; the review app's own move is AECI-1168)
- Supersedes: nothing. It changes where the decisions in ADR 0016, ADR 0017, ADR 0020 and ADR 0021 run, not what they decide.

## Context

AECi ran in its own Cloudflare account, "AEC Integrations" (`e62ec9d8012c3e0c225f8e4dbab76b79`), with the `aecintegrations.com` zone on the Pro plan. The decision with Bill on 2026-09-30 was that AECi stays within The WBS Project. The WBS account (`004dc1af737b22a8aa83b3550fa9b9d3`) has a spare Enterprise zone, so the zone moves onto it and the Pro plan and the Smart Shield Argo add-on on the old zone are cancelled.

One Cloudflare fact shaped the approach. A registrar inter-account move carries the domain but no zone configuration, so everything on the zone is rebuilt on the WBS side.

## Decision

**Redeploy fresh on the WBS account, then copy the data. Nothing moves in place.**

- Workers, Queues, KV, R2, D1, Workflows and Durable Objects are created new on the WBS account. The D1 and KV ids are recorded in `scripts/ops/2026-09-wbs-account-move/ids.json` and wired into the wrangler files.
- D1 data goes across by `wrangler d1 export` and `execute --file`. D1 checks foreign keys per statement and rejects statements over 100 KB, so the dump passes through three prep scripts in that directory: `order-d1-export.py`, `split-long-statements.py` and `order-by-fk.py`. R2 is copied bucket to bucket with rclone.
- The zone moves with the Cloudflare Registrar inter-account move, which needs DNSSEC off. DNS, the WAF rules, the rate-limit rules and the bot settings are rebuilt by hand on the WBS zone and ported 1:1. The old rule ids map to the new ones in `docs/waf-rate-limits.md`.
- Access is one self-hosted app, `AECi Non-Prod`, on the WBS Zero Trust org. Its destination is `aeci-*.thewbsproject.workers.dev`, plus `staging.aecintegrations.com` once the zone is Active.
- The config PR changing `account_id` merges after the cutover, not before. Staging deploys from `main` on every merge, and its custom domain cannot bind on the WBS account until the zone has moved.
- Rate-limit namespace ids 7731 to 7738 are unchanged. None of the local WBS configs declares a `ratelimits` binding, so there is no collision (ADR 0026).
- GitHub secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `CF_ZONE_ID` and `CF_ANALYTICS_API_TOKEN` are swapped after the cutover.
- The old stack stays deployed and read-only for 48 hours. Everything left on the old account is deleted 30 days after the cutover.

The operator procedure is `scripts/ops/2026-09-wbs-account-move/README.md`. It is the source for dates and ids.

## Consequences

**Lost.** These do not move, and a final export is taken before the old account is deleted:

- D1 time-travel history. The new databases start their history at the import.
- Workers Logs.
- Zone analytics history. The `aeci.waf.ratelimit.blocked` poll starts from zero.
- Workflow instance history.
- The agent spike's AI Gateway credits and AI Search instances (ADR 0034).

**Access changes shape.** The Zero Trust org is now `the-wbs-project.cloudflareaccess.com` and the app AUD changed, so `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `apps/agent` and `apps/datatool` are new values. The old account's separate agent-production Access app is folded into the one app. On 2026-10-01 the hostname app did not send one-time codes. Per-Worker Worker Access on `aeci-web-production` was enabled as a workaround. It must be scoped to workers.dev and previews, or turned off, before `www.aecintegrations.com` binds, or the public site asks for a login.

**The workers.dev subdomain is shared.** It is now `thewbsproject.workers.dev`, which other WBS apps also use. Any pattern on that suffix is wider than AECi. The Access destination uses `aeci-*.` for that reason. The page-views self-host suffix in `apps/api/src/routes/page-views.ts` is `thewbsproject.workers.dev`, so it also matches other WBS apps' hosts. The Supabase redirect allow-list needs `https://*.thewbsproject.workers.dev/**`, which is wider than AECi for the same reason.

**The cutover depends on the registrar move.** Worker custom domains cannot bind until the WBS zone is Active, so there are a few minutes of real downtime on the apex, `www`, `demo` and `staging` between the zone going Active and the three web Workers deploying with routes. If Cloudflare refuses the move because the old zone is still on Pro, the fallback is the first Saturday after the Pro renewal on 2026-10-08. After the move, whether the old account keeps answering DNS for cached resolvers is an open question to the account team.

**Pro limits no longer bind.** The two-rate-limit-rule cap and the one-minute counting window described in `docs/waf-rate-limits.md` were Pro limits. The rules were ported unchanged. Using the Enterprise headroom is separate work.
