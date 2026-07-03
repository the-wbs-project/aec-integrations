# ADR 0012: BrowserStack for cross-browser / real-device testing (Phase 7)

**Status:** **Accepted** (2026-06-25; proposed 2026-06-09)

**Context owner:** Chris Walton

Tracks **AECI-154**. **Ratified and shipped** in Phase 7.8 (AECI-154): the CI fan-out landed as the
non-blocking BrowserStack lane (`apps/web/browserstack.yml`, `apps/web/playwright.browserstack.config.ts`,
`.github/workflows/browserstack.yml`). See "Decision" for the posture and "Follow-ups" for what shipped.
Adds to the testing approach in `docs/TESTING_STRATEGY.md` §7/§9; supersedes nothing.

---

## Context

E2E today is **chromium-only** (`apps/web/playwright.config.ts` — a single `chromium` project), with
cross-browser/mobile explicitly **deferred to Phase 7** (the config comment cites `TESTING_STRATEGY.md`
§7 and AECI-33). The existing stack — Playwright E2E + `@axe-core/playwright` + Chromatic (visual) +
Lighthouse CI — runs per-PR against Cloudflare Workers previews.

`TESTING_STRATEGY.md` §7.1 names Playwright's bundled multi-browser support (Chromium/Firefox/WebKit) as
the cross-browser plan, and §9 names **Chromatic** for visual regression. Neither mentions BrowserStack.
Two gaps that local Playwright cannot close structurally:

1. **Real iOS Safari.** Playwright's bundled WebKit *approximates* Safari — it automates a WebKit build,
   not the real engine, so Safari/iOS-specific rendering, memory-pressure, and backgrounding bugs don't
   reproduce. BrowserStack runs Playwright on **real iOS devices with Safari**.
2. **Real device matrix breadth** (real Android Chrome, desktop Safari, older OS versions) for the launch
   cross-browser pass.

Chris has a personal BrowserStack subscription. The question is where it fits without disrupting the fast,
free PR-blocking lane.

## Decision

**Accepted posture: adopt BrowserStack as the cross-browser / real-device approach (shipped in Phase
7.8), as a separate non-blocking lane — not a replacement for any existing layer.**

1. **MCP server now (done).** The BrowserStack MCP server (`@browserstack/mcp-server`) is wired + verified,
   for ad-hoc real-device checks during UI work (pairs with the `/impeccable` + Mobbin design loop and the
   "both themes / real device" design checklist). Personal/user scope — credentials never enter the repo.

2. **CI fan-out deferred to Phase 7 (AECI-154).** Wire the existing Playwright suite to **BrowserStack
   Automate** via `browserstack-node-sdk` + `browserstack.yml`, running a **curated cross-browser smoke
   subset** (critical journeys only — parallel-session quota forbids the whole suite × N devices). Matrix:
   real iOS Safari, real Android Chrome, desktop Safari, Firefox, Edge.

3. **Keep BrowserStack off the fast lane.** Unit / component / integration / chromium-E2E / axe stay fast
   and free on every PR. The BrowserStack lane is a dedicated GitHub Actions job that **does not gate
   merge** (the cloud grid adds a network hop + consumes session quota).

4. **Reuse CF Access service-token headers** to reach Access-gated staging/preview
   (`CF-Access-Client-Id` / `CF-Access-Client-Secret` as Playwright request headers); `BrowserStackLocal`
   tunnel is the fallback for purely-local runs. `demo.aecintegrations.com` is public and needs neither.

5. **Don't run Percy *and* Chromatic.** BrowserStack's Percy overlaps Chromatic (already specced, §9).
   Keep **Chromatic** unless cross-*real*-browser visual diffs are specifically wanted, in which case Percy
   consolidates billing under BrowserStack. A deliberate either/or, not both.

6. **axe-core stays the per-PR a11y gate.** BrowserStack's accessibility scans are a real-device
   *complement* for a pre-launch audit, not a per-PR replacement.

## Consequences

**Positive**

- Closes the **real iOS Safari + real Android** gap local Playwright/WebKit can't — the single biggest
  cross-browser blind spot for a directory used by professionals on mixed devices.
- Reuses the *existing* Playwright tests (SDK fan-out) — no parallel test framework.
- Fast PR lane is untouched: same gates, same wall-time, still free.
- MCP path gives immediate ad-hoc value during UI work before any CI investment.

**Negative / trade-offs**

- Another vendor + paid quota; parallel-session limits force a *curated* subset, not full coverage (must be
  surfaced, not silent — `TESTING_STRATEGY.md` §14-style discipline).
- Real-device runs are slower than local Playwright (cloud network hop) — hence non-blocking, separate lane.
- CF-Access wiring is required for non-prod targets (service-token headers).
- Overlaps Chromatic (Percy) — needs a deliberate either/or to avoid double-paying.

**Follow-ups**

- **Phase 7.8 (AECI-154) — SHIPPED:** `browserstack-node-sdk` + `apps/web/browserstack.yml` +
  `apps/web/playwright.browserstack.config.ts` (curated read-only smoke subset:
  `smoke`/`home`/`products-detail`/`search`/`facets`) + the non-blocking
  `.github/workflows/browserstack.yml` job (post-merge `workflow_run` after `deploy` + dispatch + weekly,
  against deployed staging); CF-Access headers via Playwright `extraHTTPHeaders`, no tunnel; Percy **not**
  adopted (Chromatic stays the visual tool — `TESTING_STRATEGY.md` §9.5).
- **Inert until provisioned:** the lane **skips green** until `gh secret set BROWSERSTACK_USERNAME` /
  `BROWSERSTACK_ACCESS_KEY` (personal subscription) — `CF_ACCESS_*` already exist as repo secrets. Confirm
  the subscription includes the **Automate** product (real iOS Safari Playwright is Automate-only) and a
  parallel-session quota ≥ the 5-platform matrix; reconcile the `deviceName`/`osVersion` strings against
  BrowserStack's live device list at provisioning.
- **Pre-launch:** one-off full real-device sweep + BrowserStack accessibility audit as a launch gate.
- **Ratified:** this ADR flipped **Proposed → Accepted** (2026-06-25) and `TESTING_STRATEGY.md` §7.7/§9.5
  were promoted from "planned" to the documented approach.
