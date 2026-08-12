# ADR 0021: Promote ingest runs in a Cloudflare Workflow, keyed by a caller-supplied job ID

**Status:** Accepted
**Date:** 2026-08-12
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-563 (this change), AECI-561 (epic), AECI-567 / AECI-570 (the review-app half, other repo); narrows ADR 0013's cron→queue posture for a *request*-triggered job; ADR 0016 (D1 has no interactive transactions)

---

## Context

`POST /api/promote` ran the whole plan-then-batch ingest inline and returned the assigned IDs in its response body. That coupled the **durability of a committed write** to the **survival of an HTTP connection**, and the two came apart in production:

- The review app aborts the push at `PROMOTE_TIMEOUT_MS = 30_000`. AECi commits anyway.
- The atomic `db.batch` lands, so the product (plus its vendors and integrations) goes fully live on the public site.
- The response carrying the assigned IDs is lost, so the Airtable write-back never runs: `supabase_product_id` stays null and `promotion_status` never flips.

That is worse than a plain failure. AECi upserts **only** by caller-supplied `supabaseId` — there is no `external_id` column and, by decision, no curation-tool key in D1 — so **a lost response is unrecoverable via the API**, and re-promoting a stranded product mints duplicate public rows.

Three shapes were considered:

1. **A D1 idempotency key** (`airtable_record_id` + upsert-by-ref, AECI-562). **Rejected by the decision owner:** no curation-tool key belongs in the public schema. Also treats the symptom (duplicates) rather than the cause (the response is the only copy of the IDs).
2. **Keep it synchronous, just raise the timeouts.** Doesn't fix anything — it only moves the cliff. Any client death at any moment still strands the commit, and Workers have their own request limits.
3. **Make promotion an async job:** kick off, poll, collect. The commit stops depending on the caller entirely, and the IDs become *fetchable* rather than *delivered once*.

## Decision

**Promote is an async job protocol. `POST /api/promote` validates synchronously, starts a Cloudflare Workflow, and returns `202 { jobId }`; `GET /api/promote/jobs/:id` serves status plus the full ID map.**

- **New Workflow** `PromoteWorkflow` (`apps/api/src/workflows/promote-workflow.ts`), bound as `PROMOTE_WORKFLOW`, one per environment (`aeci-promote-{preview,staging,demo,production}`) so instance IDs never collide across tiers. The class is re-exported from `src/index.ts` — wrangler resolves a Workflow's `class_name` off the Worker's main module, so the `workflows` binding block alone is not enough.
- **The caller-supplied job ID *is* the Workflow instance ID** — the idempotency key. `create({ id })` throws on a duplicate, so a replayed kick-off attaches to the existing instance and returns the same `jobId`. There is no code path that starts two instances for one job ID, and therefore none that commits twice. The review app stamps `promote_job_id` on the Airtable row *before* pushing (AECI-567), which is what makes the key durable on its side.
- **The commit is one non-retried step.** `commit-promote` throws `NonRetryableError(message, code)` on any failure, so the engine never replays a half-planned create. The second argument becomes the error's `name` — the only field `instance.status().error` carries besides the message — which is how the structured `ApiErrorCode` (`SLUG_CONFLICT`, `INTERNAL_ERROR`) survives to the poll response.
- **The ingest keeps its shape.** The 1,550-line plan-then-batch body is unchanged; only its dependency on Hono's `Context` was narrowed to a four-member `PromoteRunCtx` (`env` / `waitUntil` / `request` / `bookmark`). All five post-commit seams are untouched.
- **Post-commit hooks stay fire-and-forget** (`ctx.waitUntil`: audit forwards, cache purge, Algolia, IndexNow, Google Indexing, home-stats), dispatched from `run()` *after* the step resolves rather than inside it — so a step replay cannot re-fire them, and the job reaches `complete` the moment the batch commits. The poller gets its IDs without waiting on Algolia or Cloudflare.
- **Oversize bundles stage in KV.** Workflow event params cap at 1 MiB; above 512 KiB the validated payload goes to `promote:payload:{jobId}` (24h) and the params carry `payloadRef: 'kv'`. The committed ID map is also mirrored to `promote:result:{jobId}` (90 days) so the IDs outlive the 30-day instance retention. Both key spaces live in `apps/api/src/lib/promote-jobs.ts`.
- **Job-level observability.** `aeci.api.promote.kickoff`, `aeci.api.promote.job`, `aeci.api.promote.job.duration_ms`, plus an explicit `aeci.api.promote.job_failed` error log from the Workflow. Necessary, not decorative: `aeci.api.query.duration_ms{endpoint:/api/promote}` now times only the kick-off, and a Workflow failure never passes through the router's `errorHandler`, so without the log `REVIEW_APP_PROMOTE_API.md` §6.3's "every rejected promote is in Datadog" would quietly stop holding.

**Hard cutover, no dual mode.** There is no opt-in flag and no synchronous fallback: `POST /api/promote` always returns `202`. Two shapes for one endpoint would have to be maintained, documented, and tested in both directions for the life of the transition, and the sync path is precisely the thing being removed. The cost is a coordinated release — see Consequences.

## Consequences

**Gained**

- Kill any client at any moment and the commit still happens, exactly once, and the IDs stay fetchable by job ID for 90 days.
- A replayed push can no longer double-create, without a public-schema change.
- Kick-off returns in well under a second regardless of bundle size, so the heavy-bundle timeout class of failure is gone rather than widened.
- A slow ingest is now *visible* (job duration) instead of *fatal* (client timeout).

**Accepted costs**

- **Release coordination.** The deployed review app expects a synchronous `200` with a body. This merges to `main` (staging auto-tracks it), but **production must not be promoted until the review app's AECI-567 is deployed**, or every prod promote breaks. That is the deliberate price of the hard cutover.
- **The error contract moved.** `SLUG_CONFLICT` and `INTERNAL_ERROR` are no longer HTTP statuses of the promote call; they arrive as `{ status: 'errored', error: { code } }` on the poll. Only `400` / `401` / `413` / `503` remain synchronous.
- **Residual at-least-once window.** Workflows guarantee a step runs *at least* once. If the engine dies between `db.batch` committing and the step result being persisted, the commit could replay and duplicate a *created* row. Client death — the failure this ADR exists to fix — is fully covered; this narrower engine-crash window is **documented, not engineered around**, per the AECI-563 decision. Hardening it needs either deterministic IDs derived from the job ID (UUIDv5 + existence check) or an internal D1 job ledger whose primary key makes a replayed batch roll back; both are cheap to add later because the job ID is already threaded everywhere. Tracked as **AECI-571**.
- **`ctx.waitUntil` inside a Workflow is not a documented guarantee.** Keeping the hooks fire-and-forget is what buys the zero-latency `complete`, but the platform does not promise `waitUntil` survives instance completion. **Verified against local `wrangler dev`:** after a promote, the `home.*` `stats_cache` rows carried the promote's exact `computed_at`, so the hooks ran to completion after `run()` returned. If it ever regresses, the fallback is a trailing best-effort `step.do('post-commit-hooks')` that awaits them, at the cost of ~1s of poll latency.
- **New infrastructure to provision:** four KV namespaces (`aeci-api-promote-*`). Workflows themselves need no provisioning step, but they **do require the Workers Paid plan** (already in use for Queues).
- **`x-d1-bookmark` no longer rides the promote response.** The ingest runs off-request, so there is no header to emit and `bookmarkMiddleware` never sees this path. The write's session bookmark now travels internally (`PromoteIngestResult.bookmark` → `rc.bookmark()`), which is all the post-commit re-reads ever needed it for.

## Alternatives not taken

- **A Cloudflare Queue** (the ADR 0013 pattern). Queues give durable execution but no addressable instance identity, no status/output surface, and no caller-supplied dedup key — every one of which this problem needs. We would have had to build the job ledger and the poll surface ourselves, in D1, which is the thing the decision owner ruled out.
- **A Durable Object per job.** Equivalent power, strictly more code: we would hand-roll retries, retention, and status. Workflows *is* that DO, maintained by the platform.
- **Returning `202` but keeping the commit on the request via `waitUntil`.** Fast response, no durability: a Worker eviction mid-`waitUntil` loses the commit with no record that a job ever existed. This is the failure mode we are removing, not a fix for it.
