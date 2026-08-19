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
 * ── The entitlement gate (AECI-611) ─────────────────────────────────────────
 * `STAGE_2_PAID_TIERS_SPEC.md` §4. Two axes, both enforced here:
 *
 *   - **Route-level**: `requireCapability(c, …)` in each WRITE handler — a
 *     DB-free assertion over the tier `requireVendor()` already joined onto the
 *     session. 403 `ENTITLEMENT_REQUIRED` (never 402: the wire contract stays
 *     payer-model-agnostic).
 *   - **Field-level**: `splitPatch` takes the caller's tier and THROWS on any
 *     provided field whose capability the tier lacks. It never silently drops.
 *
 * **The two GETs are never gated** — see the comment on `createVendorMeHandler`.
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
 *
 * The mechanics above (`sessionVendorId`, `purgeTags`, the audit source, and the
 * `requireOwnedProduct` ownership proof) live in `./vendor-shared.ts` so the
 * version CRUD (AECI-607) and the attestation authoring API (AECI-301) share ONE
 * implementation of each rule rather than three that must be kept in agreement.
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
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import {
  capabilitiesFor,
  hasCapability,
  type Capability,
  type EntitlementTier,
} from '@aeci/shared/entitlements';
import { and, asc, count, eq, inArray } from 'drizzle-orm';

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
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, entitlementRequired, requireCapability } from '../lib/authz';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import {
  AUDIT_SOURCE,
  afterVendorWrite,
  parseJsonBody,
  requireOwnedProduct,
  sessionVendorId,
  vendorRequestsWhere,
  type ProductRow,
  type VendorContext,
  type VendorRow,
} from './vendor-shared';

/** Injected seat-email seam. Default hits the GoTrue Admin API; returns an empty
 *  map (→ `email: null`) when the service-role key is absent. */
export type FetchSeatEmails = (
  env: Env,
  userIds: readonly string[],
) => Promise<Map<string, string>>;

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
 * Wire field → the `vendors`/`products` column it writes AND the capability that
 * unlocks it (AECI-611 / `STAGE_2_PAID_TIERS_SPEC.md` §3.3b).
 *
 * This is the SECOND axis of the allow-list. Restated, because both halves are
 * load-bearing and they are enforced in different places:
 *
 *   - **Zod is the PARSE allow-list.** A field absent from `Update*Schema` is
 *     stripped and can never be written — that is what keeps `verified`,
 *     `promotion_status`, `admin_notes` and the VQS columns AECi-owned.
 *   - **The column map is the ENTITLEMENT allow-list.** A field present in both
 *     is written only if the caller's tier holds its capability.
 *
 * Both must agree. At launch every field maps to a capability the `verified`
 * tier holds, so an entitled vendor sees byte-identical behaviour; adding a
 * middle rung later is a data edit in two tables (here and `TIER_CAPABILITIES`)
 * with no handler change.
 */
type VendorColumnMap = Record<string, { column: string; capability: Capability }>;

/**
 * Split a validated PATCH body into the column patch and the taxonomy patch,
 * enforcing the entitlement axis as it goes.
 *
 * Zod omits absent optional keys from its output, so `Object.entries` yields
 * exactly the fields the caller sent — which is what makes "absent leaves the
 * column alone, explicit `null` clears it" work.
 *
 * **It THROWS on an unentitled field; it must never silently drop one** (§4.2).
 * Dropping is the "silently un-verify a paying vendor" class of bug this
 * codebase has already learned once: `vendor-profile-form.ts` runs a dirty-diff
 * and re-seeds its baseline from the response echo, so a dropped field would
 * make the form settle **clean** on a value that never reached the database —
 * the vendor sees their edit accepted and it simply is not there.
 *
 * Exported for `vendor.entitlement.spec.ts`: this is a security-relevant
 * allow-list, and the field-granular denial is not reachable through the HTTP
 * surface at launch (the binary ladder means `requireCapability` in the handler
 * already 403'd anything an `unclaimed` caller could send). Testing it directly
 * is what proves the second axis is wired rather than merely declared.
 */
export function splitPatch<T extends Record<string, unknown>>(
  body: T,
  columnMap: VendorColumnMap,
  tier: EntitlementTier,
): { columns: Record<string, unknown>; provided: string[] } {
  const columns: Record<string, unknown> = {};
  const provided: string[] = [];
  const denied: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    const entry = columnMap[key];
    if (entry === undefined) continue; // taxonomy keys, handled separately
    if (!hasCapability(tier, entry.capability)) {
      denied.push(key);
      continue;
    }
    columns[entry.column] = value;
    provided.push(key);
  }
  if (denied.length > 0) {
    // Sorted so the 403 body is deterministic, and the reported `capability` is
    // the first denied field's — `details.fields` carries the complete set.
    denied.sort();
    const capability = (columnMap[denied[0] as string] as VendorColumnMap[string]).capability;
    throw entitlementRequired(capability, tier, denied);
  }
  return { columns, provided };
}

// ─── GET /api/vendor/me ──────────────────────────────────────────────────────

export function createVendorMeHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    // NO `requireCapability` here, and there must never be one (§4.3 / R13).
    // `/vendor` is gated by `vendorMeResolver`, which maps 401/403/404 onto a
    // 404 render — so gating this read would 404 the entire dashboard for a
    // vendor whose entitlement lapsed, hiding the renewal notice from exactly
    // the cohort being billed. The block below is the DOWNGRADED readout those
    // vendors need to see. Pinned by `vendor.entitlement.spec.ts`.
    const session = c.get('auth');
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
      // itself, plus those targeting any product it owns. The predicate is shared
      // with `GET /api/vendor/updates`'s `requests` cursor (AECI-627) — see
      // `vendorRequestsWhere` for why that sharing is load-bearing.
      db.query.vendorRequests.findMany({
        where: vendorRequestsWhere(vendorId, productIds),
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
      // Built from the session the guard already loaded — zero extra queries,
      // and the dashboard's readout therefore cannot disagree with the 403 a
      // write would get, because both read the same `entitlementTier`.
      entitlement: {
        tier: session.entitlementTier,
        status: session.entitlement?.status ?? null,
        period_end: session.entitlement?.periodEnd ?? null,
        capabilities: [...capabilitiesFor(session.entitlementTier)],
      },
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

/**
 * Wire field → `vendors` column + the capability that unlocks it (see
 * `VendorColumnMap`).
 *
 * Every field here is `profile.edit` at launch, so the `verified` tier writes
 * all of them and `unclaimed` writes none. `profile.rich_fields` is declared in
 * the registry and deliberately unused HERE: which fields become "rich" is the
 * open pricing question (§8.2 / §3.1), and guessing it now would ship a split
 * that the first paid rung has to undo. Moving a row to `profile.rich_fields` is
 * a one-word edit when that decision lands.
 */
export const VENDOR_COLUMN_MAP: VendorColumnMap = {
  description: { column: 'description', capability: 'profile.edit' },
  website: { column: 'website', capability: 'profile.edit' },
  headquarters: { column: 'headquarters', capability: 'profile.edit' },
  founded_year: { column: 'foundedYear', capability: 'profile.edit' },
  public_private: { column: 'publicPrivate', capability: 'profile.edit' },
  parent_company: { column: 'parentCompany', capability: 'profile.edit' },
  contact_email: { column: 'contactEmail', capability: 'profile.edit' },
  phone_number: { column: 'phoneNumber', capability: 'profile.edit' },
  logo_url: { column: 'logoUrl', capability: 'profile.edit' },
  linkedin_url: { column: 'linkedinUrl', capability: 'profile.edit' },
  x_url: { column: 'xUrl', capability: 'profile.edit' },
  facebook_url: { column: 'facebookUrl', capability: 'profile.edit' },
  instagram_url: { column: 'instagramUrl', capability: 'profile.edit' },
  youtube_url: { column: 'youtubeUrl', capability: 'profile.edit' },
  crunchbase_url: { column: 'crunchbaseUrl', capability: 'profile.edit' },
  wiki_url: { column: 'wikiUrl', capability: 'profile.edit' },
  github_org: { column: 'githubOrg', capability: 'profile.edit' },
};

export function createUpdateVendorProfileHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    // The route-level gate (§3.3a) — DB-free, over the tier the guard already
    // loaded. It runs BEFORE the body is parsed so an unentitled vendor gets a
    // consistent 403 rather than a 400 about a field it could not have written
    // anyway. There is no ownership question on this route (the session names
    // the vendor), so nothing has to settle first.
    requireCapability(c, 'profile.edit');
    const payload = await parseJsonBody(c, UpdateVendorProfileSchema);

    const { db } = writeDb(c, dbFor);
    const before = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (!before) throw notFoundError('vendor', { id: vendorId });

    const { columns } = splitPatch(payload, VENDOR_COLUMN_MAP, session.entitlementTier);
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

    // `vendor:{slug}` is enough here: a product detail page embeds its vendor and
    // therefore carries this tag (`CACHE_STRATEGY.md` §3 rule 2), so every page
    // showing the vendor repaints.
    afterVendorWrite(c, [`vendor:${after.slug}`], auditEntry);

    const body: UpdateVendorProfileResponse = { vendor: toVendorAccount(after) };
    validateResponseInDev(c.env, () => UpdateVendorProfileResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/vendor/products/:id ──────────────────────────────────────────

/** Wire field → `products` column + capability (the two-axis write allow-list).
 *  The taxonomy arrays are NOT here — they are handled by `FACETS` and gated as
 *  a unit by `product.taxonomy.edit` in the handler. */
export const PRODUCT_COLUMN_MAP: VendorColumnMap = {
  description: { column: 'description', capability: 'product.edit' },
  website: { column: 'website', capability: 'product.edit' },
  tool_integrations_url: { column: 'toolIntegrationsUrl', capability: 'product.edit' },
  api_docs_url: { column: 'apiDocsUrl', capability: 'product.edit' },
  logo_url: { column: 'logoUrl', capability: 'product.edit' },
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
    const { product: before, isPrimary } = await requireOwnedProduct(db, vendorId, productId);

    // The capability gate runs AFTER ownership, not "immediately after
    // `sessionVendorId`" as on `/profile`: a 403 here would confirm to a
    // non-owner that the product exists, and 404-never-403 is the harder
    // invariant of this surface. Same ordering as the AECI-607 version routes.
    requireCapability(c, 'product.edit');
    // Taxonomy assignment is its own capability, gated as a unit — the facet
    // arrays never enter `PRODUCT_COLUMN_MAP` (they are set-replacement joins,
    // not columns), so `splitPatch`'s second axis cannot see them.
    if (FACETS.some((facet) => payload[facet.field] !== undefined)) {
      requireCapability(c, 'product.taxonomy.edit');
    }

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

    const { columns } = splitPatch(payload, PRODUCT_COLUMN_MAP, session.entitlementTier);
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

    afterVendorWrite(c, productEditTags(after.slug, beforeTaxonomy, afterTaxonomy), auditEntry);

    const body: UpdateVendorProductResponse = {
      product: toVendorProduct(after, isPrimary, afterTaxonomy),
    };
    validateResponseInDev(c.env, () => UpdateVendorProductResponseSchema.parse(body));
    return json(body);
  };
}
