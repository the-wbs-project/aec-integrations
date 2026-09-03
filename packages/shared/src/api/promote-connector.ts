import { z } from 'zod';

import { PromoteJobIdSchema, type PromoteSkipped } from './promote';

/**
 * `POST /api/promote/connector-catalog` — the connector-catalogue mirror
 * (AECI-714 / `STAGE_1_5_SPEC.md` §13 Addendum C, ADR 0021).
 *
 * The review app owns connector catalogues, their crawled listings ("stubs"),
 * many-to-many stub↔product mappings and the vendor's own published pair pages
 * (AECI-719). AECi holds a **full mirror** of them — every stub, including the
 * ~3,342 that map to nothing — because the question this lane answers is *"is this
 * new listing one of ours?"*, and that needs the misses present. It is also what
 * makes AECI-720's cutoff a lane freeze rather than a data migration, and what gives
 * AECI-722's triage queue its rows.
 *
 * ── ONE PAGE = ONE COMPLETE ADR 0021 PROMOTE JOB ────────────────────────────
 * This endpoint carries ONE page of ONE catalogue and reuses the promote machinery
 * verbatim: validate synchronously → start `PROMOTE_WORKFLOW` → `202 { jobId }` →
 * one non-retried `step.do` → one `db.batch` with the `promote_jobs` ledger row
 * FIRST (AECI-571) → poll the EXISTING `GET /api/promote/jobs/:id`. No new Worker,
 * no new binding, no second poll route.
 *
 * ── ACROSS PAGES THERE IS NO ATOMICITY, DELIBERATELY ────────────────────────
 * A catalogue is 3,573 stubs today and ~15k once Zapier lands (AECI-701); it cannot
 * be one transaction, and D1 has none to offer. One `promote_jobs` row protects one
 * commit, not N. So the only correctness property across pages is **whole-page
 * idempotence**: every statement the ingest emits is an upsert keyed on the review
 * record id, and a page re-sent with no review-side change in between emits zero
 * statements and writes no audit row.
 *
 * Two consequences the caller must design for, neither of them an error:
 *   - **References may dangle, and that is reported rather than fatal.** A `pairs`
 *     page whose stub endpoints ride a page not yet sent, or a mapping whose product
 *     is not promoted, lands in `skipped[]` and is re-sent later. Send stubs before
 *     pairs and it never happens; the protocol does not require it.
 *   - **Absence never means deletion.** A row missing from a page is a row on a
 *     different page. Hard deletes are explicit ({@link PromoteConnectorPagePayload.deleted}),
 *     and stub/pair retirement is a `removedAt` tombstone riding the ordinary upsert.
 *
 * ── ENUM DISCIPLINE, AND WHY IT IS A RULE ───────────────────────────────────
 * **Every field the DB CHECKs, this file `z.enum`s; every field this file leaves a
 * loose string, the DB leaves unconstrained.** Not a style preference: a CHECK change
 * on D1 is a destructive table recreate (`docs/migrations.md` §0), so the two must be
 * in exact lockstep or a value this contract admits rolls a whole page back at commit
 * time instead of failing fast with a 400. `surfaceRole`, `indexKind` and
 * `directionRole` are loose on BOTH sides — that vocabulary has already moved once
 * (the review app added `all` only after the 2026-08-27 Aquifer/Kroo survey).
 */

/**
 * A review-app record id, which is also the app-DB primary key — that identity is
 * what makes every statement in the sync a pure PK upsert (see the connector-lane
 * header in `apps/api/src/db/schema.ts`).
 *
 * Validated by shape rather than by `/^rec[A-Za-z0-9]{14}$/`. The `rec`-prefixed
 * format is the review app's own D1 id keeping Airtable's shape for compatibility,
 * not a commitment — and pinning the regex here would reject the entire catalogue the
 * day that changes, which the AECI-720 trajectory makes a live possibility.
 */
const RecordIdSchema = z.string().min(1).max(64);

/**
 * An already-promoted AECi product, addressed by its app-DB UUID. The review app
 * holds this mapping (`products.supabase_product_id`), so there is no `ref`/
 * `supabaseId` graph on this endpoint at all.
 *
 * Absent means *not promoted* — Zapier and Workato are `promotion_status: on_hold`
 * review-side (AECI-700) — and that is a **skip, never a 400**. The review app is
 * right to keep ingesting a catalogue whose platform AECi has not promoted.
 */
const PromotedProductIdSchema = z.string().uuid();

/** Enum vocabularies — kept in exact lockstep with the D1 CHECK constraints. */
/**
 * Who authors a catalogue. NOT on this wire — see {@link PromoteConnectorCatalogSchema}.
 * Exported because it is the lane's shared vocabulary: the admin flip contract
 * (`./admin-connector-catalogs`) is its only consumer.
 */
export const CONNECTOR_MANAGED_BY = ['review', 'vendor'] as const;
export const CONNECTOR_AUTHORSHIP = ['platform', 'partner', 'mixed'] as const;
export const CONNECTOR_MAPPING_STATUSES = [
  'mapped',
  'ruled_out',
  'out_of_scope',
  'no_record',
  'ambiguous_parked',
] as const;
export const CONNECTOR_MAPPING_CONFIDENCES = ['low', 'medium', 'high'] as const;
export const CONNECTOR_PAIR_SURFACES = ['curated', 'generated', 'unknown'] as const;

/** Statuses that NAME a product; several may sit on one stub. */
export const CONNECTOR_PRODUCT_STATUSES = ['mapped', 'ruled_out'] as const;
/** Statuses asserting there is no product to name; at most ONE per stub. */
export const CONNECTOR_DECISION_STATUSES = [
  'out_of_scope',
  'no_record',
  'ambiguous_parked',
] as const;

/**
 * The reserved `decidedBy` of the review app's automatic name-match pass.
 *
 * Exported because it is the **publication gate**, and the gate is provenance rather
 * than confidence: reachability the public site carries is only what somebody stands
 * behind. `status === 'mapped' && productId && decidedBy && decidedBy !== this`.
 * Gating on `confidence` instead would publish hundreds of machine guesses at
 * `medium`. AECI-715/716 must not re-spell this string.
 */
export const CONNECTOR_AUTO_DECIDER = 'auto-name-match';

/**
 * The catalogue header. Rides EVERY page, not just the first.
 *
 * One row of overhead per page, and it buys the single most useful property in the
 * protocol: a page is foreign-key self-sufficient, because its parent row is upserted
 * in the same batch ahead of its children. That removes the whole "page arrived before
 * the catalogue was created" failure class.
 */
export const PromoteConnectorCatalogSchema = z.object({
  id: RecordIdSchema,
  /** Absent → the connector platform is not promoted, and the WHOLE page is skipped
   *  with `kind: 'connector-catalog'`. See {@link PromotedProductIdSchema}. */
  connectorProductId: PromotedProductIdSchema.nullish(),
  /** Who actually BUILDS the connectors. Zapier inverts what the rest of this lane
   *  assumes — its app vendors write the connectors, not Zapier — so a reader
   *  defaulting to `platform` would attribute nine thousand connectors to the wrong
   *  party. `mixed` closes the space by construction (all / none / some). */
  connectorAuthorship: z.enum(CONNECTOR_AUTHORSHIP).nullish(),
  /**
   * `managedBy` is DELIBERATELY ABSENT (AECI-720). The flag is held AND enforced on this
   * side, so promote must not be able to set it: a catalogue starts `review` by column
   * default and only `PATCH /api/admin/connector-catalogs/:id` ever moves it. Accepting
   * it here would let any re-sync flip a vendor-managed catalogue back to `review` —
   * which is what this schema did until AECI-720, and the exact inversion of "the
   * surviving system owns who-controls-what". Zod strips unknown keys, so a sender that
   * still includes the field is ignored rather than rejected.
   */
  notes: z.string().nullish(),
});

export const PromoteConnectorSurfaceSchema = z.object({
  id: RecordIdSchema,
  /** Loose string — see the enum-discipline note in the file header. */
  surfaceRole: z.string().min(1),
  indexKind: z.string().nullish(),
  indexUrl: z.string().nullish(),
  /** The "as of" date §13.1 requires every reachable-tier claim to render with.
   *  It is per surface — one row — which is why the coverage surfaces should source
   *  provenance from here rather than from thousands of per-stub `lastSeenAt`s. */
  lastIngestedAt: z.string().nullish(),
  notes: z.string().nullish(),
});

export const PromoteConnectorStubSchema = z.object({
  id: RecordIdSchema,
  slug: z.string().min(1),
  label: z.string().nullish(),
  url: z.string().nullish(),
  directionRole: z.string().nullish(),
  actionCount: z.number().int().nullish(),
  /** **NULL means NEVER FETCHED, not "no actions".** The per-listing inventory is
   *  ~73k actions across MindCloud alone and is fetched lazily, so most stubs carry
   *  null indefinitely. A reader treating null as "none" would publish "this
   *  connector does nothing" about most of the catalogue. */
  actions: z.unknown().nullish(),
  /** The change-detection proxy for `actions`: the ingest compares hashes rather
   *  than deep-comparing a multi-kilobyte blob. That is what the field is for. */
  actionsHash: z.string().nullish(),
  actionsFetchedAt: z.string().nullish(),
  previousLabels: z.array(z.string()).nullish(),
  meta: z.unknown().nullish(),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  /** Tombstone, computed review-side off a `complete` ingest run — a truncated
   *  sitemap fetch is indistinguishable from a vendor deleting half their catalogue.
   *  AECi copies the outcome and never re-derives it, which is why the review app's
   *  ingest-run log is deliberately not mirrored. */
  removedAt: z.string().nullish(),
});

export const PromoteConnectorMappingSchema = z.object({
  id: RecordIdSchema,
  stubId: RecordIdSchema,
  /** Required for `mapped`/`ruled_out`, forbidden for the three stub-level
   *  decisions — enforced in the payload `superRefine`. Absent on a product-bearing
   *  status means the product is not promoted: a skip, not a 400. */
  productId: PromotedProductIdSchema.nullish(),
  status: z.enum(CONNECTOR_MAPPING_STATUSES),
  confidence: z.enum(CONNECTOR_MAPPING_CONFIDENCES).nullish(),
  /** Per ROW, not per stub: an edition inherits a platform's reach but not its
   *  evidence (AECI-697). */
  evidenceUrl: z.string().nullish(),
  /** {@link CONNECTOR_AUTO_DECIDER} or a person — the publication gate. */
  decidedBy: z.string().nullish(),
  decidedAt: z.string().nullish(),
  checkedAt: z.string().nullish(),
  notes: z.string().nullish(),
  // `catalogId` is deliberately NOT on the wire. It is a denormalised copy of the
  // stub's, "written from the stub row and never independently edited", and the
  // server derives it from the page's own catalogue — so a malformed payload cannot
  // break the invariant the triage index depends on.
});

export const PromoteConnectorPairSchema = z.object({
  id: RecordIdSchema,
  /** Canonically ordered: `stubAId < stubBId`. Enforced here so the caller gets an
   *  actionable 400 rather than a CHECK failure that rolls the whole page back. The
   *  vendor publishes both directions as separate pages; without the ordering every
   *  pair arrives twice and the unique index cannot see the collision. */
  stubAId: RecordIdSchema,
  stubBId: RecordIdSchema,
  urlAToB: z.string().nullish(),
  urlBToA: z.string().nullish(),
  /** `unknown` by default on purpose: appearing in an index says a page exists, not
   *  that anyone read it. `curated` is what §13.7 publishes. */
  surface: z.enum(CONNECTOR_PAIR_SURFACES).default('unknown'),
  classifiedAt: z.string().nullish(),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  removedAt: z.string().nullish(),
});

/**
 * Rows per page, across every array including `deleted`. A ceiling, not a target.
 *
 * It bounds three things at once: statements in one `db.batch`, chunked pre-reads
 * (`ceil(500 / 90) = 6` per table), and wire size — 500 stub rows serialise to
 * roughly 150 KB, comfortably inside the 512 KiB inline-params limit, so an ordinary
 * page never touches KV. A page whose stubs carry fetched `actions` blobs can exceed
 * that, which is exactly what the existing kick-off spill path already handles.
 */
export const CONNECTOR_PAGE_MAX_ROWS = 500;

export const PromoteConnectorPagePayloadSchema = z
  .object({
    /** Same idempotency key as the product promote, and used the same way: stamp it
     *  per (catalogue, page) BEFORE pushing so a retry replays the same id. */
    jobId: PromoteJobIdSchema.optional(),
    catalog: PromoteConnectorCatalogSchema,
    /** Page provenance. Carried for the audit row and telemetry only — nothing in the
     *  commit path depends on it, because pages are independent by construction. It
     *  lets an operator see "page 7 of 8 landed, 8 never did" without reconstructing
     *  it from job ids. */
    page: z.object({ index: z.number().int().min(0), of: z.number().int().min(1) }),
    surfaces: z.array(PromoteConnectorSurfaceSchema).default([]),
    stubs: z.array(PromoteConnectorStubSchema).default([]),
    mappings: z.array(PromoteConnectorMappingSchema).default([]),
    pairs: z.array(PromoteConnectorPairSchema).default([]),
    /**
     * Explicit hard deletes, by review record id.
     *
     * Necessary because in a PAGED mirror absence cannot mean deletion — a row missing
     * from this page is a row on another page. Only the two entities the review app
     * hard-deletes appear here; stubs and pairs retire via the `removedAt` tombstone,
     * which rides the ordinary upsert.
     */
    deleted: z
      .object({
        surfaces: z.array(RecordIdSchema).default([]),
        mappings: z.array(RecordIdSchema).default([]),
      })
      .optional(),
  })
  .superRefine((page, ctx) => {
    const rows =
      page.surfaces.length +
      page.stubs.length +
      page.mappings.length +
      page.pairs.length +
      (page.deleted?.surfaces.length ?? 0) +
      (page.deleted?.mappings.length ?? 0);

    if (rows > CONNECTOR_PAGE_MAX_ROWS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Page carries ${rows} rows; the ceiling is ${CONNECTOR_PAGE_MAX_ROWS}`,
        path: ['page'],
      });
    }
    if (rows === 0) {
      // A catalogue-header-only page would commit a ledger row for nothing. Mirrors
      // the product promote's empty-payload rejection.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Page carries no surfaces, stubs, mappings, pairs or deletions; send at least one',
        path: [],
      });
    }
    if (page.page.index >= page.page.of) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `page.index (${page.page.index}) must be less than page.of (${page.page.of})`,
        path: ['page', 'index'],
      });
    }

    const claimId = (seen: Set<string>, id: string, path: (string | number)[]) => {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate id "${id}" within one page — the last write would silently win`,
          path,
        });
      }
      seen.add(id);
    };
    const stubIds = new Set<string>();
    page.stubs.forEach((s, i) => claimId(stubIds, s.id, ['stubs', i, 'id']));
    const mappingIds = new Set<string>();
    page.mappings.forEach((m, i) => claimId(mappingIds, m.id, ['mappings', i, 'id']));
    const pairIds = new Set<string>();
    page.pairs.forEach((p, i) => claimId(pairIds, p.id, ['pairs', i, 'id']));

    page.pairs.forEach((p, i) => {
      if (p.stubAId >= p.stubBId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pairs must be canonically ordered: stubAId < stubBId',
          path: ['pairs', i, 'stubAId'],
        });
      }
    });

    // The two status families may not cross. `mapped` / `ruled_out` NAME a product;
    // the other three assert there is none to name, and a decision carrying a product
    // would collide on the partial unique index and fail the whole page at commit.
    const decisionStatuses = CONNECTOR_DECISION_STATUSES as readonly string[];
    const decisionsPerStub = new Map<string, number>();
    page.mappings.forEach((m, i) => {
      if (decisionStatuses.includes(m.status)) {
        if (m.productId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `status "${m.status}" is a stub-level decision and may not name a product`,
            path: ['mappings', i, 'productId'],
          });
        }
        const count = (decisionsPerStub.get(m.stubId) ?? 0) + 1;
        decisionsPerStub.set(m.stubId, count);
        if (count === 2) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `stub "${m.stubId}" carries more than one stub-level decision on this page`,
            path: ['mappings', i, 'status'],
          });
        }
      }
    });
  });

export type PromoteConnectorPagePayload = z.infer<typeof PromoteConnectorPagePayloadSchema>;
export type PromoteConnectorCatalog = z.infer<typeof PromoteConnectorCatalogSchema>;
export type PromoteConnectorSurface = z.infer<typeof PromoteConnectorSurfaceSchema>;
export type PromoteConnectorStub = z.infer<typeof PromoteConnectorStubSchema>;
export type PromoteConnectorMapping = z.infer<typeof PromoteConnectorMappingSchema>;
export type PromoteConnectorPair = z.infer<typeof PromoteConnectorPairSchema>;

// ─── Response ────────────────────────────────────────────────────────────────

/**
 * Per-table outcome. `unchanged` is the interesting number: it is what proves the
 * page was idempotent, and a steady-state re-sync should report it for everything.
 */
export interface PromoteConnectorTableCounts {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  skipped: number;
}

/**
 * The connector page's job result, served by the existing
 * `GET /api/promote/jobs/:id`.
 *
 * `kind: 'connector'` is the discriminant on `PromoteJobResponse['result']`.
 * `PromoteResponse` deliberately carries no `kind` — absence means product — so
 * widening the poll type moves no existing producer or consumer.
 *
 * There is **no ID map here**, and that is the point of keying these tables on the
 * review record id: the caller already knows every id it sent. Nothing to persist,
 * nothing to strand — the AECI-561 lost-response failure mode does not exist on this
 * path.
 */
export interface PromoteConnectorPageResponse {
  kind: 'connector';
  catalogId: string;
  page: { index: number; of: number };
  counts: {
    catalogs: PromoteConnectorTableCounts;
    surfaces: PromoteConnectorTableCounts;
    stubs: PromoteConnectorTableCounts;
    mappings: PromoteConnectorTableCounts;
    pairs: PromoteConnectorTableCounts;
  };
  /** Rows accepted but not written — an unpromoted product, a stub on a page not yet
   *  sent. Never fatal; re-send later. Always inspect it: on a full-mirror sync a
   *  `status: 'complete'` with 200 skipped mappings looks identical to a clean run. */
  skipped: PromoteSkipped[];
}
