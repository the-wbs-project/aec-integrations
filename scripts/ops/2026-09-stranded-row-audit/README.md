# AECI-767 — stranded row audit (upstream delete / reject)

Read-only sweep for **production D1 rows whose upstream curation record is gone or
rejected**. It answers the question AECI-595 could not be prioritised without: is the
stranded tail two rows or two hundred?

> **Status (2026-09-08): CLEAN. Zero rows in every bucket**, reconciling 252/252 products
> with no unresolved reads. The tail this sweep opened with on 2026-09-07 — seven rows, all
> publicly reachable, all in search — was drained by hand over two days (AECI-593, AECI-685,
> AECI-794, AECI-795).
>
> **Two things changed on 2026-09-08 besides the count.** This lane is now the **daily CI
> audit** (AECI-796), not a one-off measuring instrument, so a clean result is a claim that
> gets re-tested every morning rather than a snapshot. And the review app's `list_products` /
> `list_vendors` projections now carry `supabaseId`, so the sweep costs ~64 fallback calls
> instead of ~300 and runs in about two minutes.
>
> The original finding is preserved below and is still the point of the exercise: **zero
> stranded products**, damage confined to one vendor and six edges, and **five of the seven
> rows belonged to issues already filed — two of them under an issue marked Done** whose own
> verification step could never have held. See
> [Measurement](#measurement--2026-09-07-production) and [Run log](#run-log).

**Read-only.** There is no `--apply` flag and no write path. Retraction is a separate,
authorized action — `pnpm --filter @aeci/api ops:retract-product` for a product, the
datatool `POST /api/prune-integrations` for integrations.

---

## The gap this measures

`docs/REVIEW_APP_PROMOTE_API.md` §5.1: **"A promote can create and update rows. It can
never delete one."** So when a curator deletes a curation record, or moves it to
`rejected`, the D1 row it produced stays live, indexable and un-updatable. Nothing
notices. AECI-593 (2 Polycam edges) and AECI-685 (the dead `bluebeam` vendor) are the
two instances found **by eye**; this sweep is the first systematic look.

### Why it runs upstream-first

**D1 stores no upstream record id** (`docs/REVIEW_APP_PROMOTE_API.md:71`; AECI-562 was
canceled on purpose — no curation-tool key in the public schema). The only link is the
`supabaseId` the _review app_ holds. There is therefore no D1 → upstream walk: the
sweep enumerates upstream, builds the set of D1 ids upstream still **claims**, and
treats the D1 rows outside that set as stranded.

### How this differs from the 2026-08 strand audit it replaced

`scripts/ops/2026-08-promote-strand-audit/` computed the same set difference as its
`stray` bucket, reading Airtable directly, and was *scheduled* daily in CI — though it never
actually executed once (see below). **This lane was not a duplicate of it.** It adds the
three things that audit deliberately did not do:

1. **Why the claim is gone** — DELETED upstream vs **REJECTED** upstream. A rejected
   record is invisible to every ordinary MCP read tool (`list_products` excludes them
   with no opt-in), so `find_product` with `include_rejected` is the only way to tell
   the two apart.
2. **The transitive damage** — a stranded product strands its integrations, which
   strand their claims and attestations.
3. **Public reachability and the retraction cascade**, per row.

**And on 2026-09-07 a fourth difference superseded the rest: the review app no longer runs
on Airtable.** It has its own D1 (`server/db/ids.ts` keeps the `rec…` id *format*, which is
why the ids still look Airtable-shaped — `apps/api/src/db/schema.ts:1755-1776` says so
explicitly). The 2026-08 audit read `api.airtable.com` directly, so it was not merely
uncredentialed — **its data source was decommissioned and it could not be made to work again
as written**. Its `audit.mjs` was deleted on 2026-09-08; its README survives for the
§Healing recipes and the 2026-08-13 measurement.

So this is the **replacement**, not the companion, and since AECI-796 it is what the daily
job runs. The "make a cheaper integrations-only mode for the cron" split that question
originally implied was dropped: the sweep self-optimises instead. See
[Runs daily in CI](#runs-daily-in-ci) and
[Non-goals](#non-goals).

## Buckets

| Bucket                        | Meaning                                                                                               | Disposition                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `productRejectedUpstream`     | D1 product no live upstream record claims, and `find_product(include_rejected)` finds it **rejected** | The headline class: a public page asserting something the catalogue has ruled out. Retract. |
| `productDeletedUpstream`      | D1 product no upstream record claims at all                                                           | Find the ruling before retracting — see the strand audit's §Healing.                        |
| `vendorNoLiveProducts`        | D1 vendor with zero products (the AECI-685 shape)                                                     | A vendor page rendering an empty grid. Redirect, then delete.                               |
| `vendorSourceGone`            | D1 vendor no upstream vendor record claims                                                            | Curation judgment.                                                                          |
| `integrationSourceGone`       | D1 integration whose id no upstream record carries (the AECI-593 shape)                               | **Never a mechanical delete.** Check for a recorded editorial ruling first.                 |
| `integrationEndpointStranded` | Integration whose `source` / `target` / `built_by` / `powered_by` resolves to a row stranded above    | Usually a **re-point**, not a delete — the edge itself is fine.                             |
| `orphanChildren`              | Claims + attestations under any stranded integration                                                  | Cascade only; they cannot be stranded independently.                                        |

### What is deliberately out of scope

- **`connector_evidenced_pairs`.** Fed by the separate connector-catalog promote arm
  (§3a), whose review-side sender (AECI-731) is unbuilt, so no data flows in any
  environment yet. Its rows are counted and reported, never classified — auditing them
  against `list_integrations` would report all of them, every run.
- **Claims and attestations as an independent axis.** `claims.integration_id` and
  `attestations.claim_id` both cascade, so a claim cannot outlive its integration.
  They are reported as cascade weight, not as a bucket.

## Run it

```bash
node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production
node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production --json --out /tmp/r.json
node scripts/ops/2026-09-stranded-row-audit/audit.mjs --env production --refresh-cache
```

Every run writes `report-<UTC>.json` **and** `stranded-ids-<UTC>.txt` — the rollback-ready
id list, grouped by class — next to the script. Both are gitignored: they hold production
catalog content. `--out` moves the report, `--ids-out` moves the id list, `--cache` moves the
upstream snapshot; the CI caller redirects all three (see below). The dated measurement that
matters lives below.

Only `--env production` is meaningful, for the reason both sibling lanes give: the
review app holds **production** uuids in its `supabase*` fields — one curation base,
not one per tier.

### Exit codes — three-valued since AECI-796, and 2 is not a pass

| Exit | Meaning |
| ---- | ------- |
| `0`  | clean and complete — every row is claimed upstream |
| `1`  | stranded rows found — at least one bucket is non-empty |
| `2`  | **could not check** — missing credential, bad args, an incomplete sweep, or a crash |

`2` outranks `1`. A sweep that could not read part of upstream, or whose product classes do
not reconcile, produces a bucket list that is untrustworthy in **both** directions: a row may
be listed only because its record was unreadable, and a row may be missing for the same
reason. Before AECI-796 both of those printed a WARNING and exited **0**, so a run where
every upstream read failed reported clean. That is the same defect class as the 25 green runs
of the workflow this lane replaced, which is why it was worth fixing here rather than in the
caller. `report.clean` had always accounted for it; only the exit code had not.

An uncaught throw — a wrangler failure, a dead MCP handshake — also lands on `2`. Node's
default for an uncaught throw is `1`, which would have arrived wearing the costume of a real
finding.

**A failed `find_product` is not a stranded product.** That call is the only read that can
tell a *deleted* upstream record from a *rejected* one, so when it fails the D1 row is left
out of every bucket rather than filed as `productDeletedUpstream`. Two reasons. It would be a
phantom finding at exit 1, and the `stranded-ids` file beside the report is what an
authorized retraction consumes verbatim — an unverified id has no business in it. The
omission fails `reconciles`, so the run still exits `2`, and the row appears in
`unresolvedUpstream` as `{ kind: 'product-lookup', d1Id }`.

The line between `1` and `2` is the one `scripts/ci/posthog-liveness-sweep.sh` draws for the
same reason: "the sweep could not run" is not "the thing being swept is fine".

**None of this has an automated test.** There is no test harness for `scripts/ops/**`
anywhere in the repo — no vitest include, no package script — so do not assume coverage. The
exit codes are checked by hand: `--help` (2), a run with `AECI_MCP_TOKEN` unset (2), and a
real production run (1 while AECI-795 is open).

### Runs daily in CI

`.github/workflows/promote-strand-audit.yml`, 09:00 UTC, production only, since AECI-796.
That file's header carries the full contract — why it is scheduled rather than a PR check,
why it never heals, and why it has no skip-green branch. The invocation:

```bash
node scripts/ops/2026-09-stranded-row-audit/audit.mjs \
  --env production \
  --refresh-cache \
  --cache "$RUNNER_TEMP/upstream-cache.json" \
  --out "$RUNNER_TEMP/stranded-row-audit.json" \
  --ids-out "$RUNNER_TEMP/stranded-ids.txt"
```

Every writable path goes to `RUNNER_TEMP`, and nothing is uploaded as an artifact: all three
outputs are production catalog content. `--refresh-cache` is belt-and-braces on a fresh
runner — the snapshot is reused **silently** when present, so a future runner-cache change
must not be able to turn the job into a replay of an old measurement.

### Credentials

| Variable                | Used for                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | `wrangler d1 execute --remote`. Account → D1 → **Read** is sufficient; this sweep never writes. |
| `CLOUDFLARE_ACCOUNT_ID` | ditto                                                                                           |
| `AECI_MCP_TOKEN`        | the review-app MCP (`.mcp.json`, injected from the Conductor keychain)                          |

No `AIRTABLE_TOKEN` — and as of 2026-09-07 that is no longer merely a convenience.
**The review app is off Airtable**, so there is no Airtable base to point a token at;
`AECI_MCP_TOKEN` against the review app's own MCP is the only way in. `mcp-client.mjs`
(copied from `2026-08-powered-by-backfill`, plus `find_product` on the allow-list) is
that path. The sibling lane's Airtable-PAT instructions are gone — its `audit.mjs` was
deleted on 2026-09-08 and its README is history only.

### The upstream cache

The upstream phase used to cost ~300 `get_product` / `get_vendor` calls against a
**rate-limited** production curation DB, so its result is snapshotted to
`.upstream-cache.json` (gitignored) and reused. `--refresh-cache` re-reads it.

**That cost has largely gone.** The review app's `list_products` / `list_vendors` projections
now carry `supabaseId`, so most records resolve off the paged list. Measured 2026-09-08:
`fastPath: products {fromList: 252, viaGet: 38}, vendors {fromList: 167, viaGet: 26}` — about
64 fallback calls instead of ~300, and a run of roughly two minutes. The cache matters much
less than it did; prefer `--refresh-cache`. Watch the `fastPath:` line: `fromList: 0` means
the projection regressed and the slow path is back.

The cache is a convenience for iterating on the D1 half within one sitting — **not** a
substitute for a fresh read. Every published measurement must come from a run whose
cache is same-day.

### Three things that bite, all found the hard way on 2026-09-07

1. **The review app rate-limits — `{ limit: 100, period: 10 }` keyed on
   `CF-Connecting-IP`** (their `wrangler.jsonc:96-102`). So ~10 req/s sustained, no burst
   beyond that window, **no per-token quota**, and every 429 carries `retry-after: 10`.
   The check runs **before auth**, so a scheduled job shares the budget with anything
   else on the same egress IP — aim at **5 rps**. Eight concurrent `get_product` calls
   tripped it partway through the first run and killed it with nothing written.
   `mcp-client.mjs` now retries 429/5xx with exponential backoff and honours
   `Retry-After`; concurrency defaults to **3** (`AECI_MCP_CONCURRENCY` overrides). The
   2026-08 copy of that client has neither. Note a single `tools/call` fans out to
   several D1 queries upstream, so per-call cost is not uniform — `get_product` is four
   neighbourhood reads plus a taxonomy batch.
2. **A tool can fail server-side and return a bare string.** One `get_product`
   returned `Failed query: SELECT id FROM products WHERE …` as its text payload, which
   a blind `JSON.parse` reports as a meaningless `SyntaxError`. **Not a query bug** —
   the review app diagnosed it as Drizzle's `DrizzleQueryError`, whose `.cause` carries
   the real D1 error and whose `.message` is just the SQL; their MCP error formatter
   dropped the cause. They are fixing the formatting, so future failures should say what
   actually went wrong. The retries were the right response regardless: the client now
   names the tool and echoes the text, the sweep retries three times, then records the
   record in `unresolvedUpstream` and **refuses to report `clean`** while that list is
   non-empty. A sweep that could not read upstream must never look like a green one.
3. **D1 will reset you for a correlated subquery.** `(SELECT count(*) FROM claims
WHERE integration_id = i.id)` over 927 integrations returned _"D1 DB exceeded its
   CPU time limit and was reset"_ (code 7429). Every count in this script is a
   `GROUP BY` aggregate joined in JS instead.

## Measurement — 2026-09-07, production

`aeci-app-production` vs the review app. Reconciled: **247/247 products accounted
for**, **0 unresolved upstream reads**.

| Side                  | Products             | Vendors              | Integrations                            |
| --------------------- | -------------------- | -------------------- | --------------------------------------- |
| Upstream (review app) | 1,535 (285 resolved) | 1,010 (190 resolved) | 2,441 (942 carry an id)                 |
| Production D1         | 247                  | 165                  | 927 (+19 evidenced pairs, out of scope) |

| Bucket                        | Count                     |
| ----------------------------- | ------------------------- |
| `productRejectedUpstream`     | **0**                     |
| `productDeletedUpstream`      | **0**                     |
| `vendorNoLiveProducts`        | **1**                     |
| `vendorSourceGone`            | **0**                     |
| `integrationSourceGone`       | **4**                     |
| `integrationEndpointStranded` | **2**                     |
| `orphanChildren`              | 7 claims / 7 attestations |

**The product tier is clean.** All 247 live products are claimed by a live upstream
record, and the `find_product` second pass found **no** rejected record pointing at a
live D1 row. The reject→retract flow has been working; the 3 dangling pointers the
2026-08-13 strand audit found were its residue, in the _opposite_ direction, and were
healed then.

### Publicly reachable stranded rows — all 7, all in search

This is the subset that matters. Public reachability is **not** gated on
`promotion_status`: the read handlers apply no status filter, so a row that exists is
live (see [Two gates](#two-gates)).

| URL                                                              | Bucket                        | Cascade                  | What it is                                                             |
| ---------------------------------------------------------------- | ----------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `/vendors/bluebeam`                                              | `vendorNoLiveProducts`        | 0 products               | **AECI-685 / AECI-792** — D1 delete **applied 2026-09-07**, see below. |
| `/products/polycam/integrations/arcgis`                          | `integrationSourceGone`       | 1 claim, 1 attestation   | **AECI-593** — reopened and **retracted the same day**, see below.     |
| `/products/polycam/integrations/autocad`                         | `integrationSourceGone`       | 2 claims, 2 attestations | **AECI-593** — reopened and **retracted the same day**, see below.     |
| `/products/procore-project-management/integrations/followup-crm` | `integrationSourceGone`       | 2 claims, 2 attestations | **AECI-794** — ruled and **retracted 2026-09-08**, see below.          |
| `/products/microsoft-dynamics-365/integrations/monday-com`       | `integrationSourceGone`       | 1 claim, 1 attestation   | **New** — AECI-795. No twin.                                           |
| `/products/autodesk-revit/integrations/bluebeam-revu`            | `integrationEndpointStranded` | 1 claim, 1 attestation   | `built_by` → the dead Bluebeam vendor. **Re-pointed 2026-09-07.**      |
| `/products/bluebeam-revu/integrations/okta`                      | `integrationEndpointStranded` | 0                        | `built_by` → the dead Bluebeam vendor. **Re-pointed 2026-09-07.**      |

### The headline: detection is not the weak link — execution is

- **`/vendors/bluebeam`** (`b52e0001-8b9e-40c5-87fc-953c2e0dd843`) — the AECI-685 row,
  and that issue is correctly **In Progress**. Its 301 redirect shipped at `5a7af578`
  on 2026-09-05, whose commit message says _"The row is being deleted from production
  D1."_ That delete has **not** happened: the row is still live, still
  `promotion_status = 'promoted'`, still in Algolia, still rendering an empty product
  grid behind the redirect. Upstream corroborates the shape exactly — the `Bluebeam`
  vendor record (`recyPyhW3fe9p73Qe`) still exists but now has `toolCount: 0`, both
  products having moved to `Nemetschek Group` (`toolCount: 8`). Nothing here is news to
  AECI-685, which already enumerates the blockers; this run simply confirms the state
  independently, four weeks on.
  **Closed the day after this sweep ran:** the vendor row was deleted from production D1
  on 2026-09-07 and both `built_by` edges re-pointed to Nemetschek Group, so this row and
  both `integrationEndpointStranded` rows below are gone from the 2026-09-08 re-run.
  Record: `scripts/ops/2026-09-bluebeam-vendor-retraction/README.md` (Algolia, cache and
  the upstream record delete were still outstanding at that point).
- **The two Polycam edges** (`74099c42-…`, `4dc9d4bb-…`) — these are AECI-593's rows,
  and **AECI-593 is marked Done** (closed 2026-08-13). Its own Verify step reads _"the
  strand audit returns `Integrations → stray: 0`"_, and that is still false today.
  What actually shipped under it was PR #510 — the datatool's named-guard
  acknowledgment and the daily audit workflow, i.e. the _tooling_ for the retraction —
  while the retraction itself was never performed. Upstream now holds only `Polycam ↔
SketchUp` and `Polycam ↔ Xactimate`, confirming both records are gone. The rows have
  been live and indexed for **four weeks**, not the four days the issue recorded.
  **Closed the same day this sweep ran:** AECI-593 was reopened and the retraction
  executed against production on 2026-09-07 — both rows, 3 claims and 3 attestations
  deleted, `integration_count` repaired (polycam 3→1, autocad 12→11, arcgis 18→17), both
  Algolia objects removed. Record: `scripts/ops/2026-09-polycam-retraction/README.md`.
  A re-run of this audit no longer lists either id.

### The daily backstop had never run — fixed 2026-09-08

The obvious reading of the above — "the daily audit went red for four weeks and nobody
acted" — is **wrong**, and the truth is worse.

`.github/workflows/promote-strand-audit.yml` skips green when `AIRTABLE_TOKEN` is
absent, on the reasoning that a red-on-arrival cron teaches people to ignore the cron.
**That secret was never added.** `gh secret list` does not contain it, and all **25**
scheduled runs since the workflow shipped on 2026-08-13 report `success` after logging
`AIRTABLE_TOKEN is not set — skipping the strand audit` and running the audit zero
times. Verified on run `34033166656` (2026-09-06): `AIRTABLE_TOKEN:` is empty, the
`::warning` fires, the job exits 0.

So the backstop AECI-593 shipped **has never executed once**, and its green history is
indistinguishable from a healthy one.

**And the secret was not the fix.** The review app had since moved off Airtable onto its
own D1, so `scripts/ops/2026-08-promote-strand-audit/audit.mjs` — which read
`api.airtable.com/v0/appy81IdGJY6Fngf9` directly — pointed at a decommissioned system.
Minting a PAT would not have revived it; there was nothing to authenticate against. The skip
branch was hiding an audit that had *also* gone obsolete underneath it, which is why
"just add the secret" was never done.

**Fixed 2026-09-08 (AECI-796).** The workflow now runs *this* lane over `AECI_MCP_TOKEN`,
the transport this README already proved works. The skip-green branch is gone — a missing
credential exits 2 and goes red — the Airtable script is deleted, and the audit's own exit
code no longer reports clean on an incomplete sweep. The one thing the fix cannot supply is
the credential itself: `AECI_MCP_TOKEN` has to be added to the repo secrets, and until it is
the job is red on exit 2, which is the intended state rather than a regression.

That reframes what this sweep found. It was not that the detector worked and the
follow-through failed — **the detector had never been switched on**, and the only two
things that had ever found a stranded row were a human noticing and this one-off run.
Worth weighing when AECI-595's priority is set: a retract _feature_ is worth less than a
retract _detector that actually runs_. Since 2026-09-08 there is one.

### Every disposition is now settled (review app, 2026-09-07)

The review app answered on all four integration rows and the vendor. **All four
integrations are DELETE; none is an adopt.** Sources are their production D1 and code at
`a29e419`.

| Row | Ruling |
| --- | --- |
| `74099c42-…` polycam ↔ arcgis | **DELETE.** The 2026-08-09 curator decision is recorded verbatim on Polycam's `tool_integration_check_notes` *and* `research_notes`: the integration bar is a **purpose-built mechanism**, and a manual file hand-off ("export a DXF, open it in X") is not an integration however well documented. Full evidence for both removed edges is preserved "for easy re-materialization if the bar ever loosens" — so re-creating them upstream would re-litigate a settled decision. |
| `4dc9d4bb-…` polycam ↔ autocad | **DELETE**, same ruling. |
| `8f5365f9-…` procore → followup-crm | **DELETE — executed 2026-09-08** (`scripts/ops/2026-09-procore-followup-retraction/`). Two records existed upstream and one was **deliberately merged away** under AECI-699 — both cited the same evidence page (`marketplace.procore.com/apps/followup-crm`), "one artifact filed twice, not two". The survivor is `rec1HRURkiFzAPUkn`, carrying `111ed9fc-…` — the reverse-orientation twin this audit spotted. The identical `created_at` is because both were seeded in one discovery pass. |
| `2e6ad5bf-…` dynamics-365 → monday-com | **DELETE**, and this is the one that argues for a retraction channel. The edge *was* materialised in a 2026-07 sweep and is gone now, **with no ruling written down on either side**. Probably swept up by the AECI-700/701 Zapier-convention change, which matches its `iPaaS` kind — but the review app explicitly declines to assert that from the data. No upstream record, no defence: if the edge is real it should be re-materialised deliberately with current evidence, not adopted from a stranded row. |

**The single most useful fact they returned:** Polycam was **re-promoted on 2026-08-25**,
after the deletion, and both rows were still live four weeks later. That is §5.1
demonstrated end-to-end — **a re-promote does not heal a retraction** — and it is the
cleanest evidence available for sizing AECI-595. It took a deliberate, hand-run delete on
2026-09-07 to remove them, which is the whole argument for a retraction channel.

### The Bluebeam vendor: upstream is finished, we are not

Correcting what this README implied. The upstream re-point is **done** — all three
integrations moved to Nemetschek Group (`rec2St6GqFE2YK3eu`) on 2026-09-05, and their
production D1 now shows Bluebeam with **0** `built_by_vendor_id` rows and **0**
`product_vendors` rows.

What has not happened is a **re-promote**, so the change has not reached us:
`last_promoted_at` is 2026-08-27 for Bluebeam Revu and 2026-08-26 for Autodesk Revit,
both before the re-point. AECi keeps rendering "Built by Bluebeam" until one of those
products is pushed again — which AECI-792 gates behind `5a7af578` being live in
production.

And the upstream **vendor row still exists on purpose**: AECI-685's order of operations
is public row first, upstream row last, and their new `deleteVendor` guard now refuses
(409) while `supabase_vendor_id` is set. So do **not** read `vendorNoLiveProducts` here
as "the upstream record is gone" — it is not, and that is deliberate.

### The two genuinely new rows

Both were created in the 2026-07-25 bulk promote and have different dispositions.
Neither is a mechanical delete — a tripped expectation means _stop and check_.

- **`8f5365f9-…` `procore-project-management → followup-crm`** (`partner`). A
  **reverse-orientation twin survives**: `111ed9fc-…` (`followup-crm →
procore-project-management`, also `partner`) carries the identical `created_at`
  `2026-07-25T15:43:40.949Z`, so both were minted in one promote and the upstream
  record for one direction was later removed. Because the pair page is
  orientation-independent (`pair:{min}__{max}`), **retracting this row would not 404
  the URL** — the twin keeps it alive. That makes it the cheaper of the two to
  resolve, and the likelier duplicate. Filed as **AECI-794**, and **executed 2026-09-08**
  (`scripts/ops/2026-09-procore-followup-retraction/`). The duplicate reading was right,
  and it came from the upstream AECI-699 merge note plus the claim data, **not** from the
  prune guards — both of those tripped. `orphansWithoutATwin` matches on
  `(source, target, mechanism_name)`, so it is blind to a reverse-orientation twin.
- **`2e6ad5bf-…` `microsoft-dynamics-365 → monday-com`** (`iPaaS`). **No twin.** The
  upstream `monday.com (ipaas)` record (`recgbcRYqUf2OvSZf`) carries a _different_
  uuid (`048952ee-…`), which is live in D1 on the unrelated `adp-workforce-now ↔
monday-com` pair. So this is not a duplicate of anything — it is an edge whose own
  record is gone. Needs a curation ruling. Retracting it would leave
  `/products/microsoft-dynamics-365/integrations/monday-com` returning 200 with a
  noindexed empty state, not a 404 — but it removes the only copy of that mechanism,
  which is the real reason it needs a ruling rather than a sweep.

Note the first carries the retired `partner` mechanism marker, which AECI-735 left
sequenced behind AECI-712's upstream re-key. Anything that re-keys `partner` rows
should expect to meet this one.

### The two Bluebeam-built edges are a re-point, not a delete

`322ba420-…` and `6c0cbee8-…` are fully claimed upstream and editorially correct. They
are stranded only because `built_by_vendor_id` points at the dead `bluebeam` vendor.
That column declares **no `ON DELETE` action** (`apps/api/src/db/schema.ts:268`;
`docs/DATABASE_SCHEMA.md:337`) — so it is `NO ACTION`, not cascade, and with foreign
keys enforced **the vendor delete is rejected while these two rows still point at it.**
Re-point both to `Nemetschek Group` first, then delete the vendor — which is exactly
the order AECI-685 already prescribes. **That issue also names a second blocker this
sweep does not check**: `page_views.vendor_id` held 29 rows against the same vendor,
and it is a RESTRICT reference too. Treat AECI-685's order of operations as the
authority; this audit only confirms the vendor is still there.

## Non-goals

- ~~**This is not a CI cron.**~~ **Reversed 2026-09-08 (AECI-796). It is the CI cron now.**
  `.github/workflows/promote-strand-audit.yml` runs this lane against production daily at
  09:00 UTC. The original objection was cost — a per-product `get_product` fan-out against a
  rate-limited curation DB — and it was written when the alternative was thought to be a
  cheap integrations-only set difference rebuilt on this transport. Two things settled it the
  other way: the fan-out self-optimises to ~8 paged reads the moment the review app's
  `list_products` / `list_vendors` projections start carrying `supabaseId` (the script
  already reads it when present and prints a `fastPath:` line saying which path it took), and
  a second reduced detector would have meant two sets of bucket semantics to keep in step.

  **The rate allowance this bullet asked for, now that it is wired up.** The review app
  limits 100 requests / 10 s keyed on `CF-Connecting-IP`, checked *before* auth, so the job
  shares its budget with anything else on the runner's egress IP. Standing allowance:
  **concurrency 3 (~5 rps, their own guidance), one run per day, no burst.** Raising the
  cadence, raising `AECI_MCP_CONCURRENCY`, or adding a second scheduled consumer of this MCP
  all need a fresh look at that ceiling — the same permanent-floor discipline
  `2026-08-powered-by-backfill/README.md` applies to its own.
- **No write path, now or in a follow-up commit.** Retraction stays with
  `ops:retract-product` and the datatool prune, both of which carry guards, rollback
  SQL, count repair and reindex. This script emits the id list they consume.

## Two gates

Worth stating explicitly, because the `inAlgolia` column is otherwise easy to misread.

- **Page + sitemap: gated on nothing.** The public read handlers apply no
  `promotion_status` filter (`apps/api/src/routes/products.ts`; `buildProductsWhere` in
  `apps/api/src/lib/drizzle-helpers.ts` has no status clause) and the sitemap pages
  those same endpoints. For a product or vendor, **"publicly reachable" _is_ "the row
  exists"**. The `url` column records where it is, not whether it renders.
- **Search: stricter, and derived.** A product/vendor is indexed iff
  `promotion_status = 'promoted'`, an integration iff **both** endpoints are
  (`apps/api/src/lib/algolia-sync.ts`). This sweep derives that rather than querying
  Algolia, so it needs no fourth credential. In practice the two gates collapse:
  nothing in this repo ever writes `'retracted'` / `'rejected'` into D1 — retraction is
  a hard delete — so the realistic stranded row is `promoted`, indexed and live, which
  is exactly what all seven are. `apps/api/src/lib/algolia-orphans.ts` answers the
  index-_truth_ question if the derived answer is ever doubted.

## Run log

| Date       | Env        | Action      | Result                                                                                                                                           |
| ---------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-07 | production | `audit.mjs` | 0 products, 1 vendor, 6 integrations stranded; 7 claims + 7 attestations in cascade. Reconciled 247/247, 0 unresolved reads. No write performed. |
| 2026-09-07 | production | `audit.mjs` | Re-run after the AECI-593 retraction: 0 products, 1 vendor, 4 integrations stranded; 4 claims + 4 attestations in cascade; 5 publicly reachable. `integrationSourceGone` is down to **2** (AECI-794, AECI-795), carrying 3 of those claims/attestations. Both Polycam ids gone. Still exits 1 — correctly, those two rulings are open. |
| 2026-09-08 | production | `audit.mjs` | Re-run after the AECI-794 retraction: **0 products, 0 vendors, 1 integration** stranded; 1 claim + 1 attestation in cascade; **1** publicly reachable. `integrationSourceGone` is down to **1**. `8f5365f9-…` is gone, and so are the Bluebeam vendor and both `built_by` strands — that whole lane closed between the two runs. Only **AECI-795** is left. Still exits 1, correctly. |
| 2026-09-08 | production | `audit.mjs` | **First run of the AECI-796 rewrite, and the first clean one: 0 in every bucket, 0 publicly reachable, 0 orphan children.** Reconciled 252/252, 0 unresolved reads, exit **0**. AECI-795 had moved to In Review nine minutes earlier, so the tail this lane opened on 2026-09-07 with 7 rows is drained. Also the first run to show the upstream fast path live: `fastPath: products {fromList: 252, viaGet: 38}, vendors {fromList: 167, viaGet: 26}` — ~64 fallback calls instead of ~300, about two minutes. Invoked exactly as CI does, with `--refresh-cache` and all three artifacts in a temp dir. |

## Follow-ups filed from this run

| Issue        | Row                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **AECI-794** | `procore-project-management → followup-crm` — reverse twin survives. **Ruled DELETE and executed 2026-09-08**, see `scripts/ops/2026-09-procore-followup-retraction/` |
| **AECI-795** | `microsoft-dynamics-365 → monday-com` — no twin, so a retraction removes the only copy of that mechanism. **Resolved 2026-09-08** (In Review as of 04:30 UTC); the 04:39 UTC sweep no longer lists the id. (It does **not** 404 the pair URL: a pair page with no edge returns 200 with a noindexed empty state.) |

Five of the seven rows were already covered: **AECI-685** (the vendor and both
`built_by` edges) and **AECI-593** (both Polycam edges). Both carry a comment recording
the confirmed 2026-09-07 state. **AECI-593 was executed that same day** — see
`scripts/ops/2026-09-polycam-retraction/` — leaving five stranded rows, all five still
publicly reachable (the vendor, the two undecided `integrationSourceGone` edges, and the
two `built_by` strands). **All five have since closed**, and the 2026-09-08 sweep is clean;
see the [Run log](#run-log).

## Related

- `docs/REVIEW_APP_PROMOTE_API.md` §5.1 — why promote has no delete semantics.
- `scripts/ops/2026-08-promote-strand-audit/` — **retired 2026-09-08**, README only. Its
  §Healing recipes are still the reference; read them before acting on anything found here.
- `.github/workflows/promote-strand-audit.yml` — the daily 09:00 UTC job that runs this
  lane. Its header carries the scheduling, no-heal and no-skip-green contract.
- `apps/api/src/lib/retract-product.ts` + `apps/api/scripts/retract-product.ts` — the
  product retraction tool. This sweep's cascade counts mirror its `buildFootprintSql`.
- `apps/datatool/README.md` — `POST /api/prune-integrations`, including the
  `acknowledgeGuards` override contract.
- `scripts/ops/2026-08-powered-by-backfill/` — the sibling MCP-based sweep this lane's
  client and flag conventions are copied from.
