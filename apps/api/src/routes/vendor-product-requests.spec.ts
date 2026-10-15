/**
 * `POST` and `GET /api/vendor/product-requests` (AECI-1377 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6) against the in-memory D1 harness.
 *
 * Covers the §4.7.6 API cases: the gate (a stub sets the session `requireVendor()`
 * would; the guard itself is `vendor.authz-matrix.spec.ts`), the context-product 404,
 * the duplicate 409 and no 409 once decided, the batch and its audit metadata with no
 * typed text, the alert after commit, and the list scoped to the caller.
 */

import {
  ApiErrorCode,
  CreateProductRequestResponseSchema,
  ListVendorProductRequestsResponseSchema,
} from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productRequests,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { racingFactory } from '../test/racing-factory';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import type { DbFactory } from '../lib/handler-utils';
import {
  createListVendorProductRequestsHandler,
  createVendorProductRequestHandler,
} from './vendor-product-requests';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const P_OWN = uuid(10);
const P_PENDING = uuid(11); // A's, not promoted
const P_FOREIGN = uuid(12); // B's
const P_RESOLVED = uuid(13);

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_A = seat(1, VENDOR_A);
const AUTH_A2 = seat(2, VENDOR_A);
const AUTH_B = seat(3, VENDOR_B);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_B, slug: 'autodesk', companyName: 'Autodesk' },
  ]);
  await t.db.insert(products).values([
    { id: P_OWN, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
    { id: P_PENDING, slug: 'draft', name: 'Draft' },
    { id: P_FOREIGN, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    {
      id: P_RESOLVED,
      slug: 'field-notes',
      name: 'Field Notes',
      promotionStatus: 'promoted',
      logoUrl: 'https://cdn.example.com/fn.png',
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_OWN, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_PENDING, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_FOREIGN, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_A, AUTH_A2, AUTH_B].map((a) => ({
      id: a.userId,
      role: 'vendor_admin',
      vendorId: a.vendorId,
    })),
  );
});
afterEach(() => {
  t.dispose();
  vi.unstubAllGlobals();
});

function app(auth: AuthzVariables['auth'], factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/product-requests', createVendorProductRequestHandler(factory));
  a.get('/api/vendor/product-requests', createListVendorProductRequestsHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function post(
  auth: AuthzVariables['auth'],
  body: unknown,
  opts: { env?: Partial<Env>; factory?: DbFactory } = {},
) {
  const execCtx = fakeExecutionContext();
  const res = await app(auth, opts.factory).request(
    '/api/vendor/product-requests',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    { ...TEST_ENV, ...opts.env },
    execCtx,
  );
  return { status: res.status, body: (await res.json()) as JsonBody, execCtx };
}

async function list(auth: AuthzVariables['auth']) {
  const res = await app(auth).request(
    '/api/vendor/product-requests',
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { status: res.status, body: (await res.json()) as JsonBody };
}

const valid = {
  context_product_id: P_OWN,
  name: 'Field Notes',
  maker: 'Field Notes Inc',
  website: 'https://fieldnotes.example.com',
  body: 'They sync daily reports with us.',
};

describe('POST /api/vendor/product-requests', () => {
  it('writes the row and its audit row in one batch, and answers 201 with the request', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    const { status, body } = await post(AUTH_A, valid);
    expect(status).toBe(201);
    const parsed = CreateProductRequestResponseSchema.parse(body);
    expect(parsed.request).toMatchObject({
      status: 'open',
      context_product_id: P_OWN,
      name: 'Field Notes',
      maker: 'Field Notes Inc',
      website: 'https://fieldnotes.example.com',
      body: 'They sync daily reports with us.',
      resolved_at: null,
      decline_reason: null,
      resolved_product: null,
    });
    expect(batch).toHaveBeenCalledTimes(1);

    const [row] = await t.db.select().from(productRequests);
    expect(row).toMatchObject({
      id: parsed.request.id,
      vendorId: VENDOR_A,
      requestedBy: AUTH_A.userId,
      contextProductId: P_OWN,
      status: 'open',
    });

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'product_request.created',
      entityType: 'product_request',
      entityId: parsed.request.id,
      actorId: AUTH_A.userId,
      vendorId: VENDOR_A,
      productId: P_OWN,
    });
    expect(audits[0]!.metadata).toEqual({
      source: 'vendor-portal',
      context_product_id: P_OWN,
      has_website: true,
    });
    // The typed text never reaches the audit row, which is forwarded off the Worker.
    const serialized = JSON.stringify(audits[0]);
    for (const typed of ['Field Notes', 'fieldnotes.example.com', 'daily reports']) {
      expect(serialized).not.toContain(typed);
    }
    batch.mockRestore();
  });

  it('stores an omitted or empty website as NULL and an omitted note as empty', async () => {
    const { status, body } = await post(AUTH_A, {
      context_product_id: P_OWN,
      name: 'Bare',
      maker: 'Bare Co',
      website: '',
    });
    expect(status).toBe(201);
    expect(body.request).toMatchObject({ website: null, body: '' });
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.metadata).toMatchObject({ has_website: false });
  });

  it.each([
    ['a product of another vendor', P_FOREIGN],
    ['an unpromoted product of its own', P_PENDING],
    ['an unknown id', uuid(99)],
  ])('answers the same 404 for %s, and writes nothing', async (_label, id) => {
    const { status, body } = await post(AUTH_A, { ...valid, context_product_id: id });
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(await t.db.select().from(productRequests)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it.each([
    ['an unknown key', { ...valid, vendor_id: VENDOR_B }],
    ['a missing maker', { context_product_id: P_OWN, name: 'X' }],
    ['an http website', { ...valid, website: 'http://fieldnotes.example.com' }],
    ['a name over 200', { ...valid, name: 'x'.repeat(201) }],
    ['a note over 2000', { ...valid, body: 'x'.repeat(2001) }],
  ])('answers 400 for %s', async (_label, body) => {
    expect((await post(AUTH_A, body)).status).toBe(400);
  });

  it('answers 409 PRODUCT_REQUEST_EXISTS for an open request of the same name, any case', async () => {
    const first = await post(AUTH_A, valid);
    const second = await post(AUTH_A2, { ...valid, name: '  field NOTES ' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ApiErrorCode.PRODUCT_REQUEST_EXISTS);
    expect(second.body.error.details).toEqual({ request_id: first.body.request.id });
    expect(await t.db.select().from(productRequests)).toHaveLength(1);
  });

  it('does not block a new request once the old one is decided, or for another vendor', async () => {
    const first = await post(AUTH_A, valid);
    expect((await post(AUTH_B, { ...valid, context_product_id: P_FOREIGN })).status).toBe(201);
    await t.db.update(productRequests).set({ status: 'declined' });
    expect(first.status).toBe(201);
    expect((await post(AUTH_A, valid)).status).toBe(201);
  });

  it('rolls back the second of two concurrent asks for one name, as the same 409', async () => {
    // A concurrent ask commits between this request's duplicate read and its batch.
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db.insert(productRequests).values({
        id: uuid(70),
        vendorId: VENDOR_A,
        requestedBy: AUTH_A2.userId,
        contextProductId: P_OWN,
        name: 'Field Notes',
        maker: 'Field Notes Inc',
      });
    });
    const { status, body } = await post(AUTH_A, valid, { factory: racing });
    expect(status).toBe(409);
    expect(body.error.details).toEqual({ request_id: uuid(70) });
    expect(await t.db.select().from(productRequests)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('emails SUPPORT_EMAIL after commit, reply-to the seat, with the typed fields', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"re_1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { status, execCtx } = await post(AUTH_A, valid, {
      env: {
        RESEND_API_KEY: 'rk_test',
        EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
        SUPPORT_EMAIL: 'support@aecintegrations.com',
      },
    });
    expect(status).toBe(201);
    // Nothing is sent before the handler returns: the alert rides `waitUntil`.
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
    const resend = fetchMock.mock.calls.filter(([url]) => String(url).includes('resend'));
    expect(resend).toHaveLength(1);
    const sent = JSON.parse(String(resend[0]![1]!.body)) as {
      to: string | string[];
      subject: string;
      text: string;
      reply_to?: string;
    };
    expect(String(sent.to)).toContain('support@aecintegrations.com');
    expect(sent.subject).toContain('[AECi] Product request: Field Notes');
    expect(sent.reply_to).toBe(AUTH_A.email);
    expect(sent.text).toContain('Field Notes Inc');
    expect(sent.text).toContain('MicroStation');
    expect(sent.text).toContain('Bentley');
  });

  it('still answers 201 when the alert send fails (fail-open)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const { status, execCtx } = await post(AUTH_A, valid, {
      env: {
        RESEND_API_KEY: 'rk_test',
        EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
        SUPPORT_EMAIL: 'support@aecintegrations.com',
      },
    });
    expect(status).toBe(201);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
    expect(await t.db.select().from(productRequests)).toHaveLength(1);
  });
});

describe('GET /api/vendor/product-requests', () => {
  it("lists the caller's vendor's requests newest first, to every seat, and nobody else's", async () => {
    await t.db.insert(productRequests).values([
      {
        id: uuid(50),
        vendorId: VENDOR_A,
        requestedBy: AUTH_A.userId,
        contextProductId: P_OWN,
        name: 'Older',
        maker: 'M',
        createdAt: '2026-10-14T08:00:00.000Z',
      },
      {
        id: uuid(51),
        vendorId: VENDOR_A,
        requestedBy: AUTH_A2.userId,
        contextProductId: P_OWN,
        name: 'Field Notes',
        maker: 'Field Notes Inc',
        status: 'already_listed',
        resolvedProductId: P_RESOLVED,
        resolvedAt: '2026-10-15T09:00:00.000Z',
        createdAt: '2026-10-15T08:00:00.000Z',
      },
      {
        id: uuid(52),
        vendorId: VENDOR_A,
        requestedBy: AUTH_A.userId,
        contextProductId: P_OWN,
        name: 'Nope',
        maker: 'M',
        status: 'declined',
        declineReason: 'Not AEC software.',
        createdAt: '2026-10-13T08:00:00.000Z',
      },
      {
        id: uuid(53),
        vendorId: VENDOR_B,
        requestedBy: AUTH_B.userId,
        contextProductId: P_FOREIGN,
        name: 'Theirs',
        maker: 'M',
      },
    ]);

    const { status, body } = await list(AUTH_A2);
    expect(status).toBe(200);
    const parsed = ListVendorProductRequestsResponseSchema.parse(body);
    expect(parsed.requests.map((r) => r.id)).toEqual([uuid(51), uuid(50), uuid(52)]);
    expect(parsed.requests[0]!.resolved_product).toEqual({
      id: P_RESOLVED,
      slug: 'field-notes',
      name: 'Field Notes',
      logo_url: 'https://cdn.example.com/fn.png',
    });
    expect(parsed.requests[1]!.resolved_product).toBeNull();
    expect(parsed.requests[2]).toMatchObject({
      status: 'declined',
      decline_reason: 'Not AEC software.',
      resolved_product: null,
    });

    const other = ListVendorProductRequestsResponseSchema.parse((await list(AUTH_B)).body);
    expect(other.requests.map((r) => r.id)).toEqual([uuid(53)]);
  });

  it('returns an empty list when the vendor has asked for nothing', async () => {
    expect((await list(AUTH_A)).body).toEqual({ requests: [] });
  });
});
