/**
 * AECI-204 (Phase 5.13) — integration proof that the admin moderation API's
 * reviewer-email lookup actually works against a real `auth.users`.
 *
 * `reviewer_email` lives only in `auth.users.email` (no column on
 * `profiles`/`reviews`). `routes/admin-reviews.ts` reads it with a parameterized
 * cross-schema `$queryRaw`, relying on the Worker's Accelerate connection being
 * a privileged Postgres role that can SELECT `auth.users` (`AUTH_AND_RLS.md`
 * §1). That privilege is unverifiable from the repo, so this test is the safety
 * net: if the role ever loses SELECT on `auth.users` (or the SQL drifts), the
 * real `fetchReviewerEmails` query fails here, before production.
 *
 * The direct `PrismaClient` (TEST_DATABASE_URL → the `postgres` role, the same
 * privileged class the Accelerate `DATABASE_URL` uses) exercises the exact
 * exported `fetchReviewerEmails` function — its `$queryRaw` is API-identical to
 * the edge client's, so a passing run here means the SQL (the
 * `string_to_array(...)::uuid[]` scalar-param form) and the grant are both good.
 *
 * Env vars (see apps/api/.dev.vars.example):
 *   SUPABASE_URL                — e.g. http://127.0.0.1:54321
 *   SUPABASE_SERVICE_ROLE_KEY   — service-role JWT (admin API user creation)
 *   TEST_DATABASE_URL           — direct postgresql:// URL to the same Postgres
 *
 * `describe.skipIf` keeps environments without these vars silent.
 */

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fetchReviewerEmails } from '../routes/admin-reviews';
import type { AcceleratedPrisma } from '../prisma';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testDbUrl = process.env.TEST_DATABASE_URL;

const TEST_RUN_TAG = `aeci204-${Date.now()}`;

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
  return ((await res.json()) as AdminUserResponse).id;
}

async function adminDeleteUser(id: string): Promise<void> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey!, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!res.ok) {
    throw new Error(`adminDeleteUser failed: ${res.status} ${await res.text()}`);
  }
}

describe.skipIf(!supabaseUrl || !serviceRoleKey || !testDbUrl)(
  'admin reviews: reviewer email read from auth.users (AECI-204)',
  () => {
    let prisma: PrismaClient;
    const createdAuthIds: string[] = [];

    beforeAll(() => {
      prisma = new PrismaClient({ datasourceUrl: testDbUrl });
    });

    afterAll(async () => {
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

    it('resolves emails for multiple reviewer ids, keyed by id', async () => {
      const emailA = `${TEST_RUN_TAG}-a@example.com`;
      const emailB = `${TEST_RUN_TAG}-b@example.com`;
      const idA = await adminCreateUser(emailA);
      const idB = await adminCreateUser(emailB);
      createdAuthIds.push(idA, idB);

      const map = await fetchReviewerEmails(prisma as unknown as AcceleratedPrisma, [idA, idB]);

      expect(map.get(idA)).toBe(emailA);
      expect(map.get(idB)).toBe(emailB);
    });

    it('omits ids with no matching auth.users row (no throw)', async () => {
      const email = `${TEST_RUN_TAG}-c@example.com`;
      const realId = await adminCreateUser(email);
      createdAuthIds.push(realId);

      const missingId = '00000000-0000-4000-8000-000000000000';
      const map = await fetchReviewerEmails(prisma as unknown as AcceleratedPrisma, [
        realId,
        missingId,
      ]);

      expect(map.get(realId)).toBe(email);
      expect(map.has(missingId)).toBe(false);
    });

    it('returns an empty map for an empty id list (no query)', async () => {
      const map = await fetchReviewerEmails(prisma as unknown as AcceleratedPrisma, []);
      expect(map.size).toBe(0);
    });
  },
);
