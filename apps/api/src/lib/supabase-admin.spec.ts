/**
 * Unit coverage for the GoTrue Admin API seams (`lib/supabase-admin.ts`) —
 * the split-identity seam register, `docs/AUTH_AND_RLS.md` §3.1.
 *
 * This file previously had NO spec — the only `src/lib/*.ts` without one — so the
 * GoTrue HTTP contract was untested. All four seams are covered here now: the
 * AECI-527 additions (`findAuthUserByEmail`, `createAuthUser`,
 * `fetchAuthAccountsByEmail`) and the pre-existing #2/#3 (`fetchAuthUserEmails`,
 * `deleteAuthUser`), which AECI-527 also touched by adding `AbortSignal.timeout`.
 * Their call sites keep injecting them (`routes/admin-reviews.spec.ts`,
 * `routes/account.spec.ts`); this spec pins the wire contract those stubs stand in
 * for.
 *
 * Global `fetch` is stubbed (`vi.spyOn(globalThis, 'fetch')`), mirroring
 * `email.spec.ts` / `toxicity.spec.ts`. This module has no Datadog import, so
 * there is nothing to mock. The house invariant under test throughout: NOTHING
 * throws, and absent creds are reported as `skipped` — never as "no such user".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { TEST_ENV } from '../test/helpers';
import {
  createAuthUser,
  deleteAuthUser,
  fetchAuthAccountsByEmail,
  fetchAuthUserEmails,
  fetchAuthUserEmailsResult,
  fetchAuthUserRecords,
  findAuthUserByEmail,
} from './supabase-admin';

const SUPABASE_URL = 'https://proj.supabase.co';
const SERVICE_KEY = 'service-role-key';

/** `TEST_ENV` deliberately carries no Supabase creds, so the absent-creds branch
 *  is the default and the happy path has to opt in. */
const ENV_WITH_CREDS: Env = {
  ...TEST_ENV,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};

const USER_ID = '00000000-0000-4000-8000-00000000a001';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** `{ users: [...] }` — the GoTrue `GET /admin/users` envelope. */
function usersResponse(users: unknown[], status = 200): Response {
  return jsonResponse({ aud: 'authenticated', users }, status);
}

function stubFetch(response: Response | (() => Response)) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => (typeof response === 'function' ? response() : response));
}

afterEach(() => vi.restoreAllMocks());

describe('findAuthUserByEmail (seam #4a)', () => {
  it('skips with { ok, skipped } and makes no request when admin creds are absent', async () => {
    const fetchSpy = stubFetch(usersResponse([]));

    const res = await findAuthUserByEmail(TEST_ENV, 'jane@acme.com');

    expect(res).toEqual({ ok: true, skipped: true, user: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when only SUPABASE_URL is set (both creds are required)', async () => {
    const fetchSpy = stubFetch(usersResponse([]));

    const res = await findAuthUserByEmail({ ...TEST_ENV, SUPABASE_URL }, 'jane@acme.com');

    expect(res.skipped).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('queries ?filter= with the lowercased email and sends both admin headers', async () => {
    const fetchSpy = stubFetch(usersResponse([{ id: USER_ID, email: 'jane@acme.com' }]));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, '  JANE@Acme.COM  ');

    expect(res).toMatchObject({ ok: true, user: { id: USER_ID, email: 'jane@acme.com' } });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SUPABASE_URL}/auth/v1/admin/users?filter=jane%40acme.com`);
    expect((init as RequestInit).headers).toEqual({
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    });
  });

  it('url-encodes a local-part containing + so the filter is not mangled', async () => {
    const fetchSpy = stubFetch(usersResponse([{ id: USER_ID, email: 'jane+claims@acme.com' }]));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane+claims@acme.com');

    expect(res.user?.id).toBe(USER_ID);
    expect(fetchSpy.mock.calls[0]![0]).toContain('filter=jane%2Bclaims%40acme.com');
  });

  it('strips a trailing slash from SUPABASE_URL', async () => {
    const fetchSpy = stubFetch(usersResponse([]));

    await findAuthUserByEmail(
      { ...ENV_WITH_CREDS, SUPABASE_URL: `${SUPABASE_URL}/` },
      'jane@acme.com',
    );

    expect(fetchSpy.mock.calls[0]![0]).toBe(
      `${SUPABASE_URL}/auth/v1/admin/users?filter=jane%40acme.com`,
    );
  });

  it('picks the exact match out of a multi-user filter response', async () => {
    stubFetch(
      usersResponse([
        { id: 'other-1', email: 'jane@acme.com.au' },
        { id: USER_ID, email: 'jane@acme.com' },
        { id: 'other-2', email: 'not-jane@acme.com' },
      ]),
    );

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res.user?.id).toBe(USER_ID);
  });

  it('matches case-insensitively against the stored email', async () => {
    stubFetch(usersResponse([{ id: USER_ID, email: 'Jane@Acme.Com' }]));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res.user?.id).toBe(USER_ID);
  });

  // The two guards below are why the client-side exact match exists: GoTrue's
  // `?filter=` is a substring LIKE over email OR full_name, so both of these
  // rows come back from the server and MUST NOT be treated as the claimant.
  it('rejects a substring superset — jane@acme.com does not match jane@acme.com.evil.io', async () => {
    stubFetch(usersResponse([{ id: 'attacker', email: 'jane@acme.com.evil.io' }]));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toMatchObject({ ok: true, user: null });
  });

  it('rejects a display-name hit — a user whose full_name contains the email is not a match', async () => {
    stubFetch(
      usersResponse([
        {
          id: 'impostor',
          email: 'someone-else@example.com',
          raw_user_meta_data: { full_name: 'jane@acme.com' },
        },
      ]),
    );

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res.user).toBeNull();
  });

  it('returns user: null with no request for a blank or at-less input', async () => {
    const fetchSpy = stubFetch(usersResponse([]));

    expect(await findAuthUserByEmail(ENV_WITH_CREDS, '   ')).toEqual({ ok: true, user: null });
    expect(await findAuthUserByEmail(ENV_WITH_CREDS, 'not-an-email')).toEqual({
      ok: true,
      user: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns { ok: false, status } on a non-2xx and never throws', async () => {
    stubFetch(new Response('forbidden', { status: 403 }));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toEqual({ ok: false, user: null, status: 403, error: 'forbidden' });
  });

  it('returns { ok: false } on a network rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toMatchObject({ ok: false, user: null, error: 'network down' });
  });

  it('returns { ok: false } when the timeout aborts the request', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res.ok).toBe(false);
    expect(res.user).toBeNull();
  });

  it('returns { ok: false } on a malformed body (users is not an array)', async () => {
    stubFetch(jsonResponse({ aud: 'authenticated' }));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toMatchObject({ ok: false, user: null, error: 'malformed response' });
  });

  it('ignores a matching row that carries no usable id', async () => {
    stubFetch(usersResponse([{ email: 'jane@acme.com' }]));

    const res = await findAuthUserByEmail(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toMatchObject({ ok: true, user: null });
  });
});

describe('createAuthUser (seam #4b)', () => {
  it('skips with { ok, skipped } and makes no request when admin creds are absent', async () => {
    const fetchSpy = stubFetch(jsonResponse({ id: USER_ID, email: 'jane@acme.com' }));

    const res = await createAuthUser(TEST_ENV, 'jane@acme.com');

    expect(res).toEqual({ ok: true, skipped: true, user: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the lowercased email with email_confirm and a json content-type', async () => {
    const fetchSpy = stubFetch(jsonResponse({ id: USER_ID, email: 'jane@acme.com' }));

    const res = await createAuthUser(ENV_WITH_CREDS, ' Jane@Acme.com ');

    expect(res).toMatchObject({ ok: true, user: { id: USER_ID, email: 'jane@acme.com' } });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SUPABASE_URL}/auth/v1/admin/users`);
    const request = init as RequestInit;
    expect(request.method).toBe('POST');
    expect(request.headers).toEqual({
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(request.body as string)).toEqual({
      email: 'jane@acme.com',
      email_confirm: true,
    });
  });

  it('flags alreadyExists on a 422 email_exists', async () => {
    stubFetch(
      new Response(JSON.stringify({ error_code: 'email_exists', msg: 'Duplicate Email' }), {
        status: 422,
      }),
    );

    const res = await createAuthUser(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toMatchObject({ ok: false, user: null, alreadyExists: true, status: 422 });
  });

  it('does not flag alreadyExists on another non-2xx', async () => {
    stubFetch(new Response('rate limited', { status: 429 }));

    const res = await createAuthUser(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toEqual({ ok: false, user: null, status: 429, error: 'rate limited' });
    expect(res.alreadyExists).toBeUndefined();
  });

  it('does not flag alreadyExists on a 422 that is not email_exists', async () => {
    stubFetch(new Response(JSON.stringify({ error_code: 'validation_failed' }), { status: 422 }));

    const res = await createAuthUser(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res.alreadyExists).toBeUndefined();
    expect(res.ok).toBe(false);
  });

  it('rejects an at-less email without a request', async () => {
    const fetchSpy = stubFetch(jsonResponse({ id: USER_ID, email: 'x' }));

    const res = await createAuthUser(ENV_WITH_CREDS, 'not-an-email');

    expect(res).toEqual({ ok: false, user: null, error: 'invalid email' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns { ok: false } on a malformed success body', async () => {
    stubFetch(jsonResponse({ email: 'jane@acme.com' }));

    const res = await createAuthUser(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toMatchObject({ ok: false, user: null, error: 'malformed response' });
  });

  it('never throws on a network rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

    const res = await createAuthUser(ENV_WITH_CREDS, 'jane@acme.com');

    expect(res).toMatchObject({ ok: false, user: null, error: 'network down' });
  });
});

describe('fetchAuthAccountsByEmail (the AECI-527 reviewer signal)', () => {
  it('returns an empty map and makes no request when admin creds are absent', async () => {
    const fetchSpy = stubFetch(usersResponse([]));

    const map = await fetchAuthAccountsByEmail(TEST_ENV, ['jane@acme.com']);

    expect(map.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps a hit to true and a miss to false', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      return url.includes('jane%40acme.com')
        ? usersResponse([{ id: USER_ID, email: 'jane@acme.com' }])
        : usersResponse([]);
    });

    const map = await fetchAuthAccountsByEmail(ENV_WITH_CREDS, ['jane@acme.com', 'new@acme.com']);

    expect(map.get('jane@acme.com')).toBe(true);
    expect(map.get('new@acme.com')).toBe(false);
  });

  it('dedupes case-insensitively: one request for two spellings, keyed under both', async () => {
    const fetchSpy = stubFetch(usersResponse([{ id: USER_ID, email: 'jane@acme.com' }]));

    const map = await fetchAuthAccountsByEmail(ENV_WITH_CREDS, ['Jane@Acme.com', 'jane@acme.com']);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(map.get('Jane@Acme.com')).toBe(true);
    expect(map.get('jane@acme.com')).toBe(true);
  });

  it('omits an email whose lookup failed, so the caller reports null rather than false', async () => {
    stubFetch(new Response('boom', { status: 500 }));

    const map = await fetchAuthAccountsByEmail(ENV_WITH_CREDS, ['jane@acme.com']);

    expect(map.has('jane@acme.com')).toBe(false);
  });

  it('keeps the successful lookups when a sibling lookup fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('broken')
        ? new Response('boom', { status: 500 })
        : usersResponse([{ id: USER_ID, email: 'jane@acme.com' }]),
    );

    const map = await fetchAuthAccountsByEmail(ENV_WITH_CREDS, [
      'jane@acme.com',
      'broken@acme.com',
    ]);

    expect(map.get('jane@acme.com')).toBe(true);
    expect(map.has('broken@acme.com')).toBe(false);
  });

  it('skips blank / at-less inputs without a request', async () => {
    const fetchSpy = stubFetch(usersResponse([]));

    const map = await fetchAuthAccountsByEmail(ENV_WITH_CREDS, ['', '   ', 'nope']);

    expect(map.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns an empty map for an empty input list', async () => {
    const fetchSpy = stubFetch(usersResponse([]));

    expect((await fetchAuthAccountsByEmail(ENV_WITH_CREDS, [])).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Seams #2/#3 predate AECI-527 and are exercised through injection at their call
// sites (`admin-reviews.spec.ts`, `account.spec.ts`), so their HTTP contract had
// never been asserted. AECI-527 added `AbortSignal.timeout` to both, so the
// request shape and the never-throw guarantee are pinned here too.

describe('deleteAuthUser (seam #3)', () => {
  it('skips with { ok, skipped } and makes no request when admin creds are absent', async () => {
    const fetchSpy = stubFetch(new Response(null, { status: 204 }));

    expect(await deleteAuthUser(TEST_ENV, USER_ID)).toEqual({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DELETEs the by-id admin URL with both admin headers', async () => {
    const fetchSpy = stubFetch(new Response(null, { status: 204 }));

    expect(await deleteAuthUser(ENV_WITH_CREDS, USER_ID)).toEqual({ ok: true, status: 204 });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`${SUPABASE_URL}/auth/v1/admin/users/${USER_ID}`);
    expect((init as RequestInit).method).toBe('DELETE');
    expect((init as RequestInit).headers).toEqual({
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    });
  });

  it('treats a 404 as success — the row is already gone', async () => {
    stubFetch(new Response('not found', { status: 404 }));

    expect(await deleteAuthUser(ENV_WITH_CREDS, USER_ID)).toEqual({ ok: true, status: 404 });
  });

  it('returns { ok: false, status } on another non-2xx', async () => {
    stubFetch(new Response('forbidden', { status: 403 }));

    expect(await deleteAuthUser(ENV_WITH_CREDS, USER_ID)).toEqual({
      ok: false,
      status: 403,
      error: 'forbidden',
    });
  });

  it('never throws on a network rejection or an aborted request', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

    expect(await deleteAuthUser(ENV_WITH_CREDS, USER_ID)).toEqual({
      ok: false,
      error: 'network down',
    });
  });
});

describe('fetchAuthUserEmails (seam #2)', () => {
  const OTHER_ID = '00000000-0000-4000-8000-00000000a002';

  it('returns an empty map and makes no request when admin creds are absent', async () => {
    const fetchSpy = stubFetch(jsonResponse({ email: 'jane@acme.com' }));

    expect((await fetchAuthUserEmails(TEST_ENV, [USER_ID])).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves each id to its email over parallel by-id GETs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      jsonResponse({ email: String(input).endsWith(USER_ID) ? 'jane@acme.com' : 'bob@acme.com' }),
    );

    const map = await fetchAuthUserEmails(ENV_WITH_CREDS, [USER_ID, OTHER_ID]);

    expect(map.get(USER_ID)).toBe('jane@acme.com');
    expect(map.get(OTHER_ID)).toBe('bob@acme.com');
  });

  it('dedupes ids and drops empty strings', async () => {
    const fetchSpy = stubFetch(jsonResponse({ email: 'jane@acme.com' }));

    const map = await fetchAuthUserEmails(ENV_WITH_CREDS, [USER_ID, USER_ID, '']);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(1);
  });

  it('leaves an id absent on a non-2xx, a network error, or a missing email', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(jsonResponse({ id: 'x' })); // no email field

    const map = await fetchAuthUserEmails(ENV_WITH_CREDS, [USER_ID, OTHER_ID, 'third']);

    expect(map.size).toBe(0);
  });

  it('returns an empty map for an empty id list without a request', async () => {
    const fetchSpy = stubFetch(jsonResponse({ email: 'jane@acme.com' }));

    expect((await fetchAuthUserEmails(ENV_WITH_CREDS, [])).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The availability-reporting form (AECI-652).
 *
 * The bare map cannot distinguish "the seam is down" from "this account has no
 * email", and on 2026-08-24 that gap made an absent service-role key look exactly
 * like a claimant with no account — for a day, with nothing in any log. These
 * cases pin the distinction, and the last one pins that the bare-map wrapper is
 * unchanged, because four structural type aliases take it as an injection
 * default.
 */
describe('fetchAuthUserEmailsResult (seam #2, AECI-652)', () => {
  const OTHER_ID = '00000000-0000-4000-8000-00000000a002';

  it('reports no_credentials — available:false, empty map, no request', async () => {
    const fetchSpy = stubFetch(jsonResponse({ email: 'jane@acme.com' }));

    const result = await fetchAuthUserEmailsResult(TEST_ENV, [USER_ID]);

    expect(result).toEqual({ available: false, emails: new Map(), reason: 'no_credentials' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('warns with the reason when creds are absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await fetchAuthUserEmailsResult(TEST_ENV, [USER_ID]);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no_credentials'), expect.anything());
  });

  it('reports ok with the full map on success', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      jsonResponse({ email: String(input).endsWith(USER_ID) ? 'jane@acme.com' : 'bob@acme.com' }),
    );

    const result = await fetchAuthUserEmailsResult(ENV_WITH_CREDS, [USER_ID, OTHER_ID]);

    expect(result.available).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.emails.get(USER_ID)).toBe('jane@acme.com');
  });

  it('reports ok — not error — when an id 404s, and warns nothing', async () => {
    // A 404 is a genuine "no such auth user" (an erased account), not a seam
    // failure. Reporting it as unavailable would relabel every row on the page.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ email: 'jane@acme.com' }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const result = await fetchAuthUserEmailsResult(ENV_WITH_CREDS, [USER_ID, OTHER_ID]);

    expect(result).toMatchObject({ available: true, reason: 'ok' });
    expect(result.emails.size).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports error — with the status logged — on a non-2xx, even if others succeed', async () => {
    // A partial map is still a degraded answer: a caller labelling a per-row blank
    // as authoritative would be wrong for exactly the rows that failed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ email: 'jane@acme.com' }))
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const result = await fetchAuthUserEmailsResult(ENV_WITH_CREDS, [USER_ID, OTHER_ID]);

    expect(result).toMatchObject({ available: false, reason: 'error' });
    expect(result.emails.get(USER_ID)).toBe('jane@acme.com');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('http_500'), expect.anything());
  });

  it('reports error and logs the message on a network failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));

    const result = await fetchAuthUserEmailsResult(ENV_WITH_CREDS, [USER_ID]);

    expect(result.reason).toBe('error');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('error'),
      expect.objectContaining({ message: 'network down' }),
    );
  });

  it('an empty id list is ok, not a degrade — there was nothing to look up', async () => {
    expect(await fetchAuthUserEmailsResult(ENV_WITH_CREDS, [])).toEqual({
      available: true,
      emails: new Map(),
      reason: 'ok',
    });
  });

  it("the bare-map wrapper returns exactly the Result form's map", async () => {
    // `FetchReviewerEmails` and `FetchSeatEmails` (×3) are declared as
    // `(env, ids) => Promise<Map<string, string>>` and take `fetchAuthUserEmails`
    // as their default. Changing that signature breaks every spec that injects a
    // fake, which is why the wrapper exists rather than the callers migrating.
    // `mockImplementation`, not `mockResolvedValue`: a Response body can only be
    // read once, so a single shared instance makes the second call fail.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ email: 'jane@acme.com' }),
    );

    const bare = await fetchAuthUserEmails(ENV_WITH_CREDS, [USER_ID]);
    const result = await fetchAuthUserEmailsResult(ENV_WITH_CREDS, [USER_ID]);

    expect(bare).toEqual(result.emails);
  });
});

describe('fetchAuthUserRecords (seam #2, record form, AECI-692)', () => {
  const OTHER_ID = '00000000-0000-4000-8000-00000000a002';

  /** A realistic GoTrue by-id payload — more fields than we project, on purpose. */
  function account(overrides: Record<string, unknown> = {}): Response {
    return jsonResponse({
      id: USER_ID,
      email: 'jane@acme.com',
      last_sign_in_at: '2026-08-20T09:00:00.000Z',
      created_at: '2026-01-05T12:00:00.000Z',
      email_confirmed_at: '2026-01-05T12:04:00.000Z',
      phone: '',
      role: 'authenticated',
      ...overrides,
    });
  }

  it('projects the four account fields the admin user surface renders', async () => {
    // The whole point of the issue: `last_sign_in_at` has always been on this
    // response and every caller until now threw it away.
    stubFetch(() => account());

    const result = await fetchAuthUserRecords(ENV_WITH_CREDS, [USER_ID]);

    expect(result).toMatchObject({ available: true, reason: 'ok' });
    expect(result.records.get(USER_ID)).toEqual({
      email: 'jane@acme.com',
      last_sign_in_at: '2026-08-20T09:00:00.000Z',
      created_at: '2026-01-05T12:00:00.000Z',
      email_confirmed_at: '2026-01-05T12:04:00.000Z',
    });
  });

  it('maps a missing or empty field to null, not undefined', async () => {
    // An account that has never signed in and never confirmed. `null` is the wire
    // contract (R10 required-nullable); `undefined` would drop the key entirely
    // and fail the response schema.
    stubFetch(() => account({ last_sign_in_at: null, email_confirmed_at: undefined, email: '' }));

    const record = (await fetchAuthUserRecords(ENV_WITH_CREDS, [USER_ID])).records.get(USER_ID);

    expect(record).toEqual({
      email: null,
      last_sign_in_at: null,
      created_at: '2026-01-05T12:00:00.000Z',
      email_confirmed_at: null,
    });
  });

  it('reports no_credentials — available:false, empty map, no request, warns ONCE', async () => {
    // Absent creds are the NORMAL state on local dev and PR previews. The warn
    // fires once before the fan-out, not once per id, or a 24-row admin page
    // buries the log it exists to produce.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchSpy = stubFetch(() => account());

    const result = await fetchAuthUserRecords(TEST_ENV, [USER_ID, OTHER_ID]);

    expect(result).toEqual({ available: false, records: new Map(), reason: 'no_credentials' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fetchAuthUserRecords degraded: no_credentials'),
      expect.anything(),
    );
  });

  it('leaves a 404 id ABSENT from the map while staying available — an orphaned profile', async () => {
    // The three-state contract: absent + available:true means "no auth.users row
    // for this profile", which is a real data defect and NOT the same as a seam
    // failure. A caller must be able to tell them apart.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(account())
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const result = await fetchAuthUserRecords(ENV_WITH_CREDS, [USER_ID, OTHER_ID]);

    expect(result).toMatchObject({ available: true, reason: 'ok' });
    expect(result.records.has(USER_ID)).toBe(true);
    expect(result.records.has(OTHER_ID)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports error page-wide when ANY id fails, keeping the ids that succeeded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(account())
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));

    const result = await fetchAuthUserRecords(ENV_WITH_CREDS, [USER_ID, OTHER_ID]);

    expect(result).toMatchObject({ available: false, reason: 'error' });
    expect(result.records.get(USER_ID)?.email).toBe('jane@acme.com');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fetchAuthUserRecords degraded: http_500'),
      expect.anything(),
    );
  });

  it('treats zero ids as ok, not a degrade, and makes no request', async () => {
    const fetchSpy = stubFetch(() => account());

    const result = await fetchAuthUserRecords(ENV_WITH_CREDS, []);

    expect(result).toEqual({ available: true, records: new Map(), reason: 'ok' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shares one fan-out with the email form — same ids, same availability', async () => {
    // `fetchAuthUserEmailsResult` is implemented ON this function. The projection
    // is the only difference, so an account with no email must be PRESENT here and
    // ABSENT there — that asymmetry is why both forms exist.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => account({ email: null }));

    const records = await fetchAuthUserRecords(ENV_WITH_CREDS, [USER_ID]);
    const emails = await fetchAuthUserEmailsResult(ENV_WITH_CREDS, [USER_ID]);

    expect(records.available).toBe(emails.available);
    expect(records.records.has(USER_ID)).toBe(true);
    expect(emails.emails.has(USER_ID)).toBe(false);
  });
});
