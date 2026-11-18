# Unclaimed-logo audit — AECI-1867

Read-only operator script. It counts unclaimed products and vendors whose Algolia record still
carries a `logo_url`.

Linear: [AECI-1867](https://linear.app/aec-integrations/issue/AECI-1867).

## Why

Search shows a logo only while a listing is claimed (AECI-1618, `DESIGN.md` §5 "Unclaimed note",
counsel's ruling 9). Both record builders null `logo_url` for an unclaimed listing. Records built
before AECI-1618 kept their logos, because the nightly sync only re-pushes rows whose `updated_at`
moved. `/search` trusts the record, so it showed those logos.

## What it reads

1. D1, one SELECT per entity: every unclaimed product and vendor id. A vendor is claimed when
   `owned_at` is set and `claim_ended_at` is null. A product is claimed when any linked vendor is.
   Every unclaimed id is a candidate, not only those with a stored logo, because a record can hold a
   logo D1 no longer has.
2. Algolia getObjects on `<prefix>_products` and `<prefix>_vendors`, 1000 ids per request, with the
   public search-only key. An id with no record is not a finding.

It writes nothing. Exit code 0 means clean, 2 means findings, 1 means an error.

## Usage

```
ALGOLIA_APP_ID=… ALGOLIA_SEARCH_KEY=… node scripts/ops/2026-11-algolia-unclaimed-logo-audit/audit.mjs --env production
```

`--env` is `staging`, `demo` or `production`. The search key is the per-env query-only key the SSR
Worker renders into `window.__AECI_ALGOLIA__`. Wrangler needs D1 read on the target account.

## The repair

Reset the `products` and `vendors` watermark fields with
`scripts/ops/2026-09-algolia-integration-watermark-reset/reset-watermark.mjs`, then wait for the
next 08:00 UTC sync (`docs/SEARCH_RANKING.md` §1.2). Re-run this audit after it.

The daily `algolia_unclaimed_logo` data-quality check runs the same comparison in the Worker
(`apps/api/src/lib/algolia-unclaimed-logo.ts`), so a recurrence shows without this script.

## Run record

Before the repair, 2026-11-17:

| Index | Unclaimed in D1 | In the index | With a `logo_url` |
|---|---|---|---|
| `production_products` | 441 | 441 | 195 |
| `production_vendors` | 247 | 247 | 239 |
| `staging_products` | 342 | 342 | 192 |
| `staging_vendors` | 229 | 229 | 229 |
| `demo_products` | 433 | 433 | 0 |
| `demo_vendors` | 245 | 245 | 0 |

Most vendor findings were Brandfetch lettermark fallback URLs.

After the 08:00 UTC sync, 2026-11-17: every index read 0 with a `logo_url` on staging and
production. The 4 claimed production vendors with a stored logo kept it in their records.
