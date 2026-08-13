# `trade` Controlled Vocabulary

**Status:** Proposed (AECI-539 — the decision gate for the AECI-538 epic). **Source of truth** for the `trade` term list once accepted. Every AECI-539 open question is answered as a **decision** — see the decision log in §10; the term list itself (Q2) is the one that still wants a human yes, and §5.3 tabulates exactly how it diverges from the issue's draft.
**Issue:** AECI-539. **Epic:** AECI-538 — Trades taxonomy facet. **Ships before Stage 2** (ADR 0019: production-destined, branches from and merges to `main`).
**Machine-readable mirror:** [`trades-vocabulary.json`](./trades-vocabulary.json).
**Spec:** `docs/STAGE_1_SPEC.md` §5.5 (amended by this issue to define the fourth facet).

This document is the single canonical artifact for the `trade` controlled vocabulary.
Everything downstream seeds from it:

- **AECI-540** _(shipped)_ — the main app's D1 `taxonomy_trades` + `product_trades` tables, and
  `apps/api/seed/trades.sql` seeded from §5 under the id convention in §8.
- **AECI-541** _(shipped)_ — `packages/shared` contracts, `GET /api/taxonomy → trades`,
  `GET /api/trades`, `GET /api/trades/:slug`, the `trades` dimension on
  `GET /api/products/facets`, the `trades` chip array on `ProductDetail`, and the `trade_id`
  listing param.
- **AECI-542 / AECI-543** — the promote `trades` key and the Review-app (bamako) Airtable `Trades`
  field are seeded from this list; the promote resolver matches against §5 **find-only** (§3).
- **AECI-545** _(shipped)_ — the Algolia product record gains `trades` (term names, faceted via
  `searchable(trades)`) and `trade_aliases` (the §4 aliases flattened; **searchable only**), plus the
  `/search` Trades refinement list. Records stay empty until AECI-542 + AECI-547 populate
  `product_trades`.
- **AECI-546** _(shipped)_ — the publication gate in §6 reaches the SEO surfaces: the XML sitemap
  lists published terms only (plus the always-listed `/trades` index), a sub-floor term page renders
  `noindex`, and `POST /api/promote` submits only published trade URLs to IndexNow / Google.

---

## 1. What a `trade` is

A `trade` is **the work a company sells** — the scope of work it is hired to perform. It answers the
buyer's own question:

> *"What does my company actually do?"* → *"What software understands **my** work?"*

The three existing facets answer different questions, and none of them answers this one:

| Facet | Question | Example |
|---|---|---|
| **Category** | What does the *software* do? | Estimating & Takeoff |
| **Audience** | Who is the software *for*? | Specialty Contracting, Estimator |
| **Phase** | *When* in the project lifecycle? | Pre-Construction |
| **Trade** (new) | What work does the *company sell*? | Electrical, Roofing, Paving & Asphalt |

The gap this closes (industry feedback, Aug 2026): a paving sub, a glazier, and an electrical
contractor all collapse into the single Audience term **Specialty Contracting**. A paving contractor
cannot ask AECi "what tools understand pavement?" Trade-first discovery is how contractors
self-identify, it is low-competition long-tail SEO ("software for paving contractors") that
horizontal directories serve badly, and it is the most AEC-native dimension we could add.

The vocabulary mirrors the existing taxonomy vocabularies (`taxonomy_categories`,
`taxonomy_audiences`, `taxonomy_phases`) in shape — `slug` / `name` / `description` /
`display_order` — and adds `aliases`, following the Stage 1.5 `data_object` precedent
(`docs/DATA_OBJECT_VOCABULARY.md` §3).

### 1.1 The core tagging rule

**A product gets a trade tag only when it has *trade-specific* value.** Trade-specific means at
least one of:

- trade-specific **features** (sprinkler hydraulic calculations, duct fabrication, roof measurement)
- trade-specific **cost databases or assemblies** (NECA labor units, MCAA labor factors, RSMeans by trade)
- trade-specific **templates, forms, or reports** (a trade's standard submittal/inspection set)
- trade-specific **takeoff or layout logic** (rebar bending schedules, mass-haul balancing, panel schedules)
- trade-specific **integrations** (to a fabrication machine, a trade ERP, a trade supplier catalog)

**Horizontal platforms get no trade tags.** Procore, Autodesk Build, Bluebeam, Microsoft Project and
their peers are used by every trade and are therefore diagnostic of none. Tagging them would make
every trade page a copy of the all-products list, which is exactly the failure mode this facet
exists to avoid.

> **The trade-page test.** A `/trades/:slug` page must answer *"what understands MY work"*. If a
> reviewer reading the page cannot tell which trade it belongs to from the products alone, the
> tagging is wrong — not the page.

The rule is deliberately asymmetric with the other three facets, which are permissive (a product can
plausibly carry many categories/audiences/phases). Trades are **sparse by design**: most products in
the catalog will carry **zero** trade tags, and that is the correct outcome.

---

## 2. Naming decision — why "Trades"

The epic carried **Trades** as a working name and this issue confirms it. Route namespace `/trades`,
tables `taxonomy_trades` / `product_trades`, listing param `trade_id`, promote key `trades`, Algolia
facet `trades`.

Alternatives considered and rejected:

| Candidate | Rejected because |
|---|---|
| **Services** | Horizontal and generic — every SaaS directory has a "services" filter. No SEO differentiation, and it collides with "professional services" (the A/E side). |
| **Scopes** / **Scopes of Work** | A scope is a *per-project* artifact; a trade is a *company identity*. Buyers do not search "scope of work software". |
| **Specialties** | Collides with the existing Audience term **Specialty Contracting**, and reads clinical. |
| **Disciplines** | Burned: the `disciplines` slug namespace is reserved by the permanent `/disciplines/:slug → /audiences/:slug` 301 from AECI-121. Reusing it would be a URL trap. |
| **Work Types** | Not language anyone in the field uses. |

**Trades** wins on all three axes that matter: it is how contractors self-identify ("we're a
mechanical contractor", "the electrical trade"), it is the head term in the SEO phrases we want
("roofing contractor software", "software for electrical contractors"), and it is AEC-native rather
than borrowed from horizontal software directories.

**Recorded caveat.** "Trades" reads contractor-first. Design- and engineering-side work
(architecture, structural engineering, surveying) is **not** a trade and stays on the Audience axis.
See §7 for the full seam.

---

## 3. Governance — the vocabulary is closed and find-only

The list is **closed**. This is a deliberate constraint, and it is a *stronger* constraint than the
one the original three facets carry:

- **Promote resolves it find-only.** During promotion a free-text trade value is matched
  case-insensitively against the canonical set by **`slug` → `name` → `alias`**. An unmatched value
  is **dropped from the stored set and reported in `skipped[]`** (`kind: "trade"`) — it is **not**
  auto-created, and it is **not** a promote failure (the same shape as `usefulness` groups and
  claim `dataObject`s — `REVIEW_APP_PROMOTE_API.md` §3.3). This deliberately diverges from
  `categories` / `audiences` / `phases`, which promote resolves **find-or-create**
  (`apps/api/src/routes/promote.ts` — `resolveTaxonomy`). Trades follow the Stage 1.5 `data_object`
  model instead (`docs/DATA_OBJECT_VOCABULARY.md` §2), because a curator minting
  `paving-contractors` alongside `paving-asphalt` would silently split a trade page's products
  across two permanent URLs and quietly destroy the SEO asset the facet exists to build.
- **Adding, removing, or renaming a term is a deliberate vocabulary change.** The change process is
  **manual and four-step**, and all four must land together or the two apps drift:
  1. Edit the §5 table in this file (the human-canonical source).
  2. Regenerate the JSON mirror (§9).
  3. Update `apps/api/seed/trades.sql` and merge — the seed re-applies on every deploy (ADR 0008).
  4. **Airtable option parity** — add the matching option to the Review-app `Trades` field
     (AECI-543). There is no sync job: an option that exists in Airtable but not in the seed
     resolves to nothing and lands in `skipped[]`; an option in the seed but not in Airtable is
     simply untaggable. Reviewers should treat step 4 as part of the same change, not a follow-up.
- **`slug` is the immutable identity key.** Once a term ships, its `slug` never changes — the slug is
  a permanent public URL (`/trades/electrical`) and an SEO landing page (ADR 0008). `name`,
  `description`, and `aliases` **may** be edited freely; they are presentation/matching metadata,
  not identity.
- **Seeding is upsert-only and never deletes** (a delete would cascade to `product_trades`).
  Retiring a term goes through an explicit, reviewed migration.
- **The vocabulary is code-managed reference data**, per ADR 0008 — `apps/api/seed/trades.sql`,
  applied to every environment with `wrangler d1 execute`, never Airtable content.

---

## 4. How `aliases` is used

`aliases` is a list of synonyms the **seeding process** and the **promote resolver** map onto a
closed term — the same mechanism as `data_object` (`docs/DATA_OBJECT_VOCABULARY.md` §3). "HVAC" and
"Mechanical" both resolve to `hvac-mechanical`; "Sprinkler" resolves to `fire-protection`.

Matching is **case-insensitive**; the `slug`, the `name`, and every `alias` all resolve to the same
`slug`. Aliases carry real weight here because the trades vocabulary is the one facet where regional
and colloquial naming diverges hardest (*sitework* / *dirt work* / *earthmoving*; *glazier* /
*curtain wall* / *fenestration*).

**Decision: `aliases` is a real column on `taxonomy_trades`** (JSON-mode `TEXT` in D1, matching
`taxonomy_data_objects` — `DATABASE_SCHEMA.md` §5.3a), not a map that lives only in the seeder.
The deciding reason is search, not resolution: because the column exists, AECI-545 **flattens** a
product's trade aliases into a `trade_aliases` attribute on the Algolia product record, so a query
for "blacktop" or "glazier" reaches the right products (`SEARCH_RANKING.md` §3.1). `trade_aliases`
is **searchable only** — never faceted, never displayed. (Shipped: the flattening is
`flattenTradeAliases` in `packages/shared/src/algolia-records.ts`, shared by both record builders,
and it de-duplicates aliases that two trades have in common or that merely repeat a canonical name.)

So `aliases` is **dual-purpose** here, a deliberate divergence from `taxonomy_data_objects` where it
is resolver-only:

1. **Promote resolution** — find-only matching, `slug` → `name` → `alias` (§3).
2. **Search recall** — indexed as searchable content in Algolia (never as a ranking signal).

---

## 5. The vocabulary (34 terms)

Ordered **alphabetically by slug**, matching the `taxonomy_categories` / `taxonomy_audiences`
convention. `display_order` increments by 10; slugs are kebab-case; names are Title Case with `&`
for combined terms.

**Descriptions ship populated.** Unlike the original three facets — seeded `description = NULL`
(ADR 0008 "Follow-ups") — every trade ships with copy, because `/trades/:slug` is an SEO landing
page from day one and an empty page is the SEO junk the publication gate (§6) exists to prevent.

| display_order | slug | name | description | aliases |
|---:|------|------|-------------|---------|
| 10 | `concrete` | Concrete | Cast-in-place concrete: formwork, placing, finishing, and flatwork. | Cast-in-Place, Cast in Place Concrete, Formwork, Flatwork, Poured Concrete, Concrete Contracting, Tilt-Up |
| 20 | `crane-rigging` | Crane & Rigging | Crane operations, lift planning, hoisting, and heavy rigging. | Crane, Cranes, Rigging, Lift Planning, Hoisting, Heavy Haul, Crane & Hoisting |
| 30 | `deep-foundations` | Deep Foundations & Piling | Piles, drilled shafts, caissons, ground improvement, and earth retention. | Piling, Piles, Pile Driving, Drilled Shafts, Caissons, Earth Retention, Shoring & Piling, Ground Improvement |
| 40 | `demolition` | Demolition | Structural and selective interior demolition, including deconstruction. | Demo, Selective Demolition, Interior Demolition, Deconstruction, Wrecking |
| 50 | `doors-frames-hardware` | Doors, Frames & Hardware | Door and frame supply, finish hardware scheduling, and openings installation. | Doors & Hardware, Door Hardware, Finish Hardware, Openings, Hollow Metal, DHI |
| 60 | `drywall-interior-framing` | Drywall & Interior Framing | Metal stud framing, gypsum board, taping, finishing, and acoustical ceilings. | Drywall, Gypsum, Interior Framing, Metal Stud Framing, Taping, Wall & Ceiling, Acoustical Ceilings, ACT |
| 70 | `earthwork-excavation` | Earthwork & Excavation | Excavation, grading, mass haul, and soil work on the site. | Excavation, Grading, Earthmoving, Dirt Work, Mass Haul, Site Grading, Excavating |
| 80 | `electrical` | Electrical | Power distribution, lighting, and electrical systems installation. | Electric, Electrical Contracting, Electrician, Power, Lighting Installation, Electrical Trade |
| 90 | `elevators-conveying` | Elevators & Conveying | Elevators, escalators, lifts, and other vertical transportation systems. | Elevator, Elevators, Vertical Transportation, Escalators, Lifts, Conveying Systems |
| 100 | `environmental-abatement` | Environmental & Abatement | Asbestos, lead, and mold abatement plus environmental remediation. | Abatement, Asbestos Abatement, Asbestos, Lead Abatement, Mold Remediation, Remediation, Hazmat, Environmental |
| 110 | `fire-protection` | Fire Protection | Fire sprinkler, standpipe, and suppression system design and installation. | Fire Sprinkler, Sprinkler, Sprinklers, Fire Suppression, Suppression, Fire Life Safety, Fire Protection Contracting |
| 120 | `fireproofing-firestopping` | Fireproofing & Firestopping | Applied fireproofing and through-penetration firestopping. | Fireproofing, Firestopping, Spray Fireproofing, Intumescent, Penetration Firestop |
| 130 | `flooring` | Flooring | Resilient, carpet, wood, and polished-concrete floor covering. | Floor Covering, Floorcovering, Carpet, Resilient Flooring, Hardwood, Polished Concrete, Flooring Contracting |
| 140 | `framing-carpentry` | Framing & Carpentry | Wood and light-gauge structural framing plus rough and finish carpentry. | Carpentry, Wood Framing, Light Gauge Steel Framing, LGS, Rough Carpentry, Finish Carpentry, Trusses, Framing |
| 150 | `glazing-curtain-wall` | Glazing & Curtain Wall | Glass, storefront, curtain wall, and window-wall fabrication and installation. | Glass, Glazing, Glazier, Curtain Wall, Storefront, Window Wall, Fenestration, Glass & Glazing |
| 160 | `hvac-mechanical` | HVAC & Mechanical | Heating, ventilation, air conditioning, hydronics, and process piping. | HVAC, Mechanical, Mechanical Contracting, Air Conditioning, Heating & Cooling, Hydronics, Process Piping, Mechanical Trade |
| 170 | `insulation` | Insulation | Building-envelope and mechanical insulation, including spray foam. | Mechanical Insulation, Thermal Insulation, Building Insulation, Spray Foam, Pipe Insulation |
| 180 | `landscaping-irrigation` | Landscaping & Irrigation | Planting, hardscape, irrigation, and grounds maintenance. | Landscape, Landscaping, Irrigation, Hardscape, Grounds Maintenance, Green Industry, Lawn Care |
| 190 | `low-voltage-security` | Low Voltage & Security | Structured cabling, access control, surveillance, AV, and building networks. | Low Voltage, Security Systems, Access Control, Surveillance, AV, Audio Visual, Structured Cabling, Systems Integration, Alarm, Fire Alarm |
| 200 | `masonry` | Masonry | Brick, block, stone, and cast-stone construction. | Brick, Bricklaying, Block, CMU, Stone, Cast Stone, Masonry Contracting |
| 210 | `millwork-casework` | Millwork & Casework | Architectural woodwork, casework, cabinetry, and countertops. | Millwork, Casework, Cabinetry, Cabinets, Architectural Woodwork, Cabinet Shop, Countertops, AWI |
| 220 | `painting-coatings` | Painting & Coatings | Architectural painting, industrial coatings, and wall covering. | Painting, Painter, Coatings, Industrial Coatings, Wallcovering, Wall Covering, Painting & Decorating |
| 230 | `paving-asphalt` | Paving & Asphalt | Asphalt and concrete paving, striping, sealcoating, and pavement maintenance. | Paving, Asphalt, Pavement, Blacktop, Striping, Sealcoating, Pavement Maintenance, Asphalt Paving |
| 240 | `plumbing` | Plumbing | Domestic water, sanitary, medical gas, and fuel-gas piping systems. | Plumber, Plumbing Contracting, Sanitary, Domestic Water, Med Gas, Medical Gas, Plumbing Trade |
| 250 | `precast-concrete` | Precast Concrete | Plant-cast structural and architectural precast, including erection. | Precast, Architectural Precast, Structural Precast, Hollowcore, Double Tee |
| 260 | `rebar-reinforcing` | Rebar & Reinforcing Steel | Reinforcing steel detailing, fabrication, and placement, including post-tensioning. | Rebar, Reinforcing Steel, Reinforcement, Rebar Detailing, Post-Tensioning, PT, Rod Busting |
| 270 | `restoration-waterproofing` | Restoration & Waterproofing | Building-envelope restoration, waterproofing, sealants, and caulking. | Waterproofing, Sealants, Caulking, Building Envelope, Facade Restoration, Tuckpointing, Concrete Restoration |
| 280 | `roofing` | Roofing | Low-slope and steep-slope roof systems, repair, and replacement. | Roofer, Roof, Roofing Contracting, Commercial Roofing, Residential Roofing, Re-Roofing, Roof Replacement, Sheet Roofing |
| 290 | `scaffolding-access` | Scaffolding & Access | Scaffold, shoring, swing stage, and temporary access systems. | Scaffold, Scaffolding, Shoring, Swing Stage, Suspended Access, Access Equipment, Formwork & Shoring |
| 300 | `sheet-metal` | Sheet Metal | Duct fabrication and installation plus architectural sheet metal. | Ductwork, Duct, Duct Fabrication, HVAC Sheet Metal, Architectural Sheet Metal, Fab Shop, SMACNA |
| 310 | `sitework-utilities` | Sitework & Underground Utilities | Wet and dry underground utilities, storm, sewer, and site infrastructure. | Underground Utilities, Utilities, Site Utilities, Wet Utilities, Dry Utilities, Storm Drain, Sewer, Underground |
| 320 | `solar-renewables` | Solar & Renewables | Solar PV, battery storage, EV charging, and renewable-energy installation. | Solar, PV, Photovoltaic, Solar Installation, Renewable Energy, Battery Storage, Energy Storage, EV Charging |
| 330 | `structural-steel` | Structural Steel & Metals | Structural steel detailing, fabrication, erection, and miscellaneous metals. | Structural Steel, Steel, Steel Erection, Steel Fabrication, Ironworker, Misc Metals, Miscellaneous Metals, Ornamental Metals, Metal Fabrication |
| 340 | `tile-stone` | Tile & Stone | Ceramic tile, natural stone, and terrazzo setting. | Tile, Tile Setting, Ceramic Tile, Stone Setting, Terrazzo, Tilework |

### 5.1 Why these 34

Each term had to clear three bars:

1. **Contractors self-identify with it.** The term is what a company would put on its own website
   ("we're a glazing contractor"), not an internal work-breakdown label.
2. **Trade-specific software plausibly exists.** A trade page with no candidate products is a page
   that fails the §1.1 trade-page test on day one. Every term above has a recognisable population of
   trade-specific estimating, takeoff, fabrication, or service software.
3. **It does not duplicate an existing Category or Audience term.** See §7.

`display_order` is alphabetical rather than grouped-by-system (site → structure → envelope → MEP →
interiors). With 34 terms the browse list is long enough that users **scan for their own trade**, and
alphabetical is the only ordering that supports scanning. It also matches how
`taxonomy_categories` and `taxonomy_audiences` are already ordered.

### 5.2 Considered and deliberately excluded

These were evaluated and left out of the initial set. Each must clear the §3 bar to be added later.

| Candidate | Why it is out |
|---|---|
| **Surveying & Layout** | Duplicates **two** existing terms: the Category `surveying-gis` and the Audience `surveying-geomatics`. This is exactly the ~55%-overlap failure that got the proposed "Roles" facet rejected in AECI-121. |
| **Heavy Civil / Highway**, **Bridge**, **Water & Wastewater** | These are **market sectors** (what kind of project), not trades (what work you sell). The market-sector axis is an explicit AECI-538 out-of-scope follow-up. |
| **HVAC Service**, **Plumbing Service**, **Mechanical Service** | Service vs. new-construction is a **delivery-model** axis cutting across every trade, not a trade of its own. Splitting it would double the vocabulary. Service-first products tag the base trade (`hvac-mechanical`, `plumbing`). |
| **Metal Buildings / Pre-Engineered** | Folds into `structural-steel`; a separate term would fragment a thin page. |
| **Signage**, **Pools & Aquatics**, **Well Drilling**, **Septic** | Real trades, but no meaningful population of trade-specific software in an AEC directory. Revisit if the catalog grows into them. |
| **General Contracting**, **Construction Management** | Not trades — these are delivery roles, already on the Audience axis (`general-contracting`, `construction-management`). Tagging them would re-create the horizontal-platform problem §1.1 forbids. |
| **Architecture**, **Structural Engineering**, **MEP Engineering** | Design disciplines, already Audience terms. A firm that *designs* mechanical systems is not in the mechanical trade. |

### 5.3 How this list differs from the AECI-539 draft

The issue carried a ~28-term draft. This list is **34 terms** and diverges in three ways. The
splits and additions are the substantive part of the proposal; **this is the one open question that
still wants a human decision** (AECI-539 Q2).

**Split — one draft term became two**, because each half has its own software population and a
combined page would fail the §1.1 trade-page test:

| Draft term | Became | Why |
|---|---|---|
| Sitework & Earthwork · Utilities | `earthwork-excavation` + `sitework-utilities` | Mass-haul/grading software (Agtek, InSite) and underground-utility estimating are different buyers. The draft's separate "Utilities" term folds in here. |
| Insulation & Waterproofing | `insulation` + `restoration-waterproofing` | Mechanical insulation ≠ envelope restoration; the latter is a distinct restoration/sealant market. |
| Demolition & Abatement | `demolition` + `environmental-abatement` | Abatement is licensed, regulated, and served by its own compliance software. |
| Mechanical / HVAC | `hvac-mechanical` + `sheet-metal` | The draft made "sheet metal" an *alias* of Mechanical/HVAC. Duct fabrication is its own trade with its own software (fab-shop/CAM, SMACNA) and often its own company. Kept as a term; "sheet metal" is **not** an alias of `hvac-mechanical`. |

**Added — nine terms not in the draft**, each with a real trade-specific software population:
`crane-rigging`, `deep-foundations`, `doors-frames-hardware`, `fireproofing-firestopping`,
`precast-concrete`, `rebar-reinforcing`, `scaffolding-access`, `sheet-metal`, `tile-stone`.

**Dropped — five draft terms**, all for reasons in §5.2:

| Draft term | Disposition |
|---|---|
| Bridges & Structures · Marine & Waterfront · Rail | **Out.** These are the heavy-civil umbrellas Q2 asks about explicitly. They answer *what kind of project* (market sector), not *what work you sell* — and market sector is a named AECI-538 out-of-scope follow-up. Launching without them keeps the facet's question coherent. |
| Fencing | **Out.** A real trade, but no meaningful population of trade-specific AEC software. |
| Pools & Aquatics | **Out.** Same — residential-leaning and outside the catalog's centre of gravity. |

If you want the heavy-civil umbrellas in v1 anyway, they can be added without disturbing anything
else — but they should then be named as sectors, and §7's distinguishability test says they will
read oddly next to `electrical` and `roofing`.

### 5.4 Which products may carry trades

**Any `product_role` may carry trade tags — connectors included.** A connector purpose-built to sync
a trade ERP (an electrical-contractor accounting system, a roofing CRM) is exactly as trade-specific
as an application, and hiding it from the trade page would lose the most useful result for a buyer
already running that ERP. In practice tags concentrate on `application`-role products; that is an
expectation about the catalog, not a rule enforced anywhere.

The §1.1 rule is the only gate. `product_role` never is.

---

## 6. Publication gating

Thin trade pages are SEO junk and dilute the whole `/trades` namespace. A trade term is
**published** only when it clears a product floor.

- **`TRADE_PUBLISH_MIN_PRODUCTS = 3`** — a trade is published when at least 3 promoted products
  carry it. Launch-tunable (`docs/POST_LAUNCH_MONITORING.md` threshold table); 3 is low enough to
  publish early and high enough that the page is never a single-item stub.

| Surface | Published trade | Unpublished trade (`product_count < 3`) |
|---|---|---|
| `/trades` index — the terms it *lists* | Listed | **Hidden** |
| `/trades` index — *the page itself* | Always in the sitemap, always indexable — the floor gates terms, not the navigational page that lists them (AECI-546); see below |
| `/trades/:slug` page | 200, indexable | 200, `noindex` |
| XML sitemap | Included | **Excluded** |
| IndexNow / Google Indexing ping on `POST /api/promote` | Submitted | **Not submitted** (AECI-546) |
| Primary-nav flyout (`TaxonomyNavStore.tradesTop10`) | Offered | **Hidden** |
| Facet sidebar (`aec-facet-sidebar`) | Offered as a filter | **Also offered** — the floor does NOT apply; see below |
| Product-detail trade chips | Rendered + linked | Rendered + linked (the tag is true; the *page* is just not promoted) |
| `GET /api/trades`, `GET /api/trades/:slug`, `GET /api/taxonomy`, `GET /api/products/facets` | Returned | Returned (with `product_count`; gating is a presentation decision, not a data one) |

**`noindex`, not `noindex,follow` (AECI-546).** Earlier drafts of this section wrote the directive
as `noindex,follow`. What actually ships is a bare `<meta name="robots" content="noindex">` — the
existing `MetaService.setEntityMeta({ noindex })` flag, whose other callers are 404s, `/search`, and
the empty product-pair page. The two are equivalent: `follow` is every major crawler's default, so
an unqualified `noindex` still lets the products linked from a thin trade page pass authority, which
is the behaviour the original wording was reaching for. Reusing the one flag keeps a single
indexability mechanism in the app rather than a second directive string used by one caller.

**Why the `/trades` index page is exempt (AECI-546).** The floor exists to keep *thin term pages*
out of the index. `/trades` is not a term page — it is the navigational surface a crawler needs in
order to discover a term the moment it crosses the floor, and it carries the facet's own copy on top
of its published grid. Gating it would be self-defeating twice over: pre-backfill (before AECI-547)
it would remove the entry point to the whole namespace, and it would make the facet's discoverability
depend on the catalog rather than on the page. It is therefore listed unconditionally in the sitemap
and never `noindex`, exactly like `/categories`, `/audiences`, and `/phases`.

**Why the indexing pings follow the floor.** `POST /api/promote` submits affected URLs to IndexNow
and the Google Indexing API (§20.2). Pinging an indexing service for a page that serves `noindex` is
the same correctness bug the "provision `INDEXNOW_KEY` only at launch" rule exists to prevent, so
only published terms are submitted. The `/trades` **index** is submitted whenever any trade is
touched at all — published or not — because it renders live per-term counts and gains or loses a
tile on a floor crossing. AECI-542 excluded trade URLs outright and deferred the decision to
AECI-546; this is that decision.

**Why the facet sidebar is exempt (AECI-544).** Its counts come from
`GET /api/products/facets`, which is **disjunctive and scoped to the active filters** — a genuinely
published trade's count legitimately falls below 3 (often to 1) as soon as the visitor picks a
category, so applying the floor there would hide published terms at exactly the moment they are most
useful. The floor is meaningful only where the count is **unscoped** (the `/trades` index, the nav
flyout, the sitemap), and its purpose is to keep thin *pages* out of the search index — the sidebar
is a control surface, not indexable content, and a sub-floor trade offered there still leads to a
real, non-empty result set. The sidebar therefore keeps its existing cross-dimension rule: show a
term when its scoped `count > 0`, or when it is currently refined. This is a deliberate exemption,
not an implementation gap.

Two further consequences worth stating explicitly:

- **URLs are stable across the gate.** An unpublished trade still resolves at its permanent slug, so
  a trade crossing the floor becomes indexable with no redirect and no URL churn.
- **The API is not gated.** `product_count` travels on every term
  (`TaxonomyTermWithCountSchema`), and each consuming surface applies the floor. This keeps the gate
  in one presentational place instead of splitting the vocabulary into two API shapes.

`TRADE_PUBLISH_MIN_PRODUCTS` is exported from `packages/shared` (`src/api/taxonomy.ts`) alongside
the `isPublishedTrade` helper, so every consumer reads one value. **The gate is fully shipped.** Its
consumers, and where each applies the floor:

| Consumer | Where |
|---|---|
| `/trades` index grid | `apps/web/src/app/taxonomy/taxonomy-index.ts` (AECI-544) |
| Primary-nav flyout | `apps/web/src/app/core/taxonomy/taxonomy-nav.store.ts` (AECI-544) |
| XML sitemap | `apps/web/src/server/sitemap.ts` (AECI-546) |
| `<meta name="robots">` on a term page | `apps/web/src/app/taxonomy/taxonomy-browse.resolver.ts` → `applyBrowseMeta` (AECI-546) |
| IndexNow / Google Indexing submit set | `apps/api/src/routes/promote-trade-publication.ts` → `apps/api/src/routes/promote-indexnow-urls.ts` (AECI-546) |
| Admin panel — catalog coverage | `apps/api/src/lib/admin-catalog.ts` → `taxonomyUsage()` (AECI-579). Reports **published vs thin per term** so an operator can see which trade pages currently clear the floor. It is the one consumer that neither hides nor filters a sub-floor term — the whole point is to show what is still thin. It also surfaces the untagged-product count with a `trade_facet_sparse_by_design` caveat, because §1.1 makes "untagged" the correct state for most of the catalog rather than a backlog. |

The API-side consumer is the only one that must *read* the floor rather than filter data it already
holds: `affectedUrlsForPromote` is pure over the promote response, which carries no `product_count`,
so `resolvePublishedTradeSlugs` runs one grouped count **after** the batch commits (a pre-commit
count would miss a term this very promote pushed over the floor) and both pings share the single
result. This section is the governing policy.

---

## 7. The seam with Audience — documented, not resolved

**The Audience facet does not change.** `specialty-contracting` stays exactly as it is (AECI-538
out-of-scope: "Any audience-facet restructure"). Trades and Audiences overlap on purpose:

- **Audience `specialty-contracting`** = *"this software is aimed at specialty subcontractors"* — a
  positioning statement about the software.
- **Trade `electrical`** = *"this software understands electrical work"* — a statement about the
  work.

A product can carry both, one, or neither. The near-duplicate pairs to be aware of when tagging:

| Trade | Nearest existing term | How they differ |
|---|---|---|
| `hvac-mechanical`, `plumbing` | Category `mep-design`, Audience `mep-engineering` | Design/analysis software for engineers vs. software for the contractor who installs it. |
| `solar-renewables` | Category `energy-sustainability` | Whole-building energy analysis vs. PV system design and installation. |
| `structural-steel`, `precast-concrete` | Audience `structural-engineering` | Detailing/fabrication/erection vs. structural analysis and design. |
| `low-voltage-security` | Category `safety-compliance` | Systems the low-voltage trade installs vs. safety-program software. |

If a future term cannot be distinguished from an existing Category or Audience term by that test, it
does not belong in this vocabulary (§5.2).

---

## 8. Seeding conventions

**Shipped in AECI-540** as `apps/api/seed/trades.sql`, mirroring the existing taxonomy pattern
(`apps/api/seed/taxonomy.sql`, `apps/api/seed/data-objects.sql`):

- **`id`** — deterministic **UUIDv5 derived from the `slug`**, so ids are stable across re-runs and
  across environments. Ids are therefore **not** stored in this file or the JSON mirror — they are
  derived from the `slug`:

  ```
  TRADE_NAMESPACE = UUIDv5(URL_NS, 'https://aecintegrations.com/vocabulary/trade')
                  = af0d33bc-5814-524f-9c6c-cac49b84d5f0
  id              = UUIDv5(TRADE_NAMESPACE, slug)
  ```

  where `URL_NS = 6ba7b811-9dad-11d1-80b4-00c04fd430c8` (RFC 9562 §6.6). The executable reference
  is `uuidv5()` in `apps/api/src/test/d1.spec.ts`, which re-derives all 34 ids and asserts they
  match the seed file.
  > **Resolution of the AECI-539 open item.** That issue recorded the derivation as "not recorded
  > anywhere in the repo" and deferred the choice to AECI-540. Half of that was wrong: the
  > convention **is** recorded — in the header of `apps/api/seed/data-objects.sql`, as
  > `UUIDv5(URL_NS, 'https://aecintegrations.com/vocabulary/data_object')` =
  > `4a9d061b-fec7-596f-be52-8db72334eb59`, verified to reproduce the shipped `taxonomy_data_objects`
  > ids exactly. AECI-540 therefore **followed that precedent** (same construction, one vocabulary
  > path along) rather than inventing a derivation. The other half stands: the ids in
  > `taxonomy.sql` (categories / audiences / phases) match **neither** this scheme nor UUIDv5 over
  > the bare slug under any standard namespace, and their derivation remains unrecovered. Those ids
  > are already shipped and immutable, so this is a documentation gap, not a defect — a note to that
  > effect is carried in the `taxonomy.sql` header.
- **Idempotent UPSERT keyed on `slug`** (`ON CONFLICT(slug) DO UPDATE`) — re-seeding updates
  `name` / `description` / `display_order` / `aliases` in place; it **never deletes**.
- **`display_order`** carried through verbatim (10, 20, … 340).
- **`description` is seeded non-null** for every term (§5) — the column is `not null`.
- The seed writes **`taxonomy_trades` only**, never `product_trades` (those links come from the
  promote flow — AECI-542).
- **Application** is uniform across environments (ADR 0008): locally via
  `pnpm --filter @aeci/api db:seed:trades:local` (folded into `db:seed:local` / `db:setup:local`),
  and per-env via the `--remote` step in `scripts/d1-apply-migrations.sh`, which every deploy lane
  runs after `wrangler d1 migrations apply`.

---

## 9. Keeping the mirror in sync

[`trades-vocabulary.json`](./trades-vocabulary.json) is a **generated mirror** of the table in §5. It
is an object carrying `vocabulary` / `stage` / `closed` metadata plus a `terms` array — one object
per row, in `display_order` order. The markdown table is the human-edited canonical source; **edit
the table, then regenerate the JSON**, never the reverse. A row in §5 ⇔ an object in `terms`: same
`slug`, `name`, `description`, `display_order`, and `aliases`.

This is the same arrangement as `docs/DATA_OBJECT_VOCABULARY.md` ⇔
`docs/data-object-vocabulary.json`. Neither pair has an automated generator or a CI drift gate
today; keeping them in sync is a review-time responsibility.

---

## 10. Decision log — the AECI-539 open questions

Recorded as decisions, not options, per the issue's acceptance criteria. Each links to the section
that carries the reasoning.

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | Facet name + URL namespace (permanent): **Trades** (`/trades`) or **Work Types** (`/work-types`)? | **Trades** / `/trades`. Matches the issue's recommendation. "Work Types" is not language anyone in the field uses; the awkwardness for heavy-civil primes is accepted and recorded. | §2 |
| 2 | Approve/trim the draft list. Heavy-civil umbrellas (Bridges & Structures, Marine & Waterfront, Rail) in v1? | **34 terms; heavy-civil umbrellas excluded** — they are market sectors, which is a named out-of-scope follow-up. Fencing and Pools & Aquatics also dropped (no software population). Four draft terms split, nine added. **This is the one decision still wanting a human yes.** | §5, §5.2, §5.3 |
| 3 | Promote semantics: find-or-create (like categories/audiences) or resolve-only? | **Resolve-only.** Unmatched value → dropped + reported in `skipped[]` with `kind: "trade"`; never auto-created, never a promote failure. Matches the issue's recommendation and the `usefulness` / `dataObject` precedent. | §3 |
| 4 | `aliases` **column** on `taxonomy_trades` so Algolia can index aliases as searchable content? | **Yes.** JSON-mode `TEXT` in D1, mirroring `taxonomy_data_objects`. Dual-purpose here: promote resolution **and** a `trade_aliases` searchable attribute on the Algolia product record (searchable only — never faceted, never displayed, never a ranking signal). | §4, `DATABASE_SCHEMA.md` §5.3a, `SEARCH_RANKING.md` §3.1 |
| 5 | Publication gate **N**? | **`TRADE_PUBLISH_MIN_PRODUCTS = 3`**, launch-tunable. Gates which terms the `/trades` index and nav flyout list, which term URLs reach the sitemap and the indexing pings, and each term page's indexability — **not** the API, not the facet sidebar (its counts are scoped), not the `/trades` index page itself, and not the URL (an unpublished trade still resolves, so crossing the floor needs no redirect). | §6 |
| 6 | May connector-role products carry trade tags, or apps only? | **All roles, connectors included.** A connector built for a trade ERP is as trade-specific as an app. `product_role` is never a gate; the §1.1 trade-specific-value rule is the only one. | §5.4 |

**The one item deferred to AECI-540 is now closed.** This issue deferred the UUIDv5 namespace +
name form, believing it was recorded nowhere in the repo. It **is** recorded — in the
`apps/api/seed/data-objects.sql` header — so AECI-540 followed that precedent instead of inventing
one: `TRADE_NAMESPACE = UUIDv5(URL_NS, 'https://aecintegrations.com/vocabulary/trade')` =
`af0d33bc-5814-524f-9c6c-cac49b84d5f0`, and `id = UUIDv5(TRADE_NAMESPACE, slug)`. The derivation
behind the *original three* facets in `taxonomy.sql` is still unrecovered (checked again in
AECI-540: it matches neither this scheme nor the bare slug under any standard namespace); those ids
are shipped and immutable, so it stays a documentation gap. Full detail: §8.
