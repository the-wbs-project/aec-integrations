/**
 * Business days: Monday to Friday, US federal holidays excluded, as observed (a Saturday
 * holiday moves to Friday, a Sunday one to Monday). Counsel's Q13 follow-up, 2026-11-05.
 *
 * Dates are the calendar dates of America/New_York, AECi's home time zone. The last day
 * of a window runs to the end of that date, and {@link businessWindowEnd} returns the
 * first moment that is safely past it in both EST and EDT. So a window can end up to an
 * hour late and never early.
 */

const DAY_MS = 86_400_000;

const dateKey = (d: Date): string => d.toISOString().slice(0, 10);

const nthWeekday = (year: number, month: number, weekday: number, n: number): Date => {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
};

const lastWeekday = (year: number, month: number, weekday: number): Date => {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month + 1, -offset));
};

const observed = (d: Date): Date => {
  const day = d.getUTCDay();
  if (day === 6) return new Date(d.getTime() - DAY_MS);
  if (day === 0) return new Date(d.getTime() + DAY_MS);
  return d;
};

const holidayCache = new Map<number, Set<string>>();

/** The observed federal holidays of one calendar year, keyed `YYYY-MM-DD`. */
function holidaysOf(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const fixed = (month: number, day: number) => observed(new Date(Date.UTC(year, month, day)));
  const set = new Set(
    [
      fixed(0, 1),
      nthWeekday(year, 0, 1, 3), // Martin Luther King Jr. Day
      nthWeekday(year, 1, 1, 3), // Washington's Birthday
      lastWeekday(year, 4, 1), // Memorial Day
      fixed(5, 19),
      fixed(6, 4),
      nthWeekday(year, 8, 1, 1), // Labor Day
      nthWeekday(year, 9, 1, 2), // Columbus Day
      fixed(10, 11),
      nthWeekday(year, 10, 4, 4), // Thanksgiving
      fixed(11, 25),
    ].map(dateKey),
  );
  holidayCache.set(year, set);
  return set;
}

/** Is this UTC-midnight date a business day? New Year's Day can be observed the year before. */
export function isBusinessDay(date: Date): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const key = dateKey(date);
  const year = date.getUTCFullYear();
  return !holidaysOf(year).has(key) && !holidaysOf(year + 1).has(key);
}

const NY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The New York calendar date of an instant, as a UTC-midnight `Date`. */
function newYorkDate(instant: Date): Date {
  return new Date(`${NY_DATE.format(instant)}T00:00:00.000Z`);
}

/**
 * The last day of a window of `days` business days opened at `start`. The start day
 * never counts, so a notice sent on a Monday has its day 1 on Tuesday.
 */
export function addBusinessDays(start: Date, days: number): Date {
  let cursor = newYorkDate(start);
  let left = days;
  while (left > 0) {
    cursor = new Date(cursor.getTime() + DAY_MS);
    if (isBusinessDay(cursor)) left--;
  }
  return cursor;
}

/** The moment a window of `days` business days from `startIso` has fully passed. */
export function businessWindowEnd(startIso: string, days: number): string {
  const lastDay = addBusinessDays(new Date(startIso), days);
  // 05:00 UTC the next day is midnight EST and 1 am EDT.
  return new Date(lastDay.getTime() + DAY_MS + 5 * 3_600_000).toISOString();
}
