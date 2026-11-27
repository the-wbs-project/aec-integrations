/**
 * The protest and decline emails (AECI-1205 / `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.12.10).
 *
 * Five senders, all fire-and-forget after a committed write or from a cron:
 *
 *   - {@link emailContestSubmittedToOwner} (AECI-1942, §11b.8): an owner-routed
 *     contest was submitted. The owner vendor's seats get `contest-submitted-owner`
 *     with the date after which their silence counts as a decline (30 days).
 *   - {@link emailPairReportSubmittedToOwner} (AECI-2229, §11e.7): the same for an
 *     owner-routed Sync Service data flow report, as `pair-report-submitted-owner`.
 *   - {@link emailProtestFiled}: a protest was filed. The owner vendor's seats get
 *     `contest-protest-opened` with the 14-day reply deadline, and `SUPPORT_EMAIL`
 *     gets `protest-submitted-alert`.
 *   - {@link emailOwnerDecline}: the owner declined a contest. The submitter vendor's
 *     seats get `contest-declined-protest-window` with the 30-day filing deadline.
 *   - {@link runProtestReplyReminderSweep}: the daily `protest_reply_reminder` cron.
 *     An open protest with no reply whose deadline falls in the next 3 days sends
 *     the owner's seats `contest-protest-reply-reminder`.
 *   - {@link emailPairProtestFiled} (AECI-2110, §11e.5): a protest on a Sync Service
 *     data flow report. The owner's seats get `contest-protest-opened`, the same
 *     template, with the flow as the "field". The sweep covers these protests too.
 *     AECi's alert goes out from the route (`sendPairContestSubmittedNotification`).
 *
 * **At most once, with no schema change.** Every send carries a `notification_sends`
 * dedupe key (AECI-1202). Each per-seat key ends in the seat's profile id, because the
 * key is unique across the whole ledger and the seats of one vendor are separate
 * sends. A key held by an earlier send makes the next one a `duplicate` with no Resend
 * call. That is what lets the reminder cron run daily over a 3-day window and still
 * send once. A `failed` send releases its key, so tomorrow's run retries it.
 *
 * **No mute.** These carry a deadline the vendor loses a right by missing, so the
 * attestation nudge mute (AECI-1204) does not apply. Seats come from
 * `loadVendorSeatRecipients`, which reads no preference.
 *
 * **Never rejects.** The route senders run inside `waitUntil` after the batch
 * committed. A read failure warns and sends nothing. The email layer resolves every
 * send failure to an outcome.
 */

import {
  addContestDays,
  CONTEST_OWNER_SILENCE_DAYS,
  PAIR_PROTEST_WINDOW_DAYS,
  type ContestProtestBasis,
  type PairContest,
  type PairFlowDirection,
} from '@aeci/shared';
import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  integrationFieldChallenges,
  products,
  syncServicePairContests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { logToPosthog } from '../posthog';
import {
  sendContestDeclinedProtestWindowEmail,
  sendContestProtestOpenedEmail,
  sendContestProtestReplyReminderEmail,
  sendContestSubmittedOwnerEmail,
  sendPairReportSubmittedOwnerEmail,
  sendProtestSubmittedAlert,
  type ContestEmailFacts,
  type EmailContext,
  type EmailOutcome,
} from './email';
import { contestAnchorOf, loadContestTarget, type ContestRow } from './integration-contests';
import { pairContestWireRows, type PairContestRow } from './sync-service-pair-contests';
import {
  loadVendorSeatRecipients,
  type FetchSeatEmails,
  type SeatRecipient,
} from './vendor-seat-recipients';

const DAY_MS = 86_400_000;

/** How far ahead of the reply deadline the reminder goes out. */
export const PROTEST_REMINDER_LEAD_DAYS = 3;

/** Most protests one reminder run handles. A backstop, not a design limit: open
 *  protests are a handful, and the next daily run continues any backlog. */
export const PROTEST_REMINDER_BATCH_CAP = 100;

export interface ProtestEmailDeps {
  /** The privileged `auth.users` email seam. Injected so specs never touch it. */
  fetchSeatEmails?: FetchSeatEmails;
}

// ─── Dedupe keys ─────────────────────────────────────────────────────────────

export const protestOpenedKey = (contestId: string, protestedAt: string, profileId: string) =>
  `contest-protest-opened:${contestId}:${protestedAt}:${profileId}`;
export const protestAlertKey = (contestId: string, protestedAt: string) =>
  `protest-submitted-alert:${contestId}:${protestedAt}`;
export const protestReminderKey = (contestId: string, protestedAt: string, profileId: string) =>
  `contest-protest-reply-reminder:${contestId}:${protestedAt}:${profileId}`;
export const declineWindowKey = (contestId: string, profileId: string) =>
  `contest-declined-protest-window:${contestId}:${profileId}`;
export const contestSubmittedOwnerKey = (contestId: string, profileId: string) =>
  `contest-submitted-owner:${contestId}:${profileId}`;
export const pairReportSubmittedOwnerKey = (reportId: string, profileId: string) =>
  `pair-report-submitted-owner:${reportId}:${profileId}`;

// ─── Shared reads ────────────────────────────────────────────────────────────

interface VendorRef {
  name: string;
  slug: string;
}

/** What every email about one contest needs: the facts and the two vendors. */
async function loadContestEmailContext(
  db: Db,
  row: ContestRow,
): Promise<{ facts: ContestEmailFacts; vendors: Map<string, VendorRef> }> {
  const target = await loadContestTarget(db, contestAnchorOf(row));
  let pairSlugs: readonly [string, string] | null = null;
  let pairName: string | null = null;
  if (target) {
    const ends = await db
      .select({ id: products.id, slug: products.slug, name: products.name })
      .from(products)
      .where(inArray(products.id, [target.sourceProductId, target.targetProductId]));
    const byId = new Map(ends.map((p) => [p.id, p]));
    const a = byId.get(target.sourceProductId);
    const b = byId.get(target.targetProductId);
    if (a && b) {
      pairSlugs = [a.slug, b.slug];
      pairName = `${a.name} and ${b.name}`;
    }
  }
  const vendorIds = [row.submitterVendorId, row.ownerVendorId].filter(
    (id): id is string => typeof id === 'string',
  );
  const named = vendorIds.length
    ? await db
        .select({ id: vendors.id, name: vendors.companyName, slug: vendors.slug })
        .from(vendors)
        .where(inArray(vendors.id, vendorIds))
    : [];
  return {
    facts: {
      contestId: row.id,
      integrationName: target?.name?.trim() || pairName || 'an integration',
      field: row.field,
      currentValue: row.currentValue,
      proposedValue: row.proposedValue,
      pairSlugs,
    },
    vendors: new Map(named.map((v) => [v.id, { name: v.name, slug: v.slug }])),
  };
}

function warn(c: EmailContext, message: string, error: unknown): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message,
      source: 'contest-protest-email',
      outcome: error instanceof Error ? error.message : String(error),
    });
  } catch {
    console.warn(`contest-protest-email: ${message}`);
  }
}

// ─── Contest submitted to the owner ──────────────────────────────────────────

/**
 * Email the owner's seats about an owner-routed contest that just committed
 * (AECI-1942). `row` is the contest as the submit batch wrote it. An AECi-routed
 * contest has no owner to tell and sends nothing here; the route sends AECi its own
 * alert. Never rejects.
 */
export async function emailContestSubmittedToOwner(
  c: EmailContext,
  db: Db,
  row: ContestRow,
  deps: ProtestEmailDeps = {},
): Promise<void> {
  try {
    if (row.routedTo !== 'owner' || !row.ownerVendorId) return;
    const ownerVendorId = row.ownerVendorId;
    const { facts, vendors: named } = await loadContestEmailContext(db, row);
    const owner = named.get(ownerVendorId);
    const submitterName = named.get(row.submitterVendorId)?.name ?? 'A vendor';
    const answerBy = addContestDays(row.createdAt, CONTEST_OWNER_SILENCE_DAYS);
    const seats = await ownerSeats(db, c.env, ownerVendorId, deps);
    // One connection at a time: sequential sends.
    for (const seat of seats) {
      await sendContestSubmittedOwnerEmail(c, {
        ...facts,
        to: seat.email,
        vendorId: ownerVendorId,
        vendorSlug: owner?.slug ?? null,
        vendorName: owner?.name ?? null,
        submitterVendorName: submitterName,
        contestReason: row.reason,
        answerBy,
        dedupeKey: contestSubmittedOwnerKey(row.id, seat.profileId),
      });
    }
  } catch (error) {
    warn(c, `Contest owner email failed for ${row.id}`, error);
  }
}

// ─── Data flow report submitted to the owner ─────────────────────────────────

/**
 * Email the owner's seats about an owner-routed Sync Service data flow report that
 * just committed (AECI-2229, §11e.7). `row` is the report as the submit batch wrote it.
 * Only a data flow report on a claimed pair routes to the owner (§11e.4). An
 * AECi-routed report sends nothing here; the route sends AECi its own alert. The
 * answer date is the submit plus the 30 days after which `pairProtestWindow` lets the
 * submitter protest the owner's silence. Never rejects.
 */
export async function emailPairReportSubmittedToOwner(
  c: EmailContext,
  db: Db,
  row: PairContestRow,
  deps: ProtestEmailDeps = {},
): Promise<void> {
  try {
    if (row.routedTo !== 'owner' || !row.ownerVendorId || row.kind !== 'data_flow') return;
    const ownerVendorId = row.ownerVendorId;
    const [wire] = await pairContestWireRows(db, [row]);
    if (!wire?.flow) return;
    const owner = await db.query.vendors.findFirst({
      columns: { companyName: true, slug: true },
      where: eq(vendors.id, ownerVendorId),
    });
    const a = wire.pair.product_a;
    const b = wire.pair.product_b;
    const integrationName =
      wire.pair.name?.trim() || (a && b ? `${a.name} and ${b.name}` : 'an integration');
    const answerBy = addContestDays(row.createdAt, PAIR_PROTEST_WINDOW_DAYS);
    const seats = await ownerSeats(db, c.env, ownerVendorId, deps);
    // One connection at a time: sequential sends.
    for (const seat of seats) {
      await sendPairReportSubmittedOwnerEmail(c, {
        to: seat.email,
        vendorId: ownerVendorId,
        vendorSlug: owner?.slug ?? null,
        vendorName: owner?.companyName ?? null,
        reportId: row.id,
        integrationName,
        flowName: wire.flow.data_object_name,
        currentDirection: wire.flow.current_direction,
        proposedDirection: wire.flow.proposed_direction,
        productAName: a?.name ?? null,
        productBName: b?.name ?? null,
        submitterVendorName: wire.submitter_name ?? 'A vendor',
        reason: row.reason,
        answerBy,
        pairSlugs: a && b ? [a.slug, b.slug] : null,
        dedupeKey: pairReportSubmittedOwnerKey(row.id, seat.profileId),
      });
    }
  } catch (error) {
    warn(c, `Data flow report owner email failed for ${row.id}`, error);
  }
}

// ─── Protest filed ───────────────────────────────────────────────────────────

/**
 * Email the owner's seats and AECi about a protest that just committed. `row` is the
 * contest as it was read before the file batch, and `protest` the values the batch
 * wrote. Never rejects.
 */
export async function emailProtestFiled(
  c: EmailContext,
  db: Db,
  row: ContestRow,
  protest: {
    basis: ContestProtestBasis;
    reason: string;
    evidenceCount: number;
    protestedAt: string;
    replyDueAt: string;
  },
  deps: ProtestEmailDeps = {},
): Promise<void> {
  try {
    const { facts, vendors: named } = await loadContestEmailContext(db, row);
    const submitterName = named.get(row.submitterVendorId)?.name ?? 'A vendor';
    const owner = row.ownerVendorId ? named.get(row.ownerVendorId) : undefined;

    await sendProtestSubmittedAlert(c, {
      ...facts,
      submitterVendorName: submitterName,
      ownerVendorName: owner?.name ?? row.ownerVendorId ?? 'none',
      basis: protest.basis,
      protestReason: protest.reason,
      evidenceCount: protest.evidenceCount,
      replyDueAt: protest.replyDueAt,
      dedupeKey: protestAlertKey(row.id, protest.protestedAt),
    });

    if (!row.ownerVendorId) return;
    const seats = await ownerSeats(db, c.env, row.ownerVendorId, deps);
    // One connection at a time: sequential sends.
    for (const seat of seats) {
      await sendContestProtestOpenedEmail(c, {
        ...facts,
        to: seat.email,
        vendorId: row.ownerVendorId,
        vendorSlug: owner?.slug ?? null,
        vendorName: owner?.name ?? null,
        submitterVendorName: submitterName,
        basis: protest.basis,
        protestReason: protest.reason,
        replyDueAt: protest.replyDueAt,
        dedupeKey: protestOpenedKey(row.id, protest.protestedAt, seat.profileId),
      });
    }
  } catch (error) {
    warn(c, `Protest emails failed for ${row.id}`, error);
  }
}

async function ownerSeats(
  db: Db,
  env: Env,
  vendorId: string,
  deps: ProtestEmailDeps,
): Promise<SeatRecipient[]> {
  const byVendor = await loadVendorSeatRecipients(db, env, [vendorId], deps.fetchSeatEmails);
  return byVendor.get(vendorId) ?? [];
}

// ─── Sync Service data flow report protests (AECI-2110) ──────────────────────

/** A pair-frame direction in words: "Revit to Procore", or "Both ways". */
function pairDirectionWords(
  direction: PairFlowDirection | null,
  a: string | null,
  b: string | null,
): string {
  if (direction === null) return 'Not listed';
  if (direction === 'both') return 'Both ways';
  const [from, to] = direction === 'a_to_b' ? [a, b] : [b, a];
  return from && to ? `${from} to ${to}` : direction === 'a_to_b' ? 'A to B' : 'B to A';
}

/** The facts of a data flow report, shaped for the field-contest templates: the
 *  "field" is the data flow, the values are its direction on record and proposed. */
function pairReportEmailFacts(wire: PairContest): ContestEmailFacts {
  const a = wire.pair.product_a?.name ?? null;
  const b = wire.pair.product_b?.name ?? null;
  const flow = wire.flow?.data_object_name ?? 'data';
  const pairSlugs =
    wire.pair.product_a && wire.pair.product_b
      ? ([wire.pair.product_a.slug, wire.pair.product_b.slug] as const)
      : null;
  return {
    contestId: wire.id,
    integrationName: wire.pair.name?.trim() || (a && b ? `${a} and ${b}` : 'an integration'),
    field: `${flow} data flow`,
    currentValue: pairDirectionWords(wire.flow?.current_direction ?? null, a, b),
    proposedValue: pairDirectionWords(wire.flow?.proposed_direction ?? null, a, b),
    pairSlugs,
    entityType: 'sync_service_pair_contest',
  };
}

async function vendorRef(db: Db, vendorId: string): Promise<VendorRef | undefined> {
  const [row] = await db
    .select({ name: vendors.companyName, slug: vendors.slug })
    .from(vendors)
    .where(eq(vendors.id, vendorId))
    .limit(1);
  return row;
}

/**
 * Email the owner's seats about a protest on a data flow report that just committed,
 * with its 14-day reply deadline. `wire` is the report after the batch. Never rejects.
 */
export async function emailPairProtestFiled(
  c: EmailContext,
  db: Db,
  wire: PairContest | undefined,
  protest: {
    basis: ContestProtestBasis;
    reason: string;
    protestedAt: string;
    replyDueAt: string;
  },
  deps: ProtestEmailDeps = {},
): Promise<void> {
  try {
    if (!wire?.owner_vendor_id) return;
    const ownerVendorId = wire.owner_vendor_id;
    const owner = await vendorRef(db, ownerVendorId);
    const facts = pairReportEmailFacts(wire);
    const seats = await ownerSeats(db, c.env, ownerVendorId, deps);
    for (const seat of seats) {
      await sendContestProtestOpenedEmail(c, {
        ...facts,
        to: seat.email,
        vendorId: ownerVendorId,
        vendorSlug: owner?.slug ?? null,
        vendorName: owner?.name ?? null,
        submitterVendorName: wire.submitter_name ?? 'A vendor',
        basis: protest.basis,
        protestReason: protest.reason,
        replyDueAt: protest.replyDueAt,
        dedupeKey: protestOpenedKey(wire.id, protest.protestedAt, seat.profileId),
      });
    }
  } catch (error) {
    warn(c, `Pair protest email failed for ${wire?.id ?? 'unknown'}`, error);
  }
}

// ─── Owner decline ───────────────────────────────────────────────────────────

/**
 * Email the submitter's seats that the owner declined their contest, and until when
 * they can protest it. Call it only for an OWNER decline: an AECi decline cannot be
 * protested. Never rejects.
 */
export async function emailOwnerDecline(
  c: EmailContext,
  db: Db,
  row: ContestRow,
  decline: { decisionNote: string | null; protestClosesAt: string },
  deps: ProtestEmailDeps = {},
): Promise<void> {
  try {
    const { facts, vendors: named } = await loadContestEmailContext(db, row);
    const submitter = named.get(row.submitterVendorId);
    const ownerName = (row.ownerVendorId && named.get(row.ownerVendorId)?.name) || 'The owner';
    const byVendor = await loadVendorSeatRecipients(
      db,
      c.env,
      [row.submitterVendorId],
      deps.fetchSeatEmails,
    );
    for (const seat of byVendor.get(row.submitterVendorId) ?? []) {
      await sendContestDeclinedProtestWindowEmail(c, {
        ...facts,
        to: seat.email,
        vendorId: row.submitterVendorId,
        vendorSlug: submitter?.slug ?? null,
        vendorName: submitter?.name ?? null,
        ownerVendorName: ownerName,
        decisionNote: decline.decisionNote,
        protestClosesAt: decline.protestClosesAt,
        dedupeKey: declineWindowKey(row.id, seat.profileId),
      });
    }
  } catch (error) {
    warn(c, `Decline email failed for ${row.id}`, error);
  }
}

// ─── The daily reply reminder ────────────────────────────────────────────────

export interface ProtestReminderResult {
  /** Open, unreplied protests whose deadline falls inside the reminder window. */
  due: number;
  /** Protests dropped by {@link PROTEST_REMINDER_BATCH_CAP} this run. */
  capped: number;
  /** Per-seat send outcomes, aggregated. A held key counts as `duplicate`. */
  emails: Record<EmailOutcome, number>;
}

const emptyOutcomes = (): Record<EmailOutcome, number> => ({
  sent: 0,
  failed: 0,
  unknown: 0,
  skipped: 0,
  suppressed: 0,
  duplicate: 0,
  paused: 0,
});

/**
 * Send `contest-protest-reply-reminder` for every open protest with no reply whose
 * deadline is after `now` and at most {@link PROTEST_REMINDER_LEAD_DAYS} days away.
 *
 * A replied, withdrawn or decided protest is skipped by the read, and so is one past
 * its deadline: the reply is closed, so a reminder would be noise. The ledger key
 * makes each (protest, seat) send once across the daily runs inside the window.
 * Throws only on a D1 error, which the cron shell records as a failed run.
 */
export async function runProtestReplyReminderSweep(
  c: EmailContext,
  db: Db,
  deps: ProtestEmailDeps & { now?: Date } = {},
): Promise<ProtestReminderResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const horizonIso = new Date(now.getTime() + PROTEST_REMINDER_LEAD_DAYS * DAY_MS).toISOString();

  // `integration_field_challenges_protest_idx` leads with `protest_status`.
  const rows = await db
    .select()
    .from(integrationFieldChallenges)
    .where(
      and(
        eq(integrationFieldChallenges.protestStatus, 'open'),
        isNull(integrationFieldChallenges.protestReply),
        gt(integrationFieldChallenges.protestReplyDueAt, nowIso),
        lte(integrationFieldChallenges.protestReplyDueAt, horizonIso),
      ),
    )
    .orderBy(integrationFieldChallenges.protestReplyDueAt, integrationFieldChallenges.id);

  const batch = rows.slice(0, PROTEST_REMINDER_BATCH_CAP);
  const result: ProtestReminderResult = {
    due: rows.length,
    capped: rows.length - batch.length,
    emails: emptyOutcomes(),
  };
  if (batch.length === 0) {
    await remindPairProtests(c, db, deps, nowIso, horizonIso, result);
    return result;
  }

  const ownerIds = batch.map((r) => r.ownerVendorId).filter((id): id is string => !!id);
  const seatsByVendor = await loadVendorSeatRecipients(db, c.env, ownerIds, deps.fetchSeatEmails);

  for (const row of batch) {
    if (!row.ownerVendorId || !row.protestedAt || !row.protestReplyDueAt) continue;
    const seats = seatsByVendor.get(row.ownerVendorId) ?? [];
    if (seats.length === 0) continue;
    const { facts, vendors: named } = await loadContestEmailContext(db, row);
    const owner = named.get(row.ownerVendorId);
    for (const seat of seats) {
      const outcome = await sendContestProtestReplyReminderEmail(c, {
        ...facts,
        to: seat.email,
        vendorId: row.ownerVendorId,
        vendorSlug: owner?.slug ?? null,
        vendorName: owner?.name ?? null,
        submitterVendorName: named.get(row.submitterVendorId)?.name ?? 'A vendor',
        replyDueAt: row.protestReplyDueAt,
        dedupeKey: protestReminderKey(row.id, row.protestedAt, seat.profileId),
      });
      result.emails[outcome]++;
    }
  }
  await remindPairProtests(c, db, deps, nowIso, horizonIso, result);
  return result;
}

/** The same reminder for protests on Sync Service data flow reports (AECI-2110). */
async function remindPairProtests(
  c: EmailContext,
  db: Db,
  deps: ProtestEmailDeps,
  nowIso: string,
  horizonIso: string,
  result: ProtestReminderResult,
): Promise<void> {
  const t = syncServicePairContests;
  const rows = await db
    .select()
    .from(t)
    .where(
      and(
        eq(t.protestStatus, 'open'),
        isNull(t.protestReply),
        gt(t.protestReplyDueAt, nowIso),
        lte(t.protestReplyDueAt, horizonIso),
      ),
    )
    .orderBy(t.protestReplyDueAt, t.id);
  const batch = rows.slice(0, PROTEST_REMINDER_BATCH_CAP);
  result.due += rows.length;
  result.capped += rows.length - batch.length;
  if (batch.length === 0) return;
  const ownerIds = batch.map((r) => r.ownerVendorId).filter((id): id is string => !!id);
  const seatsByVendor = await loadVendorSeatRecipients(db, c.env, ownerIds, deps.fetchSeatEmails);
  const wires = new Map((await pairContestWireRows(db, batch)).map((w) => [w.id, w]));
  for (const row of batch) {
    const wire = wires.get(row.id);
    if (!wire || !row.ownerVendorId || !row.protestedAt || !row.protestReplyDueAt) continue;
    const seats = seatsByVendor.get(row.ownerVendorId) ?? [];
    if (seats.length === 0) continue;
    const owner = await vendorRef(db, row.ownerVendorId);
    for (const seat of seats) {
      const outcome = await sendContestProtestReplyReminderEmail(c, {
        ...pairReportEmailFacts(wire),
        to: seat.email,
        vendorId: row.ownerVendorId,
        vendorSlug: owner?.slug ?? null,
        vendorName: owner?.name ?? null,
        submitterVendorName: wire.submitter_name ?? 'A vendor',
        replyDueAt: row.protestReplyDueAt,
        dedupeKey: protestReminderKey(row.id, row.protestedAt, seat.profileId),
      });
      result.emails[outcome]++;
    }
  }
}
