import { describe, expect, it } from 'vitest';

// AECI-48 acceptance criterion: anon and authenticated PostgREST roles must
// not be able to SELECT, INSERT, UPDATE, or DELETE on vendor_requests.
//
// The table is in the "no GRANT" bucket (STEP 6 of the migration
// supabase/migrations/20260602051513_rls_grants_and_policies.sql), so
// PostgREST rejects every verb before RLS is even consulted. We assert any
// of 401 / 403 / 404 — PostgREST may return 404 when the table is fully
// hidden from a role; all three satisfy "no access".
//
// Env vars (see apps/api/.dev.vars.example):
//   SUPABASE_URL              — project URL, e.g. https://<ref>.supabase.co
//   SUPABASE_ANON_KEY         — public anon JWT
//   SUPABASE_TEST_USER_JWT    — access token for a non-admin authenticated user
//
// describe.skipIf keeps environments without these vars (e.g. the default
// unit-test CI lane) silent. The dedicated integration CI job sets them.

const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const userJwt = process.env.SUPABASE_TEST_USER_JWT;

const DENIED_STATUSES = [401, 403, 404];

// PostgREST refuses PATCH/DELETE without a WHERE clause (HTTP 400) before it
// ever checks GRANTs. To exercise the GRANT/RLS deny path on those verbs we
// must pass an `id=eq.<uuid>` filter so PostgREST is willing to attempt the
// write. The uuid doesn't have to exist — the GRANT check fires regardless.
const FILTER = '?id=eq.00000000-0000-0000-0000-000000000000';

const verbs = [
  { method: 'GET', path: '', body: undefined },
  {
    method: 'POST',
    path: '',
    body: JSON.stringify({
      kind: 'claim',
      target_type: 'vendor',
      target_id: '00000000-0000-0000-0000-000000000000',
      submitter_email: 'rls-test@example.com',
      body: 'rls deny-path test',
    }),
  },
  { method: 'PATCH', path: FILTER, body: JSON.stringify({ status: 'resolved' }) },
  { method: 'DELETE', path: FILTER, body: undefined },
] as const;

describe.skipIf(!url || !anon || !userJwt)(
  'vendor_requests — PostgREST deny-path for anon + authenticated (AECI-48)',
  () => {
    const roles = [
      { name: 'anon', jwt: anon! },
      { name: 'authenticated', jwt: userJwt! },
    ];

    for (const role of roles) {
      for (const v of verbs) {
        it(`denies ${v.method} for ${role.name}`, async () => {
          const res = await fetch(`${url}/rest/v1/vendor_requests${v.path}`, {
            method: v.method,
            headers: {
              apikey: anon!,
              Authorization: `Bearer ${role.jwt}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: v.body,
          });

          expect(DENIED_STATUSES).toContain(res.status);
        });
      }
    }
  },
);
