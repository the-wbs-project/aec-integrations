// ---------------------------------------------------------------------------
// Auto-enrich consumer.
//
// Picks the first N vendors that are either never-enriched (BLANK
// last_enriched_at) or stale (older than STALE_AFTER_DAYS), and spawns a
// vendor-orchestrator instance for each with forceRefresh: true.
//
// Two queries instead of one — Airtable's `sort` param accepts only field
// names, and BLANKs sort *last* under `asc`. Querying BLANKs first then
// filling the remainder with oldest-stale rows guarantees BLANK-first
// ordering without depending on a hidden Airtable view.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { listRecords, asString } from '../airtable';
import { resolveSearchTool } from '../../lib/llm';
import { notifyRunStarted } from '../../lib/notify-run-started';
import { buildLookupMaps } from '../../hydrate';
import type { RunParams } from '../../lib/workflow-meta';

const STALE_AFTER_DAYS = 60;
const VALID_MODEL = /^claude-(opus|sonnet|haiku)-[\w.-]+$/;

export interface AutoEnrichResult {
  spawned: Array<{ runId: string; recordId: string }>;
  totalCandidates: number;
}

export async function runVendorAutoEnrich(
  env: Env,
  args: { count: number; model?: string; triggeredBy: 'cron' | 'http' },
): Promise<AutoEnrichResult> {
  if (!Number.isFinite(args.count) || args.count <= 0) {
    return { spawned: [], totalCandidates: 0 };
  }

  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const blankRows = await listRecords(env, 'vendors', {
    filterByFormula: `{last_enriched_at} = BLANK()`,
    fields: ['company_name', 'last_enriched_at'],
    maxRecords: args.count,
  });

  const remaining = args.count - blankRows.length;
  const staleRows =
    remaining > 0
      ? await listRecords(env, 'vendors', {
          filterByFormula: `AND({last_enriched_at} != BLANK(), IS_BEFORE({last_enriched_at}, '${cutoff}'))`,
          fields: ['company_name', 'last_enriched_at'],
          maxRecords: remaining,
          sort: [{ field: 'last_enriched_at', direction: 'asc' }],
        })
      : [];

  const candidates = [...blankRows, ...staleRows];
  if (candidates.length === 0) return { spawned: [], totalCandidates: 0 };

  const requested = args.model ?? env.DEFAULT_MODEL;
  if (!VALID_MODEL.test(requested)) {
    throw new Error(`Invalid model in auto-enrich job: ${requested}`);
  }
  const model = requested;
  const searchTool = resolveSearchTool(env, env.SEARCH_TOOL);

  let labels: Map<string, string> | undefined;
  try {
    labels = (await buildLookupMaps(env)).vendors;
  } catch {
    labels = undefined;
  }

  const spawned: Array<{ runId: string; recordId: string }> = [];
  for (const rec of candidates) {
    const runId = crypto.randomUUID();
    const params: RunParams = { recordId: rec.id, model, searchTool, forceRefresh: true };
    await env.WF_VENDOR_ORCHESTRATOR.create({ id: runId, params });

    const recordLabel = labels?.get(rec.id) ?? asString(rec.fields['company_name']);
    try {
      await notifyRunStarted(env, {
        runId,
        workflow: 'vendor-orchestrator',
        recordId: rec.id,
        recordLabel,
        triggeredBy: 'auto-enrich',
        forceRefresh: true,
        model,
      });
    } catch (err) {
      console.error('[auto-enrich] notifyRunStarted failed', runId, String(err));
    }

    spawned.push({ runId, recordId: rec.id });
  }

  console.log(
    `[auto-enrich] triggeredBy=${args.triggeredBy} requested=${args.count} spawned=${spawned.length} blanks=${blankRows.length} stale=${staleRows.length} model=${model}`,
  );

  return { spawned, totalCandidates: candidates.length };
}
