/**
 * `/admin/dmca`, the copyright notice log (AECI-1665, counsel Q38). Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.23, `docs/API_CONTRACTS.md` §6.10 "Copyright notices",
 * `docs/DATABASE_SCHEMA.md` §8.14.
 *
 *   GET   /api/admin/dmca-notices       every notice and counter-notice, filtered
 *   POST  /api/admin/dmca-notices       log one notice or counter-notice
 *   PATCH /api/admin/dmca-notices/:id   edit one
 *
 * All behind `requireAdmin()` in `index.ts`. The POST and the PATCH also carry
 * `rateLimit('write')` after the guard (`waf-rate-limits.md` §6.2). The GET is a read: no
 * audit row, no limiter. There is no delete route: the audit trail is the edit history.
 * The log is never public, so no write purges a cache.
 *
 * ─── The POST, in order ───────────────────────────────────────────────────────
 *
 *   1. The body (400 on a non-JSON body or a schema miss).
 *   2. The references: a counter-notice's `notice_id` names a notice, `account_id` names a
 *      profile and `vendor_id` names a vendor. Each miss is 400 `VALIDATION_FAILED` with
 *      `field` naming it, the precedent of an unknown taxonomy id.
 *   3. ONE `db.batch`: the insert and its `dmca_notice.created` audit row. The insert is an
 *      `INSERT … SELECT` guarded by {@link accountStillExists}, and the audit row lands only
 *      when the notice row did. Step 2's read is the friendly early answer. This guard is
 *      the one that counts: the account-deletion batch nulls `account_id` on existing rows,
 *      and an insert that lands after it must not bring a dead id back. The batch ends with
 *      {@link settleReads}, so the outcome is read inside the write's own transaction. No
 *      audit row there means the guard wrote nothing: 400 `VALIDATION_FAILED` on
 *      `account_id`. Then the forward.
 *
 * ─── The PATCH, in order ──────────────────────────────────────────────────────
 *
 *   1. The body (400). Then the row (404 `NOT_FOUND`).
 *   2. A field the row's kind does not carry is 400 `VALIDATION_FAILED`. So is a row the
 *      edit would leave `removed` or `disabled` with no `content_identified`. The references
 *      are checked as on the POST.
 *   3. A body that changes nothing is a 200 with `changed: false` and writes nothing.
 *   4. ONE `db.batch`: the race sentinel, the `dmca_notice.updated` audit row and the
 *      guarded UPDATE, the audit row and the UPDATE under one predicate. A stale
 *      `expected_updated_at` aborts the batch: 409 `DMCA_NOTICE_CHANGED`. When the edit sets
 *      `account_id`, the predicate also requires the profile to exist, as on the POST. The
 *      batch ends with {@link settleReads}, which tells the two apart inside the same
 *      transaction: the sentinel passed, so no audit row means the account guard matched
 *      nothing, which is 400 on `account_id`. A write that landed is a 200 and is forwarded,
 *      whatever commits after it.
 *
 * ─── What the audit row holds ─────────────────────────────────────────────────
 *
 * `audit_log` rows are kept four years (AECI-1638), so they must not hold the personal data
 * this table keeps for three years and nulls on account deletion. The states carry the dates, the action, the
 * outcome and the ids of the notice and vendor. Names, contact details, the material, the
 * work, the notes and the account id are listed in `metadata.fields` when they change, and
 * their values stay on the row.
 */

import {
  ApiErrorCode,
  CreateDmcaNoticeRequestSchema,
  CreateDmcaNoticeResponseSchema,
  DMCA_COUNTER_NOTICE_ONLY_FIELDS,
  DMCA_TAKEDOWN_NEEDS_CONTENT_MESSAGE,
  dmcaTakedownLacksContent,
  DmcaNoticesQuerySchema,
  DmcaNoticesResponseSchema,
  UpdateDmcaNoticeRequestSchema,
  UpdateDmcaNoticeResponseSchema,
  type CreateDmcaNoticeResponse,
  type DmcaAccountCounts,
  type DmcaNotice,
  type DmcaNoticesResponse,
  type UpdateDmcaNoticeRequest,
  type UpdateDmcaNoticeResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { auditLog, dmcaNotices, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsertWhere } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  accountCountStatements,
  compareDmcaNotices,
  DMCA_NOTICE_CREATED_ACTION,
  DMCA_NOTICE_ENTITY_TYPE,
  DMCA_NOTICE_UPDATED_ACTION,
  restoreClock,
  type DmcaNoticeRow,
} from '../lib/dmca-notices';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';

type DmcaContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

const AUDIT_SOURCE = 'admin-dmca-notices';
/** The sentinel's abort token. SQLite has no `RAISE()` outside triggers, so malformed JSON
 *  is the in-statement abort, as in `lib/notifications/switches.ts`. */
const RACE_TOKEN = 'dmca-notice-changed';

export interface AdminDmcaNoticesDeps {
  now?: () => Date;
}

/** The editable columns, request key to row key. */
const FIELDS = {
  received_at: 'receivedAt',
  submitter_name: 'submitterName',
  submitter_contact: 'submitterContact',
  content_identified: 'contentIdentified',
  work_claimed: 'workClaimed',
  account_id: 'accountId',
  vendor_id: 'vendorId',
  action: 'action',
  action_at: 'actionAt',
  forwarded_at: 'forwardedAt',
  court_action_at: 'courtActionAt',
  restore_outcome: 'restoreOutcome',
  restore_outcome_at: 'restoreOutcomeAt',
  closed_at: 'closedAt',
  notes: 'notes',
} as const satisfies Partial<Record<keyof UpdateDmcaNoticeRequest, keyof DmcaNoticeRow>>;
type Field = keyof typeof FIELDS;

/** Fields whose VALUES the audit row may hold. The rest are named only. */
const AUDITED_VALUES: ReadonlySet<string> = new Set([
  'kind',
  'notice_id',
  'received_at',
  'vendor_id',
  'action',
  'action_at',
  'forwarded_at',
  'court_action_at',
  'restore_outcome',
  'restore_outcome_at',
  'closed_at',
]);

type JoinedRow = DmcaNoticeRow & { accountName: string | null; vendorName: string | null };

function toDmcaNotice(row: JoinedRow, now: Date): DmcaNotice {
  return {
    id: row.id,
    kind: row.kind as DmcaNotice['kind'],
    notice_id: row.noticeId,
    received_at: row.receivedAt,
    submitter_name: row.submitterName,
    submitter_contact: row.submitterContact,
    content_identified: row.contentIdentified,
    work_claimed: row.workClaimed,
    account_id: row.accountId,
    account_name: row.accountName,
    vendor_id: row.vendorId,
    vendor_name: row.vendorName,
    action: row.action as DmcaNotice['action'],
    action_at: row.actionAt,
    forwarded_at: row.forwardedAt,
    court_action_at: row.courtActionAt,
    restore_outcome: row.restoreOutcome as DmcaNotice['restore_outcome'],
    restore_outcome_at: row.restoreOutcomeAt,
    closed_at: row.closedAt,
    notes: row.notes,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_by: row.updatedBy,
    updated_at: row.updatedAt,
    restore_clock: restoreClock(row, now),
  };
}

/** The rows with the account's display name and the vendor's company name. */
function selectJoined(db: Db, where?: SQL) {
  const q = db
    .select({
      row: dmcaNotices,
      accountName: profiles.displayName,
      vendorName: vendors.companyName,
    })
    .from(dmcaNotices)
    .leftJoin(profiles, eq(profiles.id, dmcaNotices.accountId))
    .leftJoin(vendors, eq(vendors.id, dmcaNotices.vendorId));
  return where ? q.where(where) : q;
}

const flatten = (r: {
  row: DmcaNoticeRow;
  accountName: string | null;
  vendorName: string | null;
}): JoinedRow => ({ ...r.row, accountName: r.accountName, vendorName: r.vendorName });

async function loadJoined(db: Db, id: string): Promise<JoinedRow | null> {
  const rows = await selectJoined(db, eq(dmcaNotices.id, id));
  return rows[0] ? flatten(rows[0]) : null;
}

/**
 * The two reads a write appends as the LAST statements of its own batch: the row, and this
 * write's audit row by its id. A D1 batch is one serialized transaction, so they see the
 * state just after the write, before any other write can commit. A read after the batch
 * could see a later edit or an account deletion and misjudge a write that landed.
 * Call it after {@link auditInsertWhere}, which assigns `entry.id`.
 */
function settleReads(db: Db, id: string, entry: AuditLogEntry) {
  return [
    selectJoined(db, eq(dmcaNotices.id, id)),
    db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.id, entry.id ?? '')),
  ] as const;
}

/** `GET /api/admin/dmca-notices`. */
export function createAdminDmcaNoticesHandler(
  dbFor: DbFactory = getDb,
  deps: AdminDmcaNoticesDeps = {},
): (c: DmcaContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const query = DmcaNoticesQuerySchema.parse(c.req.query());
    const { db } = dbFor(c.env);
    const now = clock();
    const where = and(
      query.account_id ? eq(dmcaNotices.accountId, query.account_id) : undefined,
      query.kind ? eq(dmcaNotices.kind, query.kind) : undefined,
      query.open === 'true' ? isNull(dmcaNotices.closedAt) : undefined,
    );
    let rows: Awaited<ReturnType<typeof selectJoined>>;
    let accountCounts: DmcaAccountCounts | null = null;
    if (query.account_id) {
      const [listed, takedowns, counters] = await db.batch([
        selectJoined(db, where),
        ...accountCountStatements(db, query.account_id),
      ]);
      rows = listed;
      accountCounts = {
        dmca_takedowns: takedowns[0]?.value ?? 0,
        dmca_counter_notices: counters[0]?.value ?? 0,
      };
    } else {
      rows = await selectJoined(db, where);
    }
    const body: DmcaNoticesResponse = {
      generated_at: now.toISOString(),
      notices: rows.map((r) => toDmcaNotice(flatten(r), now)).sort(compareDmcaNotices),
      account_counts: accountCounts,
    };
    validateResponseInDev(c.env, () => {
      DmcaNoticesResponseSchema.parse(body);
    });
    return json(body);
  };
}

async function readJson(c: DmcaContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
}

const unknownRef = (field: string, message: string) =>
  new ApiError(400, ApiErrorCode.VALIDATION_FAILED, message, { field });

const unknownAccount = () => unknownRef('account_id', 'account_id does not name an account.');

/**
 * The in-batch account guard: true when `accountId` is null or names a profile at commit
 * time. `checkReferences` is the early read. This is the check that counts, because there is
 * no FK and the account-deletion batch can commit between that read and the write.
 */
export function accountStillExists(accountId: string | null): SQL {
  return sql`(${accountId} IS NULL OR EXISTS (SELECT 1 FROM ${profiles} WHERE ${profiles.id} = ${accountId}))`;
}

/** Refuse a reference that names nothing. Only the fields the body set are checked. */
async function checkReferences(
  db: Db,
  refs: { notice_id?: string | null; account_id?: string | null; vendor_id?: string | null },
): Promise<void> {
  if (refs.notice_id) {
    const [n] = await db
      .select({ kind: dmcaNotices.kind })
      .from(dmcaNotices)
      .where(eq(dmcaNotices.id, refs.notice_id));
    if (n?.kind !== 'notice') {
      throw unknownRef('notice_id', 'notice_id does not name a logged notice.');
    }
  }
  if (refs.account_id) {
    const [p] = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.id, refs.account_id));
    if (!p) throw unknownAccount();
  }
  if (refs.vendor_id) {
    const [v] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(eq(vendors.id, refs.vendor_id));
    if (!v) throw unknownRef('vendor_id', 'vendor_id does not name a vendor.');
  }
}

/** The audit before/after for the changed fields, values only where they may be kept. */
function auditStates(
  changed: readonly string[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
) {
  const pick = (src: Record<string, unknown>) =>
    Object.fromEntries(
      changed.filter((f) => AUDITED_VALUES.has(f)).map((f) => [f, src[f] ?? null]),
    );
  return { beforeState: before ? pick(before) : null, afterState: pick(after) };
}

/** A row's editable values keyed by request field, for diffing and the audit row. */
function wireValues(row: DmcaNoticeRow): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: row.kind, notice_id: row.noticeId };
  for (const [field, col] of Object.entries(FIELDS)) out[field] = row[col];
  return out;
}

/**
 * The POST's insert as `INSERT … SELECT … WHERE accountStillExists(account_id)`, so an
 * account deleted after the early read writes no row. Every value is bound. Exported for
 * the spec.
 */
export function guardedInsert(db: Db, row: DmcaNoticeRow) {
  const v = (value: string | null) => sql`${value}`;
  return db.insert(dmcaNotices).select(
    db
      .select({
        id: v(row.id).as('id'),
        kind: v(row.kind).as('kind'),
        noticeId: v(row.noticeId).as('notice_id'),
        receivedAt: v(row.receivedAt).as('received_at'),
        submitterName: v(row.submitterName).as('submitter_name'),
        submitterContact: v(row.submitterContact).as('submitter_contact'),
        contentIdentified: v(row.contentIdentified).as('content_identified'),
        workClaimed: v(row.workClaimed).as('work_claimed'),
        accountId: v(row.accountId).as('account_id'),
        vendorId: v(row.vendorId).as('vendor_id'),
        action: v(row.action).as('action'),
        actionAt: v(row.actionAt).as('action_at'),
        forwardedAt: v(row.forwardedAt).as('forwarded_at'),
        courtActionAt: v(row.courtActionAt).as('court_action_at'),
        restoreOutcome: v(row.restoreOutcome).as('restore_outcome'),
        restoreOutcomeAt: v(row.restoreOutcomeAt).as('restore_outcome_at'),
        closedAt: v(row.closedAt).as('closed_at'),
        notes: v(row.notes).as('notes'),
        createdBy: v(row.createdBy).as('created_by'),
        createdAt: v(row.createdAt).as('created_at'),
        updatedBy: v(row.updatedBy).as('updated_by'),
        updatedAt: v(row.updatedAt).as('updated_at'),
      })
      .from(sql`(SELECT 1)`)
      .where(accountStillExists(row.accountId)),
  );
}

/** `POST /api/admin/dmca-notices`. */
export function createCreateDmcaNoticeHandler(
  dbFor: DbFactory = getDb,
  deps: AdminDmcaNoticesDeps = {},
): (c: DmcaContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const session = c.get('auth');
    const payload = CreateDmcaNoticeRequestSchema.parse(await readJson(c));
    const { db } = writeDb(c, dbFor);
    await checkReferences(db, payload);

    const now = clock();
    const nowIso = now.toISOString();
    const row: DmcaNoticeRow = {
      id: crypto.randomUUID(),
      kind: payload.kind,
      noticeId: payload.notice_id ?? null,
      receivedAt: payload.received_at,
      submitterName: payload.submitter_name ?? null,
      submitterContact: payload.submitter_contact ?? null,
      contentIdentified: payload.content_identified ?? null,
      workClaimed: payload.work_claimed ?? null,
      accountId: payload.account_id ?? null,
      vendorId: payload.vendor_id ?? null,
      action: payload.action ?? 'pending',
      actionAt: payload.action_at ?? null,
      forwardedAt: payload.forwarded_at ?? null,
      courtActionAt: payload.court_action_at ?? null,
      restoreOutcome: payload.restore_outcome ?? null,
      restoreOutcomeAt: payload.restore_outcome_at ?? null,
      closedAt: payload.closed_at ?? null,
      notes: payload.notes ?? null,
      createdBy: session.userId,
      createdAt: nowIso,
      updatedBy: session.userId,
      updatedAt: nowIso,
    };
    const values = wireValues(row);
    const set = Object.keys(values).filter((f) => values[f] != null);
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: DMCA_NOTICE_CREATED_ACTION,
      entityType: DMCA_NOTICE_ENTITY_TYPE,
      entityId: row.id,
      vendorId: row.vendorId,
      ...auditStates(set, null, values),
      metadata: { source: AUDIT_SOURCE, fields: set },
    };
    // The audit row lands only when the notice row did.
    const audit = auditInsertWhere(db, entry, {
      from: dmcaNotices,
      where: eq(dmcaNotices.id, row.id),
    });
    // D1 gives no reliable `meta.changes` on an INSERT … SELECT, so the batch reads its own
    // outcome as its last statements.
    const [, , rows, landed] = await db.batch([
      guardedInsert(db, row),
      audit,
      ...settleReads(db, row.id, entry),
    ]);
    const joined = rows[0] ? flatten(rows[0]) : null;
    if (!joined || landed.length === 0) throw unknownAccount();
    forwardAuditBatch(c, [entry], [], AUDIT_SOURCE);

    const body: CreateDmcaNoticeResponse = {
      notice: toDmcaNotice(joined, now),
    };
    validateResponseInDev(c.env, () => {
      CreateDmcaNoticeResponseSchema.parse(body);
    });
    return json(body, { status: 201 });
  };
}

/** True when a batch failed because the sentinel fired. */
export function isDmcaRaceError(error: unknown): boolean {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    parts.push(String((current as { message?: unknown }).message ?? current));
    current = (current as { cause?: unknown }).cause;
  }
  return /malformed JSON/i.test(parts.join(' | '));
}

/** The next `updated_at`: now, or one millisecond past the old value if now is not later,
 *  so the sentinel always sees a write. */
function nextStamp(now: Date, previous: string): string {
  const prev = Date.parse(previous);
  return Number.isNaN(prev) || now.getTime() > prev
    ? now.toISOString()
    : new Date(prev + 1).toISOString();
}

/** `PATCH /api/admin/dmca-notices/:id`. */
export function createUpdateDmcaNoticeHandler(
  dbFor: DbFactory = getDb,
  deps: AdminDmcaNoticesDeps = {},
): (c: DmcaContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const session = c.get('auth');
    const payload = UpdateDmcaNoticeRequestSchema.parse(await readJson(c));
    const id = c.req.param('id') ?? '';
    const { db } = writeDb(c, dbFor);

    // ── 1. The row ───────────────────────────────────────────────────────────
    const current = id ? await loadJoined(db, id) : null;
    if (!current) throw notFoundError('dmca_notice', { id });
    const changedError = () =>
      new ApiError(
        409,
        ApiErrorCode.DMCA_NOTICE_CHANGED,
        'This notice changed since the page loaded. Reload to see where it stands.',
      );
    // Stale already: say so even when the body would change nothing. The sentinel in the
    // batch catches a save that lands between this read and the write.
    if (current.updatedAt !== payload.expected_updated_at) throw changedError();

    // ── 2. Fields the kind carries, and references ───────────────────────────
    const banned: readonly string[] =
      current.kind === 'notice' ? DMCA_COUNTER_NOTICE_ONLY_FIELDS : ['work_claimed'];
    for (const field of banned) {
      if ((payload as Record<string, unknown>)[field] != null) {
        throw new ApiError(
          400,
          ApiErrorCode.VALIDATION_FAILED,
          `A ${current.kind === 'notice' ? 'notice' : 'counter-notice'} has no ${field}.`,
          { field },
        );
      }
    }

    // ── 3. The diff ──────────────────────────────────────────────────────────
    const before = wireValues(current);
    const set: Partial<DmcaNoticeRow> = {};
    const changed: Field[] = [];
    for (const field of Object.keys(FIELDS) as Field[]) {
      if (!(field in payload)) continue;
      const next = (payload as Record<string, unknown>)[field] ?? null;
      if (next === (before[field] ?? null)) continue;
      changed.push(field);
      (set as Record<string, unknown>)[FIELDS[field]] = next;
    }
    // The takedown rule, against the row as this edit would leave it. A no-op edit of a row
    // that already breaks it (written before the rule) is let through: it writes nothing.
    const merged = { ...before };
    for (const field of changed)
      merged[field] = (payload as Record<string, unknown>)[field] ?? null;
    if (
      changed.length > 0 &&
      dmcaTakedownLacksContent(merged as Parameters<typeof dmcaTakedownLacksContent>[0])
    ) {
      throw new ApiError(
        400,
        ApiErrorCode.VALIDATION_FAILED,
        `${DMCA_TAKEDOWN_NEEDS_CONTENT_MESSAGE}.`,
        {
          field: 'content_identified',
        },
      );
    }
    const now = clock();
    if (changed.length === 0) {
      const body: UpdateDmcaNoticeResponse = {
        notice: toDmcaNotice(current, now),
        changed: false,
      };
      validateResponseInDev(c.env, () => {
        UpdateDmcaNoticeResponseSchema.parse(body);
      });
      return json(body);
    }
    await checkReferences(db, {
      account_id: changed.includes('account_id') ? payload.account_id : null,
      vendor_id: changed.includes('vendor_id') ? payload.vendor_id : null,
    });

    // ── 4. ONE batch ─────────────────────────────────────────────────────────
    const stamp = nextStamp(now, current.updatedAt);
    const after = merged;
    const vendorId = (after.vendor_id as string | null) ?? null;
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: DMCA_NOTICE_UPDATED_ACTION,
      entityType: DMCA_NOTICE_ENTITY_TYPE,
      entityId: current.id,
      vendorId,
      ...auditStates(changed, before, after),
      metadata: { source: AUDIT_SOURCE, kind: current.kind, fields: changed },
    };
    const sentinel = db
      .select({
        guard: sql`CASE WHEN COALESCE((SELECT ${dmcaNotices.updatedAt} FROM ${dmcaNotices}
          WHERE ${dmcaNotices.id} = ${current.id}), '') <> ${payload.expected_updated_at}
          THEN json(${RACE_TOKEN}) END`,
      })
      .from(sql`(SELECT 1)`);
    // The audit row and the UPDATE share one predicate, so the audit row lands only with
    // the edit. It runs first, while the row still carries `expected_updated_at`.
    const setsAccount = changed.includes('account_id') && set.accountId != null;
    const guard = and(
      eq(dmcaNotices.id, current.id),
      eq(dmcaNotices.updatedAt, payload.expected_updated_at),
      setsAccount ? accountStillExists(set.accountId ?? null) : undefined,
    );
    const update = db
      .update(dmcaNotices)
      .set({ ...set, updatedBy: session.userId, updatedAt: stamp })
      .where(guard);
    const audit = auditInsertWhere(db, entry, { from: dmcaNotices, where: guard });
    let settled: Awaited<ReturnType<typeof settleReads>[0]>;
    let landed: Awaited<ReturnType<typeof settleReads>[1]>;
    try {
      // D1 gives no reliable `meta.changes` here, so the batch reads its own outcome as its
      // last statements. A read after the batch could see a later edit and call this one
      // stale even though it committed.
      [, , , settled, landed] = await db.batch([
        sentinel,
        audit,
        update,
        ...settleReads(db, current.id, entry),
      ]);
    } catch (error) {
      if (isDmcaRaceError(error)) throw changedError();
      throw error;
    }

    // The sentinel passed, so a write that did not land means the account guard matched
    // nothing. The 409 branch is defence in depth: the guard repeats the sentinel's check.
    const joined = settled[0] ? flatten(settled[0]) : null;
    if (!joined || landed.length === 0 || joined.updatedAt !== stamp) {
      if (setsAccount) throw unknownAccount();
      throw changedError();
    }
    forwardAuditBatch(c, [entry], [], AUDIT_SOURCE);

    const body: UpdateDmcaNoticeResponse = {
      notice: toDmcaNotice(joined, now),
      changed: true,
    };
    validateResponseInDev(c.env, () => {
      UpdateDmcaNoticeResponseSchema.parse(body);
    });
    return json(body);
  };
}
