/**
 * Integration field contests: the rules both the vendor and the admin handlers
 * share (AECI-1008 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b).
 *
 * Four things live here so no handler re-derives them:
 *
 *   1. **Routing** — who decides a contest. {@link routeContest} is the one
 *      implementation, and {@link isIntegrationClaimed} (AECI-1005) its claim test.
 *   2. **The field ↔ column map**, and the two translations between the storage
 *      form of a value and the caller-relative wire form (`direction` only).
 *   3. **The vendor scoping predicate** ({@link vendorContestsWhere}), which
 *      `GET /api/vendor/contests` and the `contests` freshness cursor in
 *      `routes/vendor-updates.ts` both import. The cursor invariant
 *      (`STAGE_2_REALTIME_SPEC.md` §2.2) is that the two can never differ.
 *   4. **The notification row** ({@link contestNotificationAudit}): a
 *      `notification.sent` audit row addressed to the other side of a contest,
 *      which is how the event reaches the vendor feed with no new store.
 */

import {
  claimDirectionForContext,
  claimDirectionFromContext,
  orderedPairSlugs,
  type ClaimDirection,
  type ContestNotificationEvent,
  type ContestRoute,
  type ContextDirection,
  type IntegrationContestField,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrationFieldChallenges, integrations, vendors } from '../db/schema';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { isClaimed, ONE_ROW } from './integration-claims';

type IntegrationRow = typeof integrations.$inferSelect;

/** `audit_log.entity_type` for every row about a contest. `entity_type` is
 *  unconstrained, so this needs no migration. */
export const CONTEST_ENTITY_TYPE = 'integration_field_challenge';

/**
 * Is this integration CLAIMED, i.e. has its owner taken the row, so that it decides
 * contests on it?
 *
 * AECI-1005 replaced the stub that stood here (always `false`) with the real test:
 * `claimed_at IS NOT NULL`, via {@link isClaimed} in `lib/integration-claims.ts`,
 * which is the single definition. A claim is an act (the owner's own claim, or an
 * admin approval of an owner-unknown claim), and it is the same column that fences
 * promote, so an owner accept can no longer be reverted by the next promote of the
 * edge.
 *
 * It still takes the row rather than an id, and the submit handler still takes it
 * as an injectable predicate, so a spec can pin either route without seeding a claim.
 */
export function isIntegrationClaimed(
  integration: Pick<IntegrationRow, 'id' | 'builtByVendorId' | 'claimedAt'>,
): boolean {
  return isClaimed(integration);
}

export type IntegrationClaimedPredicate = typeof isIntegrationClaimed;

/**
 * Who decides a contest, fixed at submit (§11b).
 *
 * `owner` iff the integration is claimed, the field is not `owner`, and an owner
 * is on file. An `owner` contest ALWAYS routes to AECi: the owner cannot be the
 * judge of whether it is the owner.
 *
 * `ownerVendorId` is the `built_by_vendor_id` snapshot either way. On an
 * AECi-routed row it is informational (the admin screen shows who is on file).
 */
export function routeContest(
  integration: Pick<IntegrationRow, 'id' | 'builtByVendorId' | 'claimedAt'>,
  field: IntegrationContestField,
  claimed: IntegrationClaimedPredicate = isIntegrationClaimed,
): { routedTo: ContestRoute; ownerVendorId: string | null } {
  const ownerVendorId = integration.builtByVendorId ?? null;
  const routedTo: ContestRoute =
    claimed(integration) && field !== 'owner' && ownerVendorId !== null ? 'owner' : 'aeci';
  return { routedTo, ownerVendorId };
}

// ─── Field ↔ column ──────────────────────────────────────────────────────────

/** The `integrations` column each content field names. `owner` is absent on
 *  purpose: it maps to `built_by_vendor_id`, and no accept path ever writes it. */
export const CONTEST_FIELD_COLUMNS = {
  name: 'name',
  mechanism_kind: 'mechanismKind',
  mechanism_name: 'mechanismName',
  direction: 'direction',
  description: 'description',
  listing_url: 'listingUrl',
  docs_url: 'docsUrl',
  website: 'website',
  mechanism_url: 'mechanismUrl',
  pricing_model: 'pricingModel',
  maturity: 'maturity',
} as const satisfies Record<Exclude<IntegrationContestField, 'owner'>, keyof IntegrationRow>;

export type ContentContestField = keyof typeof CONTEST_FIELD_COLUMNS;

/** The field's value on the row, in STORAGE form. */
export function storedFieldValue(
  row: Pick<IntegrationRow, ContestColumn | 'builtByVendorId'>,
  field: IntegrationContestField,
): string | null {
  if (field === 'owner') return row.builtByVendorId ?? null;
  return row[CONTEST_FIELD_COLUMNS[field]] ?? null;
}

type ContestColumn = (typeof CONTEST_FIELD_COLUMNS)[ContentContestField];

/** Storage form → wire form. Only `direction` differs: it is re-framed against the
 *  caller's context product. An unknown stored direction passes through as-is
 *  rather than throwing, so one bad row cannot 500 a list. */
export function toWireValue(
  field: IntegrationContestField,
  stored: string | null,
  contextIsSource: boolean,
): string | null {
  if (field !== 'direction' || stored === null) return stored;
  if (stored !== 'a_to_b' && stored !== 'b_to_a' && stored !== 'both') return stored;
  return claimDirectionForContext(stored as ClaimDirection, contextIsSource);
}

/** Wire form → storage form. The caller has already passed
 *  `contestValueProblem`, so a `direction` here is a valid `ContextDirection`. */
export function toStorageValue(
  field: IntegrationContestField,
  wire: string | null,
  contextIsSource: boolean,
): string | null {
  if (field !== 'direction' || wire === null) return wire;
  return claimDirectionFromContext(wire as ContextDirection, contextIsSource);
}

// ─── Scoping ─────────────────────────────────────────────────────────────────

/** Contests the caller's vendor filed. */
export function submittedContestsWhere(vendorId: string): SQL {
  return eq(integrationFieldChallenges.submitterVendorId, vendorId);
}

/** Contests the caller's vendor decides: owner-routed, with it as the snapshot
 *  owner. An AECi-routed row naming the vendor as owner is NOT received — the
 *  vendor is not its decider, and an owner contest about it must not be shown to
 *  the party it disputes. */
export function receivedContestsWhere(vendorId: string): SQL {
  return and(
    eq(integrationFieldChallenges.routedTo, 'owner'),
    eq(integrationFieldChallenges.ownerVendorId, vendorId),
  ) as SQL;
}

/**
 * The whole vendor contest scope: submitted ∪ received.
 *
 * The scoping predicate of `GET /api/vendor/contests` AND of the `contests`
 * cursor on `GET /api/vendor/updates`. Import it; never restate it. A cursor that
 * scopes wider moves on a row the list will never show (and leaks that it
 * exists); one that scopes narrower never moves for a change the list would show.
 */
export function vendorContestsWhere(vendorId: string): SQL {
  return or(submittedContestsWhere(vendorId), receivedContestsWhere(vendorId)) as SQL;
}

// ─── The notification row ────────────────────────────────────────────────────

/** What a contest `notification.sent` row records. Read back by
 *  `routes/vendor-notifications.ts`. `vendorId` is the RECIPIENT, which is what
 *  the feed's `json_extract(metadata, '$.vendorId')` filter matches. */
export interface ContestNotificationMetadata {
  kind: 'contest';
  vendorId: string;
  contestId: string;
  integrationId: string;
  integrationName: string | null;
  field: IntegrationContestField;
  event: ContestNotificationEvent;
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row for one contest event, addressed to one vendor.
 *
 * Pushed into the SAME batch as the transition it announces, so a rolled-back
 * transition cannot leave a notification about something that never happened.
 * `actorId` is the person who caused the event (the row is not the sweep's), and
 * `entity_type` distinguishes it from the §7 detector rows, whose entity is a claim.
 */
export function contestNotificationAudit(
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<ContestNotificationMetadata, 'kind' | 'pairSlugs'> & {
    pairSlugs: readonly [string, string] | null;
  },
): AuditLogEntry {
  const full: ContestNotificationMetadata = {
    kind: 'contest',
    ...metadata,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: CONTEST_ENTITY_TYPE,
    entityId: metadata.contestId,
    metadata: full,
  };
}

/** The canonical pair page for two slugs, or `null` when either is missing. */
export function pairPathFor(pairSlugs: readonly [string, string] | null): string | null {
  if (!pairSlugs) return null;
  const [a, b] = orderedPairSlugs(pairSlugs[0], pairSlugs[1]);
  return `/products/${a}/integrations/${b}`;
}

// ─── Hydration (shared by the vendor and admin reads) ────────────────────────

export type ContestRow = typeof integrationFieldChallenges.$inferSelect;

interface HydratedProduct {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}

export interface ContestIntegrationContext {
  id: string;
  name: string | null;
  sourceProduct: HydratedProduct;
  targetProduct: HydratedProduct;
}

export interface ContestHydration {
  integrations: Map<string, ContestIntegrationContext>;
  vendorNames: Map<string, string>;
}

/**
 * Everything a list of contest rows needs to render, in two reads: the
 * integrations (with both endpoint products) and the vendor names — submitter,
 * owner, and the vendor ids an `owner` contest carries as its values.
 */
export async function hydrateContests(
  db: Db,
  rows: readonly ContestRow[],
): Promise<ContestHydration> {
  const integrationIds = [...new Set(rows.map((r) => r.integrationId))];
  const vendorIds = [
    ...new Set(
      rows.flatMap((r) =>
        [
          r.submitterVendorId,
          r.ownerVendorId,
          ...(r.field === 'owner' ? [r.currentValue, r.proposedValue] : []),
        ].filter((v): v is string => typeof v === 'string'),
      ),
    ),
  ];
  const [integrationRows, vendorRows] = await Promise.all([
    integrationIds.length === 0
      ? Promise.resolve([])
      : db.query.integrations.findMany({
          columns: { id: true, name: true },
          with: {
            sourceProduct: { columns: { id: true, name: true, slug: true, logoUrl: true } },
            targetProduct: { columns: { id: true, name: true, slug: true, logoUrl: true } },
          },
          where: inArray(integrations.id, integrationIds),
        }),
    vendorIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: vendors.id, name: vendors.companyName })
          .from(vendors)
          .where(inArray(vendors.id, vendorIds)),
  ]);
  return {
    integrations: new Map(integrationRows.map((row) => [row.id, row])),
    vendorNames: new Map(vendorRows.map((row) => [row.id, row.name])),
  };
}

/** The display label for a value: a vendor name for `owner`, `null` otherwise. */
export function contestValueLabel(
  field: string,
  value: string | null,
  vendorNames: ReadonlyMap<string, string>,
): string | null {
  if (field !== 'owner' || value === null) return null;
  return vendorNames.get(value) ?? null;
}

// ─── The decision-race sentinel ──────────────────────────────────────────────

/**
 * A batch statement that ABORTS the batch when the statement before it changed
 * zero rows. Push it immediately after a contest's guarded
 * `UPDATE … WHERE status = 'open'`, and push every other statement after it.
 *
 * Why it exists: D1 has no interactive transactions, so a batch cannot branch on
 * whether its guarded UPDATE matched. Without this, the loser of a decision race
 * (two deciders, or a decision against a withdraw) still committed its audit row,
 * its workflow transition, the owner-accept catalog write, and — the real harm — a
 * `notification.sent` row telling the other side "declined" about a contest that
 * was in fact accepted.
 *
 * How: `changes()` is SQLite's row count for the most recent INSERT/UPDATE/DELETE
 * on the connection, which inside a batch is the guarded UPDATE. When it is 0 the
 * `CASE` evaluates `json('contest-not-open')`, which is malformed JSON and raises,
 * rolling the whole batch back. SQLite has no `RAISE()` outside triggers, so a
 * deliberate function error is the only in-statement abort available. It is a
 * Drizzle SELECT builder (not `db.run(sql…)`) so the D1 batch and the test
 * harness's shim both accept it. It selects FROM the contest's own row, which
 * always exists at this point, so the expression is evaluated exactly once.
 *
 * {@link isContestRaceError} recognises the resulting error; nothing else in a
 * contest batch calls `json()`, so the match is unambiguous.
 */
export function contestStillOpenSentinel(db: Db, _contestId: string) {
  // FROM a one-row constant, NOT from the contest's own row (AECI-1005 review). If
  // the row is gone (its integration was deleted and the FK cascaded), a
  // `FROM integration_field_challenges WHERE id = ?` returns zero rows, the CASE is
  // never evaluated, and the batch sails on writing audit rows about a contest that
  // no longer exists. A constant row always evaluates the guard exactly once.
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('contest-not-open') END` })
    .from(ONE_ROW);
}

/**
 * A batch statement that ABORTS an admin accept when the integration's ownership
 * state moved after the handler read it (AECI-1005). What an AECi accept writes
 * depends on that state (`claimed_at` decides whether the value is applied here,
 * `built_by_vendor_id` whether an owner accept is a reassignment), so a claim or an
 * owner change landing between the read and the batch must not be decided on stale
 * facts. Same `json()` abort as {@link contestStillOpenSentinel}; the handler tells
 * the two apart by re-reading the contest, which is still `open` only in this case.
 */
export function contestIntegrationStateSentinel(
  db: Db,
  integrationId: string,
  expected: { claimed: boolean; ownerVendorId: string | null },
) {
  // Raises when the row is GONE as well as when it moved (AECI-1005 review): a
  // promote cross-table move deletes an unclaimed row, and a guard that reads
  // `FROM integrations WHERE id = ?` would return zero rows and pass silently.
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM "integrations" WHERE "id" = ${integrationId})
        OR EXISTS (SELECT 1 FROM "integrations" WHERE "id" = ${integrationId}
          AND (("claimed_at" IS NOT NULL) <> ${expected.claimed ? 1 : 0}
            OR ifnull("built_by_vendor_id", '') <> ${expected.ownerVendorId ?? ''}))
        THEN json('contest-integration-changed') END`,
    })
    .from(ONE_ROW);
}

/** True for the error {@link contestStillOpenSentinel} raises, in D1 or SQLite. */
export function isContestRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (/malformed JSON/i.test(String((current as { message?: unknown }).message ?? current))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
