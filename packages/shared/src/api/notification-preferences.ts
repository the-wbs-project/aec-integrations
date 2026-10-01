import { z } from 'zod';

/**
 * Per-seat notification preferences (AECI-1204 / `STAGE_2_ATTESTATIONS_SPEC.md` §7.2).
 *
 * One setting today: mute the daily attestation nudge digest. It is per SEAT, not
 * per vendor: one colleague muting does not silence the others. The mute covers
 * nudges only. Seat invites, claim decisions and plan-expiry notices still send,
 * and a muted seat still sees every finding in the portal's Messages list.
 *
 * Two ways in, one state:
 *
 *   - `GET` / `PUT /api/vendor/notification-preferences`: the portal toggle, behind
 *     a vendor session. It acts on the caller's own seat; no profile id is ever read
 *     from the request.
 *   - `POST /api/notifications/nudges/mute`: the one-click link in the digest footer,
 *     unauthenticated, keyed by the seat's opaque mute token. Mute only.
 */

/** `GET` and `PUT /api/vendor/notification-preferences` response. */
export const NotificationPreferencesResponseSchema = z.object({
  nudges_muted: z.boolean(),
  /** ISO-8601, when the seat muted the digest. Null when not muted. */
  nudges_muted_at: z.string().nullable(),
});
export type NotificationPreferencesResponse = z.infer<typeof NotificationPreferencesResponseSchema>;

/** `PUT /api/vendor/notification-preferences` body. Unknown keys are refused. */
export const UpdateNotificationPreferencesSchema = z
  .object({
    nudges_muted: z.boolean(),
  })
  .strict();
export type UpdateNotificationPreferencesInput = z.infer<
  typeof UpdateNotificationPreferencesSchema
>;

/**
 * `POST /api/notifications/nudges/mute` body. The token is the seat's opaque
 * `notification_preferences.mute_token`. The endpoint also takes it as `?token=`,
 * which is the path an RFC 8058 one-click POST from a mail client uses; that form
 * body is ignored. The browser page POSTs it as JSON here.
 */
export const NudgeMuteSubmitSchema = z.object({
  token: z.string().trim().min(1).max(100),
});
export type NudgeMuteSubmit = z.infer<typeof NudgeMuteSubmitSchema>;

/**
 * `POST /api/notifications/nudges/mute` response, the `/api/unsubscribe` shape.
 * `ok: true` = the token matched a seat, which is now muted. A repeat also returns
 * true. `ok: false` = the token matched nothing. Tokens are unguessable, so `false`
 * leaks nothing.
 */
export const NudgeMuteResultSchema = z.object({ ok: z.boolean() });
export type NudgeMuteResult = z.infer<typeof NudgeMuteResultSchema>;
