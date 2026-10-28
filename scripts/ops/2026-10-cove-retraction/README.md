# 2026-10 cove (Vitras.ai) retraction (AECI-1496)

**Status: COMPLETE — 2026-10-28.** Both live rows retracted, all three review-app records
deleted, retraction feed empty.

| Step | State |
|---|---|
| 1. Dry runs, both CLIs | done 2026-10-28 |
| 2. `ops:retract-product` on `5d33a95e-…` | **done 2026-10-28** — 84 rows, Algolia object removed |
| 3. `ops:retract-vendor` on `ea586005-…` | **done 2026-10-28** — 73 rows, `vendor.deleted`, Algolia object removed |
| 4. Edge cache | not purged by hand — Chris ruled to let the 900 s `s-maxage` expire |
| 5. `sitemap:dirty` put | **done 2026-10-28T03:29:58Z** |
| 6. AECI-881 claim | **posted and released 2026-10-28** |
| 7a. Review app `delete_product` `recCk99gqc5ityqLu` | **done 2026-10-28T03:44:56Z** — 7 links cascaded; opened journal entry `rec3W3h90Qzwtxsza` |
| 7b. `confirm_retractions` `rec3W3h90Qzwtxsza` | **done 2026-10-28** — 1 of 1 confirmed; feed now empty |
| 7c. `update_vendor` `clear_production_pointer` | **done 2026-10-28** — cleared `ea586005` / `vitras-ai`, logged to `vendor_rulings`; 0 products left |
| 7d. `delete_vendor` `recZbENaVKNtDF3kA` with a `ruling` | **done 2026-10-28** — ruling and row snapshot logged to `vendor_rulings` |

## Why it exists

Chris ruled on 2026-10-27 that cove (formerly cove.tool) leaves the catalogue. cove.inc presents
an architecture studio. Vitras.ai is, by cove's own page, an internal tool that is not sold. The
analysis platform (cove.tool, renamed analysis.tool) is served to existing customers only. Neither
product had a recorded integration. The ruling is recorded in the review-app vendor's
`admin_notes` (`recZbENaVKNtDF3kA`).

Promote cannot retract (`docs/REVIEW_APP_PROMOTE_API.md` §5.1), so the live rows came down through
the two ops CLIs before the upstream records were deleted. Deleting upstream first would have lost
the only pointer to the live rows.

## What this removed from `aeci-app-production`

| Entity | Id | Slug |
|---|---|---|
| Product Vitras.ai | `5d33a95e-b2c1-456d-a693-f44014a7778a` | `vitras-ai` |
| Vendor (named Vitras.ai in D1) | `ea586005-82d8-4f59-897c-255d3b28fd66` | `vitras-ai` |

### Product footprint (dry run = apply)

| Rows | Count |
|---|---|
| integrations, evidenced pairs, claims, attestations, contests, reviews, versions, licenses | 0 |
| `product_vendors` / `product_categories` / `product_audiences` / `product_phases` | 1 / 2 / 2 / 2 |
| `page_views.product_id` NULLed, rows kept | 75 |

Apply: 84 rows written across 32 statements, tombstones in the same batch.

### Vendor footprint (re-run after the product retract)

| Rows | Count |
|---|---|
| products, integrations, evidenced pairs, profiles, invites, billing accounts, proposals | 0 |
| `page_views.vendor_id` NULLed, rows kept | 71 |

The first dry run refused with "owns 1 product(s)", as expected before step 2. Apply: 73 rows
changed across 8 statements, one `audit_log` row `vendor.deleted`.

## Commands

```
pnpm --filter @aeci/api ops:retract-product -- --id 5d33a95e-b2c1-456d-a693-f44014a7778a --env production --apply --allow-production --operator chrisw@thewbsproject.com
```

```
pnpm --filter @aeci/api ops:retract-vendor -- --id ea586005-82d8-4f59-897c-255d3b28fd66 --env production --apply --allow-production --confirm-count 1
```

Neither CLI marks the sitemap dirty (`docs/RUNBOOKS.md`, "Sitemap is stale"), so the marker was
put by hand from `apps/api`:

```
pnpm exec wrangler kv key put sitemap:dirty "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --binding TAXONOMY_KV --env production --remote
```

## Verification, 2026-10-28

| Check | Result |
|---|---|
| `/products/vitras-ai` | 404 |
| `/vendors/vitras-ai` | 404 from 03:42:49Z. It served a cached 200 (`HIT`) for about 15 minutes after the retract, the 900 s `s-maxage` |
| `/sitemap.xml` | no `vitras-ai` in 2,340 URLs, first read 03:30:42Z |
| Algolia | `ops:purge-algolia-orphans` dry run: `0/2 target(s) present` |
| Review app | product and vendor records deleted; `list_retractions` returns 0 entries |

A plain `curl` to production gets a 403 from the WAF scraper rule. The read-backs used a browser
user agent. The orphan-purge dry run also prints `EXTRA` lines for its built-in "Procore" and
"Fixture" search probes. Those are unrelated live objects, not leftovers of this run.

## The retraction journal entry

`delete_product` on a record that still carries a `supabase_product_id` always opens a
retraction-journal entry, even when AECi has already removed the row. The daily strand audit
reports every open entry under `pendingRetractions` and fails on it. Here the entry
(`rec3W3h90Qzwtxsza`) points at a row step 2 had already deleted, so the repair is
`confirm_retractions`, not a consumer run.
