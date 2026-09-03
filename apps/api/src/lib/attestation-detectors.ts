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
 *   • `aeci-denied`        — a vendor denies an AECi-seeded claim. This is a
 *     correction signal to **AECi**, not a vendor nudge: a denial-only claim
 *     computes `unverified` (§4.2), so it is invisible on every surface. Without
 *     this detector the vendor's "no, we don't do that" is silently swallowed.
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
import type { Db } from '../db/client';
import { attestations, claims } from '../db/schema';

const DAY_MS = 86_400_000;

/** A claim one-sided (`single_source`) for longer than this nudges the silent
 *  slot's vendor. Long enough that a vendor who simply hasn't opened the portal
 *  yet is not chased, short enough that the context is still fresh. */
export const SILENT_COUNTERPARTY_DAYS = 14;

/** An unresolved `conflict` older than this nudges **both** disputants and raises
 *  AECi ops. Tighter than the silent threshold on purpose: a live vendor-vs-vendor
 *  disagreement is the lowest-volume, highest-signal state in the model. */
export const OPEN_CONFLICT_DAYS = 7;

/** A live vendor attestation older than this with **no** version data at all is
 *  asked to re-confirm — an annual cadence rather than a rolling nag. Note that
 *  nothing in D1 carries version stamps yet (AECI-607 shipped the columns; no
 *  backfill), so at launch this is the only clause that can ever match. */
export const STALE_VERSION_MONTHS = 12;

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
    where: and(inArray(claims.id, vendorAttestedClaimIds), isNotNull(claims.integrationId)),
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
    const occupied = new Set<string>(votes.map((v) => v.source));
    const silent = (['vendor_a', 'vendor_b'] as const).filter((slot) => !occupied.has(slot));
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

// ─── aeci-denied ─────────────────────────────────────────────────────────────

/**
 * An **AECi-seeded** claim every voting vendor denies. Ops-only, and deliberately
 * un-thresholded: this is a correction to AECi's own curation, and there is
 * nothing for the vendor to do that it has not already done.
 *
 * `isClaimRefuted` rather than an `unverified` check, because `unverified`
 * conflates "nobody voted" with "everybody said no" (§4.5) — only the latter is
 * a signal, and the whole reason the detector exists is that the model renders
 * the two identically.
 *
 * `origin = 'vendor'` claims are excluded: a vendor denying a claim it created
 * itself is a self-correction the §5 API already handles by retraction, not an
 * AECi curation error.
 */
export function detectAeciDenied(claimRows: readonly DetectorClaim[]): DetectorFinding[] {
  const out: DetectorFinding[] = [];
  for (const claim of claimRows) {
    if (claim.origin !== 'aeci') continue;
    if (!isClaimRefuted(votesForEngine(claim))) continue;
    out.push({
      detector: 'aeci-denied',
      claimId: claim.id,
      integrationId: claim.integrationId,
      vendorId: null,
      context: contextForOps(claim),
    });
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
 * `aeci-denied` is ops-routed by definition (§7.1) and `open-conflict` raises an
 * ops finding alongside its two vendor nudges. Those are AECi's correction signal
 * on its *own* curation, not a nudge to someone who built nothing — suppressing
 * them would hide exactly the case an operator needs to see, which is a vendor
 * disputing a powered edge it attested before the edge became powered.
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
    ['aeci-denied', () => detectAeciDenied(claimRows)],
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
