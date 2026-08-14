/**
 * Number and date formatting for the operator console — AECI-578 / Phase 8.3
 * P1.4. Source of truth: `docs/ADMIN_PANEL_SPEC.md` §9.5 (timezone) and §9.8
 * (the visitor definition), plus the `dataviz` skill for numeric form.
 *
 * Pure and Angular-free for the same reason as `geometry.ts`: it tests under the
 * fast plain-Vitest runner, and §11 requires "UTC boundary tests, including the
 * WIB presentation offset".
 *
 * ─── The timezone rule, and why it is a formatting concern only ──────────────
 *
 * §9.5: UTC is the only window the API speaks, the digest and all eight crons are
 * UTC-only, and the operator is at UTC+7. **The WIB toggle is presentational.**
 * That is not a soft preference — it is the difference between a label and a
 * lie. The API's day buckets ARE UTC calendar days
 * (`AdminTimeseriesPointSchema.day` is `YYYY-MM-DD`), computed server-side by a
 * `strftime('%Y-%m-%d', created_at)` grouping. There is no client-side operation
 * that can turn UTC-day buckets into WIB-day buckets: re-bucketing needs the raw
 * rows, which the browser never has. So a toggle that *appeared* to rebucket
 * would be inventing data.
 *
 * What the toggle therefore does, and all it does:
 *
 *   1. re-renders **instants** — the window boundaries and `generated_at` — in
 *      the chosen zone, and
 *   2. changes the caption that names what a bucket is.
 *
 * The bucket keys never move. {@link utcDayKey} is the function that guarantees
 * it, and `format.spec.ts` pins it at the boundary that actually bites: 17:00Z
 * onward is already "tomorrow" in Jakarta.
 *
 * WIB (Asia/Jakarta) is a **fixed** UTC+7 with no DST — Indonesia abolished it in
 * 1964 — which is why a constant offset is correct here and an `Intl` timezone
 * lookup would be ceremony. Recorded because "hardcoded offset" is exactly the
 * kind of thing a reviewer should challenge, and this is the answer.
 */

/** Asia/Jakarta, UTC+7, no DST. */
export const WIB_OFFSET_MINUTES = 420;

/** The two zones the console speaks. Not a general timezone picker: UTC because
 *  it is what the data means, WIB because it is where the operator is. */
export type DisplayZone = 'UTC' | 'WIB';

/**
 * The UTC calendar day an instant belongs to, `YYYY-MM-DD`.
 *
 * **This is the bucket key, and it is UTC no matter what the display zone is.**
 * A page view at `2026-08-05T17:30:00Z` is `2026-08-06 00:30` in Jakarta, and it
 * still belongs to the `2026-08-05` bucket — because that is the bucket the API,
 * the digest, and every cron put it in. Presenting it as the 6th would make the
 * console disagree with the 05:00 email about the same row.
 */
export function utcDayKey(instant: string | Date): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Shift an instant into a display zone and return the wall-clock parts.
 *
 * Returns plain fields rather than a `Date` on purpose: a shifted `Date` is a
 * lie about its own `getTime()`, and someone will eventually compare two of them.
 * Nothing downstream should be able to mistake this for an instant.
 */
export function zonedParts(
  instant: string | Date,
  zone: DisplayZone,
): { year: number; month: number; day: number; hour: number; minute: number } | null {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const shifted = new Date(d.getTime() + (zone === 'WIB' ? WIB_OFFSET_MINUTES : 0) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * An instant as `YYYY-MM-DD HH:mm ZONE` — the window boundaries and
 * `generated_at`. The zone suffix is never optional (§9.5: "always labelled"): an
 * unlabelled timestamp on a screen that can show two zones is unreadable.
 */
export function formatInstant(instant: string | Date, zone: DisplayZone): string {
  const p = zonedParts(instant, zone);
  if (!p) return '';
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} ${zone}`;
}

/**
 * Split a `YYYY-MM-DD` bucket key into its parts, or null if it is not one.
 *
 * Takes the key, NOT an instant, precisely so it cannot be zone-shifted: there is
 * no zone parameter because a bucket has no zone to be shifted into. Month names
 * are `$localize`d by the caller in the axis component; this returns the numeric
 * pieces so the pure function stays free of `$localize` (which needs the Angular
 * runtime and would break the plain-Vitest runner).
 */
export function dayKeyParts(dayKey: string): { year: number; month: number; day: number } | null {
  const m = dayKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject a well-formed but non-existent date (2026-02-30): round-trip through
  // UTC and see whether the day survived.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/**
 * How many labels an axis can carry without collision, and which indices get one.
 *
 * Pure and count-based rather than measured: at 30 days a label every ~5 slots is
 * comfortable, at 90 every ~15. The first and last index are always included so
 * the axis states its own range. This is the "no DOM measurement" rule applied to
 * the one place charts usually reach for `getBBox()`.
 */
export function axisLabelIndices(count: number, maxLabels = 7): number[] {
  if (count <= 0) return [];
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const step = Math.ceil(count / maxLabels);
  const indices: number[] = [];
  for (let i = 0; i < count; i += step) indices.push(i);
  const last = count - 1;
  if (indices[indices.length - 1] !== last) {
    // Replace rather than append when the penultimate label would crowd the last
    // one — two labels a single slot apart is the collision this exists to avoid.
    if (last - indices[indices.length - 1]! < step / 2) indices.pop();
    indices.push(last);
  }
  return indices;
}

/**
 * Thousands-separated integer — `1,284`. The default for axis ticks and any
 * number a reader may need to compare precisely.
 *
 * Hardcodes en-US grouping rather than using `toLocaleString()`: the app is
 * en-US only at launch, and `toLocaleString` on the server picks up the Worker's
 * ICU default, which can differ from the browser's and would make the SSR HTML
 * and the hydrated DOM disagree — a hydration mismatch, not a formatting nit.
 */
export function formatThousands(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Compact figure for a stat tile — `1.3k`, `24.1k`, `2.4M`. Only for the hero
 * number, which is about magnitude; the exact figure is always available in the
 * chart's data table and in the tooltip, so nothing is lost to rounding.
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${trimZero(value / 1000)}k`;
  return `${trimZero(value / 1_000_000)}M`;
}

/** A share as a whole-number percent — `38%`. Zero total yields `0%` rather than
 *  `NaN%`, which is the empty-window case on every breakdown on the page. */
export function formatPercent(part: number, total: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

/**
 * A rate (a fraction in `[0, 1]`) as a percentage, or **`null` when there is no
 * rate to report**.
 *
 * **This is deliberately not `formatPercent`.** That one answers "what share of
 * this total is this part", and `0%` is the right answer for a slice of an empty
 * breakdown. A *rate* over an empty denominator is undefined, and `0% churn` on
 * an empty mailing list would be a clean bill of health nobody measured: §5.1's
 * "`null` renders as *Not measured*, never as zero" (AECI-586).
 *
 * Null propagates rather than becoming a placeholder here, because this module
 * is Angular-free by rule (§8.1) and so cannot own a localized string. The
 * caller supplies the words; this decides only whether there is a number.
 *
 * One decimal place, trimmed. At the volumes this reports on, one opt-out from
 * eight subscribers is 12.5%, and rounding that to 13% throws away the only
 * precision the number has.
 */
export function formatRate(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  const pct = rate * 100;
  const fixed = pct.toFixed(1);
  return `${fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed}%`;
}

function trimZero(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
