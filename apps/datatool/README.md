# `@aeci/datatool` — internal D1 copy / seed / reindex tool

A small Cloudflare-Access-gated admin Worker + web UI that does two jobs across the
four D1 environments (`preview` / `staging` / `demo` / `production` — one per deploy
tier, `docs/environments.md`):

1. **Copy data env→env** — a **full clone** in **replace/mirror** mode: the
   destination becomes an exact copy of the source, table for table.
2. **Seed reviews** — generate ~150–200 deterministic anonymous reviews against
   any env's products (the in-Worker port of `apps/api db:seed-reviews`).

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
```

**Determinism cross-check:** the same `seed` yields byte-identical review ids in
the Worker and the CLI (both call the shared `buildPlan`). Compare the Worker's
seeded ids against `pnpm --filter @aeci/api db:seed-reviews -- --seed=24301` (dry-run
writes `seed/reviews.sql`).

## Tests

```bash
pnpm --filter @aeci/datatool test       # 28 specs: introspect/copy/seed/reindex/routes
pnpm --filter @aeci/datatool typecheck
```

Tests run against an in-memory better-sqlite3 D1 shim (`src/test/d1.ts`) that applies
the real `apps/api/migrations`, so the schema/FKs/constraints are real.
