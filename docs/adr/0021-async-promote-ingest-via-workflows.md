# ADR 0021: Promote ingest runs in a Cloudflare Workflow, keyed by a caller-supplied job ID

**Status:** Accepted (amended 2026-08-13 — the residual at-least-once window is now closed by a D1 job ledger; amended 2026-08-27 — the hook dispatch is now bounded and watchdogged; amended 2026-08-31 — a second job kind rides the same binding, and atomicity stops at the page boundary; see the Amendment sections below)
**Date:** 2026-08-12
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-563 (this change), AECI-571 / AECI-666 (the amendments), AECI-561 (epic), AECI-567 / AECI-570 (the review-app half, other repo); narrows ADR 0013's cron→queue posture for a *request*-triggered job; ADR 0016 (D1 has no interactive transactions)

> **Amendment 2026-08-13 (AECI-571):** everything below stands, with one exception — the
> "Residual at-least-once window" under Accepted costs is **no longer accepted**. The ingest
> now writes a `promote_jobs` ledger row keyed by the job id inside the promote's own
> `db.batch`, so an engine replay rolls back and returns the recorded IDs. The commit is
> exactly-once for engine death as well as client death. See the
> [Amendment](#amendment-2026-08-13--the-promote_jobs-ledger) section.

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
- **Post-commit hooks stay fire-and-forget** (`ctx.waitUntil`: audit forwards, cache purge, Algolia, IndexNow, Google Indexing, home-stats), dispatched from `run()` *after* the step resolves rather than inside it — so a step replay cannot re-fire them, and the job reaches `complete` the moment the batch commits. The poller gets its IDs without waiting on Algolia or Cloudflare. **Fire-and-forget is not fire-and-ignore** — see the [2026-08-27 amendment](#amendment-2026-08-27--bounded-hook-dispatch-aeci-666) for the connection budget the dispatch must respect and the watchdog that keeps one wedged hook from killing the rest.
- **Oversize bundles stage in KV.** Workflow event params cap at 1 MiB; above 512 KiB the validated payload goes to `promote:payload:{jobId}` (24h) and the params carry `payloadRef: 'kv'`. The committed ID map is also mirrored to `promote:result:{jobId}` (90 days) so the IDs outlive the 30-day instance retention. Both key spaces live in `apps/api/src/lib/promote-jobs.ts`.
- **Job-level observability.** `aeci.api.promote.kickoff`, `aeci.api.promote.job`, `aeci.api.promote.job.duration_ms`, plus an explicit `aeci.api.promote.job_failed` error log from the Workflow. Necessary, not decorative: `aeci.api.query.duration_ms{endpoint:/api/promote}` now times only the kick-off, and a Workflow failure never passes through the router's `errorHandler`, so without the log `REVIEW_APP_PROMOTE_API.md` §6.3's "every rejected promote is logged" would quietly stop holding. *(That guarantee is vendor-independent and must survive the ADR 0024 Datadog → PostHog swap — it is item 7 of the migration's verification checklist.)*

**Hard cutover, no dual mode.** There is no opt-in flag and no synchronous fallback: `POST /api/promote` always returns `202`. Two shapes for one endpoint would have to be maintained, documented, and tested in both directions for the life of the transition, and the sync path is precisely the thing being removed. The cost is a coordinated release — see Consequences.

## Consequences

**Gained**

- Kill any client at any moment — and, since the AECI-571 amendment, the job engine too — and the commit still happens, exactly once, and the IDs stay fetchable by job ID for 90 days.
- A replayed push can no longer double-create, without a public-schema change.
- Kick-off returns in well under a second regardless of bundle size, so the heavy-bundle timeout class of failure is gone rather than widened.
- A slow ingest is now *visible* (job duration) instead of *fatal* (client timeout).

**Accepted costs**

- ~~**Release coordination.**~~ **Discharged 2026-08-13 — the ordering was respected.** At decision time the deployed review app expected a synchronous `200` with a body, so production could not be promoted until the review app's AECI-567 was deployed, or every prod promote would break. That was the deliberate price of the hard cutover. AECI-567 merged 2026-08-12 and prod moved to the async API afterwards. The rule outlives this instance: **any future change to the promote contract ships in the review app first, then `promote-to-prod`** (`docs/environments.md` → promote-Workflow checklist).
- **The error contract moved.** `SLUG_CONFLICT` and `INTERNAL_ERROR` are no longer HTTP statuses of the promote call; they arrive as `{ status: 'errored', error: { code } }` on the poll. Only `400` / `401` / `413` / `503` remain synchronous.
- ~~**Residual at-least-once window.**~~ **Closed by AECI-571 — see the [Amendment](#amendment-2026-08-13--the-promote_jobs-ledger).** Workflows guarantee a step runs *at least* once, so if the engine died between `db.batch` committing and the step result being persisted, the commit replayed and duplicated a *created* row. Client death — the failure this ADR exists to fix — was always covered; this narrower engine-crash window was originally **documented, not engineered around**, per the AECI-563 decision. It is now guarded by the `promote_jobs` primary key.
- **`ctx.waitUntil` inside a Workflow is not a documented guarantee.** Keeping the hooks fire-and-forget is what buys the zero-latency `complete`, but the platform does not promise `waitUntil` survives instance completion. **Verified against local `wrangler dev`:** after a promote, the `home.*` `stats_cache` rows carried the promote's exact `computed_at`, so the hooks ran to completion after `run()` returned. If it ever regresses, the fallback is a trailing best-effort `step.do('post-commit-hooks')` that awaits them, at the cost of ~1s of poll latency.
- **New infrastructure to provision:** four KV namespaces (`aeci-api-promote-*`). Workflows themselves need no provisioning step, but they **do require the Workers Paid plan** (already in use for Queues).
- **`x-d1-bookmark` no longer rides the promote response.** The ingest runs off-request, so there is no header to emit and `bookmarkMiddleware` never sees this path. The write's session bookmark now travels internally (`PromoteIngestResult.bookmark` → `rc.bookmark()`), which is all the post-commit re-reads ever needed it for.

## Alternatives not taken

- **A Cloudflare Queue** (the ADR 0013 pattern). Queues give durable execution but no addressable instance identity, no status/output surface, and no caller-supplied dedup key — every one of which this problem needs. We would have had to build the job ledger and the poll surface ourselves, in D1, which is the thing the decision owner ruled out.
- **A Durable Object per job.** Equivalent power, strictly more code: we would hand-roll retries, retention, and status. Workflows *is* that DO, maintained by the platform.
- **Returning `202` but keeping the commit on the request via `waitUntil`.** Fast response, no durability: a Worker eviction mid-`waitUntil` loses the commit with no record that a job ever existed. This is the failure mode we are removing, not a fix for it.

---

## Amendment (2026-08-13): the `promote_jobs` ledger

**Issue:** AECI-571. **Closes** the "Residual at-least-once window" accepted cost above.

### What changed

`runPromoteIngest` now takes the job id and writes a **`promote_jobs`** row — `job_id` TEXT
PRIMARY KEY, the committed result as JSON — as the **first statement of the same atomic
`db.batch`** as the promote's own writes. Two things follow:

1. A replayed batch trips the primary key, so D1 rolls the **entire** batch back. No
   duplicate product, no duplicate vendor, no duplicate audit rows, and — the part a
   deterministic-id scheme would not have given us — no disambiguated slug, because the
   second insert never lands.
2. The stored result lets the replay return an **identical** `PromoteIngestResult`: same
   ids, same slug. The job still reaches `complete`, and the post-commit hooks — which
   never fired for the attempt whose result was lost, since they are dispatched from
   `run()` *after* the step — fire exactly once, driven by the recorded result.

A cheap pre-read of the same primary key short-circuits the ordinary replay before the plan
phase runs. That is an optimization; the in-batch key is the guard, and it is what makes two
genuinely concurrent attempts safe.

An absorbed replay emits `aeci.api.promote.replay` and an
`aeci.api.promote.replay_detected` log — the first direct evidence that this window ever
fires. Before, the runbook could only ask an operator to notice a duplicated product and
infer it.

### Why the ledger rather than deterministic ids

The original text named two options. Deterministic UUIDv5 ids (derived from `jobId + kind +
ref`) were rejected on inspection:

- They fix **ids** but not **slugs**. `revit-2` is derived from a *read* of the existing
  slug set, not from an id, so a replay would still drift — and then collide on the
  deterministic PK, failing the job instead of duplicating it. Neither outcome is right.
- They turn all six create branches into create-or-update with an existence check, and
  still leave duplicate `audit_log` rows to solve separately.
- The replay would have to re-plan the whole bundle to answer, where the ledger reads the
  answer back.

One primary key replaces roughly eight subtle invariants, for the price of one additive
migration.

### Consequences of the amendment

- **Idempotency now outlives Workflow retention.** Previously, once an instance aged out
  (30 days) `create({ id })` stopped seeing a duplicate, so re-pushing that job id committed
  a second time — a real hole, and exactly what the AECI-570 reconcile sweep could hit with
  a stale marker. The ledger row closes it for as long as it lives. Corollary: **any future
  prune floor must be ≥ 90 days**, the KV result mirror's TTL, or the guard expires before
  the IDs it protects.
- **One new failure class: an `errored` job that DID write.** If a ledger row is present but
  unreadable (corrupt JSON, or a future envelope version), the ingest fails the job rather
  than re-planning — re-planning is the duplicate. This breaks the otherwise clean "an
  errored promote wrote nothing" invariant, so `docs/RUNBOOKS.md` carries the exception.
  Near-zero probability; we write the row ourselves and it is versioned.
- **The AECI-562 veto is untouched.** `job_id` is AECi's own job id, not an Airtable record
  id. The ruling was about curation-tool keys in the public schema; a workflow-job ledger is
  not one.
- **No pruner shipped.** ~10 KB a row at a handful of promotes a day. The `created_at` index
  is there so a later sweep is a one-line range delete; `docs/RUNBOOKS.md` carries the
  manual statement and the 90-day floor.
- **Not done, deliberately:** wiring `GET /api/promote/jobs/:id` to read the ledger as a
  third, never-expiring result source behind the instance and the KV mirror. Attractive and
  small, but it changes 404 semantics and belongs in its own issue.

## Amendment 2026-08-27 — bounded hook dispatch (AECI-666)

**Status:** Accepted · **Issue:** AECI-666

The decision above stands. What it did not specify — and what production then broke on
— is *how many connections* the fire-and-forget tail is allowed to open at once.

**What happened.** `dispatchPromoteHooks` handed every transport to `waitUntil`
simultaneously, and the §26.5 audit forwards issued one request **per `audit_log`
row**. Several of those transports (the observability forward, the Cloudflare
purge, IndexNow) also never read their success-path response body, so each held
its connection until garbage collection. A Worker invocation may hold only a
bounded number of open connections; past that the runtime cancels the stalled
responses to break the deadlock, and **a cancelled `fetch` returns a promise that
never settles** — neither resolve nor reject, so each transport's own `catch`
never fired.

Measured on production during a 63-promote backfill (2026-08-26 22:50–23:20 UTC):
745 `"A stalled HTTP response was canceled to prevent deadlock"` warnings, 1–77 per
invocation, and 5 invocations killed outright by the runtime hang detector
(`"your Worker's code had hung and would never generate a response"`, 11.4s wall on
0.32s CPU). All 63 commits landed and all 63 instances reported `complete` — the
ledger and the retry semantics were never at fault. What was lost was the post-commit
tail: Algolia upserts, cache purges, IndexNow/Google pings, audit forwards. Silently.

**What changed.**

1. **Every transport releases its response body** on every path
   (`discardResponseBody`, `packages/shared/src/response-drain.ts`). This is the
   actual fix — an unread body is what holds the connection.
2. **The audit forwards are one request, not N** — `logBatchToPosthog`
   (`apps/api/src/posthog.ts`). OTLP's `logRecords` accepts an array; the per-entry
   loop was the only hook whose request count scaled with bundle size. The same
   treatment applies to the other two per-entry loops on this branch,
   `lib/attestation-notify.ts` and `routes/vendor-shared.ts`.
3. **Google Indexing publishes in bounded waves** rather than opening up to 100
   connections at once — it has no batch endpoint, so bounding concurrency
   (`mapWithConcurrency`, `packages/shared/src/concurrency.ts`) is the only lever.
4. **The cache purge enqueues via one `queue.sendBatch()`**, not a concurrent
   `send()` per batch. A Queue producer call counts against the same budget as
   `fetch`. Latent today — `CACHE_PURGE_QUEUE_MAX_TAGS` is 1000, so a promote's tag
   set is one batch — but the shape is the rule, and it stops being latent if that
   cap moves. See ADR 0020 §3.
5. **Each hook is dispatched behind a 20s watchdog** (`dispatchHook`). A hook that
   never settles is abandoned with a `console.warn` instead of wedging `waitUntil`
   until the runtime kills the invocation. Losing one hook is survivable; losing the
   invocation takes every *other* in-flight hook with it, which is what turned a
   transport bug into a silent outage. **20s, not 30s:** `waitUntil` is documented to
   extend execution for *up to* 30s after the response, so a 30s watchdog races the
   platform tearing the invocation down and the warning — the whole point of it —
   might never be emitted.

**The rule this establishes.** Any code that fans out `fetch` from a single
invocation must (a) release bodies it does not read, and (b) prefer one batched
request over N concurrent ones — falling back to
`mapWithConcurrency(items, WORKER_CONNECTION_LIMIT, fn)` only when the upstream
has no batch endpoint. Recorded as a non-negotiable constraint in `CLAUDE.md`.

**The same defect existed outside the promote path** and was fixed in the same
change: `lib/email.ts` (both Resend senders), `lib/toxicity.ts`,
`lib/algolia-orphan-purge.ts` (including a poll loop that could park 20 held
connections in one invocation), `lib/data-quality.ts`,
`apps/datatool/src/algolia-reindex.ts`, and `lib/supabase-admin.ts` — where
`fetchAuthUserEmails` and `fetchAuthAccountsByEmail` were bare `Promise.all`s of one
GoTrue GET per id, the latter bounded only by the admin page size of 100. Those were
the promote bug in miniature, on surfaces nobody had connected to it.

**Still open.** The promote path issues ~20 further telemetry requests per run from
individual `submitCount` / `logToPosthog` call sites — doubled again by the dual-run.
With bodies drained these queue harmlessly rather than deadlocking, but coalescing
them into a per-invocation buffer flushed once would cut the tail's request count by
an order of magnitude. Deferred — it changes the transport's contract for both
Workers and was not needed to close the incident.

## Amendment 2026-08-31 — a second job kind, and where atomicity stops (AECI-714)

Everything above continues to hold **per job**. This records a second arm on the same
protocol and, more importantly, the one guarantee it deliberately does not extend.

**What was added.** `POST /api/promote/connector-catalog` sends one **page** of one connector
catalogue. It reuses this ADR wholesale — the same `PROMOTE_WORKFLOW` binding, the same
`PROMOTE_KV` staging and result mirror, the same single non-retried `commit-promote` step, the
same `promote_jobs` ledger-first batch, the same `GET /api/promote/jobs/:id` poll, the same
`NonRetryableError(message, code)` conversion. `PromoteWorkflowParams` became a discriminated
union whose `kind` is **absent** for the product arm, so instances created before this
amendment and still inside their 30-day retention window keep replaying as product promotes.
**No `wrangler.jsonc` change was needed in any environment**, which is the whole reason for
one Workflow class rather than two.

**Where atomicity stops, and why that is a decision rather than a gap.** A catalogue is ~3,573
rows today and ~15k once Zapier lands. It cannot be one transaction — D1 has none to offer,
and one `promote_jobs` row protects one commit, not N. So a catalogue sync is a *sequence* of
independent jobs, and the cross-page property is **idempotence rather than atomicity**:

- every statement the connector planner emits is an upsert keyed on the review app's own
  record id, which is also the app-DB primary key (see `DATABASE_SCHEMA.md` §9a for why that
  key choice is forced rather than convenient);
- a page re-sent with nothing changed emits **zero** statements and writes **no** audit row;
- a half-finished catalogue sync is therefore always safe to re-run from page one, and a
  dangling reference between pages is reported in `skipped[]` and re-sendable rather than
  fatal.

The product arm's guarantee is unchanged and must stay unchanged: its writes are **not**
idempotent by construction — a create with no `supabaseId` mints a new row — which is exactly
why the ledger PK exists there and why the commit step must never be auto-retried.

**Post-commit hooks: two, not seven.** The connector arm dispatches only the §26.5 audit
forward and the skip report. No Algolia sync, no IndexNow, no Google Indexing, no home-stats
refresh, and no cache purge — `STAGE_1_5_SPEC.md` §13.5 is categorical that reachable data
never counts anywhere, and no cacheable route depends on these rows until AECI-715/716. The
absence is asserted by a source guard in `routes/promote-connector.spec.ts` rather than by a
spy, because the thing worth preventing is a future refactor wiring this arm into
`dispatchPromoteHooks` wholesale.
