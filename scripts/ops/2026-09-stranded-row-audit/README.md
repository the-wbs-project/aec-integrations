# AECI-767 — stranded row audit (upstream delete / reject)

Read-only sweep for **production D1 rows whose upstream curation record is gone or
rejected**. It answers the question AECI-595 could not be prioritised without: is the
stranded tail two rows or two hundred?

> **Status (2026-09-07): seven rows, all publicly reachable, all in search.**
> **Zero stranded products** — every one of the 247 live products is claimed upstream.
> The damage is confined to one vendor and six integration edges. This is a cleanup,
> not a trust problem. The sharper finding is that **five of the seven belong to issues
> already filed — and two of those sit under an issue marked Done** whose own
> verification step does not hold. See
> [Measurement](#measurement--2026-09-07-production).

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

### How this differs from the daily strand audit

`scripts/ops/2026-08-promote-strand-audit/` computes the same set difference as its
`stray` bucket, reading Airtable directly, and runs daily in CI. **This lane is not a
duplicate.** It adds the three things that audit deliberately does not do:

1. **Why the claim is gone** — DELETED upstream vs **REJECTED** upstream. A rejected
   record is invisible to every ordinary MCP read tool (`list_products` excludes them
   with no opt-in), so `find_product` with `include_rejected` is the only way to tell
   the two apart.
2. **The transitive damage** — a stranded product strands its integrations, which
   strand their claims and attestations.
3. **Public reachability and the retraction cascade**, per row.

**And since 2026-09-07 there is a fourth difference that supersedes the rest: the
review app no longer runs on Airtable.** It has its own D1 (`server/db/ids.ts` keeps
the `rec…` id *format*, which is why the ids still look Airtable-shaped —
`apps/api/src/db/schema.ts:1755-1776` says so explicitly). The daily audit reads
`api.airtable.com` directly, so it is not merely uncredentialed — **its data source is
decommissioned and it cannot be made to work again as written**. See
[The daily backstop has never run](#the-daily-backstop-has-never-run).

So this is the **replacement**, not the companion: it already speaks to the current
system. What it is not yet is a *cheap* daily check — see AECI-796 for that split.

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

Exits **0** when nothing is stranded, **1** when any bucket is non-empty, **2** on a
usage/credential error. Every run writes `report-<UTC>.json` **and**
`stranded-ids-<UTC>.txt` — the rollback-ready id list, grouped by class — next to the
script. Both are gitignored: they hold production catalog content. The dated
measurement that matters lives below.

Only `--env production` is meaningful, for the reason both sibling lanes give: the
review app holds **production** uuids in its `supabase*` fields — one curation base,
not one per tier.

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
that path. Ignore the sibling lane's instructions for minting an Airtable PAT.

### The upstream cache

The upstream phase costs ~300 `get_product` / `get_vendor` calls against a
**rate-limited** production curation DB, so its result is snapshotted to
`.upstream-cache.json` (gitignored) and reused. `--refresh-cache` re-reads it.

The cache is a convenience for iterating on the D1 half within one sitting — **not** a
substitute for a fresh read. Every published measurement must come from a run whose
cache is same-day.

### Three things that bite, all found the hard way on 2026-09-07

1. **The review app rate-limits.** Eight concurrent `get_product` calls returned
   `429 {"error":"rate_limited"}` partway through the first run and killed it with
   nothing written. `mcp-client.mjs` now retries 429/5xx with exponential backoff and
   honours `Retry-After`; concurrency defaults to **3** (`AECI_MCP_CONCURRENCY`
   overrides). The 2026-08 copy of that client has neither.
2. **A tool can fail server-side and return a bare string.** One `get_product`
   returned `Failed query: SELECT id FROM products WHERE …` as its text payload, which
   a blind `JSON.parse` reports as a meaningless `SyntaxError`. The client now names
   the tool and echoes the text; the sweep retries three times, then records the record
   in `unresolvedUpstream` and **refuses to report `clean`** while that list is
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
| `/vendors/bluebeam`                                              | `vendorNoLiveProducts`        | 0 products               | **AECI-685**, In Progress — redirect shipped, D1 delete still pending. |
| `/products/polycam/integrations/arcgis`                          | `integrationSourceGone`       | 1 claim, 1 attestation   | **AECI-593, marked Done — rows still live.**                           |
| `/products/polycam/integrations/autocad`                         | `integrationSourceGone`       | 2 claims, 2 attestations | **AECI-593, marked Done — rows still live.**                           |
| `/products/procore-project-management/integrations/followup-crm` | `integrationSourceGone`       | 2 claims, 2 attestations | **New** — AECI-794. Reverse twin survives.                             |
| `/products/microsoft-dynamics-365/integrations/monday-com`       | `integrationSourceGone`       | 1 claim, 1 attestation   | **New** — AECI-795. No twin.                                           |
| `/products/autodesk-revit/integrations/bluebeam-revu`            | `integrationEndpointStranded` | 1 claim, 1 attestation   | `built_by` → the dead Bluebeam vendor.                                 |
| `/products/bluebeam-revu/integrations/okta`                      | `integrationEndpointStranded` | 0                        | `built_by` → the dead Bluebeam vendor.                                 |

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
- **The two Polycam edges** (`74099c42-…`, `4dc9d4bb-…`) — these are AECI-593's rows,
  and **AECI-593 is marked Done** (closed 2026-08-13). Its own Verify step reads _"the
  strand audit returns `Integrations → stray: 0`"_, and that is still false today.
  What actually shipped under it was PR #510 — the datatool's named-guard
  acknowledgment and the daily audit workflow, i.e. the _tooling_ for the retraction —
  while the retraction itself was never performed. Upstream now holds only `Polycam ↔
SketchUp` and `Polycam ↔ Xactimate`, confirming both records are gone. The rows have
  been live and indexed for **four weeks**, not the four days the issue recorded.

### The daily backstop has never run

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

**And the secret is not the fix.** The review app has since moved off Airtable onto its
own D1, so `scripts/ops/2026-08-promote-strand-audit/audit.mjs` — which reads
`api.airtable.com/v0/appy81IdGJY6Fngf9` directly — points at a decommissioned system.
Minting a PAT would not revive it; there is nothing to authenticate against. The skip
branch was hiding an audit that had *also* gone obsolete underneath it, which is why
"just add the secret" was never done. Tracked as **AECI-796**, whose fix is to re-point
the daily check at the review app over `AECI_MCP_TOKEN` — the transport this lane
already uses and proves works.

That reframes what this sweep found. It is not that the detector works and the
follow-through fails — **the detector has never been switched on**, and the only two
things that have ever found a stranded row are a human noticing and this one-off run.
Worth weighing when AECI-595's priority is set: a retract _feature_ is worth less than a
retract _detector that actually runs_, and the cheapest fix on the table is a secret.

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
  resolve, and the likelier duplicate. Filed as **AECI-794**.
- **`2e6ad5bf-…` `microsoft-dynamics-365 → monday-com`** (`iPaaS`). **No twin.** The
  upstream `monday.com (ipaas)` record (`recgbcRYqUf2OvSZf`) carries a _different_
  uuid (`048952ee-…`), which is live in D1 on the unrelated `adp-workforce-now ↔
monday-com` pair. So this is not a duplicate of anything — it is an edge whose own
  record is gone, and retracting it **would** 404 `/products/microsoft-dynamics-365/
integrations/monday-com`. Needs a curation ruling.

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

- **This is not a CI cron.** `promote-strand-audit.yml` already watches the cheap set
  difference daily. This sweep costs a per-product `get_product` fan-out against a
  rate-limited curation DB; it is a measuring instrument, not a monitor. If it is ever
  wired up it needs a documented allowance, exactly as
  `2026-08-powered-by-backfill/README.md` warns about its own permanent floors.
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

## Follow-ups filed from this run

| Issue        | Row                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| **AECI-794** | `procore-project-management → followup-crm` — reverse twin survives, so a retraction does not 404 the pair URL |
| **AECI-795** | `microsoft-dynamics-365 → monday-com` — no twin; a retraction **does** 404 the pair URL, so it needs a ruling  |

Five of the seven rows were already covered: **AECI-685** (the vendor and both
`built_by` edges) and **AECI-593** (both Polycam edges). Both carry a comment recording
the confirmed 2026-09-07 state.

## Related

- `docs/REVIEW_APP_PROMOTE_API.md` §5.1 — why promote has no delete semantics.
- `scripts/ops/2026-08-promote-strand-audit/` — the daily set-difference audit and its
  §Healing recipes. Read its healing section before acting on anything found here.
- `apps/api/src/lib/retract-product.ts` + `apps/api/scripts/retract-product.ts` — the
  product retraction tool. This sweep's cascade counts mirror its `buildFootprintSql`.
- `apps/datatool/README.md` — `POST /api/prune-integrations`, including the
  `acknowledgeGuards` override contract.
- `scripts/ops/2026-08-powered-by-backfill/` — the sibling MCP-based sweep this lane's
  client and flag conventions are copied from.
