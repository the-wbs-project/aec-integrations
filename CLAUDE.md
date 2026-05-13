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
3. The Linear issue you're working on should have a `Spec Section` custom field pointing to the governing section
4. If the spec is ambiguous or wrong, raise it — don't guess

## Documents that are source of truth

| Topic | Source of truth |
|---|---|
| What we're building and why | `docs/STAGE_1_SPEC.md` |
| API endpoint shapes, validation, errors | `docs/API_CONTRACTS.md` |
| Database schema, migrations, RLS hooks | `docs/DATABASE_SCHEMA.md` |
| CI/CD, environments, deployment | `docs/CICD_PLAN.md` |
| Testing tools, coverage targets, patterns | `docs/TESTING_STRATEGY.md` |
| Auth model and RLS policies | `docs/AUTH_AND_RLS.md` (placeholder — defer to spec until completed) |

If your work touches a topic governed by one of these documents, that document is the source of truth — not your prior knowledge or assumptions.

## Stack at a glance

- **Frontend:** Angular 21+ with SSR, zoneless change detection
- **Styling:** Tailwind CSS + Spartan UI + Angular CDK
- **Hosting:** Cloudflare Workers (SSR Worker + private API Worker via service binding)
- **Database:** Supabase (PostgreSQL) + Prisma with `@prisma/adapter-pg-worker` (NOT Accelerate)
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

- **No Prisma Accelerate.** Use `@prisma/adapter-pg-worker` with Supabase's connection pooler. Do NOT install `@prisma/extension-accelerate`. Do NOT import from `@prisma/client/edge`. The `prisma://` protocol is Accelerate; never use it. If Prisma tooling suggests Accelerate, push back.
- **Cloudflare plan is Pro, not Enterprise.** Cache invalidation uses purge-by-URL, not purge-by-tag. Don't add `Cache-Tag` headers.
- **Zoneless Angular.** No `zone.js`. Use `provideZonelessChangeDetection()`.
- **No pay-for-placement.** Search rankings are purely algorithmic. Paid vendor tiers (Stage 4+) affect profile richness, never ranking position.
- **i18n from day one.** No hardcoded English strings in templates. Wrap everything in `i18n` attributes or `$localize` tags. Even though we launch English-only, retrofitting i18n is painful.
- **Both themes always.** Every component must render correctly in light and dark themes. Verify both before submitting.
- **Accessibility is built-in, not bolted on.** Spartan + Angular CDK give you a11y by default — don't break it. Run axe-core locally before pushing.

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
pnpm lint

# Run tests
pnpm test            # unit + integration
pnpm test:unit       # Vitest only
pnpm test:e2e        # Playwright against local wrangler dev

# Build for deployment
pnpm build
```

Local secrets live in `.dev.vars` (per Worker package). Not committed. `.dev.vars.example` shows what's required.

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

## Closing notes

This file evolves. If a recurring instruction keeps coming up in code reviews, add it here. If a constraint is outdated, remove it. PR like any other doc change.

Last updated: see git log.
