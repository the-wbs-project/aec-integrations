/**
 * The §13.10 step rules (AECI-1217), one block per step, with the Free vs Managed
 * score and the "nothing to do counts as done" cases.
 */

import { capabilitiesFor, type EntitlementTier } from '@aeci/shared/entitlements';
import type { VendorEntitlementBlock } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  checklistScore,
  dataFlowsCount,
  productChecklistSteps,
  vendorChecklistSteps,
  type ChecklistProductCounts,
  type ChecklistProductFacts,
} from './vendor-checklist';

const SEEN = '2026-09-01T00:00:00.000Z';

function plan(tier: EntitlementTier): VendorEntitlementBlock {
  return {
    tier,
    status: tier === 'verified' ? 'active' : null,
    period_end: null,
    ended_at: null,
    capabilities: [...capabilitiesFor(tier)],
    price: { managed_price_cents: null, message: null },
  };
}
const FREE = plan('unclaimed');
const MANAGED = plan('verified');

const CHECKED: ChecklistProductFacts = {
  maintainedBy: 'vendor',
  lastReviewedAt: SEEN,
  integrationsReviewedAt: SEEN,
};
const NOTHING_OUTSTANDING: ChecklistProductCounts = { unclaimedRows: 0, unattestedClaims: 0 };

const stepOf = (steps: ReturnType<typeof productChecklistSteps>, key: string) =>
  steps.find((step) => step.key === key)!;

describe('productChecklistSteps', () => {
  it('lists the four steps in display order', () => {
    expect(productChecklistSteps(CHECKED, NOTHING_OUTSTANDING, MANAGED).map((s) => s.key)).toEqual([
      'product_details',
      'integration_list',
      'claim_integrations',
      'confirm_data_flows',
    ]);
  });

  describe('Check product details', () => {
    it('is done when the vendor maintains the product and it was reviewed', () => {
      const steps = productChecklistSteps(CHECKED, NOTHING_OUTSTANDING, FREE);
      expect(stepOf(steps, 'product_details')).toEqual({
        key: 'product_details',
        status: 'done',
        counts: true,
      });
    });

    it('is todo while AECi maintains it, even with a review date', () => {
      const steps = productChecklistSteps(
        { ...CHECKED, maintainedBy: 'aeci' },
        NOTHING_OUTSTANDING,
        FREE,
      );
      expect(stepOf(steps, 'product_details').status).toBe('todo');
    });

    it('is todo with no review date', () => {
      const steps = productChecklistSteps(
        { ...CHECKED, lastReviewedAt: null },
        NOTHING_OUTSTANDING,
        FREE,
      );
      expect(stepOf(steps, 'product_details').status).toBe('todo');
    });

    it('treats an old review as done, because "ever checked" is enough', () => {
      const steps = productChecklistSteps(
        { ...CHECKED, lastReviewedAt: '2001-01-01T00:00:00.000Z' },
        NOTHING_OUTSTANDING,
        FREE,
      );
      expect(stepOf(steps, 'product_details').status).toBe('done');
    });
  });

  describe('Check the integration list', () => {
    it('is done once integrations_reviewed_at is set', () => {
      expect(
        stepOf(productChecklistSteps(CHECKED, NOTHING_OUTSTANDING, FREE), 'integration_list')
          .status,
      ).toBe('done');
    });

    it('is todo while it is null', () => {
      const steps = productChecklistSteps(
        { ...CHECKED, integrationsReviewedAt: null },
        NOTHING_OUTSTANDING,
        FREE,
      );
      expect(stepOf(steps, 'integration_list')).toEqual({
        key: 'integration_list',
        status: 'todo',
        counts: true,
      });
    });
  });

  describe('Claim or say "not ours"', () => {
    it('is done with no unclaimed rows, the vacuous case', () => {
      expect(
        stepOf(productChecklistSteps(CHECKED, NOTHING_OUTSTANDING, FREE), 'claim_integrations')
          .status,
      ).toBe('done');
    });

    it.each([
      ['Free', FREE],
      ['Managed', MANAGED],
    ])('is todo and counts on %s while a row is unclaimed', (_label, p) => {
      const steps = productChecklistSteps(CHECKED, { unclaimedRows: 2, unattestedClaims: 0 }, p);
      expect(stepOf(steps, 'claim_integrations')).toEqual({
        key: 'claim_integrations',
        status: 'todo',
        counts: true,
      });
    });
  });

  describe('Confirm data flows', () => {
    it('counts on Managed and is todo while a claim is unanswered', () => {
      const steps = productChecklistSteps(
        CHECKED,
        { unclaimedRows: 0, unattestedClaims: 1 },
        MANAGED,
      );
      expect(stepOf(steps, 'confirm_data_flows')).toEqual({
        key: 'confirm_data_flows',
        status: 'todo',
        counts: true,
      });
    });

    it('is optional on Free while a claim is unanswered', () => {
      const steps = productChecklistSteps(CHECKED, { unclaimedRows: 0, unattestedClaims: 1 }, FREE);
      expect(stepOf(steps, 'confirm_data_flows')).toEqual({
        key: 'confirm_data_flows',
        status: 'optional',
        counts: false,
      });
    });

    it('reads done on Free when there is nothing to confirm, but still does not count', () => {
      const steps = productChecklistSteps(CHECKED, NOTHING_OUTSTANDING, FREE);
      expect(stepOf(steps, 'confirm_data_flows')).toEqual({
        key: 'confirm_data_flows',
        status: 'done',
        counts: false,
      });
    });

    it('is done on Managed with no claims, the vacuous case', () => {
      expect(
        stepOf(productChecklistSteps(CHECKED, NOTHING_OUTSTANDING, MANAGED), 'confirm_data_flows'),
      ).toEqual({ key: 'confirm_data_flows', status: 'done', counts: true });
    });

    it('keys on the plan block capability, not on the tier name', () => {
      expect(dataFlowsCount({ ...FREE, capabilities: ['attestation.author'] })).toBe(true);
      expect(dataFlowsCount({ ...MANAGED, capabilities: [] })).toBe(false);
    });
  });
});

describe('checklistScore', () => {
  it('reads "3 of 3" on a finished Free product, with data flows outstanding', () => {
    const steps = productChecklistSteps(CHECKED, { unclaimedRows: 0, unattestedClaims: 5 }, FREE);
    expect(checklistScore(steps)).toEqual({ done: 3, total: 3, complete: true });
  });

  it('reads "3 of 4" on the same Managed product', () => {
    const steps = productChecklistSteps(
      CHECKED,
      { unclaimedRows: 0, unattestedClaims: 5 },
      MANAGED,
    );
    expect(checklistScore(steps)).toEqual({ done: 3, total: 4, complete: false });
  });

  it('reads "4 of 4" on a finished Managed product', () => {
    expect(checklistScore(productChecklistSteps(CHECKED, NOTHING_OUTSTANDING, MANAGED))).toEqual({
      done: 4,
      total: 4,
      complete: true,
    });
  });

  it('reads "0 of 3" on an untouched Free product', () => {
    const untouched: ChecklistProductFacts = {
      maintainedBy: 'aeci',
      lastReviewedAt: null,
      integrationsReviewedAt: null,
    };
    expect(
      checklistScore(
        productChecklistSteps(untouched, { unclaimedRows: 1, unattestedClaims: 1 }, FREE),
      ),
    ).toEqual({ done: 0, total: 3, complete: false });
  });

  it('is complete with no counted steps at all', () => {
    expect(checklistScore([])).toEqual({ done: 0, total: 0, complete: true });
  });
});

describe('vendorChecklistSteps', () => {
  const vendor = { maintainedBy: 'vendor', lastReviewedAt: SEEN, seatCount: 1, inviteCount: 0 };

  it('lists the three steps in display order, the invite never counting', () => {
    expect(vendorChecklistSteps(vendor, [true])).toEqual([
      { key: 'company_details', status: 'done', counts: true },
      { key: 'finish_products', status: 'done', counts: true },
      { key: 'invite_colleague', status: 'optional', counts: false },
    ]);
  });

  it('leaves company details todo while AECi maintains the vendor', () => {
    const steps = vendorChecklistSteps({ ...vendor, maintainedBy: 'aeci' }, []);
    expect(steps[0]!.status).toBe('todo');
  });

  it('leaves company details todo with no review date', () => {
    const steps = vendorChecklistSteps({ ...vendor, lastReviewedAt: null }, []);
    expect(steps[0]!.status).toBe('todo');
  });

  it('finishes products only when every product is complete', () => {
    expect(vendorChecklistSteps(vendor, [true, false])[1]!.status).toBe('todo');
    expect(vendorChecklistSteps(vendor, [true, true])[1]!.status).toBe('done');
  });

  it('finishes products vacuously with no products', () => {
    expect(vendorChecklistSteps(vendor, [])[1]!.status).toBe('done');
  });

  it('marks the invite done for a second seat', () => {
    expect(vendorChecklistSteps({ ...vendor, seatCount: 2 }, [])[2]).toEqual({
      key: 'invite_colleague',
      status: 'done',
      counts: false,
    });
  });

  it('marks the invite done for any invite row', () => {
    expect(vendorChecklistSteps({ ...vendor, inviteCount: 1 }, [])[2]!.status).toBe('done');
  });

  it('scores the vendor over the two counted steps', () => {
    expect(checklistScore(vendorChecklistSteps(vendor, [true]))).toEqual({
      done: 2,
      total: 2,
      complete: true,
    });
    expect(
      checklistScore(vendorChecklistSteps({ ...vendor, lastReviewedAt: null }, [false])),
    ).toEqual({ done: 0, total: 2, complete: false });
  });
});
