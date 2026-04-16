# Tool Scoring Plan

**Scope:** Enrich individual tools with product-level signals, compute a priority score per tool using both tool-level and vendor-level data, and assign tiers for launch prioritization.

---

## Part 1 — Airtable schema changes

### Existing Tools table fields (already present)

| Field | ID | Type |
|---|---|---|
| Name | `fldH1125P4DzL08dL` | singleLineText |
| Category | `fldo9cjoZ0BdFGbWm` | multipleRecordLinks → Categories |
| Vendors | `fldBWNd5zfMRDh36F` | multipleRecordLinks → Vendors |
| Website | `fldQM3iN36uTeiMOp` | url |
| Description | `fldmahsTEvEaa1nSD` | multilineText |
| Supported Disciplines | `fldCQYNoV4I6P51fU` | multipleRecordLinks |
| Supported Project Phases | `fld2PuvDzH5wtCuQe` | multipleRecordLinks |
| Tool Integrations (Source) | `fldDUAor00GmvenJE` | multipleRecordLinks |
| Tool Integrations (Target) | `fldSK6xKk9AswaMLc` | multipleRecordLinks |
| Research Status | `fldr04Baav7Oadqwm` | singleSelect (Complete/Partial/Failed/Pending) |
| Research Notes | `fldNaZoW1lvdhmdw8` | multilineText |

### Existing fields to rename (snake_case consistency)

| Current name | New name |
|---|---|
| Name | (leave — it's the primary field) |
| Category | category |
| Vendors | vendors |
| Website | website |
| Description | description |
| Supported Disciplines | supported_disciplines |
| Supported Project Phases | supported_project_phases |
| Tool Integrations (Source Tool) | tool_integrations_source |
| Tool Integrations (Target Tool) | tool_integrations_target |
| Research Status | research_status |
| Research Notes | research_notes |

### New fields to add — grouped by workflow

**WT-APICheck (API documentation detection)**
| Field | Type | Description |
|---|---|---|
| `has_api_docs` | Checkbox | True if a developer portal was detected |
| `api_docs_url` | URL | Matched URL |
| `api_docs_checked_at` | DateTime | Timestamp |

**WT-Marketplace (AEC marketplace presence)**
| Field | Type | Description |
|---|---|---|
| `source_marketplaces` | Multi-select: `Procore`, `ACC`, `Trimble`, `Bluebeam` | Which AEC marketplaces list this tool |
| `marketplace_count` | Number | Count of marketplaces (0-4) |
| `marketplace_checked_at` | DateTime | Timestamp |

**WT-iPaaS (Zapier/Make/Workato presence)**
| Field | Type | Description |
|---|---|---|
| `ipaas_platforms` | Multi-select: `Zapier`, `Make`, `Workato` | Which iPaaS platforms list this tool |
| `ipaas_count` | Number | Count (0-3) |
| `zapier_trigger_count` | Number | Number of Zapier triggers+actions (integration maturity signal) |
| `ipaas_checked_at` | DateTime | Timestamp |

**WT-Reviews (G2 + Capterra reviews)**
| Field | Type | Description |
|---|---|---|
| `g2_review_count` | Number | Total reviews on G2 |
| `g2_rating` | Number (1 decimal) | Average G2 rating |
| `g2_url` | URL | G2 product page |
| `capterra_review_count` | Number | Total reviews on Capterra |
| `capterra_rating` | Number (1 decimal) | Average Capterra rating |
| `capterra_url` | URL | Capterra product page |
| `reviews_checked_at` | DateTime | Timestamp |

**WT-SearchDemand (Google Trends + search volume)**
| Field | Type | Description |
|---|---|---|
| `search_volume_monthly` | Number | Estimated monthly search volume |
| `google_trends_index` | Number | 12-month average Google Trends index (0-100 relative) |
| `search_checked_at` | DateTime | Timestamp |

**WT-Reddit (community mentions)**
| Field | Type | Description |
|---|---|---|
| `reddit_mentions_24mo` | Number | Reddit mentions across AEC subreddits in last 24 months |
| `reddit_checked_at` | DateTime | Timestamp |

**WT-IntegrationCount (derived from Tool Integrations table)**
| Field | Type | Description |
|---|---|---|
| `integration_count` | Number | Count of Tool Integration records where this tool is source or target. Can be a rollup or workflow-computed. |
| `integration_count_checked_at` | DateTime | Timestamp |

**Scoring fields (written by WT-Score)**
| Field | Type | Description |
|---|---|---|
| `integration_score` | Number (1 decimal) | 0-100 product integration score |
| `demand_score` | Number (1 decimal) | 0-100 buyer demand score |
| `outreach_score` | Number (1 decimal) | 0-100 outreach viability (pulled from vendor via lookup) |
| `priority_score` | Number (1 decimal) | Composite 0-100 score |
| `priority_tier` | Single select: `1`, `2`, `3`, `4` | Tier assignment |
| `emerging_flag` | Checkbox | Auto-set for young tools with strong signals |
| `tool_data_completeness` | Percent | % of enrichment fields populated |
| `tool_enrichment_status` | Single select: `pending`, `enriching`, `enriched`, `partial`, `error` | Overall status |
| `last_tool_enriched_at` | DateTime | Timestamp |
| `last_scored_at` | DateTime | When scoring was last computed |

### Vendor lookup fields (on Tools table, read-only)

These pull vendor data into the Tools table via the existing `vendors` link field. They make vendor data available to the scoring formula without extra API calls:

| Field | Type | Description |
|---|---|---|
| `vendor_outreach_score` | Lookup → Vendors.vendor_outreach_score | For computing tool-level outreach score. Note: `vendor_outreach_score` doesn't exist yet on Vendors — needs to be added when we build vendor scoring. |
| `vendor_company_size` | Lookup → Vendors.company_size | For the outreach sweet-spot curve |
| `vendor_funding_stage` | Lookup → Vendors.funding_stage | For outreach scoring |
| `vendor_has_partner_program` | Lookup → Vendors.has_partner_program | For outreach scoring |

**Note:** Airtable lookup fields can't be created via API — they must be created manually in the Airtable UI. Document this for the user.

---

## Part 2 — Tool enrichment workflows

### Workflow architecture

Same pattern as vendor enrichment: each workflow is independently callable, takes a `record_id`, fetches the tool record, enriches specific fields, writes results back.

```
Tool Enrichment Workflows (one per signal):
├── WT-APICheck        — detect /api, /developers, /api-docs on tool website
├── WT-Marketplace     — match tool against pre-scraped AEC marketplace indexes
├── WT-iPaaS           — match tool against Zapier/Make/Workato app indexes
├── WT-Reviews         — G2 + Capterra review counts and ratings (Apify)
├── WT-SearchDemand    — Google Trends + search volume
├── WT-Reddit          — subreddit mention counts
├── WT-IntegrationCount— count existing Tool Integration records in Airtable
├── WT-Score           — compute scores (pure math, no external calls)
└── WT-ToolOrchestrator— dispatch all above in order
```

### WT-APICheck

**Purpose:** Detect a developer portal / API docs for this specific tool.

**Input:** `{ record_id }` — fetches tool record, reads `website` field.

**Logic:**
1. Derive tool_domain from the tool's website (not the vendor's — some tools have their own domain like `openspace.ai` vs the vendor `openspace.com`)
2. HTTP check common paths: `/api`, `/developers`, `/api-docs`, `/developer`, `/developer-portal`, `docs.{domain}`
3. For first 200 response with >2KB body, use Claude Haiku to confirm it's a real developer/API page
4. Write `has_api_docs`, `api_docs_url`, `api_docs_checked_at`

**Cost:** Free + $0.002 Claude per matched page. ~$1.50/1K tools.

### WT-Marketplace

**Purpose:** Check if this tool appears on Procore, ACC, Trimble, or Bluebeam marketplaces.

**Key design choice:** Don't scrape marketplaces per tool — scrape all four marketplace indexes once (see W01 from earlier plan), cache the results in n8n static data or a lookup table, then do O(1) matching per tool.

**Input:** `{ record_id }` — fetches tool record, reads `Name` and `website`.

**Logic:**
1. Load cached marketplace index (tool name → marketplace list) from n8n static data
2. Match by tool name (fuzzy) and/or domain
3. If no match in cache, try Claude Haiku: *"Is '{tool_name}' listed on any of these AEC marketplaces: Procore, Autodesk Construction Cloud, Trimble, Bluebeam? Return JSON."*
4. Write `source_marketplaces`, `marketplace_count`, `marketplace_checked_at`

**Pre-dependency:** Run the marketplace scraper (W01 from original plan) at least once before this workflow. Or consolidate: WT-Marketplace *is* the per-tool version of the marketplace check.

**Cost:** Near-zero if using cache. $0.002/tool with Claude fallback.

### WT-iPaaS

**Purpose:** Check Zapier, Make, Workato for this tool.

**Same caching pattern as WT-Marketplace:**
1. Pre-scrape all three iPaaS app indexes (Zapier: `zapier.com/apps`, Make: `make.com/en/integrations`, Workato: `workato.com/integrations`) once into a JSON cache
2. Match tool name against cache
3. For Zapier matches, fetch the app page to count triggers+actions (measure of integration depth)
4. Write `ipaas_platforms`, `ipaas_count`, `zapier_trigger_count`, `ipaas_checked_at`

**Cost:** Near-zero with cache. Zapier trigger count fetch adds ~$0.005/matched tool via Apify.

### WT-Reviews

**Purpose:** G2 + Capterra review counts and ratings.

**Input:** `{ record_id }` — reads tool `Name`.

**Logic:**
1. Apify: search G2 for tool name → extract `reviewCount`, `averageRating`, `url`
2. Apify: search Capterra for tool name → extract same
3. Write all six fields

**Cost:** ~$0.005/tool (Apify). $5/1K tools. This is the only tool workflow that requires Apify.

### WT-SearchDemand

**Purpose:** Buyer search volume and trend trajectory.

**Logic:**
1. Google Trends via Pytrends: 12-month interest for `{tool_name}`
2. SearchVolume.io or Google Keyword Planner: monthly volume for `"{tool_name} software"` and `"{tool_name} reviews"`
3. Write `search_volume_monthly`, `google_trends_index`, `search_checked_at`

**Gotcha:** Same rate-limit issue as vendor Trends workflow — run overnight for bulk.

**Cost:** Free. ~16 hours for 1,000 tools due to rate limits.

### WT-Reddit

**Purpose:** Community discussion volume.

**Logic:**
1. Reddit API (PRAW via HTTP): search 5 subreddits (r/Construction, r/AEC, r/Revit, r/civilengineering, r/ConstructionManagement) for tool name, last 24 months
2. Count matching posts + comments
3. Write `reddit_mentions_24mo`, `reddit_checked_at`

**Cost:** Free. ~2 seconds/tool.

### WT-IntegrationCount

**Purpose:** Count how many entries exist in the Tool Integrations table where this tool is either source or target. This is the *actual* integration density signal — direct from your own data, not a proxy.

**Logic:**
1. Fetch the tool record — read `tool_integrations_source` and `tool_integrations_target` linked record arrays
2. Count unique linked records: `integration_count = (source links).length + (target links).length`
3. Write `integration_count`, `integration_count_checked_at`

**No external calls at all.** Pure Airtable read + write. This is the cheapest and most accurate integration signal in the system, but it's only useful once you have Tool Integration records populated.

**Cost:** $0. Milliseconds per tool.

### WT-Score

**Purpose:** Compute scores. Pure math, no external calls. Runs after all enrichment workflows complete.

**Input:** `{ record_id }` — fetches tool record (all enrichment fields) + vendor record (via linked `vendors` field).

**The formula:**

```
PRIORITY_SCORE = 0.40 × Integration_Score + 0.35 × Demand_Score + 0.25 × Outreach_Score
```

#### Integration Score (0-100) — tool-level signals only

```
integration_score =
    0.30 × normalize(log(marketplace_count + 1))       # AEC marketplace presence
  + 0.25 × (has_api_docs ? 100 : 0)                    # API docs exist
  + 0.20 × normalize(log(integration_count + 1))       # Actual integrations in our DB
  + 0.15 × normalize(log(ipaas_count + 1))             # iPaaS presence
  + 0.10 × normalize(log(zapier_trigger_count + 1))    # Zapier depth
```

Note: `github_stars_total` and `has_sdk_repo` from the vendor are **not** in the integration score. They're useful context but they describe the vendor, not this specific product's integrability. If we need a vendor-capability boost, add it as a small bonus (+5 points if `vendor.has_sdk_repo`) rather than a weighted sub-signal.

#### Demand Score (0-100) — tool-level signals only

```
demand_score =
    0.30 × normalize(log(g2_review_count + capterra_review_count + 1))  # Review volume
  + 0.25 × bayesian_rating(g2_rating, g2_review_count)                 # Quality-adjusted rating
  + 0.20 × normalize(log(search_volume_monthly + 1))                   # Absolute demand
  + 0.15 × normalize(google_trends_index, 0, 100)                      # Relative trajectory
  + 0.10 × normalize(log(reddit_mentions_24mo + 1))                    # Community presence
```

Bayesian rating (same formula from original plan):
```
WR = (v/(v+m)) × R + (m/(v+m)) × C
where v = review count, m = 15, R = tool's avg rating, C = category mean (~4.1)
then scale to 0-100: WR / 5 * 100
```

#### Outreach Score (0-100) — vendor-level signals, read via lookup

```
outreach_score =
    0.30 × employee_sweet_spot(vendor.company_size)     # Outreach responsiveness curve
  + 0.25 × (vendor.has_partner_program ? 100 : 0)      # Partner program exists
  + 0.20 × funding_score(vendor.funding_stage)          # Funding = budget + marketing
  + 0.15 × normalize(log(vendor.press_count_12mo + 1))  # Marketing activity
  + 0.10 × blog_recency_score(vendor.blog_last_post_days_ago) # Active marketing team
```

The outreach score is **identical for all tools from the same vendor**. This is correct — outreach happens at the vendor level. The reason it's still on the tool record is so you can sort/filter tools by a single `priority_score` without joins.

#### Employee sweet-spot curve

```
1-10:       20
11-50:      50
51-200:    100
201-1000:   90
1001-5000:  60
5000+:      30
```

#### Funding score

```
Bootstrapped:  40
Pre-seed:      30
Seed:          50
Series A:      80
Series B:      90
Series C:     100
Series D+:     85
Public:        50
Acquired:      40
Unknown:       30
```

#### Normalization

All `normalize()` calls use **within-category min-max normalization**:
1. Group tools by their primary category (from `category` linked field)
2. For each signal, compute `min` and `max` across the category
3. `normalize(x) = max(0, min(100, (x - min) / (max - min) * 100))`

Pre-compute category min/max values in a first pass, cache in n8n static data, then apply per tool.

For tools where `category` is empty, fall back to global normalization.

#### Missing data handling

| Missing signal | Imputation |
|---|---|
| Review count = 0 | Keep 0 (meaningful — truly no reviews) |
| Review rating missing | Use category mean (Bayesian pulls to ~4.1 anyway) |
| Search volume missing | Use category 25th percentile |
| integration_count = 0 | Keep 0 (meaningful — no integrations mapped yet) |
| marketplace_count = 0 | Keep 0 |
| Vendor fields missing | Use neutral defaults (company_size → '201-1000' midpoint, funding → 'Unknown', etc.) |

#### Data completeness

```
tool_data_completeness = (non-null signals out of 10) / 10
```

The 10 signals: `has_api_docs`, `marketplace_count`, `ipaas_count`, `g2_review_count`, `g2_rating`, `search_volume_monthly`, `google_trends_index`, `reddit_mentions_24mo`, `integration_count`, and vendor outreach data available.

### Tiering

After scoring all tools, apply Jenks Natural Breaks (4 classes):

| Tier | Expected profile | Action |
|---|---|---|
| 1 (Must-Have) | ~30-50 tools, score ≥ 80 | Seed immediately, full integration mapping, proactive outreach |
| 2 (High Priority) | ~100-200, score 55-79 | Seed within first month, profiles from public data |
| 3 (Standard) | ~300-500, score 30-54 | Basic profiles, reactive outreach |
| 4 (Long Tail) | ~500+, score < 30 | Minimal profiles, revisit quarterly |

### Emerging-tool bypass

Force Tier 2 if ALL of:
- Vendor `founded_year > NOW - 4` (young company)
- `has_api_docs = true` (integration-ready)
- `marketplace_count >= 1` (already in an AEC ecosystem)

---

## Part 3 — Orchestrator (WT-ToolOrchestrator)

### Execution order

Dependencies exist:
- **WT-IntegrationCount** has no external dependency but needs Tool Integration records populated (from your existing data pipeline or manual entry)
- **WT-Score** must run AFTER all enrichment workflows AND after vendor enrichment is complete
- Everything else is independent and parallelizable

```
Phase 0: Ensure vendor enrichment is done
         (Check that linked vendor has vendor_enrichment_status = 'enriched')

Phase 1: Parallel enrichment (all independent)
         ├── WT-APICheck
         ├── WT-Marketplace
         ├── WT-iPaaS
         ├── WT-Reviews
         ├── WT-SearchDemand
         ├── WT-Reddit
         └── WT-IntegrationCount

Phase 2: Scoring (after all Phase 1 complete)
         └── WT-Score

Phase 3: Tier assignment (after all scoring)
         └── WT-TierAssign (or inline in WT-Score)
```

### Orchestrator nodes

```
Trigger (Manual / Cron)
        │
        ▼
Query Tools to Enrich (Airtable List)
  filter: tool_enrichment_status IN ('pending', 'partial')
          OR last_tool_enriched_at < NOW - 90d
        │
        ▼
Pre-check: Is Vendor Enriched?
  For each tool, read linked vendor's vendor_enrichment_status.
  IF vendor not enriched → skip tool, set note "vendor not enriched yet"
  IF vendor enriched → proceed
        │
        ▼
Set tool_enrichment_status = 'enriching'
        │
        ▼
Phase 1: Execute all 7 enrichment workflows (parallel, Wait=false)
  ├── Execute Workflow: WT-APICheck       (record_id)
  ├── Execute Workflow: WT-Marketplace    (record_id)
  ├── Execute Workflow: WT-iPaaS          (record_id)
  ├── Execute Workflow: WT-Reviews        (record_id)
  ├── Execute Workflow: WT-SearchDemand   (record_id)
  ├── Execute Workflow: WT-Reddit         (record_id)
  └── Execute Workflow: WT-IntegrationCount (record_id)
        │
        ▼ (all complete)
Phase 2: Execute Workflow: WT-Score (record_id)
        │
        ▼
Compute tool_data_completeness
Update tool_enrichment_status ('enriched' if ≥75%, 'partial' if ≥40%, 'error' if <40%)
Write last_tool_enriched_at
        │
        ▼
Batch loop continues
        │
        ▼
Optional: Gmail notification summary
```

### Important: Score computation needs category context

WT-Score can't run per-tool in isolation because normalization requires category min/max values. Two approaches:

**Option A: Two-pass scoring (recommended)**
1. First pass: run all enrichment workflows for all tools
2. Then run WT-Score as a batch job that:
   a. Fetches ALL enriched tools
   b. Computes per-category min/max
   c. Normalizes and scores all tools at once
   d. Writes scores + tiers back

This is more efficient (one Airtable list call, batch update) and gives correct normalization.

**Option B: Pre-compute min/max, then score per-tool**
1. A separate workflow runs first, queries all tools, computes min/max per category, stores in n8n static data
2. Then WT-Score runs per-tool using the cached min/max values

Option B is simpler per-tool but requires an extra pre-computation step and can get stale.

**Recommendation: Option A.** WT-Score should be a batch workflow that the orchestrator calls once after all individual tool enrichments complete, not per-tool.

### Scheduling

**Initial backfill:**
- Manual trigger
- Process all tools
- Estimated runtime: 20-40 hours for 1,000 tools (mostly Google Trends rate limits)
- Estimated cost: ~$20 (Apify for reviews) + ~$5 (Claude calls) = ~$25

**Quarterly re-enrichment:**
- Cron: re-run WT-Reviews, WT-SearchDemand, WT-Reddit (the signals that drift fastest)
- Re-run WT-Score on all tools after
- Skip WT-APICheck, WT-Marketplace, WT-iPaaS (change slowly)

**On-demand (new tool added):**
- Webhook on new Airtable row → full enrichment pipeline
- WT-Score can run per-tool using stale min/max from last batch run (close enough)

---

## Summary of what to build

### Build order

| # | What | Effort | Cost per 1K tools |
|---|---|---|---|
| 1 | Airtable schema additions (fields) | 1 hour | — |
| 2 | WT-IntegrationCount | 30 min | $0 |
| 3 | WT-APICheck | 2 hours | $1.50 |
| 4 | WT-Marketplace | 3 hours (cache setup) | ~$0 |
| 5 | WT-iPaaS | 2 hours (cache setup) | ~$0 |
| 6 | WT-Reviews | 2 hours | $5 |
| 7 | WT-SearchDemand | 2 hours | $0 |
| 8 | WT-Reddit | 1 hour | $0 |
| 9 | WT-Score (batch) | 3 hours | $0 |
| 10 | WT-ToolOrchestrator | 2 hours | — |

**Total estimated cost per 1,000-tool scoring run: ~$25**
(vs ~$57 for vendors — tools are cheaper because fewer LLM calls)

### Validation checkpoint

Score these 5 tools first and verify rankings match intuition:
1. **Procore** — should be Tier 1 (massive reviews, marketplace hub, high demand)
2. **Revit** — should be Tier 1 (dominant BIM tool, enormous search volume)
3. **Bluebeam Revu** — should be Tier 1 or top of Tier 2
4. **A mid-tier scheduling tool** (e.g., Primavera P6) — Tier 2
5. **A niche/unknown tool** — Tier 3 or 4

If the scores don't match, tune weights before scaling.