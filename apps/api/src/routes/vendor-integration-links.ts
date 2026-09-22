/**
 * Per-side integration links, vendor side (AECI-1007 / ADR 0035 decision 6 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.7) — Drizzle/D1.
 *
 *   PUT    /api/vendor/integrations/:id/links/:productId/:kind — set one link (200).
 *   DELETE /api/vendor/integrations/:id/links/:productId/:kind — remove it (200).
 *
 * Each endpoint vendor stores its own marketplace listing and docs link on an
 * integration. Six rules of this module's own:
 *
 * ── 1. A SEAT IS THE WHOLE GATE ─────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')`, and no `requireCapability` and no
 * Verified check (AECI-1003 decision 15), the same named exception contests and
 * the claim took.
 *
 * ── 2. THE SIDE IS A PRODUCT, AND THE CALLER MUST OWN IT ────────────────────
 * `:productId` names the endpoint the link speaks for. It must be the row's source
 * or target, and the caller's vendor must hold it through `product_vendors`.
 * Ownership of the INTEGRATION is not required, and neither is a claim: a link is
 * the endpoint vendor's own statement about its own side. A product id rather than
 * `a`/`b` because promote swaps source and target in bulk (AECI-920), and a
 * positional key would hand one vendor's link to the other.
 *
 * ── 3. EVERY MISS IS A 404 ──────────────────────────────────────────────────
 * An unknown integration, a product that is not an endpoint of it, and an endpoint
 * the caller does not own all answer the same 404. The last one includes the other
 * side of a row the caller can see: it is not the caller's side to write, and a
 * distinct code would tell a stranger which products sit on which rows.
 *
 * ── 4. CONNECTOR-POWERED ROWS TAKE NO NEW LINKS ─────────────────────────────
 * Decision 9 (ruled 2026-09-18 for links). Decided by `isConnectorPoweredEdge`, so
 * a PUT on a row with `powered_by_product_id`, `iPaaS` or a Convention-A
 * self-reference is refused with `403 INTEGRATION_CONNECTOR_POWERED`. Asked AFTER
 * the side check, so a caller with no side still gets the 404.
 *
 * A DELETE passes the fence. Promote can make an unclaimed row connector-powered
 * IN PLACE (a connector `mechanism_kind`, or a Convention-A self-reference), and
 * the links stored before that stay in the table. The pair page stops showing them,
 * and removing your own link is not an edit of the row, so the vendor can still
 * clear it. On such a row the DELETE writes no §13.9 maintenance transfer: the row
 * is connector-delivered and stays AECi's to curate. It still bumps `updated_at`,
 * so the freshness cursor sees the removal.
 *
 * ── 4b. RETIRED ROWS TAKE NO LINK WRITES (AECI-1010) ────────────────────────
 * A retired row answers `409 INTEGRATION_RETIRED` to both PUT and DELETE, after the
 * side check and the connector fence, through `assertIntegrationLive`. The batch
 * opens with `integrationLiveSentinel`, so a retire that lands between the read and
 * the batch stops the write too.
 *
 * ── 5. ONE BATCH, AND THE WRITE TRANSFERS MAINTENANCE ───────────────────────
 * The link upsert (or delete), the §13.9 maintenance transfer on the integration
 * row, and one `integration.link_set` / `integration.link_removed` audit row. The
 * transfer is an UPDATE of `integrations`, so `updated_at` moves with it, and that
 * is what moves the `integrations` freshness cursor for BOTH endpoint vendors
 * (`vendor-updates.ts` reads `max(integrations.updated_at)`). A DELETE of a link
 * that does not exist writes nothing and still answers 200 with the side as it is.
 *
 * ── 6. LINKS ARE NEVER ROUTES AND NEVER PERMISSIONS ─────────────────────────
 * Nothing reads a stored URL to decide anything. The pair page renders it as an
 * external `href`, and promote never writes this table
 * (`promote-vendor-links.spec.ts`).
 */

import {
  ApiErrorCode,
  IntegrationLinkKindSchema,
  IntegrationLinkResponseSchema,
  PutIntegrationLinkSchema,
  type IntegrationLinkKind,
  type IntegrationLinkResponse,
  type IntegrationSideLinks,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { integrations, integrationVendorLinks, productVendors, products } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import { toSideLinks } from '../lib/integration-vendor-links';
import {
  assertIntegrationLive,
  integrationLiveSentinel,
  integrationRetiredError,
} from '../lib/live-integration';
import { publicSiteBase } from '../lib/public-urls';
import { pairCacheTag } from './promote-pair';
import { attestationEditRecrawl } from './vendor-recrawl';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  isMaintenanceTransfer,
  maintenanceTransferColumns,
  parseJsonBody,
  recrawlEnabled,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

/** `audit_log.action` values. `entity_type` is `integration`, like every other
 *  write that is about one integration row. */
export const INTEGRATION_LINK_SET_ACTION = 'integration.link_set';
export const INTEGRATION_LINK_REMOVED_ACTION = 'integration.link_removed';

const LINK_GONE_TOKEN = 'integration-link-already-removed';

/**
 * Aborts a DELETE batch whose link was removed by a concurrent request after the
 * handler read it. Push it IMMEDIATELY after the DELETE: `changes()` reports the
 * statement before it. Selects FROM `ONE_ROW`, the AECI-1005 review pattern, so it
 * evaluates exactly once whatever state the link row is in. Without it the loser
 * would still commit a maintenance transfer and an audit row saying it removed a
 * link it did not.
 */
function linkRemovedSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${LINK_GONE_TOKEN}) END` })
    .from(ONE_ROW);
}

function isLinkRemovedRace(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(LINK_GONE_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

interface Target {
  row: {
    id: string;
    sourceProductId: string;
    targetProductId: string;
    poweredByProductId: string | null;
    mechanismKind: string | null;
    maintainedBy: string;
    retiredAt: string | null;
  };
  productId: string;
  kind: IntegrationLinkKind;
}

/** Params, row, side ownership, then the connector fence: rules 2 to 4, in order.
 *  `mode` is the write: a `remove` passes the connector fence (rule 4). */
async function resolveTarget(
  c: VendorContext,
  db: Db,
  vendorId: string,
  mode: 'set' | 'remove',
): Promise<Target> {
  const integrationId = c.req.param('id');
  const productId = c.req.param('productId');
  const kindParam = IntegrationLinkKindSchema.safeParse(c.req.param('kind'));
  if (!integrationId || !productId) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing id', { field: 'id' });
  }
  if (!kindParam.success) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'kind must be listing or docs', {
      field: 'kind',
    });
  }

  const row = await db.query.integrations.findFirst({
    columns: {
      id: true,
      sourceProductId: true,
      targetProductId: true,
      poweredByProductId: true,
      mechanismKind: true,
      maintainedBy: true,
      retiredAt: true,
    },
    where: eq(integrations.id, integrationId),
  });
  if (!row) throw notFoundError('integration', { id: integrationId });

  const isEndpoint = productId === row.sourceProductId || productId === row.targetProductId;
  const owned = isEndpoint
    ? await db
        .select({ productId: productVendors.productId })
        .from(productVendors)
        .where(and(eq(productVendors.vendorId, vendorId), eq(productVendors.productId, productId)))
        .limit(1)
    : [];
  if (owned.length === 0) throw notFoundError('integration', { id: integrationId });

  if (mode === 'set' && isConnectorPoweredEdge(row)) {
    throw new ApiError(
      403,
      ApiErrorCode.INTEGRATION_CONNECTOR_POWERED,
      'This integration is delivered through a connector product, and connector-delivered integrations cannot take your own links yet.',
    );
  }
  // AECI-1010: a retired row takes no link write, PUT or DELETE. Last, so a caller
  // with no side still gets the 404.
  assertIntegrationLive(row);
  return { row, productId, kind: kindParam.data };
}

async function sideLinks(db: Db, integrationId: string, productId: string) {
  return db
    .select({
      id: integrationVendorLinks.id,
      kind: integrationVendorLinks.kind,
      url: integrationVendorLinks.url,
    })
    .from(integrationVendorLinks)
    .where(
      and(
        eq(integrationVendorLinks.integrationId, integrationId),
        eq(integrationVendorLinks.productId, productId),
      ),
    );
}

/** Both endpoint slugs, for the purge and the recrawl. */
async function endpointSlugs(
  db: Db,
  row: Target['row'],
): Promise<readonly [string, string] | null> {
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.id, [row.sourceProductId, row.targetProductId]));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  const a = slug.get(row.sourceProductId);
  const b = slug.get(row.targetProductId);
  return a && b ? [a, b] : null;
}

function respond(
  c: VendorContext,
  integrationId: string,
  productId: string,
  links: IntegrationSideLinks,
): Response {
  const body: IntegrationLinkResponse = {
    integration_id: integrationId,
    product_id: productId,
    links,
  };
  validateResponseInDev(c.env, () => IntegrationLinkResponseSchema.parse(body));
  return json(body);
}

/** Commit, then purge the pair page and both product pages and queue the pair
 *  re-crawl, because the pair page's links and its maintenance marker moved. */
async function commit(
  c: VendorContext,
  db: Db,
  target: Target,
  stmts: BatchStmt[],
  audit: AuditLogEntry,
): Promise<void> {
  const pairSlugs = await endpointSlugs(db, target.row);
  try {
    // First in the batch: a retire that landed after the read aborts the write.
    await db.batch([integrationLiveSentinel(db, target.row.id), ...stmts] as BatchTuple);
  } catch (error) {
    // Both sentinels raise the same malformed-JSON error, so ask the row which one.
    const now = await db.query.integrations.findFirst({
      columns: { retiredAt: true },
      where: eq(integrations.id, target.row.id),
    });
    if (now?.retiredAt) throw integrationRetiredError();
    throw error;
  }
  const tags = pairSlugs
    ? [
        pairCacheTag(pairSlugs[0], pairSlugs[1]),
        `product:${pairSlugs[0]}`,
        `product:${pairSlugs[1]}`,
      ]
    : [];
  const base = publicSiteBase(c.env);
  const recrawl =
    pairSlugs && recrawlEnabled(c.env) && base
      ? attestationEditRecrawl(base, pairSlugs[0], pairSlugs[1])
      : undefined;
  afterVendorWrite(c, tags, audit, recrawl, db);
}

function auditFor(
  c: VendorContext,
  vendorId: string,
  target: Target,
  action: string,
  before: string | null,
  after: string | null,
  stranded = false,
): AuditLogEntry {
  const session = c.get('auth');
  return {
    actorId: session.userId,
    actorType: auditActorType(session),
    action,
    entityType: 'integration',
    entityId: target.row.id,
    beforeState: { product_id: target.productId, kind: target.kind, url: before },
    afterState: { product_id: target.productId, kind: target.kind, url: after },
    metadata: {
      source: AUDIT_SOURCE,
      vendorId,
      productId: target.productId,
      kind: target.kind,
      // Present only on the hand-changing write, never as `false` (§13.9). A
      // stranded removal on a connector-powered row changes no hands (rule 4).
      ...(!stranded && isMaintenanceTransfer(target.row) ? { maintenanceTransfer: true } : {}),
      ...(stranded ? { connectorPowered: true } : {}),
    },
  };
}

export function createPutIntegrationLinkHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const target = await resolveTarget(c, db, vendorId, 'set');
    const payload = await parseJsonBody(c, PutIntegrationLinkSchema);

    const current = await sideLinks(db, target.row.id, target.productId);
    const before = current.find((l) => l.kind === target.kind)?.url ?? null;
    const now = new Date().toISOString();
    const audit = auditFor(c, vendorId, target, INTEGRATION_LINK_SET_ACTION, before, payload.url);

    await commit(
      c,
      db,
      target,
      [
        db
          .insert(integrationVendorLinks)
          .values({
            integrationId: target.row.id,
            productId: target.productId,
            kind: target.kind,
            url: payload.url,
            vendorId,
          })
          .onConflictDoUpdate({
            target: [
              integrationVendorLinks.integrationId,
              integrationVendorLinks.productId,
              integrationVendorLinks.kind,
            ],
            set: { url: payload.url, vendorId, updatedAt: now },
          }),
        db
          .update(integrations)
          .set(maintenanceTransferColumns(now))
          .where(eq(integrations.id, target.row.id)),
        auditInsert(db, audit),
      ],
      audit,
    );

    const links = toSideLinks([
      ...current.filter((l) => l.kind !== target.kind),
      { kind: target.kind, url: payload.url },
    ]);
    return respond(c, target.row.id, target.productId, links);
  };
}

export function createDeleteIntegrationLinkHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const target = await resolveTarget(c, db, vendorId, 'remove');
    // A stranded link on a connector-powered row: removal, but no hand change (rule 4).
    const stranded = isConnectorPoweredEdge(target.row);

    const current = await sideLinks(db, target.row.id, target.productId);
    const existing = current.find((l) => l.kind === target.kind);
    const remaining = current.filter((l) => l.kind !== target.kind);
    // Nothing to remove: write nothing, not even an audit row, and answer with the
    // side as it stands. A repeated DELETE is therefore harmless.
    if (!existing) return respond(c, target.row.id, target.productId, toSideLinks(remaining));

    const now = new Date().toISOString();
    const audit = auditFor(
      c,
      vendorId,
      target,
      INTEGRATION_LINK_REMOVED_ACTION,
      existing.url,
      null,
      stranded,
    );
    try {
      await commit(
        c,
        db,
        target,
        [
          db.delete(integrationVendorLinks).where(eq(integrationVendorLinks.id, existing.id)),
          linkRemovedSentinel(db),
          db
            .update(integrations)
            .set(stranded ? { updatedAt: now } : maintenanceTransferColumns(now))
            .where(eq(integrations.id, target.row.id)),
          auditInsert(db, audit),
        ],
        audit,
      );
    } catch (error) {
      if (!isLinkRemovedRace(error)) throw error;
      // Someone else removed it first. Nothing was written; answer with the side
      // as it now stands, which is what a repeated DELETE answers anyway.
      const after = await sideLinks(db, target.row.id, target.productId);
      return respond(c, target.row.id, target.productId, toSideLinks(after));
    }
    return respond(c, target.row.id, target.productId, toSideLinks(remaining));
  };
}
