/**
 * `GET /api/vendor/history` and `GET /api/vendor/history.csv` (AECI-1194,
 * `API_CONTRACTS.md` §6.14 "Change history"), and since AECI-1160
 * `GET /api/vendor/history/follow-up`, the search follow-up of one page of it.
 *
 * The vendor's own change history, as JSON pages and as a CSV export. Both run
 * the same query (`lib/vendor-history.ts`), scoped by the session's vendor id.
 *
 * - `requireVendor()` only. **No capability gate**: every vendor, Free included,
 *   sees what AECi changed on its records. Reads are never gated
 *   (`STAGE_2_PAID_TIERS_SPEC.md` §4.3).
 * - **No rate limit.** Reads are never rate-limited (ADR 0026).
 * - **No audit row.** Reading the log does not write to it.
 */

import {
  ListVendorHistoryFollowUpResponseSchema,
  ListVendorHistoryResponseSchema,
  VENDOR_HISTORY_CSV_COLUMNS,
  VENDOR_HISTORY_CSV_MAX_ROWS,
  VENDOR_HISTORY_CSV_TOTAL_HEADER,
  VENDOR_HISTORY_CSV_TRUNCATED_HEADER,
  VendorHistoryFilterSchema,
  VendorHistoryFollowUpQuerySchema,
  VendorHistoryQuerySchema,
  type ListVendorHistoryFollowUpResponse,
  type ListVendorHistoryResponse,
  type VendorHistoryItem,
} from '@aeci/shared';
import { toCsv, type CsvValue } from '@aeci/shared/csv';

import { getDb } from '../db/client';
import { json } from '../http';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { listVendorHistory } from '../lib/vendor-history';
import { loadVendorHistoryFollowUp } from '../lib/vendor-history-follow-up';
import { sessionVendorId, type VendorContext } from './vendor-shared';

function searchParams(c: VendorContext): Record<string, string> {
  return Object.fromEntries(new URL(c.req.url).searchParams);
}

export function createListVendorHistoryHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const query = VendorHistoryQuerySchema.parse(searchParams(c));
    const { db } = dbFor(c.env);

    const { items, total } = await listVendorHistory(db, vendorId, query, {
      limit: query.perPage,
      offset: (query.page - 1) * query.perPage,
    });

    const body: ListVendorHistoryResponse = {
      data: items,
      page: query.page,
      perPage: query.perPage,
      total,
    };
    validateResponseInDev(c.env, () => ListVendorHistoryResponseSchema.parse(body));
    return json(body);
  };
}

/** One CSV line per item, in `VENDOR_HISTORY_CSV_COLUMNS` order. */
export function vendorHistoryCsvRow(item: VendorHistoryItem): CsvValue[] {
  return [
    item.id,
    item.at,
    item.actor_kind,
    item.action,
    item.entity_type,
    item.entity_id,
    item.entity_name,
    item.fields.join(';'),
    item.plan?.tier ?? null,
    item.plan?.status ?? null,
    item.reason ?? null,
  ];
}

export function createVendorHistoryCsvHandler(
  dbFor: DbFactory = getDb,
  now: () => Date = () => new Date(),
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const filter = VendorHistoryFilterSchema.parse(searchParams(c));
    const { db } = dbFor(c.env);

    const { items, total } = await listVendorHistory(db, vendorId, filter, {
      limit: VENDOR_HISTORY_CSV_MAX_ROWS,
      offset: 0,
    });

    const date = now().toISOString().slice(0, 10);
    const headers = new Headers({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="aec-integrations-change-history-${date}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      [VENDOR_HISTORY_CSV_TOTAL_HEADER]: String(total),
      [VENDOR_HISTORY_CSV_TRUNCATED_HEADER]: String(total > items.length),
    });
    return new Response(toCsv(VENDOR_HISTORY_CSV_COLUMNS, items.map(vendorHistoryCsvRow)), {
      status: 200,
      headers,
    });
  };
}

/**
 * `GET /api/vendor/history/follow-up?ids=…` (AECI-1160). The search follow-up of
 * one history page, keyed by the page's audit ids: one request per page, never one
 * per row. Same guard as the history read and nothing else: no capability gate, no
 * rate limit, no audit row. Scoped on the recrawl cause's `vendor_id`
 * (`lib/vendor-history-follow-up.ts`), so a foreign id answers an empty list.
 */
export function createVendorHistoryFollowUpHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { ids } = VendorHistoryFollowUpQuerySchema.parse(searchParams(c));
    const { db } = dbFor(c.env);

    const body: ListVendorHistoryFollowUpResponse = {
      data: await loadVendorHistoryFollowUp(db, vendorId, ids),
    };
    validateResponseInDev(c.env, () => ListVendorHistoryFollowUpResponseSchema.parse(body));
    return json(body);
  };
}
