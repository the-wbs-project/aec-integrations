# AEC Integrations — Stage 1.5 Specification (Integration Redesign)

**Status:** Approved — ready for build
**Supersedes:** the integration portions of `STAGE_1_SPEC.md` — §4.4 (the single-row source→target integration page), the `/integrations/:id` row of the §3.1 route table, and the integration note in §7.5
**Inherits from:** Stage 1 (Phases 1–7 — foundation, data display, search, home, auth/reviews, requests, polish)
**Companion docs:** `DATA_OBJECT_VOCABULARY.md` (frozen vocab — source of truth for §2), `REVIEW_APP_PROMOTE_API.md` (promote contract — §5), `API_CONTRACTS.md` (endpoint shapes — §6), `DATABASE_SCHEMA.md` (table conventions — §6.1), `CACHE_STRATEGY.md` (cache tags — §7), `SEARCH_RANKING.md` (Algolia — §9)
**ADR:** `docs/adr/0018-claims-attach-to-mechanism-row-agreement-computed.md`

> **Data-layer note (ADR 0016).** The application database is **Cloudflare D1 + Drizzle**; Supabase is auth-only. Every D1 write in this spec goes through `getDb(env)` and, for multi-statement writes, a single `db.batch([...])` that includes the `audit_log` row (the §26.1 invariant of `STAGE_1_SPEC.md`). There is no Prisma, no Postgres, no RLS on app tables.

---

## 1. Overview & phasing

Stage 1.5 — **Integration Redesign** — is a focused, pre-launch redesign of the one surface in Stage 1 that misleads: the integration page. It lands two coordinated changes.

- **(A) The product-PAIR page.** Today an integration is rendered as a standalone `source → target` row at `/integrations/:id`. Two products can be connected by several mechanisms (a native connector *and* a Zapier app *and* a partner API), and the directionality of each is buried. Stage 1.5 replaces the per-row page with a single **context-oriented pair page** nested under a product — `/products/:contextSlug/integrations/:otherSlug` — that consolidates **every** mechanism between the two products into one view.
- **(B) The claim/attestation model.** Stage 1.5 adds a structured answer to *"what actually flows between these two products, and in which direction?"* A **claim** is the unit: a closed-vocabulary `data_object` (RFIs, Budgets, Models…) moving in a `direction`, attached to a specific integration (mechanism) row. Claims carry **attestations** (who says so). In Stage 1.5 the only attestor is **AECi itself** (staff curation); vendor attestations — and everything that depends on them — are Stage 2.

The redesign is deliberately split into **two layers** so visible value ships before any data exists:

| Layer | What | Needs claim data? | Ships |
|---|---|---|---|
| **A** | The pair page — routing, 301 consolidation, SEO (§7) | **No** | First (AECI-294) |
| **B** | Claim rendering on the pair page — the data-flow section (§8) | Yes (seeded via §4–§6) | After the spine is seeded |

### 1.1 The 1.5 ⇄ Stage 2 split

Everything in Stage 1.5 is **AECi-seeded and read-only to the public**. The dividing line is the **vendor portal**: anything that requires a vendor to log in and assert something is Stage 2.

| In Stage 1.5 | Deferred to Stage 2 |
|---|---|
| Pair page + 301 consolidation (§7) | Vendor attestation authoring (AECI-301) |
| Claim model + AECi attestations (§3) | Conflict UI + notification pipeline (AECI-302) |
| `data_object` closed vocabulary (§2) | Version-diff timeline (AECI-303) — **shipped**, over the `product_versions` FKs rather than these date stamps |
| `computeAgreement` (vendor-vs-vendor; AECi-never-red) (§3.4) | Paywalled integration depth (AECI-304) |
| Read-only claim rendering — everything shows **"Unverified"** (§8) | Per-pair Algolia records + integrations search tab (§9) |

Because no vendor can attest in 1.5, **every claim renders "Unverified"** and the agreement engine can never produce a red "conflict" state (§3.4). The version stamps (`introduced_at`/`deprecated_at`) and the `vendor_a`/`vendor_b` attestation sources ship **additive and dormant** — present in the schema, exercised by Stage 2.

### 1.2 Issue map (the anchors this doc is the contract for)

Every Stage 1.5 issue opens with `**Spec section:** §X.Y (docs/STAGE_1_5_SPEC.md)`. The subsection numbering below is load-bearing — it must not be renumbered without updating the issues.

| Anchor | Issue | Surface |
|---|---|---|
| §2 | AECI-287 *(done)* | `data_object` controlled vocabulary |
| §3 | — | Claim/attestation model (foundational; no single issue) |
| §4.1 | AECI-290 | Review app: Airtable `data_objects` + `integration_claims` |
| §4.2 | AECI-292 | Review app: claim MCP tools + seeding playbook |
| §4.3 | AECI-299 | OPS: re-curate the catalog into claims |
| §4.4 | AECI-295 | Review app: read-only Claims tab (QA) |
| §5 | AECI-291 | Promote contract: add `claims[]` (shared schema) |
| §5.2 | AECI-296 | Review app: emit `claims[]` from `buildPromotePayload` |
| §6.1 | AECI-293 | Main app: D1 schema (`taxonomy_data_objects` / `claims` / `attestations`) |
| §6.2 | AECI-297 | Main app: `POST /api/promote` ingests `claims[]` |
| §7 | AECI-294 | Pair page (Layer A) — routing / 301 / SEO |
| §8 | AECI-300 | Claim rendering (Layer B) |
| §9 | AECI-298 | Search / SEO / Algolia follow-through |
| §11 | AECI-339 | Addendum A — search-intent pair indexing (this addendum) |
| §11.2 | AECI-340 | Dual-orientation indexable pair pages |
| §11.3 | AECI-341 | Context-specific suggestions module |
| §11.4 | AECI-342 | "Meaningful no" pair pages — scoring / template / tiered indexing |
| §11.5 | AECI-343 | Per-pair "report a missing integration" CTA |
| §11.6 | AECI-344 | GSC measurement loop — gate + quarterly tier review |
| §12 | — | Addendum B — connector-role product detail: powered integrations (`integrations_as_connector` + hub view) |
| §12.7 | — | Catalog-scope note under both populated integration lists |
| §13 | AECI-708 | Addendum C — connector presentation contract (this addendum) |
| §13.2 / §13.3 | AECI-713 | Endpoint Integrations split — direct lane + "Via {connector}" groups |
| §13.4 | AECI-713 | Contract additions the split needs (`powered_by` on the detail embed; self-exclusion) |
| §13.5 | AECI-721 | Count invariants — §12.5 resolved as B; the ten-site lockstep |
| §13.6 | AECI-707 | Connector / hybrid role-varied product-detail template |
| §13.7 | AECI-715 / AECI-716 | Connector coverage surface + reachable-lane publication boundary |

Prototypes (AECI-289) gate §7/§8 — build the production pair page and claim rendering **against the approved I3 prototype**. The §11 rows are **post-launch Addendum A** work (project "Pair-Page Search Intent (pSEO)"), not part of the original 1.5 critical path.

### 1.3 Critical path

```
287 (vocab) → 288 (this spec) → 291 (promote claims[] shared schema)
            → 293 (D1 schema) → 297 (promote ingest) → 300 (claim rendering)
```

The Review-app lane (290 → 292 → 295/296) and the OPS re-curation (299) run in parallel; the pair page (294, Layer A) needs none of them and ships first. The two locked architectural decisions — *claims attach to the mechanism row* and *agreement is computed-not-stored* — are recorded in **ADR 0018**.

---

## 2. `data_object` vocabulary

The `data_object` controlled vocabulary is **frozen** and lives in **`docs/DATA_OBJECT_VOCABULARY.md`** (with a generated machine-readable mirror, `docs/data-object-vocabulary.json`). **That document is the source of truth — this spec references it and does not duplicate the 20-term table** (one source of truth; the table drifts the moment it is copied).

A `data_object` is the **noun that flows between two integrated products** — the *what* of an integration (RFIs, Budgets, Models…). It is the load-bearing middle term of claim identity (§3.1). The vocabulary mirrors the existing taxonomy vocabularies (`taxonomy_categories` / `taxonomy_audiences` / `taxonomy_phases`) in shape — `slug` / `name` / `description` / `display_order` — and adds one field, **`aliases`**.

The rules every consumer must honour (full detail in `DATA_OBJECT_VOCABULARY.md` §2–§5):

- **Closed and frozen.** Adding/removing/renaming a term is a deliberate vocabulary change — a PR that edits the doc and re-seeds **both** apps. Curators cannot mint a term by typing one.
- **Find-only resolution.** During promote (§5, §6.2) a free-text `data_object` value is matched against the canonical `slug` set, directly or via an alias. **An unmatched term is rejected, not auto-created** — it lands in the promote response's `skipped[]` with `kind: "claim"`, never a 500.
- **`slug` is the immutable identity key.** Renaming a slug would orphan existing claims. `name` / `description` / `aliases` / `display_order` may be edited freely (presentation/matching metadata, not identity).
- **`aliases` is resolver metadata.** A case-insensitive synonym list the seeding AI and the promote resolver map onto a canonical slug ("Requests for Information" → `rfis`). Whether D1 materialises an `aliases` column or keeps the map beside the seeder is a §6.1 decision; either way the doc is the source of the mapping.
- **Deterministic ids + idempotent seed.** Ids are **UUIDv5 derived from the `slug`** (the convention `apps/api/seed/taxonomy.sql` already uses), so they are stable across re-runs and across both apps and are **not stored** in the doc/JSON. Seeding is an UPSERT keyed on `slug` (`ON CONFLICT(slug) DO UPDATE`); it never deletes.

### 2.1 Naming across the two apps

The vocabulary is one logical list seeded into two stores with each store's own naming convention. **This spec sets the canonical names** (reconciling a `data_objects` shorthand that appears in some issue drafts):

| Store | Table / file | Convention it mirrors |
|---|---|---|
| Review app (Airtable) | **`data_objects`** lookup table | sibling lookup tables `categories` / `disciplines` (no prefix) |
| Main app (D1) | **`taxonomy_data_objects`** | the existing `taxonomy_categories` / `taxonomy_audiences` / `taxonomy_phases` |
| Main app seed | **`apps/api/seed/data-objects.sql`** | `apps/api/seed/taxonomy.sql` |

The relational claim tables are **not** taxonomy and carry no prefix: D1 `claims` + `attestations` (§6.1); the Airtable authoring table is `integration_claims` (§4.1).

---

## 3. Claim/attestation model

This section is the conceptual heart. It is implemented in Airtable (§4), travels over promote (§5), is stored in D1 (§6), and is rendered on the pair page (§8). It is the same model in every layer.

### 3.1 Claim identity — claims attach to the mechanism row

A **claim** asserts that a particular `data_object` flows in a particular `direction` through a **specific integration (mechanism) row**. Its identity is the triple:

```
(integration_id, data_object_id, direction)
```

The **integration row is the anchor** (ADR 0018). Consequences:

- A pair of products connected by **two mechanisms** (e.g. a native connector and a Zapier app) that both move RFIs yields **two claims** — one per integration row. The pair page (§8) groups them under the pair but they remain distinct rows.
- Consolidation onto the pair page needs **no `integrations`-table migration**: there is no unique pair index today (`apps/api/src/db/schema.ts` integrations table — only non-unique `source`/`target` indexes and a distinct-endpoints check), and Stage 1.5 adds none. The pair page is a *query-time* grouping (§7), not a stored entity.
- The unique index `(integration_id, data_object_id, direction)` (§6.1) makes promote ingest an idempotent upsert (§6.2). *(Intended from the start; actually true only since AECI-604 — the 1.5 ingest shipped as delete-and-reinsert. See the §6.2 note.)*

**Amended by AECI-721 (2026-08-31): the anchor is polymorphic, the identity is not.** "The mechanism row" now means a row of *either* delivered-tier table — `integrations`, or `connector_evidenced_pairs` for an edge an iPaaS delivers (§13.1). `claims` carries both FKs, nullable, with a CHECK that exactly one is set, and the identity triple becomes `(anchor_id, data_object_id, direction)` where `anchor_id` is a STORED generated `coalesce` of the two.

Nothing above changes in substance. The anchor is still the mechanism row, still not the pair, and the identity is still immutable — the migration passed each moved edge's id verbatim to its evidenced pair, so all 85 production claims kept the same `anchor_id` value and only changed which column holds it. The generated column is load-bearing rather than cosmetic: a nullable `integration_id` in the unique index would break the identity outright, because SQLite treats NULLs as distinct. ADR 0018 carries the dated amendment.

### 3.2 Direction encoding — stored vs context-relative

Direction is stored **relative to the integration row's own two endpoints**, and exposed at the API **relative to the page's context product**. Keep the two representations distinct.

**Stored (D1 `claims.direction`, Airtable `integration_claims`):** one of

| Stored value | Meaning |
|---|---|
| `a_to_b` | flows from endpoint **A** to endpoint **B** |
| `b_to_a` | flows from endpoint **B** to endpoint **A** |
| `both` | bidirectional |

where **A = the integration's `source_product_id`** and **B = its `target_product_id`** (the stored endpoint order on the row). This is canonical and never depends on which product the visitor is viewing.

**Context-relative (API / `packages/shared`):** the pair page is viewed *from* a context product. The API translates the stored direction into the visitor's frame:

| Stored | Context product = A | Context product = B |
|---|---|---|
| `a_to_b` | `outbound` | `inbound` |
| `b_to_a` | `inbound` | `outbound` |
| `both` | `both` | `both` |

So a claim stored `a_to_b` reads as **"outbound"** on product A's pair page and **"inbound"** on product B's. The translation is a pure function in `packages/shared` (the same place `defaultIntegrationContext` lives — §7); the stored value is never rewritten.

### 3.3 Attestation shape

An **attestation** records *who asserts a claim*. Attestations hang off a claim (D1: relationally in `attestations`; Airtable: as a JSON array on the claim row — §4.1).

| Field | Type | Notes |
|---|---|---|
| `source` | `'aeci' \| 'vendor_a' \| 'vendor_b'` | who attests. `vendor_a` / `vendor_b` map to the integration's endpoint-A / endpoint-B vendors. **In Stage 1.5 only `aeci` is ever written.** |
| `asserted` | boolean | `true` = this source affirms the claim; `false` = denies it. AECi seeds `true`. |
| `introduced_at` | date \| null | **dormant in 1.5** — a coarse version stamp. AECI-303 ships the §9 diff over the PRECISE `introduced_version_id`/`deprecated_version_id` FKs (Stage 2 migration 2) instead; these dates remain the fallback for the claims promote writes, and a claim with neither is **always present** at every selection. |
| `deprecated_at` | date \| null | **dormant in 1.5** — version stamp. |
| `note` | string \| null | optional provenance/source note. |

`vendor_a` / `vendor_b` and the version stamps are **additive and dormant**: present in schema and contract, written by no 1.5 code path.

> **Stage 2 update (AECI-603, 2026-08-14).** `vendor_a` / `vendor_b` are no longer dormant, and the table above is no longer the whole row. Migration 1 of the AECI-514 epic added **`attested_by_vendor_id`** (which vendor identity filled the slot — `confirmed` requires two *distinct* ones) and **`retracted_at`** (supersession, which is **not** what `introduced_at`/`deprecated_at` mean — those stay version stamps exactly as defined above). Which slot a caller may write derives from product ownership in `product_vendors`, never from the request. See `docs/STAGE_2_ATTESTATIONS_SPEC.md` §2 and `docs/DATABASE_SCHEMA.md` §5a.2.

### 3.4 Computed agreement — `computeAgreement` and the AECi-never-red rule

Agreement is **computed from the attestation set, never stored** (ADR 0018). A single pure function owns it:

```
computeAgreement(attestations) → AgreementState
```

It lives at **`packages/shared/src/agreement.ts`** (AECI-300) so the API, SSR, and tests share one implementation.

Rules:

- **Only vendor attestations vote.** Agreement is a *vendor-vs-vendor* signal: it asks whether the two vendors of a pair agree about a data flow. **The AECi attestation is excluded from the vote** — it is the baseline/seed, not a party to the disagreement.
- **AECi-never-red.** Because AECi never votes, an AECi-only claim can **never** produce a `conflict` state. The conflict (red) state requires two distinct vendors to disagree — impossible until the Stage 2 portal exists.
- **Distinct vendor identities** *(added by AECI-605 — `STAGE_2_ATTESTATIONS_SPEC.md` §4)*. Votes are deduped by `attestations.attested_by_vendor_id`, and **`confirmed` requires two of them**. `product_vendors` is many-to-many, so one company can own *both* endpoints of an integration and fill both attestation slots; without the dedupe it could affirm both and manufacture "Vendor-confirmed" on its own intra-portfolio integrations. A single vendor affirming alone resolves **`single_source`**, never `confirmed`. Retracted attestations (`retracted_at IS NOT NULL`) do not vote — note that `deprecated_at` is a *version stamp* (§3.3), not retraction, and never gates the read.
- **Stage 1.5 reality.** With only an `aeci` attestation present, every claim resolves to an **"Unverified"** state and renders as such (§8). The agreement engine ships fully but, by construction, only ever returns the unverified branch in 1.5.

`AgreementState` is enumerated in `agreement.ts` as `unverified | single_source | confirmed | conflict` (ascending verification); the 1.5-reachable value is the unverified one. The other three branches are implemented and unit-tested against synthetic vendor attestations so Stage 2 inherits a proven function. The full outcome matrix lives in `STAGE_2_ATTESTATIONS_SPEC.md` §4.2, and the render contract for each state in §4.3.

### 3.5 The `confirmed / total` sync headline

The pair page leads its data-flow section with a headline of the form **"N data objects sync"** plus a verification ratio **`confirmed / total`**:

- **`total`** — the number of distinct claims on the pair (all directions, all mechanisms).
- **`confirmed`** — claims whose computed agreement is vendor-confirmed.
- **`single_source`** *(added by AECI-605 — `STAGE_2_ATTESTATIONS_SPEC.md` §4.3)* — claims exactly one vendor affirms with the counterparty silent.

`single_source` is reported as its **own clause**, never added into `confirmed` — folding a one-sided assertion into the bilateral figure is the overstatement `STAGE_2_SPEC.md` §8.1(4) forbids. The rendered line reads e.g. "3 of 12 vendor-confirmed · 4 confirmed by one vendor only", and the second clause is omitted entirely at zero rather than rendered as "0".

In Stage 1.5 **both counts are 0** for every pair (no vendor attestations), so the headline communicates breadth ("12 data objects sync") with an honest **"Unverified"** posture, never a fake trust signal. The ratio becomes meaningful in Stage 2.

---

## 4. Review app (bamako) — authoring & re-curation

The Review app (`aec-integrations-review`, codename *bamako*) is the **system of record** for claims, exactly as it is for products/vendors/integrations. AECi staff (and Claude via MCP) author claims there; they reach the main app only through promote (§5). Authoring is **MCP-first** in 1.5 — the Review app has no integration editor UI today, and building one is out of scope. A cross-repo handoff for the bamako team lives at **`docs/stage-1-5-review-app-handoff.md`**.

### 4.1 Airtable `data_objects` + `integration_claims` tables (AECI-290)

- **`data_objects`** — a new lookup table mirroring the existing `categories` / `disciplines` lookups: `Name`, `slug`, `description`, `display_order`, `aliases`, `deprecated_at`. **Seed it from the frozen vocabulary** (`DATA_OBJECT_VOCABULARY.md` §4 / the JSON mirror).
- **`integration_claims`** — the authoring table for claims. Each row **links to one integration record** (the mechanism anchor — §3.1) and carries:
  - a link to one `data_objects` row,
  - `direction` (`a_to_b` / `b_to_a` / `both`, stored relative to the integration's source/target — §3.2),
  - **`attestations` as a JSON array** (the §3.3 shape), mirroring the existing JSON-on-a-row pattern used by `integrations_discovery_candidates` — not a separate Airtable table.

Keeping attestations as JSON in Airtable (relational in D1 — §6.1) matches each store's grain: Airtable authors a compact editable blob; D1 normalises it for query.

### 4.2 Claim MCP tools + seeding playbook (AECI-292)

MCP is the authoring seam. Add `server/mcp/tools/claim-tools.ts` exposing:

- `list_claims`, `get_claim` — read.
- `create_claim` — resolves its `data_object` **find-only** against the seeded `data_objects` (slug or alias; a miss is an error to the caller, never an auto-create), attaches to an integration row, sets `direction`.
- `update_claim` — edit direction / data_object.
- `add_attestation` — append an attestation (in 1.5, `source: 'aeci'`).

Ship a **`seed-claims-from-integrations.md` playbook** that drives staff/Claude through converting an existing integration's free-text description into structured claims via these tools. This is the instrument AECI-299 runs at scale.

### 4.3 OPS — re-curate the catalog into claims (AECI-299)

A **tracked work item, not a code change.** Staff run the §4.2 playbook over the existing catalog so the pair page (§8) has data to render. Long-running; **overlaps the main-app build** (the pair page ships first without it). The output is AECi attestations only — everything stays "Unverified" until Stage 2.

### 4.4 Read-only Claims tab in product-detail (AECI-295)

Give curators a read-only view to QA the §4.3 seeding. In the Review app's Angular product-detail page, add a **"Claims" tab** that reads the product's claims (via `GET /api/claims` or an extension of `routes/integrations.ts`) and lists them grouped by integration, showing `data_object`, direction, and attestation sources. **No editor** — authoring stays in MCP for 1.5.

---

## 5. Promote contract extension — `claims[]` (AECI-291)

Claims travel from the Review app to the main app over the **existing** `POST /api/promote` pipeline (`docs/REVIEW_APP_PROMOTE_API.md`; main-app contract `docs/API_CONTRACTS.md` §6.12). This is the **cross-repo pivot** — land the shared schema early; it unblocks both the Review emit (§5.2) and the main ingest (§6.2). The contract types live in `packages/shared` and are consumed by both repos.

### 5.1 The `claims[]` shape (shared schema)

Add to `packages/shared/src/api/promote.ts`:

- **`PromoteClaimSchema`** — one claim:
  - `dataObject`: string (slug **or** name/alias; resolved find-only — §2),
  - `direction`: `'a_to_b' \| 'b_to_a' \| 'both'`,
  - `attestations`: `PromoteAttestationSchema[]`.
- **`PromoteAttestationSchema`** — `source` (`'aeci' \| 'vendor_a' \| 'vendor_b'`), `asserted` (boolean), optional `introducedAt` / `deprecatedAt` / `note` (dormant fields accepted but unused in 1.5).
- Claims are nested **under each integration** in the payload (claims attach to the mechanism row — §3.1): each `integrations[]` entry gains an optional `claims: PromoteClaim[]`.

**Withhold rule (reuses the existing integration rule).** A claim is only emitted/ingested when its integration is — i.e. when **both** of the integration's endpoints are promoted. A claim whose integration is withheld (other endpoint not promoted yet) is itself withheld, and a claim whose `dataObject` fails find-only resolution lands in the promote response's **`skipped[]` with `kind: "claim"`** (never a 500), consistent with how unresolved integrations/usefulness are reported today.

### 5.2 Review-app emit from `buildPromotePayload` (AECI-296)

In the Review app (`server/services/promote.ts`):

- Define `ClaimPayload` / `AttestationPayload` (matching the §5.1 shared shape).
- In `buildPromotePayload`, assemble `claims[]` under each integration from the `integration_claims` rows (§4.1).
- **Withhold a claim** when its integration's endpoints aren't both promoted — reuse the existing integration-withholding logic rather than duplicating it.

---

## 6. Main-app D1 schema + promote ingest

### 6.1 D1 schema — `taxonomy_data_objects` / `claims` / `attestations` (AECI-293)

Additive migration only (drizzle-kit `pnpm db:generate` → `wrangler d1 migrations apply`; `docs/migrations.md`). **No change to the `integrations` table.** Edit `apps/api/src/db/schema.ts`:

- **`taxonomy_data_objects`** — mirror `taxonomyCategories` exactly (`id` UUID PK, `slug` unique, `name`, `description`, `display_order`, `created_at`, `updated_at`); optionally an `aliases` column (resolver metadata — §2; a §6.1 implementation choice). Seeded from `apps/api/seed/data-objects.sql` (UUIDv5-by-slug, idempotent upsert — §2).
- **`claims`** — `id` PK; `integration_id` → `integrations(id)` `on delete cascade`; `data_object_id` → `taxonomy_data_objects(id)`; `direction` (`a_to_b` / `b_to_a` / `both`, check-constrained); timestamps. **Unique index `(integration_id, data_object_id, direction)`** — the §3.1 identity, and the upsert key for ingest.
- **`attestations`** — `id` PK; `claim_id` → `claims(id)` `on delete cascade`; `source` (`aeci` / `vendor_a` / `vendor_b`, check-constrained); `asserted` (boolean); **dormant** `introduced_at` / `deprecated_at` (the §3.3 version stamps); optional `note`; timestamps.

Index `claims.integration_id` and `claims.data_object_id` for the pair-page read (§8). The `vendor_a`/`vendor_b` sources and the version-stamp columns ship dormant (§1.1).

### 6.2 `POST /api/promote` ingests `claims[]` (AECI-297)

Extend the existing plan-then-batch promote flow (`apps/api/src/routes/promote.ts`):

- **Resolve** each claim's `dataObject` **find-only** by slug (then alias) against the seeded `taxonomy_data_objects`. A miss → `skipped[]` `{ kind: 'claim', … }`; **never a 500** (§2, §5.1).
- **Upsert** each claim by the identity unique index `(integration_id, data_object_id, direction)` (§6.1) — re-promote is idempotent.
- **Replace** the claim's attestations to exactly match the payload (same merge-by-replacement semantics promote already uses for join sets — `REVIEW_APP_PROMOTE_API.md` §5).

> **Superseded in part by AECI-604 (`STAGE_2_ATTESTATIONS_SPEC.md` §3), 2026-08-18.** As
> shipped, AECI-297 implemented the first bullet as a wholesale delete-and-reinsert rather
> than a true upsert, and the second bullet replaced **all** attestations. Both became wrong
> once vendors could author claims and attestations (AECI-301): the cascade through
> `attestations.claim_id ON DELETE CASCADE` destroyed vendor rows, and the re-insert churned
> every claim id. Promote now merges **by origin** — an identity match re-uses the row, only
> `origin = 'aeci'` claims are deleted, only `source = 'aeci'` attestations are replaced, and
> a dropped claim a vendor attests is converted rather than deleted. The atomicity and audit
> bullet below is unchanged. See §3 of the attestations spec and `REVIEW_APP_PROMOTE_API.md`
> §5.2.
- **Audit + atomicity.** Claim/attestation writes go in the **same `db.batch([...])`** as the rest of the promote transaction and emit their `audit_log` row in that batch (the §26.1 invariant of `STAGE_1_SPEC.md`). Edge-cache purge for affected pair pages reuses the existing promote→purge path (`affectedUrlsForPromote`; ADR 0010) extended with the pair URLs (§7).

---

## 7. Pair page (Layer A) — routing, 301, SEO (AECI-294)

The pair page is **Layer A**: it ships first, needs **no** claim data, and delivers the visible consolidation on day one. Build it against the AECI-289 prototype.

### 7.1 Context + routing

- **`defaultIntegrationContext(a, b)`** in `packages/shared` (e.g. `packages/shared/src/integration-context.ts`) — given two product slugs, returns the canonical **context product** for the default pair URL: the **alphabetically-first slug** is the context. Deterministic, pure, shared by SSR and the 301.
- **Nested route:** `/products/:contextSlug/integrations/:otherSlug`. The page resolves the two products, finds **all** integration rows between them (either source/target orientation), and renders one consolidated view. Multiple mechanisms → multiple rows on one page (§3.1), not multiple pages.
- **Per-mechanism direction (Layer A).** Each mechanism card shows a context-relative arrow. In Layer A this is the **integration row's own** stored direction (`one-way`/`bidirectional`) translated to the context product's frame — `one-way` reads `outbound` when the context product is the row's `source` (else `inbound`), `bidirectional` reads `both` — *not* the claim-level `a_to_b`/`b_to_a`/`both` translation of §3.2 (that governs the `data_object` rows in Layer B, §8). Both translations live in the same pure `packages/shared` helper module (`integration-context.ts`: `defaultIntegrationContext` + `integrationDirectionForContext`). The **product-detail page** (`/products/:slug`) — the entry point into the pair pages — lists a product's integrations as a **column-aligned table** (direction · partner · connection; **direction leads the row** so the relationship reads at a glance) rather than a card stack, one row per integration, each row a stretched link to the pair page with the *other* product linked separately. Its **Direction** column is the **effective, claims-aware** context-relative direction, `effectiveContextDirection` (`integration-context.ts`): it prefers the aggregate of the mechanism's `data_object` claim directions — the richer signal the pair page surfaces, where any `both` (or an opposing `a_to_b`+`b_to_a` pair) reads `both` — and falls back to the row's own stored `one-way`/`bidirectional`, both framed to this product; `null` (em-dash) only when there is **neither** a claim nor a stored direction. It is **precomputed server-side** and carried on `ProductDetail.integrations_as_*[]` as `context_direction` (the `ProductIntegrationItem` shape — see `API_CONTRACTS.md`), so the table renders it verbatim and can **never contradict** the pair page (which, once a mechanism has claims, shows those claim lanes and hides its own bare Layer-A arrow). **This supersedes** the earlier "Direction = the row's stored `one-way`/`bidirectional`, translated" framing: that promise that the two surfaces couldn't drift did **not** hold when a mechanism's stored `direction` was null while its claims flowed both ways (the reported bug — the table showed "–" while the pair page said "Syncs both ways"). The endpoint (`GET /api/products/:slug/integrations/:otherSlug`) returns `{ context_product, other_product, mechanisms[], sync_headline }`; `context_product`/`other_product` hydrate as `ProductListItem`, and `sync_headline` is `{ total: 0, confirmed: 0 }` until claims land (§8). An empty pair (both products exist, no integration between them) is a **200** with `mechanisms: []`; the page renders but is `noindex`.
- **Row order on the product-detail table: alphabetical by partner name** (2026-08-24). The `integrations_as_source` / `integrations_as_target` buckets **interleave** into one alphabetized list rather than concatenating — the split is invisible to the reader (every row shows `context_direction`, never its bucket), so concatenating would surface a distinction they cannot see as an unexplained break in the alphabet. Ties (one partner reachable by more than one mechanism) fall back to the integration name, then `id`, so the order is **total** and cannot reshuffle between renders. Before this the list carried **no** ordering at all — neither the `sourceIntegrations` / `targetIntegrations` read configs nor the client sorted — so rows arrived in D1 row order (effectively promote order) and the 20-row `@defer` cut fell at an arbitrary point. The sort lives in `product-detail.ts`, not SQL: those relations can only `ORDER BY` columns of `integrations` itself (the partner name is on the joined product), and ordering each bucket separately still would not interleave them. Contrast the sibling powered-hub section, which has always sorted (§12.3).

### 7.2 301 consolidation from the legacy route

- `/integrations/:id` (the Stage 1 §4.4 page) **301-redirects** to the pair URL for that integration's two products, using `defaultIntegrationContext` to pick the context slug. The redirect is permanent and preserves link equity (the SEO follow-through in §9 ensures internal links and Algolia records resolve through it rather than 404).

### 7.3 SEO

> **Superseded in part by §11 (Addendum A, 2026-07-08).** The single-canonical rule below was the shipped Layer-A behaviour and remains accurate until AECI-340 lands; from then on, **pairs with ≥1 mechanism carry a self-referential canonical on each orientation** (two indexable URLs per real pair, each direction-framed). Empty pairs are unchanged (render + `noindex`). See §11.2 for the replacement contract and §11.1 for why the alphabetical default survives everywhere else.

- **Canonical** uses the serving origin (ADR 0011) — the default-context pair URL is the canonical; the non-default orientation (viewing from the other product) is a secondary entry that canonicalises to the default. Avoid two indexable URLs for one pair. *(Superseded by §11.2 for pairs with mechanisms — see the note above.)*
- JSON-LD and per-pair meta describe the product pair. *(Per-pair meta shipped with the page in 1.5. **JSON-LD did not** — Phase 2 §9.2 had deferred integration structured data to Stage 2, so this line described an intent rather than the build for as long as the page has existed. ✅ **Closed 2026-08-20 by AECI-518**: a `schema.org/WebPage` whose `about` names both endpoint products, plus a `BreadcrumbList` mirroring the visible trail, emitted only when the page is indexable. Contract: `STAGE_2_SPEC.md` §8.7.)*
- **Cache tags** per `CACHE_STRATEGY.md` — tag the pair page by both product slugs so a promote touching either product (or its claims) purges it (§6.2).

---

## 8. Claim rendering (Layer B) — the data-flow section (AECI-300)

**Layer B** renders claims on the pair page. Build against the AECI-289 prototype; it is *the* integration point of the project.

- **`computeAgreement`** — `packages/shared/src/agreement.ts` (pure; vendor-vs-vendor; AECi excluded → never `conflict` — §3.4), unit-tested against synthetic vendor attestations so the Stage 2 branches are proven now.
- **Data-flow section.** For the pair, list each claim as a **`data_object` + direction** row, with the direction shown **context-relative** to the page's context product (`outbound` / `inbound` / `both` — §3.2). Group by integration (mechanism) so a pair connected by two connectors reads clearly.
- **"Unverified" pills.** Every claim shows an **"Unverified"** state in 1.5 (§3.4). The pill styling and copy must read as *"not yet vendor-confirmed"*, not as a warning/defect. *(AECI-605 added the other three states to the same `AgreementBadge`; their tone and copy are specified in `STAGE_2_ATTESTATIONS_SPEC.md` §4.3/§4.5. `unverified` is unchanged and still the only 1.5-reachable one.)*
- **Sync headline.** Lead with the `confirmed / total` headline (§3.5) — in 1.5, `confirmed = 0`, so it communicates breadth honestly.
- API: a pair-page read (extend the integrations read path / a `GET /api/claims` for a pair) returns claims with context-relative direction already translated (§3.2) and the computed agreement state — the browser does not re-derive identity.
- **Basic / Detailed disclosure toggle.** The consolidated page carries a lot of per-mechanism detail; a segmented **Basic / Detailed** control in the header lets readers collapse it. **Detailed** (the default) is the full page above. **Basic** ("Overview") keeps the rail, the sync headline, and each mechanism's kind/name + description + external links, and hides the granular data transfers — the Layer-B `data_object` claim lanes **and** the standalone Layer-A direction arrow. State is a **content-affecting URL param** `?view=basic|detailed` (absent ⇒ `detailed`), so the page stays deep-linkable, SSR-correct, and visitor-state-neutral; it is **added to the pair route's `cacheKeyParams`** (`CACHE_STRATEGY.md` §4a), mirroring `/products ?view=table` (AECI-190). The default (param-absent) URL renders the full claim set, so the crawler-indexed page and the canonical are unaffected. The toggle is suppressed when no mechanism has a claim lane or a direction arrow (nothing to collapse).
  - **Remembered default (cookie).** The reader's last explicit choice is persisted in a client-only cookie (`aeci_pair_view`, 1-year) so it becomes the default on the next pair-page visit. **Cache-neutrality is non-negotiable:** the cookie is written only on a toggle click and read only **post-hydration** (`afterNextRender`, browser-only), so SSR never reads it and it is deliberately **not** in `VISITOR_STATE_COOKIES`. The `?view=` URL param stays the source of truth — an explicit param always wins (deep-link + cache-key fork); the cookie only supplies the default when the URL carries no `?view=`, reconciled in the browser after hydration (same pattern as the analytics-consent banner). See `CACHE_STRATEGY.md` §6.1.

---

## 9. Search / SEO / Algolia follow-through (AECI-298)

Follow-through after the pair page lands.

- **Defer per-pair Algolia records.** The `/search` integrations tab is already hidden (`STAGE_1_SPEC.md` §7.5). Stage 1.5 does **not** add a per-pair search record; document the deferral in `SEARCH_RANKING.md` and record the **future `{prefix}_pairs` record shape** there for Stage 2. (The existing per-integration index continues to be built/maintained by the sync; it is simply not surfaced.)
- **No dead `/integrations/:id` links.** Ensure the still-built per-integration Algolia records and any internal links resolve **through the §7.2 301** to the pair page, never to a dead route. Audit internal link generation and the sitemap so they emit pair URLs (or 301-safe legacy URLs), not orphaned integration URLs.
- **Sitemap.** Pair pages are the canonical integration surface; reflect them in the sitemap per the existing generator, dropping standalone `/integrations/:id` entries in favour of (canonical) pair URLs. *(Extended by §11.2: from AECI-340 the sitemap emits **both** orientations per real pair; §11.4 later adds scored "meaningful no" pairs.)*

---

## 10. Out of scope / Stage 2 carve-outs

Recorded so the boundary is explicit (see §1.1). These were **placeholders** when 1.5 shipped; three of them have now **shipped** under the AECI-514 epic, specified in **`docs/STAGE_2_ATTESTATIONS_SPEC.md`** (kickoff 2026-08-14, swept closed by AECI-608 2026-08-18):

- **AECI-301** — vendor attestation authoring (the portal seam that makes `vendor_a`/`vendor_b` attestations real). ✅ **Shipped** (`STAGE_2_ATTESTATIONS_SPEC.md` §5 + §5.4 as-built): four `/api/vendor/*` endpoints, authority derived from `product_vendors` ownership and never from the request. This is what makes the dormant sources real — every attestation in D1 before it was `source='aeci'`.
- **AECI-302** — conflict UI + notification pipeline (activates the red/`conflict` branch of `computeAgreement`). ✅ **Shipped** (§4 surfacing + §7 pipeline, §7.5 as-built): email-only (Resend), four cron-driven detectors deduped through an `audit_log` ledger rather than a notifications table. *("Email-only" was the launch shape pending the then-open real-time transport question, which **resolved 2026-08-19** — `STAGE_2_SPEC.md` §8.6 / ADR 0023 / `docs/STAGE_2_REALTIME_SPEC.md`, the AECI-516 epic. The answer adds **no second channel**: the portal polls a per-vendor freshness cursor and re-reads this same `audit_log`-backed endpoint, surfacing new rows as a session-scoped count. **Email stays primary**, and nothing AECI-302 shipped changes.)* **Four detectors** (`silent-counterparty`, `open-conflict`, `stale-version`, `aeci-denied`); the `cross-grain` detector `STAGE_2_SPEC.md` §2.4 also listed was **dropped at build** (§7.1 / §11) because its only proposed definition described legitimate data — two mechanisms genuinely can move the same `data_object` in opposite directions.
- **AECI-303** — version-diff timeline. ✅ **Shipped** (`STAGE_2_ATTESTATIONS_SPEC.md` §9 + §9.4 as-built): over the `product_versions` FKs from §8, not the dormant `introduced_at`/`deprecated_at` dates, which could not express "source-version × target-version". Also fixed a pre-existing TransferState orientation bug on the pair resolver that §11.2 (AECI-340) would have surfaced.
- **AECI-304** — paywalled integration depth. Stays under the Paid Tiers epic (AECI-515); AECI-514 ships the entitlement **seam** only (§9.3).

The Stage 1.5 schema and contract are forward-compatible with all four in the sense that matters — the dormant `vendor_a`/`vendor_b` sources and the computed-not-stored agreement need no change.

> **Two corrections from the AECI-514 kickoff**, recorded here because they touch §3's definitions:
>
> 1. **`introduced_at`/`deprecated_at` are version *stamps*, per §3.3 — not attestation retirement.** ✅ **Resolved by AECI-603** (2026-08-14; migration `0016`). As shipped in 1.5, `attestations_active_idx` was partial on `deprecated_at IS NULL` with a comment describing it as retirement. §3.3's definition won (AECI-303 depends on it): supersession got its own `retracted_at` column and the index predicate moved onto it, with the shared `liveAttestationsWhere` (`apps/api/src/lib/drizzle-helpers.ts`) as the one definition every read applies. *(AECI-608 found one read that had kept the old predicate — the admin panel's claim-coverage count — and corrected it. Nothing reads `deprecated_at` as a gate now.)*
> 2. **`computeAgreement` needs a `single_source` state.** ✅ **Resolved by AECI-605** (2026-08-14; `STAGE_2_ATTESTATIONS_SPEC.md` §4.5). As originally shipped (§3.4), a *single* vendor affirming with the counterparty silent resolved to `confirmed`. That branch was unreachable in 1.5, so the gap was latent — but it would have rendered one-sided assertion as agreement, which `STAGE_2_SPEC.md` §8.1(4) forbids. `confirmed` is now narrowed to **two distinct vendor identities** and §3.4 above reflects the shipped rule.
>
> Also: "no migration is required to light them up" was **too strong**. It holds for the agreement engine and the attestation sources; it does not hold for vendor-created claims or for real per-product version selectors, which need a version entity that §6.1 never defined. AECI-514 shipped **three** additive migrations (`STAGE_2_ATTESTATIONS_SPEC.md` §1.2): `0016` claim provenance + attestation authority, `0017` the product-version model, and `0018` the maintenance marker's `last_reviewed_at` / `maintained_by` (AECI-616, scoped in after kickoff).

---

## 11. Addendum A — Search-intent pair indexing (AECI-339, 2026-07-08)

**Status:** Approved — post-launch growth play (Linear project *"Pair-Page Search Intent (pSEO)"*). **Supersedes** the single-alphabetical-canonical rule of §7.3 (for pairs with mechanisms) and **extends** the §9 sitemap contract. Everything else in §7–§9 stands.

**Goal.** Make AECi the search result for *"does [Tool A] integrate with [Tool B]"* — in **both directions** of the question and for **both "yes" and "no"** answers — without triggering Google's thin-content / duplicate-content systems on a young domain.

**Why the orientation matters.** A pair's two URL orientations answer two different questions: *"I own Revit — does Bluebeam fit us?"* is not the question the Bluebeam owner is asking in reverse. The existence answer and mechanism list are symmetric; the **framing, context-relative direction, and (future) suggestions are not**. §7.3's alphabetical canonical resolved that asymmetry by ignoring it — the searcher of the non-alphabetical direction was served a page framed for the other side. This addendum resolves it by **indexing both orientations**, gated on genuinely differentiated content.

### 11.1 Decision record

1. **Orientation is respected in search.** For pairs with **≥1 mechanism**, both orientations become independently indexable, each with a **self-referential canonical**. (Supersedes §7.3's "avoid two indexable URLs for one pair".)
2. **Dual indexing is gated on differentiated content.** The direction-framed `<title>`/H1/intro (§11.2) ships in the **same change** as the canonical split. Two near-mirror pages get folded by Google as duplicates ("Google chose different canonical than user"), forfeiting control of which orientation survives — the worst outcome.
3. **No demand-chosen canonical.** `defaultIntegrationContext` (alphabetical, `packages/shared/src/integration-context.ts`) survives as the **default orientation only**: orientation-neutral link builders (home tiles, search cards, integration cards), the §7.2 legacy 301 target, the `pair:{min}__{max}` cache tag, and sitemap dedupe keys. Its purity is load-bearing — client-side link builders construct pair URLs from two slugs alone and have no demand data; a demand-driven canonical would also churn the index whenever demand shifts. Rejected.
4. **"No" pages are tiered, never blanket-indexed.** Every combination keeps rendering for humans (§7.1's empty-pair 200 stands). Only **"meaningful no"** pairs clearing the §11.4 scoring bar are promoted to indexable, and only carrying unique data-derived content. The combinatorial long tail (~990 pairs at today's 45 products; six figures at catalog scale) stays `noindex` **permanently**. This is the defence against a site-wide Helpful-Content penalty.
5. **Google Search Console is the demand signal.** Pair-level, per-direction demand exists nowhere else — the review app's `compute_product_search_demand` is per-product and is a tie-breaker input only. GSC gates the §11.2 flip (folding/cannibalization check) and drives §11.4 tier promotion.
6. **No referrer/cookie-based reframing.** One URL renders one document. Cached SSR routes are visitor-state-neutral (hard Stage-1 constraint), and per-visitor reframing drifts toward cloaking.

### 11.2 Dual-orientation indexing for real pairs (AECI-340)

Scope — must ship as one change:

- **Direction-framed meta + hero per orientation.** `<title>` / H1 / meta description framed from the context product (not the current near-symmetric "{Context} and {Other} integrations"), plus a short **data-derived intro block**: mechanism count, kinds, context-relative sync summary (from `sync_headline` + claim lanes). Enough unique per-orientation prose that the two pages do not read as mirrors.
- **Canonical:** self-referential on each orientation **iff `mechanisms.length > 0`**; empty pairs keep `noindex` (canonical moot).
- **Sitemap:** both orientations per real pair (~90 pairs → ~180 URLs today — trivially within limits).
- **Unchanged:** alphabetical default orientation everywhere per §11.1(3); empty-pair behaviour; orientation-independent cache tags (a `pair:{min}__{max}` purge already hits both cached URLs).
- **Reversible:** rollback = restore the cross-canonicals + single sitemap entry.

### 11.3 Context-specific suggestions module (AECI-341)

*"Other tools that connect to {context product}"* — ranked **purely algorithmically** from taxonomy overlap (category/audience/phase) + integration presence. **No pay-for-placement, ever.** Rendered on the pair page in both yes and no states, framed from the context product — the suggestion set genuinely differs by which tool the reader owns, making it the strongest per-orientation differentiator (§11.1(2)) and the content backbone of §11.4. API shape lands in `API_CONTRACTS.md`; suggested products join the pair page's embedded cache tags.

### 11.4 Tiered indexing for empty pairs — the "meaningful no" (AECI-342)

The searcher whose true answer is *no* currently gets nothing from us; a good "no" page — honest answer, viable bridge, alternatives — is the trust-first positioning made concrete, and the anti-thin-content moat is that it is **data-derived and unique per pair**.

- **Scoring function** (pure, `packages/shared`): an empty pair qualifies on same category cluster + `data_object` overlap + demonstrated GSC demand (§11.6). Below the bar → stays `noindex`.
- **Content template** for qualifying pairs: existence answer → **data-object bridge** ("X and Y both handle *cost codes* — a CSV/manual bridge is viable", derived from each product's claims on its other integrations) → suggestions (§11.3) → report CTA (§11.5).
- **Indexing flip:** qualifying pairs lose `noindex` and enter the sitemap. Dual-orientation only where scoring shows demand in both directions.
- **Internal links (required):** a "commonly asked about" module on product-detail pages links each product to its qualifying no-pairs — indexable pages must not be sitemap-only orphans.
- **Batched rollout:** first batch tens of pages; widen only on GSC evidence (§11.6). Gated behind the §11.2 GSC gate passing.

### 11.5 Per-pair "report a missing integration" CTA (AECI-343)

*"Know of an integration between {X} and {Y} we're missing?"* — a prefilled entry point into the **existing** Phase 6 requests + moderation pipeline (no new pipeline), carrying both product slugs with distinguishable type/metadata so **per-pair report counts are queryable**. Doubles as a coverage-gap demand signal feeding the §11.4 scoring. Writes obey the §26.1 audit-batch invariant.

### 11.6 Measurement, gates & rollback (AECI-344)

- **Phase-1 gate (4–6 weeks after AECI-340):** GSC Page-indexing report shows no systematic folding of one orientation ("Google chose different canonical than user"), and per-query results show no same-SERP cannibalization between a pair's two orientations. **§11.4's indexing flip does not proceed until this gate passes.** Fail → fix differentiation or roll back per §11.2.
- **Steady-state loop (quarterly):** pull pair-shaped queries per direction from GSC → promote qualifying "no" pairs into §11.4 batches, review dead indexed pairs. The long tail stays `noindex` regardless.

### 11.7 Out of scope

- Indexing every combination (rejected — §11.1(4)).
- Demand-chosen canonical (rejected — §11.1(3)).
- Per-visitor reframing of one URL (rejected — §11.1(6)).
- Per-pair Algolia records (still deferred to Stage 2 per §9).

---

## 12. Addendum B — Connector-role product detail: powered integrations (2026-08-04)

**Status:** Shipped. **Extends** §7.5 / the product-detail contract of §3.1 — §7.1's product-detail
framing is endpoint-only and never specified what a **connector-role** product's own page shows.
Nothing in §3–§11 is superseded.

**The defect this closes.** `/products/agave-erp-sync` — a `product_role: 'connector'` whose entire
purpose is linking PM platforms to ~14 ERPs — rendered **"Integrations (0) — No integrations
recorded yet."** The product-detail pipeline surfaces only edges where the product is a **source or
target endpoint**; edges where it is the **mechanism** (`integrations.powered_by_product_id`) were
unreachable end to end: no inverse Drizzle relation, no API field, no UI section. The page asserted
the exact opposite of the truth about the most-connected class of product in the catalog.

### 12.1 Why the data model did not change

The obvious "industry standard" fix is to model the connector as an **endpoint** — hub-and-spoke
edges (`agave ↔ procore`, `agave ↔ acumatica`) instead of a pair edge carrying a `powered_by`
pointer. Rejected, deliberately:

- **Pair-level truth.** The user-facing question is *"does Procore integrate with Acumatica?"* The
  pair edge answers it directly; hub-spoke edges only imply it transitively and can never express
  what actually syncs **between the two endpoints**.
- **Claims anchoring.** `claims` / `attestations` (§3) hang off the pair edge and are asserted about
  the two endpoints' `data_object` flow. A hub-spoke edge has no coherent claim subject.
- So the model was already right; it was simply **never surfaced**. Addendum B is a read/presentation
  change plus one relation — **no migration**.

### 12.2 Contract: `ProductDetail.integrations_as_connector`

- **Field:** `integrations_as_connector: IntegrationListItem[]` on `ProductDetailSchema`
  (`packages/shared/src/api/products.ts`), beside `integrations_as_source` / `_as_target`.
- **Row shape is the bare `IntegrationListItem`, deliberately** — *not*
  `ProductIntegrationItem`. `context_direction` (§3.2) is meaningless here: the page product is
  **neither endpoint**, so there is no context frame to translate a direction into. The row's
  `direction` remains between `source` and `target`.
- **Hydration:** `products` gains the inverse relation
  `poweredIntegrations: many(integrations, { relationName: 'IntegrationPoweredByProduct' })`
  (`apps/api/src/db/schema.ts`). Relations file only — the FK column and its partial index already
  existed, so **no migration**. `productDetailConfig.with` reuses the plain `integrationListConfig`
  (no claims join — the pair page owns claim depth).
- **The API stays a flat edge list.** Grouping is a presentation concern (§12.3), so no shape churn
  if the presentation changes.
- **Amended by §13.4(2) — the relation has no self-exclusion.** `poweredIntegrations` selects on
  `powered_by_product_id` alone, so an edge whose connector is also one of its own endpoints (the
  review app's Convention A, §13.2a) is hydrated into **both** this bucket and the endpoint
  buckets, and renders twice on that connector's page. Latent while `powered_by` is un-backfilled
  (§12.6); **AECI-706 activates it.** §13.4(2) is the governing rule.

### 12.3 Presentation: the grouped hub view

`apps/web/src/app/products/product-powered-hub.ts` (+ the pure heuristic in
`powered-hub-grouping.ts`), rendered from `product-detail.ts` as `id="powered-integrations"`,
between `#integrations` and `#reviews`, with a matching "Integrations it powers" section-nav entry
(label identical to the section heading minus the count).

- **Edges collapse to distinct PAIRS first.** Two products can be joined by several rows —
  different mechanism kinds, or (in live data today) plain duplicates. One pair renders one row.
  Each pair is normalized to the canonical `orderedPairSlugs` orientation (`a` = alphabetically
  -first slug, matching `defaultIntegrationContext`), so the arbitrary stored source/target
  orientation never leaks into the UI. Per pair we keep the distinct `mechanism_kind` set (in enum
  order) and a merged direction; two opposing one-ways merge to a round trip.
- **The hub is decided per PRODUCT, not per edge.** Source/target orientation on a powered edge is
  arbitrary — it records how the row was authored, not a hub/spoke truth — so the hub is derived.
  Deriving it per *edge* (the original heuristic: file each edge under its more frequent endpoint)
  is locally correct and globally incoherent: given `ACC↔QuickBooks` and `QuickBooks↔Roofr`, ACC
  wins the first and QuickBooks wins the second, so **QuickBooks renders as a partner row AND as a
  hub heading in the same section** — it reads as a data error. Deciding once per product makes
  that impossible. Greedy, highest-degree-first, ties on slug (alphabetical): count each product's
  unclaimed pairs while **skipping products already spent as a partner** (that exclusion is what
  enforces the invariant); the winner becomes a hub if it clears **`MIN_PAIRS_FOR_HUB` = 2** and
  claims every unclaimed pair it touches. Groups sort by partner count desc then hub name;
  partners sort by name.
- **Pairs that clear no hub are rendered flat**, in a trailing card, as whole `A → B` rows — rather
  than forced under a one-partner heading (all chrome, no content). When there are no hub cards at
  all, that card is titled "Connections"; below hub cards it is "Other connections".
- **Presentation: cards with rows, not a fragment heading over chips.** The first cut rendered
  "Connects {hub} with" + name-only chips. That heading was a sentence fragment — screen readers
  announced a trailing preposition, and a string split around a list can't hold word order under
  translation — and the chips carried none of the mechanism/direction detail the sibling endpoint
  table shows for the same edges (they also sat at 1.03:1 on `--surface-base`, visually absent).
  Now: one bordered card per hub, header = logo + hub name as a plain **noun-phrase** heading
  (linked to the hub product) + the group size; body = full-width partner rows carrying logo,
  partner name, **hub-relative direction** (`integrationDirectionForContext`, mirrored when the hub
  is endpoint B — the same `→ Outbound / ← Inbound / ⇄ Both` vocabulary the endpoint table frames
  relative to *its* page product), the mechanism badge, and a chevron. Below `md` the direction and
  mechanism columns fold and the mechanism becomes a muted sublabel — the same breakpoint behaviour
  as `ProductIntegrationRow`. One link per row (the pair page), so no stretched-link overlay: the
  partner's own product page is one hop further, from the pair page.
- **A full compatibility-matrix page archetype** (platforms × ERPs grid) was considered and is
  noted as a possible **Stage 2** evolution; the hub view is the Stage 1.5 answer.
- **Render condition:** `product_role !== 'application' || integrations_as_connector.length > 0`.
  Connector/hybrid always show the section (empty state included — "none recorded yet" is
  information, and Agave's own edges are un-backfilled today); an application shows it only when
  it actually powers edges, a data-driven safety net for a mis-roled product.
- **Empty state** mirrors the endpoint one, with connector wording and the same `aecRequestTrigger`
  suggest-a-correction link (`@@products.detail.body.powers.empty`). The **populated** branch
  carries the catalog-scope note of §12.7.
- **Heading: "Integrations it powers (N)"** (`@@products.detail.body.powers.heading`). A noun
  phrase, parallel to the endpoint "Integrations (N)" heading directly above it, because on a
  connector page **both sections can be populated at once** — NetSuite Connector by Appficiency
  carries its own endpoint integration *and* powered edges — so the two headings must be tellable
  apart. The former "Powers these integrations" failed at that: verb-first (breaking the
  `About` / `How teams use it` / `Integrations` / `Reviews` heading grammar), "these" pointed
  forward at nothing, and "powers" is vendor marketing voice rather than the neutral catalog voice
  PRODUCT.md asks for. The pronoun in "it powers" does the disambiguating work "these" was not.
  (Renaming the *sibling* endpoint heading to "Direct integrations (N)" on connector/hybrid pages
  was considered as a matching pair and is **not** adopted — the pronoun carries it alone.)
- **N counts distinct pairs** — i.e. the rows actually rendered — not raw edges and not groups.
  Counting edges made the heading lie: live data carries duplicate rows for one pair (that same
  NetSuite connector: 4 edges, 2 pairs) and several mechanisms between one pair collapse to a
  single row, so a reader counting rows found fewer than the heading promised. `product-detail.ts`
  owns the `groupPoweredIntegrations()` call and passes the result down as `[view]`, so the count
  and the rendered rows are provably the same set.
- **`RoleBadge` in the hero**, beside the "Product" eyebrow. It self-hides for `application`, so
  only connectors/hybrids are flagged. The endpoint "Integrations (0)" section is left as-is — for
  a pure connector that number is factually correct. (Its *populated* branch does gain the §12.7
  scope note.)
- **Pair page (Stage 1 §4.4).** The mechanism card's "Built by {vendor} · Powered by {product}"
  byline is now **linked** (it rendered as plain text), so a via-connector mechanism navigates to
  the connector's own page — the return path into this surface.

### 12.4 Cache-tag composition

- **SSR (resolver, `product-detail.resolver.ts`):** each powered edge contributes
  `integration:{id}` **plus both** endpoint `product:{slug}` tags — this product is the connector,
  so neither endpoint is "self" and both are rendered (hub heading + chip).
- **Promote (`promote-cache-tags.ts`):** `PromoteIntegrationResult` gains optional
  `poweredBySlug`, and the deriver emits `product:{poweredBySlug}`. Without it, a promote touching
  an Agave-powered edge left `/products/agave-erp-sync` stale until TTL — the connector is neither
  endpoint, so no other rule reached it. **Bounded gap:** a re-pointed powered product purges only
  the new connector (the response carries the post-update slug), same shape as the existing
  endpoint-move gap.

### 12.5 Open decision — count semantics

`integration_count` remains **endpoint-only** (`recompute-counts.ts`), so a connector's browse card
still reads "0 integrations" while its page lists ~13, and connectors rank low on a signal they
should dominate. Three options — (A) keep endpoint-only, (B) count powered edges too, (C) a separate
`powered_integration_count` — are recorded with pros/cons in the implementation plan.
**Recommendation: B, as its own follow-up after the data backfill**, so the numbers change once and
the Algolia products reindex (custom ranking + numeric facet buckets + sort replica, see
`docs/SEARCH_RANKING.md`) happens once. `affectedProducts` in `promote.ts` is deliberately
**unchanged** here.

✅ **Resolved by §13.5 (Addendum C, 2026-08-31): option B, scheduled into the AECI-721 migration**
rather than shipped ahead of it, so the numbers move once and the Algolia reindex happens once —
which is what the recommendation above was asking for. Two things this section did not anticipate
are recorded there: B **is** a ranking change (it lifts connectors up `desc(integration_count)` on
both indices), and the count rule is duplicated across **ten** sites that must move in lockstep —
including the Algolia *vendor* count, which is a different rule, and the `metrics_daily` cron,
which is a time series.

### 12.6 Known data state

At time of writing only **5 of 421** prod integrations carry `powered_by_product_id`; all ~13 Agave
edges have it NULL, with "via Agave ERP Sync" living only in free-text `mechanism_name`. The code
path is complete; Agave's hub view fills in when the FK is backfilled in **Airtable + re-promote**
(the durable path — no D1 stopgap). Separately tracked follow-ups: 22 exact-duplicate integration
rows; connector discovery in search/browse (`product_role` on Algolia records, a Connectors facet,
`RoleBadge` on search cards).

**Superseded as a snapshot by §13.9** (2026-08-30/31), which carries the current connector-lane
figures. This paragraph stays as the historical record of what Addendum B shipped against — and the
discovery follow-ups named in it are still open.

### 12.7 Catalog-scope note on both integration lists (2026-08-05)

**Status:** Shipped. Applies to **both** product-detail integration sections, so it also amends the
endpoint-table presentation inherited from §7.5 / Stage 1 §3.1.

**The asymmetry it closes.** An `integrations` row only exists once **both** endpoints are promoted
products (product-driven promotion, `docs/REVIEW_APP_PROMOTE_API.md`), so every list on the page is
bounded by the directory rather than by the vendor's real partner set. The **empty** branch of each
section already hedges that ("Vendor data is curated; if you know of one, suggest a correction");
the **populated** branch did not, and it is the branch that renders an authoritative count in an
`<h2>`. The miss is worst on a connector, whose entire value proposition is breadth:
"Integrations it powers (4)" for a product marketing ~14 ERP connections understates the vendor in
the page's loudest element. That is the mirror image of the defect §12 opened with, and on a
directory that refuses pay-for-placement an understatement is as much a trust failure as an
overstatement.

- **One line per section, on the populated branch only.** `text-xs text-(--text-secondary)`, below
  the list, no callout box, no icon, never repeated per card or per hub.
  - `#integrations` (`@@products.detail.body.integrations.scope`): "Only partners listed on AECi
    appear here. If one is missing, suggest a correction."
  - `#powered-integrations` (`@@products.detail.body.powers.scope`): "Only integrations between
    products listed on AECi appear here. If one is missing, suggest a correction."
- **Both sections carry it, deliberately.** The boundary is identical for the two lists; caveating
  only the powered one would imply the endpoint table is complete.
- **Scope, not apology.** It states the boundary and ends in the same `aecRequestTrigger`
  suggest-a-correction link the empty states use, so the caveat is a contribution loop rather than
  a dead disclaimer. The heading count is deliberately **not** reworded, tooltipped, or asterisked.
- **Not repeated on the empty branch** — "No integrations recorded yet. Vendor data is curated…"
  already says it.
- **`ProductPoweredHub` gains `host: { class: 'block' }`.** A custom element is `display: inline`
  by default, so the section's `space-y-4` margin was landing on an inline box and being dropped.
  Invisible while the hub was the section's last child; the note directly below it made the missing
  16px obvious.
- **Coverage:** `product-detail.component.spec.ts` asserts both notes render on the populated
  branch (each linking the correction drawer) and that neither renders on an empty list. The
  connector page was re-run through the Phase 2 axe (WCAG AA) sweep with both notes present: zero
  violations.

---

## 13. Addendum C — Connector presentation contract (AECI-708, 2026-08-31)

**Status:** Approved — the build contract for AECI-707 / 713 / 715 / 716, none of which is built.
**Extends** §12 (Addendum B) and the endpoint-table presentation inherited from `STAGE_1_SPEC.md`
§7.5 / §3.1. **Amends** §12.2 / §12.3 with the self-exclusion rule of §13.4(2). **Resolves** §12.5's open
count decision. Nothing in §3–§12 is superseded.

**Why this exists.** Addendum B gave a **connector** its own page. This addendum governs the
mirror-image surface — what an **endpoint**'s page says about the connectors that reach it — plus
the role-varied template and the boundary around the reachable tier. The four issues above each
open with *"governed by the Stage 1.5 addendum"* and, until now, pointed at nothing; the recurring
code-review finding on this repo is docs trailing the build, and a contract written after the build
is a description, not a contract.

**Scope boundary — this repo renders, the review app curates.** Connector catalogues, stubs and
stub↔product mappings live in `aec-integrations-review` (`docs/connector-vendors.md` is their
source of truth, and the epic is AECI-695, spanning all three repos). Addendum C governs
**presentation in this repo only**, and names the app-DB contract elements the presentation needs.

**Two of the originating issue's own premises are corrected here rather than transcribed** — the
split key (§13.2a) and the "no ranking change" cross-reference (§13.5). Both corrections are
load-bearing; each is argued where it lands.

### 13.1 The three-tier vocabulary

The spine every other subsection references. It is written down because it existed only in session
notes, and the words were already drifting between issues.

| Tier | What it asserts | Where it lives | Counts as an integration? |
|---|---|---|---|
| **Delivered** | A working integration exists **today**. Two sub-kinds: *accountable-party* — a vendor or SI built it and maintains it — and *via-connector* — an iPaaS ships a listing covering both sides | `integrations`; after AECI-721, also the connector lane's **evidenced pairs** | **Yes — both sub-kinds** |
| **Reachable** | Both sides appear in the same connector's catalogue, so a connector **could** deliver it with configuration and no code. Computed from stub↔product mappings; **never stored as delivered** | derived at read time from `connector_stubs` + `connector_stub_mappings`, gated for publication by `connector_pairs.surface` (AECI-714 — §13.10) | **No, ever** |
| **Buildable** | Both sides expose an API, so somebody **could** write it. True of very nearly every pair in the catalog | nowhere — deliberately not modelled | **No** |

- **Delivered is a tier, not a column.** There is **no `integrations.status`** and no delivered
  flag anywhere in the schema; `recompute-counts.ts` counts with no status predicate at all.
  Membership in `integrations` **is** the delivered assertion. Read "delivered-only" throughout
  this addendum as *"the delivered tier"*, never as a filter to be added — no migration is implied
  or wanted.
- **Buildable is named specifically so it can be refused.** It is the claim connector marketing
  makes, and it is the reason AECI-670 separated capability from delivery. Publishing it would make
  AECi a larger directory and a worse one: an answer true of every pair answers nothing.
- **Reachable is publishable, but only when labelled.** Reach evidence scraped from a published
  spec is *spec-published*, not *exercised* — a schema page proves a connector published a spec,
  not that the connector has ever run for that pair. Every reachable-tier claim therefore renders
  with visible provenance and an "as of" date. **An incomplete coverage list is acceptable; an
  unlabelled one is not.**

### 13.2 The split rule — routing a delivered edge to a lane

Two phases, with the boundary named, because the routing key has a **known expiry** and a doc that
describes only one side of that boundary is stale whichever way the work sequences.

**Phase 1 — today until AECI-721.** Three clauses, applied in order:

- **(a) Self-reference carve-out. An edge whose `powered_by_product_id` equals *either of its own
  endpoints* stays in the DIRECT list.** Review-side **Convention A** (settled 2026-08-27,
  `record-integrity-checks` I10) stores *"product X ships a connector on platform C"* as **one**
  edge — source `X`, target `C`, `powered_by` = `C` — and the self-reference is deliberate, not
  dirt. That is roughly **152 of the 308** `iPaaS` rows (57 Zapier/Make/Workato/Boomi/Celigo, 43
  Aquifer, 52 Kroo). Without this clause each routes into a "Via C" group whose only partner *is*
  C, rendering **"Via Aquifer → Aquifer"**. Half the connector rows, misfiled.
- **(b) Otherwise, the Via lane is `powered_by_product_id IS NOT NULL` OR
  `mechanism_kind = 'iPaaS'`.** The FK leads deliberately. `mechanism_kind` is the dirty column —
  nullable with no default (`apps/api/src/db/schema.ts`), and AECI-712 counts 478 unset-or-`partner`
  rows, 19% of the review catalogue. The FK is the fact; the kind is an annotation.
- **(c) Everything else is direct**, explicitly including an **unset-mechanism edge carrying no
  `powered_by`**. Unset is not a kind (AECI-698); filing it under "Via" would invent an attribution
  the data does not make. An `iPaaS` edge with a null `powered_by` (4 known) groups under an
  unnamed **"Via a connector"** heading — **never invent a connector name**. That group being
  non-empty is a data-integrity signal, not a design state, and should be watched rather than
  styled.

**SETTLED by AECI-721 (2026-08-31): the residue MIGRATES.** The routing key is
`powered_by_product_id IS NOT NULL AND <> source AND <> target`, **regardless of
`mechanism_kind`** — so the ~20 accountable `marketplace-app`-with-`powered_by` rows move into the
evidenced tier alongside the `iPaaS` ones, carrying `built_by_vendor_id`. Read the originating
issue's "`integrations` keeps only accountable-party edges" as *"no connector intermediary"*, not
*"no named builder"*: `connector_evidenced_pairs.built_by_vendor_id` exists on day one precisely so
this residue would not be pre-decided (`DATABASE_SCHEMA.md` §9a.6). **AECI-713's Via lane therefore
composes ONE source, not two.** In production that is 17 of the 19 migrating edges — Agave's 11,
Cherry Bekaert's 2, ClearPlan's 2, Appficiency's 2. The cost accepted with it: those rows lose
`mechanism_kind` (the destination has no such column), and `mechanism_name` carries the label
instead. The paragraph below is retained as the record of what was open.

**The `powered_by` ≠ `iPaaS` residue was recorded here as OPEN, not settled.** The two sets differ
in both directions: ~326 edges carry `powered_by` against 308 marked `iPaaS`. The ~20-row
difference is real and **accountable** — AnyWare Apps' two Ramp↔Sage edges are `marketplace-app`
**with** a `powered_by`, built and maintained by Cherry Bekaert. AECI-721 says both that it
"migrates the ~326 `powered_by` edges" **and** that "`integrations` keeps only accountable-party
edges"; those two clauses disagree about exactly this residue, and this addendum does not get to
settle a question inside another issue's scope. **If the residue stays behind, the Via lane
composes two sources after the migration, not one** — which changes §13.3's sourcing, so AECI-721
must answer it before AECI-713 finalises.

**Phase 2 — after AECI-721.** The lane **is** the source table: direct = `integrations`, via =
evidenced connector pairs. No key, no heuristic, no dirty column — the structure carries what the
predicate used to, **for every edge that could be routed**.

**One correction to this paragraph, from the build.** `mechanism_kind` DOES still contain `iPaaS`.
53 production edges are `iPaaS` with a NULL `powered_by` because their connector is not a promoted
product, `connector_evidenced_pairs.connector_product_id` is NOT NULL, and AECI-700 parks Zapier and
Workato permanently — so they cannot be routed, and they are 53 of the 132 edges
`isConnectorPoweredEdge` gates for AECI-705. Dropping the value would have silently re-opened vendor
attestation prompts on every one. Clause (b) is therefore still reachable, and clause (a) still
matters for the ~60 Convention-A rows that stay. Retiring `iPaaS` is a sequenced follow-up gated on
AECI-730 making the unroutable population observable at promote time.

**A hard prerequisite under both phases: AECI-706**, the prod `powered_by` backfill. Splitting on a
half-populated FK misfiles connector edges as direct, which is worse than today's honest mixed list.

### 13.3 Presentation: the split endpoint Integrations section

Deliberately written **source-agnostically**, so that Phase 2 changes nothing in this subsection.
`#integrations` stays **one** section with one anchor and one section-nav entry; the split is
within it.

- **Order: the direct lane first, then one group per connector.** Connector groups sort by row
  count desc, then connector name. Direct-first because an accountable-party integration is a
  stronger answer to *"does A integrate with B"* than a configurable one — someone is on the hook
  for it.
- **Group heading: "Via {connector}"**, the connector name linking `/products/{connectorSlug}`.
  That link is the return path into Addendum B's hub, mirroring §12.3's linked hub heading in the
  opposite direction. No "Via" copy exists in the app today; the new ids belong beside the
  single-sourced labels in `apps/web/src/app/search/mechanism-labels.ts`, not inline.
- **Row identity is per lane.** The direct lane keeps today's **one row per edge**, unchanged. Via
  groups collapse to **one row per (connector, partner)** — the same pair collapse
  `powered-hub-grouping.ts` already performs, inverted: grouped by the connector the edge names
  rather than by a derived hub. §12.3's reasons for collapsing (duplicate rows, several mechanisms
  between one pair) apply identically.
- **The heading count `N` is the rows actually rendered, across both lanes**, with per-group
  sub-counts that sum to it. This is §12.3's "the count and the rendered rows are provably the same
  set" rule applied to a split section — a reader counting rows must never find fewer than the
  heading promised. It remains the delivered tier only.
- **Reachable pairs are never enumerated here.** They get one summary line (§13.7) and nothing else.
- **Accessibility: one `<table>` per lane**, not group-header rows interleaved into a single
  `<tbody>`. A header row inside a table body has no accessible name relationship to the rows
  beneath it, so a screen-reader user gets the grouping visually and not at all otherwise. Each
  table keeps the existing Direction / Integrates with / Connection columns, the `md` column
  collapse, and the per-row pair-page link.
- **The `@defer (on viewport)` cut applies to the flattened render order**, so it still lands after
  20 visible rows rather than 20 rows into each lane.
- **The §12.7 catalog-scope note renders once per section** on the populated branch — not once per
  group. The boundary it describes is the same for every lane, and repeating it per group would
  turn a scope note into chrome.
- **Empty state unchanged**, and the section-nav label stays `Integrations` — one section, two
  lanes, one anchor, so no link, sitemap or cache-tag churn.

### 13.4 Contract elements the split needs and does not have

Named here because each is a real gap in shipped code, and a build issue that discovers them
mid-flight will make a local decision about a cross-cutting contract.

1. **`ProductIntegrationItem` carries no connector, so the split is not implementable on today's
   payload.** `IntegrationListItemSchema` (`packages/shared/src/api/integrations.ts`) carries
   `mechanism_kind` / `mechanism_name` / `direction` / `source` / `target` and **no `powered_by`**;
   only `IntegrationDetailSchema` and the pair-page read have it. On product detail the FK is
   expressed *implicitly* — by an edge appearing in `integrations_as_connector`, which is the
   **connector's** own page, not the endpoint's. **Contract:** add
   `powered_by_product: ProductLink | null` to **`ProductIntegrationItemSchema`** — the
   product-detail embed — and **not** to the bare list item, which `/api/integrations` and the home
   rail do not need. Hydration: add `poweredByProduct: { columns: productLinkColumns }` to
   `productDetailIntegrationConfig.with` (`apps/api/src/lib/drizzle-helpers.ts`), which today reuses
   `integrationListConfig` and omits it. `API_CONTRACTS.md` moves in the same PR. Still no
   migration — the column and its partial index have existed since `0000_init`.
2. **Self-exclusion — a latent double-render that AECI-706 is about to switch on.** This amends
   §12.2 / §12.3. `poweredIntegrations` (`apps/api/src/db/schema.ts`) is a plain `many(...)` with
   **no `where`**: it selects on `powered_by_product_id` alone. A Convention-A edge (§13.2a) has the
   connector as **both** an endpoint and the `powered_by` target, so on that connector's page it
   lands in `sourceIntegrations`/`targetIntegrations` **and** in `poweredIntegrations` — rendering
   **twice**, once in `#integrations` and once in `#powered-integrations`. Production is blind to
   this today only because `powered_by` is un-backfilled (§12.6: 5 of 421 rows). **AECI-706 turns it
   on**, and 706 lands *before* AECI-721 removes the class — Aquifer's 43 and Kroo's 52 duplicate on
   the day the backfill ships. **Rule: the powered section excludes edges where the page product is
   also an endpoint.** Those edges belong to the endpoint lane, where §13.2(a) already keeps them
   direct. Stated in the spec rather than in a build issue because it governs a surface that is
   already live.
3. **Cache-tag composition — the connector becomes a rendered entity on the endpoint's page.**
   `product-detail.resolver.ts` pushes `integration:{id}` plus the partner's `product:{slug}` for
   endpoint edges. A linked "Via {connector}" heading renders the connector, so it must push
   `product:{connectorSlug}` too — otherwise editing a connector leaves every endpoint page naming
   it stale until TTL. This is `CACHE_STRATEGY.md` §3's embedded-entity rule applied, not a new
   rule, and it is §12.4's first bullet pointing the other way.
4. **No promote-deriver change is needed.** `promote-cache-tags.ts` already emits
   `product:{poweredBySlug}` (§12.4), which covers the reverse purge.

### 13.5 Count invariants

- **The section count** is §13.3's: rows rendered across both lanes, delivered tier only.
- **`integration_count` semantics do not change — and that is a requirement, not an observation.**
  It is endpoint-only and entirely unfiltered (`apps/api/src/lib/recompute-counts.ts`: "integrations
  where the product is source OR target"), so a delivered-via-connector edge **already counts for
  its two endpoints today** and must keep counting after the split and after the migration. Stated
  as the invariant that survives both: **`integration_count` counts delivered edges regardless of
  which table holds them.**
- **§12.5 is resolved: option B**, counting powered edges toward the **connector's own** count, is
  adopted — **and scheduled into the AECI-721 migration** rather than shipped before it, so the
  numbers move once and the Algolia products reindex happens once, which is exactly what §12.5's
  recommendation asked for. Post-migration the expression becomes AECI-713's recorded rule:
  headline = direct + evidenced-connector.
  - **Shipped 2026-08-31.** The expression is `count(integrations WHERE src=p OR tgt=p) +
    count(evidenced_pairs WHERE a=p OR b=p OR connector=p)`; the third disjunct IS option B. The
    `affectedProducts` comment in `apps/api/src/routes/promote.ts` no longer cites it as open, and
    the connector joins `affectedProducts` on the routing branch, where the row it counts is
    written. Prod effect: Agave ERP Sync 0 → 12, ClearSync 0 → 2, Be.Smart 0 → 1, NetSuite
    Connector 1 → 3, AnyWare 1 → 3. Endpoint counts are unchanged by construction.
  - **Evidenced only, never derived.** Only the delivered tier reaches a count. MindCloud's
    catalogue alone is ~3,411 stubs, and the `integration_count` facet buckets
    (`0 / 1–10 / 11–50 / 51+`) were calibrated against a catalogue topping out near 52 — letting
    derived pairs into the count would not so much shift the numbers as destroy the scale.
- **Correction to this addendum's originating issue: §12.5-B *is* a ranking change.** AECI-708
  cross-referenced `SEARCH_RANKING.md` as "no ranking change". That is true of Addendum C in
  isolation — §4's `MECHANISM_RANK` / `mechanism_rank` are untouched here — and **false of option
  B**, which lifts connectors up `desc(integration_count)` on **both** the products and vendors
  indices, in a numeric facet and in two sort replicas. The `SEARCH_RANKING.md` edit belongs to
  AECI-721, alongside AECI-698's enum revision. Ranking stays purely algorithmic throughout — this
  is a change in a signal's inputs, never in who can buy position.
  - **Landed 2026-08-31, with one clause of this bullet overturned by the data.** `iPaaS` does NOT
    leave §4's rank table. AECI-721 adds `integrator` (tied with the `partner` it replaces, so the
    upstream re-key is rank-neutral) and pins connector-evidenced pairs to a fixed rank of **4**
    rather than letting a structurally-absent kind fall through to the unknown-kind `0`. Removing
    `iPaaS` is deferred: 53 production edges are `iPaaS` with a NULL `powered_by` because their
    connector is unpromoted and AECI-700 parks Zapier and Workato permanently, they cannot migrate
    (`connector_product_id` is NOT NULL), and they are 53 of the 132 edges `isConnectorPoweredEdge`
    gates — so nulling their kind would silently re-open AECI-705's attestation prompts on every
    one. `SEARCH_RANKING.md` §4.1–§4.3 records all three decisions.
- **The lockstep set is FOURTEEN sites** (was ten — corrected by AECI-721 PR-A, which found four
  more while implementing). Migrating powered edges out of `integrations` without moving every one
  of them silently drops the edges and re-ranks the catalog as a side effect of a data migration.
  Enumerated so it cannot be half-done. The rule each site expresses, post-AECI-721:

  ```
  product: count(integrations WHERE src=p OR tgt=p)
         + count(evidenced_pairs WHERE a=p OR b=p OR connector=p)   ← §12.5 option B
  vendor:  count(integrations WHERE built_by=v)
         + count(evidenced_pairs WHERE built_by=v)
  total:   count(integrations) + count(evidenced_pairs)
  ```

  1. `apps/api/src/lib/recompute-counts.ts` — `computeExpected`, the canonical definition.
  2. and 3. **the same rule as raw SQL, twice**, in `apps/api/scripts/reconcile-product-counts.ts`
     (`DRIFT_QUERY` and `RECOMPUTE_SQL`). Miss these and the daily `reconcile-counts.yml` cron
     reports 100% drift every morning and `--fix` silently reverts the new rule.
  4. `apps/datatool/src/prune-integrations.ts` — the prune-path repair copy.
  5. `apps/api/src/lib/algolia-transforms.ts` — the product record (reads the denormalized column).
  6. **The Algolia *vendor* count is a different rule** — a correlated subquery on
     `built_by_vendor_id` (`algolia-transforms.ts` and, independently,
     `apps/datatool/src/algolia-reindex.ts`). It is not downstream of the product column, so it
     drops every migrated edge on its own and connector vendors' counts collapse. Named nowhere
     before this addendum.
  7. `apps/datatool/src/algolia-reindex.ts` — datatool's independent copy of the *product* rule.
  8. Four expressions in `apps/api/src/lib/home-stats.ts`: the total, the added-in-30-days figure,
     most-active-category, and the recent-integrations rail.
  9. `apps/api/src/lib/admin-catalog.ts` — `integrations_total` / `_with_claims` /
     `_without_claims` on the operator console. Named nowhere before this addendum.
  10. **`apps/api/src/lib/metrics-snapshot.ts` — `catalog.integrations_total`**, written daily into
      `metrics_daily` by cron (AECI-581). This one is a **time series**: an unadjusted migration
      writes a permanent, unexplained step-change into recorded history, and it is the only site on
      this list where the damage cannot be repaired after the fact.

      **Resolved: no backfill is needed, and that is the point of doing it this way.** Summing both
      tables makes the series *continuous across the migration* — the migration moves rows between
      two tables that are already added together and creates none, so there is no step to annotate
      and no recorded history to rewrite. That is how AECI-721 discharges this item's "backfill or
      annotate deliberately"; the alternative, editing `metrics_daily` after the fact, would have
      been the less honest of the two. Recorded in `DATABASE_SCHEMA.md` §9.3.

  **Four further sites, found during AECI-721 PR-A and unnamed above** — the enumeration was
  written from the `integration_count` name, and these express the rule without using it:

  11. `apps/api/src/routes/admin-overview.ts` — a **module-local `catalogTotals`** that shadows the
      exported one in `admin-catalog.ts`. Two independent implementations of the same operator
      number; if only one moved, the overview and the catalog screen would disagree with each other,
      which is worse than either being wrong alone.
  12. `apps/api/src/lib/admin-catalog.ts` — the **exported `catalogTotals`**, keyed `integrations`
      rather than `integrations_total`. That naming is exactly why item 9 missed it.
  13. `apps/api/src/lib/algolia-drift-deps.ts` — the Algolia↔D1 drift guard's integration count.
      **The one with teeth**: a live alarm surface, so it must ship in the ADDITIVE PR, not with the
      migration — otherwise it reports drift for the whole window between the migration and the
      reindex, drift that is an artifact of its own single-table definition. Its membership rule
      must stay byte-for-byte the rule `algolia-sync.ts` applies, because any divergence between
      those two *is* the alarm.
  14. Three more copies of the **vendor `built_by_vendor_id` rule outside Algolia** —
      `apps/api/src/lib/drizzle-helpers.ts` (`vendorListConfig`, feeding the public and admin vendor
      lists) and `apps/api/src/routes/admin-vendors.ts` (vendor detail). Item 6 names only the two
      Algolia copies; there are five, and connector vendors' counts collapse on all five.

  Plus two things that are not `integration_count` but move with it: the rendered section heading
  (computed from the payload, not the stored column — §13.3), and the Algolia settings themselves —
  custom ranking on both indices, the numeric facet, both sort replicas
  (`packages/shared/src/algolia.ts`, `docs/SEARCH_RANKING.md` §5a).

  **The lockstep is regression-tested, not just enumerated.** `apps/api/src/lib/count-lockstep.spec.ts`
  seeds `connector_evidenced_pairs` and leaves `integrations` untouched, then asserts each
  expression returns direct + evidenced. That shape is deliberate: `stage-2` is not the production
  line, so the two AECI-721 PRs reach prod D1 **together** at the `stage-2` → `main` promote, and at
  that boundary count-neutrality stops being a deployment-order property and becomes a code
  property. The spec is the artifact that survives the promote.
- **Reachable never counts** — not in the heading, not in `integration_count`, not in a facet, not
  in the home stats. Publishing the tail buries the products with real integrations underneath it.

### 13.6 Role-varied product detail for `connector` / `hybrid` (AECI-707)

- **Section order — `connector` only.** Today the body renders
  `about → how-teams-use-it → integrations → powered-integrations → reviews`. On
  `product_role = 'connector'` the two integration sections **swap**, so "Integrations it powers"
  leads: for a pure connector the endpoint table is legitimately sparse and the powered set is the
  page's entire subject. **`hybrid` keeps today's order**, and the catalog settles that more
  cleanly than `STAGE_2_SPEC.md` §8.8's hybrid-counts-as-endpoint analogy does: there are exactly **two** hybrids
  catalog-wide — AnyWare Apps (2 endpoint edges, both `native` first-party apps; 2 powered) and
  Datagrid (3 endpoint, 0 powered). Swapping hybrids too would demote a surface that is half of
  AnyWare's real content and unambiguously its own product. A data-driven "swap when powered
  exceeds endpoint" rule was also rejected: at 2 vs 2 the only page it exists for does not trip it,
  while the cost — page order changing under readers as data moves — applies catalog-wide.
  `application` is unchanged. **Section-nav follows render order and no anchor ids change**, so
  there is no link, sitemap or cache-tag churn.
- **Hero.** `RoleBadge` is already there (§12.3). Add one data-derived line — "Connects N products
  in the AECi catalog" — where `N` counts **distinct endpoint products**, not pairs, and excludes
  self-references per §13.4(2). It renders only when `N > 0` and carries §12.7's catalog-scope
  framing rather than implying the vendor's full partner set.
- **Meta description variant.** `product-detail.resolver.ts` sets one shape for every role. The
  connector variant targets *"«connector» for construction"*-class queries. **Pair-shaped queries
  stay on pair pages**, which Addendum A §11.2 owns — stated as a boundary so the two addenda do
  not compete for the same SERP with two different pages.
- **Explicitly not in scope: a `/connectors/:slug` namespace or a separate entity.** Connectors stay
  products. Dual reviews, claims, vendor linkage and Algolia records all hang off `products`, and
  forking the entity breaks all four. §12.3's compatibility-matrix archetype remains a possible
  later evolution, and §12.6's discovery follow-up remains open — **`product_role` is on no Algolia
  record today**, so a Connectors facet and a `RoleBadge` on search cards are still unbuilt.

### 13.7 The reachable-lane boundary (AECI-715 / AECI-716)

Presentation only; the data lands in AECI-714 and the curation in the review app.

- **One line on the endpoint page**, below the Integrations section: *"N more pairs reachable via
  connectors"*, linking **our** filtered view. Never a list, never a table row, never part of the
  §13.3 heading count.
- **Never link out to a connector's own generated pair pages.** MindCloud publishes 104,186 of them;
  they carry no attribution, no comparison and nothing the reader cannot get better from us.
- **Which reachable pairs publish** — the selection rule AECI-716 asks this addendum to own. A pair
  publishes only when all four hold: **(a)** both products are in the AECi catalog; **(b)** the pair
  is undelivered — a delivered edge takes the page over the moment one ships; **(c)** it clears
  Addendum A §11.4's "meaningful no" bar, deliberately reusing that scoring rather than standing up
  a second parallel bar for the same thin-content risk; and **(d)** it carries §13.1's provenance
  and "as of" label.
- **Comparison requires at least two connectors.** A one-column comparison is an advertisement, and
  publishing one would undercut the no-pay-for-placement posture on the exact surface where a
  connector has the most to gain. This is why AECI-716 blocks on the second catalogue (AECI-701).
- **The coverage surface (AECI-715) is bounded by our catalog, not the connector's marketing
  graph** — expressed as **apps reached, not pairs possible** (linear in the catalog, where the
  pair cross-product is quadratic), and linking into the filtered pair view rather than enumerating.

### 13.8 Cross-references and no-change declarations

Stated explicitly so a reviewer can check them rather than infer them:

- **`DATABASE_SCHEMA.md` — no schema change in this addendum.** §13.4's additions are a Drizzle read
  config plus a Zod field; no DDL, no migration. The AECI-721 migration is governed by AECI-714 and
  rides the `stage-2` migration lane after that set settles (a D1 CHECK change is a destructive
  table recreate). **It landed 2026-08-31** as `0022_powerful_killraven.sql`: the `integrations`
  CHECK gains `integrator`, `claims` gains the polymorphic anchor (§3.1's amendment), and the 19
  production powered edges move. §5a.1, §9.3 and §9a.6 of that document carry the as-built detail.
- **`SEARCH_RANKING.md` — no ranking *rule* change from Addendum C**, with the §12.5-B correction
  recorded in §13.5 rather than the originating issue's blanket claim. §4's rank table changes with
  AECI-698 / AECI-721 — **landed 2026-08-31**: `integrator` added at 1, the connector-evidenced pin
  at 4, `iPaaS` retained (§4.1–§4.3), and §5's `integration_count` tie-break re-scoped to both
  delivered-tier tables.
- **`CACHE_STRATEGY.md`** — §13.4(3) applies its existing §3 embedded-entity rule; no new rule.
- **`API_CONTRACTS.md`** — changes with AECI-713 (the §13.4(1) field), not with this addendum.
- **`REVIEW_APP_PROMOTE_API.md`** — unchanged *by this addendum*; the connector-coverage payload
  extension was AECI-714's, and it **landed 2026-08-31** as §3a of that document. See §13.10.

### 13.9 Known data state (2026-08-30/31)

Dated like §12.6, because every number here moves. Figures are **review-catalogue** (pipeline-side),
which is materially larger than the promoted app DB — the *ratios* are the durable claim:

- **308 of 2,428** integration edges are `mechanism_kind = 'iPaaS'` (12.7%); ~**326** carry
  `powered_by_product_id`. The two sets are not the same set (§13.2).
- ≈**152** of the `iPaaS` rows are Convention-A self-references (57 Zapier/Make/Workato/Boomi/Celigo,
  43 Aquifer, 52 Kroo) — the rows §13.2(a) and §13.4(2) exist for.
- ~**20** accountable `marketplace-app`-with-`powered_by` rows are the open residue of §13.2;
  **4** `iPaaS` rows carry no `powered_by`.
- **86** connector-role products, of which **8 promoted + 2 `on_hold`** are in play; **2** hybrids
  catalog-wide (§13.6); **144** curated reachable pairs (§13.7).

The prod app-DB subset is gated on **AECI-706** (the `powered_by` backfill) and **AECI-700** (the
Zapier/Workato `on_hold` decision — 110 and 44 powered edges respectively ride on parked products).
Until AECI-700 resolves, the "Via" lane reads mostly-Agave; that is expected, not a defect in the
split. This supersedes §12.6's snapshot (5 of 421 prod edges carrying `powered_by`), which stays in
place as the historical record of what Addendum B shipped against.

### 13.10 What AECI-714 landed (2026-08-31)

The data half of this addendum. §13.1 named "derived pairs (AECI-714)" and §13.7 said "the data
lands in AECI-714"; this is what that turned out to be, recorded here so the four unbuilt
presentation issues anchor to something concrete rather than to a promise.

**Six app-DB tables**, migration `apps/api/migrations/0021_overconfident_selene.sql`, documented in
`DATABASE_SCHEMA.md` **§9a**. Five are a field-for-field **projection** of the review app's model
(AECI-719) — `connector_catalogs`, `connector_catalog_surfaces`, `connector_stubs`,
`connector_stub_mappings`, `connector_pairs` — and the sixth, `connector_evidenced_pairs`, is the
delivered tier §13.1's table names, **created empty**.

**AECI-714 created new tables only.** Every change to an existing table stayed AECI-721's: the
`integrations_mechanism_kind_check` enum revision, the powered-edge move, the claims re-home, and
the `integration_count` lockstep sites of §13.5. That split is what kept the destructive D1
recreate to **one** migration, and it is why `0021` is `CREATE TABLE` / `CREATE INDEX` only.

**AECI-721 landed 2026-08-31, in two PRs.** The split is expand→contract (`docs/migrations.md`
§3.2): PR-A is additive and inert — every read surface and all fourteen count sites read the union
of both tables, so PR-B could not move a number — and PR-B is the single destructive migration
`0022_powerful_killraven.sql` plus the promote-path routing that stops the migration undoing
itself. Three things worth carrying forward:

- **`connector_evidenced_pairs` is no longer written by nothing.** `POST /api/promote` routes
  connector-powered edges here. The catalogue sync still does not touch it.
- **`iPaaS` did not leave the mechanism enum**, against this section's own expectation — see
  §13.2's Phase 2 correction. Neither did `partner`. Both retirements are sequenced follow-ups.
- **The lockstep is fourteen sites, not ten** (§13.5), and it is regression-tested rather than
  only enumerated.

**The reachable tier is still not a table**, exactly as §13.1 requires. Reachability derives at
read time from `connector_stubs` + `connector_stub_mappings`. `connector_pairs` is projected not
because reachability needs it but because **publication** does: §13.7 publishes the *curated* set,
and `curated | generated | unknown` is a classification on the vendor's own published pair row
(AECI-677) that exists nowhere in the mapping graph. Without it the only derivable thing is the
auto-generated cross-product this addendum refuses to publish.

**A paged sync**, `POST /api/promote/connector-catalog` (`REVIEW_APP_PROMOTE_API.md` §3a). AECi
holds the **full** mirror — every stub, including the ~3,342 that map to nothing — because the
question the lane answers is *"is this new listing one of ours?"*, because AECI-720's cutoff is
only a lane freeze if AECi's copy is complete, and because those rows **are** AECI-722's triage
queue. One page is one complete ADR 0021 job; there is no atomicity across pages, and every
statement is an idempotent upsert keyed on the review record id.

**Nothing renders it yet, and nothing counts it.** The sync dispatches no Algolia sync, no
IndexNow or Google ping, no home-stats refresh and no cache purge — §13.5 holds unchanged. When
§13.7's summary line ships, `CACHE_STRATEGY.md` §3 rule 4 now names the tag set it will need.

**What is still open.** The publication gate is provenance rather than confidence
(`decided_by <> 'auto-name-match'`), so today's **13 confirmed** stubs are what would publish
against 212 machine proposals — the coverage surface is real but thin until somebody confirms.
And a catalogue whose connector platform is unpromoted cannot land at all (`connector_product_id`
is NOT NULL): Zapier and Workato are `on_hold` review-side, so their pages report in `skipped[]`.
Whether an evidenced pair may name a connector with no `products` row is AECI-721's question, and
it now applies to catalogues too.
