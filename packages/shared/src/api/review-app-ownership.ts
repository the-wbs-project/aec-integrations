import { z } from 'zod';

/**
 * The ownership record: the live app tells the review app who owns one vendor's records
 * (AECI-1418, E6b.2; `REVIEW_APP_PROMOTE_API.md` §4d; ADR 0042). The receiver is the
 * review app's AECI-1412, which imports or mirrors this schema.
 *
 *   PUT {REVIEW_APP_OWNERSHIP_URL}/vendors/{vendorId}
 *   Authorization: Bearer {REVIEW_APP_OWNERSHIP_TOKEN}
 *
 * ── WHOLE RECORD, NOT A DELTA ────────────────────────────────────────────────────
 * Every send carries the vendor's complete current ownership state, read from D1 at
 * delivery time. A replay sends the same state again. An out-of-order delivery is
 * dropped by `version`. So the receiver converges on the latest state without knowing
 * which event caused the send.
 *
 * ── IDS ──────────────────────────────────────────────────────────────────────────
 * Every id is the AECi database UUID: the `supabaseId` the review app stores per record
 * (`REVIEW_APP_PROMOTE_API.md` §3.1). An id the receiver has never stored, such as a
 * product a vendor created itself, is ignored by the receiver, not an error.
 *
 * Attestations carry no ids here. The live app's `attestations` rows are replaced on
 * every promote and their ids are informational only (§3, "`claims` shape"), so the
 * review app cannot map them. It derives an attestation's owner from its integration.
 */

/** Who owns a record. */
export const RECORD_OWNERS = ['vendor', 'aeci'] as const;
export type RecordOwner = (typeof RECORD_OWNERS)[number];

/** Why a record was sent. Informational: the receiver acts on the state, not the reason. */
export const OWNERSHIP_SYNC_REASONS = [
  'claim_approved',
  'seat_provisioned',
  'proposal_accepted',
  'proposal_declined',
  'records_returned',
  'backfill',
] as const;
export type OwnershipSyncReason = (typeof OWNERSHIP_SYNC_REASONS)[number];

/** The live table an integration id comes from. Promote routes a connector-delivered
 *  edge into `connector_evidenced_pairs` (§3.4a), so the review app's stored
 *  `supabase_integration_id` may name either table. */
export const OWNERSHIP_INTEGRATION_TABLES = ['integrations', 'connector_evidenced_pairs'] as const;
export type OwnershipIntegrationTable = (typeof OWNERSHIP_INTEGRATION_TABLES)[number];

/** The record's own format version. Bumped only on a breaking change to this shape. */
export const OWNERSHIP_RECORD_SCHEMA_VERSION = 1;

const id = z.string().uuid();
const iso = z.string().datetime({ offset: true });

/**
 * One product joined to the vendor. `owner` is the product's own owner, not the
 * vendor's: a product co-owned with another owned vendor stays `vendor` after this
 * vendor returns its records (ADR 0042, ruling Q3).
 */
export const OwnershipProductSchema = z.object({
  id,
  owner: z.enum(RECORD_OWNERS),
});

/**
 * One integration where a product of this vendor is the source or the target (ruling
 * Q2). An edge where the vendor's product is only the `poweredByProduct` connector is
 * not listed. `owner` is `vendor` when either endpoint product is owned, by this vendor
 * or another. The per-row claim fence (§4b) and the vendor-created fence (§4c) apply on
 * top of it in promote, whatever this says.
 */
export const OwnershipIntegrationSchema = z.object({
  id,
  table: z.enum(OWNERSHIP_INTEGRATION_TABLES),
  owner: z.enum(RECORD_OWNERS),
});

/**
 * One product proposal addressed to this vendor (AECI-1416, AECI-1417). `ref` is the
 * review app's record ref (`p:rec…`) the proposal is keyed on, so the review app can
 * find its own record. `productId` is the product an accept created. An open proposal
 * the "Return records to AECi" action discarded is no longer listed.
 */
export const OwnershipProposalSchema = z.object({
  id,
  ref: z.string().min(1),
  state: z.enum(['open', 'accepted', 'declined']),
  decidedAt: iso.nullable(),
  productId: id.nullable(),
});

export const OwnershipRecordSchema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_RECORD_SCHEMA_VERSION),
    vendorId: id,
    owner: z.enum(RECORD_OWNERS),
    /** When the vendor took ownership. `null` exactly when `owner` is `aeci`. */
    ownedAt: iso.nullable(),
    /**
     * Monotonic per vendor: the epoch milliseconds of the D1 read the record was built
     * from. The receiver keeps the highest version it has seen and answers `409` to a
     * lower one. An equal version is the same state and is a no-op `200`.
     */
    version: z.number().int().positive(),
    /** `version` as an ISO instant, for humans. */
    asOf: iso,
    reason: z.enum(OWNERSHIP_SYNC_REASONS),
    products: z.array(OwnershipProductSchema),
    integrations: z.array(OwnershipIntegrationSchema),
    proposals: z.array(OwnershipProposalSchema),
  })
  .superRefine((record, ctx) => {
    if ((record.owner === 'vendor') !== (record.ownedAt !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['ownedAt'],
        message: 'ownedAt is set exactly when owner is "vendor"',
      });
    }
    // A product joined to an owned vendor is owned (ruling Q3).
    if (record.owner === 'vendor') {
      record.products.forEach((p, i) => {
        if (p.owner !== 'vendor') {
          ctx.addIssue({
            code: 'custom',
            path: ['products', i, 'owner'],
            message: 'every product of a vendor-owned vendor is vendor-owned',
          });
        }
      });
    }
  });
export type OwnershipRecord = z.infer<typeof OwnershipRecordSchema>;
export type OwnershipProduct = z.infer<typeof OwnershipProductSchema>;
export type OwnershipIntegration = z.infer<typeof OwnershipIntegrationSchema>;
export type OwnershipProposal = z.infer<typeof OwnershipProposalSchema>;

/**
 * The message on the `aeci-ownership-sync-{env}` queue. It carries no ownership data:
 * the consumer reads the current state from D1 at delivery and sends the whole record,
 * so a message enqueued before a later change still sends the later state.
 */
export const OwnershipSyncMessageSchema = z.object({
  vendorId: id,
  reason: z.enum(OWNERSHIP_SYNC_REASONS),
  enqueuedAt: iso,
});
export type OwnershipSyncMessage = z.infer<typeof OwnershipSyncMessageSchema>;

/** The receiver path for one vendor, under the configured base URL. */
export function ownershipRecordUrl(baseUrl: string, vendorId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/vendors/${encodeURIComponent(vendorId)}`;
}
