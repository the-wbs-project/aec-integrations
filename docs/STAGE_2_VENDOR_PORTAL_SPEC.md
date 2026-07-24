# AEC Integrations — Stage 2 Vendor Portal & Self-Serve Claiming Specification

**Version:** 0.1 — **build contract** (the decomposition of the AECI-513 epic, the Stage 2 anchor)
**Date:** July 2026
**Status:** Build contract — promotes `STAGE_2_SPEC.md` §2.1 from scope outline to a buildable spec. Decisions resolved at the 2026-07-24 epic review (see `STAGE_2_SPEC.md` §8.3).
**Supersedes:** the integration/portal portions of `STAGE_2_SPEC.md` §2.1 (that section stays the scope outline; this doc is the contract each sub-issue anchors to).
**Inherits from:** Stage 1 (Phases 1–8 — `STAGE_1_SPEC.md`), Stage 1.5 (`STAGE_1_5_SPEC.md`), and the authorization model (`AUTH_AND_RLS.md`).
**Companion docs:** `AUTH_AND_RLS.md` (Layer-1 Worker authz — §4/§7), `API_CONTRACTS.md` (endpoint shapes — §4), `DATABASE_SCHEMA.md` (tables — §1.2), `email.md` (Resend — §9), `CACHE_STRATEGY.md` (Cache-Tag purge — §3/§8), `SEARCH_RANKING.md` (Algolia — §8).

> **Data-layer note (ADR 0016 / 0017).** The application database is **Cloudflare D1 + Drizzle**; Supabase is **auth-only**. Every write in this spec goes through `getDb(env)` and, for multi-statement writes, a single `db.batch([...])` that includes its `audit_log` row (the §26.1 invariant of `STAGE_1_SPEC.md`). There is **no Prisma, no Postgres, no RLS on app tables** — Stage 2 authorization is the **3-layer Worker model** in `AUTH_AND_RLS.md`, not Postgres RLS.

---

## 1. Overview & the launch model

**Stage 2 is where the vendors log in.** The vendor portal is the anchor capability of Stage 2: a vendor authenticates, proves association with a `vendors` record, and gains `vendor_id`-**scoped** write access to their own product/vendor data — with every write audited and the verified badge activated on approval. The dividing line inherited from `STAGE_1_5_SPEC.md` §1.1 is exact: *anything that requires a vendor to authenticate and assert something about their own product is Stage 2.*

**The launch model is concierge / manual (`STAGE_2_SPEC.md` §8.1).** AECi grants every `vendor_admin` **by hand** — **no auto-grant**. Verification is a **paid gate** arranged by **offline invoice/PO**. Seats are **multi-seat, flat** (several admins per vendor — e.g. Autodesk, Deltek). It deliberately does not scale; vendor volume at launch is low, and staffing help comes in if it grows.

**The trust invariant is unchanged and non-negotiable: no pay-for-placement.** Verified is a **capability + profile-richness** gate, never a ranking, placement, or badge-trust gate. Search stays purely algorithmic (`STAGE_1_SPEC.md` §1 principles; `CLAUDE.md` constraints). The reader-facing model is unaffected by what a vendor pays to participate.

### 1.1 Issue map & critical path

This doc is the contract for the AECI-513 sub-issues. Each opens with `**Spec section:** docs/STAGE_2_VENDOR_PORTAL_SPEC.md §X` per the `spec-anchor` convention. **The subsection numbering below is load-bearing — do not renumber without updating the issues.**

| Anchor | Issue | Surface |
|---|---|---|
| §2 | AECI-527 | Claimant identity resolution — GoTrue email→user seam, invite path, profile-ensure no-clobber |
| §3 | AECI-519 | Claim → verified-account grant flow |
| §4 | AECI-520 | `/api/vendor/*` endpoint surface + vendor authz seam |
| §5 | AECI-521 | Admin claim-review surface + reviewer-assist verification signals |
| §6 | AECI-522 | Vendor dashboard UI (edit content, status, multi-seat) |
| §7 | AECI-524 | Moderation escalation — gate vendor writes on ban state |
| §8 | AECI-523 / AECI-529 | Verified-badge activation — SSR trust surface (523) + search surfaces (529) |
| §9 | AECI-528 | Claim-decision emails (claim-approved / claim-rejected over Resend) |
| §10 | AECI-525 | Document `vendor_admin` authz in `AUTH_AND_RLS.md` |

**Build order.**

```
527 (identity) → 519 (grant) ∥ 520 (authz seam + /api/vendor/*)
              → 521 (admin review) + 522 (dashboard)
              → 523 (badge SSR) / 524 (ban) / 529 (badge search)
525 (authz doc) + 528 (claim emails) run alongside.
```

`527` blocks `519` (the grant needs a resolved identity to link). `519` and `520` are parallel (the grant flow and the authz seam share nothing but the schema). The ban gate **check** ships with `520`; `524` owns the ban **action** + policy. `528` (emails) and `525` (authz doc) have no code dependency and run whenever.

### 1.2 Schema readiness — no migration required

Verified 2026-07-12 and re-verified at kickoff against `apps/api/src/db/schema.ts`. **Standing up the vendor portal needs no migration.** The relevant hooks (line numbers current at kickoff — treat as approximate, verify before editing):

| Hook | Location |
|---|---|
| `profiles.role` CHECK allows `vendor_admin` (`'reviewer' \| 'admin' \| 'vendor_admin'`) | `schema.ts` `profiles_role_check` (~:498) |
| `profiles.vendor_id` FK → `vendors.id` + partial index | `schema.ts` col (~:479), `profiles_vendor_idx` (~:492-494) |
| `vendors.verified` boolean + index | `schema.ts` col (~:94), `vendors_verified_idx` (~:111) |
| `profiles.banned_at` / `ban_reason` + partial index | `schema.ts` cols (~:484-485), `profiles_banned_idx` (~:495-497) |
| `vendor_requests` (kind `'claim' \| 'correction'`, carries `submitter_email`, `domain_match`) | `schema.ts` (~:575-626) |
| `workflow_instances_type_check` already lists `'vendor_claim'` | `schema.ts` (~:658) |

Many `profiles` → one `vendor_id` (no uniqueness on `vendor_id`) makes **multi-seat, flat** schema-native with zero migration. `DATABASE_SCHEMA.md` documents these tables in Postgres-DDL notation (it trails the live D1/Drizzle schema); `schema.ts` is the source of truth.

### 1.3 What already exists (reuse, don't rebuild)

The Stage 1 Phase 6 request pipeline already ships the front half of the claim flow:

- **Public claim submit (anonymous)** — `POST /api/requests/claim` → `createClaimSubmitHandler` → shared `createRequest()` (`apps/api/src/routes/requests.ts` ~:207-371) atomically batches a `vendor_requests` row (kind `'claim'`, carrying `submitter_email` + computed `domain_match`), a `workflow_instances` row (`workflow_type='vendor_claim'`, `current_state='open'`), the genesis `workflow_transitions` row, and the `vendor_request.created` audit row; then best-effort opens a Linear issue post-commit.
- **Domain-match signal** — `computeDomainMatch(submitterEmail, vendorWebsite)` (`apps/api/src/lib/domain-match.ts`, eTLD+1 compare via `tldts`) already produces the `domain_match` verification hint the reviewer needs.
- **Admin moderation template** — `createModerateRequestHandler` (`apps/api/src/routes/admin-requests.ts` ~:274-440) is the batch-shaped approve/reject handler to clone (guarded `WHERE status IN (...)`, find-or-create `workflow_instances`, `TERMINAL_OUTCOME` map, injectable Linear-sync seam, `422 INVALID_STATE_TRANSITION` preload gate).
- **Audit / workflow batch builders** — `auditInsert` / `workflowTransitionInsert` (`apps/api/src/lib/audit.ts` ~:42-68) return the batch statements every write pushes into `db.batch`.

**What does NOT exist yet** (the net-new work of this epic): any account-grant / role-grant code, the GoTrue **invite** + **email→user lookup** path (the current `supabase-admin.ts` only deletes and fetches-by-id), the `vendor_admin` guard branch + `vendorId` on the session, the `/api/vendor/*` surface, the `/admin/claims` UI, the claim-decision emails, and the `verified` field on the Algolia index.

---

## 2. Claimant identity resolution (AECI-527)

**Blocks §3.** The `vendor_requests` claim record carries `submitter_email` **only** — there is no user account attached at submit time (the form is anonymous). Before a claim can be granted, that email must resolve to a Supabase `auth.users` identity so the D1 `profiles` row (keyed by the auth-user UUID) can be linked to the vendor.

**The seam.** Provisioning is an **app-layer seam** — there is no cross-system FK between Supabase `auth.users` and D1 `profiles` (AECI-254), identical to how the `admin` role is granted (`AUTH_AND_RLS.md` §3). `profiles.id` is a plain text PK, keyed **by convention** to `auth.users.id` = the JWT `sub`.

**Resolution paths.** When AECi approves a claim (§3), resolve `submitter_email` to an auth user:

1. **Existing user** — look the email up via the GoTrue Admin API and reuse its id. (Net-new: the current `apps/api/src/lib/supabase-admin.ts` fetches users **by id** only — add an email→user lookup helper reusing the existing `adminConfig` / `adminHeaders` scaffolding.)
2. **New user (invite path)** — if no auth user exists for the email, invite/create one through the GoTrue Admin API so the claimant receives a set-password / magic-link onboarding. (Net-new: no `inviteUserByEmail` / `generateLink` / `admin.createUser` exists today.)

Either way, the resolved auth-user id is the id used to write the `profiles` row in the §3 grant batch.

**Profile-ensure no-clobber contract.** The `profiles` row is created idempotently and **never clobbered**. Reuse the pattern in `POST /api/auth/profile/ensure` (`apps/api/src/routes/auth-profile.ts` ~:50-79): `INSERT … ON CONFLICT DO NOTHING … RETURNING`, so a grant that lands after the claimant has already signed in (and self-created a default `reviewer` profile) **updates** the existing row's `role`/`vendor_id` rather than replacing it. The grant must not reset `display_name`, `theme_preference`, or any field it does not own.

**Graceful degrade.** `SUPABASE_SERVICE_ROLE_KEY` is optional (absent in local/PR-preview). The identity-resolution helpers must **degrade gracefully** when creds are absent (the pattern `deleteAuthUser` / `fetchAuthUserEmails` already follow — return a skipped/empty result, never throw), so the grant path is testable without a live Supabase.

**Role/vendor exclusivity (`STAGE_2_SPEC.md` §8.3).** `role` and `vendor_id` are single-valued. Resolution must surface explicit errors, not silent overwrites, when: the resolved account is already an `admin` (no `vendor_admin` grant to admin accounts), or is already `vendor_admin` for a **different** vendor (one vendor per account at launch — a `vendors.parent_company` multi-vendor admin uses separate accounts). A **second seat on the same vendor** is the expected, allowed case.

---

## 3. Claim → verified-account grant flow (AECI-519)

The approval action that turns an `open` vendor claim into a live verified vendor account. **Depends on §2** (a resolved auth-user id) and reuses the §1.3 moderation template.

**The grant (single `db.batch([...])`).** On approve, in one atomic batch:

1. **Link the seat** — upsert the `profiles` row for the resolved auth-user id: set `role = 'vendor_admin'` and `vendor_id = <claimed vendor>` (no-clobber per §2).
2. **Flip verification** — `UPDATE vendors SET verified = true WHERE id = <vendor>` (idempotent; a guarded predicate keeps concurrent grants safe).
3. **Resolve the request** — `UPDATE vendor_requests SET status='resolved', resolved_by_id, resolved_at WHERE id = :id AND status IN ('open','in_review')` (the guarded-WHERE idiom from `createModerateRequestHandler`).
4. **Workflow transition** — advance/complete the `vendor_claim` `workflow_instances` row + insert the `workflow_transitions` row (`workflowTransitionInsert`).
5. **Audit** — `auditInsert` for the grant. **Record the PO/invoice arrangement in the `audit_log` `metadata`** — this is the launch entitlement record (see §8.3(1) of `STAGE_2_SPEC.md`); no new schema.

**Entitlement launch shape.** `vendors.verified` **is** the launch entitlement bit. The offline PO/invoice arrangement lives in `audit_log` metadata (payer, amount/terms, arranged-by). A formal entitlement model is deferred to the Paid Tiers epic (AECI-515); this epic adds **no new schema**.

**Post-commit (best-effort, `waitUntil`).**

- **Cache purge** — the grant flips `vendors.verified`, which changes the cacheable `/vendors/:slug` page **and** the product pages that embed the vendor tag. Enqueue a Cache-Tag purge onto `CACHE_PURGE_QUEUE` — `{ tags: ['vendor:<slug>'], source: 'moderation' }` — mirroring `purgeProductTag` (`apps/api/src/routes/admin-reviews.ts` ~:135-147). **Note:** the existing request-moderation path deliberately skips purge (a `vendor_request` renders on no cacheable page); the grant path **must add it** because it mutates `vendors`.
- **Claim-approved email** — §9 / AECI-528.

**Reject path.** `UPDATE vendor_requests SET status='rejected'` + workflow `rejected` + audit; no vendor mutation, no purge; fire the claim-rejected email (§9). `TERMINAL_OUTCOME` maps `resolved→completed`, `rejected→rejected` (as in the reviews/requests handlers).

**Reversibility.** Grants are app-side and reversible — a later revoke (§7) is a separate audited write; it removes the seat but does **not** by itself un-verify the vendor (see §7 seat semantics).

---

## 4. Vendor authorization seam & `/api/vendor/*` (AECI-520)

**Parallel with §3.** Extends the 3-layer Worker model (`AUTH_AND_RLS.md` §4) to `vendor_admin`; **no RLS** (`STAGE_2_SPEC.md` §4.1).

**Guard extension.** Today `createAuthzMiddleware` (`apps/api/src/lib/authz.ts` ~:157-197) hard-codes `requiredRole: 'admin' | null` and the `AuthenticatedSession` (~:56-64) carries `userId`/`email`/`role` but **not** `vendorId`. AECI-520:

- Adds a `vendor_admin` branch — a `requireVendor()` guard (sibling of `requireAdmin()`) that requires `role === 'vendor_admin'` and a non-null `vendor_id`.
- Adds `vendorId` to `AuthenticatedSession` and to the D1 profile re-fetch (currently selects `role`, `bannedAt`, `banReason`; add `vendorId`), so handlers can scope by it.
- Keeps the existing **ban check** (`banned_at` → 403) ahead of the role check — this is the §7 gate.

**Query scoping (the core invariant).** Every `/api/vendor/*` read and write is scoped by the session's `vendor_id` in the Drizzle query (`WHERE vendor_id = :sessionVendorId`) — the Worker never trusts a client-supplied vendor/target id without checking ownership against the session. This is the D1/Drizzle replacement for the RLS row filter §18 assumed. Every write emits its `audit_log` row in the same `db.batch()` (§26.1).

**Endpoint surface (contract-level; detailed Zod shapes land in `API_CONTRACTS.md` when AECI-520 builds).** Mirrors `/api/admin/*`. At minimum:

| Endpoint | Purpose |
|---|---|
| `GET /api/vendor/me` | The signed-in vendor's dashboard payload (vendor + owned products + claim/correction status + seats) |
| `PATCH /api/vendor/products/:id` | Edit owned product content within guard-rails (see §6) |
| `PATCH /api/vendor/profile` | Edit owned vendor content within guard-rails |
| `GET /api/vendor/seats` | List the seats on this vendor (read-only at launch) |

Guard-rails, exact field allow-lists, and the taxonomy-edit constraints are defined in §6 and pinned as Zod in `API_CONTRACTS.md` at build. **Not in scope for the kickoff — this section defines the surface + the authz seam, not the request schemas.**

---

## 5. Admin claim-review surface (AECI-521)

**Reviewer-assisted verification — no auto-grant (`STAGE_2_SPEC.md` §8.1(1)).** The AECi-facing UI presents **verification signals** and a human decides; approve triggers §3, reject triggers §3's reject path + §9 email.

**Signals surfaced (enrichment at launch — §8.3(4)).**

- **Email-domain match** — `domain_match` (already computed at submit via `computeDomainMatch`) against the vendor's known domain(s).
- **A pre-built LinkedIn/person search link** — a constructed search URL from `submitter_email` / `submitter_name`, opened by the reviewer. A **link only** — real person-lookup providers (data enrichment APIs) are a **deferred DPA/GDPR decision**, out of scope at launch.

**UI pattern.** A new `/admin/claims` child surface cloning the existing admin request queue:

- **Route** — add a child to the `/admin` layout route (`apps/web/src/app/app.routes.ts` ~:224-243), e.g. `{ path: 'claims', loadComponent: … ClaimQueue }`.
- **Shell nav** — add a nav `<li>` in `AdminShell` (`apps/web/src/app/admin/admin-shell.ts`) after the requests link. The `/admin` gate (`summary() === null` → `<aec-not-found/>`) already hides the surface from non-admins.
- **Component** — `ClaimQueue` copies `RequestQueue` (`apps/web/src/app/admin/requests/request-queue.ts`); `AdminClaimsApi` mirrors `AdminRequestsApi` (`GET /api/admin/claims`, `PATCH /api/admin/claims/:id`), same-origin cookie auth behind `requireAdmin()`.
- **Badge (optional)** — a pending-claims count would extend `AdminSummaryStore` (`apps/web/src/app/admin/admin-summary.store.ts`) + the summary API (`apps/api/src/routes/admin-summary.ts`), which today counts pending reviews only. Follow the requests-queue precedent (no badge) unless a count is wanted.

The moderation handler behind these routes clones `createModerateRequestHandler`, wired to the §3 grant/reject batch (not the plain request resolve).

---

## 6. Vendor dashboard UI (AECI-522)

The signed-in vendor's home, backed by `/api/vendor/*` (§4). **Multi-seat, flat (§8.1(2))** — several `vendor_admin` seats share one `vendor_id`; each was individually granted through §5. **Self-serve invite/revoke and an owner/admin distinction are deferred** (need a small schema add — §11).

- **Edit product/vendor content within guard-rails** — name, description, links, and taxonomy **within guard-rails** (the editable field allow-list + which taxonomy edits are vendor-permitted vs admin-only are pinned in `API_CONTRACTS.md` at build). Every save is a `vendor_id`-scoped write with its audit row (§4) and purges the affected `vendor:<slug>` / `product:<slug>` tag (§3, §8).
- **Claim / correction status** — surface the vendor's `vendor_requests` (claim + correction) states.
- **Verified badge management** — show verification state; the badge itself is AECi-controlled (`vendors.verified`), not vendor-toggled.
- **Seat list** — read-only roster of the vendor's seats at launch.

Design work runs the `apps/web` UI checklist (`CLAUDE.md` §"Design checklist"): critique the surface, pick a Mobbin anchor, build via Impeccable, run axe locally. **Light theme only at launch** — dark returns in the separate Dark-Theme epic (`STAGE_2_SPEC.md` §2.5), not here.

---

## 7. Moderation escalation — ban gate (AECI-524)

**The gate check ships with §4** (`banned_at` → 403 in the guard, ahead of the role check). This section owns the ban **action** + policy.

- **Ban action** — an admin sets `profiles.banned_at` / `ban_reason` on a `vendor_admin` seat (reusing the existing Layer-1 ban mechanism, `AUTH_AND_RLS.md` §7). Audited like any state change.
- **Seat semantics (§8.3(2)).** Ban and revoke are **per-seat** — they touch one `profiles` row and **never** touch `vendors.verified` (that is vendor-level, paid entitlement state). Banning one abusive seat leaves the vendor verified and its other seats working. **Un-verifying** a vendor is a **separate entitlement action** (not a ban).
- **Effect.** A banned seat fails the §4 guard on every `/api/vendor/*` call (403) — portal abuse is a ban path, not a delete.

---

## 8. Verified-badge activation — trust surface (AECI-523) & search (AECI-529)

`vendors.verified` already exists and is indexed (§1.2); Stage 2 lights it up. The free/default state stays the unclaimed, AECi-curated **"Unverified"** baseline.

### 8.1 SSR trust surface (AECI-523)

Render the verified badge on the SSR detail surfaces (vendor detail, and product pages where the built-by vendor is shown). Immediate freshness: a §3 grant enqueues a `vendor:<slug>` Cache-Tag purge (§3), so the badge appears on the next request after approval. The badge is a **trust** signal — never gated by pay-for-placement, never conflated with ranking (§1).

### 8.2 Search surfaces (AECI-529)

Thread the existing `vendors.verified` column into the Algolia vendor record. Four **lockstep** edits (miss one and the field silently drops):

1. `algoliaVendorConfig.columns` — add `verified` to the queried columns (`apps/api/src/lib/algolia-transforms.ts` ~:83-105).
2. `RawAlgoliaVendorRow` — add the field (~:149-161).
3. `toAlgoliaVendor` — map it into the record (~:198-210).
4. `AlgoliaVendorRecordSchema` — add `verified: z.boolean()` (`packages/shared/src/algolia-records.ts` ~:59-69).

**Freshness contract (§8.3(5)).** Vendor edits and badge flips reach **Algolia on the nightly watermark sync** (`runDailySync`, `apps/api/src/lib/algolia-sync.ts`) — **≤24h**, since an edit bumps `updated_at` which the next window picks up (an immediate by-id `indexEntity` hook like `syncPromoteTargets` is optional if faster search is later wanted). **SSR is immediate** via the §3 Cache-Tag purge. **Accepted for launch — UI copy must not promise instant search.** `verified` becomes a facet/filter, never a ranking signal (no pay-for-placement).

---

## 9. Claim-decision emails (AECI-528)

Claim approved / rejected notifications over **Resend** (`apps/api/src/lib/email.ts`; `docs/email.md`), fail-open — runs alongside the rest.

- Add `'claim-approved'` and `'claim-rejected'` to the `EmailTemplate` union (~:60-72) — the id is also the `template:` metric tag on `aeci.email.send`.
- Add `sendClaimApprovedEmail` / `sendClaimRejectedEmail` helpers modeled on `sendReviewApprovedEmail` / `sendReviewRejectedEmail` (~:168-220): build `text`/`html` via `toText()`/`toHtml()`, call `sendTransactionalEmail` (never throws; absent key/sender/recipient → `'skipped'`).
- Fire from the §3 grant/reject handler via `c.executionCtx.waitUntil(...)`, to the claim's `submitter_email`.
- Update the template catalogue in `docs/email.md`.

Billing/invoice notices are a Paid-Tiers concern (`STAGE_2_SPEC.md` §2.2 / AECI-515), not this issue.

---

## 10. Document `vendor_admin` authz (AECI-525)

Complete `AUTH_AND_RLS.md` for `vendor_admin`. The **kickoff** already seeds the de-staling — §9 rewritten to the 3-layer Worker model, the §4.1 file-path fix, the §3 roles-row update. AECI-525 finishes it **once §4 lands**:

- Add the `vendor_admin` rows to the §4.4 endpoint-by-endpoint table (`/api/vendor/*` auth + scope + audit expectations).
- Document the `requireVendor()` guard + `vendor_id` query-scoping invariant (§4 here) as the canonical pattern.
- Document the ban gate for vendor seats (§7) and the app-layer grant/revoke seam.

---

## 11. Out of scope / deferred

Explicitly **not** in this epic (tracked elsewhere or later):

- **Self-serve seat invite/revoke + owner/admin distinction** — needs a small schema add; deferred (`STAGE_2_SPEC.md` §8.1(2)). Launch is admin-granted seats only.
- **Paid-tier ladder above the entry Verified fee, automated billing, self-serve card, offline-invoicing mechanics** (renewal/expiry/dunning) — the Paid Tiers epic (AECI-515); still open in `STAGE_2_SPEC.md` §8.2.
- **Real-time / live vendor edits** — the Real-Time epic (AECI-516); transport (Durable Objects vs SSE vs revalidation) deferred. The portal ships without persistent sockets.
- **Integration attestation authoring / conflict UI / version-diff** — the Integration Attestations epic (activates the dormant `vendor_a`/`vendor_b` sources); `STAGE_2_SPEC.md` §2.4.
- **Person-lookup enrichment providers** — deferred DPA/GDPR decision (§5 surfaces a link only).
- **Dark theme** — the Dark-Theme Reintroduction epic; `STAGE_2_SPEC.md` §2.5.
- **A public/partner write API** — the "no public API surface" boundary is unchanged (`STAGE_2_SPEC.md` §9).

---

## 12. Cross-references

| Topic | Doc |
|---|---|
| Layer-1 Worker authz (JWT → role/ban → scope) | `AUTH_AND_RLS.md` (extended by §4/§7/§10) |
| `/api/vendor/*` request/response Zod shapes | `API_CONTRACTS.md` (added by AECI-520) |
| D1 schema | `apps/api/src/db/schema.ts` + `DATABASE_SCHEMA.md` (§1.2 — no migration) |
| Transactional email | `email.md` (§9) |
| Cache-Tag purge (queue producer + tag map) | `CACHE_STRATEGY.md` (§3/§8) |
| Algolia index settings + `verified` facet | `SEARCH_RANKING.md` (§8) |
| Stage 2 scope, decisions, epic map | `STAGE_2_SPEC.md` (§2.1 scope, §8.3 decisions) |

---

*This is the build contract for AECI-513. As each sub-issue lands, keep this doc current with the code (per the "update all documents" rule) — the file/line references in §1.2, §1.3, and §8.2 are anchors, not guarantees; verify them before editing the cited files.*
