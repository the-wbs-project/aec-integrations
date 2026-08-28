/**
 * The arithmetic behind `<aec-relative-time>` (AECI-694), kept in a plain module
 * with no Angular and no `$localize` so it can be unit-tested under the Vitest
 * runner (`*.spec.ts`) rather than the component one.
 *
 * It returns a STRUCTURE, not a string. The compact labels ("2d", "4h") are
 * user-visible copy and therefore have to be `$localize` messages, which only
 * resolve inside the app bundle; splitting the boundary here keeps every
 * threshold directly testable and leaves exactly one place (the component) that
 * knows how a span is spelled.
 *
 * No date library is involved, and none should be: the repo has never carried
 * one (`date-fns` / `dayjs` / `luxon` are absent from every `package.json`), and
 * this is subtraction and division.
 */

/** Coarsest unit that still describes the span. `now` carries no number. */
export type RelativeUnit = 'now' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface RelativeSpan {
  readonly unit: RelativeUnit;
  /** Whole units elapsed, floored. Always 0 for `now`. */
  readonly value: number;
  /**
   * The instant is in the FUTURE. Defensive rather than speculative: the audit
   * trail is past-only, but clock skew between a Worker and a browser is real
   * and routinely a second or two, so a just-written row can arrive "ahead" of
   * the reader. Under a minute that lands in `now`; beyond it the caller says
   * "in 3d" instead of silently rendering a past-tense lie.
   */
  readonly future: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Where each unit gives way to the next.
 *
 * Weeks stop at 4 rather than at a calendar month, and months are 30 days flat:
 * a compact stamp is a "how stale is this" signal, not an interval calculation,
 * and a reader who needs the exact instant has the info affordance beside it.
 * Trying to be calendar-exact here would buy nothing and cost a month-length
 * table.
 */
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Describe the gap between `iso` and `nowMs`.
 *
 * Returns `null` when `iso` is not a parseable date, so the caller can fall back
 * to rendering the raw value. That is not a hypothetical: `audit_log` is
 * excluded from the retention prune, so today's reader parses rows written by
 * code that no longer exists, and `AdminAuditRowSchema.created_at` is a bare
 * `z.string()` with no `.datetime()` refinement precisely to let those through.
 */
export function relativeSpan(iso: string, nowMs: number): RelativeSpan | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  const delta = nowMs - then;
  const future = delta < 0;
  const abs = Math.abs(delta);

  if (abs < MINUTE) return { unit: 'now', value: 0, future: false };
  if (abs < HOUR) return { unit: 'minute', value: Math.floor(abs / MINUTE), future };
  if (abs < DAY) return { unit: 'hour', value: Math.floor(abs / HOUR), future };
  if (abs < WEEK) return { unit: 'day', value: Math.floor(abs / DAY), future };
  if (abs < MONTH) return { unit: 'week', value: Math.floor(abs / WEEK), future };
  if (abs < YEAR) return { unit: 'month', value: Math.floor(abs / MONTH), future };
  return { unit: 'year', value: Math.floor(abs / YEAR), future };
}
