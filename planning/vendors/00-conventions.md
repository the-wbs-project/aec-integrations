# Vendor Enrichment — Shared Conventions

All vendor enrichment workflows follow the same structural conventions. Read this first — the individual workflow specs assume it.

## Airtable base

- **Base name:** AEC Integrations
- **Base ID:** `appy81IdGJY6Fngf9`
- **Vendors table ID:** `tbln8aZjwPI3Am4TF`
- **Enrichment Errors table ID:** `tblZs3rksWG2J2L3j`

## Input contract

Every vendor-enrichment workflow takes **only** a record_id. The workflow fetches the vendor record itself from Airtable.

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

Triggers:
- **Manual Trigger** → **Test Data** (Set node with hardcoded record_id) — for standalone testing
- **Execute Workflow Trigger** — for orchestrator calls in production

Both triggers feed into the same **Get Vendor Record** node (Airtable Get).

## Output contract

Every workflow returns this shape for the orchestrator to consume:

```json
{
  "record_id": "recXXXXXXXXXXXXXX",
  "workflow": "W-XYZ",
  "status": "success" | "error",
  "fields_updated": ["field1", "field2", ...],
  "error": null | "reason string",
  "note": null | "optional human-readable note"
}
```

## Required n8n credentials

Set these up once in n8n Credentials:

| Credential | Type | Used by |
|---|---|---|
| `airtable-aec-integrations` | Airtable PAT | Every workflow |
| `anthropic-api` | Anthropic API | Workflows that use Claude |
| `github-pat-aec` | GitHub API | W-GitHub only |
| `apify-aec` | Apify API | W-LinkedIn only |
| `gmail-aec` | Gmail OAuth2 | W-ErrorHandler only |

## Standard workflow shape

Every workflow follows this skeleton:

```
Manual Trigger ──► Test Data ──┐
                               ├──► Get Vendor Record ──► Normalize Input
Execute Workflow Trigger ──────┘                                │
                                                                ▼
                                                      Has Required Fields?
                                                     /                    \
                                              Yes                        No
                                              │                           │
                                              ▼                           ▼
                                     ...workflow-specific...     Missing Required
                                              │                           │
                                              ▼                           │
                                  Update Vendor Record ◄──────────────────┤
                                              │                           │
                                              ▼                           ▼
                                    Format Return Value ◄─────────────────┘
```

## Standard node: Get Vendor Record

- **Type:** `n8n-nodes-base.airtable` v2.1
- **Operation:** Get
- **Base:** `appy81IdGJY6Fngf9`
- **Table:** `tbln8aZjwPI3Am4TF`
- **Record ID:** `={{ $json.record_id }}`

## Standard node: Normalize Input (Code node)

Purpose: extract required fields from the Airtable record. Adjust the fields returned per workflow.

```javascript
const record = $input.item.json;
const fields = record.fields || record;

const company_name = fields.company_name || null;
const website = fields.website || null;

// Derive vendor_domain from website (n8n Code sandbox has no URL constructor)
let vendor_domain = null;
if (website) {
  const match = website.match(/^(?:https?:\/\/)?([^\/\?#:]+)/i);
  if (match && match[1] && match[1].includes('.')) {
    vendor_domain = match[1].replace(/^www\./i, '').toLowerCase();
  }
}

return {
  record_id: record.id || $('Get Vendor Record').item.json.id,
  company_name,
  website,
  vendor_domain,
  _has_required: !!(company_name && vendor_domain)
};
```

## Standard node: Has Required Fields? (IF node)

- **Condition:** `{{ $json._has_required }}` equals `true`
- **True branch** → continue
- **False branch** → Missing Required Fields node → Format Return Value

## Standard node: Missing Required Fields (Code node)

```javascript
const context = $('Normalize Input').item.json;

return {
  record_id: context.record_id,
  // Set all of this workflow's target fields to null/default
  // plus always the checked_at timestamp:
  [`${PREFIX}_checked_at`]: new Date().toISOString(),
  status: 'error',
  fields_updated: [`${PREFIX}_checked_at`],
  error: `Missing required fields on vendor record (company_name and/or website). record_id=${context.record_id}`
};
```

## Standard node: Format Return Value (Code node)

Final node, returns the orchestrator contract:

```javascript
const input = $input.item.json;

return {
  record_id: input.record_id,
  workflow: 'W-XYZ',  // replace per workflow
  status: input.status || 'success',
  fields_updated: input.fields_updated || [],
  error: input.error || null,
  note: input.note || null
};
```

## Claude API pattern

Always use the **Basic LLM Chain** (`@n8n/n8n-nodes-langchain.chainLlm`) with:

- **Anthropic Chat Model** sub-node (`@n8n/n8n-nodes-langchain.lmChatAnthropic`)
  - Model: `claude-haiku-4-5-20251001` (unless workflow needs Sonnet for web search — noted per spec)
  - Max Tokens: 1024
  - Temperature: 0
- **Structured Output Parser** sub-node (`@n8n/n8n-nodes-langchain.outputParserStructured`)
  - Always supply `jsonSchemaExample` matching the expected response shape

Never use raw HTTP Request to the Anthropic API.

## HTTP Request conventions

When hitting external vendor sites or other APIs:
- **User-Agent header:** `Mozilla/5.0 (compatible; AEC-Integrations-Bot/1.0; +https://aec-integrations.com)`
- **Accept-Language:** `en-US,en;q=0.9`
- **Timeout:** 30s
- **Continue on Fail:** true (for exploratory checks)
- **Never Error + Full Response:** for any call where you need to check the status code programmatically

## Empty-array handling

n8n halts the chain when a node outputs an empty array. For any HTTP node that might legitimately return `[]`:

- Open node → **Settings** tab → enable **"Always Output Data"**
- Downstream Code node must handle the sentinel (no items to aggregate)

## Merge node warning

Do **not** use the Merge node to collapse mutually exclusive branches. Instead, connect both branches directly to the next node. The Merge node waits for data on all inputs, which deadlocks exclusive branches.

## Error handling wiring

Every workflow should have:

1. **Error Workflow setting** — Workflow Settings → Error Workflow → `W-ErrorHandler` (catches unhandled crashes)
2. **Explicit W-LogEvent calls** — Execute Workflow node, `Wait=false`, called from the `Missing Required Fields` branch and from any other "handled but notable" path (e.g., "no GitHub org found")

## Checked-at discipline

Every enrichment workflow writes a `*_checked_at` timestamp to Airtable on **every** run, even on the error path. This tells the orchestrator "we tried" so it doesn't pick up the same record next cycle. The specific field name per workflow:

| Workflow | Timestamp field |
|---|---|
| W-GitHub | `github_checked_at` |
| W-IntegrationPage | `integration_page_checked_at` |
| W-PartnerProgram | `partner_program_checked_at` |
| W-LinkedIn | `linkedin_checked_at` |
| W-CompanySize | `employee_checked_at` |
| W-Funding | `funding_checked_at` |
| W-Press | `press_checked_at` |
| W-BlogRecency | `blog_checked_at` |
