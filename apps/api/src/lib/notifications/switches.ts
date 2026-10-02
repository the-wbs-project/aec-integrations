/**
 * Operator sending switches (AECI-1224). Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.14
 * "Sending switches" and §13 D24, `docs/email.md` §Sending switches, `docs/DATABASE_SCHEMA.md`
 * §9.13.
 *
 * A switch pauses one email template, or the support copy, on one tier. The table is
 * `notification_settings`, keyed by the registry id or the reserved {@link SUPPORT_COPY_KEY}.
 * No row means enabled.
 *
 * ─── Three rules ──────────────────────────────────────────────────────────────
 *
 * **1. Protected mail can never be paused.** `pausable` on the registry entry decides. The
 * write route refuses to pause a non-pausable entry, and {@link readSendSwitches} ignores a
 * paused row for one too, so a row left over from before an entry became always-on cannot
 * stop it.
 *
 * **2. The read fails open.** A D1 error returns `available: false` and every key reads as
 * enabled, so the send goes ahead. Email is fail-open everywhere in `lib/email.ts`, and a
 * D1 hiccup must not drop a seat invite. The transport warns and counts it.
 *
 * **3. Every change audits in its batch.** A switch changes who receives mail, so it is
 * domain state (§26.1). The upsert and its `audit_log` row commit together, behind a
 * sentinel that aborts the batch if another tab moved the switch since it was read.
 *
 * Not the per-seat nudge mute: that is `notification_preferences` (AECI-1204), a seat's own
 * choice about one digest.
 */

import type { AuditLogActorType, AuditLogEntry } from '@aeci/shared/audit-log';
import { inArray, sql } from 'drizzle-orm';

import type { Db } from '../../db/client';
import { notificationSettings } from '../../db/schema';
import { auditInsert, type BatchStmt } from '../audit';
import { NOTIFICATIONS, type NotificationEntry } from './registry';

/** The reserved key for the `EMAIL_BCC` blind copy and the separate operator `COPY:`. No
 *  registry id may equal it (`registry.spec.ts`). */
export const SUPPORT_COPY_KEY = 'support-copy';

/** `audit_log.action` for a pause or a resume. */
export const SWITCH_UPDATED_ACTION = 'notification_settings.updated';

/** `audit_log.entity_type`. `entity_id` is the key. */
export const SWITCH_ENTITY_TYPE = 'notification_setting';

export type SwitchKind = 'notification' | 'support_copy';

type RegistryRecord = Readonly<Record<string, NotificationEntry>>;
const REGISTRY = NOTIFICATIONS as RegistryRecord;

function registryEntry(key: string): NotificationEntry | null {
  return Object.prototype.hasOwnProperty.call(REGISTRY, key) ? REGISTRY[key]! : null;
}

/** What a key names, or null when it names nothing the switches know. A registry id of any
 *  channel resolves, so the API can say "not pausable" rather than "not found" for it. */
export function resolveSwitchKey(
  key: string,
): { kind: SwitchKind; pausable: boolean; entry: NotificationEntry | null } | null {
  if (key === SUPPORT_COPY_KEY) return { kind: 'support_copy', pausable: true, entry: null };
  const entry = registryEntry(key);
  return entry ? { kind: 'notification', pausable: entry.pausable, entry } : null;
}

/** Whether a paused row for this key may take effect. */
export function isPausableKey(key: string): boolean {
  return resolveSwitchKey(key)?.pausable ?? false;
}

// ─── The transport's read ─────────────────────────────────────────────────────

/** The switches one send call needs. `available: false` means the read failed. */
export interface SendSwitches {
  available: boolean;
  isPaused(key: string): boolean;
}

const ALL_ON: SendSwitches = { available: true, isPaused: () => false };
const UNAVAILABLE: SendSwitches = { available: false, isPaused: () => false };

/**
 * Read the switches for one send call: ONE query over `keys`. Never throws. No DB (a bare
 * test env) reads as all enabled. A D1 error reads as all enabled with `available: false`,
 * so the caller sends and reports the failure. Not cached across calls: a pause must stop
 * the very next send.
 */
export async function readSendSwitches(
  db: Db | null,
  keys: readonly string[],
): Promise<SendSwitches> {
  if (!db || keys.length === 0) return ALL_ON;
  let rows: Array<{ key: string; enabled: boolean }>;
  try {
    rows = await db
      .select({ key: notificationSettings.key, enabled: notificationSettings.enabled })
      .from(notificationSettings)
      .where(inArray(notificationSettings.key, [...new Set(keys)]));
  } catch {
    return UNAVAILABLE;
  }
  const paused = new Set(rows.filter((r) => !r.enabled && isPausableKey(r.key)).map((r) => r.key));
  return { available: true, isPaused: (key) => paused.has(key) };
}

// ─── The admin read ───────────────────────────────────────────────────────────

export interface SwitchRow {
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

/** Every stored switch, by key. The table holds at most one row per switch, so it is small. */
export async function readSwitchRows(db: Db): Promise<Map<string, SwitchRow>> {
  const rows = await db
    .select({
      key: notificationSettings.key,
      enabled: notificationSettings.enabled,
      updatedAt: notificationSettings.updatedAt,
      updatedBy: notificationSettings.updatedBy,
    })
    .from(notificationSettings);
  return new Map(rows.map(({ key, ...rest }) => [key, rest]));
}

// ─── The write ────────────────────────────────────────────────────────────────

export interface SwitchWriteInput {
  key: string;
  /** The effective state the caller read. A missing row is `true`. */
  from: boolean;
  to: boolean;
  actorId: string;
  actorType: AuditLogActorType;
  tier: string;
  reason?: string;
  now: string;
}

/** The sentinel's abort token, matched by {@link isSwitchRaceError}. */
const RACE_TOKEN = 'notification-switch-changed';

/**
 * The batch for one change: the race sentinel, the upsert, the audit row. In that order:
 * the sentinel aborts the whole batch, audit row included, when the stored state is no
 * longer `from`.
 *
 * The sentinel uses the `json()` abort the other batch sentinels use (`connector-mapping-edit.ts`):
 * SQLite has no `RAISE()` outside triggers, so malformed JSON is the in-statement abort. It
 * reads from a one-row constant so it evaluates once whether or not the row exists.
 */
export function switchWriteStatements(
  db: Db,
  input: SwitchWriteInput,
): { stmts: BatchStmt[]; auditEntry: AuditLogEntry } {
  const auditEntry: AuditLogEntry = {
    actorId: input.actorId,
    actorType: input.actorType,
    action: SWITCH_UPDATED_ACTION,
    entityType: SWITCH_ENTITY_TYPE,
    entityId: input.key,
    beforeState: { enabled: input.from },
    afterState: { enabled: input.to },
    metadata: {
      source: 'admin-email-switches',
      tier: input.tier,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };

  const fromInt = input.from ? 1 : 0;
  const sentinel = db
    .select({
      guard: sql`CASE WHEN COALESCE((SELECT ${notificationSettings.enabled} FROM ${notificationSettings}
        WHERE ${notificationSettings.key} = ${input.key}), 1) <> ${fromInt}
        THEN json(${RACE_TOKEN}) END`,
    })
    .from(sql`(SELECT 1)`);

  const upsert = db
    .insert(notificationSettings)
    .values({
      key: input.key,
      enabled: input.to,
      updatedBy: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: notificationSettings.key,
      set: { enabled: input.to, updatedBy: input.actorId, updatedAt: input.now },
    });

  return { stmts: [sentinel, upsert, auditInsert(db, auditEntry)], auditEntry };
}

/** True when a batch failed because the sentinel fired. */
export function isSwitchRaceError(error: unknown): boolean {
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
