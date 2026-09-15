# 2026-09 Reality Capture category de-duplication (AECI-926 / AECI-962)

**Status: NOT YET RUN.** Blocked on the upstream rename — see "Order of operations".

## What is wrong

`taxonomy_categories` holds **two rows with the identical display name** on demo and
production. Verified 2026-09-15:

| slug | display_order | description | products |
| -- | -- | -- | -- |
| `reality-capture` | 250 | curated | 0 |
| `reality-capture-scan-to-bim` | NULL | NULL | 10 |

Preview and staging are clean — one row, description present. They are not promote
targets, which is the whole difference.

Both slugs were in the live production `sitemap.xml`, so one of them was an empty
browse page we were asking Google to index.

## Why it happened

`resolveTaxonomy` (`apps/api/src/routes/promote.ts`) matches an incoming category by
`slugify(name)` against the `slug` column and **mints** the term on a miss, writing
`{ id, slug, name }` only — no `description`, no `display_order`.

Upstream record `rec6UopJxIh0GumVn` was named `Reality Capture (Scan-to-BIM)`, which
slugifies to `reality-capture-scan-to-bim`. The seed slug is `reality-capture`. They
never matched, so every promote re-missed and the minted duplicate is what products
attached to — while the curated description stayed on the row nobody reached.

That is the whole of AECI-962's symptom: the vendor taxonomy picker was rendering the
**minted** row. A re-seed could never have fixed it.

## Resolution: option A

`reality-capture` is canonical. The upstream term is renamed to `Reality Capture` so
`slugify` lands on the seeded slug, and the shorter URL survives.

There is no AECi-side alternative. `taxonomy_categories` has no `aliases` column —
only `taxonomy_trades` and `taxonomy_data_objects` do — and `resolveTaxonomy` is a
single slug lookup with no name or alias pass. The upstream write is unavoidable.

## Order of operations, and why it is strict

1. **Merge the repo PR** (seed rename, the 301, the two new guards).
2. **Deploy**, so `/categories/reality-capture-scan-to-bim` already 301s. The redirect
   wins whether or not the row exists, so there is no window where the URL 404s.
3. **Rename `rec6UopJxIh0GumVn` upstream** to `Reality Capture`. **This is the
   load-bearing step.** Until it lands, every promote of one of those 10 products
   re-mints the duplicate and undoes step 4.
4. **Run `dedup.sh --env demo --apply`**, verify end to end, then production.

Running step 4 before step 3 does not fail. It silently reverts.

## What the script does

Per environment, in this order:

1. Resolves both ids and refuses on two guards: a product joined to **both** rows
   (which would trip `product_categories`' composite PK on the UPDATE), and a loser row
   that carries a description (which would mean someone curated the minted row and the
   merge would throw that copy away).
2. Backs up both category rows, all affected join rows, and the affected product slugs.
3. `UPDATE product_categories SET category_id = <winner> WHERE category_id = <loser>`,
   then **verifies the joins moved before deleting anything**.
4. Bumps `products.updated_at` on the affected products, for the Algolia watermark.
5. `DELETE FROM taxonomy_categories WHERE id = <loser>`.

**The ordering in 3 → 5 is a data-loss control.** `product_categories.category_id` is
`ON DELETE cascade` (`apps/api/src/db/schema.ts:710`), and it is the **only** FK to
`taxonomy_categories.id`. A bare delete of the loser does not error — it silently
strips those 10 products of their category, and nothing self-heals, because promote
replaces join sets wholesale rather than reconciling them. The script aborts before the
delete if the UPDATE did not move every row.

## Follow-ups the script does not do

- **`TAXONOMY_KV` must be cleared by hand.** `GET /api/taxonomy` read-through caches on
  `taxonomy:v1` with a 300s TTL and **no active invalidation**
  (`apps/api/src/routes/taxonomy.ts`). That cache sits **upstream of every `Cache-Tag`**,
  so a tag purge alone repaints the HTML from the stale payload. The script prints the
  exact `wrangler kv key delete` line.
- **Cache-Tag purge:** `category:reality-capture`, `category:reality-capture-scan-to-bim`,
  `index:categories`, `index:products`, `taxonomy`, `sitemap`, `route:browse`.
- **Algolia:** `algolia-transforms.ts` indexes the category **name** as the facet value,
  and the name changed. `updated_at` is bumped in step 4 so the watermark sync picks the
  records up; verify with `pnpm --filter @aeci/api db:reconcile-algolia-drift`.
- **Re-submit the sitemap** so the dropped URL is picked up.

**Do not run `reconcile-counts`.** Category product counts are computed live per request
(`toTaxonomyTermWithCount` in `apps/api/src/routes/taxonomy.ts`); there is no
denormalised category counter to drift. The "44 integrations" figure on AECI-926 is
derived from the products, not stored on the category.

The rename half needs no data op at all — `seed/taxonomy.sql`'s `ON CONFLICT` updates
`name`, and the seed re-applies on every deploy, so merging the PR renames the surviving
row in every environment automatically.

Like every prior ops script here, this runs raw SQL rather than the API's `db.batch` +
audit builders, so it leaves **no `audit_log` row**.

## Guards added so this cannot recur silently

| Guard | Catches |
| -- | -- |
| `apps/api/src/test/taxonomy-seed-slugs.spec.ts` | a seeded term whose `slug` stops matching `slugify(name)` — the condition that makes promote mint. `KNOWN_OFFENDERS` is now empty and asserted as an exact set, so adding an entry is not a fix. Since AECI-962 it also fails on a blank, NULL, or over-155-char seed description. |
| `taxonomy_missing_description` in `apps/api/src/lib/data-quality.ts` (severity `error`) | a **live** term in D1 with no description — the minted-row shape the seed test structurally cannot see. |

## Still open

Whether `resolveTaxonomy` should mint at all. Trades and data objects are find-only
precisely because a minted duplicate splits a browse page across two permanent URLs,
which is exactly what happened here. Making categories, audiences and phases find-only —
reporting an unmatched value in `skipped[]` — would make this class structurally
impossible rather than merely tested for. That is a promote-contract change and belongs
in its own issue with its own `REVIEW_APP_PROMOTE_API.md` update.
