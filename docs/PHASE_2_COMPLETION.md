# Phase 2 Completion Report

**Issue:** [AECI-67](https://linear.app/aec-integrations/issue/AECI-67) — Phase 2.21, Phase 2 completion checkpoint
**Spec anchor:** `docs/STAGE_1_PHASE_2_SPEC.md` §11.3 (i18n) + §15 (Acceptance criteria for Phase 2 completion)
**Commit:** `a812a9b` · **Date:** 2026-06-09 (UTC)

This is the "Phase 2 is Done" gate — the equivalent of AECI-36 ("lights on") for the
whole directory. Per the issue, it **surfaces** open items rather than silently
closing them: every §15 line is mapped to ✅ Done / ⚠️ Partial / ❌ Outstanding with
concrete evidence, and each non-green item carries either a follow-up issue proposal or
an explicit written punt.

---

## 1. Verdict

**Phase 2 is functionally complete and shippable.** All 10 page types render, all 13 API
endpoints ship with tests, the data model + RLS + slugs are in place, caching + SEO +
internal-link graph are wired and tested, and CI is green on `main`.

Three items are **not** fully green, none of them a launch blocker for the Phase 2
*build*; all three are operational / later-phase concerns:

| # | Item | Status | Disposition |
|---|------|--------|-------------|
| §15.2 | Lighthouse mobile ≥ 90 on every page type | ❌ Outstanding | **Owned by existing [AECI-65](https://linear.app/aec-integrations/issue/AECI-65) (Phase 2.19, Backlog)**; code defers enforcement to Phase 7 — decision to reconcile (F1) |
| §15.13 | Datadog dashboard live + showing data | ⚠️ Partial | Config shipped under AECI-66 (Done, PR #156) but its **live-apply + verification ACs are unfinished** (live URL + notification channel still TBD) → follow-up **F2** |
| §15.15 | No console warnings/errors on **any** page type | ⚠️ Partial | Capture asserted on `/` only → follow-up **F3** |

Two work products were produced **in this issue** to close green items: the i18n
duplicate-id fix (§15.14) and the DESIGN.md component definitions (§15.16). See §4.

---

## 2. §15 Acceptance checklist

| # | §15 criterion | Status | Evidence |
|---|---------------|--------|----------|
| 1 | Every page in §3.1 renders with real data from Supabase | ✅ | Routes `apps/web/src/app/app.routes.ts` (products, vendors, integrations, categories, `categories/:slug`, `audiences/:slug`, `phases/:slug`, `integrations/:id`, 404 `**`); per-page resolvers via `core/create-detail-resolver.ts`; e2e: `products-{index,detail}`, `vendors-{index,detail}`, `integrations-{index,detail}`, `categories-index`, `taxonomy-browse`, `not-found`. *(Live data presence is env-seed-dependent — see §5, note A.)* |
| 2 | Every page passes Lighthouse mobile ≥ 90 (Perf/A11y/BP/SEO) | ❌ | `.lighthouserc.cjs` is **desktop-only, homepage-only, warn-only** (Phase 1 posture); the `lighthouse` job in `.github/workflows/deploy.yml` is parked (`if: false`). This is the explicit scope of **[AECI-65](https://linear.app/aec-integrations/issue/AECI-65) — "Phase 2.19, Wire axe + Lighthouse to every Phase 2 page in CI (budgets enforced)"**, which is **still in Backlog** (its axe half is done; its Lighthouse half is not). Note AECI-65 is *not* in AECI-67's `blockedBy` list, so the checkpoint can complete with it open. **See §3.F1.** |
| 3 | Every page passes axe with zero AA violations | ✅ | `@axe-core/playwright` with `withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa'])`, hard-fail `toEqual([])` — `apps/web/e2e/smoke.spec.ts:32-44`; per-page e2e specs across all page types; runs in the required `e2e-and-integration` CI job. |
| 4 | sitemap.xml is valid and contains every entity | ✅ | `apps/web/src/server/sitemap.ts` (`buildSitemapXml` + `resolveSitemapEntries`, paginates all products/vendors/integrations + taxonomy); route in `server-runtime.ts`; tests `apps/web/src/server/sitemap.spec.ts`. (AECI-63) |
| 5 | Crawler confirms every entity reachable in ≤ 3 hops from `/` | ✅ | `apps/web/e2e/internal-link-graph.spec.ts` — BFS to depth 3 in a hydrated browser, asserts all internal links resolve, no 5xx, structural indexes + seeded entity pages reachable ≤ 3. (AECI-64) |
| 6 | Cache-Tag headers present on every cacheable response (§8.2) | ✅ | `apps/web/src/server/cache-tags.ts` (`buildCacheTags` / `cacheTagInputsForPath`); set in `server-runtime.ts` on 2xx + a `not-found` tag on 404; tests `cache-tags.spec.ts`. (AECI-56) |
| 7 | `POST /admin/purge` works end-to-end (manual + test) | ✅ | `apps/web/src/server/routes/admin-purge.ts` — bearer-token (timing-safe) auth, Zod body (1–30 tags), CF purge-by-tag passthrough, Datadog `aeci.cache.purge`; tests `admin-purge.spec.ts` (auth, body, CF passthrough, metric). Live MISS→HIT cycle verified by `scripts/run-extra-tests.sh` against a **deployed** URL. *(See §5, note B — the local Playwright suite excludes edge-cache observation because Miniflare ≠ CF edge.)* |
| 8 | `POST /api/page-views` returns 204 + called by every detail render + `PageViewTracker` | ✅ | Endpoint `apps/api/src/routes/page-views.ts` (204 no-op, no Prisma import, tested incl. structural no-Prisma guard); fired server-side via `firePageView()` in `server-runtime.ts`; client `PageViewTracker` `apps/web/src/app/core/page-view-tracker.ts` started from `app.ts`, skips first nav, strips query/hash. (AECI-55 / AECI-151) |
| 9 | Slugs backfilled for 100% of products + vendors; uniqueness constraint | ✅ | `supabase/migrations/20260524100000_phase_2_slug_unique.sql` (UNIQUE indexes); generator `packages/shared/src/slug.ts` + 23-case `slug.spec.ts`; backfill `apps/api/scripts/backfill-slugs.ts` + `backfill-slugs.spec.ts`. *(Backfill is a run-once op against each environment — see §5, note A.)* |
| 10 | `vendor_requests` table exists with RLS policies applied | ✅ | `supabase/migrations/20260524000000_phase_2_vendor_requests.sql` (full §5.1 column set + CHECK constraints + FK + RLS enabled); admin-read policy in `20260602051513_rls_grants_and_policies.sql`; RLS test `apps/api/src/integration/vendor_requests.rls.spec.ts`. |
| 11 | All API contracts in `packages/shared/`, all endpoints in `apps/api/` with tests | ✅ | Zod + types in `packages/shared/src/api/{products,vendors,integrations,taxonomy,page-views,common}.ts`; 13 endpoints in `apps/api/src/routes/` each with a `*.spec.ts`; wired in `apps/api/src/index.ts`. (audiences/phases lists intentionally via `/api/taxonomy` per §7.1.) |
| 12 | CI runs unit + integration + E2E + a11y + Lighthouse and is green | ⚠️ | `deploy.yml`: `lint-and-types`, `unit-tests`, `e2e-and-integration` (Playwright + axe + edge-cache) all run; `integration-db-tests.yml` runs RLS/DB suites; **`main` is green** (latest `deploy` runs `success`). **Lighthouse is parked** (`if: false`) → the missing wiring is AECI-65's scope (§15.2). The non-Lighthouse pipeline is complete and gating. |
| 13 | Datadog dashboard live and showing data | ⚠️ | Metrics emitted in code (`aeci.page.render.duration_ms`, `aeci.api.query.duration_ms`, `aeci.cache.purge`); dashboard + 3 monitors in `observability/datadog/*.json` shipped under **AECI-66 (Done, PR #156)**. **But AECI-66's own verification ACs are unfinished**: `OBSERVABILITY.md` still has **Live URL "TBD"** (line 95) and **`@NOTIFICATION_CHANNEL_TBD`** (line 104), and the post-deploy traffic-gen confirmation isn't recorded — i.e. AECI-66 was closed on config-landing with the live-apply step deferred. **See §3.F2.** |
| 14 | `xliff` extraction succeeds with no missing-translations marker | ✅ | `ng extract-i18n` → **299 messages, exit 0, zero warnings** after the duplicate-id fix in §4.1. Re-verified clean. |
| 15 | No new console warnings or errors on any page type | ⚠️ | Console capture asserted on **`/` only** (`smoke.spec.ts:46-64`, "AECI-36 AC #6"). The crawler and per-page Phase 2 specs do **not** assert console-clean. **See §3.F3.** |
| 16 | DESIGN.md updated with new component definitions | ✅ | Done in this issue (§4.2): `ProductCard`/`VendorCard`/`IntegrationCard` added; `EntityTable` reconciled; layouts + `TaxonomyBadge` already present. |
| 17 | No hard-coded color literals anywhere (lint clean) | ✅ | `pnpm lint` clean across all 4 workspaces + Prettier + logical-properties; `npx impeccable detect` on the Phase 2 components reports **0 findings**. *(Mechanism note — §5, note C: there is no dedicated ESLint color rule; enforcement is `impeccable detect` + review, not lint as §11.4 implies.)* |

**Score: 14 ✅ / 2 ⚠️ / 1 ❌** — the three non-green items are Phase 7 (Lighthouse) and operational/test-coverage follow-ups, not Phase 2 build defects.

---

## 3. Outstanding items — follow-ups & punts

### F1 — Lighthouse mobile ≥ 90 on every page type → **Owned by existing AECI-65 (Phase 2.19)**

§15.2 and the Lighthouse portion of §15.12 are **already a tracked Phase 2 issue —
[AECI-65](https://linear.app/aec-integrations/issue/AECI-65), "Wire axe + Lighthouse to
every Phase 2 page in CI (budgets enforced)" — currently in Backlog.** Its axe half is
done (§15.3 ✅); its Lighthouse half is not: `.lighthouserc.cjs` runs **warn-only,
desktop-only, homepage-only**, and the `deploy.yml` `lighthouse` job is `if: false`,
with in-file comments deferring mobile + every-page-type URLs + error-level enforcement
to **Phase 7**. There is a **decision to reconcile here**: AECI-65 (Phase 2.19) frames
Lighthouse budgets as Phase 2 merge-blockers, while the code defers enforcement to Phase
7. **No new issue needed** — route this through AECI-65; Chris to decide whether AECI-65's
Lighthouse half stays Phase 2 or is formally re-scoped to Phase 7. Either way it does not
block AECI-67 (not a `blockedBy` of the checkpoint, and no Phase 2 page is known to fail
the budget — it is simply not yet gated).

### F2 — Finish AECI-66's live Datadog apply + verification → **New follow-up issue**

The metric-emission code + dashboard/monitor **definitions** shipped under AECI-66 (Done,
PR #156). But AECI-66's **verification ACs are unfinished** and it was closed anyway: the
live dashboard URL is still "TBD" (`OBSERVABILITY.md:95`), the alert notification channel
is still `@NOTIFICATION_CHANNEL_TBD` (`:104`), and the "generate test traffic, confirm
all three metrics appear within 5 min" step isn't recorded. This is **operational and
cannot be verified from the repo** (needs a deployed env + `DD_APP_KEY`). Because AECI-66
is already closed, a **new focused follow-up** is cleaner than reopening it. **Created:**
see hand-off — "Finish Datadog live apply + verification (AECI-66 carryover)."

### F3 — Console-clean on every page type → **New Phase 2.x follow-up issue**

The "no console warnings/errors" assertion currently covers `/` only
(`smoke.spec.ts:46`). The Phase 2 page types (product/vendor/integration detail + index,
category/audience/phase browse, 404) are **not** asserted console-clean. The cleanest fix
is a `page.on('console')` / `page.on('pageerror')` collector in the existing crawler
(`internal-link-graph.spec.ts`), which already visits every reachable page type, asserting
zero errors per visited page. **Not fixed in this issue** because the change needs the
full e2e stack (`dev:bound` + seeded data) to verify it passes; shipping an unverified
assertion risks a red CI. **Created:** see hand-off — "Extend console-error/warning
capture to every Phase 2 page type (crawler)."

### F4 — (Optional) Color-literal enforcement mechanism → **Recommendation, no issue**

§11.4 / the AECI-67 AC say a "lint rule (Phase 1) catches" hard-coded color literals. In
reality **no dedicated ESLint color rule exists** (the base config enforces the inject
guard + em-dash guard only); color literals are caught by `npx impeccable detect` and
code review. The Phase 2 components are clean either way (0 detect findings). **Recommend
one of:** (a) add a real ESLint/stylelint hard-coded-color rule, or (b) formally adopt
`impeccable detect` as the enforcement of record and correct the §11.4 wording. Doc/lint
hygiene, not a Phase 2 blocker — no issue filed pending Chris's preference.

---

## 4. Work done in this issue

### 4.1 i18n: fixed 3 duplicate-id extraction warnings

`ng extract-i18n` initially warned that `@@app.theme.label.{system,light,dark}` each
mapped to **two different source strings** — `theme-toggle.ts` wraps the label tightly
(`<ng-container i18n>System</ng-container>` → `"System"`) while `theme-toggle-group.ts`
put `i18n` on the `<button>` whose content carried surrounding whitespace (`" System "`).
Same id, different source ⇒ non-deterministic xliff. The group component's own doc
comment states it intentionally reuses the cycle button's ids, so the sources must match.
Fixed by wrapping each label in `theme-toggle-group.ts` in a tight
`<ng-container i18n="@@app.theme.label.*">` (mirrors `theme-toggle.ts`). Re-extraction is
now **clean (299 messages, no warnings)**; the component spec is unaffected (keys rows by
`textContent.trim()`).

### 4.2 DESIGN.md: added the missing Phase 2 component definitions

`DESIGN.md` §5 already documented the three layout shells and `TaxonomyBadge`. Added:

- A new **"Entity cards (index rows)"** subsection defining `ProductCard`, `VendorCard`,
  `IntegrationCard` — accurately recording that these currently render as **table rows**
  (`tr[aec-*-card]` attribute selectors projected into `IndexLayout`'s `table-body`),
  with the "card" vocabulary reserved for the future Phase 3 grid tile.
- An **`EntityTable` reconciliation note** — the §11.2 generic `EntityTable` primitive was
  **subsumed into `IndexLayout`** (no standalone class ships); recorded so the spec's
  component list matches the codebase.

All 8 named Phase 2 components (§11.1–11.2) are now defined in DESIGN.md.

---

## 5. Notes & known debt

- **Note A — environment data seeding.** §15.1 and §15.9 ("renders with real data",
  "slugs backfilled 100%") describe capabilities proven against seeded fixtures + the
  backfill script/migration. Actual row presence and the backfill *run* are per-environment
  operational steps (the shared dev DB has at times had 0 products/vendors). The build path
  is complete; seeding/backfilling a given environment is operations, not Phase 2 code.
- **Note B — edge-cache observation is deployed-only.** The MISS→HIT purge cycle (§13.3,
  §15.7) runs via `scripts/run-extra-tests.sh` against a deployed URL; it is intentionally
  **skipped on localhost** because Miniflare's `caches.default` does not emulate the CF
  edge. This is a documented, accepted limitation, not a coverage gap.
- **Note C — color enforcement.** See §3.F4: no dedicated color lint rule exists; the
  spec wording overstates the automation. Components are clean via `impeccable detect`.
- **Latent debt — `--text-tertiary` contrast.** The card empty-state en-dash (`–`)
  placeholders use `--text-tertiary` (≈ 2.6:1 on white, below WCAG AA for normal text).
  They are short non-essential placeholders carrying `aria-label`s and the page-type axe
  scans pass, so this is not a §15 blocker — but it is the same latent contrast debt
  tracked project-wide for `--text-tertiary` and should be revisited when that token is
  addressed.
- **Build noise (non-blocking).** Extraction prints three "File not found in TypeScript
  compilation" notes for `packages/shared/src/{errors,slug,timing-safe-equal}.ts`
  (re-exported via `index.ts` but outside the web tsconfig program). The files are bundled
  correctly; these are build-config notes, not i18n or runtime issues.

---

## 6. Design sign-off (AECI-67 AC)

The AECI-67 AC asks that each new component have a `/impeccable craft` + `/impeccable
polish` history "or equivalent design audit signed off by Chris." Evidence available in
this repo:

- All Phase 2 components were built through the AECI-19 v0 → Angular workflow (recorded in
  each component's header doc comment) and reference their Mobbin anchor (Stripe site
  chrome) per the Anchor-Site Rule.
- `npx impeccable detect` on the Phase 2 components returns **0 findings** (no P0
  anti-patterns).
- axe AA is zero-violation across all page types in CI.

The **formal craft/polish command history per component, or Chris's explicit sign-off,
is a human gate** this report cannot self-certify — flagged here for Chris to confirm.

---

## 7. Hand-off

**Follow-ups filed** (created alongside this report):

- **F2** → [AECI-161](https://linear.app/aec-integrations/issue/AECI-161) — Finish Datadog
  live apply + verification (AECI-66 carryover).
- **F3** → [AECI-162](https://linear.app/aec-integrations/issue/AECI-162) — Extend
  console-error/warning capture to every Phase 2 page type (crawler).

**Ready to mark Phase 2 Done** once Chris confirms:

1. **F1 / §15.2 Lighthouse** — route through the existing **AECI-65** (Phase 2.19,
   Backlog) and decide whether its Lighthouse half stays a Phase 2 merge-blocker or is
   re-scoped to Phase 7 (the code already defers it to Phase 7). Not a blocker for AECI-67.
2. The design sign-off in §6.
3. **F4** (optional) — preference on the color-literal enforcement mechanism.
