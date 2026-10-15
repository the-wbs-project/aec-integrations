/**
 * `GET /api/admin/vendors/:id/billing` (AECI-1372, E4.3) over the in-memory D1, the
 * handler mounted bare. The `requireAdmin()` cells (401, 403, banned) are in
 * `admin-panel.authz-matrix.spec.ts`. The last describe mounts the REAL Worker to prove
 * no rate limiter sits on the route.
 */

import {
  ADMIN_BILLING_LICENSES_MAX,
  AdminVendorBillingResponseSchema,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  type AdminVendorBillingResponse,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, billingAccounts, licenses, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import worker from '../index';
import { agreementAcceptanceStatements } from '../lib/agreement-acceptances';
import type { BatchTuple } from '../lib/audit';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import type { FetchAuthEmails } from './admin-vendors';
import { createAdminVendorBillingHandler } from './admin-vendors-billing';

const ADMIN_USER = '00000000-0000-4000-8000-000000000105';

// Only the registration describe goes through `requireAdmin`; the handler specs mount
// the handler bare.
vi.mock('../lib/authz', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/authz')>();
  const stub =
    (): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> => async (c, next) => {
      c.set('auth', {
        userId: ADMIN_USER,
        email: 'admin@example.test',
        role: 'admin',
      } as AuthzVariables['auth']);
      await next();
    };
  return { ...actual, requireAdmin: stub };
});

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const NO_ACCOUNT_VENDOR = uuid(3);
const OWNER = uuid(500);
const BANNED_OWNER = uuid(501);
const MEMBER = uuid(502);
const PRODUCT = uuid(700);

let t: TestDb;
let fetchEmails: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  t = await makeTestDb();
  fetchEmails = vi.fn(async (_env: Env, ids: readonly string[]) => ({
    available: true,
    reason: 'ok' as const,
    emails: new Map(ids.map((id) => [id, `seat-${id.slice(-3)}@acme.example`])),
  }));
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex' },
    { id: NO_ACCOUNT_VENDOR, slug: 'initech', companyName: 'Initech' },
  ]);
  await t.db.insert(products).values({ id: PRODUCT, slug: 'acme-build', name: 'Acme Build' });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true, displayName: 'Olive' },
    {
      id: BANNED_OWNER,
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      bannedAt: '2026-10-01T00:00:00.000Z',
    },
    // A seat that joined by invite: not an owner, so not on the Billing tab.
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
  ]);
});
afterEach(() => t.dispose());

async function call(vendorId: string, emails: FetchAuthEmails = fetchEmails as never) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/admin/vendors/:id/billing', createAdminVendorBillingHandler(t.factory, emails));
  const res = await app.fetch(
    new Request(`http://x/api/admin/vendors/${vendorId}/billing`),
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as never };
}

describe('GET /api/admin/vendors/:id/billing', () => {
  it('returns the account, owner seats, every license, and the acceptances', async () => {
    const accountId = await seedBillingAccount(t.db, VENDOR);
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'billing@acme.example' })
      .where(eq(billingAccounts.id, accountId));
    const ended = await seedLicense(t.db, VENDOR, {
      productId: PRODUCT,
      endedAt: '2026-06-01T00:00:00.000Z',
      endReason: 'revoked',
    });
    const assigned = await seedLicense(t.db, VENDOR, {
      productId: PRODUCT,
      source: 'invoice',
      endsAt: '2027-06-30',
    });
    const flagged = await seedLicense(t.db, VENDOR, { endsAt: '2027-06-30' });
    await t.db
      .update(licenses)
      .set({ cancelAtTermEnd: true, cancelReason: 'vendor-banned', reference: 'PO-1' })
      .where(eq(licenses.id, flagged));
    // Another vendor's license never leaks in.
    await seedLicense(t.db, OTHER_VENDOR);

    const acceptance = agreementAcceptanceStatements(t.db, {
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      source: 'claim',
      email: 'olive@acme.example',
      vendorId: VENDOR,
      acceptedAt: '2026-10-01T00:00:00.000Z',
      requestHeaders: new Headers({ 'cf-connecting-ip': '203.0.113.7' }),
      actorType: 'user',
    });
    await t.db.batch([...acceptance.stmts] as BatchTuple);
    const auditBefore = (await t.db.select().from(auditLog)).length;

    const { status, headers, body } = await call(VENDOR);
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    const parsed: AdminVendorBillingResponse = AdminVendorBillingResponseSchema.parse(body);

    expect(parsed.vendor_id).toBe(VENDOR);
    expect(parsed.billing_account).toMatchObject({
      id: accountId,
      billing_email: 'billing@acme.example',
      stripe_customer_id: null,
      seat_emails_available: true,
    });
    expect(parsed.billing_account?.owner_seats).toEqual([
      { user_id: OWNER, display_name: 'Olive', email: 'seat-500@acme.example', banned: false },
      { user_id: BANNED_OWNER, display_name: null, email: 'seat-501@acme.example', banned: true },
    ]);

    // Live first in creation order, then ended.
    expect(parsed.licenses.map((l) => l.id)).toEqual([assigned, flagged, ended]);
    expect(parsed.licenses[0]).toMatchObject({
      source: 'invoice',
      live: true,
      ends_at: '2027-06-30',
      assigned_product: { id: PRODUCT, slug: 'acme-build', name: 'Acme Build' },
      cancel_at_term_end: false,
    });
    expect(parsed.licenses[1]).toMatchObject({
      assigned_product: null,
      cancel_at_term_end: true,
      cancel_reason: 'vendor-banned',
      reference: 'PO-1',
    });
    // An ended license keeps its product as history.
    expect(parsed.licenses[2]).toMatchObject({
      live: false,
      end_reason: 'revoked',
      assigned_product: { id: PRODUCT },
    });
    expect(parsed.licenses_truncated).toBe(false);

    expect(parsed.acceptances).toHaveLength(1);
    expect(parsed.acceptances[0]).toMatchObject({
      id: acceptance.acceptanceId,
      ip: '203.0.113.7',
    });
    expect(parsed.release_requests).toEqual([]);

    // A read writes no audit row.
    expect((await t.db.select().from(auditLog)).length).toBe(auditBefore);
  });

  it('answers 200 with billing_account null for a vendor with no account', async () => {
    const { status, body } = await call(NO_ACCOUNT_VENDOR);
    expect(status).toBe(200);
    expect(AdminVendorBillingResponseSchema.parse(body)).toEqual({
      vendor_id: NO_ACCOUNT_VENDOR,
      billing_account: null,
      licenses: [],
      licenses_truncated: false,
      acceptances: [],
      acceptances_truncated: false,
      release_requests: [],
    });
    // No account to show seats on: GoTrue is not asked.
    expect(fetchEmails).not.toHaveBeenCalled();
  });

  it('reports the email lookup as unavailable without failing the read', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const down: FetchAuthEmails = async () => ({
      available: false,
      reason: 'no_credentials',
      emails: new Map(),
    });
    const { status, body } = await call(VENDOR, down);
    expect(status).toBe(200);
    const parsed = AdminVendorBillingResponseSchema.parse(body);
    expect(parsed.billing_account?.seat_emails_available).toBe(false);
    expect(parsed.billing_account?.owner_seats.every((s) => s.email === null)).toBe(true);
  });

  it('caps the license list and says so', async () => {
    const accountId = await seedBillingAccount(t.db, VENDOR);
    const rows = Array.from({ length: ADMIN_BILLING_LICENSES_MAX + 1 }, (_, i) => ({
      id: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`,
      billingAccountId: accountId,
      source: 'complimentary',
      startsAt: '2026-01-01T00:00:00.000Z',
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await t.db.insert(licenses).values(rows.slice(i, i + 50));
    }
    const { body } = await call(VENDOR);
    const parsed = AdminVendorBillingResponseSchema.parse(body);
    expect(parsed.licenses).toHaveLength(ADMIN_BILLING_LICENSES_MAX);
    expect(parsed.licenses_truncated).toBe(true);
  });

  it('404s an unknown vendor', async () => {
    const { status, body } = await call(uuid(999));
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('GET /api/admin/vendors/:id/billing registration', () => {
  it('is never rate-limited', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    } as RateLimit;
    const res = await worker.fetch(
      new Request(`https://api/api/admin/vendors/${VENDOR}/billing`, {
        headers: { authorization: 'Bearer test' },
      }),
      { ENV: 'staging', WRITE_RATE_LIMIT: limiter } as Env,
      fakeExecutionContext(),
    );
    // No D1 binding here, so the handler itself fails. What matters is that the
    // limiter was never asked.
    expect(res.status).not.toBe(429);
    expect(res.status).not.toBe(404);
    expect(keys).toEqual([]);
  });
});
