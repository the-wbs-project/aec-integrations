# Tool Scoring

How a single tool's `priority_score` and `priority_tier` are computed. Mirrors the logic in `artifacts/n8n-workflows/AECi-T-Score.json`.

---

## Inputs

**From the Tools table** (all read from the tool record):
- `has_api_docs` (bool)
- `marketplace_count` (int, 0–4)
- `integration_count` (int)
- `ipaas_count` (int, 0–3)
- `zapier_trigger_count` (int)
- `g2_review_count`, `g2_rating`
- `capterra_review_count`, `capterra_rating`
- `search_volume_monthly`, `google_trends_index` (0–100)
- `reddit_mentions_24mo`

**From the linked Vendor record** (first entry in `vendors`):
- `company_size` (`'1-10'` | `'11-50'` | `'51-200'` | `'201-1000'` | `'1001-5000'` | `'5000+'`)
- `has_partner_program` (bool)
- `funding_stage` (`'Bootstrapped'` | `'Pre-seed'` | `'Seed'` | `'Series A'` | `'Series B'` | `'Series C'` | `'Series D+'` | `'Public'` | `'Acquired'` | `'Unknown'`)
- `press_count_12mo`, `blog_last_post_days_ago`
- `founded_year` (for emerging flag)

If the vendor isn't linked or isn't enriched, all vendor fields fall back to neutral defaults (see below).

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
| `press_count_12mo` | 50 |

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

---

## Outreach Score (0–100)

Vendor-level signals. Identical for every tool from the same vendor (by design — outreach happens at the vendor level).

```
outreach_score =
    0.30 × employee_sweet_spot(company_size)
  + 0.25 × (has_partner_program ? 100 : 0)
  + 0.20 × funding_score(funding_stage)
  + 0.15 × logNorm(press_count_12mo, 50)
  + 0.10 × blog_recency(blog_last_post_days_ago)
```

**Employee sweet-spot curve** — favors mid-market vendors most likely to respond to outreach:

| `company_size` | Score |
|---|---|
| `1-10` | 20 |
| `11-50` | 50 |
| `51-200` | **100** |
| `201-1000` | 90 |
| `1001-5000` | 60 |
| `5000+` | 30 |

**Funding score** — budget + growth stage proxy:

| `funding_stage` | Score |
|---|---|
| `Series C` | **100** |
| `Series B` | 90 |
| `Series D+` | 85 |
| `Series A` | 80 |
| `Seed` | 50 |
| `Public` | 50 |
| `Bootstrapped` | 40 |
| `Acquired` | 40 |
| `Pre-seed` | 30 |
| `Unknown` | 30 |

**Blog recency** — marketing activity freshness:

| `blog_last_post_days_ago` | Score |
|---|---|
| ≤ 7 | 100 |
| ≤ 30 | 80 |
| ≤ 90 | 60 |
| ≤ 180 | 40 |
| ≤ 365 | 20 |
| > 365 | 10 |
| missing | 30 |

---

## Priority Score

```
priority_score =
    0.40 × integration_score
  + 0.35 × demand_score
  + 0.25 × outreach_score
```

Integration weighted highest because the business case for this catalog is integration-forward tool discovery.

---

## Priority Tier

Absolute thresholds on `priority_score`:

| Tier | Range | Profile |
|---|---|---|
| **1** (Must-Have) | ≥ 80 | Seed immediately, full integration mapping, proactive outreach |
| **2** (High Priority) | 55–79 | Seed within first month, profiles from public data |
| **3** (Standard) | 30–54 | Basic profiles, reactive outreach |
| **4** (Long Tail) | < 30 | Minimal profiles, revisit quarterly |

---

## Emerging Flag

Force minimum Tier 2 if **all three** are true:

- `vendor.founded_year > current_year − 4` (young vendor)
- `has_api_docs = true` (integration-ready)
- `marketplace_count ≥ 1` (already in an AEC ecosystem)

Young integration-ready tools in AEC marketplaces get an explicit boost so they aren't buried under incumbents with more reviews and search volume.

---

## Missing Data Defaults

| Missing | Treatment |
|---|---|
| Review count = 0 | Keep 0 (meaningful signal) |
| Rating missing | Bayesian pulls to `C = 4.1` |
| Any count signal missing | Treated as 0 in `logNorm` |
| `google_trends_index` missing | Treated as 0 |
| `company_size` missing/unknown | 50 (neutral midpoint) |
| `funding_stage` missing/unknown | 30 |
| `blog_last_post_days_ago` missing | 30 |
| `has_partner_program` missing | Treated as false (0) |
| Vendor not linked / not enriched | All vendor-level fields use the defaults above |

---

## Output Fields Written

All written to the Tool record:

| Field | Type | Notes |
|---|---|---|
| `integration_score` | Number (1 decimal) | 0–100 |
| `demand_score` | Number (1 decimal) | 0–100 |
| `outreach_score` | Number (1 decimal) | 0–100 |
| `priority_score` | Number (1 decimal) | 0–100 |
| `priority_tier` | Single select | `'1'`, `'2'`, `'3'`, `'4'` |
| `emerging_flag` | Checkbox | — |
| `last_scored_at` | DateTime | ISO 8601 |

---

## Design Notes

- **Per-tool, not batch.** WT-Score is invoked with a single `record_id` and scores that one tool. No population-wide normalization or percentile ranking. This lets scoring run on demand whenever enrichment for a single tool refreshes.
- **Fixed caps, not per-category min/max.** A Revit and a Procore are normalized against the same absolute caps. Trade-off: simpler and stable, but a category of all-small-tools gets crushed against larger categories. Revisit if specific categories need their own curves.
- **Absolute tier thresholds, not percentiles.** Tier labels don't rebalance as new tools are added. If the score distribution shifts materially, the 80/55/30 cutoffs may need retuning.
