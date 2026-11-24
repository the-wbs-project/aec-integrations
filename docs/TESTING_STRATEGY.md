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
| `apps/web/src/border-color-layer.guard.spec.ts`, with its rendered half in `e2e/border-color-utility.spec.ts` | unit, e2e | No border colour (or `border` shorthand) on a universal selector outside a cascade layer, so border-colour utilities apply. The default `--border-default` sits in `@layer base`. The e2e reads a utility's computed colour on `/preview/vendor-detail` (AECI-2088) |
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
| `apps/web/src/heading-utilities.guard.spec.ts`, `field-label.guard.spec.ts` (portal and admin blocks), `radius-utilities.guard.spec.ts`, `inline-icon-svg.guard.spec.ts`, `native-button.guard.spec.ts` | unit | Under `vendor/` and `admin/`, dead heading utilities are held at zero with no allowlist since AECI-1729. Each file's count of labels off the Label role, old radius utilities, inline icon `<svg>` and buttons without `aecButton` only goes down (AECI-2083). One allowlist per remaining guard in `src/guard-allowlists/`, rules in `shrink-only.harness.ts`. A new file starts at zero, a stale line fails, and an unreadable `[class]` binding fails until it is named |
| `apps/web/e2e/preview-admin-axe.spec.ts` | e2e | axe (WCAG 2.2 AA) on every `/preview/admin-*` route at 1440 and 390, against a shrink-only per-route allowlist (AECI-2083, §8.2) |

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

### 7.7 Cross-browser & real-device — none

The `projects` list above is **chromium-only**, and there is no cross-browser or real-device lane. The BrowserStack lane from Phase 7.8 (AECI-154, ADR 0012) was removed on 2026-10-10 under AECI-1269. Its workflow had been disabled since 2026-06-26 and never gated a merge or a deploy. ADR 0012 is marked superseded. Adding a cross-browser lane again needs a new decision record.

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
- `/preview/admin-*` — **every admin preview route, at 1440 and 390**, in
  `preview-admin-axe.spec.ts` (AECI-2083), with the WCAG 2.2 AA tags. The console is
  behind the SSR admin gate, so the previews (the real admin components over a fake API,
  no session) are where it is axe-scanned. Today's violations are recorded per route in
  `e2e/preview-admin-axe.allowlist.txt`. The list only shrinks: a rule not listed fails,
  and a listed rule that no longer fails on its route fails too, so the slice that fixed
  it deletes the line. A new `/preview/admin-*` route fails until it is added to the spec.
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
    **once**, in `apps/web/src/app/vendor/vendor-dashboard-tabbed.ts`, the shell
    the portal and the preview render. (A second, preview-only single-page concept
    declared one too. AECI-1809 deleted it.) Two consequences for this run: the
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

**Phase 2 implementation (AECI-65).** `apps/web/e2e/phase2-a11y.spec.ts` runs axe against every live Phase 2 page type — product/vendor/integration index+detail, the **product-PAIR page** (added by AECI-303), category/audience/phase browse, the three flat taxonomy indexes (`/categories`, `/audiences`, `/phases`), and the 404 — in the **light theme** (14 URLs; the dark pass was removed in AECI-226), plus the open state of the header's Browse menu (AECI-1774; it replaced the AECI-155 taxonomy flyouts), for 15 axe assertions in total. Detail pages run against committed fixtures (`apps/api/seed/phase2-fixtures.sql`, seeded into the local D1 by `dev:bound`); they self-skip if the fixtures aren't seeded so the suite never wedges CI. Both the header (incl. the Browse menu) and the **footer** are in scope: the footer's former `.exclude('aec-site-footer')` carve-out covered dark-theme contrast debt only, and AECI-226 removed it after verifying the footer is WCAG-AA clean in the (now sole) light theme.

**Phase 3.12 implementation (AECI-145).** `/search` axe coverage (zero WCAG-AA violations) ships in `apps/web/e2e/search.spec.ts` — against the graceful-degradation shell that renders in CI, where Algolia is absent. The `/products` listing + facet sidebar is covered by `products-index.spec.ts` (`tags wcag2a/2aa/21a/21aa`); the facet-interaction states add no new always-on surface beyond what those axe runs already scan.

### 8.3 Severity threshold

Block PR merge on any `serious` or `critical` violations. Warn (but don't block) on `moderate`. Ignore `minor`.

The Phase 2 success-path suite (AECI-65, above) is stricter: it asserts **zero violations at WCAG-AA** (tags `wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa`) on every page type — any such violation fails the run. Those tags do not include WCAG 2.2. The one 2.2 rule gated today is `target-size`, on the product-detail `#integrations` section at 1280px and 375px (AECI-1079). See `ACCESSIBILITY_AUDIT.md` §6.

Some violations are unfixable in third-party code; maintain an explicit allowlist with documented reason for each.

### 8.4 Nightly suite

AECI-1875 added a nightly Playwright lane for accessibility checks that are too slow or too broad for a
PR. The sub-issues of AECI-1874 add the checks. The workflow, its skip rule and its alert are in
`docs/CICD_PLAN.md` §11a-quater.

**The boundary.** The suite lives in `apps/web/e2e-a11y/` and runs from its own config,
`apps/web/playwright.a11y-nightly.config.ts`. The default `playwright.config.ts` keeps `testDir: './e2e'`,
so the PR e2e job never sees the nightly specs. The nightly config reuses everything else from the default
one: the base URL, the `webServer` block and the `.dev.vars` auth hydration. Run it locally against
`pnpm dev:agent`:

```bash
AECI_WEB_PORT=8790 PLAYWRIGHT_BASE_URL=http://localhost:8790 pnpm test:a11y:nightly
```

Use the web port `dev:agent` printed in place of `8790`.

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

**The summary.** `e2e-a11y/summary-reporter.ts` writes `apps/web/a11y-nightly-summary.json` after every
run. CI keeps it as an artifact for 30 days. The alert reads it to name the failing surfaces, and
AECI-1682 will read it for the dated record.

| Field | Meaning |
|---|---|
| `schemaVersion` | `1`. Changes only when a field changes meaning or goes away |
| `generatedAt`, `commitSha`, `trigger`, `runUrl` | When, which commit, `nightly` or `manual`, and the Actions run |
| `status` | Playwright's overall result |
| `totals` | `passed`, `failed`, `skipped`, `expectedFailures` |
| `tests[]` | `title`, `surfaceId`, `route`, `outcome`, and `knownFailure` (the issue ID or `null`) |
| `axe.violationsByImpact` | `null` until AECI-1876 adds the axe sweep |

**Adding a check.** Write a new spec in `e2e-a11y/` that loops over `SURFACES`. Add the
`surface` and `route` annotations to each test, as `surfaces.spec.ts` does, so the summary can name the
surface. Mint sessions with `personaCredentials()` and skip the same way. Add a surface to `surfaces.ts`,
never to a spec. When you change the manifest, change the manual checklist §1 with it.
`apps/web/e2e-a11y/README.md` is the short version.

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
- Performance regression alerts (build them on PostHog — ADR 0024)
- Real User Monitoring SLO breach alerts

Not pursued in Stage 1.
