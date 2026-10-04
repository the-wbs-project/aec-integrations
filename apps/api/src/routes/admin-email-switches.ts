/**
 * `/admin/email` sending switches (AECI-1224). Source of truth: `docs/ADMIN_PANEL_SPEC.md`
 * §5.14 "Sending switches", §6 and §13 D24; `docs/API_CONTRACTS.md` §6.10 "Sending switches".
 *
 *   GET /api/admin/email/switches        every email entry plus the support copy
 *   PUT /api/admin/email/switches/:key   pause or resume one, on this tier
 *
 * Both behind `requireAdmin()` in `index.ts`. The PUT also carries `rateLimit('write')`
 * after the guard (`waf-rate-limits.md` §6.2). The GET is a read: no audit row, no limiter.
 *
 * ─── The PUT, in order ────────────────────────────────────────────────────────
 *
 *   1. Resolve the key. Unknown is a 404. A registry id of any channel resolves, so a
 *      portal or Linear id gets the honest answer, "not pausable", rather than "not found".
 *   2. `enabled: false` on a non-pausable entry is 400 `NOTIFICATION_NOT_PAUSABLE`.
 *      Resuming one is allowed, so a row left from before it became always-on can be cleared.
 *   3. Read the current state. Naming it again is a 200 that writes nothing.
 *   4. ONE `db.batch`: the race sentinel, the upsert, the `audit_log` row (§26.1). A
 *      sentinel abort is 409 `NOTIFICATION_SWITCH_CHANGED`.
 *   5. The post-commit PostHog forward in `waitUntil`. No cache purge: no public page reads
 *      `notification_settings`.
 */

import {
  AdminEmailSwitchesResponseSchema,
  ApiErrorCode,
  SetAdminEmailSwitchBodySchema,
  SetAdminEmailSwitchResponseSchema,
  type AdminEmailSwitch,
  type AdminEmailSwitchesResponse,
  type SetAdminEmailSwitchResponse,
} from '@aeci/shared';
import { forwardAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { logToPosthog } from '../posthog';
import type { BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { parseRecipients } from '../lib/email';
import { emailTemplates } from '../lib/admin-email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { tierLabel } from '../lib/notifications/delivery-policy';
import {
  isSwitchRaceError,
  readSwitchRows,
  resolveSwitchKey,
  SUPPORT_COPY_KEY,
  switchWriteStatements,
  type SwitchRow,
} from '../lib/notifications/switches';

type SwitchContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

const AUDIT_SOURCE = 'admin-email-switches';

export interface AdminEmailSwitchDeps {
  now?: () => Date;
}

/** One switch as the API reports it. A non-pausable entry always reads as enabled: the
 *  transport ignores a paused row for it, so reporting the row would be a false statement. */
function toSwitch(key: string, row: SwitchRow | undefined): AdminEmailSwitch {
  const resolved = resolveSwitchKey(key)!;
  const entry = resolved.entry;
  return {
    key,
    kind: resolved.kind,
    summary: entry?.summary ?? null,
    audience: entry?.audience ?? null,
    pausable: resolved.pausable,
    enabled: resolved.pausable ? (row?.enabled ?? true) : true,
    updated_at: row?.updatedAt ?? null,
    updated_by: row?.updatedBy ?? null,
  };
}

async function readAll(db: Db): Promise<AdminEmailSwitch[]> {
  const rows = await readSwitchRows(db);
  return [SUPPORT_COPY_KEY, ...emailTemplates().map((t) => t.id)].map((key) =>
    toSwitch(key, rows.get(key)),
  );
}

/** `GET /api/admin/email/switches`. */
export function createAdminEmailSwitchesHandler(
  dbFor: DbFactory = getDb,
  deps: AdminEmailSwitchDeps = {},
): (c: SwitchContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const { db } = dbFor(c.env);
    const body: AdminEmailSwitchesResponse = {
      generated_at: clock().toISOString(),
      environment: tierLabel(c.env),
      support_copy_configured: parseRecipients(c.env.EMAIL_BCC).length > 0,
      switches: await readAll(db),
    };
    validateResponseInDev(c.env, () => {
      AdminEmailSwitchesResponseSchema.parse(body);
    });
    return json(body);
  };
}

function makeForwarder(c: SwitchContext): AuditLogForwarder | undefined {
  if (!c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: AUDIT_SOURCE,
    });
  };
}

/** `PUT /api/admin/email/switches/:key`. */
export function createSetAdminEmailSwitchHandler(
  dbFor: DbFactory = getDb,
  deps: AdminEmailSwitchDeps = {},
): (c: SwitchContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const session = c.get('auth');
    const key = c.req.param('key') ?? '';

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
    }
    const payload = SetAdminEmailSwitchBodySchema.parse(raw);

    // ── 1. Resolve ───────────────────────────────────────────────────────────
    const resolved = resolveSwitchKey(key);
    if (!resolved) throw notFoundError('notification_setting', { id: key });

    // ── 2. Protected mail ────────────────────────────────────────────────────
    if (!payload.enabled && !resolved.pausable) {
      throw new ApiError(
        400,
        ApiErrorCode.NOTIFICATION_NOT_PAUSABLE,
        `${key} cannot be paused. The registry marks it always on.`,
        { field: 'key' },
      );
    }

    // ── 3. Current state ─────────────────────────────────────────────────────
    const { db } = writeDb(c, dbFor);
    const rows = await readSwitchRows(db);
    const stored = rows.get(key);
    // The stored value, not the reported one: resuming a stale paused row on a
    // non-pausable entry must write, or the row would never clear.
    const from = stored?.enabled ?? true;
    const to = payload.enabled;
    if (from === to) {
      const body: SetAdminEmailSwitchResponse = { switch: toSwitch(key, stored), changed: false };
      validateResponseInDev(c.env, () => {
        SetAdminEmailSwitchResponseSchema.parse(body);
      });
      return json(body);
    }

    // ── 4. ONE batch ─────────────────────────────────────────────────────────
    const now = clock().toISOString();
    const { stmts, auditEntry } = switchWriteStatements(db, {
      key,
      from,
      to,
      actorId: session.userId,
      actorType: auditActorType(session),
      tier: tierLabel(c.env),
      ...(payload.reason ? { reason: payload.reason } : {}),
      now,
    });
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isSwitchRaceError(error)) {
        throw new ApiError(
          409,
          ApiErrorCode.NOTIFICATION_SWITCH_CHANGED,
          'This switch changed since the page loaded. Reload to see where it stands.',
        );
      }
      throw error;
    }

    // ── 5. Post-commit forward ───────────────────────────────────────────────
    c.executionCtx.waitUntil(forwardAuditLog(auditEntry, makeForwarder(c)));

    const body: SetAdminEmailSwitchResponse = {
      switch: toSwitch(key, { enabled: to, updatedAt: now, updatedBy: session.userId }),
      changed: true,
    };
    validateResponseInDev(c.env, () => {
      SetAdminEmailSwitchResponseSchema.parse(body);
    });
    return json(body);
  };
}
