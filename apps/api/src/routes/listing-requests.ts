/**
 * `POST /api/requests/listing` (AECI-1293, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.4):
 * "Not listed? Ask us to add it" in the claim dialog. A visitor names a product or
 * company the catalog does not list, with the claimant's identity fields, the company's
 * country and optional comments, so AECi can add the listing and then invite them to
 * claim it.
 *
 * **A request to be listed, not a claim** (AECI-1705). There is no vendor terms box and
 * no `agreement_acceptances` row: no listed company exists yet to accept the terms for.
 * The vendor accepts them when they claim the listing we add.
 *
 * Public, no session, like the claim route beside it. Contract: `ListingRequestSchema`.
 *
 * **It waits on the emailed link** (AECI-1435, ADR 0043). Unless the visitor is signed
 * in with the typed address, the submit parks the request in `request_confirmations`
 * and emails a confirm link. The row and its audit row are written at confirm
 * (`routes/request-confirmations.ts`), by `submitListingNow`.
 *
 * **Its own table.** The row lands in `listing_requests`, not `vendor_requests`: a
 * typed-in listing has no target, and admitting it to `vendor_requests` would change
 * two CHECKs and a NOT NULL, a drizzle-kit table recreate of a table with FK children
 * (`docs/migrations.md` §0). See the table's comment in `db/schema.ts`.
 *
 * **One atomic `db.batch`**: the insert and its `listing_request.created` audit row
 * (ADR 0022: a request is domain state). A failed batch writes neither. A row written
 * before AECI-1705 also has a vendor terms acceptance that names it
 * (`agreement_acceptances.listing_request_id`). None is written now. The metadata holds whether a LinkedIn
 * profile was given, never the typed name, website or email: those
 * are on the row, and the audit forward leaves the Worker. No `workflow_instances` row,
 * because that table's `workflow_type` is CHECK-constrained; the audit rows are the
 * history. The §26.5 forward runs post-commit.
 *
 * **Rate limit.** None in the Worker, like the claim route: the path is under
 * `/api/requests/`, so zone Rule A caps it per IP (`docs/waf-rate-limits.md` §1, §6.2).
 *
 * **The alert** (`listing-request-alert`) goes to `SUPPORT_EMAIL` after commit in
 * `ctx.waitUntil`, reply-to the submitter, keyed on the row id. Since AECI-1705 it is the
 * working record, so it carries every field the form collects. The visitor's receipt
 * (`claim-received`, AECI-1366) follows it in the same chain. The address is typed, not
 * verified, so the receipt is bounded to one per address per UTC day and grants nothing.
 * Both fail open and never change the `201`.
 */

import {
  claimantTitle,
  ListingRequestSchema,
  normalizeFoundVia,
  type ListingRequest,
  type StoredListingRequest,
  type RequestSubmitResponse,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { listingRequests } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { sendClaimReceivedEmail, sendListingRequestAlert } from '../lib/email';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { createPendingConfirmation } from '../lib/request-confirmations';
import {
  sessionMatchesTypedEmail,
  verifiedSessionEmail,
  type SessionEmailResolver,
} from '../lib/session-email';

/** The `201` message. The dialog renders its own receipt; this is for API callers. */
export const LISTING_REQUEST_RECEIVED =
  'Your request has been received. We will review it. If we add the listing, we will email you to finish your claim.';

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

/** The `201` message of a listing request that waits on the emailed link (AECI-1435). */
export const LISTING_REQUEST_CONFIRM =
  'Check your email. Your request is not sent until you click the link we emailed you.';

/** What the confirm path changes (AECI-1435). See `CreateRequestOptions` in `requests.ts`. */
export interface ListingRequestOptions {
  /** The pending `request_confirmations.id`, used as the `listing_requests.id`. */
  requestId?: string;
  /** The confirmed-row update and its audit row, appended to the batch. */
  extra?: { stmts: BatchStmt[]; auditEntries: AuditLogEntry[] };
  /** `metadata.confirmation`: `session` for a signed-in match, `email` for a link. */
  confirmation?: 'session' | 'email';
}

/**
 * Write a listing request: the insert and its audit row in one batch, then the alert
 * and the receipt post-commit. No acceptance row (AECI-1705). The signed-in path of
 * `POST /api/requests/listing` calls it at submit, and the confirm (AECI-1435) calls
 * it with the pending row's payload and id. Returns the request id.
 */
export async function submitListingNow(
  c: Context<{ Bindings: Env }>,
  db: Db,
  payload: ListingRequest | StoredListingRequest,
  opts: ListingRequestOptions = {},
): Promise<string> {
  const requestId = opts.requestId ?? crypto.randomUUID();
  // AECI-1063 (`docs/ANALYTICS.md` §11b): `''` stores NULL; a detail without a
  // follow-up choice is dropped.
  const { foundVia, foundViaDetail } = normalizeFoundVia(payload);
  const row = {
    id: requestId,
    listingName: payload.listing_name,
    website: payload.website,
    submitterEmail: payload.submitter_email,
    submitterName: payload.submitter_name,
    // AECI-1649: only a pending request stored before the role field went carries one.
    submitterRole: ('submitter_role' in payload && payload.submitter_role) || null,
    // Optional fields: `''` is "not supplied", stored as NULL.
    submitterLinkedinUrl: payload.submitter_linkedin_url || null,
    // AECI-1617: absent only on a pending request stored before the fields shipped.
    submitterTitle: payload.submitter_title || null,
    companyLegalName: payload.company_legal_name || null,
    // AECI-1705: absent only on a pending request stored before the field shipped.
    companyCountry: payload.company_country ?? null,
    body: payload.body,
    foundVia,
    foundViaDetail,
  };

  const auditEntry: AuditLogEntry = {
    actorType: 'user',
    action: 'listing_request.created',
    entityType: 'listing_request',
    entityId: requestId,
    metadata: {
      source: 'claim-dialog',
      has_linkedin: row.submitterLinkedinUrl !== null,
      // AECI-1063: the enum only. The detail stays on the row: this metadata is
      // forwarded to PostHog Logs (docs/ANALYTICS.md §2).
      found_via: row.foundVia,
      ...(opts.confirmation ? { confirmation: opts.confirmation } : {}),
    },
  };

  const stmts: BatchStmt[] = [
    db.insert(listingRequests).values(row),
    auditInsert(db, auditEntry),
    // AECI-1435: the confirmed-row update and its audit row.
    ...(opts.extra?.stmts ?? []),
  ];
  await db.batch(stmts as BatchTuple);

  // Best-effort §26.5 forward AFTER the atomic commit.
  forwardAuditBatch(c, [auditEntry, ...(opts.extra?.auditEntries ?? [])], [], 'claim-dialog');

  c.executionCtx.waitUntil(
    sendListingRequestAlert(c, {
      request: {
        requestId,
        listingName: row.listingName,
        website: row.website,
        submitterEmail: row.submitterEmail,
        submitterName: row.submitterName,
        submitterTitle: claimantTitle(row.submitterTitle, row.submitterRole),
        submitterLinkedinUrl: row.submitterLinkedinUrl,
        companyLegalName: row.companyLegalName,
        companyCountry: row.companyCountry,
        body: row.body,
        foundVia: row.foundVia,
        foundViaDetail: row.foundViaDetail,
      },
      dedupeKey: `listing-request-alert:${requestId}`,
      entity: { type: 'listing_request', id: requestId },
    })
      .then(() =>
        sendClaimReceivedEmail(c, {
          to: row.submitterEmail,
          subject: { kind: 'listing', requestId, listingName: row.listingName },
        }),
      )
      .then(() => undefined),
  );
  return requestId;
}

export function createListingRequestHandler(
  dbFor: DbFactory = getDb,
  sessionEmail: SessionEmailResolver = verifiedSessionEmail,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseBody(c);
    const { db } = writeDb(c, dbFor);

    // AECI-1435: a signed-in visitor whose verified email is the typed address skips
    // the emailed link. Anyone else waits on it, and nothing reaches the queue yet.
    if (sessionMatchesTypedEmail(await sessionEmail(c), payload.submitter_email)) {
      const requestId = await submitListingNow(c, db, payload, { confirmation: 'session' });
      const body: RequestSubmitResponse = {
        request_id: requestId,
        message: LISTING_REQUEST_RECEIVED,
        confirmation_required: false,
      };
      return json(body, { status: 201 });
    }

    const { id } = await createPendingConfirmation(c, db, {
      kind: 'listing',
      targetType: null,
      targetId: null,
      email: payload.submitter_email,
      payload,
      subject: { kind: 'listing', listingName: payload.listing_name },
      // AECI-1705: the form shows no vendor terms, so the pending row records none.
      acceptance: false,
    });
    const body: RequestSubmitResponse = {
      request_id: id,
      message: LISTING_REQUEST_CONFIRM,
      confirmation_required: true,
    };
    return json(body, { status: 201 });
  };
}
