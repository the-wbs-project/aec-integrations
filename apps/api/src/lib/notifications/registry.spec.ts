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
 */
const EXPECTED_COUNT = 49;

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
      // `portal-review-response`.
      email: 27,
      'email+portal': 1,
      'supabase-email': 1,
      portal: 16,
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
    });

    it('offers an opt-out only where one exists', () => {
      expect(entry.optOut === 'mailing-list-unsubscribe').toBe(id === 'mailing-list-welcome');
      // AECI-1204: the per-seat nudge mute covers the attestation digest and nothing
      // else. Seat invites, claim decisions and plan-expiry notices still send.
      expect(entry.optOut === 'nudge-mute').toBe(id === 'attestation-digest');
    });
  });
});
