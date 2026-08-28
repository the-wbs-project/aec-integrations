# AEC Integrations — CI/CD Plan

**Referenced by:** `STAGE_1_SPEC.md` §16 (Build Order), §24 (Development Workflow)
**Version:** 1.1
**Date:** May 2026 — **last reconciled against the live pipeline 2026-08-14**
**Platform re-evaluation:** Cloudflare CI on Workflows assessed and declined 2026-08-14 (AECI-555) — §1, §13.4

> **Reconciliation note (2026-08-14).** §2, §3.2, §3.3, §3.4, §4.1 and §9.1 were written
> pre-launch and had drifted from what the workflows actually do. Corrected in this pass:
> the Supabase-project topology (one shared project, not per-env), production's Access +
> indexing state (launched — public and indexable), `deploy-staging`'s real step list (D1
> migrations, no deploy marker, no Playwright smoke, no approval-request step), and the
> removal of every Slack reference. Claims below were verified against
> `.github/workflows/*.yml`, `apps/web/wrangler.jsonc`, and live HTTP probes.

---

## 1. Platform: GitHub Actions

GitHub Actions is the CI/CD platform. Cloudflare Workers Builds is rejected for reasons below.

**Why GitHub Actions:**
- Already using GitHub for source control
- Native integration with Wrangler for Cloudflare deploys via `cloudflare/wrangler-action`
- Linear's GitHub integration triggers off PR/commit events
- Massive ecosystem of pre-built actions (axe-core, Lighthouse CI, Playwright)
- Generous free tier (unlimited for public repos; 2,000 minutes/month for private)
- Mature secret management with environment scoping

**Why not Cloudflare Workers Builds:**
- Designed for simple build-and-deploy workflows
- Less flexible for the multi-step pipeline we need (lint, type check, test, build, deploy, smoke test)
- Smaller ecosystem of reusable steps
- Workers Builds is fine for "deploy on push" projects — we need more

**Why not Cloudflare CI on Workflows (re-evaluated 2026-08-14 — AECI-555):**

A different Cloudflare product from Workers Builds above: CI pipelines written in **TypeScript** via
[`@cloudflare/ci`](https://github.com/cloudflare/ci) instead of YAML, running as Cloudflare
Workflows — durable execution, retry-with-state, **restart from a specific step**, and dependency
caching snapshotted to R2 ([announcement](https://blog.cloudflare.com/ci-workflows/)). Genuinely
attractive; declined for now on five counts:

1. **Monorepo support has not shipped** — still roadmap item #3 ("Monorepos: simplified management
   for multi-Worker deployments using one CI pipeline"). We are a pnpm monorepo with two Workers.
2. **Triggers are Artifacts-push-only** (`cf.artifacts.repo.pushed`). Push events "from any version
   control system, not just Artifacts" are roadmap item #4 — so today the repo would have to *live*
   in Cloudflare Artifacts, taking Linear's GitHub integration, branch protection, and the §8
   required-check gate with it. This is a larger cost than "code lives there" suggests.
3. **Artifacts is still closed beta** — access is request-gated.
4. **No pricing announced.**
5. **The ten workflows here encode load-bearing logic** — the dual SSR+API SHA gate (§9.2), the
   demo→prod promotion ordering (§3.3), the schema-drift gate (§5.5), reconcile-counts. Porting that
   onto a closed beta for a *live production site* is a bad trade.

The one feature worth wanting — restart-from-step — turns out to be adequately approximated by
GitHub Actions' job-scoped re-runs given how this pipeline is already structured. **§13.4** carries
that analysis and the dated re-check log. Revisit when Artifacts is GA **and** monorepos have
shipped.

---

## 2. Environments

> **Current state (deviation from spec) — set 2026-05-18, updated 2026-05-26.**
> - **Staging** is auto-deployed on merge to `main` via `.github/workflows/deploy.yml` `deploy-staging` job, gated by `vars.STAGING_ENABLED`.
> - **Demo** is promoted manually via `.github/workflows/promote-to-demo.yml` — `workflow_dispatch` with `commit_sha` + `confirm=PROMOTE`. The public showcase tier, inserted between staging and production; it shares the prod Supabase project (touches no Postgres).
> - **Production** is promoted manually via `.github/workflows/promote-to-prod.yml` (AECI-78) — `workflow_dispatch` with explicit `commit_sha` + `confirm=PROMOTE` inputs and a GH Environment approval gate. It promotes from **demo** (the immediate upstream tier). There is intentionally **no auto-deploy to demo or production**.
> - **Per-PR previews** are wired via `.github/workflows/pr-preview.yml` (AECI-79). Only the SSR Worker is per-PR (`aeci-web-pr-<N>` on `*.aec-integrations.workers.dev`); the API Worker is shared (`aeci-api-preview`) and reaches the app DB through its native D1 `DB` binding (no Prisma Accelerate, no `DATABASE_URL`; ADR 0016). See `docs/environments.md` §"PR previews" for the DB-strategy decision.

Four permanent environments, all on Cloudflare — plus, while Stage 2 is being tested, one temporary fifth:

| Environment | URL pattern | Triggered by | Auto/Manual | Data |
|---|---|---|---|---|
| **Preview** | `aeci-web-pr-<N>.aec-integrations.workers.dev` | Every PR push | Auto | `aeci-app-preview` D1 via `aeci-api-preview` (Option 1, see environments.md) |
| **Staging** | `staging.aecintegrations.com` | Merge to `main` | Auto | `aeci-app-staging` D1 |
| **Demo** | `demo.aecintegrations.com` | Manual, after staging | Manual | `aeci-app-demo` D1 |
| **Production** | `aecintegrations.com` + `www.` (public, canonical) and `prod.` | Manual approval, after demo | Manual | `aeci-app-production` D1 |
| **stage2** _(temporary — AECI-637)_ | `stage2.aecintegrations.com` | Nothing — **no workflow exists** | By hand, `wrangler deploy --env stage2` from a `stage-2` SHA | `aeci-app-stage2` D1 |

> **`stage2` is outside the promotion chain by design.** It exists because staging auto-tracks `main` (§10 / ADR 0019), so the completed Stage 2 build has no deployed surface; there is no `promote-to-stage2.yml`, no GH Environment, and no GH secret that names it. It carries **no `triggers.crons` and no `queues`**, so it runs no scheduled jobs and cannot send email. Bootstrap, secret posture and teardown: `docs/environments.md` §10. Delete it when Stage 2 testing is done.

> **One Supabase project, one D1 database per tier.** Per **ADR 0017** every tier shares a *single*
> Supabase project (`ktuhnlypztujpsseujzx`, verified in every `env.*` block of both
> `wrangler.jsonc` files — including the temporary `env.stage2`) and Supabase is **auth only** — hence the single un-suffixed
> `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` (§7.1). The application database is
> Cloudflare D1 (ADR 0016) and *that* is what is per-tier. Earlier revisions of this table said
> "Staging Supabase project" / "Production D1 + Supabase", implying per-env Supabase projects;
> they do not exist.

### 2.1 Preview environment

Spun up per PR by [`pr-preview.yml`](../.github/workflows/pr-preview.yml) (AECI-79). Provides a working deployment for human review; the preview-URL E2E / integration-runner jobs remain parked in `deploy.yml` pending separate work to bridge them across workflows. (E2E and axe run **on every PR** against a local `dev:bound` server in `deploy.yml`. Lighthouse used to as well — AECI-65 un-parked it against `dev:bound` — but it never gated anything on a PR and has since moved to its own **push-to-main-only** workflow ([`lighthouse.yml`](../.github/workflows/lighthouse.yml)), so it no longer runs on PRs; it **error-gates the post-merge run** instead (AECI-188 — a budget miss turns the workflow red after merge).)

- Each PR gets a unique SSR Worker `aeci-web-pr-<N>` at `https://aeci-web-pr-<N>.aec-integrations.workers.dev`.
- Auto-deletes when the PR is closed or merged (cleanup job in the same workflow).
- **DB:** the shared `aeci-api-preview` Worker reaches Cloudflare D1 via its native `DB` binding (ADR 0016) — no Prisma Accelerate, no per-PR Supabase branches (see `docs/environments.md` §"PR previews" for the trade-off and decision history).
- Fronted by the "AECi Non-Prod" Cloudflare Access app — service token for CI, OTP-to-email for humans (see `docs/access.md`).
- Resend and Linear behaviour for previews is shared with staging (preview Workers don't have their own integrations — they ride on whatever the shared `aeci-api-preview` is wired to). **PostHog is now the second exception:** since AECI-640 the publishable `phc_` token is a committed `env.preview` wrangler var pointing at `aec-integrations-dev` (525793), so **every PR preview gets analytics and error tracking for free** — no secret push, nothing to provision. Previews also post a PostHog `deployment` marker (`deploy_kind: preview`) and upload hidden source maps. **Algolia is the other exception:** previews use their own dedicated `preview_*` index set (and `preview` scoped keys), per §7.5 — so preview/local search can't poison staging data. Local `pnpm dev:bound` (`ENV=preview`) rides the same `preview_*` set.

### 2.2 Staging environment

Mirror of production, but with test data and isolated from real users.

- Always reflects the latest `main` branch
- Own D1 database (`aeci-app-staging`); shares the single Supabase **auth** project with every other tier (ADR 0017)
- Algolia connects to dedicated staging indexes (`staging_*`; physical naming per §7.5)
- PostHog under the non-prod project `aec-integrations-dev` (525793), separated from the other non-prod tiers by `$host` / `env`
- Resend sends real emails but only to allowlisted internal addresses
- Linear creates real issues in a "Staging Test" project
- Used for smoke tests, manual QA, and demos
- **Network-level access control:** staging and `*.aec-integrations.workers.dev` previews sit behind Cloudflare Access (email-allowlist OTP for humans, service token for CI) — verified 2026-08-14: `https://staging.aecintegrations.com/` still 302s to the Access login. The demo tier is intentionally public (showcase), and **production is now public too** (see §2.4 — the pre-launch Access gate is gone). See [`access.md`](./access.md) for the runbook (allowlist management, service-token rotation, lockout recovery).

### 2.3 Demo environment

The public showcase tier (`demo.aecintegrations.com`), inserted between staging and production. Promoted from staging via [`promote-to-demo.yml`](../.github/workflows/promote-to-demo.yml) — see `docs/environments.md` → "Promote-to-demo runbook".

- Public (no Cloudflare Access), but `ALLOW_INDEXING="false"` (no-index) like production.
- **Shares the prod Supabase auth project** (one admin login works on demo + prod; the app DB is Cloudflare D1 per ADR 0016), but has its **own** D1 (`aeci-app-demo`), KV, queues (`aeci-*-demo`), and Algolia (`demo_*`) index set.
- `ENV=demo` → PostHog `env` dimension `demo`, `demo_*` Algolia prefix. Recognised as a public site by `isPublicSite()` alongside production (blocks `/preview/*` etc.).
- **PostHog: the non-prod project** (`aec-integrations-dev`, 525793) since AECI-640. Before that, `promote-to-demo.yml` pushed `POSTHOG_KEY_PRODUCTION` to the demo Worker, so synthetic demo traffic landed in the **production** project and skewed every production number. Events in 354071 from before that change carry mixed tiers — filter by `$host` when reading history.
- Touches no Postgres on promote — `promote-to-demo.yml` is the light sibling of promote-to-prod.

### 2.4 Production environment

The real site. **Launched** — the AECI-247/277 apex cutover is done, so production serves the public apex `aecintegrations.com` and `www.aecintegrations.com` (the bare apex 301s to `www.`, which is canonical per ADR 0011 as amended 2026-07-05) plus the internal `prod.aecintegrations.com`. Promoted from **demo** via manual approval — see `docs/environments.md` → "Promote runbook" for the operator flow.

- Deployed only after the demo deployment is verified (the pre-promotion check asserts demo is at the SHA)
- Manual approval gate in GitHub Environments (Chris clicks "Approve" button on the `deploy-prod-workers` job in `.github/workflows/promote-to-prod.yml`)
- Own D1 (`aeci-app-production`); shares the single Supabase auth project (ADR 0017)
- Production Algolia indexes (`production_*`)
- PostHog under the production project `aec-integrations` (354071), with deployment markers — the live alerting plane (ADR 0024; the Datadog plane was retired at AECI-651)
- **PostHog: the only tier on the production project** `aec-integrations` (**354071**). Every other tier reports to `aec-integrations-dev` (525793), which is what makes a production number a production number
- **Public and indexable.** `ALLOW_INDEXING="true"` (`apps/web/wrangler.jsonc` `env.production`) — no `X-Robots-Tag: noindex`, and `robots.txt` / `sitemap.xml` are crawlable
- Resend sends to real users
- Linear is the live vendor request destination

> **Production is NOT behind Cloudflare Access.** Verified 2026-08-14 by direct probe: both
> `https://www.aecintegrations.com/` and `https://prod.aecintegrations.com/` return **HTTP 200**
> with no Access redirect (staging, by contrast, still 302s to the Access login). Earlier text
> here said "Cloudflare Access-gated until launch (ADR 0017)"; launch has happened. Note that
> the `env.production` comment block in `apps/web/wrangler.jsonc` still claims the `prod.` host
> "stays crawler-free via Cloudflare Access" — **that comment is stale and its premise is
> false**, which means `prod.` is a publicly reachable duplicate of `www.` under a single
> `ALLOW_INDEXING="true"`. Worth either re-gating `prod.` in Access or dropping the host;
> tracked separately, not changed here.

---

## 3. Pipeline

### 3.1 On every PR push

Runs in parallel where possible to minimize wall time. Goal: under 10 minutes total.

> **The PR lane is base-branch-agnostic — every PR runs the full gate regardless of what it
> targets.** `deploy.yml` and `integration-db-tests.yml` intentionally carry **no `branches:`
> filter** on their `pull_request` trigger, matching `pr-preview.yml` and `drift-check.yml`.
> This is load-bearing under the ADR 0019 branch model (§10): `branches:` on `pull_request`
> filters by **base** branch, so the former `branches: [main]` made this entire suite invisible
> to any PR targeting a long-lived integration branch (`stage-2`, `admin-panel`) or an epic
> branch (`aeci-513`) — i.e. to most of the work in flight. It went unnoticed until PR #521
> (the AECI-513 vendor-portal epic, ~13k lines into `stage-2`) merged having run **only**
> `pr-preview`: no lint, no typecheck, no unit tests, no build, no E2E. Omitting the filter
> rather than listing branches means epic branches are covered as they come and go, with no
> list to maintain. It is safe because `deploy-staging` is independently gated on
> `push` + `refs/heads/main` (plus `vars.STAGING_ENABLED`), so a non-`main` PR runs
> `lint-and-types` / `unit-tests` / `build-web` / `e2e-and-integration` and **deploys nothing**.
> The `paths-ignore` (docs-only) and `paths` (auth/JWKS input set) filters are unchanged and
> remain the real cost control.

**Job: `lint-and-types`** (~2 min)
1. Checkout
2. Setup Node 24 with cache
3. `pnpm install --frozen-lockfile`
4. `pnpm run lint` (ESLint ×4 packages + `apps/web/scripts/check-source-constraints.mjs` + Prettier)
5. `pnpm run typecheck` (`tsc --noEmit` across the monorepo)

This job is where the non-negotiable constraints are enforced (AECI-549), not just style: the Drizzle/D1 data-layer ban, zoneless, light-theme-only, and the `Vary` discipline all fail here. Because `lint-and-types` is a required check on `main` and `stage-2`, a PR cannot merge while violating one. See `ANGULAR_STYLE_GUIDE.md` §24 for the rule-to-constraint map.

**Job: `unit-tests`** (~3 min)
1. Checkout, install
2. `pnpm run test:unit` (Vitest)
3. `pnpm -r run test:coverage` as an **advisory, non-blocking** step
   (`continue-on-error`); uploads the lcov/HTML `coverage` artifact
4. Coverage is **reported, not gated** — a drop does not fail the job
   (`TESTING_STRATEGY.md` §3.3). There is no Codecov integration today.

**Job: `integration-db-tests`** (~3 min, AECI-90; its own workflow `integration-db-tests.yml`, extracted from `deploy.yml`) — *non-blocking*
1. Checkout, install
2. Boot a full local Supabase stack on the runner (`supabase start`)
3. Map `supabase status -o env` → the spec env vars; mint a
   `SUPABASE_TEST_USER_JWT`
4. Run the `apps/api` `src/integration/**` lane — post-D1 a **single** spec,
   `user-auth.jwks.spec.ts` (live ES256 JWKS regression guard for
   `requireUserAuth()`; auth is retained on Supabase) — via `test:integration:ci`.
   No ORM client-generation step is needed (Drizzle requires none; Prisma was removed in AECI-278).
5. Fail on a **0-collected or silently-skipped** result (the spec
   `describe.skipIf`s on env, so a misconfigured job would skip-and-pass). Not in
   `deploy-staging`'s `needs` yet — promote to a required check once stable. See
   `TESTING_STRATEGY.md` §6.5.

> **ADR 0016 / AECI-234:** the reviews/profiles authorization deny-matrix is **not** in this
> job — under D1 (no RLS) it is an app-layer **no-leakage matrix in the unit lane**
> (`apps/api/src/routes/reviews.authz-matrix.spec.ts` / `profiles.authz-matrix.spec.ts`), run by
> the `unit` job on every PR. The Postgres/PostgREST suites this lane once planned (RLS deny
> matrices, GDPR delete trigger, Airtable bulk migrate, count/backfill checks) were removed in
> PR #359 and the references pruned in AECI-265; only the auth/JWKS spec remains.

**Job: `build`** (~3 min)
1. Checkout, install
2. `pnpm run build` (Angular SSR build for Cloudflare Workers)
3. Bundle size check against budget (defined in `TESTING_STRATEGY.md`)
4. Upload build artifact for downstream jobs

**Per-PR preview deploy** — lives in the separate [`pr-preview.yml`](../.github/workflows/pr-preview.yml) workflow (AECI-79), not as a job in `deploy.yml`. Triggered by `pull_request` (`opened` / `synchronize` / `reopened`); the deploy job builds the SSR Worker, runs `wrangler deploy --env preview --name aeci-web-pr-<N>` with `COMMIT_SHA` + `DEPLOYED_AT` vars, verifies both `/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report the PR head SHA, and posts a sticky PR comment with the preview URL. The matching `closed` event teardown runs `wrangler delete`. No Supabase migrations are applied per-PR under the current Option 1 strategy.

**Job: `e2e-tests`** (depends on `deploy-preview`, ~5 min)
1. Wait for preview deployment health check
2. Run Playwright E2E suite against preview URL
3. Capture screenshots and traces on failure
4. Upload Playwright report as artifact

> The E2E suite that actually gates PRs is the local **`e2e-and-integration`** job
> (against `dev:bound`), not this parked preview-URL job. Its Playwright step also
> passes `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_TEST_USER_EMAIL` /
> `SUPABASE_TEST_USER_PASSWORD` (AECI-235) so `authed-console.spec.ts` can mint a real
> admin session and console-check the auth-gated Phase 5 pages — warn-and-skip when the
> `SUPABASE_TEST_USER_*` secrets are unset. See `TESTING_STRATEGY.md` §7.6.

**Job: `accessibility`** (depends on `deploy-preview`, ~2 min)
1. Run axe-core via Playwright against key pages on preview
2. Fail if any violations above "moderate" severity
3. Comment on PR with summary if violations found

**Job: `lighthouse`** (depends on `deploy-preview`, ~3 min)
1. Run Lighthouse CI against preview URL for home, product, vendor pages
2. Compare against performance budget (Core Web Vitals targets)
3. Fail if LCP > 2.5s, INP > 200ms, CLS > 0.1, or Accessibility < 95
4. Comment on PR with scores

**Aggregate PR result:**
- All checks green: PR is mergeable
- Any check failed: merge blocked, PR comment shows failure details

### 3.2 On merge to `main` (and to the long-lived integration branches)

Re-runs all PR checks against the merged code (in case of merge conflicts), then deploys to staging.

> **This IS wired.** An older callout here said "Merges to `main` re-run CI only; no environment
> is deployed" — that was true only while `deploy-staging` was gated off. The repo variable
> `STAGING_ENABLED` has been `true` since 2026-05-28 (verified 2026-08-14 via `gh variable
> list`), so every merge to `main` deploys staging.

> **Which branches get a post-merge run.** Unlike the PR lane (§3.1, base-branch-agnostic), the
> `push` trigger *does* keep an explicit branch list — `[main, stage-2, admin-panel]`: the
> production line plus the long-lived integration branches of §10. A post-merge run only earns
> its cost on branches that accumulate merges, where it catches what PR-time gating structurally
> cannot — a squash-merge whose result differs from every PR head (a semantic conflict between
> two PRs that landed in sequence). Feature and epic branches are already covered by their own PR
> run, so listing them here would only double-bill. **Maintenance:** add a branch to
> `deploy.yml`'s `push.branches` when a new long-lived integration branch is opened, and remove
> it once that branch merges up and is retired. Only the `main` entry deploys anything —
> `deploy-staging` is separately gated on `github.ref == 'refs/heads/main'`, so a push to
> `stage-2` / `admin-panel` runs the test jobs and stops.

**Job: `deploy-staging`** — the actual step order in `deploy.yml`, verified 2026-08-14:
1. All PR checks repeat (lint, types, tests, build) — via `needs:`
2. `scripts/require-secrets.sh` preflight — refuse to deploy a half-provisioned staging
3. Provision the staging queues — the scheduled-job set (`aeci-algolia-sync-staging`, `aeci-algolia-drift-staging`, `aeci-stats-staging`, `aeci-reconcile-staging`, `aeci-data-quality-staging`, and the AECI-302 `aeci-attestation-notify-staging`) plus the WC-5 `aeci-cache-purge-staging` purge queue; idempotent
4. Apply **Cloudflare D1** migrations — `scripts/d1-apply-migrations.sh aeci-app-staging staging`. *(Not Supabase: the app DB is D1 per ADR 0016 and the `supabase db push` path was decommissioned in AECI-278 — see §5.)*
5. `wrangler deploy --env staging` for the API Worker, then push its runtime secrets (`REVIEW_APP_TOKEN`, Algolia, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CF_ANALYTICS_API_TOKEN` — the optional ones warn-and-skip)
   - **5b — PostHog source maps** (`scripts/ci/posthog-sourcemaps.sh`, AECI-646) — runs **after the build and before the SSR deploy**, and that order is load-bearing: `posthog-cli sourcemap inject` rewrites the built JS to add the `//# chunkId=…` comment PostHog matches on, so deploying the pre-inject bundle would upload maps that can never be matched. Angular's `production` configuration emits **hidden** maps (no `sourceMappingURL` comment in the served JS), and **every exit path of the script deletes the `.map` files** — including the warn-skip when `POSTHOG_CLI_API_KEY` is absent. That deletion is the safety property, not a tidy-up: `dist/browser` is uploaded verbatim as Worker assets, so a surviving `.map` would publish the whole app source at a guessable URL.
6. `wrangler deploy --env staging` for the SSR Worker, then push its public config (`SUPABASE_ANON_KEY`, Algolia public config). **No observability push step at all** — AECI-640 deleted the four PostHog ones and AECI-651 deleted the Datadog RUM credential push; the publishable `phc_` token is a committed `vars.POSTHOG_PROJECT_KEY` in `wrangler.jsonc`
   - **6b — PostHog deploy marker** (`scripts/ci/posthog-deploy-marker.sh`, `deploy_kind: deploy`, non-prod project) — see §9.1
7. `scripts/verify-worker-secrets.sh` — assert the staging API Worker has the required set
8. Smoke test: poll until **both** Workers report the deployed SHA and `/api/health` is `db:ok` (`scripts/verify-version.sh` + `verify-health.sh`, §9.2). This is a version/health poll, **not** a Playwright suite
9. Update Algolia staging index settings (AECI-137; as of AECI-175 this also links +
   configures each primary's sort **replicas** — needs the management key scoped to the
   replicas, see §7.4/§7.5), then run the **report-only**
   Algolia ↔ D1 index-drift check (AECI-140, `scripts/reconcile-algolia-drift.ts`,
   `continue-on-error`) — surfaces drift via the `aeci.algolia.index_drift` gauge without
   blocking the deploy. The scheduled (daily 09:00 UTC = 04:00 EST) drift check runs as the API Worker
   cron (`apps/api/src/scheduled.ts`, §23.1); this step is the immediate post-deploy check.

> **Three steps this section used to list do not exist.** There was **no Datadog deployment
> marker** on `deploy-staging` — Datadog markers were posted only by `promote-to-prod.yml` and
> `promote-to-demo.yml` (§9.1). *(The **PostHog** marker is different: since AECI-640 it runs on
> all four deploy paths, staging included — steps 5b/6b above.)* There is **no Slack notification** anywhere in the repo (§3.3).
> And there is **no "open GitHub Environment approval request" step** — promotion is a separate
> manual `workflow_dispatch` (§3.3), not something staging queues up.

### 3.3 On manual production approval

Production deploys run via `.github/workflows/promote-to-prod.yml` (AECI-78). See `docs/environments.md` → "Promote runbook" for the operator flow.

Triggered by Chris (workflow_dispatch with `commit_sha` + `confirm=PROMOTE` inputs) and gated by the `production` GH Environment approval on the `deploy-prod-workers` job. Promotes from the **demo** tier (chain: staging → demo → production). Two jobs in order:

**Job: `pre-promotion-checks`**
1. Validate `confirm == PROMOTE`
2. Checkout at `inputs.commit_sha`
3. Assert **demo** reports the same SHA on **both** `demo.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) via `scripts/verify-version.sh`, else fail with `demo is not at <input> on both Workers (API + SSR), refusing to promote` (the script logs the actual per-Worker SHAs). `/api/version` alone is proxied raw to the API Worker, so it can't catch a stale SSR deploy.
4. `scripts/require-secrets.sh` — refuse to promote if a required prod secret is missing (before the approval gate, so nothing is deployed)

**Job: `deploy-prod-workers`** (gated by GH Environment `production` — the single approval gate; blocks before any mutation)
1. Provision the prod scheduled-job queues — six as of AECI-302 (`aeci-{algolia-sync,algolia-drift,stats,reconcile,data-quality,attestation-notify}-production`) — **and the WC-5 cross-Worker `aeci-cache-purge-production` queue** (idempotent; before both Worker deploys — its consumer is on the SSR Worker)
2. Apply the app DB migrations to **Cloudflare D1** + reconcile the D1 taxonomy seed via `scripts/d1-apply-migrations.sh aeci-app-production production` (wraps `wrangler d1 migrations apply … --remote` + the two `wrangler d1 execute … --file=seed/*.sql` reconciles, **retrying each on a transient Cloudflare D1 `[code: 7500]` internal error** — safe because all three are idempotent), then purge the taxonomy cache tags. This is the **only** data migration — the app DB is D1 (ADR 0016); the promote touches no Supabase Postgres (auth is the single shared project, ADR 0017, whose auth-only baseline is maintained out of band). No pg_dump → R2 snapshot, no `supabase db push`, no drift/RLS gate (mirrors `promote-to-demo.yml` — AECI-256/278)
3. Deploy `apps/api` with `--env production --var COMMIT_SHA --var DEPLOYED_AT`, then push the Worker runtime secrets
4. Deploy `apps/web` with `--env production --var COMMIT_SHA --var DEPLOYED_AT`, then push the Worker runtime secrets
5. Post the deployment marker — the PostHog annotation + `deployment` event (§9.1). (A Datadog `/api/v1/events` marker ran alongside it until AECI-651.) Source maps were injected + uploaded earlier, before the SSR deploy (§3.2 step 5b)
6. Poll both `prod.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) until **both** return the promoted SHA **and** `/api/health` is `db:ok` (60s budget) via `scripts/verify-version.sh` + `scripts/verify-health.sh`; a smoke failure auto-rolls-back both Workers
7. Write summary (commit, DEPLOYED_AT, actor)

The **demo** tier is deployed by the light sibling [`promote-to-demo.yml`](../.github/workflows/promote-to-demo.yml): validate `confirm` → assert **staging** is at the SHA → (GH Environment `demo`) provision `aeci-*-demo` queues (the six-queue scheduled-job set, incl. the AECI-302 `aeci-attestation-notify-demo`, + the WC-5 `aeci-cache-purge-demo` queue) → apply `aeci-app-demo` D1 migrations (`scripts/d1-apply-migrations.sh`, which retries a transient D1 `[code: 7500]` internal error) → deploy `aeci-{api,web}-demo` → push demo Worker secrets → smoke `demo.aecintegrations.com` → auto-rollback on smoke failure. The `demo` GH Environment has no required reviewer by default (add one to gate it). It touches no Postgres (demo shares the prod Supabase project, which production owns).

Algolia index updates **are** wired (step 9 of `deploy-staging` above, and the equivalent in both promote workflows). **Slack was dropped from the project entirely**, not deferred — there is no Slack integration anywhere in `.github/workflows/` or `scripts/` (the only mention was a comment recording that an alert-grade Datadog *event* replaced it on rollback — removed with the Datadog leg at AECI-651). Release-tag automation remains unbuilt — see §3.4.

### 3.4 On release tag (e.g. `v1.0.0`) — **NOT IMPLEMENTED**

> **Aspirational, not wired.** There is no release/tag workflow in `.github/workflows/`
> (verified 2026-08-14), so pushing a `vX.Y.Z` tag today triggers nothing. Release tags are cut
> by hand from `main` after a validated prod promote and serve as break-glass branch points
> (§10). The list below is the design if this is ever built; the Slack line is void regardless,
> per §3.3.

- Would be the same as production approval, but also:
  - Generate a changelog from commit messages since the previous tag
  - Create a GitHub Release with the changelog
  - ~~Post release notes to Slack~~ (no Slack in this project)

---

## 4. Deployment mechanics

### 4.1 Wrangler

Wrangler is the only deployment tool. Single source of truth for Worker configuration.

**Configuration files:**
- `wrangler.jsonc` per Worker package (e.g., `apps/web/wrangler.jsonc`, `apps/api/wrangler.jsonc`), with environment overrides under `env.preview`, `env.staging`, `env.demo`, `env.production`. JSONC is preferred over TOML because it allows comments and matches the validated pattern in `apps/web/wrangler.jsonc` and `apps/api/wrangler.jsonc`.
- Compatibility date locked per environment to prevent surprise Worker runtime changes
- SSR Worker requires `"compatibility_flags": ["nodejs_compat"]` — needed for `@angular/ssr` runtime Node polyfills. This is unrelated to database access; see `DATABASE_SCHEMA.md` §1a.
- API Worker does not need `nodejs_compat` for the DB path — it reaches Cloudflare D1 through its native `DB` binding (Drizzle), no pg adapter, no Accelerate (ADR 0016).
- Custom domain routing uses `routes` with `"custom_domain": true` per the `apps/web/wrangler.jsonc:78-85` pattern, not zone-level `route` strings.

**Pattern (SSR Worker — `apps/web/wrangler.jsonc`):**
```jsonc
{
  "name": "aeci-ssr",
  "main": "dist/server/server.mjs",
  "compatibility_date": "2026-07-10",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "directory": "./dist/browser" },
  "observability": { "enabled": true },
  "env": {
    "preview": { "vars": { "ENV": "preview" } },
    "staging": {
      "vars": { "ENV": "staging" },
      "routes": [{ "pattern": "staging.aecintegrations.com", "custom_domain": true }]
    },
    "demo": {
      "vars": { "ENV": "demo" },
      // public showcase tier; shares the prod Supabase auth project
      "routes": [{ "pattern": "demo.aecintegrations.com", "custom_domain": true }]
    },
    "production": {
      "vars": { "ENV": "production", "ALLOW_INDEXING": "true" },
      // Post-apex-cutover (AECI-247/277): the app IS the public site. The bare
      // apex 301s to www. inside the SSR Worker; `prod.` is the internal host.
      "routes": [
        { "pattern": "aecintegrations.com", "custom_domain": true },
        { "pattern": "www.aecintegrations.com", "custom_domain": true },
        { "pattern": "prod.aecintegrations.com", "custom_domain": true }
      ]
    }
  }
}
```

The multi-locale Angular build emits a single `server.mjs` that dispatches by URL prefix (`/`, `/es`, etc.) — no per-locale deploys, no per-locale Workers. The deploy command is just `wrangler deploy --env <env>`. See `STAGE_1_SPEC.md` §7a.3a.

### 4.2 Service bindings

The SSR Worker calls the API Worker via service binding, configured per environment:

```toml
[[env.production.services]]
binding = "API"
service = "aeci-api-production"
```

The API Worker is private — has no route, only callable via the service binding. This pattern is identical across environments.

### 4.3 Atomic deploys

Both Workers (SSR and API) deploy together as a single pipeline step. If either fails to deploy, the other is rolled back. This prevents an inconsistent state where the SSR Worker is calling a stale API Worker (or vice versa).

Implementation: deploy API Worker first, run health check, deploy SSR Worker, run smoke tests. If smoke tests fail, rollback both.

---

## 5. Database migrations

The application database is **Cloudflare D1**, with migrations generated by **drizzle-kit** and applied by **`wrangler d1 migrations apply`** (ADR 0016). The full workflow is `docs/migrations.md` §0.

### 5.1 Migration source

The schema source of truth is the Drizzle schema `apps/api/src/db/schema.ts`. Migration SQL is generated by `pnpm --filter @aeci/api db:generate` (drizzle-kit) into `apps/api/migrations/`, committed alongside the schema change. Applied with `wrangler d1 migrations apply <db> [--remote]` — locally via `pnpm db:migrate:local`, in CI via `deploy.yml` (staging) / `promote-to-prod.yml` (production). There is no `DATABASE_URL` / `DIRECT_URL` / `supabase db push` — Prisma was removed entirely (AECI-278) and the API Worker reaches D1 through its native `DB` binding.

### 5.2 Forward-only

Migrations are forward-only. No automated rollback. If a migration is bad:

- The migration was reviewed in the PR and shouldn't have merged
- If it lands in staging and breaks something, write a new migration to fix it
- Never edit a committed migration after the fact

### 5.3 Migration ordering

- Migrations apply to staging at merge-to-main
- Migrations apply to production at production approval
- Migrations are typically applied **before** the new Worker code is deployed, to ensure the database is ready for the new code
- Migrations that can't be safely run with old code still deployed require feature flags or a two-phase migration:
  1. Phase 1: Migration adds new column (nullable), code reads old + new
  2. Phase 2: Code writes only to new column; backfill old data
  3. Phase 3: Migration drops old column

### 5.4 No RLS / GRANT policies on D1

D1 (SQLite) has no PostgREST, no GRANTs, and no row-level security. Authorization for app tables is **app-layer only** — the Worker request guard (`docs/AUTH_AND_RLS.md` Layer 1). The former Postgres GRANT/RLS migration and its `scripts/verify-rls.sql` hard-stop gate were **deleted with the Postgres-app-DB decommission (AECI-278)**; there is no Postgres schema/RLS drift gate anymore. The live PR gate is the drizzle-kit schema-drift check (`drift-check.yml`, AECI-264). App-layer visibility (promoted-only, approved-only, own-row) is covered by the no-leakage authz-matrix specs (`apps/api/src/routes/*.authz-matrix.spec.ts`).

### 5.5 Schema-drift gate

`drift-check.yml` (AECI-264) runs on any PR touching `apps/api/src/db/schema.ts`, `apps/api/drizzle.config.ts`, or `apps/api/migrations/**`: it re-runs `db:generate` and fails if that leaves `apps/api/migrations/` dirty (you edited the schema but didn't commit the generated migration).

---

## 6. Rollback strategy

### 6.1 Worker rollback

Wrangler stores deployment history. To roll back:

```bash
wrangler deployments list --env production
wrangler rollback --env production --message "Reverting due to bug X"
```

Takes effect within seconds globally. Use case: a deploy introduced a critical bug, you want the previous version live immediately.

### 6.2 Database rollback

Not supported. Migrations are forward-only.

If a migration broke something, you write a new migration that fixes it (could be a revert if the original was additive). Workers may need to be rolled back to a version compatible with the database state.

### 6.3 Cache invalidation on rollback

After any rollback, purge the affected cache **tags** via `POST /admin/purge` with a tag list (see `CACHE_STRATEGY.md` §5 for the endpoint shape, tag vocabulary, and auth). Purge the tags for any pages the rolled-back code rendered; for a drastic rollback, use the coarse route-class tags (`route:detail` / `route:index` / `route:browse`) to repaint whole page classes at once.

Use `wrangler tail` to monitor cache miss rates climbing back to normal after the purge. (The `invalidateForEntity()` / URL-invalidation-map approach in `STAGE_1_SPEC.md` §9.3 is superseded — see `CACHE_STRATEGY.md`.)

---

## 7. Secrets management

### 7.1 GitHub Actions secrets

Stored in GitHub Settings → Secrets and Variables → Actions. Scoped per environment via GitHub Environments.

**Required secrets per environment:**

| Secret | Purpose | Environments |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Wrangler auth + queue provisioning. Scope: the **Workers Scripts edit** `wrangler deploy` requires **and `Account → Queues → Edit`** (ADR 0013 + ADR 0020 §3 — the deploy provisions + binds the scheduled-job queues **and the WC-5 `aeci-cache-purge-{env}` cross-Worker purge queue**; without it `wrangler queues create` and the consumer-binding deploy fail). The former **`Zone.Cache Purge`** grant is no longer needed — the HTTP purge transport was retired in WC-10 (AECI-324) and native `ctx.cache.purge()` needs no token — so it can be dropped on the next rotation. Keep it as narrow as these need; issue a new token at the same scope and rotate rather than broadening reactively. | All |
| `CLOUDFLARE_ACCOUNT_ID` | Account identifier | All |
| `CF_ZONE_ID` | Zone ID for `aecintegrations.com` (single shared value — one zone). Pushed to the **API Worker only** by `deploy.yml` / `promote-to-demo.yml` / `promote-to-prod.yml`, as the zone the AECI-262 WAF firewall-event analytics poll queries — paired with `CF_ANALYTICS_API_TOKEN` (see `docs/waf-rate-limits.md` §5). It no longer backs cache purge: `/admin/purge` is native `ctx.cache.purge()` since WC-6 and the HTTP purge token was retired in WC-10. Graceful warn-and-skip. (Earlier drafts of this table called it `CLOUDFLARE_ZONE_ID`; the live secret name is `CF_ZONE_ID`.) | All |
| `CF_PURGE_API_TOKEN` | **RETIRED (WC-10 / AECI-324).** Was the `Zone.Cache Purge`-scoped token behind the ADR 0010 HTTP purge. Native Workers Cache made a zone purge inert, so invalidation moved to the `aeci-cache-purge-{env}` Queue (WC-5) and in-process `ctx.cache.purge()` (WC-6). No workflow pushes it; delete it from the GH repo secrets and from each Worker. | — |
| `ADMIN_PURGE_TOKEN` | Long-lived bearer the **caller** of `POST /admin/purge` presents (CI's post-seed taxonomy purge + manual incident purges). Single shared un-suffixed value; pushed to the **web Worker only** by the same three workflows, so the token CI presents and the token the Worker checks are the same secret by construction. Graceful warn-and-skip: absent → the endpoint 401s. | All |
| `CF_ANALYTICS_API_TOKEN` | **Single shared** (un-suffixed, like `SUPABASE_ANON_KEY` — the token is zone-scoped and the zone is shared) Cloudflare token for the hourly WAF firewall-event poll (AECI-262 / §15.1): reads the zone's `firewallEventsAdaptiveGroups` over the GraphQL Analytics API and emits `aeci.waf.ratelimit.blocked`. Scope: **`Zone Analytics: Read` on `aecintegrations.com`** — a *different* scope than the `Zone.Cache Purge` purge token, so it is its own secret. Pushed to the API Worker as `CF_ANALYTICS_API_TOKEN` by `deploy.yml` (staging) / `promote-to-demo.yml` (demo) / `promote-to-prod.yml` (production), all **graceful warn-and-skip**. Reuses the env's `CF_ZONE_ID`. **Optional + fail-safe:** absent → the poll logs `outcome:skipped_no_creds` and no-ops. See `docs/waf-rate-limits.md` §5. | All |
| `SUPABASE_ACCESS_TOKEN` — **orphaned** | Was for the Supabase CLI app-DB migrations; the Postgres `supabase db push` machinery was decommissioned (AECI-278). Only manual auth-baseline reconciliation uses the CLI now. | — |
| `SUPABASE_DB_URL` / `DIRECT_URL` — **retired** | The Postgres app-DB `supabase db push` path is gone (AECI-278). No DB connection URL is needed — the app DB is Cloudflare D1, reached via the Worker's `DB` binding. | — |
| `DATABASE_URL` — **retired** | Prisma Accelerate was removed (AECI-253/278). The app DB is Cloudflare D1 (ADR 0016) via the `DB` binding; there is no DB connection secret. | — |
| `SUPABASE_SERVICE_ROLE_KEY` | GoTrue Admin API key for the **split-identity seams** (register: `AUTH_AND_RLS.md` §3.1 — `auth.users` email reads, GDPR erasure of the `auth.users` row, vendor-claimant lookup + provisioning). **Single shared, un-suffixed key** — one Supabase auth project backs every env (ADR 0017), like `SUPABASE_ANON_KEY` / `RESEND_API_KEY` / `CF_ANALYTICS_API_TOKEN`. Pushed to the **API Worker** as `SUPABASE_SERVICE_ROLE_KEY` by `deploy.yml` (staging), `promote-to-demo.yml` (demo), and `promote-to-prod.yml` (production) — reconciling CI with ADR 0016 §6 (AECI-530). **Optional + fail-open on every env** (prod included — warn-and-skip, never in `REQUIRED_WORKER_SECRETS`): absent → reviewer emails read `null`, the erasure `auth.users` delete is silently skipped, and vendor-claim resolution reports `unavailable`. **API Worker only, and deliberately NOT on per-PR previews** (§7.2). Not involved in sign-in. Unrelated to `integration-db-tests`, which mints its own key from a local `supabase start` stack. See `environments.md` §Secrets. | staging, demo, production (optional) |
| `SUPABASE_ANON_KEY` | Public Supabase key | All |
| `ALGOLIA_ADMIN_KEY` | **Single shared management** key (one value, every env) — search + index-mutation ACLs; one Algolia app spans all envs and the key reaches every index (`--env` is only an index-name prefix). Sync pipeline (3.5/3.6) + CI. Pushed to the API Worker as `ALGOLIA_ADMIN_KEY` by `deploy.yml` / `promote-to-prod.yml` / `promote-to-demo.yml`. The former `_STAGING`/`_PRODUCTION` secrets are retired. | All |
| `ALGOLIA_SEARCH_KEY` | **Single shared search-only** key (`['search']`, one value every env), client-exposed (InstantSearch, 3.9). **Must be scoped to cover every env's indexes + sort replicas** it serves (`staging_*`/`production_*`/`demo_*`/`preview_*`; AECI-175 — `connectSortBy` queries a replica directly) — it's one shared value now, so an env-scoped key breaks the others. Pushed to the web Worker (with `ALGOLIA_APP_ID`) by `deploy.yml` (staging — recommended/warn-and-skip), `promote-to-prod.yml` (production — required/fail-closed), `promote-to-demo.yml` (demo). The former `_STAGING`/`_PRODUCTION`/`_PREVIEW`/`_DEMO` secrets are retired. | All |
| `ALGOLIA_SEARCH_KEY` (Lighthouse preview use) | The same shared `ALGOLIA_SEARCH_KEY` above. Consumed by [`lighthouse.yml`](../.github/workflows/lighthouse.yml) (AECI-188), which writes it into `apps/web/.dev.vars` so the post-merge Lighthouse run measures `/search` with the real InstantSearch SDK against the `preview_*` indexes (populated via `pnpm algolia:bulk-sync -- --env preview`); the workflow hard-fails without it, so the shared key **must** also cover `preview_*`. | CI (lighthouse.yml) |
| `ALGOLIA_APP_ID` | Algolia application id. **Single value shared across all envs** (one app; only indexes/keys differ). Pushed to both Workers. | All |
| ~~`POSTHOG_KEY_STAGING` / `_PRODUCTION`~~ — **retired (AECI-640)** | **No longer read by any workflow.** The publishable `phc_` project token is now a committed per-env `vars.POSTHOG_PROJECT_KEY` in both `wrangler.jsonc` files, and all four CI push steps are deleted. The token ships in the served HTML on every page, so keeping it a secret bought nothing and cost the weeks-dark prod analytics of AECI-326. **Operator action: delete both GH secrets.** | — |
| `POSTHOG_CLI_API_KEY` | Personal `phx_` key. **CI-only — never a Worker secret** (a personal key reaches the whole org). Used by `posthog-sourcemaps.sh` (§9.1a) and the deploy marker's annotation leg (§9.1). Needs the union of `error tracking write` + `organization read` and insight/dashboard/alert write + project read (for the AECI-647 `apply.sh`). Optional + warn-and-skip everywhere. Not in `RECOMMENDED_SECRETS` — the scripts self-warn, which is the right gate for a step that must never block a deploy. | CI (all deploy paths) |
| ~~`DATADOG_API_KEY`~~ | **Retired at AECI-651** — no longer read by any workflow. Delete from GH secrets (manual, WC-10 precedent). | — |
| ~~`DATADOG_APP_KEY`~~ | **Retired at AECI-651.** Same. | — |
| `RESEND_API_KEY` | Resend key for transactional email (AECI-240, §11.1). **Single shared, un-suffixed key** — one Resend account/key spans every env (like `SUPABASE_ANON_KEY`); pushed to the API Worker as `RESEND_API_KEY` by `deploy.yml` (staging), `promote-to-demo.yml` (demo), and `promote-to-prod.yml` (production). **Optional + fail-open on every env** (warn-and-skip): a missing key makes every send a silent `'skipped'` and the triggering action still succeeds. Pairs with the `EMAIL_FROM` var (sender). See `docs/email.md`. | staging, demo, production |
| `LINEAR_API_TOKEN` | Issue creation | All |
| `LINEAR_WEBHOOK_SECRET` | Webhook signature verification | All |
| `ANTHROPIC_API_KEY_STAGING` / `_PRODUCTION` | Anthropic key for review toxicity scoring (Claude Haiku, AECI-258); pushed to the API Worker as `ANTHROPIC_API_KEY`. **Optional + fail-open on every env** (prod included — warn-and-skip, NOT fail-closed): a missing key stores `toxicity_score=null` and the review still enters the moderation queue. Previews reuse the `_STAGING` value. Supersedes the sunsetting `PERSPECTIVE_API_KEY`. **GDPR:** confirm zero-data-retention (ZDR) is enabled on the Anthropic org before provisioning a real key — the Messages API has no per-request no-store control, so otherwise scored review bodies are retained ~30 days outside the §8 erasure boundary. | staging, production |
| `BRANDFETCH_CLIENT_ID` | Logo CDN | All |
| `AIRTABLE_TOKEN` | **Single shared, read-only** Airtable PAT scoped to `data.records:read` on the AEC Integrations curation base (`appy81IdGJY6Fngf9`). Consumed only by [`promote-strand-audit.yml`](../.github/workflows/promote-strand-audit.yml) (§11a) to cross-reference production D1 against the base. **Never pushed to a Worker** — no runtime code in this repo talks to Airtable; the curation base belongs to the review app. **Optional + skip-green:** absent → the audit job warns and exits 0, so the guard is simply inert rather than red. Read-only by design: the audit has no write path. | CI (promote-strand-audit.yml) |

### 7.2 Worker secrets

For runtime use, secrets are pushed to Worker secrets via Wrangler:

```bash
wrangler secret put DD_API_KEY --env production
```

GitHub Actions does this via the `cloudflare/wrangler-action` step, pulling from GitHub Actions secrets.

> **The Supabase service-role key goes to the API Worker only.** It is a real runtime secret there — `apps/api/src/lib/supabase-admin.ts` (the single module allowed to read it) uses it for the GoTrue Admin API split-identity seams registered in `AUTH_AND_RLS.md` §3.1, per ADR 0016 §6. It must **never** reach the **web Worker**: that Worker's auth path uses `SUPABASE_URL` + the publishable anon key, it renders its config into client HTML, and `apps/web/src/supabase-bootstrap-inject.spec.ts` is the standing regression guard that the bootstrap never serializes a service-role value. The API Worker still verifies **user JWTs** with public JWKS material only — the service-role key is for Admin-API calls, never for token verification.
>
> It is also **deliberately not pushed to per-PR preview Workers** (`pr-preview.yml` carries the rationale inline): previews are numerous, short-lived and least-reviewed, the key is the *project-wide* auth key, and under ADR 0017 a single Supabase project backs every environment including production — with seams that **delete** (`DELETE /auth/v1/admin/users/:id`) and **create** (`POST /auth/v1/admin/users`) identities. GoTrue has no scoped admin credential, so the exposure cannot be narrowed per tier. Previews keep the degraded behaviour by design. See `environments.md` §Secrets.

### 7.3 Local development

Local secrets live in `.dev.vars` at the root of each Worker package. **Never committed.** A `.dev.vars.example` template is committed showing required keys with placeholder values.

`pnpm dev` or `wrangler dev` reads `.dev.vars` automatically.

The API Worker reaches the app DB through its native D1 `DB` binding — there is **no** `DATABASE_URL` / `DIRECT_URL` (Prisma was removed, AECI-278). The local D1 is a per-workspace SQLite that `pnpm dev` auto-migrates + seeds via `db:setup:local`; `.dev.vars` only needs the **Auth** values (`SUPABASE_URL` + the anon key) and the other runtime secrets (`DD_*`, Algolia, etc.). See `docs/environments.md` → "Local dev: running the API Worker (D1)".

> **Leave `POSTHOG_PROJECT_KEY` empty locally.** It is an *optional* override in
> `apps/web/.dev.vars.example`, not a secret to go fetch: an absent project key is a total
> no-op on every PostHog pipe by design, so local runs neither send telemetry nor pollute a
> real project. Set it only when you are specifically verifying the transport, and point it
> at the non-prod project (`aec-integrations-dev`, 525793) when you do.

### 7.4 Rotation

Documented procedure, executed annually or on suspected compromise:

1. Generate new credential at the source (Supabase, Algolia, etc.)
2. Update GitHub Actions secret
3. Trigger a deploy to push the new secret to Worker secrets
4. Verify the new secret is active
5. Revoke the old credential at the source

For the API keys with dev/prod separation (Algolia, Datadog), rotate independently per environment.

**Supabase service-role key (shared — all environments at once).** Under ADR 0017 a *single* Supabase auth project backs every environment, so `SUPABASE_SERVICE_ROLE_KEY` is one physical credential behind one un-suffixed GH secret. There is no per-env rotation: **generating a new service-role key in the Supabase dashboard invalidates the old one for staging, demo, *and* production simultaneously**, and every Worker still holding the old value starts failing its Admin-API calls immediately. Sequence it deliberately:

1. Rotate the key in the Supabase dashboard (Project Settings → API) and `gh secret set SUPABASE_SERVICE_ROLE_KEY` with the new value.
2. Re-run **all three** deploy paths so every Worker picks it up: `deploy.yml` (staging — push to `main`, or re-run the last `deploy-staging`), then `promote-to-demo.yml`, then `promote-to-prod.yml`.
3. Between step 1 and the last re-run there is a **degraded window**, not an outage — every seam fails open (reviewer emails read `null`, the erasure `auth.users` delete is skipped, vendor-claim approval 503s). Accept the window or drain it quickly; nothing fails closed and no deploy is blocked.

PR previews are unaffected — they never carry the key (§7.2). Note the GDPR consequence of the window: account erasures processed during it leave orphaned `auth.users` rows that need the manual cleanup in `AUTH_AND_RLS.md` §8 step 4.

**Algolia (per-env, independent).** The app-wide root admin key stays operator-held and is used _only_ to run the provision script — it is never a GitHub or Worker secret, so it does not rotate through this pipeline. The per-env scoped keys rotate one env at a time:

1. `node scripts/algolia/provision.mjs --env <env> --rotate` — mints fresh search + management keys for that env and deletes the old ones (the index scope follows `searchKeyParams`/`managementKeyParams`).
2. Re-set the affected secrets with the printed values: `gh secret set ALGOLIA_SEARCH_KEY` / `ALGOLIA_ADMIN_KEY` (single shared secrets, all envs), and `wrangler secret put ALGOLIA_SEARCH_KEY --env <env>` (web) / `ALGOLIA_ADMIN_KEY --env <env>` (API). ⚠️ Rotating per-env now overwrites the one shared secret — mint a key that covers every env's indexes (or rotate all envs together).

**One-time scope widening (AECI-175).** The sort replicas (§7.5) widened both keys' index scope to include the replica names. Before the first deploy that runs the AECI-175 apply step in an env, **re-provision that env's keys** (`pnpm algolia:provision --env <env>` — or `--rotate`) and re-push the secrets per the two steps above, or the CI `setSettings` on a replica will 403 and the browser key will 401 on a replica query. This is a one-off per env; routine rotation (above) already carries the wider scope.
3. Redeploy that env so the Workers pick up the new secrets.

`ALGOLIA_APP_ID` is not a credential and does not rotate. Rotating the root admin key itself is a dashboard operation (Algolia → API Keys) followed by re-exporting it locally before the next provision run.

### 7.5 Algolia topology (AECI-134)

**One application, per-env indexes.** A single AECi Algolia app (one `ALGOLIA_APP_ID`, shared) holds four index sets, one per environment. Physical names are `<prefix>_<entity>`:

| Prefix | Indexes | Used by |
|---|---|---|
| `preview` | `preview_products`, `preview_vendors`, `preview_integrations` | PR previews + local `pnpm dev:bound` (`ENV=preview`) + `development` (bare `wrangler dev`/tests fold here) |
| `staging` | `staging_products`, `staging_vendors`, `staging_integrations` | staging |
| `demo` | `demo_products`, `demo_vendors`, `demo_integrations` | demo (`ENV=demo`) |
| `production` | `production_products`, `production_vendors`, `production_integrations` | production |

The prefix is derived from the Worker `ENV` label (matching the Datadog tags + `/api/version` convention); `development` folds onto `preview` so there is no fifth set. `demo` and `production` keep separate sets so the showcase never reads or writes the live `production_*` indexes. The names and the key shapes are defined once in `packages/shared/src/algolia.ts` and consumed by the Workers and the provision script alike.

**Three keys per app, two of them per-env-scoped:**

- **Root admin key** — app-wide, all ACLs. **Operator-held**; used _only_ to run `scripts/algolia/provision.mjs`. Never a GitHub or Worker secret.
- **Search-only key** (per env) — ACL `['search']`, scoped to that env's three indexes **and their sort replicas** (AECI-175: `<prefix>_products_name_asc`, etc. — `connectSortBy` queries replicas directly). → web Worker `ALGOLIA_SEARCH_KEY`. Client-exposed (rendered into the SSR HTML as `window.__AECI_ALGOLIA__` for InstantSearch, 3.9).
- **Management key** (per env) — ACL `search + addObject + deleteObject + editSettings + listIndexes`, scoped to that env's three indexes **and their sort replicas** (so the apply step can configure each replica's `ranking`); excludes the destructive/global ACLs (`deleteIndex`, `usage`, `logs`, …). → API Worker `ALGOLIA_ADMIN_KEY`. Server-only; used by sync from 3.5.

The replica index names (`<prefix>_<entity>_<sort>`) are defined alongside the base names in `packages/shared/src/algolia.ts` (`replicaNamesFor`); the standard replicas auto-mirror their primary's records, so sync still pushes only to the base indexes (see `SEARCH_RANKING.md` §5a).

Both per-env keys are standalone (`addApiKey`, not derived/secured keys), so each rotates independently per env (§7.4). The search and management keys are minted by the provision script; the operator pushes them to the Workers via `wrangler secret put`. **The management/admin key must never reach the browser** — it is deliberately absent from the web Worker's `WebEnv`, and a unit test (`apps/web/src/algolia-bootstrap-inject.spec.ts`) enforces that the bootstrap injection never serializes it.

Scope is provisioning + keys only. Index _settings_ (searchable attributes, facets, ranking) land in 3.2; sync in 3.5/3.6; the `/search` UI in 3.9.

---

## 8. Quality gates

Every PR must pass these gates before merge:

- ✓ Lint and type check
- ✓ Unit tests pass
- ✓ Build succeeds
- ✓ Bundle size under budget
- ✓ Preview deploys successfully
- ✓ E2E tests pass against preview
- ✓ No new accessibility violations (axe-core) — blocking
- ✓ Lighthouse scores meet budget (Performance / Accessibility / Best-Practices / SEO ≥ 90 mobile) — **partially enforced** (AECI-188): Accessibility / Best-Practices / SEO / TBT / the `/search` TTFB are error-level on the post-merge run; Performance / LCP / CLS / the JS budgets remain advisory pending the perf follow-up (see the note below)
- ✓ At least one human reviewer approval

Two checks run **advisory / non-blocking** rather than as merge gates: coverage is generated and reported but never fails a build (target: 70% line coverage — see §3.1 and `TESTING_STRATEGY.md` §3.3), and the `integration-db-tests` lane reports red/green without gating the staging deploy until it's promoted to a required check (`TESTING_STRATEGY.md` §6.5).

**axe + Lighthouse wiring (AECI-65 / Phase 2.19).** Both harnesses (scaffolded in AECI-33) run against **every Phase 2 page type** on a local `dev:bound` server, using committed seed fixtures (`apps/api/seed/phase2-fixtures.sql`, seeded into the local D1 by `dev:bound`'s `db:setup:local` → `db:seed:fixtures:local`):

- **axe** runs in the `e2e-and-integration` job of `deploy.yml` (`apps/web/e2e/phase2-a11y.spec.ts`) across all 13 page types in **light and dark** themes — **zero AA violations, blocking** (the site footer's pre-existing dark-mode contrast debt is carved out and tracked separately). Runs on **every PR**.
- **Lighthouse** (mobile, simulated throttle, median of 3 runs) runs in its own [`lighthouse.yml`](../.github/workflows/lighthouse.yml) workflow on **push-to-main only** — _not_ on PRs. Running it on every PR was pure noise when it gated nothing; it now **error-gates the post-merge run** (AECI-188), just before/alongside the staging deploy. It builds + boots its own `dev:bound` and uses a per-commit concurrency group so each merged SHA gets an uncancelled report (deploy.yml's run-level cancel-in-progress would otherwise kill it on a rapid follow-up merge). Budgets (§12 of `STAGE_1_PHASE_2_SPEC.md`: scores ≥ 90, LCP ≤ 2.5s, CLS ≤ 0.1, detail-page JS ≤ 200 KB) are **partially enforced**: Accessibility / Best-Practices / SEO / TBT (and the `/search` TTFB) assert at `'error'` — a miss exits 1 and turns the workflow red — while Performance / LCP / CLS / the JS budgets stay `'warn'` until the measured misses are fixed (perf follow-up issue referenced in `.lighthouserc.cjs`; budgets must not be lowered to pass, per the AECI-65 note). A red here means `main` already regressed — fix forward or revert.

**Search wiring (AECI-145 / Phase 3.12).** The same jobs extend to the search/listing surfaces without any workflow change (both already run every `e2e/*.spec.ts` and `lhci autorun`): `/search` is in the Lighthouse collection as a `noindex`, SEO-exempt page (AECI-146), and AECI-145 adds its **MISS-only TTFB budget** (`server-response-time`, since it's `private, no-store`, now error-level); the AECI-143 facet sidebar gets interaction E2E (`apps/web/e2e/facets.spec.ts`) plus a cache-key unit test (originally `cacheKeyUrl()`, removed in WC-3 / AECI-317 with the manual `caches.default` pipeline; **restored in WC-4 / AECI-318 as `cacheKeyFor()` in `cache-key-url.spec.ts`**, now behind the gateway entrypoint) that proves distinct facets → distinct cache entries. The **Lighthouse run measures `/search` with the real InstantSearch SDK** — `lighthouse.yml` provisions the shared `ALGOLIA_SEARCH_KEY` into `apps/web/.dev.vars` (AECI-188; the key must cover the `preview_*` indexes) so the `/search` JS-transfer budget and a11y numbers reflect the production page, not the degraded shell. The Playwright live-results flow still self-skips in `deploy.yml` (no Algolia there); see `TESTING_STRATEGY.md` §7.2/§8/§10.5.

The "human reviewer" requirement is enforced by GitHub branch protection on `main`.

> **Branch protection, per branch (verified 2026-08-14).**
>
> | Branch | Protected | Required contexts |
> |---|---|---|
> | `main` | Yes | `Lint & typecheck`, `Unit tests`, `Build SSR Worker` |
> | `stage-2` | **Yes — added 2026-08-14**, an exact mirror of `main` | same three |
> | `admin-panel` | **No** (404 "Branch not protected") | — |
>
> Both protected branches also set `strict: true` (PR must be up to date with the base before
> merging), `required_linear_history`, `required_conversation_resolution`, and no
> force-push/deletion. Neither sets `required_pull_request_reviews`, so the "human reviewer"
> line above is aspirational, not enforced. Both leave **`enforce_admins: false`** — an admin can
> still merge past red or missing checks.
>
> **Known quirk — a `paths-ignore`-skipped run reports nothing, and "nothing" is not "green."**
> A docs-only PR skips `deploy.yml` entirely (§3.1), so the three required contexts never arrive
> and GitHub blocks the merge pending checks that will never run. This already happens on `main`
> — PR #518 (docs-only, 2026-08-13) merged with an empty check list purely on the
> `enforce_admins: false` admin bypass — and now applies to `stage-2` identically. Live with the
> bypass, or fix it properly by moving the path filtering from the workflow-level `paths-ignore`
> into job-level conditions so the jobs always report (a no-op green on docs-only PRs). Not done
> here; it is a separate change.

---

## 9. Monitoring deployments

### 9.1 Deployment markers

**Two vendors post markers today** (ADR 0024 dual-run). PostHog is where this is going;
Datadog is what production dashboards still carry. The Datadog half is deleted by
**AECI-651**, not before.

#### PostHog markers (AECI-640) — all four deploy paths

`scripts/ci/posthog-deploy-marker.sh` runs on **staging, PR preview, demo and production**,
plus the production rollback path. It posts **two legs**, because they answer different
questions and neither substitutes for the other:

| Leg | What it is | Needs | State today |
|---|---|---|---|
| Project **annotation** | the vertical line PostHog draws across every insight and dashboard | personal `phx_` key (`POSTHOG_CLI_API_KEY`) + numeric project id | warn-skips until the operator provisions the key |
| `deployment` **event** | the queryable record a HogQL query joins against — "which deploy introduced this error", "how many deploys this week" | only the publishable `phc_` project token, which is a committed var | **works today**, including on PR previews and forks |

Properties on the event: `env`, `service` (`aeci-web` / `aeci-api` / `both`), `version`
(the commit SHA), `deploy_kind` (`deploy` / `promote` / `preview` / `auto_rollback`),
`app`, `workflow`, `run_url`. It is not a user event — `$process_person_profile: false`,
`distinct_id: aeci-ci`.

**Both legs are best-effort and the script always exits 0**, with `continue-on-error: true`
as a second layer: a PostHog outage, a rotated key or a missing repo variable must never
block a deploy. Every skip prints a GitHub `::warning::` rather than passing silently —
that is the AECI-326 failure mode in reverse, where a silent skip hid a real gap for weeks.

Host split to keep straight: annotations go to the **management** host
`https://us.posthog.com`; the event goes to the **ingest** host `https://us.i.posthog.com`.
Swapping them yields a confusing 404, which is why the script carries two host variables.

#### Datadog markers (AECI-78) — promote paths only, until AECI-651

Markers appear on Datadog dashboards as vertical lines, making it easy to correlate any new errors or performance regressions with a specific deploy.

> **Only the promote workflows post one.** Verified 2026-08-14: `promote-to-prod.yml` and
> `promote-to-demo.yml` each have a `Datadog deployment marker` step; **`deploy.yml`'s
> `deploy-staging` does not** — it pushes `DATADOG_API_KEY` to the Worker but never posts an
> event. So staging deploys are unmarked *on the Datadog side*. This asymmetry is no longer
> worth closing: the PostHog marker above already covers staging, and this step is scheduled
> for deletion at AECI-651.

```yaml
- name: Mark deployment in Datadog
  run: |
    curl -X POST "https://api.datadoghq.com/api/v1/events" \
      -H "DD-API-KEY: ${{ secrets.DATADOG_API_KEY }}" \
      -H "Content-Type: application/json" \
      -d '{
        "title": "Production deployment",
        "text": "Deployed commit ${{ github.sha }}",
        "tags": ["env:production", "service:aeci-ssr", "commit:${{ github.sha }}"]
      }'
```

### 9.1a Source-map upload (AECI-646)

`scripts/ci/posthog-sourcemaps.sh` runs on all four deploy paths, **after the build and
before the deploy**. Angular's `production` configuration emits **hidden** source maps
(`{ scripts: true, styles: false, hidden: true, vendor: false }`): the `.map` files exist
but no `//# sourceMappingURL=` comment is written into the served JS, so a devtools session
cannot pull our source while PostHog can still symbolicate a minified frame.

Three things about this script are load-bearing:

1. **Order.** `posthog-cli sourcemap inject` rewrites the built JS to add the `//# chunkId=…`
   comment PostHog matches on. Deploying the pre-inject bundle would upload maps that can
   never be matched to anything.
2. **Every exit path deletes the maps** — the warn-skip when `POSTHOG_CLI_API_KEY` is absent,
   an inject failure, an upload failure, and the success path (belt and braces over
   `--delete-after`). `dist/browser` is uploaded verbatim as Worker assets, so a `.map`
   surviving to a deploy would publish the whole app source at a guessable URL.
3. **`--release-name` is passed explicitly.** Left to itself the CLI tries to derive one
   from git and warns "Could not create release", producing uploads not tied to a release —
   which is exactly what makes "which deploy introduced this error" unanswerable.

`POSTHOG_CLI_API_KEY` is a **personal** key (`error tracking write` + `organization read`)
and is **CI-only — it must never become a Worker secret**. Absent, every step warn-skips
and the deploy proceeds.

> There is **no `staging` build configuration.** This repo promotes ONE build by SHA across
> staging → demo → prod (`docs/environments.md`), so `production` *is* the configuration every
> deployed tier is built with. One consequence, deliberate and bounded: the `web-dist` CI
> artifact now carries `.map` files, because `deploy-staging` builds in a separate job and
> downloads that artifact — the artifact is repo-private with 7-day retention, unlike Worker
> assets.

### 9.1b Liveness sweep — **arriving in AECI-647**

PostHog has **no `notify_no_data` equivalent at any tier**, so the eight Datadog no-data
monitors (Algolia sync / home stats / data quality / reconcile sweep / WAF poll / retention
prune not running, plus the liveness halves of the index-drift and moderation-backlog
monitors) do not port as alerts. They are replaced by **one external scheduled GitHub
Actions workflow** that queries the prod PostHog project for per-cron heartbeats and fails
red + emails on a missing series.

Two properties, both worth stating:

- Running **outside the Worker** is precisely what let Datadog's `notify_no_data` detect a
  dead Worker, and the sweep keeps that property — a self-reporting health check cannot
  report that it never started.
- It **depends on GitHub Actions availability**, which `notify_no_data` did not. That is a
  new single point of failure and an accepted one; it is called out in ADR 0024's
  re-open triggers.

AECI-647 has landed, and AECI-651 removed the eight Datadog no-data monitors it replaced.
The sweep is now the only absence detection.

### 9.2 Smoke tests

After every staging and production deploy, the workflow polls the deployed site until **both** Workers report the SHA being shipped, via `scripts/verify-version.sh`:

- `GET /api/version` — proxied raw to the API Worker; reports the **API** Worker's `COMMIT_SHA`.
- `GET /_version` — served by the SSR Worker itself; reports the **SSR** Worker's `COMMIT_SHA`.

Checking both (AECI-92) proves the whole site — not just the API behind the proxy — is at the deployed commit. The workflow owns the timing budget: it retries up to 10 times at 6s intervals (~60s) and marks the deploy failed if either Worker has not reported the expected SHA by then.

If the smoke check fails, the deployment is marked failed and:

- **Staging:** the red CI run is the signal. No Slack notification and no auto-rollback — a developer investigates and re-runs.
- **Production:** the `deploy-prod-workers` job auto-rolls-back **both** Workers to the previous deployment (`wrangler rollback --env production` for `apps/web` then `apps/api`, the reverse of deploy order, so API stays ahead of SSR on the way down), emits an alert-grade **Datadog event** (`alert_type: error`, `event:auto_rollback`) **and a PostHog marker with `deploy_kind: auto_rollback`** (AECI-640, so a HogQL query can separate releases from rollbacks), and writes an operator runbook to the run summary. The runbook carries the manual `wrangler rollback` commands and the **Cloudflare D1 time-travel** restore block (`wrangler d1 time-travel info|restore aeci-app-production`) — the app DB is D1 with 30-day time-travel (AECI-256), so a bad migration is reverted to a point just before the promote without any pre-promote dump. The **database is not auto-restored** — migrations are forward-only (§6.2), so restoring is an operator decision made with the surfaced commands in hand. (Auth lives in the single shared Supabase project, ADR 0017, and is not touched by the promote.)

> Slack alerting was intentionally dropped from Phase 1; **Datadog events are the prod alert channel today**, and remain so for the whole ADR 0024 dual-run — PostHog alerts (hourly cadence) take over at AECI-647, and the Datadog side is deleted at AECI-651. A Playwright smoke suite (home / product / vendor / search / auth-login page renders) is **deferred to a later phase** — until then the dual-Worker version verification above is the smoke gate.

---

## 10. Branch strategy

> **Post-launch model (2026-07-05, ADR 0019).** Production is **live**, and Stage 2 must be
> built without blocking prod hotfixes. `main` is now the **production/stable line**; Stage 2
> development happens on a **long-lived `stage-2` integration branch**. This is a deliberate,
> time-boxed exception to the original single-trunk rule below — see ADR 0019 for the full
> rationale (the short version: the promote chain is a single linear trunk gated by SHA, and
> `promote-to-prod` applies **forward-only** D1 migrations, so any Stage 2 commit or migration
> on `main` would ship to prod on the next promote — feature flags hide UI, not migrations).

- **`main` = production line.** Only production-destined work lands here: **hotfixes**, and
  Stage 2 work that is genuinely additive *and* safe to ship to prod now. `main` HEAD must stay
  **always-promotable** — staging auto-tracks `main` (§2.2 / `deploy.yml`), so `main` HEAD is
  always a valid prod candidate. Production-destined feature branches branch off `main` and
  squash-merge back.
- **`stage-2` = long-lived integration branch.** All Stage 2 feature branches (and Conductor
  workspaces doing Stage 2 work) target `stage-2` and squash-merge into it. Merge
  **`main → stage-2` regularly** (after every hotfix, at least weekly) to absorb fixes and keep
  drift small. When Stage 2 is ready, merge **`stage-2 → main`** via PR, promote through the
  tiers, then reset/retire the branch.
- **`admin-panel` = a second, narrower epic integration branch** (2026-08-12, AECI-572 /
  `ADMIN_PANEL_SPEC.md` §13 D1). The admin panel is **Phase 8.3 post-launch work on the `main`
  line**, not Stage 2 — but its 14 sub-issues carry schema migrations (`metrics_daily`,
  `job_runs`, `products.promoted_at`, three dropped `page_views` columns), and ADR 0019's
  forward-only-migration reasoning applies to *any* migration on `main`, not only Stage 2 ones.
  So the epic integrates on `admin-panel` and reaches `main` as **one squash merge** at the end.
  Same discipline as `stage-2`: merge **`main → admin-panel` regularly** and reconcile the
  Drizzle journal before the merge-up. The trade-off to know: **staging never exercises the
  panel until that final merge** (staging auto-tracks `main`), so **per-PR preview Workers are
  the verification surface** for the epic — the same posture `environments.md` describes for
  Stage 2. Retire the branch on merge-up; this is time-boxed to the epic, not a standing third
  line.
- **Hotfix flow (unchanged)** — this *is* the "apply a fix to live prod" path:
  branch from `main` → PR to `main` → squash-merge → staging auto-deploys → `promote-to-demo`
  (SHA) → `promote-to-prod` (SHA). The promote buttons already take an **arbitrary** `commit_sha`
  (gated only on the SHA being live one tier up), so no workflow change is needed.
- **Migration-journal reconciliation.** Stage 2 migrations accumulate on `stage-2` while hotfix
  migrations may land on `main`. Before merging `stage-2 → main`, re-run
  `pnpm --filter @aeci/api db:generate` and reconcile against any `main` migrations so the
  Drizzle journal (`apps/api/migrations/meta/_journal.json`) stays linear.
- **CI on the integration branches.** Every PR gets the full gate no matter which branch it
  targets — `deploy.yml`, `integration-db-tests.yml`, `drift-check.yml` and `pr-preview.yml` are
  all base-branch-agnostic (§3.1). `main`, `stage-2` and `admin-panel` additionally get a
  post-merge `push` run (§3.2); only `main` deploys. `main` and `stage-2` are branch-protected on
  the same three required contexts (§8); `admin-panel` is not. **Opening a new long-lived
  integration branch is a two-line change:** add it to `deploy.yml`'s `push.branches`, and remove
  it when the branch merges up. Nothing needs touching for a short-lived feature or epic branch.
  *(Historical note: until 2026-08-14 `deploy.yml` and `integration-db-tests.yml` pinned
  `pull_request: branches: [main]`. Because that filter matches the **base** branch, it exempted
  every PR into `stage-2` / `admin-panel` / an epic branch from lint, typecheck, unit tests,
  build and E2E — the gap that let PR #521, the ~13k-line AECI-513 epic, merge into `stage-2` on
  preview-deploy signal alone.)*
- **A workflow fix only helps the branches that actually contain it.** For `pull_request` events
  GitHub evaluates the workflow from the PR's **merge ref** (head merged into base), so the fix
  above protects `stage-2` as soon as it lands there. But `push`-triggered runs use the *pushed
  branch's own* copy — and `admin-panel` is **not** descended from current `main`. The 2026-08-14
  fix landed on `stage-2` only, so **`admin-panel` PRs still run no tests**, and the
  `admin-panel` entry in `deploy.yml`'s `push.branches` stays inert, until the fix is merged into
  that branch. Do that when `admin-panel` next absorbs `main`/`stage-2`.
- **The same "only the branches that contain it" rule applies to the PostHog docs sweep.**
  The AECI-639 observability migration lands on `stage-2`, so `admin-panel` still carries the
  pre-migration Datadog wording (including `ADMIN_PANEL_SPEC.md` §7.2's "Datadog owns absence").
  **Re-apply the AECI-648 sweep to `admin-panel` when it merges** — a conflict-free merge will
  not catch prose that is merely stale.
- Release tags (`v1.0.0`, `v1.1.0`) cut from `main` after a production deploy is validated —
  they double as break-glass branch points.

**Original single-trunk model (pre-launch — Stage 1 build).** Retained for context and as the
target state once Stage 2 lands: single long-lived branch `main`; feature branches off `main`
squash-merged; **no `develop`/long-lived branches** (`main` always deployable to staging); cut
release tags from `main` after each validated prod deploy. This keeps the model simple — if
parallel feature work creates conflicts, work it out in PRs. ADR 0019 reinstates this once
`stage-2` merges up and no further parallel-stage work is outstanding.

---

## 11. Build performance

### 11.1 Caching

Aggressive caching to minimize CI time:
- `pnpm` lockfile cache (per `pnpm-lock.yaml` hash)
- Angular build cache (per source hash)
- Playwright browser cache (rare invalidation)
- Vitest cache where Vitest supports it

### 11.2 Parallel jobs

Independent jobs run in parallel. The dependency graph is:

```
lint-and-types ─┐
unit-tests ──────├── (gate)
build ──────────┘
   │
   └── deploy-preview
            │
            ├── e2e-tests
            ├── accessibility
            └── lighthouse
```

### 11.3 Selective testing

For very small PRs (e.g. doc-only changes), skip downstream jobs via `paths-ignore` in workflow triggers.

> **Caveat now that `main` and `stage-2` have required checks:** a workflow skipped by
> `paths-ignore` reports *nothing*, and GitHub treats a missing required context as pending, not
> passing — so a docs-only PR blocks on checks that will never run and needs the
> `enforce_admins: false` bypass to merge. See the §8 quirk note. The clean fix is job-level path
> conditions (jobs always run and report a no-op green) rather than a workflow-level
> `paths-ignore`.

---

## 11a. Scheduled data-integrity guards

Two workflows run on a cron rather than on a PR, because the drift they catch is
created by **operator actions against live data**, not by merging code. Both are
strictly read-only against production and never repair anything — repair is a
deliberate, reviewed human action.

| Workflow | Cron (UTC) | What it checks | On red |
|---|---|---|---|
| [`reconcile-counts.yml`](../.github/workflows/reconcile-counts.yml) | `0 8 * * *` | Denormalized product aggregates (`integration_count`, `review_count`, `rating_*_avg`) against their source rows, on staging + production | A write path mutated rows without `recomputeProductCounts()` landing. Repair with `db:reconcile-counts -- --fix`. |
| [`promote-strand-audit.yml`](../.github/workflows/promote-strand-audit.yml) | `0 9 * * *` | Production D1 against the Airtable curation base — rows on either side with no valid counterpart link (AECI-568/593). Production only: one curation base serves all tiers and holds production uuids. | Usually a curator deleted or edited an Airtable record whose D1 row is still live; promote has no delete semantics, so that strands the row forever. Recipes in `scripts/ops/2026-08-promote-strand-audit/README.md` §Healing. **Skips green until `AIRTABLE_TOKEN` is set.** |

---

## 12. Observability for CI itself

- GitHub Actions usage tracked monthly to stay under free-tier minutes
- ~~Failed builds notify Slack~~ — **no Slack in this project** (§3.3). A failed build's signal is the red run + GitHub's own email/UI notification; there is no chat integration
- Long-running jobs (>15 min) flagged for investigation
- Edge cache HIT-rate observed via `Cf-Cache-Status` on the Cloudflare Workers observability dashboard — the Datadog `cache hit rate < 70%` monitor was retired in WC-8 (a HIT skips the SSR Worker, so it's unmeasurable from render metrics). See `docs/CACHE_STRATEGY.md` §9.

---

## 13. Future considerations

### 13.1 When team grows

- Add CODEOWNERS file to require specific reviewers for specific paths
- Add merge queue to serialize merges and re-run CI against the rebased state
- Add manual QA approval gate before production for risky changes

### 13.2 When traffic scales

- Add canary deployment pattern: deploy to 5% of traffic first, monitor, promote if healthy
- Add blue/green pattern with Cloudflare load balancers
- Add automated performance regression detection (an alert on the render-latency / web-vitals insight — build it on PostHog, not Datadog, since the Datadog plane is scheduled for deletion at AECI-651)

### 13.3 Stage 4 paid tier work

- Stripe integration adds new secrets and a payment webhook endpoint
- Test mode vs live mode pricing requires environment-specific Stripe keys
- Payment failure handling adds new alert categories

Not pursued in Stage 1.

### 13.4 Cloudflare CI on Workflows — watch item (AECI-555)

A standing **watch item**, not planned work. §1 carries the rejection rationale; this section carries
the evidence, the restart-from-step analysis that closed the actionable half of the question, and the
dated re-check log. **Revisit trigger: Artifacts is GA _and_ monorepo support has shipped.**

#### Status of the revisit gates

| Gate | State (2026-08-14) | Source |
|---|---|---|
| Artifacts GA | **Closed beta** — "Artifacts is currently in closed beta. To request access, fill out this form." | `developers.cloudflare.com/artifacts/` |
| Monorepo support | **Not shipped** — "What's coming next" item #3 | `blog.cloudflare.com/ci-workflows/` |
| Non-Artifacts (GitHub) triggers | **Not shipped** — "What's coming next" item #4 | same |
| Pricing | **Unannounced** | — |
| `@cloudflare/ci` maturity | Early-stage repo, no GA label. Importing Worker must enable `nodejs_compat`; runner commands must be **idempotent** because Workflow steps are retryable | `github.com/cloudflare/ci` |

#### Restart-from-step: what GitHub Actions can and can't do

GitHub Actions has **no step-level resume**. Re-runs are job-scoped — `Re-run failed jobs` (the
failed job plus its dependents) or `Re-run specific job` — they preserve the original
`workflow_dispatch` inputs, and they are available for 30 days after the initial run. Mapping that
onto the workflow the issue named, `promote-to-prod.yml`:

| Failure point | Mutated before it fails? | Recovery today | Would restart-from-step help? |
|---|---|---|---|
| `pre-promotion-checks` — `confirm`, `require-secrets.sh`, the demo SHA gate | **Nothing** | `Re-run failed jobs` re-runs only this ~2-min job; `deploy-prod-workers` then re-enters the `production` approval gate | **No — already job-scoped.** This *is* the "version gate" the issue complained about |
| Provision queues → `d1 migrations apply` → purge taxonomy tags | Queues + D1 | Full job re-run; all three are idempotent (`scripts/d1-apply-migrations.sh` even retries a transient D1 `[code: 7500]`) | Marginal |
| `Deploy API` → the Worker secret pushes → `Deploy SSR` → `verify-worker-secrets.sh` | Workers live | Full job re-run; `wrangler deploy` and `wrangler secret put` are idempotent | Marginal |
| **Smoke gate** (`verify-version.sh` + `verify-health.sh`) | Workers went live, then were **auto-rolled-back** (AECI-91) | Full job re-run | **No — resuming would be wrong.** The rollback reverted the deploy, so a fresh deploy is the only correct recovery |
| **`Update Algolia production index settings`** — runs *after* the smoke gate, deliberately outside the rollback guard (`steps.smoke.outcome == 'failure'`) | Workers live **and healthy** at the new SHA | Full job re-run — queues, migrations, both deploys and every secret push, to retry one `setSettings` — **or** `pnpm algolia:apply-settings --env production` by hand | **Yes — the only genuine case in the file** |

`promote-to-demo.yml` has the same smoke → Algolia-settings → auto-rollback tail and the same
profile.

**Verdict.** Two properties make job-scoped re-runs sufficient here: the safety-critical gate is
*already* its own job, and every mutating step is idempotent by design. Cloudflare's
restart-from-step is nicer, but it does not justify migrating a live production promote chain onto a
closed beta. **The actionable half of AECI-555 is answered; the issue stays open only as the GA
watch.**

**Deliberately not done:** splitting the post-smoke Algolia step into its own `needs:`-chained job
would close the one residual gap and make it independently re-runnable. Declined under AECI-555 —
re-applying by hand costs seconds, and the promote workflows are the wrong place to take structural
risk for a marginal convenience. Recorded so it isn't re-proposed without new information. Also
declined: a `resume_from` workflow_dispatch input gating each step — it would let an operator skip
migrations on the single most safety-critical workflow.

#### Re-check log

Append a row on each re-check rather than re-researching from scratch.

| Date | Artifacts | Monorepos | Non-Artifacts triggers | Pricing | Verdict |
|---|---|---|---|---|---|
| 2026-08-14 (AECI-555) | Closed beta | Roadmap #3 | Roadmap #4 | Unannounced | No migration; keep watching. GH Actions approximation judged sufficient |

---

## 14. Setup checklist

Before the first deploy:

- [ ] GitHub repo created with branch protection on `main`
- [ ] GitHub Environments created: `preview`, `staging`, `production`
- [ ] Production environment requires manual approval from Chris or Bill
- [ ] All secrets configured per Section 7.1
- [ ] Cloudflare account has Workers, Pages (for static assets), and zone access
- [ ] Supabase projects created for dev/staging/production
- [ ] Algolia app created; per-env indexes + scoped keys provisioned via `scripts/algolia/provision.mjs` (`preview_*` / `staging_*` / `production_*`, per §7.5)
- [ ] Datadog account configured with appropriate API keys *(dual-run — Datadog stays until AECI-651)*
- [ ] PostHog: both projects exist (`aec-integrations` 354071 = production only; `aec-integrations-dev` 525793 = every other tier), error tracking enabled on both, internal-user exclusion configured, `POSTHOG_CLI_API_KEY` + the two `POSTHOG_PROJECT_ID_*` repo variables set. **No PostHog Worker secret to provision** — the publishable token is a committed wrangler var
- [ ] Resend account configured: verified sending domain (SPF/DKIM/DMARC), `EMAIL_FROM` sender, and the single shared `RESEND_API_KEY` GH secret; Supabase Auth SMTP pointed at Resend for magic links (see `docs/email.md`)
- [ ] Linear workspace configured per `STAGE_1_SPEC.md` §24
- [ ] DNS configured for `demo.aecintegrations.com` (web prod), `staging.aecintegrations.com`, and the landing apex + `www.aecintegrations.com`
- [ ] `.dev.vars.example` committed showing all required local secrets
- [ ] First end-to-end deploy validated against a test PR
