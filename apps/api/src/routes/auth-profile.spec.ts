/**
 * POST /api/auth/profile/ensure on the Drizzle/D1 path (ADR 0016 / AECI-253),
 * against the in-memory D1 harness. Idempotent provisioning: first call creates +
 * audits, re-runs are no-ops.
 *
 * Also pins the AECI-527 no-clobber contract (`STAGE_2_VENDOR_PORTAL_SPEC.md` §2):
 * a vendor-claim grant that lands before the claimant's first sign-in must survive
 * that sign-in intact. See the handler's NO-CLOBBER CONTRACT header block.
 */

import {
  LEGAL_IN_FORCE_MAPS,
  legalEffectiveAtMs,
  TERMS_CHANGE_BOX_LABEL,
  type LegalInForceMaps,
} from '@aeci/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, legalVersions, profiles, termsAcceptances, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import type { AuthzVariables } from '../lib/authz';
import type { UserAuthVariables } from '../lib/user-auth';
import {
  createAcceptTermsHandler,
  createEnsureProfileHandler,
  createTermsPendingHandler,
  type EnsureProfileDeps,
} from './auth-profile';

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
    expect((await res.json()) as { created: boolean }).toEqual({
      created: true,
      terms_acceptance: null,
    });

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
    expect((await second.json()) as { created: boolean }).toEqual({
      created: false,
      terms_acceptance: null,
    });

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

    expect((await res.json()) as { created: boolean }).toEqual({
      created: false,
      terms_acceptance: null,
    });
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
    expect(await res.json()).toEqual({ created: true, terms_acceptance: null });
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
    expect(await res.json()).toEqual({ created: true, terms_acceptance: null });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // ── The tick box (counsel Q63, ruling 53) ─────────────────────────────────────
  const OLD_ACCOUNT = async () =>
    t.db.insert(profiles).values({ id: USER, role: 'reviewer', createdAt: '2026-06-01T00:00:00Z' });

  it('an existing account at the first sign-in after a rights-reducing version: no row, the box named', async () => {
    await OLD_ACCOUNT();
    const res = await post({ deps, headers: HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: false, terms_acceptance: { version: '1.2' } });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
  });

  function accept(body: unknown, raw = false) {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', { userId: USER, email: 'reader@example.com' } as AuthzVariables['auth']);
      await next();
    });
    a.post('/api/auth/terms/accept', createAcceptTermsHandler(t.factory, deps));
    return a.request(
      '/api/auth/terms/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...HEADERS },
        body: raw ? (body as string) : JSON.stringify(body),
      },
      TEST_ENV,
      fakeExecutionContext(),
    );
  }

  it('POST /api/auth/terms/accept records the tick, then the next sign-in shows no box', async () => {
    await OLD_ACCOUNT();
    const res = await accept({ version: '1.2', accepted: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: '1.2', accepted_at: AFTER.toISOString() });
    const rows = await t.db.select().from(termsAcceptances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      profileId: USER,
      email: 'reader@example.com',
      checkboxLabel: TERMS_CHANGE_BOX_LABEL,
      checkboxDefaultUnticked: true,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 Test',
    });

    const next = await post({ deps, headers: HEADERS });
    expect(await next.json()).toEqual({ created: false, terms_acceptance: null });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(1);
  });

  it('GET /api/auth/terms/pending names the version and its summary, then null after the tick', async () => {
    await OLD_ACCOUNT();
    const read = async () => {
      const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
      a.onError(errorHandler());
      a.use('*', async (c, next) => {
        c.set('auth', { userId: USER, email: 'reader@example.com' } as AuthzVariables['auth']);
        await next();
      });
      a.get('/api/auth/terms/pending', createTermsPendingHandler(t.factory, deps));
      const res = await a.request('/api/auth/terms/pending', {}, TEST_ENV, fakeExecutionContext());
      expect(res.status).toBe(200);
      return res.json();
    };
    expect(await read()).toEqual({
      pending: {
        version: '1.2',
        effective_at: new Date(MOMENT).toISOString(),
        summary: ['The disputes section changes.'],
        previous_version: null,
      },
    });
    await accept({ version: '1.2', accepted: true });
    expect(await read()).toEqual({ pending: null });
  });

  it('POST /api/auth/terms/accept refuses an unticked body and a version not pending', async () => {
    await OLD_ACCOUNT();
    expect((await accept({ version: '1.2', accepted: false })).status).toBe(400);
    expect((await accept({ version: '1.2' })).status).toBe(400);
    expect((await accept('{', true)).status).toBe(400);
    const stale = await accept({ version: '1.1', accepted: true });
    expect(stale.status).toBe(422);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe(
      'LEGAL_ACCEPTANCE_NOT_PENDING',
    );
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
  });
});

describe('route registration (apps/api/src/index.ts)', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  const squash = (x: string) => x.replace(/\s+/g, ' ');

  it('the pending read is guarded by requireAuth and never rate-limited', () => {
    expect(squash(index)).toContain(
      "authAccount.get('/api/auth/terms/pending', requireAuth(), createTermsPendingHandler());",
    );
  });

  it('guards the tick with requireAuth (the cookie guard), THEN the write limiter', () => {
    expect(squash(index)).toContain(
      "authAccount.post( '/api/auth/terms/accept', requireAuth(), rateLimit('write'), createAcceptTermsHandler(), );",
    );
  });
});
