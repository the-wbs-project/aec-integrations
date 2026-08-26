/**
 * The vendor-portal freshness cursor (`GET /api/vendor/updates`, AECI-627 /
 * `STAGE_2_REALTIME_SPEC.md` §2) — Drizzle/D1.
 *
 * ADR 0023 answered `STAGE_2_SPEC.md` §8.2's deferred transport question with
 * **scoped client revalidation over a cheap per-vendor cursor**, not Durable-Object
 * WebSockets and not SSE. Nothing that changes a vendor's portal state is
 * sub-second — two of the six producers are once-a-day crons — so a socket would
 * deliver a 24-hour-stale event with 50 ms of transport latency, at the cost of a
 * `durable_objects` binding in four wrangler environments, a WebSocket upgrade
 * threaded through the SSR Worker's `/api/*` passthrough, and fan-out coupling on
 * every write. This endpoint is the whole server side of the alternative.
 *
 * The client (`VendorLiveSync`, AECI-629) polls it on a visibility-aware cadence
 * and refetches **only** the sections whose cursor moved.
 *
 * ── THE INVARIANT THIS MODULE EXISTS TO HOLD ────────────────────────────────
 * **Every cursor query reuses the scoping predicate of the handler it is a cursor
 * for.** Not "an equivalent predicate" — the same one, imported, so the two
 * cannot drift. A cursor that scopes differently from its payload fails in one of
 * two directions, and both are silent:
 *
 *   - **Too narrow** → the cursor never moves for a change the payload would
 *     show. The client stops refetching that section and the portal goes
 *     permanently stale, with no error anywhere to notice.
 *   - **Too wide** → the cursor moves on a row the payload will never return.
 *     The client refetches forever and finds nothing (a self-inflicted poll
 *     amplifier), and worse, the timestamp itself leaks the *existence* of
 *     another vendor's write. There is no RLS behind `/api/vendor/*` (ADR 0016),
 *     so a `WHERE` clause here is not a filter — it IS the authorization.
 *
 * So the predicates live at their handlers, not here:
 *
 *   | scope          | predicate lives in                                          |
 *   |----------------|-------------------------------------------------------------|
 *   | `profile`      | trivially `vendors.id = <session vendor>`                    |
 *   | `entitlement`  | trivially `vendor_entitlements.vendor_id = <session vendor>` |
 *   | `products`     | `ownedProductIds` (`vendor-shared.ts`)                       |
 *   | `integrations` | `ownedEndpointJoin` (`lib/attestation-authority.ts`)         |
 *   | `notifications`| `vendorNotificationLedgerWhere` (`vendor-notifications.ts`)  |
 *   | `requests`     | `vendorRequestsWhere` (`vendor-shared.ts`)                   |
 *
 * `vendorId` comes from `c.get('auth')` and never from the request — the AECI-520
 * invariant; the endpoint takes no parameters at all.
 *
 * ── READ-ONLY: NO `audit_log` ROW ───────────────────────────────────────────
 * §26.1 governs writes ("no state change without an audit row"). This changes no
 * state, so it emits nothing — and it must stay that way: at one poll per 20 s
 * per open tab, auditing it would make the `audit_log` scan that
 * `GET /api/vendor/notifications` depends on grow without bound, i.e. this
 * endpoint would degrade the very list it is a cursor for.
 *
 * ── ONE ROUND TRIP ──────────────────────────────────────────────────────────
 * Six SELECTs in one `db.batch([...])`. The Worker pays per D1 hop, and this is
 * the most frequently called endpoint on the surface, so six sequential reads
 * would multiply the epic's cost by six for no benefit. Each statement returns a
 * single aggregate row, so the response payload of the batch is six scalars.
 *
 * `db.batch` here carries **no** mutation, which makes it the one batch in the
 * codebase that is not about atomicity. It is about the round trip. (Atomicity is
 * free anyway: six aggregate reads have nothing to roll back.)
 */

import {
  VENDOR_PORTAL_SCOPES,
  VendorUpdatesResponseSchema,
  type VendorRevisions,
  type VendorUpdatesResponse,
} from '@aeci/shared';
import { eq, inArray, max, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import {
  attestations,
  auditLog,
  claims,
  integrations,
  productVendors,
  products,
  vendorEntitlements,
  vendorRequests,
  vendors,
} from '../db/schema';
import { submitCount } from '../posthog';
import { json } from '../http';
import { ownedEndpointJoin } from '../lib/attestation-authority';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { vendorNotificationLedgerWhere } from './vendor-notifications';
import {
  ownedProductIds,
  sessionVendorId,
  vendorRequestsWhere,
  type VendorContext,
} from './vendor-shared';

/**
 * How recent the newest cursor must be for a response to be tagged
 * `changed:some`.
 *
 * The endpoint is stateless — it has no idea what the caller last saw — so
 * "changed" cannot mean "changed since your last poll". It means **"something in
 * this vendor's portal moved within one poll interval of this response"**, which
 * is the question the metric is actually there to answer: would a poll at the
 * shipped cadence have carried news?
 *
 * The value is the **longest** shipped interval (60 s, the visible-but-unfocused
 * lane), not the shortest. That deliberately over-counts `some` for a 20 s
 * focused client — one write can be tagged `some` on three consecutive polls —
 * because the decision this metric feeds is "is the polling transport still the
 * right call, or is it time for the Durable Object?" and that decision must not
 * be biased toward "nothing ever changes". Read the `some` ratio as an upper
 * bound.
 */
export const VENDOR_UPDATES_CHANGE_WINDOW_MS = 60_000;

/**
 * The later of two cursors, compared **as strings**.
 *
 * That is not laziness: it is the same comparison SQLite's `MAX()` just performed
 * over the same TEXT columns, so the merge below cannot disagree with the
 * aggregates it is merging. Every `*_at` column in the app DB is an ISO-8601 UTC
 * string from `toISOString()`, for which lexicographic and chronological order
 * coincide. `Date.parse` would introduce a second, subtly different ordering, and
 * would turn a value it cannot parse into `NaN` — i.e. into "not newer", which is
 * the stale direction.
 */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * `some` when anything moved inside {@link VENDOR_UPDATES_CHANGE_WINDOW_MS} of
 * `asOf`, `none` otherwise. An unparseable cursor counts as `none` — a metric
 * must never be the thing that 500s a request.
 */
function changedTag(revisions: VendorRevisions, asOf: number): 'none' | 'some' {
  const newest = VENDOR_PORTAL_SCOPES.reduce<string | null>(
    (acc, scope) => laterOf(acc, revisions[scope]),
    null,
  );
  if (newest === null) return 'none';
  const at = Date.parse(newest);
  return Number.isFinite(at) && at >= asOf - VENDOR_UPDATES_CHANGE_WINDOW_MS ? 'some' : 'none';
}

export function createVendorUpdatesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);

    // Stamped BEFORE the read, so `server_time` is never later than the data it
    // describes. A change landing mid-batch is then reported on the next poll
    // rather than skipped by a client treating it as a high-water mark.
    const asOf = Date.now();

    const [profileRows, entitlementRows, productRows, integrationRows, ledgerRows, requestRows] =
      await db.batch([
        // `profile` — the vendor's own row. Also moves on the `verified` mirror
        // flip, which is the point: that flip is an admin action the vendor must
        // see without reloading.
        db.select({ value: vendors.updatedAt }).from(vendors).where(eq(vendors.id, vendorId)),

        // `entitlement` — `vendor_entitlements.vendor_id` is UNIQUE, so this is a
        // MAX over at most one row. `max()` rather than a plain select anyway:
        // an aggregate with no GROUP BY always returns exactly one row (NULL when
        // the set is empty), so the "no entitlement ever arranged" case needs no
        // branch here.
        db
          .select({ value: max(vendorEntitlements.updatedAt) })
          .from(vendorEntitlements)
          .where(eq(vendorEntitlements.vendorId, vendorId)),

        // `products` — every product the vendor owns, via the shared subquery.
        db
          .select({ value: max(products.updatedAt) })
          .from(products)
          .where(inArray(products.id, ownedProductIds(db, vendorId))),

        // `integrations` — claims ∪ attestations on the caller's ATTESTABLE
        // surface, over the exact three-table join `resolveClaimAuthority` uses.
        //
        // Two deliberate choices:
        //   1. `LEFT JOIN attestations`, so a claim with no attestation still
        //      contributes its own `updated_at`. The join multiplies rows
        //      (a vendor owning both endpoints matches `product_vendors` twice);
        //      MAX is insensitive to duplicates, so that costs nothing but scan.
        //   2. **No `retracted_at IS NULL` filter**, unlike the list handler's
        //      `liveAttestationsWhere`. That is a CONTENT filter, not a scoping
        //      one, and applying it here would break the cursor: a bare retract
        //      (DELETE with no replacement) only stamps `retracted_at` on the
        //      existing row, so a live-only cursor would not move even though the
        //      lane the vendor is looking at just emptied.
        db
          .select({
            claims: max(claims.updatedAt),
            attestations: max(attestations.updatedAt),
          })
          .from(claims)
          .innerJoin(integrations, eq(integrations.id, claims.integrationId))
          .innerJoin(productVendors, ownedEndpointJoin(vendorId))
          .leftJoin(attestations, eq(attestations.claimId, claims.id)),

        // `notifications` — the §7.3 `notification.sent` ledger, under the list
        // endpoint's own predicate (action + 90-day window + the `json_extract`
        // vendor filter). Ops-routed rows store `metadata.vendorId = null`, which
        // `json_extract` returns as SQL NULL and can therefore never equal a
        // caller's id — the same structural isolation the list relies on.
        db
          .select({ value: max(auditLog.createdAt) })
          .from(auditLog)
          .where(vendorNotificationLedgerWhere(vendorId)),

        // `requests` — `vendor_requests` carries NO `updated_at` column (verified
        // against `db/schema.ts`), and its only mutation after insert is the
        // admin resolve, which stamps `resolved_at`. So COALESCE over the two
        // lifecycle columns is the whole change surface: an open request reports
        // when it arrived, a resolved one when it was answered.
        db
          .select({
            value: max(sql`coalesce(${vendorRequests.resolvedAt}, ${vendorRequests.createdAt})`),
          })
          .from(vendorRequests)
          .where(vendorRequestsWhere(vendorId, ownedProductIds(db, vendorId))),
      ]);

    const integrationRow = integrationRows[0];
    const revisions: VendorRevisions = {
      // A granted seat whose vendor row has since been deleted reports `null`
      // rather than 404-ing. `GET /api/vendor/me` owns that 404; a cursor that
      // threw would only take the poll loop down alongside it.
      profile: profileRows[0]?.value ?? null,
      entitlement: entitlementRows[0]?.value ?? null,
      products: productRows[0]?.value ?? null,
      integrations: laterOf(integrationRow?.claims ?? null, integrationRow?.attestations ?? null),
      notifications: ledgerRows[0]?.value ?? null,
      requests: requestRows[0]?.value ?? null,
    };

    const body: VendorUpdatesResponse = {
      revisions,
      server_time: new Date(asOf).toISOString(),
    };

    // A high `none` ratio is the evidence for lengthening the poll interval; a
    // high `some` ratio is the evidence for revisiting ADR 0023's re-open
    // trigger. Cataloged in `docs/OBSERVABILITY.md`.
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.api.vendor.updates', 1, [
      `changed:${changedTag(revisions, asOf)}`,
    ]);

    validateResponseInDev(c.env, () => VendorUpdatesResponseSchema.parse(body));
    // `json()` defaults to `private, no-store`. Load-bearing rather than
    // incidental: the response is per-vendor and by construction stale the
    // instant it is written, so an intermediary caching it would report
    // "nothing changed" to a portal where something had.
    return json(body);
  };
}
