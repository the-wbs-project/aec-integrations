/**
 * AECI-694 — `describeAuditAction`.
 *
 * Two things are worth pinning. First, that every action the API actually writes
 * has a description: an unmapped one degrades to a humanised token, which is
 * correct behaviour for an unknown action but would silently hide a mapping this
 * build was supposed to have. Second, that the degradation works at all, because
 * `audit_log.action` is a free `z.string()` by contract and the table is excluded
 * from the retention prune, so this renderer meets rows written by code that no
 * longer exists.
 *
 * Named `*.component.spec.ts` for the RUNNER, not because it tests a component:
 * the labels are `$localize` messages, and `$localize` only exists in the Angular
 * test target (`@angular/localize/init` comes in with the build's polyfills).
 * Vitest's node environment has no such global.
 */
import { describe, expect, it } from 'vitest';

import { describeAuditAction, isKnownAuditAction } from './audit-action-labels';

/**
 * Every action string emitted by an `auditInsert` call site in `apps/api/src`,
 * with the two TEMPLATED families expanded: `${entity}.created` over
 * category/audience/phase (promote.ts) and `${seatRole}.banned|unbanned` over
 * reviewer/vendor_admin (admin-reviewers.ts, role-aware since AECI-524).
 *
 * If a new writer lands in the API, this list and the map both need the entry;
 * that is the point of asserting over it.
 */
const EMITTED_ACTIONS = [
  'vendor.created',
  'vendor.updated',
  'product.created',
  'product.updated',
  'product.extension_created',
  'integration.created',
  'integration.updated',
  'category.created',
  'audience.created',
  'phase.created',
  'promote.blocked',
  'claim.created',
  'claim.deleted',
  'claim.converted',
  'attestation.created',
  'attestation.retracted',
  'product_version.created',
  'product_version.updated',
  'product_version.deleted',
  'review.submitted',
  'review.approved',
  'review.rejected',
  'vendor_request.created',
  'vendor_request.resolved',
  'vendor_request.rejected',
  'vendor_request.status_changed',
  'vendor_claim.granted',
  'vendor_claim.rejected',
  'vendor_claim.seat_revoked',
  'vendor_claim.note_updated',
  'vendor_seat.invited',
  'vendor_seat.invite_revoked',
  'vendor_seat.invite_accepted',
  'vendor_entitlement.set',
  'vendor_entitlement.renewed',
  'vendor_entitlement.cleared',
  'vendor_entitlement.granted',
  'vendor_entitlement.expiry_warned',
  'reviewer.banned',
  'reviewer.unbanned',
  'vendor_admin.banned',
  'vendor_admin.unbanned',
  'profile.created',
  'profile.updated',
  'account.deleted',
  'notification.sent',
  'retention.pruned',
] as const;

describe('describeAuditAction', () => {
  it('has a description for every action the API writes', () => {
    const unmapped = EMITTED_ACTIONS.filter((action) => !isKnownAuditAction(action));
    expect(unmapped).toEqual([]);
  });

  it('never returns the raw token for a known action', () => {
    for (const action of EMITTED_ACTIONS) {
      const described = describeAuditAction(action);
      expect(described).not.toBe(action);
      expect(described.trim()).not.toBe('');
    }
  });

  it('covers both halves of the role-aware ban family', () => {
    // The endpoint picks the prefix from the target's role, so a `vendor_admin`
    // ban must not read as a reviewer ban (AECI-524).
    expect(describeAuditAction('reviewer.banned')).toContain('Reviewer');
    expect(describeAuditAction('vendor_admin.banned')).toContain('Vendor admin');
    expect(describeAuditAction('reviewer.unbanned')).not.toBe(
      describeAuditAction('reviewer.banned'),
    );
  });

  it('covers all three taxonomy terms of the templated create family', () => {
    for (const entity of ['category', 'audience', 'phase']) {
      expect(isKnownAuditAction(`${entity}.created`)).toBe(true);
    }
  });

  it('humanises an action this build has never heard of', () => {
    // The documented case: `docs/DATABASE_SCHEMA.md` §8.4 lists a
    // `data_object.created` writer that does not exist in the code today.
    expect(describeAuditAction('data_object.created')).toBe('Data object created');
    expect(isKnownAuditAction('data_object.created')).toBe(false);
  });

  it('degrades instead of throwing on a malformed action', () => {
    expect(describeAuditAction('')).toBe('');
    expect(describeAuditAction('...')).toBe('...');
    expect(describeAuditAction('noseparator')).toBe('Noseparator');
  });
});
