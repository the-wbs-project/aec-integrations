# Tool Scoring

How a single tool's `priority_score` and `priority_tier` are computed. Implemented in `apps/review-app/server/tasks/computePriorityScore.ts` and called by `apps/review-app/server/workflows/tool/score.ts` (T08).

---

## Design notes

**Two pillars, both tool-intrinsic.** Tool priority is `0.55 × Integration + 0.45 × Demand`. Integration captures the "can we plug into this product?" question; Demand captures "is anyone looking for it?". Both are derived purely from data the tool itself owns — review counts, marketplace listings, search interest.

**Outreach is captured by VQS at the vendor level, not duplicated here.** A tool's "is this vendor likely to respond to outreach?" question is answered by the linked vendor's `vqs_score`. The tools list shows the linked vendor's VQS in a column right next to the tool's priority — but VQS is not multiplied into the priority score. This avoids the prior failure mode where an unenriched vendor's neutral defaults silently buoyed every linked tool's priority by ~13 points.

**Tier ladder matches VQS.** Same five-tier ladder + `Unscored`, same 80/60/40/20 cutoffs. A "Tier 2" tool and a "Tier 2" vendor mean the same thing across the app.

---

## Inputs

**From the Tools table:**
- `has_api_docs` (bool)
- `marketplace_count` (int, 0–4)
- `integration_count` (int)
- `ipaas_count` (int, 0–3)
- `zapier_trigger_count` (int)
- `g2_review_count`, `g2_rating`
- `capterra_review_count`, `capterra_rating`
- `search_volume_monthly`, `google_trends_index` (0–100)
- `reddit_mentions_24mo`

**From the linked Vendor record** (first entry in `vendors`, optional):
- `founded_year` — only used for the emerging flag.

If the vendor isn't linked or `founded_year` is missing, the emerging flag simply can't fire — but the priority score itself is unaffected.

---

## Normalization

All count-like signals use **fixed-cap log normalization**:

```
logNorm(value, cap) = clamp(log(value + 1) / log(cap + 1) × 100, 0, 100)
```

A signal at or above `cap` maps to 100. Caps:

| Signal | Cap |
|---|---|
| `marketplace_count` | 4 |
| `ipaas_count` | 3 |
| `integration_count` | 100 |
| `zapier_trigger_count` | 50 |
| `total_review_count` (g2 + capterra) | 5,000 |
| `search_volume_monthly` | 100,000 |
| `reddit_mentions_24mo` | 500 |

`google_trends_index` is already 0–100 and passes through linearly.

---

## Integration Score (0–100)

Product integrability signals, tool-level only.

```
integration_score =
    0.30 × logNorm(marketplace_count, 4)
  + 0.25 × (has_api_docs ? 100 : 0)
  + 0.20 × logNorm(integration_count, 100)
  + 0.15 × logNorm(ipaas_count, 3)
  + 0.10 × logNorm(zapier_trigger_count, 50)
```

Returns `null` when none of the five signals is populated.

---

## Demand Score (0–100)

Buyer demand, tool-level only.

```
total_reviews = g2_review_count + capterra_review_count
best_rating   = g2_rating || capterra_rating || null

demand_score =
    0.30 × logNorm(total_reviews, 5000)
  + 0.25 × bayesian_rating(best_rating, total_reviews)
  + 0.20 × logNorm(search_volume_monthly, 100000)
  + 0.15 × norm(google_trends_index, 0, 100)
  + 0.10 × logNorm(reddit_mentions_24mo, 500)
```

**Bayesian rating** (smooths low-review tools toward the category mean):

```
m = 15              (prior weight)
C = 4.1             (category mean rating)
v = total_reviews   (evidence weight)
R = best_rating || C

WR = (v / (v + m)) × R + (m / (v + m)) × C
bayesian_rating = WR / 5 × 100
```

Returns `null` when none of the five count signals is populated.

---

## Priority Score

```
priority_score =
    0.55 × integration_score
  + 0.45 × demand_score
```

If only one pillar has any populated input, that pillar's score becomes the priority directly (no synthetic weighting against a missing pillar). If both are null, `priority_score` is `null` and tier is `Unscored`.

Integration is weighted slightly higher because the business case for this catalog is integration-forward tool discovery — but the gap from the old `0.40 / 0.35 / 0.25` model is closed.

---

## Priority Tier

Absolute thresholds on `priority_score`, aligned with VQS:

| Tier | Range | Profile |
|---|---|---|
| **1** | ≥ 80 | Must-have. Seed immediately, full integration mapping, proactive outreach. |
| **2** | 60–79 | High priority. Seed within first month. |
| **3** | 40–59 | Standard. Basic profiles, reactive outreach. |
| **4** | 20–39 | Long tail. Minimal profiles, revisit quarterly. |
| **5** | < 20 | Background. Track only. |
| **Unscored** | n/a | Neither pillar has any populated input. |

---

## Emerging Flag

Force minimum Tier 2 if **all three** are true:

- `vendor.founded_year > current_year − 4` (young vendor)
- `has_api_docs = true` (integration-ready)
- `marketplace_count ≥ 1` (already in an AEC ecosystem)

The flag never applies to `Unscored` tools.

---

## Completeness, Confidence, Flags

`tool/score.ts` writes three additional fields the UI reads:

**`tool_data_completeness`** — ratio of populated input fields out of the 10 priority inputs (5 integration + 5 demand). Drives `tool_enrichment_status`:
- `≥ 0.75` → `enriched`
- `≥ 0.40` → `partial`
- `< 0.40` → `error`

**`priority_confidence`** — same `high` / `medium` / `low` thresholds used for VQS:
- `high`: both pillars present and ≥ 6 total signals populated
- `medium`: at least 1 pillar present and ≥ 3 total signals populated
- `low`: otherwise

**`priority_flags`** (JSON array string) — markers the tier-detail dialog can surface:
- `missing_marketplace_check`, `missing_api_docs_check`, `missing_ipaas_check`, `missing_reviews_check`, `missing_search_check`, `missing_reddit_check` — leaf hasn't run yet
- `no_vendor_linked` — tool has no linked vendor record
- `vendor_unenriched` — vendor exists but couldn't be fetched
- `unscored` — both pillars null
- `emerging` — emerging flag fired

---

## Missing Data Defaults

| Missing | Treatment |
|---|---|
| Review count = 0 | Keep 0 (meaningful signal). |
| Rating missing | Bayesian pulls to `C = 4.1`. |
| Any count signal missing | Treated as 0 in `logNorm`. |
| `google_trends_index` missing | Treated as 0. |
| Vendor not linked / `founded_year` missing | Emerging flag can't fire. Priority score unaffected. |

---

## Output Fields Written

All written to the Tool record by T08:

| Field | Type | Notes |
|---|---|---|
| `integration_score` | Number (1 decimal) | 0–100 or null |
| `demand_score` | Number (1 decimal) | 0–100 or null |
| `priority_score` | Number (1 decimal) | 0–100 or null |
| `priority_tier` | Single select | `'1'` … `'5'` or `'Unscored'` |
| `priority_confidence` | Single select | `high` / `medium` / `low` |
| `priority_flags` | Long text | JSON-stringified array |
| `emerging_flag` | Checkbox | — |
| `tool_data_completeness` | Number | 0.0–1.0 |
| `tool_enrichment_status` | Single select | `enriched` / `partial` / `error` |
| `last_tool_enriched_at` | DateTime | ISO 8601 |
| `last_scored_at` | DateTime | ISO 8601 |

**Deprecated** (no longer written, kept on the schema so historical values still render):
- `outreach_score` — was 0.30·sweetSpot + 0.25·partner + 0.20·funding + 0.15·press + 0.10·blogRecency. Removed when priority moved to a 2-pillar model. Vendor outreach quality lives in `vqs_score`.

---

## Worked Examples

**Procore (Tier 1 incumbent)**
- Integration: marketplace=1, has_api_docs=true, integration_count=80, ipaas=2, zapier=15 → ~71
- Demand: 4500 reviews · 4.5 rating, search_volume=85k, trends=80, reddit=120 → ~78
- Priority = 0.55 · 71 + 0.45 · 78 = 39.05 + 35.10 = **74.2 → Tier 2**

**Bluebeam Revu (Tier 2)**
- Integration: marketplace=1, has_api_docs=true, integration_count=15, ipaas=1, zapier=4 → ~52
- Demand: 1200 reviews · 4.6 rating, search_volume=60k, trends=70, reddit=30 → ~63
- Priority = 0.55 · 52 + 0.45 · 63 = 28.6 + 28.35 = **57.0 → Tier 3**

**A bare-record tool with only a name and Pending status**
- Integration: all signals missing → null
- Demand: all signals missing → null
- Priority = null → **Unscored** (`priority_flags` includes `unscored`, `missing_*_check`s)

The first example shows a meaningful re-tier from the old 4-tier ladder: Procore is now Tier 2 instead of Tier 1, because `priority_score=74.2` falls below the new 80 cutoff. This is correct — tier 1 should be reserved for truly dominant tools, and the old system was inflating tiers via the defaulted-50 outreach pillar.

---

## Design Notes (Engineering)

- **Per-tool, not batch.** T08-Score is invoked with a single `record_id` and scores that one tool. No population-wide normalization or percentile ranking.
- **Fixed caps, not per-category min/max.** A Revit and a Procore are normalized against the same absolute caps. Trade-off: simpler and stable, but a category of all-small-tools gets crushed against larger categories. Revisit if specific categories need their own curves.
- **Absolute tier thresholds, not percentiles.** Tier labels don't rebalance as new tools are added.
- **Outreach pillar is gone, not refactored.** The `outreach_score` Airtable column is preserved (left in place for historical reads) but never written. If we ever want to bring it back, it should be a single inherited value (`vendor.vqs_score`) rather than a re-derived per-tool synthesis.
