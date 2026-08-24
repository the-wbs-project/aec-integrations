# AEC Integrations — Code Review Checklist

**Audience:** LLMs and humans performing pre-merge code review.
**Scope:** All changes in this branch against the base branch.
**Companion documents:** `STAGE_1_SPEC.md` (intent), `API_CONTRACTS.md` (contracts), `DATABASE_SCHEMA.md` (data layer), `CLAUDE.md` (stack constraints), `ANGULAR_STYLE_GUIDE.md` (Angular + TypeScript conventions, lint enforcement), `UNIT_TESTING_GUIDE.md` (test standards), `CODE_REVIEW_EXEMPTIONS.md` (findings the team has consciously accepted or deferred).

**Pre-implementation half:** this document reviews a **diff**. The **plan** gets reviewed earlier, by step 4.5 of the `spec-anchor` skill (`.agents/skills/spec-anchor/SKILL.md`), which rates findings 🔴 CRITICAL / 🟡 MAJOR / 🔵 MINOR against the same governing docs. The vocabulary is deliberately different so you can tell at a glance which reviewer produced a block.

---

## Approach

Before flagging anything, read the surrounding context of each changed file — not just the diff lines. The diff alone hides intent and context.

Then:

0. **Load `CODE_REVIEW_EXEMPTIONS.md`.** Any finding the rest of this document would otherwise produce gets cross-checked against the active entries there. Matching findings are dropped silently from the output (do not list them, do not mention the exemption ID). Expired entries — where the linked Linear issue has closed or the date has passed — do **not** suppress findings; report the underlying issue normally and add one line at the bottom of the review noting the expired exemption ID. See `CODE_REVIEW_EXEMPTIONS.md` §"How this file works" for the active/expired rules.
1. Find the Linear issue this PR claims to address. Read the issue and the linked spec section. Does the diff implement what was asked? Implementation that doesn't match intent is the most expensive defect class.
2. Walk the diff file by file. For each, ask the questions in the categories below.
3. Compile findings into the output format at the bottom.

Severity is binary: blocker or major. Anything else does not get reported. Style nits, formatting, micro-optimizations, naming preferences — skip them. The CI gate handles formatting; the unit testing guide handles coverage. Reviewers handle correctness, security, and intent.

**Items tagged `Lint: ✅` are enforced mechanically — do not hand-check them.** They fail `pnpm lint` (the `lint-and-types` CI job, a required check on `main` and `stage-2`), so a PR that reaches review cannot be violating them. Spending review attention there is wasted; spend it on the untagged items, which are the ones a machine cannot decide. The tag mirrors the `Lint: ✅` / `Lint: 🟡 review-only` convention in `ANGULAR_STYLE_GUIDE.md` §24, which holds the full rule-to-constraint matrix. If you believe a tagged item is genuinely violated in a diff, the lint rule has a gap — that's a defect in the rule, so report it as such rather than as a one-off review finding.

---

## Categories to check

### Spec alignment

The most distinctive concern for this codebase. Code that diverges from the spec is a defect even if it works.

- Does the diff implement what the linked spec section describes?
- If the diff modifies behavior covered by a spec section, does the spec get updated in the same PR?
- If the PR adds or renames a `docs/*.md` (or root doc) that governs work, is it added to the `CLAUDE.md` source-of-truth table in the same PR? (No orphaned governing docs — see AECI-106.)
- Does the code use the entity types, error codes, and field names defined in `API_CONTRACTS.md` and `DATABASE_SCHEMA.md`?
- Does the code respect the constraints in `CLAUDE.md` (DB access is Drizzle over the D1 `DB` binding via `getDb(env)` — no Prisma, no Accelerate, no pg adapter; atomic writes use `db.batch([...])`; cacheable SSR responses set `Cache-Tag` via the AECI-56 helper; zoneless; light theme only; no pay-for-placement; i18n strings wrapped)? `Lint: ✅` for the statically-checkable half — no Prisma / Accelerate / pg adapter / connection vars, no `zone.js` or `NgZone`, no `dark:` variant or `.theme-dark` block, no forbidden `Vary` (AECI-549). The rest — `db.batch([...])` atomicity, `Cache-Tag` emission, no pay-for-placement, i18n wrapping — is `Lint: 🟡 review-only` and still needs your eyes.

- If a `## Spec Review` block exists for this issue (posted in the conversation, a Linear comment, or the PR body), were its findings addressed or explicitly waived? An unaddressed plan-time **CRITICAL** is a **BLOCKER** here; an unaddressed **MAJOR** stays **MAJOR**. If the plan check was never run and the diff contradicts its spec section, say so.

If the spec is wrong, that's also a defect — flag it. Do not silently work around it. Note that the docs are stale in known places: cite the code as well as the doc before calling a divergence a defect.

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
- Worker route writes to a table that has a permissive RLS policy for the calling user but the code uses the Supabase service-role key instead of the user's JWT (defeats RLS, masks auth-model violations). See `AUTH_AND_RLS.md` §3.1 (the split-identity seam register) for the operations that legitimately require service role — anything outside that list should use a JWT-scoped client, and a new service-role call should be added to that register in the same PR.

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
- Errors thrown from `ctx.waitUntil()` work that silently fail and never reach the observability plane
- New code path that can throw but doesn't include the error in audit log

### Data integrity and audit

- Write path that mutates state but emits no `audit_log` row at all (the builders are `auditInsert` / `workflowTransitionInsert` in `apps/api/src/lib/audit.ts`)
- Write path that mutates an entity and writes `audit_log` outside the **same** `db.batch([...])` — both must commit together (see `DATABASE_SCHEMA.md` §18). D1 has no interactive transactions, so a separate statement is not atomic
- Cache purge (`POST /admin/purge`) fired inside the `db.batch([...])` instead of after it commits, or not wrapped in `ctx.waitUntil()` on the response path
- Write path that affects cached pages but doesn't purge the relevant cache tags (see `CACHE_STRATEGY.md` §5)
- Migration that's not forward-only safe (drops a column the old code still reads)
- Schema change without corresponding migration file
- Schema change without `DATABASE_SCHEMA.md` updated in the same PR
- Denormalized counts updated in one place but not the corresponding place (review approval doesn't increment `review_count`)
- Foreign key constraints missing where the relationship is required
- Soft-delete pattern violated (hard deletion where the spec calls for `status = 'archived'`)

### Observability

> **Two vendors are live right now** (ADR 0024 dual-run). PostHog is where the migration is
> going; **Datadog is what is alerting on production today** and is deleted only by AECI-651.
> A PR that removes a Datadog leg "because we use PostHog now" is wrong until that issue ships.

- Telemetry dispatched **without** `ctx.waitUntil(...)` — a forward must never block the response
- A forwarding failure that can **throw**. Every transport leg must `console.warn` and swallow;
  a telemetry outage must not become a 500
- Telemetry emitted only on one vendor's leg where the fan-out expects both (during the dual-run,
  call sites emit once and the per-Worker adapter fans out — a call site that reaches a vendor
  client directly has bypassed the seam)
- A **metric** tagged with a concrete path instead of the matched route pattern, or tagged with
  raw `status` instead of `status_class` (the code belongs on the error log). Route patterns
  contain colons, so `key:value` tag strings split on the **first** colon only
- **A user / person / session id on a metric** — never. Ids belong on logs and events, and only
  where a genuine Supabase user id is in hand (`posthogDistinctId`; omit the attribute entirely
  otherwise, never mint a per-request id)
- **A new metric tag added without redoing the cardinality arithmetic.** PostHog guardrails at
  1,000 series per window and series identity includes resource attributes — `version` alone
  doubles every dimension while two deploy versions are live. The standing rule is in
  `OBSERVABILITY.md`; adding a dimension is a budget decision, not a one-line change
- Failure and liveness collapsed into one signal — emit on **every** run with an `outcome` tag,
  and never alert below-threshold on a failure-only slice (it is empty on healthy days, so the
  alert fires constantly)
- A new **product event** shipped without its row in `ANALYTICS.md` §4, or a **renamed** shipped
  event (a rename splits the series; there is no rename-and-backfill)
- Free text in an event property (§2 of `ANALYTICS.md`) — identifiers and shapes, never contents
- A browser capture placed in the wrong consent tier: errors + web vitals + `app_started` are
  Tier 2 (every visitor, DNT/GPC included, memory persistence, no identifier); pageviews, the
  event catalogue and `identify`/groups are Tier 3 (consented only). Writing anything persistent
  pre-consent is a defect

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
- **MAJOR** — `Lint: ✅` Response emits a forbidden `Vary` header (`Vary: Cookie`, `Vary: User-Agent`, etc.) that fragments the edge cache without a corresponding `Cache-Tag` advantage. `Vary: Accept-Language` is permitted (URL-prefix locale dispatch already handles the variance); any other `Vary` value is rejected unless there's an explicit, documented reason. Use URL-prefix segmentation instead. Enforced by `no-restricted-syntax` on `headers.set`/`append` and the object-literal form (AECI-549); test files are exempt because fixtures legitimately build a forbidden `Vary` to prove the middleware strips it.
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

- `Lint: 🟡 review-only` Hardcoded English string in a template (must be wrapped in `i18n` attribute). AECI-549 evaluated `@angular-eslint/template/i18n` and rejected it: its attribute check flagged 53 sites in this codebase and **none** were real copy (`d`, `stroke-linecap`, `rel`, `inputmode`, `aria-labelledby`, `selectionMode`, …), because the rule is configured by denylist and the allowlist we would need is inexpressible. A rule with that false-positive rate is worse than no rule. This stays the reviewer's job.
- Hardcoded English string in code (must use `$localize` tagged template)
- Date or number formatted without locale awareness
- New entity that should accept localized variants but doesn't write to `translations`
- `Lint: ✅` Logical CSS properties (margin-inline-start) NOT used in directional contexts — important for future RTL languages. Enforced by the `logical-properties` rule in `apps/web/scripts/check-source-constraints.mjs` (AECI-153), which scans `.ts` and `.html` for `ml-*` / `mr-*` / `pl-*` / `pr-*` / `text-left` / `text-right`.
- **MAJOR** — New locale added without updating both `angular.json` `i18n.locales` and the SSR Worker's `LOCALES` constant. The two must stay in lockstep; an out-of-sync `LOCALES` means the Worker can't dispatch the new prefix or purge across it.
- **MAJOR** — Translation merge code path that doesn't apply per-field fallback to canonical (missing overlay field → blank instead of canonical value). See `STAGE_1_SPEC.md` §7a.2.

### Theming

- `Lint: ✅` Dark-theme surface reintroduced: a `dark:` Tailwind variant, a `.theme-dark` block, a `@custom-variant dark` re-declaration, a `prefers-color-scheme: dark` query, or `[data-theme]` switching. Stage 1 ships a single light theme (AECI-226) and dark returns with the Stage 2 vendor portal as a semantic-token block, not as scattered utilities. Enforced two ways (AECI-549): `no-restricted-syntax` covers `.ts` including inline templates, and `apps/web/scripts/check-source-constraints.mjs` covers external `.html` and `.css`, which ESLint structurally cannot read as class strings. (This item previously read "renders correctly in light but not dark" — that predates AECI-226 and no longer applies.)
- Color hardcoded instead of using a theme token (`--surface-base`, `--text-primary`, etc.) — see `ANGULAR_STYLE_GUIDE.md` §20 (tokens, not literals). `Lint: 🟡 review-only` — despite what `STAGE_1_PHASE_2_SPEC.md` used to claim, no lint rule checks this; see AECI-597.
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
- **DB client reached by any path other than the D1 binding.** `Lint: ✅` Any reach for Prisma / Accelerate / a pg adapter / a `DATABASE_URL` is wrong — DB access is Drizzle over the native `DB` binding via `getDb(env)` (ADR 0016, AECI-278). See `DATABASE_SCHEMA.md` §1a. Enforced by `no-restricted-imports` (`@prisma/*`, `pg`, `postgres`, `@neondatabase/serverless`, `drizzle-orm/node-postgres`, `drizzle-orm/postgres-js`) plus `no-restricted-syntax` on the `getPrisma` / `PrismaClient` identifiers and the `DATABASE_URL` / `DIRECT_URL` vars (AECI-549). Unlike the value bans, this one applies to test files too.
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
- `apps/api/src/routes/reviews.ts:112` — Review insert commits without an audit row in the same `db.batch([...])`. Audit trail for review submissions is required and must be atomic with the write (STAGE_1_SPEC.md §26.1; `apps/api/src/lib/audit.ts` `auditInsert`).
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