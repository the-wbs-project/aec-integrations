# 0018 — Claims attach to the mechanism (integration) row; agreement is computed-not-stored

- **Status:** Accepted (2026-06-30)
- **Date:** 2026-06-30
- **Context owner:** chrisw@thewbsproject.com
- **Spec anchor:** `docs/STAGE_1_5_SPEC.md` §3, §6 (Stage 1.5 — Integration Redesign)
- **Retains / interacts:** ADR 0016 (D1 app DB + Drizzle — the data layer this builds on), ADR 0008 (taxonomy as code-managed reference data — the `data_object` vocab mirrors it), ADR 0028 (promote purges Cloudflare directly — the pair-page purge path; numbered 0010 when this ADR was written), ADR 0011 (serving-origin canonical — the pair-page canonical)

---

## Context

Stage 1.5 (Integration Redesign) adds a structured answer to *"what data flows between two integrated products, and in which direction?"* — a closed `data_object` vocabulary, claims, and attestations — and replaces the single-row `source → target` integration page with a consolidated **product-PAIR page**. Two modelling choices shape every downstream issue (schema, promote, rendering, search), so they are recorded here before the build fans out.

**Where does a claim attach?** A product pair can be connected by several mechanisms (a native connector, a Zapier app, a partner API), each potentially moving different data objects in different directions. A claim ("RFIs flow A→B") must hang off *something*. The two candidates were: (a) a new **pair** entity, or (b) the existing **integration (mechanism)** row.

**Is agreement stored or computed?** A claim can be attested by AECi and (in Stage 2) by each vendor. "Do the parties agree?" is a derived signal. It could be **materialised** (a stored `agreement` column kept in sync on every attestation write) or **computed** on read from the attestation set.

## Decision

**1. Claims attach to the integration (mechanism) row.** A claim's identity is the triple `(integration_id, data_object_id, direction)`. A pair connected by two mechanisms that both move RFIs is **two claims** (one per integration row). The pair page is a **query-time grouping** of the integration rows between two products, not a stored pair entity.

- Direction is stored relative to the integration row's own endpoints (`a_to_b` / `b_to_a` / `both`, where A/B are the row's `source`/`target`) and translated to a context-relative `outbound`/`inbound`/`both` at the API (`docs/STAGE_1_5_SPEC.md` §3.2).
- Consolidation needs **no `integrations`-table migration**: there is no unique pair index today (`apps/api/src/db/schema.ts` integrations table carries only non-unique source/target indexes and a distinct-endpoints check), and Stage 1.5 adds none.
- The same model holds in both stores: Airtable `integration_claims` rows link to an integration record; D1 `claims` FK to `integrations(id)`, with a unique index on the identity triple making promote ingest an idempotent upsert.

**2. Agreement is computed, never stored.** A single pure function `computeAgreement(attestations) → AgreementState` (`packages/shared/src/agreement.ts`) derives the state on read; no `agreement` column exists.

- **Only vendor attestations vote.** Agreement is a *vendor-vs-vendor* signal. The **AECi attestation is excluded from the vote** — it is the seed/baseline, not a party.
- **AECi-never-red.** Because AECi never votes, an AECi-only claim can never produce a `conflict` (red) state. In Stage 1.5 — where the only attestor is AECi (no vendor portal yet) — every claim resolves to **"Unverified"**, and the `confirmed/total` sync headline shows `confirmed = 0`.

## Consequences

**Positive**
- **No new pair entity and no integrations migration** — the redesign is additive (`taxonomy_data_objects` / `claims` / `attestations`) over the existing integration model; the pair page is pure query/SSR.
- **One source of truth for agreement.** A pure function shared by API, SSR, and tests can't drift from a stored column, and re-promote/re-attestation can never leave a stale materialised value. Stage 2 lights up the conflict/confirmed branches with no migration — they are implemented and unit-tested against synthetic vendor attestations now.
- **Honest pre-launch posture.** "Unverified" everywhere is structurally guaranteed in 1.5 rather than a hand-set flag; the model cannot accidentally claim vendor confirmation it doesn't have.

**Negative / accepted trade-offs**
- **Agreement is recomputed on every read.** Acceptable: the input is a small per-claim attestation set and the pair page is edge-cached; if it ever matters, a derived column can be added without changing the contract (the function stays the boundary).
- **Multi-mechanism duplication.** The same data_object moving through two mechanisms is two claims, which the pair page must group sensibly (§8). Accepted — it reflects reality (two distinct integration paths) and avoids a lossy merge.
- **Dormant surface area.** `vendor_a`/`vendor_b` attestation sources and the `introduced_at`/`deprecated_at` version stamps ship in the 1.5 schema/contract but are exercised by no 1.5 code path — carried for Stage 2 (AECI-301/303) to avoid a later migration.

## Amendment — 2026-08-14 (AECI-605, Stage 2 attestations epic)

Decision 2 stands; the **state set** it produces has widened. `docs/STAGE_2_ATTESTATIONS_SPEC.md`
§4 is the governing spec.

- **`AgreementState` has four values**, ascending: `unverified | single_source | confirmed |
  conflict`. `single_source` is new.
- **`confirmed` now requires two *distinct vendor identities***, deduped by
  `attestations.attested_by_vendor_id` (added by AECI-603's migration 1). As originally written the
  function returned `confirmed` for *any* affirming vendor with no denial — so a single vendor
  affirming while the counterparty stayed silent would have rendered "Vendor-confirmed". That
  branch was unreachable in Stage 1.5 (AECi never votes), so the defect was latent; the vendor
  portal (AECI-301) makes it reachable. One-sided affirmation is now `single_source`, rendered
  neutral and attributed.
- **Why identity and not slot.** `product_vendors` is many-to-many, so one company can own *both*
  endpoints of an integration and fill both attestation slots. Counting slots would let a vendor
  manufacture bilateral agreement on its own intra-portfolio integrations. `attested_by_vendor_id`
  is `ON DELETE SET NULL`, so unattributable votes collapse into one bucket rather than being
  trusted as distinct.
- **Retracted attestations do not vote** (`retracted_at`, also AECI-603). The `introduced_at` /
  `deprecated_at` version stamps are **not** retraction and never gate the read.
- **The "no migration" claim held for the engine.** Agreement is still computed-not-stored, and
  this change needed no schema of its own — but it does *read* two columns AECI-603 added, so
  "Stage 2 lights up the branches with no migration" (above) was true of the function and not of
  the epic. The wider correction is recorded in `STAGE_1_5_SPEC.md` §10.
- **AECi-never-red is now doubly true:** AECi does not vote, *and* `conflict` requires two distinct
  vendors.

A companion predicate `isClaimRefuted()` ships alongside, because `unverified` conflates "nobody
voted" with "every vendor denies" — and only the latter may stop a claim contributing its direction
to the product-detail integrations table.

---

## Amendment — 2026-08-31 (AECI-721): the mechanism row lives in two tables

**Decision 1 stands; the word "integration" in it narrows to "mechanism row".**

Stage 1.5 Addendum C (`STAGE_1_5_SPEC.md` §13.1) split the **delivered** tier across two tables:
`integrations` for accountable-party edges, and `connector_evidenced_pairs` for edges an iPaaS
delivers. AECI-721 migrated the connector-powered edges out of the first and into the second, which
means a claim's anchor can now be a row of either.

**What changed.** `claims` carries two nullable anchor FKs — `integration_id` and
`connector_evidenced_pair_id` — with `claims_anchor_check` asserting exactly one is set, and a
STORED generated `anchor_id = coalesce(integration_id, connector_evidenced_pair_id)`. The identity
triple becomes `(anchor_id, data_object_id, direction)`.

**What did not change, and why this is an amendment rather than a reversal:**

- **The anchor is still the mechanism row, and still not the pair.** Two mechanisms moving the same
  `data_object` between the same two products are still two independent claims. The pair page is
  still a query-time grouping — it just now composes two source tables instead of one.
- **The identity is still immutable.** Migration `0022` inserts each moved edge into
  `connector_evidenced_pairs` with its `integrations.id` **verbatim**, so all 85 production claims
  kept the same `anchor_id` *value*; only the column holding it moved. No id was reissued, and every
  existing `audit_log` row, PostHog log line and attestation still resolves.
- **Decision 2 (agreement computed, never stored) is untouched.**

**Why a generated column rather than a plain nullable FK in the index.** A nullable `integration_id`
inside `claims_identity_key` would have silently broken the immutability this ADR asserts: SQLite
treats NULLs as **distinct**, so two claims differing only in a NULL anchor would both be accepted
and the unique index would stop being unique for exactly the rows that had just moved. Coalescing to
one non-null column before indexing is what preserves the guarantee. The cost is that `claims` can
only ever be *recreated* into this shape — SQLite refuses to `ALTER TABLE ADD COLUMN` a STORED
generated column — which is why this rode the one destructive migration rather than an additive one.

**Why the exactly-one-anchor rule is a DB CHECK here**, when the sibling `origin` /
`created_by_vendor_id` biconditional is application-enforced: those two are deliberately not a CHECK
because an `ON DELETE SET NULL` would re-evaluate the constraint and make deleting an unrelated
vendor fail. Both anchors here **cascade**, so a claim disappears with its anchor rather than being
re-evaluated against it. Nothing can make this CHECK fail a delete.

**Consequence for attestation.** A claim anchored on a connector-evidenced pair is not attestable —
an evidenced pair is connector-delivered by construction, and §14 of
`STAGE_2_ATTESTATIONS_SPEC.md` already forbids attestation on connector-delivered edges. The
authority read and the detector sweep therefore scope themselves to `integration_id IS NOT NULL`
explicitly, so the exclusion is a stated decision rather than an emergent property of an inner join.

---

## Amendment — 2026-09-13 (AECI-891): a third arm, and it is not a delivered row

**Decision 1 stands. The 2026-08-31 amendment's "either delivered-tier table" becomes "one of three
anchor tables", and the third is not delivered.**

Operator ruling of 2026-09-13: **a claim can anchor to a reached pair, and AECi carries it.** An
earlier answer the same day said such claims would be translated onto the delivered tier at promote
time; that is superseded. Translation would have minted a `connector_evidenced_pairs` row — a
*delivered* row, meaning somebody built the integration — for a pair nobody built. Carrying the
reach anchor honestly is the lesser distortion.

**What changed.** `claims` carries a third nullable anchor FK, `connector_pair_id` →
`connector_pairs(id)` `ON DELETE cascade` (`DATABASE_SCHEMA.md` §9a.5). `anchor_id` becomes
`coalesce(integration_id, connector_evidenced_pair_id, connector_pair_id)`, still STORED, still the
leading column of `claims_identity_key`. The identity triple is unchanged.

**The distinction that must not blur, in this ADR above all.** The first two anchors point at
**delivered** rows: somebody built the integration. The third points at the **reachable** tier:
nobody built anything, and the two ends are merely joinable through that connector. Wherever this
ADR or its readers say "the anchor", say which kind. A surface that renders all three identically
turns reach into a delivery claim, which is the exact error Addendum C's I24 ruling exists to
prevent (`STAGE_1_5_SPEC.md` §13.7).

**Why the CHECK changed form and not just arity.** `claims_anchor_check` was
`(a IS NOT NULL) <> (b IS NOT NULL)`, which says "exactly one" for two terms and does **not** for
three: `a <> b <> c` parses as `(a <> b) <> c` and evaluates TRUE when all three are set. The
shipped form sums the three booleans and compares to `1`. Anyone restoring the chained `<>` for
symmetry would reopen a hole that admits a triple-anchored claim.

**Why no discriminator column is needed.** The three id spaces cannot collide: `connector_pairs.id`
is the review app's own record id, while `integrations.id` and `connector_evidenced_pairs.id` are
UUIDs minted here. So `anchor_id` alone still identifies one row in one table.

**What it cost.** A second destructive `claims` recreate — migration `0033`, the same shape as
`0027` and for the same reason, since a STORED generated column cannot be altered in place.
`attestations` cascades from `claims`, production holds roughly 1,872 of each, and
`PRAGMA defer_foreign_keys` does not defer cascade *actions*, so the migration carries both through
`__carry_*` tables. A second consequence to carry forward: `connector_pairs` now **has** a cascade
child where it had none, so the next recreate of *that* table is the dangerous class too
(`docs/migrations.md` §3.3a).

**Consequence for attestation, unchanged and now doubly so.** The 2026-08-31 amendment scoped the
authority read and the detector sweep to `integration_id IS NOT NULL` explicitly rather than letting
an inner join imply it. That decision pays off here with no new rule: a reach-anchored claim falls
outside both by construction. It is not attestable, and it would be incoherent if it were — no
vendor built the edge, so there is nobody to ask.

**Consequence for rendering: none, deliberately.** A pair-anchored claim can land and no surface
reads one. The reachable pair page is **AECI-716** and is unbuilt, and §13.7's endpoint summary line
enumerates nothing. This is a stated carve-out of AECI-891, not an oversight, and the next reader to
build that surface owns the delivered-versus-reach distinction above.
