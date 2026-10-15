/**
 * Product requests (AECI-1377, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6): the pieces the
 * vendor route, the admin route, the notification feed and the specs share.
 *
 * A seated vendor asks AECi to add the other product of an integration. An operator
 * decides it: `added`, `already_listed` or `declined`. The decision writes one
 * `notification.sent` row (registry id `portal-product-request-decided`) to the
 * requesting vendor in the decision batch, then emails the seat that asked
 * (`product-request-decided`) after commit.
 */

import type { ProductRequestOutcome } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productRequests, profiles } from '../db/schema';
import { logToPosthog } from '../posthog';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import {
  sendProductRequestDecidedEmail,
  type EmailContext,
  type ProductRequestDecision,
} from './email';
import { ONE_ROW } from './integration-claims';
import type { PortalNotificationId } from './notifications/registry';
import type { FetchSeatEmails } from './vendor-seat-recipients';

/** The registry id a decision's feed row records. */
export type ProductRequestPortalNotificationId = Extract<
  PortalNotificationId,
  'portal-product-request-decided'
>;

/** `audit_log.entity_type` on every product request row. */
export const PRODUCT_REQUEST_ENTITY_TYPE = 'product_request';

/** `audit_log.action` for a new request. */
export const PRODUCT_REQUEST_CREATED_ACTION = 'product_request.created';

/** `audit_log.action` for each decision. */
export const PRODUCT_REQUEST_DECISION_ACTION = {
  added: 'product_request.added',
  already_listed: 'product_request.already_listed',
  declined: 'product_request.declined',
} as const satisfies Record<ProductRequestOutcome, string>;

/** `metadata.kind` on the feed row a decision writes. */
export const PRODUCT_REQUEST_NOTIFICATION_KIND = 'product_request';

/** `product-request-alert:{requestId}`. One alert per saved request. */
export const productRequestAlertKey = (requestId: string) => `product-request-alert:${requestId}`;

/** `product-request-decided:{requestId}`. A request is decided once. */
export const productRequestDecidedKey = (requestId: string) =>
  `product-request-decided:${requestId}`;

/** The `{ slug, name }` snapshot the feed row records. */
export interface NotifiedRef {
  slug: string;
  name: string;
}

/** What a `product_request` feed row records. Every field is a decision-time snapshot. */
export interface ProductRequestNotificationMetadata {
  kind: typeof PRODUCT_REQUEST_NOTIFICATION_KIND;
  /** The registry entry (AECI-1199). */
  notificationId: ProductRequestPortalNotificationId;
  /** The RECIPIENT: the requesting vendor. */
  vendorId: string;
  event: ProductRequestOutcome;
  requestId: string;
  /** The name the vendor typed. */
  requestName: string;
  /** The linked catalog product, `null` on `declined`. */
  product: NotifiedRef | null;
  /** The vendor's own product the request came from. */
  contextProduct: NotifiedRef | null;
  /** The decline reason, shown to the vendor. Absent on the other two. */
  reason?: string;
}

/**
 * The `notification.sent` row telling the requesting vendor what AECi decided. Push it
 * into the decision batch AFTER the guarded UPDATE and its sentinel, so a lost race
 * rolls it back with the rest. `vendor_id` is the recipient, which the feed filters on.
 */
export function productRequestDecisionNotification(
  notification: ProductRequestPortalNotificationId,
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  input: {
    requestId: string;
    vendorId: string;
    event: ProductRequestOutcome;
    requestName: string;
    product: NotifiedRef | null;
    contextProduct: NotifiedRef | null;
    reason: string | null;
  },
): AuditLogEntry {
  const metadata: ProductRequestNotificationMetadata = {
    kind: PRODUCT_REQUEST_NOTIFICATION_KIND,
    notificationId: notification,
    vendorId: input.vendorId,
    event: input.event,
    requestId: input.requestId,
    requestName: input.requestName,
    product: input.product,
    contextProduct: input.contextProduct,
    ...(input.event === 'declined' && input.reason ? { reason: input.reason } : {}),
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: PRODUCT_REQUEST_ENTITY_TYPE,
    entityId: input.requestId,
    vendorId: input.vendorId,
    metadata,
  };
}

/**
 * A batch statement that ABORTS the decision when the guarded UPDATE right before it
 * changed no row: another admin decided the request between this handler's read and
 * its batch. The `contestStillOpenSentinel` pattern (`lib/integration-contests.ts`):
 * `json('…')` on a non-JSON string raises "malformed JSON", which rolls the whole
 * batch back, so the losing side writes no audit row and no portal row.
 *
 * FROM a one-row constant, so the guard is evaluated exactly once even when the
 * request row is gone.
 */
export function productRequestStillOpenSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('product-request-not-open') END` })
    .from(ONE_ROW);
}

/** True for the error {@link productRequestStillOpenSentinel} raises, in D1 or SQLite. */
export function isProductRequestRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (/malformed JSON/i.test(String((current as { message?: unknown }).message ?? current))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The trimmed, lower-cased name the open-duplicate check compares. */
export function productRequestNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** An open request of this vendor whose name matches, or `undefined`. */
export async function findOpenDuplicate(
  db: Db,
  vendorId: string,
  name: string,
): Promise<{ id: string } | undefined> {
  const [hit] = await db
    .select({ id: productRequests.id })
    .from(productRequests)
    .where(
      and(
        eq(productRequests.vendorId, vendorId),
        eq(productRequests.status, 'open'),
        sql`lower(trim(${productRequests.name})) = ${productRequestNameKey(name)}`,
      ),
    )
    .limit(1);
  return hit;
}

/**
 * The address of the seat that asked, or `null` when the seat is gone (§4.7.6): the
 * profile is no longer an unbanned `vendor_admin` of the requesting vendor, or the
 * privileged seam returns no address for it. Then no email is sent, and the portal row
 * is the record. Throws only on a D1 error.
 */
export async function requesterSeatEmail(
  db: Db,
  env: EmailContext['env'],
  request: { requestedBy: string; vendorId: string },
  fetchSeatEmails: FetchSeatEmails,
): Promise<string | null> {
  const [seat] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        eq(profiles.id, request.requestedBy),
        eq(profiles.vendorId, request.vendorId),
        eq(profiles.role, VENDOR_ADMIN_ROLE),
        isNull(profiles.bannedAt),
      ),
    )
    .limit(1);
  if (!seat) return null;
  const emails = await fetchSeatEmails(env, [seat.id]);
  return emails.get(seat.id) ?? null;
}

/** The decision email seam, injected so specs can observe it. */
export type SendProductRequestDecided = typeof sendProductRequestDecidedEmail;

/**
 * Email the seat that asked about the decision. Runs post-commit inside
 * `ctx.waitUntil` and NEVER throws: a failure warns, and the decision is already
 * committed with its portal row.
 */
export async function emailProductRequestDecision(
  c: EmailContext,
  db: Db,
  input: {
    requestId: string;
    requestName: string;
    vendorId: string;
    vendorSlug: string | null;
    requestedBy: string;
    contextProductSlug: string | null;
    decision: ProductRequestDecision;
  },
  fetchSeatEmails: FetchSeatEmails,
  send: SendProductRequestDecided = sendProductRequestDecidedEmail,
): Promise<void> {
  try {
    const to = await requesterSeatEmail(db, c.env, input, fetchSeatEmails);
    if (!to) return;
    await send(c, {
      to,
      requestId: input.requestId,
      requestName: input.requestName,
      vendorSlug: input.vendorSlug,
      contextProductSlug: input.contextProductSlug,
      decision: input.decision,
      dedupeKey: productRequestDecidedKey(input.requestId),
    });
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: 'product-request decided email failed',
      source: 'product-requests',
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}
