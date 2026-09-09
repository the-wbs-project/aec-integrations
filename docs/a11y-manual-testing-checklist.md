# Accessibility Manual-Testing Checklist (VoiceOver / NVDA / keyboard)

**Spec:** `STAGE_1_SPEC.md` §21.3 · **Issue:** [AECI-244](https://linear.app/aec-integrations/issue/AECI-244) (Phase 7.10) · **Complements:** the automated axe-core + Lighthouse a11y ≥95 CI gates (AECI-65) — this is the **human layer** those cannot cover.

> **Purpose.** A repeatable procedure for the manual screen-reader + keyboard pass §21.3 requires, so it can be re-run before each launch/major release rather than reinvented. **This is the procedure and a blank log — it records no results itself.** Fill a dated copy of §4 each time you run it; file blocking findings as issues or fix in place. **Results live in `docs/ACCESSIBILITY_AUDIT.md`** — the 2026-09-09 AECI-244 run is the first entry, and §5 below is the tool-assisted pre-pass it introduced.
>
> **Target:** WCAG 2.1 AA. **Tools:** VoiceOver (macOS Safari), NVDA (Windows Firefox/Chrome), and keyboard-only (no pointer) in each browser.

---

## 1. Scope — surfaces to test (AECI-244)

1. **Home** (`/`)
2. **Product detail** (`/products/:slug`)
3. **Review submission** (`/products/:slug/review`) — the full flow
4. **Login** (`/auth/login`)
5. **Account** (`/account`)
6. **Admin moderation queue** (`/admin/reviews`, and `/admin/requests`)
7. **Vendor portal** (`/vendor/:vendorSlug/products` and `/integrations`) — added
   after Stage 2; the list above predates it. Two things here are only evaluable by
   a human: the portal's **one polite live region** in the shell (a background poll
   lands announcements into it from sections the reader is not looking at,
   `STAGE_2_REALTIME_SPEC.md` §6.3), and the **Products nav dropdown**, a disclosure
   whose panel contains a combobox (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.4) — a nested
   pattern no automated tool fully evaluates. Needs a session; on a deployed
   environment, check the WAF note in `docs/waf-rate-limits.md` first. The ungated
   `/preview/vendor-dashboard` renders the same shell if a session is not available.

## 2. Per-surface checks

Run each surface with **(a) keyboard only**, then **(b) VoiceOver**, then **(c) NVDA**.

**Keyboard-only (every surface):**
- [ ] A visible focus indicator is present on every interactive element; focus order matches reading order.
- [ ] No keyboard trap; `Tab`/`Shift+Tab` reach and leave every control; `Esc` closes overlays/menus and returns focus to the trigger.
- [ ] "Skip to content" works; landmarks (`header`/`nav`/`main`/`footer`) are reachable.
- [ ] All actions (links, buttons, filters, form submit, menu) are operable without a pointer.

**Screen reader (VoiceOver + NVDA, every surface):**
- [ ] Page has a correct, unique title and a single logical `h1`; heading levels don't skip.
- [ ] Images have meaningful `alt` (or are correctly empty/decorative); icon-only buttons have accessible names.
- [ ] Links/buttons announce a clear purpose out of context (no bare "click here"/"read more").
- [ ] Dynamic updates (toasts, live counts, async results) are announced via an appropriate live region.
- [ ] Reading order via the rotor/element list is sensible; no orphaned or duplicated announcements.

**Surface-specific:**
- [ ] **Home** — trust band, stats, search entry, and section headings announce; the waitlist welcome banner (if `?ref=waitlist`) is announced and dismissible by keyboard.
- [ ] **Product detail** — rating/review summary, tabs/sections, and external links announce state + destination.
- [ ] **Review submission** — every field has a programmatic label; the discrete-choice controls (Aria combobox/listbox standing in for role/select) announce role + value + expanded state; validation errors are associated to their field (`aria-describedby`) and announced on submit; success/error is announced.
- [ ] **Login** — magic-link / Google buttons have accessible names; error + "check your email" states are announced.
- [ ] **Account** — the delete-account confirmation is a proper dialog (focus moved in, `Esc`/close returns focus, action announced).
- [ ] **Admin queue** — filter toggles expose pressed state (`aria-pressed`); the moderation/ban dialog traps focus correctly and announces outcome; empty/loading/error states announce.
- [ ] **Vendor portal** — the section row announces as a navigation landmark and the current section as current; the Products item announces as a collapsed disclosure, opens onto a labelled search box that takes focus, and its filtered results announce a count that updates as you type; a zero-match query announces the plain "no products match" line and exposes **no** empty listbox; `Esc` and `Tab` both close it and return focus to the trigger; it is **not** announced as a menu. Then, with a section open, confirm a write elsewhere is announced **once** (never twice, never as an interruption) and that nothing under the pointer moves when a background refresh lands.

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
| V1 | `/` | `Tab` once from page top | "Skip to main content, link" — and the link becomes **visible** | ☐ |
| V2 | `/` | `Return` on it, then `VO+Right` | The cursor should move **into the main content**, not stay in the header. *(H1: `<main>` has no `tabindex="-1"`, so this is the open question.)* | ☐ |
| V3 | `/` | `VO+U`, choose **Landmarks** | Two "search" entries appear, indistinguishable. *(Confirms A5.)* | ☐ |
| V4 | `/` | `VO+U`, choose **Links** | Three entries reading "Source, opens in a new tab" with no way to tell them apart. *(Confirms A4.)* | ☐ |
| V5 | `/` | Focus the hero search, type `proc` | Does anything announce **how many results** arrived, or only the first option? *(H4.)* | ☐ |
| V6 | `/` | Submit the mailing-list signup | Is the "thanks" message spoken? *(H2 — the region is inserted already populated.)* | ☐ |
| V7 | `/auth/login` | `VO+A` | "YOUR EMAIL" — read as words, or spelled out letter by letter? *(H3.)* | ☐ |
| V8 | `/auth/login` | Enter an email, submit | **The critical one.** Is "Check your email" announced? Where does the cursor land? *(A1 — expected to fail.)* | ☐ |
| V9 | `/products/microsoft-fabric` | `VO+U`, choose **Tables** | Two unnamed tables with identical headers. *(Confirms A7.)* | ☐ |
| V10 | `/products/:slug/review` | `VO+U`, choose **Headings** | Only one heading, the product name. Is the page's purpose discoverable? | ☐ |
| V11 | `/products/:slug/review` | `Tab` through the whole form | Is the **Submit review** button ever reached? Is it clear what is blocking it? *(A6 — expected: never reached.)* | ☐ |
| V12 | `/products/:slug/review` | Complete and submit a review *(local only)* | Is "Review received" announced? Where does the cursor land? *(A2 — expected to fail.)* | ☐ |
| V13 | `/account` | Load the page | Is the loading-to-loaded transition announced? *(A3 — expected to fail.)* | ☐ |
| V14 | `/account` | `Return` on "Delete account", then `Escape` | Does VoiceOver enter the dialog and read its title? Does `Escape` return you to the button? *(Untested by machine — do this **locally**.)* | ☐ |
| V15 | `/admin/reviews` | Moderate one review *(local only)* | Is the outcome announced **once**? This region is the reference-good pattern. | ☐ |

## 7. Scripted NVDA walkthrough (Windows, Firefox then Chrome)

About 10 minutes per browser. NVDA's browse mode is the important difference from VoiceOver: it is the
mode where quick-nav keys work, and the mode most users spend most of their time in.

| # | Surface | Keys | Expected | ✅/❌ |
|---|---|---|---|---|
| N1 | `/` | `NVDA+F7` → **Landmarks** | Same two indistinguishable "search" landmarks. *(A5.)* | ☐ |
| N2 | `/` | `NVDA+F7` → **Links** | Three identical "Source" links. *(A4.)* | ☐ |
| N3 | `/` | `D` repeatedly | Landmark quick-nav reaches banner, navigation, main, contentinfo in a sensible order | ☐ |
| N4 | `/` | `H` repeatedly | Headings descend without skips and describe their sections | ☐ |
| N5 | `/` | Submit the mailing-list signup | **The NVDA-specific question**: NVDA generally does **not** announce a polite live region that is inserted already populated. Is the "thanks" spoken? *(H2.)* | ☐ |
| N6 | `/auth/login` | Submit the form | Is "Check your email" spoken? *(A1.)* | ☐ |
| N7 | `/products/microsoft-fabric` | `T` repeatedly | Two unnamed tables. Then `Ctrl+Alt+Arrow` through cells — are headers announced per cell? *(A7.)* | ☐ |
| N8 | `/products/:slug/review` | `F` repeatedly, then `Tab` | Does NVDA switch cleanly between browse and forms mode on each control? Are the star ratings usable with arrows? | ☐ |
| N9 | `/products/:slug/review` | Submit *(local only)* | Is "Review received" spoken? *(A2.)* | ☐ |
| N10 | `/account` | `Return` on "Delete account", then `Escape` | Focus enters the dialog, `Tab` cycles inside it, `Escape` returns focus to the button. *(Run **locally**.)* | ☐ |

**Record every ❌ in `docs/ACCESSIBILITY_AUDIT.md` §3 with the tool, the browser and what was actually
spoken.** An announcement that differs between VoiceOver and NVDA is itself a finding worth writing
down — that divergence is the entire reason §21.3 asks for both.

---

_Automated coverage (already in CI, not a substitute for the above): axe-core in e2e + Lighthouse a11y ≥95 on the public pages (AECI-65); console-health harness (AECI-162)._
