/**
 * `GET /api/admin/vendors/:id/acceptances` (AECI-1362) over the in-memory D1, the
 * handler mounted bare. The `requireAdmin()` cells (401, 403, banned) are in
 * `admin-panel.authz-matrix.spec.ts`. This file covers the 404 gate, the vendor
 * filter, and that AECi sees the evidence columns the vendor read omits.
 */

import {
  AdminAgreementAcceptancesResponseSchema,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
} from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { agreementAcceptanceStatements } from '../lib/agreement-acceptances';
import type { BatchTuple } from '../lib/audit';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createAdminVendorAcceptancesHandler } from './admin-vendor-acceptances';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex' },
  ]);
});
afterEach(() => t.dispose());

async function call(vendorId: string) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.get('/api/admin/vendors/:id/acceptances', createAdminVendorAcceptancesHandler(t.factory));
  const res = await app.fetch(
    new Request(`http://x/api/admin/vendors/${vendorId}/acceptances`),
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as never };
}

describe('GET /api/admin/vendors/:id/acceptances', () => {
  it('returns the vendor’s rows with IP and user agent', async () => {
    const mine = agreementAcceptanceStatements(t.db, {
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      source: 'claim',
      email: 'owner@acme.com',
      vendorId: VENDOR,
      acceptedAt: '2026-10-01T00:00:00.000Z',
      requestHeaders: new Headers({ 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'UA/1' }),
      actorType: 'user',
    });
    const foreign = agreementAcceptanceStatements(t.db, {
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      source: 'claim',
      email: 'x@globex.com',
      vendorId: OTHER_VENDOR,
      acceptedAt: '2026-10-02T00:00:00.000Z',
      actorType: 'user',
    });
    await t.db.batch([...mine.stmts, ...foreign.stmts] as BatchTuple);

    const { status, headers, body } = await call(VENDOR);
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
    const parsed = AdminAgreementAcceptancesResponseSchema.parse(body);
    expect(parsed.acceptances).toHaveLength(1);
    expect(parsed.acceptances[0]).toMatchObject({
      id: mine.acceptanceId,
      vendor_id: VENDOR,
      email: 'owner@acme.com',
      ip: '203.0.113.7',
      user_agent: 'UA/1',
    });
  });

  it('answers an empty list for a known vendor with no acceptances', async () => {
    const { status, body } = await call(VENDOR);
    expect(status).toBe(200);
    expect(body).toEqual({ acceptances: [] });
  });

  it('404s an unknown vendor rather than answering an empty list', async () => {
    const { status, body } = await call(uuid(999));
    expect(status).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});
