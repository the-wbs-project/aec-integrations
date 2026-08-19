# AEC Integrations — Stage 2 Specification (Scope Outline)

**Version:** 0.1 — **scope outline, not a build contract**
**Date:** July 2026
**Status:** Kickoff draft (AECI-282). This is the Stage 2 equivalent of an opening scope doc — the pillars, the readiness carryover, the open decisions, and the epic map. It is **not** yet decomposed into buildable issues, and every section below is expected to grow its own detail (or split into a companion doc) before that phase is built.
**Inherits from:** Stage 1 (Phases 1–8 — `STAGE_1_SPEC.md`) and Stage 1.5 (Integration Redesign — `STAGE_1_5_SPEC.md`)
**Supersedes:** `STAGE_1_SPEC.md` §18 (Stage 2 Forward Compatibility) — §18 is the seed; this doc is the germination. Where §18's prose and this doc disagree (see §4, stack drift), **this doc wins**.

> **Data-layer note (ADR 0016 / 0017).** The application database is **Cloudflare D1 + Drizzle**; Supabase is **auth-only**. Every Stage 2 write goes through `getDb(env)` and, for multi-statement writes, a single `db.batch([...])` that includes its `audit_log` row (the §26.1 invariant of `STAGE_1_SPEC.md`). There is **no Prisma, no Postgres, no RLS on app tables** — Stage 2 authorization is the 3-layer Worker model in `docs/AUTH_AND_RLS.md`, not Postgres RLS. This is the single biggest correction to §18 (see §4).

---

## 1. Overview

Stage 1 shipped a **public, read-only** directory: AECi curates every product, vendor, integration, and claim; the public reads. Stage 1.5 added the integration claim/attestation spine but kept it **AECi-seeded** — every claim renders **"Unverified"** because no vendor can yet attest.

**Stage 2 is where the vendors log in.** The dividing line is exactly the one drawn in `STAGE_1_5_SPEC.md` §1.1: *anything that requires a vendor to authenticate and assert something about their own product is Stage 2.* That single capability — the **vendor portal** — unlocks the other two pillars (paid tiers layered on verified vendor accounts; real-time updates so vendor edits reflect live).

**Primary new user:** a **vendor** (software publisher) who — through a **paid, AECi-verified account** (§8.1(3)) — wants to claim their product, correct its data, attest to its integrations, and unlock a richer profile.

**The trust invariant is unchanged and non-negotiable:** **no pay-for-placement.** Paid tiers affect *profile richness and portal capability only, never ranking position* (`STAGE_1_SPEC.md` §1 principles; `CLAUDE.md` constraints). Search stays purely algorithmic.

**Out of scope for Stage 2 (still later stages):** rich media profiles (Stage 4), trust scoring beyond basic anti-abuse (Stage 3), a public write API product.

### 1.1 Relationship to prior specs & companion docs

Stage 2 inherits every Stage 1 / 1.5 constraint. It leans on these existing companion docs (each remains the source of truth for its topic; Stage 2 adds to them rather than forking):

| Topic | Source of truth (extended in Stage 2) |
|---|---|
| Authorization (roles, GRANT-equivalent, ban, 3-layer Worker authz) | `docs/AUTH_AND_RLS.md` — add `vendor_admin` enforcement + `/api/vendor/*` |
| API endpoint shapes / Zod / errors | `docs/API_CONTRACTS.md` — add the `/api/vendor/*` surface |
| D1 schema & migrations | `apps/api/src/db/schema.ts` + `docs/DATABASE_SCHEMA.md` (see §3 — the AECI-513 hooks already existed; the Paid-Tiers migration is the `vendor_entitlements` table, §8.5(1) / `DATABASE_SCHEMA.md` §8.6. The "**one** Stage 2 migration" framing is no longer accurate — the attestations epic added three more, §8.4) |
| Claim / attestation model | `docs/STAGE_1_5_SPEC.md` §3 — Stage 2 activates the dormant `vendor_a`/`vendor_b` sources |
| Edge caching / invalidation | `docs/CACHE_STRATEGY.md` (mid-migration to native Workers Cache — see §6) |
| Transactional email | `docs/email.md` (Resend — see §4) |
| Design tokens / theming | `DESIGN.md` (dark-theme reintroduction — see §2.5) |

---

## 2. Scope pillars

The three §18 pillars, plus the two carried-over surfaces (integration attestations, dark theme) that only Stage 2 can complete. Each maps to a Linear epic (§7).

### 2.1 Vendor Portal & Self-Serve Claiming — *the anchor*

> **Build contract:** this pillar is decomposed and specified in **`docs/STAGE_2_VENDOR_PORTAL_SPEC.md`** (the AECI-513 epic). The subsections below remain the scope outline; that doc is what each sub-issue anchors to.

The foundation everything else layers on. A vendor authenticates, proves association with a vendor record, and gains scoped write access to their own product/vendor data.

- **Claim flow — concierge / manual at launch (§8.1).** A vendor requests ownership of a `vendors` row (and its products). Builds on the Stage 1 Phase 6 request pipeline (`docs/STAGE_1_PHASE_6_SPEC.md`) and the domain-match hint, but escalates it from a correction request to a **verified account grant that AECi approves by hand**: on approval, a `profiles.role = 'vendor_admin'` row is linked to the `vendors` row via `profiles.vendor_id`, and `vendors.verified` flips true. **Verification is a paid gate** (§8.1(3)) arranged by **offline invoice/PO** (§8.1(5)) — the same admin action records the payment arrangement and toggles entitlement. *(As built — AECI-519: the grant mechanics shipped as `PATCH /api/admin/claims/:id`; see `STAGE_2_VENDOR_PORTAL_SPEC.md` §3 / §3.1.)*
- **Admin claim-review surface — reviewer-assisted verification (§8.1(1)).** The AECi-facing review UI presents **verification signals** to the reviewer: email-domain match against the vendor's known domain(s), an email→LinkedIn/person lookup, and any other enrichment that helps confirm the claimant. No auto-grant — a human decides on the assembled evidence.
- **Provisioning is an app-layer seam.** There is no cross-system FK between Supabase `auth.users` and D1 `profiles` (AECI-254) — the same seam the admin role uses. Vendor grants are written app-side, audited, and reversible.
- **`/api/vendor/*` endpoint surface.** Mirrors `/api/admin/*` (§18's observation still holds), scoped by `vendor_id` in the Worker + Drizzle query, **not** by RLS (§4). Every write emits its `audit_log` row in the same `db.batch()`.
- **Vendor dashboard UI.** Edit product/vendor content (name, description, links, taxonomy within guard-rails), see claim/correction status, manage the verified badge. **Multi-seat, flat** (§8.1(2)) — several admins per vendor; each seat is individually granted through the review above (self-serve invite/revoke deferred).
- **Verified-badge activation.** `vendors.verified` already exists and is indexed (§3); Stage 2 lights it up in the UI and the trust surface.
- **Moderation escalation.** `profiles.banned_at` / `ban_reason` (§3) gate vendor write access; abuse of the portal is a ban path.

### 2.2 Paid Tiers & Entitlements — *no pay-for-placement*

> **Build contract:** this pillar is decomposed and specified in **`docs/STAGE_2_PAID_TIERS_SPEC.md`** (the AECI-515 epic). The subsections below remain the scope outline; that doc is what each sub-issue anchors to.

Monetization layered on verified vendor accounts. **Ranking is never for sale;** **vendors pay, always** (§8.1(4)).

- **Tier model (§8.1(3)).** The free/default state is the **unclaimed, AECi-curated baseline** (renders "Unverified"). **Verified is a paid gate** — a modest entry fee unlocks claim, data correction, integration attestation, the verified badge, richer profile fields, vendor analytics, and version-diff depth. Entitlements gate **richness + capability only — never ranking, placement, or badge trust.** Any richness ladder above the entry Verified fee is **still open** (§8.2).
- **Billing — offline invoicing / PO at launch (§8.1(5)).** No payment-provider integration in the first slice; larger vendors pay by PO/invoice, not a credit card. The system needs an **admin-toggled entitlement/verification state** + basic invoice/arrangement tracking (notices/receipts over Resend — §4). Automated billing (Stripe or similar) and self-serve card are **deferred** — start with the minimum.
- **Entitlement enforcement.** A single entitlement gate consulted by `/api/vendor/*` and the render path; entitlements are **data, not code branches scattered across the app**, and the flag is payer-model-agnostic (§8.1(4)).
- **Relates to** the Stage 1.5 carve-out AECI-304 (paywalled integration/version-diff depth) — the first concrete paid capability. Hard invariant: the *latest-version* view **and** the latest conflict / single-source state are always free and full-fidelity to readers; only the historical *diff depth* is gateable; one-sided (paid-vs-unpaid) states are visibly labeled (this also mitigates the §8.1(3) attestation-bias risk).

### 2.3 Real-Time / Live Portal

§18 says "WebSockets/SSE for the portal." On Cloudflare Workers that means **Durable Objects** (WebSocket hibernation), not a standalone socket server.

- **Live vendor edits.** A vendor's change reflects without a full reload; optimistic UI + server confirmation.
- **Notification delivery.** Real-time channel for the §2.4 conflict/attestation notifications (silent-counterparty, open-conflict, stale-version) alongside their email fallback.
- **Transport decision is open** (§8): Durable-Object WebSockets vs SSE vs periodic revalidation. Pick the lightest transport that meets the portal's actual latency need — this is explicitly *not* a "real-time everything" mandate.

### 2.4 Integration Attestations & Conflict — *activating the dormant 1.5 spine*

> **Build contract:** this pillar is decomposed and specified in **`docs/STAGE_2_ATTESTATIONS_SPEC.md`** (the AECI-514 epic). The subsection below remains the scope outline; that doc is what each sub-issue anchors to.

Stage 1.5 shipped the claim spine with **dormant** `vendor_a`/`vendor_b` attestation sources and additive `introduced_at`/`deprecated_at` version stamps (§3). Stage 2 makes them live. These are **already tracked** as Stage 1.5 carve-outs and become the sub-issues of this epic:

- **Vendor attestation authoring** (AECI-301) — **shipped 2026-08-17; `STAGE_2_ATTESTATIONS_SPEC.md` §5 + §5.4.** Vendors assert/deny claims **and create their own**, producing real `vendor_a`/`vendor_b` attestations; `computeAgreement` (already unit-tested, computed-not-stored) lights up the confirmed/conflict states. Which slot a caller may fill derives from `product_vendors` ownership, never from the request — the AECI-520 `vendor_id`-scoping invariant extended to two slots.
- **Agreement/conflict surfacing + notification pipeline** (AECI-302) — **shipped 2026-08-17; §4 (surfacing) + §7 (pipeline) + §7.5.** The red vendor-vs-vendor conflict badge the AECi baseline can never trigger, plus the detector-fed notification pipeline. **Email-only at launch** (Resend + cron detectors + an in-portal list); real-time delivery over §2.3 is deferred to AECI-516 (§8.4(4)). **Four detectors shipped** — `silent-counterparty`, `open-conflict`, `stale-version`, `aeci-denied`. A fifth, `cross-grain`, was **dropped at build** (`STAGE_2_ATTESTATIONS_SPEC.md` §7.1 / §11): no doc in this repo ever defined it, and the only definition proposed describes legitimate data, since two mechanisms genuinely can move the same `data_object` in opposite directions.
- **Version-diff timeline** (AECI-303) — **shipped 2026-08-18; §9 + §9.4.** Per-product version selectors, built over the real `product_versions` entity migration 2 added (§8), because the dormant `introduced_at`/`deprecated_at` date stamps alone cannot express "source-version × target-version".
- **Paywalled integration depth** (AECI-304) — see §2.2; the diff is paywalled, the latest view is not. This epic ships the **seam**, not the gate.
- **Maintenance marker: real `last_reviewed_at` + vendor-maintained branch** (AECI-616) — **shipped 2026-08-18; the contract is `STAGE_2_ATTESTATIONS_SPEC.md` §13.** Stage 1 shipped the marker on `main` as attribution only (`Maintained by AEC Integrations` on product detail, vendor detail, and the pair page — a label, not a sentence, so no terminal period, and the date clause joins with a middot). The date clause and the `Vendor-maintained` branch existed in the component but were dormant, because **no column stored a real review timestamp**. Stage 2 adds `last_reviewed_at` + `maintained_by` to `vendors` / `products` / `integrations` (**migration 3**, `0018`), gates the write on an explicit `lastReviewedAt` signal in the promote payload — where **absence means untouched** — and lights up the vendor branch off real attestations. **Hard constraint: never source the date from `updated_at` / `created_at` / `promoted_at`, and never backfill it** — `updated_at` is `$onUpdate` and the promote ingest restamps it on every re-promote, so a bulk sweep would silently refresh the whole catalog's "freshness" without anyone re-checking a record.

> **Correction (2026-08-14 epic review — AECI-514): the "no migration" claim above was wrong.** It held for the *agreement engine* (computed-not-stored, ADR 0018) and for the `vendor_a`/`vendor_b` sources, and that much is unchanged. But two kickoff decisions (§8.4(1) vendor-created claims, §8.4(3) the product-version model) each require schema, so this epic ships **two additive migrations** — **three as of AECI-616**, which adds the maintenance-marker columns. They are specified in `STAGE_2_ATTESTATIONS_SPEC.md` §1.2. Do not plan against the old promise.

### 2.5 Dark Theme Reintroduction

Stage 1 shipped **light-only** (AECI-226), which deferred dark to "the Stage 2 vendor portal." The semantic token architecture was kept precisely so this is a token-block + toggle reintroduction, not a re-theme.

- Re-introduce the `.theme-dark` token block + a theme toggle + system-preference detection.
- The `profiles.theme_preference` column already exists (`'system' | 'light' | 'dark'`, §3) — persistence is ready.
- Re-audit contrast (WCAG AA) and re-enable the `dark:` verification step in the design checklist (currently skipped per the "Light only (Stage 1)" constraint).

---

## 3. Schema readiness carried through to D1/Drizzle (AECI-282 AC #3 — verified)

§18's readiness hooks were written for the **retired Supabase-Postgres** schema. Verified 2026-07-12 that **every one carried through** into the D1/Drizzle schema (`apps/api/src/db/schema.ts`) — so **no Stage 2 migration is required to stand up the vendor portal**:

| §18 hook | D1/Drizzle status |
|---|---|
| `profiles.role` includes `vendor_admin` | ✅ `schema.ts` — `profiles_role_check` (`'reviewer' \| 'admin' \| 'vendor_admin'`) |
| `profiles.vendor_id` FK → `vendors.id` | ✅ `schema.ts` — column + partial index `profiles_vendor_idx` |
| `vendors.verified` boolean | ✅ `schema.ts` — column + `vendors_verified_idx` |
| `profiles.banned_at` / `ban_reason` (moderation escalation) | ✅ `schema.ts` — columns + partial index `profiles_banned_idx` |
| attestation `source` reserves `vendor_a` / `vendor_b` | ✅ `schema.ts` — `attestations_source_check` (`'aeci' \| 'vendor_a' \| 'vendor_b'`) |
| attestation `introduced_at` / `deprecated_at` version stamps | ✅ `schema.ts` — additive; **live since AECI-603**, and still *date* stamps. The insufficiency the note below records was **closed by migration 2** (AECI-607): a real `product_versions` entity plus `introduced_version_id` / `deprecated_version_id` FKs is what AECI-303 shipped over. The dates remain the coarse fallback for claims carrying no version data, which today is all of them. |
| `translations` table (localized vendor-managed content) | ✅ `schema.ts` — present |
| `profiles.theme_preference` (dark-theme persistence) | ✅ `schema.ts` — `'system' \| 'light' \| 'dark'` |
| `computeAgreement` (computed-not-stored agreement) | ✅ defined in `packages/shared/src/agreement.ts` (imported/used in `apps/api/src/lib/drizzle-helpers.ts`) — unit-tested. **Four states as of AECI-605** (`single_source` added; `confirmed` narrowed to two distinct vendor identities) |

> **Two gaps found at the AECI-514 epic review (2026-08-14).** The table above is accurate about the *columns*, but readiness ≠ sufficiency:
>
> 1. **The version stamps are dates, not versions.** `introduced_at` / `deprecated_at` are ISO dates on an attestation. AECI-303's "source-version × target-version selectors" needs a **version entity per product**, and there is none in `schema.ts`. That is migration 2 of `STAGE_2_ATTESTATIONS_SPEC.md` §8.
> 2. **`computeAgreement` renders a *single* vendor's affirmation as `confirmed`.** ✅ **Closed by AECI-605** (2026-08-14). Unreachable in Stage 1.5 (AECi never votes), so the gap was latent — but it contradicted §8.1(4)'s "one-sided states are visibly labeled". A `single_source` state now carries the one-sided case, rendered neutral and attributed ("Confirmed by {vendor}") with the counterparty's silence stated; `confirmed` requires two **distinct** vendor identities. Shipped ahead of the authoring API (AECI-301), which is what would first make the branch reachable — see the §1.1 release gate and §4.5 in `STAGE_2_ATTESTATIONS_SPEC.md`.
>
> A third finding is a live defect rather than a readiness gap: **`POST /api/promote` deletes claims by `integration_id` and cascades to attestations**, so the first re-promote of a claimed product would silently destroy every vendor attestation. Fixed in `STAGE_2_ATTESTATIONS_SPEC.md` §3.

---

## 4. Stack drift since §18 (AECI-282 AC #4)

§18 was written before the mid-Stage-1 platform changes. These are the points where its prose is stale and Stage 2 must plan against current reality:

1. **DB & authz — D1/Drizzle replaced Prisma/Supabase-PG (ADR 0016, AECI-278).** §18 implicitly assumes **Postgres RLS** for vendor-scoped access. **There is no RLS on app tables.** Stage 2 vendor authorization is the **3-layer Worker model** (`docs/AUTH_AND_RLS.md`): verify JWT → check `role`/`vendor_id`/`banned_at` → scope every Drizzle query by `vendor_id`. Multi-statement vendor writes use `db.batch([...])` (**D1 has no interactive transactions**) and must include their `audit_log` row in the same batch (§26.1).

2. **Cache invalidation — §18's `invalidateForEntity` reference is stale.** It was superseded by Cache-Tag purge (ADR 0004) and is now being re-migrated to **native Workers Cache + a cross-Worker Queue purge** (the in-flight **AECI-314** epic, ADR 0020 — see §6). Stage 2 vendor writes purge through whatever AECI-314 lands, via `Cache-Tag`, not a per-entity helper. Do not re-introduce `invalidateForEntity`.

3. **Email — Resend replaced Loops (AECI-240).** Every Stage 2 notification (claim approved/denied, conflict alerts, billing receipts) sends through the Resend client `apps/api/src/lib/email.ts` (`docs/email.md`), fail-open, not Loops.

4. **Auth — Supabase is Auth-only (ADR 0017).** One shared Supabase project across all environments; magic link + Google OAuth. `vendor_admin` provisioning is an **app-layer seam** (no `auth.users`↔`profiles` FK, AECI-254) — identical to how the admin role is granted. GDPR erasure remains an app-layer seam (AECI-254).

5. **Real-time — Cloudflare Durable Objects, not a socket server.** §18's "WebSockets/SSE" on Workers is realized with Durable Objects (WebSocket hibernation) — see §2.3.

6. **Read scaling — D1 Sessions API (AECI-250).** Read-replication is wired but inert until per-DB `read_replication: { mode: auto }` is flipped (ops action). A read-heavy vendor portal is the workload that would justify enabling it.

---

## 5. Stage-1 deferrals rolled into Stage 2

Explicit Stage-1 punts that belong to Stage 2 (the "Deferrals & Carryover" epic, §7):

- **Integration-page JSON-LD** — deferred from Phase 2 §9.2 (`STAGE_1_SPEC.md` §16). The pair page (Stage 1.5 §7) ships without structured data; Stage 2 adds it.
- **Sitemap index / sub-sitemap split** — AECI-63; only needed beyond 50k URLs. Revisit when catalog growth crosses the threshold.
- **RTL-safe logical properties** — the app-wide i18n hardening follow-through (AECI-153 shipped the first pass) if Stage 2 adds a locale.

> **Correction to AECI-282's own text:** the issue lists the **AECI-175 per-tab sort dropdown** as a Stage-1 deferral to carry forward. It is **not** — it **shipped** (Done 2026-06-23, PR #370, Relevance / Most-integrations / Name A–Z). It is recorded here as *already done*, not deferred.

---

## 6. In-flight Stage 2 tracks

Work already opened against the `stage-2` branch and living in the "Stage 2 Planning" Linear project before this kickoff:

- **Workers Cache Migration** (AECI-314 epic, WC-1…11 / AECI-315…325; ADR 0020). Moves the SSR edge cache from hand-rolled `caches.default` match/put + HTTP purge to **native Workers Cache** with cross-Worker purge via a Cloudflare Queue. This is the concrete realization of drift point §4.2 and is a prerequisite Stage 2 platform change, independent of the vendor portal.

Stage 2 feature work branches from and merges to `stage-2` (post-launch branch model, ADR 0019 / `docs/CICD_PLAN.md` §10); production hotfixes still branch from `main`.

---

## 7. Epic map → Linear ("Stage 2 Build" project)

The initial epics seeded by AECI-282 (in the `Stage 2 Build` project — renamed from `Stage 2 Planning`), following the AECI-314 "(epic)" parent-issue convention. Each epic opens with `**Spec section:** docs/STAGE_2_SPEC.md §X` and `**Base branch:** stage-2`. The anchor epic (Vendor Portal, AECI-513) is decomposed into buildable sub-issues **AECI-519…525 plus 527, 528, 529** (the +3 from the 2026-07-24 epic review), specified in **`docs/STAGE_2_VENDOR_PORTAL_SPEC.md`**. The Integration Attestations epic (AECI-514) is decomposed into **AECI-301 / 302 / 303 plus 603…608** (the +6 from the 2026-08-14 epic review), specified in **`docs/STAGE_2_ATTESTATIONS_SPEC.md`**. The Paid Tiers epic (AECI-515) is decomposed into **AECI-609…615 plus the re-scoped AECI-532** (the 2026-08-14 epic review), specified in **`docs/STAGE_2_PAID_TIERS_SPEC.md`**.

> **Epic branches.** All three decomposed epics use a **long-lived epic integration branch** (`aeci-513`, `aeci-514`, `aeci-515`) rather than basing sub-issues on `stage-2` directly, because each sub-issue has to update a companion spec that does not exist on `stage-2` yet. Sub-issues branch from and PR into their epic branch; the epic branch merges to `stage-2` when it completes. **The Linear template's `**Base branch:** stage-2` line is stale for a decomposed epic's sub-issues.**

| Epic | Spec | Notes |
|---|---|---|
| Vendor Portal & Self-Serve Claiming | §2.1 | The anchor; blocks the rest. **Build spec:** `STAGE_2_VENDOR_PORTAL_SPEC.md` |
| Integration Attestations & Conflict | §2.4 | Re-parents AECI-301 / 302 / 303, +6 at kickoff. **Build spec:** `STAGE_2_ATTESTATIONS_SPEC.md` |
| Paid Tiers & Entitlements | §2.2 | No pay-for-placement. Re-scopes AECI-532, parents AECI-304. **Build spec:** `STAGE_2_PAID_TIERS_SPEC.md` |
| Real-Time / Live Portal | §2.3 | Durable Objects |
| Dark Theme Reintroduction | §2.5 | Token-block + toggle; AECI-226 deferral |
| Stage-1 Deferrals & Carryover | §5 | JSON-LD, sitemap split |
| Workers Cache Migration | §6 | **Already exists** — AECI-314 |

---

## 8. Decisions

Resolved **2026-07-12** (AECI-282 kickoff, Chris). The Stage-2-launch model is **concierge / manual onboarding** for the first vendor cohort: AECi reviews each claim by hand, arranges payment offline, and toggles verification manually. It deliberately does not scale — vendor volume at launch is low, and staffing help comes in if it grows.

### 8.1 Decided

1. **Verification bar — manual, reviewer-assisted.** AECi grants every `vendor_admin` by hand; **no auto-grant** at launch. The admin claim-review surface must **present verification signals** to the reviewer — email-domain match against the vendor's known domain(s), an email→LinkedIn/person lookup, and any other enrichment that helps confirm the claimant is who they say. Doesn't scale; acceptable — bring in help if volume warrants. (Gates AECI-513.)
2. **Seat model — multi-seat, flat.** Many `profiles` → one `vendor_id` (already schema-native, **zero migration**). A large vendor (Autodesk, Deltek…) will have several admins, not one. Every seat is individually granted through the §8.1(1) review, so multi-seat stays safe. Self-serve invite/revoke + an owner/admin distinction are **deferred** (need a small schema add). (Gates AECI-513.)
3. **Verification is a paid gate.** Becoming a **Verified** vendor carries a fee — modest, but real. The free/default state is the **unclaimed, AECi-curated baseline** that renders "Unverified" (the Stage 1.5 status quo); **Verified (paid)** unlocks claim, data correction, integration attestation, the verified badge, richer profile fields, vendor analytics, and version-diff depth. This does **not** break the reader-facing trust model — that invariant is §8.1(4), and it is about the *reader*, not the vendor's cost to participate.
   - *Residual risk to watch:* if only paying vendors attest, attestation coverage skews toward payers. Mitigated by (a) the AECi-curated baseline staying **free to read**, and (b) AECI-304's invariant that **one-sided states are visibly labeled** — absence of a vendor attestation is never rendered as agreement. Tier structure/pricing above the entry Verified fee is **still open** (§8.2).
4. **Payer — vendors pay, always.** AECi's customer is the vendor. Viewer-pays tooling is possible far later, out of scope now. Reader-facing invariants (AECI-304) hold: the latest-version view **and** the latest conflict / single-source state are always free and full-fidelity to readers; only the historical *diff depth* is gateable; one-sided (paid-vs-unpaid) states are labeled. Keep the entitlement flag model-agnostic so the payer model could swing later without a migration.
5. **Billing — offline invoicing / PO at launch.** No payment-provider integration in the first slice; larger vendors pay by **PO/invoice, not a credit card**. The system needs an **admin-toggled entitlement/verification state** + basic invoice/arrangement tracking (notices over Resend, §4). Automated billing (Stripe or similar) and self-serve card payment are **deferred** — start with the minimum.

### 8.2 Still open (further discussion — do not block AECI-513 on these)

- ~~**Tier ladder above the entry Verified fee**~~ — **structure resolved 2026-08-14, see §8.5(2).** The ladder is binary at launch and adding a rung is now a data-only change. *Pricing* above the entry fee remains a business question, not a build blocker.
- ~~**Offline-invoicing mechanics**~~ — **resolved 2026-08-14, see §8.5.** Who toggles, what is recorded, and the renewal/expiry posture are all settled; dunning stays deliberately out.
- **Real-time transport** (§2.3) — Durable-Object WebSockets vs SSE vs revalidation. **Deferred** — decide when the build reaches AECI-516; the portal ships without persistent sockets until a concrete latency need proves one. (Search-index freshness *within* the portal is separately **decided** — §8.3(5): nightly ≤24h + immediate SSR — and does not wait on this transport choice.)

### 8.3 Decided at build kickoff (2026-07-24 epic review — AECI-513)

Resolved when the Vendor Portal epic was decomposed. These **promote the epic's working decisions into the spec** and are the contract carried in `docs/STAGE_2_VENDOR_PORTAL_SPEC.md`; they refine §8.1 without contradicting it.

1. ~~**Entitlement launch shape.**~~ **SUPERSEDED by §8.5(1) (2026-08-14).** As decided here: `vendors.verified` **is** the launch entitlement bit (per §8.1(5)); the PO/invoice arrangement is recorded in `audit_log` metadata; **no new schema** in the AECI-513 epic — the Paid Tiers epic (AECI-515) formalizes the entitlement model later. (That broke the 513↔515 coordination knot, and 515 has now done it: `vendors.verified` is a **mirror** of a `vendor_entitlements` row, and the arrangement lives in the row as well as the audit trail. Everything AECI-513 shipped against this bullet is still correct — only the storage model moved.)
2. **Seat semantics.** Revoke and ban are **per-seat** and **never** touch `vendors.verified` (vendor-level paid state). Un-verifying a vendor is a **separate entitlement action**, not a ban.
3. **Role exclusivity.** `role` / `vendor_id` are **single-valued** — no `vendor_admin` grant to `admin` accounts; **one vendor per account** at launch; conflicts are **explicit errors** (a `vendors.parent_company` multi-vendor admin uses separate accounts).
4. **Enrichment at launch.** Reviewer-assist signals are **domain-match + a pre-built LinkedIn/person search link only**; real person-lookup providers are a **deferred DPA/GDPR decision**.
5. **Search freshness.** Vendor edits + badge flips reach **Algolia on the nightly watermark sync (≤24h)**; **SSR is immediate** via Cache-Tag purge. Accepted for launch — **UI copy must not promise instant search**.

### 8.4 Decided at build kickoff (2026-08-14 epic review — AECI-514)

Resolved when the Integration Attestations epic was decomposed. These **promote the epic's working decisions into the spec** and are the contract carried in `docs/STAGE_2_ATTESTATIONS_SPEC.md`; they refine §2.4 without contradicting §8.1.

1. **Vendors may CREATE claims, not just attest to AECi-seeded ones.** A vendor knows its own integration surface better than AECi's curation does; attest-only would cap coverage at whatever AECi happened to seed. Cost: a **provenance column on `claims`** (`origin` + `created_by_vendor_id`) and the promote carve-out in (4) below. **This is migration 1** — it overturns §2.4's original "no migration" promise.
2. **Attestation authority derives from product ownership, never from the request.** `vendor_a` = a vendor with a `product_vendors` row on the integration's `source_product_id`; `vendor_b` = the same on `target_product_id`; owning **both** endpoints permits attesting both slots; owning **neither is a 404, not a 403** (the AECI-520 non-disclosure rule). This is the two-slot extension of the §8.3 `vendor_id`-scoping invariant.
   - **One live attestation per slot**, enforced by a partial unique index on `(claim_id, source) WHERE retracted_at IS NULL`. Supersession is **retract-then-insert**, never `UPDATE`, so history stays append-only for the version timeline.
   - **`retracted_at` is a new column.** `deprecated_at` is a *version stamp* (`STAGE_1_5_SPEC.md` §3.3), not a retraction — the shipped `attestations_active_idx` comment conflates the two and is corrected.
3. **A real product-version model is added** (`product_versions` + version FKs on `attestations`) so AECI-303's per-product selectors are buildable. **This is migration 2.** Ordering keys off an explicit `sort_key`, never off the label (version labels do not sort lexically) or `released_at` (nullable). Versions are **vendor-authored only** at launch; promote does not ingest them.
4. **Promote coexistence — replace-by-origin.** `POST /api/promote` replaces only `origin='aeci'` claims and `source='aeci'` attestations; vendor rows survive re-promote, and claims upsert by their identity index so ids stay stable. When AECi drops a claim that carries a live vendor attestation, it is **converted to `origin='vendor'`, not deleted** — AECi withdraws its curation, the vendor's assertion stands. This fixes a **live defect**: today promote deletes claims by `integration_id` and cascades to attestations.
5. **`confirmed` requires two *distinct vendor identities*.** A new **`single_source`** agreement state is added so one vendor's affirmation is never rendered as bilateral agreement — the structural form of §8.1(4)'s "one-sided states are visibly labeled". `conflict` remains the only red state, and the AECi-never-red rule is unchanged.
6. **Notifications ship email-only** (Resend) with cron-driven detectors and an in-portal list. Real-time delivery is deferred to AECI-516, whose transport is still open (§8.2) — nothing in the attestations epic waits on it.
7. **Notification dedupe uses `audit_log` as the ledger** (`action: 'notification.sent'`), so the epic needs no notifications table and the in-portal list gets its backing query for free.
8. **The paywall is a seam, not a gate, in this epic.** AECI-303 shipped `canViewVersionDiff(...)` defaulting to open, in **`packages/shared/src/version-diff.ts`** (reached as `@aeci/shared/version-diff` — deliberately NOT `entitlements.ts`, which `aeci-515` already owns and which already declares the `'integration.version_diff'` capability id). Its single `apps/api` consult site is `resolveDiffAccess` in `apps/api/src/lib/pair-version-diff.ts`; the other is the web pair resolver. **AECI-304 swapped the implementation on 2026-08-19, and both of §9.4's ⚠️ notes are now resolved.** The gate is on **the pair's endpoint vendors, never the reader** — a reader never pays and is never identified — and because the pair's vendors are a function of the two slugs in the URL, the gate stayed **URL-derived**, so the edge-cache constraint was discharged by construction rather than by any of the three escape routes that note listed. The §8.1(4) invariant holds throughout: the **latest-version view and the latest conflict / single-source state are always free and full-fidelity**; only historical diff depth is gateable.

### 8.5 Decided at the Paid-Tiers epic review (2026-08-14 — AECI-515)

Resolved when the Paid Tiers epic was decomposed. These close §8.2's first two items and are the contract carried in **`docs/STAGE_2_PAID_TIERS_SPEC.md`**; they refine §8.1 and supersede §8.3(1) without contradicting the rest.

1. **Entitlement storage — a real table, with `vendors.verified` demoted to a mirror.** A new `vendor_entitlements` table (tier / status / term / offline-arrangement record) carries the model; **`vendors.verified` becomes a denormalized mirror**, maintained in the same `db.batch([...])`, with the invariant *`verified = true` **iff** an `active` entitlement row exists*. `vendor_id` is **UNIQUE** — that is what lets the mirror flip be a guarded single-row `UPDATE`, which is the only concurrency-safe shape available given D1 has no interactive transactions. **This supersedes §8.3(1)'s "no new schema"**, which was the AECI-513 launch shape and named AECI-515 as its successor. One migration, `0019_easy_sandman` (generated as `0006_*`, renumbered in AECI-622 — see `migrations.md` §0); everything downstream is additive-with-no-DDL. All five existing readers of `verified` (the public `?verified=` filter, `VendorLinkSchema`, `VendorDetail`, the Algolia vendor record, `aec-verified-badge`) are **untouched**.
2. **Tier ladder — binary at launch, extensible as data.** `unclaimed` (the AECi-curated baseline) vs `verified` (the paid entry fee). A **capability registry** (`packages/shared/src/entitlements.ts`, pure data, zod-free) maps tier → capability set, so adding a rung later is a data edit and not a code change. `tier` is deliberately **unconstrained** at the DB layer for exactly that reason (`workflow_instances_type_check` is the cautionary precedent); an unknown tier fails closed to zero capabilities.
3. **Renewal / expiry — warn, never auto-lapse.** Entitlements carry `period_start` / `period_end`. A daily cron **warns** the vendor's seats and `ADMIN_ALERT_EMAIL` before expiry and **never writes `status`**. Auto-lapse would strip a badge from a paying customer over a data-entry mistake; **un-verifying stays a deliberate admin action** — consistent with §8.3(2). No dunning.
4. **Who toggles — an admin, through the entitlement, never the bit.** `PATCH /api/admin/vendors/:id/entitlement` (`set` / `renew` / `clear`) is the sole owner of the un-verify half §8.3(2) left unowned. `verified` is never named in the payload; it follows in the same batch. **Clearing an entitlement does not revoke seats** — the vendor keeps portal access, read-only, with a renewal notice.
5. **No pay-for-placement becomes an asserted property.** The entitlement capability vocabulary and the Algolia ranking vocabulary (`searchableAttributes ∪ attributesForFaceting ∪ customRanking` across `INDEX_SETTINGS`) are proven **disjoint** by unit test, and no cacheable SSR component may import the entitlement registry. The invariant stops depending on reviewer vigilance.
6. ~~**AECI-304 stays parented to AECI-515 but is excluded from the epic's build order and completion criteria**~~ — it was blocked by the then-unbuilt AECI-303. **Both shipped 2026-08-18/19**, so 304 landed on the epic branch after all. Minting the `integration.version_diff` capability id up front did what it was meant to: 304 needed no registry edit, only the two consult sites. It is **not** a render-path gate on a component, though — it is a gate on the **pair's vendor tiers**, in `canViewVersionDiff` (`STAGE_2_PAID_TIERS_SPEC.md` §11).

---

## 9. Out of scope for Stage 2

- Rich media profiles (Stage 4)
- Trust scoring beyond basic anti-abuse (Stage 3)
- A public/partner write API product ("no public API surface" boundary unchanged)
- Anything requiring a schema change not already reserved by §3 without an explicit migration decision

---

*This is a living kickoff outline. As each pillar approaches build, promote its §2 subsection into a full sibling spec (as Stage 1.5 did) or grow it in place, and decompose the epic into 3–10 focused issues per `STAGE_1_SPEC.md` §24.4.*
