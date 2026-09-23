# 2026-09 connector-attribution re-promote — the AECI-1064 tail

**Status: NOT RUN.** Manifest, preflight and dry run taken read-only against
`aeci-app-production` on 2026-09-23. The apply is the operator's, under an AECI-881 writer
slot. Issue: AECI-1064.

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
4. The products: every product at either end of the 39 edges. **36.**

A 14-product subset would carry every edge (`minimal_cover_record_ids`). The run uses all 36,
as the brief asked. Promoting both endpoints of an edge is harmless: the second push finds the
row already in `connector_evidenced_pairs` and updates it in place (§3.4a).

## Expected numbers

| Check | Before | After |
|---|---|---|
| The 39 ids in `integrations` | 39 | **0** |
| The 39 ids in `connector_evidenced_pairs` | 0 | **39** |
| `connector_product_id` matches the manifest's connector | n/a | **39 / 39** |
| Claims on the 39 edges | 63 on `integration_id` (35 edges carry claims) | **63** on `connector_evidenced_pair_id`, 0 left on `integration_id` |
| Promote jobs | n/a | **36** new `promote_jobs` rows, one per product |
| Collateral moves (edges outside the manifest) | n/a | **0** |
| New integrations created | n/a | **1**: `QuickBooks Online (Deltek-built)` (`recLOKlsKSqqRP2dN`), via Deltek Vantagepoint |
| Withheld by the owner gate | n/a | **10** (listed below) |
| Sent without their connector (`connectorsParked`) | n/a | **7** (Make, n8n, Boomi, Forma Construction Connect, Autodesk Platform Services) |
| Claimed rows skipped (§4b) | n/a | **0** |

### Withheld by the owner gate (AECI-1014)

These are not live, their far endpoint is promoted, and they have no owner, so the review app
withholds them. **They are curation work, not failures.** Eight are Convention A edges that
could not publish before because Zapier or Workato was their far endpoint.

| Record | Integration | Via product |
|---|---|---|
| `rec9j4pqSj5EsAU60` | Amazon Redshift → Zapier | Amazon Redshift |
| `recP6XKHjqqUlz1Vn` | Amazon Redshift → Workato | Amazon Redshift |
| `recVflfLU8FwplWK5` | CompanyCam ↔ Zapier | CompanyCam |
| `recDH7fyreT2duB29` | Deltek Vantagepoint ↔ Blackbox Connector | Deltek Vantagepoint |
| `recD0cM64HrOXK1mM` | Workday HCM → Deltek Vantagepoint | Deltek Vantagepoint |
| `recaz6LQUkGPhWQSU` | JobNimbus via Zapier | JobNimbus |
| `recv9hFbJOrh6d9Sg` | JobTread ↔ Zapier | JobTread |
| `recDiQLkjesEkWfor` | Oracle NetSuite ↔ Zapier (iPaaS connector) | Oracle NetSuite |
| `recu1XqfeDUoDSbvm` | Oracle NetSuite ↔ Workato (iPaaS connector) | Oracle NetSuite |
| `rec1S4PDtQIi1gZPb` | Smartsheet ↔ Zapier | Smartsheet |

No live integration on these products is sent with an owner warning. 48 live ones have an owner
ruled empty. **43 of those rulings cite AECI-700 as the reason** ("connector product is
parked/unpromoted"), and for the Zapier and Workato rows that reason is now false. They still
promote. Re-ruling them is curation follow-up, listed in `dry-run.json` → `no_owner`.

## Runbook

Needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `AECI_MCP_TOKEN`. Run from the repo
root.

The read-only steps, already run on 2026-09-23 (re-run all three if the apply is not the same
day, because a promote in between changes the set):

```
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs manifest
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs preflight
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs dry-run
```

The apply. Take the AECI-881 writer slot first:

```
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs apply --confirm-count 36
```

Then:

```
node scripts/ops/2026-09-connector-attribution-repromote/repromote.mjs verify
```

`verify` exits non-zero unless all 39 rows pass. It prints one line per edge, before → after.

### What `apply` checks

It promotes serially, smallest blast radius first (Amazon Redshift, 3 edges sent, through
Autodesk Forma, 47). It refuses to start when:

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
| `manifest.json` | the 36 product record ids, the 39 edge ids, the 7 exclusions |
| `preflight-rows.json` | the 39 `integrations` rows, their 63 claims, the two connector rows |
| `dry-run.json` | per-product prediction, the no-owner list, parked connectors |
| `promote-jobs.json` | written by `apply` |
| `verify-rows.json` | written by `verify` |
