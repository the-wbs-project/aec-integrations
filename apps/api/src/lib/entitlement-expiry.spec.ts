/**
 * The §7 term-expiry sweep (AECI-613 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §7).
 *
 * The first describe block is an INVARIANT test (§10) — it encodes the §7.3
 * product decision, not behaviour, and must not be deleted without reopening the
 * spec:
 *
 *   **The cron warns; it never lapses.** Auto-lapse would strip a badge from a
 *   paying customer over a data-entry mistake. So the job's batch may not mutate
 *   `status`, and may not touch `vendors` at all. That is asserted against the
 *   GENERATED SQL, because it is the only form of the claim that survives a
 *   refactor: an assertion on observed row values would still pass if a future
 *   edit wrote `status = 'active'` back over itself.
 *
 * The rest is asserted by OBSERVED EFFECT (run the sweep against the real
 * migrations in the in-memory harness, read the rows back), the way
 * `vendor-entitlement.spec.ts` does. Both email seams are stubbed — no spec here
 * may reach the Resend transport.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, profiles, vendorEntitlements, vendors } from '../db/schema';
import type { BatchStmt } from './audit';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  daysUntil,
  expiryNoticeStatements,
  noticeIsDue,
  runEntitlementExpirySweep,
  EXPIRY_WARNED_ACTION,
  EXPIRY_WARNING_DAYS,
  type ExpiryContext,
  type SendEntitlementExpiringAdminEmail,
  type SendEntitlementExpiringEmail,
} from './entitlement-expiry';
import { EXPIRY_DUE_METRIC, EXPIRY_NOTICE_METRIC } from './entitlement-expiry-metrics';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_B_ID = '33333333-3333-4333-8333-333333333333';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const ENTITLEMENT_ID = '44444444-4444-4444-8444-444444444444';

const DAY_MS = 86_400_000;
const NOW = new Date('2026-08-19T11:00:00.000Z');
/** 10 days out — inside the 30-day horizon. */
const SOON = new Date(NOW.getTime() + 10 * DAY_MS).toISOString();
/** 400 days out — outside it. */
const FAR = new Date(NOW.getTime() + 400 * DAY_MS).toISOString();
const OLD_TS = '2020-01-01T00:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

// ─── Fixtures ────────────────────────────────────────────────────────────────

async function seedVendor(id = VENDOR_ID, slug = 'autodesk', verified = true) {
  await t.db.insert(vendors).values({
    id,
    slug,
    companyName: slug === 'autodesk' ? 'Autodesk' : 'Procore',
    verified,
    updatedAt: OLD_TS,
  });
}

async function seedSeat(vendorId = VENDOR_ID, id = SEAT_ID) {
  await t.db.insert(profiles).values({ id, role: 'vendor_admin', vendorId });
}

async function seedEntitlement(
  overrides: {
    id?: string;
    vendorId?: string;
    status?: string;
    periodEnd?: string | null;
    expiryNoticeSentAt?: string | null;
  } = {},
) {
  await t.db.insert(vendorEntitlements).values({
    id: overrides.id ?? ENTITLEMENT_ID,
    vendorId: overrides.vendorId ?? VENDOR_ID,
    tier: 'verified',
    status: overrides.status ?? 'active',
    periodEnd: overrides.periodEnd === undefined ? SOON : overrides.periodEnd,
    payer: 'Autodesk Inc.',
    invoiceRef: 'PO-4471',
    grantedAt: OLD_TS,
    expiryNoticeSentAt: overrides.expiryNoticeSentAt ?? null,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
  });
}

interface Recorded {
  vendor: Array<{ to: string; daysRemaining: number; periodEndDay: string }>;
  admin: Array<{ to: string; vendorSlug: string; vendorNotice: string }>;
}

/** Stubbed seams. `vendorOutcome: 'skipped'` is not enough on its own to simulate
 *  a missing service-role key — that is done by returning an empty seat map, so no
 *  address ever reaches the sender at all. */
function seams(
  outcomes: { vendor?: 'sent' | 'failed' | 'skipped'; admin?: 'sent' | 'failed' | 'skipped' } = {},
) {
  const recorded: Recorded = { vendor: [], admin: [] };
  const sendVendorEmail = vi.fn(async (_c, o) => {
    recorded.vendor.push({
      to: o.to,
      daysRemaining: o.daysRemaining,
      periodEndDay: o.periodEndDay,
    });
    return outcomes.vendor ?? 'sent';
  }) as unknown as SendEntitlementExpiringEmail;
  const sendAdminEmail = vi.fn(async (_c, o) => {
    recorded.admin.push({ to: o.to, vendorSlug: o.vendorSlug, vendorNotice: o.vendorNotice });
    return outcomes.admin ?? 'sent';
  }) as unknown as SendEntitlementExpiringAdminEmail;
  return { recorded, sendVendorEmail, sendAdminEmail };
}

interface MetricCall {
  kind: 'count' | 'gauge';
  metric: string;
  value: number;
  tags: string[];
}

function metricSink() {
  const calls: MetricCall[] = [];
  return {
    calls,
    sink: {
      count: (metric: string, value: number, tags: string[]) =>
        calls.push({ kind: 'count' as const, metric, value, tags }),
      gauge: (metric: string, value: number, tags: string[]) =>
        calls.push({ kind: 'gauge' as const, metric, value, tags }),
    },
  };
}

const waited: Array<Promise<unknown>> = [];

function ctx(env: Partial<Env> = {}): ExpiryContext {
  return {
    env: { ADMIN_ALERT_EMAIL: 'ops@aecintegrations.com', ...env } as Env,
    executionCtx: {
      waitUntil: (p: Promise<unknown>) => {
        waited.push(p);
      },
    },
    req: { raw: new Request('https://aeci-api/cron/entitlement-expiry') },
  };
}

/** Every seat resolves to an address — the deployed-tier state. */
const seatEmails = async (_env: Env, ids: readonly string[]) =>
  new Map(ids.map((id) => [id, `seat-${id.slice(0, 4)}@vendor.example`]));

/** No address resolves — the "no `SUPABASE_SERVICE_ROLE_KEY`" state. */
const noSeatEmails = async () => new Map<string, string>();

const entitlementOf = async (id = ENTITLEMENT_ID) =>
  (await t.db.select().from(vendorEntitlements).where(eq(vendorEntitlements.id, id)))[0];
const vendorOf = async (id = VENDOR_ID) =>
  (await t.db.select().from(vendors).where(eq(vendors.id, id)))[0];
const auditRows = async () => t.db.select().from(auditLog);

// ─────────────────────────────────────────────────────────────────────────────

describe('§7.3 THE NON-NEGOTIABLE — the cron warns, it never lapses', () => {
  /** `BatchStmt` is Drizzle's `BatchItem<'sqlite'>` union, which does not surface
   *  `toSQL()` on the union type even though every member has it. Narrowed here
   *  rather than in the module: the production code has no reason to know. */
  function sqlOf(stmt: BatchStmt): string {
    return (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql.toLowerCase();
  }

  /** The SET clause of an UPDATE, i.e. everything the statement actually writes.
   *  Split off the WHERE so a `status` GUARD is not mistaken for a `status` WRITE
   *  — that distinction is the whole point of this block. */
  function setClauseOf(sql: string): string {
    const where = sql.indexOf(' where ');
    return where === -1 ? sql : sql.slice(0, where);
  }

  const params = {
    entitlementId: ENTITLEMENT_ID,
    vendorId: VENDOR_ID,
    tier: 'verified',
    periodEnd: SOON,
    daysRemaining: 10,
    now: NOW.toISOString(),
    vendorNotice: 'sent' as const,
    adminNotice: 'sent' as const,
    vendorRecipients: 1,
  };

  it('emits no statement that mutates `status`', () => {
    const { stmts } = expiryNoticeStatements(t.db, params);
    for (const stmt of stmts) {
      expect(setClauseOf(sqlOf(stmt))).not.toContain('status');
    }
  });

  it('emits no statement that touches `vendors` or `verified` at all', () => {
    const { stmts } = expiryNoticeStatements(t.db, params);
    for (const stmt of stmts) {
      const sql = sqlOf(stmt);
      expect(sql).not.toContain('"vendors"');
      expect(sql).not.toContain('verified');
    }
  });

  it('writes exactly `expiry_notice_sent_at` + `updated_at`, and audits in the same batch', () => {
    const { stmts, auditEntry } = expiryNoticeStatements(t.db, params);
    expect(stmts).toHaveLength(2);

    const setClause = setClauseOf(sqlOf(stmts[0]!));
    expect(setClause).toContain('update "vendor_entitlements"');
    expect(setClause).toContain('"expiry_notice_sent_at"');
    expect(setClause).toContain('"updated_at"');
    // Nothing else. Column count in the SET clause is exactly two.
    expect(setClause.match(/"[a-z_]+" = /g)).toHaveLength(2);

    expect(sqlOf(stmts[1]!)).toContain('insert into "audit_log"');
    expect(auditEntry.action).toBe(EXPIRY_WARNED_ACTION);
    expect(auditEntry.entityType).toBe('vendor_entitlement');
    expect(auditEntry.entityId).toBe(VENDOR_ID);
    expect(auditEntry.actorType).toBe('system');
    expect(auditEntry.actorId).toBeNull();
  });

  it('guards the stamp on `status = active` — a read, not a write', () => {
    const { stmts } = expiryNoticeStatements(t.db, params);
    const sql = sqlOf(stmts[0]!);
    expect(sql.slice(sql.indexOf(' where '))).toContain('status');
  });

  it('leaves `status`, `vendors.verified` and `vendors.updated_at` untouched end to end', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    const { sendVendorEmail, sendAdminEmail } = seams();

    await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    const row = await entitlementOf();
    expect(row?.status).toBe('active');
    expect(row?.endedAt).toBeNull();
    expect(row?.expiryNoticeSentAt).toBe(NOW.toISOString());

    // The Algolia watermark (R2) must not move: nothing about the badge changed.
    const vendor = await vendorOf();
    expect(vendor?.verified).toBe(true);
    expect(vendor?.updatedAt).toBe(OLD_TS);
  });
});

describe('the scan', () => {
  it('never selects a perpetual entitlement (`period_end IS NULL`)', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement({ periodEnd: null });
    const { recorded, sendVendorEmail, sendAdminEmail } = seams();

    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.due).toBe(0);
    expect(result.warned).toBe(0);
    expect(recorded.vendor).toEqual([]);
    expect(recorded.admin).toEqual([]);
    expect((await entitlementOf())?.expiryNoticeSentAt).toBeNull();
  });

  it('ignores a term beyond the horizon', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement({ periodEnd: FAR });
    const { sendVendorEmail, sendAdminEmail } = seams();

    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.due).toBe(0);
    expect(result.warned).toBe(0);
  });

  it.each(['pending', 'expired', 'revoked'])('ignores a `%s` row inside the horizon', async (s) => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement({ status: s });
    const { sendVendorEmail, sendAdminEmail } = seams();

    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.due).toBe(0);
  });

  it('DOES select an active term already past its end date — the state nothing lapses', async () => {
    await seedVendor();
    await seedSeat();
    const past = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    await seedEntitlement({ periodEnd: past });
    const { recorded, sendVendorEmail, sendAdminEmail } = seams();

    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.due).toBe(1);
    expect(result.warned).toBe(1);
    expect(recorded.vendor[0]?.daysRemaining).toBe(-5);
    expect((await entitlementOf())?.status).toBe('active');
  });
});

describe('the `expiry_notice_sent_at` fence — one notice per term, not one per night', () => {
  it('sends on run 1 and sends nothing on run 2', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    const { recorded, sendVendorEmail, sendAdminEmail } = seams();

    const first = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });
    expect(first.warned).toBe(1);
    expect(first.suppressed).toBe(0);
    expect(recorded.vendor).toHaveLength(1);
    expect(recorded.admin).toHaveLength(1);

    const stampedAt = (await entitlementOf())?.expiryNoticeSentAt;

    // The next night's run, 24h later. Same term, still inside the horizon.
    const tomorrow = new Date(NOW.getTime() + DAY_MS);
    const second = await runEntitlementExpirySweep(ctx(), t.db, {
      now: tomorrow,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(second.due).toBe(1);
    expect(second.suppressed).toBe(1);
    expect(second.warned).toBe(0);
    // No second email of either kind, and the stamp did not move.
    expect(recorded.vendor).toHaveLength(1);
    expect(recorded.admin).toHaveLength(1);
    expect((await entitlementOf())?.expiryNoticeSentAt).toBe(stampedAt);
    // And exactly one audit row for the whole two-run sequence.
    expect(await auditRows()).toHaveLength(1);
  });

  it('re-arms when a renewal pushes `period_end` past the old stamp + window', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    const { recorded, sendVendorEmail, sendAdminEmail } = seams();

    await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });
    expect(recorded.vendor).toHaveLength(1);

    // A renewal: the term moves out a year. The stamp stays (a renewal writes the
    // term columns, not the fence) and is now older than `period_end − 30d`.
    const renewedEnd = new Date(NOW.getTime() + 365 * DAY_MS).toISOString();
    await t.db
      .update(vendorEntitlements)
      .set({ periodEnd: renewedEnd })
      .where(eq(vendorEntitlements.id, ENTITLEMENT_ID));

    // A year on, the new term is inside the horizon again.
    const later = new Date(NOW.getTime() + 350 * DAY_MS);
    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: later,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.suppressed).toBe(0);
    expect(result.warned).toBe(1);
    expect(recorded.vendor).toHaveLength(2);
    expect((await entitlementOf())?.expiryNoticeSentAt).toBe(later.toISOString());
  });

  it('leaves the fence unstamped when NOTHING was delivered, so tomorrow retries', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    const { sendVendorEmail, sendAdminEmail } = seams({ vendor: 'failed', admin: 'failed' });

    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.warned).toBe(0);
    expect(result.vendor.failed).toBe(1);
    expect(result.admin.failed).toBe(1);
    expect((await entitlementOf())?.expiryNoticeSentAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('without SUPABASE_SERVICE_ROLE_KEY', () => {
  it('reports the vendor send `skipped`, still sends the admin copy, and never throws', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    const { recorded, sendVendorEmail, sendAdminEmail } = seams();

    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      // The degraded seam: `fetchAuthUserEmails` returns an empty map without the
      // key, so no vendor address is ever resolved.
      fetchSeatEmails: noSeatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.vendor.skipped).toBe(1);
    expect(result.vendor.sent).toBe(0);
    expect(result.admin.sent).toBe(1);
    expect(recorded.vendor).toEqual([]);
    expect(recorded.admin).toHaveLength(1);
    // The admin copy names the vendor half's outcome, so "we warned them" is never
    // assumed from the operator alert alone.
    expect(recorded.admin[0]?.vendorNotice).toBe('skipped');

    // The admin copy landed, so the term is fenced — the operator is not re-nagged
    // nightly on a tier that structurally cannot reach the vendor.
    expect(result.warned).toBe(1);
    expect((await entitlementOf())?.expiryNoticeSentAt).toBe(NOW.toISOString());
  });

  it('does not stamp when there is no admin recipient either (the local/preview state)', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    const { recorded, sendVendorEmail, sendAdminEmail } = seams();

    const result = await runEntitlementExpirySweep(ctx({ ADMIN_ALERT_EMAIL: undefined }), t.db, {
      now: NOW,
      fetchSeatEmails: noSeatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(recorded.admin).toEqual([]);
    expect(result.admin.skipped).toBe(1);
    expect(result.warned).toBe(0);
    expect((await entitlementOf())?.expiryNoticeSentAt).toBeNull();
  });
});

describe('the audit row', () => {
  it('records the warning against the VENDOR id, as `system`, in the same batch', async () => {
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    const { sendVendorEmail, sendAdminEmail } = seams();

    await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe(EXPIRY_WARNED_ACTION);
    expect(row.entityType).toBe('vendor_entitlement');
    expect(row.entityId).toBe(VENDOR_ID);
    expect(row.actorType).toBe('system');
    expect(row.actorId).toBeNull();

    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata['days_remaining']).toBe(10);
    expect(metadata['warning_days']).toBe(EXPIRY_WARNING_DAYS);
    expect(metadata['vendor_notice']).toBe('sent');
    expect(metadata['admin_notice']).toBe('sent');
    expect(metadata['status_unchanged']).toBe(true);
  });
});

describe('metrics', () => {
  it('emits the due gauge on every run, zero included, and per-channel notice counts', async () => {
    const { calls, sink } = metricSink();

    // Run 1: nothing in the database at all.
    await runEntitlementExpirySweep(ctx(), t.db, { now: NOW, metrics: sink });
    expect(calls).toContainEqual({ kind: 'gauge', metric: EXPIRY_DUE_METRIC, value: 0, tags: [] });
    expect(calls.filter((c) => c.metric === EXPIRY_NOTICE_METRIC)).toEqual([]);

    // Run 2: one term due.
    await seedVendor();
    await seedSeat();
    await seedEntitlement();
    calls.length = 0;
    const { sendVendorEmail, sendAdminEmail } = seams();
    await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      metrics: sink,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(calls).toContainEqual({ kind: 'gauge', metric: EXPIRY_DUE_METRIC, value: 1, tags: [] });
    expect(calls).toContainEqual({
      kind: 'count',
      metric: EXPIRY_NOTICE_METRIC,
      value: 1,
      tags: ['channel:vendor', 'outcome:sent'],
    });
    expect(calls).toContainEqual({
      kind: 'count',
      metric: EXPIRY_NOTICE_METRIC,
      value: 1,
      tags: ['channel:admin', 'outcome:sent'],
    });
  });
});

describe('multiple vendors', () => {
  it('warns each independently, oldest term first', async () => {
    await seedVendor(VENDOR_ID, 'autodesk');
    await seedSeat(VENDOR_ID, SEAT_ID);
    await seedEntitlement({ periodEnd: new Date(NOW.getTime() + 20 * DAY_MS).toISOString() });

    await seedVendor(VENDOR_B_ID, 'procore');
    await seedSeat(VENDOR_B_ID, '55555555-5555-4555-8555-555555555555');
    await seedEntitlement({
      id: '66666666-6666-4666-8666-666666666666',
      vendorId: VENDOR_B_ID,
      periodEnd: new Date(NOW.getTime() + 2 * DAY_MS).toISOString(),
    });

    const { recorded, sendVendorEmail, sendAdminEmail } = seams();
    const result = await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.due).toBe(2);
    expect(result.warned).toBe(2);
    expect(recorded.admin.map((a) => a.vendorSlug)).toEqual(['procore', 'autodesk']);
    expect(await auditRows()).toHaveLength(2);
  });

  it('skips a banned seat but still warns the vendor through its other seats', async () => {
    await seedVendor();
    await seedSeat();
    await t.db.insert(profiles).values({
      id: '77777777-7777-4777-8777-777777777777',
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      bannedAt: OLD_TS,
    });
    await seedEntitlement();

    const { recorded, sendVendorEmail, sendAdminEmail } = seams();
    await runEntitlementExpirySweep(ctx(), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(recorded.vendor).toHaveLength(1);
    expect(recorded.vendor[0]?.to).toBe(`seat-${SEAT_ID.slice(0, 4)}@vendor.example`);
  });
});

describe('pure helpers', () => {
  it('daysUntil rounds up, so "18 hours left" reads as tomorrow', () => {
    const now = Date.parse('2026-08-19T00:00:00.000Z');
    expect(daysUntil(now, now + 30 * DAY_MS)).toBe(30);
    expect(daysUntil(now, now + Math.round(0.75 * DAY_MS))).toBe(1);
    expect(daysUntil(now, now)).toBe(0);
    expect(daysUntil(now, now - 5 * DAY_MS)).toBe(-5);
  });

  it('noticeIsDue: null stamp is due; a current-term stamp is not; an older one is', () => {
    const end = Date.parse(SOON);
    expect(noticeIsDue(null, end, 30)).toBe(true);
    // Sent 5 days ago — inside `[end − 30d, end]`, so it belongs to this term.
    expect(noticeIsDue(new Date(NOW.getTime() - 5 * DAY_MS).toISOString(), end, 30)).toBe(false);
    // Sent 90 days ago — before `end − 30d`, so it belongs to a previous term.
    expect(noticeIsDue(new Date(NOW.getTime() - 90 * DAY_MS).toISOString(), end, 30)).toBe(true);
  });

  it('noticeIsDue suppresses an unparseable stamp rather than re-nagging nightly', () => {
    expect(noticeIsDue('not-a-date', Date.parse(SOON), 30)).toBe(false);
  });
});
