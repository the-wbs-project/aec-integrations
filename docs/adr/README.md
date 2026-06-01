# Architecture Decision Records

Short, dated records explaining *why* specific decisions were made. Format: Context, Decision, Consequences.

See [adr.github.io](https://adr.github.io/) for the convention.

## Naming

`NNNN-short-decision-title.md` where NNNN is a four-digit sequential number starting at 0001.

## Written ADRs

- `0001-cloudflare-workers-over-vercel.md` — **Accepted**: SSR + private API Worker on Cloudflare over Vercel.
- `0002-prisma-accelerate-over-tcp-pooler.md` — **Accepted**: Prisma Accelerate (HTTPS) for Worker→DB; no TCP pooler / pg adapter. _(Renamed from the inverted placeholder `0002-no-prisma-accelerate`.)_
- `0003-linear-over-huly.md` — **Accepted**: Linear for issue tracking + workflow automation.
- `0004-pro-plan-and-cache-tag-purge.md` — **Accepted**: Cloudflare Pro + purge-by-Cache-Tag; URL-invalidation (`STAGE_1_SPEC §9.3`) superseded. _(Renamed from the stale placeholder `0004-pro-plan-purge-by-url`.)_
- `0005-spartan-over-syncfusion.md` — **Accepted**: headless Spartan + Tailwind v4 over a commercial suite.
- `0006-algolia-over-cloudflare-ai-search.md` — **Accepted**: Algolia + InstantSearch for search (ships Phase 3).
- `0007-prisma-migrate-dev-unsupported.md` — status **Superseded by AECI-72**: documents the original Catch-22 between Prisma's drift detector and Supabase's `auth.users` schema. Resolved by retiring Prisma migrations entirely and adopting Supabase CLI migrations (`supabase/migrations/`). See `docs/migrations.md` for the current workflow.

> ADRs 0001–0006 were written retroactively on **2026-06-01** during the codebase audit; the decisions predate the records. The "over X" comparison rationale in 0001/0003/0005/0006 is reconstructed from repo evidence — the decision owner should confirm or correct it. 0002 and 0004 were renamed from misleading placeholder titles (the old `0002-no-prisma-accelerate` inverted the decision; `0004-pro-plan-purge-by-url` named a purge mechanism that was superseded by Cache-Tag purge).

Add new ADRs when a decision could surprise someone six months from now.
