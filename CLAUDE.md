# AEC Integrations — Claude Code Instructions

This file tells Claude Code how to work in this repo. Read this before starting any task.

## What this project is

**AEC Integrations (AECi)** is a directory and review platform for software integrations in the Architecture, Engineering, and Construction industry. The product is built around dual-vendor-verified integration reviews, AEC-native taxonomy, trust-first positioning (no pay-for-placement), and dual reviews separating product quality from onboarding experience.

The site is currently in pre-launch. Production data lives in Airtable; Supabase is being built out for Stage 1.

## Where to start

**Always read `docs/STAGE_1_SPEC.md` first.** It is the master spec and references every other document. The first section ("Companion Documents") is an index of what lives where.

For any task:

1. Find the relevant section of `docs/STAGE_1_SPEC.md`
2. Follow the cross-references to companion documents (`docs/API_CONTRACTS.md`, `docs/DATABASE_SCHEMA.md`, etc.)
3. The Linear issue you're working on opens its description with `**Spec section:** §X.Y` pointing to the governing section (Linear has no custom-field feature on our plan; this is the convention enforced by the team issue templates `Build Issue Template`, `Bug Template`, `Vendor Claim Template`, `Correction Request Template`)
4. If the spec is ambiguous or wrong, raise it — don't guess

## Documents that are source of truth

| Topic | Source of truth |
|---|---|
| What we're building and why | `docs/STAGE_1_SPEC.md` |
| API endpoint shapes, validation, errors | `docs/API_CONTRACTS.md` |
| Database schema, migrations, RLS hooks | `docs/DATABASE_SCHEMA.md` |
| CI/CD, environments, deployment | `docs/CICD_PLAN.md` |
| Testing tools, coverage targets, patterns | `docs/TESTING_STRATEGY.md` |
| Writing unit tests | `docs/UNIT_TESTING_GUIDE.md` |
| Reviewing code (pre-merge) | `docs/CODE_REVIEW_CHECKLIST.md` |
| Auth model and RLS policies | `docs/AUTH_AND_RLS.md` (placeholder — defer to spec until completed) |
| Strategic product / brand context (audiences, voice, anti-references, principles) | `PRODUCT.md` (repo root) |
| Visual design system (colors, typography, components, do's/don'ts) | `DESIGN.md` (repo root) — Stitch format, source of truth for tokens |
| Angular / TypeScript conventions (zoneless, signals, control flow, OnPush, SSR safety, file naming, lint rules) | `ANGULAR_STYLE_GUIDE.md` (repo root) |
| Brand book (palette, contrast, visual principles, DOCX export) | `docs/BRAND_GUIDELINES.md` |

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

- **Use Prisma Accelerate.** Instantiate `PrismaClient` from `@prisma/client/edge` and apply `withAccelerate()` per request. `DATABASE_URL` is the `prisma://` Accelerate URL (Worker runtime). `DIRECT_URL` is the Supabase pooler URL, used **only** by the Prisma CLI for migrations — never by Worker runtime code. Do NOT install `@prisma/adapter-pg-worker` and do NOT route Prisma through a TCP pooler from a Worker — Accelerate is HTTPS and works without `nodejs_compat` for the DB path. Validated pattern: `apps/prisma-test/src/index.ts:21-25`. Details in `docs/DATABASE_SCHEMA.md` §1a.
- **`nodejs_compat` is for SSR, not for the DB.** The SSR Worker needs `compatibility_flags: ["nodejs_compat"]` because `@angular/ssr` reaches for Node polyfills at runtime. That flag is unrelated to database access — Prisma still goes via Accelerate (HTTPS), never via a pg adapter. Validated pattern: `apps/stack-test/wrangler.jsonc:14-15`.
- **Cloudflare plan is Pro, not Enterprise.** Cache invalidation uses purge-by-URL, not purge-by-tag. Don't add `Cache-Tag` headers. Don't emit `Vary` headers that fragment the edge cache and undermine purge-by-URL — segment by URL path instead (e.g., locale prefix).
- **Zoneless Angular.** No `zone.js`. Use `provideZonelessChangeDetection()`. Pair with `provideClientHydration(withEventReplay(), withHttpTransferCacheOptions({ includePostRequests: false }))`. Validated pattern: `apps/stack-test/src/app/app.config.ts:18-25`. See `ANGULAR_STYLE_GUIDE.md` for the full set of Angular and TypeScript conventions (signals, control flow, OnPush, SSR safety, host bindings, `NgOptimizedImage`, `inject()` DI, file naming) and the ESLint rules that enforce them.
- **Cached SSR routes must render visitor-state-neutral HTML.** Edge cache is keyed by URL. If SSR reads a cookie (e.g., `theme`) and bakes it into the response, the first visitor poisons the cache for everyone. The Worker strips visitor-state cookies before forwarding to SSR for cacheable routes; the client reconciles after hydration. Validated pattern: `apps/stack-test/src/server.ts:212-229`.
- **No pay-for-placement.** Search rankings are purely algorithmic. Paid vendor tiers (Stage 4+) affect profile richness, never ranking position.
- **i18n from day one.** No hardcoded English strings in templates. Wrap everything in `i18n` attributes or `$localize` tags. Even though we launch English-only, retrofitting i18n is painful.
- **Both themes always.** Every component must render correctly in light and dark themes. Verify both before submitting.
- **Accessibility is built-in, not bolted on.** Spartan + Angular CDK give you a11y by default — don't break it. Run axe-core locally before pushing.

## Design checklist (UI-touching issues only)

For any issue that touches rendered UI in `apps/web/`, run this checklist before pushing. Issues that don't render UI (API, schema, infra, docs, CI, types) skip it.

`PRODUCT.md` (strategic context — users, brand, anti-references, principles) and `DESIGN.md` (visual system — colors, typography, components, do's/don'ts) are loaded by every Impeccable command before design work. If you're touching UI, both files are part of the contract.

1. **Critique the surface first.** Run `/impeccable critique <surface>` (or the standalone `/critique`) to capture a baseline against PRODUCT.md and DESIGN.md before you change anything. The output lands in `.impeccable/critique/` (gitignored).
2. **Build / refine via the matching skill.** For new features: `/impeccable craft <feature>`. For targeted refinement: `/impeccable typeset`, `/impeccable layout`, `/impeccable colorize`, `/impeccable distill`, `/impeccable normalize`. The shared design laws and the PRODUCT.md/DESIGN.md context are loaded automatically.
3. **Polish before submitting.** Run `/impeccable polish` for the final pass on spacing, alignment, micro-detail.
4. **Detect anti-patterns.** `npx impeccable detect <file-or-dir>` must report zero P0 findings. If P0s remain, fix or open a follow-up issue with the exact line references before merging.
5. **Verify both themes.** Per the "Both themes always" constraint above. The theme switcher (`apps/web/src/app/theme.service.ts`) toggles `.theme-dark` on `<html>` — render in each.
6. **Run a11y locally.** axe-core pass on the changed surface; resolve every error and `serious` violation before push.

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

# Run locally (uses .dev.vars for secrets)
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

## Skills

Shared Claude Code skills live in `.agents/skills/` and are checked into the repo so every contributor (and CI agents) get them automatically. `.claude/skills/` symlinks the same content for Claude Code's discovery path.

Two bundles co-exist:

- **`coreyhaines31/marketingskills`** — marketing / SEO / CRO / copywriting / analytics. Refresh with `pnpm skills:update`. Adds skills under `.agents/skills/` (one per skill, e.g. `analytics/`, `seo-audit/`).
- **`pbakaus/impeccable`** — design skill (single skill, 23 sub-commands: `craft`, `shape`, `teach`, `document`, `critique`, `audit`, `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard`, `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`, `clarify`, `adapt`, `optimize`, `extract`, `live`). Lives at `.agents/skills/impeccable/`. Refresh with `npx impeccable skills update` (the bundle ships its own self-updater) or reinstall via `npx -y impeccable skills install --force`. Reads `PRODUCT.md` and `DESIGN.md` at the repo root.

If `pnpm skills:update` ever clobbers `impeccable/`, that's a bug — the marketingskills bundle should not ship a same-named skill. Treat the `impeccable/` directory under `.agents/skills/` as owned by the upstream `pbakaus/impeccable` bundle.

Then commit any changes under `.agents/skills/`.

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

Every write that affects cacheable URLs must call `invalidateForEntity()`. See `docs/STAGE_1_SPEC.md` §9.3. URL map is in §9.3 — extend it when adding new cached routes.

## MCP usage rules

**Angular CLI MCP (`angular-cli`):**
- Before writing, modifying, or analyzing any Angular code, call `get_best_practices` once per session.
- For any Angular API question (signals, control flow, forms, router, SSR, zoneless), call `search_documentation` before answering from training data.
- Use `list_projects` to orient before generating files in the workspace.

## Closing notes

This file evolves. If a recurring instruction keeps coming up in code reviews, add it here. If a constraint is outdated, remove it. PR like any other doc change.

Last updated: see git log.