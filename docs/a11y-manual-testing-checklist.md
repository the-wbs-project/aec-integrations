# Accessibility Manual-Testing Checklist (VoiceOver / NVDA / keyboard)

**Spec:** `STAGE_1_SPEC.md` §21.3 · **Issue:** [AECI-244](https://linear.app/aec-integrations/issue/AECI-244) (Phase 7.10) · **Complements:** the automated axe-core + Lighthouse a11y ≥95 CI gates (AECI-65) — this is the **human layer** those cannot cover.

> **Purpose.** A repeatable procedure for the manual screen-reader + keyboard pass §21.3 requires, so it can be re-run before each launch/major release rather than reinvented. **This is the procedure and a blank log — it records no results itself.** Fill a dated copy of §4 each time you run it; file blocking findings as issues or fix in place.
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

---

_Automated coverage (already in CI, not a substitute for the above): axe-core in e2e + Lighthouse a11y ≥95 on the public pages (AECI-65); console-health harness (AECI-162)._
