/**
 * The §7 term-expiry sweep (AECI-613 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §7), over
 * `licenses` since AECI-1356 (E1.7).
 *
 * The first describe block is an INVARIANT test (§10) — it encodes the §7.3
 * product decision, not behaviour, and must not be deleted without reopening the
 * spec:
 *
 *   **The cron warns; it never lapses.** Auto-lapse would strip Managed access from a
 *   paying customer over a data-entry mistake. So the job's batch may not end a
 *   license, may not move an assignment, and may not touch `vendors` at all: no
 *   statement names `ended_at`, `assigned_product_id` or `vendors`. That is asserted
 *   against the GENERATED SQL, because it is the only form of the claim that survives
 *   a refactor: an assertion on observed row values would still pass if a future edit
 *   wrote `ended_at = NULL` back over itself.
 *
 * The rest is asserted by OBSERVED EFFECT (run the sweep against the real
 * migrations in the in-memory harness, read the rows back), the way
 * `license.spec.ts` does. Both email seams are stubbed — no spec here may reach the
 * Resend transport. The one exception is the AECI-1198 tier-policy suite, which
 * wires the REAL senders behind a stubbed global `fetch`, because the policy lives in
 * the transport and a stubbed seam would never reach it.
 */

import { LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, billingAccounts, licenses, products, profiles, vendors } from '../db/schema';
import type { BatchStmt } from './audit';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { stubPosthogIntake } from '../test/posthog-intake';
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
import {
  sendEntitlementExpiringAdminEmail,
  sendEntitlementExpiringEmail,
  type EmailOutcome,
} from './email';
import { EXPIRY_STAMP_CHUNK } from './license';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_B_ID = '33333333-3333-4333-8333-333333333333';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const LICENSE_ID = '44444444-4444-4444-8444-444444444444';

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

/** The account id for a vendor: one account per vendor, as `billing_accounts_vendor_key` holds. */
const accountFor = (vendorId: string) => `acct-${vendorId}`;

async function seedVendor(id = VENDOR_ID, slug = 'autodesk', verified = true) {
  await t.db.insert(vendors).values({
    id,
    slug,
    companyName: slug === 'autodesk' ? 'Autodesk' : slug === 'procore' ? 'Procore' : slug,
    verified,
    updatedAt: OLD_TS,
  });
  await t.db.insert(billingAccounts).values({
    id: accountFor(id),
    vendorId: id,
    name: slug,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
  });
}

async function seedSeat(vendorId = VENDOR_ID, id = SEAT_ID) {
  await t.db.insert(profiles).values({ id, role: 'vendor_admin', vendorId });
}

async function seedLicense(
  overrides: {
    id?: string;
    vendorId?: string;
    endsAt?: string | null;
    endedAt?: string | null;
    expiryNoticeSentAt?: string | null;
    source?: string;
    reference?: string | null;
    assignedProductId?: string | null;
    termsVersion?: string | null;
  } = {},
) {
  await t.db.insert(licenses).values({
    id: overrides.id ?? LICENSE_ID,
    billingAccountId: accountFor(overrides.vendorId ?? VENDOR_ID),
    source: overrides.source ?? 'invoice',
    startsAt: OLD_TS,
    endsAt: overrides.endsAt === undefined ? SOON : overrides.endsAt,
    endedAt: overrides.endedAt ?? null,
    endReason: overrides.endedAt ? 'revoked' : null,
    reference: overrides.reference === undefined ? 'PO-4471' : overrides.reference,
    expiryNoticeSentAt: overrides.expiryNoticeSentAt ?? null,
    assignedProductId: overrides.assignedProductId ?? null,
    assignedAt: overrides.assignedProductId ? OLD_TS : null,
    termsVersion: overrides.termsVersion ?? null,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
  });
}

/** Vendor, one seat and one live license ending SOON: the common case. */
async function seedTerm() {
  await seedVendor();
  await seedSeat();
  await seedLicense();
}

interface Recorded {
  vendor: Array<{
    to: string;
    daysRemaining: number;
    periodEndDay: string;
    licenseCount: number;
    productNames: readonly string[];
    sources: readonly string[];
    termsChange: boolean;
  }>;
  admin: Array<{
    to: string;
    vendorSlug: string;
    vendorNotice: string;
    licenseCount: number;
    source: string | null;
    reference: string | null;
  }>;
}

/** Stubbed seams. `vendorOutcome: 'skipped'` is not enough on its own to simulate
 *  a missing service-role key — that is done by returning an empty seat map, so no
 *  address ever reaches the sender at all. */
function seams(outcomes: { vendor?: EmailOutcome; admin?: EmailOutcome } = {}) {
  const recorded: Recorded = { vendor: [], admin: [] };
  const sendVendorEmail = vi.fn(async (_c, o) => {
    recorded.vendor.push({
      to: o.to,
      daysRemaining: o.daysRemaining,
      periodEndDay: o.periodEndDay,
      licenseCount: o.licenseCount,
      productNames: o.productNames,
      sources: o.sources,
      termsChange: o.termsChange,
    });
    return outcomes.vendor ?? 'sent';
  }) as unknown as SendEntitlementExpiringEmail;
  const sendAdminEmail = vi.fn(async (_c, o) => {
    recorded.admin.push({
      to: o.to,
      vendorSlug: o.vendorSlug,
      vendorNotice: o.vendorNotice,
      licenseCount: o.licenseCount,
      source: o.source,
      reference: o.reference,
    });
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
    env: { SUPPORT_EMAIL: 'ops@aecintegrations.com', ...env } as Env,
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

const licenseOf = async (id = LICENSE_ID) =>
  (await t.db.select().from(licenses).where(eq(licenses.id, id)))[0];
const vendorOf = async (id = VENDOR_ID) =>
  (await t.db.select().from(vendors).where(eq(vendors.id, id)))[0];
const auditRows = async () => t.db.select().from(auditLog);

/** Run the sweep at `now` with every seam stubbed. */
function sweep(
  s: ReturnType<typeof seams>,
  extra: { now?: Date; batchCap?: number; fetchSeatEmails?: typeof seatEmails } = {},
) {
  return runEntitlementExpirySweep(ctx(), t.db, {
    now: extra.now ?? NOW,
    fetchSeatEmails: extra.fetchSeatEmails ?? seatEmails,
    sendVendorEmail: s.sendVendorEmail,
    sendAdminEmail: s.sendAdminEmail,
    ...(extra.batchCap !== undefined ? { batchCap: extra.batchCap } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('§7.3 THE NON-NEGOTIABLE — the cron warns, it never lapses', () => {
  /** `BatchStmt` is Drizzle's `BatchItem<'sqlite'>` union, which does not surface
   *  `toSQL()` on the union type even though every member has it. Narrowed here
   *  rather than in the module: the production code has no reason to know. */
  function sqlOf(stmt: BatchStmt): string {
    return (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql.toLowerCase();
  }

  /** The SET clause of an UPDATE, i.e. everything the statement actually writes. */
  function setClauseOf(sql: string): string {
    const where = sql.indexOf(' where ');
    return where === -1 ? sql : sql.slice(0, where);
  }

  const params = {
    billingAccountId: accountFor(VENDOR_ID),
    vendorId: VENDOR_ID,
    licenseIds: [LICENSE_ID, '55555555-5555-4555-8555-555555555555'],
    endsAt: SOON,
    daysRemaining: 10,
    now: NOW.toISOString(),
    vendorLicenses: [{ endsAt: SOON, endedAt: null }],
    vendorNotice: 'sent' as const,
    adminNotice: 'sent' as const,
    vendorRecipients: 1,
    termsChange: false,
  };

  it('names no `ended_at`, `assigned_product_id` or `vendors` in any statement, not even as a guard', () => {
    const { stmts } = expiryNoticeStatements(t.db, params);
    for (const stmt of stmts) {
      const sql = sqlOf(stmt);
      expect(sql).not.toContain('ended_at');
      expect(sql).not.toContain('assigned_product_id');
      expect(sql).not.toContain('"vendors"');
      expect(sql).not.toContain('verified');
    }
  });

  it('writes only `expiry_notice_sent_at` + `updated_at` on `licenses`, and audits in the same batch', () => {
    const { stmts, auditEntry } = expiryNoticeStatements(t.db, params);
    expect(stmts).toHaveLength(2);

    const setClause = setClauseOf(sqlOf(stmts[0]!));
    expect(setClause).toContain('update "licenses"');
    expect(setClause).toContain('"expiry_notice_sent_at"');
    expect(setClause).toContain('"updated_at"');
    // Nothing else. Column count in the SET clause is exactly two.
    expect(setClause.match(/"[a-z_]+" = /g)).toHaveLength(2);

    expect(sqlOf(stmts[1]!)).toContain('insert into "audit_log"');
    expect(auditEntry.action).toBe(EXPIRY_WARNED_ACTION);
    expect(auditEntry.entityType).toBe('billing_account');
    expect(auditEntry.entityId).toBe(accountFor(VENDOR_ID));
    expect(auditEntry.vendorId).toBe(VENDOR_ID);
    expect(auditEntry.actorType).toBe('system');
    expect(auditEntry.actorId).toBeNull();
  });

  it('every statement in a large term still writes only the fence (one per chunk of ids)', () => {
    const many = Array.from({ length: EXPIRY_STAMP_CHUNK + 1 }, (_, i) => `lic-${i}`);
    const { stmts } = expiryNoticeStatements(t.db, { ...params, licenseIds: many });
    // Two stamp statements, then the one audit row.
    expect(stmts).toHaveLength(3);
    for (const stmt of stmts.slice(0, 2)) {
      expect(setClauseOf(sqlOf(stmt)).match(/"[a-z_]+" = /g)).toHaveLength(2);
    }
  });

  it('guards the stamp on the scanned `ends_at` — a read, not a write', () => {
    const { stmts } = expiryNoticeStatements(t.db, params);
    const sql = sqlOf(stmts[0]!);
    expect(sql.slice(sql.indexOf(' where '))).toContain('"ends_at"');
  });

  it('leaves the license live, its product, `vendors.verified` and `vendors.updated_at` untouched end to end', async () => {
    await seedVendor();
    await seedSeat();
    await t.db.update(vendors).set({ updatedAt: OLD_TS });
    await seedLicense();

    await sweep(seams());

    const row = await licenseOf();
    expect(row?.endedAt).toBeNull();
    expect(row?.endReason).toBeNull();
    expect(row?.endsAt).toBe(SOON);
    expect(row?.expiryNoticeSentAt).toBe(NOW.toISOString());

    // The Algolia watermark (R2) must not move: `verified` did not change.
    const vendor = await vendorOf();
    expect(vendor?.verified).toBe(true);
    expect(vendor?.updatedAt).toBe(OLD_TS);
  });
});

describe('the scan', () => {
  it('never selects a monthly license (`ends_at IS NULL`)', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ endsAt: null });
    const s = seams();

    const result = await sweep(s);

    expect(result.due).toBe(0);
    expect(result.warned).toBe(0);
    expect(s.recorded.vendor).toEqual([]);
    expect(s.recorded.admin).toEqual([]);
    expect((await licenseOf())?.expiryNoticeSentAt).toBeNull();
  });

  it('never selects an ended license inside the horizon', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ endedAt: OLD_TS });
    const s = seams();

    const result = await sweep(s);

    expect(result.due).toBe(0);
    expect(s.recorded.admin).toEqual([]);
    expect((await licenseOf())?.expiryNoticeSentAt).toBeNull();
  });

  it('ignores a term beyond the horizon', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ endsAt: FAR });

    const result = await sweep(seams());

    expect(result.due).toBe(0);
    expect(result.warned).toBe(0);
  });

  it('DOES select a live license already past its end date — the state nothing lapses yet', async () => {
    await seedVendor();
    await seedSeat();
    const past = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    await seedLicense({ endsAt: past });
    const s = seams();

    const result = await sweep(s);

    expect(result.due).toBe(1);
    expect(result.warned).toBe(1);
    expect(s.recorded.vendor[0]?.daysRemaining).toBe(-5);
    expect((await licenseOf())?.endedAt).toBeNull();
  });
});

describe('one notice per account per term, not per license', () => {
  const IDS = [
    'a1111111-1111-4111-8111-111111111111',
    'a2222222-2222-4222-8222-222222222222',
    'a3333333-3333-4333-8333-333333333333',
  ];

  it('sends ONE notice for three licenses on one account and end date, and stamps all three', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ id: IDS[0], reference: 'PO-1' });
    await seedLicense({ id: IDS[1], reference: 'PO-1' });
    await seedLicense({ id: IDS[2], reference: 'PO-2', source: 'complimentary' });
    const s = seams();

    const result = await sweep(s);

    expect(result.due).toBe(1);
    expect(result.warned).toBe(1);
    expect(s.recorded.vendor).toHaveLength(1);
    expect(s.recorded.admin).toHaveLength(1);
    // The operator copy carries the term's count, sources and references.
    expect(s.recorded.admin[0]).toMatchObject({
      licenseCount: 3,
      source: 'complimentary, invoice',
      reference: 'PO-1, PO-2',
    });

    const stamped = await t.db.select().from(licenses).where(inArray(licenses.id, IDS));
    expect(stamped.map((l) => l.expiryNoticeSentAt)).toEqual(IDS.map(() => NOW.toISOString()));

    // One audit row for the notice, filed under the account, naming every license.
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityType).toBe('billing_account');
    expect(rows[0]?.entityId).toBe(accountFor(VENDOR_ID));
    const metadata = rows[0]?.metadata as Record<string, unknown>;
    expect(metadata['license_ids']).toEqual([...IDS].sort());
    expect(metadata['license_count']).toBe(3);
  });

  it('treats two end dates on one account as two terms', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ id: IDS[0] });
    await seedLicense({ id: IDS[1], endsAt: new Date(NOW.getTime() + 20 * DAY_MS).toISOString() });
    const s = seams();

    const result = await sweep(s);

    expect(result.due).toBe(2);
    expect(result.warned).toBe(2);
    expect(s.recorded.admin.map((a) => a.licenseCount)).toEqual([1, 1]);
  });

  it('leaves a monthly and an ended license on the same account out of the notice', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ id: IDS[0] });
    await seedLicense({ id: IDS[1], endsAt: null });
    await seedLicense({ id: IDS[2], endedAt: OLD_TS });
    const s = seams();

    await sweep(s);

    expect(s.recorded.admin[0]?.licenseCount).toBe(1);
    expect((await licenseOf(IDS[0]))?.expiryNoticeSentAt).toBe(NOW.toISOString());
    expect((await licenseOf(IDS[1]))?.expiryNoticeSentAt).toBeNull();
    expect((await licenseOf(IDS[2]))?.expiryNoticeSentAt).toBeNull();
    // The plan snapshot reads the whole set: a live monthly license keeps it active.
    const [row] = await auditRows();
    expect(row?.vendorTier).toBe('verified');
    expect(row?.vendorEntitlementStatus).toBe('active');
  });

  it('re-warns an already-warned term when a license joins it, with the new count', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ id: IDS[0], expiryNoticeSentAt: NOW.toISOString() });
    await seedLicense({ id: IDS[1] });
    const s = seams();

    const result = await sweep(s, { now: new Date(NOW.getTime() + DAY_MS) });

    expect(result.warned).toBe(1);
    expect(s.recorded.admin[0]?.licenseCount).toBe(2);
  });
});

describe('the `expiry_notice_sent_at` fence — one notice per term, not one per night', () => {
  it('sends on run 1 and sends nothing on run 2', async () => {
    await seedTerm();
    const s = seams();

    const first = await sweep(s);
    expect(first.warned).toBe(1);
    expect(first.suppressed).toBe(0);
    expect(s.recorded.vendor).toHaveLength(1);
    expect(s.recorded.admin).toHaveLength(1);

    const stampedAt = (await licenseOf())?.expiryNoticeSentAt;

    // The next night's run, 24h later. Same term, still inside the horizon.
    const second = await sweep(s, { now: new Date(NOW.getTime() + DAY_MS) });

    expect(second.due).toBe(1);
    expect(second.suppressed).toBe(1);
    expect(second.warned).toBe(0);
    // No second email of either kind, and the stamp did not move.
    expect(s.recorded.vendor).toHaveLength(1);
    expect(s.recorded.admin).toHaveLength(1);
    expect((await licenseOf())?.expiryNoticeSentAt).toBe(stampedAt);
    // And exactly one audit row for the whole two-run sequence.
    expect(await auditRows()).toHaveLength(1);
  });

  it('re-arms when a term change pushes `ends_at` past the old stamp + window', async () => {
    await seedTerm();
    const s = seams();

    await sweep(s);
    expect(s.recorded.vendor).toHaveLength(1);

    // The term moves out a year. Here the stamp stays (a hand edit); the real writer
    // also clears it. Either way it is now older than `ends_at − 30d`.
    const renewedEnd = new Date(NOW.getTime() + 365 * DAY_MS).toISOString();
    await t.db.update(licenses).set({ endsAt: renewedEnd }).where(eq(licenses.id, LICENSE_ID));

    // A year on, the new term is inside the horizon again.
    const later = new Date(NOW.getTime() + 350 * DAY_MS);
    const result = await sweep(s, { now: later });

    expect(result.suppressed).toBe(0);
    expect(result.warned).toBe(1);
    expect(s.recorded.vendor).toHaveLength(2);
    expect((await licenseOf())?.expiryNoticeSentAt).toBe(later.toISOString());
  });

  it('leaves the fence unstamped when NOTHING was delivered, so tomorrow retries', async () => {
    await seedTerm();

    const result = await sweep(seams({ vendor: 'failed', admin: 'failed' }));

    expect(result.warned).toBe(0);
    expect(result.vendor.failed).toBe(1);
    expect(result.admin.failed).toBe(1);
    expect((await licenseOf())?.expiryNoticeSentAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);
  });

  it('counts a ledger duplicate as duplicate, not failed, and does not stamp (AECI-1202)', async () => {
    await seedTerm();

    const result = await sweep(seams({ vendor: 'duplicate', admin: 'duplicate' }));

    expect(result.warned).toBe(0);
    expect(result.vendor).toMatchObject({ duplicate: 1, failed: 0, sent: 0 });
    expect(result.admin).toMatchObject({ duplicate: 1, failed: 0, sent: 0 });
    expect((await licenseOf())?.expiryNoticeSentAt).toBeNull();
  });
});

describe('the 30-day notice content and recipients (AECI-1406, E6.3)', () => {
  const P1 = 'p1111111-1111-4111-8111-111111111111';
  const P2 = 'p2222222-2222-4222-8222-222222222222';
  const L2 = '55555555-5555-4555-8555-555555555555';
  const L3 = '66666666-6666-4666-8666-666666666666';

  async function setBillingEmail(email: string | null) {
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: email })
      .where(eq(billingAccounts.id, accountFor(VENDOR_ID)));
  }

  it('sends the vendor copy to every seat AND the billing email (decision 16)', async () => {
    await seedTerm();
    await setBillingEmail('ap@vendor.example');
    const s = seams();

    const result = await sweep(s);

    expect(s.recorded.vendor.map((v) => v.to)).toEqual([
      'seat-2222@vendor.example',
      'ap@vendor.example',
    ]);
    expect(result.vendor.sent).toBe(1);
    const metadata = (await auditRows())[0]?.metadata as Record<string, unknown>;
    expect(metadata.vendor_recipients).toBe(2);
  });

  it('sends once when the billing email is a seat address in another case', async () => {
    await seedTerm();
    await setBillingEmail('  SEAT-2222@Vendor.Example ');
    const s = seams();

    await sweep(s);

    expect(s.recorded.vendor.map((v) => v.to)).toEqual(['seat-2222@vendor.example']);
  });

  it('still reaches the billing email when no seat address resolves', async () => {
    await seedTerm();
    await setBillingEmail('ap@vendor.example');
    const s = seams();

    const result = await sweep(s, { fetchSeatEmails: noSeatEmails });

    expect(s.recorded.vendor.map((v) => v.to)).toEqual(['ap@vendor.example']);
    expect(result.vendor.sent).toBe(1);
  });

  it('passes the license count, the products, the sources and no terms change', async () => {
    await seedVendor();
    await seedSeat();
    await t.db.insert(products).values([
      { id: P1, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
      { id: P2, slug: 'bim-360', name: 'BIM 360', promotionStatus: 'promoted' },
    ]);
    await seedLicense({ assignedProductId: P1 });
    await seedLicense({ id: L2, assignedProductId: P2, source: 'complimentary' });
    // Unassigned: counted, but names no product.
    await seedLicense({ id: L3 });
    const s = seams();

    await sweep(s);

    expect(s.recorded.vendor).toHaveLength(1);
    expect(s.recorded.vendor[0]).toMatchObject({
      licenseCount: 3,
      productNames: ['BIM 360', 'Revit'],
      sources: ['complimentary', 'invoice'],
      termsChange: false,
    });
    const metadata = (await auditRows())[0]?.metadata as Record<string, unknown>;
    expect(metadata.license_count).toBe(3);
    expect(metadata.terms_change).toBe(false);
  });

  it('flags a terms change when a license accepted an older agreement version (decision 9)', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ termsVersion: '0.9', source: 'stripe' });
    await seedLicense({ id: L2, termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan });
    const s = seams();

    await sweep(s);

    expect(s.recorded.vendor[0]?.termsChange).toBe(true);
    const metadata = (await auditRows())[0]?.metadata as Record<string, unknown>;
    expect(metadata.terms_change).toBe(true);
  });

  it('gives no terms notice for the current version', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan });
    const s = seams();

    await sweep(s);

    expect(s.recorded.vendor[0]?.termsChange).toBe(false);
  });

  it('gives no terms notice for a null version, because nothing was accepted', async () => {
    await seedTerm();
    const s = seams();

    await sweep(s);

    expect(s.recorded.vendor[0]?.termsChange).toBe(false);
  });

  it('renders the price, the count and the terms notice through the real sender', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ termsVersion: '0.9' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));

    try {
      await runEntitlementExpirySweep(
        ctx({
          ENV: 'production',
          RESEND_API_KEY: 'rk_test',
          EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
          POSTHOG_PROJECT_KEY: undefined,
        }),
        t.db,
        {
          now: NOW,
          fetchSeatEmails: seatEmails,
          sendVendorEmail: sendEntitlementExpiringEmail,
          sendAdminEmail: async () => 'skipped',
        },
      );

      const vendorSend = fetchSpy.mock.calls
        .filter((call) => String(call[0]) === 'https://api.resend.com/emails')
        .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>)
        .find((b) => JSON.stringify(b.to).includes('seat-2222@vendor.example'));
      const text = String(vendorSend?.text);
      expect(text).toContain('Managed is $25 a month or $250 a year per product.');
      expect(text).toContain('It covers 1 Managed license. It is not on a product yet.');
      expect(text).toContain('A new version of the Managed plan agreement applies from');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('without SUPABASE_SERVICE_ROLE_KEY', () => {
  it('reports the vendor send `skipped`, still sends the admin copy, and never throws', async () => {
    await seedTerm();
    const s = seams();

    // The degraded seam: `fetchAuthUserEmails` returns an empty map without the key,
    // so no vendor address is ever resolved.
    const result = await sweep(s, { fetchSeatEmails: noSeatEmails });

    expect(result.vendor.skipped).toBe(1);
    expect(result.vendor.sent).toBe(0);
    expect(result.admin.sent).toBe(1);
    expect(s.recorded.vendor).toEqual([]);
    expect(s.recorded.admin).toHaveLength(1);
    // The admin copy names the vendor half's outcome, so "we warned them" is never
    // assumed from the operator alert alone.
    expect(s.recorded.admin[0]?.vendorNotice).toBe('skipped');

    // The admin copy landed, so the term is fenced — the operator is not re-nagged
    // nightly on a tier that structurally cannot reach the vendor.
    expect(result.warned).toBe(1);
    expect((await licenseOf())?.expiryNoticeSentAt).toBe(NOW.toISOString());
  });

  it('does not stamp when there is no admin recipient either (the local state)', async () => {
    await seedTerm();
    const s = seams();

    const result = await runEntitlementExpirySweep(ctx({ SUPPORT_EMAIL: undefined }), t.db, {
      now: NOW,
      fetchSeatEmails: noSeatEmails,
      sendVendorEmail: s.sendVendorEmail,
      sendAdminEmail: s.sendAdminEmail,
    });

    expect(s.recorded.admin).toEqual([]);
    expect(result.admin.skipped).toBe(1);
    expect(result.warned).toBe(0);
    expect((await licenseOf())?.expiryNoticeSentAt).toBeNull();
  });
});

describe('the audit row', () => {
  it('records the warning against the ACCOUNT, with the vendor, as `system`, in the same batch', async () => {
    await seedTerm();

    await sweep(seams());

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe(EXPIRY_WARNED_ACTION);
    expect(row.action).toBe('license.expiry_warned');
    expect(row.entityType).toBe('billing_account');
    expect(row.entityId).toBe(accountFor(VENDOR_ID));
    expect(row.vendorId).toBe(VENDOR_ID);
    expect(row.actorType).toBe('system');
    expect(row.actorId).toBeNull();
    expect(row.vendorTier).toBe('verified');
    expect(row.vendorEntitlementStatus).toBe('active');

    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata['license_ids']).toEqual([LICENSE_ID]);
    expect(metadata['ends_at']).toBe(SOON);
    expect(metadata['days_remaining']).toBe(10);
    expect(metadata['warning_days']).toBe(EXPIRY_WARNING_DAYS);
    expect(metadata['vendor_notice']).toBe('sent');
    expect(metadata['admin_notice']).toBe('sent');
    expect(metadata['warning_only']).toBe(true);
  });

  it('records `expired` when the only live license is past its end date', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense({ endsAt: new Date(NOW.getTime() - DAY_MS).toISOString() });

    await sweep(seams());

    const [row] = await auditRows();
    expect(row?.vendorEntitlementStatus).toBe('expired');
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
    await seedTerm();
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

  it('emits the due gauge as zero when only monthly licenses exist', async () => {
    const { calls, sink } = metricSink();
    await seedVendor();
    await seedLicense({ endsAt: null });

    await runEntitlementExpirySweep(ctx(), t.db, { now: NOW, metrics: sink });

    expect(calls).toEqual([{ kind: 'gauge', metric: EXPIRY_DUE_METRIC, value: 0, tags: [] }]);
  });
});

describe('multiple vendors', () => {
  it('warns each independently, oldest term first', async () => {
    await seedVendor(VENDOR_ID, 'autodesk');
    await seedSeat(VENDOR_ID, SEAT_ID);
    await seedLicense({ endsAt: new Date(NOW.getTime() + 20 * DAY_MS).toISOString() });

    await seedVendor(VENDOR_B_ID, 'procore');
    await seedSeat(VENDOR_B_ID, '55555555-5555-4555-8555-555555555555');
    await seedLicense({
      id: '66666666-6666-4666-8666-666666666666',
      vendorId: VENDOR_B_ID,
      endsAt: new Date(NOW.getTime() + 2 * DAY_MS).toISOString(),
    });

    const s = seams();
    const result = await sweep(s);

    expect(result.due).toBe(2);
    expect(result.warned).toBe(2);
    expect(s.recorded.admin.map((a) => a.vendorSlug)).toEqual(['procore', 'autodesk']);
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
    await seedLicense();

    const s = seams();
    await sweep(s);

    expect(s.recorded.vendor).toHaveLength(1);
    expect(s.recorded.vendor[0]?.to).toBe(`seat-${SEAT_ID.slice(0, 4)}@vendor.example`);
  });
});

describe('the batch cap — never-warned terms are read before the already-warned backlog', () => {
  it('warns a due term even when the cap is filled by already-warned past-term licenses', async () => {
    // The steady-state backlog: past-term live licenses already warned for their
    // (only) term. Nothing lapses yet, so they never leave the scan, they stay
    // stamped-and-suppressed, and their past `ends_at` sorts them to the FRONT of an
    // `ends_at`-only ordering.
    const past = new Date(NOW.getTime() - 5 * DAY_MS).toISOString();
    await seedVendor(VENDOR_ID, 'autodesk');
    await seedSeat(VENDOR_ID, SEAT_ID);
    await seedLicense({ endsAt: past, expiryNoticeSentAt: past });

    await seedVendor(VENDOR_B_ID, 'procore');
    await seedSeat(VENDOR_B_ID, '55555555-5555-4555-8555-555555555555');
    await seedLicense({
      id: '66666666-6666-4666-8666-666666666666',
      vendorId: VENDOR_B_ID,
      endsAt: past,
      expiryNoticeSentAt: past,
    });

    // A genuinely-due term whose future `ends_at` sorts AFTER the two past ones, and
    // whose stamp is null.
    const DUE_VENDOR = '88888888-8888-4888-8888-888888888888';
    const DUE_LICENSE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seedVendor(DUE_VENDOR, 'bluebeam');
    await seedSeat(DUE_VENDOR, '99999999-9999-4999-8999-999999999999');
    await seedLicense({ id: DUE_LICENSE, vendorId: DUE_VENDOR, endsAt: SOON });

    const s = seams();
    // Cap of 1 → the read is `LIMIT 2`. Ordered by `ends_at` alone the two past-dated
    // suppressed terms would fill it and the due term would never load;
    // never-warned-first puts the due term at the head of the window instead.
    const result = await sweep(s, { batchCap: 1 });

    expect(result.warned).toBe(1);
    expect(s.recorded.admin.map((a) => a.vendorSlug)).toEqual(['bluebeam']);
    expect((await licenseOf(DUE_LICENSE))?.expiryNoticeSentAt).toBe(NOW.toISOString());
  });

  it('counts the cap in terms, not licenses, and logs nothing silently', async () => {
    await seedVendor(VENDOR_ID, 'autodesk');
    await seedSeat(VENDOR_ID, SEAT_ID);
    // Three licenses on one term: still ONE term against a cap of 1.
    await seedLicense({ id: 'b1111111-1111-4111-8111-111111111111' });
    await seedLicense({ id: 'b2222222-2222-4222-8222-222222222222' });
    await seedLicense({ id: 'b3333333-3333-4333-8333-333333333333' });

    const result = await sweep(seams(), { batchCap: 1 });

    expect(result.capped).toBe(0);
    expect(result.warned).toBe(1);
  });
});

describe('the §26.5 forward — one request per sweep, not one per vendor (AECI-1112)', () => {
  const MANY = 8; // past the Worker's ~6 open connections (AECI-666)
  const idFor = (prefix: string, i: number) =>
    `${prefix}${i}${prefix}${i}${prefix}${i}${prefix}${i}-0000-4000-8000-00000000000${i}`;

  async function seedMany() {
    for (let i = 1; i <= MANY; i++) {
      const vendorId = idFor('a', i);
      await seedVendor(vendorId, `vendor-${i}`);
      await seedSeat(vendorId, idFor('b', i));
      await seedLicense({ id: idFor('c', i), vendorId });
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(`forwards ${MANY} warned rows' audit entries in ONE logs request`, async () => {
    await seedMany();
    const intake = stubPosthogIntake();
    const { sendVendorEmail, sendAdminEmail } = seams();

    const result = await runEntitlementExpirySweep(ctx({ POSTHOG_PROJECT_KEY: 'phc_test' }), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail,
      sendAdminEmail,
    });

    expect(result.warned).toBe(MANY);
    expect(intake.auditRequests()).toHaveLength(1);
    const messages = intake.auditRequests()[0]!.messages;
    expect(messages).toHaveLength(MANY);
    expect(messages.every((m) => m.startsWith(`audit ${EXPIRY_WARNED_ACTION} `))).toBe(true);
  });

  it('batches the stamp failures too, and a failed forward never fails the sweep', async () => {
    await seedMany();
    const intake = stubPosthogIntake(() => Promise.reject(new Error('network down')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { sendVendorEmail, sendAdminEmail } = seams();
    // Every stamp batch fails: D1 is down after the emails went out.
    const failingDb = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'batch') return () => Promise.reject(new Error('D1 unavailable'));
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await runEntitlementExpirySweep(
      ctx({ POSTHOG_PROJECT_KEY: 'phc_test' }),
      failingDb,
      { now: NOW, fetchSeatEmails: seatEmails, sendVendorEmail, sendAdminEmail },
    );
    await Promise.all(waited);

    expect(result.batchFailures).toBe(MANY);
    expect(result.warned).toBe(0);
    // No audit row committed, so nothing to forward. The failures share one request.
    expect(intake.auditRequests()).toHaveLength(0);
    expect(intake.requests).toHaveLength(1);
    expect(intake.requests[0]!.messages).toEqual(
      Array.from({ length: MANY }, () => 'aeci.entitlement.expiry.stamp_failed'),
    );
    expect(warn).toHaveBeenCalledWith('logBatchToPosthog: forward failed', expect.any(Error));
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

// ─── AECI-1198: outside recipients get mail from production only ─────────────

describe('tier delivery policy — the real senders on a demo config (AECI-1198)', () => {
  const RESEND_URL = 'https://api.resend.com/emails';
  const DEMO: Partial<Env> = {
    ENV: 'demo',
    RESEND_API_KEY: 'rk_test',
    EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
    POSTHOG_PROJECT_KEY: undefined,
  };

  afterEach(() => vi.restoreAllMocks());

  /** Parsed bodies of every Resend call. Other `fetch` traffic is ignored. */
  function resendBodies(spy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
    return spy.mock.calls
      .filter((call) => String(call[0]) === RESEND_URL)
      .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
  }

  it('sends nothing to a vendor seat, and still sends the internal operator copy', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));

    const result = await runEntitlementExpirySweep(ctx(DEMO), t.db, {
      now: NOW,
      fetchSeatEmails: seatEmails,
      sendVendorEmail: sendEntitlementExpiringEmail,
      sendAdminEmail: sendEntitlementExpiringAdminEmail,
    });

    const bodies = resendBodies(fetchSpy);
    // Zero Resend calls to the seat. The one call is the operator copy.
    expect(bodies.some((b) => JSON.stringify(b).includes('vendor.example'))).toBe(false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.to).toBe('ops@aecintegrations.com');
    expect(String(bodies[0]!.subject).startsWith('[demo] ')).toBe(true);
    expect(result.vendor).toEqual({
      sent: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      suppressed: 1,
      duplicate: 0,
      paused: 0,
    });
    expect(result.admin.sent).toBe(1);
  });

  it('with an outside operator address too, makes no Resend call at all and stamps nothing', async () => {
    await seedVendor();
    await seedSeat();
    await seedLicense();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));

    const result = await runEntitlementExpirySweep(
      ctx({ ...DEMO, SUPPORT_EMAIL: 'ops@vendor.example' }),
      t.db,
      {
        now: NOW,
        fetchSeatEmails: seatEmails,
        sendVendorEmail: sendEntitlementExpiringEmail,
        sendAdminEmail: sendEntitlementExpiringAdminEmail,
      },
    );

    expect(resendBodies(fetchSpy)).toHaveLength(0);
    expect(result.warned).toBe(0);
    expect((await licenseOf())?.expiryNoticeSentAt).toBeNull();
  });
});
