# W-CompanySize

Determine employee count bucket for the vendor. Prefers data from W-LinkedIn (cheaper, more reliable); falls back to Claude with web search.

## Purpose

Employee count drives outreach scoring — the sweet spot is 51-1,000 employees (marketing team exists, not bureaucratic). Company size on its own is useful; exact count feeds Bayesian priors in the final scoring formula.

## Prerequisite

Run **W-LinkedIn first** whenever possible. If `linkedin_url` is populated on the vendor, this workflow can skip the expensive Claude-with-web-search call.

## Airtable fields written

| Field | Type | Description |
|---|---|---|
| `company_size` | Single select | Bucket: `1-10`, `11-50`, `51-200`, `201-1000`, `1001-5000`, `5000+` (existing field) |
| `employee_count_exact` | Number | Precise count when known |
| `employee_source` | Single select | `linkedin`, `crunchbase`, `website`, `manual`, `unknown` |
| `employee_checked_at` | DateTime | Always set |

## Input

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

## Node flow

```
Trigger → Get Vendor Record → Normalize → Has Required?
                                               │ yes
                                               ▼
                                      Has LinkedIn URL? (IF)
                                     /                    \
                                  Yes                      No
                                   │                        │
                                   ▼                        ▼
                          Apify: Fetch Employee       Claude (with web_search):
                          Range from LinkedIn         Look up Employee Count
                                   │                        │
                                   └───────────┬────────────┘
                                               ▼
                                      Map to Bucket (Code)
                                               │
                                               ▼
                                     Update Vendor Record
                                               │
                                               ▼
                                     Format Return Value
```

## Key nodes

### Has LinkedIn URL? (IF)

- Condition: `{{ $('Get Vendor Record').item.json.fields.linkedin_url }}` is not empty

### LinkedIn path — Apify Fetch

Use the same Apify actor as W-LinkedIn. You can either:
- **Option A:** run a fresh scrape (simple, same actor call pattern)
- **Option B:** store `employee_range` from the W-LinkedIn actor's response directly so W-CompanySize just reads Airtable

**Recommended: Option A.** Running the actor fresh keeps workflows loosely coupled — W-CompanySize doesn't depend on which specific fields W-LinkedIn chose to persist.

Actor input: same as W-LinkedIn. Expected response field name varies: `employeeCount`, `employeeCountRange`, `employeesOnLinkedIn`, `staff_count_range` etc. — handle defensively.

### Fallback path — Claude with Web Search (Basic LLM Chain)

**Model:** `claude-sonnet-4-6` (Sonnet — needed for web_search tool).
**Max tokens:** 2048.

**Prompt:**
```
How many employees does '{{ $json.company_name }}' ({{ $json.vendor_domain }}) have?

Search LinkedIn, Crunchbase, or the company website. Prefer LinkedIn's "employees on LinkedIn" count if available.

Return JSON:
{
  "employee_range": "1-10" | "11-50" | "51-200" | "201-1000" | "1001-5000" | "5000+",
  "employee_count_exact": number | null,
  "source": "linkedin" | "crunchbase" | "website" | "unknown",
  "confidence": "low" | "medium" | "high",
  "source_url": "https://..." | null
}

If you cannot determine the company size with medium or higher confidence, return confidence="low" and your best guess.
```

**Tools:** enable web_search on the Anthropic Chat Model node.

### Map to Bucket (Code)

Normalizes whatever source returned to the existing Airtable buckets:

```javascript
const input = $input.item.json;
const context = $('Normalize Input').item.json;

// Pull from either LinkedIn path or Claude path
const fromLinkedIn = Array.isArray(input) ? input[0] : null;
const fromClaude = input.output || (input.employee_range ? input : null);

let range = null;
let exact = null;
let source = 'unknown';
let confidence = 'low';

if (fromClaude && fromClaude.employee_range) {
  range = fromClaude.employee_range;
  exact = fromClaude.employee_count_exact || null;
  source = fromClaude.source || 'unknown';
  confidence = fromClaude.confidence || 'low';
} else if (fromLinkedIn) {
  // Defensive field name handling
  const raw = fromLinkedIn.employeeCount
           ?? fromLinkedIn.employeeCountRange
           ?? fromLinkedIn.employeesOnLinkedIn
           ?? fromLinkedIn.staffCountRange
           ?? fromLinkedIn.staff_count_range;

  if (typeof raw === 'number') {
    exact = raw;
    range = exactToBucket(raw);
    source = 'linkedin';
    confidence = 'high';
  } else if (typeof raw === 'string') {
    range = normalizeRange(raw);
    source = 'linkedin';
    confidence = 'high';
  }
}

function exactToBucket(n) {
  if (n <= 10) return '1-10';
  if (n <= 50) return '11-50';
  if (n <= 200) return '51-200';
  if (n <= 1000) return '201-1000';
  if (n <= 5000) return '1001-5000';
  return '5000+';
}

function normalizeRange(s) {
  // Map LinkedIn ranges ("51-200", "201-500", "501-1000", etc.) to our buckets
  const map = {
    '1-10': '1-10', '2-10': '1-10',
    '11-50': '11-50',
    '51-200': '51-200',
    '201-500': '201-1000', '501-1000': '201-1000',
    '1001-5000': '1001-5000',
    '5001-10000': '5000+', '10001+': '5000+', '10,001+': '5000+'
  };
  return map[s] || null;
}

return {
  record_id: context.record_id,
  company_size: range,
  employee_count_exact: exact,
  employee_source: source,
  employee_checked_at: new Date().toISOString(),
  status: range ? 'success' : 'partial',
  fields_updated: range
    ? ['company_size','employee_count_exact','employee_source','employee_checked_at']
    : ['employee_checked_at'],
  needs_manual_review: confidence === 'low',
  note: range ? null : 'Could not determine employee count'
};
```

## Existing Airtable buckets (DO NOT MODIFY)

The existing `company_size` single-select has these options — stay aligned:
- `1-10`
- `11-50`
- `51-200`
- `201-1000`
- `1001-5000`
- `5000+`

## Test plan

| Vendor | Expected bucket |
|---|---|
| Procore | `1001-5000` |
| Autodesk | `5000+` |
| Bluebeam | `201-1000` |
| A Series A AEC startup | `51-200` or `11-50` |
| A known bootstrapped 5-person tool | `1-10` |

## Cost

- LinkedIn path: ~$0.005 Apify
- Claude fallback: ~$0.03 (Sonnet + web_search)

Assuming ~70% have LinkedIn URL available after W-LinkedIn: total ~$10 per 1,000 vendors.
