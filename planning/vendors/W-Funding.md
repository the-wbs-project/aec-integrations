# W-Funding

Determine vendor's funding stage, total funding, and most recent round. Uses Claude with web search — Crunchbase's free API is too stingy and scraping Crunchbase is blocked.

## Purpose

Funding stage is a strong outreach-readiness signal. Series A-D companies have budgets and marketing teams; public companies have brand value but slower procurement; bootstrapped/unknown need different outreach approaches.

## Airtable fields written

| Field | Type | Description |
|---|---|---|
| `funding_stage` | Single select | `Bootstrapped`, `Pre-seed`, `Seed`, `Series A-D+`, `Public`, `Acquired`, `Unknown` |
| `total_funding_usd` | Currency | Total raised in USD |
| `last_funding_date` | Date | Date of most recent round |
| `funding_source_url` | URL | Where the data came from |
| `funding_checked_at` | DateTime | Always set |

## Input

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

## Node flow

```
Trigger → Get Vendor Record → Normalize → Has Required?
                                               │ yes
                                               ▼
                                 Check Existing Data (IF)
                                 "Is public_private='Public'?"
                                /                            \
                             Yes                              No
                              │                                │
                              ▼                                ▼
                      Skip to: Stage=Public         Claude with web_search:
                                                    Look up funding
                              │                                │
                              └────────────┬───────────────────┘
                                           ▼
                                  Parse Response (Code)
                                           │
                                           ▼
                                  Update Vendor Record
                                           │
                                           ▼
                                  Format Return Value
```

## Key nodes

### Check Existing Data (IF)

Short-circuit for vendors already known to be public. The `public_private` field exists on the Vendors table.

- Condition: `{{ $('Get Vendor Record').item.json.fields.public_private }}` equals `"Public"`
- True → skip Claude call, set funding_stage=Public
- False → Claude with web search

### Claude: Funding Lookup (Basic LLM Chain)

**Model:** `claude-sonnet-4-6` (Sonnet — web_search required).
**Tools:** enable `web_search`.

**Prompt:**
```
What is the funding status of '{{ $json.company_name }}' ({{ $json.vendor_domain }})?

Search Crunchbase, press releases, TechCrunch, and the company's about/news pages. Return the most recent confirmed funding information.

Return JSON:
{
  "funding_stage": one of ["Bootstrapped","Pre-seed","Seed","Series A","Series B","Series C","Series D+","Public","Acquired","Unknown"],
  "total_funding_usd": number | null,
  "last_funding_date": "YYYY-MM-DD" | null,
  "source_url": "https://..." | null,
  "confidence": "low" | "medium" | "high",
  "notes": "brief"
}

Notes:
- Use "Public" if the company is publicly traded (any exchange).
- Use "Acquired" if acquired by another company (note the acquirer in notes).
- Use "Bootstrapped" only if you find explicit evidence (founder statements, "never raised", etc.), NOT just absence of funding data.
- Use "Unknown" if you cannot determine with medium+ confidence.
- total_funding_usd should be total disclosed funding across all rounds.
```

**Output schema example:**
```json
{
  "funding_stage": "Series C",
  "total_funding_usd": 250000000,
  "last_funding_date": "2024-03-15",
  "source_url": "https://techcrunch.com/2024/03/example",
  "confidence": "high",
  "notes": "Led by Andreessen Horowitz"
}
```

### Skip to Public (Code — for the IF=true branch)

```javascript
const context = $('Normalize Input').item.json;
const existing = $('Get Vendor Record').item.json.fields;

return {
  record_id: context.record_id,
  funding_stage: 'Public',
  total_funding_usd: null,
  last_funding_date: null,
  funding_source_url: existing.source_url || null,
  funding_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['funding_stage','funding_checked_at'],
  note: 'Stage inferred from existing public_private field'
};
```

### Parse Response (Code)

```javascript
const parsed = $input.item.json.output || $input.item.json;
const context = $('Normalize Input').item.json;

// Validate enum
const validStages = ['Bootstrapped','Pre-seed','Seed','Series A','Series B','Series C','Series D+','Public','Acquired','Unknown'];
const stage = validStages.includes(parsed.funding_stage) ? parsed.funding_stage : 'Unknown';

// Validate date
let lastDate = null;
if (parsed.last_funding_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.last_funding_date)) {
  lastDate = parsed.last_funding_date;
}

const low = parsed.confidence === 'low' || stage === 'Unknown';

return {
  record_id: context.record_id,
  funding_stage: stage,
  total_funding_usd: (typeof parsed.total_funding_usd === 'number' ? parsed.total_funding_usd : null),
  last_funding_date: lastDate,
  funding_source_url: parsed.source_url || null,
  funding_checked_at: new Date().toISOString(),
  needs_manual_review: low,
  status: low ? 'partial' : 'success',
  fields_updated: ['funding_stage','total_funding_usd','last_funding_date','funding_source_url','funding_checked_at'],
  note: parsed.notes || null
};
```

## Error handling

- Claude web_search occasionally fails or returns hallucinated data → `confidence: low` triggers `needs_manual_review=true`
- Rate limits on web_search: Anthropic has per-minute caps. Orchestrator should space calls (batch size ≤ 20 at a time)

## Test plan

| Vendor | Expected | Why |
|---|---|---|
| Autodesk | `Public` | NASDAQ: ADSK |
| Procore | `Public` | NYSE: PCOR (IPO'd 2021) |
| OpenSpace | `Series D+` or `Series C` | Well-funded AEC startup |
| Buildots | `Series C` | Disclosed funding |
| A bootstrapped SaaS with known founder statements | `Bootstrapped` |
| An obscure vendor with no online funding footprint | `Unknown`, `needs_manual_review=true` |

## Cost

Claude Sonnet with web_search is ~$0.03 per call. For 1,000 vendors: ~$30, minus the short-circuited "Public" ones.

This is the **most expensive single workflow** in the set. Consider running it *after* W-LinkedIn and W-CompanySize so you have as much context as possible before spending Sonnet calls. Could also batch lower-priority vendors to run quarterly rather than on initial enrichment.
