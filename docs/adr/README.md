# Architecture Decision Records

Short, dated records explaining *why* specific decisions were made. Format: Context, Decision, Consequences.

See [adr.github.io](https://adr.github.io/) for the convention.

## Naming

`NNNN-short-decision-title.md` where NNNN is a four-digit sequential number starting at 0001.

## Planned ADRs to write

- `0001-cloudflare-workers-over-vercel.md`
- `0002-no-prisma-accelerate.md`
- `0003-linear-over-huly.md`
- `0004-pro-plan-purge-by-url.md`
- `0005-spartan-over-syncfusion.md`
- `0006-algolia-over-cloudflare-ai-search.md`

## Written ADRs

- `0007-prisma-migrate-dev-unsupported.md` — status **Superseded by AECI-72**: documents the original Catch-22 between Prisma's drift detector and Supabase's `auth.users` schema. Resolved by retiring Prisma migrations entirely and adopting Supabase CLI migrations (`supabase/migrations/`). See `docs/migrations.md` for the current workflow.

Add new ADRs when a decision could surprise someone six months from now.
