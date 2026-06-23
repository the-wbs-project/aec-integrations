# 0014 — `instantsearch.js` + connectors over `angular-instantsearch`

**Status:** Accepted (2026-06-10, AECI-142). Narrows `STAGE_1_SPEC.md` §7.5 for the `/search` page; companion to ADR 0006 (Algolia chosen for search).

## Context

Spec §7.5 ("InstantSearch integration") names **`angular-instantsearch` v4+** and its `ais-*`
widgets (`ais-instant-search`, `ais-search-box`, `ais-hits`, `ais-refinement-list`,
`ais-range-input`, `ais-pagination`, `ais-stats`) as the `/search` implementation. When
AECI-142 (Phase 3.9) came to build the consumer, that package turned out to be unusable on
this stack:

- `angular-instantsearch@4.4.3` hard-caps its peer dependency at `@angular/core >=5.0.0 <16.0.0`.
  This repo is Angular **22** (zoneless, standalone, SSR). Installing it forces a peer-range
  override and runs unsupported, pre-Ivy-era code against a runtime it was never built for.
- It is officially **deprecated**, and Algolia's own documentation states it "isn't compatible
  with the latest Angular versions."
- Its widgets are component-based and assume `NgModule` + zone.js change detection — neither of
  which exists here (`provideZonelessChangeDetection()`, no `zone.js`).

So §7.5 cannot be implemented as written. Per `CLAUDE.md` ("When the spec is wrong… raise it,
don't silently work around"), this ADR records the deviation rather than burying it.

## Decision

Build `/search` with **`instantsearch.js` (the vanilla JS library) using connectors only**,
render results with Angular templates, and push each connector's render state into Angular
**signals** via a small browser-only adapter (`apps/web/src/app/search/search-controller.ts`).
This is the path Algolia officially recommends for modern Angular.

Key properties:

- **Zoneless-safe:** connector render callbacks write signals; signal writes schedule change
  detection. No `markForCheck`/`detectChanges`, no zone.
- **SSR-safe:** `instantsearch.js` and `algoliasearch/lite` touch browser globals at module
  scope, so they are reached ONLY through a dynamic `import()` isolated in
  `search-controller.factory.ts`, invoked inside `afterNextRender` (browser-only). The SSR
  shell (meta + search box + tablist + empty/loading state) renders without the SDK; the heavy
  chunk is lazy-loaded for `/search` only — never in the initial or SSR bundle. Mirrors the
  `datadog.provider.ts` discipline.
- **Architecture:** one root `instantsearch()` (root index `products`) plus two nested `index()`
  widgets (`vendors`, `integrations`), one shared `searchBox` → three index queries batched per
  keystroke; per-tab counts are each index's `connectStats.nbHits`; tab switching is pure
  show/hide of materialized signal slices (no re-query). The §7.2 facets map to
  `connectRefinementList` / `connectNumericMenu` / `connectRange`; `?q=`/`?tab=` (only) sync to
  the URL — facets stay in-memory to avoid the §9.2 "query-string explosion."

The acceptance criteria of §4.6 / §7.5 (browser-side search-only key, faceted, entity tabs,
branded hit cards, empty state, noindex, non-cacheable, both themes, axe-AA) are all met — only
the *named library* differs.

A required build-config note: the browser-only chunk pulls `instantsearch.js → qs →
object-inspect`, whose Node entry does a bare `require('util')`. The browser build stubs it via
object-inspect's `browser` field; the SSR build (`platform: neutral`) cannot, so `util` is added
to `externalDependencies` in `angular.json`. Safe because the chunk is never loaded server-side
(it is dynamically imported only in `afterNextRender`) and `nodejs_compat` provides `util` at
runtime regardless.

## Consequences

- The spec's `ais-*` widget vocabulary does not appear in the codebase. Anyone grepping §7.5
  against the source will not find it — this ADR is the bridge. A short §7.5 edit pointing here
  is proposed.
- We own a thin adapter (`SearchController` + three facet widgets + three hit cards) instead of
  leaning on a widget library. That is *more* code, but it is fully unit-testable (the adapter
  takes a structural `InstantSearchLib`, so tests drive connector→signal mapping with fakes — no
  network, no real SDK) and it is the only Angular-22-compatible option.
- **Per-tab sort dropdown (AECI-175, shipped).** §4.6's "Sort options per tab" is now live for
  Products and Vendors (Relevance · Most integrations · Name A–Z), backed by Algolia **standard
  replica** indexes. `connectSortBy` is wired per index in `search-controller.ts` (the deferral
  marker is gone); the `aec-search-sort-by` widget is a non-editable Aria combobox + listbox
  (ADR 0010); `REPLICA_SORTS` + `applyIndexSettingsTo` in `packages/shared/src/algolia.ts` own
  the replica model; the active sort mirrors to `?sort=`. The Integrations tab stays hidden
  (§7.5) so it gets no replicas. Standard replicas auto-mirror their primary (4 replicas = 4×
  the products+vendors record footprint, accepted for exact ordering). Full model:
  `SEARCH_RANKING.md` §5a.
- If a future Angular-native InstantSearch binding ships (or `@angular/aria`-based community
  widgets mature), revisit; the connector→signal seam localizes the blast radius of a swap to
  `search-controller.ts` + `search-controller.factory.ts`.
