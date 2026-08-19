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
 *     resolve to `unclaimed` → zero capabilities. Never default to `verified`.
 *  3. **Reachable only as `@aeci/shared/entitlements`.** Deliberately NOT
 *     re-exported from the root `src/index.ts` barrel, which carries zod via
 *     `export * from './api'` — the same reason `algolia.ts` is kept out. The
 *     subpath being the only import path is what makes rule 1 structural
 *     rather than a convention a consumer can miss.
 *
 * Nothing consumes this yet: AECI-611 loads the tier onto `AuthenticatedSession`
 * and adds `requireCapability`, AECI-532 the admin set/renew/clear action,
 * AECI-614 the vendor-facing plan panel.
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
 * The last three are **declared with no consumer on purpose**, so the issues
 * that need them become pure render-path/handler changes with no registry edit,
 * and so the whole vocabulary is auditable in one place today.
 */
export const CAPABILITIES = [
  'profile.edit', // PATCH /api/vendor/profile
  'profile.rich_fields', // the extended vendor field set
  'product.edit', // PATCH /api/vendor/products/:id
  'product.taxonomy.edit', // taxonomy assignment on an owned product
  'attestation.author', // AECI-301 — declared, no consumer yet
  'analytics.view', // vendor analytics — declared, no consumer yet
  'integration.version_diff', // AECI-304 — declared, no consumer yet
] as const;

/** One capability id. */
export type Capability = (typeof CAPABILITIES)[number];

/**
 * The tier ladder. **Binary at launch** (§8.4): `unclaimed` (no active
 * entitlement) vs `verified` (the paid entry fee). Adding a rung = one entry
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
 * `verified` unlocks everything §8.1(3) lists. A future middle rung is a subset
 * literal, not a new branch anywhere else in the codebase.
 */
export const TIER_CAPABILITIES: Readonly<Record<EntitlementTier, readonly Capability[]>> = {
  unclaimed: [],
  verified: [...CAPABILITIES],
};

/**
 * The tiers an admin may actually **grant** — i.e. `TIERS` minus every tier that
 * holds no capabilities.
 *
 * This exists because `TIERS` and "what you can sell someone" are not the same
 * list, and conflating them is a live incoherence rather than a tidiness point.
 * `unclaimed` is defined as the **absence** of an entitlement (§3.1), but a
 * `vendor_entitlements` row at that tier would still carry `status: 'active'` —
 * which flips the `vendors.verified` mirror and lights the Verified badge (§2.1)
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
 * the derived set, so adding a zero-capability rung cannot silently make it stale.
 */
export const PAID_TIERS = ['verified'] as const;

/** A tier that can be granted. Always a subset of {@link EntitlementTier}. */
export type PaidEntitlementTier = (typeof PAID_TIERS)[number];

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
 * tier resolving to zero capabilities is strictly safer than a write-time CHECK
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
 * Whether a tier holds a capability. The DB-free assertion `/api/vendor/*`
 * writes run immediately after `sessionVendorId(c)` (§3.3a) — no seam, no mock.
 * Reads are never gated (§4.3).
 */
export function hasCapability(tier: EntitlementTier, capability: Capability): boolean {
  return capabilitiesFor(tier).includes(capability);
}
