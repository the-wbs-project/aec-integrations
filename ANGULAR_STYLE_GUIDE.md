# AEC Integrations — Angular & TypeScript Style Guide

How we write Angular and TypeScript in this codebase. Source of truth for "how it should look" — distinct from `DESIGN.md` (visual system), `PRODUCT.md` (strategy), and `docs/design/v0-porting-rules.md` (v0 → Angular translation).

**Audience:** humans and AI agents (Claude Code, Conductor) authoring or reviewing code in `apps/web/` and any future Angular app in this monorepo.

**Lint enforcement:** rules tagged `Lint: ✅` are enforced by `pnpm lint` and gated in CI (`.github/workflows/deploy.yml` — the `lint-and-types` job fails the build). Rules tagged `Lint: 🟡 review-only` are the reviewer's job — see `docs/CODE_REVIEW_CHECKLIST.md`. The full mapping is in §24.

---

## 1. Purpose & scope

This guide governs every `.ts` and `.html` file under `apps/web/`. It defers to:

- **`DESIGN.md`** (repo root) for color tokens, typography scales, component visual specs.
- **`PRODUCT.md`** (repo root) for voice, tone, anti-references.
- **`docs/design/v0-porting-rules.md`** for v0.dev → Angular porting mechanics.
- **`CLAUDE.md`** (repo root) for stack-wide constraints (Drizzle/D1 data layer, cache invalidation, i18n, both themes, no pay-for-placement).
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

- `provideZonelessChangeDetection()` is the first provider in every `ApplicationConfig`. No `zone.js` in `polyfills` or anywhere else. Reference: `apps/web/src/app/app.config.ts:19`.
- Pair zoneless with `provideClientHydration(withHttpTransferCacheOptions({ includePostRequests: false }))`. Angular v22 incremental hydration is the default and auto-enables event replay, so a separate `withEventReplay()` is redundant (AECI-130). Reference: `apps/web/src/app/app.config.ts:19-27`.
- Don't reintroduce `zone.js` to make a flaky test pass — fix the test instead.

Lint: 🟡 review-only.

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

Lint: 🟡 review-only.

---

## 14. Images: `NgOptimizedImage`

- Use `<img ngSrc="..." width="..." height="...">` from `NgOptimizedImage` for every static raster image. Mark above-the-fold images with `priority`.
- Inline base64 images are exempt — `NgOptimizedImage` doesn't support `data:` URLs. Add an `eslint-disable-next-line @angular-eslint/template/prefer-ngsrc` with a comment explaining the carve-out.

Lint: ✅ `@angular-eslint/template/prefer-ngsrc`.

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
- Gate browser-only work with `isPlatformBrowser(inject(PLATFORM_ID))` and `afterNextRender(() => { … })`. Reference: `apps/web/src/app/theme.service.ts:49-58`, `apps/web/src/app/datadog.provider.ts:35-36`.
- Browser-only third-party SDKs (Datadog RUM, anything touching `window` at module load) must be `import()`-ed dynamically inside an `afterNextRender` / `provideAppInitializer` browser-only branch — see `apps/web/src/app/datadog.provider.ts` for the full pattern.
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

---

## 19. Headless behavior: Spartan brain primitives + Angular Aria

- Use Spartan brain (`@spartan-ng/brain/<primitive>`) for behavior; layer Tailwind utility classes for style.
- Import primitives directly: `import { BrnButton } from '@spartan-ng/brain/button';`. No barrel imports from `@spartan-ng/brain` root.
- **No project-level wrapper components** around brain primitives. Compose with Tailwind in the consuming template. Reference: `apps/web/src/app/preview/vendor-detail/vendor-detail.ts:2-4`, `apps/web/src/app/demo/spartan-demo.ts`.
- No `@spartan-ng/helm` codegen (per `docs/STAGE_1_SPEC.md` §16 Phase 1).
- Angular CDK is fine where Spartan doesn't cover (overlays, drag-drop, virtual scroll).
- **New interactive/form-control patterns → Angular Aria.** This is the **rule** (ADR 0010, **Accepted**), not a proposal. For _new_ selects, comboboxes, listboxes, radio groups, accordions, trees, grids, menus, toolbars, and tabs, build on Angular Aria (`@angular/aria`, stable in v22) — it's first-party and Signal-Forms-friendly (§13). Spartan stays for the overlay primitives Aria lacks (Popover, Dialog); CDK remains the shared overlay/positioning foundation under both. Reference implementations: the review-submission form (`apps/web/src/app/reviews/review-form.ts`), the header search combobox (`apps/web/src/app/search/search-autocomplete.ts`), and the `/search` sort dropdown (`apps/web/src/app/search/widgets/search-sort-by.ts`).
  - **`select`/`radio` are realised via combobox/listbox** — Aria@22 GA ships neither directive, so a non-editable `ngCombobox` + `ngListbox` popup stands in for a select, and a horizontal `ngListbox`/`ngOption` stands in for a radio group (e.g. the review-form star ratings).
  - **Signal Forms wiring depends on the control kind.** Native `<input>`/`<textarea>` bind `[formField]` directly (like `requests/request-form.ts`). **Discrete-choice Aria controls (listbox/combobox) do _not_ — bridge them** with a local `signal` two-way bound via `[(value)]` (Aria's `value` is a `ModelSignal<V[]>`; drives `aria-selected` + roving state) plus a `(valueChange)` handler that writes `values[0]` into the field with `.value.set()` + `.markAsTouched()`. `[formField]` fails here because undefined-seeded fields aren't materialised and a seeded `0`-sentinel can't be told apart from a real first pick. See `reviews/review-form.ts` (`onOverallChange`/`onOnboardingChange`).
  - **Style Aria like brain primitives:** Tailwind `aria-*:` variant utilities (`aria-selected:`, `aria-expanded:`, `aria-checked:`) and the `data-[active=true]:` variant Aria sets on the active option, bound to the OKLCH tokens — no TS state mirror. Stage 1 is **light-only** (AECI-226); do not add `dark:` variants.
  - **Overlay glue:** `ComboboxPopup` content renders **in-flow**, not in a CDK overlay. For a floating popup, nest `ngComboboxPopup` inside `cdkConnectedOverlay` (`usePopover: 'inline'`) driven by the `[(expanded)]` signal (AECI-232).
  - Full rationale + the two deviations: `docs/adr/0010-angular-aria-alongside-spartan.md`.

Lint: 🟡 review-only.

---

## 20. Tokens, not literals

No hardcoded colors in templates or component styles. Use the semantic tokens defined in `apps/web/src/styles.css` (Tailwind v4 `@theme inline` block):

- Tailwind paren-shortcut utilities: `bg-(--surface-base)`, `text-(--text-primary)`, `border-(--border-default)`, `hover:bg-(--accent-primary-hover)`.
- Inline styles: `[style.background]="'var(--accent-primary)'"`.

**Banned:** `bg-green-900`, `#1E3A2F`, `oklch(...)`, `rgb(...)`, named Tailwind color classes, hex literals in `style="..."`.

For the canonical token list see `DESIGN.md`. For the v0 → token translation table see `docs/design/v0-porting-rules.md` §1. Don't restate either here.

Lint: 🟡 review-only (custom regex rule deferred — see §24 "Future enforcement").

---

## 21. Accessibility (WCAG AA + axe-clean)

- Spartan brain primitives give you a11y for free — don't break their built-in semantics.
- Run axe-core against any new surface before pushing.
- The template a11y lint config (`angular.configs.templateAccessibility`) is on in `apps/web`. Lint: ✅ `alt-text`, `click-events-have-key-events`, `interactive-supports-focus`, `label-has-associated-control`, `mouse-events-have-key-events`, `role-has-required-aria`, `table-scope`, `valid-aria`.
- Detailed checklist: `docs/CODE_REVIEW_CHECKLIST.md` "Accessibility" section.

---

## 22. Cross-cutting constraints (don't restate — link)

- **i18n from day one.** Every visible string wrapped in `i18n="@@unique.id"` (templates) or `$localize` (TS). See `CLAUDE.md` constraints and `docs/STAGE_1_SPEC.md` §7a.
- **Both themes always.** Light and dark must both render correctly. See `CLAUDE.md` constraints and `docs/CODE_REVIEW_CHECKLIST.md` "Theming".
- **Data layer is Drizzle over D1.** The Worker reaches the app DB through its `DB` binding via `getDb(env)` — no Prisma, no Accelerate. See `CLAUDE.md` constraints and ADR 0016.
- **Cached SSR is visitor-state-neutral.** See `CLAUDE.md` constraints and `docs/STAGE_1_SPEC.md` §9.1a.
- **No pay-for-placement.** Ranking is algorithmic. See `PRODUCT.md`.

---

## 23. Out of scope

- Visual tokens, colors, typography, spacing scales — see `DESIGN.md`.
- Voice, tone, anti-references, strategic positioning — see `PRODUCT.md`.
- v0 → Angular porting mechanics — see `docs/design/v0-porting-rules.md`.
- Drizzle/D1, Worker, cache invalidation rules — see `CLAUDE.md` constraints and `docs/DATABASE_SCHEMA.md`.
- Testing patterns — see `docs/TESTING_STRATEGY.md` and `docs/UNIT_TESTING_GUIDE.md`.

---

## 24. Appendix: ESLint enforcement matrix

Rules enforced by `pnpm lint` (via `apps/web/eslint.config.mjs`, consuming the shared `angularBase` export from `eslint.config.base.mjs`):

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

### Review-only (no lint enforcement)

| Rule | Section |
|---|---|
| Zoneless + hydration provider order | §3 |
| Omit explicit `changeDetection` (OnPush is the v22 default) | §5 |
| `ngStyle` ban (use `[style.X]`) | §8 |
| Async pipe for observables | §8 |
| No browser globals at template render (`new Date()`) | §8, §16 |
| Signal Forms; no Reactive/template-driven forms | §13 |
| SSR-safety patterns (`isPlatformBrowser`, `afterNextRender`, dynamic `import()`) | §16 |
| Lazy-loaded feature routes | §18 |
| Spartan brain composition without wrappers | §19 |
| Token usage; no hex / oklch literals | §20 |
| i18n; both themes; cache; Drizzle/D1; no pay-for-placement | §22 |

### Future enforcement (deferred)

- `@angular-eslint/prefer-signals` and `@angular-eslint/no-uncalled-signals` — both require typed linting (`parserOptions.project`), which isn't yet wired in this workspace. Enabling typed linting is a separate scope-expanding change (slower lint, broader rule surface) and is tracked as a follow-up. Until then, signal usage is review-only.
- Custom regex / processor rule banning hex / oklch / named Tailwind colors in templates and inline styles (§20).
- Custom rule banning template-driven `[(ngModel)]` outside a `<form>` context (§13).
