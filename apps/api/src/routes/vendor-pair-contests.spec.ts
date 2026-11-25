/**
 * Existence and data flow reports on a Sync Service pair (AECI-2042, rulings 9 and 10
 * on AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.3 and §11e.4).
 *
 * Covered: routing for each report, who may file, the pair staying public while an
 * existence report is open, an AECi accept retiring a vendor-held pair (and writing
 * nothing on an AECi-held one), an owner accept writing the owner's answer in the same
 * batch, a decline, a withdraw, and a protest that stays advice only.
 */

import { PairContestResponseSchema } from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/algolia-sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/algolia-sync')>();
  return { ...real, syncIndexTargets: vi.fn(async () => []) };
});

import {
  auditLog,
  claimOwnerAnswers,
  claims,
  connectorEvidencedPairs,
  productVendors,
  products,
  profiles,
  syncServicePairContests,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createAdminDecidePairContestHandler,
  createAdminDecidePairProtestHandler,
  createAdminListPairContestsHandler,
} from './admin-pair-contests';
import { createProductPairHandler } from './integrations';
import {
  createDecidePairContestHandler,
  createFilePairProtestHandler,
  createListVendorPairContestsHandler,
  createSubmitPairContestHandler,
  createWithdrawPairContestHandler,
} from './vendor-pair-contests';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RIVETS = uuid(1);
const PROCORE = uuid(2);
const ACUMATICA = uuid(3);
const NOBODY = uuid(5);
const P_PROCORE = uuid(10);
const P_ACUMATICA = uuid(11);
const P_INEIGHT = uuid(12);
const S_SYNC = uuid(20);
const S_PLATFORM = uuid(21);
const PAIR = uuid(30); // claimed by Rivets: the owner decides its flows
const PAIR_SEEDED = uuid(31); // AECi-held: AECi decides
const PAIR_PLATFORM = uuid(32);
const DO_RFIS = uuid(40);
const CLAIM = uuid(50); // on PAIR, a_to_b
const CLAIM_SEEDED = uuid(51); // on PAIR_SEEDED

const seat = (
  n: number,
  vendorId: string | null,
  role = 'vendor_admin',
): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: role as AuthzVariables['auth']['role'],
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_RIVETS = seat(1, RIVETS);
const AUTH_PROCORE = seat(2, PROCORE);
const AUTH_ACUMATICA = seat(3, ACUMATICA);
const AUTH_NOBODY = seat(5, NOBODY);
const AUTH_ADMIN = seat(9, null, 'admin');

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: RIVETS, slug: 'rivets', companyName: 'Rivets' },
    { id: PROCORE, slug: 'procore-inc', companyName: 'Procore Inc' },
    { id: ACUMATICA, slug: 'acumatica-inc', companyName: 'Acumatica Inc' },
    { id: NOBODY, slug: 'nobody', companyName: 'Nobody' },
  ]);
  const promoted = { promotionStatus: 'promoted' } as const;
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', ...promoted },
    { id: P_ACUMATICA, slug: 'acumatica', name: 'Acumatica', ...promoted },
    { id: P_INEIGHT, slug: 'ineight', name: 'InEight', ...promoted },
    {
      id: S_SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
      ...promoted,
    },
    {
      id: S_PLATFORM,
      slug: 'zap-flow',
      name: 'Zap Flow',
      productRole: 'connector',
      connectorKind: 'integration_platform',
      ...promoted,
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: PROCORE, isPrimary: true },
    { productId: P_ACUMATICA, vendorId: ACUMATICA, isPrimary: true },
    { productId: P_INEIGHT, vendorId: ACUMATICA, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS, isPrimary: true },
  ]);
  await t.db.insert(profiles).values(
    [AUTH_RIVETS, AUTH_PROCORE, AUTH_ACUMATICA, AUTH_NOBODY, AUTH_ADMIN].map((auth) => ({
      id: auth.userId,
      role: auth.role,
      vendorId: auth.vendorId,
    })),
  );
  await t.db.insert(connectorEvidencedPairs).values([
    {
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
    },
    {
      id: PAIR_SEEDED,
      name: 'Procore and InEight (Rivets Sync)',
      connectorProductId: S_SYNC,
      productAId: P_PROCORE,
      productBId: P_INEIGHT,
      direction: 'both',
    },
    {
      id: PAIR_PLATFORM,
      name: 'Platform pair',
      connectorProductId: S_PLATFORM,
      productAId: P_PROCORE,
      productBId: P_ACUMATICA,
      direction: 'both',
    },
  ]);
  await t.db.insert(taxonomyDataObjects).values({
    id: DO_RFIS,
    slug: 'rfis',
    name: 'RFIs',
    displayOrder: 1,
  });
  await t.db.insert(claims).values([
    { id: CLAIM, connectorEvidencedPairId: PAIR, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    {
      id: CLAIM_SEEDED,
      connectorEvidencedPairId: PAIR_SEEDED,
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    },
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/integrations/:id/pair-contests', createSubmitPairContestHandler(t.factory));
  a.get('/api/vendor/pair-contests', createListVendorPairContestsHandler(t.factory));
  a.post('/api/vendor/pair-contests/:id/withdraw', createWithdrawPairContestHandler(t.factory));
  a.post('/api/vendor/pair-contests/:id/decision', createDecidePairContestHandler(t.factory));
  a.post('/api/vendor/pair-contests/:id/protest', createFilePairProtestHandler(t.factory));
  a.get('/api/admin/pair-contests', createAdminListPairContestsHandler(t.factory));
  a.patch('/api/admin/pair-contests/:id', createAdminDecidePairContestHandler(t.factory));
  a.patch('/api/admin/pair-contests/:id/protest', createAdminDecidePairProtestHandler(t.factory));
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
): Promise<{ status: number; body: JsonBody }> {
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
  return { status: res.status, body: (await res.json()) as JsonBody };
}

const submit = (id: string, body: unknown, auth = AUTH_ACUMATICA) =>
  call(auth, `/api/vendor/integrations/${id}/pair-contests`, 'POST', body);
const existence = (id = PAIR, auth = AUTH_ACUMATICA) =>
  submit(id, { kind: 'existence', reason: 'Rivets stopped offering this in 2026.' }, auth);
const flow = (proposed: string | null = null, id = PAIR, claimId = CLAIM) =>
  submit(id, {
    kind: 'data_flow',
    claim_id: claimId,
    reason: 'We do not send RFIs to this product.',
    ...(proposed ? { proposed_direction: proposed } : {}),
  });
const liveAnswer = async (claimId: string) =>
  t.db.query.claimOwnerAnswers.findFirst({
    where: and(eq(claimOwnerAnswers.claimId, claimId), isNull(claimOwnerAnswers.retractedAt)),
  });
const pairRow = async (id: string) =>
  (await t.db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  }))!;

describe('who may file a report', () => {
  it('an endpoint vendor files; the owner, a stranger and a platform pair are refused', async () => {
    expect((await existence()).status).toBe(201);
    expect((await existence(PAIR, AUTH_NOBODY)).status).toBe(404);
    expect((await existence(PAIR_PLATFORM)).body.error.code).toBe(
      'SYNC_SERVICE_RIGHT_NOT_AVAILABLE',
    );
    await t.db.insert(productVendors).values({ productId: P_ACUMATICA, vendorId: RIVETS });
    expect((await existence(PAIR, AUTH_RIVETS)).body.error.code).toBe(
      'SYNC_SERVICE_RIGHT_OWN_INTEGRATION',
    );
  });

  it('a second open report of the same kind is 409 PAIR_CONTEST_DUPLICATE', async () => {
    await existence();
    const again = await existence();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAIR_CONTEST_DUPLICATE');
  });

  it('a data flow report must name a flow on this pair', async () => {
    const res = await flow(null, PAIR, CLAIM_SEEDED);
    expect(res.status).toBe(400);
  });
});

describe('existence: AECi decides, filing hides nothing (ruling 9)', () => {
  it('routes to AECi, and the pair stays on the pair page while it is open', async () => {
    const res = await existence();
    const { contest } = PairContestResponseSchema.parse(res.body);
    expect(contest.routed_to).toBe('aeci');
    const page = await call(AUTH_NOBODY, '/api/products/procore/integrations/acumatica', 'GET');
    expect(JSON.stringify(page.body)).toContain(PAIR);
    const queue = await call(AUTH_ADMIN, '/api/admin/pair-contests', 'GET');
    expect(queue.body.data.map((r: JsonBody) => r.id)).toEqual([contest.id]);
  });

  it('an accept needs a note and a proof link, then retires a vendor-held pair', async () => {
    const id = (await existence()).body.contest.id as string;
    const bare = await call(AUTH_ADMIN, `/api/admin/pair-contests/${id}`, 'PATCH', {
      decision: 'accept',
      note: 'Rivets confirmed.',
    });
    expect(bare.status).toBe(400);
    expect(bare.body.error.field).toBe('sourceUrl');
    const res = await call(AUTH_ADMIN, `/api/admin/pair-contests/${id}`, 'PATCH', {
      decision: 'accept',
      note: 'Rivets confirmed it is no longer offered.',
      source_url: 'https://rivets.example/changelog',
    });
    expect(res.status).toBe(200);
    expect(res.body.contest).toMatchObject({ status: 'accepted', accept_mode: 'retired' });
    const row = await pairRow(PAIR);
    expect(row.retiredAt).not.toBeNull();
    expect(row.retiredBy).toBe('aeci');
    const retired = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'integration.retired'));
    expect(retired).toHaveLength(1);
  });

  it('on an AECi-held pair the accept writes no catalog data (upstream-only)', async () => {
    const id = (await existence(PAIR_SEEDED)).body.contest.id as string;
    const before = await pairRow(PAIR_SEEDED);
    const res = await call(AUTH_ADMIN, `/api/admin/pair-contests/${id}`, 'PATCH', {
      decision: 'accept',
      note: 'Confirmed. Retract upstream.',
      source_url: 'https://rivets.example/changelog',
    });
    expect(res.body.contest.accept_mode).toBe('upstream-only');
    expect(await pairRow(PAIR_SEEDED)).toEqual(before);
  });

  it('a decline closes it and changes nothing', async () => {
    const id = (await existence()).body.contest.id as string;
    const res = await call(AUTH_ADMIN, `/api/admin/pair-contests/${id}`, 'PATCH', {
      decision: 'decline',
    });
    expect(res.body.contest.status).toBe('declined');
    expect((await pairRow(PAIR)).retiredAt).toBeNull();
  });

  it('the submitter withdraws an open report', async () => {
    const id = (await existence()).body.contest.id as string;
    const res = await call(AUTH_ACUMATICA, `/api/vendor/pair-contests/${id}/withdraw`);
    expect(res.body.contest.status).toBe('withdrawn');
    expect((await call(AUTH_PROCORE, `/api/vendor/pair-contests/${id}/withdraw`)).status).toBe(404);
  });
});

describe('data flow: the owner decides on a claimed pair (ruling 10)', () => {
  it('routes to the owner, lands in its Received list, and the owner is told', async () => {
    const res = await flow();
    expect(res.body.contest.routed_to).toBe('owner');
    const owner = await call(AUTH_RIVETS, '/api/vendor/pair-contests', 'GET');
    expect(owner.body.received.map((r: JsonBody) => r.id)).toEqual([res.body.contest.id]);
    const notices = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === 'notification.sent' && r.vendorId === RIVETS,
    );
    expect(notices).toHaveLength(1);
  });

  it('an owner accept with no proposal removes the flow: the owner answers No in the same batch', async () => {
    const id = (await flow()).body.contest.id as string;
    const res = await call(AUTH_RIVETS, `/api/vendor/pair-contests/${id}/decision`, 'POST', {
      decision: 'accept',
    });
    expect(res.status).toBe(200);
    expect(res.body.contest).toMatchObject({ status: 'accepted', accept_mode: 'flow-removed' });
    expect((await liveAnswer(CLAIM))?.asserted).toBe(false);
  });

  it('an owner accept with a proposed direction moves the flow', async () => {
    const id = (await flow('both')).body.contest.id as string;
    await call(AUTH_RIVETS, `/api/vendor/pair-contests/${id}/decision`, 'POST', {
      decision: 'accept',
    });
    expect((await liveAnswer(CLAIM))?.asserted).toBe(false);
    const moved = await t.db.query.claims.findFirst({
      where: and(eq(claims.connectorEvidencedPairId, PAIR), eq(claims.direction, 'both')),
    });
    expect(moved).toBeTruthy();
    expect((await liveAnswer(moved!.id))?.asserted).toBe(true);
  });

  it('a decline writes no answer; only the owner may decide; AECi may not', async () => {
    const id = (await flow()).body.contest.id as string;
    expect(
      (
        await call(AUTH_PROCORE, `/api/vendor/pair-contests/${id}/decision`, 'POST', {
          decision: 'accept',
        })
      ).status,
    ).toBe(404);
    const admin = await call(AUTH_ADMIN, `/api/admin/pair-contests/${id}`, 'PATCH', {
      decision: 'accept',
      note: 'x',
    });
    expect(admin.body.error.code).toBe('CONTEST_ROUTED_TO_OWNER');
    const res = await call(AUTH_RIVETS, `/api/vendor/pair-contests/${id}/decision`, 'POST', {
      decision: 'decline',
      note: 'We do send RFIs.',
    });
    expect(res.body.contest.status).toBe('declined');
    expect(await liveAnswer(CLAIM)).toBeUndefined();
  });

  it('on an unclaimed pair it routes to AECi, whose accept writes nothing here', async () => {
    const res = await flow(null, PAIR_SEEDED, CLAIM_SEEDED);
    expect(res.body.contest.routed_to).toBe('aeci');
    const decided = await call(
      AUTH_ADMIN,
      `/api/admin/pair-contests/${res.body.contest.id}`,
      'PATCH',
      {
        decision: 'accept',
        note: 'Fix upstream.',
      },
    );
    expect(decided.body.contest.accept_mode).toBe('upstream-only');
    expect(await liveAnswer(CLAIM_SEEDED)).toBeUndefined();
  });
});

describe('a protest after a decline stays advice only (§11b.12)', () => {
  it('files within the window, and an upheld protest writes nothing to the listing', async () => {
    const id = (await flow()).body.contest.id as string;
    const early = await call(AUTH_ACUMATICA, `/api/vendor/pair-contests/${id}/protest`, 'POST', {
      reason: 'Please look again.',
    });
    expect(early.body.error.code).toBe('PAIR_PROTEST_NOT_ALLOWED');
    await call(AUTH_RIVETS, `/api/vendor/pair-contests/${id}/decision`, 'POST', {
      decision: 'decline',
    });
    const protest = await call(AUTH_ACUMATICA, `/api/vendor/pair-contests/${id}/protest`, 'POST', {
      reason: 'Our docs show no RFI sync.',
    });
    expect(protest.status).toBe(200);
    expect(protest.body.contest.protest).toMatchObject({ status: 'open', basis: 'declined' });
    const before = await t.db.select().from(claimOwnerAnswers);
    const upheld = await call(AUTH_ADMIN, `/api/admin/pair-contests/${id}/protest`, 'PATCH', {
      decision: 'upheld',
      note: 'We agree with Acumatica.',
    });
    expect(upheld.body.contest.protest.status).toBe('upheld');
    expect(await t.db.select().from(claimOwnerAnswers)).toEqual(before);
    expect((await pairRow(PAIR)).retiredAt).toBeNull();
  });

  it('a silence protest needs 30 days and records the decline at day 30', async () => {
    const id = (await flow()).body.contest.id as string;
    const filed = new Date(Date.now() - 31 * 86_400_000).toISOString();
    await t.db
      .update(syncServicePairContests)
      .set({ createdAt: filed })
      .where(eq(syncServicePairContests.id, id));
    const res = await call(AUTH_ACUMATICA, `/api/vendor/pair-contests/${id}/protest`, 'POST', {
      reason: 'No answer.',
    });
    expect(res.body.contest).toMatchObject({ status: 'declined' });
    expect(res.body.contest.protest.basis).toBe('silence');
  });
});

// ─── The gate holds at commit (AECI-2042 review blocker 2) ───────────────────
//
// `resolvePairRightTarget` and the routing read run before the batch. A change landing
// between them and the commit must abort the report, not file it on stale facts.

/** Run `statement` once, just before the next `db.batch` commits. */
function raceBeforeBatch(statement: string, ...params: unknown[]): void {
  type BatchFn = (s: unknown[]) => Promise<unknown[]>;
  const holder = t.db as unknown as { batch: BatchFn };
  const realBatch = holder.batch.bind(t.db) as BatchFn;
  holder.batch = async (stmts) => {
    holder.batch = realBatch;
    t.raw.prepare(statement).run(...params);
    return realBatch(stmts);
  };
}

describe('a report re-checks the gate at commit (AECI-2042 review)', () => {
  it.each([
    [
      'the caller lost its endpoint',
      'DELETE FROM product_vendors WHERE vendor_id = ?',
      [ACUMATICA],
    ],
    [
      'the owner changed, so the routing read is stale',
      'UPDATE connector_evidenced_pairs SET built_by_vendor_id = ? WHERE id = ?',
      [NOBODY, PAIR],
    ],
    [
      'the pair was retired',
      "UPDATE connector_evidenced_pairs SET retired_at = '2026-11-25T00:00:00.000Z' WHERE id = ?",
      [PAIR],
    ],
    [
      'the connector is no longer a Sync Service',
      "UPDATE products SET connector_kind = 'integration_platform' WHERE id = ?",
      [S_SYNC],
    ],
  ])('%s: 409 PAIR_CONTEST_CHANGED, nothing written', async (_label, statement, params) => {
    raceBeforeBatch(statement, ...params);
    const res = await flow();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAIR_CONTEST_CHANGED');
    expect(await t.db.select().from(syncServicePairContests)).toEqual([]);
  });

  it('a duplicate that won the race still answers PAIR_CONTEST_DUPLICATE', async () => {
    expect((await existence()).status).toBe(201);
    const again = await existence();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAIR_CONTEST_DUPLICATE');
  });
});
