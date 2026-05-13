# AECi Review — Stack Validation Test App

**Purpose:** Validate the full Phase 1 foundation stack works end-to-end before committing to it for the production build.
**Version:** 1.0
**Date:** May 2026

---

## 1. What this test proves

This test app exists to answer a single binary question: **does the Phase 1 foundation stack work together as the spec assumes?**

If yes, Phase 2 starts with confidence.
If no, we discover the incompatibility now — when it costs days to swap a piece — not in week 6 when it costs weeks.

The stack under test:

- Angular 21+ in **zoneless** mode with SSR
- Cloudflare Workers as the SSR runtime
- Cloudflare CDN caching at the edge
- Cloudflare cache invalidation via **purge-by-URL** REST API (Pro plan)
- Spartan UI + Angular CDK components
- Tailwind CSS with theme tokens (light/dark)
- System preference theme detection with manual override

Out of scope for this test: Supabase, Prisma, Algolia, Datadog, PostHog, auth, i18n. Those get their own validation when their phase begins. This test is foundation only.

---

## 2. Why "zoneless" matters

Angular's NgZone is the legacy change detection mechanism that monkey-patches async APIs. Zoneless mode (stable in Angular 18+, default-recommended in 21) replaces this with signals-based reactivity, which has three practical benefits worth validating up front:

- **Smaller bundle** — `zone.js` is ~30KB minified, removed entirely in zoneless mode
- **Better SSR behavior** — no zone tracking means simpler hydration and fewer hydration mismatches
- **Better Workers compatibility** — `zone.js` patches `setTimeout`, `Promise`, etc., which has caused friction in non-browser runtimes like Cloudflare Workers historically

Zoneless is also the direction Angular is going. Starting zoneful and migrating later is more painful than starting zoneless.

---

## 3. Tech stack for the test app

| Layer | Choice | Notes |
|---|---|---|
| Framework | Angular 21+ | Latest stable |
| Change detection | Zoneless (`provideZonelessChangeDetection()`) | No `zone.js` in bundle |
| Rendering | SSR via `@angular/ssr` | Server-rendered HTML with hydration |
| Server runtime | Cloudflare Workers | Via `@cloudflare/vite-plugin` or `@angular/build:application` with Workers output |
| Styling | Tailwind CSS | Configured with CSS custom property tokens |
| Components | Spartan UI (`@spartan-ng/ui-*`) + Angular CDK | Pick 3–4 representative components |
| Theme tokens | CSS custom properties bound to `[data-theme="light|dark"]` | System preference detection + manual override |
| Cache | Cloudflare CDN at the edge | `Cache-Control` headers from the Worker |
| Cache invalidation | Cloudflare REST API purge-by-URL | API token in Worker secrets |
| Deployment | Wrangler | Single Worker, single zone |
| Local dev | Wrangler dev | Validates Worker bundle locally |

---

## 4. What the test app does

A minimal Angular SSR app with three routes, just enough to exercise every part of the stack:

### Route 1: `/` — Theme + Spartan smoke test

- Page title and short intro text
- A `hlm-button` (Spartan button) that toggles theme between light / dark / system
- A `hlm-card` (Spartan card) displaying current theme state
- A `hlm-input` and `hlm-label` (Spartan form primitives)
- A `hlm-dialog` (Spartan modal) triggered by a button — validates Angular CDK overlay works in SSR
- Tailwind utility classes throughout, reading from CSS custom property tokens
- Server-rendered HTML must include initial theme based on `Sec-CH-Prefers-Color-Scheme` header (or fall back to a sensible default)

**What this validates:**
- Spartan components render server-side without errors
- Angular CDK overlay works with SSR hydration
- Tailwind theme tokens switch correctly between light and dark
- Zoneless change detection drives the theme toggle reactively
- No hydration mismatches between server-rendered HTML and client-hydrated DOM

### Route 2: `/cached/:id` — Cache smoke test

- Dynamic route that renders an entity-detail-style page
- Shows the `:id` and a server timestamp baked into the rendered HTML
- Worker sets `Cache-Control: public, s-maxage=300, max-age=60`
- First request: renders fresh, timestamp = now
- Subsequent requests within 5 minutes: same timestamp (cache HIT)

**What this validates:**
- SSR output is cacheable at the Cloudflare edge
- `CF-Cache-Status` header progresses MISS → HIT
- Cache key includes the path, so `/cached/1` and `/cached/2` cache independently
- The Worker reads `Cache-Control` headers correctly

### Route 3: `/admin/purge` — Cache invalidation smoke test

- A page with a form: input box for URL path, "Purge" button
- Form submission triggers a `POST /api/purge` Worker endpoint
- Endpoint calls Cloudflare's purge-by-URL REST API with the supplied path
- Returns success/failure + API response
- Page displays the API response

**What this validates:**
- Cloudflare API token works from inside a Worker
- Purge-by-URL endpoint is callable
- Purge propagates globally — verified by hitting `/cached/:id` from different geographies before and after

---

## 5. Test scenarios

Each scenario is a specific check. Run all of them before declaring the stack validated.

### 5.1 Build & deploy

- [ ] `npm run build` produces an Angular SSR bundle suitable for Cloudflare Workers
- [ ] Bundle size under Cloudflare's 10MB Worker size limit (uncompressed)
- [ ] `zone.js` is **not** in the production bundle (verify with `npx source-map-explorer dist/server/main.js` or equivalent)
- [ ] `wrangler deploy` succeeds
- [ ] App reachable at the deployed URL

### 5.2 Server-side rendering

- [ ] View source of `/` shows fully rendered HTML, not just `<app-root></app-root>`
- [ ] All Spartan components render server-side without errors in Worker logs
- [ ] Page renders correctly with JavaScript disabled in browser dev tools (proves SSR is doing the work)
- [ ] Time-to-first-byte (TTFB) under 500ms from a North American POP

### 5.3 Hydration

- [ ] Browser console shows no hydration mismatch warnings
- [ ] Theme toggle button works after hydration (proves interactivity is wired up)
- [ ] Dialog opens and closes after hydration (proves Angular CDK overlay hydrates correctly)
- [ ] Form input accepts text after hydration

### 5.4 Zoneless behavior

- [ ] `provideZonelessChangeDetection()` is in the app config
- [ ] `zone.js` is not imported anywhere
- [ ] Signal-driven state updates trigger view re-renders (theme toggle as test case)
- [ ] No `NgZone` references anywhere in the code

### 5.5 Theme system

- [ ] System preference (light/dark) detected on first load via `prefers-color-scheme`
- [ ] Manual override persists to localStorage and survives page refresh
- [ ] Toggling theme updates CSS custom properties on `<html>` or root element
- [ ] All Spartan components reflect the active theme
- [ ] Tailwind utility classes resolve to theme-appropriate values
- [ ] Forest accent passes WCAG AA contrast in both themes (large text + UI elements)
- [ ] Clay accent passes WCAG AA for large text / graphical use only (verified manually)

### 5.6 Edge caching

- [ ] First request to `/cached/abc` returns `CF-Cache-Status: MISS`, status 200
- [ ] Second request within 60s returns `CF-Cache-Status: HIT`
- [ ] `/cached/abc` and `/cached/xyz` cache independently (different timestamps)
- [ ] Request from a second geography (e.g. VPN to EU) eventually shows HIT after warming
- [ ] `Age` header increases on subsequent HITs

### 5.7 Cache invalidation via purge-by-URL

- [ ] Submit the purge form for `/cached/abc`
- [ ] Cloudflare API returns success
- [ ] Next request to `/cached/abc` returns `CF-Cache-Status: MISS` (within 30 seconds of purge)
- [ ] Timestamp on the page reflects fresh render, not cached value
- [ ] Purge of `/cached/abc` does NOT invalidate `/cached/xyz`
- [ ] Repeated purge calls don't error or rate-limit at typical write volume

### 5.8 Spartan UI specific checks

- [ ] `hlm-button` renders, is clickable, has correct hover/focus states in both themes
- [ ] `hlm-card` renders with correct background, border, shadow tokens
- [ ] `hlm-input` + `hlm-label` render with correct typography and spacing
- [ ] `hlm-dialog` opens with focus trap, closes on Esc, returns focus correctly
- [ ] No console errors from Angular CDK during component lifecycle
- [ ] All Spartan components work with `provideZonelessChangeDetection()` — no warnings about zone requirements

### 5.9 Tailwind integration

- [ ] Tailwind utility classes apply correctly server-side and client-side
- [ ] CSS custom property tokens from theme config resolve in both themes
- [ ] Tailwind's JIT mode produces only the classes actually used (verify built CSS file is small)
- [ ] No FOUC (flash of unstyled content) on initial load

### 5.10 Worker observability

- [ ] `wrangler tail` shows logs from SSR requests
- [ ] Errors thrown in Angular components surface in Worker logs
- [ ] Cache hits don't invoke the Worker (verify by checking tail output during HIT requests)

---

## 6. Known risk areas and what to watch for

These are the spots most likely to break. Pay close attention.

**Angular SSR adapter for Cloudflare Workers** — The official `@angular/ssr` package is designed for Node.js runtimes. Cloudflare Workers requires the build to target the Workers runtime, not Node.js. Use the `@cloudflare/vite-plugin` integration or the Angular team's official Workers adapter (if published — verify at build time). If neither works, the test fails fast and we know to either downgrade Angular or pick a different SSR host.

**Spartan UI + Angular 21 + zoneless** — Spartan is built on Angular CDK, which historically required zones. Recent CDK versions (17+) support zoneless. Verify the specific Spartan version pinned for this test explicitly supports both Angular 21 and zoneless mode. Check release notes.

**Hydration mismatches** — Spartan components that depend on browser APIs (window size, user preferences, animations) can render differently server-side and client-side. Watch for hydration warnings. The dialog component specifically is high-risk because overlays manipulate the DOM in ways that can confuse hydration.

**Theme detection in SSR** — Server doesn't know the user's color preference at render time. Options:
- Render with a neutral default and flash to user preference on client hydration (causes FOUC)
- Use the `Sec-CH-Prefers-Color-Scheme` Client Hints header if available (limited browser support)
- Persist user preference in a cookie and read it server-side (works reliably)

The cookie approach is most robust. Test it.

**Cloudflare API token scoping** — The API token used for purge needs `Zone.Cache Purge` permission scoped to your zone. A misscoped token fails silently or with a confusing error. Validate this carefully.

**Cache key includes more than just URL** — By default, Cloudflare's cache key includes the full URL plus some headers. Verify that purging by URL actually invalidates what you cached. Specifically, if the Worker sets `Vary` headers, the cache key fragments and a single purge call may not invalidate all variants.

---

## 7. Project structure

```
aeci-stack-test/
├── package.json
├── wrangler.jsonc
├── angular.json
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── .env.example                    # CLOUDFLARE_API_TOKEN, ZONE_ID
├── src/
│   ├── main.ts                     # Bootstrap with provideZonelessChangeDetection()
│   ├── main.server.ts              # SSR entry
│   ├── server.ts                   # Cloudflare Worker entry, routes to Angular SSR
│   ├── app/
│   │   ├── app.config.ts           # Zoneless config, router config
│   │   ├── app.config.server.ts    # Server-side providers
│   │   ├── app.component.ts        # Root layout with theme toggle
│   │   ├── theme.service.ts        # Signal-based theme state
│   │   ├── routes.ts
│   │   ├── home/
│   │   │   └── home.component.ts   # Spartan smoke test
│   │   ├── cached/
│   │   │   └── cached.component.ts # Cache test, dynamic route
│   │   └── admin/
│   │       └── purge.component.ts  # Purge form + API call
│   ├── styles.css                  # Tailwind directives + theme tokens
│   └── theme-tokens.css            # Light/dark CSS custom properties
└── README.md                       # Setup, test scenarios, results log
```

---

## 8. Setup checklist (in order)

1. **Confirm Cloudflare account state**
   - Cloudflare account exists, Pro plan active
   - A zone is provisioned (e.g. `stack-test.aecireview.com` as a subdomain)
   - API token created with `Zone.Cache Purge` permission for that zone
   - Token saved to `.env` and (for deployed Worker) Worker secrets

2. **Bootstrap the Angular project**
   - `ng new aeci-stack-test --routing --ssr --standalone --style=css --skip-tests`
   - Verify Angular 21+ is installed
   - Add `provideZonelessChangeDetection()` to `app.config.ts`
   - Remove all `zone.js` imports and references

3. **Add Tailwind**
   - Install `tailwindcss`, `postcss`, `autoprefixer`
   - Configure `tailwind.config.ts` with content paths and theme extending CSS custom properties
   - Add Tailwind directives to `styles.css`
   - Define theme tokens in `theme-tokens.css` matching Section 2a of the Stage 1 spec

4. **Add Spartan UI**
   - Follow Spartan installation for Angular 21 + Tailwind
   - Install the specific Spartan packages for button, card, input, label, dialog
   - Verify CDK is installed and at a zoneless-compatible version
   - Add Spartan's Tailwind preset or config additions

5. **Configure Cloudflare Workers deployment**
   - Install Wrangler
   - Configure `wrangler.jsonc` with account ID, zone, custom_domain route, compatibility date, and `"compatibility_flags": ["nodejs_compat"]` for SSR
   - Set `CLOUDFLARE_API_TOKEN` and `ZONE_ID` as Worker secrets via `wrangler secret put`
   - Verify build produces a Workers-compatible bundle (no Node.js shims)

6. **Implement the three routes**
   - `/` — theme toggle + Spartan smoke test
   - `/cached/:id` — server-rendered timestamp with `Cache-Control` headers
   - `/admin/purge` — form posting to a Worker endpoint that hits Cloudflare REST API

7. **Local validation**
   - `wrangler dev` runs the app locally
   - All three routes render
   - Build succeeds without errors

8. **Deploy**
   - `wrangler deploy`
   - App reachable at the configured URL
   - Run through all of Section 5's test scenarios

9. **Document results**
   - For each scenario in Section 5, mark pass/fail
   - For failures, capture the error message, the commit hash, and any relevant context
   - Update this document's Section 9 with findings

---

## 9. Results log

Probe ran 2026-05-12 (foundation scenarios) and 2026-05-13 (i18n scenarios) against `apps/stack-test` deployed at `stack-test.aecintegrations.com`. Implementation lives at `apps/stack-test/`; integration harness at `apps/stack-test/scripts/run-extra-tests.sh` (T1–T12).

| Section | Scenario | Result | Notes |
|---|---|---|---|
| 5.1 | Build & deploy | ✅ | Single `server.mjs` ~1.1 MB; `zone.js` not in bundle; `wrangler deploy` succeeds |
| 5.2 | Server-side rendering | ✅ | View-source shows rendered HTML; renders with JS off; TTFB well under 500ms |
| 5.3 | Hydration | ✅ | No mismatch warnings with `withEventReplay()`; CDK Dialog hydrates cleanly because it's opened imperatively client-side |
| 5.4 | Zoneless behavior | ✅ | `provideZonelessChangeDetection()` in `app.config.ts:18`; no `zone.js` dependency in `package.json` |
| 5.5 | Theme system | ✅ | SSR reads cookie + `Sec-CH-Prefers-Color-Scheme`; client reconciles from `localStorage` + `matchMedia` — see `theme.service.ts:73-86` |
| 5.6 | Edge caching | ✅ | URL-keyed segmentation works; `caches.default` MISS→HIT progression verified per T1 |
| 5.7 | Cache invalidation | ✅ | Purge-by-URL works on Pro; locale-scoped purge and canonical cascade both verified (T10) |
| 5.8 | Spartan UI | ✅ | Brain primitives only — `BrnButton`, `BrnDialog` work with zoneless; `helm` codegen avoided |
| 5.9 | Tailwind integration | ✅ | Tailwind v4 with custom-property tokens; no FOUC |
| 5.10 | Worker observability | ✅ | `wrangler tail` shows SSR logs; cache HITs don't invoke the Worker |

### 9a. Outcomes summary (go/no-go)

Validated as **go** for Phase 2. Highlights and gaps:

**Validated** ✅
- Zoneless Angular + Spartan brain + Angular CDK overlay: no hydration warnings, no zone.js shipped.
- Cloudflare Workers SSR via `AngularAppEngine` with `nodejs_compat` (Node polyfills required by `@angular/ssr`; unrelated to DB path).
- Edge caching via `caches.default` with URL-keyed segmentation; purge-by-URL works on Pro plan.
- Per-locale build: single `server.mjs` dispatches `/` (en-US) and `/es` (es-ES); no per-locale deploy.
- Per-field translation fallback (overlay layer); merge runs on both Worker and SSR sides.
- Locale URL-prefix segments edge cache naturally — no `Vary` header needed (T9).

**Gaps that informed doc updates** ⚠️
- **T1b — theme-cookie pollution.** A naive SSR theme implementation reads the `theme` cookie and bakes it into rendered HTML; with URL-only cache keying, the first visitor primes the cache for everyone. Fixed in stack-test by stripping visitor-state cookies before forwarding to SSR (`src/server.ts:212-229`). Documented as a non-negotiable rule in `STAGE_1_SPEC.md §9.1a` and `CLAUDE.md`.
- **T3a/b — "pinned 404".** Caching 200 "not found" with a 5-minute TTL pins stale state across entity creation. Stack-test ships with this gap; `apps/web/` must return HTTP 404 with ≤60s TTL from the start. See `STAGE_1_SPEC.md §9.1b`.
- **T6 — no ETag.** Worker doesn't emit `ETag`; clients can't `If-None-Match` for bandwidth savings. Soft gap, deferred to Phase 2 decision.

### 9b. Reusing the harness

The bash integration test pattern at `apps/stack-test/scripts/run-extra-tests.sh` (T1–T12) covers behaviors that span multiple requests with edge-cache state (cookie/cache interaction, MISS→HIT, purge propagation, per-locale isolation). Vitest+Miniflare is fine for handler-logic tests but does not exercise the actual Cloudflare CDN cache. Port the T1–T12 pattern into `apps/web/` integration tests in Phase 1 — see `TESTING_STRATEGY.md §6`.

---

## 10. Go/no-go decision criteria

**Go** — Phase 2 of the Stage 1 build proceeds as specified if:

- All Section 5 scenarios pass, or
- Any failures are minor (cosmetic, edge case) with documented workarounds

**No-go with mitigation** — adjust the Stage 1 spec before proceeding if:

- SSR works but a specific Spartan component has hydration issues — swap that component for a custom one or a different library
- Cache invalidation works but propagation is slow (>60s) — adjust TTL strategy accordingly
- Bundle size is over budget — investigate tree-shaking, code-splitting, or feature reduction

**Hard stop — rethink stack** — if any of these fail:

- Angular SSR doesn't deploy to Cloudflare Workers at all (bundle incompatibility)
- Zoneless + Spartan + Angular CDK has fundamental incompatibilities
- Cache invalidation via purge-by-URL doesn't work on the Pro plan as documented
- Hydration mismatches are unfixable across multiple Spartan components

In any hard-stop case, document what failed and consult before re-scoping the spec.

---

## 11. After the test

Regardless of outcome:

1. **Commit the test app to a permanent reference repo** — `github.com/aeci-review/stack-validation` or similar. Future debugging benefits from having a known-working minimal example.
2. **Update the Stage 1 spec** with any findings that change the foundation choices.
3. **Document any workarounds** that were needed — these become "gotchas" the production build inherits.
4. **Move on to Phase 2 with confidence** (or reset and pick a different stack).
