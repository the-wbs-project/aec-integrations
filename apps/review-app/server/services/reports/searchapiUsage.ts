// ---------------------------------------------------------------------------
// SearchAPI.io usage tracking + weekly summary.
//
// Two-step flow:
//   1. At search time, every successful call writes a tiny KV breadcrumb keyed
//      by `search_id` (returned in `search_metadata.id`). The value records
//      which workflow + run issued the search.
//   2. At report time, we list those breadcrumbs, filter to the report window,
//      and compute cost as calls × SEARCHAPI_COST_PER_SEARCH (USD per search,
//      configured in wrangler.jsonc).
//
// We use a flat per-search rate instead of querying SearchAPI for per-call
// cost because their account endpoint surfaces credits, not USD on every plan,
// and a single env var is simpler / auditable.
//
// KV layout
//   key:   searchapi:{search_id}
//   value: { runId, workflow, engine, query, createdAtIso }
//   TTL:   14 days (long enough for a weekly window + retries).
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import type { CostSummary, WorkflowCostRow } from './types';

const KV_PREFIX = 'searchapi:';
const KV_TTL_S = 14 * 24 * 60 * 60;
// Cap so a runaway window can't take down the cron tick.
const MAX_RECORDS = 5000;

export interface SearchUsageRecord {
  runId: string;
  workflow: string;
  engine: string;
  query: string;
  createdAtIso: string;
}

export async function recordSearch(
  env: Env,
  args: { searchId: string; runId: string; workflow: string; engine: string; query: string },
): Promise<void> {
  if (!args.searchId) return;
  const value: SearchUsageRecord = {
    runId: args.runId,
    workflow: args.workflow,
    engine: args.engine,
    query: args.query,
    createdAtIso: new Date().toISOString(),
  };
  try {
    await env.KV_CACHE.put(`${KV_PREFIX}${args.searchId}`, JSON.stringify(value), {
      expirationTtl: KV_TTL_S,
    });
  } catch (err) {
    // Non-fatal — we don't want to break the workflow if usage tracking fails.
    console.warn(`[searchapi-usage] KV write failed for ${args.searchId}: ${String(err)}`);
  }
}

function parseRate(raw: string): { rate: number; warning?: string } {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) {
    return {
      rate: 0,
      warning: `SEARCHAPI_COST_PER_SEARCH="${raw}" is not a valid non-negative number; treating as $0.`,
    };
  }
  return { rate: n };
}

export async function summarizeSearchapiUsage(
  env: Env,
  opts: { startIso: string; endIso: string },
): Promise<CostSummary> {
  const notes: string[] = [];
  const { rate, warning } = parseRate(env.SEARCHAPI_COST_PER_SEARCH ?? '0');
  if (warning) notes.push(warning);

  // 1) List all searchapi: keys (paginated).
  const allKeys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await env.KV_CACHE.list({ prefix: KV_PREFIX, cursor, limit: 1000 });
    for (const k of list.keys) allKeys.push(k.name);
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor && allKeys.length < MAX_RECORDS);

  if (allKeys.length === 0) {
    return {
      rows: [],
      totalCalls: 0,
      totalCostUsd: 0,
      unattributedCalls: 0,
      unattributedCostUsd: 0,
      notes,
    };
  }
  if (allKeys.length >= MAX_RECORDS) {
    notes.push(`SearchAPI: capped at ${MAX_RECORDS} KV records; totals may be incomplete.`);
  }

  // 2) Read each KV value and filter by the report window.
  const startMs = Date.parse(opts.startIso);
  const endMs = Date.parse(opts.endIso);
  const byWorkflow = new Map<string, number>();
  let unattributedCalls = 0;
  let totalCalls = 0;

  for (const key of allKeys) {
    const raw = await env.KV_CACHE.get(key, 'json');
    if (!raw) continue;
    const record = raw as SearchUsageRecord;
    const ts = Date.parse(record.createdAtIso);
    if (!Number.isFinite(ts)) continue;
    if (ts < startMs || ts > endMs) continue;

    totalCalls += 1;
    const wf = record.workflow || '';
    if (wf) {
      byWorkflow.set(wf, (byWorkflow.get(wf) ?? 0) + 1);
    } else {
      unattributedCalls += 1;
    }
  }

  // 3) Cost = calls × flat rate. No per-search HTTP lookup.
  const rows: WorkflowCostRow[] = Array.from(byWorkflow.entries())
    .map(([workflow, calls]) => ({ workflow, calls, costUsd: calls * rate }))
    .sort((a, b) => b.costUsd - a.costUsd || a.workflow.localeCompare(b.workflow));

  notes.push(`SearchAPI cost computed at $${rate.toFixed(4)}/search (SEARCHAPI_COST_PER_SEARCH).`);

  return {
    rows,
    totalCalls,
    totalCostUsd: totalCalls * rate,
    unattributedCalls,
    unattributedCostUsd: unattributedCalls * rate,
    notes,
  };
}
