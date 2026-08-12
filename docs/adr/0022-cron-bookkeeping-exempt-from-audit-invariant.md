# ADR 0022: The §26.1 audit invariant scopes to domain state; derived and log-class writes are exempt, scheduled deletes are not

**Status:** Accepted
**Date:** 2026-08-12
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-573 (this change, §13 D11 of `ADMIN_PANEL_SPEC.md`), AECI-572 (the epic whose `metrics_daily` / `job_runs` / retention crons forced the question), AECI-581 / AECI-583 / AECI-584 (the three sub-issues that depend on the answer); ADR 0016 (D1 has no interactive transactions, so `db.batch` is the atomic unit)

---

## Context

`STAGE_1_SPEC.md` §26.1 stated the audit invariant without qualification:

> **Coverage:** every write path in the API Worker calls `appendAuditLog(...)` as part of its transaction … This guarantees no state change happens without a corresponding audit entry.

`DATABASE_SCHEMA.md` §18 and `CLAUDE.md` restate it the same way ("every state-changing write"). The admin-panel epic proposes two cron-written bookkeeping tables — `metrics_daily` (a daily metric snapshot) and `job_runs` (cron liveness plus persisted data-quality results) — plus a retention cron that deletes from `page_views`. Read literally, §26.1 requires an `audit_log` row for every one of those inserts, forever, for records no person initiated.

**The invariant was already false when this question was asked.** `API_CONTRACTS.md` §6.9 documents `page_views` as exempt, with a qualifier that appears nowhere in §26.1 itself:

> **No audit log.** §26.1 scopes `appendAuditLog()` to *state-changing* **domain** writes; `page_views` is a read-analytics log, so no audit row is written.

§6.13 extends the same exemption to `mailing_list` and `feedback`, explicitly including the unsubscribe **soft-delete** — a user-initiated, destructive-ish write exempted on grounds of *entity class*, not actor. So the spec-of-record and the contract doc had already diverged, and the reconciling word — "domain" — lived only in the contract doc.

Three further facts constrained the answer:

1. **No cron in this codebase has ever audited.** Three of the eight write to D1: the 07:00 home-stats job and the Algolia sync watermark both upsert `stats_cache`, and the `*/15` reconciliation sweep updates `vendor_requests` and `workflow_instances`. None emits an audit row. `recomputeProductCounts` likewise mutates `products` itself — a first-class domain entity — without one, because the user-initiated write that triggered it already carried the audit row.
2. **Answering "yes" would break a specified property.** `stats_cache` is written per key, deliberately outside any batch, because `lib/home-stats.ts` requires that "partial failure of one key must not abort the others." `metrics_daily` mirrors that key convention by design. Forcing an audit row into the write means forcing it into a batch, which destroys that isolation.
3. **Nothing schema-side blocked "yes."** `actor_type` is CHECK-constrained to include `'system'`, `actor_id` is nullable by design ("null for system/anonymous"), and `POST /api/promote` uses `actorType: 'system'` throughout. The mechanical cost of auditing a cron write is one line — which is exactly why the rule needed writing down rather than leaving to reviewer taste. A cheap-to-satisfy rule that nobody satisfies is worse than an explicit exemption.

## Decision

**§26.1 scopes to *domain state*. Derived and log-class writes are exempt. Scheduled deletion is not.**

- **Domain state** is the catalog, users and profiles, reviews and moderation, claims and attestations, requests and workflows — anything a person changed, or that changes what a visitor sees. These continue to emit an `audit_log` row via `auditInsert()` in the **same** `db.batch([...])` as the mutation; failure to log still rolls the batch back.
- **The exemption test is three-part and conjunctive.** A write is exempt when it is *all three* of: (a) computed entirely from data already in the database, **or** an append-only event / lead-capture log; (b) invisible on every public surface; and (c) reproducible by re-running the job that wrote it. Exempt today: `page_views`, `mailing_list`, `feedback`, `stats_cache` (home-stats + Algolia watermark), the denormalized product counters, and — once they ship — `metrics_daily` and `job_runs`.
- **The test is entity class, not actor class.** A system or cron actor writing *domain* state still audits. `actorType: 'system'` exists for precisely that case and is already in production use.
- **Exception: any scheduled `DELETE` emits exactly one summary `audit_log` row per run**, in the same batch as the delete — `actor_type='system'`, `action='retention.pruned'`, `metadata={table, cutoff, rowsDeleted}`. One row per run, not per row deleted.
- **Observability for exempt writes is `job_runs` plus Datadog**, not the audit log. That is not a downgrade: `job_runs` (`ADMIN_PANEL_SPEC.md` §7.2) is a richer record for this class of write than an `audit_log` row would be, because it carries duration, outcome, and a per-job payload.

The carve-out is written into `STAGE_1_SPEC.md` §26.1 itself. A carve-out documented only in a downstream spec is a contradiction waiting to be found in review — which is exactly how the `page_views` exemption ended up stranded in `API_CONTRACTS.md`.

## Consequences

**Gained**

- The invariant becomes true again. Before this ADR, §26.1 as written was contradicted by `page_views`, `mailing_list`, `feedback`, `stats_cache`, the Algolia watermark, and `recompute-counts` — six live exemptions, one of them documented, five of them not.
- `audit_log` keeps its signal-to-noise. A daily snapshot writing ~20 metric rows plus 8 job rows would add ~10k audit rows a year describing nothing anyone did.
- `metrics_daily` can keep `stats_cache`'s per-key partial-failure isolation instead of being forced into a batch to carry an audit row.
- Reviewers get a decidable test. "Is this domain state?" is answerable at review time; "is this a state-changing write?" was answerable only as "yes, always," which is why the rule was being silently ignored.
- The one genuinely irreversible operation — scheduled deletion — gains an audit obligation it did not previously have, at bounded cost (one row per run).

**Accepted costs**

- **A three-part test is more judgment than a blanket rule.** Mitigated by naming the exempt tables explicitly in §26.1 rather than leaving the test to be applied from scratch each time; a new exemption is a spec edit, not a reviewer's call.
- **"Invisible on every public surface" can drift.** If a table currently exempt later feeds a public number, the exemption must be revisited. `stats_cache` is the live example — it is exempt but *does* back public home-page stats, and it qualifies only because it is fully recomputable from domain data that is itself audited. That is a fine distinction and the most likely place this ADR is misapplied.
- **The audit log stops being a complete changelog of the database.** It never was one, but the old wording implied it. Anyone reconstructing history from `audit_log` must now consult `job_runs` and Datadog as well — which `ADMIN_PANEL_SPEC.md` §4 already establishes for other reasons (827 `integration.created` events against 496 live rows).

**Surfaced but not fixed here**

- The `*/15` reconciliation sweep mutates `vendor_requests` and `workflow_instances` with no audit row and no batch (`lib/linear.ts`). Under this ADR that is unambiguously **domain state** and therefore a genuine §26.1 violation — not bookkeeping, and more serious than anything the admin-panel epic introduces. Tracked as **AECI-591**; this ADR deliberately does not legitimize it.
- `data-quality.ts` check #2 (`ready_products_unpromoted`) is structurally unreachable — nothing in the repo writes `'ready'` to D1 — so it has been silently passing since it shipped. Unrelated to the audit invariant, but found in the same sweep. Tracked as **AECI-592**.

## Alternatives not taken

- **Audit everything, literally.** One line per cron, and `actorType: 'system'` already exists — but it forces `metrics_daily` into a batch (breaking the documented per-key isolation), makes the existing 07:00 job retroactively non-compliant, and buys an audit trail whose entries no one would ever read. It also would not have resolved the `page_views` contradiction, only widened it.
- **Leave §26.1 alone and document the exemption in `ADMIN_PANEL_SPEC.md`.** Cheapest edit, and precisely the mistake that produced this ADR: the `page_views` exemption has sat in `API_CONTRACTS.md` for months while three other docs assert the absolute form.
- **Exempt on actor ("system writes don't audit").** Simpler to state, and wrong: `POST /api/promote` is a system actor writing the entire public catalog, and it must audit. Actor is the wrong axis; entity class is the one the codebase was already using.
- **A separate `system_log` table for cron writes.** More machinery for the same outcome. `job_runs` already is that table, and it exists for independent reasons.
