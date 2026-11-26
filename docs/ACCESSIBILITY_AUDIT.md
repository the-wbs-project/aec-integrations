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
| Automated: axe-core in Playwright | ✅ Already shipped | 29 specs at `wcag2a/wcag2aa/wcag21a/wcag21aa`, zero-violation assertions, on 2026-09-09. *As built 2026-11-25 (AECI-1876):* 56 of the 106 e2e specs run axe themselves on every PR. The accessibility nightly also scans the end state of every e2e test (`TESTING_STRATEGY.md` §8.2) |
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

### Operating notes (moved from CLAUDE.md, 2026-09-23)

- This file holds the dated **results** of runs of `docs/a11y-manual-testing-checklist.md`. The AECI-244 public-site pass of 2026-09-09, against prod `44aba9cf`, is the first run.
- Standing warning for every run: axe structurally cannot see the WCAG 4.1.3 status-message class. The defect only exists after a form submit. Since AECI-829 and AECI-1876 axe does scan states after a submit, but no axe rule checks that a change is announced. The nightly announcement checks (`TESTING_STRATEGY.md` §8.4.4, AECI-1880) record that in the DOM. Only a screen reader shows whether it is spoken.

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

**Fixed 2026-10-23 (AECI-829).** A1 and A2 now move focus to the swapped-in heading. The "Check your email" and "Review received" `<h1>` carry `tabindex="-1"` and are focused in `afterNextRender` after the signal flips. A1 also returns focus to the email field after "Use a different email", which destroyed its own button in the same way. A3 now has one persistent `sr-only` `role="status"` region under the `<h1>`. It reads "Loading your account…", then "Your account has loaded."; the failure branches keep their own `role="alert"`. Regression assertions: `apps/web/e2e/auth-login.spec.ts` submits against a stubbed Supabase config and asserts `toBeFocused()` on the heading. `apps/web/e2e/reviews-submission.spec.ts` asserts the same on its existing submit test. Both tests also run axe on the swapped-in state. `/account` needs a real session, so its region is covered by `account.component.spec.ts`. Not yet fixed, same class: the "Your reviews" list load on `/account`, and the "Display name updated." notice, which is a `role="status"` created together with its text.

**What to do.** For a whole-view swap, moving focus is better than announcing, because it fixes the lost reading position too: give the success heading `tabindex="-1"` and focus it after the swap. A persistent `role="status"` region is the alternative, and is the right choice for A3's loading transition.

**Regression test each fix must add.** The two specs are in different starting positions, so the work differs. `apps/web/e2e/auth-login.spec.ts` never submits at all — every one of its four tests measures the default render, so A1's fix has to add a submit step first. `apps/web/e2e/reviews-submission.spec.ts` **does** submit: its "a filled form submits and shows the moderation confirmation" test stubs `POST /api/reviews`, fills the form and clicks submit, then asserts only that the confirmation copy is *visible*. A2's fix therefore extends an existing test rather than adding one. In both cases the new assertion is the same: `document.activeElement` is the success heading, or a pre-existing `role="status"` received the text. Note that the axe scan in each file is a **separate** test on the default render, so neither suite would catch this class even where a submit already happens. The assertion style already exists in `apps/web/e2e/nav-menu.spec.ts`, which asserts Escape-closes-and-returns-focus.

### 3.2 Serious — link and landmark ambiguity

| # | Surface | Finding | SC |
|---|---|---|---|
| **A4** | Home | ~~Three links with the **identical** accessible name `"Source (opens in a new tab)"` point to three **different** external destinations (`originality.ai`, `vendr.com`, `capterra.com`). No `aria-label`, no `title`. In a rotor or `NVDA+F7` links list — a primary screen-reader navigation mode — they are indistinguishable.~~ **FIXED by the home redesign (#1145), pinned 2026-11-09 (AECI-830).** Each link now carries an `sr-only` suffix inside the anchor. The names read "Source for the 19% AI-generated figure, Originality.AI (opens in a new tab)" and its two siblings. They begin with the visible "Source", so 2.5.3 Label in Name holds. | 2.4.4 (A) in context, 2.4.9 (AAA) outright |
| **A5** | Home | ~~Two `role="search"` landmarks (header and hero), **neither named**, each containing a `role="combobox"` whose accessible name is also identical. A landmarks list shows two entries reading "search".~~ **FIXED 2026-11-09 (AECI-830).** `aec-search-autocomplete` names its own form through a `searchName` input. The header box is "Site search" and the hero box is "Search the directory". The pair finder already took its name from its heading, "Do these two connect?". The claim dialog finder is "Find your listing". | 1.3.1 (A) / 2.4.1 (A) |

**Why axe does not catch either.** `landmark-unique` and `identical-links-same-purpose` are tagged `best-practice`, and the e2e suite filters to `wcag2a/wcag2aa/wcag21a/wcag21aa`. The rules are excluded by configuration, not missing.

**What was done.** A4 was fixed by an `sr-only` suffix rather than an `aria-label`, so the icon's new-tab note still reads. A5 was fixed with bound `aria-label`s on the search forms. `apps/web/e2e/home.spec.ts` now asserts both at 1440px: the three source links have distinct names, and every search landmark has a distinct, non-empty name. Those explicit checks stand in for the two best-practice axe rules, which the WCAG-tag runs still exclude. A one-off axe run with only `landmark-unique` and `identical-links-same-purpose` reported 0 violations at 375 and 1440 on local `/`.

**The same shape is still open elsewhere.** A4 itself is fixed (above). The same shape exists in two more places found while doing that work and **not** yet ticketed: `admin/vendors/vendor-products-table.html` renders one "View page" per product row, and `products-pair.ts` renders one "View listing" and one "Documentation" per mechanism card. Each set points at N different destinations under one name. The fix is the same in both: an `aria-label` built with `$localize` at the call site, naming the destination and restating the new tab — restating it because an `aria-label` replaces the anchor's contents and so suppresses the icon's note. `aec-view-public-link` already takes that name as an input and documents the requirement.

### 3.3 Minor

| # | Surface | Finding |
|---|---|---|
| **A6** | Login, review, account | ~~Submit buttons use the `disabled` attribute rather than `aria-disabled`, so they leave the tab order entirely. A screen-reader user tabbing the form never encounters the button and receives no programmatic explanation of what is blocking submission. On the review form no field carries `required` or `aria-required` either, so required-ness is conveyed only by the *absence* of "(optional)" in the visible label. Affects `Email me a sign-in link`, `Submit review`, and `Save`.~~ **FIXED 2026-11-09 (AECI-831).** The fix follows `DESIGN.md` "Submit stays enabled" (AECI-1296), not `aria-disabled`. All three buttons are disabled only while the request is in flight; sign-in is also disabled until hydration. Pressing one with a bad answer shows every error and focuses the first bad field. The review form's two ratings, headline and body carry `aria-required="true"`. Guarded by the login, review-form and account component specs and by the review form's empty-submit check in `request-and-review-forms.spec.ts`. |
| **A7** | Product detail | ~~Both integration `<table>` elements have **no accessible name** — no `<caption>`, no `aria-label` — and identical column headers (`Direction`, `Integrates with`, `Connection`, `Details`). Navigating by table gives two indistinguishable tables. The `<h3>`s directly above them ("Direct integrations", "Via Kroo Connector") make this a one-line `aria-labelledby` fix.~~ **Already fixed by AECI-713** (2026-09), which made each lane its own `aec-product-integrations-table` named by its `<h3>`. AECI-831 added the regression test in `products-detail.spec.ts`. |
| **A8** | Product detail | ~~The "On this page" section nav exposes `aria-current` on **none** of its four links. The nav itself is correctly named. (2.4.8 Location is AAA, so this is an enhancement, not a conformance failure.)~~ **FIXED 2026-11-09 (AECI-831).** `SectionNav` marks the first link current until a click or the scroll-spy names another, so exactly one link always carries `aria-current="location"`. Guarded by `section-nav.component.spec.ts` and the e2e `section-nav.spec.ts` "aria-current follows the scroll". |
| **A9** | Product detail | ~~"Visit website" opens a new tab (`target="_blank"`) with no warning to the user. Home's source links **do** carry an "(opens in a new tab)" hint, so this is an inconsistency within the product rather than a missing capability.~~ **FIXED 2026-09-16 (AECI-980).** The inconsistency ran both ways and was wider than this row recorded: seven new-tab links announced the tab to a screen reader and showed a sighted reader nothing, and eight drew a `↗` text character rather than the one drawn glyph. `aec-new-tab-icon` now carries both halves at every new-tab link in `apps/web`, and `DESIGN.md` → "The Link Treatment Rule" pins it. |
| **A10** | `/admin/reviews` | ~~`aria-current="page"` is set on both the `<a>` and its parent `<li>`, so the state may be announced twice.~~ **Already fixed by the admin nav redesign**: the `<li>` carries nothing, the category trigger carries `aria-current="true"` and only the screen's link carries `"page"`. AECI-831 added the guard to `admin-shell.component.spec.ts` and `authed-console.spec.ts`. |
| **A11** | Product detail, "Integrations it powers" | ~~Each hub row is one link whose `aria-label` replaced its content, so a screen reader never heard the row's direction or mechanism. The row also ended in a decorative `→` beside a real direction `→`. At 375px the hub card header truncated the hub name to zero width.~~ **FIXED 2026-09-24 (AECI-1117).** Found in a local critique, not by this audit, and no axe rule fails on it. The row name now restates direction, mechanism and object count ("View the Procore and Fieldwire integration, direction Inbound"). The trailing mark is the chevron. The card header wraps on its own width, so the name keeps its space. Measured on local `/products/fx-agave`: the hub name box went from 0px wide to its full 66px ("Procore") at 375px. axe (WCAG 2.0/2.1/2.2 A and AA) reports 0 violations at 375 and 1280, before and after. `STAGE_1_5_SPEC.md` §12.3 carries the rule. |

### 3.4 Needs a human with a real screen reader

These are the items the machine pass proved the *shape* of but cannot adjudicate. The checklist §6 and §7 scripts are built from this list.

| # | Question only VoiceOver/NVDA can answer |
|---|---|
| **H1** | `<main id="main">` had **no `tabindex="-1"`** when this audit ran; AECI-1839 added it. The same fix repaired a defect this audit missed: the skip link's bare `href="#main"` resolved to `/#main` under `<base href="/">` and loaded the home page on every route but `/`. Keyboard behaviour is **correct and verified**: activating the skip link moves the sequential start point, and the next `Tab` lands on `input#hero-search` inside `#main`. What is unverified is whether the AT *virtual cursor* follows. The `tabindex="-1"` insurance is in place, added by AECI-1839. |
| **H2** | `home-feedback-form.ts:52-56` and `account.html:91-94` place a `role="status"` region **inside** an `@if`, so it is inserted into the DOM already populated. NVDA generally does not announce a polite region on insertion. Does the message actually speak? |
| **H3** | Many labels are ALL CAPS (`YOUR EMAIL`, `HEADLINE`, `OVERALL RATING`, `VENDOR`, `CATEGORIES`). Some screen readers spell short all-caps tokens letter by letter. Do these read as words? |
| **H4** | The search autocomplete announces no result count when its listbox opens; the user gets `aria-activedescendant` on the first option only. Measured: 10 options appeared with no count message. Is arrowing through sufficient in practice? |

### 3.5 Found outside this audit: vendor portal

The vendor portal is outside this audit's scope (AECI-633 owns that pass). Findings from other lanes' axe runs are recorded here so a later pass can tell a regression from a first sighting.

| # | Surface | Finding | SC |
|---|---|---|---|
| **V1** | Vendor portal "product not found" state (`vendor-products-page.ts`) | ~~The "See your products" link sat inside a sentence and was told apart by colour alone. axe reported one **serious** `link-in-text-block`.~~ **FIXED 2026-09-24 (AECI-1102, PR #835).** The link is now underlined. A follow-up polish added its hover and focus styles and gave the state an `h2`, so a heading jump reaches it. `preview-vendor-portal-nav.spec.ts` guards the state. A sweep of every `<a>` under `apps/web/src/app/vendor/` found no other in-text link without an underline. | 1.4.1 (A) |

**Watch for this class anywhere.** A bare `<a>` inside running text always fails `link-in-text-block`. The base `a` rule in `styles.css` sets colour only, and Tailwind's preflight removes the underline.

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

- **Combobox missing `aria-controls`.** Present only in the collapsed state, which is correct per ARIA 1.2. *(2026-10-13: true of a query with hits. A zero-hit query was a real defect, fixed by AECI-1308, §5.)* On typing, `aria-expanded` flips to `true`, `aria-controls` resolves to a real `role="listbox"` with 10 `role="option"` children, and `aria-activedescendant` is set. Escape collapses it and keeps focus on the input.
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
| Home `/` | ✅ | ✅ clean | ✅ | ✅ A4, A5 fixed (AECI-830) | n/a |
| Product detail `/products/microsoft-fabric` | ✅ | ✅ clean | ⚠️ A8 | ⚠️ A7, A9 | n/a |
| Login `/auth/login` | ✅ | not walked | ✅ | ✅ | ✅ A1 fixed (AECI-829) |
| Review submission `/products/:slug/review` | ✅ | ⚠️ partial (§6) | ⚠️ single `h1`, no `h2` | ✅ | ✅ A2 fixed (AECI-829) |
| Account `/account` | ✅ | not walked | ✅ | ✅ | ✅ A3 fixed (AECI-829) |
| Admin queue `/admin/reviews` | ✅ | not walked | ✅ | ✅ | ✅ reference-good |
| Admin overview `/admin/overview` | ✅ (bonus) | not walked | ✅ | ✅ | ✅ reference-good |
| Onboarding `/welcome` (local, 2026-10-13, AECI-1296 working tree) | ✅ | DOM order only (harness dropped keys) | ✅ | ✅ | ✅ one persistent `role=status` |
| Help center and vendor guide `/docs/**` (local, 2026-10-13, AECI-1308) | ✅ all 30 URLs | not walked | ✅ | ✅ | ✅ docs search live region |

**2026-10-13 `/welcome` run (local 8790 pair, AECI-1296).** Two passes on the same day. The first, on
the initial build, found: field borders at 1.25:1 (1.4.11, serious); Save natively `disabled` with no
reason (3.3.1); "Loading…" and the vendor-branch field removal silent (4.1.3); the audience count and
cap unannounced; "Prefer not to say" rendered as pre-selected (3.3.2). The second pass, after the
fixes, found every one resolved and zero axe violations in five states (default, popup open, vendor
chosen, errors showing, 10-of-10 cap). Measured: resting border `#8A8A93` at 3.42:1 on white and
3.28:1 on the raised card; error border `--status-error` at 6.54:1. Not covered: real keyboard and
focus ring (the hidden tab drops keys), VoiceOver/NVDA, a true 390px viewport (an iframe stood in).
Minor, unfiled: the "Clear answer" row is exposed as a `role=option`.

**2026-10-13 docs close-out run (local 8790 pair, `main` at `0416c17a`, AECI-1308).** axe with the
`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `wcag22aa` tags, Chromium, at 1280px and 390px. Every docs
template was covered: the `/docs` home, the four help-center section indexes, the vendor guide landing page
(`/docs/vendors`), and all 24 article pages. That is 30 URLs at each width, and every one scanned clean.
Also scanned clean: the open "Docs menu" panel at 390px, and the docs search box with hits and with
none, in both guides and at both widths.

One defect was found, and it was critical. A search combobox with no rows kept `aria-expanded="true"`
with no `aria-controls`, which axe reports as `aria-required-attr`. It hit two places:

| Where | When | Reach |
|---|---|---|
| Header search (`search-autocomplete.ts`) | Any zero-hit query | Every page with the inline header box, not only `/docs` |
| Docs search (`docs-search.ts`) | While the first query is in flight | `/docs/**` only; a settled zero-hit query already collapsed |

Both now collapse whenever they have no row, and re-expand when hits land. Re-scanned clean after the fix,
including zero-hit and in-flight states on `/docs`, `/docs/vendors/overview` and `/products`. ADR 0010
point 2 had called the gated-empty state axe-clean, and is corrected. The e2e gate missed it because
`docs.spec.ts` scans the default render and never types. Not covered: a real keyboard walk, VoiceOver
or NVDA, and the compact header search at 1024px to 1279px (it mounts the same component).

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
8. **WCAG 2.2 is not in the automated gate.** The e2e axe suites run the `wcag2a` / `wcag2aa` / `wcag21a` / `wcag21aa` tags. `target-size` (SC 2.5.8) is tagged `wcag22aa`, so it never ran there. AECI-1079 found it failing on the integration-row partner link (a 20px-tall target) and fixed it on 2026-09-24. One rule-scoped case now guards that section at 1280px and 375px (`phase2-a11y.spec.ts`). A local axe run with `wcag22aa` on product detail, the pair page, `/integrations`, `/products` and a vendor page found no other violation on that date. The rest of the site is not gated on 2.2. Since AECI-1883 the accessibility nightly reports `target-size` on every manifest surface, without failing the run (`TESTING_STRATEGY.md` §8.4.8). Its first run, on 2026-11-24, reported nothing. The nightly e2e axe sweep (AECI-1876) also reports every `wcag22aa` rule on the end state of every e2e test, and IBM Equal Access (AECI-1884) reports WCAG 2.2 A and AA findings on every manifest surface. Both are report only (`TESTING_STRATEGY.md` §8.3), so the rest of the site is still not gated on 2.2.

---

## 7. Follow-ups

| Item | Severity | Filed as |
|---|---|---|
| A1 / A2 / A3 — status messages on view swap | **Serious (WCAG 4.1.3 AA)** | [AECI-829](https://linear.app/aec-integrations/issue/AECI-829), fixed 2026-10-23 |
| A4 — three identical "Source" links · A5 — two unnamed search landmarks | Serious | [AECI-830](https://linear.app/aec-integrations/issue/AECI-830), fixed 2026-11-09 |
| A6–A10 — minor set | Minor | [AECI-831](https://linear.app/aec-integrations/issue/AECI-831), closed 2026-11-09 |
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

---

## 9. Home citation reflow follow-up (AECI-1846, 2026-11-15)

**Scope:** `/`, measured in Chromium against this issue's local `pnpm dev:agent` stack. These
measurements supplement the dated production audit above; they are not a new production or
screen-reader speech audit.

The final market figure's absolutely positioned, 16rem citation extended past the right viewport
edge in the three-column row. Its `opacity: 0` state still enlarged the page's scrollable width.
The fix right-aligns that final citation to its Source link from `sm` (640px), keeping all
citations left-aligned in the stacked layout, and caps their width at `calc(100vw - 3rem)`.
The complete citation wraps without page-level clipping. Hover, focus, source destinations,
unique accessible link names and `aria-describedby` associations are retained.

| Viewport width (CSS px) | Page scroll width before | Page scroll width after, hidden / hover / focus |
|---|---|---|
| 320 | 320 | 320 / 320 / 320 |
| 639 | 639 | 639 / 639 / 639 |
| 640 | 699 | 640 / 640 / 640 |
| 768 | 781 | 768 / 768 / 768 |
| 1024 | 1024 | 1024 / 1024 / 1024 |

**Regression coverage:** five cases in `apps/web/e2e/home.spec.ts` check exact page/viewport
width equality before revealing a citation, then all three citations on hover and real Tab
navigation. The open tooltip's bounds must fit the viewport, its text must fit without clipping,
and its text must remain the link's accessible description. Reduced motion keeps keyboard
geometry measurements independent of the page's smooth-scroll animation. The 639px case guards
the stacked side of the `sm` breakpoint. The tests failed on the original layout at 640 and 768px
and pass with the fix.

Width equality and the tooltip's right boundary use `document.documentElement.clientWidth`,
the usable viewport excluding a classic scrollbar gutter. `window.innerWidth` is checked
separately against the requested browser width. Comparing scroll width to `innerWidth` falsely
failed all five cases in Linux CI, where the vertical scrollbar reserves 15px; the local macOS
overlay scrollbar reserves none. The same failures were reproduced locally with classic
scrollbars enabled before correcting the measurements. All five cases then passed with both
overlay and classic scrollbars, and restoring the old tooltip alignment still exposed horizontal
overflow at 640 and 768px in both modes.

**Other validation:** the home axe AA case reports zero violations; all 11 HomeWhy component
tests, the web build, web typecheck and repository lint/format checks pass. The rendered
impeccable scan at 768px reports no P0 finding; its existing prose-length and eyebrow warnings
and one straggler advisory are outside this placement fix. The full home suite passes 28 of
29 cases; the unchanged AECI-1823 pair-finder case fails while choosing live search suggestions,
but passes when run alone. It also fails in a full-suite run with one worker. That existing
search-selection timing issue is outside this CSS change; no pair-finder code or assertions
were changed.

---

## 10. Ban form and ban-term panel (AECI-1607, 2026-11-20)

**Scope:** `/admin/users/:id` (the ban form on a vendor's last unbanned seat) and
`/admin/vendors/:id?tab=billing` (the ban-term panel, with a banned subscription whose term end is
unknown). Run against local `pnpm dev:agent` with a real admin session, using `@axe-core/playwright`
(WCAG 2.0 to 2.2 A and AA tags) and a scripted keyboard pass in Chromium. This is not a
screen-reader speech audit.

| State | axe critical or serious | axe other |
| --- | --- | --- |
| User page, ban form closed | 0 | 0 |
| User page, after the last-seat refusal | 0 | 0 |
| Billing tab, ban-term panel closed | 0 | 0 |
| Billing tab, ban-term panel open | 0 | 0 |

**Keyboard.** Every control is reachable with Tab and works with Enter. The last-seat refusal is
announced (`role="alert"`). The "Term end unknown: enter the date the vendor had paid through" row
keeps "Grant complimentary subscriptions for the ban term" disabled until a date is entered. The
"Enter a date after today (UTC)." error is tied to its input with `aria-describedby` and
`aria-invalid`, but it has no live region.

**Finding (AECI-1989).** Focus falls to `<body>` after four actions: opening the ban form,
submitting it, opening the ban-term panel, and cancelling the panel. The next Tab restarts at
"Skip to main content". WCAG 2.2 SC 2.4.3, Focus Order.

**Fixed in code (AECI-1989, 2026-11-20; not yet re-run with Playwright).** Each step now moves
focus on purpose: into the form on open, back to the trigger on cancel or a grant, and to the
message on a refusal. The ban-term date error is now a `role="alert"` live region. The grant
control beside the panel had the same gaps and got the same fix. Component specs assert
`document.activeElement` after each step. The rules are in `ADMIN_PANEL_SPEC.md` §5.7 and §5.8.

**Same gap, five more controls (AECI-1994, 2026-11-22; found by reading the code, not yet re-run
with Playwright).** Five inline controls on the vendor page dropped focus to `<body>` when the API
refused a submit: the subscription row actions, the bulk subscription actions, the grant
Withdraw, "Add a seat" and "Return records to AECi". Each refusal message now takes focus
(`tabindex="-1"`). "Add a seat" now focuses the email field on open and returns focus to its
button on Cancel. "Return records to AECi" returns focus to its button on
Cancel. Component specs assert `document.activeElement`. The rules are in `ADMIN_PANEL_SPEC.md`
§5.7. A successful action can still lose focus when the page reloads or the control
disappears. AECI-2001 tracks that.

---

## 11. Redesign accessibility gate (AECI-1818, 2026-11-18)

**Scope:** every public surface the November 2026 redesign rebuilt (AECI-1720), as merged on
`redesign/on-hold-2026-11-16` at **`42f192752`**. Measured in Chromium against this issue's local
`pnpm dev:agent` stack on a freshly seeded local D1. Every write and every external host was
intercepted with `page.route`, so no form, sign-in or email reached a real service.
**Procedure:** the dev-time axe recipe (`apps/web`, `@playwright/test`, `browser.newContext()`),
plus real `Tab` walks with Playwright's keyboard. Playwright drives a visible, focused page, so the
hidden-tab trap of checklist §5 does not apply to this run. **Not a screen-reader run:** see §11.6.

### 11.1 Verdict

**The gate passes on this branch, with two WCAG defects fixed in it.** axe found no error and no
`serious` violation on any surface, at any width, in any state. The tags were `wcag2a`, `wcag2aa`,
`wcag21a`, `wcag21aa`, `wcag22aa` and `best-practice`.

The two defects axe cannot see were found by the keyboard pass and are fixed here:

| # | Surface | Finding | SC | Status |
|---|---|---|---|---|
| **R1** | Every page on a first visit, worst at 768px and below | The fixed consent banner hid the focused control. A `Tab` scrolled each control only to the viewport's bottom edge, which is under the banner. Measured fully hidden stops: 27 at 320px, 14 at 390px, 4 at 768px, 1 at 1440px (`/products/revit`). | 2.4.11 (AA, 2.2) | **Fixed.** While it shows, the banner publishes its height on `<html>`. An unlayered `scroll-margin-bottom` rule in `styles.css` keeps every focusable element above it. After the fix: 0 hidden and 0 partly hidden stops at every width. The rule skips anything inside a modal (the open mobile menu, and the CDK overlay container's dialogs, drawer and popovers). Those paint above the banner, measured at 844 by 390, 390 by 844 and 320 by 640, so the banner cannot hide their focus. A first version applied inside the menu too. Its last control then asked for more scroll than the panel had, and the browser scrolled the locked page behind the menu by about 120px. CI caught it in `nav-menu.spec.ts` "landscape phone". |
| **R2** | `/search` | The results tab panel is a Tab stop (`tabindex="0"`) and carried `focus-visible:outline-none`. Focus landed on it with nothing drawn. | 2.4.7 (AA, 2.0) | **Fixed.** The panel takes the standard 3px Forest ring at a 4px offset. |
| **R3** | `/search` | The page's own `role="search"` form had no name. A landmarks list showed "Site search" and an unnamed "search". The A5 class. | 1.3.1 (A), best-practice | **Fixed.** `aria-labelledby` points at the existing "Search the directory" label. No new words. |

Regression guards: `e2e/accessibility.spec.ts` "redesign accessibility gate (AECI-1818)" tabs
45 stops at 320px with the banner up. With the fix switched off it failed and listed 16 hidden
controls. A second case opens the menu at 844 by 390 with the banner up. It tabs 60 stops and asserts none is painted under the banner and the page behind stays at 0. A third asserts the panel ring and the two distinct landmark names. The component specs
`consent-banner.component.spec.ts` and `search-page.component.spec.ts` pin the attribute, the
custom property, the label link and the ring classes.

### 11.2 Coverage, per surface

Each row was scanned at 1440, 768, 390 and 320px. "Keys" is a real `Tab` walk at all four
widths: cycle closed, no trap, no focus on a hidden element, a ring on every stop, and nothing
fully hidden by the sticky header, the section bar or the banner. "Structure" is one `h1`, no
skipped level, named landmarks and no image without alt text.

| Surface | axe | Keys | Structure | Reflow 320 | States checked |
|---|---|---|---|---|---|
| Home `/` | ✅ | ✅ | ✅ | ✅ | default |
| `/products` | ✅ | ✅ | ✅ | ✅ | default, filter on (count line announced), sort popup |
| `/categories`, `/audiences`, `/phases`, `/trades` | ✅ | ✅ | ✅ | ✅ | default |
| Term `/categories/bim-authoring` | ✅ | ✅ | ✅ | ✅ | default |
| `/search` | ✅ | ✅ after R2 | ✅ after R3 | ✅ | default, zero results ("0 results" announced once) |
| Product, many (`fixture-long-list`) | ✅ | ✅ | ✅ | ✅ | default, by-category and one-list views |
| Product, few (`revit`) / none (`autocad`) | ✅ | ✅ | ✅ | ✅ | default |
| Product, connector (`fx-agave`) | ✅ | ✅ | ✅ | ✅ | default |
| Product, hybrid | not tested | not tested | not tested | not tested | no hybrid product is seeded locally |
| Vendor `/vendors/autodesk` | ✅ | ✅ | ✅ | ✅ | default |
| Pair `/products/revit/integrations/procore` | ✅ | ✅ | ✅ | ✅ | default |
| 404 | ✅ | ✅ | ✅ | ✅ | default |
| `/about`, `/methodology`, `/updates`, `/roadmap`, `/contact` | ✅ | ✅ | ✅ (P5) | ✅ | default |
| `/vendor-program` | ✅ | ✅ | ✅ | ✅ | claim dialog open |
| `/vendor-program/list-your-product` | ✅ | ✅ | ✅ | ✅ | errors, country popup, step 2, sent |
| `/docs`, an article, vendor guide, plans, ranking | ✅ | ✅ | ✅ | ✅ | default |
| `/legal/terms` | ✅ | ✅ | ✅ | ✅ | default |
| `/auth/login` | ✅ | ✅ | ✅ | ✅ | error, "Check your email" (focus on the heading) |
| Claim dialog | ✅ | ✅ trap, Escape, focus back | ✅ | ✅ | open; finder results **not tested** (no rows came back locally) |
| Routed claim and correction pages | ✅ (P1) | ✅ | ✅ | ✅ | errors (focus to first field), sent (focus on the heading) |
| Correction drawer | ✅ | ✅ trap, Escape, focus back | ✅ | ✅ | open, errors |
| Review form | ✅ (P1) | ✅ stars by arrow keys | ✅ | ✅ | errors, received (focus on the heading) |
| Unsubscribe, mute, claim confirm | ✅ | ✅ | ✅ | ✅ | done state (focus on the heading) |
| Header, Browse menu (1024px and up) | ✅ | ✅ Escape returns focus | ✅ | n/a | open |
| Mobile menu (below 1024px) | ✅ | ✅ trap, Escape returns focus | ✅ | ✅ | open, all four sections expanded |
| Footer | ✅ | ✅ | ✅ | ✅ | default |
| Consent banner | ✅ | ✅ after R1 | ✅ | ✅ | first visit |
| `/account`, `/welcome` | not tested | not tested | not tested | not tested | need a session, and no preview route renders them |

Also measured: 200% zoom, using a 640px CSS viewport at device scale 2 as the stand-in for 1280px
at 200%. Ten pages reflowed with no sideways scroll and no axe finding. Reduced motion:
`scroll-behavior` resolves to `auto`, an in-page section link jumps at once, no transition or
animation runs over 200ms, and the Browse menu opens with no animation. The skip link keeps the
URL path, focuses `<main>`, and the next `Tab` lands inside it. Sign-in needs no cognitive test:
the email field has `autocomplete="email"` and allows paste (3.3.8).

### 11.3 Contrast, measured

Ratios are WCAG 2, computed in the page after a canvas resolves each token to sRGB. Buttons and
chips were real `aecButton` and `.aec-chip` elements rendered with the shipped classes.

| Pair | Ratio | Need |
|---|---|---|
| Bone on Forest / on the footer ground / on the hero panel | 11.03 / 13.71 / 9.18 | 4.5 |
| `--text-on-brand-secondary` on Forest / hero panel / footer | 7.96 / 6.62 / 9.89 | 4.5 |
| `--text-on-footer-secondary` on the footer ground | 8.76 | 4.5 |
| Clay bar on Forest | 5.29 | 3 |
| Clay bar on white | **2.33** | 3, met by a second cue (below) |
| Bone ring on Forest / Forest hover / hero panel / footer | 11.03 / 6.87 / 9.18 / 13.71 | 3 |
| Forest ring on white / raised / sunken / Bone | 12.34 / 11.82 / 11.23 / 11.03 | 3 |
| Field edge on white / raised / sunken / Bone / Forest / footer | 3.71 / 3.55 / 3.37 / 3.31 / 3.33 / 4.14 | 3 |
| Field edge on the hero panel | **2.77** | 3, never used there: controls on it take a fill (DESIGN.md §2) |
| `--border-on-brand-strong` on Forest / hero panel / footer | 4.01 / 3.58 / 4.49 | 3 |
| Tertiary text on white / raised | 4.83 / 4.63 | 4.5 |
| Tertiary text on sunken / Bone | **4.40 / 4.32** | 4.5, never used there (axe found no live instance) |
| Placeholder, every live field measured (14 pages) | 4.83 to 5.92 | 4.5 |

| `aecButton` variant (its grounds) | Text rest / hover | Ring | Disabled text |
|---|---|---|---|
| primary (white, raised, sunken, Bone) | 12.34 / 7.68 | 11.03 to 12.34 | 3.68 to 3.80, exempt |
| secondary | 18.97 / 11.23 | 11.03 to 12.34 | 5.12 to 5.28 |
| ghost | 17.70 to 19.80 / 11.03 to 12.34 | 11.03 to 12.34 | 5.06 to 5.25 |
| danger (white, raised) | 6.54 / 9.11 | 11.82 to 12.34 | 3.04 to 3.06, exempt |
| on-brand (Forest, hero panel, footer) | 11.03 / 9.46 | 9.18 to 13.71 | 5.01 to 5.18 |
| on-brand-secondary | 6.90 to 10.17 / 5.88 to 8.53 | 9.18 to 13.71 | 3.75 to 4.90 |

Every chip tone (neutral, quiet, sunken, strong, strong-sunken, forest, wash, error, selected)
measured 6.54:1 or more at rest and on hover on white, raised and Bone, with the ring at
11.03:1 or more. Every active state carries a cue besides colour. The section nav and the guide
tabs change weight. The jump rail fills Forest. The docs "On this page" dash grows from 12px to
20px. The Browse trigger's Clay bar comes with weight 600.

### 11.4 Open findings (moderate and minor)

None of these is an axe error or `serious` violation. Each needs the owner's decision, words or
a build.

| # | Surface | Finding | Why it matters | What to do |
|---|---|---|---|---|
| **P1** | Review form, routed claim and correction pages | axe `landmark-complementary-is-top-level` (moderate, best-practice): the context rail `<aside data-testid="context-rail">` sits inside `<main>`. Files: `reviews/review-form.html:67`, `requests/request-form.html:30`, `welcome/welcome.ts:111`. | Some screen readers list a nested aside as a second top-level landmark. | Make the rail a named `<section>` (a region), or accept the rule as an exemption. A semantic choice for the owner. |
| **P2** | `/categories`, `/audiences`, `/phases` | Term descriptions are cut to three lines (`line-clamp-3`). At default spacing 32 of 35 on `/categories` are already cut. The 1.4.12 text-spacing override cuts more (1 to 4 on `/phases`). | 1.4.12 asks that spacing changes lose no content. The full text is one link away, on the term page. | Decide whether the term page counts as the full text. If not, drop the clamp under the spacing override or show the full description. Filed as AECI-2108 on 2026-11-24, when the nightly magnification check found it (`TESTING_STRATEGY.md` §8.4.6). Ruled by Chris on 2026-11-26: the term page counts as the full text, so the clamp stays and is on the nightly's `CLIP_ALLOW_LIST`. |
| **P3** | Home at 320px | With the text-spacing override the page is 322px wide, 2px of sideways scroll. No visible box crosses the edge, so the source is not found. | 1.4.10 and 1.4.12 at the 400% zoom width. | Find the 2px source in a follow-up. |
| **P4** | `/vendor-program` claim dialog | "Ask us to add it" is a 20px-tall text button. It passes 2.5.8 by the spacing exception, and it is inline in a sentence. | The 44px house rule covers buttons. This one is a link-style button. | Owner's call: give it a 44px hit area as the review rail's guide link has, or leave it. |
| **P5** | `/methodology` | The agreement-state table has no caption or name. It comes from rendered Markdown. | A table list in a screen reader shows it unnamed (the A7 class). | Name it from its heading in the Markdown pipeline, or add a caption. The caption needs the owner's words. |
| **P6** | Routed claim page | "Send claim" stays natively `disabled` until the Vendor Terms box is ticked (`request-form-body.html:382`, VENDOR_SIGNUP_PROCESS.md §4). It is out of the Tab order until then, and nothing says why. | The A6 class. DESIGN.md "Submit stays enabled" is the house pattern. This one is a documented exception. | Keep, or follow the house pattern. Owner's decision. |
| **P7** | `/products`, product pages, docs | Some link names repeat with different targets: "Procore" (product and vendor), "About" (section link and footer), "For vendors" (header and docs guide). Each pair sits in a different card or landmark. | 2.4.4 passes in context. A links list shows the pair without that context. | No change needed. Recorded so a re-run does not count it as new. |
| **P8** | Consent banner | The banner is the last thing in the Tab order: about 70 stops on a product page. | Not a WCAG failure. A keyboard user meets the choice last. | Owner's call. |

### 11.5 Live regions (DOM shape, not speech)

Filter changes update the pagination line, a polite region present from load ("Showing 1 of 1").
`/search` says "0 results" once through its `role="status"`. The mailing-list signup keeps focus
on the field and updates one persistent `role="status"`. Every form error pass moves focus to the
first bad field and ties each message to its field through `aria-describedby`. Each message is a
`role="alert"` inserted with its text, up to six at once on list-your-product. Whether that burst
reads as one announcement or six is a question for §11.6.

### 11.6 Not covered, and what a human must still do

1. **No screen reader ran.** No VoiceOver or NVDA speech was observed. The tooling here drives
   Chrome's accessibility tree, not speech.
2. **NVDA, in the Parallels Windows VM, Firefox then Chrome:** checklist §7 N1 to N10, plus three
   new checks. (a) The mobile menu: open it, expand a section, and confirm the dialog, the
   section's expanded state and the return to "Menu" are spoken. (b) Submit list-your-product
   empty, and count how many of the six alerts are spoken with the first field's name. (c) Tick a
   `/products` filter, and confirm "Showing N of N" is spoken once.
3. **VoiceOver, Safari:** checklist §6 V1 to V15, and the same three checks.
4. **Safari and Firefox keyboard passes.** This run was Chromium only.
5. **`/account` and `/welcome`** need a session. Their component specs cover the status regions
   (§3.1), but no rendered pass ran on the redesigned pages.
6. **A hybrid product page and the claim finder's results list** could not be reached locally.

**The `/accessibility` statement (hidden until AECI-1687).** Nothing found here makes a sentence
in it false. R2 was a 2.1 AA failure, and it is fixed on this branch. R1 is WCAG 2.2 only, which
the statement's 2.1 aim does not cover. One sentence is at risk for this release: "Before major
releases we also work through a manual keyboard and screen-reader checklist." The redesign is a
major release, and its screen-reader half (items 2 and 3 above) has not been run. Publish only
after it has.

Evidence: `.context/for-chris/a11y/` in the workspace holds the screenshots, the focus captures
and the raw per-surface JSON.

## 12. Field error states (AECI-1984, 2026-11-22)

**Scope:** the shared field-error recipe (`FIELD_ERROR_CLASS`, `CHOICE_CARD_CLASS`, `CHOICE_INPUT_CLASS`) after it gained the `--status-error` icon, the red choice-card edge and the red outline on a bare checkbox. Tags: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`. Run against local `pnpm dev:agent`, Chrome via Playwright.

| Surface, error state showing | axe violations | Notes |
|---|---|---|
| `/auth/login`, invalid email (live page) | 0 | Icon shows. The input border stays grey because the login input is not on `.aec-field-control` yet. AECI-1850 owns that. |
| Recipe harness: text field, choice card, bare checkbox, valid card | 0 | Rendered on the compiled stylesheet. The computed card border, checkbox outline and icon colour are all `--status-error`. A focused bare checkbox shows the Forest ring, not the red outline. |

**Not reached live:** `/auth/terms`, `/welcome` and the review form need a session, and sign-in does not complete on an agent port. The claim dialog needs a product search to reach its fields. The class wiring on those surfaces is covered by component specs (`terms-accept.component.spec.ts`) and the class-assertion spec (`form-field-classes.spec.ts`).

**Contrast:** `--status-error` is 6.54:1 on white. That is above the 3:1 needed for a non-text boundary or icon (WCAG 1.4.11). The error text stays `--text-primary` on `main`. On the redesign branch (sync 15) the message keeps the redesign recipe (clash 23): 14px at weight 600 in `--status-error`, 6.54:1 on white.
