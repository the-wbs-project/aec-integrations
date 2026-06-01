# ADR 0001: Cloudflare Workers (SSR + private API) over Vercel

**Status:** Accepted
**Date:** Stage 1 planning · **Recorded:** 2026-06-01 (written retroactively during the codebase audit; the decision predates this record)
**Context owner:** _unset — confirm_

> _The head-to-head rationale against Vercel is reconstructed from repo evidence (CLAUDE.md, `docs/CICD_PLAN.md`, the wrangler configs) during the 2026-06-01 audit. It reflects the observable architecture; the decision owner should confirm/correct the specifics._

---

## Context

AECi needs server-side rendering for SEO (it is a directory whose entire value is discoverability) plus a backend API that talks to Supabase. The hosting choice had to support: edge SSR, a backend **not** exposed to the public internet, cache invalidation by entity, object storage for DB snapshots, and access control for non-prod environments.

## Decision

Host the whole app on **Cloudflare Workers**:

- An **SSR Worker** (`apps/web`) running `@angular/ssr` with `compatibility_flags: ["nodejs_compat"]`.
- A **private API Worker** (`apps/api`) reached only over a Cloudflare **service binding** (`env.API`) — no public ingress on the API's own hostname (`workers_dev: false`).
- Supporting Cloudflare primitives: **R2** (prod DB snapshots), **Cloudflare Access** (non-prod allowlist), **purge-by-Cache-Tag** (see ADR 0004), and the Datadog Worker SDK for logs.

Chosen over Vercel.

## Consequences

- ➕ The API Worker is private **by construction** (service binding), not by firewall configuration.
- ➕ One integrated edge platform for compute + R2 + Access + cache purge + service bindings; one vendor, one `wrangler` toolchain.
- ➕ Edge-native SSR with per-entity cache invalidation.
- ➖ `@angular/ssr` needs `nodejs_compat` polyfills (a Workers-specific wrinkle); the DB path deliberately avoids Node APIs via Accelerate (ADR 0002).
- ➖ The Workers execution model (isolate-per-request, no durable TCP pools) shapes downstream decisions — notably Accelerate over a pg pool (ADR 0002), and Cloudflare-account-level rate limits over in-isolate buckets.
- ➖ Note: the SSR Worker re-exposes `/api/*` to the public internet via a passthrough, so the API is private only on its own hostname — per-endpoint auth on write routes is therefore mandatory (see the promote/admin-purge auth and the legacy-route review).
