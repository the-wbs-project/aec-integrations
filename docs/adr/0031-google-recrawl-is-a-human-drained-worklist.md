# 0031 — Google re-crawl is a human-drained ranked worklist, not an automated push

**Status:** Accepted
**Date:** 2026-09-14
**Issue:** AECI-943 (epic), AECI-945, AECI-946
**Supersedes:** nothing. Sits beside ADR 0025, which answers a different question about a different engine.

## Context

Bing and Yandex are fed automatically. A write appends the public URLs it affected to
`indexnow_queue`, and a `*/20` cron submits the buffer in one request (ADR 0025). That channel
is a solved problem in shape, whatever its current health.

**Google has no equivalent and cannot be given one.** Its Indexing API is documented for
`JobPosting` and `BroadcastEvent` only. AECI-263 shipped a ping against it anyway, and every
submission we made was discarded on arrival; AECI-747 deleted the transport once Google's own
documentation confirmed why. Nothing replaced it, because nothing can.

What survived was a manual step: the operator opens Search Console, runs **URL Inspection →
Request Indexing** on the pages a promote just changed, and repeats until Google stops
accepting requests. AECI-799 recorded that this step existed, having found that nothing in
`docs/` said so. It described the step as "undelegated, unmonitored and invisible".

Three facts make the manual step harder than it sounds.

1. **The quota is real, per-property, daily, and unpublished.** A light week uses a handful of
   requests. A heavy curation session hits the cap outright. Google changes the number without
   notice, so there is nothing to plan against.
2. **The operator worked from memory.** Which URLs a promote touched is derivable from the
   promote response and was derived nowhere. A session interrupted halfway left no record of
   where it stopped.
3. **Vendors are about to write.** Stage 2 shipped the vendor portal **dark** — merged and
   live, with no seats granted — so today every public-page change still comes from a promote.
   That ends at the first seat grant, which is Stage 2.1's exit condition. A seated vendor can
   change a product page that no promote will touch again for weeks, so the set of pages
   needing attention stops being "what I just promoted". Building the worklist before the
   grant rather than after is the cheap order: the alternative is discovering the gap with
   real vendors already editing.

So the question this record answers is not *how do we push to Google*. It is: **given that a
person is the only transport, what should the machine do?**

## Decision

**Queue the work, rank it, and let a person drain it. Build no automation for the last step
and no cron for the queue.**

### 1. A second table, not a column on `indexnow_queue`

`gsc_recrawl_queue` (`DATABASE_SCHEMA.md` §9.8, migration `0036_youthful_vengeance.sql`) is a
sibling table, and two structural facts forced that rather than a `status` column.

**That drain deletes by cursor.** `deleteSubmittedThrough` removes rows with
`where id <= :maxId`, one bound parameter, chosen because D1 caps a query at 100 of them.
Retaining rows for a second, slower consumer breaks the cursor, or forces the drain to learn a
status column it has no reason to know about.

**The two consumers want opposite things.** IndexNow is free, batched and unranked, so it takes
everything indiscriminately. Request Indexing is quota-capped, so this list has to be
*ordered*, and a row may sit on it for weeks. Those are different lifecycles, and one row
cannot carry both.

### 2. The list is RANKED, never filtered

`apps/api/src/lib/gsc-recrawl-priority.ts` maps every `reason` to a tier from 1 to 4. The
ranking is a diagonal over two axes: page type (product, vendor, pair) and change class (new
page, material edit, minor edit).

| Tier | What it is | `reason` |
|---|---|---|
| 1 | A new product page | `product.created` |
| 2 | A new vendor page, or a material change to a product page | `vendor.created`, `product.updated` |
| 3 | A new pair page, a newly published trade page, or a material change to a vendor page | `pair.created`, `trade.published`, `vendor.updated` |
| 4 | A change to an existing pair page, or any minor edit | `pair.updated`, `product.minor`, `vendor.minor` |

**Nothing is dropped, and this is the load-bearing half of the decision.** Living inside a cap
has two shapes: discard the low-value work, or rank it. A filter is **silently lossy**. The
operator never sees what a rule decided to discard, so a rule that turns out to be wrong is
undetectable, and the only evidence would be a page that quietly never got indexed. Ranking
keeps everything, spends the quota top-down, and leaves tier 4 unreached on a busy week. The
failure mode becomes "I did not get to it", which is on the screen, rather than "it never
existed".

**It is a map rather than a formula.** `pageTypeRank + changeClassRank` reproduces the table
exactly and was rejected. `trade.published` is already outside both axes, since a trade page is
neither product nor vendor nor pair, so the formula would have to be rewritten rather than
edited the first time a reason needed to sit somewhere it does not put it. A re-tune is
expected, and a map is what a re-tune touches. The map is exhaustive over the reason union at
the type level, so a new reason cannot ship untiered.

### 3. Nothing ages a row out

`indexnow_queue` drops rows past `INDEXNOW_QUEUE_MAX_AGE_DAYS` (7), because a missed ping is
recoverable: the sitemap covers the URL within days and dropping it decided nothing.

**Here an aged-out row is work silently discarded that nobody ever saw.** There is no staleness
sweep, there must not be one, and unbounded growth is the cheaper failure. The table's own
bound is the `url` unique index, which collapses a page edited fifty times into one row. The
only other disposal path in the module is `deleteGscRecrawlForeignHosts`, which drops rows whose
host no longer matches `PUBLIC_SITE_URL` after an environment re-point, because those URLs name a
property the operator cannot paste them into. It is a statement builder with no caller as
shipped, and it is not a sweep: it fires on a re-point, never on age.

### 4. Conflict raises priority and preserves `queued_at`

`on conflict (url) do update` taking `min(existing, incoming)`, because 1 is the most important
tier. A page that had a logo swap (tier 4) and is then renamed (tier 2) must **rise** to 2.
Under `do nothing` it would keep the logo swap's tier and stay buried at the bottom of a list
the operator never reaches, which is indistinguishable from never having queued it.

`queued_at` is deliberately absent from the update set. Ordering inside a tier is oldest-first,
so refreshing the timestamp would let a page someone keeps editing starve an older one forever.

### 5. Done deletes, and it audits per row

`DELETE /api/admin/reindex/:id` removes the row. A `requested_at` column would mean an
empty-looking screen could still hold rows, so the nav badge would have to distinguish
"pending" from "pending and not yet dismissed", and the operator would have to trust that
distinction at a glance. Deleting makes an empty list mean exactly one thing. Nothing is lost,
because a later edit to the same page inserts a fresh row.

The delete emits one `audit_log` row in the same `db.batch`, `action='reindex.cleared'`,
attributed to the admin rather than to `'system'`. **§26.1's scheduled-deletion exception does
not reach it.** That exception allows a cron one summary row per run. This is an operator
action with an actor, a request and a single subject, so the ordinary per-write invariant
applies unchanged. The discriminator is *scheduled*, not *queue*.

### 6. The Google list is not the IndexNow list

The Google deriver emits **entity detail pages only**. `affectedUrlsForPromote` also emits
`/products`, `/categories`, `/trades` and `/` on a term creation; this one emits none of them.

A hub page is the part of the site Google already re-crawls on its own. It is linked from every
page, it changes constantly, and it carries no content beyond its tiles. A Request Indexing slot
spent on `/products` is a slot not spent on a page Google has never seen. IndexNow can afford to
be indiscriminate. This cannot.

## Alternatives considered

**A drain cron that submits to the Indexing API.** Declined because the API does not accept our
content types. This is not a cost or complexity judgement. There is no endpoint to call.
**Re-open trigger:** Google documents `SoftwareApplication`, `Organization` or general web-page
URLs as accepted `urlNotifications:publish` types. If that ever happens, §2's ranked worklist
survives unchanged and becomes the thing that drives the drain, so this decision does not have
to be unwound first.

**Browser automation against Search Console.** Declined. It would be an unsupported,
unauthenticated-by-design scrape of another company's console, against an explicit quota,
using the operator's own credentials. The blast radius of getting it wrong is the property, not
the job.

**A staleness sweep, for symmetry with `indexnow_queue`.** Declined, and §3 is the reason. The
symmetry is superficial: the two tables differ in whether a dropped row is recoverable, and
that difference is the whole design.

**An alert on queue depth.** Declined, and recorded in `docs/RUNBOOKS.md` rather than left
unmentioned. A healthy queue is a non-empty queue, because every write appends and tier 4 may
never be reached. Depth cannot separate a busy catalogue from a neglected queue, so an alert on
it fires on ordinary days. **Re-open trigger:** the nav badge proves ignorable. The signal to
build then is the age of the oldest tier-1 or tier-2 row, not depth.

**Filtering low-value events out instead of ranking them.** Declined, and it is the alternative
this record most wants to argue against. It is cheaper, it produces a shorter list, and it is
wrong for one reason: the operator cannot audit a decision they never saw. §2 has the argument.

**Keeping the IndexNow table and adding a `priority` column.** Declined for the two structural
reasons in §1, not for tidiness.

## Consequences

- **The last step is still manual and still undelegated.** Nothing in this record changes that,
  and nothing can while the API refuses our content types. What changed is that the step now
  runs off a list instead of out of memory, and that the omission is visible as a badge.
- **A new admin screen and a new badged queue.** `/admin/reindex` (`ADMIN_PANEL_SPEC.md`
  §5.11) is the fourth Operations queue. It is the first one that counts a table other than
  `reviews` or `vendor_requests`, which makes §5.0c's disjointness argument trivial for it.
- **Tier 4 may never be reached, permanently.** That is the accepted cost of ranking over
  filtering. A minor edit to an existing pair page can sit in the queue indefinitely, and the
  sitemap's `<lastmod>` remains its discovery path, which is what it would have been under a
  filter too.
- **Two queues now share one gate.** Both appenders check `INDEXNOW_KEY` **and**
  `PUBLIC_SITE_URL`, which looks wrong for a table with nothing to do with IndexNow. The API
  Worker has no `ALLOW_INDEXING` var, and `INDEXNOW_KEY` is provisioned only where
  `ALLOW_INDEXING="true"`, so it is the only available "this environment is public and
  indexable" signal inside this Worker. A second var expressing the same fact would mean five
  more wrangler blocks to keep in step and a new way for them to drift.
- **One new metric and no new alert.** `aeci.gsc_recrawl.queued{source:promote}`. Absence is
  ambiguous by construction, so the depth on `GET /api/admin/summary` is the reading that
  matters. `docs/OBSERVABILITY.md` has both.
- **ADR 0025 is untouched in substance.** Its buffer, its cron, its retry gate and its alert
  are unchanged. The one thing this work did to it is give `indexnow_queue` a second appender
  (AECI-944), which the `url` unique index already deduped across.

## References

- `docs/STAGE_1_SPEC.md` §20.2 (the contract), §20.5 (the write-event pipeline), §26.1 (why the
  DELETE audits per row)
- `docs/DATABASE_SCHEMA.md` §9.8 (the table), §9.6 (the sibling)
- `docs/ADMIN_PANEL_SPEC.md` §5.11 (the screen), §5.0c (the fourth badge)
- `docs/API_CONTRACTS.md` §6.10 (the two endpoints)
- `docs/environments.md` → "Request indexing by hand (Google)" (the operator procedure)
- `docs/RUNBOOKS.md` → "There is no runbook for an unworked Google queue" (the declined alert)
- ADR 0025 (the IndexNow buffer), ADR 0022 (why the INSERTs are audit-exempt)
