/**
 * `POST /api/requests/listing` (AECI-1293, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.4):
 * "Not listed? Type it in" in the claim dialog. A visitor names a product or company
 * the catalog does not list, with the claim form's identity fields and optional
 * comments, so AECi can add the listing and then invite them to claim it.
 *
 * Public, no session, like the claim route beside it. Contract: `ListingRequestSchema`.
 *
 * **Its own table.** The row lands in `listing_requests`, not `vendor_requests`: a
 * typed-in listing has no target, and admitting it to `vendor_requests` would change
 * two CHECKs and a NOT NULL, a drizzle-kit table recreate of a table with FK children
 * (`docs/migrations.md` §0). See the table's comment in `db/schema.ts`.
 *
 * **One atomic `db.batch`**: the insert and its `listing_request.created` audit row
 * (ADR 0022: a request is domain state). The metadata holds whether a LinkedIn
 * profile was given, never the typed name, website or email: those
 * are on the row, and the audit forward leaves the Worker. No `workflow_instances` row,
 * because that table's `workflow_type` is CHECK-constrained; the audit rows are the
 * history. The §26.5 forward runs post-commit.
 *
 * **Rate limit.** None in the Worker, like the claim route: the path is under
 * `/api/requests/`, so zone Rule A caps it per IP (`docs/waf-rate-limits.md` §1, §6.2).
 *
 * **The alert** (`listing-request-alert`) goes to `SUPPORT_EMAIL` after commit in
 * `ctx.waitUntil`, reply-to the submitter, keyed on the row id. It fails open and never
 * changes the `201`. No email to the visitor: the address is typed, not verified.
 */

import {
  ListingRequestSchema,
  type ListingRequest,
  type RequestSubmitResponse,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { listingRequests } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { sendListingRequestAlert } from '../lib/email';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';

/** The `201` message. The dialog renders its own receipt; this is for API callers. */
export const LISTING_REQUEST_RECEIVED =
  'Your request has been received. We will add the listing and email you to finish your claim.';

async function parseBody(c: Context<{ Bindings: Env }>): Promise<ListingRequest> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope.
  return ListingRequestSchema.parse(raw);
}

export function createListingRequestHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseBody(c);
    const { db } = writeDb(c, dbFor);

    const requestId = crypto.randomUUID();
    const row = {
      id: requestId,
      listingName: payload.listing_name,
      website: payload.website,
      submitterEmail: payload.submitter_email,
      submitterName: payload.submitter_name,
      submitterRole: payload.submitter_role,
      // Optional fields: `''` is "not supplied", stored as NULL.
      submitterLinkedinUrl: payload.submitter_linkedin_url || null,
      body: payload.body,
    };

    const auditEntry: AuditLogEntry = {
      actorType: 'user',
      action: 'listing_request.created',
      entityType: 'listing_request',
      entityId: requestId,
      metadata: {
        source: 'claim-dialog',
        has_linkedin: row.submitterLinkedinUrl !== null,
      },
    };

    const stmts: BatchStmt[] = [
      db.insert(listingRequests).values(row),
      auditInsert(db, auditEntry),
    ];
    await db.batch(stmts as BatchTuple);

    // Best-effort §26.5 forward AFTER the atomic commit.
    forwardAuditBatch(c, [auditEntry], [], 'claim-dialog');

    c.executionCtx.waitUntil(
      sendListingRequestAlert(c, {
        request: {
          requestId,
          listingName: row.listingName,
          website: row.website,
          submitterEmail: row.submitterEmail,
          submitterName: row.submitterName,
          submitterRole: row.submitterRole,
          submitterLinkedinUrl: row.submitterLinkedinUrl,
          body: row.body,
        },
        dedupeKey: `listing-request-alert:${requestId}`,
        entity: { type: 'listing_request', id: requestId },
      }).then(() => undefined),
    );

    const body: RequestSubmitResponse = {
      request_id: requestId,
      message: LISTING_REQUEST_RECEIVED,
    };
    return json(body, { status: 201 });
  };
}
