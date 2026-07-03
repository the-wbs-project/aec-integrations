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
 */

import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { profiles } from '../db/schema';
import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { json } from '../http';
import { auditInsert } from '../lib/audit';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import type { UserAuthVariables } from '../lib/user-auth';

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. */
function makeForwarder(
  c: Context<{ Bindings: Env; Variables: UserAuthVariables }>,
): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
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
