# ADR 0042: Record ownership is stored, and only an admin returns it

- Status: Accepted
- Date: 2026-10-19
- Issue: AECI-1415 (E6b.3, epic AECI-1341). Ruled on AECI-1341.
- Follow-ups: AECI-1416 (a new product under an owned vendor becomes a proposal), AECI-1417 (the owner accepts or declines it), AECI-1418 (the ownership message to the review app, landed 2026-10-20), AECI-1424 (vendor product create, landed 2026-10-22). Not built: AECI-1413 (the mirror of vendor edits to the review app), AECI-1412 (the review-app receiver, review repo)
- Amends: ADR 0035 (promote refusal and the last-seat hand-back), ADR 0039 (the vendor-held test)
- Relates to: ADR 0021 (async promote), `docs/REVIEW_APP_PROMOTE_API.md` §4a to §4c, `docs/STAGE_2_ATTESTATIONS_SPEC.md` §13.9

## Context

Until now a vendor was "claimed" only while it had an unbanned `vendor_admin` seat (AECI-520, `loadClaimedVendorIds`). Promote refused to write a claimed vendor and its products. Everything else followed from that test.

Two problems came from deriving ownership from seats.

- **Seat loss gave records to promote.** A ban made the vendor writable again. AECI-989 then made the last-seat revoke hand the record back, and AECI-1106 did the same for account erasure. A vendor that lost a seat for any reason could see the review app overwrite its text on the next push.
- **The test covered the vendor and its products only.** An integration was fenced per row by its own claim (ADR 0035). An edge whose far endpoint was a claimed vendor's product still wrote, because owning a product did not make a vendor the owner of every integration touching it.

Chris ruled on 2026-10-19 (AECI-1341) that every record has one owner, AECi or the vendor, and that the owner does not change by accident.

## Decision

1. **Ownership is stored.** `vendors.owned_at` (nullable ISO text) is non-null while the vendor owns its record, every product joined to it and the integrations it owns. `loadOwnedVendorIds` in `apps/api/src/lib/claimed-vendors.ts` is the one test.
2. **It flips to the vendor at claim approval and at the admin seat provision.** A guarded `owned_at IS NULL` update runs in the grant's own batch, with `updated_at` kept. The grant's audit row carries `metadata.ownership_stamped: true`. A seat without `owned_at` owns nothing.
3. **Seat loss and license lapse never move it.** A revoke, a ban and an account erasure end the edit right only. The records stay vendor-owned and frozen: `owned_at`, `maintained_by` and `claimed_at` all stay. The last-seat revoke and the erasure run the seat lapse, as a last-seat ban always did. Open owner contests move to AECi stamped with `owner_seat_lapsed_at`, so a later seat grant gets them back. Nothing is purged.
4. **One audited admin action returns ownership.** "Return records to AECi" is `POST /api/admin/vendors/:id/return-to-aeci`, admin only. It exists for a mistaken approval and nothing else. It is refused with `VENDOR_HAS_SEATS` while the vendor holds any `vendor_admin` seat, banned or not, because an unban would otherwise re-seat an AECi record. It is refused with `VENDOR_NOT_OWNED` when `owned_at` is already NULL. One batch clears `owned_at`, revokes live seat invites, runs `planVendorHandback` (markers to `'aeci'`, live claimed integrations and evidenced pairs un-claimed, open owner contests to AECi unstamped) and writes a `vendor.records_returned` audit row.
5. **Promote sends nothing about an owned record and refuses it.** It refuses the vendor, every product joined to an owned vendor (a co-owned product is owned if any joined vendor is owned), and every integration whose source or target product is owned, whichever product the payload is about. That includes the stored endpoints of an edge an update would move away from an owned product. An edge where the owned product is only the `poweredByProduct` connector still writes. A new product that would join an owned vendor is not created. Until AECI-1416 it was skipped. Since AECI-1416 it is stored as a proposal to the owner (amendment below). An unowned company is untouched. Each refusal is a `skipped[]` entry with its own reason constant and a `promote.blocked` audit row.
6. **A commit-time sentinel guards the race.** The promote batch carries statements, after the `promote_jobs` ledger row, that abort it if a vendor the plan treated as unowned and writes, or any written edge endpoint product, became owned before commit. The job ends `errored` with `VENDOR_OWNED_DURING_PROMOTE` (409) and nothing is written. A re-push under a new `jobId` skips those rows.
7. **Edit rights stay seat-based.** `requireVendor()`, notification recipients and contest routing read `profiles`, not `owned_at`. Ownership says who may write the record. A seat says who may act for the vendor.
8. **The AECi field override reads ownership.** The vendor-held test in `routes/admin-field-overrides.ts` now uses `owned_at`, so a frozen seatless owned record can still be corrected by AECi (ADR 0039).
9. **Three things deliberately do not change.** The `last_reviewed_at` fence (§3.6a) keys on `maintained_by`, which the freeze keeps. The connector-catalog vendor-managed refusal (AECI-720) keys on `connector_catalogs.managed_by`. The per-row integration claim fence (ADR 0035, §4b) still applies on top of the product rule.

## Consequences

- A vendor that loses every seat stays frozen. Nobody can edit its records until a seat is granted again, and promote does not write them. AECi corrects a wrong fact through a field override, or returns the records. This is the cost of the rule, and it is intended.
- Migration `0083` added `vendors.owned_at` as a plain `ADD COLUMN`, so it has no cascade exposure. It backfilled every vendor with a `vendor_admin` seat, banned or not. A ban never moves ownership, so it does not decide the backfill either (ruled 2026-10-19). The stamp is the earliest grant audit row or the migration time.
- The ownership message to the review app on a return is AECI-1418. *As built 2026-10-20: see the amendment below.* Before it, the review app learned of a return only when it next saw the records promote again.
- Hand-back audit rows say `cause` and `reason` `records-returned-to-aeci`. Rows from before AECI-1415 say `owner-seat-revoked`.
- Between this and AECI-1416, a curator could not add a product to an owned vendor through promote. The product was skipped with `BLOCKED_NEW_PRODUCT_REASON`. AECI-1416 replaced that skip with a proposal (amendment below).
- The last-seat hand-back of AECI-989 and AECI-1106 is superseded. The 2026-09-23 note in ADR 0035 is kept as history.

## Rulings recorded 2026-10-19

Chris ruled on these after the build, and each stands as built.

1. **Contests return to a later seat.** When the last seat goes, open owner contests move to AECi stamped with `owner_seat_lapsed_at`. A later seat grant (the claim approval, the admin provision or an invite redeem) routes them back to the owner, as after an unban. Only the admin return moves them to AECi for good.
2. **The admin seat provision stamps ownership.** `POST /api/admin/vendors/:id/seats` sets `owned_at` exactly as the claim approval does. A vendor with a provisioned seat owns its records.
3. **An integration an owned vendor built between two unowned products still writes unless claimed.** Rule 5 covers endpoints only. The per-row claim fence (`REVIEW_APP_PROMOTE_API.md` §4b, ADR 0035) governs these edges: once the owner claims the row, or created it (`origin = 'vendor'`), promote writes nothing to it.
4. **An owned connector vendor's catalogue still syncs.** The connector-catalog arm keys on `connector_catalogs.managed_by` (AECI-720), not on `owned_at`. Whether ownership should also freeze the catalogue is deferred to AECI-1343.

## Amendment 2026-10-19: AECI-1416 landed (new products become proposals)

Rule 5's interim skip is replaced. A new product that would join an owned vendor is stored in `product_proposals` (migration `0084`, `DATABASE_SCHEMA.md` §8.6f) with a `product_proposal.created` audit row in the promote batch. `product` is `null`, and the `skipped[]` entry carries `PROPOSED_PRODUCT_REASON` and `proposalId`. The payload is the validated `product` object, frozen. Its taxonomy is not resolved. It goes to the first owned vendor in the payload's `vendors[]` order.

- **Q4.** A proposal carries the product only. Integrations in the payload that touch it are skipped with `PROPOSED_PRODUCT_INTEGRATION_REASON` and never stored.
- **Q5.** One send per review-app ref, ever. A `ref` that already has a proposal, open, accepted or declined, is refused at plan time with its state and `proposalId`. Nothing is written to the catalog or proposals for it; the refusal writes its `promote.blocked` audit row, like every refusal. A unique index on `product_proposals.ref` is the commit-time guard. A racing second send errors with `PRODUCT_PROPOSED_DURING_PROMOTE`, and a re-push gets the plan-time refusal.
- **Ref identity.** `REVIEW_APP_PROMOTE_API.md` §3.1 called `ref` a client-local label that is not stored. A product `ref` is now stored as the proposal's identity, so it must be stable per review-app record. The review app sends `p:<recId>`, which is.

Accept and decline, and the owner's list, are AECI-1417.

## Amendment 2026-10-19 (later): rulings A, B and C on AECI-1416

Chris ruled on the three open points of the AECI-1416 build.

- **A. The ref shape is enforced.** A new product that would become a proposal must carry the review app's record ref, `p:rec…`. Any other ref is refused with `PROPOSAL_REF_REFUSED_REASON`, and nothing is written to the catalog or proposals for it (its `promote.blocked` audit row still is). A product for an unowned vendor is not checked.
- **B. Accept means exactly what was sent.** The proposal stores the whole product and every vendor the payload named, owned and unowned, each with the AECi id it resolved to (`ProductProposalPayload`). An accept creates that product with every one of those vendor links. `vendor_id` stays the owned vendor the proposal is addressed to, the first in payload order.
- **C. A return discards open proposals, and promote re-checks at commit.** "Return records to AECi" deletes the vendor's open proposals in its own batch and lists their ids in its audit row. Decided ones stay. A proposal that arrives between the return's read and its batch aborts the return with `VENDOR_PROPOSALS_CHANGED`. A promote that planned a proposal and commits after a return aborts with `VENDOR_RETURNED_DURING_PROMOTE`, the inverse of the rule 6 sentinel, and a re-push creates the product. The return's confirmation shows "N open product proposals will be discarded." from `open_proposal_count` on the vendor read.

## Amendment 2026-10-19 (later still): AECI-1417 landed (accept and decline)

Owner seats decide proposals on the portal's "Proposed products" tab
(`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.22, `API_CONTRACTS.md` §6.14). Members do not act.

- **Accept** re-checks that the proposal is open and that the addressed vendor still owns its
  record, before the batch and again inside it by sentinel. It creates the product exactly as
  proposed (ruling B), with every vendor link in the payload. A linked vendor that no longer
  exists refuses the accept (`PROPOSAL_VENDOR_MISSING`) rather than create a half-linked
  product. Taxonomy is find-only (ruling Q6): missing terms are dropped and listed, never
  minted. The product, the decision and two audit rows are one batch. It reuses promote's slug
  rule, column projection and purge deriver (`routes/vendor-proposal-accept.ts`).
- **The created product is vendor-maintained from birth**: `maintained_by = 'vendor'` and
  `last_reviewed_at` = the accept time, the markers a vendor-created integration carries. It is
  owned through its join to the owned vendor, so promote refuses it from then on.
- **Decline** records the decision and its audit row, nothing else.
- **One email per owner seat per proposal**, `product-proposal-owner-review`, sent from
  promote's post-commit hooks and keyed per proposal per owner.

The review app still learns of a decision only through a refused re-send. That message is
AECI-1418 (landed 2026-10-20, amendment below).

## Amendment 2026-10-20: AECI-1418 landed (the ownership message to the review app)

The review app now learns each ownership change from the live app. This is the **first call
the live app makes into the review app**. Every call before it ran the other way (promote,
ADR 0021). Contract: `REVIEW_APP_PROMOTE_API.md` §4d. The receiver is the review repo's
AECI-1412, which must ship before the end-to-end test.

- **When.** After the commit of a claim approval, an ownership-stamping seat provision, a
  proposal accept or decline, and "Return records to AECi". An accept sends one per owned
  vendor named on the created product (ruled 2026-10-20). `ops:backfill-ownership-sync`
  sends one per already-owned vendor (ruling Q7). A `404` (unknown vendor) shows on the
  daily data-quality gauge as `ownership_sync_unknown_vendor`.
- **How.** Producer enqueues, consumer works. Each route sends one message
  `{ vendorId, reason, enqueuedAt }` to `aeci-ownership-sync-{env}` in `waitUntil`. The API
  Worker consumes it, builds the record from D1 and `PUT`s it. A send failure warns and does
  not fail the user's write. Every attempt writes an `ownership_sync_deliveries` row
  (log-class, ADR 0022 amendment 2026-10-20).
- **Why a whole-record PUT, not a delta.** The message carries no ownership data, and the
  record is the vendor's complete current state, read at delivery. So a replay, a retry or an
  out-of-order delivery all converge: the receiver keeps the highest `version` and replaces
  what it holds. A delta would need ordered, exactly-once delivery, which Queues does not give,
  and a lost delta would leave the review app wrong with nothing to repair it. The backfill is
  the repair for any lost message, because sending the whole state again is always safe.
- **What the record says.** The vendor's `owner` and `ownedAt`, every joined product with its
  own owner (Q3), every integration where a product is the source or target, from
  `integrations` and `connector_evidenced_pairs` (Q2, the connector side excluded), and every
  proposal with its decision and created product id. The decision on a proposal, which the
  AECI-1417 amendment left to a refused re-send, now arrives here.
- **What it does not say.** Attestation ids. The live app rebuilds attestations on every
  promote, so their ids are not stable and the review app cannot map them. It derives an
  attestation's owner from its integration.
- **Unconfigured is loud.** A tier without `REVIEW_APP_OWNERSHIP_URL` and
  `REVIEW_APP_OWNERSHIP_TOKEN` acks each message with an `unconfigured` ledger row, a count and
  a warning (the AECI-851 lesson), and never retries.

## Amendment 2026-10-22: AECI-1424 landed (an owner adds a product)

Once a company owns its record, a product reached the catalog only as a promote proposal,
sent once (Q5). A declined proposal, one that cannot be accepted, or a product AECi never
found had no path. Chris ruled on 2026-10-20 (on AECI-1341) that the owner adds it from the
portal (option A). An admin re-open of a declined proposal and an admin create for a vendor
were rejected. Contract: `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.8, `API_CONTRACTS.md` §6.14.

- **Who.** An owner seat (`requireSeatOwner()`) of a company with `owned_at` set. A member
  seat is refused, and so is a company that does not own its record (`VENDOR_NOT_OWNED`).
  An ownership sentinel in the batch covers a "Return records to AECi" that lands mid-request.
- **What.** Free fields only (ruled 2026-10-22): name, description, website, logo and
  categories. A new product holds no license, so the edit route would refuse the rest.
  Taxonomy is find-only and strict: an unknown slug is a `400`, and no term is minted.
- **Born owned.** The product is promoted, `maintained_by = 'vendor'`, and joined to the
  caller's vendor as primary. Rule 5 then refuses every promote that names it. There is no
  `origin` column on `products`: ownership is the fence, and the `product.created` audit row
  (`metadata.reason = 'vendor-create'`) records who made it. A later "Return records to AECi"
  makes it AECi's like the vendor's other products, with no review-app record behind it.
- **No ownership message (ruled 2026-10-22).** The create sends nothing to the review app and
  adds no `OWNERSHIP_SYNC_REASONS` value. The product has no review-app record until the
  mirror (AECI-1413), a gap ruled accepted on 2026-10-20. The next whole-record sync from any
  other trigger lists it, because the record is read from D1 at delivery.
- **Duplicates warn (ruled 2026-10-22).** A same-name product or open proposal of the company
  is returned and audited, never refused.
- **The AECI-1417 decline sentence stays.** "You can add the product yourself from your
  dashboard." is now true.

## Revisit

When AECI-1343 decides the connector catalogue, or when AECI-1413 mirrors vendor edits through
the same receiver.
