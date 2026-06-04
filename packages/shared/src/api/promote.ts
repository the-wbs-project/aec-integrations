import { z } from 'zod';

/**
 * `POST /api/promote` — push-based Airtable → Supabase promotion (supersedes the
 * pull-based `scripts/airtable-to-supabase-bulk-migrate.ts`). The review
 * application sends one product plus its dependencies (vendors, taxonomy,
 * integrations) and the API upserts them, returning the created/updated IDs so
 * the review app can persist the mapping and re-push edits later.
 *
 * Idempotency model (locked decision): the review app holds the IDs. An entity
 * with `supabaseId` present is UPDATED by that ID; absent → CREATED and its new
 * ID is returned. There is no `external_id` column on Supabase — the review app
 * is the system of record for the rec-ID ↔ Supabase-UUID mapping.
 *
 * Intra-payload links use a client-local `ref` (unique within the request).
 * The product references its vendors implicitly (every entry in `vendors[]`
 * becomes a `product_vendor`); integrations reference their endpoints by `ref`
 * (only the product in this bundle) or by `supabaseId` (an already-promoted
 * product). Slugs are server-generated — the review app never sends them.
 *
 * Enum values mirror the DB CHECK constraints in `docs/DATABASE_SCHEMA.md`.
 * Contract source of truth; no codegen (see `docs/API_CONTRACTS.md` §2).
 */

/** Enum vocabularies — kept in sync with the Postgres CHECK constraints. */
export const PRODUCT_ROLES = ['application', 'connector', 'hybrid'] as const;
export const RESEARCH_STATUSES = ['pending', 'in_progress', 'done', 'blocked'] as const;
export const PRIORITY_TIERS = ['tier_1', 'tier_2', 'tier_3', 'tier_4', 'tier_5'] as const;
export const PUBLIC_PRIVATE = ['public', 'private'] as const;
export const MECHANISM_KINDS = [
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
] as const;
export const INTEGRATION_DIRECTIONS = ['one-way', 'bidirectional'] as const;

/**
 * A reference to one entity, resolved at write time. Exactly one of `ref`
 * (points at another entity declared in this same payload) or `supabaseId`
 * (an entity already promoted in a prior request) must be set.
 */
export const EntityRefSchema = z
  .object({
    ref: z.string().min(1).optional(),
    supabaseId: z.string().uuid().optional(),
  })
  .refine((v) => (v.ref ? 1 : 0) + (v.supabaseId ? 1 : 0) === 1, {
    message: 'Provide exactly one of `ref` or `supabaseId`',
  });

export type EntityRef = z.infer<typeof EntityRefSchema>;

/**
 * A vendor of the product being promoted. `ref` is required so integrations in
 * the same payload can name it as their `builtByVendor`. URL-ish fields are
 * loose strings (curated Airtable data is trusted; over-strict validation would
 * reject legitimate-but-unusual values).
 */
export const PromoteVendorSchema = z.object({
  ref: z.string().min(1),
  supabaseId: z.string().uuid().nullish(),
  companyName: z.string().min(1),
  /** When omitted, the first vendor in the array is treated as primary. */
  isPrimary: z.boolean().optional(),
  description: z.string().nullish(),
  website: z.string().nullish(),
  headquarters: z.string().nullish(),
  foundedYear: z.number().int().nullish(),
  publicPrivate: z.enum(PUBLIC_PRIVATE).nullish(),
  parentCompany: z.string().nullish(),
  linkedinUrl: z.string().nullish(),
  crunchbaseUrl: z.string().nullish(),
  wikiUrl: z.string().nullish(),
  sourceUrl: z.string().nullish(),
  githubOrg: z.string().nullish(),
  phoneNumber: z.string().nullish(),
  contactEmail: z.string().nullish(),
  logoUrl: z.string().nullish(),
  verified: z.boolean().optional(),
});

export type PromoteVendor = z.infer<typeof PromoteVendorSchema>;

/**
 * The product being promoted. Taxonomy is sent as names or slugs (find-or-
 * created by canonical slug). `extensionOf` lists host products this product
 * extends — host products must already be promoted (use `supabaseId`).
 */
export const PromoteProductSchema = z.object({
  ref: z.string().min(1),
  supabaseId: z.string().uuid().nullish(),
  name: z.string().min(1),
  productRole: z.enum(PRODUCT_ROLES).default('application'),
  description: z.string().nullish(),
  website: z.string().nullish(),
  toolIntegrationsUrl: z.string().nullish(),
  apiDocsUrl: z.string().nullish(),
  hasApiDocs: z.boolean().optional(),
  toolIntegrationCheckNotes: z.string().nullish(),
  logoUrl: z.string().nullish(),
  researchStatus: z.enum(RESEARCH_STATUSES).nullish(),
  researchNotes: z.string().nullish(),
  priorityTier: z.enum(PRIORITY_TIERS).nullish(),
  priorityScore: z.number().nullish(),
  googleTrendsIndex: z.number().int().min(0).max(100).nullish(),
  searchVolumeMonthly: z.number().int().nullish(),
  redditMentions24mo: z.number().int().nullish(),
  adminNotes: z.string().nullish(),
  categories: z.array(z.string().min(1)).default([]),
  audiences: z.array(z.string().min(1)).default([]),
  phases: z.array(z.string().min(1)).default([]),
  extensionOf: z.array(EntityRefSchema).default([]),
});

export type PromoteProduct = z.infer<typeof PromoteProductSchema>;

/**
 * An integration incident to the product being promoted. One endpoint is the
 * product in this bundle (`{ ref: <product.ref> }`); the other must already be
 * promoted (`{ supabaseId }`). Integrations whose other endpoint isn't promoted
 * yet should simply be omitted — they migrate when that product is promoted.
 */
export const PromoteIntegrationSchema = z.object({
  ref: z.string().min(1),
  supabaseId: z.string().uuid().nullish(),
  name: z.string().nullish(),
  sourceProduct: EntityRefSchema,
  targetProduct: EntityRefSchema,
  builtByVendor: EntityRefSchema.nullish(),
  poweredByProduct: EntityRefSchema.nullish(),
  mechanismKind: z.enum(MECHANISM_KINDS).nullish(),
  mechanismName: z.string().nullish(),
  direction: z.enum(INTEGRATION_DIRECTIONS).nullish(),
  description: z.string().nullish(),
  listingUrl: z.string().nullish(),
  docsUrl: z.string().nullish(),
  website: z.string().nullish(),
  mechanismUrl: z.string().nullish(),
  pricingModel: z.string().nullish(),
  maturity: z.string().nullish(),
  notes: z.string().nullish(),
});

export type PromoteIntegration = z.infer<typeof PromoteIntegrationSchema>;

/**
 * Full promote payload: one product, its vendors, its integrations. The
 * `superRefine` enforces structural integrity that can't be expressed per-field:
 * globally-unique `ref`s, and `ref`-form links pointing at a declared entity.
 */
export const PromotePayloadSchema = z
  .object({
    vendors: z.array(PromoteVendorSchema).default([]),
    // Optional: a vendor-only or integration-only push (e.g. "I edited just the
    // vendor on review and want it live") omits `product`. When present, it
    // drives taxonomy + join rows as the product-centric promote.
    product: PromoteProductSchema.optional(),
    integrations: z.array(PromoteIntegrationSchema).default([]),
  })
  .superRefine((payload, ctx) => {
    const product = payload.product;
    const vendorRefs = new Set<string>();
    const allRefs = new Map<string, string>(); // ref → owner path (for dup detection)

    // A completely empty payload is a no-op mistake — reject it.
    if (!payload.vendors.length && !product && !payload.integrations.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Payload must include at least one of `vendors`, `product`, or `integrations`',
        path: [],
      });
      return;
    }

    const claim = (ref: string, path: (string | number)[]) => {
      if (allRefs.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate ref "${ref}" — refs must be unique across the payload`,
          path,
        });
      }
      allRefs.set(ref, path.join('.'));
    };

    payload.vendors.forEach((v, i) => {
      vendorRefs.add(v.ref);
      claim(v.ref, ['vendors', i, 'ref']);
    });
    if (product) claim(product.ref, ['product', 'ref']);
    payload.integrations.forEach((intg, i) => claim(intg.ref, ['integrations', i, 'ref']));

    // `extensionOf` cannot use `ref`: the only product in the payload is this
    // product, and a product can't be an extension of itself. Hosts are
    // promoted separately → reference them by `supabaseId`.
    product?.extensionOf.forEach((host, i) => {
      if (host.ref) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'extensionOf must reference a host product by `supabaseId`, not `ref`',
          path: ['product', 'extensionOf', i, 'ref'],
        });
      }
    });

    payload.integrations.forEach((intg, i) => {
      const checkProductRef = (endpoint: EntityRef, field: string) => {
        if (!endpoint.ref) return;
        if (!product) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} uses a \`ref\` but this payload has no product; reference products by \`supabaseId\``,
            path: ['integrations', i, field, 'ref'],
          });
        } else if (endpoint.ref !== product.ref) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${field} \`ref\` must be the product being promoted ("${product.ref}"); reference other products by \`supabaseId\``,
            path: ['integrations', i, field, 'ref'],
          });
        }
      };
      checkProductRef(intg.sourceProduct, 'sourceProduct');
      checkProductRef(intg.targetProduct, 'targetProduct');
      if (intg.poweredByProduct) checkProductRef(intg.poweredByProduct, 'poweredByProduct');
      if (intg.builtByVendor?.ref && !vendorRefs.has(intg.builtByVendor.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `builtByVendor \`ref\` "${intg.builtByVendor.ref}" is not a vendor declared in this payload`,
          path: ['integrations', i, 'builtByVendor', 'ref'],
        });
      }
    });
  });

export type PromotePayload = z.infer<typeof PromotePayloadSchema>;

// ─── Response shapes ─────────────────────────────────────────────────────────
export type PromoteOperation = 'created' | 'updated';
export type PromoteTaxonomyOperation = 'created' | 'reused';

export interface PromoteEntityResult {
  ref: string;
  id: string;
  slug: string;
  operation: PromoteOperation;
}

export interface PromoteIntegrationResult {
  ref: string;
  id: string;
  operation: PromoteOperation;
}

export interface PromoteTaxonomyResult {
  slug: string;
  id: string;
  operation: PromoteTaxonomyOperation;
}

export interface PromoteSkipped {
  ref: string;
  kind: 'integration' | 'extension';
  reason: string;
}

/**
 * The ID map the review app persists. `product` is `null` for a vendor-only or
 * integration-only push (no `product` was sent); otherwise it's the single
 * promoted product. `skipped` lists integrations/extensions that couldn't be
 * linked because an endpoint wasn't resolvable (e.g. the other product isn't
 * promoted yet) — surfaced rather than silently dropped.
 */
export interface PromoteResponse {
  vendors: PromoteEntityResult[];
  product: PromoteEntityResult | null;
  integrations: PromoteIntegrationResult[];
  taxonomy: {
    categories: PromoteTaxonomyResult[];
    audiences: PromoteTaxonomyResult[];
    phases: PromoteTaxonomyResult[];
  };
  skipped: PromoteSkipped[];
}
