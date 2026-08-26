/**
 * The §7.2/§7.3 notification sweep (AECI-302) against the in-memory D1 harness.
 *
 * The detectors have their own suite, so this one injects synthetic findings and
 * concentrates on the parts only the sweep owns: the suppression window (§7 AC
 * #2), fail-open sends (AC #4), recipient resolution, and the ledger contract.
 *
 * The Resend transport is exercised through a mocked global `fetch` rather than a
 * stubbed send helper, so the real `sendTransactionalEmail` path — template ids,
 * the missing-key skip, the non-2xx failure — is what these assertions cover.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DetectorFinding, DetectorResult } from './attestation-detectors';
import {
  NOTIFICATION_SENT_ACTION,
  NOTIFICATION_SUPPRESSION_DAYS,
  NOTIFY_BATCH_CAP,
  runAttestationNotifySweep,
  type NotificationLedgerMetadata,
  type NotifyContext,
} from './attestation-notify';
import { auditLog, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
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
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

const ENV: Env = {
  ENV: 'preview',
  RESEND_API_KEY: 'rk_test',
  EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
  ADMIN_ALERT_EMAIL: 'ops@aecintegrations.com',
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
    { detector: 'aeci-denied', findings: findings.filter((f) => f.detector === 'aeci-denied') },
  ];
}

function sweep(findings: DetectorFinding[], over: { env?: Partial<Env> } = {}) {
  return runAttestationNotifySweep(ctx(over.env), t.db, {
    now: NOW,
    runDetectors: detectors(findings) as never,
    fetchSeatEmails: seatEmails,
  });
}

async function ledgerRows() {
  return t.db.select().from(auditLog);
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

  it('emails the vendor’s unbanned seats and writes one ledger row', async () => {
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

  it('routes an ops finding to ADMIN_ALERT_EMAIL with vendorId null on the ledger', async () => {
    await sweep([finding({ detector: 'aeci-denied', vendorId: null })]);

    expect(sentTo()).toEqual(['ops@aecintegrations.com']);
    const rows = await ledgerRows();
    expect((rows[0].metadata as NotificationLedgerMetadata).vendorId).toBeNull();
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

  it('survives a network throw', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));

    const result = await sweep([finding()]);
    expect(result).toMatchObject({ failed: 1, sent: 0 });
    expect(await ledgerRows()).toHaveLength(0);
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

  it('skips an ops finding when ADMIN_ALERT_EMAIL is unset', async () => {
    const result = await sweep([finding({ detector: 'aeci-denied', vendorId: null })], {
      env: { ADMIN_ALERT_EMAIL: undefined },
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
      ['aeci.attestation.detector', 0, ['detector:aeci-denied']],
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
