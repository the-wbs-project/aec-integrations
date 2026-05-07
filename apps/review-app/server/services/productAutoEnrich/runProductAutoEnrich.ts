// ---------------------------------------------------------------------------
// Product auto-enrich consumer.
//
// Picks the first N products that are either never-scored (BLANK
// priority_tier — never enriched) or stale (last_tool_enriched_at older
// than STALE_AFTER_DAYS), and enqueues an `enrich-product` playbook job for
// each with `force_refresh: true`. The scheduled dispatcher drains the
// queue serially across subsequent ticks.
//
// Two queries instead of one — Airtable's `sort` param accepts only field
// names, and BLANKs sort *last* under `asc`. Querying BLANKs first then
// filling the remainder with oldest-stale rows guarantees BLANK-first
// ordering without depending on a hidden Airtable view.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { listRecords } from '../airtable';
import { enqueue } from '../promptQueue';

const STALE_AFTER_DAYS = 60;

export interface ProductAutoEnrichResult {
  /** Airtable prompt_queue record IDs created this tick. */
  enqueued: Array<{ queueRecordId: string; recordId: string }>;
  totalCandidates: number;
}

export async function runProductAutoEnrich(
  env: Env,
  args: { count: number; model?: string; triggeredBy: 'cron' | 'http' },
): Promise<ProductAutoEnrichResult> {
  if (!Number.isFinite(args.count) || args.count <= 0) {
    console.warn(`[product-auto-enrich] invalid count=${args.count} triggeredBy=${args.triggeredBy}`);
    return { enqueued: [], totalCandidates: 0 };
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
    return { enqueued: [], totalCandidates: 0 };
  }

  const enqueued: Array<{ queueRecordId: string; recordId: string }> = [];
  for (const rec of candidates) {
    try {
      const result = await enqueue(env, {
        playbookSlug: 'enrich-product',
        targetRecordId: rec.id,
        forceRefresh: true,
        requestedBy: `${args.triggeredBy}:product-auto-enrich`,
      });
      enqueued.push({ queueRecordId: result.recordId, recordId: rec.id });
    } catch (err) {
      console.error(
        `[product-auto-enrich] enqueue FAILED recordId=${rec.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  console.log(
    `[product-auto-enrich] triggeredBy=${args.triggeredBy} requested=${args.count} enqueued=${enqueued.length} blanks=${blankRows.length} stale=${staleRows.length}`,
  );

  return { enqueued, totalCandidates: candidates.length };
}
