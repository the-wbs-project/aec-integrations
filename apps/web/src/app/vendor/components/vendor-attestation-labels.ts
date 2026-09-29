import type {
  AttestationDetector,
  CounterpartyAttestation,
  VendorClaim,
  VendorIntegration,
} from '@aeci/shared';

import type { HealthCounts, IntegrationHealth } from './vendor-integration-health';

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

/**
 * Who sees a note the vendor writes on a data flow (AECI-1139).
 *
 * Ruling 2026-09-28: no attestation note is public, affirm or deny. The other
 * company reads it in its own portal, and AEC Integrations reads it in the audit
 * record. The public pair page shows stances only. The helper text under every
 * note field says so, because a vendor writes differently for an audience of two
 * than for the open web.
 *
 * - **The vendor owns both products, and nobody else is on either:** only AEC
 *   Integrations sees it.
 * - **Exactly one other company is on the integration:** it is named.
 * - **Otherwise** (the other product has no company on file, or several): the
 *   other product names it, or a generic phrase when even that is unknown.
 *
 * `endpoint_vendors` is both endpoints' companies, deduped, so "the others" is
 * that list minus the caller. `slots` is the caller's own endpoints, so two slots
 * means it owns both products.
 */
export function noteAudienceHint(
  integration: Pick<VendorIntegration, 'slots' | 'endpoint_vendors'> | undefined,
  ownVendorId: string | null,
  otherProductName: string | null,
): string {
  const vendors = integration?.endpoint_vendors ?? [];
  const ownsBoth = (integration?.slots.length ?? 0) >= 2;
  // `null` until the session's own vendor id is known. An owns-both integration
  // with a single company on file is the caller's alone either way.
  const others = ownVendorId ? vendors.filter((v) => v.id !== ownVendorId) : null;
  if (ownsBoth && (others ? others.length === 0 : vendors.length <= 1)) {
    return $localize`:@@vendor.attest.note.audience.aeciOnly:Only AEC Integrations sees this.`;
  }
  if (others?.length === 1) {
    const company = others[0].name;
    return $localize`:@@vendor.attest.note.audience.named:Only ${company}:company: and AEC Integrations see this.`;
  }
  return otherProductName
    ? $localize`:@@vendor.attest.note.audience.byProduct:Only the company behind ${otherProductName}:product: and AEC Integrations see this.`
    : $localize`:@@vendor.attest.note.audience.generic:Only the other company and AEC Integrations see this.`;
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

/**
 * The health pill's label for a counterpart or integration row (AECI-999 /
 * §6.3). Worded as what the vendor needs to know, never as a quality verdict on
 * the integration itself: "Conflict" reports a disagreement between vendors, and
 * "Via connector" is a delivery fact, not a downgrade.
 */
export function healthLabel(health: IntegrationHealth): string {
  switch (health) {
    case 'conflict':
      return $localize`:@@vendor.attest.health.conflict:Conflict`;
    case 'needs_you':
      return $localize`:@@vendor.attest.health.needsYou:Needs your input`;
    case 'responded':
      return $localize`:@@vendor.attest.health.responded:You have responded`;
    case 'confirmed':
      return $localize`:@@vendor.attest.health.confirmed:Fully confirmed`;
    case 'connector':
      return $localize`:@@vendor.attest.health.connector:Via connector`;
    case 'empty':
      return $localize`:@@vendor.attest.health.empty:No data flows`;
  }
}

/**
 * The compact count line under a row name: total first, then only the non-zero
 * parts, so a healthy row reads short and a row with work on it reads long.
 * "Data flows" rather than "data points" to match every other sentence on the
 * tab ("You confirm this flow", "N data flows on record").
 */
export function healthCountsLine(counts: HealthCounts): string {
  const parts = [
    counts.total === 1
      ? $localize`:@@vendor.attest.counts.total.one:1 data flow`
      : $localize`:@@vendor.attest.counts.total:${counts.total}:count: data flows`,
  ];
  if (counts.conflict > 0) {
    parts.push($localize`:@@vendor.attest.counts.conflict:${counts.conflict}:count: in conflict`);
  }
  if (counts.waiting === 1) {
    parts.push($localize`:@@vendor.attest.counts.waiting.one:1 needs your input`);
  } else if (counts.waiting > 1) {
    parts.push($localize`:@@vendor.attest.counts.waiting:${counts.waiting}:count: need your input`);
  }
  if (counts.confirmed > 0) {
    parts.push(
      $localize`:@@vendor.attest.counts.confirmed:${counts.confirmed}:count: confirmed by both vendors`,
    );
  }
  return parts.join(' · ');
}
