# Unsourced company facts on non-owned vendors (AECI-1634)

**Status:** done on production, 2026-11-06. The list found three vendors. SafetyStack Ltd gained its Companies House source. Howell Commerce Co. and AEC Stack had both facts cleared upstream. All three were re-promoted, and the list now returns no rows. Staging was not run.

`list.sql` is read-only. It lists live vendors that do not own their record and hold a `headquarters` or `founded_year` with no source URL. The vendor page hides such a value (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23). Search, cards, Algolia and the JSON-LD still show it until AECI-1635 lands. A value an active AECi correction still holds is left out, because it shows with the correction's source.

## Run the list

The list goes through `--command`, because `--file` returns no rows. Wrangler reads a leading `--` line as an argument, so the comment lines are stripped first. Run this from the repo root.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx --prefix "$OLDPWD/apps/api" wrangler d1 execute aeci-app-production-us --remote --json --command "$(grep -v '^--' "$OLDPWD/scripts/ops/2026-11-unsourced-company-facts/list.sql")"
```

Production is `aeci-app-production-us`. The bare `aeci-app-production` reaches the retired APAC copy.

## How a listed row is fixed

Fix the review app first, then promote. Promote writes what the review app sends, so a D1-only clear comes back on the next promote.

1. In the review app, either attach a permitted source URL to the fact, or clear the fact.
2. Promote one of the vendor's products. Promote writes the value, its source URL and its check date.
3. Run the list again. The vendor must be gone from it.

No D1 write script is needed while every listed vendor has a live product. A vendor with no product needs an ops script that writes its `audit_log` row in the same file and moves `updated_at`, as `scripts/ops/2026-11-brand-asset-backfill/sourced-logo-apply.sql` does.
