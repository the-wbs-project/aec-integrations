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
- Helper functions (`computeCacheTags`, `invalidateForEntity`, `appendAuditLog`)
- Score calculations and aggregations
- Business rules (review duplicate detection, ban enforcement)

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

Coverage is measured via c8 and reported to Codecov on every PR. Coverage drops are flagged but not blocking — quality of tests matters more than the number.

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

---

## 4. Component testing — Vitest + Angular Testing Utilities

### 4.1 Scope

Component tests render a single Angular component in isolation, with mocked dependencies. Used for components with meaningful interaction logic.

### 4.2 What to test

- Components with form input or validation
- Components with conditional rendering based on inputs or state
- Components with output emission (event handlers, signals)
- Auth-gated components (verify they redirect or hide content when unauthenticated)
- Theme-aware components (verify they render correctly in both themes)

### 4.3 What to skip

- Pure presentational components with no logic
- Components fully covered by E2E tests where rendering is the main concern

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
- Cache behavior (set, get, purge)
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

### 6.3 Prisma in integration tests

API Worker handlers are factories that take the Prisma client through a `prismaFor: PrismaFactory = getPrisma` parameter and call it per request — the factory-DI shape in `DATABASE_SCHEMA.md` §1a (modeled on `apps/api/src/routes/health.ts`). Do **not** import a module-level Prisma singleton; doing so makes handlers untestable without a live database.

**Unit/handler tests** — inject a Prisma double through the `prismaFor` factory param (e.g. `createHealthHandler(() => mock)`). Vitest's `vi.fn()` or a minimal hand-rolled stub is enough for most cases (e.g. `findMany`, `create`, `update`, `delete`). Assert on the call shape, not the return.

**Higher-fidelity integration tests** — point `DATABASE_URL` at a dedicated preview Supabase Accelerate URL. Each test run must clean up after itself by truncating tables in `afterEach`/`afterAll`. Run serially or per-test-suite isolated to avoid cross-test interference.

**Accelerate-specific constraint:** the common Node Postgres pattern of "open a transaction, run the test, rollback" does **not** work the same way over Accelerate's HTTPS boundary — `prisma.$transaction` is supported, but each interactive-transaction statement is a separate round-trip, and the transaction does not span the test's surrounding code. Use truncation, not rollback, for test isolation.

**Audit + cache assertions.** Tests that exercise a write path should assert both the `prisma.$transaction(...)` call shape (mutation + `audit_log`) and the `ctx.waitUntil(invalidateForEntity(...))` call. See `CODE_REVIEW_CHECKLIST.md` "Tests" — these assertions are a documented review requirement.

### 6.4 Edge-cache integration layer (complementary to Miniflare)

Vitest + Miniflare exercises Worker *handler logic* but does **not** exercise the actual Cloudflare CDN cache, real cookie/cache interactions, or real purge propagation. Some behaviors only manifest against `wrangler dev` (or a deployed preview) where multiple requests share edge-cache state.

Keep a small bash- or Playwright-driven suite for these multi-request, edge-stateful scenarios — modeled on `apps/web/scripts/run-extra-tests.sh` (T1–T12). The scenarios that earned their keep there:

- **Cookie × cache pollution** — verify visitor-state cookies (theme, etc.) are stripped before SSR for cacheable routes; otherwise the first visitor's render poisons everyone else's response.
- **`Vary` audit** — confirm no cached SSR response emits `Vary`; one variant per URL.
- **404 / KV-miss path** — assert HTTP 404 with TTL ≤60s, not 200 with a long TTL (the "pinned 404" trap).
- **MISS → HIT progression** — assert `X-*-Cache: MISS` then `HIT` for the same URL.
- **Concurrent PUT/purge storm** — confirm rate-limit resilience.
- **Per-locale cache isolation** — `/products/x` and `/es/products/x` cache independently; per-locale purge doesn't cascade across locales; canonical purge does cascade across all locales.
- **Per-field translation fallback** — entity with partial overlay renders translated fields + canonical fallback for missing fields.
- **`ng extract-i18n` discipline** — every chrome string in templates appears in the extracted XLIFF.

Run this suite in CI against the preview deploy for the PR. It's slow relative to Miniflare (each test is a real HTTP round-trip) but covers gaps Miniflare cannot.

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

- Preview environment uses a fixed seed data set in Supabase
- Tests assume seed data exists (Procore, Autodesk, etc.)
- Seed data lives in `apps/api/prisma/seed.ts` and is applied to preview/staging on initialization

### 7.6 Auth in tests

Magic link doesn't work well in E2E (requires real email). Two options:

- **Test mode bypass**: API Worker has a `TEST_MODE=true` flag that accepts a `?test_user=email@example.com` query param to create a session. Only enabled in preview environment.
- **Direct Supabase JWT**: tests use the Supabase admin SDK to mint a JWT for a test user, set it as a cookie.

Recommend the test mode bypass for simplicity. Enable only with `ENV !== 'production'`.

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

Run in both light and dark themes.

### 8.3 Severity threshold

Block PR merge on any `serious` or `critical` violations. Warn (but don't block) on `moderate`. Ignore `minor`.

Some violations are unfixable in third-party code; maintain an explicit allowlist with documented reason for each.

---

## 9. Visual regression — Playwright + Chromatic

### 9.1 Approach

Playwright takes screenshots of key pages and components. Chromatic hosts them and shows visual diffs in PRs.

### 9.2 What to snapshot

- Home page (light and dark)
- Product page hero (light and dark)
- All Spartan UI components in the design system (button, card, input, dialog states)
- Empty states ("be the first to review", no search results)
- Error states (404, validation error)

### 9.3 Cost management

Chromatic free tier covers ~5,000 snapshots/month. Avoid snapshotting every page in every test. Curate to a focused set.

### 9.4 Approval flow

Visual diffs appear as a check on the PR. Reviewers approve or reject visual changes inline in Chromatic's UI. Once approved, the new baseline is committed.

---

## 10. Performance testing — Lighthouse CI

### 10.1 Budget enforcement

Lighthouse CI runs against the preview deployment. Performance budget:

| Metric | Threshold | Action |
|---|---|---|
| LCP | < 2.5s | Block merge if exceeded |
| INP | < 200ms | Block merge if exceeded |
| CLS | < 0.1 | Block merge if exceeded |
| TBT | < 200ms | Warn |
| Accessibility score | > 95 | Block merge |
| Performance score | > 80 | Warn |
| SEO score | > 90 | Warn |

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
- Algolia, Supabase, Datadog all stay healthy
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
- Auto-generated code (Prisma client)
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
- Performance regression alerts in Datadog
- Real User Monitoring SLO breach alerts

Not pursued in Stage 1.
