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
  type UpdateVendorProductInput,
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
import { and, asc, count, eq, inArray, or } from 'drizzle-orm';
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

/**
 * "The seats on this vendor" — a granted vendor-portal seat is a `profiles` row
 * with BOTH `vendor_id = <vendor>` and `role = 'vendor_admin'`. Shared by the
 * dashboard's `seat_count` and the roster so the two can never disagree: a
 * `reviewer` profile that happens to carry a `vendor_id` is not a seat.
 */
function seatsOf(vendorId: string) {
  return and(eq(profiles.vendorId, vendorId), eq(profiles.role, VENDOR_ADMIN_ROLE));
}

/** The session's vendor id. `requireVendor()` guarantees it is non-null, so a
 *  miss here means the guard was not mounted — fail loudly rather than fall
 *  back to something that would read another vendor's rows. */
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
 */
async function purgeTags(c: VendorContext, tags: readonly string[]): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue || tags.length === 0) return;
  try {
    await queue.send({ tags: [...tags], source: 'vendor' });
  } catch (error) {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Cache purge enqueue failed for ${tags.join(',')}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Tags a product edit invalidates.
 *
 * Three groups, and the last two are the ones that are easy to miss — this
 * mirrors `cacheTagsForPromote` (`promote-cache-tags.ts`), which purges the same
 * set for a byte-identical write:
 *
 * 1. `product:{slug}` — the detail page.
 * 2. `index:products` — the `/products` catalog. NOT covered by (1): only the
 *    detail, vendor-detail and pair resolvers push embedded `product:` tags, so
 *    the index's only handle is its own `index:{slug}` tag. Without this the
 *    vendor's edit shows on the detail page instantly and on the catalog they
 *    clicked through from up to 300s later.
 * 3. `category:{slug}` / `audience:{slug}` / `phase:{slug}` for the UNION of the
 *    product's facet membership before and after. The union matters: a browse
 *    page tags each product it lists, so the page the product has just been
 *    ADDED to never carried `product:{slug}` and would otherwise stay stale.
 *    Purging both sides repaints the page it left and the page it joined.
 *
 * `taxonomy` is deliberately NOT emitted: that tag is for a change to the term
 * SET, and a vendor can only assign existing terms, never mint one.
 */
function productEditTags(slug: string, before: TaxonomySlugs, after: TaxonomySlugs): string[] {
  const tags = new Set<string>([`product:${slug}`, 'index:products']);
  const facets: ReadonlyArray<[string, keyof TaxonomySlugs]> = [
    ['category', 'categories'],
    ['audience', 'audiences'],
    ['phase', 'phases'],
  ];
  for (const [prefix, bucket] of facets) {
    for (const termSlug of [...before[bucket], ...after[bucket]]) {
      tags.add(`${prefix}:${termSlug}`);
    }
  }
  return [...tags];
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
 * The three taxonomy facets, as data.
 *
 * Each facet has to be handled in four places on a product edit — term
 * resolution, the before/after audit state, and the batch's delete+reinsert.
 * Written out longhand that is twelve near-identical fragments that must agree
 * about "did the caller send this facet?", and a fourth facet (Stage 2 has
 * `data_object` waiting) would mean twelve correct edits. Driving them off one
 * table makes the agreement structural instead of remembered.
 */
const FACETS = [
  {
    field: 'category_slugs',
    bucket: 'categories',
    terms: taxonomyCategories,
    join: productCategories,
    row: (productId: string, categoryId: string) => ({ productId, categoryId }),
  },
  {
    field: 'audience_slugs',
    bucket: 'audiences',
    terms: taxonomyAudiences,
    join: productAudiences,
    row: (productId: string, audienceId: string) => ({ productId, audienceId }),
  },
  {
    field: 'phase_slugs',
    bucket: 'phases',
    terms: taxonomyPhases,
    join: productPhases,
    row: (productId: string, phaseId: string) => ({ productId, phaseId }),
  },
] as const satisfies ReadonlyArray<{
  field: keyof UpdateVendorProductInput & `${string}_slugs`;
  bucket: keyof TaxonomySlugs;
  terms: typeof taxonomyCategories | typeof taxonomyAudiences | typeof taxonomyPhases;
  join: typeof productCategories | typeof productAudiences | typeof productPhases;
  row: (productId: string, termId: string) => Record<string, string>;
}>;

/** Narrow a Drizzle row to the given property names — the `beforeState` shape. */
function pickColumns(row: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, (row as Record<string, unknown>)[key]]));
}

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
      // pointing at this vendor is not a seat. Only the count is consumed, so
      // count it in SQL rather than shipping every row back.
      db.select({ value: count() }).from(profiles).where(seatsOf(vendorId)),
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
      seat_count: Math.max(seatRows[0]?.value ?? 0, 1),
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

    const { columns } = splitPatch(payload, VENDOR_COLUMN_MAP);
    // `updatedAt` is stamped rather than left to `$onUpdate` so the response can
    // be built from data already in hand (see the product handler). It is kept
    // OUT of `columns` so the audit row records the vendor's edit and not a
    // system column they never touched.
    const writeColumns = { ...columns, updatedAt: new Date().toISOString() };

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: vendorId,
      beforeState: pickColumns(before, Object.keys(columns)),
      afterState: columns,
      // Zod strips unknown keys and omits absent optionals, so the payload's own
      // keys ARE the list of fields the vendor sent.
      metadata: { source: AUDIT_SOURCE, vendorId, fields: Object.keys(payload) },
    };

    await db.batch([
      db.update(vendors).set(writeColumns).where(eq(vendors.id, vendorId)),
      auditInsert(db, auditEntry),
    ] as BatchTuple);

    // The batch committed exactly `writeColumns`, so re-reading the row would
    // only cost a round-trip — and could 404 a write that actually succeeded.
    const after = { ...before, ...writeColumns } as VendorRow;

    c.executionCtx.waitUntil(
      Promise.all([
        // `vendor:{slug}` is enough here: a product detail page embeds its
        // vendor and therefore carries this tag (`CACHE_STRATEGY.md` §3 rule 2),
        // so every page showing the vendor repaints.
        purgeTags(c, [`vendor:${after.slug}`]),
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

    // Ownership is proven FIRST, in its own wave, and a miss is a 404 — a vendor
    // must not be able to probe for the existence of another vendor's product.
    // This check is what stands in for the RLS row filter, so it has to settle
    // before any other query runs: folding it into the wave below would let a
    // rejected term lookup (400 VALIDATION_FAILED, naming the bad slug) win the
    // `Promise.all` race and answer a request that should have been a flat 404.
    const [ownership, before] = await Promise.all([
      db.query.productVendors.findFirst({
        where: and(eq(productVendors.productId, productId), eq(productVendors.vendorId, vendorId)),
      }),
      db.query.products.findFirst({ where: eq(products.id, productId) }),
    ]);
    if (!ownership || !before) throw notFoundError('product', { id: productId });

    // Now that the caller is known to own the row, the rest goes in one wave.
    // Term resolution happens BEFORE the batch opens, so an unknown slug is a
    // 400 rather than a half-applied edit.
    const [beforeTaxonomy, ...facetIds] = await Promise.all([
      loadTaxonomySlugs(db, [productId]).then((m) => m.get(productId) ?? NO_TAXONOMY),
      ...FACETS.map((facet) => {
        const slugs = payload[facet.field];
        return slugs ? resolveTermIds(db, facet.terms, slugs, facet.field) : Promise.resolve(null);
      }),
    ]);

    const { columns } = splitPatch(payload, PRODUCT_COLUMN_MAP);
    // ALWAYS stamp `updated_at`, even for a taxonomy-only edit that touches no
    // `products` column. Two things depend on it and both fail silently and
    // permanently otherwise: the nightly Algolia sync selects rows by
    // `updated_at` in the last window (`lib/algolia-sync.ts`) and the product
    // record embeds its facet names, so a taxonomy-only edit would otherwise
    // never reach search at all — not "within 24h", ever. Kept out of `columns`
    // so the audit row records the vendor's edit, not a system column.
    const writeColumns = { ...columns, updatedAt: new Date().toISOString() };

    // Set replacement per facet: absent → untouched, `[]` → cleared.
    const afterTaxonomy: TaxonomySlugs = { ...beforeTaxonomy };
    const beforeFacets: Record<string, unknown> = {};
    const afterFacets: Record<string, unknown> = {};
    FACETS.forEach((facet, i) => {
      if (facetIds[i] === null) return;
      const slugs = [...new Set(payload[facet.field])].sort();
      beforeFacets[facet.field] = beforeTaxonomy[facet.bucket];
      afterFacets[facet.field] = slugs;
      afterTaxonomy[facet.bucket] = slugs;
    });

    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'product.updated',
      entityType: 'product',
      entityId: productId,
      beforeState: { ...pickColumns(before, Object.keys(columns)), ...beforeFacets },
      afterState: { ...columns, ...afterFacets },
      // Zod strips unknown keys and omits absent optionals, so the payload's own
      // keys ARE the list of fields the vendor sent.
      metadata: { source: AUDIT_SOURCE, vendorId, fields: Object.keys(payload) },
    };

    // One atomic unit: the column patch, each sent facet's delete+reinsert, and
    // the audit row (§26.1).
    const stmts: BatchStmt[] = [
      db.update(products).set(writeColumns).where(eq(products.id, productId)),
    ];
    FACETS.forEach((facet, i) => {
      const ids = facetIds[i];
      if (ids === null) return;
      stmts.push(db.delete(facet.join).where(eq(facet.join.productId, productId)));
      if (ids.length) {
        stmts.push(db.insert(facet.join).values(ids.map((id) => facet.row(productId, id))));
      }
    });
    stmts.push(auditInsert(db, auditEntry));
    await db.batch(stmts as BatchTuple);

    // The batch committed exactly `writeColumns` and exactly the facets above,
    // so the post-write state is known without reading it back. Re-reading would
    // cost four more statements AND could 404 a write that actually succeeded,
    // if the row vanished between the batch and the read.
    const after = { ...before, ...writeColumns } as ProductRow;

    c.executionCtx.waitUntil(
      Promise.all([
        purgeTags(c, productEditTags(after.slug, beforeTaxonomy, afterTaxonomy)),
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
