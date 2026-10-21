/**
 * Pending claim and listing confirmations (AECI-1435, ADR 0043).
 *
 * An anonymous claim or typed-in listing request is not a request yet. The submit
 * validates it, resolves its target, and parks it in `request_confirmations` with a
 * hashed single-use token. The `claim-confirm` email carries the token. A click on
 * `/claims/confirm` POSTs it to `POST /api/requests/confirm`, which runs the same
 * submit code a signed-in claimant gets, with the pending row's id as the request id.
 *
 * This module holds the pieces both ends share: the token, the pending row and its
 * audit row, the confirmed-row update, and the daily expiry sweep. Two functions run
 * their own batch: `createPendingConfirmation` (the submit's only write) and the sweep.
 * The confirm appends `confirmedStatements` to the request's own batch.
 *
 * **What the audit rows carry.** They are forwarded to PostHog, so they carry the
 * kind and the target, never the email, the token or its hash.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  REQUEST_CONFIRMATION_DAYS,
  type RequestConfirmationKind,
} from '@aeci/shared';
import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import { requestConfirmations } from '../db/schema';
import { acceptanceRequestEvidence, type AcceptanceRequestEvidence } from './agreement-acceptances';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { sendClaimConfirmEmail, type ClaimConfirmSubject, type EmailContext } from './email';
import { sha256Hex } from './hash';
import { forwardAuditBatch, type ForwardContext } from './moderation-forward';

/** How long the emailed link works. Ruled 2026-10-21 (Chris). The shared constant. */
export { REQUEST_CONFIRMATION_DAYS };

/** Most rows one expiry run deletes. A backstop: the next daily run continues. */
export const REQUEST_CONFIRMATION_EXPIRY_CAP = 500;

export const REQUEST_CONFIRMATION_ENTITY_TYPE = 'request_confirmation';
export const REQUEST_CONFIRMATION_CREATED_ACTION = 'request_confirmation.created';
export const REQUEST_CONFIRMATION_CONFIRMED_ACTION = 'request_confirmation.confirmed';
export const REQUEST_CONFIRMATION_EXPIRED_ACTION = 'request_confirmation.expired';

/** `metadata.source` on the sweep's audit row and its PostHog forward. */
export const REQUEST_CONFIRMATION_EXPIRY_SOURCE = 'request-confirmation-expiry-cron';

const DAY_MS = 86_400_000;

/** Base64url without padding. */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh token: 32 random bytes, 43 base64url characters. Only ever emailed. */
export function newConfirmationToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The stored form of a token. The lookup is by this hash, so no compare is needed. */
export function confirmationTokenHash(token: string): Promise<string> {
  return sha256Hex(token.trim());
}

/** `created_at` plus {@link REQUEST_CONFIRMATION_DAYS}. */
export function confirmationExpiresAt(now: Date): string {
  return new Date(now.getTime() + REQUEST_CONFIRMATION_DAYS * DAY_MS).toISOString();
}

/** True when the link no longer works. The boundary instant is expired. */
export function confirmationExpired(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) <= now.getTime();
}

/** What the audit rows say about a pending request. Never the email. */
export interface ConfirmationTarget {
  kind: RequestConfirmationKind;
  /** `vendor` for a claim (a claim is on the company), null for a listing. */
  targetType: 'vendor' | null;
  targetId: string | null;
}

export interface PendingConfirmationParams extends ConfirmationTarget {
  id: string;
  tokenHash: string;
  /** The typed address. Stored trimmed and lowercased. */
  email: string;
  /** The validated request body. */
  payload: unknown;
  termsVersion: string;
  evidence: AcceptanceRequestEvidence;
  now: Date;
}

/** The pending insert and its `request_confirmation.created` audit row. */
export function pendingConfirmationStatements(
  db: Db,
  p: PendingConfirmationParams,
): { stmts: BatchStmt[]; auditEntry: AuditLogEntry } {
  const auditEntry: AuditLogEntry = {
    actorId: null,
    actorType: 'user',
    action: REQUEST_CONFIRMATION_CREATED_ACTION,
    entityType: REQUEST_CONFIRMATION_ENTITY_TYPE,
    entityId: p.id,
    vendorId: p.targetType === 'vendor' ? p.targetId : null,
    metadata: { kind: p.kind, target_type: p.targetType, target_id: p.targetId },
  };
  return {
    stmts: [
      db.insert(requestConfirmations).values({
        id: p.id,
        kind: p.kind,
        tokenHash: p.tokenHash,
        submitterEmail: p.email.trim().toLowerCase(),
        payload: JSON.stringify(p.payload),
        termsVersion: p.termsVersion,
        ip: p.evidence.ip,
        userAgent: p.evidence.userAgent,
        createdAt: p.now.toISOString(),
        expiresAt: confirmationExpiresAt(p.now),
      }),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
  };
}

/**
 * The confirm's two statements, appended to the request's own batch: the guarded
 * update (`confirmed_at`, `payload = NULL`) and the `request_confirmation.confirmed`
 * audit row. The request insert in the same batch carries this row's id as its PK,
 * so a second confirm fails on that PK and rolls all of this back.
 */
export function confirmedStatements(
  db: Db,
  p: ConfirmationTarget & { id: string; now: string },
): { stmts: BatchStmt[]; auditEntry: AuditLogEntry } {
  const auditEntry: AuditLogEntry = {
    actorId: null,
    actorType: 'user',
    action: REQUEST_CONFIRMATION_CONFIRMED_ACTION,
    entityType: REQUEST_CONFIRMATION_ENTITY_TYPE,
    entityId: p.id,
    vendorId: p.targetType === 'vendor' ? p.targetId : null,
    beforeState: { confirmed_at: null },
    afterState: { confirmed_at: p.now },
    metadata: { kind: p.kind, target_type: p.targetType, target_id: p.targetId },
  };
  return {
    stmts: [
      db
        .update(requestConfirmations)
        .set({ confirmedAt: p.now, payload: null })
        .where(and(eq(requestConfirmations.id, p.id), isNull(requestConfirmations.confirmedAt))),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
  };
}

/** `metadata.source` on the submit's PostHog forward. */
export const REQUEST_CONFIRMATION_SOURCE = 'claim-confirm';

/**
 * Park an anonymous submit (the confirm path of `POST /api/requests/claim` and
 * `/listing`). One `db.batch`: the pending row and its `request_confirmation.created`
 * audit row. No acceptance row, no account check, no routing, no Linear issue, no
 * alert, no receipt: all of that runs at confirm. Post-commit, in `waitUntil`, the
 * `claim-confirm` email goes to the typed address. Returns the pending id, which the
 * request takes on confirm.
 */
export async function createPendingConfirmation(
  c: EmailContext & ForwardContext,
  db: Db,
  p: ConfirmationTarget & {
    email: string;
    payload: unknown;
    subject: ClaimConfirmSubject;
    now?: Date;
  },
): Promise<{ id: string }> {
  const now = p.now ?? new Date();
  const id = crypto.randomUUID();
  const token = newConfirmationToken();
  const built = pendingConfirmationStatements(db, {
    id,
    kind: p.kind,
    targetType: p.targetType,
    targetId: p.targetId,
    tokenHash: await confirmationTokenHash(token),
    email: p.email,
    payload: p.payload,
    // The version the visitor saw. Re-checked at confirm, where a bump in between
    // refuses the acceptance (`agreementAcceptanceStatements`).
    termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
    evidence: acceptanceRequestEvidence(c.req.raw.headers),
    now,
  });
  await db.batch(built.stmts as BatchTuple);
  forwardAuditBatch(c, [built.auditEntry], [], REQUEST_CONFIRMATION_SOURCE);
  c.executionCtx.waitUntil(
    sendClaimConfirmEmail(c, {
      to: p.email,
      pendingId: id,
      token,
      subject: p.subject,
      now,
    }).then(() => undefined),
  );
  return { id };
}

/** The pending row a token names, or undefined. */
export async function findConfirmationByToken(db: Db, token: string) {
  const tokenHash = await confirmationTokenHash(token);
  return db.query.requestConfirmations.findFirst({
    where: eq(requestConfirmations.tokenHash, tokenHash),
  });
}

export type RequestConfirmationRow = typeof requestConfirmations.$inferSelect;

// ─── The daily expiry sweep ─────────────────────────────────────────────────

export interface RequestConfirmationExpiryResult {
  /** Rows deleted this run. */
  deleted: number;
  /** Of those, the ones never confirmed: links nobody clicked. */
  unconfirmed: number;
  /** 1 when more expired rows remain for the next run, else 0. Not a count. */
  capped: number;
  /** The summary audit entry, or null when nothing was deleted. */
  auditEntry: AuditLogEntry | null;
}

/**
 * Delete every row past `expires_at`, confirmed or not, up to
 * {@link REQUEST_CONFIRMATION_EXPIRY_CAP}, with ONE summary
 * `request_confirmation.expired` audit row in the same batch (the scheduled-delete
 * rule, ADR 0022). A confirmed row is spent and holds no payload. An unconfirmed one
 * is a link nobody clicked, so nothing was ever claimed. Zero rows writes nothing.
 *
 * Throws only on a D1 error, which the cron shell records as a failed run.
 */
export async function runRequestConfirmationExpiry(
  db: Db,
  deps: { now?: Date } = {},
): Promise<RequestConfirmationExpiryResult> {
  const now = deps.now ?? new Date();
  // ISO-8601 TEXT compares lexically, so the cutoff is a string. `expires_at <= now`
  // matches `confirmationExpired`: the boundary instant is expired.
  const cutoff = now.toISOString();
  const expired = lte(requestConfirmations.expiresAt, cutoff);

  const rows = await db
    .select({ id: requestConfirmations.id, confirmedAt: requestConfirmations.confirmedAt })
    .from(requestConfirmations)
    .where(expired)
    .orderBy(asc(requestConfirmations.expiresAt), asc(requestConfirmations.id))
    .limit(REQUEST_CONFIRMATION_EXPIRY_CAP + 1);
  const batch = rows.slice(0, REQUEST_CONFIRMATION_EXPIRY_CAP);
  const capped = rows.length > batch.length ? 1 : 0;
  if (batch.length === 0) return { deleted: 0, unconfirmed: 0, capped: 0, auditEntry: null };

  const unconfirmed = batch.filter((r) => r.confirmedAt === null).length;
  const auditEntry: AuditLogEntry = {
    actorId: null,
    actorType: 'system',
    action: REQUEST_CONFIRMATION_EXPIRED_ACTION,
    entityType: REQUEST_CONFIRMATION_ENTITY_TYPE,
    metadata: {
      source: REQUEST_CONFIRMATION_EXPIRY_SOURCE,
      table: 'request_confirmations',
      cutoff,
      rowsDeleted: batch.length,
      unconfirmed,
    },
  };
  // The same ordered, capped selection as the read, as a subquery: up to 500 ids
  // would pass D1's 100-parameter cap as an `IN (…)` list.
  const stmts: BatchStmt[] = [
    db
      .delete(requestConfirmations)
      .where(
        inArray(
          requestConfirmations.id,
          db
            .select({ id: requestConfirmations.id })
            .from(requestConfirmations)
            .where(expired)
            .orderBy(asc(requestConfirmations.expiresAt), asc(requestConfirmations.id))
            .limit(REQUEST_CONFIRMATION_EXPIRY_CAP),
        ),
      ),
    auditInsert(db, auditEntry),
  ];
  await db.batch(stmts as BatchTuple);
  return { deleted: batch.length, unconfirmed, capped, auditEntry };
}
