/**
 * The in-portal notification list (`GET /api/vendor/notifications`, AECI-302 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §7.2) — Drizzle/D1.
 *
 * §7.3 chose `audit_log` as the detector sweep's dedupe ledger and noted that this
 * "gives the in-portal list its backing query for free". This module is that
 * query. There is no notifications table (decision §1.3(6)) and no new store:
 * every row here is a `notification.sent` audit row the daily sweep
 * (`lib/attestation-notify.ts`) wrote after a successful send.
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
 * authorization. Ops-routed ledger rows (the `aeci-denied` correction signal and
 * the ops half of `open-conflict`) carry `metadata.vendorId = null`, so they can
 * never match a caller: the isolation is structural rather than a clause someone
 * has to remember.
 *
 * **Not verified-gated.** `vendors.verified` gates authoring (§1), not reading —
 * an unverified vendor sees its own (probably empty) list rather than a 403 it
 * cannot act on. Same reasoning as `GET /api/vendor/products/:id/versions`.
 */

import {
  ListVendorNotificationsResponseSchema,
  type AttestationDetector,
  type ListVendorNotificationsResponse,
  type NotificationProductRef,
  type VendorNotification,
} from '@aeci/shared';
import { ATTESTATION_DETECTORS, orderedPairSlugs } from '@aeci/shared';
import { and, desc, eq, gte, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import { auditLog } from '../db/schema';
import { json } from '../http';
import {
  NOTIFICATION_SENT_ACTION,
  type NotificationLedgerMetadata,
} from '../lib/attestation-notify';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
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
    // The scoping filter. An ops row stores `"vendorId": null`, which
    // `json_extract` returns as SQL NULL — never equal to a caller's id.
    sql`json_extract(${auditLog.metadata}, '$.vendorId') = ${vendorId}`,
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
