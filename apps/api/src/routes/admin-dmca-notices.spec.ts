/**
 * `/api/admin/dmca-notices` (AECI-1665) against the in-memory D1 harness. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.23, `docs/API_CONTRACTS.md` §6.10 "Copyright notices".
 *
 * INVARIANTS. None should be deleted without reopening the decision behind it:
 *
 *   1. **Every write is one row change and one audit row in ONE batch.** An audit insert
 *      that fails rolls the row back.
 *   2. **The audit row holds no personal data.** Names, contact details, the material,
 *      the notes and the account id are named in `metadata.fields`, never copied.
 *   3. **A counter-notice answers a notice.** A missing `notice_id`, or one naming a
 *      counter-notice, is refused and writes nothing.
 *   4. **A stale edit is 409 `DMCA_NOTICE_CHANGED` and writes nothing.** A no-op edit
 *      writes nothing either.
 *   5. **The list's account counts are the user detail's counts.**
 *   6. **An account deleted mid-write leaves no dead id.** The account check is part of the
 *      write itself, so a profile deleted after the early read means no row, no audit row
 *      and a 400 on `account_id`.
 *   7. **Every notice is logged, complete or not.** Name, contact and material may be
 *      missing. Only a `removed` or `disabled` row needs `content_identified`.
 */

import {
  ApiErrorCode,
  CreateDmcaNoticeResponseSchema,
  DmcaNoticesResponseSchema,
  UpdateDmcaNoticeResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, dmcaNotices, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { logBatchToPosthog } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createAdminDmcaNoticesHandler,
  createCreateDmcaNoticeHandler,
  createUpdateDmcaNoticeHandler,
  isDmcaRaceError,
} from './admin-dmca-notices';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const NOW = new Date('2026-11-23T15:00:00.000Z');
const ADMIN = '00000000-0000-4000-8000-000000000900';
const ACCOUNT = '00000000-0000-4000-8000-000000000901';
const VENDOR = '00000000-0000-4000-8000-000000000902';

let t: TestDb;
let now = NOW;
beforeEach(async () => {
  vi.mocked(logBatchToPosthog).mockClear();
  now = NOW;
  t = await makeTestDb();
  await t.db.insert(profiles).values([
    { id: ADMIN, role: 'admin' },
    { id: ACCOUNT, role: 'reviewer', displayName: 'Uploader' },
  ]);
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
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
  const deps = { now: () => now };
  a.get('/api/admin/dmca-notices', createAdminDmcaNoticesHandler(t.factory, deps));
  a.post('/api/admin/dmca-notices', createCreateDmcaNoticeHandler(t.factory, deps));
  a.patch('/api/admin/dmca-notices/:id', createUpdateDmcaNoticeHandler(t.factory, deps));
  return a;
}

const ENV = { ENV: 'staging' } as unknown as Env;

async function call(method: string, path: string, body?: unknown) {
  return app().request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
    fakeExecutionContext(),
  );
}

const notice = (over: Record<string, unknown> = {}) => ({
  kind: 'notice',
  received_at: '2026-11-20T15:00:00.000Z',
  submitter_name: 'Rights Holder LLC',
  submitter_contact: 'legal@rights.test, 1 Main St, 555-0100',
  content_identified: 'https://www.aecintegrations.com/vendors/acme logo',
  work_claimed: 'The Rights Holder logo',
  account_id: ACCOUNT,
  vendor_id: VENDOR,
  action: 'removed',
  action_at: '2026-11-20T16:00:00.000Z',
  ...over,
});

async function createNotice(over: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/admin/dmca-notices', notice(over));
  expect(res.status).toBe(201);
  return CreateDmcaNoticeResponseSchema.parse(await res.json()).notice;
}

const audits = () => t.db.select().from(auditLog).where(eq(auditLog.entityType, 'dmca_notice'));

/**
 * An app whose first `db.batch` runs `before()` first: the write that lands between the
 * handler's early read and its batch. `after()` runs once that batch has committed and
 * before the handler reads anything else: the write that lands just after this one.
 */
function racingApp(before: () => void, after: () => void = () => {}) {
  const realFactory = t.factory;
  let fired = false;
  const factory: typeof realFactory = (env, opts) => {
    const ctx = realFactory(env, opts);
    const batch = ctx.db.batch.bind(ctx.db) as (stmts: unknown) => Promise<unknown>;
    (ctx.db as unknown as { batch: (stmts: unknown) => Promise<unknown> }).batch = async (
      stmts,
    ) => {
      if (fired) return batch(stmts);
      fired = true;
      before();
      const out = await batch(stmts);
      after();
      return out;
    };
    return ctx;
  };
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', { userId: ADMIN, role: 'admin' } as AuthzVariables['auth']);
    await next();
  });
  a.post('/x', createCreateDmcaNoticeHandler(factory, { now: () => now }));
  a.patch('/x/:id', createUpdateDmcaNoticeHandler(factory, { now: () => now }));
  return (method: string, path: string, body: unknown) =>
    a.request(
      path,
      { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      ENV,
      fakeExecutionContext(),
    );
}

const deleteAccount = () => t.raw.prepare('DELETE FROM profiles WHERE id = ?').run(ACCOUNT);

describe('POST /api/admin/dmca-notices', () => {
  it('logs a notice with its audit row, holding no personal data', async () => {
    const out = await createNotice({ notes: 'Called the uploader.' });
    expect(out).toMatchObject({
      kind: 'notice',
      notice_id: null,
      account_id: ACCOUNT,
      account_name: 'Uploader',
      vendor_id: VENDOR,
      vendor_name: 'Acme',
      action: 'removed',
      created_by: ADMIN,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      restore_clock: null,
    });
    const [row] = await t.db.select().from(dmcaNotices);
    expect(row).toMatchObject({
      submitterName: 'Rights Holder LLC',
      notes: 'Called the uploader.',
    });

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'dmca_notice.created',
      entityId: out.id,
      actorId: ADMIN,
      actorType: 'admin',
      vendorId: VENDOR,
      beforeState: null,
    });
    expect(rows[0]?.afterState).toEqual({
      kind: 'notice',
      received_at: '2026-11-20T15:00:00.000Z',
      vendor_id: VENDOR,
      action: 'removed',
      action_at: '2026-11-20T16:00:00.000Z',
    });
    const serialized = JSON.stringify(rows[0]);
    for (const secret of ['Rights Holder', 'legal@rights.test', 'Called the uploader', ACCOUNT]) {
      expect(serialized).not.toContain(secret);
    }
    expect((rows[0]?.metadata as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(['submitter_name', 'account_id', 'notes']),
    );
    expect(vi.mocked(logBatchToPosthog)).toHaveBeenCalledTimes(1);
  });

  it('logs a counter-notice against a notice, with its restore clock', async () => {
    const parent = await createNotice();
    const res = await call('POST', '/api/admin/dmca-notices', {
      kind: 'counter_notice',
      notice_id: parent.id,
      received_at: '2026-11-20T15:00:00.000Z',
      submitter_name: 'Uploader',
      submitter_contact: 'me@example.test',
      content_identified: 'The same logo',
      account_id: ACCOUNT,
      forwarded_at: '2026-11-20T18:00:00.000Z',
    });
    expect(res.status).toBe(201);
    const out = CreateDmcaNoticeResponseSchema.parse(await res.json()).notice;
    expect(out).toMatchObject({ kind: 'counter_notice', notice_id: parent.id, action: 'pending' });
    expect(out.restore_clock).toEqual({
      earliest: '2026-12-07T05:00:00.000Z',
      latest: '2026-12-12T05:00:00.000Z',
      opens_on: '2026-12-07',
      due_on: '2026-12-11',
      state: 'waiting',
    });
  });

  it('refuses a counter-notice with no notice, or one that names a counter-notice', async () => {
    const parent = await createNotice();
    const counter = {
      kind: 'counter_notice',
      received_at: '2026-11-21T15:00:00.000Z',
      submitter_name: 'Uploader',
      submitter_contact: 'me@example.test',
      content_identified: 'The same logo',
    };
    const missing = await call('POST', '/api/admin/dmca-notices', counter);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: ApiErrorCode.VALIDATION_FAILED, field: 'notice_id' },
    });

    const first = await call('POST', '/api/admin/dmca-notices', {
      ...counter,
      notice_id: parent.id,
    });
    const firstId = CreateDmcaNoticeResponseSchema.parse(await first.json()).notice.id;
    const chained = await call('POST', '/api/admin/dmca-notices', {
      ...counter,
      notice_id: firstId,
    });
    expect(chained.status).toBe(400);
    expect(await chained.json()).toMatchObject({
      error: { code: ApiErrorCode.VALIDATION_FAILED, field: 'notice_id' },
    });
    const unknown = await call('POST', '/api/admin/dmca-notices', {
      ...counter,
      notice_id: '00000000-0000-4000-8000-00000000ffff',
    });
    expect(unknown.status).toBe(400);
    expect(await t.db.select().from(dmcaNotices)).toHaveLength(2);
    expect(await audits()).toHaveLength(2);
  });

  it('refuses a notice_id on a notice and counter-notice fields on a notice (400)', async () => {
    const parent = await createNotice();
    const res = await call('POST', '/api/admin/dmca-notices', notice({ notice_id: parent.id }));
    expect(res.status).toBe(400);
    const res2 = await call(
      'POST',
      '/api/admin/dmca-notices',
      notice({ restore_outcome: 'restored' }),
    );
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ error: { field: 'restore_outcome' } });
  });

  it('refuses an unknown account or vendor (400, field named) and writes nothing', async () => {
    const res = await call(
      'POST',
      '/api/admin/dmca-notices',
      notice({ account_id: '00000000-0000-4000-8000-00000000abcd' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: ApiErrorCode.VALIDATION_FAILED, field: 'account_id' },
    });
    const res2 = await call('POST', '/api/admin/dmca-notices', notice({ vendor_id: 'nope' }));
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ error: { field: 'vendor_id' } });
    expect(await t.db.select().from(dmcaNotices)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('writes no row when the account is deleted between the check and the batch', async () => {
    const send = racingApp(deleteAccount);
    const res = await send('POST', '/x', notice());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: ApiErrorCode.VALIDATION_FAILED, field: 'account_id' },
    });
    expect(await t.db.select().from(dmcaNotices)).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(logBatchToPosthog).not.toHaveBeenCalled();
  });

  it('settles inside its batch: a write that lands just after it is not misread', async () => {
    // An edit and an account deletion commit right after this batch. The created row is
    // still the one this request wrote, and the forward runs.
    let id = '';
    const send = racingApp(
      () => {},
      () => {
        const row = t.raw.prepare('SELECT id FROM dmca_notices').get() as { id: string };
        id = row.id;
        t.raw
          .prepare('UPDATE dmca_notices SET notes = ?, updated_at = ? WHERE id = ?')
          .run('Later edit.', '2026-11-23T16:00:00.000Z', id);
        t.raw.prepare('UPDATE dmca_notices SET account_id = NULL WHERE id = ?').run(id);
        deleteAccount();
      },
    );
    const res = await send('POST', '/x', notice());
    expect(res.status).toBe(201);
    const out = CreateDmcaNoticeResponseSchema.parse(await res.json()).notice;
    expect(out).toMatchObject({
      id,
      account_id: ACCOUNT,
      notes: null,
      updated_at: NOW.toISOString(),
    });
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });

  it('logs an incomplete notice: no name, contact or material', async () => {
    const res = await call('POST', '/api/admin/dmca-notices', {
      kind: 'notice',
      received_at: '2026-11-20T15:00:00.000Z',
      action: 'no_action',
    });
    expect(res.status).toBe(201);
    const out = CreateDmcaNoticeResponseSchema.parse(await res.json()).notice;
    expect(out).toMatchObject({
      submitter_name: null,
      submitter_contact: null,
      content_identified: null,
      account_id: null,
      action: 'no_action',
    });
    const [audit] = await audits();
    expect((audit?.metadata as { fields: string[] }).fields).toEqual([
      'kind',
      'received_at',
      'action',
    ]);
  });

  it('refuses a takedown that names no material (400) and writes nothing', async () => {
    for (const action of ['removed', 'disabled']) {
      const res = await call(
        'POST',
        '/api/admin/dmca-notices',
        notice({ action, content_identified: undefined }),
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('content_identified');
    }
    expect(await t.db.select().from(dmcaNotices)).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('refuses a non-JSON body and an unknown key (400)', async () => {
    const res = await app().request(
      '/api/admin/dmca-notices',
      { method: 'POST', body: 'not json' },
      ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect((await call('POST', '/api/admin/dmca-notices', notice({ extra: 1 }))).status).toBe(400);
  });

  it('rolls the batch back whole when the audit insert fails', async () => {
    t.raw.prepare('DROP TABLE audit_log').run();
    const res = await call('POST', '/api/admin/dmca-notices', notice());
    expect(res.status).toBe(500);
    expect(await t.db.select().from(dmcaNotices)).toEqual([]);
  });
});

describe('PATCH /api/admin/dmca-notices/:id', () => {
  it('edits the row and audits the change, before and after', async () => {
    const created = await createNotice({ action: 'pending', action_at: null });
    now = new Date('2026-11-24T10:00:00.000Z');
    const res = await call('PATCH', `/api/admin/dmca-notices/${created.id}`, {
      expected_updated_at: created.updated_at,
      action: 'disabled',
      action_at: '2026-11-24T09:00:00.000Z',
      notes: 'Logo disabled.',
    });
    expect(res.status).toBe(200);
    const out = UpdateDmcaNoticeResponseSchema.parse(await res.json());
    expect(out.changed).toBe(true);
    expect(out.notice).toMatchObject({
      action: 'disabled',
      notes: 'Logo disabled.',
      updated_by: ADMIN,
      updated_at: '2026-11-24T10:00:00.000Z',
    });
    const updates = (await audits()).filter((a) => a.action === 'dmca_notice.updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      entityId: created.id,
      vendorId: VENDOR,
      beforeState: { action: 'pending', action_at: null },
      afterState: { action: 'disabled', action_at: '2026-11-24T09:00:00.000Z' },
      metadata: { source: 'admin-dmca-notices', kind: 'notice' },
    });
    expect((updates[0]?.metadata as { fields: string[] }).fields).toEqual([
      'action',
      'action_at',
      'notes',
    ]);
    expect(JSON.stringify(updates[0])).not.toContain('Logo disabled');
  });

  it('answers a stale expected_updated_at with 409 and writes nothing', async () => {
    const created = await createNotice();
    const res = await call('PATCH', `/api/admin/dmca-notices/${created.id}`, {
      expected_updated_at: '2026-01-01T00:00:00.000Z',
      action: 'disabled',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: ApiErrorCode.DMCA_NOTICE_CHANGED } });
    const [row] = await t.db.select().from(dmcaNotices);
    expect(row?.action).toBe('removed');
    expect(await audits()).toHaveLength(1);
  });

  it('the in-batch sentinel catches a save that lands after the read', async () => {
    const created = await createNotice();
    // Another tab saves between this request's read and its batch: simulated by moving
    // updated_at under a factory whose first read still sees the old value.
    const realFactory = t.factory;
    let moved = false;
    const factory: typeof realFactory = (env, opts) => {
      const ctx = realFactory(env, opts);
      const batch = ctx.db.batch.bind(ctx.db) as (stmts: unknown) => Promise<unknown>;
      (ctx.db as unknown as { batch: (stmts: unknown) => Promise<unknown> }).batch = async (
        stmts,
      ) => {
        if (!moved) {
          moved = true;
          t.raw
            .prepare('UPDATE dmca_notices SET updated_at = ? WHERE id = ?')
            .run('2026-11-23T15:00:00.500Z', created.id);
        }
        return batch(stmts);
      };
      return ctx;
    };
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', { userId: ADMIN, role: 'admin' } as AuthzVariables['auth']);
      await next();
    });
    a.patch('/x/:id', createUpdateDmcaNoticeHandler(factory, { now: () => now }));
    const res = await a.request(
      `/x/${created.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_updated_at: created.updated_at, action: 'disabled' }),
      },
      ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(409);
    const [row] = await t.db.select().from(dmcaNotices);
    expect(row?.action).toBe('removed');
    expect(await audits()).toHaveLength(1);
  });

  it('a no-op edit answers changed: false and writes nothing', async () => {
    const created = await createNotice();
    const res = await call('PATCH', `/api/admin/dmca-notices/${created.id}`, {
      expected_updated_at: created.updated_at,
      action: 'removed',
      submitter_name: 'Rights Holder LLC',
    });
    expect(res.status).toBe(200);
    expect(UpdateDmcaNoticeResponseSchema.parse(await res.json()).changed).toBe(false);
    expect(await audits()).toHaveLength(1);
  });

  it('refuses a counter-notice field on a notice, and an unknown account', async () => {
    const created = await createNotice();
    const res = await call('PATCH', `/api/admin/dmca-notices/${created.id}`, {
      expected_updated_at: created.updated_at,
      restore_outcome: 'restored',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { field: 'restore_outcome' } });
    const res2 = await call('PATCH', `/api/admin/dmca-notices/${created.id}`, {
      expected_updated_at: created.updated_at,
      account_id: 'nobody',
    });
    expect(res2.status).toBe(400);
    expect(await res2.json()).toMatchObject({ error: { field: 'account_id' } });
    expect(await audits()).toHaveLength(1);
  });

  it('writes nothing when the account is deleted between the check and the batch', async () => {
    const created = await createNotice({ account_id: null });
    const send = racingApp(deleteAccount);
    const res = await send('PATCH', `/x/${created.id}`, {
      expected_updated_at: created.updated_at,
      account_id: ACCOUNT,
      notes: 'Linked the uploader.',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: ApiErrorCode.VALIDATION_FAILED, field: 'account_id' },
    });
    const [row] = await t.db.select().from(dmcaNotices);
    expect(row).toMatchObject({ accountId: null, notes: null, updatedAt: created.updated_at });
    expect(await audits()).toHaveLength(1);
    // Only the create's forward ran.
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });

  it('a save that lands just after the batch does not turn a committed edit into a 409', async () => {
    const created = await createNotice();
    vi.mocked(logBatchToPosthog).mockClear();
    now = new Date('2026-11-24T10:00:00.000Z');
    const send = racingApp(
      () => {},
      () =>
        t.raw
          .prepare('UPDATE dmca_notices SET notes = ?, updated_at = ? WHERE id = ?')
          .run('Another tab.', '2026-11-24T11:00:00.000Z', created.id),
    );
    const res = await send('PATCH', `/x/${created.id}`, {
      expected_updated_at: created.updated_at,
      action: 'disabled',
    });
    expect(res.status).toBe(200);
    const out = UpdateDmcaNoticeResponseSchema.parse(await res.json());
    expect(out).toMatchObject({
      changed: true,
      notice: { action: 'disabled', notes: null, updated_at: '2026-11-24T10:00:00.000Z' },
    });
    expect(await audits()).toHaveLength(2);
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });

  it('an account deleted just after the batch does not turn a linked edit into a 400', async () => {
    const created = await createNotice({ account_id: null });
    vi.mocked(logBatchToPosthog).mockClear();
    now = new Date('2026-11-24T10:00:00.000Z');
    const send = racingApp(
      () => {},
      () => {
        // The account-deletion batch: null the link (Drizzle's `$onUpdate` moves
        // `updated_at`), then drop the profile.
        t.raw
          .prepare('UPDATE dmca_notices SET account_id = NULL, updated_at = ? WHERE account_id = ?')
          .run('2026-11-24T11:00:00.000Z', ACCOUNT);
        deleteAccount();
      },
    );
    const res = await send('PATCH', `/x/${created.id}`, {
      expected_updated_at: created.updated_at,
      account_id: ACCOUNT,
    });
    expect(res.status).toBe(200);
    expect(UpdateDmcaNoticeResponseSchema.parse(await res.json()).notice).toMatchObject({
      account_id: ACCOUNT,
      account_name: 'Uploader',
    });
    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });

  it('an edit that clears account_id needs no account guard', async () => {
    const created = await createNotice();
    const send = racingApp(deleteAccount);
    const res = await send('PATCH', `/x/${created.id}`, {
      expected_updated_at: created.updated_at,
      account_id: null,
    });
    expect(res.status).toBe(200);
    const [row] = await t.db.select().from(dmcaNotices);
    expect(row?.accountId).toBeNull();
    expect(await audits()).toHaveLength(2);
  });

  it('applies the takedown rule to the row as the edit leaves it', async () => {
    const incomplete = await createNotice({
      action: 'pending',
      action_at: null,
      content_identified: undefined,
    });
    // pending → removed with no material on the row: refused.
    const res = await call('PATCH', `/api/admin/dmca-notices/${incomplete.id}`, {
      expected_updated_at: incomplete.updated_at,
      action: 'removed',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: ApiErrorCode.VALIDATION_FAILED, field: 'content_identified' },
    });
    // The same edit with the material in it: saved.
    const ok = await call('PATCH', `/api/admin/dmca-notices/${incomplete.id}`, {
      expected_updated_at: incomplete.updated_at,
      action: 'removed',
      content_identified: 'https://www.aecintegrations.com/vendors/acme logo',
    });
    expect(ok.status).toBe(200);
    const saved = UpdateDmcaNoticeResponseSchema.parse(await ok.json()).notice;
    // Clearing the material of a removed row: refused.
    const clear = await call('PATCH', `/api/admin/dmca-notices/${incomplete.id}`, {
      expected_updated_at: saved.updated_at,
      content_identified: null,
    });
    expect(clear.status).toBe(400);
    expect(await clear.json()).toMatchObject({ error: { field: 'content_identified' } });
    // Clearing the name and contact is fine.
    const names = await call('PATCH', `/api/admin/dmca-notices/${incomplete.id}`, {
      expected_updated_at: saved.updated_at,
      submitter_name: null,
      submitter_contact: null,
    });
    expect(names.status).toBe(200);
    expect(UpdateDmcaNoticeResponseSchema.parse(await names.json()).notice).toMatchObject({
      submitter_name: null,
      submitter_contact: null,
    });
    expect(await audits()).toHaveLength(3);
  });

  it('answers 404 for an unknown id', async () => {
    const res = await call('PATCH', '/api/admin/dmca-notices/nope', {
      expected_updated_at: NOW.toISOString(),
      action: 'removed',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: ApiErrorCode.NOT_FOUND } });
  });

  it('recognises the sentinel abort through a cause chain, and nothing else', () => {
    const inner = new Error('malformed JSON');
    expect(isDmcaRaceError(new Error('batch failed', { cause: inner }))).toBe(true);
    expect(isDmcaRaceError(new Error('UNIQUE constraint failed'))).toBe(false);
  });
});

describe('GET /api/admin/dmca-notices', () => {
  async function list(query = '') {
    const res = await call('GET', `/api/admin/dmca-notices${query}`);
    expect(res.status).toBe(200);
    return DmcaNoticesResponseSchema.parse(await res.json());
  }

  it('sorts the most urgent clock first, then newest received', async () => {
    const old = await createNotice({ received_at: '2026-10-01T12:00:00.000Z' });
    const recent = await createNotice({ received_at: '2026-11-22T12:00:00.000Z' });
    const counter = await call('POST', '/api/admin/dmca-notices', {
      kind: 'counter_notice',
      notice_id: old.id,
      received_at: '2026-10-02T12:00:00.000Z',
      submitter_name: 'Uploader',
      submitter_contact: 'me@example.test',
      content_identified: 'x',
      forwarded_at: '2026-10-02T13:00:00.000Z',
    });
    const counterId = CreateDmcaNoticeResponseSchema.parse(await counter.json()).notice.id;
    const out = await list();
    expect(out.notices.map((n) => n.id)).toEqual([counterId, recent.id, old.id]);
    expect(out.notices[0]?.restore_clock?.state).toBe('overdue');
    expect(out.account_counts).toBeNull();
  });

  it('filters by account, kind and open, and carries the account counts', async () => {
    const a = await createNotice();
    await createNotice({ account_id: null, closed_at: '2026-11-22T00:00:00.000Z' });
    await createNotice({ action: 'no_action' });
    const out = await list(`?account_id=${ACCOUNT}`);
    expect(out.notices).toHaveLength(2);
    expect(out.account_counts).toEqual({ dmca_takedowns: 1, dmca_counter_notices: 0 });
    expect((await list('?open=true')).notices).toHaveLength(2);
    expect((await list('?kind=counter_notice')).notices).toEqual([]);
    expect(out.notices.map((n) => n.id)).toContain(a.id);
  });

  it('refuses an unknown kind (400)', async () => {
    const res = await call('GET', '/api/admin/dmca-notices?kind=other');
    expect(res.status).toBe(400);
  });
});
