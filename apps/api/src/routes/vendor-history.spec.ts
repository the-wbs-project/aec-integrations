/**
 * `GET /api/vendor/history` and `GET /api/vendor/history.csv` (AECI-1194).
 *
 * This spec stubs `c.set('auth', …)` and drives the handlers over the in-memory
 * D1. The real `requireVendor()` guard cells live in `vendor.authz-matrix.spec.ts`,
 * and the "no rate limit" cell in `vendor-history.registration.spec.ts`.
 *
 * The load-bearing cells are the scoping ones. The predicate is `vendor_id`
 * alone, so a co-owned product and an ownership move are both answered by the
 * row's own stamp, never by who owns the entity now.
 */

import {
  ListVendorHistoryResponseSchema,
  VENDOR_HISTORY_CSV_COLUMNS,
  VENDOR_HISTORY_CSV_MAX_ROWS,
  type VendorHistoryItem,
} from '@aeci/shared';
import { count } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, integrations, productVendors, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createListVendorHistoryHandler, createVendorHistoryCsvHandler } from './vendor-history';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const SHARED_PRODUCT = uuid(10);
const INTEGRATION = uuid(20);
const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const ADMIN = uuid(200);

const authFor = (vendorId: string, userId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId}@vendor.test`,
  role: 'vendor_admin',
  vendorId,
  // The Free plan: the read must not depend on any capability.
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const AUTH_A = authFor(VENDOR_A, SEAT_A);
const AUTH_B = authFor(VENDOR_B, SEAT_B);

let t: TestDb;

type AuditRow = typeof auditLog.$inferInsert;
const audit = (n: number, day: string, row: Omit<AuditRow, 'id' | 'createdAt'>): AuditRow => ({
  id: uuid(1000 + n),
  createdAt: `${day}T12:00:00.000Z`,
  ...row,
});

/** The fixture ledger. Ids end in the row number; days increase with it. */
const ROWS: AuditRow[] = [
  // 1. Vendor A's seat edits the co-owned product.
  audit(1, '2026-10-01', {
    actorId: SEAT_A,
    actorType: 'user',
    action: 'product.updated',
    entityType: 'product',
    entityId: SHARED_PRODUCT,
    afterState: { description: 'A edit' },
    metadata: { source: 'vendor-portal' },
    vendorId: VENDOR_A,
    vendorTier: 'unclaimed',
    vendorEntitlementStatus: 'none',
  }),
  // 2. Vendor B's seat edits the SAME co-owned product.
  audit(2, '2026-10-02', {
    actorId: SEAT_B,
    actorType: 'user',
    action: 'product.updated',
    entityType: 'product',
    entityId: SHARED_PRODUCT,
    afterState: { website: 'https://b.test' },
    metadata: { source: 'vendor-portal' },
    vendorId: VENDOR_B,
  }),
  // 3. AECi overrides the product, stamped with vendor A (the holder).
  audit(3, '2026-10-03', {
    actorId: ADMIN,
    actorType: 'admin',
    action: 'vendor_entitlement.set',
    entityType: 'vendor_entitlement',
    entityId: VENDOR_A,
    afterState: { tier: 'verified', status: 'active' },
    metadata: {
      reason: 'Pilot seat, as agreed.',
      reasonVisibility: 'vendor',
      internalNote: 'Comped by Chris; do not mention price.',
      actorEmail: 'ops@aecintegrations.com',
    },
    vendorId: VENDOR_A,
    vendorTier: 'unclaimed',
    vendorEntitlementStatus: 'none',
  }),
  // 4. Vendor B edits its company profile.
  audit(4, '2026-10-04', {
    actorId: SEAT_B,
    actorType: 'user',
    action: 'vendor.updated',
    entityType: 'vendor',
    entityId: VENDOR_B,
    afterState: { description: 'B' },
    vendorId: VENDOR_B,
  }),
  // 5. A notification addressed to A. Not a receipt.
  audit(5, '2026-10-05', {
    actorType: 'system',
    action: 'notification.sent',
    entityType: 'claim',
    entityId: uuid(30),
    metadata: { vendorId: VENDOR_A },
    vendorId: VENDOR_A,
  }),
  // 6. A legacy row from before AECI-1192: no vendor_id. Never shown.
  audit(6, '2026-10-06', {
    actorId: SEAT_A,
    actorType: 'user',
    action: 'product.updated',
    entityType: 'product',
    entityId: SHARED_PRODUCT,
    metadata: { source: 'vendor-portal', vendorId: VENDOR_A },
  }),
  // 7. Vendor A retired the integration. Ownership moves to B after this row.
  audit(7, '2026-10-07', {
    actorId: SEAT_A,
    actorType: 'user',
    action: 'integration.retired',
    entityType: 'integration',
    entityId: INTEGRATION,
    afterState: { retired_at: '2026-10-07' },
    vendorId: VENDOR_A,
  }),
  // 8. The expiry sweep warned A.
  audit(8, '2026-10-08', {
    actorType: 'system',
    action: 'vendor_entitlement.expiry_warned',
    entityType: 'vendor_entitlement',
    entityId: VENDOR_A,
    vendorId: VENDOR_A,
  }),
];

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: SHARED_PRODUCT, slug: 'shared', name: 'Shared Product' },
    { id: uuid(11), slug: 'other', name: 'Other Product' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: SHARED_PRODUCT, vendorId: VENDOR_A, isPrimary: true },
    { productId: SHARED_PRODUCT, vendorId: VENDOR_B, isPrimary: false },
  ]);
  // The integration is now B's: ownership moved after row 7.
  await t.db.insert(integrations).values({
    id: INTEGRATION,
    sourceProductId: SHARED_PRODUCT,
    targetProductId: uuid(11),
    name: 'Shared to Other',
    builtByVendorId: VENDOR_B,
  });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: ADMIN, role: 'admin' },
  ]);
  await t.db.insert(auditLog).values(ROWS);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/history', createListVendorHistoryHandler(t.factory));
  a.get(
    '/api/vendor/history.csv',
    createVendorHistoryCsvHandler(t.factory, () => new Date('2026-10-09T08:00:00.000Z')),
  );
  return a;
}

async function getJson(auth: AuthzVariables['auth'], query = '') {
  const res = await app(auth).request(
    `/api/vendor/history${query}`,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function getCsv(auth: AuthzVariables['auth'], query = '') {
  const res = await app(auth).request(
    `/api/vendor/history.csv${query}`,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { res, text: await res.text() };
}

const ids = (items: VendorHistoryItem[]) => items.map((i) => i.id);

describe('GET /api/vendor/history — scoping', () => {
  it('returns only rows stamped with the caller’s vendor, newest first', async () => {
    const a = await getJson(AUTH_A);
    expect(a.status).toBe(200);
    expect(ListVendorHistoryResponseSchema.parse(a.body)).toEqual(a.body);
    expect(ids(a.body.data)).toEqual([uuid(1008), uuid(1007), uuid(1003), uuid(1001)]);
    expect(a.body.total).toBe(4);

    const b = await getJson(AUTH_B);
    expect(ids(b.body.data)).toEqual([uuid(1004), uuid(1002)]);
  });

  it('a co-owned product: each owner sees only its own rows about it', async () => {
    const onShared = (items: VendorHistoryItem[]) =>
      items.filter((i) => i.entity_id === SHARED_PRODUCT).map((i) => i.id);
    expect(onShared((await getJson(AUTH_A)).body.data)).toEqual([uuid(1001)]);
    expect(onShared((await getJson(AUTH_B)).body.data)).toEqual([uuid(1002)]);
  });

  it('ownership moved after the row: the row stays with the vendor it named', async () => {
    const a = (await getJson(AUTH_A)).body.data as VendorHistoryItem[];
    const b = (await getJson(AUTH_B)).body.data as VendorHistoryItem[];
    expect(a.find((i) => i.entity_id === INTEGRATION)?.id).toBe(uuid(1007));
    expect(b.some((i) => i.entity_id === INTEGRATION)).toBe(false);
  });

  it('never shows a notification ledger row or a legacy row with no vendor_id', async () => {
    const a = ids((await getJson(AUTH_A)).body.data);
    expect(a).not.toContain(uuid(1005));
    expect(a).not.toContain(uuid(1006));
  });
});

describe('GET /api/vendor/history — projection', () => {
  it('projects actor kind, current names, field names and the plan', async () => {
    const [warned, retired, override, edit] = (await getJson(AUTH_A)).body
      .data as VendorHistoryItem[];
    expect(warned).toMatchObject({ actor_kind: 'system', entity_name: 'Autodesk', plan: null });
    expect(retired).toMatchObject({
      actor_kind: 'your_team',
      entity_name: 'Shared to Other',
      fields: ['retired_at'],
    });
    expect(override).toMatchObject({
      actor_kind: 'aeci',
      action: 'vendor_entitlement.set',
      entity_name: 'Autodesk',
      fields: ['tier', 'status'],
      plan: { tier: 'unclaimed', status: 'none' },
      reason: 'Pilot seat, as agreed.',
    });
    expect(edit).toMatchObject({
      actor_kind: 'your_team',
      entity_name: 'Shared Product',
      fields: ['description'],
      at: '2026-10-01T12:00:00.000Z',
    });
  });

  it('never returns the internal note, an email, an actor id or a value', async () => {
    const wire = JSON.stringify((await getJson(AUTH_A)).body);
    expect(wire).not.toContain('Comped');
    expect(wire).not.toContain('internalNote');
    expect(wire).not.toContain('@');
    expect(wire).not.toContain(SEAT_A);
    expect(wire).not.toContain(ADMIN);
    expect(wire).not.toContain('A edit');
  });

  it('a failed name lookup degrades to null and warns with the entity type', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      t.raw.exec('ALTER TABLE integrations RENAME TO integrations_gone');
      const retired = ((await getJson(AUTH_A)).body.data as VendorHistoryItem[]).find(
        (i) => i.id === uuid(1007),
      );
      expect(retired?.entity_name).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        '[vendor-history] entity name lookup failed',
        expect.objectContaining({ entityType: 'integration', error: expect.any(String) }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('reduces odd after_state and metadata in SQL without failing the read', async () => {
    const insert = t.raw.prepare(
      `INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, vendor_id,
         after_state, metadata, created_at)
       VALUES (?, 'admin', 'vendor.updated', 'vendor', ?, ?, ?, ?, ?)`,
    );
    const cases: [number, string | null, string | null][] = [
      [30, '{not json', '{"reason":"Hidden","reasonVisibility":"vendor"'],
      [31, '["a","b"]', '["reasonVisibility"]'],
      [32, '7', '"vendor"'],
      [33, JSON.stringify(JSON.stringify({ name: 'x' })), null],
      [
        34,
        JSON.stringify({ 'someone@example.com': 1, status: 'a' }),
        JSON.stringify({ reasonVisibility: 'vendor', reason: { nested: 'object' } }),
      ],
      [
        35,
        JSON.stringify({ logo_url: 'secret value' }),
        JSON.stringify({ reasonVisibility: 'vendor', reason: 'Shown', internalNote: 'x' }),
      ],
    ];
    for (const [n, after, meta] of cases) {
      insert.run(
        uuid(1000 + n),
        VENDOR_A,
        VENDOR_A,
        after,
        meta,
        `2026-11-${n - 29}T00:00:00.000Z`,
      );
    }
    const r = await getJson(AUTH_A, '?from=2026-11-01');
    expect(r.status).toBe(200);
    const byId = new Map((r.body.data as VendorHistoryItem[]).map((i) => [i.id, i]));
    expect(byId.get(uuid(1030))).toMatchObject({ fields: [] });
    expect('reason' in byId.get(uuid(1030))!).toBe(false);
    expect(byId.get(uuid(1031))).toMatchObject({ fields: [] });
    expect(byId.get(uuid(1032))).toMatchObject({ fields: [] });
    expect(byId.get(uuid(1033))).toMatchObject({ fields: ['name'] });
    expect(byId.get(uuid(1034))).toMatchObject({ fields: ['status'] });
    expect('reason' in byId.get(uuid(1034))!).toBe(false);
    expect(byId.get(uuid(1035))).toMatchObject({ fields: ['logo_url'], reason: 'Shown' });
    expect(JSON.stringify(r.body)).not.toContain('secret value');

    const { res } = await getCsv(AUTH_A, '?from=2026-11-01');
    expect(res.status).toBe(200);
  });

  it('reads the entity name now, not at write time', async () => {
    await t.raw
      .prepare('UPDATE products SET name = ? WHERE id = ?')
      .run('Renamed Product', SHARED_PRODUCT);
    const edit = ((await getJson(AUTH_A)).body.data as VendorHistoryItem[]).find(
      (i) => i.id === uuid(1001),
    );
    expect(edit?.entity_name).toBe('Renamed Product');
  });
});

describe('GET /api/vendor/history — filters and pages', () => {
  it('kind selects by who acted: aeci keeps admin rows, vendor keeps seat rows', async () => {
    expect(ids((await getJson(AUTH_A, '?kind=aeci')).body.data)).toEqual([uuid(1003)]);
    expect(ids((await getJson(AUTH_A, '?kind=vendor')).body.data)).toEqual([
      uuid(1007),
      uuid(1001),
    ]);
  });

  describe('an AECi admin product.updated (a logo overwrite)', () => {
    beforeEach(async () => {
      await t.db.insert(auditLog).values(
        audit(9, '2026-10-09', {
          actorId: ADMIN,
          actorType: 'admin',
          action: 'product.updated',
          entityType: 'product',
          entityId: SHARED_PRODUCT,
          afterState: { logo_url: 'https://cdn.test/new.png' },
          metadata: { source: 'admin-logo-override' },
          vendorId: VENDOR_A,
        }),
      );
    });

    it('JSON: shows under aeci and all, not vendor; the seat edit under vendor only', async () => {
      const aeci = ids((await getJson(AUTH_A, '?kind=aeci')).body.data);
      const vendor = ids((await getJson(AUTH_A, '?kind=vendor')).body.data);
      const all = ids((await getJson(AUTH_A, '?kind=all')).body.data);
      expect(aeci).toEqual([uuid(1009), uuid(1003)]);
      expect(vendor).not.toContain(uuid(1009));
      expect(all).toContain(uuid(1009));
      expect(vendor).toContain(uuid(1001));
      expect(aeci).not.toContain(uuid(1001));
      for (const item of (await getJson(AUTH_A, '?kind=aeci')).body.data as VendorHistoryItem[]) {
        expect(item.actor_kind).toBe('aeci');
      }
      for (const item of (await getJson(AUTH_A, '?kind=vendor')).body.data as VendorHistoryItem[]) {
        expect(item.actor_kind).toBe('your_team');
      }
    });

    it('CSV: shows under aeci, not vendor; the seat edit under vendor only', async () => {
      const csvIds = async (query: string) => {
        const [, ...rows] = parseCsv((await getCsv(AUTH_A, query)).text);
        return rows.map((r) => r[0]);
      };
      const aeci = await csvIds('?kind=aeci');
      const vendor = await csvIds('?kind=vendor');
      expect(aeci).toEqual([uuid(1009), uuid(1003)]);
      expect(vendor).toEqual([uuid(1007), uuid(1001)]);
    });
  });

  it('system rows show under all only', async () => {
    const all = ids((await getJson(AUTH_A)).body.data);
    expect(all).toContain(uuid(1008));
    expect(ids((await getJson(AUTH_A, '?kind=vendor')).body.data)).not.toContain(uuid(1008));
    expect(ids((await getJson(AUTH_A, '?kind=aeci')).body.data)).not.toContain(uuid(1008));
  });

  it('from and to are inclusive UTC days', async () => {
    const r = await getJson(AUTH_A, '?from=2026-10-03&to=2026-10-07');
    expect(ids(r.body.data)).toEqual([uuid(1007), uuid(1003)]);
    expect(r.body.total).toBe(2);
  });

  it('pages with page/perPage and reports the full total', async () => {
    const r = await getJson(AUTH_A, '?page=2&perPage=3');
    expect(r.body).toMatchObject({ page: 2, perPage: 3, total: 4 });
    expect(ids(r.body.data)).toEqual([uuid(1001)]);
  });

  it('breaks a created_at tie by id DESC', async () => {
    await t.db.insert(auditLog).values([
      audit(20, '2026-10-10', {
        actorType: 'user',
        action: 'vendor.updated',
        entityType: 'vendor',
        entityId: VENDOR_A,
        vendorId: VENDOR_A,
      }),
      audit(21, '2026-10-10', {
        actorType: 'user',
        action: 'vendor.updated',
        entityType: 'vendor',
        entityId: VENDOR_A,
        vendorId: VENDOR_A,
      }),
    ]);
    expect(ids((await getJson(AUTH_A, '?perPage=2')).body.data)).toEqual([uuid(1021), uuid(1020)]);
  });

  it.each([
    '?kind=everything',
    '?from=2026-10-09&to=2026-10-01',
    '?from=yesterday',
    '?perPage=500',
  ])('%s is a 400', async (query) => {
    const r = await getJson(AUTH_A, query);
    expect(r.status).toBe(400);
  });

  it.each(['?to=2026-13-01', '?to=2026-02-31', '?from=2026-13-01', '?from=2026-02-31'])(
    '%s is not a real day: 400 VALIDATION_FAILED on JSON and CSV',
    async (query) => {
      const r = await getJson(AUTH_A, query);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
      const { res, text } = await getCsv(AUTH_A, query);
      expect(res.status).toBe(400);
      expect(JSON.parse(text).error.code).toBe('VALIDATION_FAILED');
    },
  );

  it('writes no audit row', async () => {
    const before = await t.db.select({ n: count() }).from(auditLog);
    await getJson(AUTH_A);
    await getCsv(AUTH_A);
    const after = await t.db.select({ n: count() }).from(auditLog);
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

/** Minimal RFC 4180 reader for the parity cell. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return rows;
}

describe('GET /api/vendor/history.csv', () => {
  it('sends a dated attachment with the total and truncation headers', async () => {
    const { res } = await getCsv(AUTH_A);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="aeci-change-history-2026-10-09.csv"',
    );
    expect(res.headers.get('x-aeci-total-rows')).toBe('4');
    expect(res.headers.get('x-aeci-truncated')).toBe('false');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it.each(['', '?kind=vendor', '?from=2026-10-03'])(
    'carries the same rows as the JSON read (%s)',
    async (query) => {
      const json = (await getJson(AUTH_A, query)).body.data as VendorHistoryItem[];
      const [header, ...rows] = parseCsv((await getCsv(AUTH_A, query)).text);
      expect(header).toEqual([...VENDOR_HISTORY_CSV_COLUMNS]);
      expect(rows).toEqual(
        json.map((i) => [
          i.id,
          i.at,
          i.actor_kind,
          i.action,
          i.entity_type ?? '',
          i.entity_id ?? '',
          i.entity_name ?? '',
          i.fields.join(';'),
          i.plan?.tier ?? '',
          i.plan?.status ?? '',
          i.reason ?? '',
        ]),
      );
    },
  );

  it('is scoped like the JSON read', async () => {
    const [, ...rows] = parseCsv((await getCsv(AUTH_B)).text);
    expect(rows.map((r) => r[0])).toEqual([uuid(1004), uuid(1002)]);
    expect((await getCsv(AUTH_B)).text).not.toContain('Comped');
  });

  it(`stops at ${VENDOR_HISTORY_CSV_MAX_ROWS} rows and says so`, async () => {
    const insert = t.raw.prepare(
      `INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, vendor_id, created_at)
       VALUES (?, 'user', 'vendor.updated', 'vendor', ?, ?, ?)`,
    );
    t.raw.transaction(() => {
      for (let i = 0; i < VENDOR_HISTORY_CSV_MAX_ROWS; i++) {
        insert.run(
          `bulk-${String(i).padStart(6, '0')}`,
          VENDOR_B,
          VENDOR_B,
          '2026-09-01T00:00:00.000Z',
        );
      }
    })();
    const { res, text } = await getCsv(AUTH_B);
    expect(res.headers.get('x-aeci-truncated')).toBe('true');
    expect(res.headers.get('x-aeci-total-rows')).toBe(String(VENDOR_HISTORY_CSV_MAX_ROWS + 2));
    expect(parseCsv(text)).toHaveLength(VENDOR_HISTORY_CSV_MAX_ROWS + 1);
  });
});
