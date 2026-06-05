# ADR 0009: Signal Forms is the standard for forms

**Status:** **Accepted** (2026-06-04)

**Context owner:** Chris Walton

Supersedes the "Reactive forms only" stance in `ANGULAR_STYLE_GUIDE.md` §13 (and the §8 "no template-driven forms" note). Part of the Angular v22 adoption epic (AECI-122); the first real form ships in AECI-128.

---

## Context

Angular 22 ships **Signal Forms** (`@angular/forms/signals`) as a stable, signal-native forms API: a form is built from a `signal()` model via `form(model, schema)`, fields bind with the `[formField]` directive, and all state (`value`, `valid`, `touched`, `pending`, `errors`) is exposed as signals. It fits a zoneless, signals-first codebase far better than Reactive Forms' `Observable`/`Subscription` model.

The repo is a **clean slate** for forms: no Reactive or template-driven forms exist (the Phase 5/6 auth, review, claim, and correction forms were still `PlaceholderPage` stubs). `@angular/forms@22` was added in the upgrade PR (AECI-122 PR 1). So we can pick one standard before the first real form rather than retrofit later. The generic Angular best-practices guide still says "prefer Reactive forms"; that predates Signal Forms stabilizing — we supersede it for this repo.

The repo's API contract is **Zod schemas in `@aeci/shared`**, validated at runtime on the API Worker. A forms standard should let the client validate against the *same* schemas so validation can't drift between client and server.

## Decision

**Use Signal Forms (`@angular/forms/signals`) for all new forms.** No Reactive or template-driven forms.

- Build from a `signal()` model with `form(model, (path) => { … })`; bind controls with `[formField]`; submit with `submit()`.
- **Reuse the shared `@aeci/shared` Zod schemas as the single source of validation truth** (client + server). The same `CorrectionFormSchema` / `ClaimFormSchema` that the API validates with also validate the form.
- **Server-side checks** (uniqueness, availability) use `validateHttp()` against an API endpoint.
- **i18n:** the shared Zod schemas are framework-agnostic and cannot hold `$localize` strings, so their messages are never rendered. Templates own user-facing copy via `$localize`, keyed off field validity / `getError(kind)`. **Zod = validation logic; `$localize` = presentation.**

First implementation: the claim & correction submission forms, `apps/web/src/app/requests/` (AECI-128).

### Default: `validateStandardSchema`. Known v22.0.0 constraint with `validateHttp`

Apply the whole Zod schema with `validateStandardSchema(path, schema)` — the idiomatic, one-call approach. The AECI-128 forms use exactly this (`apps/web/src/app/requests/request-form.ts`).

**The one sharp edge:** in `@angular/forms@22.0.0`, `validateStandardSchema` **cannot be combined with `validateHttp()` on the same form.** `validateStandardSchema` registers an internal async-validation *resource* (to support async/Promise standard-schema results), and creating the `validateHttp` resource alongside it trips Angular's re-entrancy guard — **NG0992, "Cannot create a resource inside the `params` of another resource."**

So when a form needs a server-side check (`validateHttp` — uniqueness/availability), drop `validateStandardSchema` and reuse the shared schema **field-by-field** instead:

> `validate(path.field, ({ value }) => … Schema.shape[field].safeParse(value()) …)`, emitting a `standardSchema`-kind error. Equivalent for our flat schemas (no cross-field refinements) and keeps Zod the single source of truth.

AECI-128 originally took the field-by-field path, but its duplicate-check was descoped to the Phase 6 moderation pipeline (server-side de-duplication belongs there), so the shipped form has no `validateHttp` and stays on the simpler `validateStandardSchema`. The first form to genuinely need `validateHttp` (e.g. a Phase 5 "email already registered" check) reintroduces the field-by-field adapter. Revisit if a later `@angular/forms` patch removes the resource collision (tracked as a follow-up).

## Consequences

**Positive**
- One forms standard, signal-native and zoneless-friendly — no `Observable` plumbing, less boilerplate than Reactive Forms.
- Client and server validate against the *same* Zod schemas; rules can't drift.
- `validateHttp` gives first-class server-side validation (uniqueness/availability) with built-in `pending()` state and request cancellation.
- A documented, working exemplar (`apps/web/src/app/requests/`) for the Phase 5/6 forms to copy.

**Negative / trade-offs**
- Signal Forms is new and still evolving; APIs may shift in minor releases.
- The `validateStandardSchema` + `validateHttp` incompatibility is a sharp edge; the field-by-field workaround is more verbose than one `validateStandardSchema` call and must be remembered.
- Reusing Zod client-side ships Zod in the browser bundle (already present transitively; modest).

**Follow-ups**
- Re-evaluate the `validateStandardSchema` + `validateHttp` collision once `@angular/forms` resolves it; if fixed, forms that need a server check can drop the field-by-field workaround and use `validateStandardSchema` directly.
- Adopt Signal Forms for the Phase 5 (auth/reviews) and remaining Phase 6 (moderation) forms.
- `minDate`/`maxDate` validators exist and are documented in `ANGULAR_STYLE_GUIDE.md` §13, but no current form has a date field; wire them in when one does.
