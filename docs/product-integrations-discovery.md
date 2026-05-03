# Product Integrations Discovery Workflow

## Context

Integrations are first-class records in Airtable (linked source/target Products, mechanism, evidence URLs, maturity, etc.) but today they are **manually created**. The only existing automation, `product-integration-count`, just counts what already exists — nothing actually discovers integrations.

We need a workflow that, given a Product, sweeps the places where integration evidence lives, normalizes what it finds, and materializes Integration records linking back to the source Product. Where target Vendors don't yet exist, the workflow auto-creates Vendor stubs. Product auto-creation is deferred — unmatched products are parked as candidates on the source Product for later resolution.

## Architecture

Follow the existing T0x leaf-and-orchestrator pattern. Add six per-source leaves and a sub-orchestrator dedicated to integration discovery. The main `product-orchestrator` stays clean; curators (and the existing dispatcher at `routes/workflows.ts`) can run discovery on-demand.

```
product-integrations-discovery   (NEW orchestrator)
  ├─ product-integrations-website        (vendor's /integrations, /partners, /apps page)
  ├─ product-integrations-ipaas          (Zapier, Workato, Make, Tray.io, n8n connector lists)
  ├─ product-integrations-marketplaces   (Procore, ACC, Trimble, Bluebeam listing pages)
  ├─ product-integrations-g2             (G2 "Integrations" section on the product page)
  ├─ product-integrations-github         (vendor GitHub org repos w/ "connector"/"sdk"/"integration")
  └─ product-integrations-web            (web_search fallback: "<product> integrates with", press, partner news)

→ aggregator step: dedupe + resolve + materialize (in the orchestrator)
```

Each leaf returns a normalized array of `IntegrationCandidate`. The orchestrator merges, dedupes, resolves vendors/products, creates Integration records, and writes the unresolved remainder to the Product as a JSON candidate list.

## Sources & evidence per leaf

| Leaf | Strategy | Evidence URL captured |
|---|---|---|
| website | `services/scrapfly.ts` GET on `/integrations`, `/partners`, `/apps`, `/marketplace`; LLM extract | exact page URL |
| ipaas | LLM with `web_search` scoped to `site:zapier.com/apps`, `site:workato.com`, `site:make.com`, `site:tray.io`, `site:n8n.io/integrations` | connector listing URL |
| marketplaces | Reuse `services/scrapfly.ts` to fetch marketplace listings already discovered by `product-marketplace` (`source_marketplaces` field) and extract listed-with/works-with sections | listing URL |
| g2 | `services/g2-parse.ts` already pulls the G2 product page — extend to extract the "Integrations" section | G2 product URL |
| github | `services/github.ts` org slug already on vendor; list repos and filter on naming/topics; pull README signals | repo URL |
| web | LLM `web_search` (MAX_USES=5): `"<product>" integration partner`, `"<product>" "integrates with"`, `"<product>" partnership announcement` | source URL from search result |

All leaves use the existing `lib/llm.ts` runTurn loop with `emit_result` and `OutputSchema` validation — match `workflows/product/marketplace.ts:34-93`.

## Shared types & helpers (new)

`apps/review-app/server/services/integrationCandidates.ts`:

```ts
export interface IntegrationCandidate {
  targetName: string;            // raw product/vendor name as found
  targetWebsite?: string;
  targetVendorName?: string;     // separate when found (e.g. "Procore" vendor, "Procore Project Management" product)
  mechanismKind?: string;        // 'native'|'iPaaS'|'marketplace-app'|'api'|'webhook'|'partner'
  mechanismName?: string;        // e.g. "Zapier connector", "Procore App"
  direction?: 'one-way'|'bidirectional';
  evidenceUrl: string;           // REQUIRED — the URL we saw it on
  evidenceSource: 'website'|'ipaas'|'marketplaces'|'g2'|'github'|'web';
  notes?: string;
  confidence: 'high'|'medium'|'low';
}

export async function resolveAndMaterialize(
  env: Env,
  sourceProductId: string,
  candidates: IntegrationCandidate[],
): Promise<{
  createdIntegrations: string[];
  createdVendors: string[];
  unresolved: IntegrationCandidate[];
}>;
```

Resolution flow inside `resolveAndMaterialize`:

1. Group/dedupe candidates by normalized `targetName` + `targetWebsite` host. Keep highest-confidence evidence URL plus all sources for traceability.
2. **Vendor lookup** — `listRecords(env, 'vendors', { filterByFormula: ... })` matching company_name OR website host.
3. **If vendor missing** — call `createVendorAndStartOrchestrator(env, { companyName, website, skipOrchestrator: true, triggeredBy: 'http' })` from `services/createVendor.ts:52`. Reuses the cache-invalidation path; `skipOrchestrator: true` avoids fanning out a full vendor enrichment for every discovered partner.
4. **Product lookup** — `listRecords(env, 'products')` matching name OR `vendor` link.
5. **If product missing** — DO NOT create. Leave the candidate in the unresolved bucket with `vendorId` populated. (Auto-creation deferred — to be added later.)
6. **If both resolved** — `createRecord(env, 'integrations', { Name, 'Source Tool': [sourceProductId], 'Target Tool': [targetProductId], mechanism_kind, mechanism_name, direction, listing_url: evidenceUrl, notes, ... })`. Skip if an integration already exists with the same (source, target, mechanism_kind) tuple — query existing source linked records first.

## New workflow files

- `apps/review-app/server/workflows/product/integrationsWebsite.ts`
- `apps/review-app/server/workflows/product/integrationsIpaas.ts`
- `apps/review-app/server/workflows/product/integrationsMarketplaces.ts`
- `apps/review-app/server/workflows/product/integrationsG2.ts`
- `apps/review-app/server/workflows/product/integrationsGithub.ts`
- `apps/review-app/server/workflows/product/integrationsWeb.ts`
- `apps/review-app/server/workflows/product/integrationsDiscovery.ts` (orchestrator)
- `apps/review-app/server/services/integrationCandidates.ts` (shared types + materializer)

Each leaf class extends `ErrorCapturingWorkflow`, uses `checkpoint(step, …)` for resumability, fetches the product via `getRecord`, builds prompts via `lib/llm.ts`, and writes `<source>_candidates_checked_at` plus a `<source>_candidates` JSON blob back to the product so the orchestrator can read them in its aggregate step.

## New Product fields (Airtable)

Add via the Airtable UI before running:

- `integrations_discovery_checked_at` — datetime
- `integrations_discovery_candidates` — long text (JSON of `IntegrationCandidate[]` for unresolved targets)
- `integrations_discovery_summary` — long text (one-line per source: count + status)
- Per leaf: `integrations_<source>_candidates_checked_at`, `integrations_<source>_candidates`

Surface these in `apps/review-app/server/types.ts` `Product` and read them in `apps/review-app/server/hydrate.ts` (around the existing integration count block at line 170-200).

## Files to modify

- `apps/review-app/server/workflows/registry.ts` — register new bindings (`WF_PRODUCT_INTEGRATIONS_*`).
- `apps/review-app/wrangler.jsonc` (or `wrangler.toml`) — add Workflow bindings for each new class.
- `apps/review-app/server/lib/workflow-meta.ts` — list new slugs.
- `apps/review-app/server/workflows/product/orchestrator.ts:54-62` — optionally add `product-integrations-discovery` as a final leaf with `stalenessField: 'integrations_discovery_checked_at'`. Run it AFTER `product-integration-count` so the count reflects the new records.
- `apps/review-app/server/types.ts`, `apps/review-app/src/app/types.ts`, `apps/review-app/server/hydrate.ts` — surface new fields in `ProductDetail`.
- `apps/review-app/src/app/pages/product-detail/product-detail.component.{ts,html}` — show the unresolved candidates list and a "Discover integrations" trigger button on the Integrations tab.

## Existing utilities to reuse

- `services/airtable.ts:78` `getRecord`, `:92` `updateRecord`, `:112` `createRecord`, `:135` `listRecords`
- `services/createVendor.ts:52` `createVendorAndStartOrchestrator` (vendor stub creation)
- `services/scrapfly.ts` (page fetches)
- `services/g2-parse.ts`, `services/capterra-parse.ts` (existing review-page parsers — extend for integrations section)
- `services/github.ts` (org/repo lookups)
- `lib/llm.ts` `buildInitialRequest`, `runTurn`, `interpretMessage`, `executeSearchTool`
- `lib/checkpoint.ts` `checkpoint`
- `lib/error-capturing-workflow.ts` `ErrorCapturingWorkflow`
- `lib/notify-run-started.ts` `notifyRunStarted`

## Verification

1. **Dry run**: pick a product with known integrations (e.g., Procore) and `POST /api/workflows/product-integrations-discovery/run` with `{ record_ids: ["<recId>"], force_refresh: true }`. Confirm:
   - One run row appears in the runs UI per leaf.
   - Each leaf writes a `*_candidates` JSON blob.
   - Aggregate step writes `integrations_discovery_candidates` and creates Integration records visible on the product detail Integrations tab.
2. **Vendor stub creation**: verify a previously-unknown target (e.g. a niche Zapier connector vendor) appears in the Vendors table with `triggeredBy='http'`, no orchestrator run spawned.
3. **Dedupe**: run twice in a row — second run creates zero new Integration records.
4. **Unresolved bucket**: candidates whose vendor exists but product doesn't get parked in `integrations_discovery_candidates` (not silently dropped).
5. **UI**: the Integrations tab on product detail shows new records with their evidence URLs (`listing_url`) clickable.
6. **Type-check**: `pnpm -F review-app typecheck` passes.
