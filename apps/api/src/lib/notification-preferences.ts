/**
 * Per-profile notification preferences (AECI-1204, AECI-1305, `DATABASE_SCHEMA.md` §9.10).
 *
 * Two settings, each with its own one-click token:
 *
 *   - mute the daily attestation nudge digest (`nudges_muted_at`, `mute_token`), per seat;
 *   - opt out of marketing email (`marketing_muted_at`, `marketing_mute_token`), per
 *     account. Today that covers `vendor-claim-nudge` alone.
 *
 * The row is created lazily the first time something needs it: a digest send (the sweep
 * needs the token for the footer link), a toggle, or a marketing send. The marketing
 * token is minted by the first marketing send. The two scopes never touch each other's
 * columns, so a nudge unmute, which rotates `mute_token`, leaves a marketing link working.
 *
 * **Every write is domain state and audited in its own batch.** A mute is a choice a
 * person made, so the change and its `audit_log` row commit together (§26.1). The
 * lazy create is audited too (`notification_preferences.created`): it is a new row
 * on a user-state table, and the test is entity class, not actor class.
 *
 * **The token is a capability.** It never appears in an audit row, a log line, or a
 * response body. Only an email's footer link and `List-Unsubscribe` header carry it.
 */

import type { AuditLogEntry, AuditLogActorType } from '@aeci/shared';
import type { VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { notificationPreferences } from '../db/schema';
import type { Db } from '../db/client';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';

/** `audit_log.action` for a mute or unmute. */
export const PREFERENCES_UPDATED_ACTION = 'notification_preferences.updated';

/** `audit_log.action` for the lazy create (token minted, nothing muted). */
export const PREFERENCES_CREATED_ACTION = 'notification_preferences.created';

/** `audit_log.entity_type` for both. The row is keyed by the profile. */
export const PREFERENCES_ENTITY_TYPE = 'profile';

/** Profile ids per read. D1 caps bound parameters per query. */
const LOOKUP_CHUNK = 50;

/** Inserts per lazy-create batch (each is two statements with its audit row). */
const CREATE_CHUNK = 25;

export interface NudgePreference {
  profileId: string;
  /** ISO-8601, or null when not muted. */
  nudgesMutedAt: string | null;
  muteToken: string;
}

/** Where a preference change came from, recorded on its audit row. */
export type PreferenceSource =
  | 'vendor-portal'
  | 'one-click'
  | 'attestation-digest'
  | 'vendor-claim-nudge';

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Existing rows for these profiles. A profile with no row is absent from the map:
 *  not muted, no token yet. */
export async function loadNudgePreferences(
  db: Db,
  profileIds: readonly string[],
): Promise<Map<string, NudgePreference>> {
  const out = new Map<string, NudgePreference>();
  for (const ids of chunk([...new Set(profileIds)], LOOKUP_CHUNK)) {
    const rows = await db
      .select({
        profileId: notificationPreferences.profileId,
        nudgesMutedAt: notificationPreferences.nudgesMutedAt,
        muteToken: notificationPreferences.muteToken,
      })
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.profileId, ids));
    for (const row of rows) out.set(row.profileId, row);
  }
  return out;
}

/** Whether a seat has muted nudges. No row is not muted. */
export function isNudgeMuted(pref: NudgePreference | undefined): boolean {
  return Boolean(pref?.nudgesMutedAt);
}

function createdEntry(profileId: string, source: PreferenceSource): AuditLogEntry {
  return {
    actorId: null,
    actorType: 'system',
    action: PREFERENCES_CREATED_ACTION,
    entityType: PREFERENCES_ENTITY_TYPE,
    entityId: profileId,
    metadata: { source, nudgesMuted: false },
  };
}

/**
 * Make sure every profile has a row, so the digest has a mute token to put in its
 * footer. Creates the missing rows (unmuted), each with its audit row in the same
 * batch, and returns the full set.
 *
 * Throws on a D1 failure. The sweep calls it before it sends anything, so a throw
 * aborts the run with nothing sent and nothing recorded, and the queue retries.
 */
export async function ensureNudgePreferences(
  db: Db,
  profileIds: readonly string[],
  source: PreferenceSource,
): Promise<{ prefs: Map<string, NudgePreference>; created: AuditLogEntry[] }> {
  const prefs = await loadNudgePreferences(db, profileIds);
  const missing = [...new Set(profileIds)].filter((id) => !prefs.has(id));
  const created: AuditLogEntry[] = [];
  for (const ids of chunk(missing, CREATE_CHUNK)) {
    const statements: BatchStmt[] = [];
    for (const profileId of ids) {
      const entry = createdEntry(profileId, source);
      statements.push(
        db
          .insert(notificationPreferences)
          .values({ profileId })
          // A concurrent toggle may have created it. Its token is as good as ours.
          .onConflictDoNothing({ target: notificationPreferences.profileId }),
        auditInsert(db, entry),
      );
      created.push(entry);
    }
    await db.batch(statements as BatchTuple);
  }
  if (missing.length === 0) return { prefs, created };
  const fresh = await loadNudgePreferences(db, missing);
  for (const [id, pref] of fresh) prefs.set(id, pref);
  return { prefs, created };
}

export interface SetNudgesMutedResult {
  /** The row after the write (or unchanged). Undefined when a seat with no row
   *  unmutes: no row reads as unmuted, so there is nothing to write. */
  pref: NudgePreference | undefined;
  /** The audit entries written, for the post-commit forward. Empty on a no-op. */
  entries: AuditLogEntry[];
}

/**
 * Set one seat's mute. Idempotent: setting the state it already has writes nothing
 * and keeps the original `nudges_muted_at`. A seat with no row reads as unmuted, so
 * unmuting it writes no row and no audit row.
 *
 * The preference write and its audit row go in ONE `db.batch`. When the row does
 * not exist yet, the insert is that write, and it mints the token.
 *
 * **Unmuting rotates the token.** Every digest already sent carries the old token
 * in its footer link and `List-Unsubscribe` header. Without a rotation, any one of
 * those old emails, or a mail scanner replaying its one-click POST, would silently
 * re-mute a seat that just chose to hear from us again. The new token is set in the
 * same `UPDATE`, so it commits with the audit row. Muting keeps the token: the link
 * the seat just used stays the valid one, and a repeat stays idempotent.
 */
export async function setNudgesMuted(
  db: Db,
  input: {
    profileId: string;
    muted: boolean;
    actorId: string | null;
    actorType: AuditLogActorType;
    source: PreferenceSource;
    now?: Date;
    /** The seat's vendor and plan, from a vendor session (AECI-1192 / AECI-1193).
     *  Absent on the one-click mute, which holds a token and no session. */
    vendorId?: string | null;
    vendorPlan?: VendorPlanSnapshot | null;
  },
): Promise<SetNudgesMutedResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const existing = (await loadNudgePreferences(db, [input.profileId])).get(input.profileId);
  const wasMuted = isNudgeMuted(existing);
  if (wasMuted === input.muted) return { pref: existing, entries: [] };

  const nudgesMutedAt = input.muted ? nowIso : null;
  const entry: AuditLogEntry = {
    actorId: input.actorId,
    actorType: input.actorType,
    action: PREFERENCES_UPDATED_ACTION,
    entityType: PREFERENCES_ENTITY_TYPE,
    entityId: input.profileId,
    vendorId: input.vendorId ?? null,
    vendorPlan: input.vendorPlan ?? null,
    beforeState: { nudgesMuted: wasMuted },
    afterState: { nudgesMuted: input.muted },
    metadata: { source: input.source },
  };

  const write = existing
    ? db
        .update(notificationPreferences)
        .set(
          input.muted
            ? { nudgesMutedAt, updatedAt: nowIso }
            : { nudgesMutedAt, updatedAt: nowIso, muteToken: crypto.randomUUID() },
        )
        .where(eq(notificationPreferences.profileId, input.profileId))
    : db
        .insert(notificationPreferences)
        .values({ profileId: input.profileId, nudgesMutedAt })
        .onConflictDoUpdate({
          target: notificationPreferences.profileId,
          set: { nudgesMutedAt, updatedAt: nowIso },
        });
  await db.batch([write, auditInsert(db, entry)]);

  const pref = (await loadNudgePreferences(db, [input.profileId])).get(input.profileId);
  if (!pref) throw new Error('notification_preferences row missing after write');
  return { pref, entries: [entry] };
}

/** The profile a mute token belongs to, with its current state. */
export async function findByMuteToken(db: Db, token: string): Promise<NudgePreference | null> {
  const [row] = await db
    .select({
      profileId: notificationPreferences.profileId,
      nudgesMutedAt: notificationPreferences.nudgesMutedAt,
      muteToken: notificationPreferences.muteToken,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.muteToken, token))
    .limit(1);
  return row ?? null;
}

// ─── Marketing opt-out (AECI-1305) ───────────────────────────────────────────

export interface MarketingPreference {
  profileId: string;
  /** ISO-8601, or null when not opted out. */
  marketingMutedAt: string | null;
  /** Null until the first marketing send mints it. */
  marketingMuteToken: string | null;
}

/** Existing rows for these profiles, marketing columns only. A profile with no row is
 *  absent from the map: not opted out, no token yet. */
export async function loadMarketingPreferences(
  db: Db,
  profileIds: readonly string[],
): Promise<Map<string, MarketingPreference>> {
  const out = new Map<string, MarketingPreference>();
  for (const ids of chunk([...new Set(profileIds)], LOOKUP_CHUNK)) {
    const rows = await db
      .select({
        profileId: notificationPreferences.profileId,
        marketingMutedAt: notificationPreferences.marketingMutedAt,
        marketingMuteToken: notificationPreferences.marketingMuteToken,
      })
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.profileId, ids));
    for (const row of rows) out.set(row.profileId, row);
  }
  return out;
}

/** Whether an account opted out of marketing email. No row is not opted out. */
export function isMarketingMuted(pref: MarketingPreference | undefined): boolean {
  return Boolean(pref?.marketingMutedAt);
}

/**
 * Make sure every profile has a row with a marketing token, so a marketing email has
 * an opt-out link for its footer and its `List-Unsubscribe` header. Two writes, each
 * with its audit row in the same batch:
 *
 *   - no row: insert one with a fresh marketing token (`notification_preferences.created`);
 *   - a row with no marketing token (a seat that already had a nudge row): set one
 *     (`notification_preferences.updated`). The `UPDATE` is guarded on the token being
 *     null, so a concurrent mint is never overwritten.
 *
 * Neither write touches `nudges_muted_at` or `mute_token`. Returns the full set and the
 * audit entries, for the post-commit forward.
 *
 * Throws on a D1 failure. The sweep calls it before it sends anything, so a throw
 * aborts the run with nothing sent, and the queue retries.
 */
export async function ensureMarketingPreferences(
  db: Db,
  profileIds: readonly string[],
  source: PreferenceSource,
  now: Date = new Date(),
): Promise<{ prefs: Map<string, MarketingPreference>; entries: AuditLogEntry[] }> {
  const unique = [...new Set(profileIds)];
  const entries: AuditLogEntry[] = [];
  const existing = await loadMarketingPreferences(db, unique);

  const missing = unique.filter((id) => !existing.has(id));
  for (const ids of chunk(missing, CREATE_CHUNK)) {
    const statements: BatchStmt[] = [];
    for (const profileId of ids) {
      const entry: AuditLogEntry = {
        actorId: null,
        actorType: 'system',
        action: PREFERENCES_CREATED_ACTION,
        entityType: PREFERENCES_ENTITY_TYPE,
        entityId: profileId,
        metadata: { source, nudgesMuted: false, marketingMuted: false },
      };
      statements.push(
        db
          .insert(notificationPreferences)
          .values({ profileId, marketingMuteToken: crypto.randomUUID() })
          // A concurrent toggle or digest may have created it. The pass below then
          // mints the marketing token on that row.
          .onConflictDoNothing({ target: notificationPreferences.profileId }),
        auditInsert(db, entry),
      );
      entries.push(entry);
    }
    await db.batch(statements as BatchTuple);
  }

  const afterCreate = missing.length === 0 ? existing : await loadMarketingPreferences(db, unique);
  const tokenless = unique.filter((id) => {
    const pref = afterCreate.get(id);
    return pref !== undefined && pref.marketingMuteToken === null;
  });
  const nowIso = now.toISOString();
  for (const ids of chunk(tokenless, CREATE_CHUNK)) {
    const statements: BatchStmt[] = [];
    for (const profileId of ids) {
      const entry: AuditLogEntry = {
        actorId: null,
        actorType: 'system',
        action: PREFERENCES_UPDATED_ACTION,
        entityType: PREFERENCES_ENTITY_TYPE,
        entityId: profileId,
        // About the account, not a vendor: the nudge goes to accounts with no vendor.
        vendorId: null,
        metadata: { source, marketingTokenMinted: true },
      };
      statements.push(
        db
          .update(notificationPreferences)
          .set({ marketingMuteToken: crypto.randomUUID(), updatedAt: nowIso })
          .where(
            and(
              eq(notificationPreferences.profileId, profileId),
              isNull(notificationPreferences.marketingMuteToken),
            ),
          ),
        auditInsert(db, entry),
      );
      entries.push(entry);
    }
    await db.batch(statements as BatchTuple);
  }

  if (entries.length === 0) return { prefs: existing, entries };
  return { prefs: await loadMarketingPreferences(db, unique), entries };
}

/**
 * Opt one account out of marketing email. Idempotent: a repeat writes nothing and keeps
 * the original `marketing_muted_at`. The row must exist: the only caller holds a
 * marketing token, and only an existing row has one.
 *
 * Mute only. There is no unmute surface yet (`/account` is out of AECI-1305's scope).
 * When one is built, it must rotate `marketing_mute_token`, for the reason
 * {@link setNudgesMuted} rotates `mute_token`.
 */
export async function setMarketingMuted(
  db: Db,
  input: {
    profileId: string;
    actorId: string | null;
    actorType: AuditLogActorType;
    source: PreferenceSource;
    now?: Date;
  },
): Promise<{ entries: AuditLogEntry[] }> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const existing = (await loadMarketingPreferences(db, [input.profileId])).get(input.profileId);
  if (!existing) throw new Error('notification_preferences row missing for a marketing mute');
  if (isMarketingMuted(existing)) return { entries: [] };

  const entry: AuditLogEntry = {
    actorId: input.actorId,
    actorType: input.actorType,
    action: PREFERENCES_UPDATED_ACTION,
    entityType: PREFERENCES_ENTITY_TYPE,
    entityId: input.profileId,
    // A marketing opt-out is about the account, never a vendor's listing, so no vendor
    // portal shows it. A seat's nudge mute is the vendor-scoped one.
    vendorId: null,
    beforeState: { marketingMuted: false },
    afterState: { marketingMuted: true },
    metadata: { source: input.source },
  };
  await db.batch([
    db
      .update(notificationPreferences)
      .set({ marketingMutedAt: nowIso, updatedAt: nowIso })
      .where(eq(notificationPreferences.profileId, input.profileId)),
    auditInsert(db, entry),
  ]);
  return { entries: [entry] };
}

/** The profile a marketing token belongs to, with its current state. */
export async function findByMarketingMuteToken(
  db: Db,
  token: string,
): Promise<MarketingPreference | null> {
  const [row] = await db
    .select({
      profileId: notificationPreferences.profileId,
      marketingMutedAt: notificationPreferences.marketingMutedAt,
      marketingMuteToken: notificationPreferences.marketingMuteToken,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.marketingMuteToken, token))
    .limit(1);
  return row ?? null;
}
