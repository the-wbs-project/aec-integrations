# Phase 5 Completion Report

**Issue:** [AECI-207](https://linear.app/aec-integrations/issue/AECI-207) — Phase 5.16, Phase 5 completion checkpoint
**Spec anchor:** `docs/STAGE_1_PHASE_5_SPEC.md` (all) + `docs/STAGE_1_SPEC.md` §16 Phase 5 (acceptance, lines 1065–1077). Phase 5 = Auth & reviews. Companion contracts: `AUTH_AND_RLS.md` §4 (authz layers), `API_CONTRACTS.md` §4/§6 (review + account + admin endpoints), `DATABASE_SCHEMA.md` (reviews/profiles + RLS), `OBSERVABILITY.md` §"AECi Phase 5".
**Mirrors:** [AECI-67](https://linear.app/aec-integrations/issue/AECI-67) (Phase 2 gate), [AECI-146](https://linear.app/aec-integrations/issue/AECI-146) (Phase 3 gate), [AECI-187](https://linear.app/aec-integrations/issue/AECI-187) (Phase 4 gate).
**Evaluated against:** the working tree on `chris/aeci-207-…`, branched from `origin/main` @ `23d2fa5` (AECI-206, the last Phase 5 merge). · **Date:** 2026-06-12 (UTC)

This is the "Phase 5 is Done" gate. Like the Phase 2/3/4 gates it **surfaces** open items rather
than silently closing them: every AECI-207 acceptance line and every §16 Phase 5 build-order
bullet is mapped to ✅ Done / ⚠️ Partial / ❌ Outstanding with concrete file:line evidence, and
each non-green item carries either a follow-up issue or an explicit written punt.

**Prerequisites met:** the Phase 2/3/4 gates are closed; Phase 5 inherits their axe/Lighthouse CI
wiring (AECI-65), the console-health harness (AECI-162), and the AECI-90 integration-test stack it
extends. The data layer (profiles, reviews + moderation columns, RLS, `is_admin()`/`is_active_user()`,
audit log, `handle_new_user`) pre-existed Phase 5 (§16 note) — Phase 5 was app code, ~zero migrations.

---

## 1. Verdict

**Phase 5 is functionally complete and shippable.** All fifteen Phase 5 build issues
(5.1–5.15 = AECI-192…AECI-206) are merged to `main`. Auth ships magic-link + Google OAuth with a
PKCE `/auth/callback`, SSR session read, and sign-out (5.2–5.4); the API Worker enforces a
fail-closed JWKS JWT verify + role/ban middleware before every write (5.5); `POST /api/reviews`
inserts a `pending` review with app-level + partial-unique-index dedup (`409 REVIEW_DUPLICATE`),
banned rejection (`403 REVIEW_BANNED`), server-resolved locale, Perspective toxicity **flag-not-block**
scoring, and a same-transaction audit row (5.6–5.7); `GET /api/products/:slug/reviews` returns
approved-only, PII-free, paginated reviews and a ProductDetail summary gated at ≥5 (5.8); the review
form is the project's **first Angular Aria form** (Signal Forms + Aria listbox/combobox, satisfies
AECI-133) (5.9); the product page shows the list, the ≥5 averages gate, a "Be the first to review"
empty state, and a **cache-neutral** personalized CTA (5.10); `/account` + `DELETE /api/account`
performs single-transaction GDPR erasure (anonymizes reviews, nulls the six `NO ACTION` FKs, deletes
the profile, deletes `auth.users`) (5.11); admin moderation ships the `/admin` gate + pending-badge
shell, `GET`/`PATCH /api/admin/reviews` (approve → recompute counts + purge `product:<slug>`; reject →
required reason), and the `/admin/reviews` queue UI (5.12–5.14); and observability adds the
`aeci.auth.signin` / `aeci.review.submit` / `aeci.moderation.*` metrics plus a Datadog
dashboard + monitors (5.15). All Phase 5 surfaces are token-only, i18n-wrapped, light-only (AECI-226),
and have shipped e2e + unit/integration specs.

**Repo-checkable gates run for this report — all green:**

| Gate | Result |
|------|--------|
| `pnpm lint` (ESLint ×4 packages + `check-logical-properties` + Prettier) | ✅ exit 0 · "All matched files use Prettier code style!" · no physical-direction utilities |
| `ng extract-i18n` (verification only — **not** committed) | ✅ exit 0 · **536 messages** · **zero duplicate-id warnings** (after the §4.2 fix) · committed `src/locale/messages.xlf` untouched |
| Angular AOT build (run by `extract-i18n`) | ✅ exit 0 · "Application bundle generation complete" — a template-aware compile of every Phase 5 component |
| `tsc -p apps/web/tsconfig.app.json --noEmit` | ✅ no type errors (modulo the documented `@aeci/shared` re-export / `$localize` build-config noise) |
| `npx impeccable detect` (auth, reviews, account, admin, product-reviews) | ✅ exit 0 · zero findings, zero P0 |
| Hardcoded color literals on Phase 5 components | ✅ none — semantic tokens / CSS-vars only |

The only items **not** green are (a) **deployed-environment confirmations** — the live staging
login→submit→moderate→display→delete flow, axe/Lighthouse on the auth-gated pages, and the live
Datadog apply — bundled into **[AECI-233](https://linear.app/aec-integrations/issue/AECI-233)**
(the Phase 5 analogue of AECI-222), and (b) two **test-harness coverage gaps** the acceptance asks
to close: a reviews/profiles RLS deny-matrix spec
(**[AECI-234](https://linear.app/aec-integrations/issue/AECI-234)**, extends AECI-90) and
authed-page console coverage (**[AECI-235](https://linear.app/aec-integrations/issue/AECI-235)**,
extends AECI-162). None is a Phase 5 *build* defect.

Two **green-closing edits** were made in this issue (see §4): DESIGN.md gained an "Auth & Reviews
(Phase 5)" component subsection (it had none), and a duplicate-i18n-id warning introduced in
`product-reviews.html` was fixed.

---

## 2. Acceptance checklist

### 2a. AECI-207 acceptance criteria

| AC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| 1 | Every §16 Phase 5 item + Phase-5-spec acceptance verified → produce `docs/PHASE_5_COMPLETION.md` | ✅ | This document. Per-bullet mapping in §2b; all 15 build issues (AECI-192…206) merged to `main`. |
| 2 | **E2E on staging**: login (magic link + Google) → submit → moderate (approve/reject) → public ≥5 display → account delete anonymizes reviews | ⚠️ | **Code + local e2e ✅, live staging ⚠️.** Callback `apps/web/src/server/routes/auth-callback.ts` (PKCE exchange, session cookie, profile-ensure, safe redirect); submit `apps/api/src/routes/reviews.ts` (pending + dedup + toxicity + audit); moderate `apps/api/src/routes/admin-reviews.ts` (approve→recompute+purge / reject→required reason); ≥5 gate `apps/web/src/app/products/product-reviews.ts:69-71`; erasure `apps/api/src/routes/account.ts:208-` (reviews `reviewer_id→NULL`, `auth.users` delete). e2e: `reviews-submission.spec.ts`, `admin-reviews.spec.ts`, `account-delete.spec.ts`, `product-reviews.spec.ts`. **Live run needs a deployed env + real auth → [AECI-233](https://linear.app/aec-integrations/issue/AECI-233).** |
| 3 | **Authz**: unauthenticated / banned / non-admin rejected; RLS integration tests green in CI (extend AECI-90) | ⚠️ | **Worker authz ✅ + tested; RLS deny-matrix ⚠️.** `apps/api/src/lib/user-auth.ts` (JWKS verify, fail-closed `401 UNAUTHENTICATED`); `apps/api/src/lib/authz.ts` `requireAuth` (`:224`) / `requireAdmin` (`:235`), banned → `403` (`REVIEW_BANNED`/`FORBIDDEN`, `:202-205`). Specs: `user-auth.jwks.spec.ts`, `auth_user_delete_trigger.spec.ts`, `account_delete.spec.ts`, `auth_users_email_read.spec.ts`. RLS policies exist (`supabase/migrations/20260602051513_rls_grants_and_policies.sql:297-333`) but have **no PostgREST deny-matrix spec** (AECI-90 covers only `landing_forms`/`vendor_requests`) → **[AECI-234](https://linear.app/aec-integrations/issue/AECI-234).** |
| 4 | **Cache-neutrality**: product page's cached HTML carries no session/CTA; auth routes non-cacheable | ✅ | `apps/web/src/app/reviews/review-cta.ts` renders a neutral "Write a review" at SSR and reconciles to `anon`/`authed` in `afterNextRender` only. The route classifier marks `/products/:slug/review` (`server-runtime.ts:167`), `/account` (`:176`), `/admin/*` (`:187`), and `/auth/*` non-cacheable → `private, no-store` (`:460`); unknown routes fail closed. Edge MISS→HIT is deployed-only (§5, Note C). |
| 5 | `ng extract-i18n` **verification** (no hard-coded strings; do **not** commit a regenerated `messages.xlf`) | ✅ | Ran to a temp path: **exit 0, 536 messages, zero duplicate-id warnings** after the §4.2 fix (two `products.detail.reviews.*` ids previously collided on whitespace-different sources). Committed `src/locale/messages.xlf` **untouched** (`git status` clean — en-US source-string convention upheld). Every Phase 5 string is `i18n`/`$localize`-wrapped. |
| 6 | Monorepo lint clean; zero color literals; axe + Lighthouse budgets on the new pages; no console errors (AECI-162 crawler extended) | ⚠️ | **lint + color ✅; authed-page axe/LH + console ⚠️.** `pnpm lint` exit 0; zero color literals (tokens only). Public Phase 5 page covered: `auth-login.spec.ts` console-checks `/auth/login`, and the crawler already lists `/auth` as an `EXPECTED_PENDING_PREFIXES` entry (`internal-link-graph.spec.ts:221`). **axe + Lighthouse on the auth-gated pages** (review/account/admin) need a session → [AECI-233](https://linear.app/aec-integrations/issue/AECI-233); **authed-page console** coverage → **[AECI-235](https://linear.app/aec-integrations/issue/AECI-235).** |
| 7 | `DESIGN.md` updated with every new component | ⚠️ | **DESIGN.md updated in this issue (§4.1)** — new "Auth & Reviews (Phase 5)" subsection documenting all eight components (login, review form, star control, star display, reviews list, cache-neutral CTA, account, admin shell, moderation queue), token-only + i18n. The **per-component `/impeccable` craft/polish history or Chris's explicit sign-off is a human gate** this report can't self-certify — flagged in §6. |
| 8 | Outstanding items get a follow-up Phase 5.x issue or an explicit written punt | ✅ | Three follow-ups filed + assigned to Chris: **[AECI-233](https://linear.app/aec-integrations/issue/AECI-233)** (operational verification), **[AECI-234](https://linear.app/aec-integrations/issue/AECI-234)** (RLS deny-matrix), **[AECI-235](https://linear.app/aec-integrations/issue/AECI-235)** (authed-page console). Written punts in §3. |

### 2b. §16 Phase 5 build-order bullets

| §16 bullet | Issue(s) | Status | Evidence |
|-----------|----------|--------|----------|
| Supabase Auth (magic link + Google OAuth): `/auth/login`, `/auth/callback`, SSR session read, sign-out | AECI-193/194/195 | ✅ | `apps/web/src/app/auth/login.ts` (`aec-login-page`, magic + Google + validated return); `apps/web/src/server/routes/auth-callback.ts` (PKCE exchange, session cookie, profile-ensure, safe redirect, `aeci.auth.signin`); `auth.service.ts` `signOut()`; `/auth/*` non-cacheable (`server-runtime.ts:43`). |
| API Worker authz middleware (JWT verify + role/ban; `AUTH_AND_RLS.md` §4) | AECI-196 | ✅ | `apps/api/src/lib/user-auth.ts` (`createRemoteJWKSet` verify, fail-closed `401`); `apps/api/src/lib/authz.ts` `requireAuth`/`requireAdmin`, ban → `403` (`:202-205`), `auditActorType` (`:172`). Tests `user-auth.jwks.spec.ts`. |
| `POST /api/reviews` (dedup, banned rejection, locale) + Perspective toxicity flagging | AECI-197/198 | ✅ | `apps/api/src/routes/reviews.ts` (`requireAuth` `REVIEW_BANNED`, `status='pending'`, dedup `reviews_unique_per_user_product` → `409 REVIEW_DUPLICATE` `:148`, locale via `x-aeci-locale`, `scoreToxicity` flag-not-block `:49,:163`, `appendAuditLog` same-tx); `apps/api/src/lib/perspective.ts`. Tests `reviews.spec.ts`. |
| `GET /api/products/:slug/reviews` (public, approved-only) + ProductDetail summary + ≥5 threshold | AECI-199 | ✅ | `apps/api/src/routes/product-reviews.ts` (approved-only, paginated, `PublicReview` no PII, `product:<slug>` tag); ProductDetail embed; component gate `apps/web/src/app/products/product-reviews.ts:69-71`. |
| Review submission form `/products/:slug/review` (Signal Forms + Angular Aria — satisfies AECI-133) | AECI-200 | ✅ | `apps/web/src/app/reviews/review-form.ts` (`aec-review-form`, Aria `Listbox`/`Combobox` `:2-3`, first Aria form, Signal Forms + `SubmitReviewSchema`). |
| Reviews display + "Be the first to review" empty state + cache-neutral personalized CTA | AECI-201 | ✅ | `product-reviews.html` (empty state `:13-19`, threshold note `:48-51`, averages `:20-47`); `apps/web/src/app/reviews/review-cta.ts` (neutral SSR → `afterNextRender` `anon`/`authed`). |
| `/account` + `DELETE /api/account` (GDPR anonymization; Loops email deferred to Phase 7) | AECI-202 | ✅ | `apps/api/src/routes/account.ts` (single-tx DELETE: `reviews.reviewer_id→NULL`, six `NO ACTION` FKs nulled `:222-224`, `account.deleted` audit `actorId:null` `:36`, delete profile, raw `DELETE FROM auth.users`); `apps/web/src/app/account/account.ts` (`aec-account-page`, Spartan delete dialog). Loops email → Phase 7 (noted, §5). |
| Admin moderation: `/admin` guard, `GET`/`PATCH /api/admin/reviews`, `/admin/reviews` queue UI | AECI-203/204/205 | ✅ | `apps/web/src/app/admin/admin-shell.ts` (gate, non-admin → 404 surface, live pending badge via `AdminSummaryStore`); `apps/api/src/routes/admin-summary.ts` (`GET` count); `apps/api/src/routes/admin-reviews.ts` (`GET` pending + toxicity + `reviewer_email` via parameterized `$queryRaw`; `PATCH` approve→`recomputeProductCounts`+`callCloudflarePurge` / reject→required reason; audit same-tx); `apps/web/src/app/admin/reviews/review-queue.ts` (`aec-review-queue`, sortable, one-click, reject reason). |
| Auth/reviews observability + Phase 5 completion checkpoint | AECI-206 / AECI-207 | ✅ | `aeci.auth.signin` (`auth-callback.ts`), `aeci.review.submit` (`reviews.ts:156`), `aeci.moderation.*` / `aeci.perspective.*` (`docs/OBSERVABILITY.md:126-145`); `observability/datadog/dashboard-auth-reviews.json` + `monitor-auth-error-rate.json` (+ queue-age / Perspective monitors); `OBSERVABILITY.md:239` "AECi Phase 5 — Auth / Reviews". Checkpoint = this doc. **Live apply → [AECI-233](https://linear.app/aec-integrations/issue/AECI-233).** |

**Score: AC — 4 ✅ / 4 ⚠️ · §16 bullets — 9 ✅ / 0 ⚠️ / 0 ❌.** Every ⚠️ is a deployed-env
confirmation (AECI-233), a named harness-coverage gap (AECI-234 / AECI-235), or a human design
sign-off — not a Phase 5 build defect.

---

## 3. Outstanding items — follow-ups & punts

### F1 — Phase 5 operational verification → **new [AECI-233](https://linear.app/aec-integrations/issue/AECI-233)**

Everything in AECI-207's "E2E on staging" / "axe + Lighthouse on the new (auth-gated) pages" /
"live Datadog apply" that needs a **deployed environment + real auth** is bundled here (the Phase 5
analogue of AECI-222 for Phase 4, AECI-161 for Phase 2). The code + config is merged and green; what
remains is live confirmation: the staging login (magic link **and** Google) → submit → approve/reject
→ public ≥5 display → account-delete-anonymizes flow; the banned/non-admin/anon deny paths observed
live; axe + Lighthouse on `/products/:slug/review`, `/account`, `/admin`, `/admin/reviews` against a
deployed origin with a session; and applying `dashboard-auth-reviews.json` + the AECI-206 monitors to
the live Datadog org with the dashboard URL pasted into `docs/OBSERVABILITY.md`.

> **Runbook + sign-off:** [`docs/PHASE_5_OPERATIONAL_VERIFICATION.md`](./PHASE_5_OPERATIONAL_VERIFICATION.md)
> holds the step-by-step procedure (Parts A–D) and the per-AC sign-off tables for the live run.
> AECI-233 also pre-fixed the `dashboard-auth-reviews.json` `reflow_type` defect (`fixed` → `auto`)
> so the Datadog apply doesn't reject the way AECI-222's first attempt did.

### F2 — Reviews/profiles RLS deny-matrix → **new [AECI-234](https://linear.app/aec-integrations/issue/AECI-234)** (extends AECI-90)

Phase 5 authz is enforced and tested at the **Worker layer** (`requireAuth`/`requireAdmin` + JWKS
verify; the `user-auth.jwks` / `auth_user_delete_trigger` / `account_delete` / `auth_users_email_read`
integration specs). The **RLS layer** for `reviews`/`profiles` (defense-in-depth — all app traffic
goes through Prisma Accelerate's privileged role, which bypasses RLS) has policies
(`…rls_grants_and_policies.sql:297-333`) but **no PostgREST deny-matrix spec**; the AECI-90 harness
covers only `landing_forms` and `vendor_requests`. AECI-234 adds `reviews.rls.spec.ts` +
`profiles.rls.spec.ts` mirroring `vendor_requests.rls.spec.ts`; they auto-enroll via the
`integration-db-tests.yml` `apps/api/src/integration/**` path-gate. **No new test code lands in this
checkpoint PR** (matching the Phase 4 gate's zero-app/test-code posture).

### F3 — Authed-page console coverage → **new [AECI-235](https://linear.app/aec-integrations/issue/AECI-235)** (extends AECI-162)

The console-health crawler reaches every public page and `auth-login.spec.ts` covers `/auth/login`,
but the **auth-gated** pages (`/account`, `/admin/*`, `/products/:slug/review`) can't be
BFS-crawled or console-checked from a hydrated render without a real session. AECI-235 adds an
authenticated Playwright context and extends `console-capture.ts` to those routes.

### Not a defect — deferred-to-Phase-6 / Phase-7 items are spec'd, not missed

Per `STAGE_1_PHASE_5_SPEC.md` §3.2 and §16, the following are **intentionally** out of Phase 5 and
are not gaps: the workflow-FSM formalization (`workflow_instances`/`workflow_transitions`), Slack
alerts, Linear sync, and the reviewer **ban-management UI** all move to Phase 6 (enforcement-on-submit
ships in Phase 5); the Loops account-deletion confirmation email moves to Phase 7; and the
`GET /api/account/reviews` list + the "You've already reviewed" CTA state are deferred (the CTA ships
its `anon`/`authed` states now). The ≥5 averages are additionally null'd **server-side** in
`toProductDetail`, so the component's ≥5 gate is belt-and-braces, not the sole guard.

---

## 4. Work done in this issue

### 4.1 DESIGN.md: added the "Auth & Reviews (Phase 5)" component subsection

DESIGN.md §5 ended at "Home (Phase 4)" with **no** subsection for the Phase 5 surfaces — the same gap
the Phase 3/4 gates closed for search/home. Added an **"Auth & Reviews (Phase 5)"** subsection
documenting all eight components: `<aec-login-page>`, `<aec-review-form>` (the first Angular Aria
form — listbox star controls + combobox), `<aec-review-stars>` (read-only display), `<aec-product-reviews>`
(the ≥5 gate + empty state), `<aec-review-cta>` (cache-neutral), `<aec-account-page>` (GDPR delete
dialog), `<aec-admin-shell>` (gate + live pending badge), and `<aec-review-queue>` (sortable
moderation queue). Token-only color, full i18n, light-only (AECI-226), forms per ADR 0009 (Signal
Forms) + the proposed Angular Aria ADR. Prettier-clean.

### 4.2 `product-reviews.html`: fixed two duplicate-i18n-id warnings

`ng extract-i18n` reported two duplicates: `@@products.detail.reviews.overall` and
`@@products.detail.reviews.onboarding` were each used in **two** places with **whitespace-different**
source text — the summary `<p>` (" Overall " / " Onboarding ") and the per-review breakdown `<span>`
("Overall" / "Onboarding"). Same id, different source → an extractor warning and an ambiguous
translation unit. Renamed the per-review breakdown labels to distinct `@@products.detail.reviews.item.overall`
/ `…item.onboarding` ids (the two contexts — summary-average label vs per-review label — are
legitimately separate units). Re-extraction is warning-free. Per the stale-`messages.xlf` convention
(en-US builds from source strings), the committed `messages.xlf` is **not** regenerated.

_(No application logic, schema, API, or component behavior was changed in this issue — Phase 5 build
work shipped in AECI-192…206. This gate added the DESIGN.md subsection, the i18n-id hygiene fix above,
and this report.)_

---

## 5. Notes & known debt

- **Note A — environment data + live apply is operational.** As with the Phase 2/3/4 gates, "the
  staging flow works" / "monitors live" / "axe/LH on authed pages" describe the shipped *capability*
  and its tests; the deployed-env behavior is tracked in **AECI-233**. Per memory, the running app
  (local `dev:bound` + all CI e2e) reads the shared `aeci-development` DB via Accelerate.
- **Note B — graceful/empty states are first-class.** The reviews section renders a "Be the first to
  review" empty state, a "ratings shown at 5+" threshold note, and a neutral cache-safe CTA; the login
  page renders cleanly even when Supabase is unconfigured; the moderation email lookup degrades to
  `reviewer_email: null` rather than 500. Pre-launch sparse data renders cleanly, not as errors.
- **Note C — edge-cache observation is deployed-only.** The product page's cache-neutrality is
  unit/e2e-asserted (`review-cta` SSR default, route classifier), but the actual MISS→HIT + cookie-strip
  behavior is only observable against a deployed CF edge (Miniflare's `caches.default` ≠ the edge) —
  same caveat as Phase 2/3/4.
- **`--text-tertiary` contrast — resolved at the token level (AECI-230).** The previously-failing
  `--text-tertiary` was re-pointed to `#71717A` (4.83:1) on 2026-06-12; Phase 5 components that use it
  for disabled/least-emphasis text now pass AA. (The standing rule — tertiary never on sunken/muted —
  still applies.)
- **Light-only (AECI-226).** Phase 5 components ship a single light theme; dark returns with the
  Stage 2 vendor portal. No `dark:` variants were added.
- **Build noise (non-blocking).** `ng extract-i18n` prints "File not found in TypeScript compilation"
  notes for the `packages/shared/src/**` re-exports (bundled correctly, outside the web tsconfig
  program) — documented since AECI-67; build-config notes, not i18n/runtime issues. `tsc` against the
  Angular app tsconfig also needs `--noEmit` to avoid a TS5011 rootDir *emit*-layout complaint (not a
  type error).

---

## 6. Design sign-off (AECI-187 / AECI-146 / AECI-67 convention)

- The Phase 5 surfaces were built through the v0 → Angular workflow, reusing the established catalog
  token + type vocabulary so the signed-in experience reads as the **same publication** as the public
  directory (the Anchor-Site Rule). Unlike the home surface (which recorded a Faire anchor in
  `docs/design/home-direction.md`), Phase 5 has **no dedicated design-direction doc / recorded Mobbin
  anchor** — the surfaces are forms and admin tooling assembled from existing tokens and the Angular
  Aria primitives (ADR 0009 / the Aria ADR). If Chris wants a recorded anchor for the auth/account/admin
  surfaces, that's a small follow-up; it is **not** an AECI-207 blocker.
- DESIGN.md now documents every shipped Phase 5 component (§4.1), token-only color, full i18n,
  light-only.
- a11y: the review form is the first Angular Aria form (roving-tabindex listboxes + combobox);
  `<aec-review-stars>` keeps glyphs `aria-hidden` and announces the value via `aria-label`;
  `auth-login.spec.ts` asserts a real `<label for>` and console cleanliness. `impeccable detect` on the
  Phase 5 dirs returns zero findings. Full axe AA on the **authed** pages rides AECI-233 (needs a session).
- The **formal `/impeccable` craft + polish history per component, or Chris's explicit sign-off, is a
  human gate** this report can't self-certify — flagged for Chris to confirm.

---

## 7. Hand-off

**Follow-ups filed** (created alongside this report, Stage 1 Build, assigned to Chris):

- **F1** → [AECI-233](https://linear.app/aec-integrations/issue/AECI-233) — Phase 5 operational
  verification: deployed staging E2E (magic link + Google → submit → moderate → ≥5 display → delete
  anonymizes), authed-page axe + Lighthouse, live Datadog auth/reviews apply.
- **F2** → [AECI-234](https://linear.app/aec-integrations/issue/AECI-234) — reviews/profiles RLS
  deny-matrix integration tests (extends the AECI-90 harness).
- **F3** → [AECI-235](https://linear.app/aec-integrations/issue/AECI-235) — authed-page console
  coverage (extends the AECI-162 crawler).

**Already tracked:** [AECI-222](https://linear.app/aec-integrations/issue/AECI-222) /
[AECI-161](https://linear.app/aec-integrations/issue/AECI-161) — the Datadog live-apply carryover to
coordinate the Phase 5 dashboard/monitor apply with. [AECI-188](https://linear.app/aec-integrations/issue/AECI-188)
/ [AECI-65](https://linear.app/aec-integrations/issue/AECI-65) — the global Lighthouse warn→error
enforcement flip the auth-gated pages join once they're measurable (AECI-233).

**Ready to mark Phase 5 Done** once Chris confirms:

1. The deployed-env operational items (AECI-233) are acceptable to verify post-merge, not as a build
   blocker (matches how Phase 2/4 deferred their live apply to AECI-161 / AECI-222).
2. The two harness-coverage gaps (AECI-234 RLS deny-matrix, AECI-235 authed console) are acceptable as
   tracked follow-ups rather than in-checkpoint work (matches the Phase 4 zero-app/test-code posture).
3. The design sign-off in §6 (per-component craft/polish history or explicit sign-off; optionally a
   recorded anchor for the Phase 5 surfaces).
