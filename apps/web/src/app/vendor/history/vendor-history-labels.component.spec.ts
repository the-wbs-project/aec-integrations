/**
 * AECI-1160 — the Changes page's vendor-facing labels.
 *
 * Every `receipt: true` action in the shared registry must have a written label.
 * An unmapped one would still render through the humanize fallback, which is right
 * for an action a newer API adds, but would silently hide a label this build owed.
 *
 * Named `*.component.spec.ts` for the RUNNER: the labels are `$localize` messages,
 * and `$localize` only exists in the Angular test target.
 */
import { describe, expect, it } from 'vitest';

import { AUDIT_VENDOR_RECEIPT_ACTIONS } from '@aeci/shared/audit-vendor-actions';

import {
  describeHistoryAction,
  hasHistoryActionLabel,
  historyActorLabel,
  historyPlanLabel,
  historyTimeFormatter,
  humanizeField,
} from './vendor-history-labels';

describe('vendor history labels', () => {
  it('labels every receipt action in the registry', () => {
    const missing = AUDIT_VENDOR_RECEIPT_ACTIONS.filter((a) => !hasHistoryActionLabel(a));
    expect(missing).toEqual([]);
    expect(AUDIT_VENDOR_RECEIPT_ACTIONS.length).toBeGreaterThan(40);
  });

  it('never shows the raw token for a labelled action', () => {
    for (const action of AUDIT_VENDOR_RECEIPT_ACTIONS) {
      const label = describeHistoryAction(action);
      expect(label).not.toContain('.');
      expect(label).not.toContain('_');
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it('humanizes an action this build does not know', () => {
    expect(hasHistoryActionLabel('listing.future_event')).toBe(false);
    expect(describeHistoryAction('listing.future_event')).toBe('Listing future event');
  });

  it('humanizes field names, keeping acronyms', () => {
    expect(humanizeField('logo_url')).toBe('Logo URL');
    expect(humanizeField('dataObjects')).toBe('Data objects');
    expect(humanizeField('description')).toBe('Description');
  });

  it('names each actor kind', () => {
    expect(historyActorLabel('your_team')).toBe('Your team');
    expect(historyActorLabel('aeci')).toBe('AECi');
    expect(historyActorLabel('system')).toBe('System');
  });

  it('names the plan Managed only when active over a paid tier', () => {
    expect(historyPlanLabel({ tier: 'verified', status: 'active' })).toBe('Managed');
    expect(historyPlanLabel({ tier: 'verified', status: 'expired' })).toBe('Free');
    expect(historyPlanLabel({ tier: 'unclaimed', status: null })).toBe('Free');
    expect(historyPlanLabel({ tier: 'none', status: 'none' })).toBe('Free');
  });
});

describe('historyTimeFormatter', () => {
  const at = new Date('2026-10-03T15:42:07.000Z');
  const flat = (v: string) => v.replace(/\s/g, ' ');

  it('shows the medium date and the short time with the zone, no seconds', () => {
    expect(flat(historyTimeFormatter('en-US', 'America/New_York').format(at))).toBe(
      'Oct 3, 2026, 11:42 AM EDT',
    );
  });

  it("follows the reader's locale", () => {
    expect(flat(historyTimeFormatter('en-GB', 'Europe/London').format(at))).toBe(
      '3 Oct 2026, 16:42 BST',
    );
  });
});
