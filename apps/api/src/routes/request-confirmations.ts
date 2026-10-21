/**
 * `POST /api/requests/confirm` (AECI-1435, ADR 0042, `API_CONTRACTS.md` §6.7): the
 * click behind the `claim-confirm` email. The `/claims/confirm?token=…` page renders a
 * button, and only the button POSTs here, because mail scanners fetch the links they
 * are sent.
 *
 * Public, no session: the token is the proof that the typed address received the
 * mail. It is hashed and looked up by its hash. Rate-limited by the `token` bucket,
 * keyed by IP, never by the token (the invite-accept reasoning), and the path is under
 * `/api/requests/`, so zone Rule A caps it too.
 *
 * Outcomes:
 *
 *   - unknown token: `404 NOT_FOUND`, `details.resource = 'request_confirmation'`.
 *   - already confirmed: `200 { status: 'already_confirmed' }`. Nothing is written.
 *   - past `expires_at`: `422 INVALID_STATE_TRANSITION`, `details.reason = 'expired'`,
 *     the expired-invite precedent (`routes/seat-invites.ts`).
 *   - the claimed listing is gone: the `404 NOT_FOUND` `resolveClaimTarget` gives, with
 *     `details.resource` `vendor` or `product`. The page offers the typed-in form.
 *   - otherwise the request goes in: `200 { status: 'confirmed' }`.
 *   - a claim the AECI-1420 account check stored rejected: `200 { status: 'rejected',
 *     reason, vendor_name }` (ruled 2026-10-21). The click proved the mailbox, so the
 *     page says why, the way the reasoned `claim-rejected` email does. A check that
 *     could not run (`unavailable`) is not a rejection and answers `confirmed`.
 *
 * **Going in is today's submit, unchanged.** A claim runs `submitClaimNow` and a listing
 * runs `submitListingNow`, the functions the signed-in submit calls, with the pending
 * row's id as the request id and its stored terms version, IP and user agent for the
 * acceptance. The AECI-1420 account check, owner routing, the duplicate probe and the
 * domain match all run now. The request's batch also carries the guarded update of the
 * pending row (`confirmed_at`, `payload = NULL`) and its
 * `request_confirmation.confirmed` audit row.
 *
 * **Single use.** A second confirm finds `confirmed_at` set and writes nothing. Two
 * confirms racing both pass that read, and the loser's batch fails on the request's
 * primary key and rolls back whole. The handler re-reads, finds the row confirmed, and
 * answers `already_confirmed`. The post-commit chain (Linear, alert, receipt, owner
 * emails) runs only after a batch commits, so it runs once.
 */

import {
  ApiErrorCode,
  ClaimRequestSchema,
  ConfirmRequestResponseSchema,
  ConfirmRequestSchema,
  ListingRequestSchema,
  RequestConfirmationKindSchema,
  type ConfirmRequestResponse,
  type RequestConfirmationKind,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { requestConfirmations } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { resolveClaimantIdentity } from '../lib/claimant-identity';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  confirmationExpired,
  confirmedStatements,
  findConfirmationByToken,
  type RequestConfirmationRow,
} from '../lib/request-confirmations';
import { submitListingNow } from './listing-requests';
import { resolveClaimTarget, submitClaimNow } from './requests';

async function parseBody(c: Context<{ Bindings: Env }>) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return ConfirmRequestSchema.parse(raw);
}

function respond(c: Context<{ Bindings: Env }>, body: ConfirmRequestResponse): Response {
  validateResponseInDev(c.env, () => ConfirmRequestResponseSchema.parse(body));
  return json(body);
}

function alreadyConfirmed(
  c: Context<{ Bindings: Env }>,
  row: RequestConfirmationRow,
  kind: RequestConfirmationKind,
): Response {
  return respond(c, {
    status: 'already_confirmed',
    kind,
    request_id: row.id,
    routed: false,
    company_name: null,
  });
}

/** The stored payload, as JSON. A row that is unconfirmed always holds one. */
function storedPayload(row: RequestConfirmationRow): unknown {
  if (row.payload === null) {
    throw new ApiError(500, ApiErrorCode.INTERNAL_ERROR, 'Pending request has no payload');
  }
  return JSON.parse(row.payload);
}

/** Did a racing confirm commit first? Re-read the pending row by id. */
async function confirmedSince(db: Db, id: string): Promise<boolean> {
  const again = await db.query.requestConfirmations.findFirst({
    columns: { confirmedAt: true },
    where: eq(requestConfirmations.id, id),
  });
  return Boolean(again?.confirmedAt);
}

export function createConfirmRequestHandler(
  dbFor: DbFactory = getDb,
  resolveIdentity: typeof resolveClaimantIdentity = resolveClaimantIdentity,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const { token } = await parseBody(c);
    const { db } = writeDb(c, dbFor);

    const row = await findConfirmationByToken(db, token);
    // Never echo the token: the 404 names the resource only.
    if (!row) throw notFoundError('request_confirmation', {});
    const kindParse = RequestConfirmationKindSchema.safeParse(row.kind);
    if (!kindParse.success) throw notFoundError('request_confirmation', {});
    const kind = kindParse.data;

    if (row.confirmedAt) return alreadyConfirmed(c, row, kind);

    const now = new Date();
    if (confirmationExpired(row.expiresAt, now)) {
      throw new ApiError(422, ApiErrorCode.INVALID_STATE_TRANSITION, 'This link has expired', {
        details: { reason: 'expired' },
      });
    }

    const acceptance = {
      version: row.termsVersion,
      evidence: { ip: row.ip, userAgent: row.userAgent },
    };

    if (kind === 'claim') {
      const payload = ClaimRequestSchema.parse(storedPayload(row));
      // Again, not from the submit: the listing may have changed or gone in 7 days.
      const target = await resolveClaimTarget(db, payload.target_type, payload.slug);
      const confirmed = confirmedStatements(db, {
        id: row.id,
        now: now.toISOString(),
        kind,
        targetType: 'vendor',
        targetId: target.id,
      });
      try {
        const result = await submitClaimNow(c, db, payload, target, resolveIdentity, {
          requestId: row.id,
          acceptance,
          extra: { stmts: confirmed.stmts, auditEntries: [confirmed.auditEntry] },
          confirmation: 'email',
        });
        if (result.rejection) {
          return respond(c, {
            status: 'rejected',
            kind: 'claim',
            request_id: result.requestId,
            routed: false,
            company_name: target.name,
            reason: result.rejection.kind,
            vendor_name:
              result.rejection.kind === 'other_vendor'
                ? result.rejection.otherVendorName.trim() || null
                : null,
          });
        }
        return respond(c, {
          status: 'confirmed',
          kind,
          request_id: result.requestId,
          routed: result.routed,
          company_name: target.name,
        });
      } catch (error) {
        if (!(error instanceof ApiError) && (await confirmedSince(db, row.id))) {
          return alreadyConfirmed(c, row, kind);
        }
        throw error;
      }
    }

    const payload = ListingRequestSchema.parse(storedPayload(row));
    const confirmed = confirmedStatements(db, {
      id: row.id,
      now: now.toISOString(),
      kind,
      targetType: null,
      targetId: null,
    });
    try {
      const requestId = await submitListingNow(c, db, payload, {
        requestId: row.id,
        acceptance,
        extra: { stmts: confirmed.stmts, auditEntries: [confirmed.auditEntry] },
        confirmation: 'email',
      });
      return respond(c, {
        status: 'confirmed',
        kind,
        request_id: requestId,
        routed: false,
        company_name: payload.listing_name,
      });
    } catch (error) {
      if (!(error instanceof ApiError) && (await confirmedSince(db, row.id))) {
        return alreadyConfirmed(c, row, kind);
      }
      throw error;
    }
  };
}
