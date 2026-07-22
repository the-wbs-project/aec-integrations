# AEC Integrations — Unit Test Authoring Guide

**Audience:** LLMs writing or updating unit tests for this repository.
**Scope:** Branch-scoped only. Test only what changed.
**Companion documents:** `TESTING_STRATEGY.md` (tooling, coverage, philosophy), `STAGE_1_SPEC.md` (what the code is supposed to do), `API_CONTRACTS.md` (schema contracts), `CLAUDE.md` (stack constraints).

---

## Scope rule

You are writing tests for the diff in this branch. Not the rest of the codebase.

- Identify files changed in this branch
- For each changed file: review existing tests, then write tests for new or modified behavior
- Do not audit unchanged files
- Do not refactor unrelated tests "while you're in there"

If you find a critical untested gap in an unchanged file, flag it in the output. Do not fix it in this PR.

---

## Workflow

Work through these in order. Do not skip ahead.

### Step 1 — Review existing tests against the diff

For each changed file, open its test file and check:

- Tests that asserted the **old behavior** and now assert something the code no longer does → update
- Tests that mock dependencies whose signature changed → update mocks
- Tests that cover behavior **deleted** in this branch → delete those tests
- Tests that pass under the new code but for the wrong reason (lucky path) → rewrite

Output a short summary table before writing anything new:

```
File              Issue
--------------    -----------------------------------------
review-form.ts    Existing test mocks old validateBody signature
auth.service.ts   Tests still assert pre-change error message
```

Then proceed.

### Step 2 — Write tests for new and modified logic

Cover the categories below that apply. Each test gets a one-line comment explaining the risk or behavior it guards. Tests without comments are not finished.

### Step 3 — Flag testability problems

If a piece of new or changed code is untestable, do not skip it silently:

- Name the file and function
- Explain the structural problem (tight coupling, hidden side effect, untestable singleton, etc.)
- Suggest the minimal refactor
- Write a `it.todo('...')` placeholder so the gap is tracked

---

## What to test

### Pure functions and helpers

If the function is pure (no I/O, no globals, no time), test it exhaustively:

- Happy path with typical input
- Boundary values (empty string, zero, max int, single-element array)
- Null/undefined where the type permits
- Each branch of every conditional
- Each early return

### Zod schemas

Zod schemas are contracts. Test them with both valid and invalid inputs:

- One happy-path case proving valid input passes
- One case per validation rule proving invalid input fails (string too short, wrong enum value, missing required field, etc.)
- Assert the error's `path` and `code` when the test depends on which field failed, not just that something failed

```typescript
it('rejects body under 50 chars', () => {
  // Guards: validation should fail with field path 'body'
  const result = SubmitReviewSchema.safeParse({ ...validInput, body: 'too short' });
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0].path).toEqual(['body']);
  }
});
```

### Angular components (zoneless)

#### Harness

Angular component specs run under the `@angular/build:unit-test` builder with the Vitest runner (Angular 21 native). The wiring lives in:

- `apps/web/angular.json` — `test` architect target pointing at `tsconfig.component-spec.json` with `include: ["src/**/*.component.spec.ts"]` and **`isolate: true`**. The builder defaults `isolate` to `false` (the Karma/Jasmine-style shared environment), which runs every spec in one jsdom — so a spec that mutates a global (`window.history`/`location`, `document.referrer`) can pollute another file and cause cross-file CI flakes. We override it to `true` so each spec file gets a fresh environment (this restores plain Vitest's default). Prefer mocking the indirection that reads a global over mutating the global directly regardless (see `waitlist-welcome.component.spec.ts`).
- `apps/web/tsconfig.component-spec.json` — dedicated tsconfig so only Angular specs are compiled (the wider `tsconfig.spec.json` also includes server vitest specs which would fail Angular's strict compile)
- `apps/web/package.json` — `test:component` script runs `ng test`; `test:unit` runs server vitest first, then `test:component`

Server-side Vitest (`apps/web/vitest.config.ts`) explicitly excludes `*.component.spec.ts` so the two test runners never see each other's files. **Always use the `.component.spec.ts` suffix for Angular tests** — using bare `.spec.ts` will route the file to server vitest, where Angular's DI and DOM are absent.

Local dev: `pnpm exec ng test` (one-shot) or pass `--watch` for re-run on change. CI invokes `pnpm test:unit` from the root and picks up both pipelines automatically.

#### Patterns

Bare `TestBed` from `@angular/core/testing` is the default; reach for `@testing-library/angular` only if a spec needs richer semantic querying than `nativeElement.querySelector(...)` provides.

For pure structural shells with named slots (e.g. the layout components in `apps/web/src/app/layouts/`), define a tiny inline host component that projects test markers and assert on what reaches the DOM. Example: `apps/web/src/app/layouts/detail-layout.component.spec.ts`.

Cover:

- Conditional rendering: render with each set of inputs, assert the right thing is on screen
- User interactions: simulate the interaction, assert the resulting state change or emitted output
- Form validators: dispatch the input, assert the error state
- Output emissions: spy on the output, trigger the action, assert it emitted with the right value
- Both themes: if the component has theme-dependent behavior, test both light and dark

Prefer semantic queries (`querySelector('main[aria-label]')`, `getByRole` if `@testing-library/angular` is in use) over CSS class selectors or `data-testid` — fall back to `data-testid` only when no semantic anchor exists (e.g. projected slot markers in a host fixture).

Do NOT test:
- Pure rendering with no logic (the framework does this)
- Tailwind class application (visual regression handles this)
- Spartan UI internals (the library is already tested)

### Cloudflare Worker code

Use Miniflare for integration tests. For pure handler logic, extract and test as a pure function.

- Request validation: send malformed input, assert correct error response and status code
- Auth gating: send unauthenticated request, assert 401
- Authorization: send authenticated-but-not-authorized request, assert 403
- Happy path: send valid request, assert correct response shape (validate against the Zod schema, not against a hand-written object)
- Error paths: mock the dependency to throw, assert the right error code surfaces
- Cache headers: assert exact `Cache-Control` and `Cache-Tag` for each route class; assert non-cacheable responses are `private, no-store`
- Gateway normalization: assert `cacheKeyFor()` strips tracking noise, retains only content-affecting parameters, canonicalizes order, and is passed to `ctx.exports.Renderer.fetch()` as `cf.cacheKey`
- Native cache boundaries: do not mock `caches.default`; front-of-Worker HIT/MISS is deployed-only

### Async operations

- Rejected promises caught and surfaced as the right error type
- No unhandled rejection warnings during the test (Vitest fails on these — keep it that way)
- Use async/await; never use done callbacks
- Time-dependent code uses `vi.useFakeTimers()` — never real `setTimeout` in tests

### Drizzle/D1 queries

- Pure transformations of query results: unit test with a mocked Drizzle client (`getDb` double)
- The query itself: integration test against a local D1 (covered in `TESTING_STRATEGY.md` integration testing — not unit tests)

Don't mock the Drizzle client deeply. Mock the specific call you're hitting (`db.query.*`, `db.select`, `db.batch`) and assert on the call's input.

### Workflow state machines

Each transition is a test:

- Each valid `from_state → to_state` succeeds
- Every invalid `from_state → to_state` throws `INVALID_STATE_TRANSITION`
- Side effects fire on transition (audit log appended, webhook emitted)

### Audit logging

Any change that calls `appendAuditLog()` must include a test asserting:

- The log entry was created
- `action`, `entity_type`, `entity_id`, and `actor_id` are correct
- For updates: `before_state` and `after_state` contain the changed fields

This is non-negotiable. Audit logging silently failing is one of the worst possible bugs for this product.

### Cache invalidation

Any write that invalidates cached SSR content must include a producer test asserting:

- The correct `CachePurgeMessage` directive (`tags`, `pathPrefixes`, or exclusive `purgeEverything`) was sent after the write committed
- The message carries the correct `source`, and local/unbound queues preserve the documented graceful fallback

Changes to the SSR consumer or `/admin/purge` must also assert the native boundary:

- The purge is delegated into the cached `Renderer` entrypoint, never the uncached gateway
- Success/no-cache/noop messages ack; failed or thrown purges retry
- `/admin/purge` validates auth and exclusive purge modes before calling `ctx.cache.purge()`

---

## What NOT to test

- Configuration files (`.config.ts`)
- Type-only files (`.d.ts`, `types.ts`)
- Generated migration SQL (drizzle-kit output under `apps/api/migrations/`)
- Tailwind class names — visual regression tests cover styling
- Spartan UI component internals
- Framework behavior (Angular's change detection, Vitest itself, Zod's parser)
- Trivial getters/setters with no logic

---

## Mocking rules

**Mock at the boundary.** External services (Algolia, Resend, Datadog, Linear), the network layer, the database connection. Not internal helpers.

**Never mock:**

- Zod schemas — they ARE the contract; mocking them defeats the test
- Pure utility functions — just call them directly
- The thing you're testing

**Always mock:**

- HTTP calls (use MSW or test handlers, never let tests hit real services)
- `Date` and `setTimeout` (use `vi.useFakeTimers()`)
- `Math.random` (deterministic tests only)
- File system access in unit tests (integration tests can use a temp dir)

**Mock once at the top of the test file or `describe` block, not inside each `it`.** Repeated setup means a missing `beforeEach`.

---

## Test data

Three options, picked deliberately:

### Inline literals

Best for simple, one-off cases. The data is part of the test's documentation.

```typescript
it('rejects negative rating', () => {
  // Guards: rating must be 1-5
  const result = SubmitReviewSchema.safeParse({ rating_overall: -1, ... });
  expect(result.success).toBe(false);
});
```

### Factories

Best when many tests need similar-but-varied data. Create one in `src/test/factories/`:

```typescript
export function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'review-1',
    product_id: 'product-1',
    rating_overall: 5,
    rating_onboarding: 4,
    title: 'Good',
    body: 'A '.repeat(30),  // 60 chars, satisfies min
    ...overrides,
  };
}
```

Then in tests: `const review = makeReview({ rating_overall: 1 });`

### Fixtures

Best for complex realistic data. Use sparingly — fixtures encourage testing too much in one test.

Store in `src/test/fixtures/`. Name them by what they represent (`fixtures/procore-product.ts`), not by which test uses them.

---

## File and naming conventions

- Test files live next to source files: `review-form.component.ts` → `review-form.component.spec.ts`
- Integration tests live separately: `apps/api/integration/` with `*.integration.spec.ts`
- E2E tests live in `e2e/` with `*.e2e.spec.ts`

`describe` blocks group by **behavior**, not by function name:

```typescript
// Good
describe('ReviewFormComponent', () => {
  describe('when no product is selected', () => { ... });
  describe('when submitting with invalid input', () => { ... });
  describe('when authentication is required', () => { ... });
});

// Bad
describe('ReviewFormComponent', () => {
  describe('ngOnInit', () => { ... });   // tests grouped by method name
  describe('submit', () => { ... });
  describe('validate', () => { ... });
});
```

Test names start with "it" implicit subject:

```typescript
// Good
it('rejects body under 50 chars', () => { ... });
it('disables submit button while pending', () => { ... });

// Bad
it('should reject body under 50 chars', () => { ... });   // "should" adds nothing
it('test body validation', () => { ... });                 // says nothing about the assertion
```

---

## The "test should fail for the right reason" discipline

Before submitting a test, mentally check: **if the code under test was buggy in the exact way this test is supposed to catch, would this test actually fail?**

Common ways tests pass when they shouldn't:

- Test expects truthy but the code returns truthy for the wrong reason
- Test asserts the spy was called, but doesn't check what it was called with
- Test mocks return success regardless of input, so the test passes even when the code skips its logic
- Test catches an error and asserts on a property the error doesn't have

When in doubt, **temporarily break the implementation** to verify your test catches it. Then restore the implementation. The test should have failed.

---

## Anti-patterns

These do not get committed. Reject them on review.

### Tests that test the framework

```typescript
// Bad — testing Angular, not your code
it('renders the component', () => {
  render(MyComponent);
  expect(screen.getByText('Hello')).toBeInTheDocument();
});
```

If `MyComponent` just renders "Hello" with no logic, there's nothing to test.

### Tests that test mocks

```typescript
// Bad — asserting on the mock's behavior, not the code's
const mockFn = vi.fn().mockReturnValue(42);
expect(mockFn()).toBe(42);
```

### Snapshot tests for everything

Snapshots have their place (visual regression, schema stability). For component behavior, they're an anti-pattern — they pass until they don't, and when they fail nobody knows why.

### Tests with no assertions

```typescript
// Bad — passes whether the code works or not
it('handles the click', async () => {
  await fireEvent.click(button);
});
```

### Conditional assertions

```typescript
// Bad — if result.success is always false, the inner expects never run
if (result.success) {
  expect(result.data.id).toBe('123');
}
```

If you need conditional logic, the test is testing two things. Split it.

### Massive setup

If `beforeEach` is longer than the test, the component or function is too coupled. Flag testability (Step 3).

---

## AI-author specific pitfalls

LLM-authored tests can fail in distinctive ways. Reviewers should look for these:

- **Hallucinated test utilities.** `getByCustomQuery`, `expect.toBeInTheTree()` — verify every imported test utility actually exists in the installed library version.
- **Tests against fabricated APIs.** The test calls `productService.fetchAll()` but the real method is `productService.list()`. Verify imports and signatures match.
- **Spurious mocks.** Mocks for dependencies that the code under test doesn't actually use. Wastes lines, hides what's tested.
- **Comments that lie.** "Guards: validation should fail" but the assertion checks for success. Read the comment against the assertion.
- **Test names that don't match the body.** `it('rejects empty input')` followed by a test that submits valid input. Read the name against the body.
- **Coverage theater.** Tests that exist to bump coverage numbers, asserting on trivial things. Better to write fewer tests that catch real bugs.

When in doubt, prefer fewer high-quality tests over many low-quality ones.

---

## Coverage exemptions

You don't need to test:

- Code that only delegates to another tested function with no logic of its own
- Logging statements (the side effect, not the value, is what matters — covered by integration tests)
- Type-only assertions (TypeScript handles this)
- Branches that are unreachable due to type constraints (`assertNever` defaults)

Document the exemption in a comment if it's not obvious why.

---

## Output format

After writing tests, your PR description (or comment to the human reviewer) should include:

```
## Tests added or updated

**Modified:**
- review-form.component.spec.ts: updated 2 tests for new validation rule; added 3 tests for the rate limit warning
- auth.service.spec.ts: removed 1 stale test; added 1 test for the new token refresh path

**New:**
- workflow-transitions.spec.ts: 8 tests covering valid and invalid state transitions

**Skipped:**
- correction-form.component.spec.ts: NEW logic in renderCorrectionPreview() is not unit-testable due to direct DOM manipulation. Flagged with it.todo() and Linear issue AECI-NNN created.
```

If you don't have this output to give, you're not done.

---

## Final discipline

Before declaring "tests done":

1. All tests in the file pass (`pnpm test:unit -- path/to/spec.ts`)
2. Coverage didn't drop (`pnpm test:coverage` on affected files)
3. No `.only` or `.skip` left in the file
4. No `console.log` debugging left behind
5. Every test has a one-line comment explaining what it guards
6. The output summary (above) is included in the PR
