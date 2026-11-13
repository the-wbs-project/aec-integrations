/**
 * POST /api/auth/profile/ensure on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness. Idempotent provisioning: first call creates +
 * audits, re-runs are no-ops.
 *
 * Also pins the AECI-527 no-clobber contract (`STAGE_2_VENDOR_PORTAL_SPEC.md` §2):
 * a vendor-claim grant that lands before the claimant's first sign-in must survive
 * that sign-in intact. See the handler's NO-CLOBBER CONTRACT header block.
 */

import { LEGAL_IN_FORCE_MAPS, legalEffectiveAtMs, type LegalInForceMaps } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, legalVersions, profiles, termsAcceptances, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import type { UserAuthVariables } from '../lib/user-auth';
import { createEnsureProfileHandler, type EnsureProfileDeps } from './auth-profile';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = u(900);
const VENDOR = u(901);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function post(opts: { deps?: EnsureProfileDeps; headers?: Record<string, string> } = {}) {
  const a = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('user', { userId: USER, email: 'reader@example.com' });
    await next();
  });
  a.post('/api/auth/profile/ensure', createEnsureProfileHandler(t.factory, opts.deps));
  return a.request(
    '/api/auth/profile/ensure',
    { method: 'POST', headers: opts.headers ?? {} },
    TEST_ENV,
    fakeExecutionContext(),
  );
}

describe('POST /api/auth/profile/ensure', () => {
  it('creates the profile + a profile.created audit on first call', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()) as { created: boolean }).toEqual({ created: true });

    const rows = await t.db.select().from(profiles);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(USER);
    expect(rows[0]!.role).toBe('reviewer'); // schema default

    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('profile.created');
    expect(audit[0]!.entityId).toBe(USER);
  });

  it('is idempotent: a re-run creates nothing and writes no new audit', async () => {
    await post();
    const second = await post();
    expect((await second.json()) as { created: boolean }).toEqual({ created: false });

    expect(await t.db.select().from(profiles)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1); // no second audit
  });

  // The no-clobber contract AECI-519's grant depends on: a vendor-claim grant can
  // land BEFORE the claimant has ever signed in, and their first login must not
  // reset it. Asserts `display_name` / `theme_preference` too — fields the grant
  // does not own and must equally survive (spec §2, last sentence).
  it('does not clobber a granted vendor_admin profile on first login (AECI-527)', async () => {
    await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
    await t.db.insert(profiles).values({
      id: USER,
      role: 'vendor_admin',
      vendorId: VENDOR,
      displayName: 'Jane',
      themePreference: 'light',
    });

    const res = await post();

    // The grant must be intact — asserted FIRST so a regression names the clobber
    // rather than the response shape.
    const rows = await t.db.select().from(profiles);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: USER,
      role: 'vendor_admin',
      vendorId: VENDOR,
      displayName: 'Jane',
      themePreference: 'light',
    });

    expect((await res.json()) as { created: boolean }).toEqual({ created: false });
    // No row was created, so no `profile.created` audit either.
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

// AECI-1637 (ruling of 2026-11-13): signing in is the Terms acceptance.
describe('POST /api/auth/profile/ensure: the sign-in Terms acceptance (AECI-1637)', () => {
  const DAY = '2027-01-15';
  const MOMENT = legalEffectiveAtMs(DAY);
  const AFTER = new Date(MOMENT + 86_400_000);
  const MAPS: LegalInForceMaps = {
    ...LEGAL_IN_FORCE_MAPS,
    readerUpcoming: { terms: { version: '1.2', effectiveOn: DAY } },
  };
  const deps: EnsureProfileDeps = { maps: MAPS, now: () => AFTER };
  const HEADERS = { 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'Mozilla/5.0 Test' };

  beforeEach(async () => {
    await t.db.insert(legalVersions).values({
      id: 'lv12',
      document: 'terms',
      version: '1.2',
      effectiveAt: MOMENT,
      summaryJson: '["The disputes section changes."]',
      material: true,
      requiresAcceptance: true,
      pdfKey: 'legal/terms/v1.2.pdf',
      pdfSha256: 'b'.repeat(64),
      pdfBytes: 10,
      publishedBy: 'admin',
      publishedAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('records the version in force with the IP address and browser of the request', async () => {
    const res = await post({ deps, headers: HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true });
    const rows = await t.db.select().from(termsAcceptances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profileId: USER,
      email: 'reader@example.com',
      version: '1.2',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 Test',
      acceptedAt: AFTER.toISOString(),
    });
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'terms.accepted')),
    ).toHaveLength(1);
  });

  it('a second sign-in on the same version writes nothing more', async () => {
    await post({ deps, headers: HEADERS });
    await post({ deps, headers: HEADERS });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(1);
  });

  it('with no Terms version in force (today) it writes nothing', async () => {
    await post({ headers: HEADERS });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
  });

  it('a failed acceptance write never fails the ensure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Every batch fails: the ensure's own insert is not a batch, so the profile is made.
    const batch = vi.spyOn(t.db, 'batch').mockRejectedValue(new Error('D1 is down'));
    const res = await post({ deps, headers: HEADERS });
    batch.mockRestore();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: true });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
