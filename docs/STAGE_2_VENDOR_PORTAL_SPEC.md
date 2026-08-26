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
| §2 | AECI-527 | Claimant identity resolution — GoTrue email→user seam, provisioning path, profile-ensure no-clobber |
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
527 (identity) → 530 (service-role key) → 519 (grant) ∥ 520 (authz seam + /api/vendor/*)
                                       → 521 (admin review) + 522 (dashboard)
                                       → 523 (badge SSR) / 524 (ban) / 529 (badge search)
525 (authz doc) + 528 (claim emails) run alongside.
```

`527` blocks `519` (the grant needs a resolved identity to link). **`530` also blocked `519`** — it provisions `SUPABASE_SERVICE_ROLE_KEY` on the API Worker, without which resolution can only ever report `unavailable` in a deployed environment (§2, "Graceful degrade"); `527` itself was *not* blocked by it, since degrading is by design and the unit lane needs no key. **`530` has shipped:** CI now pushes the key to the API Worker on staging, demo and production (PR previews and local stay keyless by design). `519` and `520` are parallel (the grant flow and the authz seam share nothing but the schema). The ban gate **check** ships with `520`; `524` owns the ban **action** + policy. `528` (emails) and `525` (authz doc) have no code dependency and run whenever.

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

**What does NOT exist yet** (the net-new work of this epic; shipped items struck through as sub-issues land): ~~the GoTrue **invite** + **email→user lookup** path~~ (AECI-527, shipped: `lib/supabase-admin.ts` + `lib/claimant-identity.ts`), ~~the `vendor_admin` guard branch + `vendorId` on the session + the `/api/vendor/*` surface~~ (AECI-520, shipped), ~~the account-grant / role-grant code~~ (AECI-519, shipped: `PATCH /api/admin/claims/:id`, `lib/vendor-grant.ts` — see §3 "As built"), the `/admin/claims` UI (AECI-521), ~~the claim-decision email *sender*~~ (AECI-528, shipped: `lib/email.ts` `sendClaimApprovedEmail`/`sendClaimRejectedEmail` + the `sendClaimDecisionEmail` adapter, injected at `index.ts` into the grant/reject seam), and the `verified` field on the Algolia index (AECI-529).

---

## 2. Claimant identity resolution (AECI-527)

**Blocks §3.** The `vendor_requests` claim record carries `submitter_email` **only** — there is no user account attached at submit time (the form is anonymous). Before a claim can be granted, that email must resolve to a Supabase `auth.users` identity so the D1 `profiles` row (keyed by the auth-user UUID) can be linked to the vendor.

**The seam.** Provisioning is an **app-layer seam** — there is no cross-system FK between Supabase `auth.users` and D1 `profiles` (AECI-254), identical to how the `admin` role is granted (`AUTH_AND_RLS.md` §3). `profiles.id` is a plain text PK, keyed **by convention** to `auth.users.id` = the JWT `sub`.

**Resolution paths.** When AECi approves a claim (§3), resolve `submitter_email` to an auth user:

1. **Existing user** — look the email up via the GoTrue Admin API and reuse its id. Shipped as `findAuthUserByEmail` (seam #4a, `apps/api/src/lib/supabase-admin.ts`), reusing the existing `adminConfig` / `adminHeaders` scaffolding.
2. **New user (invite path)** — if no auth user exists for the email, provision one through the GoTrue Admin API. Shipped as `createAuthUser` (seam #4b).

Either way, the resolved auth-user id is the id used to write the `profiles` row in the §3 grant batch.

> **⚠️ `?filter=` is a substring match, so the exact-match guard is load-bearing.** GoTrue has **no** by-email endpoint. `GET /admin/users?filter=q` runs
> `WHERE (email LIKE '%q%' OR raw_user_meta_data->>'full_name' ILIKE '%q%')` — case-**sensitive** on email, and it also matches display names. So the lookup queries with the **lowercased** address (GoTrue stores lowercase) and then requires an exact, case-insensitive equality on `users[].email` client-side. Without that second step `jane@acme.com` matches `jane@acme.com.evil.io`, and any account whose `full_name` contains the string — i.e. a claim granted against the **wrong** auth user. Treat the two guard tests in `supabase-admin.spec.ts` as non-negotiable.

**Provisioning does NOT send a GoTrue invite email — a deliberate deviation (AECI-527).** The original AC said `POST /auth/v1/invite`; the seam uses `POST /auth/v1/admin/users` with `email_confirm: true` instead, because:

- **The invite link dead-ends today.** GoTrue's invite email links to `/auth/v1/verify?type=invite&redirect_to=…`, which redirects with the session in a URL **fragment**. `apps/web`'s `/auth/callback` requires a PKCE `?code=` and 302s to `/auth/login?error=missing_code` otherwise (`apps/web/src/server/routes/auth-callback.ts`). Sending a broken link is worse than sending none.
- **It would need dashboard ops on the production auth project.** The GoTrue "Invite user" template and a `redirect_to` allow-list entry live on the **one shared** project (ADR 0017), so editing them changes prod. `environments.md` documents the silent fallback to Site URL when a `redirect_to` isn't allow-listed.
- **We already own a better channel.** `email_confirm: true` makes the account immediately usable through the existing, proven magic-link login, and onboarding comms are the `claim-approved` Resend email (§9 / AECI-528) — copy we control, with a metric. The launch claim flow is concierge (`STAGE_2_SPEC.md` §8.1), so a human is already in the loop.

Adopting the GoTrue invite later is a change to `createAuthUser` **only** — the resolution contract and its `invited` outcome are unaffected. Its prerequisites (a real Invite-user template, the allow-list entry, and a landing page that consumes a fragment session) are recorded in `docs/email.md`. **The invite email is not an `apps/api` send**: it would be dispatched by GoTrue over the project's Resend SMTP, emits no `aeci.email.send` metric, and therefore is **not** part of §9's template set — AECI-528 must not add it to `lib/email.ts`.

**Resolution contract.** `resolveClaimantIdentity(db, env, { email, vendorId })` (`apps/api/src/lib/claimant-identity.ts`) composes the two seams with a single D1 `profiles` read and returns a discriminated union — it never throws, and it never maps HTTP (this is a `lib/` seam; §3 owns the endpoint):

| `outcome` | Meaning | Carries |
|---|---|---|
| `linked` | An `auth.users` row already owned `submitter_email`; reuse its id. | `userId`, `email`, `profile` (the D1 snapshot, or `null` if the account has never signed in) |
| `invited` | No auth user existed; one was provisioned. | `userId`, `email`, `profile: null` |
| `not_found` | No auth user existed **and** provisioning was not requested (`provision: false`, a terminal-claim re-approve). Distinct from `unavailable`: the lookup succeeded, the account simply does not exist and none was created. | — |
| `conflict` | Exclusivity violation — an explicit error, never a silent overwrite. | `reason: 'already_admin' \| 'other_vendor'`, `userId`, `email`, `profile` |
| `unavailable` | `SUPABASE_SERVICE_ROLE_KEY` absent — local dev and PR previews only, since AECI-530 pushes it on staging/demo/production. Resolution is **impossible**, not negative — the grant must refuse rather than half-grant. | — |
| `error` | GoTrue reachable but errored. | `stage: 'lookup' \| 'create'`, `status?`, `message?` |

- **A second seat on the same vendor is `linked`, not `conflict`.** This is the branch most likely to be got wrong: `role`/`vendor_id` are single-valued, but multi-seat is schema-native (no uniqueness on `profiles.vendor_id`), so only a *different* `vendor_id` conflicts. An `admin` account conflicts regardless of its `vendor_id`.
- **A conflict is decided before any account is created.** The order is lookup → create-if-absent → profile read → classify; since a conflict requires an existing auth user, no provisioning is ever spent on a claim that is then rejected.
- **Terminal re-approve resolves lookup-only (no orphan).** `resolveClaimantIdentity` takes an optional `provision` (default `true`). §3 passes `provision: false` when re-approving an already-`resolved` claim — the only valid re-approve there is the idempotent same-seat no-op, which needs an *existing* account. A `resolved` claim whose claimant was deleted (e.g. GDPR erasure) then returns `not_found` → 422 **without** provisioning an orphan `auth.users` row. *(Review-pass hardening, 2026-08-14: the initial build resolved terminal claims with provisioning on, so a gone-claimant re-approve created an orphan before 422-ing.)*
- **Idempotency.** Re-running resolution for the same email is stable: once provisioned, a re-run returns `linked`, never a second create. GoTrue's create is *not* idempotent — it answers `422 email_exists` — so the resolver treats that as a lookup miss, re-resolves **once**, and surfaces an explicit `error` if the second lookup still misses (rather than guessing at an account).
- **`vendorId` must be a VENDOR id.** For a `target_type='product'` claim, §3 resolves the product's vendor before calling; passing a product id compares against a value `profiles.vendor_id` can never hold, so exclusivity would silently never fire.
- **HTTP mapping is AECI-519's** (it owns the endpoint and the `API_CONTRACTS.md` §4 error-table edit). Intended: `linked`/`invited` → 200 and the grant proceeds; `conflict` → **409** with a new `GRANT_CONFLICT` code and `details.reason` (§4.1 assigns 409 to state conflicts with an existing record, cf. `SLUG_CONFLICT` — not 422, which is for business-rule violations); `unavailable`/`error` → **503 `DEPENDENCY_FAILURE`**, already documented as "upstream dependency (Supabase, Algolia, Linear) failed". One new code is the minimum; resist a second.

**Reviewer signal (feeds §5).** `has_auth_account` on `AdminVendorRequest` answers "does an auth user already exist for this submitter?", so the reviewer knows before approving whether the grant will **link** or **provision**. Computed on the LIST path only, via the batched `fetchAuthAccountsByEmail` (one deduped GoTrue lookup per distinct claim email, run in parallel with the target hydration). Tri-state: `null` means **unknown** — a correction row, absent creds, or a failed lookup — and must never be rendered as "no account".

**Profile-ensure no-clobber contract.** The `profiles` row is created idempotently and **never clobbered**. Reuse the pattern in `POST /api/auth/profile/ensure` (`apps/api/src/routes/auth-profile.ts` ~:50-79): `INSERT … ON CONFLICT DO NOTHING … RETURNING`, so a grant that lands after the claimant has already signed in (and self-created a default `reviewer` profile) **updates** the existing row's `role`/`vendor_id` rather than replacing it. The grant must not reset `display_name`, `theme_preference`, or any field it does not own.

**Graceful degrade.** `SUPABASE_SERVICE_ROLE_KEY` is optional and absent in local dev / PR previews (AECI-530 pushes it to the API Worker on staging, demo and production only). The identity-resolution helpers **degrade gracefully** when creds are absent (the pattern `deleteAuthUser` / `fetchAuthUserEmails` already follow — return a skipped/empty result, never throw), so the grant path is testable without a live Supabase. The single-shot seams flag that case as `skipped: true`, which callers MUST distinguish from a successful "no such user" — conflating them would provision a duplicate account.

> **The key is CI-pushed to the API Worker on staging, demo and production (AECI-530)**, so seams #2/#3/#4 are live on those tiers. It was previously pushed to no Worker — `environments.md` and `CICD_PLAN.md` carried the pre-ADR-0016 "never on a Worker" posture, which ADR 0016 §6 had superseded without updating them; AECI-530 reconciled the workflows and the docs. **Local dev and per-PR previews still carry no key** (the preview omission is deliberate — see `pr-preview.yml`), so the seams degrade there exactly as tabled. The related GDPR consequence — seam #3's skip is silent, so erasure leaves orphaned `auth.users` rows undetectably — is still open as **AECI-531**.

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

> **Superseded (AECI-515, 2026-08-19).** That was the AECI-513 launch shape, and the Paid Tiers epic is the successor it named. `vendors.verified` is now a **denormalized mirror** of a `vendor_entitlements` row — `true` **iff** an `active` row exists — maintained in the same `db.batch`; the arrangement lives in the row **as well as** the audit trail, which stays the renewal ledger. The "no new schema" clause held for this epic and was spent by that one: `0019_easy_sandman` is the single migration.
>
> **Nothing AECI-513 shipped against this bullet changed in behaviour** — the grant still writes the seat, still flips the bit, still records the arrangement in audit metadata; every reader still reads `verified`, and no public or read path may query the entitlement table. The one structural change is that after AECI-612 the flip is **emitted by `lib/vendor-entitlement.ts`, not by `grantSeatStatements`**, so the mirror has exactly one writer. See `docs/STAGE_2_PAID_TIERS_SPEC.md` §2 and `STAGE_2_SPEC.md` §8.5.

**Post-commit (best-effort, `waitUntil`).**

- **Cache purge** — the grant flips `vendors.verified`, which changes the cacheable `/vendors/:slug` page **and** the product pages that embed the vendor tag. Enqueue a Cache-Tag purge onto `CACHE_PURGE_QUEUE` — `{ tags: ['vendor:<slug>'], source: 'moderation' }` — mirroring `purgeProductTag` (`apps/api/src/routes/admin-reviews.ts` ~:135-147). **Note:** the existing request-moderation path deliberately skips purge (a `vendor_request` renders on no cacheable page); the grant path **must add it** because it mutates `vendors`.
- **Claim-approved email** — §9 / AECI-528.

**Reject path.** `UPDATE vendor_requests SET status='rejected'` + workflow `rejected` + audit; no vendor mutation, no purge; fire the claim-rejected email (§9). `TERMINAL_OUTCOME` maps `resolved→completed`, `rejected→rejected` (as in the reviews/requests handlers).

**Reversibility.** Grants are app-side and reversible — a later revoke (§7) is a separate audited write; it removes the seat but does **not** by itself un-verify the vendor (see §7 seat semantics).

> **This flow is now the ONLY writer of `vendors.verified`.** AECI-520 removed the column from the promote payload's writable set (§4.2) because a routine Airtable push could otherwise silently un-verify a paying vendor. This section's `UPDATE vendors SET verified = true` (step 2) is the sole SET path; the **un-verify** half (the "separate entitlement action" §7 defers) had no owner at the close of this epic — a seat revoke (below / AECI-524) deliberately never un-verifies. **It has one now: AECI-532** (`PATCH /api/admin/vendors/:id/entitlement`, `set` / `renew` / `clear`), specified in `docs/STAGE_2_PAID_TIERS_SPEC.md` §5. Clearing an entitlement does **not** revoke seats — the vendor keeps portal access, read-only. The bit is read by the public vendor API shapes and the `GET /api/vendors?verified=` filter, and — as of AECI-523 — **rendered as the verified badge on the SSR detail surfaces** (§8.1); it is still **not in the Algolia record** (AECI-529).

### 3.1 As built (AECI-519 — 2026-07-25)

Shipped with **no migration**. Contracts: `packages/shared/src/api/admin-claims.ts` (`ModerateClaimSchema` / `ModerateClaimResponseSchema` + `GRANT_CONFLICT` in `errors/codes.ts`); pure batch-builders: `apps/api/src/lib/vendor-grant.ts`; handler: `apps/api/src/routes/admin-claims.ts`; full contract in `API_CONTRACTS.md` §6.10. Decisions taken at build that this section did not pre-specify:

- **New endpoint, not an extension.** The grant is `PATCH /api/admin/claims/:id` (a clone of `createModerateRequestHandler`), a sibling of `PATCH /api/admin/requests/:id`. The requests endpoint is **left untouched** (still resolves corrections); the claims endpoint **422s a non-claim** request so a claim can't be plain-resolved without granting. The `/admin/claims` LIST is AECI-521; this issue is the PATCH (grant mechanics) only.
- **`updated_at` is stamped explicitly** on the verified flip (`SET verified = true, updated_at = <now>`, not left to `$onUpdate`), matching `routes/vendor.ts`, so the AECI-529 Algolia watermark reliably moves. The flip is guarded on `verified = false`, so a **second-seat grant is a no-op** there — no re-flip, no `updated_at` churn, and the audit records `verified_flipped: false`.
- **Idempotency is explicit.** A re-grant of a claim already `resolved` to the exact same seat returns **200 with no batch and no audit row** (metric `outcome:noop`); any other terminal state is a genuine `422`.
- **Entitlement shape.** The optional `entitlement` body object (`payer` / `amount` / `terms` / `arranged_by` / `notes`) is recorded verbatim in the grant `audit_log` metadata (§8.3(1)) — no `vendors.admin_notes` mirror, no new column.
- **Product claims resolve the primary vendor.** A `target_type='product'` claim grants the product's `is_primary` vendor (any `product_vendors` row is the fallback), so `resolveClaimantIdentity` always receives a vendor id (§2).
- **Purge = vendor + its products.** Post-commit enqueues `{ tags: ['vendor:<slug>', 'product:<slug>'…, 'index:products'], source: 'moderation' }` — the vendor page plus every product page that embeds it.
- **Revoke is a mechanic, not an endpoint.** `revokeSeatStatements` (in `vendor-grant.ts`, exported + unit-tested) drops a seat to `reviewer` + unlinks `vendor_id`, audited (`vendor_claim.seat_revoked`), and **never touches `vendors.verified`** (§8.3(2)). **Still no HTTP surface:** AECI-524 wired the ban gate only (§7) and deliberately left revoke unwired (its AC scopes un-granting out); self-serve invite/revoke is deferred (§11). The batch shape stays pinned for whichever issue wires it.
- **503 only where the key is absent (since AECI-530).** `SUPABASE_SERVICE_ROLE_KEY` is CI-pushed to the API Worker on staging, demo and production, so `approve` resolves there. On **PR previews and local dev** the key is absent by design and `approve` reports `DEPENDENCY_FAILURE` (503); the code is fully unit-tested via the injected `resolveClaimantIdentity` seam. `reject` needs no resolution and works regardless.

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
| `GET /api/vendor/me` | The signed-in vendor's dashboard payload (vendor + owned products + claim/correction status + seat count) |
| `PATCH /api/vendor/products/:id` | Edit owned product content within guard-rails (see §6) |
| `PATCH /api/vendor/profile` | Edit owned vendor content within guard-rails |
| `GET /api/vendor/seats` | List the seats on this vendor (read-only at launch) |

Guard-rails, exact field allow-lists, and the taxonomy-edit constraints are defined in §6 and pinned as Zod in `API_CONTRACTS.md`.

### 4.1 As built (AECI-520 — 2026-07-25)

All four endpoints shipped with pinned Zod, **no migration**. Contracts live in `packages/shared/src/api/vendor.ts`, handlers in `apps/api/src/routes/vendor.ts`, full documentation in `API_CONTRACTS.md` §6.14. Decisions taken at build that this section did not pre-specify:

- **Editable allow-list = content + links + taxonomy.** Product: `description`, `website`, `tool_integrations_url`, `api_docs_url`, `logo_url`, plus category/audience/phase assignment. Vendor: `description`, `website`, `headquarters`, `founded_year`, `public_private`, `parent_company`, `contact_email`, `phone_number`, `logo_url`, profile URLs. **Vendors assign existing taxonomy terms only** — minting a term stays an AECi curation act, so an unknown slug is a `400`, not a silent drop. `name`/`slug` are not vendor-editable (a rename breaks the URL, the Algolia record, and every inbound link — it stays a correction request).
- **Cross-vendor access returns `404`, not `403`.** A non-owner must not learn that another vendor's product exists. Ownership is proven against `product_vendors` in its own read wave, before anything else runs.
- **A site `admin` is rejected with `403`.** No impersonation at launch; admins act through `/api/admin/*` so the audit trail names the real actor. A `vendor_admin` with a null `vendor_id` is likewise rejected.
- **Audit rows use `actor_type: 'user'`** — the `audit_log_actor_type_check` CHECK has no `vendor` value and this epic ships no migration — and are distinguished by `metadata.source = 'vendor-portal'`.
- **Purge tags.** Profile edit → `vendor:{slug}`. Product edit → `product:{slug}` + `index:products` + the taxonomy tags for the **union** of facet membership before and after (the browse page a product *joins* never carried its `product:` tag, so the union is what stops it going stale). Every vendor write stamps `products.updated_at`, including a taxonomy-only edit, or the nightly Algolia watermark would never see it.

### 4.2 Review-app counterpart: claimed vendors are not promote-writable

A conflict §4 did not anticipate: `POST /api/promote` writes an overlapping column set, so an ordinary Airtable push would silently revert a vendor's edits. AECI-520 therefore blocks the review app from writing to a **claimed** vendor or any product it owns — wholesale, all columns — while everything else in the payload still promotes. Creates are never blocked. Blocked entities are omitted from the response and reported in `skipped[]` (new kinds `vendor` / `product`). See `API_CONTRACTS.md` §6.12 and `REVIEW_APP_PROMOTE_API.md` §4a.

**"Claimed" means at least one ACTIVE seat** — a `profiles` row with `role = 'vendor_admin'`, a matching `vendor_id`, and `banned_at IS NULL`. Seat existence is the signal rather than `vendors.verified` precisely because it cannot be set from Airtable. The ban exclusion is what keeps §7 moderation from locking a record: banning a vendor's only admin fails their portal calls **and**, without it, would leave promote refused too — so the content AECi banned them over would be the one thing nobody could correct. Ban stays per-seat (§7), so a vendor with another active seat is unaffected.

`verified` was also **dropped from promote's vendor update** — it is the paid entitlement bit, set by the §3 grant and cleared only by a deliberate entitlement action, so a routine push must not move it (it previously could silently un-verify a paying vendor). It stays accepted-and-ignored in `PromoteVendorSchema`, so no lockstep review-app deploy was needed. **Consequence: until §3 (AECI-519) lands there is no writer for `vendors.verified` at all** — see §3.

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

### 5.1 As built (AECI-521 — 2026-07-25)

Shipped with **no migration**. The AECI-519 `PATCH /api/admin/claims/:id` already existed; this issue added the LIST endpoint + the reviewer surface, wired to that PATCH. Contracts: `packages/shared/src/api/admin-claims.ts` (`AdminClaim` / `ListVendorClaims{Query,Response}` schemas); handler: `createAdminClaimsListHandler` in `apps/api/src/routes/admin-claims.ts`; mapper `toAdminClaim` in `apps/api/src/lib/drizzle-helpers.ts`; surface under `apps/web/src/app/admin/claims/`; full contract in `API_CONTRACTS.md` §6.10 (`GET /api/admin/claims`). Decisions taken at build:

- **New endpoint, cloning the requests LIST.** `GET /api/admin/claims` mirrors `createAdminRequestsListHandler` (same `PageQuerySchema` envelope, same read-time `is_duplicate` groupBy + the `fetchAuthAccountsByEmail` `has_auth_account` seam) but is **claims-only** (`kind='claim'`, no `kind` filter) and **read-only** (no audit). `status` filter is `open|resolved|rejected` (default `open`), matching the requests contract.
- **`AdminClaim` = `AdminVendorRequest` + three signals.** The shared `AdminVendorRequest` already carried `domain_match` + `has_auth_account`; `AdminClaim` extends it with `duplicate_of_request_id`, `existing_seats`, and `related_requests`. `duplicateOfRequestId` was added to `adminVendorRequestConfig` + `RawAdminVendorRequestRow` (harmless to the requests path; only `toAdminClaim` surfaces it).
- **`null` = unavailable, `[]` = empty.** `existing_seats` / `related_requests` are **nullable**: `null` means the enrichment query failed and the UI renders "unavailable" (AC: graceful degrade); `[]` means computed-and-empty (a genuine first claim / no priors). Both enrichment queries run `.catch(() => null)`, so a signal failure never fails the list.
- **Existing seats = one grouped `profiles` scan.** Per-claim target vendor is resolved first (a `product` claim → its primary vendor, a batched clone of `resolveTargetVendor`), then one `profiles` query over the page's vendor ids (`role='vendor_admin' AND banned_at IS NULL`) — no per-row N+1. Each seat carries `display_name` + `work_email_verified` + `created_at` (no email — a seat belongs to the vendor). This covers the issue's `work_email_verified` bullet for seats; the **claimant's own** `work_email_verified`/profile-history is **omitted** — `profiles` is keyed by auth-user UUID, not email, so it isn't cheap on the read path.
- **LinkedIn link is client-built, a link only.** `linkedInSearchUrl()` builds `…/search/results/people/?keywords=<name||email>` in the component — no claimant data leaves AECi at render time (§8.3(4)). Real person-lookup/enrichment providers stay a deferred DPA/GDPR decision (§11).
- **Approve captures a free-text note only.** The reviewer surface exposes a single optional "arrangement notes" field on Grant, submitted as `entitlement.notes` (the offline PO/invoice record, §8.1(5) → grant audit metadata). The structured `payer`/`amount`/`terms`/`arranged_by` fields stay accepted by the AECI-519 API but are hidden at launch.
- **The surface is a `/admin/requests` clone.** New `/admin/claims` child route + a no-badge nav `<li>` in `AdminShell` (the requests precedent), `AdminClaimsApi` mirroring `AdminRequestsApi`, `ClaimQueue` cloning `RequestQueue` (SSR shell + `afterNextRender` client fetch behind the shared `/admin` gate). Error handling: **409 `GRANT_CONFLICT`** and **503 `DEPENDENCY_FAILURE`** keep the row with an inline explanation; **422** drops it as already-moderated.
- **503 only where the key is absent (since AECI-530).** `SUPABASE_SERVICE_ROLE_KEY` is CI-pushed to the API Worker on staging, demo and production, so the AECI-519 grant resolves there. Wherever the key is absent — PR previews and local dev — the grant reports `DEPENDENCY_FAILURE` (503) and the surface renders that as "Grant unavailable — the identity service isn't configured. Reject still works." Reject needs no resolution and works everywhere.
- **Design anchor.** Internal surface → the binding anchor is the existing `/admin/requests` queue (Anchor-Site Rule — it must read as a sibling); externally validated against the Reddit mod-queue pattern (card-per-item list + status badge + inline approve/reject). `impeccable detect` clean; structural a11y covered by `claim-queue.component.spec.ts`.
- **Claim-decision email is AECI-528's.** The AC "the claimant is notified" is satisfied by the AECI-519 PATCH's already-wired `SendClaimDecisionEmail` no-op seam; AECI-528 injects the real Resend sender. This issue adds no email code.

---

## 6. Vendor dashboard UI (AECI-522)

The signed-in vendor's home, backed by `/api/vendor/*` (§4). **Multi-seat, flat (§8.1(2))** — several `vendor_admin` seats share one `vendor_id`; each was individually granted through §5. **Self-serve invite/revoke and an owner/admin distinction are deferred** (need a small schema add — §11).

- **Edit product/vendor content within guard-rails** — name, description, links, and taxonomy **within guard-rails** (the editable field allow-list + which taxonomy edits are vendor-permitted vs admin-only are pinned in `API_CONTRACTS.md` at build). Every save is a `vendor_id`-scoped write with its audit row (§4) and purges the affected `vendor:<slug>` / `product:<slug>` tag (§3, §8).
- **Claim / correction status** — surface the vendor's `vendor_requests` (claim + correction) states.
- **Verified badge management** — show verification state; the badge itself is AECi-controlled (`vendors.verified`), not vendor-toggled.
- **Seat list** — read-only roster of the vendor's seats at launch.

Design work runs the `apps/web` UI checklist (`CLAUDE.md` §"Design checklist"): critique the surface, pick a Mobbin anchor, build via Impeccable, run axe locally. **Light theme only at launch** — dark returns in the separate Dark-Theme epic (`STAGE_2_SPEC.md` §2.5), not here.

### 6.1 As built (AECI-522 — 2026-07-25)

Shipped as the Angular `/vendor` surface (singular — the public `/vendors/:slug` detail is a different, cacheable route). Files under `apps/web/src/app/vendor/`. Decisions taken at build:

- **IA — tabbed.** Both a tabbed and a single-page concept were built as live-toggleable previews (`/preview/vendor-dashboard`, the AECI-270 precedent); the PO chose **tabbed** (`vendor-dashboard-tabbed.ts`: a side-nav — Overview / Profile / Products / Seats — over one content panel). It was originally an in-page `@switch` with **no child routes**, so the concept could render identically in the preview and on the real page; **§6.2 replaced that with real child routes** and the same relative-link trick keeps the preview working. The single-page concept (`vendor-dashboard-single.ts`) stays in the tree behind the preview. The presentational pieces (`components/vendor-{verified-status,request-status,seat-roster,profile-form,product-form,products-section}.ts`) are shared by both. **AECI-606** (`STAGE_2_ATTESTATIONS_SPEC.md` §6) adds an Integrations tab and its components (`components/vendor-{integrations-section,integration-card,claim-lane,attestation-control,add-claim-form,notifications-list,attestation-labels}.ts`) to **both** concepts, so the single-page concept does not silently lose a section the tabbed one has.
- **Gate = the `/admin` pattern.** `vendorMeResolver` (`vendor-me.resolver.ts`) calls `GET /api/vendor/me`; a **401/403/404 → 404 render** (`<aec-not-found/>` + `RESPONSE_INIT.status = 404` + noindex), a 200 → the dashboard, a 5xx rethrows. `requireVendor()` rejects anon, reviewers, banned seats, null-`vendor_id` seats, **and site admins** — all surface as the same 404. Non-cacheable + `Cache-Tag`-free by the fail-closed classifier (no `server-runtime.ts` change; the worker login-bounce for anon `/vendor` already shipped with AECI-520). The page sets `robots: noindex`.
- **Edits.** `vendor-profile-form.ts` / `vendor-product-form.ts` are dirty-diff editors validated **live against the shared `UpdateVendorProfile*`/`UpdateVendorProduct*` schemas** (single source of truth; a single-key parse per field). Only changed fields are PATCHed (the endpoint requires ≥1; Save is disabled until a real change); the echo re-seeds the baseline so the form settles clean. **Optimistic + on-demand revalidation, no socket.** Save-confirmation copy never promises instant search — it says the listing updates now and search refreshes within a day (§8.3(5) / AECI-529). Product taxonomy is assigned via `aria-pressed` toggle chips fed by `GET /api/taxonomy` (existing terms only); `name`/`slug` are read-only with a "rename = correction request" hint. `public_private` uses the Angular Aria single-select listbox stand-in (ADR 0010).
- **Header entry point.** A role-gated "Vendor dashboard" link in the signed-in user menu (`layout/user-menu.ts` + `layout/nav-menu.ts`), driven by `VendorStatus` (`vendor/vendor-status.ts`) — the cache-neutral clone of `AdminStatus`: it probes the cheap `GET /api/account` `role` (never `/api/vendor/*`) and stays `false` during SSR.
- **Verified state.** Originally rendered read-only (`vendor-verified-status.ts`) as the launch-minimum entitlement display, with the richer paid-tier display deferred to AECI-515. **That hand-off is now resolved: AECI-614 shipped** (`docs/STAGE_2_PAID_TIERS_SPEC.md` §8/§8.1) and **`vendor-verified-status.ts` is deleted**. Its successor is `vendor/components/vendor-plan-panel.ts` — tier, status, term and resolved capabilities off the `entitlement` block on `GET /api/vendor/me`, across five states (`active` / `expiring` / `pending` / `lapsed` / `none`), with the forms read-only rather than disabled when the entitlement is not active.
- **e2e.** The AECI-235 real-session mint (`apps/web/e2e/auth-session.ts`) was parameterized with a `vendor` persona; `vendor-dashboard.spec.ts` drives `/vendor` + a profile-edit round-trip. Seeded by a `vendor_admin` D1 profile in `apps/api/seed/auth-fixtures.sql` (id = the real vendor test account's Supabase `sub`, anchored to the `...061` fixture vendor). Skips-green until the `SUPABASE_VENDOR_TEST_USER_*` GH secrets are set (see `environments.md`).


### 6.2 As built — the portal gets real URLs (2026-08-26)

The §6.1 dashboard had one URL. Every section was the same address, so nothing on
the portal was linkable, bookmarkable or shareable, Back left the portal entirely
instead of returning to the previous section, and a reload always landed on
Overview. This change gives the surface the browser's navigation model.

**URL shape — `/vendor/:vendorSlug/<section>`.** The vendor slug comes first, the
section after it: `/vendor/acme/overview`, `/vendor/acme/profile`,
`/vendor/acme/products`, `/vendor/acme/products/:productSlug`,
`/vendor/acme/integrations`, `/vendor/acme/seats`. Naming the vendor is not
decoration — today one seat maps to exactly one `vendor_id`, so the slug is
derivable, but §11's deferred multi-vendor seat is precisely the case where the
address has to say which company is being edited, and putting it in now means that
change is a resolver branch rather than a URL migration.

**The route table moved into `apps/web/src/app/vendor/vendor.routes.ts`** and
`app.routes.ts` reaches it through `loadChildren`. Two consequences worth knowing:
the resolver, the guard and the section table are no longer in the initial bundle
(the portal is a private surface used by a handful of accounts, and the initial
bundle sits close enough to its 1 MB budget that eagerly importing the guard alone
broke the build); and `VENDOR_SECTION_ROUTES` is exported separately because three
surfaces mount it — the real portal, the dev preview, and the shell's own spec.

- **`VendorPage` is now the layout route** (`/vendor/:vendorSlug`): the gate, the
  head, `VendorPortalStore` and `VendorLiveSync`, plus the shell. The sections are
  lazy children rendered through `<router-outlet/>`, so a section still only
  fetches when a vendor opens it — the property the `@switch` used to provide.
  The parent resolver runs once per entry into the portal, so moving between
  sections costs no round-trip and never re-seeds the store.
- **The nav links are relative.** `routerLink="overview"` resolves against the
  `ActivatedRoute` of whichever route created the shell's ancestor, so one
  template serves both `/vendor/:vendorSlug` and `/preview/vendor-dashboard`
  (which mounts the same `VENDOR_SECTION_ROUTES` as children). No "am I
  previewing" branch anywhere, and the preview keeps reviewing the component that
  actually ships.
- **The slug is checked, not decorative.** `vendorMeResolver` takes the same
  not-found path for a 200 whose `vendor.slug` is not the one in the URL as it
  does for a 401/403 — and does not put the payload in `TransferState`, so the
  client branch cannot hydrate the dashboard the server refused to render.
  Rendering the session's dashboard under a URL naming a different vendor is how
  someone edits (or cites) the wrong listing.
- **Bare `/vendor` still works, via a guard.** Both header menus link to it and
  neither has a vendor payload to build a slugged link from.
  `vendorHomeRedirectGuard` resolves `GET /api/vendor/me` and returns a `UrlTree`
  to `/vendor/:vendorSlug/overview`; under SSR that becomes a **real 302**
  (`@angular/ssr` emits one whenever the router's final URL differs from the
  requested one), so a cold hit costs one redirect and lands on an address that
  names the vendor. `redirectTo` — including its function form — cannot do this:
  resolvers do not run for a redirect route, so the target is unknowable there.
  The rejection branch returns `true` instead, leaving the URL intact and
  rendering the global `NotFound` with the 404 status + noindex head the guard
  sets (the AECI-62 "no pinned-404 trap" rule). A 5xx rethrows.
  The cost is one extra `GET /api/vendor/me` on that one hop — a 302 carries no
  `TransferState`, so the redirect target's resolver fetches again. Deep links,
  bookmarks and every in-portal navigation skip the guard.
- **"Vendor Overview", not "Overview"** (`vendor-nav.ts`, the `admin-nav.ts`
  shape). The portal's overview is one of several overview-ish surfaces a
  signed-in operator meets, and the nav sits inside a page whose `h1` is the
  company name — naming the scope is what makes the link self-describing in a
  screen-reader's link list and in a browser-history entry.
- **The products section is one product at a time, with a picker.** It used to
  render every owned product as a collapsed `<details>`; that reads fine for the
  three-product fixture vendor and falls apart for a real one with a hundred, where
  the product you came to edit is somewhere in the middle and cannot be named.
  `sections/vendor-products-page.ts` puts the shared `AecSelect` (the ADR 0010
  non-editable Aria combobox, whose listbox brings typeahead — the thing that makes
  a hundred options navigable) beside the "Your products" heading, and the choice
  is the `:productSlug` segment. The bare path shows the primary product (the nav
  has no product in hand), the picker is hidden for a single-product vendor, and a
  slug naming a product the vendor does not own is **called out** rather than
  silently substituted. `VendorProductsSection` keeps its stacked-list rendering
  for a `null` `selectedSlug`, which is what the single-page concept still uses.
- **Ownership is still enforced server-side.** Nothing here is the gate:
  `PATCH /api/vendor/products/:id` proves ownership against the session, and
  `requireVendor()` still scopes every read. The slug check and the unknown-product
  notice are clarity guards on top of that.
- **No worker change was needed.** `isVendorPath` already matched `/vendor/…`, so
  the anon login-bounce carries the deep path through in `?return=`, and the
  fail-closed cache classifier still gives every portal path `private, no-store`
  with no `Cache-Tag`.

> ⚠️ **Deployed-environment blocker — the zone WAF 403s any path containing
> `/vendor/`.** Verified 2026-08-26 by curl on `www`, `staging`, `demo` and
> `stage2`: `/vendor` is fine, `/vendor/acme/overview` is a Cloudflare block page.
> Almost certainly a Cloudflare **Managed Ruleset** rule (the Composer/PHPUnit
> `vendor/` RCE family), not one of ours. This already broke every browser-side
> `/api/vendor/*` call (SSR reaches the API over a service binding, so the page
> looked alive while its XHRs 403'd); after this change it blocks the **page loads**
> too, so the portal is unreachable on the zone until a skip rule lands. Local dev,
> `workers.dev` preview URLs and CI are outside the zone and unaffected — which is
> why no test catches it. Fix: a WAF skip for that managed rule scoped to
> `starts_with(http.request.uri.path, "/api/vendor/") or
> starts_with(http.request.uri.path, "/vendor/")`. Dashboard access required; see
> `docs/waf-rate-limits.md` §"Managed-rule collision".

**Tests.** `vendor-dashboard-tabbed.component.spec.ts` drives the sections with
`RouterTestingHarness` (the shell's nav is anchors now, not buttons) and re-pins
every AECI-606/614/631 property against the routed shape, plus the picker's own
cases. `vendor-me.resolver.component.spec.ts` gains a `:vendorSlug` block covering
both branches on both platforms. `apps/web/e2e/vendor-dashboard.spec.ts` asserts
the bare-`/vendor` redirect and navigates by link.

---

## 7. Moderation escalation — ban gate (AECI-524)

**The gate check ships with §4** (`banned_at` → 403 in the guard, ahead of the role check). This section owns the ban **action** + policy.

- **Ban action** — an admin sets `profiles.banned_at` / `ban_reason` on a `vendor_admin` seat (reusing the existing Layer-1 ban mechanism, `AUTH_AND_RLS.md` §7). Audited like any state change.
- **Seat semantics (§8.3(2)).** Ban and revoke are **per-seat** — they touch one `profiles` row and **never** touch `vendors.verified` (that is vendor-level, paid entitlement state). Banning one abusive seat leaves the vendor verified and its other seats working. **Un-verifying** a vendor is a **separate entitlement action** (not a ban).
- **Effect.** A banned seat fails the §4 guard on every `/api/vendor/*` call (403) — portal abuse is a ban path, not a delete.

### 7.1 As built (AECI-524 — 2026-07-25)

Shipped as **tests + role-aware auditing on the existing ban action** — **no new endpoint, no migration**. Most of §7 was already satisfied: AECI-520 shipped the guard's per-request `banned_at` → 403 check, and AECI-218 shipped the reviewer-ban admin action whose UPDATE is role-agnostic. Decisions taken at build:

- **The ban action is the existing `PATCH /api/admin/reviewers/:id`.** Its `UPDATE profiles SET banned_at/ban_reason` carries **no `role='reviewer'` filter** — only a guardrail blocking `role='admin'` and self — so it already bans a `vendor_admin` seat. This issue added **no parallel endpoint**; the reviewer-named route/contract (`reviewer_id`, `reviewer_email`) and the `reviewer_ban` workflow type are unchanged (a rename would break the `/admin/reviewers` UI for no functional gain).
- **Role-aware audit + metric.** `admin-reviewers.ts` now derives the audit `action` and the `aeci.moderation.ban` `role:` tag from the moderated seat's role, so a vendor-seat ban records `vendor_admin.banned` / `vendor_admin.unbanned` (not `reviewer.banned`). Everything else in the atomic batch (guarded UPDATE, `workflow_transitions`, post-commit forwards) is unchanged.
- **Immediate effect is inherited from AECI-520, not re-implemented.** `createAuthzMiddleware` re-fetches `banned_at` from D1 on **every** request, so a ban blocks the next `/api/vendor/*` call with the same already-issued token — no cached-token bypass. `moderation-ban-gate.spec.ts` proves it end-to-end (real ban handler + real `requireVendor` over one D1: seat 200 → admin bans → same token 403 `'Portal abuse'` → unban → same token 200).
- **Per-seat, reversible.** `admin-reviewers.spec.ts` covers: banning one of two seats on a `verified` vendor leaves the other seat **and** `vendors.verified` untouched (§8.3(2)); unban clears `banned_at` without touching `role`/`vendor_id` — access restored **without re-granting** the seat.
- **Revoke stays out.** The AC scoped un-granting to the separate revoke path, so `revokeSeatStatements` keeps **no HTTP surface**. The earlier "AECI-524 wires it" notes (§3, `AUTH_AND_RLS.md` §4.4, `vendor-grant.ts`) were corrected. Ban gates access reversibly; revoke un-grants — two different actions.

---

## 8. Verified-badge activation — trust surface (AECI-523) & search (AECI-529)

`vendors.verified` already exists and is indexed (§1.2); Stage 2 lights it up. The free/default state stays the unclaimed, AECi-curated **"Unverified"** baseline.

### 8.1 SSR trust surface (AECI-523)

Render the verified badge on the SSR detail surfaces (vendor detail, and product pages where the built-by vendor is shown). Immediate freshness: a §3 grant enqueues a `vendor:<slug>` Cache-Tag purge (§3), so the badge appears on the next request after approval. The badge is a **trust** signal — never gated by pay-for-placement, never conflated with ranking (§1).

**As built (AECI-523).** A shared, presentational `aec-verified-badge` (`apps/web/src/app/shared/verified-badge/verified-badge.ts`) — a quiet editorial **pill** (Forest-soft wash + Forest text + 0.5px Forest border + a shield-check glyph, `rounded-full` per the DESIGN.md pill reservation for vendor-verified badges) with `full` and `compact` (icon-only) variants. It renders **only when `verified === true`** — the public "Unverified" baseline is the *absence* of the badge (the explicit not-verified copy stays a dashboard-only readout, now `vendor/components/vendor-plan-panel.ts` since AECI-614); it is not conflated with the `AgreementBadge` "Unverified · AECi" claim state, nor the rating anatomy. Wired on three surfaces: the vendor detail hero (`vendors/vendor-detail.ts`), the product detail "Vendor" card (`products/product-detail.ts`, compact), and the product-pair rail (`products/products-pair.ts`, compact). Copy: `@@verified.badge.label` ("Verified vendor") + a non-overclaiming `@@verified.badge.tooltip`. AECI-529 reuses this component + copy for the search surfaces.

Data plumbing: `VendorDetail.verified` already existed, so the vendor page needed none; the product surfaces embed the lean `VendorLink`, so `verified: z.boolean()` was added to `VendorLinkSchema` (`packages/shared/src/api/common.ts`) and hydrated in the single `toVendorLink` constructor (`apps/api/src/lib/drizzle-helpers.ts`, via `vendorLinkColumns`) — covering product detail, integration detail, product-pairs, and `ProductListItem.vendor`. No cache work: the §3 `vendor:<slug>` purge already invalidates the vendor page and every embedding product/pair page.

### 8.1a Claim-CTA copy on an already-claimed listing

The badge landing on the detail pages exposed a copy contradiction: the Actions-sidebar claim CTA (AECI-128) was **unconditional**, so a verified vendor rendered the "Verified vendor" badge and "Claim this listing" on the same page.

**The CTA is not removed, only reworded.** Hiding it would close the only route in for cases the rest of this epic assumes exist:

1. Seats are **multi-seat and admin-granted**, and self-serve invite/revoke is deferred (§11), so the public claim form is the only way a *second* person at a vendor asks for one. §5's `AdminVendorSeat` signal exists precisely so a reviewer can tell a second-seat request from a first claim.
2. A wrongly-granted listing needs a public correction path for its rightful owner.
3. `vendors.verified` is a **mirror of `vendor_entitlements`** since AECI-609, not an ownership bit, so hard-gating on it would tie the CTA to billing state: a cleared or expired entitlement would make it reappear on a vendor that still has live seats. There is no claim/ownership field on the public payload; `verified` is the closest available proxy and is used for **copy only**.

**As built.** `verified === true` swaps the CTA label to "Request access to this listing" (`@@vendors.detail.metadata.requestAccess` / `@@products.detail.metadata.requestAccess`) and appends a one-line note under the action pair (`@@…metadata.claimedNote`: "Already managed by a verified vendor. Request access if you work there too."). The vendor page reads `v.verified`; the product page reads `p.vendor?.verified` (a nullable vendor falls back to the neutral claim copy). A copy-only `claimed` input on `RequestTrigger` rides into `RequestDrawerTarget`, so the drawer opens with matching eyebrow/title/subtitle (`@@requests.access.*`). **No contract change** — both states POST the same `kind:'claim'` request to the same route, and `verified` was already on `VendorDetail` and `VendorLink` from §8.1. Covered by `vendor-detail.component.spec.ts` (new), `product-detail.component.spec.ts`, and `request-trigger.component.spec.ts`.

**Deliberately unchanged:** the routed fallback form at `/{products,vendors}/:slug/claim` keeps the neutral "Claim this listing" wording — `RequestForm` resolves no entity data (route `data` + `slug` only), so it cannot read `verified` without new plumbing, and the no-JS/deep-link path is honest either way. Server-side nothing gates either: `detectDuplicate` (`apps/api/src/routes/requests.ts`) only matches requests still `status='open'`, so a claim against an already-granted vendor is not even flagged as a duplicate. Surfacing "vendor already verified" as an **admin intake signal** is the open follow-up.

---

### 8.2 Search surfaces (AECI-529)

Thread the existing `vendors.verified` column into the Algolia vendor record. Four **lockstep** edits (miss one and the field silently drops):

1. `algoliaVendorConfig.columns` — add `verified` to the queried columns (`apps/api/src/lib/algolia-transforms.ts` ~:83-105).
2. `RawAlgoliaVendorRow` — add the field (~:149-161).
3. `toAlgoliaVendor` — map it into the record (~:198-210).
4. `AlgoliaVendorRecordSchema` — add `verified: z.boolean()` (`packages/shared/src/algolia-records.ts` ~:59-69).

**Freshness contract (§8.3(5)).** Vendor edits and badge flips reach **Algolia on the nightly watermark sync** (`runDailySync`, `apps/api/src/lib/algolia-sync.ts`) — **≤24h**, since an edit bumps `updated_at` which the next window picks up (an immediate by-id `indexEntity` hook like `syncPromoteTargets` is optional if faster search is later wanted). **SSR is immediate** via the §3 Cache-Tag purge. **Accepted for launch — UI copy must not promise instant search.** `verified` becomes a facet/filter, never a ranking signal (no pay-for-placement).

### As built (AECI-529 — 2026-07-25)

- **Vendor record only, badge on the `/search` Vendors tab.** The `verified` bit is denormalized onto the Algolia **vendor** record, and the reused `aec-verified-badge` (§8.1) renders under the company name on `SearchVendorCard` (`apps/web/src/app/search/search-vendor-card.ts`). The **product** search card is deliberately left untouched — `algolia-transforms.ts` already carried a comment reserving `verified` for the vendor record, and it is also the only freshness-clean choice: the §3 grant bumps `vendors.updated_at` (→ the vendor index catches the flip on the next nightly window) but never touches `products.updated_at`, so a badge on product cards would go stale on a flip until each product is separately reindexed. This resolves the Linear AC's "product (and vendor, if applicable)" to **vendor**.
- **Four lockstep edits, as specified:** `algoliaVendorConfig.columns` (+`verified: true`), `RawAlgoliaVendorRow` (+`verified: boolean`), `toAlgoliaVendor` (+`verified: row.verified`), and `AlgoliaVendorRecordSchema` (+`verified: z.boolean().default(false)`). The `.default(false)` keeps records indexed before this field parse-safe as the unverified baseline; the card also guards with `@if (record().verified)` so a stale record's missing field (runtime `undefined`) hides the badge, not errors.
- **Record field only — no faceting, no ranking change.** `INDEX_SETTINGS` (`packages/shared/src/algolia.ts`) and `algolia.spec.ts` are untouched, so there is no searchable-attribute or custom-ranking change (AC #3, no pay-for-placement). Algolia returns the field on every hit without it being a facet; a `verified` facet is a trivial future add if a "Verified only" filter is built.
- **Freshness test already covered.** The grant-bumps-`updated_at` premise is asserted by AECI-519's own tests (`apps/api/src/routes/admin-claims.spec.ts` — "flips verified (+ bumps updated_at) … atomically", and the multi-seat no-churn case). AECI-529 adds transform + schema + card coverage that the field now flows to the record and renders.
- **One-time backfill.** Existing vendor records won't carry `verified` until re-indexed; the nightly window only re-pushes vendors whose `updated_at` moved. A **full vendor reindex** (datatool / the AECI-535 data-ops panel) backfills the field across all records post-merge. Until then the badge degrades safely (hidden = unverified baseline).

---

## 9. Claim-decision emails (AECI-528)

Claim approved / rejected notifications over **Resend** (`apps/api/src/lib/email.ts`; `docs/email.md`), fail-open — runs alongside the rest.

- Add `'claim-approved'` and `'claim-rejected'` to the `EmailTemplate` union (~:60-72) — the id is also the `template:` metric tag on `aeci.email.send`.
- Add `sendClaimApprovedEmail` / `sendClaimRejectedEmail` helpers modeled on `sendReviewApprovedEmail` / `sendReviewRejectedEmail` (~:168-220): build `text`/`html` via `toText()`/`toHtml()`, call `sendTransactionalEmail` (never throws; absent key/sender/recipient → `'skipped'`).
- Fire from the §3 grant/reject handler via `c.executionCtx.waitUntil(...)`, to the claim's `submitter_email`.
- Update the template catalogue in `docs/email.md`.

Billing/invoice notices are a Paid-Tiers concern (`STAGE_2_SPEC.md` §2.2 / AECI-515), not this issue — **now owned by AECI-613** (`entitlement-expiring` / `entitlement-expiring-admin`, `docs/STAGE_2_PAID_TIERS_SPEC.md` §7).

### As built (AECI-528 — 2026-07-25)

- `EmailTemplate` gained `'claim-approved'` / `'claim-rejected'`; `sendClaimApprovedEmail` / `sendClaimRejectedEmail` land in `apps/api/src/lib/email.ts` next to the review helpers (same fail-open transport + `template:` metric tag), plus a `portalUrl(env)` = `${PUBLIC_SITE_URL}/vendor` link builder.
- The §3 handler's `SendClaimDecisionEmail` seam was **widened** to carry `targetName` (the claimed vendor's `companyName` or the product's `name`, resolved via `resolveRequestTargets`) and — on approve — the `identityOutcome` (`invited` vs `linked`). The real sender (`lib/email.ts` `sendClaimDecisionEmail` adapter) is injected at the route registration in `index.ts`; the in-handler default stays a no-op for standalone tests.
- **Approved copy** names the vendor, lists the account's new capabilities (edit profile, submit data corrections, add integration attestations), links to `/vendor` when `PUBLIC_SITE_URL` is set, and tailors sign-in guidance: `invited` explains the just-provisioned account + one-time sign-in link (no GoTrue invite email is sent, §2); `linked` points at the existing account. Verification is framed as an **account status**, never ranking/placement (no pay-for-placement) and with no instant-search promise.
- **Rejected copy** is **neutral by design** (this §9 AC): it names the vendor, states the claim wasn't approved, and invites a fresh claim. The reviewer's decision `reason` is an **internal audit note** — recorded in `audit_log` (admin-visible) and **never emailed** — so nothing a reviewer types can leak to the claimant. `ModerateClaimSchema` keeps its single `reason` field, but it no longer reaches the email path (the `SendClaimDecisionEmail` seam carries no `reason`), and the `/admin/claims` reject form labels it "Internal reason … not shared with the claimant." *(Review-pass hardening, 2026-08-14: the initial AECI-528 build echoed `reason` to the claimant — a reviewer-note leak vector — which contradicted this AC; it was neutralized. Splitting `reason` into distinct claimant-facing vs internal fields remains a possible future enhancement.)*

---

## 10. Document `vendor_admin` authz (AECI-525)

Complete `AUTH_AND_RLS.md` for `vendor_admin`. The **kickoff** already seeds the de-staling — §9 rewritten to the 3-layer Worker model, the §4.1 file-path fix, the §3 roles-row update. AECI-525 finishes it **once §4 lands**:

- Add the `vendor_admin` rows to the §4.4 endpoint-by-endpoint table (`/api/vendor/*` auth + scope + audit expectations).
- Document the `requireVendor()` guard + `vendor_id` query-scoping invariant (§4 here) as the canonical pattern.
- Document the ban gate for vendor seats (§7) and the app-layer grant/revoke seam.

---

## 11. Out of scope / deferred

Explicitly **not** in this epic (tracked elsewhere or later):

- ~~**Self-serve seat invite/revoke + owner/admin distinction**~~ — **SHIPPED 2026-08-26 (AECI-664); see §11a below.** The "small schema add" this bullet anticipated turned out to be exactly that: one table (`vendor_seat_invites`) and one column (`profiles.seat_owner`), migration `0020`. Launch is no longer admin-granted-seats-only — an owner seat can invite a colleague **on the vendor's own email domain**, and every other case still falls through to the §5 claim queue.
- **Paid-tier ladder above the entry Verified fee, automated billing, self-serve card, offline-invoicing mechanics** (renewal/expiry/dunning) — the Paid Tiers epic (AECI-515). **Decomposed 2026-08-14** in `docs/STAGE_2_PAID_TIERS_SPEC.md`; the decisions landed in `STAGE_2_SPEC.md` **§8.5** (§8.4 is the AECI-514 attestations block, taken at its own review the same day). **Built out 2026-08-14…19**: the entitlement model, the capability registry, the gate, the admin set/renew/clear action, the expiry warnings and the vendor plan panel all shipped. Automated billing and self-serve card stay deferred there; dunning is deliberately out (expiry **warns**, never auto-lapses); the tier *ladder* is now a data-only edit but its **pricing** stays open.
- **Real-time / live vendor edits** — the Real-Time epic (AECI-516). **Transport resolved 2026-08-19** (ADR 0023 / `STAGE_2_SPEC.md` §8.6): **scoped client revalidation** over a per-vendor freshness cursor — **not** Durable-Object WebSockets, not SSE — decomposed into AECI-626…632 in **`docs/STAGE_2_REALTIME_SPEC.md`** and **built out 2026-08-19**. "The portal ships without persistent sockets" stayed true and is now the decision rather than the interim posture. It builds directly on this doc's §4 authz seam (a new `GET /api/vendor/updates` behind `requireVendor()`, scoped by `c.get('auth').vendorId`) and makes this doc's §6 dashboard live; nothing this epic shipped changes.
- **Integration attestation authoring / conflict UI / version-diff** *(the version-diff half is now **shipped** — AECI-303, `STAGE_2_ATTESTATIONS_SPEC.md` §9 + §9.4)* — the Integration Attestations epic (AECI-514; activates the dormant `vendor_a`/`vendor_b` sources). Decomposed at its 2026-08-14 kickoff: **`docs/STAGE_2_ATTESTATIONS_SPEC.md`** is the build contract (`STAGE_2_SPEC.md` §2.4 is now just the scope outline). It builds directly on the §4 authz seam and the §6 dashboard shipped here — the two-slot attestation authority rule is the extension of this doc's `vendor_id`-scoping invariant, and the attestations surface is a new tab on this doc's dashboard.
- **Person-lookup enrichment providers** — deferred DPA/GDPR decision (§5 surfaces a link only).
- **Dark theme** — the Dark-Theme Reintroduction epic; `STAGE_2_SPEC.md` §2.5.
- **A public/partner write API** — the "no public API surface" boundary is unchanged (`STAGE_2_SPEC.md` §9).

---

## 11a. Self-serve seat invites (AECI-664) — activating the first §11 deferral

**Shipped 2026-08-26.** One migration (`0020`), five endpoints, two web surfaces. This section is the build contract; the code is `apps/api/src/lib/vendor-seat-invites.ts`, `apps/api/src/routes/{vendor-seat-invites,seat-invites}.ts`, and `apps/web/src/app/vendor/{vendor-invite-page.ts,components/vendor-seat-{roster,invite-form}.ts}`.

### 11a.1 Why this was safe to open up

§8.1(1) put a human in the loop for every seat, and that stays true for the cases that need it. What changed is the finding that the **second** seat's review was protecting nothing:

- **Not revenue.** `activateEntitlementStatements` already returns the frozen no-op when an `active` row exists (§3.1), so a second-seat grant never re-flipped `verified`, never re-charged, never even bumped `updated_at`. There is no seat cap and no seat capability: `CAPABILITIES` (`packages/shared/src/entitlements.ts`) holds seven ids and none is about seats.
- **Not attestation integrity.** `computeAgreement` (`packages/shared/src/agreement.ts`) dedupes by `attestedByVendorId`, so N seats at one vendor cast **one** vote and `confirmed` still needs two *distinct* vendor identities. Seat count cannot manufacture agreement. The residual risk is vendor-internal quality, which is the vendor's to manage.

What the review WAS protecting is the identity question — "does this person really work there?" — and that is precisely what the domain gate answers mechanically for the easy case and escalates for every other one.

### 11a.2 The model

**Supabase does the sign-in; the invite is ours.** GoTrue's `POST /auth/v1/invite` was evaluated and rejected — the rationale is in `apps/api/src/lib/supabase-admin.ts` (the `WHY NOT` block on `createAuthUser`) and is unchanged by this issue: its link lands on `/auth/v1/verify?type=invite` and returns the session in a **URL fragment**, which `/auth/callback` (PKCE `?code=`) dead-ends; and enabling it needs two dashboard edits on the ONE shared auth project that backs production (ADR 0017).

**The vendor never provisions an account.** No `createAuthUser` call exists on this path. An invite row is an INTENT; the invitee signs in through the ordinary self-service flow and the seat attaches on acceptance. Two consequences worth stating: it removes the spam / enumeration / third-party-consent problem a vendor-triggered account create would introduce, and — because nothing here reads `SUPABASE_SERVICE_ROLE_KEY` — the whole flow works in local `wrangler dev` and on PR previews, unlike the §3 admin grant which 503s wherever that key is absent.

**The token is not a credential.** It identifies an invite; it never authorizes one. `inviteRedeemState` (the single shared verdict, used by both the preview read and the accept write) requires the redeemer's **verified JWT email** to equal the invited address, and an ABSENT session email fails closed. A forwarded link, a shared-inbox link, or a link a scanner prefetches grants nothing.

**GET describes, POST mutates.** Mail scanners, link-preview bots and corporate URL rewriters fetch what they are sent, so a GET that redeemed would be spent by the invitee's own security appliance before they clicked. Same confirm-then-POST discipline as `/unsubscribe` (AECI-537).

### 11a.3 The domain gate

`computeDomainMatch(email, vendors.website)` (`apps/api/src/lib/domain-match.ts`) — already the reviewer's primary signal on the §5 queue — is reused verbatim as the policy:

| verdict | outcome |
|---|---|
| `match` | the invite sends |
| `no_match` | **422 `INVITE_DOMAIN_MISMATCH`**, no row written, no mail sent |
| `manual_review` (freemail, or the vendor has no `website`) | same 422 |

The refusal copy names the fallback explicitly ("ask them to open your listing and choose *Request access to this listing*"), so an agency address, a subsidiary, or a contractor lands back in the §5 queue where a human already weighs this exact question. **The concierge review is narrowed, not removed.**

### 11a.4 Owner vs member

`profiles.seat_owner` is the owner/admin distinction §11 deferred, and it gates **seat management only** — data capabilities stay identical across seats, so this is not the start of a permission matrix.

- `true` on a seat created by the §3 admin claim grant (`grantSeatStatements`) — an AECi-reviewed human IS the owner event.
- `false` on a **new** seat created by redeeming an invite (`acceptInviteStatements`). **This is the bound**: without it, one reviewed human seeds an unbounded chain of seats no reviewer ever saw. Redeeming never **demotes**, though — an existing owner who happens to redeem (re-invited, or self-invited; the invite path cannot cheaply tell they already hold a seat) keeps their bit, so the accept upsert's conflict path preserves the prior `seat_owner` rather than forcing it false. Forcing it false there could strip the only owner and leave the vendor unadministrable — the state the removal path's last-owner guard exists to prevent.
- Cleared by `revokeSeatStatements`, so a stale `true` cannot make a re-linked account an owner by accident.
- **Migration `0020` backfills every pre-existing `vendor_admin` to `true`.** A default-`false` rollout would have shipped the feature dead — no existing vendor could invite anyone.

### 11a.5 Endpoints

Owner side, behind `requireVendor()` **plus** an in-handler `requireSeatOwner()` that re-reads `seat_owner` from D1 every request (a demotion lands on the caller's next call, the same discipline as the `banned_at` re-read in `createAuthzMiddleware`):

- `POST /api/vendor/seats/invites` — 201. Domain gate, duplicate probe, **rate limit** (`INVITE_DAILY_LIMIT` = 10 per vendor per rolling 24 h, counted over `vendor_seat_invites` — no KV, no new binding). Mail is post-commit `waitUntil`; a send failure never un-creates a committed invite.
- `DELETE /api/vendor/seats/invites/:id` — 204, soft delete (`revoked_at`).
- `DELETE /api/vendor/seats/:userId` — 204. **The first HTTP surface `revokeSeatStatements` has ever had** (AECI-524 shipped the builder unwired). Refuses self-removal; also carries an explicit last-owner guard which is *currently unreachable* and kept deliberately — see the handler docblock.

Invitee side, on its **own prefix** and behind `requireAuth()`, because the caller is by definition not a `vendor_admin` yet:

- `GET /api/seat-invites/:token` — the preview + the redeemability verdict.
- `POST /api/seat-invites/:token/accept` — attaches the seat.

`GET /api/vendor/seats` gains `pending_invites` and `can_manage_seats`. It stays **un-gated** by capability (`STAGE_2_PAID_TIERS_SPEC.md` §4.3). **The `token` is never on this payload** — the roster is readable by every seat, and a token there would let any seat redeem an invite addressed to someone else's mailbox. It appears in exactly one place: the invite email.

### 11a.6 Seat management is NOT entitlement-gated

No `requireCapability` call exists in `routes/vendor-seat-invites.ts`, and that is a position rather than an omission. There is no seat capability in the frozen registry; §3 already establishes that clearing an entitlement does not revoke seats; and gating **removal** on a live entitlement would mean a lapsed vendor cannot revoke a departed employee's access — a security regression wearing a billing lever's clothes. A lapsed vendor's seats still cannot write anything: every data write is separately capability-gated.

### 11a.7 Routing

The portal is `/vendor/:vendorSlug/<section>` since §6.2, so the redeem page is `/vendor/invite/:token`, registered **ahead of `:vendorSlug`** in `vendor.routes.ts` (or the literal `invite` segment is captured as a slug and `vendorMeResolver` 404s the one page a non-vendor must reach). It is deliberately OUTSIDE that layout route — everything under it is behind the resolver — but stays under `/vendor/` so the worker-level anon gate (`isVendorPath`) bounces a signed-out visitor to `/auth/login?return=<path>` with the token intact (`safeReturnPath` preserves query strings and path segments alike). **That bounce is the flow, not a side-effect.**

### 11a.8 Deliberately deferred

- **An `invites` scope on `GET /api/vendor/updates`.** There are exactly six cursor scopes, and both `STAGE_2_REALTIME_SPEC.md` and `CLAUDE.md` state "six SELECTs in one `db.batch`". A seventh is its own change. Cross-tab invite freshness degrades to on-demand `store.reload('seats')`, which the surface already does after every write.
- **Cross-domain invites.** By design — that is what the §5 claim queue is for.
- **Bulk/CSV invite, and role tiers beyond owner/member.**
- **A seat-count capability or per-seat billing** — a Paid Tiers (AECI-515) decision, not this one's.

---

## 12. Cross-references

| Topic | Doc |
|---|---|
| Layer-1 Worker authz (JWT → role/ban → scope) | `AUTH_AND_RLS.md` (extended by §4/§7/§10) |
| Split-identity seams / service-role operations register | `AUTH_AND_RLS.md` §3.1 (seam #4 added by §2); original numbering in `adr/0016` §3 |
| `/api/vendor/*` request/response Zod shapes | `API_CONTRACTS.md` (added by AECI-520) |
| D1 schema | `apps/api/src/db/schema.ts` + `DATABASE_SCHEMA.md` (§1.2 — no migration) |
| Transactional email | `email.md` (§9) |
| Cache-Tag purge (queue producer + tag map) | `CACHE_STRATEGY.md` (§3/§8) |
| Algolia index settings + `verified` facet | `SEARCH_RANKING.md` (§8) |
| Stage 2 scope, decisions, epic map | `STAGE_2_SPEC.md` (§2.1 scope, §8.3 decisions) |
| Paid tiers & entitlements — the successor epic (AECI-515) | `STAGE_2_PAID_TIERS_SPEC.md` (§3's un-verify owner, §6.1's paid-tier display, §9's billing notices, §11's deferrals) |

---

*This is the build contract for AECI-513. As each sub-issue lands, keep this doc current with the code (per the "update all documents" rule) — the file/line references in §1.2, §1.3, and §8.2 are anchors, not guarantees; verify them before editing the cited files.*
