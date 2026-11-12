/**
 * Which Managed plan agreement version a Stripe charge binds (AECI-1690,
 * `VENDOR_SIGNUP_PROCESS.md` §2 decision 9 and §3 step 9, ADR 0047 decision 9). A license
 * carries the version it is bound to (`licenses.terms_version`). A renewal charge may move
 * it to a later one. Nothing here ends, pauses or changes a Stripe subscription: a version
 * that cannot bind is simply not bound.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────────
 * The renewal moment is the new period's start (the caller passes it). The target is the
 * version in force at that moment, by the one rule (`legalAgreementVersionInForce`,
 * AECI-1689: 12:00 UTC of the effective day, and a published row for an upcoming version).
 * Each license walks from ITS OWN version, oldest first, up to the target:
 *
 *   - **Never lower.** A license at or above the target keeps its version.
 *   - **Annual** stops below the first version that was not announced in this renewal's
 *     notice: a published row whose `published_at` is later than the renewal moment less
 *     {@link RENEWAL_NOTICE_DAYS} (the agreement: "We announce it in the renewal notice sent
 *     45 days before your renewal date"). It binds at the following renewal instead. The
 *     45-day notice asks the same function, so the two cannot disagree.
 *   - **Monthly** stops below the first version whose published row has
 *     `requires_acceptance` (a final version; a draft never needs one) and that no
 *     acceptance of the company covers (`acceptanceCovers`, AECI-1677: any source, a final
 *     version at or after it). Only acceptances recorded at or before the renewal moment
 *     count: a later click binds at the next charge, never mid-period.
 *
 * A stopping version is reported (`withheld` for an acceptance, `unannounced` for the
 * notice). So a later version without the flag never carries an unaccepted change past the
 * click, and a license on 1.2 never jumps past an unaccepted 1.3 because a sibling is on 1.4.
 *
 * A checkout, a grant, a complimentary or a pilot subscription never comes here: a new
 * checkout stamps the version in force at request time (`routes/vendor-billing-stripe.ts`),
 * and a grant keeps its grant-date version for its term (AECI-1615).
 *
 * ── NO READ UNLESS IT CAN MATTER ─────────────────────────────────────────────────
 * {@link loadTermsBinding} reads `legal_versions` only when an upcoming version's moment
 * has come, or when a walk would pass a version that is not a draft in code. It reads
 * acceptances only when a monthly walk passes a version that needs one. With today's data
 * (every version a draft, no upcoming entry) a renewal reads nothing and binds the build's
 * current version, exactly as before AECI-1690.
 *
 * Version order is numeric, through `compareLegalVersions` ('1.10' is after '1.9').
 */

import {
  compareLegalVersions,
  legalAgreementVersionInForce,
  legalInForceNeedsPublished,
  LEGAL_AGREEMENT_KNOWN_VERSIONS,
  LEGAL_IN_FORCE_MAPS,
  type LegalInForceMaps,
} from '@aeci/shared';
import { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';
import { and, eq, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, legalVersions } from '../db/schema';
import { acceptancesOfVendor } from './agreement-acceptances';
import {
  acceptanceCovers,
  effectiveAtMsOf,
  isDraftInCode,
  type AcceptedVersionLite,
  type PublishedVersionLite,
} from './legal-acceptance';

const DOC = 'managed_plan' as const;
const DAY_MS = 86_400_000;

/** The metric and warn log of a charge that left a license on an unaccepted version. */
export const UNACCEPTED_TERMS_CHARGE_METRIC = 'aeci.billing.unaccepted_terms_charge';

/**
 * How far ahead of an annual renewal a version must be published to bind at it. The
 * renewal notice's own horizon (`EXPIRY_WARNING_DAYS`), never a second constant: a version
 * published inside it was not in the notice.
 */
export const RENEWAL_NOTICE_DAYS = EXPIRY_WARNING_DAYS;

export type TermsBindingInterval = 'month' | 'year';

/** A `legal_versions` row as the bind reads it. */
export interface TermsPublishedRow extends PublishedVersionLite {
  /** ISO-8601. */
  publishedAt: string;
}

/** An acceptance as the bind reads it. */
export interface TermsAcceptedRow extends AcceptedVersionLite {
  /** ISO-8601. */
  acceptedAt: string;
}

/** What a charge binds, for one license version. */
export interface TermsBinding {
  /** The version the license carries after the charge. `null` only when it carried none
   *  and nothing could bind. */
  version: string | null;
  /** Monthly: the version that would have bound and did not, because no acceptance made
   *  by the renewal moment covers it. */
  withheld: string | null;
  /** Annual: the version that would have bound and did not, because it was published too
   *  late for this renewal's notice. */
  unannounced: string | null;
}

/** What {@link bindTermsVersion} decides from. Every read is done by the caller. */
export interface TermsBindingInput {
  interval: TermsBindingInterval;
  /** The renewal moment, epoch ms: the new period's start. */
  renewalAtMs: number;
  /** The version the license carries, or `null`. */
  boundVersion: string | null;
  /** The `managed_plan` rows of `legal_versions` (others are ignored). */
  published: readonly TermsPublishedRow[];
  /** The company's `managed_plan` acceptances (others are ignored). Those recorded after
   *  the renewal moment are ignored too. */
  accepted: readonly TermsAcceptedRow[];
  maps?: LegalInForceMaps;
}

/** The highest of some versions, numerically. `null` when none is given. */
export function highestTermsVersion(versions: Iterable<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!v) continue;
    if (best === null || compareLegalVersions(v, best) > 0) best = v;
  }
  return best;
}

/** The lowest of some versions, numerically. `null` sorts first: a license with none. */
function lowestTermsVersion(versions: readonly (string | null)[]): string | null {
  if (versions.some((v) => v === null)) return null;
  return [...(versions as string[])].sort(compareLegalVersions)[0] ?? null;
}

/** Every version the code knows of: the archive list, the current and the upcoming one. */
function codeVersions(maps: LegalInForceMaps): string[] {
  const upcoming = maps.agreementUpcoming[DOC];
  return [
    ...(LEGAL_AGREEMENT_KNOWN_VERSIONS[DOC] as readonly string[]),
    maps.agreementCurrent[DOC],
    ...(upcoming ? [upcoming.version] : []),
  ];
}

/** The distinct versions above `above` (exclusive) and up to `upTo` (inclusive), oldest first. */
function versionsBetween(all: Iterable<string>, above: string | null, upTo: string): string[] {
  return [...new Set(all)]
    .filter(
      (v) =>
        compareLegalVersions(v, upTo) <= 0 &&
        (above === null || compareLegalVersions(v, above) > 0),
    )
    .sort(compareLegalVersions);
}

function rowOf(version: string, published: readonly PublishedVersionLite[]) {
  return published.find((r) => r.document === DOC && r.version === version);
}

/** Whether `version` has a published, final row that needs an acceptance. */
function needsAcceptance(version: string, published: readonly PublishedVersionLite[]): boolean {
  return (
    rowOf(version, published)?.requiresAcceptance === true &&
    effectiveAtMsOf(DOC, version, published) !== null
  );
}

/**
 * Whether `version` was announced in the notice of an annual renewal at `renewalAtMs`:
 * it has no publish to announce (a version that switched without a row, as every version
 * did before AECI-1688), or it was published at least {@link RENEWAL_NOTICE_DAYS} before.
 */
export function announcedForRenewal(
  version: string,
  published: readonly TermsPublishedRow[],
  renewalAtMs: number,
): boolean {
  const row = rowOf(version, published) as TermsPublishedRow | undefined;
  if (!row) return true;
  const at = Date.parse(row.publishedAt);
  return Number.isFinite(at) && at <= renewalAtMs - RENEWAL_NOTICE_DAYS * DAY_MS;
}

/** Every version a walk can name: the code's and the published rows'. */
function allVersions(maps: LegalInForceMaps, published: readonly PublishedVersionLite[]): string[] {
  return [
    ...codeVersions(maps),
    ...published.filter((r) => r.document === DOC).map((r) => r.version),
  ];
}

/** The acceptances recorded at or before `atMs`. */
function acceptedBy(accepted: readonly TermsAcceptedRow[], atMs: number): TermsAcceptedRow[] {
  return accepted.filter((a) => {
    const at = Date.parse(a.acceptedAt);
    return Number.isFinite(at) && at <= atMs;
  });
}

/**
 * The first version above `from` and up to `to` that needs an acceptance no acceptance
 * covers, or `null`. The tripwire's test: pass the acceptances counted at the charge.
 */
export function firstUncoveredVersion(
  from: string | null,
  to: string,
  published: readonly PublishedVersionLite[],
  accepted: readonly AcceptedVersionLite[],
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string | null {
  for (const v of versionsBetween(allVersions(maps, published), from, to)) {
    if (needsAcceptance(v, published) && !acceptanceCovers(DOC, v, accepted, published)) return v;
  }
  return null;
}

/** The version a charge binds to one license (module header). Pure. */
export function bindTermsVersion(input: TermsBindingInput): TermsBinding {
  const maps = input.maps ?? LEGAL_IN_FORCE_MAPS;
  const { boundVersion: bound, published, renewalAtMs } = input;
  const target = legalAgreementVersionInForce(DOC, published, renewalAtMs, maps);
  if (bound !== null && compareLegalVersions(target, bound) <= 0) {
    return { version: bound, withheld: null, unannounced: null };
  }
  const accepted = acceptedBy(input.accepted, renewalAtMs);
  let last = bound;
  for (const v of versionsBetween(allVersions(maps, published), bound, target)) {
    if (input.interval === 'year' && !announcedForRenewal(v, published, renewalAtMs)) {
      return { version: last, withheld: null, unannounced: v };
    }
    if (
      input.interval === 'month' &&
      needsAcceptance(v, published) &&
      !acceptanceCovers(DOC, v, accepted, published)
    ) {
      return { version: last, withheld: v, unannounced: null };
    }
    last = v;
  }
  return { version: target, withheld: null, unannounced: null };
}

/** Whether a walk from `lowest` can need the published rows (module header). */
export function termsRowsMayMatter(
  atMs: number,
  lowest: string | null,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  // Without a row the target is the build's current version, and only a version that is
  // not a draft in code can have a row to stop or flag on.
  return (
    legalInForceNeedsPublished(atMs, maps) ||
    versionsBetween(codeVersions(maps), lowest, maps.agreementCurrent[DOC]).some(
      (v) => !isDraftInCode(DOC, v),
    )
  );
}

/** Every `managed_plan` row of `legal_versions`, as the bind reads it. */
export function loadTermsPublished(db: Db): Promise<TermsPublishedRow[]> {
  return db
    .select({
      document: legalVersions.document,
      version: legalVersions.version,
      effectiveAt: legalVersions.effectiveAt,
      requiresAcceptance: legalVersions.requiresAcceptance,
      summaryJson: legalVersions.summaryJson,
      publishedAt: legalVersions.publishedAt,
    })
    .from(legalVersions)
    .where(eq(legalVersions.document, DOC));
}

/** What {@link loadTermsBinding} needs to know about the charge. */
export interface TermsBindingRequest {
  vendorId: string;
  interval: TermsBindingInterval;
  renewalAt: Date;
  /** The versions the subscription's licenses carry, one entry per license is fine. */
  boundVersions: readonly (string | null)[];
  maps?: LegalInForceMaps;
}

/** The rows a charge was decided from, and the bind for each version a license carries. */
export interface LoadedTermsBinding {
  published: readonly TermsPublishedRow[];
  /** The acceptances counted at the charge: recorded at or before the renewal moment. */
  accepted: readonly TermsAcceptedRow[];
  /** The bind for a license carrying `version`. */
  bindFrom(version: string | null): TermsBinding;
}

/**
 * {@link bindTermsVersion} with its reads, each only when it can change the answer (module
 * header). Throws only on a D1 error.
 */
export async function loadTermsBinding(
  db: Db,
  req: TermsBindingRequest,
): Promise<LoadedTermsBinding> {
  const maps = req.maps ?? LEGAL_IN_FORCE_MAPS;
  const atMs = req.renewalAt.getTime();
  const lowest = lowestTermsVersion(req.boundVersions);
  const published = termsRowsMayMatter(atMs, lowest, maps) ? await loadTermsPublished(db) : [];

  const target = legalAgreementVersionInForce(DOC, published, atMs, maps);
  const needAccepted =
    req.interval === 'month' &&
    versionsBetween(allVersions(maps, published), lowest, target).some((v) =>
      needsAcceptance(v, published),
    );
  const accepted: TermsAcceptedRow[] = needAccepted
    ? await db
        .select({
          document: agreementAcceptances.document,
          version: agreementAcceptances.version,
          acceptedAt: agreementAcceptances.acceptedAt,
        })
        .from(agreementAcceptances)
        .where(
          and(
            acceptancesOfVendor(db, req.vendorId),
            eq(agreementAcceptances.document, DOC),
            // ISO-8601 throughout, so the string order is the time order.
            lte(agreementAcceptances.acceptedAt, req.renewalAt.toISOString()),
          ),
        )
    : [];

  return {
    published,
    accepted,
    bindFrom: (version) =>
      bindTermsVersion({
        interval: req.interval,
        renewalAtMs: atMs,
        boundVersion: version,
        published,
        accepted,
        maps,
      }),
  };
}
