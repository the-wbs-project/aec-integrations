import { describe, expect, it } from 'vitest';

import {
  computeAgreement,
  computeSyncHeadline,
  type AgreementAttestation,
  type SyncHeadlineClaim,
} from './agreement';

const aeci = (asserted = true): AgreementAttestation => ({ source: 'aeci', asserted });
const vendorA = (asserted: boolean): AgreementAttestation => ({ source: 'vendor_a', asserted });
const vendorB = (asserted: boolean): AgreementAttestation => ({ source: 'vendor_b', asserted });

describe('computeAgreement', () => {
  it('returns unverified for an empty attestation set', () => {
    expect(computeAgreement([])).toBe('unverified');
  });

  // The AECi-never-red regression lock (§3.4 / ADR 0018): AECi is excluded from
  // the vote, so an AECi-only claim can NEVER be `conflict` — it is always
  // `unverified`. This is the Stage 1.5 reality (AECi is the only attestor) and
  // the invariant that keeps the pre-launch posture honest.
  it('is unverified for an AECi-only claim, and never conflict (aeci-never-red)', () => {
    expect(computeAgreement([aeci(true)])).toBe('unverified');
    // Even an AECi *denial* cannot manufacture a conflict — AECi does not vote.
    expect(computeAgreement([aeci(false)])).toBe('unverified');
  });

  it('ignores the AECi vote entirely — a lone vendor affirm confirms despite AECi denying', () => {
    expect(computeAgreement([aeci(false), vendorA(true)])).toBe('confirmed');
  });

  it('is confirmed when the only vendor votes affirm', () => {
    expect(computeAgreement([aeci(true), vendorA(true)])).toBe('confirmed');
    expect(computeAgreement([vendorA(true), vendorB(true)])).toBe('confirmed');
  });

  it('is unverified when vendors deny without any affirm (denied, not a conflict)', () => {
    expect(computeAgreement([aeci(true), vendorA(false)])).toBe('unverified');
    expect(computeAgreement([vendorA(false), vendorB(false)])).toBe('unverified');
  });

  it('is conflict only when a vendor affirms and another denies', () => {
    expect(computeAgreement([vendorA(true), vendorB(false)])).toBe('conflict');
    expect(computeAgreement([aeci(true), vendorA(true), vendorB(false)])).toBe('conflict');
  });
});

describe('computeSyncHeadline', () => {
  const claim = (agreement: SyncHeadlineClaim['agreement']): SyncHeadlineClaim => ({ agreement });

  it('is {0,0} for no claims', () => {
    expect(computeSyncHeadline([])).toEqual({ total: 0, confirmed: 0 });
  });

  it('counts total but zero confirmed when every claim is unverified (Stage 1.5)', () => {
    expect(
      computeSyncHeadline([claim('unverified'), claim('unverified'), claim('unverified')]),
    ).toEqual({ total: 3, confirmed: 0 });
  });

  it('counts only vendor-confirmed claims as confirmed', () => {
    expect(
      computeSyncHeadline([
        claim('confirmed'),
        claim('unverified'),
        claim('confirmed'),
        claim('conflict'),
      ]),
    ).toEqual({ total: 4, confirmed: 2 });
  });
});
