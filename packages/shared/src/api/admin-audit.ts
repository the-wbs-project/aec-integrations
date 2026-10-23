import { z } from 'zod';

import { AdminAuditRowSchema } from './admin-vendors';
import { SortOrderSchema } from './common';
import { UtcCalendarDaySchema } from './vendor-history';

/**
 * `GET /api/admin/audit`: the global admin audit-log viewer (AECI-653,
 * `API_CONTRACTS.md` §6.10). The unscoped, filterable read over `audit_log`. The
 * vendor, claim and connector-catalogue trails are scoped reads of the same table
 * and share the same row shape (`AdminAuditRowSchema`).
 *
 * Every filter is optional and they AND together. Each filter is chosen so the
 * query can start from an index (`DATABASE_SCHEMA.md` §8.4):
 *
 * | Param           | Index it uses                              |
 * |-----------------|--------------------------------------------|
 * | none            | `audit_log_created_at_idx`, walked in `order` |
 * | `entity_type`   | `audit_log_entity_idx` (leading column)    |
 * | `entity_id`     | `audit_log_entity_idx` (second column)     |
 * | `action`        | `audit_log_action_idx`                     |
 * | `actor_id`      | `audit_log_actor_idx` (partial, `actor_id IS NOT NULL`) |
 * | `from`, `to`    | `audit_log_created_at_idx` range           |
 * | `actor_type`    | none: a residual filter only               |
 * | `after` alone   | `audit_log_created_at_idx` range, bounded by the cursor's `created_at` |
 * | `before` alone  | `audit_log_created_at_idx` range, bounded by the cursor's `created_at` |
 * | cursor + filter | the filter's index; the cursor narrows its `created_at` column when the index has one next |
 * | `order`         | no index change: the same range walked the other way |
 *
 * ─── Paging: keyset cursors (ADR 0046) ─────────────────────────────────────
 *
 * This endpoint does not take `page`. Offset paging over an append-only ledger
 * drifts: a row written between two fetches pushes every older row down one,
 * so page 2 repeats the last row of page 1. The page is a keyset walk over
 * `(created_at, id)` instead, and the response hands back opaque cursors.
 *
 * - **Cursor grammar.** `"<created_at>|<id>"`: the row's ISO timestamp, a pipe,
 *   and its uuid. Build and read it with `encodeAuditCursor` /
 *   `decodeAuditCursor`. The server reads it as two bound values, never as SQL.
 * - **`after`** returns the page that follows that row in the current `order`.
 *   **`before`** returns the page that precedes it. Both are relative to
 *   `order`, so `order=asc` needs no second grammar. Sending both is a 400.
 * - **`order`** (`desc` default) sorts on `created_at` and then `id`, both in
 *   the same direction. The tiebreak flips with the primary key, because a
 *   keyset comparison needs one total order.
 * - **`perPage`** is 25, 50 or 100. Any other value is a 400.
 * - **`count`** is `1` by default. `0` skips the `count()` and returns
 *   `total: null`. A client that already holds the total for these filters
 *   sends `0` on every later page, so paging does not re-count the set.
 * - `has_next` / `has_prev` say whether rows exist past either end of the page.
 *   `next_cursor` / `prev_cursor` are the last and first row shown, or `null`
 *   when the matching flag is false or the page is empty. An empty page with a
 *   cursor means the cursor walked off the end: start again from the first page.
 *
 * A UI date preset (`range`) is resolved to `from` / `to` in the browser. This
 * endpoint never sees it, so the table above stays the whole story.
 *
 * **`entity_id` needs `entity_type`.** `audit_log_entity_idx` leads with
 * `entity_type`, so an `entity_id` on its own cannot seek the index and reads
 * the whole table. A 400 is the honest answer.
 *
 * **`actor_type` cannot stand alone.** No index leads with it. The page itself
 * stays cheap because it walks `audit_log_created_at_idx` in `order` and stops at
 * `perPage` rows. The `count()` behind `total` is the problem: it has to read
 * every row to test `actor_type`, and D1 bills rows read. Next to any other
 * filter, or a date range, it is a residual test on an indexed range. So it is
 * rejected only when it is the ONLY constraint.
 *
 * **`entity_type` and `action` are free strings, never enums.** `audit_log`
 * carries no CHECK on either by design, and a writer elsewhere adds new values
 * without touching this file. An enum here would turn a new writer into a 400.
 * `action` is an exact match: no prefix and no LIKE, so it stays an index seek.
 *
 * **`actor_id` is a uuid, never an email** (`ADMIN_PANEL_SPEC.md` §13 D23 keeps
 * addresses out of URLs).
 *
 * `from` / `to` are inclusive UTC days on `created_at`. `from` after `to` is a 400.
 *
 * **An empty value is an absent value.** A filter form submits `?action=` for a
 * blank field, so a blank or whitespace-only value is dropped before parsing.
 */

/** The `audit_log.actor_type` values, matching `audit_log_actor_type_check`. */
export const AUDIT_ACTOR_TYPES = ['user', 'admin', 'system', 'workflow'] as const;
export const AuditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

/** Drop blank query values so `?action=` reads as "no action filter". */
const dropBlankValues = (input: unknown): unknown => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => !(typeof v === 'string' && v.trim() === '')),
  );
};

/** The page sizes the viewer offers. Any other `perPage` is a 400. */
export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
export type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number];
export const AUDIT_DEFAULT_PAGE_SIZE: AuditPageSize = 25;

/** A decoded keyset cursor: the `(created_at, id)` of one `audit_log` row. */
export interface AuditCursor {
  createdAt: string;
  id: string;
}

const AUDIT_CURSOR_SEPARATOR = '|';
const CURSOR_ID_SCHEMA = z.string().uuid();
/** Longer than any ISO timestamp, short enough that a junk value is refused. */
const CURSOR_CREATED_AT_MAX = 40;

/** Encode a row's position as the wire cursor `"<created_at>|<id>"`. */
export function encodeAuditCursor(cursor: AuditCursor): string {
  return `${cursor.createdAt}${AUDIT_CURSOR_SEPARATOR}${cursor.id}`;
}

/**
 * Decode a wire cursor, or `null` when it is malformed. Splits on the LAST pipe,
 * so the id is always the uuid at the end. `createdAt` must be non-empty and
 * short. It is not parsed as a date: it is only ever a bound comparison value.
 */
export function decodeAuditCursor(raw: string): AuditCursor | null {
  const at = raw.lastIndexOf(AUDIT_CURSOR_SEPARATOR);
  if (at <= 0) return null;
  const createdAt = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (createdAt.trim() === '' || createdAt.length > CURSOR_CREATED_AT_MAX) return null;
  if (!CURSOR_ID_SCHEMA.safeParse(id).success) return null;
  return { createdAt, id };
}

/** A wire cursor, parsed into `{ createdAt, id }`. */
export const AuditCursorSchema = z.string().transform((raw, ctx): AuditCursor => {
  const cursor = decodeAuditCursor(raw);
  if (cursor === null) {
    ctx.addIssue({ code: 'custom', message: 'Expected a cursor of the form `<created_at>|<id>`' });
    return z.NEVER;
  }
  return cursor;
});

const AdminAuditLogFiltersObject = z
  .object({
    perPage: z.coerce
      .number()
      .int()
      .refine((v) => (AUDIT_PAGE_SIZES as readonly number[]).includes(v), {
        message: '`perPage` must be 25, 50 or 100',
      })
      .default(AUDIT_DEFAULT_PAGE_SIZE),
    order: SortOrderSchema.default('desc'),
    /** The page after this row, in `order`. */
    after: AuditCursorSchema.optional(),
    /** The page before this row, in `order`. */
    before: AuditCursorSchema.optional(),
    /** `0` skips the `count()`; the response then carries `total: null`. */
    count: z.coerce.number().int().min(0).max(1).default(1),
    entity_type: z.string().trim().min(1).max(64).optional(),
    entity_id: z.string().trim().min(1).max(128).optional(),
    action: z.string().trim().min(1).max(128).optional(),
    actor_id: z.string().trim().uuid().optional(),
    actor_type: AuditActorTypeSchema.optional(),
    /** Inclusive UTC day, on `created_at`. */
    from: UtcCalendarDaySchema.optional(),
    /** Inclusive UTC day, on `created_at`. */
    to: UtcCalendarDaySchema.optional(),
  })
  .superRefine((q, ctx) => {
    if (q.entity_id !== undefined && q.entity_type === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['entity_id'],
        message: '`entity_id` needs `entity_type`',
      });
    }
    const hasIndexedConstraint =
      q.entity_type !== undefined ||
      q.action !== undefined ||
      q.actor_id !== undefined ||
      q.from !== undefined ||
      q.to !== undefined;
    if (q.actor_type !== undefined && !hasIndexedConstraint) {
      ctx.addIssue({
        code: 'custom',
        path: ['actor_type'],
        message: '`actor_type` needs another filter or a date range',
      });
    }
    if (q.after !== undefined && q.before !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['before'],
        message: 'Send `after` or `before`, not both',
      });
    }
    if (q.from !== undefined && q.to !== undefined && q.from > q.to) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: '`from` must not be after `to`',
      });
    }
  });

/** `GET /api/admin/audit` query: the cursor paging params plus the filters above. */
export const AdminAuditLogQuerySchema = z.preprocess(dropBlankValues, AdminAuditLogFiltersObject);
export type AdminAuditLogQuery = z.infer<typeof AdminAuditLogQuerySchema>;

/**
 * The `GET /api/admin/audit` envelope. Not `paginatedResponseSchema`: a keyset
 * page has no page number, and `total` is `null` when the caller sent `count=0`
 * (ADR 0046). `actor_emails_available` is the same GoTrue availability flag the
 * scoped trails carry: `false` means the email lookup failed, so a `null` email
 * reads "unavailable", not "no email". No `metadata` on the row in v1, matching
 * the scoped trails.
 */
export const AdminAuditLogResponseSchema = z.object({
  data: z.array(AdminAuditRowSchema),
  perPage: z.number().int().min(1).max(100),
  /** Rows matching the filters, ignoring the cursor. `null` only under `count=0`. */
  total: z.number().int().min(0).nullable(),
  has_next: z.boolean(),
  has_prev: z.boolean(),
  /** Send as `after` for the next page. `null` when `has_next` is false. */
  next_cursor: z.string().nullable(),
  /** Send as `before` for the previous page. `null` when `has_prev` is false. */
  prev_cursor: z.string().nullable(),
  actor_emails_available: z.boolean(),
});
export type AdminAuditLogResponse = z.infer<typeof AdminAuditLogResponseSchema>;
