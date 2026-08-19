# AEC Integrations — Stage 2 Paid Tiers & Entitlements Specification

**Version:** 0.1 — **build contract** (the decomposition of the AECI-515 epic)
**Date:** August 2026
**Status:** Build contract — promotes `STAGE_2_SPEC.md` §2.2 from scope outline to a buildable spec. Decisions resolved at the 2026-08-14 epic review (see `STAGE_2_SPEC.md` §8.5).
**Supersedes:** the entitlement/billing portions of `STAGE_2_SPEC.md` §2.2 and the two open items in §8.2 (that section stays the scope outline; this doc is the contract each sub-issue anchors to). Also supersedes `STAGE_2_VENDOR_PORTAL_SPEC.md` §8.3(1)'s "`vendors.verified` **is** the launch entitlement bit … no new schema" — that was the AECI-513 launch shape and this epic is the successor it named.
**Inherits from:** Stage 1 (`STAGE_1_SPEC.md`), Stage 1.5 (`STAGE_1_5_SPEC.md`), and — critically — the **Vendor Portal build contract** (`STAGE_2_VENDOR_PORTAL_SPEC.md`, AECI-513, all sub-issues shipped 2026-07-25). Every seam this epic extends was built there.
**Companion docs:** `AUTH_AND_RLS.md` (Layer-1 Worker authz — §4), `API_CONTRACTS.md` (endpoint shapes — §5), `DATABASE_SCHEMA.md` (tables — §2), `migrations.md` (the one migration — §2.3), `email.md` (Resend — §7), `CACHE_STRATEGY.md` (Cache-Tag purge — §5.3), `SEARCH_RANKING.md` (the ranking firewall — §3.2), `OBSERVABILITY.md` (metrics — §9).

> **Data-layer note (ADR 0016 / 0017).** The application database is **Cloudflare D1 + Drizzle**; Supabase is **auth-only**. Every write in this spec goes through `getDb(env)` and, for multi-statement writes, a single `db.batch([...])` that includes its `audit_log` row (the §26.1 invariant of `STAGE_1_SPEC.md`). There is **no Prisma, no Postgres, no RLS on app tables** — authorization is the **3-layer Worker model** in `AUTH_AND_RLS.md`. **D1 has no interactive transactions**, which is not a footnote here: it is the single constraint that determines the entitlement table's shape (§2.1).

---

## 1. Overview & the launch model

**Stage 2 is where the vendors log in; this epic is where they pay.** AECI-513 shipped the portal — claim → grant → seat → `/api/vendor/*` → dashboard → verified badge. It deliberately shipped **no entitlement model**, using `vendors.verified` as a stand-in bit and recording the offline PO/invoice arrangement as free text in `audit_log.metadata`. This epic replaces the stand-in with the real thing.

**The trust invariant is unchanged and non-negotiable: no pay-for-placement.** Entitlements gate **profile richness and portal capability only** — never ranking, placement, or badge trust. Search stays purely algorithmic (`STAGE_1_SPEC.md` §1 principles; `CLAUDE.md` constraints). In this epic that invariant stops being a documented promise and becomes an **asserted property** (§3.2).

**The launch model stays concierge (`STAGE_2_SPEC.md` §8.1).** Vendors pay, always. Offline invoice/PO only — no payment provider, no self-serve card. An admin records the arrangement and toggles the entitlement by hand. It deliberately does not scale.

**What "free" means, precisely.** The free/default state is the **unclaimed, AECi-curated baseline** — the full Stage 1/1.5 directory entry, free to read, rendering no verified badge. Paying buys the vendor the ability to *act* on their own record. It buys the reader nothing and costs the reader nothing.

### 1.1 Issue map & critical path

This doc is the contract for the AECI-515 sub-issues. Each opens with `**Spec section:** docs/STAGE_2_PAID_TIERS_SPEC.md §X` per the `spec-anchor` convention. **The subsection numbering below is load-bearing — do not renumber without updating the issues.**

| Anchor | Issue | Surface |
|---|---|---|
| §2 | AECI-609 | `vendor_entitlements` schema + the `vendors.verified` mirror and its two guards |
| §3 | AECI-610 | Capability registry + the ranking firewall |
| §4 | AECI-611 | The entitlement gate — tier on the session, `requireCapability()`, the field allow-list |
| §5 | AECI-532 | Admin entitlement action — set / renew / clear (re-scoped at this review) |
| §6 | AECI-612 | Claim-grant integration — the AECI-519 refactor |
| §7 | AECI-613 | Term expiry — warn, never auto-lapse |
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

§3 is the one that can start immediately with zero dependencies — pure data, no schema. §2 and §3 are the critical path; everything else fans out. §5 and §6 are genuinely parallel (one adds a route, the other edits `admin-claims.ts`); they share only `lib/vendor-entitlement.ts`, which §2 ships.

**Explicitly NOT in the build order: AECI-304** (paywalled integration/version-diff depth). It stays parented to this epic because the *decision* is a Paid-Tiers decision, but it is **blocked by AECI-303** (the version-diff timeline), which is unbuilt — the `attestations.introduced_at` / `deprecated_at` stamps are dormant data with **zero web consumers** (verified 2026-08-14: no timeline UI exists anywhere in `apps/web`). **AECI-304 is excluded from this epic's completion criteria.** What this epic does for it is mint the `integration.version_diff` capability id (§3.1) so that once AECI-303 exists, AECI-304 reduces to a render-path gate and nothing else. See §11.

### 1.2 Schema readiness — ONE migration required

This is the deliberate contrast with `STAGE_2_VENDOR_PORTAL_SPEC.md` §1.2 ("no migration required"). AECI-513 could ride entirely on the §18 reserved hooks; this epic cannot, because there is no reserved entitlement table. **§2 ships migration `0019_easy_sandman`** — generated by `pnpm db:generate`, applied by `wrangler d1 migrations apply` (`docs/migrations.md`; never `drizzle-kit migrate`/`push`). It generated as `0006_*` and was renumbered **twice**: to `0018` in AECI-622, because `main` had independently taken `0006`–`0015`; then to `0019`, because the AECI-514 epic landed `0016`/`0017` **and** `0018_chilly_joseph`. `migrations.md` §0 "Renumbering a migration" is the procedure, and §0 "Reserved numbers" records the collision history.

**One migration, and only one.** Everything downstream of §2 must be additive-with-no-DDL. Two closed vocabularies decide whether that holds, and **both are settled in §2, not discovered later**:

| Closed CHECK | Decision |
|---|---|
| `workflow_instances_type_check` (`schema.ts` ~:657-659) — `('vendor_claim','review_moderation','correction_request','reviewer_ban')` | **Do not open it.** Entitlement changes write **no** `workflow_instances` row (§2.4). A closed CHECK change on SQLite is a full table rebuild; discovering the need at §5 would cost a second migration after `0018` merged. |
| `audit_log_actor_type_check` (`schema.ts` ~:690) — `('user','admin','system','workflow')` | **Sufficient as-is.** Admin entitlement writes use `actor_type: 'admin'`; the §7 cron uses `'system'`. |

`audit_log.entity_type` is **deliberately unconstrained** (schema comment ~:715-718), so `entity_type: 'vendor_entitlement'` costs nothing.

### 1.3 What already exists (reuse, don't rebuild)

| Asset | Location | Used by |
|---|---|---|
| The reversible-flag admin handler template (nine moves: preload gate → guardrail → 422 idempotency gate → derive from/to → build audit entry → one `db.batch` with a **guarded** `UPDATE … WHERE <current state>` → metric → post-commit `waitUntil` forwards → `validateResponseInDev`) | `createBanReviewerHandler`, `apps/api/src/routes/admin-reviewers.ts` ~:173-304 | §5 |
| Pure batch-builder module contract (returns statements + forwarding entries, executes nothing) | `apps/api/src/lib/vendor-grant.ts` | §2, §6 |
| The offline-arrangement contract | `ClaimEntitlementSchema`, `packages/shared/src/api/admin-claims.ts` ~:29-36 | §2, §5 |
| The grant's purge tag set (`vendor:{slug}` + every owned `product:{slug}` + `index:products`) | `grantPurgeTags`, `apps/api/src/routes/admin-claims.ts` ~:246-255 | §2 (promoted to a shared module), §5 |
| Audit/workflow batch builders | `auditInsert` / `workflowTransitionInsert`, `apps/api/src/lib/audit.ts` ~:42-68 | §2, §5, §7 |
| The ranking freeze that already makes half the firewall true | `packages/shared/src/algolia.spec.ts` ~:242/:262/:274 (per-entity `customRanking` frozen to its exact Stage-1 value) and ~:283-291 (regex over the union of `searchableAttributes ∪ attributesForFaceting ∪ customRanking`) | §3.2 |
| The email route-seam pattern (route declares a `Send*Email` type + no-op default as a factory param; `email.ts` exports a structurally-typed adapter; `index.ts` injects the real one) | `apps/api/src/routes/admin-claims.ts` ~:100-113 + `apps/api/src/lib/email.ts` ~:327-350 | §7 |
| Inline (queue-less) cron precedent — `queueForJob` returns `undefined`, so the job always runs in the `scheduled` handler | `MODERATION_CRON = '0 6 * * *'`, `apps/api/src/scheduled.ts` ~:135-137 | §7 |
| The daily data-quality check suite (report-only; each check is a pure async fn over an injected `Db`, emitting the `aeci.data_quality.check` gauge) | `apps/api/src/lib/data-quality.ts` | §2.1 |
| The launch-minimum entitlement readout, explicitly flagged for replacement here | ~~`apps/web/src/app/vendor/components/vendor-verified-status.ts`~~ — **deleted by §8**; the successor is `vendor/components/vendor-plan-panel.ts` | §8 |

**What does NOT exist yet** (the net-new work): the `vendor_entitlements` table, `lib/vendor-entitlement.ts`, `packages/shared/src/entitlements.ts`, the `ENTITLEMENT_REQUIRED` error code, any entitlement field on `AuthenticatedSession`, any HTTP surface that can **clear** `vendors.verified`, and any billing/expiry email.

---

## 2. The entitlement model — `vendor_entitlements` + the `vendors.verified` mirror (AECI-609)

**The shape of the problem.** `vendors.verified` is read in five places that all ship and all render: the public `GET /api/vendors?verified=` filter (`apps/api/src/routes/vendors.ts` ~:47), `VendorLinkSchema.verified` (`packages/shared/src/api/common.ts` ~:48-51, embedded in product / integration / pair payloads), `VendorDetail.verified` / `VendorListItem.verified`, the Algolia vendor record (AECI-529), and `aec-verified-badge`. Any design that changes what those readers query is a large, risky diff.

**So they don't change.** A new `vendor_entitlements` table carries the real model; `vendors.verified` is demoted to a **denormalized mirror** of it, maintained inside the same `db.batch([...])` as every entitlement write. Every existing reader keeps reading the mirror and is untouched by this epic (§2.4).

### 2.1 The mirror invariant, and its two mechanical guards

> **The mirror invariant.** `vendors.verified = true` **iff** the vendor has a `vendor_entitlements` row with `status = 'active'`. Because `vendor_entitlements.vendor_id` is **UNIQUE**, that predicate is a single-row test — and every statement that can move either side of the *iff* is emitted by one module, `apps/api/src/lib/vendor-entitlement.ts`, which never emits one side without the other. **No route handler writes `vendors.verified` directly.**

**Why UNIQUE, i.e. why one row per vendor and not a period-history table.** The invariant has to be expressible as a **guarded single-row `UPDATE`** so the write is safe under concurrency. D1 has no interactive transactions, so read-then-write is a race with no available fix. With one row per vendor the predicate is `status = 'active'`, which is a legal `WHERE`. With history rows it becomes `MAX(period_end)` / `is_current` over N rows — not a predicate you can put in a `WHERE`, and the mirror flip degrades into exactly the race there is no tool to fix.

Three supporting reasons: **`audit_log` already is the history ledger** (every mutation writes its row in the same batch per §26.1, and `audit_log_entity_idx` is `(entity_type, entity_id, created_at)`, so `entity_type='vendor_entitlement', entity_id=<vendor_id>` yields the full grant/renew/lapse trail with zero new indexes and zero new read paths); **the invoice is not the system of record** (offline PO means the accounting system holds the money ledger — this table records the *arrangement*); and **read cost** (the §4 gate reads this row on every `/api/vendor/*` request; a history table puts an aggregate on the hot path).

*Accepted trade-off:* if finance later wants a queryable term history, add an append-only `vendor_entitlement_periods` child table. That is purely additive and changes no reader, because per §2.4 no reader ever touches entitlement tables at all.

**Guard 1 — compile-time (sole-writer lint).** An ESLint `no-restricted-syntax` rule rejecting a Drizzle `.set({ verified: … })` on `vendors` anywhere outside `apps/api/src/lib/vendor-entitlement.ts`. AECI-549 (commit `c91f2fa6`) established exactly this mechanism for the other non-negotiables, and `ANGULAR_STYLE_GUIDE.md` §24 is the rule-to-constraint map this new rule joins — so it is a rule addition, not a new mechanism.

**Guard 2 — run-time (drift check).** A new check in `apps/api/src/lib/data-quality.ts`, run by the existing 04:00 UTC cron: `id: 'entitlement_mirror_drift'`, `severity: 'error'` — the count of vendors where `verified = 1` XOR an `active` entitlement row exists. It emits the existing `aeci.data_quality.check` gauge, so it needs no new metric and no new monitor plumbing, and it lands in the daily digest. This is the guard that catches what lint cannot: hand-written D1 SQL against a tier, the `apps/datatool` worker (which binds all four tiers and can write prod D1), and — the likely one — a backfill that ran on staging but not demo (§2.3).

### 2.2 The table

Lands in the "Operations and workflow" block of `apps/api/src/db/schema.ts`, after `vendorRequests`. House conventions: `uuidPk()`, `createdAt()`, `updatedAt()`, timestamps as **`text` ISO-8601**, booleans as `integer(…, { mode: 'boolean' })`.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `uuidPk()` |
| `vendor_id` | text NOT NULL → `vendors.id` **ON DELETE CASCADE** | **`uniqueIndex vendor_entitlements_vendor_key`** — the structural half of the mirror invariant |
| `tier` | text NOT NULL DEFAULT `'verified'` | **Deliberately UNCONSTRAINED at the DB layer** — see below |
| `status` | text NOT NULL DEFAULT `'active'` | CHECK `IN ('pending','active','expired','revoked')` |
| `period_start` | text | ISO-8601; null = open-ended |
| `period_end` | text | ISO-8601; **null = perpetual** (backfilled rows) |
| `payer`, `amount`, `terms`, `arranged_by`, `invoice_ref`, `notes` | text | The offline arrangement — a superset of `ClaimEntitlementSchema`. **`amount` stays `text`**, not `real`: free-form and currency-agnostic (`"USD 5,000 / yr"`), matching the shipped contract and keeping the model payer-agnostic (§8.1(4)) |
| `granted_by` | text → `profiles.id` **ON DELETE SET NULL** | See R6 in §10 — this is the **seventh** inbound FK to `profiles` |
| `granted_at` | text NOT NULL | `$defaultFn` ISO now |
| `ended_at` | text | stamped when `status` leaves `'active'` |
| `expiry_notice_sent_at` | text | the §7 cron's idempotency fence |
| `source_request_id` | text → `vendor_requests.id` | the claim this came from, when it came from one |
| `created_at`, `updated_at` | text NOT NULL | |

Indexes: `vendor_entitlements_vendor_key` (unique, above); `vendor_entitlements_status_idx` on `status`; and the §7 cron's only scan — a **partial** index `vendor_entitlements_expiry_idx` on `period_end` `WHERE "period_end" IS NOT NULL AND "status" = 'active'`, so perpetual and backfilled rows are invisible to it.

**Why `tier` is unconstrained and `status` is not.** `workflow_instances_type_check` is the cautionary precedent sitting three tables away: a closed CHECK there means every new workflow type costs a migration, and the schema comment records that the ban workflow would have CHECK-failed in prod. The §8.5 decision requires that **adding a tier rung be data-only**, so the closed tier vocabulary lives in the capability registry (§3) and the Zod enum derived from it — the same posture as `audit_log.entity_type`. An unknown tier resolves to **zero capabilities** (fail-closed, §3.1), which is strictly safer than a write-time CHECK failure. `status`, by contrast, **is** CHECK-constrained: adding a status is a state-machine change and therefore a code change anyway.

**Why `pending` earns its place in the status vocabulary.** `pending` = arrangement recorded, PO issued, not yet effective. Offline invoicing genuinely has that limbo, and without it an admin must either not record the arrangement (losing the record this epic exists to create) or verify an unpaid vendor. `expired` = term lapsed amicably; `revoked` = pulled for cause. **Only `active` mirrors.**

### 2.3 The batch shape, concurrency, and the second-seat matrix

Cloned move-for-move from `createBanReviewerHandler` — the guarded-`UPDATE`-under-`db.batch` idiom.

**Activate** (branch chosen in TS from the preload the 422 gate already did, using the `existingWf ? update : insert` idiom from `grantSeatStatements`; not `onConflictDoUpdate`):

```
INSERT INTO vendor_entitlements (…, status='active')                 -- no row existed
  | UPDATE vendor_entitlements SET status='active', ended_at=NULL, … -- row existed, inactive
      WHERE vendor_id = :v AND status <> 'active'
UPDATE vendors SET verified = 1, updated_at = :now WHERE id = :v AND verified = 0
auditInsert(…)                                                       -- same batch, §26.1
```

**Deactivate:**

```
UPDATE vendor_entitlements SET status = :terminal, ended_at = :now, updated_at = :now
  WHERE vendor_id = :v AND status = 'active'
UPDATE vendors SET verified = 0, updated_at = :now WHERE id = :v AND verified = 1
auditInsert(…)
```

**`vendors.updated_at` moves iff `vendors.verified` moves** — stamped explicitly, never left to `$onUpdate`. Both directions matter and only one of them has ever been reasoned about (see R2 in §10).

**Second-seat matrix** (the case that must not regress — the shipped `admin-claims.spec.ts` asserts a second seat neither re-flips `verified` nor churns `updated_at`):

| Preloaded state | Entitlement stmts | `vendors` stmts | Audit |
|---|---|---|---|
| No entitlement row | INSERT | guarded flip → true | `verified_flipped: true`, `entitlement_created: true` |
| Row `active` (second seat) | **none** | **none** | `verified_flipped: false`, `entitlement_created: false` |
| Row exists, not `active` (re-claim after revoke) | guarded UPDATE → active | guarded flip → true | as row 1, plus `reactivated: true` |

Row 2 is the critical one: emitting an INSERT there would violate `vendor_entitlements_vendor_key` and **roll back the entire seat grant**. Preloading and emitting nothing is what keeps the existing assertions passing byte-for-byte.

### 2.4 Backfill, seeds, and the pre-existing `verified = true` rows

Rows already `verified = 1` from the Airtable/claim era violate the mirror the moment §2 lands. Three separate deliverables:

1. **Seeds** (`apps/api/seed/phase2-fixtures.sql`, `catalog.sql`) gain matching `vendor_entitlements` rows. Seed **three states deliberately**: one `active` with a far-future `period_end`, one `active` with a near `period_end` (so the §7 cron has something to bite on locally), one `revoked` (so the §8 downgraded read-only dashboard is demoable without hand-editing D1). The `…0061` fixture vendor is the `/vendor` e2e persona's anchor and **must** get the far-future active row or `vendor-dashboard.spec.ts` breaks once §4 lands.
2. **Backfill for staging / demo / production** — for every `vendors.verified = 1` with no entitlement row, insert `{ tier: 'verified', status: 'active', period_start: null, period_end: null, granted_by: null, notes: 'backfilled at AECI-515 §2 — pre-entitlement Airtable/claim-era verification' }`. Perpetual and termless, so the partial expiry index ignores them entirely. **This is a script under `apps/api/scripts/`, run explicitly per environment — not appended to the migration.** `docs/migrations.md` (~:128, ~:249) is explicit: keep migrations declarative; one-off data backfills are scripts.
3. **The drift check is the proof it landed.** Do not ship §2 without Guard 2 — "the backfill ran on staging but not demo" is otherwise invisible until a reader notices a missing badge.

### 2.5 What this epic deliberately does NOT touch

> **No public or read path may query `vendor_entitlements`.** The public `?verified=` filter, `VendorLinkSchema`, `VendorDetail`/`VendorListItem`, the Algolia vendor record, and `aec-verified-badge` all keep reading `vendors.verified` and are untouched by this epic. The entitlement table is written by `lib/vendor-entitlement.ts`, read by the §4 gate and the §5/§8 surfaces, and by **nothing else**.

This is what keeps the epic additive, and it needs stating because the obvious "improvement" — joining `vendor_entitlements` into the public filter so it reads the truth rather than a mirror — would defeat the entire denormalization. Back it with a test asserting no read config in `apps/api/src/lib/drizzle-helpers.ts` references the table. Also **promote `grantPurgeTags` out of `admin-claims.ts` into a shared `apps/api/src/lib/vendor-cache-tags.ts`** in this issue: this epic adds a second writer of the same tag set (§5), and duplicated tag construction is exactly how a badge goes stale on one path and not the other.

### 2.6 As built (AECI-609 — 2026-08-14)

Shipped as specified: the table (migration `0019_easy_sandman`, §1.2), `apps/api/src/lib/vendor-entitlement.ts` as the sole-writer batch-builder module, both guards, the per-tier backfill script, seeds in three states, and `grantPurgeTags` promoted to `apps/api/src/lib/vendor-cache-tags.ts` as `vendorPurgeTags(db, vendor)`. Decisions taken at build that this section did not pre-specify:

- **The audit `entity_id` is the VENDOR id, not the entitlement row id.** §2.1 makes `audit_log_entity_idx` (`entity_type, entity_id, created_at`) the history ledger, and that only works if every row in a vendor's grant/renew/lapse trail shares a key. An entitlement row id would fragment the trail on every clear-and-re-grant, which is precisely the sequence a renewal dispute needs to read.
- **`EntitlementBatch` deliberately has no `workflowEntry` field.** It mirrors `ClaimBatch` (`lib/vendor-grant.ts`) with two differences: `auditEntry` is **nullable** (a no-op writes nothing, so §26.1 requires no row), and the workflow slot does not exist at all — so R1 is structural rather than a rule someone has to remember. The shared no-op result is a frozen singleton.
- **The activate builder self-heals forward drift, without churning `updated_at`.** `vendorWasVerified` is a parameter, so a drifted `verified = 1`-with-no-row vendor gets its row written while the guarded `WHERE verified = 0` flip matches nothing — no `updated_at` bump, no needless nightly Algolia re-push. **Reverse drift is deliberately not repaired**: an `active` row over `verified = 0` hits §2.3 row 2's frozen no-op. See §6 for why that case can no longer heal itself, and what does repair it.
- **The backfill script refuses reverse drift rather than fixing it** (`ops:backfill-entitlements`, dry-run by default, `--apply` to write, `production` needs `--allow-production`, idempotent via a `WHERE NOT EXISTS` re-guard). It never writes `vendors.verified` — only the sole-writer module moves the mirror — so a `verified = 0` vendor holding an `active` row is **reported and refused**, not repaired. It writes no `audit_log` row (Tier-0; `notes` carries the provenance).
- **Guard 1 shipped with two selectors, not one.** The `.set({ verified })` selector alone would miss `db.insert(vendors).values({ verified: true })` — "create a vendor already verified with no entitlement row" — so the `insert`/`values` twin ships alongside it. Both are anchored to the Drizzle *chain*, not the property name, so read projections and `signal.set({…})` stay clean.
- **Guard 2 is the 11th data-quality check**, riding the existing `aeci.data_quality.check` gauge at `severity: 'error'` — no new metric, no new monitor, and it lands in the daily digest.
- **Seeded `verified = 1` vendors must get an entitlement row or every fresh local D1 trips `entitlement_mirror_drift`.** Nothing fails until the 04:00 cron runs, which makes it a slow, confusing failure; the three seeded states (far-future active, near-term active, revoked) exist so §7 and §8 are demoable locally without hand-editing D1.

---

## 3. The capability registry (AECI-610)

### 3.1 Vocabulary and the tier ladder

**`packages/shared/src/entitlements.ts`** — a root-level module with its own `"./entitlements"` entry in `packages/shared/package.json`, **not** under `src/api/`. `api/*` is the wire-contract namespace (request/response Zod); this is a domain rule table like `algolia.ts`, `agreement.ts`, `slug.ts`.

**It must import no zod.** `hasCapability` is consumed by the lazy `/vendor` Angular route (§8), and `packages/shared/package.json` carries an explicit note that one value import from an `api/*` module once dragged the entire schema set plus a 327 kB zod chunk into the Angular initial graph. Enforce with a file-scoped `no-restricted-imports`. The wire shapes (`SetVendorEntitlementSchema`, `VendorEntitlementResponseSchema`) live in a separate `packages/shared/src/api/admin-entitlements.ts` which imports the tier ids from the registry and joins the `api/index.ts` barrel.

```ts
// packages/shared/src/entitlements.ts — PURE DATA + PURE FUNCTIONS. No zod.

export const CAPABILITIES = [
  'profile.edit',              // PATCH /api/vendor/profile
  'profile.rich_fields',       // the extended vendor field set
  'product.edit',              // PATCH /api/vendor/products/:id
  'product.taxonomy.edit',     // taxonomy assignment on an owned product
  'attestation.author',        // AECI-301 — declared, no consumer yet
  'analytics.view',            // vendor analytics — declared, no consumer yet
  'integration.version_diff',  // AECI-304 — declared, no consumer yet
] as const;

/** The binary ladder at launch (§8.5). Adding a rung = one key here + one row in TIER_CAPABILITIES. */
export const TIERS = ['unclaimed', 'verified'] as const;

export const TIER_CAPABILITIES = {
  unclaimed: [],
  verified: [...CAPABILITIES],   // Verified unlocks everything §8.1(3) lists
};

/** Fail-closed: no row, unknown tier, or non-active status → 'unclaimed'. */
export function tierFor(e: { tier: string; status: string } | null | undefined): EntitlementTier;
export function hasCapability(tier: EntitlementTier, cap: Capability): boolean;
export function capabilitiesFor(tier: EntitlementTier): readonly Capability[];
```

Three capabilities are **declared with no consumer on purpose**: `attestation.author` (AECI-301), `analytics.view`, and `integration.version_diff` (AECI-304). Minting the ids now means those later issues become pure render-path/handler changes with no registry edit, and it makes the vocabulary auditable in one place today.

The ladder is **binary at launch** — `unclaimed` (no active entitlement) vs `verified` (the paid entry fee). `STAGE_2_SPEC.md` §8.2's "tier ladder above the entry Verified fee" stays open as a *pricing* question; this structure makes answering it a data edit.

### 3.2 The ranking firewall — what the unit test asserts

`packages/shared/src/entitlements.spec.ts`, three assertions, escalating:

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

> **The entitlement vocabulary and the Algolia ranking vocabulary are disjoint sets, and the disjointness is asserted, not documented.**

The other half of the firewall **already exists and must stay untouched**: `algolia.spec.ts` ~:242/:262/:274 freeze each entity's `customRanking` to its exact Stage-1 value, so any attempt to add a ranking signal fails there first. **`packages/shared/src/algolia.ts` `INDEX_SETTINGS` and those three assertions are out of bounds for this epic** — see `SEARCH_RANKING.md`.

### 3.3 Where `hasCapability` is consulted — and where it is forbidden

**(a) `/api/vendor/*` writes** — in the handler, **after ownership settles, wherever there is an ownership question**: `requireCapability(c, 'profile.edit')`, throwing 403 `ENTITLEMENT_REQUIRED`. This is a **DB-free assertion** over `c.get('auth').entitlementTier` (§4) — no seam, no mock, trivially unit-testable. **`GET /api/vendor/me` and `GET /api/vendor/seats` are never gated** (§4.3).

> **Amended at build (AECI-611).** This bullet originally read "immediately after `sessionVendorId(c)`", which is not universally satisfiable. On `PATCH /api/vendor/profile` it holds — the caller's own vendor is the subject, so there is nothing to leak. On `PATCH /api/vendor/products/:id` the gate **must** run after `requireOwnedProduct`, because a 403 raised before ownership settles would confirm to a non-owner that the product exists, and **404-never-403 is the harder invariant** of this surface (`AUTH_AND_RLS.md` §4.2a). Same ordering as the AECI-607 version routes. The rule is "as early as possible, but never before ownership".

**(b) The vendor-editable column allow-list** — `VENDOR_COLUMN_MAP` / `PRODUCT_COLUMN_MAP` (`apps/api/src/routes/vendor.ts` ~:525-543, ~:605-611) go from `Record<string, string>` to `Record<string, { column: string; capability: Capability }>`, and `splitPatch` (~:390-403) gains the caller's tier. This extends the header invariant in `packages/shared/src/api/vendor.ts` from one axis to two: **Zod is the parse allow-list, the column map is the entitlement allow-list, and both must agree.** At launch every field maps to a capability `verified` holds, so behaviour is unchanged; adding a rung later is a data edit in two tables.

**(c) The render path — deliberately asymmetric.**

- **Vendor dashboard (`/vendor`)** — non-cacheable and `Cache-Tag`-free by the fail-closed classifier, so per-session forking is safe. `GET /api/vendor/me` returns an `entitlement` block and the forms disable on it (§8).
- **Public SSR (`/vendors/:slug`, `/products/:slug`, the pair page — all cacheable)** — **never forks on the VIEWER.** `aec-verified-badge` is untouched and keeps reading the mirror. If a paid capability forks public HTML at all, it forks on **the subject vendor's** tier — a function of the entity already in the URL, already purged by `vendor:{slug}` — never on the reader's. There is no viewer axis on a cacheable request, and there must never be one: the Workers Cache is URL-keyed, so the first visitor would poison the entry for everyone. See R3 in §10.

> **Restated at build (AECI-304).** This bullet originally read "**no cacheable SSR component may import `@aeci/shared/entitlements`**", naming AECI-304 as the build that would reach for it. That sketch is the wrong shape, and reading it literally would reopen a settled decision. The product-pair resolver **does** import the registry, transitively (`version-diff.ts` → `entitlements.ts`), and is correct to: `canViewVersionDiff` forks on the **pair's two endpoint vendors' tiers**, which are a function of the two slugs in the URL. The page stays storable in the shared cache, shareable, and free of any `Cache-Control: private` — the constraint is discharged **by construction**, not by a module ban. So the rule is a **viewer-tier ban, not an import ban**. A future mechanical guard must either express the viewer-tier property directly or allow-list `@aeci/shared/version-diff`; none exists today (§3.4 note 4), so **R3 stays open** and this is review-only.

### 3.4 As built (AECI-610 — 2026-08-14)

Shipped as specified. Five source files, no behaviour: nothing consults the registry yet, by design.

| File | What landed |
|---|---|
| `packages/shared/src/entitlements.ts` | `CAPABILITIES` (the 7 ids, §3.1 order), `TIERS`, `TIER_CAPABILITIES`, `tierFor`, `hasCapability`, `capabilitiesFor`, `isEntitlementTier`. **Zero imports.** |
| `packages/shared/src/entitlements.spec.ts` | The three-assertion firewall (§3.2) + the fail-closed matrix. 20 cases. |
| `packages/shared/src/api/admin-entitlements.ts` | `SetVendorEntitlementSchema`, `VendorEntitlementResponseSchema` (+ `EntitlementTierSchema` / `EntitlementStatusSchema` / `EntitlementArrangementSchema`), on the `api/index.ts` barrel. §5 consumes it. |
| `packages/shared/src/errors/codes.ts` | `ENTITLEMENT_REQUIRED`. No thrower yet — §4 wires it. |
| `packages/shared/eslint.config.mjs` | The file-scoped `no-restricted-imports` (§3.1). |

Four decisions worth knowing before building on this:

1. **`ENTITLEMENT_STATUSES` lives in the registry, not the wire module.** A small, deliberate addition beyond the §3.1 sketch. The status vocabulary is a plain `as const` array (zod-free, so it costs the bundle nothing), and putting it beside `TIERS` means the D1 CHECK (§2.2, AECI-609), the admin wire enum (§5), and the session block (§4) read one list instead of three copies. `tierFor` still takes a loose `status: string` and fails closed on anything that isn't `active`, including a value outside the vocabulary.
2. **The registry is NOT on the root `src/index.ts` barrel.** That barrel does `export * from './api'`, i.e. it carries zod — the same reason `algolia.ts` was kept out. `@aeci/shared/entitlements` being the only import path makes R11 structural rather than a convention. **Import it by subpath; a root-barrel import will not resolve.**
3. **The lint ban also covers `api/*`, not just `zod`.** `no-restricted-imports` sees only direct imports, so one hop through a wire-contract module would reintroduce the chunk with nothing to catch it. Both halves are proved in `apps/web/src/eslint-config.spec.ts`, which now resolves `packages/shared` configs too — including the case that the ban is scoped to the one file and does not leak across the package.
4. **The §3.3(c) SSR import boundary is NOT built.** Deferred to whichever issue adds the first SSR consumer (AECI-614 is the likely one; AECI-304 is the build R3 actually warns about). **R3 stays open until then** — there is no mechanical guard today stopping a cacheable SSR component from importing the registry.

The disjointness proof carries a non-vacuity case of its own (it asserts the ranking vocabulary is non-empty and that the `unordered()`/`searchable()`/`desc()` wrappers really were stripped), because a broken strip helper would make every assertion below it pass trivially. Per AC 2, `algolia.ts` and the three `customRanking` freezes in `algolia.spec.ts` were not touched.

**Bundle impact, measured** (AC 5, `ng build --configuration production` before/after): **`main-*.js` is byte-identical** (51,305 B) and the chunk count is unchanged (99). The only delta anywhere is **+44 bytes in one lazy chunk** — the `ENTITLEMENT_REQUIRED` entry landing in the already-shipped `ApiErrorCode` map, which `apps/web` genuinely imports. No zod schema, no `TIER_CAPABILITIES`, and no registry function entered the browser graph. R11 held.

---

## 4. The entitlement gate (AECI-611)

### 4.1 Why the session, and not a middleware

**Decision: load the entitlement into `AuthenticatedSession` inside `createAuthzMiddleware` (`apps/api/src/lib/authz.ts` ~:178-235) — but only on the `vendor_admin` branch.** That branch's existing per-request profile re-fetch (~:192-200, currently selecting `role`, `vendorId`, `bannedAt`, `banReason`) becomes a `leftJoin(vendorEntitlements, eq(vendorEntitlements.vendorId, profiles.vendorId))` additionally selecting tier/status/`period_end`. `requireAuth()` and `requireAdmin()` keep the exact `db.query.profiles.findFirst` they run today.

Four reasons:

- **Cost.** A separate `requireCapability()` middleware needs `vendorId` before it can look anything up, so its read **serializes after** the guard's — 2 D1 round-trips per `/api/vendor/*` request instead of 1. Round-trips dominate; statements per round-trip do not. The join is a single-row lookup on a unique index.
- **Coupling.** The epic's stated goal is "a single entitlement gate … entitlements are data, not code branches scattered across the app." A per-route middleware is opt-in, so an omission is a **silent authorization hole** — the same failure mode as forgetting the `vendor_id` scope. On the session, the tier is always present.
- **Granularity settles it.** The gate is **field**-granular (§3.3b) — `description` and `headquarters` can require different capabilities on the same request. Route-level middleware cannot express that. It has to be a handler-level assertion over already-loaded state, which is exactly what a session field gives you.
- **`/api/admin/*` runs through the same middleware.** An admin session has `vendor_id = null`, so an *unconditional* join would be a `LEFT JOIN … ON NULL` on every admin request — harmless but pointless. Branching on the guard variant keeps `/api/admin/*` **and** `requireAuth()` (`POST /api/reviews`, `DELETE /api/account`) byte-identical to today: zero added latency on the review-submit hot path and zero regression surface across the existing authenticated endpoints. Reject the "just always join" simplification.

`AuthenticatedSession` gains:

- **`entitlementTier: EntitlementTier`** — **always present, never optional** (an optional field invites `session.entitlementTier ?? 'verified'`), `'unclaimed'` for non-vendor sessions and for any vendor without an active entitlement. Named `entitlementTier` and **not `tier`** — see R4 in §10.
- **`entitlement: { status, periodEnd } | null`** — term detail for the §8 dashboard readout; null for non-vendor sessions.

**Fail-closed:** a missing or errored join resolves to `'unclaimed'` → writes 403. Never default to `'verified'`.

### 4.2 `ENTITLEMENT_REQUIRED` — 403, not 402

New code in `packages/shared/src/errors/codes.ts` (precedent: `REVIEW_BANNED`, which exists precisely so the UI can distinguish a specific rejection). `details: { capability, tier, fields? }`.

**403, not 402.** 402 Payment Required is semantically tempting, but it leaks a billing model into a wire contract that §8.1(4) requires to stay **payer-model-agnostic**, and `API_CONTRACTS.md` §4.1's status conventions have no 402 row.

**`splitPatch` throws, it does not silently drop.** For any provided field whose capability the tier lacks, throw 403 with `details.fields`. Silent dropping is the "silently un-verify a paying vendor" class of bug this codebase already learned once: the dirty-diff form (`vendor-profile-form.ts`) re-seeds its baseline from the echo and would settle **clean** on a value that never landed.

### 4.3 Reads are never gated

**`GET /api/vendor/me` and `GET /api/vendor/seats` must not consult a capability.** `/vendor` is gated by `vendorMeResolver`, which maps 401/403/404 to a **404 render**. If `me` were ever capability-gated, a vendor whose entitlement lapsed would see a 404 for the entire dashboard — and could therefore never see the renewal notice this epic exists to show them. It is a one-line mistake with total blast radius on exactly the cohort you are trying to bill. **This is an acceptance criterion with its own test**, not a convention.

### 4.4 As built (AECI-611 — 2026-08-18)

Shipped as specified: the `leftJoin` on the `vendor_admin` guard branch only, `entitlementTier` + `entitlement` on `AuthenticatedSession`, `requireCapability()`, the 403, and the two-axis allow-list. `requireAuth()` / `requireAdmin()` are byte-identical to before. Six decisions this section did not pre-specify:

- **The gate's call site is not uniform, and §3.3(a) was amended for it.** See the amendment under §3.3(a): "immediately after `sessionVendorId(c)`" holds on `/profile` but not on a product write, where the gate must run after `requireOwnedProduct` or a 403 confirms a foreign product exists.
- **The entitlement wire shapes live in `api/admin-entitlements.ts`, not `api/vendor.ts`.** `VendorEntitlementBlockSchema` is centralized with the admin tier/status enums so the dashboard readout, the admin action and the D1 CHECK all derive from one vocabulary. `api/vendor.ts` imports it.
- **The `me` block is built from the session, not from a query.** It costs no round-trip, and — the load-bearing part — the dashboard's readout and the 403 a write would get are built from the **same** field, so they cannot disagree.
- **`status: null` means "no `vendor_entitlements` row at all"**, which distinguishes *never bought* from *lapsed*. It is never "unknown". §8 turned that distinction into two different panels.
- **Taxonomy is gated separately** (`product.taxonomy.edit`), as a unit rather than per-field: the facet arrays are set-replacement joins, not columns, so they never enter `PRODUCT_COLUMN_MAP` and `splitPatch`'s second axis structurally cannot see them.
- **`profile.rich_fields` is minted and deliberately unused.** Every shipped vendor-editable field maps to `profile.edit` or `product.edit`. Splitting the profile field set into basic-vs-rich is a *pricing* decision (§8.2 of `STAGE_2_SPEC.md`), and pre-assigning fields to a rung nobody has priced would bake in an answer. The id exists so that decision stays a data edit.

`entitlementRequired()` is the single constructor for the error, so the status, the copy and the `details` shape cannot drift between the route-level gate and the field-level one. The copy points at activation and **never** at ranking, placement or search.

---

## 5. Admin entitlement action — set / renew / clear (AECI-532)

`vendors.verified` has had **no clearing writer at all** since AECI-520 dropped it from the promote payload; `STAGE_2_VENDOR_PORTAL_SPEC.md` §3 closed that epic with the un-verify half explicitly unowned. **This section is its owner** — and it clears the bit through the entitlement row, never by writing the mirror directly.

### 5.1 Endpoint

**`PATCH /api/admin/vendors/:id/entitlement`**, behind `requireAdmin()`, mounted on the existing `authAdmin` sub-router (`apps/api/src/index.ts` ~:264-294 — extend the inventory doc block there too). Body: `{ action: 'set' | 'renew' | 'clear', tier?, period_start?, period_end?, payer?, amount?, terms?, arranged_by?, invoice_ref?, notes?, reason? }`.

**`verified` is never named in the payload.** It follows in the same batch, emitted by `lib/vendor-entitlement.ts` (§2.1). A `PATCH /api/admin/vendors/:id` that set `verified` directly — AECI-532's original shape — would create a second direct writer and break the mirror invariant.

Implementation is the nine-move `createBanReviewerHandler` clone: preload gate (404 on unknown vendor) → guardrail → **422 `INVALID_STATE_TRANSITION`** idempotency gate (`clear` on an already-inactive entitlement, `set` on an already-`active` one) → derive from/to → build the audit entry (`vendor_entitlement.set` / `.renewed` / `.cleared`, `entity_type: 'vendor_entitlement'`, `entity_id: <vendor_id>`, `actor_type: 'admin'`) → one `db.batch` with the guarded UPDATEs → metric `aeci.entitlement.action` → post-commit `waitUntil` forwards + purge → `validateResponseInDev`. **No `workflow_instances` row** (§1.2). Zod in `packages/shared/src/api/admin-entitlements.ts`; documented in `API_CONTRACTS.md` §6.10.

**UI.** An entitlement column on the existing `/admin/claims` rows plus an inline set/clear control, following the `/admin/reviewers` ban-control precedent — not a new admin section. (A standalone `/admin/vendors` entitlement browser is §11.)

### 5.2 Entitlement vs seat-revoke vs ban — three orthogonal actions

After this epic there are three distinct "take it away" actions, and an admin clicking the wrong one expecting a different effect is a foreseeable incident. The admin UI copy must make this table true on screen:

| Action | Endpoint | Scope | Effect | Touches `vendors.verified`? |
|---|---|---|---|---|
| **Ban a seat** | `PATCH /api/admin/reviewers/:id` | one `profiles` row | that seat 403s on every `/api/vendor/*` call; other seats unaffected | **No** |
| **Revoke a seat** | *(none — `revokeSeatStatements` still has no HTTP surface)* | one `profiles` row | drops the seat to `reviewer`, unlinks `vendor_id` | **No** |
| **Clear an entitlement** | `PATCH /api/admin/vendors/:id/entitlement` | the vendor | badge goes away; **seats, logins and dashboard survive, read-only** | **Yes** (via the mirror) |

**Clearing an entitlement does not revoke seats** — this answers AECI-532's open question. It is consistent with `STAGE_2_SPEC.md` §8.3(2) ("un-verifying a vendor is a separate entitlement action, not a ban") and it is what makes the §4 gate's launch behaviour concrete and testable: writes 403, reads work, the dashboard renders read-only with a renewal notice.

### 5.3 Cache purge, Algolia freshness, and copy

Post-commit, enqueue the **full** grant tag set via the shared `lib/vendor-cache-tags.ts` (§2.5): `vendor:{slug}` + every owned `product:{slug}` + `index:products`. The badge renders on the vendor detail hero, the product detail vendor card, and both pair rails — purging only `vendor:{slug}` would leave the badge on cached product pages.

**Algolia is nightly, in both directions.** A flip bumps `vendors.updated_at`, so the next watermark window picks it up — **≤24h** (§8.3(5)). Admin UI copy must not promise instant search. And see R2 in §10: the **un-verify** direction is the one nobody has tested.

### 5.4 Known consequence: the lapsed-and-claimed edit lockout

`loadClaimedVendorIds` (`apps/api/src/lib/claimed-vendors.ts`) defines "claimed" as ≥1 **active** seat — deliberately not `verified` — and `POST /api/promote` refuses to write a claimed vendor. Clearing an entitlement leaves the seats, so the promote block stays in force while the portal writes now 403. **Result: nobody can edit that vendor.**

This is the same shape as the banned-seat lockout AECI-520 already solved (which is why banned seats don't count as claimed), reappearing through a new door. There is no admin vendor-edit endpoint to fall back on. Since un-verify is rare and deliberate, the **accepted** mitigation at launch is: re-activate the entitlement → edit → clear again, or use `apps/datatool`. **It is recorded here as a known consequence with the escape hatch named** — closing it properly (exempt lapsed-but-seated vendors from the promote block, or add an admin vendor-edit endpoint) is §11.

### 5.5 As built (AECI-532 — 2026-08-19)

Shipped as the nine-move `createBanReviewerHandler` clone. Contracts in `packages/shared/src/api/admin-entitlements.ts`, handler in `apps/api/src/routes/admin-entitlements.ts`, full wire contract in `API_CONTRACTS.md` §6.10. Decisions this section did not settle:

- **`renew` PATCHES the arrangement; `set` REPLACES it.** The spec named three actions and never stated their column semantics. `set` writes every arrangement column (absent keys become `null`), so a re-activation cannot inherit a stale previous term; `renew` writes only the keys actually supplied, so extending a term **keeps** the PO reference that `set` would deliberately null. This is the reading a renewal wants: you are amending an arrangement, not restating it. It also required a new builder — `renewEntitlementStatements` in `lib/vendor-entitlement.ts`, the seam §2's module header reserved — because per the §2.3 matrix `activate` answers an already-active row with a **no-op**, so it structurally cannot serve the renewal case.
- **§5.1's "guardrail" move had to be invented.** The template's guardrail is "never ban an admin or yourself"; an entitlement has no person, so there was nothing to port. It was filled with two checks: a **403** on a tier that grants zero capabilities (never sell a badge that unlocks nothing), and a **400** on a term ending at or before it starts (a data-entry slip that would arm the §7 cron immediately). The dates are compared as **instants**, not strings, because the wire type accepts date-only (`2027-09-01`, what a date picker submits) alongside a full timestamp and the two forms do not sort lexicographically against each other.
- **The zero-capability rejection moved from 403 to 400 for the one tier that matters.** A follow-up (`6416487c`) added `PAID_TIERS` / `PaidEntitlementTierSchema`, so `tier: 'unclaimed'` is now rejected by **Zod, as a 400 `VALIDATION_FAILED`**, before the handler runs. The 403 stays as the *semantic* rule rather than a restatement of one tier id, so it keeps biting if a future rung joins `PAID_TIERS` before its capabilities do. **A grantable tier is not the same list as a reportable tier** — the read enum must include `unclaimed` (§4's session block and §6's grant summary have to report it), the write enum must not.
- **Purge is skipped on `renew` and unconditional on `set`/`clear`.** §5.3 says "the full grant tag set" without qualifying by action. `renew` provably cannot change a rendered badge — its builder emits no `vendors` statement at all — so it purges nothing. `set`/`clear` purge **without** checking `verifiedFlipped`: on a drifted vendor a redundant purge costs one cache miss, while a missed one leaves a wrong badge on every cached product page for a full TTL.
- **`clear` writes `revoked`, not `expired`.** Both clear the mirror identically; `revoked` = pulled for cause, `expired` = lapsed amicably. The admin action is always a deliberate act, and the only job with grounds to write `expired` is the §7 cron — which per §7.3 never writes `status` at all. So `expired` is currently unreachable, by design.
- **The response re-reads the committed row but NOT the mirror.** `renew` patches only supplied keys, so reconstructing the row in the handler would duplicate the builder's column mapping and drift from it — one single-row lookup on the unique index is cheaper than that risk. `verified`, by contrast, is known exactly from the action (§2.1's *iff*): `set` → true, `clear` → false, `renew` → the preloaded value. One fewer round-trip, and it cannot disagree with the batch that just ran.
- **A builder returning nothing after the 422 gate is a 500-class bug, and fails loudly.** The gate rules out every no-op branch, so an empty batch means the gate and the builders have drifted apart. The handler throws rather than committing nothing and returning 200 on a write that never happened.
- **The `/admin/claims` row carries the control, and needed a resolved vendor to do it.** `AdminClaim` gained `entitlement_vendor` (required-nullable) because `target_id` on a *product* claim is a product id and cannot address the endpoint; `entitlement` (also required-nullable) is the same readout the PATCH returns, so a successful action drops into the row with no refetch.
- **Fixed in passing:** `admin-claims.spec.ts` inserted a `vendorId` key into `products`, which has no such column. Drizzle drops unknown keys at runtime, so the test passed; `tsc` caught it.

---

## 6. Claim-grant integration — the AECI-519 refactor (AECI-612)

The trick that keeps the shipped tests green: **the audit shape does not change — only which module emits the `vendors` UPDATE.**

1. **Delete exactly one statement** from `grantSeatStatements` — the `db.update(vendors).set({ verified: true, updatedAt })` at `apps/api/src/lib/vendor-grant.ts` ~:208-211.
2. **Keep** the `vendorWasVerified` parameter and keep writing `verified_flipped` plus `beforeState.vendor_verified` / `afterState.vendor_verified`. Those are pure metadata with no statement behind them, so every existing assertion in `admin-claims.spec.ts` and `vendor-grant.spec.ts` passes untouched.
3. **`approveClaim` composes** the two builders and concatenates their statements into one batch:
   ```ts
   const ent = activateEntitlementStatements(db, { vendorId, tier: 'verified', arrangement: entitlement,
                                                   actorId, actorType, now: resolvedAt,
                                                   existing: entitlementBefore, sourceRequestId });
   const grant = grantSeatStatements(db, { … });          // no longer touches `vendors`
   await db.batch([...grant.stmts, ...ent.stmts] as BatchTuple);
   ```
   On the second-seat path `ent.stmts` is `[]` and `ent.auditEntry` is `null` (§2.3 row 2), so the batch is byte-identical to today's minus the no-op guarded UPDATE.
4. **`resolveTargetVendor`** (`apps/api/src/routes/admin-claims.ts` ~:180-206) additionally preloads the entitlement row — one extra read on a path that already does five.
5. **The idempotent re-grant** (200, no batch, `outcome:noop`) returns before any batch is built — untouched.
6. **The `entitlement` body blob keeps landing in audit metadata *and* now also in the row.** Not redundant: per §2.1 the audit log *is* the renewal ledger, so the metadata write is the history. `ClaimEntitlementSchema` gains optional `invoice_ref`, `period_start`, `period_end` — additive, so the `/admin/claims` approve form (which sends only `notes`) needs no change.
7. **`ClaimGrantSummarySchema`** gains `tier` and `entitlement_created: boolean`, both **required** so `validateResponseInDev` catches a construction site that forgets one (the web `ClaimQueue` ignores unknown keys).
8. **New regression guard:** assert `grantSeatStatements` emits no statement touching `vendors`, so the sole-writer invariant cannot silently regress.

### 6.1 As built (AECI-612 — 2026-08-18)

The refactor landed as described — one statement deleted, the metadata kept, `approveClaim` composing the two builders into one batch — and the load-bearing second-seat case passes **byte-for-byte**. Three things this section did not anticipate:

- **A first grant now writes TWO audit rows, and the §6 AC's "no assertion edits" was not achievable.** The rows are `vendor_claim.granted` (the seat) and `vendor_entitlement.granted` (the entitlement + the mirror), both in the one batch, sharing `metadata.source: 'admin-moderation'` so the pair is queryable as one act. Suppressing the second would have kept the assertion count intact and left the §2.1 ledger **missing every claim-originated grant** — which is most of them. Exactly one shipped assertion changed, `toHaveLength(1)` → `(2)`; the second-seat assertions were not touched.
- **The claim path's entitlement action is `vendor_entitlement.granted`, distinct from §5's `.set`.** Same entity type, same vendor-keyed `entity_id`, different verb — so the ledger distinguishes "this came from a claim approval" from "an admin set it directly" without reading metadata.
- **The composed grant can no longer repair one drift state: an `active` entitlement over `verified = 0`.** §2.3 row 2 returns the frozen no-op, so nothing emits the mirror flip — whereas the old `grantSeatStatements` would have healed it as a side effect of its unconditional guarded UPDATE. That side effect is exactly what §2.1 set out to remove, so this is the cost of the invariant rather than a regression: the healing path is now `ops:backfill-entitlements` (which **reports and refuses** reverse drift rather than repairing it, §2.6) plus the `entitlement_mirror_drift` check that surfaces it nightly. Repairing it is a deliberate act, not a side effect of an unrelated grant.

`ClaimEntitlementSchema` gained `invoice_ref`, `period_start` and `period_end` — additive, so the `/admin/claims` approve form (which sends only `notes`) needed no change. `ClaimGrantSummary` gained `tier` and `entitlement_created`, both **required** (R10). The sole-writer exemption list dropped to one file in the same commit (`ANGULAR_STYLE_GUIDE.md` §24), and `apps/api/src/lib/vendor-grant.spec.ts` was **created** to hold the regression guard — see the correction under §10.

---

## 7. Term expiry — warn, never auto-lapse (AECI-613)

**The decision (§8.5).** An entitlement carries a term. The system **warns** admin and vendor as `period_end` approaches and **never** flips anything. Auto-lapse would strip a badge from a paying customer over a data-entry mistake; un-verify stays a deliberate admin act (§5).

### 7.1 The cron

**`0 11 * * *` — 11:00 UTC**, one hour after the attestation sweep and the new last of the daily jobs. `ENTITLEMENT_EXPIRY_CRON`, `apps/api/src/lib/cron-schedules.ts`.

> **Corrected: this section originally specified 05:00 as "the only free slot among the seven", and both halves are now wrong.** The list it argued from has been overtaken twice — 05:00 went to the AECI-526 analytics digest and 10:00 to the AECI-302 attestation-notify sweep, both of which landed after this spec was written. The Worker now runs **twelve** crons, and the 04:00–10:00 band is fully occupied: 00:15 metrics snapshot, 03:00 retention prune, 04:00 data quality, 05:00 analytics digest, 06:00 moderation snapshot, 07:00 stats, 08:00 Algolia sync, 09:00 index drift, 10:00 attestation notify, plus `*/15` reconcile and hourly WAF. **11:00 continues the sequence rather than colliding with it, and satisfies what §7 actually required** — a daily slot in the dead-of-night window, scheduled after the batch that may have moved the rows it reads. The specific hour was never load-bearing; being last was.

The cron string **must stay byte-equal** to its constant, because `scheduled.ts` `switch`es on `controller.cron` and a mismatch silently stops dispatching the job (`cron-schedules.spec.ts` asserts the twelve match `wrangler.jsonc`). `triggers` are declared on **staging, demo and production** — the base config and `preview` carry none — so PR previews never run it.

**Queue-less and inline**, following the 06:00 moderation-snapshot precedent (`queueForJob` returns `undefined`) rather than the ADR 0013 cron→queue→consumer path. The job is one indexed read over `vendor_entitlements_expiry_idx` plus a handful of emails; going queue-less avoids a new `aeci-entitlements-{env}` queue, two `wrangler.jsonc` blocks per tier, and a `wrangler queues create` step in `deploy.yml` / `promote-to-prod.yml`.

### 7.2 Templates, recipients, and the idempotency fence

Two new `EmailTemplate` ids (the id doubles as the `template:` tag on `aeci.email.send`), added to the union in `apps/api/src/lib/email.ts` **and** the catalogue table in `docs/email.md`:

| id | Recipient | Why both |
|---|---|---|
| `entitlement-expiring` | the vendor's seats | the renewal prompt |
| `entitlement-expiring-admin` | `ADMIN_ALERT_EMAIL` | seat email addresses need `fetchAuthUserEmails` and therefore `SUPABASE_SERVICE_ROLE_KEY` — present on staging/demo/prod since AECI-530, **absent locally and on PR previews**, so the vendor send degrades to `skipped`. The admin copy always lands. |

Copy follows the house pattern (two parallel paragraph arrays, `escapeHtml` on every HTML interpolation, `toText()` / `toHtml()`, `sendTransactionalEmail` which never throws). Emails are deliberately not `$localize`d. Reuse the route-seam pattern (§1.3) so the job unit-tests without the email module.

**Idempotency fence:** `expiry_notice_sent_at`. The scan selects `status = 'active' AND period_end IS NOT NULL AND period_end <= now + N days AND (expiry_notice_sent_at IS NULL OR expiry_notice_sent_at < period_end - <window>)`, so a vendor gets one notice per term, not one per night.

### 7.3 The non-negotiable

**The cron never writes `status`.** Ship a test asserting the job's batch contains no `status` mutation. It writes `expiry_notice_sent_at` and a `vendor_entitlement.expiry_warned` audit row with `actor_type: 'system'` — that row is audited (rather than following the `stats_cache` no-audit precedent) because "we warned them on date X" is precisely the fact an offline-invoice dispute needs, and writing it keeps §26.1 unqualified.

Metrics: `aeci.entitlement.expiry_notice` (`outcome`, `channel: vendor|admin`) plus a per-run heartbeat consistent with the other cron jobs (`OBSERVABILITY.md`).

### 7.4 As built (AECI-613 — 2026-08-18)

Shipped queue-less and inline as specified, at **`0 11 * * *`** rather than 05:00 (see the correction in §7.1). Core in `apps/api/src/lib/entitlement-expiry.ts`, metrics in `entitlement-expiry-metrics.ts`, both templates in `lib/email.ts` behind the §1.3 route seam. Four decisions this section did not pre-specify:

1. **The idempotency fence is computed in TS, not SQL.** §7.2 states the predicate as one `WHERE`, and expressing `expiry_notice_sent_at < period_end − 30d` in SQLite would have been a **silent correctness bug**: it is a column-to-column comparison (unindexable either way, so nothing is lost), and SQLite's `datetime()` renders `YYYY-MM-DD HH:MM:SS`, which does **not** order lexically against the `…THH:MM:SS.sssZ` form this schema stores. The horizon filter stays in SQL and rides the partial index; the fence is applied in TS over the returned rows.
2. **The fence stamps when EITHER channel was `sent`.** Stamping on *attempt* would silently consume a term's one notice during a Resend outage; requiring **both** would re-nag the operator every night on any tier without `SUPABASE_SERVICE_ROLE_KEY` — i.e. permanently, locally and on previews. "At least one recipient actually heard about it" is the condition that matches what the fence is for.
3. **The job does not rethrow**, unlike the attestation sweep it otherwise mirrors. A retry would re-send every notice whose *fence write* is what failed — turning one transient D1 error into a duplicate mailshot at a paying customer. An unexpected error is an `outcome:failed` heartbeat and a `failed` `job_runs` row, and tomorrow's run picks up exactly what this one missed.
4. **No lower bound on the scan.** An `active` term already past its end date is exactly what an operator needs to see — nothing lapses on its own (§7.3), so that state persists until a human acts — and the fence still limits it to one notice per term. The admin copy says so outright rather than implying something changed.

Two supporting details: `EXPIRY_BATCH_CAP` (200/run) is a backstop against a first-adoption spike or a mis-entered bulk term, not a design limit — the fence means tomorrow continues the backlog rather than repeating it, and the dropped count is logged rather than truncated silently. And `aeci.entitlement.expiry_due` is emitted on **every** run including zero, because every §2.4 backfilled entitlement is perpetual and therefore structurally invisible to this job: **"0 due" is the healthy steady state for a long time, so no-data is the failure signal.**

⚠️ **A carve-out worth knowing about.** `scheduled.spec.ts`'s `AUDIT_EXEMPT_CRONS` list carves out `entitlement-expiry` alongside `retention-prune`. It is **not** genuinely ADR-0022-exempt — a delivered warning writes an `audit_log` row — and the sweep is mocked in that file, so the exemption assertion would pass vacuously twice over. The real obligation is asserted in `entitlement-expiry.spec.ts`. If that list grows, it needs a comment distinguishing "genuinely exempt" from "mocked here, asserted elsewhere" (`TESTING_STRATEGY.md` §3.6 records the general caveat).

---

## 8. Vendor-facing entitlement surface (AECI-614)

Replace `apps/web/src/app/vendor/components/vendor-verified-status.ts` — whose own doc comment says "the richer paid-tier display lands with AECI-515" — with the real plan panel on the dashboard **Overview** tab.

- **Reads the `entitlement` block on `GET /api/vendor/me`** (§4): tier, status, `period_end`, and the resolved capability list. No new endpoint.
- **States to render:** active with a far term (quiet); active and expiring soon ("expires in N days", renewal CTA); and **downgraded** — `status` not `active`, forms read-only, a clear explanation that portal access remains and how to renew. The downgraded state is the one that must be designed properly: it is shown to a customer AECi wants back.
- **Copy discipline.** Verification is an **account status**, never an endorsement and never a ranking or placement signal (reuse the `aec-verified-badge` tooltip's framing and the `claim-approved` email's wording). No promise of instant search (§8.3(5)). Arrangement details (amount, terms, PO) are **admin-side only** — the dashboard shows status and term, never the money.
- **Build it preview-first** (`apps/web/src/app/preview/vendor-dashboard/`, the AECI-270 → AECI-522 house pattern) with fixtures for all three states, so the downgraded state gets PO sign-off before the gated route is wired.
- Run the `CLAUDE.md` design checklist: Anchor-Site Rule (the anchor is the existing `/vendor` dashboard — it must read as a sibling), `impeccable detect` clean, axe pass, i18n `@@` ids on every string. **Light theme only.**

### 8.1 As built (AECI-614 — 2026-08-19)

`vendor-plan-panel.ts` replaces `vendor-verified-status.ts`, which is **deleted** — resolving the `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.1 hand-off that named this issue. It reads the `entitlement` block on `GET /api/vendor/me`; no new endpoint, no new query.

**Five states shipped, not the three this section listed.** The extra two are not variants of "downgraded" — they are different conversations:

| State | Condition | What it says |
|---|---|---|
| `active` | `status: 'active'`, known tier, term far off or absent | Quiet. The real badge, the term, the framing sentence. |
| `expiring` | as above, `period_end` within `EXPIRY_WARNING_DAYS` | "Ends in N days", a renewal path. **Still verified** — nothing has been taken away yet, and the copy says so. |
| `pending` | `status: 'pending'` | Arranged, not yet switched on. |
| `lapsed` | `expired` / `revoked` (and the fail-closed drift case below) | A **loss to acknowledge**. Leads with what the vendor KEEPS, names the one thing that is paused, offers a renewal path. |
| `none` | `status: null` — no entitlement row at all | An **invitation**, not a loss. |

`null` vs `expired` is the distinction that earned two panels: never-arranged and lapsed are materially different conversations, and rendering a loss-acknowledgement at someone who never bought anything is the wrong message. §4 made that distinction available on the wire.

Three decisions this section did not pre-specify:

1. **State resolution is fail-closed, mirroring `tierFor`.** `status: 'active'` over an **unknown tier** renders as **lapsed**, not verified. `vendor_entitlements.tier` is DB-unconstrained by design (§2.2), so this case is real; a "Verified" chip sitting above read-only forms would be the wrong lie, and the panel must never claim more than the gate will honour.
2. **The read-only forms use `readOnly`, not `disabled`.** §5.2's promise is that the data survives a lapse, and `disabled` removes the values from the accessibility tree — a screen-reader user would lose exactly the data the promise is about. `readOnly` keeps them focusable and copyable. Both `onSave` handlers guard independently, because Enter submits a form with no button.
3. **The active/expiring states render the real `aec-verified-badge`**, not a lookalike — the vendor sees the exact pill the public sees, which is the whole point of a status readout.

The expiry horizon is **one constant**: `EXPIRY_WARNING_DAYS` in `@aeci/shared/entitlements`, consumed by both the cron and this panel. It shipped as two independent `30`s (AECI-613's `EXPIRY_WARNING_DAYS` and this issue's `EXPIRY_SOON_DAYS`) that agreed by coincidence; a follow-up consolidated them, because a cron whose horizon was the wider of the two would email a paying customer about a problem their own portal still denied.

Copy discipline held: verification is an **account status**, never an endorsement and never a ranking or placement signal; no promise of instant search; arrangement details (amount, terms, PO, payer) stay **admin-side only** — this panel shows status and term, never the money. Renewal is a conversation (`/contact`), not a checkout. Dates format in **UTC**, not the ambient zone: the SSR Worker runs in UTC and the browser does not, so a zone-local format would render two different dates across hydration.

One thing this panel does **not** yet drive: `attestation.author` is still gated on the `vendors.verified` **mirror** (`assertVerifiedVendor`), not on the capability — the last place in the portal not driven by `capabilities`. Behaviourally identical while the ladder is binary; a real divergence the moment a rung lands between. Tracked as **AECI-623**.

---

## 9. Documentation & authz sweep (AECI-615)

Land last, once §2–§8 have settled the details. Each doc gets the sections named:

| Doc | Change |
|---|---|
| `API_CONTRACTS.md` | §6.10 — `PATCH /api/admin/vendors/:id/entitlement`, plus the `entitlement_vendor` / `entitlement` fields on `AdminClaim` and the `tier` / `entitlement_created` fields on `ClaimGrantSummary`; §6.14 — the `entitlement` block on `GET /api/vendor/me` + the 403 `ENTITLEMENT_REQUIRED` shape + the second (capability) axis on the allow-list invariant; §4 — the error code row |
| `DATABASE_SCHEMA.md` | new **§8.6** `vendor_entitlements` (Postgres-DDL notation, house style); §3 — the table inventory; §4.1 — rewrite the `vendors.verified` annotation from "sole writer is the claim grant, no un-verify writer yet" to the mirror invariant; §7.1 — a disambiguating pointer next to `profiles.trust_tier` (R4); §18 — the expiry sweep is a second auditing cron |
| `AUTH_AND_RLS.md` | §3.2 — replace "`vendors.verified` *is* the launch entitlement bit (there is no `entitlements` table)"; **new §4.2b** — the entitlement tier on the session; §4.4 — the new admin endpoint row + capability columns on the vendor writes; §8 — the FK trap table (already **seven** rows; fix the "six inbound references" and "eight-FK trap" prose that disagreed with it); §8.2 — the last-seat edge gains "the entitlement survives, and that is legitimate: verified-but-unclaimed"; §9 — mark the model shipped |
| `email.md` | catalogue rows for `entitlement-expiring` / `entitlement-expiring-admin`; the `ADMIN_ALERT_EMAIL` row gains the operator copy |
| `CACHE_STRATEGY.md` | new **(b1)** — entitlement flips purge the grant tag set via the shared builder; no new tag; the `updated_at`-iff-`verified` rule in both directions |
| `OBSERVABILITY.md` | `aeci.entitlement.action`, `aeci.entitlement.expiry_due`, `aeci.entitlement.expiry_notice`, `aeci.entitlement.expiry.job{,.duration_ms}`, the new `entitlement_mirror_drift` id under `aeci.data_quality.check`, a cron-liveness row for the 11:00 job; **and fix the already-stale `aeci.email.send` `template` tag list**, which omitted `claim-approved`, `claim-rejected` and `mailing-list-welcome` |
| `migrations.md` | nothing owed — `apps/api/scripts/README.md` already carries the §2.4 backfill script, and §0's numbering history is current |
| `STAGE_2_SPEC.md` | §8.2's two open items are already promoted to §8.5 by the epic review; §2.2 already points here |
| `STAGE_2_VENDOR_PORTAL_SPEC.md` | its three hand-off lines (§3's unowned un-verify, §6.1's deferred paid-tier display, §11's deferral bullet) already name this doc; verify they still resolve |
| `STAGE_2_ATTESTATIONS_SPEC.md` | §9.3/§9.4 — the version-diff gate is built and both ⚠️ notes are resolved; AECI-304 moves off the deferred list |
| `ANGULAR_STYLE_GUIDE.md` §24 | the mirror sole-writer rule's exemption list drops to **one** file; the `version-diff.ts` no-zod block joins the package-local guards; the `@aeci/shared/entitlements` SSR boundary is recorded as **not built** and restated as a viewer-tier ban |
| `TESTING_STRATEGY.md` | new §3.6 — the §10 invariant tests, and what makes one different from a coverage test |
| `CLAUDE.md` | the design checklist's `impeccable detect` step — scan the rendered surface, because a file-path scan cannot see inline Angular templates and passes vacuously |

---

## 10. Testing contract

The three tests below are **invariant tests** — they encode decisions, not behaviour, and must not be deleted without reopening this spec.

| Test | Owner | Asserts |
|---|---|---|
| Mirror sole-writer | §2 | `grantSeatStatements` (and every route handler) emits no statement touching `vendors.verified`; only `lib/vendor-entitlement.ts` does, and never one side of the *iff* without the other — **live**; AECI-612 created `apps/api/src/lib/vendor-grant.spec.ts` to hold it |
| Ranking disjointness | §3 | the capability vocabulary and the union of `INDEX_SETTINGS` searchable/facet/customRanking attributes are disjoint sets (§3.2) — **live** in `packages/shared/src/entitlements.spec.ts` |
| Reads are never gated | §4 | `GET /api/vendor/me` returns 200 for a vendor whose entitlement is `revoked`/`expired`, with the downgraded `entitlement` block — **live** |

> **Correction:** this table originally implied `vendor-grant.spec.ts` already existed and merely gained an assertion. **It never did** — `git log --all --diff-filter=A` finds no such file on any branch before AECI-612, and `grantSeatStatements` was covered only indirectly through `admin-claims.spec.ts`. AECI-612 created it.

Plus, per issue: the second-seat no-op matrix (§2.3) against the in-memory D1 harness; **`vendors.updated_at` moves iff `vendors.verified` moves, in both directions** (§2.3 / R2); 422 idempotency on `set`/`clear` (§5); `POST /api/promote` still cannot move the bit (the AECI-520 regression guard, carried over from AECI-532); the cron writes no `status` (§7.3, asserted against the generated SQL so the `WHERE status = 'active'` **guard** is not mistaken for a write); and the no-read-path guard on `drizzle-helpers.ts` (§2.5).

### Risks recorded at the epic review

| # | Trap | Mitigation |
|---|---|---|
| R1 | `workflow_instances_type_check` is a **closed** CHECK; a new type is a SQLite table rebuild | No workflow row for entitlement changes; `audit_log.entity_type` is unconstrained. Settled in §1.2/§2, not §5. |
| R2 | The Algolia watermark. AECI-529 only ever reasoned about the flip to **`true`** | **`vendors.updated_at` moves iff `verified` moves**, both directions tested. A renewal that doesn't flip the mirror must **not** bump it (needless nightly re-push); an **un-verify must**, or a lapsed vendor keeps a Verified badge in search indefinitely. |
| R3 | Cache key vs Cache-Tag | A public page may never fork on the **viewer's** entitlement (Workers Cache is URL-keyed; `CLAUDE.md` visitor-state-neutral constraint). **Discharged in practice, still open mechanically.** AECI-304 — the build this risk was written about — kept its gate URL-derived (the pair's endpoint vendors, a function of the two slugs), so no cookie, no session, no `Cache-Control: private`, no new cache-key axis; `cacheKeyParams` unchanged. But there is still **no lint rule**: §3.3(c)'s sketched module ban is the wrong shape (§3.3c, as restated), and nobody has expressed the viewer-tier property mechanically. Tag side: one shared tag builder (§2.5). |
| R4 | `profiles.trust_tier`'s CHECK vocabulary **literally contains `'verified'`** — a reviewer concept on the neighbouring table | Session field is `entitlementTier`, never `tier`; no `TrustTier` type; `DATABASE_SCHEMA.md` §7.1 gets a pointer. `grantSeatStatements`' no-clobber comment already lists `trust_tier` — that stays true and now needs the disambiguating word. |
| R5 | Seeds already ship `verified = 1`; the `…0061` fixture is the `/vendor` e2e persona's anchor | §2.4 — three seeded states, a script-based backfill per tier, and the drift check as proof. |
| R6 | `vendor_entitlements.granted_by` is a new inbound FK to `profiles.id`, all of which are nulled by the `DELETE /api/account` batch | **Closed.** `ON DELETE SET NULL` **and** an explicit null-out in the erasure batch **and** the doc table updated. Otherwise account deletion FK-fails for any admin who ever granted an entitlement — silent, delayed, GDPR-relevant. **Count correction:** this risk (and §2.2) called it the *eighth* FK, reading a doc table that then listed seven. `page_views.user_id` had already been dropped by AECI-585, so the real count going in was **six**, and `granted_by` is the **seventh** — five `NO ACTION` + two `SET NULL`, verified against the actual batch in `apps/api/src/routes/account.ts`. `AUTH_AND_RLS.md` §8 is correct at seven; do not "fix" it to eight. |
| R7 | Lapsed-and-claimed edit lockout | §5.4 — accepted, escape hatch named, proper fix in §11. |
| R8 | Three orthogonal "take it away" actions | §5.2 table + admin UI copy. |
| R9 | `GET /api/vendors?verified=` quietly changes meaning (from "was granted a claim" to "has an active entitlement") | No code change, and §2.5 forbids "fixing" it to join the entitlement table. Backed by the read-path test. |
| R10 | New response fields shipping as `undefined` | Make them **required** so `validateResponseInDev` catches a missed construction site (§6.7). |
| R11 | The 327 kB zod-chunk regression | **Closed (AECI-610).** `entitlements.ts` imports no zod and no `api/*`, enforced by a file-scoped lint rule and kept off the zod-carrying root barrel; wire schemas live in `api/admin-entitlements.ts` (§3.1 / §3.4). |
| R12 | `OBSERVABILITY.md`'s `aeci.email.send` template list is **already** stale | Fix it in §9 rather than adding two more templates to a wrong list. |
| R13 | Gating `GET /api/vendor/me` would 404 the whole dashboard and hide the renewal notice from exactly the cohort being billed | §4.3 — an acceptance criterion with a test. |

---

## 11. Out of scope / deferred

- ~~**AECI-304 — paywalled integration/version-diff depth.**~~ **SHIPPED** (2026-08-19), after AECI-303 unblocked it mid-epic. It was excluded from this epic's build order and completion criteria (§1.1) and then landed on the branch anyway; recorded here rather than promoted to a numbered section, because the gate lives in the attestations spec's §9 seam. **The hand-off sentence this bullet used to carry was wrong**: it said the gate would be "`hasCapability(...)` on the diff component only". It is not on a component and not on the reader. The gate is `canViewVersionDiff` in `packages/shared/src/version-diff.ts`, consulted at exactly **two** sites (asserted by `version-diff.consult-sites.spec.ts`): `resolveDiffAccess` (`apps/api/src/lib/pair-version-diff.ts`) and `gateHistoricalDepth` (`apps/web/src/app/products/products-pair.resolver.ts`). It forks on the **pair's two endpoint vendors' tiers** — read off the `vendors.verified` mirror via `vendorTiersFromMirror`, since §2.5 forbids a public read path from touching the entitlement table — and historical depth opens when **either** endpoint vendor holds `integration.version_diff`. The reader invariants are unchanged and non-negotiable — **the latest-version view and the latest conflict / single-source state are always free and full-fidelity; paywall the diff, never the dispute; one-sided (paid-vs-unpaid) states are visibly labeled** — and the first of those is a labelled early return (`if (!historical) return 'full'`) that runs before any entitlement is consulted. That labeling is also the §8.1(3) attestation-bias mitigation.
- **Automated billing (Stripe or similar) and self-serve card payment** — deferred (§8.1(5)). The entitlement flag is payer-model-agnostic so this can arrive without a migration.
- **Pricing and a tier ladder above the entry Verified fee** — the *structure* is now data-only (§3.1); the pricing question stays open.
- **Dunning / auto-lapse / renewal automation** — §7 warns only, by decision.
- **Queryable term history** — the audit log is the ledger (§2.1); an append-only `vendor_entitlement_periods` child table is the additive escape hatch if finance ever needs one.
- **Per-seat entitlements** — entitlement is vendor-level; seats are individually granted and individually bannable (§5.2).
- **A standalone `/admin/vendors` entitlement browser** — §5 attaches the control to `/admin/claims`.
- **Closing the §5.4 lockout properly** (exempt lapsed-but-seated vendors from the promote block, or add an admin vendor-edit endpoint).
- **Viewer-pays anything** — far-future, out of scope (§8.1(4)).

---

## 12. Cross-references

| Topic | Doc |
|---|---|
| Stage 2 scope, decisions, epic map | `STAGE_2_SPEC.md` (§2.2 scope, §8.1 + §8.5 decisions) |
| The portal this layers on (claim → grant → seat → `/api/vendor/*` → badge) | `STAGE_2_VENDOR_PORTAL_SPEC.md` (AECI-513, shipped) |
| Layer-1 Worker authz (JWT → role/ban → scope) | `AUTH_AND_RLS.md` (extended by §4/§9) |
| Endpoint request/response Zod shapes | `API_CONTRACTS.md` (§6.10, §6.14) |
| D1 schema | `apps/api/src/db/schema.ts` + `DATABASE_SCHEMA.md` (**§8.6** — the one migration; §8.5 was already `promote_jobs`) |
| Migration + backfill workflow | `migrations.md` (§2.4 — backfills are scripts, not migrations) |
| Transactional email | `email.md` (§7) |
| Cache-Tag purge (queue producer + tag map) | `CACHE_STRATEGY.md` (§5.3) |
| Algolia index settings — the untouchable half of the firewall | `SEARCH_RANKING.md` (§3.2) |
| Metric catalog | `OBSERVABILITY.md` (§9) |
| Lint rule-to-constraint map | `ANGULAR_STYLE_GUIDE.md` §24 (§2.1, §3.3c) |
| The version-diff seam AECI-304 gates | `STAGE_2_ATTESTATIONS_SPEC.md` §9.3/§9.4 (§11) |
| Invariant tests, and what makes one | `TESTING_STRATEGY.md` §3.6 (§10) |

---

*This is the build contract for AECI-515. As each sub-issue lands, add its "As built (AECI-N — date)" subsection and keep this doc current with the code (per the "update all documents" rule) — the file/line references in §1.3, §2 and §6 are anchors, not guarantees; verify them before editing the cited files.*
