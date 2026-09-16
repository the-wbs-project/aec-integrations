import type { AttestationDetector, CounterpartyAttestation, VendorClaim } from '@aeci/shared';

/**
 * Vendor-facing copy for the attestation tab (AECI-606 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §6).
 *
 * Kept out of the components so the same sentence is not written twice as the
 * tab grows (the `search/mechanism-labels.ts` precedent), and so the copy
 * discipline §6 imposes is auditable in one file:
 *
 *  - **No instant-search promise.** Vendor edits reach Algolia on the nightly
 *    sync (`STAGE_2_SPEC.md` §8.3(5)); nothing here may say "live in search".
 *  - **No ranking or placement implication.** Attesting changes what the
 *    directory *says*, never where a product *sits*. AECi does not sell
 *    placement, and the vendor-facing surface is exactly where that promise
 *    would be quietly broken.
 *  - **Active vendor access is an account status**, arranged with AEC Integrations.
 *    It is not a quality signal and not something the dashboard grants.
 *
 * Agreement-state copy deliberately lives in `products/agreement-badge.ts`
 * instead: the vendor's view of a claim and the public pair page's view must not
 * drift into two vocabularies, so the tab renders that component rather than
 * restating it.
 */

/** The caller's own stance on a claim, as a sentence fragment. */
export function ownStanceLabel(mine: VendorClaim['mine']): string {
  if (mine.length === 0) return $localize`:@@vendor.attest.stance.none:No position yet`;
  return mine[0].asserted
    ? $localize`:@@vendor.attest.stance.affirmed:You confirm this flow`
    : $localize`:@@vendor.attest.stance.denied:You say this flow does not exist`;
}

/** The counterparty's stance, framed by what the vendor can act on. All four
 *  cases are distinct: silence is never rendered as agreement (§8.1(4)). */
export function counterpartyLabel(
  counterparty: CounterpartyAttestation | null,
  mine: VendorClaim['mine'],
  otherProductName: string,
): string {
  if (!counterparty) {
    return mine.length === 0
      ? $localize`:@@vendor.attest.counterparty.neither:Neither vendor has confirmed this yet.`
      : $localize`:@@vendor.attest.counterparty.silent:The other vendor has not responded.`;
  }
  return counterparty.asserted
    ? $localize`:@@vendor.attest.counterparty.affirmed:${otherProductName}:other: confirms this flow.`
    : $localize`:@@vendor.attest.counterparty.denied:${otherProductName}:other: says this flow does not exist.`;
}

/** Heading for the counterparty column in the conflict disclosure. */
export function counterpartyColumnLabel(otherProductName: string): string {
  return $localize`:@@vendor.attest.conflict.theirs:${otherProductName}:other:’s position`;
}

/** The counterparty's stance as a standalone phrase, for the conflict columns. */
export function counterpartyStanceLabel(counterparty: CounterpartyAttestation): string {
  return counterparty.asserted
    ? $localize`:@@vendor.attest.conflict.theirs.affirmed:Confirms this flow`
    : $localize`:@@vendor.attest.conflict.theirs.denied:Says this flow does not exist`;
}

/** The caller's stance as a standalone phrase, for the conflict columns. */
export function ownStancePhrase(mine: VendorClaim['mine']): string {
  if (mine.length === 0) return $localize`:@@vendor.attest.conflict.mine.none:No position recorded`;
  return mine[0].asserted
    ? $localize`:@@vendor.attest.conflict.mine.affirmed:Confirms this flow`
    : $localize`:@@vendor.attest.conflict.mine.denied:Says this flow does not exist`;
}

/**
 * Title for one in-portal notification.
 *
 * The `switch` is total over `AttestationDetector` on purpose, so adding a
 * detector is a compile error here rather than a blank row on a vendor's
 * dashboard. `vendor-notifications-list.ts` drops any row whose title is empty,
 * which is what makes a not-yet-written branch harmless.
 *
 * `claim-denied` was `aeci-denied` and returned `''` for exactly that reason: it
 * was ops-routed, its ledger rows carried `vendorId: null`, and no vendor could
 * ever receive one. AECI-961 gave the detector a **counterparty** finding, so
 * its vendor-addressed rows are now real and need real copy. The ops row still
 * carries a null vendor and still cannot reach this function.
 */
export function detectorTitle(detector: AttestationDetector): string {
  switch (detector) {
    case 'silent-counterparty':
      return $localize`:@@vendor.attest.notify.silentCounterparty:Waiting on the other vendor`;
    case 'open-conflict':
      return $localize`:@@vendor.attest.notify.openConflict:Vendors disagree about this flow`;
    case 'stale-version':
      return $localize`:@@vendor.attest.notify.staleVersion:Time to re-confirm this flow`;
    case 'claim-denied':
      return $localize`:@@vendor.attest.notify.claimDenied:The other vendor says this flow does not exist`;
  }
}
