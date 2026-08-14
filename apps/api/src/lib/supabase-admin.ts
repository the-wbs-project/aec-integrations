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
 */

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
    if (res.ok || res.status === 404) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: await res.text().catch(() => '') };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolve emails for the given auth user ids via the GoTrue Admin API (seam #2).
 * Parallel per-id GETs; degrades to a partial/empty map on any failure or absent
 * creds (the admin queue then shows `reviewer_email: null` rather than 500ing).
 */
export async function fetchAuthUserEmails(
  env: Env,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cfg = adminConfig(env);
  const ids = [...new Set(userIds)].filter((id) => id.length > 0);
  if (!cfg || ids.length === 0) return out;

  await Promise.all(
    ids.map(async (id) => {
      try {
        const res = await fetch(`${cfg.url}/auth/v1/admin/users/${encodeURIComponent(id)}`, {
          headers: adminHeaders(cfg.key),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return;
        const user = (await res.json()) as { email?: unknown };
        if (typeof user.email === 'string' && user.email) out.set(id, user.email);
      } catch {
        /* degrade — leave this id absent from the map */
      }
    }),
  );
  return out;
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

/** Shape of the subset of a GoTrue user object these seams read. */
interface RawGoTrueUser {
  id?: unknown;
  email?: unknown;
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
 * Uncapped fan-out, deliberately: `perPage` caps the page at 100
 * (`PageQuerySchema`), `fetchAuthUserEmails` already fans out page-wide at the
 * same magnitude, and a cap would make "signal suppressed" indistinguishable
 * from "creds absent".
 */
export async function fetchAuthAccountsByEmail(
  env: Env,
  emails: readonly string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const cfg = adminConfig(env);
  if (!cfg) return out;

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

  await Promise.all(
    [...groups].map(async ([normalized, spellings]) => {
      const res = await findAuthUserByEmail(env, normalized);
      // `!ok` or `skipped` → leave the group absent so the caller reports
      // "unknown" rather than asserting the account does not exist.
      if (!res.ok || res.skipped) return;
      for (const spelling of spellings) out.set(spelling, res.user !== null);
    }),
  );
  return out;
}
