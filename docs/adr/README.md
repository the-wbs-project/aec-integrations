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
- `0008-taxonomy-reference-data.md` — **Accepted**: the taxonomy vocabulary (categories/audiences/phases) is code-managed reference data in `supabase/reference-data/taxonomy.sql`, applied to every environment via idempotent upserts. Supersedes the §13 "Airtable owns taxonomy" stance for the taxonomy facets only (vendors/products/integrations stay Airtable-owned).
- `0009-signal-forms.md` — **Accepted**: Angular v22 Signal Forms (`@angular/forms/signals`) is the standard for all new forms; forms reuse the shared `@aeci/shared` Zod schemas as the single source of validation truth, with `$localize` owning display copy. Documents the v22.0.0 `validateStandardSchema` + `validateHttp` incompatibility (NG0992) and the field-by-field workaround. Supersedes the "Reactive forms only" stance in `ANGULAR_STYLE_GUIDE.md` §13.
- `0010-promote-purges-cloudflare-directly.md` — **Accepted**: `POST /api/promote` purges the edge cache by calling Cloudflare's purge-by-tag API directly (shared `@aeci/shared` transport), removing the api→web `WEB` service binding and the web↔api cycle from AECI-105. The SSR Worker's `POST /admin/purge` stays as the manual/CI surface. A Cloudflare Queue (Option C) is the deferred evolution if multiple cross-Worker purge producers or bulk-purge volume appear.
- `0010-angular-aria-alongside-spartan.md` — status **Proposed** (AECI-129 spike, v22 epic AECI-122): adopt Angular Aria (`@angular/aria`, stable in v22) as the default for _new_ interactive/form-control patterns (select, combobox, listbox, radio, accordion, tree, grid, menu, toolbar, tabs) — it binds to Signal Forms out of the box — while **keeping Spartan** for the overlay primitives Aria lacks (Popover, Dialog) and migrating nothing reactively. Does not supersede ADR 0005 or 0009; informs but does not resolve the Spartan peer-override cleanup. Awaiting sign-off to flip to **Accepted**.
- `0011-canonical-uses-serving-origin.md` — **Accepted** (AECI-147): `<link rel="canonical">` and `og:url` use the **serving origin** (self-referential, multi-host), not a hardcoded apex — built once via `apps/web/src/app/core/canonical.ts` → `canonicalUrl()`. Future-proofs the pre-launch `demo.aecintegrations.com` → apex/www promotion; non-prod hosts are Access-gated so their self-canonicals never index. Sitemap/robots already used the serving origin, so they stay consistent for free; the 404 and `/preview/*` samples are documented exceptions.
- `0012-browserstack-real-device-cross-browser.md` — status **Proposed** (AECI-154): adopt **BrowserStack** (real-device cloud) as the **Phase 7** cross-browser / real-device testing approach — a scope addition to `TESTING_STRATEGY.md` §7/§9 (which specs Playwright-multi-browser + Chromatic, no BrowserStack). MCP server wired now for ad-hoc checks; the CI fan-out (existing Playwright suite → BrowserStack Automate, curated smoke subset, **real iOS Safari + real Android**) is a **separate non-blocking** lane deferred to Phase 7. Keeps the fast PR lane fast/free; reuses CF Access service-token headers for gated envs; don't run Percy *and* Chromatic. Awaiting sign-off to flip to **Accepted**.

> ADRs 0001–0006 were written retroactively on **2026-06-01** during the codebase audit; the decisions predate the records. The "over X" comparison rationale in 0001/0003/0005/0006 is reconstructed from repo evidence — the decision owner should confirm or correct it. 0002 and 0004 were renamed from misleading placeholder titles (the old `0002-no-prisma-accelerate` inverted the decision; `0004-pro-plan-purge-by-url` named a purge mechanism that was superseded by Cache-Tag purge).

Add new ADRs when a decision could surprise someone six months from now.
