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

`applyIndexSettings()` is invoked by the per-environment CI steps and the operator script — see §1.1. (It is **not** called by the sync pipeline: `apps/api/src/lib/algolia-sync.ts` pushes *records*, never *settings*.) **A ranking change means editing `INDEX_SETTINGS` (or `MECHANISM_RANK`) and updating this doc in the same PR** — neither prose nor code is allowed to drift from the other.

### 1.1 How settings actually reach an index

One command applies every index's settings for one environment:

```bash
pnpm algolia:apply-settings --env <preview|staging|demo|production>
# → scripts/algolia/apply-settings.mjs → applyIndexSettings(client, env)
```

It is idempotent, prints no secrets, and per run issues **7 `setSettings` calls** — the three primaries plus the four sort replicas, which re-receive `searchableAttributes` / `attributesForFaceting` / `customRanking` verbatim and differ only in `ranking` (§5a). That is why a new facet needs no separate replica step: the `/search` facet rail keeps working under every sort automatically.

| Environment | How settings are applied |
|---|---|
| `staging` | CI — `.github/workflows/deploy.yml` ("Update Algolia staging index settings") |
| `demo` | CI — `.github/workflows/promote-to-demo.yml` |
| `production` | CI — `.github/workflows/promote-to-prod.yml` |
| **`preview`** | **No CI step — an operator must run the command by hand.** |

The preview gap matters in practice: `lighthouse.yml` measures `/search` against the **preview** indexes, so a settings change that lands in code but not on preview is invisible there until someone runs the command. It degrades gracefully rather than erroring (Algolia returns no values for an unconfigured facet attribute, and the widget renders nothing), so it is a hygiene step, not a release blocker.

> **One Algolia application spans every environment** — `--env` only selects the index-name *prefix*, and an admin key reaches every index (`CICD_PLAN.md`). Check the flag before running the command locally.

**Full reindex** (needed only when records must be rebuilt, e.g. after a new record field or a D1 copy) goes through the Access-gated datatool Worker (`apps/datatool`, "Reindex now" + env select) or `reindexEnv(db, fetch, creds, env, ['products'])`. Note it CLEARS the index before repopulating, so the target returns zero hits for the duration — run it off-peak. The nightly incremental sync cannot substitute: it selects on a `products.updated_at` watermark and so only carries rows that were actually touched.

### 1.1 How settings actually reach an index

One command applies every index's settings for one environment:

```bash
pnpm algolia:apply-settings --env <preview|staging|demo|production>
# → scripts/algolia/apply-settings.mjs → applyIndexSettings(client, env)
```

It is idempotent, prints no secrets, and per run issues **7 `setSettings` calls** — the three primaries plus the four sort replicas, which re-receive `searchableAttributes` / `attributesForFaceting` / `customRanking` verbatim and differ only in `ranking` (§5a). That is why a new facet needs no separate replica step: the `/search` facet rail keeps working under every sort automatically.

| Environment | How settings are applied |
|---|---|
| `staging` | CI — `.github/workflows/deploy.yml` ("Update Algolia staging index settings") |
| `demo` | CI — `.github/workflows/promote-to-demo.yml` |
| `production` | CI — `.github/workflows/promote-to-prod.yml` |
| **`preview`** | **No CI step — an operator must run the command by hand.** |

The preview gap matters in practice: `lighthouse.yml` measures `/search` against the **preview** indexes, so a settings change that lands in code but not on preview is invisible there until someone runs the command. It degrades gracefully rather than erroring (Algolia returns no values for an unconfigured facet attribute, and the widget renders nothing), so it is a hygiene step, not a release blocker.

> **One Algolia application spans every environment** — `--env` only selects the index-name *prefix*, and an admin key reaches every index (`CICD_PLAN.md`). Check the flag before running the command locally.

**Full reindex** (needed only when records must be rebuilt, e.g. after a new record field or a D1 copy) goes through the Access-gated datatool Worker (`apps/datatool`, "Reindex now" + env select) or `reindexEnv(db, fetch, creds, env, ['products'])`. Note it CLEARS the index before repopulating, so the target returns zero hits for the duration — run it off-peak. The nightly incremental sync cannot substitute: it selects on a `products.updated_at` watermark and so only carries rows that were actually touched.

**Ranking is purely algorithmic.** Per the CLAUDE.md non-negotiable, there is no pay-for-placement: paid vendor tiers affect profile richness, never ranking position. No ranking signal in this document may be a function of payment.

**And it is asserted, not merely documented (AECI-610).** The entitlement vocabulary (`packages/shared/src/entitlements.ts`) and the ranking vocabulary defined here are both pure data in the same package, so `packages/shared/src/entitlements.spec.ts` proves they are **disjoint sets**: no capability id appears in the union of every entity's `searchableAttributes ∪ attributesForFaceting ∪ customRanking`, and none of `verified` / `tier` / `entitlement` / `status` / `paid` / `plan` appears in it either. That test plus the per-entity `customRanking` freezes in `algolia.spec.ts` are the two halves of the firewall. Both are **invariant tests** (`STAGE_2_PAID_TIERS_SPEC.md` §10) — a ranking change that trips one is not a test to update, it is a decision to reopen.

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
  6. `trades` — AECI-545; ranked above `trade_aliases` and `description` because a canonical trade name is a strong intent signal ("roofing software")
  7. `trade_aliases` — AECI-545; the flattened alias strings of the product's trades (`taxonomy_trades.aliases`), so colloquial queries ("blacktop", "glazier", "dirt work") reach the right products. **Searchable but never faceted and never displayed** — it is matching metadata, not a label.
  8. `unordered(description)` — `unordered` so word position within the long description doesn't affect relevance
- **Faceting:** `searchable(categories)`, `searchable(audiences)`, `searchable(phases)`, `searchable(trades)`, `searchable(vendor_name)`, `has_api_docs`, `integration_count`
  (the §7.2 range buckets `0 / 1–10 / 11–50 / 51+` are an `ais-numeric-menu` over the bare numeric `integration_count`, not a stored field)
- **Custom ranking:** `desc(integration_count)`, then `desc(review_count)`
  - *Rationale:* a product wired into more integrations is more useful in a directory whose value proposition is integration coverage; reviews break the next tie once they exist (§6).
  - **Trades add no custom-ranking signal.** The `trades` facet changes what is *findable* and *filterable*, never what ranks higher. Carrying a trade tag is a factual claim about a product's scope, not a quality or commercial signal, and boosting on it would be a placement lever — which AECi does not have (`STAGE_1_SPEC.md` §1, no pay-for-placement).
  - **Trades are sparse on purpose.** Most products carry `trades: []` (`TRADES_VOCABULARY.md` §1.1 — horizontal platforms get no tags), so an empty array is normal and must not be treated as missing data in relevance tuning.
- **Rejected alternative for aliases: Algolia Synonyms.** Synonyms are index-level configuration state applied globally, and they are not managed as code in this repo. A record attribute keeps the alias vocabulary in the same code-managed lockstep as everything else (`docs/TRADES_VOCABULARY.md` §5 → `apps/api/seed/trades.sql` → D1 → transform → record). Recorded as a possible §7 lever, not a gap.
- **Deferred tuning lever: `unordered(trade_aliases)`.** `trade_aliases` is a flattened join artifact, so element order is meaningless, and Algolia otherwise slightly favours matches in earlier array positions. The bare form ships first because it is settings-only to change later — no reindex — and there is no query data yet to justify the tweak (§7).
- **Publication floor does not apply here.** `TRADE_PUBLISH_MIN_PRODUCTS` (`TRADES_VOCABULARY.md` §6) gates the API-backed facet sidebar and nav (AECI-546). It is deliberately NOT applied to the Algolia `trades` facet: Algolia facet counts are query- and refinement-scoped rather than global, publication is a property of the *term* while an Algolia record is per-*product* (a term crossing the floor moves no product's `updated_at`, so the flag would go stale until the next full reindex), and `/search` is `noindex` + `no-store`, so the floor's SEO rationale doesn't apply.

### 3.2 `vendors`

- **Searchable attributes** (ordered):
  1. `company_name`
  2. `unordered(description)`
  3. `headquarters`
- **Faceting:** `searchable(headquarters)`, `founded_year`, `product_count`, `integration_count`
- **Custom ranking:** `desc(integration_count)`, then `desc(product_count)`
  - *Rationale:* a vendor whose catalog participates in more integrations ranks first; product count breaks the tie.
- **`verified` (AECI-529)** is denormalized onto the vendor record for the search-card badge only. It is **display-only** — deliberately **not** a searchable attribute, facet, or custom-ranking signal, so the settings above are unchanged (no pay-for-placement). See §6 for its freshness behavior. The **record** may carry it; `INDEX_SETTINGS` may never name it, and `entitlements.spec.ts` asserts exactly that (§1).

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
  `{ context_product, other_product, mechanisms[], sync_headline, maintenance, version_diff }`
  (`STAGE_1_5_SPEC.md` §7.1/§8; `maintenance` added by AECI-616, `version_diff` by AECI-303). Note
  that a per-pair record would be a **latest-version** projection: the §9 version selectors are URL
  params on the read, and attestation state still does not reach search
  (`STAGE_2_ATTESTATIONS_SPEC.md` §11):

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

Three configured signals are **inert at launch** and should not be read as "tuned and working":

- **`review_count` / ratings are no-ops until Phase 5.** `desc(review_count)` is wired into the `products` custom ranking, but every product carries `review_count: 0` until the reviews feature (Phase 5) lands, so the signal orders nothing pre-Phase-5. Separately, `rating_overall_avg` ships on the product record (for display) but is **not** a `customRanking` signal at all today — promoting it to a ranking signal once reviews exist is a §7 tuning decision, not current behavior.
- **The `integrations` index is sparse until [AECI-86](https://linear.app/aec-integrations/issue/AECI-86).** Integration seeding in `POST /api/promote` is currently disabled, so few integration records exist. `desc(mechanism_rank)` is correct but has little to order until AECI-86 re-enables seeding; the §5 secondary-tie-break gap is also low-impact until then.

- **`trades` / `trade_aliases` ship empty (AECI-545).** The record fields and the `searchable(trades)` facet are live, but `product_trades` is unpopulated in every environment until the promote-ingest key (AECI-542) and the cross-repo catalog backfill (REVIEW: AECI-547) land. Until then every product carries `trades: []` / `trade_aliases: []` and the `/search` **Trades facet renders nothing at all** — that is the expected state, not a regression. Because the backfill re-promotes (which bumps `products.updated_at`), the nightly watermark sync carries trades onto exactly the tagged products with no manual step; the one-time full reindex afterwards is only to normalize the untouched majority onto the new field set. **Second writer since AECI-665:** a claimed vendor can now assign its own product's trades in the portal (`PATCH /api/vendor/products/:id`), which reaches this index by the same route — that handler stamps `products.updated_at` even for a taxonomy-only edit, so the next nightly window picks the change up. No immediate by-id push, so trade edits are ≤24h to search (the vendor-facing copy says so; `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.3).

None of these caveats requires a settings change — the signals are deliberately in place ahead of the data so no re-index is needed when the data arrives.

**Search freshness lags SSR by up to a nightly cycle (AECI-529).** Search/browse cards render from **Algolia records**, which are rebuilt only by the nightly watermark cron (`runDailySync`, `apps/api/src/lib/algolia-sync.ts`, 08:00 UTC) over rows whose `updated_at` moved. So a vendor content edit or a **verified-badge flip** reaches the search surfaces **≤24h** later, whereas the equivalent SSR detail page is **immediate** via the `vendor:{slug}` / `product:{slug}` Cache-Tag purge (`CACHE_STRATEGY.md` §5). This is an **accepted launch expectation** — UI copy must not promise instant search. The AECI-519 claim→grant batch stamps `vendors.updated_at` alongside the `verified` flip precisely so the next window re-indexes the vendor. An immediate by-id `indexEntity` hook (like the promote path's `syncPromoteTargets`) is a future option if faster search is wanted; it is out of scope for launch.

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

**Roll out.** Every change is code: edit `INDEX_SETTINGS` / `MECHANISM_RANK` in `packages/shared/src/algolia.ts`, update the matching section of this doc in the same PR, and let `applyIndexSettings()` push it through the per-environment path in §1.1 (remembering that **preview is manual**). `algolia.spec.ts` must be updated to assert the new settings. Prefer Algolia A/B testing (two index configurations) to validate a ranking change against live metrics before making it the default, rather than flipping production ranking blind.

**Evaluating a lever before there is enough data.** The full loop above runs on real query data — that is [AECI-283](https://linear.app/aec-integrations/issue/AECI-283), unblocked since go-live ([AECI-247](https://linear.app/aec-integrations/issue/AECI-247), 2026-07-03) but only actionable once launch traffic has accumulated meaningful Algolia analytics. Until then, the dev-only **`/preview/search-relevance`** harness ([AECI-286](https://linear.app/aec-integrations/issue/AECI-286)) ranks a curated AEC fixture set under the candidate levers above (Baseline, Ratings-forward, Coverage-weighted, and a tunable Balanced blend) so the trade-offs can be *seen and felt* before any `INDEX_SETTINGS` change. It is a **client-side model** of `customRanking`, not Algolia: a deterministic token-overlap text score stands in for Algolia's textual ranking, the lexicographic strategies mirror the real "signals only break textual ties" model, and the weighted strategies illustrate a best-match alternative where signals can override text. The pure logic lives in `apps/web/src/app/preview/search-relevance/ranking-strategies.ts` (unit-tested); the surface itself is covered by `apps/web/e2e/preview-search-relevance.spec.ts` (reorder behavior + axe). It touches no production setting and is production-blocked by `isPreviewPath`.

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
- [AECI-283](https://linear.app/aec-integrations/issue/AECI-283) — run this §7 tuning loop on real query data (unblocked at go-live 2026-07-03; needs accumulated launch traffic).
- [AECI-286](https://linear.app/aec-integrations/issue/AECI-286) — `/preview/search-relevance`, the fixtures-based lab for evaluating the §7 levers before the query data exists (see §7).
- [AECI-49](https://linear.app/aec-integrations/issue/AECI-49) — the `CACHE_STRATEGY.md` precedent for lifting a spec section into a canonical doc.
- [AECI-298](https://linear.app/aec-integrations/issue/AECI-298) — Stage 1.5 search/SEO follow-through: deferral of per-pair Algolia records (§3.4) + the future `{prefix}_pairs` shape.
