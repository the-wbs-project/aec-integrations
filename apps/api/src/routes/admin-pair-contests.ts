/**
 * AECi's queue of Sync Service pair reports (AECI-2042, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11e, `ADMIN_PANEL_SPEC.md` §5.12). Shown on `/admin/contests` beside the field
 * contests.
 *
 *   GET   /api/admin/pair-contests?status=&protests=&retractions=  — the queue (default: open reports)
 *   PATCH /api/admin/pair-contests/:id                — accept or decline an AECi-routed report
 *   PATCH /api/admin/pair-contests/:id/protest        — uphold or reject a protest (advice only)
 *
 * `requireAdmin()` → `rateLimit('write')` on the two writes.
 *
 * An existence accept needs a note and a proof link (ruling 9: AECi retires on proof).
 * It acts on the whole pair key (AECI-2170, ruled 2026-11-25): the connector and the
 * two endpoints, either order, in both `integrations` and `connector_evidenced_pairs`.
 * Every live vendor-held row on the key, whoever owns it, is retired through the admin
 * retire batch (`planAdminRetire`) with the note as the reason, in ONE batch with the
 * report's decision. A live AECi-held row is not written: promote owns it (§4.6.4), so
 * it is listed for retraction in the review app within five business days
 * (`?retractions=true`, `docs/runbooks/catalog.md`). `pairKeyUnchangedSentinel` holds
 * the rows read at commit, so a row that joins the key, leaves it, or changes owner or
 * class between the read and the batch answers `409 PAIR_CONTEST_CHANGED` with nothing
 * written. The decision's audit row records `retiredRowIds`, `upstreamRowIds` and
 * `alreadyRetiredRowIds`. A data flow accept on an unclaimed pair writes nothing here:
 * the review app holds those flows.
 *
 * The admin wire (`AdminPairContestSchema`) adds `key_rows` and `retract_by` to the
 * vendor shape. Vendor reads keep `PairContestSchema`, so no vendor learns who owns
 * another row on the key.
 */

import {
  AdminDecidePairContestSchema,
  AdminDecidePairProtestSchema,
  AdminPairContestResponseSchema,
  AdminPairContestsResponseSchema,
  ApiErrorCode,
  ListAdminPairContestsQuerySchema,
  type AdminPairContest,
  type AdminPairContestResponse,
  type AdminPairContestsResponse,
  type PairKeyRowWire,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { syncServicePairContests, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { businessWindowEnd } from '../lib/business-days';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isVendorHeld } from '../lib/integration-claims';
import { isRetireRaceError } from '../lib/integration-retire';
import { locateRetireTarget, retireTargetOf, type LocatedRetireRow } from '../lib/retire-target';
import {
  isPairContestRaceError,
  pairContestChangedSentinel,
  PAIR_CONTEST_ENTITY_TYPE,
  pairContestWireRows,
  pairKeyUnchangedSentinel,
  pairWorkflowStepStmts,
  type PairContestRow,
} from '../lib/sync-service-pair-contests';
import {
  pairKeyOfLocated,
  pairKeyString,
  pairRightNotificationAudit,
  rowsOnPairKey,
  rowsOnPairKeys,
  type PairKey,
  type PairKeyRow,
} from '../lib/sync-service-pair-rights';
import {
  adminRetireRefusal,
  afterAdminRetireMany,
  planAdminRetire,
  type AdminRetirePlan,
} from './admin-integration-retire';
import { afterVendorWrite, parseJsonBody, type VendorContext } from './vendor-shared';

export const ADMIN_PAIR_CONTEST_SOURCE = 'admin-moderation';
const ADMIN_ORIGIN = { auditSource: ADMIN_PAIR_CONTEST_SOURCE, purgeSource: 'moderation' } as const;

/** The business days AECi has to retract an AECi-held row after an accept. The Listing
 *  Accuracy Policy's "within five business days". */
export const RETRACT_WITHIN_BUSINESS_DAYS = 5;

/** How many accepted existence reports `?retractions=true` scans. */
const RETRACTION_SCAN_LIMIT = 200;

/** A row AECi holds and the site still shows: what the review app must retract. */
function isUpstreamLive(row: PairKeyRow): boolean {
  return row.retiredAt === null && !isVendorHeld(row);
}

/**
 * Admin wire rows (AECI-2170): the vendor shape plus every row on each existence
 * report's pair key and, on an accepted one with an AECi-held row still live, the
 * retract-by instant. Reads: the vendor shape's, then two for every key's rows and one
 * for their owners' names, never one per report.
 */
export async function adminPairContestWireRows(
  db: Db,
  rows: readonly PairContestRow[],
): Promise<AdminPairContest[]> {
  const wire = await pairContestWireRows(db, rows);
  const keyOf = (w: (typeof wire)[number]): PairKey | null => {
    const { connector, product_a, product_b } = w.pair;
    return w.kind === 'existence' && connector && product_a && product_b
      ? { connectorProductId: connector.id, productAId: product_a.id, productBId: product_b.id }
      : null;
  };
  const keys = wire.map(keyOf);
  const byKey = await rowsOnPairKeys(
    db,
    keys.filter((k): k is PairKey => k !== null),
  );
  const ownerIds = [
    ...new Set(
      [...byKey.values()].flat().flatMap((r) => (r.builtByVendorId ? [r.builtByVendorId] : [])),
    ),
  ];
  const owners = ownerIds.length
    ? await db
        .select({ id: vendors.id, name: vendors.companyName })
        .from(vendors)
        .where(sql`${vendors.id} IN (SELECT value FROM json_each(${JSON.stringify(ownerIds)}))`)
    : [];
  const ownerName = new Map(owners.map((o) => [o.id, o.name]));
  return wire.map((w, n) => {
    const key = keys[n];
    const keyRows = key ? (byKey.get(pairKeyString(key)) ?? []) : null;
    const row = rows[n]!;
    const retractBy =
      keyRows && row.status === 'accepted' && row.decidedAt && keyRows.some(isUpstreamLive)
        ? businessWindowEnd(row.decidedAt, RETRACT_WITHIN_BUSINESS_DAYS)
        : null;
    return {
      ...w,
      key_rows: keyRows
        ? keyRows.map(
            (r): PairKeyRowWire => ({
              id: r.id,
              anchor: r.anchor,
              name: r.name,
              owner_vendor_id: r.builtByVendorId,
              owner_name: r.builtByVendorId ? (ownerName.get(r.builtByVendorId) ?? null) : null,
              held: isVendorHeld(r) ? 'vendor' : 'aeci',
              retired: r.retiredAt !== null,
            }),
          )
        : null,
      retract_by: retractBy,
    };
  });
}

/**
 * `GET /api/admin/pair-contests`. Oldest open first, so the queue reads in filing order.
 *
 * `?retractions=true` (AECI-2170): the accepted existence reports whose pair key still
 * has a live AECi-held row, one per key, earliest deadline first. Computed in memory
 * over the newest {@link RETRACTION_SCAN_LIMIT} accepted existence reports. A key drops
 * off once promote retracts its AECi-held rows.
 */
export function createAdminListPairContestsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const query = ListAdminPairContestsQuerySchema.parse(c.req.query());
    const { db } = dbFor(c.env);
    const t = syncServicePairContests;
    let data: AdminPairContest[];
    if (query.retractions) {
      // Timestamp then id: both BINARY orderings.
      const rows = await db
        .select()
        .from(t)
        .where(and(eq(t.status, 'accepted'), eq(t.kind, 'existence')))
        .orderBy(desc(t.decidedAt), desc(t.id))
        .limit(RETRACTION_SCAN_LIMIT);
      const seen = new Set<string>();
      data = (await adminPairContestWireRows(db, rows))
        .filter((r) => r.retract_by !== null)
        // ISO instants, then id: BINARY.
        .sort((a, b) =>
          a.retract_by! < b.retract_by!
            ? -1
            : a.retract_by! > b.retract_by!
              ? 1
              : a.id < b.id
                ? -1
                : a.id > b.id
                  ? 1
                  : 0,
        )
        .filter((r) => {
          const key = `${r.pair.connector?.id}|${r.pair.product_a?.id}|${r.pair.product_b?.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } else {
      // Timestamp then id: both BINARY orderings.
      const rows = await db
        .select()
        .from(t)
        .where(query.protests ? eq(t.protestStatus, 'open') : eq(t.status, query.status))
        .orderBy(
          query.status === 'open' && !query.protests ? asc(t.createdAt) : desc(t.updatedAt),
          t.id,
        )
        .limit(200);
      data = await adminPairContestWireRows(db, rows);
    }
    const body: AdminPairContestsResponse = { data };
    validateResponseInDev(c.env, () => AdminPairContestsResponseSchema.parse(body));
    return json(body);
  };
}

/** The admin answer of a decision: the report after the write, admin shape. */
async function adminContestBody(db: Db, id: string): Promise<AdminPairContestResponse> {
  const row = await loadRow(db, id);
  const [contest] = await adminPairContestWireRows(db, [row]);
  return { contest: contest! };
}

async function loadRow(db: Db, id: string): Promise<PairContestRow> {
  const row = await db.query.syncServicePairContests.findFirst({
    where: eq(syncServicePairContests.id, id),
  });
  if (!row) throw notFoundError('pair_contest', { id });
  return row;
}

function notOpenError(): ApiError {
  return new ApiError(409, ApiErrorCode.PAIR_CONTEST_NOT_OPEN, 'Already decided or withdrawn.');
}

/** The submitter's notice of AECi's decision. */
function decisionNotice(
  c: VendorContext,
  row: PairContestRow,
  wire: Awaited<ReturnType<typeof pairContestWireRows>>[number] | undefined,
  event: 'report_accepted' | 'report_declined' | 'protest_decided',
  vendorId: string,
  reason: string | null,
): AuditLogEntry {
  const session = c.get('auth');
  const a = wire?.pair.product_a?.slug;
  const b = wire?.pair.product_b?.slug;
  return pairRightNotificationAudit(
    'portal-sync-service-pair-report',
    { actorId: session.userId, actorType: auditActorType(session) },
    row.integrationId ? 'integration' : 'evidenced_pair',
    {
      event,
      vendorId,
      integrationId: row.integrationId ?? row.evidencedPairId!,
      integrationName: wire?.pair.name ?? null,
      reportKind: row.kind as 'existence' | 'data_flow',
      byVendorName: null,
      reason,
      pairPublic: null,
      pairSlugs: a && b ? [a, b] : null,
    },
  );
}

/** `PATCH /api/admin/pair-contests/:id`. */
export function createAdminDecidePairContestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const payload = await parseJsonBody(c, AdminDecidePairContestSchema);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, id);
    if (row.routedTo !== 'aeci') {
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_ROUTED_TO_OWNER,
        'The owner decides this report. AEC Integrations does not.',
      );
    }
    if (row.status !== 'open') throw notOpenError();
    const accepted = payload.decision === 'accept';
    const note = payload.note?.trim() || null;
    if (accepted && !note) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'A note is required to accept a report.', {
        field: 'note',
      });
    }
    if (accepted && row.kind === 'existence' && !payload.source_url) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'A link to the proof is required to accept an existence report.',
        { field: 'sourceUrl' },
      );
    }

    const now = new Date().toISOString();
    const anchorId = row.integrationId ?? row.evidencedPairId!;
    const existenceAccept = accepted && row.kind === 'existence';
    // AECI-2170: an existence accept acts on every row on the pair key.
    const keyRead = existenceAccept ? await readPairKey(db, anchorId) : null;
    const mode: string | null = !accepted
      ? null
      : row.kind === 'data_flow' || !keyRead || keyRead.rows.length === 0
        ? 'upstream-only'
        : keyRead.retire.length > 0
          ? 'retired'
          : keyRead.upstream.length > 0
            ? 'upstream-only'
            : 'already-retired';

    const [wire] = await pairContestWireRows(db, [row]);
    const audits: AuditLogEntry[] = [
      {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: accepted
          ? 'integration.pair_contest.accepted'
          : 'integration.pair_contest.declined',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        // AECI-1192: the row is about the vendor that filed the report.
        vendorId: row.submitterVendorId,
        beforeState: { status: 'open' },
        afterState: { status: accepted ? 'accepted' : 'declined', accept_mode: mode },
        metadata: {
          source: ADMIN_PAIR_CONTEST_SOURCE,
          ...(note ? { reason: note, reasonVisibility: 'vendor' } : {}),
          ...(payload.source_url ? { sourceUrl: payload.source_url } : {}),
          ...(mode ? { appliedMode: mode } : {}),
          // AECI-2170: the permanent record of what the accept did on the key, and what
          // it left to retract. The report row cascades away with its anchor; this
          // does not.
          ...(keyRead
            ? {
                retiredRowIds: keyRead.retire.map((r) => r.id),
                upstreamRowIds: keyRead.upstream.map((r) => r.id),
                alreadyRetiredRowIds: keyRead.alreadyRetired.map((r) => r.id),
              }
            : {}),
        },
      },
      decisionNotice(
        c,
        row,
        wire,
        accepted ? 'report_accepted' : 'report_declined',
        row.submitterVendorId,
        note,
      ),
    ];
    const decide: BatchStmt[] = [
      db
        .update(syncServicePairContests)
        .set({
          status: accepted ? 'accepted' : 'declined',
          decisionNote: note,
          decidedBy: session.userId,
          decidedAt: now,
          acceptMode: mode,
          updatedAt: now,
        })
        .where(
          and(
            eq(syncServicePairContests.id, row.id),
            eq(syncServicePairContests.status, 'open'),
            eq(syncServicePairContests.routedTo, 'aeci'),
          ),
        ),
      pairContestChangedSentinel(db),
      // AECI-2110: the report's workflow, closed in the decision's batch.
      ...pairWorkflowStepStmts(
        db,
        row,
        { which: 'report', toState: accepted ? 'accepted' : 'declined' },
        {
          actorId: session.userId,
          reason: `${accepted ? 'accepted' : 'declined'} by AEC Integrations`,
          ...(mode ? { metadata: { appliedMode: mode } } : {}),
        },
        now,
      ),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];

    if (keyRead && (keyRead.key || keyRead.retire.length > 0)) {
      // Ruling 9: retire on proof, through the admin retire, in one batch. AECI-2170:
      // one plan per vendor-held live row on the key. The endpoint vendors hear once,
      // on the first plan; every owner hears on its own row, with the reason.
      const plans: { plan: AdminRetirePlan; id: string }[] = [];
      for (const [n, located] of keyRead.retire.entries()) {
        const plan = await planAdminRetire(c, db, located.located, 'retire', {
          reason: note!,
          internalNote: `Existence report ${row.id} accepted. Proof: ${payload.source_url}`,
          notifyEndpointVendors: n === 0,
          existenceReportId: row.id,
        });
        plans.push({ plan, id: located.id });
      }
      const stmts: BatchStmt[] = [
        ...decide,
        // Ahead of the plans: the key as the accept read it, held at commit.
        ...(keyRead.key ? [pairKeyUnchangedSentinel(db, keyRead.key, keyRead.rows)] : []),
        // Each plan's statements stay contiguous, so its race sentinel reads its UPDATE.
        ...plans.flatMap((p) => p.plan.batch.stmts),
      ];
      try {
        await db.batch(stmts as BatchTuple);
      } catch (error) {
        if (isPairContestRaceError(error) || isRetireRaceError(error)) {
          throw await raceError(db, row.id);
        }
        throw error;
      }
      if (plans.length > 0) afterAdminRetireMany(c, db, plans, 'retire', audits);
      else afterVendorWrite(c, [], audits, undefined, db, ADMIN_ORIGIN);
    } else {
      try {
        await db.batch(decide as BatchTuple);
      } catch (error) {
        if (!isPairContestRaceError(error)) throw error;
        throw notOpenError();
      }
      afterVendorWrite(c, [], audits, undefined, db, ADMIN_ORIGIN);
    }
    const body = await adminContestBody(db, row.id);
    validateResponseInDev(c.env, () => AdminPairContestResponseSchema.parse(body));
    return json(body);
  };
}

/** The 409 a lost race answers: the report was decided meanwhile, or the key changed. */
async function raceError(db: Db, id: string): Promise<ApiError> {
  const current = await loadRow(db, id);
  return current.status !== 'open'
    ? notOpenError()
    : new ApiError(
        409,
        ApiErrorCode.PAIR_CONTEST_CHANGED,
        'The integration changed while you were deciding. Reload and try again.',
      );
}

/** A row on the key the accept retires, located in full for the retire plan. */
interface KeyRetireRow {
  readonly id: string;
  readonly located: LocatedRetireRow;
}

/**
 * The rows on the report's pair key, sorted into what an existence accept does with
 * each (AECI-2170): `retire` (vendor-held and live, located in full for the plan),
 * `upstream` (AECi-held and live: left for the review app) and `alreadyRetired`. `key`
 * is `null` only for an `integrations` row no connector delivers; then the anchor
 * alone is read, as before the key existed. A row whose admin retire would be refused
 * once located answers `409 PAIR_CONTEST_CHANGED`: it changed between the two reads.
 */
async function readPairKey(
  db: Db,
  anchorId: string,
): Promise<{
  key: PairKey | null;
  rows: PairKeyRow[];
  retire: KeyRetireRow[];
  upstream: PairKeyRow[];
  alreadyRetired: PairKeyRow[];
}> {
  const anchor = await locateRetireTarget(db, anchorId);
  if (!anchor) return { key: null, rows: [], retire: [], upstream: [], alreadyRetired: [] };
  const key = pairKeyOfLocated(anchor);
  const anchorTarget = retireTargetOf(anchor);
  const rows: PairKeyRow[] = key
    ? await rowsOnPairKey(db, key)
    : [
        {
          anchor: anchorTarget.anchor,
          id: anchorTarget.id,
          name: anchor.anchor === 'integration' ? anchor.row.name : anchor.pair.name,
          builtByVendorId: anchorTarget.builtByVendorId,
          claimedAt: anchorTarget.claimedAt,
          origin: anchorTarget.origin,
          retiredAt: anchorTarget.retiredAt,
        },
      ];
  const retire: KeyRetireRow[] = [];
  for (const r of rows) {
    if (r.retiredAt !== null || !isVendorHeld(r)) continue;
    // Ids are minted per table, so the id names one row in one table.
    const located = r.id === anchorId ? anchor : await locateRetireTarget(db, r.id);
    if (
      !located ||
      located.anchor !== r.anchor ||
      adminRetireRefusal(retireTargetOf(located), 'retire')
    ) {
      throw new ApiError(
        409,
        ApiErrorCode.PAIR_CONTEST_CHANGED,
        'The integration changed while you were deciding. Reload and try again.',
      );
    }
    retire.push({ id: r.id, located });
  }
  return {
    key,
    rows,
    retire,
    upstream: rows.filter(isUpstreamLive),
    alreadyRetired: rows.filter((r) => r.retiredAt !== null),
  };
}

/**
 * `PATCH /api/admin/pair-contests/:id/protest`. Advice only (§11b.12.1, ruling 10): it
 * tells both vendors which side AECi agrees with, and writes nothing to the listing.
 */
export function createAdminDecidePairProtestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const payload = await parseJsonBody(c, AdminDecidePairProtestSchema);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, id);
    if (row.protestStatus !== 'open') {
      throw new ApiError(409, ApiErrorCode.PAIR_PROTEST_NOT_OPEN, 'This review is no longer open.');
    }
    const now = new Date().toISOString();
    const [wire] = await pairContestWireRows(db, [row]);
    const upheld = payload.decision === 'upheld';
    const audits: AuditLogEntry[] = [
      {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: upheld
          ? 'integration.pair_contest.protest_upheld'
          : 'integration.pair_contest.protest_rejected',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        vendorId: row.submitterVendorId,
        beforeState: { protest_status: 'open' },
        afterState: { protest_status: payload.decision },
        metadata: {
          source: ADMIN_PAIR_CONTEST_SOURCE,
          reason: payload.note,
          reasonVisibility: 'vendor',
          advisory: true,
        },
      },
      decisionNotice(c, row, wire, 'protest_decided', row.submitterVendorId, payload.note),
      ...(row.ownerVendorId
        ? [decisionNotice(c, row, wire, 'protest_decided', row.ownerVendorId, payload.note)]
        : []),
    ];
    try {
      await db.batch([
        db
          .update(syncServicePairContests)
          .set({
            protestStatus: payload.decision,
            protestDecisionNote: payload.note,
            protestDecidedBy: session.userId,
            protestDecidedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(syncServicePairContests.id, row.id),
              eq(syncServicePairContests.protestStatus, 'open'),
            ),
          ),
        pairContestChangedSentinel(db),
        ...pairWorkflowStepStmts(
          db,
          row,
          { which: 'protest', toState: upheld ? 'upheld' : 'rejected' },
          { actorId: session.userId, reason: `protest ${payload.decision}` },
          now,
        ),
        ...audits.map((entry) => auditInsert(db, entry)),
      ] as BatchTuple);
    } catch (error) {
      if (!isPairContestRaceError(error)) throw error;
      throw new ApiError(409, ApiErrorCode.PAIR_PROTEST_NOT_OPEN, 'This review is no longer open.');
    }
    // Advice: no purge, no catalog write, no search sync.
    afterVendorWrite(c, [], audits, undefined, db, ADMIN_ORIGIN);
    const body = await adminContestBody(db, row.id);
    validateResponseInDev(c.env, () => AdminPairContestResponseSchema.parse(body));
    return json(body);
  };
}
