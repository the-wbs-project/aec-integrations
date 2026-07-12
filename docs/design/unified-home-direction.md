# Unified home — build direction (AECI-270)

Status: **settled** (positioning, section order, reconciliation, and concept). Chosen concept: **b · warm commerce** (2026-06-25). The direction the AECI-269 build children (2–6) build against.
Source issue: **AECI-270** (the direction-setting child of **AECI-269**, "unify the marketing landing page + app home into one launch front door"). Spec anchor: `docs/STAGE_1_SPEC.md` §4.1 (rewritten by this issue).
Contracts: `DESIGN.md` (laws + Anchor-Site Rule → Faire), `PRODUCT.md` (voice / audiences / banned words), `packages/shared/src/api/{stats,taxonomy,landing}.ts`.

> **Supersedes the *page contract* of [`home-direction.md`](./home-direction.md) (AECI-181).** That doc settled the Phase 4 **directory-only** home (hero → trust → stats → browse → recent → trending) and the Phase 4.7–4.11 components shipped against it. This doc widens the contract to the **unified marketing + directory** home: it sets the order + the NEW bands and **reuses** `home-direction.md`'s hero / stats / browse / trust treatments verbatim. Where the two disagree (section order, the trust band's role), **this doc wins**; everywhere else `home-direction.md` still governs.

The live concepts are the dev-only **`/preview/unified-home`** route (`apps/web/src/app/preview/unified-home/`), three live-toggleable variants reviewed in the running app (`pnpm dev:agent`) per `LESSONS.md` 2026-06-10. This doc is the contract a build-child port is reviewed against; the preview route is the selection tool.

## Canonical positioning

The home's one-liner is:

> **The independent directory of AEC software integrations. No vendor marketing, no pay-for-placement.**

Three live expressions ladder up to it (reconciled in AECI-270):

| Surface | String | File |
|---|---|---|
| Hero lede | "The independent directory of integrations across the AEC stack, with no vendor marketing and no pay-for-placement." | `home-hero.ts` (`@@home.hero.lede`) |
| Footer tagline | "The independent directory of AEC software integrations." | `site-footer.ts` (`@@app.footer.tagline`) |
| Meta description | "The independent directory of AEC software integrations. No vendor marketing, no pay-for-placement." | `core/meta.service.ts` (`@@meta.homeDescription`) |

The hero **tagline** ("Find the integrations between your AEC tools.") is unchanged — it is the verb-forward hook; the lede now carries the positioning. **No launch copy claims integrations are "verified"** — nothing is dual-vendor-verified at Stage 1 (spec §1; §4.2 verified-badge placeholder). This is why the prior footer "Vendor-verified reviews…" tagline was reconciled out: the directory, not a verified-review claim, is the honest anchor at launch.

## The page as one publication — section rhythm

One column of stacked modules in the standard shell (`SiteHeader` + Bone shelf above, `SiteFooter` below). The home serves **two readers on one editorial spine**, and the order is chosen so neither path is blocked by the other:

- **Cold visitor** (doesn't know AECi): hero lede → **why** the landscape is broken → **what's different** → **how it works** → the live directory as proof.
- **Ready visitor** (here to look something up): hero **search** → **browse** chips → **stats / recent / trending** data, with a credibility cue up top so they trust what they're about to read.

```
1  Hero + search            (existing)   ── lede for cold, search for ready
2  Credibility strip        NEW          ── coverage counts + independence (trust cue, both readers)
3  Why AECi / the problem   NEW          ── cold path: the broken landscape + 3 cited stats
4  What's different / trust REWORK        ── cold path: the three ideas + the trust promise
5  How it works             NEW          ── cold path: earns the "reviews" framing
6  Stats cards              (existing)   ── ready path: live directory data
7  Browse cat/aud/phase     existing+NEW ── ready path: audience facet is the "this is for you" recognition band (home-audience.ts, AECI-274); cat/phase stay browse chips
8  Recently added + trending(existing)   ── ready path: proof the directory is alive
9  Closing CTA + capture    NEW          ── both: email + suggest-a-tool
10 Footer                   (existing)
```

**Texture variation is the anti-monotony device** (DESIGN.md "no identical card grids"). The marketing bands (2–5) read as **editorial prose + spec-sheet stat rows + a numbered list** — a different texture from the data modules (6–8), which are the shipped **count-chips, stats cards, and the broken product grid**. Stacking five identical card matrices is the failure mode; alternating prose ↔ chips ↔ cards ↔ broken-grid is what makes it read as one publication rather than a template. The marketing intro (2–5) is a contiguous block between the hero and the data; the CTA (9) is the only marketing band below the fold, after the directory has done its proving.

## The new bands (treatment)

All bands are **static, SSR-safe, edge-cache-neutral** unless noted, and obey the DESIGN.md laws: Forest is the only CTA/figure color (Forest-Anchor Rule), Clay ≤5% decorative-only, Bone is an accent band never a page background, **borders not shadows**, Source Serif headlines (≥18px) + Atkinson body, sentence case, **no em dashes**, no banned hero-metric template, Lucide glyphs only. No new tokens (see "Tokens").

### 2 — Credibility strip
A thin band directly under the hero: **coverage counts** (products / integrations / vendors) + the line "Independent and editorially neutral. No vendor marketing, no pay-for-placement." Counts are **live** (`GET /api/stats/home` for the integration total; taxonomy/product/vendor totals from the stats payload or `GET /api/taxonomy`), so the strip needs a real **empty state**: when a count is 0, drop that figure rather than render a bare "0", and fall back to the independence line alone. This is a coverage *fact row*, not the banned hero-metric template (no sparkline, no gradient, label always present).

### 3 — Why AECi / the problem
The broken-landscape narrative, translated from the landing into the editorial voice (no em dashes, no "verified" overclaim): two short paragraphs (pay-to-play rankings, AI reviews, vendor-funded visibility; and the information that actually decides a purchase is impossible to find), then **three cited figures** in a **spec-sheet row** (label-value, hairline-separated), not big-number cards: ≈34% of reviews AI-generated · $87K/yr to boost a ranking · 900+ tools in generic categories. Figures are **static cited stats**, not live data.

> **Built: AECI-272** — `apps/web/src/app/home/home-why.ts` (mounted after the credibility strip). Shipped the **chosen concept-b** treatment: bordered Forest-figure stat cards on `--surface-raised` (not the spec-sheet row above; concept b governs). **Sourcing (interim):** the legacy landing recorded no sources for the three figures and the app has no citation pattern, so the figures keep their hedged framing ("≈", "estimated to be") plus one understated "Figures are industry estimates" note (`@@home.why.estimatesNote`). **AECI-285 (shipped)** then replaced that interim: figures revised to **≈19%** (AI-generated Google reviews, Originality.AI) and **$27K** (median annual G2 vendor spend, Vendr); 900+ kept (Capterra covers ~986 in one generic category); and the blanket estimates note retired in favour of a per-figure **"Source"** link with an accessible hover/focus citation reveal (CSS-only, band stays static/cache-neutral). Research + citations: `docs/design/home-why-market-figures.md`.

### 4 — What's different / trust (the reconciliation)
This band is the **rework of `home-trust-pillars.ts`** (AECI-269 build child 4). It reconciles two "threes":

- **Shipped trust band** = three *operator promises* ("Trust is the product": never sell rankings · always be transparent · never review products ourselves).
- **Landing** = three *product differentiators* ("Three ideas at the core": reviewable integrations · separate product + onboarding ratings · no pay-to-rank).

**Decision:** the band **leads with the three product ideas** (what AECi does differently) and **folds the operator promise in as the trust underpinning**, rather than running two near-duplicate "three" bands (their overlap is "no pay-for-placement" = "never sell rankings"):

1. **Reviewable integrations** — each integration is a reviewable object (what it links, how data flows, where it falls short), not a logo on a grid. *(Stage-1 honest: describes the model; does not claim a verified catalog exists.)*
2. **Separate ratings for product and onboarding** — rated separately, not collapsed into one score.
3. **No pay-for-placement, ever** — listings never boosted by spend; transparent ranking method; vendor responses sit alongside criticism.
- **Trust closing line** (the absorbed operator promise): "We earn revenue from vendors who want to be found, never from changing what you see."

So the standalone "Trust is the product" band is **absorbed here**, not kept as a separate 11th section. The shipped Clay-on-Forest treatment is available to reuse, but the reconciled content leads; build child 4 owns the implementation.

### 5 — How it works
A compact three-step band that **earns the "reviews" framing** the footer used to assert: (1) integrations are documented (what they link, mechanism, direction), (2) practitioners review them (product and onboarding separately), (3) nothing is for sale (position earned by relevance and reviews). Framed as the **operating model**, present tense, with no claim that a verified/reviewed inventory already exists at launch.

### 9 — Closing CTA + capture
Email signup + suggest-a-tool, translated from the landing's "Get notified when we launch" + feedback modal. **The one client-state surface on the page:** a **progressively-enhanced client island** whose SSR HTML is the static form, POSTing to the **non-cached** `/api/*` so the route stays edge-cache-neutral (spec §9; §4.1 non-negotiables). Email → `POST /api/subscribe`; suggest-a-tool / feedback → `POST /api/feedback` (both shipped, AECI-257; contract in `API_CONTRACTS.md` §6.13). Forest CTA (Forest-Anchor Rule); real `<label for>` (sr-only acceptable), never placeholder-as-label; `aria-live` status line for the async result.

## The three concepts (live-toggleable)

Three distinct Faire-anchored **editorial spines** for the new bands, all within the DESIGN.md laws — the choice is one of *posture*, not of which laws apply. Toggle them at **`/preview/unified-home`**.

- **a · Editorial restraint** — the trade-journal spine. Hairline rules between bands, numbered kickers ("01 / The problem"), the problem stats as a hairline-divided spec row, the three ideas as a numbered editorial list, near-zero fills, Bone reserved to the hero + closing CTA. The most "published artifact" reading.
- **b · Warm commerce** — Faire-forward. Bone bands for the credibility strip + CTA, bordered cards (borders, not shadows) for the problem stats / the three ideas / how-it-works, a single decorative Clay tick on the idea cards (≤5%). More visual, still editorial and restrained.
- **c · Data-forward** — the directory-confident spine. A prominent live-count bar under the hero, a compressed problem (one paragraph + an inline stat trio), **what's-different and how-it-works merged** into one tight band, and the data sections carrying the weight. Pulls the ready-visitor path forward and treats the working directory as the proof.

### Chosen concept — **b · Warm commerce** (2026-06-25)

Chris selected **concept b** from the live `/preview/unified-home` review. It is the buyer-facing, commerce-leaning posture (the standing toggleable-premium-options preference) that still reads as editorial restraint: Bone warmth and bordered cards, never SaaS gloss. No cross-concept grafts.

**What this fixes for the build children (AECI-269 2–6), all within the DESIGN.md laws:**

- **Credibility strip (child 2):** a full-bleed **Bone** (`--accent-warm`) band; coverage counts as small bordered count-chips on `--surface-base`; the independence line alongside. Real empty state when a count is 0.
- **Why / problem (child 3):** the eyebrow carries a small decorative **Clay dot** (`--accent-secondary`, fill only, `aria-hidden`, well under the ≤5% cap); the narrative sits in a rounded **Bone callout** (border, not shadow); the three figures are bordered stat cards on `--surface-raised` with **Forest** figures (not the banned hero-metric template). **Built: AECI-272** (`home-why.ts`); figure sourcing researched in **AECI-285** (`docs/design/home-why-market-figures.md`).
- **What's different + how it works (child 4 — the `home-trust-pillars.ts` rework):** the three ideas as bordered cards on `--surface-raised`, each with a **Clay top-tick** bar (decorative fill, the shipped trust-band vocabulary, ≤5%); the trust line folded in as the closing; how-it-works as bordered step cards with **Forest-circled** numerals. **Rework note:** the shipped `home-trust-pillars.ts` uses `shadow-sm` / `hover:shadow-lg`, which violates the Borders-Not-Shadows Rule (this predates AECI-270); the rework must drop the shadows for borders, as the concept does. **Shipped (AECI-273):** the home's "what's different" band is a **new** `home-differentiation.ts` (bordered cards on `--surface-raised`, Clay top-tick, the trust line folded in as the closing) + new `home-how-it-works.ts`; both mount inside the centred home column in §4.1 order. The how-it-works copy uses the operating-model lineup (documented · practitioners review product/onboarding separately · nothing for sale), no "verified" claim. **Not** an in-place rework of `home-trust-pillars.ts` after all: that band is shared with `/about` (the standalone "three trust commitments"), so it is left untouched there and the home gets its own component — no second trust block on the home, since the trust band is no longer mounted on `/`.
- **Audience "this is for you" (child 5 — built: AECI-274, `home-audience.ts`):** the audience facet's `browse-grid` instance is **replaced** by a dedicated recognition band so the page keeps **one** coherent audience moment (the AC's non-negotiable), not two. Treatment: an eyebrow with the decorative **Clay** dot (matching `home-why.ts`), an `<h2>` recognition headline, and a use-case lede ("comparing three to five tools in a category … justifying a decision to a steering committee") + the legacy landing's ten role callouts inside a rounded **Bone** callout (`--accent-warm`, border not shadow). Nine roles link to `/audiences/:slug` via the shipped `TaxonomyBadge` (live `product_count` when > 0); the one with no good audience term (Technology directors) renders as plain recognition text, never a dead link. Category + phase keep the `browse-grid.ts` count-chips — the richer audience module between them is the intended texture variation.
- **Closing CTA (child 6):** a **Bone** band with the capture form in a bordered `--surface-base` card; **Forest** subscribe button (Forest-Anchor Rule); the suggest-a-tool link beside it. Progressive-enhancement island POSTing to the non-cached `/api/*` (§4.1). **Built: AECI-275** (`home-closing-cta.ts` + the `@defer`-loaded `home-feedback-dialog.ts` / `home-feedback-form.ts`); email → `POST /api/subscribe`, suggest-a-tool → `POST /api/feedback`; geo enriched server-side on trusted `LANDING_CF_HEADERS`. **AECI-327** extracted the email capture into a shared `aec-mailing-list-signup` band (`apps/web/src/app/shared/mailing-list-signup/`) so the same prominent signup also rides the directory + detail pages; `home-closing-cta.ts` now composes that band and projects the suggest-a-tool prompt into its content slot.
- **Existing modules** (hero / stats / browse / recent / trending) keep their `home-direction.md` treatment unchanged.

The live concept route (`apps/web/src/app/preview/unified-home/`) defaults to **b** so the chosen direction opens first; the a / c variants stay toggleable for reference. Verified on the concept route: axe 0 violations (all three concepts), `impeccable detect` clean, light theme only.

## Reuse (components)

**Reuse as shipped (do not reinvent)** — the existing modules keep their `home-direction.md` treatment:

| Module | Component |
|---|---|
| Hero + search | `home-hero.ts` (reuses `SearchAutocomplete`) |
| Stats cards | `home-stats-cards.ts` (`IntegrationStat` headline, `LogoOrInitial`) |
| Browse chips | `browse-grid.ts` (`TaxonomyBadge`) |
| Recently added | `recent-integrations-section.ts` |
| Trending | `trending-products-section.ts` (`ProductCardGrid` broken grid) |
| Header / footer | `SiteHeader`, `SiteFooter` (`layout/`) |

**New, built by the AECI-269 children (in `apps/web/src/app/home/`, token-driven, i18n `@@`-wrapped, signals + zoneless, SSR-safe):** the credibility strip (child 2), the why/problem band (child 3), the what's-different/how-it-works rework of `home-trust-pillars.ts` (child 4), the audience "this is for you" recognition band `home-audience.ts` that **replaces** the audience `browse-grid` instance (child 5, AECI-274), and the closing CTA + capture island (child 6). The home assembly (`home.ts`) restacks them in the §4.1 order.

**Page-level banding (readability).** Beyond the per-section texture variation above, the `home.ts` assembly groups the stacked sections into full-bleed bands with a hairline top border (`--border-default`) and an **alternating ground**, so each reads as a distinct moment rather than one flat `--surface-base` column: hero (Bone) → credibility + why (white) → what's-different + how-it-works (`--accent-primary-soft`, Forest-soft) → stats + category + audience (white) → phase + recent + trending (`--accent-primary-soft`) → closing CTA (Bone). The two Bone bookends frame the page; the white ↔ Forest-soft alternation between them supplies the landmarks (`--surface-sunken` reads too close to white to register as a band). Each section component stays a background-agnostic bare `<section>`; the band wrapper (ground + `max-w-7xl` + vertical rhythm) lives at the page level. Forest-soft as a full-bleed band ground follows the established `aec-waitlist-welcome` pattern; the page `<body>` itself stays neutral `--surface-base`, so the Surfaces-Are-Neutral rule holds.

## Empty / pre-launch state

The existing-module empties are unchanged (`home-direction.md`). New:

- **Credibility counts at 0:** drop the zero figure, never render a bare "0"; the independence line stands alone. The strip never disappears.
- **Capture island:** static SSR form renders regardless of JS; the success / "already on the list" / error copy is the `aria-live` status line after the POST resolves.

## Guardrails honored

Source Serif 4 + Atkinson Hyperlegible Next only · Forest anchor (every CTA + figure) · Clay only as a decorative accent on concept **b**, under the ≤5% cap · Bone only as an accent band (hero / credibility / CTA per concept), never a page background · borders not shadows · sentence case · **no em dashes** (the landing's em dashes are removed in translation) · no banned hero-metric template (problem stats are a labelled spec row / bordered cards, no sparkline / gradient) · Lucide glyphs only, no emoji · **light only** (Stage 1, AECI-226) · edge-cache-neutral SSR (the capture island is the only client-state surface) · empty states real.

## Tokens

**No new design tokens.** The bands use only existing tokens (`--accent-warm` Bone, `--accent-primary` / `--accent-primary-hover` Forest, `--accent-primary-soft` Forest-soft (the page-level band ground, see "Page-level banding"), `--accent-secondary` Clay, `--surface-base` / `--surface-raised` / `--surface-sunken`, `--border-default` / `--border-strong`, the text scale, `--radius-sm` / `--radius-lg`). If a build child discovers a genuine new token need, add it to `DESIGN.md` (and `styles.css` + `BRAND_GUIDELINES.md` + `STAGE_1_SPEC.md` §2a.2 in lockstep) **before** using it.
