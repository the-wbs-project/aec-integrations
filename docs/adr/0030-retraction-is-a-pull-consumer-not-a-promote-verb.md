# 0030 — Retraction is a pull consumer, not a promote verb

**Status:** Accepted
**Date:** 2026-09-13
**Issue:** AECI-882 (epic), AECI-811, AECI-878
**Supersedes:** nothing. Completes the AECi half of AECI-595, whose upstream half shipped 2026-09-07.

> **Amended 2026-09-14 (AECI-888 / AECI-897).** Two sentences below are now wrong, and the
> decision is unchanged by both.
>
> 1. **"It can never delete one" is too strong** — read it as **"it can never *retract*
>    one"**. The rejected alternative at the bottom of this file is about inferring a delete
>    from **absence**, and that rejection stands unconditionally. What AECI-888 adds is an
>    **id-directed cross-table move**: `powered_by_product_id` routes an edge between
>    `integrations` and `connector_evidenced_pairs`, identity is table-scoped, and the key is
>    mutable — so a push that flips it must move the row, dropping the old one in the same
>    batch as the insert. That delete is caused by an id you named, never by a record you
>    omitted. The forward direction already shipped with AECI-721; AECI-888 added the reverse
>    and the two are now symmetric. Both re-home claims *before* the drop, for the reason
>    §2 below gives.
> 2. **"classifying it against `list_integrations` would flag every row every run" is wrong**
>    (see "The detection half"). Measured against production on 2026-09-14: of 62
>    `connector_evidenced_pairs` rows, **60 were claimed upstream and 2 were not**. It is wrong
>    by 60 of 62. The comparand is sound because the ids are the same ids — the product promote
>    arm writes a pair row under the caller's `supabaseId` verbatim and reports it back, and
>    the review app stores that in the same column `list_integrations` projects. AECI-897
>    therefore put the table **in scope** as `evidencedPairSourceGone`, with a sanity gate that
>    withholds the findings and exits 2 rather than 1 if the whole table ever comes back
>    unclaimed at once.
>
> The lesson is the one this file already teaches, applied to itself: a stated reason for a
> blind spot is not evidence for it. That sentence was recorded three times and measured zero
> times, and it held the exclusion in place across the 2026-09-10 miss.

> **Amended again 2026-09-14 (AECI-916). The decision stands; the consumer gained a second
> cohort source.**
>
> §2 derives the cohort from the feed, and §1 says the confirm function has "exactly one call
> site". Both remain true, and a reader who stopped there would still conclude — wrongly, since
> AECI-916 — that a row absent from the feed has no repair path here.
>
> **The feed cannot carry every retraction.** A journal entry is written only when the deleted
> upstream record carried a `supabase_integration_id`. If that pointer was never stored, the
> upstream delete journals nothing, and the live AECi row is unreachable from both directions
> at once: the stock sweep sees a strand, the event check sees nothing. That is not a gap in
> either check — it is a gap in the *repair*, and it closed for exactly the class this consumer
> was built to serve.
>
> So `consume.mjs --ruling <file>` takes the ids from a **committed operator ruling** instead.
> The four load-bearing properties below are unchanged by it:
>
> 1. **The order.** Delete → verify still holds and the verify still gates the run. The third
>    step does not exist in ruling mode because there is nothing upstream to acknowledge, which
>    removes the unrecoverable move rather than relaxing the guard against it. There is still
>    exactly one `confirmRetractions()` call site, now behind an `if`, and the function throws
>    if handed a non-journal entry id.
> 2. **Both tables**, on resolve and again on verify. Unchanged. Ruling mode is *stricter*
>    here: a ruled id that resolves in neither table refuses the run outright, where a journal
>    entry in the same position lands in `alreadyGone`.
> 3. **The write tool behind its own door.** Ruling mode never opens a write session at all, so
>    `AECI_MCP_TOKEN` is read-only for the whole run. The token is still required, because the
>    feed is read to prove it is empty — mixing the two cohorts would leave journal entries
>    un-confirmable against rows that no longer exist.
> 4. **One `audit_log` row per deleted row.** Unchanged, and it matters more here: with no
>    upstream record and no journal entry, that row plus the committed ruling file are the
>    *only* surviving account of the deletion. The provenance block swaps from
>    `retraction_journal` to `operator_ruling`; `metadata.source` distinguishes them.
>
> **Route A stays the default.** If the upstream record still exists, delete it there and let
> the journal carry it — the curator's own words are better evidence than a reconstruction.
> Ruling mode is for the case where that route is structurally closed.

## Context

Promote can create and update rows. It can never retract one
(`docs/REVIEW_APP_PROMOTE_API.md` §5.1). So when a curator deletes a curation record, the
live D1 row it produced stays on the public site, and the review app's `supabase_*_id`
column — which ADR 0021's AECI-562 veto keeps out of our schema on purpose — is the only
surviving pointer to it.

The review app already journals every such delete and exposes the journal as
`list_retractions` / `confirm_retractions`. Nothing in this repo read either tool. On
2026-09-13 the journal held **216 pending entries and 0 confirmed**, all of them live on
the public site as delivered integrations.

## Decision

**Retraction is a separate, pull-shaped consumer. It is not a verb added to promote.**

The consumer is an ops script (`scripts/ops/2026-09-retraction-consumer/consume.mjs`) that
reads the feed, deletes the named rows, verifies, and only then confirms.

Four properties are load-bearing.

### 1. The order is delete → verify → confirm, and it is enforced structurally

`confirm_retractions` stamps `synced_at`, which drops the entry out of the default feed. An
entry confirmed but never deleted is a live public row that **nothing in either system can
find again**: the curation record is gone, so the journal entry holds the only copy of its
`supabaseId`, and confirming discards it.

The opposite mistake is harmless and self-correcting. An unconfirmed entry is simply
re-reported, and re-deleting an already-deleted row is a no-op. The two directions are not
symmetric, so the code is not symmetric either: the confirm function accepts **only** the
token the post-delete verifier returns, and there is exactly one call site.

### 2. Both delivered-tier tables are read, on resolve and again on verify

A journal entry carries a `supabaseId` and nothing that says which table holds it.
Migration `0027` (AECI-721) moved connector-powered edges out of `integrations` into
`connector_evidenced_pairs` **with their ids verbatim**, so the same id can be in either.

This is not a theoretical edge. 215 of the 216 entries were in the pairs table. A consumer
written against `integrations` alone would have deleted 1 row, found the other 215 absent,
concluded they were already gone, and **confirmed** them — destroying the only pointer to
215 live, incorrect public rows.

The same reasoning bounds the lane in the other direction. The feed journals
`entity: 'product' | 'integration' | 'vendor'`, and this consumer resolves against the two
delivered-tier tables and nothing else — so a `product` entry resolves to nothing and is
indistinguishable, at that layer, from an edge already gone. It is therefore **parked**:
reported, never deleted, never confirmed, including under `--confirm-already-gone`. Its
repair is `ops:retract-product`, and leaving the entry pending is the harmless direction.
An entry with a **missing** `entity` is parked too — if the upstream projection ever drops
the field, a destructive lane that cannot establish a row's class should do nothing and say
so.

### 3. The write tool is behind its own door, not a widened allow-list

Every prior ops MCP client carried one read-only allow-list and one method.
`confirm_retractions` is a write, so the consumer's client carries **two** sets behind two
methods: `callTool` for reads, `callWriteTool` for exactly one write. A typo on the read
path cannot reach the write, and neither can reach `promote_product` or the
`create_*`/`update_*` family the same server exposes.

`AECI_MCP_TOKEN` is still never pushed to a Worker. That is why the consumer stays in
`scripts/ops/` rather than becoming a `pnpm ops:*` CLI in `apps/api` — it keeps
`docs/CICD_PLAN.md` §7.1's "no runtime code in this repo talks to the review app"
literally true.

### 4. One `audit_log` row per deleted row, not one summary row per run

ADR 0022 §37 prescribes a single `retention.pruned` summary row for **scheduled** deletes.
This is an operator action, and each row carries its own editorial ruling in the curator's
own words. A summary row would discard 214 distinct rulings that exist nowhere else: once
an entry is confirmed, its `reason`, upstream record id and name-as-it-stood are gone from
both systems. Preserving them in `metadata` is the single thing the feed makes possible
that a set-difference sweep cannot.

## The detection half

The daily `promote-strand-audit` gained a `pendingRetractions` bucket rather than a second
scheduled job. The two checks answer different questions over the same catalog and are
cheapest read together:

- The six existing buckets are a **stock** check. They compare what exists on both sides
  today, so they catch a row however long ago it was stranded, but they can only infer
  *that* something went missing.
- The feed is an **event** check. It says what was deleted and *why*, but journals forward
  only, so it is blind to anything stranded before it shipped.

The bucket also closes a real blind spot rather than adding a nice-to-have. The six stock
buckets excluded `connector_evidenced_pairs` by design — the recorded reason was that
classifying it against `list_integrations` would flag every row every run — so they reported
**clean** on every run between 2026-09-10 and 2026-09-13 while 215 retracted pairs were live
and public.

> **That reason was wrong and the exclusion is gone (AECI-897, 2026-09-14).** Measured: 60 of
> 62 pair rows are claimed upstream. The table is now classified as `evidencedPairSourceGone`,
> a seventh stock bucket. The `pendingRetractions` bucket stays and is not redundant — a set
> difference can only infer that something went missing, while the feed carries the curator's
> ruling and its reason. Stock and event, not one check run twice.

That bucket carries a `HELD_RETRACTIONS` list: entries held on a recorded decision are
printed but do not fail the run. Without it, two deliberate holds would leave the job red
every day until they clear, and a permanently red guard is one nobody reads — which would
hide the next retraction behind the two we already know about. Each hold names the issue
that clears it.

> **Amended 2026-09-14 (AECI-909).** Both holds are discharged and `HELD_RETRACTIONS` is
> empty. AECI-891 reached production, AECI-910 re-anchored the 21 claims those two rows
> carried onto the reach tier, and the consumer then deleted and confirmed the entries. The
> feed is at zero pending. The list mechanism stays — this decision is unchanged — but the
> practice it proved is narrower than the decision: **empty a hold in the same change as the
> run that releases it**, because a discharged hold left in place recreates exactly the
> blind spot the bucket was built to remove. The consumer's numeric guards were reset to
> zero in the same change for the same reason — an authorisation is spent by the run that
> used it, and a later cohort of the same shape would otherwise inherit it.

## Alternatives considered

**Infer deletion from absence in a promote payload.** Rejected, permanently. A promote
payload is a statement about what exists, and absence in a paged, partial push is not
evidence of deletion — the connector arm needs an explicit `deleted` block (§3a) for exactly
that reason. Inferring deletion from absence on the product arm would make every partial push
a potential mass delete.

This is about **absence**, and it is the only thing being rejected here. An **id-directed**
delete — the cross-table move in the 2026-09-14 amendment, where the payload names the row
and states its new routing key — is not covered by this rejection and never was; the forward
half of it already shipped with AECI-721, before this ADR was written.

**`promotion_status = 'retracted'`.** Already reserved and inert: zero rows carry it,
nothing upstream writes it, and nothing in AECi's promote path reads it. Making it live
would put a destructive action behind a field that looks like metadata.

**Detect-only, with a human executing each row.** The right v1 when the feed was empty and
the job was to catch the next strand. It stopped fitting at 216 entries: a detect-only poll
produces one alert naming 216 rows and clears none. The per-row human ruling also does not
scale here, because all 215 share one editorial decision applied 215 times, not 215
decisions.

**A `pnpm ops:*` CLI in `apps/api` with unit tests.** Genuinely better on testability —
`scripts/ops/**` has no test harness, so the confirm gate is structural rather than
unit-tested. Rejected on the credential boundary above. The trade is recorded in the lane
README rather than left for a reader to discover.

## Consequences

- **Deleting a row is now a repeatable operation, not a bespoke script per incident.** The
  four 2026-09 retraction lanes each transcribed the same logic for one row. This one takes
  whatever the feed holds and is re-runnable.
- **This is the first code path in the repo that can delete from
  `connector_evidenced_pairs`.** Neither the datatool prune nor `ops:retract-product` can
  touch that table; the latter also cannot *see* it, which is a separate latent defect
  (its `products` delete cascades evidenced pairs away silently). *(Fixed 2026-09-21 by
  AECI-687: `ops:retract-product` now counts evidenced pairs in its footprint, refuses them
  without `--force`, and deletes them explicitly with an `integration.deleted` tombstone.
  AECI-904 then split the gate: the footprint counts pairs per role, and they refuse unless
  `--delete-evidenced-pairs`, which `--force` does not imply. It is still a product-level
  tool, not a per-pair one — this consumer remains the per-pair path.)*
- **A crashed run is recoverable by construction.** The consumer recognises its own
  `audit_log` rows by `metadata.tool` and confirms entries it can prove it deleted. The
  first production run exercised this for real: the confirm step died on an expired MCP
  session after all 214 deletes had landed, and the re-run closed them out.
- **The undo is a whole-database restore, not a file.** D1 has no statement-level undo. The
  lane writes `rollback-<stamp>.sql` before any write, but Cloudflare D1 Time Travel — 30
  days, whole database — is the real backstop, and the lane README records the bookmark
  taken before the 2026-09-13 run.
- **`docs/CICD_PLAN.md` §7.1 can no longer describe `AECI_MCP_TOKEN` as read-only on our
  side.** It is read-only in the audit lane and read-plus-one-write in the consumer lane.
