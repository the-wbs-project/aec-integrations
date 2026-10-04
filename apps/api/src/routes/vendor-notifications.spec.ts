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
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import { claimAddedNotificationAudit } from '../lib/claim-added-notification';
import {
  reviewApprovedNotifications,
  reviewResponseDecisionNotification,
} from '../lib/review-notifications';
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
    await ledgerRow({ vendorId: null, detector: 'claim-denied' });
    await ledgerRow({ vendorId: null, detector: 'open-conflict', claimId: uuid(33) });

    expect((await get()).body.notifications).toEqual([]);
    expect((await get({ ...AUTH, vendorId: OTHER_VENDOR })).body.notifications).toEqual([]);
  });

  it('reads the recipient from the vendor_id column on new rows (AECI-1192)', async () => {
    // A row whose metadata carries no `vendorId` at all: only the column can match.
    await t.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorType: 'system',
      action: NOTIFICATION_SENT_ACTION,
      entityType: 'claim',
      entityId: CLAIM,
      vendorId: VENDOR,
      metadata: {
        detector: 'silent-counterparty',
        integrationId: uuid(10),
        dataObject: { slug: 'rfis', name: 'RFIs' },
        counterpartProduct: { slug: 'procore', name: 'Procore' },
        pairSlugs: ['revit', 'procore'],
      },
    });
    expect((await get()).body.notifications).toHaveLength(1);
    expect((await get({ ...AUTH, vendorId: OTHER_VENDOR })).body.notifications).toEqual([]);
  });

  it('ignores a vendor-actor row even when its vendor_id column matches', async () => {
    await t.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorType: 'user',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR,
      vendorId: VENDOR,
      metadata: { source: 'vendor-portal', vendorId: VENDOR },
    });
    expect((await get()).body.notifications).toEqual([]);
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

describe('GET /api/vendor/notifications — claim_added rows (AECI-1153 / §7.6)', () => {
  const claimAdded = (vendorId: string, extra: Record<string, unknown> = {}) =>
    ledgerRow({
      metadata: claimAddedNotificationAudit(
        'portal-claim-added',
        { actorId: null, actorType: 'user' },
        {
          vendorId,
          addedByVendorId: OTHER_VENDOR,
          addedByName: 'Bentley',
          integrationId: uuid(10),
          integrationName: 'Revit to MicroStation',
          claimId: CLAIM,
          dataObject: { slug: 'rfis', name: 'RFIs' },
          direction: 'inbound',
          counterpartProduct: { slug: 'microstation', name: 'MicroStation' },
          pairSlugs: ['revit', 'microstation'],
          ...extra,
        },
      ).metadata,
    });

  it('maps the ledger row to the claim_added member', async () => {
    await claimAdded(VENDOR);
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(() => ListVendorNotificationsResponseSchema.parse(body)).not.toThrow();
    const [row] = body.notifications as Record<string, unknown>[];
    expect(row).toEqual({
      kind: 'claim_added',
      id: expect.any(String),
      claim_id: CLAIM,
      integration_id: uuid(10),
      integration_name: 'Revit to MicroStation',
      data_object: { slug: 'rfis', name: 'RFIs' },
      direction: 'inbound',
      added_by_name: 'Bentley',
      counterpart_product: { slug: 'microstation', name: 'MicroStation' },
      pair_path: '/products/microstation/integrations/revit',
      created_at: expect.any(String),
    });
  });

  it('is isolated to its recipient', async () => {
    await claimAdded(OTHER_VENDOR);
    const { body } = await get();
    expect(body.notifications).toEqual([]);
  });

  it('never carries a note, even if one were in the ledger metadata', async () => {
    await claimAdded(VENDOR, { note: 'private reason' });
    const { body } = await get();
    expect(JSON.stringify(body)).not.toContain('private reason');
  });

  it('skips a claim_added row it cannot read, rather than 500ing the tab', async () => {
    await ledgerRow({ metadata: { kind: 'claim_added', vendorId: VENDOR, direction: 'sideways' } });
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body.notifications).toEqual([]);
  });
});

describe('GET /api/vendor/notifications — review rows (AECI-1180 / §11c.12)', () => {
  const PRODUCT = { id: uuid(40), slug: 'revit', name: 'Revit' };
  const ADMIN_ACTOR = { actorId: null, actorType: 'admin' as const };

  it('maps a review row and a review_response row, and validates the union', async () => {
    const [review] = reviewApprovedNotifications(
      'portal-review',
      ADMIN_ACTOR,
      [{ vendorId: VENDOR, vendorSlug: 'autodesk' }],
      { id: uuid(41), title: 'Solid', product: PRODUCT },
    );
    await ledgerRow({ metadata: review!.metadata, createdAt: daysAgo(2) });
    const decision = reviewResponseDecisionNotification('portal-review-response', ADMIN_ACTOR, {
      responseId: uuid(42),
      decision: 'approve',
      vendorId: VENDOR,
      reviewId: uuid(41),
      product: PRODUCT,
      reason: null,
    });
    await ledgerRow({ metadata: decision.metadata, createdAt: daysAgo(1) });

    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(() => ListVendorNotificationsResponseSchema.parse(body)).not.toThrow();
    expect(body.notifications).toEqual([
      {
        kind: 'review_response',
        id: expect.any(String),
        event: 'approved',
        response_id: uuid(42),
        review_id: uuid(41),
        product: { slug: 'revit', name: 'Revit' },
        reason: null,
        created_at: expect.any(String),
      },
      {
        kind: 'review',
        id: expect.any(String),
        review_id: uuid(41),
        product: { slug: 'revit', name: 'Revit' },
        review_title: 'Solid',
        created_at: expect.any(String),
      },
    ]);
  });

  it('is isolated to its recipient', async () => {
    const [review] = reviewApprovedNotifications(
      'portal-review',
      ADMIN_ACTOR,
      [{ vendorId: OTHER_VENDOR, vendorSlug: 'bentley' }],
      { id: uuid(41), title: 'Solid', product: PRODUCT },
    );
    await ledgerRow({ metadata: review!.metadata });
    expect((await get()).body.notifications).toEqual([]);
  });

  it('skips review rows it cannot read, rather than 500ing the tab', async () => {
    await ledgerRow({ metadata: { kind: 'review', vendorId: VENDOR, reviewId: uuid(41) } });
    await ledgerRow({
      metadata: {
        kind: 'review_response',
        vendorId: VENDOR,
        event: 'withdrawn',
        responseId: uuid(42),
        reviewId: uuid(41),
        product: { slug: 'revit', name: 'Revit' },
      },
    });
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body.notifications).toEqual([]);
  });
});

describe('GET /api/vendor/notifications — AECi override rows (AECI-1159 / §11d)', () => {
  const ADMIN_ACTOR = { actorId: null, actorType: 'admin' as const };
  const REASON = 'The logo belonged to a different company.';

  it('maps the three override events with the reason, and validates the union', async () => {
    const field = aeciOverrideNotificationAudit('portal-field-overridden-by-aeci', ADMIN_ACTOR, {
      event: 'field_overridden',
      vendorId: VENDOR,
      reason: REASON,
      integrationId: uuid(50),
      integrationName: 'Revit for Procore',
      field: 'name',
      pairSlugs: ['revit', 'procore'],
      entityType: 'integration',
    });
    const logo = aeciOverrideNotificationAudit('portal-logo-overridden-by-aeci', ADMIN_ACTOR, {
      event: 'logo_overridden',
      vendorId: VENDOR,
      reason: REASON,
      entityId: uuid(51),
      logoSubject: { type: 'product', slug: 'revit', name: 'Revit' },
    });
    const seat = aeciOverrideNotificationAudit('portal-seat-revoked-by-aeci', ADMIN_ACTOR, {
      event: 'seat_revoked',
      vendorId: VENDOR,
      reason: REASON,
      seatUserId: uuid(52),
      seatName: 'Pat Example',
    });
    await ledgerRow({ metadata: field.metadata, createdAt: daysAgo(3) });
    await ledgerRow({ metadata: logo.metadata, createdAt: daysAgo(2) });
    await ledgerRow({ metadata: seat.metadata, createdAt: daysAgo(1) });

    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(() => ListVendorNotificationsResponseSchema.parse(body)).not.toThrow();
    const common = {
      kind: 'aeci_override',
      id: expect.any(String),
      reason: REASON,
      integration_id: null,
      integration_name: null,
      field: null,
      pair_path: null,
      logo_subject: null,
      seat_name: null,
      created_at: expect.any(String),
    };
    expect(body.notifications).toEqual([
      { ...common, event: 'seat_revoked', seat_name: 'Pat Example' },
      {
        ...common,
        event: 'logo_overridden',
        logo_subject: { type: 'product', slug: 'revit', name: 'Revit' },
      },
      {
        ...common,
        event: 'field_overridden',
        integration_id: uuid(50),
        integration_name: 'Revit for Procore',
        field: 'name',
        pair_path: '/products/procore/integrations/revit',
      },
    ]);
  });

  it('drops an override row without the vendor-visibility marker, and never reads an internal note', async () => {
    await ledgerRow({
      metadata: {
        kind: 'aeci_override',
        event: 'seat_revoked',
        vendorId: VENDOR,
        reason: 'Written for AECi only.',
      },
    });
    await ledgerRow({
      metadata: {
        kind: 'aeci_override',
        event: 'seat_revoked',
        vendorId: VENDOR,
        reason: REASON,
        reasonVisibility: 'vendor',
        internalNote: 'Never shown.',
      },
    });
    const { body } = await get();
    expect(body.notifications).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('Written for AECi only.');
    expect(JSON.stringify(body)).not.toContain('Never shown.');
  });

  it('is isolated to its recipient', async () => {
    const seat = aeciOverrideNotificationAudit('portal-seat-revoked-by-aeci', ADMIN_ACTOR, {
      event: 'seat_revoked',
      vendorId: OTHER_VENDOR,
      reason: REASON,
      seatUserId: uuid(52),
      seatName: null,
    });
    await ledgerRow({ metadata: seat.metadata });
    expect((await get()).body.notifications).toEqual([]);
  });
});
