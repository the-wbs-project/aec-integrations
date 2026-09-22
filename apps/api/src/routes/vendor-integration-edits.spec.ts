/**
 * `PATCH /api/vendor/integrations/:id` (AECI-1006 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6).
 *
 * Real migrations on in-memory SQLite with `db.batch` shimmed onto one transaction,
 * so the guarded UPDATE, the race sentinel and the audit-in-batch rule run for real.
 */

import {
  CONNECTOR_DELIVERED_MECHANISM_KINDS,
  IntegrationMechanismKindSchema,
  ListVendorNotificationsResponseSchema,
  OWNER_EDITABLE_MECHANISM_KINDS,
  UpdateVendorIntegrationResponseSchema,
  integrationEditValueProblem,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { isConnectorPoweredEdge } from '../lib/connector-powered';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createUpdateVendorIntegrationHandler,
  INTEGRATION_UPDATED_ACTION,
} from './vendor-integration-edits';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns SOURCE, B owns TARGET and is the recorded, claimed owner of I_MAIN.
// C owns an unrelated product.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3);

const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_FOREIGN = uuid(12);
const P_CONNECTOR = uuid(13);

const I_MAIN = uuid(20); // SOURCE (A) → TARGET (B), owned by B, claimed
const I_UNCLAIMED = uuid(21); // SOURCE (A) → TARGET (B), owned by B, not claimed
const I_NO_OWNER = uuid(22); // SOURCE (A) → TARGET (B), nobody on file
const I_POWERED = uuid(23); // SOURCE (A) → CONNECTOR (B), powered_by set, owned by B, claimed

const CLAIMED_AT = '2026-09-01T00:00:00.000Z';

const seat = (n: number, vendorId: string): AuthzVariables['auth'] => ({
  userId: uuid(100 + n),
  email: `seat${n}@example.test`,
  role: 'vendor_admin',
  vendorId,
  // No entitlement at all: a seat is the whole gate (decision 15).
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_A = seat(1, VENDOR_A);
const AUTH_B = seat(2, VENDOR_B);
const AUTH_C = seat(3, VENDOR_C);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
    { id: P_FOREIGN, slug: 'archicad', name: 'ArchiCAD' },
    { id: P_CONNECTOR, slug: 'bentley-connect', name: 'Bentley Connect', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_FOREIGN, vendorId: VENDOR_C, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_MAIN,
      name: 'Revit for MicroStation',
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      mechanismKind: 'native',
      direction: 'a_to_b',
      website: 'https://bentley.example/revit',
      notes: 'AECi curation note',
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
      maintainedBy: 'vendor',
      lastReviewedAt: CLAIMED_AT,
      updatedAt: CLAIMED_AT,
    },
    {
      id: I_UNCLAIMED,
      name: 'Unclaimed',
      sourceProductId: P_SOURCE,
      targetProductId: P_TARGET,
      mechanismKind: 'api',
      builtByVendorId: VENDOR_B,
    },
    { id: I_NO_OWNER, sourceProductId: P_SOURCE, targetProductId: P_TARGET },
    {
      id: I_POWERED,
      sourceProductId: P_SOURCE,
      targetProductId: P_CONNECTOR,
      mechanismKind: 'marketplace-app',
      poweredByProductId: P_CONNECTOR,
      builtByVendorId: VENDOR_B,
      claimedAt: CLAIMED_AT,
    },
  ]);
  // `audit_log.actor_id` is an FK to `profiles`, so every seat needs its row.
  await t.db.insert(profiles).values(
    [AUTH_A, AUTH_B, AUTH_C].map((auth) => ({
      id: auth.userId,
      role: 'vendor_admin',
      vendorId: auth.vendorId,
    })),
  );
});
afterEach(() => t.dispose());

function app(
  auth: AuthzVariables['auth'],
  handler = createUpdateVendorIntegrationHandler(t.factory),
) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.patch('/api/vendor/integrations/:id', handler);
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: AuthzVariables['auth'],
  path: string,
  init: { method: 'GET' | 'PATCH'; body?: unknown },
  handler?: ReturnType<typeof createUpdateVendorIntegrationHandler>,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app(auth, handler).request(
    path,
    {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { 'Content-Type': 'application/json' } }),
    },
    env,
    execCtx,
  );
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const edit = (auth: AuthzVariables['auth'], id: string, body: unknown) =>
  call(auth, `/api/vendor/integrations/${id}`, { method: 'PATCH', body });

const row = async (id: string) =>
  (await t.db.query.integrations.findFirst({ where: eq(integrations.id, id) }))!;
const auditRows = () => t.db.select().from(auditLog);
const updateAudits = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, INTEGRATION_UPDATED_ACTION));
const notificationRows = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, NOTIFICATION_SENT_ACTION));

describe('PATCH /api/vendor/integrations/:id — the claimed owner edits', () => {
  it('writes the changed fields, the maintenance transfer and updated_at', async () => {
    const res = await edit(AUTH_B, I_MAIN, {
      name: 'MicroStation Link',
      description: 'Sends models from Revit to MicroStation.',
      website: null,
    });

    expect(res.status).toBe(200);
    expect(() => UpdateVendorIntegrationResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.integration).toMatchObject({
      id: I_MAIN,
      changed: ['name', 'description', 'website'],
      maintained_by: 'vendor',
    });
    const after = await row(I_MAIN);
    expect(after.name).toBe('MicroStation Link');
    expect(after.description).toBe('Sends models from Revit to MicroStation.');
    expect(after.website).toBeNull();
    expect(after.lastReviewedAt).toBe(res.body.integration.last_reviewed_at);
    expect(after.updatedAt).toBe(res.body.integration.updated_at);
    expect(after.updatedAt > CLAIMED_AT).toBe(true);
    // Untouched: the owner, the claim, and AECi's own curation column.
    expect(after.builtByVendorId).toBe(VENDOR_B);
    expect(after.claimedAt).toBe(CLAIMED_AT);
    expect(after.notes).toBe('AECi curation note');
  });

  it('writes one integration.updated audit row with before and after, in the same batch', async () => {
    await edit(AUTH_B, I_MAIN, { name: 'MicroStation Link', website: null });
    const [audit, ...rest] = await updateAudits();
    expect(rest).toHaveLength(0);
    expect(audit).toMatchObject({
      actorId: AUTH_B.userId,
      entityType: 'integration',
      entityId: I_MAIN,
    });
    expect(audit!.beforeState).toEqual({
      name: 'Revit for MicroStation',
      website: 'https://bentley.example/revit',
      maintained_by: 'vendor',
      last_reviewed_at: CLAIMED_AT,
    });
    expect(audit!.afterState).toMatchObject({
      name: 'MicroStation Link',
      website: null,
      maintained_by: 'vendor',
    });
    expect(audit!.metadata).toEqual({
      source: 'vendor-portal',
      vendorId: VENDOR_B,
      reason: 'owner-edit',
      fields: ['name', 'website'],
      // Already vendor-maintained after the claim, so no transfer flag (§13.9).
    });
  });

  it('marks the maintenance transfer only when the row changes hands', async () => {
    await t.db
      .update(integrations)
      .set({ maintainedBy: 'aeci' })
      .where(eq(integrations.id, I_MAIN));
    await edit(AUTH_B, I_MAIN, { maturity: 'GA' });
    const [audit] = await updateAudits();
    expect(audit!.metadata).toMatchObject({ maintenanceTransfer: true });
    expect((await row(I_MAIN)).maintainedBy).toBe('vendor');
  });

  it('notifies the other endpoint vendor, never the owner, and shows it in the feed', async () => {
    await edit(AUTH_B, I_MAIN, { name: 'MicroStation Link' });
    const rows = await notificationRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      kind: 'integration_update',
      vendorId: VENDOR_A,
      ownerVendorId: VENDOR_B,
      ownerName: 'Bentley',
      integrationName: 'MicroStation Link',
      fields: ['name'],
      pairSlugs: ['microstation', 'revit'],
    });
    const feedA = await call(AUTH_A, '/api/vendor/notifications', { method: 'GET' });
    expect(() => ListVendorNotificationsResponseSchema.parse(feedA.body)).not.toThrow();
    expect(feedA.body.notifications).toEqual([
      expect.objectContaining({
        kind: 'integration_update',
        integration_id: I_MAIN,
        owner_name: 'Bentley',
        fields: ['name'],
        pair_path: '/products/microstation/integrations/revit',
      }),
    ]);
    const feedB = await call(AUTH_B, '/api/vendor/notifications', { method: 'GET' });
    expect(feedB.body.notifications).toEqual([]);
  });

  it('purges the pair page and both product pages', async () => {
    const res = await edit(AUTH_B, I_MAIN, { pricing_model: 'Free' });
    expect(res.send).toHaveBeenCalledWith({
      tags: ['pair:microstation__revit', 'product:revit', 'product:microstation'],
      source: 'vendor',
    });
  });

  it('frames direction against the caller’s own endpoint by default', async () => {
    // B owns TARGET, so "outbound" from B means target → source.
    await edit(AUTH_B, I_MAIN, { direction: 'outbound' });
    expect((await row(I_MAIN)).direction).toBe('b_to_a');
  });

  it('frames direction against context_product_id when sent', async () => {
    await edit(AUTH_B, I_MAIN, { direction: 'outbound', context_product_id: P_SOURCE });
    expect((await row(I_MAIN)).direction).toBe('a_to_b');
    // Same value in the same frame: nothing to write.
    const again = await edit(AUTH_B, I_MAIN, { direction: 'inbound' });
    expect(again.body.integration.changed).toEqual([]);
  });

  it('writes nothing at all, not even an audit row, when every value is unchanged', async () => {
    const res = await edit(AUTH_B, I_MAIN, {
      name: 'Revit for MicroStation',
      mechanism_kind: 'native',
    });
    expect(res.status).toBe(200);
    expect(res.body.integration.changed).toEqual([]);
    expect(await auditRows()).toHaveLength(0);
    expect(res.send).not.toHaveBeenCalled();
    expect((await row(I_MAIN)).updatedAt).toBe(CLAIMED_AT);
  });

  it('treats an empty string as a clear', async () => {
    await edit(AUTH_B, I_MAIN, { website: '   ' });
    expect((await row(I_MAIN)).website).toBeNull();
  });

  it('leaves an open contest on the edited field open (§4.5.6)', async () => {
    await t.db.insert(integrationFieldChallenges).values({
      id: uuid(300),
      integrationId: I_MAIN,
      field: 'name',
      currentValue: 'Revit for MicroStation',
      proposedValue: 'MicroStation Link',
      reason: 'That is the listing name',
      submitterVendorId: VENDOR_A,
      routedTo: 'owner',
      ownerVendorId: VENDOR_B,
    });
    await edit(AUTH_B, I_MAIN, { name: 'MicroStation Link' });
    const [contest] = await t.db.select().from(integrationFieldChallenges);
    expect(contest).toMatchObject({ status: 'open', decidedAt: null });
  });
});

describe('PATCH /api/vendor/integrations/:id — the gate, in order', () => {
  it('answers the same 404 for a row the caller cannot see and for an unknown id', async () => {
    const hidden = await edit(AUTH_C, I_MAIN, { name: 'x' });
    const unknown = await edit(AUTH_C, uuid(999), { name: 'x' });
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(hidden.body.error.code).toBe(unknown.body.error.code);
    expect((await edit(AUTH_C, I_NO_OWNER, { name: 'x' })).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 403 INTEGRATION_NOT_OWNER to an endpoint vendor that is not the owner', async () => {
    const res = await edit(AUTH_A, I_MAIN, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_OWNER');
    expect((await row(I_MAIN)).name).toBe('Revit for MicroStation');
  });

  it('answers 409 INTEGRATION_OWNER_UNKNOWN when nobody is on file', async () => {
    const res = await edit(AUTH_A, I_NO_OWNER, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_OWNER_UNKNOWN');
  });

  it('answers 403 INTEGRATION_CONNECTOR_POWERED to the owner of a connector-powered row', async () => {
    const res = await edit(AUTH_B, I_POWERED, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_CONNECTOR_POWERED');
    expect(await auditRows()).toHaveLength(0);
  });

  it('asks ownership before connector-powered', async () => {
    const res = await edit(AUTH_A, I_POWERED, { name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_OWNER');
  });

  it('answers 409 INTEGRATION_NOT_CLAIMED to an owner that has not claimed', async () => {
    const res = await edit(AUTH_B, I_UNCLAIMED, { name: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CLAIMED');
    expect((await row(I_UNCLAIMED)).name).toBe('Unclaimed');
    expect(await auditRows()).toHaveLength(0);
  });

  it('checks ownership before the body, so a non-owner cannot probe with a bad one', async () => {
    const res = await edit(AUTH_A, I_MAIN, { owner: VENDOR_A });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/vendor/integrations/:id — the body', () => {
  it.each([
    ['an empty body', {}],
    ['only a frame', { context_product_id: P_SOURCE }],
    ['the owner field', { owner: VENDOR_A }],
    ['AECi’s notes column', { notes: 'mine now' }],
    ['a raw column name', { built_by_vendor_id: VENDOR_A }],
    ['an over-long name', { name: 'x'.repeat(201) }],
  ])('refuses %s with 400', async (_label, body) => {
    const res = await edit(AUTH_B, I_MAIN, body);
    expect(res.status).toBe(400);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a context_product_id that is not one of the two endpoints', async () => {
    const res = await edit(AUTH_B, I_MAIN, { direction: 'both', context_product_id: P_FOREIGN });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('context_product_id');
  });

  it.each([
    ['mechanism_kind', 'iPaaS'],
    ['mechanism_kind', 'integrator'],
    ['mechanism_kind', 'carrier-pigeon'],
    ['direction', 'a_to_b'],
    ['website', 'ftp://example.com'],
    ['listing_url', 'not a url'],
    ['name', null],
    ['mechanism_kind', null],
    ['direction', null],
  ])('refuses %s = %j with 422 INTEGRATION_INVALID_VALUE', async (field, value) => {
    const res = await edit(AUTH_B, I_MAIN, { [field]: value });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INTEGRATION_INVALID_VALUE');
    expect(res.body.error.field).toBe(field);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses the whole body when one field is invalid, and writes none of it', async () => {
    const res = await edit(AUTH_B, I_MAIN, { name: 'New', mechanism_kind: 'iPaaS' });
    expect(res.status).toBe(422);
    expect((await row(I_MAIN)).name).toBe('Revit for MicroStation');
  });
});

describe('PATCH /api/vendor/integrations/:id — the race guard', () => {
  /** A handler whose batch runs `sql` against the raw DB first, the way a
   *  concurrent write would land between the handler's read and its batch. */
  function racing(statement: string, ...params: unknown[]) {
    const factory = t.factory;
    let fired = false;
    return createUpdateVendorIntegrationHandler((env, opts) => {
      const ctx = factory(env, opts);
      if (!fired) {
        const batch = ctx.db.batch.bind(ctx.db);
        (ctx.db as unknown as { batch: typeof batch }).batch = (async (stmts: never) => {
          fired = true;
          t.raw.prepare(statement).run(...params);
          return batch(stmts);
        }) as typeof batch;
      }
      return ctx;
    });
  }

  it('refuses the old owner when AECi reassigned the row before the batch ran', async () => {
    const handler = racing(
      `UPDATE integrations SET built_by_vendor_id = ?, claimed_at = NULL WHERE id = ?`,
      VENDOR_A,
      I_MAIN,
    );
    const res = await call(
      AUTH_B,
      `/api/vendor/integrations/${I_MAIN}`,
      { method: 'PATCH', body: { name: 'Stolen' } },
      handler,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_OWNER');
    expect((await row(I_MAIN)).name).toBe('Revit for MicroStation');
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses when the claim was cleared under the same owner, and writes nothing', async () => {
    const handler = racing(`UPDATE integrations SET claimed_at = NULL WHERE id = ?`, I_MAIN);
    const res = await call(
      AUTH_B,
      `/api/vendor/integrations/${I_MAIN}`,
      { method: 'PATCH', body: { name: 'Late' } },
      handler,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_NOT_CLAIMED');
    expect(await notificationRows()).toHaveLength(0);
  });
});

describe('the connector-kind lockstep', () => {
  it('the shared list names exactly the kinds isConnectorPoweredEdge treats as connector-delivered', () => {
    for (const kind of IntegrationMechanismKindSchema.options) {
      expect(CONNECTOR_DELIVERED_MECHANISM_KINDS.has(kind)).toBe(
        isConnectorPoweredEdge({ poweredByProductId: null, mechanismKind: kind }),
      );
      expect(OWNER_EDITABLE_MECHANISM_KINDS.includes(kind)).toBe(
        !CONNECTOR_DELIVERED_MECHANISM_KINDS.has(kind),
      );
      expect(integrationEditValueProblem('mechanism_kind', kind) === null).toBe(
        OWNER_EDITABLE_MECHANISM_KINDS.includes(kind),
      );
    }
  });
});
