# 2026-09 connector-attribution re-promote — the AECI-1064 tail

**Status: RUN — complete.** 14 serialized re-promotes applied to `aeci-app-production` on
2026-09-23, 09:17Z–09:28Z, by the operator. Verified 2026-09-24 00:36Z: 39 / 39 clean. Issue:
AECI-1064. See [The run](#the-run-2026-09-23).

## What is wrong

Zapier (`4e0e4400-2ad3-43e6-a4cb-0c3392473259`) and Workato
(`6023cc70-a234-4dca-ab66-6aed72d2b798`) went live on 2026-09-23 as `product_role: connector`,
reversing the AECI-700 park. **39 live `integrations` rows** (Zapier 23, Workato 16) still carry
`powered_by_product_id = NULL`. They were promoted while both connectors were parked, so promote
could not resolve the connector and wrote the row without it (AECI-1032).

Promoting the connectors repaired none of them, by design:

> promoting the connector alone does not repair edges already in the database, because promote
> is product-driven and those edges belong to their endpoints' bundles
> — `docs/REVIEW_APP_PROMOTE_API.md` §3.4

The repair is a re-promote of each edge's endpoints. The edge is re-sent with a connector that
now resolves, and §3.4a moves it: the row is inserted into `connector_evidenced_pairs` under its
existing id, its claims are re-homed with it, and the `integrations` row is dropped.

## The set

`manifest.json`, derived read-only:

1. Upstream, via the `aeci-review` MCP: every integration whose `powered_by` is Zapier or
   Workato and which stores a production id. Zapier 115 upstream / 28 with an id; Workato 49 / 18.
2. Production: those 46 ids matched to `integrations` rows with `powered_by_product_id IS NULL
   AND retired_at IS NULL`. **39 match.**
3. The other **7 are excluded**. Each is self-referential (Convention A: the connector is one of
   the edge's own endpoints, e.g. `Connecteam → Zapier`), and §3.4a keeps those in
   `integrations` by design. None is in `connector_evidenced_pairs`, retired, or missing.
4. The products. The 39 edges have **36** distinct endpoints (`all_endpoint_record_ids`).
   Promoting either end of an edge carries it (§3.4), so the run promotes a greedy cover of
   the edges instead: **14 products** that between them carry all 39. The manifest refuses to
   write if the cover misses an edge. Operator ruling 2026-09-23 on AECI-1064.

7 of the 39 edges have both endpoints in the cover, so they are sent twice. That is harmless:
the second push finds the row already in `connector_evidenced_pairs` and updates it in place
(§3.4a). `manifest` prints which product carries each edge.

| Product | Record | Manifest edges |
|---|---|---|
| Autodesk Forma | `rec2KtJeJUzqih3ad` | 9 |
| Box | `recCOE9Ju0ZRoW8ss` | 2 |
| busybusy | `recDzKmObXRE6uHpm` | 1 |
| Deltek Vantagepoint | `recvm3gJmUFLMzVIL` | 3 |
| Egnyte | `recdO5uJDgWBpNVmD` | 2 |
| Google Calendar | `recEuQ8n9wSqaoEBL` | 2 |
| HOVER | `recE1QYJGBueJQvaL` | 4 |
| Jobber | `recBec7hSiuPp0YY2` | 3 |
| Motion | `recohQSEjZl4EP4zL` | 2 |
| Procore | `rec944YjKNRfRCgAf` | 3 |
| Roofr | `recRd7g8zjLcaz3yd` | 9 |
| Smartsheet | `recvTtJLtPerJyKVB` | 2 |
| SumoQuote | `rec6UUp8iEaL1vUpk` | 2 |
| Xero | `recoiDWUn1VK93IdS` | 2 |

## Expected numbers

| Check | Before | After |
|---|---|---|
| The 39 ids in `integrations` | 39 | **0** |
| The 39 ids in `connector_evidenced_pairs` | 0 | **39** |
| `connector_product_id` matches the manifest's connector | n/a | **39 / 39** |
| Claims on the 39 edges | 63 on `integration_id` (35 edges carry claims) | **63** on `connector_evidenced_pair_id`, 0 left on `integration_id` |
| Promote jobs | n/a | **14** new `promote_jobs` rows, one per product |
| Collateral moves (edges outside the manifest) | n/a | **0** |
| New integrations created | n/a | **1**: `QuickBooks Online (Deltek-built)` (`recLOKlsKSqqRP2dN`), via Deltek Vantagepoint |
| Withheld by the owner gate | n/a | **3** (listed below) |
| Sent without their connector (`connectorsParked`) | n/a | **2**: CMiC ↔ Autodesk Forma (Boomi), Smartsheet ↔ Autodesk Build (Forma Construction Connect) |
| Claimed rows skipped (§4b) | n/a | **0** |

### Withheld by the owner gate (AECI-1014)

These are not live, their far endpoint is promoted, and they have no owner, so the review app
withholds them. **They are curation work, not failures.**

| Record | Integration | Via product |
|---|---|---|
| `recDH7fyreT2duB29` | Deltek Vantagepoint ↔ Blackbox Connector | Deltek Vantagepoint |
| `recD0cM64HrOXK1mM` | Workday HCM → Deltek Vantagepoint | Deltek Vantagepoint |
| `rec1S4PDtQIi1gZPb` | Smartsheet ↔ Zapier | Smartsheet |

The 36-product dry run found 7 more on products this run no longer promotes (Amazon Redshift,
CompanyCam, JobNimbus, JobTread, Oracle NetSuite). They are unaffected here and tracked on
AECI-1098 with the rest.

No live integration on these products is sent with an owner warning. 41 live ones have an owner
ruled empty. **40 of those rulings cite AECI-700 as the reason** ("connector product is
parked/unpromoted"), and for the Zapier and Workato rows that reason is now false. They still
promote. Re-ruling them is curation follow-up (AECI-1098), listed in `dry-run.json` →
`no_owner`.

## The run (2026-09-23)

The operator ran `apply --confirm-count 14` from 09:17Z to 09:28Z. Every job returned
`status: ok`, `operation: updated`, and an empty `skipped[]`, `warnings` and
`unresolvedLinks`. No connector was published as a side effect. Each job id is the one new
`promote_jobs` row for its product, minted after the call started, so none is an AECI-1095
replay.

| # | Product | Job id | Ledger `created_at` | Manifest edges moved | `skipped[]` | Parked |
|---|---|---|---|---|---|---|
| 1 | Motion | `recohQSEjZl4EP4zL-mudw35gp-df2db566` | 09:17:25Z | 2 | 0 | 0 |
| 2 | SumoQuote | `rec6UUp8iEaL1vUpk-mudw46s3-89ad3b95` | 09:18:14Z | 2 | 0 | 0 |
| 3 | Jobber | `recBec7hSiuPp0YY2-mudw4w59-fa98d57b` | 09:18:50Z | 3 | 0 | 0 |
| 4 | Xero | `recoiDWUn1VK93IdS-mudw5m5l-3946eea8` | 09:19:23Z | 2 | 0 | 0 |
| 5 | Roofr | `recRd7g8zjLcaz3yd-mudw6bv3-2ab3756c` | 09:19:58Z | 9 | 0 | 0 |
| 6 | HOVER | `recE1QYJGBueJQvaL-mudw74e2-de195854` | 09:20:33Z | 4 | 0 | 0 |
| 7 | Google Calendar | `recEuQ8n9wSqaoEBL-mudw7uk2-0438f899` | 09:21:08Z | 2 | 0 | 0 |
| 8 | busybusy | `recDzKmObXRE6uHpm-mudw8p61-ccf50ae5` | 09:21:46Z | 1 | 0 | 0 |
| 9 | Box | `recCOE9Ju0ZRoW8ss-mudw9lpp-40b54967` | 09:22:33Z | 2 | 0 | 0 |
| 10 | Deltek Vantagepoint | `recvm3gJmUFLMzVIL-mudwaj35-9277f7d2` | 09:23:18Z | 3 | 0 | 0 |
| 11 | Egnyte | `recdO5uJDgWBpNVmD-mudwbi6t-ec5b7412` | 09:24:03Z | 2 | 0 | 0 |
| 12 | Smartsheet | `recvTtJLtPerJyKVB-mudwcfqq-38b110d8` | 09:24:47Z | 2 | 0 | 1 |
| 13 | Procore | `rec944YjKNRfRCgAf-mudwdh0p-f826d76b` | 09:25:50Z | 3 | 0 | 0 |
| 14 | Autodesk Forma | `rec2KtJeJUzqih3ad-mudwg9av-55441d73` | 09:28:06Z | 9 | 0 | 1 |

"Manifest edges moved" counts the manifest edges on that product found in
`connector_evidenced_pairs` after its promote. An edge carried by two products counts under both.

### Writer slot

The run was inside its AECI-881 claim. The claim for these 14 promotes was posted at
09:15:36Z. The first job was minted at 09:17:25Z and the last at 09:28:06Z. The production
`promote_jobs` ledger confirms both times (read 2026-09-24).

At 13:52Z the claim was withdrawn with "apply not run; will re-claim". That note was wrong. The
apply had already finished four and a half hours earlier. The `yangon-v2` Pivvot claim opened
at 13:53Z, after the run, so the two did not overlap. A reply on the claim records the
correction.

An earlier draft of this section said the apply ran after the withdrawal and alongside
`yangon-v2`. The ledger timestamps rule that out.

### Withheld at kick-off

The `withheld` lists in `promote-jobs.json` are long (0 to 78 per product, 358 in all). 352 are
the ordinary product-driven rule: the far endpoint is not promoted, so neither the edge nor its
claims are sent. The other 6 are the owner gate (AECI-1014), exactly the 3 edges the dry run
predicted, each with its claims:

- Deltek Vantagepoint ↔ Blackbox Connector (and 1 claim)
- Workday HCM → Deltek Vantagepoint (and 2 claims)
- Smartsheet ↔ Zapier

`connectorsParked` held the 2 predicted rows: Smartsheet ↔ Autodesk Build (Forma Construction
Connect) and CMiC ↔ Autodesk Forma (Boomi). Both say "connector awaits review".

The one predicted create landed. QuickBooks Online (Deltek-built) is live as `integrations` row
`94ab0374-74cf-4107-803d-f5fb53825f1e`, created 09:23:18Z by the Deltek Vantagepoint job, with
its owner set.

### Verification (2026-09-24 00:36Z, prod)

| Check | Result |
|---|---|
| The 39 ids in `connector_evidenced_pairs` | **39** |
| The 39 ids still in `integrations` | **0** |
| Wrong `connector_product_id` | **0** |
| Claims on the pair rows | **63** of 63; 0 left on `integration_id` |
| Job ids recorded / found in the prod ledger | **14 / 14** |
| Rows passing every check | **39 / 39** |

Two field changes show in the diff, and both are expected:

- **`direction` flipped on 6 edges.** Each is a pair whose canonical A (`product_a_id`, the
  lower id) is the original target, so `a_to_b` became `b_to_a` or back. That is the §3.4a
  re-anchor. The flow is unchanged: 09b38f3a, 0ec2b8bf, a59122dc, a77916a4, bb34ac33, f9f77dc3.
- **`created_at` is reset on all 39** to the time of the move. The move branch
  (`apps/api/src/routes/promote.ts`, the `existing?.table === 'integrations'` case) inserts the
  pair row without the source row's `created_at`, so each edge's original creation date is lost.
  The preflight snapshot keeps the originals. This is a promote defect, not a run defect, and it
  is filed as AECI-1113.

## Runbook

Needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `AECI_MCP_TOKEN`. Run from the repo
root.

The read-only steps. They ran on 2026-09-23 before the apply. Re-running them now derives an
empty set, because the 39 edges have moved:

```
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs manifest
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs preflight
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs dry-run
```

The apply. Take the AECI-881 writer slot first, and release it only after `verify`:

```
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs apply --confirm-count 14
```

Then:

```
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs verify
```

`verify` exits non-zero unless all 39 rows pass. It prints one line per edge, before → after.

### What `apply` checks

It promotes serially, smallest blast radius first, counting every edge the product sends:
Motion (4), SumoQuote (5), Jobber (9), Xero (11), Roofr (12), HOVER (13), Google Calendar (14),
busybusy (15), Box (17), Deltek Vantagepoint (19), Egnyte (20), Smartsheet (22), Procore (39),
Autodesk Forma (47). It refuses to start when:

- `--confirm-count` is not the number of products still to promote;
- either connector row is missing from production, or its `product_role` is not `connector`;
- the dry run reported a blocker.

It stops at the first product where:

- `get_promote_status(record_id)` is not `idle` before the call. A pending marker means
  `promote_product` would re-collect the old job and send nothing (AECI-1095);
- the production `promote_jobs` ledger does not gain **exactly one new job id** for the product,
  minted after the call started. `promote_product` returns no job id when it finishes inline,
  so the ledger is the only reliable read. A replay adds no row, which is how AECI-1095 was
  seen: one ledger row where there should have been two;
- the result is not `status: ok`, carries `replayed`, or published a connector as a side
  effect. `partial` leaves the pending marker, so it stops the run too;
- any manifest edge on the product is still in `integrations` afterwards, unless `skipped[]`
  names it.

Each product's job id, `skipped[]`, `withheld`, `warnings`, `unresolvedLinks` and
`connectorsParked` land in `promote-jobs.json` as it completes. A stopped run is resumed by
re-running `apply`; completed products are skipped, and `--confirm-count` must equal what is
left.

The MCP client's write door never retries. A retried `promote_product` is the AECI-1095 shape.

## Files

| File | What |
|---|---|
| `repromote.mjs` | the lane: `manifest`, `preflight`, `dry-run`, `apply`, `verify` |
| `mcp-client.mjs` | two-door MCP client; the write door allows only `promote_product` |
| `manifest.json` | the 14 product record ids, the 39 edge ids, the 7 exclusions, all 36 endpoints for reference |
| `preflight-rows.json` | the 39 `integrations` rows, their 63 claims, the two connector rows |
| `dry-run.json` | per-product prediction, the no-owner list, parked connectors |
| `promote-jobs.json` | the 14 job ids, results and per-product move counts, from `apply` |
| `verify-rows.json` | the 39 rows and 63 claims after the run, per-edge diff, from `verify` |
