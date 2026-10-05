/**
 * The in-portal notification list (`GET /api/vendor/notifications`, AECI-302 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §7.2) — Drizzle/D1.
 *
 * §7.3 chose `audit_log` as the detector sweep's dedupe ledger and noted that this
 * "gives the in-portal list its backing query for free". This module is that
 * query. There is no notifications table (decision §1.3(6)) and no new store:
 * every row here is a `notification.sent` audit row. Most are the daily sweep's
 * (`lib/attestation-notify.ts`), written after a successful send. Since AECI-1008
 * the contest handlers also write them (`metadata.kind = 'contest'`), in the same
 * batch as the contest transition, addressed to the other side of the contest.
 * Since AECI-1005 so does the integration claim (`metadata.kind =
 * 'integration_claim'`), addressed to every other endpoint vendor, and since
 * AECI-1010 the retire and restore (`metadata.kind = 'integration_retire'`), and since
 * AECI-1006 the owner's edit (`metadata.kind = 'integration_update'`), and since
 * AECI-1011 a vendor's create (`metadata.kind = 'integration_create'`), to the same
 * recipients, and since AECI-1153 a data row another vendor added
 * (`metadata.kind = 'claim_added'`), to the vendors of the other endpoint, and
 * since AECI-1180 an approved review of an owned product (`metadata.kind =
 * 'review'`), to every owning vendor, and AECi's decision on a vendor's reply
 * (`metadata.kind = 'review_response'`), to the reply's vendor, and since AECI-1159
 * an AECi override of a field, a logo or a seat (`metadata.kind = 'aeci_override'`),
 * to the vendor that held it, with AECi's vendor-visible reason.
 * The list is a union on `kind`; the scoping predicate below is unchanged, so the
 * `notifications` cursor needed no change either.
 *
 * ── THIS IS THE FIRST PRODUCTION READ OF `audit_log` ────────────────────────
 * Everything else in the codebase only ever writes to it (plus the GDPR
 * actor-anonymisation UPDATE in `routes/account.ts`). Two consequences shaped the
 * query:
 *
 * 1. **`action` + a time window carry the scan.** `audit_log_action_idx`
 *    is `(action, created_at)` — exactly this shape. The window is what bounds a
 *    table that grows with every write in the system.
 * 2. **The vendor filter is a `json_extract` on unindexed `metadata`.** That is
 *    deliberate, not an oversight: indexing JSON would need a migration and a
 *    generated column, and the window already bounds how many rows the predicate
 *    sees. It runs in SQL rather than in the Worker so a vendor's row budget is
 *    not spent on other vendors' rows.
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * `vendorId` comes from `c.get('auth')`, never the request — the AECI-520
 * invariant, and with no RLS behind it (ADR 0016) that filter *is* the
 * authorization. Ops-routed ledger rows (the ops halves of `claim-denied` and
 * `open-conflict`) carry `metadata.vendorId = null`, so they can never match a
 * caller: the isolation is structural rather than a clause someone has to
 * remember. Note that since AECI-961 `claim-denied` writes **two** ledger rows
 * for one denial — an ops row and a counterparty row — and only the second is
 * addressed to a vendor id, so it is the only one this endpoint can return.
 *
 * **Not capability-gated.** `attestation.author` gates authoring (§1), not
 * reading (AECI-623) — a vendor without it sees its own (probably empty) list
 * rather than a 403 it cannot act on. Same reasoning as
 * `GET /api/vendor/products/:id/versions`.
 */

import {
  AECI_OVERRIDE_NOTIFICATION_EVENTS,
  vendorVisibleReason,
  type AeciOverrideLogoSubject,
  type AeciOverrideNotificationEvent,
  type VendorAeciOverrideNotification,
  CONTEST_NOTIFICATION_EVENTS,
  INTEGRATION_CONTEST_FIELDS,
  ListVendorNotificationsResponseSchema,
  REVIEW_RESPONSE_NOTIFICATION_EVENTS,
  type ReviewResponseNotificationEvent,
  type VendorReviewNotification,
  type VendorReviewResponseNotification,
  type AttestationDetector,
  type ContestNotificationEvent,
  type ContextDirection,
  type ListVendorNotificationsResponse,
  type VendorClaimAddedNotification,
  type NotificationProductRef,
  type VendorContestNotification,
  type VendorIntegrationClaimNotification,
  type VendorIntegrationCreateNotification,
  type VendorIntegrationRetireNotification,
  type VendorIntegrationUpdateNotification,
  type VendorNotification,
} from '@aeci/shared';
import { ATTESTATION_DETECTORS, orderedPairSlugs } from '@aeci/shared';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import { auditLog } from '../db/schema';
import { json } from '../http';
import {
  NOTIFICATION_SENT_ACTION,
  type NotificationLedgerMetadata,
} from '../lib/attestation-notify';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import {
  AECI_OVERRIDE_NOTIFICATION_KIND,
  type AeciOverrideNotificationMetadata,
} from '../lib/aeci-override-notifications';
import {
  CLAIM_ADDED_NOTIFICATION_KIND,
  type ClaimAddedNotificationMetadata,
} from '../lib/claim-added-notification';
import { CLAIM_NOTIFICATION_KIND, type ClaimNotificationMetadata } from '../lib/integration-claims';
import {
  CREATE_NOTIFICATION_KIND,
  type CreateNotificationMetadata,
} from '../lib/integration-create';
import {
  RETIRE_NOTIFICATION_KIND,
  type RetireNotificationMetadata,
} from '../lib/integration-retire';
import { pairPathFor, type ContestNotificationMetadata } from '../lib/integration-contests';
import {
  REVIEW_NOTIFICATION_KIND,
  REVIEW_RESPONSE_NOTIFICATION_KIND,
  type ReviewNotificationMetadata,
  type ReviewResponseNotificationMetadata,
} from '../lib/review-notifications';
import {
  UPDATE_NOTIFICATION_KIND,
  type UpdateNotificationMetadata,
} from '../lib/integration-owner-writes';
import { sessionVendorId, type VendorContext } from './vendor-shared';

const DAY_MS = 86_400_000;

/** How far back the list reaches. Comfortably longer than the 30-day suppression
 *  window, so a vendor can see the nudge that is currently suppressing a repeat,
 *  while still bounding the `audit_log` scan. */
export const NOTIFICATION_HISTORY_DAYS = 90;

/** Most rows returned. The dashboard tab is a recent-activity list, not an
 *  archive; there is no pagination contract at launch. */
export const NOTIFICATION_PAGE_SIZE = 50;

const DETECTORS = new Set<string>(ATTESTATION_DETECTORS);
const CONTEST_EVENTS = new Set<string>(CONTEST_NOTIFICATION_EVENTS);
const CONTEST_FIELDS = new Set<string>(INTEGRATION_CONTEST_FIELDS);

/**
 * The ledger scoping predicate — action, window, and vendor, in that order.
 *
 * Exported rather than inlined because AECI-627's freshness cursor
 * (`routes/vendor-updates.ts`) reports `MAX(created_at)` over **these** rows, and a
 * cursor whose predicate differs from its list's is worse than no cursor at all:
 * narrow it and the client never learns a nudge arrived; widen it and the cursor
 * moves on a row (an ops-routed one, or one outside the window) that the list will
 * never show, so the client refetches forever and finds nothing.
 *
 * `now` is injectable so a test can pin the window boundary without faking the clock.
 */
export function vendorNotificationLedgerWhere(vendorId: string, now: number = Date.now()) {
  const since = new Date(now - NOTIFICATION_HISTORY_DAYS * DAY_MS).toISOString();
  return and(
    eq(auditLog.action, NOTIFICATION_SENT_ACTION),
    gte(auditLog.createdAt, since),
    // The scoping filter. Since AECI-1192 a `notification.sent` row names its
    // RECIPIENT in the indexed `vendor_id` column; rows written before carry it only
    // in `metadata.vendorId`, and are never rewritten (no backfill, ruling
    // 2026-10-04), so the JSON leg stays as the legacy fallback. An ops row stores
    // NULL in both, which never equals a caller's id.
    or(
      eq(auditLog.vendorId, vendorId),
      sql`json_extract(${auditLog.metadata}, '$.vendorId') = ${vendorId}`,
    ),
  );
}

function productRef(value: unknown): NotificationProductRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const { slug, name } = value as Record<string, unknown>;
  return typeof slug === 'string' && typeof name === 'string' ? { slug, name } : null;
}

/**
 * Map one ledger row to the wire shape, or `null` when the snapshot is not
 * recognisable.
 *
 * Tolerant by design: these rows are historical records that outlive the code
 * that wrote them, so a future detector id or a shape change must degrade to
 * "skip this row" rather than 500 a dashboard tab. `pair_path` is rebuilt from the
 * stored slugs through the same alphabetical rule the pair route canonicalises to.
 */
function toVendorNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorNotification | null {
  // AECI-1008: contest events share the ledger. They are recognised by
  // `metadata.kind`, never by the absence of `detector`, so a malformed detector
  // row can never be misread as a contest.
  const kind = (row.metadata as { kind?: unknown } | null)?.kind;
  if (kind === 'contest') return toContestNotification(row);
  // AECI-1005: an owner claimed an integration on one of this vendor's products.
  if (kind === CLAIM_NOTIFICATION_KIND) return toClaimNotification(row);
  // AECI-1010: an owner retired or restored an integration on one of its products.
  if (kind === RETIRE_NOTIFICATION_KIND) return toRetireNotification(row);
  // AECI-1006: the owner edited an integration on one of this vendor's products.
  if (kind === UPDATE_NOTIFICATION_KIND) return toUpdateNotification(row);
  // AECI-1011: another vendor created an integration on one of its products.
  if (kind === CREATE_NOTIFICATION_KIND) return toCreateNotification(row);
  // AECI-1153: another vendor added a data row to an integration on its product.
  if (kind === CLAIM_ADDED_NOTIFICATION_KIND) return toClaimAddedNotification(row);
  // AECI-1180: a review of one of its products was approved.
  if (kind === REVIEW_NOTIFICATION_KIND) return toReviewNotification(row);
  // AECI-1180: AECi decided one of its replies to a review.
  if (kind === REVIEW_RESPONSE_NOTIFICATION_KIND) return toReviewResponseNotification(row);
  // AECI-1159: AECi overrode a field, a logo or a seat the vendor holds.
  if (kind === AECI_OVERRIDE_NOTIFICATION_KIND) return toAeciOverrideNotification(row);
  const meta = row.metadata as Partial<NotificationLedgerMetadata> | null;
  if (!meta || !row.entityId) return null;
  if (typeof meta.detector !== 'string' || !DETECTORS.has(meta.detector)) return null;
  if (typeof meta.integrationId !== 'string') return null;

  const pair = meta.pairSlugs;
  let pairPath: string | null = null;
  if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
    const [context, other] = orderedPairSlugs(pair[0], pair[1]);
    pairPath = `/products/${context}/integrations/${other}`;
  }

  return {
    kind: 'attestation',
    id: row.id,
    detector: meta.detector as AttestationDetector,
    claim_id: row.entityId,
    integration_id: meta.integrationId,
    data_object: productRef(meta.dataObject),
    counterpart_product: productRef(meta.counterpartProduct),
    pair_path: pairPath,
    created_at: row.createdAt,
  };
}

/**
 * Map one contest ledger row (AECI-1008), or `null` when it is not recognisable.
 * Same tolerance as the detector mapper: a row this code cannot read is skipped,
 * never a 500.
 */
function toContestNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorContestNotification | null {
  const meta = row.metadata as Partial<ContestNotificationMetadata> | null;
  if (!meta || typeof meta.contestId !== 'string' || typeof meta.integrationId !== 'string') {
    return null;
  }
  if (typeof meta.event !== 'string' || !CONTEST_EVENTS.has(meta.event)) return null;
  if (typeof meta.field !== 'string' || !CONTEST_FIELDS.has(meta.field)) return null;
  const pair = meta.pairSlugs;
  const pairSlugs =
    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      ? ([pair[0], pair[1]] as const)
      : null;
  return {
    kind: 'contest',
    id: row.id,
    event: meta.event as ContestNotificationEvent,
    contest_id: meta.contestId,
    integration_id: meta.integrationId,
    integration_name: typeof meta.integrationName === 'string' ? meta.integrationName : null,
    field: meta.field,
    // AECI-1046: a retire close says who retired it; an older one was the owner's.
    ...(meta.event === 'closed_by_retire'
      ? { retired_by: meta.retiredBy === 'aeci' ? ('aeci' as const) : ('owner' as const) }
      : {}),
    pair_path: pairPathFor(pairSlugs),
    created_at: row.createdAt,
    // AECI-1009 protest metadata. Absent on every older row, so each reads `null`.
    recipient_role:
      meta.recipientRole === 'submitter' || meta.recipientRole === 'owner'
        ? meta.recipientRole
        : null,
    protest_closes_at: typeof meta.protestClosesAt === 'string' ? meta.protestClosesAt : null,
    reply_due_at: typeof meta.replyDueAt === 'string' ? meta.replyDueAt : null,
    cooldown_until: typeof meta.cooldownUntil === 'string' ? meta.cooldownUntil : null,
  };
}

/**
 * Map one claim ledger row (AECI-1005), or `null` when it is not recognisable.
 * Same tolerance as the other two mappers.
 */
function toClaimNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorIntegrationClaimNotification | null {
  const meta = row.metadata as Partial<ClaimNotificationMetadata> | null;
  if (!meta || typeof meta.integrationId !== 'string') return null;
  const pair = meta.pairSlugs;
  const pairSlugs =
    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      ? ([pair[0], pair[1]] as const)
      : null;
  return {
    kind: 'integration_claim',
    id: row.id,
    integration_id: meta.integrationId,
    integration_name: typeof meta.integrationName === 'string' ? meta.integrationName : null,
    owner_name: typeof meta.ownerName === 'string' ? meta.ownerName : null,
    pair_path: pairPathFor(pairSlugs),
    created_at: row.createdAt,
  };
}

/**
 * Map one retire or restore ledger row (AECI-1010), or `null` when it is not
 * recognisable. Same tolerance as the other mappers.
 */
function toRetireNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorIntegrationRetireNotification | null {
  const meta = row.metadata as Partial<RetireNotificationMetadata> | null;
  if (!meta || typeof meta.integrationId !== 'string') return null;
  if (meta.event !== 'retired' && meta.event !== 'restored') return null;
  const pair = meta.pairSlugs;
  const pairSlugs =
    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      ? ([pair[0], pair[1]] as const)
      : null;
  return {
    kind: 'integration_retire',
    id: row.id,
    event: meta.event,
    integration_id: meta.integrationId,
    integration_name: typeof meta.integrationName === 'string' ? meta.integrationName : null,
    owner_name: typeof meta.ownerName === 'string' ? meta.ownerName : null,
    // AECI-1046. A row written before it carries no value: the owner retired it.
    retired_by: meta.retiredBy === 'aeci' ? 'aeci' : 'owner',
    // AECI-1159: only an AECi retire's owner row carries a reason, and only with the
    // vendor-visibility marker. Every other row, and every older one, reads `null`.
    reason: meta.retiredBy === 'aeci' ? vendorVisibleReason(meta) : null,
    pair_path: pairPathFor(pairSlugs),
    created_at: row.createdAt,
  };
}

/**
 * Map one owner-edit ledger row (AECI-1006), or `null` when it is not recognisable.
 * Same tolerance as the other mappers: a non-string field name is dropped, never
 * a 500.
 */
function toUpdateNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorIntegrationUpdateNotification | null {
  const meta = row.metadata as Partial<UpdateNotificationMetadata> | null;
  if (!meta || typeof meta.integrationId !== 'string') return null;
  const pair = meta.pairSlugs;
  const pairSlugs =
    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      ? ([pair[0], pair[1]] as const)
      : null;
  return {
    kind: 'integration_update',
    id: row.id,
    integration_id: meta.integrationId,
    integration_name: typeof meta.integrationName === 'string' ? meta.integrationName : null,
    owner_name: typeof meta.ownerName === 'string' ? meta.ownerName : null,
    fields: Array.isArray(meta.fields)
      ? meta.fields.filter((field): field is string => typeof field === 'string')
      : [],
    pair_path: pairPathFor(pairSlugs),
    created_at: row.createdAt,
  };
}

/**
 * Map one create ledger row (AECI-1011), or `null` when it is not recognisable.
 * Same tolerance as the other mappers.
 */
function toCreateNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorIntegrationCreateNotification | null {
  const meta = row.metadata as Partial<CreateNotificationMetadata> | null;
  if (!meta || typeof meta.integrationId !== 'string') return null;
  const pair = meta.pairSlugs;
  const pairSlugs =
    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      ? ([pair[0], pair[1]] as const)
      : null;
  return {
    kind: 'integration_create',
    id: row.id,
    integration_id: meta.integrationId,
    integration_name: typeof meta.integrationName === 'string' ? meta.integrationName : null,
    owner_name: typeof meta.ownerName === 'string' ? meta.ownerName : null,
    pair_path: pairPathFor(pairSlugs),
    created_at: row.createdAt,
  };
}

const CONTEXT_DIRECTIONS = new Set<string>(['inbound', 'outbound', 'both']);

/**
 * Map one `claim_added` ledger row (AECI-1153), or `null` when it is not
 * recognisable. Same tolerance as the other mappers. The row never carries the
 * note (§7.6), and nothing here reads one.
 */
function toClaimAddedNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorClaimAddedNotification | null {
  const meta = row.metadata as Partial<ClaimAddedNotificationMetadata> | null;
  if (!meta || typeof meta.integrationId !== 'string' || typeof meta.claimId !== 'string') {
    return null;
  }
  const dataObject = productRef(meta.dataObject);
  if (!dataObject) return null;
  if (typeof meta.direction !== 'string' || !CONTEXT_DIRECTIONS.has(meta.direction)) return null;
  const pair = meta.pairSlugs;
  const pairSlugs =
    Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
      ? ([pair[0], pair[1]] as const)
      : null;
  return {
    kind: 'claim_added',
    id: row.id,
    claim_id: meta.claimId,
    integration_id: meta.integrationId,
    integration_name: typeof meta.integrationName === 'string' ? meta.integrationName : null,
    data_object: dataObject,
    direction: meta.direction as ContextDirection,
    added_by_name: typeof meta.addedByName === 'string' ? meta.addedByName : null,
    counterpart_product: productRef(meta.counterpartProduct),
    pair_path: pairPathFor(pairSlugs),
    created_at: row.createdAt,
  };
}

const REVIEW_RESPONSE_EVENTS = new Set<string>(REVIEW_RESPONSE_NOTIFICATION_EVENTS);

/**
 * Map one `review` ledger row (AECI-1180), or `null` when it is not recognisable.
 * Same tolerance as the other mappers.
 */
function toReviewNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorReviewNotification | null {
  const meta = row.metadata as Partial<ReviewNotificationMetadata> | null;
  if (!meta || typeof meta.reviewId !== 'string') return null;
  const product = productRef(meta.product);
  if (!product || typeof meta.reviewTitle !== 'string') return null;
  return {
    kind: 'review',
    id: row.id,
    review_id: meta.reviewId,
    product,
    review_title: meta.reviewTitle,
    created_at: row.createdAt,
  };
}

/**
 * Map one `review_response` ledger row (AECI-1180), or `null` when it is not
 * recognisable. Same tolerance as the other mappers.
 */
function toReviewResponseNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorReviewResponseNotification | null {
  const meta = row.metadata as Partial<ReviewResponseNotificationMetadata> | null;
  if (!meta || typeof meta.responseId !== 'string' || typeof meta.reviewId !== 'string') {
    return null;
  }
  if (typeof meta.event !== 'string' || !REVIEW_RESPONSE_EVENTS.has(meta.event)) return null;
  const product = productRef(meta.product);
  if (!product) return null;
  return {
    kind: 'review_response',
    id: row.id,
    event: meta.event as ReviewResponseNotificationEvent,
    response_id: meta.responseId,
    review_id: meta.reviewId,
    product,
    reason: meta.event !== 'approved' && typeof meta.reason === 'string' ? meta.reason : null,
    created_at: row.createdAt,
  };
}

const AECI_OVERRIDE_EVENTS = new Set<string>(AECI_OVERRIDE_NOTIFICATION_EVENTS);

/**
 * Map one `aeci_override` ledger row (AECI-1159), or `null` when it is not
 * recognisable. Same tolerance as the other mappers. **A row without the
 * `reasonVisibility: 'vendor'` marker is dropped**, because its reason was never
 * written for a vendor. The internal note is never read.
 */
function toAeciOverrideNotification(row: {
  id: string;
  entityId: string | null;
  createdAt: string;
  metadata: unknown;
}): VendorAeciOverrideNotification | null {
  const meta = row.metadata as Partial<AeciOverrideNotificationMetadata> | null;
  if (!meta || typeof meta.event !== 'string' || !AECI_OVERRIDE_EVENTS.has(meta.event)) {
    return null;
  }
  const reason = vendorVisibleReason(meta);
  if (!reason) return null;
  const base = {
    kind: 'aeci_override' as const,
    id: row.id,
    reason,
    integration_id: null,
    integration_name: null,
    field: null,
    pair_path: null,
    logo_subject: null,
    logo_cleared: false,
    seat_name: null,
    created_at: row.createdAt,
  };
  switch (meta.event as AeciOverrideNotificationEvent) {
    case 'field_overridden': {
      if (typeof meta.integrationId !== 'string' || typeof meta.field !== 'string') return null;
      const pair = meta.pairSlugs;
      const pairSlugs =
        Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string'
          ? ([pair[0], pair[1]] as const)
          : null;
      return {
        ...base,
        event: 'field_overridden',
        integration_id: meta.integrationId,
        integration_name: typeof meta.integrationName === 'string' ? meta.integrationName : null,
        field: meta.field,
        pair_path: pairPathFor(pairSlugs),
      };
    }
    case 'logo_overridden': {
      const subject = meta.logoSubject as Partial<AeciOverrideLogoSubject> | undefined;
      const ref = productRef(subject);
      if (!ref || (subject?.type !== 'vendor' && subject?.type !== 'product')) return null;
      return {
        ...base,
        event: 'logo_overridden',
        logo_subject: { type: subject.type, ...ref },
        logo_cleared: meta.logoCleared === true,
      };
    }
    case 'seat_revoked':
      return {
        ...base,
        event: 'seat_revoked',
        seat_name: typeof meta.seatName === 'string' ? meta.seatName : null,
      };
  }
}

export function createListVendorNotificationsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    const rows = await db
      .select({
        id: auditLog.id,
        entityId: auditLog.entityId,
        createdAt: auditLog.createdAt,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(vendorNotificationLedgerWhere(vendorId))
      .orderBy(desc(auditLog.createdAt))
      .limit(NOTIFICATION_PAGE_SIZE);

    const body: ListVendorNotificationsResponse = {
      notifications: rows
        .map(toVendorNotification)
        .filter((n): n is VendorNotification => n !== null),
    };
    validateResponseInDev(c.env, () => ListVendorNotificationsResponseSchema.parse(body));
    return json(body);
  };
}
