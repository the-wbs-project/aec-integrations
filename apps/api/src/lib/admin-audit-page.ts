/**
 * One page of an entity's audit trail, shaped for `<aec-audit-trail>`.
 *
 * Shared by the single-disjunct admin audit reads: the connector catalogue's
 * (`GET /api/admin/connector-catalogs/:id/audit`) and the claim's
 * (`GET /api/admin/claims/:id/audit`, AECI-1276). Each caller owns its own 404
 * gate and its own `where`. This reader owns everything after the gate: the page
 * and count `db.batch`, the actor-name lookup, the email seam, and the row
 * mapping. The vendor trail (`admin-vendors.ts`) keeps its own code because it
 * ORs four disjuncts and carries a scope filter.
 *
 * Ordered `created_at DESC, id DESC`. The tiebreaker matters: `created_at` is a
 * JS-stamped ISO string and two rows from one `db.batch` routinely share a
 * millisecond.
 */

import type { AdminAuditRow } from '@aeci/shared';
import { count, desc, inArray, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { auditLog, profiles } from '../db/schema';
import type { Env } from '../env';
import type { AuthEmailLookup } from './supabase-admin';

/** The email seam in its availability-reporting form. */
export type FetchAuthEmails = (env: Env, ids: readonly string[]) => Promise<AuthEmailLookup>;

export interface AdminAuditPage {
  data: AdminAuditRow[];
  page: number;
  perPage: number;
  total: number;
  actor_emails_available: boolean;
}

export async function readAdminAuditPage(
  db: Db,
  env: Env,
  where: SQL | undefined,
  query: { page: number; perPage: number },
  fetchEmails: FetchAuthEmails,
): Promise<AdminAuditPage> {
  const [rows, totals] = await db.batch([
    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actorId: auditLog.actorId,
        actorType: auditLog.actorType,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        createdAt: auditLog.createdAt,
        beforeState: auditLog.beforeState,
        afterState: auditLog.afterState,
      })
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage),
    db.select({ value: count() }).from(auditLog).where(where),
  ]);

  // Bounded by `perPage`, not by how much history the entity has.
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((v): v is string => !!v))];
  const [actorRows, lookup] = await Promise.all([
    actorIds.length === 0
      ? Promise.resolve([] as { id: string; displayName: string | null }[])
      : db
          .select({ id: profiles.id, displayName: profiles.displayName })
          .from(profiles)
          .where(inArray(profiles.id, actorIds)),
    fetchEmails(env, actorIds),
  ]);
  const namesById = new Map(actorRows.map((r) => [r.id, r.displayName]));

  return {
    data: rows.map(
      (row): AdminAuditRow => ({
        id: row.id,
        action: row.action,
        // A row with no actor id (a sync run, a workflow step, an anonymous
        // submission) is `null`. `null` means "not a known person", never
        // "person unknown".
        actor: row.actorId
          ? {
              id: row.actorId,
              display_name: namesById.get(row.actorId) ?? null,
              email: lookup.emails.get(row.actorId) ?? null,
            }
          : null,
        actor_type: row.actorType,
        entity_type: row.entityType,
        entity_id: row.entityId,
        created_at: row.createdAt,
        before_state: row.beforeState ?? null,
        after_state: row.afterState ?? null,
      }),
    ),
    page: query.page,
    perPage: query.perPage,
    total: totals[0]?.value ?? 0,
    actor_emails_available: lookup.available,
  };
}
