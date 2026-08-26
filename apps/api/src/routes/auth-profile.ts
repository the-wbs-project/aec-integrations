/**
 * `POST /api/auth/profile/ensure` (AECI-195 / Phase 5.4) — Drizzle/D1 (ADR 0016).
 *
 * Idempotent profile provisioning (split-identity seam #1, AECI-251/254). Under
 * D1 there is no `handle_new_user` trigger, so this endpoint is the PRIMARY
 * profile creator (productionised in Phase 3): `requireUserAuth()` runs first, so
 * the row id is always the verified token's `sub`.
 *
 * `INSERT … ON CONFLICT DO NOTHING … RETURNING` makes the race correct: only the
 * insert that actually created the row gets a returned id (`created=true`) and
 * writes the `profile.created` audit; a concurrent loser (or a re-run) returns []
 * → `created=false` → no audit. The audit follows the committed insert (the §26.1
 * atomicity is relaxed only for this idempotent backstop; domain state changes
 * use `db.batch`).
 *
 * NO-CLOBBER CONTRACT (AECI-527 / `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2). This
 * insert writes ONLY `id` and never updates on conflict, so a vendor-claim grant
 * that landed BEFORE the claimant's first sign-in survives it: `role`
 * (`vendor_admin`), `vendor_id`, `display_name`, and `theme_preference` are all
 * preserved. That is what lets AECI-519 grant a seat to an account that has never
 * logged in. Do NOT add columns to `.values()` and do NOT convert this to
 * `onConflictDoUpdate` — `auth-profile.spec.ts` regression-tests the property.
 */

import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { profiles } from '../db/schema';
import { logToPosthog } from '../posthog';
import type { Env } from '../env';
import { json } from '../http';
import { auditInsert } from '../lib/audit';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import type { UserAuthVariables } from '../lib/user-auth';

/** Telemetry forwarder (PostHog + the dual-run Datadog leg) for the audit write; each vendor leg no-ops without its own key. */
function makeForwarder(
  c: Context<{ Bindings: Env; Variables: UserAuthVariables }>,
): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY && !c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'auth-callback',
    });
  };
}

export function createEnsureProfileHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env; Variables: UserAuthVariables }>) => Promise<Response> {
  return async (c) => {
    const { userId } = c.get('user');
    const { db } = writeDb(c, dbFor);

    const inserted = await db
      .insert(profiles)
      .values({ id: userId })
      .onConflictDoNothing()
      .returning({ id: profiles.id });
    const created = inserted.length > 0;

    if (created) {
      const auditEntry: AuditLogEntry = {
        actorId: userId,
        actorType: 'user',
        action: 'profile.created',
        entityType: 'profile',
        entityId: userId,
        metadata: { source: 'auth-callback' },
      };
      await auditInsert(db, auditEntry);
      c.executionCtx.waitUntil(forwardAuditLog(auditEntry, makeForwarder(c)));
    }

    return json({ created });
  };
}
