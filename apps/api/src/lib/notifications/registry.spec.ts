/**
 * Shape rules for the notification registry (AECI-1199).
 *
 * The registry is the one list of everything AECi sends. These rules keep each entry
 * internally consistent and keep its doc anchor pointing at a heading that exists.
 * `registry-coverage.spec.ts` is the other half: it proves every sender in the code
 * names an entry.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getNotification, NOTIFICATIONS, type NotificationEntry } from './registry';
import { SUPPORT_COPY_KEY } from './switches';

/** Vitest runs with cwd = apps/api. */
const REPO_ROOT = join(process.cwd(), '..', '..');

const ENTRIES = Object.entries(NOTIFICATIONS) as Array<[string, NotificationEntry]>;

/**
 * The 2026-10-01 inventory (45 rows) plus L4, `pushRequestResolutionToLinear`, was 46.
 * AECI-1204 retired the four per-finding attestation nudges and `attestation-ops-alert`
 * (5 ids) and added `attestation-digest` and `attestation-ops-digest` (2 ids): 43.
 * AECI-1203 removed the sweep's re-send of the claim alert, `claim-submitted-alert-retry`: 42.
 * AECI-1205 added the four protest and decline emails: 46.
 * AECI-1180 added the vendor review email and the two review feed rows: 49.
 * AECI-1159 added the three AECi override feed rows: 52. AECI-1237 added the field
 * correction and its lift: 54. AECI-1279 added the plan inquiry receipt and alert: 56.
 * AECI-1293 added the listing request alert: 57. AECI-1368 added the claim owner review
 * email and the owner fallback digest: 59. AECI-1366 added the claimant's receipt: 60.
 * AECI-1377 added the product request alert, its decision email and its feed row: 63.
 * AECI-1370 added the licenses-granted email: 64. AECI-1371 added the managed-ended
 * email and the license revoke feed row: 66. AECI-1373 added the early-unassign
 * alert and its two decision feed rows: 69. E8.1 (AECI-1398) removed the plan inquiry
 * receipt and alert: 67. AECI-1417 added the product proposal owner email: 68.
 * AECI-1435 added the claim confirm link: 69. AECI-1120 added the promote move's
 * contest close feed row: 70. AECI-1513 added the claim owner reminder and AECI-1512
 * the unassigned-license reminder: 72. AECI-1500 added the Stripe payment-failed email: 73.
 * AECI-1503 added the Stripe reconcile alert: 74. AECI-1535 added `portal-thread-message` and
 * `thread-help-requested`: 76. AECI-1548 added `portal-thread-closed`: 77.
 */
const EXPECTED_COUNT = 77;

const sendsEmail = (e: NotificationEntry) => e.channel === 'email' || e.channel === 'email+portal';

/**
 * Whether `anchor` names a heading in `markdown`. A numbered anchor (`11b.12.10`, `9`)
 * matches a heading that starts with it, optionally after `§`. A named anchor
 * (`Template catalogue`) matches a heading that starts with the name.
 */
function headingExists(markdown: string, anchor: string): boolean {
  const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = /^\d/.test(anchor)
    ? new RegExp(`^#{1,4}\\s+§?${escaped}[.\\s)]`, 'm')
    : new RegExp(`^#{1,4}\\s+${escaped}\\b`, 'm');
  return pattern.test(markdown);
}

describe('notification registry shape', () => {
  it(`holds all ${EXPECTED_COUNT} notifications`, () => {
    expect(ENTRIES).toHaveLength(EXPECTED_COUNT);
  });

  it('counts each channel as the inventory does', () => {
    const byChannel = ENTRIES.reduce<Record<string, number>>((acc, [, e]) => {
      acc[e.channel] = (acc[e.channel] ?? 0) + 1;
      return acc;
    }, {});
    expect(byChannel).toEqual({
      // Was 23 + 4. AECI-1204 swapped `attestation-ops-alert` for
      // `attestation-ops-digest` (email, net 0) and the four `email+portal` nudges for
      // the one `attestation-digest`. AECI-1203 removed `claim-submitted-alert-retry`.
      // AECI-1205 added `protest-submitted-alert`, `contest-protest-opened`,
      // `contest-protest-reply-reminder` and `contest-declined-protest-window`.
      // AECI-1180 added `vendor-review-published`, `portal-review` and
      // `portal-review-response`. AECI-1279 added the plan inquiry receipt and
      // alert. AECI-1293 added `listing-request-alert`. AECI-1368
      // added `claim-owner-review` and `claim-owner-fallback-alert`. AECI-1366 added
      // `claim-received`. AECI-1377 added `product-request-alert`,
      // `product-request-decided` and `portal-product-request-decided`. AECI-1370
      // added `licenses-granted`. AECI-1371 added `managed-ended` and
      // `portal-license-revoked-by-aeci`. AECI-1373 added
      // `license-release-request-alert`, `portal-license-release-approved-by-aeci`
      // and `portal-license-release-declined-by-aeci`. E8.1 removed the plan
      // inquiry receipt and alert. AECI-1417 added `product-proposal-owner-review`.
      // AECI-1435 added `claim-confirm`. AECI-1500 added `payment-failed`.
      // AECI-1503 added `stripe-reconcile-alert`. AECI-1535 added
      // `thread-help-requested` and `portal-thread-message`.
      email: 43,
      'email+portal': 1,
      'supabase-email': 1,
      portal: 28,
      linear: 4,
    });
  });

  it('uses kebab-case ids, so an id reads the same in a metric tag and a doc', () => {
    for (const [id] of ENTRIES) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('prefixes ids by channel, which the derived id types rely on', () => {
    for (const [id, e] of ENTRIES) {
      if (e.channel === 'portal') expect(id).toMatch(/^portal-/);
      else expect(id).not.toMatch(/^portal-/);
      if (e.channel === 'linear') expect(id).toMatch(/^linear-/);
      if (e.channel === 'supabase-email') expect(id).toMatch(/^supabase-/);
      if (id.startsWith('digest-')) expect(e.trigger.kind).toBe('cron');
    }
  });

  it('getNotification returns the entry', () => {
    expect(getNotification('vendor-seat-invite').ledger).toEqual([
      'notification_sends',
      'invite-row',
    ]);
  });

  describe.each(ENTRIES)('%s', (id, entry) => {
    it('has a one-sentence summary and a dedupe description', () => {
      expect(entry.summary).toMatch(/^[A-Z].*\.$/);
      expect(entry.dedupe.length).toBeGreaterThan(0);
    });

    it('points at a doc heading that exists', () => {
      const match = entry.doc.match(/^(docs\/[\w./-]+\.md) §(.+)$/);
      expect(match, `${id}: doc must read "docs/X.md §Y"`).not.toBeNull();
      const [, path, anchor] = match!;
      const file = join(REPO_ROOT, path!);
      expect(existsSync(file), `${id}: ${path} does not exist`).toBe(true);
      expect(
        headingExists(readFileSync(file, 'utf8'), anchor!),
        `${id}: no heading "${anchor}" in ${path}`,
      ).toBe(true);
    });

    it('pairs its channel, trigger and ledger legally', () => {
      // Supabase sends it, so nothing in the app can record it.
      expect(entry.channel === 'supabase-email').toBe(entry.trigger.kind === 'supabase');
      if (entry.channel === 'supabase-email') expect(entry.ledger).toEqual(['none']);

      // A ledger list names each record once, and `none` stands alone.
      expect(new Set(entry.ledger).size).toBe(entry.ledger.length);
      if (entry.ledger.includes('none')) expect(entry.ledger).toEqual(['none']);

      // Every Resend email writes a send-ledger row, listed first (AECI-1202). Nothing
      // else writes one.
      expect(entry.ledger[0] === 'notification_sends').toBe(sendsEmail(entry));
      expect(entry.ledger.includes('notification_sends')).toBe(sendsEmail(entry));

      // A portal row is its own ledger: the feed reads the `notification.sent` row.
      if (entry.channel === 'portal' || entry.channel === 'email+portal') {
        expect(entry.ledger).toContain('audit_log');
      }
      if (entry.channel === 'portal') expect(entry.ledger).toEqual(['audit_log']);
      if (entry.channel === 'linear') {
        expect([['linear-issue-id'], ['none']]).toContainEqual([...entry.ledger]);
      }
      if (entry.ledger.includes('linear-issue-id')) expect(entry.channel).toBe('linear');
      if (entry.ledger.includes('invite-row') || entry.ledger.includes('fence-column')) {
        expect(entry.channel).toBe('email');
      }
      if (entry.ledger.includes('job_runs')) expect(entry.trigger.kind).toBe('cron');

      // Linear and the AECi inboxes are operator audiences. Portal rows go to vendors.
      if (entry.channel === 'linear') expect(entry.audience).toBe('operator');
      if (entry.channel === 'portal') expect(entry.audience).toBe('external');
    });

    it('carries the tier rule its audience needs', () => {
      // Email to an outside person sends from production only (AECI-1198).
      if (sendsEmail(entry) && entry.audience === 'external') {
        expect(entry.envRule).toBe('production-external');
      }
      // `any-tier` email is operator mail. The transport runs one allowlist for both
      // rules, which is only equivalent while every `any-tier` email is internal.
      if (sendsEmail(entry) && entry.envRule === 'any-tier') {
        expect(entry.audience).toBe('operator');
      }
      // `production-external` is an email rule. Nothing else has a send to gate.
      if (entry.envRule === 'production-external') expect(sendsEmail(entry)).toBe(true);
      // `production-only` and `production-and-demo` (AECI-1220) are operator email the transport refuses outright
      // off production. A portal row or a Linear write has no send for it to refuse.
      if (entry.envRule === 'production-only' || entry.envRule === 'production-and-demo') {
        expect(sendsEmail(entry)).toBe(true);
        expect(entry.audience).toBe('operator');
      }
    });

    it('offers an opt-out only where one exists', () => {
      expect(entry.optOut === 'mailing-list-unsubscribe').toBe(id === 'mailing-list-welcome');
      // AECI-1204: the per-seat nudge mute covers the attestation digest and nothing
      // else. Seat invites, claim decisions and plan-expiry notices still send.
      expect(entry.optOut === 'nudge-mute').toBe(id === 'attestation-digest');
    });
  });
});

// ─── Pausable (AECI-1224) ────────────────────────────────────────────────────

/**
 * Mail an operator must never be able to stop from `/admin/email`. Security- or
 * obligation-bearing: invites, decisions, the erasure confirmation, and every vendor email
 * that carries a deadline. Moving an id out of this list is a decision, so it is a test
 * edit.
 */
const ALWAYS_ON = [
  'account-deleted',
  'claim-approved',
  'claim-owner-review',
  'claim-owner-review-reminder',
  'claim-received',
  'claim-rejected',
  'contest-declined-protest-window',
  'contest-protest-opened',
  'contest-protest-reply-reminder',
  'entitlement-expiring',
  'mailing-list-welcome-operator-copy',
  'product-request-decided',
  'review-approved',
  'review-rejected',
  'vendor-seat-invite',
  'vendor-seat-invite-resend',
];

describe('pausable (AECI-1224)', () => {
  it('is true only on an entry sent through lib/email.ts', () => {
    for (const [id, e] of ENTRIES) {
      if (!sendsEmail(e)) expect(e.pausable, id).toBe(false);
    }
  });

  it('is false on every supabase-email, portal and linear entry', () => {
    const others = ENTRIES.filter(([, e]) =>
      ['supabase-email', 'portal', 'linear'].includes(e.channel),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const [id, e] of others) expect(e.pausable, id).toBe(false);
  });

  it('keeps security- and deadline-bearing mail always on', () => {
    for (const id of ALWAYS_ON) {
      expect(NOTIFICATIONS[id as keyof typeof NOTIFICATIONS].pausable, id).toBe(false);
    }
  });

  // AECI-1373 added `license-release-request-alert`: 20. E8.1 removed the pausable
  // plan inquiry receipt: 19. AECI-1417 added `product-proposal-owner-review`: 20.
  // AECI-1512 added `license-unassigned-reminder`: 21.
  // AECI-1503 added `stripe-reconcile-alert`: 22.
  // AECI-1535 added `thread-help-requested`: 23.
  it('pauses only what is listed: 23 pausable email entries', () => {
    const pausable = ENTRIES.filter(([, e]) => e.pausable).map(([id]) => id);
    expect(pausable).toHaveLength(23);
    for (const id of pausable) expect(ALWAYS_ON).not.toContain(id);
  });

  it("says why in the entry's note, either way", () => {
    for (const [id, e] of ENTRIES) {
      expect(e.note, id).toMatch(e.pausable ? /Pausable:/ : /(Always on|Not pausable)/);
    }
  });

  it('never uses the reserved support-copy key as an id', () => {
    expect(Object.keys(NOTIFICATIONS)).not.toContain(SUPPORT_COPY_KEY);
  });
});
