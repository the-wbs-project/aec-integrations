# AEC Integrations — Testing Strategy

**Referenced by:** `STAGE_1_SPEC.md` §21 (Accessibility), `CICD_PLAN.md` §3
**Version:** 1.0
**Date:** May 2026

---

## 1. Approach

Pragmatic, modern, integrated with CI. The goal isn't 100% coverage — it's confidence that the code does what the spec says, and that regressions are caught before users see them.

Priorities in order:
1. **Tests that catch real bugs** — focus on the integration points and core flows that matter to users
2. **Tests that run fast in CI** — slow tests get skipped, skipped tests stop catching bugs
3. **Tests that are easy to maintain** — flaky tests get disabled, disabled tests are worse than nothing

---

## 2. Test layer overview

| Layer | Tool | Runs against | Speed | When |
|---|---|---|---|---|
| Unit | Vitest | Pure functions, isolated components | Fast (~ms) | Every PR |
| Component | Vitest + Angular Testing Utilities | Single component, mocked deps | Fast (~10ms) | Every PR |
| API contract | Vitest + Zod assertions | Mock fetch against schemas | Fast | Every PR |
| Integration | Vitest + Miniflare | Worker code with real Workers runtime | Medium | Every PR |
| E2E | Playwright | Full deployed preview | Slow (~30s/test) | Every PR |
| Accessibility | axe-core via Playwright | Deployed preview | Medium | Every PR |
| Visual | Playwright screenshots + Chromatic | Deployed preview | Medium | Every PR |
| Performance | Lighthouse CI | Deployed preview | Slow (~2min) | Every PR |
| Smoke | Playwright (subset) | Staging, production | Medium | Post-deploy |
| Load | k6 or similar | Staging | Slow | Pre-launch, rarely |

> **"Every PR" means *every* PR — any base branch.** `deploy.yml` and `integration-db-tests.yml`
> carry no `branches:` (base-branch) filter on their `pull_request` trigger, so a PR into
> `stage-2`, `admin-panel`, or an epic branch runs the same lanes as a PR into `main`. This was
> **not** true before 2026-08-14: both were pinned to `branches: [main]`, which filters by base
> branch, so under the ADR 0019 branch model this table over-claimed for most PRs in flight —
> the ~13k-line AECI-513 epic merged into `stage-2` having run none of it. Two rows carry their
> own caveats regardless of base: **Performance** (Lighthouse) is push-to-`main`-only by design
> (`lighthouse.yml`, §10.5) — not on PRs — and **Visual** (Chromatic) is not wired at all.
> `CICD_PLAN.md` §3.1 has the full rationale. `main` and `stage-2` are branch-protected on the
> same three required contexts, so a red `Lint & typecheck` / `Unit tests` / `Build SSR Worker`
> blocks the merge on both (§8). **`admin-panel` is the exception on every count** — the trigger
> fix landed on `stage-2` only, so its PRs still run none of this, and it has no protection.

---

## 3. Unit testing — Vitest

### 3.1 Why Vitest

- Faster than Jest, native ESM, no compile step for TypeScript
- Works with Angular 18+ via `@analogjs/vitest-angular`
- Excellent Workers compatibility — easy to mock Workers globals
- Same syntax as Jest, easy migration path if needed
- Built-in coverage reporting via c8

### 3.2 What to unit test

**Always:**
- Pure utility functions (slug generation, URL building, date formatting)
- Validation logic (Zod schemas — verify they accept valid input and reject invalid)
- Helper functions (`buildCacheTags`, `cacheKeyFor`, audit-log row builders)
- Score calculations and aggregations
- Business rules (review duplicate detection, ban enforcement)
- **Chart geometry** (AECI-576 / `ADMIN_PANEL_SPEC.md` §8, §11) — scales, path strings, bar
  layout, and the degenerate cases (empty, single-point, all-zero, non-finite input). This is a
  category rather than a one-off: the admin console's charts are hand-rolled SVG with **no
  charting dependency**, so their maths is ours to test. It only stays testable because §8
  requires the geometry to be a pure function of `(values, box)` with no DOM measurement — which
  is also what makes the charts SSR-safe. `apps/web/src/app/admin/charts/chart-geometry.spec.ts`
  is the reference: plain Vitest, no TestBed, no `*.component.spec.ts` suffix. If a chart's maths
  needs a mounted component to test, the maths is in the wrong file.

**Sometimes:**
- Service classes if they have meaningful logic beyond delegation
- Workflow state machines (transition validity)

**Rarely:**
- Components that are pure rendering with no logic (let E2E cover them)
- Wrapper functions that just call other functions

### 3.3 Coverage target

- Line coverage: 70% across the codebase
- Branch coverage: 60%
- Critical paths (auth, payments in Stage 4, audit logging) require 90%+ coverage explicitly

Coverage is measured with Vitest's built-in **v8** provider (each package's `vitest.config.ts` records these numbers in its `thresholds` block). CI generates the report on every PR — `pnpm -r run test:coverage` runs as an **advisory, non-blocking** step in the `unit-tests` job (`continue-on-error`) and uploads the lcov/HTML as the `coverage` artifact — but a coverage drop **does not fail the build**. The thresholds are a documented target, not a merge gate: quality of tests matters more than the number. There is no Codecov integration today; if one is added later it would be for visualization, not enforcement.

### 3.4 Configuration

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import angular from '@analogjs/vite-plugin-angular';

export default defineConfig({
  plugins: [angular()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      reporter: ['text', 'html', 'lcov'],
      exclude: ['**/*.spec.ts', '**/*.config.ts', '**/main.ts'],
      thresholds: {
        lines: 70,
        branches: 60,
        functions: 70,
        statements: 70,
      },
    },
  },
});
```

### 3.5 Patterns

**Pure function:**
```typescript
import { describe, it, expect } from 'vitest';
import { generateSlug } from './slug';

describe('generateSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(generateSlug('Procore Technologies')).toBe('procore-technologies');
  });

  it('handles existing collisions by appending vendor name', () => {
    const existing = ['connect-procore'];
    expect(generateSlug('Connect', 'Fieldwire', existing)).toBe('connect-fieldwire');
  });
});
```

**Zod schema validation:**
```typescript
import { SubmitReviewSchema } from '@aeci/shared/api/reviews';

describe('SubmitReviewSchema', () => {
  it('rejects body under 50 chars', () => {
    const result = SubmitReviewSchema.safeParse({
      product_id: 'valid-uuid-here',
      rating_overall: 5,
      rating_onboarding: 4,
      title: 'Great product',
      body: 'Too short',
    });
    expect(result.success).toBe(false);
  });
});
```

### 3.6 Invariant tests — tests that encode a decision, not a behaviour

A handful of tests exist to make a **written decision mechanically true** rather than to cover a code path. They look over-specified on purpose: a frozen literal list, an assertion that a builder emits *no* statement of some shape, an assertion that a set is empty. **Deleting or loosening one is a spec change, not a test cleanup** — the governing spec has to be reopened first, and each one names its spec section in a comment so a reviewer can tell the difference.

Three ship with the Stage 2 entitlement model (`docs/STAGE_2_PAID_TIERS_SPEC.md` §10), and they are the reference shape:

| Test | Asserts | Why a test and not a comment |
|---|---|---|
| **Ranking disjointness** (`packages/shared/src/entitlements.spec.ts`) | The capability vocabulary and the union of every Algolia `searchableAttributes` ∪ `attributesForFaceting` ∪ `customRanking` are **disjoint sets**; no capability id matches a ranking-word regex; no entitlement concept (`verified`, `tier`, `entitlement`, `paid`, `plan`, …) appears in `INDEX_SETTINGS` at all | **No pay-for-placement** is the product's founding promise. Both tables are pure data in the same package, so the promise is *provable* — this is the one place a documented principle became an asserted property. It carries its own **non-vacuity** case (the ranking vocabulary is non-empty, and the `unordered()`/`desc()` wrappers really were stripped), because a broken strip helper would make every assertion below it pass trivially |
| **Mirror sole-writer** (`apps/api`, over the batch builders) | `grantSeatStatements` — and every route handler — emits **no statement touching `vendors.verified`**; only `lib/vendor-entitlement.ts` does, and never one side of the *iff* without the other. Plus: `vendors.updated_at` moves **iff** `vendors.verified` moves, in **both** directions | The ESLint sole-writer rule catches the syntax; this catches the semantics the rule cannot see. The both-directions clause exists because the un-verify direction had no writer at all until AECI-532, so nothing had ever exercised it |
| **Reads are never gated** (`apps/api`) | `GET /api/vendor/me` returns **200** for a vendor whose entitlement is `revoked`/`expired`, carrying the downgraded `entitlement` block | A one-line mistake with total blast radius on exactly the cohort being billed: `vendorMeResolver` maps 403 onto a **404 render**, so gating this read would hide the renewal notice inside a 404 dashboard |

Alongside them, per issue: the second-seat no-op matrix against the in-memory D1 harness; 422 idempotency on the admin `set`/`clear`; `POST /api/promote` still cannot move `verified` (the AECI-520 regression guard); the expiry cron writes **no `status`** (asserted against generated SQL, since a `WHERE status = 'active'` guard is a read and must not be mistaken for a write); and a no-read-path guard asserting no read config in `lib/drizzle-helpers.ts` references `vendor_entitlements`.

**A caveat worth generalizing.** An invariant asserted in a file where its subject is *mocked* passes vacuously. Where a cron-level suite mocks the sweep it is testing, the real obligation belongs in the sweep's own spec, and any exemption list in the mocking file should say which entries are genuinely exempt versus merely asserted elsewhere.

---

## 4. Component testing — Vitest + Angular Testing Utilities

### 4.1 Scope

Component tests render a single Angular component in isolation, with mocked dependencies. Used for components with meaningful interaction logic.

### 4.2 What to test

- Components with form input or validation
- Components with conditional rendering based on inputs or state
- Components with output emission (event handlers, signals)
- Auth-gated components (verify they redirect or hide content when unauthenticated)

### 4.3 What to skip

- Pure presentational components with no logic
- Components fully covered by E2E tests where rendering is the main concern

### 4.3a The two runners in `apps/web`, and which one owns a file

`apps/web` has **two Vitest runners**, split by filename, and putting a spec in the
wrong one makes it silently not run:

| Runner | Config | Picks up | Environment |
|---|---|---|---|
| plain Vitest | `apps/web/vitest.config.ts` | `src/**/*.spec.ts`, **excluding** `*.component.spec.ts` | `node`, no Angular |
| `ng test` | `apps/web/angular.json` → `test` target | `src/**/*.component.spec.ts` | Angular build pipeline |

`pnpm --filter @aeci/web test:unit` runs both in sequence.

The split is by capability, not by location: anything needing Angular DI must be
named `*.component.spec.ts`, and anything that does **not** import from
`@angular/*` should not be, because the plain runner is an order of magnitude
faster.

**The admin chart primitives are the worked example** (AECI-578,
`apps/web/src/app/admin/charts/`, `ADMIN_PANEL_SPEC.md` §8/§11). `geometry.ts`,
`format.ts`, `axis.ts` and `chart-types.ts` are **Angular-free by rule**, so
`geometry.spec.ts` and `format.spec.ts` run in the plain runner — which is what
makes §11's "pure-function unit tests … no rendering involved" cheap enough to be
exhaustive (scales, ticks, paths, stacking, arcs, plus the empty / single-point /
all-zero / dominant-outlier cases, and the UTC↔WIB boundary tests). The chart
*components* are `*.component.spec.ts` and run under `ng test`.

That import discipline is load-bearing rather than stylistic: add an `@angular/*`
import to `geometry.ts` and its spec stops running, with no error. If you touch
those modules, check both runners report the file.

### 4.4 Pattern

```typescript
import { render, screen, fireEvent } from '@testing-library/angular';
import { ReviewFormComponent } from './review-form.component';

describe('ReviewFormComponent', () => {
  it('disables submit until form is valid', async () => {
    await render(ReviewFormComponent);

    const submit = screen.getByRole('button', { name: /submit/i });
    expect(submit).toBeDisabled();

    fireEvent.input(screen.getByLabelText(/title/i), { target: { value: 'Good product' } });
    fireEvent.input(screen.getByLabelText(/body/i), {
      target: { value: 'This is a sufficient review body that meets the minimum 50 character requirement.' }
    });

    expect(submit).toBeEnabled();
  });
});
```

---

## 5. API contract testing

API contract tests verify that endpoints return responses matching their Zod schemas. They catch contract drift between the API Worker and shared package.

### 5.1 What to test

Every endpoint defined in `API_CONTRACTS.md` should have at least one contract test:
- Happy path: valid request returns the expected response shape
- Error paths: each documented error code returns the correct shape

### 5.2 Pattern

```typescript
import { ListProductsResponseSchema } from '@aeci/shared/api/products';

describe('GET /api/products', () => {
  it('returns paginated response matching schema', async () => {
    const response = await fetch('http://localhost:8787/api/products');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(() => ListProductsResponseSchema.parse(body)).not.toThrow();
  });

  it('returns VALIDATION_FAILED for invalid limit', async () => {
    const response = await fetch('http://localhost:8787/api/products?limit=999');
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});
```

These tests run against `wrangler dev` in CI, against the locally running API Worker.

---

## 6. Integration testing — Vitest + Miniflare

Miniflare is Cloudflare's local Workers runtime emulator. It runs Worker code with realistic bindings (KV, R2, Durable Objects, service bindings) without deploying.

### 6.1 What to test

- Worker request handlers end-to-end with mocked external dependencies
- Service binding interactions between SSR Worker and API Worker
- Cache-facing handler behavior (headers, gateway normalization, queue/native purge delegation)
- Error propagation through middleware

### 6.2 Pattern

```typescript
import { Miniflare } from 'miniflare';

describe('SSR Worker', () => {
  let mf: Miniflare;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      scriptPath: './dist/server/main.js',
      bindings: { ENV: 'test' },
      serviceBindings: {
        API: (req) => new Response(JSON.stringify({ mocked: true })),
      },
    });
  });

  afterAll(() => mf.dispose());

  it('renders the home page', async () => {
    const res = await mf.dispatchFetch('http://localhost/');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('AEC Integrations');
  });
});
```

### 6.3 The Drizzle/D1 client in tests

API Worker handlers are factories that take the Drizzle client through a `getDb`-style factory parameter and call it per request — the factory-DI shape in `DATABASE_SCHEMA.md` §1a (`getDb(env)`, `apps/api/src/db/client.ts`). Do **not** import a module-level DB singleton; doing so makes handlers untestable without a live database. (Prisma was removed entirely in AECI-278 — there is no `getPrisma` / `prismaFor`.)

**Unit/handler tests** — inject a Drizzle double through the factory param. Vitest's `vi.fn()` or a minimal hand-rolled stub is enough for most cases (`db.query.*`, `db.select()`, `db.insert/update/delete`, `db.batch`). Assert on the call shape, not the return.

**Higher-fidelity integration tests** — run against a local D1 (the in-memory / Miniflare D1 harness, or the seeded local SQLite). The authz no-leakage matrix specs (`apps/api/src/routes/*.authz-matrix.spec.ts`, AECI-234) compose the real guards with the real handlers over the in-memory D1.

**Atomicity constraint:** D1 has **no interactive transactions** — atomic multi-statement writes are `db.batch([...])`. So the "open a transaction, run the test, rollback" isolation pattern does not apply; reset/reseed the local D1 between suites instead.

**The harness is better-sqlite3, and its LIMITS are not D1's (AECI-580).** `apps/api/src/test/d1.ts` runs a real SQLite, which is why it is so much more faithful than mocking — but it is a *differently compiled* SQLite. Compile-time limits diverge, and the divergence is invisible: a query the harness executes happily can fail at runtime on D1.

The known case, found the hard way: **D1 sets `SQLITE_MAX_COMPOUND_SELECT` to 5**, against the stock 500 that better-sqlite3 ships. `GET /api/admin/system` built one `UNION ALL` of `COUNT(*)` per table (~28 terms) to count rows in a single round trip. Every unit test passed; the first real request returned `500` with `D1_ERROR: too many terms in compound SELECT`. It is now chunked at 5, with a spec that asserts the **query shape** (no emitted statement exceeds 5 terms) rather than the result — because the result-level assertion is exactly the one the harness cannot fail on.

Two habits follow:

1. **Hand-built SQL is where this bites.** ORM-generated queries stay inside ordinary shapes; a hand-rolled `sql.raw(...)` that scales with table count, column count, or row count can cross a limit the harness will never enforce. `SQLITE_MAX_VARIABLE_NUMBER` and the 100 KB statement-length cap are the same class of hazard.
2. **Exercise a new hand-built query against a real local D1 once**, via `pnpm dev:agent` + `curl`, before calling it verified. A green suite is necessary, not sufficient. Where a limit is discovered, encode it as a shape assertion so the next person inherits the guard rather than the bug.

**Audit + cache assertions.** Tests that exercise a write path should assert both the `db.batch([...])` call shape (mutation + the `auditInsert(...)` row in the same batch) and the typed cache-purge message sent after commit. Queue-consumer tests separately assert delegation into the cached `Renderer` entrypoint, including ack on success/no-cache/noop and retry on purge failure. See `CODE_REVIEW_CHECKLIST.md` "Tests" — these assertions are a documented review requirement.

### 6.4 Edge-cache integration layer (complementary to Miniflare)

Vitest + Miniflare exercises Worker *handler logic* but does **not** exercise native Workers Cache in front of the Worker. Verified for AECI-323 with Wrangler 4.111.0 / Miniflare 4.20260710.0: `wrangler dev --env preview` accepts the per-entrypoint cache config, but every localhost request executes the Worker and responses carry neither `Cf-Cache-Status` nor `Age`. Local tests therefore own the response-header contract, gateway normalization, queue consumer, native purge call shape, noindex bake, and stable cache/robots semantics across repeat requests; only a deployed Worker can prove front-cache state and HIT behavior. Do not require byte-identical local SSR documents—Angular may emit request-specific element ids on each uncached render.

Keep a small bash- or Playwright-driven suite for these multi-request, edge-stateful scenarios — modeled on `apps/web/scripts/run-extra-tests.sh` (T1–T12). The scenarios that earned their keep there:

- **Cookie × cache pollution** — verify the visitor-state cookie-strip runs before SSR for cacheable routes, so a per-visitor cookie can't poison the shared edge cache. The strip list (`VISITOR_STATE_COOKIES`) is empty as of AECI-226 — `theme` was removed with the dark theme — but the mechanism is retained as infrastructure and `server.spec.ts` still exercises it.
- **`Vary` audit** — confirm cached SSR responses emit only `Vary: Accept-Language`; forbidden values such as `Cookie`, `User-Agent`, and `Accept-Encoding` must be absent.
- **404 / KV-miss path** — assert HTTP 404 with TTL ≤60s, not 200 with a long TTL (the "pinned 404" trap).
- **MISS → HIT progression** — `e2e/edge-cache.spec.ts` uses a unique allowlisted `/products?view=…` key (a display-only param, so an arbitrary value forks the cache key but still renders a normal 200 grid — unlike `page=`, which 404s out of range) and requires exact `Cf-Cache-Status: MISS → HIT`, with identical `Cache-Control` and baked `X-Robots-Tag` on the HIT. It does **not** assert `Cache-Tag`: Cloudflare consumes that header for purge-by-tag and strips it before the response reaches the client, so it is unobservable at the deployed edge — the per-route tag set is verified in `server.spec.ts` and the local `run-extra-tests.sh` probe (which see the unstripped Worker response).
- **Concurrent PUT/purge storm** — confirm rate-limit resilience.
- **Per-locale cache isolation** — `/products/x` and `/es/products/x` cache independently; per-locale purge doesn't cascade across locales; canonical purge does cascade across all locales.
- **Per-field translation fallback** — entity with partial overlay renders translated fields + canonical fallback for missing fields.
- **`ng extract-i18n` discipline** — every chrome string in templates appears in the extracted XLIFF.

The local HTTP checks run in `deploy.yml` against `dev:bound`; their T7 assertion pins the absence of native-cache headers. The request-only deployed cache spec runs after deployment in `pr-preview.yml` for every first-party PR, using the existing Cloudflare Access service-token headers and no browser download. The full preview-URL E2E jobs in `deploy.yml` remain parked.

### 6.5 Live-auth integration suite in CI (AECI-90; pruned AECI-265)

The `apps/api/src/integration/**` lane talks to a real Supabase service rather than Miniflare. Post-D1 migration (PR #359, AECI-248→257) it holds a **single** spec — `user-auth.jwks.spec.ts`, a live **ES256 JWKS** regression guard for `requireUserAuth()`: it fetches the project's published signing keys over the network (`createRemoteJWKSet`) and verifies a real, freshly-minted access token, so a dashboard signing-key rotation back to HS256 (which would break the production JWKS-only contract) fails the build. Auth is the only thing retained on Supabase (ADR 0015/0016); the application DB is Cloudflare D1. The former Postgres/PostgREST suites this lane was built for — the RLS deny matrices, the auth-user-delete GDPR trigger, the Airtable→Supabase bulk migrate, and the `TEST_DATABASE_URL`-gated recompute/backfill checks — were **deleted in PR #359** (the planned `landing_forms.rls` was never created and the landing lead-capture tables moved to D1, AECI-257), so nothing remains on Supabase **Postgres**. Locally the spec runs via `pnpm --filter @aeci/api test:integration` with `SUPABASE_URL` + a fresh `SUPABASE_TEST_USER_JWT` (mint via `apps/web/scripts/mint-dev-session.mjs`).

In CI the `integration-db-tests` job — its own workflow, `.github/workflows/integration-db-tests.yml` (extracted from `deploy.yml`) — boots a **full local Supabase stack** on the runner (`supabase start`), maps `supabase status -o env` into the env the spec + mint step read (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), mints a `SUPABASE_TEST_USER_JWT` (the local stack issues ES256), then runs the `test:integration:ci` script (the JSON-reporter variant of `test:integration`, without the `dotenv` wrapper). **No repo secrets are required** — the local GoTrue both mints the token and serves the JWKS endpoint, isolated from any shared project. There is no ORM client-generation step: Drizzle needs none, and Prisma was removed from `apps/api` wholesale (AECI-278).

**Silent-skip guard.** Every spec is wrapped in `describe.skipIf(<env unset>)` so the default unit lane stays green without live services. That same guard means a *misconfigured* CI job would *collect* the tests but *skip* them and still exit 0. The job therefore parses the JSON summary and fails on either `numTotalTests === 0` (nothing collected) **or** `numPendingTests > 0` (a `skipIf` fired → env not wired). A green check must mean the JWKS regression guard actually executed — not that it was quietly excluded.

The job is **non-blocking** today (intentionally not in `deploy-staging`'s `needs`); promote it to a required check once it has proven stable.

> **ADR-0016 note (AECI-234).** The reviews/profiles authorization deny-matrix is **not** in this lane. ADR 0016 moved the application DB to Cloudflare D1 (no RLS, no PostgREST), so the reviews/profiles **no-leakage matrix is an app-layer test in the normal unit lane** — `apps/api/src/routes/reviews.authz-matrix.spec.ts` + `profiles.authz-matrix.spec.ts` — composing the real `requireAuth`/`requireAdmin` guard with the real read and write handlers over the in-memory D1 harness (read-leakage cells plus write paths rejecting anon/banned/non-admin before the handler). It runs on every PR (no Supabase boot, not path-gated).

---

## 7. E2E testing — Playwright

End-to-end tests drive a real browser against a deployed preview environment. Highest fidelity, slowest, used for critical user journeys.

### 7.1 Why Playwright over Cypress

- Faster (no constant context-switching between test runner and app)
- Multi-browser support (Chromium, Firefox, WebKit) without extra config
- Better support for SSR apps (handles multi-page navigation cleanly)
- First-class Workers support (can hit `wrangler dev` or deployed previews)
- Parallel by default
- Better debugging tools (trace viewer, time-travel)

### 7.2 What to test

Critical user journeys:

- **Browse and view product** — home → category → product page → all four tabs
- **Search and filter** — search bar → results → faceted filter → result click
- **Review submission** — product page → login (mock auth) → review form → submit → confirmation
- **Vendor request submission** — product page → "Is this your product" → form → submit
- **Account deletion** — login → account → delete → confirmation → verify reviews anonymized
- **Theme switching** — toggle → verify CSS variables change → reload → persistence

Anything that crosses multiple components or pages is a candidate for E2E.

**Phase 3.12 implementation (AECI-145).** The "search → results → faceted filter → result click" journey is covered on the **API-backed listing path** (`apps/web/e2e/facets.spec.ts`): the AECI-143 facet sidebar on `/products` (facet click → `{kind}_id` + `page=1` in the URL, checkbox state, grid refresh, Clear-filters reset), the locked-kind sidebar on `/categories/:slug` (hides its own dimension), and the deterministic refine → product-card click → detail `<h1>` chain. This is the CI-runnable embodiment of the journey because **`/search` itself degrades in CI** — `dev:bound` boots without Algolia, so the InstantSearch results never render. The live `/search` box → hits → click → detail flow therefore lives in a **self-skipping block** in `search.spec.ts`, guarded on the `window.__AECI_ALGOLIA__` bootstrap (runs locally/preview with search creds, skips in CI). **Cache-key correctness** ("distinct facets → distinct cache entries") is proven by a unit test on the exported `cacheKeyFor()` (`cache-key-url.spec.ts`; it replaced `cacheKeyUrl()`, which WC-3 / AECI-317 removed with the manual `caches.default` pipeline and WC-4 / AECI-318 restored behind the gateway entrypoint) — HIT/MISS is unobservable on localhost (Miniflare ≠ Cloudflare edge) — with `facets.spec.ts` asserting the complement at the wire: distinct facet URLs are independently cacheable yet share one `Cache-Tag` (facets live in the key, not the tag).

`cache-key-url.spec.ts` is the same proof for every later content-affecting param, and AECI-303 added the product-PAIR page's two version selectors to it. Two of those cases are worth knowing about because they guard against a *plausible* future change rather than a typo: one asserts that swapping the two values yields a **different** key (the pair is ordered), and one asserts a comma inside a version label survives verbatim — together they fail any attempt to add `context_version`/`other_version` to `MULTI_VALUE_CACHE_KEY_PARAMS` "for consistency", which would corrupt a legitimate `R2024,SP1` label rather than merely fragment the cache.

**The product-PAIR page's own e2e** (`apps/web/e2e/products-pair.spec.ts`, AECI-303) follows the `search.spec.ts` self-skipping shape for the same reason: the §9 selectors only render for a pair with version-stamped attestations, and no environment has one (promote does not ingest versions; the only writer is the Verified-vendor API). The default-path cases run everywhere; the interaction block probes for a non-null `version_diff` and skips when there is none. `pnpm --filter @aeci/api db:seed:version-diff:local` is the reproducible local input that makes it run, and is deliberately **not** part of `db:seed:local` so every other pair page keeps showing the launch-reality default. The pair page also gained its first row in `phase2-a11y.spec.ts` — it had none, which is how the design checklist's axe step went unenforced in CI for the surface that owns the claim lanes.

### 7.3 What not to test in E2E

- Things already covered by unit/component tests
- Edge cases of form validation (use component tests instead)
- Pure CSS/visual concerns (use visual regression)

### 7.4 Pattern

```typescript
import { test, expect } from '@playwright/test';

test('user can search and find a product', async ({ page }) => {
  await page.goto('/');

  await page.fill('[data-testid="search-input"]', 'Procore');
  await page.press('[data-testid="search-input"]', 'Enter');

  await expect(page).toHaveURL(/\/search\?q=Procore/);
  await expect(page.getByText('Procore', { exact: false })).toBeVisible();

  await page.click('text=Procore');

  await expect(page).toHaveURL(/\/products\/procore/);
  await expect(page.getByRole('heading', { name: 'Procore' })).toBeVisible();
});
```

### 7.5 Test data

- The local/preview environment uses a fixed seed data set in D1
- Tests assume seed data exists (Procore, Autodesk, etc.)
- Seed data lives in `apps/api/seed/*.sql` and is applied to the local D1 via `pnpm db:seed:local` (`db:setup:local` migrates + seeds)

### 7.6 Auth in tests

Magic link doesn't work in E2E (real email), and there is **no** `TEST_MODE`/`?test_user=`
bypass — the API Worker verifies a real Supabase JWT against the project's JWKS on every
request (`apps/api/src/lib/authz.ts`), so the only way an auth-gated page renders its real
content is a real session. Two postures, by what the page needs:

- **Cookie-presence + API stubs** — for pages whose SSR gate is only a cookie *presence*
  check and which fetch their data **client-side** (`/account`, `/products/:slug/review`):
  a dummy `sb-…-auth-token` cookie passes the gate and `page.route()` stubs the
  `/api/*` reads. See `account-delete.spec.ts` / `reviews-submission.spec.ts`. Deterministic,
  no secrets — but it never exercises a real signed-in hydration (the client's
  `@supabase/ssr` `getSession()` sees no real session) and **cannot** cover the admin pages.
- **Real minted session** — for pages that authorize **server-side inside the SSR Worker**
  (`/admin`, `/admin/reviews`: `adminSummaryResolver` → `GET /api/admin/summary`, a
  service-binding call `page.route()` can't intercept). `apps/web/e2e/auth-session.ts`
  mints a session with the `@supabase/ssr` capture-jar recipe (the same one
  `apps/web/scripts/mint-dev-session.mjs` prints) and hands Playwright the real cookies.

**Authed console-health (AECI-235, Spec §15.15).** `apps/web/e2e/authed-console.spec.ts` is
the Phase 5 analogue of the AECI-162 console crawler: it visits the four auth-gated pages
(`/account`, `/admin`, `/admin/reviews`, `/products/:slug/review`) with one minted **admin**
session (admin is also an authed user, so it covers all four) and asserts zero console
`error`/`pageerror` via the shared, single-sourced `console-capture.ts` helpers (warnings
stay reported-not-gated). It **skips when unconfigured** (no anon key / no
`SUPABASE_TEST_USER_*` creds / sign-in fails), matching `auth-whoami.spec.ts`. To run it the
test user must be `test@thewbsproject.com` (an admin account in the shared Supabase project)
and its `role='admin'` D1 profile must exist — seeded automatically by `dev:bound` →
`db:seed:local` (`apps/api/seed/auth-fixtures.sql`, keyed to that account's Supabase user
id; update both together if the account is recreated). Env is
read from `process.env`; locally `playwright.config.ts` hydrates the four `SUPABASE_*` keys
from `apps/web/.dev.vars`, and in CI they come from the Playwright step `env:` in
`deploy.yml` (warn-and-skip when the secrets are absent). Remaining manual step to activate
it in CI: set the `SUPABASE_TEST_USER_EMAIL` / `SUPABASE_TEST_USER_PASSWORD` GH secrets.

### 7.7 Cross-browser & real-device — BrowserStack (Phase 7.8 — shipped, AECI-154)

The `projects` list above is **chromium-only** by design — cross-browser/mobile is handled by a separate **BrowserStack** (real-device cloud) lane, recorded in **ADR 0012** (**Accepted**) and shipped in Phase 7.8 (AECI-154). The lane:

- Fans the *existing* Playwright suite out to **BrowserStack Automate** via `browserstack-node-sdk` + `apps/web/browserstack.yml`, running a **curated cross-browser smoke subset** — critical **read-only render journeys only** (`smoke`, `home`, `products-detail`, `search`, `facets`), not the full suite (parallel-session quota). The selection lives in `apps/web/playwright.browserstack.config.ts` (`testMatch`); the mutating journeys (auth / review-submission / account-delete) stay on the local chromium lane.
- Matrix (`apps/web/browserstack.yml`): **real iOS Safari** + **real Android Chrome** (the gap local WebKit can't reproduce — bundled WebKit ≈ Safari, not the real engine), plus desktop Safari, Firefox, Edge.
- Runs as a **separate, non-blocking** workflow — `.github/workflows/browserstack.yml`, triggered **post-merge** (`workflow_run` after the `deploy` workflow succeeds) + `workflow_dispatch` + a weekly schedule, against **deployed staging**. It is never in any deploy `needs:`, so the fast PR lane (unit / component / integration / chromium-E2E / axe) stays fast, free, and keeps gating merge.
- Reaches Access-gated staging over the public internet with the CF Access **service-token headers** (`CF-Access-Client-Id` / `CF-Access-Client-Secret`, sent via Playwright `extraHTTPHeaders`) — **no BrowserStackLocal tunnel**; `demo.aecintegrations.com` is public and needs none.
- **Inert until provisioned:** the lane **skips green** (does not gate, does not fail) until the personal-subscription secrets `BROWSERSTACK_USERNAME` / `BROWSERSTACK_ACCESS_KEY` are set (`gh secret set …`). The real iOS Safari row requires the **Automate** product specifically.
- A BrowserStack **MCP server** (`@browserstack/mcp-server`) is also wired for ad-hoc real-device checks during UI work — that part is *not* CI.

---

## 8. Accessibility testing — axe-core

### 8.1 Setup

`@axe-core/playwright` package plugs directly into Playwright.

```typescript
import AxeBuilder from '@axe-core/playwright';

test('home page has no accessibility violations', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
```

### 8.2 Coverage

Run axe on:
- Home page
- Product page (each tab)
- Vendor page
- Integration page
- Search results
- Login page
- Review submission form
- Legal pages
- `/admin/traffic` — **in `authed-console.spec.ts`, not a public spec** (AECI-578). The
  admin surface authorizes server-side, and the charts do not exist until the
  authorized `afterNextRender` reads resolve, so an axe run on the unauthenticated
  route would only ever audit the loading state. That spec is the one place with a
  real minted session; it waits for the stat tiles before analyzing.
- `/vendor/:vendorSlug/integrations` — the **Integrations section**, in
  `vendor-dashboard.spec.ts` (AECI-606), for the
  same reason and with the same shape: it authorizes server-side via
  `vendorMeResolver`, and its cards, claim lanes and Aria pickers do not exist
  until `GET /api/vendor/integrations` lands. That spec mints the
  `vendor_admin` persona and waits for the first integration card (or the empty
  state) before analyzing. It is the most interactive vendor-facing surface, so
  this is the run that covers the combobox/listbox wiring end to end — the unit
  specs deliberately never open a CDK overlay (§4.3a), **with one carve-out, below.**
- `/preview/vendor-dashboard` — the **portal nav and its Products dropdown**, in
  the new `preview-vendor-portal-nav.spec.ts`
  (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.4). Two runs, **closed and open**, because a
  new always-present nav dropdown is exactly the kind of change that invalidates a
  prior pass, and an empty `role="listbox"` (`aria-required-children`) only exists
  in the open state. It runs on the PREVIEW route deliberately: that surface mounts
  the same shell and section routes with fixture data and **no session**, so unlike
  `vendor-dashboard.spec.ts` it does not skip-green in CI — and its path contains no
  `/vendor/` segment, so the zone WAF cannot 403 it. Open the panel with the
  **keyboard**, not a click: a click moves the pointer over the host first, which on
  a hover-opening neighbour toggles it back shut (`phase2-a11y.spec.ts` records the
  same workaround).
  - **The carve-out to "unit specs never open a CDK overlay":**
    `vendor-products-menu.component.spec.ts` does, and can. Opening `AecSelect`
    means going through Aria's own combobox toggle and its activedescendant commit,
    which is jsdom-hostile; opening this one is a plain `<button>` click writing a
    plain signal into `cdkConnectedOverlayOpen`, and under jsdom there is no Popover
    API so CDK downgrades `usePopover` to the body-level `.cdk-overlay-container`
    (query `document`, not the host, and sweep the container in `afterEach`). What
    stays e2e-only is unchanged: Aria's ArrowDown → `aria-activedescendant` → Enter
    commit, a real outside click, and real focus order out of the top layer.
  - **The live region is no longer part of that subtree** (AECI-631 /
    `STAGE_2_REALTIME_SPEC.md` §6.3). The portal has exactly ONE **persistent**
    polite live region, and it now lives in the dashboard SHELL — an `sr-only`
    `<p role="status">` fed by `VendorPortalAnnouncer`
    (`apps/web/src/app/vendor/vendor-announcer.ts`) — so it is present from first
    paint on every section, not just after the integrations read. It is declared
    **once per dashboard concept**:
    `apps/web/src/app/vendor/vendor-dashboard-tabbed.ts` (Concept A, what the
    portal renders) and `apps/web/src/app/vendor/vendor-dashboard-single.ts`
    (Concept B, preview-only — it composes the same integrations section, which
    announces through the channel and declares no region of its own, so without
    it every attestation write on Concept B is silent). Only one concept ever
    renders at a time, so they cannot race. Two consequences for this run: the
    axe pass must be **re-run after the hoist** (a region moving is exactly the
    kind of change that invalidates a prior pass), and any assertion about it
    should be made on the shell rather than on the section body. Since the
    sections became child routes (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2) the shell
    is the layout route's component, so the region is the **same DOM node** across
    a section navigation — `vendor-dashboard-tabbed.component.spec.ts` asserts
    node identity, which is a stronger claim than "there is still exactly one".
    The section's loading/failure paragraphs and the integration card's pivot
    notice are deliberately **not** live regions — two regions on one page make
    announcements race — so a second **persistent** `[role="status"]` appearing
    under the portal is a regression, not an addition. `aria-busy` covers the
    loading state.
  - **Assert on `[role="status"].sr-only`, not on `[role="status"]`.** The
    announcement channel is the only `sr-only` one; three *conditional*
    `role="status"` paragraphs also exist in the vendor tree (the profile and
    product "Saved" confirmations and the add-claim form's duplicate-lane
    notice), so a bare `getByRole('status')` matches more than one element as
    soon as any of them renders and trips Playwright's strict mode. That is not
    hypothetical — it broke two pre-existing assertions in
    `vendor-dashboard.spec.ts` the moment the region was hoisted, and shipped
    green only because the spec skips without `SUPABASE_VENDOR_TEST_USER_*`.
    Those three are **legitimate** under the corrected §6.3 rule
    (`STAGE_2_REALTIME_SPEC.md`): a local `role="status"` is allowed for
    immediate feedback on an action the user just took, beside the control they
    took it with, provided it never fires for an event the channel also
    announces. A fourth — the attestation control's divergent-slots notice — was
    a real violation (standing state, movable by a background poll, on the tab
    that announces) and had its role removed on 2026-08-19. **axe cannot see
    this class at all** (multiple live regions are valid ARIA), which is why the
    count assertion lives in the e2e spec rather than being left to the a11y
    pass — and why the three survivors still owe a manual screen-reader pass
    under a live revalidation (`docs/a11y-manual-testing-checklist.md`).

Run in the light theme (Stage 1 is light-only — AECI-226).

**Charts need an assertion axe cannot make.** `role="img"` renders its subtree
presentational, so a data table nested *inside* a chart's `role="img"` element is
invisible to a screen reader while remaining perfectly valid markup — axe reports
nothing. `chart-a11y.component.spec.ts` asserts the placement (and each chart's
table contents against its series) for every chart type, which is the half of the
§8 accessibility rule the automated pass structurally cannot cover.

**Phase 2 implementation (AECI-65).** `apps/web/e2e/phase2-a11y.spec.ts` runs axe against every live Phase 2 page type — product/vendor/integration index+detail, category/audience/phase browse, the three flat taxonomy indexes (`/categories`, `/audiences`, `/phases`), and the 404 — in the **light theme** (13 URLs; the dark pass was removed in AECI-226), plus the open state of the AECI-155 taxonomy flyout nav. Detail pages run against committed fixtures (`apps/api/seed/phase2-fixtures.sql`, seeded into the local D1 by `dev:bound`); they self-skip if the fixtures aren't seeded so the suite never wedges CI. Both the header (incl. the new flyout nav) and the **footer** are in scope: the footer's former `.exclude('aec-site-footer')` carve-out covered dark-theme contrast debt only, and AECI-226 removed it after verifying the footer is WCAG-AA clean in the (now sole) light theme.

**Phase 3.12 implementation (AECI-145).** `/search` axe coverage (zero WCAG-AA violations) ships in `apps/web/e2e/search.spec.ts` — against the graceful-degradation shell that renders in CI, where Algolia is absent. The `/products` listing + facet sidebar is covered by `products-index.spec.ts` (`tags wcag2a/2aa/21a/21aa`); the facet-interaction states add no new always-on surface beyond what those axe runs already scan.

### 8.3 Severity threshold

Block PR merge on any `serious` or `critical` violations. Warn (but don't block) on `moderate`. Ignore `minor`.

The Phase 2 success-path suite (AECI-65, above) is stricter: it asserts **zero violations at WCAG-AA** (tags `wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa`) on every page type — any such violation fails the run.

Some violations are unfixable in third-party code; maintain an explicit allowlist with documented reason for each.

---

## 9. Visual regression — Playwright + Chromatic

### 9.1 Approach

Playwright takes screenshots of key pages and components. Chromatic hosts them and shows visual diffs in PRs.

### 9.2 What to snapshot

- Home page
- Product page hero
- All Spartan UI components in the design system (button, card, input, dialog states)
- Empty states ("be the first to review", no search results)
- Error states (404, validation error)

### 9.3 Cost management

Chromatic free tier covers ~5,000 snapshots/month. Avoid snapshotting every page in every test. Curate to a focused set.

### 9.4 Approval flow

Visual diffs appear as a check on the PR. Reviewers approve or reject visual changes inline in Chromatic's UI. Once approved, the new baseline is committed.

### 9.5 Why not Percy (BrowserStack)

BrowserStack's visual tool, **Percy**, overlaps Chromatic directly. **Do not run both.** Phase 7.8 (AECI-154) shipped the BrowserStack **Automate** *functional* cross-browser lane (§7.7) **without Percy** — Percy was evaluated and deliberately not adopted. Chromatic stays the visual-regression tool (above); Percy is only worth revisiting if cross-*real*-browser visual diffs become a requirement, in which case it consolidates billing under BrowserStack alongside the cross-browser lane (ADR 0012, AECI-154).

---

## 10. Performance testing — Lighthouse CI

### 10.1 Budget enforcement

Lighthouse CI runs post-merge against a local `dev:bound` server (see §10.4). Performance budget and enforcement as of AECI-188 (the gate is the post-merge [`lighthouse.yml`](../.github/workflows/lighthouse.yml) run going red — Lighthouse does not run on PRs):

| Metric | Threshold | Action |
|---|---|---|
| Accessibility score | ≥ 95 | **Error** (red post-merge run) |
| Best-Practices score | ≥ 90 | **Error** (red post-merge run) |
| SEO score (indexable pages) | ≥ 90 | **Error** (red post-merge run) |
| TBT | ≤ 200ms | **Error** (red post-merge run) |
| `/search` TTFB (`server-response-time`) | ≤ 600ms | **Error** (red post-merge run) |
| Performance score | ≥ 90 | Warn (perf follow-up; see §10.4) |
| LCP | ≤ 2.5s | Warn (perf follow-up; see §10.4) |
| CLS | ≤ 0.1 | Warn (perf follow-up; see §10.4) |
| JS transfer (detail pages 200 KB; `/search` see §10.5) | per class | Warn (perf follow-up; see §10.4) |

(INP isn't lab-measurable — TBT is its Lighthouse proxy.)

### 10.2 Bundle size budget

Separate from Lighthouse but enforced in the same pipeline.

| Asset | Budget | Threshold |
|---|---|---|
| Main JS bundle (gzipped) | < 200 KB | hard fail |
| Initial CSS (gzipped) | < 30 KB | hard fail |
| Total page weight (gzipped, home page) | < 500 KB | hard fail |
| Worker bundle (uncompressed) | < 5 MB warn, < 10 MB hard fail | Cloudflare's hard ceiling is **10 MB**; warn at 5 MB to give headroom for locale additions |

Use `size-limit` or `bundlewatch` to enforce the JS/CSS budgets in CI. For the Worker bundle, mirror the snapshot pattern in `apps/web/scripts/run-extra-tests.sh` (T7): print `dist/server/` size on every build, warn over 5 MB, fail over 10 MB. The 10 MB ceiling is enforced by Cloudflare at deploy time anyway, but failing in CI catches it earlier with a clearer error.

### 10.3 Pages tested

- Home (`/`)
- Product page (`/products/procore`)
- Vendor page (`/vendors/procore-technologies`)
- Search results (`/search?q=Procore`)

Mobile and desktop profiles separately.

### 10.4 Phase 2 implementation status (AECI-65)

Lighthouse CI is wired in its own [`lighthouse.yml`](../.github/workflows/lighthouse.yml) workflow (push-to-main only) and runs **mobile** (simulated Slow-4G throttle, median-of-3) against **every Phase 2 page type** on a local `dev:bound` server — not a deployed preview — using the committed fixtures (`apps/api/seed/phase2-fixtures.sql`, seeded into the local D1 by `dev:bound`). The URL set and assertions live in [`.lighthouserc.cjs`](../.lighthouserc.cjs).

Budgets follow `STAGE_1_PHASE_2_SPEC.md` §12 (scores ≥ 90 for Performance / Accessibility / Best-Practices / SEO; LCP ≤ 2.5s; CLS ≤ 0.1; detail-page total JS transfer ≤ 200 KB). Per-URL handling: the JS budget targets detail/browse pages only; the `noindex` 404 is exempt from the SEO score.

> **Posture: partial error gate (AECI-188).** The warn→error flip landed **partially**, driven by what every page actually passes today: Accessibility / Best-Practices / SEO / TBT (+ the `/search` TTFB, §10.5) assert at `'error'` — `lhci autorun` exits 1 on a miss and the post-merge `lighthouse.yml` run goes red — while Performance / LCP / CLS / the JS-transfer budgets stay `'warn'` because multiple pages measurably miss them (per-page numbers recorded on the perf follow-up issue referenced in `.lighthouserc.cjs`). The remaining flip is gated on fixing those misses — **budgets are not lowered to pass** (AECI-65's rule). Note the gate is post-merge, not merge-blocking: a red run means `main` already regressed; fix forward or revert. The §10.1 table reflects the enforced levels.

### 10.5 Search route (AECI-145 / Phase 3.12)

`/search` is in `.lighthouserc.cjs`'s collection (15 URLs total). It differs from every Phase 2 page on two axes, handled by two assertion classes:

- **`noindex`** — like the 404, its SEO audit fails by design. AECI-146 grouped `/search` with the 404 in the **noindex class** (matched by `NOINDEX_URL_PATTERN`): perf/a11y/CWV only, **SEO-exempt** (excluded from the indexable class's `categories:seo`).
- **No-cache (always an edge MISS)** — `/search` is `private, no-store`, the one route that never serves from an edge HIT. AECI-145 adds a `/search`-only class with a **MISS-only TTFB budget** (`server-response-time ≤ 600ms`, error-level since AECI-188) rather than inheriting cached-page timing assumptions. The threshold is Lighthouse's own native pass bar and measures the SSR-shell document fetch on `dev:bound` — the document itself involves no Algolia round-trip (InstantSearch loads browser-side) — not production search latency.

`/search` does **not** match the detail/browse URL pattern, so it correctly skips the 200 KB JS budget — InstantSearch ships more than a detail page. Instead it carries its **own JS-transfer budget** (AECI-188; ceiling recorded in `.lighthouserc.cjs`, measured against the real SDK). To make that measurement meaningful, `lighthouse.yml` provisions the shared search key (`ALGOLIA_SEARCH_KEY`, which must cover the `preview_*` indexes) into `apps/web/.dev.vars`, so CI's `/search` boots real InstantSearch against the `preview_*` indexes rather than the degraded shell — and hard-fails if the key is missing. `?q=…` is intentionally not collected: the empty-query page already loads the full SDK + widgets, and a pinned query would couple the budget to index contents. Enforcement: a11y + TTFB at `'error'`; perf/CWV + the JS budget stay `'warn'` (§10.4).

---

## 11. Smoke tests

A subset of E2E tests run after every deploy to staging and production.

### 11.1 Scope

The "site works at all" check:

- Home page renders with 200 status
- Product page renders for a known slug
- Search returns results
- Login page renders
- Static legal pages render
- API health check returns ok

Should complete in under 2 minutes. Run sequentially against the deployed URL.

### 11.2 Failure handling

- Staging: notify Slack, no auto-rollback
- Production: auto-rollback to previous deployment, urgent Slack alert, page Chris

---

## 12. Load testing — k6

### 12.1 When

Pre-launch, and any time a major architectural change ships. Not a continuous CI concern.

### 12.2 Targets

Verify the site handles expected launch traffic:

- 100 concurrent users browsing pages
- 10 reviews/minute submission rate
- 50 search queries/second

Verify:
- p95 latency stays under SLO (2 seconds)
- Error rate stays under 1%
- Algolia, Supabase, and the telemetry intake all stay healthy
- Cache hit rate above 60% on cacheable pages

### 12.3 Run target

Against staging, never production. Run after a known-good baseline run; compare results to detect regressions.

---

## 13. Test data management

### 13.1 Unit/component tests

Use fixtures or factories defined in `src/test/fixtures/`. Don't share fixtures across tests — each test owns its own data setup.

### 13.2 Integration tests

Use Miniflare's in-memory storage. Reset between tests.

### 13.3 E2E tests

Run against a preview environment with seed data applied. Seed data is the same across all preview deployments — a known, stable dataset.

If a test needs to create data (e.g. submit a review), it creates it with a unique identifier (test-{timestamp}) so it doesn't conflict with other concurrent test runs.

A nightly job cleans up test-created data from preview Supabase to prevent buildup.

---

## 14. Flaky tests

### 14.1 Definition

A test is flaky if it fails intermittently without code changes. Flaky tests are a serious problem — they erode trust in CI.

### 14.2 Policy

- A test that fails twice in a row in `main` is flagged
- After 3 unrelated failures in `main`, the test is **disabled** and a Linear issue created to investigate
- The test author or owner has 1 sprint to fix or delete it
- Disabled tests are tracked in a `KNOWN_FLAKY.md` file in the repo
- New flaky tests block PR merge — they don't get to land

This is strict but necessary. Tolerating flakiness leads to compounding pain.

---

## 15. Coverage exceptions

Files exempt from coverage requirements:

- Configuration files (`*.config.ts`)
- Type-only files (`.d.ts`, `types.ts`)
- Generated migration SQL (drizzle-kit output under `apps/api/migrations/`)
- Storybook stories
- Test utilities themselves

Defined in `vitest.config.ts` `coverage.exclude`.

---

## 16. Setup tooling

### 16.1 Dependencies

```json
{
  "devDependencies": {
    "vitest": "^2.0.0",
    "@analogjs/vitest-angular": "latest",
    "@testing-library/angular": "^17.0.0",
    "@playwright/test": "^1.45.0",
    "@axe-core/playwright": "^4.9.0",
    "@chromatic-com/playwright": "latest",
    "@lhci/cli": "latest",
    "miniflare": "^3.0.0",
    "size-limit": "latest",
    "@size-limit/preset-app": "latest"
  }
}
```

### 16.2 Scripts

```json
{
  "scripts": {
    "test": "pnpm run test:unit && pnpm run test:e2e",
    "test:unit": "vitest run",
    "test:unit:watch": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:a11y": "playwright test --grep @a11y",
    "test:visual": "playwright test --grep @visual",
    "test:smoke": "playwright test --grep @smoke",
    "test:coverage": "vitest run --coverage",
    "test:size": "size-limit"
  }
}
```

---

## 17. Future considerations

### 17.1 When team grows

- Add merge queue serialization
- Add explicit test ownership per directory (CODEOWNERS)
- Consider Storybook for component documentation + visual regression

### 17.2 When data scales

- Property-based testing for data invariants (fast-check)
- Contract testing between services (Pact) if Stage 2 introduces external integrations

### 17.3 When traffic scales

- Continuous load testing in staging
- Performance regression alerts (Datadog today; build new ones on PostHog — ADR 0024)
- Real User Monitoring SLO breach alerts

Not pursued in Stage 1.
