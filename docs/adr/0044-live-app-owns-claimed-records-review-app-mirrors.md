# ADR 0044: The live app owns claimed records, and the review app mirrors them

- Status: Accepted
- Date: 2026-10-22
- Issue: AECI-1413 (epic). Contract: AECI-1452. Producer and builder: AECI-1454. Drift check and
  production enable: AECI-1413 sub-issue 4. Receiver: the review repo's `REVIEW - Ownership
  receiver v2` issue.
- Rulings: Chris, 2026-10-22, on AECI-1413 (four, listed under Decision)
- Extends: ADR 0042 (record ownership and its 2026-10-20 amendment, the ownership record)
- Relates to: ADR 0021 (async promote), ADR 0030 (promote never infers a delete), ADR 0035
  (integrations are vendor-owned), `docs/REVIEW_APP_PROMOTE_API.md` §4a and §4d

## Context

ADR 0042 made ownership stored. Once a company is claimed (`vendors.owned_at` set), its vendor
row, its products and every integration touching them are edited only in the live app. Promote
refuses them.

So the review app's copy of a claimed company goes stale from the day of the claim. That copy
is still read. The review app, its MCP and the catalog agents use it to judge other products
and to plan new research. Two kinds of product are missing from it entirely: a product a
vendor created in the portal (AECI-1424 ruling, 2026-10-20) and a product a proposal accept
created (AECI-1417).

AECI-1418 already sends the review app each owned vendor's ownership record, ids and owners
only, through a queue, a consumer that reads D1 at delivery, and an idempotent `PUT` per
vendor (`REVIEW_APP_PROMOTE_API.md` §4d). The review receiver (AECI-1412) is live on
production.

## Decision

**The live app is the source of truth for every vendor-owned record. The review app holds a
read-only mirror of it.** The direction of flow follows ownership:

| Ownership state | Who edits | Flow |
|---|---|---|
| Unowned (`owned_at` null) | The review app's curators | Review → live, by promote. Unchanged. |
| Owned | The vendor in the portal, or an AECi admin in the live app | Live → review, by the mirror. Promote refuses the record (§4a). |
| Returned ("Return records to AECi") | The review app again | The last mirrored values are the review app's starting point. Promote writes it again. |

The rulings of 2026-10-22:

1. **Pointer message, record read at delivery.** The queue message stays
   `{ vendorId, reason, enqueuedAt }`. It never carries the record. `version` is the epoch
   milliseconds of the D1 read.
2. **Extend the existing `/vendors/{id}` record to `schemaVersion: 2`.** Same queue, consumer,
   ledger and secrets. No second pipeline.
3. **Drift reads the review app through one new batched read**, `GET {base}/vendors?ids=…`,
   at most 100 ids, answering each vendor's `version` and `recordHash`.
4. **Attestations ride inside each integration**, keyed by the natural key
   `{ dataObject, direction, source }`, because their ids are not stable.

### Pointer plus read

Every send is the vendor's whole current state, read when the consumer runs. A replay, a retry
or an out-of-order delivery all converge, because the receiver keeps the highest `version` and
replaces what it holds. A message enqueued before a later edit still sends the later edit. A
lost message is repaired by the next edit or by `ops:backfill-ownership-sync`. A message that
carried the record would need ordered, exactly-once delivery to stay correct, which Queues
does not give.

### What v2 carries

v2 adds `vendor` content, product `content` for each owned product, integration `content` and
`claims[]` for each owned integration, and `recordHash`. Field names are the promote wire names,
so the review app reverses its own promote mapping. Fields promote never carries are listed as
live-only, each with a reason, in `apps/api/src/lib/review-mirror-fields.ts`. That module is
the one map from live columns to wire fields, and its parity spec fails when a vendor-editable
field has no mirror decision. Derived and aggregate columns, timestamps and the review app's
own curation columns are left out. The contract is `packages/shared/src/api/review-app-ownership.ts`
and `REVIEW_APP_PROMOTE_API.md` §4d.

v1 told the receiver to ignore an id it never stored. v2 reverses that: the receiver creates a
read-only mirror row. That is how vendor-created and proposal-accepted products reach the
review side. A mirror write never starts a promote.

### Hash drift, not `updated_at`

The drift check, `review_mirror_drift`, compares a SHA-256 of each owned vendor's v2 content
with the hash the review app last stored. The issue text asked for a comparison of `updated_at`
with the record version. That was not used. `updated_at` moves on writes the mirror does not
carry, such as a `verified` flip by a license writer or a review-count recompute. Those would
read as drift and page every day. A content hash moves only when a mirrored field moves.

The hash is over canonical JSON: keys in UTF-16 code-unit order at every depth, set-like arrays
sorted by id or natural key, and `version`, `asOf` and `reason` excluded. Binary order, not the
`compareText` collator, because every sorted value is a key, an id or a slug, and a collator
would tie the hash to the runtime's ICU data.

### The `REVIEW_APP_MIRROR_SCHEMA` flag

The producer sends v2 only where the per-env wrangler var `REVIEW_APP_MIRROR_SCHEMA` is `"2"`.
It is `"1"` on every tier by default. The live receiver answers `400` to a shape it does not
parse, and the live app classifies `400` as permanent. So a v2 send before the review receiver
accepts v2 would drop every message silently. The flag lets the producer merge to `main` and
stay promotable, and production flips only after the receiver ships, followed by a backfill.
The new `vendor_edit` and `admin_edit` reasons are sent only under `"2"` for the same reason.

## Alternatives declined

- **Merge the two apps, so there is one copy.** Declined. The review app is a curation tool
  with its own store (ADR 0029), its own deploy and its own agents. The live app is the
  production site with its own authorization model. Merging them would put curation research
  inside the production trust boundary and couple two deploy cadences, to fix a staleness that
  a one-way mirror fixes.
- **Send the record in the queue message.** Declined by ruling 1, for the convergence reason
  above.
- **A second endpoint and queue for content.** Declined by ruling 2. The ownership record
  already reaches every owned vendor with versioning, retries and a ledger.
- **Let the review app write back through promote.** Declined. ADR 0042 makes the live app the
  only editor of an owned record. Two editors would need merge rules nobody has asked for.

## Consequences

- The review app's copy of an owned company is current within one queue delivery of each
  edit, and complete after the v2 backfill.
- Every live write path that changes a mirrored field must enqueue a sync. One hook in
  `afterVendorWrite` covers the vendor portal. Admin paths that bypass it call the dispatcher
  themselves (AECI-1454).
- A new vendor-editable field cannot ship without a mirror decision: the parity spec fails.
- The review receiver must accept both schema versions and must never promote from a mirror
  write.

## Revisit

When a second consumer needs the live content, or when the review app needs field-level
history rather than the latest state.
