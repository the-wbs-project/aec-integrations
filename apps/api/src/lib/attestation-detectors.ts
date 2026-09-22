/**
 * The §7.1 attestation detectors (AECI-302 / `STAGE_2_ATTESTATIONS_SPEC.md` §7).
 *
 * Four read-only passes over the claim/attestation spine, each yielding
 * `(claim, recipient, detector kind)` triples the §7.2 sweep turns into email.
 * They answer the questions no surface asks on its own:
 *
 *   • `silent-counterparty` — one vendor affirmed and the other side never
 *     answered. The pair page renders that honestly as `single_source`, but
 *     nobody *tells* the silent vendor.
 *   • `open-conflict`      — two vendors describe the same flow differently and
 *     nothing has moved. Both disputants get told, and AECi ops is raised.
 *   • `stale-version`      — an assertion has aged past a year with no version
 *     data, or asserts a flow whose deprecated version has already passed.
 *   • `claim-denied`       — every voting vendor denies a claim. A denial-only
 *     claim computes `unverified` (§4.2), so it is invisible on every surface;
 *     without this detector the vendor's "no, we don't do that" is silently
 *     swallowed. Raises **AECi ops** and tells the **counterparty**, with no age
 *     threshold. Renamed from `aeci-denied` by AECI-961, which also dropped its
 *     AECi-origin gate — see the detector's own header for both reasons.
 *
 * **`cross-grain` is deliberately absent.** §7.1 required it be defined or
 * dropped; it is dropped. Its proposed definition — the same `data_object`
 * claimed with contradictory directions through *different mechanism rows* on
 * the same product pair — fires on legitimate data: a native connector that
 * pushes and a Zapier app that pulls the same object is a true description of
 * two mechanisms, not a contradiction. A detector with no false-positive floor
 * trains operators to ignore its output. See §7.1 / §11.
 *
 * Shape follows `lib/data-quality.ts`: a registry of independent checks, run
 * best-effort so one throwing detector never aborts the others, with the
 * thresholds as exported constants (`lib/reconciliation-sweep.ts` does the same)
 * because §7.1 calls them launch-tunable — they are documented in
 * `docs/POST_LAUNCH_MONITORING.md` §3 and change by edit-and-deploy, not by
 * config.
 *
 * Everything here is a **pure read**. Sending, suppression and the ledger belong
 * to `lib/attestation-notify.ts`; keeping them apart is what lets the detector
 * specs seed D1 and assert on findings without a mail transport in sight.
 */

import {
  computeAgreement,
  isClaimRefuted,
  OPEN_CONFLICT_DAYS,
  SILENT_COUNTERPARTY_DAYS,
  STALE_VERSION_MONTHS,
  type AgreementAttestation,
  type AttestationDetector,
  type NotificationProductRef,
} from '@aeci/shared';
import { and, inArray, isNotNull, isNull, ne } from 'drizzle-orm';

import {
  vendorsForIntegrationSlots,
  type AttestationSlot,
  type IntegrationSlotVendors,
} from './attestation-authority';
import { isConnectorPoweredEdge } from './connector-powered';
import { liveAttestationsWhere } from './drizzle-helpers';
import { liveIntegrationWhere } from './live-integration';
import type { Db } from '../db/client';
import { attestations, claims, integrations } from '../db/schema';

const DAY_MS = 86_400_000;

/**
 * The three launch-tunable thresholds, **re-exported from `@aeci/shared`** under
 * the names they have always had here (AECI-961).
 *
 * They moved because the vendor portal now quotes them verbatim: the claim lane
 * tells a vendor "we ask {other} to answer after 14 days"
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §6.2), and the browser bundle cannot import
 * this module. A hand-copied second source would have made a retune silently
 * turn that sentence into a lie. Retuning still means editing one number and
 * deploying — it just now also edits what the portal says, so read §6.2 first.
 *
 * Every existing importer and spec kept working unchanged; keep it that way.
 */
export {
  OPEN_CONFLICT_DAYS,
  SILENT_COUNTERPARTY_DAYS,
  STALE_VERSION_MONTHS,
} from '@aeci/shared/attestation-thresholds';

// ─── Findings ────────────────────────────────────────────────────────────────

/**
 * The recipient-relative snapshot a notification carries. Captured at detection
 * time and persisted verbatim into the §7.3 ledger, which is what makes the
 * in-portal list (`GET /api/vendor/notifications`) a single indexed read with no
 * joins — and what keeps a year-old notification legible after the claim it
 * names has been re-curated.
 *
 * For a **vendor** finding, `subjectProduct` is the endpoint the recipient owns
 * and `counterpartProduct` is the other side. For an **ops** finding there is no
 * "own" side, so `subjectProduct` is endpoint A and `counterpartProduct` is
 * endpoint B, in the integration's own frame.
 */
export interface NotificationContext {
  mechanismName: string | null;
  dataObject: NotificationProductRef;
  subjectProduct: NotificationProductRef;
  counterpartProduct: NotificationProductRef;
  /** Both endpoint slugs (source first) — the pair-page link's raw material. */
  pairSlugs: readonly [string, string];
}

/** One nudge to send. `vendorId: null` means AECi ops, never a vendor. */
export interface DetectorFinding {
  detector: AttestationDetector;
  claimId: string;
  integrationId: string;
  vendorId: string | null;
  context: NotificationContext;
}

/** One detector's outcome. `error` is set when the detector threw — the sweep
 *  reports it (and emits the `-1` gauge sentinel) rather than failing the run. */
export interface DetectorResult {
  detector: AttestationDetector;
  findings: DetectorFinding[];
  error?: string;
}

// ─── The shared read ─────────────────────────────────────────────────────────

/**
 * Claims that carry **at least one live non-`aeci` attestation**, with everything
 * four detectors need, in one query.
 *
 * The pre-filter is what keeps this job cheap. Every detector keys off a vendor's
 * word — an AECi-only claim cannot be one-sided, conflicted, stale or denied — so
 * the subquery bounds the scan to the claims a vendor has actually touched. Today
 * that is **zero rows** in every environment (promote has only ever written
 * `source='aeci'`), and it grows with portal adoption rather than with the
 * catalog.
 *
 * It is an `IN (SELECT …)` rather than a fetch-ids-then-`inArray` round trip
 * because D1 caps bound parameters per query — an id list would break the moment
 * adoption outgrew that cap, silently at first.
 *
 * `liveAttestationsWhere` (not a fresh `isNull(...)`) is the §2.5/§4 predicate:
 * retracted rows neither vote nor render, and there is one definition of that.
 */
export async function loadDetectorClaims(db: Db) {
  const vendorAttestedClaimIds = db
    .select({ claimId: attestations.claimId })
    .from(attestations)
    .where(and(isNull(attestations.retractedAt), ne(attestations.source, 'aeci')));

  const rows = await db.query.claims.findMany({
    columns: { id: true, integrationId: true, direction: true, origin: true },
    // `integration_id IS NOT NULL` scopes this to claims anchored on `integrations`
    // (AECI-721 made the anchor polymorphic — `STAGE_1_5_SPEC.md` §13.1). It excludes
    // nothing reachable: every detector keys off a live NON-`aeci` attestation, and a
    // vendor cannot attest to a claim on a connector-evidenced pair — the §14 gate
    // answers 403 on connector-delivered edges, and an evidenced pair is
    // connector-delivered by construction. So the intersection is empty by
    // definition, not by filtering.
    //
    // Written explicitly rather than left to the inner join it would otherwise
    // become, so the exclusion is a stated decision a reader can check, and so the
    // narrowing below is honest rather than a cast.
    //
    // Live integrations only (AECI-1010). A retired row keeps its claims and
    // attestations so a restore is lossless, but nobody is asked to attest to, or
    // told about a conflict on, an integration its owner has withdrawn.
    where: and(
      inArray(claims.id, vendorAttestedClaimIds),
      isNotNull(claims.integrationId),
      inArray(
        claims.integrationId,
        db.select({ id: integrations.id }).from(integrations).where(liveIntegrationWhere),
      ),
    ),
    with: {
      dataObject: { columns: { slug: true, name: true } },
      integration: {
        columns: {
          id: true,
          mechanismName: true,
          sourceProductId: true,
          targetProductId: true,
          // AECI-705 — the two columns `isConnectorPoweredEdge` reads. Hydrated
          // rather than filtered in the `where` above on purpose: the ops-routed
          // findings on a powered edge still fire, so the ROWS must survive the
          // read and only the vendor-addressed FINDINGS are dropped.
          mechanismKind: true,
          poweredByProductId: true,
        },
        with: {
          sourceProduct: { columns: { id: true, slug: true, name: true } },
          targetProduct: { columns: { id: true, slug: true, name: true } },
        },
      },
      attestations: {
        columns: {
          id: true,
          source: true,
          asserted: true,
          attestedByVendorId: true,
          retractedAt: true,
          createdAt: true,
          introducedAt: true,
          deprecatedAt: true,
          introducedVersionId: true,
          deprecatedVersionId: true,
        },
        with: { deprecatedVersion: { columns: { sunsetAt: true } } },
        where: liveAttestationsWhere,
      },
    },
  });

  // The `where` above makes this total; the relational query builder cannot express
  // that in the type, so narrow once here rather than at fourteen use sites.
  return rows.filter(
    (
      row,
    ): row is typeof row & {
      integrationId: string;
      integration: NonNullable<(typeof row)['integration']>;
    } => row.integration !== null,
  );
}

export type DetectorClaim = Awaited<ReturnType<typeof loadDetectorClaims>>[number];
type DetectorAttestation = DetectorClaim['attestations'][number];

// ─── Row helpers ─────────────────────────────────────────────────────────────

/** Live vendor votes — everything the agreement engine actually counts. The read
 *  already filters `retracted_at`, so this is only the AECi-seed exclusion. */
function vendorVotes(claim: DetectorClaim): DetectorAttestation[] {
  return claim.attestations.filter((a) => a.source !== 'aeci');
}

/** The engine's input shape, straight off the row (identical field names). */
function votesForEngine(claim: DetectorClaim): AgreementAttestation[] {
  return claim.attestations;
}

/** Which endpoint product a slot names (§2.1: A = source, B = target). */
function productForSlot(claim: DetectorClaim, slot: AttestationSlot): NotificationProductRef {
  const product =
    slot === 'vendor_a' ? claim.integration.sourceProduct : claim.integration.targetProduct;
  return { slug: product.slug, name: product.name };
}

function otherSlot(slot: AttestationSlot): AttestationSlot {
  return slot === 'vendor_a' ? 'vendor_b' : 'vendor_a';
}

/** Build the recipient-relative snapshot for a vendor sitting in `slot`. */
function contextForSlot(claim: DetectorClaim, slot: AttestationSlot): NotificationContext {
  return {
    mechanismName: claim.integration.mechanismName,
    dataObject: { slug: claim.dataObject.slug, name: claim.dataObject.name },
    subjectProduct: productForSlot(claim, slot),
    counterpartProduct: productForSlot(claim, otherSlot(slot)),
    pairSlugs: [claim.integration.sourceProduct.slug, claim.integration.targetProduct.slug],
  };
}

/** The ops-facing snapshot: no "own" side, so A is subject and B is counterpart. */
function contextForOps(claim: DetectorClaim): NotificationContext {
  return contextForSlot(claim, 'vendor_a');
}

/** Oldest / newest `created_at` in an attestation set. ISO-8601 TEXT sorts
 *  lexically, so a string compare is the date compare (the `schema.ts` §11
 *  convention `reconciliation-sweep.ts` already relies on). */
function oldestCreatedAt(rows: readonly DetectorAttestation[]): string | null {
  return rows.reduce<string | null>(
    (min, r) => (min === null || r.createdAt < min ? r.createdAt : min),
    null,
  );
}

function newestCreatedAt(rows: readonly DetectorAttestation[]): string | null {
  return rows.reduce<string | null>(
    (max, r) => (max === null || r.createdAt > max ? r.createdAt : max),
    null,
  );
}

function olderThan(iso: string | null, cutoffIso: string): boolean {
  return iso !== null && iso < cutoffIso;
}

function cutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

/**
 * The slots with **no live vendor attestation** — the side that has not spoken.
 *
 * Two detectors need exactly this set and must agree on it.
 * `silent-counterparty` reads it as "who has not answered yet";
 * `claim-denied` reads it as "who is the counterparty of the denial", which on a
 * refuted claim is the same set by construction, because every live voter denied.
 *
 * It also carries the owns-both-endpoints guard for free. A vendor owning both
 * slots writes every owned slot on one PUT (§5.2), so both slots are occupied and
 * this returns empty — no self-nudge, and no "we told the other vendor" when
 * there is no other vendor.
 */
function unvotedSlots(claim: DetectorClaim): readonly AttestationSlot[] {
  const occupied = new Set<string>(vendorVotes(claim).map((v) => v.source));
  return (['vendor_a', 'vendor_b'] as const).filter((slot) => !occupied.has(slot));
}

// ─── silent-counterparty ─────────────────────────────────────────────────────

/**
 * A claim at `single_source` for more than {@link SILENT_COUNTERPARTY_DAYS},
 * nudging the vendors on the **silent** slot.
 *
 * The age is measured from the *earliest* live affirming vote — how long the
 * claim has actually been one-sided. Using the newest would let a vendor's
 * re-confirmation reset a clock the silent side never touched.
 *
 * Two cases yield nothing, both correctly:
 * - one company owning **both** endpoints affirms both slots. §4.5 collapses that
 *   to one voter, so the state is `single_source` — but there is no silent slot
 *   and nobody to nudge.
 * - the silent product has no `product_vendors` row. Nobody has claimed it, so
 *   there is no seat to email; that is AECi's outreach problem, not a nudge.
 */
export function detectSilentCounterparty(
  claimRows: readonly DetectorClaim[],
  slotVendors: ReadonlyMap<string, IntegrationSlotVendors>,
  now: Date,
): DetectorFinding[] {
  const cutoffIso = cutoff(now, SILENT_COUNTERPARTY_DAYS);
  const out: DetectorFinding[] = [];

  for (const claim of claimRows) {
    if (computeAgreement(votesForEngine(claim)) !== 'single_source') continue;

    const votes = vendorVotes(claim);
    const silent = unvotedSlots(claim);
    if (silent.length === 0) continue;

    if (!olderThan(oldestCreatedAt(votes.filter((v) => v.asserted)), cutoffIso)) continue;

    for (const slot of silent) {
      for (const vendorId of slotVendors.get(claim.integrationId)?.slots[slot] ?? []) {
        out.push({
          detector: 'silent-counterparty',
          claimId: claim.id,
          integrationId: claim.integrationId,
          vendorId,
          context: contextForSlot(claim, slot),
        });
      }
    }
  }
  return out;
}

// ─── open-conflict ───────────────────────────────────────────────────────────

/**
 * A claim at `conflict` for more than {@link OPEN_CONFLICT_DAYS}: both disputants
 * plus one AECi ops finding.
 *
 * Age runs from the **newest** live vendor vote — the moment the disagreement
 * came into being. (Silent-counterparty measures from the oldest, for the mirror
 * reason: there the clock is on the side that has *not* acted.)
 *
 * Recipients are the **attesting** vendors, not the slot occupants. `conflict`
 * means two identities took opposing positions, and those identities are on the
 * rows; a co-owner of the same product who never voted is not party to the
 * dispute. An orphaned vote (`attested_by_vendor_id` nulled by `ON DELETE SET
 * NULL`) has nobody to notify and is skipped — the ops finding still fires, which
 * is the point of raising it.
 */
export function detectOpenConflict(
  claimRows: readonly DetectorClaim[],
  now: Date,
): DetectorFinding[] {
  const cutoffIso = cutoff(now, OPEN_CONFLICT_DAYS);
  const out: DetectorFinding[] = [];

  for (const claim of claimRows) {
    if (computeAgreement(votesForEngine(claim)) !== 'conflict') continue;

    const votes = vendorVotes(claim);
    if (!olderThan(newestCreatedAt(votes), cutoffIso)) continue;

    // One finding per disputant, in the slot that vendor actually attested on.
    const seen = new Set<string>();
    for (const vote of votes) {
      const vendorId = vote.attestedByVendorId;
      if (vendorId === null || seen.has(vendorId)) continue;
      seen.add(vendorId);
      out.push({
        detector: 'open-conflict',
        claimId: claim.id,
        integrationId: claim.integrationId,
        vendorId,
        context: contextForSlot(claim, vote.source === 'vendor_b' ? 'vendor_b' : 'vendor_a'),
      });
    }

    out.push({
      detector: 'open-conflict',
      claimId: claim.id,
      integrationId: claim.integrationId,
      vendorId: null,
      context: contextForOps(claim),
    });
  }
  return out;
}

// ─── stale-version ───────────────────────────────────────────────────────────

/** Whether an attestation carries any version information at all — either of the
 *  AECI-607 version ids or either of the Stage 1.5 coarse date stamps. */
function hasVersionData(a: DetectorAttestation): boolean {
  return (
    a.introducedVersionId !== null ||
    a.deprecatedVersionId !== null ||
    a.introducedAt !== null ||
    a.deprecatedAt !== null
  );
}

/**
 * A live vendor **affirmation** that should be re-confirmed, either because it has
 * aged past {@link STALE_VERSION_MONTHS} with no version data, or because it
 * still asserts a flow whose deprecated version has already passed.
 *
 * Both clauses are restricted to affirmations. The re-confirm email describes the
 * flow as one the vendor recorded ("Your record that X moves between …"), so a
 * denial must not enter here — chasing a vendor to re-confirm a "no" would invert
 * their position. The second clause additionally carries **no age threshold** —
 * "the version this ended in is gone" is a fact, not a duration. Either way the
 * vendor's remedy (retract or extend the attestation) removes the row from this
 * detector, so it terminates rather than nagging forever.
 *
 * `sunset_at` on the linked `product_versions` row is the authority; the coarse
 * `deprecated_at` date is the fallback for an attestation stamped before AECI-607
 * gave versions an entity. Both are ISO dates, compared as strings.
 */
export function detectStaleVersion(
  claimRows: readonly DetectorClaim[],
  now: Date,
): DetectorFinding[] {
  const nowIso = now.toISOString();
  const ageCutoffIso = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth() - STALE_VERSION_MONTHS,
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  ).toISOString();
  const out: DetectorFinding[] = [];

  for (const claim of claimRows) {
    // One finding per (claim, vendor): a vendor holding both slots with two stale
    // rows is one thing to fix, and the ledger key cannot distinguish them anyway.
    const seen = new Set<string>();
    for (const vote of vendorVotes(claim)) {
      const vendorId = vote.attestedByVendorId;
      if (vendorId === null || seen.has(vendorId)) continue;

      const aged = vote.asserted && vote.createdAt < ageCutoffIso && !hasVersionData(vote);
      const deprecationPassed =
        vote.asserted &&
        ((vote.deprecatedVersion?.sunsetAt ?? null) !== null
          ? vote.deprecatedVersion!.sunsetAt! < nowIso
          : vote.deprecatedAt !== null && vote.deprecatedAt < nowIso);
      if (!aged && !deprecationPassed) continue;

      seen.add(vendorId);
      out.push({
        detector: 'stale-version',
        claimId: claim.id,
        integrationId: claim.integrationId,
        vendorId,
        context: contextForSlot(claim, vote.source === 'vendor_b' ? 'vendor_b' : 'vendor_a'),
      });
    }
  }
  return out;
}

// ─── claim-denied ────────────────────────────────────────────────────────────

/**
 * A claim every voting vendor denies: **one AECi ops finding, plus one finding
 * per vendor on the unvoted slot.** Deliberately un-thresholded — it fires on the
 * next daily sweep.
 *
 * `isClaimRefuted` rather than an `unverified` check, because `unverified`
 * conflates "nobody voted" with "everybody said no" (§4.5) — only the latter is
 * a signal, and the whole reason the detector exists is that the model renders
 * the two identically.
 *
 * ── WHAT AECI-961 CHANGED, AND WHY ──────────────────────────────────────────
 * This detector shipped as `aeci-denied`: ops-only, and gated on
 * `claim.origin === 'aeci'`. Both halves were wrong, and the operator decision of
 * 2026-09-15 removed them together (`STAGE_2_ATTESTATIONS_SPEC.md` §6.2 / §7.1).
 *
 * **The origin gate left a dead state.** The reasoning was that a vendor denying
 * a claim it created is a self-correction the §5 API handles by retraction. It
 * does not: retraction withdraws a *position*, it does not remove the *claim*,
 * and no vendor route deletes a claim. So a vendor-origin claim every voter
 * denied reached nobody at all — not ops, not the counterparty — and sat on the
 * pair page as `unverified` forever. Any refuted claim now raises ops.
 *
 * **Ops-only left the denier with no receipt.** The portal could not honestly
 * tell a vendor what a Deny does, because the honest answer was "the other side
 * is never told". The counterparty now gets a finding too, on the same sweep,
 * with no age threshold: a delay would only make the lane's acknowledgement
 * vaguer, which is the defect being fixed.
 *
 * Three properties fall out of {@link unvotedSlots} rather than from code here,
 * and each has a test:
 * - a denier owning **both** endpoints has attested on both slots, so there is no
 *   unvoted slot and no vendor finding — only ops;
 * - a counterparty product with no `product_vendors` row yields no vendor
 *   finding, and the ops finding still fires;
 * - a connector-powered edge loses the vendor finding to
 *   {@link dropPromptsOnPoweredEdges} and keeps the ops one, with no code here.
 *
 * The one guard that *is* written out: a counterparty vendor id that also denied
 * is skipped. Slot occupancy comes from `product_vendors`, so one company can own
 * the unvoted product *and* have voted on the other slot, and emailing a vendor
 * about its own denial is the exact self-nudge the ops finding already covers.
 */
export function detectClaimDenied(
  claimRows: readonly DetectorClaim[],
  slotVendors: ReadonlyMap<string, IntegrationSlotVendors>,
): DetectorFinding[] {
  const out: DetectorFinding[] = [];
  for (const claim of claimRows) {
    if (!isClaimRefuted(votesForEngine(claim))) continue;

    out.push({
      detector: 'claim-denied',
      claimId: claim.id,
      integrationId: claim.integrationId,
      vendorId: null,
      context: contextForOps(claim),
    });

    const deniers = new Set(
      vendorVotes(claim)
        .map((v) => v.attestedByVendorId)
        .filter((id): id is string => id !== null),
    );
    for (const slot of unvotedSlots(claim)) {
      for (const vendorId of slotVendors.get(claim.integrationId)?.slots[slot] ?? []) {
        if (deniers.has(vendorId)) continue;
        out.push({
          detector: 'claim-denied',
          claimId: claim.id,
          integrationId: claim.integrationId,
          vendorId,
          context: contextForSlot(claim, slot),
        });
      }
    }
  }
  return out;
}

// ─── The AECI-705 connector gate ─────────────────────────────────────────────

/**
 * Which of the swept claims sit on a **connector-powered** edge (§14).
 *
 * Built from the rows the shared read already hydrated, so the gate costs no
 * extra query — and it uses `isConnectorPoweredEdge`, the one definition of the
 * union, rather than restating either half here.
 */
function connectorPoweredIntegrationIds(claimRows: readonly DetectorClaim[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const claim of claimRows) {
    if (isConnectorPoweredEdge(claim.integration)) out.add(claim.integrationId);
  }
  return out;
}

/**
 * Drop every **vendor-addressed** finding on a connector-powered edge, and keep
 * every ops-routed one.
 *
 * This is a literal transcription of the acceptance criterion — "no vendor is
 * ever prompted to confirm/deny plumbing they didn't build" — which is why it
 * lives here, once, at the registry, instead of as four edits inside four
 * detectors. Any detector added later inherits it without anyone remembering to,
 * and the property is checkable by reading one function.
 *
 * **`vendorId === null` means AECi ops, and those findings survive on purpose.**
 * Both `claim-denied` and `open-conflict` raise an ops finding alongside their
 * vendor nudges. Those are AECi's correction signal on its *own* curation, not a
 * nudge to someone who built nothing — suppressing them would hide exactly the
 * case an operator needs to see, which is a vendor disputing a powered edge it
 * attested before the edge became powered. (Since AECI-961 `claim-denied` also
 * carries a counterparty nudge, and that half IS dropped here, correctly: a
 * vendor who did not build the plumbing cannot answer for it either.)
 */
function dropPromptsOnPoweredEdges(
  findings: readonly DetectorFinding[],
  poweredEdges: ReadonlySet<string>,
): DetectorFinding[] {
  return findings.filter(
    (finding) => finding.vendorId === null || !poweredEdges.has(finding.integrationId),
  );
}

// ─── The registry ────────────────────────────────────────────────────────────

export interface DetectorDeps {
  db: Db;
  /** Injected for deterministic age math (the `runDailySync(…, new Date())` habit). */
  now?: Date;
}

/**
 * Run every detector over one shared read.
 *
 * Best-effort like `runDataQualityChecks`: a detector that throws yields an
 * `error` result and the others still report, because a partial sweep beats a
 * silent one. A failure of the *read itself* propagates — the queue consumer
 * retries, which is safe: detection is pure and the ledger makes the send
 * idempotent.
 */
export async function runAttestationDetectors(deps: DetectorDeps): Promise<DetectorResult[]> {
  const now = deps.now ?? new Date();
  const claimRows = await loadDetectorClaims(deps.db);
  const slotVendors = await vendorsForIntegrationSlots(
    deps.db,
    claimRows.map((c) => c.integrationId),
  );
  const poweredEdges = connectorPoweredIntegrationIds(claimRows);

  const registry: ReadonlyArray<[AttestationDetector, () => DetectorFinding[]]> = [
    ['silent-counterparty', () => detectSilentCounterparty(claimRows, slotVendors, now)],
    ['open-conflict', () => detectOpenConflict(claimRows, now)],
    ['stale-version', () => detectStaleVersion(claimRows, now)],
    ['claim-denied', () => detectClaimDenied(claimRows, slotVendors)],
  ];

  return registry.map(([detector, run]) => {
    try {
      // Inside the `try`, so the per-detector gauge (`aeci.attestation.detector`,
      // `OBSERVABILITY.md`) counts what is actually SENT rather than what was
      // found — a number nobody can act on is worse than no number.
      return { detector, findings: dropPromptsOnPoweredEdges(run(), poweredEdges) };
    } catch (error) {
      return {
        detector,
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

/** Flatten a detector pass to the findings the sweep will act on. */
export function findingsOf(results: readonly DetectorResult[]): DetectorFinding[] {
  return results.flatMap((r) => r.findings);
}
