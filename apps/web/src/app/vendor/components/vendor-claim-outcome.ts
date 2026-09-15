import {
  OPEN_CONFLICT_DAYS,
  SILENT_COUNTERPARTY_DAYS,
  STALE_VERSION_MONTHS,
  type VendorClaim,
} from '@aeci/shared';

/**
 * What happens next on one claim lane (AECI-961 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §6.2).
 *
 * The portal used to end at `Your position: You say this flow does not exist`. A
 * vendor who denied a false claim saw no acknowledgement and reasonably assumed
 * nothing had happened — while in fact the §7 sweep was about to mail AECi ops
 * and the counterparty. Correcting bad catalog data is the most valuable thing a
 * seated vendor does for us, and the action had no receipt.
 *
 * Three rules this file exists to hold:
 *
 *  - **The thresholds are the real ones.** They come from
 *    `@aeci/shared/attestation-thresholds`, which is also where the detector
 *    reads them, so "after 14 days" cannot survive a retune that made it false.
 *    Do not write a number in this file, and do not round one into words.
 *  - **It describes what the pipeline does, not what we wish it did.** Notably a
 *    denial does NOT remove the flow: a refuted claim still renders on the public
 *    pair page as `unverified` (only the product-detail arrow stops using it,
 *    `packages/shared/src/integration-context.ts`). The copy says so.
 *  - **The §6 copy discipline applies here too.** No ranking or placement
 *    implication, no search promise, "Verified" is an account status. Sentence
 *    case, no em dashes.
 *  - **It never restates the stance.** Every sentence starts at the consequence.
 *    The lane already prints `Your position: …` directly below it and the badge
 *    directly above it, and the announcement prefixes its own "you denied this
 *    flow" — so a sentence opening "You confirm this flow" said the same thing
 *    twice in a row out loud. Read a new sentence back in both places before
 *    adding one.
 *
 * It is a sibling of `vendor-attestation-labels.ts` rather than part of it
 * because it is a classifier with branching logic and its own spec, not a table
 * of strings. The two are the same contract; change one and read the other.
 */

/**
 * The seven distinct "what happens next" states, which are NOT the four
 * agreement states. Agreement answers "what does the directory believe"; this
 * answers "what will the system do about it", and those differ: two claims can
 * both read `unverified` while one is waiting on the vendor and the other has a
 * denial queued for the next sweep.
 *
 * Three agreement/stance pairs are unreachable and deliberately have no state.
 * A lone affirmation is always `single_source` and a lone denial is always
 * `unverified` (`packages/shared/src/agreement.ts`), so `denied` can never pair
 * with `single_source` or `confirmed`.
 */
export type ClaimOutcome =
  /** No position recorded, and nobody has been told anything. */
  | 'no-position'
  /** The counterparty affirmed and this vendor has not answered. */
  | 'awaiting-you'
  /** This vendor affirmed and the counterparty has not answered. */
  | 'awaiting-them'
  /** Both sides affirmed. */
  | 'confirmed'
  /** The two sides disagree. */
  | 'conflict'
  /** Refuted, with a counterparty slot this vendor does not hold. */
  | 'denied'
  /** Refuted, and this vendor holds both endpoints, so there is nobody to tell. */
  | 'denied-own-both';

/**
 * `mine.length > 1` means the caller owns **both** endpoints of the integration.
 *
 * A write applies one position to every slot the caller owns (`§5.2`, and the
 * `divergentSlots` computation in `vendor-attestation-control.ts` reads the same
 * signal), so two own rows can only mean two owned slots. It matters here because
 * the §7 detector resolves the counterparty from the slots with no live vendor
 * attestation: when the denier holds both, that set is empty and no counterparty
 * mail is sent. Copy that promised one would be a lie.
 */
function ownsBothEndpoints(claim: VendorClaim): boolean {
  return claim.mine.length > 1;
}

/**
 * Whether the caller's own position carries version stamps.
 *
 * `stale-version` only chases an affirmation that has **no** version data, so an
 * unstamped `confirmed` claim gets a re-confirm ask in {@link STALE_VERSION_MONTHS}
 * months and a stamped one does not.
 *
 * This reads only `introduced_version_id` / `deprecated_version_id`. The server's
 * `hasVersionData` also counts the dormant `introduced_at` / `deprecated_at`
 * columns, which are not on `VendorOwnAttestation` and have no authoring path or
 * backfill (§8.4), so they are null in practice. The gap can only ever
 * over-promise a nudge, never deny one; §6.2 records the approximation.
 */
function hasVersionStamps(claim: VendorClaim): boolean {
  return claim.mine.some(
    (a) => a.introduced_version_id !== null || a.deprecated_version_id !== null,
  );
}

/** Classify one claim into the state whose consequence the lane will describe. */
export function claimOutcome(claim: VendorClaim): ClaimOutcome {
  if (claim.agreement === 'conflict') return 'conflict';
  if (claim.agreement === 'confirmed') return 'confirmed';

  const mine = claim.mine[0];
  if (!mine) return claim.agreement === 'single_source' ? 'awaiting-you' : 'no-position';
  if (mine.asserted) return 'awaiting-them';
  return ownsBothEndpoints(claim) ? 'denied-own-both' : 'denied';
}

/**
 * The lane's outcome sentence, in the vendor's own frame.
 *
 * Rendered as **plain text on the lane**, in every state, and announced through
 * `VendorPortalAnnouncer` when a write lands. It is never its own live region:
 * standing state is plain text and events go through the one shell channel
 * (`STAGE_2_REALTIME_SPEC.md` §6.3).
 */
export function claimOutcomeLine(claim: VendorClaim, otherProductName: string): string {
  switch (claimOutcome(claim)) {
    case 'no-position':
      return $localize`:@@vendor.attest.outcome.noPosition:Nothing is sent to anyone until you affirm or deny this flow.`;
    case 'awaiting-you':
      return $localize`:@@vendor.attest.outcome.awaitingYou:You have not answered. We email you a reminder after ${SILENT_COUNTERPARTY_DAYS}:days: days.`;
    case 'awaiting-them':
      return $localize`:@@vendor.attest.outcome.awaitingThem:We ask ${otherProductName}:other: to answer after ${SILENT_COUNTERPARTY_DAYS}:days: days.`;
    case 'confirmed':
      return hasVersionStamps(claim)
        ? $localize`:@@vendor.attest.outcome.confirmed:Nothing further is needed.`
        : $localize`:@@vendor.attest.outcome.confirmedUnstamped:We ask you to re-confirm after ${STALE_VERSION_MONTHS}:months: months.`;
    case 'conflict':
      return $localize`:@@vendor.attest.outcome.conflict:If neither position changes within ${OPEN_CONFLICT_DAYS}:days: days we email both vendors and review the listing ourselves.`;
    case 'denied':
      return $localize`:@@vendor.attest.outcome.denied:We review denied flows and correct the listing, and we tell ${otherProductName}:other: on the next daily check. Until we act, this flow still shows as unverified on the public listing.`;
    case 'denied-own-both':
      return $localize`:@@vendor.attest.outcome.deniedOwnBoth:We review denied flows and correct the listing. Until we act, this flow still shows as unverified on the public listing.`;
  }
}
