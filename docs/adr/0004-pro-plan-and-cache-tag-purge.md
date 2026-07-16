# ADR 0004: Cloudflare Pro plan + purge-by-Cache-Tag (not purge-by-URL)

> **⚠️ Amended by [ADR 0020](0020-workers-cache-and-queue-purge.md) (2026-07-12, AECI-314).** Purge-by-**Cache-Tag** is **retained**, but the *transport* moves from the zone HTTP purge API (`POST /zones/{zone}/purge_cache`, ≤30 tags/call) to native Workers Cache `ctx.cache.purge({ tags })` (≤1000 tags/response), issued from inside the SSR Worker via a Cloudflare Queue. `Cache-Tag` emission and the tag vocabulary are unchanged. The zone HTTP purge is **inert** against Workers Cache — see ADR 0020.

> _Renamed from the placeholder `0004-pro-plan-purge-by-url` — purge is by **Cache-Tag**, not by URL. The URL-invalidation approach (`STAGE_1_SPEC.md §9.3` `invalidateForEntity()`) is superseded._

**Status:** Accepted (a CLAUDE.md non-negotiable)
**Date:** Phase 2 · **Recorded:** 2026-06-01
**Context owner:** _unset — confirm_

---

## Context

A single write changes many cached URLs at once — a product appears on its detail page, the products index, vendor pages, and taxonomy browse pages. Invalidating by enumerating URLs is brittle and incomplete. Cloudflare's `Cache-Tag` response header plus purge-by-tag lets one write invalidate every page carrying an entity's tag. As of **April 2025**, purge-by-tag is available on **all** Cloudflare plans; AECi runs on **Pro**.

## Decision

- Run on the Cloudflare **Pro** plan.
- Every cacheable SSR response sets a `Cache-Tag` via the AECI-56 helper (`apps/web/src/server/cache-tags.ts`).
- Invalidation goes through `POST /admin/purge` with a tag list (Cloudflare purge-by-tag, ≤30 tags/call).
- The older URL-invalidation-map approach in `STAGE_1_SPEC.md §9.3` (`invalidateForEntity()`) is **superseded**.
- `Vary: Accept-Language` is permitted (URL-prefix locale dispatch already handles real variance); any other `Vary` value (`Cookie`, `User-Agent`, …) is forbidden.

## Consequences

- ➕ One write purges all affected URLs by entity tag, without enumerating them.
- ➕ Works on Pro — no Enterprise requirement.
- ➖ Tag discipline is load-bearing: a cacheable response that ships without its entity tag becomes un-purgeable (tracked: cache-tag coverage; promote→purge wiring in AECI-105).
- ➖ Docs that still reference `invalidateForEntity()` (e.g. the CICD_PLAN rollback runbook) are drift and must be corrected (tracked in AECI-106).
