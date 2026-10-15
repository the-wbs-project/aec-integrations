/**
 * Agreement acceptances end to end (AECI-1362): written the way their callers will
 * write them, read back through both endpoints behind their real guards.
 *
 * E3 (the claim insert) and E9 (the Stripe webhook) are not built yet, so this spec
 * plays them: a claim row and its vendor-terms acceptance in ONE `db.batch`, and a
 * checkout acceptance on the billing account. Both reads then run behind the real
 * `requireVendor()` / `requireAdmin()` with signed JWTs over the same migrated D1
 * harness the authz matrices use. Same pattern as `vendor-recrawl.integration.spec.ts`.
 */

import {
  AdminAgreementAcceptancesResponseSchema,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  VendorAgreementAcceptancesResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  profiles,
  vendorRequests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { agreementAcceptanceStatements } from '../lib/agreement-acceptances';
import type { BatchTuple } from '../lib/audit';
import { requireAdmin, requireVendor, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { createAdminVendorAcceptancesHandler } from './admin-vendor-acceptances';
import { createVendorBillingAcceptancesHandler } from './vendor-billing-acceptances';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ENV = { ENV: 'staging', SUPABASE_URL } as Env;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const ACCOUNT = u(10);
const CLAIM = u(20);
const OWNER = u(100);
const ADMIN = u(101);

let t: TestDb;
let jwks: TestJwks;
beforeEach(async () => {
  t = await makeTestDb();
  jwks = await makeTestJwks();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'procore', companyName: 'Procore' });
  await t.db.insert(billingAccounts).values({ id: ACCOUNT, vendorId: VENDOR, name: 'Procore' });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: ADMIN, role: 'admin' },
  ]);
});
afterEach(() => t.dispose());

function makeApp() {
  const guard = { getKey: jwks.getKey, dbFor: t.factory };
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get(
    '/api/vendor/billing/acceptances',
    requireVendor(guard),
    createVendorBillingAcceptancesHandler(t.factory),
  );
  app.get(
    '/api/admin/vendors/:id/acceptances',
    requireAdmin(guard),
    createAdminVendorAcceptancesHandler(t.factory),
  );
  return app;
}

async function get(path: string, sub?: string) {
  const headers: Record<string, string> = {};
  if (sub) {
    headers.Authorization = `Bearer ${await jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL })}`;
  }
  const res = await makeApp().request(path, { headers }, ENV, fakeExecutionContext());
  return { status: res.status, body: (await res.json()) as unknown };
}

describe('agreement acceptances, written in a caller batch and read back', () => {
  it('lands a claim and its acceptance atomically and shows it on both reads', async () => {
    // E3's shape: the claim INSERT and the acceptance share one batch.
    const terms = agreementAcceptanceStatements(t.db, {
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      source: 'claim',
      email: 'ada@procore.com',
      vendorId: VENDOR,
      vendorRequestId: CLAIM,
      acceptedAt: '2026-10-14T10:00:00.000Z',
      requestHeaders: new Headers({
        'cf-connecting-ip': '198.51.100.4',
        'user-agent': 'Mozilla/5.0',
      }),
      actorType: 'user',
    });
    // E9's shape: written from the webhook, filed on the billing account.
    const plan = agreementAcceptanceStatements(t.db, {
      document: 'managed_plan',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      source: 'checkout',
      email: 'billing@procore.com',
      profileId: OWNER,
      billingAccountId: ACCOUNT,
      stripeCheckoutSessionId: 'cs_live_abc',
      acceptedAt: '2026-10-15T10:00:00.000Z',
      actorType: 'system',
    });
    await t.db.batch([
      t.db.insert(vendorRequests).values({
        id: CLAIM,
        kind: 'claim',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'ada@procore.com',
        body: '',
      }),
      ...terms.stmts,
    ] as BatchTuple);
    await t.db.batch(plan.stmts as BatchTuple);

    expect(await t.db.select().from(auditLog)).toHaveLength(2);

    const vendorRead = await get('/api/vendor/billing/acceptances', OWNER);
    expect(vendorRead.status).toBe(200);
    const vendorRows = VendorAgreementAcceptancesResponseSchema.parse(vendorRead.body).acceptances;
    expect(vendorRows.map((r) => r.id)).toEqual([plan.acceptanceId, terms.acceptanceId]);
    expect(vendorRows[1]).toMatchObject({ vendor_request_id: CLAIM, email: 'ada@procore.com' });
    expect(JSON.stringify(vendorRead.body)).not.toContain('198.51.100.4');

    const adminRead = await get(`/api/admin/vendors/${VENDOR}/acceptances`, ADMIN);
    expect(adminRead.status).toBe(200);
    const adminRows = AdminAgreementAcceptancesResponseSchema.parse(adminRead.body).acceptances;
    expect(adminRows.map((r) => r.id)).toEqual([plan.acceptanceId, terms.acceptanceId]);
    expect(adminRows[1]).toMatchObject({ ip: '198.51.100.4', user_agent: 'Mozilla/5.0' });
    expect(adminRows[0]).toMatchObject({ ip: null, user_agent: null, vendor_id: null });
  });

  it('rolls the acceptance back with its claim when the batch fails', async () => {
    const terms = agreementAcceptanceStatements(t.db, {
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      source: 'claim',
      email: 'ada@procore.com',
      vendorId: VENDOR,
      acceptedAt: '2026-10-14T10:00:00.000Z',
      actorType: 'user',
    });
    const badClaim = t.db.insert(vendorRequests).values({
      id: CLAIM,
      kind: 'not-a-kind', // trips vendor_requests_kind_check
      targetType: 'vendor',
      targetId: VENDOR,
      submitterEmail: 'ada@procore.com',
      body: '',
    });
    await expect(t.db.batch([badClaim, ...terms.stmts] as BatchTuple)).rejects.toThrow();
    expect(await t.db.select().from(agreementAcceptances)).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('keeps the acceptance when its claim row is deleted', async () => {
    const terms = agreementAcceptanceStatements(t.db, {
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      source: 'claim',
      email: 'ada@procore.com',
      vendorId: VENDOR,
      vendorRequestId: CLAIM,
      acceptedAt: '2026-10-14T10:00:00.000Z',
      actorType: 'user',
    });
    await t.db.batch([
      t.db.insert(vendorRequests).values({
        id: CLAIM,
        kind: 'claim',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'ada@procore.com',
        body: '',
      }),
      ...terms.stmts,
    ] as BatchTuple);
    await t.db.delete(vendorRequests).where(eq(vendorRequests.id, CLAIM));

    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({ id: terms.acceptanceId, vendorRequestId: null });
  });

  it('answers 401 to an anonymous caller on both reads', async () => {
    expect((await get('/api/vendor/billing/acceptances')).status).toBe(401);
    expect((await get(`/api/admin/vendors/${VENDOR}/acceptances`)).status).toBe(401);
  });
});
