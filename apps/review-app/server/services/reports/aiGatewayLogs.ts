// ---------------------------------------------------------------------------
// Fetch + aggregate AI Gateway logs for the weekly cost report.
//
// Calls Cloudflare's REST endpoint:
//   GET /accounts/{account_id}/ai-gateway/gateways/{gateway_id}/logs
//
// Each log entry carries `cost` (USD) and `metadata` (we already stamp
// `workflow` + `runId` on every gateway request via runMessage()). We page
// until either the window is exhausted or a hard cap is reached, then group
// by `metadata.workflow`.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import type { CostSummary, WorkflowCostRow } from './types';

const PER_PAGE = 100;
// Hard ceiling so a misconfigured token / gateway can't run us through tens
// of thousands of pages in a cron tick.
const MAX_PAGES = 200;

interface GatewayLogEntry {
  id?: string;
  created_at?: string;
  cost?: number;
  // Some gateway versions report the stringified currency value alongside.
  metadata?: Record<string, unknown> | string | null;
}

interface GatewayLogsResponse {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: GatewayLogEntry[];
  result_info?: {
    page?: number;
    per_page?: number;
    total_count?: number;
    total_pages?: number;
  };
}

function parseMetadata(raw: GatewayLogEntry['metadata']): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return raw;
}

export interface FetchOptions {
  /** Inclusive lower bound (ISO 8601). */
  startIso: string;
  /** Inclusive upper bound (ISO 8601). */
  endIso: string;
}

export async function summarizeGatewayUsage(
  env: Env,
  opts: FetchOptions,
): Promise<CostSummary> {
  const byWorkflow = new Map<string, { calls: number; costUsd: number }>();
  const notes: string[] = [];
  let unattributedCalls = 0;
  let unattributedCostUsd = 0;
  let totalCalls = 0;
  let totalCostUsd = 0;

  if (!env.CF_API_TOKEN) {
    notes.push('CF_API_TOKEN missing — skipped AI Gateway log fetch.');
    return {
      rows: [],
      totalCalls: 0,
      totalCostUsd: 0,
      unattributedCalls: 0,
      unattributedCostUsd: 0,
      notes,
    };
  }

  let page = 1;
  let cappedAtMaxPages = false;
  while (page <= MAX_PAGES) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.AI_GATEWAY_ID}/logs`,
    );
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('start_date', opts.startIso);
    url.searchParams.set('end_date', opts.endIso);
    url.searchParams.set('order_by', 'created_at');
    url.searchParams.set('order_by_direction', 'desc');

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '<unreadable>');
      notes.push(`AI Gateway logs page ${page} failed (${resp.status}): ${text.slice(0, 200)}`);
      break;
    }
    const json = (await resp.json()) as GatewayLogsResponse;
    if (json.success === false) {
      const msg = json.errors?.map((e) => e.message).join('; ') ?? 'unknown error';
      notes.push(`AI Gateway API error on page ${page}: ${msg}`);
      break;
    }
    const entries = json.result ?? [];
    for (const entry of entries) {
      const cost = typeof entry.cost === 'number' && Number.isFinite(entry.cost) ? entry.cost : 0;
      const meta = parseMetadata(entry.metadata);
      const workflow = typeof meta['workflow'] === 'string' ? (meta['workflow'] as string) : '';
      totalCalls += 1;
      totalCostUsd += cost;
      if (workflow) {
        const cur = byWorkflow.get(workflow) ?? { calls: 0, costUsd: 0 };
        cur.calls += 1;
        cur.costUsd += cost;
        byWorkflow.set(workflow, cur);
      } else {
        unattributedCalls += 1;
        unattributedCostUsd += cost;
      }
    }

    const totalPages = json.result_info?.total_pages ?? 1;
    if (entries.length < PER_PAGE || page >= totalPages) break;
    page += 1;
    if (page > MAX_PAGES) {
      cappedAtMaxPages = true;
    }
  }
  if (cappedAtMaxPages) {
    notes.push(`Stopped at MAX_PAGES=${MAX_PAGES} — totals may be incomplete.`);
  }

  const rows: WorkflowCostRow[] = Array.from(byWorkflow.entries())
    .map(([workflow, v]) => ({ workflow, calls: v.calls, costUsd: v.costUsd }))
    .sort((a, b) => b.costUsd - a.costUsd || a.workflow.localeCompare(b.workflow));

  return { rows, totalCalls, totalCostUsd, unattributedCalls, unattributedCostUsd, notes };
}
