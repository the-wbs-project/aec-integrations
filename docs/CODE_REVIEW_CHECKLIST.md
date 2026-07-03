# AEC Integrations — Code Review Checklist

**Audience:** LLMs and humans performing pre-merge code review.
**Scope:** All changes in this branch against the base branch.
**Companion documents:** `STAGE_1_SPEC.md` (intent), `API_CONTRACTS.md` (contracts), `DATABASE_SCHEMA.md` (data layer), `CLAUDE.md` (stack constraints), `ANGULAR_STYLE_GUIDE.md` (Angular + TypeScript conventions, lint enforcement), `UNIT_TESTING_GUIDE.md` (test standards), `CODE_REVIEW_EXEMPTIONS.md` (findings the team has consciously accepted or deferred).

---

## Approach

Before flagging anything, read the surrounding context of each changed file — not just the diff lines. The diff alone hides intent and context.

Then:

0. **Load `CODE_REVIEW_EXEMPTIONS.md`.** Any finding the rest of this document would otherwise produce gets cross-checked against the active entries there. Matching findings are dropped silently from the output (do not list them, do not mention the exemption ID). Expired entries — where the linked Linear issue has closed or the date has passed — do **not** suppress findings; report the underlying issue normally and add one line at the bottom of the review noting the expired exemption ID. See `CODE_REVIEW_EXEMPTIONS.md` §"How this file works" for the active/expired rules.
1. Find the Linear issue this PR claims to address. Read the issue and the linked spec section. Does the diff implement what was asked? Implementation that doesn't match intent is the most expensive defect class.
2. Walk the diff file by file. For each, ask the questions in the categories below.
3. Compile findings into the output format at the bottom.

Severity is binary: blocker or major. Anything else does not get reported. Style nits, formatting, micro-optimizations, naming preferences — skip them. The CI gate handles formatting; the unit testing guide handles coverage. Reviewers handle correctness, security, and intent.

---

## Categories to check

### Spec alignment

The most distinctive concern for this codebase. Code that diverges from the spec is a defect even if it works.

- Does the diff implement what the linked spec section describes?
- If the diff modifies behavior covered by a spec section, does the spec get updated in the same PR?
- If the PR adds or renames a `docs/*.md` (or root doc) that governs work, is it added to the `CLAUDE.md` source-of-truth table in the same PR? (No orphaned governing docs — see AECI-106.)
- Does the code use the entity types, error codes, and field names defined in `API_CONTRACTS.md` and `DATABASE_SCHEMA.md`?
- Does the code respect the constraints in `CLAUDE.md` (DB access is Drizzle over the D1 `DB` binding via `getDb(env)` — no Prisma, no Accelerate, no pg adapter; atomic writes use `db.batch([...])`; cacheable SSR responses set `Cache-Tag` via the AECI-56 helper; zoneless; light theme only; no pay-for-placement; i18n strings wrapped)?

If the spec is wrong, that's also a defect — flag it. Do not silently work around it.

### Bugs and logic errors

- Off-by-one errors, wrong operators, inverted conditions
- Race conditions, async/await misuse, unhandled promise rejections
- Null/undefined dereferences that will throw at runtime
- Wrong handling of empty arrays, zero values, missing optional fields
- Incorrect handling of pagination edges (last page, empty result set)
- State machine transitions that allow invalid `from_state → to_state` paths
- Incorrect denormalized count maintenance (review_count, integration_count drift from truth)

### Security

- Unsanitized user input rendered to DOM or passed to `innerHTML` / `eval` / `bypassSecurityTrust*`
- Auth checks missing on protected Worker endpoints
- Authorization checks missing (authenticated but not the right role/owner)
- Sensitive data (tokens, emails, personal info) logged or returned in error responses
- API responses that leak more data than the contract requires
- Missing CSRF protection on state-changing endpoints
- CORS policy too permissive
- Webhook handlers without HMAC signature verification
- Secrets in code (API keys, tokens, passwords) — even commented out
- `.dev.vars` or `.env` files added to commits
- SQL constructed via string concatenation (use Drizzle's query builder or parameterized `sql` templates, never interpolation)
- Banned-user enforcement missing on write paths

### Authorization model

- Does the change touch a table covered by RLS policies? If so, has the policy been verified for the new access pattern?
- Worker code using the Supabase service role key without justification (defeats RLS)
- Role check missing or wrong (`role === 'admin'` vs `role === 'vendor_admin'` mix-up)
- Vendor-scoped operations not checking `vendor_id` matches the authenticated user
- Worker route writes to a table that has a permissive RLS policy for the calling user but the code uses the Supabase service-role key instead of the user's JWT (defeats RLS, masks auth-model violations). See `AUTH_AND_RLS.md` §6 for the operations that legitimately require service role — anything outside that list should use a JWT-scoped client.

### Performance

- N+1 query patterns: fetching a list, then making a query per item
- Missing pagination on list endpoints (no implicit "return everything")
- Missing indexes for new query patterns (check `DATABASE_SCHEMA.md` — was the new index added?)
- Synchronous blocking work in Worker request handlers (heavy CPU on the request path)
- Missing debounce/throttle on high-frequency event handlers (search-as-you-type, scroll, resize)
- Heavy computation inside Angular templates (move to computed signals or pipes) — see `ANGULAR_STYLE_GUIDE.md` §8, §11
- Large data structures loaded into memory when streaming would work
- Cache headers missing or wrong TTL on cacheable responses
- `ctx.waitUntil()` missing on fire-and-forget side effects (writes that block the response unnecessarily)

### Error handling

- Unhandled promise rejections
- Silent catch blocks: `try { ... } catch {}` with no logging or rethrow
- Errors caught but the original error context lost (`throw new Error('failed')` loses the cause)
- API or Worker responses that return 200 with an error payload instead of the right HTTP status code
- No fallback when an external dependency (Algolia, Linear, Resend) fails
- Errors thrown from `ctx.waitUntil()` work that silently fail and never reach Datadog
- New code path that can throw but doesn't include the error in audit log

### Data integrity and audit

- Write path that should call `appendAuditLog()` but doesn't
- Write path that mutates an entity and writes `audit_log` outside the **same** `db.batch([...])` — both must commit together (see `DATABASE_SCHEMA.md` §18)
- Cache purge (`POST /admin/purge`) fired inside the `db.batch([...])` instead of after it commits, or not wrapped in `ctx.waitUntil()` on the response path
- Write path that affects cached pages but doesn't purge the relevant cache tags (see `CACHE_STRATEGY.md` §5)
- Migration that's not forward-only safe (drops a column the old code still reads)
- Schema change without corresponding migration file
- Schema change without `DATABASE_SCHEMA.md` updated in the same PR
- Denormalized counts updated in one place but not the corresponding place (review approval doesn't increment `review_count`)
- Foreign key constraints missing where the relationship is required
- Soft-delete pattern violated (hard deletion where the spec calls for `status = 'archived'`)

### API contract integrity

- New endpoint without a Zod schema in `packages/shared/`
- Response shape that doesn't match the documented contract
- Error code that doesn't exist in the documented error code table
- Endpoint that returns sensitive data not in its documented response shape
- HTTP status code that doesn't match the conventions in `API_CONTRACTS.md` §4.1
- Breaking change to a contract without updating both the schema and the consumers

### Caching

- Cacheable response without `Cache-Control` headers
- Non-cacheable response (user-specific, write) without `Cache-Control: private, no-store`
- Write path that purges the wrong set of cache tags, or fails to call `POST /admin/purge` after a write that affects cached pages (consult the tag vocabulary in `CACHE_STRATEGY.md` §2; the `STAGE_1_SPEC.md` §9.3 URL-invalidation map is superseded)
- Cache key that includes user-specific data, fragmenting the cache
- **BLOCKER** — Cached SSR route reads a request cookie and bakes the value into rendered HTML (cookie/cache pollution). Visitor-state cookies must be stripped before forwarding to SSR for cacheable routes, or the route must not be cached. See `STAGE_1_SPEC.md` §9.1a.
- **BLOCKER** — 404 / not-found returns HTTP 200 with a long TTL (the "pinned 404" trap). 404 must return status 404 with TTL ≤60s. See `STAGE_1_SPEC.md` §9.1b.
- **MAJOR** — Response emits a forbidden `Vary` header (`Vary: Cookie`, `Vary: User-Agent`, etc.) that fragments the edge cache without a corresponding `Cache-Tag` advantage. `Vary: Accept-Language` is permitted (URL-prefix locale dispatch already handles the variance); any other `Vary` value is rejected unless there's an explicit, documented reason. Use URL-prefix segmentation instead.
- **MAJOR** — `CLOUDFLARE_API_TOKEN` scope broadened beyond `Zone.Cache Purge` on `aecintegrations.com`.

### Accessibility

- New interactive element without keyboard support
- New form input without a `<label>` (placeholder is not a label)
- Color used as the only signal (error states need icons + text, not just red)
- New text that doesn't pass contrast against the theme background (Clay used for body text — see `STAGE_1_SPEC.md` §2a.4)
- Heading hierarchy broken (h1 → h3 with no h2)
- Decorative images without `alt=""`
- Spartan UI component overridden in a way that breaks its built-in a11y
- Reduced motion not respected on new animation
- ARIA attributes used where semantic HTML would suffice

### Internationalization

- Hardcoded English string in a template (must be wrapped in `i18n` attribute)
- Hardcoded English string in code (must use `$localize` tagged template)
- Date or number formatted without locale awareness
- New entity that should accept localized variants but doesn't write to `translations`
- Logical CSS properties (margin-inline-start) NOT used in directional contexts — important for future RTL languages
- **MAJOR** — New locale added without updating both `angular.json` `i18n.locales` and the SSR Worker's `LOCALES` constant. The two must stay in lockstep; an out-of-sync `LOCALES` means the Worker can't dispatch the new prefix or purge across it.
- **MAJOR** — Translation merge code path that doesn't apply per-field fallback to canonical (missing overlay field → blank instead of canonical value). See `STAGE_1_SPEC.md` §7a.2.

### Theming

- New component renders correctly in light but not dark (or vice versa)
- Color hardcoded instead of using a theme token (`--surface-base`, `--text-primary`, etc.) — see `ANGULAR_STYLE_GUIDE.md` §20 (tokens, not literals)
- Vendor-uploaded content not wrapped in the neutral media block container
- Brand accent (Clay, Forest) used in a low-contrast context that fails WCAG AA
- **BLOCKER** — A `data-theme`-dependent value is rendered in SSR for a cacheable route (same cookie/cache pollution rule as Caching above). Theme must be applied on the client after hydration for cached routes; server-rendered HTML is theme-neutral.

### Tests

- New logic path with no corresponding test in this PR
- Existing tests rendered stale by this change but not updated
- Tests that pass for the wrong reason (mock returns success regardless of input)
- Test names that don't match the assertion body (refer to `UNIT_TESTING_GUIDE.md`)
- Audit log calls without a corresponding test asserting the log was made
- Cache invalidation calls without a test asserting the helper was invoked
- Hallucinated test utilities or test imports (especially in AI-authored code)

### Correctness

- Business logic that contradicts the apparent intent of the issue
- State mutations that propagate incorrect data downstream
- Missing cleanup of subscriptions, timers, observers, or event listeners
- API request payload that doesn't match the documented contract
- Mappings between Airtable and Supabase that overwrite curator-preserve fields (`website`, `headquarters`, `crunchbase_url`, `wiki_url`, `linkedin_url`)

### AI-authored code red flags

Be especially vigilant about these in AI-authored PRs. They are easy to miss because the code looks plausible.

- **Fabricated imports.** `import { useQuery } from '@aeci/something-that-doesnt-exist'`. Verify every import resolves.
- **Hallucinated APIs.** Code that calls `productService.fetchAll()` when the real method is `productService.list()`. Cross-check against the actual file.
- **Made-up Zod methods.** `z.text()`, `z.uuid()` (this one exists; just an example shape) — verify against Zod's actual API.
- **Plausible but wrong configuration.** A `tailwind.config.ts` value that looks like the documented format but uses an option that doesn't exist.
- **Doc/code drift introduced in the PR.** The code does X, but a doc updated in the same PR says it does Y.
- **Copy-paste from outside this codebase.** Style, naming, or patterns that don't match the rest of the codebase signal copy-paste from training data — review extra carefully.
- **Comments that confidently describe wrong behavior.** "// This handles the bot-score check" on code that doesn't check bot score.
- **Stub or placeholder code committed.** `// TODO: implement actual logic` left in alongside passing tests — the tests are testing the stub, not real behavior.
- **DB client reached by any path other than the D1 binding.** Any reach for Prisma / Accelerate / a pg adapter / a `DATABASE_URL` is wrong — DB access is Drizzle over the native `DB` binding via `getDb(env)` (ADR 0016, AECI-278). See `DATABASE_SCHEMA.md` §1a.
- **Module-level DB client.** Constructed once at import time and reused across requests. Should be per-request via the `getDb(env)` factory injected into the handler. Breaks request isolation and testability.
- **Angular-decorator carryover.** `@HostBinding` / `@HostListener` / `@Input` / `@Output` / `ngClass` / `ngStyle` / `*ngIf` / `*ngFor` / `*ngSwitch` / `[(ngModel)]` in a form context — all banned. Use the `host: { ... }` metadata object, `input()` / `output()` / `model()`, `[class.X]` / `[style.X]` bindings, `@if` / `@for` / `@switch`, and reactive forms. `pnpm lint` catches most of these; if one slips past lint, flag it as a BLOCKER. See `ANGULAR_STYLE_GUIDE.md` for the full enforcement matrix.

---

## Severity labels

Use exactly one of these. Nothing in between.

🔴 **BLOCKER** — must be fixed before merge.
- Will throw in production
- Security hole (auth bypass, secret leak, injection)
- Data loss or corruption risk
- Breaks an existing functioning feature
- Schema migration that's not forward-only safe
- Audit log missing on a state-changing write
- Cache invalidation missing on a write that affects cached content
- Hardcoded secret committed

🟡 **MAJOR** — should be fixed before merge unless explicitly deferred.
- Likely runtime bug not caught by tests
- Performance regression on a hot path
- Spec divergence with no spec update
- Missing test for new logic
- Accessibility violation that axe-core would catch
- Error handling gap that will silently swallow real errors
- New endpoint missing rate limiting where the spec requires it

Below MAJOR is not reported. Don't suggest renaming variables, optimizing trivial code paths, or making style adjustments. The CI gate handles formatting.

---

## What to skip entirely

- Style and formatting (CI enforces this)
- Variable naming preferences
- "Could be more idiomatic" suggestions
- Micro-optimizations not on a hot path
- "I would have done this differently" without a concrete defect
- Things already covered by existing tests passing
- Comments and docstring nits
- Test naming preferences (handled by `UNIT_TESTING_GUIDE.md`)
- Asking for tests to be expanded beyond the diff's scope

---

## Output format

If issues are found:

```
## Code Review

🔴 BLOCKERS
- `apps/api/src/reviews/submit.ts:42` — Missing auth check. Anonymous users can POST and create reviews. Section §5.1 of the spec requires authenticated insert with reviewer_id = auth.uid.
- `apps/api/migrations/0007_add_locale.sql:8` — Migration adds `NOT NULL` column without default; will fail on existing rows. Either add a default or use a two-phase migration (nullable, backfill, then NOT NULL).

🟡 MAJOR
- `apps/web/src/app/review-form/review-form.component.ts:78` — Form does not call appendAuditLog on submit. Audit trail for review submissions is required (STAGE_1_SPEC.md §26.1).
- `packages/shared/src/api/reviews.ts:34` — New error code 'REVIEW_TOO_LONG' added but not in the documented error code table in API_CONTRACTS.md §4.
- `apps/web/src/app/product-page/reviews-tab.component.html:12` — New "Submit review" button has no accessible name (icon-only, no aria-label).

❌ Issues found — do not merge.
```

If no issues are found:

```
## Code Review

Reviewed: 8 files changed across apps/web, apps/api, packages/shared. Diff implements AECI-42 (review submission form). Spec section §4.7 references match the implementation. Tests cover the new validation rules and the auth-gated path.

✅ Approved.
```

---

## Reviewer self-check

Before posting the review, verify:

1. You actually read the spec section the PR references
2. You actually opened each changed file beyond the diff window
3. You did not flag anything below MAJOR
4. Each blocker or major issue cites a specific file and line
5. Each issue explains *why* it matters, not just what it is
6. The summary matches what you actually checked
7. You loaded `CODE_REVIEW_EXEMPTIONS.md` and applied every active entry before composing the review — and you noted any expired entries at the bottom

A review that flags 30 minor things and misses the real bug is worse than a review that says "approved" with no thought. Calibrate.