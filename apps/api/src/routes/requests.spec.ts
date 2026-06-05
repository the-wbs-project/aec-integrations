import { describe, expect, it } from 'vitest';

import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createClaimSubmitHandler, createCorrectionSubmitHandler } from './requests';

// ─── In-memory fake ───────────────────────────────────────────────────────────
// Covers the slice these handlers touch: product/vendor `findUnique` (slug→id),
// `vendorRequest.create`, `auditLog.create`, and `$transaction` (which just runs
// the callback against the same models, like the real client).
type Rec = Record<string, unknown>;

interface FakeOptions {
  productSlugToId?: Record<string, string>;
  vendorSlugToId?: Record<string, string>;
}

function makeFake(opts: FakeOptions = {}) {
  const audit: Rec[] = [];
  const created: Rec[] = [];
  let counter = 0;

  const bySlug = (map: Record<string, string> = {}) => ({
    async findUnique({ where }: { where: Rec }) {
      const id = map[where.slug as string];
      return id ? { id } : null;
    },
  });

  const models = {
    product: bySlug(opts.productSlugToId),
    vendor: bySlug(opts.vendorSlugToId),
    vendorRequest: {
      async create({ data }: { data: Rec }) {
        const id = `req_${(counter += 1)}`;
        created.push({ ...data, id });
        return { id };
      },
    },
    auditLog: {
      async create({ data }: { data: Rec }) {
        audit.push(data);
        return data;
      },
    },
    $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(models);
    },
  };

  return { models, audit, created };
}

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';

const correctionApp = (prisma: unknown) =>
  buildAppWithHandler({
    method: 'post',
    path: '/api/requests/correction',
    handler: createCorrectionSubmitHandler(() => prisma as never),
  });

const claimApp = (prisma: unknown) =>
  buildAppWithHandler({
    method: 'post',
    path: '/api/requests/claim',
    handler: createClaimSubmitHandler(() => prisma as never),
  });

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('POST /api/requests/correction', () => {
  const validBody = {
    target_type: 'product',
    slug: 'acme-build',
    body: 'The founding year on this listing is wrong; it should read 2009 not 2019.',
    source_url: '',
    submitter_email: 'reporter@example.com',
  };

  it('inserts a correction row + audit entry and returns 201 with the request id', async () => {
    const fake = makeFake({ productSlugToId: { 'acme-build': PRODUCT_ID } });
    const res = await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit(validBody),
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(201);
    const json = (await res.json()) as { request_id: string; message: string };
    expect(json.request_id).toBe('req_1');
    expect(json.message).toBeTruthy();

    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      kind: 'correction',
      targetType: 'product',
      targetId: PRODUCT_ID,
      submitterEmail: 'reporter@example.com',
      submitterName: null,
      submitterRole: null,
      sourceUrl: null, // empty string maps to NULL
    });

    expect(fake.audit).toHaveLength(1);
    expect(fake.audit[0]).toMatchObject({
      actorType: 'user',
      action: 'vendor_request.created',
      entityType: 'vendor_request',
      entityId: 'req_1',
    });
    expect((fake.audit[0].metadata as Rec).kind).toBe('correction');
  });

  it('stores a provided source URL', async () => {
    const fake = makeFake({ productSlugToId: { 'acme-build': PRODUCT_ID } });
    await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit({ ...validBody, source_url: 'https://example.com/proof' }),
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(fake.created[0]).toMatchObject({ sourceUrl: 'https://example.com/proof' });
  });

  it('rejects a too-short body with VALIDATION_FAILED (and writes nothing)', async () => {
    const fake = makeFake({ productSlugToId: { 'acme-build': PRODUCT_ID } });
    const res = await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit({ ...validBody, body: 'too short' }),
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('body');
    expect(fake.created).toHaveLength(0);
    expect(fake.audit).toHaveLength(0);
  });

  it('404s when the target slug does not resolve', async () => {
    const fake = makeFake({ productSlugToId: {} });
    const res = await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit(validBody),
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(404);
    expect(fake.created).toHaveLength(0);
  });
});

describe('POST /api/requests/claim', () => {
  const validBody = {
    target_type: 'vendor',
    slug: 'acme-co',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_role: 'Head of Partnerships',
    body: 'I lead partnerships at Acme and would like to manage this listing going forward.',
  };

  it('inserts a claim row with the submitter fields and returns 201', async () => {
    const fake = makeFake({ vendorSlugToId: { 'acme-co': VENDOR_ID } });
    const res = await claimApp(fake.models).request(
      '/api/requests/claim',
      postInit(validBody),
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(201);
    expect(fake.created[0]).toMatchObject({
      kind: 'claim',
      targetType: 'vendor',
      targetId: VENDOR_ID,
      submitterName: 'Dana Reyes',
      submitterEmail: 'dana@acme.com',
      submitterRole: 'Head of Partnerships',
    });
    expect(fake.audit[0]).toMatchObject({ action: 'vendor_request.created' });
  });

  it('rejects a missing name with VALIDATION_FAILED', async () => {
    const fake = makeFake({ vendorSlugToId: { 'acme-co': VENDOR_ID } });
    const { submitter_name: _omit, ...noName } = validBody;
    const res = await claimApp(fake.models).request(
      '/api/requests/claim',
      postInit(noName),
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(fake.created).toHaveLength(0);
  });
});
