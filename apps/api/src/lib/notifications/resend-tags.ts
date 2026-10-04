/**
 * Resend `tags` on every send (AECI-1222).
 *
 * One Resend account and one key serve every tier, and a Resend webhook endpoint receives
 * the events of the whole account. So every send says which tier sent it and which registry
 * entry it is, and each tier's webhook keeps only its own events
 * (`lib/notifications/delivery-events.ts`).
 *
 * Resend's rule for a tag name and value: ASCII letters, digits, `_` and `-` only, at most
 * 256 characters (`https://resend.com/docs/api-reference/emails/send-email`, read
 * 2026-10-02). A send with a bad tag is refused, so every value is sanitized here rather than
 * trusted. Today's tier labels and registry ids already pass unchanged.
 */

import { tierLabel, type DeliveryPolicyEnv } from './delivery-policy';

/** The tag that names the sending tier, from `tierLabel(env)`. */
export const RESEND_TAG_TIER = 'tier';

/** The tag that names the registry entry (`lib/notifications/registry.ts`). */
export const RESEND_TAG_NOTIFICATION = 'notification_id';

const TAG_MAX = 256;

/** Replace every character outside `[A-Za-z0-9_-]` with `_` and cap at 256. Empty → `_`. */
export function sanitizeTagValue(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, TAG_MAX);
  return cleaned.length > 0 ? cleaned : '_';
}

/** The `tags` field for one Resend send. */
export function resendTags(
  env: DeliveryPolicyEnv,
  notificationId: string,
): Array<{ name: string; value: string }> {
  return [
    { name: RESEND_TAG_TIER, value: sanitizeTagValue(tierLabel(env)) },
    { name: RESEND_TAG_NOTIFICATION, value: sanitizeTagValue(notificationId) },
  ];
}
