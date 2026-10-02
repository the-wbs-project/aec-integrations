/**
 * Per-user daily activity (AECI-1208, `DATABASE_SCHEMA.md` §9.11).
 *
 * `user_activity_daily` keeps one row per signed-in user per UTC day. It is a
 * per-user service log (ADR 0022, 2026-10-02 amendment): operator-only, never
 * shown to the user or the public, erased with the account, pruned at 400 days.
 *
 * This module is the closed vocabulary both sides share: the surface bit map the
 * API middleware writes, the decoder every reader goes through, and the arrival
 * params the beacon reports. The beacon's Zod body schema is in
 * `./activity-arrival.ts`.
 *
 * **Deliberately zod-free.** The browser's `ArrivalCaptureService` starts in the
 * app shell, so anything it imports lands in the initial bundle on every page.
 * Zod must not (AECI-221). The plain checks below and the schema share their
 * constants, and `user-activity.spec.ts` asserts they agree.
 */

/**
 * The surfaces a request can mark, as bits of `user_activity_daily.surfaces`.
 * The set is closed. A bitmask makes the per-day merge one atomic SQL expression
 * (`surfaces | excluded.surfaces`). Never renumber a bit: stored rows keep it.
 */
export const USER_ACTIVITY_SURFACE_BITS = {
  vendor_portal: 1,
  admin: 2,
  account: 4,
  reviews: 8,
} as const;

export type UserActivitySurface = keyof typeof USER_ACTIVITY_SURFACE_BITS;

/** Every surface, in bit order. */
export const USER_ACTIVITY_SURFACES = Object.keys(
  USER_ACTIVITY_SURFACE_BITS,
) as UserActivitySurface[];

/** Turn a stored bitmask into surface names, in bit order. Unknown bits are dropped. */
export function decodeUserActivitySurfaces(mask: number): UserActivitySurface[] {
  return USER_ACTIVITY_SURFACES.filter((s) => (mask & USER_ACTIVITY_SURFACE_BITS[s]) !== 0);
}

/** Turn surface names into a bitmask. */
export function encodeUserActivitySurfaces(surfaces: readonly UserActivitySurface[]): number {
  return surfaces.reduce((mask, s) => mask | USER_ACTIVITY_SURFACE_BITS[s], 0);
}

/**
 * The landing-URL query params the arrival beacon reports, and the only params the
 * SSR sign-in bounce carries into `?return=` (`apps/web/src/server-runtime.ts`).
 * Nothing else is carried.
 */
export const ARRIVAL_QUERY_PARAMS = ['utm_source', 'utm_campaign', 'n'] as const;
export type ArrivalQueryParam = (typeof ARRIVAL_QUERY_PARAMS)[number];

/** Longest value stored for any arrival param. */
export const ARRIVAL_VALUE_MAX_LENGTH = 100;

/**
 * The `n` param is a `notification_sends.id` (AECI-1202): an `AUTOINCREMENT`
 * integer, so a positive decimal with no leading zero. 15 digits stays inside
 * `Number.MAX_SAFE_INTEGER`.
 */
export const NOTIFICATION_SEND_ID_PATTERN = /^[1-9][0-9]{0,14}$/;

/** Whether `value` is an acceptable value for arrival param `key`. */
export function isValidArrivalValue(key: ArrivalQueryParam, value: string): boolean {
  if (key === 'n') return NOTIFICATION_SEND_ID_PATTERN.test(value);
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= ARRIVAL_VALUE_MAX_LENGTH;
}

/** The arrival params, as the beacon body carries them. */
export type ArrivalParams = Partial<Record<ArrivalQueryParam, string>>;

/**
 * Read the arrival params from a query string, keeping only values the beacon
 * accepts. Returns null when none survive. The browser beacon uses it, so the
 * client never sends a body the server would refuse.
 */
export function arrivalFromSearch(search: string): ArrivalParams | null {
  const params = new URLSearchParams(search);
  const out: ArrivalParams = {};
  for (const key of ARRIVAL_QUERY_PARAMS) {
    const value = params.get(key)?.trim();
    if (value && isValidArrivalValue(key, value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The valid allowlisted arrival params of `search`, as a query string with a
 * leading `?`, or `''` when there are none. The SSR sign-in bounce uses it to
 * carry the arrival through `?return=` and drop every other param, so a hostile
 * or oversized value never rides the login round trip.
 */
export function arrivalQueryString(search: string): string {
  const arrival = arrivalFromSearch(search);
  if (!arrival) return '';
  const out = new URLSearchParams();
  for (const key of ARRIVAL_QUERY_PARAMS) {
    const value = arrival[key];
    if (value !== undefined) out.set(key, value);
  }
  return `?${out.toString()}`;
}
