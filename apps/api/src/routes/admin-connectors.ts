/**
 * The connector admin surface (AECI-722 — `docs/ADMIN_PANEL_SPEC.md` §5.9), the
 * FIRST read layer over the six connector-lane tables AECI-714 landed:
 *
 *   GET /api/admin/connector-catalogs            — list + per-catalogue tallies
 *   GET /api/admin/connector-catalogs/:id        — basics, surfaces, counts, handover
 *   GET /api/admin/connector-catalogs/:id/stubs  — the triage queue
 *   GET /api/admin/connector-catalogs/:id/pairs  — evidenced vs reachable, one lane per call
 *   GET /api/admin/connector-catalogs/:id/audit  — the `audit_log` viewer
 *
 * All five behind `requireAdmin()`. All five are `GET`s that write NOTHING —
 * §6's convention, and ADR 0022's scoping of the §26.1 invariant: reads carry no
 * `audit_log` obligation. There is no cache purge and no `Cache-Tag` either, and
 * that is a positive statement rather than an omission: `/admin/*` is
 * deliberately uncacheable (`CACHE_STRATEGY.md` §4 — *"Do not add an `/admin`
 * entry to `ROUTE_CACHE_PATTERNS`"*), so an admin-only read surface renders
 * nothing cacheable and the connector tables still have no tag vocabulary. That
 * obligation stays with AECI-715 / 716, the first PUBLIC read surface.
 *
 * ── THE ONE WRITE THIS SCREEN DRIVES IS SOMEBODY ELSE'S ─────────────────────
 * `PATCH /api/admin/connector-catalogs/:id` (`./admin-connector-catalogs`,
 * AECI-720) owns the `managed_by` flip, its audit row, its 422 same-state gate
 * and its 404 on an unknown `vendorId`. This module does not re-implement any of
 * it; it renders the state the flip moves, and reads the handover back out of the
 * audit trail because that trail is the only place `vendorId` and `reason` are
 * recorded.
 *
 * Why mapping decisions are NOT writable here — the sync would clobber them — is
 * argued in `packages/shared/src/api/admin-connectors.ts`.
 */

import {
  AdminConnectorAuditQuerySchema,
  AdminConnectorAuditResponseSchema,
  AdminConnectorCatalogDetailSchema,
  AdminConnectorCatalogsListQuerySchema,
  AdminConnectorCatalogsListResponseSchema,
  AdminConnectorPairsQuerySchema,
  AdminConnectorPairsResponseSchema,
  AdminConnectorStubsQuerySchema,
  AdminConnectorStubsResponseSchema,
  type AdminAuditRow,
  type AdminConnectorCatalogDetail,
  type AdminConnectorCatalogRow,
  type AdminConnectorCatalogsListResponse,
  type AdminConnectorEvidencedPairRow,
  type AdminConnectorHandover,
  type AdminConnectorMapping,
  type AdminConnectorPairSide,
  type AdminConnectorPairsResponse,
  type AdminConnectorReachablePairRow,
  type AdminConnectorStubRow,
  type AdminConnectorStubsResponse,
  type AdminNote,
  type LinkRef,
} from '@aeci/shared';
import { and, asc, count, desc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  auditLog,
  connectorCatalogSurfaces,
  connectorCatalogs,
  connectorEvidencedPairs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { ApiErrorCode } from '@aeci/shared';
import {
  collectCounts,
  emptyCounts,
  isPublishable,
  representativeMapping,
  stubFilterWhere,
  toMapping,
} from '../lib/admin-connectors';
import { note } from '../lib/admin-analytics';
import type { AuthzVariables } from '../lib/authz';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { likeContains } from '../lib/sql-like';
import { fetchAuthUserEmailsResult, type AuthEmailLookup } from '../lib/supabase-admin';

type AdminConnectorContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** Injected email seam, in the availability-reporting form — same shape and same
 *  reason as `admin-vendors.ts`: a bare map cannot tell "the seam is down" from
 *  "this account has no address", and the handover block has to. */
export type FetchAuthEmails = (env: Env, ids: readonly string[]) => Promise<AuthEmailLookup>;

// ─── Local helpers (mirroring `admin-vendors.ts`) ────────────────────────────

function requiredParam(c: AdminConnectorContext, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, `Missing ${name}`, { field: name });
  }
  return value;
}

function parseQuery<T>(c: AdminConnectorContext, schema: { parse: (input: unknown) => T }): T {
  return schema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
}

const productLink = (p: { id: string; name: string; slug: string }): LinkRef => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
});

/** Hydrate a set of product ids to `LinkRef`s. Bounded by the caller's page. */
async function loadProducts(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, { id: string; name: string; slug: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: products.id, name: products.name, slug: products.slug })
    .from(products)
    .where(inArray(products.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

/** The catalogue row every handler's 404 gate loads. */
async function loadCatalog(db: Db, id: string) {
  return db
    .select({
      id: connectorCatalogs.id,
      connectorProductId: connectorCatalogs.connectorProductId,
      connectorAuthorship: connectorCatalogs.connectorAuthorship,
      managedBy: connectorCatalogs.managedBy,
      notes: connectorCatalogs.notes,
      updatedAt: connectorCatalogs.updatedAt,
      productName: products.name,
      productSlug: products.slug,
    })
    .from(connectorCatalogs)
    .innerJoin(products, eq(products.id, connectorCatalogs.connectorProductId))
    .where(eq(connectorCatalogs.id, id))
    .then((rows) => rows[0] ?? null);
}

// ─── GET /api/admin/connector-catalogs ───────────────────────────────────────

/**
 * The catalogue list.
 *
 * `innerJoin(products)` cannot multiply rows — `connector_product_id` is NOT NULL
 * with a FK to a primary key — and it is an INNER join deliberately: a catalogue
 * whose connector platform is unpromoted never lands at all (the sync reports it
 * in `skipped[]`, §9a.1), so there is no orphan case for a LEFT join to reveal.
 *
 * Ordered by product name with `id` as the tiebreaker. The tiebreaker is not
 * decoration: two catalogues can share a product name, and without a second key
 * the page boundary is unstable — a row can appear twice or not at all.
 */
export function createAdminConnectorCatalogsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminConnectorContext) => Promise<Response> {
  return async (c) => {
    const query = parseQuery(c, AdminConnectorCatalogsListQuerySchema);
    const { db } = dbFor(c.env);

    const search = query.search?.trim();
    const where = and(
      query.managed_by ? eq(connectorCatalogs.managedBy, query.managed_by) : undefined,
      search
        ? or(likeContains(products.name, search), likeContains(products.slug, search))
        : undefined,
    );

    const [rows, totals] = await db.batch([
      db
        .select({
          id: connectorCatalogs.id,
          connectorProductId: connectorCatalogs.connectorProductId,
          connectorAuthorship: connectorCatalogs.connectorAuthorship,
          managedBy: connectorCatalogs.managedBy,
          notes: connectorCatalogs.notes,
          updatedAt: connectorCatalogs.updatedAt,
          productName: products.name,
          productSlug: products.slug,
        })
        .from(connectorCatalogs)
        .innerJoin(products, eq(products.id, connectorCatalogs.connectorProductId))
        .where(where)
        .orderBy(asc(products.name), asc(connectorCatalogs.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db
        .select({ value: count() })
        .from(connectorCatalogs)
        .innerJoin(products, eq(products.id, connectorCatalogs.connectorProductId))
        .where(where),
    ]);

    const byCatalog = new Map(rows.map((r) => [r.id, r.connectorProductId]));
    const tallies = await collectCounts(
      db,
      rows.map((r) => r.id),
      byCatalog,
    );

    const body: AdminConnectorCatalogsListResponse = {
      data: rows.map((r): AdminConnectorCatalogRow => {
        const t = tallies.get(r.id);
        return {
          id: r.id,
          connector_product: { id: r.connectorProductId, name: r.productName, slug: r.productSlug },
          connector_authorship:
            (r.connectorAuthorship as AdminConnectorCatalogRow['connector_authorship']) ?? null,
          managed_by: r.managedBy as AdminConnectorCatalogRow['managed_by'],
          notes: r.notes ?? null,
          last_ingested_at: t?.lastIngestedAt ?? null,
          counts: t?.counts ?? emptyCounts(),
          updated_at: r.updatedAt,
        };
      }),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      AdminConnectorCatalogsListResponseSchema.parse(body);
    });
    return json(body);
  };
}

// ─── GET /api/admin/connector-catalogs/:id ───────────────────────────────────

/**
 * Derive the handover from `audit_log`.
 *
 * AECI-720 persists `vendorId` and `reason` ONLY in the audit row's `metadata`,
 * so the trail is the sole record of who a catalogue was handed to. `metadata`
 * is deliberately absent from `AdminAuditRow` — that schema is rendered by the
 * shared `<aec-audit-trail>` for vendors too — so this derives a fixed shape
 * rather than widening the generic row.
 *
 * **Only while the lane is actually frozen.** A catalogue reclaimed to `review`
 * returns `null`: rendering the last handover beside a review-managed lane would
 * read as if it were still live. The history stays in the trail.
 *
 * `metadata` is `unknown` on the wire and written by code this reader may not
 * know, so every field is probed defensively — a malformed row costs the handover
 * block, never the page.
 */
async function loadHandover(
  db: Db,
  catalogId: string,
  managedBy: string,
): Promise<{ handover: AdminConnectorHandover | null; actorId: string | null }> {
  if (managedBy !== 'vendor') return { handover: null, actorId: null };

  const rows = await db
    .select({
      actorId: auditLog.actorId,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'connector_catalog'),
        eq(auditLog.entityId, catalogId),
        eq(auditLog.action, 'connector_catalog.managed_by_vendor'),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1);

  const row = rows[0];
  if (!row) return { handover: null, actorId: null };

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const vendorId = typeof meta['vendor_id'] === 'string' ? meta['vendor_id'] : null;
  const reason = typeof meta['reason'] === 'string' ? meta['reason'] : null;

  let vendor: LinkRef | null = null;
  if (vendorId) {
    const v = await db
      .select({ id: vendors.id, name: vendors.companyName, slug: vendors.slug })
      .from(vendors)
      .where(eq(vendors.id, vendorId))
      .then((r) => r[0] ?? null);
    // A vendor deleted since the handover leaves the audit row pointing nowhere.
    // Report the handover without a vendor rather than suppressing it — the
    // handover happened, and that is the fact the operator needs.
    vendor = v ? { id: v.id, name: v.name, slug: v.slug } : null;
  }

  return {
    handover: { vendor, reason, actor: null, at: row.createdAt },
    actorId: row.actorId ?? null,
  };
}

/**
 * The catalogue detail bundle.
 *
 * One `db.batch` for the D1 reads, then the GoTrue fan-out AFTER it, so a slow
 * seam never widens the database hop — the ordering `admin-vendors.ts` settled.
 */
export function createAdminConnectorCatalogDetailHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthEmails = fetchAuthUserEmailsResult,
): (c: AdminConnectorContext) => Promise<Response> {
  return async (c) => {
    const id = requiredParam(c, 'id');
    const { db } = dbFor(c.env);

    const catalog = await loadCatalog(db, id);
    if (!catalog) throw notFoundError('connector_catalog', { id });

    const [surfaces, tallies, handoverResult] = await Promise.all([
      db
        .select({
          id: connectorCatalogSurfaces.id,
          surfaceRole: connectorCatalogSurfaces.surfaceRole,
          indexKind: connectorCatalogSurfaces.indexKind,
          indexUrl: connectorCatalogSurfaces.indexUrl,
          lastIngestedAt: connectorCatalogSurfaces.lastIngestedAt,
          notes: connectorCatalogSurfaces.notes,
        })
        .from(connectorCatalogSurfaces)
        .where(eq(connectorCatalogSurfaces.catalogId, id))
        .orderBy(asc(connectorCatalogSurfaces.surfaceRole)),
      collectCounts(db, [id], new Map([[id, catalog.connectorProductId]])),
      loadHandover(db, id, catalog.managedBy),
    ]);

    const tally = tallies.get(id);
    const counts = tally?.counts ?? emptyCounts();

    // The GoTrue hop, after the D1 work and only when there is an actor to name.
    const actorIds = handoverResult.actorId ? [handoverResult.actorId] : [];
    const [actorRows, lookup] = await Promise.all([
      actorIds.length === 0
        ? Promise.resolve([] as { id: string; displayName: string | null }[])
        : db
            .select({ id: profiles.id, displayName: profiles.displayName })
            .from(profiles)
            .where(inArray(profiles.id, actorIds)),
      fetchEmails(c.env, actorIds),
    ]);

    let handover = handoverResult.handover;
    if (handover && handoverResult.actorId) {
      const actorId = handoverResult.actorId;
      handover = {
        ...handover,
        actor: {
          id: actorId,
          display_name: actorRows.find((r) => r.id === actorId)?.displayName ?? null,
          email: lookup.emails.get(actorId) ?? null,
        },
      };
    }

    const advisories: AdminNote[] = [];
    if (counts.evidenced_pairs === 0) {
      advisories.push(
        note(
          'connector_evidenced_pairs_empty',
          'The delivered lane is empty because AECI-721 has not migrated the powered edges yet, not because this connector delivers nothing.',
        ),
      );
    }
    if (counts.pairs_curated + counts.pairs_generated + counts.pairs_unknown > 0) {
      advisories.push(
        note(
          'reachable_never_counted',
          'Pair counts describe how many pair pages the vendor publishes. Reachable pairs are never counted as integrations.',
        ),
      );
    }

    const body: AdminConnectorCatalogDetail = {
      id: catalog.id,
      connector_product: {
        id: catalog.connectorProductId,
        name: catalog.productName,
        slug: catalog.productSlug,
      },
      connector_authorship:
        (catalog.connectorAuthorship as AdminConnectorCatalogDetail['connector_authorship']) ??
        null,
      managed_by: catalog.managedBy as AdminConnectorCatalogDetail['managed_by'],
      notes: catalog.notes ?? null,
      last_ingested_at: tally?.lastIngestedAt ?? null,
      counts,
      updated_at: catalog.updatedAt,
      surfaces: surfaces.map((s) => ({
        id: s.id,
        surface_role: s.surfaceRole,
        index_kind: s.indexKind ?? null,
        index_url: s.indexUrl ?? null,
        last_ingested_at: s.lastIngestedAt ?? null,
        notes: s.notes ?? null,
      })),
      handover,
      advisories,
      actor_emails_available: lookup.available,
    };

    validateResponseInDev(c.env, () => {
      AdminConnectorCatalogDetailSchema.parse(body);
    });
    return json(body);
  };
}

// ─── GET /api/admin/connector-catalogs/:id/stubs ─────────────────────────────

/**
 * The triage queue.
 *
 * Three sequential reads by necessity, each bounded by the page: the stub page,
 * then its mappings (`stub_id IN (…)`), then the products those mappings name.
 * Not a join — a stub carries several mappings (§9a.4's many-to-many), so a join
 * would repeat the stub once per mapping and break both the page and its `total`.
 *
 * The `actions` blob NEVER crosses this wire. It is ~73k actions across MindCloud
 * alone; the row ships `actions_fetched` instead, so the UI cannot render a
 * never-fetched inventory as an empty one (§9a.3).
 */
export function createAdminConnectorStubsHandler(
  dbFor: DbFactory = getDb,
): (c: AdminConnectorContext) => Promise<Response> {
  return async (c) => {
    const id = requiredParam(c, 'id');
    const query = parseQuery(c, AdminConnectorStubsQuerySchema);
    const { db } = dbFor(c.env);

    const catalog = await loadCatalog(db, id);
    if (!catalog) throw notFoundError('connector_catalog', { id });

    const where = stubFilterWhere(id, {
      state: query.state,
      proposalsOnly: query.proposals_only,
      confidence: query.confidence,
      search: query.search,
      includeRemoved: query.include_removed,
    });

    const [rows, totals] = await db.batch([
      db
        .select({
          id: connectorStubs.id,
          slug: connectorStubs.slug,
          label: connectorStubs.label,
          url: connectorStubs.url,
          directionRole: connectorStubs.directionRole,
          actionCount: connectorStubs.actionCount,
          // Presence, never the payload.
          actionsFetched: isNotNull(connectorStubs.actions),
          actionsFetchedAt: connectorStubs.actionsFetchedAt,
          firstSeenAt: connectorStubs.firstSeenAt,
          lastSeenAt: connectorStubs.lastSeenAt,
          removedAt: connectorStubs.removedAt,
        })
        .from(connectorStubs)
        .where(where)
        // Newest listings first: a stub that just appeared is the one most likely
        // to need a decision, which is what this queue is for. `id` breaks ties.
        .orderBy(desc(connectorStubs.firstSeenAt), asc(connectorStubs.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(connectorStubs).where(where),
    ]);

    const stubIds = rows.map((r) => r.id);
    const mappingRows =
      stubIds.length === 0
        ? []
        : await db
            .select({
              id: connectorStubMappings.id,
              stubId: connectorStubMappings.stubId,
              status: connectorStubMappings.status,
              productId: connectorStubMappings.productId,
              confidence: connectorStubMappings.confidence,
              evidenceUrl: connectorStubMappings.evidenceUrl,
              decidedBy: connectorStubMappings.decidedBy,
              decidedAt: connectorStubMappings.decidedAt,
              checkedAt: connectorStubMappings.checkedAt,
              notes: connectorStubMappings.notes,
            })
            .from(connectorStubMappings)
            .where(inArray(connectorStubMappings.stubId, stubIds))
            .orderBy(asc(connectorStubMappings.id));

    const productMap = await loadProducts(
      db,
      mappingRows.map((m) => m.productId).filter((v): v is string => !!v),
    );

    const byStub = new Map<string, AdminConnectorMapping[]>();
    for (const m of mappingRows) {
      const list = byStub.get(m.stubId) ?? [];
      list.push(toMapping(m, productMap));
      byStub.set(m.stubId, list);
    }

    const neverFetched = rows.filter((r) => !r.actionsFetched).length;
    const advisories: AdminNote[] = [];
    if (neverFetched > 0) {
      advisories.push(
        note(
          'stub_actions_never_fetched',
          `${neverFetched} of ${rows.length} listings on this page have never had their action inventory fetched. That is not the same as having no actions.`,
          { never_fetched: neverFetched, total: rows.length },
        ),
      );
    }

    const body: AdminConnectorStubsResponse = {
      data: rows.map(
        (r): AdminConnectorStubRow => ({
          id: r.id,
          slug: r.slug,
          label: r.label ?? null,
          url: r.url ?? null,
          direction_role: r.directionRole ?? null,
          action_count: r.actionCount ?? null,
          actions_fetched: Boolean(r.actionsFetched),
          actions_fetched_at: r.actionsFetchedAt ?? null,
          first_seen_at: r.firstSeenAt,
          last_seen_at: r.lastSeenAt,
          removed_at: r.removedAt ?? null,
          mappings: byStub.get(r.id) ?? [],
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
      advisories,
    };

    validateResponseInDev(c.env, () => {
      AdminConnectorStubsResponseSchema.parse(body);
    });
    return json(body);
  };
}

// ─── GET /api/admin/connector-catalogs/:id/pairs ─────────────────────────────

/**
 * Evidenced vs reachable, ONE LANE PER CALL.
 *
 * Two lanes rather than one interleaved list because §13.3 requires one `<table>`
 * per lane: a group-header row inside a single `<tbody>` has no accessible name
 * relationship to the rows beneath it, so a screen-reader user gets the grouping
 * visually and not at all otherwise. Splitting at the endpoint is what lets the UI
 * render two independently-paginated tables without inventing a client-side split.
 *
 * The reachable rows carry the publication gate's INPUTS, never its verdict —
 * §13.7's four-clause rule is AECI-716's, and clause (c) reuses Addendum A §11.4's
 * scoring, which does not exist in this repo. The `publication_gate_inputs_only`
 * advisory says so on the wire so the screen cannot be read as a publish decision.
 */
export function createAdminConnectorPairsHandler(
  dbFor: DbFactory = getDb,
): (c: AdminConnectorContext) => Promise<Response> {
  return async (c) => {
    const id = requiredParam(c, 'id');
    const query = parseQuery(c, AdminConnectorPairsQuerySchema);
    const { db } = dbFor(c.env);

    const catalog = await loadCatalog(db, id);
    if (!catalog) throw notFoundError('connector_catalog', { id });

    const offset = (query.page - 1) * query.perPage;

    if (query.lane === 'evidenced') {
      const where = eq(connectorEvidencedPairs.connectorProductId, catalog.connectorProductId);
      const [rows, totals] = await db.batch([
        db
          .select({
            id: connectorEvidencedPairs.id,
            productAId: connectorEvidencedPairs.productAId,
            productBId: connectorEvidencedPairs.productBId,
            name: connectorEvidencedPairs.name,
            builtByVendorId: connectorEvidencedPairs.builtByVendorId,
            mechanismName: connectorEvidencedPairs.mechanismName,
            direction: connectorEvidencedPairs.direction,
            listingUrl: connectorEvidencedPairs.listingUrl,
            lastReviewedAt: connectorEvidencedPairs.lastReviewedAt,
            maintainedBy: connectorEvidencedPairs.maintainedBy,
          })
          .from(connectorEvidencedPairs)
          .where(where)
          .orderBy(asc(connectorEvidencedPairs.id))
          .limit(query.perPage)
          .offset(offset),
        db.select({ value: count() }).from(connectorEvidencedPairs).where(where),
      ]);

      const productMap = await loadProducts(
        db,
        rows.flatMap((r) => [r.productAId, r.productBId]),
      );
      const vendorIds = [
        ...new Set(rows.map((r) => r.builtByVendorId).filter((v): v is string => !!v)),
      ];
      const vendorRows =
        vendorIds.length === 0
          ? []
          : await db
              .select({ id: vendors.id, name: vendors.companyName, slug: vendors.slug })
              .from(vendors)
              .where(inArray(vendors.id, vendorIds));
      const vendorMap = new Map(vendorRows.map((v) => [v.id, v]));

      const total = totals[0]?.value ?? 0;
      const advisories: AdminNote[] = [];
      if (total === 0) {
        advisories.push(
          note(
            'connector_evidenced_pairs_empty',
            'The delivered lane is empty because AECI-721 has not migrated the powered edges yet, not because this connector delivers nothing.',
          ),
        );
      }

      const body: AdminConnectorPairsResponse = {
        lane: 'evidenced',
        data: rows.map((r): AdminConnectorEvidencedPairRow => {
          const a = productMap.get(r.productAId);
          const b = productMap.get(r.productBId);
          const v = r.builtByVendorId ? vendorMap.get(r.builtByVendorId) : undefined;
          return {
            id: r.id,
            // Both FKs are NOT NULL with ON DELETE CASCADE, so a missing product
            // is unreachable; the fallback keeps a bad row renderable rather than
            // 500ing the page.
            product_a: a ? productLink(a) : { id: r.productAId, name: r.productAId, slug: '' },
            product_b: b ? productLink(b) : { id: r.productBId, name: r.productBId, slug: '' },
            name: r.name ?? null,
            built_by_vendor: v ? { id: v.id, name: v.name, slug: v.slug } : null,
            mechanism_name: r.mechanismName ?? null,
            direction: (r.direction as AdminConnectorEvidencedPairRow['direction']) ?? null,
            listing_url: r.listingUrl ?? null,
            last_reviewed_at: r.lastReviewedAt ?? null,
            maintained_by: r.maintainedBy as AdminConnectorEvidencedPairRow['maintained_by'],
          };
        }),
        page: query.page,
        perPage: query.perPage,
        total,
        advisories,
      };

      validateResponseInDev(c.env, () => {
        AdminConnectorPairsResponseSchema.parse(body);
      });
      return json(body);
    }

    const where = and(
      eq(connectorPairs.catalogId, id),
      query.surface ? eq(connectorPairs.surface, query.surface) : undefined,
    );
    const [rows, totals] = await db.batch([
      db
        .select({
          id: connectorPairs.id,
          surface: connectorPairs.surface,
          stubAId: connectorPairs.stubAId,
          stubBId: connectorPairs.stubBId,
          urlAToB: connectorPairs.urlAToB,
          urlBToA: connectorPairs.urlBToA,
          classifiedAt: connectorPairs.classifiedAt,
          firstSeenAt: connectorPairs.firstSeenAt,
          lastSeenAt: connectorPairs.lastSeenAt,
          removedAt: connectorPairs.removedAt,
        })
        .from(connectorPairs)
        .where(where)
        .orderBy(desc(connectorPairs.lastSeenAt), asc(connectorPairs.id))
        .limit(query.perPage)
        .offset(offset),
      db.select({ value: count() }).from(connectorPairs).where(where),
    ]);

    const stubIds = [...new Set(rows.flatMap((r) => [r.stubAId, r.stubBId]))];
    const [stubRows, mappingRows] =
      stubIds.length === 0
        ? [[], []]
        : await db.batch([
            db
              .select({
                id: connectorStubs.id,
                slug: connectorStubs.slug,
                label: connectorStubs.label,
              })
              .from(connectorStubs)
              .where(inArray(connectorStubs.id, stubIds)),
            db
              .select({
                stubId: connectorStubMappings.stubId,
                status: connectorStubMappings.status,
                productId: connectorStubMappings.productId,
                decidedBy: connectorStubMappings.decidedBy,
              })
              .from(connectorStubMappings)
              .where(inArray(connectorStubMappings.stubId, stubIds)),
          ]);

    const stubMap = new Map(stubRows.map((s) => [s.id, s]));
    const mappingsByStub = new Map<string, typeof mappingRows>();
    for (const m of mappingRows) {
      const list = mappingsByStub.get(m.stubId) ?? [];
      list.push(m);
      mappingsByStub.set(m.stubId, list);
    }
    const productMap = await loadProducts(
      db,
      mappingRows.map((m) => m.productId).filter((v): v is string => !!v),
    );

    const side = (stubId: string): AdminConnectorPairSide => {
      const stub = stubMap.get(stubId);
      const chosen = representativeMapping(mappingsByStub.get(stubId) ?? []);
      const product = chosen?.productId ? (productMap.get(chosen.productId) ?? null) : null;
      return {
        stub_id: stubId,
        slug: stub?.slug ?? stubId,
        label: stub?.label ?? null,
        product: product ? productLink(product) : null,
        // `isPublishable`, never a re-implementation: the whole point of the
        // predicate living in one place is that this cell and the
        // `mappings_publishable` tally cannot drift apart.
        publishable: chosen ? isPublishable(chosen) : false,
      };
    };

    const body: AdminConnectorPairsResponse = {
      lane: 'reachable',
      data: rows.map(
        (r): AdminConnectorReachablePairRow => ({
          id: r.id,
          surface: r.surface as AdminConnectorReachablePairRow['surface'],
          side_a: side(r.stubAId),
          side_b: side(r.stubBId),
          url_a_to_b: r.urlAToB ?? null,
          url_b_to_a: r.urlBToA ?? null,
          classified_at: r.classifiedAt ?? null,
          first_seen_at: r.firstSeenAt,
          last_seen_at: r.lastSeenAt,
          removed_at: r.removedAt ?? null,
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
      advisories: [
        note(
          'publication_gate_inputs_only',
          'These rows show the inputs to the publication gate, not its verdict. Two of the four clauses are evaluated elsewhere (AECI-716).',
        ),
        note(
          'reachable_never_counted',
          'Reachable pairs are never counted as integrations: not in a heading, not in integration_count, not in a facet, not in the home stats.',
        ),
      ],
    };

    validateResponseInDev(c.env, () => {
      AdminConnectorPairsResponseSchema.parse(body);
    });
    return json(body);
  };
}

// ─── GET /api/admin/connector-catalogs/:id/audit ─────────────────────────────

/**
 * The catalogue's audit trail.
 *
 * ONE disjunct, not `admin-vendors.ts`'s four: both writers file under
 * `entity_type = 'connector_catalog'` with the catalogue id — AECI-720's
 * `managed_by_vendor` / `managed_by_review` flips, and the sync's own
 * `connector_catalog.synced` run row — so `audit_log_entity_idx` answers it
 * directly with no new index and no metadata probing.
 *
 * The sync rows being here is the point, not noise: they are the durable record
 * of when the feed last delivered anything, which is the other half of the
 * `STAGE_2_SPEC.md` §8.9(4) freshness duty this screen carries.
 *
 * Ordered `created_at DESC, id DESC`. The tiebreaker matters for the same reason
 * it does on the vendor trail: `created_at` is a JS-stamped ISO string and two
 * rows from one `db.batch` routinely share a millisecond.
 */
export function createAdminConnectorAuditHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthEmails = fetchAuthUserEmailsResult,
): (c: AdminConnectorContext) => Promise<Response> {
  return async (c) => {
    const id = requiredParam(c, 'id');
    const query = parseQuery(c, AdminConnectorAuditQuerySchema);
    const { db } = dbFor(c.env);

    // The 404 gate. Without it an unknown id returns an empty successful page,
    // which reads as "this catalogue has no history" rather than "no such
    // catalogue".
    const exists = await db
      .select({ id: connectorCatalogs.id })
      .from(connectorCatalogs)
      .where(eq(connectorCatalogs.id, id))
      .then((r) => r[0] ?? null);
    if (!exists) throw notFoundError('connector_catalog', { id });

    const where = and(eq(auditLog.entityType, 'connector_catalog'), eq(auditLog.entityId, id));

    const [rows, totals] = await db.batch([
      db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          actorId: auditLog.actorId,
          actorType: auditLog.actorType,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          createdAt: auditLog.createdAt,
          beforeState: auditLog.beforeState,
          afterState: auditLog.afterState,
        })
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(auditLog).where(where),
    ]);

    // Bounded by `perPage`, not by how much history the catalogue has.
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v))];
    const [actorRows, lookup] = await Promise.all([
      actorIds.length === 0
        ? Promise.resolve([] as { id: string; displayName: string | null }[])
        : db
            .select({ id: profiles.id, displayName: profiles.displayName })
            .from(profiles)
            .where(inArray(profiles.id, actorIds)),
      fetchEmails(c.env, actorIds),
    ]);
    const namesById = new Map(actorRows.map((r) => [r.id, r.displayName]));

    const body = {
      data: rows.map(
        (row): AdminAuditRow => ({
          id: row.id,
          action: row.action,
          // A `system` / `workflow` row — the sync's own — has no actor id at
          // all. `null` here means "not a person", never "person unknown".
          actor: row.actorId
            ? {
                id: row.actorId,
                display_name: namesById.get(row.actorId) ?? null,
                email: lookup.emails.get(row.actorId) ?? null,
              }
            : null,
          actor_type: row.actorType,
          entity_type: row.entityType,
          entity_id: row.entityId,
          created_at: row.createdAt,
          before_state: row.beforeState ?? null,
          after_state: row.afterState ?? null,
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
      actor_emails_available: lookup.available,
    };

    validateResponseInDev(c.env, () => {
      AdminConnectorAuditResponseSchema.parse(body);
    });
    return json(body);
  };
}
