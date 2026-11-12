/**
 * `/api/admin/legal-versions` (AECI-1688) against the in-memory D1 harness. Source of
 * truth: `docs/ADMIN_PANEL_SPEC.md` §5.22, `docs/API_CONTRACTS.md` §6.10 "Legal versions".
 *
 * INVARIANTS. None should be deleted without reopening the decision behind it:
 *
 *   1. **Every refusal writes nothing**, in the issue's order: publishing disabled (409),
 *      not upcoming (422), already published (409), inside the 30-day window (422), PDF
 *      missing, not a PDF or over 5 MB (409).
 *   2. **A publish writes the row and its audit row in ONE batch.** A lost race on the
 *      unique index is a 409, never a 500.
 *   3. **Only a material publish enqueues the notice** (AECI-1620): one message per
 *      company, after the commit, with the outcome and its audit row in one batch. A
 *      non-material publish enqueues nothing. A failed fan-out leaves
 *      `notice_enqueued_at` NULL so the page can show it.
 *   5. **The re-send** refuses in order (gate, unknown id, not material, already in
 *      effect), records its outcome with a `legal_version.notice_resent` audit row in one
 *      batch, and answers 503 after recording an incomplete fan-out.
 *   4. **The effective moment is 12:00 UTC** of the upcoming day, for the row and the
 *      window alike.
 */

import {
  AdminLegalVersionsResponseSchema,
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_PDF_MAX_BYTES,
  PublishLegalVersionResponseSchema,
  ResendLegalNoticeResponseSchema,
  type LegalAgreementDocument,
  type LegalAgreementUpcomingVersion,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  legalNoticeDeliveries,
  legalVersions,
  notificationSends,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { sha256OfBytes } from '../lib/legal-versions';
import { logBatchToPosthog } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeFakeR2Bucket, type FakeR2Bucket } from '../test/fake-r2';
import { fakeExecutionContext } from '../test/helpers';
import { seedLicense } from '../test/licenses';
import {
  createAdminLegalVersionsHandler,
  createPublishLegalVersionHandler,
  createResendLegalNoticeHandler,
  isDuplicateVersionError,
  LEGAL_VERSION_NOTICE_QUEUED_ACTION,
  LEGAL_VERSION_NOTICE_RESENT_ACTION,
  LEGAL_VERSION_PUBLISHED_ACTION,
} from './admin-legal-versions';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const NOW = new Date('2026-11-12T12:00:00.000Z');
const ADMIN = '00000000-0000-4000-8000-000000000900';
const PDF = new TextEncoder().encode('%PDF-1.7\nvendor terms 1.4\n%%EOF\n');
const VT_KEY = 'legal/vendor-terms/v1.4.pdf';

/** 45 days out: outside the window. */
const FAR_DAY = '2026-12-27';
/** 10 days out: inside it. */
const NEAR_DAY = '2026-11-22';

type Upcoming = Partial<Record<LegalAgreementDocument, LegalAgreementUpcomingVersion>>;
const VT_UPCOMING: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: FAR_DAY } };

let t: TestDb;
let bucket: FakeR2Bucket;
beforeEach(async () => {
  vi.mocked(logBatchToPosthog).mockClear();
  t = await makeTestDb();
  bucket = makeFakeR2Bucket();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

function app(upcoming: Upcoming, factory: DbFactory = t.factory, now: Date | (() => Date) = NOW) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: ADMIN,
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  const deps = { now: typeof now === 'function' ? now : () => now, upcoming };
  a.get('/api/admin/legal-versions', createAdminLegalVersionsHandler(factory, deps));
  a.post('/api/admin/legal-versions', createPublishLegalVersionHandler(factory, deps));
  a.post('/api/admin/legal-versions/:id/notice', createResendLegalNoticeHandler(factory, deps));
  return a;
}

/** The env a publish sees. `queues` stand in for every queue binding, to prove none is used. */
function envWith(over: Partial<Record<string, unknown>> = {}) {
  const queue = { send: vi.fn(), sendBatch: vi.fn() };
  const legalQueue = { send: vi.fn(), sendBatch: vi.fn(async (_messages: unknown[]) => undefined) };
  const env = {
    ENV: 'staging',
    LEGAL_PUBLISH_ENABLED: 'true',
    UPLOADS: bucket as unknown as R2Bucket,
    CACHE_PURGE_QUEUE: queue,
    OWNERSHIP_SYNC_QUEUE: queue,
    LEGAL_NOTICE_QUEUE: legalQueue,
    RESEND_API_KEY: 're_test',
    ...over,
  } as unknown as Env;
  return { env, queue, legalQueue: (over.LEGAL_NOTICE_QUEUE as typeof legalQueue) ?? legalQueue };
}

const body = (over: Record<string, unknown> = {}) => ({
  document: 'vendor_terms',
  version: '1.4',
  material: true,
  requires_acceptance: false,
  summary: ['Claims end after 90 days without a seat.'],
  ...over,
});

const putPdf = (bytes: Uint8Array = PDF, key = VT_KEY) => bucket.put(key, bytes.slice().buffer);

async function post(
  payload: unknown,
  opts: {
    upcoming?: Upcoming;
    env?: Partial<Record<string, unknown>>;
    factory?: DbFactory;
    now?: Date;
  } = {},
) {
  const ctx = fakeExecutionContext();
  const { env, queue, legalQueue } = envWith(opts.env);
  const res = await app(opts.upcoming ?? VT_UPCOMING, opts.factory, opts.now).request(
    '/api/admin/legal-versions',
    {
      method: 'POST',
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    },
    env,
    ctx,
  );
  await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map((call) => call[0]));
  return Object.assign(res, { queue, legalQueue, ctx });
}

/** The `legal_version.published` audit rows: a fan-out adds its own. */
const publishedAudits = async () =>
  (await t.db.select().from(auditLog)).filter((a) => a.action === LEGAL_VERSION_PUBLISHED_ACTION);

const codeOf = async (res: Response) =>
  ((await res.clone().json()) as { error: { code: string } }).error.code;

async function expectRefused(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(await codeOf(res)).toBe(code);
  expect(await t.db.select().from(legalVersions)).toEqual([]);
  expect(await t.db.select().from(auditLog)).toEqual([]);
}

/** A factory whose existence read always misses: the other publish has not committed yet. */
function lostRaceFactory(): DbFactory {
  return (env, opts) => {
    const ctx = t.factory(env, opts);
    const query = new Proxy(ctx.db.query, {
      get(target, prop, receiver) {
        if (prop === 'legalVersions') return { findFirst: async () => undefined };
        return Reflect.get(target, prop, receiver);
      },
    });
    const db = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === 'query') return query;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { ...ctx, db };
  };
}

describe('POST /api/admin/legal-versions: refusals, in order', () => {
  it('refuses when the tier has publishing off (409 LEGAL_PUBLISH_DISABLED), before the body', async () => {
    await putPdf();
    for (const value of ['false', undefined, 'TRUE', '1']) {
      await expectRefused(
        await post(body(), { env: { LEGAL_PUBLISH_ENABLED: value } }),
        409,
        ApiErrorCode.LEGAL_PUBLISH_DISABLED,
      );
    }
    // Before the body: an invalid body still gets the gate's answer.
    await expectRefused(
      await post('not json', { env: { LEGAL_PUBLISH_ENABLED: 'false' } }),
      409,
      ApiErrorCode.LEGAL_PUBLISH_DISABLED,
    );
  });

  it('refuses a version that is not the upcoming entry (422 LEGAL_VERSION_NOT_UPCOMING)', async () => {
    await putPdf();
    await expectRefused(
      await post(body({ version: '1.5' })),
      422,
      ApiErrorCode.LEGAL_VERSION_NOT_UPCOMING,
    );
    await expectRefused(
      await post(body({ document: 'managed_plan' })),
      422,
      ApiErrorCode.LEGAL_VERSION_NOT_UPCOMING,
    );
    await expectRefused(
      await post(body(), { upcoming: {} }),
      422,
      ApiErrorCode.LEGAL_VERSION_NOT_UPCOMING,
    );
  });

  it('refuses a version already published (409 LEGAL_VERSION_EXISTS)', async () => {
    await putPdf();
    expect((await post(body())).status).toBe(201);
    const res = await post(body());
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe(ApiErrorCode.LEGAL_VERSION_EXISTS);
    expect(await t.db.select().from(legalVersions)).toHaveLength(1);
    expect(await publishedAudits()).toHaveLength(1);
  });

  it('answers a lost race on the unique index with 409 LEGAL_VERSION_EXISTS, not 500', async () => {
    await putPdf();
    expect((await post(body())).status).toBe(201);
    // The second publish's existence read misses, so it reaches the batch and the index.
    const res = await post(body(), { factory: lostRaceFactory() });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe(ApiErrorCode.LEGAL_VERSION_EXISTS);
    expect(await t.db.select().from(legalVersions)).toHaveLength(1);
    // The batch rolled back whole: the loser's audit row is not there either.
    expect(await publishedAudits()).toHaveLength(1);
  });

  it('checks the published row before the window (409 beats 422)', async () => {
    await putPdf();
    await post(body());
    const near: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: NEAR_DAY } };
    expect(await codeOf(await post(body(), { upcoming: near }))).toBe(
      ApiErrorCode.LEGAL_VERSION_EXISTS,
    );
  });

  it('refuses a version inside the 30-day window (422 LEGAL_NOTICE_WINDOW, reason too_soon)', async () => {
    await putPdf();
    const near: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: NEAR_DAY } };
    const res = await post(body(), { upcoming: near });
    await expectRefused(res, 422, ApiErrorCode.LEGAL_NOTICE_WINDOW);
    const out = (await res.json()) as { error: { message: string; details: { reason: string } } };
    expect(out.error.details.reason).toBe('too_soon');
    expect(out.error.message).toMatch(
      /less than 30 days away\. Move the effective date, or for the Vendor Terms give an expedited reason\./,
    );
  });

  it('tells a passed date apart (reason passed), with or without an expedited reason', async () => {
    await putPdf();
    const past: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: '2026-11-01' } };
    for (const extra of [{}, { expedited_reason: 'law' }]) {
      const res = await post(body(extra), { upcoming: past });
      await expectRefused(res, 422, ApiErrorCode.LEGAL_NOTICE_WINDOW);
      const out = (await res.json()) as {
        error: { message: string; details: { reason: string } };
      };
      expect(out.error.details.reason).toBe('passed');
      expect(out.error.message).toMatch(
        /already passed\. Move the effective date; an expedited reason does not help\./,
      );
    }
  });

  it('measures the window to 12:00 UTC of the effective day', async () => {
    await putPdf();
    // 2026-12-12 12:00 UTC is exactly 30 days after NOW: allowed.
    const edge: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: '2026-12-12' } };
    // One millisecond later it is 30 days less 1 ms away: refused.
    await expectRefused(
      await post(body(), { upcoming: edge, now: new Date(NOW.getTime() + 1) }),
      422,
      ApiErrorCode.LEGAL_NOTICE_WINDOW,
    );
    const res = await post(body(), { upcoming: edge });
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(legalVersions);
    expect(new Date(row!.effectiveAt).toISOString()).toBe('2026-12-12T12:00:00.000Z');
  });

  it('checks the window before the PDF (422 beats 409)', async () => {
    const near: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: NEAR_DAY } };
    await expectRefused(
      await post(body(), { upcoming: near }),
      422,
      ApiErrorCode.LEGAL_NOTICE_WINDOW,
    );
  });

  it('lets an expedited Vendor Terms change in sooner, but only while it is in the future', async () => {
    await putPdf();
    const past: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: '2026-11-01' } };
    await expectRefused(
      await post(body({ expedited_reason: 'law' }), { upcoming: past }),
      422,
      ApiErrorCode.LEGAL_NOTICE_WINDOW,
    );
    // Today at 12:00 UTC is NOW itself: not in the future.
    const today: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: '2026-11-12' } };
    await expectRefused(
      await post(body({ expedited_reason: 'error' }), { upcoming: today }),
      422,
      ApiErrorCode.LEGAL_NOTICE_WINDOW,
    );
    const near: Upcoming = { vendor_terms: { version: '1.4', effectiveOn: NEAR_DAY } };
    const res = await post(body({ expedited_reason: 'law' }), { upcoming: near });
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(legalVersions);
    expect(row?.expeditedReason).toBe('law');
  });

  it('records no expedited reason on a version that gave the full 30 days', async () => {
    await putPdf();
    expect((await post(body({ expedited_reason: 'law' }))).status).toBe(201);
    const [row] = await t.db.select().from(legalVersions);
    expect(row?.expeditedReason).toBeNull();
  });

  it('never expedites a Managed plan version (400 on the reason)', async () => {
    await putPdf(PDF, 'legal/managed-plan-agreement/v1.2.pdf');
    const mp: Upcoming = { managed_plan: { version: '1.2', effectiveOn: NEAR_DAY } };
    const res = await post(
      body({ document: 'managed_plan', version: '1.2', expedited_reason: 'error' }),
      { upcoming: mp },
    );
    expect(res.status).toBe(400);
    expect(await t.db.select().from(legalVersions)).toEqual([]);
  });

  it('refuses a missing, non-PDF or unbound file (409 LEGAL_PDF_MISSING)', async () => {
    await expectRefused(await post(body()), 409, ApiErrorCode.LEGAL_PDF_MISSING);
    await putPdf(new TextEncoder().encode('<html>not a pdf</html>'));
    await expectRefused(await post(body()), 409, ApiErrorCode.LEGAL_PDF_MISSING);
    await putPdf();
    await expectRefused(
      await post(body(), { env: { UPLOADS: undefined } }),
      409,
      ApiErrorCode.LEGAL_PDF_MISSING,
    );
  });

  it('refuses a PDF over 5 MB (409 LEGAL_PDF_MISSING), and accepts one of exactly 5 MB', async () => {
    const big = new Uint8Array(LEGAL_PDF_MAX_BYTES + 1);
    big.set(PDF);
    await putPdf(big);
    const res = await post(body());
    await expectRefused(res, 409, ApiErrorCode.LEGAL_PDF_MISSING);
    const out = (await res.json()) as { error: { details: { problem: string } } };
    expect(out.error.details.problem).toBe('too_large');

    const max = new Uint8Array(LEGAL_PDF_MAX_BYTES);
    max.set(PDF);
    await putPdf(max);
    const ok = await post(body());
    expect(ok.status).toBe(201);
    const [row] = await t.db.select().from(legalVersions);
    expect(row?.pdfBytes).toBe(LEGAL_PDF_MAX_BYTES);
    expect(row?.pdfSha256).toBe(await sha256OfBytes(max));
  });

  it('refuses requires_acceptance without material (400), and a non-JSON body (400)', async () => {
    await putPdf();
    const res = await post(body({ material: false, requires_acceptance: true }));
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe(ApiErrorCode.VALIDATION_FAILED);
    const bad = await post('{nope');
    expect(bad.status).toBe(400);
    expect(await codeOf(bad)).toBe(ApiErrorCode.MALFORMED_REQUEST);
    expect(await t.db.select().from(legalVersions)).toEqual([]);
  });

  it('validates the summary: 1 to 10 one-line bullets of up to 300 characters', async () => {
    await putPdf();
    for (const summary of [
      [],
      Array.from({ length: 11 }, (_, i) => `Bullet ${i}`),
      ['x'.repeat(301)],
      ['two\nlines'],
      ['   '],
      ['tab\there'],
      ['bidi \u202E override'],
      ['zero\u200Bwidth'],
      ['line\u2028separator'],
    ]) {
      const res = await post(body({ summary }));
      expect(res.status, JSON.stringify(summary).slice(0, 40)).toBe(400);
    }
    expect(await t.db.select().from(legalVersions)).toEqual([]);
  });
});

describe('POST /api/admin/legal-versions: the publish', () => {
  it('writes the row and its audit row, then records an empty fan-out', async () => {
    await putPdf();
    const res = await post(
      body({
        requires_acceptance: true,
        summary: ['  Claims end after 90 days without a seat.  ', 'The notice address moves.'],
      }),
    );

    expect(res.status).toBe(201);
    const out = PublishLegalVersionResponseSchema.parse(await res.json());
    expect(out.legal_version).toMatchObject({
      document: 'vendor_terms',
      version: '1.4',
      effective_at: '2026-12-27T12:00:00.000Z',
      material: true,
      requires_acceptance: true,
      summary: ['Claims end after 90 days without a seat.', 'The notice address moves.'],
      expedited_reason: null,
      pdf_key: VT_KEY,
      pdf_sha256: await sha256OfBytes(PDF),
      pdf_bytes: PDF.length,
      published_by: ADMIN,
      published_at: NOW.toISOString(),
      notice_enqueued_at: null,
      notice_vendor_count: null,
    });

    const [row] = await t.db.select().from(legalVersions);
    const audits = await publishedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: LEGAL_VERSION_PUBLISHED_ACTION,
      entityType: 'legal_version',
      entityId: row!.id,
      actorId: ADMIN,
      actorType: 'admin',
    });
    expect(audits[0]?.afterState).toMatchObject({
      version: '1.4',
      material: true,
      requires_acceptance: true,
      pdf_sha256: row!.pdfSha256,
    });

    // No company to notify: nothing queued, and the fan-out is recorded as complete.
    expect(res.queue.send).not.toHaveBeenCalled();
    expect(res.queue.sendBatch).not.toHaveBeenCalled();
    expect(res.legalQueue.sendBatch).not.toHaveBeenCalled();
    expect(row).toMatchObject({ noticeEnqueuedAt: NOW.toISOString(), noticeVendorCount: 0 });
    expect(vi.mocked(logBatchToPosthog).mock.calls[0]?.[3]).toEqual([
      expect.objectContaining({ action: LEGAL_VERSION_PUBLISHED_ACTION, entity_id: row!.id }),
    ]);
  });

  it('builds the R2 key from the upcoming entry, not the request', async () => {
    await putPdf();
    // A padded version still trims to the upcoming one; the key never carries input.
    const res = await post(body({ version: ' 1.4 ' }));
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(legalVersions);
    expect(row).toMatchObject({ version: '1.4', pdfKey: VT_KEY });
  });

  it('rolls the batch back whole when the audit insert fails', async () => {
    await putPdf();
    t.raw.prepare('DROP TABLE audit_log').run();
    const res = await post(body());
    expect(res.status).toBe(500);
    expect(await t.db.select().from(legalVersions)).toEqual([]);
  });
});

describe('GET /api/admin/legal-versions', () => {
  const get = async (upcoming: Upcoming, env: Partial<Record<string, unknown>> = {}) => {
    const res = await app(upcoming).request(
      '/api/admin/legal-versions',
      {},
      envWith(env).env,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    return AdminLegalVersionsResponseSchema.parse(await res.json());
  };

  it('lists each upcoming entry with its published row or null', async () => {
    await putPdf();
    const upcoming: Upcoming = {
      ...VT_UPCOMING,
      managed_plan: { version: '1.2', effectiveOn: FAR_DAY },
    };
    await post(body(), { upcoming });
    const [row] = await t.db.select().from(legalVersions);

    const out = await get(upcoming);
    expect(out.publish_enabled).toBe(true);
    expect(out.upcoming).toHaveLength(2);
    expect(out.upcoming[0]).toMatchObject({
      document: 'vendor_terms',
      version: '1.4',
      effective_on: FAR_DAY,
      effective_at: '2026-12-27T12:00:00.000Z',
      current_version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      published: { id: row!.id, requires_acceptance: false },
    });
    expect(out.upcoming[1]).toMatchObject({ document: 'managed_plan', published: null });
  });

  it('ignores a published row of a version that is no longer upcoming', async () => {
    await putPdf();
    await post(body());
    const out = await get({ vendor_terms: { version: '1.5', effectiveOn: FAR_DAY } });
    expect(out.upcoming[0]).toMatchObject({ version: '1.5', published: null });
  });

  it('reports the tier switch', async () => {
    expect((await get({}, { LEGAL_PUBLISH_ENABLED: 'false' })).publish_enabled).toBe(false);
  });

  it('is empty when nothing is upcoming', async () => {
    expect(await get({})).toEqual({ publish_enabled: true, upcoming: [] });
  });
});

describe('isDuplicateVersionError', () => {
  it('finds the index name through a cause chain, and nothing else', () => {
    const inner = new Error('D1_ERROR: UNIQUE constraint failed: legal_versions.document');
    expect(isDuplicateVersionError(new Error('batch failed', { cause: inner }))).toBe(true);
    expect(isDuplicateVersionError(new Error('UNIQUE constraint failed: audit_log.id'))).toBe(
      false,
    );
  });
});

// ─── AECI-1620: the change notice ─────────────────────────────────────────────

const V1 = '11111111-1111-4111-8111-000000000001';
const V2 = '11111111-1111-4111-8111-000000000002';
const V3 = '11111111-1111-4111-8111-000000000003';

/** Three companies: two with an unbanned seat, one whose only seat is banned. */
async function seedCompanies(): Promise<void> {
  await t.db.insert(vendors).values([
    { id: V1, slug: 'one', companyName: 'One', verified: true, maintainedBy: 'vendor' },
    { id: V2, slug: 'two', companyName: 'Two', verified: true, maintainedBy: 'vendor' },
    { id: V3, slug: 'three', companyName: 'Three', verified: true, maintainedBy: 'vendor' },
  ]);
  await t.db.insert(profiles).values([
    { id: crypto.randomUUID(), role: 'vendor_admin', vendorId: V1, seatOwner: true },
    { id: crypto.randomUUID(), role: 'vendor_admin', vendorId: V2 },
    {
      id: crypto.randomUUID(),
      role: 'vendor_admin',
      vendorId: V3,
      bannedAt: '2026-11-01T00:00:00.000Z',
    },
  ]);
}

const queuedVendorIds = (q: { sendBatch: ReturnType<typeof vi.fn> }) =>
  q.sendBatch.mock.calls.flatMap(([msgs]) =>
    (msgs as { body: { vendorId: string } }[]).map((m) => m.body.vendorId),
  );

describe('POST /api/admin/legal-versions: the notice fan-out', () => {
  it('queues one message per Vendor Terms company with an unbanned seat, and records it', async () => {
    await putPdf();
    await seedCompanies();
    const res = await post(body());
    expect(res.status).toBe(201);

    expect(queuedVendorIds(res.legalQueue)).toEqual([V1, V2]);
    const [row] = await t.db.select().from(legalVersions);
    expect(res.legalQueue.sendBatch.mock.calls[0]?.[0]).toEqual([
      { body: { legalVersionId: row!.id, vendorId: V1, enqueuedAt: NOW.toISOString() } },
      { body: { legalVersionId: row!.id, vendorId: V2, enqueuedAt: NOW.toISOString() } },
    ]);
    expect(row).toMatchObject({ noticeEnqueuedAt: NOW.toISOString(), noticeVendorCount: 2 });
    const queuedAudit = (await t.db.select().from(auditLog)).find(
      (a) => a.action === LEGAL_VERSION_NOTICE_QUEUED_ACTION,
    );
    expect(queuedAudit).toMatchObject({ entityId: row!.id, actorId: ADMIN });
    expect(queuedAudit?.afterState).toMatchObject({ complete: true, notice_vendor_count: 2 });
  });

  it('queues Managed plan companies with a live subscription of any source', async () => {
    const MP_KEY = 'legal/managed-plan-agreement/v1.2.pdf';
    await putPdf(PDF, MP_KEY);
    await seedCompanies();
    await seedLicense(t.db, V1, { source: 'stripe' });
    await seedLicense(t.db, V3, { source: 'complimentary', endsAt: '2027-06-01T00:00:00.000Z' });
    await seedLicense(t.db, V2, { source: 'invoice', endedAt: '2026-10-01T00:00:00.000Z' });
    const res = await post(body({ document: 'managed_plan', version: '1.2' }), {
      upcoming: { managed_plan: { version: '1.2', effectiveOn: FAR_DAY } },
    });
    expect(res.status).toBe(201);
    // V2's only subscription ended; V3 is a grant-style complimentary account, still told.
    expect(queuedVendorIds(res.legalQueue)).toEqual([V1, V3]);
  });

  it('chunks at 100 messages per sendBatch', async () => {
    await putPdf();
    const ids = Array.from(
      { length: 205 },
      (_, i) => `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
    );
    await t.db
      .insert(vendors)
      .values(
        ids.map((id, i) => ({ id, slug: `v${i}`, companyName: `V${i}`, maintainedBy: 'vendor' })),
      );
    await t.db
      .insert(profiles)
      .values(ids.map((vendorId) => ({ id: crypto.randomUUID(), role: 'vendor_admin', vendorId })));
    const res = await post(body());
    expect(res.legalQueue.sendBatch.mock.calls.map(([m]) => (m as unknown[]).length)).toEqual([
      100, 100, 5,
    ]);
    const [row] = await t.db.select().from(legalVersions);
    expect(row?.noticeVendorCount).toBe(205);
  });

  it('enqueues nothing for a non-material version', async () => {
    await putPdf();
    await seedCompanies();
    const res = await post(body({ material: false, requires_acceptance: false }));
    expect(res.status).toBe(201);
    expect(res.legalQueue.sendBatch).not.toHaveBeenCalled();
    const [row] = await t.db.select().from(legalVersions);
    expect(row).toMatchObject({ noticeEnqueuedAt: null, noticeVendorCount: null });
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('leaves notice_enqueued_at NULL with the partial count when a chunk fails', async () => {
    await putPdf();
    await seedCompanies();
    const failing = {
      send: vi.fn(),
      sendBatch: vi.fn(async () => {
        throw new Error('queue down');
      }),
    };
    const res = await post(body(), { env: { LEGAL_NOTICE_QUEUE: failing } });
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(legalVersions);
    expect(row).toMatchObject({ noticeEnqueuedAt: null, noticeVendorCount: 0 });
    const queuedAudit = (await t.db.select().from(auditLog)).find(
      (a) => a.action === LEGAL_VERSION_NOTICE_QUEUED_ACTION,
    );
    expect(queuedAudit?.afterState).toMatchObject({ complete: false, failure: 'send_batch' });
  });

  it('records an unbound queue as not finished', async () => {
    await putPdf();
    await seedCompanies();
    await post(body(), { env: { LEGAL_NOTICE_QUEUE: undefined } });
    const [row] = await t.db.select().from(legalVersions);
    expect(row).toMatchObject({ noticeEnqueuedAt: null, noticeVendorCount: 0 });
  });
});

describe('POST /api/admin/legal-versions/:id/notice', () => {
  async function resend(
    id: string,
    opts: { env?: Partial<Record<string, unknown>>; now?: Date | (() => Date) } = {},
  ) {
    const ctx = fakeExecutionContext();
    const { env, legalQueue } = envWith(opts.env);
    const res = await app(VT_UPCOMING, t.factory, opts.now).request(
      `/api/admin/legal-versions/${id}/notice`,
      { method: 'POST' },
      env,
      ctx,
    );
    await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map((call) => call[0]));
    return Object.assign(res, { legalQueue });
  }
  const published = async (over: Record<string, unknown> = {}) => {
    await putPdf();
    await post(body(over), { env: { LEGAL_NOTICE_QUEUE: undefined } });
    const [row] = await t.db.select().from(legalVersions);
    return row!;
  };
  const resentAudits = async () =>
    (await t.db.select().from(auditLog)).filter(
      (a) => a.action === LEGAL_VERSION_NOTICE_RESENT_ACTION,
    );

  it('refuses when publishing is off (409), before reading the row', async () => {
    const res = await resend('nope', { env: { LEGAL_PUBLISH_ENABLED: 'false' } });
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe(ApiErrorCode.LEGAL_PUBLISH_DISABLED);
  });

  it('answers 404 for an unknown id', async () => {
    const res = await resend('00000000-0000-4000-8000-00000000dead');
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe(ApiErrorCode.NOT_FOUND);
  });

  it('refuses a non-material version (409 LEGAL_NOTICE_NOT_MATERIAL) and writes nothing', async () => {
    const row = await published({ material: false });
    const res = await resend(row.id);
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe(ApiErrorCode.LEGAL_NOTICE_NOT_MATERIAL);
    expect(res.legalQueue.sendBatch).not.toHaveBeenCalled();
    expect(await resentAudits()).toEqual([]);
  });

  it('refuses once the version is in effect (422 LEGAL_NOTICE_TOO_LATE)', async () => {
    const row = await published();
    const res = await resend(row.id, { now: new Date('2026-12-27T12:00:00.000Z') });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe(ApiErrorCode.LEGAL_NOTICE_TOO_LATE);
    expect(res.legalQueue.sendBatch).not.toHaveBeenCalled();
  });

  it('re-reads the audience, re-enqueues and audits in one batch with the outcome', async () => {
    // Published before any company existed: an empty, complete fan-out.
    const row = await published();
    expect(row).toMatchObject({ noticeEnqueuedAt: NOW.toISOString(), noticeVendorCount: 0 });
    await seedCompanies();

    const res = await resend(row.id);
    expect(res.status).toBe(200);
    const out = ResendLegalNoticeResponseSchema.parse(await res.json());
    expect(out.legal_version).toMatchObject({
      notice_enqueued_at: NOW.toISOString(),
      notice_vendor_count: 2,
    });
    expect(queuedVendorIds(res.legalQueue)).toEqual([V1, V2]);
    const [after] = await t.db.select().from(legalVersions);
    expect(after).toMatchObject({ noticeEnqueuedAt: NOW.toISOString(), noticeVendorCount: 2 });
    const audits = await resentAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityId: row.id,
      actorId: ADMIN,
      entityType: 'legal_version',
    });
    expect(audits[0]?.beforeState).toEqual({
      notice_enqueued_at: NOW.toISOString(),
      notice_vendor_count: 0,
    });
    expect(audits[0]?.afterState).toMatchObject({ complete: true, notice_vendor_count: 2 });
  });

  it('records an incomplete fan-out, then answers 503 LEGAL_NOTICE_ENQUEUE_FAILED', async () => {
    const row = await published();
    await seedCompanies();
    const res = await resend(row.id, { env: { LEGAL_NOTICE_QUEUE: undefined } });
    expect(res.status).toBe(503);
    expect(await codeOf(res)).toBe(ApiErrorCode.LEGAL_NOTICE_ENQUEUE_FAILED);
    const audits = await resentAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.afterState).toMatchObject({ complete: false, failure: 'unbound' });
  });

  it('does not stamp "queued" over the expired mark when the moment passes mid-fan-out', async () => {
    // Race order: the re-send passes its check before the effective moment, the consumer
    // then marks the notice expired (notice_enqueued_at NULL), and the fan-out finishes
    // after the moment. The guarded UPDATE must leave the column NULL.
    const row = await published();
    await seedCompanies();
    await t.db
      .update(legalVersions)
      .set({ noticeEnqueuedAt: null })
      .where(eq(legalVersions.id, row.id));
    const before = new Date(row.effectiveAt - 60_000);
    const after = new Date(row.effectiveAt + 1);
    let calls = 0;
    const clock = () => (++calls === 1 ? before : after);

    const res = await resend(row.id, { now: clock });
    expect(res.status).toBe(200);
    const [stored] = await t.db.select().from(legalVersions);
    expect(stored?.noticeEnqueuedAt).toBeNull();
    const audits = await resentAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.afterState).toMatchObject({ outcome_written: false });
  });

  it('re-enqueues only the companies not yet delivered', async () => {
    const row = await published();
    await seedCompanies();
    const ts = NOW.toISOString();
    await t.db.insert(legalNoticeDeliveries).values({
      legalVersionId: row.id,
      vendorId: V1,
      status: 'delivered',
      attempts: 1,
      createdAt: ts,
      updatedAt: ts,
    });
    const res = await resend(row.id);
    expect(res.status).toBe(200);
    expect(queuedVendorIds(res.legalQueue)).toEqual([V2]);
  });

  it('rolls the outcome back with its audit row when the audit insert fails', async () => {
    const row = await published();
    await seedCompanies();
    t.raw.prepare('DROP TABLE audit_log').run();
    const res = await resend(row.id, { now: new Date('2026-11-13T12:00:00.000Z') });
    expect(res.status).toBe(500);
    // The update did not land alone: the row still shows the publish's outcome.
    const [after] = await t.db.select().from(legalVersions);
    expect(after).toMatchObject({ noticeEnqueuedAt: NOW.toISOString(), noticeVendorCount: 0 });
  });
});

describe('GET /api/admin/legal-versions: notice counts', () => {
  it('counts the notice sends of the published row by outcome, and ignores duplicates', async () => {
    await putPdf();
    await post(body());
    const [row] = await t.db.select().from(legalVersions);
    const base = {
      notificationId: 'legal-terms-change',
      tier: 'staging',
      entityType: 'legal_version',
      entityId: row!.id,
    };
    await t.db.insert(notificationSends).values([
      { ...base, recipientHash: 'a', outcome: 'sent' },
      { ...base, recipientHash: 'b', outcome: 'sent' },
      { ...base, recipientHash: 'c', outcome: 'failed' },
      { ...base, recipientHash: 'd', outcome: 'suppressed' },
      { ...base, recipientHash: 'a', outcome: 'duplicate' },
      { ...base, entityId: 'other', recipientHash: 'e', outcome: 'sent' },
    ]);
    const res = await app(VT_UPCOMING).request(
      '/api/admin/legal-versions',
      {},
      envWith().env,
      fakeExecutionContext(),
    );
    const out = AdminLegalVersionsResponseSchema.parse(await res.json());
    expect(out.upcoming[0]?.notice_sends).toEqual({
      sent: 2,
      failed: 1,
      unknown: 0,
      suppressed: 1,
      skipped: 0,
    });
  });

  it('is null for an unpublished entry', async () => {
    const res = await app(VT_UPCOMING).request(
      '/api/admin/legal-versions',
      {},
      envWith().env,
      fakeExecutionContext(),
    );
    const out = AdminLegalVersionsResponseSchema.parse(await res.json());
    expect(out.upcoming[0]?.notice_sends).toBeNull();
    expect(out.upcoming[0]?.notice_deliveries).toBeNull();
  });

  it('carries the per-company delivery record of the published row', async () => {
    await putPdf();
    await seedCompanies();
    await post(body());
    const res = await app(VT_UPCOMING).request(
      '/api/admin/legal-versions',
      {},
      envWith().env,
      fakeExecutionContext(),
    );
    const out = AdminLegalVersionsResponseSchema.parse(await res.json());
    expect(out.upcoming[0]?.notice_deliveries).toEqual({
      total: 2,
      delivered: 0,
      pending: 2,
      not_reached: 0,
      not_reached_companies: [],
      delivered_to_check: 0,
      delivered_to_check_companies: [],
      stale_companies: [],
    });
  });
});
