/**
 * The reads behind `/admin/email` (AECI-1223). Source of truth: `docs/ADMIN_PANEL_SPEC.md`
 * §5.14 and §13 D23. Tables: `notification_sends` (`DATABASE_SCHEMA.md` §9.9) and
 * `notification_delivery_events` (§9.9a).
 *
 * Pure reads over our own tables. Nothing here writes, sends, logs a recipient, or calls
 * Resend. The routes in `routes/admin-email.ts` parse, call these, and wrap the envelope.
 *
 * ─── Three things worth knowing before extending this ─────────────────────────
 *
 * **1. The registry is the only list of templates.** Summaries and audiences come from
 * `NOTIFICATIONS` (`notifications/registry.ts`). A ledger id the registry no longer knows
 * is still shown, as `registered: false`, because the ledger can outlive a renamed id.
 *
 * **2. The correlated subquery names every column by table.** Drizzle emits a BARE column
 * name when a select has no join, and inside a correlated subquery a bare `"id"` binds to
 * the inner table (`ADMIN_PANEL_SPEC.md` §6, P1.5 note 4). Both tables have `id` and
 * `provider_message_id`, so the latest-event subquery is written with explicit
 * `"notification_sends".` and `e2.` qualifiers.
 *
 * **3. Windows count by each table's own `created_at`.** A delivery event's `occurred_at`
 * is Resend's string stored verbatim, so its format is Resend's. `created_at` is our ISO
 * stamp of when the webhook landed, which compares as text correctly.
 */

import {
  ADMIN_EMAIL_UNMATCHED_EVENTS_LIMIT,
  type AdminEmailDeliveryCounts,
  type AdminEmailDeliveryEvent,
  type AdminEmailEntity,
  type AdminEmailOutcomeCounts,
  type AdminEmailSendOutcome,
  type AdminEmailSendRow,
  type AdminEmailSendsQuery,
  type AdminEmailSignInCounts,
  type AdminEmailSummaryResponse,
  type AdminEmailSummaryRow,
  type AdminEmailTemplate,
  type AdminEmailUnmatchedEvent,
  type AdminEmailWindowCounts,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { notificationDeliveryEvents, notificationSends, vendorRequests } from '../db/schema';
import { recipientHash } from './hash';
import { AUTH_TIER } from './notifications/delivery-events';
import { NOTIFICATIONS, type NotificationEntry } from './notifications/registry';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The registry id of the sign-in stream. The summary table leaves it to its own panel. */
const SIGN_IN_ID = 'supabase-sign-in';

type RegistryRecord = Readonly<Record<string, NotificationEntry>>;
const REGISTRY = NOTIFICATIONS as RegistryRecord;

function registryEntry(id: string): NotificationEntry | null {
  return Object.prototype.hasOwnProperty.call(REGISTRY, id) ? REGISTRY[id]! : null;
}

/** Every registry entry that sends a Resend email, in id order. The template filter's
 *  options. Portal and Linear entries are not email and have no ledger row. */
export function emailTemplates(): AdminEmailTemplate[] {
  return Object.entries(REGISTRY)
    .filter(([, e]) => e.channel === 'email' || e.channel === 'email+portal')
    .map(([id, e]) => ({ id, summary: e.summary, audience: e.audience }))
    .sort((a, b) => compareText(a.id, b.id));
}

// ─── Summary ──────────────────────────────────────────────────────────────────

const zeroOutcomes = (): AdminEmailOutcomeCounts => ({
  sent: 0,
  failed: 0,
  unknown: 0,
  skipped: 0,
  suppressed: 0,
  duplicate: 0,
  paused: 0,
});
const zeroDelivery = (): AdminEmailDeliveryCounts => ({
  delivered: 0,
  bounced: 0,
  complained: 0,
  delivery_delayed: 0,
});
const zeroWindow = (): AdminEmailWindowCounts => ({
  outcomes: zeroOutcomes(),
  delivery: zeroDelivery(),
});
const zeroSignIn = (): AdminEmailSignInCounts => ({
  sent: 0,
  delivered: 0,
  delivery_delayed: 0,
  bounced: 0,
  complained: 0,
});

interface GroupRow {
  key: string;
  kind: string;
  d7: number | null;
  d30: number;
}

/**
 * Per-template 7- and 30-day counts, plus the production sign-in stream.
 *
 * Two (or three) `GROUP BY` statements in one `db.batch`, one D1 round trip. Each counts
 * the 30-day window and sums the 7-day subset in the same pass. No compound SELECT, so the
 * D1 five-term cap does not apply.
 */
export async function readEmailSummary(
  db: Db,
  now: Date,
  opts: { production: boolean; environment: string },
): Promise<AdminEmailSummaryResponse> {
  const since7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const s = notificationSends;
  const e = notificationDeliveryEvents;

  const ledgerStmt = db
    .select({
      key: s.notificationId,
      kind: s.outcome,
      d7: sql<number>`sum(case when ${s.createdAt} >= ${since7} then 1 else 0 end)`,
      d30: count(),
    })
    .from(s)
    .where(gte(s.createdAt, since30))
    .groupBy(s.notificationId, s.outcome);

  const eventsStmt = db
    .select({
      key: e.notificationId,
      kind: e.eventType,
      d7: sql<number>`sum(case when ${e.createdAt} >= ${since7} then 1 else 0 end)`,
      d30: count(),
    })
    .from(e)
    .where(and(gte(e.createdAt, since30), ne(e.tier, AUTH_TIER)))
    .groupBy(e.notificationId, e.eventType);

  const signInStmt = db
    .select({
      key: e.tier,
      kind: e.eventType,
      d7: sql<number>`sum(case when ${e.createdAt} >= ${since7} then 1 else 0 end)`,
      d30: count(),
    })
    .from(e)
    .where(and(gte(e.createdAt, since30), eq(e.tier, AUTH_TIER)))
    .groupBy(e.tier, e.eventType);

  let ledger: GroupRow[];
  let events: GroupRow[];
  let signIn: GroupRow[] | null = null;
  if (opts.production) {
    const [a, b, c] = await db.batch([ledgerStmt, eventsStmt, signInStmt]);
    ledger = a as GroupRow[];
    events = b as GroupRow[];
    signIn = c as GroupRow[];
  } else {
    const [a, b] = await db.batch([ledgerStmt, eventsStmt]);
    ledger = a as GroupRow[];
    events = b as GroupRow[];
  }

  const byId = new Map<string, { d7: AdminEmailWindowCounts; d30: AdminEmailWindowCounts }>();
  const slot = (id: string) => {
    let v = byId.get(id);
    if (!v) {
      v = { d7: zeroWindow(), d30: zeroWindow() };
      byId.set(id, v);
    }
    return v;
  };

  for (const row of ledger) {
    if (row.key === SIGN_IN_ID) continue;
    if (!(row.kind in zeroOutcomes())) continue; // `sending` is in neither group (§5.14).
    const v = slot(row.key);
    const k = row.kind as keyof AdminEmailOutcomeCounts;
    v.d7.outcomes[k] += Number(row.d7 ?? 0);
    v.d30.outcomes[k] += Number(row.d30);
  }
  for (const row of events) {
    if (row.key === SIGN_IN_ID) continue;
    if (!(row.kind in zeroDelivery())) continue; // Resend's own `sent` event is not counted.
    const v = slot(row.key);
    const k = row.kind as keyof AdminEmailDeliveryCounts;
    v.d7.delivery[k] += Number(row.d7 ?? 0);
    v.d30.delivery[k] += Number(row.d30);
  }

  const rows: AdminEmailSummaryRow[] = [...byId.entries()]
    .map(([id, counts]) => {
      const entry = registryEntry(id);
      return {
        notification_id: id,
        summary: entry?.summary ?? null,
        audience: entry?.audience ?? null,
        registered: entry !== null,
        d7: counts.d7,
        d30: counts.d30,
      };
    })
    .sort((a, b) => compareText(a.notification_id, b.notification_id));

  let signInCounts: AdminEmailSummaryResponse['sign_in'] = null;
  if (signIn) {
    const d7 = zeroSignIn();
    const d30 = zeroSignIn();
    for (const row of signIn) {
      if (!(row.kind in d7)) continue;
      const k = row.kind as keyof AdminEmailSignInCounts;
      d7[k] += Number(row.d7 ?? 0);
      d30[k] += Number(row.d30);
    }
    signInCounts = { d7, d30 };
  }

  return {
    generated_at: now.toISOString(),
    environment: opts.environment,
    templates: emailTemplates(),
    rows,
    sign_in: signInCounts,
  };
}

// ─── The list ─────────────────────────────────────────────────────────────────

/**
 * The newest delivery event for the outer ledger row, as a scalar subquery on `column`.
 * Narrowed by `provider_message_id` first so it rides
 * `notification_delivery_events_message_idx`; `notification_send_id` then picks this
 * recipient's events. See the header, note 2, for why every name is qualified.
 */
function latestEvent(column: 'id' | 'event_type'): SQL {
  return sql.raw(
    `(select e2."${column}" from "notification_delivery_events" e2` +
      ` where e2."provider_message_id" = "notification_sends"."provider_message_id"` +
      ` and e2."notification_send_id" = "notification_sends"."id"` +
      ` order by e2."occurred_at" desc, e2."id" desc limit 1)`,
  );
}

/** `YYYY-MM-DD` → the ISO instant that day starts, UTC. */
function dayStart(day: string): string {
  return `${day}T00:00:00.000Z`;
}

/** The day after `day`, as an ISO instant, so `to` is inclusive. */
function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  return new Date(d.getTime() + DAY_MS).toISOString();
}

export type AdminEmailListFilters = Omit<AdminEmailSendsQuery, 'page' | 'perPage'>;

function listWhere(filters: AdminEmailListFilters, hash: string | null): SQL | undefined {
  const s = notificationSends;
  const parts: SQL[] = [];
  if (hash !== null) parts.push(eq(s.recipientHash, hash));
  if (filters.template) parts.push(eq(s.notificationId, filters.template));
  if (filters.outcome) parts.push(eq(s.outcome, filters.outcome));
  if (filters.from) parts.push(gte(s.createdAt, dayStart(filters.from)));
  if (filters.to) parts.push(lt(s.createdAt, dayAfter(filters.to)));
  if (filters.delivery === 'none') parts.push(sql`${latestEvent('id')} is null`);
  else if (filters.delivery) parts.push(sql`${latestEvent('event_type')} = ${filters.delivery}`);
  return parts.length > 0 ? and(...parts) : undefined;
}

interface ListedRow {
  id: number;
  notification_id: string;
  outcome: string;
  created_at: string;
  provider_message_id: string | null;
  recipient_hash_prefix: string;
  entity_type: string | null;
  entity_id: string | null;
  latest_event_id: number | null;
}

/**
 * One page of the ledger, newest first, with each row's latest delivery event and its
 * related entity's admin page. `hash` is the recipient filter for an address search, or
 * null for the plain list.
 *
 * Three round trips at most: the page and its count in one batch, then the page's latest
 * events by id, then the `vendor_requests` kinds the entity links need. The last two only
 * run when the page names something to look up.
 */
export async function listEmailSends(
  db: Db,
  query: AdminEmailSendsQuery,
  hash: string | null,
): Promise<{ rows: AdminEmailSendRow[]; total: number }> {
  const s = notificationSends;
  const where = listWhere(query, hash);

  const [page, totals] = await db.batch([
    db
      .select({
        id: s.id,
        notification_id: s.notificationId,
        outcome: s.outcome,
        created_at: s.createdAt,
        provider_message_id: s.providerMessageId,
        // Cut in SQL, so the full hash never leaves D1 (§5.14; the §5.2 visitor_hash rule).
        recipient_hash_prefix: sql<string>`substr(${s.recipientHash}, 1, 8)`,
        entity_type: s.entityType,
        entity_id: s.entityId,
        latest_event_id: sql<number | null>`${latestEvent('id')}`,
      })
      .from(s)
      .where(where)
      .orderBy(desc(s.createdAt), desc(s.id))
      .limit(query.perPage)
      .offset((query.page - 1) * query.perPage),
    db.select({ value: count() }).from(s).where(where),
  ]);
  const listed = page as ListedRow[];

  const eventIds = listed.map((r) => r.latest_event_id).filter((v): v is number => v !== null);
  const requestIds = listed
    .filter((r) => r.entity_type === 'vendor_request' && r.entity_id)
    .map((r) => r.entity_id!);

  const e = notificationDeliveryEvents;
  const [events, kinds] = await Promise.all([
    eventIds.length > 0
      ? db
          .select({
            id: e.id,
            event_type: e.eventType,
            occurred_at: e.occurredAt,
            bounce_type: e.bounceType,
            bounce_subtype: e.bounceSubtype,
          })
          .from(e)
          .where(inArray(e.id, eventIds))
      : Promise.resolve([]),
    requestIds.length > 0
      ? db
          .select({ id: vendorRequests.id, kind: vendorRequests.kind })
          .from(vendorRequests)
          .where(inArray(vendorRequests.id, [...new Set(requestIds)]))
      : Promise.resolve([]),
  ]);
  const eventById = new Map(events.map((ev) => [ev.id, ev]));
  const kindById = new Map(kinds.map((k) => [k.id, k.kind]));

  const rows: AdminEmailSendRow[] = listed.map((r) => {
    const ev = r.latest_event_id !== null ? eventById.get(r.latest_event_id) : undefined;
    return {
      id: r.id,
      notification_id: r.notification_id,
      summary: registryEntry(r.notification_id)?.summary ?? null,
      outcome: r.outcome as AdminEmailSendOutcome,
      created_at: r.created_at,
      provider_message_id: r.provider_message_id,
      recipient_hash_prefix: r.recipient_hash_prefix ?? '',
      entity: entityLink(r.entity_type, r.entity_id, kindById),
      latest_delivery: ev
        ? {
            event_type: ev.event_type as AdminEmailDeliveryEvent,
            occurred_at: ev.occurred_at,
            bounce_type: ev.bounce_type,
            bounce_subtype: ev.bounce_subtype,
          }
        : null,
    };
  });

  return { rows, total: totals[0]?.value ?? 0 };
}

/**
 * The related entity and the admin page that shows it (§5.14 table). Null when the sender
 * named no entity. A type with no admin page keeps its type and id with a null path.
 */
export function entityLink(
  type: string | null,
  id: string | null,
  requestKinds: ReadonlyMap<string, string>,
): AdminEmailEntity | null {
  if (!type || !id) return null;
  const enc = encodeURIComponent(id);
  let path: string | null = null;
  switch (type) {
    case 'vendor':
      path = `/admin/vendors/${enc}`;
      break;
    case 'profile':
      path = `/admin/users/${enc}`;
      break;
    case 'vendor_request': {
      const kind = requestKinds.get(id);
      if (kind === 'claim') path = `/admin/claims/${enc}`;
      else if (kind === 'correction') path = '/admin/requests';
      break;
    }
    case 'review':
      path = '/admin/reviews';
      break;
    case 'integration_field_challenge':
      path = '/admin/contests';
      break;
    case 'mailing_list':
      path = '/admin/subscribers';
      break;
  }
  return { type, id, admin_path: path };
}

/** The newest delivery events for one recipient that no ledger row claims: a BCC copy, or
 *  on production the sign-in stream. Rides the `(recipient_hash, created_at)` index. */
export async function listUnmatchedEvents(
  db: Db,
  hash: string,
): Promise<AdminEmailUnmatchedEvent[]> {
  const e = notificationDeliveryEvents;
  const rows = await db
    .select({
      id: e.id,
      notification_id: e.notificationId,
      tier: e.tier,
      event_type: e.eventType,
      occurred_at: e.occurredAt,
      provider_message_id: e.providerMessageId,
      bounce_type: e.bounceType,
      bounce_subtype: e.bounceSubtype,
    })
    .from(e)
    .where(and(eq(e.recipientHash, hash), isNull(e.notificationSendId)))
    .orderBy(desc(e.createdAt), desc(e.id))
    .limit(ADMIN_EMAIL_UNMATCHED_EVENTS_LIMIT);
  return rows.map((r) => ({ ...r, event_type: r.event_type as AdminEmailDeliveryEvent }));
}

/**
 * The hash an address search matches on. Strips a `Name <a@b.com>` wrapper, then applies
 * the ledger's own normalization (`recipientHash`: trim, lowercase, SHA-256). The address
 * is not kept, returned or logged.
 */
export function searchHash(address: string): Promise<string> {
  const match = address.match(/<([^>]+)>/);
  return recipientHash(match ? match[1]! : address);
}
