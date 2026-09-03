# Stage 2 — Demo Test Plan

**Purpose:** what to exercise on `demo.aecintegrations.com` after `stage-2` merges to `main`
and is promoted, before production. Derived from the actual tree delta
`origin/main..origin/stage-2` (760 files) at `4c23496a`, not from the issue list.

**Status:** working checklist for the Stage 2 promote. Delete or archive once demo is signed
off — this is not a source-of-truth doc and is deliberately absent from the `CLAUDE.md` table.

**The shape of the risk.** Stage 2 is a **dark launch**: the vendor portal ships live but inert
behind three locks (session → admin-approved seat → admin-set entitlements). So the vendor
surface is mostly *unreachable* by design, and the real exposure is the **public catalog
regressions** the connector lane introduced. Weight your time accordingly: §3 is where a defect
reaches a real user, §5 is where it reaches nobody yet.

---

## 1. Before you promote — blockers

- [ ] **`stage-2` does not contain AECI-659 (#619).** `main` gained the WAF host-set extension
      after `stage-2`'s last commit. Reconcile `main → stage-2` **first**, or the merge reverts
      the production WAF rules and the ops scripts under `scripts/ops/2026-09-waf-host-scope/`.
      This shows in the diff as a deletion — it is the single most damaging thing in this merge.
- [ ] **Merge conflict to resolve deliberately in `docs/waf-rate-limits.md`.** `#619` rewrote the
      doc and **dropped §3a** (the `/vendor/` managed-rule collision recipe). Keep §3a on the
      merged result — that rule lives in a Cloudflare-managed ruleset we do not version and can
      re-fire. Its corrected text is on `chris-walton-wbs/planning---stage-2`, not on `stage-2`.
- [ ] **Eight migrations apply to demo D1** (`0021`–`0028`). Census before and after.
- [ ] **`0027_powerful_killraven` recreates `integrations`.** It is safe *because* it carries
      claims/attestations through `__carry_*` tables — but take a row census of `integrations`,
      `claims` and `attestations` before and after and confirm they match. A regenerated `0027`
      destroys ~1,697 claims and ~1,697 attestations.

## 2. Environment caveats — things demo cannot tell you

Read these before concluding anything from a demo result.

| Caveat | Consequence |
|---|---|
| **Demo runs uncached** — no `exports` block in `apps/web/wrangler.jsonc` (only `preview` and `staging` have one) | Cache-tag emission, TTLs, `MISS → HIT`, and stale-while-revalidate are **not testable here**. A cache defect will not appear on demo and will appear in production only if prod is later switched on. Verify caching on a PR preview instead. |
| **Datadog is gone on this line (AECI-651)** | Demo stops writing to Datadog the moment it is promoted. PostHog is the only plane. If a dashboard goes quiet, that is expected, not an incident. |
| **PostHog project split** | Demo's SSR key is the **non-prod** project (`phc_pY8F…`, 525793); only production uses `phc_Ka6z…` (354071). AECI-754 is still in flight for the remaining axis — confirm demo test traffic is not landing in the production project before you generate volume. |
| **Internal-user exclusion is not configured** | Your own testing will appear in PostHog product analytics while `page_views` excludes it by admin session. The two surfaces will disagree; that is a known gap, not a bug. |
| **Two new crons** (10:00 UTC attestation detector sweep, 11:00 UTC entitlement term-expiry sweep) | Both send real email via Resend. Know this before leaving demo running overnight. |
| **No connector data flows yet** | The first production connector-catalogue sync is AECI-764 and has not run. Connector surfaces render from whatever demo's D1 holds. |

---

## 3. Public catalog — the regression surface (spend most of your time here)

This is what real users see and where the connector lane made structural changes.

### 3.1 Product detail — the Integrations split (AECI-713)
- [ ] An endpoint product's Integrations section splits into a **direct** list and **"Via {connector}"** groups.
- [ ] Direct integrations still show their mechanism and agreement badge.
- [ ] A product with **no** connector-powered edges shows no empty "Via" group.
- [ ] A product with **only** connector-powered edges renders sensibly (no empty direct list header).
- [ ] Counts under both lists reconcile with what is listed.

### 3.2 Connector / hybrid product template (AECI-707)
- [ ] A connector-role product (Zapier, Workato) renders the role-varied template, not the endpoint one.
- [ ] A `hybrid` product renders correctly — it counts as endpoint for the commercial model but has both faces.
- [ ] The "Integrations it powers" hub still works and links back to pair pages.
- [ ] `RoleBadge` self-hides for `application` — an ordinary product shows **no** role chip. Absence is the signal.

### 3.3 `integration_count` lockstep — the highest-value check
AECI-721 unioned two tables across **fourteen** call sites (the spec's own list named ten). A
drift here is silent and user-visible.
- [ ] Product card count == product detail count == taxonomy index count == search facet count, for the same product.
- [ ] Check at least one endpoint product, one connector, one hybrid.

### 3.4 Pair pages
- [ ] Agreement states render: `confirmed`, `single_source`, `unverified`, conflict.
- [ ] Version-diff timeline and the per-product version selectors work.
- [ ] `version_diff: null` suppresses the diff rather than rendering an empty one.
- [ ] Claim provenance and the maintenance marker (`last_reviewed_at`) display.
- [ ] Pair-page JSON-LD present (WebPage + about + BreadcrumbList).

### 3.5 Navigation + footer
The nav was restructured and `nav-more-*` deleted in favour of `nav-flyout-*`, plus AECI-617
retired the arrow buttons.
- [ ] Top nav taxonomy row and flyout menus open, keyboard-navigable, close on Escape.
- [ ] The facet link is itself the disclosure trigger — no separate arrow button.
- [ ] Footer renders; user menu reflects signed-in/signed-out state.

### 3.6 Search
- [ ] Search returns results; facets (category, audience, phase, trade) filter correctly.
- [ ] `?sort=` still works from the listing toolbar.
- [ ] Verified badge appears on vendor records in search — **expect none**, since production has zero `verified = 1` vendors. Confirm the absence rather than a broken badge.
- [ ] Autocomplete works (note: it lost telemetry in AECI-717).

---

## 4. Admin console — new surfaces

All under `/admin`, requires the D1 `profiles.role` admin grant.

- [ ] `/admin/claims` — list renders; `product_role` breakdown and `is_pure_connector_vendor` visible (the §5.2 payer test).
- [ ] `/admin/claims/:id` — detail route; **operator note** field saves (this is migration `0028`; if the column is missing the save 500s, which is your migration canary).
- [ ] `/admin/vendors` and `/admin/vendors/:id` — basics, entitlement panel, seats, audit trail.
- [ ] `/admin/vendors/:id` — entitlement **set / renew / clear**. Setting one should flip `vendors.verified`; clearing should flip it back **and** bump `updated_at` so search re-indexes.
- [ ] `/admin/users` and `/admin/users/:id` — accounts, last login, seats, ban/reinstate. Ban now lives here (AECI-692 folded `/admin/reviewers`).
- [ ] `/admin/connectors` and `/admin/connectors/:id` — read-only triage; the `managed_by` flip control is present and audited.
- [ ] `/admin/overview`, `/activity`, `/traffic`, `/audience`, `/catalog`, `/system` — regression pass, these existed before.

## 5. Vendor portal — inert by design

Expected state on demo: **reachable but empty**, because no seats are granted. Confirm it fails
*closed and gracefully*, not with a stack trace.

- [ ] `/vendor` with a signed-in non-vendor account → clean "no access" state, not a 500.
- [ ] **`/vendor/...` paths return 200/404, never a Cloudflare 403.** This is the §3a managed-rule
      check. Re-run the recipe: `/vendor`, `/vendor/x/overview`, `/api/vendor/me`, and the
      `/foo/vendor/bar` substring control. A 403 "Attention Required" page on any of them means
      the managed rule has re-fired.
- [ ] `/preview/vendor-dashboard` — renders every persona and entitlement preset **without a
      session**. This is the cheapest way to eyeball the whole portal surface.
- [ ] Live sync cadence, if you can seat a test vendor: 20 s focused / 60 s unfocused / paused when hidden.

## 6. Write paths + email

- [ ] Public claim submission (`/vendors/:slug/claim`) accepts and **parks** the claim — this is
      the decided dark-window posture. Confirm it lands in the admin queue.
- [ ] Review submission and the request forms still work (rate-limited: 5/60s per IP).
- [ ] Mailing-list signup + unsubscribe (tokenised soft-delete, one-click header).
- [ ] Claim-decision emails (`claim-approved` / `claim-rejected`) and seat invites send via Resend.
- [ ] The two new crons fire without crashing. Check `job_runs`.

## 7. Cross-cutting

- [ ] `/api/version` **and** `/_version` both report the promoted SHA. Two endpoints because `/api/version` alone cannot catch a stale SSR deploy.
- [ ] `/api/health` reports `db:ok`.
- [ ] Sign-in works (magic link + Google OAuth — note Google OAuth 400s until the provider is enabled in the dashboard).
- [ ] axe-core pass on the changed public surfaces: product detail, pair page, search, nav.
- [ ] No console errors on the main public routes.
- [ ] `entitlement_mirror_drift` reports 0 after the 04:00 UTC data-quality run.

---

## 8. Known non-issues — do not raise these as defects

- Verified badge appears nowhere: production and demo have **zero** `verified = 1` vendors. The entitlement backfill is a confirmed no-op.
- Connector coverage surfaces (AECI-715 / 716) are **unbuilt** — public "reaches N of M" pages do not exist yet.
- Vendor-side connector authoring is not available: `/admin/connectors` is read-only until AECI-724.
- Datadog dashboards going quiet is the intended AECI-651 outcome.
- `/vendor` returning 404 on `www` is the dark launch, not the WAF.
