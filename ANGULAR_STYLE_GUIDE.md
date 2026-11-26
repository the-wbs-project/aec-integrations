# AEC Integrations — Angular & TypeScript Style Guide

How we write Angular and TypeScript in this codebase. Source of truth for "how it should look" — distinct from `DESIGN.md` (visual system), `PRODUCT.md` (strategy), and `docs/design/v0-porting-rules.md` (v0 → Angular translation).

**Audience:** humans and AI agents (Claude Code, Conductor) authoring or reviewing code in `apps/web/` and any future Angular app in this monorepo.

**Lint enforcement:** rules tagged `Lint: ✅` are enforced by `pnpm lint` and gated in CI (`.github/workflows/deploy.yml` — the `lint-and-types` job fails the build, and it is a required check on `main`). Enforcement means ESLint *or* the `check-source-constraints.mjs` line scanner that runs in the same `lint` script — see §24 for which does what and why some constraints can only be caught by the latter. Rules tagged `Lint: 🟡 review-only` are the reviewer's job — see `docs/CODE_REVIEW_CHECKLIST.md`. The full mapping is in §24.

---

## 1. Purpose & scope

This guide governs every `.ts` and `.html` file under `apps/web/`. It defers to:

- **`DESIGN.md`** (repo root) for color tokens, typography scales, component visual specs.
- **`PRODUCT.md`** (repo root) for voice, tone, anti-references.
- **`docs/design/v0-porting-rules.md`** for v0.dev → Angular porting mechanics.
- **`CLAUDE.md`** (repo root) for stack-wide constraints (Drizzle/D1 data layer, cache invalidation, i18n, light theme only, no pay-for-placement).
- **`docs/STAGE_1_SPEC.md`** §2a.2 + §16 Phase 1 for the spec contract these rules implement.

If a rule here contradicts one of those, the more-specific document wins.

---

## 2. TypeScript baseline

- `strict: true` is on in every `tsconfig.json` (`apps/web/tsconfig.json`); don't disable.
- Prefer type inference when the type is obvious. Don't restate inferable types (`const x: number = 1` → `const x = 1`). Lint: ✅ `@typescript-eslint/no-inferrable-types`.
- Avoid `any`. Use `unknown` and narrow with type predicates, `instanceof`, or schema validation (Zod at the boundary). Lint: ✅ `@typescript-eslint/no-explicit-any` (`error`).
- Unused vars: prefix with `_` to escape (`_unused`, `_err`). Lint: ✅ `@typescript-eslint/no-unused-vars` (`error`).
- Boundary validation (HTTP, Worker bindings, env, user input) lives in `packages/shared/src/api/*` Zod schemas — see `docs/API_CONTRACTS.md` §2.

---

## 3. Angular 21 + zoneless

- `provideZonelessChangeDetection()` is the first provider in every `ApplicationConfig`. No `zone.js` in `polyfills` or anywhere else. Reference: `apps/web/src/app/app.config.ts:16`.
- Pair zoneless with `provideClientHydration(withI18nSupport(), withHttpTransferCacheOptions({ includePostRequests: false }))`. Angular v22 incremental hydration is the default and auto-enables event replay, so a separate `withEventReplay()` is redundant (AECI-130). `withI18nSupport()` is not optional. Without it Angular stamps `ngSkipHydration` on every component whose template uses `i18n`, which here is the header, the footer and every page body. Those views are destroyed and re-rendered on the client, and the server drops the event-replay contract script because no listener was annotated (AECI-1655). `e2e/ssr-hydration-contract.spec.ts` guards both. Reference: `provideClientHydration` in `apps/web/src/app/app.config.ts`.
- **A handler that calls `preventDefault` returns early on a replayed event first.** Event replay hands a click, submit or key press made before the app was stable to the real listener after hydration. The inline contract never cancels the event, so the browser has already run the native default: followed the link, scrolled on the arrow key, sent a `method="get"` search form to `/search`. A `method="dialog"` form, which is every other form (AECI-1919), ran a native submit that does nothing, so the page stays and the press is replayed into the listener. On a replay Angular sets `event.eventPhase` to `EventPhase.REPLAY` and makes `preventDefault` throw, and the error would reach `PosthogErrorHandler`. So start such a handler with `if (isReplayedEvent(event)) return;` (`core/event-replay.ts`), before the `preventDefault` call. A replayed form press is dropped, never submitted. On a form use `(aecSubmit)="save()"` (`AecFormSubmit`, `shared/form-field/form-submit.ts`), which guards and cancels for you. Do not write an inline `(submit)="$event.preventDefault(); save()"` or `(keydown.enter)="$event.preventDefault()"`: the element can be in the SSR HTML more often than it looks, since admin and portal pages render on the server when signed in. Global `document:` and `window:` listeners and listeners added in code are never replayed. The helper is pinned against Angular's own replay primitives in `core/event-replay.component.spec.ts`.
- **An `<a href>` that relies on its native default carries no listener of its own.** Once an anchor that owns a click listener takes a click before the app is stable, Angular's dispatcher calls `preventDefault` on every later click on that anchor. The action cache outlives the `jsaction` attribute, and with incremental hydration the contract keeps listening. A same-page `#fragment` link or a `target="_blank"` link then goes dead. Put a highlight or tracking listener on a non-anchor ancestor, the component host for example, and find the anchor with `closest('a')`. `SectionNav` (`shared/section-nav/section-nav.ts`) is the worked example. Anchors whose handler cancels the click anyway (`RouterLink`, `aecRequestTrigger`, `aecClaimDialogTrigger` with a dialog on the page) lose nothing. A modified click (new tab) is not affected, and neither is an early click that already left the page.
- **Never write a bare `href="#id"`.** The app ships `<base href="/">`, so a fragment-only href resolves to `/#id` and loads the home page from every other route (AECI-1839: the skip link did this on every page but `/`). Build `{path}#id` instead, from `shared/in-page-href.ts`: `injectInPageHref(id)` for one link (the skip link), and `injectInPageHrefFor()` for a component with several (`SectionNav`, the docs rail and the vendor integration page nav, AECI-1843). Never build the href from a path alone: on a URL with a query (`?utm_source=…`) a path-only href is a different URL, so the click loads the whole page again. It reads `Location` and follows `Location.onUrlChange`, so it stays right after a `replaceState` that fires no router event. The router reports `/` until the first navigation ends, which is why it does not read `router.url`. In the browser it keeps the whole query, so the jump never reloads. In the server render it keeps only the params the route's edge cache key keeps, from `core/route-cache-key.ts`, the same code `cacheKeyFor` uses. It keeps the whole query on paths listed by `isNeverCacheablePath`, such as `/search`, `/admin` and the email token pages `/unsubscribe`, `/claims/confirm` and `/notifications/mute` (AECI-1848). It also keeps it on any render from the runtime's non-cacheable branch that is not a 404, such as `/contact?topic=add-product` (`edgeCacheable` on the request context, AECI-1848). A param a cached page reads only after hydration, such as `/vendor-program?vendor=`, is dropped from the server href, so an Enter on the skip link before hydration reloads the page without it. `<main id="main" tabindex="-1">` makes the skip link's target focusable.
- `provideRouter` gets `withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' })` so new routes open at the top and Back/Forward restores scroll (`apps/web/src/app/app.config.ts:19-40`). The router resets scroll with `window.scrollTo`, which honors any smooth `scroll-behavior` on `<html>`. Angular 22 passes `behavior: 'instant'` only when it restores a saved position on Back/Forward, not for the scroll to the top of a forward navigation or for an anchor scroll, so a browser-only `ScrollBehaviorManager` (`core/scroll-behavior-manager.ts`, started from `App`) forces the reset instant. Smooth scrolling is not global (AECI-1752): it is on only for the span of an in-page section-link jump, through `InPageSmoothScroll` (see "Smooth scrolling is scoped to in-page section links" below). A browser-only `InitialFragmentScroller` (`core/initial-fragment-scroller.ts`, also started from `App`) covers the one case the router misses — the *initial* load of a `…#section` deep link, where no `Scroll` event fires on the initial hydration navigation and `scrollRestoration: 'manual'` has disabled the browser's native jump. A browser-only `PreStableScrollReset` (`core/pre-stable-scroll-reset.ts`, also started from `App`) covers the other: a client navigation that ends before the app is first stable, which the router also leaves unscrolled. Don't route in-page section jumps through the router — they're native `<a href="{path}#id">` anchors by design. That does **not** make them invisible to the router: a same-document fragment navigation fires `popstate`, Angular reads `popstate` as a browser-driven navigation, and `RouterScroller` asks to re-scroll to the fragment while the browser's smooth scroll is still running. `provideScrollMarginViewportScroller()` (`core/scroll-margin-viewport-scroller.ts`) skips that scroll, and honors the target's `scroll-margin-*` on every fragment scroll it does perform, which Angular's stock `ViewportScroller` does not. Any anchor that must clear a sticky bar declares the clearance in CSS (`scroll-mt-*`), never as a `ViewportScroller.setOffset()` constant.
- Don't reintroduce `zone.js` to make a flaky test pass — fix the test instead.

Lint: ✅ `no-restricted-imports` bans `zone.js`, `zone.js/*`, and the `NgZone` / `provideZoneChangeDetection` symbols from `@angular/core` in every package, tests included (AECI-549). 🟡 review-only for the *ordering* of the hydration providers, which no rule checks.

### Operating notes (moved from CLAUDE.md, 2026-09-23)

- **In-page listing controls opt out per navigation.** A filter, sort or view change on a listing page (`/products`, the browse pages, `/search`) is a query-param navigation, so the router would jump to the top after each one. Those navigations pass `scroll: 'manual'` (Angular 22 `NavigationExtras`), so the reader stays where they were while ticking several filters (`DESIGN.md` "The Same-Behavior Rule", 2026-10-26). Back/Forward still restores the saved position, and a link to another page still opens at the top. Don't turn scroll restoration off globally to get this.
- **Why the router resets scroll at all.** SPA navigations are same-document, so without `withInMemoryScrolling` the browser carries the previous page's scroll offset over to the new route.
- **The fragment-click re-scroll, in full.** The section-nav ships plain `<a href="{path}#id">` anchors so the browser scrolls natively. A fragment navigation fires `popstate` as well as `hashchange`. Angular's `HistoryStateManager` treats `popstate` as a browser-driven navigation, so the router runs a navigation and `RouterScroller` asks to re-scroll to the same fragment a moment later, while the browser's smooth scroll is still running.
- **Why the re-scroll is skipped.** Interrupting that smooth scroll desynced Safari: it painted the target while `scrollY` stayed near the old position, so hover and clicks hit whatever sat at the stale position until the next scroll (measured on Safari 26.6.2, 2026-11-02). `ScrollMarginViewportScroller` listens for `popstate` and skips the scroll for that fragment, keeping only the focus step. It cannot use `hashchange`, because re-clicking the link for the fragment already in the URL fires `popstate` alone. `routerLink [fragment]` navigations use `pushState`, fire no `popstate`, and still scroll.
- **Why the stock scroller overshot.** Angular's `ViewportScroller.scrollToAnchor()` computes the scroll as `rect.top + scrollY - offset` and ignores `scroll-margin-top` entirely. It overshot the browser's correct landing by each section's `scroll-mt-20` and parked the `<h2>` under the sticky nav.
- **Where the fix lives.** `provideScrollMarginViewportScroller()` is in `apps/web/src/app/core/scroll-margin-viewport-scroller.ts`. It is registered after `provideRouter` in `app.config.ts`. It subtracts the target's own `scroll-margin-*`, so a router-driven fragment scroll lands on the same pixel a native one does.
- **Do not use `setOffset([0, N])` for a future variant.** That offset is global. It would open an N-pixel gap on every anchor with no sticky nav above it, starting with `#main`.
- **The initial deep-link gap.** `withInMemoryScrolling` itself sets `history.scrollRestoration = 'manual'`, which disables the browser's native scroll to `#id` on load. The router does not emit a `Scroll` event on the initial hydration navigation. So a reload or an externally shared `…#section` link would land at the top.
- **How `InitialFragmentScroller` closes it.** It lives in `apps/web/src/app/core/initial-fragment-scroller.ts`. On the first `NavigationEnd` it scrolls to `location.hash` via `Element.scrollIntoView()`, which honors each detail section's `scroll-mt-20`.
- **The pre-stable gap (AECI-1629).** With SSR hydration on, `RouterScroller` skips its scroll for every navigation that ends before `ApplicationRef.whenStable()` first resolves, not only the initial one. Any in-flight `httpResource` keeps the app unstable. So a row clicked on `/products` while the facets request is still loading opened the detail page at the listing's offset. CI saw it as `scrollY` 143.
- **How `PreStableScrollReset` closes it.** It lives in `apps/web/src/app/core/pre-stable-scroll-reset.ts`. Until the app is first stable, it waits out the router's scroll delay after each later `NavigationEnd`. If the router emitted no `Scroll` event for that navigation, it does what the router would have done: restore the saved position on Back/Forward, scroll to the fragment, or scroll to the top. It honors `scroll: 'manual'`. It never doubles a router scroll, so it stands down by itself if Angular closes the gap. `e2e/scroll-restoration.spec.ts` holds the facets request open to reproduce the gap.
- **Back needs the page as tall as the reader left it (AECI-1900).** The router restores the saved position one frame after the page renders. A page that fetches its rows on that render is too short then, so the browser clamps the position and scroll anchoring moves it again as the rows arrive. Measured on `/products`: left at 1,200, landed at 3,503. The fix belongs in the data layer, never in a second scroller.
- **What is stored.** The listings keep the pages they rendered, "Load more" pages included, in `ListingHistoryStore` (`apps/web/src/app/shared/paginated-index/listing-history-store.ts`). On a filtered listing the rows are few and the filter panel sets the page height, so `FacetSidebar` keeps its last counts in `FacetHistoryStore` under the same rules. Measured with one filter before that: left at 1,576, landed at 1,925.
- **The rules of both stores.** In memory, per tab, never in localStorage, sessionStorage or a cookie, so a reload empties them. The server never reads or writes them. Each holds the last 5 entries. An entry older than 5 minutes is dropped and the page fetches, because a restore makes no request and could otherwise show a product since hidden or a logo an unclaimed listing no longer shows (ADR 0051). Five minutes is the edge TTL of the index and browse pages.
- **The key.** The route plus the full request line (for the counts, the counts request line), plus the history entry. The router writes `navigationId` into `history.state` for every entry and rewrites it on each Back or Forward. A listing records the id of the last `NavigationEnd` as the reader leaves the entry. A Back hands the same id back as `NavigationStart.restoredState.navigationId`. `HistoryTraversal` tracks both from the router events, because `Navigation` does not expose `restoredState`. So two visits to one URL in one tab keep their own pages. A Back or Forward leaves the entry's old id in no history entry, so a save under the new id first drops every entry stored under the old one (`retire`, at save time only). Repeat trips then do not fill the 5-entry bound with dead entries. Only when the entry carries no router id does a read fall back to the newest entry for the URL.
- **When the stores are written and read.** Written as the reader leaves each history entry: at every `NavigationStart`, and when the listing is torn down. Read only on a Back or Forward (`popstate`), never on a fresh navigation, which fetches as before. They are read in two places. The first is when the listing and its panel are created by a Back or Forward from another page. The second is on each later change of request line, because a Back or Forward between two filter or sort states on the same page keeps the same component. Before that second read, such a Back refetched page 1, lost the "Load more" pages and moved the reader by up to 352px. The panel is created in the page's first render, which can come after `NavigationEnd`, so both read through `HistoryTraversal` rather than `router.currentNavigation()`.
- **Covered.** `/products` and the four term pages, with or without filters and "Load more" pages. That holds for Back and Forward from another page, and between filter or sort states on the page.
- **The first page follows `?page=` (AECI-1902).** The listing starts its buffer at the URL's `?page=` on every navigation, not only when it is built. So the header link from `/products?page=2` to `/products` shows page 1 with "Load more", and a Back to a listing opened at `?page=K` across an in-page filter change returns to page K and its stored pages. A change of the first page reads the store again even when the request line comes out the same. The taxonomy index pages and the vendor page get their rows from a route resolver, so they are tall in time already.
- **`/search` (AECI-1899's batch).** Its rows come from Algolia only after the search code loads, after the first render. Measured by a reviewer before the fix: left at 3,200, clamped to 1,341, landed at 3,457. `SearchHistoryStore` (`apps/web/src/app/search/search-history.ts`) extends the same bounded base, so its rules are the ones above. The key is the path, the query, the tab, the sort and every filter and range of both tabs, plus the history entry. The value is both tabs as they were: every loaded page of hits, the counts, the sort and each facet's rows. On a Back or Forward the page draws that in its first frame, before the search code loads. The controller then starts on the same URL state, with its infinite-hits cache already holding those pages, so it takes over the rows without a loading state or a re-order. Its first search is one request for page 0 with the query in it. "Load more" then asks for the page after the last one held. A filter, sort or query changed before that first answer drops the held pages for its tab, and the rows on screen stay until the new search answers. Before that rule, a change after a failed first answer drew the stored rows under the new count. The page saves only a state that matches the URL exactly, so typing not yet in `?q=` stores nothing.
- **Not covered.** On `/search`, a Back or Forward between two states on the page itself (a filter, tab or sort step) keeps the component and refetches as before. A Back after the entry has aged out, been pushed out of the last 5, or been lost to a reload fetches as a fresh visit. On a short filtered page the reader can then land off their place. A second Back pressed before the router has rendered the first one supersedes that navigation. Where the reader lands then is the router's own behaviour.
- Full paths for the other helpers: `apps/web/src/app/core/scroll-behavior-manager.ts` (`ScrollBehaviorManager`, which toggles `scroll-behavior: auto` for the span of each navigation), the fragment scroller and `PreStableScrollReset` above. All three are started from `App`.
- **Smooth scrolling is scoped to in-page section links (AECI-1752, clash 38 of ADR 0059).** `styles.css` has no global `html { scroll-behavior: smooth }`. The rule is `html.aeci-smooth-scroll { scroll-behavior: smooth }`, inside `@media (prefers-reduced-motion: no-preference)`. `InPageSmoothScroll` (`apps/web/src/app/core/in-page-smooth-scroll.ts`, started from `App`) adds that class when a reader clicks an `<a data-smooth-scroll>` link to a `#fragment` on the current page. It removes the class at `scrollend`, or after 1.5 seconds. The browser still does the scroll, so the target's `scroll-mt-*` holds. Everything else scrolls instantly: the skip link, router restoration, `InitialFragmentScroller`, `routerLink [fragment]` links such as the `/vendor-program` plan links, and every programmatic scroll. Every `scrollIntoView()` and `scrollTo()` outside the router passes `behavior: 'instant'`. Safari 17.0 to 26.1 have no `scrollend`, so there the class stays on for the full 1.5 seconds, and a call with no `behavior` in that window would animate.
- **A navigation to another page cancels a glide in flight (AECI-1907).** The inline `scroll-behavior: auto` that `ScrollBehaviorManager` sets at `NavigationStart` does not stop a smooth scroll the browser has already started. A link clicked mid-glide let that glide run on into the new page. The router's reset then either landed while it was still running and ended partway down (measured: 24, 39 and 153px), or glided itself, because the deferred restore had dropped the inline style while the class was still on. So `InPageSmoothScroll` watches `NavigationStart`. When a jump is armed and the navigation goes to another path or query, it takes the class off and makes one instant `scrollTo` to the current position, which aborts the browser's animation. The router's scroll for the new page is then the last write. A `NavigationStart` to a fragment of the same page is the jump's own `popstate`, so it is left alone, and a second section link still replaces the first glide smoothly. Reduced motion never arms, so it is unchanged. Do not add a timer, a frame loop, `setOffset`, or any code that re-applies a position after the router's scroll. The class stays the one switch. `e2e/scroll-restoration.spec.ts` starts each race only once the glide is in flight: a route link, Back, a second section link, and a docs search hit with a fragment.
- **Opting a link in.** Add the bare `data-smooth-scroll` attribute to a plain `<a href="{path}#id">`. The attribute has no effect on a `routerLink`: `RouterLink` cancels the click, and the router's scroll is always instant. An in-page section nav that should animate must therefore be plain anchors, with any click listener on a non-anchor ancestor (the AECI-1655 rule above). Opted in today: the product page section nav and its "N reviews" link, the docs "On this page" rail, the `/account` section nav, and the vendor integration page nav. Never put it on the skip link.
- **One mechanism, one switch.** Never turn smooth scrolling on any other way: no `scroll-behavior: smooth` in a stylesheet or via `style.setProperty`, no Tailwind `scroll-smooth`, no inline `scrollBehavior` or `[style.scroll-behavior]` binding, no `behavior: 'smooth'` option on a scroll call, and no use of the `aeci-smooth-scroll` class outside the service. Lint: ✅ `no-smooth-scroll` in `apps/web/scripts/check-source-constraints.mjs`, which allow-lists only `styles.css`, `core/in-page-smooth-scroll.ts` and `index.html` (the switch site). The scanner reads comments too, so describe the banned forms in prose.
- **The switch back to the old global smooth scroll.** Add `class="aeci-smooth-scroll"` to the `<html>` element in `apps/web/src/index.html`. The rule then applies from the first paint, server-rendered HTML included. `InPageSmoothScroll.start()` sees the class and stands down, so it never strips it. `ScrollBehaviorManager` keeps router scrolls instant and reduced motion still wins. Two e2e tests in `apps/web/e2e/scroll-restoration.spec.ts` assert the scoped behaviour and fail when the switch is flipped, so update them in the same change: "a section-nav click animates and lands the section below the nav" (it checks `<html>` is `auto` at rest) and the two "the skip link jumps without animation …" tests. The test "the switch: with the class on <html>, …" covers the flipped state. Chris asked for this switch (clash 38, "Make sure we know how to adopt the old way if needed").

---

## 4. Standalone everywhere, no `NgModule`

- Every component, directive, and pipe is standalone with an explicit `imports: [...]` array.
- **Do not** set `standalone: true` in the `@Component` / `@Directive` / `@Pipe` decorator — it's the default since Angular v20. Setting it explicitly is dead code.
- No `NgModule` declarations. If you find one in `node_modules` types, that's third-party, not us.

Lint: ✅ `@angular-eslint/prefer-standalone`.

---

## 5. OnPush change detection

OnPush is the **default** change detection strategy in Angular v22+ ([Angular docs](https://angular.dev/best-practices/skipping-subtrees#using-onpush)). **Do not** declare `changeDetection: ChangeDetectionStrategy.OnPush` in the `@Component` decorator — it's redundant dead code, exactly like an explicit `standalone: true` (§4).

Write components to stay OnPush-compatible: drive state with signals, treat inputs as immutable, and call `inject(ChangeDetectorRef).markForCheck()` only in the rare case of manually mutating an input acquired via `@ViewChild` / `@ContentChild`.

Lint: none — it's the framework default. The former `@angular-eslint/prefer-on-push-component-change-detection` rule was removed in AECI-125.

---

## 6. File & class naming (Angular 20+ convention)

- TypeScript files use bare names — `vendor-detail.ts`, not `vendor-detail.component.ts`.
- Class names match without the `Component` / `Directive` / `Pipe` suffix — `class VendorDetail`, not `class VendorDetailComponent`.
- Templates and styles colocated as `*.html` / `*.css` next to the `.ts` file. Use `templateUrl: './vendor-detail.html'` (relative path).
- Inline templates are fine — and encouraged — for small components (< ~40 template lines). Reference inline example: `apps/web/src/app/app.ts:9-13`, `apps/web/src/app/demo/spartan-demo.ts`.
- Selectors: components are kebab-case elements with the `app-` or `aec-` prefix; directives are camelCase attributes with the `app` prefix. Enforced per-app in `apps/web/eslint.config.mjs`.

Lint: ✅ `@angular-eslint/component-class-suffix: 'off'` and `@angular-eslint/directive-class-suffix: 'off'` (the rules default to *requiring* the suffix; we override).

---

## 7. New control flow only

Use `@if` / `@for` / `@switch`. The legacy structural directives — `*ngIf`, `*ngFor`, `*ngSwitch`, and `[ngSwitch]` — are banned.

- `@for` **must** include a `track` expression (use `$index` only if there's no stable identity).
- Use `@empty { ... }` for empty-list states; prefer it over a separate `@if (items.length === 0)`.
- Use `@else { ... }` for the false branch; don't write two separate `@if` blocks for binary state.

References: `apps/web/src/app/preview/vendor-detail/vendor-detail.html:109,112,243`, `apps/web/src/app/home/home.ts:23` (`@for (m of modes; track m)`).

Lint: ✅ `@angular-eslint/template/prefer-control-flow`, `@angular-eslint/template/prefer-at-empty`, `@angular-eslint/template/prefer-at-else`, `@angular-eslint/template/use-track-by-function`.

---

## 8. Templates: simple and declarative

- **No `ngClass`.** Use class bindings: `[class.is-active]="active()"` or `[class]="classExpr()"`. Lint: ✅ `@angular-eslint/template/prefer-class-binding`.
- **No `ngStyle`.** Use style bindings: `[style.color]="color()"`, `[style.background]="bg()"`. Lint: 🟡 review-only (no built-in ESLint rule).
- **Async pipe for observables.** `{{ items$ | async }}`, not manual `.subscribe()` in the component class. If state is observable-shaped but only emits once, convert to a signal at the boundary. Lint: 🟡 review-only.
- **No globals at template render.** `new Date()` and friends mean "server time on SSR, client time after hydration" — they cause hydration mismatches. Pass values in as inputs, freeze in a signal at component init, or compute server-side. Lint: 🟡 review-only.
- **No `$any()` template escapes.** If a template needs `$any()`, the underlying type is wrong — fix the type. Lint: ✅ `@angular-eslint/template/no-any`.
- **Keep heavy method calls out of templates** where you can — push to `computed()` or a pure pipe so change detection isn't re-running the function every cycle. Lint: 🟡 review-only (`@angular-eslint/template/no-call-expression` conflicts with the signal-invocation idiom `mySignal()` and would be perpetual noise; intent is enforced by review, not lint).
- **Inline text next to an element on the next line needs `&ngsp;`.** Angular's default `preserveWhitespaces: false` collapses the newline between adjacent nodes, so `<ng-container i18n="…">Built by</ng-container>` followed by a `<a>` on the next line renders `Built byAgave`. Flex `gap-*` only helps when the two nodes are direct flex children; inside a plain `<span>` or `<p>` they aren't. Append `&ngsp;` after the closing tag (Prettier may wrap the closing bracket onto the `&ngsp;` line — that's equivalent). Cover it with a spec that normalizes `textContent` whitespace and asserts the joined string, since the two-node markup looks correct on inspection. The same trap breaks anything read as one string: a visible `<span>Remove</span>` plus an `sr-only` span on the next line gives the button name "RemoveJane", and a heading that names a region or a checklist row title runs its words together the same way. Put `&ngsp;` between the spans, or as the first thing inside the `sr-only` span (or inside the `@if`, before its element) when it sits next to a control-flow block, because a space beside a control-flow block is stripped too. Assert the element's exact `textContent` (AECI-1469 buttons, AECI-1471 the review-reply heading and checklist rows). Lint: 🟡 review-only.
- **No template-driven forms.** Use Signal Forms (`@angular/forms/signals`) — see §13. No `[(ngModel)]` in a form context. Lint: 🟡 review-only.

---

## 9. Dependency injection via `inject()`

- Use `inject(Token)` at field initialization. No constructor parameter DI.
- Pattern: `private readonly themeService = inject(ThemeService);`
- Optional dependencies: `inject(REQUEST, { optional: true })` — reference: `apps/web/src/app/theme.service.ts:32`.
- Injection tokens (e.g., `DOCUMENT`, `PLATFORM_ID`, `REQUEST`) get injected, never reached for as globals.
- **Do not call `inject()` inside the constructor body.** `@angular-eslint/prefer-inject` only catches constructor-parameter DI and will not flag `inject()` called inside `constructor() { ... }`. A `no-restricted-syntax` rule in `eslint.config.base.mjs` closes this gap and will error on that pattern.

Lint: ✅ `@angular-eslint/prefer-inject` + `no-restricted-syntax` (constructor-body `inject()`).

---

## 10. Host bindings via the `host` object

Use the `host: { ... }` metadata property on `@Component` / `@Directive`. Never `@HostBinding` or `@HostListener` decorators.

```ts
@Component({
  selector: 'app-thing',
  host: {
    '[class.is-open]': 'isOpen()',
    '(click)': 'onClick($event)',
  },
  // ...
})
```

Lint: ✅ `@angular-eslint/prefer-host-metadata-property`.

**A static `class` beside a class binding is briefly dropped at hydration (AECI-1937).** When Angular hydrates or creates an element, it writes the element's static classes with one `setAttribute('class', …)` (`setupStaticAttributes`). That covers the template's `class="mt-12"` plus any static host `class`. On a hydrated node, that write replaces the server's full class list with the static part alone. Bound classes (`[class]`, `[class.x]`, a directive's host `[class]`) come back in the first update pass. The zoneless scheduler runs that pass before any rendering step, so no frame paints the bare state.

- **What was measured.** A MutationObserver sees the reduced list on every load of the 404 page and the home page, for example `aecButton` and `aecCard` hosts. Across more than 70 throttled loads, a style probe saw the browser resolve style in the gap zero times. No reader-visible state was measured.
- **What makes it visible.** A script that reads style during the gap, such as `getComputedStyle` or a test tool polling an element, resolves the element without its bound classes. A later change then starts any transition it has. That is what made the AECI-1922 e2e flaky: Playwright read the 404 button mid-fade as rgb(31, 58, 47). Don't read style in a hydration callback or during creation.
- **The rule for new code.** Give an element one class binding, with no static `class` beside it. That applies to an element that binds `[class]` and to an element carrying a directive that binds `[class]`, such as `aecButton` or `aecCard`. Write `[class]="'mt-5 flex ' + layout()"`, not `class="mt-5 flex" [class.lg:grid]="split()"`. An element with no static class is never touched by the write, so a hydrated node keeps the server's list until the update pass. Existing pairs are tracked in AECI-1938, at low priority.
- **The guard.** `e2e/hydration-class-recipe.spec.ts` injects a 1ms animation for an `aecButton` or `aecCard` without its recipe's first class, and fails on `animationstart`. It loads five routes passively. It fails only if something starts resolving style in the gap. It reads no style itself, because its own read would start the transitions it looks for.
- **Upstream.** On a hydrated node, Angular rewrites a class attribute that already holds the server's list. That could be reported to Angular. No report has been filed.

---

## 11. Signals over RxJS

- Use `signal()`, `computed()`, `effect()` for component and service state. Reference: `apps/web/src/app/theme.service.ts:34-47`.
- RxJS is reserved for genuine multi-emission streams (HTTP responses are `Observable` by default — fine; router events; user-input debouncing).
- One-shot data (e.g., a single HTTP response feeding component state) → convert to a signal at the boundary with `toSignal()` or `httpResource()` instead of `subscribe` + manual state.
- **Don't `mutate()` a signal** — that API was removed in Angular 17. Use `signal.set(...)` or `signal.update(prev => ...)`.
- `computed()` must `return` a value on every code path. Lint: ✅ `@angular-eslint/computed-must-return`.
- Don't reference a signal without invoking it (`mySignal` instead of `mySignal()`) — that's almost always a bug. Lint: 🟡 deferred (`@angular-eslint/no-uncalled-signals` requires typed linting — see §24 "Future enforcement").

Lint: 🟡 deferred for `@angular-eslint/prefer-signals` (requires typed linting); rest review-only.

---

## 12. Component I/O: `input()` / `output()` / `model()`

- Inputs via `input()` / `input.required()` / `input<T>(default, { transform: ... })`.
- Outputs via `output<Event>()`.
- Two-way bindings via `model()`.
- **No `@Input()` / `@Output()` decorators.** No `EventEmitter` instantiation by hand.
- No input renaming (`@Input('foo') bar`) and no output renaming — the alias makes refactor and review harder. Lint: ✅ `@angular-eslint/no-input-rename`, `@angular-eslint/no-output-rename`.

Lint: ✅ `@angular-eslint/prefer-signal-model`, `@angular-eslint/prefer-output-emitter-ref`, `@angular-eslint/prefer-output-readonly`.

---

## 13. Forms — Signal Forms

**Signal Forms (`@angular/forms/signals`) is the standard for all new forms** (ADR `docs/adr/0009-signal-forms.md`). No Reactive Forms (`FormGroup`/`FormControl`/`FormBuilder`), no template-driven (`[(ngModel)]`). It's signal-native and zoneless-friendly; the generic "prefer Reactive forms" guidance predates Signal Forms stabilizing and does not apply here.

Worked example end-to-end: `apps/web/src/app/requests/request-form.ts` + `request-form.html` (AECI-128).

**Shape.** A `signal()` model → `form(model, schema)` → bind controls with `[formField]` → submit with `submit()`:

```ts
private readonly model = signal({ email: '', body: '' });
protected readonly form = form(this.model, (p) => {
  /* validators go here */
});
// template: <input [formField]="form.email" />  …  <textarea [formField]="form.body">
```

Field state is signals: `form.email().value()`, `.valid()`, `.touched()`, `.dirty()`, `.pending()`, `.errors()`, `.getError(kind)`. The form root aggregates: `form().invalid()`, `form().pending()`, `form().submitting()`.

**Validation is the shared Zod schema.** Reuse the `@aeci/shared` Zod schema that the API validates with, so client and server rules can't drift — Zod is the single source of validation truth.

- **Default — `validateStandardSchema(p, MySchema)`** applies a whole schema in one call. This is what `request-form.ts` uses.
- **v22.0.0 constraint:** `validateStandardSchema` **cannot be combined with `validateHttp()` on the same form** — both create async-validation resources and Angular throws **NG0992** ("cannot create a resource inside the params of another resource"). _Only_ when a form also needs a server check, drop `validateStandardSchema` and reuse the schema **field-by-field** with sync `validate()` instead:

```ts
validate(p.email, ({ value }) => {
  const r = MySchema.shape.email.safeParse(value());
  return r.success ? null : { kind: 'standardSchema', message: r.error.issues[0]?.message };
});
```

  Equivalent for flat schemas; revisit `validateStandardSchema` if a later `@angular/forms` removes the collision. See ADR 0009.
- Built-in validators are available too: `required`, `email`, `min`/`max`, `minLength`/`maxLength`, `pattern`, `minDate`/`maxDate`, plus `validate`/`validateTree` for custom and cross-field rules.

**Async / server-side checks → `validateHttp()`.** For uniqueness/availability against the API, attach `validateHttp(p.field, { request, onSuccess, onError })`; it runs only after sync validation passes, exposes `.pending()`, and cancels stale requests. Mind the NG0992 constraint above — a form using `validateHttp` validates its other fields with field-by-field `validate()`, not `validateStandardSchema`. Surface a failed or un-resolvable check as a **non-blocking** notice, never a `ValidationError` — an error marks the field invalid and disables submit. (The AECI-128 form defers its duplicate check to the Phase 6 moderation pipeline, so it ships without a `validateHttp` example.)

**Commit timing → `debounce()`.** `debounce(p.field, 'blur')` defers the model commit until the field blurs (touch/submit flushes it). Use a duration (`debounce(p.field, 300)`) to hold per-keystroke updates; use `validateHttp({ debounce })` to throttle only the async call.

**Dates.** `minDate`/`maxDate` require a **`Date`-typed** field. A native `<input type="date">` binds a `YYYY-MM-DD` **string**, so it won't satisfy `minDate`/`maxDate` directly — type the model field as `Date` (or convert) when using them:

```ts
// model: { incidentDate: Date }
minDate(p.incidentDate, new Date('2000-01-01'));
maxDate(p.incidentDate, today);   // pass `today` in; don't call new Date() at render (§16)
```

**i18n — Zod = logic, `$localize` = copy.** The shared Zod schemas are framework-agnostic and can't hold `$localize` strings, so **never render `error.message`** from a schema error. Show localized copy in the template, keyed off field validity / error kind:

```html
@if (form.email().touched() && form.email().getError('standardSchema')) {
  <p role="alert" i18n="@@requests.email.invalid">Enter a valid email address.</p>
}
```

**Accessibility.** Associate `<label for>` with the control `id`; set `[attr.aria-invalid]` when touched+invalid; point `aria-describedby` at the error element; give error text `role="alert"`. Error text uses `text-(--text-primary)` (AA-contrast), not color alone. Reference: `request-form.html`.

**SSR.** Forms render visitor-neutral and empty on the server; any `validateHttp` check skips its request for blank/invalid values so no HTTP fires during SSR. Submission (`HttpClient.post`) runs only on user action, post-hydration.

**Early input and consent boxes (AECI-1720).** Import `AecEarlyInput` (`shared/form-field/early-input.ts`) beside `FormField` in every component that binds `[formField]`; `early-input-coverage.spec.ts` fails a component that does not. On hydration Signal Forms writes the model's starting value over each native control, and its `input` listener is added in code, so event replay never delivers the early events: answers typed before the scripts loaded were wiped. The directive restores the value the inline recorder in `src/index.html` kept, once, after the field's first render, by firing `input` then `change`. The recorder keeps events the browser dispatched, whether the visitor, an extension or a script's `click()` caused them, so it carries nothing the same action after hydration would not. It stops once the app is stable. No checkbox is ever carried. Put `aecConsent` (`AecConsentBox`, `shared/form-field/consent-box.ts`) on every consent or acceptance checkbox: it is `disabled` until the app is live, so it cannot be ticked before it can work. Bind `[aecConsent]="ready()"` when the box must also wait for the page, as `/auth/terms` waits for its summary of changes. A checkbox without it must be on the non-consent list in `early-input-coverage.spec.ts`. A box whose meaning can change on screen after hydration (a version line, a summary) unticks when it changes. Do not seed a model from the DOM yourself, and do not add a timer or a second read.

Lint: 🟡 review-only.

---

## 14. Images: `NgOptimizedImage`

- Use `<img ngSrc="..." width="..." height="...">` from `NgOptimizedImage` for every static raster image. Mark above-the-fold images with `priority`.
- Inline base64 images are exempt — `NgOptimizedImage` doesn't support `data:` URLs. Add an `eslint-disable-next-line @angular-eslint/template/prefer-ngsrc` with a comment explaining the carve-out.

Lint: ✅ `@angular-eslint/template/prefer-ngsrc`.

---

## 14a. Icons: `aec-icon`

AECI-1753, ruling 34 (ADR 0059). A custom icon set at 1.75 stroke replaces "Lucide icons exclusively". New icons go through `aec-icon` (`apps/web/src/app/shared/icon/`). Do not paste an inline `<svg>` for a UI glyph. Existing inline SVGs migrate page by page under AECI-1720. Charts, brand marks and filled social glyphs are not icons and stay as they are.

Every use states its intent. The selector is `aec-icon[label], aec-icon[decorative]`, so an `<aec-icon>` with neither fails to compile with NG8001.

- **Decorative:** `<aec-icon name="search" decorative />`. The SVG is `aria-hidden="true"` with no name. Use it whenever visible text beside the icon says the same thing, and inside a control that has its own name.
- **Meaningful:** `<aec-icon name="alert-circle" label="Needs review" />` or `[label]="alertLabel"`. The SVG becomes `role="img"` with that accessible name. Pass the label already localised (`$localize` or an `i18n-label` attribute on the caller). A bound label that resolves blank falls back to decorative and logs a `console.warn` in dev mode only.
- **Size:** `[size]="3.5 | 4 | 5 | 6"` is 14, 16, 20 or 24px. The default is 5. Never size an icon with arbitrary pixel classes.
- **Colour:** the icon is `currentColor` only. Set a text colour on the parent. Inherited properties such as `color` reach the SVG through the host. A class on `<aec-icon>` does not size, space or flip it, because the host is `display: contents`. Use `size` and `mirrorRtl`, and put spacing on a wrapper.
- **Direction:** set `[mirrorRtl]="true"` for an icon that points along the line, such as an arrow or chevron.
- **Name:** `name` is typed `AecIconName`, derived from the registry keys. An unknown name fails to compile.
- **Vocabulary icons:** a drawing is named for what it shows. The data-object and facet icons live in `DATA_OBJECT_ICONS` and `FACET_ICONS` in `icon-maps.ts`, typed over the full vocabulary. `null` means no drawing exists yet.

**Adding an icon:** add one kebab-case key to `AEC_ICONS` in `icon-registry.ts`, in alphabetical order, named for what it draws and not where it is used. Write it as shapes (`p` path, `c` circle, `r` rounded rect), stroke-only, in the 24 x 24 box. Do not add colours or fills. If the path data is copied from Lucide, mark the entry `// Lucide` and keep the licence notice at the top of the file and in `apps/web/public/third-party-notices.txt`. esbuild strips source comments, so the public file is the notice that ships (`/third-party-notices.txt`). Add no other icon dependency. `icon.component.spec.ts` checks key format, that no shape carries colour, and that no two icons draw the same.

**Adding a vocabulary slug:** add it to `DATA_OBJECT_SLUGS` and `DATA_OBJECT_ICONS` in `icon-maps.ts`. `icon-maps.spec.ts` compares the slugs with `docs/data-object-vocabulary.json`.

Lint: the label rule is compile-enforced (NG8001). "No inline `<svg>` for a UI glyph" is 🟡 review-only.

---

## 15. Lifecycle hooks

- Implement the matching interface (`OnInit`, `OnDestroy`, etc.) on the class — don't just define the method. Lint: ✅ `@angular-eslint/use-lifecycle-interface`.
- Don't leave empty lifecycle methods. If you don't need it, delete it. Lint: ✅ `@angular-eslint/no-empty-lifecycle-method`.
- Lifecycle methods are not async — use `effect()` or `afterNextRender()` for asynchronous concerns. Lint: ✅ `@angular-eslint/no-async-lifecycle-method`.

---

## 16. SSR safety

The site runs on Cloudflare Workers with `@angular/ssr`. Server-side rendering executes in a non-browser environment without `window`, `document`, `localStorage`, `navigator`, or browser-only globals.

- Never reach for browser globals at module, constructor, or render-pass scope.
- Inject `DOCUMENT` (from `@angular/common`) instead of touching `document` directly. Reference: `apps/web/src/app/theme.service.ts:30`.
- Gate browser-only work with `isPlatformBrowser(inject(PLATFORM_ID))` and `afterNextRender(() => { … })`. Reference: `apps/web/src/app/theme.service.ts:49-58`, `apps/web/src/app/analytics/posthog.provider.ts`.
- Browser-only third-party SDKs (`posthog-js`, anything touching `window` at module load) must be `import()`-ed dynamically inside an `afterNextRender` / `provideAppInitializer` browser-only branch — see `apps/web/src/app/analytics/` (`posthog.provider.ts` + `posthog-client.ts`) for the full pattern. *(`datadog.provider.ts` demonstrated the same pattern until AECI-651 deleted it.)*
- `new Date()` is platform-dependent — server clock ≠ client clock. Don't call it during render. Freeze on the server, pass to the client.
- Cached SSR routes must render visitor-state-neutral HTML (no cookie content baked in). See `CLAUDE.md` "Constraints" and `docs/STAGE_1_SPEC.md` §9.1a.

Lint: 🟡 review-only.

---

## 17. Services

- One responsibility per service. If a service handles three things, split it.
- `@Injectable({ providedIn: 'root' })` for singletons. Lint: ✅ `@angular-eslint/use-injectable-provided-in`.
- DI via `inject()` (see §9).
- Reference: `apps/web/src/app/theme.service.ts:28`.

---

## 18. Routing

- Every feature route is lazy-loaded with `loadComponent: () => import(...)` or `loadChildren: () => import(...).then(m => m.routes)`.
- No eager-importing feature components in `app.routes.ts`.
- Server routes (`apps/web/src/app/app.routes.server.ts`) follow the same lazy pattern; the SSR Worker doesn't pay for eager bundles.

Lint: 🟡 review-only.

### Focus after a navigation (AECI-1855)

**The policy.** After a client-side navigation to another path, focus moves to the new page's first visible `h1` inside `<main id="main">`. A page with no `h1` yet gives focus to `<main>` itself, the skip link's target. The heading names the page, so a screen reader announces where the reader landed, and the next Tab starts in the content. This is what a full page load gives a keyboard user, and what WCAG 2.4.3 (focus order) expects of a link that replaces the page. One mechanism does it for every link: `RouteFocus` (`core/route-focus.ts`), started from `App`. A card, a breadcrumb, a header link, the Browse menu and the mobile menu all land the same way (the Same-Behavior Rule).

- **It never scrolls.** The call is `focus({ preventScroll: true })`, after the new view has rendered, in the `read` phase of `afterNextRender`, so a page that focuses its own element in the default phase of the same render has done so first. The router's scroll reset and Back's scroll restore stay the only scroll writes (§3 above). Do not add a scroll to it.
- **When it leaves focus alone.** A navigation that changes only the query or the fragment: a listing filter, sort or page keeps focus on the control, and a section link's target is focused by `ScrollMarginViewportScroller`. A page that put focus somewhere itself during the render, inside `<main>` or a dialog: a form that focuses its success heading, a page that focuses its search box. The initial hydration navigation.
- **Persistent section rows keep focus (Chris's ruling, option A).** A row of section links that stays on screen, under a heading that does not change, across the navigations its links make carries `data-route-focus-keep`. When focus is on a link inside it, still connected and visible, after the navigation renders, focus stays there, so the reader keeps their place in the row. Marked today: the admin section row (`admin/admin-shell.ts`) and the vendor portal row (`vendor/vendor-portal-nav.ts`). A link in an admin dropdown (Operations, Catalog) closes its panel when pressed, as the Browse menu's links do (`admin/admin-nav-dropdown.ts`). Its focus is then on a link in a `[hidden]` panel, which counts as lost, so it goes to the page `h1`. A sole link in the row keeps focus. "Lost" is one shared test, `focusIsLost()` in `core/route-focus.ts`: focus on `<body>`, on nothing, on a detached element, or on a hidden one (`checkVisibility({ visibilityProperty: true })`, with a `[hidden]`-ancestor fallback). Not marked: the docs sidebar, whose page heading changes with each article, and rows whose links change only the query or the fragment (the admin vendor tabs, the `/account` section nav, the `/search` tabs), which keep focus anyway. Never on the site header or the Browse menu. A new persistent row adds the attribute to its `<nav>`.
- **A link to the page already showing.** The router ends it in `NavigationSkipped`. Focus moves only if it was lost, as when the Browse menu or the mobile menu closes around the link. A press on a control that stays on screen keeps its focus.
- **No ring on the heading.** The heading takes `tabindex="-1"` and `data-route-focus` only while it holds focus. `styles.css` draws no outline on `[data-route-focus]:focus`, as `<main>` draws none. Both attributes go when focus next lands on another element. They stay through a window or tab blur, so the browser can give focus back to the heading on return. Nothing is in the server HTML, so the cached page is unchanged.
- **The menus.** A menu that closes because of a navigation does nothing about focus: the router events reach `RouteFocus`. Escape with no navigation still returns focus to the trigger (`NavDisclosure`, the mobile menu toggle), and so does the mobile menu's dimmer. The one close with no navigation and no visible trigger is the mobile menu closing because the window grew to `lg`. It calls `RouteFocus.focusPage()` when the menu was open and focus was in it or already dropped to `<body>`: the host can go `display: none` before the media query event arrives.
- **A page that moves focus itself** after a state change (the review form's "Review received" heading, the claim and mute token pages) keeps doing so. Give that element `tabindex="-1"` and `outline-none` as those pages do.
- **Tests.** `core/route-focus.component.spec.ts` covers each rule. `e2e/nav-menu.spec.ts` "focus after a navigation" checks the Browse menu by mouse and keyboard, the mobile menu at 390px, a card and a breadcrumb, and Escape. `e2e/scroll-restoration.spec.ts` guards that Back still restores position.

---

## 19. Headless behavior: Spartan brain primitives + Angular Aria

- Use Spartan brain (`@spartan-ng/brain/<primitive>`) for behavior; layer Tailwind utility classes for style.
- Import primitives directly: `import { BrnButton } from '@spartan-ng/brain/button';`. No barrel imports from `@spartan-ng/brain` root.
- **No project-level wrapper components** around brain primitives. Compose with Tailwind in the consuming template. Reference: `apps/web/src/app/preview/vendor-detail/vendor-detail.ts:2-4`, `apps/web/src/app/demo/spartan-demo.ts`.
- No `@spartan-ng/helm` codegen (per `docs/STAGE_1_SPEC.md` §16 Phase 1).
- Angular CDK is fine where Spartan doesn't cover (overlays, drag-drop, virtual scroll).
- **A confirmation dialog opens on its title** (AECI-1861, DESIGN.md "The Title-First Dialog Rule"). Bind `[role]="'alertdialog'"` and `[autoFocus]="'first-heading'"` on the `<brn-dialog>`, as bound inputs so no stray attribute lands on the role-less wrapper. Give the `brnDialogTitle` `h2` `tabindex="-1"` and the focus ring, and put the sentence that says what the choice does on `brnDialogDescription`. Pin it with `expectTitleFirstDialog` (`core/testing/title-first-dialog.harness.ts`).
- **New interactive/form-control patterns → Angular Aria.** This is the **rule** (ADR 0010, **Accepted**), not a proposal. For _new_ selects, comboboxes, listboxes, radio groups, accordions, trees, grids, menus, toolbars, and tabs, build on Angular Aria (`@angular/aria`, stable in v22) — it's first-party and Signal-Forms-friendly (§13). Spartan stays for the overlay primitives Aria lacks (Popover, Dialog); CDK remains the shared overlay/positioning foundation under both. Reference implementations: the review-submission form (`apps/web/src/app/reviews/review-form.ts`), the header search combobox (`apps/web/src/app/search/search-autocomplete.ts`), and the listing sort dropdown on `/search`, `/products` and the taxonomy pages (`apps/web/src/app/shared/listing-toolbar/listing-sort-select.ts`).
  - **`select`/`radio` are realised via combobox/listbox** — Aria@22 GA ships neither directive, so a non-editable `ngCombobox` + `ngListbox` popup stands in for a select, and a horizontal `ngListbox`/`ngOption` stands in for a radio group (e.g. the review-form star ratings).
  - **Exception: a plain single-value form field may be a native `<select>`** (ADR 0010 deviation (d), 2026-09-17). It applies only to one value from a closed, plain-text list, with no type-to-filter, in an ordinary form. Give it a `<label for>` and map the `""` row to `null`. Reference: the vendor data-flow forms on the integration detail page (`vendor/integration-detail/integration-shared-data.ts`, `vendor/integration-detail/integration-answer-form.ts`; the original reference, `vendor/components/vendor-add-claim-form.ts` and `vendor-attestation-control.ts`, was retired by AECI-1156). Styled, filterable or overlay dropdowns stay on `AecSelect`.
  - **An editable combobox starts with no option active** (AECI-1860, ADR 0010 finding 5). Wire `listboxEntry` from `shared/listbox-entry/listbox-entry.ts`: Down enters at the first row, Up at the last, and Enter before the first arrow key never commits an option.
  - **Signal Forms wiring depends on the control kind.** Native `<input>`/`<textarea>` bind `[formField]` directly (like `requests/request-form.ts`). **Discrete-choice Aria controls (listbox/combobox) do _not_ — bridge them** with a local `signal` two-way bound via `[(value)]` (Aria's `value` is a `ModelSignal<V[]>`; drives `aria-selected` + roving state) plus a `(valueChange)` handler that writes `values[0]` into the field with `.value.set()` + `.markAsTouched()`. `[formField]` fails here because undefined-seeded fields aren't materialised and a seeded `0`-sentinel can't be told apart from a real first pick. See `reviews/review-form.ts` (`onOverallChange`/`onOnboardingChange`).
  - **Style Aria like brain primitives:** Tailwind `aria-*:` variant utilities (`aria-selected:`, `aria-expanded:`, `aria-checked:`) and the `data-[active=true]:` variant Aria sets on the active option, bound to the OKLCH tokens — no TS state mirror. Stage 1 is **light-only** (AECI-226); do not add `dark:` variants.
  - **Overlay glue:** `ComboboxPopup` content renders **in-flow**, not in a CDK overlay. For a floating popup, nest `ngComboboxPopup` inside `cdkConnectedOverlay` (`usePopover: 'inline'`) driven by the `[(expanded)]` signal (AECI-232).
  - **"Menus" in the Aria rule means APPLICATION menus, not navigation.** The decision table's `Menu / Menubar` row covers commands that act on the page. A row of **router links** is a disclosure-navigation pattern: `role="menu"` is the wrong semantic for it, and the WAI-ARIA practices advise against it. Those extend `layout/nav-disclosure.ts` instead, which is what keeps the public Browse menu (`layout/browse-menu.ts`, AECI-1774) and the admin console's category row (`admin/admin-nav-dropdown.ts`, AECI-694) on one open/close contract — the contract `DESIGN.md` §Navigation requires. Two shipped precedents predate the admin row and reach the same conclusion from the other direction: `layout/user-menu.ts` ("no `role=\"menu\"`/roving tabindex") and the vendor portal's former Products menu, which was a combobox because `role="menu"` may not own a textbox (retired in `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.11).
  - **The accordion is off-limits for SSR-indexable content (AECI-841).** `AccordionPanel` renders its content through `DeferredContent`, which creates the embedded view inside an `afterRenderEffect` — and `afterRenderEffect` runs **only on the client** ([angular.dev](https://angular.dev/guide/signals/effect#server-side-rendering-caveats)). So on a server-rendered page the panel serialises **empty**: no content for a crawler, and a visible pop-in after hydration. `preserveContent: true` does not rescue it, because it only stops an already-created view being destroyed. If the content inside a collapsible region is indexable, or feeds an `@defer (hydrate on viewport)` block, hand-roll the WAI-ARIA disclosure pattern instead — a `<button aria-expanded aria-controls>` inside the heading over a `role="region"` panel hidden with the `hidden` attribute, content in the DOM in every state. Reference: `apps/web/src/app/products/integration-group-card.ts`. Popups and menus are unaffected: their content is not indexable, so Aria's deferred rendering is correct there.
  - Full rationale + the three deviations: `docs/adr/0010-angular-aria-alongside-spartan.md`.

Lint: 🟡 review-only.

---

## 20. Tokens, not literals

No hardcoded colors in templates or component styles. Use the semantic tokens defined in `apps/web/src/styles.css` (Tailwind v4 `@theme inline` block):

- Tailwind paren-shortcut utilities: `bg-(--surface-base)`, `text-(--text-primary)`, `border-(--border-default)`, `hover:bg-(--accent-primary-hover)`.
- Inline styles: `[style.background]="'var(--accent-primary)'"`.

**Banned:** `bg-green-900`, `#1E3A2F`, `oklch(...)`, `rgb(...)`, `text-white` / `bg-black`, named Tailwind color classes, hex literals in `style="..."`.

**Three deliberate allowances**, so you know where the edges are:

- `rgb(0 0 0 / α)` — pure black only, for the `DESIGN.md` §Shadows recipe and the CDK backdrop. Any other channel value is banned. The underscore form Tailwind arbitrary values use (`rgb(0_0_0/0.18)`) is equally allowed.
- `bg-transparent` / `border-transparent` — keywords with no token equivalent. `white` and `black` are NOT in this category: `--surface-base` is pure white, and `text-(--surface-base)` is what the app uses in 64 places.
- Two files may spell a color literal: `apps/web/src/styles.css`, because it is the token definition site, and `apps/web/src/app/auth/login.html`, because the Google "G" mark's four fills are fixed by the Sign-in-with-Google branding guidelines.

For the canonical token list see `DESIGN.md`. For the v0 → token translation table see `docs/design/v0-porting-rules.md` §1. Don't restate either here.

Lint: ✅ (AECI-597). Enforced two ways, split by file type the same way the light-only rule is: `no-restricted-syntax` covers `.ts` including inline templates, and `apps/web/scripts/check-source-constraints.mjs` covers external `.html` and `.css`. Both read their patterns from `eslint.color-patterns.mjs`, which is the single definition — and which explains why `#RGBA` is excluded and why the pure-black carve-out is mandatory rather than convenient. **apps/web only**: `apps/api`'s transactional email HTML is correctly hex (email clients don't support custom properties) and `apps/datatool` is an internal ops Worker with no design system.

---

## 20a. Sorting text: `compareText`, never `localeCompare`

Any list a reader sees in alphabetical order goes through `compareText` from
`@aeci/shared/text-sort`:

```typescript
import { compareText } from '@aeci/shared/text-sort';

readonly sorted = computed(() => [...this.products()].sort((a, b) => compareText(a.name, b.name)));
```

**Banned for display text:** a bare `.sort()`, `a < b ? -1 : 1`, and `a.localeCompare(b)` with no
locale argument. The first two sort by UTF-16 code unit, so case decides the order and
`ADP Workforce Now` outranks `Access Coins Evo` (AECI-825). The third gets the collation right but
resolves against the **ambient** locale — the visitor's OS setting in the browser, workerd's default
under SSR — so a list SSR renders sorted and the client re-sorts after hydration can order
differently on the two runtimes. `compareText` pins `'en'`.

Still fine on `BINARY`/code-unit comparison, because they are not display text: slugs (lowercase by
construction), ids, enum tokens, and ISO-8601 timestamps.

The SQL twin of this rule is `COLLATE NOCASE` in `apps/api/src/lib/collation.ts`; the two produce the
same order, which `apps/api/src/lib/collation.spec.ts` asserts against real SQLite. Both call two names
that differ only in case a tie (`compareText` returns 0), so the caller breaks it on `id`:
`compareText(a.name, b.name) || compareId(a, b)` (AECI-1840). A sort with no id term
keeps a case-only pair in input order.

Lint: 🟡 review-only.

### Operating notes (moved from CLAUDE.md, 2026-09-23)

- Every regression of this rule is silent. The sort still returns 200 and still looks sorted.
- The full three-layer rule (D1, in memory, Algolia), the AECI-99 tiebreaker and the `eSUB` / `iSqFt` / `openBIM` example live in `docs/API_CONTRACTS.md` §3.2 "Collation".

---

## 20b. First paint and critical CSS

**How it works.** Angular SSR runs Beasties on every server render. Beasties inlines a per-page subset of `styles.css` into a `<style>` in the head: every rule whose selector matches an element in the server HTML, plus `:root`, `html`, `body`, every `@property` and every `@layer` statement. About 30 to 37 kB raw and 6.5 to 8 kB gzipped per page (the home page: 37.1 kB, 8.0 kB gzipped, 2026-11-22). The full `styles-*.css` (about 105 kB raw, 18 kB gzipped) loads without blocking render: a `media="print"` link that an inline script switches to `all`. Until it arrives, the page paints with the subset alone. On a cold load over a throttled mobile connection (150ms latency, 1.6 Mbps) we measured about 500ms.

**Three Beasties defects broke the subset (AECI-1854).** All three are fixed in `pnpm-workspace.yaml`.

- Beasties 0.5.4 wrote a `;` after each `@property` rule. The browser drops the rule after a stray `;`. That lost 78 of 80 `@property` rules and the whole `:root` token block, so every `var(--token)` was empty at first paint. The override pins 0.5.5, which fixes it.
- Beasties drops a rule whose selector is wholly `:where(…)`. Tailwind v4 writes `space-*` and `divide-*` that way. `patches/beasties@0.5.5.patch` matches the selector's argument instead.
- Beasties also dropped a rule whose selector is only pseudo-elements or pseudo-classes, such as `::placeholder` or `:focus-visible`, because stripping them left nothing to match. So the unlayered `::placeholder { color: var(--text-tertiary) }` never reached the subset: every placeholder painted in its `placeholder:` utility's colour (secondary ink) and turned tertiary when the full stylesheet landed. 0.2% of the home page's first screen at 1440px and 0.6% at 390px changed colour (AECI-1854 audit, 2026-11-22). The same patch matches such a selector as `*`, so it is always kept.

**The rule.** First paint must equal the final paint for everything in the server HTML.

- Put design values in tokens on `:root` in `styles.css`. Tokens always reach the subset.
- A class only reaches the subset if an element in the server HTML carries it. Content that renders only in the browser (a `@defer` block, an `isPlatformBrowser` branch, data fetched after hydration) gets its rules only from the full stylesheet. Give that content a server-rendered placeholder of the same size, or accept that it can paint unstyled for a moment.
- Never add a selector Beasties cannot match to style a first-paint state. It strips pseudo-classes before matching, so `:hover` and `:focus-visible` rules are kept when the element exists. A selector that is only pseudo-classes or pseudo-elements, with no class, tag or attribute, is always kept since the AECI-1854 patch.
- Do not fix a first-paint flash with a literal value in one component (AECI-1852 did). Find why the subset differs and fix that once.

**The guard.** `apps/web/e2e/first-paint.spec.ts` runs in the CI e2e lane. It parses the inlined CSS of `/` with the browser's parser and asserts every `@property` rule, the `:root` tokens, the `space-y` rules and the `::placeholder` rule survive. It then renders six public pages at 1440px and 390px with scripts off, once with `styles-*.css` blocked and once loaded. The header, the first heading, the first button and the header search field must match in background, colour, corner radius and box. Every element in the server HTML must keep its box, display, visibility, opacity, transform, background and colour, and the first screen must match: no pixel may move more than one level in a channel, and at most 32 may move that much. That is corner antialiasing in CI (run 45007653563: 10 pixels on one button corner, each off by 1), not a first-paint change. Last, `/` and `/products` load cold with scripts on and the stylesheet held back 1.5s, and their layout shift must stay under 0.01. When you bump Angular or Beasties, run it. Drop the override and the patch once Angular pins a Beasties release that carries all three fixes.

**The audit (AECI-1854, 2026-11-22).** On `/`, `/products`, a product page, a pair page, `/docs` and `/vendor-program`, at 1440px and 390px, with the patch above, no element of the server HTML changes box, display, visibility, opacity, transform, background or colour when the full stylesheet lands, and no pixel of the first screen changes. Before the `::placeholder` fix, the only change was the placeholder colour of the home hero search and both pair pickers. The two shifts PR #1328 left open no longer happen. The home "Most viewed" row was a data shift, not a stylesheet one: it filled in after hydration. AECI-1792 put it in the server HTML with a height floor. The `/products` grid has been kept by hydration since #1344 (AECI-1863): all 24 server-rendered card links stay connected. Measured cold with the stylesheet held 1.5s: layout shift 0.000 on both pages at both widths. One element is client-only and so outside the subset: the consent banner. It renders after hydration, so its rules arrive with the full stylesheet. If the stylesheet were still missing after hydration, the banner would paint in the page flow below the footer, then jump to its fixed place. In practice the stylesheet lands first: 0.8s against the banner's 2.9s on a throttled phone profile.

Lint: 🟡 review-only. The e2e is the enforcement.

---

## 21. Accessibility (WCAG AA + axe-clean)

- Spartan brain primitives give you a11y for free — don't break their built-in semantics.
- Run axe-core against any new surface before pushing.
- The template a11y lint config (`angular.configs.templateAccessibility`) is on in `apps/web`. Lint: ✅ `alt-text`, `click-events-have-key-events`, `interactive-supports-focus`, `label-has-associated-control`, `mouse-events-have-key-events`, `role-has-required-aria`, `table-scope`, `valid-aria`.
- Detailed checklist: `docs/CODE_REVIEW_CHECKLIST.md` "Accessibility" section.

---

## 22. Cross-cutting constraints (don't restate — link)

- **i18n from day one.** Every visible string wrapped in `i18n="@@unique.id"` (templates) or `$localize` (TS). See `CLAUDE.md` constraints and `docs/STAGE_1_SPEC.md` §7a.
- **Light only (Stage 1).** One light theme: no `dark:` variants, no `.theme-dark` block, no toggle, no system-preference detection (AECI-226; supersedes the former "Both themes always" rule). Dark theme is not roadmapped — the Stage 2 reintroduction was dropped (`docs/STAGE_2_SPEC.md` §9); light-only is the standing direction. See `CLAUDE.md` constraints and `docs/CODE_REVIEW_CHECKLIST.md` "Theming". Lint: ✅ (AECI-549).
- **Data layer is Drizzle over D1.** The Worker reaches the app DB through its `DB` binding via `getDb(env)` — no Prisma, no Accelerate, no pg adapter. See `CLAUDE.md` constraints and ADR 0016. Lint: ✅ (AECI-549).
- **Cached SSR is visitor-state-neutral.** See `CLAUDE.md` constraints and `docs/STAGE_1_SPEC.md` §9.1a.
- **No pay-for-placement.** Ranking is algorithmic. See `PRODUCT.md`.

### Operating notes (moved from CLAUDE.md, 2026-09-23)

- **Why i18n from day one.** We launch English-only, but retrofitting i18n later is painful.
- **Light only keeps its scaffolding.** The semantic tokens (`--surface-*` / `--text-*` / `--accent-*`) and the dormant `.theme-dark` scaffolding stay in place so a later stage could revisit dark theme. Nothing is planned.

---

## 23. Out of scope

- Visual tokens, colors, typography, spacing scales — see `DESIGN.md`.
- Voice, tone, anti-references, strategic positioning — see `PRODUCT.md`.
- v0 → Angular porting mechanics — see `docs/design/v0-porting-rules.md`.
- Drizzle/D1, Worker, cache invalidation rules — see `CLAUDE.md` constraints and `docs/DATABASE_SCHEMA.md`.
- Testing patterns — see `docs/TESTING_STRATEGY.md` and `docs/UNIT_TESTING_GUIDE.md`.

---

## 24. Appendix: ESLint enforcement matrix

Rules enforced by `pnpm lint`. Five layers, and knowing which is which matters when you add a rule:

1. **`angularBase`** (`eslint.config.base.mjs`, consumed by `apps/web/eslint.config.mjs`) — the Angular and brand-voice rules. `apps/web` only.
2. **`tsBase`** (same file, consumed by all four packages) — the cross-cutting constraint guards from AECI-549. These reach `apps/api`, `apps/datatool`, and `packages/shared` as well.
3. **Package-local file-scoped blocks** (e.g. `packages/shared/eslint.config.mjs`) — a rule that applies to one file, not a tier. See "Package-local guards" below.
4. **`apps/web/scripts/check-source-constraints.mjs`** — a line scanner for what ESLint structurally cannot read: Tailwind class strings inside external `.html` templates (the template processor parses them into a template AST, not lintable string literals) and selectors in `.css` (nothing lints CSS here — there is no stylelint). Wired into `apps/web`'s `lint` script.
5. **Root gates in `scripts/`**, run by the root `pnpm lint` before the package lints: `check-claude-md-size.mjs` (`CLAUDE.md` at most 30,000 bytes), `check-conflict-markers.mjs` (no tracked file holds git conflict markers, AECI-1720) and `pnpm docs:notifications:check` (`docs/NOTIFICATIONS.md` matches the registry). See "Root gates" below.

A constraint that spans layers 1 and 4 keeps its patterns in a **shared leaf module** rather than spelling them twice. `eslint.color-patterns.mjs` (repo root, zero dependencies) is the worked example: the `dark:` rule predates the convention and *is* spelled twice, which is exactly the drift the connector-lane vocabulary hit before AECI-735 had to add lockstep tests. Root and dependency-free are both load-bearing — the scanner walks `apps/web/src` and each package lints from its own basePath, so a root file is outside every scanned tree and cannot flag its own source; and the scanner runs as a bare `node` process, so importing `eslint.config.base.mjs` would drag in typescript-eslint for four regexes.

**Two traps when editing the config.** First, flat config *replaces* a rule's options per file rather than merging them, and `apps/web` spreads `angularBase` after `tsBase` — so both `angularBase` TypeScript blocks must restate every `no-restricted-syntax` selector or they silently drop the ones `tsBase` set. Second, the `tsBase` rules object has no `files` key, so it also applies to the `.html` files `apps/web` lints; ESTree selectors belong in a `files`-scoped block. `apps/web/src/eslint-config.spec.ts` asserts the resolved config for both packages in both tiers, so either regression fails a test rather than quietly disabling a constraint.

**A third trap, if your pattern is non-trivial.** Selectors are built by interpolating a pattern into an esquery string (`Literal[value=/${PATTERN}/]`), so a `/` in the pattern must be escaped or it terminates the regex early, and a literal backtick cannot appear inside the `String.raw` template that builds the source (write `\x60`). Both failures are silent — you get a rule that never matches, not an error. The AECI-597 patterns carry a lookahead, a lookbehind and an escaped `/`; `eslint-config.spec.ts` runs them through the *real* resolved config for that reason.

**A fourth, if your rule is about Tailwind classes: your test fixtures ship.** Tailwind v4 auto-detects sources, `.spec.ts` included, and cannot tell a class named in a fixture string from a class a component uses. A spec asserting that a banned utility is caught therefore *generates* that utility into the production stylesheet — the AECI-597 specs put seven of them there, 1,591 bytes, each with zero non-spec references. `apps/web/src/styles.css` now carries `@source not` for `'./**/*.spec.ts'`, its `.harness.ts` twin, `'../e2e'` and `'../scripts'` — the globs resolve relative to the stylesheet, so `src/`-anchored entries do not reach the sibling trees, and both of those leak too. `scripts/check-source-constraints.mjs` spells `text-left` / `text-right` as part of the RTL rule's own pattern, which is how `.text-right` came to ship in the bundle: a utility that same rule bans. Component specs lose nothing: the classes they render are declared in the component `.ts`, which is still scanned. Check the built CSS when you add a class-shaped fixture — and note that a *pattern* naming a class counts, not just a fixture.

### TypeScript files (`**/*.ts`)

| Rule | Severity | Section |
|---|---|---|
| `@typescript-eslint/no-explicit-any` | error | §2 |
| `@typescript-eslint/no-inferrable-types` | warn | §2 |
| `@typescript-eslint/no-unused-vars` | error | §2 |
| `@angular-eslint/prefer-standalone` | error | §4 |
| `@angular-eslint/component-class-suffix` | **off** (override) | §6 |
| `@angular-eslint/directive-class-suffix` | **off** (override) | §6 |
| `@angular-eslint/prefer-inject` | error | §9 |
| `no-restricted-syntax` (constructor-body `inject()`) | error | §9 |
| `@angular-eslint/prefer-host-metadata-property` | error | §10 |
| `@angular-eslint/computed-must-return` | error | §11 |
| `@angular-eslint/prefer-signal-model` | error | §12 |
| `@angular-eslint/prefer-output-emitter-ref` | error | §12 |
| `@angular-eslint/prefer-output-readonly` | error | §12 |
| `@angular-eslint/no-input-rename` | error | §12 |
| `@angular-eslint/no-output-rename` | error | §12 |
| `@angular-eslint/use-lifecycle-interface` | error | §15 |
| `@angular-eslint/no-empty-lifecycle-method` | error | §15 |
| `@angular-eslint/no-async-lifecycle-method` | error | §15 |
| `@angular-eslint/use-injectable-provided-in` | error | §17 |
| `no-restricted-syntax` (em dash in copy) | error | `PRODUCT.md` / `DESIGN.md` |
| `no-restricted-syntax` (color literals — hex, `rgb()`/`hsl()`/`oklch()`, Tailwind palette, `white`/`black`, opacity modifier on a colour utility) | error | §20 |

Scope note: the em-dash guard is shipped-source only (`**/*.spec.ts`, `**/*.harness.ts`, and `e2e/**` are exempt) because `describe()` / `it()` titles and assertion messages are developer-facing, not rendered copy. The AECI-597 color guard shares that exemption for the same reason, and it is load-bearing: `login.component.spec.ts` pins the four Google brand fills as a fixture.

Scope note on colors: they sit in `angularBase` rather than in a `tsBase` tier, which is the entire **apps/web-only** scoping mechanism. That is a decision, not an oversight. `apps/api/src/lib/{email,analytics-digest}.ts` hold 13 hex literals that are *correct* — email clients do not support CSS custom properties — and `apps/datatool/src/ui.ts` holds 28 more in an internal ops Worker with no design system to migrate to. Promoting these to `CONSTRAINT_SYNTAX_SOURCE_ONLY` would need 41 exemptions on day one. `eslint-config.spec.ts` asserts the rules are ABSENT on `apiSource`, so that promotion fails a test rather than landing quietly.

### Cross-cutting constraint guards (`**/*.ts`, all packages — AECI-549)

These live in `tsBase`, so they apply to `apps/api`, `apps/datatool`, and `packages/shared` too. The **dependency** bans apply everywhere including tests; the **value** bans exempt tests, because a fixture legitimately constructs a forbidden value in order to prove the code rejects it (`seo-headers.spec.ts` builds `Vary: Cookie` upstream responses for exactly that reason).

| Rule | Bans | Tests exempt? | Constraint |
|---|---|---|---|
| `no-restricted-imports` | `@prisma/*`, `@prisma/extension-accelerate`, `pg`, `postgres`, `@neondatabase/serverless`, `drizzle-orm/node-postgres`, `drizzle-orm/postgres-js` | no | Drizzle over D1 (ADR 0016) |
| `no-restricted-imports` | `zone.js`, `zone.js/*`, and `NgZone` / `provideZoneChangeDetection` from `@angular/core` | no | Zoneless (§3) |
| `no-restricted-syntax` | `getPrisma` / `prismaFor` / `PrismaClient` identifiers; `DATABASE_URL` / `DIRECT_URL` | no | Drizzle over D1 (ADR 0016) |
| `no-restricted-syntax` | `dark:` Tailwind variants (incl. stacked `md:dark:`); `.theme-dark` | yes | Light only (AECI-226) |
| `no-restricted-syntax` | `Vary` set to anything but `Accept-Language`, via `headers.set` / `append` or an object literal | yes | Edge-cache discipline |
| `no-restricted-syntax` | a `verified` key in `db.update(vendors).set({…})` or `db.insert(vendors).values({…})` | yes | Entitlement mirror sole-writer (`docs/STAGE_2_PAID_TIERS_SPEC.md` §2.1) |

**Scope note on the mirror sole-writer rule (AECI-609).** It is the only guard with a *per-file* exemption, so it lives in its own `CONSTRAINT_SYNTAX_MIRROR` tier and its own `tsBase` block rather than joining the source-only list — folding a file exemption into that list would silently strip `dark:` and `Vary` from the exempted files too. **`MIRROR_WRITE_EXEMPT` holds one entry**: `lib/license.ts` (AECI-1352), whose `reconcileVerifiedMirror` statement ends every subscription batch. *As built (AECI-1358, 2026-10-17): `lib/vendor-entitlement.ts`, the entitlement-era writer, sat beside it during the subscription transition. E1.9 deleted that module, which took the list back to exactly one.* It first shipped with two as well: `lib/vendor-grant.ts` was a **temporary** baseline carve-out because it still emitted the `verified` flip when the rule landed. AECI-612 deleted that statement — `grantSeatStatements` no longer names `vendors` at all, and `approveClaim` composed the entitlement activator into the same `db.batch` instead (until AECI-1367) — so the carve-out was removed in the same commit and the rule now covers that file like any other. **Landing a rule scoped to the clean subset and widening it as the rest is cleaned up is the documented lifecycle below, and this is a worked example of the widening step.** The selector is anchored to the Drizzle *chain* (`.update(vendors).set(…)`), not to the property name, so `columns: { verified: true }` read projections, `db.update(vendors).set(writeColumns)`, and Angular's `signal.set({…})` all stay clean; the `insert`/`values` twin closes the "create a vendor already verified with no entitlement row" hole the `.set` selector alone would miss. Accepted limitation: `db.update(schema.vendors)` would evade it — the `license_mirror_drift` data-quality check (`entitlement_mirror_drift` until its retirement on 2026-10-17, AECI-1375) is the run-time backstop that covers what lint cannot see (raw D1 SQL, `apps/datatool`).

### Package-local guards

Three rules are scoped to named files rather than a tier, because the thing they protect is invisible at runtime.

| Rule | Scope | Bans | Constraint |
|---|---|---|---|
| `no-restricted-imports` | `packages/shared/src/entitlements.ts` only (`packages/shared/eslint.config.mjs`) | `zod`, `zod/*`, and `./api/*` / `@aeci/shared/api*` | The capability registry ships in the lazy `/vendor` Angular route; one value import from an `api/*` module once dragged the whole schema set plus a 327 kB zod chunk into the initial graph (AECI-610 / `STAGE_2_PAID_TIERS_SPEC.md` §3.1, R11) |
| `no-restricted-imports` | `packages/shared/src/version-diff.ts` only (same file) | same set | The version-diff engine ships in the lazy product-pair route **and** imports the capability registry, so it inherits the same obligation one hop further out; `api/product-pairs.ts` imports *from* it, so the dependency must stay one-way (AECI-304 / `STAGE_2_ATTESTATIONS_SPEC.md` §9.4) |
| `no-restricted-imports` | the zod-free `api/*` modules in `ZOD_FREE_API_MODULES` (same file): `agreements.ts`, `https-url-rule.ts`, `legal-moment.ts`, `taxonomy-count.ts`, `trade-publish.ts` | `zod`, `zod/*`, every sibling `./*` except the other listed files, `../*`, `@aeci/shared*` | Public pages read these files. A schema module one import away keeps zod, and the page loads the 78 kB zod chunk while it hydrates (AECI-2033). `apps/web/scripts/check-zod-free-routes.mjs` checks the built routes |

Two things about them generalize to any future file-scoped rule here:

- **It restates `CONSTRAINT_IMPORTS`.** Flat config replaces a rule's options per file, so a block setting only the new ban would silently drop the Prisma and zone.js bans for that file — the same trap described above, in miniature.
- **`api/*` is banned alongside `zod` itself**, because `no-restricted-imports` matches only direct imports. Banning the dependency without banning the one-hop route to it would leave the rule looking enforced while doing nothing.

`apps/web/src/eslint-config.spec.ts` resolves `packages/shared` configs too, and asserts both halves fire, that the restated bans survived, and that the ban is scoped to the file rather than leaking across the package.

**Not built, and deliberately so: the cacheable-SSR import boundary.** `STAGE_2_PAID_TIERS_SPEC.md` §3.3(c) reserves a rule stopping a **cacheable** SSR surface from forking on entitlement state — the Workers Cache is URL-keyed, so a page that varies by *viewer* poisons the cache for everyone (R3). It was sketched as "no cacheable SSR component may import `@aeci/shared/entitlements`", and that sketch is now known to be the **wrong shape**: the product-pair resolver imports the registry transitively (`version-diff.ts` → `entitlements.ts`) and is *correct* to, because it forks on the **pair's vendors' tiers** — a function of the two slugs in the URL — never on the reader's. The rule that is actually wanted is a **viewer-tier** ban, not a module ban; a module ban would either fail on a compliant consumer or need `@aeci/shared/version-diff` explicitly allow-listed. **There is no mechanical guard today**, so R3 stays open and the invariant is review-only until someone expresses it correctly.

### Line-scanner guards (`check-source-constraints.mjs`)

ESLint cannot see these. `.ts` is deliberately excluded from the dark-theme and color rules so they never double-report against the selectors above — and for colors that exclusion does a second job, since this scanner does not strip comments and two files document a token's hex in JSDoc.

| Rule | Scans | Bans | Constraint |
|---|---|---|---|
| `logical-properties` | `.ts`, `.html` | `ml-*`, `mr-*`, `pl-*`, `pr-*`, `text-left`, `text-right` | RTL readiness (AECI-153) |
| `no-dark-variant` | `.html`, `.css` | `dark:` Tailwind variants | Light only (AECI-226) |
| `no-dark-theme-css` | `.css`, `.html` | `.theme-dark`, `@custom-variant dark`, `prefers-color-scheme: dark`, `[data-theme=…]` | Light only (AECI-226) |
| `no-hex-color` | `.html`, `.css` | `#RGB`, `#RRGGBB`, `#RRGGBBAA` | Tokens, not literals (AECI-597, §20) |
| `no-color-function` | `.html`, `.css` | `rgb()`, `hsl()`, `oklch()`, `oklab()` — except pure black | Tokens, not literals (AECI-597, §20) |
| `no-tailwind-palette` | `.html`, `.css` | `bg-zinc-100` and every other palette-with-shade class | Tokens, not literals (AECI-597, §20) |
| `no-named-color-class` | `.html`, `.css` | `text-white`, `bg-black`, … — not `-transparent` | Tokens, not literals (AECI-597, §20) |
| `no-color-opacity-modifier` | `.html`, `.css` | `text-(--surface-base)/70`, `bg-forest/40`: a `/NN` on a colour utility. Not `text-sm/6` or `w-1/2`. Allow-list `COLOR_OPACITY_MODIFIER_ALLOW` is empty and cleared by AECI-1813 | Every alpha is a measured named token (AECI-1747, redesign clash 6) |
| `no-smooth-scroll` | `.ts`, `.html`, `.css` | A smooth `scroll-behavior` from CSS, `scrollBehavior =` or `style.setProperty`; a smooth `behavior` scroll option, key bare or quoted, value on the same or the next line; any `[style.scroll-behavior]` binding; Tailwind `scroll-smooth` incl. `[class.scroll-smooth]`; the switch class `aeci-smooth-scroll`. Allow-lists `styles.css`, `core/in-page-smooth-scroll.ts` and `index.html` | One smooth-scroll mechanism, one switch (AECI-1752, §3 scroll notes) |
| `form-declares-method` | `.ts`, `.html`, not `.spec.ts` | A `<form>` opening tag that is neither `method="dialog"` nor `method="get" action="/search"`, read from the static attributes. A tag rule: it reads the whole tag across lines and skips tags inside comments | Forms are inert before hydration (AECI-1919, DESIGN.md) |

**Two escape hatches, and they are not interchangeable.**

A rule may carry an `allow` array of repo-relative paths. It is per-RULE, not per-file, on purpose: `styles.css` is exempt from the color rules because it is the token definition site, yet stays fully covered by both dark-theme rules — the one stylesheet most able to reintroduce a second theme. A file-level skip would have silently dropped that. The colour rules' two entries are declared in `eslint.color-patterns.mjs`. The `no-smooth-scroll` rule declares its own three (`styles.css`, `core/in-page-smooth-scroll.ts` and `index.html`) in the script. `source-constraints.spec.ts` asserts each allow-listed file still *contains* what it is exempted for, so an exemption cannot outlive its reason.

For a one-off line, `constraints-guard-allow-next-line` in a comment on the preceding line. Use it sparingly and say why — it exists so a comment or a test fixture that legitimately *names* a banned pattern does not make the file uneditable. Its first real uses are in `source-constraints.spec.ts`, where the fixture proving `text-left` is caught has to contain `text-left`.

The guard is unit-tested as of AECI-597 (`apps/web/src/source-constraints.spec.ts`), which also back-filled coverage for the three rules above that had none. That matters because every failure mode here is silent: a pattern that stops matching still exits 0 and still prints "rules clean".

### Root gates (`scripts/`)

| Gate | Scans | Fails on | Constraint |
|---|---|---|---|
| `check-claude-md-size.mjs` | `CLAUDE.md` | more than 30,000 bytes | `CLAUDE.md` stays a pointer file |
| `check-conflict-markers.mjs` | every tracked text file | a line of seven `<` closed later by a line of seven `>`, each followed by a space or the line end. NUL-byte files are skipped | A merge must not leave markers, as one did in an archived ranking page (AECI-1720) |
| `docs:notifications:check` | `docs/NOTIFICATIONS.md` | a file that differs from the registry's output | The notification doc is generated (ADR 0038) |

### Spec-enforced guards from the redesign

Lint cannot read these, so a spec holds them. `docs/TESTING_STRATEGY.md` §3.6 lists every one.

| Guard | Constraint |
|---|---|
| `apps/web/src/app/shared/form-field/early-input-coverage.spec.ts` | Every acceptance checkbox carries `aecConsent`, and every component binding a text field, select or radio imports `AecEarlyInput` (§13) |
| `apps/web/e2e/serif-floor.spec.ts`, with its source half in `design-tokens.guard.spec.ts` | Source Serif never renders below 20px (`DESIGN.md` §3 "The Serif-Floor Rule") |
| `apps/web/src/border-color-layer.guard.spec.ts` | The global `* { border-color }` default sits in `@layer base`, so a border-colour utility (`border-(--x)`, `divide-(--x)`) applies. An unlayered rule on `*` that sets a border colour fails it (AECI-2088) |
| `apps/api/src/lib/on-page-ordering-firewall.spec.ts` and the web firewall specs | No on-page order reads an input a paid plan can change. A new `orderBy`, `.sort(` or `.toSorted(` on a public read path fails until it is registered, a tripwire that reads tokens, not meaning (`STAGE_2_PAID_TIERS_SPEC.md` §3.2 assertion 8) |

### Template files (`**/*.html`)

| Rule | Severity | Section |
|---|---|---|
| `@angular-eslint/template/prefer-control-flow` | error | §7 |
| `@angular-eslint/template/prefer-at-empty` | error | §7 |
| `@angular-eslint/template/prefer-at-else` | error | §7 |
| `@angular-eslint/template/use-track-by-function` | error | §7 |
| `@angular-eslint/template/prefer-class-binding` | error | §8 |
| `@angular-eslint/template/no-any` | error | §8 |
| `@angular-eslint/template/prefer-ngsrc` | error | §14 |
| `angular.configs.templateAccessibility` (full set) | error | §21 |
| `aec-icon` must carry `label` or `decorative` (selector `aec-icon[label], aec-icon[decorative]`, NG8001 at build, not lint) | compile error | §14a |

### Review-only (no lint enforcement)

| Rule | Section |
|---|---|
| Hydration provider order and `withI18nSupport()` presence (the zoneless *provider* is lint-enforced via the `NgZone` / `provideZoneChangeDetection` import ban; ordering is not, and a missing `withI18nSupport()` is caught by `e2e/ssr-hydration-contract.spec.ts`, not lint) | §3 |
| Omit explicit `changeDetection` (OnPush is the v22 default) | §5 |
| No inline `<svg>` for a UI glyph (use `aec-icon`) | §14a |
| `ngStyle` ban (use `[style.X]`) | §8 |
| Async pipe for observables | §8 |
| No browser globals at template render (`new Date()`) | §8, §16 |
| Signal Forms; no Reactive/template-driven forms | §13 |
| SSR-safety patterns (`isPlatformBrowser`, `afterNextRender`, dynamic `import()`) | §16 |
| Lazy-loaded feature routes | §18 |
| Spartan brain composition without wrappers | §19 |
| Which token is the *right* one (Clay ≤5% of a screen, Bone never a page background, contrast pairings) — the literal ban itself is `Lint: ✅` as of AECI-597 | §20, `DESIGN.md` |
| First paint equals final paint for server HTML (caught by `e2e/first-paint.spec.ts`, not lint) | §20b |
| i18n string wrapping; `Cache-Tag` emission; `db.batch([...])` atomicity; no pay-for-placement | §22 |

### Future enforcement (deferred)

- `@angular-eslint/prefer-signals` and `@angular-eslint/no-uncalled-signals` — both require typed linting (`parserOptions.project`), which isn't yet wired in this workspace. Enabling typed linting is a separate scope-expanding change (slower lint, broader rule surface) and is tracked as a follow-up. Until then, signal usage is review-only.
- ~~Custom regex / processor rule banning hex / oklch / named Tailwind colors (§20).~~ **BUILT 2026-09-11 (AECI-597)** — see the color rows in the two tables above. Both deferral reasons turned out to be solvable. The id-selector class (`#aec-facet-panel`) dies to a trailing `(?![0-9a-zA-Z_-])` guard, and the four-digit issue/PO class (`PO #4471`) dies to *omitting* the `#RGBA` branch, which has zero usage here. The email-HTML problem was solved by scoping rather than by exemption: the rule lives in `angularBase`, so it never reaches `apps/api`. Measured false positives on the base branch: zero.
- Custom rule banning template-driven `[(ngModel)]` outside a `<form>` context (§13).
- `no-restricted-syntax` banning a one-argument `localeCompare` (§20a, AECI-825). Structurally
  trivial to write, and it would have caught the whole defect class. Deferred because it cannot tell
  display text from a slug, an id, or an ISO timestamp: ~10 current call sites compare exactly those
  and are correct as written, so the rule lands as ten `eslint-disable` lines rather than ten fixes.
  Worth revisiting if the ratio moves — unlike the rejected i18n rule below, the findings here are
  suppressible with a one-line reason rather than unactionable.

**Rejected, with evidence — do not re-propose without new information.** `@angular-eslint/template/i18n` was evaluated in AECI-549 for the "no hardcoded English in templates" constraint (§22). Its attribute check produced **53 findings in this codebase and zero real ones** — it flags every static attribute, including `d`, `stroke-linecap`, `rel`, `crossorigin`, `inputmode`, `aria-labelledby`, `selectionMode`, `orientation` — because it is configured by denylist (`ignoreAttributes`) and the allowlist we would need is inexpressible. Its text check was cleaner (4 findings) but all four were legitimate: decorative `aria-hidden` icon glyphs and the SVG brand wordmark. A rule with that false-positive rate is worse than no rule, so i18n stays review-only.

### Rule lifecycle

New rules land at `error` when the base branch is already clean, which is how the AECI-549 set shipped. Note that `warn` is **not** a usable staging severity here: `pnpm lint` runs without `--max-warnings`, so a warning does not fail the build and the rule is decorative. If a rule must land against a dirty baseline, either fix the baseline in the same PR or land the rule scoped (via `files` / `ignores`) to the clean subset and widen it as the rest is cleaned up.

### Operating notes (moved from CLAUDE.md, 2026-09-23)

Three review-only constraints are not in the review-only table above. None has a lint rule.

| Constraint | Where it is specified |
|---|---|
| Release every `fetch` response body you do not read (`discardResponseBody`), and batch or bound fan-out (AECI-666) | ADR 0021, 2026-08-27 amendment |
| Case never decides an alphabetical order (AECI-825) | §20a, `docs/API_CONTRACTS.md` §3.2 |
| Reads are never rate-limited; the in-Worker limiter is per route, after the authz guard, on writes only (AECI-773) | `docs/waf-rate-limits.md` §6, ADR 0026 |
