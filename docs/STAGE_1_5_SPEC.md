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
| `data_object` closed vocabulary (§2) | Version-diff timeline using `introduced_at`/`deprecated_at` (AECI-303) |
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
- The unique index `(integration_id, data_object_id, direction)` (§6.1) makes promote ingest an idempotent upsert (§6.2).

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
| `introduced_at` | date \| null | **dormant in 1.5** — version stamp for the Stage 2 timeline (AECI-303). |
| `deprecated_at` | date \| null | **dormant in 1.5** — version stamp. |
| `note` | string \| null | optional provenance/source note. |

`vendor_a` / `vendor_b` and the version stamps are **additive and dormant**: present in schema and contract, written by no 1.5 code path.

### 3.4 Computed agreement — `computeAgreement` and the AECi-never-red rule

Agreement is **computed from the attestation set, never stored** (ADR 0018). A single pure function owns it:

```
computeAgreement(attestations) → AgreementState
```

It lives at **`packages/shared/src/agreement.ts`** (AECI-300) so the API, SSR, and tests share one implementation.

Rules:

- **Only vendor attestations vote.** Agreement is a *vendor-vs-vendor* signal: it asks whether the two vendors of a pair agree about a data flow. **The AECi attestation is excluded from the vote** — it is the baseline/seed, not a party to the disagreement.
- **AECi-never-red.** Because AECi never votes, an AECi-only claim can **never** produce a `conflict` state. The conflict (red) state requires `vendor_a` and `vendor_b` to disagree — impossible until the Stage 2 portal exists.
- **Stage 1.5 reality.** With only an `aeci` attestation present, every claim resolves to an **"Unverified"** state and renders as such (§8). The agreement engine ships fully but, by construction, only ever returns the unverified branch in 1.5.

`AgreementState` is enumerated in `agreement.ts`; the 1.5-reachable value is the unverified one. The conflict/confirmed branches are implemented and unit-tested against synthetic vendor attestations so Stage 2 inherits a proven function.

### 3.5 The `confirmed / total` sync headline

The pair page leads its data-flow section with a headline of the form **"N data objects sync"** plus a verification ratio **`confirmed / total`**:

- **`total`** — the number of distinct claims on the pair (all directions, all mechanisms).
- **`confirmed`** — claims whose computed agreement is vendor-confirmed.

In Stage 1.5 **`confirmed = 0`** for every pair (no vendor attestations), so the headline communicates breadth ("12 data objects sync") with an honest **"Unverified"** posture, never a fake trust signal. The ratio becomes meaningful in Stage 2.

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
- **Audit + atomicity.** Claim/attestation writes go in the **same `db.batch([...])`** as the rest of the promote transaction and emit their `audit_log` row in that batch (the §26.1 invariant of `STAGE_1_SPEC.md`). Edge-cache purge for affected pair pages reuses the existing promote→purge path (`affectedUrlsForPromote`; ADR 0010) extended with the pair URLs (§7).

---

## 7. Pair page (Layer A) — routing, 301, SEO (AECI-294)

The pair page is **Layer A**: it ships first, needs **no** claim data, and delivers the visible consolidation on day one. Build it against the AECI-289 prototype.

### 7.1 Context + routing

- **`defaultIntegrationContext(a, b)`** in `packages/shared` (e.g. `packages/shared/src/integration-context.ts`) — given two product slugs, returns the canonical **context product** for the default pair URL: the **alphabetically-first slug** is the context. Deterministic, pure, shared by SSR and the 301.
- **Nested route:** `/products/:contextSlug/integrations/:otherSlug`. The page resolves the two products, finds **all** integration rows between them (either source/target orientation), and renders one consolidated view. Multiple mechanisms → multiple rows on one page (§3.1), not multiple pages.
- **Per-mechanism direction (Layer A).** Each mechanism card shows a context-relative arrow. In Layer A this is the **integration row's own** stored direction (`one-way`/`bidirectional`) translated to the context product's frame — `one-way` reads `outbound` when the context product is the row's `source` (else `inbound`), `bidirectional` reads `both` — *not* the claim-level `a_to_b`/`b_to_a`/`both` translation of §3.2 (that governs the `data_object` rows in Layer B, §8). Both translations live in the same pure `packages/shared` helper module (`integration-context.ts`: `defaultIntegrationContext` + `integrationDirectionForContext`). The **product-detail page** (`/products/:slug`) — the entry point into the pair pages — lists a product's integrations as a **column-aligned table** (direction · partner · connection; **direction leads the row** so the relationship reads at a glance) rather than a card stack, one row per integration, each row a stretched link to the pair page with the *other* product linked separately. Its **Direction** column is the **effective, claims-aware** context-relative direction, `effectiveContextDirection` (`integration-context.ts`): it prefers the aggregate of the mechanism's `data_object` claim directions — the richer signal the pair page surfaces, where any `both` (or an opposing `a_to_b`+`b_to_a` pair) reads `both` — and falls back to the row's own stored `one-way`/`bidirectional`, both framed to this product; `null` (em-dash) only when there is **neither** a claim nor a stored direction. It is **precomputed server-side** and carried on `ProductDetail.integrations_as_*[]` as `context_direction` (the `ProductIntegrationItem` shape — see `API_CONTRACTS.md`), so the table renders it verbatim and can **never contradict** the pair page (which, once a mechanism has claims, shows those claim lanes and hides its own bare Layer-A arrow). **This supersedes** the earlier "Direction = the row's stored `one-way`/`bidirectional`, translated" framing: that promise that the two surfaces couldn't drift did **not** hold when a mechanism's stored `direction` was null while its claims flowed both ways (the reported bug — the table showed "–" while the pair page said "Syncs both ways"). The endpoint (`GET /api/products/:slug/integrations/:otherSlug`) returns `{ context_product, other_product, mechanisms[], sync_headline }`; `context_product`/`other_product` hydrate as `ProductListItem`, and `sync_headline` is `{ total: 0, confirmed: 0 }` until claims land (§8). An empty pair (both products exist, no integration between them) is a **200** with `mechanisms: []`; the page renders but is `noindex`.

### 7.2 301 consolidation from the legacy route

- `/integrations/:id` (the Stage 1 §4.4 page) **301-redirects** to the pair URL for that integration's two products, using `defaultIntegrationContext` to pick the context slug. The redirect is permanent and preserves link equity (the SEO follow-through in §9 ensures internal links and Algolia records resolve through it rather than 404).

### 7.3 SEO

> **Superseded in part by §11 (Addendum A, 2026-07-08).** The single-canonical rule below was the shipped Layer-A behaviour and remains accurate until AECI-340 lands; from then on, **pairs with ≥1 mechanism carry a self-referential canonical on each orientation** (two indexable URLs per real pair, each direction-framed). Empty pairs are unchanged (render + `noindex`). See §11.2 for the replacement contract and §11.1 for why the alphabetical default survives everywhere else.

- **Canonical** uses the serving origin (ADR 0011) — the default-context pair URL is the canonical; the non-default orientation (viewing from the other product) is a secondary entry that canonicalises to the default. Avoid two indexable URLs for one pair. *(Superseded by §11.2 for pairs with mechanisms — see the note above.)*
- JSON-LD and per-pair meta describe the product pair.
- **Cache tags** per `CACHE_STRATEGY.md` — tag the pair page by both product slugs so a promote touching either product (or its claims) purges it (§6.2).

---

## 8. Claim rendering (Layer B) — the data-flow section (AECI-300)

**Layer B** renders claims on the pair page. Build against the AECI-289 prototype; it is *the* integration point of the project.

- **`computeAgreement`** — `packages/shared/src/agreement.ts` (pure; vendor-vs-vendor; AECi excluded → never `conflict` — §3.4), unit-tested against synthetic vendor attestations so the Stage 2 branches are proven now.
- **Data-flow section.** For the pair, list each claim as a **`data_object` + direction** row, with the direction shown **context-relative** to the page's context product (`outbound` / `inbound` / `both` — §3.2). Group by integration (mechanism) so a pair connected by two connectors reads clearly.
- **"Unverified" pills.** Every claim shows an **"Unverified"** state in 1.5 (§3.4). The pill styling and copy must read as *"not yet vendor-confirmed"*, not as a warning/defect.
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

Recorded so the boundary is explicit (see §1.1). These were **placeholders** when 1.5 shipped; three of them are now **active Stage 2 work** under the AECI-514 epic, specified in **`docs/STAGE_2_ATTESTATIONS_SPEC.md`** (kickoff 2026-08-14):

- **AECI-301** — vendor attestation authoring (the portal seam that makes `vendor_a`/`vendor_b` attestations real). → `STAGE_2_ATTESTATIONS_SPEC.md` §5.
- **AECI-302** — conflict UI + notification pipeline (activates the red/`conflict` branch of `computeAgreement`). → §4 (surfacing) + §7 (notifications).
- **AECI-303** — version-diff timeline using the dormant `introduced_at`/`deprecated_at` stamps. → §8 (version model) + §9 (the diff).
- **AECI-304** — paywalled integration depth. Stays under the Paid Tiers epic (AECI-515); AECI-514 ships the entitlement **seam** only (§9.3).

The Stage 1.5 schema and contract are forward-compatible with all four in the sense that matters — the dormant `vendor_a`/`vendor_b` sources and the computed-not-stored agreement need no change.

> **Two corrections from the AECI-514 kickoff**, recorded here because they touch §3's definitions:
>
> 1. **`introduced_at`/`deprecated_at` are version *stamps*, per §3.3 — not attestation retirement.** The shipped `attestations_active_idx` in `schema.ts` is partial on `deprecated_at IS NULL` with a comment describing it as retirement. §3.3's definition wins (AECI-303 depends on it); supersession moves to a new `retracted_at` column and the index predicate follows it.
> 2. **`computeAgreement` needs a `single_source` state.** As shipped (§3.4), a *single* vendor affirming with the counterparty silent resolves to `confirmed`. That branch is unreachable in 1.5, so the gap was latent — but it would render one-sided assertion as agreement, which `STAGE_2_SPEC.md` §8.1(4) forbids. `confirmed` is narrowed to **two distinct vendor identities**.
>
> Also: "no migration is required to light them up" was **too strong**. It holds for the agreement engine and the attestation sources; it does not hold for vendor-created claims or for real per-product version selectors, which need a version entity that §6.1 never defined. AECI-514 ships two additive migrations (`STAGE_2_ATTESTATIONS_SPEC.md` §1.2).

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
