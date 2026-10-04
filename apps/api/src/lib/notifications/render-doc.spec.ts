/**
 * The `docs/NOTIFICATIONS.md` renderer (AECI-1200). A small fixture registry renders to an
 * exact string, the order does not depend on insertion order, and the `--check` compare
 * reports a hand-edited doc as stale.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOTIFICATIONS, type NotificationEntry } from './registry';
import { checkNotificationsDoc, renderNotificationsDoc, type MonitoringAlerts } from './render-doc';

const FIXTURE: Record<string, NotificationEntry> = {
  'portal-b': {
    channel: 'portal',
    audience: 'external',
    trigger: { kind: 'route', ref: 'POST /b' },
    envRule: 'any-tier',
    dedupe: 'One row per write.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/x.md §1',
    summary: 'Tells a vendor about b.',
  },
  'zeta-mail': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'cron', ref: '0 1 * * *' },
    envRule: 'production-external',
    dedupe: 'None.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/x.md §2',
    summary: 'Sends zeta | with a pipe.',
    note: 'Production only.',
  },
  'Alpha-mail': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /a' },
    envRule: 'any-tier',
    dedupe: 'None.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/x.md §3',
    summary: 'Sends alpha.',
  },
};

const MONITORING: MonitoringAlerts = {
  alerts: [
    { key: 'z-alert', name: 'Z alert', calculationInterval: 'hourly' },
    { key: 'a-alert', name: 'A alert', calculationInterval: 'daily' },
  ],
  appliesTo: ['prod'],
  subscribers: ['ops@example.com'],
};

/** Everything from `## Counts` on. The intro is prose and is checked separately. */
const EXPECTED_BODY = `## Counts

| Channel | Entries |
|---|---|
| \`email\` | 2 |
| \`portal\` | 1 |
| **Total** | **3** |

## Email (Resend) (\`email\`, 2)

Resend email from the API Worker. Transactional sends go through \`sendTransactionalEmail\`,
and the id is the \`template:\` tag on the \`aeci.email.send\` metric. The cron digests
(\`digest-*\`) go through the low-level \`sendEmail\` transport and count on the same metric.
Transport, house layout, per-template copy notes and secrets are in \`docs/email.md\`.
Every send writes one \`notification_sends\` row per recipient, with the Resend message id
on success (AECI-1202, \`docs/DATABASE_SCHEMA.md\` §9.9).

| Id | Summary | Audience | Trigger | Tier rule | Dedupe | Ledger | Opt-out | Pausable | Doc | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| \`Alpha-mail\` | Sends alpha. | operator | route: POST /a | \`any-tier\` | None. | \`notification_sends\` | \`none\` | yes | docs/x.md §3 |  |
| \`zeta-mail\` | Sends zeta \\| with a pipe. | external | cron: 0 1 * * * | \`production-external\` | None. | \`notification_sends\` | \`none\` | no | docs/x.md §2 | Production only. |

## Vendor portal feed only (\`portal\`, 1)

`;

const EXPECTED_ALERTS = `## Monitoring alerts (not product notifications, 2)

These PostHog alerts tell the operator about the system, not a person about an event in
the product, so they are not registry entries. They are defined in
\`observability/posthog/alerts.json\`. They apply to \`prod\`. The subscribers are \`ops@example.com\`, from
\`observability/posthog/project-config.json\` (\`alertSubscribers\`). \`docs/OBSERVABILITY.md\`
governs them.

| Key | Name | Interval |
|---|---|---|
| \`a-alert\` | A alert | daily |
| \`z-alert\` | Z alert | hourly |
`;

describe('renderNotificationsDoc', () => {
  const doc = renderNotificationsDoc(FIXTURE, MONITORING);

  it('opens with the generated banner', () => {
    expect(doc.startsWith('# Notifications\n\n<!-- Generated from')).toBe(true);
    expect(doc).toContain(
      '> Generated from `apps/api/src/lib/notifications/registry.ts`. Do not edit by hand; run `pnpm docs:notifications`.',
    );
  });

  it('renders counts and one table per channel, ids in code-unit order', () => {
    const body = doc.slice(doc.indexOf('## Counts'));
    expect(body.startsWith(EXPECTED_BODY)).toBe(true);
    expect(body).toContain(
      '| `portal-b` | Tells a vendor about b. | external | route: POST /b | `any-tier` | One row per write. | `audit_log` | `none` | no | docs/x.md §1 |  |\n\n## Monitoring',
    );
  });

  it('renders the monitoring alerts last, sorted by key, ending in one newline', () => {
    expect(doc.endsWith(EXPECTED_ALERTS)).toBe(true);
    expect(doc.endsWith('\n\n')).toBe(false);
  });

  it('names the tier allowlist and the coverage spec in the intro', () => {
    expect(doc).toContain('`thewbsproject.com` and `aecintegrations.com`');
    expect(doc).toContain('registry-coverage.spec.ts');
  });

  it('says the doc is mirrored to Linear and that Linear edits are overwritten', () => {
    expect(doc).toContain('mirrors it into a Linear Document');
    expect(doc).toContain('.github/workflows/mirror-notifications-doc.yml');
    expect(doc).toContain('overwritten on the next merge');
  });

  it('falls back to a pointer when the subscribers are unknown', () => {
    const out = renderNotificationsDoc(FIXTURE, { ...MONITORING, subscribers: [] });
    expect(out).toContain(
      'The subscribers are listed in\n`observability/posthog/project-config.json`',
    );
  });

  it('does not depend on insertion order', () => {
    const reversed = Object.fromEntries(Object.entries(FIXTURE).reverse());
    const shuffledAlerts = { ...MONITORING, alerts: [...MONITORING.alerts].reverse() };
    expect(renderNotificationsDoc(reversed, shuffledAlerts)).toBe(doc);
  });

  it('renders every real registry entry, including claim_added and the protest events', () => {
    const real = renderNotificationsDoc(NOTIFICATIONS, MONITORING);
    for (const id of Object.keys(NOTIFICATIONS)) expect(real).toContain(`| \`${id}\` |`);
    for (const id of [
      'portal-claim-added',
      'portal-contest-protested',
      'portal-contest-protest-replied',
      'portal-contest-protest-withdrawn',
      'portal-contest-protest-decided',
    ]) {
      expect(real).toContain(`| \`${id}\` |`);
    }
  });
});

describe('checkNotificationsDoc', () => {
  const doc = renderNotificationsDoc(FIXTURE, MONITORING);

  it('passes an identical doc', () => {
    expect(checkNotificationsDoc(doc, doc)).toBeNull();
  });

  it('reports a hand-edited doc as stale, with the first differing line', () => {
    const edited = doc.replace('Sends alpha.', 'Sends alpha, edited by hand.');
    const line = doc.split('\n').findIndex((l) => l.includes('Sends alpha.')) + 1;
    expect(checkNotificationsDoc(edited, doc)).toBe(
      `docs/NOTIFICATIONS.md is stale; run pnpm docs:notifications (first difference at line ${line}).`,
    );
  });

  it('reports a missing doc', () => {
    expect(checkNotificationsDoc(null, doc)).toBe(
      'docs/NOTIFICATIONS.md is stale; run pnpm docs:notifications (the file does not exist).',
    );
  });

  it('agrees with the committed docs/NOTIFICATIONS.md heading set', () => {
    // A light guard that the committed file is the generated one. The full compare is the
    // `pnpm docs:notifications:check` step in root `pnpm lint`, which reads alerts.json too.
    const file = join(process.cwd(), '..', '..', 'docs', 'NOTIFICATIONS.md');
    expect(existsSync(file)).toBe(true);
    const committed = readFileSync(file, 'utf8');
    for (const id of Object.keys(NOTIFICATIONS)) expect(committed).toContain(`| \`${id}\` |`);
  });
});
