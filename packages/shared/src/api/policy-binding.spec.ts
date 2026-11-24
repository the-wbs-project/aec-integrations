import { describe, expect, it } from 'vitest';

import { legalEffectiveAtMs } from './legal-moment';
import { companyPolicyVersion, companyPolicyVersions } from './policy-binding';

/** AECI-1969, counsel Q68, ruling 54: which policy version a claimed company is on. */
const V11 = legalEffectiveAtMs('2027-03-31');
const V12 = legalEffectiveAtMs('2027-06-30');
const CLAIM = { version: '1.0', acceptedAt: '2026-12-01T10:00:00.000Z' };
const DELIVERED = '2027-02-01T09:00:00.000Z';

describe('companyPolicyVersion', () => {
  it('is the claim version before any published version is in force', () => {
    const r = companyPolicyVersion(
      'listing_accuracy',
      CLAIM,
      [{ version: '1.1', effectiveAt: V11, deliveredAt: DELIVERED }],
      V11 - 1,
    );
    expect(r).toMatchObject({ version: '1.0', basis: 'acceptance', since: CLAIM.acceptedAt });
    expect(r.missed_versions).toEqual([]);
    expect(r.upcoming).toEqual({
      version: '1.1',
      effective_at: new Date(V11).toISOString(),
      delivered: true,
    });
  });

  it('moves to a version once its email reached the company AND its moment came', () => {
    const r = companyPolicyVersion(
      'listing_accuracy',
      CLAIM,
      [{ version: '1.1', effectiveAt: V11, deliveredAt: DELIVERED }],
      V11,
    );
    expect(r).toMatchObject({
      version: '1.1',
      basis: 'notice',
      since: new Date(V11).toISOString(),
      notice_delivered_at: DELIVERED,
      upcoming: null,
    });
  });

  it('stays on the accepted version when the email did not reach it, and says so', () => {
    const r = companyPolicyVersion(
      'review_guidelines',
      CLAIM,
      [{ version: '1.1', effectiveAt: V11, deliveredAt: null }],
      V11 + 1,
    );
    expect(r).toMatchObject({ version: '1.0', basis: 'acceptance', missed_versions: ['1.1'] });
  });

  it('a later delivered version binds even after a missed one', () => {
    const r = companyPolicyVersion(
      'listing_accuracy',
      CLAIM,
      [
        { version: '1.2', effectiveAt: V12, deliveredAt: DELIVERED },
        { version: '1.1', effectiveAt: V11, deliveredAt: null },
      ],
      V12,
    );
    expect(r).toMatchObject({ version: '1.2', basis: 'notice', missed_versions: [] });
  });

  it('a claim that already recorded the newer version is not moved back', () => {
    const r = companyPolicyVersion(
      'listing_accuracy',
      { version: '1.1', acceptedAt: '2027-04-01T00:00:00.000Z' },
      [{ version: '1.1', effectiveAt: V11, deliveredAt: null }],
      V11 + 1,
    );
    expect(r).toMatchObject({ version: '1.1', basis: 'acceptance', missed_versions: [] });
  });

  it('with no claim record, only a delivered notice gives a version', () => {
    expect(companyPolicyVersion('listing_accuracy', null, [], V11)).toMatchObject({
      version: null,
      basis: 'none',
      since: null,
    });
    expect(
      companyPolicyVersion(
        'listing_accuracy',
        { version: null, acceptedAt: CLAIM.acceptedAt },
        [{ version: '1.1', effectiveAt: V11, deliveredAt: DELIVERED }],
        V11,
      ),
    ).toMatchObject({ version: '1.1', basis: 'notice' });
  });
});

describe('companyPolicyVersions', () => {
  it('answers both policies in vocabulary order', () => {
    const out = companyPolicyVersions(
      {
        acceptedAt: CLAIM.acceptedAt,
        versions: { listing_accuracy: '1.0', review_guidelines: '1.0' },
      },
      { review_guidelines: [{ version: '1.1', effectiveAt: V11, deliveredAt: DELIVERED }] },
      V11,
    );
    expect(out.map((p) => [p.policy, p.version])).toEqual([
      ['listing_accuracy', '1.0'],
      ['review_guidelines', '1.1'],
    ]);
  });
});
