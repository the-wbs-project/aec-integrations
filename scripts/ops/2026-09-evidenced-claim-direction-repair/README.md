# AECI-996: re-anchor claims on reversed connector-evidenced pairs

A one-time, idempotent repair. It flips claim directions and vendor attestation slots on
connector-evidenced pairs whose stored A/B order is the reverse of the integration's
source and target.

> **Status: written, NOT run in any environment.** The dry run writes nothing. `--apply`
> writes, and production also needs `--allow-production`. Record every run in the Run log
> below.

---

## The defect

`connector_evidenced_pairs` stores the lower product id as `product_a_id`. A claim's
`direction` and its attestations' `vendor_a` / `vendor_b` slots are read against that A/B
(`DATABASE_SCHEMA.md` §9a.6). Before the AECI-996 fix, promote copied both from the
payload's source → target unchanged. So when the source's id sorted second:

- every one-way claim pointed backwards, and the product page's Direction column showed
  the wrong arrow; and
- every vendor slot named the other endpoint's vendor.

The issue measured 31 of 45 one-way claims on reversed pairs. The dry run re-counts that
against the live database. It does not trust the issue's number.

## Where the source end comes from

**Never from the pair row.** The pair row is the thing that lost the fact. Per the
operator ruling, the script asks two sources:

1. **The review app's integration record.** It matches on `supabaseId` and resolves
   `sourceProduct` to a product uuid.
2. **The creation audit row** (`integration.created` or `connector_evidenced_pair.created`
   for the pair id), when its state names a source product.

Outcomes:

| Case | What the script does |
|---|---|
| Source is `product_a_id` | Not reversed. Nothing to do |
| Source is `product_b_id` | Reversed. Repaired |
| Both sources answer and disagree | `conflicts`. Skipped |
| Neither source answers | `unresolved`. Skipped |
| The record's endpoints are not the pair's | `endpointsDiffer`. Skipped |

**Expect the audit row to answer rarely.** Promote writes `integration.created` and
`connector_evidenced_pair.created` with no before or after state. In practice the review
app record decides, and a pair with no upstream record lands in `unresolved`.

## What a repair writes

The flip is `planClaimReframe` in `apps/api/src/lib/claim-frame.ts`. Promote runs the same
planner on its cross-table moves, and the script imports that file directly through Node
type stripping.

- A one-way claim flips `a_to_b` ↔ `b_to_a`. `both` is left alone.
- A `vendor_a` attestation becomes `vendor_b`, and the reverse, including retracted ones.
  `aeci` is left alone.
- **On a collision, contents swap in place.** A data object with both one-way claims
  would break `claims_identity_key`, and a claim with both live vendor slots would break
  `attestations_slot_key`. The rows keep their direction or slot and trade everything
  else instead. The end state is identical, and every row keeps its id.

Each write is paired with an `audit_log` row (`claim.reframed` or `attestation.reframed`,
actor `system`). Its metadata carries `source: ops-repair-aeci-996`, the run id, the pair
id, the op key and which source decided the frame. Everything goes in one file applied
with `wrangler d1 execute --file`, which D1 imports all or nothing.

## Idempotency

- **Reframe audit rows.** A pair whose claims or attestations hold any `claim.reframed` or
  `attestation.reframed` audit row is skipped whole. That covers this script's own rows and
  a promote move after the deploy, which re-anchors the pair itself. The deploy timestamp
  alone would miss the second case: on a `both` claim a move rewrites only the vendor
  slots, so the claim's `updated_at` does not change. Every generated statement is also
  guarded on its own op key.
- **The deploy timestamp.** A claim updated after it was written by the fixed code. It is
  already right, so the script skips it. The default is the commit time of the fix on
  `origin/main`. That is never later than any environment's deploy, so a wrong guess skips
  a claim rather than flipping a correct one back. Override with `--deployed-at`.
- **A pre-deploy claim whose flip would land on a post-deploy claim** is `blocked` and
  left alone. The two rows say the same thing, and choosing one is a curation call.

Skipped and blocked claims are listed by pair. An AECi-origin one heals on the pair's
next promote, because the fixed ingest matches in the pair's frame.

## Run it

Needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `AECI_MCP_TOKEN`. Run it only
after the environment is serving the fix.

```
node scripts/ops/2026-09-evidenced-claim-direction-repair/repair.mjs --env production
node scripts/ops/2026-09-evidenced-claim-direction-repair/repair.mjs --env production --apply --allow-production
```

The dry run writes `snapshot.json`, `report.json`, `repair.sql` and `rollback.sql` under
`backups/<stamp>-<env>/` (gitignored). `rollback.sql` is the planner run on its own
output, since the flip is its own inverse. It is written, never applied.

Re-run the dry run after an apply. Every repaired pair should list under
`already repaired`.

## Run log

| Date | Env | Pairs | Ops | Collisions | Notes |
|---|---|---|---|---|---|
| | | | | | |
