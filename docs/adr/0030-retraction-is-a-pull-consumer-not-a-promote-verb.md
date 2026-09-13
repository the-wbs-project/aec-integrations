# 0030 — Retraction is a pull consumer, not a promote verb

**Status:** Accepted
**Date:** 2026-09-13
**Issue:** AECI-882 (epic), AECI-811, AECI-878
**Supersedes:** nothing. Completes the AECi half of AECI-595, whose upstream half shipped 2026-09-07.

## Context

Promote can create and update rows. It can never delete one
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
buckets exclude `connector_evidenced_pairs` by design — classifying it against
`list_integrations` would flag every row every run — so they reported **clean** on every
run between 2026-09-10 and 2026-09-13 while 215 retracted pairs were live and public.

That bucket carries a `HELD_RETRACTIONS` list: entries held on a recorded decision are
printed but do not fail the run. Without it, two deliberate holds would leave the job red
every day until they clear, and a permanently red guard is one nobody reads — which would
hide the next retraction behind the two we already know about. Each hold names the issue
that clears it.

## Alternatives considered

**Add delete semantics to promote.** Rejected. A promote payload is a statement about what
exists, and absence in a paged, partial push is not evidence of deletion — the connector
arm needs an explicit `deleted` block (§3a) for exactly that reason. Inferring deletion
from absence on the product arm would make every partial push a potential mass delete.

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
  (its `products` delete cascades evidenced pairs away silently).
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
