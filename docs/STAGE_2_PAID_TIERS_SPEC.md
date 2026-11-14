# AEC Integrations — Stage 2 Paid Tiers & Entitlements Specification

**Version:** 0.1 — **build contract** (the decomposition of the AECI-515 epic)
**Date:** August 2026
**Status:** Build contract — promotes `STAGE_2_SPEC.md` §2.2 from scope outline to a buildable spec. Decisions resolved at the 2026-08-14 epic review (see `STAGE_2_SPEC.md` §8.5).
**Supersedes:** the entitlement/billing portions of `STAGE_2_SPEC.md` §2.2 and the two open items in §8.2 (that section stays the scope outline; this doc is the contract each sub-issue anchors to). Also supersedes `STAGE_2_VENDOR_PORTAL_SPEC.md` §8.3(1)'s "`vendors.verified` **is** the launch entitlement bit … no new schema" — that was the AECI-513 launch shape and this epic is the successor it named.
**Inherits from:** Stage 1 (`STAGE_1_SPEC.md`), Stage 1.5 (`STAGE_1_5_SPEC.md`), and — critically — the **Vendor Portal build contract** (`STAGE_2_VENDOR_PORTAL_SPEC.md`, AECI-513, all sub-issues shipped 2026-07-25). Every seam this epic extends was built there.
**Companion docs:** `AUTH_AND_RLS.md` (Layer-1 Worker authz — §4), `API_CONTRACTS.md` (endpoint shapes — §5), `DATABASE_SCHEMA.md` (tables — §2), `migrations.md` (the one migration — §2.3), `email.md` (Resend — §7), `CACHE_STRATEGY.md` (Cache-Tag purge — §5.3), `SEARCH_RANKING.md` (the ranking firewall — §3.2), `OBSERVABILITY.md` (metrics — §9).

> **Data-layer note (ADR 0016 / 0017).** The application database is **Cloudflare D1 + Drizzle**; Supabase is **auth-only**. Every write in this spec goes through `getDb(env)` and, for multi-statement writes, a single `db.batch([...])` that includes its `audit_log` row (the §26.1 invariant of `STAGE_1_SPEC.md`). There is **no Prisma, no Postgres, no RLS on app tables** — authorization is the **3-layer Worker model** in `AUTH_AND_RLS.md`. **D1 has no interactive transactions**, which is not a footnote here. It is the constraint that decides how the `vendors.verified` mirror is written: one idempotent guarded `UPDATE` at the end of every subscription batch (§2.1).

---

## 1. Overview & the launch model

**Stage 2 is where the vendors log in; this epic is where they pay.** AECI-513 shipped the portal — claim → grant → seat → `/api/vendor/*` → dashboard → public account label. It deliberately shipped **no entitlement model**, using `vendors.verified` as a stand-in bit and recording the offline PO/invoice arrangement as free text in `audit_log.metadata`. This epic replaced the stand-in with a real model. That model is now subscriptions: `licenses` rows on the vendor's billing account (AECI-1355, `VENDOR_SIGNUP_PROCESS.md` §5 E1). The first model, the `vendor_entitlements` table, was dropped on 2026-10-17 (AECI-1358). AECI-965 later replaced the misleading verification badge treatment with a neutral account-status label while retaining the internal mirror. AECI-1264 removed that label on 2026-10-09 (§2).

**The trust invariant is unchanged and non-negotiable: no pay-for-placement.** Entitlements gate **profile richness and portal capability only** — never ranking, placement, or badge trust. Search stays purely algorithmic (`STAGE_1_SPEC.md` §1 principles; `CLAUDE.md` constraints). In this epic that invariant stops being a documented promise and becomes an **asserted property** (§3.2).

**The launch model began concierge (`STAGE_2_SPEC.md` §8.1).** Vendors pay, always — and since **§8.8** (AECI-702) the vendor who pays is the **endpoint** vendor: a connector surface is not invoiced. What a pure connector vendor gets in return for its catalogue feed is settled by **§8.9** (AECI-704): a catalogue-maintenance seat on its own catalogue(s) that holds **no subscription**. So nothing in this document applies to one, and the mirror never flips for it. **Since §8.10 (2026-09-18, AECI-1017) a connector vendor also pays when it owns integrations it manages:** a third-party owner holds an ordinary Managed subscription, and §8.9 covers only a connector vendor that owns no integration it manages. *Superseded 2026-11-09 by ruling 14 (AECI-1663, recorded by AECI-1653): a connector vendor that owns integrations it manages pays nothing for them — "Managing an owned integration needs a seat, not a payment. Any seat may manage, a §8.9 catalogue-maintenance seat included" (`STAGE_2_SPEC.md` §8.10(1)(b)). A third-party owner may hold a Managed subscription on its own products, but ownership triggers no payment. §8.9's scope line — a connector vendor that owns no integration it manages — stands unchanged.* Connector vendors and subscriptions are parked (`VENDOR_SIGNUP_PROCESS.md` §2, AECI-1343). An admin grants invoice and complimentary subscriptions by hand from the vendor's Billing tab (§5.6.1). Card payment through Stripe Checkout is built (E9, ADR 0047). It stays off in production until the switch-on, behind `STRIPE_CHECKOUT_ENABLED` (`VENDOR_SIGNUP_PROCESS.md` §5 E9).

**What "free" means, precisely.** The free/default state is the **unclaimed, AECi-curated baseline** — the full Stage 1/1.5 directory entry, free to read, rendering no account-status label. Paying buys the vendor the ability to *act* on their own record. It buys the reader nothing and costs the reader nothing. **§8.8 exempts the connector surface from being invoiced at all** (the connector product, its catalogue and its reach; since §8.10, not an integration a connector vendor owns and manages), and **§8.9 settles what a pure connector vendor receives instead** — a catalogue-maintenance seat that deliberately holds **no** subscription. The mirror forces that shape: *any* live subscription flips `vendors.verified`, whatever it is for. The public label it once drove is gone (AECI-1264), and the claim button no longer reads it (AECI-1266). The version-diff gate still does (§3.3(c)).

### 1.1 Issue map & critical path

This doc is the contract for the AECI-515 sub-issues. Each opens with `**Spec section:** §X (docs/STAGE_2_PAID_TIERS_SPEC.md)` — the canonical form in `docs/linear-issue-conventions.md`. (The older doc-name-first spelling survives in existing issues and still resolves; write new ones this way.) **The subsection numbering below is load-bearing — do not renumber without updating the issues.**

| Anchor | Issue | Surface |
|---|---|---|
| §2 | AECI-609 | The `vendors.verified` mirror and its two guards. The `vendor_entitlements` table it shipped was dropped by AECI-1358 |
| §3 | AECI-610 | Capability registry + the ranking firewall |
| §4 | AECI-611 | The entitlement gate — tier on the session, `requireCapability()`, the field allow-list |
| §5 | AECI-532 | Admin entitlement action, set / renew / clear. Retired by AECI-1375 for the subscription routes |
| §5.6 | AECI-652 | The `/admin/vendors` surface — vendor list + detail, the entitlement control's new home, the seat roster + admin revoke, and the first `audit_log` viewer (**added 2026-08-27**, after the epic closed) |
| §6 | AECI-612 | Claim-grant integration — the AECI-519 refactor |
| §7 | AECI-613, AECI-1404 | Term expiry — warn, then lapse on the end date (the lapse since AECI-1404, §7.6) |
| §8 | AECI-614 | Vendor-facing entitlement surface |
| §9 | AECI-615 | Documentation & authz sweep |

**Build order.**

```
§2 (schema + mirror + guards) ─┬─→ §6 (claim-grant refactor)
                               ├─→ §5 (admin action)          [also needs §3]
§3 (capability registry) ──────┼─→ §4 (the gate) ──→ §8 (vendor dashboard surface)
  (§2 ∥ §3 — no dependency)    └─→ §7 (expiry cron + emails)

§9 (docs sweep) runs alongside; land it last so the § references are settled.
```

§3 is the one that can start immediately with zero dependencies — pure data, no schema. §2 and §3 are the critical path; everything else fans out. §5 and §6 are genuinely parallel (one adds a route, the other edits `admin-claims.ts`); they shared only `lib/vendor-entitlement.ts`, which §2 shipped and AECI-1358 deleted.

**Explicitly NOT in the build order: AECI-304** (paywalled integration/version-diff depth). It stays parented to this epic because the *decision* is a Paid-Tiers decision, but it is **blocked by AECI-303** (the version-diff timeline), which is unbuilt — the `attestations.introduced_at` / `deprecated_at` stamps are dormant data with **zero web consumers** (verified 2026-08-14: no timeline UI exists anywhere in `apps/web`). **AECI-304 is excluded from this epic's completion criteria.** What this epic does for it is mint the `integration.version_diff` capability id (§3.1) so that once AECI-303 exists, AECI-304 reduces to a render-path gate and nothing else. See §11.

### 1.2 Schema readiness — ONE migration required

AECI-609 shipped one migration, `0024_easy_sandman`, which created `vendor_entitlements`. Migration `0082_lying_paper_doll` dropped that table on 2026-10-17 (AECI-1358). The plan tables today are `billing_accounts` and `licenses`, from migration `0073` (AECI-1350, `DATABASE_SCHEMA.md` §8.6b, §8.6c). `migrations.md` §0 records the renumbering history of `0024`.

Two closed vocabularies still bound what a plan write may touch:

| Closed CHECK | Decision |
|---|---|
| `workflow_instances_type_check` | **Do not open it.** A subscription write records no `workflow_instances` row. A closed CHECK change on SQLite is a full table rebuild (`migrations.md` §0). |
| `audit_log_actor_type_check` — `('user','admin','system','workflow')` | **Sufficient as-is.** Admin subscription writes use `actor_type: 'admin'`. The 11:00 lapse and warning sweep use `'system'`. |

`audit_log.entity_type` is **deliberately unconstrained**. Subscription rows audit under `entity_type: 'billing_account'`, and the historical `vendor_entitlement` rows still render.

### 1.3 What already exists (reuse, don't rebuild)

This was the AECI-515 build's reuse list. Line references are as of that build.

| Asset | Location | Used by |
|---|---|---|
| The reversible-flag admin handler template (nine moves: preload gate → guardrail → 422 idempotency gate → derive from/to → build audit entry → one `db.batch` with a **guarded** `UPDATE … WHERE <current state>` → metric → post-commit `waitUntil` forwards → `validateResponseInDev`) | `createBanReviewerHandler`, `apps/api/src/routes/admin-reviewers.ts` ~:173-304 | §5 |
| Pure batch-builder module contract (returns statements + forwarding entries, executes nothing) | `apps/api/src/lib/vendor-grant.ts` | §2, §6 |
| The offline-arrangement contract | `ClaimEntitlementSchema`, `packages/shared/src/api/admin-claims.ts`. Deleted by AECI-1333. A subscription's `source` and `reference` carry the arrangement now (`DATABASE_SCHEMA.md` §8.6c) | §2, §5 |
| The grant's purge tag set (`vendor:{slug}` + every owned `product:{slug}` + `index:products`) | `grantPurgeTags`, `apps/api/src/routes/admin-claims.ts` ~:246-255 | §2 (promoted to a shared module), §5 |
| Audit/workflow batch builders | `auditInsert` / `workflowTransitionInsert`, `apps/api/src/lib/audit.ts` ~:42-68 | §2, §5, §7 |
| The ranking freeze that already makes half the firewall true | `packages/shared/src/algolia.spec.ts` ~:242/:262/:274 (per-entity `customRanking` frozen to its exact Stage-1 value) and ~:283-291 (regex over the union of `searchableAttributes ∪ attributesForFaceting ∪ customRanking`). *(AECI-636 PR-B, 2026-09-22: no longer the Stage-1 values. AECI-636 reopened the freeze by decision; see §3.2.)* | §3.2 |
| The email route-seam pattern (route declares a `Send*Email` type + no-op default as a factory param; `email.ts` exports a structurally-typed adapter; `index.ts` injects the real one) | `apps/api/src/routes/admin-claims.ts` ~:100-113 + `apps/api/src/lib/email.ts` ~:327-350 | §7 |
| Inline (queue-less) cron precedent — `queueForJob` returns `QUEUE_LESS`, so the job always runs in the `scheduled` handler | `MODERATION_CRON = '0 6 * * *'`, `apps/api/src/scheduled.ts` ~:135-137 | §7 |
| The daily data-quality check suite (report-only; each check is a pure async fn over an injected `Db`, emitting the `aeci.data_quality.check` gauge) | `apps/api/src/lib/data-quality.ts` | §2.1 |
| The launch-minimum entitlement readout, explicitly flagged for replacement here | ~~`apps/web/src/app/vendor/components/vendor-verified-status.ts`~~ — **deleted by §8**; the successor is `vendor/components/vendor-plan-panel.ts` | §8 |

**What the epic added.** `packages/shared/src/entitlements.ts`, the `ENTITLEMENT_REQUIRED` error code, the plan fields on `AuthenticatedSession`, the expiry emails, and the first route that could clear `vendors.verified`. The `vendor_entitlements` table and `lib/vendor-entitlement.ts` were also added, and both are gone since AECI-1358. Subscriptions replaced them, and `lib/license.ts` is the one writer of the mirror (§2.1).

---

## 2. The entitlement model — `vendor_entitlements` + the `vendors.verified` mirror (AECI-609)

A vendor's plan is its subscriptions: `licenses` rows on its billing account (§13, `VENDOR_SIGNUP_PROCESS.md` §5 E1, `DATABASE_SCHEMA.md` §8.6b and §8.6c). A subscription is live while `ended_at IS NULL`. AECI-609 built the first model, one `vendor_entitlements` row per vendor. AECI-1355 moved plan resolution onto subscriptions on 2026-10-14. AECI-1358 deleted the entitlement code, and migration 0082 dropped the table on 2026-10-17.

`vendors.verified` survives as a **denormalized mirror** of the plan. It is true exactly when the vendor holds a live subscription on any of its billing accounts.

**Who reads the mirror.** One public consumer is left: the pair page's version-diff gate. It reads the raw vendor row inside the API (`pickPrimaryVendorRow` in `apps/api/src/lib/drizzle-helpers.ts`) and never ships the flag. Admin, the vendor portal, data-quality and vendor retraction also read `verified`. The DB column and its index stay.

Every other public reader is gone, because each one let a visitor tell who pays. AECI-1264 deleted the `aec-vendor-account-badge` on 2026-10-09. AECI-1266 removed `verified` from `VendorLinkSchema`, `VendorListItem`, `VendorDetail` and the Algolia vendor record on 2026-10-12. It also retired the public `GET /api/vendors?verified=` filter. Zod strips a stale param, so the caller gets the unfiltered list, never a 400.

### 2.1 The mirror invariant, and its two mechanical guards

> **The mirror invariant.** `vendors.verified = true` **iff** the vendor holds a live subscription (`licenses.ended_at IS NULL`) on any of its billing accounts. One module writes it: `apps/api/src/lib/license.ts`. **No route handler writes `vendors.verified` directly.**

**The write is one idempotent statement.** Every subscription batch that `lib/license.ts` builds ends with `reconcileVerifiedMirror`. The one exception is the expiry-notice fence (`expiryNoticeStampStatements`), which cannot change whether a subscription is live (§7.5 point 4). The reconcile sets `verified` to EXISTS(a live subscription) and is guarded on `verified <>` that value. D1 evaluates the predicate inside the one `UPDATE`, so there is no read-then-write race. That is the property the old one-row-per-vendor table existed to give, and the reconcile gives it without that table.

**`vendors.updated_at` moves iff `vendors.verified` moves.** The reconcile stamps `updated_at` and `plan_ended_at` only when it flips the bit. A grant or extend that leaves the mirror unchanged moves neither. See R2 in §10.

**The audit log is the history ledger.** Each subscription write records its own audit row under `entity_type = 'billing_account'` in the same `db.batch` (`DATABASE_SCHEMA.md` §8.6c). Ended subscriptions stay as rows with their own dates and `end_reason`. The legacy `vendor_entitlement.*` rows are keyed on the vendor id and still render (§5.6.2).

**Guard 1: compile-time (sole-writer lint).** An ESLint `no-restricted-syntax` rule rejects a Drizzle `.set({ verified: … })` on `vendors` anywhere outside `apps/api/src/lib/license.ts` (`MIRROR_WRITE_EXEMPT` in `eslint.config.base.mjs`). A twin selector rejects `db.insert(vendors).values({ verified: true })`, which the `.set` selector alone would miss. Both are anchored to the Drizzle chain, not the property name, so read projections and `signal.set({…})` stay clean. `ANGULAR_STYLE_GUIDE.md` §24 lists the rule.

**Guard 2: run-time (drift check).** `license_mirror_drift` in `apps/api/src/lib/data-quality.ts`, severity `error`, run by the 04:00 UTC cron. It counts vendors where `verified = 1` XOR a live subscription exists. It rides the existing `aeci.data_quality.check` gauge and lands in the daily digest. It catches what lint cannot: hand-written D1 SQL against a tier, and the `apps/datatool` Worker, which can write prod D1. It shipped at `warn` (AECI-1354) and went to `error` with AECI-1355. Its predecessor `entitlement_mirror_drift` compared `verified` to the entitlement row and was retired on 2026-10-17 (AECI-1375).

### 2.2 The table

Dropped 2026-10-17 (AECI-1358, migration `0082_lying_paper_doll`), and `migration-0082.spec.ts` is the tripwire. The plan tables are `billing_accounts` and `licenses` (`DATABASE_SCHEMA.md` §8.6b, §8.6c, and §8.6 for the dropped table).

### 2.3 The batch shape, concurrency, and the second-seat matrix

Retired with `lib/vendor-entitlement.ts` (AECI-1358), whose activate, renew and deactivate builders this section described. A subscription batch's own shape and race guards (`noLiveLicenseSentinel`, `liveLicenseRemainsSentinel`) are in `lib/license.ts` and `DATABASE_SCHEMA.md` §8.6c.

### 2.4 Backfill, seeds, and the pre-existing `verified = true` rows

Retired (AECI-1358). Both back-fill scripts ran on every tier and are deleted. The seeds (`apps/api/seed/phase2-fixtures.sql`, `catalog.sql`) insert subscriptions directly, so a fresh local D1 has no vendor whose `verified` disagrees with its live subscriptions, and `license_mirror_drift` reads 0.

### 2.5 What this epic deliberately does NOT touch

> **No public or read path may query `licenses` or `billing_accounts`.** The vendor guard (§4), the vendor and admin routes and the daily jobs read them. No public read config does.

The obvious "improvement" is to join `licenses` into a public read so it reads the truth rather than a mirror. That would defeat the denormalization and put a plan lookup on every public request. `apps/api/src/lib/drizzle-helpers.read-path.spec.ts` scans every read-path module and fails on a reference to either table. It still fails on the name `vendor_entitlements` too, as a guard against a resurrected name.

A public read that needs a plan fact reads a mirror written in the same batch as the subscription write. The version-diff gate reads `vendors.verified` (§2). The "until" caption reads `products.managed_ended_at` (AECI-1614, §7.8, ADR 0051). It read `vendors.plan_ended_at` too, for a held connector-powered row, until ruling 14 (2026-11-09, AECI-1663). That column keeps its mirror and its drift check, but no public caption reads it now.

Every subscription write that changes a public page purges through `vendorPurgeTags` in `apps/api/src/lib/vendor-cache-tags.ts` (§5.3). One shared builder means no path can purge a different tag set from another.

### 2.6 As built (AECI-609 — 2026-08-14)

Retired (AECI-1358). The table, `lib/vendor-entitlement.ts`, its back-fill and its seeds are deleted. The decisions that still hold are in §2.1: the vendor-keyed audit trail, Guard 1's two selectors, and Guard 2 as a data-quality check. `vendorPurgeTags` is in §2.5.

---

## 3. The capability registry (AECI-610)

### 3.1 Vocabulary and the tier ladder

**Glossary (AECI-1609).** "Subscription" in copy is "license" in code and the database. Copy about Stripe's one object says "your billing" or "your Stripe plan". Engineering docs say "Stripe subscription". A "paid subscription" is one paid by card through Stripe (`source = 'stripe'`). Invoiced and complimentary subscriptions keep those names, and a rule about a paid subscription does not cover them.

**`packages/shared/src/entitlements.ts`** — a root-level module with its own `"./entitlements"` entry in `packages/shared/package.json`, **not** under `src/api/`. `api/*` is the wire-contract namespace (request/response Zod); this is a domain rule table like `algolia.ts`, `agreement.ts`, `slug.ts`.

**It must import no zod.** `hasCapability` is consumed by the lazy `/vendor` Angular route (§8), and `packages/shared/package.json` carries an explicit note that one value import from an `api/*` module once dragged the entire schema set plus a 327 kB zod chunk into the Angular initial graph. Enforce with a file-scoped `no-restricted-imports`. The wire shapes live in `packages/shared/src/api/vendor.ts`: `VendorEntitlementBlockSchema` and the tier, status and capability enums, built from the registry. The admin subscription shapes are in `api/admin-licenses.ts`.

```ts
// packages/shared/src/entitlements.ts — PURE DATA + PURE FUNCTIONS. No zod.

export const CAPABILITIES = [
  'profile.edit',              // PATCH /api/vendor/profile — every company detail
  'profile.rich_fields',       // the extended vendor field set
  'product.edit',              // the integrations page URL and the API docs URL
  'product.listing.edit',      // AECI-1214 — product description, website, logo
  'product.categories.edit',   // AECI-1214 — product category_slugs
  'product.taxonomy.edit',     // product trades, audiences, phases
  'product.usefulness.edit',   // AECI-963 — the "how teams use it" narrative
  'attestation.author',        // AECI-623 — the attestation + product-version writes
  'analytics.view',            // vendor analytics — declared, no consumer yet
  'integration.version_diff',  // AECI-304 — consulted by `./version-diff`
  'review.reply',              // AECI-1176 — a public reply to a review; every claimed tier since AECI-1590
] as const;

/** The binary ladder at launch (§8.5). Adding a rung = one key here + one row in TIER_CAPABILITIES. */
export const TIERS = ['unclaimed', 'verified'] as const;

export const TIER_CAPABILITIES = {
  unclaimed: ['profile.edit', 'product.listing.edit', 'product.categories.edit', 'review.reply'], // Free (§13.3; review.reply since AECI-1590)
  verified: [...CAPABILITIES],   // Verified unlocks everything §8.1(3) lists
};

/** Fail-closed: no plan, unknown tier, or non-active status → 'unclaimed'. */
export function tierFor(e: { tier: string; status: string } | null | undefined): EntitlementTier;
export function hasCapability(tier: EntitlementTier, cap: Capability): boolean;
export function capabilitiesFor(tier: EntitlementTier): readonly Capability[];
```

> **Amended 2026-10-01 by §13.3 (AECI-1212), built by AECI-1214 (2026-10-02).** The registry holds ten ids: `product.listing.edit` and `product.categories.edit` are new. `unclaimed` holds `profile.edit` and both new ids. That is the Free plan. Every field's capability is in `VENDOR_FIELD_CAPABILITIES` / `PRODUCT_FIELD_CAPABILITIES` in the same module.

> **Amended 2026-10-02 by `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.9 (AECI-1174).** The registry gains `review.reply`, the gate on a vendor's public reply to a review. It is held by `verified` only. `unclaimed` must not hold it. Opening it to Free is a one-line move into `TIER_CAPABILITIES.unclaimed`. AECI-1176 changes the code. **Built by AECI-1176 (2026-10-02).** The registry holds eleven ids. This supersedes the AECI-313 flag-only ruling of 2026-07-02. Reporting a review stays an email: `support@aecintegrations.com` since 2026-10-09 (AECI-1265, ruled by Chris: there is no reviews@ mailbox; it was `reviews@thewbsproject.com` before).

> **Amended 2026-11-03 (AECI-1590). `unclaimed` now holds `review.reply`.** Chris ruled on AECI-308 that gating a vendor's reply to a review behind payment is the "pay to defend" pattern. Every claimed company may reply to a review of its product, on any plan. One reply per review per vendor and pre-moderation stay. AECI-1590 made the one-line move the 2026-10-02 amendment anticipated. The id stays in the registry, so the eleven ids, the route gates and the §3.2 firewall are unchanged. `requireProductCapability(c, productId, 'review.reply')` now passes for every live tier. It still fails closed with `403 ENTITLEMENT_REQUIRED` on a tier the build does not know. The text above that says `unclaimed` must not hold it is superseded.

Three capabilities are **declared with no consumer on purpose**: `attestation.author` (AECI-301), `analytics.view`, and `integration.version_diff` (AECI-304). Minting the ids now means those later issues become pure render-path/handler changes with no registry edit, and it makes the vocabulary auditable in one place today.

> **Corrected 2026-09-24 (AECI-1107).** The registry holds **eight** ids, not seven: AECI-963 added `product.usefulness.edit`. Only `analytics.view` is still declared with no consumer. `integration.version_diff` gained its consumer in AECI-304 (`canViewVersionDiff`, §3.3(c)). `attestation.author` gained its consumers in AECI-623: the three attestation writes and the three product-version writes call `requireCapability(c, 'attestation.author')` (§3.3(a)), and the portal's Integrations tab reads the same capability. So a vendor whose plan lapses loses confirming, denying and clearing data flows. Since AECI-1214 it keeps company details and the four `listing_tier` product fields, and loses only the Managed product fields (§13.3). The lapsed plan panel (§8) names what is paused.

The ladder is **binary at launch**: `unclaimed` (no live subscription, "Free" in copy) vs `verified` (a live subscription, "Managed" in copy). `STAGE_2_SPEC.md` §8.2's "tier ladder above the entry Verified fee" stays open as a *pricing* question; this structure makes answering it a data edit.

> **Ruled 2026-10-13: the next rung is Insights, above Managed.** Performance reporting leaves Managed, and `analytics.view` leaves `verified` when the rung is built (`VENDOR_PERFORMANCE_SPEC.md` §1.1, amended). Plans are versioned. `docs/ROADMAP.md` §3 has the version convention.

> **The connector carve-out mints no capability id, and adds no rung** (`STAGE_2_SPEC.md` §8.9(2), AECI-704). A pure connector vendor's catalogue-maintenance seat is authorized by `profiles.role = 'vendor_admin'` + `profiles.vendor_id` on the connector admin routes — outside this registry entirely. So it needs no subscription and never lights the `vendors.verified` mirror. Do not add a `partner` tier to reach that outcome. No tier is stored: any live subscription resolves to `verified` (§4.1), and any live subscription flips the mirror (§2.1).

> **Integration actions are deliberately outside this registry (`STAGE_2_SPEC.md` §8.10(3), epic AECI-1003 decision 15).** There is **no `integration.edit` capability**, and no integration route calls `requireCapability` or reads the entitlement tier. That covers the owner's claim, standard-field edit, retire and create (AECI-1005, 1006, 1010, 1011), an endpoint vendor's per-side links (AECI-1007), and contests (AECI-1008, the first to ship). A vendor seat, `requireVendor()`, is the whole gate. What the vendor may do to a row then follows only from its relationship to that row: owner, endpoint vendor, or neither. **Do not add `integration.edit` by reflex.** It would fail every §8.9 seat by construction, since a seat with no subscription resolves to `unclaimed`, and it would make the accuracy of a public page something a vendor buys.
>
> **How that squares with an owner paying.** Decision 14 (§8.10(1)) says an owner pays, and a third-party owner holds a Managed subscription (§8.10(2)). The payment is enforced at the **seat grant**, not at the route: who gets a seat is the commercial control, applied by the operator in `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2. The capabilities the `verified` tier does gate are the ones in the list above. Two of them name integrations, and neither is an ownership action: `attestation.author` belongs to endpoint vendors (a third-party owner has no attestation seat on its own rows, `STAGE_2_SPEC.md` §8.4(2)), and `integration.version_diff` gates a read keyed on the pair's endpoint vendors (AECI-304). No capability gates claim, edit, retire, create, per-side links or contest.
>
> **Answered 2026-11-11 (AECI-1653): the seat grant is no commercial control, and an owner no longer pays.** The claim above died in two steps. Since AECI-1367 (2026-10-15) every claim approval lands on Free (§13.6): the grant's batch writes the seat, the billing account, the terms acceptances and `vendors.owned_at`, and no subscription — nothing at the grant enforces payment. The cited `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 procedure is itself retired (2026-10-15) and now says a connector-vendor claim "is approved like any other and lands on Free". Then ruling 14 (Chris, 2026-11-09, AECI-1663) dropped the payer test's second clause (`STAGE_2_SPEC.md` §8.10(1)(b)): "Managing an owned integration needs a seat, not a payment. Any seat may manage, a §8.9 catalogue-maintenance seat included." Free vendors own and manage integrations by design (§13.6, ADR 0048, ADR 0035's 2026-11-09 amendment), because correcting a listing must never be something a vendor buys. The note's closing sentences still hold: no capability gates claim, edit, retire, create, per-side links or contest, and neither integration-naming capability (`attestation.author`, per product since AECI-1355; `integration.version_diff`) is an ownership action.
>
> **Revisit trigger: when tiers differentiate.** While the ladder is binary (`unclaimed` / `verified`), a capability on integration routes would separate nothing a seat does not already separate. If a rung is added above `verified`, or a seated vendor can exist without a subscription and still own integrations it manages, reopen this. §8.10(6) names the second case: once AECI-1040 lifts decision 9, a free §8.9 seat could act on owned connector-powered rows, and closing that may need the first entitlement check on an integration ownership route.
>
> **Second case fired and answered 2026-11-11 (AECI-1653): accepted by design, not closed.** Since AECI-1367 a seated vendor exists without a subscription and still owns integrations it manages, by design (§13.6), and ruling 14 (2026-11-09, AECI-1663) accepted the free-seat hole rather than closing it: "the hole is accepted, not closed. A §8.9 seat whose vendor owns a connector-powered row may claim and manage it without paying, because correcting a listing must never be something a vendor buys" (`STAGE_2_SPEC.md` §8.10(6)). No capability check was added. Only the first case remains live — "The revisit trigger above stands for tiers in general" (the withdrawal note below).
>
> **Answered 2026-10-01 (AECI-1212):** see §13.5. **Re-answered 2026-11-11 (ruling 14, AECI-1663; recorded by AECI-1653):** the fired second case is accepted by design, and §13.5 states both answers.
>
> **Withdrawn 2026-11-09 by ruling 14 (AECI-1663).** The two paragraphs below record a gate that no longer exists. The owner of a connector-powered row claims, edits, retires, restores and decides contests on it with a seat alone, on any plan, as decision 15 says for every other row. Any seat qualifies, a §8.9 catalogue-maintenance seat included, so §8.10(6) is superseded rather than closed. `requireActiveEntitlement`, `integrationEntitlementRequired` and `INTEGRATION_ENTITLEMENT_REQUIRED` are deleted. No subscription end moves a contest. `hasActiveEntitlement` survives for the search-engine submission exception below only. The revisit trigger above stands for tiers in general.
>
> **Reopened and ruled 2026-09-23 (AECI-1040, `STAGE_2_SPEC.md` §8.10(8)). Built for the claim (AECI-1089), the edit (AECI-1090), retire and restore (AECI-1091) and the contest decision (AECI-1092), all on the same helper.** The shared gate is `apps/api/src/lib/integration-entitlement.ts`: `requireActiveEntitlement(c)`, `hasActiveEntitlement(session)`, and `integrationEntitlementRequired(session)`, the one constructor of `403 INTEGRATION_ENTITLEMENT_REQUIRED` (`details: { tier, status }`, `API_CONTRACTS.md` §4). It reads the session's `entitlementTier`, which `sessionPlanFromLicenses` makes `verified` only while the vendor holds a live subscription on any of its billing accounts. So it costs no read and fails closed. It has its own code rather than `ENTITLEMENT_REQUIRED` because that code promises a `details.capability` this gate does not have.
>
> An owner's claim, edit, retire and restore of a connector-powered row need an active entitlement, which means at least one live subscription. So does an owner's **decision on a contest** over a connector-powered row, accept or decline, because that too is an owner write (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13, follow-up ruling 2). The contest owner check reads subscriptions too (`vendorHoldsActiveEntitlement`, `ownerEntitlementActiveSentinel`). It is a named exception to decision 15. It is not a capability. There is still no `integration.edit`, and no tier is compared. The gate is vendor-level, because an integration is not one product's.
>
> When the vendor's last live subscription ends, the same batch moves its open owner-routed contests on those rows to the AECi admin queue. An admin revoke does this (AECI-1092, moved to the subscription revoke by AECI-1375), and so does the 11:00 lapse (ruled 2026-10-19, `lib/license-lapse.ts`). Every other integration route, and every contest on a row that is not connector-powered, keeps the seat as its whole gate. A §8.9 seat holds no subscription, so it fails the check. That closes §8.10(6) at write time, which an operator rule at seat grant could not do once ownership moves after the grant.

> **Search-engine submission is a second named exception (AECI-1186, 2026-10-02).** A vendor write's post-commit re-crawl buffer reads the plan too. It is not an integration action and gates no write: the write commits and purges whatever the plan. Only the IndexNow and Google worklist buffering is skipped without a live subscription. It uses the same `hasActiveEntitlement` helper, so any live subscription passes and no tier is compared. See §3.3(d). *Since the 2026-10-14 ruling (AECI-1355) it is per product as well: a write that names a product buffers only when that product holds a live subscription on the writing vendor's own billing account (§3.3(d), per-product note).*

### 3.2 The ranking firewall — what the unit test asserts

`packages/shared/src/entitlements.spec.ts`, seven assertions, escalating:

1. **Frozen vocabulary** — `expect(CAPABILITIES).toEqual([…literal list…])`. A new capability id fails the test until someone edits it deliberately. A speed bump; weak alone.
2. **Ranking-vocabulary regex** — no capability id matches `/rank|placement|position|boost|sponsor|feature|priorit|weight|sort|relevance|pin|top/i`. Same shape as the existing regex-over-a-const-table guard at `algolia.spec.ts` ~:283-291.
3. **The disjointness proof — the headline.** Both tables are pure data in the same package, so the claim is *provable*, not documented:

```ts
const rankingVocabulary = new Set(
  INDEX_ENTITIES.flatMap((e) => {
    const s = indexSettingsFor(e);
    return [...s.searchableAttributes, ...s.attributesForFaceting, ...s.customRanking];
  }).map(stripAlgoliaWrapper),   // unordered(x) | searchable(x) | desc(x) | asc(x) -> x
);

// (a) No capability can name a ranking attribute.
for (const cap of CAPABILITIES) expect(rankingVocabulary.has(cap)).toBe(false);

// (b) No entitlement concept may appear in INDEX_SETTINGS at all. The Algolia vendor
//     RECORD may carry `verified` (AECI-529, display-only); INDEX_SETTINGS may never name it.
for (const banned of ['verified', 'tier', 'entitlement', 'status', 'paid', 'plan'])
  expect(rankingVocabulary.has(banned)).toBe(false);
```

*(As revised (AECI-1266, 2026-10-12). The Algolia vendor record no longer carries `verified` at all. Assertion (b) is unchanged: `INDEX_SETTINGS` still may never name it.)*

> **The entitlement vocabulary and the Algolia ranking vocabulary are disjoint sets, and the disjointness is asserted, not documented.**

4. **Computed-attribute inputs (added by AECI-636, 2026-09-21).** Assertion 3 checks attribute *names*. That stops being enough once a ranking attribute is *computed*: `listing_tier` could carry a plan through its inputs while its own name stays clean. So the same spec now asserts, for `productListingTier` and `vendorListingTier` in `packages/shared/src/listing-tier.ts`:
   - the declared input lists (`PRODUCT_LISTING_TIER_INPUTS`, `VENDOR_LISTING_TIER_INPUTS`) contain no `verified`, `tier`, `entitlement`, `status`, `paid`, `plan`, `priority` or `seat` substring, and no capability id, tier id or status value;
   - each function reads **exactly** its declared inputs and nothing else, checked with a recording `Proxy` over inputs that also carry every plan-shaped field;
   - the tier is identical whatever plan-shaped fields ride along; and
   - each function takes one argument, so a plan cannot arrive as a second parameter.

   Adding a plan-shaped input, or reading one without declaring it, fails the build. It is an invariant test like the other three.

5. **No `listing_tier` input may need a plan to edit (added 2026-10-01, AECI-1212, built by AECI-1214).** Every `listing_tier` input maps to the wire field that writes it, or to "not vendor-editable" for `name` and `company_name`. Each field's capability, read from `PRODUCT_FIELD_CAPABILITIES` / `VENDOR_FIELD_CAPABILITIES`, must be in `TIER_CAPABILITIES.unclaimed`. The API builds its column maps and facet gate from those tables, so the test checks the gate the routes enforce. See §13.4.

6. **A review reply never reaches a ranking input (added 2026-10-02, AECI-1181, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.10).** Any claimed vendor writes a reply under the `review.reply` capability, on any plan since AECI-1590. A reply is still vendor-authored text that a vendor chooses to write, so a ranking input that read one would let a vendor write its way up the rankings. The firewall is what keeps replies out of ranking, whoever may write them. *(Amended 2026-11-03, AECI-1590: the reason read "written under the `verified`-only capability" until replies opened to Free. The assertion is unchanged.)* Block 6 of `entitlements.spec.ts` asserts, as data, that no `INDEX_SETTINGS` searchable, facet or `customRanking` attribute, no Algolia record field, no public `?sort=` key and no `listing_tier` input names a reply (`review_responses`, `vendor_responses`, `reply*`), and that `listing_tier` reads no reply field that rides along. The source half is `apps/api/src/lib/review-reply-ranking-firewall.spec.ts`. It scans every file that computes a ranking input (`sort.ts`, `recompute-counts.ts`, the Algolia builders, sync and drift reconcile, the datatool reindex, `algolia.ts`, `algolia-records.ts`, `listing-tier.ts`) for the reply table, its Drizzle handle, its module or a reply field, and pins both public review lists to `created_at DESC, id ASC`. A new ranking-input file joins that list.
   **Extended 2026-11-06 (AECI-1613) to reviewer updates.** An update is reviewer-authored, not vendor-authored, and it has one sanctioned path into ranking: the latest approved update that carries ratings is its review's rating in the stored averages (`DATABASE_SCHEMA.md` §11.2). Block 6 also asserts, as data, that no `INDEX_SETTINGS` attribute, Algolia record field, public sort key or `listing_tier` input names an update (`review_update*`, `updates`, `update_count`). The source half asserts that no other ranking-input file names the update table or module, that `recompute-counts.ts` reads it only inside `effectiveRatingSql`, and that only the two averages call that function, never `review_count`. A vendor reply can invite an update but cannot write one.

7. **A company fact never reaches a ranking input (added 2026-11-05, AECI-1310, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23).** Size, funding and ownership describe a vendor and must not rank small vendors down. Block 7 asserts that no `INDEX_SETTINGS` attribute, Algolia record field, public `?sort=` key or `listing_tier` input names a company fact or its provenance. `headquarters` and `founded_year` predate the rule and keep their existing search roles.

8. **No on-page order reads an input a paid plan can change (added 2026-11-14, AECI-1814).** The first seven assertions cover search attributes, sort keys and `listing_tier` inputs. This one covers the order of lists on a page. No on-page sort, default order or featured subset may read an input that only a capability outside `TIER_CAPABILITIES.unclaimed` can change. The tests are `apps/api/src/lib/on-page-ordering-firewall.spec.ts`, `apps/web/src/app/products/on-page-ordering-firewall.spec.ts` and `apps/web/src/app/products/on-page-ordering-firewall.component.spec.ts`.

   **The rule is ruling R1** (Chris, 2026-11-14, AECI-1732): "Maintain orders as they are. If its a new feature a to z". As applied:
   - Every new on-page list is A to Z by name, with the id as the tie-break.
   - The via-lane groups and the powered-hub groups keep their count order.
   - The pair page keeps integrations first, then evidenced pairs.
   - "Confirmed by both companies" is a row label only. It is never a filter or a sort.

   **The Managed-only inputs are derived from the registry.** The test computes the Managed-only capabilities as `CAPABILITIES` less the Free set, and fails if one has no declared inputs.

   | Capability | What a vendor can change that a page could order by |
   |---|---|
   | `product.edit` | `tool_integrations_url`, `api_docs_url` (from `PRODUCT_FIELD_CAPABILITIES`) |
   | `product.taxonomy.edit` | `audience_slugs`, `phase_slugs`, `trade_slugs`, so each term's product count |
   | `product.usefulness.edit` | `usefulness` |
   | `attestation.author` | Claim agreement ("confirmed by both companies"). A denial, which can refute a claim and lower the data-flow count. Vendor-added data objects, which raise it. Deleting or withdrawing an added object, which lowers it. Product versions and the version stamps on a claim. The maintenance stamps an attestation write moves |
   | `integration.version_diff` | The depth of the pair page version diff |
   | `analytics.view`, `profile.rich_fields` | Nothing public today |

   Plan state itself is set too: a live license, the `vendors.verified` mirror, and the plan-end mirrors and edit stamps.

   **How each surface is tested.** Every behavioural case runs in two directions, so an order that rewards a plan and one that punishes it both disagree with today's order in at least one run. Every fixture holds a real tie at each comparator level, so the tie-breaks run too.

   | Surface | Order | How |
   |---|---|---|
   | Product page, direct lane | Partner name, edge name, id | Behavioural. Every non-order row field is set rising and falling along the fixture. Each partner in turn also gets every paid input at once |
   | Product page, "Via" groups | Row count, connector name, unnamed last. Rows A to Z | Same, and each group in turn gets every paid input |
   | Product page, the reader's filter | Removes rows. Never reorders | Same, with no query and with one |
   | Product page, rows above the `@defer` cut | The first `INTEGRATIONS_ABOVE_FOLD` (20) rows of the two orders above | Same, with cuts that split a lane and the real 20-row cut over 32 rows |
   | Product page, the section component | Split, then filter, then cut | Rendered in a component spec. The rendered row order and row set do not move when the paid inputs change, rising, falling or loaded onto one row. With no filter selected every row renders, up to the cut, so a default filter on a paid input fails. A filter the reader types keeps the same rows whatever the paid inputs. A structural check also bans any comparator, `.filter(`, `.slice(` or `.splice(` in the component: a reader-chosen filter belongs in `integration-filter.ts` |
   | Connector page, powered hubs | Partner count, hub name. Partners and flat pairs A to Z | Behavioural, as above, with the filter |
   | Pair page mechanisms and claims | Integrations A to Z then id, then evidenced pairs A to Z then id. Claims by the data object vocabulary, nulls last | Behavioural over the D1 harness: a free database and two paid ones. One paid database loads the rows and claims that sort last and denies those that sort first. The other does the opposite. The loaded rows carry every version stamp, and each lowered row carries one, on its last claim. The two rows that tie on name under NOCASE get different paid inputs and vote counts in each paid database |
   | `related_products` | Newest first, id tie-break, six shown | Behavioural, two paid databases. Four products share one `created_at` across the sixth place, as promote writes them. The page product carries every paid input too, so an order matching the page's own tags would fire |

   Every row field of `ProductIntegrationItemSchema` and `PoweredIntegrationItemSchema` is classified as an order input or a payload field. A new field fails until it is classified. AECI-1781's `agreement`, `data_objects` and `partner_categories` are payload fields.

   **Why the count orders pass.** Via-group and powered-hub counts change only through promote, the vendor integration create, and the shared retire and restore write. A source scan finds those three writers. It reads aliased and namespace imports of the two row tables, and flags any `.set(` it cannot read. It asserts that none of these calls a plan check: the three writers, the three files whose `.set(` it cannot read, every caller of `anchorUpdate` (derived, today `vendor-contests.ts` and `admin-contests.ts`), and the routes that rename a row. A plan check is a capability gate, `productTier`, `hasActiveEntitlement`, `assertFieldsEntitled` or `entitlementRequired`. It is a tripwire, not a proof. A write through a generic table variable would pass unseen. A vendor create cannot make a via-lane row at all: its body has no `powered_by` field and refuses `iPaaS`.

   **The surface list is hand-written.** A surface is covered only once it is registered. Surfaces not built yet are pending entries, each owned by the issue that builds it: closest matches (AECI-1829), the Browse menu's term order (AECI-1774), the redesigned integrations list (AECI-1782, AECI-1783), the hero visual (AECI-1787) and similar products (AECI-1785). They show as `todo` in the test run. No scan yet fails on an unregistered `orderBy` or `.sort(` on a public read path.

   **Accepted exception: taxonomy term counts.** The header's Browse menu (its Audiences and Trades columns, AECI-1774), the home page, the `/search` facets and the taxonomy index's "Most products" sort rank audience and trade terms by product count. The facet sidebar on browse pages, and the Browse menu, hide terms with no matching products. The Browse menu's key categories are a fixed editorial list and its Categories column counts Free tags, so neither is part of the exception (`browse-menu-term-order`, covered). The `/trades` publish floor cuts on the same count. Tagging a product with an audience, phase or trade needs `product.taxonomy.edit`, which only a Managed plan holds. So a Managed vendor can move a term up, or publish a trade. It is one named exception, `taxonomy-term-product-count`, because it orders terms, not vendors, and R1 keeps existing orders. **Accepted by Chris on 2026-11-14, by Slack: "A, create a ticket to address later".** The permanent rule is follow-up AECI-1836. The `/trades/:slug` noindex rule reads the same floor. It is an indexing decision, not an order, and the entry records it separately.

   How the exception is kept narrow:
   - `topByCount` is tested behaviourally. Every field but `product_count` is set rising and falling, on terms that tie on count, and the order and the top-N cut do not move.
   - The taxonomy index's "Most products" sort is tested behaviourally in a component spec. Its declared inputs are the count, then the term's integration count, then the name. The fixture ties on all three, two terms sharing a name, and every other field is set rising and falling: a tie-break on the description, its length or the display order moves the order. The integration count moves with the same tags and with seat-gated integration writes, so it adds no new Managed-only input.
   - Phases never order by count: the nav uses display order, and `/search` re-sorts phases into lifecycle order. Both are tested behaviourally.
   - The `/search` audience and trade facet order is Algolia's own count order. It is pinned by source only.
   - A source scan of the public pages in `apps/web` (not the admin console, the vendor portal or previews) lists every `topByCount` call, every count read (`product_count`, `.count` or `topByCount`'s `SORT_KEY`) inside a `.sort(` or `.toSorted(` call, helper arguments included, every subtraction of one count from another anywhere, every `product_count` compared with a number, every `.filter` that compares an item's `.count` with a number, and every use of the trade publish floor. It fails on any site the entry does not name. It is a tripwire, not a proof: a count reached without naming `product_count`, `.count` or `SORT_KEY` would pass. That covers a destructured field, a computed key, and a helper handed the whole term.

   AECI-1836 changes that one entry. The new Browse menu (AECI-1774) orders its audience and trade columns the same way, so it inherits the accepted count order.

**Search-engine submission is external discovery, not a ranking input (AECI-1186).** Since 2026-10-02 a vendor write buffers its changed URLs for IndexNow and the Google worklist only when the vendor holds a live subscription (§3.3(d), §13.1a). Since 2026-10-14 (AECI-1355) a write on a product also needs that product to hold the vendor's own live subscription. That gate tells Bing, Yandex and an operator that a page changed. It feeds nothing into Algolia, `listing_tier`, `customRanking` or any sort on our own pages, so none of the seven assertions above moves. It does not change where anything ranks on AECi. What a search engine does with a submitted URL is outside our control and outside this firewall.

The other half of the firewall **already exists and must stay untouched**: `algolia.spec.ts` ~:242/:262/:274 freeze each entity's `customRanking` to its exact Stage-1 value, so any attempt to add a ranking signal fails there first. **`packages/shared/src/algolia.ts` `INDEX_SETTINGS` and those three assertions are out of bounds for this epic** — see `SEARCH_RANKING.md`.

*(AECI-636 PR-B, 2026-09-22: the freeze was scoped to the AECI-515 epic. AECI-636 reopened it as a decision on 2026-08-23, not as test churn. `customRanking` is now `desc(listing_tier)`, `desc(review_count)` on products and `desc(listing_tier)` on vendors. The firewall also grew: `entitlements.spec.ts` now asserts that no entity's `customRanking` names a plan, entitlement or verified attribute. `listing_tier` is the one allowed name containing "tier", because the same spec proves its inputs are content only. See `SEARCH_RANKING.md` §1.)*

### 3.3 Where `hasCapability` is consulted — and where it is forbidden

**(a) `/api/vendor/*` writes** — in the handler, **after ownership settles, wherever there is an ownership question**: `requireCapability(c, 'profile.edit')`, throwing 403 `ENTITLEMENT_REQUIRED`. This is a **DB-free assertion** over `c.get('auth').entitlementTier` (§4) — no seam, no mock, trivially unit-testable. **`GET /api/vendor/me` and `GET /api/vendor/seats` are never gated** (§4.3).

> **Amended at build (AECI-611).** This bullet originally read "immediately after `sessionVendorId(c)`", which is not universally satisfiable. On `PATCH /api/vendor/profile` it holds — the caller's own vendor is the subject, so there is nothing to leak. On `PATCH /api/vendor/products/:id` the gate **must** run after `requireOwnedProduct`, because a 403 raised before ownership settles would confirm to a non-owner that the product exists, and **404-never-403 is the harder invariant** of this surface (`AUTH_AND_RLS.md` §4.2a). Same ordering as the AECI-607 version routes. The rule is "as early as possible, but never before ownership".

> **As built (AECI-623 — 2026-09-23).** `attestation.author` now has its consumers. The three attestation writes (`POST /api/vendor/claims`, `PUT` and `DELETE /api/vendor/claims/:claimId/attestation`, joined by `DELETE /api/vendor/claims/:claimId` in AECI-1245) and the three product-version writes (`POST`, `PATCH`, `DELETE` under `/api/vendor/products/:id/versions`) call `requireCapability(c, 'attestation.author')` after authority or ownership settles. They answer `403 ENTITLEMENT_REQUIRED` where they used to answer `403 FORBIDDEN`. The placeholder they replaced, `assertVerifiedVendor`, read the `vendors.verified` mirror and is deleted. No authorization decision reads the mirror any more. On an attestation write the connector-powered edge check still runs first and still answers `FORBIDDEN` (`STAGE_2_ATTESTATIONS_SPEC.md` §5.2). The portal's Integrations write gate reads the same capability (§8.1). *Since AECI-1355 (2026-10-14) the three version writes call `requireProductCapability` over the product's own live subscription. Since the 2026-10-14 ruling the three attestation writes do too, on the caller's endpoint product (see the ruling note below).*

> **As built (AECI-1355, E1.6 — 2026-10-14). Plan resolution reads subscriptions, per product.** `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 6: a product is Managed exactly when it holds a live subscription (`licenses.ended_at IS NULL`). So a write on ONE product gates on that product's tier through `requireProductCapability(c, productId, cap)`, a DB-free assertion over the session's `licensedProductIds` and `TIER_CAPABILITIES`, run after `requireOwnedProduct`. Its 403 has the same status, copy and `details` shape as `requireCapability`; `details.tier` is the product's tier. It gates the three product-version writes and the review-reply create and edit. The product PATCH keeps no route-level gate; (b)'s field gate takes the product's tier (`productTier`). `requireCapability` stays for `profile.edit`, over `entitlementTier`, which is now "the vendor holds any live subscription". The logo upload names no product and checks Free capabilities only, so it is unchanged. `TIERS`, `CAPABILITIES`, `TIER_CAPABILITIES` and the field tables are untouched, so §3.2 and §13.4 hold as they were.

> **Ruled 2026-10-14 (Chris, AECI-1355).** Attestations and search-engine resubmission are per product, like every other Managed right. A co-owned product is Managed only for the vendor whose billing account holds its subscription (`docs/VENDOR_SIGNUP_PROCESS.md` §2). As built:
>
> - **The three attestation writes** call `requireAttestationCapability` in `routes/vendor-attestations.ts`, which is `requireProductCapability(c, product, 'attestation.author')` on the caller's own endpoint product of the integration. It runs where `requireCapability` ran: after authority (404) and the connector-powered edge check (403 `FORBIDDEN`). A caller owning BOTH endpoints passes when EITHER endpoint product is Managed for it. The write fills every slot the caller owns and §4 counts one company as one voter, so the company's one vote is a right it has paid for on one of the two products it is about. The refusal is `403 ENTITLEMENT_REQUIRED` with `details.tier` = the endpoint product's tier. `DELETE /api/vendor/claims/:claimId` (AECI-1245) is gated the same way, with no edge check, as the retract has none.
> - **Only the payer gets Managed rights.** `licensedProductIds` is the products assigned to a live subscription on the caller vendor's OWN billing accounts. The old third statement (owned products subscribed on any account) is gone. Since AECI-1623 the third statement reads the open suspension (§4.1). A co-owner whose product is subscribed by the other vendor stays Free on it, in its writes and in its `GET /api/vendor/me` `plan`.
> - **Resubmission** is (d)'s per-product rule below.
> - **Unchanged, deliberately.** The connector-powered owner carve-out (`hasActiveEntitlement`, `INTEGRATION_ENTITLEMENT_REQUIRED`) stays vendor-level. It gates integration ownership writes, not attestation authoring, and the ruling did not name it. *Withdrawn 2026-11-09 by ruling 14 (AECI-1663): the carve-out and `canClaimConnectorPowered` are gone, so there is no difference left to describe.*

**(b) The vendor-editable column allow-list** — `VENDOR_COLUMN_MAP` / `PRODUCT_COLUMN_MAP` (`apps/api/src/routes/vendor.ts` ~:525-543, ~:605-611) go from `Record<string, string>` to `Record<string, { column: string; capability: Capability }>`, and `splitPatch` (~:390-403) gains the caller's tier. This extends the header invariant in `packages/shared/src/api/vendor.ts` from one axis to two: **Zod is the parse allow-list, the column map is the entitlement allow-list, and both must agree.** Every field maps to a capability `verified` holds. Since AECI-1214 the capabilities come from `VENDOR_FIELD_CAPABILITIES` / `PRODUCT_FIELD_CAPABILITIES` in `@aeci/shared/entitlements`, and the Free tier holds company details and the four `listing_tier` product fields (§13.3). Moving a field between plans is a data edit in those tables and `TIER_CAPABILITIES`.

**(c) The render path — deliberately asymmetric.**

- **Vendor portal (`/vendor`)** — non-cacheable and `Cache-Tag`-free by the fail-closed classifier, so per-session forking is safe. `GET /api/vendor/me` returns the vendor-level `entitlement` block and a `plan` block on each product (§13.7). Product forms disable on the product's own `plan`, never on `me.entitlement` (§8).
- **Public SSR (`/vendors/:slug`, `/products/:slug`, the pair page, all cacheable)** **never forks on the VIEWER.** The version-diff gate is the only public HTML that forks on a plan, and it forks on the subject vendor's tier: the pair's endpoint vendors, read off the `vendors.verified` mirror inside the API. That is a function of the entities already in the URL, already purged by their `vendor:` and `product:` tags. The vendor and product pages always read "Claim this listing" (AECI-1266), and no public label shows a plan (AECI-1264). There is no viewer axis on a cacheable request, and there must never be one: the Workers Cache is URL-keyed, so the first visitor would poison the entry for everyone. See R3 in §10.

> **Restated at build (AECI-304).** This bullet originally read "**no cacheable SSR component may import `@aeci/shared/entitlements`**", naming AECI-304 as the build that would reach for it. That sketch is the wrong shape, and reading it literally would reopen a settled decision. The product-pair resolver **does** import the registry, transitively (`version-diff.ts` → `entitlements.ts`), and is correct to: `canViewVersionDiff` forks on the **pair's two endpoint vendors' tiers**, which are a function of the two slugs in the URL. The page stays storable in the shared cache, shareable, and free of any `Cache-Control: private` — the constraint is discharged **by construction**, not by a module ban. So the rule is a **viewer-tier ban, not an import ban**. A future mechanical guard must either express the viewer-tier property directly or allow-list `@aeci/shared/version-diff`; none exists today (§3.4 note 4), so **R3 stays open** and this is review-only.

**(d) The post-commit re-crawl buffer (AECI-1186, built 2026-10-02).** `bufferVendorRecrawl` in `apps/api/src/routes/vendor-shared.ts` skips both queues, `indexnow_queue` and `gsc_recrawl_queue`, for a vendor-origin write whose session holds no live subscription. It reads `hasActiveEntitlement(c.get('auth'))`, so it costs no D1 read and fails closed. It never throws: the write has already committed. The gate keys off the write's origin, not the session alone. The admin retire shares this tail with a session that carries no plan, and AECi's own writes stay ungated, as promote's do. Vendor-only call sites derive URLs behind `vendorRecrawlEnabled(c)`, so a Free write skips that work too. Not a capability, for the reason in §3.1's AECI-1040 note: a renamed or added tier must not silently drop the benefit.

> **Per product (ruled 2026-10-14).** Resubmission is a Managed right of the PRODUCT. Past the vendor-level check, `bufferVendorRecrawl` reads the product the write names (`VendorRecrawl.productId`, the AECI-1184 cause product) and buffers nothing unless `productTier` says that product holds the caller's live subscription. The vendor-level check stays as the cheap necessary condition, because a subscribed product implies a live subscription. The product PATCH derives URLs behind `vendorProductRecrawlEnabled(c, productId)`, so a Free product skips its trade-floor read. A write that names no product stays on the vendor-level gate: the company profile edit, which `profile.edit` already limits to a vendor holding a live subscription, and an integration write whose owner holds neither endpoint. The integration writes (edit, links, claim, create, retire, contest decision, evidenced-pair edit) and the attestation writes name the caller's own endpoint, so they follow that product's subscription. An owns-both attestation names its framed endpoint, so a write the gate allows through the other endpoint's subscription buffers nothing when the framed one is Free.

> **As built (AECI-1376 — 2026-10-16). The history note follows the cause product.** The vendor history page used to derive "No expedited search submission" from the row's vendor-level plan snapshot (`sessionVendorPlan`), so a Free product's edit by a vendor subscribed elsewhere showed neither a submission nor that note. Now each listing write's audit row also records its cause product's plan, in `audit_log.product_tier` / `product_entitlement_status` (migration `0080`, `DATABASE_SCHEMA.md` §8.4), and the page reads that first (`product_plan`, `API_CONTRACTS.md` §6.14). A handler computes its cause product once and hands the same value to `stampCauseProductPlan` and `withRecrawlProduct`, so the note and this gate cannot disagree. A row about one product is stamped by `vendorAuditEntry` from its `product_id`. `sessionProductPlan` keys on `productTier`, the field this gate reads. "Plan at the time" and the CSV stay vendor-level (ruling 2026-10-16, Chris).
>
> **The deferred product read is gone.** `VendorRecrawl.productId` used to accept a thunk that the integration claim, the contest decision and the retire ran post-commit. A failed read recorded `null`, which put the write back on the vendor-level gate, so a subscribed vendor's Free product could be resubmitted. Those three handlers now read the owned endpoints before the batch (the claim inside its existing `Promise.all`, the contest only on an accept), because the audit stamp needs the value. A failed read fails the request before anything commits. `productId` is a plain `string | null`, and `null` now means only the ruled "names no product" case.
>
> **Issue note, checked.** The vendor Integrations list's owns-both lock (a row filed under a Free product, its other endpoint subscribed) was already fixed by AECI-1355: the list and the detail page both read `integrationCanAuthor`.

### 3.4 As built (AECI-610 — 2026-08-14)

Shipped as specified. Five source files, no behaviour: nothing consults the registry yet, by design.

| File | What landed |
|---|---|
| `packages/shared/src/entitlements.ts` | `CAPABILITIES` (the 7 ids as of AECI-610, §3.1 order; 8 since AECI-963), `TIERS`, `TIER_CAPABILITIES`, `tierFor`, `hasCapability`, `capabilitiesFor`, `isEntitlementTier`. **Zero imports.** |
| `packages/shared/src/entitlements.spec.ts` | The three-assertion firewall (§3.2) + the fail-closed matrix. 20 cases. |
| `packages/shared/src/api/admin-entitlements.ts` | The admin and session wire shapes. Deleted 2026-10-17 (AECI-1358, after AECI-1375 removed the write schemas). The session block and the tier, status and capability enums live in `api/vendor.ts`. The admin subscription shapes are in `api/admin-licenses.ts`. |
| `packages/shared/src/errors/codes.ts` | `ENTITLEMENT_REQUIRED`. No thrower yet — §4 wires it. |
| `packages/shared/eslint.config.mjs` | The file-scoped `no-restricted-imports` (§3.1). |

Four decisions worth knowing before building on this:

1. **`ENTITLEMENT_STATUSES` lives in the registry, not the wire module.** A small, deliberate addition beyond the §3.1 sketch. The status vocabulary is a plain `as const` array (zod-free, so it costs the bundle nothing), and putting it beside `TIERS` gave the D1 CHECK, the admin wire enum and the session block one list. The CHECK and the admin enum went with the entitlement table (AECI-1358). The session block (§4) still reads it, and `sessionPlanFromLicenses` maps subscriptions onto `active`, `expired` and `revoked`. `tierFor` still takes a loose `status: string` and fails closed on anything that isn't `active`, including a value outside the vocabulary.
2. **The registry is NOT on the root `src/index.ts` barrel.** That barrel does `export * from './api'`, i.e. it carries zod — the same reason `algolia.ts` was kept out. `@aeci/shared/entitlements` being the only import path makes R11 structural rather than a convention. **Import it by subpath; a root-barrel import will not resolve.**
3. **The lint ban also covers `api/*`, not just `zod`.** `no-restricted-imports` sees only direct imports, so one hop through a wire-contract module would reintroduce the chunk with nothing to catch it. Both halves are proved in `apps/web/src/eslint-config.spec.ts`, which now resolves `packages/shared` configs too — including the case that the ban is scoped to the one file and does not leak across the package.
4. **The §3.3(c) SSR import boundary is NOT built.** Deferred to whichever issue adds the first SSR consumer (AECI-614 is the likely one; AECI-304 is the build R3 actually warns about). **R3 stays open until then** — there is no mechanical guard today stopping a cacheable SSR component from importing the registry.

The disjointness proof carries a non-vacuity case of its own (it asserts the ranking vocabulary is non-empty and that the `unordered()`/`searchable()`/`desc()` wrappers really were stripped), because a broken strip helper would make every assertion below it pass trivially. Per AC 2, `algolia.ts` and the three `customRanking` freezes in `algolia.spec.ts` were not touched.

**Bundle impact, measured** (AC 5, `ng build --configuration production` before/after): **`main-*.js` is byte-identical** (51,305 B) and the chunk count is unchanged (99). The only delta anywhere is **+44 bytes in one lazy chunk** — the `ENTITLEMENT_REQUIRED` entry landing in the already-shipped `ApiErrorCode` map, which `apps/web` genuinely imports. No zod schema, no `TIER_CAPABILITIES`, and no registry function entered the browser graph. R11 held.

---

## 4. The entitlement gate (AECI-611)

### 4.1 Why the session, and not a middleware

**Decision: load the plan into `AuthenticatedSession` inside `createAuthzMiddleware` (`apps/api/src/lib/authz.ts`), but only on the `vendor_admin` branch.** That branch's per-request profile re-fetch is one `db.batch`, so one D1 round trip. It reads the profile, the vendor's own subscriptions, and since AECI-1623 the vendor's open suspension (`findVendorProfile`). The subscription statement scopes by a subquery on `profiles.vendor_id`, because a batch cannot feed one result into the next. It reads every live subscription on the vendor's own billing accounts, plus the latest ended one per account and assigned product. `requireAuth()` and `requireAdmin()` keep their plain profile read.

Four reasons:

- **Cost.** A separate `requireCapability()` middleware needs `vendorId` before it can look anything up, so its read **serializes after** the guard's. That is 2 D1 round trips per `/api/vendor/*` request instead of 1. Round trips dominate. Statements per round trip do not.
- **Coupling.** The epic's stated goal is "a single entitlement gate … entitlements are data, not code branches scattered across the app." A per-route middleware is opt-in, so an omission is a **silent authorization hole**, the same failure mode as forgetting the `vendor_id` scope. On the session, the tier is always present.
- **Granularity settles it.** The gate is **field**-granular (§3.3b). Two fields on the same request can require different capabilities. Route-level middleware cannot express that. It has to be a handler-level assertion over already-loaded state, which is exactly what a session field gives you.
- **`/api/admin/*` runs through the same middleware.** An admin session has `vendor_id = null`, so an *unconditional* subscription read would match nothing on every admin request. Branching on the guard variant keeps `/api/admin/*` **and** `requireAuth()` (`POST /api/reviews`, `DELETE /api/account`) free of it. That means zero added latency on the review-submit hot path. Reject the "just always read" simplification.

`sessionPlanFromLicenses` builds four session fields from the subscription rows:

- **`entitlementTier: EntitlementTier`**: `verified` iff the vendor holds any live subscription, assigned or not. **Always present, never optional**, because an optional field invites `session.entitlementTier ?? 'verified'`. It is `'unclaimed'` for non-vendor sessions and for a vendor with no live subscription. Named `entitlementTier` and **not `tier`**, see R4 in §10.
- **`entitlement: { status, tier, periodEnd, endedAt } | null`**: `active` while any subscription is live, with `periodEnd` the latest live `ends_at`, or `null` if any is monthly. Once none is live it carries the latest ended subscription's status (`expired` or `revoked`), `ends_at` and `ended_at`. It is `null` if the vendor never held one, and for non-vendor sessions.
- **`licensedProductIds`**: the products assigned to a live subscription on the vendor's OWN billing accounts. Only the payer gets Managed rights (ruled 2026-10-14). A co-owned product subscribed by the other owner is not in it. `productTier` reads it.
- **`licenses`**: `{ product_id, source, ends_at, ended_at, end_reason }[]` from the vendor's own accounts, so another vendor's terms never enter the session.

The last two are optional on the type for hand-built test sessions, and absence reads as no subscription. Live is stored state: a subscription past `ends_at` still grants until the 11:00 lapse writes `ended_at` (§7.6).

**Fail-closed.** A vendor with no live subscription, and every non-vendor session, resolves to `'unclaimed'`, so Managed writes 403. Nothing defaults to `'verified'`. The vendor audit snapshot (`sessionVendorPlan`) and the admin one (`vendorAuditStamp`) both use `licensePlanSnapshot`.

### 4.2 `ENTITLEMENT_REQUIRED` — 403, not 402

New code in `packages/shared/src/errors/codes.ts` (precedent: `REVIEW_BANNED`, which exists precisely so the UI can distinguish a specific rejection). `details: { capability, tier, fields? }`.

**403, not 402.** 402 Payment Required is semantically tempting, but it leaks a billing model into a wire contract that §8.1(4) requires to stay **payer-model-agnostic**, and `API_CONTRACTS.md` §4.1's status conventions have no 402 row.

**`splitPatch` throws, it does not silently drop.** For any provided field whose capability the tier lacks, throw 403 with `details.fields`. Silent dropping is the "silently un-verify a paying vendor" class of bug this codebase already learned once: the dirty-diff form (`vendor-profile-form.ts`) re-seeds its baseline from the echo and would settle **clean** on a value that never landed.

### 4.3 Reads are never gated

**`GET /api/vendor/me` and `GET /api/vendor/seats` must not consult a capability.** `/vendor` is gated by `vendorMeResolver`, which maps 403/404 to a **404 render** (a 401 goes to `/auth/login` instead — AECI-954). If `me` were ever capability-gated, a vendor whose last subscription ended would see a 404 for the entire dashboard — and could therefore never see the renewal notice this epic exists to show them. It is a one-line mistake with total blast radius on exactly the cohort you are trying to bill. **This is an acceptance criterion with its own test**, not a convention.

**The change history is ungated too (AECI-1194).** `GET /api/vendor/history` and `GET /api/vendor/history.csv` take a seat and nothing else, on every plan, Free included. A vendor sees what AECi changed on its records whether or not it pays (`API_CONTRACTS.md` §6.14).

### 4.4 As built (AECI-611 — 2026-08-18)

Shipped as specified: the plan read on the `vendor_admin` guard branch only, `entitlementTier` + `entitlement` on `AuthenticatedSession`, `requireCapability()`, the 403, and the two-axis allow-list. The read was a `leftJoin` on the entitlement row until AECI-1355 replaced it with the subscription read in §4.1. Six decisions this section did not pre-specify:

- **The gate's call site is not uniform, and §3.3(a) was amended for it.** See the amendment under §3.3(a): "immediately after `sessionVendorId(c)`" holds on `/profile` but not on a product write, where the gate must run after `requireOwnedProduct` or a 403 confirms a foreign product exists.
- **The plan wire shapes live in `api/vendor.ts`.** `VendorEntitlementBlockSchema` and the tier, status and capability enums sit there, with the `GET /api/vendor/me` response that carries the block. They were in `api/admin-entitlements.ts` until AECI-1358 deleted it.
- **The `me` block is built from the session, not from a query.** It costs no round-trip, and — the load-bearing part — the dashboard's readout and the 403 a write would get are built from the **same** field, so they cannot disagree.
- **`status: null` on the wire block means the vendor never held a subscription**, which distinguishes *never bought* from *lapsed*. It is never "unknown". §8 turned that distinction into two different panels.
- **Taxonomy is gated separately** (`product.taxonomy.edit`), as a unit rather than per-field: the facet arrays are set-replacement joins, not columns, so they never enter `PRODUCT_COLUMN_MAP` and `splitPatch`'s second axis structurally cannot see them. *Superseded by AECI-1214 (§13.3):* the facets are now gated per field from `PRODUCT_FIELD_CAPABILITIES` by `assertFieldsEntitled`. `category_slugs` is `product.categories.edit`; the other three stay `product.taxonomy.edit`.
- **`product.usefulness.edit` is the FIRST `PRODUCT_COLUMN_MAP` entry whose capability is not `product.edit` (AECI-963)**, which makes it the only field where the second axis is separately observable. Withholding narrative authorship from a rung is a data edit rather than a handler change. Since AECI-1214 there is no base `product.edit` check: the Free plan (`unclaimed`) is refused `usefulness` by its own capability, with `details.fields: ["usefulness"]`. Unlike taxonomy above, `usefulness` **is** a real `products` column, so it sits in the map. The handler's per-field gate (`assertFieldsEntitled`) checks it, with every other sent field, BEFORE term resolution, so an unentitled caller gets its 403 rather than a 400 from a read it was never allowed to make.
- **`profile.rich_fields` is minted and deliberately unused.** Every shipped company field maps to `profile.edit`. Product fields map to `product.listing.edit`, `product.categories.edit`, `product.edit`, `product.taxonomy.edit` or `product.usefulness.edit` (§13.3). Splitting the profile field set into basic-vs-rich is a *pricing* decision (§8.2 of `STAGE_2_SPEC.md`), and pre-assigning fields to a rung nobody has priced would bake in an answer. The id exists so that decision stays a data edit.

`entitlementRequired()` is the single constructor for the error, so the status, the copy and the `details` shape cannot drift between the route-level gate and the field-level one. The copy points at activation and **never** at ranking, placement or search.

---

## 5. Admin entitlement action — set / renew / clear (AECI-532)

This section began as the admin set / renew / clear entitlement action. That action is retired. `PATCH /api/admin/vendors/:id/entitlement` answers `404`, and `/admin/vendors/:id` has no Entitlement section (AECI-1375, E4.6).

Admin billing writes are now subscription writes. Grant with `POST /api/admin/vendors/:id/licenses`. Extend or re-reference with `PATCH /api/admin/licenses/:id`, and end with `revoke` (`API_CONTRACTS.md` §6.10). `vendors.verified` is a mirror, reconciled from the vendor's live subscriptions at the end of every subscription batch. No route writes it directly (§5.6.1). A revoke that ends the vendor's last live subscription carried the AECI-1092 contest re-route until AECI-1663 (ruling 14, 2026-11-09). §5.2 to §5.4 and §5.6 describe what the admin console does today.

*As built 2026-11-10 (AECI-1615, counsel Q5).* A grant writes no subscription. It writes one pending `license_grants` row (`DATABASE_SCHEMA.md` §8.6h). The subscriptions are written only when an owner accepts it on the Billing tab (`POST /api/vendor/license-grants/:id/accept`), or at once when the grant records a signed deal. So a grant turns `vendors.verified` on only at activation. AECi withdraws a pending grant with `PATCH /api/admin/license-grants/:id`. A pending grant nobody accepts expires at its end date (§7.9). Grants live before AECI-1615 stay live (ruling R3).

### 5.1 Endpoint

Retired 2026-10-17 (AECI-1375). The subscription routes in §5.6.1 replace the entitlement endpoint, and §5.6.1 states the un-verify rule.

### 5.2 Entitlement vs seat-revoke vs ban — three orthogonal actions

There are four distinct "take it away" actions. An admin clicking the wrong one expecting a different effect is a foreseeable incident. The admin UI copy must make this table true on screen:

| Action | Endpoint | Scope | Effect | Touches `vendors.verified`? |
|---|---|---|---|---|
| **Ban a seat** | `PATCH /api/admin/reviewers/:id` | one `profiles` row | that seat 403s on every `/api/vendor/*` call; other seats unaffected. The ban of the last unbanned seat is refused with `409 VENDOR_LAST_SEAT_USE_SUSPEND` and writes nothing (AECI-1623, ruled 2026-11-05). Ending a vendor is the next two rows | **No** |
| **Suspend a vendor** (AECI-1623, ruled 2026-11-05) | `POST /api/admin/vendors/:id/suspend` (`rateLimit('write')`) | every seat of the vendor | every seat 403s `VENDOR_SUSPENDED` on every `/api/vendor/*` route, reads included, except `POST /api/vendor/billing/portal`. A written notice names the rule and the evidence and starts a window of 7 business days at its first confirmed send. Billing, subscriptions, records and the listing are untouched, and nothing is purged. `POST .../suspension/lift` undoes it | **No** |
| **Revoke a seat** | `DELETE /api/vendor/seats/:userId` (AECI-664; owner-only, **not** capability-gated) — or `DELETE /api/admin/vendors/:id/seats/:userId` (AECI-652 §5.6, admin-side; **requires a body `{ reason }` since AECI-1191**, with an optional `internalNote` and a vendor-visible reason since AECI-1159; the portal revoke takes none) | one `profiles` row; the vendor's open owner contests too when it is the **last** seat (AECI-989, the seat lapse) | drops the seat to `reviewer`, unlinks `vendor_id`, clears `seat_owner`. The last seat moves open owner contests to AECi, stamped. **Since AECI-1415 (2026-10-19) it hands no record back:** ownership is stored (`vendors.owned_at`) and only the admin "Return records to AECi" action clears it (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9) | **No** |
| **Terminate a suspended vendor** ("ban a vendor", ruled 2026-10-14 AECI-1374, rewritten 2026-11-03 AECI-1589, moved here by AECI-1623 on 2026-11-05) | `POST /api/admin/vendors/:id/suspension/terminate` (`rateLimit('write')`), refused until the applicable window has elapsed | every live subscription on the vendor's billing accounts, any source; the vendor's records; its pending invites | every unbanned seat is banned (the seat ban above, `vendor_admin.banned` each), plus, in the same `db.batch`: every live subscription ends now (`ended_at`, `end_reason = 'banned'`, one `license.banned` audit row each, `ends_at` kept as the paid term end; a monthly Stripe row takes Stripe's `current_period_end` read before the batch, or stays NULL when Stripe cannot be read, `metadata.paid_term_end_source` is `ends_at`, `stripe` or `unknown`); the records return to AECi as ADR 0042's return does, although the banned seat remains (`vendors.owned_at = NULL`, markers back to `aeci`, integrations and pairs un-claimed, every open owner contest to AECi unstamped, open product proposals deleted, one `vendor.records_returned` row with `metadata.cause = 'vendor-banned'`); every pending seat invite is revoked (one `vendor_seat.invite_revoked` row each, `metadata.reason = 'vendor-banned'`). The seat lapse (`planOwnerSeatLapse`) is not planned on this path, because the return re-routes the same contests. After commit: one cache purge for the products that dropped to Free and the records-return tags, in its own `waitUntil` first; then every Stripe subscription Stripe can still bill on the vendor's Stripe customer is cancelled now with no proration, live subscription or not, and the customer's open Checkout sessions are expired (`stripeBanCancelNowHook`, §7.6 point 2, 15 s overall deadline); the ownership message to the review app (`records_returned`); the refunds, one `POST /v1/refunds` per payment under the key `aeci-termination-refund-{row id}`; and one `vendor-terminated` email to every seat, banned ones included, and the billing email, carrying the itemized statement. No `managed-ended` is sent. The Stripe payments are read before the batch, and Stripe unreadable refuses Terminate with `503 VENDOR_TERMINATION_STRIPE_UNAVAILABLE`. A grant that commits between the read and the batch aborts it (`noLiveLicenseSentinel`): nothing is written and the route answers `409 VENDOR_SEATS_CHANGED`. The unban lifts the seat ban and re-stamps `owned_at` when the ban cleared it (`ownership_stamped` on the unban's audit row, ownership message `seat_provisioned`). It restores no invite and grants no subscription. Contests the ban moved stay with AECi. The operator grants complimentary subscriptions for the rest of the ban term from the vendor's Billing section (`POST /api/admin/vendors/:id/licenses/ban-term`, `API_CONTRACTS.md`, `ADMIN_PANEL_SPEC.md` §5.7). The generic grant (`POST /api/admin/vendors/:id/licenses`) refuses a vendor whose every seat is banned with `409 VENDOR_STILL_BANNED` (ruled 2026-11-03), so the unban comes first. The unban and any new unbanned seat still clear legacy `vendor-banned` flags written before AECI-1589. A seat **revoke**, last seat included, writes nothing in billing (`VENDOR_SIGNUP_PROCESS.md` decision 15) and leaves the vendor not ban-dead | **Yes**: every subscription ends, so `vendors.verified` drops in the same batch (the end path's mirror reconcile) |
| **Revoke a subscription** (AECI-1371, E4.2) | `PATCH /api/admin/licenses/:id` `{ action: 'revoke', reason, internalNote? }` | one subscription | ends the subscription now (`ended_at`, `end_reason = 'revoked'`). It keeps its product as history (decision 14), and the product drops to Free because no live subscription holds it. Its Managed text stays live; the vendor loses the edit right. The vendor's seats read the reason in Messages. When the subscription was on a product they also get the `managed-ended` email, and the product and vendor pages are purged. **Seats, logins and dashboard survive.** It is not a seat revoke and not a ban. Nothing refunded. *Until AECI-1663 (ruling 14, 2026-11-09), when it ended the vendor's last live subscription, the same batch re-routed the vendor's open owner-routed contests on connector-powered rows to AECi. It moves no contest now.* | **Only when it ends the vendor's last live subscription** (the mirror reconcile) |

**The termination refund (AECI-1623, rulings 2 and 3 of 2026-11-05; `lib/vendor-termination-refund.ts`, integer cents).** Refund = paid x unused days / term days, minus cost, floored at zero. Paid is the invoice's `amount_paid` less anything already refunded. Days are whole UTC days. The period used ends on the suspension date, so a period that starts on or after it is fully unused and a renewal charged inside the window comes back in full before cost. Several lines on one invoice are weighted by amount, so tax, a coupon and a mid-term addition stay proportional. Cost is the non-voided cost log: staff minutes x 250 cents, plus third-party amounts, less recoveries. It is capped at the pre-cost refund and taken from the largest payment first, so no refund and no statement line goes negative. The deduction is never used to keep prepaid fees for the unused term. An invoice-paid subscription has no Stripe payment, so the operator types the amount paid and its refund row is `manual`. A complimentary subscription refunds nothing. Stripe Tax adjusts tax liability on a plain refund by itself (https://docs.stripe.com/tax/invoicing/refunds), so no credit note is made.

The subscription revoke carries its copy invariant. The revoke confirm on the Billing tab (`license-row-actions` and `license-bulk-actions`) says seats and logins stay and that this is not a seat revoke or a ban. Both component specs assert that sentence.

**A pure connector vendor has no path of its own.** Its claim is approved like any other and lands on Free (§13.6, `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2). Its seat holds no subscription unless one is granted. Connector vendors and subscriptions are parked (`VENDOR_SIGNUP_PROCESS.md` §2, AECI-1343).

**Ending the last live subscription does not revoke seats** (`VENDOR_SIGNUP_PROCESS.md` decisions 14 and 15). This is consistent with `STAGE_2_SPEC.md` §8.3(2): un-verifying a vendor is a separate action, not a ban. It is also what makes the §4 gate's behaviour concrete and testable. Managed writes 403, reads work, and the dashboard shows the ended banner (§13.11).

### 5.3 Cache purge, Algolia freshness, and copy

Each subscription write purges what it changed, post-commit, through the shared `lib/vendor-cache-tags.ts` (§2.5). The vendor tag set (`vendorPurgeTags`) is `vendor:{slug}` + every owned `product:{slug}` + `index:products`.

- **Grant.** Purges the vendor tag set only when the batch flips `vendors.verified`. Unassigned subscriptions change no product's plan, but the pair-page version-diff gate reads the mirror.
- **Revoke.** When the subscription was on a product, purges `product:{slug}`, `index:products` and the vendor tag set. An unassigned revoke purges the vendor tag set only on a mirror flip.
- **Assign** (the owner's Billing tab). Purges `product:{slug}`, `index:products` and `vendor:{slug}`, because the product's plan changes on public pages. The release-at-renewal flag purges nothing.
- **Extend and re-reference.** Purge nothing. No plan changes.
- **Lapse.** One purge per run (§7.6 point 7).

The `product:` tags matter because pair pages carry both endpoints' `product:` tags and the version-diff gate reads the mirror. The claim CTA no longer reads the mirror (AECI-1266), so no claim copy can go stale.

**Search needs no sync.** The Algolia vendor record carries neither `verified` nor a plan (AECI-1266). Admin UI copy must not promise a change in search.

### 5.4 Known consequence: the lapsed-and-claimed edit lockout

`loadOwnedVendorIds` (`apps/api/src/lib/claimed-vendors.ts`) defines "owned" as `vendors.owned_at` set. It is deliberately not `verified`, and since AECI-1415 it is not seat presence either. `POST /api/promote` refuses to write an owned vendor. Ending the vendor's last live subscription, by an admin revoke or by the term-end lapse (§7.6), leaves the seats and the ownership. The promote block stays in force while the portal's Managed writes 403. **Result: nobody can edit that vendor's Managed fields, and the text stays live as the vendor left it** (decision 14). A new subscription gives the edit right back.

This is the same shape as the banned-seat lockout AECI-520 solved by not counting banned seats as claimed. AECI-1415 removed that answer: seat loss no longer returns a record to promote. A frozen owned record is corrected by an AECi field override (ADR 0039, which reads `owned_at`), by hand through `apps/datatool`, or by the admin "Return records to AECi" action. AECI-955 supplies a logo-only admin fallback (`STAGE_2_5_SPEC.md` §11). There is no general admin vendor-edit endpoint. The Managed-only promote opening (AECI-1407) was removed on 2026-10-19 (AECI-1414). The **accepted** mitigation is a subscription grant the vendor assigns to the product, then the edit, then a revoke. **It is recorded here as a known consequence with the escape hatch named.** Closing it properly, by exempting lapsed-but-seated vendors from the promote block or adding an admin vendor-edit endpoint, is §11.

### 5.5 As built (AECI-532 — 2026-08-19)

Retired 2026-10-17 (AECI-1375). The set / renew / clear handler, its `admin-entitlements` contracts and its tests are deleted, and the subscription routes in §5.6.1 replace them.

### 5.6 The `/admin/vendors` surface (AECI-652)

**This section reverses §11's deferral of "a standalone `/admin/vendors` entitlement browser."** The deferral rested on an assumption that proved false: that every vendor an operator needs to act on has a claim row to act through. Three consequences made that untenable:

1. **A vendor that never filed a claim was unreachable.** There was no row to hang a control on, so an operator could not view the vendor or grant it subscriptions. That is the concierge-onboarding case, where AECi approaches the vendor rather than the reverse.
2. **Seats were visible only incidentally**, as the "existing seats" reviewer signal on a claim card for that same vendor.
3. **`audit_log` had no read surface at all.** It is written in the same atomic `db.batch` as every domain-state write and is hard-excluded from the retention prune, but nothing read it as a viewer, and `audit_log_entity_idx` had no reader.

**No schema change, no migration.** Every read is served by an index that already exists: `audit_log_entity_idx`, `audit_log_action_idx`, `audit_log_actor_idx`, `vendor_requests_target_idx`, `profiles_vendor_idx`, `product_vendors_vendor_idx`. The Billing tab reads `billing_accounts` and `licenses` (`DATABASE_SCHEMA.md` §8.6b, §8.6c).

#### 5.6.1 Endpoints

Ten (originally four in AECI-652; `POST /api/admin/vendors/:id/seats` added by AECI-740, `GET /api/admin/vendors/:id/products` by §5.9, `POST /api/admin/vendors/:id/licenses` by AECI-1370, `GET /api/admin/vendors/:id/billing` by AECI-1372, `PATCH /api/admin/licenses/:id` by AECI-1371, `PATCH /api/admin/license-grants/:id` by AECI-1615), all on the existing `authAdmin` sub-router behind `requireAdmin()` (`apps/api/src/routes/admin-vendors.ts`; contracts in `packages/shared/src/api/admin-vendors.ts`; wire shapes in `API_CONTRACTS.md` §6.10):

| Endpoint | What |
|---|---|
| `GET /api/admin/vendors` | Paginated list + name/slug search + a **sort key per rendered column** (`AdminVendorSortSchema`, admin-only, see the list rendering note below). One round trip: a plain `db.select()` plus a `count()`, in one `db.batch`. Each row carries `live_license_count`, a correlated count of the vendor's subscriptions with `ended_at IS NULL` across its billing accounts (`liveLicenseCountSql()`, `lib/license.ts`). The per-row product count reuses `vendorListConfig.extras.productCount`, the same correlated subquery the public list ships. |
| `GET /api/admin/vendors/:id` | Basics, the seat roster + pending invites, and product / integration / claim counts. The claim counts report all four statuses (`open`, `in_review`, `resolved`, `rejected`), so the numbers sum. Two D1 round trips: a 404 gate, then **one `db.batch` of six reads**, a batch for the round trip and not for atomicity, the same use `GET /api/vendor/updates` documents. Deliberately **not** a `UNION`: D1 caps compound selects at five, which the admin System screen already got bitten by. |
| `GET /api/admin/vendors/:id/products` | The vendor's product roster behind the detail page's Products tab (§5.9). Paginated, name-ordered, joins EVERY `product_vendors` row. Added after AECI-652; contract in `API_CONTRACTS.md` §6.10. |
| `GET /api/admin/vendors/:id/billing` | The Billing tab's read (AECI-1372, E4.3; §5.9). In `routes/admin-vendors-billing.ts`. One `db.batch`: the vendor (404 gate), the billing account, its owner seats, every subscription with its assigned product, the agreement acceptances. `billing_account: null` is a 200: an E1 back-fill defect, shown as such. No audit row, no limiter. |
| `GET /api/admin/vendors/:id/audit` | The `audit_log` viewer. `?scope=all\|entity\|actor`, default `all`, newest first. See §5.6.2 — the query is the interesting part. |
| `DELETE /api/admin/vendors/:id/seats/:userId` | Revoke one seat, AECi-side. Requires a JSON body `{ reason, internalNote? }` (AECI-1191, AECI-1159). |
| `POST /api/admin/vendors/:id/seats` | Provision one catalogue-maintenance seat (AECI-740). One `db.batch`: the seat, the vendor's billing account when it has none, and `vendors.owned_at` (`stampOwnershipStatement`, AECI-1415). It grants no subscription. The seat statements themselves never name `vendors`. |
| `POST /api/admin/vendors/:id/licenses` | Grant N unassigned complimentary or invoice subscriptions on the billing account (AECI-1370, E4.1; `VENDOR_SIGNUP_PROCESS.md` §3 step 5). In `routes/admin-licenses.ts`. Assigns nothing. Idempotent on `grant_id`. A vendor whose every seat is banned gets `409 VENDOR_STILL_BANNED` (AECI-1589). *Since AECI-1615 it writes a pending `license_grants` row and no subscription. `grantLicensesStatements` and the `vendors.verified` reconcile run at activation: the owner's accept, or a `signed_deal` in this request.* Contract in `API_CONTRACTS.md` §6.10. |
| `PATCH /api/admin/license-grants/:id` | Withdraw a pending grant, with a reason (AECI-1615). One guarded UPDATE and `license_grant.withdrawn`. No email, no purge. Contract in `API_CONTRACTS.md` §6.10. |
| `PATCH /api/admin/licenses/:id` | Extend, re-reference or revoke one subscription (AECI-1371, E4.2; `VENDOR_SIGNUP_PROCESS.md` §3 step 11). In `routes/admin-licenses.ts`, through `setLicensesTermStatements` and `endLicensesStatements`. A revoke keeps the product as history and the product drops to Free (§5.2). Contract in `API_CONTRACTS.md` §6.10. |

**The subscription end path is the sole writer that can take `vendors.verified` back down.** `reconcileVerifiedMirror` (`apps/api/src/lib/license.ts`) ends every subscription batch and turns the mirror off when no live subscription is left. Two builders end a subscription: `endLicensesStatements` (the admin revoke) and `lapseTermStatements` (the 11:00 lapse, §7.6). Both write through one private end writer and end with the reconcile. The Stripe sync ends subscriptions the same way (§7.6 point 2). The 45-day warning sweep only warns (§7.3). **No new writer of `vendors.verified` exists anywhere.** The seat revoke and seat provision compose `revokeSeatStatements` / `provisionSeatStatements` (`lib/vendor-grant.ts`), which an ESLint rule and generated-SQL assertions prove never name `vendors` at all.

**The four GETs emit no `audit_log` row.** Reads write nothing (`ADMIN_PANEL_SPEC.md` §9.3, `API_CONTRACTS.md` §6.10 conventions). ADR 0022 scopes the §26.1 invariant, but it is a write-side document — cite those two as the direct authority.

> **List rendering.** Four properties of `/admin/vendors`, one of which is an API change:
>
> 1. **The Integrations column is gone**, and with it `integration_count` on `AdminVendorRowSchema`. An operator on this screen triages subscriptions and seats. The integration count is a catalog fact they act on at `/admin/vendors/:id`, where the §13.5 union of direct and connector-evidenced edges is the number that matters. `vendorListConfig.extras.integrationCount` is untouched. The public list and the Algolia record still ship it, and `count-lockstep.spec.ts` pins the union rule on the config rather than on any one reader.
> 2. **The slug is its own column** rather than a second line under the company name. It is the identifier an operator carries between this screen, a URL and a support thread, so it is scannable and sortable. Lifting it out also makes every row one line tall.
> 3. **Every column is sortable**, via the admin-only `AdminVendorSortSchema` (`name | slug | verified | licenses | products | updated`, default `name`) and `resolveAdminVendorOrderBy`. A header that reorders only the rows already loaded presents a chunk as a ranking, which is why this took an API change. Direction is a toggle: `order` is optional and absent means the key's natural direction (§5.10). `licenses` orders by the live subscription count, most first. `products` orders by the `product_count` SELECT alias. The public `VendorSortSchema` is deliberately untouched. `created` is absent here because `created_at` is not on the row for a header to point at.
> 4. **Paging is scroll-append, not prev/next.** The screen renders the shared `<aec-pagination-footer>`, the same `IntersectionObserver` sentinel + "Load more" floor the public listings use, instead of `<aec-admin-paginator>`. `GET /api/admin/vendors` is still page-based, and `total` is still the `count()` over the filter, which is what the footer's "Showing X of N" reports. Two client-side invariants make it safe. A filter, search or sort change **discards the accumulation** before refetching chunk 1, because appending across a reordered set duplicates rows. A failed append keeps the loaded rows, steps the cursor back and retries the chunk that failed. The footer renders a real `<button>` here rather than its usual anchor, because an admin screen has no SSR'd `?page=2` to link to and an `<a>` with no `href` is not focusable.

#### 5.6.2 The audit query: why `entity_id = <vendor>` is not enough

The obvious filter misses more than it catches, and the gaps are silent. Entity scope is therefore **four OR'd disjuncts**, each index-usable, each load-bearing:

1. `entity_type IN ('vendor','vendor_entitlement') AND entity_id = :vendorId` → `audit_log_entity_idx`. Serves `vendor.created/.updated`, `promote.blocked`, and the legacy `vendor_entitlement.*` ledger. Nothing writes those rows since AECI-1375, so this leg reads them for history only. They are reachable because §2.1 made their `entity_id` the **vendor** id rather than the entitlement row id. `licenses` rows file under `entity_type = 'billing_account'` and are reached through leg 3, because they carry `vendor_id`.
2. `entity_type = 'vendor_request' AND entity_id IN (SELECT id FROM vendor_requests WHERE <vendorRequestsWhere>)`. **Required**, because `rejectClaimStatements` builds its metadata with `claimMetadata(p, {})`, which emits no `vendor_id` — and `RejectClaimParams` does not even carry one. Widening that writer would fix only rows written after the deploy; the subquery is retroactive, and reusing `vendorRequestsWhere` gets the vendor-arm / product-arm split right (a product claim's `target_id` is a **product** id).
3. **Since AECI-1192:** `(vendor_id = :vendorId AND action <> 'notification.sent') OR (action IN (<claim + seat lifecycle actions>) AND json_extract(metadata,'$.vendor_id') = :vendorId)`. The first half reads the indexed `audit_log.vendor_id` column (`audit_log_vendor_idx`), which every new row about a vendor carries on any action (`DATABASE_SCHEMA.md` §8.4). The Messages ledger is left out. The second half is the legacy fallback for rows written before migration 0063, which are never backfilled (ruling 2026-10-04); its action filter stays so the JSON probe does not walk the whole table. Before AECI-1192 this leg was the JSON half alone, `audit_log_action_idx` with the JSON test as a filter. Also required: it is the **only** path that reaches `vendor_claim.seat_revoked` and `vendor_seat.provisioned`, which file under `entity_type='profile'` with the seat's user id — and by the time anyone reads it the revoke has nulled that profile's `vendor_id`, so the actor scope misses it too. That is precisely the row an operator asking "why did this vendor lose access?" wants.
   **Seat exclusion (AECI-1192 review).** Both halves then require `actor_id IS NULL OR actor_id NOT IN (SELECT id FROM profiles WHERE <seatsOf>)`. `vendorAuditEntry` stamps the *acting* vendor on every seat write, so without it entity scope ("done to this vendor") would list the vendor's own product edits. A row a current seat wrote belongs to the actor scope, and `all` still shows it. The exclusion is a residual filter: the vendor or action index still drives the scan, and the uncorrelated subquery is the same one the actor scope uses. A seat that has since left the vendor no longer matches `seatsOf`, so its older rows return to entity scope. A NULL actor (system, cron, promote) is kept explicitly, because `NULL NOT IN (…)` is NULL.
4. `action IN ('vendor_admin.banned','vendor_admin.unbanned') AND entity_id IN (SELECT id FROM profiles WHERE <seatsOf>)`. **Matters only for rows written before AECI-1192.** Since then `admin-reviewers.ts` stamps the seat's vendor in the `vendor_id` column on a `vendor_admin` ban or unban, so new rows arrive via leg 3. The actor is the admin, never a seat, so the seat exclusion does not drop them. Older ban/unban rows file under `entity_type='profile'` with the seat's user id and carry **no** vendor at all: no column, and metadata of `{ source, reason? }`. None of legs 1–3 reach them, yet the roster shows ban state, so the audit tab has to explain it. A ban does not null `vendor_id`, so the seat is still in `seatsOf`. Those rows are never rewritten, so this leg stays. A seat banned and *then* revoked drops out of this leg (the revoke nulls `vendor_id`), but its `vendor_claim.seat_revoked` row stays reachable via leg 3, so "lost access" is never lost.

Actor scope is one statement with a **subquery**, not a resolved id list: `inArray(auditLog.actorId, db.select(...).from(profiles).where(seatsOf(vendorId)))`. `ID_CHUNK` / `SEAT_LOOKUP_CHUNK` exist elsewhere because D1 caps **bound parameters** per query, not statements — so an id set SQL can derive belongs in SQL. As a subquery there is no cap to hit, no chunking (which would break a single `ORDER BY … LIMIT/OFFSET` anyway), and no extra round trip. Both partial indexes still apply; SQLite proves `actor_id IS NOT NULL` from the `IN`.

Ordering is `created_at DESC, id DESC`. The tiebreak is not decoration: `created_at` is an ISO string stamped in JS, two rows from one `db.batch` routinely share a millisecond, and without a second key a page boundary is unstable.

**The viewer renders tolerantly.** `before_state` / `after_state` are free-form JSON written by ~34 call sites across the life of the schema, with no shared contract, in a table nothing prunes — so today's reader is parsing rows written by code that no longer exists. The wire types are `z.unknown().nullable()` (which in Zod 4 still rejects a *missing* key, satisfying R10) and `action` / `entity_type` are plain strings. An enum would turn a new writer elsewhere into a 500 on this screen.

#### 5.6.3 Seats: add and revoke, but never ban

> **Retitled by AECI-740 (2026-09-03).** This subsection read "revoke, but never ban" because
> revoke was the only seat verb the console had. It now has two: **`POST /api/admin/vendors/:id/seats`**
> adds one. The ban boundary below is unchanged in every respect.

The roster lists every seat via the shared `seatsOf` predicate (moved to `routes/vendor-shared.ts` so the dashboard count, the portal roster and this page can never disagree), **including banned ones** — a ban is a per-seat lock, not a removal, and hiding it leaves nobody able to see why a colleague cannot sign in.

The page can **revoke** a seat and deliberately **cannot ban** a person; each row deep-links to `/admin/reviewers`, which owns that policy (AECI-524). The two have different blast radii — a revoke un-grants one vendor's access, a ban locks the human out of AECi entirely — and peer buttons would invite the wrong one.

The admin revoke is a near-clone of the portal's owner-only `DELETE /api/vendor/seats/:userId` with four differences: `vendorId` comes from the path (and scopes the target read), there is no self-removal guard (an admin holds no seat), **the last-owner guard is not carried over**, and since AECI-1191 it **requires a reason** (see below). That guard's stated rationale is that a vendor cannot self-rescue from an unadministrable account and "only an AECi grant can rescue it" — the admin *is* that rescue, so keeping it would block only the operator who exists to undo it.

**The admin revoke requires a reason (AECI-1191).** The body is a strict `{ reason }` (`AdminReasonSchema`, trimmed, 1 to 1000 characters). A missing body, missing reason or blank reason is `400` and nothing is written. The reason lands in the `vendor_claim.seat_revoked` row's `metadata.reason`, in the same batch. Since AECI-1159 (2026-10-04) the body also takes an optional `internalNote`, the audit row carries `metadata.reasonVisibility = 'vendor'`, and the vendor's remaining seats are told the reason in Messages on every plan. No seat remaining means no notice (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11d). The portal's owner-only revoke takes no body and no reason.

**The page can also ADD a seat, and that is the only place in the product that can (AECI-740).** `POST /api/admin/vendors/:id/seats` is the **only route that writes `profiles.role = 'vendor_admin'` on its own**. The claim grant and the invite redeem write it too, but only behind a claim or an owner's invite. The batch writes the seat, creates the vendor's billing account when it has none, and stamps `vendors.owned_at` (AECI-1415, ADR 0042). It grants no subscription, so it never moves `vendors.verified`. It exists because `STAGE_2_SPEC.md` §8.9(1) gives a pure **connector** vendor a catalogue-maintenance seat without selling it Managed. Every claim approval since AECI-1367 (2026-10-15) also writes the seat alone, so the old advice to park a connector claim is retired (§13.6).

Three consequences for this section specifically:

- **Adding a seat and granting a subscription stay separate controls on one page, deliberately.** They are the two halves the old claim grant fused, and fusing them was the problem. The provision control says so in its own copy: *"opens no entitlement and carries no attestation rights."*
- **It lives here** rather than on `/admin/claims/:id` or `/admin/users/:id`, for the reason the revoke does. This is the only screen showing the blast radius that makes the decision safe: the other seats, the subscription state and `is_pure_connector_vendor`. `ADMIN_PANEL_SPEC.md` §5.8's "this screen cannot edit the role" is unchanged and now points here.
- **It warns and never gates** on a vendor owning endpoint products (the AECI-738 rule), or, since AECI-1041, on a vendor that owns integrations (an owner under `STAGE_2_SPEC.md` §8.10; ownership no longer implies payment — ruling 14, AECI-1663). It does **not** become a second writer of `banned_at`. A banned account is provisioned and flagged, not refused. Ban policy is `PATCH /api/admin/reviewers/:id`'s.

Full contract in `API_CONTRACTS.md` §6.10; as-built in `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.3.

**Emails are a tri-state, and that is the whole point.** `seat_emails_available: false` means the GoTrue seam was unreachable, so a blank email says nothing about the account; `true` with a blank means the account genuinely has none. On 2026-08-24 the claim queue read "Account status unknown" for every row because `SUPABASE_SERVICE_ROLE_KEY` was absent and then carried a bad value, and the seam discarded both the HTTP status and the error text — so there was nothing to debug from. AECI-652 fixed that at the source: `fetchAuthUserEmailsResult` reports `{ available, emails, reason }`, `fetchAuthUserEmails` stays a byte-identical wrapper (four structural type aliases take it as an injection default), and every swallow point now `console.warn`s its reason. **Absent creds must render "unavailable", never an empty seat list.**

#### 5.6.4 What this section does NOT do

- **It does not close the §5.4 lockout.** AECI-955 later adds a logo-only admin exception. Other fields of a lapsed-but-still-seated vendor remain uneditable, and §5.4's escape hatch is still the answer (`apps/datatool`, or a grant the vendor assigns, then revoke, since AECI-1375). §11 keeps that bullet.
- **It adds no live updates.** `STAGE_2_REALTIME_SPEC.md` §8 excludes `/admin` from revalidation, and `ADMIN_PANEL_SPEC.md` §5 makes manual refresh a deliberate decision, not a placeholder.
- **It is not a global audit browser.** The viewer here is vendor-scoped. The general `/admin/audit` shipped as its own issue, AECI-653 (`ADMIN_PANEL_SPEC.md` §5.18). It links in from this tab, and its vendor filter is a subset of this tab's four scopes.
- **The seat action does not resolve a claim** (AECI-740). Provisioning writes no `vendor_requests` row and moves no workflow: a parked connector claim stayed `open` (parking is retired since AECI-1367, 2026-10-15, and a connector claim is now approved like any other), because `resolved` would read as approved in the Resolved tab with a paid account behind it, and none was opened. The handover is recorded in the claim's operator note (`STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 step 6).
- **It still cannot ban, and adding a seat is not verifying a vendor.** Both boundaries are asserted in `vendor-detail.component.spec.ts` now that this section carries two write actions rather than one.

### 5.7 As built (AECI-652 — 2026-08-27)

Retired 2026-10-28 (AECI-1518). The AECI-652 build decisions that still hold are in §5.6 and §5.8, and the entitlement control, `AdminEntitlementApi` and the claim card readout it describes are deleted (AECI-1375). Its reader rules (share `seatsOf()`, escape searches with `likeContains`) live in `API_CONTRACTS.md`.

### 5.8 Rendering revision (AECI-694 — 2026-08-28)

**Presentation only. No endpoint, query parameter, response shape or audit behaviour moved**, and every §5.6 invariant above still holds: the seat timestamp is still labelled "Account created", the diff still walks the union of both snapshots and still states its changes in words, and the seats tri-state (`null` = seam unavailable, `[]` = genuinely none, `seat_emails_available: false` = addresses only) is preserved cell for cell.

- **All four sections are tables.** The list, the seat roster, the pending invites and the audit trail. Every field on this surface is short and every row has the same fields, which is the case a table is for. The card list made an operator read a paragraph per row to compare subscription state across a page. The markup follows the console's existing pattern (`admin/system/system-status.html`): `overflow-x-auto` wrapper, `min-w-[…]` table, visually-hidden `<caption>`, `th[scope=col]` in the head and `th[scope=row]` on each row's identity cell, `text-end tabular-nums` on counts, and an en-dash with an `aria-label` for a genuinely absent value.
- **The two-step seat revoke is a full-width `<tr colspan>` directly under its row**, so the confirm stays adjacent to the seat it acts on in both the visual and the accessibility tree. `revokeConfirmId` and the page's single live region are unchanged.
- **Every column is sortable, with a direction toggle** (§5.6.1, §5.10). `aria-sort` reports the live direction.
- **The audit trail is now a shared `<aec-audit-trail>`** (`app/admin/audit/`), so the next trail the console wants is a drop-in. Fetching and the `?scope=` control stay on this page: scope here is four OR'd disjuncts over this vendor's rows, requests, metadata references and seat roster, and a user- or product-scoped trail would need a different one or none.
- **Actions read as English** via `describeAuditAction()`, with the raw token still shown beneath for grepping, and an unmapped action humanises rather than blanking (`action` is a free `z.string()` by contract so a new writer cannot 500 this screen, and `audit_log` is excluded from the retention prune). `metadata` is not on the wire, so a description can only use `action`, `entity_type` and the two snapshots.
- **Audit timestamps are relative** ("4h", "2d") with an info control whose accessible name is the full `medium`/UTC instant; every other timestamp on the page is absolute `medium`/UTC, including several that rendered as raw ISO strings before this change (`updated_at`, `seat.created_at` and `invite.expires_at`).
- **A term end is formatted as a CALENDAR DATE, not an instant, and that distinction is load-bearing.** The admin grant form writes a date-only end because it is an `<input type="date">`, and the wire type accepts a date-only value or a full timestamp. A bare `2027-09-01` handed to `DatePipe` with a `'UTC'` timezone is parsed as **local** midnight and then shifted, so west of UTC it renders as 31 August. A term ending on the 1st would display as the 31st, which is a paperwork question nobody wants to have. `formatTermDate` (`apps/web/src/app/shared/term-date/format-term-date.ts`) pins the date-only case to UTC midnight first and formats a real instant in UTC as-is. It is shared by every place a term date is shown: the admin and vendor Billing tabs, the subscription actions and the early-unassign queue. The regression case lives in `format-term-date.component.spec.ts`.
- **"View public page" is now "View Page" and opens in a new tab.** An operator opens it to check something against the admin record, so navigating away from that record was the wrong outcome.

`docs/ADMIN_PANEL_SPEC.md` §5.0a records the companion change to the console shell: the nav became a horizontal row of category dropdowns, which is what freed the width these tables use.

---

### 5.9 The detail page becomes a tabbed menu (three tabs, now five)

**Presentation plus one new read endpoint. Nothing in §5.6 or §5.8 is retracted.** The seat timestamp still reads "Account created", the seats tri-state is preserved, and no write path changed.

`/admin/vendors/:id` gains a horizontal menu over one panel. It shipped with three tabs.
Since AECI-1046 and AECI-1372 it has five, in this order: **Vendor** / **Billing** /
**Products** / **Integrations** / **Audit Trail**.

- **Vendor** keeps basics + counts and the seat roster. A one-line pointer sends the operator to `?tab=billing`, where the grant control and the subscription actions live.
- **Products** is new, and reads `GET /api/admin/vendors/:id/products` (§5.6.1) —
  paginated, name-ordered, every `product_vendors` row with `is_primary` on the row.
  Read-only except for AECI-955 logo editing (STAGE_2_5_SPEC.md §11): there is no general admin product-edit endpoint, and §5.6.4's catalog lockout is
  unchanged by this.
- **Audit Trail** is the §5.8 `<aec-audit-trail>` and its scope control, moved intact.
- **Billing** (AECI-1372, E4.3; `?tab=billing`) reads `GET /api/admin/vendors/:id/billing`
  lazily on first open. It shows the billing account and its owner seats, every subscription
  (live first, then ended; dates through `formatTermDate`, §5.8), the agreement
  acceptances and the early-unassign requests (AECI-1373; decided on `/admin/requests`,
  `ADMIN_PANEL_SPEC.md` §5.17). A subscription a termination ended reads "ended by the vendor's ban" (`end_reason = 'banned'`, AECI-1589, written by Terminate since AECI-1623), and its end date is the paid term end, or blank when Stripe could not be read. After an unban the tab also shows the "Grant complimentary subscriptions for the ban term" control (`ADMIN_PANEL_SPEC.md` §5.7). A live subscription flagged
  `cancel_at_term_end` with `cancel_reason = 'vendor-banned'` is a row a ban flagged before AECI-1589. No ban writes that flag now, and it still reads "Cancels at term end: vendor banned" until the unban or a new unbanned seat clears it. The E4.1 grant control lives here. `/admin/claims` "Manage billing" links open this tab. Each live `licenses` row carries the AECI-1371 actions: Extend, Change reference (invoice only) and Revoke (`ADMIN_PANEL_SPEC.md` §5.7). Read-only otherwise: nothing on it changes ranking or reviews.
- **Integrations** (AECI-1046) is described in `ADMIN_PANEL_SPEC.md` §5.7.

Three decisions worth recording:

- **`?tab=`, not child routes.** A route per tab buys two lazy components and two
  resolvers and carries nothing but a signal; a query parameter keeps the tab linkable,
  bookmarkable and Back-navigable, which an in-page toggle silently gives up. The default
  tab is the ABSENT value, so the bare URL stays canonical and an unrecognised `?tab=`
  falls back to Vendor rather than rendering an empty panel.
- **Links and a `nav`, not an ARIA `tablist`.** These navigate the URL rather than swap
  panels in place, and a `tablist` would promise arrow-key semantics the router does not
  implement. The open tab carries `aria-current="page"`.
- **Products fetches lazily; the audit trail does not.** The trail is refetched after every write on this screen (a seat revoke, a seat provision), so the page holds it regardless of which tab is open. Products has no such coupling, which is also why it is a separate endpoint rather than a field on the detail payload. The seat read must cost the same for a vendor with sixty products as for one with two.


### 5.10 Sort direction becomes a toggle

The list shipped with direction **fixed per key** and no `order` parameter: the header
arrow was a statement of how a column sorts, and clicking the already-active header was
a deliberate no-op (§5.8, and `sort-header.ts` argued it at length). That was a
reasonable call over a two-key API. It stopped being one at seven keys (six since
AECI-1375) — an arrow on a
clickable header reads as a toggle to every operator who has used one, so a control that
silently does nothing on the second click is a worse lie than the one the rule was
trying to avoid.

`?order=asc|desc` is now on `GET /api/admin/vendors` and `GET /api/admin/users`.

- **Optional, and absent means the key's natural direction.** Not defaulted to `asc`: a
  default erases the difference between "the caller wants ascending" and "the caller did
  not say", and half these keys are naturally descending. Every link, bookmark and test
  written before the parameter orders exactly as it did — asserted directly
  (`slugsSortedBy('name')` must equal `slugsSortedBy('name', 'asc')`).
- **The natural directions live in `packages/shared`, in one copy.**
  `ADMIN_VENDOR_SORT_DEFAULT_ORDER` / `ADMIN_USER_SORT_DEFAULT_ORDER`: the API resolves
  its ORDER BY from them, the table draws its arrows and its first-click direction from
  them. Two copies is the classic silent drift — a header renders ↑ over a descending
  list and nothing fails.
- **Only the primary term flips.** `id ASC` and the intermediate `company_name` term
  never move; they are what make the order total and the page stable (AECI-99), and
  reversing a tiebreaker is how a paginated list starts duplicating and skipping rows.
- **`licenses` counts live subscriptions**, so it has no NULL to guard. Only the primary term flips.
- **Switching columns resets** to the new column's natural direction.
- **`aria-sort` reports the live direction**, and the button gained an sr-only hint for
  what the next press will do: the arrow is `aria-hidden`, so without it the button's
  accessible name is identical before and after a flip.

`SortHeader` is shared with `/admin/users` (§5.8 of `ADMIN_PANEL_SPEC.md`), so both
screens gained the toggle together — a shared header that behaved differently per table
would be the worse outcome.

## 6. Claim-grant integration — the AECI-519 refactor (AECI-612)

A claim approval never moves `vendors.verified`. Every approval lands on Free (AECI-1367, §13.6). Its batch writes the seat, the billing account, the terms acceptances and `vendors.owned_at`, and no subscription. So the mirror reconcile has nothing to do.

What AECI-612 settled still holds:

1. **`grantSeatStatements` emits no statement that names `vendors`.** AECI-612 deleted its `db.update(vendors).set({ verified: true, updatedAt })`. Guard 1 covers `lib/vendor-grant.ts`, and `apps/api/src/lib/vendor-grant.spec.ts` asserts the rule against the generated SQL. So the sole-writer invariant (§2.1) cannot silently regress.
2. **The audit metadata stays.** The grant row still records `beforeState.vendor_verified` and `afterState.vendor_verified`, now always equal, and `verified_flipped: false`. So a grant row reads the same shape as the older ones beside it.
3. **The idempotent re-grant** (200, no batch, `outcome:noop`) returns before any batch is built.
4. **`ClaimGrantSummarySchema` carries a required `tier`** (R10), so `validateResponseInDev` catches a construction site that forgets it. Since AECI-1358 it is the vendor's live state, read from its subscriptions: `verified` when any is live.

From AECI-612 to AECI-1367, a Managed approval also composed the entitlement activate into the same batch. That composition, its `entitlement` body and its `entitlement_created` field are gone. `ClaimEntitlementSchema` was deleted by AECI-1333.

### 6.1 As built (AECI-612 — 2026-08-18)

Retired (AECI-1367, AECI-1358). The composed grant and its `vendor_entitlement.granted` audit row are gone, and §6 states what holds. The historical `vendor_entitlement.granted` rows still render in the audit viewer (§5.6.2). `vendor-grant.spec.ts` was created by AECI-612, see the correction under §10.

---

## 7. Term expiry — warn, then lapse (AECI-613, AECI-1404)

**The decision.** A subscription carries a term. The 11:00 job ends every passed non-Stripe term on its end date (§7.6). It then warns the vendor and AECi about terms still to come (§7.2), reminds owners about subscriptions still on no product (§7.7), and sweeps the grants still waiting for an owner's accept (§7.9). The warning batch only warns (§7.3). A wrong lapse is undone by an extend plus a re-assign (`docs/runbooks/subscriptions.md` "Pilot vendor terms: set, extend, end").

### 7.1 The cron

**`0 11 * * *` — 11:00 UTC**, one hour after the attestation sweep and the new last of the daily jobs. `ENTITLEMENT_EXPIRY_CRON`, `apps/api/src/lib/cron-schedules.ts`.

> **Corrected: this section originally specified 05:00 as "the only free slot among the seven", and both halves are now wrong.** The list it argued from has been overtaken twice — 05:00 went to the AECI-526 analytics digest and 10:00 to the AECI-302 attestation-notify sweep, both of which landed after this spec was written. The Worker now runs **fourteen** crons (the weekly `asn-registry` joined at the AECI-750 reconcile; the `*/20` IndexNow drain arrived with AECI-826), and the 04:00–10:00 band is fully occupied: 00:15 metrics snapshot, 03:00 retention prune, 04:00 data quality, 05:00 analytics digest, 06:00 moderation snapshot, 07:00 stats, 08:00 Algolia sync, 09:00 index drift, 10:00 attestation notify, plus `*/15` reconcile and hourly WAF. **11:00 continues the sequence rather than colliding with it, and satisfies what §7 actually required** — a daily slot in the dead-of-night window, scheduled after the batch that may have moved the rows it reads. The specific hour was never load-bearing; being last was.

The cron string **must stay byte-equal** to its constant, because `scheduled.ts` `switch`es on `controller.cron` and a mismatch silently stops dispatching the job (`cron-schedules.spec.ts` asserts all fourteen match `wrangler.jsonc`). `triggers` are declared on **staging, demo and production** — the base config carries none — so local dev never runs it. *(The `preview` block, and the PR previews that used it, were retired 2026-10-10, AECI-1268.)*

**Queue-less and inline**, following the 06:00 moderation-snapshot precedent (`queueForJob` returns `QUEUE_LESS`) rather than the ADR 0013 cron→queue→consumer path. The job is one indexed read (over `licenses_ends_idx` since AECI-1356, §7.5) plus a handful of emails; going queue-less avoids a new `aeci-entitlements-{env}` queue, two `wrangler.jsonc` blocks per tier, and a `wrangler queues create` step in `deploy.yml` / `promote-to-prod.yml`.

### 7.2 Templates, recipients, and the idempotency fence

Two `EmailTemplate` ids (the id doubles as the `template:` tag on `aeci.email.send`), added to the union in `apps/api/src/lib/email.ts` **and** the catalogue table in `docs/email.md`. Since AECI-1199 there is no hand-written union: an id is an entry in `apps/api/src/lib/notifications/registry.ts`, and `EmailTemplate` is derived from it. The catalogue is `docs/NOTIFICATIONS.md`, generated from the registry (AECI-1200).

| id | Recipient | Why both |
|---|---|---|
| `entitlement-expiring` | the vendor's seats and the billing email (since AECI-1406) | the renewal prompt: the 45-day notice of `VENDOR_SIGNUP_PROCESS.md` §3 step 8 |
| `entitlement-expiring-admin` | `ADMIN_ALERT_EMAIL` (since AECI-1220: `SUPPORT_EMAIL`) | seat email addresses need `fetchAuthUserEmails` and therefore `SUPABASE_SERVICE_ROLE_KEY` — present on staging/demo/prod since AECI-530, **absent locally**, so the vendor send degrades to `skipped`. The admin copy always lands. |

Copy follows the house pattern (two parallel paragraph arrays, `escapeHtml` on every HTML interpolation, the house layout through `houseBody()` (`docs/email.md` §House layout; the legacy `toText()` / `toHtml()` were deleted in AECI-1611), `sendTransactionalEmail` which never throws). Emails are deliberately not `$localize`d. Reuse the route-seam pattern (§1.3) so the job unit-tests without the email module.

**The 45-day notice (AECI-1406, E6.3 — 2026-10-19; 30 days until AECI-1596, 2026-11-04).** The vendor copy carries what `VENDOR_SIGNUP_PROCESS.md` §3 step 8 lists. It goes to every unbanned seat and the billing account's billing email, each address once, compared trimmed and case-insensitively (decision 16, `lib/billing-recipients.ts`). The billing email needs no service-role key, so it still lands where the seat read degrades. The copy:

1. Leads with the end date, never a day count (§7.3 ruling, point 5). The day count decides only the tense.
2. States the subscription count and names the products the term's subscriptions are on. An unassigned subscription counts but names no product.
3. States the list price: "Managed is $25 a month or $250 a year per product", built from `MANAGED_LIST_PRICE_CENTS` and `MANAGED_ANNUAL_PRICE_CENTS`. **Not for an invoice term (ruling B, Chris, 2026-10-19).** An invoice deal may carry a different price, so the line is left out when any subscription in the term has `source = 'invoice'`. The rule is deliberately simple: one invoice subscription in a mixed term drops the line for the whole notice. The arrangement stays admin-side (§8): no agreed amount, payer, invoice or PO reference.
4. Says what happens on the date, by source. Complimentary and invoice subscriptions end unless renewed, and their products move to Free. Annual paid subscriptions renew for another year, and the copy states the charge: list price times the renewing count, plus any tax (AECI-1596). Ruling B does not touch that line, because paid subscriptions carry the list price. A founding discount covers the first year only, so a renewal is at list price. A term holding both says which does which. A paid subscription flagged `cancel_at_term_end` does not renew: when no subscription in a card term renews, the copy says the subscriptions end as asked and that we will not charge again, and it has no opt-out line.
5. Says how to opt out or reduce: an owner chooses Release subscription on the Billing tab, or the vendor replies. When the term holds a paid subscription, it also says an owner can cancel the card renewal from Manage billing in Stripe on the Billing tab, or reply (AECI-1516, 2026-10-28). A term with no paid subscription has nothing to renew, so it names no portal route. Replies go to `SUPPORT_EMAIL`. A past-term notice drops this line.
6. Announces a terms change (decision 9). When any subscription in the term has a non-null `terms_version` that differs from the version in force (AECI-1689), it adds "A new version of the Managed plan agreement applies from {date}" with a link to `/legal/managed-plan-agreement`. A null version (a complimentary or invoice grant) gets no notice, because nothing was accepted.
   *As built 2026-11-12 (AECI-1690, the agreement's "Changes to this agreement").* When card subscriptions in the term renew, and the version that renewal binds (`bindTermsVersion`, the call the renewal makes, per carried version: in force at `ends_at`, and published at least 45 days before it, D2 of AECI-1690) is above what one of them carries and has a published `legal_versions` row, the line gives way to a block straight after the lead and before the price. It names the version and its effective date, lists the summary bullets (escaped in HTML), links the fixed copy `/legal/managed-plan-agreement/v<version>`, and attaches the PDF as `aeci-managed-plan-agreement-v<version>.pdf`. The PDF is read once per version per run and re-hashed against `pdf_sha256` (`loadVerifiedLegalPdf`). A missing or changed file sends the block without the attachment and its sentence, and logs `aeci.entitlement.expiry.pdf_refused` at error level with the version. A send with the PDF blind-copies no one, so the operator gets `entitlement-expiring-operator-copy`, the same body without the PDF. A version that is a draft in code has no row, so today nothing extra is read.

The audit row's metadata gains `terms_change`. `license_count` was already there.

**Idempotency fence:** `licenses.expiry_notice_sent_at` (§7.5). A vendor gets one notice per term, not one per night. The sweep's other rules:

- **The fence is computed in TS, not SQL.** `expiry_notice_sent_at < ends_at − 45d` is a column-to-column comparison. SQLite's `datetime()` renders `YYYY-MM-DD HH:MM:SS`, which does not order lexically against the stored `…THH:MM:SS.sssZ` form, so a SQL version would be a silent bug. The horizon filter stays in SQL and rides the partial index.
- **The fence stamps when either channel was `sent`.** Stamping on attempt would consume a term's one notice during a Resend outage. Requiring both would re-nag the operator every night on a tier without `SUPABASE_SERVICE_ROLE_KEY`.
- **The job does not rethrow.** A retry would re-send every notice whose fence write failed. An unexpected error is an `outcome:failed` heartbeat and a `failed` `job_runs` row, and tomorrow's run picks up what this one missed.
- **The batch cap is 200 terms a run** (`EXPIRY_BATCH_CAP`). It is a backstop, not a design limit. The read orders never-warned terms first, then by end date, so a backlog of already-warned terms cannot starve a due one. The dropped count is logged.
- **The scan has no lower bound, on purpose.** A live subscription already past its `ends_at` is a term the lapse did not end, because it failed or hit its cap. That is what an operator most needs to see, and the fence still limits it to one notice.
- **No data is the failure signal.** `aeci.entitlement.expiry_due` is emitted on every run, including zero.
- **A test caveat.** `scheduled.spec.ts` lists `entitlement-expiry` in `AUDIT_EXEMPT_CRONS`, though a delivered warning writes an audit row, because the sweep is mocked there. The real obligation is asserted in `entitlement-expiry.spec.ts` (`TESTING_STRATEGY.md` §3.6).

### 7.3 The non-negotiable

*The warning batch writes nothing but the fence and its audit row. The lapse pre-step (§7.6) ends subscriptions in batches of its own.*

**The warning sweep never writes `status` and never ends a subscription.** A test asserts the batch holds no `status` mutation, and §7.5 point 4 asserts it against the generated SQL. The batch writes `licenses.expiry_notice_sent_at` and an audit row `license.expiry_warned` with `actor_type: 'system'` (§7.5). The row is audited, rather than following the `stats_cache` no-audit precedent, because "we warned them on date X" is the fact an offline-invoice dispute needs. Writing it keeps §26.1 unqualified.

Metrics: `aeci.entitlement.expiry_notice` (`outcome`, `channel: vendor|admin`) plus a per-run heartbeat consistent with the other cron jobs (`OBSERVABILITY.md`).

**Pilots end on their own date (AECI-1404).** A pilot is a complimentary subscription with its own end date. The lapse ends it on that date, recorded `lapsed`, or `released` when flagged release-at-renewal. It is not recorded `revoked`. A revoke stays for an early end.

1. **Each pilot vendor has its own one-month term.** The admin enters it when granting the subscriptions, from the vendor's sign-on date (§5.6.1). There is no shared pilot end date.
2. **An extension is case by case.** The admin extends the subscription from the Billing tab (E4.2). The extend clears the subscription's `expiry_notice_sent_at`, so the new term earns its own notice.
3. **The operator steps** are in `docs/runbooks/subscriptions.md` "Pilot vendor terms: set, extend, end".
4. **The vendor email leads with the end date** and the renewal offer, never a day count. A one-month term is inside the 45-day window on its first day, so the vendor gets the notice the day after the grant. After the offer, the copy says a vendor that does not renew moves to the Free plan, with seats and entered data kept. Replies go to `SUPPORT_EMAIL`. The past-due copy states no grace period, so none binds the operator (`docs/email.md`).

### 7.4 As built (AECI-613 — 2026-08-18)

Retired 2026-10-28 (AECI-1518). The decisions the AECI-613 build settled are folded into §7.2, and the subscription scan is §7.5.

### 7.5 Re-pointed to subscriptions (AECI-1356, E1.7 — 2026-10-14)

The sweep reads `licenses`, not `vendor_entitlements` (`docs/VENDOR_SIGNUP_PROCESS.md` §3 step 8, §5 E1). The cron, the two templates, the never-warned-first order, `EXPIRY_BATCH_CAP` and the metrics are unchanged. The sweep itself only warns. The lapse runs just before it in the same job (§7.6, AECI-1404), and the price line shipped with AECI-1406 (§7.2).

1. **The scan.** Live subscriptions with an end date inside the horizon: `ended_at IS NULL AND ends_at IS NOT NULL AND ends_at <= now + 45d`, which is exactly the predicate of the partial index `licenses_ends_idx`. Monthly subscriptions (`ends_at` null) and ended subscriptions are invisible to it by construction.
2. **One notice per account per term.** A term is one billing account's live subscriptions that share one `ends_at`. The scan groups by `(billing_account_id, ends_at)`, so three subscriptions ending on one day get one notice naming the count. Two end dates on one account are two terms and two notices: the email names one date. E1.4's dual-write moves an account's subscriptions together, so today that is one notice per account.
3. **The fence.** `licenses.expiry_notice_sent_at`. A term is due when any of its subscriptions is unstamped, or its oldest stamp predates `ends_at − 45d`. A delivered notice stamps every subscription it covered. `setLicensesTermStatements` clears the stamp when `ends_at` moves, so a renewed term earns its own notice. A subscription added to an already-warned term arrives unstamped, so the term is warned again with the new count. That is deliberate: the count is part of the notice. The comparison stays in TS (§7.4 point 1).
4. **What the batch may write.** Only `expiry_notice_sent_at` and `updated_at` on `licenses` (`expiryNoticeStampStatements` in `lib/license.ts`, one statement per 50 ids for D1's bound-parameter cap), and the audit row. The stamp is guarded on the scanned `ends_at`, so a renewal between the scan and the write keeps its cleared stamp. The invariant test asserts against the generated SQL that no statement names `ended_at`, `assigned_product_id` or `vendors`, not even as a guard.
5. **The audit row.** One per notice: `license.expiry_warned`, `entity_type = 'billing_account'`, `entity_id` = the account id, `vendor_id` filled, `metadata.license_ids` naming the subscriptions covered. The plan snapshot is `licensePlanSnapshot` over the vendor's whole subscription set. It is a vendor receipt, like the `vendor_entitlement.expiry_warned` rows it replaces, which stay readable.
6. **The operator copy.** `entitlement-expiring-admin` carries the subscription count, the subscriptions' `source` and their `reference` (invoice number, PO or grant note) in place of tier, payer and invoice ref. The vendor copy was unchanged here. *AECI-1406 (E6.3) rebuilt it as the renewal notice with the price, the count, the products and any terms change, sent to the billing email too (§7.2).*
7. **Counts are terms.** `due`, `suppressed`, `capped`, `warned` and the `aeci.entitlement.expiry_due` gauge count terms, not subscriptions.

### 7.6 The lapse on the end date (AECI-1404, E6.1 — 2026-10-19)

A subscription whose term has passed ends on its own (`docs/VENDOR_SIGNUP_PROCESS.md` §3 steps 9 and 10, decision 14). The product drops to Free and the vendor loses the edit right on its Managed fields, which stay live as the vendor left them. Nothing is deleted. Code: `apps/api/src/lib/license-lapse.ts`, with the batch built by `lapseTermStatements` in `lib/license.ts`.

1. **Where it runs.** A pre-step of the 11:00 `entitlement_expiry` job, before the warning sweep. There is no new cron, job key, `CRON_JOBS` entry or liveness entry. A lapsed term is therefore never warned. It stays queue-less and inline: the job now writes, and a queue retry would replay a run against subscriptions it already ended (the `retention` reason in `queueForJob`).
2. **The scan.** `ended_at IS NULL AND ends_at IS NOT NULL AND ends_at <= now` (the predicate of `licenses_ends_idx`) `AND source <> 'stripe'`, grouped by `(billing_account_id, ends_at)`. A term is one account's live subscriptions on one end date. `ends_at <= now` is the same rule as `termHasEnded` in `@aeci/shared/entitlements`. A date-only end is stored as 00:00Z, so the 11:00 run on the end day ends it. Monthly subscriptions (`ends_at` NULL) never lapse. There is no lower bound: an older passed term ends too.
   **Paid subscriptions never lapse here (decision 13).** The Stripe webhook (E9, AECI-1339) owns their ends: a deleted or cancelled Stripe subscription ends them. The scan skips `source = 'stripe'`, and `lapseTermStatements` leaves a paid subscription on the term live, so carry-over never treats one as lapsing. A live, unassigned pool subscription of any source may still receive a carried product (point 9).
   *As built 2026-10-28 (AECI-1500, E9.2).* `POST /api/webhooks/stripe` owns them through one sync, `syncSubscriptionLicensesStatements` in `lib/stripe-licenses.ts`, with the batch built by `syncStripeLicensesStatements` in `lib/license.ts`. Every Stripe subscription event re-reads the Stripe subscription from Stripe and runs it, so event order does not matter, and the E9.5 reconcile calls the same entry point, `runStripeSubscriptionSync`. For an `active`, `trialing` or `past_due` Stripe subscription the sync grants the delta when the quantity exceeds the live subscriptions (UUIDv5 ids over the Stripe subscription and the ordinal, so two syncs from one read collide on the primary key and the loser re-plans). It ends the surplus `released` when the quantity is lower: unassigned subscriptions first, then those flagged release-at-renewal, then the most recently assigned, with the carry-over of point 9. Annual subscriptions take the period end as `ends_at`; monthly ones keep it NULL. A renewal (`invoice.paid`, `subscription_cycle`) binds the current Managed plan agreement version. `cancel_at_period_end` maps to `cancel_at_term_end` with reason `vendor-cancelled`, set only on a subscription with no reason and cleared only where the reason is `vendor-cancelled`, so a ban flag is never touched. A `canceled`, `unpaid` or `incomplete_expired` Stripe subscription ends every live subscription on it as this section's lapse does: `lapsed`, or `released` when flagged, then the carry-over, the point 10 sentinels (mirror guards only since AECI-1663, which retired the re-route), one reconcile, and after commit the point 7 purge and `managed-ended` email. A failed payment changes no subscription (decision 13); it sends `payment-failed`.
   *The backstop, as built 2026-10-28 (AECI-1503, E9.5).* A daily reconcile catches what the webhook missed: an event Stripe gave up on, a disabled endpoint, a rotated secret. The cron `stripe-reconcile` (`15 1 * * *`) enqueues one message on `aeci-stripe-reconcile-{env}` (binding `STRIPE_RECONCILE_QUEUE`), and the consumer runs `runStripeReconcile` in `lib/stripe-reconcile.ts`. With no `STRIPE_SECRET_KEY` the run is `skipped` and reads nothing. Otherwise it makes two reads. First, one paged walk of `GET /v1/subscriptions` with no `status`, which Stripe answers with every Stripe subscription that is not canceled, 100 a page. Second, one `GET /v1/subscriptions/:id` for each Stripe subscription that still has a live subscription in D1 but was not in the walk: a canceled one, or one past the 10-page cap. Stripe's list filters on `created`, not on when a Stripe subscription changed, so a time-windowed canceled walk would miss an old Stripe subscription canceled yesterday. The second read covers it, at one request per Stripe subscription that needs ending. A listed Stripe subscription is synced only when it carries `billing_account_id` metadata or D1 holds subscriptions on it. Each one goes through `runStripeSubscriptionSync`, source `stripe-reconcile`, with the same emails as the webhook, at most `WORKER_CONNECTION_LIMIT` at a time.
   The sync converges, so a queue retry (3, batch size 1) changes only what still differs and cannot grant or end twice. A failed list walk throws before any write. A Stripe subscription that fails to sync is counted, the rest still sync, and the run then throws so the queue retries. Any change means an event was missed: the run emails `SUPPORT_EMAIL` one `stripe-reconcile-alert`, keyed on the day and the sorted Stripe subscription ids. The alert sends on production and demo only (registry `envRule: 'production-and-demo'`). Staging's webhook endpoint is unreachable by design, so every staging Stripe subscription would look like a missed webhook. The run checks the tier rule (`refusedByTierRule`) before it builds the alert. On staging and local it records `alert: 'suppressed'`, and the counts still reach `job_runs` on every tier. The counts go in `job_runs.detail` (`listed`, `truncated`, `synced`, `retrieved`, `changed`, `granted`, `ended`, `banCancelsNow`, `acceptancesBackfilled`, `billingEmailsBackfilled`, `unlinked`, `failed`, `alert`). Runbook: `docs/runbooks/subscriptions.md` "Stripe reconcile changed subscriptions". *Revised 2026-10-28 (the E9 fix pass, AECI-1503).*
   **The missing Checkout acceptance.** A missed `checkout.session.completed` also loses the Managed plan agreement acceptance. For each linked Stripe subscription the run looks in D1 for a `checkout` acceptance on the billing account at or after the Stripe subscription's `created`, less one hour of clock-skew slack (`ACCEPTANCE_WINDOW_SECONDS`). When there is none, `findCheckoutSessionForSubscription` in `lib/stripe.ts` makes one `GET /v1/checkout/sessions?subscription=…&limit=1`. The run records the acceptance through `checkoutAcceptanceStatements` in `lib/stripe-webhook-events.ts`, the same builder the webhook uses: the metadata's `terms_version` and `profile_id`, stamped with the Stripe subscription's `created`. It goes first in the sync's batch and is counted in `acceptancesBackfilled`. The same prefix backfills the billing email the webhook would have set (decision 16 in `VENDOR_SIGNUP_PROCESS.md`): when the account has none, `billingEmailStatements` in `lib/billing-account.ts` sets it to the buyer's email from the session, with its `billing_account.email_changed` audit row in the same batch (`billingEmailsBackfilled`). The customer link needs no backfill, because checkout links it before the session opens. Either backfill counts as a change, so it raises `changed` and the alert names it under "Acceptance" or "Billing email". A session that already has its row is left alone, because `stripe_checkout_session_id` is unique, so a second run adds nothing. A Stripe subscription made outside Checkout has no session and records nothing. A failed lookup warns `aeci.stripe.reconcile.acceptance_lookup_failed` and the sync goes on. A row the builder cannot build, for a missing version or email, warns `aeci.stripe.reconcile.acceptance_skipped`. If the webhook records the same session between the read and the batch, the unique key trips, the sync re-plans, the prefix re-reads the session's row, finds it, and leaves the acceptance out (`isCheckoutAcceptanceConflict` in `lib/stripe-licenses.ts`). The webhook's `checkoutPrefix` does the same read, so a late event after a reconcile backfill records nothing twice. *Revised 2026-10-28 (AECI-1500).*
   **Renewals.** The sync binds an agreement version when an annual period end moves past a live subscription's `ends_at` (`annualPeriodMovedForward` in `lib/stripe-licenses.ts`). This holds for both callers. The webhook still marks a renewal on `invoice.paid` (`subscription_cycle`), and any other path, the reconcile or a `subscription.updated`, sees the moved period end. *Since AECI-1690* the version is `loadTermsBinding`'s at the period start, not the build constant (ADR 0047 decision 9), and the reconcile's `monthlyCatchUp` completes a monthly bind the current period's charge should have made, with the acceptances recorded by the period start: a missed monthly `invoice.paid` (`termsBound` in `job_runs.detail`). A click mid-period binds at the next charge. A subscription that began in the current period is not rebound.
   **Known gaps.** An acceptance that can never be built, for example one whose metadata has no version, is looked up again every day and warns `acceptance_skipped` each time.
   *The ban cancel, as built 2026-11-03 (AECI-1589, superseding the 2026-10-28 period-end cancel and its `metadata.aeci_ban_cancel` marker, which are deleted), and moved on 2026-11-05 by AECI-1623: Terminate does what the last-seat ban did, after Suspend, and refunds the unused term (§5.2).* Terminate ends every subscription `banned` in its own batch, then `stripeBanCancelNowHook` cancels each Stripe subscription after commit. The set is the live subscriptions' Stripe subscriptions plus every Stripe subscription listed on the billing account's Stripe customer (`listSubscriptions({ customer })`), so an `unpaid` Stripe subscription whose subscriptions had already lapsed, or an `incomplete` first payment, is cancelled too. The hook then expires the customer's open Checkout sessions (`listOpenCheckoutSessions` + `expireCheckoutSession`, key `aeci-ban-expire-{session id}`); a failure warns `aeci.stripe.ban_checkout_expire_failed` and never throws. The whole Stripe pass has a 15 s deadline (`BAN_CANCEL_DEADLINE_MS`): each Stripe call has its own 10 s timeout, so a hung Stripe could otherwise hold the email for 30 s or more. Past the deadline no further Stripe call starts, and every Stripe subscription not yet settled reports `failed`, so the email says it "will be cancelled within a day". The cache purge runs in its own `waitUntil` before the hook, so a hung Stripe never delays it. The cancel itself is `DELETE /v1/subscriptions/:id?prorate=false&invoice_now=false`, through `StripeClient.cancelSubscriptionNow`. The parameters ride the query string with no body, as Stripe's SDKs send DELETE parameters. Stripe accepts idempotency keys on POST only, so the DELETE carries none. The hook cancels every status Stripe can still bill: all but `canceled` and `incomplete_expired` (`isStripeSubscriptionCancellable`). An `unpaid`, `paused` or `incomplete` Stripe subscription grants no subscription, but its open invoice can still be paid. The hook runs sequentially, never throws, and skips a Stripe subscription whose pre-read status is terminal. It does not match Stripe's error text. On any refusal it re-reads the Stripe subscription and counts the cancel done (`unchanged`) when it is terminal by then. The refunds and then the `vendor-terminated` email run after the hook in the same `waitUntil` chain, and the email states each cancel's and each refund's outcome. A cancel that failed warns `aeci.stripe.ban_cancel_now_failed` (`vendor_id`, `stripe_subscription_id`, `reason`). It runs after commit on purpose: a cancel before the batch, followed by a lost D1 race, would let Stripe's `deleted` event end the subscriptions `lapsed` and send `managed-ended`. A pre-ban read of the paid term end that fails warns `aeci.stripe.ban_period_end_unavailable` and the ban goes ahead. *The ban-dead rule.* A Stripe subscription that Stripe can still bill is ban-dead when its vendor is terminated and fully banned (`vendorBanDead`, AECI-1623: a `vendor_suspensions` row with `resolution = 'terminated'`, `vendors.owned_at` still NULL because no unban or new seat has reinstated it, and at least one `vendor_admin` seat, every one banned), whatever its subscriptions, or when some subscription on it ended `banned` and none is live (`isBanDeadSubscription`). `runStripeSubscriptionSync` never grants on one. For any non-terminal status it cancels it now instead, records `stripe_events.outcome = 'ban-dead'` with the ledger row only, and warns `aeci.stripe.sync.ban_dead_cancelled`. So a `subscription.updated` that lands between the ban's commit and its cancel, and the daily reconcile, both repair a failed cancel. The reconcile counts these as `banCancelsNow` (it replaces `banCancelsCleared` and `banCancelsApplied`), and a cancel that fails again fails that Stripe subscription so the queue retries it. The webhook path throws `StripeTransientError` on a failed cancel and answers 503 with no ledger row, so Stripe retries the event. A sync that read before the ban and planned grants carries `bannedSubscriptionSentinel` in its batch: when any subscription on the Stripe subscription has ended `banned` by then, the batch aborts and the one re-plan reads the Stripe subscription as ban-dead. A live-mode batch that grants also carries `vendorNotBanDeadSentinel`, so a terminate that lands mid-sync on a vendor with no subscription on this Stripe subscription aborts it the same way. A vendor left with only banned seats by a seat revoke or an erasure is **not** ban-dead (AECI-1623): it got no notice and no refund, so the sync keeps granting and its billing carries on. The `banned` license rule is unchanged. Stripe's own `customer.subscription.deleted` and `updated(canceled)` events after the cancel find nothing live and change nothing (`no_change`): no `managed-ended`, no purge. Non-payment is unchanged: `invoice.payment_failed` keeps subscriptions live, and a Stripe-side cancel ends them `lapsed` with `managed-ended`.
3. **The cap counts terms.** 200 per run (`EXPIRY_BATCH_CAP`, reused), oldest end date first. A term is never split across runs. A capped run counts `aeci.license.lapse.capped` and logs, and the rest lapse the next day.
4. **One batch per term.** A subscription flagged `release_at_renewal` ends with `end_reason = 'released'` (`license.released`). Every other subscription on the term ends `lapsed` (`license.lapsed`). One audit row per subscription, actor `system`, `metadata.source = 'license-lapse-cron'`, `metadata.ends_at` the term. One mirror reconcile and one `verifiedFlipped` prediction for the whole batch. `assigned_product_id` is kept, as for every end.
5. **Races.** Every end UPDATE is guarded on `ended_at IS NULL`, the scanned `ends_at`, the pre-read `assigned_product_id` (NULL-safe `IS`), and the pre-read `release_at_renewal` and `cancel_at_term_end`. `lapseTermStatements` builds these guards through the private `endWrites` in `lib/license.ts`. Each UPDATE is followed by a `changedOneRowSentinel`. An admin extend or revoke that commits between the read and the batch therefore rolls the whole term back, and the admin write wins. So does a vendor assign or unassign on a term subscription: the retry reads the new product and ends the subscription with it. So does a release or cancel flag set mid-run: the flags pick the end reason and the carry-over, so the retry reads them again. As the revoke does, the run then reads the term again and rebuilds its batch once: an extended subscription is off the term, and the rest end. A term that rolls back twice counts in `lapse_batch_failures` and is read again the next day.
6. **The hand-back writes nothing here.** It is the loss of the edit right only, and revoke, release and lapse hand back the same way. Promote still writes nothing to an owned vendor's product (`REVIEW_APP_PROMOTE_API.md` §4a). The E6.4 promote opening was removed 2026-10-19 (AECI-1414, ruling on AECI-1341).
7. **After commit, once per run.** One purge message on `CACHE_PURGE_QUEUE`, source `'moderation'`: `product:{slug}` for every product that dropped to Free, `index:products`, and `vendorPurgeTags` for every vendor whose term dropped a product or flipped `vendors.verified`. No Algolia sync, because records carry neither `verified` nor a plan. One `forwardAuditBatch`. Then `managed-ended` emails, one per term and cause: the products that lapsed and the products released at renewal go in separate emails. They go to every unbanned seat and the billing email, each address once (`lib/billing-recipients.ts`). The dedupe key is `managed-ended:term:{billingAccountId}:{endsAt}:{cause}:{recipient hash}`. Sends run one at a time. A pool subscription changes no product, so it gets no email. A failed purge or send never undoes the lapse.
8. **The job row.** `entitlement-expiry`'s `job_runs.detail` gains `lapsed_terms`, `lapsed_licenses`, `carried` (point 9), `lapse_capped`, `lapse_batch_failures` and `lapse_email`. A crash of the lapse scan sets `lapse_error`, marks the run `failed`, and still lets the warnings run. The unassigned-subscription reminder (§7.7) follows the same rule with `unassigned_error`.
9. **Fewer subscriptions than products: the carry-over (AECI-1405, E6.2).** Decision 12 as ruled 2026-10-19. In the term's batch, after the ends, a product on a lapsing subscription moves onto a live, unassigned subscription of the same billing account whose `ends_at` is NULL or later than now. The products assigned longest go first (`assigned_at ASC, id ASC`), onto pool subscriptions oldest first (`created_at ASC, id ASC`). Built by `carryOverStatements` in `lib/license.ts`. Each move is a `license.assigned` audit row with `metadata.carried_from` naming the lapsing subscription, guarded like any assign and followed by the same race sentinel. **A carried product keeps its seniority (ruling A, Chris, 2026-10-19).** The pool subscription takes the lapsing subscription's `assigned_at`, not now, and the audit row's `after_state.assigned_at` records it. Decision 12 says the oldest assignment keeps the subscription, so a product that carried once still ranks by its first assign at the next shortfall. The old subscription ends first in the batch, so `licenses_live_product_idx` holds. A product flagged `release_at_renewal` or `cancel_at_term_end` never moves. A product another live subscription holds, or one the vendor no longer owns, is pre-checked and never moves. A carried product stays Managed: no email, no purge. The products left over drop to Free, and their `managed-ended` email adds "You had fewer subscriptions than products. The products assigned longest kept theirs." The line appears only when at least one product carried, and only when every product in the `lapsed` email lost the carry-over. A product that was never a candidate (cancel-at-term-end, held by another live subscription, or no longer owned) in the same email drops the line, so it never explains a drop it did not cause. E9 reuses this step at a Stripe renewal with a lower quantity.
   *As built 2026-10-28 (AECI-1500, E9.2).* The Stripe sync calls `carryOverStatements` itself, in the same batch, after its ends: when a lower quantity ends assigned subscriptions, and when a dead Stripe subscription ends them all. The pool is the account's live, unassigned subscriptions not ending in the batch, of any source, whose `ends_at` is NULL or later than now. The no-carry pre-check is the lapse's, shared as `loadNoCarryProducts` (`lib/license-lapse.ts`). The `managed-ended` email for a Stripe end is keyed `managed-ended:stripe:{subscriptionId}:{first ended license id}:{cause}:{recipient hash}`.
10. ~~**The last live subscription re-routes contests (ruled 2026-10-19).**~~ *Retired 2026-11-09 by ruling 14 (AECI-1663), with ruling B. A lapse moves no contest now, and `job_runs.detail` lost `rerouted_contests`. The license-race guards named at the end of this point stay, as mirror guards that keep `verified_flipped` true to the commit.* A term whose end leaves the vendor no live subscription also moves the vendor's open owner-decided contests on connector-powered rows to AECi, exactly as the admin revoke does (ruling B, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13). Both run `planLastLicenseReroute` in `lib/integration-contests.ts`. The moves ride the term's batch with their audit rows: `integration.contest.rerouted`, actor `system`, `metadata.reason = 'entitlement-cleared'`, `metadata.source = 'license-lapse-cron'`, plus the term's `billing_account_id` and `ends_at`. "Last" is read from the `licenses` rows. A carried product's pool subscription is live, and so is a subscription on another passed term the run has not reached yet, so the re-route runs on the vendor's last term. The guards are the revoke's: the plan's own guard and `noLiveLicenseSentinel` with a re-route, `liveLicenseRemainsSentinel` without one. Any abort sends the term into the rebuild of point 5. The revoke sends nothing about its re-route, so the lapse sends nothing either. The rows join the run's one forward.


### 7.7 The unassigned-subscription reminder (AECI-1512 — 2026-10-28)

A grant lands its subscriptions in the pool unassigned (`docs/VENDOR_SIGNUP_PROCESS.md` §3 steps 5 and 6). `licenses-granted` says so once. *Since AECI-1615 (2026-11-10)* both happen when the grant activates, at the owner's accept or a recorded signed deal, not when AECi grants it. So the week counts from the accept. This step reminds the owners a week later if a subscription is still on no product. Code: `apps/api/src/lib/license-unassigned-reminder.ts`.

1. **Where it runs.** A step of the 11:00 `entitlement_expiry` job, after the 45-day notice. No new cron, job key or liveness entry.
2. **Which subscriptions are due.** Live (`ended_at IS NULL`), on no product, `cancel_at_term_end = 0`, and `created_at` between 7 and 10 days ago (`REMINDER_AFTER_DAYS`, `REMINDER_GRACE_DAYS`). The 3-day grace covers a missed cron. `created_at`, not `starts_at`: the admin grant takes `starts_at` from the operator, but stamps `created_at` with the real write time, which since AECI-1615 is the activation. `grantLicensesStatements` is the one writer of `licenses` rows today. The Stripe writer (E9, AECI-1339) must create rows through it too, so `created_at` holds the purchase time.
3. **One email per account per grant day.** Due subscriptions are grouped by billing account and the UTC day of `created_at`. One grant is one email; two grant days are two emails, on the same run when both are in the window.
4. **Who gets it.** Unbanned owner seats only (`loadVendorOwnerRecipients`), because only an owner can assign. Not the billing email.
5. **When nothing is sent.** When every product the vendor owns already holds a live subscription, there is nothing to assign. The group counts in `unassigned_nothing_to_assign` and sends nothing.
6. **What it says.** The count on no product, the owned products still on Free (the Billing tab's assignable set), where to assign, and the end date when there is one. Template notes: `docs/email.md`.
7. **At most once.** Key `license-unassigned-reminder:{billingAccountId}:{grantDay}:{profileId}`. Pausable: no deadline rides on it.
8. **Writes no domain state.** Only the send ledger, which is log-class (ADR 0022), so no audit row.
9. **The job row.** `entitlement-expiry`'s `job_runs.detail` gains `unassigned_due`, `unassigned_capped`, `unassigned_nothing_to_assign` and `unassigned_emails`. A crash sets `unassigned_error` and marks the run `failed`, as a lapse crash does (§7.6 point 8). The notices have already run.
10. **What it does not cover.** A subscription unassigned later, by an approved early unassign or a product retraction (AECI-1350), is older than the window and gets no reminder. At renewal, `entitlement-expiring` already says how many subscriptions are on no product, but only for subscriptions with an end date. A monthly or open-ended subscription gets no renewal-time reminder.

### 7.8 The plan-end mirrors move with the license (AECI-1614 — 2026-11-05)

The "until" caption (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8) publishes a plan end. A public read may not query `licenses` (§2.5), so two mirrors carry it. *Since ruling 14 (2026-11-09, AECI-1663) only `products.managed_ended_at` feeds a caption. `vendors.plan_ended_at` keeps its writer, its column and the drift check below, with no public reader. No migration.* ADR 0051 records the decision.

| Mirror | Set when | Cleared when | Built by |
|---|---|---|---|
| `products.managed_ended_at` | The product loses its last live license: a lapse, a release, a revoke, a termination, a Stripe end, or an early unassign, which dates it at the unassign | A live license reaches the product: a grant with a product, an assign, or a carry-over | `reconcileManagedMirror` (`lib/license.ts`) |
| `vendors.plan_ended_at` | The vendor has no live license left. It moves with `verified` | Any live license | `reconcileVerifiedMirror` (`lib/license.ts`) |

1. **The same batch as the license write.** Every end, assign, unassign, carry-over and Stripe sync already computes the license set before and after. The reconcile runs from that diff, just before the vendor reconcile, so a mirror cannot move without its license.
2. **A carried product does not move.** Each statement re-checks liveness in SQL, so a carry-over (§7.6 point 9) that leaves the product live stamps nothing. A batch that lost a race keeps the first end's date.
3. **`updated_at` is pinned.** `reconcileManagedMirror` sets `products.updated_at` to itself. The column's `$onUpdate` would otherwise move it, and a plan event must not move a public sort or the Algolia watermark (§13.4).
4. **The date is a stored fact.** It is never computed from a clock at read time, so the cached HTML stays neutral.
5. **The purge.** The end paths already purge the product and the vendor set. *From AECI-1614 to AECI-1663 `vendorPurgeTags` also covered the pages of the vendor's edited connector-powered rows (`connectorRowTags`). Ruling 14 (2026-11-09) took the `until` form off rows, so a plan flip no longer changes a row caption and those tags are gone.*
6. **The drift check.** `plan_end_mirror_drift` (warn) compares both mirrors with `licenses` (`ADMIN_PANEL_SPEC.md` §14.1). `scripts/ops/2026-11-field-caption-backfill/` fills them from `licenses` once.

---

### 7.9 The license-grant sweep (AECI-1615 — 2026-11-10)

A grant waits as `pending_acceptance` until an owner accepts it (`VENDOR_SIGNUP_PROCESS.md` §3 step 5, `DATABASE_SCHEMA.md` §8.6h). The fourth step of the 11:00 job looks after the waiting grants. Code: `apps/api/src/lib/license-grant-sweep.ts`.

1. **Where it runs.** Last in the 11:00 `entitlement_expiry` job, in its own catch. No new cron, job key or queue. A queue retry would re-send email.
2. **Expire.** A pending grant whose `ends_at` is not after now becomes `expired`. One batch per grant: a guarded UPDATE, `changedOneRowSentinel` and a `license_grant.expired` audit row, actor `system`. A grant accepted or withdrawn since the read trips the sentinel and writes nothing. A failed batch is counted and retried tomorrow.
3. **Catch-up.** A pending grant under 7 days old sends `license-grant-pending` to every unbanned owner seat. The send ledger key `license-grant-pending:{grantId}:{profileId}` makes this a no-op except for an owner who had no send yet: a vendor with no seat at grant time, or a failed send.
4. **Reminder.** A pending grant 7 or more days old sends `license-grant-pending-reminder` once per owner seat (ruling R4), keyed `license-grant-pending-reminder:{grantId}:{profileId}`. It replaces the catch-up from day 7, so a late owner gets one prompt.
5. **Cap.** At most 100 grants per pass (`LICENSE_GRANT_SWEEP_CAP`). The rest wait for the next run and count in `grants_capped`.
6. **The job row.** `job_runs.detail` gains `grants_expired`, `grants_raced`, `grants_batch_failures`, `grants_capped`, `grant_pending_emails` and `grant_reminder_emails`. A crash sets `grants_error` and marks the run `failed`, as a lapse crash does.

## 8. Vendor-facing entitlement surface (AECI-614)

Each product page carries a plan panel (`apps/web/src/app/vendor/components/vendor-plan-panel.ts`, AECI-614, made per product by AECI-1218). It states that one product's plan in words: a portal-only "Free" or "Managed" badge beside the heading, a lede, what the plan includes, the price and one button.

- **It reads the product's `plan` block** on `GET /api/vendor/me` (§13.7), built from the product's own subscription. No new endpoint.
- **It has seven states:** `managed`, `expiring`, `overdue`, `pending`, `ended`, `free` and `catalogue` (§8.1). `ended` is the one to design properly. It is shown to a customer AECi wants back.
- **Price.** Every state but `catalogue` shows "Managed is $25 a month or $250 a year per product." from `planPriceSentence(locale)`. Every state carries decision 10's line (§13.1).
- **Buttons.** An owner seat goes to the Billing tab: "Go to Billing" in `free`, `ended` and `overdue`, and "Manage renewal" in `expiring`. A member seat cannot open Billing, so it keeps the contact path (`/contact`): "Ask about Managed for this product", or "Renew Managed" in `expiring` (AECI-1396, AECI-1408).
- **Copy discipline.** Copy never says verification, endorsement, ranking or placement. No plan turns a public label on or off, because the "Active on AEC Integrations" label was removed on 2026-10-09 (AECI-1264). Copy promises no instant search (§8.3(5)). Amounts and terms stay admin-side. The subscription `reference` (invoice or PO number) shows to the vendor on the Billing tab, not on the panel, because it is the vendor's own number (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21, Chris, 2026-10-16, AECI-1390). The help page is `/docs/vendors/plans`.
- **Design checklist.** Run the `CLAUDE.md` design checklist: Anchor-Site Rule (the anchor is the existing `/vendor` dashboard, so it must read as a sibling), `impeccable detect` clean, axe pass, i18n `@@` ids on every string. **Light theme only.**

The Free plan, the per-product panel and the plan-ended banners are governed by §13 and `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18.

### 8.1 As built (AECI-614 — 2026-08-19)

`vendor-plan-panel.ts` replaced `vendor-verified-status.ts`. It reads the product's `plan` block (`VendorEntitlementBlock`, §13.7). The state rule is `planState` in `apps/web/src/app/vendor/vendor-plan.ts`.

| State | Condition | What it says |
|---|---|---|
| `managed` | A live subscription on the product, end date far off or none | "This product is on Managed", through the end date when there is one. Lists what Managed covers and what Free also includes. |
| `expiring` | A live subscription whose end day is today or inside `EXPIRY_WARNING_DAYS` | "Managed ends on {date}, in N days. Nothing changes before then." Warm wash. Owners get "Manage renewal". |
| `overdue` | A live subscription whose end day has passed (AECI-1408) | "Managed ended on {date}. The change is on its way." Shows only in the hours before the daily lapse job ends the subscription (§7.6). |
| `ended` | The product's latest subscription ended | A loss to acknowledge. "Managed ended for this product on {date}, so it is on Free. Ending a plan removes nothing you entered." Leads with what the vendor keeps. *(Reworded 2026-11-05, AECI-1618: an owner seat's 30-day removal election can blank the product's text, so "Nothing you entered was removed" could be false.)* |
| `free` | The product never held a subscription, or the block is `active` over a tier this build does not know | An invitation, not a loss. "This product is on Free. Its listing is published and stays published." |
| `pending` | Block `status: 'pending'` | "Arranged, not yet switched on." No subscription produces this status, so it does not occur today. The code keeps the state. |
| `catalogue` | A connector catalogue seat | Describes the catalogue-maintenance seat. Shows no price. |

Days count by UTC calendar day (`signedDaysRemaining`), so "Managed ends today" shows on the end day only. Dates format in UTC. The SSR Worker runs in UTC and the browser does not, so a zone-local format would render two dates across hydration.

`ended` and `free` are different conversations on purpose. A loss acknowledgement shown to someone who never bought anything is the wrong message, and the wire keeps the two apart (§4, §13.11).

Two decisions this section did not pre-specify:

1. **State resolution is fail-closed.** `status: 'active'` over a tier the build does not know reads as Free, not Managed. The panel must never claim more than the gate honours.
2. **The expiry horizon is one constant.** `EXPIRY_WARNING_DAYS` in `@aeci/shared/entitlements` is read by both the 11:00 job and the panel. A job with a wider horizon than the panel would email a paying customer about a problem their own portal still denied. Since AECI-1596 it is 45, so the panel's `expiring` state starts 45 days out. The Managed plan agreement promises the number, so it changes only with the agreement.

Every write gate in the portal reads `capabilities`, the Integrations gate included (AECI-623). The portal reads `attestation.author`, the capability the API asserts on attestation and version writes.

---

## 9. Documentation & authz sweep (AECI-615)

Land last, once §2–§8 have settled the details. Each doc gets the sections named. AECI-615 landed this sweep. Rows that later work changed say so in place.

| Doc | Change |
|---|---|
| `API_CONTRACTS.md` | §6.10 — `PATCH /api/admin/vendors/:id/entitlement` (retired by AECI-1375, replaced in §6.10 by the subscription routes), plus the `entitlement_vendor` field on `AdminClaim` (its `entitlement` readout dropped by AECI-1375) and the `tier` field on `ClaimGrantSummary` (`entitlement_created` removed 2026-10-15, AECI-1367); §6.14 — the `entitlement` block on `GET /api/vendor/me` + the 403 `ENTITLEMENT_REQUIRED` shape + the second (capability) axis on the allow-list invariant; §4 — the error code row |
| `DATABASE_SCHEMA.md` | new **§8.6** `vendor_entitlements`, now the record of the dropped table (AECI-1358), with the plan tables in §8.6b and §8.6c; §3 — the table inventory; §4.1 — rewrite the `vendors.verified` annotation from "sole writer is the claim grant, no un-verify writer yet" to the mirror invariant; §7.1 — a disambiguating pointer next to `profiles.trust_tier` (R4); §18 — the expiry sweep is a second auditing cron |
| `AUTH_AND_RLS.md` | §3.2 — replace "`vendors.verified` *is* the launch entitlement bit (there is no `entitlements` table)"; **new §4.2b** — the entitlement tier on the session; §4.4 — the new admin endpoint row + capability columns on the vendor writes; §8 — the FK trap table (already **seven** rows; fix the "six inbound references" and "eight-FK trap" prose that disagreed with it); §8.2 — the last-seat edge gains "the entitlement survives, and that is legitimate: verified-but-unclaimed"; §9 — mark the model shipped |
| `email.md` | catalogue rows for `entitlement-expiring` / `entitlement-expiring-admin`; the `ADMIN_ALERT_EMAIL` row (since AECI-1220: `SUPPORT_EMAIL`) gains the operator copy |
| `CACHE_STRATEGY.md` | new **(b1)** — plan changes purge the vendor tag set via the shared builder (§5.3); no new tag; the `updated_at`-iff-`verified` rule in both directions |
| `OBSERVABILITY.md` | `aeci.entitlement.action` (retired by AECI-1375), `aeci.entitlement.expiry_due`, `aeci.entitlement.expiry_notice`, `aeci.entitlement.expiry.job{,.duration_ms}`, the mirror drift id under `aeci.data_quality.check` (`license_mirror_drift` since AECI-1375 retired `entitlement_mirror_drift`), a cron-liveness row for the 11:00 job; **and fix the already-stale `aeci.email.send` `template` tag list**, which omitted `claim-approved`, `claim-rejected` and `mailing-list-welcome` |
| `migrations.md` | nothing owed — `apps/api/scripts/README.md` carried the §2.4 backfill script until AECI-1358 deleted it, and §0's numbering history is current |
| `STAGE_2_SPEC.md` | §8.2's two open items are already promoted to §8.5 by the epic review; §2.2 already points here |
| `STAGE_2_VENDOR_PORTAL_SPEC.md` | its three hand-off lines (§3's unowned un-verify, §6.1's deferred paid-tier display, §11's deferral bullet) already name this doc; verify they still resolve |
| `STAGE_2_ATTESTATIONS_SPEC.md` | §9.3/§9.4 — the version-diff gate is built and both ⚠️ notes are resolved; AECI-304 moves off the deferred list |
| `ANGULAR_STYLE_GUIDE.md` §24 | the mirror sole-writer rule's exemption list drops to **one** file; the `version-diff.ts` no-zod block joins the package-local guards; the `@aeci/shared/entitlements` SSR boundary is recorded as **not built** and restated as a viewer-tier ban |
| `TESTING_STRATEGY.md` | new §3.6 — the §10 invariant tests, and what makes one different from a coverage test; §8.2 — the `/admin/vendors` axe row (§5.6) |
| `ADMIN_PANEL_SPEC.md` | §5 — the route tree gains `/admin/vendors` (§5.6); new §5.7; §2 — one line clarifying that an entitlement/seat write is not a *catalog* write |
| `CLAUDE.md` | the design checklist's `impeccable detect` step — scan the rendered surface, because a file-path scan cannot see inline Angular templates and passes vacuously |

---

## 10. Testing contract

The four tests below are **invariant tests** — they encode decisions, not behaviour, and must not be deleted without reopening this spec.

| Test | Owner | Asserts |
|---|---|---|
| Mirror sole-writer | §2 | `grantSeatStatements` (and every route handler) emits no statement touching `vendors.verified`. Only `lib/license.ts` does, and never without the subscription statement in the same batch. **Live**: Guard 1 plus `apps/api/src/lib/vendor-grant.spec.ts`, which AECI-612 created |
| Ranking disjointness | §3 | the capability vocabulary and the union of `INDEX_SETTINGS` searchable/facet/customRanking attributes are disjoint sets (§3.2) — **live** in `packages/shared/src/entitlements.spec.ts` |
| Reads are never gated | §4 | `GET /api/vendor/me` returns 200 for a vendor whose only subscription ended, `revoked` or `expired`, with the downgraded `entitlement` block. **Live** in `apps/api/src/routes/vendor.entitlement.spec.ts` |
| On-page ordering | §3.2 assertion 8 | The registered on-page sorts, default orders and featured subsets do not move when any Managed-only input changes, except the one accepted exception named there. **Live** in `apps/api/src/lib/on-page-ordering-firewall.spec.ts`, `apps/web/src/app/products/on-page-ordering-firewall.spec.ts` and its `.component.spec.ts` (AECI-1814) |

> **Correction:** this table originally implied `vendor-grant.spec.ts` already existed and merely gained an assertion. **It never did** — `git log --all --diff-filter=A` finds no such file on any branch before AECI-612, and `grantSeatStatements` was covered only indirectly through `admin-claims.spec.ts`. AECI-612 created it.

Plus, per issue, four more. **`vendors.updated_at` moves iff `vendors.verified` moves, in both directions** (§2.1, R2). `POST /api/promote` still cannot move the bit, the AECI-520 regression guard carried over from AECI-532. The warning sweep writes nothing but its fence and audit row (§7.3, §7.5 point 4), asserted against the generated SQL. The no-read-path guard on `drizzle-helpers.ts` holds (§2.5). The second-seat matrix (§2.3) and the 422 idempotency on `set`/`clear` (§5) left with the entitlement code (AECI-1358, AECI-1375).

### Risks recorded at the epic review

| # | Trap | Mitigation |
|---|---|---|
| R1 | `workflow_instances_type_check` is a **closed** CHECK; a new type is a SQLite table rebuild | No workflow row for plan changes, then or now. `audit_log.entity_type` is unconstrained. Settled in §1.2. |
| R2 | The Algolia watermark. AECI-529 only ever reasoned about the flip to **`true`** | **`vendors.updated_at` moves iff `verified` moves**, both directions tested. A renewal that doesn't flip the mirror must **not** bump it (needless nightly re-push); deactivation must bump it. `reconcileVerifiedMirror` holds both directions today (§2.1). Since AECI-1266 the Algolia record carries no `verified`, so the stale-record half of the risk is gone. |
| R3 | Cache key vs Cache-Tag | A public page may never fork on the **viewer's** entitlement (Workers Cache is URL-keyed; `CLAUDE.md` visitor-state-neutral constraint). **Discharged in practice, still open mechanically.** AECI-304 — the build this risk was written about — kept its gate URL-derived (the pair's endpoint vendors, a function of the two slugs), so no cookie, no session, no `Cache-Control: private`, no new cache-key axis; `cacheKeyParams` unchanged. But there is still **no lint rule**: §3.3(c)'s sketched module ban is the wrong shape (§3.3c, as restated), and nobody has expressed the viewer-tier property mechanically. Tag side: one shared tag builder (§2.5). |
| R4 | `profiles.trust_tier`'s CHECK vocabulary **literally contains `'verified'`** — a reviewer concept on the neighbouring table | Session field is `entitlementTier`, never `tier`; no `TrustTier` type; `DATABASE_SCHEMA.md` §7.1 gets a pointer. `grantSeatStatements`' no-clobber comment already lists `trust_tier` — that stays true and now needs the disambiguating word. |
| R5 | Seeds already ship `verified = 1`; the `…0061` fixture is the `/vendor` e2e persona's anchor | §2.4. The seeds insert matching subscriptions, the per-tier back-fills ran and are deleted, and `license_mirror_drift` is the proof. |
| R6 | Every inbound reference to `profiles.id` must be cleared by the `DELETE /api/account` batch | **Closed.** `licenses.granted_by` and `billing_accounts.created_by` carry no FK, so SQLite never clears them, and the erasure batch nulls both explicitly (`apps/api/src/routes/account.ts`). The dropped `vendor_entitlements.granted_by` was an `ON DELETE SET NULL` FK, also nulled by the batch. Without the null-out an admin who ever granted a plan keeps an id on the record after erasure. |
| R7 | Lapsed-and-claimed edit lockout | §5.4 — accepted, escape hatch named, proper fix in §11. |
| R8 | Three orthogonal "take it away" actions | §5.2 table + admin UI copy. |
| R9 | `GET /api/vendors?verified=` quietly changes meaning (from "was granted a claim" to "has a paid plan") | **Closed (AECI-1266, 2026-10-12).** The public filter is retired, so it has no meaning left to change. §2.5 still forbids a public read from joining a plan table. |
| R10 | New response fields shipping as `undefined` | Make them **required** so `validateResponseInDev` catches a missed construction site (§6 point 4). |
| R11 | The 327 kB zod-chunk regression | **Closed (AECI-610).** `entitlements.ts` imports no zod and no `api/*`, enforced by a file-scoped lint rule and kept off the zod-carrying root barrel; wire schemas live in `api/vendor.ts` (§3.1 / §3.4), and the lint message names it. |
| R12 | `OBSERVABILITY.md`'s `aeci.email.send` template list is **already** stale | Fix it in §9 rather than adding two more templates to a wrong list. |
| R13 | Gating `GET /api/vendor/me` would 404 the whole dashboard and hide the renewal notice from exactly the cohort being billed | §4.3 — an acceptance criterion with a test. |

---

## 11. Out of scope / deferred

- ~~**AECI-304 — paywalled integration/version-diff depth.**~~ **SHIPPED** (2026-08-19), after AECI-303 unblocked it mid-epic. It was excluded from this epic's build order and completion criteria (§1.1) and then landed on the branch anyway; recorded here rather than promoted to a numbered section, because the gate lives in the attestations spec's §9 seam. **The hand-off sentence this bullet used to carry was wrong**: it said the gate would be "`hasCapability(...)` on the diff component only". It is not on a component and not on the reader. The gate is `canViewVersionDiff` in `packages/shared/src/version-diff.ts`, consulted at exactly **two** sites (asserted by `version-diff.consult-sites.spec.ts`): `resolveDiffAccess` (`apps/api/src/lib/pair-version-diff.ts`) and `gateHistoricalDepth` (`apps/web/src/app/products/products-pair.resolver.ts`). It forks on the **pair's two endpoint vendors' tiers** — read off the `vendors.verified` mirror via `vendorTiersFromMirror`, since §2.5 forbids a public read path from touching a plan table — and historical depth opens when **either** endpoint vendor holds `integration.version_diff`. *(As revised (AECI-1266, 2026-10-12). `gateHistoricalDepth` is deleted. `canViewVersionDiff` now has exactly **one** consult site, `resolveDiffAccess`. The web resolver trusts the API's `diff_access`. The API reads the mirror off the raw vendor row, because `VendorLink` no longer carries `verified`. See `STAGE_2_ATTESTATIONS_SPEC.md` §9.3.)* The reader invariants are unchanged and non-negotiable — **the latest-version view and the latest conflict / single-source state are always free and full-fidelity; paywall the diff, never the dispute; one-sided (paid-vs-unpaid) states are visibly labeled** — and the first of those is a labelled early return (`if (!historical) return 'full'`) that runs before any entitlement is consulted. That labeling is also the §8.1(3) attestation-bias mitigation.
- ~~**Automated billing (Stripe or similar) and self-serve card payment.**~~ **Built** with epic E9 (AECI-1339). An owner pays by card through Stripe Checkout, and webhooks own the paid subscriptions (ADR 0047). Production checkout stays off until the switch-on (`VENDOR_SIGNUP_PROCESS.md` §5 E9).
- **Pricing and a tier ladder above the entry Verified fee** — the *structure* is now data-only (§3.1); the pricing question stays open. `STAGE_2_SPEC.md` §8.8's connector carve-out is about the **entry fee only**: any rung above it is priced for connector vendors on the same terms as anyone else.
- **Dunning / renewal automation** — deferred to Stripe (E9). *Auto-lapse is no longer deferred: subscriptions lapse on their end date since AECI-1404 (§7.6).*
- ~~**Queryable term history.**~~ Settled by subscriptions. Each subscription is its own `licenses` row with its own dates, and an ended row stays as history with its `end_reason` (§2.1).
- **Per-seat plans.** A plan is per product, held by a subscription on the vendor's billing account (§13.7). Seats hold no plan. They are individually granted and individually bannable (§5.2).
- ~~**A standalone `/admin/vendors` entitlement browser** — §5 attaches the control to `/admin/claims`.~~ **SHIPPED** (AECI-652, 2026-08-27) as **§5.6**. The deferral rested on an assumption that proved false — that every vendor an operator needs to act on has a claim row to act through. A vendor that never filed one had nothing to hang the control on, which made concierge onboarding unreachable. The control did not merely gain a second home: it **moved**, so the §5.2/§5.3/§5.4 copy invariants still live in exactly one file.
- **Closing the §5.4 lockout properly** (exempt lapsed-but-seated vendors from the promote block, or add an admin vendor-edit endpoint).
- **Viewer-pays anything** — far-future, out of scope (§8.1(4)).

---

## 12. Cross-references

| Topic | Doc |
|---|---|
| Stage 2 scope, decisions, epic map | `STAGE_2_SPEC.md` (§2.2 scope, §8.1 + §8.5 decisions) |
| The portal this layers on (claim → grant → seat → `/api/vendor/*` → dashboard) | `STAGE_2_VENDOR_PORTAL_SPEC.md` (AECI-513, shipped) |
| Layer-1 Worker authz (JWT → role/ban → scope) | `AUTH_AND_RLS.md` (extended by §4/§9) |
| Endpoint request/response Zod shapes | `API_CONTRACTS.md` (§6.10, §6.14) |
| D1 schema | `apps/api/src/db/schema.ts` + `DATABASE_SCHEMA.md` (§8.6b `billing_accounts`, §8.6c `licenses`; §8.6 records the dropped `vendor_entitlements`) |
| Migration + backfill workflow | `migrations.md` (§1, §7: backfills are scripts, not migrations) |
| Transactional email | `email.md` (§7) |
| Cache-Tag purge (queue producer + tag map) | `CACHE_STRATEGY.md` (§5.3) |
| Algolia index settings — the untouchable half of the firewall | `SEARCH_RANKING.md` (§3.2) |
| Metric catalog | `OBSERVABILITY.md` (§9) |
| Lint rule-to-constraint map | `ANGULAR_STYLE_GUIDE.md` §24 (§2.1, §3.3c) |
| The version-diff seam AECI-304 gates | `STAGE_2_ATTESTATIONS_SPEC.md` §9.3/§9.4 (§11) |
| Invariant tests, and what makes one | `TESTING_STRATEGY.md` §3.6 (§10) |
| The operator console the §5.6 surface joins (IA, nav, the no-live-updates rule) | `ADMIN_PANEL_SPEC.md` §5, §9 (§5.6) |
| `audit_log` shape + the indexes the §5.6 viewer reads | `DATABASE_SCHEMA.md` §8.4 — **unchanged by AECI-652**; every read is served by an existing index |

---

## 13. Free plan (AECI-1212)

**Status: built.** AECI-1214 (§13.3, §13.4, §13.5, §13.7), AECI-1215 (§13.6), AECI-1216 (§13.8, §13.9), AECI-1217 (§13.10), AECI-1218 (§13.11 and the portal UI) and AECI-1219 (the help page `/docs/vendors/plans`) are on `main`. Plans resolve from subscriptions since AECI-1355.

The portal surfaces are in `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18. The decision record is ADR 0048 (supersedes 0037). The Stage 2.1 admission is `STAGE_2_1_SPEC.md` §3.3.3.

### 13.1 Decisions 2026-10-01

Chris made these ten decisions on 2026-10-01 in epic AECI-1212. Later rulings on decisions 2, 4, 8, 9 and 10 are folded in.

1. There is a deliberate **Free plan** state of the existing portal. It is not a separate portal.
2. **Plans and checklists live at the product level.** The vendor dashboard shows no plan card, and the vendor checklist takes the full width (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). The Products list shows a plan badge and a checklist score on each row. Each product page has its own plan panel and checklist.
3. **Company details are editable on every plan.**
4. **Product description, website, logo and categories are editable on every plan.** They feed `listing_tier`, so keeping them paid let payment raise ranking. These stay Managed-only: "How teams use it", the integrations page URL, the API docs URL, trades, audiences, phases, data-flow confirm or deny, and integrations delivered through a connector. *Integrations delivered through a connector left this list on 2026-11-09 (ruling 14, AECI-1663). Their owner manages them on every plan.*
5. **The checklist has two levels.** Vendor level: check company details, finish each product checklist, and invite a colleague. The invite step is optional. Product level: check product details, check the integration list, claim integrations or say which are not yours, and confirm data flows.
6. **The checklist is finishable on Free.** On a Free product the data-flows step is visible but optional. A Free product therefore reads "3 of 3". On Managed the step counts, so it reads "x of 4".
7. **"Looks right" is a free action on every plan.** It applies to company details, each product, and each product's integration list. It writes an audit row and stamps `last_reviewed_at`. That column already drives the public "Vendor maintained · Updated <date>" chip in `maintenance-marker.ts`. Edit schemas reject an empty save today. So "Looks right" is the only way to record "checked, nothing to change".
8. **The end of a plan lands the product on Free.** A calm banner lists what still works and what stays as the vendor left it. Nothing the vendor entered is removed. A pilot is a complimentary subscription that ends on its own date (§7.6).
9. **The portal shows one Managed price: "Managed is $25 a month or $250 a year per product."** There is no draft label and no per-vendor override (`VENDOR_SIGNUP_PROCESS.md` decision 8, §13.13). The founding discount is a Stripe coupon. A pilot is a complimentary subscription, not a coupon. The price, its terms and every discount are set in `PRICING_RULES.md` §2 and §3, and this string follows them.
10. **Each plan panel says:** "No plan changes where you rank or appear, or whether a review is published." `noPlanChangesLine()` in `apps/web/src/app/vendor/vendor-plan.ts` carries it. The marketing review dropped "or what we verify" (AECI-1265).

Two later rulings closed the epic's open questions. Both are comments on AECI-1212.

- **Ruled 2026-10-01: data-flow confirmation stays a Managed feature.** "It is not planned to become free. A Free plan includes only the most basic product information."
- **Ruled 2026-10-01: screens first (option A).** "The per-product screens ship before per-product plans exist in the database." Every product-scoped response carries "this product's plan". Per-product plans landed with subscriptions (AECI-1355), and §13.7 governs.

### 13.1a Search-engine submission is Managed-only (AECI-1186)

- **Ruled 2026-09-29 (recorded on AECI-1160):** IndexNow submission is a Managed-only benefit.
- **Ruled 2026-10-02 (decision 4 of epic AECI-1182):** the Google worklist is Managed-only too. A Free vendor's write queues nothing for `/admin/reindex`.
- A Free vendor's edit still commits, purges the cache and moves the sitemap `<lastmod>`. Search engines can still find the change on their own schedule.
- Promote and AECi admin writes are not plan-gated. They are AECi's own work, not a vendor benefit.
- The copy says "submitted" or "told search engines", never "indexed" or "ranked". No plan changes where a page ranks or appears (decision 10, §3.2).
- **Ruled 2026-10-14 (AECI-1355):** submission is per product, like every other Managed right. A write on a product queues only when that product holds a live subscription on the writing vendor's own billing account. A company profile edit stays vendor-level.
- §3.3(d) has the mechanism.
- **Ruled 2026-10-04 (decision 3 of epic AECI-1182):** reading the history is not gated. `GET /api/vendor/recrawl-submissions` (AECI-1187, `API_CONTRACTS.md` §6.14) answers every seat, so a Free vendor sees an empty list or the rows from a period when it held a plan. Reads are never gated (§4.3).

### 13.2 Plan model

- "Free" is the existing `unclaimed` tier. It is renamed in copy only.
- `TIERS` stays `['unclaimed', 'verified']`. There is no `free` tier id, so there is no migration and no change to the §3.2 firewall vocabulary.
- "Managed" is the copy name for the `verified` tier.
- Free is never a subscription. A product with no live subscription on the payer's billing account is Free (`productTier`). A vendor with no live subscription resolves to Free (`sessionPlanFromLicenses`). Both are AECI-1355.
- A subscription that ends puts its product on Free. `tierFor` maps `expired` and `revoked` to `unclaimed`. That is decision 8. A subscription a ban ended (`end_reason = 'banned'`, AECI-1589) reads as `revoked`, so the plan status is `revoked` and the product is Free.

### 13.3 Registry split

Two capability ids are added. `unclaimed` stops being empty. *(Amended 2026-11-03, AECI-1590: `unclaimed` also holds `review.reply`, so Free holds four ids.)*

| Capability | Fields | Tier |
|---|---|---|
| `profile.edit` | all company details | moves to `unclaimed`, so every seat holds it |
| `product.listing.edit`, new | description, website, logo | `unclaimed`, so every seat holds it |
| `product.categories.edit`, new | `category_slugs` | `unclaimed`, so every seat holds it |
| `product.edit` | integrations page URL, API docs URL | `verified` |
| `product.taxonomy.edit` | trades, audiences, phases | `verified` |
| `product.usefulness.edit`, `attestation.author`, and the rest | unchanged | `verified` |
| `review.reply`, new (AECI-1174) | a public reply to a review, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c | `unclaimed`, so every seat holds it. `verified` only until 2026-11-03 (AECI-1590) |

`verified` keeps every capability. Existing ids keep their names, so audit rows and the shipped UI keep their meaning. Neither new id contains a word from `PLAN_SHAPED` in `entitlements.spec.ts`.

Connector catalogue seats get the Free edits too: they hold no live subscription, so they resolve to `unclaimed` like any other seat with no subscription (ruled by Chris 2026-10-02, because decisions 3 and 4 say "every plan").

What changes in code, all in AECI-1214:

- `PATCH /api/vendor/products/:id` drops its route-level `requireCapability(c, 'product.edit')`. Each field is gated through `PRODUCT_COLUMN_MAP` and `splitPatch()`. A request naming any field the caller cannot edit is still refused whole.
- The facet gate splits. `category_slugs` checks `product.categories.edit`. Trades, audiences and phases keep `product.taxonomy.edit`.
- The logo upload route gates on `product.listing.edit` or `profile.edit`. Today it checks `product.edit` and falls back to `profile.edit`.
- The frozen-vocabulary test grows from eight ids to ten.

> **As built (AECI-1214 — 2026-10-02).**
>
> - The field → capability tables are `VENDOR_FIELD_CAPABILITIES` and `PRODUCT_FIELD_CAPABILITIES` in `packages/shared/src/entitlements.ts`. They moved out of the API so the §13.4 test can read the same table the routes enforce. `apps/api/src/routes/vendor.ts` builds `VENDOR_COLUMN_MAP` and `PRODUCT_COLUMN_MAP` from them. `vendor.entitlement.spec.ts` asserts the tables' keys equal the `Update*Schema` keys, because the shared module may not import zod.
> - The product PATCH runs one per-field gate, `assertFieldsEntitled`, after `requireOwnedProduct` and before any taxonomy read. It covers columns and the four facet arrays. The separate taxonomy and usefulness `requireCapability` calls are gone. A denied facet carrying an unknown slug answers 403, not 400.
> - The 403 for a refused field is `ENTITLEMENT_REQUIRED` with `details: { capability, tier, fields }`. `fields` lists every denied field, sorted. `capability` is the first one's.
> - `PATCH /api/vendor/profile` keeps `requireCapability(c, 'profile.edit')`. Every real tier passes it now.
> - The logo upload checks `product.listing.edit`, then falls back to `profile.edit`. Only a tier the build does not know is refused.

**A move between plans is a Plans version (AECI-1619, 2026-11-11, counsel ruling 16).** Moving a capability between `unclaimed` and `verified` in `TIER_CAPABILITIES`, or changing `MANAGED_LIST_PRICE_CENTS` or `MANAGED_ANNUAL_PRICE_CENTS`, changes the comparison table and prices on `/docs/vendors/plans`. That page is versioned, because a checkout or grant acceptance records its version and snapshot hash (`DATABASE_SCHEMA.md` §8.6d). So the same change must bump the Plans version and write a new snapshot (`STAGE_2_PRODUCT_DOCS_SPEC.md` §4). `plans-snapshot.spec.ts` fails until it does. Taking a capability out of Managed may also make the Managed plan agreement's core-inclusions sentence false (`LEGAL_IMPACT_REVIEW.md` §3).

### 13.4 Firewall rule

**No `listing_tier` input may need a plan to edit.** This joins §3.2 as a fifth assertion in `entitlements.spec.ts`. The test maps each `listing_tier` input to the capability its column map names. It then checks that capability is in `TIER_CAPABILITIES.unclaimed`.

| Input list | Input | Capability |
|---|---|---|
| `PRODUCT_LISTING_TIER_INPUTS` | `name` | not vendor-editable, listed as such |
| | `description`, `website`, `logo_url` | `product.listing.edit` |
| | `categories` | `product.categories.edit` |
| `VENDOR_LISTING_TIER_INPUTS` | `company_name` | not vendor-editable, listed as such |
| | `description`, `headquarters`, `website`, `logo_url` | `profile.edit` |

Payment can then no longer raise a product's rank through the edit path. That is the leak decision 4 closes.

**The caption columns are in the firewall too (AECI-1614).** `apps/api/src/lib/ranking-firewall.spec.ts` bars both plan-end mirrors (`plan_ended_at`, `managed_ended_at`) and all five edit stamps (`description_edited_at`, `profile_edited_at`, `usefulness_edited_at`, `managed_edited_at`, `vendor_edited_at`) from the ranking inputs. A vendor whose plan is live, or who edits more, must never rank higher.

### 13.5 The §3.1 revisit trigger, answered

§3.1 said to reopen the integration-capability question if "a seated vendor can exist without a subscription and still own integrations it manages". That now exists by design. A seat with no plan owns integrations through the seat-gated routes. Connector-powered rows kept their named entitlement exception from AECI-1040 until ruling 14 (Chris, 2026-11-09, AECI-1663) retired it; a seat alone is the gate on those rows too, on any plan. No integration capability is added.

**Re-answered 2026-11-11 (AECI-1653).** The trigger's second case fired in full when AECI-1367 (2026-10-15) made every claim approval land on Free (§13.6): the seat grant stopped being a commercial control, because the grant's batch writes no subscription. Ruling 14 then dropped the payer test's second clause (`STAGE_2_SPEC.md` §8.10(1)(b)) and accepted the free-seat hole by design — "Managing an owned integration needs a seat, not a payment. Any seat may manage, a §8.9 catalogue-maintenance seat included." — because correcting a listing must never be something a vendor buys. The answer stands: no capability check on integration ownership routes; a seat is the whole gate, on any plan. Only the trigger's first case remains live, a rung added above `verified` ("The revisit trigger above stands for tiers in general", §3.1's withdrawal note).

### 13.6 Claim approval with no plan

Every claim approval lands on Free (AECI-1367, E3.4, `VENDOR_SIGNUP_PROCESS.md` decisions 2 and 4). `PATCH /api/admin/claims/:id` approve takes no `plan` and no `entitlement`, and a body naming either is `400 VALIDATION_FAILED` on that field.

The approval's batch writes:

- the seat, an owner seat when the vendor has no unbanned owner;
- the vendor's billing account, one per vendor;
- the claim's terms acceptances, linked to the seat, the vendor and the billing account;
- `vendors.owned_at` (AECI-1415, ADR 0042).

It writes no subscription and flips no `vendors.verified`, and it purges nothing, because no cacheable page renders a seat. The AECI-989 seat return reads the vendor's real subscriptions. A paid plan is bought later as subscriptions. The email is `claim-approved`, and `email.md` has the copy. Contract: `STAGE_2_VENDOR_PORTAL_SPEC.md` §3.2.
#### 13.6.1 As built (AECI-1215 — 2026-10-02; superseded 2026-10-15 by AECI-1367, see §13.6)
Retired 2026-10-15 (AECI-1367). The Free or Managed choice on approval and its `plan` field are gone, and §13.6 states the approval.

### 13.7 Per-product plan field

Each product carries its own plan (the field is AECI-1214, the source is AECI-1355, E1.6).

- `VendorProductSchema.plan` is a `VendorEntitlementBlock` built from that product's own subscription: `entitlementBlock(session, productId)`, through `productPlan` in `apps/api/src/lib/authz.ts`. It is `verified` / `active` with the subscription's `ends_at` while a subscription is live on the product. It is `unclaimed` with the latest ended subscription's status and dates once that subscription ended. It is `unclaimed` with no term if the product never held one. `productId: null` builds the vendor block for the `entitlement` on `GET /api/vendor/me`.
- Server enforcement is per product. A write on one product gates on that product's tier (`requireProductCapability`, `productTier`, §3.3(a)). The field and the gate read the same session data, so they cannot disagree.
- A co-owned product is Managed only for the vendor whose billing account holds its subscription. The other owner reads `unclaimed` with a null term (ruled 2026-10-14).
- The web uses `productCan(product, cap)` in `apps/web/src/app/vendor/vendor-capabilities.ts`. Product screens call it per field on their own `product` input and never read `me().entitlement` directly. The vendor overview reads `vendorCan(store, 'product.listing.edit')` for its product gap rows, because it is a vendor screen.
- The integration detail page reads the endpoint product's `plan` through `integrationCanAuthor`, for the 2026-10-14 attestation ruling. The Integrations tab widens its gate per row with the same function. The checklist scores each product on its own plan.
- `withProductPlans` in `vendor-fixtures.ts` is the all-subscribed fixture. `API_CONTRACTS.md` §6.14 has the wire shape.

### 13.8 "Looks right"

Three routes. Each is seat-only. Each registers `requireVendor()` then `rateLimit('write')`. The `write` binding already exists in all five env blocks. AECI-1216 builds them.

| Route | Stamps | Audit action | Purge tags |
|---|---|---|---|
| `POST /api/vendor/profile/review` | `vendors.last_reviewed_at`, `maintained_by = 'vendor'` | `vendor.reviewed` | `vendor:{slug}` |
| `POST /api/vendor/products/:id/review` | the same columns on `products` | `product.reviewed` | `productEditTags()` |
| `POST /api/vendor/products/:id/integrations/review` | see §13.9 | `product.integrations_reviewed` | `product:{slug}` and each stamped `integration:` tag |

- Company and product transfer maintenance exactly as an edit does. That is `STAGE_2_ATTESTATIONS_SPEC.md` §13.9.
- Each audit row goes in the same `db.batch` as the stamp, built with `auditInsert`.
- The post-commit forward goes through `afterVendorWrite`.
- There is no IndexNow recrawl, because no content changed. That keeps these routes clear of AECI-1186.
- The two product routes check ownership first. A product the vendor does not own answers 404.

Every pair page embeds both of its products, so the `product:{slug}` tag also purges the pair pages that show a stamped integration's chip.

> **As built (AECI-1241 — 2026-10-08).** The "Looks right" strip at the head of company Profile, product Profile and product Integrations now shows only for a step that was not done when the page loaded. Chris ruled it: a vendor who checked a step long ago comes back to change things, and a permanent strip is noise to them.
>
> - **Not done at load.** The strip shows. After a press it stays for the rest of that view and reads "Checked". It does not vanish when the checklist refetch flips the step to done.
> - **Done at load.** No strip. The next visit to a page the vendor just checked is this case, because `VendorPortalStore` keeps the refetched checklist.
> - **Checklist not loaded yet.** Nothing renders, so a checked page never flashes the strip.
> - **The decision is per record.** A product page reused for another product decides again from that product's checklist.
>
> The same rule covers the "Looks right" button on the product checklist card on a product's Overview (Chris, 2026-10-08). A row whose step was done when the card first saw it shows no button. A row pressed in this view keeps the button and reads "Checked" until the vendor leaves. The row itself and its "Open Profile" link always render. A done row's body says it is checked and that an edit records a later check, so it never tells the vendor to press a button that is not there. The vendor checklist's company row does the same (`checklist-rows.ts`).
>
> The rule is `latchReviewDecisions` in `apps/web/src/app/vendor/components/vendor-review-strip.ts`. It is a `linkedSignal` latch: it records a decision the first time a step's state is known for a record, then holds it. The strips call it through `reviewStripShown`. The card calls it once per row, keyed by target and product. The routes are unchanged.
>
> The accepted consequence is that a checked step offers no re-stamp anywhere in the portal. A vendor moves the public "Updated" date on a checked record only by saving an edit.

### 13.9 Integration-list stamp scope

The third route stamps only rows this vendor already maintains.

- It stamps `integrations` and `connector_evidenced_pairs` rows touching the product where `maintained_by = 'vendor'` and `built_by_vendor_id` is the session vendor.
- It never stamps a row AECi maintains or another vendor's row. So maintenance never moves through this route. `STAGE_2_ATTESTATIONS_SPEC.md` §13.9 is the rule it keeps.
- It runs one set-based `UPDATE` per table and writes one audit row keyed to the product. The stamped ids go in the audit metadata.
- It also stamps a new `products.integrations_reviewed_at` column. So the checklist step completes even when the vendor maintains zero rows.

That column is the epic's only migration. It is an additive `ADD COLUMN` with no table recreate. `docs/migrations.md` §0 says why a recreate is unsafe.

#### As built (AECI-1216 — 2026-10-02)

The three routes are in `apps/api/src/routes/vendor-review.ts`. The migration is `0053_blushing_crystal.sql`, one `ALTER TABLE products ADD COLUMN`. The wire contract is `API_CONTRACTS.md` §6.14. Decisions taken at build that §13.8 and §13.9 did not fix:

- **"Touching the product" includes the connector arm.** A row qualifies when the product is either endpoint, or the connector that powers it (`integrations.powered_by_product_id`, `connector_evidenced_pairs.connector_product_id`). A connector's page lists those rows, so they are on its integration list.
- **Retired rows are not stamped.** They are off the public list, so there is no list entry being confirmed.
- **The ids are read before the batch.** The audit row must name them and is built before the batch runs. Each UPDATE repeats the full rule and also pins the ids it read. So a row that changes hands in between is skipped, and no row is ever stamped without being audited.
- **The body is `{}` or nothing, and refuses any key.** The edit schemas strip unknown keys. This one is `.strict()`, so an edit sent here by mistake is a 400 rather than a stamp that drops it.
- **The product route purges `productEditTags()` with no facet change.** That is `product:{slug}` and `index:products`. It skips the four facet reads an edit needs, because no browse page gains or loses the product.
- **`metadata.reason = 'looks-right'`** on all three audit rows, so one grep finds them. `maintenanceTransfer: true` appears only on the save that changes hands, as on every other writer.
- **The cursor moves with no new code.** Each stamp moves `updated_at` on the rows it writes, which the `profile`, `products` and `integrations` scopes of `GET /api/vendor/updates` already read.

### 13.10 Checklist steps

Every step derives from existing records plus the §13.9 column. There is no progress table. AECI-1217 serves them.

| Level | Step | Done when | Counts on |
|---|---|---|---|
| Vendor | Check company details | `vendors.maintained_by = 'vendor'` and `last_reviewed_at` is set | all plans |
| Vendor | Finish each product checklist | every owned product is complete | all plans |
| Vendor | Invite a colleague | a second seat exists, or any `vendor_seat_invites` row | optional |
| Product | Check product details | `products.maintained_by = 'vendor'` and `last_reviewed_at` is set | all plans |
| Product | Check the integration list | `products.integrations_reviewed_at` is set | all plans |
| Product | Claim or say "not ours" | no seeded row naming this vendor as builder is unclaimed without an open `owner` contest, or an accepted one that still names this vendor as builder | all plans |
| Product | Confirm data flows | every claim on the product's integrations has a non-retracted attestation by this vendor | counts on Managed, optional on Free |

The score rule:

- A Free product reads "3 of 3". The data-flows step shows but does not count.
- A Managed product reads "x of 4".
- A step with nothing to do counts as done.
- "Ever checked" is enough. Staleness is out of scope.

The two reads are `GET /api/vendor/checklist` and `GET /api/vendor/products/:id/checklist`. They are batched, with no per-product round trip. They are reads, so they are never rate-limited.

#### As built (AECI-1217 — 2026-10-02)

The handlers are in `apps/api/src/routes/vendor-checklist.ts`. The step rules are pure functions in `apps/api/src/lib/vendor-checklist.ts`. The wire contract is `API_CONTRACTS.md` §6.14, "Checklist". Decisions taken at build that the table above did not fix:

- **Each step carries `status` and `counts`.** `status` is `done`, `todo` or `optional`. A finished step reads `done` even when it does not count. So a Free product with no claims shows "Confirm data flows" as done, and still scores 3 of 3.
- **"Confirm data flows" counts when the product's `plan.capabilities` holds `attestation.author`.** It reads the product's plan block, never the vendor's.
- **"Claim or say not ours", row by row.** A row counts against a product when it is in either table, is live, has `origin = 'aeci'`, names the vendor in `built_by_vendor_id`, has no `claimed_at`, and touches the product. "Touches" is the §13.9 arm: either endpoint, or the connector that powers it.
- **"Without an owner contest" means an OPEN `owner` contest, or an ACCEPTED one (AECI-1225, ruled 2026-10-05).** A declined contest leaves the row on the vendor, so the row counts again. An accepted contest counts only while its `owner_vendor_id` is still the row's `built_by_vendor_id`. It stops counting once promote re-points the builder, because the row then names another vendor and no longer counts against this one. Either kind answers the step whoever filed it. That includes another endpoint vendor's contest, so "accepted from another vendor too" is deliberate. The named owner can now file one itself: `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.2 lets it self-disclaim on a seeded, unclaimed row. **This closed the gap this bullet used to record**, where the step named a "say not ours" action the owner had no route for. The portal's "Not ours?" control (§6.18 of that spec) is the route.
- **A connector-powered row counts on every plan (ruling 14, 2026-11-09, AECI-1663).** Every evidenced pair is connector-powered. *From AECI-1089 it counted only when `plan.tier !== 'unclaimed'`, because the claim route refused such a row without an active entitlement and decision 6 forbids an unfinishable step. The claim is open on Free now, so `canClaimConnectorPowered` is gone. On deploy every Free product's claim step started counting its unclaimed connector-powered rows, and the step can grow for a Free vendor.*
- **"Confirm data flows", claim by claim.** It reads claims on live `integrations` rows where the product is an endpoint. The answer must be a live attestation whose `attested_by_vendor_id` is the vendor. A denial is an answer, so it counts. Claims on connector-powered rows are skipped, because nobody may attest them (AECI-705). Evidenced-pair and reach-anchored claims are skipped for the same reason.
- **"Invite a colleague"** is done at two or more `vendor_admin` seats (the `seatsOf` predicate), or at any `vendor_seat_invites` row, revoked and expired ones included.
- **Batching.** The vendor read is seven SELECTs in one `Promise.all` wave. The three per-product fact reads scope by the `ownedProductIds` subquery, not a bound id list. A bound list would meet D1's 100-parameter cap near 33 products. `vendor-checklist.spec.ts` asserts the statement count is the same for 2 and 12 products. The product read is the ownership wave plus the same three reads scoped to one id.
- **The §13.9 predicates are not reused.** `ownedMaintainedIntegrationsWhere` selects rows the vendor already maintains. The claim step needs the opposite set, rows not yet claimed. Only the "touches the product" arm is shared, and it is restated for a product set.
- **No new cursor scope.** `STAGE_2_REALTIME_SPEC.md` §2.3 records which scopes the checklist refetches on.

### 13.11 Pilot-ended banner

The vendor-wide banner shows when the vendor held a subscription and none is live now. It never shows for a vendor that never held one.

The session keeps the two apart. `VendorEntitlementBlock.status` is `null` for a vendor that never held a subscription. Once no subscription on the vendor's billing accounts is live, the latest ended subscription decides. Its end reason `revoked` or `banned` (AECI-1589, written by Terminate since AECI-1623) gives `revoked`, and any other end (`lapsed`, `released`) gives `expired`. Its `ended_at` fills the date line (AECI-1355). The guard reads that latest ended subscription on every request, so the banner needs no extra query. §8.1's `ended` and `free` panel states use the same split.

- The banner is `apps/web/src/app/vendor/components/vendor-plan-ended-banner.ts`, rendered by the shell above the tabs on every portal page. Its rule is `planHasEnded` in `vendor-plan.ts`.
- It is not dismissible, because it states the current state.
- Its heading is "Your Managed plan has ended". It lists what still works and what is "Read-only now", and says ending a plan removes nothing you entered (decision 14, AECI-1395, reworded AECI-1618 on 2026-11-05). `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18 records the copy.
- An owner seat's button is "Go to Billing", to the Billing tab. A member keeps "Talk to us about Managed" on `/contact`, because a member cannot open Billing (AECI-1408).

**Product-ended banner (AECI-1408).** A vendor that keeps Managed on other products gets a banner per product instead. It is `vendor-product-ended-banner.ts`, under the product header. It shows when that product's `plan` is `ended` and its `ended_at` is within the last 90 days (`PRODUCT_ENDED_BANNER_DAYS`). "Go to Billing" goes to the Billing tab, for an owner seat only. A member sees no button. When the vendor-wide banner shows, the product banner is hidden, so a vendor never sees two. `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18 has the rule and the copy.

### 13.12 Sub-issue map

| Issue | Scope | Governed by |
|---|---|---|
| AECI-1213 | This section, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18, ADR 0048 (supersedes 0037), `STAGE_2_1_SPEC.md` §3.3.3 | §13.1 |
| AECI-1214 | Seat-level edit of company details and the four `listing_tier` fields, plus the per-product `plan` field | §13.3, §13.4, §13.5, §13.7 |
| AECI-1215 | Claim approval with no plan | §13.6 |
| AECI-1216 | The three "Looks right" routes and the one migration | §13.8, §13.9 |
| AECI-1217 | The checklist API | §13.10 |
| AECI-1218 | The portal UI | §13.11 and `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18 |
| AECI-1219 | The vendor help center page, shipped as `/docs/vendors/plans` | §13.1, §13.2 and `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18 |

### 13.13 Plan price overrides (ruling 2026-10-08)

Retired 2026-10-17 (AECI-1357, AECI-1375, `VENDOR_SIGNUP_PROCESS.md` decision 8). Per-vendor price and message overrides are gone, with `PUT /api/admin/vendors/:id/plan-pricing`, the `vendor_plan_pricing` table (migration 0081) and the admin "Plan price" section: every vendor sees "Managed is $25 a month or $250 a year per product." from `planPriceSentence(locale)` in `apps/web/src/app/vendor/vendor-plan.ts`, the founding discount is a Stripe coupon, and a pilot is a complimentary subscription.

---

*This is the build contract for the paid tiers, kept current with the code as of 2026-10-28 (E10, AECI-1340, `VENDOR_SIGNUP_PROCESS.md`). As each build issue lands, add its "As built (AECI-N, date)" note to the section it governs. The file and line references in §1.3, §2 and §6 are anchors, not guarantees. Verify them before editing the cited files.*
