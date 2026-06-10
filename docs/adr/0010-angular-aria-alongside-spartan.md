# ADR 0010: Angular Aria for new interactive/form patterns, alongside Spartan

**Status:** **Proposed** (2026-06-05)

**Context owner:** Chris Walton

Spike outcome for AECI-129 ("Evaluate Angular Aria vs Spartan/CDK"), PR 6 of the Angular v22 adoption
epic (AECI-122). A **recommendation**, not yet ratified — see "Decision" for the proposed posture and
"Follow-ups" for what flips this to **Accepted**. Builds on ADR 0005 (Spartan over Syncfusion) and
ADR 0009 (Signal Forms); does not supersede either.

---

## Context

Angular 22 (GA 2026-06-03) shipped **Angular Aria (`@angular/aria`)** as **stable** — graduated from the
v21 developer preview, announced alongside stable Signal Forms and `resource`. Angular Aria is a set of
**headless, accessible directives** that implement common WAI-ARIA patterns (keyboard interaction, ARIA
attributes, focus management, screen-reader support); the consumer provides the HTML structure, the CSS,
and the business logic. It covers 12 directives across 8 pattern families: Autocomplete, Listbox, Select,
Multiselect, Combobox; Menu, Menubar, Toolbar; Accordion, Tabs, Tree, Grid. (Refs:
`angular.dev/guide/aria/overview`; the bundled best-practice reference at
`.agents/skills/angular-developer/references/angular-aria.md`.)

This overlaps the app's existing primitive layer. Per **ADR 0005**, AECi standardized on **Spartan UI
brain primitives (`@spartan-ng/brain`) + Tailwind v4 + Angular CDK** — headless brain primitives styled
directly with Tailwind tokens, helm codegen off, no project-level wrapper components
(`ANGULAR_STYLE_GUIDE.md` §19). Angular Aria sits in the **same category**: a headless, bring-your-own-CSS
behavior layer. So the question is genuine — where, if anywhere, does the first-party option now belong?

**Current Spartan/CDK footprint (verified across `apps/web/src`):**

- **In production:** `BrnButton` (`layout/theme-toggle.ts`) and `BrnPopover` (`layout/mobile-nav-menu.ts`,
  for the mobile nav dropdown — leaning on Spartan's CDK overlay + focus-trap + Escape/outside-click).
- **Demo/preview only (not in production routing):** `BrnDialog` (`demo/spartan-demo.ts`) and `BrnTabs`
  (`preview/vendor-detail/vendor-detail.ts`).
- **No direct `@angular/cdk` imports anywhere** — CDK is a transitive dependency consumed only through
  Spartan (overlay, focus-trap).
- **No wrapper layer** — consuming templates compose Tailwind classes on brain primitives directly.
- **Forms** are **Signal Forms** (ADR 0009) over **plain HTML `<input>`/`<textarea>`**
  (`requests/request-form.ts`). There are **no `select` / `checkbox` / `radio` / `combobox` primitives in
  the app yet** — those patterns are entirely greenfield.

**Two facts shape the recommendation:**

1. **Angular Aria does not replace Angular CDK.** Aria's dropdown patterns (combobox/select/multiselect)
   still rely on **CDK Overlay** for positioning, and its test harnesses are built on
   `@angular/cdk/testing`. CDK remains the shared overlay/positioning foundation regardless.
2. **Angular Aria has no dialog, popover, or tooltip primitive.** The overlay-anchored primitives Spartan
   provides today (Popover, Dialog) have **no Aria equivalent**.

Finally, the dependency angle the issue raises: `@spartan-ng/brain` is `0.0.1-alpha.689` and has **no
v22-compatible release**; it is force-installed onto Angular v22 via root `package.json` pnpm
`peerDependencyRules.allowedVersions` (`@spartan-ng/brain>@angular/{core,common,forms,cdk}`: "22"). That
override block is the "peer-override cleanup" tracked under the v22 epic.

## Decision

**Proposed posture: adopt Angular Aria as the default for _new_ interactive and form-control patterns it
covers, keep Spartan for the overlay primitives it uniquely provides, and migrate nothing reactively.**
**Do not rip out Spartan** (per the issue's explicit constraint).

1. **New interactive/form-control patterns → Angular Aria.** When the app first needs a select, combobox,
   multiselect, listbox, radio group, accordion, tree, grid, menu/menubar, or toolbar, build it on
   `@angular/aria`. Rationale: it is **first-party and now stable** (removing reliance on a third-party
   _alpha_ for new surfaces), it **integrates with Signal Forms out of the box** (the `[formField]`
   directive detects `ngCombobox`/`ngListbox` as custom controls via their `value` model — ADR 0009
   synergy), and Angular's own "when to use Aria" (design system / custom brand / headless, needs custom
   CSS) describes AECi precisely.

2. **Form controls are the highest-value entry point.** The Phase 5/6 forms (auth, reviews, moderation)
   will be the first to need selects/comboboxes/radios. They already use Signal Forms over plain HTML, so
   Aria is additive — no Spartan form-control layer exists to displace.

3. **Keep Spartan for overlay primitives.** Popover and Dialog have no Aria equivalent and depend on CDK
   Overlay either way; they stay on Spartan. `BrnButton` also stays (trivial, no reason to move).

4. **Migrate nothing reactively.** Existing production usage (Button, Popover) is untouched. The
   demo/preview-only `BrnTabs` is the natural **low-risk pilot** to validate the token-binding + both-theme
   + axe story before Aria is blessed as the standing default — tracked as a follow-up, **not** this spike.

**Pattern-by-pattern overlap:**

| Pattern | Covered by Angular Aria? | Current app usage | Recommendation |
| --- | --- | --- | --- |
| Button | No (use native `<button>`) | `BrnButton` (prod) | Keep Spartan / native; no change |
| Popover | **No** | `BrnPopover` (prod) | **Keep Spartan** (needs CDK Overlay; no Aria equivalent) |
| Dialog / Modal | **No** | `BrnDialog` (demo only) | **Keep Spartan** (no Aria equivalent) |
| Tooltip | **No** | none | Spartan or CDK when needed |
| Tabs | Yes | `BrnTabs` (preview only) | New tabs → Aria; pilot-migrate the preview one |
| Accordion | Yes | none | **Aria** |
| Combobox / Select / Multiselect | Yes (popup uses CDK Overlay) | none | **Aria** (binds to Signal Forms) |
| Listbox | Yes | none | **Aria** |
| Radio group | Yes | none | **Aria** |
| Menu / Menubar | Yes | none | **Aria** |
| Toolbar | Yes | none | **Aria** |
| Tree | Yes | none | **Aria** |
| Grid (keyboard data grid) | Yes | none | **Aria** |

**Design-system implications.** Angular Aria is styled exactly like Spartan brain: Tailwind utilities
targeting the `aria-*` attributes the directives toggle (`[aria-selected]`, `[aria-expanded]`,
`[aria-checked]`, …), bound to the OKLCH tokens, borders-not-shadows, rendered correctly in **both
themes**. Running **two headless behavior providers is not a "mashup"** under the Anchor-Site Rule — that
rule governs **visual** composition (which Mobbin site anchors a surface's hierarchy, density, atmosphere),
which is owned by tokens and layout, not by which library supplies keyboard/ARIA behavior. Editorial
coherence is unaffected by the behavior provider. (`DESIGN.md` §5, Named Rules.)

**Peer-override link.** Adopting Aria for new work **shrinks** Spartan's role but does **not** eliminate
it — Popover and Dialog keep Spartan on the dependency graph. So the `@spartan-ng/brain>@angular/*` pnpm
peer overrides **must stay** until either (a) `@spartan-ng/brain` ships a v22-compatible release, or
(b) Popover/Dialog are migrated off Spartan (e.g. onto CDK Overlay directly). **This ADR informs but does
not resolve the peer-override cleanup.**

## Consequences

**Positive**

- New interactive and form behavior comes from a **first-party, stable** package, reducing reliance on a
  third-party `alpha` for greenfield surfaces.
- **Native Signal Forms integration** — Aria controls bind to `[formField]` with no adapter, extending the
  ADR 0009 "one forms standard" story to rich controls (select/combobox/multiselect).
- No design-system conflict: same headless styling model, same tokens, same both-theme + axe discipline;
  the Anchor-Site Rule still owns visual coherence.
- CDK stays the single shared overlay/positioning/testing foundation under both Spartan and Aria — no new
  infrastructure.
- "Do not rip out Spartan" is honored; zero churn to shipping code.

**Negative / trade-offs**

- Two headless providers for contributors to know (Spartan for overlays, Aria for selection/forms/layout).
  Mitigated by a clear split and a docs pointer, but it is more surface than one library.
- Angular Aria stabilized **two days before this ADR** (2026-06-03); real-world edge cases are unproven.
  Hence pilot-before-default rather than an immediate blanket mandate.
- Aria dropdowns still require **CDK Overlay** wiring for positioning — Aria is behavior, not a floating
  layer; the team owns the overlay glue (as it does implicitly through Spartan today).
- Headless means the team writes **all** the CSS for Aria components (same cost profile as Spartan; no
  batteries-included themed widgets).
- Does **not** by itself unblock the peer-override cleanup (Popover/Dialog keep Spartan in the tree).

**Follow-ups**

- **Pilot:** port the demo/preview `BrnTabs` (`preview/vendor-detail/vendor-detail.ts`, non-production) to
  Angular Aria `ngTabs`, validating token-binding, both themes, and an axe-clean pass. Open as its own
  low-priority issue.
- **First real use:** adopt Aria select/combobox/radio for the first Phase 5/6 form that needs them; treat
  it as the reference implementation (mirroring how `requests/` is the Signal Forms exemplar).
- **Ratify:** on sign-off, flip this ADR **Proposed → Accepted** and harden the companion-doc wording
  (`ANGULAR_STYLE_GUIDE.md` §19, `DESIGN.md` §5) from "proposed default" to a rule.
- **Peer overrides:** revisit the `@spartan-ng/brain>@angular/*` overrides once Popover/Dialog's future is
  decided (keep on Spartan vs. move to CDK Overlay), since that — not Aria adoption — is what can remove
  the last Spartan peer dependency.

## Pilot results (AECI-132)

Status stays **Proposed** — this records the pilot evidence the "Ratify" follow-up needs; the
Proposed → Accepted flip is a separate sign-off.

The demo/preview Tabs in `apps/web/src/app/preview/vendor-detail/` were ported from Spartan
`BrnTabs`/`BrnTabsList`/`BrnTabsTrigger` to Angular Aria `@angular/aria@22.0.0`
(`ngTabs`/`ngTabList`/`ngTab`/`ngTabPanel`/`ngTabContent`). Production Spartan usage (Button, Popover) is
untouched, including the `brn-popover`s living *inside* the ported Products panel.

**Token-binding ergonomics — Aria is a clear win over Spartan for this pattern:**

- **Selected-state styling is now declarative.** Spartan exposed no `aria-selected` to target, so the
  active tab was styled by a `tabTriggerClass(key)` TS method that read the component's `activeTab()`
  signal and concatenated active/inactive class strings — styling logic split across `.ts` and `.html`.
  Aria toggles `aria-selected` on each tab, so the same look is one static class string using the
  built-in Tailwind `aria-selected:` variant bound to tokens
  (`aria-selected:border-(--accent-primary) aria-selected:text-(--text-primary)`). No TS method, no
  state mirror — identical model to how brain primitives are *meant* to be styled, finally available for
  the selected state too.
- **Less component state.** The `onTabChange()` writeback and `tabTriggerClass()` method were both
  deleted; selection is a single `[(selectedTab)]` two-way binding to one signal. (Note: the model is
  typed `string | undefined`, so the backing signal widened from the `'overview' | 'products'` union.)
- **A11y wiring is free.** `role="tab"/"tablist"/"tabpanel"`, `aria-controls`/`aria-labelledby`, roving
  `tabindex`, and `inert` on hidden panels are all applied by the directives — the manual
  `role="tablist"`/`role="tabpanel"` attributes the Spartan version carried were removed. Keyboard nav
  (arrows, Home/End, automatic `selectionMode="follow"` activation) works without app code.
- **Panel show/hide requires `ngTabContent`.** `ngTabPanel` only marks the inactive panel `inert`/hidden
  and notes "proper styling is required for visual hiding"; wrapping panel bodies in
  `<ng-template ngTabContent>` (its `DeferredContent` host directive) renders the inactive panel empty,
  which both hides it and lazy-loads content. This is the one structural rule worth flagging for the
  first real adopter — it is not optional.
- **Dependency posture improved.** Tabs now run on a first-party stable package instead of
  `@spartan-ng/brain` `0.0.1-alpha.689`. No new pnpm peer overrides were needed (Aria's peers are the
  already-present v22 `@angular/{core,common,cdk}`).

**Validation:** borders-not-shadows preserved (2px `--accent-primary` underline on the selected tab,
transparent otherwise); renders correctly in light and dark; covered by
`apps/web/e2e/preview-vendor-detail-tabs.spec.ts` — the tab controls are axe-clean in both themes, and
keyboard nav (arrows, Home/End, Enter/Space, pointer) is asserted to drive `aria-selected` + panel
visibility.

**Two findings to flag for the first adopter:**

1. **`ngTabContent` defers content past SSR.** Its `DeferredContent` host directive renders the panel
   body on the client after hydration, so even the default-selected panel is **empty in the server HTML**
   (verified: the tab bar SSRs with full roles/`aria-controls`/`aria-labelledby`, but panel content does
   not). Fine for this preview demo, but a content surface that needs the default tab's body in the SSR
   payload (SEO / no-JS) should render that panel eagerly rather than via `ngTabContent`. The trade-off:
   `ngTabPanel` only marks the hidden panel `inert` (it notes "proper styling is required for visual
   hiding"), so eager panels need their own hide rule — `ngTabContent` gives hide-for-free at the cost of
   SSR content.
2. **Adding axe coverage surfaced pre-existing contrast debt.** The demo page had never been axe-tested;
   the new spec flagged WCAG-AA `color-contrast` failures from the `--text-tertiary` token on small
   labels (header eyebrow, card titles, `dt` labels) — pre-existing, not caused by the port. The ported
   **tab controls** were brought to AA (inactive label/badge use `--text-secondary`, ~7:1 in both
   themes); the page-wide `--text-tertiary` token debt is out of scope here and should be tracked
   separately. The pilot's axe assertion is therefore scoped to `[role="tablist"]`.

**Net:** for selection/disclosure patterns, Aria's `aria-*`-attribute surface makes token-bound,
both-theme styling *more* ergonomic than Spartan brain, not merely equivalent. Nothing surfaced in the
pilot argues against the proposed posture; the `ngTabContent`-vs-SSR trade-off is the one structural rule
to document for adopters.

## First combobox adoption (AECI-144)

Status stays **Proposed** — this records the first real `@angular/aria` **combobox** adoption (the
"First real use" follow-up's trigger). The Proposed → Accepted flip is a separate sign-off; this adoption
is the evidence for it and the **recommendation here is to ratify**.

The header search-as-you-type autocomplete (`apps/web/src/app/search/search-autocomplete.ts`,
`aec-search-autocomplete`) was built on `@angular/aria@22.0.0` `Combobox`/`ComboboxPopup`/`ComboboxWidget`
(`@angular/aria/combobox`) + `Listbox`/`Option` (`@angular/aria/listbox`), and is mounted in **both** the
desktop header (`lg+`) and the mobile `BrnPopover` overlay (`layout/site-header.ts`, `layout/nav-menu.ts`).
This **precedes** the Phase 5/6 form the ADR anticipated as the first adopter, and is a **non-form** case:
the combobox value is a transient query string, not a `[formField]`, so it does **not** exercise the Signal
Forms integration — that path still wants a Phase 5/6 form as its reference implementation.

**Pattern recipe — "navigation autocomplete" (vs. value autocomplete).** Selecting a suggestion navigates
to a detail page rather than filling the input. The commit signal is the **listbox `value` model**
(`(valueChange)` on `ngListbox`); each `ngOption [value]` carries the full suggestion object, so the
handler reads the committed object and routes. The combobox `[(value)]` (query text) and the listbox
`[(value)]` (selection) are independent models — Aria does not copy the option into the input. The
network search is owned by the app (debounced `liteClient.searchForHits`), not by Aria; Aria owns only the
widget/keyboard/overlay. This is the reusable shape for "search box that jumps to a record."

**Findings to flag for the next adopter:**

1. **SSR is clean and cache-safe.** The `<input ngCombobox>` SSR-renders with `role="combobox"` +
   `aria-autocomplete`/`aria-expanded`/`aria-haspopup` already applied (Aria runs on the server). The
   popup lives in `ng-template ngComboboxPopup` (a `DeferredContent` host directive, like `ngTabContent`),
   so suggestions are **never** in the server HTML — the header stays visitor-state-neutral and safe inside
   cached SSR responses (verified by curling `/products`).
2. **Collapsed combobox is axe-clean — no dangling `aria-controls`.** `ComboboxPattern.popupId` is
   `computed(() => popup()?.popupId())`, and the popup's id derives from the `ComboboxWidget`, which lives
   in the deferred popup template. While collapsed the widget isn't instantiated, so `popupId()` is
   `undefined` and Angular **omits** `aria-controls` — there is no reference to a non-existent element.
   (**Watch-out:** Aria's combobox `(input)` handler sets `expanded` on **every keystroke**, so gating
   *expansion* on a non-empty result set is impossible — the popup opens before results exist. Instead render
   the `ngListbox` itself only when there is ≥1 hit (`@if (suggestions().length > 0)`): a zero-hit query then
   mounts no widget, so there's no empty `role="listbox"` (an `aria-required-children` risk) and no empty
   floating panel. The same omitted-`aria-controls` reasoning above applies to this gated-empty state, not
   just the collapsed state.)
3. **CDK Overlay positions the popup**, as the ADR predicted — no new infra (CDK is already a transitive
   dep) and no hand-rolled `top-full` positioning needed.
4. **Token styling matched the tabs ergonomics:** highlight via the `data-[active=true]:` variant Aria sets
   on the active option, selection via `aria-selected:`; both-theme via tokens, no TS state mirror.

**Open / deferred:**

- **Live interactive + mobile-nesting verification is pending a provisioned Algolia index.** The local
  `preview_*` indexes don't exist (queries 404 → the controller's catch degrades to "no dropdown"), and the
  browser extension wasn't available in this environment, so the open → ArrowDown → Enter flow and the
  combobox-CDK-overlay-inside-`BrnPopover`-CDK-overlay interaction (Escape ordering, outside-click,
  clipping) were **not** exercised end-to-end here. They are covered by the unit/component specs (handler
  logic + a11y structure + graceful degradation) and will light up in the existing `phase2-a11y` e2e
  (which axe-scans the header) once a staging index is seeded — mirroring how that spec self-skips
  fixture-dependent cases. **Recommend a staging smoke before ratifying** the mobile mount.
- **Ratification:** with this non-form adoption + the tabs pilot, the recommendation is to flip Proposed →
  Accepted and harden `ANGULAR_STYLE_GUIDE.md` §19 / `DESIGN.md` §5 wording — pending Chris's sign-off and
  the staging smoke above.
