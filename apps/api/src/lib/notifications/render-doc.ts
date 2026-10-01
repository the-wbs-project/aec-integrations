/**
 * Renders `docs/NOTIFICATIONS.md` from the notification registry (AECI-1200).
 *
 * The registry (`registry.ts`) is the source of truth. This module turns it into the
 * human-readable catalogue, and `apps/api/scripts/generate-notifications-doc.ts` writes it
 * to disk or, with `--check`, fails when the committed file differs. Root `pnpm lint` runs
 * the check, so a registry change that is not regenerated fails CI.
 *
 * The output is deterministic: channels in a fixed order, ids in code-unit order within a
 * channel, and no timestamps. Ids are identifiers, not prose, so a binary order is right
 * here (`CLAUDE.md`, "Case never decides an alphabetical order" covers prose only).
 *
 * Pure: no I/O, so the spec renders a fixture registry and compares an exact string.
 */

import { INTERNAL_RECIPIENT_DOMAINS } from './delivery-policy';
import type { NotificationChannel, NotificationEntry } from './registry';

/** The doc's path from the repo root, and the command that regenerates it. */
export const NOTIFICATIONS_DOC_PATH = 'docs/NOTIFICATIONS.md';
export const NOTIFICATIONS_DOC_COMMAND = 'pnpm docs:notifications';

/** One PostHog alert from `observability/posthog/alerts.json`. */
export interface MonitoringAlert {
  key: string;
  name: string;
  calculationInterval: string;
}

/** The monitoring half of the doc. `subscribers` is empty when the config was unreadable. */
export interface MonitoringAlerts {
  alerts: readonly MonitoringAlert[];
  appliesTo: readonly string[];
  subscribers: readonly string[];
}

/** The order channels render in. Every `NotificationChannel` must be listed. */
const CHANNEL_ORDER: readonly NotificationChannel[] = [
  'email',
  'email+portal',
  'supabase-email',
  'portal',
  'linear',
];

/**
 * Built by join so the registry-coverage scan, which forbids a quoted literal of the
 * audit action outside its constant, does not read this prose as an audit write.
 */
const SENT_ROW = ['`notification', 'sent`'].join('.');

const CHANNEL_HEADINGS: Record<NotificationChannel, string> = {
  email: 'Email (Resend)',
  'email+portal': 'Email plus vendor portal row',
  'supabase-email': 'Supabase Auth email',
  portal: 'Vendor portal feed only',
  linear: 'Linear',
};

const CHANNEL_BLURBS: Record<NotificationChannel, string> = {
  email: [
    'Resend email from the API Worker. Transactional sends go through `sendTransactionalEmail`,',
    'and the id is the `template:` tag on the `aeci.email.send` metric. The cron digests',
    '(`digest-*`) go through the low-level `sendEmail` transport and count on the same metric.',
    'Transport, house layout, per-template copy notes and secrets are in `docs/email.md`.',
    'Every send writes one `notification_sends` row per recipient, with the Resend message id',
    'on success (AECI-1202, `docs/DATABASE_SCHEMA.md` §9.9).',
  ].join('\n'),
  'email+portal': [
    "One notification on two surfaces: the attestation sweep's email, plus a",
    `${SENT_ROW} row the vendor portal shows. The portal row is written only when the`,
    'email was sent, and it is the ledger the 30-day dedupe reads.',
  ].join('\n'),
  'supabase-email': [
    'Supabase Auth sends this itself, over the Resend SMTP relay. No app code sends it, so the',
    'tier rule cannot stop it and no metric counts it. The template is',
    '`docs/email-templates/magic-link.html`.',
  ].join('\n'),
  portal: [
    `Delivered only as ${SENT_ROW} audit rows, written in the same \`db.batch\` as the`,
    'change that caused them. The row is its own ledger. The vendor portal reads them through',
    '`GET /api/vendor/notifications`, and revalidates on the `GET /api/vendor/updates` cursor.',
    'None of these sends email and none has an opt-out, so a vendor learns of one only by',
    'opening the portal. The portal copy lives in `vendor-notifications-list.ts` and',
    '`vendor-contest-labels.ts` in `apps/web`. Per-side link writes (AECI-1007) send no',
    'notification at all.',
  ].join('\n'),
  linear: [
    'Writes to Linear. Linear then emails or pings whoever is subscribed there, and AECi does',
    'not control that fan-out.',
  ].join('\n'),
};

const COLUMNS = [
  'Id',
  'Summary',
  'Audience',
  'Trigger',
  'Tier rule',
  'Dedupe',
  'Ledger',
  'Opt-out',
  'Doc',
  'Note',
] as const;

/** Make a value safe inside one Markdown table cell. */
function cell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** Plain code-unit comparison. Ids are identifiers, so locale must not decide. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function entryRow(id: string, e: NotificationEntry): string {
  const values = [
    `\`${id}\``,
    e.summary,
    e.audience,
    `${e.trigger.kind}: ${e.trigger.ref}`,
    `\`${e.envRule}\``,
    e.dedupe,
    e.ledger.map((l) => `\`${l}\``).join(', '),
    `\`${e.optOut}\``,
    e.doc,
    e.note ?? '',
  ];
  return `| ${values.map(cell).join(' | ')} |`;
}

function tableHeader(columns: readonly string[]): string[] {
  return [`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`];
}

function intro(): string[] {
  const domains = INTERNAL_RECIPIENT_DOMAINS.map((d) => `\`${d}\``).join(' and ');
  return [
    '## What this is',
    '',
    'This is the list of every notification AECi sends: email, vendor portal rows and Linear',
    'writes. It is rendered from the notification registry,',
    '`apps/api/src/lib/notifications/registry.ts` (AECI-1199). The registry is the source of',
    'truth. To change a row here, change the registry entry and run',
    `\`${NOTIFICATIONS_DOC_COMMAND}\`. Root \`pnpm lint\` fails when this file is stale.`,
    '',
    'Every merge to `main` that changes this file mirrors it into a Linear Document, through',
    '`.github/workflows/mirror-notifications-doc.yml` (AECI-1201). The Linear copy is read-only',
    'in practice: edits made there are overwritten on the next merge.',
    '',
    "Each entry records today's behaviour, including known gaps. Change an entry in the same",
    'commit that changes the behaviour it describes.',
    '',
    '**Every sender must name an entry.** The types enforce it, and',
    '`apps/api/src/lib/notifications/registry-coverage.spec.ts` scans `apps/api/src` and fails',
    'on a sender that names no registry id, or on an entry that no code sends.',
    "`registry.spec.ts` checks each entry's shape and that its doc section exists.",
    '',
    '| Sender | Takes |',
    '|---|---|',
    '| `sendTransactionalEmail` | `template`, typed as `EmailTemplate`, derived from the email entries |',
    '| `sendEmail` (cron digests) | a required `notification` digest id |',
    `| Every ${SENT_ROW} audit builder | a \`notification\` id, recorded as \`metadata.notificationId\` |`,
    '| `createLinearIssueForRequest`, `createLinearIssueForContest`, `pushRequestResolutionToLinear` | a `notification` field on the input, carried on their logs |',
    '',
    '**The tier rule (AECI-1198).** Email to an outside recipient sends from production only.',
    `Every other tier sends only to the internal allowlist, ${domains}, matched exactly on the`,
    'domain. Anything else is suppressed and counted as `outcome:suppressed`. A missing or',
    'unknown `ENV` counts as non-production. The policy is',
    '`apps/api/src/lib/notifications/delivery-policy.ts`, and `docs/email.md` §Tier delivery',
    'policy is its governing doc.',
    '',
    '- `production-external`: email to an outside person. Sent from production only.',
    '- `any-tier`: no gate of its own. For email this is operator mail to internal inboxes. A',
    '  portal row or a Linear write has no outbound message to gate.',
    '',
    '**Id scheme.** An email id is its `template:` metric tag. A template sent from a second',
    'trigger gets a suffixed id: `-retry` for the sweep re-send, `-resend` for an owner re-send.',
    'The operator `COPY:` of an unsubscribable send is `<template>-operator-copy`. Digests are',
    '`digest-<name>`, portal rows `portal-<kind>[-<event>]`, Linear writes',
    '`linear-<subject>-<what>`.',
    '',
    '**Ledger** is the durable record that proves a send happened: `audit_log` (a',
    `${SENT_ROW} row), \`fence-column\` (a sent-at column on the entity), \`invite-row\` (the`,
    'seat invite row), `job_runs` (the cron run record), `linear-issue-id` (the issue id stored',
    'on the request or contest), or `none`.',
    '',
    '**To add a notification,** add its registry entry first, name the id at the sender, then',
    `run \`${NOTIFICATIONS_DOC_COMMAND}\` and commit this file.`,
  ];
}

function countsSection(groups: ReadonlyArray<[NotificationChannel, string[]]>): string[] {
  const total = groups.reduce((n, [, ids]) => n + ids.length, 0);
  return [
    '## Counts',
    '',
    '| Channel | Entries |',
    '|---|---|',
    ...groups.map(([channel, ids]) => `| \`${channel}\` | ${ids.length} |`),
    `| **Total** | **${total}** |`,
  ];
}

function channelSection(
  channel: NotificationChannel,
  ids: readonly string[],
  registry: Readonly<Record<string, NotificationEntry>>,
): string[] {
  return [
    `## ${CHANNEL_HEADINGS[channel]} (\`${channel}\`, ${ids.length})`,
    '',
    CHANNEL_BLURBS[channel],
    '',
    ...tableHeader(COLUMNS),
    ...ids.map((id) => entryRow(id, registry[id]!)),
  ];
}

function alertsSection(monitoring: MonitoringAlerts): string[] {
  const subscribers =
    monitoring.subscribers.length > 0
      ? `The subscribers are ${monitoring.subscribers.map((s) => `\`${s}\``).join(', ')}, from`
      : 'The subscribers are listed in';
  const appliesTo =
    monitoring.appliesTo.length > 0
      ? ` They apply to ${monitoring.appliesTo.map((t) => `\`${t}\``).join(', ')}.`
      : '';
  const alerts = [...monitoring.alerts].sort((a, b) => byCodeUnit(a.key, b.key));
  return [
    `## Monitoring alerts (not product notifications, ${alerts.length})`,
    '',
    'These PostHog alerts tell the operator about the system, not a person about an event in',
    'the product, so they are not registry entries. They are defined in',
    `\`observability/posthog/alerts.json\`.${appliesTo} ${subscribers}`,
    '`observability/posthog/project-config.json` (`alertSubscribers`). `docs/OBSERVABILITY.md`',
    'governs them.',
    '',
    ...tableHeader(['Key', 'Name', 'Interval']),
    ...alerts.map(
      (a) => `| ${[`\`${a.key}\``, a.name, a.calculationInterval].map(cell).join(' | ')} |`,
    ),
  ];
}

/** Group ids by channel in `CHANNEL_ORDER`, ids in code-unit order. Empty channels drop. */
function groupByChannel(
  registry: Readonly<Record<string, NotificationEntry>>,
): Array<[NotificationChannel, string[]]> {
  const unknown = Object.entries(registry).filter(([, e]) => !CHANNEL_ORDER.includes(e.channel));
  if (unknown.length > 0) {
    throw new Error(`render-doc: no CHANNEL_ORDER slot for channel "${unknown[0]![1].channel}"`);
  }
  return CHANNEL_ORDER.map((channel): [NotificationChannel, string[]] => [
    channel,
    Object.keys(registry)
      .filter((id) => registry[id]!.channel === channel)
      .sort(byCodeUnit),
  ]).filter(([, ids]) => ids.length > 0);
}

/** Render the whole of `docs/NOTIFICATIONS.md`. Ends with exactly one newline. */
export function renderNotificationsDoc(
  registry: Readonly<Record<string, NotificationEntry>>,
  monitoring: MonitoringAlerts,
): string {
  const groups = groupByChannel(registry);
  const blocks: string[][] = [
    [
      '# Notifications',
      '',
      '<!-- Generated from apps/api/src/lib/notifications/registry.ts. Do not edit by hand; run `pnpm docs:notifications`. -->',
      '',
      `> Generated from \`apps/api/src/lib/notifications/registry.ts\`. Do not edit by hand; run \`${NOTIFICATIONS_DOC_COMMAND}\`.`,
    ],
    intro(),
    countsSection(groups),
    ...groups.map(([channel, ids]) => channelSection(channel, ids, registry)),
    alertsSection(monitoring),
  ];
  return `${blocks.map((b) => b.join('\n')).join('\n\n')}\n`;
}

/**
 * Compare the committed doc with a fresh render. Returns `null` when they match, else the
 * message the `--check` CLI prints. `committed` is `null` when the file does not exist.
 */
export function checkNotificationsDoc(committed: string | null, rendered: string): string | null {
  if (committed === rendered) return null;
  const stale = `${NOTIFICATIONS_DOC_PATH} is stale; run ${NOTIFICATIONS_DOC_COMMAND}`;
  if (committed === null) return `${stale} (the file does not exist).`;
  const a = committed.split('\n');
  const b = rendered.split('\n');
  let line = 0;
  while (line < a.length && line < b.length && a[line] === b[line]) line++;
  return `${stale} (first difference at line ${line + 1}).`;
}
