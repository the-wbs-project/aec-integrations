import { PAGE_VIEW_CF_HEADERS, PageViewPayloadSchema, type PageViewPayload } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Db } from '../db/client';
import {
  pageViews,
  products,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import { classifyTraffic } from '../lib/bot-classification';
import { classifyClientSignals } from '../lib/client-signals';
import { classifyReferrer } from '../lib/referrer-classification';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { noContent } from '../http';
import type { DbFactory } from '../lib/handler-utils';
import { isOperatorRequest, type OperatorSessionOptions } from '../lib/operator-session';

/**
 * `POST /api/page-views` (AECI-177) — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 * Fire-and-forget page-view capture: validate the body, return 204 immediately,
 * insert one `page_views` row via `ctx.waitUntil()` (never blocks the response).
 * Enrichment (cf_*, hashed user agent, resolved entity) happens here.
 * No audit row — `page_views` is a read-analytics log, not a domain state change.
 *
 * AECI-585 (`ADMIN_PANEL_SPEC.md` §7.3) widened what a row records at write time,
 * which is the only time any of it is recoverable: the taxonomy term behind a facet
 * browse page, the concrete path beside the route pattern, whether the visit was an
 * arrival or an in-app hop, and the AS holder name beside the ASN. Rows written
 * before it carry null in all four and cannot be backfilled — nothing in the stored
 * row implies them.
 *
 * §13 D13 added a fifth, `is_operator`: whether the request carried a verified
 * admin session (`lib/operator-session.ts`). Same recoverable-only-at-write-time
 * property, same not-backfillable consequence for older rows.
 */

/** Structural view of a directly-present `request.cf` (local dev / direct test). */
interface CfLike {
  country?: string | null;
  colo?: string | null;
  asn?: number | null;
  asOrganization?: string | null;
  botManagement?: { score?: number | null } | null;
  /** AECI-658 — available on Pro, unlike the bot score. */
  tlsVersion?: string | null;
  httpProtocol?: string | null;
}

type CfContext = {
  country: string | null;
  colo: string | null;
  asn: number | null;
  asOrganization: string | null;
  botScore: number | null;
  tlsVersion: string | null;
  httpProtocol: string | null;
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
  // The AS holder NAME beside the number (AECI-585 / §13 D10). Read-side signal
  // only — it never feeds `classifyTraffic` below, because `DATACENTER_ASNS` writes
  // a permanent `is_bot` verdict and its membership doctrine is deliberately strict.
  const asOrganization = h.get(PAGE_VIEW_CF_HEADERS.asOrganization) ?? cf?.asOrganization ?? null;
  const botScore =
    intOrNull(h.get(PAGE_VIEW_CF_HEADERS.botScore)) ?? cf?.botManagement?.score ?? null;
  // AECI-658. Corroboration for `client_verdict`, never a fingerprint on their own.
  const tlsVersion = h.get(PAGE_VIEW_CF_HEADERS.tlsVersion) ?? cf?.tlsVersion ?? null;
  const httpProtocol = h.get(PAGE_VIEW_CF_HEADERS.httpProtocol) ?? cf?.httpProtocol ?? null;
  return {
    country: country || null,
    colo: colo || null,
    asn,
    asOrganization: asOrganization || null,
    botScore,
    tlsVersion: tlsVersion || null,
    httpProtocol: httpProtocol || null,
  };
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

/** The site's own hostnames — a `Referer` from any of these is same-origin in-app
 *  navigation, not an external traffic source. Derived from `PUBLIC_SITE_URL` plus the
 *  known apex + workers.dev preview suffix. */
function selfHosts(env: Env): string[] {
  const hosts = ['aecintegrations.com', 'aec-integrations.workers.dev'];
  try {
    if (env.PUBLIC_SITE_URL) hosts.push(new URL(env.PUBLIC_SITE_URL).hostname.toLowerCase());
  } catch {
    // Malformed PUBLIC_SITE_URL — fall back to the hardcoded self-hosts.
  }
  return hosts;
}

/**
 * The four taxonomy facets, mapped to the table that owns their terms. Same shape
 * as `lib/admin-catalog.ts`'s `facetUsage` map, and the same closed set the SSR
 * taxonomy resolver sends as `entity_type` — `trade` included, which is the fourth
 * facet (`TRADES_VOCABULARY.md` / §5.5a) and the one most easily forgotten.
 */
const TAXONOMY_TABLES = {
  category: taxonomyCategories,
  audience: taxonomyAudiences,
  phase: taxonomyPhases,
  trade: taxonomyTrades,
} as const;

type TaxonomyKind = keyof typeof TAXONOMY_TABLES;

function isTaxonomyKind(value: string): value is TaxonomyKind {
  return value in TAXONOMY_TABLES;
}

interface ResolvedEntity {
  productId: string | null;
  vendorId: string | null;
  taxonomyKind: string | null;
  taxonomyId: string | null;
}

const NO_ENTITY: ResolvedEntity = {
  productId: null,
  vendorId: null,
  taxonomyKind: null,
  taxonomyId: null,
};

/**
 * Map `(entity_type, entity_id)` onto the row's entity columns, confirming the
 * referenced row exists (cheap PK lookup) so a stale/spoofed id is stored as null.
 *
 * Products and vendors land in their FK columns. The four taxonomy facets land in
 * `taxonomy_kind` + `taxonomy_id` (AECI-585 / §7.3) — the SSR resolvers have always
 * sent them and this function used to drop them on the floor, which is why ~600
 * taxonomy rows can say a facet page was viewed but not which term. Those two
 * columns carry no FK (SQLite cannot point one column at four tables), so the
 * existence check below IS the integrity guarantee, exactly as it is for the
 * product and vendor branches.
 */
async function resolveEntity(db: Db, payload: PageViewPayload): Promise<ResolvedEntity> {
  const { entity_type: entityType, entity_id: entityId } = payload;
  if (!entityType || !entityId || !UUID_RE.test(entityId)) {
    return NO_ENTITY;
  }
  if (entityType === 'product') {
    const row = await db.query.products.findFirst({
      columns: { id: true },
      where: eq(products.id, entityId),
    });
    return { ...NO_ENTITY, productId: row ? row.id : null };
  }
  if (entityType === 'vendor') {
    const row = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, entityId),
    });
    return { ...NO_ENTITY, vendorId: row ? row.id : null };
  }
  if (isTaxonomyKind(entityType)) {
    const table = TAXONOMY_TABLES[entityType];
    const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, entityId));
    // `taxonomy_kind` is stored only alongside a CONFIRMED id. A kind with a dangling
    // id would read as "some category was viewed" and quietly inflate every per-facet
    // count with rows that can never be attributed to a term.
    return row ? { ...NO_ENTITY, taxonomyKind: entityType, taxonomyId: row.id } : NO_ENTITY;
  }
  return NO_ENTITY;
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
  deps: PageViewsDeps,
): Promise<void> {
  const req = c.req.raw;
  try {
    const cf = readCfContext(req);
    if (botScoreSampledOut(c.env, cf.botScore)) return;

    const ua = req.headers.get('user-agent');
    const userAgentHash = ua ? await sha256Hex(ua) : null;
    // Classify human vs. bot NOW, while the raw UA is still available (only its hash
    // is persisted). ASN unmasks headless scrapers that spoof a browser UA. AECI-526.
    const { isBot, botName } = classifyTraffic(ua, cf.asn);
    // Traffic source from the forwarded eyeball `Referer` (SSR `firePageView`). Store
    // the host only (privacy) + a coarse source label the digest groups on. AECI-526.
    const { source: referrerSource, host: referrerHost } = classifyReferrer(
      req.headers.get('referer'),
      selfHosts(c.env),
    );
    // How browser-shaped this request was (AECI-658). Computed here for the same
    // reason the two classifications above are: the headers are gone afterwards.
    // ANNOTATION ONLY — deliberately not passed to `classifyTraffic` and it must
    // never change `isBot` above. Navigation-aware, so the tracker's same-origin
    // fetch is not judged by document-arrival rules it fails by construction.
    const clientSignals = classifyClientSignals(req.headers, ua, payload.navigation ?? null, cf);

    // Fire-and-forget analytics (runs in `waitUntil`, never read back, returns
    // 204 regardless) — stays on the `'first-unconstrained'` read default; a
    // primary anchor would spend a round-trip for no benefit. (AECI-250)
    const { db } = dbFor(c.env);
    // Both reads are independent, so they overlap rather than queue. The operator
    // check short-circuits to `false` with no I/O when the request is anonymous,
    // which is nearly all of them.
    const [{ productId, vendorId, taxonomyKind, taxonomyId }, isOperator] = await Promise.all([
      resolveEntity(db, payload),
      isOperatorRequest(c, db, deps),
    ]);

    await db.insert(pageViews).values({
      path: payload.route,
      // The concrete URL path, falling back to `route` (AECI-585 / §7.3). Only a
      // writer that sends a route PATTERN owes an explicit `path`; for the browser
      // tracker and the SSR cache-HIT synthesis, `route` already IS the concrete
      // path, so the fallback is the right answer rather than a degraded one.
      concretePath: payload.path ?? payload.route,
      productId,
      vendorId,
      taxonomyKind,
      taxonomyId,
      // Never inferred — an omitted flag stays null rather than being guessed into
      // the bucket this column exists to disambiguate.
      navigation: payload.navigation ?? null,
      cfCountry: cf.country,
      cfColo: cf.colo,
      cfAsn: cf.asn,
      cfAsOrganization: cf.asOrganization,
      cfBotScore: cf.botScore,
      userAgentHash,
      locale: localeFromRoute(payload.route),
      isBot,
      botName,
      // The operator checking their own work (§13 D13). Recorded rather than
      // dropped: the row stays available to any query that wants it, exactly as
      // the §9.6 path rows did, and the read side excludes it.
      isOperator,
      referrer: referrerHost,
      referrerSource,
      // Request-shape annotation (AECI-658). Never read by the bot classifier.
      secFetchDest: clientSignals.secFetchDest,
      hasAcceptLanguage: clientSignals.hasAcceptLanguage,
      hasSecChUa: clientSignals.hasSecChUa,
      tlsVersion: clientSignals.tlsVersion,
      httpProtocol: clientSignals.httpProtocol,
      clientVerdict: clientSignals.verdict,
      // Campaign attribution (AECI-243 / §11.2) — set only on tagged arrivals
      // (e.g. the waitlist welcome banner); null for ordinary views.
      refSource: payload.ref_source ?? null,
      refToken: payload.ref_token ?? null,
    });
    submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.write', 1, [
      'outcome:ok',
      `bot:${isBot}`,
    ]);
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

/** Injectable seams. `getKey` is the offline-JWKS hook `isOperatorRequest` needs
 *  so specs can mint a verifiable admin session without a network round trip. */
export type PageViewsDeps = OperatorSessionOptions;

export function createPageViewsHandler(
  dbFor: DbFactory = getDb,
  deps: PageViewsDeps = {},
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
    c.executionCtx.waitUntil(capturePageView(c, payload, dbFor, deps));

    return noContent();
  };
}
