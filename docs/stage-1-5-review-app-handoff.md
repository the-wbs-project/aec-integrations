# Stage 1.5 — Review-app handoff (for the `aec-integrations-review` / bamako team)

**Audience:** the Review-app (bamako) team building the AECI-290 / 292 / 295 / 296 work.
**Source of truth:** `docs/STAGE_1_5_SPEC.md` in the `aec-integrations` (singapore) repo. This note is a cross-repo summary — when it and the spec disagree, the spec wins. Anchors below (`§X`) point into that spec.
**Companion (singapore repo):** `docs/DATA_OBJECT_VOCABULARY.md` (frozen vocab), `docs/REVIEW_APP_PROMOTE_API.md` (promote contract), `docs/adr/0018-claims-attach-to-mechanism-row-agreement-computed.md`.

## What Stage 1.5 adds

A structured **claim/attestation model** on top of the existing integration catalog, plus a consolidated **product-PAIR page** in the main app. The Review app is the **system of record** for claims, exactly as it is for products/vendors/integrations. Authoring is **MCP-first** in 1.5 — there is no integration-editor UI and none is being built. In 1.5 the only attestor is **AECi** (staff curation); everything renders **"Unverified"** in the main app until the Stage 2 vendor portal exists.

## The model in one screen (§3)

- A **claim** = `(integration, data_object, direction)`. It **attaches to an integration (mechanism) row**, not to a product pair (ADR 0018). A pair connected by two mechanisms that both move RFIs is **two claims**.
- **`data_object`** is a term from the **frozen, closed** vocabulary in `DATA_OBJECT_VOCABULARY.md` (20 terms). Resolution is **find-only** — an unmatched term is rejected, never auto-created. `slug` is immutable identity; `aliases` is a case-insensitive synonym list for the resolver.
- **`direction`** is stored relative to the integration row's own endpoints: `a_to_b` / `b_to_a` / `both`, where **A = the integration's source product, B = its target product** (the stored endpoint order). The main app translates this to context-relative `outbound`/`inbound`/`both` at render time — **the Review app stores the canonical `a_to_b`/`b_to_a`/`both` value only.**
- An **attestation** = who asserts the claim. Shape: `source` (`aeci` / `vendor_a` / `vendor_b`), `asserted` (boolean), optional `introduced_at` / `deprecated_at` / `note`. **In 1.5 you only ever write `source: 'aeci'`, `asserted: true`.** `vendor_a`/`vendor_b` and the date stamps are dormant — accepted by the contract, written by no 1.5 path.

## Your four deliverables

### AECI-290 — Airtable foundation (§4.1)
- New **`data_objects`** lookup table mirroring `categories`/`disciplines`: `Name`, `slug`, `description`, `display_order`, `aliases`, `deprecated_at`. **Seed it from the frozen vocabulary** (`DATA_OBJECT_VOCABULARY.md` §4 / `data-object-vocabulary.json`).
- New **`integration_claims`** authoring table. Each row **links to one integration record** + one `data_objects` row, carries `direction`, and stores **`attestations` as a JSON array** (the §3.3 shape) — mirroring the existing JSON-on-a-row pattern of `integrations_discovery_candidates`, **not** a separate attestations table.

### AECI-292 — Claim MCP tools + seeding playbook (§4.2)
- `server/mcp/tools/claim-tools.ts`: `list_claims`, `get_claim`, `create_claim`, `update_claim`, `add_attestation`.
- `create_claim` resolves its `data_object` **find-only** against the seeded `data_objects` (slug or alias; a miss is an error to the caller, never an auto-create), attaches to an integration row, sets `direction`.
- Ship a **`seed-claims-from-integrations.md` playbook** that walks staff/Claude through turning an integration's free-text description into structured claims. AECI-299 (OPS, §4.3) runs this at scale — long-running, overlaps the main-app build.

### AECI-296 — Emit `claims[]` from `buildPromotePayload` (§5.2)
- Define `ClaimPayload` / `AttestationPayload` matching the shared schema (`PromoteClaimSchema` / `PromoteAttestationSchema` in singapore's `packages/shared/src/api/promote.ts`, landing in **AECI-291** — coordinate so the shapes match exactly).
- In `server/services/promote.ts`, assemble `claims[]` **nested under each integration** in the payload (claims attach to the mechanism row).
- **Withhold rule:** emit a claim only when its integration is emitted — i.e. when **both** of the integration's endpoints are promoted. **Reuse the existing integration-withholding logic**, don't duplicate it. The main app reports an unresolved `data_object` in the promote response's `skipped[]` with `kind: "claim"` (never a 500), so emitting a best-effort `data_object` slug/name is safe.

### AECI-295 — Read-only Claims tab for QA (§4.4)
- A **read-only** "Claims" tab in the Angular product-detail page so curators can QA the AECI-299 seeding: list a product's claims grouped by integration, showing `data_object`, direction, attestation sources. **No editor** — authoring stays in MCP for 1.5.

## Gotchas

- **Find-only, always.** Neither the MCP tools nor promote may mint a `data_object`. If curators need a new term, that's a vocabulary change (a PR against `DATA_OBJECT_VOCABULARY.md` that re-seeds **both** apps), not a typed value.
- **Direction is endpoint-relative, not viewer-relative.** Store `a_to_b`/`b_to_a`/`both` against the integration's source/target. Do not pre-translate to outbound/inbound — the main app owns that (§3.2).
- **One source of truth for the vocab.** Seed Airtable `data_objects` from `DATA_OBJECT_VOCABULARY.md`; don't hand-key the list.
- **Coordinate the contract land (AECI-291).** The `claims[]` shared schema in singapore's `packages/shared` is the cross-repo pivot. Your emit (296) must match it field-for-field; land/track 291 first.
