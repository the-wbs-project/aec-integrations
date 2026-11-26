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

## Crawler-visibility checks (AECI-746)

Some defects are invisible to every browser-driven test by construction. AECI-746
was one: `/products` and the taxonomy browse pages rendered correctly once
JavaScript ran, and shipped an error document to anything that did not — which is
every crawler on its first pass. A `page.goto()` test passed throughout.

Two guards, and they are different in kind:

| Guard | What it is | When it runs |
|---|---|---|
| `apps/web/e2e/ssr-listing-crawlability.spec.ts` | Playwright, using the **`request`** fixture (raw HTTP, no JavaScript) to assert product links exist in the server HTML | every e2e run |
| `scripts/check-ssr-listings.sh <base-url>` | One-command `curl` check over five listing pages. Exit **1** on any dead end, including a non-200; exit **2** if a page never answered; exit **0** only when all five were seen and all five shipped links. Sends the Access service token when `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` are set, and fails a page that redirects off-host. Fixture-tested by `scripts/check-ssr-listings.test.mjs` (`pnpm test:scripts`) | every promote, against the host just deployed: the blocking post-smoke step in `promote-to-demo.yml` and `promote-to-prod.yml` (AECI-840). Also by hand, against any deployed env |

**The e2e spec must keep using `request`, never `page`.** Rewriting it onto the
`page` fixture would make it pass unconditionally and test nothing.

**A non-200 is a FAIL in both guards, and that is the point.** The spec asserts
`response.status()` explicitly. The script did not, until AECI-753: `curl -f` collapsed
403, 404 and 5xx into the same empty body as a network timeout, the script called that a
SKIP, and a run with `/products` challenged by the WAF printed `RESULT: PASS` and exited
**0**. A gate that goes green when it could not see the page converts "unknown" into
"verified", which is worse than having no gate. Do not reintroduce a non-fatal skip in
either guard.

**Neither guard is meaningful against local `wrangler dev`** for this particular
failure: the relative `/api/...` URL resolves to `localhost` there and works, so
local passes with and without the bug. Run the script against staging or
production. This is a rare case where the local environment is not a faithful
reproduction, and it is why the defect survived for months.


## 2. Test layer overview

| Layer | Tool | Runs against | Speed | When |
|---|---|---|---|---|
| Unit | Vitest | Pure functions, isolated components | Fast (~ms) | Every PR |
| Component | Vitest + Angular Testing Utilities | Single component, mocked deps | Fast (~10ms) | Every PR |
| API contract | Vitest + Zod assertions | Mock fetch against schemas | Fast | Every PR |
| Integration | Vitest + Miniflare | Worker code with real Workers runtime | Medium | Every PR |
| E2E | Playwright | Local `dev:bound` server | Slow (~30s/test) | Every PR |
| Accessibility | axe-core via Playwright | Local `dev:bound` server | Medium | Every PR |
| Accessibility nightly | Playwright: the `e2e-a11y/` suite, and the e2e suite with the axe sweep on (§8.4) | Local `dev:bound` server | Slow (8 + 4 shards) | Nightly on `main`, never on a PR |
| Visual | Playwright screenshots + Chromatic | Deployed environment | Medium | Every PR |
| Performance | Lighthouse CI | Local `dev:bound` | Slow (~6 min, 3 shards) | Nightly + demo promote gate (§10.4) |
| Smoke | Playwright (subset) | Staging, production | Medium | Post-deploy |
| Load | k6 or similar | Staging | Slow | Pre-launch, rarely |

> **"Every PR" means *every* PR — any base branch.** `deploy.yml` and `integration-db-tests.yml`
> carry no `branches:` (base-branch) filter on their `pull_request` trigger, so a PR into
> `stage-2`, `admin-panel`, or an epic branch runs the same lanes as a PR into `main`. This was
> **not** true before 2026-08-14: both were pinned to `branches: [main]`, which filters by base
> branch, so under the ADR 0019 branch model this table over-claimed for most PRs in flight —
> the ~13k-line AECI-513 epic merged into `stage-2` having run none of it. Two rows carry their
> own caveats regardless of base: **Performance** (Lighthouse) never runs on PRs. It runs nightly
> and as the demo promote gate (`lighthouse.yml`, §10.4). And **Visual** (Chromatic) is not wired at all.
> `CICD_PLAN.md` §3.1 has the full rationale. `main` is branch-protected on three required
> contexts, so a red `Lint & typecheck` / `Unit tests` / `Build SSR Worker` blocks the merge (§8).
> `main` is now the only branch. `stage-2` merged 2026-09-03 and `admin-panel` merged 2026-08-14,
> and both are retired, so there is no longer an ungated long-lived base to worry about.

### 2.1 Type-checking `apps/web`

`apps/web` has a `typecheck` script (AECI-1652): `tsc -p tsconfig.spec.json --noEmit`. It covers the
spec + e2e graph and runs in the `Lint & typecheck` CI lane through the root
`pnpm -r --if-present run typecheck` fan-out. App code is still type-checked by `ng build` in CI
(the Build SSR Worker lane); to check it by hand, run from `apps/web`:

```bash
./node_modules/.bin/tsc -p tsconfig.app.json
```

Use the package's own `tsc`. A bare `npx tsc` at the repo root resolves a decoy package that prints
a message and exits 0. `tsconfig.app.json` sets `noEmit: true` (AECI-1394), so the command writes
nothing. Without it, TypeScript 6 stops with TS5011 (no `rootDir`) and leaves an `out-tsc/` tree.
`out-tsc/` is in the ESLint and Prettier ignores in case a spec tsconfig run still writes one.
`tsconfig.spec.json` was clean as of AECI-1652 (2026-11-11). Before that it carried an unseen error
baseline (56 errors on 2026-10-26, 65 at fix time, mostly TS2307 on `.md` content imports because
`src/markdown.d.ts` was not in the program). The lane gates it now, so a new error fails CI rather
than piling up unseen.

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

Coverage is measured with Vitest's built-in **v8** provider (each package's `vitest.config.ts` records these numbers in its `thresholds` block). CI generates the report on every **push** to `main`. Since 2026-10 the unit jobs run each suite **once** with coverage on, with the thresholds zeroed on the command line so only a test failure fails the job. Since AECI-1709 (2026-11) apps/api runs as two `unit-api` shards (`--shard=N/2`) that each write a vitest blob report, and `unit-api-coverage` merges them into one coverage report with `vitest run --merge-reports --coverage`. One unsharded coverage run had starved the vitest main process until a worker RPC timed out, which vitest counts as a failure with every test green (`docs/CICD_PLAN.md` §3.1). `scripts/ci/coverage-advisory.mjs` then compares the totals with each config's `thresholds` and raises a warning annotation on a miss. The lcov/HTML uploads as the `coverage-api` and `coverage-web` artifacts. A coverage drop **does not fail the build** (`docs/CICD_PLAN.md` §3.1). Since **AECI-917 (2026-09-14) it no longer runs on PRs**, where it cost ~2 min of the required `unit-tests` check to produce a report nobody read per PR. Note also that `apps/web`'s `test:coverage` is the plain vitest suite, so the `ng test` component specs are **not** measured. The thresholds are a documented target, not a merge gate: quality of tests matters more than the number. There is no Codecov integration today; if one is added later it would be for visualization, not enforcement.

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

Three ship with the Stage 2 entitlement model (`docs/STAGE_2_PAID_TIERS_SPEC.md` §10), and they are the reference shape. The fourth, on-page ordering, joined in AECI-1814:

| Test | Asserts | Why a test and not a comment |
|---|---|---|
| **Ranking disjointness** (`packages/shared/src/entitlements.spec.ts`) | The capability vocabulary and the union of every Algolia `searchableAttributes` ∪ `attributesForFaceting` ∪ `customRanking` are **disjoint sets**; no capability id matches a ranking-word regex; no entitlement concept (`verified`, `tier`, `entitlement`, `paid`, `plan`, …) appears in `INDEX_SETTINGS` at all | **No pay-for-placement** is the product's founding promise. Both tables are pure data in the same package, so the promise is *provable* — this is the one place a documented principle became an asserted property. It carries its own **non-vacuity** case (the ranking vocabulary is non-empty, and the `unordered()`/`desc()` wrappers really were stripped), because a broken strip helper would make every assertion below it pass trivially. **Since AECI-636 it also proves a computed attribute's inputs:** `listing_tier`'s declared inputs name no plan concept, and a recording `Proxy` shows the functions read nothing else, because a computed attribute can carry a plan while its own name stays clean. **Since AECI-1214 it also proves the edit path:** every `listing_tier` input is either not vendor-editable or written by a field whose capability (`PRODUCT_FIELD_CAPABILITIES` / `VENDOR_FIELD_CAPABILITIES`, the tables the vendor routes enforce) the Free tier holds, so no plan is needed to raise a listing's tier. **Since AECI-1181 (2026-10-02) it also proves a review reply never ranks:** block 6 asserts that no Algolia attribute, record field, sort key or `listing_tier` input names the reply table or its fields, and `apps/api/src/lib/review-reply-ranking-firewall.spec.ts` scans the files that compute ranking inputs for them (`STAGE_2_PAID_TIERS_SPEC.md` §3.2 assertion 6) |
| **Mirror sole-writer** (`apps/api`, over the batch builders) | `grantSeatStatements` — and every route handler — emits **no statement touching `vendors.verified`**; only `lib/license.ts` does (it was `lib/vendor-entitlement.ts` until AECI-1358 deleted it), and never one side of the *iff* without the other. Plus: `vendors.updated_at` moves **iff** `vendors.verified` moves, in **both** directions | The ESLint sole-writer rule catches the syntax; this catches the semantics the rule cannot see. The both-directions clause exists because the un-verify direction had no writer at all until AECI-532, so nothing had ever exercised it |
| **Reads are never gated** (`apps/api`) | `GET /api/vendor/me` returns **200** for a vendor whose entitlement is `revoked`/`expired`, carrying the downgraded `entitlement` block | A one-line mistake with total blast radius on exactly the cohort being billed: `vendorMeResolver` maps 403 onto a **404 render**, so gating this read would hide the renewal notice inside a 404 dashboard |
| **On-page ordering** (`apps/api/src/lib/on-page-ordering-firewall.spec.ts`, `apps/web/src/app/products/on-page-ordering-firewall.spec.ts` and its `.component.spec.ts`; AECI-1814) | The registered on-page sorts, default orders and featured subsets do not move when a Managed-only input changes. The Managed-only capabilities are derived from `TIER_CAPABILITIES`. Behavioural cases set every non-order field rising and falling along the fixture, and load every paid input onto one group at a time, on fixtures with a tie at every comparator level. They cover the product page lanes, its filter and the 20-row `@defer` cut (the table view only since AECI-1891), the connector page hubs, and the pair page and `related_products` over the D1 harness, where the page product carries the paid inputs too. A component spec renders the product page Integrations section, where no filter selected must mean every row renders, the product page Similar products section (AECI-1785), which must keep the API order and every card, and the taxonomy index's "Most products" sort, on terms that tie on every declared input. Every row field is classified as an order input or not, so a new field fails until someone decides. Three source scans are tripwires, not proofs: the integration row writers and every route that passes them columns call no plan check, the product page section adds no comparator or filter, and every count read in a sort, count subtraction and count cut on the public pages is registered. A count reached without naming `product_count`, `.count` or `SORT_KEY` would pass the last one. Since AECI-1841 a fourth scan counts `orderBy`, `.sort(`, `.toSorted(` and sort-resolver definitions in the public read paths and checks each file against a classified list, so a new order cannot ship unregistered. It is a tripwire too: it sees tokens, not meaning, and it skips `lib/` files outside its list. A hand-written registry lists each ordered surface as covered, pending with its owning issue (shown as `todo`), or the one accepted exception, taxonomy term counts (Chris, 2026-11-14; permanent rule in AECI-1836; `STAGE_2_PAID_TIERS_SPEC.md` §3.2 assertion 8) | The Terms promise ranking is "never influenced by payment". The other firewall tests cover search attributes, sort keys and `listing_tier` inputs, but not the order of a list on a page. The redesign mock-ups ordered by "most evidence", which only a Managed vendor can add. A one-direction flip passed 30 of 57 mutations in review. The two-direction flips, ties, loaded groups and asymmetric paid inputs exist to kill them. Every mutation from both review rounds, as reconstructed for AECI-1814, now fails the test. Each behavioural case also has a non-vacuity case that changes an order input and sees the order move |

Alongside them, per issue: the second-seat no-op matrix against the in-memory D1 harness; 422 idempotency on the admin `set`/`clear` (retired with its route by AECI-1375, 2026-10-17); `POST /api/promote` still cannot move `verified` (the AECI-520 regression guard); the expiry cron writes **no `status`** (asserted against generated SQL, since a `WHERE status = 'active'` guard is a read and must not be mistaken for a write; since AECI-1356 it stamps `licenses`, and the same test asserts no statement names `ended_at`, `assigned_product_id` or `vendors`); and a no-read-path guard asserting no read config in `lib/drizzle-helpers.ts` references `vendor_entitlements`. The same spec (`drizzle-helpers.read-path.spec.ts`) also asserts that no read config references `billing_accounts` or `licenses` and that neither has a `relations()` entry. Since AECI-1358 it also asserts that no non-spec module names the dropped `vendor_entitlements` table in code. Prose mentions pass.

**The November 2026 redesign's guards (AECI-1720).** Each pins a design or legal decision that a component test cannot see. Most read source or built output rather than a rendered component.

| Guard | Runs in | Pins |
|---|---|---|
| `apps/web/src/design-tokens.guard.spec.ts` | unit | Every token the source names exists in `styles.css`. Its source half also stops `font-display` beside a small size (the serif floor) |
| `apps/web/src/design-tokens.hex.guard.spec.ts` | unit | Every colour token renders the hex its comment documents (AECI-1747) |
| `apps/web/src/chip.guard.spec.ts`, `field-recipe-css.guard.spec.ts`, `pair-diff-edge.guard.spec.ts` | unit | The one chip recipe, the shared field recipe and the pair page's diff edge, read from `styles.css` |
| `apps/web/src/prose.guard.spec.ts` | unit | The one prose style reads only type ramp tokens (AECI-1804) |
| `apps/web/src/font-files.guard.spec.ts` | unit | Each self-hosted font file's bytes, because `/fonts/*` is cached for a year (AECI-1892) |
| `apps/web/src/app/legal/legal-heading-ids.spec.ts` | unit | The heading ids on `/legal/*` and `/methodology` change no word of the page |
| `apps/web/src/app/legal/legal-archive-freeze.spec.ts`, `app/docs/ranking-page-versions.spec.ts` | unit | Archived legal versions and ranking page versions keep their published bytes |
| `apps/web/src/app/shared/form-field/early-input-coverage.spec.ts` | unit | Every component that binds a text field, select or radio imports `AecEarlyInput`, and every consent box carries `aecConsent` |
| `scripts/check-conflict-markers.mjs` | `pnpm lint` | No tracked file holds git conflict markers (`ANGULAR_STYLE_GUIDE.md` §24) |
| `apps/web/e2e/serif-floor.spec.ts` | e2e | No rendered Source Serif text is under 20px (AECI-1928) |
| `apps/web/e2e/first-paint.spec.ts`, `font-loading.spec.ts` | e2e | First paint matches final paint, and fallback fonts take the same space (`ANGULAR_STYLE_GUIDE.md` §20b) |
| `apps/web/e2e/hydration-class-recipe.spec.ts` | e2e | Nothing resolves an `aecButton` or `aecCard` style while hydration has it without its recipe (AECI-1937) |
| `apps/web/e2e/forms-early-input.spec.ts` | e2e | Typed text survives hydration, and no tick does (§14.3) |

The on-page ordering firewall in the table above is the redesign's legal guard.

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
| plain Vitest | `apps/web/vitest.config.ts` | `src/**/*.spec.ts`, `e2e/**/*.unit.spec.ts` and `e2e-a11y/**/*.unit.spec.ts`, **excluding** `*.component.spec.ts` and `*.integration.spec.ts` | `node`, no Angular |
| `ng test` | `apps/web/angular.json` → `test` target | `src/**/*.component.spec.ts` | Angular build pipeline |

`pnpm --filter @aeci/web test:unit` runs both in sequence.

**`*.unit.spec.ts` beside the Playwright suites.** A pure helper of the e2e suite or the accessibility
nightly is pinned by a `*.unit.spec.ts` file next to it, in `e2e/` or `e2e-a11y/`. The plain runner
picks those up, so they run in the PR `unit-web` job, although the nightly specs themselves never run
on a PR. Both Playwright configs skip the suffix (`testIgnore` in `playwright.config.ts`). On
2026-11-25 that is 2 files in `e2e/` and 11 in `e2e-a11y/`. A helper spec named `*.spec.ts` in those
folders would run as a Playwright test instead.

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
  it('keeps submit enabled and focuses the first bad field (DESIGN.md "Submit stays enabled")', async () => {
    await render(ReviewFormComponent);

    const submit = screen.getByRole('button', { name: /submit/i });
    expect(submit).toBeEnabled();

    fireEvent.click(submit);

    expect(screen.getByText(/select an overall rating/i)).toBeVisible();
    expect(document.activeElement?.getAttribute('role')).toBe('option');
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

The second case is in the driver, not SQLite (AECI-1507). **drizzle 0.45's D1 batch throws on a `findFirst` that matches no row.** Its `mapGetResult` passes `[undefined]` to the relational mapper, which reads a property of `undefined`. better-sqlite3 returns `undefined` cleanly, so `GET /api/products/:slug` passed every spec and returned `500` for an unknown slug under `wrangler dev`. Inside `db.batch`, use `findMany({ …, limit: 1 })` and take `[0]`. The harness's `batch()` shim now throws on an empty `findFirst` too, so a spec catches it.

The harness's synchronous work also starves the vitest worker's event loop (AECI-1916). `promote.spec.ts` ran 83 s without one macrotask, past birpc's 60 s `onTaskUpdate` timeout, and the lane exited 1 with every test green. `makeTestDb()` now yields one macrotask and clones a migrated image built once per file. The rule and its edge cases are in `UNIT_TESTING_GUIDE.md` under "Drizzle/D1 queries".

Two habits follow:

1. **Hand-built SQL is where this bites.** ORM-generated queries stay inside ordinary shapes; a hand-rolled `sql.raw(...)` that scales with table count, column count, or row count can cross a limit the harness will never enforce. `SQLITE_MAX_VARIABLE_NUMBER` and the 100 KB statement-length cap are the same class of hazard.
2. **Exercise a new hand-built query against a real local D1 once**, via `pnpm dev:agent` + `curl`, before calling it verified. A green suite is necessary, not sufficient. Where a limit is discovered, encode it as a shape assertion so the next person inherits the guard rather than the bug.

**Audit + cache assertions.** Tests that exercise a write path should assert both the `db.batch([...])` call shape (mutation + the `auditInsert(...)` row in the same batch) and the typed cache-purge message sent after commit. Queue-consumer tests separately assert delegation into the cached `Renderer` entrypoint, including ack on success/no-cache/noop and retry on purge failure. See `CODE_REVIEW_CHECKLIST.md` "Tests" — these assertions are a documented review requirement.

### 6.4 Edge-cache integration layer (complementary to Miniflare)

Vitest + Miniflare exercises Worker *handler logic* but does **not** exercise native Workers Cache in front of the Worker. Verified for AECI-323 with Wrangler 4.111.0 / Miniflare 4.20260710.0: `wrangler dev` (top-level block, which carries the cache config) accepts the per-entrypoint cache config, but every localhost request executes the Worker and responses carry neither `Cf-Cache-Status` nor `Age`. Local tests therefore own the response-header contract, gateway normalization, queue consumer, native purge call shape, noindex bake, and stable cache/robots semantics across repeat requests; only a deployed Worker can prove front-cache state and HIT behavior. Do not require byte-identical local SSR documents—Angular may emit request-specific element ids on each uncached render.

Keep a small bash- or Playwright-driven suite for these multi-request, edge-stateful scenarios — modeled on `apps/web/scripts/run-extra-tests.sh` (T1–T12). The scenarios that earned their keep there:

- **Cookie × cache pollution** — verify the visitor-state cookie-strip runs before SSR for cacheable routes, so a per-visitor cookie can't poison the shared edge cache. The strip list (`VISITOR_STATE_COOKIES`) is empty as of AECI-226 — `theme` was removed with the dark theme — but the mechanism is retained as infrastructure and `server.spec.ts` still exercises it.
- **`Vary` audit** — confirm cached SSR responses emit only `Vary: Accept-Language`; forbidden values such as `Cookie`, `User-Agent`, and `Accept-Encoding` must be absent.
- **404 / KV-miss path** — assert HTTP 404 with TTL ≤60s, not 200 with a long TTL (the "pinned 404" trap).
- **MISS → HIT progression** — `e2e/edge-cache.spec.ts` uses a unique allowlisted `/products?view=…` key (a display-only param, so an arbitrary value forks the cache key but still renders a normal 200 grid — unlike `page=`, which 404s out of range) and requires exact `Cf-Cache-Status: MISS → HIT`, with identical `Cache-Control` and baked `X-Robots-Tag` on the HIT. It does **not** assert `Cache-Tag`: Cloudflare consumes that header for purge-by-tag and strips it before the response reaches the client, so it is unobservable at the deployed edge — the per-route tag set is verified in `server.spec.ts` and the local `run-extra-tests.sh` probe (which see the unstripped Worker response).
- **Concurrent PUT/purge storm** — confirm rate-limit resilience.
- **Per-locale cache isolation** — `/products/x` and `/es/products/x` cache independently; per-locale purge doesn't cascade across locales; canonical purge does cascade across all locales.
- **Per-field translation fallback** — entity with partial overlay renders translated fields + canonical fallback for missing fields.
- **`ng extract-i18n` discipline** — every chrome string in templates appears in the extracted XLIFF.

The local HTTP checks run in `deploy.yml` against `dev:bound`; their T7 assertion pins the absence of native-cache headers. The request-only deployed cache spec ran after deployment in `pr-preview.yml` for every first-party PR. That workflow was deleted on 2026-10-10 (AECI-1268), along with the parked preview-URL E2E jobs in `deploy.yml`, so no automated run of it remains. Run it by hand against staging, the only cached tier.

### 6.5 Live-auth integration suite in CI (AECI-90; pruned AECI-265)

The `apps/api/src/integration/**` lane talks to a real Supabase service rather than Miniflare. Post-D1 migration (PR #359, AECI-248→257) it holds a **single** spec — `user-auth.jwks.spec.ts`, a live **ES256 JWKS** regression guard for `requireUserAuth()`: it fetches the project's published signing keys over the network (`createRemoteJWKSet`) and verifies a real, freshly-minted access token, so a dashboard signing-key rotation back to HS256 (which would break the production JWKS-only contract) fails the build. Auth is the only thing retained on Supabase (ADR 0015/0016); the application DB is Cloudflare D1. The former Postgres/PostgREST suites this lane was built for — the RLS deny matrices, the auth-user-delete GDPR trigger, the Airtable→Supabase bulk migrate, and the `TEST_DATABASE_URL`-gated recompute/backfill checks — were **deleted in PR #359** (the planned `landing_forms.rls` was never created and the landing lead-capture tables moved to D1, AECI-257), so nothing remains on Supabase **Postgres**. Locally the spec runs via `pnpm --filter @aeci/api test:integration` with `SUPABASE_URL` + a fresh `SUPABASE_TEST_USER_JWT` (mint via `apps/web/scripts/mint-dev-session.mjs`).

In CI the `integration-db-tests` job — its own workflow, `.github/workflows/integration-db-tests.yml` (extracted from `deploy.yml`) — boots a **full local Supabase stack** on the runner (`supabase start`), maps `supabase status -o env` into the env the spec + mint step read (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`), mints a `SUPABASE_TEST_USER_JWT` (the local stack issues ES256), then runs the `test:integration:ci` script (the JSON-reporter variant of `test:integration`, without the `dotenv` wrapper). **No repo secrets are required** — the local GoTrue both mints the token and serves the JWKS endpoint, isolated from any shared project. There is no ORM client-generation step: Drizzle needs none, and Prisma was removed from `apps/api` wholesale (AECI-278).

**Silent-skip guard.** Every spec is wrapped in `describe.skipIf(<env unset>)` so the default unit lane stays green without live services. That same guard means a *misconfigured* CI job would *collect* the tests but *skip* them and still exit 0. The job therefore parses the JSON summary and fails on either `numTotalTests === 0` (nothing collected) **or** `numPendingTests > 0` (a `skipIf` fired → env not wired). A green check must mean the JWKS regression guard actually executed — not that it was quietly excluded.

The job is **non-blocking** today (intentionally not in `deploy-staging`'s `needs`); promote it to a required check once it has proven stable.

> **ADR-0016 note (AECI-234).** The reviews/profiles authorization deny-matrix is **not** in this lane. ADR 0016 moved the application DB to Cloudflare D1 (no RLS, no PostgREST), so the reviews/profiles **no-leakage matrix is an app-layer test in the normal unit lane** — `apps/api/src/routes/reviews.authz-matrix.spec.ts` + `profiles.authz-matrix.spec.ts` — composing the real `requireAuth`/`requireAdmin` guard with the real read and write handlers over the in-memory D1 harness (read-leakage cells plus write paths rejecting anon/banned/non-admin before the handler). It runs on every PR (no Supabase boot, not path-gated).

---

## 7. E2E testing — Playwright

End-to-end tests drive a real browser. In CI they run against a local `dev:bound` server (the per-PR preview tier was retired 2026-10-10, AECI-1268). Highest fidelity, slowest, used for critical user journeys.

Since AECI-2026 (2026-11) CI runs the suite as four Playwright shards (`--shard=N/4`). Each shard boots its own `dev:bound` and seeds its own local D1, so a shard never shares a server or a database. A merge job joins the shards' blob reports into one HTML report, the `playwright-report` artifact. Sharding changes which tests share a database, so **a test must not depend on rows another test wrote**. Each test gets the seed state plus whatever earlier tests on the same shard wrote. The job layout is in `docs/CICD_PLAN.md` §3. Locally, `pnpm test:e2e` still runs every test in one process.

### 7.1 Why Playwright over Cypress

- Faster (no constant context-switching between test runner and app)
- Multi-browser support (Chromium, Firefox, WebKit) without extra config
- Better support for SSR apps (handles multi-page navigation cleanly)
- First-class Workers support (can hit `wrangler dev` or a deployed environment)
- Parallel by default
- Better debugging tools (trace viewer, time-travel)

### 7.2 What to test

Critical user journeys:

- **Browse and view product** — home → category → product page → all four tabs
- **Search and filter** — search bar → results → faceted filter → result click
- **Review submission** — product page → login (mock auth) → review form → submit → confirmation
- **Vendor request submission** — product page → "Claim Vendor" → form → submit
- **Account deletion** — login → account → delete → confirmation → verify reviews anonymized
- **Theme switching** — toggle → verify CSS variables change → reload → persistence

Anything that crosses multiple components or pages is a candidate for E2E.

**Phase 3.12 implementation (AECI-145).** The "search → results → faceted filter → result click" journey is covered on the **API-backed listing path** (`apps/web/e2e/facets.spec.ts`): the AECI-143 facet sidebar on `/products` (facet click → `{kind}_id` + `page=1` in the URL, checkbox state, grid refresh, Clear-filters reset), the locked-kind sidebar on `/categories/:slug` (hides its own dimension), and the deterministic refine → product-card click → detail `<h1>` chain. This is the CI-runnable embodiment of the journey because **`/search` itself degrades in CI** — `dev:bound` boots without Algolia, so the InstantSearch results never render. The live `/search` box → hits → click → detail flow therefore lives in a **self-skipping block** in `search.spec.ts`, guarded on the `window.__AECI_ALGOLIA__` bootstrap (runs locally/preview with search creds, skips in CI). One `/search` results spec does run in CI: `search-load-more.spec.ts` (AECI-1906) answers every Algolia query from the fixed catalogue in `e2e/fake-algolia.ts`, held back 1.5 s, to pin that "Load more" during a pending filter search keeps the filtered first page. **A fixed Algolia (AECI-1899).** `apps/web/e2e/fake-algolia.ts` sets a stand-in config before the page loads and answers every multi-query from a small fixed catalogue on a Playwright route, so a `/search` spec runs the real InstantSearch code in CI with results that never move. It follows `facetFilters`, `numericFilters`, the query, `page` and `hitsPerPage`, and leaves an empty facet out as Algolia does. The checked-filter specs in `search.spec.ts` and the `/search` Back and Forward specs in `scroll-restoration.spec.ts` use it. No request reaches a live index. **Cache-key correctness** ("distinct facets → distinct cache entries") is proven by a unit test on the exported `cacheKeyFor()` (`cache-key-url.spec.ts`; it replaced `cacheKeyUrl()`, which WC-3 / AECI-317 removed with the manual `caches.default` pipeline and WC-4 / AECI-318 restored behind the gateway entrypoint) — HIT/MISS is unobservable on localhost (Miniflare ≠ Cloudflare edge) — with `facets.spec.ts` asserting the complement at the wire: distinct facet URLs are independently cacheable yet share one `Cache-Tag` (facets live in the key, not the tag).

`cache-key-url.spec.ts` is the same proof for every later content-affecting param, and AECI-303 added the product-PAIR page's two version selectors to it. Two of those cases are worth knowing about because they guard against a *plausible* future change rather than a typo: one asserts that swapping the two values yields a **different** key (the pair is ordered), and one asserts a comma inside a version label survives verbatim — together they fail any attempt to add `context_version`/`other_version` to `MULTI_VALUE_CACHE_KEY_PARAMS` "for consistency", which would corrupt a legitimate `R2024,SP1` label rather than merely fragment the cache.

**The docs search box's e2e** (`apps/web/e2e/docs-search.spec.ts`, AECI-1270) self-skips the same way. With no docs config in the SSR HTML it skips in `beforeAll`, before any page load (AECI-2027). It also skips when the tier's docs index answers nothing (not pushed yet, or a key that does not reach it), saying which. It runs one search per guide and is meant to be run by hand against staging after the first push. The box's wiring (guide filter, keyboard, no-config, highlights as text) is pinned in `docs-search.component.spec.ts`, and the records against the real manifest in `docs-search-records.component.spec.ts`.

**The product-PAIR page's own e2e** (`apps/web/e2e/products-pair.spec.ts`, AECI-303) follows the `search.spec.ts` self-skipping shape for the same reason: the §9 selectors only render for a pair with version-stamped attestations, and no environment has one (promote does not ingest versions; the only writer is the Verified-vendor API). The default-path cases run everywhere; the interaction block probes for a non-null `version_diff` and skips when there is none. `pnpm --filter @aeci/api db:seed:version-diff:local` is the reproducible local input that makes it run, and is deliberately **not** part of `db:seed:local` so every other pair page keeps showing the launch-reality default. The pair page also gained its first row in `phase2-a11y.spec.ts` — it had none, which is how the design checklist's axe step went unenforced in CI for the surface that owns the claim lanes.

### 7.3 What not to test in E2E

- Things already covered by unit/component tests
- Edge cases of form validation (use component tests instead)
- Pure CSS/visual concerns (use visual regression)

**Which lane a check belongs in (AECI-2027).** An E2E test pays for a page load, about half a
second. A component spec pays milliseconds. Put a check in E2E only when it needs something a
component spec cannot give it.

A check belongs in E2E when it needs one of these:

- Real layout or the built stylesheet: a box, a resolved colour, a computed font size, sideways
  scroll, the cascade. jsdom has no layout.
- The server HTML, hydration, or event replay.
- Routing, history, scroll position, or focus moving between pages.
- More than one component working together on a real page.
- A real key press or pointer the test environment cannot simulate.
- axe on a rendered page.

A check belongs in a component spec when it reads what one component renders from its inputs:
text, attributes, ARIA, classes, emitted events, form validation. If a component spec already
asserts it, do not repeat it in E2E.

Four rules keep the suite cheap:

- **One page load, many checks.** Tests that load the same URL at the same viewport and only
  read it go in one test, one `test.step` per check. The exception is an axe test, which stays
  on its own.
- **A matrix needs a reason per case.** Loop over routes only when each route is a different
  page or component. Loop over widths only when the behaviour depends on width, and then pick
  the widths that start a breakpoint band. Two widths inside one band prove the same thing.
  Say in a comment why each case is there.
- **Look a fixture up once.** A helper that walks pages to find a suitable product runs once
  per worker, not once per test. `apps/web/e2e/section-nav-product.ts` is the example. It
  finds the product the section-nav specs open, in its own browser context, and caches the path.
- **Removing a test names its cover.** The commit or PR names the test that still asserts the
  behaviour. An axe test is never removed without Chris's ruling, because the accessibility
  statement rests on it.

### 7.4 Pattern

Import `test` from `./fixtures`, never from `@playwright/test`. The fixture carries the nightly
axe sweep (§8.2), and `scripts/e2e-axe-sweep.test.mjs` fails a spec that skips it. Everything
else `@playwright/test` exports comes through `./fixtures` unchanged.

```typescript
import { test, expect } from './fixtures';

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

**Scroll with `behavior: 'instant'`.** Smooth scrolling is on only while an in-page section link
jumps (AECI-1752, `ANGULAR_STYLE_GUIDE.md`), but the switch back to a global smooth scroll can turn
it on everywhere, and `window.scrollTo` and `scrollIntoView` honour it. A smooth scroll is still
moving when the next assertion runs. An assertion that matches the start state then passes before
the scroll lands. Pass `behavior: 'instant'` to every DOM scroll call in a spec, unless the spec
tests the smooth scroll itself (`e2e/scroll-restoration.spec.ts` samples `scrollY` per frame). The phone-bar test in `vendor-program.spec.ts` passed this way on Playwright 1.60
and failed on 1.64's newer Chromium (AECI-1383).

**Never write a port into a spec.** Navigate with relative paths so `page.goto` follows the
config's `baseURL`. A spec that needs an absolute origin outside a test, such as a `beforeAll`
request context, a cookie domain or a session mint, imports `E2E_BASE_URL` from
`apps/web/e2e/base-url.ts`. That module is also what `playwright.config.ts` reads. A
`localhost:8788` literal passes in CI and fails on every `dev:agent` port pair (AECI-1449).

**Check sideways scroll with `expectNoSidewaysScroll(page)`.** It lives in
`apps/web/e2e/no-sideways-scroll.ts` and passes when the root's `scrollWidth` is at most its
`clientWidth`. Never assert that the two are equal, or that their difference is exactly 0. On
Linux CI the root's `scrollWidth` leaves out the classic scrollbar gutter and `clientWidth` keeps
it, so `scrollWidth` can be the smaller one on a page that fits. Three specs failed in CI that
way. The helper is for the page root only. A check that compares an element's width with its
container, such as a header row or a scroll strip, stays as it is. Its `tolerance` option keeps
an older 1px allowance at the same strength. Do not raise it to make a real overflow pass.
The nightly magnification check applies the same rule, with AECI-1881's 1px allowance, through
`scrollsSideways` in `e2e-a11y/support/magnify-geometry.ts`. It collects problems instead of
asserting, so it cannot call the helper (§8.4.6).

### 7.5 Test data

- The local environment uses a fixed seed data set in D1
- Tests assume seed data exists (Procore, Autodesk, etc.)
- Seed data lives in `apps/api/seed/*.sql` and is applied to the local D1 via `pnpm db:seed:local` (`db:setup:local` migrates + seeds). The chain's **last step is not SQL**: `db:grant-admin:local` runs `apps/api/scripts/grant-local-admin.mjs`, which upserts a `role='admin'` profile for `LOCAL_ADMIN_USER_ID` from `apps/api/.dev.vars` so `/admin/*` is reachable in a local browser (AECI-765), then `db:grant-vendor:local` seats `LOCAL_VENDOR_USER_ID` as a `vendor_admin` on `LOCAL_VENDOR_SLUG` (default `autodesk`) so `/vendor` is reachable too. Unset → each no-ops; both always exit 0 so they can never fail a seed run
- `seed/long-list-fixtures.sql` (AECI-1868) seeds `fixture-long-list`: 14 integrations to 14 partner products in three local-only categories, so the product page's grouped integration list renders and `products-long-list.spec.ts` asserts against that slug instead of skipping. It adds 15 products, which gives `/products` a second page. Every name starts "Zz Fixture" and every `created_at` is 2020-01-01, so A to Z and Newest lists keep their top. The categories live in this file, not `taxonomy.sql`, because `taxonomy.sql` is applied to staging and production.
- `seed/connector-lists-fixtures.sql` (AECI-1788) seeds `fixture-hybrid-via`, a hybrid with a Via lane past 20 rows that also powers 21 pairs, and `fixture-connector-hub`, a connector that powers 39 pairs, with two hubs and 25 partners. `products-connector-lists.spec.ts` asserts against those slugs and fails, never skips, when they are missing. It adds 29 products, all "Zz Fixture" names dated 2020-01-01, with one unverified vendor and no category or review. `src/test/seed-data-quality.spec.ts` runs the scheduled data-quality checks over the seed chain with and without this file and fails if it adds a finding at any severity. Since AECI-1920 the same spec also holds the whole chain to a floor: zero error-severity findings, and the only nonzero check is `products_without_vendor` at 28, all fixtures that are vendorless on purpose (the connector-lane endpoints, pyRevit, the long-list product and its partners, `fixture-acme-connector`). A new finding at any severity, or a changed count, fails it. A seeded review with no reviewer carries an `anonymized_at` stamp, the state an account deletion leaves, because the check reports a review with neither. Since AECI-1936 the spec also applies the by-hand review seeder's output (`db:seed-reviews`, `@aeci/shared/seed-reviews`) over the chain and fails on any error-severity finding, so the seeder's rows carry the same stamp.

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

### 7.7 Cross-browser & real-device — one nightly lane, in Playwright's own builds

The `projects` list above is **chromium-only**, and the PR e2e job runs Chromium only. There is no
real-device lane. The BrowserStack lane from Phase 7.8 (AECI-154, ADR 0012) was removed on 2026-10-10
under AECI-1269. Its workflow had been disabled since 2026-06-26 and never gated a merge or a deploy.
ADR 0012 is marked superseded.

One cross-browser lane exists, under ADR 0060 (AECI-1885, accepted 2026-11-26). The accessibility
nightly runs its keyboard, focus ring and announcement suites in Playwright's own Firefox and WebKit
builds as well as Chromium. It runs once a night against `main`, never on a PR, with no BrowserStack.
§8.4.10 describes it. Playwright WebKit is not Safari, and Playwright Firefox is not a Firefox release,
so the manual pass keeps its full scope and cadence. Any other cross-browser lane needs a new decision
record.

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
- `/admin/vendors` — the **admin vendor list**, in `authed-console.spec.ts`
  (AECI-652), for the same reason as `/admin/traffic`: the rows do not exist until
  the authorized `GET /api/admin/vendors` resolves, so the spec waits for a real
  row before analyzing. The list rather than the detail page, deliberately — the
  list is where the new layout primitives are (a search field, a sortable table and
  the paging footer). *As built 2026-10-17 (AECI-1375):* the list's Aria combobox
  filter (Account status) and the detail page's `EntitlementControl` are gone. The
  subscription controls on the Billing tab carry their heading and live-region contract in
  their own component specs (`license-row-actions`, `license-bulk-actions`).
- `/vendor/:vendorSlug/integrations` — the **Integrations section**, in
  `vendor-dashboard.spec.ts` (AECI-606), for the
  same reason and with the same shape: it authorizes server-side via
  `vendorMeResolver`, and its cards, claim lanes and Aria pickers do not exist
  until `GET /api/vendor/integrations` lands. That spec mints the
  `vendor_admin` persona and waits for the first integration card (or the empty
  state) before analyzing. It is the most interactive vendor-facing surface, so
  this is the run that covers the combobox/listbox wiring end to end — the unit
  specs deliberately never open a CDK overlay (§4.3a), **with one carve-out, below.**
- `/preview/vendor-dashboard` — the **portal header, breadcrumb and tab row**, in
  `preview-vendor-portal-nav.spec.ts` (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.4, §6.11).
  One axe run in **vendor context** and one in **product context**, because §6.11
  swaps the breadcrumb, the `h1` and the whole tab row when a product opens. A third
  run covers the **product-not-found** state, reached through the "No access · new"
  preset (AECI-1102: its inline link failed `link-in-text-block`). It runs
  on the PREVIEW route deliberately: that surface mounts the same shell and section
  routes with fixture data and **no session**, so unlike `vendor-dashboard.spec.ts`
  it does not skip-green in CI — and its path contains no `/vendor/` segment, so the
  zone WAF cannot 403 it. (Until §6.11 this spec also opened the Products dropdown and
  its component spec was a carve-out to "unit specs never open a CDK overlay". The
  dropdown is deleted, so that carve-out no longer exists.)
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

**Manual-pass status (AECI-244, 2026-09-09 — `docs/ACCESSIBILITY_AUDIT.md`).** The chart half of this
debt is **discharged**, with a clean result: on `/admin/overview` the 30-day chart renders its
`sr-only` `<table>` (caption + 30 rows) as a **sibling** of the `role="img"` element, exactly as this
section requires, and the neighbouring `role="img"` element with no table is `sparkline.ts`, whose
omission is deliberate and documented in the component (the stat tile always renders the figure, so the
chart is never the only representation). The **live-region half is not discharged**: the three
surviving `role="status"` regions are on the **vendor portal**, which belongs to AECI-633 and is
unreachable from production — `/preview/*` 404s on public tiers and the Stage 2 dark launch has granted
zero vendor seats. It needs a seated vendor session or a local run.

**What that pass found instead, and what it means for this section.** Three serious **WCAG 2.1 4.1.3
Status Messages (AA)** failures on `/auth/login`, `/products/:slug/review` and `/account`: each
replaces the view on a state change with no live region and no focus move. **No axe run can catch this
class**, for a reason worth stating plainly here — the defect exists only *after* a form submission,
and at the time of that pass **every axe spec we had measured the default render**. `auth-login.spec.ts`
never submitted at all. `reviews-submission.spec.ts` did submit, in its "a filled form submits and shows the moderation
confirmation" test, but its axe scan was a *separate* test on the default render and the submit test
asserted only that the confirmation copy was visible, so neither suite caught the class either way.
The regression assertion belongs in the e2e spec (submit, then assert focus or the announcement), not
in a new axe rule. AECI-829 fixed all three and added it: `auth-login.spec.ts` now submits against a
stubbed Supabase config (`addInitScript` plus `page.route`) and asserts the "Check your email" heading
`toBeFocused()`; `reviews-submission.spec.ts` asserts the same on "Review received". Both tests also
run axe on the swapped-in state, the first axe scans of a post-submit view. `/account` needs a
real session, so its persistent load-status region is asserted in `account.component.spec.ts`.

**Announcements are now a nightly check (AECI-1880).** The accessibility nightly records what changes
in the places a screen reader speaks from, while a test takes an action: every live region's text,
with its politeness, and every focus move, with the focused element's name and description. Each
status message and form error in checklist §2 is asserted to be heard exactly once, through the
channel the page promises, at the politeness it promises. §8.4.4 has the method and the flows.
**This proves the DOM changed. It does not prove a screen reader spoke.** A screen reader can still
drop, merge or reorder what the page gave it. Real speech is AECI-1886 (NVDA) and AECI-1887
(VoiceOver), and the manual pass in `docs/a11y-manual-testing-checklist.md` stays as it is. Three PR
specs moved their hand-rolled live-region checks onto the same recorder:
`preview-vendor-integration-detail.spec.ts` (three portal writes, each heard once and politely),
`preview-vendor-portal-nav.spec.ts` (the one polite channel after a section change), and the two
read-only tests of `vendor-dashboard.spec.ts` (one polite channel on every section). That spec's two
write tests keep their own checks. They save through the real vendor API, whose post-commit hooks
are not stubbed, so they were not run locally to verify a change.

Five more PR specs keep their own live-region checks. The PR job is the merge gate, so AECI-1880 did
not change how they behave. Each checks text or an attribute, not how often a message is heard.

| Spec | What it checks | Why it stays |
|---|---|---|
| `preview-vendor-catalogue.spec.ts:97` | The saved row's `role="status"` names the product | A local save confirmation. If it is inserted already filled (AECI-1858), a heard-once check would fail the gate |
| `updates.spec.ts:120` | The "A follow-up question appeared" status text | The test is about the signup body. The announcement is a side check |
| `admin-review-updates.spec.ts:116` | The queue's status says "Update approved" | It approves a seeded update through the real local API. The nightly's moderation flow checks hearing, against a stub |
| `app-update.spec.ts:50` | The update banner's status is `aria-live="polite"` | The banner is on AECI-1858's list. A heard-once check would fail the gate until that lands |
| `preview-search-relevance.spec.ts:40` | The result count is on the page after load | The count is there on arrival, so there is no change to record |

**Phase 2 implementation (AECI-65).** `apps/web/e2e/phase2-a11y.spec.ts` runs axe against every live Phase 2 page type — product/vendor/integration index+detail, the **product-PAIR page** (added by AECI-303), category/audience/phase browse, the three flat taxonomy indexes (`/categories`, `/audiences`, `/phases`), and the 404 — in the **light theme** (14 URLs; the dark pass was removed in AECI-226), plus the open state of the header's Browse menu (AECI-1774; it replaced the AECI-155 taxonomy flyouts), for 15 axe assertions in total. Detail pages run against committed fixtures (`apps/api/seed/phase2-fixtures.sql`, seeded into the local D1 by `dev:bound`); they self-skip if the fixtures aren't seeded so the suite never wedges CI. Both the header (incl. the Browse menu) and the **footer** are in scope: the footer's former `.exclude('aec-site-footer')` carve-out covered dark-theme contrast debt only, and AECI-226 removed it after verifying the footer is WCAG-AA clean in the (now sole) light theme.

**Phase 3.12 implementation (AECI-145).** `/search` axe coverage (zero WCAG-AA violations) ships in `apps/web/e2e/search.spec.ts` — against the graceful-degradation shell that renders in CI, where Algolia is absent. The `/products` listing + facet sidebar is covered by `products-index.spec.ts` (`tags wcag2a/2aa/21a/21aa`); the facet-interaction states add no new always-on surface beyond what those axe runs already scan.

**The e2e axe sweep (AECI-1876, nightly only).** The list above is the scans someone wrote. Most of
them measure a default render, which is how the post-submit states of AECI-829 went unseen. The sweep
closes that gap. With the env flag `AECI_E2E_AXE=1`, every e2e test that uses the `page` fixture ends
with one axe scan of the state it left the page in: after a submit, an open menu, a client navigation.

- **The fixture.** Every spec in `apps/web/e2e/` imports `test` from `./fixtures`, not from
  `@playwright/test`. `fixtures.ts` re-exports everything else unchanged. With the flag unset, its
  `test` is `@playwright/test`'s own `test`, so the PR e2e job is unchanged. With it set, `test`
  overrides `page`: it watches the console and runs `sweepAfterTest()` from `e2e/axe-sweep.ts` after
  the test body. The `page` fixture has its own 60-second budget, so a `test.setTimeout()` in a test
  body cannot cut the sweep short. `scripts/e2e-axe-sweep.test.mjs` fails a spec that
  imports `test` from `@playwright/test`, so a new spec cannot skip the sweep by accident.
- **The flag.** Only the exact value `1` turns it on. `playwright.e2e-axe.config.ts` sets it, and
  `pnpm test:e2e:axe` runs that config. The default `playwright.config.ts` and `deploy.yml` never
  set it, and the same test pins that.
- **Before the scan.** The sweep waits for the page's `load`, then for app stability
  (`untilAppStable`, §14.3 (a)), then for every `aria-busy="true"` region to clear, then for finite
  animations and transitions to finish. A scan mid-fade reads a part-transparent colour and reports a
  contrast failure no reader sees. A test that emulated forced colours gets the default back first:
  the contrast rule does not apply under forced colours. Every other emulated setting stays.
- **Hydration voids a scan.** An `NG0500` or `NG0602` logged during the test fails it. A page that
  hydrated wrong is not the page a reader gets.
- **Not scanned.** Every test in the lane that starts gets a scan record, so each one is counted.
  A test skipped at declaration never starts, and `totals.skipped` counts it. These are recorded as
  not scanned, with the reason:
  - A test that failed or skipped. It already has its answer.
  - A closed page, or a page that is not HTML (`/sitemap.xml`).
  - A test with JavaScript off. axe runs as a script in the page, so it cannot run there.
  - A test that never asks for `page`, such as an API-only test using `request`.
  - A test that opens its own browser context (`browser.newContext()` or `browser.newPage()`) and not
    `page`. The sweep scans only the `page` fixture. Those pages are closed in the test body, and they
    hold a state the sweep cannot judge: forced colours, JavaScript off, a held stylesheet, a cold
    first paint. As of AECI-1876 that is 12 tests: `product-review-responses.spec.ts` (forced colours,
    one), `product-hero-hub.spec.ts` (reduced motion, two), `first-paint.spec.ts` (four),
    `font-loading.spec.ts` (four) and `products-pair.spec.ts` (JavaScript off, one).
    `browser-evidence.spec.ts` opens one too when it runs. An auto fixture counts the contexts a
    test opens and writes the record.
- **Opting out.** A test whose end state is not a page a reader can reach calls
  `axeOptOut(reason)` in its body or a `beforeEach`. Examples: a stub page the test served itself, a
  chunk it held back so the app never becomes stable. The reason is a literal string, and
  `scripts/e2e-axe-sweep.test.mjs` lists every call in `OPT_OUTS`, so adding one shows in the diff.
- **Excluded DOM.** Not ours to judge, as in the scans above: the dev-only concept switcher, the
  Turnstile iframe, and 1Password's injected nodes (`EXCLUDED_DOM` in `axe-sweep.ts`).
- **Known failures.** A violation we cannot fix yet goes in `e2e/axe-known-failures.ts`, by rule and
  page path, with its Linear issue. It is the sweep's form of `knownFailure()` (§8.4), keyed by page
  because one cause often ends many tests on one page. A listed violation does not fail the test, and
  the test carries the `known-failure` annotation. A test that ends on a listed page fails when the rule
  now passes there, or when any one listed target passes. A partial fix shrinks the entry, and a
  full fix removes it. `scripts/a11y-known-failures.test.mjs` requires a literal
  `'AECI-<n>'` on every entry.
- **What it found on landing (2026-11-24).** Two gate failures, both on dev-only pages, both filed
  under AECI-1069 and listed: AECI-2059 (`/_demo/spartan`, `aria-prohibited-attr` on the demo dialog
  host, 20 tests) and AECI-2060 (`/preview/vendor-detail`, tertiary text on Bone, 3 tests).

### 8.3 Severity threshold

Block PR merge on any `serious` or `critical` violations. Warn (but don't block) on `moderate`. Ignore `minor`.

The Phase 2 success-path suite (AECI-65, above) is stricter: it asserts **zero violations at WCAG-AA** (tags `wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa`) on every page type — any such violation fails the run. Those tags do not include WCAG 2.2. The one 2.2 rule gated today is `target-size`, on the product-detail `#integrations` section at 1280px and 375px (AECI-1079). See `ACCESSIBILITY_AUDIT.md` §6.

The nightly e2e axe sweep (§8.2, AECI-1876) gates on the same four tags: any violation fails the test, whatever its impact. It runs one axe pass with three more tags on top, `wcag22aa`, `best-practice` and `experimental`. A rule with none of the four gate tags is **report only**. So is any rule tagged `experimental`, because the gate tags alone never turn experimental rules on. Report-only findings go to the run summary, grouped by rule, and never fail the run. `target-size` on the product-detail `#integrations` section is dropped from the report, because AECI-1079 already gates it there.

**axe remains the gate.** The nightly also runs a second engine, IBM Equal Access (§8.4.9, AECI-1884).
It is report only. Its findings go to the run summary and never fail a test or the run. Until Chris
rules on the two-week note, no IBM finding blocks a merge, a deploy or the nightly.

Some violations are unfixable in third-party code; maintain an explicit allowlist with documented reason for each.

### 8.4 Nightly suite

AECI-1875 added a nightly Playwright lane for accessibility checks that are too slow or too broad for a
PR. The sub-issues of AECI-1874 add the checks. The workflow, its skip rule and its alert are in
`docs/CICD_PLAN.md` §11a-quater.

**What the suite holds.** Nine suites over the 22 surfaces of the manifest, 600 tests in all. Counted
with `playwright test -c playwright.a11y-nightly.config.ts --list` at `61eeafe65` (2026-11-25). The
nightly also runs the e2e axe sweep lane (§8.4.2), the PR e2e suite's 838 tests from its own config.

| Suite | Specs | Tests | Section |
|---|---|---|---|
| Reachability placeholder | `surfaces.spec.ts` | 22 | Below |
| Keyboard walkthroughs | `keyboard-{public,reviewer,admin,vendor}.spec.ts` | 111 | §8.4.1 |
| ARIA snapshots and cross-page checks | `aria-{public,reviewer,admin,vendor}.spec.ts`, `aria-cross-page.spec.ts` | 108 | §8.4.3 |
| Announcements and form errors | `announcements-public.spec.ts`, `announcements-signed-in.spec.ts` | 38 | §8.4.4 |
| Focus ring | `focus-ring.spec.ts` | 25 | §8.4.5 |
| Magnification | `magnification.spec.ts` | 44 | §8.4.6 |
| Interaction scripts | `interaction.spec.ts`, `interaction-flows.spec.ts` | 185 | §8.4.7 |
| Voice control and switch | `voice-control.spec.ts` | 45 | §8.4.8 |
| IBM Equal Access, report only | `ibm-equal-access.spec.ts` | 22 | §8.4.9 |

The committed snapshots are in `e2e-a11y/__snapshots__/chromium/`: 22 tab orders (`keyboard-*.txt`)
and 56 ARIA files (`aria-*.yml` and `aria-states-*.txt`). Every suite runs in Chromium.

**The projects (AECI-1885).** The nightly config has three Playwright projects. `chromium` runs every
suite. `firefox` and `webkit` run only the keyboard, focus ring and announcement suites, picked by
`testMatch`: 174 tests each, plus the barrier tests found only in that browser (§8.4.10). Their tab orders are in `__snapshots__/firefox/` and
`__snapshots__/webkit/`. CI runs each browser in its own job (§8.4.10). With no `--project`, a local
run takes all three browsers. Add `--project=chromium` to run Chromium alone, as the CI shards do.

**The boundary.** The suite lives in `apps/web/e2e-a11y/` and runs from its own config,
`apps/web/playwright.a11y-nightly.config.ts`. The default `playwright.config.ts` keeps `testDir: './e2e'`,
so the PR e2e job never sees the nightly specs. The nightly config reuses everything else from the default
one: the base URL, the `webServer` block and the `.dev.vars` auth hydration. Run it locally against
`pnpm dev:agent`:

```bash
AECI_WEB_PORT=8790 PLAYWRIGHT_BASE_URL=http://localhost:8790 pnpm test:a11y:nightly
```

Use the web port `dev:agent` printed in place of `8790`. With no `--shard`, the command runs the whole
suite, as before.

**Shards (AECI-1874).** CI runs the Chromium suite in eight shards, one runner each, with
`--project=chromium`. The Firefox and WebKit lane runs three shards per browser (§8.4.10)
(`docs/CICD_PLAN.md` §11a-quater has the measured times). Playwright splits by test, because the base
config sets `fullyParallel`. So a spec's tests can land on different shards, and no test may depend on
another test having run:

- A `describe` with `test.describe.configure({ mode: 'serial' })` or `{ mode: 'default' }` stays on one
  shard, whole. A group that shares a `beforeAll` record must use one of the two, as
  `aria-cross-page.spec.ts` (`mode: 'default'`) and `focus-ring.spec.ts` (`mode: 'serial'`) do.
- Which surface checks the site header (`headerOwnerFor` in `support/header-owner.ts`) is a pure
  function of the manifest and the fixture probe. It does not depend on which test ran first, so the
  owner surface checks the header on whichever shard it lands.
- Known failures and the summary are per test. Each shard writes its own summary, and the workflow
  merges them (§8.4.2).

To see where tests land: `playwright test -c playwright.a11y-nightly.config.ts --list --project=chromium --shard=3/8`,
or `--project=webkit --shard=2/3` for the browser lane.

**The manifest.** `apps/web/e2e-a11y/surfaces.ts` is the one list of surfaces. It has the seven surfaces
of `docs/a11y-manual-testing-checklist.md` §1, as nine routes, and the 14 URLs of `phase2-a11y.spec.ts`.
The product page is in both, so the manifest has 22 entries.
Each entry names its route, the persona that signs in, the seed it needs (`phase2` or `auth`), whether the
AECI-1571 redesign is rebuilding it, and the status it should answer. `phase2-a11y.spec.ts` keeps its own
list, so the PR job is unchanged. `personaCredentials()` maps a persona to a test account. The reviewer
persona signs in as the admin test user until a plain reviewer account exists.

**The placeholder.** `surfaces.spec.ts` checks that each surface answers its expected status and renders
one visible `h1`. It runs no accessibility rule. A signed-in surface skips when its session cannot be
minted. A `phase2` surface skips when the fixture product is absent. Skips are green, as in the PR suite.

**The known-failure rule.** A real barrier we cannot fix yet is marked with
`knownFailure('AECI-123', reason)` from `e2e-a11y/known-failure.ts`, inside the test body. The test stays
green while it fails and turns red when it starts to pass, so the mark comes off. A bare `test.fail()`
anywhere else in `e2e-a11y/`, or a call without a literal `'AECI-<n>'`, fails `pnpm test:scripts`
(`scripts/a11y-known-failures.test.mjs`).

Each suite keeps its own list of known barriers, each entry with its literal issue ID. Three patterns
are in use:

| Pattern | What a mark covers | Used by |
|---|---|---|
| `markKnownBarriers` (`support/known-barriers.ts`) | One check on the surfaces the entry names | Keyboard (§8.4.1) |
| `expectOnlyKnownProblems` (`support/known-barriers.ts`) | Only the problems the entry matches. A new problem on the same surface still fails, and a fixed one turns red | ARIA (§8.4.3), magnification (§8.4.6), interaction (§8.4.7), voice control (§8.4.8) |
| A separate marked test beside an unmarked one | Only the assertion the marked test holds | Announcements (§8.4.4), focus ring (§8.4.5) |

Use `expectOnlyKnownProblems` for a new check that reports a list of problems.

**The summary.** `e2e-a11y/summary-reporter.ts` writes `apps/web/a11y-nightly-summary.json` after every
run, and after every shard in CI. The workflow merges the shards' files with the e2e axe sweep's, and the alert reads the merged
file to name the failing surfaces (§8.4.2). CI keeps that file as an artifact for 30 days. AECI-1682
will read it for the dated record.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1`. Changes only when a field changes meaning or goes away |
| `generatedAt`, `commitSha`, `trigger`, `runUrl` | When, which commit, `nightly` or `manual`, and the Actions run |
| `status` | Playwright's overall result |
| `totals` | `passed`, `failed`, `skipped`, `expectedFailures` |
| `tests[]` | `title`, `surfaceId`, `route`, `file`, `browser`, `outcome`, `knownFailure`, `knownFailures`, and `axe` (the sweep's verdict or `null`) |
| `tests[].browser` | The Playwright project that ran the test: `chromium`, `firefox` or `webkit` (AECI-1885). The same title appears once per browser |
| `tests[].knownFailure` | The first known-failure ID the test carries, or `null`. One ID only: kept for readers that use it |
| `tests[].knownFailures` | Every known-failure ID the test carries, once each, in issue number order (AECI-1874). A test that judges several problems marks each known one, so it can carry two or three. Empty when there is none. Read this one |
| `knownFailures` | Merged file only. Every known-failure ID in the run, once, with `tests`, the number of tests that carry it |
| `browsers` | Merged file only. Per browser: `passed`, `failed`, `skipped`, `expectedFailures` and `flaky`, from each row's `browser` (AECI-1885). The job summary prints it as "By browser". Adding it kept `schemaVersion` 1 |
| `parts` | Merged file only. Each shard's file, whether it was found, and the read error if any. See §8.4.2 |
| `axe` | The e2e axe sweep's results. Always an object: zero counts and empty lists for a run with no sweep. See §8.4.2 |
| `voice` | The voice-control checks' effort counts, target size report and the fields input purpose judged. Always an object: empty lists for a run with no voice-control test. See §8.4.8 |
| `ibm` | IBM Equal Access findings, report only: violations, needs review and recommendations. Each is marked by how axe saw the same element: failed it, only marked it for review, or said nothing. Only an axe failure takes a finding off the unique list. Always an object: zero counts and empty lists for a run with no IBM test. See §8.4.9 |

**Adding a check.** Write a new spec in `e2e-a11y/` that loops over `SURFACES`. Give each test
`surfaceAnnotations(surface)`, so the summary can name the surface. Start it with `prepareSurface()`,
which mints the persona's session and skips the same way as every other suite, then `openSurface()`,
which waits for hydration (both in `support/surface-page.ts`). Install a write guard before the first
action: `guardWrites` (`support/page-guards.ts`) for a check that only reads, `blockWrites`
(`support/announcement-flows.ts`) for one that submits, then stub the one write it answers. Mark a
known barrier as above. Keep each test independent, as "Shards" says. Add a surface to `surfaces.ts`,
never to a spec. When you change the manifest, change the manual checklist §1 with it.
`apps/web/e2e-a11y/README.md` is the short version.

#### 8.4.1 Keyboard walkthroughs (AECI-1877)

The keyboard checks script the "Keyboard-only (every surface)" block of
`docs/a11y-manual-testing-checklist.md` §2. They cover WCAG 2.1.1, 2.1.2, 2.4.1, 2.4.3 and 3.2.1. The
checks are defined once, in `e2e-a11y/support/keyboard-suite.ts`. Four thin specs run them, one per
persona: `keyboard-public.spec.ts`, `keyboard-reviewer.spec.ts`, `keyboard-admin.spec.ts` and
`keyboard-vendor.spec.ts`. Every surface in the manifest runs, public pages included (Chris, 2026-11-24).

Each surface gets these tests:

| Test | Checks |
|---|---|
| `tab walk` | Tab until focus is back on the first stop. The cycle must close, reach the footer, and move focus on every press (no trap). No stop may change the URL or open a dialog, menu or list. The order must match the committed snapshot. The candidate diff must be empty. The first stop is the skip link, and Enter on it puts focus inside `main` with no new document. |
| `overlays` | Every popup trigger the walk met opens by keyboard, keeps focus as **Overlays** below says, closes on Escape and returns focus to its trigger. A popover's Tab rule is the next test. |
| `popovers` | Every floating popover the walk met: after each Tab, focus is inside it or it has closed. Its own test, so a known popover barrier cannot hide the other overlays. |
| `aria-haspopup names the popup it opens` | A trigger's `aria-haspopup` must match the role of the element its `aria-controls` names. `"true"` promises a menu. |
| `overlay: <name>` | An overlay a fresh walk cannot reach, from `support/overlay-scenarios.ts`. Today that is the ban dialog on `/admin/reviews`. Its reject is stubbed, so the queue row stays and nothing is moderated. |
| `after navigation` | Enter on the first in-app link in `main`. After the client navigation, focus is not on `body`. |

**Real Tab presses only.** No test calls `el.focus()`. Every surface is loaded with `openSurface`, which
waits for `untilAppStable` before the first press (§14.3). A walk that must reach a known stop again uses
`tabTo`, which presses Tab until the probe key matches.

**Overlays.** Triggers are found in the walk, not listed by hand: a combobox, an element with
`aria-haspopup`, or one with `aria-expanded`. `classifyTrigger` in `support/overlay-check.ts` decides how
each opens, and its header table lists every kind. "Keeps focus while open" means one of two things. A
modal dialog must trap Tab and Shift+Tab inside it. Every other popup (menu, select list, search
suggestions, the Browse menu, a popover) passes when each Tab leaves focus inside it, or closes it within
a second, so focus is never behind an open popup. Escape must close every kind and return focus to the
trigger. A button whose panel opens in the flow of the page is an inline disclosure, and a native
`<select>` draws its own list. Neither is checked. A trigger no rule covers fails the test, so a new kind
of popup cannot pass unchecked.

The site header's popups (search, the Browse menu, the account menu) are one component on every page.
They are checked once per persona, on the first surface of that persona the run can reach
(`headerOwnerFor` in `support/header-owner.ts`). A `phase2` surface is passed over when the fixtures are
absent, so the check falls through to the next surface. A missing session skips every surface of the
persona, and the skip count shows it. Each overlays test records `header-overlays: checked here` on the
surface that ran it.

The vendor portal has no Products dropdown to check. `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.11 made Products a
plain link, and checklist §2 dropped that step (AECI-2062).

**The snapshot.** `e2e-a11y/__snapshots__/<browser>/keyboard-<surface id>.txt` holds one line per stop:
the innermost landmark, the role and the accessible name. There is one folder per browser project:
`chromium`, `firefox` and `webkit` (§8.4.10). Relative times and dates are masked. The path is keyed by
browser project, not OS (`snapshotPathTemplate` in the nightly config). For Chromium, a snapshot written
on a Mac is the one the Linux runner reads. WebKit on a Mac and on Linux are different ports, so §8.4.10
says how to write WebKit's on the runner. A changed order is a behaviour change. A change that alters a
tab order updates all three folders in the same PR. Update it on purpose, and review the diff:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts keyboard --update-snapshots
```

The names come from the seed, so a seed change that adds a product or a facet value changes the listing
snapshots too. The snapshots assume a freshly seeded D1, as CI has. A local stack restarted on the same D1
seeds it again, and today that detaches the test user's review, so `/account` loses two stops (AECI-2068).
Delete `apps/api/.wrangler/state/v3/d1` before a local run that must match. Three things keep a walk the same from run to run. `settleLazyContent` scrolls to the
bottom until the page stops growing, so a listing's next page and every `@defer (on viewport)` block are
in place before the walk. Each test has a fresh browser context, so the consent banner is always there.
`fakeHeaderSearch` answers every Algolia query with the same rows.

**The candidate diff** is the method in checklist §5. `collectElementFacts` reads every element that could
be a Tab stop. `candidateTabStops` predicts the walk from those facts: focusable, not inert, not disabled,
a `tabindex` that is absent or not negative, positive `tabindex` first, and one radio per group.
`diffCandidates` reports stops predicted but never reached, stops reached but not predicted, and stops
reached while hidden (inside `aria-hidden`, or with no box). The pure half is pinned by
`support/tab-candidates.unit.spec.ts`. It runs in the plain Vitest runner (§4.3a), from
`pnpm --filter @aeci/web test:unit`. Playwright ignores `*.unit.spec.ts`.

**Writes are blocked.** The signed-in surfaces run as the shared test accounts, and they hold the account
delete and ban dialogs. `guardWrites` aborts every request that is not a read, on any origin, from the page and from any tab
or window it opens (the route is on the browser context too, AECI-1882), so a stray
Enter cannot delete the account, ban anyone, or sign the session out. The tests close the delete and ban
dialogs with Escape and never confirm them. The one confirm they press, "Confirm rejection" on the way to
the ban dialog, answers from a stub.

**Known barriers.** `KNOWN_BARRIERS` in `keyboard-suite.ts` maps a check and a set of surfaces to a
`knownFailure` call. Today it holds AECI-2058: the admin nav triggers say `aria-haspopup="true"` but open
a list of links, so `aria-haspopup names the popup it opens` is a known failure on the admin surfaces.

**For the next sub-issues.** AECI-1878 (focus ring) and AECI-1885 (Firefox and WebKit) reuse these
exports from `e2e-a11y/support/`:

| Export | File | What it does |
|---|---|---|
| `tabWalk(page, { key?, maxPresses?, until?, onStop? })` | `tab-walk.ts` | Real Tab presses until the cycle closes. Returns the stops and how the walk ended. Asserts nothing. `onStop` runs at each new stop while it has focus (AECI-1878, §8.4.5) |
| `tabTo(page, key, options?)` | `tab-walk.ts` | Tab until the element with that probe key has focus |
| `walkSnapshot(stops)`, `normalizeName(name)` | `tab-walk.ts` | The committed snapshot text |
| `collectElementFacts(page)`, `focusFacts(page)`, `popupFacts`, `triggerFacts`, `haspopupFacts`, `locatorForKey` | `probe.ts` | Read the page. Never move focus |
| `candidateTabStops(facts, { keyboardFocusableScrollers? })`, `diffCandidates(candidates, stops)` | `tab-candidates.ts` | The prediction and the diff. Pure |
| `checkOverlay(page, trigger, plan)`, `classifyTrigger(stop)` | `overlay-check.ts` | Check 7 for one trigger |
| `headerOwnerFor(persona, fixturesPresent)` | `header-owner.ts` | Which surface checks the site header's popups. Pure |
| `prepareSurface(context, surface, fixturesPresent)`, `openSurface(page, surface, { settle? })`, `phase2FixturesPresent()`, `surfaceAnnotations(surface)` | `surface-page.ts` | Session mint and skip, the hydration gate, the summary annotations |
| `guardWrites(page)`, `fakeHeaderSearch(page)` | `page-guards.ts` | The routes every keyboard test installs |

**Other browsers (AECI-1885).** The same checks run in Playwright's Firefox and WebKit builds. Where an
engine differs by design, the walk reads one entry of `support/browser-expectations.ts`: the key it
presses (Option+Tab in WebKit, which skips links on a plain Tab as Safari does), whether Tab wraps at the
ends of the page (not in Playwright Firefox), and which scroll containers are Tab stops (both
`candidateTabStops` options). Chromium's values are the defaults the suite always had. §8.4.10 lists
every entry and its reason. Measured on 2026-11-26, the three browsers give the same order, roles and
names on all 22 surfaces. The one difference is the account page's review list, which Firefox makes a
stop because it scrolls.

#### 8.4.2 The e2e axe sweep lane (AECI-1876)

The nightly runs a second Playwright lane next to `e2e-a11y/`: the whole e2e suite with the axe sweep
on (§8.2). It runs from `apps/web/playwright.e2e-axe.config.ts`, the default config plus the flag, the
reporters and `retries: 0`. CI splits it into four shards. The PR job retries once in CI. Here a retry
would hide a violation: a test that fails the sweep and passes on the second try is green, and the
summary reads only the last try. So a flaky test is red in this lane and is named in the alert. Run it locally against `pnpm dev:agent`:

```bash
AECI_WEB_PORT=8790 PLAYWRIGHT_BASE_URL=http://localhost:8790 pnpm test:e2e:axe
```

Use the web port `dev:agent` printed in place of `8790`. A full local run took about 10 minutes with
the default workers.

Each shard of each lane writes its own summary with the same reporter: `a11y-nightly-summary.json` for
an `e2e-a11y/` shard and `a11y-e2e-axe-summary.json` for a sweep shard. The workflow's `report` job
merges all twelve into the one `a11y-nightly-summary.json` the alert reads
(`scripts/a11y-nightly-merge-summary.mjs`). The merge adds `parts`, which names each shard's file and
whether it was found, and `knownFailures`, each known-failure ID once with its test count. The job
summary prints that list as a table. A missing part makes the merged
`status` `failed`. A test row names its spec in `file`. Without a `route` annotation, `route` is the
path the sweep scanned.

| `axe` field | Meaning |
|---|---|
| `violationsByImpact` | Gate violations, one per test and rule, by impact. Known failures count |
| `scans` | `scanned`, `optedOut`, `notScanned` |
| `optOuts[]` | `title` and `reason` of each opted-out test |
| `gate` | The gate tags, and the rules that failed a test: `id`, `impact`, `help`, `helpUrl`, `tests`, `nodes`, `paths` (up to 10) |
| `knownFailures[]` | `issue`, `rule`, and `tests`, from `e2e/axe-known-failures.ts` |
| `reportOnly` | The report-only tags, and their findings grouped by rule, in the same shape as `gate` |

The merge also writes the totals, the gate rules, the known failures and the report-only rules to
the run's job summary. A known failure in the sweep passes, so it is not in `totals.expectedFailures`.

#### 8.4.3 ARIA snapshots and cross-page checks (AECI-1879)

Most of what a screen-reader pass finds is structure: roles, names, states and heading order. These checks
pin it. They cover WCAG 1.3.1, 2.4.2, 2.4.4, 2.4.5, 2.4.6, 3.2.3, 3.2.4 and 4.1.2. The per-surface checks
are defined once, in `e2e-a11y/support/aria-suite.ts`. Four thin specs run them, one per persona:
`aria-public.spec.ts`, `aria-reviewer.spec.ts`, `aria-admin.spec.ts` and `aria-vendor.spec.ts`. The
cross-page checks are `aria-cross-page.spec.ts`. Every surface in the manifest runs, the product and pair
pages included (Chris, 2026-11-24). Those two are `underRedesign`, so expect their snapshots to change
when the redesign batch lands, and review that change like any other.

Each surface gets these tests:

| Test | Checks |
|---|---|
| `snapshot: main` | The ARIA snapshot of `main` matches `aria-<surface id>.yml`. |
| `structure` | Exactly one `h1`. No heading skips a level, counting from `h1`. The `banner`, `navigation`, `main` and `contentinfo` landmarks are present, with one `main`. Every `navigation` and `search` landmark has a name, and no two of a kind share one. |
| `link names` | No two links on the page share a name while pointing to different targets. Names are compared without case or extra spacing, and a trailing slash on a target is not a difference. AECI-830 is the precedent. |
| `states: main` | Each disclosure button, tab, combobox, toggle button and `<summary>` in `main`, snapshotted before and after it is flipped by keyboard, in `aria-states-<surface id>.txt`. A control Tab cannot reach, or whose state does not change, fails the test. |
| `states: the site header` | The same for the header, on the first surface of each persona only, in `aria-states-header-<persona>.txt`. |

**How the snapshot is taken.** The text comes from Playwright's `locator.ariaSnapshot()`, the serialiser
behind `toMatchAriaSnapshot`. It is masked, then compared with `toMatchSnapshot` as a committed text file.
`toMatchAriaSnapshot` itself is not used. Its update path writes its own guess at a regex, which leaves
single-digit counts and relative times in the file. Its default match is also partial, so a removed
element can pass. Every surface is loaded with `openSurface`, which waits for `untilAppStable` (§14.3),
and `settleLazyContent`, so the listing pages and `@defer` blocks are complete.

**What is masked.** `maskAriaSnapshot` in `support/aria-tree.ts` does it, and its unit spec pins it.

| Data | Becomes |
|---|---|
| Any number in a name or text: counts, ratings, prices, "Step 2" | `<n>` |
| A calendar date (`Nov 24, 2026`, `24 Nov 2026`, `2026-11-24`) | `<date>` |
| A relative time (`3 days ago`, `today`, `yesterday`, `just now`) | `<ago>` |
| A clock time, with its AM or PM (`4:24:46 PM`) | `<time>` |
| A UUID, in a name or a link target | `<uuid>` |
| The `return=` parameter on the sign-in link, which names the page it sits on | dropped |

State flags keep their values (`[level=2]`, `[expanded]`, `[pressed]`), and link targets keep everything
else. So a heading-level change or a moved link still shows. A seed change that renames a product still
changes the snapshots, as it does the tab orders.

**How a state is flipped.** `support/state-snapshots.ts` finds the controls on the page, so a new one is
snapshotted the day it ships. Every flip is by keyboard, never by pointer. Real Tab presses bring focus to
the control (`tabTo`, with the probe key from `keyForLocator` in `support/probe.ts`), then a key acts on it.
A pointer would not do. The admin nav dropdowns and the review queue's toxicity legend open on
`mouseenter`, so a Playwright click opens them and then toggles them shut (AECI-2099). A button with
`aria-expanded` gets Enter. A `role="combobox"` button gets Enter. A combobox text box gets ArrowDown,
then the query `fixture` if ArrowDown opens nothing. In a group of `aria-pressed` buttons, each one not
pressed gets Enter. An unselected `role="tab"` and a `<summary>` get Enter. Each snapshot holds the control
(or its group or tab list) and the element its `aria-controls` names. After each flip the control is put
back by keyboard, with Escape for a combobox. When it is not back, the page is reloaded, and the test waits
until the same controls show as on the first load. That wait fails with its own message. A control Tab
cannot reach, or whose state does not change, is a problem, so the test cannot pass on a flip that never
happened.

The "after" snapshot is read until two reads 500 ms apart agree. There is no DOM signal to wait on
instead: the search suggestions come from a debounced query and set no `aria-busy`, and app stability is
only observable at hydration. A snapshot still changing after 10 seconds fails the test.

Two kinds are left out: a link with `aria-expanded` navigates, and an `aria-haspopup="dialog"` trigger hides
the page behind a modal. The keyboard suite's overlay check covers both (§8.4.1). Charts render
`role="img"`, so their subtree is absent, and `chart-a11y.component.spec.ts` keeps covering them.

**The cross-page checks** visit every surface of a persona once, in a `beforeAll`, and judge the record.
The hook signs in with `signInAs(context, persona)` from `support/surface-page.ts`, the session half of
`prepareSurface`, so a persona with no session skips the whole group.

| Test | Checks |
|---|---|
| `titles` | Every page has a non-empty title no other page has. Surfaces that redirect to the same page count once (`/vendors` and `/integrations` both answer 301 to `/products`). |
| `header and footer` | The header and footer snapshots are the same on every page, and match `aria-header-<persona>.yml` and `aria-footer-<persona>.yml`. |
| `link names` | A link target carries a consistent name on every page. Names are compared within one landmark, `main` with `main`, because a header link and a footer link to the same page are two components. Two names agree when, with numbers masked and case folded, every word of one is a word of the other. That covers a name followed by a count ("Project Management 2 products") or a description. Three leading words are accepted, each listed in `ACCEPTED_LEADS` in `support/aria-tree.ts`: "View all", "View" and "Back to". So "View Fixture Procore" agrees with "Fixture Procore". "Vendor portal" and "Vendor Overview" do not agree, and neither do "General contractors" and "General Contracting". |
| `on every page` | A `search` landmark, a `navigation` landmark with links, and a footer with links. |

**Updating a snapshot.** A changed snapshot is a behaviour change, the same as a changed tab order. Update
it on purpose, read the diff, and say in the PR why it changed:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts aria- --update-snapshots
```

A diff that only renames or reorders seed data needs no more than that. A diff that drops a landmark, a
name, a heading or a state flag needs review by whoever owns the surface, because that is what a
screen-reader user loses. The snapshots assume a freshly seeded D1, as CI has. Delete
`apps/api/.wrangler/state/v3/d1` before a local run that must match (§8.4.1).

**Signed-in surfaces.** The six signed-in surfaces sign in through `prepareSurface` and `signInAs`, as
every nightly spec does, and skip when a session cannot be minted. Their snapshots are committed with the
public ones. They hold the shared test accounts' display names, which are already public in the seed.
The portal and admin redesign (AECI-1729) will change them, so review that diff when it lands.

**Known barriers.** A mark covers only the problems it names, not the whole rule. Each entry in
`KNOWN_PROBLEMS` (`aria-suite.ts`, and the cross-page one in `aria-cross-page.spec.ts`) has an issue, a
`matches` test for its problem strings, and the `knownFailure` call. `expectOnlyKnownProblems` in
`support/known-barriers.ts` judges a check:

1. A problem no entry matches fails the test unmarked. A new defect on a page with a known barrier is
   still red.
2. An entry that matches nothing fails the test unmarked. When an issue is fixed, the test turns red until
   its entry is removed.
3. Otherwise the test is marked with each entry's `knownFailure` and fails on the known problems alone,
   which reads as an expected failure.

The pure half, `classifyProblems`, is pinned by `support/known-barriers.unit.spec.ts`. Today:

| Issue | Test | Barrier |
|---|---|---|
| AECI-2077 | `link names`, product page | Two links named "About": the section nav's to `#about`, the footer's to `/about` |
| AECI-2086 | `link names`, both vendor portal surfaces | The portal nav and the footer both have "Products", and four taxonomy names, for different pages |
| AECI-2078 | cross-page `link names`, anonymous | Home names the audience links by role ("Subcontractors"), `/audiences` by discipline ("Specialty Contracting") |
| AECI-2087 | cross-page `link names`, vendor | The portal overview is linked as "Vendor portal", "Vendor Overview" and the vendor's name |
| AECI-2084 | cross-page `titles`, admin | Both admin queues are titled "Admin · AEC Integrations" |
| AECI-2085 | cross-page `titles`, vendor | Both portal screens are titled "Vendor portal · AEC Integrations" |

#### 8.4.4 Announcements and form errors (AECI-1880)

These checks script the announcement items of `docs/a11y-manual-testing-checklist.md` §2: "Dynamic
updates … are announced", and every "Surface-specific" line that names an announcement. They cover
WCAG 4.1.3 and 3.3.1. axe cannot see this class: the message exists only after an action.

**The recorder** is `e2e-a11y/support/announcements.ts`. It imports only `@playwright/test`, so `e2e/`
specs use it too.

| Export | What it does |
|---|---|
| `recordAnnouncements(page)` | Start recording on the current document. Call it after the hydration gate, right before the action |
| `recordAnnouncementsFromLoad(page)` | Start recording on every next document, from an init script, as soon as the HTML parser finishes and before any module script runs. For a message that appears on arrival. Each document has its own token, so a read after a reload throws |
| `rec.settle({ quietMs?, timeoutMs? })`, `rec.read()`, `rec.clear()` | The ordered record. `settle` waits until nothing new has arrived for `quietMs` (1 s) |
| `heard(record)`, `heardMatching(record, text)` | What a screen reader is expected to speak, by the model below |
| `expectHeardOnce(record, text, via)` | Heard exactly once, through `via`: `'focus'`, `'polite'` or `'assertive'` |
| `expectNotHeard(record, text)` | Never heard |
| `liveRegions(page)` | Every live region now, with its politeness and whether it is `sr-only`. Reads only |

A record entry is either `live` or `focus`. A `live` entry is a text change in an element with
`aria-live`, `role="status"`, `role="alert"` or `role="log"`. It carries the politeness, whether the
region is hidden, and whether the region was inserted with its text already in it. A `focus` entry is a
focus move. It carries the focused element's name and its `aria-describedby` text, read one frame
after the move, when the browser has updated the accessibility tree. An option or radio with no
description of its own takes its group's.

**The model** (`heard`). A hidden region, `aria-live="off"` and an empty text are silent. A polite region
inserted already filled is silent, as AECI-1858 found with VoiceOver. An inserted `role="alert"` is
spoken. Every focus move is spoken, as its name and description. So a field error that is `role="alert"`
on a field the submit also focuses is heard twice: once as the alert and once in the field's
description. **The record proves the DOM changed. It does not prove a screen reader spoke.**

**The flows.** `announcements-public.spec.ts` runs signed out. `announcements-signed-in.spec.ts` signs in
per surface with `prepareSurface` and skips without a session.

**A known barrier splits a flow in two.** `knownFailure` passes on any failure, so a broken error link
would stay green under a hearing mark. A flow with a known barrier is two tests. The unmarked one
checks what works today: the error wiring, the focus move, and that the stub was hit or not hit. The
marked one holds only the hearing assertion.

| Flow | Asserts |
|---|---|
| The on-load recorder, on `/auth/login` | An alert added before `DOMContentLoaded` is recorded. A read after a reload throws |
| Login: link sent | "Check your email" heard once, by focus |
| Login: send failed | The error heard once, assertive |
| Login: bad email | Field wiring, focus on the field, nothing posted. Its error heard once by focus |
| `/updates`: joined, already on the list, failed | Heard once: by focus, then polite, then polite |
| Mailing-list band on the product page: joined, bad email | Polite once. Field wiring, focus, nothing posted. Its error heard once by focus |
| Home with `?ref=waitlist` | The banner shows. The welcome heard once, polite |
| `/claims/confirm`: sent, failed | "Claim sent" by focus. The error takes focus and the stub is hit. The error heard once, by focus |
| `/search`: a query, a query with no match | The count once, polite. "0 results" once, polite |
| Vendor portal preview: a Yes on an integration | Heard once from the shell's one channel, polite, never assertive. Still one channel after |
| Vendor portal preview: a Yes in "Data that's shared" with a change request open in Overview | Heard once, polite, never assertive. The open request stays open. Still one channel |
| Product claim form: empty submit | The name and email errors wired, focus on the name, nothing posted. Only its error heard |
| Review submission: sent, empty submit | "Review received" by focus. The rating and title errors wired, focus in the first rating, nothing posted. Only its error heard |
| Account: display name saved | The stub is hit and the message shows. Heard once, polite |
| Account: delete dialog | Focus moves in on open and back to the trigger on Escape |
| Account: delete confirmed against a stub that fails | The error heard once in the dialog, assertive. The dialog stays open |
| Account: delete confirmed against a stub that accepts | The page leaves for home. The sign-out that follows is aborted |
| `/admin/reviews`: approve, against a stubbed list and a stubbed approve | "Review approved." heard once, polite |
| `/admin/reviews` and `/admin/requests`: failed load, then Try again | The failure once, assertive. Both reads hit the stub and the empty queue shows. Loading and the empty queue heard once each, polite |
| Vendor portal: a section change | One polite channel, the same node after, nothing assertive |

"Form errors" means `aria-invalid="true"` on each failing field, an `aria-describedby` that names a
visible error, and focus on the first failing field. The Products dropdown count in checklist §2 is not
here: `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.11 replaced the dropdown with a link (AECI-2062).

**No real sends.** `.dev.vars` holds live Supabase and Resend keys. Every test calls `blockWrites`
(`support/announcement-flows.ts`) first, which aborts every request that is not a read, then stubs the
one write it answers. No write reaches the network, the local API included. The account delete and any
ban reach no real endpoint. The account delete is confirmed only against a stubbed
`DELETE /api/account`. Its handler erases the account and emails the person, and it is never reached.
The sign-out after a stubbed delete is aborted, so the shared test account stays signed in. The admin
tests stub the queue's list read and the approve, so no review is moderated.

**Not covered.** A deleted account leaves for the home page, a new document, and nothing there says the
account is gone. That is a page load, not a status message, so the recorder has nothing to check. The
manual pass still listens for it. A background revalidation in the vendor portal announces nothing by
design (`STAGE_2_REALTIME_SPEC.md` §6.2), so "a write elsewhere" is scripted as a write in one section
while another section's form is open.

**Pages outside the manifest.** `/updates`, `/claims/confirm`, `/search`, the product claim form and
`/preview/vendor-dashboard` are not in `surfaces.ts`. Adding them would widen the manual pass of
checklist §1 and put them under the keyboard suite. The flows that need them name their route, with
`flowAnnotations`, so the summary still names the page.

**Known failures on landing (2026-11-24).**

| Issue | What the record shows | Tests |
|---|---|---|
| AECI-1859 | A submit reveals several field errors, each `role="alert"`. Every error is spoken, not the focused field's | Claim form and review empty submit, hearing only |
| AECI-1858 | "Display name updated." is a `role="status"` inserted with its text already in it. Never heard | Account display name saved, hearing only |
| AECI-2079 | One message is `role="alert"` and also reached by focus. The claim-confirm error takes focus itself. A single field error describes the field the submit focuses. Heard twice | `/claims/confirm` failed, login and band bad email, hearing only |
| AECI-2080 | The waitlist welcome is added after hydration with no live region. Never heard | Home with `?ref=waitlist`, hearing only |
| AECI-2082 | The admin queues' loading and empty text are plain paragraphs, and Try again is removed while focused. Never heard | Try again on both queues, hearing only |

The signed-in flows ran with real test-user sessions, minted by `prepareSurface`. The failed-load
alert on both queues, the approve, review sent, the delete dialog and both stubbed confirms, and the
real vendor portal pass.

**Browsers.** These flows also run in Playwright's Firefox and WebKit (§8.4.10). Every flow activates
its control through `activate` (`support/announcement-flows.ts`), after the recorder starts. Chromium
and Firefox click, as before. In WebKit a click does not focus a button: focus goes to `main`, and the
record hears all of `main`, with or without the new message, by timing. So in WebKit the control is
reached by real Tab presses and activated by Enter, as a keyboard or screen-reader user does. The Tab
presses are in the record, because what a field announces when Tab leaves it is what that user hears. The login bad-email flow is a known failure in Firefox (AECI-2196): the click is lost because
the error moves the button. The record still proves only that the DOM changed.
No screen reader runs in any of the three.

**Run it** with the rest of the nightly, or alone:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts announcements --workers=1
```

Set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` to the port `dev:agent` printed, as for §8.4.

#### 8.4.5 Focus ring on every Tab stop (AECI-1878)

axe cannot tell whether a focus indicator can be seen. `e2e-a11y/focus-ring.spec.ts` looks at every Tab
stop of every surface in the manifest, public pages included. It covers WCAG 2.4.7, the focus part of
1.4.11, 2.4.11, and the control-boundary part of 1.4.11. It scripts the first line of
`docs/a11y-manual-testing-checklist.md` §2, "A visible focus indicator is present on every interactive
element".

**One walk.** Each surface gets one Tab walk, the keyboard suite's `tabWalk` (§8.4.1). The checks run in
its `onStop` hook, while the stop has focus. Nothing walks the page a second way, and nothing calls
`el.focus()`.

**The four checks.** Each stop is pictured twice with `page.screenshot`, clipped to the stop and 8px
around it: once focused, and once unfocused. The clip also takes in an ancestor that draws an outline
while the stop has focus, such as an interactive card. Pictures are taken at `scale: 'css'`, with
animations stopped and the caret hidden. Colours are read from computed styles and from pixels, never
from class names.

| Check | WCAG | Fails when |
|---|---|---|
| Visible | 2.4.7 | No pixel changes between the focused and unfocused pictures, once the changes that are not focus are left out (below) |
| Contrast | 1.4.11 | Too few changed pixels reach 3:1 against the same pixel unfocused. A changed pixel is the indicator, and the unfocused pixel is the ground it is drawn on. The 3:1 pixels must add up to a line 1 CSS px wide round the stop's on-screen sides. Changes that are not focus are left out here too |
| Not obscured | 2.4.11 | `elementFromPoint` at the centre of each on-screen box of the stop finds neither the stop nor something inside it. A link that wraps has a box per line. A visually hidden input is judged on its labels |
| Control boundary | 1.4.11 | A text field, select, combobox, checkbox or radio has no edge at 3:1 against the ground just outside it. The edge can be every border it has, its own fill, or, for a box the browser draws, its strongest pixel. The ground is the median pixel 2px outside the control, unfocused |

A Forest ring 3px wide on white gives about three times the pixels the contrast check needs. A ring that
vanishes on its ground, or a faint background tint, gives far less. Buttons and links are not boundary
checked: their text names them.

**The unfocused picture** of a stop is taken after focus has moved on to a stop whose ring is clear of
it. The page is scrolled back exactly to where the stop was focused, pictured, and scrolled forward
again. There is no scroll tolerance: a 1px shift turns every text edge in the clip into a strong pixel.
Scrolling moves no focus, so the walk goes on from the focused stop. The last few are pictured after the
walk with focus removed.

**Telling a ring from other changes** (review round 2). Leaving a stop can change the picture for
reasons that are not focus. A field renders its error text, turns its edge red, or content above it
shifts. Counted as the indicator, any of these would pass a stop with `outline: none`. So the stop and
every element whose box reaches into the clip are read twice, with each picture. Ancestors are left out:
a ring a card draws for its link is a ring. Then:

- **The stop must not move.** If its box, or the labels a hidden input is judged on, moved or resized by
  a hundredth of a pixel, the stop is not compared. It is `unmeasured`. The one exception is a stop that
  is visually hidden until focused, as the skip link is: its appearing is its indicator.
- **Other elements that changed are left out.** An element that appeared, went, moved, resized, or
  changed its attributes or its own text has its box left out of both pictures (`changedRegions` in
  `support/focus-pixels.ts`). An error message rendered on blur is one.
- **The stop's own box is left out when its own state changed.** If the stop's attributes or text, or
  its descendants', changed between the reads (`aria-invalid`, a touched class), a change inside its
  border box is not counted. A ring drawn outside the box still is. So a control that styles focus
  through a class it sets on focus, such as the CDK focus monitor's, is judged on what it draws outside
  its box. None does today.

A field whose only change on blur is its error text and red edge therefore fails "visible". Changed
pixels left out are named in the finding's detail. A change on blur that a parent element draws, such
as a wrapper turning its border red, still counts as the focus ring, because ancestors are left out of
the changed-element rule.

**Unmeasured stops.** Every stop that gets no verdict is counted in the `focus-stops-unmeasured`
annotation and named, with its reason, in a `focus-unmeasured` annotation. Two reasons are expected: an
iframe, which draws its own focus, and a stop with no box, which the keyboard suite already fails. Any
other reason is an `unmeasured` finding and fails the test, so the check cannot quietly measure fewer
stops (`EXPECTED_UNMEASURED` in `support/focus-check.ts`):

| Reason | Means |
|---|---|
| `focus moved before it was read` | The walk's stop and the focused element differ |
| `the stop moved or resized between its pictures` | Something shifted it, so its pictures cannot be compared |
| `the stop left the page before its unfocused picture` | It was removed |
| `the scroll position could not be restored` | The page or a scroll box cannot reach the focused position again |
| `focus never moved clear of the stop` | Every later stop's ring overlapped its clip |
| `no ground round the control` | The boundary check found no pixels outside the control |

On landing no surface had an unmeasured stop, in three runs.

**Stable results.** Before it reads a stop, the probe waits for finite animations on the stop and its
ancestors, then for the stop's box to hold still for two frames. Leaving a field can render its error a
frame later and push the next field down. The check judges where the stop ends up. Three one-worker runs
gave the same findings.

**The site header and footer** are the same components on every page. They are measured in full once
per persona, on the surface `headerOwnerFor` names (§8.4.1). Elsewhere their stops run only the obscured
check, which needs no picture.

**The code.**

| File | What it holds |
|---|---|
| `focus-ring.spec.ts` | One test per surface, `ALLOW_LIST` and `KNOWN_FOCUS_BARRIERS` |
| `support/focus-check.ts` | `measureWalk(page, checksSharedChrome)`: the walk, the two pictures, the verdicts, and the unmeasured reasons. The interaction suite reruns it under forced colours (§8.4.7) |
| `support/focus-probe.ts` | The in-page reads: the stop's box, the clip, the hit test, computed colours, the stop and the elements round it, scroll save and restore |
| `support/focus-pixels.ts` | Pure: the WCAG contrast ratio, a PNG decoder, the pixel rules, `changedRegions` and `sameRect`. Pinned by `focus-pixels.unit.spec.ts` against known colour pairs, in the plain Vitest runner |

**The allow-list.** `ALLOW_LIST` holds findings where the check is wrong about the element, each with its
reason. It is empty on landing. A real barrier never goes there.

**Known barriers on landing (2026-11-24).** `KNOWN_FOCUS_BARRIERS` has the same shape as the keyboard
suite's. A surface with a barrier gets a `known focus barriers: <check>` test, marked with
`knownFailure`. It passes while the finding is there and turns red when it is fixed. The walk test
ignores only the findings a barrier covers, so a new finding on the same surface still fails it.

| Issue | What the check finds | Surfaces |
|---|---|---|
| AECI-2097 | The vendor portal section nav clips the top and bottom of its links' focus ring. About half a 1px line reaches 3:1 | Both vendor portal surfaces |
| AECI-2098 | The portal Integrations filters, Search and "Integrates with", have a 1.22:1 edge on their `#FAFAFA` panel | Vendor portal integrations |

AECI-2100 came out of the same work but is not a known failure. After Tab, the review form's "Your
review" shows only its top 25px, partly under the consent banner. Part of it stays visible, so it passes
2.4.11 (AA). It fails the AAA version, 2.4.12, which the nightly does not check.

**Limits.** `elementFromPoint` skips an element with `pointer-events: none`, so an overlay that ignores
the pointer is not caught. The pictures are at 1280 by 720 only, in Chromium, Firefox and WebKit
(§8.4.10). Every browser's screenshot decodes with `decodePng` at `scale: 'css'`, and the canvas reads
`oklch()` colours in all three. A ring drawn by the browser itself, such as WebKit's `outline: auto`, is
drawn differently on macOS and on Linux, so a WebKit finding about it may not reproduce on the runner. The checks do not judge a ring's
shape or thickness beyond the pixel count, so WCAG 2.4.13 (AAA) is out of scope.

**Run it** alone with one worker:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts focus-ring --workers=1
```

Set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` to the port `dev:agent` printed, as for §8.4. It took
5.6 to 6.5 minutes on one local worker. The four listing pages take about 40 seconds each. The CI time
is not measured yet. Read it off the first nightly against the `suite` job's 30-minute limit.

#### 8.4.6 Magnification: reflow, zoom, text size, text spacing and orientation (AECI-1881)

`e2e-a11y/magnification.spec.ts` stands in for screen magnification on every surface in the manifest,
public pages included. It covers WCAG 1.4.4, 1.4.10, 1.4.12 and 1.3.4.

**Two loads per surface.** A page load is the slow part, so checks that cannot disturb each other share
one. Each surface gets two tests:

| Test | Load | Then |
|---|---|---|
| `narrow` | 390 by 844 | Orientation. Turn to 844 by 390, as a phone turns, and check orientation again. Resize to 320 by 640, load everything that renders on scroll, and check reflow. Then switch to 400% zoom and check that |
| `wide` | 1280 by 800, everything that renders on scroll loaded | Run the clip detector once as a baseline. Add 200% text and check. Take it away, add text spacing and check |

**The six checks.**

| Check | WCAG | Set-up | Fails when |
|---|---|---|---|
| Reflow | 1.4.10 | 320 by 640 | The page root's `scrollWidth` is more than `clientWidth + 1`, or an element inside the page scrolls sideways and `SCROLLER_ALLOW_LIST` does not cover it |
| 400% zoom | 1.4.10, 1.4.4 | 315 by 256 at four device pixels per CSS pixel: 400% of a 1280 by 1024 window, less a classic scrollbar (below) | The root scrolls sideways, or the clip detector finds anything |
| 200% text | 1.4.4 | `html { font-size: 200% }` | The clip detector finds anything |
| Text spacing | 1.4.12 | Line height 1.5, letter spacing 0.12em, word spacing 0.16em on every element, 2em after each `p` | The clip detector finds anything |
| Clip detector | the three above | Shared by them, in `support/magnify-geometry.ts` | Text is cut off, or text is painted over other text. Below |
| Orientation | 1.3.4 | 390 by 844, then 844 by 390 | `main` is not shown, `main` or any ancestor up to `html` is rotated or skewed (computed `transform` or `rotate`), or a script called `screen.orientation.lock` |

Playwright has no zoom API, and it sets the device scale only when a context is made. `emulateZoom`
sends the DevTools call Playwright itself uses, `Emulation.setDeviceMetricsOverride`, on the open
page, and the test asserts the page then reports `devicePixelRatio` 4 at 315px. The override lives as
long as its DevTools session, so it is the last step of the test. The scale changes rounding,
`resolution` media queries and image choice. The two checks also look at different things: reflow at
scrollers, 400% at clipped and overlapping text.

The root rule is the one in `e2e/no-sideways-scroll.ts` (§7.4): never equality, because the Linux
scrollbar gutter can make `scrollWidth` the smaller one (PR #1321). The issue allows 1px of rounding.
When the root does scroll, the test notes up to five boxes past the right edge, to find the source.

**The clip detector.** `readText` in `support/magnify-probe.ts` walks every text node with glyphs on
screen. For each it reads the line boxes (`Range.getClientRects()`) and the ancestors whose overflow is
not `visible`. It follows the containing-block rules, so an absolutely positioned or fixed box escapes
the ancestors it really escapes. The pure half decides:

- **Clipped.** A container with `overflow: hidden` or `clip` overflows on an axis
  (`scrollHeight > clientHeight`, or the width pair), and a line box of the text reaches past its
  padding box. Across, the line must reach more than 2px past. Down, more than a quarter of the line's
  height, because a line box is the font's content area and pokes out of a tight `leading-none` box with
  nothing cut. A container under 2px on either side is collapsed or `.sr-only` on purpose, so its text
  counts as hidden, not clipped. Text past a scroll container on an axis can be scrolled to, so a box
  further out does not count as clipping it on that axis. The finding names the kind: `line-clamp`,
  `ellipsis` or `hidden`.
- **Overlapping.** The visible parts of two text nodes' line boxes cross by more than 2px across and
  more than 30% of the shorter line's height. Only text in the same layer is compared, so the fixed
  consent banner over the page is not a finding. Scrolled-away text inside a scroller is not compared.

A problem string quotes the text with its digits masked, its element and the clipping container, the
component it belongs to, and the nearest `data-testid`, so the string is the same from run to run. The
component is read from the page, not from a test id: the nearest custom element, with the nearest `aec…`
attribute directive host in front when that is closer (`within aec-product-card-grid [aeccard]`).
Angular keeps a template's static attributes, so `aecCard` stays in the DOM as `aeccard`. In the `wide` test a problem that is
also there before any override says `(also at 100%)`. It still counts. `magnify-geometry.unit.spec.ts`
pins the decisions in the plain Vitest runner. jsdom has no layout, so the fixtures are the boxes
Chromium gives for the HTML each case names. The in-page reader is proven by the deliberate breakage
below, not by a unit test.

**It can fail.** On 2026-11-24 the home page passed clean, then each check was broken on purpose in a
throwaway run. `main h1 { max-height: 0.5em; overflow: hidden }` gave a `clipped (hidden)` finding at
400%, 200% and spacing. `main h1 { margin-bottom: -2.5em }` gave an overlap of the title and the lede at
all three. `main { min-width: 600px }` failed reflow and 400% with sideways scroll. `main { transform:
rotate(90deg) }` failed both orientations. A `nowrap` `overflow-x: auto` paragraph failed reflow as a
scroller. Letting the review form's side panel wrap turned its known barrier red. None of it was committed.

**Stable results.** `settleLayout` waits for web fonts, for every finite animation and transition, and
for the document's size and element count to hold over three samples 100ms apart, then for the app to
be stable. It runs after every resize and every style change. The tests run with `reducedMotion:
'reduce'`. Three one-worker runs gave the same findings. Every test stands alone, with no `beforeAll`
and no order: the fixture probe runs once per worker on first use, so a shard may take any of them.

**Scrollbars take no space.** Chromium draws classic scrollbars, 15 CSS px wide, on Linux CI. On macOS
a system setting picks overlay scrollbars, which take no space, or classic ones, and by default that
depends on whether a mouse is attached. Review round 2 (2026-11-25) found the same page 305px wide on
one day and 320px on the next, on the same machine, and three product names fitted at 400% zoom or did
not. `hideScrollbars` sets `scrollbar-width: none` on every element before the page loads, so every
run measures the same width on every machine. Scrolling still works.

**What that costs, and the 315px viewport (review round 3, 2026-11-25).** Hiding scrollbars would be
lenient for one reader: a Windows user with classic scrollbars at 400% zoom. As far as we can tell,
Chromium keeps a classic scrollbar at its own size when the page zooms, and it does not grow with the
page. At 100% scale the Fluent scrollbars Chromium announced for Windows and Linux in January 2025 are
15px wide, and the older ones 17px (the blink-dev thread
`groups.google.com/a/chromium.org/g/blink-dev/c/vabF61VwINk`). At 400% zoom on a 1280px window that is
3.75 to 4.25 CSS px, so the reader has 315.75 to 316.25 CSS px for content, not 320. So the 400% check uses a 315px viewport
with no scrollbar: the whole number at or below both. It is never more lenient than that reader, and at
most 1.25px stricter. Reflow stays at 320px: a phone and macOS draw overlay scrollbars that take no space,
and 320 CSS px is the WCAG 1.4.10 reference width.

What is tested and what is not:

- The width a classic-scrollbar Windows reader has at 400% is tested, to the nearest pixel below.
- Media queries see 315px where that reader's browser sees 320px. No rule in `apps/web/src` has a
  breakpoint between 300 and 329px, so nothing changes today. A new one would.
- Edge's own scrollbar width and Windows display scaling above 100% are not measured. The figures above
  come from Chromium's notes, not from a Windows machine.
- We have no Chrome document that says page zoom leaves a classic scrollbar's size alone. Mozilla's
  bug 1657549 says Chrome's scrollbars "don't normally change thickness on zoom-out", and Firefox
  behaves the same way. We relied on that.

Measured once on 2026-11-25, every surface's `narrow` test: at 316px one product name is cut on the
three listing pages, "Fixture Acme Connector". At 315px two are cut, "Bluebeam Revu (fixture)" as well.
At 320px none is. Nothing else on any of the 22 surfaces fails between 315 and 320px.

**The allow-lists.** Both are in the spec, each entry with its reason. A real barrier never goes there.

| List | Entry | Reason |
|---|---|---|
| `CLIP_ALLOW_LIST` | The product hero lede, `line-clamp-2` | Intentional. It is `aria-hidden` and repeats the start of the description, whose full text is in the About band of the same page |
| `SCROLLER_ALLOW_LIST` | The vendor page's products table, `vendor-products-scroller` | A data table that scrolls inside its own box at 320px. 1.4.10 excepts data tables. The entry holds only while the scroller still holds a table |

The browse table is not in the manifest: the listing surfaces load the card view. Checked by hand on
2026-11-24, `/products?view=table` at 320px scrolls inside `aec-product-table` and the page does not. At
700px, below `md`, it fits. If a table view joins the manifest, it needs an entry like the vendor table's.

**Known barriers on landing (2026-11-24).** `KNOWN_PROBLEMS` uses `expectOnlyKnownProblems`
(`support/known-barriers.ts`), narrowed by a pattern per issue. Every clip pattern names the component
it belongs to, and the rail pattern its `data-testid` too, so the same kind of cut anywhere else on a
marked surface is still a new problem. A fixed barrier turns its mark red. Review round 2 (2026-11-25)
proved both: a new ellipsis outside each anchored component failed, and fixing each one turned its mark
red.

| Pattern | Anchored on |
|---|---|
| `CARD_NAME` (AECI-1889) | `aec-product-card-grid [aeccard]`: a card in the product card grid |
| `FILTER_LABEL` (AECI-2106) | `aec-search-refinement-list`: a row of the filter panel |
| `TERM_DESCRIPTION` (AECI-2108) | `aec-browse-layout [aeccard]`: a term card, projected into the browse layout |
| `RAIL_VENDOR` (AECI-2107) | `aec-review-form` and `[data-testid="context-rail"]` |
| `MAILING_OVERLAP` (AECI-2105) | `[data-testid="mailing-list-card"]` |
| `NAV_ROW` (AECI-2109) | The row's own link names |

| Issue | What the check finds | Where |
|---|---|---|
| AECI-1889 | Product cards cut product and vendor names with an ellipsis: about 35 at 200% text, four already at 100%, two at 400% zoom | Listings at 400%, listings and term pages at 200% and spacing |
| AECI-2105 | At 200% text the mailing list card's text column shrinks to one word a line and the form paints over it | 13 public surfaces |
| AECI-2106 | At 200% text every browse filter label is cut to a few letters | Listings and term pages |
| AECI-2107 | The review form side panel cuts the vendor name | Review submission, at 400% and 200% |
| AECI-2108 | Taxonomy index cards clamp each description to three lines. A ruling: does the term page count as the full text? (`ACCESSIBILITY_AUDIT.md` §11.4 P2) | The three index pages, at every enlargement |
| AECI-2109 | Nav rows scroll sideways at 320px, by the house rule in `DESIGN.md`. A ruling: does that meet 1.4.10? | Product page section nav, both vendor portal tab rows |

The two rulings move their findings to an allow-list or to a fix. Orientation found nothing.

**The citation reflow checks stay in the PR suite.** `e2e/home.spec.ts` "printed citations" pins each
citation inside the viewport at five widths on every PR. Moving it here would drop that PR guard, and the
nightly's code must stay out of the PR job. Its page-root half already uses `expectNoSidewaysScroll`. A
comment above the block says so.

**What a real magnifier shows that these checks do not.** A screen magnifier enlarges pixels and shows a
small part of the screen. It follows focus and the caret. So a reader at 400% sees what is near focus
and nothing else. A toast or a status message far from its trigger is invisible to that reader. So is an
error printed above a form while focus stays on the submit button, and a change in a sticky bar at the
other edge. These checks enlarge the layout and look at the whole page. They never follow focus, so they
cannot see any of that. They also miss text in images, pixelated icons, and text that grows in `px` that
the 200% root size does not touch. Browser zoom scales `px`, so that last one is not a 1.4.4 failure, but
the check does not test it. The detector reads only text nodes, so it misses cut-off form values,
placeholders and SVG text. A cut made by `clip-path` or `contain: paint` instead of `overflow` is missed.
It sees one state per page: no open menu, no error state and no expanded panel is enlarged. At 315 by
256 a sticky header and the fixed consent banner can cover most of the screen, and nothing here checks
how much of the viewport is left for content. A reader can scroll the page but never past a bar that
stays put. The
overrides do not combine: text spacing runs at 1280px only, so `ACCESSIBILITY_AUDIT.md` §11.4 P3, 2px
of sideways scroll on home at 320px with spacing on, is not covered. A person with
a magnifier, ZoomText or macOS Zoom, still has to run the pass.

**The code.**

| File | What it holds |
|---|---|
| `magnification.spec.ts` | Two tests per surface, `CLIP_ALLOW_LIST`, `SCROLLER_ALLOW_LIST` and `KNOWN_PROBLEMS` |
| `support/magnify-probe.ts` | The in-page reads, the two style overrides, `settleLayout`, `emulateZoom`, `hideScrollbars`, the component host (`hostOf`) and the orientation-lock watch |
| `support/magnify-geometry.ts` | Pure: the clip and overlap rules, the root rule, the rotation rule, the problem strings. Pinned by `magnify-geometry.unit.spec.ts` |

**Run it** alone with one worker:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts magnification --workers=1
```

Set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` as for §8.4. Six local one-worker runs took 3.0 to 4.6
minutes for the 44 tests, with no skips. The slowest are the `wide` tests of the listing pages and the
review form, 5 to 18 seconds each, depending on machine load. The CI time is not measured yet.

#### 8.4.7 Interaction scripts (AECI-1882)

Some WCAG criteria describe behaviour, not markup, so no rule engine tests them. These scripts act on
the page and watch what it does. `e2e-a11y/interaction.spec.ts` runs checks 1 to 6 on every surface in
the manifest, public pages included. `e2e-a11y/interaction-flows.spec.ts` runs check 7 on four flows.

| # | Check | WCAG | Fails when |
|---|---|---|---|
| 1 | Content on hover | 1.4.13 | Content that hover shows closes when the pointer moves onto it, or Escape does not close it while the pointer is on it, or Escape moves focus. At 768px wide it also fails when the content pushes the page sideways or leaves the viewport (AECI-1846) |
| 2 | Pointer cancellation | 2.5.2 | A press on a control, a move off it and a release somewhere with nothing interactive changes the URL, loads a page, sends a write, opens a popup or flips a state |
| 3 | On input | 3.2.2 | Changing a form control changes the address, loads a page, opens a window or moves focus off the control, and the control is not on the on-input list |
| 4 | Character shortcuts | 2.1.4 | With focus on `body`, a key from a to z changes the URL, the title, the scroll, focus, the open popups or the page's text, or sends a write |
| 5a | Motion | 2.2.2 | An animation longer than 5 seconds, or endless, is still running on a drawn element 5 seconds after it started |
| 5b | Reduced motion | 2.3.3 (AAA), and 2.2.2 | With `reducedMotion: 'reduce'`, any animation or transition the page ran, from its first frame, lasted more than 100ms |
| 6a | Forced colours, axe | WCAG 2 A and AA rules | With `forcedColors: 'active'`, axe with the sweep's tags and exclusions (`e2e/axe-sweep.ts`) finds a gate violation |
| 6b | Forced colours, focus ring | 2.4.7, 1.4.11, 2.4.11 | With `forcedColors: 'active'`, the focus ring check of §8.4.5 fails on a Tab stop |
| 7 | Error prevention | 3.3.4 | The claim, checkout, account delete, reject, remove or ban writes with no confirm or review step first. Approve is a pending ruling (below) |

**How each surface runs.** Each surface is loaded twice, each time in a `beforeAll` that runs the
checks and records their problems. Each check is then its own test, which judges the record with
`expectOnlyKnownProblems` (§8.4.3), so a known barrier marks only its own check. Load A has the default
media and runs 5a, 4, 1, 2 and 3 in that order: the two that only read go first, and a check that
changes the page reloads it before the next. Load B has reduced motion and forced colours together and
runs 6a, 6b, then 5b, so 5b covers the load, the settle scroll and every focus move of the walk. Each
describe is `mode: 'default'`, so it stays on one shard and a failed test re-runs the hook for the
tests left (§8.4 "Shards"). Each describe also sets `retries: 0`. The findings are deterministic, so a
retry adds nothing, and in CI (`retries: 1`) it would run the whole surface load again. A regression in
a shared component could fail many loads at once and push a shard toward its 30-minute limit on the
night the summary matters most. The site header and footer are checked once per persona for checks 1 to 3
(`headerOwnerFor`, §8.4.1).

**How a control is found.** No list is kept by hand.

- Check 1: an init script (`support/interaction-probe.ts`) marks every element that registers a
  `mouseenter`, `mouseover`, `pointerenter` or `pointerover` listener. Angular binds a template's
  `(mouseenter)` with `addEventListener`, so every hover panel in the app is found. Each one is pointed
  at, and the new content is what was drawn after the hover and not before. The pointer then moves onto
  the largest new element whose centre takes the pointer. Each load records an annotation with the
  number of triggers checked and the number of listeners passed over because their element has no
  box, so a surface where the check found nothing says so.
- Check 2: one activatable control of each kind (component, landmark, role, and the name for anything
  but a link), up to 60 a surface. A press that changed something is run again from a fresh load as
  the same pointer path with no press, and only what the press added counts. A control that opens on
  hover (the admin nav, the Browse menu) changes the page either way. Both runs dwell on the control
  for 400ms first, so a hover timer fires in both.
- Check 3: one form control of each kind in each component: one box of a filter group, one select,
  one text field. A form with three text fields has its first one changed. Each is changed once by
  keyboard: Space for a box, the next option for a
  select, Enter, ArrowDown and Enter for a select-only combobox, one typed letter for a text field. The
  check focuses the control with `focus()`, because it tests the change, not how focus got there.
- Check 7: the flows are scripted by hand (below).

**Pending rulings.** Two kinds of finding wait for Chris. Both pass today and assert exactly what
happens now, so a change in either direction turns a test red.

Check 3's on-input list is `ON_INPUT_LIST` in `support/on-input-list.ts`. A listed control may change
the page the way its entry says. An entry that stops matching turns the test red. Every entry is
**pending Chris's ruling**:

| Entry | Surfaces | What it does on change | Status |
|---|---|---|---|
| `facet-filters` | `/products` and the three browse pages | A facet box filters the results at once and writes the filter to the address (`?categories=…`). Focus stays on the box | Pending Chris's ruling |
| `listing-sort` | The same | Choosing a sort reorders the results at once and writes it to the address (`?sort=…`) | Pending Chris's ruling |
| `portal-integration-filters` | Vendor portal integrations | The Search box filters as you type, and "Integrates with" on change. Both write the filter to the address | Pending Chris's ruling |

No control on any surface loads a new page, opens a window or moves focus on change. The sort on
`/categories`, `/audiences` and `/phases` reorders in place and does not write to the address, while
the sort on the listing pages does. That is a difference under `DESIGN.md` "The Same-Behavior Rule",
reported to Chris, not decided here.

Check 7's Approve is the other: one click on Approve sends the approve, with no confirm step and no
undo (AECI-2121). The test asserts one click, one call to the stub and no dialog, and carries the
annotation "pending Chris's ruling, AECI-2121". If Chris rules that Approve needs a confirm, the test
changes then.

**Check 7, the flows.** Each test proves the step is there and stops on it. `blockWrites` runs first,
so no write reaches the network, the local API included. A count of every write the page tried is how
"nothing was sent yet" is checked.

| Flow | Where | What proves the step | What is never pressed |
|---|---|---|---|
| Claim, signed out | `/products/:slug/claim`, then `/claims/confirm` | The submit sends only `POST /api/requests/claim`, answered by a stub, and the receipt says the claim is not sent until the emailed link is clicked. The confirm page sends nothing on load and shows "Confirm and send" | "Confirm and send" |
| Checkout: pay by card | `/vendor/:slug/billing` | The only submit is "Continue to Stripe", and the form says the plan is accepted on Stripe's page | "Continue to Stripe" |
| Checkout: add subscriptions | The same | The button opens a dialog that states the charge, with its own submit and Cancel. Opening and closing it sends nothing | The dialog's submit |
| Account delete | `/account` | The button opens "Delete your account?" with "Delete my account". Opening and closing it sends nothing | "Delete my account" |
| Reject | `/admin/reviews` | Reject opens a reason and "Confirm rejection". Nothing is sent | "Confirm rejection" |
| Remove | The same, Approved tab | A reason, then "Continue to removal", then "Remove permanently". Nothing is sent | "Remove permanently" |
| Ban | The same | A stubbed reject raises "Ban reviewer", which opens a dialog with a reason and "Confirm ban". Only the stubbed reject was sent | "Confirm ban" |
| Approve | The same | One click sends the approve, to a stub, with no confirm step. Pending Chris's ruling (AECI-2121) | Nothing else |

The checkout tests reach no Stripe route and no route that creates a Checkout Session or charges a
card. The vendor test account is a member seat and the local API has no Stripe key, so three reads are
answered in the browser: the billing page's transfer state with `seat_owner` set, `GET
/api/vendor/billing` with Stripe on, and the empty list of accepted agreements. The moderation tests
run over a stubbed queue list, so no real review is touched.

Not covered:

- A signed-in claim whose email matches the session goes straight in, with no confirm step
  (`createClaimSubmitHandler` in `apps/api/src/routes/requests.ts`). The server makes that choice, so a
  browser stub cannot test it without the real write.
- The signed-out claim's emailed confirm is the server's choice too. The test's own stub answers
  `confirmation_required: true`, so the test proves the page shows the confirm step when the server
  asks for it. It does not prove the server asks.

**Known barriers on landing (2026-11-24).** `KNOWN_INTERACTION_BARRIERS` in `interaction.spec.ts`:

| Issue | Check | What the check finds | Surfaces |
|---|---|---|---|
| AECI-2119 | 1 | Escape does not close an admin nav dropdown opened by hover, at both widths | Both admin surfaces |
| AECI-2120 | 2 | A press on "Browse" dragged off and released leaves the Browse panel open | The header owner of each persona |
| AECI-2097 | 6b | The vendor portal section nav clips its links' focus ring, in forced colours too. The mark covers only a strong ring that is too short (`isClippedPortalRing`), so any other contrast finding on those links still fails | Both vendor portal surfaces |

AECI-2099 (a click closes what hover opened) is why checks 1 and 2 never click a hover trigger.

**Limits.**

- **Forced colours is an emulation.** Chromium's `forcedColors: 'active'` applies its own fixed
  palette, not a real Windows contrast theme, and does not follow the reader's chosen colours. A pass
  here means the page survives forced colours in Chromium. The manual pass still checks a real theme.
- The contrast rules (`color-contrast`, `color-contrast-enhanced`) are off in 6a. Under forced colours
  the reader's palette replaces the author's colours, so those rules measure colours nobody sees. The
  sweep checks contrast with forced colours off (§8.2). An element with `forced-color-adjust: none`
  keeps its own colours and is not checked for contrast here. Today's uses in `styles.css` and
  `shared/meter/meter.ts` paint system colour pairs (`Highlight` on `HighlightText`, `CanvasText` on
  `Canvas`), so they follow the reader's theme.
- Check 1 finds hover content shown by a script listener. A reveal done in CSS alone, with `:hover`
  showing a hidden element, is not found. The app has none today. Content shown on focus alone is the
  keyboard suite's (§8.4.1).
- Check 2 does not look at text fields or native selects: they are not in its selector, because they
  have no pointer function. It also passes over a control whose centre is covered or that has no free
  point near it, and those skips are in the test's annotations.
- Check 5 sees CSS and Web Animations. A video, a GIF, a canvas drawn by script, or a carousel that
  swaps its slides by script with no CSS animation is not seen.
- Checks 1 to 6 run in Chromium at 1280 by 720, and check 1 also at 768 by 1024.

**Run it** alone with one worker:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts interaction --workers=1
```

Set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` to the port `dev:agent` printed, as for §8.4. The two
specs hold 185 tests and took 15.2 to 17.4 minutes on one local worker, on a busy machine. The 44
loads average 23 seconds. The slowest is `/admin/reviews` with the default media, at about 75 seconds:
its hover check opens five panels at two widths. Each judge test reads the time of its load in the
`interaction-load-seconds` annotation. The CI time is not measured yet. Read it off the first nightly
against the `suite` job's 30-minute limit, since this is one of the suites `docs/CICD_PLAN.md`
§11a-quater sized the eight shards for.

#### 8.4.8 Voice control and switch stand-ins (AECI-1883)

Real sessions with Dragon, Voice Control, Voice Access or a switch are out of reach in CI.
`e2e-a11y/voice-control.spec.ts` stands in for them on every surface in the manifest, public pages
included. It covers WCAG 2.5.3 and 1.3.5, reports 2.5.8, and measures how many presses a switch or
keyboard user spends before the task starts.

**Two tests per surface,** plus one that checks every surface has a primary action:

| Test | Load | Then |
|---|---|---|
| `controls` | Everything that renders on scroll loaded (`openSurface` with `settle`) | Read every rendered control once. Run checks 1, 2 and 4, which fail the run. Record check 3, which never does |
| `effort` | The same load | Check 5: Tab from load to the primary action with the keyboard suite's `tabWalk` |

**The five checks.**

| Check | WCAG | Fails when |
|---|---|---|
| 1. Label in name | 2.5.3 | A control shows text, and its accessible name does not contain that text, word for word and in order |
| 2. Unique names | (voice) | Two controls share a name and do different things, and at least one of them is not a link |
| 3. Target size | 2.5.8 | Never. axe's `target-size` rule. Each finding goes to the summary as `fails` or `review` |
| 4. Input purpose | 1.3.5 | A text field that collects the user's email, name, display name, organisation, job title, phone, web address, postal code, country or street address has no `autocomplete` token for it. `off` and a wrong token fail too |
| 5. Effort | (switch) | The Tab presses from load to the primary action exceed the baseline by more than the margin, or the walk never reaches it |

**How a control is read.** `readControls` in `support/voice-probe.ts` marks every rendered control,
reads its DOM facts, and joins Chromium's accessibility tree over DevTools by backend node id. The role
and name come from that tree, because it is what the platform hands to a voice-control product. The
visible label comes from the page:

- A button, link, tab, option or summary shows its rendered text. A text field, select, checkbox or
  radio shows the rendered text of its `<label>`. A button input shows its value. A field with no
  `<label>` shows nothing, and is not judged.
- Text is visible when it has a box on screen and no ancestor hides it: `visibility`, `opacity: 0`, or
  the `.sr-only` pattern (a clipped box under 2px). Text inside a nested control is not this control's.
- Two text pieces that sit apart on screen, on another line or with a gap, read as two words even when
  the DOM has no space between them. That is how AECI-1469's "Change billing email" lost its space.
- An `aria-hidden` piece of one or two characters is an icon, not a label: a logo's initial tile, a
  count badge, an "i" info mark. Nobody says "click F".

The comparison is `nameContainsLabel` in `support/voice-names.ts`. Both texts are case-folded, spacing
is collapsed and punctuation dropped, then the label's words must appear in order in the name.
`support/voice-names.unit.spec.ts` pins it, whitespace and case included, in the plain Vitest runner.
No rule orders by name, so nothing calls `localeCompare`.

**What "different things" means.** A link does what its target says, so two links to one page are one
action. A control with `aria-controls` does what it controls. A submit button submits its form. A
`<summary>` opens its `<details>`. Two controls with none of those count as different. `SAME_ACTION`
in the spec lists the pairs that do the same thing after all, by exact problem string and with a
reason. Today it has one entry: home's header search and hero search are the same widget and both land
on `/search`. An entry that matches nothing fails the test. A real barrier never goes there.

**Who owns which rule.** Each finding is reported once:

| Finding | Owner |
|---|---|
| Two links with one name and different targets | ARIA suite `link names` (§8.4.3). Check 2 skips a group made only of links |
| A name shared by a button, field or tab and anything else | Check 2 |
| One target named differently on two pages | ARIA cross-page `link names` (§8.4.3) |
| Visible text missing from the name, on the manifest surfaces | Check 1. It fails the run |
| The same, on every e2e test's end state | The sweep's report-only `label-content-name-mismatch` row (§8.4.2). It never fails |
| A small target, on the manifest surfaces at load | Check 3, in the summary's `voice` block |
| A small target, on every e2e test's end state | The sweep's report-only `target-size` row |

The sweep and checks 1 and 3 look at different states, so the counts do not add. On the day this
landed the two disagreed in a known way. axe flagged 22 nodes on home alone: the category chips, named
"BIM Authoring 2 products" with a visible "BIM Authoring" and a "2" badge. Check 1 passes them, because
every visible word is in the name, in order. The chips are on many pages the e2e suite visits. We have
not counted how much of the sweep's 647 nodes they make up. Read check 1 for the verdict. Read the
sweep's row for states the manifest does not reach.

**The primary actions and the baseline.** The primary action is the first control of the task a person
comes to the page for. That is a judgement. `PRIMARY_ACTIONS` in the spec writes each one down, with its
baseline: the Tab presses from load to it on a freshly seeded D1, measured on 2026-11-24.

**How a target is matched.** Each action is matched by what it is, never by "the first link in `main`".
A matcher names the role, the component it sits in, and its name or link target, and the stop must be
in `main`. The component is an `aec-*` host element or a `data-testid` on the chain from the stop up to
the document. The walk's `onStop` hook reads that chain at each stop, and `until` matches on it. So a new
link or button that lands in `main` ahead of the action does not match. The walk counts it and goes on
to the real action, and the extra press shows in the change. A target that matches no stop ends the walk
as `not-reached`, which fails the test. The effort row records the stop it matched in `matched`.

| Surface | Primary action | Matched by: role, within, then name or target | Baseline | Margin |
|---|---|---|---|---|
| `home` | The hero search box | combobox, `aec-home-hero`, name "Search" | 8 | 3 |
| `product-detail` | The "Sign in to review" link in the hero | link, `aec-product-hero`, name "Sign in to review", target `/auth/login?…` | 12 | 3 |
| `review-submission` | The first star rating | option, `aec-review-form`, name "1 star" | 9 | 3 |
| `login` | The email field | textbox, `aec-login-page`, name "Email" | 9 | 3 |
| `account` | The display name field | textbox, `aec-account-page`, name "Display name" | 14 | 3 |
| `admin-reviews` | The first Approve button | button, `aec-review-queue`, name "Approve" | 23 | 5 |
| `admin-requests` | The "Open" filter of the first queue. The seed has no request rows | button, `aec-request-queue`, name "Open" | 12 | 3 |
| `vendor-products` | The first product card | link, `aec-vendor-product-list-page`, target `/vendor/<slug>/products/<slug>` | 17 | 4 |
| `vendor-integrations` | The first integration row | link, test id `integration-row-*`, target `/vendor/…/integrations/<uuid>` | 28 | 6 |
| `product-index`, `vendor-index`, `integration-index` | The first result card | link, `aec-product-card-grid`, target `/products/<slug>` | 38 | 8 |
| `vendor-detail` | The first of the vendor's products | link, test id `vendor-products-scroller`, name "View …", target `/products/<slug>` | 14 | 3 |
| `integration-detail`, `product-pair` | The "View listing" link | link, `aec-products-pair`, name "View listing …" | 17 | 4 |
| `category-browse` | The first result card | link, `aec-product-card-grid`, target `/products/<slug>` | 18 | 4 |
| `audience-browse` | The first result card | the same | 22 | 5 |
| `phase-browse` | The first result card | the same | 21 | 5 |
| `categories-index`, `audiences-index`, `phases-index` | The first term card | link, `aec-taxonomy-index`, target `/categories/<slug>`, `/audiences/<slug>` or `/phases/<slug>` | 10 | 3 |
| `not-found` | The "Go home" link | link, `aec-not-found`, name "Go home", target `/` | 13 | 3 |

No baseline changed when the matchers were tightened on 2026-11-25. Each new matcher picks the same stop
the old "first link" or "first button" picked, at the same press.

**The margin** is three presses, or a fifth of the baseline when that is more (`effortMargin`). One new
link in the shared header adds a press to every surface and passes. A new block of links or filters
ahead of the task fails. A fifth scales with the page: a listing reaches its first card after 25 filter
checkboxes, so one more facet value there is not a regression, and one more facet is. Fewer presses than
the baseline pass. The summary shows the change, so update the baseline in the same change that moved
it, and say why. Three one-worker runs gave the same count on every surface. A count that changes
between runs is a bug in the test, not in the page.

**What check 4 judges.** The `controls` test lists every text-entry field it reads, as one
`input purpose judged` annotation each and as the summary's `inputPurpose` record. Each field shows the
purpose it was held to, or "no purpose, not judged". So a green run can be told from a run that judged
nothing. The purposes are the ones WCAG 1.3.5 lists that this app's forms collect: email, phone, first
and last name, display name, name, organisation, job title, web address, postal code, country and
street address. The app has no password field, because sign-in is a magic link or Google. A
one-time code is not in the WCAG list. So neither has an entry.

On 2026-11-25 the check saw 49 text fields on the 22 surfaces and held 18 of them to a purpose, on 16
surfaces. All 18 carried the right token:

| Surfaces | Fields held to a purpose |
|---|---|
| The 13 public pages with the mailing list band, and `login` | "Email address" or "Email": `email` |
| `account` | "Display name": `nickname`. "Firm name": `organization`. "LinkedIn profile": `url` |
| `review-submission` | "Your firm (optional)": `organization` |
| `home`, `admin-reviews`, `admin-requests`, `vendor-products`, `vendor-integrations`, `not-found` | None. Their only text fields are search and filter boxes |

The other 31 fields have no purpose to check: the header search on every page, the hero and pair
finder search boxes, the portal and audience filter boxes, the review headline and body, and the
"Years using this product" number. So on six surfaces "found nothing" means check 4 had nothing to
judge, not that it judged and passed.

**Fields inside dialogs are not read.** Check 4 reads the page at load, so a field that only appears in
a dialog is not judged. No dialog on a manifest surface holds a field about the user: the account delete
dialog has no field, and the ban dialog on `/admin/reviews` (`support/overlay-scenarios.ts`) asks about
the banned reviewer. The claim dialog has organisation and web address fields, but it opens from
`/vendor-program` and `/docs/vendors/plans`, which are not in the manifest. That is a gap.

**The summary.** The `controls` test writes a `voice-target-size` and a `voice-input-purpose`
annotation, and the `effort` test a `voice-effort` one. `summary-reporter.ts` folds them into the
summary's `voice` block with `summarizeVoice` (`support/voice-summary.ts`, pinned by its unit spec).
Each shard writes its own. The merge combines them with `mergeVoice`
(`scripts/a11y-nightly-merge-summary.mjs`), and the job summary gets an effort table, a target size line
and an input purpose line. Adding the block, and later `inputPurpose` and `effort[].matched`, kept
`schemaVersion` 1.

| `voice` field | Meaning |
|---|---|
| `effort[]` | One row per surface: `surfaceId`, `route`, `action`, `presses` (`null` when not reached), `baseline`, `margin`, `change`, `verdict` (`same`, `fewer`, `more`, `over-margin` or `not-reached`), and `matched`, the stop the walk matched |
| `targetSize.surfaces`, `targetSize.targets` | Surfaces measured, and findings across them |
| `targetSize.bySurface[]` | `surfaceId`, `route`, and `targets[]`: axe's `target`, a `verdict` (`fails` measured, `review` when axe could not decide), and `why` |
| `inputPurpose.surfaces`, `.fields`, `.judged` | Surfaces read, text fields seen, and fields held to a purpose |
| `inputPurpose.bySurface[]` | `surfaceId`, `route`, and `fields[]`: `field`, `type`, `landmark`, `purpose` (`null` when not judged), `wants`, `has`, `ok` |

**Known barriers on landing (2026-11-24).** `KNOWN_PROBLEMS` uses `expectOnlyKnownProblems`
(`support/known-barriers.ts`), narrowed per issue. A new problem on a marked surface still fails, and a
fixed one turns its mark red. All five are check 2. Check 1 found nothing. Check 4 found every field it
judged right (above). Check 3 reported nothing on any surface: the 44px button floor in `DESIGN.md`
clears 24px.

| Issue | What the check finds | Surfaces |
|---|---|---|
| AECI-2114 | Both star ratings name their options "1 star" to "5 stars" | `review-submission` |
| AECI-2115 | "Delete account" names the account nav link and the button that opens the delete dialog | `account` |
| AECI-2116 | The three request sections share the filter names "Open" and "Declined" | `admin-requests` |
| AECI-2117 | The portal's integration filter is named "Search", the same as the site search | `vendor-integrations` |
| AECI-2118 | "Construction Management" is a category and an audience, so two filter checkboxes share it | `product-index`, `vendor-index`, `integration-index`, `phase-browse` |

`NOT_ABOUT_THE_USER` lists text fields 1.3.5 does not cover because they collect something about another
person or a company. It is empty on landing.

**It can fail.** On 2026-11-24, on `/auth/login`, each check was broken on purpose in a throwaway run.
An `aria-label` of "Emailme a sign-in link" on the "Email me a sign-in link" button failed check 1.
Renaming the consent banner's Decline to a second "Accept" failed check 2. `autocomplete="off"` on the
email field failed check 4. Two empty 12 by 12px buttons 2px apart came back from check 3 as `fails`,
and the run stayed green. Four extra buttons at the top of `main` took the email field from 9 presses to
13 and failed check 5 above its margin of 3. One 12px button with its icon still inside came back as
`review` ("overflow content"), which is why the report keeps axe's undecided results. On 2026-11-25, on
`/products`, a link to `/products/zz-inserted` put at the top of `main` did not match the first result
card. The walk went on to the real card, at 39 presses, and recorded "more". With the card grid removed,
the walk closed without a match and the test failed as not reached. None of it was committed.

**What real voice and switch sessions show that these checks do not.**

- Each voice product matches speech against names its own way, and each mishears some words. The
  checks prove the words are in the name. They do not prove a person can say them and be understood.
- The checks read one state per page at load. A menu, a dialog or an error state is not read. A
  voice user meets all of those.
- Check 2 decides "different things" from the DOM. It cannot see that two controls with one name do the
  same thing, or that two with different names are confusing. Hover-only controls and drag-only
  gestures are out of its sight too.
- Check 1 skips a field with no `<label>` and a control with no text. A voice user must then guess a
  name they cannot see, or fall back to "show numbers" or a mouse grid.
- A switch user scans, often in groups, at a timed rate. The effort count is Tab presses in a straight
  line. It says nothing about scanning speed, grouping, timeouts, or how a long press or a held key
  behaves.
- Check 4 decides the purpose from the field's name. It does not prove that the browser or a password
  manager fills the field.

A person with Dragon or Voice Control and a person with a switch still have to run those sessions.

**The code.**

| File | What it holds |
|---|---|
| `voice-control.spec.ts` | Two tests per surface, `PRIMARY_ACTIONS`, `SAME_ACTION`, `NOT_ABOUT_THE_USER` and `KNOWN_PROBLEMS` |
| `support/voice-probe.ts` | `readControls`, the DOM read and the DevTools join, and `readTargetSize`, axe's `target-size` rule |
| `support/voice-names.ts` | Pure: the name comparison, checks 1, 2 and 4, the action keys, the effort margin and verdict |
| `support/voice-summary.ts` | Pure: the `voice` block and its annotations |

**Run it** alone with one worker:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts voice-control --workers=1
```

Set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` as for §8.4. Three local one-worker runs took 2.0 to 2.4
minutes for the 45 tests, with no skips. No test took more than about 10 seconds. The CI time is not
measured yet.

#### 8.4.9 IBM Equal Access, a second rule engine, report only (AECI-1884)

Each accessibility engine finds some issues the others miss. `e2e-a11y/ibm-equal-access.spec.ts` runs
IBM's Equal Access engine next to axe on every surface in the manifest, public pages included. **It is
report only.** Nothing it finds fails the run, and axe remains the gate (§8.3). Whether to gate on it,
keep it as a report, or remove it is Chris's ruling, after two weeks of nightly data (below).

**The package is `accessibility-checker-engine`, pinned to exactly 4.0.35.** It is a dev dependency of
`apps/web` only. Version 4.0.35 carries IBM's rule archive `13November2026` and the ruleset
`IBM_Accessibility` (IBM Accessibility 7.3, which covers WCAG 2.2 A and AA). Nothing the PR e2e job runs
imports it. Vetted on 2026-11-24:

| Question | Answer |
|---|---|
| Licence | Apache 2.0. The full text is `LICENSE` in `github.com/IBMa/equal-access`. The tarball ships none, only the `ace.js.LICENSE.txt` header and the `license` field. A dev dependency we do not redistribute is fine in a public repo |
| Install scripts | None. No `preinstall`, `install` or `postinstall`, and no dependencies. The lockfile gained this one package |
| Network at run time | None. `ace.js` holds no `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `importScripts` or script injection. Its three hostnames are strings: help links (`able.ibm.com`), spec links, and a font name map |
| Offline and pinned | Yes. The spec reads `ace.js` from `node_modules` and evaluates it in the page, as `@axe-core/playwright` does with axe. The rules are the ones in the installed version |
| `pnpm audit` | No change: 19 low, 91 moderate, 84 high, 4 critical before and after |

**Why not the `accessibility-checker` package the issue names.** That is IBM's wrapper around the same
engine, and it fails the issue's network rule:

- At run time it downloads the engine (`ace.js`) and the rule list (`archives.json`) from jsDelivr. Its
  default `ruleServer` is `cdn.jsdelivr.net/npm/accessibility-checker-engine`, with rule archive
  `latest`. It writes the downloaded `ace-node.js` to a temp folder and `require`s it in Node.
- It sends scan counts and times to `able.ibm.com/tools/api/pub/meter/v2` (`ACReporterMetrics`).
  `perfMetrics: false` turns that off at start, but `ReporterManager.setConfig()` adds the metrics
  reporter again without checking the setting.
- Its `postinstall` runs `ibmtelemetry` from `@ibm/telemetry-js`, which reports the installing
  project's dependencies to `www-api.ibm.com/ibm-telemetry/v1/metrics`. pnpm 10 blocks it here, because
  it is not in `onlyBuiltDependencies`.
- It pulls in `puppeteer` and `chromedriver` at version `*`, and both download a browser on install.

The engine package has none of these, and it is the code the wrapper downloads. Siteimprove Alfa, the
issue's fallback, was not needed.

**Proof that no page data leaves the runner (2026-11-24).** One full run with the browser behind a
logging proxy (every non-loopback request) and a Node preload that logged every outbound socket:

- The browser made **no** request to any host other than the local app.
- The Node test process made two connections, both to the project's Supabase host. They are the
  sign-ins `prepareSurface` already makes for the admin and vendor test accounts.
- Nothing went to jsDelivr, unpkg, `ibm.com` or `mybluemix.net`.
- A deliberate visit to `example.com` through the same proxy was logged, so the logger works.

The spec keeps a narrower guard on every run. The window opens before the engine is injected and
closes after both axe and IBM have run. In that window it records:

- every request the browser context reports (`context.on('request')`): the page, its frames, and the
  workers Chromium reports there;
- every WebSocket the page opens (`page.on('websocket')`). A WebSocket never fires `request`.

It fails on any HTTP or WebSocket URL to another origin. `data:` and `blob:` URLs stay in the page, so
they do not count. It does not see requests from the Node test process, or traffic Chromium never
reports to Playwright, such as DNS prefetch and WebRTC. The one-off proof above covered the Node
process. Nothing covers the other two. `ace.js` has no WebRTC code and creates no `link`, `script`,
`img` or `iframe` element, so it cannot start them.

**One test per surface.** It loads the surface with `openSurface` and `settle`, as §8.4.8 does, with
`guardWrites` on. On that one state it injects the engine, runs axe with the e2e sweep's tags and
`EXCLUDED_DOM` (§8.2), then runs the IBM engine. Results inside `EXCLUDED_DOM` are dropped from both.
The test fails only when the scan cannot be trusted, or when the guard above trips:

- The surface did not render. `openSurface` checks its expected status, and the test checks one
  visible `h1`, as `surfaces.spec.ts` does. Without this an error page would pass, because IBM's rules
  on `html`, `head` and `title` still return results there.
- The engine did not run: it failed to load, threw, or no rule returned a result, not even a pass.

A broken scan must not read as a clean one.

**The three lists,** grouped as IBM's own reports group them:

| List | IBM levels | In the job summary |
|---|---|---|
| Violations | `violation` (a rule failed) | A table, open |
| Needs review | `potentialviolation`, `manual` | Collapsed |
| Recommendations | `recommendation`, `potentialrecommendation` | Collapsed |

**The overlap with axe.** `matchAxe` in `support/ibm-overlap.ts` matches an IBM finding to an axe node
on the same state when the node passes both tests. This is a judgement, so here it is in full:

1. **Same element.** The two elements are one, or one holds the other at most two levels down
   (`MAX_DEPTH_GAP`). Both engines often report one problem on a field and its wrapper. Both XPaths come
   from one helper the spec injects, so they compare as strings.
2. **Same problem.** The two rules share a WCAG success criterion, or the pair is listed in
   `RULE_PAIRS`. IBM's criteria come from its ruleset's checkpoints. axe's come from its `wcagNNN`
   tags. axe's best-practice rules have no criterion, so they match only through `RULE_PAIRS`. Today the
   list has two pairs, each with its reason: `aria_landmark_name_unique` with `landmark-unique`, and
   `aria_content_in_landmark` with `region`.

**Failed and review only are counted apart.** The record names each matching axe rule, with
`(review)` after one that only marked the node for review (an axe "incomplete"). `axeVerdict` reads that
list:

| How axe saw it | Meaning | On the unique list |
|---|---|---|
| Failed | At least one matching axe rule failed the node | No |
| Review only | axe matched it, but only marked it for review | Yes, labelled "axe review only" |
| Not in axe | No axe node matched | Yes |

An IBM violation that axe could only mark for review is not overlap. axe did not call it a failure, so
it stays on the unique list.

**The rule errs both ways.** Each direction has a cost:

- **Overlap overstated, so the unique list is too short.** This hides a finding only IBM makes, which is
  the failure a second engine exists to catch. Causes: a broad criterion such as 1.3.1 on a high element
  matches an unrelated axe node up to two levels below it, and two different problems on one element
  under one criterion count as one.
- **Overlap understated, so the unique list is too long.** This costs triage time and makes IBM look
  more useful than it is. Causes: an axe node whose selector no longer resolves in the page is dropped
  before matching (`runAxe` in `support/ibm-engine.ts`), an element and its holder more than two levels
  apart never match, and two rules for one problem that map to different criteria miss unless
  `RULE_PAIRS` lists them.

The two-week note should sample both by hand: unique findings that axe did report, and matched findings
that are different problems. `support/ibm-overlap.unit.spec.ts` pins the rule.

**What it found on landing (2026-11-24).** Seven one-worker runs, on two freshly seeded local D1s,
gave the same findings on all 22 surfaces, with no skips: 40 violation nodes, 452 needing review and
34 recommendations. Review round 2 (2026-11-25) split the overlap, and three more runs gave the same
findings:

| Violations | Failed in axe | axe review only | Not in axe | Unique (not failed in axe) |
|---|---|---|---|---|
| 40 | 0 | 9 | 31 | 40 |

axe failed none of IBM's violations. The 9 it matched are `aria_id_unique` dialog triggers that axe only
marked for review (`aria-valid-attr-value`). A first read of the 31 axe did not report at all:

| IBM rule | Nodes | Surfaces | First read |
|---|---|---|---|
| `aria_role_valid` | 26 | all 22 | Looks false. The search boxes are `<input type="search" role="combobox">` with no `list` attribute, and ARIA in HTML allows `combobox` there |
| `aria_form_label_unique` | 2 | `account` | Looks false. The two `<form>` elements have no accessible name, and an unnamed `form` is not a form landmark |
| `aria_landmark_name_unique` | 2 | `account` | Looks false, for the same reason |
| `aria_id_unique` | 1 | `vendor-integrations` | Borderline. The create toggle's `aria-controls` names a form that is not rendered while it is collapsed. axe passes that case on purpose. The other 9 nodes of this rule are dialog triggers that axe only marks for review, so they are on the unique list too, labelled |

No issues were filed for these. Whether they are true is what the two-week note decides.

**Cost.** The IBM engine took about 5 seconds per full pass over the 22 surfaces, and axe about 31
seconds on the same states. The rest is page loads. One-worker runs took 1.2, 1.3 and 2.0 minutes on
landing, and 1.1 to 1.2 minutes in review round 2. One earlier run took 3.3 minutes under load from
other work on the machine. Playwright gives each shard a contiguous slice of the sorted list, so all 22
tests land on one shard (`docs/CICD_PLAN.md` §11a-quater). The CI time is not measured yet.

**The summary.** The spec writes one `ibm-equal-access` annotation per surface.
`summary-reporter.ts` folds them into the summary's `ibm` block with `summarizeIbm`, and the merge
combines the shards with `mergeIbm` (`scripts/a11y-nightly-merge-summary.mjs`). The job summary gets
the unique violations (with an "axe review only" column), then every violation, then the other two
lists in a collapsed `<details>`. Adding the block, and the split fields in review round 2, kept
`schemaVersion` 1. No field changed meaning.

| `ibm` field | Meaning |
|---|---|
| `engine` | `version` and `ruleset`, or `null` when no IBM test ran |
| `surfaces` | Surfaces scanned |
| `counts` | Nodes per list: `violation`, `needsReview`, `recommendation` |
| `alsoAxe` | Of `counts`, nodes axe matched at all, failed or marked for review |
| `alsoFailedInAxe`, `axeReviewOnly` | The two parts of `alsoAxe`: nodes axe failed, and nodes axe only marked for review. Added in review round 2 |
| `violations[]`, `needsReview[]`, `recommendations[]` | One row per IBM rule: `ruleId`, `message` (one example), `wcag`, `nodes`, `alsoAxe`, `alsoFailedInAxe`, `axeReviewOnly`, `axeRules`, `surfaces`, `examples` (up to three `surfaceId` and `xpath` pairs). Most nodes first |
| `bySurface[]` | `surfaceId`, `route`, the three counts, `uniqueViolations` (not in axe at all), `violationsAxeReviewOnly`, `violationsNotFailedInAxe` (the unique list: the two added together), `scanMs` (IBM) and `axeMs` |

The full record, with every node, is the test's annotation in the HTML report.

**Still to do: the two-week note.** After two weeks of nightly data, someone writes a short note on
AECI-1884: how many unique findings were true and how many false. Chris then rules whether to gate on
the engine, keep it as a report, or remove it. That note and the ruling have not happened yet.

**The code.**

| File | What it holds |
|---|---|
| `ibm-equal-access.spec.ts` | One test per surface, the request guard |
| `support/ibm-engine.ts` | `injectEngines`, `runIbm`, `runAxe` on the same state, `watchRequests` |
| `support/ibm-overlap.ts` | Pure: IBM's levels and lists, `matchAxe`, `RULE_PAIRS`, the `ibm` block |

**Run it** alone with one worker:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts ibm-equal-access --workers=1
```

Set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` as for §8.4.

#### 8.4.10 The Firefox and WebKit lane (AECI-1885)

ADR 0060 governs this lane. The nightly runs the keyboard walkthroughs (§8.4.1), the announcements
(§8.4.4) and the focus ring (§8.4.5) in Playwright's own Firefox and WebKit builds, as well as Chromium.
It runs once a night against `main`, in the `cross-browser` job of `a11y-nightly.yml`, three shards per
browser. It never runs on a PR. The PR e2e job stays Chromium only. It feeds the one `a11y-nightly`
status and alert (`docs/CICD_PLAN.md` §11a-quater).

**What runs.** The nightly config's `firefox` and `webkit` projects. `testMatch` picks the three suites
(`CROSS_BROWSER_SUITES` in `playwright.a11y-nightly.config.ts`), over every surface, signed in and out.
The magnification, interaction, ARIA, voice-control and IBM suites stay Chromium only (ADR 0060 "Scope").
Sessions are minted the same way as in Chromium, through `prepareSurface`, and every test keeps its write
guard.

| Browser | Tests | Snapshots |
|---|---|---|
| `chromium` | 600, every suite | `__snapshots__/chromium/` |
| `firefox` | 176: the three suites, 174, and 2 barrier tests found only in Firefox | `__snapshots__/firefox/keyboard-*.txt`, 22 |
| `webkit` | 199: the three suites, 174, and 25 barrier tests found only in WebKit | `__snapshots__/webkit/keyboard-*.txt`, 22 |

**Per-browser expectations.** A difference by design is one entry in
`e2e-a11y/support/browser-expectations.ts`, keyed by browser, with its reason and its source. The
specs read the value for the browser they run in (`browserOf(page)`). `browser-expectations.unit.spec.ts`
pins every Chromium value to what the suites did before this lane, so no entry changes a Chromium
check. All were measured on 2026-11-26 on a bare page and on the site.

| Entry | Chromium | Firefox | WebKit | Why |
|---|---|---|---|---|
| `sequentialKeys` | Tab | Tab | Option+Tab | WebKit follows Safari: Tab skips links and buttons unless "Press Tab to highlight each item" is on. A plain Tab walk of home reached only the two text fields. Option+Tab reaches every item, in the same order Firefox gives |
| `sequentialFocusWraps` | yes | no | yes | Playwright Firefox leaves focus on the last stop when Tab is pressed there, and on the first on Shift+Tab. Real Firefox moves to its toolbar, which Playwright does not draw. The walk confirms the end with the opposite key, which must move focus, and then wraps by hand (below) |
| `keyboardFocusableScrollers` | yes | yes | no | Whether an empty scroll container is a Tab stop |
| `scrollersWithFocusableContent` | no | yes | no | Firefox also stops on a scroll container that holds a link. The account page's review list is one |
| `pointerFocusesButtons` | yes | yes | no | A WebKit click does not focus a button. Focus goes to `main` (`tabindex="-1"`), and the record hears all of it. In WebKit the announcement flows reach the control by Tab and press Enter (`activate` in `support/announcement-flows.ts`) |

**Wrapping by hand, in Firefox.** `tabWalk` and `tabTo` use real key presses only. When a press leaves
focus where it was in a browser that does not wrap, the walk presses the opposite key. If focus does not
move, the stop is a trap, as before. If it moves, the walk keeps pressing until focus stops at the other
end of the document, and goes on from there. That is what the wrapping press does in Chromium. The way
back judges nothing. Coming up from below, the page is still scrolled, so a sticky bar can show stops a
top-down walk never meets. The focus ring walk does not wrap by hand (`atDocumentEnd: 'stop'`). It
checks the opposite key moves focus, puts focus back on the last stop and ends there. A climb up the whole
page before the last unfocused pictures moved the page under them, and five stops in one run could not
be measured.

**Barriers found in one browser.** The barrier tables have a `browsers` field (`KNOWN_BARRIERS` in
`keyboard-suite.ts`, `KNOWN_FOCUS_BARRIERS` in `focus-ring.spec.ts`). A mark covers only its own browser
and its own finding, so the same finding in another browser still fails. A focus ring barrier test is
declared before its browser is known. So a barrier found in some browsers only is tagged
`@not-<browser>` for the others (`notInTags`), and each project drops its own tag with `grepInvert`.
No Chromium test was added or skipped. Known on landing:

| Issue | Browsers | What the run shows |
|---|---|---|
| AECI-2195 | Firefox, WebKit | Focus under the consent banner. Firefox does not scroll a link or card that is already inside the viewport, so the banner's scroll margin (AECI-1818) never applies: not found, account. WebKit skips it for text fields: login, review submission, account, vendor portal integrations, categories index |
| AECI-2196 | Firefox | Login with a bad email: the press blurs the field, its error pushes the button down, and the release misses it. Real in every browser for a person's press. Playwright's Chromium click is instant, and WebKit activates by keyboard, so only the Firefox run sees it |
| AECI-2197 | WebKit | A control styled only by the global `:focus-visible` colour keeps `outline-style: auto`, which WebKit draws as the system ring at about 2.1:1 |
| AECI-2097 | WebKit, one more link | The portal section nav clips "Seats" too |

**What this lane does not prove.** Playwright WebKit is not Safari, and on the Linux runner it is not
even the macOS port. Playwright Firefox is not a Firefox release, and no screen reader is attached.

- The WebKit walks press Option+Tab. They show what a Safari user who presses Option+Tab, or who has
  turned on "Press Tab to highlight each item", meets. Safari's default, where Tab skips links, is not
  tested. Linux WebKit has no such setting. We do not know yet whether it treats Option+Tab as Tab.
  The first CI run shows it: a walk that misses stops fails its snapshot.
- What VoiceOver and NVDA speak. The record proves the DOM changed (§8.4.4).
- The focus ring as each OS draws it at the user's own zoom and theme. WebKit's `outline: auto` ring is
  the clearest case: macOS and Linux draw it differently.
- iOS Safari and Android.

The manual pass (`docs/a11y-manual-testing-checklist.md` §2, §6, §7) keeps its full scope and cadence.

**WebKit on a Mac and on Linux.** The committed WebKit snapshots were written on macOS. Playwright's
WebKit on Linux is a different port, and its walk may differ (ADR 0060, answer 5). If the first CI run
fails a WebKit snapshot, rewrite them on the runner: dispatch the workflow with `update_snapshots` set to
`webkit`. The `snapshots` job runs only the `tab walk` tests with `--update-snapshots=changed`, uploads
`a11y-keyboard-snapshots-webkit`, and posts no status.

```bash
gh workflow run a11y-nightly.yml --ref main -f update_snapshots=webkit
```

Then download the artifact into the snapshot folder, review the diff, and commit it:

```bash
gh run download --name a11y-keyboard-snapshots-webkit --dir apps/web/e2e-a11y/__snapshots__/webkit
```

The same works for `firefox`. The focus ring marks above were measured on macOS too. A mark whose
finding does not reproduce on Linux turns red, by the known-failure rule. Then remove it, or narrow it.

**Update a browser's snapshots locally** after a deliberate change:

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts keyboard --project=firefox --update-snapshots
```

**Run it locally.** Install the two browsers once, then run one browser:

```bash
pnpm --filter @aeci/web exec playwright install firefox webkit
```

```bash
pnpm --filter @aeci/web exec playwright test -c playwright.a11y-nightly.config.ts --project=webkit --workers=1
```

Set `AECI_WEB_PORT` and `PLAYWRIGHT_BASE_URL` as for §8.4. Times are in `docs/CICD_PLAN.md`
§11a-quater.

**Exit.** ADR 0060 sets the exit test. The lane is removed, or set to dispatch only, after more than 3
false red nights in any 14. A false red night is one where this lane is red for a flake, a browser build
fault or a runner fault, not a site barrier. Each test row in the summary names its `browser`, so the
count can be read from the kept summaries.

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

### 9.5 Why not Percy

Percy (BrowserStack's visual tool) overlaps Chromatic directly. **Do not run both.** Percy was evaluated in Phase 7.8 (AECI-154) and not adopted. Chromatic stays the visual-regression tool.

---

## 10. Performance testing — Lighthouse CI

### 10.1 Budget enforcement

Lighthouse CI runs against a local `dev:bound` server (see §10.4), nightly and as the demo promote gate. It does not run on PRs or on merges to `main`. Enforcement as of AECI-188: an error-level miss turns the [`lighthouse.yml`](../.github/workflows/lighthouse.yml) run red. A red nightly files a Linear issue. A red promote measurement stops the demo promote.

| Metric | Threshold | Action |
|---|---|---|
| Accessibility score | ≥ 95 | **Error** (red run) |
| Best-Practices score | ≥ 90 | **Error** (red run) |
| SEO score (indexable pages) | ≥ 90 | **Error** (red run) |
| TBT | ≤ 200ms | Warn (demoted 2026-06-11, noise on the browse pages; see `.lighthouserc.cjs`) |
| `/search` TTFB (`server-response-time`) | ≤ 600ms | **Error** (red run) |
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

**Zod-free routes (AECI-2033).** The `initial` budget in `apps/web/angular.json` cannot see a lazy chunk. So `Build SSR Worker` builds with `--stats-json` and runs `pnpm --filter @aeci/web check:zod-free-routes`. The check fails when a route on `ZOD_FREE_ROUTES` (`apps/web/scripts/check-zod-free-routes.mjs`) statically reaches any chunk that holds zod code. It prints the chunk path that brought zod in. The fix is in `packages/shared/README.md` "Zod-free modules". `apps/web/src/zod-free-routes.spec.ts` unit-tests the check itself.

### 10.3 Pages tested

- Home (`/`)
- Product page (`/products/procore`)
- Vendor page (`/vendors/procore-technologies`)
- Search results (`/search?q=Procore`)

Mobile and desktop profiles separately.

### 10.4 Phase 2 implementation status (AECI-65)

Lighthouse CI is wired in its own [`lighthouse.yml`](../.github/workflows/lighthouse.yml) workflow and runs **mobile** (simulated Slow-4G throttle, median-of-3) against **every Phase 2 page type** on a local `dev:bound` server — not a deployed preview — using the committed fixtures (`apps/api/seed/phase2-fixtures.sql`, seeded into the local D1 by `dev:bound`). The URL set and assertions live in [`.lighthouserc.cjs`](../.lighthouserc.cjs).

**When it runs.** Three triggers, no PRs and no merges:

- **Nightly** at 09:00 UTC against `main` HEAD. It skips when HEAD already has `lighthouse: success`, or a failure an earlier nightly already alerted on. A red nightly files or updates a `lighthouse-regression` Linear issue (`docs/OBSERVABILITY.md`).
- **Demo promote gate.** `promote-to-demo.yml` reuses a `lighthouse: success` status on the SHA, or calls `lighthouse.yml` to measure it. A failed measurement stops the promote.
- **Manual** `workflow_dispatch` on any branch, to check a perf change before it merges.

CI splits the 15 URLs across three parallel shards, each with its own `dev:bound` (`AECI_LHCI_SHARD`, AECI-2030). A local `pnpm lighthouse` still measures all 15. Every run posts the result as one `lighthouse` commit status on the measured SHA. `docs/CICD_PLAN.md` §11c has the design.

Budgets follow `STAGE_1_PHASE_2_SPEC.md` §12 (scores ≥ 90 for Performance / Accessibility / Best-Practices / SEO; LCP ≤ 2.5s; CLS ≤ 0.1; detail-page total JS transfer ≤ 200 KB). Per-URL handling: the JS budget targets detail/browse pages only; the `noindex` 404 is exempt from the SEO score.

> **Posture: partial error gate (AECI-188).** The warn→error flip landed **partially**, driven by what every page actually passes today: Accessibility / Best-Practices / SEO (+ the `/search` TTFB, §10.5) assert at `'error'` — `lhci autorun` exits 1 on a miss and the `lighthouse.yml` run goes red — while Performance / LCP / CLS / TBT / the JS-transfer budgets stay `'warn'` because multiple pages measurably miss them (per-page numbers recorded on the perf follow-up issue referenced in `.lighthouserc.cjs`). The remaining flip is gated on fixing those misses — **budgets are not lowered to pass** (AECI-65's rule). The gate is not merge-blocking. A red nightly means `main` already regressed. Fix forward or revert. A red promote measurement blocks that demo promote only. The §10.1 table reflects the enforced levels.

### 10.5 Search route (AECI-145 / Phase 3.12)

`/search` is in `.lighthouserc.cjs`'s collection (15 URLs total). It differs from every Phase 2 page on two axes, handled by two assertion classes:

- **`noindex`** — like the 404, its SEO audit fails by design. AECI-146 grouped `/search` with the 404 in the **noindex class** (matched by `NOINDEX_URL_PATTERN`): perf/a11y/CWV only, **SEO-exempt** (excluded from the indexable class's `categories:seo`).
- **No-cache (always an edge MISS)** — `/search` is `private, no-store`, the one route that never serves from an edge HIT. AECI-145 adds a `/search`-only class with a **MISS-only TTFB budget** (`server-response-time ≤ 600ms`, error-level since AECI-188) rather than inheriting cached-page timing assumptions. The threshold is Lighthouse's own native pass bar and measures the SSR-shell document fetch on `dev:bound` — the document itself involves no Algolia round-trip (InstantSearch loads browser-side) — not production search latency.

`/search` does **not** match the detail/browse URL pattern, so it correctly skips the 200 KB JS budget — InstantSearch ships more than a detail page. Instead it carries its **own JS-transfer budget** (AECI-188; ceiling recorded in `.lighthouserc.cjs`, measured against the real SDK). To make that measurement meaningful, `lighthouse.yml` provisions the shared search key (`ALGOLIA_SEARCH_KEY`, which must cover the `staging_*` indexes) into `apps/web/.dev.vars`, so CI's `/search` boots real InstantSearch against the `staging_*` indexes (local runs fold onto the staging prefix, AECI-1268) rather than the degraded shell — and hard-fails if the key is missing. `?q=…` is intentionally not collected: the empty-query page already loads the full SDK + widgets, and a pinned query would couple the budget to index contents. Enforcement: a11y + TTFB at `'error'`; perf/CWV + the JS budget stay `'warn'` (§10.4).

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

Run against a local `dev:bound` server with seed data applied. The seed is a known, stable dataset.

In an agent workspace, boot with `pnpm dev:agent` and set `AECI_WEB_PORT` to the web port it printed (`docs/local-dev.md` §3.1). On that port Playwright never boots `dev:bound` itself. If no stack answers, the run fails fast (AECI-1955). `apps/web/e2e/web-server.unit.spec.ts` (Vitest, ignored by Playwright) pins each `webServer` branch: default port, agent port, `PLAYWRIGHT_BASE_URL` override, CI, and the guard script's exit.

If a test needs to create data (e.g. submit a review), it creates it with a unique identifier (test-{timestamp}) so it doesn't conflict with other concurrent test runs.

A nightly job cleans up test-created data from Supabase to prevent buildup.

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

### 14.3 The three e2e hazards that actually cause flakes here

All three are timing races against Angular, and each has a standard remedy. None
is hypothetical. `e2e/facets.spec.ts` "criterion #1" hit both (a) and (b) on
`main` within hours of each other.

**(a) There is no hydration gate.** `await expect(page.locator('app-root')).toBeAttached()`
is the repo's standard preamble, but it passes on the SSR HTML alone — it says
nothing about whether Angular has attached its listeners. Until AECI-1655 a click
or `selectOption` dispatched in that window was dropped outright, the URL never
changed, and the following `toHaveURL` timed out. Whether hydration won the race
depended on machine load, so it read like a code regression. Since AECI-1655
(`withI18nSupport()`, see `ANGULAR_STYLE_GUIDE.md` §3) the pages really hydrate
and carry Angular's event-replay contract. An early `click`, `change` or `input`
on an element with a template or host listener is queued and replayed once the
app is stable after hydration (`e2e/ssr-hydration-contract.spec.ts`). A queued
click on a toggle replays once per click, so retrying a toggle before stability
can cancel itself out. Wait with `untilHydrated` and click once instead. Replay does not cover listeners
added in code (`addEventListener`, `Renderer2.listen`) or controls that render
only on the client, so keep the remedy below.

Signal Forms is the main listener added in code: `[formField]` adds its `input`
listener with `addEventListener`, and hydration writes the model's starting value
over the control. So a `fill` on a `[formField]` control before hydration was wiped
(AECI-1720). `AecEarlyInput` now restores typed values from the inline recorder in
`src/index.html`, so filling before hydration is what a visitor does and the form
keeps it. A consent box is different: it is `disabled` until the app is live
(`aecConsent`), and no tick crosses hydration. Playwright's `check()` waits for the
box to be enabled, which is the right signal: do not wait on time. The claim form's
earlier cold-run failure (the test ticked before hydration, and hydration unticked
the box) cannot recur. `e2e/forms-early-input.spec.ts` pins both halves. A test that
clicks a toggle and asserts in-app handling still gates on `untilHydrated`.

There is now one clean DOM signal. Angular removes an element's `jsaction`
attribute once the app is stable after hydration, and its listener is live from
then on. `untilHydrated(locator)` in `apps/web/e2e/hydration.ts` waits for that.
Call it before clicking an SSR-rendered control whose in-app handling the test
asserts. It returns at once for an element with no listener, and it waits for an
element inside a `@defer (hydrate …)` block until that block hydrates. `#ng-state`
is no signal: it survives the `TransferState` read. `[ngh]` is no signal either:
it is consumed before a default `goto` resolves.

The same signal also covers content the client fetches at boot. App stability
waits for pending `HttpClient` requests, `httpResource` included. So once
`jsaction` is gone, the desktop Browse menu holds its `TaxonomyNavStore` values.
A listener can be live before that point while the list is still empty. In
`e2e/nav-menu.spec.ts` "the flyout opens on keyboard", an ArrowDown sent before
stability focused "View all", the only link yet. The values then rendered above
it, so the first link was not focused (AECI-1675, 7 of 80 runs without the gate,
0 of 1,120 with it). Gate on `untilHydrated` even when the listener seems to
answer already.

A computed colour read is a race too (AECI-1922). Hydration rewrites an element's
`class` attribute in two steps: it first writes the template's static classes,
then the host binding adds the rest on the next pass. An `aecButton` with a static
`class` loses its fill for one frame when a frame paints between the two, and its
`background-color` transition fades the fill back in. A read during the fade gets
a part-transparent colour, and the canvas readback is one step off
(`rgb(31, 58, 47)` for Forest, 2 of 50 local runs). Before reading a colour, move
the pointer off, `untilHydrated` the element, and await `el.getAnimations()`
(`e2e/button-migration.spec.ts`, `style()`).

  **Remedy: wait for hydration, then act once.** `await untilHydrated(control)`,
  then one plain click and the assertion. `e2e/facets.spec.ts` "criterion #1" and
  the `updates.spec.ts` signup question are the worked examples. Do not wrap a
  click on an SSR-rendered control in `expect(...).toPass()` on the old premise
  that an early click is dropped. It is queued, so a retry queues a second click,
  and on a toggle (a facet checkbox, a combobox) the second click undoes the
  first. Keep a `toPass()` retry only for a step that is idempotent, or for a
  listener replay does not cover. `apps/web/e2e/listing-toolbar.ts`
  (`chooseView` / `chooseSort`) waits with `untilHydrated` first and keeps its
  retry as a safety net. `chooseSort` clicks the combobox only when
  `aria-expanded` is not `true`, so a retried attempt cannot toggle an open popup
  shut.

  **A popup's keyboard handling is live only once its focus has settled.** A
  panel can be visible before its overlay has finished attaching. A key pressed
  in that gap reaches no listener. Before pressing Escape or an arrow key in an
  opened menu, assert that the element the menu focuses on open is focused.
  For a Spartan popover the cause and the exact gate are in (c) below.
  `openMenu` in `e2e/nav-menu.spec.ts` waits for both.

  **A link click is not dropped. It loads a new document (AECI-1630).** A click
  on an SSR-rendered `<a href>` before hydration still follows the `href`. The
  inline event-replay contract only queues an early event. It never calls
  `preventDefault`, so the browser runs the native navigation (checked against
  the 22.2 contract in AECI-1655). The queued click also replays into the
  link's handler if the app becomes stable before the old page unloads. That
  handler returns early on a replay (`isReplayedEvent`, `ANGULAR_STYLE_GUIDE.md`
  §3), because the browser already followed the link. After
  stability Angular's dispatcher does call `preventDefault` on an `<a>` click
  inside a not-yet-hydrated `@defer` block, then hydrates the block and replays
  the click. The URL
  changes as the test expects, so the retry above never fires. The test is now on
  a fresh document. A fresh page opens at the top, and Back from it reloads the
  previous page at the top too.

  **Remedy — wait for hydration, then prove the click stayed in the
  document.** Prefer `await untilHydrated(link)` before the click (see above).
  `client-nav-detail`, `taxonomy-browse`, `home` and `nav-menu` use it since
  AECI-1655. Before AECI-1655 those tests passed by luck: the client re-rendered
  every page and threw away the SSR nodes, and Playwright's click retried onto
  the new, listening node. `await page.waitForLoadState('networkidle')` is the
  older remedy: the main bundle, the lazy route chunk and the page's own requests
  have landed by then. Set a `window` property before the click and read it after. A full load
  clears it. Retrying from `goto` alone does not work: each new load restarts the
  same race and lost four times in a row in 14 of 32 loaded runs. Fail rather than
  skip when the marker is gone, so a real hydration break stays red.
  `scrollListingThenClickThrough` in `e2e/scroll-restoration.spec.ts` is the worked
  example. A full load on a pre-hydration click is correct app behaviour: the
  visitor gets the right page. Do not cancel the click in the app, which would
  leave the link dead until hydration.

**(b) A response is not a render.** `page.waitForResponse(...)` resolves when the
response arrives, not when Angular has applied it, and `httpResource` keeps
serving the stale value until it does. So a "wait for the refetch, then snapshot
the DOM" sequence still reads pre-refetch content, and any click that follows
navigates using post-refetch content — a read-then-click race that surfaces as a
bafflingly wrong assertion target ("expected Fixture Procore, received ConEst
IntelliBid").

  **Remedy — gate on a rendered value that can only come from the new data**,
  then snapshot. On the listing pages the footer's status line works
  (`Showing X of N`), because the footer and the grid are driven by the same
  `httpResource`. The `/products` lede no longer carries a count (AECI-1794). Where a
  test snapshots several fields off one element, read them in a single
  `locator.evaluate()` so they cannot describe two different records.

  **`waitForLoadState` does not wait for a client navigation (AECI-1909).** A
  load state belongs to the document. Once the first load reached `networkidle`,
  every later `waitForLoadState('networkidle')` returns at once, so after a
  filter click it waits for nothing. A listing keeps the previous rows on screen,
  dimmed, while it refetches, so a "layout held still" check passes then too.
  The `e2e/scroll-restoration.spec.ts` filter tests counted, scrolled and left
  filter states whose rows had not arrived (190 to 560ms on the local stack),
  and failed 15 of 165 runs. `clickFilter` there now waits for the new state's
  rows and counts responses, then the caller waits for the layout to settle.
  The footer's auto-load is the same trap. A scroll that brings the sentinel
  within its 600px margin loads the next page, and the page holds still until
  it lands. On `/search` the fake Algolia answers 300ms later, so the `/search`
  restore tests recorded the rows without that page and failed 6 of 72 runs.
  `layoutSettled` in that spec now also waits until no footer control carries
  `aria-busy`.

  **`check()` and `uncheck()` read the box again after the click (AECI-1923).**
  Playwright clicks, waits for the navigation the click scheduled, then reads
  the box's state. If the box has left the DOM by then, the action starts over
  and waits for a box that matches the locator. On `/search` an unchecked value
  whose group has no other values is removed, with its group, on the next
  render. For Trades › Roofing on `/search?trades=Roofing&categories=…` that is
  the render InstantSearch runs while the search is in flight, about 50ms after
  the click and before Algolia answers. So `uncheck()` on such a box waited out the test timeout. It failed
  3 of 200 runs on an idle machine. With the CPU slowed 4x and Algolia answering
  in 150 to 750ms, the Roofing case failed 25 of 25. The app
  was right: the box never read checked again. Use `click()` on a filter box,
  then gate on what the new state renders (rows, the URL, a count). Use
  `check()` or `uncheck()` only on a control that stays in the DOM, such as a
  form's terms box.

**(c) A visible overlay is not yet listening (AECI-1672).** A Spartan popover or
dialog (`BrnPopover`, `BrnDialog`) renders its panel inside the click handler
that opens it. It subscribes to the overlay's outside-click and Escape streams
in a root `effect()`, which runs on the next app tick. CDK drops an outside
click or an Escape that arrives before that tick, because the stream has no
subscriber yet. Under parallel load Chrome can run the next queued input before
the tick. So "the panel is visible, now click outside" leaves the panel open
about 1 run in 30. A real user would have to tap within one frame of opening, so
the app is left as it is.

  **Remedy: gate on the trigger's `aria-expanded="true"` before acting on the
  open panel.** It is a host binding, so it flips in the same tick that attaches
  the listeners. A visible link inside the panel is not a gate: it is in the DOM
  before the tick. Focus on the panel's first link lands after that render, so
  it is a valid gate too. `openMenu` in `e2e/nav-menu.spec.ts` is the worked
  example.

**A fixed sleep needs a written reason (AECI-2027).** A `page.waitForTimeout` is not
allowed in an E2E spec or helper unless a comment directly above it says why no
condition can replace it. Wait on a condition instead: a web-first assertion,
`expect.poll`, `toPass`, `page.waitForResponse`, `untilHydrated`, or
`untilAppStable` (both in `e2e/hydration.ts`). The suite has five legitimate
cases. A negative assertion needs a window to pass: no request, no navigation, no
layout shift, focus or position that does not move. A stability check samples
over time and needs a gap between samples. A test that samples at set times
while a resource is held back is tied to the clock. A back-off before a retry
has no page state to wait on. Work with no signal the test can name, such as
deferred blocks that render as they scroll in, gets a pause. A sleep that only gives the app "a beat" is none of
these. Replace it.


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
    "@playwright/test": "^1.64.1",
    "@axe-core/playwright": "^4.10.2",
    "accessibility-checker-engine": "4.0.35",
    "@chromatic-com/playwright": "latest",
    "@lhci/cli": "latest",
    "miniflare": "^3.0.0",
    "size-limit": "latest",
    "@size-limit/preset-app": "latest"
  }
}
```

Playwright has a floor. CI runs on the `ubuntu-26.04` runner image, and Playwright supports Ubuntu
26.04 from 1.61. Below that, `playwright install --with-deps chromium` fails and the e2e lane never
starts (AECI-1383). Do not pin `@playwright/test` below 1.61.

`accessibility-checker-engine` is IBM Equal Access, the nightly's second rule engine (AECI-1884). It
is **report only**: axe is the gate, and nothing IBM finds fails a run. It is a dev dependency of
`apps/web` only, pinned exactly, because the version is the rule set. Bump it on purpose and read the
summary's change in findings. Do not swap it for the `accessibility-checker` wrapper. The wrapper
downloads its engine from a CDN when it runs and reports metrics to IBM (§8.4.9).

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
    "test:a11y:nightly": "playwright test -c playwright.a11y-nightly.config.ts",
    "test:e2e:axe": "playwright test -c playwright.e2e-axe.config.ts",
    "test:visual": "playwright test --grep @visual",
    "test:smoke": "playwright test --grep @smoke",
    "test:coverage": "vitest run --coverage",
    "test:size": "size-limit"
  }
}
```

The block is the original plan, not the package's script list. `apps/web/package.json` is the truth.
The two accessibility nightly scripts above are real, and the root `package.json` forwards both. A
`test:a11y` script with `--grep @a11y` never existed: the PR axe scans run inside `pnpm test:e2e`.
`test:unit:watch`, `test:visual`, `test:smoke` and `test:size` do not exist either.

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
- Performance regression alerts (build them on PostHog — ADR 0024)
- Real User Monitoring SLO breach alerts

Not pursued in Stage 1.
