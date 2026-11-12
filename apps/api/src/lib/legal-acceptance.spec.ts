/**
 * AECI-1677: what a company must or may accept (`lib/legal-acceptance.ts`). Pure: every
 * input is passed in. The route specs cover the reads, the guard and the write.
 */
import {
  LEGAL_AGREEMENT_DOCUMENTS,
  LEGAL_AGREEMENT_EFFECTIVE_ON,
  legalEffectiveAtMs,
} from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  acceptanceCovers,
  effectiveAtMsOf,
  inForceVersions,
  pendingAcceptances,
  requiredVendorTermsVersion,
  type AcceptedVersionLite,
  type PublishedVersionLite,
} from './legal-acceptance';

const NOW = Date.parse('2027-04-15T00:00:00.000Z');
const PAST = legalEffectiveAtMs('2027-03-31');
const FUTURE = legalEffectiveAtMs('2027-06-30');

const row = (over: Partial<PublishedVersionLite> = {}): PublishedVersionLite => ({
  document: 'vendor_terms',
  version: '1.4',
  effectiveAt: PAST,
  requiresAcceptance: false,
  summaryJson: JSON.stringify(['Liability cap now names the <b>fees</b> paid.']),
  ...over,
});
const acc = (version: string, document = 'vendor_terms'): AcceptedVersionLite => ({
  document,
  version,
});

describe('nothing in force: no prompt and no block (the invariant)', () => {
  it('every version in code is a draft today, so neither agreement is in force', () => {
    for (const document of LEGAL_AGREEMENT_DOCUMENTS) {
      expect(Object.values(LEGAL_AGREEMENT_EFFECTIVE_ON[document]).every((d) => d === null)).toBe(
        true,
      );
      expect(inForceVersions(document, [], NOW)).toEqual([]);
    }
  });

  it.each([
    ['no acceptances', []],
    ['only draft acceptances', [acc('1.2'), acc('1.3'), acc('1.1', 'managed_plan')]],
  ])('pends nothing with %s, a card subscription, and no published row', (_label, accepted) => {
    expect(pendingAcceptances({ published: [], accepted, monthlyCard: true }, NOW)).toEqual([]);
    expect(requiredVendorTermsVersion([], accepted, NOW)).toBeNull();
  });

  it('pends nothing for a published version that needs acceptance but is not in force', () => {
    const published = [
      row({ effectiveAt: FUTURE, requiresAcceptance: true }),
      row({
        document: 'managed_plan',
        version: '1.2',
        effectiveAt: FUTURE,
        requiresAcceptance: true,
      }),
    ];
    expect(
      pendingAcceptances({ published, accepted: [acc('1.3')], monthlyCard: true }, NOW),
    ).toEqual([]);
    expect(requiredVendorTermsVersion(published, [], NOW)).toBeNull();
  });

  it('a row naming a draft version in code is never final', () => {
    const published = [row({ version: '1.3' })];
    expect(effectiveAtMsOf('vendor_terms', '1.3', published)).toBeNull();
    expect(inForceVersions('vendor_terms', published, NOW)).toEqual([]);
  });
});

describe('required mode (ruling 24)', () => {
  it('blocks a company whose only acceptance is of a draft, asking for the newest in force', () => {
    const published = [row(), row({ version: '1.5', effectiveAt: PAST + 1 })];
    const pending = pendingAcceptances(
      { published, accepted: [acc('1.3')], monthlyCard: false },
      NOW,
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      document: 'vendor_terms',
      version: '1.5',
      mode: 'required',
      in_force: true,
      page_path: '/legal/vendor-terms/v1.5',
    });
  });

  it('blocks a company with no acceptance at all', () => {
    expect(requiredVendorTermsVersion([row()], [], NOW)).toBe('1.4');
  });

  it('a final acceptance of a version in force, or a later final one, ends the block', () => {
    expect(requiredVendorTermsVersion([row()], [acc('1.4')], NOW)).toBeNull();
    const withUpcoming = [row(), row({ version: '1.5', effectiveAt: FUTURE })];
    expect(requiredVendorTermsVersion(withUpcoming, [acc('1.5')], NOW)).toBeNull();
  });

  it('returns the summary bullets unescaped, as stored', () => {
    const [item] = pendingAcceptances(
      { published: [row()], accepted: [], monthlyCard: false },
      NOW,
    );
    expect(item?.summary).toEqual(['Liability cap now names the <b>fees</b> paid.']);
  });
});

describe('optional mode (ruling 25, counsel Q3)', () => {
  it('prompts a covered company for a newer published version that needs acceptance', () => {
    const published = [
      row(),
      row({ version: '1.5', effectiveAt: FUTURE, requiresAcceptance: true }),
    ];
    const pending = pendingAcceptances(
      { published, accepted: [acc('1.4')], monthlyCard: false },
      NOW,
    );
    expect(pending).toEqual([
      expect.objectContaining({ version: '1.5', mode: 'optional', in_force: false }),
    ]);
  });

  it('does not prompt for a version that needs no acceptance, or one already accepted', () => {
    const plain = [row(), row({ version: '1.5', effectiveAt: FUTURE })];
    expect(
      pendingAcceptances({ published: plain, accepted: [acc('1.4')], monthlyCard: false }, NOW),
    ).toEqual([]);
    const needs = [row(), row({ version: '1.5', effectiveAt: FUTURE, requiresAcceptance: true })];
    expect(
      pendingAcceptances({ published: needs, accepted: [acc('1.5')], monthlyCard: false }, NOW),
    ).toEqual([]);
  });

  it('a blocked company sees only the required item for the Vendor Terms', () => {
    const published = [
      row(),
      row({ version: '1.5', effectiveAt: FUTURE, requiresAcceptance: true }),
    ];
    const pending = pendingAcceptances({ published, accepted: [], monthlyCard: false }, NOW);
    expect(pending.map((p) => [p.version, p.mode])).toEqual([['1.4', 'required']]);
  });

  describe('the Managed plan agreement', () => {
    const published = [
      row({ document: 'managed_plan', version: '1.2' }),
      row({
        document: 'managed_plan',
        version: '1.3',
        effectiveAt: FUTURE,
        requiresAcceptance: true,
      }),
    ];

    it('prompts only a company with a live monthly card subscription', () => {
      const accepted = [acc('1.2', 'managed_plan')];
      expect(pendingAcceptances({ published, accepted, monthlyCard: false }, NOW)).toEqual([]);
      expect(pendingAcceptances({ published, accepted, monthlyCard: true }, NOW)).toEqual([
        expect.objectContaining({ document: 'managed_plan', version: '1.3', mode: 'optional' }),
      ]);
    });

    it('never blocks: the Managed plan agreement has no required mode', () => {
      const pending = pendingAcceptances({ published, accepted: [], monthlyCard: true }, NOW);
      expect(pending.every((p) => p.mode === 'optional')).toBe(true);
    });
  });
});

describe('acceptanceCovers', () => {
  it('ignores an acceptance of a draft, and of another document', () => {
    expect(acceptanceCovers('vendor_terms', '1.0', [acc('1.3')], [])).toBe(false);
    expect(acceptanceCovers('vendor_terms', '1.4', [acc('1.4', 'managed_plan')], [row()])).toBe(
      false,
    );
  });
});

describe('the effective moment boundary, 12:00:00.000 UTC', () => {
  const published = [row({ effectiveAt: legalEffectiveAtMs('2027-03-31') })];
  const moment = Date.parse('2027-03-31T12:00:00.000Z');

  it('is not in force one millisecond before', () => {
    expect(inForceVersions('vendor_terms', published, moment - 1)).toEqual([]);
    expect(requiredVendorTermsVersion(published, [], moment - 1)).toBeNull();
  });

  it('is in force at the moment exactly', () => {
    expect(inForceVersions('vendor_terms', published, moment)).toEqual(['1.4']);
    expect(requiredVendorTermsVersion(published, [], moment)).toBe('1.4');
  });
});

describe('a later version that needs no acceptance (AECI-1677 review)', () => {
  it('offers the newest final version, not the superseded one that needs acceptance', () => {
    const published = [
      row(),
      row({ version: '1.5', effectiveAt: PAST + 1, requiresAcceptance: true }),
      row({ version: '1.6', effectiveAt: PAST + 2 }),
    ];
    const pending = pendingAcceptances(
      { published, accepted: [acc('1.4')], monthlyCard: false },
      NOW,
    );
    expect(pending).toEqual([expect.objectContaining({ version: '1.6', mode: 'optional' })]);
    // Accepting 1.6 covers 1.5, so nothing is pending after it.
    expect(
      pendingAcceptances({ published, accepted: [acc('1.6')], monthlyCard: false }, NOW),
    ).toEqual([]);
  });
});
