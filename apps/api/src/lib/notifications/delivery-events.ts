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
 * ─── Blind copies ─────────────────────────────────────────────────────────────
 *
 * Production blind-copies support (`EMAIL_BCC`) on nearly every send. If Resend lists BCC
 * addresses in `data.to`, counting them would leave almost every event unattributed. So the
 * tier's `EMAIL_BCC` addresses (parsed as the send path parses them, no tier refusal filter)
 * are set aside before counting:
 *
 *   - One address left: attributed to it and joined, as above.
 *   - Two or more left: unattributed.
 *   - None left, and the event named one BCC address: attributed to it ONLY when that
 *     address has a ledger row for this message. That is the operator `COPY:` send, which
 *     goes TO support and keeps its own rows. A plain blind copy has no row, so its event is
 *     stored unattributed and never under the BCC address.
 *   - None left from several BCC addresses, or nothing named: unattributed.
 *
 * ─── The staging redirect ─────────────────────────────────────────────────────
 *
 * Staging delivers every send to one inbox, `STAGING_REDIRECT_RECIPIENT` (2026-10-09), and
 * keeps the ledger rows under the intended recipients. So an event there names the redirect
 * inbox, not the recipient. When the route passes `redirectRecipient` and the event names
 * exactly that one address, the recipient is read from the ledger instead: the rows for the
 * message id. Rows under one recipient hash attribute the event to it and join the earliest.
 * Rows under several (a digest to several addresses) or none leave it unattributed.
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
  type ResendEmailEventData,
} from '@aeci/shared';
import { and, asc, eq } from 'drizzle-orm';

import type { Db } from '../../db/client';
import {
  notificationDeliveryEvents,
  notificationSends,
  type NotificationDeliveryEventType,
} from '../../db/schema';
import { parseRecipients } from '../email';
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
export function eventTags(data: ResendEmailEventData): Map<string, string> {
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
export function isSupabaseSignInEmail(data: ResendEmailEventData): boolean {
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
  data: ResendEmailEventData,
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
  data: ResendEmailEventData;
  classification: Extract<DeliveryClassification, { kind: 'record' }>;
  /** The tier's raw `EMAIL_BCC`: the support blind copy's addresses. See "Blind copies". */
  emailBcc?: string;
  /** The inbox this tier redirects every send to, on staging only. See "The staging
   *  redirect". */
  redirectRecipient?: string;
}

export interface RecordResult {
  /** False on a replay: the `(svix_id, recipient_hash)` row already existed. */
  inserted: boolean;
  /** The stored row's `notification_id`, for the metric. */
  notificationId: string;
  /** True when the row carries a recipient hash (see the header). */
  attributed: boolean;
}

/**
 * Store one row for the event, attributed to at most one recipient by the rules in the
 * header ("One row per event", "Blind copies"). A DB error propagates.
 */
export async function recordDeliveryEvent(db: Db, input: RecordInput): Promise<RecordResult> {
  const { data, classification } = input;
  const named = await recipientHashes(data.to ?? []);
  const bcc = new Set(await recipientHashes(parseRecipients(input.emailBcc)));
  const others = named.filter((h) => !bcc.has(h));

  // Exactly one non-BCC address: that recipient. No non-BCC address and exactly one BCC
  // address: a candidate that counts only if it joins a ledger row (the operator `COPY:`).
  let hash: string | null = null;
  let mustJoin = false;
  if (others.length === 1) hash = others[0]!;
  else if (others.length === 0 && named.length === 1) {
    hash = named[0]!;
    mustJoin = true;
  }

  const fallbackId = classification.signIn
    ? SIGN_IN_NOTIFICATION_ID
    : (classification.taggedNotificationId ?? UNKNOWN_NOTIFICATION);

  let match: { id: number; notificationId: string } | undefined;
  const redirected =
    input.redirectRecipient !== undefined &&
    named.length === 1 &&
    named[0] === (await recipientHash(bareAddress(input.redirectRecipient)));
  if (redirected) {
    // The event names the redirect inbox. The ledger names who the mail was for.
    const rows = await db
      .select({
        id: notificationSends.id,
        notificationId: notificationSends.notificationId,
        recipientHash: notificationSends.recipientHash,
      })
      .from(notificationSends)
      .where(eq(notificationSends.providerMessageId, data.email_id))
      .orderBy(asc(notificationSends.id));
    const hashes = new Set(rows.map((r) => r.recipientHash));
    if (rows.length > 0 && hashes.size === 1) {
      hash = rows[0]!.recipientHash;
      match = { id: rows[0]!.id, notificationId: rows[0]!.notificationId };
    } else {
      hash = null;
    }
  } else if (hash !== null) {
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
    // A blind copy has no ledger row of its own: never attribute an event to it.
    if (mustJoin && !match) hash = null;
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
