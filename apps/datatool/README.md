# `@aeci/datatool` — internal D1 copy / seed / reindex tool

A small Cloudflare-Access-gated admin Worker + web UI that does three jobs across the
four D1 environments (`preview` / `staging` / `demo` / `production` — one per deploy
tier, `docs/environments.md`):

1. **Copy data env→env** — a **full clone** in **replace/mirror** mode: the
   destination becomes an exact copy of the source, table for table.
2. **Seed reviews** — generate ~150–200 deterministic anonymous reviews against
   any env's products (the in-Worker port of `apps/api db:seed-reviews`).
3. **Prune orphaned integrations** — delete stranded `integrations` rows (+ their
   claims/attestations) that no Airtable record points at, behind three blocking
   guards (the in-Worker port of
   `scripts/ops/2026-08-orphan-integration-cleanup/cleanup.sh`).

After either write it runs a **clean Algolia reindex** + **edge-cache purge** of
the destination, so search and the site reflect the new data immediately. The purge
is enqueued onto the destination tier's `aeci-cache-purge-{env}` queue (WC-7), which
that tier's own SSR Worker consumes.

> ⚠️ **This is a standing, browser-reachable endpoint (behind Access) that can
> wipe-and-replace the PRODUCTION database, including auth-linked tables.** Writes
> are dry-run by default, require typing the destination DB name, and production
> needs an extra explicit confirm — but the capability is real. Treat the Access
> allowlist and the `TOOL_TOKEN` secret accordingly.

## How it works (and what it deliberately doesn't)

- **Copy = replace/mirror, all tables.** Discovers every user table at runtime
  (`introspect.ts`, excluding `sqlite_%` / `_cf_%` / `d1_migrations`), topologically
  orders by FK, clears the destination child-first, and reloads parent-first. The
  one self-FK (`vendor_requests.duplicate_of_request_id`) is nulled then restored.
  Ordering — not deferred FKs — is the correctness contract.
- **Cross-env auth coherence (post-ADR 0017).** A full clone copies `profiles` /
  `reviews` / `audit_log` etc. whose ids reference Supabase `auth.users`. Per
  [ADR 0017](../../docs/adr/0017-single-supabase-auth-project-across-environments.md)
  **all four tiers share one auth project** (`ktuhnlypztujpsseujzx`), so those
  referenced users exist everywhere — a clone between **any** two tiers
  (preview/staging/demo/production) stays sign-in-coherent. (This retires the
  earlier two-project caveat, where a prod↔dev clone left auth-linked rows orphaned;
  D1 has no auth FK regardless, so the insert always succeeds.)
- **Not globally atomic.** A clone spans many tables / batches; a mid-clone failure
  leaves the destination partially replaced — **re-run** (replace is idempotent).
- **`promote_jobs` is cloned too, and that is correct** (AECI-571). The table is the
  promote ingest's exactly-once ledger, keyed by job id, holding the committed ID map
  as JSON — so it must travel with the rows it describes, or a replayed job id in the
  clone would resolve to ids that no longer exist there. One thing to watch: it is the
  first table whose rows can reach ~100 KB (typical ~10 KB, capped at 512 KiB) and
  `copy.ts` pages `READ_PAGE = 2000` rows into Worker memory at a time. Fine today;
  once the table passes roughly 5k rows, either prune it (≥ 90-day floor — see
  `DATABASE_SCHEMA.md` §8.5) or give wide tables a smaller page size.
- **Algolia reindex = clear + repopulate, promoted-only.** The incremental cron
  can't self-heal a clone (it syncs by an `updated_at` watermark the clone
  overwrites, and `scripts/algolia-bulk-sync.ts` doesn't exist yet), so datatool
  rebuilds `{env}_products|vendors|integrations` from the fresh D1. `clear` keeps
  index settings/replicas; there's a brief empty-index window (acceptable here).
- **Edge-cache purge = queue enqueue, `purgeEverything` (WC-7 / AECI-321).** A
  clone/seed invalidates the whole cache, so after the reindex the tool enqueues a
  single `{ purgeEverything: true, source: 'datatool' }` message onto the
  **destination tier's** `aeci-cache-purge-{env}` queue (WC-5 / ADR 0020); that tier's
  own SSR Worker consumes it and evicts its native Workers Cache. Per-Worker caches →
  **no cross-tier bleed**. `preview` has no queue → graceful no-op; a `queue.send`
  failure never fails the write. (The old zone HTTP purge is inert against Workers
  Cache, hence the queue.) No CF secret is needed — the producer bindings
  `CACHE_PURGE_QUEUE_{STAGING,DEMO,PRODUCTION}` are declared in `wrangler.jsonc`.
- **Prune takes the id list as INPUT, and does not derive it.** "Orphan" means
  *no Airtable record points at this row* — deciding that requires reading the
  AEC Integrations base, which this Worker deliberately holds no credentials for.
  So the operator supplies the ids (the ops runbook's `orphan-ids.txt` produces
  them) and datatool owns the dangerous half: guards, rollback SQL, an ordered
  delete, count repair, and the refresh. That split also keeps the tool reusable
  for any future stranded-row set instead of hard-coding one batch.
- **Three guards block the prune**, and a non-zero value on *any* of them refuses
  the run — on the execute path too, not just in the dry-run summary. Each means
  "this row is not actually a redundant copy": `claimsUniqueToOrphans` (the
  cascade would destroy curation, not a duplicate), `orphansWithoutATwin` (no
  surviving row shares its source/target/mechanism — it is the only copy), and
  `orphansRicherThanTwin` (its `description`/`notes` are longer than its twin's,
  so editorial content would be lost).
- **A tripped guard is overridable, but only by name and with a reason.** "Not a
  redundant copy" is usually a reason to stop — but not always: when a curator has
  *editorially retracted* an edge (deleted the Airtable record on purpose), the live
  D1 row must go even though it has no twin, because promote has no delete semantics
  and nothing else will ever remove it (AECI-593). So the execute path accepts
  `acknowledgeGuards` + `acknowledgeReason`:

  ```jsonc
  { "target": "production", "ids": "…", "dryRun": false,
    "confirmName": "aeci-app-production", "prodConfirm": true,
    "acknowledgeGuards": ["claimsUniqueToOrphans", "orphansWithoutATwin"],
    "acknowledgeReason": "AECI-593: curator ruled 2026-08-09 …" }
  ```

  The acknowledged set must **exactly equal** the dry run's `blocked` list — not a
  superset, not a subset. Naming a guard that reads zero proves the plan under review
  is not the plan that just ran (the data moved, or the wrong ids were pasted), so the
  run refuses rather than proceeding on a stale understanding. The reason is mandatory
  (min 20 chars) and is load-bearing: a prune writes **no** `audit_log` row, so the
  `datatool.operation` log line — operator identity, guards, reason — is the only
  durable record of why a guard was overridden. The UI renders a checkbox per tripped
  guard straight from the dry-run response, so you cannot tick one the plan did not
  report.

  Error codes: `GUARD_TRIPPED` (409, a tripped guard is unacknowledged),
  `GUARD_ACK_STALE` (400, acknowledged a guard that reads zero), `ACK_REASON_REQUIRED`
  (400), `BAD_ACK_GUARDS` (400, unknown guard name). The production double-confirm
  still applies on top.
- **Prune repairs `integration_count` itself.** The column is denormalized, so
  the instant the rows are gone every affected product card overstates its count;
  leaving that to a follow-up CLI run is how drift ships. Same rule as
  `apps/api/src/lib/recompute-counts.ts` (source OR target). The reindex that
  follows is also what evicts the deleted objects from Algolia, so there is no
  separate `ops:purge-algolia-orphans` step.
- **Rollback SQL, not a backup file.** A Worker has no filesystem, and D1 has no
  undo — so *every* prune response (dry-run included) carries a complete
  `rollbackSql`: parent→child `INSERT OR IGNORE` statements recreating everything
  the delete removes. **Save it before executing.**
- **LOCAL D1 is out of scope.** A deployed Worker can't reach a dev's
  `.wrangler/state`. For local seeding use `pnpm --filter @aeci/api db:seed-reviews`.

## API

All routes are `POST` and gated by `requireAccess` (Cloudflare Access JWT, or
`Authorization: Bearer <TOOL_TOKEN>`). `GET /` (UI) and `GET /api/version` are
ungated (the edge Access gates the host).

| Route | Body | Notes |
|---|---|---|
| `/api/copy` | `{ source, dest, dryRun?, confirmName?, prodConfirm?, refresh? }` | `dryRun` defaults **true** (per-table count diff). Execute needs `confirmName === "aeci-app-<dest>"`; `dest:"production"` needs `prodConfirm:true`. |
| `/api/seed` | `{ target, action:"apply"\|"teardown", seed?, dryRun?, confirmName?, prodConfirm?, refresh? }` | `seed` default `24301` (`0x5eed`). Same confirm rules. |
| `/api/reindex` | `{ target, entities?, purge? }` | Rebuild search from current D1 (no DB write). |
| `/api/prune-integrations` | `{ target, ids, dryRun?, confirmName?, prodConfirm?, refresh? }` | `ids` = a JSON array **or** a pasted blob (newline/comma separated); non-UUIDs throw rather than being dropped, max 500. `dryRun` defaults **true**. Returns `footprint`, `guards`, `blocked`, `affectedSlugs`, and `rollbackSql`. A tripped guard ⇒ **409 `GUARD_TRIPPED`**; same confirm rules as above. |

`refresh` defaults **true** (reindex + cache purge after a write); set `false` to
skip. The reindex is a graceful no-op without Algolia creds; the purge is a no-op on
a tier with no cache-purge queue (`preview`, local).

## Deploy (manual — not in CI, like `apps/landing`)

```bash
pnpm install
pnpm --filter @aeci/datatool deploy   # wrangler deploy + COMMIT_SHA/DEPLOYED_AT --var
```

Needs `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit + D1: Edit on all three DBs) +
`CLOUDFLARE_ACCOUNT_ID`, or `wrangler login`. Publishes to
`https://aeci-datatool.aec-integrations.workers.dev`.

### One-time config

1. **`ACCESS_TEAM_DOMAIN`** in `wrangler.jsonc` — set to
   `aecintegrations.cloudflareaccess.com` (the `AEC Integrations` Zero Trust org,
   `docs/access.md` §1). This enables the in-Worker Access-JWT path, so an
   allowlisted operator hitting the browser UI can run the `/api/*` routes with no
   `TOOL_TOKEN`. ✅ Done.
2. **Secrets** (`wrangler secret put <NAME>` — all optional / graceful-skip).
   With step 1 done, the browser path already works; these add reindex and a
   curl/CI fallback:
   - `TOOL_TOKEN` — bearer fallback for curl/CI (and a belt-and-suspenders auth).
   - `ALGOLIA_APP_ID` + `ALGOLIA_ADMIN_KEY` — reindex. **Single shared values** (one
     Algolia app; the admin key reaches every `{env}_*` index — only the index prefix
     is per-env, derived from the target). Same un-suffixed values the `apps/api` /
     `apps/web` Workers receive from the `ALGOLIA_*` GitHub secrets — provision once,
     not per-env.
   - The **cache purge needs no secret** since WC-7: it enqueues onto the target
     tier's `aeci-cache-purge-{env}` queue (producer bindings in `wrangler.jsonc`).
     `CF_PURGE_API_TOKEN` / `CF_ZONE_ID` are no longer used (they backed the old zone
     HTTP purge) — retired in WC-10; leave them unset.

   **Deploy prerequisite:** the three `aeci-cache-purge-{staging,demo,production}`
   queues must already exist (provisioned by the WC-5 SSR/API deploy workflows). If
   they don't yet, `wrangler queues create aeci-cache-purge-<tier>` before deploying.
3. **Access** — the `*.aec-integrations.workers.dev` host is already covered by the
   single `AECi Non-Prod` app (`docs/access.md`); **no new Access app/policy**.
   Verify: `curl -I https://aeci-datatool.aec-integrations.workers.dev` → `302` to
   `cloudflareaccess.com`; a browser hit prompts the OTP for the allowlist.

## Verify (preview → staging; never test against production)

```bash
H=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" -H 'content-type: application/json')
U=https://aeci-datatool.aec-integrations.workers.dev

# Copy dry-run → execute
curl -s "${H[@]}" -d '{"source":"preview","dest":"staging","dryRun":true}'  $U/api/copy   # per-table counts
curl -s "${H[@]}" -d '{"source":"preview","dest":"staging","dryRun":false,"confirmName":"aeci-app-staging"}' $U/api/copy

# Confirm dest mirrors source + Algolia matches the promoted count
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-staging --env staging --remote \
  --command "SELECT (SELECT count(*) FROM products) p, (SELECT count(*) FROM integrations) i"
#   compare with Algolia: GET https://$ALGOLIA_APP_ID-dsn.algolia.net/1/indexes/staging_products → nbHits

# Seed dry-run → apply → teardown
curl -s "${H[@]}" -d '{"target":"staging","action":"apply","dryRun":true}'  $U/api/seed   # plan summary
curl -s "${H[@]}" -d '{"target":"staging","action":"apply","dryRun":false,"confirmName":"aeci-app-staging"}' $U/api/seed
curl -s "${H[@]}" -d '{"target":"staging","action":"teardown","dryRun":false,"confirmName":"aeci-app-staging"}' $U/api/seed

# Prune orphans: dry-run, SAVE the rollback, then execute
IDS=$(paste -sd, - < scripts/ops/2026-08-orphan-integration-cleanup/orphan-ids.txt)
curl -s "${H[@]}" -d "{\"target\":\"staging\",\"ids\":\"$IDS\"}" $U/api/prune-integrations \
  | tee /tmp/prune-plan.json | jq '{found, footprint, guards, blocked, affectedSlugs}'
jq -r .rollbackSql /tmp/prune-plan.json > /tmp/prune-rollback.sql   # ← keep this
curl -s "${H[@]}" -d "{\"target\":\"staging\",\"ids\":\"$IDS\",\"dryRun\":false,\"confirmName\":\"aeci-app-staging\"}" $U/api/prune-integrations

# If (and only if) an editorial ruling retracted the content, acknowledge exactly the
# guards the dry run reported. `blocked` is pasted back verbatim — no hand-typing.
ACK=$(jq -c .blocked /tmp/prune-plan.json)
curl -s "${H[@]}" -d "{\"target\":\"staging\",\"ids\":\"$IDS\",\"dryRun\":false,\"confirmName\":\"aeci-app-staging\",\"acknowledgeGuards\":$ACK,\"acknowledgeReason\":\"AECI-NNN: <the ruling, and where it is recorded>\"}" $U/api/prune-integrations
```

**Rollback** (D1 has no undo; the saved SQL is the undo):

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-staging --env staging --remote \
  --file=/tmp/prune-rollback.sql
```

**Determinism cross-check:** the same `seed` yields byte-identical review ids in
the Worker and the CLI (both call the shared `buildPlan`). Compare the Worker's
seeded ids against `pnpm --filter @aeci/api db:seed-reviews -- --seed=24301` (dry-run
writes `seed/reviews.sql`).

## Tests

```bash
pnpm --filter @aeci/datatool test       # 49 specs: introspect/copy/seed/reindex/prune/routes
pnpm --filter @aeci/datatool typecheck
```

Tests run against an in-memory better-sqlite3 D1 shim (`src/test/d1.ts`) that applies
the real `apps/api/migrations`, so the schema/FKs/constraints are real.
