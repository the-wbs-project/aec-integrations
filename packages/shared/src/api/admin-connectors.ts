import { z } from 'zod';

import { ConnectorManagedBySchema } from './admin-connector-catalogs';
import { AdminAuditActorSchema, AdminAuditRowSchema } from './admin-vendors';
import { AdminNoteSchema } from './admin-panel';
import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';
import {
  CONNECTOR_AUTHORSHIP,
  CONNECTOR_MAPPING_CONFIDENCES,
  CONNECTOR_MAPPING_STATUSES,
  CONNECTOR_PAIR_SURFACES,
} from './promote-connector';

/**
 * The connector admin surface (AECI-722 — `docs/ADMIN_PANEL_SPEC.md` §5.9), the
 * **first read layer** over the six connector-lane tables AECI-714 landed
 * (`docs/DATABASE_SCHEMA.md` §9a). Five reads behind `requireAdmin()`:
 *
 *   GET /api/admin/connector-catalogs            — paginated catalogue list + counts
 *   GET /api/admin/connector-catalogs/:id        — basics, surfaces, counts, handover
 *   GET /api/admin/connector-catalogs/:id/stubs  — the triage queue
 *   GET /api/admin/connector-catalogs/:id/pairs  — evidenced vs reachable, per lane
 *   GET /api/admin/connector-catalogs/:id/audit  — the `audit_log` viewer
 *
 * ── READS ONLY, AND THAT IS A DECISION ──────────────────────────────────────
 * The originating issue asked this screen to approve and adjust mapping
 * proposals. It cannot, and the reason is in the sync rather than in the UI:
 * `planConnectorCatalogPage` upserts `connector_stub_mappings` with
 * `onConflictDoUpdate({ target: id, set: { ...values } })` across `status`,
 * `confidence`, `evidence_url`, `decided_by`, `decided_at`, `checked_at` and
 * `notes`, and it skips only rows it computes as *unchanged* — so an
 * AECi-authored decision is precisely the row that registers as changed and is
 * overwritten by the next page the review app sends. §9a states the same thing
 * as intent: *"Rows arrive only through `POST /api/promote/connector-catalog`.
 * Nothing else writes them."*
 *
 * AECi-side authoring therefore lands as `PATCH
 * /api/admin/connector-stub-mappings/:id` **gated on `managed_by = 'vendor'`** at
 * AECI-724 time — the one state in which the sync is frozen out of the catalogue
 * and cannot clobber the row (`STAGE_2_SPEC.md` §8.9(2) already pins its authz
 * model). Guarding the sync instead was rejected: it would make AECI-731's
 * acceptance criterion — *"re-running it end to end reports every row
 * `unchanged` and writes no `audit_log` row"* — unachievable for any catalogue an
 * operator had touched.
 *
 * The **one** write this screen drives is AECI-720's `PATCH
 * /api/admin/connector-catalogs/:id` (`./admin-connector-catalogs`), which flips
 * management authority and changes no catalogue content.
 *
 * ── CONVENTIONS ─────────────────────────────────────────────────────────────
 *  - **Required-nullable, never optional (R10).** Everything genuinely absent is
 *    `.nullable()`, so a missed construction site fails `validateResponseInDev`
 *    rather than shipping as `undefined`.
 *  - **Bare `paginatedResponseSchema`**, the Operations lineage
 *    (`admin-vendors.ts` / `admin-users.ts`), not the console's
 *    `.extend({ generated_at, source, notes })` shape.
 *  - **`advisories`, not `notes`, carries the `AdminNote[]` envelope.** Three of
 *    these tables project a real `notes` **column** (catalogs, surfaces,
 *    mappings), and §9a's whole premise is that review → AECi is *"a copy rather
 *    than a transformation: same column names, same semantics."* Keeping the
 *    column's name cost one deviation from the console's field name; renaming
 *    the column would have cost three deviations from the projection.
 *  - **Ids are `RecordId`-shaped text, not uuids.** Five of the six tables use
 *    the review app's own record id as the primary key (§9a), so `z.string().uuid()`
 *    would reject every real row. Only `products` / `vendors` refs are uuids.
 */

// ─── Shared vocabulary ───────────────────────────────────────────────────────

/** A review-app record id, used as the app-DB primary key on five of six tables. */
const RecordIdSchema = z.string().min(1).max(64);

export const ConnectorAuthorshipSchema = z.enum(CONNECTOR_AUTHORSHIP);
export const ConnectorMappingStatusSchema = z.enum(CONNECTOR_MAPPING_STATUSES);
export const ConnectorMappingConfidenceSchema = z.enum(CONNECTOR_MAPPING_CONFIDENCES);
export const ConnectorPairSurfaceSchema = z.enum(CONNECTOR_PAIR_SURFACES);

/**
 * Per-catalogue tallies, as a named block rather than loose fields.
 *
 * `stubs_undecided` is stubs carrying **no** mapping row at all. §9a.4 is explicit
 * that *"there is no `pending` status — the absence of a row is pending"*, so this
 * is an anti-join and not a status count; it is also the number the triage queue
 * exists to burn down.
 *
 * `mappings_publishable` is §9a.4's publication gate verbatim — `status = 'mapped'
 * AND product_id IS NOT NULL AND decided_by IS NOT NULL AND decided_by <>
 * 'auto-name-match'`. Provenance, never confidence: gating on `confidence` would
 * publish hundreds of machine guesses sitting at `medium`.
 *
 * `pairs_*` counts `connector_pairs` by `surface`. They are **not** a reachable-tier
 * count and must never be presented as one — §13.1/§13.5 forbid counting reachable
 * anywhere. They describe how many pair pages the vendor publishes, split by whether
 * anyone has classified them.
 */
export const AdminConnectorCountsSchema = z.object({
  surfaces: z.number().int().min(0),
  stubs_total: z.number().int().min(0),
  /** Tombstoned by a `complete` review-side ingest run, never re-derived here. */
  stubs_removed: z.number().int().min(0),
  stubs_undecided: z.number().int().min(0),
  mappings_mapped: z.number().int().min(0),
  mappings_ruled_out: z.number().int().min(0),
  mappings_out_of_scope: z.number().int().min(0),
  mappings_no_record: z.number().int().min(0),
  mappings_ambiguous_parked: z.number().int().min(0),
  mappings_publishable: z.number().int().min(0),
  pairs_curated: z.number().int().min(0),
  pairs_generated: z.number().int().min(0),
  pairs_unknown: z.number().int().min(0),
  /** `connector_evidenced_pairs` for this connector. Zero until AECI-721 fills it. */
  evidenced_pairs: z.number().int().min(0),
});
export type AdminConnectorCounts = z.infer<typeof AdminConnectorCountsSchema>;

// ─── GET /api/admin/connector-catalogs ───────────────────────────────────────

/** `managed_by` is already a string enum on the wire, so it needs no
 *  enum-plus-transform dance — that idiom (AECI-691) exists for booleans. */
export const AdminConnectorCatalogsListQuerySchema = PageQuerySchema.extend({
  managed_by: ConnectorManagedBySchema.optional(),
  /** Substring over the connector product's name or slug. Wildcards escaped. */
  search: z.string().optional(),
});
export type AdminConnectorCatalogsListQuery = z.infer<typeof AdminConnectorCatalogsListQuerySchema>;

export const AdminConnectorCatalogRowSchema = z.object({
  id: RecordIdSchema,
  /** NOT NULL in the schema — a catalogue whose platform is unpromoted is
   *  reported in the sync's `skipped[]` rather than stored half-formed. */
  connector_product: LinkRefSchema,
  /** Matters because Zapier inverts the lane's assumption: its app vendors write
   *  the connectors, not Zapier. A reader defaulting to `platform` would
   *  attribute nine thousand connectors to the wrong party (§9a.1). */
  connector_authorship: ConnectorAuthorshipSchema.nullable(),
  managed_by: ConnectorManagedBySchema,
  notes: z.string().nullable(),
  /**
   * MAX(`connector_catalog_surfaces.last_ingested_at`) — the catalogue-freshness
   * signal `STAGE_2_SPEC.md` §8.9(4) makes this screen answerable for, and the
   * "as of" date §13.1 requires every reachable-tier claim to carry. Sourced per
   * surface rather than from thousands of per-stub `last_seen_at` values (§9a.2).
   * `null` = no surface has ever reported an ingest.
   */
  last_ingested_at: z.string().nullable(),
  counts: AdminConnectorCountsSchema,
  updated_at: z.string(),
});
export type AdminConnectorCatalogRow = z.infer<typeof AdminConnectorCatalogRowSchema>;

export const AdminConnectorCatalogsListResponseSchema = paginatedResponseSchema(
  AdminConnectorCatalogRowSchema,
);
export type AdminConnectorCatalogsListResponse = z.infer<
  typeof AdminConnectorCatalogsListResponseSchema
>;

// ─── GET /api/admin/connector-catalogs/:id ───────────────────────────────────

export const AdminConnectorSurfaceSchema = z.object({
  id: RecordIdSchema,
  /** `apps | pairs | sources | destinations | all` — deliberately unconstrained
   *  on both sides (§9a's CHECK discipline), so no enum here either. */
  surface_role: z.string().min(1),
  index_kind: z.string().nullable(),
  index_url: z.string().nullable(),
  last_ingested_at: z.string().nullable(),
  notes: z.string().nullable(),
});
export type AdminConnectorSurface = z.infer<typeof AdminConnectorSurfaceSchema>;

/**
 * Who a catalogue was handed to, derived from `audit_log`.
 *
 * The AECI-720 endpoint records `vendorId` and `reason` **only** in the audit
 * row's `metadata` and persists neither on `connector_catalogs`, so the trail is
 * the sole record. `AdminAuditRow` deliberately does not carry `metadata` — it is
 * rendered by the shared `<aec-audit-trail>` for vendors too, and pushing
 * free-form JSON from ~34 writers into a shared render path is exactly what that
 * schema's own docblock argues against. So the handover is derived server-side
 * into this fixed shape instead of widening the generic row.
 *
 * **Present only while `managed_by = 'vendor'`.** A catalogue reclaimed to
 * `review` reports `null`, because rendering the last handover beside a
 * review-managed lane would read as if it were still live. The history stays
 * legible in the audit trail, which is where history belongs.
 *
 * `vendor` is nullable within a present handover: `vendorId` is optional on the
 * PATCH, since the partnership track may settle before the vendor has a record.
 */
export const AdminConnectorHandoverSchema = z.object({
  vendor: LinkRefSchema.nullable(),
  reason: z.string().nullable(),
  actor: AdminAuditActorSchema.nullable(),
  at: z.string(),
});
export type AdminConnectorHandover = z.infer<typeof AdminConnectorHandoverSchema>;

export const AdminConnectorCatalogDetailSchema = AdminConnectorCatalogRowSchema.extend({
  surfaces: z.array(AdminConnectorSurfaceSchema),
  handover: AdminConnectorHandoverSchema.nullable(),
  /** The honesty envelope. Named `advisories` so the projected `notes` column
   *  above keeps its own name — see the module docblock. */
  advisories: z.array(AdminNoteSchema),
  /** `false` = the GoTrue seam was unavailable, so `handover.actor.email` is
   *  `null` for that reason rather than because the account has no address. */
  actor_emails_available: z.boolean(),
});
export type AdminConnectorCatalogDetail = z.infer<typeof AdminConnectorCatalogDetailSchema>;

// ─── GET /api/admin/connector-catalogs/:id/stubs ─────────────────────────────

/** `undecided` is not a stored status — it is the anti-join (§9a.4). It sits in
 *  the same query enum because it is the same question an operator is asking. */
export const AdminConnectorStubStateSchema = z.enum(['undecided', ...CONNECTOR_MAPPING_STATUSES]);
export type AdminConnectorStubState = z.infer<typeof AdminConnectorStubStateSchema>;

export const AdminConnectorStubsQuerySchema = PageQuerySchema.extend({
  state: AdminConnectorStubStateSchema.optional(),
  /** Only stubs carrying a mapping the auto name-match pass decided — the
   *  "low-confidence rows" the triage queue exists to review. */
  proposals_only: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  confidence: ConnectorMappingConfidenceSchema.optional(),
  /** Substring over the stub's slug or label. */
  search: z.string().optional(),
  /** Tombstoned stubs are hidden by default; a removed listing is not triage. */
  include_removed: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
export type AdminConnectorStubsQuery = z.infer<typeof AdminConnectorStubsQuerySchema>;

/**
 * What somebody concluded about a stub. Many-to-many: one listing may be several
 * of our products, and one product may appear as several listings (§9a.4).
 *
 * `product` is `null` on the three decision statuses — `out_of_scope`,
 * `no_record`, `ambiguous_parked` assert there is no product to name. It can also
 * be `null` on a `mapped` row whose product was deleted (`ON DELETE SET NULL`),
 * which §9a.4 says *"is meant to be visible, not tidied away"*.
 */
export const AdminConnectorMappingSchema = z.object({
  id: RecordIdSchema,
  status: ConnectorMappingStatusSchema,
  product: LinkRefSchema.nullable(),
  confidence: ConnectorMappingConfidenceSchema.nullable(),
  evidence_url: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  checked_at: z.string().nullable(),
  notes: z.string().nullable(),
  /** This row alone clears §9a.4's provenance gate. Derived server-side so the
   *  UI cannot re-implement the predicate and drift from it. */
  publishable: z.boolean(),
});
export type AdminConnectorMapping = z.infer<typeof AdminConnectorMappingSchema>;

export const AdminConnectorStubRowSchema = z.object({
  id: RecordIdSchema,
  slug: z.string().min(1),
  label: z.string().nullable(),
  url: z.string().nullable(),
  /** `source | destination | both`, or null. Unconstrained vocabulary (§9a). */
  direction_role: z.string().nullable(),
  action_count: z.number().int().min(0).nullable(),
  /**
   * Whether the per-listing action inventory has EVER been fetched.
   *
   * `connector_stubs.actions` is NULL for most stubs indefinitely — the inventory
   * is ~73k actions across MindCloud alone and is fetched lazily. §9a.3: *"NULL
   * means never fetched, not 'no actions'. A reader treating null as 'none' would
   * publish 'this connector does nothing' about most of the catalogue."* The blob
   * itself never crosses this wire; only the fact of it, so the UI cannot render
   * an absent inventory as an empty one.
   */
  actions_fetched: z.boolean(),
  actions_fetched_at: z.string().nullable(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  /** Tombstone. Computed review-side off a `complete` ingest run and copied
   *  verbatim — a truncated sitemap fetch is indistinguishable from a vendor
   *  deleting half their catalogue, so AECi never re-derives it (§9a.3). */
  removed_at: z.string().nullable(),
  mappings: z.array(AdminConnectorMappingSchema),
});
export type AdminConnectorStubRow = z.infer<typeof AdminConnectorStubRowSchema>;

export const AdminConnectorStubsResponseSchema = paginatedResponseSchema(
  AdminConnectorStubRowSchema,
).extend({
  advisories: z.array(AdminNoteSchema),
});
export type AdminConnectorStubsResponse = z.infer<typeof AdminConnectorStubsResponseSchema>;

// ─── GET /api/admin/connector-catalogs/:id/pairs ─────────────────────────────

/**
 * One lane per request, because the two lanes are different shapes and §13.3
 * requires **one `<table>` per lane** rather than group-header rows interleaved
 * into a single `<tbody>` — a header row inside a table body has no accessible
 * name relationship to the rows beneath it.
 */
export const AdminConnectorPairLaneSchema = z.enum(['reachable', 'evidenced']);
export type AdminConnectorPairLane = z.infer<typeof AdminConnectorPairLaneSchema>;

export const AdminConnectorPairsQuerySchema = PageQuerySchema.extend({
  lane: AdminConnectorPairLaneSchema.default('reachable'),
  /** Reachable lane only; ignored on `evidenced`. */
  surface: ConnectorPairSurfaceSchema.optional(),
});
export type AdminConnectorPairsQuery = z.infer<typeof AdminConnectorPairsQuerySchema>;

/** One end of a published pair, with the gate inputs that end contributes. */
export const AdminConnectorPairSideSchema = z.object({
  stub_id: RecordIdSchema,
  slug: z.string().min(1),
  label: z.string().nullable(),
  /** The product this side maps to, if any mapping names one. */
  product: LinkRefSchema.nullable(),
  /** Whether the mapping behind `product` clears §9a.4's provenance gate. */
  publishable: z.boolean(),
});
export type AdminConnectorPairSide = z.infer<typeof AdminConnectorPairSideSchema>;

/**
 * A pair the vendor publishes a page for — **not** the reachable tier and **not**
 * an assertion of delivery.
 *
 * §9a.5: this table exists for one thing the mapping graph cannot supply,
 * `surface`. Reachability is derivable from stubs + mappings alone; *publication*
 * is not, because curated-vs-generated is a classification on the vendor's own
 * published pair row.
 *
 * **These rows render the publication gate's INPUTS, never its verdict.** §13.7's
 * four-clause rule belongs to AECI-716, and its clause (c) reuses Addendum A
 * §11.4's "meaningful no" scoring, which does not exist in this repo. Clause (b)
 * — the pair being undelivered — is likewise not computed here. What is shown is
 * clause (a) (both sides in our catalog), the provenance half of clause (d), and
 * `surface`. The `publication_gate_inputs_only` advisory says so on the wire.
 */
export const AdminConnectorReachablePairRowSchema = z.object({
  id: RecordIdSchema,
  /** Defaults to `unknown` on purpose: appearing in an index says a page exists,
   *  not that anyone has read it (§9a.5). */
  surface: ConnectorPairSurfaceSchema,
  side_a: AdminConnectorPairSideSchema,
  side_b: AdminConnectorPairSideSchema,
  url_a_to_b: z.string().nullable(),
  url_b_to_a: z.string().nullable(),
  classified_at: z.string().nullable(),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  removed_at: z.string().nullable(),
});
export type AdminConnectorReachablePairRow = z.infer<typeof AdminConnectorReachablePairRowSchema>;

/**
 * The delivered tier for connector-delivered edges (§13.1).
 *
 * AECI-714 created `connector_evidenced_pairs` **empty and nothing writes it**;
 * AECI-721 migrates the ~326 `integrations.powered_by_product_id` edges in. So
 * this lane renders an empty state today, and that empty state is the honest
 * reading — never a zero dressed up as a measurement.
 */
export const AdminConnectorEvidencedPairRowSchema = z.object({
  id: z.string().uuid(),
  product_a: LinkRefSchema,
  product_b: LinkRefSchema,
  name: z.string().nullable(),
  /** Present from day one because §13.2 records an accountable residue: ~20
   *  `marketplace-app`-with-`powered_by` edges have a real third-party builder. */
  built_by_vendor: LinkRefSchema.nullable(),
  mechanism_name: z.string().nullable(),
  /** `claims`' `a_to_b | b_to_a | both` vocabulary, not `integrations`'
   *  `one-way | bidirectional` — once a pair is canonicalised, "one-way" no
   *  longer says which way (§9a.6). */
  direction: z.enum(['a_to_b', 'b_to_a', 'both']).nullable(),
  listing_url: z.string().nullable(),
  last_reviewed_at: z.string().nullable(),
  maintained_by: z.enum(['aeci', 'vendor']),
});
export type AdminConnectorEvidencedPairRow = z.infer<typeof AdminConnectorEvidencedPairRowSchema>;

export const AdminConnectorPairsResponseSchema = z.discriminatedUnion('lane', [
  paginatedResponseSchema(AdminConnectorReachablePairRowSchema).extend({
    lane: z.literal('reachable'),
    advisories: z.array(AdminNoteSchema),
  }),
  paginatedResponseSchema(AdminConnectorEvidencedPairRowSchema).extend({
    lane: z.literal('evidenced'),
    advisories: z.array(AdminNoteSchema),
  }),
]);
export type AdminConnectorPairsResponse = z.infer<typeof AdminConnectorPairsResponseSchema>;

// ─── GET /api/admin/connector-catalogs/:id/audit ─────────────────────────────

export const AdminConnectorAuditQuerySchema = PageQuerySchema;
export type AdminConnectorAuditQuery = z.infer<typeof AdminConnectorAuditQuerySchema>;

/**
 * The catalogue's audit trail. **One disjunct**, not `admin-vendors.ts`'s four:
 * both writers — AECI-720's flip and the sync's own `connector_catalog.synced`
 * run row — file under `entity_type = 'connector_catalog'` with the catalogue id,
 * so `audit_log_entity_idx` answers it directly with no new index.
 *
 * That the sync's rows land here is the point rather than noise: they are the
 * durable record of when the feed last actually delivered something, which is the
 * other half of the §8.9(4) freshness duty.
 */
export const AdminConnectorAuditResponseSchema = paginatedResponseSchema(
  AdminAuditRowSchema,
).extend({
  actor_emails_available: z.boolean(),
});
export type AdminConnectorAuditResponse = z.infer<typeof AdminConnectorAuditResponseSchema>;
