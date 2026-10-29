/**
 * The capability registry — the entitlement vocabulary and the tier ladder
 * (Stage 2 §3.1 — AECI-610 / `docs/STAGE_2_PAID_TIERS_SPEC.md`).
 *
 * `STAGE_2_SPEC.md` §2.2 requires entitlements to be "data, not code branches
 * scattered across the app", and the tier ladder above the entry Verified fee
 * is still an open *pricing* question (§8.2). This module is that data. Adding
 * a rung is an edit to exactly two objects below — `TIERS` and
 * `TIER_CAPABILITIES` — with no schema change, no migration, and no handler
 * change. No DB column stores a tier (licenses carry none, and the retired
 * entitlement `tier` was UNCONSTRAINED, §2.2), so this file, not a SQLite CHECK,
 * owns the closed vocabulary.
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
 *     shapes live in `./api/vendor` (the `GET /api/vendor/me` plan block, moved
 *     from `./api/admin-entitlements` by AECI-1358), which imports FROM here — the
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
  'review.reply', // AECI-1176 — a public reply to a review, `verified` only (STAGE_2_VENDOR_PORTAL_SPEC.md §11c.9)
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

/** One tier id. Resolved from a plan by `tierFor`. */
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
 * The plan status vocabulary (§2.2). The session block (AECI-611), the audit
 * snapshot's `vendor_entitlement_status` column ({@link licensePlanSnapshot}) and
 * the vendor plan readout all read this one list.
 *
 *  - `pending` — never produced from licenses (a license has no pending state).
 *                Kept so audit rows written before AECI-1355 still parse.
 *  - `active`  — the only status that grants capabilities
 *  - `expired` — the term lapsed, or every live license is past its `ends_at`
 *  - `revoked` — the latest ended license was revoked for cause
 *
 * As built (AECI-1358, 2026-10-17): this began as the `vendor_entitlements.status`
 * CHECK vocabulary. AECI-1358 kept it although the issue listed it for deletion,
 * because licenses report their status in it.
 */
export const ENTITLEMENT_STATUSES = ['pending', 'active', 'expired', 'revoked'] as const;

/** One entitlement status. */
export type EntitlementStatus = (typeof ENTITLEMENT_STATUSES)[number];

/**
 * The `licenses.source` vocabulary (AECI-1350, `docs/VENDOR_SIGNUP_PROCESS.md` §2
 * decisions 5 and 6). Where a Managed license came from, never what it grants: every
 * live license grants the same thing. Like `tier`, the column is UNCONSTRAINED at the
 * DB layer, because a CHECK change on D1 is a table recreate (`docs/migrations.md` §0).
 * Writers validate against this list.
 *
 *  - `stripe`        — bought through Stripe Checkout (E9)
 *  - `invoice`       — an offline invoice or PO deal granted by AECi
 *  - `complimentary` — granted free by AECi, for example a pilot
 */
export const LICENSE_SOURCES = ['stripe', 'invoice', 'complimentary'] as const;

/** One license source. */
export type LicenseSource = (typeof LICENSE_SOURCES)[number];

/**
 * The sources an admin grant may write (AECI-1370, E4.1; decision 6). `stripe` is
 * absent: only Stripe's webhook writes it (E9), so `POST /api/admin/vendors/:id/licenses`
 * rejects it in Zod. Here, in the zod-free registry, so the admin control can list
 * them without pulling zod into the lazy route.
 */
export const ADMIN_GRANT_LICENSE_SOURCES = [
  'complimentary',
  'invoice',
] as const satisfies readonly LicenseSource[];

/** One source an admin grant may write. */
export type AdminGrantLicenseSource = (typeof ADMIN_GRANT_LICENSE_SOURCES)[number];

/** The most licenses one admin grant writes (AECI-1370). A larger deal is two grants. */
export const LICENSE_GRANT_QUANTITY_MAX = 50;

/** `reference` cap on an admin grant: an invoice number, PO or deal note. */
export const LICENSE_GRANT_REFERENCE_MAX = 200;

/** `notes` cap on an admin grant. Recorded in the audit row only. */
export const LICENSE_GRANT_NOTES_MAX = 1000;

/**
 * The `licenses.end_reason` vocabulary (AECI-1352): why a license ended, written with
 * `ended_at` by `endLicensesStatements` (`apps/api/src/lib/license.ts`), so E4.2
 * (revoke), a reduction (release) and the lapse (E6) share one builder. NULL while live. Like
 * `source`, the column is UNCONSTRAINED at the DB layer; writers validate against this
 * list. It is not `cancel_reason`, which says why a LIVE license will not renew
 * (decision 15).
 *
 *  - `lapsed`   — the term ran out (the 11:00 lapse job, AECI-1404), or Stripe cancelled the subscription
 *  - `released` — AECi ended a license the vendor no longer wants (a reduction,
 *                 `VENDOR_SIGNUP_PROCESS.md` §3 step 8). E4.4's approved early unassign
 *                 is not this: it takes the license off its product and leaves it live
 *  - `revoked`  — AECi pulled it for cause (abuse, misrepresentation)
 */
export const LICENSE_END_REASONS = ['lapsed', 'released', 'revoked'] as const;

/** One license end reason. */
export type LicenseEndReason = (typeof LICENSE_END_REASONS)[number];

/**
 * The `licenses.cancel_reason` vocabulary (AECI-1374): why a LIVE license is flagged
 * `cancel_at_term_end`, so it ends on its end date instead of renewing (decision 15).
 * Written with the flag by `setCancelAtTermEndStatements` (`apps/api/src/lib/license.ts`),
 * cleared to NULL with it. Unconstrained at the DB layer like `end_reason`; writers
 * validate against this list.
 *
 *  - `vendor-banned` — the ban of the vendor's last unbanned seat flagged every live
 *                      license (E4.5). The unban that restores a seat clears only these.
 *  - `vendor-cancelled` — the vendor's Stripe subscription is set to cancel at period
 *                      end (`cancel_at_period_end`, AECI-1500). Written and cleared only
 *                      by the Stripe sync (`apps/api/src/lib/stripe-licenses.ts`), which
 *                      never overwrites or clears a `vendor-banned` flag.
 */
export const LICENSE_CANCEL_REASONS = ['vendor-banned', 'vendor-cancelled'] as const;

/** One license cancel reason. */
export type LicenseCancelReason = (typeof LICENSE_CANCEL_REASONS)[number];

/**
 * The status a row must carry to grant anything. `tierFor` still takes a loose
 * `status: string` — a value outside the vocabulary above must fail closed like
 * any other non-`active` status, not throw.
 */
const ACTIVE_STATUS: EntitlementStatus = 'active';

/**
 * Resolve a plan (a `{ tier, status }` pair) to its tier — **fail-closed** (§3.1).
 *
 * `unclaimed` for: no plan at all, a `pending` / `expired` / `revoked` status, and
 * a tier this build does not know (an unknown tier resolving to the Free
 * capabilities is strictly safer than a failure). Its last production caller, the
 * claim grant's `tier`, read the entitlement row; since AECI-1358 the grant reads
 * live licenses instead.
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
 * arrive from an unconstrained stored value (an old audit row) via a cast,
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

/** `'none'` on both axes of {@link VendorPlanSnapshot}: the vendor holds no
 *  license (the Free plan, §13.2). Explicit, never NULL, so an
 *  audit row can say "no plan" rather than "not recorded" (AECI-1193). */
export const NO_PLAN = 'none' as const;

/**
 * The vendor's plan at the moment an audit row is written (AECI-1193,
 * `DATABASE_SCHEMA.md` §8.4) — what lands in `audit_log.vendor_tier` and
 * `audit_log.vendor_entitlement_status`.
 *
 * `tier` is the RAW tier (`'verified'`), not the resolved `EntitlementTier`:
 * the session flattens an expired `verified` plan to `unclaimed`, and "actions
 * after the Managed plan lapsed" needs both halves. Built by
 * {@link licensePlanSnapshot}; `vendorPlanSnapshot` built it from the entitlement
 * row until AECI-1358 deleted it.
 */
export interface VendorPlanSnapshot {
  tier: string;
  status: EntitlementStatus | typeof NO_PLAN;
}

/**
 * The raw tier a license snapshot records. Licenses carry no tier: every live license
 * grants the one paid rung, which the retired entitlement `tier` called `verified`. Kept
 * as that word so audit rows before and after the switch-over read alike.
 */
const LICENSE_SNAPSHOT_TIER = 'verified';

/** The license columns {@link licensePlanSnapshot} reads. Structural, so a Drizzle row or a
 *  narrower projection both pass. */
export interface LicensePlanRow {
  endsAt: string | null;
  endedAt: string | null;
  endReason?: string | null;
}

/**
 * Snapshot a vendor's licenses (every license on every billing account it holds) for
 * an audit row (AECI-1352). Same shape and columns the retired `vendorPlanSnapshot` wrote:
 * `audit_log.vendor_tier` and `audit_log.vendor_entitlement_status` (`DATABASE_SCHEMA.md`
 * §8.4). Those column names stay, to avoid an `audit_log` recreate.
 *
 *  - no license at all → `none` / `none` (the Free plan);
 *  - any LIVE license (`ended_at` null) → `verified` / `active`, unless every live
 *    license's scheduled `ends_at` is at or before `now`, which records `expired`.
 *    That is the 2026-10-05 clock ruling carried over: the 11:00 lapse job turns `ends_at` into
 *    `ended_at`, and until it runs a write after the term must not read as a live plan;
 *  - every license ended → the most recently ended one decides: `revoked` when its
 *    `end_reason` is `revoked`, else `expired` (`lapsed`, `released`, or NULL).
 *
 * Record rule only: authorization reads stored state.
 * Dates are compared by parsed instant, so date-only and full ISO spellings cannot
 * mis-order. A null `ends_at` is monthly and never lapses on the clock; an
 * unparseable one keeps the license live. `pending` is never produced: a license has
 * no pending state.
 */
export function licensePlanSnapshot(
  licenses: readonly LicensePlanRow[] | null | undefined,
  now: Date | string,
): VendorPlanSnapshot {
  if (!licenses || licenses.length === 0) return { tier: NO_PLAN, status: NO_PLAN };

  const live = licenses.filter((l) => l.endedAt === null);
  if (live.length > 0) {
    const allPastTerm = live.every((l) => termHasEnded(l.endsAt, now));
    return { tier: LICENSE_SNAPSHOT_TIER, status: allPastTerm ? 'expired' : 'active' };
  }

  let latest: LicensePlanRow | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const license of licenses) {
    const ms = Date.parse(license.endedAt ?? '');
    // An unparseable stamp sorts first, so a readable one always wins.
    const key = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
    if (latest === null || key > latestMs) {
      latest = license;
      latestMs = key;
    }
  }
  const revoked = latest?.endReason === 'revoked';
  return { tier: LICENSE_SNAPSHOT_TIER, status: revoked ? 'revoked' : 'expired' };
}

/** Whether `periodEnd` is at or before `now`. Null or unparseable on either side
 *  is "not ended": the snapshot then falls back to the stored status. */
function termHasEnded(periodEnd: string | null, now: Date | string): boolean {
  if (periodEnd === null) return false;
  const endMs = Date.parse(periodEnd);
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
  if (Number.isNaN(endMs) || Number.isNaN(nowMs)) return false;
  return endMs <= nowMs;
}

// ─── Plan prices (display only, docs/PRICING_RULES.md §2) ─────────────────────

/**
 * Managed's list price, per product per month, in US cents. The ONE place it
 * lives in code: the vendor plan panel and the public plan pages read it.
 * Display only: Stripe bills from its own `managed_monthly` price. A price
 * change updates both (PRICING_RULES.md §6).
 */
export const MANAGED_LIST_PRICE_CENTS = 2500;

/**
 * Managed's public annual price, per product per year, in US cents ($250,
 * PRICING_RULES.md §2). Shown beside the monthly price on the public plan
 * pages. Display only, like the monthly price: Stripe bills from its own
 * `managed_annual` price. Only an invoice-sourced grant has a price agreed
 * with the company.
 */
export const MANAGED_ANNUAL_PRICE_CENTS = 25000;
