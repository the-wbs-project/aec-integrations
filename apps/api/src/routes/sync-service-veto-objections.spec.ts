/**
 * A Sync Service's objection to a removal, and AECi's end of a removal (AECI-2192,
 * ruling 66 on AECI-2035 after counsel's Q73 and Q74, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11e.2a and §11e.2b).
 *
 * Real migrations on in-memory SQLite. Covered: the three grounds and nothing else,
 * the link the "plainly false" ground needs, who may object (the owner and the Sync
 * Service's vendor; not the remover, not a stranger), one open objection per removal,
 * the AECi alert email (stubbed: tests send none), filing hides and tells nothing,
 * accept ends the removal with the ground and EVERY row on the pair key returns,
 * decline leaves it standing and tells the objecting vendor why, a withdraw or a lift
 * closes an open objection in the same batch, and the lift's required end reason.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/algolia-sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/algolia-sync')>();
  return { ...real, syncIndexTargets: vi.fn(async () => []) };
});
vi.mock('../lib/email', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/email')>();
  return {
    ...real,
    sendVetoObjectionSubmittedNotification: vi.fn(async () => ({ status: 'sent' })),
  };
});

import {
  auditLog,
  connectorEvidencedPairs,
  integrations,
  productVendors,
  products,
  profiles,
  syncServicePairVetoes,
  syncServiceVetoObjections,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { businessWindowEnd } from '../lib/business-days';
import { sendVetoObjectionSubmittedNotification } from '../lib/email';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminDecideVetoObjectionHandler,
  createAdminLiftVetoHandler,
  createAdminListVetoesHandler,
  objectionAnswerDue,
} from './admin-sync-service-vetoes';
import { createProductPairHandler } from './integrations';
import {
  createFileVetoHandler,
  createFileVetoObjectionHandler,
  createListVendorVetoesHandler,
  createWithdrawVetoHandler,
} from './vendor-sync-service-vetoes';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RIVETS = uuid(1); // sells the Sync Service, owns PAIR
const PROCORE = uuid(2); // endpoint A, the removing vendor
const ACUMATICA = uuid(3); // endpoint B
const NOBODY = uuid(5);
const RIVETS_PARTNER = uuid(6); // a second vendor of the Sync Service product

const P_PROCORE = uuid(10);
const P_ACUMATICA = uuid(11);
const S_SYNC = uuid(20);
const PAIR = uuid(30); // S_SYNC: Procore ↔ Acumatica, claimed by Rivets
const DUP = uuid(31); // integrations: Acumatica → Procore via S_SYNC, on PAIR's key

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_RIVETS = seat(1, RIVETS);
const AUTH_PROCORE = seat(2, PROCORE);
const AUTH_ACUMATICA = seat(3, ACUMATICA);
const AUTH_NOBODY = seat(5, NOBODY);
const AUTH_PARTNER = seat(6, RIVETS_PARTNER);
const AUTH_ADMIN: AuthzVariables['auth'] = {
  userId: uuid(199),
  email: 'admin@example.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;

beforeEach(async () => {
  vi.mocked(sendVetoObjectionSubmittedNotification).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: RIVETS, slug: 'rivets', companyName: 'Rivets' },
    { id: PROCORE, slug: 'procore-inc', companyName: 'Procore Inc' },
    { id: ACUMATICA, slug: 'acumatica-inc', companyName: 'Acumatica Inc' },
    { id: NOBODY, slug: 'nobody', companyName: 'Nobody' },
    { id: RIVETS_PARTNER, slug: 'rivets-partner', companyName: 'Rivets Partner' },
  ]);
  const promoted = { promotionStatus: 'promoted' } as const;
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', ...promoted },
    { id: P_ACUMATICA, slug: 'acumatica', name: 'Acumatica', ...promoted },
    {
      id: S_SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
      ...promoted,
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: PROCORE, isPrimary: true },
    { productId: P_ACUMATICA, vendorId: ACUMATICA, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS_PARTNER, isPrimary: false },
  ]);
  await t.db
    .insert(profiles)
    .values(
      [AUTH_RIVETS, AUTH_PROCORE, AUTH_ACUMATICA, AUTH_NOBODY, AUTH_PARTNER, AUTH_ADMIN].map(
        (auth) => ({ id: auth.userId, role: auth.role, vendorId: auth.vendorId }),
      ),
    );
  await t.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    name: 'Procore and Acumatica (Rivets Sync)',
    connectorProductId: S_SYNC,
    productAId: P_PROCORE,
    productBId: P_ACUMATICA,
    direction: 'a_to_b',
    builtByVendorId: RIVETS,
    claimedAt: '2026-10-01T00:00:00.000Z',
    origin: 'vendor',
    maintainedBy: 'vendor',
  });
  await t.db.insert(integrations).values({
    id: DUP,
    name: 'Acumatica to Procore (Rivets Sync)',
    sourceProductId: P_ACUMATICA,
    targetProductId: P_PROCORE,
    poweredByProductId: S_SYNC,
    mechanismKind: 'iPaaS',
    builtByVendorId: RIVETS,
  });
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/veto', createFileVetoHandler(t.factory));
  a.post('/api/vendor/vetoes/:id/withdraw', createWithdrawVetoHandler(t.factory));
  a.post('/api/vendor/vetoes/:id/objections', createFileVetoObjectionHandler(t.factory));
  a.get('/api/vendor/vetoes', createListVendorVetoesHandler(t.factory));
  a.get('/api/admin/vetoes', createAdminListVetoesHandler(t.factory));
  a.post('/api/admin/vetoes/:id/lift', createAdminLiftVetoHandler(t.factory));
  a.patch('/api/admin/veto-objections/:id', createAdminDecideVetoObjectionHandler(t.factory));
  a.get('/api/products/:slug/integrations/:otherSlug', createProductPairHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  method: 'GET' | 'POST' | 'PATCH' = 'POST',
  body?: unknown,
): Promise<{ status: number; body: JsonBody; text: string }> {
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send: vi.fn() } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit =
    body !== undefined
      ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : { method };
  const res = await app(auth).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as JsonBody, text };
}

const removal = async () => {
  const res = await call(AUTH_PROCORE, `/api/vendor/integrations/${PAIR}/veto`, 'POST', {
    reason_code: 'not_supported',
  });
  expect(res.status).toBe(201);
  return res.body.veto.id as string;
};
const object = (vetoId: string, body: unknown, auth = AUTH_RIVETS) =>
  call(auth, `/api/vendor/vetoes/${vetoId}/objections`, 'POST', body);
const FALSE_ON_ITS_FACE = {
  ground: 'reason_plainly_false',
  explanation: 'Procore lists this sync on its own marketplace page.',
  source_url: 'https://marketplace.procore.example/apps/rivets',
};
const pairPage = () => call(AUTH_NOBODY, '/api/products/procore/integrations/acumatica', 'GET');
const pairNotices = async () =>
  (await t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION))).filter(
    (r) => (r.metadata as { kind?: string } | null)?.kind === 'pair_right',
  );
const vetoRow = async (id: string) =>
  (await t.db.query.syncServicePairVetoes.findFirst({ where: eq(syncServicePairVetoes.id, id) }))!;

describe('the Sync Service objects to a removal (ruling 66)', () => {
  it('files one of the three grounds: 201, open, and the AECi alert goes out', async () => {
    const vetoId = await removal();
    const res = await object(vetoId, FALSE_ON_ITS_FACE);
    expect(res.status).toBe(201);
    expect(res.body.objection).toMatchObject({
      ground: 'reason_plainly_false',
      status: 'open',
      source_url: FALSE_ON_ITS_FACE.source_url,
      vendor_name: 'Rivets',
    });
    expect(sendVetoObjectionSubmittedNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendVetoObjectionSubmittedNotification).mock.calls[0]![1]).toMatchObject({
      removingVendorName: 'Procore Inc',
      removalReason: 'We do not support this integration',
      ground: 'The reason is plainly false on its face',
    });
    const [audit] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.veto_objection.filed'));
    expect(audit).toMatchObject({ entityType: 'sync_service_veto_objection', vendorId: RIVETS });
  });

  it('refuses any ground outside the three, and "plainly false" without an https link', async () => {
    const vetoId = await removal();
    for (const body of [
      { ground: 'we_disagree', explanation: 'We should be listed.' },
      { ground: 'reason_plainly_false', explanation: 'It is supported.' },
      { ...FALSE_ON_ITS_FACE, source_url: 'http://insecure.example' },
      { ground: 'wrong_product', explanation: '   ' },
    ]) {
      expect((await object(vetoId, body)).status).toBe(400);
    }
    expect(await t.db.select().from(syncServiceVetoObjections)).toHaveLength(0);
    expect(sendVetoObjectionSubmittedNotification).not.toHaveBeenCalled();
  });

  it('the other two grounds need no link', async () => {
    const vetoId = await removal();
    const res = await object(vetoId, {
      ground: 'wrong_product',
      explanation: 'Our sync connects Procore to Sage, not to Acumatica.',
    });
    expect(res.status).toBe(201);
    expect(res.body.objection.source_url).toBeNull();
  });

  it('only the owner or a vendor of the Sync Service may object; anyone else gets 404', async () => {
    const vetoId = await removal();
    for (const auth of [AUTH_PROCORE, AUTH_ACUMATICA, AUTH_NOBODY]) {
      expect((await object(vetoId, FALSE_ON_ITS_FACE, auth)).status).toBe(404);
    }
    expect((await object(vetoId, FALSE_ON_ITS_FACE, AUTH_PARTNER)).status).toBe(201);
    // The Sync Service's other vendor also sees the removal in its list.
    const list = await call(AUTH_PARTNER, '/api/vendor/vetoes', 'GET');
    expect(list.body.received).toHaveLength(1);
  });

  it('one open objection per removal: a second is 409 VETO_OBJECTION_DUPLICATE', async () => {
    const vetoId = await removal();
    expect((await object(vetoId, FALSE_ON_ITS_FACE)).status).toBe(201);
    const again = await object(vetoId, FALSE_ON_ITS_FACE, AUTH_PARTNER);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('VETO_OBJECTION_DUPLICATE');
  });

  it('filing changes nothing public and tells no vendor', async () => {
    const vetoId = await removal();
    const before = (await pairNotices()).length;
    await object(vetoId, FALSE_ON_ITS_FACE);
    expect((await pairNotices()).length).toBe(before);
    const page = await pairPage();
    expect(page.text).not.toContain(PAIR);
    expect((await vetoRow(vetoId)).endedAt).toBeNull();
  });

  it('an ended removal takes no objection: 409 VETO_NOT_IN_FORCE', async () => {
    const vetoId = await removal();
    await call(AUTH_PROCORE, `/api/vendor/vetoes/${vetoId}/withdraw`);
    const res = await object(vetoId, FALSE_ON_ITS_FACE);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VETO_NOT_IN_FORCE');
  });

  it('the owner reads the objection on its removed pair', async () => {
    const vetoId = await removal();
    await object(vetoId, FALSE_ON_ITS_FACE);
    const list = await call(AUTH_RIVETS, '/api/vendor/vetoes', 'GET');
    expect(list.body.received[0]).toMatchObject({
      reason_code: 'not_supported',
      objection: { status: 'open', ground: 'reason_plainly_false' },
    });
  });
});

describe('AECi decides an objection', () => {
  it('accept: the removal ends with the ground, every row on the key returns, both vendors are told why', async () => {
    const vetoId = await removal();
    const filed = await object(vetoId, FALSE_ON_ITS_FACE);
    expect((await pairPage()).text).not.toContain(DUP);
    const noNote = await call(
      AUTH_ADMIN,
      `/api/admin/veto-objections/${filed.body.objection.id}`,
      'PATCH',
      { decision: 'accept' },
    );
    expect(noNote.status).toBe(400);
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/veto-objections/${filed.body.objection.id}`,
      'PATCH',
      { decision: 'accept', note: 'Procore lists this sync on its own marketplace.' },
    );
    expect(res.status).toBe(200);
    expect(res.body.objection.status).toBe('accepted');
    expect(await vetoRow(vetoId)).toMatchObject({
      endedHow: 'lifted',
      endReason: 'reason_plainly_false',
      endNote: 'Procore lists this sync on its own marketplace.',
    });
    // Every row on the pair key is public again.
    const page = await pairPage();
    expect(page.text).toContain(PAIR);
    expect(page.text).toContain(DUP);
    const lifted = (await pairNotices()).filter(
      (n) => (n.metadata as { event?: string }).event === 'veto_lifted',
    );
    // The remover, the owner (who objected) and the other endpoint vendor.
    expect(lifted.map((n) => n.vendorId).sort()).toEqual([ACUMATICA, PROCORE, RIVETS].sort());
    for (const n of lifted) {
      expect(n.metadata).toMatchObject({
        endReason: 'reason_plainly_false',
        reason: 'Procore lists this sync on its own marketplace.',
      });
    }
    const again = await call(
      AUTH_ADMIN,
      `/api/admin/veto-objections/${filed.body.objection.id}`,
      'PATCH',
      { decision: 'decline', note: 'x' },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('VETO_OBJECTION_NOT_OPEN');
  });

  it('decline: the removal stands, and only the objecting vendor is told why', async () => {
    const vetoId = await removal();
    const filed = await object(vetoId, {
      ground: 'unauthorised_account',
      explanation: 'The person who sent it left Procore.',
    });
    const before = (await pairNotices()).length;
    const res = await call(
      AUTH_ADMIN,
      `/api/admin/veto-objections/${filed.body.objection.id}`,
      'PATCH',
      { decision: 'decline', note: 'The seat was active and held by Procore.' },
    );
    expect(res.status).toBe(200);
    expect(res.body.objection).toMatchObject({
      status: 'declined',
      decision_note: 'The seat was active and held by Procore.',
    });
    expect((await vetoRow(vetoId)).endedAt).toBeNull();
    expect((await pairPage()).text).not.toContain(PAIR);
    const sent = (await pairNotices()).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ vendorId: RIVETS });
    expect(sent[0]!.metadata).toMatchObject({
      event: 'objection_declined',
      reason: 'The seat was active and held by Procore.',
    });
    // A new objection may follow a decline.
    expect((await object(vetoId, FALSE_ON_ITS_FACE)).status).toBe(201);
  });

  it('a withdraw closes an open objection in the same batch', async () => {
    const vetoId = await removal();
    const filed = await object(vetoId, FALSE_ON_ITS_FACE);
    await call(AUTH_PROCORE, `/api/vendor/vetoes/${vetoId}/withdraw`);
    const row = await t.db.query.syncServiceVetoObjections.findFirst({
      where: eq(syncServiceVetoObjections.id, filed.body.objection.id),
    });
    expect(row?.status).toBe('closed');
    const decide = await call(
      AUTH_ADMIN,
      `/api/admin/veto-objections/${filed.body.objection.id}`,
      'PATCH',
      { decision: 'accept', note: 'Too late.' },
    );
    expect(decide.status).toBe(409);
  });
});

describe('AECi ends a removal on one of five grounds (ruling 66)', () => {
  it('the lift needs an end reason from the list, and a note', async () => {
    const vetoId = await removal();
    for (const body of [
      { note: 'Ended.' },
      { end_reason: 'we_decided', note: 'Ended.' },
      { end_reason: 'law_requires' },
    ]) {
      expect(
        (await call(AUTH_ADMIN, `/api/admin/vetoes/${vetoId}/lift`, 'POST', body)).status,
      ).toBe(400);
    }
    expect((await vetoRow(vetoId)).endedAt).toBeNull();
  });

  it('a claim ending: the removal ends, the ground is recorded and told, and an open objection closes', async () => {
    const vetoId = await removal();
    const filed = await object(vetoId, FALSE_ON_ITS_FACE);
    const res = await call(AUTH_ADMIN, `/api/admin/vetoes/${vetoId}/lift`, 'POST', {
      end_reason: 'claim_ended_or_suspended',
      note: 'Procore’s claim to this product ended on November 20.',
    });
    expect(res.status).toBe(200);
    expect(res.body.veto).toMatchObject({
      ended_how: 'lifted',
      end_reason: 'claim_ended_or_suspended',
      objection: { status: 'closed', id: filed.body.objection.id },
    });
    expect((await pairPage()).text).toContain(PAIR);
    const told = (await pairNotices()).filter(
      (n) => (n.metadata as { event?: string }).event === 'veto_lifted',
    );
    expect(told.map((n) => n.vendorId)).toEqual(expect.arrayContaining([PROCORE, RIVETS]));
    expect(told[0]!.metadata).toMatchObject({ endReason: 'claim_ended_or_suspended' });
  });

  it('the admin list carries the reason code and the open objection', async () => {
    const vetoId = await removal();
    await object(vetoId, FALSE_ON_ITS_FACE);
    const res = await call(AUTH_ADMIN, '/api/admin/vetoes', 'GET');
    expect(res.body.data[0]).toMatchObject({
      reason_code: 'not_supported',
      vendor_name: 'Procore Inc',
      objection: { status: 'open', explanation: FALSE_ON_ITS_FACE.explanation },
    });
    // Five business days from receipt, on the value-hide clocks' own helper.
    const created = res.body.data[0].objection.created_at as string;
    expect(res.body.data[0].objection_answer_due).toBe(businessWindowEnd(created, 5));
  });

  it('gives no answer due once the objection is decided', () => {
    const at = '2026-11-23T15:00:00.000Z';
    expect(objectionAnswerDue(null)).toBeNull();
    expect(objectionAnswerDue({ status: 'declined', created_at: at })).toBeNull();
    // Filed Monday 23 November 2026. The filing day does not count and Thanksgiving
    // (26th) is skipped, so day 5 is Tuesday 1 December. The window has passed at
    // 05:00 UTC on 2 December.
    expect(objectionAnswerDue({ status: 'open', created_at: at })).toBe('2026-12-02T05:00:00.000Z');
  });
});

describe('a stored reason code outside the list', () => {
  it('reads as unrecognised to the owner and the admin, never the stored text', async () => {
    const vetoId = await removal();
    await t.db
      .update(syncServicePairVetoes)
      .set({
        reasonCode: 'not_offered_for_product' as never,
        reason: 'It is not offered for our product',
      })
      .where(eq(syncServicePairVetoes.id, vetoId));
    const list = await call(AUTH_RIVETS, '/api/vendor/vetoes', 'GET');
    expect(list.status).toBe(200);
    expect(list.body.received[0]).toMatchObject({ reason_code: 'unrecognised' });
    const admin = await call(AUTH_ADMIN, '/api/admin/vetoes', 'GET');
    expect(admin.status).toBe(200);
    expect(admin.body.data[0]).toMatchObject({ reason_code: 'unrecognised' });
  });
});

describe('an older removal with free text', () => {
  it('reads as recorded, with no reason code', async () => {
    const vetoId = await removal();
    await t.db
      .update(syncServicePairVetoes)
      .set({ reasonCode: null, reason: 'Our own words, from before the fixed list.' })
      .where(eq(syncServicePairVetoes.id, vetoId));
    const list = await call(AUTH_RIVETS, '/api/vendor/vetoes', 'GET');
    expect(list.body.received[0]).toMatchObject({
      reason_code: null,
      reason: 'Our own words, from before the fixed list.',
    });
  });
});
