/**
 * Supabase GoTrue Admin API client — the split-identity seam (ADR 0016 / AECI-254).
 *
 * Under D1, the application store no longer shares a database with Supabase Auth,
 * so the two `auth.users` couplings that used a privileged Postgres query now go
 * over HTTPS to the GoTrue Admin API with the service-role key:
 *   - seam #2: reviewer email reads for the admin moderation queue.
 *   - seam #3: GDPR erasure of the `auth.users` row on account deletion.
 *
 * Both DEGRADE GRACEFULLY when `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are
 * absent (local `wrangler dev`, PR previews): emails resolve to a partial/empty
 * map, and the auth-user delete is skipped (the D1 data erasure still happened).
 * Neither throws — the caller decides how to surface a failure.
 */

import type { Env } from '../env';

function adminConfig(env: Env): { url: string; key: string } | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: env.SUPABASE_URL.replace(/\/$/, ''), key: env.SUPABASE_SERVICE_ROLE_KEY };
}

function adminHeaders(key: string): HeadersInit {
  return { apikey: key, Authorization: `Bearer ${key}` };
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
