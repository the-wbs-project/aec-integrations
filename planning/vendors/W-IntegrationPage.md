# W-IntegrationPage

Detect whether a vendor has a public `/integrations`, `/partners`, `/marketplace`, or similar page listing third-party integrations. Extract self-reported partner count if visible.

## Purpose

Flags vendors that self-publish an ecosystem of integrations. A signal of integration maturity and strategic priority — vendors maintaining these pages have likely invested in partnership infrastructure, making them both better integration candidates and more responsive to outreach.

## Airtable fields written

| Field | Type | Description |
|---|---|---|
| `has_integration_page` | Checkbox | True if a legitimate integrations/partners listing was found |
| `integration_page_url` | URL | Matched URL |
| `self_reported_partner_count` | Number | Partners visible on the page (extracted by Claude) |
| `integration_page_checked_at` | DateTime | Always set, even on error path |

## Input

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

Requires `company_name` and `website` on the vendor record.

## Node flow

```
Trigger → Get Vendor Record → Normalize Input → Has Required Fields?
                                                       │ yes
                                                       ▼
                                              Build Candidate URLs
                                                       │
                                                       ▼
                                              Check URLs (HTTP loop, continue-on-fail)
                                                       │
                                                       ▼
                                              Pick First Valid Response
                                                       │
                                                       ▼
                                              Found a Page?
                                             /              \
                                          Yes                No
                                           │                  │
                                           ▼                  ▼
                                   Claude: Validate &    Write Empty Result
                                   Extract Partner Count      │
                                           │                  │
                                           ▼                  │
                                   Merge Extracted ──────────┤
                                           │                  │
                                           ▼                  ▼
                                   Update Vendor Record ◄─────┘
                                           │
                                           ▼
                                   Format Return Value
```

## Candidate paths

Check these URL paths against `vendor_domain` (root + common subdirectories):

```json
[
  "/integrations",
  "/integration",
  "/partners",
  "/partner",
  "/marketplace",
  "/apps",
  "/app-marketplace",
  "/ecosystem",
  "/connect"
]
```

## Key nodes

### Build Candidate URLs (Code node)

```javascript
const context = $('Normalize Input').item.json;
const paths = [
  '/integrations','/integration','/partners','/partner',
  '/marketplace','/apps','/app-marketplace','/ecosystem','/connect'
];

return paths.map(p => ({
  json: {
    ...context,
    candidate_path: p,
    candidate_url: `https://${context.vendor_domain}${p}`
  }
}));
```

### Check URLs (HTTP Request, looped via Split In Batches)

- Method: GET
- URL: `={{ $json.candidate_url }}`
- Headers: standard User-Agent and Accept-Language (see 00-conventions)
- Options: `continueOnFail=true`, `neverError=true`, `fullResponse=true`
- Timeout: 30s

### Pick First Valid Response (Code node)

Filter to first 200 response with body > 2KB (filters out redirects-to-home and 200-but-empty pages):

```javascript
const responses = $input.all().map(i => i.json);
const context = $('Normalize Input').item.json;

const valid = responses.find(r =>
  r.statusCode === 200 &&
  typeof r.body === 'string' &&
  r.body.length > 2000
);

if (!valid) {
  return { ...context, found: false };
}

// Strip scripts and styles to reduce token load for Claude
const cleanHtml = valid.body
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .substring(0, 12000);

return {
  ...context,
  found: true,
  matched_url: valid.url || valid.headers?.['content-location'] || '',
  page_html: cleanHtml
};
```

### Found a Page? (IF node)

- Condition: `{{ $json.found }}` is true
- True → Claude validation
- False → Write Empty Result

### Claude: Validate & Extract (Basic LLM Chain)

**System message:**
```
You are a data extraction assistant. You respond only with valid JSON matching the requested schema. No prose, no markdown fences.
```

**Prompt:**
```
This is HTML from {{ $json.matched_url }} on vendor {{ $json.company_name }}.

Task: determine if this is a legitimate integrations/partners listing page (not a generic marketing page), and if so, count the distinct third-party integration partners listed.

HTML (cleaned, scripts/styles removed):
{{ $json.page_html }}

Return JSON:
{
  "is_integrations_page": true | false,
  "partner_count": number,
  "confidence": "low" | "medium" | "high",
  "notes": "brief"
}

Set is_integrations_page=false for press pages, customer logos, "our investors" etc. Only count distinct integration partners, not case studies or testimonials.
```

**Output Parser example:**
```json
{
  "is_integrations_page": true,
  "partner_count": 42,
  "confidence": "high",
  "notes": "clean partner grid"
}
```

### Merge Extracted (Code node)

```javascript
const parsed = $input.item.json.output || $input.item.json;
const context = $('Normalize Input').item.json;
const matched = $('Pick First Valid Response').item.json;

const isPage = parsed.is_integrations_page === true && parsed.confidence !== 'low';

return {
  record_id: context.record_id,
  has_integration_page: isPage,
  integration_page_url: isPage ? matched.matched_url : null,
  self_reported_partner_count: isPage ? (parsed.partner_count || 0) : null,
  integration_page_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['has_integration_page','integration_page_url','self_reported_partner_count','integration_page_checked_at'],
  note: isPage ? null : (parsed.notes || 'No valid integrations page found')
};
```

### Write Empty Result (Code node)

```javascript
const context = $('Normalize Input').item.json;

return {
  record_id: context.record_id,
  has_integration_page: false,
  integration_page_url: null,
  self_reported_partner_count: null,
  integration_page_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['has_integration_page','integration_page_checked_at'],
  note: 'No integrations page found at common paths'
};
```

## Error handling

- **Missing Required Fields** branch → writes `integration_page_checked_at` only, status=error, calls W-LogEvent with `error_type=missing_data`
- Set workflow Settings → Error Workflow → `W-ErrorHandler`

## Test plan

| Vendor | Expected | Why |
|---|---|---|
| Procore | `has_integration_page=true`, partner_count ≥ 500 | Largest AEC marketplace |
| Autodesk | `has_integration_page=true`, partner_count high | `/integrations/` page well-known |
| Bluebeam | `has_integration_page=true`, partner_count ~30-40 | Focused but real integrations page |
| Small vendor with no integrations page | `has_integration_page=false` | Graceful empty |
| Vendor whose `/partners` page lists reseller partners, not integrations | `has_integration_page=false` with Claude notes | Validates the Claude filter |

## Cost

Claude Haiku call only on pages that were found — ~$0.003 per matched vendor. HTTP checks are free. Expected total: ~$2 per 1,000 vendors.
