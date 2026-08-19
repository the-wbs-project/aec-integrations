/**
 * `GET /api/vendor/notifications` (AECI-302 / `STAGE_2_ATTESTATIONS_SPEC.md` §7.2).
 *
 * The endpoint reads the §7.3 `audit_log` ledger, so every fixture here is a
 * `notification.sent` row written the way the sweep writes one. Per the repo
 * split, this spec stubs `c.set('auth', …)` and exercises the handler; the real
 * `requireVendor()` guard cells live in `vendor.authz-matrix.spec.ts`.
 *
 * The load-bearing assertions are the isolation ones: a vendor sees only its own
 * rows, and an ops row (`metadata.vendorId = null`) is invisible to everyone.
 */

import { ListVendorNotificationsResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  NOTIFICATION_HISTORY_DAYS,
  NOTIFICATION_PAGE_SIZE,
  createListVendorNotificationsHandler,
} from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const SEAT = uuid(100);
const CLAIM = uuid(30);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

let t: TestDb;

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'ops@autodesk.test',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'autodesk', companyName: 'Autodesk' },
    { id: OTHER_VENDOR, slug: 'bentley', companyName: 'Bentley' },
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth'] = AUTH) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
  return a;
}

async function get(auth?: AuthzVariables['auth']) {
  const res = await app(auth).request(
    '/api/vendor/notifications',
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { res, body: (await res.json()) as Record<string, unknown> };
}

/** Write a ledger row exactly as `lib/attestation-notify.ts` does. */
async function ledgerRow(
  over: {
    vendorId?: string | null;
    detector?: string;
    claimId?: string;
    createdAt?: string;
    metadata?: unknown;
  } = {},
) {
  await t.db.insert(auditLog).values({
    id: crypto.randomUUID(),
    actorType: 'system',
    action: NOTIFICATION_SENT_ACTION,
    entityType: 'claim',
    entityId: over.claimId ?? CLAIM,
    metadata:
      over.metadata !== undefined
        ? over.metadata
        : {
            detector: over.detector ?? 'silent-counterparty',
            vendorId: over.vendorId === undefined ? VENDOR : over.vendorId,
            integrationId: uuid(10),
            dataObject: { slug: 'rfis', name: 'RFIs' },
            counterpartProduct: { slug: 'procore', name: 'Procore' },
            pairSlugs: ['revit', 'procore'],
          },
    ...(over.createdAt ? { createdAt: over.createdAt } : {}),
  });
}

describe('GET /api/vendor/notifications', () => {
  it('returns an empty list when the sweep has never nudged this vendor', async () => {
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body).toEqual({ notifications: [] });
    expect(() => ListVendorNotificationsResponseSchema.parse(body)).not.toThrow();
  });

  it('returns the vendor’s own notifications, newest first', async () => {
    await ledgerRow({ claimId: uuid(31), createdAt: daysAgo(5) });
    await ledgerRow({ claimId: uuid(32), createdAt: daysAgo(1) });

    const { body } = await get();
    const list = body.notifications as Array<Record<string, unknown>>;
    expect(list.map((n) => n.claim_id)).toEqual([uuid(32), uuid(31)]);
    expect(() => ListVendorNotificationsResponseSchema.parse(body)).not.toThrow();
  });

  it('rebuilds the canonical pair path from the stored slugs', async () => {
    await ledgerRow();

    const { body } = await get();
    const [row] = body.notifications as Array<Record<string, unknown>>;
    // `pairSlugs` was stored source-first (revit, procore); the path is
    // alphabetical, so `procore` is the context.
    expect(row.pair_path).toBe('/products/procore/integrations/revit');
    expect(row.detector).toBe('silent-counterparty');
    expect(row.data_object).toEqual({ slug: 'rfis', name: 'RFIs' });
    expect(row.counterpart_product).toEqual({ slug: 'procore', name: 'Procore' });
  });

  it('never shows another vendor’s notifications', async () => {
    await ledgerRow({ vendorId: OTHER_VENDOR });

    const { body } = await get();
    expect(body.notifications).toEqual([]);
  });

  it('never shows an AECi ops row (vendorId null) to any vendor', async () => {
    await ledgerRow({ vendorId: null, detector: 'aeci-denied' });
    await ledgerRow({ vendorId: null, detector: 'open-conflict', claimId: uuid(33) });

    expect((await get()).body.notifications).toEqual([]);
    expect((await get({ ...AUTH, vendorId: OTHER_VENDOR })).body.notifications).toEqual([]);
  });

  it('ignores audit rows that are not notifications', async () => {
    await t.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorType: 'user',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR,
      metadata: { source: 'vendor-portal', vendorId: VENDOR },
    });

    expect((await get()).body.notifications).toEqual([]);
  });

  it('drops rows older than the history window', async () => {
    await ledgerRow({ createdAt: daysAgo(NOTIFICATION_HISTORY_DAYS + 1) });
    await ledgerRow({ claimId: uuid(34), createdAt: daysAgo(2) });

    const list = (await get()).body.notifications as Array<Record<string, unknown>>;
    expect(list.map((n) => n.claim_id)).toEqual([uuid(34)]);
  });

  it('caps the page size', async () => {
    for (let i = 0; i < NOTIFICATION_PAGE_SIZE + 3; i++) {
      await ledgerRow({ claimId: uuid(400 + i) });
    }

    const list = (await get()).body.notifications as unknown[];
    expect(list).toHaveLength(NOTIFICATION_PAGE_SIZE);
  });

  it('skips a row whose snapshot it cannot read, rather than 500ing the tab', async () => {
    // A future detector id, or a shape from a later schema — these rows outlive
    // the code that wrote them, so an unreadable one must degrade quietly.
    await ledgerRow({ metadata: { detector: 'quantum-grain', vendorId: VENDOR } });
    await ledgerRow({ claimId: uuid(35) });

    const list = (await get()).body.notifications as Array<Record<string, unknown>>;
    expect(list.map((n) => n.claim_id)).toEqual([uuid(35)]);
  });
});
