import { z } from 'zod';

/**
 * The vendor-portal freshness cursor (`GET /api/vendor/updates`, AECI-627 /
 * `STAGE_2_REALTIME_SPEC.md` §2), behind the `requireVendor()` guard.
 *
 * ADR 0023 chose **scoped client revalidation over a cheap per-vendor cursor**
 * instead of Durable-Object WebSockets or SSE: nothing that changes a vendor's
 * portal state is sub-second (two of the six producers are once-a-day crons), so
 * the house "poll a tiny endpoint" pattern — the same one `GET
 * /api/promote/jobs/:id` uses — buys the whole §2.3 outcome at a fraction of the
 * moving parts. This module is that endpoint's wire contract.
 *
 * ── WHY PER-SCOPE AND NOT ONE OPAQUE REVISION ───────────────────────────────
 * One revision for the whole portal would be cheaper to compute and strictly
 * worse to consume: any write anywhere (a counterparty's attestation, the
 * nightly detector sweep, an admin's entitlement toggle) would invalidate the
 * whole dashboard and force a refetch of every section, which is exactly the
 * "reload the page" behaviour the epic exists to remove. Six independent cursors
 * let the client refetch only what moved.
 *
 * ── WHAT A CURSOR IS, AND IS NOT ────────────────────────────────────────────
 * A cursor is the newest `updated_at` (or, for the two tables that have none,
 * the newest lifecycle timestamp) across the rows **that scope feeds**. It is
 * deliberately NOT a hash, a version counter, or an ETag:
 *
 *   - It is comparable client-side with `!==` alone — the client stores the last
 *     value it acted on and refetches when the string differs. No parsing, no
 *     clock arithmetic, no dependence on the browser's clock agreeing with the
 *     server's.
 *   - `null` means "this vendor has no rows of that kind at all", which is a
 *     stable, meaningful value: a vendor with no requests keeps `requests: null`
 *     forever, and the client never refetches that section. `null` is not
 *     "unknown" and must never be treated as "changed".
 *
 * Values are **compared as strings, never as dates**. SQLite's `MAX()` over a
 * TEXT column is a lexicographic comparison, and every `*_at` column in the app
 * DB is an ISO-8601 UTC string produced by `toISOString()`, for which
 * lexicographic and chronological order coincide. Keeping the client on string
 * equality means a value the server could produce but `Date.parse` mangles can
 * still never be mistaken for "unchanged".
 *
 * ── NO VENDOR ID CROSSES THE WIRE ───────────────────────────────────────────
 * As everywhere on `/api/vendor/*` (the AECI-520 invariant), the caller's vendor
 * comes from the session and scopes every query server-side. The request carries
 * no parameters at all, which is also why the response cannot be a delta: the
 * endpoint has no idea what the client last saw, and deliberately keeps no
 * per-client state to find out.
 *
 * i18n note: framework-agnostic package (no `$localize`) — nothing here is
 * user-visible copy.
 */

/**
 * One `revisions` entry per portal scope. Every key is `string | null` — see the
 * header for what `null` means and why the type is uniform.
 *
 * The scope names are also the client's refetch vocabulary
 * (`STAGE_2_REALTIME_SPEC.md` §3): `profile` · `entitlement` · `products` ·
 * `requests` all resolve to `GET /api/vendor/me` (one deduped call),
 * `integrations` to `GET /api/vendor/integrations`, and `notifications` to
 * `GET /api/vendor/notifications`. Adding a scope here without adding it to that
 * map ships a cursor nothing acts on.
 */
export const VendorRevisionsSchema = z.object({
  /** `vendors.updated_at` — also moves on the `verified` mirror flip. */
  profile: z.string().nullable(),
  /** `MAX(vendor_entitlements.updated_at)`; `vendor_id` is UNIQUE, so ≤ 1 row. */
  entitlement: z.string().nullable(),
  /** `MAX(products.updated_at)` over the vendor's `product_vendors` rows. */
  products: z.string().nullable(),
  /** `MAX` over claims ∪ attestations on the vendor's attestable integrations. */
  integrations: z.string().nullable(),
  /** `MAX(audit_log.created_at)` over this vendor's `notification.sent` ledger. */
  notifications: z.string().nullable(),
  /** `MAX(COALESCE(resolved_at, created_at))` — `vendor_requests` has no `updated_at`. */
  requests: z.string().nullable(),
});
export type VendorRevisions = z.infer<typeof VendorRevisionsSchema>;

export type VendorPortalScope = keyof VendorRevisions;

/**
 * The scope list, derived from the schema shape rather than restated.
 *
 * The intermediate map exists purely for the `satisfies`: it fails to compile if
 * a scope is missing (the `Record` demands every key) **and** if one is invented
 * (an object-literal excess-property check rejects it), so the runtime list and
 * the wire shape cannot drift apart in either direction.
 */
const SCOPE_INDEX = {
  profile: true,
  entitlement: true,
  products: true,
  integrations: true,
  notifications: true,
  requests: true,
} satisfies Record<VendorPortalScope, true>;

export const VENDOR_PORTAL_SCOPES = Object.keys(SCOPE_INDEX) as readonly VendorPortalScope[];

/**
 * `server_time` is the instant the cursors are valid as of, stamped **before**
 * the read rather than after it. The conservative direction: a change that lands
 * mid-read is reported on the next poll instead of being silently skipped over
 * by a client that treated `server_time` as a high-water mark.
 *
 * It is advisory. The client must not do clock arithmetic against it to decide
 * whether to refetch (browser clocks are wrong often enough to matter) — it is
 * there for logging, for a "last checked" affordance, and for measuring skew.
 */
export const VendorUpdatesResponseSchema = z.object({
  revisions: VendorRevisionsSchema,
  server_time: z.string().datetime(),
});
export type VendorUpdatesResponse = z.infer<typeof VendorUpdatesResponseSchema>;
