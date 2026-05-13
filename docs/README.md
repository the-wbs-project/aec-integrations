# AEC Integrations — Documentation

This directory holds the planning, architecture, and operational documentation for AEC Integrations (AECi). For source code, see `apps/` and `packages/` at the repo root. For user-facing legal pages, see `apps/web/src/content/legal/`.

## Reading order for new contributors

1. **`STAGE_1_SPEC.md`** — master spec for the Stage 1 launch. Start here. Other documents are referenced from this one.
2. **`DATABASE_SCHEMA.md`** — full Supabase schema and Airtable migration plan.
3. **`API_CONTRACTS.md`** — Zod schemas, error codes, and TypeScript types for every API endpoint.
4. **`CICD_PLAN.md`** — GitHub Actions pipeline, environments, deployment, and rollback strategy.
5. **`TESTING_STRATEGY.md`** — test tools, coverage targets, flaky test policy.

## Documents

### Architecture and planning

| Document | Status | Description |
|---|---|---|
| [`STAGE_1_SPEC.md`](./STAGE_1_SPEC.md) | Active | Master specification for the Stage 1 launch. References every other document. |
| [`DATABASE_SCHEMA.md`](./DATABASE_SCHEMA.md) | Active | Complete Supabase schema: all tables, columns, indexes, RLS hooks, and Airtable migration plan. |
| [`API_CONTRACTS.md`](./API_CONTRACTS.md) | Active | Endpoint shapes, request/response types via Zod schemas, error codes, validation rules. |
| [`AUTH_AND_RLS.md`](./AUTH_AND_RLS.md) | Placeholder | Authorization model and Row-Level Security policies. Full definition pending. |
| [`CICD_PLAN.md`](./CICD_PLAN.md) | Active | GitHub Actions pipeline, environments, deployments, rollback, secrets management. |
| [`TESTING_STRATEGY.md`](./TESTING_STRATEGY.md) | Active | Testing tools (Vitest, Playwright, axe-core, Lighthouse CI), coverage targets, flaky test policy. |
| [`SEARCH_RANKING.md`](./SEARCH_RANKING.md) | Pending | Algolia ranking customization, tuning rules, feedback loops. |
| [`OPERATIONAL_RUNBOOKS.md`](./OPERATIONAL_RUNBOOKS.md) | Pending | Incident response, vendor dispute handling, recovery procedures. |

### Validation and reference

| Document | Status | Description |
|---|---|---|
| [`STACK_VALIDATION_TEST.md`](./STACK_VALIDATION_TEST.md) | Complete | Foundation stack test plan (Angular SSR + Cloudflare Workers + Spartan UI). |

### Architecture Decision Records (`adr/`)

Short, dated records explaining *why* specific decisions were made. Use the [ADR format](https://adr.github.io/) — Context, Decision, Consequences. Add a new ADR when a decision could surprise someone six months from now.

Examples planned:
- `0001-cloudflare-workers-over-vercel.md`
- `0002-no-prisma-accelerate.md`
- `0003-linear-over-huly.md` (and back from huly to linear)
- `0004-pro-plan-purge-by-url.md`
- `0005-spartan-over-syncfusion.md`
- `0006-algolia-over-cloudflare-ai-search.md`

## Document conventions

- **Markdown only.** No proprietary formats.
- **Single source of truth per topic.** If two documents disagree, fix the disagreement in the same PR that surfaced it.
- **Version and date** at the top of each document.
- **Cross-references** use the document filename and section anchor (e.g. `STAGE_1_SPEC.md §5.2`).
- **Updates ship with code.** Spec changes go in the same PR as the code they govern. Reviewer verifies they agree.

## How to propose changes

1. Open a branch from `main`
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
