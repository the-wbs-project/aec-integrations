# Home page — build direction (AECI-181)

Status: **settled.** The direction the Phase 4 home-build issues (4.7–4.11) build against.
Source issue: **AECI-181** (Phase 4.6 design pass). Spec anchor: `docs/STAGE_1_SPEC.md` §4.1.
Contracts: `DESIGN.md` (laws + Anchor-Site Rule), `PRODUCT.md` (voice/audience),
`packages/shared/src/api/stats.ts` (`HomeStatsResponse`).

> **Superseded in part.** The **page contract** below is superseded by
> [`unified-home-direction.md`](./unified-home-direction.md), which since epic **AECI-1554**
> (2026-10-31) describes the shipped five-band home. This doc still governs the per-component
> treatments it lists: hero, browse chips, recently added, trending, empty states.

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

## Page contract

Superseded. The shipped order is `docs/STAGE_1_SPEC.md` §4.1 and
[`unified-home-direction.md`](./unified-home-direction.md).

**Data:** `GET /api/stats/home` → `HomeStatsResponse` (read from `stats_cache`, never live-aggregated).
`recent_integrations` and `trending_products` are arrays that can be empty. Every module renders its
real empty state.

## Hero (Faire treatment)

- **Warm Bone band.** The hero sits on a full-bleed `--accent-warm` (Bone) band with a 1px
  `--border-default` bottom rule. The credibility row (`home-credibility-strip.ts`) is the band's
  last row, inside the same Bone ground. Bone is an accent band, not a page background (DESIGN.md
  Surfaces-Are-Neutral Rule).
- **Two columns at `lg`, one below** (AECI-1555). The left column holds:
  - the small-caps eyebrow (`--text-secondary`): "The independent reference for AEC software";
  - the **display** tagline, the page's only `<h1>`: Source Serif 4 **400**,
    `clamp(2.25rem, 4.5vw + 1rem, 4rem)`, lh 1.05, tracking -0.01em. Copy: "Find the integrations
    between your AEC tools." It claims no dual-vendor verification and no completeness ("every");
    nothing is dual-vendor-verified at Stage 1 (spec §1, §4.2). The independence line lives in the lede;
  - a one-line `--text-secondary` lede;
  - the search field, with its own placeholder ("Try Procore, Sage 300, Bluebeam");
  - a **"Popular:" row** of quick links to top category pages (browser-only, never in the cached HTML).
- **The right column is the pair finder.** A bordered white panel with an `<h2>` "Do these two
  connect?", a one-line hint, two product pickers ("Your tool", "Connects to"), and a Forest
  "Show integrations" button. Two products route to the product-pair page (context = the
  alphabetically-first slug); one product routes to its `#integrations` section; typed text with no
  choice routes to `/search?q=`. On mobile the panel sits under the left column.
- **Every field is `SearchAutocomplete`** (`apps/web/src/app/search/search-autocomplete.ts`,
  AECI-144). The pickers use its `kinds` (products only), `ownForm = false` and `fillOnSelect`
  inputs. Without JS the finder is a real `<form action="/search" method="get">`; the search field
  degrades to a plain submit-to-`/search` field. Real `<label for>` on every field, never
  placeholder-as-label. Forest focus ring.
- **No** stock photography, gradient, or large hero imagery (PRODUCT.md anti-references).

## Trust band (`HomeTrustPillars`)

Not on the home since AECI-273. The band lives on `/about`; the home's argument is `home-why.ts`.

## Three stats cards

Deleted in AECI-1554. The credibility row in the hero band is the home's only figure row.

## Section rhythm — break the grid

Avoid identical card matrices stacked (DESIGN.md "no identical card grids"):

- **Browse: one block** (`home-browse-block.ts`). One `<h2>` "Browse the directory" over three
  labelled `browse-grid.ts` rows: category (top N by `product_count`), project phase (all, in
  `display_order`), audience (a curated role list with a one-sentence lede). Every row uses the same
  chip: the `TaxonomyBadge` count-chip, linking to the term page. A count shows only above zero.
  Data comes from the **live** `GET /api/taxonomy`, **not** `stats_cache` (AECI-184), so the block
  purges on the `taxonomy` `Cache-Tag`. Trades are excluded (AECI-544).
- **Recently added integrations:** six **integration tiles** in a 3-up grid at `lg`, at most two per
  source product (AECI-1559). Each tile: source monogram → target monogram, the
  "{source} → {target}" headline (Source Serif), and a `mechanism_kind` chip. The direction label is
  sr-only. The `→` glyph is `aria-hidden` and RTL-mirrors. The tile links to the product-PAIR page
  `/products/:contextSlug/integrations/:otherSlug` (AECI-294; context = alphabetically-first slug).
- **Trending products this week:** the shipped **`ProductCardGrid` broken grid** with
  `cardSurface="plain"`: every card is white with a 1px border, and the lead is told apart by its
  two-column span and its eyebrow ("Most viewed this week"), not a tint. Source is
  `home.trending_products`: the top ≤5 products by `page_views` in the last 7 days that clear the
  `TRENDING_MIN_VIEWS` floor (currently 3; AECI-280). When nothing clears the floor the section
  falls back to recently-added (see Empty state).

## Theme

Light only (Stage 1, AECI-226). Token-driven throughout.

## Empty / pre-launch state (first-class, not an afterthought)

At launch the cache is sparse, so the populated case may not exist. Required empties:

- **Credibility row** at 0: each zero count is dropped; all zero renders "Indexing in progress".
- **Recently added** empty: a bordered note, "No integrations added yet. The first integrations land
  at launch." (No "vendor-verified" — nothing is dual-vendor-verified at Stage 1; §4.2.)
- **Trending** empty (pre-launch, or post-launch when no product clears the `TRENDING_MIN_VIEWS`
  floor): **fall back to `recently_added_products`** (AECI-185 decision) — render the
  same broken grid under a truthful "Recently added products" heading + the grid's default
  "Recently added" eyebrow (capped at 5), never labelling recently-added products "trending". Only
  when *both* `trending_products` and `recently_added_products` are empty does the section show the
  bordered note, "Trending lands once we have product view data."
- **Browse rows** pre-launch: taxonomy is seeded, so chips render without a count rather than
  disappearing. A count, when shown, is `--text-secondary`, never the AA-failing `--text-tertiary`.

## Components

**Reuse as shipped (AECI-190 + Phase 2/3), do not reinvent:**

| Need | Component |
|---|---|
| Hero search | `SearchAutocomplete` (`search/search-autocomplete.ts`) |
| Product monogram | `LogoOrInitial` (`shared/logo-or-initial/`) |
| Trending grid | `ProductCardGrid` (`products/product-card-grid.ts`) |
| Card chips | `RoleBadge` (`products/`) |
| Header / footer | `SiteHeader`, `SiteFooter` (`layout/`) |

**Home-specific components** (in `apps/web/src/app/home/`): the browse block and its count-chip
rows, the recently-added integration tile, and the bands listed in `unified-home-direction.md`. They are token-
driven, i18n-wrapped, OnPush + signals + zoneless, SSR-safe. `HomeStatsResponse` resolves SSR-side
(resolver + TransferState, matching the taxonomy/product pages) so the route stays edge-cacheable
with the home `Cache-Tag` (AECI-56) and `WebSite`/`Organization` JSON-LD (the 4.11 assembly issue).

## Design-law guardrails honored

Source Serif 4 + Atkinson Hyperlegible Next only · Forest anchor, no Clay on the home · borders not shadows · Bone only as accent
band · sentence case everywhere · no em dashes · Lucide glyphs only (no emoji) · light only
(Stage 1, AECI-226) · empty states real.

## Tokens

**No new design tokens.** The Faire direction uses only existing tokens (`--accent-warm` Bone,
`--accent-primary` Forest, `--surface-raised`, `--border-default` / `--border-strong`, text scale).
If 4.7–4.11 discovers a genuine new token need, add it to `DESIGN.md` (and `styles.css` +
`BRAND_GUIDELINES.md` + `STAGE_1_SPEC.md` §2a.2 in lockstep) **before** using it.
