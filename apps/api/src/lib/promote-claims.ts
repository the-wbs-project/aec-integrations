/**
 * Replace-by-origin claim ingest for `POST /api/promote`
 * (AECI-604 / `STAGE_2_ATTESTATIONS_SPEC.md` §3).
 *
 * Promote used to replace an integration's claims wholesale —
 * `DELETE FROM claims WHERE integration_id = ?` followed by a re-insert with fresh
 * UUIDs. That was correct while AECi was the only author. It stopped being correct
 * when AECI-301 shipped vendor attestation authoring: `attestations.claim_id` is
 * `ON DELETE CASCADE`, and the review app only ever emits `source: 'aeci'`, so the
 * first re-promote of a claimed product **deleted every vendor attestation on it**.
 * The fresh UUIDs were a second, quieter defect — every claim id churned on every
 * promote even when its identity triple never moved, which is exactly the anchor
 * AECI-303's version-diff timeline needs to stay put.
 *
 * The rule this module implements is the §3 one, and it is the same rule
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.2 applies to claimed vendors: **AECi keeps
 * curating; the vendor's word survives.** Concretely:
 *
 *   1. Claims are matched by their identity triple `(integration_id, data_object_id,
 *      direction)` — the `claims_identity_key` unique index. A match REUSES the row,
 *      so its id and everything hanging off it survive.
 *   2. Only `origin = 'aeci'` claims the payload dropped are deleted. A vendor-origin
 *      claim is never deleted by promote, under any payload.
 *   3. Only `source = 'aeci'` attestations are replaced. `vendor_a` / `vendor_b` rows
 *      are never touched.
 *   4. Dropping an AECi claim that a vendor has attested **converts** it to
 *      `origin = 'vendor'` rather than deleting it. AECi has withdrawn its curation;
 *      the vendor's assertion still stands on its own authority and renders
 *      `single_source` through the §4 agreement engine. Lossless.
 *
 * **Why a pre-read instead of a pure `ON CONFLICT` upsert.** D1 has no interactive
 * transactions and `db.batch([...])` cannot feed one statement's result into the
 * next, so the surviving claim's id has to be known *before* the batch is built —
 * otherwise the attestation inserts have no id to point at. Hence one batched read
 * up front. The inserts still carry `onConflictDoUpdate` on the identity index as a
 * race guard, but the pre-read is what actually delivers id stability.
 *
 * **Residual race, accepted deliberately.** Two concurrent promotes of the same
 * integration can interleave between that pre-read and the batch. The loser's
 * attestation insert then references a claim id that never landed, the FK rejects
 * it, and D1 rolls the whole batch back — a retryable 500, the same posture as the
 * existing `409 SLUG_CONFLICT` path. Closing it properly needs a transaction D1
 * does not offer.
 *
 * The module returns a *plan*, never executing anything: the caller splices the
 * statements into the single atomic `db.batch([...])` that already carries the
 * integration writes and their `audit_log` rows (§26.1). Statement order within the
 * plan is FK-safe by construction — see {@link ClaimIngestPlan.statements}.
 */

import { and, eq, inArray } from 'drizzle-orm';

import type { AuditLogEntry, PromoteClaim, PromotePreserved, PromoteSkipped } from '@aeci/shared';

import type { Db } from '../db/client';
import { attestations, claims } from '../db/schema';
import { claimProvenance } from './attestation-authority';
import type { BatchStmt } from './audit';
import type { DataObjectResolver } from './data-object-vocabulary';
import { liveAttestationsWhere } from './drizzle-helpers';

/**
 * Max ids per `IN (...)` list. D1 caps bound parameters per query well below what
 * SQLite allows locally, and the test harness will not reproduce the failure — so
 * the reads and deletes here chunk rather than trusting the payload to stay small.
 * A single integration tops out at 60 claims anyway (20 frozen vocabulary terms ×
 * 3 directions), so this only ever bites the integration-id read on a large bundle.
 *
 * Exported, with {@link chunked}, because the connector-catalogue sync
 * (`./promote-connector-catalog.ts`) pages at 500 rows and needs the same cap. One
 * constant deliberately, not two: two chunk sizes that drift is the exact failure
 * this comment exists to prevent.
 */
export const ID_CHUNK = 90;

export function chunked<T>(values: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** The `attestations.source` value promote is allowed to write. */
const AECI_SOURCE = 'aeci';

/** Reasons that appear in `preserved[]`. Constants so the specs assert on the same strings. */
export const PRESERVED_VENDOR_CLAIM = 'vendor-origin claim left untouched (not AECi-curated)';
export const PRESERVED_CONVERTED_CLAIM =
  'AECi curation withdrawn; claim converted to vendor origin (a live vendor attestation stands)';
export const PRESERVED_UNCONVERTED_CLAIM =
  'AECi curation withdrawn; claim kept for its vendor attestation but not converted (attesting vendor unknown)';
export const PRESERVED_VENDOR_ATTESTATIONS = 'vendor attestations kept on a re-curated claim';

/** One resolved integration's claim work. */
export interface ClaimIngestItem {
  /** The integration row these claims attach to. */
  integrationId: string;
  /** The payload `ref` of the enclosing integration — how claims are addressed in
   *  `skipped[]` / `preserved[]`, since a claim has no `ref` of its own. */
  ref: string;
  /** The payload's claims for this integration. */
  claims: readonly PromoteClaim[];
  /**
   * True when the integration row was CREATED by this promote, so nothing can
   * pre-exist and the pre-read is skipped entirely.
   *
   * Passed in rather than derived from `supabaseId`: a stale `supabaseId` takes
   * promote's create branch and mints a brand-new id (AECI-568), so the only
   * honest source is the caller's resolved `operation`.
   */
  isNewIntegration: boolean;
}

/** The statements + side-channel reports for one payload's claims. */
export interface ClaimIngestPlan {
  /**
   * FK-safe, ready to splice into the caller's batch: claim upserts → claim
   * deletes → claim converts → attestation deletes → attestation inserts. Claim
   * inserts precede attestation inserts (the FK), and attestation deletes precede
   * attestation inserts so re-writing the `aeci` slot cannot trip
   * `attestations_slot_key`. Deletes never contend with inserts on
   * `claims_identity_key`, because a delete only ever targets an identity the
   * payload does NOT contain.
   */
  statements: BatchStmt[];
  /** Audit entries, for the caller to run through its own `audit()` wrapper so they
   *  pick up the shared metadata and land in the same batch (§26.1). */
  audits: AuditLogEntry[];
  skipped: PromoteSkipped[];
  preserved: PromotePreserved[];
}

/** A pre-existing claim plus its live attestations. */
interface ExistingClaim {
  id: string;
  integrationId: string;
  dataObjectId: string;
  direction: string;
  origin: string;
  attestations: { source: string; attestedByVendorId: string | null }[];
}

const identityKey = (integrationId: string, dataObjectId: string, direction: string) =>
  `${integrationId}|${dataObjectId}|${direction}`;

/**
 * Load the claims already on these integrations, with their live attestations.
 *
 * `liveAttestationsWhere` (not a bare `retracted_at IS NULL`) so retraction
 * semantics stay defined in one place — a retracted vendor attestation must not
 * keep an AECi claim alive, and `deprecated_at` must never gate this (it is a
 * version stamp, not a withdrawal).
 */
async function loadExistingClaims(
  db: Db,
  integrationIds: readonly string[],
): Promise<Map<string, ExistingClaim[]>> {
  const byIntegration = new Map<string, ExistingClaim[]>();
  if (!integrationIds.length) return byIntegration;

  for (const chunk of chunked(integrationIds)) {
    const rows = await db.query.claims.findMany({
      columns: {
        id: true,
        integrationId: true,
        dataObjectId: true,
        direction: true,
        origin: true,
      },
      where: inArray(claims.integrationId, chunk),
      with: {
        attestations: {
          columns: { source: true, attestedByVendorId: true },
          where: liveAttestationsWhere,
        },
      },
    });
    for (const row of rows) {
      const list = byIntegration.get(row.integrationId);
      if (list) list.push(row);
      else byIntegration.set(row.integrationId, [row]);
    }
  }
  return byIntegration;
}

/**
 * Pick the vendor whose assertion a retired AECi claim converts to.
 *
 * `vendor_a` before `vendor_b` purely for determinism — nothing makes the source
 * endpoint more authoritative, but an arbitrary-order pick would make the written
 * `created_by_vendor_id` depend on row order. Returns `null` when the slot's
 * `attested_by_vendor_id` is null, which `attestations.attested_by_vendor_id`'s
 * `ON DELETE SET NULL` makes representable.
 */
function convertingVendorId(live: ExistingClaim['attestations']): string | null {
  const vendorRows = live.filter((a) => a.source !== AECI_SOURCE);
  const ordered = [...vendorRows].sort((a, b) => a.source.localeCompare(b.source));
  for (const row of ordered) if (row.attestedByVendorId) return row.attestedByVendorId;
  return null;
}

/**
 * Plan every claim/attestation statement for one promote payload.
 *
 * One read for the whole payload rather than one per integration: promote already
 * pays a D1 hop per resolved product, and a bundle carrying claims on ten
 * mechanisms would otherwise add ten more. Integrations this promote CREATED are
 * excluded from the read entirely, so a first-time promote — still the common case
 * — pays nothing.
 */
export async function planClaimIngest(
  db: Db,
  resolveDataObject: DataObjectResolver,
  items: readonly ClaimIngestItem[],
): Promise<ClaimIngestPlan> {
  // Defensive: a payload may name the same `supabaseId` on two integration entries.
  // The old delete-then-reinsert absorbed that (each delete cleared the previous
  // insert, so the last entry won); an id-reusing planner would instead emit two
  // inserts for one identity and fail the batch on `claims_identity_key`. Keep
  // last-wins, and attribute reports to that last entry's `ref`.
  const byIntegrationId = new Map<string, ClaimIngestItem>();
  for (const item of items) byIntegrationId.set(item.integrationId, item);
  const plannedItems = [...byIntegrationId.values()];

  const existingByIntegration = await loadExistingClaims(
    db,
    plannedItems.filter((i) => !i.isNewIntegration).map((i) => i.integrationId),
  );

  // Built separately and concatenated so the FK-safe ordering is structural rather
  // than something each branch has to remember.
  const claimUpserts: BatchStmt[] = [];
  const claimDeletes: BatchStmt[] = [];
  const claimConverts: BatchStmt[] = [];
  const attestationDeletes: BatchStmt[] = [];
  const attestationInserts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  const skipped: PromoteSkipped[] = [];

  // `preserved` is aggregated per (ref, kind, reason) — nine retained vendor claims
  // on one mechanism is one row saying nine, not nine rows.
  const preservedTally = new Map<string, PromotePreserved>();
  const preserve = (ref: string, kind: PromotePreserved['kind'], reason: string, count = 1) => {
    if (count <= 0) return;
    const key = `${ref}|${kind}|${reason}`;
    const entry = preservedTally.get(key);
    if (entry) entry.count += count;
    else preservedTally.set(key, { ref, kind, reason, count });
  };

  // Claim ids whose `aeci` attestation must go: every claim the payload re-asserts
  // (its `aeci` row is about to be rewritten) plus every claim AECi just withdrew
  // curation from. Collected across the payload so the delete is a handful of
  // chunked statements rather than one per claim.
  const aeciAttestationsToClear: string[] = [];

  for (const item of plannedItems) {
    const existing = existingByIntegration.get(item.integrationId) ?? [];
    const existingByIdentity = new Map<string, ExistingClaim>();
    for (const row of existing) {
      existingByIdentity.set(identityKey(row.integrationId, row.dataObjectId, row.direction), row);
    }

    /** Identities this payload asserts — anything else on the integration was dropped. */
    const payloadIdentities = new Set<string>();

    for (const claim of item.claims) {
      const dataObject = resolveDataObject(claim.dataObject);
      if (!dataObject) {
        skipped.push({
          ref: item.ref,
          kind: 'claim',
          reason: `dataObject "${claim.dataObject}" did not resolve to the seeded vocabulary`,
        });
        continue;
      }
      const key = identityKey(item.integrationId, dataObject.id, claim.direction);
      // Collapse identity duplicates within the payload; first occurrence wins.
      // Without this the second copy would collide with the first on
      // `claims_identity_key` and fail the whole batch.
      if (payloadIdentities.has(key)) continue;
      payloadIdentities.add(key);

      const match = existingByIdentity.get(key);
      let claimId: string;
      if (match) {
        // Identity match → reuse the row and emit NO claim statement. The claim's
        // content IS its identity (there is no other editable column), so an UPDATE
        // would move `updated_at` and nothing else, and an audit row per claim per
        // re-promote is pure churn — production carries ~950 claims. This is what
        // makes ids stable across an unchanged re-promote.
        claimId = match.id;
        aeciAttestationsToClear.push(claimId);
        if (match.origin === 'vendor') {
          // AECi curating a claim a vendor created does not seize it: provenance
          // records who CREATED the row, and that is still the vendor. Leaving it
          // alone also keeps rule 2 protecting the claim on a later promote.
          preserve(item.ref, 'claim', PRESERVED_VENDOR_CLAIM);
        }
        const keptVendorRows = match.attestations.filter((a) => a.source !== AECI_SOURCE).length;
        preserve(item.ref, 'attestation', PRESERVED_VENDOR_ATTESTATIONS, keptVendorRows);
      } else {
        claimId = crypto.randomUUID();
        claimUpserts.push(
          db
            .insert(claims)
            .values({
              id: claimId,
              integrationId: item.integrationId,
              dataObjectId: dataObject.id,
              direction: claim.direction,
              // Never assemble the provenance pair by hand — the helper makes
              // `origin='vendor'` without a vendor id unrepresentable (§2.2).
              ...claimProvenance(null),
            })
            // Race guard only; the pre-read is what decides the id. A concurrent
            // promote that inserted this identity first turns what would be a
            // constraint failure into a no-op update.
            .onConflictDoUpdate({
              target: [claims.integrationId, claims.dataObjectId, claims.direction],
              set: { updatedAt: new Date().toISOString() },
            }),
        );
        audits.push({
          actorType: 'system',
          action: 'claim.created',
          entityType: 'claim',
          entityId: claimId,
        });
      }

      // `attestations_slot_key` is unique on `(claim_id, source)` among live rows, so
      // a payload repeating a source on one claim would fail the WHOLE batch rather
      // than duplicate a vote. First occurrence wins, matching the claim dedupe.
      const seenSources = new Set<string>();
      for (const att of claim.attestations) {
        if (att.source !== AECI_SOURCE) {
          // Promote may not write a vendor slot. `PromoteAttestationSchema` permits
          // the value, and inserting it would collide with a live vendor row on
          // `attestations_slot_key` and 500 the entire promote — so it is reported
          // the same way an unresolved `dataObject` is, rather than rejected at the
          // schema boundary or allowed to blow up the batch.
          skipped.push({
            ref: item.ref,
            kind: 'claim',
            reason: `attestation source "${att.source}" is vendor-owned; promote writes only '${AECI_SOURCE}'`,
          });
          continue;
        }
        if (seenSources.has(att.source)) continue;
        seenSources.add(att.source);

        const attestationId = crypto.randomUUID();
        attestationInserts.push(
          db.insert(attestations).values({
            id: attestationId,
            claimId,
            source: att.source,
            asserted: att.asserted,
            introducedAt: att.introducedAt ?? null,
            deprecatedAt: att.deprecatedAt ?? null,
            note: att.note ?? null,
          }),
        );
        audits.push({
          actorType: 'system',
          action: 'attestation.created',
          entityType: 'attestation',
          entityId: attestationId,
        });
      }
    }

    // ── Reconcile what the payload dropped ────────────────────────────────────
    for (const row of existing) {
      const key = identityKey(row.integrationId, row.dataObjectId, row.direction);
      if (payloadIdentities.has(key)) continue;

      if (row.origin === 'vendor') {
        // Rule 2. Vendor-origin claims are not AECi's to retire, and they are never
        // in the payload, so "absent" carries no instruction about them at all.
        preserve(item.ref, 'claim', PRESERVED_VENDOR_CLAIM);
        const vendorRows = row.attestations.filter((a) => a.source !== AECI_SOURCE).length;
        preserve(item.ref, 'attestation', PRESERVED_VENDOR_ATTESTATIONS, vendorRows);
        continue;
      }

      const liveVendorRows = row.attestations.filter((a) => a.source !== AECI_SOURCE);
      if (!liveVendorRows.length) {
        // Nobody but AECi ever spoke for this claim, and AECi has stopped. Delete it;
        // its own `aeci` attestation cascades. The wholesale delete this replaces
        // emitted no audit row at all — a §26.1 gap that closes here.
        claimDeletes.push(db.delete(claims).where(eq(claims.id, row.id)));
        audits.push({
          actorType: 'system',
          action: 'claim.deleted',
          entityType: 'claim',
          entityId: row.id,
          beforeState: {
            integrationId: row.integrationId,
            dataObjectId: row.dataObjectId,
            direction: row.direction,
            origin: row.origin,
          },
        });
        continue;
      }

      // Rule 4: a vendor still asserts this. AECi withdraws its curation — the `aeci`
      // attestation goes — but the claim itself survives on the vendor's authority.
      aeciAttestationsToClear.push(row.id);
      const vendorId = convertingVendorId(row.attestations);
      if (vendorId) {
        claimConverts.push(
          db
            .update(claims)
            .set({ ...claimProvenance(vendorId) })
            .where(eq(claims.id, row.id)),
        );
        audits.push({
          actorType: 'system',
          action: 'claim.converted',
          entityType: 'claim',
          entityId: row.id,
          beforeState: { origin: 'aeci', createdByVendorId: null },
          afterState: { origin: 'vendor', createdByVendorId: vendorId },
        });
        preserve(item.ref, 'claim', PRESERVED_CONVERTED_CLAIM);
      } else {
        // The attesting vendor is unknown (`attested_by_vendor_id` is SET NULL on
        // vendor deletion), so converting would write `origin='vendor'` with a null
        // `created_by_vendor_id` — the §2.2 biconditional `assertClaimProvenance`
        // raises a 500 on. Degrade instead of failing the promote: drop AECi's
        // attestation, leave the row `origin='aeci'`, and let a later promote retry.
        // Unreachable while AECI-301 is the only writer (it always stamps the
        // vendor); this is the branch that keeps a data anomaly from becoming an
        // outage.
        preserve(item.ref, 'claim', PRESERVED_UNCONVERTED_CLAIM);
      }
      preserve(item.ref, 'attestation', PRESERVED_VENDOR_ATTESTATIONS, liveVendorRows.length);
    }
  }

  for (const chunk of chunked([...new Set(aeciAttestationsToClear)])) {
    attestationDeletes.push(
      db
        .delete(attestations)
        .where(and(inArray(attestations.claimId, chunk), eq(attestations.source, AECI_SOURCE))),
    );
  }

  return {
    statements: [
      ...claimUpserts,
      ...claimDeletes,
      ...claimConverts,
      ...attestationDeletes,
      ...attestationInserts,
    ],
    audits,
    skipped,
    preserved: [...preservedTally.values()],
  };
}
