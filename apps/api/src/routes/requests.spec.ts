import { afterEach, describe, expect, it, vi } from 'vitest';

import { LABEL_IDS } from '../lib/linear';
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
  /** slug → the product's PRIMARY vendor website (domain-match input, §7.1). */
  productWebsites?: Record<string, string | null>;
  /** slug → the vendor's own website (domain-match input, §7.1). */
  vendorWebsites?: Record<string, string | null>;
  /** Pre-seeded `open` requests the §7.2 duplicate probe matches against. */
  existingRequests?: Rec[];
}

function makeFake(opts: FakeOptions = {}) {
  const audit: Rec[] = [];
  const created: Rec[] = [];
  const workflows: Rec[] = [];
  const transitions: Rec[] = [];
  const existing = opts.existingRequests ?? [];
  let counter = 0;
  let workflowCounter = 0;

  // resolveTarget reads different shapes per type: a product needs `name` + its
  // primary vendor's website (nested `productVendors`); a vendor needs `companyName`
  // + `website`. Two builders so each returns exactly its branch's select.
  const productBySlug = (
    ids: Record<string, string> = {},
    sites: Record<string, string | null> = {},
  ) => ({
    async findUnique({ where }: { where: Rec }) {
      const id = ids[where.slug as string];
      if (!id) return null;
      const website = sites[where.slug as string] ?? null;
      return {
        id,
        name: `name-${where.slug}`,
        productVendors: website === null ? [] : [{ vendor: { website } }],
      };
    },
  });
  const vendorBySlug = (
    ids: Record<string, string> = {},
    sites: Record<string, string | null> = {},
  ) => ({
    async findUnique({ where }: { where: Rec }) {
      const id = ids[where.slug as string];
      if (!id) return null;
      return { id, companyName: `co-${where.slug}`, website: sites[where.slug as string] ?? null };
    },
  });

  const findById = (rows: Rec[], where: Rec) =>
    rows.find(
      (r) =>
        r.id === where.id &&
        (where.linearIssueId === undefined || (r.linearIssueId ?? null) === where.linearIssueId),
    );

  const models = {
    product: productBySlug(opts.productSlugToId, opts.productWebsites),
    vendor: vendorBySlug(opts.vendorSlugToId, opts.vendorWebsites),
    vendorRequest: {
      async create({ data }: { data: Rec }) {
        const id = `req_${(counter += 1)}`;
        created.push({ ...data, id });
        return { id };
      },
      // Phase 6.8 (AECI-215) duplicate probe (top-level, before the tx). Matches the
      // earliest pre-seeded `open` request for the same target sharing kind OR submitter.
      async findFirst({ where }: { where: Rec }) {
        const ors = (where.OR as Rec[] | undefined) ?? [];
        const pool = existing.filter(
          (r) =>
            r.status === where.status &&
            r.targetType === where.targetType &&
            r.targetId === where.targetId &&
            (ors.length === 0 ||
              ors.some((cond) => Object.entries(cond).every(([k, v]) => r[k] === v))),
        );
        pool.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
        const row = pool[0];
        return row
          ? { id: row.id, linearIssueId: (row.linearIssueId as string | undefined) ?? null }
          : null;
      },
      // Phase 6.4 (AECI-211) Linear-persist surface (top-level, outside the tx).
      async findUnique({ where }: { where: Rec }) {
        const row = created.find((r) => r.id === where.id);
        return row ? { linearIssueId: (row.linearIssueId as string | undefined) ?? null } : null;
      },
      async updateMany({ where, data }: { where: Rec; data: Rec }) {
        const row = findById(created, where);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    workflowInstance: {
      async create({ data }: { data: Rec }) {
        const id = `wf_${(workflowCounter += 1)}`;
        workflows.push({ ...data, id });
        return { id };
      },
      async updateMany({ where, data }: { where: Rec; data: Rec }) {
        const wf = findById(workflows, where);
        if (!wf) return { count: 0 };
        Object.assign(wf, data);
        return { count: 1 };
      },
    },
    workflowTransition: {
      async create({ data }: { data: Rec }) {
        transitions.push(data);
        return data;
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

  return { models, audit, created, workflows, transitions };
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

    // Phase 6.2: a workflow instance + genesis transition open on submit.
    expect(fake.workflows).toHaveLength(1);
    expect(fake.workflows[0]).toMatchObject({
      workflowType: 'correction_request',
      currentState: 'open',
      entityId: 'req_1',
    });
    expect(fake.workflows[0].linearIssueId).toBeUndefined(); // slot left for Phase 6.4

    expect(fake.transitions).toHaveLength(1);
    expect(fake.transitions[0]).toMatchObject({
      workflowId: 'wf_1',
      fromState: null,
      toState: 'open',
    });
    expect((fake.transitions[0].metadata as Rec).kind).toBe('correction');
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
    expect(fake.workflows).toHaveLength(0);
    expect(fake.transitions).toHaveLength(0);
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

    // Phase 6.2: claim submits open a `vendor_claim` workflow.
    expect(fake.workflows[0]).toMatchObject({
      workflowType: 'vendor_claim',
      currentState: 'open',
      entityId: 'req_1',
    });
    expect(fake.transitions[0]).toMatchObject({
      workflowId: 'wf_1',
      fromState: null,
      toState: 'open',
    });
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

// ─── Phase 6.8 (AECI-215): domain-match + duplicate signals ─────────────────────
describe('POST /api/requests/* → Phase 6.8 signals', () => {
  const correctionBody = (over: Record<string, unknown> = {}) => ({
    target_type: 'product',
    slug: 'acme-build',
    body: 'The founding year on this listing is wrong; it should read 2009 not 2019.',
    source_url: '',
    submitter_email: 'reporter@example.com',
    ...over,
  });

  async function submitCorrection(
    fake: ReturnType<typeof makeFake>,
    body: Record<string, unknown>,
  ): Promise<void> {
    const res = await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit(body),
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(201);
  }

  describe('domain-match (§7.1)', () => {
    it("matches the product's primary vendor website", async () => {
      const fake = makeFake({
        productSlugToId: { 'acme-build': PRODUCT_ID },
        productWebsites: { 'acme-build': 'https://www.acme.com' },
      });
      await submitCorrection(fake, correctionBody({ submitter_email: 'eng@acme.com' }));
      expect(fake.created[0].domainMatch).toBe('match');
      expect((fake.audit[0].metadata as Rec).domain_match).toBe('match');
      expect((fake.transitions[0].metadata as Rec).domain_match).toBe('match');
    });

    it('flags a mismatch (gmail vs the vendor domain)', async () => {
      const fake = makeFake({
        productSlugToId: { 'acme-build': PRODUCT_ID },
        productWebsites: { 'acme-build': 'https://www.acme.com' },
      });
      await submitCorrection(fake, correctionBody({ submitter_email: 'someone@gmail.com' }));
      expect(fake.created[0].domainMatch).toBe('no_match');
    });

    it('falls back to manual_review when the product has no primary vendor website', async () => {
      const fake = makeFake({ productSlugToId: { 'acme-build': PRODUCT_ID } });
      await submitCorrection(fake, correctionBody({ submitter_email: 'eng@acme.com' }));
      expect(fake.created[0].domainMatch).toBe('manual_review');
    });

    it("a vendor target uses the vendor's own website", async () => {
      const fake = makeFake({
        vendorSlugToId: { 'acme-co': VENDOR_ID },
        vendorWebsites: { 'acme-co': 'https://acme.com' },
      });
      const res = await claimApp(fake.models).request(
        '/api/requests/claim',
        postInit({
          target_type: 'vendor',
          slug: 'acme-co',
          submitter_name: 'Dana Reyes',
          submitter_email: 'dana@acme.com',
          submitter_role: 'Head of Partnerships',
          body: 'I lead partnerships at Acme and would like to manage this listing going forward.',
        }),
        TEST_ENV,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(201);
      expect(fake.created[0].domainMatch).toBe('match');
    });
  });

  describe('duplicate detection (§7.2)', () => {
    const seedOpen = (over: Rec = {}): Rec => ({
      id: 'req_existing',
      status: 'open',
      targetType: 'product',
      targetId: PRODUCT_ID,
      kind: 'correction',
      submitterEmail: 'first@unrelated.com',
      createdAt: '2026-01-01T00:00:00.000Z',
      linearIssueId: 'iss_old',
      ...over,
    });

    it('flags an existing open request of the same kind + target', async () => {
      const fake = makeFake({
        productSlugToId: { 'acme-build': PRODUCT_ID },
        existingRequests: [seedOpen()],
      });
      await submitCorrection(fake, correctionBody());
      expect(fake.created[0].duplicateOfRequestId).toBe('req_existing');
      expect((fake.audit[0].metadata as Rec).duplicate_of_request_id).toBe('req_existing');
    });

    it('flags on the same submitter even when the kind differs', async () => {
      // Existing CORRECTION by dana@acme.com; new CLAIM by dana@acme.com, same vendor.
      const fake = makeFake({
        vendorSlugToId: { 'acme-co': VENDOR_ID },
        existingRequests: [
          seedOpen({
            id: 'req_dup',
            targetType: 'vendor',
            targetId: VENDOR_ID,
            kind: 'correction',
            submitterEmail: 'dana@acme.com',
          }),
        ],
      });
      const res = await claimApp(fake.models).request(
        '/api/requests/claim',
        postInit({
          target_type: 'vendor',
          slug: 'acme-co',
          submitter_name: 'Dana Reyes',
          submitter_email: 'dana@acme.com',
          submitter_role: 'Head of Partnerships',
          body: 'I lead partnerships at Acme and would like to manage this listing.',
        }),
        TEST_ENV,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(201);
      expect(fake.created[0].duplicateOfRequestId).toBe('req_dup');
    });

    it('does not flag a resolved request or a different target', async () => {
      const fake = makeFake({
        productSlugToId: { 'acme-build': PRODUCT_ID },
        existingRequests: [
          seedOpen({ id: 'req_resolved', status: 'resolved' }),
          seedOpen({ id: 'req_other_target', targetId: VENDOR_ID }),
        ],
      });
      await submitCorrection(fake, correctionBody());
      expect(fake.created[0].duplicateOfRequestId).toBeNull();
      expect((fake.audit[0].metadata as Rec).duplicate_of_request_id).toBeNull();
    });

    it('points at the EARLIEST matching open request', async () => {
      const fake = makeFake({
        productSlugToId: { 'acme-build': PRODUCT_ID },
        existingRequests: [
          seedOpen({ id: 'req_newer', createdAt: '2026-03-01T00:00:00.000Z' }),
          seedOpen({ id: 'req_older', createdAt: '2026-01-01T00:00:00.000Z' }),
        ],
      });
      await submitCorrection(fake, correctionBody());
      expect(fake.created[0].duplicateOfRequestId).toBe('req_older');
    });
  });
});

// ─── Phase 6.4 (AECI-211): Linear issue creation via ctx.waitUntil ──────────────
// The handler fires `createLinearIssueForRequest` in the background. With no
// LINEAR_API_KEY it is a silent no-op (the existing tests above prove the 201 path
// is unperturbed); these stub the global fetch + LINEAR_API_KEY to exercise the
// background link-back and its failure mode.
describe('POST /api/requests/* → Linear issue (background)', () => {
  const ENV_WITH_LINEAR = { ...TEST_ENV, LINEAR_API_KEY: 'lin_test' };
  const validBody = {
    target_type: 'product',
    slug: 'acme-build',
    body: 'The founding year on this listing is wrong; it should read 2009 not 2019.',
    source_url: '',
    submitter_email: 'reporter@example.com',
  };

  afterEach(() => vi.unstubAllGlobals());

  function issueOkFetch() {
    // Typed with the fetch signature so `mock.calls[n][1]` (the RequestInit) is
    // inspectable — the label assertion below reads the issueCreate request body.
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: { id: 'iss_xyz', identifier: 'AECI-900', url: 'u' },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('creates a Linear issue and stores linear_issue_id on the request + workflow', async () => {
    const fetchMock = issueOkFetch();
    const fake = makeFake({ productSlugToId: { 'acme-build': PRODUCT_ID } });
    const execCtx = fakeExecutionContext();

    const res = await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit(validBody),
      ENV_WITH_LINEAR,
      execCtx,
    );
    expect(res.status).toBe(201);

    // Drain the backgrounded work before asserting on its effects.
    await vi.mocked(execCtx.waitUntil).mock.calls[0]![0];

    expect(fetchMock).toHaveBeenCalledTimes(1); // issueCreate (no source_url → no attachment)
    expect(fake.created[0].linearIssueId).toBe('iss_xyz');
    expect(fake.workflows[0].linearIssueId).toBe('iss_xyz');
  });

  it('leaves the row unlinked but still returns 201 when Linear fails', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: 'bad label' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const fake = makeFake({ productSlugToId: { 'acme-build': PRODUCT_ID } });
    const execCtx = fakeExecutionContext();

    const res = await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit(validBody),
      ENV_WITH_LINEAR,
      execCtx,
    );
    expect(res.status).toBe(201); // failure never blocks the response

    await vi.mocked(execCtx.waitUntil).mock.calls[0]![0];

    expect(fake.created[0].linearIssueId).toBeUndefined();
    expect(fake.workflows[0].linearIssueId).toBeUndefined();
  });

  it('adds the domain-check-pending label to the issue on a domain mismatch', async () => {
    const fetchMock = issueOkFetch();
    const fake = makeFake({
      productSlugToId: { 'acme-build': PRODUCT_ID },
      productWebsites: { 'acme-build': 'https://www.acme.com' },
    });
    const execCtx = fakeExecutionContext();

    const res = await correctionApp(fake.models).request(
      '/api/requests/correction',
      postInit({ ...validBody, submitter_email: 'someone@gmail.com' }),
      ENV_WITH_LINEAR,
      execCtx,
    );
    expect(res.status).toBe(201);

    await vi.mocked(execCtx.waitUntil).mock.calls[0]![0];

    const sent = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body)) as {
      variables: { input: { labelIds: string[] } };
    };
    expect(sent.variables.input.labelIds).toContain(LABEL_IDS.domainCheckPending);
  });
});
