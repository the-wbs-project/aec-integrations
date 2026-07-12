# AEC Integrations — Documentation

This directory holds the planning, architecture, and operational documentation for AEC Integrations (AECi). For source code, see `apps/` and `packages/` at the repo root. For user-facing legal pages, see `apps/web/src/content/legal/`.

## Reading order for new contributors

1. **`STAGE_1_SPEC.md`** — master spec for the Stage 1 launch. Start here. Other documents are referenced from this one.
2. **`DATABASE_SCHEMA.md`** — full Supabase schema and Airtable migration plan.
3. **`API_CONTRACTS.md`** — Zod schemas, error codes, and TypeScript types for every API endpoint.
4. **`CICD_PLAN.md`** — GitHub Actions pipeline, environments, deployment, and rollback strategy.
5. **`TESTING_STRATEGY.md`** — high-level testing philosophy and tooling.
6. **`UNIT_TESTING_GUIDE.md`** — read before writing tests.
7. **`CODE_REVIEW_CHECKLIST.md`** — read before reviewing a PR.

## Documents

### Architecture and planning

| Document | Status | Description |
|---|---|---|
| [`STAGE_1_SPEC.md`](./STAGE_1_SPEC.md) | Active | Master specification for the Stage 1 launch. References every other document. |
| [`STAGE_1_PHASE_2_SPEC.md`](./STAGE_1_PHASE_2_SPEC.md) | Active | Phase 2 scope and specification. Supersedes §16 Phase 2 of the Stage 1 spec. |
| [`DATABASE_SCHEMA.md`](./DATABASE_SCHEMA.md) | Active | Complete application-database (Cloudflare D1) schema: all tables, columns, indexes, RLS hooks, and Airtable migration plan. |
| [`migrations.md`](./migrations.md) | Active | Migration workflow — generating SQL via drizzle-kit and applying via `wrangler d1 migrations apply` (D1 app DB). The legacy Supabase-CLI body is retained as auth-project-only history. |
| [`API_CONTRACTS.md`](./API_CONTRACTS.md) | Active | Endpoint shapes, request/response types via Zod schemas, error codes, validation rules. |
| [`REVIEW_APP_PROMOTE_API.md`](./REVIEW_APP_PROMOTE_API.md) | Active | Review-app → D1 promotion push: `POST /api/promote` payload/response, idempotency, integration rule. |
| [`AUTH_AND_RLS.md`](./AUTH_AND_RLS.md) | Active | Authorization model and Row-Level Security policies — the complete authorization source of truth (3-layer authz, GRANTs, RLS, GDPR erasure). |
| [`CICD_PLAN.md`](./CICD_PLAN.md) | Active | GitHub Actions pipeline, environments, deployments, rollback, secrets management. |
| [`environments.md`](./environments.md) | Active | Environment topology, promotion model, PR-preview lifecycle, secrets, and bootstrap checklist across all tiers. |
| [`access.md`](./access.md) | Active | Cloudflare Access runbook for non-prod environments — allowlist management, service-token rotation, lockout recovery. |
| [`CACHE_STRATEGY.md`](./CACHE_STRATEGY.md) | Active | Edge caching: tag vocabulary, TTLs, `POST /admin/purge` invalidation, SEO header set. |
| [`OBSERVABILITY.md`](./OBSERVABILITY.md) | Active | Datadog custom-metric catalog, dashboard, and monitors. |
| [`ANALYTICS_BASELINE.md`](./ANALYTICS_BASELINE.md) | Active | Pre-marketing measurement baseline (AECI-326): what PostHog/Datadog-RUM instrument, the starting numbers snapshot, and the weekly read procedure. |
| [`RUNBOOKS.md`](./RUNBOOKS.md) | Active | Incident runbooks for Datadog alerts. (Realizes the formerly-planned `OPERATIONAL_RUNBOOKS.md`.) |
| [`POST_LAUNCH_MONITORING.md`](./POST_LAUNCH_MONITORING.md) | Active | Post-launch daily/weekly monitoring runbook (AECI-279 / Phase 8.1): the operate-and-tune procedure over the shipped dashboards, monitors, and scheduled crons. |
| [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md) | Log | Dated first-week/first-month health-report log fed by the monitoring runbook (AECI-279 / Phase 8.1). |
| [`TESTING_STRATEGY.md`](./TESTING_STRATEGY.md) | Active | Testing tools (Vitest, Playwright, axe-core, Lighthouse CI), coverage targets, flaky test policy. |
| [`UNIT_TESTING_GUIDE.md`](./UNIT_TESTING_GUIDE.md) | Active | Practitioner manual for writing unit tests. Scope, workflow, what to test, anti-patterns. |
| [`CODE_REVIEW_CHECKLIST.md`](./CODE_REVIEW_CHECKLIST.md) | Active | Pre-merge review checklist for LLM and human reviewers. Severity model, output format. |
| [`CODE_REVIEW_EXEMPTIONS.md`](./CODE_REVIEW_EXEMPTIONS.md) | Active | Accepted/deferred review findings and their expiry rules. Loaded alongside the checklist on every review. |
| [`SEARCH_RANKING.md`](./SEARCH_RANKING.md) | Active | Canonical search-ranking spec: per-index searchable attributes, custom ranking signals, mechanism-kind priority, tie-breakers, and the post-launch tuning/feedback loop. Lifts `STAGE_1_SPEC.md` §7.3. |

### Design and brand

| Document | Status | Description |
|---|---|---|
| [`BRAND_GUIDELINES.md`](./BRAND_GUIDELINES.md) | Active | Brand palette, contrast, visual principles, DOCX export. |
| [`design/workflow.md`](./design/workflow.md) | Active | v0.dev → Angular design workflow: the loop from idea to shipped UI. |
| [`design/v0-porting-rules.md`](./design/v0-porting-rules.md) | Active | v0.dev → Angular porting rules + token map. The contract a port is reviewed against. |
| [`design/v0-system-prompt.md`](./design/v0-system-prompt.md) | Active | v0.dev account-level aesthetic directives / custom instructions. |
| [`design/LESSONS.md`](./design/LESSONS.md) | Log | Append-only log of design-workflow lessons from ported screens. |

> Visual-system tokens live in the repo-root `DESIGN.md`; product/brand strategy in `PRODUCT.md`; Angular/TypeScript conventions in `ANGULAR_STYLE_GUIDE.md`; logo construction in `branding/logo-construction.md`. The root `CLAUDE.md` source-of-truth table is the complete index, including these root-level docs.

### Validation and reference

| Document | Status | Description |
|---|---|---|
| [`STACK_VALIDATION_TEST.md`](./STACK_VALIDATION_TEST.md) | Complete | Foundation stack test plan (Angular SSR + Cloudflare Workers + Spartan UI). |

### Architecture Decision Records (`adr/`)

Short, dated records explaining *why* specific decisions were made. Use the [ADR format](https://adr.github.io/) — Context, Decision, Consequences. Add a new ADR when a decision could surprise someone six months from now. See [`adr/README.md`](./adr/README.md) for the live index.

ADRs 0001–0006 are written (Cloudflare Workers, Prisma Accelerate, Linear, Pro-plan Cache-Tag purge, Spartan, Algolia). 0007 documents the retired `prisma migrate` approach (superseded by AECI-72).

### Archive (`archive/`)

Historical, superseded documents kept for reference — see [`archive/README.md`](./archive/README.md). **Not a source of truth.**

## Document conventions

- **Markdown only.** No proprietary formats.
- **Single source of truth per topic.** If two documents disagree, fix the disagreement in the same PR that surfaced it.
- **Version and date** at the top of each document.
- **Cross-references** use the document filename and section anchor (e.g. `STAGE_1_SPEC.md §5.2`).
- **Updates ship with code.** Spec changes go in the same PR as the code they govern. Reviewer verifies they agree.

## How to propose changes

1. Open a branch from `main` (post-launch base-branch rule, ADR 0019 / `CICD_PLAN.md` §10: doc changes and hotfixes branch from `main`; docs shipping *with* Stage 2 code branch from `stage-2` alongside that code)
2. Edit the relevant document(s)
3. Open a PR with a clear description of what's changing and why
4. Link any related Linear issues using `Closes AECI-N`
5. Request review from Chris or Bill
6. Merge after approval

For legal documents (`apps/web/src/content/legal/*.md`), see the lifecycle in `STAGE_1_SPEC.md` §27 — counsel review is required before merge.

## Non-developer edits

If a non-developer (e.g. counsel) needs to propose changes without working in git:

1. Provide the redlined content via email or document
2. Chris or Bill opens the PR
3. Standard review process applies

A simple admin UI for legal page editing may be built in Stage 2+ if this becomes a friction point.

## Related external resources

- **Linear workspace:** issues, sprints, vendor requests
- **Airtable base** `appy81IdGJY6Fngf9`: curator workspace for vendor and product research (pre-promotion to Supabase)
- **Figma:** design system, page layouts, marketing assets
- **Datadog:** performance, errors, audit log forwarding
- **PostHog:** product analytics