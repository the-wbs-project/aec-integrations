Here's the full implementation review against the plan. All 9 workflow files exist, plus 2 modifications. Here's what I found:

---

## Implementation Status: All 9 WT-* Workflows Created

| # | Workflow | File Exists | Skeleton Complete | Logic Matches Spec |
|---|----------|:-----------:|:-----------------:|:------------------:|
| 1 | WT-IntegrationCount | Yes | Missing Normalize Input | Yes |
| 2 | WT-APICheck | Yes | Yes | `matched_url` bug (see below) |
| 3 | WT-Marketplace | Yes | Missing Normalize + IF | Yes |
| 4 | WT-iPaaS | Yes | Missing Normalize + IF | Yes |
| 5 | WT-Reviews | Yes | Missing Normalize + IF | Yes |
| 6 | WT-SearchDemand | Yes | Yes | Missing `engine=google` param |
| 7 | WT-Reddit | Yes | Missing Normalize + IF | Yes |
| 8 | WT-Score | Yes | N/A (batch) | Mostly correct, some issues |
| 9 | WT-ToolOrchestrator | Yes | N/A (orchestrator) | Several gaps |

Also modified: **W-BlogRecency** (reduced agent iterations 20→10, page limit 10→5) and **W-VendorOrchestrator** (added staleness checks, Set Config node).

---

## Blockers to Fix

### WT-ToolOrchestrator (most critical)
1. **No vendor-link check** — spec says skip tools with no vendor; not implemented
2. **No WT-Score call** — spec says call WT-Score once after all tools; missing entirely
3. **IntegrationCount has no staleness gate** — runs unconditionally, all other 6 have IF-stale checks
4. **Completeness calculation fragile** — relies on `status === 'success'` from sub-workflow output rather than re-reading the Airtable record to count non-null fields
5. **Merge `numberInputs: 9` but only 8 wired** — will hang waiting for input that never arrives
6. **No per-record isolation** — unlike VendorOrchestrator, doesn't self-call per record

### WT-APICheck
7. **`matched_url` always empty** — HTTP Response replaces the input item, so the original `candidate_url` from Build Candidate URLs is lost. Needs index correlation back to the input items.

### WT-Score
8. **Format Return Value returns plain object** — Code v2 "Run Once for All Items" requires `[{ json: {...} }]`, will error at runtime
9. **Review volume normalization** — uses only `g2_review_count` stats but normalizes the sum of G2 + Capterra, so values will exceed the normalization range

### WT-SearchDemand
10. **Missing `engine=google` query parameter** on the Search Volume Request — may work if the proxy defaults to Google, but should be explicit

---

## Recurring Pattern Issues (across 4-5 workflows)

- **Missing Normalize Input + Has Required Fields? nodes** in WT-Marketplace, WT-iPaaS, WT-Reviews, WT-Reddit, WT-IntegrationCount — records with empty Name fields will waste API calls
- **Field names vs field IDs** in Airtable Update nodes — all workflows use human-readable names with `typecast: true` rather than `fld*` IDs. Works but fragile. Consistent across all files, so this is a deliberate pattern choice, not a per-file bug.
- **Stale `httpHeaderAuth` credential** alongside the correct `httpBearerAuth` in SerpAPI nodes (Marketplace, iPaaS, Reviews, Reddit) — harmless dead weight

---

## What Looks Good
- All scoring formulas match spec weights exactly (0.30/0.25/0.20/0.15/0.10)
- Bayesian rating, employee sweet-spot curve, funding score all implemented correctly
- Tier assignment percentiles correct (5%/25%/60%)
- Emerging flag logic correct
- VendorOrchestrator staleness changes are clean
- BlogRecency tightening is sensible
- Credentials and settings correct across all files
- All planned Airtable fields covered

---

**Priority:** Fix the ToolOrchestrator blockers (items 1-6) first since it's the glue that ties everything together, then the APICheck URL bug (#7) and Score return format (#8). The Normalize Input gaps (#4 workflows) are worth adding but won't cause crashes — they'll just waste API calls on bad records. Want me to start fixing any of these?