# 2026-11 OpenAsset slug rename (AECI-1574)

**Status: COMPLETE 2026-11-10.** Update this line at each step.

| Step | State |
|---|---|
| 1. Preflight read | **done 2026-11-10**: product at `openasset-connector`, named OpenAsset Source. One vendor, `openasset` (`9e20c13f-…`), `owned_at` null. No row at `openasset-source`. No redirect row. 13 `gsc_recrawl_queue` and 5 `indexnow_queue` URLs carry the old slug |
| 2. `apply.sql` against `aeci-app-production-us` | **done 2026-11-10 02:45 UTC**: 4 changes, 12 rows written |
| 3. Verify read | **done**: `openasset-source`, 1 redirect row, 1 audit row |
| 4. Edge purge | **not needed**: every URL in step 7 was `cf-cache-status: MISS` |
| 5. Promote OpenAsset Source | **done 2026-11-10**, job `recOEgIeuUKPpRbU9-mwa38l4w-e2427a54`, `updated`, slug `openasset-source`. 13 rows withheld because their other endpoint is not promoted. That predates this rename |
| 6. Review-app `supabase_slug` check | **done**: `openasset-source` |
| 7. URL check | **done 2026-11-10**: `/products/openasset-connector`, `/products/openasset-connector/integrations/procore` and `/products/deltek-vantagepoint/integrations/openasset-connector` 301 to the new slug. `/products/openasset-source` returns 200 |
| 8. Old-slug queue rows | **done 2026-11-10**: deleted, see step 8 |

## What this changes

The row was the OpenAsset Connector until AECI-496 made it the main OpenAsset product. It was renamed OpenAsset Source on 2026-11-02, after OpenAsset's October rebrand. The name is live. The slug is not:

| Entity | id | Slug now | Slug after |
|---|---|---|---|
| product (OpenAsset Source) | `3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2` | `openasset-connector` | `openasset-source` |

The vendor keeps `openasset`. `apply.sql` renames the product in place and sets `updated_at`, so the Algolia delta sync picks the change up. It seeds one `slug_redirects` row (`DATABASE_SCHEMA.md` §4.3b). The existing resolvers then 301 `/products/openasset-connector` and every pair URL that names it on either side. It writes one `product.updated` audit row. No code ships with it.

**Why an ops script and not a migration.** A migration should only change data that migrations created (ruled 2026-10-28, AECI-1495). This row exists only in production.

**Safe to run twice.** Every statement is keyed on the production id and the old slug. Tested on a scratch database built from all migrations on 2026-11-10: apply twice, rollback twice, then apply again. Each step gave the expected slug, redirect count and audit count. With another row already at `openasset-source`, apply wrote nothing. A re-apply after a rollback writes no second apply audit row, the same as AECI-1495.

## Run order

Every command runs from `/tmp`, except the copy in step 0. Inside `apps/api`, wrangler's pinned account returns 7403, and the bare name `aeci-app-production` from `/tmp` reaches the retired APAC copy.

### 0. Copy the SQL to /tmp

Run this from the repo root.

```bash
cp scripts/ops/2026-11-openasset-slug-rename/apply.sql scripts/ops/2026-11-openasset-slug-rename/rollback.sql scripts/ops/2026-11-openasset-slug-rename/delete-queued-old-slug.sql /tmp/
```

### 1. Preflight read

Expect the product at `openasset-connector`, no row already at `openasset-source`, and no redirect row.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT 'product' AS t, p.id, p.slug, pv.vendor_id AS vendor, v.owned_at FROM products p LEFT JOIN product_vendors pv ON pv.product_id = p.id LEFT JOIN vendors v ON v.id = pv.vendor_id WHERE p.id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2' OR p.slug IN ('openasset-connector','openasset-source') UNION ALL SELECT 'redirect', entity, from_slug, to_slug, NULL FROM slug_redirects WHERE from_slug = 'openasset-connector'"
```

### 2. Apply

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file apply.sql
```

`--file` reports a summary, not rows. A constraint failure shows only as `D1_RESET_DO`. If that happens, run the statements one at a time with `--command` to find which one failed.

### 3. Verify read

Expect the new slug, one redirect row, and one audit row.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT 'product' AS t, slug AS a, updated_at AS b FROM products WHERE id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2' UNION ALL SELECT 'redirect', entity, to_slug FROM slug_redirects WHERE from_slug = 'openasset-connector' UNION ALL SELECT 'audit', action, after_state FROM audit_log WHERE json_extract(metadata, '$.issue') = 'AECI-1574'"
```

### 4. Purge the edge

The SQL purges nothing, and editing the redirect map has no purge hook (`CACHE_STRATEGY.md` §3 rule 6). A cached old detail page serves until its 900 s `s-maxage` runs out, so first check whether a purge is needed at all. If one is, `POST /admin/purge` on the SSR Worker takes the `ADMIN_PURGE_TOKEN` bearer, not an admin session. That token lives in GitHub secrets. The body is:

```json
{ "tags": ["product:openasset-connector", "product:openasset-source"] }
```

`product:openasset-connector` also covers the pair pages, which embed both products' tags.

### 5. Promote OpenAsset Source from the review app

The name is already live. The promote runs to bring the new slug back to the review app (step 6). It also purges the new-slug tags and marks the sitemap dirty. Promote never changes a slug, so it keeps the new one.

### 6. Check the review app's slug copy

Read `supabaseSlug` on product `recOEgIeuUKPpRbU9`. It should be `openasset-source`. The review app stores the slug from the promote response, and no tool writes `supabase_slug` directly.

### 7. URL check

Each line should print `301` and a `location` on the new slug. The WAF answers curl's default user agent with 403, so these send a browser user agent.

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" https://www.aecintegrations.com/products/openasset-connector | grep -iE "^HTTP|^location"
```

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" https://www.aecintegrations.com/products/openasset-connector/integrations/procore | grep -iE "^HTTP|^location"
```

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" https://www.aecintegrations.com/products/deltek-vantagepoint/integrations/openasset-connector | grep -iE "^HTTP|^location"
```

### 8. Drop the old-slug queue rows

The Google and IndexNow queue rows under the old slug were queued before the mapping existed. Chris ruled on 2026-11-10 to delete them. The promote in step 5 had already queued every new-slug URL. **Done 2026-11-10**: D1 reported 19 changes against the 18 rows counted at preflight. Every row it can match also matches `LIKE '%openasset-connector%'`, so only old-slug rows went. Afterwards both queues held 0 old-slug and 13 new-slug URLs each.

`delete-queued-old-slug.sql` matches on whole path segments with `substr`. D1 rejects the equivalent LIKE patterns as too complex.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file delete-queued-old-slug.sql
```

## Rollback

`rollback.sql` puts the slug back, deletes the redirect row and writes one reversal audit row. Run step 0 first if `/tmp` no longer holds the file, then purge the same two tags as step 4.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file rollback.sql
```
