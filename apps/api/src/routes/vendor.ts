/**
 * Vendor portal API (`/api/vendor/*`, AECI-520 / Stage 2) — Drizzle/D1.
 *
 *   GET   /api/vendor/me           — the dashboard payload (vendor + owned
 *                                    products + request status + seat count).
 *   PATCH /api/vendor/profile      — edit the caller's own vendor row.
 *   PATCH /api/vendor/products/:id — edit one product the caller's vendor owns.
 *   GET   /api/vendor/seats        — the seat roster (read-only at launch).
 *
 * Source of truth: `STAGE_2_VENDOR_PORTAL_SPEC.md` §4, `API_CONTRACTS.md` §6.14.
 *
 * ── The scoping invariant ────────────────────────────────────────────────────
 * There is no RLS on app tables (ADR 0016) — the `requireVendor()` guard plus
 * the `vendor_id` filter in every query here IS the authorization. So:
 *
 *   - `vendorId` comes from `c.get('auth')`, never from the request. Nothing in
 *     the `/api/vendor/*` contract even carries a vendor id.
 *   - The one client-supplied id on this surface (`PATCH /products/:id`) is
 *     checked for ownership against the session's vendor BEFORE anything is
 *     read or written, and a miss is a **404, not a 403** — a non-owner must not
 *     learn that the product exists.
 *
 * ── Write mechanics ─────────────────────────────────────────────────────────
 * Every write is one `db.batch([...])` carrying the UPDATE, any taxonomy join
 * rewrite, and its `audit_log` row (the §26.1 invariant — D1 has no interactive
 * transactions). The Datadog forward and the Cache-Tag purge run post-commit in
 * `waitUntil`.
 *
 * Vendor edits deliberately do NOT trigger an Algolia reindex: they reach search
 * on the nightly watermark sync (≤24h) while SSR refreshes immediately via the
 * purge (`STAGE_2_VENDOR_PORTAL_SPEC.md` §8.2 / `STAGE_2_SPEC.md` §8.3(5)). The
 * dashboard copy must not promise "live in search".
 */

import {
  ListVendorSeatsResponseSchema,
  UpdateVendorProductResponseSchema,
  UpdateVendorProductSchema,
  UpdateVendorProfileResponseSchema,
  UpdateVendorProfileSchema,
  VendorMeResponseSchema,
  type ListVendorSeatsResponse,
  type UpdateVendorProductResponse,
  type UpdateVendorProfileResponse,
  type VendorAccount,
  type VendorMeResponse,
  type VendorProduct,
  type VendorRequestSummary,
  type VendorSeat,
} from '@aeci/shared';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import {
  productAudiences,
  productCategories,
  productPhases,
  productVendors,
  products,
  profiles,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  vendorRequests,
  vendors,
} from '../db/schema';
import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { fetchAuthUserEmails } from '../lib/supabase-admin';

type VendorContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** Injected seat-email seam. Default hits the GoTrue Admin API; returns an empty
 *  map (→ `email: null`) when the service-role key is absent. */
export type FetchSeatEmails = (
  env: Env,
  userIds: readonly string[],
) => Promise<Map<string, string>>;

/** `metadata.source` on every audit row this module writes. Distinguishes a
 *  vendor's self-service edit from the AECi-side `product.updated` /
 *  `vendor.updated` that `POST /api/promote` and the admin surfaces emit — the
 *  actor_type is `'user'` for both a reviewer and a vendor admin, so this tag is
 *  what makes the audit trail legible. */
const AUDIT_SOURCE = 'vendor-portal';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The session's vendor id. `requireVendor()` guarantees it is non-null, so a
 *  miss here means the guard was not mounted — fail loudly rather than fall
 *  back to something that would read another vendor's rows. */
/**
 * "The seats on this vendor" — a granted vendor-portal seat is a `profiles` row
 * with BOTH `vendor_id = <vendor>` and `role = 'vendor_admin'`. Shared by the
 * dashboard's `seat_count` and the roster so the two can never disagree: a
 * `reviewer` profile that happens to carry a `vendor_id` is not a seat.
 */
function seatsOf(vendorId: string) {
  return and(eq(profiles.vendorId, vendorId), eq(profiles.role, VENDOR_ADMIN_ROLE));
}

function sessionVendorId(c: VendorContext): string {
  const vendorId = c.get('auth').vendorId;
  if (!vendorId) {
    throw new ApiError(403, 'FORBIDDEN', 'Vendor account is not linked to a vendor');
  }
  return vendorId;
}

function makeForwarder(c: VendorContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: AUDIT_SOURCE,
    });
  };
}

async function parseJsonBody<T>(c: VendorContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

/**
 * Enqueue the Cache-Tag purge for an edited entity (WC-5 / ADR 0020 §3). The SSR
 * consumer issues the actual `ctx.cache.purge()`. Best-effort by design: no-ops
 * without the queue binding (local / PR preview) and a `queue.send` rejection is
 * logged and swallowed — a cache miss must never fail a committed edit.
 *
 * One tag is enough in both cases because of the `CACHE_STRATEGY.md` §3 embedded
 * -entity rule: browse and index pages tag every product they list, so a taxonomy
 * re-assignment is covered by `product:{slug}` on both the old and the new browse
 * page; and a product detail page tags its vendor, so `vendor:{slug}` repaints
 * every page showing that vendor.
 */
async function purgeTag(c: VendorContext, tag: string): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue) return;
  try {
    await queue.send({ tags: [tag], source: 'vendor' });
  } catch (error) {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Cache purge enqueue failed for ${tag}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── Row → wire mappers ──────────────────────────────────────────────────────

type VendorRow = typeof vendors.$inferSelect;
type ProductRow = typeof products.$inferSelect;

function toVendorAccount(row: VendorRow): VendorAccount {
  return {
    id: row.id,
    slug: row.slug,
    company_name: row.companyName,
    verified: row.verified,
    description: row.description,
    website: row.website,
    headquarters: row.headquarters,
    founded_year: row.foundedYear,
    public_private: row.publicPrivate as VendorAccount['public_private'],
    parent_company: row.parentCompany,
    contact_email: row.contactEmail,
    phone_number: row.phoneNumber,
    logo_url: row.logoUrl,
    linkedin_url: row.linkedinUrl,
    x_url: row.xUrl,
    facebook_url: row.facebookUrl,
    instagram_url: row.instagramUrl,
    youtube_url: row.youtubeUrl,
    crunchbase_url: row.crunchbaseUrl,
    wiki_url: row.wikiUrl,
    github_org: row.githubOrg,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

type TaxonomySlugs = { categories: string[]; audiences: string[]; phases: string[] };

function toVendorProduct(row: ProductRow, isPrimary: boolean, tax: TaxonomySlugs): VendorProduct {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    is_primary: isPrimary,
    description: row.description,
    website: row.website,
    tool_integrations_url: row.toolIntegrationsUrl,
    api_docs_url: row.apiDocsUrl,
    logo_url: row.logoUrl,
    category_slugs: tax.categories,
    audience_slugs: tax.audiences,
    phase_slugs: tax.phases,
    product_role: row.productRole,
    integration_count: row.integrationCount,
    review_count: row.reviewCount,
    updated_at: row.updatedAt,
  };
}

/**
 * Read the taxonomy slugs for a set of products in three queries (one per facet)
 * rather than 3×N. Returns a per-product bucket so both the dashboard list and a
 * single-product PATCH response can use it.
 */
async function loadTaxonomySlugs(
  db: Db,
  productIds: readonly string[],
): Promise<Map<string, TaxonomySlugs>> {
  const buckets = new Map<string, TaxonomySlugs>(
    productIds.map((id) => [id, { categories: [], audiences: [], phases: [] }]),
  );
  if (productIds.length === 0) return buckets;

  const [cats, auds, phs] = await Promise.all([
    db
      .select({ productId: productCategories.productId, slug: taxonomyCategories.slug })
      .from(productCategories)
      .innerJoin(taxonomyCategories, eq(productCategories.categoryId, taxonomyCategories.id))
      .where(inArray(productCategories.productId, [...productIds]))
      .orderBy(asc(taxonomyCategories.slug)),
    db
      .select({ productId: productAudiences.productId, slug: taxonomyAudiences.slug })
      .from(productAudiences)
      .innerJoin(taxonomyAudiences, eq(productAudiences.audienceId, taxonomyAudiences.id))
      .where(inArray(productAudiences.productId, [...productIds]))
      .orderBy(asc(taxonomyAudiences.slug)),
    db
      .select({ productId: productPhases.productId, slug: taxonomyPhases.slug })
      .from(productPhases)
      .innerJoin(taxonomyPhases, eq(productPhases.phaseId, taxonomyPhases.id))
      .where(inArray(productPhases.productId, [...productIds]))
      .orderBy(asc(taxonomyPhases.slug)),
  ]);

  for (const row of cats) buckets.get(row.productId)?.categories.push(row.slug);
  for (const row of auds) buckets.get(row.productId)?.audiences.push(row.slug);
  for (const row of phs) buckets.get(row.productId)?.phases.push(row.slug);
  return buckets;
}

/** Empty-set fallback so a product with no taxonomy still maps cleanly. */
const NO_TAXONOMY: TaxonomySlugs = { categories: [], audiences: [], phases: [] };

/**
 * Resolve requested term slugs to ids, rejecting any that don't exist.
 *
 * Vendors ASSIGN taxonomy; they don't MINT it (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6 guard-rails). Silently dropping an unknown slug would leave the vendor
 * believing an edit landed, so it is a `VALIDATION_FAILED` keyed to the field.
 */
async function resolveTermIds(
  db: Db,
  table: typeof taxonomyCategories | typeof taxonomyAudiences | typeof taxonomyPhases,
  slugs: readonly string[],
  field: string,
): Promise<string[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ id: table.id, slug: table.slug })
    .from(table)
    .where(inArray(table.slug, [...slugs]));

  const bySlug = new Map(rows.map((row) => [row.slug, row.id]));
  const unknown = slugs.filter((slug) => !bySlug.has(slug));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      'VALIDATION_FAILED',
      `Unknown taxonomy term(s): ${[...new Set(unknown)].sort().join(', ')}`,
      { field },
    );
  }
  // Dedupe while preserving the caller's order.
  return [...new Set(slugs)].map((slug) => bySlug.get(slug) as string);
}

/**
 * Split a validated PATCH body into the column patch and the taxonomy patch.
 *
 * Zod omits absent optional keys from its output, so `Object.entries` yields
 * exactly the fields the caller sent — which is what makes "absent leaves the
 * column alone, explicit `null` clears it" work.
 */
function splitPatch<T extends Record<string, unknown>>(
  body: T,
  columnMap: Record<string, string>,
): { columns: Record<string, unknown>; provided: string[] } {
  const columns: Record<string, unknown> = {};
  const provided: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const column = columnMap[key];
    if (column === undefined) continue; // taxonomy keys, handled separately
    columns[column] = value;
    provided.push(key);
  }
  return { columns, provided };
}

// ─── GET /api/vendor/me ──────────────────────────────────────────────────────

export function createVendorMeHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    // A granted seat whose vendor row has since been deleted. 404 rather than
    // 500: there is nothing to show, and the dashboard renders its empty state.
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    const owned = await db
      .select({ productId: productVendors.productId, isPrimary: productVendors.isPrimary })
      .from(productVendors)
      .where(eq(productVendors.vendorId, vendorId));

    const productIds = owned.map((row) => row.productId);
    const primaryById = new Map(owned.map((row) => [row.productId, row.isPrimary]));

    const [productRows, taxonomy, seatRows, requestRows] = await Promise.all([
      productIds.length
        ? db.query.products.findMany({
            where: inArray(products.id, productIds),
            orderBy: [asc(products.name)],
          })
        : Promise.resolve([]),
      loadTaxonomySlugs(db, productIds),
      // Must use the SAME predicate as `GET /api/vendor/seats`, or the dashboard
      // reports a seat count the roster can't account for — a `reviewer` profile
      // pointing at this vendor is not a seat.
      db.select({ id: profiles.id }).from(profiles).where(seatsOf(vendorId)),
      // The vendor's own claim/correction requests: those targeting the vendor
      // itself, plus those targeting any product it owns.
      db.query.vendorRequests.findMany({
        where: or(
          and(eq(vendorRequests.targetType, 'vendor'), eq(vendorRequests.targetId, vendorId)),
          productIds.length
            ? and(
                eq(vendorRequests.targetType, 'product'),
                inArray(vendorRequests.targetId, productIds),
              )
            : undefined,
        ),
        orderBy: [asc(vendorRequests.createdAt)],
      }),
    ]);

    const body: VendorMeResponse = {
      vendor: toVendorAccount(vendor),
      products: productRows.map((row) =>
        toVendorProduct(row, primaryById.get(row.id) ?? false, taxonomy.get(row.id) ?? NO_TAXONOMY),
      ),
      requests: requestRows.map(
        (row): VendorRequestSummary => ({
          id: row.id,
          kind: row.kind as VendorRequestSummary['kind'],
          target_type: row.targetType as VendorRequestSummary['target_type'],
          target_id: row.targetId,
          status: row.status as VendorRequestSummary['status'],
          created_at: row.createdAt,
          resolved_at: row.resolvedAt,
        }),
      ),
      // The caller is a seat, so this is ≥ 1 by construction.
      seat_count: Math.max(seatRows.length, 1),
    };

    validateResponseInDev(c.env, () => VendorMeResponseSchema.parse(body));
    return json(body);
  };
}

// ─── GET /api/vendor/seats ───────────────────────────────────────────────────

export function createVendorSeatsHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchSeatEmails = fetchAuthUserEmails,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    const rows = await db.query.profiles.findMany({
      columns: { id: true, displayName: true, bannedAt: true, createdAt: true },
      where: seatsOf(vendorId),
      orderBy: [asc(profiles.createdAt)],
    });

    // Degrades to `email: null` when SUPABASE_SERVICE_ROLE_KEY is absent — the
    // roster must stay usable in local dev and PR previews, never 500.
    const emails = await fetchEmails(
      c.env,
      rows.map((row) => row.id),
    );

    const body: ListVendorSeatsResponse = {
      seats: rows.map(
        (row): VendorSeat => ({
          user_id: row.id,
          display_name: row.displayName,
          email: emails.get(row.id) ?? null,
          banned: row.bannedAt !== null,
          created_at: row.createdAt,
        }),
      ),
    };

    validateResponseInDev(c.env, () => ListVendorSeatsResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/vendor/profile ───────────────────────────────────────────────

/** Wire field → `vendors` column. The map IS the allow-list on the write side;
 *  the Zod schema is the allow-list on the parse side. Both must agree. */
const VENDOR_COLUMN_MAP: Record<string, string> = {
  description: 'description',
  website: 'website',
  headquarters: 'headquarters',
  founded_year: 'foundedYear',
  public_private: 'publicPrivate',
  parent_company: 'parentCompany',
  contact_email: 'contactEmail',
  phone_number: 'phoneNumber',
  logo_url: 'logoUrl',
  linkedin_url: 'linkedinUrl',
  x_url: 'xUrl',
  facebook_url: 'facebookUrl',
  instagram_url: 'instagramUrl',
  youtube_url: 'youtubeUrl',
  crunchbase_url: 'crunchbaseUrl',
  wiki_url: 'wikiUrl',
  github_org: 'githubOrg',
};

export function createUpdateVendorProfileHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const payload = await parseJsonBody(c, UpdateVendorProfileSchema);

    const { db } = writeDb(c, dbFor);
    const before = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (!before) throw notFoundError('vendor', { id: vendorId });

    const { columns, provided } = splitPatch(payload, VENDOR_COLUMN_MAP);

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: vendorId,
      beforeState: Object.fromEntries(
        Object.keys(columns).map((column) => [column, (before as Record<string, unknown>)[column]]),
      ),
      afterState: columns,
      metadata: { source: AUDIT_SOURCE, vendorId, fields: provided },
    };

    await db.batch([
      db.update(vendors).set(columns).where(eq(vendors.id, vendorId)),
      auditInsert(db, auditEntry),
    ] as BatchTuple);

    const after = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (!after) throw notFoundError('vendor', { id: vendorId });

    c.executionCtx.waitUntil(
      Promise.all([
        purgeTag(c, `vendor:${after.slug}`),
        forwardAuditLog(auditEntry, makeForwarder(c)),
      ]),
    );

    const body: UpdateVendorProfileResponse = { vendor: toVendorAccount(after) };
    validateResponseInDev(c.env, () => UpdateVendorProfileResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/vendor/products/:id ──────────────────────────────────────────

/** Wire field → `products` column (the write-side allow-list). */
const PRODUCT_COLUMN_MAP: Record<string, string> = {
  description: 'description',
  website: 'website',
  tool_integrations_url: 'toolIntegrationsUrl',
  api_docs_url: 'apiDocsUrl',
  logo_url: 'logoUrl',
};

export function createUpdateVendorProductHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const productId = c.req.param('id');
    if (!productId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, UpdateVendorProductSchema);
    const { db } = writeDb(c, dbFor);

    // Ownership FIRST, and a miss is a 404 — a vendor must not be able to probe
    // for the existence of another vendor's product. This single check is what
    // stands in for the RLS row filter.
    const ownership = await db.query.productVendors.findFirst({
      where: and(eq(productVendors.productId, productId), eq(productVendors.vendorId, vendorId)),
    });
    if (!ownership) throw notFoundError('product', { id: productId });

    const before = await db.query.products.findFirst({ where: eq(products.id, productId) });
    if (!before) throw notFoundError('product', { id: productId });

    const { columns, provided } = splitPatch(payload, PRODUCT_COLUMN_MAP);

    // Resolve every requested term before opening the batch, so an unknown slug
    // is a 400 and not a half-applied edit.
    const [categoryIds, audienceIds, phaseIds] = await Promise.all([
      payload.category_slugs
        ? resolveTermIds(db, taxonomyCategories, payload.category_slugs, 'category_slugs')
        : Promise.resolve(null),
      payload.audience_slugs
        ? resolveTermIds(db, taxonomyAudiences, payload.audience_slugs, 'audience_slugs')
        : Promise.resolve(null),
      payload.phase_slugs
        ? resolveTermIds(db, taxonomyPhases, payload.phase_slugs, 'phase_slugs')
        : Promise.resolve(null),
    ]);

    const beforeTaxonomy = (await loadTaxonomySlugs(db, [productId])).get(productId) ?? NO_TAXONOMY;

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product.updated',
      entityType: 'product',
      entityId: productId,
      beforeState: {
        ...Object.fromEntries(
          Object.keys(columns).map((column) => [
            column,
            (before as Record<string, unknown>)[column],
          ]),
        ),
        ...(categoryIds ? { category_slugs: beforeTaxonomy.categories } : {}),
        ...(audienceIds ? { audience_slugs: beforeTaxonomy.audiences } : {}),
        ...(phaseIds ? { phase_slugs: beforeTaxonomy.phases } : {}),
      },
      afterState: {
        ...columns,
        ...(payload.category_slugs ? { category_slugs: payload.category_slugs } : {}),
        ...(payload.audience_slugs ? { audience_slugs: payload.audience_slugs } : {}),
        ...(payload.phase_slugs ? { phase_slugs: payload.phase_slugs } : {}),
      },
      metadata: {
        source: AUDIT_SOURCE,
        vendorId,
        fields: [
          ...provided,
          ...(payload.category_slugs ? ['category_slugs'] : []),
          ...(payload.audience_slugs ? ['audience_slugs'] : []),
          ...(payload.phase_slugs ? ['phase_slugs'] : []),
        ],
      },
    };

    // One atomic unit: the column patch, each taxonomy facet's delete+reinsert
    // (set replacement, so a facet the caller didn't send is untouched), and the
    // audit row.
    const stmts: BatchStmt[] = [];
    if (Object.keys(columns).length > 0) {
      stmts.push(db.update(products).set(columns).where(eq(products.id, productId)));
    }
    if (categoryIds) {
      stmts.push(db.delete(productCategories).where(eq(productCategories.productId, productId)));
      if (categoryIds.length) {
        stmts.push(
          db
            .insert(productCategories)
            .values(categoryIds.map((id) => ({ productId, categoryId: id }))),
        );
      }
    }
    if (audienceIds) {
      stmts.push(db.delete(productAudiences).where(eq(productAudiences.productId, productId)));
      if (audienceIds.length) {
        stmts.push(
          db
            .insert(productAudiences)
            .values(audienceIds.map((id) => ({ productId, audienceId: id }))),
        );
      }
    }
    if (phaseIds) {
      stmts.push(db.delete(productPhases).where(eq(productPhases.productId, productId)));
      if (phaseIds.length) {
        stmts.push(
          db.insert(productPhases).values(phaseIds.map((id) => ({ productId, phaseId: id }))),
        );
      }
    }
    stmts.push(auditInsert(db, auditEntry));
    await db.batch(stmts as BatchTuple);

    const after = await db.query.products.findFirst({ where: eq(products.id, productId) });
    if (!after) throw notFoundError('product', { id: productId });
    const afterTaxonomy = (await loadTaxonomySlugs(db, [productId])).get(productId) ?? NO_TAXONOMY;

    c.executionCtx.waitUntil(
      Promise.all([
        purgeTag(c, `product:${after.slug}`),
        forwardAuditLog(auditEntry, makeForwarder(c)),
      ]),
    );

    const body: UpdateVendorProductResponse = {
      product: toVendorProduct(after, ownership.isPrimary, afterTaxonomy),
    };
    validateResponseInDev(c.env, () => UpdateVendorProductResponseSchema.parse(body));
    return json(body);
  };
}
