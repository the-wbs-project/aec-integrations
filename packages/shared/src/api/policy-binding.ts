import { z } from 'zod';

import { LEGAL_POLICY_DOCUMENTS, type LegalPolicyDocument } from './agreements';
import { legalMomentReached } from './legal-in-force';
import { compareLegalVersions } from './legal-versions';

/**
 * Which version of each incorporated policy a claimed company is on (AECI-1969, counsel
 * Q68, ruling 54). Source of truth: `apps/web/src/content/legal/README.md` "Which policy
 * version a company is on", `DATABASE_SCHEMA.md` §8.6j, `ADMIN_PANEL_SPEC.md` §5.22.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────
 * The Vendor Terms make the Listing Accuracy Policy and the Review Guidelines "part of
 * these terms" by number and date. Counsel: a company stays bound to the version it
 * accepted until we follow the change process, which is the 30-day email. So a company is
 * on the NEWEST of:
 *
 *   - the version its latest Vendor Terms acceptance recorded: the claim, or an owner's
 *     acceptance on the portal screen (`agreement_acceptances.listing_accuracy_version` /
 *     `review_guidelines_version`, source `claim` or `portal`);
 *   - each published version (`legal_versions`) whose effective moment has come AND whose
 *     change notice reached that company (`legal_notice_deliveries.status = 'delivered'`).
 *
 * A published version whose notice did not reach the company (no address, dropped,
 * expired, never queued because the company claimed after the fan-out) does not bind it.
 * The company stays on the earlier version and the record lists the version as missed. A
 * re-send before the effective moment reaches a company that was missed, since it queues
 * every company not yet delivered. After the moment it cannot: the next version's email is
 * then the way to move the company on.
 *
 * Nothing else moves a company. A version accepted only by continued use is still a
 * version whose email went, which is what the Vendor Terms promise. No row is written: the
 * claim row and the delivery row are the record, and this reads them.
 *
 * Pure. Never reads the clock: every caller passes `nowMs`.
 */

/** One published version of a policy, as it stands for one company. */
export interface PolicyNoticeStep {
  readonly version: string;
  /** Epoch ms, the row's `effective_at`. */
  readonly effectiveAt: number;
  /** ISO time the company's notice was delivered (`legal_notice_deliveries.updated_at` of
   *  a `delivered` row), or `null` when it was not. */
  readonly deliveredAt: string | null;
}

/** What the company's latest Vendor Terms acceptance recorded for one policy. */
export interface PolicyClaimRecord {
  /** `null` on a claim older than the policy columns (migration 0118). */
  readonly version: string | null;
  /** ISO, `agreement_acceptances.accepted_at`. */
  readonly acceptedAt: string;
}

export const COMPANY_POLICY_BASES = ['acceptance', 'notice', 'none'] as const;

/** One policy as the record shows it for one company. */
export const CompanyPolicyVersionSchema = z.object({
  policy: z.enum(LEGAL_POLICY_DOCUMENTS),
  /** The version the company is on. `null`: no acceptance recorded one and no notice reached it. */
  version: z.string().nullable(),
  /**
   * Why: `acceptance` (the latest Vendor Terms acceptance, a claim or a portal accept,
   * recorded it), `notice` (a delivered change notice and its effective moment moved the
   * company to it), `none` (nothing recorded).
   */
  basis: z.enum(COMPANY_POLICY_BASES),
  /** ISO. `acceptance`: when it was accepted. `notice`: the version's effective moment. */
  since: z.string().nullable(),
  /** `notice` only: when that version's email reached the company. */
  notice_delivered_at: z.string().nullable(),
  /** Versions in force, newer than `version`, whose email did not reach the company. */
  missed_versions: z.array(z.string()),
  /** A published version not yet in effect, and whether its email has reached the company. */
  upcoming: z
    .object({
      version: z.string(),
      effective_at: z.string(),
      delivered: z.boolean(),
    })
    .nullable(),
});
export type CompanyPolicyVersion = z.infer<typeof CompanyPolicyVersionSchema>;

/** The version one company is on for one policy at `nowMs` (module header). */
export function companyPolicyVersion(
  policy: LegalPolicyDocument,
  claim: PolicyClaimRecord | null,
  steps: readonly PolicyNoticeStep[],
  nowMs: number,
): CompanyPolicyVersion {
  let version = claim?.version ?? null;
  let basis: CompanyPolicyVersion['basis'] = version === null ? 'none' : 'acceptance';
  let since: string | null = version === null ? null : (claim?.acceptedAt ?? null);
  let deliveredAt: string | null = null;
  const inForce = steps.filter((s) => legalMomentReached(s.effectiveAt, nowMs));
  for (const step of inForce) {
    if (step.deliveredAt === null) continue;
    if (version === null || compareLegalVersions(step.version, version) > 0) {
      version = step.version;
      basis = 'notice';
      since = new Date(step.effectiveAt).toISOString();
      deliveredAt = step.deliveredAt;
    }
  }
  const missed = inForce
    .filter(
      (s) =>
        s.deliveredAt === null &&
        (version === null || compareLegalVersions(s.version, version) > 0),
    )
    .map((s) => s.version)
    .sort(compareLegalVersions);
  const next = steps
    .filter((s) => !legalMomentReached(s.effectiveAt, nowMs) && Number.isFinite(s.effectiveAt))
    .sort((a, b) => compareLegalVersions(b.version, a.version))[0];
  return {
    policy,
    version,
    basis,
    since,
    notice_delivered_at: deliveredAt,
    missed_versions: missed,
    upcoming: next
      ? {
          version: next.version,
          effective_at: new Date(next.effectiveAt).toISOString(),
          delivered: next.deliveredAt !== null,
        }
      : null,
  };
}

/** {@link companyPolicyVersion} for both policies, in vocabulary order. */
export function companyPolicyVersions(
  claim: {
    readonly acceptedAt: string;
    readonly versions: Readonly<Record<LegalPolicyDocument, string | null>>;
  } | null,
  steps: Readonly<Partial<Record<LegalPolicyDocument, readonly PolicyNoticeStep[]>>>,
  nowMs: number,
): CompanyPolicyVersion[] {
  return LEGAL_POLICY_DOCUMENTS.map((policy) =>
    companyPolicyVersion(
      policy,
      claim ? { version: claim.versions[policy], acceptedAt: claim.acceptedAt } : null,
      steps[policy] ?? [],
      nowMs,
    ),
  );
}
