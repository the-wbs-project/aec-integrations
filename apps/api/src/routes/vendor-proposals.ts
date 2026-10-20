/**
 * The owner's "Proposed products" (AECI-1417, E6b.5; ADR 0042, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.22, `API_CONTRACTS.md` §6.14) — Drizzle/D1.
 *
 *   GET  /api/vendor/proposals              → 200 `{ proposals, truncated }`
 *   POST /api/vendor/proposals/:id/accept   → 200 `{ proposal_id, product, dropped }`
 *   POST /api/vendor/proposals/:id/decline  → 204
 *
 * Once a vendor owns its record, a new product the review app sends for it is stored in
 * `product_proposals` instead of being created (AECI-1416). This is the owner's half:
 * the list, and the decision.
 *
 * ── GATES, IN ORDER ──────────────────────────────────────────────────────────
 * `requireVendor()` at registration, then `rateLimit('write')` on the two POSTs, then
 * `requireSeatOwner()` here: a proposal is the owner's decision (ruled 2026-10-19), so a
 * member seat gets `403`. No capability gate: Free owners decide too. The vendor id comes
 * from the session. A proposal addressed to another vendor answers the same `404` as no
 * such proposal.
 *
 * ── ACCEPT (rulings B and Q6) ────────────────────────────────────────────────
 * Re-checks, in order: the proposal is the caller's (`404`), still open
 * (`409 PROPOSAL_ALREADY_DECIDED`), the addressed vendor still owns its record
 * (`409 VENDOR_NOT_OWNED`), and every vendor the payload links still exists
 * (`409 PROPOSAL_VENDOR_MISSING`, never a half-linked product). Then ONE batch, built by
 * `vendor-proposal-accept.ts`: the guarded decision, its race sentinel, the ownership
 * sentinel, the product and its joins, and two audit rows (`product.created`,
 * `product_proposal.accepted`). Taxonomy is find-only: missing values are dropped and
 * returned in `dropped`.
 *
 * After commit: the promote purge set for a created product (`cacheTagsForPromote`:
 * `product:{slug}`, `index:products`, `sitemap`, `vendor:{slug}` per linked vendor, one tag
 * per linked term, the trade publication tags, and each extension host), a by-id Algolia
 * sync of the product and every linked vendor behind promote's watchdog, and the audit
 * forward. No re-crawl buffer: a new product holds no license, so the vendor re-crawl gate
 * (AECI-1186) would refuse it, and the sitemap `<lastmod>` is its discovery path. No home
 * stats refresh: like every vendor write, the daily cron carries it.
 *
 * ── DECLINE ─────────────────────────────────────────────────────────────────
 * The guarded decision, its race sentinel and one `product_proposal.declined` audit row.
 * Nothing else: no catalog write, no purge.
 *
 * ── LIVE REVALIDATION ───────────────────────────────────────────────────────
 * No new `GET /api/vendor/updates` scope. An accept creates a product joined to the
 * caller's vendor, so the `products` cursor moves and `/me` refetches. A second owner's
 * stale list is answered by the `409`, and the tab re-reads.
 */

import {
  AcceptVendorProposalResponseSchema,
  ApiErrorCode,
  ListVendorProposalsResponseSchema,
  PROPOSAL_DESCRIPTION_EXCERPT_MAX,
  PromoteProductSchema,
  VENDOR_PROPOSALS_MAX,
  type AcceptVendorProposalResponse,
  type ListVendorProposalsResponse,
  type PromoteProduct,
  type PromoteResponse,
  type VendorProposal,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, type Db } from '../db/client';
import { productProposals, products, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { changedOneRowSentinel, isReleaseRaceError } from '../lib/license-release-requests';
import { dispatchOwnershipSync } from '../lib/ownership-sync';
import { openProposalsFor } from '../lib/product-proposals';
import { chunked } from '../lib/promote-claims';
import { dispatchOwnerWriteSearch, syncOwnerWriteSearch } from './integration-retire-write';
import { generateSlug, isSlugUniqueViolation } from './promote';
import { cacheTagsForPromote } from './promote-cache-tags';
import {
  loadProposalTermIndex,
  planProposalAccept,
  proposalHostIds,
  resolveProposalTerms,
  type StoredTerm,
} from './vendor-proposal-accept';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  requireSeatOwner,
  sessionVendorId,
  type VendorContext,
  vendorAuditEntry,
} from './vendor-shared';

const OWNER_ONLY = 'Only a vendor account owner can review proposed products';

export const PROPOSAL_ACCEPTED_ACTION = 'product_proposal.accepted';
export const PROPOSAL_DECLINED_ACTION = 'product_proposal.declined';

/**
 * `product_proposals.payload` as AECI-1416 stores it (`ProductProposalPayload`). Parsed
 * rather than cast: `product` re-runs `PromoteProductSchema`, which is idempotent on its
 * own output. A row that fails is a server fault, never the caller's `400`.
 */
const StoredPayloadSchema = z.object({
  version: z.literal(1),
  product: PromoteProductSchema,
  vendors: z.array(
    z.object({
      vendorId: z.string().min(1),
      isPrimary: z.boolean(),
      owned: z.boolean(),
      sent: z.object({ companyName: z.string() }).passthrough(),
    }),
  ),
});
type StoredPayload = z.infer<typeof StoredPayloadSchema>;

function parsePayload(proposalId: string, raw: unknown): StoredPayload {
  const parsed = StoredPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`product_proposals ${proposalId} holds an unreadable payload`);
  }
  return parsed.data;
}

function proposalIdParam(c: VendorContext): string {
  const id = c.req.param('id');
  if (!id) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing proposal id', {
      field: 'id',
    });
  }
  return id;
}

const alreadyDecided = () =>
  new ApiError(
    409,
    ApiErrorCode.PROPOSAL_ALREADY_DECIDED,
    'This proposal was already accepted or declined.',
  );
const vendorNotOwned = () =>
  new ApiError(
    409,
    ApiErrorCode.VENDOR_NOT_OWNED,
    'Your company no longer owns its records, so this product cannot be created from here.',
  );
const vendorMissing = (vendorIds: readonly string[]) =>
  new ApiError(
    409,
    ApiErrorCode.PROPOSAL_VENDOR_MISSING,
    'A company this product would be listed under no longer exists, so it cannot be accepted. Decline it and contact us.',
    { details: { vendor_ids: [...vendorIds] } },
  );

/** True for a D1 or SQLite foreign-key failure anywhere on the cause chain. */
function isForeignKeyViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (/FOREIGN KEY constraint failed/i.test(String((current as { message?: unknown }).message)))
      return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Rows by id, in chunks under D1's 100-parameter cap. */
async function loadByIds<T>(
  ids: readonly string[],
  read: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const out: T[] = [];
  for (const chunk of chunked(unique)) out.push(...(await read(chunk)));
  return out;
}

function hostMap(rows: readonly StoredTerm[]): Map<string, StoredTerm> {
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadHosts(db: Db, ids: readonly string[]): Promise<StoredTerm[]> {
  return loadByIds(ids, (chunk) =>
    db
      .select({ id: products.id, slug: products.slug, name: products.name })
      .from(products)
      .where(inArray(products.id, chunk)),
  );
}

function excerpt(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > PROPOSAL_DESCRIPTION_EXCERPT_MAX
    ? `${trimmed.slice(0, PROPOSAL_DESCRIPTION_EXCERPT_MAX - 1).trimEnd()}…`
    : trimmed;
}

/** `GET /api/vendor/proposals`: the open proposals addressed to the caller's vendor,
 *  oldest first, capped at {@link VENDOR_PROPOSALS_MAX}. */
export function createListVendorProposalsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);

    const rows = await db
      .select({
        id: productProposals.id,
        payload: productProposals.payload,
        proposedAt: productProposals.proposedAt,
      })
      .from(productProposals)
      .where(openProposalsFor(vendorId))
      .orderBy(asc(productProposals.proposedAt), asc(productProposals.id))
      .limit(VENDOR_PROPOSALS_MAX + 1);
    const truncated = rows.length > VENDOR_PROPOSALS_MAX;
    const page = rows.slice(0, VENDOR_PROPOSALS_MAX).map((r) => ({
      ...r,
      parsed: parsePayload(r.id, r.payload),
    }));

    let proposals: VendorProposal[] = [];
    if (page.length) {
      const [vendorRows, hostRows, index] = await Promise.all([
        loadByIds(
          page.flatMap((p) => p.parsed.vendors.map((v) => v.vendorId)),
          (chunk) =>
            db
              .select({ id: vendors.id, companyName: vendors.companyName })
              .from(vendors)
              .where(inArray(vendors.id, chunk)),
        ),
        loadHosts(
          db,
          page.flatMap((p) => proposalHostIds(p.parsed.product)),
        ),
        loadProposalTermIndex(db),
      ]);
      const vendorName = new Map(vendorRows.map((v) => [v.id, v.companyName]));
      const hosts = hostMap(hostRows);
      proposals = page.map(({ id, proposedAt, parsed }) => ({
        id,
        proposed_at: proposedAt,
        product: {
          name: parsed.product.name,
          description_excerpt: excerpt(parsed.product.description),
          website: parsed.product.website ?? null,
          product_role: parsed.product.productRole,
        },
        vendors: parsed.vendors.map((v) => ({
          id: v.vendorId,
          name: vendorName.get(v.vendorId) ?? v.sent.companyName,
          is_primary: v.isPrimary,
          owned: v.owned,
          exists: vendorName.has(v.vendorId),
        })),
        terms: resolveProposalTerms(parsed.product, index, hosts).terms,
      }));
    }

    const body: ListVendorProposalsResponse = { proposals, truncated };
    validateResponseInDev(c.env, () => ListVendorProposalsResponseSchema.parse(body));
    return json(body);
  };
}

/** The caller's proposal, or the one `404` for another vendor's and for none. */
async function loadOwnProposal(db: Db, proposalId: string, vendorId: string) {
  const row = await db.query.productProposals.findFirst({
    columns: { id: true, ref: true, payload: true, decision: true },
    where: and(eq(productProposals.id, proposalId), eq(productProposals.vendorId, vendorId)),
  });
  if (!row) throw notFoundError('product_proposal', { id: proposalId });
  return row;
}

/**
 * Name a failed decision batch. Both sentinels raise the same "malformed JSON" error, so
 * re-read: a decided proposal is the race sentinel, an unowned vendor the ownership one.
 */
async function nameRace(
  db: Db,
  error: unknown,
  proposalId: string,
  vendorId: string,
): Promise<never> {
  if (isReleaseRaceError(error)) {
    const row = await db.query.productProposals.findFirst({
      columns: { decision: true },
      where: eq(productProposals.id, proposalId),
    });
    if (!row) throw notFoundError('product_proposal', { id: proposalId });
    if (row.decision !== null) throw alreadyDecided();
    const vendor = await db.query.vendors.findFirst({
      columns: { ownedAt: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor?.ownedAt) throw vendorNotOwned();
  }
  throw error;
}

/** `POST /api/vendor/proposals/:id/accept`. */
export function createAcceptVendorProposalHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const proposalId = proposalIdParam(c);
    const { db } = writeDb(c, dbFor);
    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);

    const row = await loadOwnProposal(db, proposalId, vendorId);
    if (row.decision !== null) throw alreadyDecided();
    const owner = await db.query.vendors.findFirst({
      columns: { ownedAt: true },
      where: eq(vendors.id, vendorId),
    });
    if (!owner?.ownedAt) throw vendorNotOwned();

    const payload = parsePayload(proposalId, row.payload);
    const product: PromoteProduct = payload.product;
    const links = payload.vendors.map((v) => ({ vendorId: v.vendorId, isPrimary: v.isPrimary }));

    const [linkedVendors, hostRows, index, slugRows] = await Promise.all([
      loadByIds(
        links.map((l) => l.vendorId),
        (chunk) =>
          db
            .select({ id: vendors.id, slug: vendors.slug })
            .from(vendors)
            .where(inArray(vendors.id, chunk)),
      ),
      loadHosts(db, proposalHostIds(product)),
      loadProposalTermIndex(db),
      // Promote's slug preload (`loadSlugs`): the whole column, for collision-free
      // generation. A racing insert of the same slug is the `409 SLUG_CONFLICT` below.
      db.select({ slug: products.slug }).from(products),
    ]);
    const vendorSlug = new Map(linkedVendors.map((v) => [v.id, v.slug]));
    const missing = [...new Set(links.map((l) => l.vendorId))].filter((id) => !vendorSlug.has(id));
    if (missing.length) throw vendorMissing(missing);

    const resolved = resolveProposalTerms(product, index, hostMap(hostRows));
    const productId = crypto.randomUUID();
    // Promote suffixes a colliding slug with the payload's FIRST vendor's slug.
    const slug = generateSlug(
      product.name,
      new Set(slugRows.map((r) => r.slug)),
      links[0] ? vendorSlug.get(links[0].vendorId) : undefined,
    );
    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const linkedVendorIds = [...new Set(links.map((l) => l.vendorId))];

    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: 'product.created',
        entityType: 'product',
        entityId: productId,
        productId,
        afterState: {
          name: product.name,
          slug,
          vendor_ids: linkedVendorIds,
          maintained_by: 'vendor',
          last_reviewed_at: now,
        },
        metadata: { source: AUDIT_SOURCE, reason: 'proposal-accepted', proposalId },
      },
      {
        ...actor,
        action: PROPOSAL_ACCEPTED_ACTION,
        entityType: 'product_proposal',
        entityId: proposalId,
        beforeState: { decision: null },
        afterState: { decision: 'accepted', decided_at: now, created_product_id: productId },
        metadata: {
          source: AUDIT_SOURCE,
          ref: row.ref,
          createdProductId: productId,
          dropped: resolved.dropped,
        },
      },
    ];
    const stmts: BatchStmt[] = [
      ...planProposalAccept(db, {
        proposalId,
        vendorId,
        productId,
        slug,
        product,
        links,
        resolved,
        now,
        decidedBy: session.userId,
      }),
      ...audits.map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
    ];

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isSlugUniqueViolation(error)) {
        throw new ApiError(
          409,
          ApiErrorCode.SLUG_CONFLICT,
          'Another product took this name at the same moment. Try again.',
          { details: { target: ['slug'] } },
        );
      }
      if (isForeignKeyViolation(error)) {
        const still = await loadByIds(linkedVendorIds, (chunk) =>
          db.select({ id: vendors.id }).from(vendors).where(inArray(vendors.id, chunk)),
        );
        const present = new Set(still.map((v) => v.id));
        const gone = linkedVendorIds.filter((id) => !present.has(id));
        // A term or host product removed in the same window also fails a foreign key.
        // That is not a missing vendor, so it is rethrown rather than misnamed.
        if (gone.length) throw vendorMissing(gone);
      }
      return nameRace(db, error, proposalId, vendorId);
    }

    // The promote purge set for a created product, from the same deriver.
    const purgeShape: PromoteResponse = {
      vendors: linkedVendorIds.map((id) => ({
        ref: id,
        id,
        slug: vendorSlug.get(id)!,
        operation: 'updated' as const,
      })),
      product: { ref: row.ref, id: productId, slug, operation: 'created' },
      integrations: [],
      taxonomy: {
        categories: resolved.categories.map((t) => ({ ...t, operation: 'reused' as const })),
        audiences: resolved.audiences.map((t) => ({ ...t, operation: 'reused' as const })),
        phases: resolved.phases.map((t) => ({ ...t, operation: 'reused' as const })),
        trades: resolved.trades.map((t) => ({ ...t, operation: 'reused' as const })),
      },
      skipped: [],
      preserved: [],
      unresolvedLinks: [],
    };
    afterVendorWrite(
      c,
      cacheTagsForPromote(purgeShape, { extensionHostSlugs: resolved.hosts.map((h) => h.slug) }),
      audits,
    );
    // AECI-1418: the review app learns the decision and the created product's id, so
    // it can bind its `p:rec…` record to it. One message, for the addressed owner.
    dispatchOwnershipSync(c, vendorId, 'proposal_accepted');
    dispatchOwnerWriteSearch(
      c,
      'proposal-accept-algolia',
      syncOwnerWriteSearch(
        c,
        db,
        { products: [productId], vendors: linkedVendorIds, integrations: [] },
        'aeci.api.vendor.proposal_accept.algolia_sync_failed',
      ),
    );

    const body: AcceptVendorProposalResponse = {
      proposal_id: proposalId,
      product: { id: productId, slug, name: product.name },
      dropped: resolved.dropped,
    };
    validateResponseInDev(c.env, () => AcceptVendorProposalResponseSchema.parse(body));
    return json(body);
  };
}

/** `POST /api/vendor/proposals/:id/decline`. */
export function createDeclineVendorProposalHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const proposalId = proposalIdParam(c);
    const { db } = writeDb(c, dbFor);
    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);

    const row = await loadOwnProposal(db, proposalId, vendorId);
    if (row.decision !== null) throw alreadyDecided();

    const now = new Date().toISOString();
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: PROPOSAL_DECLINED_ACTION,
      entityType: 'product_proposal',
      entityId: proposalId,
      beforeState: { decision: null },
      afterState: { decision: 'declined', decided_at: now },
      metadata: { source: AUDIT_SOURCE, ref: row.ref },
    };
    try {
      await db.batch([
        db
          .update(productProposals)
          .set({ decision: 'declined', decidedAt: now, decidedBy: session.userId })
          .where(and(eq(productProposals.id, proposalId), isNull(productProposals.decision))),
        changedOneRowSentinel(db),
        auditInsert(db, vendorAuditEntry(c, audit)),
      ] as BatchTuple);
    } catch (error) {
      return nameRace(db, error, proposalId, vendorId);
    }

    // The audit forward only. A decline changes no public page.
    afterVendorWrite(c, [], audit);
    // AECI-1418: the review app learns the decline (ADR 0042, AECI-1417 amendment).
    dispatchOwnershipSync(c, vendorId, 'proposal_declined');
    return new Response(null, { status: 204 });
  };
}
