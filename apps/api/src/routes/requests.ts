/**
 * Vendor-request endpoints (AECI-128) — Drizzle/D1 (ADR 0016 / AECI-253). The
 * claim & correction submission forms.
 *
 *   POST /api/requests/correction     — insert a `kind:'correction'` row.
 *   POST /api/requests/claim          — insert a `kind:'claim'` row.
 *
 * A typed-in listing from the claim dialog (`POST /api/requests/listing`, AECI-1293) is
 * NOT a kind here: it has no target, so it lives in `listing_requests`
 * (`routes/listing-requests.ts`). A claim carries the dialog's "Additional comments"
 * as the existing `body`. The plan question is gone (AECI-1365): an old client may
 * still send the key, and the schema strips it.
 *
 * Contracts: `CorrectionRequestSchema` / `ClaimRequestSchema` from `@aeci/shared`.
 * Rows land in `vendor_requests` (Phase 2 Spec §5.1) with `status:'open'` and
 * `linear_issue_id:null`.
 *
 * **A claim is on the company** (AECI-1364, `docs/VENDOR_SIGNUP_PROCESS.md` decision 1).
 * The wire still accepts `target_type: 'product'`, so every shipped form keeps working,
 * but `resolveClaimTarget` normalises it: the row is stored with `target_type =
 * 'vendor'` and the product's vendor id, and the product is kept in
 * `context_product_id` ("Came from" for the reviewer). A correction is about a listing,
 * so it keeps its product target.
 *
 * Each submit is one atomic `db.batch` (the §26.1 invariant, AECI-249): the
 * `vendor_requests` insert + the `workflow_instance` (`vendor_claim` |
 * `correction_request`, `current_state:'open'`) + its genesis `workflow_transitions`
 * row (`null → open`) + the `vendor_request.created` audit. Ids are generated up
 * front so nothing depends on batch return values. The best-effort §26.5 forwards
 * (§26.5) and the §6.4 Linear issue creation run AFTER commit via `waitUntil`.
 *
 * AECI-215 (Phase 6.8) computes two **informational** signals at submit time (never
 * automating approval): `domain_match` — submitter-email vs target-vendor-website
 * registrable domain (`lib/domain-match.ts`) — and a duplicate pointer
 * (`duplicate_of_request_id`, §7.2). Both persist on the row and feed the Linear
 * issue. The rest of the Phase 6 moderation pipeline (bidirectional sync, admin
 * views, rate limiting) is owned elsewhere; rows sit `open` for it to pick up.
 */

import {
  ClaimRequestSchema,
  CorrectionRequestSchema,
  type RequestKind,
  type RequestSubmitResponse,
  type RequestTargetType,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { type WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, eq, or } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { products, vendorRequests, vendors, workflowInstances } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  auditInsert,
  workflowTransitionInsert,
  type BatchStmt,
  type BatchTuple,
} from '../lib/audit';
import { computeDomainMatch } from '../lib/domain-match';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { sendClaimSubmittedNotification } from '../lib/email';
import { createLinearIssueForRequest, drizzleLinearStore } from '../lib/linear';
import { NOTIFIED_REQUEST_KINDS } from '../lib/request-links';
import { claimTargetIsPureConnector } from '../lib/vendor-product-roles';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function parseJsonBody<T>(c: Context<{ Bindings: Env }>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope.
  return schema.parse(raw);
}

/**
 * Resolve a `(target_type, slug)` pair to the entity's UUID **and** display name.
 * The form addresses its target by slug (it never holds a UUID), and
 * `vendor_requests.target_id` has no FK (the table is loose-polymorphic), so
 * resolving here both yields the id and guards against orphan rows. A missing
 * target → canonical 404, which the form surfaces. The name is for the Linear
 * issue title only (not stored on the row); products carry `name`, vendors
 * `company_name`, so we normalise per type.
 */
async function resolveTarget(
  db: Db,
  targetType: RequestTargetType,
  slug: string,
): Promise<{ id: string; name: string; websiteUrl: string | null }> {
  // The domain-match check (§7.1) compares against the *target vendor's* website.
  // For a vendor target that's the vendor's own `website`; for a product target it's
  // the product's PRIMARY vendor (via `product_vendors.is_primary`) — not the
  // product's own `website` field. A product with no primary vendor → null → the
  // caller resolves `manual_review`.
  if (targetType === 'product') {
    const row = await db.query.products.findFirst({
      columns: { id: true, name: true },
      where: eq(products.slug, slug),
      with: {
        productVendors: {
          columns: { isPrimary: true },
          with: { vendor: { columns: { website: true } } },
        },
      },
    });
    if (!row) throw notFoundError('product', { slug });
    const primary = row.productVendors.find((pv) => pv.isPrimary);
    return { id: row.id, name: row.name, websiteUrl: primary?.vendor?.website ?? null };
  }

  const row = await db.query.vendors.findFirst({
    columns: { id: true, companyName: true, website: true },
    where: eq(vendors.slug, slug),
  });
  if (!row) throw notFoundError('vendor', { slug });
  return { id: row.id, name: row.companyName, websiteUrl: row.website ?? null };
}

/** A product named in a claim, kept as the claim's context (AECI-1364). */
interface ContextProduct {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolve a CLAIM's `(target_type, slug)` to the company it claims (AECI-1364,
 * `docs/VENDOR_SIGNUP_PROCESS.md` decision 1: a claim is on the company, never a
 * product). A vendor target resolves as `resolveTarget` does. A product target
 * resolves to the product's vendor: the `is_primary` row, else any `product_vendors`
 * row (the lowest vendor id, so the pick is stable). That is the same choice
 * `GET /api/products/:slug` makes for its `vendor` field, so the name the claim page
 * shows is the company the row records. The product comes back as `contextProduct`.
 *
 * A product with no `product_vendors` row has no company to claim. It returns the
 * same `404 NOT_FOUND` a missing product does, so the claim dialog offers "Type it in
 * instead" (`VENDOR_PROGRAM_PAGE_SPEC.md` §15.2).
 */
async function resolveClaimTarget(
  db: Db,
  targetType: RequestTargetType,
  slug: string,
): Promise<{
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  contextProduct: ContextProduct | null;
}> {
  if (targetType === 'vendor') {
    const row = await db.query.vendors.findFirst({
      columns: { id: true, companyName: true, slug: true, website: true },
      where: eq(vendors.slug, slug),
    });
    if (!row) throw notFoundError('vendor', { slug });
    return {
      id: row.id,
      name: row.companyName,
      slug: row.slug,
      websiteUrl: row.website ?? null,
      contextProduct: null,
    };
  }

  const row = await db.query.products.findFirst({
    columns: { id: true, name: true, slug: true },
    where: eq(products.slug, slug),
    with: {
      productVendors: {
        columns: { isPrimary: true },
        with: {
          vendor: { columns: { id: true, companyName: true, slug: true, website: true } },
        },
      },
    },
  });
  if (!row) throw notFoundError('product', { slug });
  const links = row.productVendors
    .filter((pv) => pv.vendor)
    .sort((a, b) => (a.vendor.id < b.vendor.id ? -1 : a.vendor.id > b.vendor.id ? 1 : 0));
  const vendor = (links.find((pv) => pv.isPrimary) ?? links[0])?.vendor;
  if (!vendor) throw notFoundError('product', { slug });
  return {
    id: vendor.id,
    name: vendor.companyName,
    slug: vendor.slug,
    websiteUrl: vendor.website ?? null,
    contextProduct: { id: row.id, name: row.name, slug: row.slug },
  };
}

/**
 * Duplicate probe (§7.2 / §23.2): an existing `open` request for the same target
 * (`target_type`+`target_id`) that shares this submit's `kind` OR `submitter_email`.
 * Returns the EARLIEST match (the "original") — the row we point
 * `duplicate_of_request_id` at and reference in the Linear note — or `null`.
 * **Informational only**; vendor requests flag duplicates (sometimes legitimate),
 * they never block.
 *
 * A claim's target is always the company since AECI-1364, so a claim sent from a
 * product page and one sent from the company page dedupe together. A claim stored
 * before that change keeps its product target and does not match a new one.
 */
async function detectDuplicate(
  db: Db,
  args: {
    kind: RequestKind;
    targetType: RequestTargetType;
    targetId: string;
    submitterEmail: string;
  },
): Promise<{ id: string; linearIssueId: string | null } | null> {
  const row = await db.query.vendorRequests.findFirst({
    columns: { id: true, linearIssueId: true },
    where: and(
      eq(vendorRequests.status, 'open'),
      eq(vendorRequests.targetType, args.targetType),
      eq(vendorRequests.targetId, args.targetId),
      or(
        eq(vendorRequests.kind, args.kind),
        eq(vendorRequests.submitterEmail, args.submitterEmail),
      ),
    ),
    orderBy: asc(vendorRequests.createdAt),
  });
  if (!row) return null;
  return { id: row.id, linearIssueId: row.linearIssueId ?? null };
}

interface RequestInsert {
  targetType: RequestTargetType;
  /** Resolved by `resolveTarget`; the row's `target_id`. */
  targetId: string;
  /** Target display name — Linear issue title only, never stored on the row. */
  targetName: string;
  /** The TARGET's slug, carried into the audit metadata for traceability. For a
   *  claim sent from a product page this is the company's slug (AECI-1364). */
  slug: string;
  /** AECI-1364: the product page a claim came from, or null. Its id is the row's
   *  `context_product_id`; its name and slug feed the metadata, the Linear issue and
   *  the claim alert. Always null for a correction. */
  contextProduct: ContextProduct | null;
  /** Target vendor's website — input to the domain-match check; never stored. */
  websiteUrl: string | null;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
  /** AECI-847: claimant-supplied LinkedIn profile, an identity signal for the
   *  reviewer. Claim-only — the correction handler always passes `null`. */
  submitterLinkedinUrl: string | null;
  body: string;
  sourceUrl: string | null;
}

/** Insert the row + open its workflow instance/genesis transition + write the
 *  audit entry, all in one atomic `db.batch`; return the 201 envelope. */
async function createRequest(
  c: Context<{ Bindings: Env }>,
  db: Db,
  kind: RequestKind,
  insert: RequestInsert,
): Promise<Response> {
  // Phase 6.8 (AECI-215): compute the two informational signals BEFORE the insert —
  // so the row persists the real `domain_match` (not the `'pending'` default) and the
  // duplicate probe never self-matches the row we're about to create. Both are hints
  // for the admin; neither gates the submit.
  const domainMatch = computeDomainMatch(insert.submitterEmail, insert.websiteUrl);
  const duplicate = await detectDuplicate(db, {
    kind,
    targetType: insert.targetType,
    targetId: insert.targetId,
    submitterEmail: insert.submitterEmail,
  });

  // `slug`/`targetName` are metadata/title only; `websiteUrl` is a domain-match input.
  // None are columns, so they're stripped before the insert.
  const { slug, targetName, websiteUrl: _websiteUrl, contextProduct, ...rowData } = insert;
  const workflowType = kind === 'claim' ? 'vendor_claim' : 'correction_request';
  // Shared metadata for the audit row and the genesis workflow transition.
  const metadata = {
    source: 'request-form',
    kind,
    target_type: insert.targetType,
    target_id: insert.targetId,
    slug,
    domain_match: domainMatch,
    duplicate_of_request_id: duplicate?.id ?? null,
    // AECI-1364: the product page a claim came from. Claims only: a correction's
    // audit row leaves the keys out rather than recording them as null.
    ...(kind === 'claim'
      ? {
          context_product_id: contextProduct?.id ?? null,
          context_product_slug: contextProduct?.slug ?? null,
        }
      : {}),
  };

  // Ids generated up front so the batch needs no return values.
  const requestId = crypto.randomUUID();
  const workflowId = crypto.randomUUID();

  // Phase 6.2 (AECI-209): the workflow instance mirrors the request `status`, then
  // the genesis transition records `null → open`. Lean — no guarded FSM (§26.3).
  // `linearIssueId` stays null (Phase 6.4 fills it post-commit); the submit is
  // anonymous so `initiatedBy`/`actorId` are null.
  const workflowEntry: WorkflowTransitionEntry = {
    workflowId,
    fromState: null,
    toState: 'open',
    reason: 'request submitted',
    metadata,
  };
  const auditEntry: AuditLogEntry = {
    actorType: 'user',
    action: 'vendor_request.created',
    entityType: 'vendor_request',
    entityId: requestId,
    metadata,
  };

  const stmts: BatchStmt[] = [
    db.insert(vendorRequests).values({
      id: requestId,
      kind,
      ...rowData,
      contextProductId: contextProduct?.id ?? null,
      domainMatch,
      duplicateOfRequestId: duplicate?.id ?? null,
    }),
    db.insert(workflowInstances).values({
      id: workflowId,
      workflowType,
      entityId: requestId,
      currentState: 'open',
    }),
    workflowTransitionInsert(db, workflowEntry),
    auditInsert(db, auditEntry),
  ];
  await db.batch(stmts as BatchTuple);

  // Best-effort §26.5 forwards AFTER the atomic commit, in ONE request (AECI-1112).
  forwardAuditBatch(c, [auditEntry], [workflowEntry], 'request-form');

  // Phase 6.4 (AECI-211): create the Linear issue out-of-band so it never blocks
  // the 201. `createLinearIssueForRequest` never throws (it logs + meters every
  // failure and leaves the row `open`/`linear_issue_id=null` for the §6.7
  // reconciliation sweep), so `waitUntil` never sees a rejection.
  //
  // AECI-861: the claim operator alert is SEQUENCED AFTER this, not fired beside
  // it. Both used to be independent `waitUntil`s, which meant the mail was composed
  // while the issue was still being created and could never name it. Chaining costs
  // nothing — both already ran off-request — and buys the operator a working link.
  // One `waitUntil`, so the two together stay inside a single extension window.
  const linearDone = createLinearIssueForRequest(c, drizzleLinearStore(db), {
    notification: 'linear-request-issue',
    requestId,
    workflowId,
    kind,
    targetType: insert.targetType,
    targetName,
    slug,
    submitterEmail: insert.submitterEmail,
    submitterName: insert.submitterName,
    submitterRole: insert.submitterRole,
    submitterLinkedinUrl: insert.submitterLinkedinUrl,
    contextProduct,
    body: insert.body,
    sourceUrl: insert.sourceUrl,
    // Phase 6.8 signals: `domainMatch:'no_match'` adds the `domain-check-pending`
    // label; a duplicate adds an informational note on the issue (§7.1/§7.2).
    domainMatch,
    duplicateOfRequestId: duplicate?.id ?? null,
    duplicateLinearIssueId: duplicate?.linearIssueId ?? null,
  });

  // Operator alert on claim INTAKE — the support inbox learns a claim landed and gets
  // the ticket link in the same message. CLAIMS ONLY: a correction is a low-stakes
  // data fix, a claim asserts control of a listing. `kind` is the gate rather than a
  // separate claim-only code path, so admitting corrections later is a predicate
  // change here and nothing else. Fail-open (absent
  // `SUPPORT_EMAIL`/`RESEND_API_KEY` → `'skipped'`), so it can never delay or
  // fail the 201. The claimant still gets no submit-time mail by design; their only
  // mail is the decision pair from `PATCH /api/admin/claims/:id`.
  //
  // The §6.7 sweep re-sends this alert under the same key when its retry creates the
  // issue (AECI-1203). The ledger makes that send a `duplicate` unless Resend refused
  // this one. The stuck-request alert covers a create that never succeeds. The key makes a
  // replayed `waitUntil` a ledger `duplicate`, not a second email.
  c.executionCtx.waitUntil(
    linearDone.then(async (outcome) => {
      if (!NOTIFIED_REQUEST_KINDS.has(kind)) return;
      // AECI-1367: the neutral connector-vendor flag. Never throws.
      const connectorVendor = await claimTargetIsPureConnector(
        db,
        insert.targetType,
        insert.targetId,
      );
      return sendClaimSubmittedNotification(c, {
        connectorVendor,
        dedupeKey: `claim-submitted-alert:${requestId}`,
        entity: { type: 'vendor_request', id: requestId },
        requestId,
        targetName,
        targetType: insert.targetType,
        slug,
        submitterEmail: insert.submitterEmail,
        submitterName: insert.submitterName,
        submitterRole: insert.submitterRole,
        submitterLinkedinUrl: insert.submitterLinkedinUrl,
        contextProduct,
        domainMatch,
        duplicateOfRequestId: duplicate?.id ?? null,
        linearIssueUrl: outcome.status === 'created' ? outcome.issueUrl : null,
      }).then(() => undefined);
    }),
  );

  const body: RequestSubmitResponse = {
    request_id: requestId,
    message:
      kind === 'claim'
        ? 'Your claim has been received. We will review it and follow up by email.'
        : // AECI-1205: no correction email exists, so this no longer promises one.
          'Your correction has been received. We will review it and update the listing if it needs a change.',
  };
  return json(body, { status: 201 });
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function createCorrectionSubmitHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, CorrectionRequestSchema);
    const { db } = writeDb(c, dbFor);
    const target = await resolveTarget(db, payload.target_type, payload.slug);

    return createRequest(c, db, 'correction', {
      targetType: payload.target_type,
      targetId: target.id,
      targetName: target.name,
      slug: payload.slug,
      contextProduct: null,
      websiteUrl: target.websiteUrl,
      submitterEmail: payload.submitter_email,
      submitterName: null,
      submitterRole: null,
      submitterLinkedinUrl: null,
      body: payload.body,
      sourceUrl: payload.source_url ? payload.source_url : null,
    });
  };
}

export function createClaimSubmitHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, ClaimRequestSchema);
    const { db } = writeDb(c, dbFor);
    // AECI-1364: a product target is normalised to its company here. The response
    // is unchanged, so the forms and the dialog need no new handling.
    const target = await resolveClaimTarget(db, payload.target_type, payload.slug);

    return createRequest(c, db, 'claim', {
      targetType: 'vendor',
      targetId: target.id,
      targetName: target.name,
      slug: target.slug,
      contextProduct: target.contextProduct,
      websiteUrl: target.websiteUrl,
      submitterEmail: payload.submitter_email,
      submitterName: payload.submitter_name,
      submitterRole: payload.submitter_role,
      // Optional field: the form submits `''` when the claimant skipped it, and an
      // empty string is not an absent signal to anything downstream. Store NULL.
      submitterLinkedinUrl: payload.submitter_linkedin_url ? payload.submitter_linkedin_url : null,
      body: payload.body,
      sourceUrl: null,
    });
  };
}
