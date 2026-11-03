# Unified home — build direction

Status: **superseded 2026-10-31 by epic AECI-1554** for the section order, the band plan and the reviews copy. This doc now describes the shipped home. The positioning section below is unchanged from AECI-270 and still governs.
Spec anchor: `docs/STAGE_1_SPEC.md` §4.1. Page assembly: `apps/web/src/app/home/home.ts` (its doc comment holds the band order).
Contracts: `DESIGN.md` (laws + Anchor-Site Rule → Faire), `PRODUCT.md` (voice / audiences / banned words), `packages/shared/src/api/{stats,taxonomy}.ts`.

> **Relation to [`home-direction.md`](./home-direction.md) (AECI-181).** That doc owns the per-component treatments (hero, browse chips). This doc owns the page: band order, grounds, and the argument band. Where the two disagree, this doc wins.

The dev-only **`/preview/unified-home`** route (`apps/web/src/app/preview/unified-home/`) is the 2026-06 concept review (concepts a, b, c; b was chosen 2026-06-25). It is kept for reference and is not the shipped home.

## Canonical positioning

The home's one-liner is:

> **The independent directory of AEC software integrations. No pay-for-placement.**

AECI-1316 (2026-10-14) dropped "No vendor marketing" from every line below. Vendors write product descriptions and "How teams use it", so the claim was untrue.

Three live expressions ladder up to it (reconciled in AECI-270):

| Surface | String | File |
|---|---|---|
| Hero lede | "The independent directory of integrations across the AEC stack, with no pay-for-placement." | `home-hero.ts` (`@@home.hero.lede`) |
| Footer tagline | "The independent directory of AEC software integrations." | `site-footer.ts` (`@@app.footer.tagline`) |
| Meta description | "The independent directory of AEC software integrations. No pay-for-placement." | `core/meta.service.ts` (`@@meta.homeDescription`) |

The hero **tagline** ("Find the integrations between your AEC tools.") is unchanged — it is the verb-forward hook; the lede now carries the positioning. **No launch copy claims integrations are "verified"** — nothing is dual-vendor-verified at Stage 1 (spec §1; §4.2 verified-badge placeholder). This is why the prior footer "Vendor-verified reviews…" tagline was reconciled out: the directory, not a verified-review claim, is the honest anchor at launch.

## The page: four bands

Directory first, then the argument. The ready visitor meets search, the pair finder and browse before any persuasion. The cold visitor sees the directory working, then reads why it exists.

```
1  Hero                 Bone   search, Popular row, pair finder; credibility row closes the band
2  Browse               white  one block: category, trade, project phase, audience rows
3  The argument         white  home-why: problem, 3 cited figures, what we do instead
4  Closing CTA          Bone   vendor call to action + suggest a tool
   Footer               white  app shell
```

**Grounds.** Two only. Bone (`--accent-warm`) bookends the page: the hero band and the closing CTA. Every band between them is white (`--surface-base`), separated by a hairline `border-t` (`--border-default`) plus its own spacing and heading. The footer is white app-wide. Each section component is a background-agnostic bare `<section>`; the band wrapper (ground, `max-w-7xl`, vertical rhythm) lives in `home.ts`.

**One card recipe.** White fill, 1px `--border-default`, `--radius-lg`. No tinted cards, no shadows.

**Texture variation** still prevents monotony (DESIGN.md "no identical card grids"): a two-column hero, chip rows, a hairline spec-sheet row, and one paragraph-led panel. The home carries no card grids (AECI-1573).

## The bands (treatment)

All bands are **static, SSR-safe, edge-cache-neutral** unless noted, and obey the DESIGN.md laws: Forest is the only CTA and figure color, Clay is decorative only and under 5%, Bone is an accent band and never a page background, borders not shadows, Source Serif headlines and Atkinson body, sentence case, **no em dashes**, no hero-metric template, Lucide glyphs only.

### 1. Hero (`home-hero.ts`, AECI-1555)
Two columns at `lg`, one below. Left: the small-caps eyebrow "The independent reference for AEC software", the `<h1>` tagline, the positioning lede, the search field, and the "Popular:" row: up to five product links, the most-viewed products by human page views over 30 days (`popular_products`, recomputed nightly, AECI-1572). It ships in the SSR HTML. When the list is empty, the row names the five largest categories instead, browser-only, so the fallback stays out of the cache. Right: the pair finder, a bordered white panel ("Do these two connect?") with two product pickers and a Forest "Show integrations" button. Two products route to the product-pair page, one product to its `#integrations` section, typed text to `/search`. Without JS the finder is a real `GET /search` form. The credibility row (`home-credibility-strip.ts`) is the band's last row: coverage counts, each suppressed at 0, the note "+{n} in the last 30 days" after the integrations count (`integrations_added_30d`, shown only above 0), and the line "Independent. Rankings are algorithmic." An all-zero cache renders "Indexing in progress". It is the home's only figure row.

### 2. Browse (`home-browse-block.ts`)
One `<h2>` "Browse the directory" over four `browse-grid.ts` rows, in this order: category (top N by `product_count`), trade (top N published trades by `product_count`, each linking to `/trades/:slug`; a trade below the publication floor is not listed, AECI-1573), project phase (all, `display_order`), audience (a curated role list, each role linking to `/audiences/:slug`). Each row opens with a one-sentence lede. One chip style everywhere: the `TaxonomyBadge` count-chip. Live `GET /api/taxonomy`.

### 3. The argument (`home-why.ts`, AECI-1558)
Eyebrow, `<h2>`, two short paragraphs in a reading-width column, then the three cited figures as a **spec-sheet row** (three columns split by hairlines, a Forest figure over its label, a per-figure "Source" link whose accessible name names its figure). Then three "what we do instead" cards: documented connections, position earned not bought, organized the way AEC works. Research and citations: `home-why-market-figures.md`.

**No reviews claim (AECI-1557).** AECi holds no reviews yet, so the home never says it rates, reviews or verifies anything. Reviews copy returns when the first approved review exists.

### 4. Closing CTA (`home-closing-cta.ts`, AECI-1564)
A Bone band holding one bordered white panel in two columns. Left: "For vendors" eyebrow, heading, two sentences on how listings work, and a Forest link "Claim or list your product" → `/vendor-program`. No imperative upsell, no price. Right: "Suggest a tool", a quieter button that `@defer`-loads `home-feedback-dialog.ts` (`POST /api/feedback`). The mailing-list signup is not on the home. `/updates` keeps its own form, and the directory and detail pages keep the shared band.

## Removed in AECI-1554

- `home-stats-cards.ts`: the credibility row is the only figure row.
- `home-audience.ts`: audience is a row in the browse block.
- `home-differentiation.ts`, `home-how-it-works.ts`: merged into `home-why.ts`, without the reviews claims.
- The Forest-soft (`--accent-primary-soft`) band grounds: two grounds only.
- `recent-integrations-section.ts`, `trending-products-section.ts`, `integration-tile.ts` (AECI-1573): card grids made the page hard to read. The hero's "Popular:" row is the one live signal.

## Empty / pre-launch state

- **Credibility counts at 0:** drop the zero figure, never a bare "0". All zero renders "Indexing in progress". The independence line always renders.
- **Popular row:** an empty `popular_products` swaps the products for the five largest categories, browser-only. The liveness note hides at 0.
- **Browse rows:** a count shows only above zero.

## Tokens

**No new design tokens.** The bands use `--accent-warm` (Bone), `--accent-primary` / `--accent-primary-hover` (Forest), `--surface-base`, `--surface-sunken` (hover only), `--border-default`, the text scale, and `--radius-sm` / `--radius-lg`. A genuine new token need goes into `DESIGN.md` (and `styles.css` + `BRAND_GUIDELINES.md` + `STAGE_1_SPEC.md` §2a.2) in lockstep **before** use.
