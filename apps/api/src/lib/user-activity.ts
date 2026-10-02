/**
 * The `user_activity_daily` writers' shared core (AECI-1208, `DATABASE_SCHEMA.md`
 * §9.11).
 *
 * Two callers write the row:
 *
 *   - `activityMiddleware()` (`../activity-middleware.ts`), after every
 *     authenticated request, in `waitUntil`, throttled per isolate;
 *   - `POST /api/activity/arrival` (`../routes/activity-arrival.ts`), inline, once
 *     per landing that carried `utm_source`, `utm_campaign` or `n`.
 *
 * Both run the ONE statement below. It is a per-user service log (ADR 0022,
 * 2026-10-02 amendment), so no `audit_log` row rides with it.
 *
 * ─── Why the upsert is gated on the profile ──────────────────────────────────
 *
 * Erasure (`DELETE /api/account`) deletes the user's rows in its batch. A write
 * that lands after that batch would bring a row back for a user who no longer
 * exists, and nothing would ever delete it again. Two things stop that:
 *
 *   1. the middleware never writes on `DELETE /api/account` itself;
 *   2. the INSERT selects from `WHERE EXISTS (SELECT 1 FROM profiles WHERE id = ?)`,
 *      so a request from another tab that races the delete inserts nothing.
 *
 * ─── What a conflict may change ──────────────────────────────────────────────
 *
 * Only `last_seen_at` (the later of the two) and `surfaces` (bitwise OR). The
 * arrival group (`arrival_*`) is written as a unit, only while the row has none:
 * the first arrival of the day wins, and a later one never mixes into it.
 * `first_seen_at`, `role` and `vendor_id` are fixed at first sight.
 */

import { USER_ACTIVITY_SURFACE_BITS } from '@aeci/shared';
import { sql } from 'drizzle-orm';

import type { Db } from '../db/client';

/** The values one write carries. */
export interface UserActivityWrite {
  userId: string;
  role: string;
  vendorId: string | null;
  /** The request instant. Its UTC date is the row's `day`. */
  at: Date;
  /** Bits to OR into `surfaces`. 0 records the day and sets no bit. */
  surfaces: number;
  arrival?: {
    utmSource: string | null;
    utmCampaign: string | null;
    notificationId: string | null;
  };
}

/** `YYYY-MM-DD` in UTC, the `metrics_daily.day` format. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * The profile-gated upsert. One statement, no batch: it is the whole write, and a
 * log row never rides inside a domain batch.
 */
export async function upsertUserActivity(db: Db, w: UserActivityWrite): Promise<void> {
  const iso = w.at.toISOString();
  const arrival = w.arrival ?? null;
  const hasArrival =
    arrival !== null &&
    (arrival.utmSource !== null || arrival.utmCampaign !== null || arrival.notificationId !== null);
  const arrivalAt = hasArrival ? iso : null;

  await db.run(sql`
    INSERT INTO user_activity_daily (
      user_id, day, role, vendor_id, first_seen_at, last_seen_at, surfaces,
      arrival_utm_source, arrival_utm_campaign, arrival_notification_id, arrival_at
    )
    SELECT
      ${w.userId}, ${utcDay(w.at)}, ${w.role}, ${w.vendorId}, ${iso}, ${iso}, ${w.surfaces},
      ${hasArrival ? arrival.utmSource : null},
      ${hasArrival ? arrival.utmCampaign : null},
      ${hasArrival ? arrival.notificationId : null},
      ${arrivalAt}
    WHERE EXISTS (SELECT 1 FROM profiles WHERE id = ${w.userId})
    ON CONFLICT (user_id, day) DO UPDATE SET
      last_seen_at = max(user_activity_daily.last_seen_at, excluded.last_seen_at),
      surfaces = user_activity_daily.surfaces | excluded.surfaces,
      arrival_utm_source = CASE WHEN user_activity_daily.arrival_at IS NULL
        THEN excluded.arrival_utm_source ELSE user_activity_daily.arrival_utm_source END,
      arrival_utm_campaign = CASE WHEN user_activity_daily.arrival_at IS NULL
        THEN excluded.arrival_utm_campaign ELSE user_activity_daily.arrival_utm_campaign END,
      arrival_notification_id = CASE WHEN user_activity_daily.arrival_at IS NULL
        THEN excluded.arrival_notification_id ELSE user_activity_daily.arrival_notification_id END,
      arrival_at = COALESCE(user_activity_daily.arrival_at, excluded.arrival_at)
  `);
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * The surface bits one API request marks, from its method and path.
 *
 * | Bit | Surface | Path |
 * |---|---|---|
 * | 1 | `vendor_portal` | `/api/vendor/…` |
 * | 2 | `admin` | `/api/admin/…` |
 * | 4 | `account` | `/api/account/…`, `/api/seat-invites/…` |
 * | 8 | `reviews` | `/api/reviews`, `/api/reviews/…` |
 *
 * Exact `/api/account` marks nothing. The site header probes `GET /api/account`
 * once per signed-in tab on every page (`apps/web` `RoleStatus`), and the listing
 * view toggle `PATCH`es it from the catalog. Counting either would set the
 * account bit for nearly every user every day, and the bit would mean nothing.
 * The `/account` page itself loads `GET /api/account/reviews`, which does count.
 *
 * Any other path records the day and sets no bit.
 */
export function surfacesForRequest(path: string): number {
  if (path.startsWith('/api/vendor/')) return USER_ACTIVITY_SURFACE_BITS.vendor_portal;
  if (path.startsWith('/api/admin/')) return USER_ACTIVITY_SURFACE_BITS.admin;
  if (path.startsWith('/api/account/') || path.startsWith('/api/seat-invites/')) {
    return USER_ACTIVITY_SURFACE_BITS.account;
  }
  if (path === '/api/reviews' || path.startsWith('/api/reviews/')) {
    return USER_ACTIVITY_SURFACE_BITS.reviews;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Throttle
// ---------------------------------------------------------------------------

/** A key re-writes at most this often, unless a new surface bit appears. */
export const ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;

/** Keys one isolate remembers before it forgets them all. */
export const ACTIVITY_THROTTLE_MAX_KEYS = 5000;

/**
 * Per-isolate memory of the last write per `userId|day`.
 *
 * The first per-isolate throttle in the API. It is safe because the SQL is
 * idempotent: forgetting a key (a new isolate, the cap clearing the map) costs one
 * extra write, never a lost row or a wrong value. Isolates do not share it, so the
 * true write rate is "at most once per 5 minutes per user per isolate".
 */
export class ActivityThrottle {
  private readonly seen = new Map<string, { at: number; mask: number }>();

  constructor(
    private readonly intervalMs = ACTIVITY_THROTTLE_MS,
    private readonly maxKeys = ACTIVITY_THROTTLE_MAX_KEYS,
  ) {}

  /**
   * Whether this request should write, and if so remember it. Writes when the key
   * is new, when `bits` adds a surface the key has not written, or when the
   * interval has passed since the key's last write.
   */
  shouldWrite(key: string, bits: number, nowMs: number): boolean {
    const prev = this.seen.get(key);
    if (prev && (prev.mask | bits) === prev.mask && nowMs - prev.at < this.intervalMs) {
      return false;
    }
    if (!prev && this.seen.size >= this.maxKeys) this.seen.clear();
    this.seen.set(key, { at: nowMs, mask: (prev?.mask ?? 0) | bits });
    return true;
  }

  /** Keys currently remembered. For tests. */
  get size(): number {
    return this.seen.size;
  }
}
