/**
 * Per-seat notification preferences (AECI-1204, `STAGE_2_ATTESTATIONS_SPEC.md` §7.2,
 * `API_CONTRACTS.md` §6.14).
 *
 *   - `GET /api/vendor/notification-preferences`: the caller's own seat's state.
 *     A read: no row is created, and no `rateLimit()`.
 *   - `PUT /api/vendor/notification-preferences`: set the caller's own mute.
 *   - `POST /api/notifications/nudges/mute`: the one-click mute from the digest
 *     footer and its RFC 8058 `List-Unsubscribe` header. Unauthenticated, keyed by
 *     the seat's opaque mute token.
 *   - `POST /api/notifications/marketing/mute` (AECI-1305): the one-click marketing
 *     opt-out from the `vendor-claim-nudge` footer and header. Unauthenticated, keyed
 *     by the account's opaque marketing token. Same shape as the nudge mute.
 *
 * **Scoping.** The vendor pair acts on `c.get('auth').userId`, the verified token
 * `sub`, which is the seat's `profiles.id`. No profile id is read from the request,
 * so a seat can only ever change its own preference, never a colleague's and never
 * another vendor's. The one-click route acts on whichever seat owns the token.
 *
 * **Audit.** Every change writes `notification_preferences.updated` in the same
 * `db.batch` as the write (`lib/notification-preferences.ts`). A no-op (setting the
 * state it already has) writes nothing.
 */

import {
  MarketingMuteSubmitSchema,
  NotificationPreferencesResponseSchema,
  NudgeMuteSubmitSchema,
  UpdateNotificationPreferencesSchema,
  type AuditLogEntry,
  type MarketingMuteResult,
  type NotificationPreferencesResponse,
  type NudgeMuteResult,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  findByMarketingMuteToken,
  findByMuteToken,
  isNudgeMuted,
  loadNudgePreferences,
  setMarketingMuted,
  setNudgesMuted,
  type NudgePreference,
} from '../lib/notification-preferences';
import { logBatchToPosthog } from '../posthog';
import {
  afterVendorWrite,
  parseJsonBody,
  type VendorContext,
  sessionVendorId,
  sessionVendorPlan,
} from './vendor-shared';

function toResponse(pref: NudgePreference | undefined): NotificationPreferencesResponse {
  return {
    nudges_muted: isNudgeMuted(pref),
    nudges_muted_at: pref?.nudgesMutedAt ?? null,
  };
}

/** `GET /api/vendor/notification-preferences`. */
export function createGetNotificationPreferencesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const profileId = c.get('auth').userId;
    const { db } = dbFor(c.env);
    const pref = (await loadNudgePreferences(db, [profileId])).get(profileId);
    const body = toResponse(pref);
    validateResponseInDev(c.env, () => NotificationPreferencesResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `PUT /api/vendor/notification-preferences`. Body `{ nudges_muted: boolean }`.
 * An unmute rotates the seat's mute token (`setNudgesMuted`), so a mute link in an
 * earlier digest cannot re-mute it. A mute keeps the token.
 */
export function createUpdateNotificationPreferencesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const input = await parseJsonBody(c, UpdateNotificationPreferencesSchema);
    const { db } = writeDb(c, dbFor);

    const { pref, entries } = await setNudgesMuted(db, {
      profileId: session.userId,
      muted: input.nudges_muted,
      actorId: session.userId,
      actorType: auditActorType(session),
      source: 'vendor-portal',
      vendorId: sessionVendorId(c),
      vendorPlan: sessionVendorPlan(c),
    });
    // No cache tag: nothing public renders a seat's preference.
    if (entries.length > 0) afterVendorWrite(c, [], entries);

    const body = toResponse(pref);
    validateResponseInDev(c.env, () => NotificationPreferencesResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `POST /api/notifications/nudges/mute` — the one-click mute (RFC 8058).
 *
 * Two callers, one handler, the `POST /api/unsubscribe` precedent:
 *   - the `/notifications/mute` page POSTs `{ token }` as JSON, from a click;
 *   - a mail client's one-click POSTs a form body (`List-Unsubscribe=One-Click`) to
 *     `…/api/notifications/nudges/mute?token=…`. The query token wins and the form
 *     body is ignored.
 *
 * Idempotent: a repeat keeps the original `nudges_muted_at` and still answers
 * `{ ok: true }`. An unknown token is `200 { ok: false }`. Tokens are unguessable,
 * so that leaks nothing, and a mail appliance reads any non-2xx as a broken
 * unsubscribe. Mute only: unmuting is the portal toggle's job, behind a session.
 */
export function createNudgeMuteHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const token = await readOneClickToken(c, NudgeMuteSubmitSchema);
    const { db } = writeDb(c, dbFor);
    const pref = await findByMuteToken(db, token);
    if (!pref) return json({ ok: false } satisfies NudgeMuteResult);

    const { entries } = await setNudgesMuted(db, {
      profileId: pref.profileId,
      muted: true,
      // Holding the token is the proof: the seat acted on its own preference.
      actorId: pref.profileId,
      actorType: 'user',
      source: 'one-click',
    });
    forwardOneClickAudit(c, entries, 'nudge-one-click');
    return json({ ok: true } satisfies NudgeMuteResult);
  };
}

/**
 * `POST /api/notifications/marketing/mute` — the one-click marketing opt-out (AECI-1305,
 * RFC 8058). The nudge mute above, for the other scope: the same two callers (the
 * `/notifications/mute?list=marketing` page POSTs `{ token }` as JSON, a mail client
 * POSTs a form body to `?token=`), the same idempotence, and `200 { ok: false }` for an
 * unknown token.
 *
 * It sets `marketing_muted_at` and nothing else. A nudge token here matches no row, and
 * a marketing token on the nudge route matches no row, so neither link can flip the
 * other setting. Mute only: there is no unmute surface yet.
 */
export function createMarketingMuteHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const token = await readOneClickToken(c, MarketingMuteSubmitSchema);
    const { db } = writeDb(c, dbFor);
    const pref = await findByMarketingMuteToken(db, token);
    if (!pref) return json({ ok: false } satisfies MarketingMuteResult);

    const { entries } = await setMarketingMuted(db, {
      profileId: pref.profileId,
      // Holding the token is the proof: the account acted on its own preference.
      actorId: pref.profileId,
      actorType: 'user',
      source: 'one-click',
    });
    forwardOneClickAudit(c, entries, 'marketing-one-click');
    return json({ ok: true } satisfies MarketingMuteResult);
  };
}

/** The token of a one-click POST: `?token=` wins and the form body is ignored, else a
 *  JSON `{ token }` body. A non-JSON body without `?token=` is `400 MALFORMED_REQUEST`. */
async function readOneClickToken(
  c: Context<{ Bindings: Env }>,
  schema: typeof NudgeMuteSubmitSchema | typeof MarketingMuteSubmitSchema,
): Promise<string> {
  const queryToken = c.req.query('token');
  if (queryToken) return schema.parse({ token: queryToken }).token;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw).token;
}

/** Forward a one-click write's audit rows post-commit (§26.5). A no-op writes none. */
function forwardOneClickAudit(
  c: Context<{ Bindings: Env }>,
  entries: readonly AuditLogEntry[],
  source: string,
): void {
  if (entries.length === 0) return;
  logBatchToPosthog(
    c.executionCtx,
    c.env,
    c.req.raw,
    entries.map((entry) => ({
      level: 'info' as const,
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source,
    })),
  );
}
