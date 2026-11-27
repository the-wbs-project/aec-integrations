/**
 * Existence and data flow reports on a Sync Service pair (AECI-2042, rulings 9 and 10
 * on AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.3 and §11e.4).
 *
 * ── WHY A TABLE OF ITS OWN ──────────────────────────────────────────────────
 * `integration_field_challenges.field` carries a CHECK over twelve field names.
 * Neither report is a field: "does this exist" is about the whole row, and a data flow
 * is a claim, not a column. Adding a value would change the CHECK, which recreates the
 * table on D1, and the table is a cascade child of both edge tables. So the reports
 * live in `sync_service_pair_contests` (a plain CREATE TABLE in 0132), with the same
 * states, routing and protest columns as the field contests. The routes, the batch rule
 * and the race sentinels follow §11b.
 *
 * ── ROUTING, FROZEN AT SUBMIT ───────────────────────────────────────────────
 *   - `existence` → AECi, always (ruling 9). The pair stays public while it is open.
 *   - `data_flow` → the owner when it maintains the flows (a claimed pair whose
 *     connector is a Sync Service, `ownerMaintainsFlows`); AECi otherwise, because an
 *     unclaimed pair's flows are curated upstream.
 *
 * ── WHAT AN ACCEPT DOES ─────────────────────────────────────────────────────
 *   - an AECi accept of `existence` acts on the whole pair key (AECI-2170): every live
 *     vendor-held row on it, both tables, whoever owns it, is RETIRED through the admin
 *     retire batch in one batch, with the note as the reason and the proof link on each
 *     audit row (`accept_mode = 'retired'`). A live AECi-held row is not written
 *     (promote owns it, §4.6.4): the admin queue lists it for retraction in the review
 *     app within five business days (`?retractions=true`). With no vendor-held row
 *     live it records `'upstream-only'` when an AECi-held row is live, and
 *     `'already-retired'` when nothing on the key is. {@link pairKeyUnchangedSentinel}
 *     holds the key's rows at commit;
 *   - an owner accept of `data_flow` writes the owner's answer in the same batch, through
 *     the owner's own flow logic: the flow answered No (`'flow-removed'`), or moved to
 *     the proposed direction (`'flow-redirected'`);
 *   - an AECi accept of `data_flow` (an unclaimed pair) writes nothing here
 *     (`'upstream-only'`): the review app holds those flows.
 *
 * A protest after an owner's decline or silence follows §11b.12: the same windows, one
 * per report, and AECi's answer is ADVICE. It writes no catalog data.
 */

import {
  PAIR_PROTEST_COOLDOWN_DAYS,
  pairProtestWindow,
  type PairContest,
  type PairContestKind,
  type PairFlowDirection,
} from '@aeci/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  claims,
  connectorEvidencedPairs,
  integrations,
  products,
  syncServicePairContests,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { workflowTransitionInsert, type BatchStmt } from './audit';
import { isVendorHeld, ONE_ROW } from './integration-claims';
import {
  evidencedPairsOnPairKeyWhere,
  integrationsOnPairKeyWhere,
  type PairKey,
  type PairKeyRow,
} from './sync-service-pair-rights';
import { pairContestWorkflowStmts } from './workflow-restore';

export const PAIR_CONTEST_ENTITY_TYPE = 'sync_service_pair_contest';

export type PairContestRow = typeof syncServicePairContests.$inferSelect;

/** The token the report sentinels raise. */
export const PAIR_CONTEST_CHANGED_TOKEN = 'pair-contest-changed';

/** After a guarded report UPDATE: aborts the batch when it matched no row. */
export function pairContestChangedSentinel(db: Db): BatchStmt {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${PAIR_CONTEST_CHANGED_TOKEN}) END` })
    .from(ONE_ROW);
}

/**
 * The commit-time half of an existence accept's key read (AECI-2170). The accept reads
 * every row on the pair key, both tables, and plans a retire for each vendor-held live
 * row. This ABORTS the batch, writing nothing, unless at commit the rows on the key are
 * exactly the rows read, each with the same owner, still vendor-held or AECi-held as it
 * was, and still live or retired as it was. So a row that reached the key, left it, was
 * claimed, changed owner or was retired between the read and the batch answers
 * `409 PAIR_CONTEST_CHANGED`. Place it BEFORE the retire plans: it checks the rows as
 * the accept read them, and each plan's own guard holds its row after.
 *
 * Raises the report token ("malformed JSON"), so `isPairContestRaceError` matches it.
 * Selects FROM `ONE_ROW`, so it runs exactly once.
 */
export function pairKeyUnchangedSentinel(
  db: Db,
  key: PairKey,
  snapshot: readonly PairKeyRow[],
): BatchStmt {
  const expected = JSON.stringify(
    snapshot.map((r) => ({
      id: r.id,
      t: r.anchor === 'evidenced_pair' ? 'p' : 'i',
      o: r.builtByVendorId ?? '',
      h: isVendorHeld(r) ? 1 : 0,
      l: r.retiredAt === null ? 1 : 0,
    })),
  );
  const p = connectorEvidencedPairs;
  const i = integrations;
  const field = (name: string) => sql`json_extract(e.value, ${'$.' + name})`;
  const matches = (
    table: SQL,
    cols: { id: SQL; owner: SQL; claimed: SQL; origin: SQL; retired: SQL },
    onKey: SQL,
  ) =>
    sql`EXISTS (SELECT 1 FROM ${table} WHERE ${cols.id} = ${field('id')} AND ${onKey} AND ifnull(${cols.owner}, '') = ${field('o')} AND (${cols.claimed} IS NOT NULL OR ${cols.origin} = 'vendor') = ${field('h')} AND (${cols.retired} IS NULL) = ${field('l')})`;
  const pairMatch = matches(
    sql`${p}`,
    {
      id: sql`${p.id}`,
      owner: sql`${p.builtByVendorId}`,
      claimed: sql`${p.claimedAt}`,
      origin: sql`${p.origin}`,
      retired: sql`${p.retiredAt}`,
    },
    evidencedPairsOnPairKeyWhere(key),
  );
  const intMatch = matches(
    sql`${i}`,
    {
      id: sql`${i.id}`,
      owner: sql`${i.builtByVendorId}`,
      claimed: sql`${i.claimedAt}`,
      origin: sql`${i.origin}`,
      retired: sql`${i.retiredAt}`,
    },
    integrationsOnPairKeyWhere(key),
  );
  const onKeyCount = sql`((SELECT count(*) FROM ${p} WHERE ${evidencedPairsOnPairKeyWhere(key)}) + (SELECT count(*) FROM ${i} WHERE ${integrationsOnPairKeyWhere(key)}))`;
  const matched = sql`(SELECT count(*) FROM json_each(${expected}) AS e WHERE (${field('t')} = 'p' AND ${pairMatch}) OR (${field('t')} = 'i' AND ${intMatch}))`;
  return db
    .select({
      guard: sql`CASE WHEN ${onKeyCount} <> ${snapshot.length} OR ${matched} <> ${snapshot.length} THEN json(${PAIR_CONTEST_CHANGED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/**
 * After a report INSERT: aborts when the same submitter now has two open reports of the
 * same kind on the same row (and the same claim, for a data flow). The partial unique
 * index cannot hold this rule, because SQLite treats NULLs as distinct.
 */
export function pairContestDuplicateSentinel(
  db: Db,
  row: Pick<
    PairContestRow,
    'submitterVendorId' | 'kind' | 'integrationId' | 'evidencedPairId' | 'claimId'
  >,
): BatchStmt {
  const t = syncServicePairContests;
  return db
    .select({
      guard: sql`CASE WHEN (SELECT count(*) FROM ${t} WHERE ${t.submitterVendorId} = ${row.submitterVendorId} AND ${t.kind} = ${row.kind} AND ${t.status} = 'open' AND ${t.integrationId} IS ${row.integrationId} AND ${t.evidencedPairId} IS ${row.evidencedPairId} AND ${t.claimId} IS ${row.claimId}) > 1 THEN json(${PAIR_CONTEST_CHANGED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

export function isPairContestRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(PAIR_CONTEST_CHANGED_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The open report the vendor already has on this target, if any. */
export async function openDuplicate(
  db: Db,
  row: Pick<
    PairContestRow,
    'submitterVendorId' | 'kind' | 'integrationId' | 'evidencedPairId' | 'claimId'
  >,
): Promise<{ id: string } | null> {
  const t = syncServicePairContests;
  const [hit] = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.submitterVendorId, row.submitterVendorId),
        eq(t.kind, row.kind),
        eq(t.status, 'open'),
        sql`${t.integrationId} IS ${row.integrationId}`,
        sql`${t.evidencedPairId} IS ${row.evidencedPairId}`,
        sql`${t.claimId} IS ${row.claimId}`,
      ),
    )
    .limit(1);
  return hit ?? null;
}

// ─── Workflow rows (AECI-2110) ───────────────────────────────────────────────

/**
 * `workflow_instances.workflow_type` for a report and for its protest. Reused, not
 * added, as the field contests reuse it: the type CHECK is closed and opening it is a
 * table recreate (`schema.ts` `workflowInstances`). `entity_id` is the report id.
 */
export const PAIR_CONTEST_WORKFLOW_TYPE = 'correction_request';

/** `final_outcome` per terminal report status, and per terminal protest status. */
const REPORT_FINAL_OUTCOME = {
  accepted: 'approved',
  declined: 'rejected',
  withdrawn: 'cancelled',
} as const;
const PROTEST_FINAL_OUTCOME = {
  upheld: 'approved',
  rejected: 'rejected',
  withdrawn: 'cancelled',
} as const;

export type PairReportTerminal = keyof typeof REPORT_FINAL_OUTCOME;
export type PairProtestTerminal = keyof typeof PROTEST_FINAL_OUTCOME;

/**
 * The statements that record one report or protest step in its workflow: the
 * instance's state (or its creation under the deterministic id when the link is NULL,
 * for a report filed before AECI-2110 or a pruned instance), then the transition. Place
 * them AFTER the guarded UPDATE and its sentinel, so a lost race writes none of them.
 */
export function pairWorkflowStepStmts(
  db: Db,
  row: Pick<PairContestRow, 'id' | 'workflowId' | 'protestWorkflowId'>,
  step:
    | { which: 'report'; toState: PairReportTerminal }
    | { which: 'protest'; toState: PairProtestTerminal | 'open' },
  entry: { actorId: string | null; reason?: string; metadata?: Record<string, unknown> },
  now: string,
): BatchStmt[] {
  const terminal =
    step.which === 'report'
      ? { finalOutcome: REPORT_FINAL_OUTCOME[step.toState] }
      : step.toState === 'open'
        ? null
        : { finalOutcome: PROTEST_FINAL_OUTCOME[step.toState] };
  const instance = pairContestWorkflowStmts(
    db,
    row,
    step.which,
    now,
    terminal ? { currentState: step.toState, completedAt: now, ...terminal } : undefined,
  );
  return [
    ...instance.stmts,
    workflowTransitionInsert(db, {
      workflowId: instance.workflowId,
      fromState: 'open',
      toState: step.toState,
      actorId: entry.actorId,
      reason: entry.reason,
      metadata: entry.metadata,
    }),
  ];
}

// ─── Protest evidence, reply and cooldown (AECI-2110, §11b.12 applied) ──────

/** A stored evidence column, read with a fallback to `[]` so one bad value cannot fail
 *  a list (§11b.12.5's rule). */
export function parsePairEvidence(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The evidence links to store: deduplicated in order, `null` when there are none. */
export function storedPairEvidence(urls: readonly string[]): string | null {
  const unique = [...new Set(urls)];
  return unique.length ? JSON.stringify(unique) : null;
}

const DAY_MS = 86_400_000;

/**
 * When a rejected protest still bars a new data flow report on the same flow, or
 * `null`: 90 days from AECi's decision while the flow's direction is still the one the
 * report was about (§11b.12.8's "unless the value on record changes"). `liveDirection`
 * is the claim's direction now, in the pair frame; `null` when the claim is gone.
 */
export function pairCooldownUntil(
  row: Pick<PairContestRow, 'protestStatus' | 'protestDecidedAt' | 'currentDirection'>,
  liveDirection: string | null,
  now: Date,
): string | null {
  if (row.protestStatus !== 'rejected' || !row.protestDecidedAt) return null;
  if (liveDirection === null || liveDirection !== row.currentDirection) return null;
  const until = Date.parse(row.protestDecidedAt) + PAIR_PROTEST_COOLDOWN_DAYS * DAY_MS;
  return now.getTime() < until ? new Date(until).toISOString() : null;
}

/**
 * The two refusals a data flow report meets after the duplicate check (§11b.12.8,
 * applied to pair reports by AECI-2110), by the same submitting vendor on the same flow:
 * an open protest (`CONTEST_PROTEST_OPEN`), or a rejected protest still in its cooldown
 * (`CONTEST_COOLDOWN`, the latest end). Handler reads with no in-batch sentinel, as for
 * field contests: neither writes anything public.
 */
export async function pairProtestSubmitRefusal(
  db: Db,
  args: { submitterVendorId: string; claimId: string; liveDirection: string },
  now: Date,
): Promise<
  | { code: 'CONTEST_PROTEST_OPEN'; contestId: string }
  | { code: 'CONTEST_COOLDOWN'; until: string }
  | null
> {
  const t = syncServicePairContests;
  const rows = await db
    .select({
      id: t.id,
      protestStatus: t.protestStatus,
      protestDecidedAt: t.protestDecidedAt,
      currentDirection: t.currentDirection,
    })
    .from(t)
    .where(
      and(
        eq(t.submitterVendorId, args.submitterVendorId),
        eq(t.kind, 'data_flow'),
        eq(t.claimId, args.claimId),
        sql`${t.protestStatus} IN ('open', 'rejected')`,
      ),
    );
  const open = rows.find((r) => r.protestStatus === 'open');
  if (open) return { code: 'CONTEST_PROTEST_OPEN', contestId: open.id };
  let latest: string | null = null;
  for (const r of rows) {
    const until = pairCooldownUntil(r, args.liveDirection, now);
    if (until && (latest === null || until > latest)) latest = until;
  }
  return latest ? { code: 'CONTEST_COOLDOWN', until: latest } : null;
}

/**
 * In a protest file batch: aborts when the submitter has another OPEN data flow report
 * on the same flow, excluding this one. One live dispute per flow per vendor, from the
 * protest side (§11b.12.15 ruling 8).
 */
export function noOtherOpenPairReportSentinel(
  db: Db,
  row: Pick<PairContestRow, 'id' | 'submitterVendorId' | 'claimId'>,
): BatchStmt {
  const t = syncServicePairContests;
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM ${t} WHERE ${t.submitterVendorId} = ${row.submitterVendorId} AND ${t.kind} = 'data_flow' AND ${t.claimId} IS ${row.claimId} AND ${t.status} = 'open' AND ${t.id} <> ${row.id}) THEN json(${PAIR_CONTEST_CHANGED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/** Wire rows. Four reads for the whole list, never one per row. `side: 'submitted'`
 *  adds the submitter-only `cooldown_until`. */
export async function pairContestWireRows(
  db: Db,
  rows: readonly PairContestRow[],
  now: Date = new Date(),
  opts: { side?: 'submitted' | 'received' | 'admin' } = {},
): Promise<PairContest[]> {
  if (rows.length === 0) return [];
  const intIds = rows.map((r) => r.integrationId).filter((x): x is string => !!x);
  const pairIds = rows.map((r) => r.evidencedPairId).filter((x): x is string => !!x);
  const claimIds = rows.map((r) => r.claimId).filter((x): x is string => !!x);
  const vendorIds = [
    ...new Set(
      rows.flatMap((r) => [r.submitterVendorId, r.ownerVendorId]).filter((x): x is string => !!x),
    ),
  ];
  const each = (ids: readonly string[]) =>
    sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  const [intRows, pairRows, claimRows, vendorRows] = await Promise.all([
    intIds.length
      ? db
          .select({
            id: integrations.id,
            name: integrations.name,
            source: integrations.sourceProductId,
            target: integrations.targetProductId,
            connector: integrations.poweredByProductId,
          })
          .from(integrations)
          .where(sql`${integrations.id} IN ${each(intIds)}`)
      : Promise.resolve([]),
    pairIds.length
      ? db
          .select({
            id: connectorEvidencedPairs.id,
            name: connectorEvidencedPairs.name,
            source: connectorEvidencedPairs.productAId,
            target: connectorEvidencedPairs.productBId,
            connector: connectorEvidencedPairs.connectorProductId,
          })
          .from(connectorEvidencedPairs)
          .where(sql`${connectorEvidencedPairs.id} IN ${each(pairIds)}`)
      : Promise.resolve([]),
    claimIds.length
      ? db
          .select({
            id: claims.id,
            slug: taxonomyDataObjects.slug,
            name: taxonomyDataObjects.name,
            direction: claims.direction,
          })
          .from(claims)
          .innerJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, claims.dataObjectId))
          .where(sql`${claims.id} IN ${each(claimIds)}`)
      : Promise.resolve([]),
    vendorIds.length
      ? db
          .select({ id: vendors.id, name: vendors.companyName })
          .from(vendors)
          .where(sql`${vendors.id} IN ${each(vendorIds)}`)
      : Promise.resolve([]),
  ]);
  const anchors = new Map([...intRows, ...pairRows].map((r) => [r.id, r]));
  const productIds = [
    ...new Set(
      [...anchors.values()]
        .flatMap((a) => [a.source, a.target, a.connector])
        .filter((x): x is string => !!x),
    ),
  ];
  const productRows = productIds.length
    ? await db
        .select({ id: products.id, slug: products.slug, name: products.name })
        .from(products)
        .where(sql`${products.id} IN ${each(productIds)}`)
    : [];
  const product = new Map(productRows.map((p) => [p.id, p]));
  const flow = new Map(claimRows.map((c) => [c.id, c]));
  const vendor = new Map(vendorRows.map((v) => [v.id, v.name]));

  return rows.map((r) => {
    const anchorId = r.integrationId ?? r.evidencedPairId;
    const a = anchorId ? anchors.get(anchorId) : undefined;
    const [pa, pb] = a
      ? a.source < a.target
        ? [a.source, a.target]
        : [a.target, a.source]
      : [null, null];
    const window = pairProtestWindow(r, now);
    const f = r.claimId ? flow.get(r.claimId) : undefined;
    const liveDirection = f && a ? toPairFrame(f.direction, a.source < a.target) : null;
    return {
      id: r.id,
      kind: r.kind as PairContestKind,
      pair: {
        integration_id: anchorId,
        anchor: r.integrationId ? 'integration' : 'evidenced_pair',
        name: a?.name ?? null,
        connector: a?.connector ? (product.get(a.connector) ?? null) : null,
        product_a: pa ? (product.get(pa) ?? null) : null,
        product_b: pb ? (product.get(pb) ?? null) : null,
      },
      flow:
        r.claimId && f
          ? {
              claim_id: r.claimId,
              data_object_slug: f.slug,
              data_object_name: f.name,
              current_direction: (r.currentDirection ?? 'both') as PairFlowDirection,
              proposed_direction: (r.proposedDirection as PairFlowDirection | null) ?? null,
            }
          : null,
      reason: r.reason,
      submitter_vendor_id: r.submitterVendorId,
      submitter_name: vendor.get(r.submitterVendorId) ?? null,
      routed_to: r.routedTo as 'owner' | 'aeci',
      owner_vendor_id: r.ownerVendorId,
      owner_name: r.ownerVendorId ? (vendor.get(r.ownerVendorId) ?? null) : null,
      status: r.status as PairContest['status'],
      decision_note: r.decisionNote,
      decided_at: r.decidedAt,
      accept_mode: r.acceptMode,
      protest:
        r.protestStatus && r.protestBasis && r.protestReason && r.protestedAt
          ? {
              status: r.protestStatus as 'open' | 'upheld' | 'rejected' | 'withdrawn',
              basis: r.protestBasis as 'declined' | 'silence',
              reason: r.protestReason,
              evidence_urls: parsePairEvidence(r.protestEvidence),
              protested_at: r.protestedAt,
              reply_due_at: r.protestReplyDueAt,
              reply: r.protestReply,
              reply_evidence_urls: parsePairEvidence(r.protestReplyEvidence),
              replied_at: r.protestRepliedAt,
              decision_note: r.protestDecisionNote,
              decided_at: r.protestDecidedAt,
            }
          : null,
      protest_closes_at: window?.closesAt ?? null,
      cooldown_until: opts.side === 'submitted' ? pairCooldownUntil(r, liveDirection, now) : null,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    };
  });
}

/**
 * A claim's stored direction, framed on the PAIR's canonical A. On an `integrations`
 * row the claim is framed source → target, so it flips when the source sorts second.
 */
export function toPairFrame(direction: string, sourceIsA: boolean): PairFlowDirection {
  if (direction === 'both' || sourceIsA) return direction as PairFlowDirection;
  return direction === 'a_to_b' ? 'b_to_a' : 'a_to_b';
}

/** The inverse of {@link toPairFrame}: a pair-frame direction in the row's own frame. */
export function fromPairFrame(direction: PairFlowDirection, sourceIsA: boolean): PairFlowDirection {
  return toPairFrame(direction, sourceIsA);
}
