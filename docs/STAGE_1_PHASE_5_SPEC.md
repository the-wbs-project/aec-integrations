# Stage 1 — Phase 5 Spec (Auth & Reviews)

Sibling to `STAGE_1_PHASE_2_SPEC.md`. Governs Phase 5 of the build order (`STAGE_1_SPEC.md` §16). Where this doc and §16 disagree, **this doc wins for Phase 5** (and §16 has been reconciled to point here). Planned 2026-06-10; decomposed into AECI Phase 5.1–5.16.

---

## 1. Goal

Turn the read-only directory into a participatory one: let real AEC practitioners **sign in**, **submit dual reviews** (product quality + onboarding), and **manage/delete their account** (GDPR), and give admins a **moderation queue** to approve/reject reviews before they go public. End state: a product page can show approved reviews and a ratings summary; a signed-in user can submit one review per product; an admin can clear the queue.

Phase 5 is the first phase that introduces **visitor state** (an authenticated session) into a deliberately cache-neutral, edge-first architecture. Protecting that architecture is a first-class constraint, not an afterthought (§8).

---

## 2. Inputs from Phases 1–4 — what already exists (do NOT rebuild)

Phase 5 is **app code**. The data layer and authorization model shipped in earlier phases. Confirmed against `main` @ 2026-06-10:

- **`profiles`** (baseline migration; Prisma `Profile`): `id`, `display_name`, `role` (default `reviewer`), `vendor_id`, `work_email_verified`, `trust_tier`, `theme_preference`, `banned_at`, `ban_reason`. Auto-created on signup by the `handle_new_user()` trigger (`AFTER INSERT ON auth.users`, search_path pinned — AECI-44); delete mirror trigger (AECI-69).
- **`reviews`** (baseline migration; Prisma `Review`) — **every column Phase 5 needs already exists**: `id`, `product_id`, `reviewer_id`, `rating_overall`, `rating_onboarding`, `title`, `body`, `role_at_company`, `years_using`, `would_recommend`, `status` (default `pending`), `rejection_reason`, `moderated_at`, `moderated_by`, `toxicity_score`, `verified_work_email`, `locale`, `created_at`, `updated_at`. Indexes: `(product_id, status)`, `(status, created_at desc)`, and a **partial unique index `(product_id, reviewer_id) WHERE reviewer_id IS NOT NULL AND status <> 'archived'`** — DB-enforced one-review-per-user-per-product.
- **`products`** already carries denormalized `review_count`, `rating_overall_avg`, `rating_onboarding_avg` (app-maintained; AECI-104).
- **RLS** (AECI-29/87, live on every env): profiles — owner-read + admin-read-all; reviews — public read `status='approved'`, owner-read-own (if `is_active_user()`), admin-read-all. **No INSERT/UPDATE/DELETE grants to anon/authenticated — all writes are Worker-only.** Helpers `public.is_admin()` and `public.is_active_user()` exist.
- **`workflow_instances` / `workflow_transitions`** (generic FSM tables) exist — used by the Phase 6 moderation orchestration, **not** Phase 5 (§3.2).
- **`appendAuditLog()`** (`packages/shared/src/audit-log.ts`) — production-ready, used by every state-changing write.
- **Cache-neutrality** (`apps/web/src/server-runtime.ts`): `/auth/*`, `/account*`, `/api/*`, `/search` are **non-cacheable** and pass cookies through unchanged; only the `theme` cookie is stripped on cacheable routes. The Supabase session cookie therefore survives by design.
- **Forms**: Signal Forms is the standard (ADR 0009, AECI-128); `apps/web/src/app/requests/request-form.ts` is the exemplar (model `signal()` + `form()` + `validateStandardSchema(p, ZodSchema)` against a shared `@aeci/shared` schema). Angular Aria for select/combobox/radio (ADR 0010 **Proposed**; AECI-133 is the designated first-Aria-form issue).
- **Authorization model**: `AUTH_AND_RLS.md` is **complete** (not a placeholder — CLAUDE.md note corrected). It already specifies the three-layer model and, critically for Phase 5, the **Worker authorization layer** (§4: JWT verify → hard fail; role + ban check before Prisma; audit inside the transaction; endpoint-by-endpoint expectations; GDPR auth→public sync). Phase 5 **implements** AUTH_AND_RLS §4 — it does not redesign it.
- **API contracts already specified** in `API_CONTRACTS.md`: `POST /api/reviews` (§6.6), `DELETE /api/account` (§6.8), `GET /api/admin/reviews` + `PATCH /api/admin/reviews/:id` (§6.10). Phase 5 implements these. **Gap filled by this spec:** a public reviews-list endpoint (§5.4) — added to API_CONTRACTS as part of Phase 5.1.

**Net:** Phase 5 ships **zero or near-zero migrations**. The work is auth wiring, two API write paths, one public read path, the admin moderation API+UI, and the front-end (login, review form, review display, account, admin queue).

---

## 3. Scope

### 3.1 In scope (Phase 5)

1. **Auth**: Supabase Auth (magic link + Google OAuth), `/auth/login`, `/auth/callback`, session read in the SSR Worker, sign-out, signed-in header state, return-path handling.
2. **Worker authz middleware**: JWT verify + role/ban check on the API Worker for every write endpoint (AUTH_AND_RLS §4).
3. **Reviews — submit**: `POST /api/reviews` (auth-gated; duplicate rejection; banned rejection; locale capture; `status='pending'`), the `/products/:slug/review` form, and **Perspective API toxicity scoring** (flag, never auto-reject).
4. **Reviews — display**: `GET /api/products/:slug/reviews` (paginated, approved-only) + the reviews section + ratings summary on the product detail page, with the **≥5 threshold** and **"Be the first to review"** empty state.
5. **Account + GDPR**: `/account` page and `DELETE /api/account` (anonymize reviews → `reviewer_id = null`, delete profile, delete `auth.users` row).
6. **Admin moderation (functional)**: `/admin` route guard + shell, `GET /api/admin/reviews`, `PATCH /api/admin/reviews/:id` (approve/reject + reason; toxicity surfaced; pending badge), `/admin/reviews` queue UI.
7. **Observability + checkpoint** for the above.

### 3.2 Explicitly deferred to Phase 6 (the moderation-orchestration boundary)

Phase 5 ships *functional* moderation driven directly off `review.status` + `appendAuditLog()`. The orchestration layer is Phase 6:

- **Workflow-FSM formalization** — writing `workflow_instances` / `workflow_transitions` for the `review_moderation` state machine (Phase 5 uses `review.status` transitions + audit rows; the FSM wrapper is Phase 6, alongside `vendor_claim` / `correction_request`).
- **Slack alerts** on new submissions / moderation items (`#moderation`).
- **Linear sync** / webhook (`/api/webhooks/linear`).
- **Reviewer-ban management UI** — Phase 5 *enforces* bans on submit (a banned user's `POST /api/reviews` is rejected via `is_active_user()` / `banned_at`); the admin UI to *apply* bans is Phase 6. Bans are set by SQL in the interim (§22.3).
- **"Repeat offender" prompt** (3rd rejection → suggest ban) — Phase 6.

### 3.3 Out of scope (Stage 2+)

Vendor portal / self-serve claiming; `vendor_admin` role usage; review editing after submit; helpful-votes / review reactions; rich-media in reviews.

---

## 4. Authentication

Implements `STAGE_1_SPEC.md` §8 and `AUTH_AND_RLS.md` §3–§4.

### 4.1 Library & runtime decision (Phase 5.1 — spike first)

- **SSR Worker (`apps/web`)**: `@supabase/ssr` for cookie-based session read/write (server-side, edge-compatible).
- **API Worker (`apps/api`)**: verify the Supabase JWT directly (Supabase JWKS via `jose`, or `supabase.auth.getUser(jwt)`) — **no DB round-trip for verification**; load the `profiles` role/ban with the existing privileged Prisma/Accelerate client.
- **Validate on the Workers runtime first** (no `nodejs_compat` for the DB path; confirm the auth libs are fetch-based and Workers-clean). This is the gating spike — if `@supabase/ssr` misbehaves on Workers, fall back to hand-rolled PKCE + cookie handling (the flow below is library-agnostic).
- Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (SSR + client), `SUPABASE_JWT_SECRET`/JWKS (API verify). Service-role key is **never** shipped to a Worker (writes go through privileged Prisma, not PostgREST).

### 4.2 Flow

1. An auth-gated CTA (e.g. "Submit a review") on an unauthenticated session links to `/auth/login?return=<path>`.
2. `/auth/login` offers **magic link** (email → Supabase sends link) and **Google OAuth** (Supabase OAuth).
3. Callback returns to `/auth/callback?return=<path>`; the handler exchanges the code for a session (PKCE), sets the session cookie, ensures a `profiles` row exists (the trigger already creates it; the handler is defensive), and redirects to `return` (validated to be a same-origin path — no open redirect).
4. Session token in an HTTP-only, `Secure`, `SameSite=Lax` cookie (Supabase default).

### 4.3 Session model & cache-neutrality

- Authenticated routes (`/auth/*`, `/account*`, `/products/:slug/review`, `/admin/*`) are **non-cacheable** — they already hit the `private, no-store` branch of the route classifier. **Add `/products/:slug/review` and `/admin/*` to the non-cacheable set if not already covered** by the wildcard fail-closed rule.
- The session cookie is **not** in `VISITOR_STATE_COOKIES` (only `theme` is), so it survives on non-cacheable routes. **Do not add it** to the strip list, and **never** read it inside a cacheable route's SSR render (that would poison the shared cache — §8).
- **Cacheable pages stay cache-neutral.** The product detail page remains cacheable: the approved-reviews list is public (visitor-neutral, safe to bake into cached HTML), but the **personalized CTA** ("Submit a review" / "You've already reviewed this" / "Sign in to review") **must be resolved client-side after hydration** — never baked into the cached SSR (same pattern as theme reconciliation; §8).

### 4.4 SSR session read, sign-out, header state

- The SSR Worker reads the session on non-cacheable authenticated routes to gate/redirect (`/account`, `/products/:slug/review`, `/admin/*`).
- Sign-out clears the session cookie (Supabase signOut) and redirects home.
- The header's signed-in state (avatar/menu vs "Sign in") is **client-hydrated** so the header stays cache-neutral on cacheable pages.

### 4.5 Worker authorization middleware (Phase 5.5)

Implements `AUTH_AND_RLS.md` §4 on `apps/api`:

- Extract the JWT (cookie or `Authorization: Bearer`); **verify or hard-fail `401 UNAUTHENTICATED`** (§4.1).
- Load `profiles.role` + `banned_at`; **reject banned** (`403`/`REVIEW_BANNED` for review writes) and enforce role (`403` for admin endpoints) **before** any Prisma write (§4.2).
- The privileged Prisma/Accelerate connection **bypasses RLS** — so the Worker is the real enforcement point; RLS is defense-in-depth for the PostgREST surface. The Worker sets `reviewer_id = auth.uid()` server-side (the client never supplies it).
- Audit every state-changing write via `appendAuditLog()` (§4.3).
- Reuse the existing bearer middleware pattern (`apps/api/src/lib/review-auth.ts`) as the structural model; this is the **user-session** analogue.

---

## 5. Reviews

### 5.1 Submission form (`/products/:slug/review`)

Per `STAGE_1_SPEC.md` §4.7. Unauthenticated → redirect to `/auth/login?return=/products/:slug/review`.

Fields → `SubmitReviewSchema` (`API_CONTRACTS.md` §6.6, shared Zod): overall rating (1–5, required), onboarding rating (1–5, required), title (5–100), body (50–2000), role at company (optional enum), years using (optional 0–50), would recommend (optional yes/no/maybe). **Locale captured** from the served locale.

- Built with **Signal Forms** (ADR 0009) reusing the shared Zod schema as the single validation source.
- Star ratings (radio group) and the role-at-company **select** are the **first Angular Aria controls** — this issue satisfies **AECI-133** (ADR 0010): bound via `[formField]`, token-styled, both themes, axe-clean, full keyboard support.
- On submit → `POST /api/reviews` → confirmation: "Thanks — your review will appear once moderated (usually within 24 hours)."

### 5.2 `POST /api/reviews` (Phase 5.6)

Per `API_CONTRACTS.md` §6.6. Auth-gated (§4.5). Inserts a `reviews` row with `status='pending'`, `reviewer_id = auth.uid()`, `locale`. Errors: `UNAUTHENTICATED`, `REVIEW_BANNED` (banned user), `REVIEW_DUPLICATE` (the partial unique index also enforces this at the DB), `NOT_FOUND` (product), `VALIDATION_FAILED`. `appendAuditLog()` on insert. Recompute/queue the denormalized counts only on **approval** (§5.4), not on submit.

### 5.3 Perspective API toxicity (Phase 5.7)

Per `STAGE_1_SPEC.md` §22.2. On submit, score the body via Perspective API and store `toxicity_score`. **Flag, never auto-reject** — high scores surface the review first in the queue. Failure is non-fatal: a Perspective outage logs a warning and stores `null` (the review still enters the queue). Secret: `PERSPECTIVE_API_KEY`. Score is admin-only (never in public payloads).

### 5.4 Public reviews display — `GET /api/products/:slug/reviews` (Phase 5.8)

**New endpoint (API_CONTRACTS gap filled by Phase 5.1).** Returns approved reviews only, paginated, newest-first, with no PII (no reviewer email; `display_name` or "Verified reviewer"). The `ProductDetail` payload additionally embeds the **summary** (`review_count`, `rating_overall_avg`, `rating_onboarding_avg` from the denormalized columns) + the first page for SSR. Shape (to be added to `API_CONTRACTS.md`):

```typescript
export type PublicReview = {
  id: string;
  rating_overall: number;
  rating_onboarding: number;
  title: string;
  body: string;
  role_at_company: string | null;
  years_using: number | null;
  would_recommend: 'yes' | 'no' | 'maybe' | null;
  verified_work_email: boolean;
  created_at: string;
};
export type ProductReviewsResponse = PaginatedResponse<PublicReview>;
```

Cacheable (public, approved-only). On approval/rejection the product's review tags are purged (Cache-Tag).

### 5.5 ≥5 threshold, empty state, personalized CTA

- **≥5 threshold (confirmed):** individual approved reviews are **always** shown; the **numeric rating averages are hidden until ≥5 approved reviews** exist for the product (a single-review average is statistically misleading). Below 5: show the reviews + a "Ratings shown once this product has 5+ reviews" note; at 0: the **"Be the first to review"** empty state.
- **Personalized CTA** ("Submit a review" / "You've already reviewed" / "Sign in to review") is **client-hydrated** post-load, never baked into the cached SSR (§4.3, §8).

---

## 6. Account & GDPR

### 6.1 `/account` (Phase 5.11, frontend)

Non-cacheable, auth-gated. Shows the user's profile (display name, email — read-only from the session), theme preference (already wired), their submitted reviews + statuses, sign-out, and the **Delete account** action (confirmation step).

### 6.2 `DELETE /api/account` (Phase 5.11, backend)

Per `API_CONTRACTS.md` §6.8 and `AUTH_AND_RLS.md` §8 (right-to-erasure). In one transaction: set `reviewer_id = null` on all of the user's reviews (anonymize, content survives — the `SetNull` FK already supports this), delete the `profiles` row, then delete the `auth.users` row via the Supabase Auth Admin API. `appendAuditLog()` records the erasure (actor = the user; no PII in the log). Errors: `UNAUTHENTICATED`. **The Loops confirmation email is deferred to Phase 7** (Loops setup is Phase 7) — log a stub/TODO; do not block deletion on email.

---

## 7. Admin moderation (functional; orchestration → Phase 6)

### 7.1 `/admin` guard + shell (Phase 5.12)

`/admin/*` is non-cacheable and gated on `role === 'admin'` (session → profile role; §4.5). Non-admins get 404 (don't reveal the surface). Minimal shell + nav with a **pending-count badge**.

### 7.2 Admin reviews API (Phase 5.13)

Per `API_CONTRACTS.md` §6.10:
- `GET /api/admin/reviews` — `ListPendingReviewsQuerySchema` (status `pending|approved|rejected`, sort `queue_age|created_at`, paginated). `AdminReview` includes `toxicity_score` and `reviewer_email` (admin-only).
- `PATCH /api/admin/reviews/:id` — `ModerateReviewSchema` (`approve`/`reject` + optional `rejection_reason`). `INVALID_STATE_TRANSITION` if not `pending`. On **approve**: set `status='approved'`, `moderated_by/at`, recompute the product's denormalized `review_count` + rating averages, purge the product Cache-Tag. On **reject**: `status='rejected'` + required reason. `appendAuditLog()` on every transition. (Slack/Linear/FSM → Phase 6.)

### 7.3 `/admin/reviews` queue UI (Phase 5.14)

Per `STAGE_1_SPEC.md` §22.1: pending list (product, reviewer email, timestamp, queue age, full content, toxicity score), one-click approve/reject, **required** rejection-reason field, sortable by queue age/product/reviewer, pending-count badge. No Slack (Phase 6). Signal Forms + Aria; both themes; axe-clean.

---

## 8. Caching & SSR rules (the non-negotiable)

- Authenticated routes are non-cacheable and `private, no-store`. Confirm `/products/:slug/review` and `/admin/*` are classified non-cacheable.
- The session cookie is preserved (never stripped) on non-cacheable routes and **never read** inside a cacheable render.
- Cacheable pages (home, product detail) render **visitor-state-neutral** HTML. The approved-reviews list is public and may be SSR'd into the cached page; the **personalized review CTA and the signed-in header state hydrate client-side** after load.
- Review approval/rejection purges the affected product's Cache-Tag so the public reviews list + summary refresh before TTL.

---

## 9. Observability (Phase 5.15)

Parity with AECI-66 (Phase 2) / AECI-141 (Phase 3) / AECI-180 (Phase 4). Metrics (`aeci.*`): sign-in attempts/success/failure (by method), review submit count, moderation actions (approve/reject), Perspective API latency/error rate. Alerts: auth error-rate spike, Perspective outage, moderation-queue age. Dashboard group "Phase 5 — Auth/Reviews"; runbook entries.

---

## 10. Testing

- **RLS integration tests** (extend the AECI-90 harness): anon sees only approved reviews; owner sees own pending; admin sees all; no anon/authenticated write grant.
- **Worker authz unit/integration**: unauthenticated write → 401; banned → rejected; non-admin → 403 on admin endpoints; `reviewer_id` is server-set (client cannot spoof).
- **Duplicate**: second review for same product → `REVIEW_DUPLICATE` (and the partial unique index holds under race).
- **e2e**: full login → submit → moderate → public-display flow; account delete anonymizes reviews. axe on every new form/page; keyboard-only pass on the review form (§21.3). No console errors (AECI-162 crawler extends to the new pages).

---

## 11. Companion-doc reconciliations (land with Phase 5.1)

- **`CLAUDE.md`**: correct the source-of-truth row — `AUTH_AND_RLS.md` is **complete**, not a placeholder; add `STAGE_1_PHASE_5_SPEC.md` to the index.
- **`API_CONTRACTS.md`**: add the public `GET /api/products/:slug/reviews` shape (§5.4) and note the `ProductDetail` reviews-summary embed.
- **`STAGE_1_SPEC.md` §16 Phase 5**: expanded to the 5.1–5.16 breakdown + the Phase 5/6 moderation boundary (§3.2).

---

## 12. Phase 6 handoff

Phase 6 ("Requests & moderation") inherits: the review-moderation **FSM** (`workflow_instances`/`workflow_transitions`), **Slack** alerts, **Linear** webhook/sync, the **ban management UI**, and the **admin requests** views (`GET /api/admin/requests` — vendor claims/corrections, whose forms already shipped in Phase 2/AECI-128). Note: §16 Phase 6's "claim/correction form + n8n" is largely done (forms shipped Phase 2; **n8n is dropped** — it's a Cloudflare Worker per Phase 2 Spec §18.1).

---

## 13. Issue breakdown (AECI Phase 5.1–5.16)

| # | Issue | Depends on |
|---|---|---|
| 5.1 | Write this spec + reconcile AUTH_AND_RLS/CLAUDE/API_CONTRACTS (reviews-list endpoint) | — |
| 5.2 | Supabase Auth spike + client wiring (`@supabase/ssr` + API JWT verify; deps; secrets) | 5.1 |
| 5.3 | `/auth/login` (magic link + Google OAuth, return-path) | 5.2 |
| 5.4 | `/auth/callback` handler (code exchange, session cookie, profile-ensure, safe redirect) | 5.2 |
| 5.5 | API Worker authz middleware (JWT verify + role/ban; AUTH_AND_RLS §4) | 5.2 |
| 5.6 | `POST /api/reviews` (dedup, banned, locale, pending) | 5.5 |
| 5.7 | Perspective API toxicity scoring (flag-not-block) | 5.6 |
| 5.8 | `GET /api/products/:slug/reviews` + ProductDetail summary + ≥5 | 5.1 |
| 5.9 | Review submission form `/products/:slug/review` (Signal Forms + Aria — satisfies AECI-133) | 5.3, 5.6 |
| 5.10 | Reviews display on product page (list, summary gate, empty state, cache-neutral CTA) | 5.8, 5.4 |
| 5.11 | `/account` + `DELETE /api/account` GDPR flow | 5.4, 5.5 |
| 5.12 | `/admin` route guard + shell (role check, pending badge) | 5.5 |
| 5.13 | Admin reviews API (`GET` + `PATCH /api/admin/reviews/:id`) | 5.5 |
| 5.14 | `/admin/reviews` moderation queue UI | 5.12, 5.13 |
| 5.15 | Auth/reviews observability | 5.6, 5.13 |
| 5.16 | Phase 5 completion checkpoint | all |
