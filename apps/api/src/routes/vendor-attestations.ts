/**
 * Vendor attestation authoring (`/api/vendor/*`, AECI-301 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §5) — Drizzle/D1.
 *
 *   GET    /api/vendor/integrations                 — the attestable surface.
 *   POST   /api/vendor/claims                       — create a claim + affirm it.
 *   PUT    /api/vendor/claims/:claimId/attestation  — assert or deny.
 *   DELETE /api/vendor/claims/:claimId/attestation  — retract (204).
 *
 * This is the write surface that makes `vendor_a` / `vendor_b` real. Until it
 * shipped, `computeAgreement` could only ever return `unverified`, because no
 * code path could create a vendor attestation (`STAGE_1_5_SPEC.md` §3.4). It must
 * not reach a public environment without §4/AECI-605, or a single vendor's
 * self-assertion would render as "Vendor-confirmed" — the §8.1(4) failure.
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants; read that
 * header first. This module adds five rules of its own.
 *
 * ── 1. AUTHORITY IS DERIVED, NEVER SENT ─────────────────────────────────────
 * Which slot the caller may fill comes from product ownership in
 * `product_vendors`, resolved by `lib/attestation-authority.ts` and nothing else
 * (§2.3 — no handler re-derives the table). Nothing on the wire carries a slot or
 * a vendor id. A claim or integration the caller touches neither endpoint of is a
 * **404, not a 403**: a vendor must not be able to probe another vendor's surface.
 *
 * ── 2. THE GATE ORDER, AND ITS ONE ADAPTATION ───────────────────────────────
 * `vendor-product-versions.ts` proves ownership FIRST, in its own wave, and parses
 * the body last — it can, because its product id is a path param. **Here the
 * integration id lives in the POST body**, so authority cannot be resolved before
 * the body is read. The order is therefore:
 *
 *   1. Shape-only Zod parse. It touches no DB, so a 400 from it is
 *      existence-independent and leaks nothing about the integration.
 *   2. Authority, alone in its wave (only the caller's own `vendors` row rides
 *      along, exactly as `requireOwnedProduct` does) — checked in order:
 *      authority → 404, then `assertAttestableEdge` → 403, then
 *      `assertVerifiedVendor` → 403. The edge gate sits BETWEEN the two on
 *      purpose: an unverified vendor on a connector-powered edge must not be
 *      told that verification would unlock it (AECI-705 / §14).
 *   3. Everything else — vocabulary resolution, the duplicate-identity check,
 *      version-stamp authority. All of it resolves BEFORE the batch opens, so
 *      nothing is ever half-applied.
 *
 * Folding step 3 into step 2 is the specific mistake `createUpdateVendorProductHandler`
 * warns about: a 400 naming a bad `data_object` would win the `Promise.all` race
 * and answer a request that should have been a flat 404.
 *
 * `GET` is **not** Verified-gated — only ownership. Authoring is the
 * Verified-vendor capability (§1); reading your own surface is not, so the §6 tab
 * renders read-only and explains what verification unlocks instead of 403-ing a
 * vendor out of its own data. Same split as AECI-607's version CRUD.
 *
 * ── 3. A VENDOR OWNING BOTH ENDPOINTS WRITES BOTH SLOTS ─────────────────────
 * `product_vendors` is many-to-many, so one company can own both endpoints of an
 * integration and hold both slots. Every write here fills **every slot the caller
 * owns**. The alternative — write `vendor_a` only — cannot retract a pre-existing
 * `vendor_b` row from the same company, which would leave a claim carrying two
 * live rows from one vendor that can disagree (the self-contradiction §4.5 had to
 * add a special case for), and would leave `DELETE` unable to clear. It changes
 * nothing for the reader either way: §4 dedupes voters by `attested_by_vendor_id`,
 * so one company is one voter and still renders `single_source`.
 *
 * ── 4. SUPERSESSION IS RETRACT-THEN-INSERT, AND THE ORDER IS THE ARGUMENT ───
 * `attestations_slot_key` is `unique(claim_id, source) WHERE retracted_at IS NULL`.
 * SQLite evaluates it per statement, so within the batch the retract `UPDATE`
 * must precede the `INSERT` — reversed, the insert collides with the row it is
 * about to supersede and takes the whole batch down. Never `UPDATE` an existing
 * attestation in place: the history is append-only because §9's timeline reads it.
 *
 * The retract filters on `source IN (owned slots)` and NOT on
 * `attested_by_vendor_id`, deliberately. Two accounts on different vendors can
 * co-own one product and target one slot (§2.1); the partial unique index makes
 * that last-write-wins, so the incoming write must clear whatever holds the slot
 * or the insert fails.
 *
 * ── 5. CONNECTOR-POWERED EDGES ARE NOT ATTESTABLE (AECI-705) ────────────────
 * `vendor_a` / `vendor_b` presume two accountable ENDPOINT vendors. On an edge
 * delivered by a connector — `powered_by_product_id` set, or
 * `mechanism_kind='iPaaS'` — neither endpoint built the plumbing, so `POST` and
 * `PUT` answer **403** (`assertAttestableEdge`). `DELETE` stays open, because an
 * edge can become powered after a vendor has already attested. The list endpoint
 * still returns these rows, flagged `attestable: false` with the connector on
 * `powered_by`, so the portal can explain rather than hide — filtering them out
 * would change the scoping predicate the AECI-627 cursor must match.
 *
 * ── WRITE MECHANICS ─────────────────────────────────────────────────────────
 * One `db.batch([...])` per write carrying every mutation and its `audit_log`
 * rows (the §26.1 invariant — D1 has no interactive transactions). Ids are
 * generated up front, never read back from `db.batch()`. Post-commit,
 * `afterVendorWrite` enqueues the Cache-Tag purge and forwards the audit rows to
 * Datadog, both best-effort. The purge carries `pairCacheTag(src, tgt)` — the same
 * tag the pair page emits, keep them in lockstep — plus `product:{slug}` for both
 * endpoints, whose detail pages render the claims-aware direction column.
 *
 * **No Algolia reindex.** Claims do not feed the index; vendor edits reach search
 * on the nightly watermark sync (`STAGE_2_SPEC.md` §8.3(5)).
 */

import {
  computeAgreement,
  claimDirectionForContext,
  claimDirectionFromContext,
  CreateVendorClaimSchema,
  ListVendorIntegrationsResponseSchema,
  UpsertVendorAttestationSchema,
  VendorClaimResponseSchema,
  type AgreementAttestation,
  type ClaimDirection,
  type CounterpartyAttestation,
  type ListVendorIntegrationsResponse,
  type VendorClaim,
  type VendorClaimResponse,
  type VendorIntegration,
  type VendorOwnAttestation,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';

import { isConnectorPoweredEdge } from '../lib/connector-powered';

import { getDb, type Db } from '../db/client';
import {
  attestations,
  claims,
  integrations,
  productVersions,
  products,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json, noContent } from '../http';
import {
  ATTESTATION_SLOTS,
  resolveAttestationSlots,
  resolveAttestationSlotsForVendor,
  resolveClaimAuthority,
  assertClaimProvenance,
  claimProvenance,
  type AttestationAuthority,
  type AttestationSlot,
} from '../lib/attestation-authority';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { loadDataObjectResolver, type DataObjectTerm } from '../lib/data-object-vocabulary';
import { productLinkColumns, toMechanismKind, toProductLink } from '../lib/drizzle-helpers';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { pairCacheTag } from './promote-pair';
import {
  AUDIT_SOURCE,
  afterVendorWrite,
  assertVerifiedVendor,
  parseJsonBody,
  sessionVendorId,
  type VendorContext,
  type VendorRow,
} from './vendor-shared';

/** Live attestations only. `retracted_at` is supersession — the ONLY column that
 *  may gate a read. `deprecated_at` is a version stamp and must never filter
 *  (`schema.ts` spells the distinction out at the table). */
const liveAttestationsWhere = isNull(attestations.retractedAt);

/** The endpoint product a slot speaks for: `vendor_a` = endpoint A = the
 *  integration's `source_product_id`, `vendor_b` = endpoint B (§3.2). */
function endpointProductFor(authority: AttestationAuthority, slot: AttestationSlot): string {
  return slot === 'vendor_a' ? authority.sourceProductId : authority.targetProductId;
}

/**
 * Whether the caller's frame is endpoint A. Every direction on this surface is
 * relative to it, and so is `context_product`.
 *
 * ── THE FRAME IS A PARAMETER NOW (AECI-666) ─────────────────────────────────
 * It used to be derived: "a caller owning BOTH endpoints frames from A —
 * arbitrary, but it has to be something". That was true while the portal had ONE
 * vendor-wide Integrations tab, where a single arbitrary frame is all a flat list
 * can show. The tab is now per-product, so an owns-both integration is listed
 * under both of the caller's products and each listing has to be framed against
 * the product it is filed under — otherwise inbound/outbound read backwards on
 * one of them.
 *
 * So `contextProductId` decides when supplied, and the old A-first rule remains
 * the fallback for callers with no product in hand. Passing a product the caller
 * does not own, or that is not an endpoint of this integration, is a programming
 * error rather than bad input — see {@link assertContextProduct}, which the write
 * paths run because there the id arrives from the client.
 */
function contextIsSourceFor(
  authority: AttestationAuthority,
  contextProductId?: string | null,
): boolean {
  if (contextProductId) return contextProductId === authority.sourceProductId;
  return authority.slots.includes('vendor_a');
}

/**
 * Guard the client-supplied frame on the §5 write paths.
 *
 * A vendor may only frame a write against an endpoint it actually owns: framing
 * against the *counterparty's* product would silently invert `inbound`/`outbound`
 * on the way into `claims.direction` and write the opposite flow to the one the
 * vendor chose. Ownership is already resolved (`authority.slots`), so this is a
 * lookup, not a second query.
 *
 * A 400 rather than a 404: by the time this runs the caller has passed the
 * ownership gate on the integration, so the existence of the integration is
 * already disclosed and there is nothing left to protect. The failing field is
 * named, per the §5.2 interactive-caller rule.
 */
function assertContextProduct(authority: AttestationAuthority, contextProductId: string): void {
  const owned = authority.slots.map((slot) => endpointProductFor(authority, slot));
  if (!owned.includes(contextProductId)) {
    throw new ApiError(
      400,
      'VALIDATION_FAILED',
      'context_product_id must be one of your own products on this integration',
      { field: 'context_product_id' },
    );
  }
}

// ─── Attestation → wire ──────────────────────────────────────────────────────

/** The attestation columns every read on this surface hydrates. */
const attestationColumns = {
  id: true,
  source: true,
  asserted: true,
  note: true,
  attestedByVendorId: true,
  retractedAt: true,
  introducedVersionId: true,
  deprecatedVersionId: true,
  updatedAt: true,
} as const;

interface RawAttestation {
  id: string;
  source: string;
  asserted: boolean;
  note: string | null;
  attestedByVendorId: string | null;
  retractedAt: string | null;
  introducedVersionId: string | null;
  deprecatedVersionId: string | null;
  updatedAt: string;
}

function isOwnAttestation(
  row: RawAttestation,
  vendorId: string,
  slots: readonly AttestationSlot[],
): boolean {
  return row.attestedByVendorId === vendorId && slots.includes(row.source as AttestationSlot);
}

function toOwnAttestation(row: RawAttestation): VendorOwnAttestation {
  return {
    slot: row.source as AttestationSlot,
    asserted: row.asserted,
    note: row.note,
    introduced_version_id: row.introducedVersionId,
    deprecated_version_id: row.deprecatedVersionId,
    updated_at: row.updatedAt,
  };
}

/**
 * The other party's live position, reduced to stance + note.
 *
 * "Other party" is keyed off the **vendor identity**, not off the slot. Usually
 * that is the counterparty endpoint's vendor; it can also be a second vendor
 * co-owning the caller's own product and holding the caller's slot (§2.1's
 * data-quality case). Both are genuinely someone else's assertion, and hiding the
 * second would make the caller's own dashboard disagree with the pair page. The
 * true counterparty wins when both exist.
 */
function toCounterparty(
  live: readonly RawAttestation[],
  vendorId: string,
  slots: readonly AttestationSlot[],
): CounterpartyAttestation | null {
  const others = live.filter(
    (row) => row.source !== 'aeci' && !isOwnAttestation(row, vendorId, slots),
  );
  const preferred =
    others.find((row) => !slots.includes(row.source as AttestationSlot)) ?? others[0];
  return preferred ? { asserted: preferred.asserted, note: preferred.note } : null;
}

/** `computeAgreement`'s input shape. The rows are already `retracted_at IS NULL`,
 *  but the field is passed through — the shared engine re-checks it, and a caller
 *  that assembled the set another way must not be able to resurrect a dead vote. */
function toAgreementVote(row: RawAttestation): AgreementAttestation {
  return {
    source: row.source,
    asserted: row.asserted,
    attestedByVendorId: row.attestedByVendorId,
    retractedAt: row.retractedAt,
  };
}

interface ClaimShape {
  id: string;
  integrationId: string;
  direction: string;
  origin: string;
  dataObject: { slug: string; name: string };
}

/**
 * `contextIsSource` is passed rather than re-derived from `slots` (AECI-666).
 * The two are NOT the same question: `slots` answers "which positions are mine to
 * write", which stays the full owned set even when the caller owns both endpoints,
 * while the frame answers "which product is this listing filed under", which is one
 * endpoint at a time. Deriving the frame from `slots` is what pinned an owns-both
 * integration to endpoint A and made it unrenderable under its other product.
 */
function toVendorClaim(
  claim: ClaimShape,
  live: readonly RawAttestation[],
  vendorId: string,
  authority: Pick<AttestationAuthority, 'slots'>,
  contextIsSource: boolean,
): VendorClaim {
  const slots = authority.slots;
  return {
    id: claim.id,
    integration_id: claim.integrationId,
    data_object_slug: claim.dataObject.slug,
    data_object_name: claim.dataObject.name,
    direction: claimDirectionForContext(claim.direction as ClaimDirection, contextIsSource),
    agreement: computeAgreement(live.map(toAgreementVote)),
    origin: claim.origin === 'vendor' ? 'vendor' : 'aeci',
    mine: live
      .filter((row) => isOwnAttestation(row, vendorId, slots))
      .map(toOwnAttestation)
      // Stable `vendor_a` before `vendor_b`, matching `slotsForOwnership`.
      .sort((a, b) => a.slot.localeCompare(b.slot)),
    counterparty: toCounterparty(live, vendorId, slots),
  };
}

// ─── Cache tags ──────────────────────────────────────────────────────────────

/**
 * What an attestation write invalidates (§5.2).
 *
 * `pairCacheTag` is the SAME `pair:{min}__{max}` the pair page emits
 * (`promote-pair.ts` is the single primitive) — a claim edit is exactly what that
 * page renders. `product:{slug}` for both endpoints covers the product-detail
 * integrations table, whose `context_direction` is claims-aware and drops a claim
 * every vendor denies (§4.3). `index:products` is NOT emitted: claims never
 * appear on the catalog.
 */
function attestationEditTags(sourceSlug: string, targetSlug: string): string[] {
  return [pairCacheTag(sourceSlug, targetSlug), `product:${sourceSlug}`, `product:${targetSlug}`];
}

// ─── Shared loads ────────────────────────────────────────────────────────────

/** The path's claim id. Present by routing, but Hono types it optional. */
function claimIdParam(c: VendorContext): string {
  const claimId = c.req.param('claimId');
  if (!claimId) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Missing claim id', { field: 'claimId' });
  }
  return claimId;
}

/**
 * Authority + the caller's own vendor row, in ONE wave, checked IN ORDER.
 *
 * The two reads are co-located because neither can produce anything but the 404
 * this wave owns; the ordering of the *checks* is what matters, and it is
 * ownership-before-verification so a non-owner never gets the 403 that would
 * confirm the resource exists. Identical shape to `requireOwnedProduct`.
 */
async function authorityAndVendor<T>(
  db: Db,
  vendorId: string,
  resolve: () => Promise<T>,
): Promise<{ resolved: T; vendor: VendorRow }> {
  const [resolved, vendor] = await Promise.all([
    resolve(),
    db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) }),
  ]);
  // A granted seat whose vendor row has since been deleted. `GET /api/vendor/me`
  // answers 404 for the same state; do the same rather than 500.
  if (!vendor) throw notFoundError('vendor', { id: vendorId });
  return { resolved, vendor };
}

/**
 * The AECI-705 edge gate: refuse authoring on a **connector-powered** edge.
 *
 * Neither endpoint vendor built the plumbing on these — Zapier, Workato or Agave
 * did, and the connector has no attestation seat (`STAGE_2_SPEC.md` §8.8(5)).
 * Prompting either endpoint asks about work it did not do, and a denial on true
 * curation renders as a correction signal against AECi. The predicate is the
 * union in `lib/connector-powered.ts`; the argument for the union is on that
 * module.
 *
 * **403, not the 404 the ownership check above returns.** The §2.1 non-disclosure
 * rule exists so a vendor cannot probe for another vendor's integration — but by
 * the time this runs the caller has already proven it owns an endpoint, and
 * powered-ness is public on the pair page. There is nothing left to conceal, and
 * a 404 here would be a lie the caller can disprove by loading its own page.
 *
 * **It runs BEFORE `assertVerifiedVendor`, and that order is load-bearing.**
 * Reversed, an unverified vendor on a powered edge is told to get verified in
 * order to author — a promise verification will never keep, because verification
 * does not and will not unlock this edge. The copy therefore points at the
 * connector, never at verification, ranking or placement (§5.2).
 *
 * `DELETE` is deliberately NOT gated — see its handler.
 */
function assertAttestableEdge(authority: AttestationAuthority): void {
  if (!isConnectorPoweredEdge(authority)) return;
  throw new ApiError(
    403,
    'FORBIDDEN',
    'This integration is delivered through a connector, so neither product vendor can attest to it. AEC Integrations maintains what it moves.',
  );
}

/** The two endpoint slugs, for the purge tags. */
async function endpointSlugs(
  db: Db,
  authority: AttestationAuthority,
): Promise<{ sourceSlug: string; targetSlug: string }> {
  const rows = await db.query.products.findMany({
    columns: { id: true, slug: true },
    where: inArray(products.id, [authority.sourceProductId, authority.targetProductId]),
  });
  const slugById = new Map(rows.map((row) => [row.id, row.slug]));
  const sourceSlug = slugById.get(authority.sourceProductId);
  const targetSlug = slugById.get(authority.targetProductId);
  // Both are NOT NULL FKs, so this is unreachable short of a corrupt row — fail
  // loudly rather than emitting a `pair:undefined__…` tag nothing will ever purge.
  if (!sourceSlug || !targetSlug) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'Integration endpoint product is missing');
  }
  return { sourceSlug, targetSlug };
}

/** Every live attestation on a claim, for the agreement recompute and the
 *  counterparty view. */
async function liveAttestationsFor(db: Db, claimId: string): Promise<RawAttestation[]> {
  return db.query.attestations.findMany({
    columns: attestationColumns,
    where: and(eq(attestations.claimId, claimId), liveAttestationsWhere),
  });
}

// ─── Version-stamp authority (§8.2) ──────────────────────────────────────────

interface VersionStampInput {
  introduced_version_id?: string | null;
  deprecated_version_id?: string | null;
}

interface VersionStamps {
  introducedVersionId: string | null;
  deprecatedVersionId: string | null;
}

/**
 * Resolve the version stamps for each slot the caller is about to write.
 *
 * §8.2: **the referenced version always belongs to the attesting side's own
 * endpoint product** — a `vendor_a` attestation stamps versions of product A. The
 * FK cannot express that, so it is enforced here. A version belonging to neither
 * of the caller's owned endpoints is a `400` naming the field; an unknown id
 * answers identically, so the response cannot be used to test whether a version
 * exists on some other product.
 *
 * A version belongs to exactly one product, so for a caller holding BOTH slots
 * the stamp lands on the matching slot and the other slot's stamp stays `null` —
 * anything else would have one endpoint asserting facts about the other's release
 * history, which is the boundary §8.2 draws.
 */
async function resolveVersionStamps(
  db: Db,
  authority: AttestationAuthority,
  input: VersionStampInput,
): Promise<(slot: AttestationSlot) => VersionStamps> {
  const requested = [input.introduced_version_id, input.deprecated_version_id].filter(
    (id): id is string => typeof id === 'string',
  );
  if (requested.length === 0) {
    return () => ({ introducedVersionId: null, deprecatedVersionId: null });
  }

  const rows = await db.query.productVersions.findMany({
    columns: { id: true, productId: true },
    where: inArray(productVersions.id, [...new Set(requested)]),
  });
  const productByVersion = new Map(rows.map((row) => [row.id, row.productId]));
  const ownedEndpoints = new Set(
    authority.slots.map((slot) => endpointProductFor(authority, slot)),
  );

  const assertOwned = (id: string | null | undefined, field: string): void => {
    if (typeof id !== 'string') return;
    const productId = productByVersion.get(id);
    if (!productId || !ownedEndpoints.has(productId)) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'Version must belong to a product you own on this integration',
        { field },
      );
    }
  };
  assertOwned(input.introduced_version_id, 'introduced_version_id');
  assertOwned(input.deprecated_version_id, 'deprecated_version_id');

  return (slot) => {
    const endpoint = endpointProductFor(authority, slot);
    const stampFor = (id: string | null | undefined): string | null =>
      typeof id === 'string' && productByVersion.get(id) === endpoint ? id : null;
    return {
      introducedVersionId: stampFor(input.introduced_version_id),
      deprecatedVersionId: stampFor(input.deprecated_version_id),
    };
  };
}

// ─── Attestation row construction ────────────────────────────────────────────

interface NewAttestationInput {
  claimId: string;
  vendorId: string;
  asserted: boolean;
  note: string | null;
  now: string;
  stampsFor: (slot: AttestationSlot) => VersionStamps;
}

type AttestationRow = typeof attestations.$inferInsert;

/** One row per slot the caller owns — see rule 3 in the header. */
function newAttestationRows(
  slots: readonly AttestationSlot[],
  input: NewAttestationInput,
): AttestationRow[] {
  return slots.map((slot) => ({
    id: crypto.randomUUID(),
    claimId: input.claimId,
    source: slot,
    asserted: input.asserted,
    note: input.note,
    // The coarse ISO date stamps stay null: this surface writes the PRECISE
    // `*_version_id` form (§8.2). The dates remain the fallback for the claims
    // promote has written, which carry no version data at all.
    introducedAt: null,
    deprecatedAt: null,
    ...input.stampsFor(slot),
    retractedAt: null,
    attestedByVendorId: input.vendorId,
    createdAt: input.now,
    updatedAt: input.now,
  }));
}

function attestationAudit(
  c: VendorContext,
  action: 'attestation.created' | 'attestation.retracted',
  row: { id: string; source: string },
  context: { vendorId: string; claimId: string; integrationId: string },
  state: { beforeState?: unknown; afterState?: unknown },
): AuditLogEntry {
  const session = c.get('auth');
  return {
    actorId: session.userId,
    actorType: auditActorType(session),
    action,
    entityType: 'attestation',
    entityId: row.id,
    ...state,
    metadata: {
      source: AUDIT_SOURCE,
      vendorId: context.vendorId,
      claimId: context.claimId,
      integrationId: context.integrationId,
      slot: row.source,
    },
  };
}

// ─── The maintenance marker's vendor branch (AECI-616 / §13) ─────────────────
//
// `integrations.maintained_by` is what makes the pair page's header read
// `Vendor-maintained.` instead of `Maintained by AEC Integrations.`, and
// `last_reviewed_at` is the date beside it. This surface is the ONLY writer of the
// `'vendor'` value — promote deliberately does not accept the column, so a routine
// Airtable push can never flip a record back (the AECI-520 / AECI-604 lesson).
//
// Both directions ride in the SAME `db.batch` as the attestation mutation (§26.1),
// each with its own `audit_log` row. They are pushed AFTER the attestation
// statements, because the retract direction's guard depends on the retraction
// having already applied — see `hasLiveVendorAttestation`.

/** The two vendor-authored `attestations.source` values, as a live-row filter. */
const liveVendorAttestationWhere = and(
  inArray(attestations.source, [...ATTESTATION_SLOTS]),
  liveAttestationsWhere,
);

/**
 * Does the integration still carry a live VENDOR attestation once `excludeIds` are
 * gone? Called pre-batch with the ids this request is about to retract, because a
 * pre-batch read cannot see a write the batch has not made yet — subtracting them
 * by hand is what makes the answer describe the post-commit world.
 *
 * Integration-grain on purpose: `liveAttestationsFor` is claim-grain, and one
 * integration carries many claims. Retracting a vendor's last attestation on ONE
 * claim must not un-vendor an integration where they still hold nine others.
 */
async function hasLiveVendorAttestation(
  db: Db,
  integrationId: string,
  excludeIds: readonly string[],
): Promise<boolean> {
  const rows = await db
    .select({ id: attestations.id })
    .from(attestations)
    .innerJoin(claims, eq(claims.id, attestations.claimId))
    .where(
      and(
        eq(claims.integrationId, integrationId),
        liveVendorAttestationWhere,
        excludeIds.length ? notInArray(attestations.id, [...excludeIds]) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Flip the integration to vendor-maintained and stamp the review date.
 *
 * Unconditional, and therefore always a real state change worth an audit row: even
 * when the integration is already `'vendor'`, the vendor just re-asserted something
 * about it, and that IS the review `last_reviewed_at` records.
 */
function vendorMaintainedFlip(
  c: VendorContext,
  db: Db,
  authority: AttestationAuthority,
  now: string,
  context: { vendorId: string; claimId: string },
): { stmt: BatchStmt; audit: AuditLogEntry } {
  return {
    stmt: db
      .update(integrations)
      .set({ maintainedBy: 'vendor', lastReviewedAt: now })
      .where(eq(integrations.id, authority.integrationId)),
    audit: maintenanceAudit(c, authority, context, {
      beforeState: { maintained_by: authority.maintainedBy },
      afterState: { maintained_by: 'vendor', last_reviewed_at: now },
    }),
  };
}

/**
 * Hand the integration back to AECi once the last live vendor attestation is gone.
 *
 * `last_reviewed_at` is deliberately NOT cleared. The vendor's review genuinely
 * happened; retracting an assertion does not un-happen it, and blanking the date
 * would make a record that HAS been checked render as one that never has.
 *
 * Returns `null` when a live vendor attestation remains, so the batch carries no
 * no-op `UPDATE` and — more importantly — no audit row claiming a state change that
 * did not occur (§26.1).
 */
function aeciMaintainedFlip(
  c: VendorContext,
  db: Db,
  authority: AttestationAuthority,
  stillVendorMaintained: boolean,
  context: { vendorId: string; claimId: string },
): { stmt: BatchStmt; audit: AuditLogEntry } | null {
  if (stillVendorMaintained || authority.maintainedBy === 'aeci') return null;
  return {
    stmt: db
      .update(integrations)
      .set({ maintainedBy: 'aeci' })
      .where(eq(integrations.id, authority.integrationId)),
    audit: maintenanceAudit(c, authority, context, {
      beforeState: { maintained_by: authority.maintainedBy },
      afterState: { maintained_by: 'aeci' },
    }),
  };
}

function maintenanceAudit(
  c: VendorContext,
  authority: AttestationAuthority,
  context: { vendorId: string; claimId: string },
  state: { beforeState?: unknown; afterState?: unknown },
): AuditLogEntry {
  const session = c.get('auth');
  return {
    actorId: session.userId,
    actorType: auditActorType(session),
    action: 'integration.updated',
    entityType: 'integration',
    entityId: authority.integrationId,
    ...state,
    metadata: {
      source: AUDIT_SOURCE,
      vendorId: context.vendorId,
      claimId: context.claimId,
      integrationId: authority.integrationId,
      reason: 'maintenance-marker',
    },
  };
}

/** The audit `afterState` for a written attestation — the vendor's position, not
 *  the row's system columns. */
function attestationState(row: AttestationRow | RawAttestation): Record<string, unknown> {
  return {
    source: row.source,
    asserted: row.asserted,
    note: row.note ?? null,
    introduced_version_id: row.introducedVersionId ?? null,
    deprecated_version_id: row.deprecatedVersionId ?? null,
  };
}

// ─── GET /api/vendor/integrations ────────────────────────────────────────────

/** The list read's hydration. Column lists are deliberately narrow: this is
 *  roughly integrations × claims × attestations rows for one vendor. */
const vendorIntegrationConfig = {
  columns: {
    id: true,
    name: true,
    mechanismKind: true,
    mechanismName: true,
    poweredByProductId: true,
  },
  with: {
    sourceProduct: { columns: productLinkColumns },
    targetProduct: { columns: productLinkColumns },
    claims: {
      columns: { id: true, integrationId: true, direction: true, origin: true },
      with: {
        dataObject: { columns: { slug: true, name: true, displayOrder: true } },
        attestations: { columns: attestationColumns, where: liveAttestationsWhere },
      },
    },
    // AECI-705: the connector delivering this edge, for the read-only
    // explanation. `poweredByProductId` rides in the column list too — the
    // predicate is the union, so the relation being null does NOT mean the edge
    // is attestable (53 of 132 powered edges in production have no promoted
    // connector product to link to).
    poweredByProduct: { columns: productLinkColumns },
  },
} as const;

export function createListVendorIntegrationsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    // Ownership only — reading your own attestable surface is not the gated
    // capability, authoring is (§1). An unverified vendor sees an accurate
    // surface it cannot yet write to, rather than a 403 it cannot act on.
    const authorities = await resolveAttestationSlotsForVendor(db, vendorId);
    // A vendor whose products carry no integrations: a 200 with an empty list, not
    // a 404 — the account is fine, it simply has nothing to attest on yet.
    if (authorities.size === 0) return json(surfaceBody(c, []));

    // Query by the caller's OWNED PRODUCT ids, not by the integration ids the
    // authority map already holds. Both express the same set, but the product
    // list is bounded by the vendor's catalog (single digits, typically) while the
    // integration list is not — and every id becomes a bound parameter. Same
    // result, an order of magnitude fewer placeholders.
    const ownedProductIds = new Set<string>();
    for (const authority of authorities.values()) {
      for (const slot of authority.slots) {
        ownedProductIds.add(endpointProductFor(authority, slot));
      }
    }
    const owned = [...ownedProductIds];

    const rows = await db.query.integrations.findMany({
      ...vendorIntegrationConfig,
      where: or(
        inArray(integrations.sourceProductId, owned),
        inArray(integrations.targetProductId, owned),
      ),
    });

    const surface: VendorIntegration[] = [];
    for (const row of rows) {
      // The authority map is the authority, not the `where` above — a row it does
      // not know about is not the caller's to see.
      const authority = authorities.get(row.id);
      if (!authority) continue;

      // ── ONE ENTRY PER OWNED ENDPOINT, NOT PER INTEGRATION (AECI-666) ───────
      // The portal files integrations under the product they touch, so an
      // integration whose endpoints the caller owns BOTH is listed twice — once
      // under each — with the directions mirrored between them. `slots` is
      // already exactly "the endpoints this caller owns", so it is the loop.
      //
      // The two entries share `id`: it is no longer unique across this list, and
      // `(id, context_product.id)` is the key. That is deliberate and is what the
      // client tracks by; see `VendorIntegrationSchema`.
      //
      // They also share ONE position — `slots`, `mine`, `counterparty` and
      // `agreement` are identical on both, because a write fills every slot the
      // caller owns (§2.1, and the retract argument on this module's header) and
      // §4 dedupes voters by vendor, so one company is one voter however many
      // endpoints it owns. Rendering it twice is a view of one fact, not two.
      for (const slot of authority.slots) {
        const contextIsSource = slot === 'vendor_a';
        surface.push({
          id: row.id,
          name: row.name,
          // Fails loud on an unknown value rather than shipping it — the same
          // data-integrity posture the public reads take (AECI-115).
          mechanism_kind: toMechanismKind(row.mechanismKind, row.id),
          mechanism_name: row.mechanismName,
          // AECI-705 — computed server-side and never re-derived in the browser:
          // the union predicate is non-obvious and a client copy would drift.
          attestable: !isConnectorPoweredEdge(row),
          powered_by: row.poweredByProduct ? toProductLink(row.poweredByProduct) : null,
          context_product: toProductLink(contextIsSource ? row.sourceProduct : row.targetProduct),
          other_product: toProductLink(contextIsSource ? row.targetProduct : row.sourceProduct),
          slots: [...authority.slots],
          claims: [...row.claims]
            // Vocabulary order, then slug — the same ordering the pair page's claim
            // lanes use, so a vendor sees its flows listed as readers do.
            .sort(
              (a, b) =>
                (a.dataObject.displayOrder ?? Number.MAX_SAFE_INTEGER) -
                  (b.dataObject.displayOrder ?? Number.MAX_SAFE_INTEGER) ||
                a.dataObject.slug.localeCompare(b.dataObject.slug),
            )
            .map((claim) =>
              toVendorClaim(claim, claim.attestations, vendorId, authority, contextIsSource),
            ),
        });
      }
    }
    // Context product first, so the per-product tab's slice is contiguous, then the
    // counterpart name — which is the order within a tab, and the order the flat
    // list used before it was filed by product.
    surface.sort(
      (a, b) =>
        a.context_product.name.localeCompare(b.context_product.name) ||
        a.other_product.name.localeCompare(b.other_product.name),
    );

    return json(surfaceBody(c, surface));
  };
}

function surfaceBody(
  c: VendorContext,
  integrations: VendorIntegration[],
): ListVendorIntegrationsResponse {
  const body: ListVendorIntegrationsResponse = { integrations };
  validateResponseInDev(c.env, () => ListVendorIntegrationsResponseSchema.parse(body));
  return body;
}

// ─── POST /api/vendor/claims ─────────────────────────────────────────────────

export function createVendorClaimHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    // Step 1 — shape only. The integration id is in the BODY here, so this must
    // precede the authority check; it touches no DB, so it leaks nothing.
    const payload = await parseJsonBody(c, CreateVendorClaimSchema);

    // Step 2 — authority (404) then the capability gate (403), in that order.
    const { resolved: authority, vendor } = await authorityAndVendor(db, vendorId, () =>
      resolveAttestationSlots(db, vendorId, payload.integration_id),
    );
    assertAttestableEdge(authority);
    assertVerifiedVendor(vendor);

    // Step 3 — everything that can fail, resolved before the batch opens.
    // The frame is validated before it is used: a `context_product_id` naming an
    // endpoint the caller does not own would invert `direction` on the way in and
    // silently store the opposite flow (AECI-666).
    if (payload.context_product_id) assertContextProduct(authority, payload.context_product_id);
    const contextIsSource = contextIsSourceFor(authority, payload.context_product_id);
    const direction = claimDirectionFromContext(payload.direction, contextIsSource);

    const [resolveDataObject, stampsFor, endpoints] = await Promise.all([
      loadDataObjectResolver(db),
      resolveVersionStamps(db, authority, payload),
      endpointSlugs(db, authority),
    ]);

    const dataObject: DataObjectTerm | undefined = resolveDataObject(payload.data_object);
    if (!dataObject) {
      // Find-only: the vocabulary is frozen and closed, and a vendor may no more
      // mint a term than promote can. Promote lands a miss in `skipped[]` because
      // it is a batch job; an interactive caller gets told (§5.2).
      throw new ApiError(400, 'VALIDATION_FAILED', `Unknown data object "${payload.data_object}"`, {
        field: 'data_object',
      });
    }

    // `claims_identity_key` is the guarantee; this read exists so a vendor gets a
    // 400 carrying the existing id — enough for the UI to pivot to `PUT` — rather
    // than a constraint violation surfacing as a 500. Same discipline as
    // `assertLabelFree` on the version CRUD.
    const clash = await db.query.claims.findFirst({
      columns: { id: true },
      where: and(
        eq(claims.integrationId, authority.integrationId),
        eq(claims.dataObjectId, dataObject.id),
        eq(claims.direction, direction),
      ),
    });
    if (clash) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        `A "${dataObject.name}" claim already exists in that direction on this integration`,
        { field: 'data_object', details: { claim_id: clash.id } },
      );
    }

    const now = new Date().toISOString();
    const claimId = crypto.randomUUID();
    const provenance = claimProvenance(vendorId);
    const claimRow = {
      id: claimId,
      integrationId: authority.integrationId,
      dataObjectId: dataObject.id,
      direction,
      origin: provenance.origin,
      createdByVendorId: provenance.createdByVendorId,
      createdAt: now,
      updatedAt: now,
    };
    // Defence in depth for the §2.2 biconditional. `claimProvenance` already makes
    // the illegal pair unrepresentable; this catches a future edit that assembles
    // the two columns by hand.
    assertClaimProvenance(claimRow);

    const attestationRows = newAttestationRows(authority.slots, {
      claimId,
      vendorId,
      asserted: true,
      note: payload.note ?? null,
      now,
      stampsFor,
    });

    const claimAudit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'claim.created',
      entityType: 'claim',
      entityId: claimId,
      afterState: {
        integration_id: authority.integrationId,
        data_object_slug: dataObject.slug,
        direction,
        origin: provenance.origin,
      },
      metadata: {
        source: AUDIT_SOURCE,
        vendorId,
        claimId,
        integrationId: authority.integrationId,
        slots: [...authority.slots],
      },
    };
    // One audit row per attestation row, not one per request: the ledger tracks
    // rows, and §7.3's dedupe reads `audit_log` per slot.
    const attestationAudits = attestationRows.map((row) =>
      attestationAudit(
        c,
        'attestation.created',
        { id: row.id as string, source: row.source },
        { vendorId, claimId, integrationId: authority.integrationId },
        { afterState: attestationState(row) },
      ),
    );

    // A vendor-authored claim always makes the integration vendor-maintained
    // (AECI-616) — this is the strongest possible form of the signal: the vendor
    // did not merely confirm AECi's curation, they wrote the row.
    const maintenance = vendorMaintainedFlip(c, db, authority, now, { vendorId, claimId });

    const stmts: BatchStmt[] = [
      db.insert(claims).values(claimRow),
      db.insert(attestations).values(attestationRows),
      maintenance.stmt,
      auditInsert(db, claimAudit),
      ...attestationAudits.map((entry) => auditInsert(db, entry)),
      auditInsert(db, maintenance.audit),
    ];
    await db.batch(stmts as BatchTuple);

    afterVendorWrite(c, attestationEditTags(endpoints.sourceSlug, endpoints.targetSlug), [
      claimAudit,
      ...attestationAudits,
      maintenance.audit,
    ]);

    const live: RawAttestation[] = attestationRows.map((row) => ({
      id: row.id as string,
      source: row.source,
      asserted: row.asserted ?? true,
      note: row.note ?? null,
      attestedByVendorId: row.attestedByVendorId ?? null,
      retractedAt: null,
      introducedVersionId: row.introducedVersionId ?? null,
      deprecatedVersionId: row.deprecatedVersionId ?? null,
      updatedAt: now,
    }));
    const body: VendorClaimResponse = {
      claim: toVendorClaim(
        { ...claimRow, dataObject: { slug: dataObject.slug, name: dataObject.name } },
        live,
        vendorId,
        authority,
        // The SAME frame the write was interpreted under, so the echo the client
        // splices in reads the way the tab it was authored from does.
        contextIsSource,
      ),
    };
    validateResponseInDev(c.env, () => VendorClaimResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

// ─── PUT /api/vendor/claims/:claimId/attestation ─────────────────────────────

export function createUpsertVendorAttestationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const claimId = claimIdParam(c);
    const { db } = writeDb(c, dbFor);

    const { resolved, vendor } = await authorityAndVendor(db, vendorId, () =>
      resolveClaimAuthority(db, vendorId, claimId),
    );
    const { claim, authority } = resolved;
    assertAttestableEdge(authority);
    assertVerifiedVendor(vendor);

    const payload = await parseJsonBody(c, UpsertVendorAttestationSchema);
    // Echo framing only — nothing stored by this write depends on it (AECI-666).
    // Still validated, so a bad id is a named 400 rather than a silently ignored
    // field that makes the echoed `direction` disagree with the tab that sent it.
    if (payload.context_product_id) assertContextProduct(authority, payload.context_product_id);
    const contextIsSource = contextIsSourceFor(authority, payload.context_product_id);

    const [stampsFor, endpoints, dataObject, liveBefore] = await Promise.all([
      resolveVersionStamps(db, authority, payload),
      endpointSlugs(db, authority),
      loadClaimDataObject(db, claim.dataObjectId),
      liveAttestationsFor(db, claimId),
    ]);

    const now = new Date().toISOString();
    // Retracted by SLOT, not by vendor id — the partial unique index is per
    // `(claim, slot)`, so whatever holds a slot the caller owns has to go or the
    // insert below collides with it (header rule 4).
    const superseded = liveBefore.filter((row) =>
      authority.slots.includes(row.source as AttestationSlot),
    );
    const attestationRows = newAttestationRows(authority.slots, {
      claimId,
      vendorId,
      asserted: payload.asserted,
      note: payload.note ?? null,
      now,
      stampsFor,
    });

    const audits: AuditLogEntry[] = [
      ...superseded.map((row) =>
        attestationAudit(
          c,
          'attestation.retracted',
          row,
          { vendorId, claimId, integrationId: authority.integrationId },
          { beforeState: attestationState(row), afterState: { retracted_at: now } },
        ),
      ),
      ...attestationRows.map((row) =>
        attestationAudit(
          c,
          'attestation.created',
          { id: row.id as string, source: row.source },
          { vendorId, claimId, integrationId: authority.integrationId },
          { afterState: attestationState(row) },
        ),
      ),
    ];

    const stmts: BatchStmt[] = [];
    if (superseded.length > 0) {
      // FIRST. SQLite evaluates `attestations_slot_key` per statement, so the
      // insert below would collide with the very rows it supersedes.
      stmts.push(
        db
          .update(attestations)
          .set({ retractedAt: now, updatedAt: now })
          .where(
            and(
              eq(attestations.claimId, claimId),
              inArray(attestations.source, [...authority.slots]),
              liveAttestationsWhere,
            ),
          ),
      );
    }
    stmts.push(db.insert(attestations).values(attestationRows));
    // An upsert always leaves a live vendor attestation behind (`attestationRows` is
    // never empty — `authority.slots` cannot be), so this direction is unconditional
    // and the retract-side guard never applies here (AECI-616).
    const maintenance = vendorMaintainedFlip(c, db, authority, now, { vendorId, claimId });
    stmts.push(maintenance.stmt);
    audits.push(maintenance.audit);
    stmts.push(...audits.map((entry) => auditInsert(db, entry)));
    await db.batch(stmts as BatchTuple);

    afterVendorWrite(c, attestationEditTags(endpoints.sourceSlug, endpoints.targetSlug), audits);

    // Composed in memory rather than re-read: the surviving rows are the live ones
    // in slots the caller does NOT own, plus what it just wrote. Re-reading would
    // cost a round-trip and could 404 a write that actually succeeded.
    const survivors = liveBefore.filter(
      (row) => !authority.slots.includes(row.source as AttestationSlot),
    );
    const live: RawAttestation[] = [
      ...survivors,
      ...attestationRows.map((row) => ({
        id: row.id as string,
        source: row.source,
        asserted: row.asserted ?? true,
        note: row.note ?? null,
        attestedByVendorId: row.attestedByVendorId ?? null,
        retractedAt: null,
        introducedVersionId: row.introducedVersionId ?? null,
        deprecatedVersionId: row.deprecatedVersionId ?? null,
        updatedAt: now,
      })),
    ];

    const body: VendorClaimResponse = {
      claim: toVendorClaim({ ...claim, dataObject }, live, vendorId, authority, contextIsSource),
    };
    validateResponseInDev(c.env, () => VendorClaimResponseSchema.parse(body));
    return json(body);
  };
}

// ─── DELETE /api/vendor/claims/:claimId/attestation ──────────────────────────

export function createRetractVendorAttestationHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const claimId = claimIdParam(c);
    const { db } = writeDb(c, dbFor);

    const { resolved, vendor } = await authorityAndVendor(db, vendorId, () =>
      resolveClaimAuthority(db, vendorId, claimId),
    );
    const { authority } = resolved;
    // NO `assertAttestableEdge` here, deliberately (AECI-705 / §14). An edge can
    // BECOME connector-powered after a vendor has attested — promote sets
    // `powered_by_product_id` late, and AECI-706's backfill writes it onto rows
    // that already exist. Gating retract would trap a vendor holding a position
    // it can no longer withdraw, which is a worse failure than the one the gate
    // prevents. Withdrawing is always allowed; only taking a new position is not.
    assertVerifiedVendor(vendor);

    const [endpoints, liveBefore] = await Promise.all([
      endpointSlugs(db, authority),
      liveAttestationsFor(db, claimId),
    ]);
    const superseded = liveBefore.filter(
      (row) =>
        authority.slots.includes(row.source as AttestationSlot) &&
        row.attestedByVendorId === vendorId,
    );
    // Nothing to retract. A 404 rather than an idempotent 204 because §26.1 wants
    // no audit row without a state change, and a 204 here would claim one happened.
    if (superseded.length === 0) {
      throw notFoundError('attestation', { id: claimId });
    }

    const now = new Date().toISOString();
    const audits = superseded.map((row) =>
      attestationAudit(
        c,
        'attestation.retracted',
        row,
        { vendorId, claimId, integrationId: authority.integrationId },
        { beforeState: attestationState(row), afterState: { retracted_at: now } },
      ),
    );

    // Does ANY live vendor attestation survive this retraction, anywhere on the
    // integration? Read pre-batch and subtract the rows about to be retracted — the
    // same read-then-decide shape `liveBefore` above uses. If none survives, the
    // record goes back to AECi's name; `last_reviewed_at` stays (AECI-616 / §13).
    const maintenance = aeciMaintainedFlip(
      c,
      db,
      authority,
      await hasLiveVendorAttestation(
        db,
        authority.integrationId,
        superseded.map((row) => row.id),
      ),
      { vendorId, claimId },
    );
    if (maintenance) audits.push(maintenance.audit);

    // The row survives — `retracted_at` is set, never deleted — because §9's
    // version-diff timeline reads the append-only attestation history.
    const stmts: BatchStmt[] = [
      db
        .update(attestations)
        .set({ retractedAt: now, updatedAt: now })
        .where(
          and(
            eq(attestations.claimId, claimId),
            inArray(
              attestations.id,
              superseded.map((row) => row.id),
            ),
            liveAttestationsWhere,
          ),
        ),
      // After the retract, so a reader of the batch sees the two in causal order.
      ...(maintenance ? [maintenance.stmt] : []),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    await db.batch(stmts as BatchTuple);

    afterVendorWrite(c, attestationEditTags(endpoints.sourceSlug, endpoints.targetSlug), audits);
    return noContent();
  };
}

/** The claim's vocabulary term, for the response echo. */
async function loadClaimDataObject(
  db: Db,
  dataObjectId: string,
): Promise<{ slug: string; name: string }> {
  const row = await db.query.taxonomyDataObjects.findFirst({
    columns: { slug: true, name: true },
    where: eq(taxonomyDataObjects.id, dataObjectId),
  });
  // `claims.data_object_id` is a NOT NULL FK with ON DELETE RESTRICT, so a miss
  // is a corrupt row, not a caller error.
  if (!row) {
    throw new ApiError(500, 'INTERNAL_ERROR', 'Claim references a missing data object');
  }
  return row;
}
