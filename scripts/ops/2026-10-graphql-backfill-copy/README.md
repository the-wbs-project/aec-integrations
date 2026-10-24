# 2026-10 GraphQL backfill copy into the edge request log (AECI-1448)

Moves the Cloudflare GraphQL backfill out of the temporary bucket `aeci-views-temp` and into the edge
request log bucket `aeci-edge-log-prod-us`, under `graphql-backfill/`. Then removes the copied
backfill from the temporary bucket. ADR 0045 decided the destination. Both buckets are on The WBS Project account
(`004dc1af737b22a8aa83b3550fa9b9d3`).

| File | What it is | Touches Cloudflare? |
|---|---|---|
| `copy.mjs` | Lists, copies, uploads, verifies and prunes through R2's S3 API. No dependencies | Read and write |
| `manifest.csv` | One row per object under `graphql-backfill/`: key, source, bytes, SHA-256, data rows | No |

The pull scripts and column docs stay in `../2026-10-traffic-history/` and
`../2026-10-ai-assistant-fetch-history/`.

## `aeci-views-temp` is not deleted

The bucket also holds `old-account-final-export-2026-10-04/` (AECI-1167, 62 objects, about 350 MB). It
is the final export of the old AEC Integrations account: D1 dumps of all six old databases, production
included, plus Workers Logs, Workflow instances and a resource inventory. Its own `README.md` in the
bucket describes it. It is not traffic backfill and does not belong in the edge request log.

Ruled 2026-10-23 (Chris): the export stays in `aeci-views-temp`, and the bucket stays. `copy.mjs` reads,
copies and prunes only keys under `cloudflare-backfill-`. A permanent home for the export is
AECI-1464.

## What lands where

A source key keeps its path under the new prefix:

```text
aeci-views-temp/cloudflare-backfill-2026-10-01/...  ->  aeci-edge-log-prod-us/graphql-backfill/cloudflare-backfill-2026-10-01/...
aeci-views-temp/cloudflare-backfill-2026-10-13/...  ->  aeci-edge-log-prod-us/graphql-backfill/cloudflare-backfill-2026-10-13/...
```

The final pull goes straight to `graphql-backfill/cloudflare-backfill-<date>/new-zone-2246ff6d/`. It never
passes through the temporary bucket.

`graphql-backfill/` falls under the bucket's `delete-after-400-days` lifecycle rule, like the Logpush
prefixes. Each object is deleted 400 days after it was written here. Ruled 2026-10-22 (Chris).

## Rows

`rows` counts CSV records after the header. The count is quote-aware and runs after gunzip when the
bytes are gzip. A row is one GraphQL group, not one request. `verify` re-reads every destination
object and compares its SHA-256 and row count with the manifest.

## Credentials

A one-off R2 API token, Object Read & Write on `aeci-views-temp` and `aeci-edge-log-prod-us`. Chris
creates it in the dashboard and revokes it after step 5. It is not the Logpush writer token, which must
never be revoked. Keep the pair in a file only you can read:

```bash
umask 077 && cat > /tmp/aeci-1448.env <<'EOF'
export R2_BACKFILL_KEY_ID=''
export R2_BACKFILL_SECRET=''
EOF
```

## Run order

Run from the repo root. Start no earlier than the day after both Logpush jobs complete one full UTC
day, and after the AECI-1447 day-two check. The jobs started on 2026-10-22, so the earliest date is
2026-10-24.

1. Final pull, read-only, into `/tmp` so no data lands in the tree. `CF_READONLY_API_TOKEN` is in
   Conductor's environment.

   ```bash
   OUT_DIR=/tmp/aeci-1448/2026-10-traffic-history node scripts/ops/2026-10-traffic-history/pull.mjs
   ```

   ```bash
   mkdir -p /tmp/aeci-1448/2026-10-ai-assistant-fetch-history && node scripts/ops/2026-10-ai-assistant-fetch-history/pull.mjs /tmp/aeci-1448/2026-10-ai-assistant-fetch-history/fetches-new-zone.csv
   ```

   Check that the last hour in `http-requests` and `firewall-events` is on or after the first full
   Logpush day, 2026-10-23.

2. Inventory the source. Read-only. Writes `manifest.csv`.

   ```bash
   source /tmp/aeci-1448.env && node scripts/ops/2026-10-graphql-backfill-copy/copy.mjs inventory
   ```

3. Upload the final pull. Replace the date with the day of step 1.

   ```bash
   source /tmp/aeci-1448.env && node scripts/ops/2026-10-graphql-backfill-copy/copy.mjs upload /tmp/aeci-1448 cloudflare-backfill-2026-10-24/new-zone-2246ff6d
   ```

4. Copy the source, then verify everything. `verify` exits non-zero on any missing or changed object.

   ```bash
   source /tmp/aeci-1448.env && node scripts/ops/2026-10-graphql-backfill-copy/copy.mjs copy && node scripts/ops/2026-10-graphql-backfill-copy/copy.mjs verify
   ```

5. Remove the copied backfill from the temporary bucket. Irreversible. `prune-source` runs `verify`
   first and deletes nothing if it fails, or if the source holds a `cloudflare-backfill-` object the
   manifest lacks. It never touches the old-account export, and it does not delete the bucket.

   ```bash
   source /tmp/aeci-1448.env && node scripts/ops/2026-10-graphql-backfill-copy/copy.mjs prune-source --confirm aeci-views-temp
   ```

   Held for one week after the copy as a safety margin. Due on or after 2026-10-31 (AECI-1475).

6. Revoke the one-off R2 token. Print the row-count table for the READMEs:

   ```bash
   node scripts/ops/2026-10-graphql-backfill-copy/copy.mjs summary
   ```

## Run log

| Date (UTC) | Step | Result |
|---|---|---|
| 2026-10-23 | 2. `inventory` | 154 objects in the source. 92 are backfill; the other 62 are the old-account export, left out |
| 2026-10-24 | 1. Final pull | 2026-10-04T04:00Z to 2026-10-24T02:00Z. Overlaps Logpush (from 2026-10-22T07:24Z) by about 43 hours |
| 2026-10-24 | 3. `upload` | 25 objects under `cloudflare-backfill-2026-10-24/new-zone-2246ff6d/` |
| 2026-10-24 | 4. `copy`, `verify` | 92 copied, 0 skipped. `verify`: 117 objects, 890,363 rows, 0 failures, 0 unknown keys |
| Due 2026-10-31 | 5. `prune-source` | AECI-1475 |

Row counts per dataset are in `../2026-10-traffic-history/README.md` "Final pull 2026-10-24".

A re-run is safe. A destination key that already holds the same bytes is skipped. One that holds
different bytes stops the run. `inventory` stops without writing if a source row in the manifest is no longer
in `aeci-views-temp`, so a re-run after `prune-source` keeps the record of the copy.
