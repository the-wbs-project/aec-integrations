import { PAGE_VIEW_CF_HEADERS, PageViewPayloadSchema, type PageViewPayload } from '@aeci/shared';
import type { Context } from 'hono';

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { noContent } from '../http';
import type { PrismaFactory } from '../lib/handler-utils';
import { getPrisma } from '../prisma';

/**
 * `POST /api/page-views` (AECI-55 hook, AECI-177 write) — fire-and-forget
 * server-side page-view capture, the data source for `home.trending_products`
 * (§14.2 / Phase 4.3).
 *
 * **Phase 4 wires the real insert.** The handler validates the body against
 * `PageViewPayloadSchema`, returns **204** immediately, and inserts one
 * `page_views` row via `ctx.waitUntil()` so the write never blocks the response
 * (§14.2 "writes asynchronously … never blocks"). The table + Prisma `PageView`
 * model already exist (baseline migration `20260515024116`) — no migration here.
 *
 * **Enrichment (§14.2 / DATABASE_SCHEMA §9.1):** `cf_country`, `cf_colo`,
 * `cf_asn`, `cf_bot_score` come from Cloudflare request context; `user_agent`
 * is SHA-256–hashed (NEVER stored raw); `locale` is the served locale; and
 * `product_id` / `vendor_id` are resolved from `(entity_type, entity_id)`.
 * Privacy is load-bearing: no raw IP and no raw user agent are ever persisted.
 *
 * **CF context forwarding:** the browser POST hits the SSR Worker first, and
 * `request.cf` does not survive the SSR→API service binding, so the SSR Worker
 * forwards the fields on trusted `PAGE_VIEW_CF_HEADERS` (`x-aeci-cf-*`). We read
 * those (falling back to a directly-present `request.cf` for local/test use).
 * See docs/API_CONTRACTS.md §6.9 for the contract.
 *
 * **No audit log:** §26.1 scopes `appendAuditLog()` to *state-changing* domain
 * writes (review/product/vendor/claim/…). `page_views` is a read-analytics log,
 * not a domain state change, so no audit row is required.
 *
 * Errors are thrown as `ApiError` (bad JSON → `MALFORMED_REQUEST`) / `ZodError`
 * (schema failure → `VALIDATION_FAILED`); the root `onError` (AECI-101) renders
 * them into the canonical §3.3 envelope. The deferred insert never throws to the
 * client — any failure is logged to Datadog (`warn`) and swallowed, and the
 * endpoint still returns 204.
 */

/**
 * Minimal structural slice of the generated Prisma client this handler touches —
 * typed structurally (like `routes/promote.ts`) so a real Accelerated client and
 * a test fake both satisfy it without dragging in the full generated types.
 */
type PageViewCaptureClient = {
  pageView: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  product: {
    findUnique(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<{ id: string } | null>;
  };
  vendor: {
    findUnique(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<{ id: string } | null>;
  };
};

/** Structural view of a directly-present `request.cf` (local dev / direct test).
 *  In production the values arrive on `PAGE_VIEW_CF_HEADERS` instead. */
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

// A v4-style UUID shape — the SSR resolvers attach `entity.id` (a UUID). Anything
// that isn't a UUID (e.g. a stray slug, or a spoofed client value) resolves to no
// product/vendor rather than tripping a uuid-column / FK error on insert.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intOrNull(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read Cloudflare request context. Primary source is the trusted
 * `PAGE_VIEW_CF_HEADERS` set by the SSR Worker; the direct `request.cf` fallback
 * only matters when the API Worker is exercised without the SSR proxy (local
 * `wrangler dev`, unit tests). No header-spoof vector exists: the SSR Worker
 * strips client-supplied copies before setting the trusted headers, and the API
 * Worker has no public ingress.
 */
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

/** SHA-256 hex digest via Web Crypto (global in Workers and Node 20+). */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Served locale for the page view. en-US only at launch (URL-prefix locale
 * dispatch ships no other prefixes yet), so this is constant today. When locales
 * are added, resolve from the route prefix mirroring `LOCALES` in
 * `apps/web/src/server-runtime.ts`.
 */
function localeFromRoute(_route: string): string {
  return DEFAULT_LOCALE;
}

/**
 * Map `(entity_type, entity_id)` onto the `product_id` / `vendor_id` foreign
 * keys. `entity_id` is the entity's own UUID; we confirm the row exists (a cheap
 * PK lookup) so a stale or spoofed id is stored as null rather than failing the
 * FK on insert. Only product/vendor pages carry an entity; integration/taxonomy
 * entity types and the browser tracker's route-only payloads resolve to null.
 */
async function resolveEntity(
  prisma: PageViewCaptureClient,
  payload: PageViewPayload,
): Promise<{ productId: string | null; vendorId: string | null }> {
  const { entity_type: entityType, entity_id: entityId } = payload;
  if (!entityType || !entityId || !UUID_RE.test(entityId)) {
    return { productId: null, vendorId: null };
  }
  if (entityType === 'product') {
    const row = await prisma.product.findUnique({ where: { id: entityId }, select: { id: true } });
    return { productId: row ? row.id : null, vendorId: null };
  }
  if (entityType === 'vendor') {
    const row = await prisma.vendor.findUnique({ where: { id: entityId }, select: { id: true } });
    return { productId: null, vendorId: row ? row.id : null };
  }
  return { productId: null, vendorId: null };
}

/**
 * Bot-score sampling knob (AECI-177 / §14.2). Returns true — i.e. drop this view
 * — only when `PAGE_VIEWS_MIN_BOT_SCORE` is set AND this view's score is below
 * it. Unset (the default everywhere) or an unscored request captures everything;
 * nothing is hardcoded to drop, per the deferred §14.2 policy.
 */
function botScoreSampledOut(env: Env, botScore: number | null): boolean {
  const floor = intOrNull(env.PAGE_VIEWS_MIN_BOT_SCORE ?? null);
  if (floor === null || botScore === null) return false;
  return botScore < floor;
}

/**
 * The deferred capture task. Enriches and inserts one `page_views` row. Never
 * throws: any failure is logged to Datadog (`warn`) and swallowed so the
 * already-returned 204 stands and the request path is never affected.
 *
 * Write-health signal (AECI-180 / 4.5): the insert emits `aeci.pageviews.write`
 * (`outcome:ok|failed`) so a silent insert regression is visible as an error
 * rate **before** it zeroes `home.trending_products` at the next daily compute.
 * The bot-score sampled-out early return emits nothing — it is an intentional
 * skip, not a write, and must not pollute the error-rate denominator.
 */
async function capturePageView(
  c: Context<{ Bindings: Env }>,
  payload: PageViewPayload,
  prismaFor: PrismaFactory,
): Promise<void> {
  const req = c.req.raw;
  try {
    const cf = readCfContext(req);
    if (botScoreSampledOut(c.env, cf.botScore)) return;

    const ua = req.headers.get('user-agent');
    const userAgentHash = ua ? await sha256Hex(ua) : null;

    const prisma = prismaFor(c.env) as unknown as PageViewCaptureClient;
    const { productId, vendorId } = await resolveEntity(prisma, payload);

    await prisma.pageView.create({
      data: {
        path: payload.route,
        productId,
        vendorId,
        cfCountry: cf.country,
        cfColo: cf.colo,
        cfAsn: cf.asn,
        cfBotScore: cf.botScore,
        userAgentHash,
        locale: localeFromRoute(payload.route),
        // userId + profileRole stay null until Phase 5 wires the authenticated
        // session here. No raw IP and no raw user agent are ever persisted
        // (§14.2 privacy); sessionId / referrer are out of scope for this issue.
      },
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
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }

    // Validate synchronously so a malformed body still surfaces 400 — only a
    // well-formed payload schedules the deferred, non-blocking insert.
    const payload = PageViewPayloadSchema.parse(raw);
    c.executionCtx.waitUntil(capturePageView(c, payload, prismaFor));

    return noContent();
  };
}
