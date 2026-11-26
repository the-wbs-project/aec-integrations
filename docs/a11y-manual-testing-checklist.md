# Accessibility Manual-Testing Checklist (VoiceOver / NVDA / keyboard)

**Spec:** `STAGE_1_SPEC.md` §21.3 · **Issue:** [AECI-244](https://linear.app/aec-integrations/issue/AECI-244) (Phase 7.10) · **Complements:** the automated axe-core + Lighthouse a11y ≥95 CI gates (AECI-65) — this is the **human layer** those cannot cover.

> **Purpose.** A repeatable procedure for the manual screen-reader + keyboard pass §21.3 requires, so it can be re-run before each launch/major release rather than reinvented. **This is the procedure and a blank log — it records no results itself.** Fill a dated copy of §4 each time you run it; file blocking findings as issues or fix in place. **Results live in `docs/ACCESSIBILITY_AUDIT.md`** — the 2026-09-09 AECI-244 run is the first entry, and §5 below is the tool-assisted pre-pass it introduced. **The accessibility statement (`/accessibility`, AECI-1673) promises this pass before major releases.** It stays hidden until the first real VoiceOver and NVDA run here (AECI-1687). Changing the cadence is a legal-impact change (`docs/LEGAL_IMPACT_REVIEW.md` §3).
>
> **Target:** WCAG 2.1 AA. **Tools:** VoiceOver (macOS Safari), NVDA (Windows Firefox/Chrome), and keyboard-only (no pointer) in each browser.

---

## 1. Scope — surfaces to test (AECI-244)

`apps/web/e2e-a11y/surfaces.ts` mirrors this list for the accessibility nightly (AECI-1875). Change both together.

1. **Home** (`/`)
2. **Product detail** (`/products/:slug`)
3. **Review submission** (`/products/:slug/review`) — the full flow
4. **Login** (`/auth/login`)
5. **Account** (`/account`)
6. **Admin moderation queue** (`/admin/reviews`, and `/admin/requests`)
7. **Vendor portal** (`/vendor/:vendorSlug/products` and
   `/vendor/:vendorSlug/products/:productSlug/integrations`) — added
   after Stage 2; the list above predates it. One thing here is only evaluable by
   a human: the portal's **one polite live region** in the shell (a background poll
   lands announcements into it from sections the reader is not looking at,
   `STAGE_2_REALTIME_SPEC.md` §6.3). Products is a plain link in the portal nav
   (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.11), so the old Products dropdown step is
   removed (AECI-2062). Needs a session; on a deployed
   environment, check the WAF note in `docs/waf-rate-limits.md` first. The ungated
   `/preview/vendor-dashboard` renders the same shell if a session is not available.

## 2. Per-surface checks

Run each surface with **(a) keyboard only**, then **(b) VoiceOver**, then **(c) NVDA**.

**Keyboard-only (every surface):**
- [ ] A visible focus indicator is present on every interactive element; focus order matches reading order.
- [ ] No keyboard trap; `Tab`/`Shift+Tab` reach and leave every control; `Esc` closes overlays/menus and returns focus to the trigger.
- [ ] "Skip to content" works **on a non-home page** (`/products/{slug}`, a `/docs` article): Enter keeps the URL path and moves focus into `main`, with no page load (AECI-1839); landmarks (`header`/`nav`/`main`/`footer`) are reachable.
- [ ] All actions (links, buttons, filters, form submit, menu) are operable without a pointer.

> **Automated nightly in Chrome (AECI-1877, `TESTING_STRATEGY.md` §8.4.1).** On every surface in §1, the
> accessibility nightly now checks: no keyboard trap, and Tab reaches the footer and closes the cycle;
> the tab order against a reviewed snapshot; that Tab reaches every element a script predicts, and no
> hidden one; the skip link puts focus in `main` with no page load; no Tab stop navigates or opens a popup;
> every dialog, menu and dropdown opens by keyboard, closes on `Esc` and returns focus to its trigger,
> a modal dialog traps `Tab` and `Shift+Tab`, and any other popup closes or keeps focus inside it on `Tab`; and focus is not left on the page body after a client navigation. It does not judge
> whether the order matches reading order. The manual pass above keeps its full scope and cadence.
>
> **The same keyboard, focus indicator and announcement checks in Firefox and WebKit (AECI-1885,
> `TESTING_STRATEGY.md` §8.4.10).** They also run nightly in Playwright's own Firefox and WebKit builds.
> Those are not Firefox and Safari as people use them. The WebKit walk presses Option+Tab, so it never
> tests Safari's default, where Tab skips links. Real Safari is still needed for that, for everything
> VoiceOver speaks, and for the focus ring as macOS draws it. Real Firefox with NVDA is still needed for
> what NVDA speaks. The manual pass above keeps its full scope and cadence, in each browser.
>
> **Focus indicator, automated nightly in Chrome (AECI-1878, `TESTING_STRATEGY.md` §8.4.5).** On every
> Tab stop of every surface in §1, the nightly checks that focus changes what is drawn, that the
> indicator reaches 3:1 against the ground it is drawn on, and that no other element sits at the stop's
> centre. It also checks that text fields, selects, comboboxes, checkboxes and radios show an edge at
> 3:1. It counts pixels, so it cannot judge whether a ring is easy to notice. The manual pass above keeps
> its full scope and cadence.
>
> **Interaction, automated nightly in Chrome (AECI-1882, `TESTING_STRATEGY.md` §8.4.7).** On every
> surface in §1, the nightly checks that content shown on hover stays when the pointer moves onto it and
> closes on `Esc` without moving focus; that a press dragged off a control and released does nothing; that
> changing a form control does not move the page unless it is on a list of controls, every entry
> pending Chris's ruling; that the keys a to z do nothing on the page body and send nothing; that
> nothing moves for more than 5 seconds, or for more than 100ms with reduced motion; and axe and the
> focus ring with forced colours on. It also checks that the claim, checkout, account delete and
> moderation flows stop on a confirm step, except Approve (AECI-2121, pending ruling). Chrome's forced
> colours is not a real Windows theme, so the manual pass above keeps its full scope and cadence.

**Screen reader (VoiceOver + NVDA, every surface):**
- [ ] Page has a correct, unique title and a single logical `h1`; heading levels don't skip.
- [ ] Images have meaningful `alt` (or are correctly empty/decorative); icon-only buttons have accessible names.
- [ ] Links/buttons announce a clear purpose out of context (no bare "click here"/"read more").
- [ ] Dynamic updates (toasts, live counts, async results) are announced via an appropriate live region.
- [ ] Reading order via the rotor/element list is sensible; no orphaned or duplicated announcements.

> **Automated nightly in Chrome (AECI-1879, `TESTING_STRATEGY.md` §8.4.3).** On every surface in §1, the
> accessibility nightly now checks: the roles, names, states and headings of `main` against a reviewed
> snapshot; one `h1` and no skipped heading level; the four landmarks, and a unique name on every
> navigation and search landmark; that no two links share a name but go to different places; and the
> before and after state, flipped by keyboard, of each disclosure button, tab, combobox, toggle button and
> `<summary>`. It leaves out links with `aria-expanded` (activating one navigates) and buttons that open a
> dialog. The keyboard walkthroughs (`TESTING_STRATEGY.md` §8.4.1) open and close both. Across pages it checks a unique
> title, the same header and footer, a consistent name for each link target, and search, navigation and
> footer links on every page. It reads the accessibility tree, not a screen reader, so it cannot judge
> whether a name is clear, whether reading order makes sense, or what is announced. The manual pass above
> keeps its full scope and cadence.

> **Automated nightly in Chrome (AECI-1880, `TESTING_STRATEGY.md` §8.4.4).** For the announcements this
> section and "Surface-specific" below name, the nightly now records the page while it acts: the login
> sent and error states, review submission, the account save, a failed account delete, the subscribe
> forms, the waitlist welcome, claim confirm, search counts, the vendor portal's one channel and a write
> in one section while another is open, the moderation outcome, and the admin queues' empty, loading
> and error states. Each must be heard exactly once at the promised politeness. Form errors
> must be tied to their field with focus on the first. It reads the DOM, not speech, so it cannot tell
> whether VoiceOver or NVDA spoke the message. The manual pass above keeps its full scope and cadence.

> **Voice control and switch, automated nightly in Chrome (AECI-1883, `TESTING_STRATEGY.md` §8.4.8).**
> On every surface in §1, the nightly checks that each control's accessible name contains its visible
> label, that no two controls share a name while doing different things, and that text fields for the
> user's name, email, organisation and the like carry their `autocomplete` token. It reports small
> targets, and counts the Tab presses from load to each page's main task. It reads names, not speech,
> so it cannot tell whether Dragon or Voice Control understands a spoken command. This pass has no
> voice-control or switch step, and the note adds none. The manual pass above keeps its full scope and
> cadence.

**Surface-specific:**
- [ ] **Home** — trust band, stats, search entry, and section headings announce; the waitlist welcome banner (if `?ref=waitlist`) is announced and dismissible by keyboard.
- [ ] **Product detail** — rating/review summary, tabs/sections, and external links announce state + destination.
- [ ] **Review submission** — every field has a programmatic label; the discrete-choice controls (Aria combobox/listbox standing in for role/select) announce role + value + expanded state; validation errors are associated to their field (`aria-describedby`) and announced on submit; success/error is announced.
- [ ] **Login** — magic-link / Google buttons have accessible names; error + "check your email" states are announced.
- [ ] **Account** — the delete-account confirmation is a proper dialog (focus moved in, `Esc`/close returns focus, action announced).
- [ ] **Admin queue** — filter toggles expose pressed state (`aria-pressed`); the moderation/ban dialog traps focus correctly and announces outcome; empty/loading/error states announce.
- [ ] **Vendor portal** — the section row announces as a navigation landmark and the current section as current; Products is a plain link in that row (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.11), and the old Products dropdown step is removed (AECI-2062). Then, with a section open, confirm a write elsewhere is announced **once** (never twice, never as an interruption) and that nothing under the pointer moves when a background refresh lands.

## 3. Recording findings

For each issue: surface, tool (VO/NVDA/keyboard), WCAG SC, severity (blocking / serious / minor), and repro steps. **Blocking + serious issues must be fixed or ticketed before launch;** minor issues may be tracked as follow-ups.

## 4. Run log (copy per run)

```
Run date: ____________   Tester: ____________   Build/SHA: ____________
Browsers: Safari+VoiceOver ☐   Firefox+NVDA ☐   Chrome+NVDA ☐

Surface              | Keyboard | VoiceOver | NVDA | Blocking findings
---------------------|----------|-----------|------|-------------------
Home                 |   ☐      |    ☐      |  ☐   |
Product detail       |   ☐      |    ☐      |  ☐   |
Review submission    |   ☐      |    ☐      |  ☐   |
Login                |   ☐      |    ☐      |  ☐   |
Account              |   ☐      |    ☐      |  ☐   |
Admin queue          |   ☐      |    ☐      |  ☐   |

Overall result: PASS ☐   PASS-with-follow-ups ☐   FAIL ☐
Findings filed: ____________________________________________
```

## 5. Tool-assisted pre-pass (Chrome accessibility tree)

Added after the AECI-244 run of 2026-09-09 (`docs/ACCESSIBILITY_AUDIT.md`). This is a **pre-pass, not a
substitute**: it clears the machine-checkable half cheaply so the human sitting in §6/§7 is spent on the
half only a screen reader can judge.

**What it establishes.** Chrome MCP's `read_page` returns the browser's own accessibility tree — roles
and accessible names, the data a screen reader consumes — and `computer` dispatches real key events.
Together they measure: sequential focus order and cycle closure, keyboard traps, focusable-but-hidden
elements, accessible-name presence and uniqueness, `aria-labelledby`/`aria-describedby` IDREF
resolution, heading and landmark structure, skip-link wiring, ARIA state attributes, live-region
presence and shape, and computed focus-indicator styles.

**What it cannot establish, ever.** How VoiceOver and NVDA *speak* that tree — verbosity, ordering,
double-speaking, rotor behaviour, browse-mode versus forms-mode. A `MutationObserver` sees DOM, not
speech. It also drives **Chrome only**, so neither browser §2 mandates is covered.

**Method.** Hypothesis, then evidence, then the diff: a JS pass computes the *candidate* tabbable set,
the real `Tab` walk is the evidence, and the difference between them is the finding. Never substitute
`el.focus()` for a `Tab` press — `focus()` does not consult the sequential focus navigation algorithm,
so a JS-only "focus order" is testing a reimplementation of `tabindex`/`inert` semantics, not the
browser.

**Three harness traps that make a broken run look like a clean pass:**

1. **The MCP tab runs hidden.** `document.visibilityState` is `"hidden"` and `document.hasFocus()` is
   `false`, and in that state the browser drops `Tab` presses entirely. Call `window.focus()` from
   `javascript_tool` first. **Skip this and every surface reports zero findings because nothing was
   measured.**
2. **Add a `computer` screenshot to the same batch.** It is a second, independent activator; without
   one, key events intermittently stop landing even when `hasFocus` is `true`. If screenshot injection
   times out on a page, that surface's keyboard walk cannot be completed — record it as a gap rather
   than as a pass.
3. **`read_page` with `filter: "interactive"` returns only viewport-visible nodes.** It is a spot check,
   not a full tree dump.

**Run-validity gate.** Capture console messages per surface. A hydration error (NG0500 / NG0602) means
the DOM was replaced mid-probe, so the run is **void** and must be re-taken. Exclude extension-injected
DOM from results — a password manager's live region is not ours.

**On production, the pass is read-only.** No form submission, no moderation action, no confirm control
ever clicked. That is a real constraint, not a formality: it means success-state behaviour must be
verified from source at the deployed SHA, and the dialogs cannot be exercised at all. **Run the dialog
and submit-path checks locally instead** (`pnpm dev:agent`, plus
`pnpm --filter @aeci/api db:seed-reviews -- --apply` so the moderation queue and review lists are
non-empty).

## 6. Scripted VoiceOver walkthrough (macOS, Safari)

About 10 minutes. `VO` = `Control+Option`. Toggle VoiceOver with `Cmd+F5`. Each step states the
**expected** announcement, so you are comparing against a stated expectation rather than judging
freehand. Mark each ✅ / ❌ and note what was actually spoken when it differs.

Derived from the `needs-human` list in `docs/ACCESSIBILITY_AUDIT.md` §3.4 — these are exactly the
questions the machine pass could not answer.

| # | Surface | Keys | Expected announcement | ✅/❌ |
|---|---|---|---|---|
| V1 | `/products/{slug}` (not `/`: the old link only worked there) | `Tab` once from page top | "Skip to main content, link" — and the link becomes **visible** | ☐ |
| V2 | `/products/{slug}` | `Return` on it, then `VO+Right` | The URL path does not change and the page does not reload. The cursor moves **into the main content**, not the header. *(H1: `<main>` has had `tabindex="-1"` since AECI-1839, so this confirms the virtual cursor follows.)* | ☐ |
| V3 | `/` | `VO+U`, choose **Landmarks** | Distinct entries: "Site search" (at desktop widths), "Search the directory" and "Do these two connect?". *(A5, fixed by AECI-830.)* | ☐ |
| V4 | `/` | `VO+U`, choose **Links** | Three "Source" entries, each naming its figure and publisher, for example "Source for the $27K paid visibility figure, Vendr, opens in a new tab". *(A4, fixed by AECI-830.)* | ☐ |
| V5 | `/` | Focus the hero search, type `proc` | Does anything announce **how many results** arrived, or only the first option? *(H4.)* | ☐ |
| V6 | `/` | Submit the mailing-list signup | Is the "thanks" message spoken? *(H2 — the region is inserted already populated.)* | ☐ |
| V7 | `/auth/login` | Sign in once with Google, return, focus **Continue with Google** | Is "Last used" read after the button name? *(The uppercase "YOUR EMAIL" label of H3 is gone: the label now reads "Email".)* | ☐ |
| V8 | `/auth/login` | Enter an email, submit | **The critical one.** Is "Check your email" announced? Where does the cursor land? *(A1. Fixed by AECI-829: focus should land on the heading.)* | ☐ |
| V9 | `/products/microsoft-fabric` | `VO+U`, choose **Tables** | Each table is named by its heading ("Direct integrations", "Via …"). *(A7. Fixed by AECI-713, regression-tested by AECI-831.)* | ☐ |
| V10 | `/products/:slug/review` | `VO+U`, choose **Headings** | Only one heading, the product name. Is the page's purpose discoverable? | ☐ |
| V11 | `/products/:slug/review` | `Tab` through the whole form | Is the **Submit review** button reached? Pressing it on an empty form, does focus land on the first missing rating and is its error read? *(A6. Fixed by AECI-831: the button stays enabled.)* | ☐ |
| V12 | `/products/:slug/review` | Complete and submit a review *(local only)* | Is "Review received" announced? Where does the cursor land? *(A2. Fixed by AECI-829: focus should land on the heading.)* | ☐ |
| V13 | `/account` | Load the page | Is the loading-to-loaded transition announced? *(A3. Fixed by AECI-829: expect "Your account has loaded.")* | ☐ |
| V14 | `/account` | `Return` on "Delete account", then `Escape` | Does VoiceOver enter the dialog and read its title? Does `Escape` return you to the button? *(Untested by machine — do this **locally**.)* | ☐ |
| V15 | `/admin/reviews` | Moderate one review *(local only)* | Is the outcome announced **once**? This region is the reference-good pattern. | ☐ |

## 7. Scripted NVDA walkthrough (Windows, Firefox then Chrome)

About 10 minutes per browser. NVDA's browse mode is the important difference from VoiceOver: it is the
mode where quick-nav keys work, and the mode most users spend most of their time in.

| # | Surface | Keys | Expected | ✅/❌ |
|---|---|---|---|---|
| N1 | `/` | `NVDA+F7` → **Landmarks** | The same distinct search landmark names as V3. *(A5, fixed.)* | ☐ |
| N2 | `/` | `NVDA+F7` → **Links** | Three "Source" links, each naming its figure and publisher, as V4. *(A4, fixed.)* | ☐ |
| N3 | `/` | `D` repeatedly | Landmark quick-nav reaches banner, navigation, main, contentinfo in a sensible order | ☐ |
| N4 | `/` | `H` repeatedly | Headings descend without skips and describe their sections | ☐ |
| N5 | `/` | Submit the mailing-list signup | **The NVDA-specific question**: NVDA generally does **not** announce a polite live region that is inserted already populated. Is the "thanks" spoken? *(H2.)* | ☐ |
| N6 | `/auth/login` | Submit the form | Is "Check your email" spoken? *(A1.)* | ☐ |
| N7 | `/products/microsoft-fabric` | `T` repeatedly | Two unnamed tables. Then `Ctrl+Alt+Arrow` through cells — are headers announced per cell? *(A7.)* | ☐ |
| N8 | `/products/:slug/review` | `F` repeatedly, then `Tab` | Does NVDA switch cleanly between browse and forms mode on each control? Are the star ratings usable with arrows? | ☐ |
| N9 | `/products/:slug/review` | Submit *(local only)* | Is "Review received" spoken? *(A2.)* | ☐ |
| N10 | `/account` | `Return` on "Delete account", then `Escape` | Focus enters the dialog, `Tab` cycles inside it, `Escape` returns focus to the button. *(Run **locally**.)* | ☐ |
| N11 | `/products` | Open "Browse" with `↓`, `Return` on a link; then the mobile menu at 390px | NVDA speaks the new page's `h1` and the next `Tab` starts in the content, not at the top of the page. In a persistent section row (the vendor portal, admin) `Return` on a section link keeps focus on that link, now announced as current page. *(AECI-1855.)* | ☐ |

**Record every ❌ in `docs/ACCESSIBILITY_AUDIT.md` §3 with the tool, the browser and what was actually
spoken.** An announcement that differs between VoiceOver and NVDA is itself a finding worth writing
down — that divergence is the entire reason §21.3 asks for both.

---

_Automated coverage (already in CI, not a substitute for the above): axe-core in e2e + Lighthouse a11y ≥95 on the public pages (AECI-65); console-health harness (AECI-162); the accessibility nightly on `main`, Chromium only (AECI-1874, `TESTING_STRATEGY.md` §8.4)._
