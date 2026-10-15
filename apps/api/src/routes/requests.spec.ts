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
  agreementAcceptances,
  auditLog,
  productVendors,
  products,
  profiles,
  vendorRequests,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { LABEL_IDS } from '../lib/linear';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { stubPosthogIntake } from '../test/posthog-intake';
import {
  createClaimSubmitHandler,
  createClaimTargetHandler,
  createCorrectionSubmitHandler,
} from './requests';

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
    // AECI-1205: no correction email exists, so the message must not promise one.
    const { message } = (await res.clone().json()) as { message: string };
    expect(message).toBe(
      'Your correction has been received. We will review it and update the listing if it needs a change.',
    );
    expect(message).not.toMatch(/email/i);

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

  it('forwards the audit row and the genesis transition in ONE request (AECI-1112)', async () => {
    await seedProduct({ slug: 'acme-build' });
    const intake = stubPosthogIntake();
    try {
      const res = await submitCorrection(validBody, {
        ...TEST_ENV,
        POSTHOG_PROJECT_KEY: 'phc_test',
      });
      expect(res.status).toBe(201);
      const { request_id } = await createdRow(res);

      expect(intake.auditRequests()).toHaveLength(1);
      expect(intake.auditRequests()[0]!.messages).toEqual([
        `audit vendor_request.created ${request_id}`,
        expect.stringMatching(/^workflow ∅→open /),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
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
    accepted_terms: true,
    body: 'I lead partnerships at Acme and would like to manage this listing going forward.',
  };

  const submitClaim = (body: Record<string, unknown>) =>
    claimApp().request('/api/requests/claim', postInit(body), TEST_ENV, fakeExecutionContext());

  // ── AECI-847: the claimant-supplied LinkedIn profile ──────────────────────
  describe('submitter_linkedin_url (AECI-847)', () => {
    it('persists a supplied LinkedIn profile URL', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({
        ...validBody,
        submitter_linkedin_url: 'https://www.linkedin.com/in/dana-reyes',
      });
      expect(res.status).toBe(201);
      expect((await createdRow(res)).row?.submitterLinkedinUrl).toBe(
        'https://www.linkedin.com/in/dana-reyes',
      );
    });

    it('stores an empty string as NULL, not as an empty signal', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({ ...validBody, submitter_linkedin_url: '' });
      expect(res.status).toBe(201);
      expect((await createdRow(res)).row?.submitterLinkedinUrl).toBeNull();
    });

    // A pasted URL routinely carries surrounding whitespace, so trimming has to
    // happen before the blank check, not after it.
    it('treats a whitespace-only value as not supplied', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({ ...validBody, submitter_linkedin_url: '   ' });
      expect(res.status).toBe(201);
      expect((await createdRow(res)).row?.submitterLinkedinUrl).toBeNull();
    });

    it('trims a pasted URL rather than rejecting it', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({
        ...validBody,
        submitter_linkedin_url: '  https://www.linkedin.com/in/dana-reyes  ',
      });
      expect(res.status).toBe(201);
      expect((await createdRow(res)).row?.submitterLinkedinUrl).toBe(
        'https://www.linkedin.com/in/dana-reyes',
      );
    });

    // The field was added to an endpoint already in production, so a body that
    // predates it must still validate (the `.default('')` on the shared schema).
    it('accepts a body that omits the key entirely', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim(validBody);
      expect(res.status).toBe(201);
      expect((await createdRow(res)).row?.submitterLinkedinUrl).toBeNull();
    });

    it.each([
      ['a non-LinkedIn host', 'https://example.com/in/dana-reyes'],
      ['a lookalike host', 'https://linkedin.com.evil.example/in/dana'],
      ['plain http', 'http://www.linkedin.com/in/dana-reyes'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['not a URL at all', 'dana-reyes'],
    ])('rejects %s with 400 and writes nothing', async (_label, url) => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({ ...validBody, submitter_linkedin_url: url });
      expect(res.status).toBe(400);
      expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    });

    it('accepts a regional LinkedIn subdomain', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({
        ...validBody,
        submitter_linkedin_url: 'https://uk.linkedin.com/in/dana-reyes',
      });
      expect(res.status).toBe(201);
    });
  });

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

  // "Anything we should know?" is optional: claimants AECi sends to claim have
  // nothing to add, and the old 20-character floor was busy work.
  describe('optional body', () => {
    it('accepts a claim with no body key and stores the empty string', async () => {
      await seedVendor({ slug: 'acme-co' });
      const { body: _omit, ...noBody } = validBody;
      const res = await submitClaim(noBody);
      expect(res.status).toBe(201);
      expect((await createdRow(res)).row?.body).toBe('');
    });

    it('accepts a short body', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({ ...validBody, body: 'CEO.' });
      expect(res.status).toBe(201);
      expect((await createdRow(res)).row?.body).toBe('CEO.');
    });

    it('still rejects a body over 2000 characters', async () => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submitClaim({ ...validBody, body: 'x'.repeat(2001) });
      expect(res.status).toBe(400);
      expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    });
  });
});

// ─── AECI-1365: the retired plan question ─────────────────────────────────────
// An old client may still send the plan answer. The schema strips it, so the claim
// still lands (201) and nothing stores or records it.
describe('POST /api/requests/claim ignores a retired plan_interest key (AECI-1365)', () => {
  const body = {
    target_type: 'vendor',
    slug: 'acme-co',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_role: 'Head of Partnerships',
    accepted_terms: true,
  };
  const submit = (extra: Record<string, unknown>) =>
    claimApp().request(
      '/api/requests/claim',
      postInit({ ...body, ...extra }),
      TEST_ENV,
      fakeExecutionContext(),
    );

  it.each(['managed', '', 'enterprise'])(
    'returns 201 for plan_interest %j and stores and audits nothing for it',
    async (value) => {
      await seedVendor({ slug: 'acme-co' });
      const res = await submit({ plan_interest: value, body: 'We have four products.' });
      expect(res.status).toBe(201);
      const { row } = await createdRow(res);
      expect(row?.planInterest).toBeNull();
      expect(row?.body).toBe('We have four products.');
      const [audit] = await t.db.select().from(auditLog);
      expect(audit!.metadata).not.toHaveProperty('plan_interest');
    },
  );
});

// ─── AECI-1364: a claim is on the company ──────────────────────────────────────
describe('POST /api/requests/claim → product target normalised to the company (AECI-1364)', () => {
  const body = {
    target_type: 'product',
    slug: 'acme-build',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_role: 'Head of Partnerships',
    accepted_terms: true,
  };
  const submit = (
    extra: Record<string, unknown> = {},
    env = TEST_ENV,
    execCtx = fakeExecutionContext(),
  ) => claimApp().request('/api/requests/claim', postInit({ ...body, ...extra }), env, execCtx);

  async function vendorOf(slug: string) {
    const v = await t.db.query.vendors.findFirst({ where: eq(vendors.slug, slug) });
    return v!;
  }

  it('stores the vendor as the target and the product as context; the response is unchanged', async () => {
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
    const vendor = await vendorOf('v-acme-build');

    const res = await submit();
    expect(res.status).toBe(201);
    const json = (await res.clone().json()) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['message', 'request_id']);
    expect(json.message).toBe(
      'Your claim has been received. We will review it and follow up by email.',
    );

    const { request_id, row } = await createdRow(res);
    expect(row).toMatchObject({
      kind: 'claim',
      targetType: 'vendor',
      targetId: vendor.id,
      contextProductId: PRODUCT_ID,
      // The domain check still compares against the company's website.
      domainMatch: 'match',
    });

    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toMatchObject({ action: 'vendor_request.created', entityId: request_id });
    expect(audit!.metadata).toMatchObject({
      target_type: 'vendor',
      target_id: vendor.id,
      slug: 'v-acme-build',
      context_product_id: PRODUCT_ID,
      context_product_slug: 'acme-build',
    });
    const [transition] = await t.db.select().from(workflowTransitions);
    expect(transition!.metadata).toMatchObject({
      target_type: 'vendor',
      context_product_id: PRODUCT_ID,
    });
  });

  it('records no context product on a company-page claim', async () => {
    await seedVendor({ slug: 'acme-co' });
    const res = await submit({ target_type: 'vendor', slug: 'acme-co' });
    expect(res.status).toBe(201);
    const { row } = await createdRow(res);
    expect(row).toMatchObject({ targetType: 'vendor', targetId: VENDOR_ID });
    expect(row?.contextProductId).toBeNull();
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.metadata).toMatchObject({ context_product_id: null });
  });

  it('falls back to any product_vendors row when there is no primary', async () => {
    await seedProduct({ slug: 'acme-build' });
    await seedVendor({ slug: 'acme-co' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: false });

    const res = await submit();
    expect(res.status).toBe(201);
    const { row } = await createdRow(res);
    expect(row).toMatchObject({
      targetType: 'vendor',
      targetId: VENDOR_ID,
      contextProductId: PRODUCT_ID,
    });
  });

  it('prefers the primary vendor over another linked vendor', async () => {
    await seedProduct({ slug: 'acme-build', vendorWebsite: null });
    const primary = await vendorOf('v-acme-build');
    await seedVendor({ slug: 'reseller-co' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: false });

    const res = await submit();
    expect((await createdRow(res)).row?.targetId).toBe(primary.id);
  });

  it('404s when the product has no vendor row, and writes nothing', async () => {
    await seedProduct({ slug: 'acme-build' });
    const res = await submit();
    expect(res.status).toBe(404);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe('NOT_FOUND');
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('404s when the product does not exist', async () => {
    const res = await submit();
    expect(res.status).toBe(404);
  });

  it('dedupes a product-page claim against an open company-page claim on the same company', async () => {
    await seedProduct({ slug: 'acme-build' });
    await seedVendor({ slug: 'acme-co' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true });

    const first = await submit({ target_type: 'vendor', slug: 'acme-co' });
    const { request_id: firstId } = await createdRow(first);
    const second = await submit({ submitter_email: 'someone-else@acme.com' });
    expect((await createdRow(second)).row?.duplicateOfRequestId).toBe(firstId);
  });

  it('keeps a correction on its product target', async () => {
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
    const res = await submitCorrection({
      target_type: 'product',
      slug: 'acme-build',
      body: 'The founding year on this listing is wrong; it should read 2009.',
      source_url: '',
      submitter_email: 'reporter@example.com',
    });
    expect(res.status).toBe(201);
    const { row } = await createdRow(res);
    expect(row).toMatchObject({ targetType: 'product', targetId: PRODUCT_ID });
    expect(row?.contextProductId).toBeNull();
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.metadata).not.toHaveProperty('context_product_id');
  });

  it('names the company and the product page in the claim alert', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"re_1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
      const execCtx = fakeExecutionContext();
      const res = await submit(
        {},
        {
          ...TEST_ENV,
          RESEND_API_KEY: 'rk_test',
          EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
          SUPPORT_EMAIL: 'support@aecintegrations.com',
        },
        execCtx,
      );
      expect(res.status).toBe(201);
      await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
      const sent = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body)) as {
        subject: string;
        text: string;
      };
      expect(sent.subject).toContain('co-acme-build');
      expect(sent.text).toContain('Claimed: co-acme-build (vendor)');
      expect(sent.text).toContain('Came from: name-acme-build (product)');
    } finally {
      vi.unstubAllGlobals();
    }
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
          accepted_terms: true,
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
          accepted_terms: true,
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
    SUPPORT_EMAIL: 'support@aecintegrations.com',
  };
  const claimBody = {
    target_type: 'vendor',
    slug: 'acme-co',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_role: 'Head of Partnerships',
    accepted_terms: true,
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

  it('emails SUPPORT_EMAIL after a claim commits', async () => {
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

  it('has no plan row, even when an old client sends the key (AECI-1365)', async () => {
    const fetchMock = resendOkFetch();
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();
    await claimApp().request(
      '/api/requests/claim',
      postInit({ ...claimBody, plan_interest: 'not_sure' }),
      ENV_WITH_ALERT,
      execCtx,
    );
    await drain(execCtx);
    const sent = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body)) as {
      text: string;
    };
    expect(sent.text).not.toContain('Plan interest');
  });

  it('carries the Linear permalink and the admin deep link (AECI-861)', async () => {
    // The sequencing this issue exists for: the email is composed AFTER the issue
    // is created, so it can name it. Previously both ran as parallel `waitUntil`s
    // and the mail could only say "a claim landed".
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (href.includes('linear.app')) {
        return new Response(
          JSON.stringify({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: 'iss-1',
                  identifier: 'AECI-900',
                  url: 'https://linear.app/aec/issue/AECI-900/claim',
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response('{"id":"re_1"}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();

    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(claimBody),
      {
        ...ENV_WITH_ALERT,
        LINEAR_API_KEY: 'lin_test',
        PUBLIC_SITE_URL: 'https://demo.aecintegrations.com',
      },
      execCtx,
    );
    expect(res.status).toBe(201);
    await drain(execCtx);

    // Ordering is the assertion: Linear first, Resend second.
    const linearIdx = calls.findIndex((c) => c.url.includes('linear.app'));
    const resendIdx = calls.findIndex((c) => c.url.includes('resend'));
    expect(linearIdx).toBeGreaterThanOrEqual(0);
    expect(resendIdx).toBeGreaterThan(linearIdx);

    const mail = calls[resendIdx]!.body as { text: string };
    expect(mail.text).toContain('https://linear.app/aec/issue/AECI-900/claim');
    expect(mail.text).toContain('demo.aecintegrations.com');
    expect(mail.text).toContain('/admin/claims/');
  });

  it('still emails when the Linear create fails, and says the retry is pending', async () => {
    // Fail-open: a broken Linear must not cost the operator the notification. The
    // §6.7 sweep owns the retry, and the mail says so rather than omitting the row.
    const fetchMock = resendOkFetch();
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();

    // No LINEAR_API_KEY → `createLinearIssueForRequest` returns `no_api_key`. On
    // production that is an outage the sweep retries.
    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(claimBody),
      { ...ENV_WITH_ALERT, ENV: 'production' },
      execCtx,
    );
    expect(res.status).toBe(201);
    await drain(execCtx);

    const sent = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body)) as {
      text: string;
    };
    expect(sent.text).toContain('not created yet. The reconciliation sweep retries it');
  });

  it('says Linear is not configured, not "the sweep retries it", on a non-production tier without a key (AECI-1198)', async () => {
    const fetchMock = resendOkFetch();
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();

    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(claimBody),
      { ...ENV_WITH_ALERT, ENV: 'demo' },
      execCtx,
    );
    expect(res.status).toBe(201);
    await drain(execCtx);

    const sent = JSON.parse(String(vi.mocked(fetchMock).mock.calls[0]![1]!.body)) as {
      text: string;
      subject: string;
    };
    expect(sent.text).toContain('not created, Linear is not configured on this tier');
    expect(sent.text).not.toContain('sweep retries it');
    expect(sent.subject.startsWith('[demo] ')).toBe(true);
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

  it('skips the send (no fetch) when SUPPORT_EMAIL is unset', async () => {
    const fetchMock = resendOkFetch();
    await seedVendor({ slug: 'acme-co' });
    const execCtx = fakeExecutionContext();

    const res = await claimApp().request(
      '/api/requests/claim',
      postInit(claimBody),
      { ...ENV_WITH_ALERT, SUPPORT_EMAIL: undefined },
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

// ─── AECI-1368: claims routed to the company's owners ────────────────────────

describe('POST /api/requests/claim → routed to the owners (AECI-1368)', () => {
  const OWNER_ID = '55555555-5555-4555-8555-555555555555';
  const validBody = {
    target_type: 'vendor',
    slug: 'acme-co',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_role: 'Head of Partnerships',
    accepted_terms: true,
    body: 'I lead partnerships at Acme and would like to manage this listing going forward.',
  };
  const submit = (execCtx = fakeExecutionContext()) =>
    claimApp().request('/api/requests/claim', postInit(validBody), TEST_ENV, execCtx);

  it('sets routed_to_owners_at when the company has an unbanned owner seat, status stays open', async () => {
    await seedVendor({ slug: 'acme-co', website: 'https://acme.com' });
    await t.db
      .insert(profiles)
      .values({ id: OWNER_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });

    const res = await submit();
    expect(res.status).toBe(201);
    const { row } = await createdRow(res);
    expect(row?.status).toBe('open');
    expect(row?.routedToOwnersAt).toEqual(expect.any(String));
    expect(row?.ownerFallbackAt).toBeNull();
    const [audit] = await t.db.select().from(auditLog);
    expect((audit!.metadata as Record<string, unknown>).routed_to_owners).toBe(true);
  });

  it('does not route when the only owner seat is banned', async () => {
    await seedVendor({ slug: 'acme-co' });
    await t.db.insert(profiles).values({
      id: OWNER_ID,
      role: 'vendor_admin',
      vendorId: VENDOR_ID,
      seatOwner: true,
      bannedAt: '2026-10-01T00:00:00.000Z',
    });

    const { row } = await createdRow(await submit());
    expect(row?.routedToOwnersAt).toBeNull();
  });

  it('does not route when the company has only a member seat', async () => {
    await seedVendor({ slug: 'acme-co' });
    await t.db
      .insert(profiles)
      .values({ id: OWNER_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: false });

    const { row } = await createdRow(await submit());
    expect(row?.routedToOwnersAt).toBeNull();
  });

  it('does not route a claim on a company with no seats', async () => {
    await seedVendor({ slug: 'acme-co' });
    const { row } = await createdRow(await submit());
    expect(row?.routedToOwnersAt).toBeNull();
    const [audit] = await t.db.select().from(auditLog);
    expect((audit!.metadata as Record<string, unknown>).routed_to_owners).toBe(false);
  });
});

describe('GET /api/requests/claim-target/:type/:slug (AECI-1368)', () => {
  const OWNER_ID = '55555555-5555-4555-8555-555555555555';
  const targetApp = () =>
    buildAppWithHandler({
      method: 'get',
      path: '/api/requests/claim-target/:type/:slug',
      handler: createClaimTargetHandler(t.factory),
    });
  const get = (path: string) =>
    targetApp().request(path, { method: 'GET' }, TEST_ENV, fakeExecutionContext());

  it('returns the vendor and has_seats false for a company with no owner seat', async () => {
    await seedVendor({ slug: 'acme-co' });
    const res = await get('/api/requests/claim-target/vendor/acme-co');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(await res.json()).toEqual({ vendor_id: VENDOR_ID, has_seats: false });
  });

  it('returns has_seats true when the company has an unbanned owner seat', async () => {
    await seedVendor({ slug: 'acme-co' });
    await t.db
      .insert(profiles)
      .values({ id: OWNER_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    const res = await get('/api/requests/claim-target/vendor/acme-co');
    expect(await res.json()).toEqual({ vendor_id: VENDOR_ID, has_seats: true });
  });

  it('resolves a product to its company, the one the claim would be stored on', async () => {
    await seedVendor({ slug: 'acme-co' });
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'acme-build', name: 'Acme Build' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true });
    const res = await get('/api/requests/claim-target/product/acme-build');
    expect(await res.json()).toEqual({ vendor_id: VENDOR_ID, has_seats: false });
  });

  it.each([
    ['/api/requests/claim-target/vendor/nope'],
    ['/api/requests/claim-target/product/nope'],
    ['/api/requests/claim-target/integration/acme-co'],
  ])('404s like the claim route for %s', async (path) => {
    await seedVendor({ slug: 'acme-co' });
    const res = await get(path);
    expect(res.status).toBe(404);
  });

  it('404s a product with no company to claim', async () => {
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'orphan', name: 'Orphan' });
    const res = await get('/api/requests/claim-target/product/orphan');
    expect(res.status).toBe(404);
  });
});

// ─── AECI-1366: the vendor terms box, the acceptance and the receipt ──────────

describe('POST /api/requests/claim → vendor terms acceptance and receipt (AECI-1366)', () => {
  const OWNER_ID = '55555555-5555-4555-8555-555555555555';
  const body = {
    target_type: 'product',
    slug: 'acme-build',
    submitter_name: 'Dana Reyes',
    submitter_email: 'dana@acme.com',
    submitter_role: 'Head of Partnerships',
    accepted_terms: true,
  };
  /** Production, so the tier policy delivers the receipt to the outside address. */
  const PROD_ENV = {
    ...TEST_ENV,
    ENV: 'production' as const,
    RESEND_API_KEY: 'rk_test',
    EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
    SUPPORT_EMAIL: 'support@aecintegrations.com',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  };
  const submit = (
    extra: Record<string, unknown> = {},
    env = TEST_ENV,
    execCtx = fakeExecutionContext(),
    headers: Record<string, string> = {},
  ) =>
    claimApp().request(
      '/api/requests/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ ...body, ...extra }),
      },
      env,
      execCtx,
    );

  afterEach(() => vi.unstubAllGlobals());

  it('records the acceptance on the claim with the current version, IP and user agent', async () => {
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
    const res = await submit({}, TEST_ENV, fakeExecutionContext(), {
      'cf-connecting-ip': '198.51.100.7',
      'user-agent': 'Mozilla/5.0 (test)',
    });
    expect(res.status).toBe(201);
    const { request_id } = await createdRow(res);

    const rows = await t.db.select().from(agreementAcceptances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      document: 'vendor_terms',
      version: '1.0',
      source: 'claim',
      email: 'dana@acme.com',
      vendorRequestId: request_id,
      listingRequestId: null,
      profileId: null,
      vendorId: null,
      billingAccountId: null,
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0 (test)',
    });
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['vendor_request.created', 'agreement.accepted']),
    );
  });

  it('commits the claim, its workflow, both audit rows and the acceptance in ONE db.batch', async () => {
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
    const batch = vi.spyOn(t.db, 'batch');
    await submit();
    expect(batch).toHaveBeenCalledTimes(1);
    // claim, workflow instance, genesis transition, claim audit, acceptance, its audit
    expect(batch.mock.calls[0]![0]).toHaveLength(6);
  });

  it('writes neither the claim nor the acceptance when the batch fails', async () => {
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
    vi.spyOn(t.db, 'batch').mockRejectedValueOnce(new Error('D1 down'));
    const res = await submit();
    expect(res.status).toBe(500);
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['false', false],
    ['the string "true"', 'true'],
  ])('rejects accepted_terms %s with 400 VALIDATION_FAILED on the field', async (_l, value) => {
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
    const res = await submit({ accepted_terms: value });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; field?: string } };
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED', field: 'accepted_terms' });
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(0);
  });

  function resendFetch() {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"re_1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).includes('resend'))
        .map(
          ([, init]) =>
            JSON.parse(String(init!.body)) as { to: string; subject: string; text: string },
        );
  }

  it('sends the alert, then the claimant a receipt naming the company and the product', async () => {
    const sent = resendFetch();
    await seedProduct({ slug: 'acme-build', vendorWebsite: 'https://acme.com' });
    const execCtx = fakeExecutionContext();
    expect((await submit({}, PROD_ENV, execCtx)).status).toBe(201);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    const mails = sent();
    expect(mails.map((m) => String(m.to))).toEqual([
      'support@aecintegrations.com',
      'dana@acme.com',
    ]);
    const receipt = mails[1]!;
    expect(receipt.subject).toBe('We got your claim for co-acme-build');
    expect(receipt.text).toContain('name-acme-build');
    expect(receipt.text).toContain('A person at AEC Integrations reviews every claim.');
    expect(receipt.text).toContain('https://www.aecintegrations.com/legal/vendor-terms');
    // Nothing that grants anything: no sign-in, no portal, no token.
    expect(receipt.text).not.toContain('/auth/');
    expect(receipt.text).not.toMatch(/\/vendor(\?|\/|\s|$)/);
    // The unrouted alert has no owners line.
    expect(mails[0]!.text).not.toContain("'s owners");
  });

  it('routed claim: the receipt says their team confirms, the alert says when AECi steps in', async () => {
    const sent = resendFetch();
    await seedVendor({ slug: 'acme-co', website: 'https://acme.com' });
    await t.db
      .insert(profiles)
      .values({ id: OWNER_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    const execCtx = fakeExecutionContext();
    const res = await submit({ target_type: 'vendor', slug: 'acme-co' }, PROD_ENV, execCtx);
    expect(res.status).toBe(201);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    const mails = sent();
    const alert = mails.find((m) => String(m.to) === 'support@aecintegrations.com')!;
    const receipt = mails.find((m) => String(m.to) === 'dana@acme.com')!;
    expect(alert.text).toMatch(/Sent to co-acme-co's owners; AECi steps in on .+ UTC\./);
    expect(receipt.text).toContain(
      'co-acme-co already maintains this listing, so we have asked their team to confirm you.',
    );
    expect(receipt.text).toContain('We step in if they do not answer within 7 days.');
  });
});
