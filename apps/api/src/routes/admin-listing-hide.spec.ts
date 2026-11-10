/**
 * The admin listing hide and restore (AECI-1238, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11d.6). The public reads are `hidden-public-reads.spec.ts`; the counts are
 * `lib/count-lockstep.spec.ts`. This file is the write: the cascade, the lossless
 * restore, the shared product, the refusals, the audit rows and notices in the batch,
 * a lost race, the queued purge directive, and the admin and portal reads.
 *
 * Seed: Autodesk (claimed) holds Revit alone, Shared with Bentley, and AutoCAD, which
 * is already hidden by its own hide. Bentley (claimed) holds MicroStation alone and
 * Shared. Two integrations touch the company's products: Revit to MicroStation and
 * MicroStation to Shared. Both are MicroStation's whole count.
 */

import {
  AdminListingHideResponseSchema,
  AdminVendorDetailSchema,
  VendorMeResponseSchema,
} from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  integrations,
  listingHides,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { checkProductLiveUnderHiddenVendor } from '../lib/data-quality';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  chunkTags,
  createAdminHideListingHandler,
  createAdminRestoreListingHandler,
  LISTING_PURGE_TAG_CHUNK,
} from './admin-listing-hide';
import { createAdminVendorDetailHandler, createAdminVendorProductsHandler } from './admin-vendors';
import { createVendorMeHandler } from './vendor';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1); // Autodesk, claimed
const VENDOR_B = uuid(2); // Bentley, claimed
const P_REVIT = uuid(10); // A only
const P_SHARED = uuid(11); // A and B
const P_ACAD = uuid(12); // A only, hidden by its own hide
const P_MICRO = uuid(13); // B only
const H_ACAD = uuid(30);
const I_ONE = uuid(20); // revit -> microstation
const I_TWO = uuid(21); // microstation -> shared
const CLAIMED_AT = '2026-09-01T00:00:00.000Z';
const ACAD_HIDDEN_AT = '2026-10-01T00:00:00.000Z';
const REASON = 'A court order names this listing. It is hidden while we review it.';
const NOTE = 'Order 2026-114, scanned in the legal folder.';

type Auth = AuthzVariables['auth'];
const ADMIN: Auth = {
  userId: uuid(90),
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};
const SEAT_A = {
  userId: uuid(101),
  email: 'seat@autodesk.test',
  role: 'vendor_admin',
  vendorId: VENDOR_A,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
} as Auth;

const HIDE_BODY = {
  kind: 'lawful_order',
  reason: REASON,
  internalNote: NOTE,
  receivedAt: '2026-11-08',
};

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk', ownedAt: CLAIMED_AT },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley', ownedAt: CLAIMED_AT },
  ]);
  await t.db.insert(products).values([
    {
      id: P_REVIT,
      slug: 'revit',
      name: 'Revit',
      description: 'BIM authoring.',
      promotionStatus: 'promoted',
    },
    { id: P_SHARED, slug: 'shared', name: 'Shared', promotionStatus: 'promoted' },
    {
      id: P_ACAD,
      slug: 'autocad',
      name: 'AutoCAD',
      promotionStatus: 'promoted',
      hiddenAt: ACAD_HIDDEN_AT,
      hiddenHideId: H_ACAD,
    },
    {
      id: P_MICRO,
      slug: 'microstation',
      name: 'MicroStation',
      promotionStatus: 'promoted',
      integrationCount: 2,
    },
  ]);
  await t.db.insert(listingHides).values({
    id: H_ACAD,
    entityType: 'product',
    entityId: P_ACAD,
    kind: 'complaint_under_review',
    reason: 'A complaint about the listing.',
    receivedAt: '2026-09-30',
    sourceUrl: 'https://example.test/complaint',
    setAt: ACAD_HIDDEN_AT,
  });
  await t.db.insert(productVendors).values([
    { productId: P_REVIT, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_SHARED, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_SHARED, vendorId: VENDOR_B, isPrimary: false },
    { productId: P_ACAD, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_MICRO, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: I_ONE,
      sourceProductId: P_REVIT,
      targetProductId: P_MICRO,
      mechanismKind: 'native',
      builtByVendorId: VENDOR_B,
    },
    {
      id: I_TWO,
      sourceProductId: P_MICRO,
      targetProductId: P_SHARED,
      mechanismKind: 'api',
    },
  ]);
  await t.db.insert(profiles).values([
    { id: ADMIN.userId, role: 'admin' },
    { id: SEAT_A.userId, role: 'vendor_admin', vendorId: VENDOR_A },
  ]);
});
afterEach(() => t.dispose());

function app(auth: Auth, factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/admin/vendors/:id/hide', createAdminHideListingHandler('vendor', factory));
  a.post('/api/admin/vendors/:id/restore', createAdminRestoreListingHandler('vendor', factory));
  a.post('/api/admin/products/:id/hide', createAdminHideListingHandler('product', factory));
  a.post('/api/admin/products/:id/restore', createAdminRestoreListingHandler('product', factory));
  a.get(
    '/api/admin/vendors/:id',
    createAdminVendorDetailHandler(factory, async () => ({
      available: true,
      emails: new Map(),
      reason: 'ok',
    })),
  );
  a.get('/api/admin/vendors/:id/products', createAdminVendorProductsHandler(factory));
  a.get('/api/vendor/me', createVendorMeHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  path: string,
  body?: unknown,
  opts: { auth?: Auth; method?: 'GET' | 'POST'; factory?: DbFactory } = {},
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const method = opts.method ?? 'POST';
  const init: RequestInit =
    body !== undefined
      ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : { method };
  const res = await app(opts.auth ?? ADMIN, opts.factory).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const hideVendor = (id = VENDOR_A, body: unknown = HIDE_BODY) =>
  call(`/api/admin/vendors/${id}/hide`, body);
const restoreVendor = (id = VENDOR_A) =>
  call(`/api/admin/vendors/${id}/restore`, { reason: 'The order was lifted.' });
const product = async (id: string) =>
  (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!;
const vendor = async (id: string) =>
  (await t.db.query.vendors.findFirst({ where: eq(vendors.id, id) }))!;
const audits = (action: string) => t.db.select().from(auditLog).where(eq(auditLog.action, action));

describe('POST /api/admin/vendors/:id/hide', () => {
  it('hides the company and every joined product not already hidden, with child rows', async () => {
    const res = await hideVendor();
    expect(res.status).toBe(200);
    expect(() => AdminListingHideResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.product_ids.sort()).toEqual([P_REVIT, P_SHARED].sort());
    expect(res.body.hide).toMatchObject({ kind: 'lawful_order', internal_note: NOTE });

    const a = await vendor(VENDOR_A);
    expect(a.hiddenAt).toBe(res.body.hidden_at);
    expect(a.hiddenHideId).toBe(res.body.hide.id);

    // The shared product is hidden too, though Bentley is live (ruled 2026-11-09).
    for (const id of [P_REVIT, P_SHARED]) {
      const p = await product(id);
      expect(p.hiddenAt).toBe(a.hiddenAt);
      const child = await t.db.query.listingHides.findFirst({
        where: eq(listingHides.id, p.hiddenHideId!),
      });
      expect(child).toMatchObject({
        entityType: 'product',
        entityId: id,
        parentId: a.hiddenHideId,
        kind: 'lawful_order',
        reason: REASON,
      });
    }
    // AutoCAD keeps its own hide, and gets no child row.
    const acad = await product(P_ACAD);
    expect(acad).toMatchObject({ hiddenAt: ACAD_HIDDEN_AT, hiddenHideId: H_ACAD });
    const acadRows = await t.db
      .select()
      .from(listingHides)
      .where(eq(listingHides.entityId, P_ACAD));
    expect(acadRows).toHaveLength(1);
    // Bentley's own product is untouched, and nothing is deleted.
    expect((await product(P_MICRO)).hiddenAt).toBeNull();
    expect((await product(P_REVIT)).description).toBe('BIM authoring.');
  });

  it('recomputes the counterpart count in the batch', async () => {
    await hideVendor();
    // Both MicroStation edges touch a hidden product, so neither is live.
    expect((await product(P_MICRO)).integrationCount).toBe(0);
  });

  it('writes the audit rows and the notices, with the vendor reason and never the note in a notice', async () => {
    await hideVendor();
    const [vendorRow] = await audits('vendor.hidden');
    expect(vendorRow).toMatchObject({
      entityId: VENDOR_A,
      vendorId: VENDOR_A,
      actorId: ADMIN.userId,
    });
    expect(vendorRow!.metadata).toMatchObject({
      source: 'admin-moderation',
      kind: 'lawful_order',
      receivedAt: '2026-11-08',
      reason: REASON,
      reasonVisibility: 'vendor',
      internalNote: NOTE,
    });
    const productRows = await audits('product.hidden');
    expect(productRows.map((r) => r.entityId).sort()).toEqual([P_REVIT, P_SHARED].sort());

    const notices = await audits(NOTIFICATION_SENT_ACTION);
    const seen = notices.map((n) => {
      const meta = n.metadata as {
        vendorId: string;
        event: string;
        recordSubject: { type: string; slug: string };
      };
      return `${meta.vendorId}:${meta.event}:${meta.recordSubject.type}:${meta.recordSubject.slug}`;
    });
    // Autodesk about itself, and Bentley about the shared product it holds.
    expect(seen.sort()).toEqual(
      [
        `${VENDOR_A}:listing_hidden:vendor:autodesk`,
        `${VENDOR_B}:listing_hidden:product:shared`,
      ].sort(),
    );
    for (const n of notices) {
      expect(n.metadata).toMatchObject({ kind: 'aeci_override', reasonVisibility: 'vendor' });
      expect(JSON.stringify(n.metadata)).not.toContain(NOTE);
    }
  });

  it('queues the purge as a moderation write, with every page the hide changes', async () => {
    const { send } = await hideVendor();
    expect(send).toHaveBeenCalled();
    // The home-stats refresh runs inline with no STATS_QUEUE and purges `index:home`
    // under its own `promote` source. Every other message is the hide's.
    const ours = send.mock.calls
      .map((c) => c[0] as { tags: string[]; source: string })
      .filter((m) => m.source !== 'promote');
    expect(ours.length).toBeGreaterThan(0);
    for (const m of ours) expect(m.source).toBe('moderation');
    const tags = ours.flatMap((m) => m.tags);
    expect(tags).toEqual(
      expect.arrayContaining([
        'vendor:autodesk',
        'vendor:bentley',
        'product:revit',
        'product:shared',
        'product:microstation',
        'pair:microstation__revit',
        'pair:microstation__shared',
        'index:products',
        'index:home',
        'taxonomy',
      ]),
    );
  });

  it('chunks a large tag set at 1,000 per message, the sitemap tag in the first', () => {
    const tags = Array.from({ length: 2500 }, (_, i) => `product:p${i}`).concat('sitemap');
    const chunks = chunkTags(tags);
    expect(chunks.map((c) => c.length)).toEqual([LISTING_PURGE_TAG_CHUNK, 1000, 501]);
    expect(chunks[0]![0]).toBe('sitemap');
  });

  it('refuses a second hide, a bad body and an unknown id', async () => {
    await hideVendor();
    const again = await hideVendor();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('LISTING_HIDDEN');

    const noSource = await call(`/api/admin/vendors/${VENDOR_B}/hide`, {
      ...HIDE_BODY,
      kind: 'complaint_under_review',
    });
    expect(noSource.status).toBe(400);
    const future = await call(`/api/admin/vendors/${VENDOR_B}/hide`, {
      ...HIDE_BODY,
      receivedAt: '2099-01-01',
    });
    expect(future.status).toBe(400);
    const unknown = await hideVendor(uuid(999));
    expect(unknown.status).toBe(404);
    // Nothing moved on Bentley.
    expect((await vendor(VENDOR_B)).hiddenAt).toBeNull();
  });

  it('answers LISTING_CHANGED_WHILE_SAVING on a lost race and writes nothing', async () => {
    // A product of the company is hidden on its own between the read and the batch.
    const racing: DbFactory = (env, opts) => {
      const ctx = t.factory(env, opts);
      const db = new Proxy(ctx.db, {
        get(target, prop, receiver) {
          if (prop === 'batch') {
            return async (stmts: Parameters<typeof target.batch>[0]) => {
              t.raw
                .prepare(
                  `UPDATE products SET hidden_at = '2026-11-09T00:00:00.000Z', hidden_hide_id = 'x' WHERE id = ?`,
                )
                .run(P_REVIT);
              return target.batch(stmts);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return { ...ctx, db };
    };
    const res = await call(`/api/admin/vendors/${VENDOR_A}/hide`, HIDE_BODY, { factory: racing });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LISTING_CHANGED_WHILE_SAVING');
    expect((await vendor(VENDOR_A)).hiddenAt).toBeNull();
    expect(await audits('vendor.hidden')).toHaveLength(0);
    expect(await audits(NOTIFICATION_SENT_ACTION)).toHaveLength(0);
    expect(await t.db.select().from(listingHides)).toHaveLength(1);
  });
});

describe('POST /api/admin/vendors/:id/restore', () => {
  it('is lossless: it re-shows exactly the products its hide covered', async () => {
    const hide = await hideVendor();
    const res = await restoreVendor();
    expect(res.status).toBe(200);
    expect(res.body.product_ids.sort()).toEqual([P_REVIT, P_SHARED].sort());

    expect((await vendor(VENDOR_A)).hiddenAt).toBeNull();
    for (const id of [P_REVIT, P_SHARED]) {
      expect(await product(id)).toMatchObject({ hiddenAt: null, hiddenHideId: null });
    }
    // AutoCAD's own hide stands.
    expect(await product(P_ACAD)).toMatchObject({ hiddenAt: ACAD_HIDDEN_AT, hiddenHideId: H_ACAD });
    expect(
      (await t.db.query.listingHides.findFirst({ where: eq(listingHides.id, H_ACAD) }))!.restoredAt,
    ).toBeNull();
    // The log keeps every row, stamped.
    const rows = await t.db
      .select()
      .from(listingHides)
      .where(eq(listingHides.id, hide.body.hide.id));
    expect(rows[0]).toMatchObject({
      restoredBy: ADMIN.userId,
      restoreReason: 'The order was lifted.',
    });
    const children = await t.db
      .select()
      .from(listingHides)
      .where(eq(listingHides.parentId, hide.body.hide.id));
    expect(children.every((c) => c.restoredAt !== null)).toBe(true);
    // The count comes back, and the content never moved.
    expect((await product(P_MICRO)).integrationCount).toBe(2);
    expect((await product(P_REVIT)).description).toBe('BIM authoring.');
    expect((await audits('vendor.restored')).length).toBe(1);
    expect((await audits('product.restored')).map((r) => r.entityId).sort()).toEqual(
      [P_REVIT, P_SHARED].sort(),
    );
  });

  it('refuses a restore of a company on the public site', async () => {
    const res = await restoreVendor(VENDOR_B);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LISTING_NOT_HIDDEN');
  });

  it('keeps a shared product hidden under the other hidden company, then shows it with that one', async () => {
    await hideVendor(VENDOR_A);
    const bHide = await hideVendor(VENDOR_B);
    // Shared was already hidden by Autodesk: Bentley's hide covers only MicroStation.
    expect(bHide.body.product_ids).toEqual([P_MICRO]);

    await restoreVendor(VENDOR_A);
    expect((await product(P_REVIT)).hiddenAt).toBeNull();
    const shared = await product(P_SHARED);
    expect(shared.hiddenAt).not.toBeNull();
    const rehomed = await t.db.query.listingHides.findFirst({
      where: eq(listingHides.id, shared.hiddenHideId!),
    });
    expect(rehomed).toMatchObject({ parentId: bHide.body.hide.id, restoredAt: null });
    expect(await checkProductLiveUnderHiddenVendor(t.db)).toEqual({ lines: [] });

    await restoreVendor(VENDOR_B);
    expect(await product(P_SHARED)).toMatchObject({ hiddenAt: null, hiddenHideId: null });
    expect((await product(P_MICRO)).hiddenAt).toBeNull();
  });

  /** A factory whose first `batch` runs `before` first: a write landing between this
   *  request's read and its batch. */
  const racingFactory = (before: () => Promise<unknown>): DbFactory => {
    let fired = false;
    return (env, opts) => {
      const ctx = t.factory(env, opts);
      const db = new Proxy(ctx.db, {
        get(target, prop, receiver) {
          if (prop === 'batch') {
            return async (stmts: Parameters<typeof target.batch>[0]) => {
              if (!fired) {
                fired = true;
                await before();
              }
              return target.batch(stmts);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      return { ...ctx, db };
    };
  };
  const restoreWith = (id: string, factory: DbFactory) =>
    call(`/api/admin/vendors/${id}/restore`, { reason: 'The order was lifted.' }, { factory });

  it('aborts a restore whose re-home target was restored after the read', async () => {
    await hideVendor(VENDOR_A);
    await hideVendor(VENDOR_B);
    // Autodesk's restore reads Bentley as hidden and plans to re-home Shared under
    // Bentley's hide. Bentley is restored before Autodesk's batch runs.
    const res = await restoreWith(
      VENDOR_A,
      racingFactory(() => restoreVendor(VENDOR_B)),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LISTING_CHANGED_WHILE_SAVING');
    expect((await vendor(VENDOR_A)).hiddenAt).not.toBeNull();
    expect(await audits('vendor.restored')).toHaveLength(1);

    // The retry reads Bentley as visible, so Shared comes back with Revit.
    expect((await restoreVendor(VENDOR_A)).status).toBe(200);
    for (const id of [P_REVIT, P_SHARED]) {
      expect(await product(id)).toMatchObject({ hiddenAt: null, hiddenHideId: null });
    }
    expect(await checkProductLiveUnderHiddenVendor(t.db)).toEqual({ lines: [] });
  });

  it('aborts a restore whose hide gained a re-homed child after the read', async () => {
    await hideVendor(VENDOR_A);
    await hideVendor(VENDOR_B);
    // Bentley's restore reads one child (MicroStation). Autodesk's restore then
    // re-homes Shared under Bentley's hide before Bentley's batch runs.
    const res = await restoreWith(
      VENDOR_B,
      racingFactory(() => restoreVendor(VENDOR_A)),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LISTING_CHANGED_WHILE_SAVING');
    expect((await vendor(VENDOR_B)).hiddenAt).not.toBeNull();
    expect((await product(P_SHARED)).hiddenAt).not.toBeNull();

    // The retry reads both children and shows both.
    expect((await restoreVendor(VENDOR_B)).status).toBe(200);
    for (const id of [P_MICRO, P_SHARED]) {
      expect(await product(id)).toMatchObject({ hiddenAt: null, hiddenHideId: null });
    }
    expect(await checkProductLiveUnderHiddenVendor(t.db)).toEqual({ lines: [] });
  });

  it('aborts a restore when a co-owner of a child was hidden after the read', async () => {
    await hideVendor(VENDOR_A);
    // Autodesk's restore reads Bentley as visible and plans to show Shared. Bentley
    // is hidden before the batch, and its hide skipped Shared as already hidden.
    const res = await restoreWith(
      VENDOR_A,
      racingFactory(() => hideVendor(VENDOR_B)),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LISTING_CHANGED_WHILE_SAVING');
    expect((await product(P_SHARED)).hiddenAt).not.toBeNull();
    expect((await restoreVendor(VENDOR_A)).status).toBe(200);
    // The retry re-homes Shared under Bentley's hide.
    expect((await product(P_SHARED)).hiddenAt).not.toBeNull();
    expect(await checkProductLiveUnderHiddenVendor(t.db)).toEqual({ lines: [] });
  });
});

describe('POST /api/admin/products/:id/hide and restore', () => {
  it('hides and restores one product, and tells every claimed vendor of it', async () => {
    const res = await call(`/api/admin/products/${P_SHARED}/hide`, HIDE_BODY);
    expect(res.status).toBe(200);
    expect(res.body.product_ids).toEqual([]);
    expect((await product(P_SHARED)).hiddenAt).not.toBeNull();
    const notices = await audits(NOTIFICATION_SENT_ACTION);
    expect(notices.map((n) => n.vendorId).sort()).toEqual([VENDOR_A, VENDOR_B].sort());

    const restore = await call(`/api/admin/products/${P_SHARED}/restore`, { reason: 'Resolved.' });
    expect(restore.status).toBe(200);
    expect(await product(P_SHARED)).toMatchObject({ hiddenAt: null, hiddenHideId: null });
  });

  it('refuses a product restore while its company is hidden', async () => {
    await hideVendor();
    // A child of the company's hide.
    const child = await call(`/api/admin/products/${P_REVIT}/restore`, { reason: 'Resolved.' });
    expect(child.status).toBe(409);
    expect(child.body.error.code).toBe('LISTING_HIDDEN_WITH_VENDOR');
    // Its own hide, but joined to a hidden company.
    const own = await call(`/api/admin/products/${P_ACAD}/restore`, { reason: 'Resolved.' });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('LISTING_HIDDEN_WITH_VENDOR');
    // A product already hidden refuses a second hide.
    const again = await call(`/api/admin/products/${P_REVIT}/hide`, HIDE_BODY);
    expect(again.body.error.code).toBe('LISTING_HIDDEN');
  });

  it('restores a product hidden on its own once its company is visible', async () => {
    const res = await call(`/api/admin/products/${P_ACAD}/restore`, { reason: 'Resolved.' });
    expect(res.status).toBe(200);
    expect((await product(P_ACAD)).hiddenAt).toBeNull();
  });
});

describe('the reads of the hide state', () => {
  it('the admin vendor detail and products tab carry the hide, the note included', async () => {
    await hideVendor();
    const detail = await call(`/api/admin/vendors/${VENDOR_A}`, undefined, { method: 'GET' });
    expect(detail.status).toBe(200);
    expect(() => AdminVendorDetailSchema.parse(detail.body)).not.toThrow();
    expect(detail.body.listing_hide).toMatchObject({ kind: 'lawful_order', internal_note: NOTE });
    expect(
      detail.body.listing_hide_products.map((p: JsonBody) => `${p.name}:${p.hidden_with_vendor}`),
    ).toEqual(['AutoCAD:false', 'Revit:true', 'Shared:true']);

    const tab = await call(`/api/admin/vendors/${VENDOR_A}/products`, undefined, {
      method: 'GET',
    });
    const revit = tab.body.data.find((r: JsonBody) => r.id === P_REVIT);
    expect(revit.listing_hide.parent_id).toBe(detail.body.listing_hide.id);
  });

  it('the portal sees when, the kind and the reason, never the internal note', async () => {
    await hideVendor();
    const me = await call('/api/vendor/me', undefined, { auth: SEAT_A, method: 'GET' });
    expect(me.status).toBe(200);
    expect(() => VendorMeResponseSchema.parse(me.body)).not.toThrow();
    expect(me.body.vendor.hidden).toMatchObject({ kind: 'lawful_order', reason: REASON });
    expect(JSON.stringify(me.body)).not.toContain(NOTE);
    const revit = me.body.products.find((p: JsonBody) => p.id === P_REVIT);
    expect(revit.hidden).toMatchObject({ kind: 'lawful_order', reason: REASON });
  });
});

describe('product_live_under_hidden_vendor (data quality)', () => {
  it('is clean after a hide, and flags a product a race left on the public site', async () => {
    await hideVendor();
    expect(await checkProductLiveUnderHiddenVendor(t.db)).toEqual({ lines: [] });
    await t.db
      .update(products)
      .set({ hiddenAt: null, hiddenHideId: null })
      .where(and(eq(products.id, P_REVIT)));
    const finding = await checkProductLiveUnderHiddenVendor(t.db);
    expect(finding.lines).toEqual(['Revit (revit) under hidden vendor autodesk']);
    // A clean seed has no hidden vendor at all.
    const fresh = await makeTestDb();
    expect(await checkProductLiveUnderHiddenVendor(fresh.db)).toEqual({ lines: [] });
    fresh.dispose();
    expect(await t.db.select().from(vendors).where(isNull(vendors.hiddenAt))).toHaveLength(1);
  });

  it('flags a product left hidden by a child row whose company hide was restored', async () => {
    await hideVendor(VENDOR_A);
    const bHide = await hideVendor(VENDOR_B);
    await restoreVendor(VENDOR_A);
    expect(await checkProductLiveUnderHiddenVendor(t.db)).toEqual({ lines: [] });
    // Bentley comes back by hand, without its child rows: the state a lost race
    // with no sentinel would have left.
    t.raw
      .prepare(`UPDATE listing_hides SET restored_at = '2026-11-10T00:00:00.000Z' WHERE id = ?`)
      .run(bHide.body.hide.id);
    t.raw
      .prepare(`UPDATE vendors SET hidden_at = NULL, hidden_hide_id = NULL WHERE id = ?`)
      .run(VENDOR_B);
    const finding = await checkProductLiveUnderHiddenVendor(t.db);
    expect(finding.lines).toEqual([
      'MicroStation (microstation) still hidden by a restored hide',
      'Shared (shared) still hidden by a restored hide',
    ]);
  });
});
