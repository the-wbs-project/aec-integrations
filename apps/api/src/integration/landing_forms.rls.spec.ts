/**
 * AECI-87 — PostgREST GRANT matrix for the landing lead-capture tables.
 *
 * The authz migration (supabase/migrations/20260602051513_rls_grants_and_policies.sql)
 * runs a blanket `REVOKE ALL ... FROM anon, authenticated` and then re-grants
 * `feedback` / `mailing_list` the narrow access the pre-launch landing forms
 * need: INSERT on the table + USAGE on the identity sequence, nothing else.
 *
 * This spec exercises that contract through the real PostgREST surface (the JWT
 * path the SQL-level `scripts/verify-rls.sql` probe can't reach):
 *   - anon AND authenticated CAN POST a row        (carve-out works)
 *   - anon AND authenticated CANNOT GET/PATCH/DELETE (no SELECT/UPDATE/DELETE grant)
 *
 * Sibling of apps/api/src/integration/vendor_requests.rls.spec.ts (the
 * all-verbs-denied "no GRANT" case); together they cover both buckets.
 *
 * Env vars (see apps/api/.dev.vars.example):
 *   SUPABASE_URL              — project URL, e.g. http://127.0.0.1:54321
 *   SUPABASE_ANON_KEY         — public anon JWT
 *   SUPABASE_TEST_USER_JWT    — access token for a non-admin authenticated user
 *   TEST_DATABASE_URL         — optional; when set, afterAll deletes the rows
 *                               the allowed-INSERT cases create (anon has no
 *                               DELETE grant, so cleanup runs via the direct URL)
 *
 * describe.skipIf keeps environments without the first three vars (e.g. the
 * default unit-test CI lane) silent; the dedicated integration job sets them.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const userJwt = process.env.SUPABASE_TEST_USER_JWT;
const testDbUrl = process.env.TEST_DATABASE_URL;

// Unique per run so the allowed-INSERT rows never collide with
// mailing_list.email's UNIQUE constraint, and so cleanup can target them.
const RUN_TAG = `aeci87-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const LANDING_TABLES = ['feedback', 'mailing_list'] as const;

// Allowed (carve-out): PostgREST returns 201, or 200/204 with return=minimal.
const ALLOWED_STATUSES = [200, 201, 204];
// Denied: PostgREST maps 42501 to one of these depending on version/headers.
const DENIED_STATUSES = [401, 403, 404];

// PATCH/DELETE need a filter so PostgREST attempts the write before the GRANT
// check. `id` is BIGINT on these tables, so a bigint literal (not a uuid). The
// id need not exist — the GRANT check fires regardless.
const FILTER = '?id=eq.0';

function headers(roleJwt: string, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: anon!,
    Authorization: `Bearer ${roleJwt}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

describe.skipIf(!url || !anon || !userJwt)(
  'landing forms — PostgREST GRANT matrix for anon + authenticated (AECI-87)',
  () => {
    const roles = [
      { name: 'anon', jwt: anon! },
      { name: 'authenticated', jwt: userJwt! },
    ];

    afterAll(async () => {
      // Best-effort cleanup of the rows the allowed-INSERT cases created. anon
      // has no DELETE grant, so this uses the direct URL when available.
      if (!testDbUrl) return;
      const prisma = new PrismaClient({ datasourceUrl: testDbUrl });
      try {
        const pattern = `landing-rls-${RUN_TAG}-%`;
        await prisma.$executeRawUnsafe('DELETE FROM public.feedback WHERE email LIKE $1', pattern);
        await prisma.$executeRawUnsafe(
          'DELETE FROM public.mailing_list WHERE email LIKE $1',
          pattern,
        );
      } finally {
        await prisma.$disconnect();
      }
    });

    for (const role of roles) {
      for (const table of LANDING_TABLES) {
        it(`allows ${role.name} INSERT into ${table}`, async () => {
          const email = `landing-rls-${RUN_TAG}-${role.name}-${table}@example.test`;
          const res = await fetch(`${url}/rest/v1/${table}`, {
            method: 'POST',
            headers: headers(role.jwt, { Prefer: 'return=minimal' }),
            body: JSON.stringify({ email }),
          });
          expect(ALLOWED_STATUSES).toContain(res.status);
        });

        it(`denies ${role.name} GET on ${table}`, async () => {
          const res = await fetch(`${url}/rest/v1/${table}`, {
            method: 'GET',
            headers: headers(role.jwt),
          });
          expect(DENIED_STATUSES).toContain(res.status);
        });

        it(`denies ${role.name} PATCH on ${table}`, async () => {
          const res = await fetch(`${url}/rest/v1/${table}${FILTER}`, {
            method: 'PATCH',
            headers: headers(role.jwt, { Prefer: 'return=minimal' }),
            body: JSON.stringify({ email: `noop-${RUN_TAG}@example.test` }),
          });
          expect(DENIED_STATUSES).toContain(res.status);
        });

        it(`denies ${role.name} DELETE on ${table}`, async () => {
          const res = await fetch(`${url}/rest/v1/${table}${FILTER}`, {
            method: 'DELETE',
            headers: headers(role.jwt),
          });
          expect(DENIED_STATUSES).toContain(res.status);
        });
      }
    }
  },
);
