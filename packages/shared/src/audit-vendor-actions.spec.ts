import { describe, expect, it } from 'vitest';

import {
  AUDIT_VENDOR_ACTIONS,
  AUDIT_VENDOR_ACTION_NAMES,
  AUDIT_VENDOR_RECEIPT_ACTIONS,
  isAuditVendorAction,
} from './audit-vendor-actions';

describe('AUDIT_VENDOR_ACTIONS (AECI-1192)', () => {
  it('keeps the Messages ledger out of the change history', () => {
    // AECI-1194 uses the receipt list as its allow-list. A notification is not a change.
    expect(AUDIT_VENDOR_ACTIONS['notification.sent'].receipt).toBe(false);
    expect(AUDIT_VENDOR_RECEIPT_ACTIONS).not.toContain('notification.sent');
  });

  it('shows every AECi override the vendor is owed a receipt for', () => {
    for (const action of [
      'integration.retired',
      'integration.contest.accepted',
      'integration.contest.protest_upheld',
      'integration.contest.protest_rejected',
      'vendor_claim.seat_revoked',
      'product.updated',
      'vendor.updated',
      // AECI-1237: the field correction with a lock, and its lift.
      'vendor.field_overridden',
      'vendor.override_lifted',
      'product.field_overridden',
      'product.override_lifted',
      'integration.field_overridden',
      'integration.override_lifted',
    ]) {
      expect(AUDIT_VENDOR_RECEIPT_ACTIONS).toContain(action);
    }
  });

  it('answers membership without inheriting Object.prototype keys', () => {
    expect(isAuditVendorAction('vendor.updated')).toBe(true);
    expect(isAuditVendorAction('toString')).toBe(false);
    expect(isAuditVendorAction('review.approved')).toBe(false);
  });

  it('lists each action once, with a known kind', () => {
    expect(new Set(AUDIT_VENDOR_ACTION_NAMES).size).toBe(AUDIT_VENDOR_ACTION_NAMES.length);
    for (const name of AUDIT_VENDOR_ACTION_NAMES) {
      expect(['vendor-edit', 'aeci-override', 'system']).toContain(AUDIT_VENDOR_ACTIONS[name].kind);
    }
  });
});
