# AEC Integrations — Vendor Enrichment Workflows

This directory contains specs for each n8n workflow in the vendor-enrichment pipeline. Read in this order.

## Read first

- **`00-conventions.md`** — shared patterns (input/output contract, standard nodes, credentials, error handling). Every workflow spec assumes this.

## Workflows

| # | Spec | Purpose | Cost/1K | Depends on | Status |
|---|---|---|---|---|---|
| 1 | `W-GitHub.md` (already built) | GitHub org, repos, stars, SDK presence | $2 | — | ✅ Built in n8n |
| 2 | `W-LinkedIn.md` | Company page URL + follower count | $7 | — | 📝 Spec only |
| 3 | `W-CompanySize.md` | Employee count bucket | $10 | W-LinkedIn (recommended) | 📝 Spec only |
| 4 | `W-Funding.md` | Funding stage, total raised, last round | $30 | — | 📝 Spec only |
| 5 | `W-Press.md` | News mentions in last 12 months | $2 | — | 📝 Spec only |
| 6 | `W-BlogRecency.md` | Date of most recent blog post | $1.50 | — | 📝 Spec only |
| 7 | `W-VendorOrchestrator.md` | Dispatches all of the above | ~$53 full | All 6 above | 📝 Spec only |

## Recommended build order

Already done:
- Airtable schema (all 32 enrichment fields + Enrichment Errors table)
- W-GitHub workflow (working on record `recH6fuIYPHJ6XWpe` for Autodesk)
- W-ErrorHandler + W-LogEvent (error handling infrastructure)

To build next:
1. **W-Press** — simplest, free, good for proving the standard workflow pattern on a new workflow
2. **W-BlogRecency** — next simplest, exercises HTTP loop + Claude extraction
3. **W-LinkedIn** — introduces Apify; validate actor choice on real vendors
4. **W-CompanySize** — depends on W-LinkedIn; dual-path logic
5. **W-Funding** — most expensive, uses Sonnet + web_search; build last to validate cost assumptions
6. **W-VendorOrchestrator** — only after all 6 above are working individually

## Test vendors

Use these 5 for end-to-end validation across every new workflow:

| Vendor | record_id | Why |
|---|---|---|
| Autodesk | `recH6fuIYPHJ6XWpe` | Public, massive — hits every signal |
| Procore | (look up in Airtable) | AEC-native, public, tiered partner program |
| Bluebeam | (look up) | Subsidiary of Nemetschek — tests parent-child logic |
| Series B/C AEC startup (e.g., OpenSpace) | (look up) | Tests funding workflow properly |
| Small obscure vendor | (look up) | Tests graceful degradation across all workflows |

## Resources

- **Airtable base:** `appy81IdGJY6Fngf9`
- **Vendors table:** `tbln8aZjwPI3Am4TF`
- **Enrichment Errors table:** `tblZs3rksWG2J2L3j`
- **n8n workflows built so far:** W-GitHub, W-ErrorHandler, W-LogEvent

## Notes for Claude Code

- Each spec is self-contained enough to build from, but ALWAYS read `00-conventions.md` first
- Node types referenced are stable in n8n 1.x:
  - `n8n-nodes-base.airtable` v2.1
  - `n8n-nodes-base.httpRequest` v4.2
  - `n8n-nodes-base.code` v2
  - `n8n-nodes-base.if` v2
  - `n8n-nodes-base.splitInBatches` / `splitOut`
  - `@n8n/n8n-nodes-langchain.chainLlm`
  - `@n8n/n8n-nodes-langchain.lmChatAnthropic`
  - `@n8n/n8n-nodes-langchain.outputParserStructured`
- After import, credentials and the Error Workflow setting must be attached manually in n8n UI
- Test every new workflow on Autodesk FIRST, then the other 4 test vendors, BEFORE running in the orchestrator
