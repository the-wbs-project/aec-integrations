# AECi Review MCP Server

The AECi Review MCP server lets an LLM read and write the three core domain
entities backing the AECi review pipeline:

- **Vendors** — companies. Carry company-level signals (HQ, funding, GitHub,
  VQS pillars).
- **Products** — software products sold by a vendor. Carry product-level signals
  (integrations, marketplaces, API docs, reviews, search demand, score).
- **Integrations** — directional links between two products (Source Tool →
  Target Tool) plus mechanism metadata.

Most tools are thin wrappers over the same Airtable + hydrate helpers that
back the HTTP data API at `https://review.aecintegrations.com/api/*`. The
two `*_and_research` tools also kick off the matching enrichment workflow,
so an LLM can turn a single name into a fully enriched record.

This file is the spec an LLM should read before calling the server.

---

## Connection

- **URL**: `https://review.aecintegrations.com/mcp`
- **Transport**: Streamable HTTP (the modern MCP transport, not SSE).
- **Auth**: none right now. Treat that as temporary; do not log or echo the
  URL more than necessary.
- **Server name**: `aeci-review-mcp` (version `2.0.0`).

Configuration in Claude Desktop / mcp-inspector / similar:

```json
{
  "mcpServers": {
    "aeci-review": {
      "url": "https://review.aecintegrations.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

---

## Conventions

- **All identifiers are Airtable record IDs** (`rec…`). Tools never accept
  user-facing names where an ID is expected — list first, then act on the
  ID.
- **Field names are snake_case** matching the Airtable schema (`company_name`,
  `research_status`, `mechanism_kind`, …). Linked-record fields take arrays
  of record IDs (`category: ["recABC", "recDEF"]`).
- **Every tool returns a single `text` content block whose body is JSON.**
  Parse it before using. On failure, the tool returns `isError: true` with a
  plain-text error message.
- **No dedupe at the create layer.** Always `list_*` first to confirm the
  record does not already exist.
- **Optional fields are sparse.** A field omitted from the input is left
  untouched; a field set to `""` writes an empty string.

---

## Tools

### Vendors

| Tool | Purpose |
|---|---|
| `list_vendors` | Search by company name + paginate. |
| `get_vendor` | Full VendorDetail by record ID. |
| `create_vendor_and_research` | Seed a vendor row + start `vendor-orchestrator`. |
| `update_vendor` | Patch fields on an existing vendor. |

### Products

| Tool | Purpose |
|---|---|
| `list_products` | Search/filter (category/discipline/phase/vendor/status/tier) + paginate. |
| `get_product` | Full ProductDetail with linked integrations. |
| `create_product_and_research` | Seed a product row + start `product-orchestrator`. |
| `update_product` | Patch fields on an existing product (incl. linked-record arrays). |

### Integrations

| Tool | Purpose |
|---|---|
| `list_integrations` | Filter by source/target/mechanism/maturity + paginate. |
| `get_integration` | Full IntegrationSummary by record ID. |
| `create_integration` | Manually link two products with mechanism metadata. |
| `update_integration` | Patch fields on an existing integration. |

### Taxonomy

| Tool | Purpose |
|---|---|
| `list_taxonomy` | Return categories, disciplines, and project phases as `{ id, name }` lists. KV-cached. |

---

## `create_vendor_and_research`

Create a new vendor in Airtable from minimal LLM-research input, then start
the standard enrichment orchestrator against it. The orchestrator runs in
the background; this call returns as soon as the record exists and the
workflow has been spawned.

**Use when**

- You have identified a vendor that does not yet exist in the database, and
  you want it researched. "Research" here means: descriptions, headquarters,
  funding, GitHub presence, Crunchbase signals, and the Vendor Quality Score
  pillars are all populated automatically by the workflow.
- You only need to hand off the most basic facts — a company name. Everything
  else is optional and will be filled in by enrichment.

**Do not use when**

- The vendor likely already exists. There is no built-in dedupe today.
  Call `list_vendors` first and only call this tool if it is genuinely new.
- You want to update an existing vendor. This tool only creates — use
  `update_vendor` instead.

#### Input schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `company_name` | string | yes | The vendor's company name. Trimmed; must be non-empty. |
| `website` | string (URL) | no | Primary marketing URL, e.g. `https://acme.com`. |
| `description` | string | no | One to three sentences. Will be overwritten by Crunchbase/Wikipedia enrichment. |
| `force_refresh` | boolean | no | Forces re-run of every leaf regardless of staleness. No-op for new records. |
| `model` | string | no | Override the orchestrator's Claude model (e.g. `claude-sonnet-4-6`). Defaults to `DEFAULT_MODEL`. |
| `skip_orchestrator` | boolean | no | If true, only create the Airtable row and skip the workflow. |

#### Output

```json
{
  "recordId": "rec0123456789ABCD",
  "run": {
    "runId": "f4c3...-uuid",
    "workflow": "vendor-orchestrator",
    "model": "claude-haiku-4-5-20251001"
  }
}
```

When `skip_orchestrator: true`, the `run` field is omitted.

---

## `create_product_and_research`

Mirror of `create_vendor_and_research` for the products table. Creates a
product row with `research_status="Pending"`, then spawns
`product-orchestrator`, which runs `product-research` and `product-overview`
sequentially, then fans out the leaf enrichments
(`product-api-check`, `product-marketplace`, `product-ipaas`,
`product-reviews`, `product-search-demand`, `product-reddit`,
`product-integrations-discovery`) in parallel, and finishes with
`product-score`.

**Do not use when**

- The product likely already exists. Call `list_products` first.
- You want to update an existing product — use `update_product`.
- You need to link the product to a vendor at creation time. Create the row
  first, then `update_product` with `vendors: [vendorId]`. (Or rely on
  `product-research`, which infers the vendor automatically.)

#### Input schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | The product name as it appears on the vendor site (drop legal suffixes). |
| `website` | string (URL) | no | Primary marketing URL for the product. |
| `description` | string | no | One to three sentences. Will be overwritten by `product-research`. |
| `force_refresh` | boolean | no | Forces re-run of every leaf. No-op for new records. |
| `model` | string | no | Override the orchestrator's Claude model. |
| `skip_orchestrator` | boolean | no | If true, only create the Airtable row. |

#### Output

```json
{
  "recordId": "rec0123456789ABCD",
  "run": {
    "runId": "f4c3...-uuid",
    "workflow": "product-orchestrator",
    "model": "claude-haiku-4-5-20251001"
  }
}
```

---

## `list_vendors` / `list_products` / `list_integrations`

All three return `{ data, total, offset, limit }`. Use them to find a
record's ID before calling `get_*` / `update_*` / `create_integration`, and
to confirm a record does not already exist before calling
`create_*_and_research`.

#### Common pagination inputs

| Field | Type | Notes |
|---|---|---|
| `offset` | int ≥ 0 | Defaults to 0. |
| `limit` | int 1–200 | Defaults to 50. |

#### `list_vendors`

| Field | Type | Notes |
|---|---|---|
| `search` | string | Case-insensitive substring against `company_name`. |

#### `list_products`

| Field | Type | Notes |
|---|---|---|
| `search` | string | Matches `name`, `description`, and linked vendor names. |
| `category_id` / `discipline_id` / `phase_id` / `vendor_id` | string | Filter to products linked to that record. |
| `research_status` | string | Exact match (e.g. `"Pending"`, `"Done"`). |
| `priority_tier` | string | Exact match. |
| `enrichment_status` | string | Exact match against `tool_enrichment_status`. |
| `include_rejected` | boolean | Defaults to false. |

#### `list_integrations`

| Field | Type | Notes |
|---|---|---|
| `search` | string | Matches name, description, mechanism_name, notes, source/target product names. |
| `source_product_id` / `target_product_id` / `powered_by_product_id` | string | Filter to that linked product. |
| `mechanism_kind` | enum | `native` \| `iPaaS` \| `marketplace-app` \| `api` \| `webhook` \| `partner`. |
| `maturity` / `pricing_model` | string | Exact match. |
| `built_by_vendor_id` | string | Filter to integrations built by that vendor. |

---

## `get_vendor` / `get_product` / `get_integration`

Each takes a single `record_id` and returns the full hydrated record.

- `get_vendor` returns `VendorDetail` (description, HQ, funding, GitHub,
  Crunchbase signals, VQS pillars, linked products).
- `get_product` returns `ProductDetail` (linked vendors/categories/disciplines/
  phases, all enrichment signals, integrations as source/target, integrated
  products, integration-discovery summary + unresolved candidates).
- `get_integration` returns `IntegrationSummary` (source/target product
  LinkRefs, mechanism, listing/docs URLs, notes).

Returns `isError: true` with `… not found: <id>` when the record does not
exist.

---

## `update_vendor`

Patch fields on an existing vendor. Only provided fields are written.

| Field | Type | Notes |
|---|---|---|
| `record_id` | string | required. |
| `company_name` | string | |
| `description` | string | |
| `website` | string | |
| `headquarters` | string | |
| `founded_year` | int \| null | Pass `null` to clear. |
| `public_private` | string \| null | |
| `parent_company` | string | |
| `linkedin_url` / `crunchbase_url` / `wiki_url` / `source_url` | string | |
| `github_org` | string | The GitHub organization slug. |
| `phone_number` | string | |
| `contact_email` | string | |
| `admin_notes` | string | |

Returns the updated `VendorDetail`.

---

## `update_product`

Patch fields on an existing product. Only provided fields are written.
Linked-record fields take arrays of Airtable record IDs.

| Field | Type | Notes |
|---|---|---|
| `record_id` | string | required. |
| `name` | string | Maps to the `Name` Airtable field. |
| `description` / `website` | string | |
| `tool_integrations_url` / `api_docs_url` | string | |
| `has_api_docs` | boolean | |
| `research_status` | string | e.g. `"Pending"`, `"Done"`. |
| `promotion_status` | enum | `pending` \| `ready` \| `promoted` \| `retracted` \| `rejected`. |
| `research_notes` / `tool_integration_check_notes` / `admin_notes` | string | |
| `category` | string[] | Array of category record IDs. |
| `supported_disciplines` | string[] | Array of discipline record IDs. |
| `supported_project_phases` | string[] | Array of project-phase record IDs. |
| `vendors` | string[] | Array of vendor record IDs. |

Returns the updated `ProductDetail`.

---

## `list_taxonomy`

Return the three closed vocabularies the products table links to:
categories, disciplines, and project phases. Use these IDs (not names) when
patching `category` / `supported_disciplines` / `supported_project_phases`
via `update_product`.

No inputs.

#### Output

```json
{
  "categories":  [{ "id": "rec…", "name": "BIM Authoring" }, …],
  "disciplines": [{ "id": "rec…", "name": "Architecture" }, …],
  "phases":      [{ "id": "rec…", "name": "Design Development" }, …]
}
```

Backed by the same KV-cached `fetchCategories` / `fetchDisciplines` /
`fetchProjectPhases` helpers used by the data API, so repeat calls within
the cache TTL hit KV rather than Airtable.

---

## `create_integration`

Manually create an integration record linking two existing products. Most
integration records are created automatically by the
`product-integrations-discovery` workflow when the LLM has direct evidence
on a marketplace listing, docs page, or partner page. Use this tool only
when you want to bypass discovery — e.g. when you already have ironclad
evidence and you want the row right now.

Both products must already exist (call `create_product_and_research` first
if they do not). There is no auto-dedupe; the discovery workflow's existing
`(source, target, mechanism_kind)` skip rule does **not** run here.

#### Input schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `source_product_id` | string | yes | Airtable record ID. The product being integrated FROM. |
| `target_product_id` | string | yes | Airtable record ID. The product being integrated TO. Must differ from source. |
| `listing_url` | string (URL) | yes | URL where evidence was observed. |
| `name` | string | no | Display name. Defaults to `"{target_name} (manual)"`. |
| `mechanism_kind` | enum | no | `native` \| `iPaaS` \| `marketplace-app` \| `api` \| `webhook` \| `partner`. |
| `mechanism_name` | string | no | Free-text label (e.g. `"Zapier connector"`, `"Procore App"`). |
| `direction` | enum | no | `one-way` \| `bidirectional`. |
| `description` | string | no | |
| `docs_url` | string (URL) | no | |
| `website` | string (URL) | no | |
| `mechanism_url` | string (URL) | no | |
| `pricing_model` | string | no | |
| `maturity` | string | no | |
| `built_by_vendor_id` | string | no | Vendor record ID. |
| `powered_by_product_id` | string | no | Product record ID for an iPaaS / connector that powers the integration. |
| `notes` | string | no | |

Returns the newly created `IntegrationSummary`.

---

## `update_integration`

Patch fields on an existing integration. Only provided fields are written.
`source_product_id` / `target_product_id` rewrite the linked-record arrays.

| Field | Type | Notes |
|---|---|---|
| `record_id` | string | required. |
| `name` | string | |
| `source_product_id` / `target_product_id` | string | |
| `mechanism_kind` | enum | Same enum as `create_integration`. |
| `mechanism_name` | string | |
| `direction` | enum | `one-way` \| `bidirectional`. |
| `description` | string | |
| `docs_url` / `website` / `mechanism_url` / `listing_url` | string | |
| `pricing_model` / `maturity` | string | |
| `built_by_vendor_id` / `powered_by_product_id` | string | |
| `notes` | string | |

Returns the updated `IntegrationSummary`.

---

## Errors

Tools return `isError: true` with a plain-text error message in these cases:

- Validation: `companyName is required`, `name is required`,
  `Invalid model: …`, `source_product_id and target_product_id must differ`,
  `No editable fields provided`, `… not found: <id>`.
- Airtable: token-scope errors, 4xx/5xx from the REST API, network failures
  — the underlying message is surfaced as-is.

A failure to notify the live-runs Durable Object does **not** fail
`create_*_and_research`; the workflow has already been spawned and will
appear in the runs list as soon as the alarm-driven reconciler picks it up.

---

## Behavior after `create_*_and_research` returns

The orchestrators run asynchronously. By the time the call returns, the
workflow instance is queued but enrichment has not started. A typical run
takes a few minutes:

- **Vendor orchestrator** — `vendor-overview` (Crunchbase + Wikipedia)
  → `vendor-github` + `vendor-funding` (parallel) → `vendor-score`.
- **Product orchestrator** — `product-research` → `product-overview`
  → 6 leaves + integrations-discovery (parallel) → `product-score`.

You do not need to call any follow-up tool. If you want to confirm progress,
the run ID returned in the response can be polled via the existing HTTP API:

- `GET https://review.aecintegrations.com/api/workflows/vendor-orchestrator/runs/{runId}`
- `GET https://review.aecintegrations.com/api/workflows/product-orchestrator/runs/{runId}`

The run also appears in the bell + run-detail dialog automatically.

---

## What to send for `name` / `company_name` and `website`

The orchestrators work best when these two fields are clean:

- **Names** — the brand name as it appears on the vendor's site. Drop legal
  suffixes (`, Inc.`, `LLC`) unless they're part of how the company presents
  itself. Example: `Procore`, not `Procore Technologies, Inc.`.
- **Website** — the apex marketing site (`https://acme.com`), not a deep
  link, not a docs subdomain, not a LinkedIn URL. The orchestrators use
  this as a seed signal across multiple enrichment leaves; a wrong URL
  poisons all of them.

If you only have one of the two, send the one you have. Enrichment derives
the rest.

---

## Idempotency and dedupe

There is no dedupe at the create layer. Calling
`create_vendor_and_research` or `create_product_and_research` twice with
the same name will create two Airtable rows and run two orchestrator
instances in parallel. The MCP client is responsible for not doing that.

If you are unsure whether the record exists, list-and-search first:

- `list_vendors({ search: "<name>" })`
- `list_products({ search: "<name>" })`
- `list_integrations({ source_product_id, target_product_id })`

and only call the create tool if no match is found.

---

## Versioning

Tool names and required input fields are stable. The shape of the JSON
returned inside the text block is also stable. New optional input fields
and new optional output fields may be added without notice; LLM clients
should ignore unknown fields rather than crash.
