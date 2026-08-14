import { describe, expect, it } from 'vitest';

import {
  computeAgreement,
  computeSyncHeadline,
  isClaimRefuted,
  type AgreementAttestation,
  type SyncHeadlineClaim,
} from './agreement';

// Two vendor companies. `ACME` owning both endpoints of an integration is the
// case the distinct-identity rule exists for (§4.2).
const ACME = 'vendor-acme';
const GLOBEX = 'vendor-globex';

const aeci = (asserted = true): AgreementAttestation => ({
  source: 'aeci',
  asserted,
  attestedByVendorId: null,
  retractedAt: null,
});

/** Endpoint-A slot. `by` is the vendor identity that filled it. */
const vendorA = (
  asserted: boolean,
  by: string | null = ACME,
  retractedAt: string | null = null,
): AgreementAttestation => ({
  source: 'vendor_a',
  asserted,
  attestedByVendorId: by,
  retractedAt,
});

/** Endpoint-B slot. */
const vendorB = (
  asserted: boolean,
  by: string | null = GLOBEX,
  retractedAt: string | null = null,
): AgreementAttestation => ({
  source: 'vendor_b',
  asserted,
  attestedByVendorId: by,
  retractedAt,
});

describe('computeAgreement', () => {
  // ---------------------------------------------------------------------
  // The §4.2 matrix, row by row.
  // ---------------------------------------------------------------------

  it('0 voters → unverified (empty set)', () => {
    expect(computeAgreement([])).toBe('unverified');
  });

  // The AECi-never-red regression lock (§3.4 / ADR 0018): AECi is excluded from
  // the vote, so an AECi-only claim can NEVER be `conflict` — it is always
  // `unverified`. This is the Stage 1.5 reality (AECi is the only attestor) and
  // the invariant that keeps the pre-launch posture honest.
  it('0 voters → unverified for an AECi-only claim, and never conflict (aeci-never-red)', () => {
    expect(computeAgreement([aeci(true)])).toBe('unverified');
    // Even an AECi *denial* cannot manufacture a conflict — AECi does not vote.
    expect(computeAgreement([aeci(false)])).toBe('unverified');
  });

  it('1 affirming voter → single_source, whichever slot it filled', () => {
    expect(computeAgreement([vendorA(true)])).toBe('single_source');
    expect(computeAgreement([vendorB(true)])).toBe('single_source');
    expect(computeAgreement([aeci(true), vendorA(true)])).toBe('single_source');
  });

  it('1 affirming voter → single_source even when AECi denies (AECi is not a voter)', () => {
    expect(computeAgreement([aeci(false), vendorA(true)])).toBe('single_source');
  });

  it('denying voters only → unverified (denied-but-unconfirmed is not a conflict)', () => {
    expect(computeAgreement([aeci(true), vendorA(false)])).toBe('unverified');
    expect(computeAgreement([vendorA(false), vendorB(false)])).toBe('unverified');
  });

  it('2 distinct voters, all affirming → confirmed', () => {
    expect(computeAgreement([vendorA(true, ACME), vendorB(true, GLOBEX)])).toBe('confirmed');
    expect(computeAgreement([aeci(true), vendorA(true, ACME), vendorB(true, GLOBEX)])).toBe(
      'confirmed',
    );
  });

  it('2 distinct voters, one affirming one denying → conflict', () => {
    expect(computeAgreement([vendorA(true, ACME), vendorB(false, GLOBEX)])).toBe('conflict');
    expect(computeAgreement([aeci(true), vendorA(true, ACME), vendorB(false, GLOBEX)])).toBe(
      'conflict',
    );
  });

  // ---------------------------------------------------------------------
  // The distinct-identity rule — the whole point of AECI-605.
  // ---------------------------------------------------------------------

  // `product_vendors` is many-to-many, so one company can own BOTH endpoints of
  // an integration and fill both attestation slots. Two affirmations from ONE
  // company is not a bilateral signal; treating it as one would let a vendor
  // manufacture "Vendor-confirmed" across its own intra-portfolio integrations.
  it('one vendor owning BOTH endpoints affirms both slots → single_source, not confirmed', () => {
    expect(computeAgreement([vendorA(true, ACME), vendorB(true, ACME)])).toBe('single_source');
  });

  it('one vendor contradicting itself across its two slots → unverified (any deny wins)', () => {
    // `attestations_slot_key` is unique per (claim, slot), not per vendor, so
    // this is representable. It is self-contradiction — neither bilateral
    // agreement nor a vendor-vs-vendor conflict — so it must read as neither.
    expect(computeAgreement([vendorA(true, ACME), vendorB(false, ACME)])).toBe('unverified');
    expect(computeAgreement([vendorA(false, ACME), vendorB(true, ACME)])).toBe('unverified');
  });

  // The acceptance criterion, asserted directly rather than implied by the rows
  // above: there is NO attestation set with fewer than two distinct vendor
  // identities that resolves `confirmed`.
  it('confirmed is unreachable with fewer than two distinct vendor identities', () => {
    const singleIdentitySets: AgreementAttestation[][] = [
      [vendorA(true, ACME)],
      [vendorB(true, ACME)],
      [aeci(true), vendorA(true, ACME)],
      [vendorA(true, ACME), vendorB(true, ACME)],
      [vendorA(true, null), vendorB(true, null)],
      [aeci(true), aeci(true)],
      [vendorA(true, ACME), vendorB(true, GLOBEX, '2026-08-14T00:00:00.000Z')],
    ];
    for (const set of singleIdentitySets) {
      expect(computeAgreement(set)).not.toBe('confirmed');
    }
  });

  // `attested_by_vendor_id` is `ON DELETE SET NULL`, so a live attestation can
  // lose its identity when a vendor row is deleted. Two such orphans must not
  // be mistaken for two distinct vendors.
  it('collapses unattributable (null-identity) votes into one voter', () => {
    expect(computeAgreement([vendorA(true, null), vendorB(true, null)])).toBe('single_source');
    expect(computeAgreement([vendorA(true, null), vendorB(false, null)])).toBe('unverified');
    // A null-identity vote is still a real voter alongside an attributed one.
    expect(computeAgreement([vendorA(true, null), vendorB(true, GLOBEX)])).toBe('confirmed');
    expect(computeAgreement([vendorA(true, null), vendorB(false, GLOBEX)])).toBe('conflict');
  });

  // ---------------------------------------------------------------------
  // Retraction (AECI-603's `retracted_at`) — the §2.5 handoff.
  // ---------------------------------------------------------------------

  it('ignores retracted votes so a withdrawn attestation stops voting', () => {
    const retracted = '2026-08-14T00:00:00.000Z';
    // Retracting the counterparty's affirmation drops confirmed → single_source.
    expect(computeAgreement([vendorA(true, ACME), vendorB(true, GLOBEX, retracted)])).toBe(
      'single_source',
    );
    // Retracting the denial dissolves the conflict.
    expect(computeAgreement([vendorA(true, ACME), vendorB(false, GLOBEX, retracted)])).toBe(
      'single_source',
    );
    // Retracting the only vote returns the claim to the baseline.
    expect(computeAgreement([vendorA(true, ACME, retracted)])).toBe('unverified');
  });

  // `deprecated_at` is a VERSION STAMP (§3.3), not retraction. Gating the vote
  // on it would silence a vendor the moment it recorded that a flow ended in
  // some product version — which is exactly what AECI-303's timeline reads.
  it('does not treat the deprecated_at version stamp as retraction', () => {
    const deprecated = { deprecatedAt: '2026-01-01T00:00:00.000Z' };
    expect(
      computeAgreement([
        { ...vendorA(true, ACME), ...deprecated },
        { ...vendorB(true, GLOBEX), ...deprecated },
      ]),
    ).toBe('confirmed');
  });
});

describe('isClaimRefuted', () => {
  // `unverified` conflates "nobody voted" with "every vendor denies"; only the
  // latter may stop a claim contributing its direction to the product-detail
  // table (§4.3). This predicate is what separates them.
  it('is false when nobody voted — an AECi-seeded claim still describes a real flow', () => {
    expect(isClaimRefuted([])).toBe(false);
    expect(isClaimRefuted([aeci(true)])).toBe(false);
    expect(isClaimRefuted([aeci(false)])).toBe(false);
  });

  it('is true when every distinct voter denies', () => {
    expect(isClaimRefuted([vendorA(false)])).toBe(true);
    expect(isClaimRefuted([vendorA(false, ACME), vendorB(false, GLOBEX)])).toBe(true);
    expect(isClaimRefuted([aeci(true), vendorA(false)])).toBe(true);
  });

  it('is false whenever any vendor affirms — including a disputed claim', () => {
    expect(isClaimRefuted([vendorA(true)])).toBe(false);
    // A `conflict` is disputed, not withdrawn: it keeps its direction.
    expect(isClaimRefuted([vendorA(true, ACME), vendorB(false, GLOBEX)])).toBe(false);
  });

  it('ignores retracted denials', () => {
    expect(isClaimRefuted([vendorA(false, ACME, '2026-08-14T00:00:00.000Z')])).toBe(false);
  });
});

describe('computeSyncHeadline', () => {
  const claim = (agreement: SyncHeadlineClaim['agreement']): SyncHeadlineClaim => ({ agreement });

  it('is all zeroes for no claims', () => {
    expect(computeSyncHeadline([])).toEqual({ total: 0, confirmed: 0, single_source: 0 });
  });

  it('counts total but nothing verified when every claim is unverified (Stage 1.5)', () => {
    expect(
      computeSyncHeadline([claim('unverified'), claim('unverified'), claim('unverified')]),
    ).toEqual({ total: 3, confirmed: 0, single_source: 0 });
  });

  // The headline must never fold a one-sided assertion into the bilateral
  // figure — that is the §8.1(4) invariant restated as a count.
  it('counts single_source separately from confirmed', () => {
    expect(
      computeSyncHeadline([
        claim('confirmed'),
        claim('unverified'),
        claim('confirmed'),
        claim('conflict'),
        claim('single_source'),
      ]),
    ).toEqual({ total: 5, confirmed: 2, single_source: 1 });
  });
});
