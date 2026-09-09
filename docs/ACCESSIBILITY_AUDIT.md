# Accessibility Audit — public site (manual / tool-assisted)

**Issue:** [AECI-244](https://linear.app/aec-integrations/issue/AECI-244) — Phase 7.10, manual screen-reader pass
**Spec anchor:** `docs/STAGE_1_SPEC.md` §21.3; scope re-stated by `docs/STAGE_2_5_SPEC.md` §5 as *"the manual screen-reader pass over the **public site**"* (the vendor-portal half is AECI-633, Stage 2.1).
**Procedure:** `docs/a11y-manual-testing-checklist.md` §5 (tool-assisted pass) — this file is the **result**; that file is the repeatable method.
**Measured against:** production `https://www.aecintegrations.com`, commit **`44aba9cf`** (`/api/version` and `/_version` agree, deployed 2026-09-07T00:45:51Z). `main` was **17 commits ahead** at audit time; none of the 17 touch the surfaces or the defects below.
**Date:** 2026-09-09 (UTC) · **Auth state:** signed in as the operator (admin role) · **Browser:** Chrome (only) · **Locale:** `en-US`

**Like the phase-completion gates, this audit surfaces items with evidence rather than silently closing them.** Per AECI-244's "log and ticket" scope, it changes no application code.

---

## 1. Verdict

**The keyboard layer is genuinely clean. The status-message layer is not.**

Every keyboard measurement passed on every surface reached: no keyboard traps, no focus landing on hidden or clipped elements, no interactive element without an accessible name, no dangling `aria-labelledby` / `aria-describedby` reference, and a visible focus indicator on every single focus stop. Home and product detail were walked end to end with real `Tab` presses and both produced a clean, closed focus cycle.

The defect this audit exists to find is **one class, repeated**: a success or state transition that replaces the view without announcing it and without moving focus. It fails **WCAG 2.1 Success Criterion 4.1.3 Status Messages, which is Level AA**, and it lands on the two most important conversion paths on the site — signing in, and submitting a review.

It is invisible to every automated gate we run, for a specific and instructive reason: the defect only exists *after* a form submission, and axe never submits. The 29 axe specs and the Lighthouse a11y ≥ 0.95 budget all measure the default render, where there is nothing to find.

**The codebase already knows the right pattern.** `/admin/reviews` and `/admin/overview` both ship a persistent `sr-only` `role="status" aria-live="polite"` region that exists *before* it is populated. That is the reference implementation. Login and review submission simply do not have one.

### Scorecard against §21.3

| §21.3 requirement | Verdict | Evidence |
|---|---|---|
| Automated: axe-core in Playwright | ✅ Already shipped | 29 specs at `wcag2a/wcag2aa/wcag21a/wcag21aa`, zero-violation assertions |
| Lighthouse Accessibility ≥ 95 enforced in CI | ✅ Already shipped | `.lighthouserc.cjs`, error-gated on 15 URLs |
| Manual: keyboard-only through the full review-submission flow | ⚠️ **Partial** | Form semantics and controls verified. The `Tab` walk and the submit step were **not** completed — see §6 |
| Manual: screen reader on home / product / review submission | ⚠️ **Machine layer done, speech layer open** | §3 findings; the VoiceOver and NVDA scripts in the checklist §6/§7 close the rest |

---

## 2. What this method establishes, and what it cannot

The pass was run with Chrome MCP browser automation. `read_page` returns **Chrome's own accessibility tree** — roles and accessible names, the data a screen reader consumes — and `computer` dispatches real key events, so focus order is measured rather than simulated.

**Established by machine, and trustworthy:** sequential focus order and cycle closure, keyboard traps, focusable-but-hidden elements, accessible-name presence and uniqueness, IDREF resolution, heading and landmark structure, skip-link wiring, ARIA state attributes, live-region presence and shape, and computed focus-indicator styles.

**Not established, and not claimed anywhere in this document:** how VoiceOver and NVDA actually *speak* the tree. Verbosity, announcement ordering, double-speaking, rotor and element-list behaviour, and NVDA browse-mode versus forms-mode transitions are all screen-reader-specific. A `MutationObserver` sees DOM, not speech.

**Browser coverage is Chrome only.** The checklist mandates Safari + VoiceOver and Firefox/Chrome + NVDA. This pass covers **neither** of those two browsers.

### Method notes worth keeping (they cost an hour to discover)

- **The MCP tab runs with `document.visibilityState === "hidden"` and `document.hasFocus() === false`.** In that state the browser does not process sequential focus navigation at all: `Tab` presses are silently dropped and the focus log stays empty. Calling `window.focus()` from `javascript_tool` sets `hasFocus` to `true` and makes `Tab` work. **A run that skips this step measures nothing and looks like a clean pass.**
- **A `computer` screenshot in the same batch is a second, independent activator.** Without one, key events intermittently stop landing even when `hasFocus` is `true`.
- **Both activators failed on `/products/:slug/review`.** Screenshot injection timed out repeatedly there and the renderer eventually became unresponsive, which is why that surface's `Tab` walk is a coverage gap rather than a result.
- **`read_page` with `filter: "interactive"` returns only viewport-visible nodes.** It is a spot check, not a full accessibility-tree dump.
- **Run-validity gate: clean.** Zero AECi console errors and zero hydration errors (NG0500 / NG0602) on every surface. The only console traffic came from a browser extension. Extension-injected DOM was excluded from the results — `div#1p-menu-live-region` is 1Password, not ours.
- `[ngh]` dehydrated-block count reached `0` on product detail, so the `@defer (on viewport)` integration tables **did** render despite the hidden tab. That risk did not materialise.

---

## 3. Findings

Severity uses the checklist §3 scale. `confidence` is `machine-verified` (measured directly), or `needs-human` (DOM shape proven, announcement behaviour not).

### 3.1 Serious — WCAG 2.1 **4.1.3 Status Messages (AA)**

One defect class, three instances. Grouped because the remedy is identical.

| # | Surface | What happens |
|---|---|---|
| **A1** | `/auth/login` | Submitting the magic-link form flips `emailSent()`, and `@if` swaps **the entire view** for a "Check your email" panel. No live region is present in either state, and there is no focus move. The submit button that had focus is destroyed with its branch, so focus falls back to `<body>`. The page's one `role="status"` (`login.html:63`) sits inside `@if (unavailable())` — the Supabase-missing degrade path — so it never renders on a working sign-in and cannot carry this announcement. |
| **A2** | `/products/:slug/review` | Identical shape. `@if (submitted())` swaps the whole form for "Review received". No live region, no focus move, focused submit button destroyed. |
| **A3** | `/account` | Renders "Loading your account…", then replaces it with the loaded content. Neither state contains a live region, so the transition is announced by nothing. |

**Why it matters.** A screen-reader user submits the form and receives no indication that anything happened. Their reading position is simultaneously lost, because the element they were on no longer exists. On `/auth/login` this is the only confirmation that a sign-in link was sent, so the user has no way to know whether to check their email or press the button again.

**Evidence.**

| Instance | Source at `44aba9cf` | Confirmed absent |
|---|---|---|
| A1 | `apps/web/src/app/auth/login.html:5-35`; `login.ts:93` sets the signal | `login.ts` has no `.focus()` call and no announcement; the page's live-region count measured **0** (the `role="status"` at `login.html:63` is inside `@if (unavailable())`) |
| A2 | `apps/web/src/app/reviews/review-form.html:8-27`; `review-form.ts:320` | `review-form.ts` has no focus move; page live-region count measured **0** |
| A3 | `apps/web/src/app/account/account.html`; the `role="status"` at line 94 is inside `@if (saved())` | live-region count measured **0** in both the loading and loaded states |

**The correct pattern already exists in the repo.** `/admin/reviews` and `/admin/overview` render `<p class="sr-only" role="status" aria-live="polite">` **outside** any `@if`, so the region is present before the text arrives. Measured live on both.

**What to do.** For a whole-view swap, moving focus is better than announcing, because it fixes the lost reading position too: give the success heading `tabindex="-1"` and focus it after the swap. A persistent `role="status"` region is the alternative, and is the right choice for A3's loading transition.

**Regression test each fix must add.** The two specs are in different starting positions, so the work differs. `apps/web/e2e/auth-login.spec.ts` never submits at all — every one of its four tests measures the default render, so A1's fix has to add a submit step first. `apps/web/e2e/reviews-submission.spec.ts` **does** submit: its "a filled form submits and shows the moderation confirmation" test stubs `POST /api/reviews`, fills the form and clicks submit, then asserts only that the confirmation copy is *visible*. A2's fix therefore extends an existing test rather than adding one. In both cases the new assertion is the same: `document.activeElement` is the success heading, or a pre-existing `role="status"` received the text. Note that the axe scan in each file is a **separate** test on the default render, so neither suite would catch this class even where a submit already happens. The assertion style already exists in `apps/web/e2e/nav-menu.spec.ts`, which asserts Escape-closes-and-returns-focus.

### 3.2 Serious — link and landmark ambiguity

| # | Surface | Finding | SC |
|---|---|---|---|
| **A4** | Home | Three links with the **identical** accessible name `"Source (opens in a new tab)"` point to three **different** external destinations (`originality.ai`, `vendr.com`, `capterra.com`). No `aria-label`, no `title`. In a rotor or `NVDA+F7` links list — a primary screen-reader navigation mode — they are indistinguishable. | 2.4.4 (A) in context, 2.4.9 (AAA) outright |
| **A5** | Home | Two `role="search"` landmarks (header and hero), **neither named**, each containing a `role="combobox"` whose accessible name is also identical. A landmarks list shows two entries reading "search". | 1.3.1 (A) / 2.4.1 (A) |

**Why axe does not catch either.** `landmark-unique` and `identical-links-same-purpose` are tagged `best-practice`, and the e2e suite filters to `wcag2a/wcag2aa/wcag21a/wcag21aa`. The rules are excluded by configuration, not missing.

**What to do.** A4: give each link an `aria-label` naming its source. A5: add `aria-label="Site search"` and `aria-label="Search integrations"` (or equivalent) to the two forms.

### 3.3 Minor

| # | Surface | Finding |
|---|---|---|
| **A6** | Login, review, account | Submit buttons use the `disabled` attribute rather than `aria-disabled`, so they leave the tab order entirely. A screen-reader user tabbing the form never encounters the button and receives no programmatic explanation of what is blocking submission. On the review form no field carries `required` or `aria-required` either, so required-ness is conveyed only by the *absence* of "(optional)" in the visible label. Affects `Email me a sign-in link`, `Submit review`, and `Save`. |
| **A7** | Product detail | Both integration `<table>` elements have **no accessible name** — no `<caption>`, no `aria-label` — and identical column headers (`Direction`, `Integrates with`, `Connection`, `Details`). Navigating by table gives two indistinguishable tables. The `<h3>`s directly above them ("Direct integrations", "Via Kroo Connector") make this a one-line `aria-labelledby` fix. |
| **A8** | Product detail | The "On this page" section nav exposes `aria-current` on **none** of its four links. The nav itself is correctly named. (2.4.8 Location is AAA, so this is an enhancement, not a conformance failure.) |
| **A9** | Product detail | "Visit website" opens a new tab (`target="_blank"`) with no warning to the user. Home's source links **do** carry an "(opens in a new tab)" hint, so this is an inconsistency within the product rather than a missing capability. |
| **A10** | `/admin/reviews` | `aria-current="page"` is set on both the `<a>` and its parent `<li>`, so the state may be announced twice. |

### 3.4 Needs a human with a real screen reader

These are the items the machine pass proved the *shape* of but cannot adjudicate. The checklist §6 and §7 scripts are built from this list.

| # | Question only VoiceOver/NVDA can answer |
|---|---|
| **H1** | `<main id="main">` has **no `tabindex="-1"`** (`apps/web/src/app/app.ts:21`). Keyboard behaviour is **correct and verified**: activating the skip link moves the sequential start point, and the next `Tab` lands on `input#hero-search` inside `#main`. What is unverified is whether the AT *virtual cursor* follows. Adding `tabindex="-1"` is cheap insurance either way. |
| **H2** | `home-feedback-form.ts:52-56` and `account.html:91-94` place a `role="status"` region **inside** an `@if`, so it is inserted into the DOM already populated. NVDA generally does not announce a polite region on insertion. Does the message actually speak? |
| **H3** | Many labels are ALL CAPS (`YOUR EMAIL`, `HEADLINE`, `OVERALL RATING`, `VENDOR`, `CATEGORIES`). Some screen readers spell short all-caps tokens letter by letter. Do these read as words? |
| **H4** | The search autocomplete announces no result count when its listbox opens; the user gets `aria-activedescendant` on the first option only. Measured: 10 options appeared with no count message. Is arrowing through sufficient in practice? |

---

## 4. Checks that were made and found nothing

Recorded so a later reader knows these were tested rather than skipped, and so a re-run can tell a regression from a first sighting.

**Keyboard, measured with real `Tab` presses:**

| Surface | Candidates | Cycle | Traps | Focus on hidden el. | Missing focus ring |
|---|---|---|---|---|---|
| Home | 120 | 81, closed (wrap at 82 of 160 presses) | 0 | 0 | 0 |
| Product detail | 125 | 86, closed (wrap at 86 of 150 presses) | 0 | 0 | 0 |

On both, every unreached candidate was inside a **collapsed nav flyout** and correctly excluded from the tab order.

**Refuted candidates** — each was a plausible defect that the evidence disproved:

- **Combobox missing `aria-controls`.** Present only in the collapsed state, which is correct per ARIA 1.2. On typing, `aria-expanded` flips to `true`, `aria-controls` resolves to a real `role="listbox"` with 10 `role="option"` children, and `aria-activedescendant` is set. Escape collapses it and keeps focus on the input.
- **Placeholder used as label.** Both search inputs have a real `<label class="sr-only">`.
- **Dangling `aria-labelledby` / `aria-describedby`.** Zero on any surface, including the Spartan `brn-dialog-title-undefined` failure mode that the optional chaining in `BrnDialogTitle` makes possible.
- **Interactive elements with no accessible name.** Zero on home and product detail. Icon-only buttons carry `aria-label` ("Open menu", "Open search", "Account menu").
- **Decorative glyphs read aloud.** The `↗` on "Visit website" is `aria-hidden="true"`; the `★` rating options carry `aria-label="1 star"`…`"5 stars"`. No unhidden decorative glyph anywhere in `main`.
- **Duplicate `banner` landmark on product detail.** The second `<header>` is nested inside `<main>`, so it maps to `generic`, not `banner`. Not a landmark at all.
- **Duplicate "About" link name on product detail.** The two live in differently-named `nav` landmarks ("On this page", "Company"), which supplies the context 2.4.4 requires.
- **A `role="img"` chart with no data table** (`/admin/overview`). This is `sparkline.ts`, and the omission is deliberate and documented in the component: the stat tile always renders the figure itself, satisfying `ADMIN_PANEL_SPEC.md` §8's "charts are never the only representation" rule. **This discharges the chart half of the `docs/TESTING_STRATEGY.md` §8 manual-pass debt.** The 30-day chart beside it correctly renders its `sr-only` `<table>` with a caption and 30 rows as a **sibling** of the `role="img"` element, exactly as `chart-a11y.component.spec.ts` requires.
- **Heading structure.** One `h1` and zero level skips on home (16 headings), product detail (15), login, account and the admin queue.
- **Star-rating listbox.** Correct roving tabindex (first option `0`, rest `-1`), resolving `aria-labelledby`, per-option `aria-label`.

---

## 5. Per-surface results

| Surface | Reached | Keyboard | Structure | Names | Status messages |
|---|---|---|---|---|---|
| Home `/` | ✅ | ✅ clean | ✅ | ⚠️ A4, A5 | n/a |
| Product detail `/products/microsoft-fabric` | ✅ | ✅ clean | ⚠️ A8 | ⚠️ A7, A9 | n/a |
| Login `/auth/login` | ✅ | not walked | ✅ | ✅ | ❌ **A1** |
| Review submission `/products/:slug/review` | ✅ | ⚠️ partial (§6) | ⚠️ single `h1`, no `h2` | ✅ | ❌ **A2** |
| Account `/account` | ✅ | not walked | ✅ | ✅ | ❌ **A3** |
| Admin queue `/admin/reviews` | ✅ | not walked | ✅ | ✅ | ✅ reference-good |
| Admin overview `/admin/overview` | ✅ (bonus) | not walked | ✅ | ✅ | ✅ reference-good |

---

## 6. Coverage gaps — what this audit does **not** cover

Stated plainly so nobody reads a gap as a pass.

1. **No real screen reader.** Chrome's accessibility tree is not VoiceOver or NVDA speech. §3.4 is the scoped residue; the checklist §6/§7 scripts close it.
2. **Chrome only.** No Safari, no Firefox. The checklist mandates both.
3. **No submission was performed anywhere on production**, by design — a review submit writes a real row, runs toxicity scoring and sends email; a login submit sends a real magic link. A1, A2 and A3 are therefore **source-verified at `44aba9cf`**, not observed live. The source is unambiguous, and `login.html` is byte-identical between the production SHA and `main`.
4. **The review-submission `Tab` walk is incomplete.** Key events stopped reaching that page and the renderer eventually became unresponsive. The form's static semantics were fully captured; the focus *order* was not. This is the one part of AC #2 still open.
5. **Three dialogs were never opened.** Production's moderation queue is empty (0 reviews pending), the operator account has no reviews, so no delete-review dialog exists, and the delete-account dialog is destructive so it was deliberately left alone. Dialog focus management — focus entry, bidirectional trap, Escape, focus restore — is **untested on every surface**. It is the single largest remaining gap and is best closed on a local seeded database, not production.
6. **Desktop viewport only** (1494×1239). The mobile nav (`aec-nav-menu`, `lg:hidden`) was never rendered, so its disclosure and dialog behaviour is untested.
7. **No product with reviews was available**, so the rating and review summary on product detail could not be exercised.

---

## 7. Follow-ups

| Item | Severity | Filed as |
|---|---|---|
| A1 / A2 / A3 — status messages on view swap | **Serious (WCAG 4.1.3 AA)** | [AECI-829](https://linear.app/aec-integrations/issue/AECI-829) |
| A4 — three identical "Source" links · A5 — two unnamed search landmarks | Serious | [AECI-830](https://linear.app/aec-integrations/issue/AECI-830) |
| A6–A10 — minor set | Minor | [AECI-831](https://linear.app/aec-integrations/issue/AECI-831) |
| Dialog focus management, review-form `Tab` walk, mobile viewport | Coverage — needs a **local seeded** run | [AECI-832](https://linear.app/aec-integrations/issue/AECI-832) |
| H1–H4 — VoiceOver / NVDA adjudication | Human | **AECI-244 itself** — run the checklist §6/§7 scripts, then fill the §4 run log |

All four defect and coverage issues live in the **Stage 3** Linear project, seeded 2026-09-09 by
operator decision. Note the divergence so a later reader does not take it for a filing error:
`docs/STAGE_2_5_SPEC.md` §5 and the `docs/STAGE_3_SPEC.md` §3 triage table had both scoped the AECI-244
close-out to Stage 2.5. Both are annotated, and `STAGE_3_SPEC.md` §2.5 now carries the four issues.

**AECI-244 does not close on this audit, and it does not move to Stage 3.** The machine layer is done
and the defects it found are filed. What remains on the issue is the speech layer: the §6 VoiceOver and
§7 NVDA walkthroughs, about ten minutes each, plus a dated §4 run-log entry. That stays where
`STAGE_2_5_SPEC.md` §5 puts it, because it is a human run rather than a code change.

---

## 8. Reproducing this audit

1. Read both version endpoints and record the SHA; confirm they agree.
2. Follow `docs/a11y-manual-testing-checklist.md` §5 for the tool-assisted pass, including the `window.focus()` step — without it the harness silently measures nothing.
3. Run the §6 VoiceOver and §7 NVDA scripts, and fill a dated copy of the §4 run log.
4. For the §6 coverage gaps, run against a **local seeded** environment (`pnpm dev:agent`, then `pnpm --filter @aeci/api db:seed-reviews -- --apply` so the moderation queue and the review lists are non-empty). Dialogs and the submit paths can be exercised safely there.
