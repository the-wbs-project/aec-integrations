# ADR 0010: Promote purges Cloudflare directly (remove the web↔api binding)

**Status:** Accepted
**Date:** 2026-06-05
**Context owner:** chrisw@thewbsproject.com
**Supersedes (mechanism only):** the AECI-105 api→web `WEB` service-binding purge path

---

## Context

`POST /api/promote` (API Worker) mutates cacheable pages, so after the transaction commits it purges the affected `Cache-Tag`s. As originally built (AECI-105), the API Worker did this by calling the SSR Worker's `POST /admin/purge` over a **`WEB` service binding** — the inverse of the SSR Worker's `API` binding. That created a deliberate **web↔api cycle** with three costs:

1. **A binding cycle.** Benign at runtime (no recursion — `/admin/purge` never calls back into the API), but awkward, and load-bearing only for one call.
2. **Deploy-ordering divergence.** The `WEB` binding could only be declared on `staging` + `production`, where the SSR Worker is long-lived. It was deliberately omitted on `preview`, because per-PR previews deploy an ephemeral `aeci-web-pr-<N>` *after* the API, so there is no stable `aeci-web` to bind. The config therefore diverged per environment.
3. **A shared secret.** The API presented `ADMIN_PURGE_TOKEN` (a copy of the SSR Worker's secret) on every call.

The reframing that drove this decision: the purge is **not** "on" the SSR Worker in any runtime sense. `callCloudflarePurge` is a stateless HTTPS POST to `https://api.cloudflare.com/.../zones/{zone}/purge_cache`. It touches none of the SSR Worker's cache/render state. The SSR Worker was merely the custodian of the `CF_PURGE_API_TOKEN`. So the binding existed only to broker an outbound REST call on the API's behalf.

Alternatives considered:

- **Option A — keep the binding, swap HTTP+bearer for typed RPC.** Removes the token dance but keeps the cycle and the deploy-ordering divergence. Rejected.
- **Option C — a Cloudflare Queue consumed by the SSR Worker.** Decouples producers from the purge, adds retry/DLQ durability, smooths bulk-purge 429s, and centralizes the token on one consumer. Genuinely better *when there are multiple cross-Worker purge producers and bulk-purge volume* — neither is true today (promote is the only cross-Worker producer). Deferred, not rejected: it is the documented evolution if Phase 5/6 write paths or bulk promotes justify the extra infra.
- **Option B (chosen) — let the producer purge Cloudflare directly.**

## Decision

- The API Worker calls Cloudflare's purge-by-tag API **directly** after a promote commits. The transport (`callCloudflarePurge`) is extracted to **`@aeci/shared`** (`packages/shared/src/cache-purge.ts`) so the SSR Worker's `POST /admin/purge` and the API's promote path share one implementation.
- The API Worker is provisioned with its own `CF_PURGE_API_TOKEN` (Wrangler secret) + `CF_ZONE_ID`, scoped to `Zone.Cache Purge` on `aecintegrations.com` **only** — identical minimal scope to the SSR Worker's token.
- The `WEB` service binding is **removed** from `apps/api/wrangler.jsonc` (both `staging` and `production`), along with the API Worker's `ADMIN_PURGE_TOKEN`.
- `POST /admin/purge` on the SSR Worker **stays** as the manual incident-response + CI surface (e.g. the `promote-to-prod.yml` taxonomy-seed purge). It is unchanged except for delegating to the shared transport.
- Behaviour preserved: the purge remains best-effort, post-commit (`ctx.waitUntil`), never fails the committed promote, and emits `aeci.cache.purge{source:promote,outcome:ok|cf_failed}` (now from the API Worker). When credentials are absent (local `pnpm dev:bound`, PR previews) it is a graceful no-op.

## Consequences

- ➕ The web↔api cycle is gone. The API depends only on Cloudflare's public API for purge.
- ➕ Per-environment config converges — no more "bound on staging/prod, omitted on preview" caveat. Purge is now gated purely by credential presence, uniformly.
- ➕ No shared `ADMIN_PURGE_TOKEN` between the two Workers.
- ➕ One purge transport (`@aeci/shared`), used by both call sites; the CF contract is defined once.
- ➖ `CF_PURGE_API_TOKEN` (same scope) now lives on **two** Workers. Mild secret sprawl — both must be rotated together. A Queue (Option C) would re-centralize the token on a single consumer; revisit if a second cross-Worker producer appears.
- ➖ **Operational step:** before promote purge works in an environment, the API Worker needs `CF_PURGE_API_TOKEN` (secret) and `CF_ZONE_ID` provisioned. Until then promote no-ops the purge and pages fall back to their edge TTL (≤15 min) — no correctness regression.
- ➖ The `aeci.cache.purge` metric for promotes now carries `worker:aeci-api` instead of `worker:aeci-web`. Dashboards/monitors that pivot on `worker` for this metric should account for both.
