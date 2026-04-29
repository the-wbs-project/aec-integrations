# AECi Review MCP Server

The AECi Review MCP server lets an LLM seed new vendor records into the
research pipeline. It is a thin wrapper around the same internal helper that
backs `POST /api/vendors`: create the Airtable row, kick off the
`vendor-orchestrator` Cloudflare Workflow, return the new record ID and
orchestrator run ID.

This file is the spec an LLM should read before calling the server. It is
deliberately short — there is exactly one tool today.

---

## Connection

- **URL**: `https://review.aecintegrations.com/mcp`
- **Transport**: Streamable HTTP (the modern MCP transport, not SSE).
- **Auth**: none right now. Treat that as temporary; do not log or echo the
  URL more than necessary.
- **Server name**: `aeci-review-mcp` (version `1.0.0`).

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

## Tools

### `create_vendor_and_research`

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
  Search the existing vendor list first (via the API or the UI) and only
  call this tool if it is genuinely new.
- You want to update an existing vendor. This tool only creates.

#### Input schema

| Field | Type | Required | Notes |
|---|---|---|---|
| `company_name` | string | yes | The vendor's company name. Trimmed; must be non-empty. |
| `website` | string (URL) | no | Primary marketing URL, e.g. `https://acme.com`. |
| `description` | string | no | One to three sentences. The orchestrator will overwrite this with a richer description sourced from Crunchbase/Wikipedia. Send what you have anyway — it shows up in the UI immediately. |
| `force_refresh` | boolean | no | Forces the orchestrator to re-run every leaf enrichment regardless of staleness. For a brand-new record this is effectively a no-op; leave it unset. |
| `model` | string | no | Override the Claude model the orchestrator passes to its sub-workflows (e.g. `claude-sonnet-4-6`). Defaults to the server's `DEFAULT_MODEL`. Don't set this unless you have a reason. |
| `skip_orchestrator` | boolean | no | If true, only create the Airtable row and skip the workflow. Use only when you explicitly want a stub record without enrichment. |

#### Output

The tool returns a single text content block containing JSON:

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

#### Errors

The tool returns `isError: true` with a plain-text error message in these
cases:

- `companyName is required` — empty/missing `company_name`.
- `Invalid model: …` — `model` did not match the expected
  `claude-(opus|sonnet|haiku)-…` pattern.
- An Airtable failure (e.g. token scope, network) surfaces the underlying
  error message.

A failure to notify the live-runs Durable Object does **not** fail the tool;
the workflow has already been spawned and will appear in the runs list as
soon as the alarm-driven reconciler picks it up.

---

## Behavior after the call returns

The orchestrator runs asynchronously. By the time `create_vendor_and_research`
returns, the workflow instance is queued but enrichment has not started. A
typical run takes a few minutes:

1. `vendor-overview` — scrapes Crunchbase + Wikipedia. Populates description,
   HQ, company size, Crunchbase signals.
2. `vendor-github`, `vendor-funding` — run in parallel once overview finishes.
3. `vendor-score` — recomputes VQS pillars, tier, confidence, flags.

You do not need to call any follow-up tool. If you want to confirm progress,
the run ID returned in the response is the same one used by the existing
HTTP API:

- Status: `GET https://review.aecintegrations.com/api/workflows/vendor-orchestrator/runs/{runId}`
- Live UI: the run appears in the bell + run-detail dialog automatically.

---

## What to send for `company_name` and `website`

The orchestrator works best when these two fields are clean. Cheap rules:

- `company_name` — the brand name as it appears on the company's site. Drop
  legal suffixes (`, Inc.`, `LLC`) unless they're part of how the company
  presents itself. Example: send `Procore`, not `Procore Technologies, Inc.`.
- `website` — the apex marketing site (`https://acme.com`), not a deep link,
  not a docs subdomain, not a LinkedIn URL. The orchestrator uses this as a
  seed signal across multiple enrichment leaves; a wrong URL poisons all of
  them.

If you only have one of the two, send the one you have. The orchestrator
will derive the rest.

---

## Idempotency and dedupe

There is no dedupe at this layer. Calling the tool twice with the same
`company_name` will create two Airtable rows and run the orchestrator twice
in parallel. The MCP client is responsible for not doing that.

If you are unsure whether the vendor exists, list-and-search first via
`GET /api/vendors?search=<name>` and only call this tool if no match is
found.

---

## Versioning

The tool name and field names are stable. The shape of the returned JSON
inside the text block is also stable. New optional input fields may be added
without notice; LLM clients should ignore unknown fields rather than crash.
