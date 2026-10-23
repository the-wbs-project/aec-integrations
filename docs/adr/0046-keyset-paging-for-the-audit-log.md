# ADR 0046: Keyset paging for the global audit log

- Status: Accepted
- Date: 2026-10-23
- Issue: AECI-653 (follow-up to the global audit-log viewer)
- Relates to: ADR 0022 (audit logging); `docs/API_CONTRACTS.md` §3.1 and §6.10 `GET /api/admin/audit`; `docs/ADMIN_PANEL_SPEC.md` §5.18; `docs/DATABASE_SCHEMA.md` §8.4

## Context

`GET /api/admin/audit` is the unscoped read over `audit_log`, the ledger every domain-state write appends to. It shipped on `PageQuerySchema`: `page`, `perPage`, `LIMIT … OFFSET …`, and a `count()` on every request. That is the house convention for every list endpoint (§3.1).

Offset paging is wrong for this table. `audit_log` only grows, and it grows at the top: a new row is the newest row. An operator reading page 1, then page 2, sees the last row of page 1 again whenever a write lands in between, because every older row moved down one position. Under `order=asc` the effect is a skipped row instead. The 2026-10-23 usability audit flagged it. A ledger viewer that repeats or drops entries is a viewer an operator cannot trust.

Two smaller costs come with offset paging here. A deep `OFFSET` makes SQLite step over every earlier row, and D1 bills rows read. And the `count()` re-runs on every page, although the filtered set rarely changes between two clicks.

## Decision

1. **The global viewer pages by keyset cursor over `(created_at, id)`.** The request takes `after=<cursor>` or `before=<cursor>`, never both. The response carries `next_cursor` and `prev_cursor`. There is no `page`. The wire cursor is `"<created_at>|<id>"`, built and read by `encodeAuditCursor` / `decodeAuditCursor` in `packages/shared/src/api/admin-audit.ts`. Its two halves are bound as values, never spliced into SQL.

2. **The tiebreak flips with the primary key.** `order=desc` sorts `created_at DESC, id DESC`. `order=asc` sorts `created_at ASC, id ASC`. `resolveAdminUserOrderBy` (`apps/api/src/lib/sort.ts`) keeps its `id` tiebreak fixed when the primary flips. That is fine for offset paging. A keyset comparison needs the pair to be one total order, so here both columns move together. `created_at` alone is not unique: rows from one `db.batch` routinely share a millisecond.

3. **Cursors are relative to `order`.** `after` is the page that follows the cursor row in the current order. `before` is the page that precedes it. So `order=asc` needs no second grammar. A `before` page walks against `order` and the reader reverses the rows in memory.

4. **The predicate is a row-value comparison: `(created_at, id) < (?, ?)`**, or `>` when the walk runs ascending. We measured both forms with `EXPLAIN QUERY PLAN` on the migrated schema in the test harness, for every filter shape, in both orders:

   | Shape | Row value | Expanded `created_at < ? OR (created_at = ? AND id < ?)` |
   |---|---|---|
   | cursor alone | `SEARCH … audit_log_created_at_idx (created_at<?)` | `MULTI-INDEX OR`, two searches on `audit_log_created_at_idx` |
   | `action` + cursor | `SEARCH … audit_log_action_idx (action=? AND created_at<?)` | `SEARCH … audit_log_action_idx (action=?)`, no range |
   | `actor_id` + cursor | `SEARCH … audit_log_actor_idx (actor_id=? AND created_at<?)` | `SEARCH … audit_log_actor_idx (actor_id=?)`, no range |
   | entity + cursor | `SEARCH … audit_log_entity_idx (entity_type=? AND entity_id=? AND created_at<?)` | `SEARCH … audit_log_entity_idx (entity_type=? AND entity_id=?)`, no range |

   SQLite seeks the row value's leading term as a `created_at` range on whichever index the filters chose, and tests the full pair as a residual. The expanded form loses that range on every composite index. So the row value is used. D1 runs a SQLite well past 3.15, where row values arrived. The plan assertions live in `apps/api/src/routes/admin-audit.spec.ts` and fail on any `SCAN` of a filtered or cursored page.

5. **`perPage` is 25, 50 or 100.** The reader fetches `perPage + 1` rows and keeps the extra one only to set `has_next` (or `has_prev` on a `before` page). An `after` page always has `has_prev`, and a `before` page always has `has_next`, because the cursor row itself lies that way.

6. **`count` is a flag, and `total` is nullable.** `count=1` (the default) adds the `count()` of the filtered set to the batch. It ignores the cursor. `count=0` skips it and the response says `total: null`. A client that already holds the total for the current filters sends `count=0` on every later page. A cursored deep link has no total yet and sends `count=1`.

7. **The response is not `paginatedResponseSchema`.** That builder requires `page: number` and `total: number`. A keyset page has no page number, and `total` can be `null`. Bending the shared builder would weaken every other list's contract to fit one endpoint, so this endpoint declares its own envelope: `{ data, perPage, total, has_next, has_prev, next_cursor, prev_cursor, actor_emails_available }`.

8. **Every other list stays on `PageQuerySchema`.** That includes the claim and connector-catalogue audit trails, which share the same reader (`apps/api/src/lib/admin-audit-page.ts`) through its offset branch. They show one entity's history, which is short and rarely written while someone reads it. The reader takes a discriminated `paging` argument, so the scoped callers pass their parsed `{ page, perPage }` unchanged.

## Consequences

- A row written between two fetches no longer repeats or skips a row. A spec walks the ledger forward by `next_cursor`, back by `prev_cursor`, and with a write in between.
- Deep pages cost the same as the first page: the index seek starts at the cursor, not at row zero.
- There is no "jump to page N" and no page-number display. The paginator offers previous, next and first page. The result line reads the total when the client has one.
- The client keeps the last `total` across pages. It can go stale while the operator pages, by the rows written since the first fetch. That is accepted: the rows themselves are exact, and re-applying the filters re-counts.
- A cursor carries a row's timestamp and uuid in the URL. Neither is sensitive: both already appear on the page, and `actor_id` is never an email (`ADMIN_PANEL_SPEC.md` §13 D23).
- An empty page with a cursor means the cursor walked off the end. The response then has no cursors to follow, so the client offers the first page.
- A second keyset endpoint should copy this one's shape and cite this ADR. Promoting the envelope to a shared builder can wait until that second endpoint exists.
