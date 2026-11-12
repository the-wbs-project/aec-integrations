/**
 * Which Managed plan agreement version a Stripe charge binds (AECI-1690,
 * `VENDOR_SIGNUP_PROCESS.md` §2 decision 9 and §3 step 9, ADR 0047 "Renewal binds the bound
 * version"). A license carries the version it is bound to (`licenses.terms_version`). A
 * renewal charge may move it to a later one. Nothing here ends, pauses or changes a Stripe
 * subscription: a version that cannot bind is simply not bound.
 *
 * ── THE RULES ────────────────────────────────────────────────────────────────────
 * The renewal moment is the new period's start (the caller passes it). The target is the
 * version in force at that moment, by the one rule (`legalAgreementVersionInForce`,
 * AECI-1689: 12:00 UTC of the effective day, and a published row for an upcoming version).
 *
 *   - **Never lower.** A license already at or above the target keeps its version.
 *   - **Annual** binds the target.
 *   - **Monthly** walks every version above the bound one, up to the target, oldest first.
 *     A version needs an acceptance when its published row has `requires_acceptance` and
 *     it is final (a draft never does, `isDraftInCode`). The first such version that no
 *     acceptance of the company covers (`acceptanceCovers`, AECI-1677: any source, a
 *     final version at or after it) stops the walk. The bind is the highest version below
 *     it, and it is reported as `withheld`. So a later version without the flag never
 *     carries an unaccepted change past the click.
 *
 * A checkout, a grant, a complimentary or a pilot subscription never comes here: a new
 * checkout stamps the version in force at request time (`routes/vendor-billing-stripe.ts`),
 * and a grant keeps its grant-date version for its term (AECI-1615).
 *
 * ── NO READ UNLESS IT CAN MATTER ─────────────────────────────────────────────────
 * {@link loadTermsBinding} reads `legal_versions` only when an upcoming version's moment
 * has come, or when a monthly charge would pass a version that is not a draft in code.
 * It reads acceptances only when a version on the way needs one. With today's data (every
 * version a draft, no upcoming entry) a renewal reads nothing and binds the build's
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
  type LegalPublishedLite,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances } from '../db/schema';
import { acceptancesOfVendor } from './agreement-acceptances';
import {
  acceptanceCovers,
  effectiveAtMsOf,
  isDraftInCode,
  publishedVersionsSelect,
  type AcceptedVersionLite,
  type PublishedVersionLite,
} from './legal-acceptance';

const DOC = 'managed_plan' as const;

/** The metric and warn log of a charge that left a license on an unaccepted version. */
export const UNACCEPTED_TERMS_CHARGE_METRIC = 'aeci.billing.unaccepted_terms_charge';

export type TermsBindingInterval = 'month' | 'year';

/** What a charge binds. */
export interface TermsBinding {
  /** The version the licenses carry after the charge. `null` only when they carried none
   *  and nothing could bind. */
  version: string | null;
  /** The version that would have bound and did not, because no acceptance covers it.
   *  `null` when nothing was held back. Monthly only. */
  withheld: string | null;
}

/** What {@link bindTermsVersion} decides from. Every read is done by the caller. */
export interface TermsBindingInput {
  interval: TermsBindingInterval;
  /** The renewal moment, epoch ms: the new period's start. */
  renewalAtMs: number;
  /** The highest version the subscription's live licenses carry, or `null`. */
  boundVersion: string | null;
  /** The `managed_plan` rows of `legal_versions` (others are ignored). */
  published: readonly PublishedVersionLite[];
  /** The company's `managed_plan` acceptances (others are ignored). */
  accepted: readonly AcceptedVersionLite[];
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

/** Whether `version` has a published, final row that needs an acceptance. */
function needsAcceptance(version: string, published: readonly PublishedVersionLite[]): boolean {
  return published.some(
    (r) =>
      r.document === DOC &&
      r.version === version &&
      r.requiresAcceptance &&
      effectiveAtMsOf(DOC, version, published) !== null,
  );
}

/** Every version a walk can name: the code's and the published rows'. */
function allVersions(maps: LegalInForceMaps, published: readonly PublishedVersionLite[]): string[] {
  return [
    ...codeVersions(maps),
    ...published.filter((r) => r.document === DOC).map((r) => r.version),
  ];
}

/**
 * The first version above `from` and up to `to` that needs an acceptance no acceptance
 * covers, or `null`. The walk of {@link bindTermsVersion}, and the tripwire's test.
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

/**
 * The version an annual renewal at `renewalAtMs` binds: the version in force then, never
 * lower than `bound`. The 45-day renewal notice names it ahead of the date
 * (`lib/entitlement-expiry.ts`). Pure.
 */
export function annualBoundVersion(
  published: readonly LegalPublishedLite[],
  renewalAtMs: number,
  bound: string | null,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string {
  const target = legalAgreementVersionInForce(DOC, published, renewalAtMs, maps);
  return bound !== null && compareLegalVersions(target, bound) > 0 ? target : (bound ?? target);
}

/** The version a charge binds (module header). Pure. */
export function bindTermsVersion(input: TermsBindingInput): TermsBinding {
  const maps = input.maps ?? LEGAL_IN_FORCE_MAPS;
  const { boundVersion: bound, published, accepted } = input;
  const target = legalAgreementVersionInForce(DOC, published, input.renewalAtMs, maps);
  if (bound !== null && compareLegalVersions(target, bound) <= 0) {
    return { version: bound, withheld: null };
  }
  if (input.interval === 'year') {
    return {
      version: annualBoundVersion(published, input.renewalAtMs, bound, maps),
      withheld: null,
    };
  }

  let last = bound;
  for (const v of versionsBetween(allVersions(maps, published), bound, target)) {
    if (needsAcceptance(v, published) && !acceptanceCovers(DOC, v, accepted, published)) {
      return { version: last, withheld: v };
    }
    last = v;
  }
  return { version: target, withheld: null };
}

/** What {@link loadTermsBinding} needs to know about the charge. */
export interface TermsBindingRequest {
  vendorId: string;
  interval: TermsBindingInterval;
  renewalAt: Date;
  boundVersion: string | null;
  maps?: LegalInForceMaps;
}

/** {@link TermsBinding} plus the rows it was decided from, for the tripwire. */
export interface LoadedTermsBinding extends TermsBinding {
  published: readonly PublishedVersionLite[];
  accepted: readonly AcceptedVersionLite[];
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
  const bound = req.boundVersion;
  // Without a row the target is the build's current version. A monthly walk up to it can
  // only stop at a version that is final, and a draft in code never is.
  const needRows =
    legalInForceNeedsPublished(atMs, maps) ||
    (req.interval === 'month' &&
      versionsBetween(codeVersions(maps), bound, maps.agreementCurrent[DOC]).some(
        (v) => !isDraftInCode(DOC, v),
      ));
  const published = needRows
    ? (await publishedVersionsSelect(db)).filter((r) => r.document === DOC)
    : [];

  const target = legalAgreementVersionInForce(DOC, published, atMs, maps);
  const needAccepted =
    req.interval === 'month' &&
    versionsBetween(allVersions(maps, published), bound, target).some((v) =>
      needsAcceptance(v, published),
    );
  const accepted = needAccepted
    ? await db
        .select({ document: agreementAcceptances.document, version: agreementAcceptances.version })
        .from(agreementAcceptances)
        .where(and(acceptancesOfVendor(db, req.vendorId), eq(agreementAcceptances.document, DOC)))
    : [];

  return {
    ...bindTermsVersion({
      interval: req.interval,
      renewalAtMs: atMs,
      boundVersion: bound,
      published,
      accepted,
      maps,
    }),
    published,
    accepted,
  };
}
