# 2026-08 page-view bot backfill (AECI-582)

Classify the historical `page_views` rows that were counting as **humans**. Rows captured
before the traffic classifier shipped have `is_bot IS NULL`, and every read predicate in
the app is the NULL-safe `is_bot IS NOT 1` (`HUMAN`, `apps/api/src/lib/analytics-digest.ts`)
— so an unclassified row *is* a human as far as the daily digest and the admin panel are
concerned. On production that was **17,784 of 26,671 rows**.

**Status: run on all four tiers 2026-08-13.** See the run log at the bottom.

## What it applies, in order

Both files are gated on `is_bot IS NULL`, so the first rule to match a row claims it —
which is why the order matters. A name the crawler told us beats a label inferred from
its hosting provider.

| | Rule | File |
|---|---|---|
| **A** | `user_agent_hash` → the **true crawler name** the live classifier has since given that same hash (`Applebot`, `Bingbot`, `OpenAI`, …) | `recover-ua-names.sql` |
| **A2** | One identified crawler cohort with no recoverable name | `recover-ua-names.sql` |
| **B** | `cf_asn` ∈ `DATACENTER_ASNS` → bot, labelled with the hosting org | `../backfill-page-view-bots.sql` |
| **C** | Everything still unclassified → `is_bot = 0` | `../backfill-page-view-bots.sql` |

### Why rule A exists

The raw User-Agent is discarded at capture — only its SHA-256 hash persists — so the
received wisdom was that historical rows can only be classified by ASN. That is half
right. `classifyTraffic()` tests the UA **before** the ASN, so any row the live classifier
labelled with a `NAMED_BOTS` name or `Other bot` was decided by the UA alone, and that
verdict is a property of the UA string rather than of the network the request came from.
It therefore transfers to every older row sharing the hash, whatever its ASN.

On production that recovered **4,941 rows** with real crawler names instead of datacenter
labels — including **885 `Applebot` rows on AS714 (Apple), an ASN the ASN rule deliberately
does not list**, because Apple's network also carries iCloud Private Relay users.

That distinction is the whole point. `DATACENTER_ASNS` drives the **live** classifier as
well as the backfill, so "just add AS714" would have taught production to call every future
Private Relay visitor a bot — the same error this backfill exists to correct, pointed the
other way. Rule A reaches those rows without touching the live classifier at all.

## Run it

Needs `CLOUDFLARE_API_TOKEN` (Account → D1 → Edit) + `CLOUDFLARE_ACCOUNT_ID`.

```bash
# dry-run — census + projection + backup, writes nothing:
scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production

# apply:
scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production --apply --allow-production
```

Dry-run by default; `--apply` writes; production additionally demands `--allow-production`.
Idempotent — a second run matches zero rows.

**Every run, including a dry-run, first exports `page_views` and records a Time Travel
bookmark** into `backups/<UTC-stamp>-<env>/` (gitignored). D1 has no undo. Rule C hard-sets
every remaining row to `is_bot = 0`, which destroys the "never classified" signal — after
it runs there is no way to tell "confirmed human" from "never looked at", and a later
widening of `DATACENTER_ASNS` can no longer reach those rows via `is_bot IS NULL`. Fix
those with a targeted `UPDATE … WHERE is_bot = 0 AND cf_asn IN (…new asns…)`.

## The one judgement call

Rule A2 marks 441 rows as bots on circumstantial evidence: a single UA hash served 440
views across 16 paths in **one day** (2026-07-06) from two different China Mobile ASNs
(9808 + 56045), and was never seen again. One client, one burst, two consumer networks.
Its UA never appears after the classifier shipped, so there is no name to recover and no
way to confirm it. Delete that statement and the 441 rows stay human.

## Run log

| Date | Tier | Rows | Unclassified before | Bot after | Human after |
|---|---|---|---|---|---|
| 2026-08-13 | `aeci-app-preview` | 646 | 646 | 588 | 58 |
| 2026-08-13 | `aeci-app-staging` | 660 | 660 | 588 | 72 |
| 2026-08-13 | `aeci-app-demo` | 19,557 | 17,784 | 17,745 | 1,812 |
| 2026-08-13 | `aeci-app-production` | 26,671 | 17,784 | **24,575** | **2,096** |

Production, by rule: A 4,941 · A2 441 · B 10,844 · C 1,558 (= 17,784).

Production "reads as human" went **18,322 → 2,096**. Full before/after and the reading
consequences are recorded in `docs/POST_LAUNCH_HEALTH_REPORT.md` (2026-08-13 entry).
