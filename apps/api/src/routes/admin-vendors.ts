/**
 * Admin vendor surface (AECI-652 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §5.6) —
 * Drizzle/D1, behind `requireAdmin()`.
 *
 *   GET    /api/admin/vendors                    — paginated list + name/slug search
 *   GET    /api/admin/vendors/:id                — basics, entitlement, seats, counts
 *   GET    /api/admin/vendors/:id/audit          — the `audit_log` viewer
 *   DELETE /api/admin/vendors/:id/seats/:userId  — revoke one seat
 *
 * Until this shipped, the only vendor-management surface in the panel was the
 * entitlement control embedded in a `/admin/claims` card — so a vendor that never
 * filed a claim had no row to hang it on, and concierge onboarding (where AECi
 * approaches the vendor) was simply unreachable. §5.6 reverses the §11 deferral.
 *
 * ── THREE READS AND ONE REVOKE — NO NEW `vendors.verified` WRITER ─────────────
 * The entitlement write stays `PATCH /api/admin/vendors/:id/entitlement`
 * (`admin-entitlements.ts`), still the only writer that can take the mirror back
 * down, and it does so through the entitlement row. The revoke here composes
 * `revokeSeatStatements` (`lib/vendor-grant.ts`), a module an ESLint rule and a
 * generated-SQL assertion both prove never names `vendors` at all.
 *
 * The three GETs emit **no `audit_log` row** — reads write nothing
 * (`ADMIN_PANEL_SPEC.md` §9.3, `API_CONTRACTS.md` §6.10; ADR 0022 scopes the
 * §26.1 invariant, but it is a write-side document, so those two are the direct
 * authority). `json()` sets `private, no-store` and `/admin/*` is absent from
 * `ROUTE_CACHE_PATTERNS`, so none of this is cacheable.
 *
 * ── THE AUDIT VIEWER IS THE FIRST READER `audit_log` HAS EVER HAD ────────────
 * The table is written in the same atomic `db.batch` as every domain-state write
 * and is hard-excluded from the retention prune, but before this it was read only
 * for aggregate counts, a notification dedupe, and the AECI-516 freshness cursor.
 * `audit_log_entity_idx` had no reader at all. Two consequences shape the query
 * in {@link auditScopeWhere}: the row shapes are historical (so parse
 * defensively), and the obvious `entity_id = :vendorId` filter misses more than
 * it catches.
 */

import {
  AdminVendorAuditQuerySchema,
  AdminVendorAuditResponseSchema,
  AdminVendorDetailSchema,
  AdminVendorsListQuerySchema,
  AdminVendorsListResponseSchema,
  ApiErrorCode,
  type AdminAuditRow,
  type AdminVendorAuditResponse,
  type AdminVendorAuditScope,
  type AdminVendorClaimCounts,
  type AdminVendorDetail,
  type AdminVendorRow,
  type AdminVendorSeatRow,
  type AdminVendorsListResponse,
  type VendorEntitlementResponse,
  type VendorSeatInvite,
} from '@aeci/shared';
import { forwardAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import { and, asc, count, desc, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  auditLog,
  connectorEvidencedPairs,
  integrations,
  profiles,
  vendorEntitlements,
  vendorRequests,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import type { BatchTuple } from '../lib/audit';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { vendorListConfig } from '../lib/drizzle-helpers';
import { resolveVendorOrderBy } from '../lib/sort';
import { likeContains } from '../lib/sql-like';
import { fetchAuthUserEmailsResult, type AuthEmailLookup } from '../lib/supabase-admin';
import { revokeSeatStatements } from '../lib/vendor-grant';
import {
  EMPTY_PRODUCT_ROLES,
  foldProductRoleGroups,
  isPureConnectorVendor,
  productRolesForVendor,
  selectProductRoleGroups,
} from '../lib/vendor-product-roles';
import { pendingInvitesFor } from '../lib/vendor-seat-invites';
import { logToPosthog } from '../posthog';
import { ownedProductIds, seatsOf, vendorRequestsWhere } from './vendor-shared';

type AdminVendorContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** Injected email seam, in the availability-reporting form (AECI-652). The
 *  bare-map `fetchAuthUserEmails` cannot tell "the seam is down" from "this
 *  account has no address", and this surface has to. */
export type FetchAuthEmails = (env: Env, ids: readonly string[]) => Promise<AuthEmailLookup>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requiredParam(c: AdminVendorContext, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, `Missing ${name}`, { field: name });
  }
  return value;
}

function parseQuery<T>(c: AdminVendorContext, schema: { parse: (input: unknown) => T }): T {
  return schema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
}

/** Telemetry forwarder for the revoke's audit row. Tagged `admin-moderation`,
 *  matching `admin-claims.ts` — the tag is what separates an AECi-side revoke
 *  from the vendor's own in the trail, since `actor_type` is `'admin'` here but
 *  `'user'` for both a reviewer and a vendor admin elsewhere. */
function makeForwarder(c: AdminVendorContext): AuditLogForwarder | undefined {
  if (!c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'admin-moderation',
    });
  };
}

/** Map a joined `vendor_entitlements` row → the wire readout. Same field-by-field
 *  shape as `loadClaimEntitlements`; `verified` is the vendor's mirror, reported
 *  as-is rather than derived, so drift is visible instead of papered over. */
function toEntitlement(
  vendorId: string,
  verified: boolean,
  row: typeof vendorEntitlements.$inferSelect | null,
): VendorEntitlementResponse | null {
  if (!row) return null;
  return {
    vendor_id: vendorId,
    tier: row.tier as VendorEntitlementResponse['tier'],
    status: row.status as VendorEntitlementResponse['status'],
    period_start: row.periodStart,
    period_end: row.periodEnd,
    granted_at: row.grantedAt,
    ended_at: row.endedAt,
    verified,
    payer: row.payer,
    amount: row.amount,
    terms: row.terms,
    arranged_by: row.arrangedBy,
    invoice_ref: row.invoiceRef,
    notes: row.notes,
  };
}

// ─── GET /api/admin/vendors ──────────────────────────────────────────────────

/**
 * The vendor list.
 *
 * A plain `db.select().leftJoin()`, deliberately NOT the relational builder:
 * `vendorEntitlements` has no `relations()` entry (that is load-bearing — it is
 * what stops a public read config growing a `with: { entitlement: true }`), so
 * the join is the only way to get tier/status alongside the vendor. It cannot
 * multiply rows — `vendor_entitlements_vendor_key` is UNIQUE on `vendor_id`.
 *
 * The per-row counts are `vendorListConfig.extras` verbatim: correlated scalar
 * subqueries that the public `/api/vendors` already ships on a 100-row page. They
 * qualify the outer column as `"vendors"."id"` precisely so a subquery's own `id`
 * cannot shadow it, which is why they drop into a plain select unchanged.
 *
 * The `count()` statement takes no join because every filter is on `vendors`.
 * Adding a tier/status filter later would have to add it there too — the two
 * predicates must stay identical or `total` stops describing `data`.
 */
export function createAdminVendorsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminVendorContext) => Promise<Response> {
  return async (c) => {
    const query = parseQuery(c, AdminVendorsListQuerySchema);
    const { db } = dbFor(c.env);

    const search = query.search?.trim();
    const where = and(
      search
        ? or(likeContains(vendors.companyName, search), likeContains(vendors.slug, search))
        : undefined,
      query.verified === undefined ? undefined : eq(vendors.verified, query.verified),
    );

    const [rows, totals] = await db.batch([
      db
        .select({
          id: vendors.id,
          slug: vendors.slug,
          companyName: vendors.companyName,
          verified: vendors.verified,
          updatedAt: vendors.updatedAt,
          tier: vendorEntitlements.tier,
          status: vendorEntitlements.status,
          periodEnd: vendorEntitlements.periodEnd,
          productCount: vendorListConfig.extras.productCount,
          integrationCount: vendorListConfig.extras.integrationCount,
        })
        .from(vendors)
        .leftJoin(vendorEntitlements, eq(vendorEntitlements.vendorId, vendors.id))
        .where(where)
        .orderBy(...resolveVendorOrderBy(query.sort))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(vendors).where(where),
    ]);

    const body: AdminVendorsListResponse = {
      data: rows.map(
        (row): AdminVendorRow => ({
          id: row.id,
          slug: row.slug,
          company_name: row.companyName,
          verified: row.verified,
          tier: (row.tier as AdminVendorRow['tier']) ?? null,
          status: (row.status as AdminVendorRow['status']) ?? null,
          period_end: row.periodEnd ?? null,
          product_count: Number(row.productCount ?? 0),
          integration_count: Number(row.integrationCount ?? 0),
          updated_at: row.updatedAt,
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      AdminVendorsListResponseSchema.parse(body);
    });
    return json(body);
  };
}

// ─── GET /api/admin/vendors/:id ──────────────────────────────────────────────

const EMPTY_CLAIM_COUNTS: AdminVendorClaimCounts = {
  open: 0,
  in_review: 0,
  resolved: 0,
  rejected: 0,
};

/**
 * The vendor detail.
 *
 * **Two D1 round trips, not seven.** The first is the 404 gate — nothing may be
 * reported about a vendor that does not exist. The second is one `db.batch` of
 * six reads: the batch is the round-trip tool here, not an atomicity one (the
 * same use `GET /api/vendor/updates` documents). It is deliberately NOT a
 * `UNION` — D1 compiles SQLite with `SQLITE_MAX_COMPOUND_SELECT = 5`, which the
 * admin System screen already got bitten by, and a batch has no such ceiling.
 *
 * Claim counts group by status and cover **all four** values the CHECK allows,
 * including `in_review`. Three would give an operator numbers that quietly fail
 * to sum — a bug the `/admin/claims` filter still has.
 */
export function createAdminVendorDetailHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthEmails = fetchAuthUserEmailsResult,
): (c: AdminVendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = requiredParam(c, 'id');
    const { db } = dbFor(c.env);

    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    // LEFT-joined for the invite's sender name: the FK is ON DELETE SET NULL, so
    // an invite outlives the account that sent it and an inner join would drop it.
    const invitedBy = alias(profiles, 'invited_by_profile');
    const now = new Date().toISOString();

    const [
      entitlementRows,
      seatRows,
      inviteRows,
      productRoleGroups,
      integrationCounts,
      evidencedCounts,
      claimRows,
    ] = await db.batch([
      db.select().from(vendorEntitlements).where(eq(vendorEntitlements.vendorId, vendorId)),
      db
        .select({
          id: profiles.id,
          displayName: profiles.displayName,
          role: profiles.role,
          workEmailVerified: profiles.workEmailVerified,
          seatOwner: profiles.seatOwner,
          bannedAt: profiles.bannedAt,
          createdAt: profiles.createdAt,
        })
        .from(profiles)
        .where(seatsOf(vendorId))
        .orderBy(asc(profiles.createdAt)),
      // The expiry filter is in SQL because `pendingInvitesFor` covers only the
      // two terminal columns — an invite that merely aged out is still
      // `accepted_at IS NULL AND revoked_at IS NULL`, and showing it as pending
      // would misreport the account's live invitations.
      db
        .select({
          id: vendorSeatInvites.id,
          email: vendorSeatInvites.email,
          expiresAt: vendorSeatInvites.expiresAt,
          createdAt: vendorSeatInvites.createdAt,
          invitedByName: invitedBy.displayName,
        })
        .from(vendorSeatInvites)
        .leftJoin(invitedBy, eq(invitedBy.id, vendorSeatInvites.invitedById))
        .where(and(pendingInvitesFor(vendorId), gt(vendorSeatInvites.expiresAt, now)))
        .orderBy(asc(vendorSeatInvites.createdAt)),
      // `product_count` AND the §5.2 role breakdown out of ONE grouped read
      // (AECI-738). Deliberately not a `count()` beside a `GROUP BY`: two
      // statements answering the same question is how `STAGE_1_5_SPEC.md` §13.5
      // items 11/12 got two drifting copies of one operator number. The join
      // cannot undercount the old bare count — `product_vendors.product_id` is
      // `ON DELETE CASCADE` against `products`, so no ownership row is orphaned.
      selectProductRoleGroups(db, productRolesForVendor(vendorId)),
      // The vendor-detail `integration_count` — the third copy of the
      // `built_by_vendor_id` rule (AECI-721 / §13.5 item 6, which names only the
      // two Algolia copies). Written as a where-clause rather than a correlated
      // subquery, but the same rule, so it needs the same second table: an
      // operator opening Agave's vendor page must not read 0 while its product
      // page renders twelve pairs.
      db
        .select({ value: count() })
        .from(integrations)
        .where(eq(integrations.builtByVendorId, vendorId)),
      db
        .select({ value: count() })
        .from(connectorEvidencedPairs)
        .where(eq(connectorEvidencedPairs.builtByVendorId, vendorId)),
      db
        .select({ status: vendorRequests.status, value: count() })
        .from(vendorRequests)
        .where(
          and(
            eq(vendorRequests.kind, 'claim'),
            vendorRequestsWhere(vendorId, ownedProductIds(db, vendorId)),
          ),
        )
        .groupBy(vendorRequests.status),
    ]);

    // One bounded GoTrue fan-out, AFTER the batch so it never widens the D1 hop.
    const lookup = await fetchEmails(
      c.env,
      seatRows.map((row) => row.id),
    );

    // One vendor in, so at most one entry out; absent = owns no products, which
    // folds to the zeroed breakdown (unknown, NOT exempt — §8.8(1)).
    const productRoles = foldProductRoleGroups(productRoleGroups).get(vendorId) ?? {
      ...EMPTY_PRODUCT_ROLES,
    };

    const claimCounts: AdminVendorClaimCounts = { ...EMPTY_CLAIM_COUNTS };
    for (const row of claimRows) {
      if (row.status in claimCounts) {
        claimCounts[row.status as keyof AdminVendorClaimCounts] = row.value;
      }
    }

    const body: AdminVendorDetail = {
      id: vendor.id,
      slug: vendor.slug,
      company_name: vendor.companyName,
      description: vendor.description,
      website: vendor.website,
      headquarters: vendor.headquarters,
      logo_url: vendor.logoUrl,
      verified: vendor.verified,
      promotion_status: vendor.promotionStatus,
      maintained_by: vendor.maintainedBy,
      last_reviewed_at: vendor.lastReviewedAt,
      created_at: vendor.createdAt,
      updated_at: vendor.updatedAt,
      entitlement: toEntitlement(vendor.id, vendor.verified, entitlementRows[0] ?? null),
      seats: seatRows.map(
        (row): AdminVendorSeatRow => ({
          user_id: row.id,
          display_name: row.displayName,
          email: lookup.emails.get(row.id) ?? null,
          role: row.role,
          work_email_verified: row.workEmailVerified,
          banned: row.bannedAt !== null,
          owner: row.seatOwner,
          created_at: row.createdAt,
        }),
      ),
      seat_emails_available: lookup.available,
      pending_invites: inviteRows.map(
        (row): VendorSeatInvite => ({
          id: row.id,
          email: row.email,
          invited_by: row.invitedByName,
          expires_at: row.expiresAt,
          created_at: row.createdAt,
        }),
      ),
      product_count: productRoles.total,
      product_roles: productRoles,
      is_pure_connector_vendor: isPureConnectorVendor(productRoles),
      integration_count: (integrationCounts[0]?.value ?? 0) + (evidencedCounts[0]?.value ?? 0),
      claim_counts: claimCounts,
    };

    validateResponseInDev(c.env, () => {
      AdminVendorDetailSchema.parse(body);
    });
    return json(body);
  };
}

// ─── GET /api/admin/vendors/:id/audit ────────────────────────────────────────

/**
 * `entity_type` values whose `entity_id` IS a vendor id.
 *
 * `vendor_entitlement` belongs here and the pairing is not obvious: its
 * `entity_id` is the VENDOR id, never the entitlement row id, precisely so a
 * clear-and-re-grant does not fragment the trail a renewal dispute needs to read
 * (`STAGE_2_PAID_TIERS_SPEC.md` §2.1). That decision is what makes this leg work.
 */
const VENDOR_ENTITY_TYPES = ['vendor', 'vendor_entitlement'] as const;

/**
 * Actions whose audit row carries `metadata.vendor_id` but files under some other
 * entity — a request id, an invite id, or a seat's user id.
 *
 * `vendor_claim.seat_revoked` is the one that justifies the whole leg. It files
 * under `entity_type='profile'` with the seat's user id, and by the time anyone
 * reads it that profile no longer has `vendor_id` set — the revoke nulled it. So
 * it is reachable neither by the entity legs nor by the actor scope, and it is
 * exactly the row an operator asking "why did this vendor lose access?" wants.
 */
const VENDOR_METADATA_ACTIONS = [
  'vendor_claim.granted',
  'vendor_claim.seat_revoked',
  'vendor_seat.invited',
  'vendor_seat.invite_revoked',
  'vendor_seat.invite_accepted',
] as const;

/**
 * Ban/unban actions that file under `entity_type='profile'` with a SEAT's user id
 * and carry NO `metadata.vendor_id` (`admin-reviewers.ts` builds the metadata as
 * `{ source, reason? }`). They are reached via the current seat roster rather than
 * the JSON path: a ban is a per-seat lock that does NOT null `vendor_id`, so a
 * currently-seated banned profile is still in {@link seatsOf}. Without this leg
 * the audit tab is silent about a ban the seat roster is actively showing — an
 * operator asking "why can this colleague not sign in?" would find nothing.
 *
 * A seat banned and LATER revoked drops out (the revoke nulls `vendor_id`), but
 * its own `vendor_claim.seat_revoked` row stays reachable via leg 3 — so "lost
 * access" is never lost, only the intermediate ban's own row is, in that one
 * ordering. Widening the ban writer to stamp `metadata.vendor_id` would be the
 * alternative; a roster subquery is retroactive over rows already written, which
 * the writer change is not (the same reasoning §5.6.2 gives for legs 2 and 3).
 */
const VENDOR_SEAT_PROFILE_ACTIONS = ['vendor_admin.banned', 'vendor_admin.unbanned'] as const;

/**
 * The `WHERE` for one audit scope.
 *
 * **Entity scope is four OR'd disjuncts, not one**, and each is load-bearing:
 *
 *  1. `entity_type IN (...) AND entity_id = :vendorId` — the obvious one. Serves
 *     `vendor.created/.updated`, `promote.blocked`, and the whole
 *     `vendor_entitlement.*` ledger, off `audit_log_entity_idx`.
 *  2. `entity_type='vendor_request' AND entity_id IN (<the vendor's claims>)` —
 *     because `rejectClaimStatements` builds its metadata with
 *     `claimMetadata(p, {})`, which emits NO `vendor_id` (and `RejectClaimParams`
 *     does not even carry one). Widening that writer would fix only rows written
 *     after the deploy; a subquery over `vendor_requests` is retroactive, and it
 *     reuses `vendorRequestsWhere`, which already handles the vendor-arm /
 *     product-arm split — a product claim's `target_id` is a PRODUCT id, so a
 *     naive `target_type='vendor'` test would miss it.
 *  3. `action IN (...) AND json_extract(metadata,'$.vendor_id') = :vendorId` —
 *     for the rows that file under a profile or an invite. See
 *     {@link VENDOR_METADATA_ACTIONS}.
 *  4. `action IN ('vendor_admin.banned', ...) AND entity_id IN (<the vendor's
 *     seats>)` — the ban/unban rows, which file under `entity_type='profile'`
 *     with the seat's user id and carry no `metadata.vendor_id`, so none of legs
 *     1–3 reach them. Matched through the current seat roster instead. See
 *     {@link VENDOR_SEAT_PROFILE_ACTIONS}.
 *
 * **Actor scope is a subquery, not a resolved id list.** `ID_CHUNK` /
 * `SEAT_LOOKUP_CHUNK` exist elsewhere because D1 caps BOUND PARAMETERS per query
 * — not statements — so an id set that SQL can derive belongs in SQL. As a
 * subquery there is no cap to hit, no chunking (which would break a single
 * `ORDER BY … LIMIT/OFFSET` anyway), and no extra round trip. Both partial
 * indexes still apply: SQLite proves `actor_id IS NOT NULL` from the `IN`.
 *
 * Cost note for whoever reads this next: leg 3 walks every row carrying one of
 * those five actions before the JSON test filters it. That scales with
 * claim/seat volume, not with the size of `audit_log` — which matters, because
 * `audit_log` is hard-excluded from the retention prune and only ever grows.
 */
function auditScopeWhere(db: Db, vendorId: string, scope: AdminVendorAuditScope): SQL | undefined {
  const entity = or(
    and(inArray(auditLog.entityType, [...VENDOR_ENTITY_TYPES]), eq(auditLog.entityId, vendorId)),
    and(
      eq(auditLog.entityType, 'vendor_request'),
      inArray(
        auditLog.entityId,
        db
          .select({ id: vendorRequests.id })
          .from(vendorRequests)
          .where(vendorRequestsWhere(vendorId, ownedProductIds(db, vendorId))),
      ),
    ),
    and(
      inArray(auditLog.action, [...VENDOR_METADATA_ACTIONS]),
      sql`json_extract(${auditLog.metadata}, '$.vendor_id') = ${vendorId}`,
    ),
    and(
      inArray(auditLog.action, [...VENDOR_SEAT_PROFILE_ACTIONS]),
      inArray(
        auditLog.entityId,
        db.select({ id: profiles.id }).from(profiles).where(seatsOf(vendorId)),
      ),
    ),
  );

  const actor = inArray(
    auditLog.actorId,
    db.select({ id: profiles.id }).from(profiles).where(seatsOf(vendorId)),
  );

  switch (scope) {
    case 'entity':
      return entity;
    case 'actor':
      return actor;
    default:
      return or(entity, actor);
  }
}

/**
 * The audit viewer.
 *
 * Ordered `created_at DESC, id DESC`. The tiebreaker is not decoration:
 * `created_at` is an ISO-8601 string stamped in JS, and two rows written by one
 * `db.batch` routinely share a millisecond — without a second key the page
 * boundary is unstable and a row can appear twice or not at all. `audit_log.id`
 * is a UUID so it is not chronological, but it is a stable total order, which is
 * all pagination needs.
 *
 * **Renders tolerantly.** These rows outlive the code that wrote them (nothing
 * prunes this table), `before_state`/`after_state` are free-form JSON with no
 * shared contract, and `entity_type` carries no CHECK. So the wire types are
 * `unknown`/`string` and nothing here narrows or validates them — the same
 * discipline `vendor-notifications.ts` applies for the same reason. A shape this
 * code has never seen must render as what it is, not 500 the screen.
 */
export function createAdminVendorAuditHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthEmails = fetchAuthUserEmailsResult,
): (c: AdminVendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = requiredParam(c, 'id');
    const query = parseQuery(c, AdminVendorAuditQuerySchema);
    const { db } = dbFor(c.env);

    // The 404 gate. Without it an unknown id returns an empty, successful page,
    // which reads as "this vendor has no history" rather than "no such vendor".
    const exists = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, vendorId),
    });
    if (!exists) throw notFoundError('vendor', { id: vendorId });

    const where = auditScopeWhere(db, vendorId, query.scope);

    const [rows, totals] = await db.batch([
      db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          actorId: auditLog.actorId,
          actorType: auditLog.actorType,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          beforeState: auditLog.beforeState,
          afterState: auditLog.afterState,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(auditLog).where(where),
    ]);

    // Actor hydration is scoped to THIS PAGE's actors, so the id list is bounded
    // by `perPage` (≤ 100) rather than by how much history the vendor has.
    const actorIds = [
      ...new Set(rows.map((row) => row.actorId).filter((id): id is string => !!id)),
    ];
    const [actorRows, lookup] = await Promise.all([
      actorIds.length === 0
        ? Promise.resolve([] as { id: string; displayName: string | null }[])
        : db
            .select({ id: profiles.id, displayName: profiles.displayName })
            .from(profiles)
            .where(inArray(profiles.id, actorIds)),
      fetchEmails(c.env, actorIds),
    ]);
    const namesById = new Map(actorRows.map((row) => [row.id, row.displayName]));

    const body: AdminVendorAuditResponse = {
      data: rows.map(
        (row): AdminAuditRow => ({
          id: row.id,
          action: row.action,
          // A `system`/`workflow` row (cron, the promote Workflow) has no actor
          // id at all — `null` here means "not a person", not "person unknown".
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
      AdminVendorAuditResponseSchema.parse(body);
    });
    return json(body);
  };
}

// ─── DELETE /api/admin/vendors/:id/seats/:userId ─────────────────────────────

/**
 * Revoke one seat, AECi-side.
 *
 * A near-clone of the vendor portal's `DELETE /api/vendor/seats/:userId`
 * (`vendor-seat-invites.ts`) with three deliberate differences:
 *
 *  - **`vendorId` comes from the path**, not a session, and the target profile
 *    read is scoped to it — so a stray seat cannot be un-granted by naming the
 *    wrong vendor.
 *  - **No self-removal guard.** An admin holds no seat; the case cannot arise.
 *  - **No last-owner guard.** The portal refuses to remove the final owner
 *    because a vendor cannot self-rescue from an unadministrable account and
 *    "only an AECi grant can rescue it". The admin IS that rescue, so the guard
 *    would only block the operator who exists to undo it. The UI says so.
 *
 * The revoke composes {@link revokeSeatStatements} unchanged, which means: the
 * `vendor_claim.seat_revoked` row lands in the SAME `db.batch` as the profile
 * write (§26.1), the metadata already carries `vendor_id` (so the audit viewer's
 * leg 3 finds it after the profile's own `vendor_id` is gone), and **no statement
 * names `vendors`** — a revoke deliberately leaves the entitlement, the mirror
 * and the badge alone. Clearing an entitlement and revoking a seat are
 * orthogonal actions (§5.2) and this endpoint is only the second one.
 *
 * No cache purge: nothing a seat revoke changes is rendered on a cached page.
 */
export function createAdminRevokeSeatHandler(
  dbFor: DbFactory = getDb,
): (c: AdminVendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = requiredParam(c, 'id');
    const targetId = requiredParam(c, 'userId');
    const auth = c.get('auth');
    const { db } = writeDb(c, dbFor);

    const vendor = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    const target = await db.query.profiles.findFirst({
      columns: { id: true, role: true, vendorId: true },
      where: and(eq(profiles.id, targetId), seatsOf(vendorId)),
    });
    if (!target) throw notFoundError('profile', { id: targetId });

    const batch = revokeSeatStatements(db, {
      userId: targetId,
      vendorId,
      actorId: auth.userId,
      actorType: auditActorType(auth),
      now: new Date().toISOString(),
      profileBefore: { role: target.role, vendorId: target.vendorId },
    });

    await db.batch(batch.stmts as BatchTuple);
    c.executionCtx.waitUntil(forwardAuditLog(batch.auditEntry, makeForwarder(c)));

    return new Response(null, { status: 204 });
  };
}
