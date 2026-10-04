/**
 * The repo's CSV writer (AECI-1194, first used by `GET /api/vendor/history.csv`).
 *
 * Two jobs, in this order:
 *
 * 1. **Formula-injection guard.** A spreadsheet treats a cell that begins with
 *    `=`, `+`, `-`, `@`, a tab or a carriage return as a formula. Such a cell gets
 *    a leading `'`, which every major spreadsheet reads as "this is text". The
 *    guard runs on the raw value, before quoting, so a quoted cell is guarded too.
 * 2. **RFC 4180 quoting.** A cell holding `"`, `,`, CR or LF is wrapped in double
 *    quotes, and each inner `"` is doubled. Rows end in CRLF.
 *
 * `null` and `undefined` become an empty cell. Numbers and booleans are written
 * with `String()`.
 */

export type CsvValue = string | number | boolean | null | undefined;

const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell, guarded and quoted. */
export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_LEAD.test(text)) text = `'${text}`;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A header row plus data rows, CRLF-terminated (RFC 4180 §2). */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  return [header, ...rows].map((row) => `${row.map(csvCell).join(',')}\r\n`).join('');
}
