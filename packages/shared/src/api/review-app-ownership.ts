import { z } from 'zod';

import { MAINTAINED_BY } from './common';
import { CLAIM_DIRECTIONS } from './integrations';
import {
  ATTESTATION_SOURCES,
  MECHANISM_KINDS,
  PRODUCT_ROLES,
  PromoteAttestationSchema,
  PromoteClaimSchema,
  PromoteIntegrationSchema,
  PromoteProductSchema,
  PromoteUsefulnessSchema,
  PromoteVendorSchema,
} from './promote';

/**
 * The ownership record: the live app tells the review app who owns one vendor's records
 * (AECI-1418, E6b.2; `REVIEW_APP_PROMOTE_API.md` §4d; ADR 0042) and, from schema
 * version 2, what those records say (AECI-1413; ADR 0044). The receiver is the review
 * app's AECI-1412, which imports or mirrors this schema.
 *
 *   PUT {REVIEW_APP_OWNERSHIP_URL}/vendors/{vendorId}
 *   Authorization: Bearer {REVIEW_APP_OWNERSHIP_TOKEN}
 *
 * ── WHOLE RECORD, NOT A DELTA ────────────────────────────────────────────────────
 * Every send carries the vendor's complete current state, read from D1 at delivery
 * time. A replay sends the same state again. An out-of-order delivery is dropped by
 * `version`. So the receiver converges on the latest state without knowing which event
 * caused the send.
 *
 * ── TWO SCHEMA VERSIONS ──────────────────────────────────────────────────────────
 * `schemaVersion: 1` carries ids and owners only. `schemaVersion: 2` adds the content
 * of every vendor-owned record, so the review app's copy of a claimed company becomes a
 * read-only mirror of live truth (ADR 0044). Which one the producer sends is the
 * per-env `REVIEW_APP_MIRROR_SCHEMA` var; the receiver accepts both.
 *
 * ── IDS ──────────────────────────────────────────────────────────────────────────
 * Every id is the AECi database UUID: the `supabaseId` the review app stores per record
 * (`REVIEW_APP_PROMOTE_API.md` §3.1). Under v1 an id the receiver has never stored,
 * such as a product a vendor created itself, is ignored. Under v2 the receiver creates
 * a read-only mirror row for it from the content: that is how vendor-created and
 * proposal-accepted products reach the review side.
 *
 * Attestations carry no ids. The live app's `attestations` rows are replaced on every
 * promote and their ids are informational only (§3, "`claims` shape"), so the review
 * app cannot map them. Under v2 each claim slot is keyed by its natural key
 * `{ dataObject, direction, source }` inside its integration.
 *
 * ── WIRE NAMES ───────────────────────────────────────────────────────────────────
 * v2 content uses the promote wire names (`./promote`). The review app already maps
 * those to its own columns, so it mirrors in reverse with no new vocabulary. Fields
 * promote never carries are the live-only fields listed in
 * `apps/api/src/lib/review-mirror-fields.ts`, which is also the one map from live
 * columns to these names.
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
  // AECI-1413: a content edit on an owned vendor's records, by the vendor or by AECi.
  'vendor_edit',
  'admin_edit',
] as const;
export type OwnershipSyncReason = (typeof OWNERSHIP_SYNC_REASONS)[number];

/** The live table an integration id comes from. Promote routes a connector-delivered
 *  edge into `connector_evidenced_pairs` (§3.4a), so the review app's stored
 *  `supabase_integration_id` may name either table. */
export const OWNERSHIP_INTEGRATION_TABLES = ['integrations', 'connector_evidenced_pairs'] as const;
export type OwnershipIntegrationTable = (typeof OWNERSHIP_INTEGRATION_TABLES)[number];

/** Schema version 1: ids and owners only (AECI-1418). */
export const OWNERSHIP_RECORD_SCHEMA_V1 = 1;
/** Schema version 2: v1 plus the content of every vendor-owned record (AECI-1413). */
export const OWNERSHIP_RECORD_SCHEMA_V2 = 2;
/** Every version the receiver accepts, oldest first. */
export const OWNERSHIP_RECORD_SCHEMA_VERSIONS = [
  OWNERSHIP_RECORD_SCHEMA_V1,
  OWNERSHIP_RECORD_SCHEMA_V2,
] as const;
export type OwnershipRecordSchemaVersion = (typeof OWNERSHIP_RECORD_SCHEMA_VERSIONS)[number];

/**
 * The v1 format version, kept under its original name for the v1 builder. Bumped only
 * on a breaking change to the v1 shape, which is now frozen.
 */
export const OWNERSHIP_RECORD_SCHEMA_VERSION = OWNERSHIP_RECORD_SCHEMA_V1;

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

/** The fields every schema version shares, in wire order. */
const recordHeader = {
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
};

interface RecordHeaderFields {
  owner: RecordOwner;
  ownedAt: string | null;
  products: readonly { owner: RecordOwner }[];
}

/** The rules every schema version shares. */
function refineRecordHeader(record: RecordHeaderFields, ctx: z.RefinementCtx): void {
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
}

/** The v1 record (AECI-1418). Frozen: a change here is a new schema version. */
export const OwnershipRecordV1Schema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_RECORD_SCHEMA_V1),
    ...recordHeader,
    products: z.array(OwnershipProductSchema),
    integrations: z.array(OwnershipIntegrationSchema),
    proposals: z.array(OwnershipProposalSchema),
  })
  .superRefine(refineRecordHeader);

// ─── v2 content (AECI-1413) ──────────────────────────────────────────────────────
//
// Content is the whole current value of each field, never a delta: every key is
// present, `null` when the live column is empty. The promote field schemas are reused
// through `.pick(...).required()`, which keeps their value rules and makes each key
// mandatory while still allowing `null`. Overrides follow where the stored value is
// narrower than the promote input (no `ref` form, no legacy direction, no defaults).

/** A reference to an AECi record. The promote `EntityRef` minus its `ref` form: a
 *  mirror names stored rows only. */
export const OwnershipEntityRefSchema = z.object({ supabaseId: id });
export type OwnershipEntityRef = z.infer<typeof OwnershipEntityRefSchema>;

const maintainedBy = z.enum(MAINTAINED_BY);
/** A stored timestamp column, sent as stored. Loose like the rest of the promote
 *  contract: a SQLite `datetime('now')` default is not ISO-8601 with an offset, and a
 *  mirror must not refuse a value the live app already holds. */
const storedInstant = z.string().min(1).nullable();
/** A slug list with set semantics. The hash sorts it, so order carries no meaning. */
const slugList = z.array(z.string().min(1));

/**
 * The vendor's own fields. Left out on purpose: AECi's research and scoring columns
 * (`sourceUrl`, `adminNotes`, the VQS scores, `promotionStatus`), which the review app
 * authors, and `verified`, which is the paid entitlement bit (AECI-520), not content.
 */
export const OwnershipVendorContentSchema = PromoteVendorSchema.pick({
  companyName: true,
  description: true,
  website: true,
  headquarters: true,
  foundedYear: true,
  publicPrivate: true,
  parentCompany: true,
  linkedinUrl: true,
  xUrl: true,
  facebookUrl: true,
  instagramUrl: true,
  youtubeUrl: true,
  crunchbaseUrl: true,
  wikiUrl: true,
  githubOrg: true,
  phoneNumber: true,
  contactEmail: true,
  logoUrl: true,
  lastReviewedAt: true,
})
  .required()
  .extend({ maintainedBy });
export type OwnershipVendorContent = z.infer<typeof OwnershipVendorContentSchema>;

/** One release of a product (`product_versions`), live-only. Listed in the product's
 *  own release order, which is meaningful, so the hash keeps it. */
export const OwnershipProductVersionSchema = z.object({
  label: z.string().min(1),
  releasedAt: z.string().nullable(),
  sunsetAt: z.string().nullable(),
});
export type OwnershipProductVersion = z.infer<typeof OwnershipProductVersionSchema>;

/**
 * One owned product's fields. Taxonomy arrays are slugs. Left out on purpose: the
 * research, priority, search and score columns and `adminNotes`, which the review app
 * authors, `hasApiDocs` and `extensionOf`, which stay AECi's, and the aggregates
 * (`integration_count`, `review_count`, rating averages), which no vendor edits.
 */
export const OwnershipProductContentSchema = PromoteProductSchema.pick({
  name: true,
  description: true,
  website: true,
  toolIntegrationsUrl: true,
  apiDocsUrl: true,
  logoUrl: true,
  lastReviewedAt: true,
})
  .required()
  .extend({
    /** Server-generated and never on the promote wire. Lets a mirror row created for
     *  an unknown id point at its live URL. */
    slug: z.string().min(1),
    productRole: z.enum(PRODUCT_ROLES),
    usefulness: PromoteUsefulnessSchema.nullable(),
    categories: slugList,
    audiences: slugList,
    phases: slugList,
    trades: slugList,
    maintainedBy,
    versions: z.array(OwnershipProductVersionSchema),
  });
export type OwnershipProductContent = z.infer<typeof OwnershipProductContentSchema>;

/** A v2 product entry: the v1 entry plus `content`, present exactly when owned. */
export const OwnershipProductV2Schema = OwnershipProductSchema.extend({
  content: OwnershipProductContentSchema.optional(),
});
export type OwnershipProductV2 = z.infer<typeof OwnershipProductV2Schema>;

/** One link an endpoint vendor set on an integration (`integration_vendor_links`). */
export const OwnershipVendorLinkSchema = z.object({
  productId: id,
  kind: z.enum(['listing', 'docs']),
  url: z.string().min(1),
});
export type OwnershipVendorLink = z.infer<typeof OwnershipVendorLinkSchema>;

/**
 * One integration's fields, for either table.
 *
 * On a `connector_evidenced_pairs` row `sourceProduct` and `targetProduct` are the
 * pair's id-sorted A and B, `poweredByProduct` is its connector, and `direction` and
 * every claim are framed to that A and B (AECI-996). That row stores no
 * `mechanismKind`, so the key is absent there. On an `integrations` row it is present,
 * `null` when unset. Left out on purpose: `notes`, AECi's own curation column.
 */
export const OwnershipIntegrationContentSchema = PromoteIntegrationSchema.pick({
  name: true,
  mechanismName: true,
  description: true,
  listingUrl: true,
  docsUrl: true,
  website: true,
  mechanismUrl: true,
  pricingModel: true,
  maturity: true,
  lastReviewedAt: true,
})
  .required()
  .extend({
    sourceProduct: OwnershipEntityRefSchema,
    targetProduct: OwnershipEntityRefSchema,
    builtByVendor: OwnershipEntityRefSchema.nullable(),
    poweredByProduct: OwnershipEntityRefSchema.nullable(),
    mechanismKind: z.enum(MECHANISM_KINDS).nullable().optional(),
    direction: z.enum(CLAIM_DIRECTIONS).nullable(),
    pricingUrl: z.string().nullable(),
    maintainedBy,
    origin: z.enum(['aeci', 'vendor']),
    claimedAt: storedInstant,
    retiredAt: storedInstant,
    vendorLinks: z.array(OwnershipVendorLinkSchema),
  });
export type OwnershipIntegrationContent = z.infer<typeof OwnershipIntegrationContentSchema>;

/**
 * One claim slot on an integration: a claim (`dataObject` + `direction`) and the
 * attestation one `source` holds on it. Keyed by `{ dataObject, direction, source }`,
 * unique within the integration. `dataObject` is the data-object slug. The version
 * fields are `product_versions` labels of the attesting endpoint's product.
 *
 * The entry is the slot's active attestation. When the slot has none, it is the most
 * recently retracted one, with `retractedAt` set, so the review side learns a position
 * was withdrawn. A slot that never held an attestation is not listed.
 */
export const OwnershipClaimSchema = z.object({
  dataObject: PromoteClaimSchema.shape.dataObject,
  direction: PromoteClaimSchema.shape.direction,
  source: z.enum(ATTESTATION_SOURCES),
  asserted: PromoteAttestationSchema.shape.asserted,
  note: z.string().nullable(),
  introducedVersion: z.string().min(1).nullable(),
  deprecatedVersion: z.string().min(1).nullable(),
  retractedAt: storedInstant,
});
export type OwnershipClaim = z.infer<typeof OwnershipClaimSchema>;

/** A v2 integration entry: the v1 entry plus `content` and `claims`, both present
 *  exactly when owned. */
export const OwnershipIntegrationV2Schema = OwnershipIntegrationSchema.extend({
  content: OwnershipIntegrationContentSchema.optional(),
  claims: z.array(OwnershipClaimSchema).optional(),
});
export type OwnershipIntegrationV2 = z.infer<typeof OwnershipIntegrationV2Schema>;

/** A lowercase hex SHA-256 digest. */
export const RecordHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256');

/** The natural key of a claim slot, for uniqueness checks and sorting. */
export function ownershipClaimKey(c: Pick<OwnershipClaim, 'dataObject' | 'direction' | 'source'>) {
  return `${c.dataObject}\u0000${c.direction}\u0000${c.source}`;
}

/**
 * The v2 record (AECI-1413). Everything in v1, plus:
 *
 * - `vendor`: the vendor's content. Present exactly when `owner` is `vendor`, else
 *   `null`: a returned vendor's own fields are the review app's again.
 * - `products[].content` and `integrations[].content` / `claims`: present exactly
 *   when that record is vendor-owned.
 * - `recordHash`: {@link computeOwnershipRecordHash} of this record. The receiver
 *   stores it and echoes it on the versions read; the drift check compares it.
 */
export const OwnershipRecordV2Schema = z
  .object({
    schemaVersion: z.literal(OWNERSHIP_RECORD_SCHEMA_V2),
    ...recordHeader,
    vendor: OwnershipVendorContentSchema.nullable(),
    products: z.array(OwnershipProductV2Schema),
    integrations: z.array(OwnershipIntegrationV2Schema),
    proposals: z.array(OwnershipProposalSchema),
    recordHash: RecordHashSchema,
  })
  .superRefine((record, ctx) => {
    refineRecordHeader(record, ctx);
    if ((record.owner === 'vendor') !== (record.vendor !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['vendor'],
        message: 'vendor content is present exactly when owner is "vendor"',
      });
    }
    record.products.forEach((p, i) => {
      if ((p.owner === 'vendor') !== (p.content !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['products', i, 'content'],
          message: 'product content is present exactly when the product is vendor-owned',
        });
      }
    });
    record.integrations.forEach((intg, i) => {
      const owned = intg.owner === 'vendor';
      if (owned !== (intg.content !== undefined) || owned !== (intg.claims !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['integrations', i, 'content'],
          message:
            'integration content and claims are present exactly when the integration is vendor-owned',
        });
      }
      const content = intg.content;
      if (content) {
        const isPair = intg.table === 'connector_evidenced_pairs';
        if (isPair && content.mechanismKind !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['integrations', i, 'content', 'mechanismKind'],
            message: 'a connector_evidenced_pairs row stores no mechanismKind',
          });
        }
        if (!isPair && content.mechanismKind === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['integrations', i, 'content', 'mechanismKind'],
            message: 'an integrations row sends mechanismKind, null when unset',
          });
        }
        if (isPair && content.poweredByProduct === null) {
          ctx.addIssue({
            code: 'custom',
            path: ['integrations', i, 'content', 'poweredByProduct'],
            message: 'a connector_evidenced_pairs row always names its connector',
          });
        }
      }
      const seen = new Set<string>();
      intg.claims?.forEach((c, j) => {
        const key = ownershipClaimKey(c);
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['integrations', i, 'claims', j],
            message: 'claim slots are unique by { dataObject, direction, source }',
          });
        }
        seen.add(key);
      });
    });
  });

/** What the receiver accepts: either schema version, told apart by `schemaVersion`. */
export const OwnershipRecordSchema = z.discriminatedUnion('schemaVersion', [
  OwnershipRecordV1Schema,
  OwnershipRecordV2Schema,
]);
export type OwnershipRecord = z.infer<typeof OwnershipRecordSchema>;
export type OwnershipRecordV1 = z.infer<typeof OwnershipRecordV1Schema>;
export type OwnershipRecordV2 = z.infer<typeof OwnershipRecordV2Schema>;
export type OwnershipProduct = z.infer<typeof OwnershipProductSchema>;
export type OwnershipIntegration = z.infer<typeof OwnershipIntegrationSchema>;
export type OwnershipProposal = z.infer<typeof OwnershipProposalSchema>;

// ─── recordHash ──────────────────────────────────────────────────────────────────

/**
 * Binary (UTF-16 code unit) string order. Every value sorted for the hash is a key,
 * an id, a slug or an enum, never text a human reads in order, so `compareText` is
 * the wrong tool here (`ANGULAR_STYLE_GUIDE.md` §20a keeps such orderings binary).
 * Its collator would also tie the hash to the runtime's ICU data, so two Workers
 * builds could hash one record two ways. This is also RFC 8785's key order.
 */
function compareBinary(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonical JSON: object keys in binary order at every depth, no whitespace, array
 * order kept, keys whose value is `undefined` left out (as `JSON.stringify` does).
 * Strings and finite numbers serialise exactly as `JSON.stringify` writes them, which
 * for the values this record carries is RFC 8785 (JCS) output. Anything JSON cannot
 * carry losslessly (a non-finite number, a function, a bigint, a top-level
 * `undefined`) throws rather than hashing as something else.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareBinary);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot serialise a ${typeof value}`);
  }
}

/**
 * SHA-256 of `canonicalJson(content)`, lowercase hex. Web Crypto only, so it runs the
 * same in a Worker, in Node and in a browser.
 */
export async function computeRecordHash(content: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(content));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const byKey =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    compareBinary(key(a), key(b));

/**
 * What the hash covers: the v2 record without `version`, `asOf`, `reason` and
 * `recordHash`, with every set-like array sorted, so two builds of the same state hash
 * the same whatever order D1 returned rows in. Sorted: products, integrations and
 * proposals by id, claims by natural key, vendor links by product and kind, and the
 * four taxonomy slug lists. Kept in order: product versions and usefulness groups and
 * points, whose order a reader sees.
 */
export function ownershipRecordHashContent(
  record: Omit<OwnershipRecordV2, 'version' | 'asOf' | 'reason' | 'recordHash'> &
    Partial<Pick<OwnershipRecordV2, 'version' | 'asOf' | 'reason' | 'recordHash'>>,
): unknown {
  const { version: _v, asOf: _a, reason: _r, recordHash: _h, ...rest } = record;
  const sortSlugs = (list: readonly string[]) => [...list].sort(compareBinary);
  return {
    ...rest,
    products: [...rest.products]
      .map((p) =>
        p.content
          ? {
              ...p,
              content: {
                ...p.content,
                categories: sortSlugs(p.content.categories),
                audiences: sortSlugs(p.content.audiences),
                phases: sortSlugs(p.content.phases),
                trades: sortSlugs(p.content.trades),
              },
            }
          : p,
      )
      .sort(byKey((p) => p.id)),
    integrations: [...rest.integrations]
      .map((intg) => ({
        ...intg,
        content: intg.content && {
          ...intg.content,
          vendorLinks: [...intg.content.vendorLinks].sort(
            byKey((l) => `${l.productId}\u0000${l.kind}`),
          ),
        },
        claims: intg.claims && [...intg.claims].sort(byKey(ownershipClaimKey)),
      }))
      .sort(byKey((i) => i.id)),
    proposals: [...rest.proposals].sort(byKey((p) => p.id)),
  };
}

/** The `recordHash` of a v2 record. `version`, `asOf`, `reason` and any `recordHash`
 *  already on it are ignored, so a re-send of unchanged state hashes the same. */
export function computeOwnershipRecordHash(
  record: Parameters<typeof ownershipRecordHashContent>[0],
): Promise<string> {
  return computeRecordHash(ownershipRecordHashContent(record));
}

// ─── Versions read (AECI-1413 drift check) ───────────────────────────────────────

/** The most vendor ids one versions read may name. */
export const OWNERSHIP_VERSIONS_MAX_IDS = 100;

/**
 * One vendor the review app holds a record for. `recordHash` is the hash of the last
 * v2 record it accepted, `null` when it holds only a v1 record.
 *
 * `skipped` (AECI-1488) is how many parts of that record the receiver accepted the
 * record without applying, such as a product it could not bind. Optional: a receiver
 * that predates it leaves it out, and absent reads as 0. A matching hash with
 * `skipped > 0` is the drift check's `partial` outcome.
 */
export const OwnershipVersionEntrySchema = z.object({
  vendorId: id,
  version: z.number().int().positive(),
  recordHash: RecordHashSchema.nullable(),
  skipped: z.number().int().nonnegative().optional(),
});
export type OwnershipVersionEntry = z.infer<typeof OwnershipVersionEntrySchema>;

/**
 * `GET {REVIEW_APP_OWNERSHIP_URL}/vendors?ids=…` (same bearer token). A vendor the
 * review app holds no record for is left out of `vendors`, not listed with nulls.
 */
export const OwnershipVersionsResponseSchema = z.object({
  vendors: z.array(OwnershipVersionEntrySchema).max(OWNERSHIP_VERSIONS_MAX_IDS),
});
export type OwnershipVersionsResponse = z.infer<typeof OwnershipVersionsResponseSchema>;

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

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** The receiver path for one vendor, under the configured base URL. */
export function ownershipRecordUrl(baseUrl: string, vendorId: string): string {
  return `${trimBase(baseUrl)}/vendors/${encodeURIComponent(vendorId)}`;
}

/**
 * The versions-read URL for up to {@link OWNERSHIP_VERSIONS_MAX_IDS} vendors, ids
 * comma-separated. Throws on an empty list or an over-cap one: the caller chunks.
 */
export function ownershipVersionsUrl(baseUrl: string, vendorIds: readonly string[]): string {
  if (vendorIds.length === 0 || vendorIds.length > OWNERSHIP_VERSIONS_MAX_IDS) {
    throw new RangeError(
      `ownershipVersionsUrl: 1 to ${OWNERSHIP_VERSIONS_MAX_IDS} ids, got ${vendorIds.length}`,
    );
  }
  return `${trimBase(baseUrl)}/vendors?ids=${vendorIds.map(encodeURIComponent).join(',')}`;
}
