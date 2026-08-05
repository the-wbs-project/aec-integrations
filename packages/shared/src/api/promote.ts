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
 * Claim / attestation vocabularies (Stage 1.5 — `STAGE_1_5_SPEC.md` §3.2/§3.3).
 * A claim's `direction` is NOT the mechanism-row `INTEGRATION_DIRECTIONS` above:
 * it is anchored to the integration's endpoints, where **A = the integration's
 * `sourceProduct`** and **B = its `targetProduct`** (§3.1). The stored value is
 * canonical and never rewritten; the context-relative view (`inbound`/`outbound`)
 * is a pure translation that lives with the pair-page helpers (§7).
 */
export const CLAIM_DIRECTIONS = ['a_to_b', 'b_to_a', 'both'] as const;

/** A claim's stored direction, relative to the integration row's own endpoints (§3.2). */
export type ClaimDirection = (typeof CLAIM_DIRECTIONS)[number];

/**
 * Who attests a claim. In Stage 1.5 only `aeci` is ever written; `vendor_a` /
 * `vendor_b` are additive-and-dormant — present in the contract, produced by no
 * 1.5 code path (§1.1/§3.3), reserved for the Stage 2 vendor portal.
 */
export const ATTESTATION_SOURCES = ['aeci', 'vendor_a', 'vendor_b'] as const;

/** Who attests a claim (§3.3). */
export type AttestationSource = (typeof ATTESTATION_SOURCES)[number];

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
  xUrl: z.string().nullish(),
  facebookUrl: z.string().nullish(),
  instagramUrl: z.string().nullish(),
  youtubeUrl: z.string().nullish(),
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
 * A usefulness group on the promote INPUT — looser than the stored
 * `UsefulnessGroup` (`./products`), which requires both `slug` AND `name`. The
 * review app identifies the audience/phase term by `slug` OR `name` (it carries
 * the Airtable name, not the AECi slug — the Disciplines/Project-Phases tables
 * have no slug field), so exactly one is required here. The server resolves each
 * group to an EXISTING term and stores the canonical `{ slug, name }` it
 * resolved to — usefulness groups NEVER find-or-create (`REVIEW_APP_PROMOTE_API.md`
 * §3.3). `points` holds ≥ 1 bullet, in display order.
 */
const PromoteUsefulnessGroupSchema = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    points: z.array(z.string().min(1)).min(1),
  })
  .refine((g) => Boolean(g.slug ?? g.name), {
    message: 'Provide `slug` or `name`',
  });

export type PromoteUsefulnessGroup = z.infer<typeof PromoteUsefulnessGroupSchema>;

/**
 * Promote-input usefulness: per-audience / per-phase narrative value. Each facet
 * array defaults to empty so a partial block (`{ audiences: [...] }`) is valid;
 * send `usefulness: null` (or omit it) when there is no value for either facet.
 */
export const PromoteUsefulnessSchema = z.object({
  audiences: z.array(PromoteUsefulnessGroupSchema).default([]),
  phases: z.array(PromoteUsefulnessGroupSchema).default([]),
});

export type PromoteUsefulness = z.infer<typeof PromoteUsefulnessSchema>;

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
  // Per-audience / per-phase narrative value. Resolved server-side against
  // existing terms (never find-or-created) and stored as slug-based jsonb;
  // `null` clears the column, absent leaves it untouched. See the route's
  // `resolveUsefulnessFacet` and `REVIEW_APP_PROMOTE_API.md` §3.3.
  usefulness: PromoteUsefulnessSchema.nullish(),
  categories: z.array(z.string().min(1)).default([]),
  audiences: z.array(z.string().min(1)).default([]),
  phases: z.array(z.string().min(1)).default([]),
  // The fourth taxonomy facet — "what work does the buyer's company sell?"
  // (`STAGE_1_SPEC.md` §5.5a, `docs/TRADES_VOCABULARY.md`). Values are trade
  // slugs, names, OR aliases, resolved server-side **find-only** against the
  // seeded closed vocabulary by slug → name → alias, case-insensitively. Unlike
  // the three facets above, an unmatched value is NEVER find-or-created: it is
  // dropped and reported in `skipped[]` with `kind: 'trade'` (a typo minting
  // `paving-contractors` alongside `paving-asphalt` would split a trade page's
  // products across two permanent URLs). Sparse by design — send trades only for
  // products with trade-SPECIFIC value; horizontal platforms send none.
  trades: z.array(z.string().min(1)).default([]),
  extensionOf: z.array(EntityRefSchema).default([]),
});

export type PromoteProduct = z.infer<typeof PromoteProductSchema>;

/**
 * One attestation on a claim: who asserts it and whether they affirm it
 * (`STAGE_1_5_SPEC.md` §3.3). In Stage 1.5 AECi writes exactly one attestation
 * per claim (`source: 'aeci', asserted: true`). `introducedAt` / `deprecatedAt`
 * are **dormant** version stamps for the Stage 2 timeline (AECI-303) — accepted
 * by the contract but written by no 1.5 code path; kept as loose ISO date strings
 * (the review app emits JSON, and over-strict validation would reject legitimate
 * values, consistent with the rest of this contract).
 */
export const PromoteAttestationSchema = z.object({
  source: z.enum(ATTESTATION_SOURCES),
  asserted: z.boolean(),
  introducedAt: z.string().nullish(),
  deprecatedAt: z.string().nullish(),
  note: z.string().nullish(),
});

export type PromoteAttestation = z.infer<typeof PromoteAttestationSchema>;

/**
 * One claim: a `dataObject` flowing in a `direction` through the enclosing
 * integration (mechanism) row — the claim's identity is anchored to that row
 * (`STAGE_1_5_SPEC.md` §3.1). `dataObject` is a slug OR a name/alias; the server
 * resolves it **find-only** against the seeded `taxonomy_data_objects` (§2). A
 * miss is reported in the promote response's `skipped[]` with `kind: 'claim'` —
 * never a 500 (§5.1, §6.2). Claims are nested under each integration; a claim is
 * only ingested when its integration is (the §5.1 withhold rule).
 */
export const PromoteClaimSchema = z.object({
  dataObject: z.string().min(1),
  direction: z.enum(CLAIM_DIRECTIONS),
  attestations: z.array(PromoteAttestationSchema).default([]),
});

export type PromoteClaim = z.infer<typeof PromoteClaimSchema>;

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
  // Claims attach to THIS mechanism row (§3.1) and ride with it: a claim is
  // emitted/ingested only when the integration is (both endpoints promoted —
  // the §5.1 withhold rule). Optional; defaults to []. An unresolved `dataObject`
  // lands in the response's `skipped[]` with `kind: 'claim'` (§5.1, §6.2).
  claims: z.array(PromoteClaimSchema).default([]),
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
  /**
   * Source / target product slugs of the promoted integration. Present so the
   * cache-tag + IndexNow derivers can purge BOTH pair-page orientations
   * (`/products/:a/integrations/:b` and its 301 twin — §7.1) without a DB read.
   * Optional here — this contract-only change (AECI-291) lands the shape; the
   * ingest handler populates and consumes them (§6.2, AECI-297). Consumers must
   * tolerate their absence.
   */
  sourceSlug?: string;
  targetSlug?: string;
  /**
   * Slug of the connector product that POWERS the promoted integration
   * (`integrations.powered_by_product_id`), when the payload named one. Present
   * so the cache-tag deriver can purge the connector's own product detail page —
   * its "Integrations it powers" hub view (Stage 1.5 Addendum B) renders this
   * edge, and without the tag it would sit stale until the TTL. Absent when the
   * integration has no powered-by product, and older responses omit it entirely,
   * so consumers must tolerate its absence.
   */
  poweredBySlug?: string;
}

export interface PromoteTaxonomyResult {
  slug: string;
  id: string;
  operation: PromoteTaxonomyOperation;
}

export interface PromoteSkipped {
  ref: string;
  kind: 'integration' | 'extension' | 'usefulness' | 'claim' | 'trade';
  reason: string;
}

/**
 * The ID map the review app persists. `product` is `null` for a vendor-only or
 * integration-only push (no `product` was sent); otherwise it's the single
 * promoted product. `skipped` lists integrations/extensions that couldn't be
 * linked because an endpoint wasn't resolvable (e.g. the other product isn't
 * promoted yet), usefulness groups that didn't resolve to an existing
 * audience/phase term, claims whose `dataObject` failed find-only resolution
 * against the seeded vocabulary (`kind: 'claim'`), and trades that failed
 * find-only resolution against the seeded `trade` vocabulary (`kind: 'trade'`) —
 * surfaced rather than silently dropped.
 */
export interface PromoteResponse {
  vendors: PromoteEntityResult[];
  product: PromoteEntityResult | null;
  integrations: PromoteIntegrationResult[];
  taxonomy: {
    categories: PromoteTaxonomyResult[];
    audiences: PromoteTaxonomyResult[];
    phases: PromoteTaxonomyResult[];
    /**
     * Trades the product resolved to. Always `operation: 'reused'` — the `trade`
     * vocabulary is closed and resolves find-only (`STAGE_1_SPEC.md` §5.5a), so
     * promote can only ever match an existing term, never mint one. Always
     * present; empty for a push with no product or no resolvable trades.
     */
    trades: PromoteTaxonomyResult[];
  };
  skipped: PromoteSkipped[];
}
