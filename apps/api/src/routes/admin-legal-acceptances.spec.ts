/**
 * AECI-1677: `GET /api/admin/legal-acceptances`, the accepted / not-yet read on
 * `/admin/legal`, over the in-memory D1. The admin guard is the registration's
 * (`requireAdmin()`, no limiter); this spec stubs the session.
 */
import { AdminLegalAcceptancesResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { agreementAcceptances, legalVersions, licenses, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { createAdminLegalAcceptancesHandler } from './admin-legal-acceptances';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2027-04-15T00:00:00.000Z');
const PAST = Date.parse('2027-03-31T12:00:00.000Z');
const FUTURE = Date.parse('2027-06-30T12:00:00.000Z');

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: u(1), slug: 'bentley', companyName: 'Bentley' },
    { id: u(2), slug: 'autodesk', companyName: 'autodesk' },
    { id: u(3), slug: 'trimble', companyName: 'Trimble' },
    // No seat: not a claimed company, never counted.
    { id: u(4), slug: 'nemetschek', companyName: 'Nemetschek' },
  ]);
  await t.db.insert(profiles).values([
    { id: u(101), role: 'vendor_admin', vendorId: u(1), seatOwner: true },
    { id: u(102), role: 'vendor_admin', vendorId: u(2), seatOwner: true },
    { id: u(103), role: 'vendor_admin', vendorId: u(3) },
    { id: u(104), role: 'reviewer', vendorId: u(4) },
  ]);
});
afterEach(() => t.dispose());

async function publish(over: Partial<typeof legalVersions.$inferInsert> = {}) {
  await t.db.insert(legalVersions).values({
    document: 'vendor_terms',
    version: '1.4',
    effectiveAt: PAST,
    summaryJson: '["A change."]',
    material: true,
    requiresAcceptance: false,
    pdfKey: `legal/${over.document ?? 'vendor_terms'}/v${over.version ?? '1.4'}.pdf`,
    pdfSha256: 'a'.repeat(64),
    pdfBytes: 10,
    publishedBy: u(900),
    publishedAt: '2027-02-01T00:00:00.000Z',
    ...over,
  });
}

async function accepted(vendorId: string | null, version: string, extra = {}) {
  await t.db.insert(agreementAcceptances).values({
    id: crypto.randomUUID(),
    document: 'vendor_terms',
    version,
    source: 'claim',
    email: 'x@example.test',
    vendorId,
    acceptedAt: '2026-11-11T00:00:00.000Z',
    ...extra,
  });
}

async function read() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.get(
    '/api/admin/legal-acceptances',
    createAdminLegalAcceptancesHandler(t.factory, () => NOW),
  );
  const res = await a.request('/api/admin/legal-acceptances', {}, TEST_ENV, fakeExecutionContext());
  expect(res.status).toBe(200);
  return AdminLegalAcceptancesResponseSchema.parse(await res.json());
}

describe('GET /api/admin/legal-acceptances', () => {
  it('lists nothing while no version is final, which is today', async () => {
    await accepted(u(1), '1.3');
    expect(await read()).toEqual({ versions: [] });
  });

  it('counts accepted and not yet over claimed companies, never a draft acceptance', async () => {
    await publish();
    await accepted(u(1), '1.3'); // a draft: not yet
    await accepted(u(2), '1.4');
    const { versions } = await read();
    expect(versions).toEqual([
      {
        document: 'vendor_terms',
        version: '1.4',
        effective_at: '2027-03-31T12:00:00.000Z',
        in_force: true,
        published: true,
        requires_acceptance: false,
        audience: 'claimed',
        accepted_count: 1,
        not_yet_count: 2,
        // By name, case-insensitively.
        not_yet: [
          { vendor_id: u(1), slug: 'bentley', company_name: 'Bentley' },
          { vendor_id: u(3), slug: 'trimble', company_name: 'Trimble' },
        ],
      },
    ]);
  });

  it('counts an acceptance filed only under a billing account, and a later final version', async () => {
    await publish();
    await publish({ version: '1.5', effectiveAt: FUTURE, requiresAcceptance: true });
    const account = await seedBillingAccount(t.db, u(3));
    await accepted(null, '1.5', { billingAccountId: account });
    const { versions } = await read();
    expect(versions.map((v) => [v.version, v.in_force, v.accepted_count, v.not_yet_count])).toEqual(
      [
        ['1.5', false, 1, 2],
        ['1.4', true, 1, 2],
      ],
    );
  });

  it('counts the Managed plan agreement over live monthly card subscriptions only', async () => {
    await publish({ document: 'managed_plan', version: '1.2', requiresAcceptance: true });
    const card = await seedLicense(t.db, u(2), { source: 'stripe' });
    await t.db.update(licenses).set({ stripeSubscriptionId: 'sub_1' }).where(eq(licenses.id, card));
    await seedLicense(t.db, u(1), { source: 'complimentary' });
    const [mp] = (await read()).versions;
    expect(mp).toMatchObject({
      document: 'managed_plan',
      audience: 'monthly_card',
      accepted_count: 0,
      not_yet_count: 1,
      not_yet: [{ vendor_id: u(2) }],
    });
  });
});
