/**
 * AECI-1435 (ADR 0043): an anonymous claim or listing request waits in
 * `request_confirmations` until the typed address clicks the emailed link.
 *
 * Runs the real submit and confirm handlers against the in-memory D1 harness, with the
 * send ledger pointed at it (so the daily bound reads real rows) and a stubbed global
 * `fetch` standing in for Resend. The token is read out of the `claim-confirm` email,
 * the same way the visitor gets it.
 */

import { LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import {
  agreementAcceptances,
  auditLog,
  listingRequests,
  notificationSends,
  productVendors,
  products,
  profiles,
  requestConfirmations,
  vendorRequests,
  vendors,
  workflowInstances,
} from '../db/schema';
import type { Env } from '../env';
import { resolveClaimantIdentity } from '../lib/claimant-identity';
import { ledgerDb } from '../lib/notifications/send-ledger';
import {
  confirmationTokenHash,
  REQUEST_CONFIRMATION_EXPIRED_ACTION,
  runRequestConfirmationExpiry,
} from '../lib/request-confirmations';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, noSession } from '../test/helpers';
import { createListingRequestHandler } from './listing-requests';
import { createConfirmRequestHandler } from './request-confirmations';
import { createClaimSubmitHandler } from './requests';

vi.mock('../lib/notifications/send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/notifications/send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '55555555-5555-4555-8555-555555555555';
const CLAIMANT_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_VENDOR_ID = '77777777-7777-4777-8777-777777777777';

/** Production, so the tier policy delivers to outside addresses. `EMAIL_BCC` set, so
 *  a send that blind-copies the operator would show it. No Linear key. */
const ENV: Env = {
  ENV: 'production',
  RESEND_API_KEY: 'rk_test',
  EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
  SUPPORT_EMAIL: 'support@aecintegrations.com',
  EMAIL_BCC: 'copy@aecintegrations.com',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
};

const claimBody = {
  target_type: 'vendor',
  slug: 'acme-co',
  submitter_name: 'Dana Reyes',
  submitter_email: 'Dana@Acme.com',
  submitter_role: 'Head of Partnerships',
  accepted_terms: true,
};

const listingBody = {
  listing_name: 'Acme Field',
  website: 'https://acme.example.com',
  submitter_name: 'Dana Reyes',
  submitter_email: 'dana@acme.com',
  submitter_role: 'Head of Partnerships',
  accepted_terms: true,
};

const CONFIRM_LINK = /\/claims\/confirm\?token=([A-Za-z0-9_-]+)/;

let t: TestDb;
function spyFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));
}
let fetchSpy: ReturnType<typeof spyFetch>;

beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
  fetchSpy = spyFetch();
  await t.db.insert(vendors).values({
    id: VENDOR_ID,
    slug: 'acme-co',
    companyName: 'Acme',
    website: 'https://acme.com',
  });
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

interface ResendBody {
  to: string;
  bcc?: string[];
  subject: string;
  text: string;
}

/** Resend calls so far. */
function mails(): ResendBody[] {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes('api.resend.com'))
    .map(([, init]) => JSON.parse(String(init?.body)) as ResendBody);
}

const drain = (ctx: ExecutionContext) =>
  Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map((call) => call[0]));

type Resolver = typeof resolveClaimantIdentity;
/** The real resolver over a GoTrue lookup that finds nobody. */
const noAccount = vi.fn<Resolver>((db, env, input) =>
  resolveClaimantIdentity(db, env, input, async () => ({ ok: true, user: null })),
);

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

async function submitClaim(
  body: Record<string, unknown> = claimBody,
  opts: { session?: () => Promise<string | null>; headers?: Record<string, string> } = {},
) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/requests/claim',
    handler: createClaimSubmitHandler(t.factory, noAccount, opts.session ?? noSession),
  });
  const ctx = fakeExecutionContext();
  const res = await app.request('/api/requests/claim', post(body, opts.headers), ENV, ctx);
  await drain(ctx);
  return res;
}

async function submitListing(body: Record<string, unknown> = listingBody) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/requests/listing',
    handler: createListingRequestHandler(t.factory, noSession),
  });
  const ctx = fakeExecutionContext();
  const res = await app.request('/api/requests/listing', post(body), ENV, ctx);
  await drain(ctx);
  return res;
}

async function confirm(
  token: string,
  resolve: Resolver = noAccount,
  headers: Record<string, string> = {},
) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/requests/confirm',
    handler: createConfirmRequestHandler(t.factory, resolve),
  });
  const ctx = fakeExecutionContext();
  const res = await app.request('/api/requests/confirm', post({ token }, headers), ENV, ctx);
  await drain(ctx);
  return res;
}

/** The token in the latest `claim-confirm` mail. */
function tokenFromMail(): string {
  const mail = [...mails()].reverse().find((m) => m.subject.startsWith('Confirm your'));
  const match = (mail?.text ?? '').match(CONFIRM_LINK);
  if (!match) throw new Error('no confirm link in the mail');
  return match[1]!;
}

describe('POST /api/requests/claim, anonymous (the confirm path)', () => {
  it('writes only the pending row and its audit row, in one batch', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    const res = await submitClaim(claimBody, {
      headers: { 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'Mozilla/5.0 (submit)' },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      request_id: string;
      message: string;
      confirmation_required: boolean;
    };
    expect(json.confirmation_required).toBe(true);
    expect(json.message).toMatch(/not sent until you click the link/);

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);

    const [pending] = await t.db.select().from(requestConfirmations);
    expect(pending).toMatchObject({
      id: json.request_id,
      kind: 'claim',
      submitterEmail: 'dana@acme.com',
      termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0 (submit)',
      confirmedAt: null,
    });
    expect(JSON.parse(pending!.payload!)).toMatchObject({ slug: 'acme-co', target_type: 'vendor' });
    expect(Date.parse(pending!.expiresAt) - Date.parse(pending!.createdAt)).toBe(7 * 86_400_000);
    // The token is never stored, only its hash.
    expect(pending!.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // Nothing reached the queue, and no evidence of an acceptance yet.
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(0);
    // The AECI-1420 check runs at confirm, not here.
    expect(noAccount).not.toHaveBeenCalled();

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'request_confirmation.created',
      entityType: 'request_confirmation',
      entityId: json.request_id,
      vendorId: VENDOR_ID,
    });
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('acme.com');
  });

  it('sends only claim-confirm, to the typed address, with no operator copy', async () => {
    await submitClaim();
    const sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('Dana@Acme.com');
    expect(sent[0]!.bcc).toBeUndefined();
    expect(sent[0]!.subject).toBe('Confirm your claim for Acme');
    expect(sent[0]!.text).toContain('This link works for 7 days.');
    expect(sent[0]!.text).toContain('Nothing happens unless you click.');
    const token = tokenFromMail();
    const [pending] = await t.db.select().from(requestConfirmations);
    expect(pending!.tokenHash).toBe(await confirmationTokenHash(token));
  });

  it('takes the confirm path when the session email is a different address', async () => {
    const res = await submitClaim(claimBody, { session: async () => 'someone@else.com' });
    expect(((await res.json()) as { confirmation_required: boolean }).confirmation_required).toBe(
      true,
    );
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
  });

  it('a signed-in claimant with the typed address goes straight in, as before', async () => {
    const res = await submitClaim(claimBody, { session: async () => 'dana@acme.com' });
    const json = (await res.json()) as { request_id: string; confirmation_required: boolean };
    expect(json.confirmation_required).toBe(false);
    const rows = await t.db.select().from(vendorRequests);
    expect(rows.map((r) => r.id)).toEqual([json.request_id]);
    expect(await t.db.select().from(requestConfirmations)).toHaveLength(0);
    expect(mails().map((m) => m.subject)).not.toContain('Confirm your claim for Acme');
  });

  it('still answers 404 for a listing that does not exist, and writes nothing', async () => {
    const res = await submitClaim({ ...claimBody, slug: 'nope' });
    expect(res.status).toBe(404);
    expect(await t.db.select().from(requestConfirmations)).toHaveLength(0);
    expect(mails()).toHaveLength(0);
  });

  it('sends at most three confirm mails per address per UTC day', async () => {
    for (let i = 0; i < 4; i++) await submitClaim();
    expect(mails().filter((m) => m.subject.startsWith('Confirm your'))).toHaveLength(3);
    const ledger = await t.db
      .select()
      .from(notificationSends)
      .where(eq(notificationSends.notificationId, 'claim-confirm'));
    expect(ledger.map((r) => r.outcome).sort()).toEqual(['duplicate', 'sent', 'sent', 'sent']);
    // Every submit is still parked; only the mail is bounded.
    expect(await t.db.select().from(requestConfirmations)).toHaveLength(4);
  });
});

describe('POST /api/requests/confirm, a claim', () => {
  it('runs the full chain once: the claim under the pending id, the acceptance, the receipt', async () => {
    const submitted = (await (
      await submitClaim(claimBody, {
        headers: { 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'Mozilla/5.0 (submit)' },
      })
    ).json()) as { request_id: string };
    const token = tokenFromMail();
    fetchSpy.mockClear();

    const res = await confirm(token, noAccount, {
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'Mozilla/5.0 (click)',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'confirmed',
      kind: 'claim',
      request_id: submitted.request_id,
      routed: false,
      company_name: 'Acme',
    });

    const [claim] = await t.db.select().from(vendorRequests);
    expect(claim).toMatchObject({
      id: submitted.request_id,
      kind: 'claim',
      status: 'open',
      targetType: 'vendor',
      targetId: VENDOR_ID,
      submitterEmail: 'Dana@Acme.com',
    });
    expect(noAccount).toHaveBeenCalledTimes(1);

    // The acceptance carries the SUBMIT's evidence and version, at confirm time.
    const [acceptance] = await t.db.select().from(agreementAcceptances);
    expect(acceptance).toMatchObject({
      vendorRequestId: submitted.request_id,
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      ip: '198.51.100.7',
      userAgent: 'Mozilla/5.0 (submit)',
    });
    const [pending] = await t.db.select().from(requestConfirmations);
    expect(pending!.confirmedAt).toEqual(expect.any(String));
    expect(pending!.payload).toBeNull();
    expect(Date.parse(acceptance!.acceptedAt)).toBeGreaterThanOrEqual(
      Date.parse(pending!.createdAt),
    );

    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'request_confirmation.created',
        'request_confirmation.confirmed',
        'vendor_request.created',
        'agreement.accepted',
      ]),
    );
    const created = audits.find((a) => a.action === 'vendor_request.created')!;
    expect((created.metadata as Record<string, unknown>).confirmation).toBe('email');

    // Today's post-commit chain: the operator alert, then the claimant's receipt.
    expect(mails().map((m) => [m.to, m.subject])).toEqual([
      ['support@aecintegrations.com', expect.stringContaining('Acme')],
      ['Dana@Acme.com', 'We got your claim for Acme'],
    ]);
  });

  it('a second confirm writes nothing and sends nothing', async () => {
    await submitClaim();
    const token = tokenFromMail();
    expect((await confirm(token)).status).toBe(200);
    const auditCount = (await t.db.select().from(auditLog)).length;
    fetchSpy.mockClear();

    const again = await confirm(token);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('already_confirmed');
    expect(await t.db.select().from(vendorRequests)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(auditCount);
    expect(mails()).toHaveLength(0);
  });

  it('two confirms racing: one goes in, the other is already_confirmed', async () => {
    await submitClaim();
    const token = tokenFromMail();
    const results = await Promise.all([confirm(token), confirm(token)]);
    const statuses = await Promise.all(
      results.map(async (r) => ((await r.json()) as { status: string }).status),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(statuses.sort()).toEqual(['already_confirmed', 'confirmed']);
    expect(await t.db.select().from(vendorRequests)).toHaveLength(1);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(1);
  });

  it('the loser of a race whose batch trips the PK answers already_confirmed', async () => {
    await submitClaim();
    const token = tokenFromMail();
    // The winner commits between this confirm's read and its batch: stamp the row,
    // then fail the batch the way the request's primary key would.
    vi.spyOn(t.db, 'batch').mockImplementationOnce(async () => {
      await t.db
        .update(requestConfirmations)
        .set({ confirmedAt: new Date().toISOString(), payload: null });
      throw new Error('D1_ERROR: UNIQUE constraint failed: vendor_requests.id');
    });
    fetchSpy.mockClear();
    const res = await confirm(token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('already_confirmed');
    // Its own chain never ran: nothing was sent.
    expect(mails()).toHaveLength(0);
  });

  it('a batch failure with the row still unconfirmed is a 500, not a false success', async () => {
    await submitClaim();
    const token = tokenFromMail();
    vi.spyOn(t.db, 'batch').mockRejectedValueOnce(new Error('D1 down'));
    const res = await confirm(token);
    expect(res.status).toBe(500);
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
  });

  it('answers 422 expired past the 7 days and writes nothing', async () => {
    await submitClaim();
    const token = tokenFromMail();
    await t.db
      .update(requestConfirmations)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await confirm(token);
    expect(res.status).toBe(422);
    const { error } = (await res.json()) as {
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.details).toMatchObject({ reason: 'expired' });
    expect(await t.db.select().from(vendorRequests)).toHaveLength(0);
  });

  it('answers 404 for an unknown token, naming no token', async () => {
    const res = await confirm('not-a-real-token');
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(error.details).toMatchObject({ resource: 'request_confirmation' });
    expect(error.message).not.toContain('not-a-real-token');
  });

  it('answers 404 with the vendor resource when the claimed company is gone', async () => {
    await submitClaim();
    const token = tokenFromMail();
    await t.db.delete(vendors).where(eq(vendors.id, VENDOR_ID));
    const res = await confirm(token);
    expect(res.status).toBe(404);
    const { error } = (await res.json()) as { error: { details?: Record<string, unknown> } };
    expect(error.details).toMatchObject({ resource: 'vendor' });
    const [pending] = await t.db.select().from(requestConfirmations);
    expect(pending!.confirmedAt).toBeNull();
  });

  it('runs the AECI-1420 check at confirm: a seat elsewhere stores it rejected and sends claim-rejected', async () => {
    await t.db
      .insert(vendors)
      .values({ id: OTHER_VENDOR_ID, slug: 'globex', companyName: 'Globex' });
    await t.db.insert(profiles).values({
      id: CLAIMANT_ID,
      role: 'vendor_admin',
      vendorId: OTHER_VENDOR_ID,
      seatOwner: true,
    });
    const seated = vi.fn<Resolver>((db, env, input) =>
      resolveClaimantIdentity(db, env, input, async () => ({
        ok: true,
        user: { id: CLAIMANT_ID, email: 'dana@acme.com' },
      })),
    );
    await submitClaim();
    const token = tokenFromMail();
    fetchSpy.mockClear();

    const res = await confirm(token, seated);
    expect(res.status).toBe(200);
    expect(seated).toHaveBeenCalledTimes(1);
    const [claim] = await t.db.select().from(vendorRequests);
    expect(claim?.status).toBe('rejected');
    // Ruled 2026-10-21: the page says why, naming the company the address manages.
    expect(await res.json()).toEqual({
      status: 'rejected',
      kind: 'claim',
      request_id: claim!.id,
      routed: false,
      company_name: 'Acme',
      reason: 'other_vendor',
      vendor_name: 'Globex',
    });
    const toClaimant = mails().filter((m) => m.to === 'Dana@Acme.com');
    expect(toClaimant).toHaveLength(1);
    expect(toClaimant[0]!.subject).not.toBe('We got your claim for Acme');
  });

  it('answers rejected with already_admin and no company for a staff address', async () => {
    await t.db.insert(profiles).values({ id: CLAIMANT_ID, role: 'admin' });
    const staff = vi.fn<Resolver>((db, env, input) =>
      resolveClaimantIdentity(db, env, input, async () => ({
        ok: true,
        user: { id: CLAIMANT_ID, email: 'dana@acme.com' },
      })),
    );
    await submitClaim();
    const res = await confirm(tokenFromMail(), staff);
    expect(res.status).toBe(200);
    const [claim] = await t.db.select().from(vendorRequests);
    expect(claim?.status).toBe('rejected');
    expect(await res.json()).toMatchObject({
      status: 'rejected',
      reason: 'already_admin',
      vendor_name: null,
      routed: false,
    });
  });

  it('a check that could not run is not a rejection: the claim answers confirmed', async () => {
    const down = vi.fn<Resolver>(async () => ({ outcome: 'unavailable' }));
    await submitClaim();
    const res = await confirm(tokenFromMail(), down);
    expect(res.status).toBe(200);
    expect(down).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'confirmed', kind: 'claim', routed: false });
    expect(body).not.toHaveProperty('reason');
    expect(body).not.toHaveProperty('vendor_name');
    const [claim] = await t.db.select().from(vendorRequests);
    expect(claim?.status).toBe('open');
  });

  it('routes to the owners at confirm, so their 7 days start then', async () => {
    await t.db
      .insert(profiles)
      .values({ id: OWNER_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    await submitClaim();
    const token = tokenFromMail();
    const [pending] = await t.db.select().from(requestConfirmations);

    const res = await confirm(token);
    expect(((await res.json()) as { routed: boolean }).routed).toBe(true);
    const [claim] = await t.db.select().from(vendorRequests);
    expect(claim!.routedToOwnersAt).toEqual(expect.any(String));
    expect(Date.parse(claim!.routedToOwnersAt!)).toBeGreaterThanOrEqual(
      Date.parse(pending!.createdAt),
    );
  });

  it('confirms a claim sent from a product page against the product company', async () => {
    await t.db.insert(products).values({ id: PRODUCT_ID, slug: 'acme-field', name: 'Acme Field' });
    await t.db
      .insert(productVendors)
      .values({ productId: PRODUCT_ID, vendorId: VENDOR_ID, isPrimary: true });
    await submitClaim({ ...claimBody, target_type: 'product', slug: 'acme-field' });
    expect(mails()[0]!.text).toContain('from the Acme Field page');
    await confirm(tokenFromMail());
    const [claim] = await t.db.select().from(vendorRequests);
    expect(claim).toMatchObject({ targetId: VENDOR_ID, contextProductId: PRODUCT_ID });
  });
});

describe('the listing path', () => {
  it('parks a typed-in listing, and the confirm writes it under the pending id', async () => {
    const res = await submitListing();
    const json = (await res.json()) as { request_id: string; confirmation_required: boolean };
    expect(json.confirmation_required).toBe(true);
    expect(await t.db.select().from(listingRequests)).toHaveLength(0);
    expect(mails().map((m) => m.subject)).toEqual(['Confirm your listing request']);

    const confirmed = await confirm(tokenFromMail());
    expect(await confirmed.json()).toEqual({
      status: 'confirmed',
      kind: 'listing',
      request_id: json.request_id,
      routed: false,
      company_name: 'Acme Field',
    });
    const [row] = await t.db.select().from(listingRequests);
    expect(row!.id).toBe(json.request_id);
    const [acceptance] = await t.db.select().from(agreementAcceptances);
    expect(acceptance!.listingRequestId).toBe(json.request_id);
  });
});

describe('runRequestConfirmationExpiry', () => {
  it('deletes rows past expires_at with one summary audit row, and keeps live ones', async () => {
    await submitClaim();
    await submitClaim();
    await submitListing();
    const rows = await t.db.select().from(requestConfirmations);
    // Two expired (one of them confirmed), one live.
    await t.db
      .update(requestConfirmations)
      .set({ expiresAt: '2026-01-01T00:00:00.000Z', confirmedAt: '2025-12-30T00:00:00.000Z' })
      .where(eq(requestConfirmations.id, rows[0]!.id));
    await t.db
      .update(requestConfirmations)
      .set({ expiresAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(requestConfirmations.id, rows[1]!.id));
    const before = (await t.db.select().from(auditLog)).length;
    const batch = vi.spyOn(t.db, 'batch');

    const result = await runRequestConfirmationExpiry(t.db);
    expect(result).toMatchObject({ deleted: 2, unconfirmed: 1, capped: 0 });
    expect(batch).toHaveBeenCalledTimes(1);
    expect((await t.db.select().from(requestConfirmations)).map((r) => r.id)).toEqual([
      rows[2]!.id,
    ]);
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(before + 1);
    const summary = audits.find((a) => a.action === REQUEST_CONFIRMATION_EXPIRED_ACTION)!;
    expect(summary).toMatchObject({ actorType: 'system', actorId: null });
    expect(summary.metadata).toMatchObject({ rowsDeleted: 2, unconfirmed: 1 });
  });

  it('writes nothing when nothing has expired', async () => {
    await submitClaim();
    const batch = vi.spyOn(t.db, 'batch');
    expect(await runRequestConfirmationExpiry(t.db)).toMatchObject({ deleted: 0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it('treats the expiry instant itself as expired', async () => {
    await submitClaim();
    const [row] = await t.db.select().from(requestConfirmations);
    const at = new Date(row!.expiresAt);
    expect(await runRequestConfirmationExpiry(t.db, { now: at })).toMatchObject({ deleted: 1 });
  });
});
