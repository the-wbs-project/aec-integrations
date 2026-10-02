/**
 * The Resend delivery-event recorder (AECI-1222). `POST /api/webhooks/resend` verifies the
 * Svix signature, then hands the parsed event here. `docs/email.md` §Delivery webhooks is the
 * governing doc, `docs/DATABASE_SCHEMA.md` §9.9a the table.
 *
 * ─── The shared-account trap ──────────────────────────────────────────────────
 *
 * One Resend account serves every tier, and a webhook endpoint receives the events of the
 * whole account. Every send carries a `tier` tag (`resend-tags.ts`). So:
 *
 *   - An event tagged with this tier is recorded.
 *   - An event tagged with another tier is dropped and counted (`outcome:other_tier`).
 *   - An untagged event is the Supabase sign-in email, or something we cannot place. Every
 *     tier shares one Supabase project, so the sign-in mail is one stream. Production alone
 *     records it, as tier `auth`, when the subject and sender match. Every other untagged
 *     event is dropped and counted (`outcome:untagged`).
 *
 * ─── The join ─────────────────────────────────────────────────────────────────
 *
 * `data.email_id` is `notification_sends.provider_message_id`. Several ledger rows can share
 * one id: a digest is one Resend call for several recipients, the operator `COPY:` writes one
 * row per operator address, and a retried send can get the first send's id back through the
 * `Idempotency-Key`. So the recipient picks its row by `recipientHash`, the ledger's own
 * normalization, and the earliest such row wins (the send that actually went). A recipient
 * with no row (a BCC copy, a ledger outage, an event that beat `finalizeSend`) is stored with
 * `notification_send_id` NULL. No ledger row is ever invented.
 *
 * ─── One row per event ────────────────────────────────────────────────────────
 *
 * Resend documents `data.to` as the "Array of impacted recipient email addresses" on every
 * email event, `email.sent` included, and never says an event is sent per recipient or
 * whether a BCC address appears. So an event that names more than one address cannot be
 * pinned on any one of them: a bounce on a three-address digest may concern one address.
 * Such an event is stored ONCE, unattributed: `recipient_hash` `''`, no ledger join,
 * `notification_send_id` NULL. An event naming one address keeps the join. An event naming
 * nobody is stored the same unattributed way. Either way the event writes exactly one row and
 * counts the metric once.
 *
 * ─── Log-class ────────────────────────────────────────────────────────────────
 *
 * No `audit_log` row (ADR 0022), like `notification_sends`. Unlike the ledger it does NOT
 * fail open: a D1 error propagates, the route answers 500, and Resend retries the delivery.
 * The retry is the durability. The `(svix_id, recipient_hash)` UNIQUE index makes the retry
 * of an already-stored event insert nothing: a retry carries the same body, so it lands on
 * the same hash, `''` for an unattributed event.
 */

import {
  RESEND_DELIVERY_EVENT_TYPES,
  type ResendDeliveryEventType,
  type ResendWebhook,
} from '@aeci/shared';
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '../../db/client';
import {
  notificationDeliveryEvents,
  notificationSends,
  type NotificationDeliveryEventType,
} from '../../db/schema';
import { recipientHash } from '../hash';
import { isProductionTier, tierLabel, type DeliveryPolicyEnv } from './delivery-policy';
import { NOTIFICATIONS } from './registry';
import { RESEND_TAG_NOTIFICATION, RESEND_TAG_TIER, sanitizeTagValue } from './resend-tags';

/** The tier recorded for the Supabase sign-in stream. */
export const AUTH_TIER = 'auth';

/** The registry id of the Supabase sign-in email. */
export const SIGN_IN_NOTIFICATION_ID = 'supabase-sign-in';

/** The sign-in email's subject, on both the Magic Link and Confirm signup slots
 *  (`docs/email.md` §Magic-link sender). Change both together. */
export const SIGN_IN_SUBJECT = 'Sign in to AEC Integrations';

/** The sending domain. The sign-in sender is this domain or a subdomain of it. */
export const SIGN_IN_SENDER_DOMAIN = 'aecintegrations.com';

/** The `template` value when no registry id can be named. */
export const UNKNOWN_NOTIFICATION = 'unknown';

/** Tier labels a metric may carry. Anything else is `other`, so a stray tag cannot grow
 *  the series count. */
const METRIC_TIERS = new Set([
  'production',
  'staging',
  'demo',
  'preview',
  'development',
  'non-production',
  AUTH_TIER,
]);

/** The `recipient_hash` of an event attributed to nobody: it named no address, or more
 *  than one. */
export const UNATTRIBUTED_RECIPIENT_HASH = '';

export type DropReason = 'other_tier' | 'untagged';

export type DeliveryClassification =
  | {
      kind: 'record';
      tier: string;
      /** The `notification_id` tag when it names a registry entry, else null. */
      taggedNotificationId: string | null;
      signIn: boolean;
    }
  | { kind: 'drop'; reason: DropReason; tier: string };

export function isHandledEventType(type: string): type is ResendDeliveryEventType {
  return (RESEND_DELIVERY_EVENT_TYPES as readonly string[]).includes(type);
}

/** `email.bounced` → `bounced`. */
export function shortEventType(type: ResendDeliveryEventType): NotificationDeliveryEventType {
  return type.slice('email.'.length) as NotificationDeliveryEventType;
}

/** A tier label safe to put on a metric. */
export function metricTier(tier: string): string {
  return METRIC_TIERS.has(tier) ? tier : 'other';
}

/** True when `id` names a registry entry. */
export function isRegistryId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(NOTIFICATIONS, id);
}

/** The event's tags as a map, from either shape Resend may send. */
export function eventTags(data: NonNullable<ResendWebhook['data']>): Map<string, string> {
  const tags = data.tags;
  if (!tags) return new Map();
  if (Array.isArray(tags)) return new Map(tags.map((t) => [t.name, t.value]));
  return new Map(Object.entries(tags));
}

/**
 * True when an untagged event is the Supabase sign-in email: the subject is exactly
 * {@link SIGN_IN_SUBJECT} and the sender's domain is {@link SIGN_IN_SENDER_DOMAIN} or a
 * subdomain of it. Supabase sends it over the Resend SMTP relay, outside our code, so it is
 * the one stream with no tags.
 */
export function isSupabaseSignInEmail(data: NonNullable<ResendWebhook['data']>): boolean {
  if ((data.subject ?? '').trim() !== SIGN_IN_SUBJECT) return false;
  const sender = bareAddress(data.from ?? '');
  const at = sender.lastIndexOf('@');
  if (at <= 0) return false;
  const domain = sender.slice(at + 1);
  return domain === SIGN_IN_SENDER_DOMAIN || domain.endsWith(`.${SIGN_IN_SENDER_DOMAIN}`);
}

/** Decide whether this tier records the event. See the header. */
export function classifyEvent(
  env: DeliveryPolicyEnv,
  data: NonNullable<ResendWebhook['data']>,
): DeliveryClassification {
  const tags = eventTags(data);
  const taggedTier = tags.get(RESEND_TAG_TIER);
  if (taggedTier !== undefined) {
    const ownTier = sanitizeTagValue(tierLabel(env));
    if (taggedTier !== ownTier) return { kind: 'drop', reason: 'other_tier', tier: taggedTier };
    const tagged = tags.get(RESEND_TAG_NOTIFICATION);
    return {
      kind: 'record',
      tier: tierLabel(env),
      taggedNotificationId: tagged !== undefined && isRegistryId(tagged) ? tagged : null,
      signIn: false,
    };
  }
  if (isProductionTier(env) && isSupabaseSignInEmail(data)) {
    return { kind: 'record', tier: AUTH_TIER, taggedNotificationId: null, signIn: true };
  }
  return { kind: 'drop', reason: 'untagged', tier: tierLabel(env) };
}

export interface RecordInput {
  svixId: string;
  eventType: ResendDeliveryEventType;
  occurredAt: string;
  data: NonNullable<ResendWebhook['data']>;
  classification: Extract<DeliveryClassification, { kind: 'record' }>;
}

export interface RecordResult {
  /** False on a replay: the `(svix_id, recipient_hash)` row already existed. */
  inserted: boolean;
  /** The stored row's `notification_id`, for the metric. */
  notificationId: string;
  /** True when the event named exactly one address and was joined by it. */
  attributed: boolean;
}

/**
 * Store one row for the event. A single-address event joins its ledger row by recipient
 * hash. Any other event is stored unattributed (see the header). A DB error propagates.
 */
export async function recordDeliveryEvent(db: Db, input: RecordInput): Promise<RecordResult> {
  const { data, classification } = input;
  const hashes = await recipientHashes(data.to ?? []);
  const hash = hashes.length === 1 ? hashes[0]! : null;

  const fallbackId = classification.signIn
    ? SIGN_IN_NOTIFICATION_ID
    : (classification.taggedNotificationId ?? UNKNOWN_NOTIFICATION);

  let match: { id: number; notificationId: string } | undefined;
  if (hash !== null) {
    // Ordered by id, so the first row is the earliest send to this recipient.
    [match] = await db
      .select({ id: notificationSends.id, notificationId: notificationSends.notificationId })
      .from(notificationSends)
      .where(
        and(
          eq(notificationSends.providerMessageId, data.email_id),
          eq(notificationSends.recipientHash, hash),
        ),
      )
      .orderBy(asc(notificationSends.id))
      .limit(1);
  }

  const bounce = input.eventType === 'email.bounced' ? data.bounce : undefined;
  const notificationId = match?.notificationId ?? fallbackId;
  const back = await db
    .insert(notificationDeliveryEvents)
    .values({
      svixId: input.svixId,
      providerMessageId: data.email_id,
      eventType: shortEventType(input.eventType),
      notificationSendId: match?.id ?? null,
      notificationId,
      tier: classification.tier,
      recipientHash: hash ?? UNATTRIBUTED_RECIPIENT_HASH,
      bounceType: bounce?.type ?? null,
      bounceSubtype: bounce?.subType ?? null,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({
      target: [notificationDeliveryEvents.svixId, notificationDeliveryEvents.recipientHash],
    })
    .returning({ id: notificationDeliveryEvents.id });

  return { inserted: back.length > 0, notificationId, attributed: hash !== null };
}

/** One hash per distinct named address, in order. Empty when the event names nobody. */
async function recipientHashes(addresses: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const address of addresses) {
    const bare = bareAddress(address);
    if (!bare) continue;
    const hash = await recipientHash(bare);
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

/** `Name <a@b.com>` or `a@b.com` → `a@b.com`, trimmed and lowercased. The same rule the
 *  ledger applies before `recipientHash` (`lib/email.ts`). */
function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1]! : value).trim().toLowerCase();
}
