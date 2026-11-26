/**
 * Which version of a legal document is in force at a moment (AECI-1689, `STAGE_1_SPEC.md`
 * §27.3, `apps/web/src/content/legal/README.md` "The effective date switches by itself").
 * The ONE rule. The API Worker, the SSR Worker and the browser all call it, so the legal
 * page, the stamp on a new acceptance and the acceptance screen agree on one version.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────
 * A document has its build's current version (the current file's frontmatter, mirrored in
 * `LEGAL_AGREEMENT_CURRENT_VERSIONS` / `LEGAL_READER_CURRENT_VERSIONS` /
 * `LEGAL_POLICY_CURRENT_VERSIONS` and the web manifest's `LEGAL_CURRENT_VERSIONS`) and at
 * most one upcoming version (`LEGAL_UPCOMING`, mirrored here for all six). The upcoming
 * version is in force from its effective moment, 12:00 UTC of `effectiveOn`
 * (`legalEffectiveAtMs`), when:
 *
 *   - the document is one of the six PUBLISHABLE documents (Vendor Terms, Managed plan
 *     agreement, since AECI-1637 the Terms of Service and the Privacy Policy, and since
 *     AECI-1969 the Review Guidelines and the Listing Accuracy Policy), and a
 *     `legal_versions` row names that version with the same effective moment. A row means
 *     it was published, so its change notice went out. No row, no switch, on every surface
 *     (ruling 2 of 2026-11-13 for the reader documents, ruling 54 for the policies).
 *     Publishing is refused in demo and production while `LEGAL_PUBLISH_ENABLED` is
 *     "false", so a first effective date waits for that release.
 *
 * Before AECI-1969 a policy switched on its date alone, with the site-wide band as its
 * notice. Counsel's Q68 answer: a policy change is a change to what a vendor agreed to, so
 * it takes the Vendor Terms email. A company whose email did not go stays on the policy
 * version it accepted (`companyPolicyVersion` in `./policy-binding`).
 *
 * Otherwise the build's current version stays in force. Before the moment nothing changes.
 * A row whose moment differs from the manifest's (the date moved after a publish) does not
 * switch: the notice named the other date, so the safe answer is the old version.
 *
 * Bump day (moving the file, bumping the constants, removing the upcoming entry) gives the
 * same answer as the switch already did, so it can land any day after the moment.
 * `legal-bump-equivalence.spec.ts` (web) pins that for every surface.
 *
 * Pure. Never reads the clock: every caller passes `nowMs`.
 */

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_EFFECTIVE_ON,
  LEGAL_AGREEMENT_KNOWN_VERSIONS,
  LEGAL_AGREEMENT_UPCOMING_VERSIONS,
  LEGAL_POLICY_CURRENT_VERSIONS,
  LEGAL_POLICY_DOCUMENTS,
  LEGAL_POLICY_UPCOMING_VERSIONS,
  LEGAL_READER_CURRENT_VERSIONS,
  LEGAL_READER_DOCUMENTS,
  LEGAL_READER_EFFECTIVE_ON,
  LEGAL_READER_KNOWN_VERSIONS,
  LEGAL_READER_UPCOMING_VERSIONS,
  type LegalAgreementDocument,
  type LegalAgreementUpcomingVersion,
  type LegalPolicyDocument,
  type LegalPublishableDocument,
  type LegalReaderDocument,
} from './agreements';
import { legalEffectiveAtMs } from './legal-moment';

/** One `legal_versions` row as the rule reads it. `effectiveAt` is epoch ms. */
export interface LegalPublishedLite {
  readonly document: string;
  readonly version: string;
  readonly effectiveAt: number;
}

/** The public read's rows (`LegalPublishedResponse.published`) as the rule reads them. */
export function legalPublishedLiteOf(
  rows: readonly { document: string; version: string; effective_at: string }[],
): LegalPublishedLite[] {
  return rows.map((r) => ({
    document: r.document,
    version: r.version,
    effectiveAt: Date.parse(r.effective_at),
  }));
}

/**
 * Whether the effective moment `effectiveAtMs` has come at `nowMs`. In force AT the moment,
 * not a millisecond after. A non-finite moment (a draft, a bad day) never comes. The one
 * comparison: the acceptance screen (`apps/api/src/lib/legal-acceptance.ts`) uses it too.
 */
export function legalMomentReached(effectiveAtMs: number, nowMs: number): boolean {
  return Number.isFinite(effectiveAtMs) && effectiveAtMs <= nowMs;
}

/**
 * Whether `upcoming` has replaced the current version at `nowMs`. `published` is the
 * document's rows (a matching row is required). `null` lets the date alone decide: no
 * document is read that way since AECI-1969, and the branch stays for a spec's fixture.
 */
export function legalUpcomingInForce(
  document: string,
  upcoming: LegalAgreementUpcomingVersion | undefined,
  nowMs: number,
  published: readonly LegalPublishedLite[] | null,
): boolean {
  if (!upcoming) return false;
  const moment = legalEffectiveAtMs(upcoming.effectiveOn);
  if (!legalMomentReached(moment, nowMs)) return false;
  if (published === null) return true;
  return published.some(
    (r) => r.document === document && r.version === upcoming.version && r.effectiveAt === moment,
  );
}

/** The maps the rule reads. Injected by specs; the defaults are the shared constants. */
export interface LegalInForceMaps {
  readonly agreementCurrent: Readonly<Record<LegalAgreementDocument, string>>;
  readonly agreementUpcoming: Readonly<
    Partial<Record<LegalAgreementDocument, LegalAgreementUpcomingVersion>>
  >;
  readonly policyCurrent: Readonly<Record<LegalPolicyDocument, string>>;
  readonly policyUpcoming: Readonly<
    Partial<Record<LegalPolicyDocument, LegalAgreementUpcomingVersion>>
  >;
  /** `LEGAL_AGREEMENT_KNOWN_VERSIONS`. Absent: the shared constant. */
  readonly agreementKnown?: Readonly<Record<LegalAgreementDocument, readonly string[]>>;
  /** `LEGAL_AGREEMENT_EFFECTIVE_ON`. Absent: the shared constant. */
  readonly agreementEffectiveOn?: Readonly<
    Record<LegalAgreementDocument, Readonly<Record<string, string | null>>>
  >;
  /** AECI-1637: `LEGAL_READER_CURRENT_VERSIONS`. Absent: the shared constant. */
  readonly readerCurrent?: Readonly<Record<LegalReaderDocument, string>>;
  /** `LEGAL_READER_UPCOMING_VERSIONS`. Absent: the shared constant. */
  readonly readerUpcoming?: Readonly<
    Partial<Record<LegalReaderDocument, LegalAgreementUpcomingVersion>>
  >;
  /** `LEGAL_READER_KNOWN_VERSIONS`. Absent: the shared constant. */
  readonly readerKnown?: Readonly<Record<LegalReaderDocument, readonly string[]>>;
  /** `LEGAL_READER_EFFECTIVE_ON`. Absent: the shared constant. */
  readonly readerEffectiveOn?: Readonly<
    Record<LegalReaderDocument, Readonly<Record<string, string | null>>>
  >;
}

/** The shared constants. The one place outside `agreements.ts` that reads them. */
export const LEGAL_IN_FORCE_MAPS: LegalInForceMaps = {
  agreementCurrent: LEGAL_AGREEMENT_CURRENT_VERSIONS,
  agreementUpcoming: LEGAL_AGREEMENT_UPCOMING_VERSIONS,
  policyCurrent: LEGAL_POLICY_CURRENT_VERSIONS,
  policyUpcoming: LEGAL_POLICY_UPCOMING_VERSIONS,
  agreementKnown: LEGAL_AGREEMENT_KNOWN_VERSIONS,
  agreementEffectiveOn: LEGAL_AGREEMENT_EFFECTIVE_ON,
  readerCurrent: LEGAL_READER_CURRENT_VERSIONS,
  readerUpcoming: LEGAL_READER_UPCOMING_VERSIONS,
  readerKnown: LEGAL_READER_KNOWN_VERSIONS,
  readerEffectiveOn: LEGAL_READER_EFFECTIVE_ON,
};

/** The reader upcoming map of `maps`, the shared constant when a spec's maps omit it. */
export function legalReaderUpcomingOf(
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): Readonly<Partial<Record<LegalReaderDocument, LegalAgreementUpcomingVersion>>> {
  return maps.readerUpcoming ?? LEGAL_READER_UPCOMING_VERSIONS;
}

/** The reader effective-day map of `maps`, the shared constant when omitted. */
export function legalReaderEffectiveOnOf(
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): Readonly<Record<LegalReaderDocument, Readonly<Record<string, string | null>>>> {
  return maps.readerEffectiveOn ?? LEGAL_READER_EFFECTIVE_ON;
}

/** The upcoming entry of any publishable document, or `undefined`. */
export function legalPublishableUpcomingOf(
  document: string,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): LegalAgreementUpcomingVersion | undefined {
  return (
    maps.agreementUpcoming[document as LegalAgreementDocument] ??
    legalReaderUpcomingOf(maps)[document as LegalReaderDocument] ??
    maps.policyUpcoming[document as LegalPolicyDocument]
  );
}

/**
 * Every publishable document with an upcoming entry, agreements first, then the reader
 * documents, then the policies, in vocabulary order (AECI-1637, AECI-1969). `/admin/legal`,
 * the public read and the data-quality checks list these, so the six documents are
 * handled alike.
 */
export function legalPublishableUpcoming(
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): { document: LegalPublishableDocument; upcoming: LegalAgreementUpcomingVersion }[] {
  const out: { document: LegalPublishableDocument; upcoming: LegalAgreementUpcomingVersion }[] = [];
  for (const document of LEGAL_AGREEMENT_DOCUMENTS) {
    const upcoming = maps.agreementUpcoming[document];
    if (upcoming) out.push({ document, upcoming });
  }
  const reader = legalReaderUpcomingOf(maps);
  for (const document of LEGAL_READER_DOCUMENTS) {
    const upcoming = reader[document];
    if (upcoming) out.push({ document, upcoming });
  }
  for (const document of LEGAL_POLICY_DOCUMENTS) {
    const upcoming = maps.policyUpcoming[document];
    if (upcoming) out.push({ document, upcoming });
  }
  return out;
}

/**
 * Whether a `legal_versions` row disagrees with the manifest: it names the document's
 * upcoming version but with another effective moment (the date was moved after the
 * publish). Such a row is in force NOWHERE: not on the page, not in a stamp, not on the
 * acceptance screen (`apps/api/src/lib/legal-acceptance.ts`). A row for a version with no
 * upcoming entry (already bumped, or stray) is not judged here.
 */
export function legalPublishedRowMismatched(
  row: LegalPublishedLite,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  const upcoming = legalPublishableUpcomingOf(row.document, maps);
  if (!upcoming || upcoming.version !== row.version) return false;
  return row.effectiveAt !== legalEffectiveAtMs(upcoming.effectiveOn);
}

/** The version of an agreement in force at `nowMs`, given its published rows. */
export function legalAgreementVersionInForce(
  document: LegalAgreementDocument,
  published: readonly LegalPublishedLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string {
  const upcoming = maps.agreementUpcoming[document];
  return upcoming && legalUpcomingInForce(document, upcoming, nowMs, published)
    ? upcoming.version
    : maps.agreementCurrent[document];
}

/**
 * The version of the Terms of Service or the Privacy Policy in force at `nowMs`, given its
 * published rows (AECI-1637). The agreements' rule: the upcoming version switches in at its
 * moment only once a `legal_versions` row published it (ruling 2 of 2026-11-13).
 */
export function legalReaderVersionInForce(
  document: LegalReaderDocument,
  published: readonly LegalPublishedLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string {
  const upcoming = legalReaderUpcomingOf(maps)[document];
  return upcoming && legalUpcomingInForce(document, upcoming, nowMs, published)
    ? upcoming.version
    : (maps.readerCurrent ?? LEGAL_READER_CURRENT_VERSIONS)[document];
}

/**
 * The version of a policy in force at `nowMs`, given its published rows. Since AECI-1969
 * (ruling 54) the agreements' rule: the upcoming version switches in at its moment only
 * once a `legal_versions` row published it, which emailed every claimed company. This is
 * the version the page shows and a new claim records. Which version an existing company
 * is on is `companyPolicyVersion`.
 */
export function legalPolicyVersionInForce(
  policy: LegalPolicyDocument,
  published: readonly LegalPublishedLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): string {
  const upcoming = maps.policyUpcoming[policy];
  return upcoming && legalUpcomingInForce(policy, upcoming, nowMs, published)
    ? upcoming.version
    : maps.policyCurrent[policy];
}

/** Every agreement and policy version in force at one moment. */
export interface LegalInForceVersions {
  readonly agreements: Readonly<Record<LegalAgreementDocument, string>>;
  readonly policies: Readonly<Record<LegalPolicyDocument, string>>;
}

/** {@link legalAgreementVersionInForce} and {@link legalPolicyVersionInForce}, all at once. */
export function legalVersionsInForce(
  published: readonly LegalPublishedLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): LegalInForceVersions {
  const agreements = {} as Record<LegalAgreementDocument, string>;
  for (const d of LEGAL_AGREEMENT_DOCUMENTS) {
    agreements[d] = legalAgreementVersionInForce(d, published, nowMs, maps);
  }
  const policies = {} as Record<LegalPolicyDocument, string>;
  for (const p of LEGAL_POLICY_DOCUMENTS) {
    policies[p] = legalPolicyVersionInForce(p, published, nowMs, maps);
  }
  return { agreements, policies };
}

/**
 * Whether the answer at `nowMs` can depend on a `legal_versions` row: some upcoming
 * publishable document's moment has come (an agreement, since AECI-1637 the Terms of
 * Service or the Privacy Policy, and since AECI-1969 a policy). False means every one is on its build version whatever
 * D1 holds, so a caller may skip the read. True today never: the maps are empty.
 */
export function legalInForceNeedsPublished(
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  return legalPublishableUpcoming(maps).some(({ upcoming }) =>
    legalMomentReached(legalEffectiveAtMs(upcoming.effectiveOn), nowMs),
  );
}

/**
 * The next effective moment after `nowMs` of any upcoming agreement, reader document or
 * policy entry, or `null`. A browser answer is good until then (`LegalInForceClient`).
 */
export function legalNextEffectiveMomentMs(
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): number | null {
  let next: number | null = null;
  for (const u of [
    ...Object.values(maps.agreementUpcoming),
    ...Object.values(legalReaderUpcomingOf(maps)),
    ...Object.values(maps.policyUpcoming),
  ]) {
    if (!u) continue;
    const at = legalEffectiveAtMs(u.effectiveOn);
    if (Number.isFinite(at) && at > nowMs && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * Whether an acceptance may record `version` of `document` without being the one in force
 * right now: it was ever current (`LEGAL_AGREEMENT_KNOWN_VERSIONS`), or it is the upcoming
 * version, which a switch may have put in force before bump day appends it there. The
 * Stripe webhook records the version its session was opened with, and a grant the version
 * it pinned, so both accept either.
 */
export function isRecordableLegalAgreementVersion(
  document: LegalAgreementDocument,
  version: string,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  return (
    (
      (maps.agreementKnown ?? LEGAL_AGREEMENT_KNOWN_VERSIONS)[document] as readonly string[]
    ).includes(version) || maps.agreementUpcoming[document]?.version === version
  );
}

/**
 * Whether `version` of `document` is the document's FIRST version in force (AECI-2234): at
 * `nowMs` no other version of it is in force. The change notice then cannot say "Until then
 * the current version applies" or name an earlier version, because only a draft exists and
 * a draft is never in force (`LEGAL_AGREEMENT_EFFECTIVE_ON`).
 *
 * Another version is in force when either holds:
 *
 *   - another `legal_versions` row of the document has reached its moment and is not
 *     mismatched (`legalPublishedRowMismatched`). Every switch needs a row, for all six
 *     documents since AECI-1969, so this arm alone covers the policies.
 *   - the build's current version has an effective day (an agreement or a reader document
 *     after its bump day). The policies have no effective-day map.
 *
 * Pure. `published` may hold rows of other documents; they are ignored.
 */
export function legalNoticeIsFirstInForce(
  document: LegalPublishableDocument,
  version: string,
  published: readonly LegalPublishedLite[],
  nowMs: number,
  maps: LegalInForceMaps = LEGAL_IN_FORCE_MAPS,
): boolean {
  const earlierRow = published.some(
    (r) =>
      r.document === document &&
      r.version !== version &&
      legalMomentReached(r.effectiveAt, nowMs) &&
      !legalPublishedRowMismatched(r, maps),
  );
  if (earlierRow) return false;
  return buildCurrentEffectiveOn(document, maps) === null;
}

/** The effective day of the build's current version of `document`, or `null`: a draft, or
 *  a policy (no effective-day map). */
function buildCurrentEffectiveOn(
  document: LegalPublishableDocument,
  maps: LegalInForceMaps,
): string | null {
  if ((LEGAL_AGREEMENT_DOCUMENTS as readonly string[]).includes(document)) {
    const d = document as LegalAgreementDocument;
    const days = (maps.agreementEffectiveOn ?? LEGAL_AGREEMENT_EFFECTIVE_ON)[d] as Readonly<
      Record<string, string | null>
    >;
    return days[maps.agreementCurrent[d]] ?? null;
  }
  if ((LEGAL_READER_DOCUMENTS as readonly string[]).includes(document)) {
    const d = document as LegalReaderDocument;
    const days = legalReaderEffectiveOnOf(maps)[d];
    return days[(maps.readerCurrent ?? LEGAL_READER_CURRENT_VERSIONS)[d]] ?? null;
  }
  return null;
}
