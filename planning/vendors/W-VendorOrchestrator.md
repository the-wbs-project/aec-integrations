# W-VendorOrchestrator

Dispatch all vendor enrichment workflows for a batch of vendors. Runs after each individual workflow is tested and stable.

## Purpose

One entry point for full-pipeline enrichment. Handles:
- Selecting which vendors need enrichment (new, stale, partial)
- Running workflows in the right order (sequential where dependencies exist, parallel where not)
- Computing completeness score and final status
- Error aggregation

## Input

Two trigger modes:

**Manual Trigger (full backfill / on-demand):**
No specific input — orchestrator selects vendors based on filter.

**Cron Trigger (scheduled re-enrichment):**
Weekly, selects vendors where `last_enriched_at < NOW - 90 days`.

## Airtable fields written

Only orchestration-level fields:

| Field | Type | Description |
|---|---|---|
| `vendor_enrichment_status` | Single select | `pending`, `enriching`, `enriched`, `partial`, `error` |
| `vendor_data_completeness` | Percent | % of enrichment fields populated |
| `last_enriched_at` | DateTime | Set when all sub-workflows complete |

Individual workflow fields (`github_org`, `linkedin_followers`, etc.) are written by the sub-workflows themselves.

## Node flow

```
Trigger (Manual or Cron)
        │
        ▼
Query Vendors to Enrich (Airtable List, filter by status)
        │
        ▼
Split In Batches (25 at a time)
        │
        ▼
Set vendor_enrichment_status = 'enriching' (Airtable Update)
        │
        ▼
Loop Over Vendors (Split In Batches size 1)
        │
        ▼
┌──────────────────────────────────────────┐
│ Phase 1: LinkedIn must run first         │
│   Execute Workflow: W-LinkedIn (wait)    │
└──────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────┐
│ Phase 2: Parallel workflows              │
│   Execute Workflow: W-GitHub            │
│   Execute Workflow: W-IntegrationPage   │
│   Execute Workflow: W-PartnerProgram    │
│   Execute Workflow: W-CompanySize       │
│   Execute Workflow: W-Funding           │
│   Execute Workflow: W-Press             │
│   Execute Workflow: W-BlogRecency       │
│   (Use Merge node, mode=wait for all)    │
└──────────────────────────────────────────┘
        │
        ▼
Re-fetch Vendor Record (to get all written fields)
        │
        ▼
Compute Completeness (Code)
        │
        ▼
Update Orchestration Fields (Airtable Update)
        │
        ▼
(Batch loop continues)
        │
        ▼
Notify Completion (Gmail, optional, only if errors above threshold)
```

## Key nodes

### Query Vendors to Enrich (Airtable List)

- Operation: List
- Filter: `OR({vendor_enrichment_status} = 'pending', {vendor_enrichment_status} = 'partial', IS_BEFORE({last_enriched_at}, DATEADD(TODAY(), -90, 'days')))`
- Fields returned: `record_id`, `company_name`, `website`, `vendor_enrichment_status`, `last_enriched_at`
- Page size: 100 (then orchestrator batches internally)

For initial backfill, change the filter to select all vendors or a specific subset.

### Set enrichment_status = 'enriching' (Airtable Update)

Mark vendors as in-flight so concurrent runs don't re-process them:

- Records: from previous node, `{{ $json.record_id }}`
- Fields: `vendor_enrichment_status = 'enriching'`

### Phase 1: Execute Workflow — W-LinkedIn

- Workflow: W-LinkedIn
- **Wait for sub-workflow to finish: true** — downstream W-CompanySize depends on this
- Input: `{{ { record_id: $json.record_id } }}`

### Phase 2: Parallel sub-workflows

For each of the 7 remaining workflows, add an **Execute Workflow** node:

- **Wait for sub-workflow: false** for all 7 (parallel)
- Input: same record_id for each

Then use a **Merge** node with mode = **Wait for all branches** (this is one case where Merge is appropriate — all branches are expected to produce output).

Actually — n8n's Merge node in "wait for all" mode still has the deadlock gotcha if any workflow errors. Better pattern:

**Alternative: use a single "Fan Out" Code node followed by individual Execute Workflow calls with `continueOnFail=true`**

```javascript
// Fan Out: produce 7 items, each targeting a different workflow
const context = $input.item.json;
return [
  { json: { ...context, target_workflow: 'W-GitHub' } },
  { json: { ...context, target_workflow: 'W-IntegrationPage' } },
  { json: { ...context, target_workflow: 'W-PartnerProgram' } },
  { json: { ...context, target_workflow: 'W-CompanySize' } },
  { json: { ...context, target_workflow: 'W-Funding' } },
  { json: { ...context, target_workflow: 'W-Press' } },
  { json: { ...context, target_workflow: 'W-BlogRecency' } }
];
```

Then a **Switch** node routes to seven separate Execute Workflow nodes based on `target_workflow`. Each writes its results to Airtable independently. This avoids Merge entirely.

**Recommended:** just have 7 separate Execute Workflow nodes in parallel connected directly from a single upstream node. n8n will run them concurrently. Let each write to Airtable on its own. Then use a final "wait and consolidate" Code node that re-fetches the vendor record.

### Re-fetch Vendor Record (Airtable Get)

After all sub-workflows have written their fields, fetch the fresh record to compute completeness.

### Compute Completeness (Code)

```javascript
const record = $input.item.json;
const fields = record.fields || record;

const enrichmentFields = [
  'github_org',
  'has_integration_page',
  'has_partner_program',
  'linkedin_followers',
  'company_size',
  'funding_stage',
  'press_count_12mo',
  'blog_last_post_days_ago'
];

const populated = enrichmentFields.filter(f => {
  const v = fields[f];
  // Treat empty string, null, and undefined as missing.
  // 0 and false are valid data.
  return v !== null && v !== undefined && v !== '';
}).length;

const completeness = Math.round((populated / enrichmentFields.length) * 100);

let status;
if (completeness >= 75) status = 'enriched';
else if (completeness >= 40) status = 'partial';
else status = 'error';

return {
  record_id: record.id,
  vendor_data_completeness: completeness,
  vendor_enrichment_status: status,
  last_enriched_at: new Date().toISOString()
};
```

### Update Orchestration Fields (Airtable Update)

Write the three orchestration fields back. Don't touch any enrichment fields — those were owned by their respective workflows.

## Error handling

- Each sub-workflow has its own error handling (W-ErrorHandler catches crashes, writes to Enrichment Errors table)
- Orchestrator doesn't need to stop on sub-workflow errors — it should let partial enrichments settle and mark them `partial` if below 75% threshold
- `continueOnFail=true` on all Execute Workflow nodes so one failing workflow doesn't kill the whole vendor's enrichment

## Scheduling

**Initial backfill:**
- Manual trigger
- No `last_enriched_at` filter, process all vendors
- Batch size 25, sequential batches
- Runtime: several hours

**Quarterly re-enrichment:**
- Cron: Sunday 02:00 UTC weekly
- Filter: `last_enriched_at < NOW - 90 days`

**Targeted re-run** (e.g., after fixing a W-GitHub bug):
- Manual trigger with custom Airtable filter (e.g., `github_checked_at < 2026-04-14`)
- Skip orchestrator entirely — call W-GitHub directly for targeted vendors

## Test plan

1. **Single-vendor dry run:** set batch size to 1, run on one known-good vendor (Autodesk). Verify all 8 sub-workflow fields populate.
2. **5-vendor test:** run on 5 vendors of varying maturity (Autodesk, Procore, Bluebeam, a Series B startup, a small vendor). Verify different completeness scores and appropriate status (`enriched` for mature, `partial` for emerging, `error` for obscure).
3. **Error injection test:** temporarily break W-Funding, run orchestrator, verify other workflows still complete and final status reflects missing data correctly.

## Cost per full orchestrator run

Summed from sub-workflow costs:
- W-LinkedIn: $7/1K (Apify + Claude)
- W-GitHub: $2/1K (Claude only)
- W-IntegrationPage: $2/1K
- W-PartnerProgram: $2/1K
- W-CompanySize: $10/1K (Sonnet fallback)
- W-Funding: $30/1K (Sonnet + web_search)
- W-Press: $2/1K
- W-BlogRecency: $1.50/1K

**Total: ~$57 per 1,000 vendors per full enrichment.** Quarterly re-runs can skip stable signals (company_size, funding) to cut cost in half.
