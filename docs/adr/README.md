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

- `0007-prisma-migrate-dev-unsupported.md` — status **Open**: documents why `prisma migrate dev` doesn't work against our Supabase setup, the dead-end approaches already tried, and possible future paths.

Add new ADRs when a decision could surprise someone six months from now.
