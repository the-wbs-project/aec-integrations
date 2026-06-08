# Algolia provisioning (`provision.mjs`)

Operator-run script that stands up one environment's Algolia search infrastructure for AECi (AECI-134 / Phase 3.1). It **provisions indexes and mints API keys only** — index _settings_ (searchable attributes, facets, ranking) land in Phase 3.2, sync in 3.5/3.6, and the InstantSearch UI in 3.9.

> ⚠️ **This script prints live API keys to stdout. Run it locally only. Never wire it into CI.**

## What it does (per `--env`)

1. **Ensures three indexes exist** — `<prefix>_products`, `<prefix>_vendors`, `<prefix>_integrations` — by applying _empty_ settings. The prefix is the env name; `development` folds onto `preview` (there is no `development_*` set).
2. **Mints two standalone, independently-rotatable keys**, each scoped to that env's three indexes:
   - **search-only key** — ACL `['search']` → the web Worker's `ALGOLIA_SEARCH_KEY` (client-exposed, query-only).
   - **management key** — ACL `search + addObject + deleteObject + editSettings + listIndexes` → the API Worker's `ALGOLIA_ADMIN_KEY` (server-only; used by sync from 3.5).
3. **Prints the exact `gh secret set` + `wrangler secret put` commands** to run next.

The index names and key ACL/scope shapes come from `packages/shared/src/algolia.ts` — the single source of truth shared with the Workers.

## Prerequisites

- Node ≥ 22.18 (native TypeScript type-stripping; the repo's `engines` floor of 22.22.3 satisfies it).
- `pnpm install` has run (provides the `algoliasearch` dependency).
- The AECi Algolia application exists and you have its **App ID** and the app-wide **root admin key**.

The root admin key is **operator-held**. It is used _only_ to run this script and is **never** pushed onto a Worker.

## Run

```bash
export ALGOLIA_APP_ID=…
export ALGOLIA_ADMIN_KEY=<root admin key>   # the app-wide ROOT key, not a scoped one

node scripts/algolia/provision.mjs --env preview
node scripts/algolia/provision.mjs --env staging
node scripts/algolia/provision.mjs --env production
```

Or via the package script: `pnpm algolia:provision --env staging`.

> Name overlap, by design: the env var `ALGOLIA_ADMIN_KEY` you export here is the **root** key (script input). The per-env **management** key the script _mints_ is _also_ surfaced as `ALGOLIA_ADMIN_KEY` on the API Worker — a different value in a different place. See `docs/CICD_PLAN.md` §7.5.

## Output

For each env the script prints the live `ALGOLIA_SEARCH_KEY` and `ALGOLIA_ADMIN_KEY` (management) values, then a copy-pasteable block of:

- `gh secret set ALGOLIA_APP_ID` (shared — set once), and `ALGOLIA_SEARCH_KEY_<ENV>` / `ALGOLIA_ADMIN_KEY_<ENV>` for staging/production.
- `wrangler secret put` for the web Worker (`ALGOLIA_APP_ID` + `ALGOLIA_SEARCH_KEY`) and the API Worker (`ALGOLIA_APP_ID` + `ALGOLIA_ADMIN_KEY`).

`preview` has no GitHub secret (per-PR previews are untouched until 3.9); push its Worker secrets directly.

## Idempotency & rotation

- **Re-running without `--rotate`** reuses keys already tagged for the env (it never creates duplicates) and re-applies empty settings (a no-op). Safe to run repeatedly.
- **`--rotate`** mints fresh keys for the env and deletes the old ones. Re-set the affected GitHub + Worker secrets and redeploy. Each env rotates independently (CICD §7.4). The root key stays operator-held throughout.

```bash
node scripts/algolia/provision.mjs --env staging --rotate
```

## Verify (in the Algolia dashboard, after a run)

- The three `<env>_*` indexes exist with **no** settings.
- The search key is `search`-only and scoped to exactly that env's three indexes.
- The management key has the index-mutation ACLs (no `deleteIndex`/`usage`/`logs`) and the same index scope.
- After `wrangler secret put` + deploy, `curl` the env's SSR HTML and confirm `window.__AECI_ALGOLIA__` carries the search key (admin key absent).
