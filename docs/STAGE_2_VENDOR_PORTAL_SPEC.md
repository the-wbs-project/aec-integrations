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

**Stage 2 is where the vendors log in.** The vendor portal is the anchor capability of Stage 2: a vendor authenticates, proves association with a `vendors` record, and gains `vendor_id`-**scoped** write access to their own product/vendor data — with every write audited and the public account-status label activated on approval. The dividing line inherited from `STAGE_1_5_SPEC.md` §1.1 is exact: *anything that requires a vendor to authenticate and assert something about their own product is Stage 2.*

**The launch model is concierge / manual (`STAGE_2_SPEC.md` §8.1).** AECi grants every `vendor_admin` **by hand** — **no auto-grant**. Vendor access is a **paid gate** arranged by **offline invoice/PO** — for **endpoint** vendors; `STAGE_2_SPEC.md` §8.8 (AECI-702) does not invoice the connector surface, and **§8.9 (AECI-704) settles what a pure connector vendor receives instead**: a catalogue-maintenance seat on its own catalogue(s), carried by **no `vendor_entitlements` row**, so the public account label never appears. A connector-vendor claim is therefore **routed to the partnership track, never granted and never declined** — procedure in §5.2. **Exception since `STAGE_2_SPEC.md` §8.10 (2026-09-18, AECI-1017):** a connector vendor that owns integrations it manages (a third-party owner) is a paying vendor and takes the ordinary Grant. Seats are **multi-seat, flat** (several admins per vendor — e.g. Autodesk, Deltek). It deliberately does not scale; vendor volume at launch is low, and staffing help comes in if it grows.

**The trust invariant is unchanged and non-negotiable: no pay-for-placement.** Verified is a **capability + profile-richness** gate, never a ranking, placement, or badge-trust gate. Search stays purely algorithmic (`STAGE_1_SPEC.md` §1 principles; `CLAUDE.md` constraints). The reader-facing model is unaffected by what a vendor pays to participate.

### 1.1 Issue map & critical path

This doc is the contract for the AECI-513 sub-issues. Each opens with `**Spec section:** §X (docs/STAGE_2_VENDOR_PORTAL_SPEC.md)` — the canonical form in `docs/linear-issue-conventions.md`. (The older doc-name-first spelling survives in existing issues and still resolves; write new ones this way.) **The subsection numbering below is load-bearing — do not renumber without updating the issues.**

| Anchor | Issue | Surface |
|---|---|---|
| §2 | AECI-527 | Claimant identity resolution — GoTrue email→user seam, provisioning path, profile-ensure no-clobber |
| §3 | AECI-519 | Claim → verified-account grant flow |
| §4 | AECI-520 | `/api/vendor/*` endpoint surface + vendor authz seam |
| §5 | AECI-521 | Admin claim-review surface + reviewer-assist verification signals |
| §6 | AECI-522 | Vendor portal UI (edit content, status, multi-seat) |
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

The approval action that turns an `open` vendor claim into an active vendor account. **Depends on §2** (a resolved auth-user id) and reuses the §1.3 moderation template.

**The grant (single `db.batch([...])`).** On approve, in one atomic batch:

1. **Link the seat** — upsert the `profiles` row for the resolved auth-user id: set `role = 'vendor_admin'` and `vendor_id = <claimed vendor>` (no-clobber per §2).
2. **Flip verification** — `UPDATE vendors SET verified = true WHERE id = <vendor>` (idempotent; a guarded predicate keeps concurrent grants safe).
3. **Resolve the request** — `UPDATE vendor_requests SET status='resolved', resolved_by_id, resolved_at WHERE id = :id AND status IN ('open','in_review')` (the guarded-WHERE idiom from `createModerateRequestHandler`).
4. **Workflow transition** — advance/complete the `vendor_claim` `workflow_instances` row + insert the `workflow_transitions` row (`workflowTransitionInsert`).
5. **Audit** — `auditInsert` for the grant. **Record the PO/invoice arrangement in the `audit_log` `metadata`** — this is the launch entitlement record (see §8.3(1) of `STAGE_2_SPEC.md`); no new schema.

**Entitlement launch shape.** `vendors.verified` **is** the launch entitlement bit. The offline PO/invoice arrangement lives in `audit_log` metadata (payer, amount/terms, arranged-by). A formal entitlement model is deferred to the Paid Tiers epic (AECI-515); this epic adds **no new schema**.

> **Superseded (AECI-515, 2026-08-19).** That was the AECI-513 launch shape, and the Paid Tiers epic is the successor it named. `vendors.verified` is now a **denormalized mirror** of a `vendor_entitlements` row — `true` **iff** an `active` row exists — maintained in the same `db.batch`; the arrangement lives in the row **as well as** the audit trail, which stays the renewal ledger. The "no new schema" clause held for this epic and was spent by that one: `0024_easy_sandman` is the single migration.
>
> **Nothing AECI-513 shipped against this bullet changed in behaviour** — the grant still writes the seat, still flips the bit, still records the arrangement in audit metadata; every reader still reads `verified`, and no public or read path may query the entitlement table. The one structural change is that after AECI-612 the flip is **emitted by `lib/vendor-entitlement.ts`, not by `grantSeatStatements`**, so the mirror has exactly one writer. See `docs/STAGE_2_PAID_TIERS_SPEC.md` §2 and `STAGE_2_SPEC.md` §8.5.

**Post-commit (best-effort, `waitUntil`).**

- **Cache purge** — the grant flips `vendors.verified`, which changes the cacheable `/vendors/:slug` page **and** the product pages that embed the vendor tag. Enqueue a Cache-Tag purge onto `CACHE_PURGE_QUEUE` — `{ tags: ['vendor:<slug>'], source: 'moderation' }` — mirroring `purgeProductTag` (`apps/api/src/routes/admin-reviews.ts` ~:135-147). **Note:** the existing request-moderation path deliberately skips purge (a `vendor_request` renders on no cacheable page); the grant path **must add it** because it mutates `vendors`.
- **Claim-approved email** — §9 / AECI-528.

**Reject path.** `UPDATE vendor_requests SET status='rejected'` + workflow `rejected` + audit; no vendor mutation, no purge; fire the claim-rejected email (§9). `TERMINAL_OUTCOME` maps `resolved→completed`, `rejected→rejected` (as in the reviews/requests handlers).

**Reversibility.** Grants are app-side and reversible — a later revoke (§7) is a separate audited write; it removes the seat but does **not** by itself un-verify the vendor (see §7 seat semantics).

> **This flow is now the ONLY writer of `vendors.verified`.** AECI-520 removed the column from the promote payload's writable set (§4.2) because a routine Airtable push could otherwise silently un-verify a paying vendor. This section's `UPDATE vendors SET verified = true` (step 2) is the sole SET path; the **un-verify** half (the "separate entitlement action" §7 defers) had no owner at the close of this epic — a seat revoke (below / AECI-524) deliberately never un-verifies. **It has one now: AECI-532** (`PATCH /api/admin/vendors/:id/entitlement`, `set` / `renew` / `clear`), specified in `docs/STAGE_2_PAID_TIERS_SPEC.md` §5. Clearing an entitlement does **not** revoke seats — the vendor keeps portal access, read-only. The bit is read by the public vendor API shapes and the `GET /api/vendors?verified=` filter, and — as of AECI-965 — **rendered as the neutral account-status label on the SSR detail surfaces** (§8.1). It is also in the Algolia vendor record (AECI-529).

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

- **Logo editing amendment (AECI-955, AECI-968):** the profile and product logo controls accept HTTPS URLs or uploaded PNG/JPEG/static WebP files via `POST /api/vendor/logo`. Upload requires a seat plus profile.edit or product.edit and does not publish a change. The editable control has separate URL and uploaded-image modes: a stored `/api/logos/<hash>` draft renders as the preview, "Uploaded image" and Remove, never as an editable backend path. Existing PATCH routes accept exact local logo paths, require the referenced object to exist and validate, and set logo_source=vendor only when logo_url is present, including null. Save remains disabled during uploads. See STAGE_2_5_SPEC.md §11.
- **Usefulness amendment (AECI-963):** the "how teams use it" narrative is vendor-written — see §4.4.
- **Integration ownership amendment (AECI-1005, ADR 0035):** integrations are vendor-owned and AECi seeds them. The owner claims its row and promote stops writing it — see §4.5. This reverses the launch-era rule that integrations are AECi-curated and not vendor-editable, which is why no route on this surface wrote integration content before 1005. Since AECI-1006 the claimed owner edits the integration's standard fields through `PATCH /api/vendor/integrations/:id` (§4.5.6). The product/vendor allow-list below is unchanged by that: the integration field set is its own, and an integration `name` is editable because nothing routes on it.
- **Editable allow-list = content + links + taxonomy.** Product: `description`, `website`, `tool_integrations_url`, `api_docs_url`, `logo_url`, **`usefulness`** (added by AECI-963 — see §4.4), plus category/audience/phase/**trade** assignment (trade added by AECI-665 — see §4.3). Vendor: `description`, `website`, `headquarters`, `founded_year`, `public_private`, `parent_company`, `contact_email`, `phone_number`, `logo_url`, profile URLs. **Vendors assign existing taxonomy terms only** — minting a term stays an AECi curation act, so an unknown slug is a `400`, not a silent drop. `name`/`slug` are not vendor-editable (a rename breaks the URL, the Algolia record, and every inbound link — it stays a correction request).
- **Cross-vendor access returns `404`, not `403`.** A non-owner must not learn that another vendor's product exists. Ownership is proven against `product_vendors` in its own read wave, before anything else runs.
- **A site `admin` is rejected with `403`.** No impersonation at launch; admins act through `/api/admin/*` so the audit trail names the real actor. A `vendor_admin` with a null `vendor_id` is likewise rejected.
- **Audit rows use `actor_type: 'user'`** — the `audit_log_actor_type_check` CHECK has no `vendor` value and this epic ships no migration — and are distinguished by `metadata.source = 'vendor-portal'`.
- **Purge tags.** Profile edit → `vendor:{slug}`. Product edit → `product:{slug}` + `index:products` + the taxonomy tags for the **union** of facet membership before and after (the browse page a product *joins* never carried its `product:` tag, so the union is what stops it going stale). A **trade** change purges more than its own browse page — see §4.3. Every vendor write stamps `products.updated_at`, including a taxonomy-only edit, or the nightly Algolia watermark would never see it.

### 4.2 Review-app counterpart: claimed vendors are not promote-writable

A conflict §4 did not anticipate: `POST /api/promote` writes an overlapping column set, so an ordinary promote push would silently revert a vendor's edits. AECI-520 therefore blocks the review app from writing to a **claimed** vendor or any product it owns — wholesale, all columns — while everything else in the payload still promotes. Creates are never blocked. Blocked entities are omitted from the response and reported in `skipped[]` (new kinds `vendor` / `product`). See `API_CONTRACTS.md` §6.12 and `REVIEW_APP_PROMOTE_API.md` §4a.

**"Claimed" means at least one ACTIVE seat** — a `profiles` row with `role = 'vendor_admin'`, a matching `vendor_id`, and `banned_at IS NULL`. Seat existence is the signal rather than `vendors.verified` precisely because it cannot be set from the review app. The ban exclusion is what keeps §7 moderation from locking a record: banning a vendor's only admin fails their portal calls **and**, without it, would leave promote refused too — so the content AECi banned them over would be the one thing nobody could correct. Ban stays per-seat (§7), so a vendor with another active seat is unaffected.

`verified` was also **dropped from promote's vendor update** — it is the paid entitlement bit, set by the §3 grant and cleared only by a deliberate entitlement action, so a routine push must not move it (it previously could silently un-verify a paying vendor). It stays accepted-and-ignored in `PromoteVendorSchema`, so no lockstep review-app deploy was needed. **Consequence: until §3 (AECI-519) lands there is no writer for `vendors.verified` at all** — see §3.

### 4.3 Trades are vendor-assignable (AECI-665 — 2026-08-26)

The vendor product editor shipped (AECI-522) with three taxonomy facets. `trade` — the
fourth facet — was **absent at every layer of the vendor-edit path**: `VendorProductSchema`,
`UpdateVendorProductSchema`, the handler's `FACETS` table, and the form's chip groups. Not a
deliberate carve-out: the trades epic (AECI-538) shipped to `main` before the vendor portal
existed on `stage-2`, none of its ten sub-issues touched a surface that wasn't built yet, and
the AECI-619 reconcile brought the schema and the public surfaces across without widening the
vendor-editable allow-list. Everything downstream already supported trades — D1
(`taxonomy_trades` / `product_trades`), `GET /api/taxonomy → trades`, promote, Algolia, the
public detail chips, `/trades` browse, the sitemap — so this was a widening, not a build. The
form was already *fetching* the trade vocabulary into its `taxonomy` input and discarding it.

**Decision: vendors self-assign trades, uniformly with the other three facets.** Same
`termSlugList` cap, same find-only resolution, same set-replacement, same
`product.taxonomy.edit` gate. Deliberately **not** given a stricter cap. The rationale is the
portal's premise: the vendor knows what their product does for a trade better than our
researcher does, and the direction of travel is AECi getting *out* of the business of curating
data vendors own.

**The accepted risk, stated plainly.** Trades are the highest-leverage discovery facet — the
publication floor is 1, so a single tag can publish a whole browse page and a sitemap entry —
and the §1.1 tagging rule ("only where the product has trade-*specific* value; horizontal
platforms carry none") is a judgement call with an obvious incentive to over-answer. That risk
is accepted, not mitigated by a cap: the write is audited (`metadata.source = 'vendor-portal'`,
with before/after trade sets) and reversible. **A "challenge recently-changed trades" review
workflow — surfacing trade edits for an operator to question and the vendor to defend — is a
known, deliberately deferred follow-up.** It is not a gap in this section; it is the mitigation
we chose not to build yet.

**Cache invalidation is the one place trades are NOT uniform.** `productEditTags` handles them
in their own branch, mirroring `cacheTagsForPromote`: any change to the trade set also purges
`index:trades`, `taxonomy`, and `sitemap`, because the facet is publication-gated
(`CACHE_STRATEGY.md` §2). Tagging a trade that had no products flips `/trades/{slug}` from
`noindex` to indexable and adds it to the index grid, the nav flyout, and `sitemap.xml` — none
of which carry that product's tag. A removal crosses the same floor downward. The purge is
keyed on the **symmetric difference** of the before/after sets, not on "the caller sent the
key", so re-saving an unchanged trade set does not purge the sitemap for nothing. That trigger is
deliberately *tighter* than promote's, which cannot cheaply diff (its response echoes only the
trades that were set) and so purges every trade on the product. Both purge a superset of what is
stale; the rule is shared, the trigger is not. A trade the product already carried needs no
explicit tag, because `/trades/{slug}` embeds a `product:{slug}` tag for every product it lists.

**Carried over from promote after all (AECI-944, 2026-09-14).** This paragraph used to read:
"*Not carried over from promote, deliberately: the IndexNow / Google submission that
`POST /api/promote` fires for newly-published trade URLs. A vendor edit repaints the edge but
does not ask a crawler to re-fetch; the next promote touching that trade does. Cheap to add if
vendor-published trade pages prove slow to index.*"

**What changed is that vendors got seats.** The original reasoning was sound while the vendor
surface was dark, because every public page a vendor could reach was also a page a promote
would touch again shortly. Once a seated vendor can rewrite a product description, that page
may not be promoted again for weeks, and the edge repaint reaches no crawler at all. So the
re-crawl announcement now rides `afterVendorWrite` rather than each call site, which means
every present and future vendor write inherits it and a writer that changes no public page
opts out by passing nothing.

The two channels are fed differently, and the difference is the whole design. IndexNow is free
and unranked, so it takes everything the edit touched. Google is quota-capped and worked by
hand, so it takes entity detail pages only, each ranked by a `reason` (`gsc_recrawl_queue`,
`DATABASE_SCHEMA.md` §9.8). A product edit still resolves the trade publication floor
post-commit before announcing anything, exactly as promote does, so a sub-floor `noindex`
trade page is never submitted. `STAGE_1_SPEC.md` §20.2 holds the full contract and ADR 0031
holds the reasoning for the Google half.

**The picker shows the full closed vocabulary**, unfiltered by the publication floor. That floor
gates the SEO surfaces, not tagging — hiding a sub-floor trade would make it permanently
unreachable, since a vendor tagging it is exactly how it reaches the floor. The form states the
§1.1 rule inline, because "most products have none" reads as broken next to three facets where
more tags is simply more accurate.

---

### 4.4 "How teams use it" is vendor-written (AECI-963 — 2026-09-16)

`products.usefulness` joins the product allow-list. It is the narrative that renders as its own section, and its own section-nav entry, on every public product detail page. Until now it was write-only through promote, so nobody could correct a word without a re-promote from the review app.

The full contract is `STAGE_2_5_SPEC.md` §12 and ADR 0033. What matters for this surface:

- **It is the one field whose OWNERSHIP moves on first write.** A vendor save sets `products.usefulness_source = 'vendor'`, after which promote stops writing the column for that product and reports the refusal to the review app in `preserved[]`. Nothing clears it back. That is the `logo_source` mechanism from §11 of the 2.5 spec, applied to narrative copy.
- **It has its own capability, `product.usefulness.edit`** — the first entry in `PRODUCT_COLUMN_MAP` not gated on `product.edit`. Inert under the binary ladder; it exists so a future rung can withhold narrative authorship without a handler change. The base `product.edit` check still runs first, so a lapsed vendor sending only `usefulness` gets `ENTITLEMENT_REQUIRED` naming `product.edit`, exactly as a taxonomy-only edit does.
- **Full replacement, `null` clears, absent leaves alone.** A group has no stable id, so a partial patch is not expressible.
- **The wire carries the term slug and never the display name.** The stored group has a `name` the public page interpolates verbatim; the server resolves it from the taxonomy row so a vendor cannot write free text into a slot readers parse as an AECi taxonomy label.
- **An unknown slug is a `400`**, matching §4.1's rule for taxonomy and deliberately unlike promote, which drops unresolvable groups silently. The vendor picked the term from a list we rendered, and the form re-seeds from the PATCH echo — a silent drop would settle the form clean on content that never landed.
- **It publishes immediately, with no moderation and no "vendor supplied" label.** Both were considered and declined; the editor's own copy carries the fact instead. §12.1 of the 2.5 spec records the re-open triggers.
- **Purge tags are unchanged** (`product:{slug}` already covers the detail page), and Algolia needs nothing because `usefulness` is not an indexed attribute. `MATERIAL_PRODUCT_FIELDS` gains it, so an edit files as `product.updated` rather than `product.minor` in the ADR 0031 re-crawl worklist.

The editor shipped as a summary card per facet with a modal behind a pencil, on the Profile tab. **Since AECI-994 (§6.12) there is no separate editor:** the points for a term are written directly under that term on the Audiences or Phases tab, and one Save sends the slug array and `usefulness` together.

### 4.5 Integrations are vendor-owned; AECi seeds (AECI-1005 — 2026-09-21)

**The contract for integration ownership.** ADR 0035 records the decisions; epic AECI-1003 holds the fifteen rulings it binds. The later owner writes build on this section: AECI-1006 (owner edits, §4.5.6, shipped), AECI-1007 (per-side links, §4.5.7), AECI-1010 (retire, §4.6), AECI-1011 (create, §4.7).

#### 4.5.1 Who owns an integration

- **The owner is `integrations.built_by_vendor_id`**, the vendor that offers the integration (AECI-1021's definition: the vendor the customer pays for it or gets it from). There is no `owner_vendor_id` (decision 12).
- **`claimed_at IS NOT NULL` means the owner verified that by an act**: its own claim, or an AECi admin approval of an owner-unknown claim.
- **`maintained_by` is not ownership** (decision 13). It is the display marker, and it flips to `'vendor'` when either endpoint vendor attests. A claim sets it too, so the public chip reads right.
- **`origin`** is who created the row (`'aeci'` from promote, or `'vendor'` from a vendor create, §4.7). **`retired_at`** is set while the owner has the row retired (AECI-1010, §4.6). Both were added by migration `0044` with `claimed_at`, as plain `ADD COLUMN`s (`DATABASE_SCHEMA.md` §4.3).

#### 4.5.2 The claim — `POST /api/vendor/integrations/:id/claim`

| Rule | As built |
|---|---|
| Gate | `requireVendor()` → `rateLimit('write')` → ownership in the handler. **A seat is the whole gate** (decision 15): no `requireCapability`, no Verified check. The same named exception to `API_CONTRACTS.md` §6.14 that §11b.2 made for contests. |
| Who may claim | Only the vendor in `built_by_vendor_id`, with **no approval** (decision 1). **Decision 9's predicate is the gate, not the owner's relationship to the endpoints** (ruled 2026-09-22): a third-party owner of a row that is not connector-powered may claim it, because that row has an editor. Such rows should not exist under the two-question test, so the route does not special-case them. In practice a third-party owner's rows are connector-powered, so it claims nothing in v1 (next row). |
| Refusals, in order | An unknown id, or a row the caller neither owns nor has an endpoint on, is the same `404`. An endpoint vendor that is not the owner gets `403 INTEGRATION_NOT_OWNER`. An endpoint vendor on a row with no owner gets `409 INTEGRATION_OWNER_UNKNOWN`. The owner of a connector-powered row gets `403 INTEGRATION_CONNECTOR_POWERED`. A claimed row is `409 INTEGRATION_ALREADY_CLAIMED`. |
| Connector-powered rows | **Not claimable in v1** (decision 9, ruled 2026-09-22, AECI-1005 Q1 option A). "Connector-powered" is `isConnectorPoweredEdge`: `powered_by_product_id` set, or a connector `mechanism_kind` such as `iPaaS`, which includes Convention-A self-references. `connector_evidenced_pairs` has no claim column at all. A claim there would freeze the row to promote (decision 5) while decision 9 freezes it to the owner, leaving nobody able to correct it. AECI-1040 delivers claim, edit and retire on these rows together. |
| One batch | The guarded `UPDATE` (`claimed_at`, plus §13.9's maintenance transfer), a race sentinel, the `integration.claimed` audit row, and a `notification.sent` row (`metadata.kind: 'integration_claim'`) for every vendor of either endpoint other than the owner. A lost race writes nothing and answers `409`. |
| After commit | Purges `pair:{a}__{b}` and both `product:` tags, and queues the pair re-crawl, because the maintenance marker on the pair page changed. |

Wire shape and error table: `API_CONTRACTS.md` §6.14. Handler: `apps/api/src/routes/vendor-integration-claims.ts`. Shared rules: `apps/api/src/lib/integration-claims.ts`.

**The other side's recourse is a contest.** The claim notification tells every other endpoint vendor that the row is now vendor-owned. If the owner on file is wrong, an `owner` contest goes to AECi (§11b.4), even on a claimed row.

#### 4.5.3 What a claim changes

- **Promote writes nothing to the row** from then on: no content, no owner, no endpoint re-point, no cross-table move, no claims or attestations. `REVIEW_APP_PROMOTE_API.md` §4b is the review-app contract.
- **Content contests route to the owner** (§11b.4). `isIntegrationClaimed` is now the real `claimed_at` test.
- **The `integrations` freshness cursor moves** (`STAGE_2_REALTIME_SPEC.md` §2.2). The row-level read AECI-992 added covers the rows themselves, not only their claims and attestations, so a claim needs no cursor change of its own.
- **The ops lanes treat the row as vendor-held** (§4.5.5).
- **One path un-claims a row:** an AECi admin accept of an `owner` contest that reassigns it to a different vendor or to "neither" clears `claimed_at`, because the new owner has not acted (§11b.6 of `STAGE_2_VENDOR_PORTAL_SPEC.md`). That accept also re-routes the old owner's open contests to AECi. Nothing else, promote included, clears it.

#### 4.5.4 Owner-unknown claims (decision 11)

**An owner-unknown claim is an AECI-1008 `owner` contest (ruled 2026-09-22, option B).** There is no separate table, route or queue. A vendor on a row with no owner contests the `owner` field and proposes its own vendor. That contest always routes to AECi (§11b.4) and lands on the `/admin/contests` screen. When an admin accepts it:

- the same batch writes `built_by_vendor_id` = the submitter, `claimed_at`, and §13.9's maintenance transfer, with an `integration.claimed` audit row (`metadata.reason = 'owner-approved'`) and a claim notification to every other endpoint vendor, exactly as the owner's own claim does (§4.5.2);
- after commit it purges the pair page and both product pages and files `REVIEW - Record integration owner: <integration>`, so the review app records the owner upstream;
- **on a connector-powered row it writes nothing here** (decision 9, v1). The accept still stands and files the ordinary `REVIEW - Apply contested field: owner …` issue, so the curation lane can still record who offers the row. The refusal sits at the accept rather than at submit for that reason.

The same accept shape covers a vendor that says "we own it, not them" on a row whose recorded owner is someone else: proposed = submitter, so it too writes the owner and `claimed_at`.

**Only an endpoint vendor can assert.** Contests require an endpoint seat (§11b.2), so a third-party vendor cannot file one. That is fine in v1: a non-endpoint owner's rows are connector-powered, decision 9 keeps the claim off them anyway, and such a vendor reaches AECi through the partnership track (§5.2).

What an AECi accept writes in every other case is §11b.6.

#### 4.5.5 The ops lanes (AECI-1005)

A row is **vendor-held** when it is claimed or `origin = 'vendor'`. "No upstream record points at it" is expected for such a row, not evidence that it is residue.

| Lane | Behaviour |
|---|---|
| Strand audit (`scripts/ops/2026-09-stranded-row-audit/`) | Counts vendor-held rows and never reports one as source-gone or puts it in the `--ids-out` list. A stranded ENDPOINT on one is still a finding, marked `vendorHeld: true`. |
| Datatool prune (`apps/datatool/src/prune-integrations.ts`) | Lists vendor-held ids in the plan and refuses the run with `409 VENDOR_HELD`. No guard acknowledgment overrides it. |
| Retraction consumer (`scripts/ops/2026-09-retraction-consumer/consume.mjs`) | Refuses the whole run, loudly, when any resolved row is vendor-held and not on `HOLD`. A held entry is never deleted and never confirmed. |
| `ops:retract-product` (`apps/api/src/lib/retract-product.ts`) | Refuses to retract a product whose deletion would cascade (or detach `powered_by` on) a vendor-held integration. A refusal, so `--force` does not override it. |

All of them probe the live DDL for the columns (`vendor-held.mjs`, and `ddlHasVendorHeldColumns` in `retract-product.ts`), because migration `0044` reaches production only at the next prod promote and a query naming a missing column would fail every run until then. Since AECI-1010 the same holds for `retired_at`: the datatool prune and reindex, the retraction consumer's count repair and both reconcile CLIs (`reconcile-product-counts.ts`, which runs daily against production, and `reconcile-algolia-drift.ts`) read the `integrations` DDL first and use `liveIntegrationSqlIf`, which degrades to always-true without the column. An empty DDL read is "could not check" and throws.

A retired row is always claimed (§4.6), so every lane above already treats it as vendor-held. One lane needed a change anyway: the datatool prune's three twin guards now count only a LIVE twin as a surviving copy (AECI-1010), because a retired twin is off the public record.

#### 4.5.6 Owner edits — `PATCH /api/vendor/integrations/:id` (AECI-1006 — 2026-09-22)

The claimed owner edits its integration's standard fields, and the edit goes live with no moderation (decision 8). Wire shape and error table: `API_CONTRACTS.md` §6.14. Handler: `apps/api/src/routes/vendor-integration-edits.ts`. The gate the owner edit uses: `apps/api/src/lib/integration-owner-writes.ts`. AECI-1010's retire and restore keep their own copy of the same order (`refusalFor` in `vendor-integration-retire.ts`).

| Rule | As built |
|---|---|
| Gate | `requireVendor()` → `rateLimit('write')` → ownership → connector-powered → claimed, the last three in the handler and all before the body is parsed. **A seat is the whole gate** (decision 15): no `requireCapability`, no Verified check. |
| Refusals, in order | The claim's order (§4.5.2) with one step added. Unknown id, or a row the caller neither owns nor has an endpoint on: `404`. Endpoint vendor that is not the owner: `403 INTEGRATION_NOT_OWNER`, or `409 INTEGRATION_OWNER_UNKNOWN` when nobody is on file. Owner of a connector-powered row: `403 INTEGRATION_CONNECTOR_POWERED`. **Owner that has not claimed: `409 INTEGRATION_NOT_CLAIMED`.** Claim first: until `claimed_at` is set promote still writes the row, and the next promote of the edge would overwrite the edit. Owner of a retired row: `409 INTEGRATION_RETIRED` (AECI-1010, through `assertIntegrationLive`), and the portal offers no edit form on it. |
| Fields | The eleven contestable content fields (§11b.3 minus `owner`): `name`, `mechanism_kind`, `mechanism_name`, `direction`, `description`, `listing_url`, `docs_url`, `website`, `mechanism_url`, `pricing_model`, `maturity`. Two are **not** editable: `owner` (reassigning the owner is AECi's decision, through an `owner` contest) and `notes` (AECi's own curation column, which is not contestable either). The body is `.strict()`, so sending either is a `400`. |
| Values | The contest rule (`contestValueProblem`), plus two of the edit's own in `integrationEditValueProblem`: `name`, `mechanism_kind` and `direction` cannot be cleared, and `mechanism_kind` cannot be `iPaaS` or `integrator`. That second rule is decision 9 from the other side: an owner must not type its own row into the connector-powered state, where no vendor write could reach it again. `direction` is caller-relative, framed against `context_product_id`. |
| One batch | The guarded `UPDATE` (the changed columns, §13.9's maintenance transfer, `updated_at`) keyed on `built_by_vendor_id = <caller> AND claimed_at IS NOT NULL AND retired_at IS NULL`, the race sentinel, one `integration.updated` audit row (`reason: 'owner-edit'`, before and after of each changed field) and one `notification.sent` row (`kind: 'integration_update'`) per other endpoint vendor. A lost race writes nothing. A body that changes nothing writes nothing, not even an audit row. |
| After commit | A by-id Algolia sync of the integration record, behind promote's `dispatchHook` watchdog (`syncOwnerWriteSearch`, the tail retire and create share), so a changed mechanism, direction or description reaches search the same minute. Only the integration record: an edit changes no count, so neither product nor the vendor is re-synced. Then purges `pair:{a}__{b}` and both `product:` tags, and queues the pair re-crawl. The `updated_at` bump still puts the row in the nightly sweep as a backstop, and moves the `integrations` freshness cursor (`STAGE_2_REALTIME_SPEC.md` §2.2). |

**An edit does not touch open contests.** A contest is a request to its decider, and only the decider closes it, with a decision the submitter is told about (§11b.5). So the edit leaves every contest on the row open, including one whose proposed value the owner has just typed in. The owner still accepts or declines it in Messages. Three reasons for the least-surprising choice:

- **Auto-accepting would speak for the owner.** The submitter would get "your contest was accepted" for a decision nobody made, and an accept also writes the proposed value, which could overwrite a different value the owner chose.
- **Auto-withdrawing would speak for the submitter.** Withdraw is the submitter's act alone (§11b.5).
- **An AECi-routed contest is not the owner's to close.** A content contest filed before the claim routes to AECi and stays there (routing is frozen at submit, §11b.4), and an `owner` contest always routes to AECi.

Two consequences. First, an owner accept after an edit writes the contest's proposed value over whatever the owner typed, because that is what accepting means, and the owner is the one choosing it. Second, an **AECi accept of a content contest on a claimed row** (§11b.6) would write its proposed value over a later owner edit of that field. That one is refused (ruled 2026-09-22 on AECI-1006): the accept answers `409 CONTEST_VALUE_STALE` when the live column no longer holds the value recorded at submit, and `/admin/contests` shows the live value so the admin can see why (§11b.6).

**The portal.** §6.14.

#### 4.5.7 Per-side links (AECI-1007 — 2026-09-22)

**Each endpoint vendor stores its own listing and docs link on an integration** (decision 6), shown on the pair page beside the other side's. They are web links. Nothing routes on them and nothing reads them to grant anything.

| Rule | As built |
|---|---|
| Routes | `PUT` / `DELETE /api/vendor/integrations/:id/links/:productId/:kind`, `kind` = `listing` or `docs`. Wire shape: `API_CONTRACTS.md` §6.14 |
| Gate | `requireVendor()` → `rateLimit('write')` → side ownership → connector fence, all in that order. **A seat is the whole gate** (decision 15). |
| Who may write a side | The vendor that holds that endpoint product through `product_vendors`. **Not** the integration's owner as such, and no claim is needed: a link is the endpoint vendor's statement about its own side. A vendor that owns both endpoints writes both sides, one at a time. A non-endpoint owner has no side to link. |
| Refusals | Every miss is the same `404`: unknown id, a product that is not an endpoint, an endpoint the caller does not hold (including the other side of a row it can see). Then a `PUT` on a connector-powered row is `403 INTEGRATION_CONNECTOR_POWERED` (decision 9, ruled 2026-09-18 for links). A `DELETE` passes that fence, so a stranded link can be removed (see "When links are lost" below). Then a retired row is `409 INTEGRATION_RETIRED` (AECI-1010). A non-https URL, credentials in the URL, or more than 2,048 characters is `400`. |
| Why a product id and not `a`/`b` | Promote swaps an unclaimed row's source and target in bulk (AECI-920). A positional key would hand one vendor's link to the other. An endpoint re-point leaves the old product's link stored and unread. |
| One batch | The upsert (or the DELETE plus a one-row race sentinel), the §13.9 maintenance transfer on the `integrations` row, and one `integration.link_set` / `integration.link_removed` audit row. The transfer moves `integrations.updated_at`, which is how the §2.2 freshness cursor sees the write on both sides. |
| After commit | Purges `pair:{a}__{b}` and both `product:` tags and queues the pair re-crawl (`CACHE_STRATEGY.md` §3). |
| Promote | Never writes the table (`promote-vendor-links.spec.ts`). It keeps writing AECi's curated `listing_url` / `docs_url` on unclaimed rows; the pair page falls back to those per kind when neither side has set one (`STAGE_1_5_SPEC.md` §7.1). |
| When links are lost, or stranded | **Deleted** only with their row, or with their product. On an **unclaimed** row the row goes with a retraction, a datatool prune, an `ops:retract-product` of an endpoint, or a promote cross-table move into `connector_evidenced_pairs`. `ops:retract-product` also deletes every link whose `product_id` is the retracted product, on any row, because `product_id` carries no FK and nothing else would clear it. A vendor-held row is refused by every one of those lanes (§4.5.5). `ops:retract-product` counts the links on its tombstone, and the retraction consumer reports them on its cascade line (reported, not ceilinged), both behind a table probe for tiers without `0045`. **Stranded, not deleted, when promote makes an unclaimed row connector-powered in place**: a connector `mechanism_kind` (`iPaaS`, `integrator`) or a Convention-A self-reference keeps the row in `integrations`, so its links stay stored. The pair read then returns empty `vendor_links` for it (`isConnectorPoweredEdge`, decision 9). The vendor can still remove its own link, since a `DELETE` passes the connector fence and removing is not an edit. That DELETE writes no maintenance transfer. A `PUT` stays refused. |

**The portal.** `own_links` on `GET /api/vendor/integrations` carries the caller's own side per entry. The card's "Your links" block (`vendor-integration-links-form.ts`) shows them and opens a two-field form. It renders on every attestable card whatever the entitlement. On a connector-powered card it renders only while the vendor still holds a stranded link: read-only, with a sentence saying readers no longer see the links and a Remove action per link. With no stored link it does not render there at all. Saving is pessimistic: one request per changed field, each echo spliced into the store (never a whole-list refetch, which would clobber a concurrent data-flow write), then one announcement through the portal's live region.

**Retired rows (AECI-1010).** A retired row refuses both PUT and DELETE with `409 INTEGRATION_RETIRED`, after the side check and the connector fence, through `assertIntegrationLive`. The batch opens with `integrationLiveSentinel`, so a retire that lands between the read and the batch stops the write. The card hides "Your links" on a retired row.

**Not built here.** Links do not appear on the product-detail page, in Algolia, or in the public integration detail read.

### 4.6 The owner retires and restores an integration (AECI-1010 — 2026-09-22)

**Retire withdraws a claimed integration from the public site without deleting anything.** It is not a retraction (ADR 0030 governs deletes, and this is not one). The row, its claims and its attestations stay, so restore is lossless. Rulings of 2026-09-22 are marked.

#### 4.6.1 The routes

| Rule | As built |
|---|---|
| Routes | `POST /api/vendor/integrations/:id/retire` and `/restore`. No body. |
| Gate | `requireVendor()` → `rateLimit('write')` → in the handler: ownership (the claim route's `404` / `403 INTEGRATION_NOT_OWNER` / `409 INTEGRATION_OWNER_UNKNOWN`), then `403 INTEGRATION_CONNECTOR_POWERED` (decision 9), then `409 INTEGRATION_NOT_CLAIMED`. A seat is the whole gate (decision 15). |
| Idempotency | Retiring a retired row is `409 INTEGRATION_RETIRED`. Restoring a live row is `409 INTEGRATION_NOT_RETIRED`. Neither writes. |
| One batch | The guarded `UPDATE` of `retired_at` and `updated_at`, a race sentinel, the contest closes (below), the `integration.retired` / `integration.restored` audit row, a `notification.sent` row (`metadata.kind: 'integration_retire'`) per other endpoint vendor, and both endpoints' `integration_count` recomputed in the batch, so the count is committed before any purge. A lost race with no other refusal to give answers `409 INTEGRATION_CHANGED_WHILE_SAVING`. |
| Open contests | **Closed as `withdrawn` on retire, in the same batch** (ruled). Each gets its workflow closure, an `integration.contest.withdrawn` audit row with reason `integration retired`, and a contest notification to the submitter vendor with the event `closed_by_retire`, all in the same batch. The notification copy is AECI-1023's (below). A last sentinel refuses the batch if a contest is still open, and the contest submit carries the mirror sentinel, so neither interleaving leaves an open contest on a retired row. **Restore reopens none** (ruled). |
| `maintained_by`, `last_reviewed_at` | Untouched. Retire changes whether the row is shown, not what it says (§13.9 is about content writes), and a claimed row is already vendor-maintained. |
| After commit | Re-index by id (behind the `dispatchHook` watchdog, logging each failed entity) the integration, both products and the owner vendor; purge `pair:`, both `product:`, `vendor:{owner}`, `index:products`, `taxonomy` and `sitemap`; queue the pair and both product URLs for re-crawl. `CACHE_STRATEGY.md` §3 records the tag set. |

Wire shape: `API_CONTRACTS.md` §6.14. Handler: `apps/api/src/routes/vendor-integration-retire.ts`.

#### 4.6.2 What a retired row is

> **Promotion gate (AECI-1010 review, 2026-09-22), closed by the 1011 twin guard, which covers the insert, de-route and re-point paths.** The gate: do not promote AECI-1010 to production before AECI-1011's `VENDOR_OWNED_TWIN` promote guard. A retired row is claimed, so the §4.5.3 fence keeps promote off it. But three promote writes never touch the retired row and can still put a fresh, live twin beside it, undoing the retire in public with a row the owner never saw: an insert under a **new** upstream id for the same pair, a **de-route** that moves a connector-evidenced pair back into `integrations`, and an UPDATE that **re-points** an unclaimed curated row onto the pair. The AECI-1011 guard (§4.7.3, `REVIEW_APP_PROMOTE_API.md` §4c) skips all three when the result would strongly match any vendor-held row, **retired rows included**, and reports it. Neither branch is merged yet, so **AECI-1010 and AECI-1011 must reach production in the same promote, or AECI-1011 first.**

- **Public:** gone from every count, id set and read (`STAGE_1_5_SPEC.md` §13.5 holds the full, asserted list). The pair page renders without it, and with no live mechanism left falls to its existing `noindex` branch. **`/integrations/:id` keeps its 301 to the pair page** (ruled), because `GET /api/integrations/:id` is deliberately unfiltered. For a retired row that route answers only `{ id, retired: true, source: { slug }, target: { slug } }` (ruled): the redirect's needs, and no name or content.
- **Search:** the Algolia sync's delete arm removes the record. The 09:00 orphan sweep is the backstop only.
- **Portal:** still listed by `GET /api/vendor/integrations` for both endpoint vendors, with `retired_at` set. **The owner sees it with a Restore action. The other endpoint vendor sees it read-only, marked retired** (ruled), which is what the retire notification lands on. Nobody can add a data flow, attest, contest or (since AECI-1006) edit it: those writes answer `409 INTEGRATION_RETIRED`. Withdrawing an existing attestation stays allowed. **A retired row is listed but never counted:** the Integrations tab's status chips (the "All" count included), each counterpart group's health and counts, and the overview's claim tallies all skip it, and no status chip matches it. Only the unfiltered list shows it (`isRetiredIntegration` in `vendor-integration-health.ts`).
- **Freshness cursor:** the `integrations` scope already reads `MAX(integrations.updated_at)` under `ownedEndpointJoin`, unfiltered (AECI-1005), so a retire and a restore move it for both sides with no new statement (`STAGE_2_REALTIME_SPEC.md` §2.2).
- **Promote:** never writes `retired_at`, and a retired row is claimed (or vendor-created), so the §4.5.3 fence keeps promote off it entirely. Nothing un-retires a row except the owner's restore.
- **Invariant:** retired ⇒ claimed. It cannot be a CHECK constraint (a CHECK change recreates `integrations`, which cascades away its claims), so the 04:00 data-quality suite checks it (`retired_integration_unclaimed`, severity `error`).

#### 4.6.3 The portal UI

A separate section at the foot of the integration card (`vendor-integration-retire.ts`), kept apart from the card's other owner writes. Retire needs a second, explicit step: the button opens an inline confirmation that says what will happen, and only its own button sends the request. No browser `confirm()`. Writes are pessimistic, outcomes go through the portal's one live region, and focus follows the change (to the confirm button, back to the trigger on cancel, to the status line after a retire).

### 4.7 A vendor creates an integration (AECI-1011 — 2026-09-22)

**A vendor lists an integration it offers that AECi has no record of, and it goes live at once** (decisions 7 and 8). The new row is the vendor's from its first statement: owned, claimed, and so behind the promote fence. Duplicates are warned about and never refused (decision 10, AECI-1012 ruling 2026-09-22).

#### 4.7.1 The route — `POST /api/vendor/integrations`

| Rule | As built |
|---|---|
| Gate | `requireVendor()` → `rateLimit('write')` → the endpoint checks in the handler. **A seat is the whole gate** (decision 15): no `requireCapability`, no Verified check. |
| Body | `product_id` (the caller's product), `counterpart_product_id`, and the eleven standard fields of the owner edit (§4.5.6) with the same caps and value rule (`integrationEditValueProblem`). `name`, `mechanism_kind` and `direction` are required. `.strict()`: `powered_by_product_id`, `built_by_vendor_id`, `origin` or any other key is a `400`. Wire shape: `API_CONTRACTS.md` §6.14. |
| Endpoints | `product_id` must be a **promoted** product the caller's vendor holds through `product_vendors`. `counterpart_product_id` must be a **promoted** product. Either miss (not the caller's, not promoted, no such id) is the same `404`. Equal ids are a `400`. The caller's product becomes the row's **source**, the way upstream orients a row by its owner, and `direction` is framed against it. |
| Never connector-powered | Decision 9 from the other side, as for the owner edit: there is no `powered_by` field, and `iPaaS` or `integrator` is `422 INTEGRATION_INVALID_VALUE`. A connector-powered row would be frozen against its own owner. |
| What it writes | `origin = 'vendor'`, `built_by_vendor_id` = caller, `claimed_at` = now, and §13.9's maintenance transfer (`maintained_by = 'vendor'`, `last_reviewed_at` = now). The id is minted app-side with `crypto.randomUUID()`, as promote mints its creates. |
| One batch | The INSERT, the `integration.created` audit row (the action the catalog additions series counts; `metadata.source = 'vendor-portal'`, `reason = 'vendor-create'`, `possibleDuplicateIds`), one `notification.sent` row (`metadata.kind: 'integration_create'`) per other endpoint vendor, and both endpoints' `integration_count` recomputed in the batch (`integrationCountRecomputeStmt`, the §4.6.1 pattern). A create has no prior state to race, so there is no sentinel. |
| After commit | By-id Algolia sync of the integration, both products and the vendor, behind `dispatchHook` (the retire's `syncOwnerWriteSearch`). Purge `pair:{a}__{b}`, both `product:`, `vendor:{caller}`, `index:products`, `taxonomy` and `sitemap` (`CACHE_STRATEGY.md` §3). Queue the pair and both product URLs through the IndexNow buffer and the GSC re-crawl queue. `index:home` is left to its daily cron, as for every vendor write. |
| Response | `201 { integration, possible_duplicates }`. |

Handler: `apps/api/src/routes/vendor-integration-create.ts`. Shared rule: `apps/api/src/lib/integration-twins.ts`.

#### 4.7.2 Duplicates warn, never refuse

A **strong match** is an existing `integrations` row with the same two products **in either orientation**, the same connector (none, for a create), and an owner that is the caller or unknown. Kind and name are not in **this** key (AECI-1012 option 1C): the warning stays broad, so a vendor hears about a curated row it would duplicate under a different kind. Promote's key (§4.7.3) adds the kind, ruled 2026-09-22. The create runs that one query and returns every match, curated or vendor-held, live or retired, in `possible_duplicates` (id, name, kind, orientation, owner, `claimed`, `retired`), and records the ids in the audit row. It never refuses. Refusing a create when the caller already owns a strong match (`409 CLAIM_INSTEAD`) was deferred by the ruling.

#### 4.7.3 Promote skips a twin of a vendor-held row

The duplicate that matters comes from the other direction: a curator adds the same pair upstream, where the vendor's row is invisible, and promote writes it beside the vendor's. Promote's key is the §4.7.2 strong match **plus the same `mechanism_kind`** (NULL equal to NULL; ruled 2026-09-22 on AECI-1012), so a curated `marketplace-app` row beside a vendor's `native` row for one pair is two integrations. It is checked against the row as it would be after the write, on three writes:

1. an INSERT (no `supabaseId`, or the stale-id fallback, which still reports its dead id in `staleSupabaseIds`);
2. a **de-route**, the move INSERT out of `connector_evidenced_pairs`. On a match the evidenced row is left untouched, never deleted;
3. an UPDATE of an unclaimed curated row whose endpoints (as a pair) or connector change. An UPDATE that re-points nothing, a direction swap included, cannot create a new match and is not asked.

When the result has a strong match that is **vendor-held** (claimed, or `origin = 'vendor'`), **live or retired**, promote writes nothing for that edge (no partial update) and reports `{ kind: 'integration', reason: 'VENDOR_OWNED_TWIN', existingId }` in `skipped[]`, with a `promote.blocked` audit row. An in-batch sentinel covers a vendor create that lands between the plan read and the commit: the promote aborts with `409 VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE` and a re-push gets the skip. It never deletes. `REVIEW_APP_PROMOTE_API.md` §4c is the review-app contract, and AECI-1047 is the review-side follow-up. This guard, covering all three writes, is what closes the §4.6.2 promotion gate.

**The promote fence holds a vendor-created row without a claim.** An AECi `owner` accept can reassign a vendor-created row and clear `claimed_at` (§11b.6). The AECI-1005 fence (§4.5.3) keyed on `claimed_at` alone would then hand promote a row no curator ever wrote. Since AECI-1011 it keys on `claimed_at IS NOT NULL OR origin = 'vendor'`, at plan time (`claimFenceRefuses`) and in the batch sentinel.

#### 4.7.3a Ranking: a vendor-created row counts (accepted risk, ruled 2026-09-22)

A vendor-created row is a live integration, so it counts in both endpoints' `integration_count`. That column is still the **first custom ranking signal** (`SEARCH_RANKING.md` §"Custom ranking"), so a seated vendor can raise its own product's search rank by creating rows. Chris ruled the risk accepted for Stage 2.1. What bounds it: a seat is admin-approved, every create writes an `integration.created` audit row naming the seat, and the duplicate warning shows the vendor what already exists. **Hard dependency: AECI-636 retires `integration_count` from ranking** (`STAGE_2_5_SPEC.md`), which is what removes the lever. Until then the audit log is the control. This does not breach "no pay-for-placement": the lever is a seat, not a tier, and it is the same count every other integration adds.

#### 4.7.4 Where a vendor-created row is not an orphan

A vendor-created row has no upstream record, by construction. §4.5.5's lanes already read `origin = 'vendor'` as vendor-held. The rest, checked for AECI-1011:

| Site | Behaviour for an `origin = 'vendor'` row |
|---|---|
| Algolia drift counters, the 09:00 sweep's id set, `INTEGRATION_IDS_SQL`, the sync, the datatool rebuild | Counted and indexed like any live row. Membership is D1-only and keys on promotion and `retired_at`, **never on `origin` or `claimed_at`**: a small keyed subset is exactly the population the sweep would delete for good. |
| Promote id maps | Upstream never sends the row's id, so promote never touches it. The twin guard (§4.7.3) stops a second row. |
| Count reconcile CLIs, `metrics_daily`, the admin catalog totals | Counted normally. A create writes `integration.created`, so it is a catalog addition. |
| Data quality | New check `vendor_integration_unclaimed` (`warn`): a vendor-created row with no claim. The only path to it is an AECi `owner` accept that reassigns the row. Until the new owner claims it nobody can edit or retire it, and promote never will, because the fence keys on `origin = 'vendor'` too (§4.7.3) (`ADMIN_PANEL_SPEC.md` §23.1). |
| Admin screens | No change. `/admin/contests` and the catalog screens read the row as any other. |
| Catalog agent | Its two queries already read live rows only (AECI-1010), and count vendor-created rows like any other. |

#### 4.7.5 The portal UI

"Add an integration" at the top of the Integrations tab (`components/vendor-integration-create.ts`, mounted by `vendor-integrations-section.ts`). Not gated on `canWrite`: a seat is the whole gate. A disclosure opens a pessimistic form with four `<fieldset>`s. The first is the two products: your product, preselected from the tab, and the other product, found by name through the public `GET /api/products?search=` and chosen from radio results that leave out your own product. The other three are the owner edit's groups (`EDIT_GROUPS`, the same labels and value rule). The type picker offers `OWNER_EDITABLE_MECHANISM_KINDS` only. Before submit it lists the rows already on record for the chosen pair, from the list the tab holds, as context. After a `201` it announces through the one live region, revalidates `integrations`, moves focus to the result, and lists `possible_duplicates` as a warning with the way out (contest the existing row, or retire the new one). Each refusal code has its own sentence in a `role="alert"`. The public pair card says "Added by the vendor" beside "Offered by" for an `origin = 'vendor'` row. It names nobody, because an AECi owner reassignment can change "Offered by" later. AECI-1023 owns the final copy for both.

**Preview.** `/preview/vendor-dashboard/products/summit-model-coordination/integrations?create=open` renders the Integrations tab with the form open on first paint (server-rendered), for the design detector. `?concept=b` on any preview child route selects the single-page concept. The fixture answers the counterpart search from a small catalogue.

**Tests.** `vendor-integration-create.spec.ts` (every gate branch, the batch, the counts, the tags, the duplicate warning in both orientations, retired matches), `promote-vendor-twin.spec.ts` (both orientations, retired, claimed curated, the stale-id fallback and its stale-id report, unknown owner, the mechanism kind, the replay, the race, the evidenced de-route, the curated re-point, the Convention-A connector clear, the non-re-pointing UPDATE, and the fence on a vendor-created row with no claim), `vendor-integration-create.component.spec.ts`.

---

## 5. Admin claim-review surface (AECI-521)

**Reviewer-assisted verification — no auto-grant (`STAGE_2_SPEC.md` §8.1(1)).** The AECi-facing UI presents **verification signals** and a human decides; approve triggers §3, reject triggers §3's reject path + §9 email.

**Signals surfaced (enrichment at launch — §8.3(4)).**

- **Email-domain match** — `domain_match` (already computed at submit via `computeDomainMatch`) against the vendor's known domain(s).
- **The claimant's own LinkedIn profile** (`submitter_linkedin_url`, AECI-847) — an optional field on the public claim form, host-anchored to `linkedin.com` at submit. This is the strongest identity signal the surface has, because it names one person rather than returning a list.
- **A pre-built LinkedIn/person search link** — a constructed search URL from `submitter_email` / `submitter_name`, opened by the reviewer. Since AECI-847 this is the **fallback**, rendered only when the claimant supplied no profile of their own. Never both: a name search confirms nobody, and showing the guess beside real evidence invites reading it as corroboration. A **link only** — real person-lookup providers (data enrichment APIs) are a **deferred DPA/GDPR decision**, out of scope at launch.

**UI pattern.** A new `/admin/claims` child surface cloning the existing admin request queue:

- **Route** — add a child to the `/admin` layout route (`apps/web/src/app/app.routes.ts` ~:224-243), e.g. `{ path: 'claims', loadComponent: … ClaimQueue }`.
- **Shell nav** — add a nav `<li>` in `AdminShell` (`apps/web/src/app/admin/admin-shell.ts`) after the requests link. The `/admin` gate (`summary() === null` → `<aec-not-found/>`) already hides the surface from non-admins.
- **Component** — `ClaimQueue` copies `RequestQueue` (`apps/web/src/app/admin/requests/request-queue.ts`); `AdminClaimsApi` mirrors `AdminRequestsApi` (`GET /api/admin/claims`, `PATCH /api/admin/claims/:id`), same-origin cookie auth behind `requireAdmin()`.
- **Badge (optional)** — a pending-claims count would extend `AdminSummaryStore` (`apps/web/src/app/admin/admin-summary.store.ts`) + the summary API (`apps/api/src/routes/admin-summary.ts`), which today counts pending reviews only. Follow the requests-queue precedent (no badge) unless a count is wanted.

The moderation handler behind these routes clones `createModerateRequestHandler`, wired to the §3 grant/reject batch (not the plain request resolve).

### 5.0a Claimant-supplied LinkedIn profile (AECI-847 — 2026-09-10)

Shipped with migration **`0030`** (additive `ALTER TABLE vendor_requests ADD submitter_linkedin_url text` — no table recreate, so none of the `0027` cascade hazard applies). Decisions taken at build:

- **Host allowlist, not a URL check.** `ClaimFormSchema` requires `https:` and a hostname of `linkedin.com` or a subdomain. A generic `z.string().url()` would accept the claimant's own marketing page, which is indistinguishable from evidence in the admin queue, and would let a `javascript:` string reach an `href` on an admin surface. Regional mirrors (`uk.linkedin.com`) pass by design.
- **Optional, and the key is omittable.** The field carries `.default('')` on the shared schema — the only field on either request schema that does. `POST /api/requests/claim` was already serving production traffic, so a body without the key must still validate. `''` is stored as `NULL`; an empty string is not an absent signal to anything downstream.
- **Claim-only at the API surface.** The column is physically available to corrections (the same arrangement as `admin_notes`), but `createCorrectionSubmitHandler` always passes `null`. A correction identifies nobody, so there is nothing for the signal to mean there.
- **One person link, never two.** Both `/admin/claims` and `/admin/claims/:id` render the supplied profile when present and the built name search only when it is null. The rule and its reason are in §5's signal list.
- **Carried into both operator channels.** The Linear issue description gains a `**LinkedIn:**` line (omitted entirely when null) and the claim-intake alert email gains a `LinkedIn` row that reads `not supplied` rather than disappearing — a missing row in an ops table reads as a rendering bug.
- **The drawer gained a pinned submit bar.** A sixth field pushed "Send claim" below the fold of the `RequestDrawer` panel, which scrolled as one block. The panel is now a clipped flex column with **one** scroll port: the eyebrow/title/close/subtitle block is pinned above it, and the submit control is pinned below it in a bordered `--surface-raised` bar that full-bleeds past the port's horizontal padding and owns the panel's bottom padding. The routed `/{products,vendors}/:slug/claim` page keeps normal flow — it has no scroll port and the window is the scroller. Details in `DESIGN.md` § Phase 6.
- **Still no enrichment.** The signal is what the claimant volunteers about themselves. Third-party person-lookup providers remain the deferred DPA/GDPR decision of §11; nothing about this change touches it.

### 5.1 As built (AECI-521 — 2026-07-25)

Shipped with **no migration**. The AECI-519 `PATCH /api/admin/claims/:id` already existed; this issue added the LIST endpoint + the reviewer surface, wired to that PATCH. Contracts: `packages/shared/src/api/admin-claims.ts` (`AdminClaim` / `ListVendorClaims{Query,Response}` schemas); handler: `createAdminClaimsListHandler` in `apps/api/src/routes/admin-claims.ts`; mapper `toAdminClaim` in `apps/api/src/lib/drizzle-helpers.ts`; surface under `apps/web/src/app/admin/claims/`; full contract in `API_CONTRACTS.md` §6.10 (`GET /api/admin/claims`). Decisions taken at build:

- **New endpoint, cloning the requests LIST.** `GET /api/admin/claims` mirrors `createAdminRequestsListHandler` (same `PageQuerySchema` envelope, same read-time `is_duplicate` groupBy + the `fetchAuthAccountsByEmail` `has_auth_account` seam) but is **claims-only** (`kind='claim'`, no `kind` filter) and **read-only** (no audit). `status` filter is `open|resolved|rejected` (default `open`), matching the requests contract.
- **`AdminClaim` = `AdminVendorRequest` + three signals.** The shared `AdminVendorRequest` already carried `domain_match` + `has_auth_account`; `AdminClaim` extends it with `duplicate_of_request_id`, `existing_seats`, and `related_requests`. `duplicateOfRequestId` was added to `adminVendorRequestConfig` + `RawAdminVendorRequestRow` (harmless to the requests path; only `toAdminClaim` surfaces it).
- **`null` = unavailable, `[]` = empty.** `existing_seats` / `related_requests` are **nullable**: `null` means the enrichment query failed and the UI renders "unavailable" (AC: graceful degrade); `[]` means computed-and-empty (a genuine first claim / no priors). Both enrichment queries run `.catch(() => null)`, so a signal failure never fails the list.
- **Existing seats = one grouped `profiles` scan.** Per-claim target vendor is resolved first (a `product` claim → its primary vendor, a batched clone of `resolveTargetVendor`), then one `profiles` query over the page's vendor ids (`role='vendor_admin' AND banned_at IS NULL`) — no per-row N+1. Each seat carries `display_name` + `work_email_verified` + `created_at` (no email — a seat belongs to the vendor). This covers the issue's `work_email_verified` bullet for seats; the **claimant's own** `work_email_verified`/profile-history is **omitted** — `profiles` is keyed by auth-user UUID, not email, so it isn't cheap on the read path.
- **LinkedIn link is client-built, a link only.** `linkedInSearchUrl()` builds `…/search/results/people/?keywords=<name||email>` in the component — no claimant data leaves AECi at render time (§8.3(4)). Real person-lookup/enrichment providers stay a deferred DPA/GDPR decision (§11). **Superseded in part by AECI-847** (see §5.0a above): the built search is now the fallback behind the claimant's own supplied profile.
- **Approve captures a free-text note only.** The reviewer surface exposes a single optional "arrangement notes" field on Grant, submitted as `entitlement.notes` (the offline PO/invoice record, §8.1(5) → grant audit metadata). The structured `payer`/`amount`/`terms`/`arranged_by` fields stay accepted by the AECI-519 API but are hidden at launch.
- **The surface is a `/admin/requests` clone.** New `/admin/claims` child route + a no-badge nav `<li>` in `AdminShell` (the requests precedent — *superseded by AECI-922, see below*), `AdminClaimsApi` mirroring `AdminRequestsApi`, `ClaimQueue` cloning `RequestQueue` (SSR shell + `afterNextRender` client fetch behind the shared `/admin` gate). Error handling: **409 `GRANT_CONFLICT`** and **503 `DEPENDENCY_FAILURE`** keep the row with an inline explanation; **422** drops it as already-moderated.
- **503 only where the key is absent (since AECI-530).** `SUPABASE_SERVICE_ROLE_KEY` is CI-pushed to the API Worker on staging, demo and production, so the AECI-519 grant resolves there. Wherever the key is absent — PR previews and local dev — the grant reports `DEPENDENCY_FAILURE` (503) and the surface renders that as "Grant unavailable — the identity service isn't configured. Reject still works." Reject needs no resolution and works everywhere.
- **Design anchor.** Internal surface → the binding anchor is the existing `/admin/requests` queue (Anchor-Site Rule — it must read as a sibling); externally validated against the Reddit mod-queue pattern (card-per-item list + status badge + inline approve/reject). `impeccable detect` clean; structural a11y covered by `claim-queue.component.spec.ts`.
- **Claim-decision email is AECI-528's.** The AC "the claimant is notified" is satisfied by the AECI-519 PATCH's already-wired `SendClaimDecisionEmail` no-op seam; AECI-528 injects the real Resend sender. This issue adds no email code.

**AECI-739 additions (2026-09-02) — the claim detail route + the operator note.** Same shape, three endpoints' worth of surface, one migration:

- **`GET /api/admin/claims/:id` + `PATCH /api/admin/claims/:id/notes`**, both behind `requireAdmin()`, both in `routes/admin-claims.ts`. The detail reuses the LIST's own enrichment helpers by passing a one-row array, so a signal cannot be computed two ways; it keeps the `null` = unavailable convention, and it emits **no `audit_log` row** (it is a read). The note write is the third thing an admin does to a claim and rides the same `aeci.claim.moderation.action` metric with `action:note`.
- **`AdminClaim` gained `admin_notes`; the status enum gained `in_review`.** The note is on the LIST as well as the detail on purpose — §5.2's handling of a pure-connector claim is to leave it `open`, and a queue of open claims with no visible reason why any is parked is the cost that motivated the issue. The enum widened because an `in_review` claim (what the webhook writes for a `started` Linear issue) appeared in no tab while being addressable by id; a detail route must not imply a status the list cannot find. `admin_notes` was added to **both** `adminVendorRequestConfig` and `RawAdminVendorRequestRow` — the rows are cast unchecked, so one without the other is invisible with no type error (the same two-part edit `duplicate_of_request_id` needed).
- **`duplicate_siblings` is an ARRAY, not a nullable signal.** It is the one enrichment that is deliberately not fail-soft: it backs `is_duplicate` (which the detail computes as `duplicate_siblings.length > 0`, the LIST's group-by rule stated directly), and a page silently reporting "no duplicates" because a query failed would be worse than an error.
- **Design anchor.** Same rule as the queue, one level down: the binding anchor is `/admin/vendors/:id` (AECI-652 / AECI-694) — the detail page must read as its sibling, flat child of the `/admin` layout with no per-route resolver, `notFound` split from `loadFailed` through the shared structural `isStatus`, and one page-owned polite live region. No nav entry: a parameterised route has no nav-able URL.

**AECI-922 additions (2026-09-14) — the queue gained a nav badge.** No endpoint moved; the contract lives in `ADMIN_PANEL_SPEC.md` §5.0c. Three notes that touch this section:

- **The "no summary badge, following the requests precedent" decision is reversed.** `/admin/claims` now carries `pending_claims` — open claims only — and `/admin/requests` carries `pending_requests`, with the Operations category showing their sum alongside `pending_reviews`. A successful grant or reject decrements the count in place, so the badge ticks down without a round-trip, as `/admin/reviews` has always done.
- **`/admin/requests` became corrections-only, which is what makes the sum honest.** Claims and corrections are two `kind`s of one `vendor_requests` table, and the requests screen listed both by default — so counting both screens would have put every open claim into the Operations total twice. That screen now pins `kind: 'correction'` and drops its kind filter; `/admin/claims` is unchanged and remains the only surface that can grant or reject a claim.
- **A parked claim still counts.** §5.2 leaves a pure-connector vendor's claim `open` deliberately, and `pending_claims` counts `open` — so a parked claim keeps the badge lit. That is the intended reading: the operator note explains *why* it is parked, and the badge is what stops a parked claim from being a forgotten one. The `in_review` tab is the opposite case and is **not** counted, which is why the queue reads a row's status before decrementing.

### 5.2 Operator note — connector-vendor claims route to the partnership track (AECI-704)

**`STAGE_2_SPEC.md` §8.8 / §8.9 / §8.10.** A pure **connector** vendor that owns no integration it manages is not invoiced for verification and is never sold it (a connector vendor that does own integrations it manages pays, step 1a); what it gets instead is a catalogue-maintenance seat on the connector admin surface (AECI-722's screen, AECI-724's seat). Neither exists yet, so this is a **manual operator step** — and because §5's console offers only Grant and Reject, both of which are wrong here, the procedure has to be written down rather than inferred.

**1. Identify — the payer test, not a vendor flag.** Per §8.8(1): does the vendor own **any** product with `product_role IN ('application','hybrid')`? If yes it is an ordinary paying vendor and takes the ordinary §5 flow — `hybrid` counts as an endpoint, and Autodesk, Trimble, Deltek and Sage Group all own connector-role products. Only a vendor **all** of whose products are `'connector'` is in scope here.

**1a. Then the owner test (`STAGE_2_SPEC.md` §8.10(1), added 2026-09-18 for AECI-1017).** A pure connector vendor still pays if it **owns integrations it manages**. Ask two things.

- **Is it the recorded owner of any live integration?** The owner is `built_by_vendor_id`, shown publicly as "Offered by". Check **both** delivered-tier tables. A third-party owner's rows are mostly in `connector_evidenced_pairs`, because promote routes an edge whose connector is a third product there (§8.10(5)). A count over `integrations` alone reads zero for exactly the vendors this step exists for.
- **Does it want to manage them through the portal?** Claiming, editing, retiring and creating are managing. A claimant that only wants its connector catalogue maintained is not asking to manage its integrations.

If both answers are yes, it is a **third-party owner**. It takes the **ordinary Grant**, with payment arranged offline like any other paying vendor (`STAGE_2_SPEC.md` §8.1(5)). Steps 2 to 9 do not apply to it. Grant opens a `verified` entitlement and lights the public account label, which is correct for a paying account. If the vendor already holds a §8.9 seat from step 9, do not ask it to re-claim. Open the entitlement on `/admin/vendors/:id` instead (`PATCH /api/admin/vendors/:id/entitlement`, `STAGE_2_PAID_TIERS_SPEC.md` §5.1).

If either answer is no, it is still a pure connector vendor in §8.9's sense, and steps 2 to 9 apply unchanged.

> **Tell the claimant what the seat does in v1.** Decision 9 of epic AECI-1003 stays as written for v1, and it also blocks the claim (ruled 2026-09-21 and 2026-09-22, `STAGE_2_SPEC.md` §8.10(5)). A third-party owner's integrations are connector-powered, so in v1 its seat does nothing to them. It cannot claim, edit, retire or create them, and it never sets per-side links because it owns neither side. The seat does carry its vendor profile, its connector product listing, taxonomy, the "How teams use it" narrative and analytics. Claiming, editing and retiring its own connector-powered integrations is **AECI-1040**, not yet built. Say so before arranging payment, so nobody pays for a capability that does not exist yet.
>
> **Console gap, tracked as AECI-1041.** Nothing on `/admin/claims` or `/admin/vendors/:id` shows how many integrations a vendor owns. AECI-738's pure-connector banner **will fire on a third-party owner** and tells the operator not to Grant. For this step the banner is wrong, and overriding it is correct. It warns and does not gate, so the Grant button works. Until the console shows the count, answer the first question with a read-only query against the environment's D1. Replace `VENDOR_ID` with the vendor's id.
>
> ```sql
> SELECT 'integrations' AS tbl, COUNT(*) AS owned FROM integrations WHERE built_by_vendor_id = 'VENDOR_ID' UNION ALL SELECT 'connector_evidenced_pairs', COUNT(*) FROM connector_evidenced_pairs WHERE built_by_vendor_id = 'VENDOR_ID';
> ```
>
> Run it with `wrangler d1 execute <db> --remote --command`, never `--file`, which returns no rows.

> **Console gap CLOSED — AECI-738, 2026-09-02.** Step 1 is now answerable without leaving the console. `AdminClaim` carries `product_roles` (`{ application, connector, hybrid, total }`) and `is_pure_connector_vendor`, and `GET /api/admin/vendors/:id` carries the same two (`API_CONTRACTS.md` §6.10). The claim card renders the breakdown as a verification signal **and**, on a pure-connector vendor, repeats it as a warning banner immediately above the actions — because the signals list sits well above the buttons and the mistake made at those buttons is the one-way one this section exists to prevent. `/admin/vendors/:id` renders the breakdown in its Basics list. Both derive from `product_vendors ⋈ products` in one grouped read, shared through `apps/api/src/lib/vendor-product-roles.ts` so the two screens cannot describe one vendor differently, and the label through `apps/web/src/app/admin/product-roles/product-roles-label.ts`. Three decisions worth knowing:
>
> - **`RoleBadge` is deliberately NOT reused**, despite being a drop-in. It self-hides for `application`, which is right for a per-product chip on a public page (no chip = endpoint, read one row at a time) and wrong for an aggregate: *"all 3 of this vendor's products are `application`"* is the **affirmative** answer to the payer test, and a control that renders nothing for it cannot state it. Reading the answer off an absence is precisely the defect this issue removed, so the console spells every role out. A capped per-product list with `RoleBadge` on `/admin/vendors/:id` is a reasonable follow-up, not a substitute.
> - **Zero products is UNKNOWN, not exempt.** A vendor owning nothing renders "No products on record — role unknown", never the carve-out. `is_pure_connector_vendor` is `false` in that case and `product_roles.total === 0` separates it from an ordinary vendor; `null` is reserved for "the enrichment degraded" (claims only — the vendor-detail copy rides the request's own `db.batch` and cannot degrade).
> - **Grant and Reject stay ENABLED.** The banner warns; it does not gate. `product_role` is curated upstream in the review app, so a mis-roled record would hard-block a legitimate endpoint vendor's claim, and steps 2–4 below are an operator procedure rather than an API rule. Turning the procedure into a gate is a separate decision, not a consequence of surfacing the signal.
>
> **AECI-722 deliberately did not close this** — the gap was on `/admin/claims` and `/admin/vendors/:id`, not on the connector screen, and folding it in would have coupled an unrelated payload change to the connector lane's merge. AECI-738 needed nothing from that lane. The *other* gap named in step 6 — no claim detail route, no operator-note field — is still open as **AECI-739**.

**2. Do not press Grant.** Approve is **unconditional**: `approveClaim` composes `grantSeatStatements` with `activateEntitlementStatements` in one batch at `GRANT_TIER = 'verified'` (`apps/api/src/routes/admin-claims.ts`), which opens a `vendor_entitlements` row, flips the legacy `vendors.verified` mirror, and hands the seat **every** capability in `TIER_CAPABILITIES.verified`. There is no partial grant, and approve-then-clear is not a workaround — it shows the public account label, bumps `vendors.updated_at` in both directions so the nightly Algolia push can carry the changed account status in between, and leaves an audit trail that reads as a customer granted and then revoked.

**3. Do not press Reject either.** `sendClaimRejectedEmail` (`apps/api/src/lib/email.ts`) sends subject *"Your claim for {name} was not approved"* over body *"After review, we weren't able to approve it."* That is an explicit decline, not merely a neutral one, and the reviewer's `reason` is an **internal audit note that is never emailed** (§9), so nothing in-product softens it. A decline is the one-way door §8.8(2) refused for the badge — the reasoning applies harder to an email aimed at exactly the party we want a relationship with.

**4. Park the claim as `open`, and route out of band.** Leave the request in `open`, reply to the claimant directly naming the partnership track, and **prefer to keep the linked Linear issue in an unstarted-category state**. `STATE_TYPE_TO_STATUS` (`apps/api/src/routes/webhooks.ts`) maps `triage` / `backlog` / `unstarted` → `open`, so the issue may sit in any of them indefinitely. Only `started` → `in_review`, and **`GET /api/admin/claims` cannot show an `in_review` claim at all** — it filters on an *exact* status and its query enum offers only `open | resolved | rejected` — so moving the issue to In Progress used to make the claim vanish from every queue view. **AECI-739 widened the query enum to all four statuses and gave the queue an In review tab**, so that is now a preference rather than a trap — an `in_review` claim is findable, and the detail page explains the state. Unstarted is still the better default: `open` is the working queue's landing tab, which is where a parked claim wants to be seen. `completed` → `resolved` is worse still: the claim then reads as approved in the Resolved tab with no seat and no grant behind it. **Since AECI-740 (2026-09-03) parking is a choice rather than the only move** — step 9's action can hand the vendor its seat out of band — but the claim's own status is unchanged by that: provisioning writes no `vendor_requests` row, and `resolved` would still assert a paid account that was never opened. Park it, provision the seat, and say so in the note.

**5. Expect the duplicate chip to fire on later claims.** A parked-open claim stays inside the `openClaims` group-by that computes `is_duplicate` (`apps/api/src/routes/admin-claims.ts`), so **every subsequent claim on that vendor renders with the duplicate signal** — including a legitimate one from a real endpoint contact. Never dismiss a new claim on the chip alone while a parked one is open. **AECI-739 made the cause visible**: `/admin/claims/:id` carries a "Duplicate signal" section naming the open claims behind the chip, with each one's match reason and whether it carries an operator note — i.e. whether it was parked on purpose. The chip's SEMANTICS are deliberately unchanged; a claim with a note still counts. Fixing the arithmetic would mean changing a shipped signal, and the problem was never that the flag was wrong — it was that nothing said why.

**6. The record lives on the claim — `/admin/claims/:id` (AECI-739).** Write down, in the operator note, why this claim is parked and what was said out of band. It is admin-only: never shown to the claimant, never emailed, and not `aec-admin-notes` (that is the closed-enum data-caveat envelope on analytics responses, not an annotation surface). The note renders read-only on the queue card too, so a parked claim is legible from the list without opening anything — which was the whole cost of not having it. Claims still auto-create a Linear issue in the Vendor Requests project carrying the `claim` label (`apps/api/src/lib/linear.ts`), and that is still the right home for a threaded exchange with a colleague; what belongs in the note is the *decision and its reason*, where the next reviewer of the next claim on this vendor will actually look.

> **Gap CLOSED — AECI-739, 2026-09-02.** This step read *"the conversation record lives in Linear, because there is nowhere else"*, and said so explicitly "so nobody looks for an in-product home that does not exist". There is now such a home. What shipped:
>
> - **`vendor_requests.admin_notes`** (migration `0028_hard_the_call`, a plain additive `ALTER TABLE … ADD COLUMN` — the table is the parent of a self-FK and is referenced by `workflow_instances`, so a recreate would have been destructive). One nullable column, matching the `vendors.admin_notes` / `products.admin_notes` precedent.
> - **The audit trail is the note's HISTORY, not the column.** Every write emits `vendor_claim.note_updated` carrying the full old and new note in `before_state`/`after_state`, **in the same `db.batch` as the UPDATE** (§26.1) — the arrangement §2.1 already uses for the entitlement ledger. That is also why an unchanged re-save is a **200 no-op that writes nothing**: a trail of identical states is not a history. It follows this resource's own idempotency rule (re-granting an already-granted claim is a documented 200 no-op), NOT `PATCH /api/admin/vendors/:id/entitlement`'s 422, which gates invalid *state transitions* — text that did not change is not one.
> - **`PATCH /api/admin/claims/:id/notes` is a sub-resource, not a third `ModerateClaimSchema.action`.** Moderation is a one-way transition that grants a paid account or declines one by email; a note is neither. Keeping them apart is what lets the note be writable at **every** status, including `resolved` and `rejected` — which is where "why we parked it, and what happened next" matters most. No workflow row, no cache purge, no email.
> - **`GET /api/admin/claims/:id` 422s on a `kind='correction'` id**, with the same redirect message the PATCH sibling already returns — not a 404. The row exists; it just moderates through `/admin/requests`, and one id on one path must not tell two different stories depending on the verb.
> - **The detail page does not moderate and does not manage the entitlement.** Grant/Reject stay on the queue, beside step 2 and step 3's warning; the entitlement control stays on `/admin/vendors/:id` (AECI-652 §5.6). Both for the same reason: the sentences whose drift is an incident rather than a typo live in exactly one file.
>
> **Update (2026-09-03, AECI-740):** that gap is now **closed** by `POST /api/admin/vendors/:id/seats` (step 9 below; as-built in §5.3) — so step 4's out-of-band resolution can now provision the catalogue-maintenance seat §8.9(2) describes. `ADMIN_PANEL_SPEC.md` §5.7 has the IA; `API_CONTRACTS.md` §6.10 has the shapes.

**7. Fallback — recorded, not prescribed.** The webhook path sends **no email at all**, so *cancelling* the linked Linear issue writes `rejected` and clears the queue without any claimant-facing decline. It is not the default: it stamps a false terminal status and attributes the decision to the webhook rather than to the operator. Reach for it only if the parked queue outgrows a handful before AECI-722 / AECI-724 ship.

**8. Volume — why parking is cheap.** §8.8(4) counted **8 `promoted` + 2 `on_hold`** connector-role products in the pipeline. A queue carrying two to five parked rows is not an operational cost; a wrongly-declined partner is.

**9. When the surface exists — half of it now does.** **AECI-722 SHIPPED 2026-08-31** (`ADMIN_PANEL_SPEC.md` §5.9): `/admin/connectors` renders every catalogue, its triage backlog and its feed freshness, and carries the control for AECI-720's `managed_by` flip — so flipping a catalogue to vendor-managed, which freezes the review lane for that iPaaS and no other, is now a button rather than a curl. **What that does NOT do is provision anything.** The flip records who a catalogue was handed to in its audit metadata and grants nothing (`seat_not_granted: true`, in the row itself).

> **Gap CLOSED — AECI-740, 2026-09-03.** The other half now exists: **`POST /api/admin/vendors/:id/seats`**, rendered as an "Add a seat" control in the Seats section of `/admin/vendors/:id`. It is the **only route that writes `profiles.role = 'vendor_admin'` on its own** — the claim grant and the invite redeem write it too, but only behind a claim or an owner's invite — and it opens **no `vendor_entitlements` row** — which is the whole of §8.9(2) turned into a mechanism. So this procedure can finally **resolve** a parked claim rather than only park it. What shipped:
>
> - **Two statements, one `db.batch`** — a no-clobber `profiles` upsert (`role`, `vendor_id`, `seat_owner`, `updated_at`) and its `vendor_seat.provisioned` audit row (§26.1). **No statement names `vendors`**, so the mirror, the badge and `vendors.updated_at` are untouched and nothing reaches the nightly Algolia push as a changed vendor record. **No migration, no email, no cache purge, no workflow row.**
> - **The fence is a type and a test, not a comment.** `entitlement_granted` is `z.literal(false)` on the wire, so an edit that opened an entitlement here could not report the truth and still compile; `apps/api/src/routes/vendor-admin-role-writers.spec.ts` asserts over module source that `vendor_admin` has exactly two writers (both `lib/` batch builders) and that **no module composes `provisionSeatStatements` with `activateEntitlementStatements`**. Behaviour cannot test for the absence of a coupling that does not exist yet; a source scan can. The tempting edit is small and looks like a bug fix — somebody comparing the two seat paths will notice this one "forgets" the entitlement — and it would hand a connector vendor the badge through a one-way door.
> - **It is on `/admin/vendors/:id`, not `/admin/claims/:id` or `/admin/connectors/:id`.** Same reason the seat revoke is: that page is the only surface showing the blast radius — the other seats, the entitlement state, `is_pure_connector_vendor` — that makes the decision safe. It is also now the **second** write action in that section, so `STAGE_2_PAID_TIERS_SPEC.md` §5.6.3 ("Seats: revoke, but never ban") owns its contract alongside the revoke.
> - **Identity by EMAIL, through `resolveClaimantIdentity` unchanged.** It links an existing `auth.users` row or provisions one, mapped to the same statuses the grant uses (409 `GRANT_CONFLICT` on exclusivity, 503 `DEPENDENCY_FAILURE` when the seam is absent) so two admin paths cannot tell different stories about one account. **503 is the DEFAULT outcome on local dev and every PR preview**, and the control says so rather than reading as a failure.
> - **`seat_owner: true`**, matching `grantSeatStatements` (§11a): an AECi-reviewed seat IS the owner event, and it is what lets the vendor add its own colleagues through the shipped invite flow instead of one admin action per person. An existing NON-owner seat is therefore a real change and does write; only an exactly-identical seat is the 200 no-op.
> - **It warns and never gates.** On a vendor owning endpoint products the control shows a warning above an **enabled** button, and zero products reads as *unknown* rather than exempt — the AECI-738 rule verbatim (step 1 above). `is_pure_connector_vendor` is recorded in the audit row so the trail shows what the operator was looking at, since `product_role` can change upstream afterwards.
> - **A banned account is provisioned, not refused**, and `banned_at` is never written — `PATCH /api/admin/reviewers/:id` keeps its sole-writer status (`routes/banned-at-writers.spec.ts`). The ban is surfaced so the console can warn.
>
> `entitlement_mirror_drift` stays clean, as §8.9(4) predicted and the route spec now asserts: a seat with no entitlement touches neither side of the `verified` XOR `active` test.
>
> **What this does NOT change** is the rest of the procedure. Grant is still wrong (step 2), Reject is still wrong (step 3), and the claim is still not moved to `resolved` by provisioning — that status would read as approved in the Resolved tab with a paid account behind it, which is not what happened. Record the handover in the operator note (step 6). **AECI-724 is still open** and still owns the vendor-side surface plus §8.9(5)'s plan-panel consequence.

---

### 5.3 As built — seat provisioning (AECI-740 — 2026-09-03)

Shipped with **no migration**. `POST /api/admin/vendors/:id/seats`, contract in
`packages/shared/src/api/admin-vendors.ts` (`ProvisionVendorSeat{,Response}Schema`), handler
`createProvisionSeatHandler` in `apps/api/src/routes/admin-vendors.ts`, batch builder
`provisionSeatStatements` in `apps/api/src/lib/vendor-grant.ts`, surface
`apps/web/src/app/admin/vendors/provision-seat-control.{ts,html}` behind its own
`SeatProvisionApi` client. Full contract in `API_CONTRACTS.md` §6.10; IA in
`ADMIN_PANEL_SPEC.md` §5.7; the section that owns the screen is
`STAGE_2_PAID_TIERS_SPEC.md` §5.6.3. Decisions taken at build:

- **A new builder, not `grantSeatStatements`.** That one emits five statements, three of
  them about a CLAIM: it resolves a `vendor_requests` row and advances a `vendor_claim`
  workflow instance. A connector vendor's seat is handed over out of band and may have no
  claim row at all — and where one exists, §5.2 step 4 deliberately leaves it `open`.
  Reusing the grant would have needed a synthetic request id or would have stamped a claim
  `resolved`. Neither is true. `provisionSeatStatements` is two statements and is modelled on
  `revokeSeatStatements`, its exact inverse, in the same file.
- **The upsert's `set` list is copied from `grantSeatStatements` verbatim.** A provision
  landing after the holder's first sign-in must not reset `display_name`,
  `work_email_verified`, `trust_tier`, `theme_preference` — or the ban columns, which is the
  case that matters: `banned_at` has exactly one writer anywhere in the codebase and this
  must not become a second (`routes/banned-at-writers.spec.ts`). Asserted on the generated
  SQL of the `ON CONFLICT` clause rather than on the whole statement, because the INSERT
  column list legitimately names every defaulted column and is unreachable on that branch.
- **`vendor_seat.provisioned` had to be added to `VENDOR_METADATA_ACTIONS`.** The row files
  under `entity_type='profile'`, so `GET /api/admin/vendors/:id/audit` reaches it only
  through leg 3's `json_extract(metadata,'$.vendor_id')` test. A provisioned seat DOES carry
  `vendor_id`, so leg 4's roster subquery looks like it would work — but leg 4 filters on the
  ban actions only. Without the entry the row that says *"this vendor was given access"* is
  the one thing the vendor's own audit tab cannot show, while the revoke beside it renders
  fine. The web-side `describeAuditAction()` map is the matching lockstep edit.
- **The audit metadata says `entitlement_granted: false` out loud**, mirroring
  `seat_not_granted: true` on AECI-720's `managed_by` flip from the opposite direction. §8.9(2)
  is a fence somebody will eventually be tempted to step over; the trail should make it
  obvious that this action never opened a paid account.
- **The response's `entitlement_granted` is `z.literal(false)`.** The fence as a type: the
  edit this guards against compiles fine otherwise. The source-level companion is
  `routes/vendor-admin-role-writers.spec.ts`, which also pins `vendor_admin` to exactly two
  writers, both `lib/` batch builders — no route hand-rolls a seat write that could skip the
  audit row. Its scan **strips comments before matching**, because the modules it polices are
  precisely the ones whose docblocks explain the coupling; a raw substring scan would fail on
  the files that document the invariant best and train the next person to delete the
  explanation rather than keep the property.
- **The identity seam is injected, so the tests need no Supabase** — the house DI shape. Its
  ABSENCE is covered too: 503 is the default outcome on local dev and on every PR preview,
  and the control renders that as a configuration fact rather than a failure.
- **Ordering is a data-safety control.** The vendor 404 is checked **before**
  `resolveClaimantIdentity`, because resolving first would provision an `auth.users` row for
  a request that is about to 404, orphaning it. The route spec asserts the seam was not
  called, not merely that the status was 404.
- **`seat_owner` is part of the idempotency test.** `ClaimantProfileSnapshot` carries
  `{ id, role, vendorId, bannedAt }` and not `seat_owner`, so the handler reads it separately
  rather than widening a type `approveClaim`'s conflict path also consumes. The consequence
  is the right one: an existing non-owner seat (a colleague who redeemed an invite) is a real
  change and writes; only an exactly-identical seat is the no-op.
- **Design anchor.** Internal surface, so the binding anchor is the sibling directly beneath
  it — the seat revoke on this same page — and secondarily `ManagedByControl`, whose
  two-step-confirm shape, host-owned live region and `changed`/`announce` outputs this
  follows. The copy states what the seat is NOT (no entitlement, no badge, no attestation)
  for the same reason `ManagedByControl` states that a handover grants no seat: nothing else
  on the page corrects the assumption, and here it runs the other way. The announcement names
  what did not happen, so a screen-reader user does not have to go and read the Basics table
  to learn that provisioning did not verify the vendor.

---

## 6. Vendor portal UI (AECI-522)

The signed-in vendor's home, backed by `/api/vendor/*` (§4). **Multi-seat, flat (§8.1(2))** — several `vendor_admin` seats share one `vendor_id`; each was individually granted through §5. **Self-serve invite/revoke and an owner/admin distinction are deferred** (need a small schema add — §11).

- **Edit product/vendor content within guard-rails** — name, description, links, and taxonomy **within guard-rails** (the editable field allow-list + which taxonomy edits are vendor-permitted vs admin-only are pinned in `API_CONTRACTS.md` at build). Every save is a `vendor_id`-scoped write with its audit row (§4) and purges the affected `vendor:<slug>` / `product:<slug>` tag (§3, §8).
- **Claim / correction status** — surface the vendor's `vendor_requests` (claim + correction) states.
- **Account-status display** — show paid vendor access as a neutral public account label; the legacy `vendors.verified` mirror is AECi-controlled, not vendor-toggled.
- **Seat list** — read-only roster of the vendor's seats at launch.

Design work runs the `apps/web` UI checklist (`CLAUDE.md` §"Design checklist"): critique the surface, pick a Mobbin anchor, build via Impeccable, run axe locally. **Light theme only** — dark theme is not roadmapped (the Stage 2 reintroduction was dropped; see `STAGE_2_SPEC.md` §9).

### 6.1 As built (AECI-522 — 2026-07-25)

Shipped as the Angular `/vendor` surface (singular — the public `/vendors/:slug` detail is a different, cacheable route). Files under `apps/web/src/app/vendor/`. Decisions taken at build:

- **IA — tabbed.** Both a tabbed and a single-page concept were built as live-toggleable previews (`/preview/vendor-dashboard`, the AECI-270 precedent); the PO chose **tabbed** (`vendor-dashboard-tabbed.ts`: a side-nav — Overview / Profile / Products / Seats — over one content panel). It was originally an in-page `@switch` with **no child routes**, so the concept could render identically in the preview and on the real page; **§6.2 replaced that with real child routes** and the same relative-link trick keeps the preview working. **§6.4 replaced the side-nav with a horizontal tab row** and turned Products into a filterable dropdown; the nav lives in `vendor-portal-nav.ts` now, not in the shell. **§6.5 then moved Integrations down a level, under the selected product** (alongside a new Taxonomy tab), gave a product its own nav row (`vendor-product-nav.ts`), and put **Messages** in the slot Integrations vacated. **§6.10 turned the Overview into a landing page**: a compact access strip, a glance band, and a "What needs you" list that links to the work (AECI-983). **§6.11 made the header follow the context**: a breadcrumb replaces the "Vendor" eyebrow, an open product takes over the `h1` and the single tab row, the Products dropdown and the separate product nav are deleted, and bare `…/products` is a product list. **§6.12 split Taxonomy into one tab per facet** and moved "How teams use it" under Audiences and Phases (AECI-994). **AECI-999 turned the Integrations tab into a three-level drill-down** (counterpart, integration, data flow), collapsed on arrival, with a health pill, filters and shareable URL state; the build record is `STAGE_2_ATTESTATIONS_SPEC.md` §6.3. **§6.13 added a read-only Connectors section below that list** (AECI-1013): the connectors that deliver or reach the product, with no new tab. The single-page concept (`vendor-dashboard-single.ts`) stays in the tree behind the preview. The presentational pieces (`components/vendor-{verified-status,request-status,seat-roster,profile-form,product-form,products-section}.ts`) are shared by both. **AECI-606** (`STAGE_2_ATTESTATIONS_SPEC.md` §6) adds an Integrations tab and its components (`components/vendor-{integrations-section,integration-card,claim-lane,attestation-control,add-claim-form,notifications-list,attestation-labels}.ts`, joined by `vendor-{counterpart-group,health-pill,integration-health}.ts` in AECI-999, and by `vendor-contest-form.ts` in AECI-1008, the seat-only "Contest a field" action on every card the vendor does not own, §11b.10) to **both** concepts, so the single-page concept does not silently lose a section the tabbed one has.
- **Gate = the `/admin` pattern.** `vendorMeResolver` (`vendor-me.resolver.ts`) calls `GET /api/vendor/me`; a **403/404 → 404 render** (`<aec-not-found/>` + `RESPONSE_INIT.status = 404` + noindex), a 200 → the portal, a 5xx rethrows. `requireVendor()` rejects reviewers, banned seats, null-`vendor_id` seats, **and site admins** — all surface as the same 404. **401 was in that set and no longer is: since AECI-954 it redirects to `/auth/login?return=<url>` (§6.6).** Non-cacheable + `Cache-Tag`-free by the fail-closed classifier (no `server-runtime.ts` change; the worker login-bounce for anon `/vendor` already shipped with AECI-520). The page sets `robots: noindex`.
- **Edits.** `vendor-profile-form.ts` / `vendor-product-form.ts` are dirty-diff editors validated **live against the shared `UpdateVendorProfile*`/`UpdateVendorProduct*` schemas** (single source of truth; a single-key parse per field). Only changed fields are PATCHed (the endpoint requires ≥1; Save is disabled until a real change); the echo re-seeds the baseline so the form settles clean. **Optimistic + on-demand revalidation, no socket.** Save-confirmation copy never promises instant search — it says the listing updates now and search refreshes within a day (§8.3(5) / AECI-529). `name`/`slug` are read-only with a "rename = correction request" hint, and `public_private` uses the Angular Aria single-select listbox stand-in (ADR 0010). Product taxonomy is its own pattern — see the sub-bullet below.

  > **A save also transfers the maintenance marker (AECI-981, 2026-09-16).** Every vendor-authorized catalog write sets `maintained_by = 'vendor'` and stamps `last_reviewed_at` on the row it writes, so the public listing reads `Vendor-maintained · Updated <date>` instead of `Maintained by AEC Integrations`. That covers both forms here **and all three product-version writes**. It is derived server-side and is not a field on the PATCH schema or its echo. Until this landed, the portal and the public page disagreed about who maintained the record: nothing anywhere wrote `vendors.maintained_by` or `products.maintained_by`, because §13.4 of `STAGE_2_ATTESTATIONS_SPEC.md` had only ever flipped `integrations`. The contract is that doc's §13.9.

- **Product taxonomy: a summary on the page, a modal to change it** (AECI-915, superseding the `aria-pressed` toggle-chip fieldsets AECI-522 shipped). **Superseded by §6.12 (AECI-994):** each facet is now its own tab with the vocabulary inline and a page Save, and both modals were deleted. The rules below are kept as the record of why the modal existed; rules 2 (descriptions beside each term), 3 (a `<label>` around a real checkbox) and 4 (never scroll a `<fieldset>`) carry over unchanged. The four facets used to render every term as a chip — **107 of them** across categories (32), audiences (36), phases (5) and trades (34) — so reading "what is this product tagged as" meant diffing pressed against unpressed, and the per-term `taxonomy_*.description` had nowhere to render. Four rules:

  1. **The page is a summary, two columns from `md` up.** One card per facet: the facet name, a pencil, and one row per **assigned** term. The full vocabulary is not on the page at all.
  2. **Every explanation is an `<aec-info-hint>`** (`shared/info-hint/`), whose **accessible name is the text**, not a `title` attribute and not an `aria-describedby` on the panel — the same contract `shared/relative-time/` established, so a keyboard or screen-reader user gets the copy without the overlay ever mounting. Two levels of it: the AECI-913 **facet hint** beside the heading, and each assigned term's **AECI-911 `description`** beside its row. The picker (`vendor-taxonomy-facet-dialog.ts`) then writes the facet hint out in full at the top and gives every term its description as its own column, because that is the moment the guidance is actually wanted.
     Assigned-term rows keep `items-start` so long names can wrap; their hint alone carries `mt-0.5` to align its 16px trigger with the first 20px text line. The heading hint remains unoffset inside its `items-center` row, and the shared `InfoHint` geometry stays context-neutral.
  3. **A picker row is a `<label>` around a real `<input type="checkbox">`**, not `role="checkbox"` on a button. Clicking anywhere in the row toggles it, Space works, and the description sits inside the label so it is part of the control's accessible name rather than outside the click target.
  4. **The picker scrolls in a `<div>`, never in the `<fieldset>`.** A `<fieldset>` given `overflow-y: auto` reports a scroll range and still refuses to clip: Chrome applies `overflow` to the anonymous fieldset content box, so with the full 33-term category vocabulary the rows painted straight down the page, past the card's bottom edge and over the page behind it (AECI-925, verified in Chrome 152). The fieldset keeps the grouping semantics and nothing else; a plain `<div class="min-h-0 flex-1 overflow-y-auto">` wraps it and does the scrolling. The sibling dialogs (`vendor-seat-invite-dialog.ts`, `home-feedback-dialog.ts`) never hit this because they put `max-h`/`overflow` on the card itself — this is the only one with a sticky header and footer around a scrolling middle.
  5. **The modal's Save persists; it does not stage.** It runs the real `PATCH` for **one facet's** full replacement set, so the Taxonomy tab has **no Save button of its own**. Staging was rejected on a concrete ground: `apps/web` has no `CanDeactivate` guard and no `beforeunload` handler, so a Save that only wrote into the form model would let a vendor click Save, switch tabs, and lose the edit silently. A failed save keeps the modal open with the draft intact and puts the error inside it, next to the work that failed. The consequence upstream is that the form's facet state is a `computed` off the baseline rather than a writable signal — unsaved facet state is now unrepresentable, and the AECI-628 dirty-edit registration covers the text fields alone.

  Two strings, two readers, two files, and the distinction is load-bearing: the **facet hint** is a `$localize` string in `vendor-product-form.ts` read by a vendor tagging a product, while the per-term **`description`** is seeded in `apps/api/seed/taxonomy.sql` (AECI-911), is public reader copy on the browse pages, and doubles as those pages' meta description. Editing one never changes the other. The four facet calibrations genuinely differ and the copy says so: categories narrower beats broader, audiences mixes disciplines with job titles on one axis, phases more is usually accurate, trades most products have none.
- **Header entry point.** A role-gated "Vendor portal" link in the signed-in user menu (`layout/user-menu.ts` + `layout/nav-menu.ts`), driven by `VendorStatus` (`vendor/vendor-status.ts`): it reads the cheap `GET /api/account` `role` (never `/api/vendor/*`) and stays `false` during SSR, so the door never reaches cached header HTML.

  > **Updated — the two portal doors are now a matched pair.** The admin console's entry point moved out of the header's "More" overflow menu (which duplicated its whole eleven-screen IA) into this same menu as an **"Admin portal"** link, and the `More▾` menu was retired. Both doors are one link each, because each portal owns its own navigation once you are inside it. `DESIGN.md` §Navigation → The Overflow Rule carries the reasoning; `ADMIN_PANEL_SPEC.md` §5 carries the admin side.
  >
  > `VendorStatus` is no longer a *clone* of `AdminStatus` — both are now thin views over one shared probe, `RoleStatus` (`apps/web/src/app/auth/role-status.ts`), so a signed-in page load makes **one** `GET /api/account` rather than two and one `ensureProbed()` re-arms both doors. That also fixed a real defect this clone carried: it latched `probed` *before* awaiting and swallowed every error, so a single 401 or JWKS blip hid "Vendor portal" for the life of the page. The AECI-617 self-heal (latch on success, one bounded retry, retry on menu open) had only ever been applied to the admin copy; it now covers both.
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
`/vendor/acme/integrations`, `/vendor/acme/seats`.
**Superseded in part by §6.5 (2026-08-27):** `/vendor/acme/integrations` is gone —
Integrations is now `/vendor/acme/products/:productSlug/integrations`, joined by
`…/profile` and `…/taxonomy` under the same product, and `/vendor/acme/messages`
takes the vacated top-level slot. Naming the vendor is not
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
  does for a 403 — and does not put the payload in `TransferState`, so the
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
  **Superseded in part by §6.4:** the one-product-at-a-time rule and the
  unknown-slug callout stand, but the picker itself moved out of the section and
  into the nav, where it gained a search box.
- **Ownership is still enforced server-side.** Nothing here is the gate:
  `PATCH /api/vendor/products/:id` proves ownership against the session, and
  `requireVendor()` still scopes every read. The slug check and the unknown-product
  notice are clarity guards on top of that.
- **No worker change was needed.** `isVendorPath` already matched `/vendor/…`, so
  the anon login-bounce carries the deep path through in `?return=`, and the
  fail-closed cache classifier still gives every portal path `private, no-store`
  with no `Cache-Tag`.

> ⚠️ **Deployed-environment blocker — the zone WAF 403s any path containing
> `/vendor/`.** Verified 2026-08-26 by curl on `www`, `staging`, `demo` and the
> since-retired `stage2` tier: `/vendor` is fine, `/vendor/acme/overview` is a
> Cloudflare block page.
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

### 6.3 As built — the surface is named "Vendor portal" (2026-08-26)

**Every user-facing string that named this surface a "dashboard" now says
"portal".** The label was inherited from §6's working title and never matched the
thing that shipped: a dashboard implies a read-first overview of the vendor's
state, and this surface is a set of editors (Profile, Products, Integrations,
Seats) with one summary section among them. "Portal" is also what the rest of the
system already called it — this doc's own title, `VendorPortalStore`,
`portalUrl()` in `apps/api/src/lib/email.ts`, and the §6.2 routing work all say
portal — so this closes a drift, it does not open a new name.

What changed (copy only — no route, no payload, no behaviour):

- **Header entry point.** "Vendor dashboard" → **"Vendor portal"** in
  `layout/user-menu.ts` + `layout/nav-menu.ts`. The i18n id moved with it,
  `@@app.header.vendorDashboard` → `@@app.header.vendorPortal`, so id and source
  text cannot disagree (English-only at launch; `messages.xlf` is deliberately
  stale per `CLAUDE.md`).
- **Page title.** `@@vendor.metaTitle` → "Vendor portal · AEC Integrations".
- **The shell's nav landmark.** `aria-label` "Dashboard sections" → **"Portal
  sections"** (`vendor-dashboard-tabbed.ts`). `apps/web/e2e/vendor-dashboard.spec.ts`
  addresses the nav by that accessible name and moved with it.
- **In-surface copy.** The two read-only notices (`vendor-profile-form.ts`,
  `vendor-product-form.ts`) now point at **"Vendor Overview"** — the nav item that
  actually holds the verification panel — rather than at "your dashboard"; the
  attestations read-only notice and the lapsed-plan copy say "this portal" / "the
  portal".
- **Admin copy.** The claim queue's clear-entitlement warning says the vendor's
  team keeps "their logins and their portal, read-only".
- **Transactional email.** `claim-approved`, the attestation nudges' shared
  closing lines, and `entitlement-expiring` all say "your vendor portal".

**Not renamed: internal identifiers.** `vendor-dashboard-tabbed.ts`,
`vendor-dashboard-single.ts`, `VendorDashboardTabbed` / `VendorDashboardSingle`,
the `aec-vendor-dashboard-*` selectors, the `/preview/vendor-dashboard` concept
route and `apps/web/e2e/vendor-dashboard.spec.ts` keep their names, and the
in-file comments still say "dashboard" in places. That is a mechanical rename with
no user-visible effect, deliberately kept out of a copy change so the diff stays
reviewable; do it as its own pass. **The rule going forward: user-facing copy says
"portal", never "dashboard".**

### 6.4 As built — the nav goes horizontal, and Products gains a filterable menu (2026-08-26)

> **Superseded in part by §6.11 (2026-09-17):** the Products dropdown
> (`vendor-products-menu.ts`) is deleted. Products is a plain link to a product list
> page. The horizontal row itself, its overflow pairing and its no-sticky and
> no-duplicate rules are unchanged.

The §6.1 nav was a 14rem side rail in a `md:grid-cols-[14rem_1fr]` grid. Five short
links do not earn a seventh of a wide page, and the content they front (a profile
form, a product form, an integration list) is what wants the width. This change
makes the nav a horizontal tab row under the company name, and moves the product
choice into it as a dropdown with a search box.

**The row** (`vendor/vendor-portal-nav.ts`, extracted from the shell). One `<ul>`
at every width, `overflow-x-auto overflow-y-hidden whitespace-nowrap` so narrow
viewports scroll it sideways rather than wrapping it (a wrapped tab row breaks
its own underline across two lines) without exposing a stray vertical scrollbar.
Deliberately **not sticky**: `shared/section-nav/section-nav.ts`
is sticky because it is an in-page jump nav on a long editorial scroll, where the
target moves under the reader; a router nav has no such coupling and the sections
are short. Deliberately **no `md:hidden` mobile duplicate**, which would put every
item in the DOM — and in a screen reader's link list — twice. The header loses its
own `border-b`, so the row carries the single rule and reads as attached to the
panel it switches.

- **The active treatment is `-mb-px` + `border-b-2` on the item itself**, pulling
  its border over the row's hairline: the `/search` entity-tab treatment and
  DESIGN.md's "2px `accent-primary` bottom border on the element".
  **The underline COLOUR is a class in `styles.css` (`.aec-nav-tab[aria-current]`),
  not a Tailwind utility** — `styles.css` sets `border-color` on `*` **outside any
  cascade layer**, and an unlayered rule beats every layered rule regardless of
  specificity, so `border-transparent` and `border-(--accent-primary)` silently
  never reach the tab and the underline comes out `--border-default` grey in both
  states. This is not local: it defeats **every** border-color utility in
  `apps/web` (~165 usages, the `/search` tabs included). Fixing it properly means
  moving that `*` rule into `@layer base` — the same fix the file already applied
  to anchor colours, with the reasoning written two lines below it — which is an
  app-wide visual change and wants its own issue.
- **Products is a `<button>`, not a link.** It opens the menu; there is no direct
  link to `…/products` in the nav. Two costs, both accepted: `routerLinkActive`
  cannot drive its state (a button has no `routerLink`), so the item computes
  active from the router and carries **`aria-current="true"`** — the correct value
  for a current item that is not a page link — and the Products section has no
  JS-off entry point. The portal already requires JS (the store, the live sync and
  every editor), is `noindex` and non-cacheable, so the second costs nothing real.
  `aria-current` is still never hand-maintained per navigation: the four links get
  it from `routerLinkActive`, and the button derives it from `router.isActive`
  with `paths: 'subset'`, which is what keeps it current on
  `…/products/:productSlug` too.
- **A vendor with one product (or none) gets a plain link instead.** A dropdown
  over a single option is noise, and the link keeps the section reachable in the
  degenerate case. Same rule the in-page picker carried, relocated.

**The menu** (`vendor/vendor-products-menu.ts`): a disclosure button over a
`cdkConnectedOverlay` panel whose first control is a search box, filtering this
vendor's catalog by name, alphabetical, with the current product check-marked.
Choosing one navigates to `…/products/:productSlug`.

- **It is a combobox, not a `role="menu"`.** A `menu` may not own a `textbox` (an
  `aria-required-children` violation), and the menu pattern claims printable
  characters for first-letter typeahead, so it would eat every keystroke aimed at
  the search box. `user-menu.ts` and `nav-menu.ts` reached the same conclusion for
  their own panels.
- **`alwaysExpanded` on the `ngCombobox` is what makes it compose.** It makes
  Aria's own `expanded` model, its Escape handler and its close-on-blur effect
  inert, leaving exactly one open state — ours. Without it two open states fight
  and the listbox collapses inside the panel.
- **The panel must be an overlay.** The row is `overflow-x-auto`, i.e. a clip
  container, so an `absolute top-full` panel would be clipped by the row it hangs
  from. `usePopover: 'inline'` puts it in the browser's top layer.
- **Escape and Tab are handled on the INPUT, not on the overlay.** Aria's
  `KeyboardEventManager` defaults to `stopPropagation: true` and binds Escape, so
  the event never reaches CDK's document-level keydown dispatcher and
  `(overlayKeydown)` silently never fires for it. A listener on the same element
  still runs (`stopPropagation` is not `stopImmediatePropagation`). CDK's own
  Escape is disabled (`disableClose`) because it detaches the overlay behind the
  back of the `open` signal, leaving the trigger claiming to be expanded.
- **Focus moves into the search box on open**, which is a context change the
  vendor asked for by activating the trigger — not a WCAG 3.2.1 problem — and
  without it a keyboard user never learns a text field appeared. Escape and Tab
  both return focus to the trigger. **No focus trap**: this is a disclosure, not a
  modal.
- **The listbox renders only when something matches.** Aria expands on every
  keystroke, so gating the expansion cannot keep an empty `role="listbox"` out of
  the DOM; gating the widget does. Zero matches renders a plain sentence, never an
  unselectable "No matches" option.
- **The option list is frozen while the panel is open.** `VendorLiveSync` refetches
  `me` every 20 s and products is one of its scopes; a poll that adds or drops
  a row under a pointer already travelling toward one is exactly what
  `STAGE_2_REALTIME_SPEC.md` §6.3 forbids. The list re-syncs on close.
- **The menu declares no live region.** A "20 products match" `role="status"` here
  would be the forbidden second region.
- **Navigation is relative to the PORTAL route, with no `.parent`.**
  `sections/vendor-products-page.ts` uses `relativeTo: route.parent` because it is
  the child; this menu is rendered by the shell, whose `ActivatedRoute` already is
  the layout route. `.parent` here would produce `/vendor/products/<slug>`, making
  `:vendorSlug` the literal "products". Relative either way is what keeps
  `/preview/vendor-dashboard` from navigating into the live portal.

**The in-page `<aec-select>` picker is gone** (§6.2's "one product at a time, with
a picker" — the *picker* moved, the one-at-a-time rule did not). A vendor had to be
ON the products page to change which product they were editing, and a non-editable
listbox gives a hundred-product catalog nothing but first-letter typeahead.
`sections/vendor-products-page.ts` keeps everything that decides which product a
URL resolves to: the bare path still shows the primary product, an unowned slug is
still called out rather than substituted, and ownership is still enforced
server-side. The unknown-product notice now points at the Products menu.

**Tests.** `vendor-dashboard-tabbed.component.spec.ts` keeps every AECI-606/614/631
property; its nav helper matches `a, button` and its href assertion covers the four
links, and it gains the Products `aria-current` case. Two new specs:
`vendor-portal-nav.component.spec.ts` (the row's own rules, no store, no DI) and
`vendor-products-menu.component.spec.ts`, which **does** assert the open state —
unlike `aec-select.component.spec.ts`, because opening here is a plain button click
writing a plain signal, and CDK downgrades `usePopover` to the body-level overlay
container under jsdom. `apps/web/e2e/preview-vendor-portal-nav.spec.ts` is new and
**ungated**: it runs on `/preview/vendor-dashboard` (no session, and no `/vendor/`
segment for the WAF to block), and covers Aria's real ArrowDown → Enter commit, a
real outside click, and an axe pass with the panel **open** — the only automated
check that would catch an empty `role="listbox"`. The preview's fixture switcher
gains a 20-product entry, because a search box over two options tells you nothing.

---

### 6.5 As built — Integrations moves under the product, Messages takes its slot (2026-08-27)

> **Superseded in part by §6.11 (2026-09-17):** the product row no longer stacks
> under the vendor row. It REPLACES it, the shell's header switches to the product,
> `vendor-product-nav.ts` and the AECI-959 `shared/segmented-route-nav/` are
> deleted, and bare `…/products` is a product list rather than a redirect into the
> primary product. The route shape and the per-product Integrations filing stand.

§6.4 made Products a menu that routes to `…/products/:productSlug`. This change makes
a product a **place** rather than a parameter, and moves the Integrations tab into it.

**The portal row is now:** Vendor Overview · Profile · Products · **Messages** · Seats. (Products is a disclosure, but it renders no arrow icon — see `DESIGN.md` §Navigation.)
**A product gains its own row:** Profile · Taxonomy · Integrations. (§6.12 replaced Taxonomy with Categories · Trades · Audiences · Phases.)

Both route lists come from `vendor/vendor-nav.ts` (`VENDOR_NAV_ITEMS` and the new
`VENDOR_PRODUCT_NAV_ITEMS`). The product row is rendered by
`vendor/vendor-product-nav.ts` and is a **second nav landmark**, named for its product
("Summit Field Issues sections") — two landmarks both called "Portal sections" would
make the landmark list useless. Its `aria-label` is built with `$localize` at the call
site, not as an `i18n-aria-label` attribute, because an *interpolated* `i18n-*`
attribute emits no attribute at all in this toolchain.

#### AECI-959 — the product row becomes a segmented route control (2026-09-16)

> **Retired by §6.11 (2026-09-17).** The product row replaces the vendor row rather
> than sitting under it, so both use the underlined tab. `shared/segmented-route-nav/`
> and `vendor-product-nav.ts` are deleted. Kept below as the record.

The two levels originally shared `VENDOR_NAV_ITEM_CLASS`. In use, identical full-width
hairlines, active underlines, type and spacing made the rows look like duplicate peer
navigation. The information architecture and both item arrays remain unchanged, but
their presentation now states the hierarchy:

- **Vendor-level navigation stays primary.** `vendor-portal-nav.ts` keeps the
  underlined horizontal route row from §6.4 and adds `overflow-y-hidden` alongside
  its horizontal overflow, preserving the AECI-958 scrollbar safeguard.
- **Product-level navigation is segmented.** `shared/segmented-route-nav/` owns the
  compact `surface-sunken`, `border-default`, `radius-md` track and `radius-sm`
  segments. Resting links use secondary text; the current link uses Forest
  (`accent-primary`) with `surface-base` text. The track sizes to its contents up to
  the available width, then scrolls horizontally without wrapping and clips vertical
  overflow. `vendor-product-nav.ts` is a thin product-specific wrapper with the same
  `mt-4 mb-8` spacing as before.
- **The control is navigation.** It renders ordinary relative `routerLink` anchors in
  a named `<nav>` and lets `routerLinkActive` set `aria-current="page"`. It does not
  claim tab, pressed-button or application-widget semantics, and every link keeps a
  visible focus outline.
- **No container was added around product content.** Profile, Taxonomy (now the four facet tabs, §6.12) and Integrations
  already render card surfaces, so wrapping them in another card would create the
  nested-card treatment prohibited by `DESIGN.md`.

Option B was selected for AECI-959. No new Mobbin anchor is required: the route control
adapts the repository's existing segmented-control vocabulary and the rest of the
vendor portal keeps its recorded anchor.

#### Why Integrations moved

An integration is a thing that happens *to a product*, and a vendor with a dozen
products was reading one flat list to answer a per-product question.

The blocker was that `GET /api/vendor/integrations` framed each integration against
**one** endpoint — `context_product` pinned to endpoint A *including when the caller
owns both* ("arbitrary, but it has to be something"). Under a product tab that is not
arbitrary at all: an owns-both integration filed under its endpoint-B product would
render every direction backwards.

**Resolution — the list unfolds.** The handler now emits **one entry per owned
endpoint** rather than one per integration, each framed against the endpoint it is
filed under. Consequences, all deliberate:

- **`id` is no longer unique in the response.** The key is `(id, context_product.id)`.
  `vendor-integrations-section.ts` tracks by exactly that; anything tracking or
  splicing by `id` alone collapses or cross-wires the pair.
- **An owns-both integration is listed under BOTH products**, directions mirrored.
- **It is still ONE position.** `slots`, `mine`, `counterparty` and `agreement` are
  identical on both entries, because a write fills every slot the caller owns (§2.1,
  and filling one only was rejected: it cannot retract the sibling row and leaves
  `DELETE` unable to clear) and §4 dedupes voters by vendor. Rendering it twice is a
  view of one fact, not two.
- **The write paths take an optional `context_product_id`.** On `POST /api/vendor/claims`
  it is load-bearing: "outbound" means opposite things from the two sides, so the old
  endpoint-A guess stored the *reverse* flow for a vendor authoring from its other
  product's tab. On `PUT …/attestation` it only frames the echo. A product the caller
  does not own on that integration is a `400` naming the field, never a silent
  re-frame. Omitted keeps the endpoint-A default, which is unambiguous for the common
  single-endpoint case. **The portal always sends it:** both write components source it
  from the listing they render (`vendor-integration-card.ts` passes
  `integration.context_product.id` into `vendor-add-claim-form.ts` and, via
  `vendor-claim-lane.ts`, into `vendor-attestation-control.ts`), so the server frames the
  write against the endpoint the vendor is authoring from rather than the fallback — the
  fallback is API robustness for a caller that omits it, not the portal's path.
- **The client mirrors on splice.** Because the write carries `context_product_id`, its
  echo comes back framed against the tab it was authored from; splicing it verbatim into
  the same integration's *other* entry
  would render that flow backwards. `mirrorContextDirection` (`packages/shared/src/
  integration-context.ts`, beside its two siblings — direction framing has one home)
  re-frames it.

**The READ stays vendor-wide.** One `GET /api/vendor/integrations`, one `integrations`
cursor scope, one `VendorPortalStore` resource; only the *view* narrows, via the
section's new `contextProductId` input. Fetching per product would break
`STAGE_2_REALTIME_SPEC.md` §2.2's invariant ("every cursor query reuses the scoping
predicate of the handler it is a cursor for") and turn one call into one per product,
for a payload already bounded by the vendor's own catalog.

#### Messages (the vendor-level slot)

Nothing new is collected. It **consolidates two surfaces that already shipped in
unrelated places**: claim/correction status (`vendor-request-status.ts`, previously on
Vendor Overview) and the notification archive (`vendor-notifications-list.ts`,
previously *inside* the Integrations tab, which is where you would look for it last).

**This does not reverse §6.2 of `STAGE_2_REALTIME_SPEC.md`.** That rule — "new
notifications are a count, never a banner" — is about not promoting *historical* rows
to *live assertions*, because a three-week-old "Vendors disagree" row sitting above a
lane now reading `confirmed` makes the surface contradict itself. All of that holds:
no banner, no unread badge, no auto-expand, no "mark as read", and the "N new" count
stays session-scoped inside the disclosure's summary line
(`vendor-notification-baseline.ts` is unchanged). Giving the archive a findable home
is not the same as asserting it is current state.

Requests are shown above the archive because they are different in kind: `vendor_requests`
rows **are** current state, ride `GET /api/vendor/me`, and carry a status the vendor acts on.

**Field contests (AECI-1008, 2026-09-18) sit between requests and the archive**, for the
same reason requests sit above it: each contest carries a status the vendor acts on
(accept, decline, withdraw), so the block renders open, not inside a disclosure. It is
two lists, Received and Submitted, off `GET /api/vendor/contests` (§11b.10). Contest
events also land in the archive below as history. That is not a duplicate: the archive
says what happened when, and the contests block says where each one stands now.

#### Taxonomy is a projection, not a second form

> **Superseded by §6.12 (AECI-994).** The `section` input and the projection are gone. The Profile tab renders `vendor-product-form.ts` alone, and each facet tab renders `vendor-product-facet-editor.ts`, which owns its own baseline and dirty-diff. The two never race: each sends only the fields it renders.

`vendor-product-form.ts` gains a `section: 'all' | 'profile' | 'taxonomy'` input and is
rendered twice rather than split. `PATCH /api/vendor/products/:id` requires ≥1 changed
field and re-asserts `product.taxonomy.edit` when facet arrays ride along, so two form
components would mean two dirty-diff implementations racing on one endpoint — two
chances to send an empty PATCH and two places for the field-level gate to drift. A
field with no control on screen is never edited, so it never enters `patch()`; that is
what makes each tab's PATCH carry only its own section. `'all'` remains the default and
is what `vendor-dashboard-single.ts` keeps using.

The Taxonomy tab is **not** route-gated on `product.taxonomy.edit`: a vendor without it
sees its own facets read-only with the copy explaining what verification unlocks, per
the ownership-reads / capability-writes split. Routing it away would hide owned data.

#### Consequences elsewhere

- **`…/products` (bare) redirects** to the default product's Profile. It cannot be an
  Angular `redirectTo` — the target depends on the vendor's catalog, known only after
  `GET /api/vendor/me` resolves — and it cannot be a guard either, because a child
  `canActivate` runs *before* the parent route's resolver. So it is an `effect` in
  `vendor-products-page.ts` with `replaceUrl`.
- **`/vendor/:vendorSlug/integrations` no longer exists.** The portal is private,
  noindex and non-cacheable, used by a handful of accounts, so a stale bookmark landing
  on a 404 was accepted rather than adding a resolve-and-redirect hop.
- **`vendor-dashboard-single.ts`** (the single-page concept, which has no product
  selection) renders `aec-vendor-notifications-list` explicitly and leaves
  `contextProductId` unset, keeping the vendor-wide list. Without that it would have
  silently lost a surface the tabbed concept has — the thing AECI-606 added it to both
  concepts to prevent.
- **`vendor-product-context.ts`** is the one implementation of "which product is this
  page about", shared by the shell and all three sections so they cannot disagree. It
  combines every level's `paramMap` **observable** (not snapshots): picking a product is
  a same-route navigation, so a snapshot read would pin each section to whichever
  product was selected when it first rendered.

### 6.6 As built — an expired session goes to login, not to a 404 (AECI-954 — 2026-09-14)

Found in the demo portal on 2026-09-14: a seat whose access token had aged out
reloaded the dashboard and got **"Page not found"**, with nothing to click. The gate
was collapsing three different answers onto one render.

**The cause.** The worker-level anon gate (`server-runtime.ts` `isVendorPath`) only
bounces visitors with **no session cookie** — `hasSessionCookie` is a presence check
by design, no crypto and no network. A cookie holding an expired access token sails
past it, SSR runs, `GET /api/vendor/me` answers 401, and `isVendorGateRejection()`
mapped 401 onto the same not-found render as 403.

**The split.** 401 and 403 answer different questions, so they now get different
answers.

| Status | The question it answers | Response |
|---|---|---|
| 200 | You are this vendor | The dashboard |
| **401** | **Nobody is signed in** | **`/auth/login?return=<url>`** |
| 403 / 404 | You are signed in, but you are not this vendor | The 404 render, unchanged |
| 5xx | The API is down | Rethrow, unchanged |

Routing 401 to login **discloses nothing new**: the worker gate already sends a
cookie-less visitor to exactly that address. §7.1's don't-reveal-the-surface rule is
about 403 — "you are not this vendor" — and that branch is untouched. `requireVendor()`
still rejects reviewers, banned seats, null-`vendor_id` seats and site admins onto the
identical 404.

**Three call sites, one rule.** `isVendorGateRejection()` (403/404) and the new
`isUnauthenticated()` (401) live in `vendor-gate.ts`, and `vendorMeResolver`,
`vendorHomeRedirectGuard` and — for the operator console — `adminSummaryResolver` all
read them. The login `UrlTree` is built by `auth/login-redirect.ts`, which runs the
return path through the same `safeReturnPath()` open-redirect guard the login page
uses.

#### The refresh, and why the two platforms differ

A Supabase access token lives about an hour; the refresh token beside it in the same
cookie lives weeks. So the ordinary "my login timed out" state is **recoverable**.

- **SSR gate (2026-09-22).** Before the render, the SSR Worker trades an expired access
  token for a fresh one on `/admin*`, `/vendor*` and `/account`
  (`apps/web/src/server/auth/session-refresh.ts`, called from the `server-runtime.ts`
  gate). `@supabase/ssr`'s server client refreshes against GoTrue only when the token is
  expired or inside the SDK's expiry margin, so a fresh token costs no network. The new
  cookie is forwarded to the resolver's API call **and** returned as `Set-Cookie`, and
  the response is forced to `private, no-store`. So the common case now renders on the
  first request, with no login-page hop. This does not reopen `ADMIN_PANEL_SPEC.md`
  §13 D22: both of D22's blockers were about the cacheable branch, and every path here is
  non-cacheable and always hands the rotated refresh token back. The refresh is bounded
  at 3 s (`REFRESH_DEADLINE_MS`), because the SDK otherwise retries a GoTrue 5xx or
  network failure for up to 30 s. Everything below is now the fallback for a refresh
  that fails or times out, such as a GoTrue outage.
- **Server branch.** Redirect straight to login. `@angular/ssr` emits a real 302
  whenever the router's final URL differs from the requested one — the same mechanism
  §6.2's bare-`/vendor` redirect already relies on.
- **Client branch.** Probe first: `hasLiveSession()` (`auth/session-recovery.ts`)
  refreshes the cookie and reports whether a session survived. One retry if it did,
  redirect only if it did not.
- **Login page.** Arriving with `?return=` **and** a session cookie, it paints a brief
  "Restoring your session" panel instead of the sign-in form, probes once, and navigates
  straight back. So the SSR bounce costs a flash, not a magic-link round trip. With no
  `?return=` it always shows the form — a deliberate visit is never hijacked.

> ⚠️ **Do not set `RESPONSE_INIT.status` on the redirect branch.** `@angular/ssr` feeds
> that value into `createRedirectResponse()`, which throws in dev mode on any status
> outside 301/302/303/307/308. The 404 write belongs to the reject branch only.

> ⚠️ **The client probe is the loop breaker, not an optimization.** A verified JWT whose
> `profiles` row is missing also 401s (`createAuthzMiddleware` treats an unauthorizable
> identity as unauthenticated, deliberately — the AECI-652 `profile-ensure` seam is
> non-fatal, so that state is reachable). Redirect on every 401 and that account rides
> login → session found → return → 401 → login forever. Redirecting **only when the
> probe reports signed out** bounds it: a signed-in caller retries once and then falls
> through to the 404 render, which is terminal. Deleting the probe reintroduces an
> infinite redirect.

**Tests.** `vendor-me.resolver.component.spec.ts` and
`admin-summary.resolver.component.spec.ts` each gain a 401-branch block covering the
server redirect and all three client outcomes.
`vendor-home-redirect.guard.component.spec.ts` is **new** — the guard had no spec at
all — and pins its 200 / 403 / 401 / 5xx answers on both platforms.
`login.component.spec.ts` gains the four silent-resume cases.

### 6.7 As built — the portal links out to the public listings (AECI-960 — 2026-09-15)

Found by the operator on 2026-09-15: a vendor edits a product profile, saves, and
has no way to see the result. `grep -rn '_blank' apps/web/src/app/vendor` returned
nothing. The portal read and wrote the catalog and pointed at none of what the
catalog renders, so seeing a save meant guessing the public URL or leaving the
portal and searching for your own product. Stage 2.1 seats the first real vendors,
so that friction was about to land on them.

**Three link sites**, each a `<aec-view-public-link>`
(`apps/web/src/app/shared/view-public-link/`):

| Site | Component | Target |
| -- | -- | -- |
| Vendor company name (`<h1>`) | `vendor-dashboard-tabbed.ts` | `/vendors/:vendorSlug` |
| Selected product name (`<h2>`) | `sections/vendor-products-page.ts` | `/products/:productSlug` |
| Each integration card (`<h3>`) | `components/vendor-integration-card.ts` | `/products/:contextSlug/integrations/:otherSlug` |

**The card links to the PAIR page, not to the counterpart product**, which is where
the issue as filed pointed it. What a vendor authors on that card is claims and
attestations, and those render on the pair page; the counterpart's own product page
shows none of it. Linking there would answer "let me see my change" with a page the
change is not on. Both slugs are already on the wire — `context_product` and
`other_product` are `ProductLink`s — so this costs nothing. For an integration whose
endpoints the vendor owns **both**, §6.5 emits one card per endpoint and each links
to its own framing; the pair route's two segments are positional, so a swapped pair
addresses the mirror page and still returns 200, which is why
`vendor-integrations-section.component.spec.ts` pins the order rather than the shape.

**No published/unpublished guard, and this is settled rather than deferred.** The
issue asked whether a counterpart might be unpublished. It cannot be: `ProductLink`
carries no publication status, the public product and pair handlers do not filter on
`promotion_status` at all, and D1's catalog is written only by promote — so any
product the portal can see has a live public page. A pair page with no edge on record
renders `noindex` rather than 404ing (`products-pair.resolver.ts`), so the third link
cannot land on a missing page either. Adding a guard would have meant widening `productLinkColumns`
(shared by many surfaces) to carry a field for a state that does not occur.

> **AMENDED 2026-09-16 (AECI-980).** Two details below are superseded and are kept
> because the reasoning around them still governs. First, the sr-only note is no longer
> **beside** the anchor — it moved **inside**, carried by the shared `aec-new-tab-icon`
> component, because a sibling span is not read in a rotor or an `NVDA+F7` links list
> and so reached browse mode and nowhere else. Second, "exactly one of the two carries
> the disclosure, never both" is no longer enforced by an `@if`, and does not need to
> be: an `aria-label` **replaces** the anchor's contents for assistive tech, so the note
> cannot be announced twice. The obligation that survives is the one that always
> mattered — a caller passing `ariaLabel` must state the new tab in that name itself.
> The same change added the drawn `arrow-up-right` cue these links never had.
> `DESIGN.md` → "The Link Treatment Rule" is now canonical for all of it.

**The accessible name splits, deliberately.** The two once-per-page links carry the
plain "View public page" with the sr-only "(opens in a new tab)" beside the anchor,
copying the two shipped admin sites (`admin/vendors/vendor-detail.html`,
`admin/vendors/vendor-products-table.html`) so the portal and the console read alike.
The integration card cannot: it renders once per integration, so a uniform name would
put N links reading "View public page" and pointing N different places into one rotor
or `NVDA+F7` links list. That is `ACCESSIBILITY_AUDIT.md` finding **A4** (WCAG 2.4.4
Link Purpose), currently open against the home page's three identical "Source" links,
reproduced inside the portal. So the card passes an `ariaLabel` naming its pair, with
the visible text leading so WCAG 2.5.3 Label in Name holds and speech input can target
it — the shape `DESIGN.md` §"Disclosure group card" already pins. It is built with
`$localize` **in TS**, never as an interpolated `i18n-aria-label`, which emits no
attribute at all in this toolchain and would leave the link unnamed rather than merely
uniform. **Exactly one of the two carries the new-tab disclosure, never both.** The
sr-only span renders only on the unnamed link. A supplied `ariaLabel` has to state the
new tab itself, because a rotor or links list never reads the sibling span, so keeping
the span as well would announce the disclosure twice in browse mode.

**The link is always a SIBLING of its title, never nested in it**, and the reason
differs at each site: the `<h1>` is the page heading a screen reader reads to say what
this page is (and a spec asserts it equals the company name exactly); the `<h2>`
carries an interpolation-only `i18n` block that nesting would pull markup into; the
`<h3>` is the `aria-labelledby` target of the integration card's `<article>`, so
anything inside it is re-read as part of the region name on every entry.

**Plain `href` and a new tab, not a `routerLink`.** The portal holds unsaved form
state and `apps/web` has no `CanDeactivate` guard and no `beforeunload` handler (the
same fact that made §6.1's taxonomy modal persist rather than stage), so a same-tab
navigation can silently discard an edit. `rel="noopener"` because the new browsing
context otherwise gets a handle on this one.

**Tests.** `vendor-dashboard-tabbed.component.spec.ts` gains a §6.7 block covering the
two once-per-page links, including that the product link follows the picker and that
it is absent for an unknown or empty catalog while the vendor link survives.
`vendor-integrations-section.component.spec.ts` gains the card block, including the
positional-order assertion and an explicit "no two cards share an accessible name"
A4 guard. `view-public-link.component.spec.ts` is new, and pins the one-disclosure-not-two rule. Every property asserted fails
silently if it regresses — a dropped `target` still renders a working link — and axe
sees none of them.

---

### 6.8 As built — the tab rows pair `overflow-y-hidden` with `overflow-x-auto` (AECI-958 — 2026-09-16)

> **Note (§6.11):** `vendor-product-nav.ts` and the segmented control named below are
> deleted. The pairing now lives in one place, `vendor-portal-nav.ts`, which draws
> both rows.

Both nav rows — the vendor row (`vendor/vendor-portal-nav.ts`) and the product row
(`vendor/vendor-product-nav.ts`) — painted a short vertical scrollbar at their right
edge. Two CSS facts combined: per CSS Overflow, `overflow-x: auto` makes the other
axis's `visible` **compute** to `auto`, so the row was also a vertical scroll
container; and `VENDOR_NAV_ITEM_CLASS`'s `-mb-px` (§6.4's active treatment) pushes
each item 1px past the row's content box. 1px of vertical overflow inside an
`overflow-y: auto` box is a scrollbar — permanently, on macOS with "Show scroll
bars: Always". The same fact is documented in `admin/admin-shell.ts` as the reason
the admin row deliberately does not scroll.

**The fix is `overflow-y-hidden` beside `overflow-x-auto` on the row `<ul>`** —
the legal pairing that keeps the sideways scroll §6.4 requires — on both portal rows
and on the third copy of the pattern, the admin vendor-detail tab row
(`admin/vendors/vendor-detail.html`). §6.4's "overflow-x-auto whitespace-nowrap" is
now that plus `overflow-y-hidden`. **`-mb-px` is untouched**: it is what pulls the
tab's underline over the row's hairline, and removing it would trade a scrollbar for
a broken tab treatment.

**Tests.** Both nav component specs (`vendor-portal-nav.component.spec.ts`,
`vendor-product-nav.component.spec.ts`) now assert the row carries `overflow-y-hidden`,
so the pairing is not separable by a later edit — including the AECI-959 nav restyle,
which touches the same two components and must carry this pairing through it.

---

### 6.9 As built — the correction sentences get a way to file one (AECI-967 — 2026-09-16)

Found by the operator on 2026-09-15, one day after §6.7 and from the same family:
the portal **named an action twice and routed to it neither time**. The product
profile said "To change the product name, file a correction request" and the
conflict lane said "If you think theirs is wrong, send us a correction request",
both as flat prose. `/products/:slug/correction` has existed and been public since
AECI-128. A vendor reading either sentence had to leave the portal, find their own
public listing, and locate the correction link there.

Renaming a product is a normal request we have deliberately made non-self-serve
(§6.1: `name`/`slug` are AECi-owned because a rename breaks the URL, the Algolia
record and every inbound link). Telling someone to do a thing while hiding the way
to do it turns a small policy friction into a dead end, and the correction is what
we lose.

**Three link sites, not the two the issue named.**

| Site | File | Target | Prefill |
| -- | -- | -- | -- |
| Product rename hint | `components/vendor-product-form.ts` | `/products/:productSlug/correction` | none |
| Company identity hint (**new copy**) | `components/vendor-profile-form.ts` | `/vendors/:vendorSlug/correction` | none |
| Conflict disclosure | `components/vendor-claim-lane.ts` | `/products/:contextProductSlug/correction` | yes |

The third site is new ground. `vendor-profile-form.ts` renders no company-name
field at all, for the same reason the product form renders its name read-only, and
until now it said nothing whatever about that. The absence read as an omission
rather than a policy. The new `@@vendor.profile.identityHint` states the fact and
carries the route.

**The mechanism is the in-place drawer, NOT a new tab, and that is a correction to
the issue as filed.** The anchors carry `aecRequestTrigger` (AECI-128,
`requests/request-trigger.ts`) and `<aec-request-drawer/>` is mounted once in the
shell. An unmodified left click is `preventDefault()`ed and opens the overlay, so
**nothing navigates**: the unsaved form state and its `VendorPortalStore.markDirty`
registration cannot be lost, and the vendor keeps the thing they are correcting on
screen behind the panel. That is strictly better than the new tab `DESIGN.md` →
"The Link Treatment Rule" case 2 prescribes, and the rule now says so.

**The `href` fallback still gets the full new-tab treatment** — `target="_blank"`,
`rel="noopener"` (alone, no `noreferrer nofollow`; the destination is our own
catalog) and `<aec-new-tab-icon/>`. That path is the no-JS and pre-hydration one
and it really does navigate, which is exactly the case the rule covers. A
modified click (cmd/middle) is left to the browser by the directive, so it lands
there too.

**The drawer is mounted in BOTH shells** — `vendor-dashboard-tabbed.ts` and
`vendor-dashboard-single.ts`. Both concepts compose `vendor-product-form` and
`vendor-claim-lane`, and a trigger with no drawer mounted `preventDefault()`s into
nothing. §6.1's rule that the single-page concept never silently loses what the
tabbed one has is what makes the second mount non-optional, and the failure it
prevents is a dead click rather than a missing section.

**Only the conflict link prefills, and the asymmetry is the point.** A correction
request already carries `(target_type, slug)`, so an admin always knows which
product. Restating the product identity in the body would be padding. What a
correction cannot carry is **which disputed data flow, against which counterpart** —
`vendor-claim-lane.ts`'s `correctionPrefill()` names both and leaves the vendor a
line to complete. It is a seed, not a value: the vendor may edit or clear it, and it
is validated like anything else they typed.

Plumbing it cost one optional field on three shared types — `bodyPrefill` on
`RequestDrawerTarget`, on `RequestTrigger`, and on `RequestFormBody`, where it
seeds the model **inside `ngOnInit` before `form()` runs** (the Signal Forms schema
callback runs once at creation, §6.1's `vendor-product-form` note applies).

**The routed fallback page is deliberately NOT prefilled.** A seed could only reach
it as a query param, and free text in the URL joins the SSR cache key
(`cacheKeyFor`, WC-4) and the request logs. The fallback is the no-JS path; an
empty body there is what shipped before this and stays correct.

**`vendor-claim-lane.ts` gained a `contextProductSlug` input.** It held
`contextProductId` (a UUID) and two display names, and a correction addresses its
target by `(entity, slug)` — never a UUID. The slug was already on the wire one
level up (`vendor-integration-card.ts` builds its §6.7 pair href from the same
field), so the card passes it down and nothing new is fetched.

**What was deliberately left out.** The issue floated a **product-header actions
menu** as the eventual home for these plus §6.7's link. Not built: the house rule
routes an application menu (commands acting on the page) to `@angular/aria/menu`,
which nothing in the repo uses yet, so it is a real adoption rather than a line of
markup — and two links do not yet justify one. The header row keeps `<h2>` +
`ViewPublicLink`. The **denied** state's copy stays with AECI-961.

**Tests, and the one gap.** `vendor-product-form`, `vendor-profile-form` and
`vendor-claim-lane` specs each pin the href, the `target`, the `rel` and the
sr-only disclosure; the lane's block also pins that the link targets the **context**
product rather than the counterpart (both slugs resolve and both pages return 200,
so nothing downstream would catch a swap) and that it renders in no other agreement
state. `vendor-integrations-section.component.spec.ts` pins the card→lane slug
wiring, which is the only place that wiring is real. `request-trigger` and
`request-form` specs pin the `bodyPrefill` hop and the seeding.

The gap is the **open drawer itself**: `BrnDialog.open()` inside an `effect()`
throws NG0602 under TestBed, so `RequestDrawer` cannot be rendered open in a
component spec anywhere in the app (it works in a real browser, which is how
product detail has shipped it since AECI-128). Coverage therefore stops at the
trigger's inputs and the anchor's attributes, and the overlay is verified by hand.
Every attribute asserted here fails **silently** if it regresses — a dropped
`target` still renders a working link — and axe sees none of them.

---

### 6.10 As built — the overview becomes a landing page (AECI-983 — 2026-09-17)

The overview (`/vendor/:vendorSlug/overview`) was the plan panel plus three bare
counts (Products, Seats, Open requests) that linked nowhere. It reported inventory
and never said what needed attention. It is now a landing page: a one-line access
strip, a three-tile glance band, and a prioritised **"What needs you"** list whose
rows link straight to the work. The direction was chosen from the mock-up at
`docs/design/vendor-overview-concepts.html` (concept A, with the views band and a
1d / 1w / 1m toggle). The baseline critique of the old page scored it 23/40.

**Admission (`STAGE_2_1_SPEC.md` §1).** This is refinement of an already-built
portal surface, not a new one. The Views tile is the one element that could read as
a surface addition. It ships as a placeholder with no server read, and its real
figure stays Stage 2.5 work (`STAGE_2_5_SPEC.md` §10, AECI-941).

**No new endpoint and no migration.** Everything reads `VendorPortalStore`. The
rules live in `overview/vendor-overview-model.ts` as pure functions, pinned by a
plain Vitest spec. The section only turns them into copy.

**The list.**

| Band | Item | Condition | Link |
| -- | -- | -- | -- |
| Needs you now | One row per product with conflicts | ≥ 1 claim with `agreement = 'conflict'` | `products/:slug/integrations` |
| Needs you now | One row per open correction | `kind = 'correction'`, status `open` or `in_review` | `messages` |
| Needs you now | One row for field contests to decide (AECI-1008) | ≥ 1 `received` contest with status `open`. Seat-only, never capability-gated (§11b.2), so it shows while the other rows are paused | `messages` |
| Worth doing | Top 3 products by waiting count, then "And N more" | `vendor.verified` (the Integrations tab's gate, see `vendor-integrations-page.ts`), claim on an `attestable` edge with `mine = []` | `products/:slug/integrations` |
| Worth doing | Top 3 incomplete products, then "And N more" | `product.edit` | `products/:slug/categories` if categories are missing, else `products/:slug/profile` (was `…/taxonomy` before §6.12) |
| Worth doing | Company profile gaps | `profile.edit` | `profile` |
| Worth doing | Unaccepted seat invites | `can_manage_seats` | `seats` |

Links are relative `routerLink` arrays (`['..', …]`), so the same template works at
`/vendor/:slug` and `/preview/vendor-dashboard`. With **no editing capability at
all**, a paused notice sits above the bands and every edit-gated row drops out.
Needs you now still lists conflicts and corrections, because reading is always
allowed. Worth doing keeps **seat invites**, because seat management is never
capability-gated (`STAGE_2_PAID_TIERS_SPEC.md` §4.3) and a lapsed owner can still
re-send or revoke them. With nothing outstanding, an all-clear card replaces both
bands, but **only once the `integrations` read has succeeded**. While it loads or
after it fails, the lede says so instead ("Checking your data flows." or "this list
may be incomplete"), because the all-clear asserts every data flow has the vendor's
position and a list we do not hold cannot back that.

**The gap fields are a product decision, pinned here.**

- **Product:** `description`, `website`, `logo_url`, `category_slugs`.
- **Company profile:** `description`, `website`, `logo_url`, `headquarters`.
- **Never `trade_slugs`.** Trades are sparse by design (`TRADES_VOCABULARY.md`
  §1.1). An empty list is usually correct, and flagging it would nag a vendor about
  data that is not wrong.
- **Never audiences or phases.** They are optional refinements, not gaps.

**Counting dedupes by claim id (AECI-993).** `VendorIntegration.id` is not unique
in `GET /api/vendor/integrations`: an integration whose endpoints the vendor owns
both is listed once per frame. A vendor-wide total is the size of a set of claim
ids, never a `flatMap(...).length` and never a sum of per-product rows. The model
spec pins this with the owns-both mirror. The Integrations tab's summary line
("N data flows on record · M waiting") reads the same model (`claimsOnRecord`,
`waitingByProduct`). It is vendor-wide on the single-page concept, where it used
to count an owns-both integration's claims twice.

**Claims stay in Messages.** A claim is someone asking for the account, not a
comment on the listing, so it is never a row here.

**The glance band** (`components/vendor-glance-band.ts`, presentational):

- **Views** (`components/vendor-views-tile.ts`) is a **placeholder**. It has a
  working `aria-pressed` toggle (1d / 1w / 1m, default 1w) and a sentence that
  follows it. It shows no number and makes no server read. AECI-941 binds the
  figure and listens to its `periodChange` output. The windows are complete UTC
  days (`VENDOR_PERFORMANCE_SPEC.md` §5.2).
- **In conflict** is the deduped conflict total. Its line reads "On {product}" or
  "Across N products", and it links to the first conflicted product's
  integrations, or to Products at zero. Since AECI-999 that link carries
  `?status=conflict`, so the tab opens filtered to conflicts. The "What needs you"
  conflict and waiting rows do the same with `conflict` and `needs_you`
  (`STAGE_2_ATTESTATIONS_SPEC.md` §6.3).
- **Suggestions about your listing** counts open corrections, shows "Newest filed
  {date}" (UTC), and links to Messages. The body and submitter are off the wire,
  so the copy never implies a reply is possible.

A zero is never a bare `0`. It renders a sentence. The conflict tile shows a loading
sentence (with `aria-busy`, no `role="status"`) and, on failure, a Try again that
reloads `integrations` and announces the outcome through `VendorPortalAnnouncer`.

**The compact plan panel.** `vendor-plan-panel.ts` gained `compact = input(false)`.
Compact applies to the `active` state **only**: `expiring`, `pending`, `lapsed` and
`none` each carry a conversation and render in full regardless. The compact strip is
the badge, the term line, and a `<details>` "What an active account covers" holding
the same framing sentence (one `ng-template`, never forked). The overview's
"Account access" `h2` becomes `sr-only` exactly when the panel collapses, so the
heading outline is unchanged.

**Live revalidation.**

| Surface | Source | Live? |
| -- | -- | -- |
| Plan strip, corrections, gaps | `me` (`profile`, `entitlement`, `products`, `requests` scopes) | Yes |
| Conflicts and waiting | `integrations` scope | Yes, including integration-row edits once AECI-992 lands |
| Seat invites | `seats`, which has no cursor | Loads on entry only, the same accepted posture as the Seats tab |
| Contests to decide | `contests` scope (AECI-1008) | Yes |
| Views | none | Placeholder |

**The single-page concept (`vendor-dashboard-single.ts`) is unchanged, on purpose.** It
renders every section on one page, so a list of links to other routes has nowhere
to point. §6.1's parity rule is about sections, and it loses none.

The section ensures `integrations` and `seats` from `afterNextRender`, so SSR paints
the plan strip and the corrections without waiting on either. It adds no live region
and never calls `markDirty`.

**Tests.** `vendor-overview-model.spec.ts` (dedupe, connector-powered edges never
waiting, empty trades never a gap, claims excluded, ordering, the top-3 cap,
capability gating), `vendor-glance-band.component.spec.ts`,
`vendor-views-tile.component.spec.ts`, the compact cases in
`vendor-plan-panel.component.spec.ts`, and an overview block in
`vendor-dashboard-tabbed.component.spec.ts` (compact vs full, row hrefs under
`/vendor/:slug`, the live entitlement flip, the all-clear state and its suppression while the
integrations read loads or fails, one live region,
the announced retry).

### 6.11 As built — one header that follows the context (2026-09-17)

A product page stacked two headers and two nav rows: the vendor's `h1`, public link
and underlined tab row, then the product's own `h2`, public link and the AECI-959
segmented row. The two rows were different sizes and styles, and the segmented one
read as a button group. It was unclear which header was in charge of the page.

**The rule now: the header describes one thing, and there is one tab row.** The shell
(`vendor-dashboard-tabbed.ts`) reads the router and switches.

| | Vendor context | Product context (`…/products/:productSlug/*`) |
| -- | -- | -- |
| Breadcrumb | Vendor › *Company* | Vendor › *Company* › Products › *Product* |
| `h1` | company name | product name |
| Public link | `/vendors/:slug` | `/products/:slug` |
| Back link | none | "← Back to *Company*" |
| Tab row | Vendor Overview · Profile · Products · Messages · Seats | Profile · Taxonomy · Integrations |
| Landmark name | "Portal sections" | "*Product* sections" |

- **The breadcrumb** is a `<nav aria-label="Breadcrumb">` over an `<ol>`, the same
  markup as the public product page. Its last item is plain text with
  `aria-current="page"`. "Vendor" and the company both link to `overview`. With one
  vendor per seat they land in the same place; the pair is what the operator asked for.
- **Only an owned product switches context.** A URL naming a product the vendor does
  not own stays in vendor context and the page says so, with a link to the product
  list. A header naming that product would contradict the notice.
- **One component draws both rows.** `vendor-portal-nav.ts` takes `items` and
  `ariaLabel` inputs. The shell prefixes the product items with
  `products/:productSlug/`, because it renders from the portal's route rather than
  from the product route. Both rows use the `.aec-nav-tab` underline.
- **The context comes from the router, not from the product page.** The shell sits
  above the outlet, so a child cannot hand it a value without a new injectable, and
  every new injectable is one more thing the preview's DI shadow must provide. The
  shell walks its route's `firstChild` chain for `:productSlug` on every
  `NavigationEnd`, so product-to-product navigation, which reuses the shell, still
  updates it.
- **`VendorProductsPage` is now an outlet plus the unknown-product notice.** Its `h2`,
  public link and product nav are gone.
- **Bare `…/products` is a product list** (`sections/vendor-product-list-page.ts`).
  It used to redirect into the primary product, so a "Products" breadcrumb would have
  bounced the vendor straight back into a product. The page is deliberately basic for
  now: logo, name, a "Primary" tag, primary first and then by name through
  `compareText`. A richer list is follow-up work. The overview's "And N more" rows
  (§6.10) already link to `products` and now land on it.

**Deleted:** `vendor-products-menu.ts`, `vendor-product-nav.ts`,
`shared/segmented-route-nav/` (its only user), their specs, and the
`.aec-segmented-route-item` rules in `styles.css`.

**No quick product switcher** beside the product title, by decision. Switching goes
through the breadcrumb or the Products tab.

**Tests.** `vendor-dashboard-tabbed.component.spec.ts` gains a "context-aware header"
block: crumbs and `h1` per context, the crumb and back-link hrefs, the swap back to
vendor context, product-to-product reuse, and the unowned-product case.
`vendor-portal-nav.component.spec.ts` pins the input-driven row for both contexts.
`e2e/preview-vendor-portal-nav.spec.ts` drops the dropdown suite and drives
Products → list → product → crumb back, with an axe pass in each context.
`e2e/vendor-dashboard.spec.ts` reaches Integrations through the list.

### 6.12 As built — one tab per taxonomy facet, with "How teams use it" under Audiences and Phases (AECI-994 — 2026-09-17)

Tagging a product with an audience happened in one modal on the Taxonomy tab. Writing how that
audience uses the product happened in a second modal on the Profile tab. It was the same decision
split across two tabs, and the points editor was a textarea where each line silently became a
bullet.

**The product row is now:** Profile · Categories · Trades · Audiences · Phases · Integrations.

- **Routes.** `…/products/:productSlug/{categories,trades,audiences,phases}`, all four served by
  `sections/vendor-product-facet-page.ts` with the facet in route `data`. `…/taxonomy` redirects
  to `…/categories`. The overview's "What needs you" row for missing categories links to
  `…/categories`.
- **One component per facet tab:** `components/vendor-product-facet-editor.ts`. It renders the
  full vocabulary inline as a checklist with each term's description beside it. There is no
  modal. The row is still a `<label>` around a real checkbox, and the list still never scrolls
  inside a `<fieldset>` (§6.1 rules 3 and 4).
- **Nothing persists until Save.** One `PATCH /api/vendor/products/:id` carries the facet's slug
  array when it changed and the complete `usefulness` value when the points changed. The handler
  writes both in one `db.batch`, so a tag and its points cannot land half-way. This reverses
  §6.1 rule 5 (the modal's Save persisted). That rule existed because a modal "Save" that only
  staged would read as saved; a page Save button that PATCHes has no such ambiguity. An unsaved
  draft is protected by `markDirty` exactly like the Profile form, with the owner
  `productId:facet`, and the registration is withdrawn when the tab is destroyed. Leaving the tab
  with unsaved changes loses them, which is also true of the Profile form (no `CanDeactivate`).
- **Categories and Trades** are the checklist and nothing else. The 10-term cap disables further
  ticks once reached, and the counter shows it.
- **Audiences and Phases** open a bullet list under each ticked term
  (`components/vendor-bullet-list-editor.ts`): one input per point, a plus button that adds a
  point at the bottom, and per-row move up, move down and remove buttons. Reordering is buttons,
  not drag, so it works with a keyboard and satisfies WCAG 2.5.7 without a second model. Focus
  moves deliberately after each action, and moves and removals are announced through the portal
  announcer. Enter never submits the form; on the last point it adds another. The caps (8 points,
  200 characters) mirror `VendorUsefulnessSchema`. Blank points are dropped and a term with none
  sends no group.
- **Points require the tag, in the portal.** A points list is only offered under a ticked term.
  Unticking a term that has points opens a `BrnDialog` listing the exact points that will be
  deleted, with "Keep them" and "Remove". A term with no written points unticks without asking.
  The server does **not** enforce this yet: promote never had the rule, so an existing product can
  carry points for an untagged term. Those render unticked, with their points and a note saying
  they are published but untagged, and a "Remove these points" action. Showing them is not an
  edit. Server-side enforcement waits on a read-only production check of how many such groups
  exist.
- **Gates stay field-granular.** Ticks need `product.edit` + `product.taxonomy.edit`; points need
  `product.edit` + `product.usefulness.edit`. A lapsed vendor sees everything read-only with Save
  withheld. No tab is route-gated.
- **Group order is preserved.** Stored groups keep their order and new groups append, and stored
  points are compared after trimming, so a promoted value is never dirty on seed. Reordering points
  is an edit.
- **The save echo is spliced into the store's `me`** by both the facet editor and the Profile form,
  so a sibling tab mounts on the saved value instead of waiting for the next poll.
- **The Profile form is text fields only.** `vendor-product-form.ts` lost its `section` input, the
  taxonomy summary cards and the usefulness cards. `vendor-products-section.ts` takes
  `section: 'all' | 'profile' | ProductFacetKind`; `'all'` (the single-page concept) renders the
  form and all four editors.
- **Deleted:** `vendor-taxonomy-facet-dialog.ts`, `vendor-usefulness-dialog.ts`,
  `sections/vendor-product-taxonomy-page.ts`, and their specs.

**Tests.** `vendor-product-facet-editor.component.spec.ts` (inline vocabulary, write-on-Save only,
the combined PATCH without group names, the other facet carried through, reorder as an edit, the
removal confirmation and its cancel, untagged points shown, the length cap, both capability axes,
the store splice), `vendor-bullet-list-editor.component.spec.ts` (add at bottom, cap, remove, move,
focus after each, announcements, Enter never submits, read-only), `vendor-portal-nav.component.spec.ts`
and `vendor-dashboard-tabbed.component.spec.ts` (six product tabs), and `vendor-overview-model.spec.ts` (the categories link).

### 6.13 As built — a read-only Connectors section on the Integrations tab (AECI-1013 — 2026-09-18)

Vendors cannot edit, create or retire connector-powered integrations. They still need to see which
connectors reach their product. This section shows that, and nothing on it is editable.

**A section, not a seventh tab.** The product row stays at six tabs (§6.12). Most products have no
connector reach, so a Connectors tab would be empty on most of them. The section sits at the bottom
of `…/products/:productSlug/integrations`, below the vendor's own integrations list, and renders
nothing when no connector reaches the product. That matches the public page's reach line, which is
hidden at zero (`STAGE_1_5_SPEC.md` §13.7).

- **Component:** `components/vendor-product-connectors.ts`, rendered by
  `sections/vendor-integrations-page.ts` with the product-context id.
- **Read:** `GET /api/vendor/products/:id/connectors` (`API_CONTRACTS.md` §6.14). It requires
  ownership only. It has no entitlement gate and no rate limit.
- **One card per connector.** A card has up to two blocks, each with its own label:
  - **Delivered.** The partner products the connector ships a listing for. These are
    `connector_evidenced_pairs` rows.
  - **Reachable.** Partner products that sit in the connector's catalogue alongside this one. The
    block is a closed `<details>`, because Kroo's catalogue reaches hundreds of products. Its
    summary always carries an "as of" date: the catalogue's latest `last_ingested_at`, or "catalogue
    date not recorded". The body says plainly that nobody has confirmed a working integration.
    Reach never counts toward any integration count.
- **No links.** Most reachable pairs are `derived` and have no vendor page to cite (§13.7). The
  section therefore links nowhere, not even to the connector's own pages.
- **Outside the live cursor.** The section fetches in the browser when the tab mounts, and again on
  every product switch. It clears the previous list before each fetch. Nothing polls it
  (`STAGE_2_REALTIME_SPEC.md` §2.3). A failed read shows a retry and does not touch the list above.
- **Not listed here:** a Convention-A self-reference, and an `iPaaS` edge with no named connector.
  Both are `integrations` rows, and the list above already shows them as read-only cards.

**Tests.** `vendor-connectors.spec.ts` covers the handler: the 404, both tiers, the canonical-B
orientation, and the delivered subtraction across both tables. `vendor.authz-matrix.spec.ts` adds
the route to every guard cell, a cross-vendor 404 and an unverified-owner read.
`connector-reach.spec.ts` covers `reachablePartnersByConnector`.
`vendor-product-connectors.component.spec.ts` covers hidden at zero, the tier labels and "as of",
no links, product switch and retry.

### 6.14 As built — ownership on the integration card: Claim, Edit, "Offered by" (AECI-1006 — 2026-09-22)

AECI-1005 shipped the claim with no UI. The card now says who offers each integration and gives the owner the one action its state allows. Component: `components/vendor-integration-ownership.ts`, mounted by `vendor-integration-card.ts` in its own block above the contest form. Copy helpers: `components/vendor-integration-ownership-labels.ts`. Design anchor: the sibling contest form on the same card (§11b.10), whose disclosure trigger, control set and button classes this reuses, so it stays on the vendor portal's existing anchor and adds no new Mobbin reference.

- **One line and at most one action, by state.**
  - Owner, unclaimed: "recorded as the owner", a hint that claiming takes the row over from AEC Integrations and makes edits live, and **Claim this integration**. There is no edit form yet, because an edit before the claim would be overwritten by promote.
  - Owner, claimed: "owns this integration", and **Edit details**, a disclosure over the edit form.
  - Owner of a connector-delivered row (`attestable: false`): a sentence that it cannot be claimed or edited yet (decision 9). No button. `attestable` is read off the wire, never re-derived.
  - Anyone else: **"Offered by {owner}"**, matching the pair page byline (AECI-1021), and who reviews a contest: the owner once it has claimed, AEC Integrations before. With no owner on file, it points at the Owner contest (the owner-unknown claim, §4.5.4).
- **Seat-only.** Never gated on `canWrite` or the entitlement, like the contest form (§11b.10).
- **The form.** Three `<fieldset>`s with legends: About the integration (name, description, type, mechanism name, direction), Links (website, listing, documentation, mechanism), Pricing and maturity. Field names are `contestFieldLabel`, shared with the contest form. Each control starts at the value on record from `contestable_fields`. The type picker offers `OWNER_EDITABLE_MECHANISM_KINDS` only. Direction is a native select of the pair page's caller-relative sentences. Name, type and direction are required; the rest say "(optional)". The intro says plainly that changes go live with no review and that the other product's vendor is told.
- **Pessimistic.** The form waits for the `200`, announces through `VendorPortalAnnouncer`, closes, returns focus to the trigger and revalidates `integrations`. A claim does the same and then moves focus to the Edit trigger that replaced the button. Only changed fields are sent. An unchanged save and a bad value are caught client-side with the shared rule. Each refusal code maps to its own sentence in a `role="alert"`.
- **One wire field.** `GET /api/vendor/integrations` gains `claimed_at` (`.nullable().default(null)`), the same definition AECI-1010 reads. The notification archive renders the new `integration_update` row as "The owner edited an integration on your product", naming the owner, the integration and the changed fields.
- **Final wording (AECI-1023, 2026-09-22).** The claim hint now says what a claim does in three sentences: AECi's catalogue updates stop reaching the row, edits go live with no review, and the other product's vendor is told. The "Offered by" line for a claimed row adds that a contest about who owns it goes to AEC Integrations, because §11b.4 routes the `owner` field there even on a claimed row. The same copy is on `/methodology` "Who owns an integration" and in the unrendered docs draft `content/docs/vendors/owning-an-integration.md`. The notification archive's ownership rows gained a one-sentence note (§11b.10).
- **Preview.** `/preview/vendor-dashboard` claims and edits against the fixture (`preview-vendor-api.ts`). The Autodesk Build card under Summit Field Issues is the owned, unclaimed row.

**Create (AECI-1011).** The "Add an integration" form sits above the cards and reuses this form's groups, labels and value rule. See §4.7.5.

**Tests.** `vendor-integration-edits.spec.ts` (every gate branch, the batch, the race guard, the enum refusals, the connector-kind lockstep), `vendor.authz-matrix.spec.ts` (every guard cell, the endpoint 403 and the neither-endpoint 404), `batch-sentinels.spec.ts`, and `vendor-integration-ownership.component.spec.ts` (every state, the claim, the form, each refusal, focus).

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

## 8. Vendor account-status activation — public surface (AECI-523 / AECI-965) & search (AECI-529)

`vendors.verified` already exists and is indexed (§1.2); Stage 2 lights it up. The field name is legacy vocabulary. Under the paid-tier model it mirrors an active entitlement, so the public treatment describes account access rather than verification. The free/default state remains the absence of an account label.

### 8.1 SSR trust surface (AECI-523)

Render the account-status label on the SSR detail surfaces: vendor detail and product pages where the built-by vendor is shown. Immediate freshness is unchanged: a §3 grant enqueues a `vendor:<slug>` Cache-Tag purge (§3), so the label appears on the next request after approval. The label reports account access only. It never certifies product quality, integration accuracy, endorsement, ranking, or placement. Read this section with `DESIGN.md` §Badges, especially the rule forbidding verification iconography on public surfaces.

**As revised (AECI-965).** The shared presentational component is `aec-vendor-account-badge` (`apps/web/src/app/shared/vendor-account-badge/vendor-account-badge.ts`). Both variants are neutral, text-only `rounded.sm` labels. The full label reads "Vendor account active" and the compact label reads "Account active". The compact form remains visible text in dense contexts; no meaning is carried only through an icon or accessible name. It renders only when `verified === true`. The public inactive baseline is the label's absence. It is distinct from the `AgreementBadge` "Unverified · AECi" claim state and from review or rating anatomy. It renders on the vendor detail hero, product detail vendor card, product-pair rail, vendor search cards, and the vendor portal plan panel. The tooltip explains the exact account-access meaning and rejects product, integration, ranking, and placement claims.

Data plumbing: `VendorDetail.verified` already existed, so the vendor page needed none; the product surfaces embed the lean `VendorLink`, so `verified: z.boolean()` was added to `VendorLinkSchema` (`packages/shared/src/api/common.ts`) and hydrated in the single `toVendorLink` constructor (`apps/api/src/lib/drizzle-helpers.ts`, via `vendorLinkColumns`) — covering product detail, integration detail, product-pairs, and `ProductListItem.vendor`. No cache work: the §3 `vendor:<slug>` purge already invalidates the vendor page and every embedding product/pair page.

### 8.1a Claim-CTA copy on an already-claimed listing

The account label landing on the detail pages exposed a copy contradiction: the Actions-sidebar claim CTA (AECI-128) was **unconditional**, so an active vendor account rendered the account label and "Claim this listing" on the same page.

**The CTA is not removed, only reworded.** Hiding it would close the only route in for cases the rest of this epic assumes exist:

1. Seats are **multi-seat and admin-granted**, and self-serve invite/revoke is deferred (§11), so the public claim form is the only way a *second* person at a vendor asks for one. §5's `AdminVendorSeat` signal exists precisely so a reviewer can tell a second-seat request from a first claim.
2. A wrongly-granted listing needs a public correction path for its rightful owner.
3. `vendors.verified` is a **mirror of `vendor_entitlements`** since AECI-609, not an ownership bit, so hard-gating on it would tie the CTA to billing state: a cleared or expired entitlement would make it reappear on a vendor that still has live seats. There is no claim/ownership field on the public payload; `verified` is the closest available proxy and is used for **copy only**.

**As built.** `verified === true` swaps the CTA label to "Request access to this listing" (`@@vendors.detail.metadata.requestAccess` / `@@products.detail.metadata.requestAccess`) and appends a one-line note under the action pair (`@@…metadata.claimedNote`: "Already managed through an active vendor account. Request access if you work there too."). The vendor page reads `v.verified`; the product page reads `p.vendor?.verified` (a nullable vendor falls back to the neutral claim copy). A copy-only `claimed` input on `RequestTrigger` rides into `RequestDrawerTarget`, so the drawer opens with matching eyebrow/title/subtitle (`@@requests.access.*`). **No contract change** — both states POST the same `kind:'claim'` request to the same route, and `verified` was already on `VendorDetail` and `VendorLink` from §8.1. Covered by `vendor-detail.component.spec.ts` (new), `product-detail.component.spec.ts`, and `request-trigger.component.spec.ts`.

**Deliberately unchanged:** the routed fallback form at `/{products,vendors}/:slug/claim` keeps the neutral "Claim this listing" wording — `RequestForm` resolves no entity data (route `data` + `slug` only), so it cannot read `verified` without new plumbing, and the no-JS/deep-link path is honest either way. Server-side nothing gates either: `detectDuplicate` (`apps/api/src/routes/requests.ts`) only matches requests still `status='open'`, so a claim against an already-granted vendor is not even flagged as a duplicate. Surfacing "vendor account already active" as an **admin intake signal** is the open follow-up.

---

### 8.2 Search surfaces (AECI-529)

Thread the existing `vendors.verified` column into the Algolia vendor record. Four **lockstep** edits (miss one and the field silently drops):

1. `algoliaVendorConfig.columns` — add `verified` to the queried columns (`apps/api/src/lib/algolia-transforms.ts` ~:83-105).
2. `RawAlgoliaVendorRow` — add the field (~:149-161).
3. `toAlgoliaVendor` — map it into the record (~:198-210).
4. `AlgoliaVendorRecordSchema` — add `verified: z.boolean()` (`packages/shared/src/algolia-records.ts` ~:59-69).

**Freshness contract (§8.3(5)).** Vendor edits and badge flips reach **Algolia on the nightly watermark sync** (`runDailySync`, `apps/api/src/lib/algolia-sync.ts`) — **≤24h**, since an edit bumps `updated_at` which the next window picks up (an immediate by-id `indexEntity` hook like `syncPromoteTargets` is optional if faster search is later wanted). **SSR is immediate** via the §3 Cache-Tag purge. **Accepted for launch — UI copy must not promise instant search.** `verified` becomes a facet/filter, never a ranking signal (no pay-for-placement).

### As built (AECI-529 — 2026-07-25)

- **Vendor record only, account label on the `/search` Vendors tab.** The legacy `verified` bit is denormalized onto the Algolia **vendor** record, and the reused `aec-vendor-account-badge` (§8.1) renders under the company name on `SearchVendorCard` (`apps/web/src/app/search/search-vendor-card.ts`). The **product** search card is deliberately left untouched. It is also the only freshness-clean choice: the §3 grant bumps `vendors.updated_at`, so the vendor index catches the flip on the next nightly window, but never touches `products.updated_at`. A product-card label would therefore go stale until every product was separately reindexed. This resolves the Linear AC's "product (and vendor, if applicable)" to **vendor**.
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
- **Approved copy** names the vendor, lists the account's new capabilities (edit profile, submit data corrections, add integration attestations), links to `/vendor` when `PUBLIC_SITE_URL` is set, and tailors sign-in guidance: `invited` explains the just-provisioned account + one-time sign-in link (no GoTrue invite email is sent, §2); `linked` points at the existing account. Vendor access is framed as an **account status**, never product or integration verification, ranking, or placement, and with no instant-search promise.
- **Rejected copy** is **neutral by design** (this §9 AC): it names the vendor, states the claim wasn't approved, and invites a fresh claim. The reviewer's decision `reason` is an **internal audit note** — recorded in `audit_log` (admin-visible) and **never emailed** — so nothing a reviewer types can leak to the claimant. `ModerateClaimSchema` keeps its single `reason` field, but it no longer reaches the email path (the `SendClaimDecisionEmail` seam carries no `reason`), and the `/admin/claims` reject form labels it "Internal reason … not shared with the claimant." *(Review-pass hardening, 2026-08-14: the initial AECI-528 build echoed `reason` to the claimant — a reviewer-note leak vector — which contradicted this AC; it was neutralized. Splitting `reason` into distinct claimant-facing vs internal fields remains a possible future enhancement.)*

### As built — the copy moves onto the house email layout (2026-09-14)

The §9 build note above says the copy is assembled "via `toText()`/`toHtml()`". That is no
longer true of **either** decision email. Both now render through
**`apps/api/src/lib/email-layout.ts`** (`renderEmailHtml` / `renderEmailText`) — the
shared shell ported from the sign-in email, `docs/email-templates/magic-link.html`.
`claim-approved` was the first template on it (AECI-914); `claim-rejected` followed the
same day (AECI-924), because the decision pair has to move together. A claimant who
receives a branded approval and an unbranded rejection is being told no in worse
packaging than they would have been told yes, and this is the one §9 surface where that
asymmetry is visible to a single person.

What changed, and what did not:

- **Structure.** A Forest logo band and text wordmark, a heading, three short blocks, one
  Forest CTA ("Go to your vendor portal") with its paste-able URL, a hairline, and the
  verification sentence as small print. It used to be four equal grey paragraphs.
- **The portal link became the CTA.** It was an inline link inside the sign-in sentence.
  It is the one action the email exists to prompt, so it is now the button, and the
  sign-in line no longer repeats the URL. The `PUBLIC_SITE_URL` behaviour is unchanged:
  unset means no button, where it previously meant no link.
- **The sign-off is gone.** The house layout has no "The AEC Integrations team" line; its
  footer wordmark names the sender. That also removes an em dash PRODUCT.md bans.
- **Every AC in this section still holds.** The vendor is named, the capabilities are
  listed, the `invited` / `linked` branch is intact, and the verification framing is
  word-for-word what it was: an account status, never ranking or placement.

`claim-rejected` moved with two differences from its sibling:

- **It ships no CTA, deliberately.** The Forest button is the layout's one action and a
  rejection has none this AC permits. The copy says resubmission is welcome; a "Submit a
  new claim" button would press harder than that. A layout with no `cta` renders no
  button and no paste-able URL, so the email is a heading and two blocks with nothing to
  click. It is the repo's reference for a CTA-less migration.
- **The reviewer's `reason` is still absent, and the migration is the moment to say so
  out loud.** The house layout offers a `note` slot and an optional `table`, either of
  which would have been a natural-looking home for a decision note. Neither is used. The
  §9 guarantee stays structural: `SendClaimDecisionEmail` carries no `reason`, so there
  is nothing for a future edit to render by accident. A spec asserts the rendered body
  carries no table row at all.

§11a's `vendor-seat-invite` moved in the same change, and of everything migrated it is
the one the shell mattered most for. Its copy is three defences against reading as
phishing (name the inviter, name the address the link is bound to, say the link expires)
and the legacy shell undercut all three: bare grey paragraphs, no logo, the sender named
nowhere but the `From:`, and the redeem link as a naked inline anchor. The house shell
names AECi in the body twice, as logo alt text and as the wordmark row, so it survives
the images-off corporate mail security this audience sits behind. The redeem link is now
the single Forest CTA with its URL spelled out underneath, which matters more here than
on any other template because the recipient is being asked to trust a link from a
directory they may not know.

`docs/email.md` (§House layout) carries the standard, the twin-file rule, and the
migration table: 6 templates on the layout, 13 still on the legacy formatters.

---

## 10. Document `vendor_admin` authz (AECI-525)

Complete `AUTH_AND_RLS.md` for `vendor_admin`. The **kickoff** already seeds the de-staling — §9 rewritten to the 3-layer Worker model, the §4.1 file-path fix, the §3 roles-row update. AECI-525 finishes it **once §4 lands**:

- Add the `vendor_admin` rows to the §4.4 endpoint-by-endpoint table (`/api/vendor/*` auth + scope + audit expectations).
- Document the `requireVendor()` guard + `vendor_id` query-scoping invariant (§4 here) as the canonical pattern.
- Document the ban gate for vendor seats (§7) and the app-layer grant/revoke seam.

---

## 11. Out of scope / deferred

Explicitly **not** in this epic (tracked elsewhere or later):

- ~~**Self-serve seat invite/revoke + owner/admin distinction**~~ — **SHIPPED 2026-08-26 (AECI-664); see §11a below.** The "small schema add" this bullet anticipated turned out to be exactly that: one table (`vendor_seat_invites`) and one column (`profiles.seat_owner`), migration `0020`. Launch is no longer admin-granted-seats-only — an owner seat can invite a colleague **at any email address** (the original same-domain restriction was removed on 2026-08-26; see §11a.3), and someone with no owner to ask still falls through to the §5 claim queue.
- **Paid-tier ladder above the entry Verified fee, automated billing, self-serve card, offline-invoicing mechanics** (renewal/expiry/dunning) — the Paid Tiers epic (AECI-515). **Decomposed 2026-08-14** in `docs/STAGE_2_PAID_TIERS_SPEC.md`; the decisions landed in `STAGE_2_SPEC.md` **§8.5** (§8.4 is the AECI-514 attestations block, taken at its own review the same day). **Built out 2026-08-14…19**: the entitlement model, the capability registry, the gate, the admin set/renew/clear action, the expiry warnings and the vendor plan panel all shipped. Automated billing and self-serve card stay deferred there; dunning is deliberately out (expiry **warns**, never auto-lapses); the tier *ladder* is now a data-only edit but its **pricing** stays open.
- **Real-time / live vendor edits** — the Real-Time epic (AECI-516). **Transport resolved 2026-08-19** (ADR 0023 / `STAGE_2_SPEC.md` §8.6): **scoped client revalidation** over a per-vendor freshness cursor — **not** Durable-Object WebSockets, not SSE — decomposed into AECI-626…632 in **`docs/STAGE_2_REALTIME_SPEC.md`** and **built out 2026-08-19**. "The portal ships without persistent sockets" stayed true and is now the decision rather than the interim posture. It builds directly on this doc's §4 authz seam (a new `GET /api/vendor/updates` behind `requireVendor()`, scoped by `c.get('auth').vendorId`) and makes this doc's §6 dashboard live; nothing this epic shipped changes.
- **Integration attestation authoring / conflict UI / version-diff** *(the version-diff half is now **shipped** — AECI-303, `STAGE_2_ATTESTATIONS_SPEC.md` §9 + §9.4)* — the Integration Attestations epic (AECI-514; activates the dormant `vendor_a`/`vendor_b` sources). Decomposed at its 2026-08-14 kickoff: **`docs/STAGE_2_ATTESTATIONS_SPEC.md`** is the build contract (`STAGE_2_SPEC.md` §2.4 is now just the scope outline). It builds directly on the §4 authz seam and the §6 dashboard shipped here — the two-slot attestation authority rule is the extension of this doc's `vendor_id`-scoping invariant, and the attestations surface is a new tab on this doc's dashboard.
- **The connector-vendor catalogue-maintenance seat** — the return side of the `STAGE_2_SPEC.md` §8.8 payer carve-out, settled as policy in **§8.9** (AECI-704). **The admin half SHIPPED 2026-08-31** (AECI-722 — `/admin/connectors`, `ADMIN_PANEL_SPEC.md` §5.9); the vendor seat is still **AECI-724**. ***Provisioning* the `vendor_admin` role SHIPPED as AECI-740 (2026-09-03)** — `POST /api/admin/vendors/:id/seats`, §5.3 — so the sentence this bullet used to carry, that *no admin route writes `role = 'vendor_admin'` on its own*, is no longer true: exactly one does, and it opens no entitlement row. Deliberately **not** an entitlement row and **not** a capability id: it authorizes on this doc's existing `vendor_admin` + `vendor_id` primitive, which `findVendorProfile`'s `leftJoin` already supports for a vendor with no entitlement. What remains deferred is the vendor-facing half — the catalogue-maintenance surface a seat holder signs in to, and §8.9(5)'s plan-panel suppression — both AECI-724's.
- **Person-lookup enrichment providers** — deferred DPA/GDPR decision (§5 surfaces a link only).
- **Dark theme** — dropped; not roadmapped (light-only remains the direction). `STAGE_2_SPEC.md` §9.
- **A public/partner write API** — the "no public API surface" boundary is unchanged (`STAGE_2_SPEC.md` §9).

---

## 11a. Self-serve seat invites (AECI-664) — activating the first §11 deferral

**Shipped 2026-08-26**, extended by AECI-927 on 2026-09-14 (§11a.9). Two migrations (`0020`, `0035`), six endpoints, two web surfaces. This section is the build contract; the code is `apps/api/src/lib/vendor-seat-invites.ts`, `apps/api/src/routes/{vendor-seat-invites,seat-invites}.ts`, and `apps/web/src/app/vendor/{vendor-invite-page.ts,components/vendor-seat-{roster,invite-dialog,invite-form}.ts}`.

### 11a.1 Why this was safe to open up

§8.1(1) put a human in the loop for every seat, and that stays true for the cases that need it. What changed is the finding that the **second** seat's review was protecting nothing:

- **Not revenue.** `activateEntitlementStatements` already returns the frozen no-op when an `active` row exists (§3.1), so a second-seat grant never re-flipped `verified`, never re-charged, never even bumped `updated_at`. There is no seat cap and no seat capability: `CAPABILITIES` (`packages/shared/src/entitlements.ts`) holds seven ids and none is about seats.
- **Not attestation integrity.** `computeAgreement` (`packages/shared/src/agreement.ts`) dedupes by `attestedByVendorId`, so N seats at one vendor cast **one** vote and `confirmed` still needs two *distinct* vendor identities. Seat count cannot manufacture agreement. The residual risk is vendor-internal quality, which is the vendor's to manage.

What the review WAS protecting is the identity question — "does this person really work there?" That question is answered by the **owner**, who is themselves AECi-reviewed and is the only party who knows the answer. §11a.3 records why the same-domain gate was a poor mechanical proxy for it, and why the domain signal is now recorded (`work_email_verified`) rather than enforced.

### 11a.2 The model

**Supabase does the sign-in; the invite is ours.** GoTrue's `POST /auth/v1/invite` was evaluated and rejected — the rationale is in `apps/api/src/lib/supabase-admin.ts` (the `WHY NOT` block on `createAuthUser`) and is unchanged by this issue: its link lands on `/auth/v1/verify?type=invite` and returns the session in a **URL fragment**, which `/auth/callback` (PKCE `?code=`) dead-ends; and enabling it needs two dashboard edits on the ONE shared auth project that backs production (ADR 0017).

**The vendor never provisions an account.** No `createAuthUser` call exists on this path. An invite row is an INTENT; the invitee signs in through the ordinary self-service flow and the seat attaches on acceptance. Two consequences worth stating: it removes the spam / enumeration / third-party-consent problem a vendor-triggered account create would introduce, and — because nothing here reads `SUPABASE_SERVICE_ROLE_KEY` — the whole flow works in local `wrangler dev` and on PR previews, unlike the §3 admin grant which 503s wherever that key is absent.

**The token is not a credential.** It identifies an invite; it never authorizes one. `inviteRedeemState` (the single shared verdict, used by both the preview read and the accept write) requires the redeemer's **verified JWT email** to equal the invited address, and an ABSENT session email fails closed. A forwarded link, a shared-inbox link, or a link a scanner prefetches grants nothing.

**GET describes, POST mutates.** Mail scanners, link-preview bots and corporate URL rewriters fetch what they are sent, so a GET that redeemed would be spent by the invitee's own security appliance before they clicked. Same confirm-then-POST discipline as `/unsubscribe` (AECI-537).

### 11a.3 No domain gate (amended 2026-08-26)

**As shipped**, an invite had to pass `computeDomainMatch(email, vendors.website) === 'match'`; `no_match` and `manual_review` (freemail, or a vendor with no `website` on file) both returned **422 `INVITE_DOMAIN_MISMATCH`** and directed the owner to the §5 claim queue.

**That gate has been removed, and the error code with it.** It was gatekeeping the wrong party. Whoever holds an owner seat has already been through AECi review, and they are the only person who knows which addresses actually maintain their listing — routinely an agency, a subsidiary, a parent company, or a contractor, none of whom have a corporate address on the vendor's domain. The gate did not make the flow safer; it converted the ordinary case into a refusal the owner could not act on themselves, and pushed a concierge review back onto AECi for a decision the owner had already made.

**What bounds the endpoint is unchanged, and none of it was ever the domain:**

- only a `seat_owner` may invite (§11a.4), and that bit still originates from an AECi-reviewed claim grant;
- a **new** invited seat is never itself an owner, so the chain does not extend past one hop;
- the redeem still requires the redeemer's verified JWT email to equal the invited address, so the owner can only hand a seat to a mailbox they can already reach — they are vouching, not minting;
- `INVITE_DAILY_LIMIT` (10 per vendor per rolling 24 h) still caps the mail;
- and §11a.1's two findings hold regardless of domain: a second seat moves no money (`activateEntitlementStatements` no-ops on an `active` row) and cannot manufacture agreement (`computeAgreement` dedupes by `attestedByVendorId`).

**`computeDomainMatch` did not go away — it moved.** It now runs on the **accept** path (`routes/seat-invites.ts`) and decides one thing: whether the redeem sets `profiles.work_email_verified`. Recording that an address is on-domain and refusing every address that isn't are different features, and only the first was earning its keep. Keeping the computation at redeem time (against the address actually redeemed) is what preserves the column's meaning for the §5 reviewer, who reads it as "this account proved control of an address on the vendor's own domain" while deciding whether a claimant really works there. Setting it unconditionally on every redeem would have quietly degraded it to "someone accepted an invite". Like `seat_owner` it is never cleared — an off-domain redeem by a profile that already earned the bit keeps it.

The §5 claim queue is unaffected and remains the path for someone who has **no** owner to ask.

### 11a.4 Owner vs member

`profiles.seat_owner` is the owner/admin distinction §11 deferred, and it gates **seat management only** — data capabilities stay identical across seats, so this is not the start of a permission matrix.

- `true` on a seat created by the §3 admin claim grant (`grantSeatStatements`) — an AECi-reviewed human IS the owner event.
- `false` on a **new** seat created by redeeming an invite (`acceptInviteStatements`). **This is the bound**: without it, one reviewed human seeds an unbounded chain of seats no reviewer ever saw. Redeeming never **demotes**, though — an existing owner who happens to redeem (re-invited, or self-invited; the invite path cannot cheaply tell they already hold a seat) keeps their bit, so the accept upsert's conflict path preserves the prior `seat_owner` rather than forcing it false. Forcing it false there could strip the only owner and leave the vendor unadministrable — the state the removal path's last-owner guard exists to prevent.
- Cleared by `revokeSeatStatements`, so a stale `true` cannot make a re-linked account an owner by accident.
- **Migration `0025` (shipped as `0020`) backfills every pre-existing `vendor_admin` to `true`.** A default-`false` rollout would have shipped the feature dead — no existing vendor could invite anyone.

### 11a.5 Endpoints

Owner side, behind `requireVendor()` **plus** an in-handler `requireSeatOwner()` that re-reads `seat_owner` from D1 every request (a demotion lands on the caller's next call, the same discipline as the `banned_at` re-read in `createAuthzMiddleware`):

- `POST /api/vendor/seats/invites` — 201. Duplicate probe, **rate limit** (`INVITE_DAILY_LIMIT` = 10 per vendor per rolling 24 h, counted over `vendor_seat_invites`). It stays a D1 count after AECI-773 added a `ratelimits` binding to this Worker, because `simple.period` is a strict enum of 10 or 60 seconds and **no binding window reaches 24 h**; the binding sits *in front of* it as a burst bucket, keyed per vendor for the same reason the daily cap is. Mail is post-commit `waitUntil`; a send failure never un-creates a committed invite.
  - **The duplicate probe checks EXPIRY as well as the two terminal columns** (AECI-927). It did not, and the roster always has, so an invite that lapsed unredeemed was invisible on the roster while still returning the 409 below — that address could never be invited again, and the owner could not see, revoke, or re-send the row blocking them. Both callers now share `liveInvitesFor`.
- `POST /api/vendor/seats/invites/:id/resend` — 200 (AECI-927). See §11a.9.
- `DELETE /api/vendor/seats/invites/:id` — 204, soft delete (`revoked_at`).
- `DELETE /api/vendor/seats/:userId` — 204. **The first HTTP surface `revokeSeatStatements` has ever had** (AECI-524 shipped the builder unwired). Refuses self-removal; also carries an explicit last-owner guard which is *currently unreachable* and kept deliberately — see the handler docblock.

Invitee side, on its **own prefix** and behind `requireAuth()`, because the caller is by definition not a `vendor_admin` yet:

- `GET /api/seat-invites/:token` — the preview + the redeemability verdict.
- `POST /api/seat-invites/:token/accept` — attaches the seat.

`GET /api/vendor/seats` gains `pending_invites` and `can_manage_seats`. It stays **un-gated** by capability (`STAGE_2_PAID_TIERS_SPEC.md` §4.3). **The `token` is never on this payload** — the roster is readable by every seat, and a token there would let any seat redeem an invite addressed to someone else's mailbox. It appears in exactly one place: the invite email.

Each `pending_invites` entry is a `ManageableSeatInvite` — the base `VendorSeatInvite` plus `last_sent_at` and `resend_state` (AECI-927). The split is deliberate: the base has two other consumers (the admin user detail and the admin vendor detail) and **neither has a re-send action**, so shipping them a re-send verdict would put a permission claim on a surface that cannot honour it.

### 11a.5a The owner's surface: roster, with invite behind a trigger

The Seats section is a **reading** surface first — who has access, who has a pending invite — so the create-an-invite form does not sit permanently under it. The section heading carries the action:

- **`Invite`**, right-aligned opposite the "Seats (N)" heading (`components/vendor-seat-invite-dialog.ts`), opens the form in a Spartan `BrnDialog` modal. Owner-only: the component renders **nothing at all** for a member seat, so the heading row simply collapses to the heading.
- **`components/vendor-seat-invite-form.ts`** is the dialog's body only — field, submit, outcome. The heading and the "any email address works" hint are the dialog's `brnDialogTitle` / `brnDialogDescription`.
- **`components/vendor-seat-roster.ts`** keeps the roster, the pending-invite list, and the three actions over them: remove seat, revoke invite, and **re-send invite** (AECI-927, §11a.9). It no longer carries a form of any kind. Re-send lives here rather than in the dialog because it acts on a row already on screen, and the fact the owner needs in order to decide — when it last went out — is the line beside the button.

Both surfaces gate on the same `can_manage_seats` from `GET /api/vendor/seats` — the SERVER's verdict on `profiles.seat_owner`, never re-derived from the roster, because hiding a control the API would 403 and showing one it would accept have to come from one source. That read is also why the trigger appears **with** the roster rather than with the first paint.

Two deliberate behaviours:

- **The dialog stays open after a successful send.** Seats are onboarded in batches; the form clears its field and keeps the "Invite sent to …" line, so "send another" costs nothing. The durable confirmation is the roster's "Pending invites" list, which the form has already re-read from the server. (Contrast `home-feedback-dialog.ts`, a one-shot, which auto-closes.)
- **The overlay opens imperatively from the click handler**, never from an `effect()` — the latter throws NG0602 (CDK attaches a provider that itself creates an effect; hit on AECI-218). Nothing but a click opens this, and the imperative form is what keeps the component renderable under TestBed, which the `effect()` form is not.

### 11a.6 Seat management is NOT entitlement-gated

No `requireCapability` call exists in `routes/vendor-seat-invites.ts`, and that is a position rather than an omission. There is no seat capability in the frozen registry; §3 already establishes that clearing an entitlement does not revoke seats; and gating **removal** on a live entitlement would mean a lapsed vendor cannot revoke a departed employee's access — a security regression wearing a billing lever's clothes. A lapsed vendor's seats still cannot write anything: every data write is separately capability-gated.

### 11a.7 Routing

The portal is `/vendor/:vendorSlug/<section>` since §6.2, so the redeem page is `/vendor/invite/:token`, registered **ahead of `:vendorSlug`** in `vendor.routes.ts` (or the literal `invite` segment is captured as a slug and `vendorMeResolver` 404s the one page a non-vendor must reach). It is deliberately OUTSIDE that layout route — everything under it is behind the resolver — but stays under `/vendor/` so the worker-level anon gate (`isVendorPath`) bounces a signed-out visitor to `/auth/login?return=<path>` with the token intact (`safeReturnPath` preserves query strings and path segments alike). **That bounce is the flow, not a side-effect.**

### 11a.8 Deliberately deferred

- **An `invites` scope on `GET /api/vendor/updates`.** There were exactly six cursor scopes when this shipped. AECI-1008 has since added a seventh, `contests` (§11b.8), so an `invites` scope would be the eighth, and it is still its own change. (AECI-992 added a second `integrations` read, not a scope, so the batch is eight SELECTs for seven scopes.) Cross-tab invite freshness degrades to on-demand `store.reload('seats')`, which the surface already does after every write.
- ~~**Cross-domain invites.**~~ **Shipped 2026-08-26** — the domain gate was removed outright; see §11a.3. The §5 claim queue remains the path for someone with no owner to ask.
- **Bulk/CSV invite, and role tiers beyond owner/member.**
- **A seat-count capability or per-seat billing** — a Paid Tiers (AECI-515) decision, not this one's.

### 11a.9 Re-sending an invite (AECI-927 — 2026-09-14)

`POST /api/vendor/seats/invites/:id/resend` → **200** `{ invite }`. Owner-only, behind the same three
gates as the rest of §11a.5, and not entitlement-gated for the same reason (§11a.6).

**Why it exists.** An invite that goes to spam, gets deleted, or is simply ignored had no recovery
path. The only move was revoke-then-re-invite, which mints a new token and spends one of the day's
ten. That is a capability gap dressed as a UX gap: the owner *could* get there, but by a route that
does not look like "send it again".

**The token is NOT rotated.** It was never a bearer credential — the redeem is bound to the invited
mailbox (§11a.2) — so rotation buys no security, and it costs the exact failure the endpoint exists
to fix: it silently kills a link the invitee may already be holding, so of two mails only the newest
works with nothing on the dead one to say why.

**`expires_at` IS refreshed** to `now + INVITE_TTL_DAYS`. An invite re-sent on day 13 with a day left
is barely worth sending, and the email states its own expiry, so the row and the mail have to agree.
That refresh is also why the lifetime cap below is the real bound rather than a nicety.

**Three caps, three different mechanisms**, and the third is the one that actually bounds volume:

| Cap | Mechanism | Refusal |
|---|---|---|
| Burst | the AECI-773 `write` bucket, `by: 'vendor'`, **shared with the create route** (no `tag:` — splitting it would let an owner spend both budgets for twice the mail) | 429, `Retry-After: 60` |
| Per invite | `RESEND_COOLDOWN_MINUTES` = 5, a per-row comparison against `last_sent_at` | 429 with an **exact** `Retry-After` |
| Per invite, lifetime | `INVITE_MAX_SENDS` = 4 **including the original** | **422 `INVALID_STATE_TRANSITION`** |

The last row is not a 429, and that is the point: a 429 promises that waiting helps, and here it
never does. The copy has to send the owner to revoke-and-re-invite, so the status has to agree. A
cooldown alone would not bound anything useful — pending invites accumulate for 14 days at up to
`INVITE_DAILY_LIMIT` a day, so daily volume without a lifetime cap runs to the thousands. With it,
total sends are a constant multiple of a creation rate that is already capped.

**An EXPIRED invite is a 404, not a revival.** Reviving would contradict the roster, which does not
show it, and would hand the lifetime cap a way around itself — an owner could park an address
indefinitely by re-sending on each expiry.

**The mail names the ORIGINAL sender**, resolved from `invited_by_id`, not whoever pressed the
button. The email's job is to be recognisable to the recipient, and the name they may already have
seen on the first copy is what does that; `requireSeatOwner` proves the caller may act, it is not the
byline. It falls back to the caller when that account has been erased (`ON DELETE SET NULL`).

**Schema.** Migration `0035`, two additive columns on `vendor_seat_invites`: `last_sent_at`
(nullable — `null` means it has only ever gone out once, at `created_at`) and `send_count` (default
`1`). Nullable and constant-default respectively, so drizzle-kit emits plain `ALTER TABLE ADD COLUMN`
rather than the table rebuild a CHECK change would force (§1.2 / R1).

**One verdict function, three consumers.** `inviteResendState` decides `ok` / `cooling_down` /
`send_limit`, and it is what the roster read ships as `resend_state`, what the handler re-runs before
writing, and what the response echoes. The reason travels rather than a boolean because a disabled
control with no explanation is a dead end, and the two refusals need opposite copy — one clears
itself in minutes, the other never does.

**Same shape as the rest of §11a otherwise**: the `audit_log` row (`vendor_seat.invite_resent`) rides
the same `db.batch` as the UPDATE (§26.1), `send_count` increments in SQL rather than as a literal
computed from the handler's read, and the mail is post-commit `waitUntil` — a send failure must not
roll back a committed expiry refresh.

**The UPDATE's `WHERE` is a compare-and-swap, and it has to be.** Vendor-scope-plus-pending is the
revoke's guard, and it survives a race there only because the revoke SETS `revoked_at`, which its own
`WHERE` tests — so the second of two concurrent revokes matches nothing. Nothing the re-send SETS is
read by those four terms, so `send_count = <the value just read>` is the term that makes the row
advance exactly once and keeps `INVITE_MAX_SENDS` enforceable. What it does **not** do is suppress the
losing request's `audit_log` row or its mail: the audit insert is an unconditional second statement in
the batch, and no statement in a `db.batch` can be made conditional on another's row count. Duplicate
mail is bounded by the cooldown and the per-vendor `write` bucket, not by this predicate.

---

## 11b. Integration field contests (AECI-1008)

**API half shipped 2026-09-18 (PR A). Portal half shipped 2026-09-18 (PR B), §11b.10. Admin queue shipped 2026-09-18 (PR C), §11b.11.** This section is the build contract. The code is `apps/api/src/routes/{vendor-contests,admin-contests}.ts`, `apps/api/src/lib/integration-contests.ts` and `packages/shared/src/api/integration-contests.ts`. The table is `integration_field_challenges`, migration `0043_needy_hobgoblin.sql`.

### 11b.1 What a contest is

A seated vendor says one field of an integration is wrong. It names the field, proposes a value, and gives a reason. The row is a request, never the value. Nothing public reads it.

### 11b.2 Who may contest

- **An endpoint vendor.** The caller must own one of the integration's two products in `product_vendors`. Authority resolves through `resolveAttestationSlots`, the same rule attestations use. Anyone else gets a `404` that looks exactly like an unknown id.
- **Not the owner.** The vendor named in `built_by_vendor_id` (the vendor that owns and offers the integration, per AECI-1003) gets `403 CONTEST_OWN_INTEGRATION`. It owns the row, claims it (AECI-1005) and then edits it directly through `PATCH /api/vendor/integrations/:id` (AECI-1006, §4.5.6).
- **A seat is the whole gate.** The route carries `requireVendor()` and nothing else. There is no `requireCapability` and no Verified check.

That last point is a **named exception to §6.14 of `API_CONTRACTS.md`**, which says vendor writes are entitlement-gated. A contest asks for a fact on a public page to be fixed. Gating it behind a paid tier would make accuracy something a vendor buys, which is the pay-for-placement line from the other side. A contest also writes nothing public by itself.

### 11b.3 The fields

Twelve: `name`, `mechanism_kind`, `mechanism_name`, `direction`, `description`, `listing_url`, `docs_url`, `website`, `mechanism_url`, `pricing_model`, `maturity`, and `owner`. `owner` names `built_by_vendor_id`. The portal and the admin queue label it **Owner**, and the admin row reads "Offered by", matching the public pair page's byline (AECI-1021). `notes` is AECi's own curation column and is not contestable.

Per-field rules live in `contestValueProblem` in `@aeci/shared`, so the portal form can run the same check.

| Field | Rule |
|---|---|
| the four URL fields | an absolute `http(s)` URL |
| `mechanism_kind` | a value of `IntegrationMechanismKindSchema`, not a new spelling |
| `direction` | `inbound`, `outbound` or `both`, relative to the caller's product |
| `owner` | one of the integration's endpoint vendor ids, or `null` for "neither endpoint vendor owns it" |
| every field | a value is required, except the `owner` `null` case; length is capped per field |

`direction` is stored canonical (`a_to_b`, `b_to_a`, `both`) and translated at the boundary with `claimDirectionFromContext`. A body that sends `context_product_id` picks the frame when the caller owns both endpoints, exactly as `POST /api/vendor/claims` does.

A shape error is a `400`. A value wrong for its field is `422 CONTEST_INVALID_VALUE`. A value equal to the current one is `422 CONTEST_NO_CHANGE`. A second open contest on the same (integration, field, vendor) is `409 CONTEST_DUPLICATE`, backed by a partial unique index.

### 11b.4 Routing

The route is decided at submit and stored on the row, with the owner snapshot in `owner_vendor_id`. A later change to `built_by_vendor_id` cannot move an open contest to a different decider.

- **`owner`** when the integration is claimed, the field is not `owner`, and an owner is on file.
- **`aeci`** otherwise.
- **An `owner` contest always routes to AECi.** The owner cannot judge whether it is the owner.

`isIntegrationClaimed()` in `lib/integration-contests.ts` was a stub that returned `false` until **AECI-1005** replaced it with the real test, `claimed_at IS NOT NULL` (§4.5). The owner path is live from that change. The submit handler still takes the predicate as an injectable argument, so specs can pin either route.

**The four gaps AECI-1008 listed for AECI-1005, and how each was closed.** The original text is kept below each so the reasoning stays legible.

- **Closed: promote no longer reverts an owner accept.** A claimed row is fenced wholesale (`REVIEW_APP_PROMOTE_API.md` §4b), and only a claimed row routes contests to its owner.
- **Closed: the `integrations` cursor now sees an owner accept.** It covers `MAX(integrations.updated_at)` under the same `ownedEndpointJoin` (`STAGE_2_REALTIME_SPEC.md` §2.2). AECI-992 shipped that read on `main` first, and AECI-1005 relies on it rather than adding a second one.
- **Closed: a deleted owner no longer strands an owner-routed contest.** An owner-routed row whose `owner_vendor_id` is NULL is decidable by the admin PATCH as if routed to AECi, is counted in `pending_contests`, and shows Accept and Decline on `/admin/contests` (§11b.5).
- **Closed structurally: a `direction` contest's anchor cannot be re-oriented under it.** Only promote re-points endpoints, and promote can no longer write a claimed row, which is the only kind of row an owner-routed contest sits on.

The original list:

- **Promote reverts an owner accept.** `integrationEditableData` in `routes/promote.ts` rewrites all eleven contestable columns on any re-promote of the edge. Only `last_reviewed_at` is protected on a vendor-maintained row. AECI-1005 must fence promote writes on a claimed integration, as AECI-520 does for claimed vendors and products.
- **The `integrations` cursor misses an owner accept.** `GET /api/vendor/updates` derives that cursor from `claims` and `attestations` only. An owner accept writes `integrations` and touches neither, so the submitter's portal keeps the old value until a reload. Add `MAX(integrations.updated_at)` to the cursor, or have the client refetch `integrations` when `contests` moves.
- **A deleted owner strands an owner-routed contest.** `owner_vendor_id` is `ON DELETE SET NULL`. The vendor decide route then cannot match the row, and the admin PATCH refuses it with `409 CONTEST_ROUTED_TO_OWNER`. Only the submitter's withdraw can close it.
- **A `direction` contest does not record which product was A.** If promote re-orients the edge while the contest is open, an owner accept writes the inverse direction. Snapshot the source product id at submit and refuse a decision when it has changed.

### 11b.5 States and deciders

`open`, then one of `accepted`, `declined` or `withdrawn`.

| Transition | Who | Endpoint |
|---|---|---|
| `open → withdrawn` | the submitting vendor only | `POST /api/vendor/contests/:id/withdraw` |
| `open → accepted \| declined` on an `owner` row | the owner vendor only | `POST /api/vendor/contests/:id/decision` |
| `open → accepted \| declined` on an `aeci` row | an AECi admin | `PATCH /api/admin/contests/:id` |
| `open → accepted \| declined` on a **stranded** `owner` row (owner vendor deleted, `owner_vendor_id` NULL, AECI-1005) | an AECi admin | `PATCH /api/admin/contests/:id` |

Anyone else gets a `404`. A closed contest answers `409 CONTEST_NOT_OPEN`. **The owner's decide route re-checks ownership now, not at submit** (AECI-1005 review): unless the integration is still claimed by the caller it answers `409 CONTEST_INTEGRATION_CHANGED`, and the same condition is re-asserted in the batch. An AECi accept that reassigns a claimed row re-routes every open owner-routed contest on it to AECi in the same batch (`integration.contest.rerouted`, an `open → open` transition), so none is left in the old owner's inbox. The admin PATCH refuses a non-stranded owner-routed row with `409 CONTEST_ROUTED_TO_OWNER`, and answers `409 CONTEST_INTEGRATION_CHANGED` when the integration was claimed or re-owned while the admin decided (the whole batch rolls back), and `409 CONTEST_VALUE_STALE` when a content accept on a claimed row would overwrite a value that changed since submit (§11b.6).

### 11b.6 What an accept does

**An owner accept writes the catalog.** In the same batch it sets the column, transfers maintenance to the vendor (`maintained_by = 'vendor'`, a fresh `last_reviewed_at`), and writes an `integration.updated` audit row with before and after. `metadata.maintenanceTransfer` is present only when the row changes hands. This is the sixth vendor-authorized catalog write site under `STAGE_2_ATTESTATIONS_SPEC.md` §13.9. After commit it purges `pair:{a}__{b}` and both `product:` tags and queues the re-crawl, like an attestation edit.

**An AECi accept writes catalog data only where promote no longer can (AECI-1005, ADR 0035).** On an unclaimed row the catalog is curated upstream and arrives through promote, so a value written here would be undone by the next promote: the accept writes nothing. On a claimed row promote writes nothing, so the accept must. The cases, decided on the row's state at decision time and guarded by `contestIntegrationStateSentinel`:

| Contest | Integration | Writes here | Issue title |
|---|---|---|---|
| content field | unclaimed | nothing | `Apply contested field` |
| content field | claimed | the column + `integration.updated` (`reason: 'contest-accepted'`), purge. No maintenance transfer: an AECi write | `Apply contested field`, worded "AECi already applied it" |
| `owner`, proposed = submitter | not connector-powered | `built_by_vendor_id`, `claimed_at`, transfer + `integration.claimed` (`reason: 'owner-approved'`), claim notification, purge | `Record integration owner` |
| `owner`, proposed = submitter | connector-powered | nothing (decision 9, v1) | `Apply contested field` |
| `owner`, proposed = someone else or neither | claimed | `built_by_vendor_id` = proposed, `claimed_at = NULL` + `integration.updated` (`reason: 'owner-reassigned'`), purge | `Record integration owner` |
| `owner`, proposed = someone else or neither | unclaimed | nothing | `Apply contested field` |

**A stale accept is refused (AECI-1006, ruled 2026-09-22).** The content-field/claimed row above writes the column, and routing is frozen at submit, so a contest filed before the claim can reach an admin after the owner has edited the same field. When the live column differs from the contest's recorded `current_value` (`NULL` counts as a value), the accept answers `409 CONTEST_VALUE_STALE` and writes nothing. It is checked on the handler's read and again inside the batch by `contestValueUnchangedSentinel`, a `ONE_ROW` guard placed after the integration-state sentinel. The admin declines, or the submitter withdraws and re-files against the current value. `GET /api/admin/contests` carries `live_value` and `value_stale` so the queue shows the reason before anyone clicks (§11b.11). No other case is ever stale: an unclaimed row writes nothing here, and an `owner` contest is decided on ownership.

The decision's own audit row records the case as `metadata.appliedMode` (`upstream-only | applied-here | owner-recorded`), which is what the reconciliation sweep reads back when it re-files a missing issue. Every accept files a Linear issue through `ctx.waitUntil`:

- title `REVIEW - Apply contested field: <field> on <integration>`, or `REVIEW - Record integration owner: <integration>` when the accept wrote an owner here, on the AECi team, with **no project**, per the three-repo routing in `docs/linear-issue-conventions.md`;
- a body carrying the app-DB integration id, the pair page, the current and accepted values, the vendor's reason, the admin note, a link to the `/admin/contests` queue (there is no per-contest route, so the contest id in the footer is what the operator matches), and a pointer to the playbook, **AECI-1025**;
- `createLinearIssueForContest` in `lib/linear.ts`, on the same contract as the request path: it never throws, an absent key is a metric-silent no-op, a read-guard makes a re-fire safe, and the persist is a compare-and-set onto `upstream_linear_issue_id` and `upstream_linear_issue_url`.

The request reconciliation sweep (Phase 6.7, `STAGE_1_PHASE_6_SPEC.md` §6.4) retries accepted AECi rows that still have no issue id. The issue id is **never** written to `workflow_instances.linear_issue_id`, so the inbound Linear webhook cannot mistake a contest issue for a request's.

### 11b.7 One batch per transition

Every transition writes, in one `db.batch`:

- the contest row change, guarded on `status = 'open'` for a decision and followed by the race sentinel;
- an `audit_log` row (`integration.contest.submitted | withdrawn | accepted | declined`, entity type `integration_field_challenge`);
- a `workflow_transitions` row, plus the instance insert or close;
- a `notification.sent` audit row for the other side, when there is a vendor on the other side.

**The workflow type is `correction_request`, reused.** `workflow_instances_type_check` is closed, and opening it is a table recreate. `entity_id` is the contest id, which cannot collide with a `vendor_requests` id. The webhook and the request sweep both key off `vendor_requests`, so neither can pick a contest up.

**A lost decision race writes nothing and answers `409`.** Each guarded `UPDATE … WHERE status = 'open'` is followed immediately by a sentinel statement (`contestStillOpenSentinel` in `lib/integration-contests.ts`). It reads SQLite's `changes()`; when the UPDATE matched no row it evaluates `json('contest-not-open')`, which raises and rolls the whole batch back. Every other statement sits after it. So the loser commits no audit row, no transition, no catalog write, and no notification that could tell the other side the wrong outcome. The handler recognises that one error and answers `409 CONTEST_NOT_OPEN`; anything else rethrows. This is stricter than the §26.3 lean relaxation `admin-requests.ts` accepts, because a wrong notification is visible harm.

### 11b.8 Notifications and freshness

**Notifications are audit rows.** A contest event writes `notification.sent` with `metadata.kind = 'contest'` and `metadata.vendorId` set to the recipient. `submitted` and `withdrawn` go to the owner, and only on an owner-routed row. `accepted` and `declined` go to the submitter. Since AECI-1010 a retire that closes an open contest also sends the submitter a `closed_by_retire` event (§4.6). There is no email. `GET /api/vendor/notifications` returns them as a union member on `kind` (`STAGE_2_ATTESTATIONS_SPEC.md` §7.5). The feed's scoping predicate is unchanged, so the `notifications` cursor needed no change.

**`contests` is the seventh cursor scope** on `GET /api/vendor/updates`. It reports `MAX(updated_at)` under `vendorContestsWhere`, which is the same predicate `GET /api/vendor/contests` imports (`STAGE_2_REALTIME_SPEC.md` §2.2). The list is capped at 100 rows per side; the cursor covers the whole scope, so an edit past the cap costs one wasted refetch and nothing else.

### 11b.9 Known risk: a cascade can delete contests

`integration_id` is `ON DELETE CASCADE`. A promote cross-table move (AECI-888) or a retraction deletes the `integrations` row and takes its contests with it. This is accepted because it can now happen only to unclaimed rows, which carry no owner-side state. AECI-1005 closed the other half: promote refuses the cross-table move on a claimed row, and the retraction consumer refuses to delete a claimed row (§4.5.5).

The table is now the second cascade child of `integrations`. `apps/api/src/test/d1.spec.ts` pins the list, so the next recreate of `integrations` must carry it out of the way first (`docs/migrations.md` §3.3a).

### 11b.10 As built — the portal (PR B, 2026-09-18)

Three surfaces, one store resource, one wire addition.

**"Contest a field" on the integration card** (`components/vendor-contest-form.ts`, mounted by `vendor-integration-card.ts`).

- **Shown when `!integration.is_owner`, and on nothing else.** It is not gated on `canWrite` (the Verified gate), not on the entitlement, and not on `attestable`. A vendor without active access, or on a connector-powered edge, can still ask for a wrong public fact to be fixed. That is §11b.2 carried to the UI.
- **A disclosure button, then a pessimistic form.** Field is a native `<select>` over the twelve fields, in the §11b.3 order. A field the vendor already has an open contest on is a disabled option, so the form never collects a `409 CONTEST_DUPLICATE` it could have prevented. The value on record renders read-only above the control.
- **The control follows the field.** URL fields get `<input type="url">`, `description` a textarea, `mechanism_kind` a native select over `IntegrationMechanismKindSchema`, `direction` a native select of the pair page's own caller-relative sentences ("Sends to X", "Syncs both ways", "Receives from X"), `owner` a native select of the endpoint vendors plus "Neither endpoint vendor", and a text input otherwise. Native selects follow the 2026-09-17 data-flow pickers (ADR 0010 deviation (d)).
- **Every control starts at the current value.** A vendor edits what is on record rather than retyping it, and an unchanged value is refused client-side before the server's `CONTEST_NO_CHANGE`.
- **One rule, shared.** The value check is `contestValueProblem`, and the body is parsed with `SubmitIntegrationContestSchema` before it is sent. Only the sentence is chosen locally (`vendor-contest-labels.ts`). `context_product_id` is always the card's context product.
- **On `201`** the form announces through `VendorPortalAnnouncer` ("sent to the integration's owner" or "sent to AEC Integrations", from `routed_to`), closes, returns focus to the trigger, and revalidates `contests`. **On an error** a `role="alert"` beside the form maps `CONTEST_DUPLICATE`, `CONTEST_NO_CHANGE`, `CONTEST_INVALID_VALUE`, `CONTEST_OWN_INTEGRATION` and `RATE_LIMITED` to plain copy.
- **The card also says when the vendor has an open contest on it**, one line naming the fields, read from the `contests` resource.

**The owner picker needed one wire field.** `GET /api/vendor/integrations` gains `endpoint_vendors`: every vendor owning either endpoint product, deduped and sorted by name. Those are the only values an `owner` contest may propose, and the portal had no way to know them. It is `.default([])` in the shared schema, but that default only applies where Zod parses. The web client reads the response through `HttpClient` without parsing, so a web build talking to a pre-AECI-1008 API sees `undefined`, not `[]`. The same holds for `contestable_fields` and `is_owner`. Production deploys the API first, so this bites only on an API-only rollback.

**Field contests in Messages** (`components/vendor-contests-list.ts`, §6.5). Two lists off one read:

- **Received** is the owner inbox. Each row shows the field and integration, the value on record and the proposal, the reason, the submitting vendor and the date, with an optional note (encouraged on a decline) and Accept / Decline. An accept revalidates `integrations` too, because it wrote the catalog. The empty state says the inbox fills once the vendor claims an integration it owns, and that AEC Integrations reviews contests until then. That is the production state until AECI-1005 replaces the `isIntegrationClaimed()` stub.
- **Submitted** shows a status pill (Open, Accepted, Declined, Withdrawn), "With the owner" or "With AEC Integrations" while open, the decision note, and Withdraw on open rows. Withdraw confirms inline, never with `confirm()`, and moves focus to the confirm button and back.
- **Every write is pessimistic and re-read**, the `vendor-seat-roster.ts` pattern. A `409 CONTEST_NOT_OPEN` says "already decided or withdrawn" beside the row and reloads the list, so the row shows the state that won.

**Store and live sync.** `contests` is a fifth `VendorPortalResource` (and a `VendorPortalSection`) with its own status, version and retry. PR A's stopgap mapping of the `contests` scope onto the notifications refetch is gone from both `vendor-portal-store.ts` and `vendor-live-sync.ts`.

**Notification archive.** Contest rows render with a title per event, written from the recipient's seat: "Another vendor contested a field on your integration" (`submitted`), "A contest on your integration was withdrawn", "Your contest was accepted", "Your contest was declined", and since AECI-1010 "Your contest was closed because the owner retired the integration" (`closed_by_retire`). The secondary line names the field and the integration. **Since AECI-1023** some rows carry one more sentence under the title saying what the event means for the recipient (`contestNotificationNote` in `vendor-contest-labels.ts`, `noteOf` in `vendor-notifications-list.ts`): `submitted` points the owner at Field contests, `declined` says the value on record stays, and `closed_by_retire` says a restore does not reopen the contest. `accepted` has no note on purpose, because what an accept changes, and when, depends on the decider and the row's claim state (§11b.6), and the event does not carry either. No note offers a protest: AECI-1009 is designed, not built. The archive's framing sentence now says it holds contest updates as well as emailed reminders, because contest events are never emailed.

**Overview.** "What needs you" gains one Needs-you-now row for open received contests, linked to Messages (§6.10).

**The owner field is labelled "Owner", not "Builder".** AECI-1003 (ruled 2026-09-18) defined `built_by_vendor_id` as the vendor that owns and offers the integration, and AECI-1021 relabelled the public byline "Offered by". PR B had shipped "Builder" and "the card the caller did not build". PR C renamed the field label, the owner hint, the own-integration refusal and the empty Received copy to owner language under new i18n ids. The column and the code identifiers keep their names.

### 11b.11 As built — the admin queue (PR C, 2026-09-18)

`/admin/contests` (`apps/web/src/app/admin/contests/contest-queue.ts`), under Operations beside Vendor claims. The IA, the badge and what the screen will not do are in `ADMIN_PANEL_SPEC.md` §5.12. What matters for this section's contract:

- **Two filters.** Status tabs (Open, Accepted, Declined, Withdrawn; default Open) and "Decided by" (AEC Integrations, the default, or The owner). Both map one-to-one onto `ListAdminContestsQuerySchema`.
- **Owner-routed rows are read-only.** They carry a "With the owner" pill and a sentence saying the owner decides, and render no Accept or Decline. That is §11b.5's single-decider rule shown in the UI rather than discovered as a `409 CONTEST_ROUTED_TO_OWNER`.
- **Accept says what it does not do.** The help text under the button, tied to it by `aria-describedby`, says accepting does not change the live listing and files a REVIEW issue for the review app (playbook AECI-1025). The success announcement repeats it. That is §11b.6's "an AECi accept writes no catalog data" in the operator's words.
- **The note is optional on both decisions and encouraged on decline.** The API accepts no note, so the form does not require one. Both forms say the note is shown to the vendor that filed the contest, and the accept form says it is also copied into the Linear issue.
- **The live value, and a stale accept (AECI-1006).** An open card shows "On the integration now" whenever the live value differs from the recorded one. When that makes the accept stale (`value_stale`, §11b.6), Accept is disabled with a sentence saying why, and Decline stays. A `409 CONTEST_VALUE_STALE` from a value that moved after the list loaded announces "Not accepted" and reloads.
- **Accepted AECi rows show the issue.** A link from `upstream_linear_issue_url`, or "Linear issue pending" while the post-commit filing or the §6.7 sweep has not landed it.
- **Pessimistic, one decision at a time.** A success drops the row and decrements the `contests` badge. `409 CONTEST_NOT_OPEN` announces "Already decided" and reloads, so the row shows the state that won, and does not decrement. `409 CONTEST_ROUTED_TO_OWNER` keeps the row with an inline alert.
- **No detail route.** The API has no single-contest read, and the row already carries every field a decision needs.

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
| Connector lane — who pays, and what a connector vendor gets instead | `STAGE_2_SPEC.md` §8.8 (payer) + §8.9 (return side) + §8.10 (a connector vendor that owns integrations it manages pays); the operator procedure is §5.2 here. Tracked catalogues/stubs and `docs/connector-vendors.md` live in the **`aec-integrations-review`** repo |
| Paid tiers & entitlements — the successor epic (AECI-515) | `STAGE_2_PAID_TIERS_SPEC.md` (§3's un-verify owner, §6.1's paid-tier display, §9's billing notices, §11's deferrals) |
| Integration field contests (§11b) | Wire shapes and error codes: `API_CONTRACTS.md` §4, §6.10, §6.14. Table: `DATABASE_SCHEMA.md` §8.7. Notifications: `STAGE_2_ATTESTATIONS_SPEC.md` §7.5. The owner-accept write: `STAGE_2_ATTESTATIONS_SPEC.md` §13.9. The `contests` cursor: `STAGE_2_REALTIME_SPEC.md` §2. The Linear retry: `STAGE_1_PHASE_6_SPEC.md` §6.4 (the Phase 6.7 sweep). What "claimed" means: §4.5 (AECI-1005, ADR 0035) |

---

*This is the build contract for AECI-513. As each sub-issue lands, keep this doc current with the code (per the "update all documents" rule) — the file/line references in §1.2, §1.3, and §8.2 are anchors, not guarantees; verify them before editing the cited files.*
