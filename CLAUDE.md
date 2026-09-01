# AEC Integrations — Claude Code Instructions

This file tells Claude Code how to work in this repo. Read this before starting any task.

## What this project is

**AEC Integrations (AECi)** is a directory and review platform for software integrations in the Architecture, Engineering, and Construction industry. The product is built around dual-vendor-verified integration reviews, AEC-native taxonomy, trust-first positioning (no pay-for-placement), and dual reviews separating product quality from onboarding experience.

The site is currently in pre-launch. Production data lives in Airtable; Supabase is being built out for Stage 1.

## Sibling repos — check you're in the right one

AECi spans **three** GitHub repos under `the-wbs-project`, and Linear issues for all three are filed on
the **AECi** team. The routing signal is the issue's **project** and **title prefix**, not the team:

| Repo | What it holds | Linear routing |
|---|---|---|
| **`aec-integrations`** (this one) | The app: Angular SSR + Workers + D1, and the specs that govern it | Default. No prefix; project is the stage/epic |
| **`aec-integrations-review`** | The curation/review app upstream of promote — the catalog, connector catalogues/stubs/mappings, and `docs/connector-vendors.md`. Reachable read-only from here via the `aeci-review` MCP | Title prefixed **`REVIEW - `**, no project |
| **`aec-integrations-marketing`** | **No application code — all Markdown.** Positioning, strategy, content plan, channel copy, and partner/vendor outreach material under `docs/outreach/`. `CLAUDE.md` is a symlink to `AGENTS.md`; its copy rules are stricter than this repo's (sentence case, **no em dashes**) | Project **"Marketing"**, no prefix |

**When you file an issue, pick the repo first and route it accordingly** — a call brief, an outreach
email, or positioning copy belongs in the marketing repo under the Marketing project, not here. If work
you're doing turns out to belong to another repo, say so rather than writing it into this one; you
generally cannot commit across repos from a single workspace.

## Where to start

`docs/STAGE_1_SPEC.md` is the master spec and the contract — but it's 1,600+ lines. **Don't read it end-to-end; load only the section that governs your task.**

1. For any AECI-* task, **invoke the `spec-anchor` skill.** It fetches the Linear issue, parses its `**Spec section:** §X.Y` line, loads just that section from the spec the line names — `docs/STAGE_1_SPEC.md` by default, but Stage 1.5, the phase specs, `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` and `docs/ADMIN_PANEL_SPEC.md` are all common anchors now — and follows the cross-references into the companion docs (`docs/API_CONTRACTS.md`, `docs/DATABASE_SCHEMA.md`, etc.). (The `§X.Y` convention is enforced by the team Linear issue templates — Linear has no custom-field feature on our plan.)
2. **Once you have a plan, run the same skill's plan check (step 4.5) before writing any code.** It reviews the plan against the section it just loaded and returns findings rated 🔴 CRITICAL / 🟡 MAJOR / 🔵 MINOR — the cheap moment to catch a spec contradiction, a missing contract element, or a governing doc the plan will make stale. Issues with no `§X.Y` anchor go through the skill's n/a ladder rather than being skipped (AECI-550).
3. If you're not working from an AECI issue, jump straight to the governing doc via the source-of-truth table below. **This table is the complete index** — the spec's own §1a "Companion Documents" list is older and incomplete.
4. If the spec is ambiguous or wrong, raise it — don't guess. The docs are stale in known places, so check the code before treating a doc/plan divergence as a defect.

## Documents that are source of truth

| Topic | Source of truth |
|---|---|
| What we're building and why | `docs/STAGE_1_SPEC.md` |
| Phase 2 scope and spec (supersedes §16 Phase 2 of the Stage 1 spec) | `docs/STAGE_1_PHASE_2_SPEC.md` |
| Phase 5 scope and spec (auth & reviews; supersedes §16 Phase 5 of the Stage 1 spec) | `docs/STAGE_1_PHASE_5_SPEC.md` |
| Phase 6 scope and spec (requests & moderation; supersedes §16 Phase 6 + §12 of the Stage 1 spec) | `docs/STAGE_1_PHASE_6_SPEC.md` |
| Stage 1.5 scope and spec (Integration Redesign: product-PAIR page + claim/attestation model; supersedes the integration portions of §3.1/§4.4/§7.5 of the Stage 1 spec) | `docs/STAGE_1_5_SPEC.md` |
| Stage 2 scope outline (vendor portal / self-serve claiming, paid tiers [no pay-for-placement], real-time, integration attestations, dark-theme reintroduction; supersedes §18 Stage 2 Forward Compatibility of the Stage 1 spec; **kickoff draft — not yet a build contract**) | `docs/STAGE_2_SPEC.md` |
| Stage 2 Vendor Portal build spec (the AECI-513 epic: claimant identity resolution, claim→verified-account grant, the `/api/vendor/*` vendor authz seam, admin claim-review, vendor portal, verified-badge activation on trust + search surfaces, claim-decision emails; the build contract each AECI-513 sub-issue [519…525, 527, 528, 529] anchors to; supersedes the integration/portal portions of §2.1 of `STAGE_2_SPEC.md`) | `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` |
| Stage 2 Paid Tiers & Entitlements build spec (the AECI-515 epic: the `vendor_entitlements` table with `vendors.verified` demoted to a **mirror**, the capability registry + the asserted no-pay-for-placement ranking firewall, the entitlement gate on `AuthenticatedSession`, the admin set/renew/clear action, term-expiry **warnings** [never auto-lapse], the vendor plan panel; the build contract each AECI-515 sub-issue [609…615 plus the re-scoped 532] anchors to; supersedes the entitlement/billing portions of §2.2 + the first two §8.2 open items of `STAGE_2_SPEC.md`, and §8.3(1)'s "no new schema") | `docs/STAGE_2_PAID_TIERS_SPEC.md` |
| Stage 2 Integration Attestations build spec (the AECI-514 epic: attestation authority + claim provenance, promote coexistence, the `single_source` agreement state + conflict UI, vendor attestation authoring, the detector/notification pipeline, the product-version model + version-diff timeline, the maintenance marker's real `last_reviewed_at`; the build contract each AECI-514 sub-issue [301, 302, 303, 603…608, 616] anchors to; supersedes §2.4 of `STAGE_2_SPEC.md` and activates the Stage 1.5 carve-outs in §10 of `STAGE_1_5_SPEC.md`) | `docs/STAGE_2_ATTESTATIONS_SPEC.md` |
| Stage 2 Real-Time / Live Portal build spec (the AECI-516 epic: **scoped client revalidation, not sockets** — ADR 0023 declined Durable-Object WebSockets and SSE, with a named re-open trigger; the read-only `GET /api/vendor/updates` per-scope freshness cursor [six SELECTs in one `db.batch`, **no audit row**, never entitlement-gated] and its "every cursor query reuses its handler's scoping predicate" invariant, the shared `VendorPortalStore` + `revalidate(scopes)`, the visibility-aware `VendorLiveSync` cadence [20 s focused / 60 s unfocused / paused hidden, 160 s backoff cap], optimistic **toggle** writes with visible rollback [forms stay pessimistic, deliberately], the live entitlement flip + session-scoped new-notification count, and the **one hoisted polite live region** [fed by the root `VendorPortalAnnouncer`, one per dashboard concept]; the build contract each AECI-516 sub-issue [626…632] anchors to — **all seven shipped 2026-08-19, every section carries an as-built subsection and §1.5 indexes the six divergences**; supersedes §2.3 + the third §8.2 open item of `STAGE_2_SPEC.md`, and corrects its §4(5) and §7 epic-table "Durable Objects". **No migration, no binding, no queue, no `Cache-Tag`.**) | `docs/STAGE_2_REALTIME_SPEC.md` |
| Stage 2 Product Docs / Help Center scope outline (the AECI-634 epic: reader-facing `/docs` **inside `apps/web`** — decided **not** a separate site/app/subdomain, with a re-open trigger; generalizes the legal-pages build-time-inlined-markdown pattern; tech stack, authoring technique [docs-as-code, the same-PR sync rule, no screenshots at v0], v0 site map; **kickoff draft — not yet a build contract**, vendor-guide content deferred until vendor-portal testing settles) | `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` |
| Connector lane (iPaaS reachability) — **the lane is split across all three repos, and almost none of it is here.** `docs/connector-vendors.md` in **`aec-integrations-review`** is the source of truth for tracked catalogues, stub/mapping state and the pair-page classifier. The **MindCloud call brief + outcome record** (AECI-703 / epic AECI-695) lives in **`aec-integrations-marketing`** at `docs/outreach/connector-lane-mindcloud-call.md` — the trade, the AECI-702 fence on what may be said, the questions, and the workstream-D decision table. **Current posture (2026-08-31): the call is deferred** — we scrape what we can get ourselves first, and an **incomplete coverage list is explicitly acceptable**, so workstream D is not blocked on a MindCloud feed. This repo holds the Stage 1.5 Addendum B slice (`products.product_role`, `integrations.powered_by_product_id`, the powered hub), the **Addendum C presentation contract** (§13, AECI-708 — the delivered/reachable/buildable vocabulary, the endpoint Integrations split, the role-varied connector template, the ten-site `integration_count` lockstep), the **commercial model** — `STAGE_2_SPEC.md` **§8.8** (AECI-702: the endpoint vendor pays; `hybrid` counts as endpoint; the connector surface is not invoiced) and **§8.9** (AECI-704: what a pure connector vendor gets instead is a catalogue-maintenance seat carried by **no `vendor_entitlements` row**, so the Verified badge never lights) with the operator claim-routing procedure in `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 — and — since **AECI-714** — the **connector-lane schema + sync**: six app-DB tables projecting the review model (`docs/DATABASE_SCHEMA.md` §9a) plus the paged `POST /api/promote/connector-catalog` (`docs/REVIEW_APP_PROMOTE_API.md` §3a) — and, since **AECI-720**, the **management cutoff**: `connector_catalogs.managed_by` is held *and* enforced here, so the promote arm refuses any page for a `vendor`-managed catalogue with `CATALOG_VENDOR_MANAGED`, the flag is **off the promote wire entirely**, and the only operator control is the audited `PATCH /api/admin/connector-catalogs/:id` (reversible — "one-way forever" governs the data direction, not the flag; it grants **no** seat, which stays AECI-722/724's). `connector_evidenced_pairs` is created **empty**; **AECI-721** fills it and owns every change to an existing table — split expand→contract: **PR-A (additive)** unions both tables across every read surface and all **fourteen** `integration_count` lockstep sites (§13.5's own list named ten), adds `integrator` to the enums + `MECHANISM_RANK` and to the AECI-705 attestation gate, and pins connector-evidenced pairs to `mechanism_rank` 4; **PR-B** is migration `0022_powerful_killraven.sql` (the `mechanism_kind` CHECK, the powered-edge move, the claims re-home) plus the promote-path routing that stops the migration undoing itself. Two things to know before touching either: the claim anchor is now **polymorphic** — `claims` carries two nullable FKs, an XOR CHECK and a STORED generated `anchor_id` (ADR 0018's 2026-08-31 amendment) — and `0022`'s **statement order is a data-loss control**, because the `integrations` → `claims` → `attestations` cascade is two levels deep and `PRAGMA defer_foreign_keys` does not defer cascade *actions*. Regenerating that file destroys 1,697 claims and 1,697 attestations — `src/test/migration-0022.spec.ts` is what catches it. `iPaaS` and `partner` both STAY in the enum — retiring them are sequenced follow-ups. And — since **AECI-722** — the **first reader**: `/admin/connectors` + `/admin/connectors/:id` over five admin `GET`s (`ADMIN_PANEL_SPEC.md` §5.9), which also discharged the remaining `relations()` deferral (the five non-evidenced tables; AECI-721 had already added the evidenced-pairs block) and carries the UI for AECI-720's `managed_by` flip. Triage there is **read-only** — the sync upserts mappings wholesale, so AECi-side authoring waits for AECI-724 gated on `managed_by = 'vendor'`. The *public* coverage surfaces (AECI-715 / 716) remain unbuilt, and still own the cache-tag decision, since `/admin/*` is uncacheable. **No data flows yet in any environment**: the review-side sender is AECI-731 and is unbuilt, so `apps/api/seed/connector-fixtures.sql` is what makes the screen renderable locally | `docs/STAGE_1_5_SPEC.md` §12 Addendum B (shipped) + **§13 Addendum C** (the contract for the unbuilt surfaces); brief + evidence in the sibling repos above |
| `data_object` controlled vocabulary (Stage 1.5; the frozen, closed list both apps seed from — slug/name/description/display_order/aliases) | `docs/DATA_OBJECT_VOCABULARY.md` (+ generated `docs/data-object-vocabulary.json` mirror) |
| `trade` controlled vocabulary — the **fourth taxonomy facet** ("what work does your company sell?", AECI-538 epic): the closed 34-term list, the trade-specific-value tagging rule, find-only promote resolution, and the publication gate | `docs/TRADES_VOCABULARY.md` (+ generated `docs/trades-vocabulary.json` mirror); facet behaviour in `docs/STAGE_1_SPEC.md` §5.5a |
| API endpoint shapes, validation, errors | `docs/API_CONTRACTS.md` |
| Review-app → app-DB promotion push — the **async** kick-off/poll/collect protocol (`POST /api/promote` → `202 { jobId }`, `GET /api/promote/jobs/:id`, payload/response, the two idempotency keys, integration rule) — **and, since AECI-714, the second arm** `POST /api/promote/connector-catalog` (§3a: paged connector-catalogue mirror, one page = one job, a *third* idempotency key in the review record id) | `docs/REVIEW_APP_PROMOTE_API.md` (design rationale: `docs/adr/0021-async-promote-ingest-via-workflows.md`) |
| Database schema and RLS hooks | `docs/DATABASE_SCHEMA.md` |
| Migration workflow (generating SQL via drizzle-kit, applying via `wrangler d1 migrations apply`) | `docs/migrations.md` (being rewritten for D1; the Supabase-CLI workflow is retired for the app DB) |
| Local dev tracing (agent-queryable OTel traces in `wrangler dev`: Local Explorer SQL endpoint, `spans`/`logs` schema, debugging recipes) | `docs/local-tracing.md` |
| Drizzle/D1 data layer (client, schema, `db.batch()` audit/workflow builders) | `apps/api/src/db/` + `apps/api/src/lib/{audit,drizzle-helpers,recompute-counts}.ts` (ADR 0016) |
| CI/CD, environments, deployment | `docs/CICD_PLAN.md` |
| Environment topology, promotion model, operator runbook (tiers, PR-preview lifecycle, bootstrap) | `docs/environments.md` |
| Cloudflare Access for non-prod environments (allowlist, service token rotation, lockout) | `docs/access.md` |
| Cloudflare WAF rate limits + scraper block on the public endpoints (rule expressions, thresholds, Pro-plan limits, verification) | `docs/waf-rate-limits.md` |
| Testing tools, coverage targets, patterns | `docs/TESTING_STRATEGY.md` |
| Writing unit tests | `docs/UNIT_TESTING_GUIDE.md` |
| Manual accessibility testing (repeatable VoiceOver/NVDA + keyboard-only screen-reader pass; the human layer beyond axe/Lighthouse CI) | `docs/a11y-manual-testing-checklist.md` |
| Reviewing code (pre-merge) | `docs/CODE_REVIEW_CHECKLIST.md` |
| Code-review exemptions (accepted/deferred findings, expiry rules) | `docs/CODE_REVIEW_EXEMPTIONS.md` |
| Edge caching: tag vocabulary, TTLs, invalidation, SEO headers | `docs/CACHE_STRATEGY.md` |
| Search ranking: Algolia index settings (searchable attrs, faceting), custom ranking signals, mechanism-kind priority, tie-breakers, post-launch tuning loop | `docs/SEARCH_RANKING.md` |
| Observability: custom metric catalog, dashboards + alerts — canonical for the live plane, which is **PostHog only** since AECI-651 | `docs/OBSERVABILITY.md` |
| Observability migration Datadog → PostHog (the AECI-639 epic: the dual-run transport fan-out, two-mode consent-aware browser init, the alert/liveness-sweep model, project topology, decommission gates; the build contract each AECI-639 sub-issue [640…651] anchored to). **Complete — AECI-651 removed the Datadog leg on the `stage-2` line**, so the spec is now a build record rather than an in-flight contract; `docs/OBSERVABILITY.md` is canonical for the live plane | `docs/POSTHOG_MIGRATION_SPEC.md` (rationale: `docs/adr/0024-observability-migrates-to-posthog.md`) |
| Analytics/marketing measurement baseline (AECI-326): PostHog + Datadog-RUM instrumentation status, starting-numbers snapshot, weekly read procedure. **Its "prod is dark, gated on secrets" state is stale** — corrected by the dated AECI-648 addendum inside the file (verified live 2026-08-24); the historical snapshot is deliberately left intact | `docs/ANALYTICS_BASELINE.md` |
| **Product** analytics — the event catalogue, naming + never-in-a-property rules, the consent-tier caveat on every number, the `search_performed → product_viewed → external_link_clicked` activation funnel, and the identify/vendor-group identity model (AECI-649; the product companion to `OBSERVABILITY.md`, which keeps the is-it-healthy half) | `docs/ANALYTICS.md` |
| Transactional email (Resend client, template catalogue, secrets) + the Supabase→Resend SMTP magic-link sender + deliverability (SPF/DKIM/DMARC) | `docs/email.md` |
| Incident runbooks for the live alerts — **PostHog** (hourly cadence; absence detection is the scheduled-CI liveness sweep, not a vendor feature). Also the only surviving record of the 26 retired Datadog monitors' thresholds, in its disposition table | `docs/RUNBOOKS.md` |
| Post-launch monitoring (AECI-279 / Phase 8.1): the daily/weekly operate-and-tune procedure over the shipped dashboards, monitors, and crons; the launch-tunable-threshold table; the triage→ticket loop | `docs/POST_LAUNCH_MONITORING.md` |
| Post-launch health-report log (AECI-279 / Phase 8.1): dated first-week/first-month snapshots fed by the monitoring runbook | `docs/POST_LAUNCH_HEALTH_REPORT.md` |
| Admin panel / operator console (traffic, audience, catalog, moderation, system health; the consent-independent read surface over `page_views` + a screen for the two cron digests) — **v1.0 build contract**; **Phase 8.3**, `main` line, epic AECI-572 integrates on the `admin-panel` branch | `docs/ADMIN_PANEL_SPEC.md` |
| Launch / DNS cutover runbook (go-live: apex flip off the coming-soon landing, launch-secret provisioning, waitlist broadcast, post-cutover verification, rollback) | `docs/launch-cutover-runbook.md` |
| Phase completion checkpoints (per-phase launch-readiness gates: AC + build-order mapping, punts) | `docs/PHASE_{2..8}_COMPLETION.md` (Phase 8 = the living post-launch checkpoint) |
| Auth model, GRANTs & RLS policies (3-layer authz: Worker JWT/role/ban, PostgREST GRANTs, RLS; GDPR erasure) | `docs/AUTH_AND_RLS.md` (complete — the authorization source of truth) |
| Strategic product / brand context (audiences, voice, anti-references, principles) | `PRODUCT.md` (repo root) |
| Visual design system (colors, typography, components, do's/don'ts) | `DESIGN.md` (repo root) — Stitch format, source of truth for tokens |
| Angular / TypeScript conventions (zoneless, signals, control flow, OnPush, SSR safety, file naming, lint rules) | `ANGULAR_STYLE_GUIDE.md` (repo root) |
| Brand book (palette, contrast, visual principles, DOCX export) | `docs/BRAND_GUIDELINES.md` |
| Logo construction spec (coordinates, geometry, type specs — companion to the brand book) | `branding/logo-construction.md` (repo root) |
| v0.dev → Angular design workflow (the loop: spec → prompt → iterate → port → review → ship) | `docs/design/workflow.md` |
| v0.dev → Angular porting rules + token map (the contract a port is reviewed against) | `docs/design/v0-porting-rules.md` |
| v0.dev account-level aesthetic directives / system prompt | `docs/design/v0-system-prompt.md` |
| Foundation stack validation (Phase 1 reference: Angular SSR + Workers + Spartan UI) | `docs/STACK_VALIDATION_TEST.md` |
| Architecture Decision Records — why key choices were made | `docs/adr/README.md` (index) |

If your work touches a topic governed by one of these documents, that document is the source of truth — not your prior knowledge or assumptions.

## Stack at a glance

- **Frontend:** Angular 21+ with SSR, zoneless change detection
- **Styling:** Tailwind CSS v4 + Spartan UI (brain primitives) + Angular CDK. New interactive/form-control patterns (select, combobox, listbox, radio, accordion, tabs, …) use Angular Aria (`@angular/aria`, stable in v22); Spartan stays for overlay primitives (Popover, Dialog). Two deviations to know: Aria@22 ships no `radio`/`select`, so combobox/listbox stand in; and discrete-choice Aria controls bridge into Signal Forms via `[(value)]`+`(valueChange)`, not `[formField]` (native inputs only). See `docs/adr/0010-angular-aria-alongside-spartan.md` (Accepted).
- **Hosting:** Cloudflare Workers (SSR Worker + private API Worker via service binding). SSR Worker runs with `compatibility_flags: ["nodejs_compat"]` for `@angular/ssr` runtime polyfills. The API Worker also runs a **Cloudflare Workflow** (`PromoteWorkflow`, one per env) carrying the promote ingest — ADR 0021.
- **Database:** Cloudflare D1 (SQLite) via Drizzle ORM (`drizzle-orm/d1`) over the API Worker's `DB` binding — no external proxy, no `nodejs_compat` for the DB path (ADR 0016). Supabase is retained for **Auth only**. The lead-capture tables (`feedback`/`mailing_list`) live in D1 (AECI-257), written by the API Worker's `POST /api/feedback` + `/api/subscribe`. Their original caller — the pre-launch coming-soon `apps/landing` Worker — was **retired at the apex cutover (AECI-247/277)**; the caller is now the shared mailing-list signup band (`apps/web/.../shared/mailing-list-signup`, the home closing-CTA plus the directory + detail pages, AECI-327), which POSTs through the SSR Worker's `/api/*` passthrough (trusted `LANDING_CF_HEADERS` geo). On a fresh signup (or a reactivation) `/api/subscribe` fires two fail-open sends: the operator "new signup" alert (to `ADMIN_ALERT_EMAIL`, replacing the landing Worker's own send) **and** the subscriber's `mailing-list-welcome` first-touch email (AECI-327); `/api/feedback` sends the operator "new feedback" alert. Unsubscribe (AECI-537): the welcome email carries a per-subscriber `unsubscribe_token`; its tokenized `/unsubscribe?token=…` link + RFC 8058 one-click header hit `POST /api/unsubscribe`, which **soft-deletes** the subscriber (`mailing_list.unsubscribed_at`, a suppression record). The `/unsubscribe` Angular page (`apps/web/.../unsubscribe`) confirms-then-POSTs (a GET never mutates); it is noindex + non-cacheable. A resubscribe reactivates (clears `unsubscribed_at`, re-welcomes).
- **Search:** Algolia + InstantSearch Angular
- **Auth:** Supabase Auth (magic link + Google OAuth)
- **Observability:** **PostHog only** (ADR 0024 / epic AECI-639). Logs, metrics, error tracking, web vitals and product analytics all land there. The AECI-639 dual-run ran PostHog beside Datadog to verify the swap against live traffic; **AECI-651 then deleted the Datadog leg** — both Worker adapters, `@datadog/browser-rum`, `observability/datadog/`, every `DD_*` var, and the CSP grants to the `browser-intake-*` hosts. **This landed on the `stage-2` line only; `main` (production) still runs the Datadog-only code** until the two are merged. Three facts worth knowing before touching observability: the Workers hold **no observability secret at all** (the publishable `phc_` `POSTHOG_PROJECT_KEY` is a committed per-env wrangler var, AECI-640); PostHog has **no `notify_no_data` equivalent**, so cron-absence detection is an external scheduled-CI liveness sweep (AECI-647); and **alerts evaluate hourly**, not every 5 minutes — the largest accepted degradation in the swap
- **Issue tracker:** Linear
- **i18n:** `@angular/localize` (en-US only at launch; architecture supports more)
- **Email:** Resend (transactional — `apps/api/src/lib/email.ts`, AECI-240) + Microsoft 365 (mailboxes). Supabase Auth magic links send over Resend custom SMTP. See `docs/email.md`. (Supersedes the former "Loops".)
- **Workflow automation:** Cloudflare Worker for the form→Linear request pipeline (n8n **dropped** — Phase 2 §18.1 / `docs/STAGE_1_PHASE_6_SPEC.md`). No Slack (Linear native email + admin-email-on-failure).
- **Theme:** light only in Stage 1 — no toggle, no system-preference detection (AECI-226; see "Light only (Stage 1)" below). The semantic tokens are defined in `docs/STAGE_1_SPEC.md` §2a and keep dark a token-block + toggle re-introduction in Stage 2.

## Constraints that aren't negotiable

These appear repeatedly in tasks and Claude Code may be tempted to violate them. Don't.

Several are now **enforced mechanically** rather than by recall — they fail `pnpm lint` (AECI-549), so violating one is a build failure, not a review comment. Those bullets are tagged `Lint: ✅`. The rule-to-constraint map, including which mechanism catches what and why some can only be caught by a line scanner rather than ESLint, is `ANGULAR_STYLE_GUIDE.md` §24.

- **Use Drizzle over the D1 binding (no Prisma in the Worker).** `Lint: ✅` — `no-restricted-imports` bans `@prisma/*`, `pg`, `postgres`, `@neondatabase/serverless`, and the Postgres Drizzle drivers; `no-restricted-syntax` bans the `getPrisma` / `PrismaClient` identifiers and the `DATABASE_URL` / `DIRECT_URL` vars. Tests included. Get a request-scoped client via `getDb(env)` (`apps/api/src/db/client.ts`), which wraps `drizzle(env.DB, { schema })`. Reads use the relational query builder (`db.query.<table>.findMany/findFirst`) or `db.select()`; the schema source of truth is `apps/api/src/db/schema.ts`, with read configs/mappers in `apps/api/src/lib/drizzle-helpers.ts`. **D1 has no interactive transactions** — atomic multi-statement writes go through `db.batch([...])` (ADR 0016 / AECI-249), and every state-changing write emits its `audit_log` (+ `workflow_transitions`) row into the SAME batch via the `apps/api/src/lib/audit.ts` builders (the §26.1 invariant). The §26.5 audit-log forwards run post-commit in `ctx.waitUntil` (to PostHog Logs through the injected forwarder seam under ADR 0024 — the §26.1 in-batch invariant was untouched by that swap). There is no `getPrisma`, no `@prisma/extension-accelerate`, no pg adapter on the Worker, and no Prisma in application code. Prisma is fully removed (AECI-278): no `@prisma/client`, no `prisma` CLI, no `apps/api/prisma/schema.prisma`, and no `DATABASE_URL` / `DIRECT_URL` / Accelerate anywhere. ADR 0016.
- **Promote is async — never commit on the request (ADR 0021 / AECI-563).** `POST /api/promote` (`apps/api/src/routes/promote-kickoff.ts`) validates, starts the `PROMOTE_WORKFLOW` Cloudflare Workflow, and returns `202 { jobId }`; the plan-then-batch ingest (`runPromoteIngest` in `routes/promote.ts`) runs inside **one non-retried `step.do`** and `GET /api/promote/jobs/:id` serves the ID map. Do not reintroduce a synchronous promote handler, and do not make the ingest depend on a Hono `Context` — it takes a narrow `PromoteRunCtx` (`env` / `waitUntil` / `request` / `bookmark`) precisely so it can run off-request. The commit step throws `NonRetryableError(message, code)`: never let it be auto-retried, or a half-planned create can replay as a duplicate product. **The caller-supplied `jobId` IS the Workflow instance id**, and since **AECI-571** it is also the primary key of a `promote_jobs` ledger row that `runPromoteIngest` writes as the **first statement of the same `db.batch`** — so a replayed step (Workflows are at-least-once) trips the PK, the whole batch rolls back, and the ingest returns the recorded `PromoteIngestResult` (identical ids, identical slug) instead of committing again. Never move that insert out of the batch, never add `ON CONFLICT DO NOTHING` to it, never compute `wrote` after pushing it, and never let an unreadable ledger row fall through to a re-plan — an unreadable ledger means the promote **already committed**. Post-commit hooks stay fire-and-forget and are dispatched from `run()` *after* the step, never inside it (which is why a replay must still be able to drive them from the ledger). **Upsert-by-`supabaseId` falls back to insert** when the supplied id no longer resolves (AECI-568) — the update branch must stay gated on the existence read, never on `Boolean(supabaseId)`, or a dead pointer becomes a no-op `UPDATE` reported as `updated` with an empty slug. Each fallback is reported via `aeci.api.promote.stale_id`; `scripts/ops/2026-08-promote-strand-audit/` is the read-only sweep that finds them offline. **Since AECI-714 the same Workflow binding carries a second job kind** — a connector-catalogue *page* (`POST /api/promote/connector-catalog`) — on a discriminated `PromoteWorkflowParams` union whose `kind` is **absent** for the product arm, so pre-AECI-714 instances still replay as product promotes; never make that field required. Everything above holds per page: single non-retried step, single `db.batch`, ledger row first. What does **not** hold is atomicity *across* pages — one ledger row protects one commit — so every statement the connector planner emits is an idempotent upsert keyed on the review app's own record id, which is also the app-DB primary key. A page re-sent with nothing changed must write nothing at all, including no `audit_log` row.
- **drizzle-kit + `wrangler d1` own migrations.** Edit `apps/api/src/db/schema.ts`, then `pnpm db:generate` (drizzle-kit writes `apps/api/migrations/*`), apply locally with `pnpm db:migrate:local` (`wrangler d1 migrations apply aeci-app-preview --local`), and seed with `pnpm db:seed:local`. `pnpm db:setup:local` does both, and `pnpm dev`/`dev:preview` run it before booting (so the local D1 is always migrated + seeded). The retired Supabase-CLI / `prisma migrate` / `prisma db pull` workflow no longer applies to the app DB. See `docs/migrations.md`.
- **Release every `fetch` response body you don't read, and batch fan-out (AECI-666).** `Lint: 🟡 review-only` — a Worker invocation may hold only ~6 connections waiting for response headers (`fetch`, KV, R2, Cache API, **Queues `send()`**, outbound WebSockets all count), and a `fetch` whose body is never consumed keeps holding one. Past the limit the runtime cancels the stalled responses to break the deadlock — and **a cancelled `fetch` returns a promise that never settles**, so the caller's own `catch` never fires, the work is lost with no log line, and the invocation is eventually killed as hung (`"your Worker's code had hung and would never generate a response"`), taking every other in-flight task with it. That is how the promote post-commit hooks silently dropped Algolia upserts and cache purges on ~8% of production promotes. AECI-651 **halved** the cost of every emission by retiring the second vendor — one `logToPosthog` call is now one connection, not two — but the budget is still a budget. Three rules: **(a)** call `discardResponseBody(res)` (`@aeci/shared/response-drain`) on every path that doesn't read the body — including error paths that only inspect `res.status`; **(b)** never fan out an unbounded `Promise.all` of `fetch` — if the upstream takes a batch, send one request (the §26.5 audit forwards go through `logBatchToPosthog`: N entries → one request); if it genuinely has no batch endpoint (Google Indexing, the GoTrue per-id/per-email lookups), run it through `mapWithConcurrency(items, WORKER_CONNECTION_LIMIT, fn)` from `@aeci/shared/concurrency`; **(c)** a Queue producer with more than one message uses `queue.sendBatch()`, not a `send()` per message. Batching beats bounding; bounding beats nothing. Fire-and-forget `waitUntil` work in the promote path additionally goes through `dispatchHook`, whose **20s** watchdog turns a wedged transport into a `console.warn` instead of a dead invocation — 20s and not 30s because `waitUntil` extends execution only *up to* 30s, so a 30s watchdog races teardown and its warning never lands. See ADR 0021's 2026-08-27 amendment.
- **`nodejs_compat` is for SSR, not for the DB.** The SSR Worker needs `compatibility_flags: ["nodejs_compat"]` because `@angular/ssr` reaches for Node polyfills at runtime. That flag is unrelated to database access — the API Worker reaches D1 through its native `DB` binding (Drizzle), no pg adapter, no Accelerate, no `nodejs_compat`. Validated pattern: `apps/web/wrangler.jsonc:43`.
- **Cloudflare plan is Pro.** `Cache-Tag` and purge-by-tag are available on **all plans as of April 2025** and are the AECi strategy from Phase 2 onward. Every cacheable SSR response sets `Cache-Tag` via the AECI-56 helper; invalidation is native `ctx.cache.purge()` — in-process for `POST /admin/purge`, and cross-Worker (promote / moderation / datatool) via the `aeci-cache-purge-{env}` Cloudflare Queue whose SSR consumer delegates into `Renderer`. `Vary: Accept-Language` is permitted because URL-prefix locale dispatch already handles actual variance; any other `Vary` value (`Cookie`, `User-Agent`, etc.) is still forbidden — those fragment the edge cache without a corresponding tag advantage. **The `Vary` half of this bullet is `Lint: ✅`** (AECI-549): `no-restricted-syntax` rejects `headers.set`/`append` and the object-literal form with any value other than `Accept-Language`, in shipped source. Test files are exempt because fixtures legitimately build a forbidden `Vary` to prove the middleware strips it. `Cache-Tag` emission itself stays review-only. **The SSR Worker uses native Cloudflare Workers Cache (`apps/web/wrangler.jsonc`; a HIT skips the Worker): WC-3 (AECI-317) enabled it on preview + staging and deleted the hand-rolled `caches.default` match/put; WC-4 (AECI-318) restored cache-key normalization (utm-strip / per-route allowlist / canonical order / multi-select CSV sort) as `cacheKeyFor()` behind a two-entrypoint gateway (`default`, cache off) → cached `Renderer` pair (per-env `exports` block; `ctx.exports` is default-on at the current compatibility date); WC-5 (AECI-319) moved cross-Worker invalidation onto a Cloudflare Queue whose SSR consumer delegates the purge into the `Renderer` entrypoint; WC-6 (AECI-320) migrated the SSR `POST /admin/purge` to in-process `ctx.cache.purge()`; WC-7 (AECI-321) routed datatool bulk purge through the same queue; WC-8 (AECI-322) baked the crawler `noindex` decision into the cached payload (a HIT can't leak an indexable non-prod page) and retired the cache-hit-rate monitor; and WC-10 (AECI-324) retired the HTTP `callCloudflarePurge` transport + pruned `CF_PURGE_API_TOKEN` (keep `CF_ZONE_ID` for the WAF poll). Native caching is live on preview + staging only — `demo`/`production` (and the temporary `stage2` tier, AECI-637) ship the same two-entrypoint code but currently run uncached (no `exports` block); enabling them is a deliberate future step.** Wrangler/Miniflare does not emulate the native front cache locally: local responses carry no `Cf-Cache-Status`/`Age`, and the exact `MISS → HIT` contract runs against each deployed PR preview (AECI-323). Tag emission, TTLs, and the `Vary` discipline are unchanged; WC-3 also added `stale-while-revalidate` / `stale-if-error` on detail/index routes. See `docs/CACHE_STRATEGY.md` for tag vocabulary, TTLs, the purge endpoint shape, and the SEO header set.
- **Zoneless Angular.** `Lint: ✅` — `no-restricted-imports` bans `zone.js`, `zone.js/*`, and the `NgZone` / `provideZoneChangeDetection` symbols from `@angular/core`, in every package including tests. No `zone.js`. Use `provideZonelessChangeDetection()`. Pair with `provideClientHydration(withHttpTransferCacheOptions({ includePostRequests: false }))` — Angular v22 incremental hydration is on by default and auto-enables event replay, so an explicit `withEventReplay()` is redundant (AECI-130). Validated pattern: `apps/web/src/app/app.config.ts:42-50`. See `ANGULAR_STYLE_GUIDE.md` for the full set of Angular and TypeScript conventions (signals, control flow, OnPush, SSR safety, host bindings, `NgOptimizedImage`, `inject()` DI, file naming) and the ESLint rules that enforce them.
- **Router scroll restoration.** `provideRouter` is configured with `withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' })` (`apps/web/src/app/app.config.ts:19-40`) so a navigation opens the new route at the top — SPA navigations are same-document, so without this the browser carries the previous page's scroll offset over — while Back/Forward restores the prior position. Because the router resets scroll via `window.scrollTo`, which honors the global `html { scroll-behavior: smooth }` rule, the browser-only `ScrollBehaviorManager` (`apps/web/src/app/core/scroll-behavior-manager.ts`, started from `App`) toggles `scroll-behavior: auto` for the span of each navigation so the reset is instant; native fragment anchors (section-nav, skip-link) never fire router events and keep animating smoothly. `withInMemoryScrolling` also sets `history.scrollRestoration = 'manual'`, which disables the browser's native "scroll to `#id` on load", and the router does **not** emit a `Scroll` event on the initial hydration navigation — so a reload or externally-shared deep link to a `…#section` URL would land at the top. `InitialFragmentScroller` (`apps/web/src/app/core/initial-fragment-scroller.ts`, also started from `App`) closes that gap: on the first `NavigationEnd` it scrolls to `location.hash` via `Element.scrollIntoView()` (which honors each detail section's `scroll-mt-20`).
- **Cached SSR routes must render visitor-state-neutral HTML.** The native Workers Cache is keyed by URL (path + query + Worker version), NOT cookies. If SSR reads a cookie (e.g., `theme`) and bakes it into the response, the first visitor poisons the cache for everyone. The Worker strips visitor-state cookies before forwarding to SSR for cacheable routes and keeps the API client cookie-free; the client reconciles after hydration. Validated pattern: `stripVisitorStateCookies` / `VISITOR_STATE_COOKIES` in `apps/web/src/server-runtime.ts`.
- **No pay-for-placement.** Search rankings are purely algorithmic. Paid vendor tiers (Stage 4+) affect profile richness, never ranking position.
- **i18n from day one.** `Lint: 🟡 review-only` — this one resisted mechanization. No hardcoded English strings in templates. Wrap everything in `i18n` attributes or `$localize` tags. Even though we launch English-only, retrofitting i18n is painful. AECI-549 evaluated `@angular-eslint/template/i18n` and rejected it: its attribute check produced 53 findings here and **zero** real ones (it flags `d`, `stroke-linecap`, `rel`, `inputmode`, `aria-labelledby`, …), because it is configured by denylist and the allowlist we would need is inexpressible. Don't re-propose it without new information; the reasoning is recorded in `ANGULAR_STYLE_GUIDE.md` §24.
- **Light only (Stage 1).** `Lint: ✅` — `no-restricted-syntax` catches `dark:` variants (including stacked `md:dark:`) and `.theme-dark` in `.ts`; `apps/web/scripts/check-source-constraints.mjs` catches them in external `.html` and `.css`, along with `@custom-variant dark`, `prefers-color-scheme: dark`, and `[data-theme=…]`. Two mechanisms because ESLint cannot read Tailwind class strings inside external templates, and nothing lints CSS here. AECi ships a single light theme — no theme toggle, no system-preference detection (AECI-226, supersedes the former "Both themes always" rule). Do not add `dark:` Tailwind variants, a `.theme-dark` block, or a theme toggle. Dark returns with the Stage 2 vendor portal; the semantic tokens (`--surface-*`/`--text-*`/`--accent-*`) keep it a token-block + toggle re-introduction.
- **Accessibility is built-in, not bolted on.** Spartan + Angular CDK give you a11y by default — don't break it. Run axe-core locally before pushing.

## Design checklist (UI-touching issues only)

For any issue that touches rendered UI in `apps/web/`, run this checklist before pushing. Issues that don't render UI (API, schema, infra, docs, CI, types) skip it.

`PRODUCT.md` (strategic context — users, brand, anti-references, principles) and `DESIGN.md` (visual system — colors, typography, components, do's/don'ts) are loaded by every Impeccable command before design work. If you're touching UI, both files are part of the contract.

1. **Critique the surface first.** Run `/impeccable critique <surface>` (or the standalone `/critique`) to capture a baseline against PRODUCT.md and DESIGN.md before you change anything. The output lands in `.impeccable/critique/` (gitignored).
2. **Pick the anchor reference before building.** If the surface is new or its visual direction is unsettled, consult Mobbin (`mcp__mobbin__*` — see §"MCP usage rules") and record the chosen anchor site in the Linear issue or commit message. From that point, components for this surface come from the *same* anchor site unless an exception is explicitly justified. Binding rule: `DESIGN.md` §"Named Rules" → "The Anchor-Site Rule".
3. **Build / refine via the matching skill.** For new features: `/impeccable craft <feature>`. For targeted refinement: `/impeccable typeset`, `/impeccable layout`, `/impeccable colorize`, `/impeccable distill`, `/impeccable normalize`. The shared design laws and the PRODUCT.md/DESIGN.md context are loaded automatically.
4. **Polish before submitting.** Run `/impeccable polish` for the final pass on spacing, alignment, micro-detail.
5. **Detect anti-patterns — scan the RENDERED SURFACE, not the file.** Run `npx impeccable detect <url>` against the running surface (`pnpm dev:agent`, then the route) and resolve every P0. If P0s remain, fix or open a follow-up issue with the exact references before merging. **A file-path scan does not work in this repo and reports a false clean:** `detect` does not read inline Angular templates, and almost every component here writes its template inline in the `.ts` file — so `detect apps/web/src/app/<dir>` typically returns zero findings *because it examined nothing*. Treat any past "detect clean" claim made from a file path as unverified.
6. **Light theme only.** Per the "Light only (Stage 1)" constraint above — there is one theme; do not add `dark:` variants or a toggle. (No dark-theme verification step in Stage 1.)
7. **Run a11y locally.** axe-core pass on the changed surface; resolve every error and `serious` violation before push.

## API contracts approach

Shared TypeScript types in `packages/shared/`, validated at runtime with Zod schemas. See `docs/API_CONTRACTS.md` §2.

- Type definitions and Zod schemas live in `packages/shared/src/api/`
- The SSR Worker imports types from `@aeci/shared`
- The API Worker validates incoming requests with Zod, throws `ApiError` on failure
- A centralized error middleware converts `ApiError` and `ZodError` to structured responses
- No OpenAPI generation. No code generation. Types and schemas are the contract.

## Build and dev workflow

```bash
# Install dependencies
pnpm install

# Run locally — boots the AECi app: SSR Worker (:8788) + private API Worker (:8787), bound.
# Alias for `pnpm dev:bound` (uses .dev.vars for secrets).
pnpm dev

# Type check across the monorepo
pnpm typecheck

# Lint and format
pnpm lint            # ESLint across all packages + Prettier --check
pnpm lint:fix        # ESLint --fix across all packages + Prettier --write
pnpm format          # Prettier --write .
pnpm format:check    # Prettier --check .

# Run tests
pnpm test            # unit + integration
pnpm test:unit       # Vitest only
pnpm test:e2e        # Playwright against local wrangler dev

# Build for deployment
pnpm build
```

Local secrets live in `.dev.vars` (per Worker package). Not committed. `.dev.vars.example` shows what's required.

### SSR ↔ API service binding in local dev

The SSR Worker calls the private API Worker over a service binding (`env.API`). In local dev, wrangler's cross-Worker registry resolves the binding only when both Workers are running **and** the API Worker's registered name matches the SSR Worker's `service` value. The bound name is `aeci-api-preview`, which is the API Worker's `env.preview.name` — so the API Worker must be started with `--env preview`.

```bash
# Boots API on :8787 (as aeci-api-preview) and SSR on :8788 in parallel.
pnpm dev:bound
```

`pnpm dev:bound` runs `pnpm -r --parallel --filter @aeci/api --filter @aeci/web run dev:preview`. Running only one of the two Workers leaves the binding unresolved and the SSR `/api/health` proxy will fail. The legacy single-Worker `pnpm dev:web` / `pnpm dev:api` scripts remain for solo-Worker iteration.

#### Parallel Conductor workspaces: `dev:conductor` vs `dev:agent`

Many Conductor workspaces run in parallel. Naively they collide two ways: on **ports** (`Address already in use` on `8788/8787`) **and** on wrangler's **local dev registry**, which is keyed by *worker name* (`aeci-web` / `aeci-api-preview`), not port. The registry clash is the nastier one — a second workspace registering the same names makes the first `wrangler dev` exit immediately, and pnpm `--parallel` then SIGTERMs its sibling (symptom: `web: Done` + `api: … signal "SIGTERM"`, no "Address already in use"). Both clashes are fixed:

- **Ports** — two scripts split the lanes:
  - **`pnpm dev:conductor`** — pins SSR `8788` / API `8787`, always (`scripts/dev-conductor.sh`), and **reclaims those ports** if a stale/previous session is holding them. This pair is **reserved for the human's primary workspace** (whose preview button/URL points at `localhost:8788`). Exactly one workspace should use this.
  - **`pnpm dev:agent`** — for every other (agent) workspace. Auto-scans for a free pair **starting at `8790/8789`** (`scripts/dev-launch.sh`), stepping up in twos, so it never touches the reserved conductor pair. Prints the URL it chose.
- **Registry** — `dev:bound` sets `WRANGLER_REGISTRY_PATH=$PWD/.wrangler/registry`, giving **each workspace its own isolated dev registry** (gitignored). Both Workers in a workspace share it (so the `env.API` service binding still resolves), but no two workspaces share names — so no cross-workspace SIGTERM and no binding cross-talk.
- **Freshness (stale `dist`)** — both `dev:conductor` and `dev:agent` **rebuild the web bundle and clear the local SSR cache** (`apps/web/.wrangler/state/v3/cache`, Cache-API only — no D1/KV) before booting. `dev:bound` runs each app's `dev:preview`, which serves a *prebuilt* `dist/` with **no build step** — and the legal/content `.md` files are inlined into that bundle at build time, so a stale `dist/` silently serves old content on launch. The rebuild makes every launch reflect current source; set `DEV_SKIP_BUILD=1` for a fast restart when the bundle is already current. (Bare `pnpm dev` / `pnpm dev:bound` skip this — they still serve whatever is in `dist/`.)

The port override is plumbed through `AECI_WEB_PORT` / `AECI_API_PORT` (honored by each app's `dev:preview` and by `playwright.config.ts`); both default to `8788/8787`, so direct `pnpm dev:bound`, CI, and e2e are unchanged (each gets its own registry too). **When you (an agent) need to boot the app in a workspace, use `pnpm dev:agent`, not `pnpm dev:conductor` / `pnpm dev` / `pnpm dev:bound`** — leave the constant pair for the human.

If launches start failing with the SIGTERM symptom, it's almost always **orphaned `workerd` processes** from a prior run that Conductor didn't clean up. Clear them: `lsof -nP -iTCP -sTCP:LISTEN | grep workerd` then `kill` the PIDs (or just re-run `dev:conductor`, which reclaims its own pair).

#### Local tracing — debug a 500 with SQL instead of `console.log` (AECI-548)

Wrangler (pinned `^4.123.0`) captures OpenTelemetry traces for every local Worker invocation — handler lifecycle, outbound `fetch()`, and **binding calls (D1, KV, R2, DO, Queues)** — with no SDK, no config, and no code change, and exposes them over a **read-only SQL endpoint**. So the debug loop for a local failure is *query the runtime*, not *add a log → rebuild → re-curl*. **`docs/local-tracing.md` is the source of truth** (schema, guardrails, recipes); the essentials:

- **Derive the URL from the port your session actually bound — never hardcode `8787`.** `dev:agent` scans up from `8790/8789`; `8788/8787` belong to the human's `dev:conductor`, so querying `8787` from an agent workspace reads *someone else's* dev server. Both Workers print their own hint on boot (`The Local Explorer API is available at http://localhost:8790/cdn-cgi/local/explorer/api`), and `scripts/dev-launch.sh` prints the pair on its first line. If the banner scrolled away: `lsof -nP -iTCP -sTCP:LISTEN | grep workerd`.
- **Two Workers ⇒ two trace stores, one per port.** `dev:bound` runs two separate `wrangler dev` processes, so a request crossing `env.API` produces **two traces with different `trace_id`s** — trace context does not propagate across the dev-registry hop. **All D1 spans live on the API store** (`:<API_PORT>`); the SSR store holds the browser-facing request, the WC-4 gateway→`Renderer` hop, and the outbound binding `fetch`. Correlate the halves on `url.full` + `start_ms` (recipe 6).
- **Failures are NOT in `spans.outcome`/`spans.error`.** A request that 500s on a D1 batch still records `outcome = 'ok'` on every span; the message is in the attributes as `error.type`. `WHERE outcome <> 'ok'` returns zero rows and looks like "no failures". Filter on `json_extract(json(attributes), '$."error.type"')` / `'$."http.response.status_code"'` — and note `attributes` is JSONB whose keys contain dots, so the path segment must be quoted.
- `db.batch()` spans carry every statement in `db.query.text` plus `db.operation.batch.size`, which makes the §26.1 audit-row-in-the-same-batch invariant directly checkable per request.
- Opt out with `X_LOCAL_OBSERVABILITY=false` (measured cost is ≈2 ms/request; you almost certainly don't need to).

```bash
API_PORT=8789   # ← the port YOUR session printed, not a copied constant
curl -sX POST "http://localhost:$API_PORT/cdn-cgi/local/explorer/api/local/observability/query" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT service, name, outcome, duration_ms FROM spans WHERE parent_id IS NULL LIMIT 20"}'
# → {"success":true,"result":{"columns":[...],"rows":[[...]]}}   rows are positional arrays
```

### Version reporting (AECI-74)

`apps/api` exposes `GET /api/version` returning `{ sha, deployedAt, environment }`. The SSR Worker proxies the same path via the existing `/api/*` service binding, so `GET /api/version` on `apps/web` reports the **API Worker's** values. The SSR Worker *also* serves its **own** `GET /_version` (`apps/web/src/server/routes/version.ts`, AECI-92) — same response shape, but **not proxied**, so it reports the **SSR Worker's** `COMMIT_SHA`. The two endpoints exist precisely because `/api/version` alone can't catch a stale SSR deploy (the SSR Worker forwards `/api/*` untouched to the API Worker). The deploy gates (`deploy.yml`, `promote-to-prod.yml`, `pr-preview.yml`, `refresh-staging.yml`) assert **both** equal the target commit via `scripts/verify-version.sh`.

`COMMIT_SHA` and `DEPLOYED_AT` are injected via `wrangler --var` and override the `"unknown"` / epoch placeholders declared in **each** Worker's `wrangler.jsonc` (`apps/api/wrangler.jsonc` and, per-env, `apps/web/wrangler.jsonc`). Both Workers' `dev` and `dev:preview` scripts derive them from `git rev-parse HEAD` and `date -u +%Y-%m-%dT%H:%M:%S.000Z`. **Any new `wrangler dev` / `wrangler deploy` invocation that targets *either* Worker must pass these flags** or that Worker's version endpoint will report `sha: "unknown"`:

```bash
wrangler deploy --env staging \
  --var COMMIT_SHA:"$GITHUB_SHA" \
  --var DEPLOYED_AT:"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```

CI wiring (resolving `$GITHUB_SHA` and the workflow timestamp) landed in AECI-71; the dual SSR+API SHA gate landed in AECI-92.

## Skills

Shared Claude Code skills live in `.agents/skills/`, checked into the repo so every contributor (and CI agents) get them automatically.

The skills checked in for the engineering build phase:

- **`spec-anchor`** — local skill that does two jobs (see "Where to start"). **Anchor:** fetches the Linear issue, resolves its `**Spec section:** §X.Y` line, loads that section and its companion docs. **Check (step 4.5, AECI-550):** once a plan exists, reviews the plan against that contract before any code is written, rating findings 🔴 CRITICAL / 🟡 MAJOR / 🔵 MINOR. Advisory, not blocking. Two rules make it usable rather than noisy: a **precedence chain** (`CLAUDE.md` constraints → ADRs → superseding spec → companion doc → `STAGE_1_SPEC.md` last) and **verify-before-flag** — every finding must cite a doc *and* a code artifact, so a stale doc yields an advisory MINOR instead of a false blocker. Issues with no `§X.Y` anchor use the n/a ladder. It is the pre-implementation half of `docs/CODE_REVIEW_CHECKLIST.md`.
- **`pbakaus/impeccable`** — design skill (single skill, 23 sub-commands: `craft`, `shape`, `teach`, `document`, `critique`, `audit`, `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`, `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`, `clarify`, `adapt`, `optimize`, `extract`, `live`). Lives at `.agents/skills/impeccable/`. Refresh with `npx impeccable skills update` or reinstall via `npx -y impeccable skills install --force`. Reads `PRODUCT.md` and `DESIGN.md` at the repo root.
- **`angular-developer`** — official Angular skill (`angular/skills`) that loads version-specific Angular best practices on demand (signals/reactivity, forms, DI, routing, SSR, ARIA, animations, styling, testing, CLI) from a bundled `references/` library. Auto-triggers when you create or modify Angular code in `apps/web/`. Pairs with the `angular-cli` MCP server (see "MCP usage rules"). Added in AECI-131.
- **`angular-new-app`** — official Angular skill (`angular/skills`) for scaffolding a new Angular app with the CLI. Rarely needed in this established monorepo, but kept for parity with the upstream set.

The two Angular skills are installed with `npx skills add https://github.com/angular/skills` — the same openskills CLI as `pnpm skills:update`. It writes the skill dirs under `.agents/skills/`, the `.claude/skills/` symlinks, and `skills-lock.json` entries (and must not re-hydrate the removed marketing bundle).

The **`coreyhaines31/marketingskills`** bundle (marketing / SEO / CRO / copywriting / analytics — ~39 skills, ~36k lines) was removed from the tree to keep the engineering repo lean and out of codebase search. Restore it when doing marketing work with `pnpm skills:update`. It installs under `.agents/skills/` (one dir per skill) and must never clobber `impeccable/` — if it ships a same-named skill, that's a bug.

Commit any changes under `.agents/skills/`.

## Git workflow

> **Post-launch branch model (2026-07-05, ADR 0019 / `docs/CICD_PLAN.md` §10).** Production is
> **live**, so `main` is the **production/stable line** and Stage 2 development happens on a
> **long-lived `stage-2` integration branch**. **Pick your base branch by the nature of the
> work:** production-destined work (**hotfixes** + prod-safe additive changes) branches from and
> merges to `main`; **Stage 2 work branches from and merges to `stage-2`**. `main` HEAD must stay
> always-promotable — staging auto-tracks it and it is the only source for a prod promote. Merge
> `main → stage-2` regularly (after every hotfix) to keep drift small; when Stage 2 ships, merge
> `stage-2 → main`. Applying a fix to live prod is the ordinary flow below, then promote by SHA
> (`promote-to-demo` → `promote-to-prod`; see `docs/environments.md`).

- Branch from `main` for production-destined work / hotfixes; branch from `stage-2` for Stage 2 work
- Branch naming: `aeci-{issue-number}-short-description` (use Linear's "Copy git branch name" action)
- Commit messages: descriptive; reference issue ID if helpful
- PR description includes `Closes AECI-{N}` for the primary issue; set the PR **base branch** to `main` or `stage-2` to match the work
- Wait for CI to pass: lint, typecheck, unit tests, build, preview deploy, E2E, accessibility, Lighthouse. **The PR suite is base-branch-agnostic** — it runs identically whether you target `main`, `stage-2`, or an epic branch (`deploy.yml` / `integration-db-tests.yml` carry no `branches:` filter on `pull_request`; Lighthouse stays push-to-`main`-only by design). `main` and `stage-2` are branch-protected on `Lint & typecheck` / `Unit tests` / `Build SSR Worker`, so a red one of those blocks the merge; E2E/a11y/Lighthouse still don't. **`admin-panel` has neither** — its PRs run no tests at all until the trigger fix is merged into that branch (`CICD_PLAN.md` §3.1/§8/§10).
- Squash merge to the base branch (`main` or `stage-2`)
- Linear auto-closes the issue on merge

## What's in scope for Stage 1

The build order in `docs/STAGE_1_SPEC.md` §16 has the canonical phase breakdown:

- Phase 1: Foundation
- Phase 2: Core data display
- Phase 3: Search & discovery
- Phase 4: Home page & stats
- Phase 5: Auth & reviews
- Phase 6: Requests & moderation
- Phase 7: SEO, accessibility, legal, polish
- Phase 8: Post-launch

If a Linear issue asks for something out-of-scope for Stage 1, flag it and propose deferring to Stage 2.

## What's NOT in scope for Stage 1

- Vendor portal / self-serve claiming (Stage 2)
- Paid features (Stage 2+)
- Rich media profiles (Stage 4)
- Trust scoring beyond basic anti-abuse (Stage 3)
- Real-time anything (Stage 2's answer is **scoped client revalidation** in the vendor portal — a polled freshness cursor, **not** WebSockets/SSE; ADR 0023 / `docs/STAGE_2_REALTIME_SPEC.md`)

## When the spec is wrong

If you discover the spec contradicts itself, contradicts reality, or doesn't cover a real requirement:

1. Don't silently work around it
2. Don't invent an approach
3. Raise it as a Linear issue or comment on your current issue
4. Wait for direction before proceeding

The spec is the contract. Maintaining its integrity matters more than shipping the current task.

## Audit logging and the observability forward

Every write that changes **domain state** must emit its `audit_log` row in the SAME atomic `db.batch([...])` as the mutation (the `auditInsert`/`workflowTransitionInsert` builders in `apps/api/src/lib/audit.ts`), then forward it post-commit via `ctx.waitUntil(forwardAuditLog(...))`. See `docs/STAGE_1_SPEC.md` §26. Failure to log is a transactional failure (the batch rolls back).

**The forward target moved, the invariant did not.** Under ADR 0024 the post-commit forward moved from **Datadog** to **PostHog Logs** through the injected-forwarder seam in `packages/shared/src/audit-log.ts` — a wiring change at the injection site, not a change to the audit path. AECI-651 removed the Datadog leg entirely. What never changes: the row goes in the **same batch**, the forward is **post-commit only**, it rides `ctx.waitUntil`, and a forwarding failure must warn and swallow rather than throw.

**Scope (ADR 0022).** Domain state = catalog, users/profiles, reviews/moderation, claims/attestations, requests/workflows. **Derived and log-class writes are exempt** — `page_views`, `mailing_list`, `feedback`, `stats_cache`, the Algolia watermark, `recompute-counts`, and the cron-written `metrics_daily`/`job_runs`; they are observable via `job_runs` + the emitted metrics instead (the exemption is vendor-independent). The test is **entity class, not actor class**: a cron or `actorType: 'system'` write that touches domain state still audits (`POST /api/promote` is the canonical example). **Scheduled `DELETE`s are never exempt** — one summary row per run (`action='retention.pruned'`).

## Cache invalidation

Every cacheable SSR response sets a `Cache-Tag` header via the AECI-56 helper (`apps/web/src/server/cache-tags.ts`). Writes that affect cached pages purge by Cache-Tag: API/datatool producers enqueue a typed purge message onto the tier's Cloudflare Queue (for promote, from the Workflow's post-commit hooks rather than the request — ADR 0021), and the SSR consumer delegates `ctx.cache.purge()` into the cached `Renderer` entrypoint (WC-5 / AECI-319). The SSR Worker's `POST /admin/purge` (the manual/incident + CI surface) already runs inside `Renderer` and purges in-process (WC-6 / AECI-320). Tests for write paths assert the queued directive; consumer tests assert the `Renderer.purgeCache()` call plus ack/retry behavior. Tag vocabulary, TTLs, composition rules, and the helper signature live in `docs/CACHE_STRATEGY.md`. The `invalidateForEntity()` / URL-invalidation-map approach in `docs/STAGE_1_SPEC.md` §9.3 is superseded.

## MCP usage rules

**Angular CLI MCP (`angular-cli`):** wired via the repo-root `.mcp.json` and pre-approved through `enabledMcpjsonServers` in `.claude/settings.json` (AECI-131), so it connects automatically. It runs the workspace's Angular v22 CLI **from `apps/web`** — `sh -c 'cd "$CLAUDE_PROJECT_DIR/apps/web" && exec npx -y @angular/cli mcp -E all'` — because `@angular/cli` is a dependency of `apps/web`, not the repo root, so `ng` only resolves there. It registers the stable read tools (`get_best_practices`, `search_documentation`, `list_projects`, `onpush_zoneless_migration`, `ai_tutor`) **plus** the experimental `run_target` (build / test / lint / e2e) and `devserver.start` / `devserver.stop` / `devserver.wait_for_build` tools. The experimental tools can build and serve `apps/web`, so invoke them deliberately.
- Before writing, modifying, or analyzing any Angular code, call `get_best_practices` once per session.
- For any Angular API question (signals, control flow, forms, router, SSR, zoneless), call `search_documentation` before answering from training data.
- Use `list_projects` to orient before generating files in the workspace — it discovers `apps/web/angular.json`; pass that workspace `path` to `run_target` and the devserver tools.
- The companion `angular-developer` skill (see "Skills") loads version-specific best-practice references on demand; prefer it over training-data recall for Angular patterns.

**Linear MCP (`linear`):** wired via the repo-root `.mcp.json` (remote HTTP, `https://mcp.linear.app/mcp`) and pre-approved in `enabledMcpjsonServers`, so it connects automatically. Auth is `Authorization: Bearer ${LINEAR_API_KEY}`; the token is injected from the Conductor keychain (`.conductor/settings.local.toml` → `[environment_variables]`), never committed. Tools cover issues (`list_issues`, `get_issue`, `save_issue`, `list_issue_statuses`, `list_issue_labels`), comments (`list_comments`, `save_comment`), projects, cycles, documents, and releases.
- The team prefix is `AECI`. This is the server the **`spec-anchor` skill** uses to fetch an issue and read its `**Spec section:** §X.Y` line — that skill assumes this MCP is connected.
- **Keep the tracker current without asking.** Linear is the agent's working surface as much as the operator's, so the default is to write: file issues for work you discover, assign to `chrisw@thewbsproject.com`, move status to match reality (In Progress at workspace start, In Review / Done as the PR moves), and comment your findings on an issue you're working — verification results, blockers, deferred scope. Don't stop to confirm any of that; a stale tracker costs more than an unnecessary comment. **Confirm first only when the write lands on someone else's work or destroys context:** editing or reassigning an issue another person owns, closing an issue you didn't do the work for, deleting comments, or restructuring projects/cycles.

**AECi review-app MCP (`aeci-review`):** wired via the repo-root `.mcp.json` (remote HTTP, `https://review.aecintegrations.com/mcp`) and pre-approved in `enabledMcpjsonServers`. Auth is `Authorization: Bearer ${AECI_MCP_TOKEN}`, also injected from the Conductor keychain.
- What it is: the **curation/review application** upstream of this repo — the system described in `docs/REVIEW_APP_PROMOTE_API.md` that pushes promoted products into the AECi API via `POST /api/promote`. It exposes the curation catalog: vendors, products, integrations, claims/attestations, and taxonomy.
- When to use: to inspect real production catalog shape when building or debugging a surface that renders it — `list_products` / `get_product` / `find_product`, `list_vendors` / `get_vendor`, `list_integrations` / `get_integration`, `list_claims` / `get_claim`, `list_taxonomy`, and the scoring/demand tools (`compute_product_score`, `compute_vendor_score`, `compute_product_search_demand`, `compute_product_reddit_mentions`). Prefer it over inventing fixture data when you need to know what the real records look like.
- **Treat the write tools as production actions.** `create_*`, `update_*`, `add_attestation`, and especially `promote_product` mutate the live curation database — and `promote_product` pushes rows into the live AECi database and purges edge cache. Never call them to "try something out"; confirm with the user first. Default to the read tools.

**Mobbin MCP (`mobbin`):**
- What it is: a visual reference library of real shipping apps — flows, screens, and component patterns sourced from production iOS, Android, and web products.
- When to use: any UI-touching issue. During `/impeccable shape` (or equivalent) to pick the named anchor reference(s) for a surface; during `/impeccable craft` or component-level work to look up patterns *from the same anchor site* already chosen for that surface.
- Auth: surfaced tools are `mcp__mobbin__authenticate` and `mcp__mobbin__complete_authentication`. Call `authenticate` first, then `complete_authentication`; additional Mobbin tools become callable in the same session after auth completes.
- **The anchor-site rule.** Once a surface picks a Mobbin site as its theme, additional components for that surface come from the *same* Mobbin site. Pulling components from a second site is a deliberate exception, not a default — the originating theme site stays the visual anchor (composition, hierarchy, density, atmosphere). This protects editorial coherence: AECi should read as one publication, not a mashup. See `DESIGN.md` §"Named Rules" → "The Anchor-Site Rule" for the binding rule.

## Closing notes

This file evolves. If a recurring instruction keeps coming up in code reviews, add it here. If a constraint is outdated, remove it. PR like any other doc change.

Last updated: see git log.
