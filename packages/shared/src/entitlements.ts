/**
 * The capability registry — the entitlement vocabulary and the tier ladder
 * (Stage 2 §3.1 — AECI-610 / `docs/STAGE_2_PAID_TIERS_SPEC.md`).
 *
 * `STAGE_2_SPEC.md` §2.2 requires entitlements to be "data, not code branches
 * scattered across the app", and the tier ladder above the entry Verified fee
 * is still an open *pricing* question (§8.2). This module is that data. Adding
 * a rung is an edit to exactly two objects below — `TIERS` and
 * `TIER_CAPABILITIES` — with no schema change, no migration, and no handler
 * change. `vendor_entitlements.tier` is deliberately UNCONSTRAINED at the DB
 * layer (§2.2) precisely so this file, not a SQLite CHECK, owns the closed
 * vocabulary.
 *
 * Three rules a future editor must not break:
 *
 *  1. **No zod, and no `./api/*` import.** This is consumed by the lazy
 *     `/vendor` Angular route (§8), and `package.json` records that one value
 *     import from an `api/*` module once dragged the entire schema set plus a
 *     327 kB zod chunk into the Angular initial graph (§10 R11). `api/*` is the
 *     wire-contract namespace; this is a domain rule table like `algolia.ts`,
 *     `agreement.ts`, `slug.ts`. Enforced by a file-scoped
 *     `no-restricted-imports` in `packages/shared/eslint.config.mjs`. The wire
 *     shapes live in `./api/admin-entitlements`, which imports FROM here — the
 *     dependency is one-way and must stay that way.
 *  2. **Fail closed.** No row, a non-`active` status, or an unknown tier all
 *     resolve to `unclaimed` → the Free capabilities only (AECI-1214). Never
 *     default to `verified`.
 *  3. **Reachable only as `@aeci/shared/entitlements`.** Deliberately NOT
 *     re-exported from the root `src/index.ts` barrel, which carries zod via
 *     `export * from './api'` — the same reason `algolia.ts` is kept out. The
 *     subpath being the only import path is what makes rule 1 structural
 *     rather than a convention a consumer can miss.
 *
 * Consumers, all shipped: AECI-611 loads the tier onto `AuthenticatedSession` and
 * adds `requireCapability`; AECI-532 the admin set/renew/clear action; AECI-613
 * the expiry-warning cron; AECI-614 the vendor-facing plan panel; AECI-304 the
 * version-diff gate, which reaches it through `./version-diff` and is the reason
 * rule 1 matters — that path is on a lazy route too.
 *
 * Spec: `STAGE_2_PAID_TIERS_SPEC.md` §3.1 (vocabulary + ladder), §3.2 (the
 * ranking firewall this file's spec asserts), §3.3 (where `hasCapability` is
 * consulted and where it is forbidden), §2.2 (why `tier` has no CHECK).
 */

/**
 * The closed capability vocabulary. Frozen by `entitlements.spec.ts` — a new id
 * fails that test until someone edits it deliberately, and it must never name a
 * search-ranking concept (§3.2, the no-pay-for-placement firewall).
 *
 * `analytics.view` is **declared with no consumer on purpose**, so the issue that
 * needs it becomes a pure render-path/handler change with no registry edit, and
 * so the whole vocabulary is auditable in one place. `attestation.author` was in
 * that set until AECI-623 made it the gate on the six attestation and
 * product-version writes (`requireCapability` in `apps/api/src/lib/authz.ts`) and
 * on the portal's Integrations tab (`vendorCan`).
 *
 * `integration.version_diff` is **no longer in that set**: AECI-304 shipped its
 * consumer in `./version-diff` (`canViewVersionDiff`), and it is the one capability
 * whose effect is visible to an anonymous READER rather than to the vendor — it
 * gates historical version-diff depth on the public pair page, keyed on the pair's
 * vendors so the page stays URL-cacheable. That reader-visible reach is why
 * `/methodology` has to disclose it (`STAGE_2_5_SPEC.md` §7.1).
 */
export const CAPABILITIES = [
  'profile.edit', // PATCH /api/vendor/profile — every company detail, held on every plan (§13.3)
  'profile.rich_fields', // the extended vendor field set
  'product.edit', // AECI-1214 — the integrations page URL and the API docs URL on an owned product
  'product.listing.edit', // AECI-1214 — description, website and logo on an owned product
  'product.categories.edit', // AECI-1214 — `category_slugs` on an owned product
  'product.taxonomy.edit', // trades, audiences and phases on an owned product
  'product.usefulness.edit', // AECI-963 — the "how teams use it" narrative on an owned product
  'attestation.author', // AECI-623 — the attestation + product-version writes
  'analytics.view', // vendor analytics — declared, no consumer yet
  'integration.version_diff', // AECI-304 — consulted by `./version-diff`
] as const;

/** One capability id. */
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The tier ladder. **Binary at launch** (`STAGE_2_SPEC.md` §8.5): `unclaimed` (no active
 * entitlement, shown as "Free" in copy) vs `verified` (the paid entry fee, shown as
 * "Managed"). `STAGE_2_PAID_TIERS_SPEC.md` §13.2: there is no `free` id. Adding a rung = one entry
 * here plus one row in `TIER_CAPABILITIES`, and nothing else.
 */
export const TIERS = ['unclaimed', 'verified'] as const;

/** One tier id. Resolved from a `vendor_entitlements` row by `tierFor`. */
export type EntitlementTier = (typeof TIERS)[number];

/**
 * Tier → the capabilities it holds. Typed as a total `Record` over
 * `EntitlementTier` on purpose: adding a rung to `TIERS` without a row here is
 * a typecheck failure, which is what keeps "exactly two objects" honest.
 *
 * `unclaimed` is the Free plan (AECI-1214, `STAGE_2_PAID_TIERS_SPEC.md` §13.3).
 * Every seat holds it, whatever its entitlement row says, because a lapsed or
 * absent row resolves here. It carries company details and the four product
 * fields that feed `listing_tier`, so payment can never raise a rank through the
 * edit path (§13.4, asserted by `entitlements.spec.ts`). The connector catalogue
 * seat holds it too (ruling 2026-10-02).
 *
 * `verified` unlocks everything §8.1(3) lists. A future middle rung is a subset
 * literal, not a new branch anywhere else in the codebase.
 */
export const TIER_CAPABILITIES: Readonly<Record<EntitlementTier, readonly Capability[]>> = {
  unclaimed: ['profile.edit', 'product.listing.edit', 'product.categories.edit'],
  verified: [...CAPABILITIES],
};

/**
 * The tiers an admin may actually **grant** — i.e. `TIERS` minus `unclaimed`.
 *
 * Until AECI-1214 this was "every tier that holds a capability". `unclaimed` now
 * holds the Free capabilities, so that derivation would wrongly include it. Free
 * is never a `vendor_entitlements` row (§13.2): it is what a seat has with no row.
 *
 * This exists because `TIERS` and "what you can sell someone" are not the same
 * list, and conflating them is a live incoherence rather than a tidiness point.
 * `unclaimed` is defined as the **absence** of an entitlement (§3.1), but a
 * `vendor_entitlements` row at that tier would still carry `status: 'active'` —
 * which flips the `vendors.verified` mirror and shows the public account label (§2.1)
 * while `tierFor` resolves the row to **zero** capabilities. That is a vendor
 * billed for a badge that unlocks nothing.
 *
 * So the *set* request enum derives from here, not from `TIERS`
 * (`PaidEntitlementTierSchema`, `api/admin-entitlements.ts`), while the session
 * block and the grant summary keep reading `TIERS` — they legitimately need to
 * *report* `unclaimed`, they just must never be able to *write* it.
 *
 * Kept as an explicit literal rather than a computed filter because `z.enum`
 * needs a const tuple at the type level; `entitlements.spec.ts` asserts it equals
 * `TIERS` minus `unclaimed`, so adding a rung cannot silently make it stale.
 */
export const PAID_TIERS = ['verified'] as const;

/** A tier that can be granted. Always a subset of {@link EntitlementTier}. */
export type PaidEntitlementTier = (typeof PAID_TIERS)[number];

/**
 * Vendor-editable wire field → the capability that unlocks it (AECI-1214).
 *
 * These two tables are the single source for the entitlement axis of the vendor
 * edit routes. `apps/api/src/routes/vendor.ts` builds `VENDOR_COLUMN_MAP` and
 * `PRODUCT_COLUMN_MAP` from them, and the product route's facet gate reads
 * `PRODUCT_FIELD_CAPABILITIES` too. They live here, not in the API, so the
 * §13.4 firewall in `entitlements.spec.ts` can check every `listing_tier` input
 * against the capability the route actually enforces.
 *
 * A field absent from a table is not vendor-editable. `name` and `company_name`
 * are absent on purpose: a rename stays a correction request.
 *
 * Keys match `UpdateVendorProfileSchema` and `UpdateVendorProductSchema` exactly.
 * `vendor.entitlement.spec.ts` asserts that, because this module may not import
 * the zod schemas (rule 1 above).
 */
export const VENDOR_FIELD_CAPABILITIES = {
  description: 'profile.edit',
  website: 'profile.edit',
  headquarters: 'profile.edit',
  founded_year: 'profile.edit',
  public_private: 'profile.edit',
  parent_company: 'profile.edit',
  contact_email: 'profile.edit',
  phone_number: 'profile.edit',
  logo_url: 'profile.edit',
  linkedin_url: 'profile.edit',
  x_url: 'profile.edit',
  facebook_url: 'profile.edit',
  instagram_url: 'profile.edit',
  youtube_url: 'profile.edit',
  crunchbase_url: 'profile.edit',
  wiki_url: 'profile.edit',
  github_org: 'profile.edit',
} as const satisfies Record<string, Capability>;

/** One vendor-editable company field. */
export type VendorEditableField = keyof typeof VENDOR_FIELD_CAPABILITIES;

/** See {@link VENDOR_FIELD_CAPABILITIES}. The four `*_slugs` facets are join
 *  rewrites rather than columns, but they are gated per field like the rest. */
export const PRODUCT_FIELD_CAPABILITIES = {
  description: 'product.listing.edit',
  website: 'product.listing.edit',
  logo_url: 'product.listing.edit',
  tool_integrations_url: 'product.edit',
  api_docs_url: 'product.edit',
  // AECI-963. Its own capability, so a future middle tier can withhold narrative
  // authorship without touching a handler.
  usefulness: 'product.usefulness.edit',
  category_slugs: 'product.categories.edit',
  audience_slugs: 'product.taxonomy.edit',
  phase_slugs: 'product.taxonomy.edit',
  trade_slugs: 'product.taxonomy.edit',
} as const satisfies Record<string, Capability>;

/** One vendor-editable product field. */
export type ProductEditableField = keyof typeof PRODUCT_FIELD_CAPABILITIES;

/**
 * How close to `period_end` the system starts warning — the §7 expiry horizon.
 *
 * **Shared because it is one promise, not two.** The cron (`apps/api`) uses it as
 * the lookahead AND as the width of the idempotency fence; the vendor dashboard
 * (`apps/web`) uses it to decide when the plan panel leans in. Those numbers must
 * never diverge: if the cron's horizon were the wider of the two, a vendor would
 * receive the renewal email while the dashboard still showed everything as fine —
 * which is exactly the state that makes a paying customer distrust the surface.
 *
 * It shipped as two independent `30`s (AECI-613's `EXPIRY_WARNING_DAYS` and
 * AECI-614's `EXPIRY_SOON_DAYS`) that agreed by coincidence; consolidated here so
 * they cannot drift.
 *
 * Launch-tunable — `docs/POST_LAUNCH_MONITORING.md` §3.
 */
export const EXPIRY_WARNING_DAYS = 30;

/**
 * The `vendor_entitlements.status` vocabulary (§2.2). Unlike `tier`, this one
 * IS CHECK-constrained at the DB layer — adding a status is a state-machine
 * change and therefore a code change anyway. It lives here rather than in the
 * wire module so the D1 CHECK (AECI-609), the admin wire schema, and the
 * session block (AECI-611) all read one list.
 *
 *  - `pending` — arrangement recorded, PO issued, not yet effective
 *  - `active`  — the only status that grants capabilities, and the only one
 *                that mirrors onto `vendors.verified`
 *  - `expired` — term lapsed amicably
 *  - `revoked` — pulled for cause
 */
export const ENTITLEMENT_STATUSES = ['pending', 'active', 'expired', 'revoked'] as const;

/** One entitlement status. */
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/**
 * The status a row must carry to grant anything. `tierFor` still takes a loose
 * `status: string` — a value outside the vocabulary above must fail closed like
 * any other non-`active` status, not throw.
 */
const ACTIVE_STATUS: EntitlementStatus = 'active';

/**
 * Resolve a `vendor_entitlements` row to its tier — **fail-closed** (§3.1).
 *
 * `unclaimed` for: no row at all (never claimed, or the entitlement was
 * cleared), a `pending` / `expired` / `revoked` status, and a tier this build
 * does not know (the DB column is unconstrained by design, §2.2 — an unknown
 * tier resolving to the Free capabilities is strictly safer than a write-time CHECK
 * failure).
 *
 * Structurally typed so callers can pass a Drizzle row, a joined projection, or
 * a session fragment without this module importing a schema.
 */
export function tierFor(
  entitlement: { tier: string; status: string } | null | undefined,
): EntitlementTier {
  if (!entitlement) return 'unclaimed';
  if (entitlement.status !== ACTIVE_STATUS) return 'unclaimed';
  return isEntitlementTier(entitlement.tier) ? entitlement.tier : 'unclaimed';
}

/** Whether a string is a tier this build knows. */
export function isEntitlementTier(tier: string): tier is EntitlementTier {
  return (TIERS as readonly string[]).includes(tier);
}

/**
 * The capabilities a tier holds. The `?? []` is not dead code: the tier can
 * arrive from the unconstrained `vendor_entitlements.tier` column via a cast,
 * and an unrecognized one must resolve to zero capabilities, not `undefined`.
 */
export function capabilitiesFor(tier: EntitlementTier): readonly Capability[] {
  return TIER_CAPABILITIES[tier] ?? [];
}

/**
 * Whether a tier holds a capability. The DB-free assertion `/api/vendor/*` writes
 * run once ownership has settled (§3.3a) — no seam, no mock.
 *
 * NOT "immediately after `sessionVendorId(c)`", which is how §3.3(a) originally
 * read: on `PATCH /products/:id` the check must follow `requireOwnedProduct`,
 * because a 403 raised before ownership is known would confirm that a foreign
 * product exists. 404-never-403 is the harder invariant and it wins.
 *
 * Reads are never gated (§4.3).
 */
export function hasCapability(tier: EntitlementTier, capability: Capability): boolean {
  return capabilitiesFor(tier).includes(capability);
}
