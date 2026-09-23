# AEC Integrations — Claude Code Instructions

Read this before starting any task. This file is a **pointer file**: it tells you which document
governs a topic and states the rules that must never be broken. It does not retell history.
Provenance lives in git, Linear, and the ADRs, and a size gate (`scripts/check-claude-md-size.mjs`,
run by `pnpm lint`) keeps this file under 30 KB. When you learn something, record it in the
governing doc, not here.

## What this project is

**AEC Integrations (AECi)** is a directory and review platform for software integrations in the
Architecture, Engineering, and Construction industry: dual-vendor-verified integration reviews,
AEC-native taxonomy, trust-first positioning (no pay-for-placement), and dual reviews separating
product quality from onboarding experience.

The site is **live in production** (canonical host `www.aecintegrations.com`). The app database is
Cloudflare D1; Supabase is Auth-only. Catalog data is curated upstream in the review app and pushed
into D1 via the async promote protocol. `main` is the production line and the only line.

## Sibling repos — check you're in the right one

AECi spans three GitHub repos under `the-wbs-project`. Linear issues for all three are on the
**AECi** team; the routing signal is the issue's **project** and **title prefix**, not the team.

| Repo | What it holds | Linear routing |
|---|---|---|
| **`aec-integrations`** (this one) | The app: Angular SSR + Workers + D1, and the specs that govern it | Default. No prefix; project is the stage/epic |
| **`aec-integrations-review`** | The curation/review app upstream of promote: catalog, connector catalogues/stubs/mappings, `docs/connector-vendors.md`. Read-only from here via the `aeci-review` MCP | Title prefixed **`REVIEW - `**, no project |
| **`aec-integrations-marketing`** | All Markdown: positioning, strategy, content plan, outreach under `docs/outreach/`. Stricter copy rules (sentence case, no em dashes) | Project **"Marketing"**, no prefix |

Pick the repo before filing an issue. If work belongs in another repo, say so rather than writing
it here; you cannot commit across repos from one workspace.

## Where to start

`docs/STAGE_1_SPEC.md` is the master spec, 1,600+ lines. **Load only the section that governs
your task.**

1. For any AECI-* task, **invoke the `spec-anchor` skill.** It fetches the Linear issue, resolves
   its `**Spec section:**` line (grammar: `docs/linear-issue-conventions.md`), loads that section,
   and follows cross-references. An anchor whose heading does not exist is reported, never silently
   re-pointed.
2. **Once you have a plan, run the same skill's plan check (step 4.5) before writing code.**
   Findings are rated 🔴 CRITICAL / 🟡 MAJOR / 🔵 MINOR. Issues with no `§X.Y` anchor go through the
   skill's n/a ladder.
3. Not working from an issue? Use the source-of-truth table below. It is the complete index.
4. If the spec is ambiguous or wrong, raise it; don't guess. Docs are stale in known places, so
   check the code before treating a doc/plan divergence as a defect.

## Documents that are source of truth

If your work touches a topic below, that document is the truth, not your prior knowledge.

| Topic | Source of truth |
|---|---|
| What we're building and why | `docs/STAGE_1_SPEC.md` |
| Phase 2 / 5 / 6 scope (supersede §16 of the Stage 1 spec) | `docs/STAGE_1_PHASE_2_SPEC.md`, `docs/STAGE_1_PHASE_5_SPEC.md`, `docs/STAGE_1_PHASE_6_SPEC.md` |
| Stage 1.5 integration redesign (product-PAIR page, claim/attestation model) | `docs/STAGE_1_5_SPEC.md` |
| Connector lane (iPaaS reachability): Addendum B schema, Addendum C presentation contract, connector-catalog sync, evidenced pairs, reach line, vendor Connectors tab | `docs/STAGE_1_5_SPEC.md` §12 + §13; schema `docs/DATABASE_SCHEMA.md` §9a; sync `docs/REVIEW_APP_PROMOTE_API.md` §3a; commercial model `docs/STAGE_2_SPEC.md` §8.8–§8.10; catalogue truth in the review repo's `docs/connector-vendors.md` |
| Vendor and product logo editing (validated R2 uploads, promote ownership) | `docs/STAGE_2_5_SPEC.md` §11, ADR 0032 |
| Vendor-authored "How teams use it" narrative (`product.usefulness.edit`, `usefulness_source` fence) | `docs/STAGE_2_5_SPEC.md` §12, ADR 0033 |
| Integration ownership: vendor-owned, AECi seeds; claim, retire/restore, vendor create, promote fence and twin guard | `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5–§4.7, ADR 0035; promote side `docs/REVIEW_APP_PROMOTE_API.md` §4b–§4c |
| Integration field contests and the protest to AECi | `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §11b (protest §11b.12); queue `docs/ADMIN_PANEL_SPEC.md` §5.12 |
| Stage 2 scope outline (kickoff draft, not a build contract) | `docs/STAGE_2_SPEC.md` |
| Stage 2 Vendor Portal build spec (claims, vendor authz seam, portal, verified badge) | `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` |
| Stage 2 Paid Tiers & Entitlements (`vendor_entitlements`, capability registry, ranking firewall) | `docs/STAGE_2_PAID_TIERS_SPEC.md` |
| Stage 2 Integration Attestations (authority, agreement state, version model, §13.9 maintenance transfer) | `docs/STAGE_2_ATTESTATIONS_SPEC.md` |
| Stage 2 Real-Time / Live Portal: scoped client revalidation, not sockets (ADR 0023); `GET /api/vendor/updates` cursor | `docs/STAGE_2_REALTIME_SPEC.md` |
| Vendor Performance reporting (`/vendor/:slug/performance` behind `analytics.view`) | `docs/VENDOR_PERFORMANCE_SPEC.md`; rationale `docs/design/vendor-performance-direction.md` |
| Product Docs / Help Center (`/docs` inside `apps/web`; kickoff draft) | `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` |
| Stage 2.1 vendor-activation interlude (dark launch → seat pilot vendors; proposal) | `docs/STAGE_2_1_SPEC.md` |
| Stage 2.5 hardening interlude (search-ranking overhaul, §7 trust/answer-surface artifacts; proposal) | `docs/STAGE_2_5_SPEC.md` |
| Stage 3 scope outline (trust ladder, pSEO, rebrand option survey §2.6; kickoff draft) | `docs/STAGE_3_SPEC.md` |
| `data_object` controlled vocabulary | `docs/DATA_OBJECT_VOCABULARY.md` (+ generated JSON mirror) |
| `trade` controlled vocabulary (fourth taxonomy facet) | `docs/TRADES_VOCABULARY.md`; facet behaviour `docs/STAGE_1_SPEC.md` §5.5a |
| API endpoint shapes, validation, errors, sort collation | `docs/API_CONTRACTS.md` |
| Review-app → app-DB promote (async kick-off/poll/collect, idempotency keys, connector-catalog arm §3a, retraction consumer §5.1, cross-table moves) | `docs/REVIEW_APP_PROMOTE_API.md`; ADR 0021, ADR 0030 |
| Database schema (§12 is the app-layer authorization model; no RLS on app tables) | `docs/DATABASE_SCHEMA.md` |
| Migration workflow, D1 recreate hazards, cascade data-loss controls | `docs/migrations.md` §0; ADR 0018 |
| Local dev: ports, Conductor workspaces, service binding, version reporting | `docs/local-dev.md` |
| Local dev tracing (OTel traces over a SQL endpoint in `wrangler dev`) | `docs/local-tracing.md` |
| Drizzle/D1 data layer (client, schema, `db.batch()` audit/workflow builders) | `apps/api/src/db/`, `apps/api/src/lib/{audit,drizzle-helpers,recompute-counts}.ts`; ADR 0016 |
| CI/CD, environments, deployment, branch model | `docs/CICD_PLAN.md`; topology + runbook `docs/environments.md` |
| Cloudflare Access for non-prod | `docs/access.md` |
| Rate limiting, both layers (zone WAF + bot settings §0–§5; in-Worker limiter §6; which layer stopped a caller §6.4) | `docs/waf-rate-limits.md`; ADR 0026 |
| Testing tools, coverage, patterns; writing unit tests | `docs/TESTING_STRATEGY.md`; `docs/UNIT_TESTING_GUIDE.md` |
| Manual accessibility testing; audit results | `docs/a11y-manual-testing-checklist.md`; `docs/ACCESSIBILITY_AUDIT.md` |
| Reviewing code; accepted exemptions | `docs/CODE_REVIEW_CHECKLIST.md`; `docs/CODE_REVIEW_EXEMPTIONS.md` |
| Edge caching: tags, TTLs, invalidation, native Workers Cache, SEO headers | `docs/CACHE_STRATEGY.md`; ADR 0020 |
| Search ranking: Algolia settings and signals | `docs/SEARCH_RANKING.md` |
| Observability (PostHog only): metrics, dashboards, alerts | `docs/OBSERVABILITY.md`; migration record `docs/POSTHOG_MIGRATION_SPEC.md`, ADR 0024 |
| Analytics: baseline snapshot; product event catalogue | `docs/ANALYTICS_BASELINE.md`; `docs/ANALYTICS.md` |
| Transactional email, magic-link SMTP, deliverability | `docs/email.md` |
| Incident runbooks; post-launch monitoring and health log | `docs/RUNBOOKS.md`; `docs/POST_LAUNCH_MONITORING.md`; `docs/POST_LAUNCH_HEALTH_REPORT.md` |
| Admin panel / operator console | `docs/ADMIN_PANEL_SPEC.md` |
| Launch / DNS cutover runbook | `docs/launch-cutover-runbook.md` |
| Phase completion checkpoints | `docs/PHASE_{2..8}_COMPLETION.md` |
| Auth model and authorization (the Worker guard is the only layer) | `docs/AUTH_AND_RLS.md` |
| Strategic product / brand context | `PRODUCT.md` |
| Visual design system (tokens, components) | `DESIGN.md` |
| Angular / TypeScript conventions and the lint-rule map (§24) | `ANGULAR_STYLE_GUIDE.md` |
| Brand book; logo construction | `docs/BRAND_GUIDELINES.md`; `branding/logo-construction.md` |
| v0.dev → Angular design workflow, porting rules, system prompt | `docs/design/workflow.md`, `docs/design/v0-porting-rules.md`, `docs/design/v0-system-prompt.md` |
| Foundation stack validation | `docs/STACK_VALIDATION_TEST.md` |
| Linear issue conventions (anchor grammar, title-prefix routing, templates) | `docs/linear-issue-conventions.md` |
| The curation store upstream of promote (review app's own D1; `rec…` ids are format only) | ADR 0029 |
| Catalog agent spike (`apps/agent` on Flue) | ADR 0034; `apps/agent/README.md` |
| Architecture Decision Records index | `docs/adr/README.md` |

## Stack at a glance

- **Frontend:** Angular 21+ with SSR, zoneless. **Styling:** Tailwind v4 + Spartan UI + Angular
  CDK; new form-control patterns use Angular Aria, Spartan stays for overlays (ADR 0010).
- **Hosting:** Cloudflare Workers: SSR Worker + private API Worker over a service binding. The API
  Worker also runs the `PromoteWorkflow` Cloudflare Workflow (ADR 0021).
- **Database:** Cloudflare D1 via Drizzle over the `DB` binding (ADR 0016). Supabase is Auth only.
  Lead capture lives in D1 (`/api/feedback`, `/api/subscribe`, tokenized soft-delete unsubscribe);
  `docs/email.md`.
- **Search:** Algolia + InstantSearch Angular. **Auth:** Supabase Auth (magic link + Google OAuth).
- **Observability:** PostHog only (ADR 0024). Workers hold no observability secret; the `phc_`
  project key is a committed per-env wrangler var. Alerts evaluate hourly; cron-absence detection
  is a scheduled-CI liveness sweep. `docs/OBSERVABILITY.md`.
- **Catalog agent (spike):** `apps/agent`, hand-deployed, Vite build, writes no domain state.
  ADR 0034.
- **Issue tracker:** Linear. **i18n:** `@angular/localize`, en-US only at launch.
- **Email:** Resend (transactional) + Microsoft 365 (mailboxes). `docs/email.md` is truth.
- **Workflow automation:** a Cloudflare Worker for the form→Linear pipeline. No n8n, no Slack.
- **Theme:** light only. No toggle, no system-preference detection. Dark is not roadmapped.

## Constraints that aren't negotiable

These recur in tasks and are tempting to violate. Don't. Several are enforced by `pnpm lint`
(`Lint: ✅`); the rule-to-constraint map is `ANGULAR_STYLE_GUIDE.md` §24. The rest are
`Lint: 🟡 review-only`. Each bullet is the rule plus one pointer; the history is in the pointer.

- **Drizzle over the D1 binding; no Prisma, no pg, no Postgres drivers.** `Lint: ✅`. Get a
  request-scoped client via `getDb(env)`; schema truth is `apps/api/src/db/schema.ts`. D1 has no
  interactive transactions: atomic writes go through `db.batch([...])`, and every domain-state
  write emits its `audit_log` row into the same batch (`apps/api/src/lib/audit.ts`). ADR 0016.
- **Promote is async; never commit on the request.** `Lint: 🟡`. `POST /api/promote` validates,
  starts the Workflow, returns `202 { jobId }`. The ingest runs in one non-retried `step.do`, takes
  a narrow `PromoteRunCtx`, and writes the `promote_jobs` ledger row as the first statement of the
  same batch so a replay trips the PK and returns the recorded result. Never move that insert,
  never add `ON CONFLICT DO NOTHING`, never let an unreadable ledger row re-plan. Upsert-by-id
  falls back to insert when the id no longer resolves, gated on the existence read. The
  connector-catalog arm shares the binding on a `kind` field that must stay optional. Promote
  never infers a delete from absence (ADR 0030); id-directed cross-table moves re-home claims
  before dropping the source. `docs/REVIEW_APP_PROMOTE_API.md`, ADR 0021.
- **drizzle-kit + `wrangler d1` own migrations.** Edit `schema.ts`, `pnpm db:generate`,
  `pnpm db:migrate:local`, `pnpm db:seed:local`. A drizzle-kit table recreate on D1 fires
  `ON DELETE CASCADE` two levels deep and `PRAGMA defer_foreign_keys` does not stop it; statement
  order in a recreate migration is a data-loss control. `docs/migrations.md` §0, ADR 0018.
- **Release every `fetch` body you don't read, and batch fan-out.** `Lint: 🟡`. A Worker holds
  about six pending connections; a cancelled `fetch` returns a promise that never settles, so the
  loss is silent. Call `discardResponseBody(res)` on every unread path, prefer one batched request,
  else `mapWithConcurrency(items, WORKER_CONNECTION_LIMIT, fn)`; multi-message Queue producers use
  `sendBatch()`. Promote post-commit hooks go through `dispatchHook` with its 20 s watchdog.
  ADR 0021 (2026-08-27 amendment).
- **`nodejs_compat` is for SSR, not the DB.** The SSR Worker needs it for `@angular/ssr`; the API
  Worker reaches D1 natively. `apps/web/wrangler.jsonc`.
- **Cache: tags, native Workers Cache, and `Vary`.** Every cacheable SSR response sets `Cache-Tag`
  via the helper in `apps/web/src/server/cache-tags.ts`; invalidation is `ctx.cache.purge()`,
  cross-Worker via the `aeci-cache-purge-{env}` Queue. `Vary` may only be `Accept-Language`
  (`Lint: ✅`, tests exempt). Native caching is live on preview + staging only; demo/production run
  uncached today. Miniflare does not emulate the front cache. `docs/CACHE_STRATEGY.md`.
- **Cached SSR routes render visitor-state-neutral HTML.** The cache is keyed by URL, not cookies.
  Strip visitor-state cookies before SSR (`stripVisitorStateCookies` in
  `apps/web/src/server-runtime.ts`) and reconcile after hydration.
- **Zoneless Angular.** `Lint: ✅`. No `zone.js`, no `NgZone`. `provideZonelessChangeDetection()`
  plus `provideClientHydration(withHttpTransferCacheOptions({ includePostRequests: false }))`.
  `ANGULAR_STYLE_GUIDE.md`.
- **Router scroll restoration is already solved; don't re-solve it.** `withInMemoryScrolling`,
  `ScrollBehaviorManager`, `provideScrollMarginViewportScroller()` and `InitialFragmentScroller`
  work together. Never fix an anchor offset with a global `setOffset([0, N])`.
  `ANGULAR_STYLE_GUIDE.md`.
- **No pay-for-placement.** Rankings are purely algorithmic. Paid tiers affect profile richness,
  never position. `docs/STAGE_2_PAID_TIERS_SPEC.md`.
- **i18n from day one.** `Lint: 🟡`. No hardcoded English in templates; use `i18n` attributes or
  `$localize`. The template i18n ESLint rule was evaluated and rejected; don't re-propose it
  without new information (`ANGULAR_STYLE_GUIDE.md` §24).
- **Light only.** `Lint: ✅` (ESLint for `.ts`, `apps/web/scripts/check-source-constraints.mjs`
  for `.html`/`.css`). No `dark:` variants, no `.theme-dark`, no toggle. Tokens stay in place.
- **Case never decides an alphabetical order.** `Lint: 🟡`. D1 uses `textAsc`/`textDesc`
  (`apps/api/src/lib/collation.ts`); in memory use `compareText` from `@aeci/shared/text-sort`,
  never a bare `.sort()` or unpinned `localeCompare`; Algolia ranks on `name_sort` keys. The
  `id ASC` tiebreaker is load-bearing; slug/id/enum/timestamp orderings stay `BINARY`.
  `docs/API_CONTRACTS.md` §3.2, `ANGULAR_STYLE_GUIDE.md` §20a.
- **Reads are never rate-limited.** `Lint: 🟡`. `rateLimit()` is registered per route, after the
  authz guard, on writes only, never globally. The `ratelimits` binding is not inherited across
  wrangler environments (declare it in all five blocks); `simple.period` is 10 or 60 seconds only.
  `docs/waf-rate-limits.md` §6, ADR 0026.
- **Audit logging is transactional.** See "Audit logging" below.
- **Accessibility is built in.** Spartan + CDK give a11y by default; don't break it. Run axe-core
  locally before pushing.

## Design checklist (UI-touching issues only)

For any issue that renders UI in `apps/web/`. `PRODUCT.md` and `DESIGN.md` are part of the
contract.

1. **Critique first:** `/impeccable critique <surface>` for a baseline (output in `.impeccable/`).
2. **Pick the anchor reference** via Mobbin before building; record it in the issue or commit.
   Components for a surface come from the same anchor site (`DESIGN.md` "The Anchor-Site Rule").
3. **Build via the matching skill:** `/impeccable craft`, or `typeset` / `layout` / `colorize` /
   `distill` for refinement. Design-system alignment is part of `polish`.
4. **Polish:** `/impeccable polish`.
5. **Detect anti-patterns against the RENDERED surface:** `npx impeccable detect <url>` with
   `pnpm dev:agent` running. A file-path scan reports a false clean here because templates are
   inline in `.ts`. Resolve every P0 or open a follow-up.
6. **Light theme only.**
7. **Run axe-core locally**; resolve every error and `serious` violation.

## API contracts approach

Shared types in `packages/shared/src/api/`, validated at runtime with Zod. The SSR Worker imports
types from `@aeci/shared`; the API Worker validates with Zod and throws `ApiError`; a central
middleware converts `ApiError` and `ZodError` to structured responses. No OpenAPI, no codegen.
`docs/API_CONTRACTS.md` §2.

## Build and dev workflow

```bash
pnpm install
pnpm dev:agent       # boot SSR + API in an agent workspace (auto-picks free ports from 8790/8789)
pnpm typecheck
pnpm lint            # ESLint + Prettier --check + source-constraint guards + CLAUDE.md size gate
pnpm lint:fix
pnpm test            # unit + integration
pnpm test:unit
pnpm test:e2e        # Playwright against local wrangler dev
pnpm build
```

- **Agents boot with `pnpm dev:agent`, never `dev:conductor` / `dev` / `dev:bound`.** The
  `8788/8787` pair and its dev-registry names are reserved for the human's primary workspace.
  `dev:agent` prints the pair it chose; rebuilds the web bundle and clears the SSR cache first
  (`DEV_SKIP_BUILD=1` to skip). Launch failures with a SIGTERM symptom are orphaned `workerd`
  processes; see `docs/local-dev.md`.
- Local secrets live in `.dev.vars` per Worker; `.dev.vars.example` lists what's required.
- **Debug a local 500 with SQL, not `console.log`.** `wrangler dev` records OTel traces for every
  invocation and binding call and serves them over a read-only SQL endpoint. Derive the port from
  the pair your session printed; the API store holds the D1 spans; failures are in
  `error.type` attributes, not `spans.outcome`. `docs/local-tracing.md`.

```bash
API_PORT=8789
curl -sX POST "http://localhost:$API_PORT/cdn-cgi/local/explorer/api/local/observability/query" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT service, name, outcome, duration_ms FROM spans WHERE parent_id IS NULL LIMIT 20"}'
```

- **Version reporting:** `GET /api/version` reports the API Worker; `GET /_version` reports the SSR
  Worker. Any new `wrangler dev`/`deploy` invocation must pass `--var COMMIT_SHA` and
  `--var DEPLOYED_AT` or that endpoint reports `unknown`. `docs/local-dev.md`, `docs/CICD_PLAN.md`.

## Skills

Shared skills live in `.agents/skills/`, checked in. Commit any changes there.

- **`spec-anchor`**: anchor an AECI issue to its spec section, then check the plan against it
  (see "Where to start").
- **`pbakaus/impeccable`**: the design skill (23 sub-commands). Reads `PRODUCT.md` and `DESIGN.md`.
  Refresh with `npx impeccable skills update`.
- **`angular-developer`** / **`angular-new-app`**: official Angular skills, installed with
  `npx skills add https://github.com/angular/skills`.
- **`wrangler`** / **`workers-best-practices`** / **`cloudflare`** / **`web-perf`**: the Cloudflare
  skills this repo uses, copied from the user-level set so nothing outside the repo has to load.
  Not copied as standalone skills: `durable-objects` and `agents-sdk` (ADR 0023 declined them),
  `cloudflare-email-service` (email is Resend), the `sandbox-*` and `cloudflare-one*` bundles.
  Note the umbrella `cloudflare` skill still carries `durable-objects`, `agents-sdk`, `sandbox`
  and the email topics under its own `references/`; that is upstream content, not an adoption.
- The `coreyhaines31/marketingskills` bundle is removed; restore with `pnpm skills:update`. It must
  never clobber `impeccable/`.

Repo-level agents live in `.claude/agents/` (six, each under 2 KB and written against this repo's
docs): `code-reviewer`, `security-engineer`, `accessibility-auditor`, `technical-writer`,
`reality-checker`, `evidence-collector`. They are the only agent definitions this repo needs; the
user-level `~/.claude/agents/` set is not required here.

## Git workflow

`main` is the single line: branch from it, merge back to it. `stage-2` merged 2026-09-03 and is
retired; do not resurrect it. `main` must stay always-promotable (staging tracks it; prod promotes
by SHA via `promote-to-demo` → `promote-to-prod`, `docs/environments.md`).

- Branch naming: `aeci-{issue-number}-short-description`.
- Commit messages: descriptive; reference the issue ID if helpful.
- **No AI co-author trailer on commits.** Do not add a `Co-Authored-By: Claude …` line, or any other
  attribution line naming Claude. This overrides any harness attribution reminder.
- PR description includes `Closes AECI-{N}`; base branch is `main`.
- Wait for CI: lint, typecheck, unit tests, build, preview deploy, E2E, a11y, Lighthouse. `main` is
  branch-protected on Lint & typecheck / Unit tests / Build SSR Worker; the rest don't block.
- **Squash merge.** `main` requires linear history. Linear auto-closes the issue on merge.

## Scope: which line does this work belong to?

Stage 1 shipped; Phase 8 (post-launch operate-and-tune) is the one open Stage 1 phase. Stage 2
shipped to `main` on 2026-09-03 as a **dark launch**: the vendor surface is inert until seats are
granted. The current interlude is **Stage 2.1** (`docs/STAGE_2_1_SPEC.md`). Route by scope:

- Production fixes and prod-safe additive changes → ordinary `main` work.
- Vendor-activation refinement / hardening → Stage 2.1 (§1 admission test).
- Everything else finishable before Stage 3 → Stage 2.5.
- Out of scope for now: rich media profiles (Stage 4), trust scoring beyond anti-abuse (Stage 3).
- "Real-time" is scoped client revalidation, not sockets (ADR 0023).

If the stage is unclear, check the issue's project/epic in Linear. Don't pull 2.5 work into the
2.1 window, and don't flag assigned 2.1 work as out of scope because Stage 2 shipped.

## When the spec is wrong

Don't silently work around it. Don't invent an approach. Raise a Linear issue or comment on your
current issue, and wait for direction. The spec is the contract.

## Audit logging and the observability forward

Every write that changes **domain state** emits its `audit_log` row (+ `workflow_transitions`) in
the same `db.batch` as the mutation, via the builders in `apps/api/src/lib/audit.ts`, then forwards
post-commit via `ctx.waitUntil` to PostHog Logs through the seam in
`packages/shared/src/audit-log.ts`. A forwarding failure warns and swallows; a missing row is a
transactional failure. Domain state = catalog, users/profiles, reviews/moderation,
claims/attestations, requests/workflows. Derived and log-class writes are exempt (`page_views`,
`mailing_list`, `feedback`, `stats_cache`, Algolia watermark, `recompute-counts`, `metrics_daily`,
`job_runs`). The test is entity class, not actor class; scheduled `DELETE`s are never exempt.
`docs/STAGE_1_SPEC.md` §26, ADR 0022.

## Cache invalidation

Writes that affect cached pages purge by `Cache-Tag`: producers enqueue a typed message on the
tier's Queue (promote from the Workflow's post-commit hooks), the SSR consumer delegates
`ctx.cache.purge()` into `Renderer`, and `POST /admin/purge` purges in-process. Tests for write
paths assert the queued directive. `docs/CACHE_STRATEGY.md`; the §9.3 URL-map approach in the
Stage 1 spec is superseded.

## MCP usage rules

- **`angular-cli`**: runs the workspace CLI from `apps/web`. Call `get_best_practices` once per
  session before touching Angular code; use `search_documentation` for API questions; `list_projects`
  before generating files. The `run_target` / `devserver.*` tools build and serve; invoke deliberately.
- **`linear`**: team prefix `AECI`; `spec-anchor` depends on it. **Keep the tracker current without
  asking**: file issues for discovered work, assign to `chrisw@thewbsproject.com`, move status to
  match reality, comment findings on the issue you're on. Confirm first only when a write lands on
  someone else's work or destroys context.
- **`aeci-review`**: the curation app upstream of promote. Use the read tools (`list_*`, `get_*`,
  `find_product`, `compute_*`) to see real catalog shape instead of inventing fixtures. **Write tools
  are production actions** (`create_*`, `update_*`, `add_attestation`, `promote_product`): never call
  them to try something; confirm with the user first.
- **`mobbin`**: visual reference library for any UI-touching issue. `authenticate` then
  `complete_authentication`. Honour the anchor-site rule.

## Writing for Chris

Chris reads your final message to decide what to do. Write it so he can act without re-reading.
These rules apply to every report, finding, plan summary, and Linear comment.

- **Answer first.** Open with the conclusion or the outcome. Evidence and reasoning come after.
- **Every finding has three parts, in this order:** what is wrong, why it matters, what to do. If
  you cannot fill all three, say which one is missing.
- **One claim per sentence.** About 20 words. No em dashes, no semicolons joining clauses, no
  parentheticals. Start a new sentence instead.
- **Say it plainly.** Prefer "the setting is off" to "the configuration is suboptimal". Prefer "we
  do not know" to "this remains to be validated". Never write "plausibly", "arguably", or "it is
  worth noting".
- **Gloss every term the first time.** Assume Chris knows the product and the stack but not the
  acronym you just coined.
- **Numbers and code go in blocks or tables, not prose.** Name at most one file, function, or flag
  per sentence.
- **End with a bullet summary.** Five to eight bullets, each an action or a decision.
- **Do not perform expertise.** If a sentence exists to sound authoritative rather than to tell him
  something, delete it.

## Commands you hand to the operator

When you write a shell command for the human to paste, hand over the command **and nothing else**:
no `#` comment lines, no `$` prompt prefixes, no placeholder angle brackets inside a runnable line.
Put the explanation in prose above or below the block. Applies to every runnable snippet.

## Closing notes

This file is a pointer file and must stay under 30 KB (`scripts/check-claude-md-size.mjs`). When a
lesson is learned, record it in the governing doc and, if needed, add a one-line pointer here.
Never append narrative, issue history, or dated incident detail to this file. At each stage
boundary, audit every line: name the failure it prevents or delete it.

Last updated: see git log.
