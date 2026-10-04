/**
 * AECI-1203: replay each path that could send the same email twice, and assert one
 * Resend call.
 *
 * Every case runs the real sender down to a stubbed global `fetch`, and the send
 * ledger writes to the in-memory D1 harness (`ledgerDb` is pointed at it), so the
 * `notification_sends` UNIQUE index that refuses a held dedupe key is real SQLite.
 * The attestation path is covered in `lib/attestation-notify.spec.ts` ("a same-day
 * replay after a lost ledger is a duplicate").
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client';
import {
  mailingList,
  notificationSends,
  products,
  profiles,
  reviews,
  vendorRequests,
  vendors,
  workflowInstances,
} from '../../db/schema';
import type { Env } from '../../env';
import { errorHandler } from '../../errors';
import { createModerateReviewHandler } from '../../routes/admin-reviews';
import { createSubscribeHandler, createUnsubscribeHandler } from '../../routes/landing-forms';
import { createClaimSubmitHandler } from '../../routes/requests';
import { makeTestDb, type TestDb } from '../../test/d1';
import { buildAppWithHandler, fakeExecutionContext } from '../../test/helpers';
import type { AuthzVariables } from '../authz';
import { runClaimStaleCheck } from '../claim-stale-check';
import { runReconciliationSweep } from '../reconciliation-sweep';
import { ledgerDb } from './send-ledger';

vi.mock('./send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});

vi.mock('../../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MINUTE = 60_000;

/** Production, so the tier policy delivers to the outside test addresses. No
 *  `LINEAR_API_KEY`, so the request handler's Linear create fails without a fetch. */
const ENV: Env = {
  ENV: 'production',
  RESEND_API_KEY: 'rk_test',
  EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
  SUPPORT_EMAIL: 'support@aecintegrations.com',
  EMAIL_BCC: 'copy@aecintegrations.com',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
};

let t: TestDb;
let fetchSpy: ReturnType<typeof spyFetch>;

function spyFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));
}

beforeEach(async () => {
  t = await makeTestDb();
  fetchSpy = spyFetch();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Resend calls so far, as `[to, subject]`. */
function resendCalls(): Array<[string, string]> {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes('api.resend.com'))
    .map(([, init]) => {
      const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string };
      return [String(body.to), body.subject];
    });
}

const ledger = (notificationId: string) =>
  t.db.select().from(notificationSends).where(eq(notificationSends.notificationId, notificationId));

/** Await every `waitUntil` promise the handler scheduled. */
const drain = (ctx: ExecutionContext) =>
  Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map((call) => call[0]));

function alertCtx(env: Partial<Env> = {}) {
  return {
    env: { ...ENV, ...env },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/cron') },
  };
}

// ─── 1. Claim intake alert ───────────────────────────────────────────────────

describe('claim intake alert', () => {
  /** Submit one claim through the real handler and drain its `waitUntil`s. */
  async function submitClaim(): Promise<string> {
    await t.db.insert(vendors).values({ id: u(1), slug: 'acme-co', companyName: 'Acme' });
    const app = buildAppWithHandler({
      method: 'post',
      path: '/api/requests/claim',
      handler: createClaimSubmitHandler(t.factory),
    });
    const ctx = fakeExecutionContext();
    const res = await app.request(
      '/api/requests/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_type: 'vendor',
          slug: 'acme-co',
          submitter_name: 'Dana Reyes',
          submitter_email: 'dana@acme.com',
          submitter_role: 'Head of Partnerships',
          body: 'I lead partnerships at Acme and would like to manage this listing going forward.',
        }),
      },
      ENV,
      ctx,
    );
    expect(res.status).toBe(201);
    await drain(ctx);
    return ((await res.json()) as { request_id: string }).request_id;
  }

  /** 20 minutes later the sweep creates the Linear issue the submit could not. */
  async function sweepCreatesIssue() {
    const createIssue = vi.fn(async (_c: unknown, _s: unknown, input: { requestId: string }) => {
      await t.db
        .update(vendorRequests)
        .set({ linearIssueId: 'iss-1' })
        .where(eq(vendorRequests.id, input.requestId));
      return {
        status: 'created' as const,
        issueId: 'iss-1',
        issueUrl: 'https://linear.app/aec/issue/AECI-901/claim',
      };
    });
    return runReconciliationSweep(alertCtx(), t.db, {
      createIssue: createIssue as never,
      now: new Date(Date.now() + 20 * MINUTE),
    });
  }

  it('a delivered submit alert holds the key: the sweep send is a duplicate, one email in all', async () => {
    const requestId = await submitClaim();
    expect(resendCalls()).toHaveLength(1);

    const result = await sweepCreatesIssue();

    expect(result).toMatchObject({ retried: 1, cleared: 1 });
    expect(resendCalls()).toHaveLength(1);
    const rows = await ledger('claim-submitted-alert');
    expect(rows.map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['sent', `claim-submitted-alert:${requestId}`],
      ['duplicate', null],
    ]);
    expect(rows[0]).toMatchObject({ entityType: 'vendor_request', entityId: requestId });
  });

  it('a submit alert Resend refused released the key: the sweep sends it, with the link (AECI-1197 review)', async () => {
    fetchSpy.mockImplementationOnce(async () => new Response('busy', { status: 503 }));
    const requestId = await submitClaim();
    expect(resendCalls()).toHaveLength(1);

    await sweepCreatesIssue();

    expect(resendCalls()).toHaveLength(2);
    const second = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)) as { text: string };
    expect(second.text).toContain('https://linear.app/aec/issue/AECI-901/claim');
    const rows = await ledger('claim-submitted-alert');
    expect(rows.map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['failed', null],
      ['sent', `claim-submitted-alert:${requestId}`],
    ]);
  });

  it('a submit alert with an unknown outcome holds the key: the sweep sends nothing (AECI-1197 review)', async () => {
    fetchSpy.mockImplementationOnce(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const requestId = await submitClaim();

    await sweepCreatesIssue();

    expect(resendCalls()).toHaveLength(1);
    const rows = await ledger('claim-submitted-alert');
    expect(rows.map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['unknown', `claim-submitted-alert:${requestId}`],
      ['duplicate', null],
    ]);
  });
});

// ─── 2. Review moderation ────────────────────────────────────────────────────

describe('review moderation', () => {
  const ADMIN = u(900);
  const REVIEWER = u(901);

  function moderate(id: string, body: unknown) {
    const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    app.onError(errorHandler());
    app.use('*', async (c, next) => {
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
    app.patch(
      '/api/admin/reviews/:id',
      createModerateReviewHandler(t.factory, async () => new Map([[REVIEWER, 'rev@example.com']])),
    );
    const ctx = fakeExecutionContext();
    return {
      ctx,
      res: app.request(
        `/api/admin/reviews/${id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        ENV,
        ctx,
      ),
    };
  }

  it('two concurrent moderations: one 200, one 409, one Resend call (AECI-1203)', async () => {
    await t.db.insert(profiles).values([{ id: ADMIN, role: 'admin' }, { id: REVIEWER }]);
    await t.db.insert(products).values({ id: u(1), slug: 'revit', name: 'Revit' });
    await t.db.insert(reviews).values({
      id: u(11),
      productId: u(1),
      reviewerId: REVIEWER,
      ratingOverall: 5,
      ratingOnboarding: 4,
      title: 'T',
      body: 'B',
      status: 'pending',
    });

    // Hold the first batch until the second has committed, so both pass the pending
    // pre-read and the late batch's guarded UPDATE matches nothing.
    const original = t.db.batch.bind(t.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    vi.spyOn(t.db, 'batch').mockImplementation((async (stmts: never) => {
      calls++;
      if (calls === 1) {
        await gate;
        return original(stmts);
      }
      try {
        return await original(stmts);
      } finally {
        release();
      }
    }) as never);

    const a = moderate(u(11), { action: 'approve' });
    const b = moderate(u(11), { action: 'reject', rejection_reason: 'Not a genuine review.' });
    const [resA, resB] = await Promise.all([a.res, b.res]);
    await Promise.all([drain(a.ctx), drain(b.ctx)]);

    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    const toReviewer = resendCalls().filter(([to]) => to === 'rev@example.com');
    expect(toReviewer).toHaveLength(1);
  });

  it('a replayed decision send is a ledger duplicate with no Resend call', async () => {
    const { sendReviewApprovedEmail } = await import('../email');
    const opts = {
      to: 'rev@example.com',
      productName: 'Revit',
      productSlug: 'revit',
      dedupeKey: `review-decision:${u(11)}`,
      entity: { type: 'review', id: u(11) },
    };
    const ctx = alertCtx();
    expect(await sendReviewApprovedEmail(ctx, opts)).toBe('sent');
    expect(await sendReviewApprovedEmail(ctx, opts)).toBe('duplicate');

    expect(resendCalls()).toHaveLength(1);
    expect((await ledger('review-approved')).map((r) => r.outcome)).toEqual(['sent', 'duplicate']);
  });
});

// ─── 3. Stuck-request alert ──────────────────────────────────────────────────

describe('stuck-request alert', () => {
  it('two sweeps in one window send one email; the next band sends another (AECI-1203)', async () => {
    const created = new Date('2026-10-01T10:00:00.000Z');
    await t.db.insert(products).values({ id: u(1), slug: 'acme-build', name: 'Acme Build' });
    await t.db.insert(vendorRequests).values({
      id: 'req-1',
      kind: 'correction',
      targetType: 'product',
      targetId: u(1),
      submitterEmail: 'reporter@example.com',
      domainMatch: 'pending',
      body: 'The founding year is wrong.',
      status: 'open',
      createdAt: created.toISOString(),
    });
    await t.db.insert(workflowInstances).values({
      id: 'wf-1',
      workflowType: 'correction_request',
      entityId: 'req-1',
      currentState: 'open',
    });
    const failing = vi.fn(async () => ({ status: 'failed' as const, reason: 'timeout' as const }));
    const sweep = (ageMinutes: number) =>
      runReconciliationSweep(alertCtx(), t.db, {
        createIssue: failing as never,
        now: new Date(created.getTime() + ageMinutes * MINUTE),
      });

    // 65 min: crosses the 60-minute band. A queue retry re-runs the same window.
    await sweep(65);
    await sweep(66);
    expect(resendCalls().filter(([to]) => to === 'support@aecintegrations.com')).toHaveLength(1);
    expect((await ledger('stuck-request-alert')).map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['sent', 'stuck-request-alert:req-1:0'],
      ['duplicate', null],
    ]);

    // 6 h 5 min: the next band, a new key, a second email.
    await sweep(365);
    expect(resendCalls().filter(([to]) => to === 'support@aecintegrations.com')).toHaveLength(2);
  });
});

// ─── 4. Stale claim ticket alert ─────────────────────────────────────────────

describe('stale-claim-ticket alert', () => {
  it('two checks in one window send one email; the next day sends another (AECI-1203)', async () => {
    const created = new Date('2026-10-01T00:00:00.000Z');
    await t.db.insert(vendors).values({ id: u(1), slug: 'acme-co', companyName: 'Acme' });
    await t.db.insert(vendorRequests).values({
      id: 'req-9',
      kind: 'claim',
      targetType: 'vendor',
      targetId: u(1),
      submitterEmail: 'dana@acme.com',
      domainMatch: 'match',
      body: 'Please let me manage this listing.',
      status: 'open',
      linearIssueId: 'iss-9',
      createdAt: created.toISOString(),
    });
    const fetchStates = vi.fn(async () => ({
      ok: true as const,
      issues: new Map([
        [
          'iss-9',
          {
            id: 'iss-9',
            identifier: 'AECI-9',
            url: 'https://linear.app/aec/issue/AECI-9',
            title: 'Claim: Acme',
            stateType: 'backlog',
            stateName: 'Backlog',
          },
        ],
      ]),
    }));
    const check = (ageMinutes: number) =>
      runClaimStaleCheck(alertCtx(), t.db, {
        fetchStates,
        now: new Date(created.getTime() + ageMinutes * MINUTE),
      });
    const toFounder = () =>
      resendCalls().filter(([to]) => to === 'support@aecintegrations.com').length;

    // 25 h: crosses the 24-hour band. A double cron tick re-runs the same window.
    await check(25 * 60);
    await check(25 * 60 + 1);
    expect(toFounder()).toBe(1);
    expect((await ledger('stale-claim-ticket-alert')).map((r) => r.dedupeKey)).toEqual([
      'stale-claim-ticket-alert:req-9:0',
      null,
    ]);

    // 49 h: the first daily repeat, band 1.
    await check(49 * 60);
    expect(toFounder()).toBe(2);
  });
});

// ─── 5. Mailing list welcome + signup alert ──────────────────────────────────

describe('mailing-list welcome and signup alert', () => {
  async function post(path: string, body: unknown): Promise<Response> {
    const app = buildAppWithHandler({
      method: 'post',
      path,
      handler:
        path === '/api/subscribe'
          ? createSubscribeHandler(t.factory)
          : createUnsubscribeHandler(t.factory),
    });
    const ctx = fakeExecutionContext();
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      ENV,
      ctx,
    );
    await drain(ctx);
    return res;
  }

  const subscriber = () => resendCalls().filter(([to]) => to === 'back@example.com').length;
  const signupAlerts = () =>
    resendCalls().filter(([, subject]) => subject === '[AECi] New mailing list signup').length;
  const copies = () => resendCalls().filter(([, subject]) => subject.startsWith('COPY: ')).length;

  it('subscribe, unsubscribe, subscribe in one month: one welcome, one alert, one copy (AECI-1203)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));

    await post('/api/subscribe', { email: 'back@example.com' });
    expect([subscriber(), signupAlerts(), copies()]).toEqual([1, 1, 1]);

    const [row] = await t.db.select().from(mailingList);
    await post('/api/unsubscribe', { token: row!.unsubscribeToken });
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    const res = await post('/api/subscribe', { email: 'back@example.com' });
    expect(await res.json()).toEqual({ created: true });

    expect([subscriber(), signupAlerts(), copies()]).toEqual([1, 1, 1]);
    expect((await ledger('mailing-list-welcome')).map((r) => r.outcome)).toEqual([
      'sent',
      'duplicate',
    ]);
    expect((await ledger('landing-signup')).map((r) => r.outcome)).toEqual(['sent', 'duplicate']);
    expect((await ledger('mailing-list-welcome')).map((r) => r.entityId)).toEqual([
      String(row!.id),
      String(row!.id),
    ]);

    // Next month, a new key: the resubscribe welcomes again.
    await post('/api/unsubscribe', { token: row!.unsubscribeToken });
    vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'));
    await post('/api/subscribe', { email: 'back@example.com' });
    expect([subscriber(), signupAlerts(), copies()]).toEqual([2, 2, 2]);
  });
});
