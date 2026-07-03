/**
 * Vendor-request endpoints (AECI-128) — Drizzle/D1 (ADR 0016 / AECI-253). The
 * claim & correction submission forms.
 *
 *   POST /api/requests/correction     — insert a `kind:'correction'` row.
 *   POST /api/requests/claim          — insert a `kind:'claim'` row.
 *
 * Contracts: `CorrectionRequestSchema` / `ClaimRequestSchema` from `@aeci/shared`.
 * Rows land in `vendor_requests` (Phase 2 Spec §5.1) with `status:'open'` and
 * `linear_issue_id:null`.
 *
 * Each submit is one atomic `db.batch` (the §26.1 invariant, AECI-249): the
 * `vendor_requests` insert + the `workflow_instance` (`vendor_claim` |
 * `correction_request`, `current_state:'open'`) + its genesis `workflow_transitions`
 * row (`null → open`) + the `vendor_request.created` audit. Ids are generated up
 * front so nothing depends on batch return values. The best-effort Datadog forwards
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
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionEntry,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import { and, asc, eq, or } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { products, vendorRequests, vendors, workflowInstances } from '../db/schema';
import { logToDatadog } from '../datadog';
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
import { createLinearIssueForRequest, drizzleLinearStore } from '../lib/linear';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Tagged
 *  `source: request-form`. */
function makeForwarder(c: Context<{ Bindings: Env }>): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'request-form',
    });
  };
}

/** Datadog forwarder for the workflow-transition write; no-op without
 *  `DD_API_KEY`. Mirrors `makeForwarder`, tagged `source: request-form`. */
function makeWorkflowForwarder(
  c: Context<{ Bindings: Env }>,
): WorkflowTransitionForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`.trim(),
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
      source: 'request-form',
    });
  };
}

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

/**
 * Duplicate probe (§7.2 / §23.2): an existing `open` request for the same target
 * (`target_type`+`target_id`) that shares this submit's `kind` OR `submitter_email`.
 * Returns the EARLIEST match (the "original") — the row we point
 * `duplicate_of_request_id` at and reference in the Linear note — or `null`.
 * **Informational only**; vendor requests flag duplicates (sometimes legitimate),
 * they never block.
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
  /** Carried into the audit metadata for traceability. */
  slug: string;
  /** Target vendor's website — input to the domain-match check; never stored. */
  websiteUrl: string | null;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
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
  const { slug, targetName, websiteUrl: _websiteUrl, ...rowData } = insert;
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

  // Best-effort §26.5 forwards AFTER the atomic commit.
  c.executionCtx.waitUntil(
    Promise.all([
      forwardAuditLog(auditEntry, makeForwarder(c)),
      forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
    ]),
  );

  // Phase 6.4 (AECI-211): create the Linear issue out-of-band so it never blocks
  // the 201. `createLinearIssueForRequest` never throws (it logs + meters every
  // failure and leaves the row `open`/`linear_issue_id=null` for the §6.7
  // reconciliation sweep), so `waitUntil` never sees a rejection.
  c.executionCtx.waitUntil(
    createLinearIssueForRequest(c, drizzleLinearStore(db), {
      requestId,
      workflowId,
      kind,
      targetType: insert.targetType,
      targetName,
      slug,
      submitterEmail: insert.submitterEmail,
      submitterName: insert.submitterName,
      submitterRole: insert.submitterRole,
      body: insert.body,
      sourceUrl: insert.sourceUrl,
      // Phase 6.8 signals: `domainMatch:'no_match'` adds the `domain-check-pending`
      // label; a duplicate adds an informational note on the issue (§7.1/§7.2).
      domainMatch,
      duplicateOfRequestId: duplicate?.id ?? null,
      duplicateLinearIssueId: duplicate?.linearIssueId ?? null,
    }),
  );

  const body: RequestSubmitResponse = {
    request_id: requestId,
    message:
      kind === 'claim'
        ? 'Your claim has been received. We will review it and follow up by email.'
        : 'Your correction has been received. We will review it and follow up by email.',
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
      websiteUrl: target.websiteUrl,
      submitterEmail: payload.submitter_email,
      submitterName: null,
      submitterRole: null,
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
    const target = await resolveTarget(db, payload.target_type, payload.slug);

    return createRequest(c, db, 'claim', {
      targetType: payload.target_type,
      targetId: target.id,
      targetName: target.name,
      slug: payload.slug,
      websiteUrl: target.websiteUrl,
      submitterEmail: payload.submitter_email,
      submitterName: payload.submitter_name,
      submitterRole: payload.submitter_role,
      body: payload.body,
      sourceUrl: null,
    });
  };
}
