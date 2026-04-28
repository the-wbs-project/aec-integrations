# Vendor Quality Score (VQS)

The Vendor Quality Score is a single 0–100 number that ranks how attractive a
vendor is as an integration partner. It replaces the old
`vendor_data_completeness` ratio, which only measured how much we knew about
a vendor, not how good the vendor was.

VQS is computed by the `vendor-score` workflow as a pure function — no LLM,
no external API calls — over fields already populated by `vendor-overview`,
`vendor-github`, and `vendor-funding`.

---

## Goals

A good vendor score should answer at least one of:

1. **Credibility** — Will this vendor still exist in two years?
2. **Momentum** — Are they growing or decaying right now?
3. **Integration Fit** — Are they relevant to AEC and technically integratable?

VQS is the weighted blend of three sub-scores, each in `[0, 100]`, addressing
those three questions.

```
VQS = 0.35 × Credibility + 0.35 × Momentum + 0.30 × Fit
```

When a pillar is `null` (insufficient inputs), the remaining pillars are
renormalized so missing data lowers confidence, not the score itself.

`vendor_data_completeness` is preserved as a separate field — a data-hygiene
flag, not a vendor verdict.

---

## Pillar 1 — Credibility (35%)

> "Is this a real, durable business?"

Sum the points below; cap at 100.

| Signal | Source | Transform | Max |
|---|---|---|---|
| Public company | `public_private` | `=== "Public"` → +35 | 35 |
| Acquired / has parent | `parent_company` | non-empty → +25 | 25 |
| Funding stage ladder | `funding_stage` | see ladder | 35 |
| Crunchbase rank (lower = better) | `crunchbase_rank` | `max(0, 20 × (1 − log10(rank) / log10(500_000)))` — rank 1 → 20, 100K → 4, ≥500K → 0 | 20 |
| Company age | `founded_year` | `min(20, max(0, (current_year − founded_year)) × 1.5)` — 0 yrs → 0, 13+ yrs → 20 | 20 |

### Funding stage ladder

| Stage | Points |
|---|---|
| `Public` | 35 |
| `Series D+` | 35 |
| `Acquired` | 30 |
| `Series C` | 30 |
| `Series B` | 25 |
| `Series A` | 18 |
| `Seed` | 10 |
| `Pre-seed` | 5 |
| `Bootstrapped` | 5 |
| `Unknown` / null | 0 |

### Why no `total_funding_usd`?

Total funding correlates with stage but adds noise: a Series D with $200M
scores nearly identical to a Series D with $500M, but the second isn't twice
as credible. We get the same signal cheaper and more comparably from
`funding_stage` plus rank.

The 20 points freed up by removing `total_funding_usd` are redistributed: 10
to `crunchbase_rank` (now max 20 instead of 15) and 10 to `founded_year`
(now max 20 instead of 15) — both inputs that better discriminate at the
top of the ladder where stage saturates.

### Sufficiency rule

Credibility is `null` if fewer than 2 of the 5 signals are populated. A
vendor with only `funding_stage` set (and nothing else) does not earn a
credibility verdict from a single data point.

---

## Pillar 2 — Momentum (35%)

> "Are they growing right now, or coasting?"

Sum the points below; cap at 100.

| Signal | Source | Transform | Max |
|---|---|---|---|
| Crunchbase Growth Score | `crunchbase_growth_score` | `value × 0.35` (passthrough scaled to 35) | 35 |
| Crunchbase Heat Score | `crunchbase_heat_score` | `value × 0.20` | 20 |
| Monthly web visits | `monthly_web_visits` | `min(20, 20 × log10(max(1, visits)) / log10(10_000_000))` — saturates at 10M/mo | 20 |
| GitHub last commit | `github_last_commit_days_ago` | piecewise: 0d→25, 30d→20, 90d→13, 180d→7, 365d+→0 (linear in between) | 25 |

### Public-company adjustment

Crunchbase typically returns `null` for `growth_score` and `heat_score` on
publicly traded companies (their model is tuned for private-company signal).
When `public_private === "Public"` and **both** scores are null, substitute
a neutral 50 for each before scaling:

- `growth_score = 50` → contributes 17.5 / 35
- `heat_score = 50`  → contributes 10 / 20

This avoids penalizing public companies for a Crunchbase data policy. The
substitution is bounded — public companies still have to earn momentum
points from web traffic, GitHub activity, and blog recency — and triggers
the `public_company_estimated` flag in the output for transparency.

If only one of the two CB scores is null on a public company, only that one
is substituted; the other passes through directly.

### Sufficiency rule

Momentum is `null` if fewer than 2 of the 4 signals are populated (counting
substituted public-company values as populated).

---

## Pillar 3 — Integration Fit (30%)

> "Are they technically integratable, and are they relevant to AEC?"

Sum the points below; cap at 100.

| Signal | Source | Transform | Max |
|---|---|---|---|
| Has SDK repo | `has_sdk_repo` | `=== true` → +30 | 30 |
| GitHub org verified | `github_org_verified` | `=== true` → +15 | 15 |
| GitHub repo count | `github_repo_count` | `min(15, 15 × log10(max(1, count)) / log10(50))` — saturates at 50 repos | 15 |
| GitHub stars total | `github_stars_total` | `min(15, 15 × log10(max(1, stars)) / log10(10_000))` — saturates at 10K | 15 |
| AEC category match | `crunchbase_categories` | see mapping; ≥1 match → +15, ≥2 matches → +25 | 25 |

### AEC category mapping

A vendor's `crunchbase_categories` array is intersected with the AEC-relevant
set below. Matching is case-insensitive and exact (Crunchbase categories are
a controlled vocabulary).

**Strong AEC categories** (each match counts toward `aec_match_count`):

```
Construction
Building Maintenance
Building Material
Architecture
Engineering
Civil Engineering
Mechanical Engineering
Structural Engineering
Industrial Engineering
Real Estate
Property Management
Commercial Real Estate
Real Estate Investment
Facility Management
Infrastructure
Smart Building
Smart Cities
Building Information Modeling
BIM
3D Technology
CAD
GIS
Surveying
Project Management
Construction Management
Field Service
Heavy Industry
Manufacturing
Industrial Automation
Supply Chain Management
Procurement
Contractors
```

Scoring:
- `aec_match_count === 0` → 0 points
- `aec_match_count === 1` → 15 points
- `aec_match_count >= 2` → 25 points

**Notes on the mapping:**
- The empirical sample from our own data (April 2026) shows: `Construction`,
  `Software`, `Risk Management`, `Supply Chain Management`, `Industrial
  Automation`, `Productivity Tools`. We exclude generic categories like
  `Software` and `Productivity Tools` because virtually every vendor in our
  database carries them — they don't discriminate.
- We include adjacent categories (`Field Service`, `Manufacturing`, `Heavy
  Industry`) because AEC overlaps them in practice (e.g., prefab, modular,
  industrial construction).
- The list is intentionally generous on the strong-AEC side. False positives
  here are recoverable (max +25); false negatives mean a real AEC vendor
  scores artificially low.

### Sufficiency rule

Fit is `null` if all five signals are unavailable (no GitHub data AND no
Crunchbase categories). A vendor with only `crunchbase_categories` set still
gets a Fit score — it just has a low ceiling (max 25 from category alone).

---

## Composite VQS

```
denom   = sum of weights for non-null pillars
numer   = sum of (pillar × weight) for non-null pillars
VQS     = round(numer / denom)   // integer 0..100
```

If all three pillars are `null`, `VQS = null` and `vqs_tier = "unscored"`.

### Tier banding

| VQS | Tier | Meaning |
|---|---|---|
| 80–100 | **Tier 1** | Established + active + integratable. Pursue. |
| 60–79  | **Tier 2** | Strong on 2 of 3 pillars. Likely worth talking to. |
| 40–59  | **Tier 3** | Mixed signals. Investigate. |
| 20–39  | **Tier 4** | Weak across pillars. Deprioritize. |
| 0–19   | **Tier 5** | Likely dormant or wrong fit. |
| `null` | **Unscored** | Not enough data — needs enrichment. |

### Confidence

`vqs_confidence` is a coarse data-quality signal independent of the score:

- **`high`**: all three pillars present, plus at least 7 of the 12 input
  signals across them populated.
- **`medium`**: at least 2 pillars present, and 4–6 input signals.
- **`low`**: 1 pillar present, or fewer than 4 inputs total.

### Flags

`vqs_flags` is a JSON-stringified array of strings, attached for
transparency in the UI:

- `public_company_estimated` — at least one CB score (`growth` or `heat`)
  was null and substituted with the neutral 50 for a public company.
- `missing_crunchbase` — no `crunchbase_checked_at` timestamp at all (the
  vendor-overview run hasn't succeeded yet).
- `missing_github` — `github_org` is null (no GitHub presence found, so the
  whole Fit pillar may be skewed).
- `unscored` — VQS itself is `null`.

---

## Worked examples

### Example A — Autodesk (public, AEC giant)

Inputs (illustrative):
- `public_private`: "Public", `parent_company`: null, `funding_stage`: "Public",
  `crunchbase_rank`: 50, `founded_year`: 1982
- `crunchbase_growth_score`: null, `crunchbase_heat_score`: null,
  `monthly_web_visits`: 25_000_000, `github_last_commit_days_ago`: 0,
  `blog_last_post_days_ago`: 30
- `has_sdk_repo`: true, `github_org_verified`: true, `github_repo_count`: 200,
  `github_stars_total`: 25_000, categories: [Software, BIM, 3D Technology, CAD]

Credibility: 35 (public) + 0 (no parent) + 35 (Public stage) + 20 (rank 50) +
20 (>13 yrs) = 100, **capped at 100**.

Momentum: growth/heat null → public substitution → 17.5 + 10 + 20 (visits
saturate) + 25 (commit 0d) ≈ **72** (capped via 100 ceiling, here actual
sum 72.5), flagged `public_company_estimated`.

Fit: 30 (SDK) + 15 (verified) + 15 (repos saturate) + 15 (stars saturate) +
25 (AEC ≥2) = 100, **capped at 100**.

VQS = 0.35×100 + 0.35×72 + 0.30×100 = **95** → **Tier 1**.

### Example B — Bootstrapped 2-year-old AEC startup with SDK

Inputs:
- `funding_stage`: "Bootstrapped", `founded_year`: 2024, `crunchbase_rank`:
  300_000, public/parent both null
- `crunchbase_growth_score`: 65, `crunchbase_heat_score`: 70,
  `monthly_web_visits`: 50_000, `github_last_commit_days_ago`: 5
- `has_sdk_repo`: true, `github_org_verified`: true, `github_repo_count`:
  12, `github_stars_total`: 800, categories: [Construction, Software]

Credibility: 0 + 0 + 5 (Bootstrapped) + ~3 (rank 300K) + 3 (2 yrs) =
**11** (3 of 5 signals → not null).

Momentum: 22.75 + 14 + ~12 + ~24 = **73**.

Fit: 30 + 15 + ~10 + ~9 + 15 (1 AEC match) = **79**.

VQS = 0.35×11 + 0.35×73 + 0.30×79 = **53** → **Tier 3** — accurately
reflects "great fit and momentum, unproven business durability."

### Example C — Unenriched vendor (only company name)

All pillars `null` → VQS = `null`, `vqs_tier = "unscored"`,
`vqs_flags = ["unscored", "missing_crunchbase", "missing_github"]`.

---

## Output schema (Airtable fields)

The `vendor-score` workflow writes:

| Field | Type | Notes |
|---|---|---|
| `vqs_score` | number | 0–100, or null when unscored |
| `vqs_credibility` | number | 0–100, nullable |
| `vqs_momentum` | number | 0–100, nullable |
| `vqs_fit` | number | 0–100, nullable |
| `vqs_tier` | singleSelect | `Tier 1` … `Tier 5` or `Unscored` |
| `vqs_confidence` | singleSelect | `high` / `medium` / `low` |
| `vqs_flags` | multilineText | JSON-stringified `string[]` |
| `vendor_data_completeness` | percent | unchanged — counts populated input signals (data hygiene) |
| `vendor_enrichment_status` | singleSelect | unchanged — `enriched` / `partial` / `error` based on data hygiene |
| `last_enriched_at` | dateTime | unchanged |

The legacy `vendor_data_completeness` is now computed over the VQS input
fields only (the 12 signals listed in the pillar tables above), not the old
set of six signals — its meaning of "data hygiene" is preserved.

---

## Removed workflows

The following leaf enrichment workflows are deleted because none of their
outputs feed VQS:

- `vendor-linkedin` — `linkedin_followers` is a vanity signal; LinkedIn URL
  was already a curator-set field on the record.
- `vendor-company-size` — `company_size` is no longer scored. Crunchbase
  fills the field directly when available; that's enough for display.
- `vendor-press` — `press_count_12mo` is too noisy (Google News RSS
  surfaces SEO syndication). Not a reliable momentum signal.
- `vendor-blog-recency` — `blog_last_post_days_ago` is dropped from the
  score. The cost of the LLM blog-discovery turn isn't justified for a
  signal that's redundant with `github_last_commit_days_ago` for any
  vendor that ships software. We may revisit if we find a cheap
  Crunchbase-driven way to detect blog dormancy.

The `vendor-funding` workflow continues to run, but only writes
`funding_stage` and `funding_checked_at` — `total_funding_usd`,
`last_funding_date`, and `funding_source_url` are no longer scored, and the
LLM cost of producing them isn't justified. The fields remain on the
Airtable schema for now in case curators want to use them manually.
