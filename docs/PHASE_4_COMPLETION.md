# Phase 4 Completion Report

**Issue:** [AECI-187](https://linear.app/aec-integrations/issue/AECI-187) — Phase 4.12, Phase 4 completion checkpoint
**Spec anchor:** `docs/STAGE_1_SPEC.md` §16 Phase 4 (acceptance). Phase 4 = Home page & stats. Governing detail in §4.1 (home page sections) and §10 (stats pipeline → `stats_cache`).
**Mirrors:** [AECI-67](https://linear.app/aec-integrations/issue/AECI-67) (the Phase 2 gate, Done 2026-06-09) and [AECI-146](https://linear.app/aec-integrations/issue/AECI-146) (the Phase 3 gate, 2026-06-10).
**Evaluated against:** working tree on top of `4481f60`. _(origin/main advanced to `054d428` mid-review — that commit is the Phase 6 spec docs only, `STAGE_1_SPEC.md` hunks at §16 Phase 5 / §11 / §28, none touching the Phase 4 region — Phase-4-irrelevant.)_ · **Date:** 2026-06-10 (UTC)

This is the "Phase 4 is Done" gate. Like AECI-67 and AECI-146 it **surfaces** open items
rather than silently closing them: every AECI-187 acceptance line and every §16 Phase 4
build-order bullet is mapped to ✅ Done / ⚠️ Partial / ❌ Outstanding with concrete
file:line evidence, and each non-green item carries either a follow-up issue or an explicit
written punt.

**Prerequisites met:** the Phase 2 gate (**AECI-67**, Done) and the Phase 3 gate
(**AECI-146**) are closed; Phase 4 inherits their axe/Lighthouse CI wiring (AECI-65) and the
search autocomplete (AECI-144) the home hero reuses.

---

## 1. Verdict

**Phase 4 is functionally complete and shippable.** All eleven Phase 4 build issues
(4.1–4.11 = AECI-176…AECI-186) are merged and **Done**. The stats pipeline is wired end to
end: shared `HomeStatsResponse` types + Zod (4.1), a real `page_views` insert with
Cloudflare enrichment (4.2), the daily compute cron writing the seven `home.*`
`stats_cache` rows on **both** staging and production (4.3), and the read-only
`GET /api/stats/home` endpoint that never live-aggregates and degrades gracefully to a
sparse pre-launch payload (4.4). Observability ships four `aeci.stats.compute*` metrics, a
`aeci.pageviews.write` signal, three Datadog monitors (compute-failed, compute-no-data
freshness, page_views-write-errors), a dashboard definition, and two runbook entries (4.5).
The home page assembles all §4.1 sections (4.6–4.11) — Bone-band hero with the reused
autocomplete, three stats cards including the "+X in the last 30 days" subtitle, the three
live-taxonomy "Browse by" grids, recently-added integrations, and trending products — all
token-driven (zero hardcoded colors), fully i18n-wrapped, SSR-resolved with `route:index` +
`taxonomy` cache tags, and emitting home `WebSite`/`Organization` JSON-LD + canonical + OG
meta. e2e covers all sections plus both-theme axe AA.

**Repo-checkable gates run for this report — all green:**

| Gate | Result |
|------|--------|
| `pnpm lint` (ESLint + Prettier + logical-properties) | ✅ exit 0, "All matched files use Prettier code style!" |
| `ng extract-i18n` (verification only — not committed) | ✅ exit 0, **364 messages**, **zero duplicate-id warnings**, 26 `home.*` ids + `meta.homeTitle`/`meta.homeDescription` present |
| `npx impeccable detect apps/web/src/app/home` | ✅ `[]` — zero findings, zero P0s |
| `tsc -p apps/web/tsconfig.app.json` | ✅ no type errors (modulo the documented `$localize`/spec noise) |
| Hardcoded color literals on home components | ✅ none — tokens/CSS-vars only |

The only items **not** green are **deployed-environment confirmations** — live stats
endpoint, the cron having actually fired, the Datadog monitors being applied, `page_views`
populating on staging, and the Lighthouse `/` budget on a live origin. None is a Phase 4
*build* defect; all need a deployed staging/prod env + `DD_APP_KEY`, so they can't be done
from a static workspace. They are consolidated into one follow-up — **[AECI-222](https://linear.app/aec-integrations/issue/AECI-222)** — exactly as Phase 2 deferred its
Datadog live-apply to [AECI-161](https://linear.app/aec-integrations/issue/AECI-161).

Two **green-closing edits** were made in this issue (see §4): the home route was added to
the Lighthouse collect set (it was missing), and DESIGN.md gained a "Home (Phase 4)"
component subsection (it had none).

---

## 2. Acceptance checklist

### 2a. AECI-187 acceptance criteria

| AC | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| 1 | Every §16 Phase 4 item satisfied → produce `docs/PHASE_4_COMPLETION.md` | ✅ | This document. Per-bullet mapping in §2b; all 11 build issues Done. |
| 2 | Backend: `GET /api/stats/home` valid (possibly sparse) payload; stats cron runs staging+prod writing `stats_cache`; freshness alert live (4.5) | ⚠️ | **Code/config ✅, live ⚠️.** Endpoint reads `stats_cache` only with per-key fallbacks `0`/`null`/`[]` (`apps/api/src/routes/stats.ts:61-118`, esp. `:67` findMany, `:78-108` fallbacks). Cron `"0 7 * * *"` configured **both envs** (`apps/api/wrangler.jsonc:153-154` staging, `:219-220` prod) → `runHomeStatsJob` (`apps/api/src/scheduled.ts:222-272`) → `runHomeStats` (`apps/api/src/lib/home-stats.ts:362-370`). Freshness monitors **defined** (`observability/datadog/monitor-stats-compute-no-data.json`, `-failed.json`). **Live apply + "cron actually fired" → [AECI-222](https://linear.app/aec-integrations/issue/AECI-222).** |
| 3 | `page_views` writes verified populating in **staging**; trending reflects it | ⚠️ | **Code ✅, live ⚠️.** Real insert with CF enrichment (`apps/api/src/routes/page-views.ts:197-212`; CF read `:103-112`; SSR supplementary write `apps/web/src/server-runtime.ts:547-568`). Trending computes from `page_views` (`home-stats.ts` `computeTrendingProducts`). **Staging data confirmation → [AECI-222](https://linear.app/aec-integrations/issue/AECI-222).** |
| 4 | Home: all §4.1 sections; both themes; axe-clean; Lighthouse `/` budgets pass; no console errors; JSON-LD/meta/canonical validated | ⚠️ | **Sections + a11y + SEO ✅; Lighthouse `/` + live console ⚠️.** All §4.1 sections present (§2b). axe AA **both themes** in CI (`apps/web/e2e/home.spec.ts:118-131`). JSON-LD `WebSite`+`Organization` (`apps/web/src/app/core/meta.service.ts:192-196`; asserted `home.spec.ts:198-213`), canonical (`meta.service.ts:180`), OG (`:183-190`). **Lighthouse `/` was missing from `.lighthouserc.cjs` — added in this issue (§4.2);** live-env budget pass + no-console-errors → [AECI-222](https://linear.app/aec-integrations/issue/AECI-222). |
| 5 | `ng extract-i18n` as **verification** (zero hard-coded strings); do **not** commit regenerated `messages.xlf` | ✅ | Ran to a temp path: **exit 0, 364 messages, zero duplicate-id warnings**, 26 `home.*` ids + `meta.home*`. Committed `src/locale/messages.xlf` **untouched** (`git status` clean — en-US source-string convention upheld). |
| 6 | Monorepo lint clean; zero hardcoded color literals on new home components | ✅ | `pnpm lint` exit 0 (ESLint all packages + `check-source-constraints` + Prettier). Home components use only tokens (`text-(--text-primary)`, `bg-(--surface-raised)`, `text-(--accent-primary)`, `bg-(--accent-warm)`, …) — no hex/`rgb()`/raw tailwind palette classes. |
| 7 | `DESIGN.md` updated with every new home component; each has craft+polish history or Chris sign-off | ⚠️ | **DESIGN.md updated in this issue (§4.1)** — added a "Home (Phase 4)" subsection documenting all six home components (hero, stats-cards, browse-grid, recent-integrations + integration-tile, trending). Design pass recorded in `docs/design/home-direction.md` (AECI-181, Faire anchor). The **formal per-component craft/polish history or Chris's explicit sign-off is a human gate** this report can't self-certify — flagged in §6. |
| 8 | Outstanding items get a follow-up Phase 4.x issue or explicit written punt | ✅ | One consolidated follow-up filed: **[AECI-222](https://linear.app/aec-integrations/issue/AECI-222)** (operational verification). Lighthouse enforcement punt is written (§3). |

### 2b. §16 Phase 4 build-order bullets

| §16 bullet | Issue | Status | Evidence |
|-----------|-------|--------|----------|
| Shared `HomeStatsResponse` types + Zod (`packages/shared`) | AECI-176 | ✅ | `packages/shared/src/api/stats.ts:136-145` (`HomeStatsResponseSchema` + 7 per-key value schemas `:109-120`); tests `stats.spec.ts`. |
| Wire `page_views` writes + CF enrichment | AECI-177 | ✅ | `apps/api/src/routes/page-views.ts:197-212` (real `pageView.create`), CF read `:103-112`, header consts `packages/shared/src/api/page-views.ts:40-45`, SSR write `apps/web/src/server-runtime.ts:547-568`; tests `page-views.spec.ts`. |
| Daily stats job → `stats_cache` (third cron; §10) | AECI-178 | ✅ | `apps/api/src/scheduled.ts:74` (`STATS_CRON='0 7 * * *'`), `:222-272`; compute `apps/api/src/lib/home-stats.ts:272-298,317-328,362-370`; crons both envs `wrangler.jsonc:153-154,219-220`; tests `home-stats.spec.ts`, `scheduled.spec.ts`. |
| `GET /api/stats/home` (reads cache, never live-aggregates) | AECI-179 | ✅ | `apps/api/src/routes/stats.ts:61-118` (`findMany` over `home.*` keys `:67`; graceful fallbacks `:78-108`); tests `stats.spec.ts`. |
| Stats pipeline + page_views observability (job health + freshness alert) | AECI-180 | ✅ | 4 metrics `apps/api/src/lib/home-stats-metrics.ts:61-75`; `aeci.pageviews.write` `page-views.ts:213,215`; 3 monitors + 1 dashboard in `observability/datadog/`; catalog `docs/OBSERVABILITY.md`; runbooks `docs/RUNBOOKS.md:170-264`. _(Live apply → AECI-222.)_ |
| Home page design pass (Impeccable shape + Mobbin anchor) | AECI-181 | ✅ | `docs/design/home-direction.md` — settled direction, **Faire** anchor (FARFETCH "Editor's picks" as the in-library Mobbin corroborator), Anchor-Site Rule recorded. |
| Home hero + search autocomplete mount (reuses AECI-144) | AECI-182 | ✅ | `apps/web/src/app/home/home-hero.ts` — Bone band, Display tagline, mounts `<aec-search-autocomplete>`. |
| Three stats cards incl. "+X in the last 30 days" subtitle | AECI-183 | ✅ | `apps/web/src/app/home/home-stats-cards.ts:54-56` (`@@home.stats.total.delta`, rendered only when delta > 0); product → `/products/:slug` `:69-86`, category → `/categories/:slug` `:102-116`; empty states `:58-127`. |
| "Browse by" category/audience/phase grids (live taxonomy) | AECI-184 | ✅ | `apps/web/src/app/home/browse-grid.ts` reading `product_count` from `home-browse.resolver.ts:55` → `GET /api/taxonomy` (**live**, not `stats_cache`). |
| Recently-added integrations + Trending products (graceful empty states) | AECI-185 | ✅ | `recent-integrations-section.ts` (+ `integration-tile.ts`) last-10 2-up, empty state `:41-48`; `trending-products-section.ts` top-5 via reused `ProductCardGrid`, recently-added fallback `:74-76`, empty state `:48-54`. |
| Home page assembly: SSR route/resolver, cache tags, home JSON-LD | AECI-186 | ✅ | Route `apps/web/src/app/app.routes.ts:33-38` (browse + stats resolvers); cache tag `apps/web/src/server/cache-tags.ts:109` (`route:index` + `taxonomy`); TTL `server-runtime.ts:264`; JSON-LD/meta/canonical `core/meta.service.ts:172-197`; e2e `home.spec.ts`. |

**Score: AC — 4 ✅ / 4 ⚠️ · §16 bullets — 11 ✅ / 0 ⚠️ / 0 ❌.** Every ⚠️ is a
deployed-env confirmation (AECI-222) or a human sign-off gate — not a Phase 4 build defect.

---

## 3. Outstanding items — follow-ups & punts

### F1 — Phase 4 operational verification → **new [AECI-222](https://linear.app/aec-integrations/issue/AECI-222)**

Everything in AECI-187's "backend verified / page_views in staging / Lighthouse `/`" ACs
that needs a **deployed environment** is bundled here (the Phase 4 analogue of AECI-161 for
Phase 2). The code + config is all merged and green; what remains is live confirmation:

- `GET /api/stats/home` returns a valid (sparse-ok) payload on staging + prod.
- The `0 7 * * *` cron actually fired on staging + prod and wrote the seven `home.*`
  `stats_cache` rows (recent `computed_at`; `aeci.stats.compute{trigger:cron}` heartbeat).
- Apply `dashboard-home-stats.json` + the 3 AECI-180 monitors to the live Datadog org;
  paste the dashboard **Live URL** into `docs/OBSERVABILITY.md` (replace TBD); swap any
  `@NOTIFICATION_CHANNEL_TBD`; confirm the freshness ("not running") monitor routes/fires.
  (`docs/OBSERVABILITY.md` already flags this step as "coordinate with AECI-161".)
- `page_views` inserts populate on staging (CF columns set) and the next compute makes
  `home.trending_products` reflect them.
- Lighthouse `/` passes its class-A budgets on a deployed origin (warn-level), and `/`
  renders both themes with no console errors.

### Punt (written) — Lighthouse `/` warn→error **enforcement** rides the existing carryover

The home route is now **collected** by `.lighthouserc.cjs` (added in this issue, §4.2), so
`/` is measured in CI like every other indexable page — but the harness is **warn-only**
(`deploy.yml` lighthouse job parked `if: false`). Flipping warn→error is the same global
carryover that **AECI-65** owns and **[AECI-188](https://linear.app/aec-integrations/issue/AECI-188)** tracks (filed by the Phase 3 gate for `/search`). `/` simply joins the
indexable class on that flip; **no new enforcement issue** — it would duplicate AECI-188.
This is a deliberate punt, not a gap: the Phase 4 budgets are defined and warn-visible now;
blocking-enforcement is one decision for all pages at once.

### Not a defect — taxonomy/audience/phase `*_counts` `stats_cache` keys are deferred

§10 lists `category_counts` / `audience_counts` / `phase_counts` cache keys, but the §10
"Phase 4 reconciliation (2026-06-10)" note already supersedes them: the "Browse by" grids
read the **live** taxonomy endpoints (which already return `product_count`), so those three
cache keys are intentionally **not** produced. The home implementation matches the
reconciled spec (`browse-grid.ts` ← `home-browse.resolver.ts` ← `/api/taxonomy`). Recorded
so the absence isn't mistaken for a miss.

---

## 4. Work done in this issue

### 4.1 DESIGN.md: added the "Home (Phase 4)" component subsection

DESIGN.md §5 referenced the home only tangentially (Display-type usage, the Bone hero-band
rule, the autocomplete-reuse note, the AECI-190 `ProductCardGrid` the home borrows) but had
**no** subsection cataloguing the actual new home components — the same gap the Phase 3 gate
closed for search. Added a **"Home (Phase 4)"** subsection documenting all six: the
`<aec-home-hero>` Bone band (Display tagline + reused `<aec-search-autocomplete>` +
progressive-enhancement popular row), the `<aec-home-stats-cards>` three bordered cards
(incl. the "+X in the last 30 days" subtitle and the deliberate avoidance of the rejected
hero-metric template), the `<app-browse-grid>` count-chip grid (live taxonomy, not the
cache), `<aec-recent-integrations-section>` + `<aec-integration-tile>`, and
`<aec-trending-products-section>` (reused `ProductCardGrid` with a recently-added fallback).
The Faire Anchor-Site provenance points to `docs/design/home-direction.md`. Prettier-clean.

### 4.2 `.lighthouserc.cjs`: added `/` (home) to the collect set

The home route `/` was **absent** from `ci.collect.url` (the list jumped straight from the
config's single-`/` Phase 1 origin to the 14 Phase 2/3 URLs). LHCI only audits URLs it is
explicitly given — there is no implicit landing on `/` — so the AC "Lighthouse budgets pass
for `/`" had no coverage at all. Added `${baseUrl}/` as the first collect entry (and bumped
the "14 URLs" comment to 15). `/` matches `INDEXABLE_URL_PATTERN` (verified by regex test) →
**class A**: performance / accessibility / best-practices / SEO + LCP/CLS/TBT, warn-level.
It correctly does **not** match the detail-only JS-budget class, the noindex class, or the
`/search` TTFB class. Same SEO-safe, warn-only posture as every other indexable page;
enforcement rides AECI-188 (§3). Prettier-clean.

_(No application code, schema, or component was changed in this issue — Phase 4 build work
shipped in AECI-176…AECI-186. This gate only added the two doc/config artifacts above and
this report.)_

---

## 5. Notes & known debt

- **Note A — environment data + live apply is operational.** As with the Phase 2/3 gates,
  "endpoint returns a payload" / "cron fired" / "monitors live" / "page_views populating"
  describe the shipped *capability* and its tests; the actual deployed-env behavior is
  operational and tracked in **AECI-222**. Per memory, the running app (local `dev:bound` +
  all CI e2e) reads the shared `aeci-development` DB via Accelerate, which now has data — so
  the home renders real content in CI, but the staging/prod stats cron + monitors are a
  live-org step.
- **Note B — graceful empty/sparse states are first-class.** `GET /api/stats/home` returns
  `0`/`null`/`[]` fallbacks for any missing `stats_cache` key (`stats.ts:78-108`), and every
  home section renders a bordered, i18n'd empty state (stats cards, recently-added,
  trending). This is the pre-launch path: a sparse cache and an empty `page_views`/
  integrations set render cleanly rather than as errors or bare zeros. Integrations stay
  empty until AECI-86 seeding returns.
- **Note C — edge-cache observation is deployed-only.** The home's `route:index` + `taxonomy`
  cache-tag wiring is unit/e2e-asserted (`cache-tags.ts:109`, `home.spec.ts:49-51`), but the
  MISS→HIT behavior and tag-purge cycle are only observable against a deployed CF edge
  (Miniflare's `caches.default` ≠ the edge) — same caveat as Phase 2/3.
- **Latent debt — `--text-tertiary` contrast.** Per the project-wide note, `--text-tertiary`
  (~2.6:1 on white) fails WCAG AA for normal text; home components use `--text-secondary`
  for small supporting text and pass axe AA both themes. Revisit when that token is fixed.
- **Build noise (non-blocking).** `ng extract-i18n` prints "File not found in TypeScript
  compilation" notes for `packages/shared/src/**` re-exports (bundled correctly, outside the
  web tsconfig program) — documented since AECI-67 §5; build-config notes, not i18n/runtime
  issues.

---

## 6. Design sign-off (AECI-187 / AECI-146 / AECI-67 convention)

- The home surface was built through the v0 → Angular workflow against the **Faire** anchor
  recorded in `docs/design/home-direction.md` (AECI-181, per the Anchor-Site Rule), reusing
  the AECI-190 Faire vocabulary so the front door and the catalog read as one publication.
- DESIGN.md now documents every shipped home component (§4.1), both themes, with token-only
  color and full i18n.
- axe AA is zero-violation on `/` in **both** themes in CI (`home.spec.ts:118-131`);
  `impeccable detect` on the home dir returns `[]`.
- The **formal `/impeccable` craft + polish history per component, or Chris's explicit
  sign-off, is a human gate** this report can't self-certify — flagged for Chris to confirm.

---

## 7. Hand-off

**Follow-up filed** (created alongside this report, Stage 1 Build, assigned to Chris):

- **F1** → [AECI-222](https://linear.app/aec-integrations/issue/AECI-222) — Phase 4
  operational verification: live stats endpoint, daily cron fired, Datadog Phase 4 apply,
  staging `page_views`, Lighthouse `/` on a deployed env.

**Already tracked:** [AECI-188](https://linear.app/aec-integrations/issue/AECI-188) /
[AECI-65](https://linear.app/aec-integrations/issue/AECI-65) — the global Lighthouse
warn→error enforcement flip (`/` joins the indexable class on that flip).
[AECI-161](https://linear.app/aec-integrations/issue/AECI-161) — the Phase 2 Datadog
live-apply (coordinate the Phase 4 apply with it).

**Ready to mark Phase 4 Done** once Chris confirms:

1. The deployed-env operational items (AECI-222) are acceptable to verify post-merge, not as
   a build blocker (matches how Phase 2's Datadog apply was deferred to AECI-161).
2. The Lighthouse `/` enforcement punt — `/` measured warn-only now, warn→error via
   AECI-188 — is acceptable for launch.
3. The design sign-off in §6 (per-component craft/polish history or explicit sign-off).
