/**
 * Computed agreement + the sync headline (Stage 1.5 §3.4 / §3.5 — AECI-300).
 *
 * Agreement is **computed from the attestation set, never stored** (ADR 0018).
 * These two pure functions are the single implementation shared by the API,
 * SSR, and tests so the pair page (§8), the API mapper, and the Stage 2 portal
 * can never drift from a materialised column.
 *
 * The **AECi-never-red** rule (§3.4): only vendor attestations vote — the AECi
 * attestation is the seed/baseline and is excluded — so an AECi-only claim can
 * never resolve to `conflict`. In Stage 1.5 the only attestor is AECi, so every
 * claim resolves to `unverified` by construction; the `confirmed`/`conflict`
 * branches are implemented (and unit-tested against synthetic vendor
 * attestations) so Stage 2 (AECI-301/302) inherits a proven function with no
 * migration.
 */

/**
 * Enumerated agreement states. Only `unverified` is reachable in Stage 1.5;
 * `confirmed`/`conflict` require vendor attestations (the Stage 2 portal).
 */
export const AGREEMENT_STATES = ['unverified', 'confirmed', 'conflict'] as const;

export type AgreementState = (typeof AGREEMENT_STATES)[number];

/**
 * The minimal attestation shape `computeAgreement` needs: who asserts and
 * whether they affirm. Deliberately loose on `source` (a plain string) — the
 * only semantics is "is this the excluded AECi baseline?" — so this module
 * stays decoupled from the promote/API contract that owns the full source enum.
 */
export interface AgreementAttestation {
  readonly source: string;
  readonly asserted: boolean;
}

/**
 * Derive a claim's agreement from its attestations (§3.4). Only vendor
 * attestations vote; the AECi attestation is excluded (the AECi-never-red rule):
 *
 * - no vendor votes → `unverified` (the Stage 1.5 reality — AECi-only claims).
 * - vendors affirm **and** deny → `conflict` (needs both vendors; unreachable in 1.5).
 * - vendors affirm only → `confirmed`.
 * - vendors deny only → `unverified` (a denied-but-unconfirmed claim is not a conflict).
 */
export function computeAgreement(attestations: readonly AgreementAttestation[]): AgreementState {
  const votes = attestations.filter((a) => a.source !== 'aeci');
  if (votes.length === 0) return 'unverified';
  const affirms = votes.some((v) => v.asserted);
  const denies = votes.some((v) => !v.asserted);
  if (affirms && denies) return 'conflict';
  return affirms ? 'confirmed' : 'unverified';
}

/** The minimal claim shape `computeSyncHeadline` needs — its computed agreement. */
export interface SyncHeadlineClaim {
  readonly agreement: AgreementState;
}

/**
 * The `confirmed / total` sync headline (§3.5). `total` is the number of
 * distinct claims on the pair (all directions, all mechanisms — a data_object
 * moving through two mechanisms counts twice, §3.1); `confirmed` counts claims
 * whose computed agreement is vendor-confirmed. In Stage 1.5 `confirmed = 0`
 * for every pair, so the headline communicates breadth with an honest
 * "Unverified" posture rather than a fake trust signal.
 */
export function computeSyncHeadline(claims: readonly SyncHeadlineClaim[]): {
  total: number;
  confirmed: number;
} {
  return {
    total: claims.length,
    confirmed: claims.filter((c) => c.agreement === 'confirmed').length,
  };
}
