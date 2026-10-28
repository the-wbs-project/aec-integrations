# 2026-10 Coda slug rename (AECI-1495)

**Status: COMPLETE 2026-10-28.** Update this line at each step.

| Step | State |
|---|---|
| 1. Preflight read | **done 2026-10-28**: both rows at `coda`, `owned_at` null, no row at the new slugs, no redirect row |
| 2. `apply.sql` against `aeci-app-production-us` | **done 2026-10-28 03:43 UTC**: 6 queries, 23 rows written. Run a second time by accident: 0 rows written |
| 3. Verify read | **done**: `superhuman`, `superhuman-docs`, 2 redirect rows, 2 audit rows |
| 4. Edge purge | **not needed**: every URL in step 7 was `cf-cache-status: MISS`, and detail pages cache for only 900 s |
| 5. Promote Superhuman Docs | **done 2026-10-28**, job `reckJV4j9DfOgCcUm-mvrkrpf3-37cd1835`. The name was already live. It ran to bring the slug back to the review app (step 6) |
| 6. Review-app `supabase_slug` check | **done**: the promote wrote back `superhuman` and `superhuman-docs`. The review app has no direct `supabase_slug` write, so a promote is the way to do it |
| 7. URL check | **done 2026-10-28**: `/vendors/coda`, `/products/coda` and `/products/coda/integrations/claude` 301 to the new slugs. Both new pages return 200 |

## What this changes

Coda was renamed Superhuman Docs on 2026-07-08. The review record is already renamed. The live slugs are not:

| Entity | id | Slug now | Slug after |
|---|---|---|---|
| vendor | `f13e7be3-317a-47b8-be47-de9ef26d8ac3` | `coda` | `superhuman` |
| product (Superhuman Docs) | `dee0b67c-160e-4804-a17a-4459dc6071ca` | `coda` | `superhuman-docs` |

`apply.sql` renames both in place and sets `updated_at`, so the Algolia delta sync picks the change up. It seeds one `slug_redirects` row per old slug (`DATABASE_SCHEMA.md` §4.3b), and the existing resolvers then 301 `/vendors/coda`, `/products/coda` and every `/products/coda/integrations/*` URL. It writes one `vendor.updated` / `product.updated` audit row per rename. No code ships with it.

**Why an ops script and not a migration.** A migration should only change data that migrations created (ruled 2026-10-28). These rows exist only in production. As a migration, the redirect rows would land on every fresh database and point at nothing.

**Safe to run twice.** Every statement is keyed on the production id and the old slug. Each audit row is written once. Tested on a scratch database built from all migrations: apply twice, then rollback twice, gave the expected rows each time. Apply on a database without these rows wrote nothing.

## Run order

Every command runs from `/tmp`, except the copy in step 0. Inside `apps/api`, wrangler's pinned account returns 7403, and the bare name `aeci-app-production` from `/tmp` reaches the retired APAC copy.

### 0. Copy the SQL to /tmp

Run this from the repo root.

```bash
cp scripts/ops/2026-10-coda-slug-rename/apply.sql scripts/ops/2026-10-coda-slug-rename/rollback.sql /tmp/
```

### 1. Preflight read

Expect the vendor and product at `coda`, no row already at `superhuman` or `superhuman-docs`, and no `coda` redirect row. Note `owned_at`: if it is set, promote skips the vendor in step 5 and the new name will not arrive that way.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT 'vendor' AS t, id, slug, company_name, owned_at FROM vendors WHERE id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3' OR slug IN ('coda','superhuman') UNION ALL SELECT 'product', id, slug, name, NULL FROM products WHERE id = 'dee0b67c-160e-4804-a17a-4459dc6071ca' OR slug IN ('coda','superhuman-docs') UNION ALL SELECT 'redirect', entity, from_slug, to_slug, NULL FROM slug_redirects WHERE from_slug = 'coda'"
```

### 2. Apply

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file apply.sql
```

`--file` reports a summary, not rows. A constraint failure shows only as `D1_RESET_DO`. If that happens, run the statements one at a time with `--command` to find which one failed.

### 3. Verify read

Expect both new slugs, two redirect rows, and two audit rows from `apply.sql`.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT 'vendor' AS t, slug AS a, updated_at AS b FROM vendors WHERE id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3' UNION ALL SELECT 'product', slug, updated_at FROM products WHERE id = 'dee0b67c-160e-4804-a17a-4459dc6071ca' UNION ALL SELECT 'redirect', entity, to_slug FROM slug_redirects WHERE from_slug = 'coda' UNION ALL SELECT 'audit', action, after_state FROM audit_log WHERE json_extract(metadata, '$.issue') = 'AECI-1495'"
```

### 4. Purge the edge

The SQL purges nothing, and editing the redirect map has no purge hook (`CACHE_STRATEGY.md` §3 rule 6). A cached old detail page serves until its 900 s `s-maxage` runs out, so first check whether a purge is needed at all. If one is, `POST /admin/purge` on the SSR Worker takes the `ADMIN_PURGE_TOKEN` bearer, not an admin session. That token lives in GitHub secrets. The body is:

```json
{ "tags": ["vendor:coda", "product:coda", "vendor:superhuman", "product:superhuman-docs"] }
```

`product:coda` also covers the pair pages, which embed both products' tags.

### 5. Promote Superhuman Docs from the review app

This brings the new vendor name across, purges the new-slug tags and marks the sitemap dirty. Promote never changes a slug, so it keeps the new ones.

### 6. Check the review app's slug copy

Read `supabaseSlug` on vendor `recTQ1St4mPQ4t0FK` and product `reckJV4j9DfOgCcUm`. The review app stores the slug from the promote response, and no tool writes `supabase_slug` directly. So step 5 is what fixes it, even when the name has already arrived.

### 7. URL check

Each line should print `301` and a `location` on the new slug. The WAF answers curl's default user agent with 403, so these send a browser user agent.

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" https://www.aecintegrations.com/vendors/coda | grep -iE "^HTTP|^location"
```

```bash
curl -sI -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" https://www.aecintegrations.com/products/coda | grep -iE "^HTTP|^location"
```

Also check one `/products/coda/integrations/*` URL taken from the live product page.

## Rollback

`rollback.sql` puts both slugs back, deletes the two redirect rows and writes one reversal audit row each. Run step 0 first if `/tmp` no longer holds the file, then purge the same four tags as step 4.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file rollback.sql
```
