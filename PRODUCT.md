# Product

Strategic design context for AEC Integrations (AECi). Loaded by every Impeccable command before any design work runs. Visual tokens (colors, typography, components, spacing) live in `DESIGN.md`. Brand-policy detail (contrast ratios, Bone reclassification, Clay restriction) lives in `docs/BRAND_GUIDELINES.md`. This file is the *strategic* layer: who, why, what voice, what to avoid.

## Register

brand

The Stage 1 launch surface is ~80% brand register: vendor directory, product profiles, integration profiles, search, About, blog. The remaining ~20% (auth, review submission, account) is product register and will use Spartan brain primitives directly. When working on those surfaces, override per task: *"this is a product surface, use product register"*. PRODUCT.md carries `brand` because the brand register is the front door — first impression, SEO surface, conversion surface — and a directory visited by AEC professionals making six- and seven-figure decisions has to read as editorial-publication first, application second.

## Users

AECi serves three audience tiers. The product is built for all three but speaks loudest to the first two.

**Tier 1 — AEC software *buyers*.** Firm decision-makers (technology directors, ops leaders, principals at top-100 ENR firms; specialty-trade owners at smaller shops) evaluating six- and seven-figure software decisions. They are deeply skeptical of vendor marketing, fed up with G2 / Capterra / Software Advice pay-to-play rankings, and are looking for a peer-trusted source they don't already have in the AEC vertical. Context: research sessions on a desktop monitor, often comparing 3-5 vendors across a category, sharing links with internal stakeholders. Job: make a defensible decision they can justify to a steering committee.

**Tier 2 — AEC *practitioners*.** Architects, structural engineers, MEP engineers, project managers, BIM coordinators, estimators, superintendents who will *use* the software daily and whose feedback feeds the buyer's decision. They want to know whether a tool is worth their adoption-curve pain — not whether the vendor's marketing copy is polished. Context: quick lookups on desktop or tablet between project work, often skimming reviews looking for a specific friction point. Job: separate the tools that survive contact with a real project from the ones that don't.

**Tier 3 — Software *vendors* (Stage 2+).** Founders, marketing leads, customer-success teams who want to claim and accurately represent their integration profiles. They get a fair hearing because the platform is editorially neutral — no paid ranking, no paid review removal. Context: claim flow, profile management, dispute corrections. Job: be represented honestly without paying a tax.

## Product Purpose

A directory and review platform for software integrations in the Architecture, Engineering, and Construction industry, built around dual-vendor-verified integration reviews, AEC-native taxonomy, and trust-first positioning (no pay-for-placement). Dual reviews separate product quality from onboarding experience, which is information G2 and Capterra mash together and lose. Success at Stage 1 launch: AEC buyers find AECi when searching for a category, trust what they read, and start sending the link to colleagues instead of forwarding G2 PDFs.

> **This section is the destination, not the current state.** "Dual-vendor-verified" is the
> Stage 2 target. Today the catalog is **entirely AECi-curated**: production holds zero
> vendor attestations and zero verified vendors, every claim renders **"Unverified · AECi"**,
> and every record carries **"Maintained by AEC Integrations"**. Public copy must describe
> what ships, not this paragraph — an `/about` line claiming integration details were
> "verified with the vendors involved" was live and false until 2026-08-17. See DESIGN.md
> §Badges ("No verification iconography in Stage 1") and AECI-616.

## Brand Personality

**Trustworthy. AEC-native. Opinionated.**

- *Trustworthy*, not "innovative" — the differentiator is editorial integrity, not novelty. The brand earns trust by saying what other directories won't (no pay-for-placement, this vendor's onboarding is bad even though their product is good, this category is dominated by two players and the rest is noise).
- *AEC-native*, not "industry-agnostic SaaS marketplace" — the taxonomy, vocabulary, and editorial tone come from inside the industry, not from a generic horizontal review platform that bolted AEC on as a vertical.
- *Opinionated*, not "neutral aggregator" — neutral aggregators are how G2 became useless. AECi takes positions: this category exists, that one doesn't; this distinction matters, that one is marketing.

### Voice and tone

Editorial, peer-to-peer, anti-vendor, no-BS. The brand speaks *with* AEC professionals, not *to* them. Substance over enthusiasm. The bar for any sentence: would a senior architect or MEP engineer reading this feel respected, or talked-down-to?

- **Sentence case everywhere** — headings, buttons, labels, navigation, table headers, section titles, page titles. Title Case reads as marketing copy; sentence case reads as editorial copy. This rule is absolute and applies to both registers.
- **Brand register** (marketing pages, vendor profiles, blog, About): confident editorial tone. Lead with the substantive claim, then back it up. Borrow rhythm from industry publication writing (ENR, Architectural Record, *The Construction Specifier*) and tech-editorial pages (Stripe Press, Linear's Changelog) — never SaaS landing-page hype.
- **Product register** (auth, review submission, account, search filters): quiet, functional, declarative. Borrow rhythm from Linear, Notion, Stripe Dashboard. Microcopy earns its place — no decorative phrasing, no "Awesome!" toasts, no exclamation marks.
- **No em dashes anywhere.** Use commas, colons, semicolons, periods, or parentheses. Also not `--`.
- **No hyperbole, no AI-marketing tells.** Banned phrases (non-exhaustive): *unlock, supercharge, revolutionize, game-changing, seamless, world-class, best-in-class, next-generation, cutting-edge, transform your workflow, your single source of truth, the only [X] you'll ever need, AI-powered (when it's not), powered by AI (when it's not).* If a sentence still parses with the marketing word removed, remove it.

## Anti-references

The brand is defined as much by what it refuses to look like as by what it commits to.

- **G2, Capterra, Software Advice, GetApp, TrustRadius.** Visually noisy, ad-saturated, ranking-for-sale, generic-SaaS-marketplace cream-and-orange. AECi exists because these failed AEC.
- **Generic AI-startup landing page** — purple-to-blue gradients, glassmorphic hero cards, hero-metric template (big number + small label + sparkline + gradient accent), "AI" in the H1, gradient text, the same Inter / DM Sans / Plus Jakarta Sans / Geist / Mona Sans / Space Grotesk / IBM Plex Sans / Outfit reflex font selection.
- **2014-era AEC vendor brochure** — stock photo of a hard-hatted worker pointing at a tablet, monumental wordmark over a beveled construction-site background, a six-color palette tied to nothing, "DELIVERING EXCELLENCE SINCE 1987".
- **Generic horizontal SaaS directory landing page** — equal-weight feature grid (3×3 of identical cards each with an icon + heading + 8 words of body), customer-logo cloud as the only proof, "Trusted by 10,000+ teams", a CTA-to-CTA layout that never lets the page breathe.
- **Construction-tech competitor mimicry** — Procore-style navy-and-orange, BIM-vendor blueprint-paper backgrounds, "construction" stock photography of any kind. AECi is editorial about AEC, not a costume of AEC.

## Visual anchors

These are the strategic anchors that drive everything in `DESIGN.md`. The exact tokens, hex values, OKLCH equivalents, contrast ratios, and component bindings live in `DESIGN.md` and `docs/BRAND_GUIDELINES.md` — not here.

- **Forest** is the primary brand color. Anchor of the system. CTAs, links, headings, the connector mark.
- **Bone** is a warm-tinted *accent surface* — hero bands on About, callout sections, marketing emphasis. Never a page background. Page backgrounds are neutral (white in light, near-black in dark).
- **Clay** is the rarest color. ≤5% of any screen. Large-text or graphical only (it fails WCAG body contrast on white). Reserved for the connector mark, primary CTA fills where appropriate, "verified" / "featured" badges, and high-emphasis highlights. Overused, it loses its meaning instantly.
- **Brand SVGs** (logo, monogram, connector mark, favicon) live under `branding/`. Spacing changes go through edits to `branding/logo-construction.md` and matching updates to the SVG files — there is no `regenerate.py` script (legacy memory reference). The DOCX export of the brand book is regenerated from `docs/BRAND_GUIDELINES.md` via `scripts/build-brand-docx.sh` (Pandoc).
- **Vendor logos** are loaded from the **Brandfetch CDN** with a generic AECi placeholder fallback. AECi never re-hosts vendor logos. See `docs/STAGE_1_SPEC.md` for fetch and fallback behavior.

## Constraints

Strategic constraints that shape every design decision. Implementation detail lives in `CLAUDE.md` and `docs/STAGE_1_SPEC.md`.

- **Angular 21+ with SSR on Cloudflare Workers.** SSR Worker (with `nodejs_compat`) calls a private API Worker via service binding. SSR responses for cacheable routes must render visitor-state-neutral HTML — the edge cache is keyed by URL, the worker strips visitor cookies before forwarding to SSR, and the client reconciles after hydration. **Implication for design:** any visitor-state-driven UI (locale, region, auth state) must hydrate after first paint, not be baked into SSR HTML.
- **Zoneless change detection.** No `zone.js`. **Implication for design:** animations driven by signals or RxJS, not Zone-tracked timers.
- **Tailwind v4 + Spartan brain (no helm codegen).** Headless component primitives + utility CSS. **Implication for design:** components are styled in templates with Tailwind utilities bound to design tokens, not via component-scoped Sass. Spartan gives a11y for free; we don't break it.
- **WCAG 2.2 AA minimum.** Atkinson Hyperlegible Next was chosen as the body face partly to embody this constraint visibly (upgraded from the classic two-weight cut in AECI-230 so the 500/600 label weights render as real cuts). Color contrast is verified in CI against the brand-token matrix (`docs/BRAND_GUIDELINES.md` §6).
- **i18n from day one.** No hardcoded English strings in templates. Every string wrapped in `i18n` attributes or `$localize` tags. English at launch; the architecture supports more.
- **Light-only presentation (Stage 1).** AECi ships a single light theme — no theme toggle, no system-preference detection (AECI-226). A dark front door pattern-matches to "internal tool" and undercuts the trust argument that is the whole product. Dark was once considered for the Stage 2 vendor portal (a genuine utility app), but that reintroduction has been **dropped** — dark is not roadmapped (`docs/STAGE_2_SPEC.md` §9). **Implication for design:** design once, for light — do not add `dark:` variants or a theme toggle.
- **No pay-for-placement.** Search rankings are purely algorithmic. Paid vendor tiers (Stage 4+) affect profile *richness*, never ranking position. **Implication for design:** no visual treatment that signals "promoted" or "sponsored" — featured / verified badges follow product rules, not vendor spend.

## Design Principles

Five strategic principles. Visual rules (use OKLCH, cap measure at 70ch, etc.) live in `DESIGN.md` — these are at a higher altitude.

1. **Substance over style.** Every design choice serves clarity and trust. If it doesn't help the reader make a better decision, remove it. Decoration that adds nothing is not neutral — it costs trust.
2. **Editorial, not commercial.** AECi is a publication that happens to be a product, not a product pretending to be content. The visual language belongs to industry publication, not SaaS marketing.
3. **Earned attention.** Don't shout. Use typography, whitespace, and restraint to draw focus where it matters. Hierarchy through scale and weight contrast, not color and decoration.
4. **Industry-native.** Designed for people who build buildings. Precision, reliability, no-nonsense. The visual language reflects AEC professional culture, not Silicon Valley product culture.
5. **Transparent by default.** The brand promise is honesty. The design reflects it — no dark patterns, no manipulative microcopy, no visual tricks that flatter vendors at the expense of buyers. The choice of Atkinson Hyperlegible Next (a11y-first body face) over an "elegant" sans is part of this principle made visible.

## Accessibility & Inclusion

- **WCAG 2.2 AA minimum**, AAA where attainable without compromising the editorial aesthetic. Color contrast verified in CI against the token matrix in `docs/BRAND_GUIDELINES.md` §6.
- **Screen reader pass before merge** for any new UI surface. Spartan brain primitives + Angular CDK provide a11y by default — don't break it. Run axe-core locally before pushing.
- **Reduced motion** respected via `@media (prefers-reduced-motion: reduce)` on every transition. Default durations 120/180/280ms; reduced-motion path collapses to instant.
- **Keyboard navigation** is the primary nav model — tab order is intentional on every screen, focus rings always visible (no `outline: none` without a replacement focus indicator), CDK focus traps used wherever modals or dropdowns appear.
- **Color is never the sole signal.** Verified / pending / failed states pair color with iconography or text labels.
- **No emoji in UI chrome.** Lucide icons exclusively. Emoji rendering is inconsistent across platforms and clashes with the editorial brand.
