// ---------------------------------------------------------------------------
// Product auto-enrich consumer.
//
// Picks the first N products that are either never-scored (BLANK
// priority_tier — orchestrator has not produced a tier yet) or stale
// (last_tool_enriched_at older than STALE_AFTER_DAYS), and spawns a
// product-orchestrator instance for each with forceRefresh: true.
//
// Two queries instead of one — Airtable's `sort` param accepts only field
// names, and BLANKs sort *last* under `asc`. Querying BLANKs first then
// filling the remainder with oldest-stale rows guarantees BLANK-first
// ordering without depending on a hidden Airtable view.
//
// STALE_AFTER_DAYS matches the orchestrator's own staleness threshold
// (server/workflows/product/orchestrator.ts).
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { listRecords, asString } from '../airtable';
import { resolveSearchTool } from '../../lib/llm';
import { notifyRunStarted } from '../../lib/notify-run-started';
import { buildLookupMaps } from '../../hydrate';
import type { RunParams } from '../../lib/workflow-meta';

const STALE_AFTER_DAYS = 60;
const VALID_MODEL = /^claude-(opus|sonnet|haiku)-[\w.-]+$/;

export interface ProductAutoEnrichResult {
  spawned: Array<{ runId: string; recordId: string }>;
  totalCandidates: number;
}

export async function runProductAutoEnrich(
  env: Env,
  args: { count: number; model?: string; triggeredBy: 'cron' | 'http' },
): Promise<ProductAutoEnrichResult> {
  if (!Number.isFinite(args.count) || args.count <= 0) {
    console.warn(`[product-auto-enrich] invalid count=${args.count} triggeredBy=${args.triggeredBy}`);
    return { spawned: [], totalCandidates: 0 };
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let blankRows: Awaited<ReturnType<typeof listRecords>>;
  try {
    blankRows = await listRecords(env, 'products', {
      filterByFormula: `{priority_tier} = BLANK()`,
      fields: ['Name', 'priority_tier', 'last_tool_enriched_at'],
      maxRecords: args.count,
    });
  } catch (err) {
    console.error(`[product-auto-enrich] BLANK query FAILED: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  const remaining = args.count - blankRows.length;
  let staleRows: Awaited<ReturnType<typeof listRecords>> = [];
  if (remaining > 0) {
    try {
      staleRows = await listRecords(env, 'products', {
        filterByFormula: `AND({priority_tier} != BLANK(), {last_tool_enriched_at} != BLANK(), IS_BEFORE({last_tool_enriched_at}, '${cutoff}'))`,
        fields: ['Name', 'priority_tier', 'last_tool_enriched_at'],
        maxRecords: remaining,
        sort: [{ field: 'last_tool_enriched_at', direction: 'asc' }],
      });
    } catch (err) {
      console.error(`[product-auto-enrich] STALE query FAILED: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  const candidates = [...blankRows, ...staleRows];

  if (candidates.length === 0) {
    console.warn(
      `[product-auto-enrich] NO CANDIDATES triggeredBy=${args.triggeredBy} requested=${args.count} blanks=0 stale=0 cutoff=${cutoff}`,
    );
    return { spawned: [], totalCandidates: 0 };
  }

  const requested = args.model ?? env.DEFAULT_MODEL;
  if (!VALID_MODEL.test(requested)) {
    throw new Error(`Invalid model in product-auto-enrich job: ${requested}`);
  }
  const model = requested;
  const searchTool = resolveSearchTool(env, env.SEARCH_TOOL);

  let labels: Map<string, string> | undefined;
  try {
    labels = (await buildLookupMaps(env)).products;
  } catch (err) {
    console.warn(
      `[product-auto-enrich] buildLookupMaps failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    labels = undefined;
  }

  const spawned: Array<{ runId: string; recordId: string }> = [];
  for (const rec of candidates) {
    const runId = crypto.randomUUID();
    const params: RunParams = { recordId: rec.id, model, searchTool, forceRefresh: true };

    try {
      await env.WF_PRODUCT_ORCHESTRATOR.create({ id: runId, params });
    } catch (err) {
      console.error(
        `[product-auto-enrich] WF_PRODUCT_ORCHESTRATOR.create FAILED runId=${runId} recordId=${rec.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    const recordLabel = labels?.get(rec.id) ?? asString(rec.fields['Name']);
    try {
      await notifyRunStarted(env, {
        runId,
        workflow: 'product-orchestrator',
        recordId: rec.id,
        recordLabel,
        triggeredBy: 'auto-enrich',
        forceRefresh: true,
        model,
      });
    } catch (err) {
      console.error(
        `[product-auto-enrich] notifyRunStarted FAILED runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    spawned.push({ runId, recordId: rec.id });
  }

  console.log(
    `[product-auto-enrich] triggeredBy=${args.triggeredBy} requested=${args.count} spawned=${spawned.length} blanks=${blankRows.length} stale=${staleRows.length} model=${model}`,
  );

  return { spawned, totalCandidates: candidates.length };
}
