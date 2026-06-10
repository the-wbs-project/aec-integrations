# Home page — build direction (AECI-181)

Status: **settled.** The direction the Phase 4 home-build issues (4.7–4.11) build against.
Source issue: **AECI-181** (Phase 4.6 design pass). Spec anchor: `docs/STAGE_1_SPEC.md` §4.1.
Contracts: `DESIGN.md` (laws + Anchor-Site Rule), `PRODUCT.md` (voice/audience),
`packages/shared/src/api/stats.ts` (`HomeStatsResponse`).

This doc is self-contained: it is the contract a 4.7–4.11 port is reviewed against. The
live concept prototype (`.context/aeci-181-home-concepts.html`, gitignored ephemeral
selection tooling per `workflow.md` §7) and the critique baseline
(`.impeccable/critique/home-baseline-2026-06-10.md`) are workspace references, not the contract.

## Anchor site: Faire

**The home's Mobbin anchor is Faire** (commerce / curated card-grid), recorded here per the
DESIGN.md **Anchor-Site Rule**. Chris selected it from three live-toggleable concepts (Faire /
HODINKEE / Blend) on 2026-06-10.

Why Faire:

- **Editorial coherence.** AECI-190 shipped `/products` Faire-anchored (broken card grid, Bone
  featured-lead band, `IntegrationStat` headline). Anchoring the home to the same site makes the
  front door and the catalog read as **one publication**, not a mashup, which is the whole point
  of the Anchor-Site Rule.
- **Premium / commerce posture** matches Chris's standing preference for buyer-facing surfaces,
  while staying editorially restrained (the hero does not become a generic marketplace).

Mobbin evidence (full notes: `.context/aeci-181-anchor-research.md`): Faire's own web app is
**not in Mobbin's library**, so the closest in-library premium editorial-commerce reference,
**FARFETCH "Editor's picks"** ([screen](https://mobbin.com/screens/515ac38a-89fe-4479-a10f-4402d4f84576)),
was recorded as the corroborating Mobbin anchor — restrained wordmark, header search, curated
editorial product cards, warm-neutral restraint (no marketplace cream). The shipped AECI-190
components are the concrete Faire vocabulary the home reuses.

> Anchor-Site Rule, recorded: **components for the home come from the Faire vocabulary**
> (the AECI-190 set). Any component pulled from a different reference for the home is a deliberate,
> documented exception, not a default.

## Page contract (fixed by §4.1 — this doc sets *treatment*, not content)

Order is fixed; the home is one column of stacked modules inside the standard `max-w-7xl` shell
(the existing `SiteHeader` + Bone shelf above, `SiteFooter` below):

1. **Hero** — tagline + search (reuse `SearchAutocomplete`).
2. **Three stats cards** — total integrations (+30d) · most-integrated product · most-active category.
3. **Browse by category** — top categories with counts.
4. **Browse by audience** — same pattern.
5. **Browse by project phase** — same pattern.
6. **Recently added integrations** — last 10, source → target.
7. **Trending products this week** — top 5 most-viewed.
8. **Footer** — existing `SiteFooter`.

**Data:** `GET /api/stats/home` → `HomeStatsResponse` (read from `stats_cache`, never live-aggregated).
`most_integrated_product` and `most_active_category` are **nullable**; `recent_integrations`,
`trending_products` are arrays that can be empty. Every module must render its real empty state.

## Hero (Faire treatment)

- **Warm Bone band.** The hero sits on a full-bleed `--accent-warm` (Bone) band with a 1px
  `--border-default` bottom rule. Bone is the warm commerce signal; it is an accent band here, not
  a page background (DESIGN.md Surfaces-Are-Neutral Rule).
- **Left-aligned, restrained.** Inside the band, a constrained column (`max-w-3xl`):
  - small-caps eyebrow (`--text-secondary`), e.g. "The specifier's reference for AEC software";
  - **Display** tagline — Source Serif 4 **400**, `clamp(2.25rem, 4.5vw + 1rem, 4rem)`, lh 1.05,
    tracking -0.01em. Leads with the substantive claim (trust / what-connects-to-what), not a verb
    imperative. Placeholder copy is fine; final marketing copy is out of scope for this pass.
  - one-line `--text-secondary` lede;
  - the search field as the single primary affordance.
- **Search:** reuse `SearchAutocomplete` (`apps/web/src/app/search/search-autocomplete.ts`,
  AECI-144). It SSR-renders the static form and hydration-enhances; it degrades to a plain
  submit-to-`/search` field when Algolia config is absent (correct for the cached home). Real
  `<label for>` (sr-only acceptable), never placeholder-as-label. Forest focus ring.
- A short row of **"Popular:" quick links** to top category browse pages sits under the search
  (text links with a hairline underline), giving a no-typing entry path.
- **No** stock photography, gradient, or large hero imagery (PRODUCT.md anti-references).

## Three stats cards — editorial, NOT the banned hero-metric template

DESIGN.md §6 bans the hero-metric template (big number + small label + sparkline + gradient). The
cards use the **score-display / spec-sheet** posture:

- A responsive 3-up grid (`sm` 1-col → `md+` 3-col) of bordered cards: `--surface-raised`,
  1px `--border-default` → `--border-strong` on hover for the linked cards, `rounded-(--radius-lg)`,
  **no shadow**.
- **Card 1 — total integrations indexed:** the figure is a large **Forest** Source-Serif numeral
  (`tabular-nums`); below it, "+X in the last 30 days" as a quiet `--text-secondary` line. No
  trend chart, no sparkline.
- **Card 2 — most integrated product** (link → `/products/:slug`): sentence-case label, a
  `LogoOrInitial` (sm) monogram + product name (Source Serif), and the count via the shipped
  **`IntegrationStat` `headline` variant** (large Forest figure + pluralized noun). Reuse the
  component; do not build a new metric card.
- **Card 3 — most active category** (link → `/categories/:slug`): sentence-case label, category
  name (Source Serif), and its integration count via `IntegrationStat` `headline`.
- **Clay budget: spent nowhere.** Forest carries every figure; Clay stays at 0% on this surface
  (well under the ≤5% cap, body-contrast safe).

## Section rhythm — break the grid

Avoid three identical card matrices stacked (DESIGN.md "no identical card grids"):

- **Browse (category / audience / phase):** three labelled subsections, each a flex-wrap of
  **count-chips** ("{term} {count}", `--surface-raised` bordered `rounded-(--radius-sm)`,
  `tabular-nums` count in `--text-secondary`). Chips link to the term browse page. This is a denser
  texture than the product tiles, so the page does not read as one repeating card. Each links to
  the relevant taxonomy browse page; data from the **live** `GET /api/taxonomy`
  (`TaxonomyResponse`, each facet a `TaxonomyTermWithCount[]` with `product_count`), **not**
  `stats_cache` (AECI-184): the browse counts read live taxonomy so this section is independent of
  the stats pipeline (4.3/4.4) and the home edge cache purges on the `taxonomy` `Cache-Tag`.
- **Recently added integrations:** a 2-up grid of **integration tiles** — source monogram → target
  monogram, the "{source} → {target}" headline (Source Serif), a `mechanism_kind` chip and the
  direction label. The `→` glyph is `aria-hidden` (and should RTL-mirror, matching the shipped
  `IntegrationCard`). Links to `/integrations/:id`.
- **Trending products this week:** the shipped **`ProductCardGrid` broken grid** — a wide featured
  lead on a Bone (`--accent-warm`) band (eyebrow "Most viewed this week") + uniform tiles for the
  rest. This is the home's single reuse of the catalog's signature broken grid, which is what ties
  the home to `/products` visually.

## Both themes

Token-driven throughout; light is the marketing default, dark at full parity. Verify in dark:
the Bone band (`--accent-warm` → `#2A2520`), the Forest stat figures (dark Forest `#5D916C`,
AECI-166 lifted for AA on raised surfaces), the search focus ring, and the featured-lead Bone tile.

## Empty / pre-launch state (first-class, not an afterthought)

At launch the cache is sparse, so the populated case may not exist. Required empties:

- **Total card** at 0: "No integrations indexed yet" (no "+X" line), not a bare `0`.
- **Most-integrated-product** null: a non-link card reading "No product data yet".
- **Most-active-category** null: a non-link card reading "No category data yet".
- **Recently added** empty: a bordered note, "No integrations added yet. The first vendor-verified
  integrations land at launch."
- **Trending** empty: **fall back to `recently_added_products`** (AECI-185 decision) — render the
  same broken grid under a truthful "Recently added products" heading + the grid's default
  "Recently added" eyebrow (capped at 5), never labelling recently-added products "trending". Only
  when *both* `trending_products` and `recently_added_products` are empty does the section show the
  bordered note, "Trending lands once we have product view data."
- **Browse grids** pre-launch: taxonomy is seeded, so chips render with `0` counts (count in
  `--text-secondary` — the AECI-184 AC requires secondary, not the AA-failing `--text-tertiary`)
  rather than disappearing — the grid structure shows before data arrives.

`IntegrationStat` already renders "Not yet connected" at zero; reuse that precedent for any count.

## Components

**Reuse as shipped (AECI-190 + Phase 2/3), do not reinvent:**

| Need | Component |
|---|---|
| Hero search | `SearchAutocomplete` (`search/search-autocomplete.ts`) |
| Stat figure / count | `IntegrationStat` (`products/integration-stat.ts`) — `headline` on cards |
| Product monogram | `LogoOrInitial` (`shared/logo-or-initial/`) |
| Trending grid | `ProductCardGrid` (`products/product-card-grid.ts`) |
| Card chips | `CategoryChip`, `RoleBadge` (`products/`) |
| Header / footer | `SiteHeader`, `SiteFooter` (`layout/`) |

**New components 4.7–4.11 will add** (home-specific): the stats-card trio, the browse count-chip
grid, and the recently-added integration tile. Build these in `apps/web/src/app/home/`, token-
driven, i18n-wrapped, OnPush + signals + zoneless, SSR-safe; resolve `HomeStatsResponse` SSR-side
(resolver + TransferState, matching the taxonomy/product pages) so the route stays edge-cacheable
with the home `Cache-Tag` (AECI-56) and `WebSite`/`Organization` JSON-LD (the 4.11 assembly issue).

## Design-law guardrails honored

Source Serif 4 + Atkinson Hyperlegible only · Forest anchor, Clay 0% on this surface · borders
not shadows · Bone only as accent band · sentence case everywhere · no em dashes · Lucide glyphs
only (no emoji) · both themes at parity · empty states real.

## Tokens

**No new design tokens.** The Faire direction uses only existing tokens (`--accent-warm` Bone,
`--accent-primary` Forest, `--surface-raised`, `--border-default` / `--border-strong`, text scale).
If 4.7–4.11 discovers a genuine new token need, add it to `DESIGN.md` (and `styles.css` +
`BRAND_GUIDELINES.md` + `STAGE_1_SPEC.md` §2a.2 in lockstep) **before** using it.
