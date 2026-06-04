# v0 → Angular porting rules

> The canonical translation table from v0.dev output to our stack. **Read this end-to-end before porting any v0 screen.** It's the contract the port is reviewed against.
>
> Companion to [`docs/design/v0-system-prompt.md`](./v0-system-prompt.md) (what v0 sees) and [`docs/design/workflow.md`](./workflow.md) (the loop). Canonical visual system is in [`DESIGN.md`](../../DESIGN.md); tokens are defined in [`apps/web/src/styles.css`](../../apps/web/src/styles.css). For a working reference component, see [`apps/web/src/app/demo/spartan-demo.ts`](../../apps/web/src/app/demo/spartan-demo.ts). Broader Angular/TypeScript conventions and lint enforcement live in [`ANGULAR_STYLE_GUIDE.md`](../../ANGULAR_STYLE_GUIDE.md).

---

## Why the port is destructive

v0 emits React + Tailwind + shadcn + lucide-react + hard-coded colors. **None of that survives the port.** The value of v0 output is the *layout, spacing, hierarchy, and visual decisions* — those translate. The code is reference material, not a starting point.

If you find yourself copying v0 code rather than re-implementing it against our stack, stop and re-read this document.

---

## 1. Color tokens

v0 emits hard-coded Tailwind colors (`bg-green-900`, `text-orange-500`), hex literals in `style={}`, and shadcn color variables (`bg-primary`, `bg-muted`). All of it is replaced by **our** semantic tokens.

### Token map

The canonical token set is defined in `apps/web/src/styles.css`. Tailwind v4 exposes each one as a paren-shortcut utility (`bg-(--surface-base)`, `text-(--text-primary)`, etc.) via the `@theme inline` block in that file.

| v0 emits (typical) | Replace with | Token role |
|---|---|---|
| `bg-white`, `bg-gray-50`, `bg-background` | `bg-(--surface-base)` | Page background |
| `bg-gray-100`, `bg-card`, `bg-muted` | `bg-(--surface-raised)` | Cards, raised surfaces |
| `bg-gray-200`, `bg-secondary` | `bg-(--surface-sunken)` | Subtler / lower-priority surface |
| `text-black`, `text-gray-900`, `text-foreground` | `text-(--text-primary)` | Body and heading text |
| `text-gray-600`, `text-muted-foreground` | `text-(--text-secondary)` | Muted / supporting text |
| `text-gray-400` | `text-(--text-tertiary)` | Captions, timestamps, low-priority |
| `border-gray-200`, `border-border` | `border-(--border-default)` | Hairline borders (most cases) |
| `border-gray-300` | `border-(--border-strong)` | Emphasized borders (buttons, inputs) |
| `bg-green-900`, `bg-emerald-800`, `bg-primary` | `bg-(--accent-primary)` | Primary CTAs, primary surfaces (Forest) |
| `hover:bg-green-800` | `hover:bg-(--accent-primary-hover)` | Primary hover |
| `bg-orange-400`, `bg-amber-400`, `bg-accent` | `bg-(--accent-secondary)` | Accent / highlight (Clay) — sparingly |
| `bg-stone-100`, `bg-amber-50` | `bg-(--accent-warm)` | Warm off-white background (Bone) |

The full list lives in `apps/web/src/styles.css`. **If a v0 design uses a color that has no semantic-token equivalent, do not invent a token inline — surface it as a question on the AECI issue.**

### Class syntax

Use Tailwind v4's paren shortcut: `bg-(--accent-primary)`, `text-(--text-primary)`, `border-(--border-default)`, `outline-(--accent-primary)`.

**Do not use** `bg-[hsl(var(...))]` brackets, `style="color: var(--...)"` inline styles, or `class="bg-text-primary"` (Tailwind auto-generated names) — all three work, but the paren shortcut is the established repo convention (see the demo component) and what reviewers will look for.

---

## 2. Component primitives

v0 emits shadcn React components. None survive the port. Replace with Spartan brain primitives + Tailwind composition. Brain is the headless layer (behavior, ARIA, focus, keyboard); the *visual* layer is plain Tailwind on top.

Import from sub-package paths (`@spartan-ng/brain/<primitive>`), not from a barrel.

| shadcn (React) | Spartan brain (Angular) | Import path |
|---|---|---|
| `<Button>` | `BrnButton` directive on a `<button>` | `@spartan-ng/brain/button` |
| `<Card>` | plain `<div>` with token classes — cards are composed, not a primitive | n/a |
| `<Dialog>` / `<Sheet>` | `BrnDialog` + `BrnDialogTrigger` + `BrnDialogContent` + `BrnDialogTitle` + `BrnDialogDescription` + `BrnDialogClose` | `@spartan-ng/brain/dialog` |
| `<Tabs>` | `BrnTabs*` (verify exact primitives at port time) | `@spartan-ng/brain/tabs` |
| `<Popover>` | `BrnPopover*` | `@spartan-ng/brain/popover` |
| `<Tooltip>` | `BrnTooltip*` | `@spartan-ng/brain/tooltip` |
| `<Select>` | `BrnSelect*` | `@spartan-ng/brain/select` |
| `<Accordion>` | `BrnAccordion*` | `@spartan-ng/brain/accordion` |
| `<Checkbox>`, `<Switch>`, `<Radio>` | `BrnCheckbox`, `BrnSwitch`, `BrnRadioGroup` | `@spartan-ng/brain/<primitive>` |
| `<Separator>` | plain `<hr>` (already token-styled by `apps/web/src/styles.css`) | n/a |

**Before importing**, confirm the sub-package exists in `apps/web/node_modules/@spartan-ng/brain/` — Spartan is alpha and packages may not all be present. The list above maps to the upstream Spartan brain catalog; if a primitive isn't installed, surface it on the AECI issue rather than installing on the fly.

For non-interactive elements (badges, tags, dividers, stat blocks), don't reach for a primitive. Just use a styled `<div>` or `<span>`.

Working reference: `apps/web/src/app/demo/spartan-demo.ts` shows BrnButton + BrnDialog wired against tokens.

---

## 3. React → Angular idiom translation

| React (v0 output) | Angular (this repo) |
|---|---|
| `className="..."` | `class="..."` |
| `onClick={fn}` | `(click)="fn()"` |
| `onChange={e => ...}` | `(change)="..."` or `(input)="..."` |
| `useState(initial)` | `signal(initial)` from `@angular/core` (we're zoneless — use signals where state drives the template) |
| `useMemo`, `useCallback` | `computed()` for derived values |
| `{cond && <X />}` | `@if (cond) { <X /> }` |
| `{cond ? <A /> : <B />}` | `@if (cond) { <A /> } @else { <B /> }` |
| `array.map(item => <X key={item.id} />)` | `@for (item of array; track item.id) { <X /> }` |
| `style={{ color: 'red' }}` | **Never.** Move to a Tailwind utility against a token. |
| `<HomeIcon />` (lucide-react) | Verify icon strategy on the AECI issue before porting — if `lucide-angular` is installed, use `<lucide-icon name="home" />`; otherwise raise it as a follow-up rather than inventing |
| `<Link href="/x">` | `<a routerLink="/x">` (Angular Router) — imports `RouterLink` |
| `useRouter()`, `useParams()` | `inject(ActivatedRoute)` + signal-based route data |

---

## 4. Structure

- **Standalone components only.** Angular 21 default. No `NgModule`.
- **Zoneless-compatible.** No `Zone.current`, no `setTimeout` to coerce change detection, no `ChangeDetectorRef.detectChanges()` calls. Use signals for any reactive state.
- **Omit explicit `changeDetection`.** OnPush is the Angular v22+ default; declaring `changeDetection: ChangeDetectionStrategy.OnPush` is redundant dead code (see `ANGULAR_STYLE_GUIDE.md` §5).
- **i18n from day one.** Every user-facing string carries an `i18n` attribute (in templates) or wraps in `$localize` (in TS strings). Use stable IDs: `i18n="@@preview.vendor-detail.heading"`. No bare English strings. Reference: the spartan demo component's `i18n="@@demo.spartan.heading"` pattern.
- **File layout.** Preview components live at `apps/web/src/app/preview/<screen-name>/<screen-name>.component.ts`. One file per component until size demands splitting templates/styles.
- **Theme.** Both light and dark must render correctly. The `.theme-dark` class is toggled on `<html>` by `apps/web/src/app/theme.service.ts`. Token-driven CSS gets this for free — don't write theme-specific classes.

---

## 5. What stays out of the port

- **Real data binding.** Preview routes use hardcoded sample data inside the component file. Wire to Supabase/Prisma in the Phase 2 entity-page issue, not here.
- **Auth, error states, loading states.** Unless v0 explicitly designed an error or empty state and that's part of the brief, skip it — Phase 2 concerns.
- **Routes beyond the preview entry.** Don't add nav, breadcrumbs, or back buttons unless they're part of the v0 reference.
- **Analytics, observability, server actions.** Out of scope for preview routes.
- **Anything that isn't visible on the screen.** If v0 didn't put it there, don't add it.

---

## 6. Verification checklist (run before declaring a port done)

Run all four, post the results as a comment on the AECI issue:

1. **No hard-coded colors.** From the repo root:
   ```bash
   grep -nE '#[0-9a-fA-F]{3,8}|rgb\(|hsl\(' apps/web/src/app/preview/<screen>/
   grep -nwE 'bg-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)-[0-9]+' apps/web/src/app/preview/<screen>/
   ```
   Both must return zero hits. (Exception: the spartan-demo file's inline `style="color: var(...)"` is grandfathered; new ports must not use inline `style`.)
2. **No `className`.** `grep -n 'className' apps/web/src/app/preview/<screen>/` → zero matches.
3. **Visual diff** against the v0 reference at desktop (≥1280px), tablet (~768px), and mobile (~375px) widths. Note any intentional divergences with rationale.
4. **Theme toggle.** Add the `.theme-dark` class to `<html>` in devtools (or use the theme switcher if landed). Every region must adapt — no light-mode-only backgrounds, borders, or text. Screenshot both.

If any check fails, fix before posting screenshots.

---

## 7. Open questions to flag, never invent

If during a port you hit any of the following, **stop and ask on the AECI issue** rather than guessing:

- A v0 color with no token equivalent.
- A v0 component (e.g., date picker, command palette) with no Spartan brain primitive installed.
- An icon system question (lucide-angular not installed, Spartan icons unclear).
- Token naming that feels inconsistent with §2a.2 of `docs/STAGE_1_SPEC.md`.
- Layout that needs a new global utility (e.g., container max-widths not in `apps/web/src/styles.css`).

The token system and primitive catalog are intentionally curated. Inventing locally creates drift that's expensive to undo.
