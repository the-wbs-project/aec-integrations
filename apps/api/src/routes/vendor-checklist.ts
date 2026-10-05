/**
 * The checklist reads (AECI-1217 / `STAGE_2_PAID_TIERS_SPEC.md` §13.10) — Drizzle/D1.
 *
 *   GET /api/vendor/checklist               — the vendor steps, plus one score per
 *                                             owned product for the Products list.
 *   GET /api/vendor/products/:id/checklist  — one owned product's steps.
 *
 * The step rules are in `lib/vendor-checklist.ts`. This module reads the facts.
 *
 * ── Gates ──────────────────────────────────────────────────────────────────────
 * `requireVendor()` only, like every other vendor read. No capability: the
 * checklist is on every plan (§13.1 decision 5). No `rateLimit()`, ever: these are
 * reads (`waf-rate-limits.md` §6.3). The product read proves ownership first, and a
 * foreign product is a flat 404 (`requireOwnedProduct`).
 *
 * ── Batched ────────────────────────────────────────────────────────────────────
 * The vendor read costs seven SELECTs in ONE wave, however many products the
 * vendor owns. The three per-product facts are each one grouped read over every
 * owned product, through the `ownedProductIds` subquery rather than a bound id
 * list. A bound list would put three placeholders per product into one statement
 * and meet D1's 100-parameter cap at about 33 products. The rows come back once
 * and are attributed to products in memory. The product read is the same three
 * reads scoped to one id, after the ownership wave.
 *
 * ── Two readings §13.10 needed (recorded in its as-built note) ────────────────
 * "Claim or say not ours": a row counts against a product when it touches the
 * product (as either endpoint, or as the connector, the §13.9 arm), is live, was
 * seeded (`origin = 'aeci'`), names the vendor in `built_by_vendor_id`, has no
 * `claimed_at`, and carries no standing `owner` contest: none open, and none
 * accepted against the vendor still on file (AECI-1225, the vendor's own "not
 * ours" included). Both tables. A
 * connector-powered row counts only when the product's plan can claim it: the
 * claim route refuses such a row without an active entitlement (AECI-1089), so on
 * Free it would be a step nobody can finish, which §13.1 decision 6 forbids.
 *
 * "Confirm data flows": every claim on a live, attestable `integrations` row with
 * the product as an endpoint has a non-retracted attestation whose
 * `attested_by_vendor_id` is the vendor. Asserting and denying both count, because
 * each is an answer. Connector-powered rows are left out: nobody may attest them
 * (AECI-705), so a claim there is not this vendor's to confirm. Evidenced pairs and
 * reach-anchored claims are left out for the same reason.
 */

import {
  VendorChecklistResponseSchema,
  VendorProductChecklistResponseSchema,
  type VendorChecklistResponse,
  type VendorEntitlementBlock,
  type VendorProductChecklistResponse,
  type VendorProductChecklistSummary,
} from '@aeci/shared';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { textAsc } from '../lib/collation';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { liveEvidencedPairOn, liveIntegrationOn } from '../lib/live-integration';
import {
  checklistScore,
  productChecklistSteps,
  vendorChecklistSteps,
  type ChecklistProductCounts,
  type ChecklistProductFacts,
} from '../lib/vendor-checklist';
import { entitlementBlock } from './vendor';
import {
  ownedProductIds,
  requireOwnedProduct,
  seatsOf,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

/** The products a fact read covers: one id, or the owned-products subquery. */
type ProductScope = string[] | SQLWrapper;

/** One row a fact read returned, with every product id it touches. */
interface TouchingRow {
  productIds: readonly (string | null)[];
  connectorPowered: boolean;
}

/** The three per-product fact reads, unattributed. */
interface ChecklistFacts {
  unclaimed: TouchingRow[];
  unattested: TouchingRow[];
}

/**
 * Can a seat on this plan claim a connector-powered row? The same test as
 * `hasActiveEntitlement` in `lib/integration-entitlement.ts`, read from the
 * PRODUCT's plan block so it moves with per-product plans (§13.7).
 */
function canClaimConnectorPowered(plan: VendorEntitlementBlock): boolean {
  return plan.tier !== 'unclaimed';
}

/**
 * No STANDING `owner` contest sits on this `integrations` row (AECI-1225). Standing
 * means open, from any vendor, or accepted against the vendor still on file: AECi
 * agreed that vendor is not the owner, and the next promote re-points the row. A
 * declined contest leaves the row on the vendor, so it counts again.
 */
function noStandingOwnerContestOnIntegration(db: Db) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(integrationFieldChallenges)
      .where(
        and(
          eq(integrationFieldChallenges.integrationId, integrations.id),
          eq(integrationFieldChallenges.field, 'owner'),
          or(
            eq(integrationFieldChallenges.status, 'open'),
            and(
              eq(integrationFieldChallenges.status, 'accepted'),
              eq(integrationFieldChallenges.ownerVendorId, integrations.builtByVendorId),
            ),
          ),
        ),
      ),
  );
}

/** No standing `owner` contest sits on this evidenced pair. */
function noStandingOwnerContestOnPair(db: Db) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(integrationFieldChallenges)
      .where(
        and(
          eq(integrationFieldChallenges.evidencedPairId, connectorEvidencedPairs.id),
          eq(integrationFieldChallenges.field, 'owner'),
          or(
            eq(integrationFieldChallenges.status, 'open'),
            and(
              eq(integrationFieldChallenges.status, 'accepted'),
              eq(integrationFieldChallenges.ownerVendorId, connectorEvidencedPairs.builtByVendorId),
            ),
          ),
        ),
      ),
  );
}

/**
 * The three fact reads, each one statement over every product in `scope`. Run
 * them inside the caller's `Promise.all` so they share its wave.
 */
function loadChecklistFacts(
  db: Db,
  vendorId: string,
  scope: ProductScope,
): [Promise<TouchingRow[]>, Promise<TouchingRow[]>, Promise<TouchingRow[]>] {
  const unclaimedIntegrations = db
    .select({
      sourceProductId: integrations.sourceProductId,
      targetProductId: integrations.targetProductId,
      poweredByProductId: integrations.poweredByProductId,
      mechanismKind: integrations.mechanismKind,
    })
    .from(integrations)
    .where(
      and(
        eq(integrations.builtByVendorId, vendorId),
        eq(integrations.origin, 'aeci'),
        isNull(integrations.claimedAt),
        liveIntegrationOn(integrations),
        or(
          inArray(integrations.sourceProductId, scope),
          inArray(integrations.targetProductId, scope),
          inArray(integrations.poweredByProductId, scope),
        ),
        noStandingOwnerContestOnIntegration(db),
      ),
    )
    .then((rows) =>
      rows.map((row) => ({
        productIds: [row.sourceProductId, row.targetProductId, row.poweredByProductId],
        connectorPowered: isConnectorPoweredEdge(row),
      })),
    );

  const unclaimedPairs = db
    .select({
      productAId: connectorEvidencedPairs.productAId,
      productBId: connectorEvidencedPairs.productBId,
      connectorProductId: connectorEvidencedPairs.connectorProductId,
    })
    .from(connectorEvidencedPairs)
    .where(
      and(
        eq(connectorEvidencedPairs.builtByVendorId, vendorId),
        eq(connectorEvidencedPairs.origin, 'aeci'),
        isNull(connectorEvidencedPairs.claimedAt),
        liveEvidencedPairOn(connectorEvidencedPairs),
        or(
          inArray(connectorEvidencedPairs.productAId, scope),
          inArray(connectorEvidencedPairs.productBId, scope),
          inArray(connectorEvidencedPairs.connectorProductId, scope),
        ),
        noStandingOwnerContestOnPair(db),
      ),
    )
    .then((rows) =>
      rows.map((row) => ({
        productIds: [row.productAId, row.productBId, row.connectorProductId],
        // Every evidenced pair is connector-delivered.
        connectorPowered: true,
      })),
    );

  // One row per claim the vendor has not answered. Endpoints only: attestation
  // authority is endpoint ownership, so the connector arm has no slot to fill.
  const unattestedClaims = db
    .select({
      sourceProductId: integrations.sourceProductId,
      targetProductId: integrations.targetProductId,
      poweredByProductId: integrations.poweredByProductId,
      mechanismKind: integrations.mechanismKind,
    })
    .from(claims)
    .innerJoin(integrations, eq(claims.integrationId, integrations.id))
    .where(
      and(
        liveIntegrationOn(integrations),
        or(
          inArray(integrations.sourceProductId, scope),
          inArray(integrations.targetProductId, scope),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(attestations)
            .where(
              and(
                eq(attestations.claimId, claims.id),
                isNull(attestations.retractedAt),
                eq(attestations.attestedByVendorId, vendorId),
              ),
            ),
        ),
      ),
    )
    .then((rows) =>
      rows
        .filter((row) => !isConnectorPoweredEdge(row))
        .map((row) => ({
          productIds: [row.sourceProductId, row.targetProductId],
          connectorPowered: false,
        })),
    );

  return [unclaimedIntegrations, unclaimedPairs, unattestedClaims];
}

/** Merge the two unclaimed reads with the unattested one. */
async function settleFacts(reads: ReturnType<typeof loadChecklistFacts>): Promise<ChecklistFacts> {
  const [rows, pairs, unattested] = await Promise.all(reads);
  return { unclaimed: [...rows, ...pairs], unattested };
}

/** How many rows touch `productId`. A row touching it twice counts once. */
function touching(
  rows: readonly TouchingRow[],
  productId: string,
  include: (row: TouchingRow) => boolean = () => true,
): number {
  return rows.filter((row) => row.productIds.includes(productId) && include(row)).length;
}

/** The counts for one product, on its own plan. */
function countsFor(
  facts: ChecklistFacts,
  productId: string,
  plan: VendorEntitlementBlock,
): ChecklistProductCounts {
  const claimPowered = canClaimConnectorPowered(plan);
  return {
    unclaimedRows: touching(
      facts.unclaimed,
      productId,
      (row) => claimPowered || !row.connectorPowered,
    ),
    unattestedClaims: touching(facts.unattested, productId),
  };
}

/** One product's response body, from its row, the facts and its plan. */
function productChecklist(
  product: ChecklistProductFacts & { id: string; slug: string },
  facts: ChecklistFacts,
  plan: VendorEntitlementBlock,
): VendorProductChecklistResponse {
  const steps = productChecklistSteps(product, countsFor(facts, product.id, plan), plan);
  return {
    product_id: product.id,
    product_slug: product.slug,
    plan,
    ...checklistScore(steps),
    steps,
  };
}

// ─── GET /api/vendor/checklist ───────────────────────────────────────────────

export function createVendorChecklistHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    // One wave. The fact reads scope by the owned-products subquery, so they need
    // nothing from the product read and can run beside it.
    const facts = settleFacts(loadChecklistFacts(db, vendorId, ownedProductIds(db, vendorId)));
    const [vendor, owned, seats, invites, settled] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { maintainedBy: true, lastReviewedAt: true },
        where: eq(vendors.id, vendorId),
      }),
      db
        .select({
          id: products.id,
          slug: products.slug,
          maintainedBy: products.maintainedBy,
          lastReviewedAt: products.lastReviewedAt,
          integrationsReviewedAt: products.integrationsReviewedAt,
        })
        .from(products)
        .innerJoin(productVendors, eq(productVendors.productId, products.id))
        .where(eq(productVendors.vendorId, vendorId))
        // The order `GET /api/vendor/me` lists products in (AECI-825).
        .orderBy(textAsc(products.name), asc(products.id)),
      // `seatsOf` is the roster's predicate, so this count matches `seat_count`.
      db.select({ value: count() }).from(profiles).where(seatsOf(vendorId)),
      db
        .select({ value: count() })
        .from(vendorSeatInvites)
        .where(eq(vendorSeatInvites.vendorId, vendorId)),
      facts,
    ]);
    // A granted seat whose vendor row was deleted. `GET /api/vendor/me` answers 404.
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    // Until per-product plans exist, every product carries the vendor's block
    // (§13.7). When they land, only this source changes.
    const plan = entitlementBlock(session);
    const summaries: VendorProductChecklistSummary[] = owned.map((product) => {
      const { steps: _steps, ...summary } = productChecklist(product, settled, plan);
      return summary;
    });

    const steps = vendorChecklistSteps(
      {
        maintainedBy: vendor.maintainedBy,
        lastReviewedAt: vendor.lastReviewedAt,
        seatCount: seats[0]?.value ?? 0,
        inviteCount: invites[0]?.value ?? 0,
      },
      summaries.map((summary) => summary.complete),
    );
    const body: VendorChecklistResponse = {
      steps,
      ...checklistScore(steps),
      products: summaries,
    };
    validateResponseInDev(c.env, () => VendorChecklistResponseSchema.parse(body));
    return json(body);
  };
}

// ─── GET /api/vendor/products/:id/checklist ──────────────────────────────────

export function createVendorProductChecklistHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const productId = c.req.param('id');
    if (!productId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
    }
    const { db } = dbFor(c.env);

    // Ownership first, in its own wave: a foreign product is a 404 before any
    // fact about it is read.
    const { product } = await requireOwnedProduct(db, vendorId, productId);
    const facts = await settleFacts(loadChecklistFacts(db, vendorId, [productId]));

    const body = productChecklist(product, facts, entitlementBlock(session));
    validateResponseInDev(c.env, () => VendorProductChecklistResponseSchema.parse(body));
    return json(body);
  };
}
