/**
 * Supabase GoTrue Admin API client — the split-identity seam (ADR 0016 / AECI-254).
 * The canonical register of every seam and its degrade behaviour is
 * `docs/AUTH_AND_RLS.md` §3.1.
 *
 * Under D1, the application store no longer shares a database with Supabase Auth,
 * so every `auth.users` coupling that used a privileged Postgres query now goes
 * over HTTPS to the GoTrue Admin API with the service-role key:
 *   - seam #2: reviewer email reads for the admin moderation queue.
 *   - seam #3: GDPR erasure of the `auth.users` row on account deletion.
 *   - seam #4a: email→auth-user lookup for vendor-claim resolution (AECI-527).
 *   - seam #4b: account provisioning when a claimant has no auth user yet.
 *
 * This file is the ONLY module that reads `env.SUPABASE_SERVICE_ROLE_KEY` — keep
 * it that way (the single-module invariant, `AUTH_AND_RLS.md` §3.1). It is also
 * deliberately DB-free: seam #4's composition with D1 lives in
 * `lib/claimant-identity.ts` (`docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2).
 *
 * Every seam DEGRADES GRACEFULLY when `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY` are absent (local `wrangler dev`, PR previews):
 * emails resolve to a partial/empty map, the auth-user delete is skipped (the D1
 * data erasure still happened), and claim resolution reports `unavailable`.
 * None throws — the caller decides how to surface a failure. The single-shot
 * seams flag the absent-creds case as `skipped: true`, which callers MUST
 * distinguish from a successful "no such user" result.
 *
 * Since AECI-652 every degrade also `console.warn`s its reason (see
 * {@link warnSeam}), and the batched email seam has a `Result` form
 * ({@link fetchAuthUserEmailsResult}) that reports availability alongside the
 * map. Graceful degradation without a log line is how a bad service-role key
 * spent a day looking exactly like "this claimant has no account".
 */

import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { discardResponseBody } from '@aeci/shared/response-drain';
import type { Env } from '../env';

/**
 * Cap on a GoTrue Admin API round-trip. Mirrors `lib/email.ts` / `lib/linear.ts`
 * / `lib/toxicity.ts`; an abort lands in the same `catch` as a network failure,
 * so it degrades to the ordinary graceful result. Matters most for
 * `fetchAuthUserEmails` / `fetchAuthAccountsByEmail`, whose page-wide fan-out
 * would otherwise be able to hang an admin queue render.
 */
const TIMEOUT_MS = 5000;

function adminConfig(env: Env): { url: string; key: string } | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: env.SUPABASE_URL.replace(/\/$/, ''), key: env.SUPABASE_SERVICE_ROLE_KEY };
}

/** `Record<string, string>` (not `HeadersInit`) so callers that need a body can
 *  spread it alongside `content-type`. Still assignable to `HeadersInit`. */
function adminHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/**
 * GoTrue stores emails lowercased, and its `?filter=` is a CASE-SENSITIVE
 * substring `LIKE` — so a lookup query MUST be lowercased or a mixed-case
 * submitter email silently misses. Also the dedupe key for the batched lookup.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Say out loud why a seam degraded.
 *
 * Every seam in this module swallows its failure by design — a missing
 * service-role key is a legitimate state in local dev and PR previews, and an
 * admin queue must render rather than 500. What was NOT by design is that the
 * status code and error text went with it: on 2026-08-24 the claim queue read
 * "Account status unknown" for every row on `stage2`, first because the key was
 * absent and then because it carried a bad value, and there was nothing in any
 * log to tell those two apart from a genuine "this claimant has no account".
 *
 * `console.warn` rather than the `logToPosthog` helpers used elsewhere
 * (`lib/email.ts`, `lib/toxicity.ts`): those need `(executionCtx, env, request)`
 * and every function here takes only `env`. Threading a Hono context in would
 * change four structural type aliases that exist precisely so these functions
 * can be swapped for fakes in tests. Workers Observability captures `console.*`,
 * and the callers — which do hold a context — turn the returned `reason` into
 * structured telemetry.
 */
function warnSeam(seam: string, reason: string, detail?: unknown): void {
  console.warn(`[supabase-admin] ${seam} degraded: ${reason}`, detail === undefined ? '' : detail);
}

/**
 * The result of a batched email lookup, with the "why" the bare map cannot
 * carry (AECI-652).
 *
 * `available: false` means the SEAM failed — creds absent, or GoTrue errored —
 * so an absent key says nothing about the account. `available: true` with an
 * absent key means that account genuinely has no email on file. A surface that
 * cannot tell those apart has to render "unknown" for everything, which is how
 * a configuration error hid in plain sight for a day.
 */
export interface AuthEmailLookup {
  available: boolean;
  emails: Map<string, string>;
  reason: 'ok' | 'no_credentials' | 'error';
}

/**
 * One GoTrue account, reduced to what the admin user surface renders (AECI-692).
 *
 * A field is `null` when the account genuinely has no such value — never as a
 * stand-in for "the seam failed", which the enclosing {@link AuthRecordLookup}
 * reports. `created_at` is the AUTH user's creation, which is NOT
 * `profiles.created_at`: a profile row is written on the first `/auth/callback`
 * and the auth user at signup, so the two differ. Ship both; do not collapse.
 */
export interface AuthUserRecord {
  email: string | null;
  last_sign_in_at: string | null;
  created_at: string | null;
  email_confirmed_at: string | null;
}

/**
 * {@link AuthEmailLookup}'s richer sibling — same three-state discipline.
 *
 * An id ABSENT from `records` while `available` is `true` means GoTrue has no
 * `auth.users` row for it (a 404): an orphaned profile, which is a real data
 * defect, not a blank. `available: false` means the seam failed and the map says
 * nothing about any account.
 */
export interface AuthRecordLookup {
  available: boolean;
  records: Map<string, AuthUserRecord>;
  reason: 'ok' | 'no_credentials' | 'error';
}

/**
 * Injected batched-record seam (AECI-692).
 *
 * Declared here, beside the result type it returns, because it is new and has no
 * other home. Its email-shaped sibling `FetchAuthEmails` is declared in
 * `routes/admin-vendors.ts` where AECI-652 put it and where its spec imports it
 * from; it is NOT duplicated here, because two structurally-identical aliases
 * for one contract is how the next reader ends up unsure which is canonical.
 */
export type FetchAuthRecords = (env: Env, ids: readonly string[]) => Promise<AuthRecordLookup>;

/** Injected email→auth-user seam (#4a), for handlers that resolve a search term. */
export type FindAuthUserByEmail = (env: Env, email: string) => Promise<FindAuthUserResult>;

/** A blank or garbage `filter=` would match every user, so reject before the
 *  round-trip. Deliberately minimal — GoTrue, not us, validates the address. */
function isPlausibleEmail(normalized: string): boolean {
  return normalized.includes('@');
}

export interface DeleteAuthUserResult {
  ok: boolean;
  /** True when Supabase admin creds were absent and the call was skipped. */
  skipped?: boolean;
  status?: number;
  error?: string;
}

/**
 * Delete an `auth.users` row via the GoTrue Admin API (seam #3). Returns `{ ok }`
 * — never throws. A 404 (already gone) counts as success. When creds are absent
 * the call is skipped (`ok: true, skipped: true`) so erasure is never blocked.
 */
export async function deleteAuthUser(env: Env, userId: string): Promise<DeleteAuthUserResult> {
  const cfg = adminConfig(env);
  if (!cfg) return { ok: true, skipped: true };
  try {
    const res = await fetch(`${cfg.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: adminHeaders(cfg.key),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok || res.status === 404) {
      discardResponseBody(res); // Nothing to read; release the connection (AECI-666).
      return { ok: true, status: res.status };
    }
    return { ok: false, status: res.status, error: await res.text().catch(() => '') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A GoTrue string field, or `null` when the account genuinely has no value. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The batched by-id fan-out both public forms of seam #2 share.
 *
 * Private and label-parameterised. {@link fetchAuthUserEmailsResult} and
 * {@link fetchAuthUserRecords} are the same HTTP contract with different
 * projections, and the rules that make it correct are subtle enough that a
 * second copy would drift within one issue: bounded concurrency (AECI-666),
 * `discardResponseBody` on every unread body, "a 404 is NOT a degrade", and
 * "`reason: 'error'` if ANY id failed, even when others succeeded". `seam` is
 * threaded through so each caller's `warnSeam` lines keep naming the function an
 * operator actually called.
 */
async function fanOutAuthUsers(
  env: Env,
  userIds: readonly string[],
  seam: string,
): Promise<AuthRecordLookup> {
  const records = new Map<string, AuthUserRecord>();
  const cfg = adminConfig(env);
  const ids = [...new Set(userIds)].filter((id) => id.length > 0);
  if (!cfg) {
    // Once, before the fan-out — not once per id. A per-row warn on a 24-row
    // admin page makes the local-dev log (where absent creds are the NORMAL
    // state) unreadable, which is the opposite of why `warnSeam` exists.
    warnSeam(seam, 'no_credentials', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return { available: false, records, reason: 'no_credentials' };
  }
  // No ids is not a degrade — there was nothing to look up, and the seam is fine.
  if (ids.length === 0) return { available: true, records, reason: 'ok' };

  let failed = false;

  // Bounded, not a bare `Promise.all` (AECI-666): GoTrue has no by-id batch
  // endpoint, so this is one GET per user and the request count scales with
  // the admin page size. An unbounded fan-out from one invocation is how the
  // promote hooks deadlocked — see `mapWithConcurrency`.
  await mapWithConcurrency(ids, WORKER_CONNECTION_LIMIT, async (id) => {
    try {
      const res = await fetch(`${cfg.url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        headers: adminHeaders(cfg.key),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        discardResponseBody(res);
        // A 404 is a genuine "no such auth user", not a seam failure — it is the
        // expected answer for a profile whose Supabase account was erased.
        if (res.status !== 404) {
          failed = true;
          warnSeam(seam, `http_${res.status}`, { userId: id });
        }
        return;
      }
      const user = (await res.json()) as RawGoTrueUser;
      records.set(id, {
        email: optionalString(user.email),
        last_sign_in_at: optionalString(user.last_sign_in_at),
        created_at: optionalString(user.created_at),
        email_confirmed_at: optionalString(user.email_confirmed_at),
      });
    } catch (error) {
      failed = true;
      warnSeam(seam, 'error', {
        userId: id,
        message: error instanceof Error ? error.message : String(error),
      });
      /* degrade — leave this id absent from the map */
    }
  });

  return failed
    ? { available: false, records, reason: 'error' }
    : { available: true, records, reason: 'ok' };
}

/**
 * Resolve emails for the given auth user ids via the GoTrue Admin API (seam #2),
 * reporting whether the seam itself worked.
 *
 * Parallel per-id GETs; degrades to a partial/empty map on any failure or absent
 * creds (the admin queue then shows `email: null` rather than 500ing) — but
 * unlike the bare-map {@link fetchAuthUserEmails} wrapper, this says WHY, so a
 * surface can render "unavailable" instead of asserting "no email on file". See
 * {@link AuthEmailLookup}.
 *
 * `reason: 'error'` is reported if ANY id failed, even when others succeeded: a
 * partial map is still a degraded answer, and a caller labelling a per-row blank
 * as authoritative would be wrong for exactly the rows that failed.
 *
 * An account with no email on file is absent from `emails` but PRESENT in the
 * underlying record map — the projection to `Map<string, string>` is what loses
 * that distinction, which is why {@link fetchAuthUserRecords} exists.
 */
export async function fetchAuthUserEmailsResult(
  env: Env,
  userIds: readonly string[],
): Promise<AuthEmailLookup> {
  const { available, records, reason } = await fanOutAuthUsers(env, userIds, 'fetchAuthUserEmails');
  const emails = new Map<string, string>();
  for (const [id, record] of records) if (record.email) emails.set(id, record.email);
  return { available, emails, reason };
}

/**
 * Seam #2, record form (AECI-692).
 *
 * The same HTTP contract as {@link fetchAuthUserEmailsResult}, projecting the
 * whole account rather than just the address — `last_sign_in_at` in particular,
 * which the by-id lookup has always returned and every caller until now
 * discarded.
 *
 * Presence in the map is itself information: an id ABSENT while `available` is
 * `true` has no `auth.users` row at all. Callers rendering a person must keep
 * that separate from "the seam is down" and from "the field is empty" — see
 * {@link AuthRecordLookup}.
 */
export async function fetchAuthUserRecords(
  env: Env,
  userIds: readonly string[],
): Promise<AuthRecordLookup> {
  return fanOutAuthUsers(env, userIds, 'fetchAuthUserRecords');
}

/**
 * Bare-map form of {@link fetchAuthUserEmailsResult} (seam #2).
 *
 * **Keep this signature byte-identical.** It is not merely a convenience: four
 * structural type aliases — `FetchReviewerEmails` (`routes/admin-reviews.ts`)
 * and `FetchSeatEmails` (`routes/vendor.ts`, `lib/entitlement-expiry.ts`,
 * `lib/attestation-notify.ts`) — are declared as
 * `(env, ids) => Promise<Map<string, string>>` and take this function as their
 * injection default, so every spec that swaps in a fake is typed against it.
 * Callers that need to distinguish "seam unavailable" from "no email on file"
 * use the `Result` form directly.
 */
export async function fetchAuthUserEmails(
  env: Env,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  return (await fetchAuthUserEmailsResult(env, userIds)).emails;
}

/** The slice of a GoTrue `auth.users` row the identity seams surface. */
export interface AuthUserRef {
  id: string;
  /** The email as GoTrue stores it (already lowercased on its side). */
  email: string;
}

export interface FindAuthUserResult {
  ok: boolean;
  /** The exact-match user, or `null` when no auth user owns this email. */
  user: AuthUserRef | null;
  /** True when Supabase admin creds were absent and the call was skipped. A
   *  caller MUST NOT read this as "no such user" — resolution is impossible
   *  here, not negative. */
  skipped?: boolean;
  status?: number;
  error?: string;
}

/**
 * Shape of the subset of a GoTrue user object these seams read.
 *
 * Widened by AECI-692 with the three account timestamps `fetchAuthUserRecords`
 * surfaces. It stays PRIVATE and `toAuthUserRef` still reads only `{id, email}`,
 * so the exported {@link AuthUserRef} — returned by `findAuthUserByEmail` and
 * `createAuthUser` — is unchanged. One type per JSON object: a second
 * `RawGoTrueAccount` would be a second description of the same payload, which is
 * the thing that drifts.
 */
interface RawGoTrueUser {
  id?: unknown;
  email?: unknown;
  last_sign_in_at?: unknown;
  created_at?: unknown;
  email_confirmed_at?: unknown;
}

function toAuthUserRef(raw: RawGoTrueUser | null | undefined): AuthUserRef | null {
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.email !== 'string' || !raw.email) return null;
  return { id: raw.id, email: raw.email };
}

/**
 * Resolve an email → `auth.users` row via the GoTrue Admin API (seam #4a,
 * AECI-527 / `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2). Never throws.
 *
 * GoTrue has NO by-email endpoint. `GET /admin/users?filter=q` runs
 * `WHERE (email LIKE '%q%' OR raw_user_meta_data->>'full_name' ILIKE '%q%')` — a
 * case-SENSITIVE substring match that ALSO hits display names. So we query with
 * the lowercased address (GoTrue stores lowercase) and then require an exact,
 * case-insensitive equality on `users[].email` client-side. That second step is
 * load-bearing, not defensive: without it `jane@acme.com` matches
 * `jane@acme.com.evil.io`, and any account whose `full_name` happens to contain
 * the string — i.e. a claim would be granted against the WRONG auth user.
 *
 * There is deliberately no retry with the caller's original casing. A mixed-case
 * stored row is unreachable via GoTrue's own signup path, and the hypothetical
 * (an out-of-band import) is caught safely downstream instead: `createAuthUser`
 * returns `422 email_exists`, `resolveClaimantIdentity` re-looks-up once, and a
 * second miss surfaces an explicit error rather than a silent overwrite (§2).
 */
export async function findAuthUserByEmail(env: Env, email: string): Promise<FindAuthUserResult> {
  const cfg = adminConfig(env);
  if (!cfg) return { ok: true, skipped: true, user: null };

  const needle = normalizeEmail(email);
  if (!isPlausibleEmail(needle)) return { ok: true, user: null };

  try {
    const res = await fetch(`${cfg.url}/auth/v1/admin/users?filter=${encodeURIComponent(needle)}`, {
      headers: adminHeaders(cfg.key),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, user: null, status: res.status, error: await res.text().catch(() => '') };
    }
    const body = (await res.json()) as { users?: unknown };
    if (!Array.isArray(body.users)) {
      return { ok: false, user: null, status: res.status, error: 'malformed response' };
    }
    const match = (body.users as RawGoTrueUser[]).find(
      (u) => typeof u?.email === 'string' && normalizeEmail(u.email) === needle,
    );
    return { ok: true, user: toAuthUserRef(match), status: res.status };
  } catch (error) {
    return { ok: false, user: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CreateAuthUserResult {
  ok: boolean;
  user: AuthUserRef | null;
  /** 422 `email_exists` — a user already owns this email, so the seam-#4a lookup
   *  missed it (a concurrent create, or a row the substring filter can't reach).
   *  A race/miss to re-resolve, not an operator-actionable failure. */
  alreadyExists?: boolean;
  /** True when Supabase admin creds were absent and the call was skipped. */
  skipped?: boolean;
  status?: number;
  error?: string;
}

/**
 * Provision an `auth.users` row for an email via the GoTrue Admin API (seam #4b,
 * AECI-527). Creates the account as already-confirmed, so the claimant can sign
 * in immediately through the existing magic-link flow. Never throws.
 *
 * WHY NOT `POST /auth/v1/invite`: that endpoint sends GoTrue's own "Invite user"
 * email, whose link lands on `/auth/v1/verify?type=invite&redirect_to=…` and
 * redirects with the session in a URL FRAGMENT. `apps/web`'s `/auth/callback`
 * requires a PKCE `?code=` and 302s to `/auth/login?error=missing_code`
 * otherwise, so that link dead-ends today. It would also need two
 * Supabase-dashboard steps (the Invite-user template + a `redirect_to`
 * allow-list entry) on the ONE shared auth project that backs production
 * (ADR 0017) — editing them changes prod. Instead the account is created
 * silently and onboarding comms are the `claim-approved` Resend email
 * (AECI-528), which we control end-to-end; the launch claim flow is concierge
 * (`STAGE_2_SPEC.md` §8.1), so a human is already in the loop.
 *
 * Switching to the GoTrue invite later is a change to THIS FUNCTION only — the
 * `resolveClaimantIdentity` contract and its `invited` outcome are unaffected.
 * See `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2 and `docs/email.md`.
 */
export async function createAuthUser(env: Env, email: string): Promise<CreateAuthUserResult> {
  const cfg = adminConfig(env);
  if (!cfg) return { ok: true, skipped: true, user: null };

  const address = normalizeEmail(email);
  if (!isPlausibleEmail(address)) {
    return { ok: false, user: null, error: 'invalid email' };
  }

  try {
    const res = await fetch(`${cfg.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { ...adminHeaders(cfg.key), 'content-type': 'application/json' },
      // `email_confirm` marks the address verified without a click, so the
      // magic-link sign-in works on the claimant's first attempt.
      body: JSON.stringify({ email: address, email_confirm: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 422 && text.includes('email_exists')) {
        return { ok: false, user: null, alreadyExists: true, status: 422, error: text };
      }
      return { ok: false, user: null, status: res.status, error: text };
    }
    const user = toAuthUserRef((await res.json()) as RawGoTrueUser);
    if (!user) return { ok: false, user: null, status: res.status, error: 'malformed response' };
    return { ok: true, user, status: res.status };
  } catch (error) {
    return { ok: false, user: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Batched "does an auth user already exist for this email?" for the admin claim
 * queue — the AECI-527 reviewer signal, rendered by AECI-521. Exact sibling of
 * {@link fetchAuthUserEmails}: parallel per-email lookups, and a BARE map
 * because for a page-wide read the partial map IS the degrade.
 *
 * Keyed by the caller's input string VERBATIM so call sites never re-normalize,
 * while deduping case-insensitively so two spellings of one address cost one
 * request. An ABSENT key means "unknown" (`has_auth_account: null`) — never
 * `false`. That distinction is the whole point of the tri-state: a failed lookup
 * must not read to the reviewer as "this claimant has no account".
 *
 * **Every address is still looked up** — `perPage` caps the page at 100
 * (`PageQuerySchema`) and none of those lookups is dropped, because a truncated
 * sweep would make "signal suppressed" indistinguishable from "creds absent"
 * and the tri-state above depends on that distinction.
 *
 * What IS capped is how many run at once (AECI-666). A Worker invocation may
 * hold only {@link WORKER_CONNECTION_LIMIT} connections waiting for response
 * headers, so a bare `Promise.all` over a full page opened ~17x that from a
 * single request; past the limit the runtime cancels the stalled responses into
 * `fetch` promises that never settle, and the whole lookup vanishes with no
 * error. `mapWithConcurrency` runs the same 100 lookups in waves of six, so the
 * result set is identical and only the burst is gone.
 */
export async function fetchAuthAccountsByEmail(
  env: Env,
  emails: readonly string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const cfg = adminConfig(env);
  if (!cfg) {
    warnSeam(
      'fetchAuthAccountsByEmail',
      'no_credentials',
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY',
    );
    return out;
  }

  // normalized address → every original spelling that produced it.
  const groups = new Map<string, string[]>();
  for (const raw of emails) {
    const normalized = normalizeEmail(raw);
    if (!isPlausibleEmail(normalized)) continue;
    const spellings = groups.get(normalized);
    if (spellings) spellings.push(raw);
    else groups.set(normalized, [raw]);
  }
  if (groups.size === 0) return out;

  await mapWithConcurrency(
    [...groups],
    WORKER_CONNECTION_LIMIT,
    async ([normalized, spellings]) => {
      const res = await findAuthUserByEmail(env, normalized);
      // `!ok` or `skipped` → leave the group absent so the caller reports
      // "unknown" rather than asserting the account does not exist. Warn on the
      // way past: this is where the status and error text used to vanish, which
      // is what made a bad service-role key indistinguishable from a claimant
      // who genuinely has no account.
      if (!res.ok || res.skipped) {
        warnSeam(
          'fetchAuthAccountsByEmail',
          res.skipped ? 'no_credentials' : `http_${res.status ?? 'error'}`,
          res.error,
        );
        return;
      }
      for (const spelling of spellings) out.set(spelling, res.user !== null);
    },
  );
  return out;
}
