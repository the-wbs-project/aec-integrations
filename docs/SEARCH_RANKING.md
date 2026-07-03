# AEC Integrations — Search Ranking

**Status:** Active — source of truth for AECi search ranking
**Delegated from:** `STAGE_1_SPEC.md` §7.3 (the spec stub points here for the full ranking spec, tie-breakers, and tuning rules)
**Established by:** Phase 3.3 ([AECI-135](https://linear.app/aec-integrations/issue/AECI-135)); index settings shipped as code in Phase 3.2 ([AECI-137](https://linear.app/aec-integrations/issue/AECI-137))
**Companion docs:** `STAGE_1_SPEC.md` §7, `API_CONTRACTS.md`, `DATABASE_SCHEMA.md`, `CACHE_STRATEGY.md`; implementation in `packages/shared/src/algolia.ts`

---

## 1. Scope & relationship to the code

This document is the canonical narrative for *how AECi ranks search results* and *how that ranking evolves*. It mirrors how `CACHE_STRATEGY.md` lifted Phase 2 Spec §8 into one source of truth: `STAGE_1_SPEC.md` §7.3 is deliberately a stub that delegates the full spec here.

The ranking **configuration** is not prose — it is executable code, and that code is the operative source of truth:

- `packages/shared/src/algolia.ts` — the `INDEX_SETTINGS` constant defines `searchableAttributes`, `attributesForFaceting`, and `customRanking` for all three indexes; `MECHANISM_RANK` / `mechanismRank()` define integration priority; `REPLICA_SORTS` (+ `sortReplicasFor` / `replicaIndexName` / `replicaNamesFor`) defines the per-tab sort replicas (§5a); `applyIndexSettings()` pushes the primary settings + creates/configures the replicas idempotently.
- `packages/shared/src/algolia-records.ts` — the Zod record schemas (`AlgoliaProductRecord`, `AlgoliaVendorRecord`, `AlgoliaIntegrationRecord`) define the fields available to rank on.
- `apps/api/src/lib/algolia-transforms.ts` — denormalizes Drizzle/D1 rows into those record shapes (including the derived `mechanism_rank`, see §4).
- `packages/shared/src/algolia.spec.ts` — asserts the exact settings below, so this doc and the code are co-verified.

`applyIndexSettings()` is invoked by the CI step (`CICD_PLAN.md` §3.2) and the sync pipeline (Phase 3.5/3.6). **A ranking change means editing `INDEX_SETTINGS` (or `MECHANISM_RANK`) and updating this doc in the same PR** — neither prose nor code is allowed to drift from the other.

**Ranking is purely algorithmic.** Per the CLAUDE.md non-negotiable, there is no pay-for-placement: paid vendor tiers (Stage 4+) affect profile richness, never ranking position. No ranking signal in this document may be a function of payment.

---

## 2. The Algolia ranking formula

Each index keeps Algolia's **default ranking formula** — the ordered tie-breaking criteria:

```
typo → geo → words → filters → proximity → attribute → exact → custom
```

We do **not** override the `ranking` setting (the order above). AECi's only customization is the final `custom` step: a per-index `customRanking` list of attributes, applied left-to-right, each `asc(...)` or `desc(...)`. Two records that tie on all of textual relevance (typo…exact) are then ordered by `customRanking`; if they tie there too, Algolia falls back to the index's internal record order (effectively arbitrary — see §5).

`customRanking` can only sort by a **numeric or boolean** attribute. That constraint shapes §4: a categorical priority (integration mechanism kind) has to be projected onto a numeric field to participate.

---

## 3. Per-index configuration

The values below are quoted from `INDEX_SETTINGS` in `packages/shared/src/algolia.ts` and asserted in `algolia.spec.ts`. Faceting is included for context; the facet → UI-widget mapping is `STAGE_1_SPEC.md` §7.2.

### 3.1 `products`

- **Searchable attributes** (ordered — earlier = higher textual priority):
  1. `name`
  2. `vendor_name`
  3. `categories`
  4. `audiences`
  5. `phases`
  6. `unordered(description)` — `unordered` so word position within the long description doesn't affect relevance
- **Faceting:** `searchable(categories)`, `searchable(audiences)`, `searchable(phases)`, `searchable(vendor_name)`, `has_api_docs`, `integration_count`
  (the §7.2 range buckets `0 / 1–10 / 11–50 / 51+` are an `ais-numeric-menu` over the bare numeric `integration_count`, not a stored field)
- **Custom ranking:** `desc(integration_count)`, then `desc(review_count)`
  - *Rationale:* a product wired into more integrations is more useful in a directory whose value proposition is integration coverage; reviews break the next tie once they exist (§6).

### 3.2 `vendors`

- **Searchable attributes** (ordered):
  1. `company_name`
  2. `unordered(description)`
  3. `headquarters`
- **Faceting:** `searchable(headquarters)`, `founded_year`, `product_count`, `integration_count`
- **Custom ranking:** `desc(integration_count)`, then `desc(product_count)`
  - *Rationale:* a vendor whose catalog participates in more integrations ranks first; product count breaks the tie.

### 3.3 `integrations`

> **Not surfaced on `/search` (product decision, 2026-06-11):** this index is still built and these
> settings still apply, but the search page hides the Integrations tab for now (see STAGE_1_SPEC.md §7.5).
> The ranking below stays maintained so the tab can be re-enabled without a reindex.

- **Searchable attributes** (ordered):
  1. `source_product_name`
  2. `target_product_name`
  3. `mechanism_name`
  4. `unordered(description)`
- **Faceting:** `mechanism_kind`, `direction`, `searchable(source_product_name)`, `searchable(target_product_name)`
- **Custom ranking:** `desc(mechanism_rank)` — see §4 for what `mechanism_rank` encodes.

### 3.4 `pairs` (deferred to Stage 2, AECI-298)

> **No per-pair search record ships in Stage 1.5.** The `/search` Integrations tab is hidden
> (`STAGE_1_SPEC.md` §7.5), so there is no user-facing surface a consolidated product-**pair** record would feed.
> The existing per-integration index (§3.3) keeps being built and maintained by the sync; it is simply not
> surfaced, and Stage 1.5 does **not** add a second `pairs` index on top of it.

Stage 1.5's Integration Redesign consolidates all mechanisms between two products onto one product-PAIR page
(`STAGE_1_5_SPEC.md` §7, `/products/:contextSlug/integrations/:otherSlug`). A future search surface for that page
would want **one record per unordered product pair**, not one per integration row — so the future index name and
shape are recorded here now (per AECI-298) to keep the decision in one place.

- **Index name.** Follows the existing `indexNamesFor(env)` convention (`packages/shared/src/algolia.ts`):
  **`{prefix}_pairs`** (e.g. `staging_pairs`, `production_pairs`).
- **Future record shape (Stage 2 — illustrative, not yet built).** Derived from the pair-page read model
  `{ context_product, other_product, mechanisms[], sync_headline }` (`STAGE_1_5_SPEC.md` §7.1/§8):

  | Field | Type | Purpose |
  |---|---|---|
  | `objectID` | `string` | The orientation-independent pair key `` `${minSlug}__${maxSlug}` `` (alphabetical), matching the `pair:{min}__{max}` cache tag (`CACHE_STRATEGY.md` §2) — one record ⇄ one page ⇄ one tag. |
  | `context_product_name` / `context_product_slug` | `string` | The alphabetically-first (context) product (§7.1). |
  | `other_product_name` / `other_product_slug` | `string` | The other product. |
  | `mechanism_kinds` | `string[]` | All `mechanism_kind`s present in the pair (faceting). |
  | `mechanism_count` | `number` | How many mechanisms connect the pair (customRanking / display). |
  | `data_objects` | `string[]` | Claimed `data_object` slugs — "what flows" (searchable; from the §3 claim model). |
  | `confirmed_count` / `total_count` | `number` | The §3.5 sync headline (`confirmed = 0` in 1.5). |
  | `top_mechanism_rank` | `number` | `max(mechanismRank(kind))` across the pair's mechanisms — reuses §4's `mechanismRank()` as the primary custom-ranking signal. |

  **Searchable attributes** would lead with the two product names, then `mechanism_kinds` / `data_objects`;
  **custom ranking** would be `desc(top_mechanism_rank)`, then `desc(mechanism_count)`. The final settings are a
  Stage 2 decision (they depend on whether pairs *replace* or *supplement* the per-integration index) and must be
  codified in `INDEX_SETTINGS` + asserted in `algolia.spec.ts` per §1 when the index is actually built.

---

## 4. Integration mechanism-kind priority

Spec §7.3 expresses integration ranking as a **priority over `mechanism_kind`**:

```
native > marketplace-app > iPaaS > api > webhook > partner
```

Because `customRanking` sorts only numeric/boolean attributes, this categorical ordering is realized as a derived numeric field, `mechanism_rank`, carried on each denormalized integration record. The transform (`apps/api/src/lib/algolia-transforms.ts`) calls `mechanismRank(mechanism_kind)` at record-build time; `desc(mechanism_rank)` then orders results so higher-trust, more-first-party mechanisms surface first.

The weight map (`MECHANISM_RANK` in `packages/shared/src/algolia.ts`):

| `mechanism_kind` | `mechanism_rank` |
|---|---|
| `native` | 6 |
| `marketplace-app` | 5 |
| `iPaaS` | 4 |
| `api` | 3 |
| `webhook` | 2 |
| `partner` | 1 |
| absent / unknown | 0 |

`mechanismRank()` returns `0` for `null`, `undefined`, or any kind not in the map, so a record with a missing mechanism ranks last rather than throwing. The map is **string-keyed on purpose** so the settings module imports nothing; `IntegrationMechanismKindSchema` (`packages/shared/src/api/integrations.ts`) remains the source of truth for the *set* of valid kinds. Adding or reordering a kind means updating that enum, `MECHANISM_RANK`, and this table together.

---

## 5. Tie-breakers

After the textual-relevance criteria (typo…exact), ties resolve by each index's `customRanking`, applied left-to-right:

| Index | 1st tie-break | 2nd tie-break | Then |
|---|---|---|---|
| `products` | `integration_count` desc | `review_count` desc | index order (arbitrary) |
| `vendors` | `integration_count` desc | `product_count` desc | index order (arbitrary) |
| `integrations` | `mechanism_rank` desc | *(none)* | index order (arbitrary) |

When records tie on the full `customRanking` list, Algolia falls back to the records' internal order in the index — not stable or meaningful, so it must not be relied on for deterministic ordering.

**Known gap (tuning candidate):** `integrations` has a *single* custom signal. Every integration sharing a `mechanism_kind` (e.g. all `native`) ties immediately and falls to arbitrary order. A secondary signal — e.g. a popularity/recency field, or ordering by the source/target products' `integration_count` — is the first candidate for §7's tuning loop once the index is populated (§6).

---

## 5a. Replica sort indexes — the `/search` per-tab sort (AECI-175)

§4.6 calls for a per-tab **sort dropdown**. The default order described above is *relevance* (textual ranking, then `customRanking`). Each additional sort option is realized as a **standard Algolia replica** of the entity's primary index — a replica returns the *same records* as its primary, re-ordered by its own `ranking`. The control lives at `apps/web/src/app/search/widgets/search-sort-by.ts`; the wiring (`connectSortBy` per index) is in `search-controller.ts`.

**Options (product decision, 2026-06-23).** Products and Vendors each expose three sorts; the Integrations tab is hidden on `/search` (§7.5), so it has **no** sort UI and **no** replicas.

| Tab | Sort | Index | Replica `ranking` (sort attribute first, then the default criteria) |
|---|---|---|---|
| Products | Relevance *(default)* | `<prefix>_products` (primary) | — (the §3.1 default formula) |
| Products | Most integrations | `<prefix>_products_integration_count_desc` | `desc(integration_count)`, typo…custom |
| Products | Name (A–Z) | `<prefix>_products_name_asc` | `asc(name)`, typo…custom |
| Vendors | Relevance *(default)* | `<prefix>_vendors` (primary) | — (the §3.2 default formula) |
| Vendors | Most integrations | `<prefix>_vendors_integration_count_desc` | `desc(integration_count)`, typo…custom |
| Vendors | Name (A–Z) | `<prefix>_vendors_name_asc` | `asc(company_name)`, typo…custom |

The model is code: `REPLICA_SORTS` (+ `sortReplicasFor`, `replicaIndexName`, `replicaNamesFor`) in `packages/shared/src/algolia.ts`, asserted in `algolia.spec.ts`. A replica leads its `ranking` with the sort attribute, then keeps Algolia's default criteria (`typo → geo → words → filters → proximity → attribute → exact → custom`) as the tie-break tail — so e.g. equal `integration_count` still falls back to textual relevance.

**Replicas inherit faceting.** `applyIndexSettingsTo` sets each replica's `searchableAttributes` / `attributesForFaceting` / `customRanking` to the **same** values as its primary (only `ranking` differs), so the §7.2 facet sidebar keeps working under any sort.

**How they're created + synced.** `applyIndexSettingsTo` writes a `replicas: [...]` array on each primary (which is what creates/links the replicas) and then `setSettings` on each replica with its `ranking`. **Standard replicas auto-mirror their primary's records** — the daily/bulk sync (`apps/api/src/lib/algolia-sync.ts`) pushes objects only to the primary, and Algolia keeps the replicas in sync. So there is **no extra sync work**, but a standard replica **duplicates the primary's record count** for Algolia quota/billing (4 replicas ⇒ 4× the products+vendors record footprint). This cost was accepted for exact, predictable ordering (incl. strict A–Z); virtual replicas were the rejected lower-cost alternative.

**Key scope + rotation.** Both provisioned keys are scoped to the replica index names (`searchKeyParams` / `managementKeyParams`): the browser **search-only** key queries a replica directly via `connectSortBy`, and the **management** key `setSettings` each replica's ranking. Because the scope widened, the keys must be **re-provisioned** (`pnpm algolia:provision`) before the first deploy that applies replica settings — see `docs/CICD_PLAN.md` §7.4/§7.5.

**URL.** The active sort mirrors to `?sort=` as a short token (`integrations` | `name`; `relevance` clears the param), per the §9.2 minimal-params policy. It is per active tab.

---

## 6. Signal availability caveats (launch state)

Two configured signals are **inert at launch** and should not be read as "tuned and working":

- **`review_count` / ratings are no-ops until Phase 5.** `desc(review_count)` is wired into the `products` custom ranking, but every product carries `review_count: 0` until the reviews feature (Phase 5) lands, so the signal orders nothing pre-Phase-5. Separately, `rating_overall_avg` ships on the product record (for display) but is **not** a `customRanking` signal at all today — promoting it to a ranking signal once reviews exist is a §7 tuning decision, not current behavior.
- **The `integrations` index is sparse until [AECI-86](https://linear.app/aec-integrations/issue/AECI-86).** Integration seeding in `POST /api/promote` is currently disabled, so few integration records exist. `desc(mechanism_rank)` is correct but has little to order until AECI-86 re-enables seeding; the §5 secondary-tie-break gap is also low-impact until then.

Neither caveat requires a settings change — the signals are deliberately in place ahead of the data so no re-index is needed when the data arrives.

---

## 7. Tuning + feedback loop (post-launch)

Search quality is a continuous concern, not a launch-day deliverable. This is the loop for evolving the ranking after launch.

**Measure.** Use Algolia Analytics (and PostHog product analytics) to watch:
- click-through rate and click position per query (are good results in the top slots?),
- conversion (search → product/vendor detail view),
- no-results and low-results queries (a synonym, typo-tolerance, or searchable-attribute gap),
- popular queries (candidates for curation / Query Suggestions).

**Decide.** A signal change should be motivated by one of the above, not intuition. Candidate levers, roughly in expected order of adoption:
1. Promote `rating_overall_avg` (and tune `review_count`) into `products` custom ranking once Phase 5 reviews provide real values (§6).
2. Add a secondary `integrations` custom signal to fix the §5 tie-break gap (after AECI-86).
3. Synonyms / `Query Suggestions` for the popular- and no-results queries.
4. Per-attribute relevance tuning (e.g. demote `description` further, or mark attributes for exact-only matching).
5. Recency or popularity signals if the data supports them without becoming a pay-to-win proxy (§1).

**Roll out.** Every change is code: edit `INDEX_SETTINGS` / `MECHANISM_RANK` in `packages/shared/src/algolia.ts`, update the matching section of this doc in the same PR, and let `applyIndexSettings()` (CI / sync pipeline) push it. `algolia.spec.ts` must be updated to assert the new settings. Prefer Algolia A/B testing (two index configurations) to validate a ranking change against live metrics before making it the default, rather than flipping production ranking blind.

---

## 8. Cross-references

- `STAGE_1_SPEC.md` §7 — Search section; §7.1 record shapes, §7.2 faceting, §7.3 (the stub this doc fulfills), §7.4 sync strategy, §7.5 InstantSearch, §7.6 per-locale indexes.
- `packages/shared/src/algolia.ts` — `INDEX_SETTINGS`, `MECHANISM_RANK`, `mechanismRank()`, `indexSettingsFor()`, `applyIndexSettings()` (the operative configuration).
- `packages/shared/src/algolia-records.ts` — Zod record schemas (fields available to rank/facet on).
- `apps/api/src/lib/algolia-transforms.ts` — Drizzle/D1 → Algolia record transforms; sets the derived `mechanism_rank`.
- `packages/shared/src/algolia.spec.ts` — settings assertions that co-verify this doc.
- `DATABASE_SCHEMA.md` — origin of `integration_count`, `product_count`, `review_count`, `rating_overall_avg`.
- `CACHE_STRATEGY.md` — the sibling lifted-from-spec doc this one mirrors in structure.
- `adr/0006-algolia-over-cloudflare-ai-search.md` — why Algolia was chosen as the search backend.
- [AECI-137](https://linear.app/aec-integrations/issue/AECI-137) — index settings + record shapes as code (Phase 3.2).
- [AECI-175](https://linear.app/aec-integrations/issue/AECI-175) — per-tab sort dropdown via replica indexes (§5a); deferred from [AECI-142](https://linear.app/aec-integrations/issue/AECI-142) (Phase 3.9).
- [AECI-86](https://linear.app/aec-integrations/issue/AECI-86) — re-enable integration seeding in `POST /api/promote` (populates the integrations index).
- [AECI-49](https://linear.app/aec-integrations/issue/AECI-49) — the `CACHE_STRATEGY.md` precedent for lifting a spec section into a canonical doc.
- [AECI-298](https://linear.app/aec-integrations/issue/AECI-298) — Stage 1.5 search/SEO follow-through: deferral of per-pair Algolia records (§3.4) + the future `{prefix}_pairs` shape.
