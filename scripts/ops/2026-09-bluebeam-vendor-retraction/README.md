# 2026-09 Bluebeam vendor retraction (AECI-685 / AECI-792)

**Status: D1 APPLIED 2026-09-07 — Algolia / cache / upstream still outstanding.** Update
this line at each step; the AECI-593 precedent shows how easily a "decided" op is mistaken
for a done one.

| Step | State |
|---|---|
| 1. Deploy gate (`5a7af578` live) | done — prod at `44aba9cf` |
| 2. `apply.sql` against `aeci-app-production` | **done 2026-09-07** — verified `0 / 0 / 3 / 0 / 1` |
| 3. Algolia object purge | outstanding |
| 4. Cache purge | outstanding |
| 5. Upstream `supabase_vendor_id` clear + record delete | outstanding |

## What this removes

One `vendors` row from `aeci-app-production`:

| | |
|---|---|
| `vendors` | `b52e0001-8b9e-40c5-87fc-953c2e0dd843` — slug `bluebeam`, `promotion_status='promoted'`, `parent_company='Nemetschek Group'`, **0 products** |
| re-pointed, not deleted | `integrations` `322ba420-f306-4948-9195-b979eebafba2` (Autodesk Revit → Bluebeam Revu) and `6c0cbee8-5d54-4244-bf59-11b88e09ccd0` (Bluebeam Revu ↔ Okta) — `built_by_vendor_id` moves to Nemetschek Group `8c83a9d5-b6c4-4117-be00-a02eebf9fee6` |
| nulled | `page_views.vendor_id` on ~31 rows (log-class, unrecoverable) |

Bluebeam was the **only** zero-product vendor across all 165 — a one-off, not a class.

## Why it exists

Bluebeam is a Nemetschek brand. The review app re-parented both Bluebeam products to
Nemetschek Group and, on 2026-09-05, re-pointed all three `built_by` edges there too —
leaving the AECi vendor row with nothing to own but still live, still indexed, still
named on two pair pages, and still in `production_vendors`.

The root cause is upstream and is now fixed: `DELETE /api/vendors/:id` in
`aec-integrations-review` had no guard, silently CASCADEing product links away while
nulling every `built_by_vendor_id`. `a29e419e` (PR #92) makes it refuse with **409**
while `supabase_vendor_id` is set.

## Pre-flight, captured 2026-09-07 against production

`preflight.json` holds the raw numbers. The four RESTRICT references:

| FK | Rows | Handling |
|---|---|---|
| `integrations.built_by_vendor_id` | **2** | re-point (step 1) |
| `page_views.vendor_id` | **31** | null (step 2) |
| `profiles.vendor_id` | 0 | — |
| `connector_evidenced_pairs.built_by_vendor_id` | 0 | — |

`connector_evidenced_pairs` is the one the original AECI-685 plan did not name. It was
absent from production when that plan was written; migration `0027` rode the 2026-09-07
promote, so the table now exists and the query returning 0 is a real check rather than a
missing-table error.

Of the five CASCADE parents, four — `product_vendors`, `claims.created_by_vendor_id`,
`attestations.attested_by_vendor_id`, `vendor_entitlements` — were confirmed **0**. That
matters more than the RESTRICT list: a CASCADE deletes silently and the rollback cannot
restore it, so confirm zero rather than assume it.

**The fifth was missed: `vendor_seat_invites.vendor_id`** (also CASCADE; the table is
live in production since migration `0025`). It was not counted before `apply.sql` ran, so
any row it held was deleted silently and is unrecoverable. Zero is very likely — the
vendor portal is dark and no seat has been granted — but that is an inference, not a
measurement. `vendors` has **nine** inbound FKs, not eight; count them all next time.

## Order of operations

The public row goes first and the upstream row last. Reversing that lets a promote
resurrect the vendor.

1. **Deploy gate — already satisfied.** `5a7af578` (the `/vendors/bluebeam` →
   `/vendors/nemetschek-group` 301) must be live in production first, or an indexed URL
   404s in the gap. Verified 2026-09-07: `/api/version` reports `44aba9cf`, and the URL
   301s. When re-checking, send a browser User-Agent — a bare `curl` gets a Cloudflare
   **403** that reads like a WAF block.
2. **`apply.sql`** — one `wrangler d1 execute --remote --file`.
3. **Algolia** — `ops:purge-algolia-orphans -- --env production --ids vendors:b52e0001-… --apply`.
4. **Cache purge** — do it, expect nothing: production runs with `cache.enabled` off, so
   the queue consumer no-ops with `outcome:no_cache`. The deciding surfaces are the SSR
   render, Algolia and the sitemap.
5. **Upstream** — clear `supabase_vendor_id` / `supabase_slug` on `recyPyhW3fe9p73Qe`
   (a direct `aeci-review` D1 write; `update_vendor` does not expose those columns), then
   delete the record. The new 409 guard will correctly refuse until you do.

Nemetschek needs **no** count recompute: its `product_count` / `integration_count` are
live correlated subqueries, not stored columns. Nothing here changes any product's
stored `integration_count` either, so `db:reconcile-counts` is not part of this op.

## The audit row

Unlike the 2026-08 orphan cleanup and the 2026-09 Roofr/QBO cleanup — both of which left
**no** `audit_log` row — `apply.sql` writes one (`action='vendor.retracted'`,
`actor_type='admin'`). A vendor delete is domain state, and `STAGE_1_SPEC.md` §26.1 says
outright that scheduled deletion is never exempt; the ADR 0022 log-class exemption covers
`page_views`, not `vendors`. Precedent for the shape: `catalog.integrations_reset`.

This is hand-written SQL rather than the `apps/api/src/lib/audit.ts` builders, so it is
**not** in the same `db.batch` as an application write — the §26.1 in-batch invariant
applies to application code paths. Keeping all four statements in one `--file` execution
is the closest raw SQL gets.

## Two traps hit during execution — read before writing another hand-SQL op

**1. Raw `INSERT` must supply `created_at` (and `updated_at`) explicitly.** Both columns
are `NOT NULL` with **no SQL-level `DEFAULT`** — `createdAt()` / `updatedAt()`
(`schema.ts:47-56`) use Drizzle's `$defaultFn`/`$onUpdate`, which only run in application
code. Every AECi table is like this, so this is not specific to `audit_log`. Omitting the
column fails with `SQLITE_CONSTRAINT_NOTNULL`. Use
`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, which reproduces `new Date().toISOString()`
exactly (3-digit milliseconds, `Z`) so the row sorts against application-written rows.

**2. A constraint failure inside a multi-statement `--file` batch surfaces as
`{"D1_RESET_DO":true}`.** That is the entire error — no statement, no constraint name.
It reads like a transient Durable Object reset, and the tempting response (retry) is
wrong: it fails identically every time. The first `apply.sql` run failed this way and the
cause was trap 1. **Diagnostic:** re-run the statements as individual
`wrangler d1 execute --command` calls; D1 then reports the real SQLite error against the
one statement that fails. The batch is atomic, so a failed `--file` run commits nothing
and the split retry is safe from a clean state — but verify that rather than assume it if
any statement is non-idempotent (`apply.sql`'s audit `INSERT` is).

A red herring worth recording so nobody re-investigates it: **`page_views.vendor_id` has
no index** (the table's six indexes are `path`, `country`, `product`, `bot`,
`operator_pair`, `dedupe_key`), so step 2 full-scans prod's largest table to find ~31
rows. That was the leading hypothesis for the `D1_RESET_DO` and it was wrong — the
statement runs fine. It is still true, and still a cost any future vendor retraction pays.

## Rollback

`rollback.sql` restores the vendor row verbatim and re-points both integrations back.
Two things it deliberately does not do:

- **`page_views.vendor_id` stays NULL** for the ~31 nulled rows. Accepted when the plan
  was written; do not read it as a failed rollback.
- **It restores `updated_at` verbatim (2026-08-25) rather than bumping it.** The 08:00
  UTC incremental Algolia sync is watermarked on `updated_at`, so a bumped value would
  silently re-index the vendor into `production_vendors`. The same fact is why step 3's
  purge is durable in the forward direction: nothing re-adds the object.

## Verification

```
apps/api/node_modules/.bin/wrangler d1 execute aeci-app-production --remote --json --command "SELECT (SELECT COUNT(*) FROM vendors WHERE slug='bluebeam') AS vendor_rows, (SELECT COUNT(*) FROM integrations WHERE built_by_vendor_id='b52e0001-8b9e-40c5-87fc-953c2e0dd843') AS stale_built_by, (SELECT COUNT(*) FROM integrations WHERE built_by_vendor_id='8c83a9d5-b6c4-4117-be00-a02eebf9fee6') AS nemetschek_built_by, (SELECT COUNT(*) FROM audit_log WHERE action='vendor.retracted') AS audit_rows"
```

Expect `vendor_rows 0`, `stale_built_by 0`, `nemetschek_built_by 3` (the two re-pointed
edges plus the pre-existing Archicad → Forma edge), `audit_rows 1`. Treat
`stale_built_by = 0` as the load-bearing assertion; the Nemetschek total is
informational, and AECI-792's acceptance list states it in a way that conflates
upstream's 3 with this one.

Then, off-database:

- `/vendors/bluebeam` still 301s (it is a hard-coded route and never read the row).
- Neither pair page renders a "Built by" link to `/vendors/bluebeam`.
- `bluebeam` is absent from `sitemap.xml` — note the *product* `bluebeam-revu` and its
  pair URLs stay, correctly; only `/vendors/bluebeam` should go.
- No `production_vendors` object for `b52e0001-…`.
- **Resurrection check** — re-promote Bluebeam Revu; no vendor comes back with
  `operation: "created"` and nothing reclaims the `bluebeam` slug. Since AECI-730 an
  unresolvable `builtByVendor` link is left untouched and reported in `unresolvedLinks[]`
  rather than creating a row, and Bluebeam can never appear in `payload.vendors[]`
  (the review app builds that array solely from `product_vendors`, which is 0). The
  general resurrection risk returns the moment anyone re-links a product to a dead
  vendor.

## Related

- **AECI-595** owns the general retract path. This is deliberately a hand-SQL one-off;
  no reusable `ops:retract-vendor` was built. If one ever is, it must cover all **nine**
  inbound FKs — the four RESTRICT ones including `connector_evidenced_pairs`, and the
  five CASCADE ones including `vendor_seat_invites`, which this op missed.
- **AECI-791** — the AECI-593 Polycam retraction, marked Done but never executed. Same
  failure mode this README's status line guards against.
- The daily `promote-strand-audit` cron will **not** catch a mistake here: it has been
  exiting 0 and skipping every run, and its Airtable transport is retired.
