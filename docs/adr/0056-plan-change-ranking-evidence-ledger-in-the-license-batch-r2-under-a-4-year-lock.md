# ADR 0056: Plan-change ranking evidence: a ledger in the license batch, R2 under a 4-year bucket lock

- Status: Accepted. Built.
- Date: 2026-11-16
- Issue: AECI-1621
- Relates to: ADR 0022 (log-class writes, amended 2026-11-16); ADR 0041, 0045 and 0050 (the earlier R2 stores); ADR 0048 (a plan is a product with a live license); `docs/SEARCH_RANKING.md` §7a; `docs/STAGE_2_PAID_TIERS_SPEC.md` §3.2; `docs/DATABASE_SCHEMA.md` §9.16; `docs/ANALYTICS.md` §11d; `docs/LEGAL_COUNSEL_RECORD.md` Q23

## Context

The Terms say ranking is never influenced by payment. Counsel's Q23 answer (2026-11-04): under FDUTPA that claim is defended with records held when it was made, kept at least four years. Most of the records already existed: the ranking code and its tests in git, the capability list, the audit log, the moderation records and the legal versions. One was missing: a ranking snapshot of a product before and after a plan starts or ends.

A plan is per product (ADR 0048). It starts when a live license reaches a product and ends when one leaves it. Every license write goes through one function, `assemble()` in `apps/api/src/lib/license.ts`, which already diffs the license set before and after the batch to keep `products.managed_ended_at` true (ADR 0051).

## Decision

Chris ruled on 2026-11-16.

1. **Two snapshots per plan change: at the event and 30 days later.** The follow-up shows that a cancellation caused no later demotion.
2. **A ledger row in the same batch as the license change.** `assemble()` inserts two `plan_change_snapshots` rows, an `event` row due at once and a `followup` row due 30 days later, for every product whose live license appeared or disappeared. Because every license write passes through `assemble()`, no caller can miss it, and a refused batch writes none. A carry-over, where one live license leaves a product and another reaches it in the same batch, is not a plan change and writes nothing. The diff reads the caller's pre-read, so a lost race can add an extra snapshot. That is harmless and not guarded. The ops retraction lane bypasses `assemble()`, but it deletes the product, so there is nothing left to rank.
3. **A sweep writes the snapshots, on the existing reconcile queue.** A new cron, `11-59/15 * * * *`, enqueues one `plan_snapshot` message on `RECONCILE_QUEUE`, which already dispatches on `message.job`. No new queue is provisioned. The consumer reads up to 25 due rows, builds each snapshot, writes it to R2, confirms it with `head`, then stamps `r2_key`. A failed row records `attempts` and `last_error` and stays due. The account has a 250-trigger cron cap on Workers Paid, and this Worker declares 27 per tier, 81 in all.
4. **A snapshot is read through the public code.** Inputs come from `productListingTier` and `toAlgoliaProduct`. Positions use `buildProductsWhere` and `resolveProductOrderBy('created')`, the `where` and default order of `GET /api/products`, for `/products` and each taxonomy page the product is on, and the home stat's own order for "most integrated". These are live D1 positions at `taken_at`, not cached page responses or Algolia search positions. No live Algolia query: the index quota is exhausted, and a query costs money. The `created_desc` replica shares the Newest sort but uses whole-second timestamps and different tie breakers, and its sync can lag D1. The saved search record is what the sync would write, not a read of the index. No personal data.
5. **Storage is the existing `UPLOADS` bucket under `evidence/`, behind a 4-year R2 bucket lock.** Key: `evidence/plan-snapshots/product=<id>/<event_at>-<kind>-<phase>-<row id>.json`. One lock rule per tier on the prefix `evidence/`, 1461 days. Chris applies it by hand after deploy (`docs/environments.md`). No lifecycle rule.
6. **The modules sit outside the ranking firewall's names.** A snapshot records whether a plan is live, as context. `ranking-firewall.spec.ts` scans files named `rank`, `listing`, `sort` or `search` and forbids plan columns there. So the modules are `plan-change-ledger.ts`, `plan-change-evidence.ts` and `plan-snapshot-sweep.ts`, and the firewall now also forbids every ranking module from naming `plan_change_snapshots`.

## Consequences

- **The lock forbids an overwrite, so the sweep never overwrites.** It `head`s the key first. An object already there was written by a run whose D1 stamp failed, and the sweep adopts it. A retry therefore never needs a second write.
- **A bucket with a lock rule cannot be emptied.** Retiring a tier's `UPLOADS` bucket means removing the rule first, after its objects have aged out. Logos and the legal PDFs live under other prefixes and stay deletable.
- **A snapshot written before the lock is applied is still covered.** A lock rule protects objects that already exist under its prefix.
- **Log-class ledger.** `plan_change_snapshots` writes no `audit_log` row. The license write's own audit row records the event (ADR 0022, 2026-11-16 amendment). No delete path exists.
- **Health.** The `aeci.plan_snapshot.run` heartbeat, the `plan-snapshot` row on `/admin/system`, and the `plan_snapshot_overdue` data-quality check (`error`) for a row unwritten 24 hours after due.
- **Cost.** A handful of D1 reads per snapshot and two R2 calls. Plan changes are rare, so most runs read one empty index range.
- **Not kept four years by this ADR: CI test results.** The tests are in git and can be re-run at any commit. GitHub keeps run logs for its own retention period only.

## Alternatives not taken

- **A new queue.** Ruled out: `RECONCILE_QUEUE` already dispatches on `message.job` (the `sitemap_rebuild` precedent), and a new queue is a provisioning step on three tiers.
- **A new bucket.** Ruled out: the lock is per prefix, so `UPLOADS` with an `evidence/` rule gives the same guarantee without a new binding or deploy-token scope.
- **Snapshot on the request.** Ruled out: the license write would grow a dozen reads and an R2 call, and a Stripe webhook or a cron batch would carry them.
- **Snapshot only at the event.** Ruled out by ruling 1: a demotion could follow the cancellation later.
- **A live Algolia query for search positions.** Ruled out: the quota and the cost. The recorded D1 positions do not establish Algolia search positions; the snapshot keeps the search record the sync would write instead.
