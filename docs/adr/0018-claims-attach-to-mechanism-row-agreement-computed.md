# 0018 — Claims attach to the mechanism (integration) row; agreement is computed-not-stored

- **Status:** Accepted (2026-06-30)
- **Date:** 2026-06-30
- **Context owner:** chrisw@thewbsproject.com
- **Spec anchor:** `docs/STAGE_1_5_SPEC.md` §3, §6 (Stage 1.5 — Integration Redesign)
- **Retains / interacts:** ADR 0016 (D1 app DB + Drizzle — the data layer this builds on), ADR 0008 (taxonomy as code-managed reference data — the `data_object` vocab mirrors it), ADR 0010 (promote purges Cloudflare directly — the pair-page purge path), ADR 0011 (serving-origin canonical — the pair-page canonical)

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
