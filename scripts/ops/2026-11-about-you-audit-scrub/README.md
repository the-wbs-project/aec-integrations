# About-you audit scrub (AECI-1869)

**Status: done on all three environments (2026-11-17 to 2026-11-18).** The staging and demo bookmarks and the deploy checks were not recorded here.

| Environment | Deployed with the AECI-1869 code | Bookmark | Count before | Count after |
|---|---|---|---|---|
| `aeci-app-staging` | Not recorded | Not recorded | 1 | 0 |
| `aeci-app-demo` | Not recorded | Not recorded | 3 | 0 |
| `aeci-app-production-us` | Not recorded | `00001b85-00000350-00005127-1e99fbb18894bea3c214e75fcc3e7622` | 4 | 0 |

## What this changes

The Privacy Policy says: "About you answers: for as long as your account exists. They are deleted when you delete your account." Account deletion keeps audit rows (`AUTH_AND_RLS.md` §8). Before AECI-1869, every About-you edit wrote a `profile.updated` row with the before and after values. So the firm name, LinkedIn link and other answers outlived the account.

Since AECI-1869, the code writes no About-you values to the audit record. The row lists which answers changed in `metadata.about_you_fields`. This script removes the values from rows written before that.

- `apply.sql` removes six keys from `before_state` and `after_state` on `profile.updated` rows: `company_type`, `company_size`, `primary_role`, `firm_name`, `linkedin_url` and `audience_ids`. They match the first six of `ABOUT_YOU_AUDIT_KEYS` in `apps/api/src/routes/account.ts`. Its seventh, `found_via_detail` (AECI-2208), was never stored by value.
- Other keys stay: `display_name`, `listing_view_preference` and `onboarding`. So does `found_via`, which AECI-2208 audits by value on purpose (Chris's ruling 1 of 2026-11-26). Do not add it to the scrub. The Privacy Policy's Retention list says the audit record keeps that choice.
- A state left empty becomes NULL, which is what the code writes now.
- Each changed row gets `metadata.about_you_scrubbed = "AECI-1869"`.
- The script writes one `system` audit row, `audit_log.about_you_scrubbed`, with the number of rows changed in `metadata.rows`.
- `count.sql` is read-only. It counts the rows that still hold any of the six keys.

**Why an ops script and not a migration.** These rows exist only in deployed databases. A migration should only change data the migrations created (ruled 2026-10-28).

**Safe to run twice.** The UPDATE matches only rows that still hold a key. The marker row is written only when there is at least one such row. This was tested on a scratch database built from every migration: two runs gave one marker row and a count of 0. The test rows covered `display_name` and `onboarding` keeping their values, a state that ended up empty becoming NULL, a new-shape row staying untouched, and another action's `firm_name` staying untouched.

**No rollback.** `rollback.sql` only prints a note. The scrub deletes values the policy says are gone, and no copy is kept. Restore the step-1 Time Travel bookmark only if the scrub broke something, and run `apply.sql` again straight after. Do not restore it for any other reason.

## Run order

Run each environment only after the AECI-1869 code is deployed to it. Otherwise a new edit writes values again after the scrub. Do staging first, then demo, then production.

The commands below are for production. For staging and demo, run the same four steps with `aeci-app-staging` or `aeci-app-demo` in place of `aeci-app-production-us`. Every command runs from `/tmp`, except the copy in step 0. The bare name `aeci-app-production` reaches the retired APAC copy.

### 0. Copy the SQL to /tmp

Run this from the repo root.

```bash
cp scripts/ops/2026-11-about-you-audit-scrub/apply.sql scripts/ops/2026-11-about-you-audit-scrub/count.sql /tmp/
```

### 1. Record a Time Travel bookmark

Write the bookmark into the table above.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 time-travel info aeci-app-production-us
```

### 2. Count before

`--file` returns no rows, so the count goes through `--command`.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "$(grep -v '^--' count.sql)"
```

### 3. Apply

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --file apply.sql
```

### 4. Count after

Run step 2 again. It must return `0`. The marker row's `metadata.rows` must equal the step-2 count.

```bash
cd /tmp && CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 env -u CLOUDFLARE_API_TOKEN npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT created_at, metadata FROM audit_log WHERE action = 'audit_log.about_you_scrubbed'"
```

When production reads 0, comment the counts on AECI-1869. The issue can then close.
