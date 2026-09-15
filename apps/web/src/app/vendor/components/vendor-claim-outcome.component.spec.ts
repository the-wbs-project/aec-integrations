/**
 * AECI-961 — `claimOutcome` / `claimOutcomeLine`: the §6.2 what-happens-next
 * contract.
 *
 * Two things these tests exist to protect.
 *
 * **The numbers are the detector's numbers.** Every threshold assertion below
 * interpolates the imported constant rather than writing `14` into the
 * expectation, so a retune in `@aeci/shared/attestation-thresholds` moves the
 * copy and the test together. A hardcoded number in either place fails.
 *
 * **The nine states are not the four agreement states.** Agreement answers what
 * the directory believes; this answers what the pipeline will do. Two claims can
 * both read `unverified` while one is waiting on the vendor and the other has a
 * denial queued for the next sweep, and the whole issue was filed because the
 * portal rendered those two identically.
 *
 * Named `*.component.spec.ts` despite testing two pure functions: that suffix is
 * this repo's marker for "runs under `ng test`", and the copy here is `$localize`
 * tagged, which the plain Vitest project does not provide (see
 * `shared/relative-time/relative-time-format.spec.ts` for the other side of that
 * split). `vendor-portal-store.component.spec.ts` is the same case.
 */
import { describe, expect, it } from 'vitest';

import {
  OPEN_CONFLICT_DAYS,
  SILENT_COUNTERPARTY_DAYS,
  STALE_VERSION_MONTHS,
  type VendorClaim,
} from '@aeci/shared';

import { claimOutcome, claimOutcomeLine } from './vendor-claim-outcome';

const OTHER = 'Procore';

const own = (over: Partial<VendorClaim['mine'][number]> = {}): VendorClaim['mine'][number] => ({
  slot: 'vendor_a',
  asserted: true,
  note: null,
  introduced_version_id: null,
  deprecated_version_id: null,
  updated_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

const claim = (over: Partial<VendorClaim> = {}): VendorClaim => ({
  id: '00000000-0000-4000-8000-000000000001',
  integration_id: '00000000-0000-4000-8000-000000000002',
  data_object_slug: 'rfis',
  data_object_name: 'RFIs',
  direction: 'outbound',
  agreement: 'unverified',
  origin: 'aeci',
  mine: [],
  counterparty: null,
  ...over,
});

const line = (over: Partial<VendorClaim> = {}) => claimOutcomeLine(claim(over), OTHER);

describe('claimOutcome', () => {
  it('reads no vote on an unverified claim as no-position', () => {
    expect(claimOutcome(claim())).toBe('no-position');
  });

  it('reads no vote against a counterparty denial as denied-by-them', () => {
    // A lone denial refutes the claim, so the sweep mails US as the counterparty
    // on our unvoted slot. Folding this into `no-position` told a vendor nothing
    // was sent on the same day we sent it.
    expect(claimOutcome(claim({ counterparty: { asserted: false, note: null } }))).toBe(
      'denied-by-them',
    );
  });

  it('reads no vote on a single_source claim as awaiting-you', () => {
    // Someone affirmed and it was not us, so the silence being waited on is ours.
    expect(claimOutcome(claim({ agreement: 'single_source' }))).toBe('awaiting-you');
  });

  it('reads our affirmation as awaiting-them', () => {
    expect(claimOutcome(claim({ agreement: 'single_source', mine: [own()] }))).toBe(
      'awaiting-them',
    );
  });

  it('reads an affirmation across both our own slots as awaiting-them-own-both', () => {
    // Same reasoning as `denied-own-both`: both slots are occupied, so
    // `unvotedSlots` is empty and `detectSilentCounterparty` sends nothing. The
    // `awaiting-them` sentence would have named our own other product.
    expect(
      claimOutcome(
        claim({
          agreement: 'single_source',
          mine: [own({ slot: 'vendor_a' }), own({ slot: 'vendor_b' })],
        }),
      ),
    ).toBe('awaiting-them-own-both');
  });

  it('reads a bilateral claim as confirmed', () => {
    expect(
      claimOutcome(
        claim({
          agreement: 'confirmed',
          mine: [own()],
          counterparty: { asserted: true, note: null },
        }),
      ),
    ).toBe('confirmed');
  });

  it('reads a disagreement as conflict, whichever side we are on', () => {
    for (const asserted of [true, false]) {
      expect(
        claimOutcome(
          claim({
            agreement: 'conflict',
            mine: [own({ asserted })],
            counterparty: { asserted: !asserted, note: null },
          }),
        ),
      ).toBe('conflict');
    }
  });

  it('reads our lone denial as denied', () => {
    expect(claimOutcome(claim({ mine: [own({ asserted: false })] }))).toBe('denied');
  });

  it('reads a denial across both our own slots as denied-own-both', () => {
    // Two own rows can only mean two owned slots: a write applies one position to
    // every slot the caller holds. There is then no unvoted slot, so the detector
    // sends no counterparty mail and the copy must not promise one.
    expect(
      claimOutcome(
        claim({
          mine: [
            own({ slot: 'vendor_a', asserted: false }),
            own({ slot: 'vendor_b', asserted: false }),
          ],
        }),
      ),
    ).toBe('denied-own-both');
  });
});

describe('claimOutcomeLine', () => {
  it('says nothing is sent when no position is recorded', () => {
    expect(line()).toContain('Nothing is sent to anyone');
  });

  it('does not say nothing is sent when the counterparty has denied', () => {
    const text = line({ counterparty: { asserted: false, note: null } });
    expect(text).not.toContain('Nothing is sent to anyone');
    expect(text).toContain('We review denied flows');
    expect(text).toContain('still shows as unverified');
  });

  it('promises no counterparty ask when the affirmer owns both endpoints', () => {
    const text = line({
      agreement: 'single_source',
      mine: [own({ slot: 'vendor_a' }), own({ slot: 'vendor_b' })],
    });
    expect(text).not.toContain(`after ${SILENT_COUNTERPARTY_DAYS} days`);
    expect(text).not.toContain(OTHER);
  });

  it('quotes the real silent-counterparty threshold on both waiting states', () => {
    expect(line({ agreement: 'single_source' })).toContain(
      `after ${SILENT_COUNTERPARTY_DAYS} days`,
    );
    expect(line({ agreement: 'single_source', mine: [own()] })).toContain(
      `after ${SILENT_COUNTERPARTY_DAYS} days`,
    );
  });

  it('names the counterparty product on every state that involves them', () => {
    expect(line({ agreement: 'single_source', mine: [own()] })).toContain(OTHER);
    expect(line({ mine: [own({ asserted: false })] })).toContain(OTHER);
  });

  it('never restates the stance the lane and the announcement already carry', () => {
    // "Models · you confirmed this flow. You confirm this flow. We ask…" is what
    // this guards against: the announcement prefixes the stance, and the lane
    // prints `Your position:` directly below the sentence.
    const states: Partial<VendorClaim>[] = [
      { agreement: 'single_source', mine: [own()] },
      { agreement: 'confirmed', mine: [own()], counterparty: { asserted: true, note: null } },
      { mine: [own({ asserted: false })] },
    ];
    for (const over of states) {
      const text = line(over);
      expect(text).not.toMatch(/^You confirm this flow/);
      expect(text).not.toMatch(/^Both vendors confirm this flow/);
      expect(text).not.toMatch(/^Recorded\./);
    }
  });

  it('quotes the real open-conflict threshold on a conflict', () => {
    const text = line({
      agreement: 'conflict',
      mine: [own()],
      counterparty: { asserted: false, note: null },
    });
    expect(text).toContain(`within ${OPEN_CONFLICT_DAYS} days`);
    expect(text).toContain('both vendors');
  });

  it('asks for a re-confirm only when the confirmed position carries no version stamps', () => {
    const base = { agreement: 'confirmed' as const, counterparty: { asserted: true, note: null } };
    expect(line({ ...base, mine: [own()] })).toContain(`after ${STALE_VERSION_MONTHS} months`);
    expect(line({ ...base, mine: [own({ introduced_version_id: 'v1' })] })).not.toContain(
      `${STALE_VERSION_MONTHS} months`,
    );
    expect(line({ ...base, mine: [own({ deprecated_version_id: 'v9' })] })).not.toContain(
      `${STALE_VERSION_MONTHS} months`,
    );
  });

  it('tells a denier that we and the counterparty are both told', () => {
    const text = line({ mine: [own({ asserted: false })] });
    expect(text).toContain('We review denied flows');
    expect(text).toContain(`we tell ${OTHER} on the next daily check`);
  });

  it('promises no counterparty mail when the denier owns both endpoints', () => {
    const text = line({
      mine: [
        own({ slot: 'vendor_a', asserted: false }),
        own({ slot: 'vendor_b', asserted: false }),
      ],
    });
    expect(text).toContain('We review denied flows');
    expect(text).not.toContain(OTHER);
  });

  it('never says a denial removes the flow — it stays unverified until we act', () => {
    // `isClaimRefuted` only stops the claim steering the product-detail arrow
    // (`packages/shared/src/integration-context.ts`). The pair page still renders
    // it. Copy that promised removal would be the one lie this file must not tell.
    const denials: Partial<VendorClaim>[] = [
      { mine: [own({ asserted: false })] },
      {
        mine: [
          own({ slot: 'vendor_a', asserted: false }),
          own({ slot: 'vendor_b', asserted: false }),
        ],
      },
      // Theirs, not ours: the same promise has to hold on the receiving end.
      { counterparty: { asserted: false, note: null } },
    ];
    for (const over of denials) {
      const text = line(over);
      expect(text).toContain('still shows as unverified');
      expect(text.toLowerCase()).not.toContain('removed');
    }
  });

  it('never implies attesting affects ranking, placement or search', () => {
    const states: Partial<VendorClaim>[] = [
      {},
      { agreement: 'single_source' },
      { agreement: 'single_source', mine: [own()] },
      { agreement: 'confirmed', mine: [own()], counterparty: { asserted: true, note: null } },
      { agreement: 'conflict', mine: [own()], counterparty: { asserted: false, note: null } },
      { mine: [own({ asserted: false })] },
      {
        mine: [
          own({ slot: 'vendor_a', asserted: false }),
          own({ slot: 'vendor_b', asserted: false }),
        ],
      },
      { counterparty: { asserted: false, note: null } },
      {
        agreement: 'single_source' as const,
        mine: [own({ slot: 'vendor_a' }), own({ slot: 'vendor_b' })],
      },
    ];
    for (const over of states) {
      const text = line(over).toLowerCase();
      for (const banned of ['ranking', 'placement', 'search', 'verified account']) {
        expect(text).not.toContain(banned);
      }
      // The repo-wide copy rule, and the only one a line scanner would catch late.
      expect(text).not.toContain('—');
    }
  });
});
