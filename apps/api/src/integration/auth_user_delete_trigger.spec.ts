/**
 * AECI-69 — integration test for the auth → public DELETE sync trigger.
 *
 * Verifies that deleting a row from `auth.users` cleans up the matching
 * `public.profiles` row via the `on_auth_user_deleted` trigger introduced
 * in `supabase/migrations/20260526083101_drop_profiles_auth_fk_add_delete_trigger.sql`.
 *
 * Two paths are exercised:
 *
 *   1. Supabase admin API delete — `DELETE /auth/v1/admin/users/:id`. This
 *      is the production code path (we'd never `DELETE FROM auth.users`
 *      directly from app code) and it routes through gotrue.
 *
 *   2. Direct SQL `DELETE FROM auth.users` via Prisma's `$executeRaw`.
 *      Proves the trigger fires regardless of caller, catching the case
 *      where the admin API uses some indirect cleanup mechanism that
 *      would mask a broken trigger.
 *
 * Both paths start by creating an auth user via the admin API — the
 * existing `on_auth_user_created` INSERT trigger then creates the
 * matching profile row, which we assert exists before we delete.
 *
 * Env vars (see apps/api/.dev.vars.example):
 *   SUPABASE_URL                — e.g. http://127.0.0.1:54321
 *   SUPABASE_SERVICE_ROLE_KEY   — service-role JWT (local Supabase
 *                                 exposes it as the "Secret" key in
 *                                 `pnpm exec supabase status`)
 *   TEST_DATABASE_URL           — direct postgresql:// URL to the same
 *                                 Postgres the Supabase stack uses
 *                                 (typically postgresql://postgres:postgres@127.0.0.1:54322/postgres)
 *
 * `describe.skipIf` keeps environments without these vars silent.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testDbUrl = process.env.TEST_DATABASE_URL;

const TEST_RUN_TAG = `aeci69-${Date.now()}`;

interface AdminUserResponse {
  id: string;
  email?: string;
}

async function adminCreateUser(email: string): Promise<string> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password: `pw-${TEST_RUN_TAG}-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`adminCreateUser failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as AdminUserResponse;
  return body.id;
}

async function adminDeleteUser(id: string): Promise<void> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey!,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`adminDeleteUser failed: ${res.status} ${await res.text()}`);
  }
}

describe.skipIf(!supabaseUrl || !serviceRoleKey || !testDbUrl)(
  'auth.users -> public.profiles sync triggers (AECI-69)',
  () => {
    let prisma: PrismaClient;
    const createdAuthIds: string[] = [];

    beforeAll(() => {
      prisma = new PrismaClient({ datasourceUrl: testDbUrl });
    });

    afterAll(async () => {
      // Best-effort cleanup of any auth users the test didn't get to delete
      // (e.g. when an assertion failed before the delete step). Profile rows
      // cascade via the trigger we're testing — but if that's broken, sweep
      // them too so subsequent runs start clean.
      for (const id of createdAuthIds) {
        try {
          await adminDeleteUser(id);
        } catch {
          // already gone — fine
        }
        await prisma.profile.deleteMany({ where: { id } });
      }
      await prisma.$disconnect();
    });

    it('on_auth_user_created creates a profiles row when an auth user is created', async () => {
      const email = `${TEST_RUN_TAG}-baseline@example.com`;
      const authId = await adminCreateUser(email);
      createdAuthIds.push(authId);

      const profile = await prisma.profile.findUnique({ where: { id: authId } });
      expect(profile).not.toBeNull();
      expect(profile?.id).toBe(authId);
    });

    it('on_auth_user_deleted removes the profiles row when the auth user is deleted via the admin API', async () => {
      const email = `${TEST_RUN_TAG}-admin@example.com`;
      const authId = await adminCreateUser(email);
      createdAuthIds.push(authId);

      // Sanity: profile row exists (INSERT trigger fired)
      const before = await prisma.profile.findUnique({ where: { id: authId } });
      expect(before).not.toBeNull();

      await adminDeleteUser(authId);

      const after = await prisma.profile.findUnique({ where: { id: authId } });
      expect(after).toBeNull();
    });

    it('on_auth_user_deleted fires for a direct DELETE FROM auth.users (not just the admin API)', async () => {
      const email = `${TEST_RUN_TAG}-direct@example.com`;
      const authId = await adminCreateUser(email);
      createdAuthIds.push(authId);

      const before = await prisma.profile.findUnique({ where: { id: authId } });
      expect(before).not.toBeNull();

      // Bypass gotrue: hit auth.users directly. This is the regression
      // we're protecting against — a future Supabase admin API change
      // that takes some alternate cleanup path would mask a broken trigger.
      const deleted = await prisma.$executeRawUnsafe(
        `DELETE FROM auth.users WHERE id = $1::uuid`,
        authId,
      );
      expect(deleted).toBe(1);

      const after = await prisma.profile.findUnique({ where: { id: authId } });
      expect(after).toBeNull();
    });
  },
);
