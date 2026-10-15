/**
 * `POST /api/requests/listing` (AECI-1293, `VENDOR_PROGRAM_PAGE_SPEC.md` §15.4) against
 * the in-memory D1 harness: the row and its audit row in ONE batch, validation, the
 * operator alert after commit, and the Rule A placement of the path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  listingRequests,
  vendorRequests,
  workflowInstances,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createListingRequestHandler, LISTING_REQUEST_RECEIVED } from './listing-requests';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => {
  t.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PATH = '/api/requests/listing';
const app = () =>
  buildAppWithHandler({
    method: 'post',
    path: PATH,
    handler: createListingRequestHandler(t.factory),
  });

const validBody = {
  listing_name: 'Site Diary Pro',
  website: 'https://sitediary.example.com',
  submitter_name: 'Pat Lee',
  submitter_email: 'pat@sitediary.example.com',
  submitter_role: 'Founder',
  accepted_terms: true,
  body: 'We make two products.',
};

function post(
  body: unknown,
  env = TEST_ENV,
  execCtx = fakeExecutionContext(),
  headers: Record<string, string> = {},
) {
  return app().request(
    PATH,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
    execCtx,
  );
}

describe('POST /api/requests/listing', () => {
  it('writes the row and its audit row, and answers 201 with the request id', async () => {
    const res = await post(validBody);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { request_id: string; message: string };
    expect(json.message).toBe(LISTING_REQUEST_RECEIVED);

    const rows = await t.db.select().from(listingRequests);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: json.request_id,
      listingName: 'Site Diary Pro',
      website: 'https://sitediary.example.com',
      submitterEmail: 'pat@sitediary.example.com',
      submitterName: 'Pat Lee',
      submitterRole: 'Founder',
      submitterLinkedinUrl: null,
      planInterest: null,
      body: 'We make two products.',
      status: 'open',
    });

    // The request's audit row, then the vendor terms acceptance's (AECI-1366).
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['agreement.accepted', 'listing_request.created']),
    );
    const created = audits.find((a) => a.action === 'listing_request.created')!;
    expect(created).toMatchObject({
      action: 'listing_request.created',
      entityType: 'listing_request',
      entityId: json.request_id,
      actorType: 'user',
    });
    // Never the typed name, website or email in the audit metadata.
    expect(created.metadata).toEqual({
      source: 'claim-dialog',
      has_linkedin: false,
    });

    // Its own table: nothing in vendor_requests, and no workflow rows.
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
  });

  it('commits the insert, the acceptance and both audit rows in ONE db.batch (ADR 0022)', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    await post(validBody);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(4);
  });

  // ── AECI-1366: the vendor terms box ───────────────────────────────────────
  it('records the vendor terms acceptance against the listing request', async () => {
    const res = await post(validBody, TEST_ENV, fakeExecutionContext(), {
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'Mozilla/5.0 (test)',
    });
    expect(res.status).toBe(201);
    const { request_id } = (await res.json()) as { request_id: string };
    const rows = await t.db.select().from(agreementAcceptances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      document: 'vendor_terms',
      version: '1.0',
      source: 'claim',
      email: 'pat@sitediary.example.com',
      listingRequestId: request_id,
      vendorRequestId: null,
      profileId: null,
      vendorId: null,
      billingAccountId: null,
      ip: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (test)',
    });
  });

  it.each([
    ['missing', undefined],
    ['false', false],
  ])(
    'rejects accepted_terms %s with VALIDATION_FAILED on the field and writes nothing',
    async (_label, value) => {
      const res = await post({ ...validBody, accepted_terms: value });
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: { code: string; field?: string } };
      expect(error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'accepted_terms' });
      expect(await t.db.select().from(listingRequests)).toHaveLength(0);
      expect(await t.db.select().from(agreementAcceptances)).toHaveLength(0);
      expect(await t.db.select().from(auditLog)).toHaveLength(0);
    },
  );

  it('writes neither the request nor the acceptance when the batch fails', async () => {
    vi.spyOn(t.db, 'batch').mockRejectedValueOnce(new Error('D1 down'));
    const res = await post(validBody);
    expect(res.status).toBe(500);
    expect(await t.db.select().from(listingRequests)).toHaveLength(0);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(0);
  });

  it('sends the claimant a claim-received receipt after the alert, on production', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"re_1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      ...TEST_ENV,
      ENV: 'production' as const,
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      SUPPORT_EMAIL: 'support@aecintegrations.com',
      PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
    };
    const execCtx = fakeExecutionContext();
    expect((await post(validBody, env, execCtx)).status).toBe(201);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    const resend = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('resend'))
      .map(
        ([, init]) =>
          JSON.parse(String(init!.body)) as { to: string; subject: string; text: string },
      );
    expect(resend.map((m) => String(m.to))).toEqual([
      'support@aecintegrations.com',
      'pat@sitediary.example.com',
    ]);
    const receipt = resend[1]!;
    expect(receipt.subject).toBe('We got your listing request');
    expect(receipt.subject).not.toContain('Site Diary Pro');
    expect(receipt.text).toContain('Site Diary Pro');
    expect(receipt.text).toContain('https://www.aecintegrations.com/legal/vendor-terms');
    expect(receipt.text).not.toContain('/vendor?');
    expect(receipt.text).not.toContain('/auth/');
  });

  it('stores "" optional answers as NULL and an omitted body as ""', async () => {
    const { body: _b, ...minimal } = validBody;
    const res = await post({ ...minimal, submitter_linkedin_url: '' });
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(listingRequests);
    expect(row).toMatchObject({ submitterLinkedinUrl: null, body: '' });
  });

  // AECI-1365: the plan question is retired. An old client may still send the key.
  it.each(['managed', 'gold'])(
    'returns 201 for a retired plan_interest %j and stores and audits nothing for it',
    async (value) => {
      const res = await post({ ...validBody, plan_interest: value });
      expect(res.status).toBe(201);
      const [row] = await t.db.select().from(listingRequests);
      expect(row!.planInterest).toBeNull();
      const [audit] = await t.db.select().from(auditLog);
      expect(audit!.metadata).not.toHaveProperty('plan_interest');
    },
  );

  it.each([
    ['a missing name', { listing_name: '' }],
    ['an http website', { website: 'http://sitediary.example.com' }],
    ['a website that is not a URL', { website: 'sitediary' }],
    ['a non-LinkedIn profile', { submitter_linkedin_url: 'https://example.com/in/pat' }],
    ['a missing role', { submitter_role: '' }],
    ['comments over 2000 characters', { body: 'x'.repeat(2001) }],
  ])('rejects %s with VALIDATION_FAILED and writes nothing', async (_label, patch) => {
    const res = await post({ ...validBody, ...patch });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(await t.db.select().from(listingRequests)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('answers MALFORMED_REQUEST to a body that is not JSON', async () => {
    const res = await app().request(
      PATH,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MALFORMED_REQUEST',
    );
  });

  it('emails SUPPORT_EMAIL after commit, reply-to the submitter, with no plan row', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"re_1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      ...TEST_ENV,
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      SUPPORT_EMAIL: 'support@aecintegrations.com',
    };
    const execCtx = fakeExecutionContext();
    const res = await post(validBody, env, execCtx);
    expect(res.status).toBe(201);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    const resend = fetchMock.mock.calls.filter(([url]) => String(url).includes('resend'));
    expect(resend).toHaveLength(1);
    const sent = JSON.parse(String(resend[0]![1]!.body)) as {
      to: string | string[];
      subject: string;
      text: string;
      reply_to?: string | string[];
    };
    expect(String(sent.to)).toContain('support@aecintegrations.com');
    expect(sent.subject).toContain('[AECi] Listing request: Site Diary Pro');
    expect(String(sent.reply_to)).toContain('pat@sitediary.example.com');
    expect(sent.text).not.toContain('Plan interest');
    expect(sent.text).toContain('https://sitediary.example.com');
  });

  it('still answers 201 when the alert send fails (fail-open)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const env = {
      ...TEST_ENV,
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      SUPPORT_EMAIL: 'support@aecintegrations.com',
    };
    const execCtx = fakeExecutionContext();
    const res = await post(validBody, env, execCtx);
    expect(res.status).toBe(201);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
    expect(await t.db.select().from(listingRequests)).toHaveLength(1);
  });

  it('sits under /api/requests/, the prefix zone Rule A caps per IP (waf-rate-limits.md §1)', () => {
    expect(PATH.startsWith('/api/requests/')).toBe(true);
  });
});
