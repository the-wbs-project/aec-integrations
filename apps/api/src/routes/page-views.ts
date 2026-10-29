import {
  PAGE_VIEW_CF_HEADERS,
  PAGE_VIEW_DEDUPE_WINDOW_MS,
  PAGE_VIEW_RAW_HEADERS,
  PAGE_VIEW_WRITERS,
  PageViewPayloadSchema,
  TurnstileVerdictPostSchema,
  buildRawEnvelope,
  canonicalPairIds,
  emptyRawPageViewDerived,
  hasPrivacySignal,
  parseLandingPath,
  parsePairPagePath,
  type LandingEntity,
  type PageViewPayload,
  type PairPageSlugs,
  type RawPageViewDerived,
  type RawPageViewOutcome,
  type TurnstileVerdict,
  type TurnstileVerdictPost,
} from '@aeci/shared';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
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
import { logToPosthog, submitCount } from '../posthog';
import { classifyTraffic } from '../lib/bot-classification';
import { monthlyIpHash, sha256Hex } from '../lib/hash';
import { writeRawEnvelope, type IpHashState } from '../lib/page-view-raw';
import { classifyClientSignals } from '../lib/client-signals';
import { classifyReferrer } from '../lib/referrer-classification';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { noContent } from '../http';
import type { DbFactory } from '../lib/handler-utils';
import { resolveVisitorSession, type OperatorSessionOptions } from '../lib/operator-session';
import { resolveOwnerVisit } from '../lib/owner-visit';
import { verifyTurnstile } from '../lib/turnstile';

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
 *
 * AECI-929 (§13 D25) added the two endpoint products of an integration pair page,
 * `pair_product_a_id` / `pair_product_b_id`. Unlike the columns above they ARE
 * recoverable later, from `concrete_path`, which is why they are derived here from
 * the path rather than sent by the writer, and why a one-time backfill exists
 * (`scripts/ops/2026-10-pair-page-view-backfill/`).
 *
 * AECI-1386 added `privacy_signal`. A request with `Sec-GPC: 1` or `DNT: 1` becomes
 * an anonymous counter row: see `PRIVACY_NULLED` below for what it never stores,
 * and `capturePageView` for why it writes no raw envelope.
 *
 * AECI-1457 added `turnstile_verdict`, Cloudflare Turnstile's per-view answer, as
 * classifier evidence. An in-app (`browser-spa`) beacon carries the token and is
 * verified before its insert (`verifySpaTurnstile`). A landing view's row is
 * written by the SSR gateway, which has no token, so the browser posts it later to
 * `POST /api/page-views/turnstile` (`createTurnstileVerdictHandler`).
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
  ray: string | null;
  verifiedBot: boolean | null;
  verifiedBotCategory: string | null;
};

const DEFAULT_LOCALE = 'en-US';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intOrNull(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/** A Cloudflare Ray ID: 16 hex digits, optionally `-COLO` (AECI-1301). */
const CF_RAY_RE = /^[0-9a-f]{16}(-[A-Z]{3,4})?$/i;
const VERIFIED_BOT_CATEGORY_MAX = 64;

function rayOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return CF_RAY_RE.test(trimmed) ? trimmed : null;
}

function verifiedBotOrNull(value: string | null): boolean | null {
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

function verifiedBotCategoryOrNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '' || trimmed.length > VERIFIED_BOT_CATEGORY_MAX) return null;
  return trimmed;
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
  // AECI-1301. Header ONLY, unlike every field above. Their `request.cf` fallback
  // exists for local runs, where the API is hit directly. Here a fallback would be
  // wrong in production: this Worker's own `cf-ray` and `request.cf` describe the
  // service-binding hop from the SSR Worker, not the visitor. Reading the hop
  // instead of the visitor is one suspected cause of AECI-1298 (the constant
  // stored bot score), so these fields must not copy that pattern.
  const ray = rayOrNull(h.get(PAGE_VIEW_CF_HEADERS.ray));
  const verifiedBot = verifiedBotOrNull(h.get(PAGE_VIEW_CF_HEADERS.verifiedBot));
  const verifiedBotCategory = verifiedBotCategoryOrNull(
    h.get(PAGE_VIEW_CF_HEADERS.verifiedBotCategory),
  );
  return {
    country: country || null,
    colo: colo || null,
    asn,
    asOrganization: asOrganization || null,
    botScore,
    tlsVersion: tlsVersion || null,
    httpProtocol: httpProtocol || null,
    ray,
    verifiedBot,
    verifiedBotCategory,
  };
}

function localeFromRoute(_route: string): string {
  return DEFAULT_LOCALE;
}

/** The site's own hostnames — a `Referer` from any of these is same-origin in-app
 *  navigation, not an external traffic source. Derived from `PUBLIC_SITE_URL` plus the
 *  known apex + workers.dev preview suffix. */
function selfHosts(env: Env): string[] {
  const hosts = ['aecintegrations.com', 'thewbsproject.workers.dev'];
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
 * The row's entity columns. An explicit `entity_type` in the body wins; an arrival
 * without one is resolved from its concrete path (AECI-1297, `resolveEntityBySlug`).
 *
 * `resolveEntityById` maps `(entity_type, entity_id)` onto the row's entity columns, confirming the
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
  if (payload.entity_type) return resolveEntityById(db, payload);
  // AECI-1297 — the gateway writes every arrival, on an edge-cache HIT too, where
  // no resolver ran to name the entity. It sends `{ route, path }` only, so the
  // entity comes from the concrete path. Arrivals only: a `browser-spa` row has
  // always been attributed by `route` alone, and this keeps it that way.
  if (payload.navigation === 'arrival' && payload.path) {
    return resolveEntityBySlug(db, parseLandingPath(payload.path).entity);
  }
  return NO_ENTITY;
}

async function resolveEntityById(db: Db, payload: PageViewPayload): Promise<ResolvedEntity> {
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

/**
 * The entity a landing path names, by one slug lookup (AECI-1297). Same storage rule
 * as `resolveEntityById`: an unknown slug stores null ids and the row is still
 * written. No `slug_redirects` lookup, for the reason `resolvePairProducts` gives:
 * a retired slug 301s before the page renders, and the gateway never writes a 301.
 * A pair page resolves through `resolvePairProducts`, not here.
 */
async function resolveEntityBySlug(db: Db, entity: LandingEntity | null): Promise<ResolvedEntity> {
  if (!entity || entity.type === 'pair') return NO_ENTITY;
  const { type, slug } = entity;
  if (type === 'product') {
    const row = await db.query.products.findFirst({
      columns: { id: true },
      where: eq(products.slug, slug),
    });
    return { ...NO_ENTITY, productId: row ? row.id : null };
  }
  if (type === 'vendor') {
    const row = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.slug, slug),
    });
    return { ...NO_ENTITY, vendorId: row ? row.id : null };
  }
  const table = TAXONOMY_TABLES[type];
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.slug, slug)).limit(1);
  return row ? { ...NO_ENTITY, taxonomyKind: type, taxonomyId: row.id } : NO_ENTITY;
}

const NO_PAIR: [string | null, string | null] = [null, null];

/**
 * The two endpoint product ids of a pair-page view, in canonical order (AECI-929 /
 * §13 D25), or `[null, null]` when the path is not a pair page.
 *
 * Derived from the concrete path rather than from the payload, so the SSR arrival,
 * the browser tracker's SPA hop (which sends only `{ route, navigation }`) and a
 * crawler's fetch all attribute the same way without any writer changing. One
 * `slug IN (a, b)` read, the same existence-check rule `resolveEntity` applies: an
 * unknown slug stores NULL on that side, never a guess, and the row is still
 * written.
 *
 * Looked up by `products.slug` only, not `slug_redirects`: a retired slug 301s to
 * the current URL before the page renders, so the view that counts is recorded
 * under the slug that resolves.
 */
async function resolvePairProducts(
  db: Db,
  pair: PairPageSlugs | null,
): Promise<[string | null, string | null]> {
  if (!pair) return NO_PAIR;
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.slug, [pair.a, pair.b]));
  const idFor = (slug: string): string | null => rows.find((r) => r.slug === slug)?.id ?? null;
  return canonicalPairIds(idFor(pair.a), idFor(pair.b));
}

function botScoreSampledOut(env: Env, botScore: number | null): boolean {
  const floor = intOrNull(env.PAGE_VIEWS_MIN_BOT_SCORE ?? null);
  if (floor === null || botScore === null) return false;
  return botScore < floor;
}

/**
 * The de-duplication keys for one view: the current time bucket and the one before
 * it (AECI-743).
 *
 * The key is `sha256(concrete_path | user_agent_hash | cf_asn | bucket)`, where
 * `bucket` is `now / PAGE_VIEW_DEDUPE_WINDOW_MS` floored. Hashed rather than stored
 * as a readable tuple for the same privacy reason the raw UA never lands in this
 * table: the column is a constraint handle, not a lookup key, and nothing reads it
 * back to identify anyone.
 *
 * Returns `null` when the row must not participate in de-duplication at all:
 *
 * - **Bot-classified rows.** Crawler volume is a raw count that the digest's
 *   `== Crawler activity ==` table and the bot backfill audits both read literally;
 *   silently collapsing a crawler's repeat fetches would rewrite that series to
 *   mean something else. A null key indexes as DISTINCT, so those rows are simply
 *   never constrained.
 * - **Rows with no `user_agent_hash`.** Without it the key degenerates to
 *   path + ASN, which two genuinely different visitors behind one network share.
 *   An unidentifiable row is not evidence of a duplicate — the same NULL-safety
 *   reasoning `NOT_INTERNAL`'s `not exists` clause is built on.
 *
 * The PREVIOUS bucket is returned alongside the current one so a pair straddling a
 * bucket boundary still collapses on the read probe; only the current bucket's key
 * is ever WRITTEN, since a row can occupy one bucket.
 */
async function dedupeKeys(input: {
  concretePath: string;
  userAgentHash: string | null;
  cfAsn: number | null;
  isBot: boolean;
  now: number;
}): Promise<{ current: string; previous: string } | null> {
  if (input.isBot || !input.userAgentHash) return null;
  const bucket = Math.floor(input.now / PAGE_VIEW_DEDUPE_WINDOW_MS);
  const build = (b: number): Promise<string> =>
    sha256Hex([input.concretePath, input.userAgentHash, input.cfAsn ?? '', b].join('|'));
  const [current, previous] = await Promise.all([build(bucket), build(bucket - 1)]);
  return { current, previous };
}

/**
 * Whether a row for this view was already written inside the de-duplication window.
 *
 * Probes BOTH bucket keys in one seek on `page_views_dedupe_key_idx`, so the
 * effective window is 10–20 s and a pair straddling a bucket boundary still
 * collapses. `null` keys (bots, no UA hash) short-circuit with no query at all.
 *
 * This probe exists for the metric, not for correctness — the UNIQUE index is what
 * actually guarantees one row. Treat a failure here as "no duplicate": a probe that
 * throws must not stop a genuine view from being recorded, and the constraint still
 * has the last word.
 */
async function findDuplicate(
  db: Db,
  keys: { current: string; previous: string } | null,
): Promise<boolean> {
  if (!keys) return false;
  const rows = await db
    .select({ id: pageViews.id })
    .from(pageViews)
    .where(inArray(pageViews.dedupeKey, [keys.current, keys.previous]))
    .limit(1);
  return rows.length > 0;
}

const HOUR_MS = 3_600_000;

/**
 * The `created_at` of a privacy-signal row: now, cut down to the start of the UTC
 * hour (AECI-1386). Same ISO-8601 text shape `createdAt()` in the schema writes, so
 * every `created_at` range read treats the row the same way. Minute-level time is
 * one of the facts that would let a counter row be matched to a person.
 */
export function privacyCreatedAt(now: number): string {
  return new Date(Math.floor(now / HOUR_MS) * HOUR_MS).toISOString();
}

/**
 * The columns a privacy-signal row always stores as NULL (AECI-1386). The verdicts
 * computed from them still run in memory, so the row keeps `is_bot`,
 * `referrer_source`, `client_verdict` and the rest. What goes is every raw input
 * that could tie the row to a browser, a network or a link: the UA hash (never
 * computed), ASN and holder name, colo, Ray ID, referrer host, link token, the
 * request-shape facts and the dedupe key. Spread last into the insert so no field
 * above it can win.
 */
const PRIVACY_NULLED = {
  userAgentHash: null,
  cfAsn: null,
  cfAsOrganization: null,
  cfColo: null,
  cfRay: null,
  referrer: null,
  refToken: null,
  secFetchDest: null,
  hasAcceptLanguage: null,
  hasSecChUa: null,
  tlsVersion: null,
  httpProtocol: null,
  dedupeKey: null,
  // AECI-1457. The browser loads no Turnstile script for a privacy request, so
  // there is no token. Listed anyway so no path can ever store a verdict here.
  turnstileVerdict: null,
} as const;

/** The count every Turnstile verdict emits (AECI-1457). Only when the secret is set. */
const TURNSTILE_METRIC = 'aeci.pageviews.turnstile';

/**
 * The visitor's IP for siteverify's optional `remoteip`. On the proxy path the SSR
 * Worker copies it onto `PAGE_VIEW_RAW_HEADERS.clientIp`; `cf-connecting-ip` also
 * crosses the service binding and is the fallback.
 */
function visitorIp(req: Request): string | null {
  return (
    req.headers.get(PAGE_VIEW_RAW_HEADERS.clientIp)?.trim() ||
    req.headers.get('cf-connecting-ip')?.trim() ||
    null
  );
}

/**
 * Siteverify for an in-app beacon (AECI-1457), run before the insert. Returns the
 * verdict to store, or null when no check applies:
 *
 * - not a `browser-spa` write: a token on an `ssr-arrival` write is ignored, since
 *   that writer never carries one and a landing view's verdict arrives by UPDATE;
 * - a privacy-signal request;
 * - no secret on this tier (`verifyTurnstile` makes no fetch).
 *
 * Emits `aeci.pageviews.turnstile{writer:spa}` only when the secret is set, which
 * is every deployed tier (CI-pushed, deploy-required). `verdict:absent` is a
 * `browser-spa` write with no token: an old client, the widget timing out, a client
 * that never ran the widget, or a tier with no `TURNSTILE_SITE_KEY` (production
 * until AECI-1458), where every in-app beacon counts as `absent`. Never throws (`verifyTurnstile` maps
 * every failure to `unknown`), so a verify failure can never cost the row.
 */
async function verifySpaTurnstile(
  c: Context<{ Bindings: Env }>,
  payload: PageViewPayload,
  writer: string | null,
  privacy: boolean,
): Promise<TurnstileVerdict | null> {
  if (writer !== PAGE_VIEW_WRITERS.browserSpa || privacy || !c.env.TURNSTILE_SECRET_KEY) {
    return null;
  }
  const req = c.req.raw;
  const verdict = payload.turnstile_token
    ? await verifyTurnstile(c.env, payload.turnstile_token, { remoteIp: visitorIp(req) })
    : null;
  submitCount(c.executionCtx, c.env, req, TURNSTILE_METRIC, 1, [
    `verdict:${verdict ?? 'absent'}`,
    'writer:spa',
  ]);
  return verdict;
}

/** What the D1 half of a capture ended as, for the raw envelope (AECI-1384). */
type RecordResult = { outcome: RawPageViewOutcome; pageViewId: number | null };

/**
 * The D1 half of a capture. Throws on failure; `capturePageView` owns the catch.
 * Fills `derived` as each value is computed, so a capture that stops early or
 * throws still hands the raw envelope whatever it had (AECI-1384).
 */
async function recordPageView(
  c: Context<{ Bindings: Env }>,
  payload: PageViewPayload,
  dbFor: DbFactory,
  deps: PageViewsDeps,
  derived: RawPageViewDerived,
  privacy: boolean,
): Promise<RecordResult> {
  const req = c.req.raw;
  const cf = readCfContext(req);
  derived.locale = localeFromRoute(payload.route);
  // Counted only by the raw store's `outcome` today; the D1 write metric has
  // never carried a sampled-out tag, and its ratio alert depends on that.
  if (botScoreSampledOut(c.env, cf.botScore)) return { outcome: 'sampled_out', pageViewId: null };

  const ua = req.headers.get('user-agent');
  // A privacy-signal row never computes the hash (AECI-1386). With no hash,
  // `dedupeKeys` below returns null, so the row also takes no dedupe key.
  const userAgentHash = ua && !privacy ? await sha256Hex(ua) : null;
  // Classify human vs. bot NOW, while the raw UA is still available (only its hash
  // is persisted). ASN unmasks headless scrapers that spoof a browser UA. AECI-526.
  const { isBot, botName } = classifyTraffic(ua, cf.asn);
  derived.user_agent_hash = userAgentHash;
  derived.is_bot = isBot;
  derived.bot_name = botName;
  // Traffic source from the forwarded eyeball `Referer` (the SSR gateway's
  // `firePageView`). Store the host only (privacy) + a coarse source label the
  // digest groups on. AECI-526.
  const { source: referrerSource, host: referrerHost } = classifyReferrer(
    req.headers.get('referer'),
    selfHosts(c.env),
  );
  // How browser-shaped this request was (AECI-658). Computed here for the same
  // reason the two classifications above are: the headers are gone afterwards.
  // ANNOTATION ONLY — deliberately not passed to `classifyTraffic` and it must
  // never change `isBot` above. Writer-aware, so the tracker's same-origin fetch
  // is not judged by document-arrival rules it fails by construction — and since
  // AECI-871 that writer comes from the SSR Worker's trusted provenance header,
  // not from `payload.navigation`, which is passed only so a body claiming an
  // in-app hop that no header corroborates can be declined (`unknown`).
  const clientSignals = classifyClientSignals(req.headers, ua, payload.navigation ?? null, cf);
  derived.referrer_source = referrerSource;
  derived.referrer_host = referrerHost;
  derived.client_signals = { ...clientSignals };

  // AECI-743 — the one-arrival-one-row key. Computed here because it needs the
  // UA hash and the bot verdict, both of which exist only at ingest.
  const concretePath = payload.path ?? payload.route;
  const keys = await dedupeKeys({
    concretePath,
    userAgentHash,
    cfAsn: cf.asn,
    isBot,
    now: Date.now(),
  });
  derived.dedupe_keys = keys;

  // Fire-and-forget analytics (runs in `waitUntil`, never read back, returns
  // 204 regardless) — stays on the `'first-unconstrained'` read default; a
  // primary anchor would spend a round-trip for no benefit. (AECI-250)
  const { db } = dbFor(c.env);
  // All four reads are independent, so they overlap rather than queue. The
  // session check short-circuits with no I/O when the request is
  // anonymous, which is nearly all of them, and the duplicate probe is a seek on
  // `page_views_dedupe_key_idx` that costs nothing when the key is null. The pair
  // lookup (AECI-929) likewise does no I/O unless the path is a pair page.
  const [
    { productId, vendorId, taxonomyKind, taxonomyId },
    { isOperator, ownerVendorId },
    duplicate,
    [pairProductAId, pairProductBId],
  ] = await Promise.all([
    resolveEntity(db, payload),
    resolveVisitorSession(c, db, deps),
    findDuplicate(db, keys),
    resolvePairProducts(db, parsePairPagePath(concretePath)),
  ]);

  Object.assign(derived, {
    product_id: productId,
    vendor_id: vendorId,
    taxonomy_kind: taxonomyKind,
    taxonomy_id: taxonomyId,
    is_operator: isOperator,
    owner_vendor_id: ownerVendorId,
    pair_product_a_id: pairProductAId,
    pair_product_b_id: pairProductBId,
  });

  // Suppression is COUNTED, never silent: a metric that quietly drops rows is
  // indistinguishable from an ingest outage, and the whole point of this issue is
  // that an unobserved miscount survived into the digest's most trusted figure.
  if (duplicate) {
    submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.write', 1, ['outcome:deduped']);
    return { outcome: 'deduped', pageViewId: null };
  }

  // A vendor viewing its own listing (AECI-934 / §13 D26). Needs the resolved
  // entity and pair ids, so it runs after the batch above. No I/O unless the
  // session is a verified vendor_admin's.
  //
  // The Turnstile check (AECI-1457) overlaps it. It runs here, after the sample
  // and dedupe exits, so a capture that writes no row spends no siteverify call.
  const [isOwnerVisit, turnstileVerdict] = await Promise.all([
    resolveOwnerVisit(db, ownerVendorId, {
      productId,
      vendorId,
      pairProductAId,
      pairProductBId,
      concretePath,
    }),
    verifySpaTurnstile(c, payload, clientSignals.writerProvenance, privacy),
  ]);
  derived.is_owner_visit = isOwnerVisit;
  derived.turnstile_verdict = turnstileVerdict;

  const inserted = await db
    .insert(pageViews)
    .values({
      path: payload.route,
      // The concrete URL path, falling back to `route` (AECI-585 / §7.3). Only a
      // writer that sends a route PATTERN owes an explicit `path`; for the browser
      // tracker and a gateway arrival on a non-detail page, `route` already IS the
      // concrete path, so the fallback is the right answer rather than a degraded one.
      concretePath,
      productId,
      vendorId,
      // AECI-929 — both endpoints of a pair page, lower id first. Bot rows take
      // this same insert, so a crawler's fetch of a pair page is attributed too.
      pairProductAId,
      pairProductBId,
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
      cfRay: cf.ray,
      cfVerifiedBot: cf.verifiedBot,
      cfVerifiedBotCategory: cf.verifiedBotCategory,
      userAgentHash,
      locale: localeFromRoute(payload.route),
      isBot,
      botName,
      // The operator checking their own work (§13 D13). Recorded rather than
      // dropped: the row stays available to any query that wants it, exactly as
      // the §9.6 path rows did, and the read side excludes it.
      isOperator,
      // A vendor admin checking its own listing (§13 D26). Recorded, never
      // dropped, for the same reason; `NOT_OWNER_VISIT` excludes it on read.
      isOwnerVisit,
      referrer: referrerHost,
      referrerSource,
      // Request-shape annotation (AECI-658). Never read by the bot classifier.
      secFetchDest: clientSignals.secFetchDest,
      hasAcceptLanguage: clientSignals.hasAcceptLanguage,
      hasSecChUa: clientSignals.hasSecChUa,
      tlsVersion: clientSignals.tlsVersion,
      httpProtocol: clientSignals.httpProtocol,
      clientVerdict: clientSignals.verdict,
      // Which of our writers originated this row (AECI-871 / §13 D18). Taken
      // from `clientSignals`, which read it off the TRUSTED
      // `PAGE_VIEW_WRITER_HEADER` — never from `payload.navigation`, which is a
      // client-controlled claim and, until this issue, was enough on its own to
      // earn a `browser` verdict.
      writerProvenance: clientSignals.writerProvenance,
      // AECI-1457. Set only on a `browser-spa` write that carried a token on a
      // tier with the secret. A landing row gets its verdict later, by UPDATE.
      turnstileVerdict,
      // Campaign attribution (AECI-243 / §11.2) — set only on tagged arrivals
      // (e.g. the waitlist welcome banner); null for ordinary views.
      refSource: payload.ref_source ?? null,
      refToken: payload.ref_token ?? null,
      // AECI-743. Null for bots and for rows with no UA hash — see `dedupeKeys`.
      dedupeKey: keys?.current ?? null,
      // AECI-1386. Always true or false on a new row; NULL only on history.
      privacySignal: privacy,
      ...(privacy ? { ...PRIVACY_NULLED, createdAt: privacyCreatedAt(Date.now()) } : {}),
    })
    // The race-proof half of the guard. The probe above catches the ordinary
    // duplicate (and is what makes the suppression measurable), but the failure
    // this issue is named for was 83 ms apart with both inserts in flight from
    // `waitUntil` — the second SELECT can run before the first INSERT commits, and
    // only the UNIQUE index settles that. D1 reports no usable `meta.changes` on a
    // conflict (AECI-581), which is why the metric hangs off the probe rather than
    // off this result.
    .onConflictDoNothing({ target: pageViews.dedupeKey })
    // The raw envelope's join key (AECI-1384). An empty result is the conflict
    // case: RETURNING yields no row when DO NOTHING fires, which is the signal
    // `meta.changes` could not give. The write metric below stays on `ok` for
    // both, exactly as before, so its existing ratio alert keeps its meaning.
    .returning({ id: pageViews.id });
  submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.write', 1, [
    'outcome:ok',
    `bot:${isBot}`,
    `privacy:${privacy}`,
  ]);
  const pageViewId = inserted[0]?.id ?? null;
  return pageViewId === null
    ? { outcome: 'conflict', pageViewId: null }
    : { outcome: 'inserted', pageViewId };
}

/**
 * Deferred capture. Never throws: a D1 failure emits
 * `aeci.pageviews.write{outcome:failed}` + an observability warn and is swallowed
 * so the returned 204 stands.
 *
 * Every capture that reaches here then writes exactly one raw envelope
 * (AECI-1384, ADR 0041), whatever the D1 outcome. The raw write runs after the D1
 * outcome is known and in its own `try`, so it can neither change that outcome nor
 * throw out of `waitUntil`.
 *
 * The one exception is a request with a privacy signal (AECI-1386). It writes no
 * envelope on any outcome, `failed` and `sampled_out` included. The envelope holds
 * the full header set and a monthly IP hash, which is exactly what the visitor
 * asked us not to keep. It emits `aeci.pageviews.raw{outcome:privacy_signal}`
 * instead, so the gap in the R2 backup is counted. Never `skipped`: that tag means
 * a missing binding and fires `pageviews-raw-unsent`.
 */
async function capturePageView(
  c: Context<{ Bindings: Env }>,
  payload: PageViewPayload,
  dbFor: DbFactory,
  deps: PageViewsDeps,
): Promise<void> {
  const req = c.req.raw;
  const capturedAt = new Date();
  const derived = emptyRawPageViewDerived();
  // Decided first, before anything can sample the capture out or throw, so no
  // path below can reach the envelope for a privacy request.
  const privacy = hasPrivacySignal(req.headers);
  let result: RecordResult;
  let outcomeDetail: string | null = null;
  try {
    result = await recordPageView(c, payload, dbFor, deps, derived, privacy);
  } catch (error) {
    outcomeDetail = error instanceof Error ? error.message : String(error);
    result = { outcome: 'failed', pageViewId: null };
    submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.write', 1, ['outcome:failed']);
    logToPosthog(c.executionCtx, c.env, req, {
      level: 'warn',
      message: 'aeci.api.page_view.capture_failed',
      source: 'page-views',
      reason: outcomeDetail,
    });
  }

  if (privacy) {
    submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.raw', 1, ['outcome:privacy_signal']);
    return;
  }

  try {
    const secret = c.env.PAGE_VIEW_IP_HASH_SECRET;
    const ip = req.headers.get(PAGE_VIEW_RAW_HEADERS.clientIp)?.trim() || null;
    const ipHash = await monthlyIpHash(secret, ip, capturedAt);
    const ipHashState: IpHashState = !secret ? 'no_secret' : ip ? 'present' : 'no_ip';
    const envelope = buildRawEnvelope({
      capturedAt,
      env: c.env.ENV ?? null,
      pageViewId: result.pageViewId,
      outcome: result.outcome,
      outcomeDetail,
      body: payload,
      headers: req.headers,
      ipHash,
      derived,
    });
    await writeRawEnvelope(c.executionCtx, c.env, req, envelope, ipHashState);
  } catch (error) {
    submitCount(c.executionCtx, c.env, req, 'aeci.pageviews.raw', 1, ['outcome:failed']);
    logToPosthog(c.executionCtx, c.env, req, {
      level: 'warn',
      message: 'aeci.api.page_view.raw_failed',
      source: 'page-views',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Injectable seams. `getKey` is the offline-JWKS hook `resolveVisitorSession` needs
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

/** How far back the landing verdict looks for its arrival row (AECI-1457). */
export const TURNSTILE_VERDICT_WINDOW_MS = 10 * 60_000;

/** Wait before the one retry, for an arrival write still in flight. */
export const TURNSTILE_VERDICT_RETRY_MS = 2_000;

/** Injectable seams for the landing verdict handler. `wait` lets specs skip the 2 s. */
export type TurnstileVerdictDeps = { wait?: (ms: number) => Promise<void> };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Store a landing view's verdict on its arrival row. One UPDATE, matched on the
 * page load's `cf_ray`, and narrowed so it can only ever touch the row it means:
 *
 * - `writer_provenance = 'ssr-arrival'`: an in-app row got its own verdict at insert;
 * - `turnstile_verdict IS NULL`: first verdict wins, a replayed post changes nothing;
 * - `privacy_signal = 0`: a privacy row is never written to. It also stores no
 *   `cf_ray`, so this is belt and braces;
 * - `created_at` inside the last 10 minutes, which bounds the scan on
 *   `page_views_created_at_idx`. `cf_ray` has no index of its own, by design.
 *
 * Returns the number of rows changed, counted through `RETURNING` (D1 gives no
 * usable `meta.changes` here, AECI-581).
 */
async function updateArrivalVerdict(
  db: Db,
  cfRay: string,
  verdict: TurnstileVerdict,
  now: number,
): Promise<number> {
  const rows = await db
    .update(pageViews)
    .set({ turnstileVerdict: verdict })
    .where(
      and(
        eq(pageViews.cfRay, cfRay),
        eq(pageViews.writerProvenance, PAGE_VIEW_WRITERS.ssrArrival),
        isNull(pageViews.turnstileVerdict),
        eq(pageViews.privacySignal, false),
        gte(pageViews.createdAt, new Date(now - TURNSTILE_VERDICT_WINDOW_MS).toISOString()),
      ),
    )
    .returning({ id: pageViews.id });
  return rows.length;
}

/**
 * The deferred half of the landing verdict post. Never throws.
 *
 * Verifies the token with `expectedCData = cf_ray`, so a token minted for another
 * page load is `fail` (and still stored as `fail` on THIS ray's row, which is what
 * a forger replaying a token earns). No secret → nothing at all: no fetch, no
 * write, no metric. The arrival row is written from the SSR gateway's own
 * `waitUntil`, which can land after this post, so zero rows changed earns one
 * retry after 2 s.
 *
 * Log-class write: `page_views` is exempt from `audit_log` (ADR 0022), and nothing
 * here renders on a cached page, so there is no purge.
 */
async function applyTurnstileVerdict(
  c: Context<{ Bindings: Env }>,
  body: TurnstileVerdictPost,
  dbFor: DbFactory,
  wait: (ms: number) => Promise<void>,
): Promise<void> {
  const req = c.req.raw;
  const verdict = await verifyTurnstile(c.env, body.token, {
    remoteIp: req.headers.get('cf-connecting-ip')?.trim() || null,
    expectedCData: body.cf_ray,
  });
  if (verdict === null) return;

  let outcome: 'updated' | 'no_row' | 'failed';
  try {
    const { db } = dbFor(c.env);
    let changed = await updateArrivalVerdict(db, body.cf_ray, verdict, Date.now());
    if (changed === 0) {
      await wait(TURNSTILE_VERDICT_RETRY_MS);
      changed = await updateArrivalVerdict(db, body.cf_ray, verdict, Date.now());
    }
    outcome = changed > 0 ? 'updated' : 'no_row';
  } catch (error) {
    outcome = 'failed';
    logToPosthog(c.executionCtx, c.env, req, {
      level: 'warn',
      message: 'aeci.api.page_view.turnstile_update_failed',
      source: 'page-views',
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  submitCount(c.executionCtx, c.env, req, TURNSTILE_METRIC, 1, [
    `verdict:${verdict}`,
    'writer:arrival',
    `outcome:${outcome}`,
  ]);
}

/**
 * `POST /api/page-views/turnstile` (AECI-1457 / AECI-1330): the verdict for a
 * landing view. Body `{ cf_ray, token }` (`TurnstileVerdictPostSchema`). A bad body
 * is a 400; anything well-formed is a 204, with the siteverify call and the UPDATE
 * deferred to `waitUntil`. The response never says whether a row matched.
 *
 * `index.ts` registers it behind the `token` rate-limit bucket keyed by IP, because
 * each accepted post spends one siteverify subrequest.
 */
export function createTurnstileVerdictHandler(
  dbFor: DbFactory = getDb,
  deps: TurnstileVerdictDeps = {},
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  const wait = deps.wait ?? sleep;
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }
    const body = TurnstileVerdictPostSchema.parse(raw);
    c.executionCtx.waitUntil(applyTurnstileVerdict(c, body, dbFor, wait));
    return noContent();
  };
}
