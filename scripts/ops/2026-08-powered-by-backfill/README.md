# AECI-706 — `powered_by` FK backfill (promote-ordering gap)

Read-only sweep + guarded data-only backfill for prod `integrations` rows whose
`powered_by_product_id` is NULL even though the review app says the edge is powered by
a connector.

> **Status (2026-08-31): nothing to backfill.** The sweep found **0** rows in the
> `backfillable` bucket. Every prod edge whose connector is promoted already carries
> its FK. The residual gap is a _promotion-coverage_ problem, not a D1 data defect —
> see [What the sweep found](#what-the-sweep-found). The backfill script is committed
> because it is the cheap fix for a row that ever does drift FK-only.
>
> **Update (2026-09-01, AECI-730):** the promote-side root cause below is **fixed** —
> the silent drop is now reported and a re-push no longer clears a stored FK. And
> AECI-700 decided Zapier and Workato stay parked **permanently**, so the
> `connectorUnpromoted` bucket has a permanent non-zero floor rather than draining.

---

## The defect

The promote ingest resolves the FK through `resolveProduct` (`apps/api/src/routes/promote.ts`):

```ts
const poweredByProductId = intg.poweredByProduct
  ? await resolveProduct(intg.poweredByProduct)
  : null;
```

`resolveProduct` returns `null` when the referenced connector is not in D1 yet. Unlike
the **endpoint** path twenty lines above it — which pushes a `skipped[]` entry and
abandons the row — an unresolvable powered-by was dropped **silently**: no `skipped[]`,
no `staleSupabaseIds`, no metric. The integration is written anyway, just without its
connector.

§3.4 of `docs/REVIEW_APP_PROMOTE_API.md` constrained only the two _endpoints_ ("the
other endpoint must already be promoted"). It said nothing about the connector, and
that silence was the ordering gap.

**Fixed by AECI-730 (2026-09-01)**, which is why the snippet above is past tense. The
ingest now reports the drop on the promote response as `unresolvedLinks[]` and emits
`aeci.api.promote.unresolved_link{field:powered_by}`, and it omits the column from the
write rather than resolving it to `null` — so an update can no longer clear a correct
FK. What that does **not** do is create the missing connector: the bucket below is
still the population, it is simply no longer invisible until this sweep runs.

This matters because the FK is the **routing key** for the powered-edge migration: an
edge with a NULL `powered_by` cannot be migrated to "via {connector}".

## Why this is not a one-line `UPDATE … WHERE powered_by_product_id IS NULL`

A NULL FK is not the only way prod can be behind upstream. The AECI-671
connector-normalisation sweep (2026-08-27) also re-typed `mechanism_kind`
native→iPaaS, **swapped source/target on Kroo's rows**, and regenerated names; AECI-698
re-typed the Agave rows. A row stale on orientation _as well as_ on the FK would get a
correct routing key written onto a **backwards edge** — worse than the NULL it
replaces, and invisible afterwards.

So the sweep classifies on full-row congruence over the fields promote owns, and only
`backfillable` is safe to write. `backfill.sh` refuses to run while any `divergent` or
`mismatch` rows exist.

## Buckets

| Bucket                | Meaning                                                                                                         | Disposition                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `backfillable`        | upstream FK set; edge in prod; connector in prod; prod FK NULL; every other promote-owned field already matches | safe to `UPDATE` — this is `backfill.sh`'s cohort |
| `divergent`           | as above, but name / `mechanism_kind` / `direction` / endpoints also differ                                     | re-promote the endpoint product; never poke       |
| `connectorUnpromoted` | upstream FK set, edge in prod, connector **not** promoted                                                       | never reaches zero — see below (AECI-700)         |
| `edgeUnpromoted`      | upstream powered edge has no prod row at all                                                                    | needs a promote, not a backfill                   |
| `mismatch`            | prod FK set but points somewhere other than upstream                                                            | investigate by hand                               |

## What the sweep found

Measured **2026-08-31T03:14Z** against `aeci-app-production`:

|                            | count   |
| -------------------------- | ------- |
| upstream integrations      | 2,425   |
| upstream **powered** edges | **325** |
| prod integrations          | 946     |
| prod edges with the FK set | 79      |

| bucket                | count |
| --------------------- | ----- |
| `backfillable`        | **0** |
| `divergent`           | 0     |
| `mismatch`            | 0     |
| `connectorUnpromoted` | 62    |
| `edgeUnpromoted`      | 184   |

`79 + 62 + 184 = 325` — every upstream powered edge is accounted for, so the residual
gap is fully explained by promotion coverage and nothing is silently unclassified.

**`connectorUnpromoted` (62)** — the edge is live on the site but its connector is not
a promoted product, so there is no FK target to point at. Exactly the set the issue
predicted: Zapier 24, Workato 15, Blackbox Connector 4, Trimble AppXchange 4, Finch
Employment API 3, Autodesk Platform Services 3, Forma Construction Connect 2, n8n 2,
and one each for Box/SyncEzy, Boomi, SharePoint/SyncEzy, Make, ADP/Flexspring.
**Not resolvable by this script, and — for most of it — not resolvable at all.**
AECI-700 parks **Zapier and Workato permanently**: neither will ever be promoted, so
their 39 edges (63% of this bucket) are a permanent floor, and the ceiling grows as
more endpoint products are promoted. Treat a non-zero `connectorUnpromoted` as the
expected state, not as a queue.

**`edgeUnpromoted` (184)** — the upstream edge has never been promoted at all: Zapier
86, Workato 29, Make 19, Kroo Connector 15, Aquifer 12, MindCloud 6, Finch 5, Blackbox
3, Boomi 2, n8n 2, and one each for Speckle, Celigo, Tray.io, Morpheus, Forma.

Two corrections to the issue text, both confirmed by this run:

- The named **Agave gap is closed** — all 12 upstream Agave powered edges carry their
  FK in prod. `docs/STAGE_1_5_SPEC.md` §12.6's "5 of 421" is a 2026-08 snapshot that
  the AECI-671/698 promotes have since overtaken.
- Upstream powered edges are **325**, not 326 — one edge changed between the issue
  being written and this measurement.

## The two scripts

### `audit.mjs` — the sweep (read-only)

Strictly read-only: SELECTs against D1, read-only MCP tools against the review app.
There is no `--apply`.

```bash
node scripts/ops/2026-08-powered-by-backfill/audit.mjs --env production
node scripts/ops/2026-08-powered-by-backfill/audit.mjs --env production --json --out /tmp/r.json
```

Exits `0` when every bucket is empty, `1` when any is non-empty, `2` on a
usage/credential error. Always writes a timestamped report (gitignored).

Only `--env production` is meaningful, for the same reason the strand audit says so:
the review app holds **production** uuids in its `supabase*` fields — one curation
base, not one per tier.

### `backfill.sh` — the write

```bash
node scripts/ops/2026-08-powered-by-backfill/audit.mjs --env production --json --out /tmp/r.json
scripts/ops/2026-08-powered-by-backfill/backfill.sh --env production --report /tmp/r.json
scripts/ops/2026-08-powered-by-backfill/backfill.sh --env production --report /tmp/r.json --apply --allow-production
```

The cohort is **never defined in this script** — it is parsed out of a fresh
`audit.mjs --json` report, so the projection, the write and the rollback cannot drift
from the detector. It refuses to run when the report was measured against a different
tier, is older than 60 minutes, or contains any `divergent`/`mismatch` row.

Backups (a full `integrations` dump) plus the generated `backfill.sql` and its
`rollback.sql` are written to `backups/<UTC-stamp>-<env>/` on **every** run, including
dry-run, so the exact bytes that would be applied can be reviewed first.

`--rollback` is a genuine inverse, not a best effort: every UPDATE carries
`AND powered_by_product_id IS NULL`, so the script can only ever have set rows that
were NULL beforehand.

## ADR 0022 and the choice of transport

`integrations` is catalog — **domain state** — so §26.1 requires the `audit_log` row in
the same atomic unit as the mutation. A Node/bash CLI has no `db.batch()`, so the
question is what a multi-statement wrangler call actually guarantees.

Measured on a real remote D1 (staging, 2026-08-31): an `UPDATE` paired with a
deliberately failing second statement, for **both** a prepare-time error (unknown
column) and a **runtime** error (CHECK violation). `--command` and `--file` **both**
rolled the UPDATE back. So `--command` is atomic today; the D1 `/query` endpoint wraps
a multi-statement body.

The write still goes through a generated file applied with `--file`, for two reasons:

1. **Only `--file` states the guarantee as a contract.** It routes through D1's import
   pipeline, which announces _"if the execution fails to complete, your DB will return
   to its original state and you can safely retry."_ `--command`'s rollback is observed
   behaviour of an endpoint that does not promise it, and an ADR-0022 invariant should
   not rest on that.
2. **The cohort is unbounded.** A few hundred UPDATE+INSERT pairs is a multi-megabyte
   argv; a file has no such limit, and it is reviewable and archivable.

Audit rows are **per-row** `integration.updated` with `actor_type: 'system'`, matching
what the promote ingest writes for the same mutation. ADR 0022's one-summary-row form
is the _scheduled-delete_ exception and does not apply here.

`updated_at` is deliberately **not** touched: it tracks last-promote recency, and the
`audit_log` row is the record of this change. Bumping it would fake a promote.

## Credentials

| Variable                | Used for                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | `wrangler d1 execute --remote`. Account → D1 → **Read** for the sweep, **Edit** for the backfill. |
| `CLOUDFLARE_ACCOUNT_ID` | ditto                                                                                             |
| `AECI_MCP_TOKEN`        | the review-app MCP (`.mcp.json`, injected from the Conductor keychain)                            |

The sibling strand audit reads Airtable directly and needs `AIRTABLE_TOKEN`. This sweep
deliberately does **not**: `AECI_MCP_TOKEN` is already in the workspace, and the MCP
server exposes the two reads this needs already joined (`list_integrations` →
`supabaseId` + `poweredByProduct.id`; `get_product` → the connector's `supabaseId`).
`mcp-client.mjs` enforces a read-only tool allow-list, because the same server also
exposes `promote_product` and the `create_*`/`update_*` family.

## Run log

| Date       | Env        | Action          | Result                                                                                                                                               |
| ---------- | ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-31 | production | `audit.mjs`     | 325 upstream powered; **backfillable 0**, divergent 0, mismatch 0, connectorUnpromoted 62, edgeUnpromoted 184. No write performed.                   |
| 2026-08-31 | staging    | transport probe | Confirmed `--file` **and** `--command` both roll back a failed multi-statement write. Probe row and audit row reverted; staging left byte-identical. |

## Follow-ups this work does not do

- **The root cause is fixed — [AECI-730](https://linear.app/aec-integrations/issue/AECI-730)
  (2026-09-01).** `promote.ts` no longer drops an unresolvable `poweredByProduct`
  silently: it reports it on the response as `unresolvedLinks[]` and in Datadog as
  `aeci.api.promote.unresolved_link{field:powered_by}` (`info`, not `warn` — see below),
  and it no longer _clears_ a stored FK on update, because the column is now omitted
  from the write instead of being resolved to `null`. `builtByVendor` got the same
  guard. So this bucket is now visible at promote time, not only in this sweep.
- **Promotion coverage closes only part of the remaining 246 edges.** Promoting a
  connector and then re-promoting the endpoint products does land their edges — but
  **Zapier and Workato are excluded by decision (AECI-700) and will never be promoted**,
  so 39 of the 62 `connectorUnpromoted` and 115 of the 184 `edgeUnpromoted` can never be
  closed that way. `audit.mjs` will keep exiting `1` permanently, by design.
- **The cron caveat is now the operative one, not a hypothetical.** If this sweep is
  wired alongside `promote-strand-audit.yml` it **must** carry a `connectorUnpromoted` /
  `edgeUnpromoted` allowance — those buckets have a permanent non-zero floor, so without
  one it is red every day for a reason no operator can act on.
