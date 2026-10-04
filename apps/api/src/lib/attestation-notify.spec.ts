/**
 * The §7.2/§7.3 notification sweep (AECI-302, digest since AECI-1204) against the
 * in-memory D1 harness.
 *
 * The detectors have their own suite, so this one injects synthetic findings and
 * concentrates on the parts only the sweep owns: the suppression window (§7 AC
 * #2), fail-open sends (AC #4), recipient resolution, the one-digest-per-seat
 * grouping, the per-seat mute, and the ledger contract.
 *
 * `ledgerDb` is mocked to hand the transport the same in-memory DB, so the digest
 * dedupe key is real SQLite (`notification_sends`).
 *
 * The Resend transport is exercised through a mocked global `fetch` rather than a
 * stubbed send helper, so the real `sendTransactionalEmail` path — template ids,
 * the missing-key skip, the non-2xx failure — is what these assertions cover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DetectorFinding, DetectorResult } from './attestation-detectors';
import {
  decideDelivery,
  digestDay,
  groupFindings,
  NOTIFICATION_SENT_ACTION,
  NOTIFICATION_SUPPRESSION_DAYS,
  NOTIFY_BATCH_CAP,
  runAttestationNotifySweep,
  vendorDigestKey,
  type NotificationLedgerMetadata,
  type NotifyContext,
} from './attestation-notify';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  auditLog,
  notificationPreferences,
  notificationSends,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { logBatchToPosthog } from '../posthog';
import { fakeExecutionContext } from '../test/helpers';
import { PREFERENCES_CREATED_ACTION } from './notification-preferences';
import { ledgerDb } from './notifications/send-ledger';

vi.mock('./notifications/send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications/send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ACME = u(901);
const GLOBEX = u(902);
const ACME_SEAT = u(801);
const ACME_BANNED_SEAT = u(802);
const GLOBEX_SEAT = u(803);

const NOW = new Date('2026-08-17T10:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

/** Stub Resend's transport. Declared as a function so the spy's precise type is
 *  inferred — `ReturnType<typeof vi.spyOn>` widens `fetch` to `(...args: unknown[])`
 *  and stops being assignable. */
function spyFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{"id":"re_1"}', { status: 200 }));
}

let t: TestDb;
let fetchSpy: ReturnType<typeof spyFetch>;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: ACME, companyName: 'Acme Software', slug: 'acme-software' },
    { id: GLOBEX, companyName: 'Globex', slug: 'globex' },
  ]);
  await t.db.insert(profiles).values([
    { id: ACME_SEAT, role: 'vendor_admin', vendorId: ACME },
    { id: ACME_BANNED_SEAT, role: 'vendor_admin', vendorId: ACME, bannedAt: daysAgo(5) },
    { id: GLOBEX_SEAT, role: 'vendor_admin', vendorId: GLOBEX },
    // A reviewer that happens to carry a vendor_id is NOT a seat.
    { id: u(804), role: 'reviewer', vendorId: ACME },
  ]);
  fetchSpy = spyFetch();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

// Production, because these suites assert delivery to outside seat addresses. The
// AECI-1198 suite covers the non-production tiers.
const ENV: Env = {
  ENV: 'production',
  RESEND_API_KEY: 'rk_test',
  EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
  SUPPORT_EMAIL: 'ops@aecintegrations.com',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
};

function ctx(env: Partial<Env> = {}): NotifyContext {
  return {
    env: { ...ENV, ...env },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://aeci-api/cron/attestation-notify') },
  };
}

/** Seat emails, as the privileged Supabase seam would resolve them. */
const seatEmails = async () =>
  new Map([
    [ACME_SEAT, 'acme@example.com'],
    [ACME_BANNED_SEAT, 'banned@example.com'],
    [GLOBEX_SEAT, 'globex@example.com'],
  ]);

function finding(over: Partial<DetectorFinding> = {}): DetectorFinding {
  return {
    detector: 'silent-counterparty',
    claimId: u(30),
    integrationId: u(10),
    vendorId: GLOBEX,
    context: {
      mechanismName: 'Procore Connector',
      dataObject: { slug: 'rfis', name: 'RFIs' },
      subjectProduct: { slug: 'revit', name: 'Revit' },
      counterpartProduct: { slug: 'procore', name: 'Procore' },
      pairSlugs: ['procore', 'revit'],
    },
    ...over,
  };
}

/** A detector pass that yields exactly the supplied findings. */
function detectors(findings: DetectorFinding[]) {
  return async (): Promise<DetectorResult[]> => [
    {
      detector: 'silent-counterparty',
      findings: findings.filter((f) => f.detector === 'silent-counterparty'),
    },
    { detector: 'open-conflict', findings: findings.filter((f) => f.detector === 'open-conflict') },
    { detector: 'stale-version', findings: findings.filter((f) => f.detector === 'stale-version') },
    { detector: 'claim-denied', findings: findings.filter((f) => f.detector === 'claim-denied') },
  ];
}

function sweep(findings: DetectorFinding[], over: { env?: Partial<Env> } = {}) {
  return runAttestationNotifySweep(ctx(over.env), t.db, {
    now: NOW,
    runDetectors: detectors(findings) as never,
    fetchSeatEmails: seatEmails,
  });
}

/** The §7.3 `notification.sent` rows only. The lazy preference create writes its
 *  own `notification_preferences.created` audit rows, which are not ledger rows. */
async function ledgerRows() {
  return t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));
}

const meta = (row: { metadata: unknown }) => row.metadata as NotificationLedgerMetadata;

async function mute(profileId: string) {
  await t.db
    .insert(notificationPreferences)
    .values({ profileId, nudgesMutedAt: daysAgo(1), muteToken: `tok-${profileId}` });
}

/** Recipients of every Resend call this run, in order. */
function sentTo(): string[] {
  return fetchSpy.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)).to as string,
  );
}

function sentTemplatesBySubject(): string[] {
  return fetchSpy.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)).subject as string,
  );
}

// ─── Delivery + recipients ───────────────────────────────────────────────────

describe('runAttestationNotifySweep — delivery', () => {
  it('does nothing at all when the detectors find nothing', async () => {
    const result = await sweep([]);
    expect(result).toMatchObject({ found: 0, sent: 0, suppressed: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('emails the vendor’s unbanned seats one digest and writes one ledger row', async () => {
    const result = await sweep([finding()]);

    expect(sentTo()).toEqual(['globex@example.com']);
    expect(result).toMatchObject({ found: 1, sent: 1, failed: 0, skipped: 0 });

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: null,
      actorType: 'system',
      action: NOTIFICATION_SENT_ACTION,
      entityType: 'claim',
      entityId: u(30),
    });
    expect(rows[0].metadata as NotificationLedgerMetadata).toMatchObject({
      // AECI-1199: the ledger row names the registry entry of the email it records.
      notificationId: 'attestation-digest',
      emailedSeats: 1,
      detector: 'silent-counterparty',
      vendorId: GLOBEX,
      integrationId: u(10),
      dataObject: { slug: 'rfis', name: 'RFIs' },
      counterpartProduct: { slug: 'procore', name: 'Procore' },
      pairSlugs: ['procore', 'revit'],
    });
  });

  it('excludes a banned seat — it cannot act on the nudge', async () => {
    await sweep([finding({ vendorId: ACME })]);
    expect(sentTo()).toEqual(['acme@example.com']);
  });

  it('routes an ops finding to SUPPORT_EMAIL with vendorId null on the ledger', async () => {
    await sweep([finding({ detector: 'claim-denied', vendorId: null })]);

    expect(sentTo()).toEqual(['ops@aecintegrations.com']);
    const rows = await ledgerRows();
    expect((rows[0].metadata as NotificationLedgerMetadata).vendorId).toBeNull();
    expect((rows[0].metadata as NotificationLedgerMetadata).notificationId).toBe(
      'attestation-ops-digest',
    );
  });

  it('sends the vendor nudges AND the ops copy for one open conflict', async () => {
    await sweep([
      finding({ detector: 'open-conflict', vendorId: ACME }),
      finding({ detector: 'open-conflict', vendorId: GLOBEX }),
      finding({ detector: 'open-conflict', vendorId: null }),
    ]);

    expect(sentTo().sort()).toEqual([
      'acme@example.com',
      'globex@example.com',
      'ops@aecintegrations.com',
    ]);
    // The ops copy is a distinct, operator-formatted message.
    expect(sentTemplatesBySubject().some((s) => s.startsWith('[AECi] '))).toBe(true);
  });
});

// ─── Suppression (§7 AC #2) ──────────────────────────────────────────────────

describe('runAttestationNotifySweep — suppression', () => {
  it('sends nothing on a second sweep inside the window', async () => {
    const first = await sweep([finding()]);
    expect(first.sent).toBe(1);

    fetchSpy.mockClear();
    const second = await sweep([finding()]);

    expect(second).toMatchObject({ found: 1, suppressed: 1, sent: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('sends again once the window has elapsed', async () => {
    await t.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorType: 'system',
      action: NOTIFICATION_SENT_ACTION,
      entityType: 'claim',
      entityId: u(30),
      metadata: { detector: 'silent-counterparty', vendorId: GLOBEX },
      createdAt: daysAgo(NOTIFICATION_SUPPRESSION_DAYS + 1),
    });

    const result = await sweep([finding()]);
    expect(result).toMatchObject({ suppressed: 0, sent: 1 });
  });

  it('scopes suppression per recipient — nudging one vendor does not silence the other', async () => {
    await sweep([finding({ detector: 'open-conflict', vendorId: ACME })]);
    fetchSpy.mockClear();

    const result = await sweep([
      finding({ detector: 'open-conflict', vendorId: ACME }),
      finding({ detector: 'open-conflict', vendorId: GLOBEX }),
    ]);
    expect(result).toMatchObject({ suppressed: 1, sent: 1 });
    expect(sentTo()).toEqual(['globex@example.com']);
  });

  it('is not suppressed by a claim_added row on the same claim and vendor (AECI-1153 / §7.6)', async () => {
    // An event row, not a detector row: it carries no `detector`, so it is no
    // suppression key and never silences a nudge.
    await t.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorType: 'user',
      action: NOTIFICATION_SENT_ACTION,
      entityType: 'claim',
      entityId: u(30),
      metadata: { kind: 'claim_added', vendorId: GLOBEX, claimId: u(30) },
    });
    const result = await sweep([finding()]);
    expect(result).toMatchObject({ suppressed: 0, sent: 1 });
  });

  it('scopes suppression per detector — a silent-counterparty nudge does not silence a conflict', async () => {
    await sweep([finding()]);
    fetchSpy.mockClear();

    const result = await sweep([finding({ detector: 'open-conflict' })]);
    expect(result).toMatchObject({ suppressed: 0, sent: 1 });
  });
});

// ─── Fail-open (§7 AC #4) ────────────────────────────────────────────────────

describe('runAttestationNotifySweep — fail-open', () => {
  it('survives a Resend outage and writes NO ledger row, so tomorrow retries', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 502 }));

    const result = await sweep([finding()]);
    expect(result).toMatchObject({ found: 1, sent: 0, failed: 1 });
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('survives a network throw, and records it as probably sent: the key stays held (AECI-1197 review)', async () => {
    // A throw may come after Resend took the mail. The send is `unknown`, which keeps
    // the digest key held and counts as emailed, so the portal row is written and a
    // same-day retry sends nothing.
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));

    const result = await sweep([finding()]);
    expect(result).toMatchObject({ failed: 0, sent: 1 });
    expect(await ledgerRows()).toHaveLength(1);

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(new Response('{"id":"re_2"}', { status: 200 }));
    await sweep([finding()]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips (never marks delivered) when RESEND_API_KEY is absent', async () => {
    const result = await sweep([finding()], { env: { RESEND_API_KEY: undefined } });
    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('skips when the seat-email seam degrades (no SUPABASE_SERVICE_ROLE_KEY)', async () => {
    const result = await runAttestationNotifySweep(ctx(), t.db, {
      now: NOW,
      runDetectors: detectors([finding()]) as never,
      fetchSeatEmails: async () => new Map(),
    });

    expect(result).toMatchObject({ skipped: 1, sent: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('skips an ops finding when SUPPORT_EMAIL is unset', async () => {
    const result = await sweep([finding({ detector: 'claim-denied', vendorId: null })], {
      env: { SUPPORT_EMAIL: undefined },
    });
    expect(result).toMatchObject({ skipped: 1, sent: 0 });
  });
});

// ─── The per-run cap ─────────────────────────────────────────────────────────

describe('runAttestationNotifySweep — cap', () => {
  it('stops at the cap and reports what it dropped', async () => {
    const findings = Array.from({ length: NOTIFY_BATCH_CAP + 5 }, (_, i) =>
      finding({ claimId: u(1000 + i) }),
    );

    const result = await sweep(findings);
    expect(result.sent).toBe(NOTIFY_BATCH_CAP);
    expect(result.capped).toBe(5);
    expect(await ledgerRows()).toHaveLength(NOTIFY_BATCH_CAP);
  });

  it('drops the least urgent detector first', async () => {
    const findings = [
      ...Array.from({ length: NOTIFY_BATCH_CAP }, (_, i) =>
        finding({ detector: 'open-conflict', claimId: u(2000 + i) }),
      ),
      finding({ detector: 'stale-version', claimId: u(3000) }),
    ];

    await sweep(findings);
    const rows = await ledgerRows();
    const detectorsSent = new Set(
      rows.map((r) => (r.metadata as NotificationLedgerMetadata).detector),
    );
    expect(detectorsSent).toEqual(new Set(['open-conflict']));
  });
});

// ─── Metrics ─────────────────────────────────────────────────────────────────

describe('runAttestationNotifySweep — metrics', () => {
  it('emits a gauge for every detector, including the zero cases', async () => {
    const gauge = vi.fn();
    const count = vi.fn();

    await runAttestationNotifySweep(ctx(), t.db, {
      now: NOW,
      runDetectors: detectors([finding()]) as never,
      fetchSeatEmails: seatEmails,
      metrics: { gauge, count },
    });

    expect(gauge.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      ['aeci.attestation.detector', 1, ['detector:silent-counterparty']],
      ['aeci.attestation.detector', 0, ['detector:open-conflict']],
      ['aeci.attestation.detector', 0, ['detector:stale-version']],
      ['aeci.attestation.detector', 0, ['detector:claim-denied']],
    ]);
    expect(count).toHaveBeenCalledWith('aeci.attestation.notify.sent', 1, [
      'detector:silent-counterparty',
      'outcome:sent',
    ]);
  });

  it('emits the -1 sentinel for a detector that threw', async () => {
    const gauge = vi.fn();
    await runAttestationNotifySweep(ctx(), t.db, {
      now: NOW,
      runDetectors: (async () => [
        { detector: 'silent-counterparty', findings: [], error: 'boom' },
      ]) as never,
      fetchSeatEmails: seatEmails,
      metrics: { gauge, count: vi.fn() },
    });

    expect(gauge).toHaveBeenCalledWith('aeci.attestation.detector', -1, [
      'detector:silent-counterparty',
    ]);
  });
});

// ─── AECI-666: the §26.5 forwards are batched, and ungated ───────────────────

describe('runAttestationNotifySweep — audit forwarding', () => {
  it('forwards a chunk of ledger rows in ONE batched call, not one per row', async () => {
    // This used to be `Promise.all(entries.map(forwardAuditLog))`, and because
    // the §3.1 dual-run fans that call site out to PostHog AND Datadog, a
    // multi-row flush opened 2N simultaneous connections from one cron
    // invocation. Past the per-invocation limit the runtime cancels the stalled
    // responses into `fetch` promises that never settle, so the forwards vanish
    // with no error and the sweep is eventually killed as hung.
    const found = await sweep([
      finding({ detector: 'stale-version', claimId: u(3001) }),
      finding({ detector: 'stale-version', claimId: u(3002) }),
      finding({ detector: 'open-conflict', claimId: u(3003) }),
    ]);
    expect(found.sent).toBeGreaterThan(0);

    // The ledger forward. The lazy preference create forwards its own rows in a
    // separate single call (AECI-1204).
    const calls = vi
      .mocked(logBatchToPosthog)
      .mock.calls.filter((call) => call[3][0]?.action === NOTIFICATION_SENT_ACTION);
    expect(calls).toHaveLength(1);
    expect(calls[0][3]).toHaveLength((await ledgerRows()).length);
    expect(calls[0][3][0]).toMatchObject({
      level: 'info',
      source: 'attestation-notify-cron',
    });
  });

  it('forwards with no telemetry key configured — the transport self-gates', async () => {
    // The old forwarder gated the forward on `DD_API_KEY`, so on any tier without
    // a Datadog key (which is every tier after PH-final, AECI-651) it silently
    // forwarded nothing at all.
    await sweep([finding({ detector: 'stale-version', claimId: u(3004) })], {
      env: { POSTHOG_PROJECT_KEY: undefined },
    });

    const ledgerForwards = vi
      .mocked(logBatchToPosthog)
      .mock.calls.filter((call) => call[3][0]?.action === NOTIFICATION_SENT_ACTION);
    expect(ledgerForwards).toHaveLength(1);
  });
});

// ─── AECI-1198: outside recipients get mail from production only ─────────────

describe('runAttestationNotifySweep — tier delivery policy (AECI-1198)', () => {
  it('on staging, sends nothing to a vendor seat but records the portal rows (AECI-1204)', async () => {
    const result = await sweep([finding(), finding({ vendorId: ACME, claimId: u(31) })], {
      env: { ENV: 'staging' },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    // The tier policy refuses on purpose, which is a final answer like a mute: the
    // vendor sees the finding in its portal, with emailedSeats 0.
    expect(result).toMatchObject({ found: 2, sent: 0, portalOnly: 2, failed: 0, skipped: 0 });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => meta(r).emailedSeats)).toEqual([0, 0]);
  });

  it('treats a missing ENV as non-production', async () => {
    await sweep([finding()], { env: { ENV: undefined } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('on staging, still sends the ops alert to an internal address, tier-prefixed', async () => {
    const result = await sweep([finding({ detector: 'claim-denied', vendorId: null })], {
      env: { ENV: 'staging' },
    });

    expect(sentTo()).toEqual(['ops@aecintegrations.com']);
    expect(sentTemplatesBySubject()[0]!.startsWith('[staging] ')).toBe(true);
    expect(result.sent).toBe(1);
  });
});

// ─── AECI-1204: one digest per seat, the mute, and the ledger rule ───────────

describe('groupFindings / decideDelivery (pure)', () => {
  it('groups vendor findings by vendor in order, and splits off the ops findings', () => {
    const a1 = finding({ vendorId: ACME, claimId: u(1) });
    const g1 = finding({ vendorId: GLOBEX, claimId: u(2) });
    const a2 = finding({ vendorId: ACME, claimId: u(3) });
    const ops = finding({ vendorId: null, detector: 'claim-denied', claimId: u(4) });

    const { byVendor, ops: opsList } = groupFindings([a1, g1, ops, a2]);
    expect([...byVendor.keys()]).toEqual([ACME, GLOBEX]);
    expect(byVendor.get(ACME)).toEqual([a1, a2]);
    expect(byVendor.get(GLOBEX)).toEqual([g1]);
    expect(opsList).toEqual([ops]);
  });

  it('records when any seat got it, counting sent and duplicate as emailed', () => {
    expect(decideDelivery(['sent', 'failed', 'muted'])).toEqual({
      outcome: 'sent',
      record: true,
      emailedSeats: 1,
    });
    expect(decideDelivery(['duplicate', 'sent'])).toMatchObject({
      outcome: 'sent',
      emailedSeats: 2,
    });
  });

  it('counts an unknown send as emailed and records it, because its key stays held (AECI-1197 review)', () => {
    expect(decideDelivery(['unknown'])).toEqual({ outcome: 'sent', record: true, emailedSeats: 1 });
    expect(decideDelivery(['unknown', 'failed', 'muted'])).toEqual({
      outcome: 'sent',
      record: true,
      emailedSeats: 1,
    });
  });

  it('records with emailedSeats 0 when every seat is muted or tier-suppressed', () => {
    expect(decideDelivery(['muted', 'muted'])).toEqual({
      outcome: 'portal-only',
      record: true,
      emailedSeats: 0,
    });
    expect(decideDelivery(['muted', 'suppressed'])).toMatchObject({ outcome: 'portal-only' });
  });

  it('treats an operator pause like a mute: portal-only, recorded (AECI-1224)', () => {
    expect(decideDelivery(['paused', 'paused'])).toEqual({
      outcome: 'portal-only',
      record: true,
      emailedSeats: 0,
    });
    // A failure beside a pause still retries tomorrow.
    expect(decideDelivery(['paused', 'failed'])).toMatchObject({
      outcome: 'failed',
      record: false,
    });
  });

  it('records portal-only when a muted or suppressed seat sits beside a seat with no address (AECI-1197 review)', () => {
    expect(decideDelivery(['muted', 'no-address'])).toEqual({
      outcome: 'portal-only',
      record: true,
      emailedSeats: 0,
    });
    expect(decideDelivery(['no-address', 'suppressed'])).toEqual({
      outcome: 'portal-only',
      record: true,
      emailedSeats: 0,
    });
  });

  it('does NOT record a Resend failure, so tomorrow retries', () => {
    expect(decideDelivery(['failed', 'muted'])).toEqual({
      outcome: 'failed',
      record: false,
      emailedSeats: 0,
    });
  });

  it('does NOT record when nothing could be attempted, including no seat at all', () => {
    expect(decideDelivery([])).toMatchObject({ outcome: 'skipped', record: false });
    expect(decideDelivery(['no-address'])).toEqual({
      outcome: 'skipped',
      record: false,
      emailedSeats: 0,
    });
    expect(decideDelivery(['no-address', 'no-address'])).toMatchObject({ outcome: 'skipped' });
    expect(decideDelivery(['skipped', 'muted'])).toMatchObject({
      outcome: 'skipped',
      record: false,
    });
  });

  it('keys the digest per vendor, seat and UTC day', () => {
    expect(digestDay(new Date('2026-10-01T23:59:59.000Z'))).toBe('2026-10-01');
    expect(vendorDigestKey('v', 'p', '2026-10-01')).toBe('attestation-digest:v:p:2026-10-01');
  });
});

describe('runAttestationNotifySweep — digest per seat (AECI-1204)', () => {
  const SEAT_2 = u(805);
  const SEAT_3 = u(806);
  const threeSeatEmails = async () =>
    new Map([
      [GLOBEX_SEAT, 'globex@example.com'],
      [SEAT_2, 'globex2@example.com'],
      [SEAT_3, 'globex3@example.com'],
    ]);
  const forty = () =>
    Array.from({ length: 40 }, (_, i) =>
      finding({ detector: 'stale-version', claimId: u(5000 + i), vendorId: GLOBEX }),
    );
  const run = (findings: DetectorFinding[], now: Date = NOW) =>
    runAttestationNotifySweep(ctx(), t.db, {
      now,
      runDetectors: detectors(findings) as never,
      fetchSeatEmails: threeSeatEmails,
    });

  beforeEach(async () => {
    await t.db.insert(profiles).values([
      { id: SEAT_2, role: 'vendor_admin', vendorId: GLOBEX },
      { id: SEAT_3, role: 'vendor_admin', vendorId: GLOBEX },
    ]);
  });

  it('40 findings, 1 vendor, 3 seats: 3 emails and 40 ledger rows', async () => {
    const result = await run(forty());

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sentTo().sort()).toEqual([
      'globex2@example.com',
      'globex3@example.com',
      'globex@example.com',
    ]);
    expect(result).toMatchObject({ found: 40, sent: 40, digestsSent: 3, failed: 0, skipped: 0 });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((r) => meta(r).emailedSeats))).toEqual(new Set([3]));
    expect(new Set(rows.map((r) => meta(r).notificationId))).toEqual(
      new Set(['attestation-digest']),
    );
  });

  it('mute one seat: 2 emails and still 40 ledger rows', async () => {
    await mute(SEAT_2);

    const result = await run(forty());

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sentTo()).not.toContain('globex2@example.com');
    expect(result.digestsSent).toBe(2);
    const rows = await ledgerRows();
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((r) => meta(r).emailedSeats))).toEqual(new Set([2]));
  });

  it('every seat muted: no email, and the vendor still gets every portal row', async () => {
    await mute(GLOBEX_SEAT);
    await mute(SEAT_2);
    await mute(SEAT_3);

    const result = await run(forty());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sent: 0, portalOnly: 40, digestsSent: 0 });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((r) => meta(r).emailedSeats))).toEqual(new Set([0]));
    expect(new Set(rows.map((r) => meta(r).vendorId))).toEqual(new Set([GLOBEX]));
  });

  it('a muted seat is not looked up and gets no token minted', async () => {
    await mute(SEAT_2);
    const lookups: string[][] = [];
    await runAttestationNotifySweep(ctx(), t.db, {
      now: NOW,
      runDetectors: detectors([finding()]) as never,
      fetchSeatEmails: async (_env, ids) => {
        lookups.push([...ids]);
        return threeSeatEmails();
      },
    });
    expect(lookups).toEqual([[GLOBEX_SEAT, SEAT_3].sort()]);
  });

  it('mints a mute token per emailed seat, audited, and puts it in the headers', async () => {
    await run([finding()]);

    const prefs = await t.db.select().from(notificationPreferences);
    expect(prefs.map((p) => p.profileId).sort()).toEqual([GLOBEX_SEAT, SEAT_2, SEAT_3].sort());
    expect(prefs.every((p) => p.nudgesMutedAt === null)).toBe(true);
    const created = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, PREFERENCES_CREATED_ACTION));
    expect(created).toHaveLength(3);
    // The token is a capability: never in an audit row.
    for (const row of created) {
      expect(JSON.stringify(row)).not.toContain(prefs[0]!.muteToken);
    }

    const tokenFor = new Map(prefs.map((p) => [p.profileId, p.muteToken]));
    const headersByTo = new Map(
      fetchSpy.mock.calls.map((call) => {
        const body = JSON.parse(String((call[1] as RequestInit).body));
        return [body.to as string, body.headers as Record<string, string>];
      }),
    );
    expect(headersByTo.get('globex@example.com')?.['List-Unsubscribe']).toBe(
      `<https://www.aecintegrations.com/api/notifications/nudges/mute?token=${tokenFor.get(GLOBEX_SEAT)}>`,
    );
  });

  it('a same-day replay after a lost ledger is a duplicate: no second email', async () => {
    await run([finding()]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Simulate the ledger chunk that failed to commit: the digests went out, the
    // notification.sent rows did not land.
    await t.db.delete(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));
    fetchSpy.mockClear();

    const replay = await run([finding()], new Date(NOW.getTime() + 3_600_000));

    expect(fetchSpy).not.toHaveBeenCalled();
    // `duplicate` counts as emailed: today's digest was delivered by the first run.
    expect(replay).toMatchObject({ sent: 1, digestsSent: 0 });
    expect(await ledgerRows()).toHaveLength(1);
    const dupes = await t.db
      .select()
      .from(notificationSends)
      .where(eq(notificationSends.outcome, 'duplicate'));
    expect(dupes).toHaveLength(3);
  });

  it('the next day is a new digest key', async () => {
    await run([finding({ claimId: u(1) })]);
    fetchSpy.mockClear();
    await run([finding({ claimId: u(2) })], new Date(NOW.getTime() + 86_400_000));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('a Resend outage writes no ledger row and releases the key for tomorrow', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 502 }));
    const result = await run(forty());
    expect(result).toMatchObject({ failed: 40, sent: 0 });
    expect(await ledgerRows()).toHaveLength(0);
  });
});

describe('runAttestationNotifySweep — ops digest (AECI-1204)', () => {
  const opsFinding = (n: number, detector: 'claim-denied' | 'open-conflict' = 'claim-denied') =>
    finding({ detector, vendorId: null, claimId: u(7000 + n) });

  it('sends ONE ops digest for every ops finding of the day', async () => {
    const result = await sweep([opsFinding(1), opsFinding(2, 'open-conflict'), opsFinding(3)]);

    expect(sentTo()).toEqual(['ops@aecintegrations.com']);
    expect(sentTemplatesBySubject()[0]).toBe(
      '[AECi] Attestation findings: 2 denied, 1 in conflict',
    );
    expect(result).toMatchObject({ sent: 3, digestsSent: 1 });
    const rows = await ledgerRows();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => meta(r).notificationId))).toEqual(
      new Set(['attestation-ops-digest']),
    );
    expect(new Set(rows.map((r) => meta(r).vendorId))).toEqual(new Set([null]));
  });

  it('sends one per SUPPORT_EMAIL address, each with its own dedupe key', async () => {
    await sweep([opsFinding(1)], {
      env: { SUPPORT_EMAIL: 'ops@aecintegrations.com, chris@thewbsproject.com' },
    });
    expect(sentTo()).toEqual(['ops@aecintegrations.com', 'chris@thewbsproject.com']);
  });

  it('a same-day replay sends no second ops digest', async () => {
    await sweep([opsFinding(1)]);
    await t.db.delete(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));
    fetchSpy.mockClear();

    await sweep([opsFinding(1)]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
