import { PAGE_VIEW_CF_HEADERS, PageViewPayloadSchema, type PageViewPayload } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Db } from '../db/client';
import { pageViews, products, vendors } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { noContent } from '../http';
import type { DbFactory } from '../lib/handler-utils';

/**
 * `POST /api/page-views` (AECI-177) — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 * Fire-and-forget page-view capture: validate the body, return 204 immediately,
 * insert one `page_views` row via `ctx.waitUntil()` (never blocks the response).
 * Enrichment (cf_*, hashed user agent, resolved product/vendor) is unchanged.
 * No audit row — `page_views` is a read-analytics log, not a domain state change.
 */

/** Structural view of a directly-present `request.cf` (local dev / direct test). */
interface CfLike {
  country?: string | null;
  colo?: string | null;
  asn?: number | null;
  botManagement?: { score?: number | null } | null;
}

type CfContext = {
  country: string | null;
  colo: string | null;
  asn: number | null;
  botScore: number | null;
};

const DEFAULT_LOCALE = 'en-US';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intOrNull(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function readCfContext(req: Request): CfContext {
  const h = req.headers;
  const cf = (req as { cf?: CfLike }).cf;
  const country = h.get(PAGE_VIEW_CF_HEADERS.country) ?? cf?.country ?? null;
  const colo = h.get(PAGE_VIEW_CF_HEADERS.colo) ?? cf?.colo ?? null;
  const asn = intOrNull(h.get(PAGE_VIEW_CF_HEADERS.asn)) ?? cf?.asn ?? null;
  const botScore =
    intOrNull(h.get(PAGE_VIEW_CF_HEADERS.botScore)) ?? cf?.botManagement?.score ?? null;
  return { country: country || null, colo: colo || null, asn, botScore };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function localeFromRoute(_route: string): string {
  return DEFAULT_LOCALE;
}

/** Map `(entity_type, entity_id)` onto product_id / vendor_id, confirming the row
 *  exists (cheap PK lookup) so a stale/spoofed id is stored as null. */
async function resolveEntity(
  db: Db,
  payload: PageViewPayload,
): Promise<{ productId: string | null; vendorId: string | null }> {
  const { entity_type: entityType, entity_id: entityId } = payload;
  if (!entityType || !entityId || !UUID_RE.test(entityId)) {
    return { productId: null, vendorId: null };
  }
  if (entityType === 'product') {
    const row = await db.query.products.findFirst({
      columns: { id: true },
      where: eq(products.id, entityId),
    });
    return { productId: row ? row.id : null, vendorId: null };
  }
  if (entityType === 'vendor') {
    const row = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, entityId),
    });
    return { productId: null, vendorId: row ? row.id : null };
  }
  return { productId: null, vendorId: null };
}

function botScoreSampledOut(env: Env, botScore: number | null): boolean {
  const floor = intOrNull(env.PAGE_VIEWS_MIN_BOT_SCORE ?? null);
  if (floor === null || botScore === null) return false;
  return botScore < floor;
}

/** Deferred capture. Never throws: failures emit `aeci.pageviews.write{outcome:failed}`
 *  + a Datadog warn and are swallowed so the returned 204 stands. */
async function capturePageView(
  c: Context<{ Bindings: Env }>,
  payload: PageViewPayload,
  dbFor: DbFactory,
): Promise<void> {
  const req = c.req.raw;
  try {
    const cf = readCfContext(req);
    if (botScoreSampledOut(c.env, cf.botScore)) return;

    const ua = req.headers.get('user-agent');
    const userAgentHash = ua ? await sha256Hex(ua) : null;

    // Fire-and-forget analytics (runs in `waitUntil`, never read back, returns
    // 204 regardless) — stays on the `'first-unconstrained'` read default; a
    // primary anchor would spend a round-trip for no benefit. (AECI-250)
    const { db } = dbFor(c.env);
    const { productId, vendorId } = await resolveEntity(db, payload);

    await db.insert(pageViews).values({
      path: payload.route,
      productId,
      vendorId,
      cfCountry: cf.country,
      cfColo: cf.colo,
      cfAsn: cf.asn,
      cfBotScore: cf.botScore,
      userAgentHash,
      locale: localeFromRoute(payload.route),
      // Campaign attribution (AECI-243 / §11.2) — set only on tagged arrivals
      // (e.g. the waitlist welcome banner); null for ordinary views.
      refSource: payload.ref_source ?? null,
      refToken: payload.ref_token ?? null,
    });
    submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.write', 1, ['outcome:ok']);
  } catch (error) {
    submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.write', 1, ['outcome:failed']);
    logToDatadog(c.executionCtx, c.env, req, {
      level: 'warn',
      message: 'aeci.api.page_view.capture_failed',
      source: 'page-views',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createPageViewsHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }

    // Validate synchronously (malformed → 400); a well-formed payload schedules
    // the deferred, non-blocking insert.
    const payload = PageViewPayloadSchema.parse(raw);
    c.executionCtx.waitUntil(capturePageView(c, payload, dbFor));

    return noContent();
  };
}
