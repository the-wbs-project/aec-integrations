/**
 * The term-end lapse (AECI-1404, E6.1; `docs/VENDOR_SIGNUP_PROCESS.md` §3 steps 9 and
 * 10, decision 14; `docs/STAGE_2_PAID_TIERS_SPEC.md` §7). A license whose term has
 * passed ends on its own: `ended_at` is stamped, the product drops to Free, and the
 * Managed fields are handed back to AECi (decision 14). The hand-back itself writes
 * nothing here: promote checks for a live license when it writes (ruled 2026-10-19).
 *
 * ── WHERE IT RUNS ───────────────────────────────────────────────────────────────
 * A pre-step of the 11:00 `entitlement_expiry` job (`runEntitlementExpiryJob` in
 * `scheduled.ts`), before the 30-day warning sweep. So a lapsed term is never warned,
 * and there is no new cron, job key or liveness entry. Queue-less and inline: this
 * job WRITES, and a queue retry would replay a run against state it already changed.
 * The scan is the fence. A term that committed has no live license left, so a re-run
 * cannot select it again.
 *
 * ── THE SCAN ────────────────────────────────────────────────────────────────────
 * `ended_at IS NULL AND ends_at IS NOT NULL AND ends_at <= now`, exactly the
 * predicate of the partial index `licenses_ends_idx`, grouped by
 * `(billing_account_id, ends_at)`: one TERM. `ends_at <= now` is the same rule as
 * `termHasEnded` in `@aeci/shared/entitlements`. A date-only end is stored as
 * 00:00Z of that day (`toIsoTimestamp`), so the end day counts as ended from 00:00Z
 * and the 11:00 run on that day ends it. Monthly licenses (`ends_at` NULL) never
 * lapse. The cap counts terms, not licenses ({@link EXPIRY_BATCH_CAP} per run, the
 * warning sweep's backstop). A capped run logs and counts
 * {@link LAPSE_CAPPED_METRIC}, and the rest lapse tomorrow.
 *
 * ── ONE BATCH PER TERM ──────────────────────────────────────────────────────────
 * `lapseTermStatements` in `lib/license.ts` (the one license writer): the end
 * UPDATEs, one audit row per license, one mirror reconcile. Each license UPDATE is
 * guarded on `ended_at IS NULL` and the scanned `ends_at`, and followed here by a
 * `changedOneRowSentinel`. So an admin extend or revoke that commits between the read
 * and the batch matches no row, the sentinel rolls the whole term back, and the admin
 * write wins. A term is never half-ended. The rolled-back term is rebuilt once from a
 * fresh read (below), and a second roll-back counts as a batch failure, read again
 * tomorrow.
 *
 * ── THE LAST LIVE LICENSE RE-ROUTES CONTESTS (ruled 2026-10-19) ────────────────
 * A term whose end leaves the vendor no live license also moves the vendor's open
 * owner-routed contests on connector-powered rows to AECi, in the same batch, exactly
 * as the admin revoke does (`planLastLicenseReroute`, ruling B,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13). The actor is the system. "Last" is read
 * from the license rows: a carried product's pool license is live, and so is a
 * license on another term that has passed but not lapsed yet (the run reaches that
 * term next and re-routes then). The guards are the revoke's: the plan's own and
 * `noLiveLicenseSentinel` with a re-route, `liveLicenseRemainsSentinel` without one.
 * The re-route sends nothing after commit, because the revoke's re-route sends nothing
 * either. Its audit rows join the run's one forward.
 *
 * Any abort in a term batch (a license sentinel or a re-route guard) sends the term
 * back to a fresh read and a rebuilt batch ONCE, as the revoke does. The rebuild
 * follows the fresh rows: an extended license is off the term, and a grant drops the
 * re-route. A second abort counts as a batch failure.
 *
 * ── FEWER LICENSES THAN PRODUCTS (AECI-1405, decision 12) ───────────────────────
 * In the same batch, after the ends, a product on a lapsing license moves onto a live,
 * unassigned license of the same billing account that does not end by now, the
 * products assigned longest first (`carryOverStatements`). A product flagged
 * release-at-renewal or cancel-at-term-end never moves. Nor does one that
 * {@link loadNoCarry} finds held by another live license, or no longer owned by the
 * vendor. A carried product stays Managed, so it gets no email and no purge. The
 * products left over drop to Free, and their email says the vendor had fewer licenses
 * than products. The assigns ride the same race sentinels: a pool license assigned
 * by the vendor since the read rolls the term back.
 *
 * ── AFTER COMMIT, ONCE PER RUN ──────────────────────────────────────────────────
 *  - ONE purge message on `CACHE_PURGE_QUEUE`, source `'moderation'` (the source every
 *    license path uses): `product:{slug}` for every product that dropped to Free,
 *    `index:products`, and `vendorPurgeTags` for every vendor whose term dropped a
 *    product or flipped `vendors.verified`. No Algolia sync: records do not carry
 *    `verified` (AECI-1266) or a plan.
 *  - ONE `forwardAuditBatch` with every committed audit row.
 *  - `managed-ended` emails, one per term and cause: products that lapsed and products
 *    released at renewal go in separate emails. To every unbanned seat and the billing
 *    email, each address once (`lib/billing-recipients.ts`). Keyed
 *    `managed-ended:term:{billingAccountId}:{endsAt}:{cause}:{recipient hash}`. Sends run
 *    one at a time, because a Worker holds about six connections. A pool license
 *    changes no product's plan, so it gets no email.
 *
 * Nothing after commit throws: the licenses have ended whatever happens to a send.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { CACHE_PURGE_QUEUE_MAX_TAGS } from '@aeci/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';

import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { loadBillingEmails, mergeRecipientAddresses } from './billing-recipients';
import type { EmailContext, EmailOutcome, sendManagedEndedEmail } from './email';
import { EXPIRY_BATCH_CAP } from './entitlement-expiry';
import { recipientHash } from './hash';
import { planLastLicenseReroute, type LastLicenseReroutePlan } from './integration-contests';
import {
  lapseTermStatements,
  loadVendorLicenses,
  type LapseTermBatch,
  type LicenseBefore,
} from './license';
import { changedOneRowSentinel, isReleaseRaceError } from './license-release-requests';
import { forwardAuditBatch } from './moderation-forward';
import { fetchAuthUserEmails } from './supabase-admin';
import { vendorPurgeTags } from './vendor-cache-tags';
import { loadVendorSeatRecipients, type FetchSeatEmails } from './vendor-seat-recipients';
import type { Db } from '../db/client';
import { billingAccounts, licenses, productVendors, products, vendors } from '../db/schema';
import { logBatchToPosthog, logToPosthog, type PosthogLogEvent } from '../posthog';

/** `metadata.source` on every audit row, and the log source. */
export const LAPSE_AUDIT_SOURCE = 'license-lapse-cron';

/** Every lapse write is the system's: no admin acts. */
const LAPSE_ACTOR = { actorId: null, actorType: 'system' } as const;

/** Counted when a run hits the term cap. The value is the terms left for tomorrow
 *  that the run could see (at least one). */
export const LAPSE_CAPPED_METRIC = 'aeci.license.lapse.capped';

/** Product ids per name read. D1 caps bound parameters per query. */
const PRODUCT_READ_CHUNK = 50;

/** The `managed-ended` sender (`lib/email.ts`), injected so specs never touch Resend. */
export type SendManagedEnded = typeof sendManagedEndedEmail;

/** Absent sender: nothing is sent and every notice reports `skipped`. */
const noopSendEnded: SendManagedEnded = async () => 'skipped';

/** The slice of the metric client this module needs. */
export interface LapseMetricSink {
  count(metric: string, value: number, tags: string[]): void;
}

export interface LapseDeps {
  /** Deterministic clock. */
  now?: Date;
  /** Terms per run. Defaults to {@link EXPIRY_BATCH_CAP}. */
  termCap?: number;
  /** The privileged `auth.users` email seam. Injected so specs never touch it. */
  fetchSeatEmails?: FetchSeatEmails;
  sendEnded?: SendManagedEnded;
  metrics?: LapseMetricSink;
}

export interface LapseResult {
  /** Terms that committed. */
  lapsedTerms: number;
  /** Licenses those terms ended, `lapsed` and `released` together. */
  lapsedLicenses: number;
  /** Products moved onto a pool license at term end (decision 12, AECI-1405). */
  carried: number;
  /** Products that left Managed. */
  droppedProducts: number;
  /** Terms the cap left for tomorrow (at least this many). */
  capped: number;
  /** Term batches that rolled back twice, or hit a D1 error. Read again tomorrow. */
  batchFailures: number;
  /** Open owner-routed contests moved to AECi because a term ended the vendor's last
   *  live license (ruling B, §11b.13). */
  reroutedContests: number;
  /** One outcome per address per notice. */
  emails: Record<EmailOutcome, number>;
}

/** One term to end: one billing account's live licenses on one passed `ends_at`. */
interface LapsingTerm {
  billingAccountId: string;
  vendorId: string;
  vendorSlug: string;
  vendorName: string;
  endsAt: string;
}

/** One `managed-ended` email to send: one term, one cause. */
interface PendingNotice {
  term: LapsingTerm;
  cause: 'lapsed' | 'released';
  productIds: string[];
  /** Some products dropped because the pool ran short (decision 12). */
  fewerLicenses: boolean;
}

/** The ledger key of one term-end `managed-ended` email to one address. */
export async function managedEndedTermDedupeKey(
  billingAccountId: string,
  endsAt: string,
  cause: 'lapsed' | 'released',
  address: string,
): Promise<string> {
  return `managed-ended:term:${billingAccountId}:${endsAt}:${cause}:${await recipientHash(address)}`;
}

/** Terms whose end has passed, oldest first. At most `limit`. */
async function loadLapsingTerms(db: Db, nowIso: string, limit: number): Promise<LapsingTerm[]> {
  const rows = await db
    .select({
      billingAccountId: licenses.billingAccountId,
      vendorId: billingAccounts.vendorId,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
      endsAt: licenses.endsAt,
    })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .innerJoin(vendors, eq(vendors.id, billingAccounts.vendorId))
    .where(
      and(
        // `licenses_ends_idx`'s predicate, so the planner can use it.
        isNull(licenses.endedAt),
        isNotNull(licenses.endsAt),
        lte(licenses.endsAt, nowIso),
      ),
    )
    .groupBy(
      licenses.billingAccountId,
      licenses.endsAt,
      billingAccounts.vendorId,
      vendors.slug,
      vendors.companyName,
    )
    .orderBy(asc(licenses.endsAt), asc(licenses.billingAccountId))
    .limit(limit);
  return rows.map((r) => ({ ...r, endsAt: r.endsAt as string }));
}

/** Slug and name per product id. */
async function loadProductNames(
  db: Db,
  productIds: readonly string[],
): Promise<Map<string, { slug: string; name: string }>> {
  const unique = [...new Set(productIds)];
  const out = new Map<string, { slug: string; name: string }>();
  for (let i = 0; i < unique.length; i += PRODUCT_READ_CHUNK) {
    const rows = await db
      .select({ id: products.id, slug: products.slug, name: products.name })
      .from(products)
      .where(inArray(products.id, unique.slice(i, i + PRODUCT_READ_CHUNK)));
    for (const r of rows) out.set(r.id, { slug: r.slug, name: r.name });
  }
  return out;
}

/**
 * The carry-over pre-check (AECI-1405): of the products on this term's licenses, the
 * ones that must not move onto a pool license. A product another live license holds
 * (any account, so a co-owned product its other vendor licenses), or one the vendor no
 * longer owns. Reads nothing when the account has no live unassigned license, because
 * then nothing can carry.
 */
async function loadNoCarry(
  db: Db,
  term: LapsingTerm,
  vendorLicenses: readonly LicenseBefore[],
): Promise<Set<string>> {
  const onAccount = vendorLicenses.filter(
    (l) => l.billingAccountId === term.billingAccountId && l.endedAt === null,
  );
  if (!onAccount.some((l) => l.assignedProductId === null)) return new Set();
  const termLicenseIds = new Set(
    onAccount.filter((l) => l.endsAt === term.endsAt).map((l) => l.id),
  );
  const productIds = [
    ...new Set(
      onAccount
        .filter((l) => termLicenseIds.has(l.id))
        .map((l) => l.assignedProductId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const blocked = new Set<string>();
  const owned = new Set<string>();
  for (let i = 0; i < productIds.length; i += PRODUCT_READ_CHUNK) {
    const ids = productIds.slice(i, i + PRODUCT_READ_CHUNK);
    const [ownedRows, liveRows] = await Promise.all([
      db
        .select({ productId: productVendors.productId })
        .from(productVendors)
        .where(
          and(eq(productVendors.vendorId, term.vendorId), inArray(productVendors.productId, ids)),
        ),
      db
        .select({ id: licenses.id, productId: licenses.assignedProductId })
        .from(licenses)
        .where(and(isNull(licenses.endedAt), inArray(licenses.assignedProductId, ids))),
    ]);
    for (const r of ownedRows) owned.add(r.productId);
    for (const r of liveRows) {
      if (r.productId && !termLicenseIds.has(r.id)) blocked.add(r.productId);
    }
  }
  for (const id of productIds) if (!owned.has(id)) blocked.add(id);
  return blocked;
}

/**
 * The term batch with a `changedOneRowSentinel` after every license UPDATE. The builder
 * puts one license statement per audit entry first (`assemble` in `lib/license.ts`), so
 * the first `auditEntries.length` statements are the license writes.
 */
function withRaceSentinels(db: Db, batch: LapseTermBatch): BatchStmt[] {
  const n = batch.auditEntries.length;
  const out: BatchStmt[] = [];
  for (const stmt of batch.stmts.slice(0, n)) out.push(stmt, changedOneRowSentinel(db));
  out.push(...batch.stmts.slice(n));
  return out;
}

function emptyOutcomes(): Record<EmailOutcome, number> {
  return { sent: 0, failed: 0, unknown: 0, skipped: 0, suppressed: 0, duplicate: 0, paused: 0 };
}

/**
 * Run one lapse pass: scan, end each term in its own batch, then purge, forward and
 * email once. Throws only on a failed scan read. A failed term batch is counted and
 * logged, never thrown.
 */
export async function runLicenseLapse(
  c: EmailContext,
  db: Db,
  deps: LapseDeps = {},
): Promise<LapseResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const cap = deps.termCap ?? EXPIRY_BATCH_CAP;
  const fetchSeatEmails = deps.fetchSeatEmails ?? fetchAuthUserEmails;
  const sendEnded = deps.sendEnded ?? noopSendEnded;

  const result: LapseResult = {
    lapsedTerms: 0,
    lapsedLicenses: 0,
    carried: 0,
    droppedProducts: 0,
    capped: 0,
    batchFailures: 0,
    reroutedContests: 0,
    emails: emptyOutcomes(),
  };

  // One over the cap, so "there was more" shows without a second query.
  const scanned = await loadLapsingTerms(db, nowIso, cap + 1);
  const terms = scanned.slice(0, cap);
  result.capped = scanned.length - terms.length;
  if (result.capped > 0) {
    deps.metrics?.count(LAPSE_CAPPED_METRIC, result.capped, []);
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `aeci.license.lapse.capped cap=${cap}`,
      source: LAPSE_AUDIT_SOURCE,
    });
  }
  if (terms.length === 0) return result;

  const audits: AuditLogEntry[] = [];
  const failures: PosthogLogEvent[] = [];
  const notices: PendingNotice[] = [];
  const purgeVendors = new Map<string, { id: string; slug: string; verified: boolean }>();
  const droppedProductIds: string[] = [];

  // One term at a time, each from a fresh read: two terms of one vendor must each see
  // what the other committed (the plan snapshot, the mirror prediction).
  for (const term of terms) {
    let batch: LapseTermBatch | null;
    let reroute: LastLicenseReroutePlan['reroute'] = null;
    let wasVerified: boolean;
    // The reads sit inside the catch too: a D1 error on one term must not end the run
    // before the terms already committed are forwarded, purged and emailed.
    try {
      // At most two attempts, as the revoke does: a guard that trips sends the term
      // back to a fresh read and a rebuilt batch once. A second abort is a failure,
      // and the term is read again tomorrow.
      for (let attempt = 1; ; attempt++) {
        const [vendorLicenses, vendorRow] = await Promise.all([
          loadVendorLicenses(db, term.vendorId),
          db.query.vendors.findFirst({
            columns: { verified: true },
            where: eq(vendors.id, term.vendorId),
          }),
        ]);
        wasVerified = vendorRow?.verified ?? false;
        batch = lapseTermStatements(db, {
          vendorId: term.vendorId,
          now: nowIso,
          ...LAPSE_ACTOR,
          vendorLicenses,
          vendorWasVerified: wasVerified,
          source: LAPSE_AUDIT_SOURCE,
          extraMetadata: { ends_at: term.endsAt },
          billingAccountId: term.billingAccountId,
          endsAt: term.endsAt,
          noCarryProductIds: await loadNoCarry(db, term, vendorLicenses),
        });
        // Nothing live on the term any more: an admin write since the scan.
        if (batch.ended.length === 0) {
          batch = null;
          break;
        }
        // Ruling B (§11b.13): the term's end leaves the vendor no live license, so its
        // open owner-routed contests on connector-powered rows move to AECi here.
        const plan = await planLastLicenseReroute(db, {
          vendorId: term.vendorId,
          actor: LAPSE_ACTOR,
          now: nowIso,
          vendorLicenses,
          endingLicenseIds: new Set(batch.ended.map((e) => e.licenseId)),
          extra: {
            source: LAPSE_AUDIT_SOURCE,
            billing_account_id: term.billingAccountId,
            ends_at: term.endsAt,
          },
        });
        reroute = plan.reroute;
        try {
          await db.batch([
            ...withRaceSentinels(db, batch),
            ...(plan.remainsGuard ? [plan.remainsGuard] : []),
            ...(reroute?.stmts ?? []),
            ...(reroute?.audits ?? []).map((entry) => auditInsert(db, entry)),
          ] as BatchTuple);
          break;
        } catch (error) {
          // The license, contest and live-license sentinels all raise the same
          // malformed-JSON abort, so the fresh read tells them apart.
          if (attempt >= 2 || !isReleaseRaceError(error)) throw error;
        }
      }
      if (!batch) continue;
    } catch (error) {
      result.batchFailures++;
      failures.push({
        level: isReleaseRaceError(error) ? 'warn' : 'error',
        message: isReleaseRaceError(error)
          ? 'aeci.license.lapse.term_raced'
          : 'aeci.license.lapse.batch_failed',
        source: LAPSE_AUDIT_SOURCE,
        vendor_id: term.vendorId,
        billing_account_id: term.billingAccountId,
        ends_at: term.endsAt,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    result.lapsedTerms++;
    result.lapsedLicenses += batch.ended.length;
    result.carried += batch.carried.length;
    result.reroutedContests += reroute?.rerouted ?? 0;
    audits.push(...batch.auditEntries, ...(reroute?.audits ?? []));

    // A carried product stays on Managed: no email and no purge for it.
    const carried = new Set(batch.carried.map((c) => c.productId));
    const byCause = { lapsed: [] as string[], released: [] as string[] };
    for (const e of batch.ended) {
      if (e.productId && !carried.has(e.productId)) byCause[e.cause].push(e.productId);
    }
    for (const cause of ['lapsed', 'released'] as const) {
      if (byCause[cause].length === 0) continue;
      notices.push({
        term,
        cause,
        productIds: byCause[cause],
        fewerLicenses: cause === 'lapsed' && batch.fewerLicenses,
      });
      droppedProductIds.push(...byCause[cause]);
    }
    if (byCause.lapsed.length + byCause.released.length > 0 || batch.verifiedFlipped) {
      purgeVendors.set(term.vendorId, {
        id: term.vendorId,
        slug: term.vendorSlug,
        verified: wasVerified,
      });
    }
  }
  result.droppedProducts = droppedProductIds.length;

  // §26.5 forward: every committed row in ONE request (AECI-1112).
  forwardAuditBatch(c, audits, [], LAPSE_AUDIT_SOURCE);
  if (failures.length > 0) logBatchToPosthog(c.executionCtx, c.env, c.req.raw, failures);

  let names = new Map<string, { slug: string; name: string }>();
  try {
    names = await loadProductNames(db, droppedProductIds);
  } catch (error) {
    // The purge then covers the vendor sets alone, and the emails skip the products
    // they cannot name rather than print an id.
    warn(c, 'aeci.license.lapse.product_read_failed', error);
  }
  try {
    await purge(c, db, droppedProductIds, names, [...purgeVendors.values()]);
  } catch (error) {
    warn(c, 'aeci.license.lapse.purge_failed', error);
  }

  try {
    await sendNotices(c, db, notices, names, fetchSeatEmails, sendEnded, result);
  } catch (error) {
    warn(c, 'aeci.license.lapse.email_failed', error);
  }

  return result;
}

function warn(c: EmailContext, message: string, error: unknown): void {
  logToPosthog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message,
    source: LAPSE_AUDIT_SOURCE,
    reason: error instanceof Error ? error.message : String(error),
  });
}

/** ONE purge message for the run (more only past `CACHE_PURGE_QUEUE_MAX_TAGS`). */
async function purge(
  c: EmailContext,
  db: Db,
  droppedProductIds: readonly string[],
  names: ReadonlyMap<string, { slug: string; name: string }>,
  purgeVendors: readonly { id: string; slug: string; verified: boolean }[],
): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue) return;
  const tags = new Set<string>();
  for (const id of droppedProductIds) {
    const slug = names.get(id)?.slug;
    if (slug) tags.add(`product:${slug}`);
  }
  if (droppedProductIds.length > 0) tags.add('index:products');
  for (const vendor of purgeVendors) {
    for (const tag of await vendorPurgeTags(db, vendor)) tags.add(tag);
  }
  if (tags.size === 0) return;
  const all = [...tags];
  const bodies: { body: { tags: string[]; source: 'moderation' } }[] = [];
  for (let i = 0; i < all.length; i += CACHE_PURGE_QUEUE_MAX_TAGS) {
    bodies.push({
      body: { tags: all.slice(i, i + CACHE_PURGE_QUEUE_MAX_TAGS), source: 'moderation' },
    });
  }
  await queue.sendBatch(bodies);
}

/** Every notice, one address at a time. Records one outcome per send. */
async function sendNotices(
  c: EmailContext,
  db: Db,
  notices: readonly PendingNotice[],
  names: ReadonlyMap<string, { slug: string; name: string }>,
  fetchSeatEmails: FetchSeatEmails,
  sendEnded: SendManagedEnded,
  result: LapseResult,
): Promise<void> {
  if (notices.length === 0) return;
  const vendorIds = notices.map((n) => n.term.vendorId);
  const [seats, billingEmails] = await Promise.all([
    loadVendorSeatRecipients(db, c.env, vendorIds, fetchSeatEmails),
    loadBillingEmails(
      db,
      notices.map((n) => n.term.billingAccountId),
    ),
  ]);

  for (const notice of notices) {
    const { term } = notice;
    const addresses = mergeRecipientAddresses(
      (seats.get(term.vendorId) ?? []).map((s) => s.email),
      billingEmails.get(term.billingAccountId),
    );
    // A product with no row to name it (deleted, or the read failed) is left out: the
    // email must never print an id.
    const productList = notice.productIds.flatMap((id) => {
      const named = names.get(id);
      return named ? [named] : [];
    });
    if (addresses.length === 0 || productList.length === 0) {
      result.emails.skipped++;
      continue;
    }
    for (const to of addresses) {
      const outcome = await sendEnded(c, {
        to,
        vendorName: term.vendorName,
        products: productList,
        cause: notice.cause,
        reason: null,
        fewerLicenses: notice.fewerLicenses,
        dedupeKey: await managedEndedTermDedupeKey(
          term.billingAccountId,
          term.endsAt,
          notice.cause,
          to,
        ),
        entity: { type: 'billing_account', id: term.billingAccountId },
      });
      result.emails[outcome]++;
    }
  }
}
