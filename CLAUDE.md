# AEC Integrations — Claude Code Instructions

This file tells Claude Code how to work in this repo. Read this before starting any task.

## What this project is

**AEC Integrations (AECi)** is a directory and review platform for software integrations in the Architecture, Engineering, and Construction industry. The product is built around dual-vendor-verified integration reviews, AEC-native taxonomy, trust-first positioning (no pay-for-placement), and dual reviews separating product quality from onboarding experience.

The site is currently in pre-launch. Production data lives in Airtable; Supabase is being built out for Stage 1.

## Where to start

`docs/STAGE_1_SPEC.md` is the master spec and the contract — but it's 1,600+ lines. **Don't read it end-to-end; load only the section that governs your task.**

1. For any AECI-* task, **invoke the `spec-anchor` skill.** It fetches the Linear issue, parses its `**Spec section:** §X.Y` line, loads just that section from `docs/STAGE_1_SPEC.md`, and follows the cross-references into the companion docs (`docs/API_CONTRACTS.md`, `docs/DATABASE_SCHEMA.md`, etc.). (The `§X.Y` convention is enforced by the team Linear issue templates — Linear has no custom-field feature on our plan.)
2. If you're not working from an AECI issue, jump straight to the governing doc via the source-of-truth table below. The spec's first section ("Companion Documents") is the full index of what lives where.
3. If the spec is ambiguous or wrong, raise it — don't guess

## Documents that are source of truth

| Topic | Source of truth |
|---|---|
| What we're building and why | `docs/STAGE_1_SPEC.md` |
| Phase 2 scope and spec (supersedes §16 Phase 2 of the Stage 1 spec) | `docs/STAGE_1_PHASE_2_SPEC.md` |
| API endpoint shapes, validation, errors | `docs/API_CONTRACTS.md` |
| Review-app → Supabase promotion push (`POST /api/promote` payload/response, idempotency, integration rule) | `docs/REVIEW_APP_PROMOTE_API.md` |
| Database schema and RLS hooks | `docs/DATABASE_SCHEMA.md` |
| Migration workflow (writing / applying SQL via Supabase CLI) | `docs/migrations.md` |
| Prisma-as-query-builder contract (Accelerate, `generate`/`db pull` only) | `docs/prisma.md` |
| CI/CD, environments, deployment | `docs/CICD_PLAN.md` |
| Environment topology, promotion model, operator runbook (tiers, PR-preview lifecycle, bootstrap) | `docs/environments.md` |
| Cloudflare Access for non-prod environments (allowlist, service token rotation, lockout) | `docs/access.md` |
| Testing tools, coverage targets, patterns | `docs/TESTING_STRATEGY.md` |
| Writing unit tests | `docs/UNIT_TESTING_GUIDE.md` |
| Reviewing code (pre-merge) | `docs/CODE_REVIEW_CHECKLIST.md` |
| Code-review exemptions (accepted/deferred findings, expiry rules) | `docs/CODE_REVIEW_EXEMPTIONS.md` |
| Edge caching: tag vocabulary, TTLs, invalidation, SEO headers | `docs/CACHE_STRATEGY.md` |
| Observability: custom metric catalog, Datadog dashboard + monitors | `docs/OBSERVABILITY.md` |
| Incident runbooks for Datadog alerts | `docs/RUNBOOKS.md` |
| Auth model and RLS policies | `docs/AUTH_AND_RLS.md` (placeholder — defer to spec until completed) |
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
- **Styling:** Tailwind CSS v4 + Spartan UI (brain primitives) + Angular CDK
- **Hosting:** Cloudflare Workers (SSR Worker + private API Worker via service binding). SSR Worker runs with `compatibility_flags: ["nodejs_compat"]` for `@angular/ssr` runtime polyfills.
- **Database:** Supabase (PostgreSQL) + Prisma with `@prisma/extension-accelerate` (HTTPS-based; no TCP pooler required for DB access from Workers — Accelerate is independent of `nodejs_compat`)
- **Search:** Algolia + InstantSearch Angular
- **Auth:** Supabase Auth (magic link + Google OAuth)
- **Observability:** Datadog (RUM + APM + logs) and PostHog (product analytics)
- **Issue tracker:** Linear
- **i18n:** `@angular/localize` (en-US only at launch; architecture supports more)
- **Email:** Loops
- **Workflow automation:** n8n with native Linear node
- **Theme:** light/dark with system preference detection (tokens defined in `docs/STAGE_1_SPEC.md` §2a)

## Constraints that aren't negotiable

These appear repeatedly in tasks and Claude Code may be tempted to violate them. Don't.

- **Use Prisma Accelerate.** Instantiate `PrismaClient` from `@prisma/client/edge` and apply `withAccelerate()` per request. `DATABASE_URL` is the `prisma://` Accelerate URL (Worker runtime). `DIRECT_URL` is the Supabase pooler URL, used **only** by the Supabase CLI for migrations — never by Worker runtime code. Do NOT install `@prisma/adapter-pg-worker` and do NOT route Prisma through a TCP pooler from a Worker — Accelerate is HTTPS and works without `nodejs_compat` for the DB path. Validated pattern: `apps/api/src/prisma.ts:8-11`. Details in `docs/DATABASE_SCHEMA.md` §1a.
- **Supabase CLI owns migrations.** SQL migration files live in `supabase/migrations/`, generated via `pnpm db:new <name>` and applied via `pnpm db:reset` (local) or `pnpm db:push` (linked remote). Prisma is invoked **only** for `prisma generate` (typed client) and `prisma db pull` (refreshing `schema.prisma` from the local DB); `prisma migrate dev/deploy/reset/resolve` is never used. After applying a migration locally, run `pnpm db:pull` to update `apps/api/prisma/schema.prisma` and regenerate the client in one step. Do not reintroduce `apps/api/prisma/migrations/` or any `prisma migrate` script. See `docs/migrations.md` for the migration workflow and `docs/prisma.md` for the Prisma-as-query-builder contract.
- **`nodejs_compat` is for SSR, not for the DB.** The SSR Worker needs `compatibility_flags: ["nodejs_compat"]` because `@angular/ssr` reaches for Node polyfills at runtime. That flag is unrelated to database access — Prisma still goes via Accelerate (HTTPS), never via a pg adapter. Validated pattern: `apps/web/wrangler.jsonc:43`.
- **Cloudflare plan is Pro.** `Cache-Tag` and purge-by-tag are available on **all plans as of April 2025** and are the AECi strategy from Phase 2 onward. Every cacheable SSR response sets `Cache-Tag` via the AECI-56 helper; invalidation goes through `POST /admin/purge` with a tag list. `Vary: Accept-Language` is permitted because URL-prefix locale dispatch already handles actual variance; any other `Vary` value (`Cookie`, `User-Agent`, etc.) is still forbidden — those fragment the edge cache without a corresponding tag advantage. See `docs/CACHE_STRATEGY.md` for tag vocabulary, TTLs, the purge endpoint shape, and the SEO header set.
- **Zoneless Angular.** No `zone.js`. Use `provideZonelessChangeDetection()`. Pair with `provideClientHydration(withEventReplay(), withHttpTransferCacheOptions({ includePostRequests: false }))`. Validated pattern: `apps/web/src/app/app.config.ts:17-29`. See `ANGULAR_STYLE_GUIDE.md` for the full set of Angular and TypeScript conventions (signals, control flow, OnPush, SSR safety, host bindings, `NgOptimizedImage`, `inject()` DI, file naming) and the ESLint rules that enforce them.
- **Cached SSR routes must render visitor-state-neutral HTML.** Edge cache is keyed by URL. If SSR reads a cookie (e.g., `theme`) and bakes it into the response, the first visitor poisons the cache for everyone. The Worker strips visitor-state cookies before forwarding to SSR for cacheable routes; the client reconciles after hydration. Validated pattern: `apps/web/src/server-runtime.ts:131-153`.
- **No pay-for-placement.** Search rankings are purely algorithmic. Paid vendor tiers (Stage 4+) affect profile richness, never ranking position.
- **i18n from day one.** No hardcoded English strings in templates. Wrap everything in `i18n` attributes or `$localize` tags. Even though we launch English-only, retrofitting i18n is painful.
- **Both themes always.** Every component must render correctly in light and dark themes. Verify both before submitting.
- **Accessibility is built-in, not bolted on.** Spartan + Angular CDK give you a11y by default — don't break it. Run axe-core locally before pushing.

## Design checklist (UI-touching issues only)

For any issue that touches rendered UI in `apps/web/`, run this checklist before pushing. Issues that don't render UI (API, schema, infra, docs, CI, types) skip it.

`PRODUCT.md` (strategic context — users, brand, anti-references, principles) and `DESIGN.md` (visual system — colors, typography, components, do's/don'ts) are loaded by every Impeccable command before design work. If you're touching UI, both files are part of the contract.

1. **Critique the surface first.** Run `/impeccable critique <surface>` (or the standalone `/critique`) to capture a baseline against PRODUCT.md and DESIGN.md before you change anything. The output lands in `.impeccable/critique/` (gitignored).
2. **Pick the anchor reference before building.** If the surface is new or its visual direction is unsettled, consult Mobbin (`mcp__mobbin__*` — see §"MCP usage rules") and record the chosen anchor site in the Linear issue or commit message. From that point, components for this surface come from the *same* anchor site unless an exception is explicitly justified. Binding rule: `DESIGN.md` §"Named Rules" → "The Anchor-Site Rule".
3. **Build / refine via the matching skill.** For new features: `/impeccable craft <feature>`. For targeted refinement: `/impeccable typeset`, `/impeccable layout`, `/impeccable colorize`, `/impeccable distill`, `/impeccable normalize`. The shared design laws and the PRODUCT.md/DESIGN.md context are loaded automatically.
4. **Polish before submitting.** Run `/impeccable polish` for the final pass on spacing, alignment, micro-detail.
5. **Detect anti-patterns.** `npx impeccable detect <file-or-dir>` must report zero P0 findings. If P0s remain, fix or open a follow-up issue with the exact line references before merging.
6. **Verify both themes.** Per the "Both themes always" constraint above. The theme switcher (`apps/web/src/app/theme.service.ts`) toggles `.theme-dark` on `<html>` — render in each.
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
# Alias for `pnpm dev:bound` (uses .dev.vars for secrets). The legacy landing page is `pnpm dev:landing`.
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

Four skills are checked in for the engineering build phase:

- **`spec-anchor`** — local skill that anchors AECI-* work to the relevant `docs/STAGE_1_SPEC.md` section (see "Where to start").
- **`pbakaus/impeccable`** — design skill (single skill, 23 sub-commands: `craft`, `shape`, `teach`, `document`, `critique`, `audit`, `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`, `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`, `clarify`, `adapt`, `optimize`, `extract`, `live`). Lives at `.agents/skills/impeccable/`. Refresh with `npx impeccable skills update` or reinstall via `npx -y impeccable skills install --force`. Reads `PRODUCT.md` and `DESIGN.md` at the repo root.
- **`angular-developer`** — official Angular skill (`angular/skills`) that loads version-specific Angular best practices on demand (signals/reactivity, forms, DI, routing, SSR, ARIA, animations, styling, testing, CLI) from a bundled `references/` library. Auto-triggers when you create or modify Angular code in `apps/web/`. Pairs with the `angular-cli` MCP server (see "MCP usage rules"). Added in AECI-131.
- **`angular-new-app`** — official Angular skill (`angular/skills`) for scaffolding a new Angular app with the CLI. Rarely needed in this established monorepo, but kept for parity with the upstream set.

The two Angular skills are installed with `npx skills add https://github.com/angular/skills` — the same openskills CLI as `pnpm skills:update`. It writes the skill dirs under `.agents/skills/`, the `.claude/skills/` symlinks, and `skills-lock.json` entries (and must not re-hydrate the removed marketing bundle).

The **`coreyhaines31/marketingskills`** bundle (marketing / SEO / CRO / copywriting / analytics — ~39 skills, ~36k lines) was removed from the tree to keep the engineering repo lean and out of codebase search. Restore it when doing marketing work with `pnpm skills:update`. It installs under `.agents/skills/` (one dir per skill) and must never clobber `impeccable/` — if it ships a same-named skill, that's a bug.

Commit any changes under `.agents/skills/`.

## Git workflow

- Branch from `main`
- Branch naming: `aeci-{issue-number}-short-description` (use Linear's "Copy git branch name" action)
- Commit messages: descriptive; reference issue ID if helpful
- PR description includes `Closes AECI-{N}` for the primary issue
- Wait for CI to pass: lint, typecheck, unit tests, build, preview deploy, E2E, accessibility, Lighthouse
- Squash merge to `main`
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
- Real-time anything (Stage 2 considers WebSockets/SSE for vendor portal)

## When the spec is wrong

If you discover the spec contradicts itself, contradicts reality, or doesn't cover a real requirement:

1. Don't silently work around it
2. Don't invent an approach
3. Raise it as a Linear issue or comment on your current issue
4. Wait for direction before proceeding

The spec is the contract. Maintaining its integrity matters more than shipping the current task.

## Datadog and audit logging

Every state-changing write must call `appendAuditLog()` which also forwards to Datadog. See `docs/STAGE_1_SPEC.md` §26. Failure to log is a transactional failure.

## Cache invalidation

Every cacheable SSR response sets a `Cache-Tag` header via the AECI-56 helper (`apps/web/src/server/cache-tags.ts`). Writes that affect cached pages call `POST /admin/purge` with the relevant tag list. Tag vocabulary, TTLs, composition rules, and the helper signature live in `docs/CACHE_STRATEGY.md`. The `invalidateForEntity()` / URL-invalidation-map approach in `docs/STAGE_1_SPEC.md` §9.3 is superseded.

## MCP usage rules

**Angular CLI MCP (`angular-cli`):** wired via the repo-root `.mcp.json` and pre-approved through `enabledMcpjsonServers` in `.claude/settings.json` (AECI-131), so it connects automatically. It runs the workspace's Angular v22 CLI **from `apps/web`** — `sh -c 'cd "$CLAUDE_PROJECT_DIR/apps/web" && exec npx -y @angular/cli mcp -E all'` — because `@angular/cli` is a dependency of `apps/web`, not the repo root, so `ng` only resolves there. It registers the stable read tools (`get_best_practices`, `search_documentation`, `list_projects`, `onpush_zoneless_migration`, `ai_tutor`) **plus** the experimental `run_target` (build / test / lint / e2e) and `devserver.start` / `devserver.stop` / `devserver.wait_for_build` tools. The experimental tools can build and serve `apps/web`, so invoke them deliberately.
- Before writing, modifying, or analyzing any Angular code, call `get_best_practices` once per session.
- For any Angular API question (signals, control flow, forms, router, SSR, zoneless), call `search_documentation` before answering from training data.
- Use `list_projects` to orient before generating files in the workspace — it discovers `apps/web/angular.json`; pass that workspace `path` to `run_target` and the devserver tools.
- The companion `angular-developer` skill (see "Skills") loads version-specific best-practice references on demand; prefer it over training-data recall for Angular patterns.

**Mobbin MCP (`mobbin`):**
- What it is: a visual reference library of real shipping apps — flows, screens, and component patterns sourced from production iOS, Android, and web products.
- When to use: any UI-touching issue. During `/impeccable shape` (or equivalent) to pick the named anchor reference(s) for a surface; during `/impeccable craft` or component-level work to look up patterns *from the same anchor site* already chosen for that surface.
- Auth: surfaced tools are `mcp__mobbin__authenticate` and `mcp__mobbin__complete_authentication`. Call `authenticate` first, then `complete_authentication`; additional Mobbin tools become callable in the same session after auth completes.
- **The anchor-site rule.** Once a surface picks a Mobbin site as its theme, additional components for that surface come from the *same* Mobbin site. Pulling components from a second site is a deliberate exception, not a default — the originating theme site stays the visual anchor (composition, hierarchy, density, atmosphere). This protects editorial coherence: AECi should read as one publication, not a mashup. See `DESIGN.md` §"Named Rules" → "The Anchor-Site Rule" for the binding rule.

## Closing notes

This file evolves. If a recurring instruction keeps coming up in code reviews, add it here. If a constraint is outdated, remove it. PR like any other doc change.

Last updated: see git log.