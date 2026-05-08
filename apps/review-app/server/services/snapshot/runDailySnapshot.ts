// ---------------------------------------------------------------------------
// Daily-stats snapshot. Counts records in products / vendors / integrations,
// derives funnel + activity metrics, and writes one row to the `daily_stats`
// Airtable table. Same entry point is invoked from cron, queue consumer, and
// ad-hoc HTTP.
//
// Counts read directly via listRecords (not fetchProducts/etc.) so the snapshot
// always sees fresh data and gets `createdTime` for the new-today metrics —
// the cached fetchAll helpers strip createdTime when persisting to KV.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { createRecord, listRecords } from '../airtable';

export interface RunOptions {
  /** Override snapshot date (UTC YYYY-MM-DD). Defaults to today (UTC). */
  date?: string;
  /** End-of-window override; defaults to now. */
  endIso?: string;
}

export interface SnapshotCounts {
  total_products: number;
  total_promoted_products: number;
  total_vendors: number;
  total_integrations: number;
  pending_products: number;
  ready_products: number;
  retracted_products: number;
  rejected_products: number;
  researched_products: number;
  enriched_vendors: number;
  unenriched_products: number;
  new_products_today: number;
  new_vendors_today: number;
  new_integrations_today: number;
}

export interface RunResult extends SnapshotCounts {
  date: string;
  recordId: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runDailySnapshot(env: Env, opts: RunOptions = {}): Promise<RunResult> {
  const now = opts.endIso ? new Date(opts.endIso) : new Date();
  const date = opts.date ?? now.toISOString().slice(0, 10);
  const cutoffMs = now.getTime() - DAY_MS;

  const [products, vendors, integrations] = await Promise.all([
    listRecords(env, 'products', {
      fields: ['promotion_status', 'research_status', 'last_tool_enriched_at'],
    }),
    listRecords(env, 'vendors', { fields: ['vqs_score'] }),
    listRecords(env, 'integrations', { fields: ['Name'] }),
  ]);

  const counts: SnapshotCounts = {
    total_products: 0,
    total_promoted_products: 0,
    total_vendors: vendors.length,
    total_integrations: integrations.length,
    pending_products: 0,
    ready_products: 0,
    retracted_products: 0,
    rejected_products: 0,
    researched_products: 0,
    enriched_vendors: 0,
    unenriched_products: 0,
    new_products_today: 0,
    new_vendors_today: 0,
    new_integrations_today: 0,
  };

  const isNew = (createdTime?: string): boolean => {
    if (!createdTime) return false;
    const ms = new Date(createdTime).getTime();
    return Number.isFinite(ms) && ms >= cutoffMs && ms <= now.getTime();
  };

  for (const r of products) {
    const promotion = r.get('promotion_status');
    const research = r.get('research_status');
    const enrichedAt = r.get('last_tool_enriched_at');
    const isRejected = promotion === 'rejected';

    if (isRejected) {
      counts.rejected_products++;
      continue;
    }

    counts.total_products++;
    if (promotion === 'promoted') counts.total_promoted_products++;
    if (promotion === 'pending') counts.pending_products++;
    if (promotion === 'ready') counts.ready_products++;
    if (promotion === 'retracted') counts.retracted_products++;
    if (typeof research === 'string' && research.length > 0 && research !== 'Pending') {
      counts.researched_products++;
    }
    if (!enrichedAt) counts.unenriched_products++;
    if (isNew(r.createdTime)) counts.new_products_today++;
  }

  for (const r of vendors) {
    if (typeof r.get('vqs_score') === 'number') counts.enriched_vendors++;
    if (isNew(r.createdTime)) counts.new_vendors_today++;
  }

  for (const r of integrations) {
    if (isNew(r.createdTime)) counts.new_integrations_today++;
  }

  const created = await createRecord(env, 'dailyStats', {
    date,
    ...counts,
    created_at: now.toISOString(),
  });

  console.log(
    `[daily-stats-snapshot] wrote id=${created.id} date=${date} ` +
      `total_products=${counts.total_products} promoted=${counts.total_promoted_products} ` +
      `vendors=${counts.total_vendors} integrations=${counts.total_integrations} ` +
      `new_products=${counts.new_products_today} new_vendors=${counts.new_vendors_today} ` +
      `new_integrations=${counts.new_integrations_today}`,
  );

  return { date, recordId: created.id, ...counts };
}
