/**
 * Vendor-request submit endpoints (AECI-128 / Phase 6.2 / 6.4 / 6.8) on the
 * Drizzle/D1 path (ADR 0016 / AECI-253), against the in-memory D1 harness. Seeds
 * real products/vendors/product_vendors so domain-match + duplicate detection run
 * over real SQL, and asserts the real vendor_requests / workflow_instances /
 * workflow_transitions / audit_log rows the atomic `db.batch` writes.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productVendors,
  products,
  vendorRequests,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { LABEL_IDS } from '../lib/linear';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createClaimSubmitHandler, createCorrectionSubmitHandler } from './requests';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/** Seed a product target; optionally its PRIMARY vendor (with a website) so the
 *  §7.1 domain-match has something to compare against. Omit `vendorWebsite` to
 *  model "no primary vendor" (→ `manual_review`). */
async function seedProduct(opts: { slug: string; id?: string; vendorWebsite?: string | null }) {
  const productId = opts.id ?? PRODUCT_ID;
  await t.db.insert(products).values({ id: productId, slug: opts.slug, name: `name-${opts.slug}` });
  if (opts.vendorWebsite !== undefined) {
    const vendorId = crypto.randomUUID();
    await t.db.insert(vendors).values({
      id: vendorId,
      slug: `v-${opts.slug}`,
      companyName: `co-${opts.slug}`,
      website: opts.vendorWebsite,
    });
    await t.db.insert(productVendors).values({ productId, vendorId, isPrimary: true });
  }
  return productId;
}

/** Seed a vendor target (its own website is the §7.1 domain-match input). */
async function seedVendor(opts: { slug: string; id?: string; website?: string | null }) {
  const vendorId = opts.id ?? VENDOR_ID;
  await t.db.insert(vendors).values({
    id: vendorId,
    slug: opts.slug,
    companyName: `co-${opts.slug}`,
    website: opts.website ?? null,
  });
  return vendorId;
}

/** Seed a pre-existing request for the §7.2 duplicate probe. */
async function seedRequest(over: Partial<typeof vendorRequests.$inferInsert> & { id: string }) {
  await t.db.insert(vendorRequests).values({
    kind: 'correction',
    status: 'open',
    targetType: 'product',
    targetId: PRODUCT_ID,
    submitterEmail: 'first@unrelated.com',
    domainMatch: 'pending',
    body: 'An existing open request body that is comfortably long enough.',
    createdAt: '2026-01-01T00:00:00.000Z',
    linearIssueId: 'iss_old',
    ...over,
  });
}

const correctionApp = () =>
  buildAppWithHandler({
    method: 'post',
    path: '/api/requests/correction',
    handler: createCorrectionSubmitHandler(t.factory),
  });
const claimApp = () =>
  buildAppWithHandler({
    method: 'post',
    path: '/api/requests/claim',
    handler: createClaimSubmitHandler(t.factory),
  });

function postInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Submit + return `{ res, request_id, created }` (the new row, looked up by the
 *  returned id). */
async function submitCorrection(
  body: Record<string, unknown>,
  env = TEST_ENV,
  execCtx = fakeExecutionContext(),
) {
  const res = await correctionApp().request(
    '/api/requests/correction',
    postInit(body),
    env,
    execCtx,
  );
  return res;
}

async function createdRow(res: Response) {
  const { request_id } = (await res.clone().json()) as { request_id: string };
  const row = await t.db.query.vendorRequests.findFirst({
    where: eq(vendorRequests.id, request_id),
  });
  return { request_id, row };
}

describe('POST /api/requests/correction', () => {
  const validBody = {
    target_type: 'product',
    slug: 'acme-build',
    body: 'The founding year on this listing is wrong; it should read 2009 not 2019.',
    source_url: '',
    submitter_email: 'reporter@example.com',
  };

  it('inserts a correction row + audit + workflow + transition, 201 with the request id', async () => {
    await seedProduct({ slug: 'acme-build' });
    const res = await submitCorrection(validBody);
    expect(res.status).toBe(201);
    const { request_id, row } = await createdRow(res);
    expect(request_id).toMatch(/^[0-9a-f-]{36}$/i);

    expect(row).toMatchObject({
      kind: 'correction',
      targetType: 'product',
      targetId: PRODUCT_ID,
      submitterEmail: 'reporter@example.com',
      submitterName: null,
      submitterRole: null,
      sourceUrl: null, // empty string maps to NULL
      status: 'open',
    });

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'user',
      action: 'vendor_request.created',
      entityType: 'vendor_request',
      entityId: request_id,
    });
    expect((audits[0]!.metadata as Record<string, unknown>).kind).toBe('correction');

    const wfs = await t.db.select().from(workflowInstances);
    expect(wfs).toHaveLength(1);
    expect(wfs[0]).toMatchObject({
      workflowType: 'correction_request',
      currentState: 'open',
      entityId: request_id,
    });
    expect(wfs[0]!.linearIssueId).toBeNull(); // slot left for Phase 6.4

    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      workflowId: wfs[0]!.id,
      fromState: null,
      toState: 'open',
    });
    expect((transitions[0]!.metadata as Record<string, unknown>).kind).toBe('correction');
  });

  it('stores a provided source URL', async () => {
    await seedProduct({ slug: 'acme-build' });
    const res = await submitCorrection({ ...validBody, source_url: 'https://example.com/proof' });
    const { row } = await createdRow(res);
    expect(row?.sourceUrl).toBe('https://example.com/proof');
  });

  it('rejects a too-short body with VALIDATION_FAILED (and writes nothing)', async () => {
    await seedProduct({ slug: 'acme-build' });
    const res = await submitCorrection({ ...validBody, body: 'too short' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('body');
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
  });

  it('404s when the target slug does not resolve', async () => {
    const res = await submitCorrection(validBody);
    expect(res.status).toBe(404);
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
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
    await seedVendor({ slug: 'acme-co' });
    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(validBody),
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(201);
    const { request_id, row } = await createdRow(res);
    expect(row).toMatchObject({
      kind: 'claim',
      targetType: 'vendor',
      targetId: VENDOR_ID,
      submitterName: 'Dana Reyes',
      submitterEmail: 'dana@acme.com',
      submitterRole: 'Head of Partnerships',
    });

    const audits = await t.db.select().from(auditLog);
    expect(audits[0]).toMatchObject({ action: 'vendor_request.created' });
    const wfs = await t.db.select().from(workflowInstances);
    expect(wfs[0]).toMatchObject({
      workflowType: 'vendor_claim',
      currentState: 'open',
      entityId: request_id,
    });
    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions[0]).toMatchObject({
      workflowId: wfs[0]!.id,
      fromState: null,
      toState: 'open',
    });
  });

  it('rejects a missing name with VALIDATION_FAILED', async () => {
    await seedVendor({ slug: 'acme-co' });
    const { submitter_name: _omit, ...noName } = validBody;
    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(noName),
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
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

  describe('domain-match (§7.1)', () => {
    it("matches the product's primary vendor website", async () => {
      await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://www.acme.com' });
      const res = await submitCorrection(correctionBody({ submitter_email: 'eng@acme.com' }));
      const { row } = await createdRow(res);
      expect(row?.domainMatch).toBe('match');
      const audits = await t.db.select().from(auditLog);
      expect((audits[0]!.metadata as Record<string, unknown>).domain_match).toBe('match');
    });

    it('flags a mismatch (gmail vs the vendor domain)', async () => {
      await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://www.acme.com' });
      const res = await submitCorrection(correctionBody({ submitter_email: 'someone@gmail.com' }));
      expect((await createdRow(res)).row?.domainMatch).toBe('no_match');
    });

    it('falls back to manual_review when the product has no primary vendor website', async () => {
      await seedProduct({ slug: 'acme-build' });
      const res = await submitCorrection(correctionBody({ submitter_email: 'eng@acme.com' }));
      expect((await createdRow(res)).row?.domainMatch).toBe('manual_review');
    });

    it("a vendor target uses the vendor's own website", async () => {
      await seedVendor({ slug: 'acme-co', website: 'https://acme.com' });
      const res = await claimApp().request(
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
      expect((await createdRow(res)).row?.domainMatch).toBe('match');
    });
  });

  describe('duplicate detection (§7.2)', () => {
    it('flags an existing open request of the same kind + target', async () => {
      await seedProduct({ slug: 'acme-build' });
      await seedRequest({ id: 'req_existing' });
      const res = await submitCorrection(correctionBody());
      const { row } = await createdRow(res);
      expect(row?.duplicateOfRequestId).toBe('req_existing');
      const audits = await t.db.select().from(auditLog);
      expect((audits[0]!.metadata as Record<string, unknown>).duplicate_of_request_id).toBe(
        'req_existing',
      );
    });

    it('flags on the same submitter even when the kind differs', async () => {
      await seedVendor({ slug: 'acme-co' });
      await seedRequest({
        id: 'req_dup',
        targetType: 'vendor',
        targetId: VENDOR_ID,
        kind: 'correction',
        submitterEmail: 'dana@acme.com',
      });
      const res = await claimApp().request(
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
      expect((await createdRow(res)).row?.duplicateOfRequestId).toBe('req_dup');
    });

    it('does not flag a resolved request or a different target', async () => {
      await seedProduct({ slug: 'acme-build' });
      await seedRequest({ id: 'req_resolved', status: 'resolved' });
      await seedRequest({ id: 'req_other_target', targetId: VENDOR_ID });
      const res = await submitCorrection(correctionBody());
      expect((await createdRow(res)).row?.duplicateOfRequestId).toBeNull();
    });

    it('points at the EARLIEST matching open request', async () => {
      await seedProduct({ slug: 'acme-build' });
      await seedRequest({ id: 'req_newer', createdAt: '2026-03-01T00:00:00.000Z' });
      await seedRequest({ id: 'req_older', createdAt: '2026-01-01T00:00:00.000Z' });
      const res = await submitCorrection(correctionBody());
      expect((await createdRow(res)).row?.duplicateOfRequestId).toBe('req_older');
    });
  });
});

// ─── Operator claim-intake alert via ctx.waitUntil ─────────────────────────────
describe('POST /api/requests/* → claim-intake operator alert (background)', () => {
  // `LINEAR_API_KEY` stays unset so the Linear task is a silent no-op and the ONLY
  // outbound fetch under test is the Resend send.
  const ENV_WITH_ALERT = {
    ...TEST_ENV,
    RESEND_API_KEY: 'rk_test',
    EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
    CLAIM_ALERT_EMAIL: 'support@aecintegrations.com',
  };
  const claimBody = {
    target_type: 'vendor',
    slug: 'acme-co',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_role: 'Head of Partnerships',
    body: 'I lead partnerships at Acme and would like to manage this listing going forward.',
  };
  const correctionBody = {
    target_type: 'product',
    slug: 'acme-build',
    body: 'The founding year on this listing is wrong; it should read 2009 not 2019.',
    source_url: '',
    submitter_email: 'reporter@example.com',
  };

  afterEach(() => vi.unstubAllGlobals());

  const drain = (execCtx: ExecutionContext) =>
    Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

  function resendOkFetch() {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"re_1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('emails CLAIM_ALERT_EMAIL after a claim commits', async () => {
    const fetchMock = resendOkFetch();
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();

    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(claimBody),
      ENV_WITH_ALERT,
      execCtx,
    );
    expect(res.status).toBe(201);
    await drain(execCtx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body)) as {
      to: string;
      subject: string;
      text: string;
    };
    expect(sent.to).toBe('support@aecintegrations.com');
    expect(sent.subject).toContain('New vendor claim');
    expect(sent.text).toContain('dana@acme.com');
  });

  it('does NOT alert on a correction — claims only', async () => {
    const fetchMock = resendOkFetch();
    await seedProduct({ slug: 'acme-build' });
    const execCtx = fakeExecutionContext();

    const res = await correctionApp().request(
      '/api/requests/correction',
      postInit(correctionBody),
      ENV_WITH_ALERT,
      execCtx,
    );
    expect(res.status).toBe(201);
    await drain(execCtx);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns 201 when the alert send fails — fail-open', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('forbidden', { status: 403 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();

    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(claimBody),
      ENV_WITH_ALERT,
      execCtx,
    );
    expect(res.status).toBe(201);
    await expect(drain(execCtx)).resolves.toBeDefined();

    // The claim row is committed regardless of the mail outcome.
    const { row } = await createdRow(res);
    expect(row).toMatchObject({ kind: 'claim', status: 'open' });
  });

  it('skips the send (no fetch) when CLAIM_ALERT_EMAIL is unset', async () => {
    const fetchMock = resendOkFetch();
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();

    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(claimBody),
      { ...ENV_WITH_ALERT, CLAIM_ALERT_EMAIL: undefined },
      execCtx,
    );
    expect(res.status).toBe(201);
    await drain(execCtx);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Phase 6.4 (AECI-211): Linear issue creation via ctx.waitUntil ──────────────
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

  /** Drain every backgrounded `waitUntil` promise (forwards + the Linear task). */
  const drain = (execCtx: ExecutionContext) =>
    Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

  function issueOkFetch() {
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
    await seedProduct({ slug: 'acme-build' });
    const execCtx = fakeExecutionContext();

    const res = await submitCorrection(validBody, ENV_WITH_LINEAR, execCtx);
    expect(res.status).toBe(201);
    const { request_id } = await createdRow(res);
    await drain(execCtx);

    expect(fetchMock).toHaveBeenCalledTimes(1); // issueCreate (no source_url → no attachment)
    const row = await t.db.query.vendorRequests.findFirst({
      where: eq(vendorRequests.id, request_id),
    });
    expect(row?.linearIssueId).toBe('iss_xyz');
    const wfs = await t.db.select().from(workflowInstances);
    expect(wfs[0]!.linearIssueId).toBe('iss_xyz');
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
    await seedProduct({ slug: 'acme-build' });
    const execCtx = fakeExecutionContext();

    const res = await submitCorrection(validBody, ENV_WITH_LINEAR, execCtx);
    expect(res.status).toBe(201); // failure never blocks the response
    const { request_id } = await createdRow(res);
    await drain(execCtx);

    const row = await t.db.query.vendorRequests.findFirst({
      where: eq(vendorRequests.id, request_id),
    });
    expect(row?.linearIssueId).toBeNull();
    const wfs = await t.db.select().from(workflowInstances);
    expect(wfs[0]!.linearIssueId).toBeNull();
  });

  it('adds the domain-check-pending label to the issue on a domain mismatch', async () => {
    const fetchMock = issueOkFetch();
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://www.acme.com' });
    const execCtx = fakeExecutionContext();

    const res = await submitCorrection(
      { ...validBody, submitter_email: 'someone@gmail.com' },
      ENV_WITH_LINEAR,
      execCtx,
    );
    expect(res.status).toBe(201);
    await drain(execCtx);

    const sent = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body)) as {
      variables: { input: { labelIds: string[] } };
    };
    expect(sent.variables.input.labelIds).toContain(LABEL_IDS.domainCheckPending);
  });
});
