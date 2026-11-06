# 2026-11 brand asset backfill (AECI-1618)

**Status: NOT RUN.** Update this line at each step, per environment.

Migration `0103_tricky_beast.sql` adds the columns empty. These two scripts fill them for rows that existed before it. ADR 0051 and `DATABASE_SCHEMA.md` §4.1 have the model.

| Script | What it fills |
|---|---|
| `sourced-logo-apply.sql` | `sourced_logo_url` on vendors and products a local save overwrote. The value is the logo before the first logo edit, when promote still owned it. |
| `claim-ended-apply.sql` | `claim_ended_at` on owned vendors with no unbanned seat. The value is the last seat revoke, else the moment the script runs. |

Each has a `*-dry-run.sql` that writes nothing. Both are safe to run twice: they only fill an empty column.

## Run order matters

**Run the sourced-logo backfill first.** The claim-ended backfill makes every company it touches due at the next 16:00 UTC removal run. That run sets `logo_url` to `sourced_logo_url` and clears `logo_source`. If `sourced_logo_url` is still empty, the AECi logo is gone. The sourced-logo backfill cannot repair it afterwards, because it only reads rows whose `logo_source` is still set. Promote cannot repair it either while the vendor is owned.

Run both on the same day, before 16:00 UTC, so no claim end lands between them.

## Steps, per environment

The commands below are for production. For staging or demo, swap the database name for the one in that environment's `d1_databases` block of `apps/api/wrangler.jsonc`. Every command runs from `/tmp`, as in `scripts/ops/2026-10-coda-slug-rename/README.md`. The bare name `aeci-app-production` from `/tmp` reaches the retired APAC copy, so production uses `aeci-app-production-us`.

### 0. Copy the SQL to /tmp

Run this from the repo root.

```bash
cp scripts/ops/2026-11-brand-asset-backfill/*.sql /tmp/
```

### 1. Sourced-logo dry run

`--file` never returns rows, so the dry runs use `--command`. Check each `sourced_logo_url` the dry run proposes is an AECi logo, not a vendor upload.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "$(cat sourced-logo-dry-run.sql)"
```

### 2. Sourced-logo apply

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file sourced-logo-apply.sql
```

Run step 1 again. It should return no rows.

### 3. Claim-ended dry run

Each row becomes due at the next 16:00 UTC run. A company that should keep its logos for now needs an operator hold from `/admin/vendors` after step 4. A hold cannot last past 13 days after the claim end, and a backfilled date in the past may already be beyond that.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "$(cat claim-ended-dry-run.sql)"
```

### 4. Claim-ended apply

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file claim-ended-apply.sql
```

Run step 3 again. It should return no rows. "Pending logo removals" under `/admin/vendors` now lists the companies.

### 5. Edge cache

The SQL purges nothing. Detail pages cache for 900 s, so they show Unclaimed within 15 minutes without a purge. To repaint at once, `POST /admin/purge` on the SSR Worker with the `vendor:{slug}` and `product:{slug}` tags of each company from step 3. It takes the `ADMIN_PURGE_TOKEN` bearer, which lives in GitHub secrets.

### 6. Algolia

The claim-ended script stamps `updated_at` on the vendors and products it changes, so the nightly sync picks them up. The sourced-logo script leaves `updated_at` alone, because nothing public renders that column. Never-owned listings changed at deploy without an `updated_at` move, so their search records keep a logo until a full rebuild. Run the datatool reindex for this environment (`RUNBOOKS.md`, `POST /api/reindex` on `apps/datatool`).
