/**
 * AECI-202 — integration test for `DELETE /api/account` (GDPR right-to-erasure)
 * against a real Supabase/Postgres stack.
 *
 * This is the gate that proves the erasure works end-to-end with the REAL FK
 * engine + the `on_auth_user_deleted` trigger — the thing the fake-Prisma unit
 * test cannot exercise. A real reviewer is seeded with the exact references that
 * would otherwise FK-block the profile delete (a `review`, an `audit_log` row,
 * and a `page_view`, all pointing at the profile), then the real handler runs.
 *
 * It asserts the four AECI-202 acceptance guarantees:
 *   1. reviews are ANONYMIZED (`reviewer_id` → null), not deleted;
 *   2. the `profiles` row AND the `auth.users` row are gone;
 *   3. the historical `audit_log` / `page_view` rows survive with their actor /
 *      user references nulled (the synchronous "sweep" of AUTH_AND_RLS §8);
 *   4. an `account.deleted` audit row exists with a NULL actor and no PII.
 *
 * It also implicitly validates that the privileged connection can run the raw
 * `DELETE FROM auth.users` (the Q1 decision) — though here that connection is
 * `TEST_DATABASE_URL` (the same direct-Postgres role the AECI-69 harness uses,
 * which already proves a direct `DELETE FROM auth.users` fires the trigger).
 * The production Accelerate role is verified by the manual run in the PR.
 *
 * Env vars (see apps/api/.dev.vars.example), `describe.skipIf` keeps CI silent:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_DATABASE_URL.
 */

import { PrismaClient } from '@prisma/client';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { createDeleteAccountHandler } from '../routes/account';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testDbUrl = process.env.TEST_DATABASE_URL;

const TEST_RUN_TAG = `aeci202-${Date.now()}`;

interface AdminUserResponse {
  id: string;
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
  if (!res.ok) throw new Error(`adminCreateUser failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as AdminUserResponse).id;
}

async function adminDeleteUser(id: string): Promise<void> {
  await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: serviceRoleKey!, Authorization: `Bearer ${serviceRoleKey}` },
  });
}

function executionCtxStub(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as ExecutionContext;
}

/** Mount the real handler behind a middleware injecting the verified session. */
function deleteApp(prisma: PrismaClient, authId: string) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/account', async (c, next) => {
    c.set('auth', { userId: authId, email: `${authId}@example.com`, role: 'reviewer' });
    await next();
  });
  app.delete(
    '/api/account',
    createDeleteAccountHandler(() => prisma as never),
  );
  return app;
}

describe.skipIf(!supabaseUrl || !serviceRoleKey || !testDbUrl)(
  'DELETE /api/account erasure (AECI-202)',
  () => {
    let prisma: PrismaClient;
    const createdAuthIds: string[] = [];
    let productId: string | undefined;

    beforeAll(() => {
      prisma = new PrismaClient({ datasourceUrl: testDbUrl });
    });

    afterAll(async () => {
      // Best-effort cleanup. The user's profile + auth row are gone on success;
      // sweep the seeded product + any audit/page/review rows (now null-ref'd).
      for (const id of createdAuthIds) {
        try {
          await adminDeleteUser(id);
        } catch {
          /* already gone */
        }
        await prisma.auditLog.deleteMany({ where: { entityId: id } });
        await prisma.review.deleteMany({ where: { title: { startsWith: TEST_RUN_TAG } } });
        await prisma.pageView.deleteMany({ where: { path: { startsWith: `/${TEST_RUN_TAG}` } } });
        await prisma.profile.deleteMany({ where: { id } });
      }
      if (productId) await prisma.product.deleteMany({ where: { id: productId } });
      await prisma.$disconnect();
    });

    it('anonymizes reviews, removes profile + auth user, nulls refs, audits the erasure', async () => {
      // 1. Create the auth user → on_auth_user_created makes the profile.
      const authId = await adminCreateUser(`${TEST_RUN_TAG}@example.com`);
      createdAuthIds.push(authId);
      expect(await prisma.profile.findUnique({ where: { id: authId } })).not.toBeNull();

      // 2. Seed the references that would FK-block a naive profile delete.
      const product = await prisma.product.create({
        data: { slug: `${TEST_RUN_TAG}-product`, name: `${TEST_RUN_TAG} Product` },
        select: { id: true },
      });
      productId = product.id;
      const review = await prisma.review.create({
        data: {
          productId: product.id,
          reviewerId: authId,
          ratingOverall: 4,
          ratingOnboarding: 5,
          title: `${TEST_RUN_TAG} review`,
          body: 'Body content that survives erasure because the author is anonymized, not deleted.',
        },
        select: { id: true },
      });
      const audit = await prisma.auditLog.create({
        data: {
          actorId: authId,
          actorType: 'user',
          action: 'review.submitted',
          entityType: 'review',
        },
        select: { id: true },
      });
      const pageView = await prisma.pageView.create({
        data: { path: `/${TEST_RUN_TAG}/page`, userId: authId },
        select: { id: true },
      });

      // 3. Run the real erasure handler.
      const res = await deleteApp(prisma, authId).request(
        '/api/account',
        { method: 'DELETE' },
        { DD_API_KEY: undefined } as Env,
        executionCtxStub(),
      );
      expect(res.status).toBe(200);

      // 4a. Profile + auth user are gone.
      expect(await prisma.profile.findUnique({ where: { id: authId } })).toBeNull();
      const authRows = await prisma.$queryRaw<
        { id: string }[]
      >`SELECT id FROM auth.users WHERE id = ${authId}::uuid`;
      expect(authRows).toHaveLength(0);

      // 4b. Review survives, ANONYMIZED (content intact, reviewer nulled).
      const reviewAfter = await prisma.review.findUnique({ where: { id: review.id } });
      expect(reviewAfter).not.toBeNull();
      expect(reviewAfter?.reviewerId).toBeNull();
      expect(reviewAfter?.body).toContain('survives erasure');

      // 4c. Historical audit + page_view rows survive with refs nulled.
      const auditAfter = await prisma.auditLog.findUnique({ where: { id: audit.id } });
      expect(auditAfter?.actorId).toBeNull();
      const pageAfter = await prisma.pageView.findUnique({ where: { id: pageView.id } });
      expect(pageAfter?.userId).toBeNull();

      // 4d. The erasure itself is audited — null actor, no PII.
      const erasure = await prisma.auditLog.findFirst({
        where: { action: 'account.deleted', entityId: authId },
      });
      expect(erasure).not.toBeNull();
      expect(erasure?.actorId).toBeNull();
      expect(JSON.stringify(erasure?.metadata ?? {})).not.toContain('@example.com');
    });
  },
);
