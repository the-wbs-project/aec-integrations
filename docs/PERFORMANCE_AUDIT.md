# Performance / Core Web Vitals Audit (pre-launch)

**Issue:** [AECI-245](https://linear.app/aec-integrations/issue/AECI-245) — Phase 7.11, Performance / Core Web Vitals audit
**Spec anchor:** `docs/STAGE_1_PHASE_2_SPEC.md` §12 (performance budgets); `docs/STAGE_1_SPEC.md` §16 Phase 7; `docs/OBSERVABILITY.md` (RUM).
**Measured against:** commit `22357ea` — simultaneously `main` HEAD, the live **prod-demo** deploy, and the CI Lighthouse baseline at audit time. · **Date:** 2026-06-23 (UTC)
**Planes:**
- **LAB** — Lighthouse mobile via the AECI-65 LHCI harness (`.lighthouserc.cjs`: 412×823, simulated Slow-4G, 4× CPU, median-of-3). Authoritative source = the green CI `lighthouse.yml` run **28051435607** on a clean runner (`ALLOW_INDEXING=true`). A local `dev:agent` run was also taken but is **environment-contaminated** (see §7) and used only for the env-independent structural metrics.
- **FIELD** — deployed **prod-demo** (`https://demo.aecintegrations.com`, public, real traffic): deployed Lighthouse on real promoted slugs + `apps/web/scripts/run-extra-tests.sh` / `curl` edge-cache probes + **Datadog RUM** (us5, app `aeci`).

**Per the issue, fixes land as follow-ups** — this audit measures and documents; it changes no budgets and no app code.

This is the holistic deployed + real-traffic sweep that complements AECI-65's per-PR Lighthouse CI. Like the phase-completion gates, it **surfaces** items with evidence rather than silently closing them.

---

## 1. Verdict

**AECi is launch-ready on real-user performance signals, with known, tracked lab headroom.** Field Core Web Vitals from Datadog RUM are all comfortably green (p75 **LCP 0.25–0.49 s**, **CLS 0.023**, **INP 32–40 ms**), the edge cache serves HITs with **TTFB 43–75 ms** (well under the 100 ms budget), and Accessibility / Best-Practices / SEO pass in the production-indexable configuration.

The conservative **LAB** plane (Slow-4G + 4× CPU) flags genuine but **warn-level** headroom already owned by **[AECI-221](https://linear.app/aec-integrations/issue/AECI-221)**:

- **Performance score 0.79–0.89** — just under the 0.90 target on every content page.
- **LCP ~3.5–3.9 s under throttle** — misses 2.5 s on home / browse / search (product detail is faster).
- **CLS on detail / browse / search 0.145–0.326** — misses 0.1 (home + flat indexes pass). Cross-confirmed on both LAB and deployed.
- **Detail-page JS transfer ~200–227 KB** — over the 200 KB budget (227 KB measured on real deployed brotli).

None is a launch blocker: the §12 perf/CWV budgets are deliberately **warn-level** in CI pending AECI-221, and the field numbers confirm real users aren't currently affected. But all are real and tracked.

**Two measurement artifacts** are called out so scores are read correctly (both are environment noise, not AECi defects):

- Deployed **Best-Practices is depressed to 82** purely by Cloudflare's injected `/cdn-cgi/challenge-platform` script. Clean LAB BP = **100**.
- The demo/preview **SEO score (~63–69)** reflects the fail-closed `noindex` on non-production environments, not an SEO defect. The indexable production config passes SEO in CI.

The **RUM sample is thin and pre-launch-unrepresentative** (~210 views/week, internal traffic on fast devices/connections + cache HITs) — green today, but to be re-read once real traffic arrives.

### §12 budget scorecard

| Budget (Lighthouse mobile, every page type) | Verdict | Evidence |
|---|---|---|
| Performance ≥ 90 | ⚠️ **MISS** (0.79–0.89, warn → AECI-221) | CI run 28051435607 |
| Accessibility ≥ 90 | ✅ PASS (96–100) | CI green; local + deployed 96–100 |
| Best-Practices ≥ 90 | ✅ PASS in lab (100); deployed 82 = CF noise | CI green; deployed §4 |
| SEO ≥ 90 | ✅ PASS in production-indexable config | CI green; demo 66 = `noindex` artifact |
| TTFB ≤ 100 ms HIT / ≤ 600 ms MISS | ✅ PASS (HIT 43–75 ms; MISS 167–290 ms) | `curl` §5 |
| LCP ≤ 2.5 s | ⚠️ **MISS in lab** (~3.5–3.9 s, warn → AECI-221); ✅ field (0.25–0.49 s) | CI + RUM |
| CLS ≤ 0.1 | ⚠️ **MISS on detail/browse/search** (0.145–0.326, warn → AECI-221); ✅ home/index + field aggregate | CI + deployed + RUM |
| Total JS ≤ 200 KB gzipped (detail) | ⚠️ **OVER** (~227 KB brotli, warn → AECI-221) | deployed §4; CI 200.4 KB |
| INP (field-only; CWV) | ✅ PASS (32–40 ms) | RUM §6 |

---

## 2. The budget (contract)

Verbatim from `docs/STAGE_1_PHASE_2_SPEC.md:466-475` — Lighthouse **mobile**, on every page type:

- **Lighthouse mobile ≥ 90** for Performance / Accessibility / Best-Practices / SEO
- **TTFB** at the edge **≤ 100 ms on cache hit, ≤ 600 ms on cache miss**
- **LCP ≤ 2.5 s** on cache miss
- **CLS ≤ 0.1**
- **Total JS** to the browser **≤ 200 KB gzipped on a detail page**
- Image budget: vendor logos via Brandfetch CDN with `loading="lazy"` + `width`/`height`; no client-side image processing

> **Lab-vs-field note.** **INP has no Lighthouse-lab equivalent** — Lighthouse emits **TBT** as its load-time proxy; **INP is sourced from RUM field data** only. LCP and CLS are reported on both planes. TTFB-on-HIT is only observable on a deployed edge (Miniflare can't HIT), so it comes from deployed `curl`, not the lab.

---

## 3. How each metric was measured

| Metric | Plane / tool | Environment |
|---|---|---|
| LH Performance / A11y / BP / SEO | LHCI harness (primary) + deployed Lighthouse (corroboration) | CI run 28051435607 (clean) + prod-demo |
| LCP (lab) | LHCI median-of-3 | CI (clean) |
| LCP (field) | Datadog RUM `@view.largest_contentful_paint` p75 | prod-demo real traffic |
| CLS (lab + deployed) | LHCI + deployed Lighthouse | CI + prod-demo |
| CLS (field) | RUM `@view.cumulative_layout_shift` p75 | prod-demo real traffic |
| TBT (INP lab-proxy) | LHCI | CI |
| **INP (field — sole source)** | RUM `@view.interaction_to_next_paint` p75 | prod-demo real traffic |
| TTFB on HIT (≤100 ms) | `curl -w time_starttransfer` on cache-primed URLs | prod-demo |
| TTFB on MISS (≤600 ms) | `curl` on `/search` (always `private, no-store`) | prod-demo |
| Detail JS transfer (≤200 KB) | deployed Lighthouse `resource-summary:script` (real brotli) + LHCI | prod-demo + CI |
| Edge-cache HIT behavior | `apps/web/scripts/run-extra-tests.sh` T7 + `curl` headers | prod-demo |

The four §12 page types map to: **Home** `/`, **Product detail** `/products/:slug` (lab fixture `fixture-procore`; deployed real slug `egnyte`, 11 integrations — the heaviest detail page), **Search** `/search`, **Taxonomy browse** `/categories/:slug` (lab `project-management`; deployed `document-management`). Deployed slugs are real promoted entities discovered at audit time (the LHCI fixtures don't exist on prod-demo).

---

## 4. Results vs budget — per page type

Legend: ✅ pass · ⚠️ miss (warn-level, AECI-221) · **EXEMPT** by design · *italic* = unreliable, see note.
LAB = CI run 28051435607 (clean). FIELD-LH = deployed Lighthouse (prod-demo). FIELD = RUM / curl.

### 4.1 Home `/`

| Metric | Budget | LAB | FIELD | Verdict |
|---|---|---|---|---|
| Performance | ≥90 | 0.86 | *0.61 (TBT-contention)* | ⚠️ (warn) |
| Accessibility | ≥90 | PASS | 100 | ✅ |
| Best-Practices | ≥90 | 100 | 82 (CF script) | ✅ lab / noise deployed |
| SEO | ≥90 | PASS (CI) | 66 (`noindex` demo) | ✅ prod-config |
| LCP | ≤2.5 s | 3.92 s | field **0.49 s** (LH 3.56 s) | ⚠️ lab / ✅ field |
| CLS | ≤0.1 | PASS | 0.001 | ✅ |
| INP | (field) | — | **39.99 ms** | ✅ |
| TTFB HIT | ≤100 ms | — | 43–75 ms (HIT, age 177) | ✅ |

### 4.2 Product detail `/products/:slug`

| Metric | Budget | LAB (`fixture-procore`) | FIELD (`egnyte`) | Verdict |
|---|---|---|---|---|
| Performance | ≥90 | 0.79 | *0.66 (TBT-contention)* | ⚠️ (warn) |
| Accessibility | ≥90 | PASS | 100 | ✅ |
| Best-Practices | ≥90 | 100 | 82 (CF script) | ✅ lab / noise deployed |
| SEO | ≥90 | PASS (CI) | 69 (`noindex` demo) | ✅ prod-config |
| LCP | ≤2.5 s | 3.92 s | LH **1.31 s**; field 0.25–0.49 s | ⚠️ lab / ✅ deployed+field |
| CLS | ≤0.1 | **0.145** | **0.149** | ⚠️ MISS (both planes) |
| **Detail JS** | **≤200 KB** | 200.4 KB | **227 KB (brotli)** | ⚠️ **OVER** |
| INP | (field) | — | 32–40 ms (aggregate) | ✅ |
| TTFB HIT | ≤100 ms | — | 56–74 ms (HIT, age 121) | ✅ |

### 4.3 Search `/search` (non-cacheable, `private, no-store`)

| Metric | Budget | LAB | FIELD-LH | Verdict |
|---|---|---|---|---|
| Performance | ≥90 | 0.82 | *0.57 (TBT-contention)* | ⚠️ (warn) |
| Accessibility | ≥90 | 0.98 | 100 | ✅ |
| Best-Practices / SEO | ≥90 | — | — | **EXEMPT** (`noindex` by design — §4.6) |
| LCP | ≤2.5 s | 3.77 s | 3.47 s | ⚠️ lab (warn) |
| CLS | ≤0.1 | **0.144** | **0.156** | ⚠️ MISS (both planes) |
| TTFB MISS | ≤600 ms | — | 167–290 ms (always MISS) | ✅ |
| JS transfer | own 500 KiB budget | ~407 KB | 435 KB | ✅ (under its own ceiling) |

### 4.4 Taxonomy browse `/categories/:slug`

| Metric | Budget | LAB (`project-management`) | FIELD-LH (`document-management`) | Verdict |
|---|---|---|---|---|
| Performance | ≥90 | 0.85 | *0.44 (TBT-contention)* | ⚠️ (warn) |
| Accessibility | ≥90 | PASS | 96 | ✅ |
| Best-Practices | ≥90 | 100 | 82 (CF script) | ✅ lab / noise deployed |
| SEO | ≥90 | PASS (CI) | 66 (`noindex` demo) | ✅ prod-config |
| LCP | ≤2.5 s | 3.91 s | 3.64 s | ⚠️ lab (warn) |
| CLS | ≤0.1 | PASS | **0.326** (worst observed) | ⚠️ MISS (deployed) |
| INP | (field) | — | 32–40 ms (aggregate) | ✅ |
| TTFB HIT | ≤100 ms | — | 55–74 ms (HIT, age 122) | ✅ |

> Additional LAB CWV misses on the other detail pages (warn, AECI-221): vendor detail CLS 0.144, **integration detail CLS 0.305**, and LCP ~3.7–4.1 s on every page.

---

## 5. Edge-cache HIT verification (prod-demo)

`HOST=https://demo.aecintegrations.com apps/web/scripts/run-extra-tests.sh` → **PASS 10 / FAIL 3 / SKIP 0**. The edge-cache and SEO/security contract is intact:

- **T7 — edge HIT: PASS** — second request returned `cf-cache-status: HIT` (`age=61`). This is the core AC item.
- **T2a/b/c PASS** — `Vary: Accept-Language` only; `Link: </sitemap.xml>; rel=sitemap`; CSP present.
- **T3a/b PASS** — 404 short TTL (`s-maxage=60, max-age=0`). **T5a/b PASS** — locale-prefix isolation.

**Per-URL TTFB on HIT** (`curl time_starttransfer`, 3 samples, primed cache):

| URL | cf-cache-status | TTFB (incl. TLS) | Budget | Verdict |
|---|---|---|---|---|
| `/` | HIT (age 177) | 43–75 ms | ≤100 ms HIT | ✅ |
| `/products/egnyte` | HIT (age 121) | 56–74 ms | ≤100 ms HIT | ✅ |
| `/categories/document-management` | HIT (age 122) | 55–74 ms | ≤100 ms HIT | ✅ |
| `/search` | (none — `private, no-store`) | 167–290 ms | ≤600 ms MISS | ✅ |

Net of TLS handshake, HIT TTFB is ~15–47 ms. The three `run-extra-tests.sh` failures are **Cloudflare-edge artifacts, not AECi code** (see §7).

---

## 6. RUM Core Web Vitals (field)

Datadog **us5**, RUM app **`aeci`** (id `51332f3d-…`), *Optimize Vitals* (p75), real traffic. Source of the field **INP**, which Lighthouse cannot produce.

| Window | views | LCP (≤2.5 s) | CLS (≤0.1) | INP (≤200 ms) |
|---|---|---|---|---|
| Past 1 week | ~210 | **0.49 s** ✅ | **0.0235** ✅ | **39.99 ms** ✅ |
| Past 2 weeks | (larger) | **0.25 s** ✅ | **0.0231** ✅ | **32.19 ms** ✅ |

All three Core Web Vitals comfortably pass the "good" thresholds on both windows. Dashboard for trend: *AECi Phase 2 — Traffic* (`observability/datadog/dashboard.json`).

> **Thinness caveat (load-bearing).** ~210 views/week is **pre-launch internal/team traffic on fast devices and connections, largely served from edge-cache HITs** — i.e. an **optimistic** sample, not representative of the eventual mobile-heavy AEC audience. Per-page-type CWV is not statistically meaningful at this volume (aggregate only). The LAB plane (Slow-4G + 4× CPU) is the conservative bound and is where the LCP/CLS/JS headroom shows up. **Re-read RUM post-launch** once real traffic exists (follow-up below).

---

## 7. Known measurement caveats

1. **Cloudflare challenge-script depresses deployed Best-Practices.** Every deployed page injects `/cdn-cgi/challenge-platform/scripts/jsd/main.js` with a fresh per-request token (`window.__CF$cv$params`). This drops deployed BP to **82** and is the *only* byte that differs between two consecutive cached fetches — so it also explains `run-extra-tests.sh` **T1a/T4** ("non-determinism": the AECi `ng-state` payload is byte-identical; only the CF token changes). It is **Cloudflare, not AECi code** — clean LAB BP = 100. (Consistent with the AECI-222 note on deployed-Lighthouse BP noise.)
2. **`noindex` on non-production environments tanks the SEO audit.** Local `dev:agent` (`ALLOW_INDEXING=false`) and prod-demo both emit `noindex`, failing Lighthouse's "is-crawlable" SEO audit (score ~63–69). CI sets `ALLOW_INDEXING=true` and SEO passes — the production-indexable config is correct.
3. **`run-extra-tests.sh` T6** reports `max-age=14400` vs the expected `300`. Origin code emits `max-age=300` (`apps/web/src/server-runtime.ts:322`, `{edge:900,browser:300}`); the Cloudflare zone **Browser Cache TTL (4 h = 14400)** overrides the browser `max-age`. Edge `s-maxage=900` is respected. A **Cloudflare zone-config** note, not an app defect (browsers may hold the home page longer than the intended 5 min).
4. **Local deployed-Lighthouse TBT/Performance are invalid.** The deployed Lighthouse pass ran from a developer machine concurrently hosting a second workspace's dev servers; TBT measured **1.9–2.7 s** (CI clean ≤200 ms), so the deployed Performance scores (44–66) are discarded in favour of the CI lab perf (0.79–0.89) and field RUM. CLS/JS/BP/SEO/A11y/LCP are contention-robust and retained. The `simulate`-throttle Lighthouse server-response-time (126–1100 ms) is **not** the real edge TTFB — the §5 `curl` numbers are authoritative.
5. **INP is field-only**; TBT is the lab proxy (≤200 ms, passing in CI).

---

## 8. Follow-ups

Per the issue, fixes land as follow-ups. **Documented here, not filed** — the team files any new ticket.

| # | Item | Disposition |
|---|---|---|
| 1 | Performance < 0.90, LCP under throttle (~3.9 s), detail/browse/search **CLS** (0.145–0.326), detail **JS ~227 KB > 200 KB** | **Existing → [AECI-221](https://linear.app/aec-integrations/issue/AECI-221)** — owns the perf fixes (browse main-thread, bundle) and the remaining warn→error budget flip. This audit confirms its scope with deployed evidence. |
| 2 | Deployed-Lighthouse tooling + CF-challenge BP-noise handling | **Existing → [AECI-222](https://linear.app/aec-integrations/issue/AECI-222)** — owns deployed/operational verification. Any reusable deployed-sweep script routes here. |
| 3 | Partial warn→error budget flip already shipped (a11y/BP/SEO/`/search` TTFB at error) | **Existing → [AECI-188](https://linear.app/aec-integrations/issue/AECI-188)** — referenced as the enforcement baseline; no action. |
| 4 | **NEW — Post-launch RUM CWV re-read.** Pre-launch RUM (~210 views/wk, fast internal traffic) is too thin to certify field CWV (esp. INP) for the real mobile audience. Re-measure p75 LCP/INP/CLS per page type once real traffic exists, and confirm the LAB headroom (AECI-221) does/doesn't surface in the field. | **New follow-up** — the one item none of the above owns. |

---

## 9. Reproducing this audit

- **LAB (clean):** `gh run view 28051435607 --log` (CI `lighthouse.yml` on `main`, commit `22357ea`). Local re-run: `AECI_LHCI_URL=http://localhost:<port> LHCI_RUNS=3 pnpm lighthouse` after `pnpm dev:agent` — **set `ALLOW_INDEXING=true`** to avoid the `noindex` SEO artifact, and expect machine-load variance in LCP/TBT.
- **Deployed Lighthouse:** `npx -y lighthouse@12 https://demo.aecintegrations.com/<path> --form-factor=mobile --only-categories=performance,accessibility,best-practices,seo` (run on an idle machine for valid TBT).
- **Edge cache:** `HOST=https://demo.aecintegrations.com apps/web/scripts/run-extra-tests.sh`; per-URL HIT timing via `curl -sS -D- -o /dev/null -w '%{time_starttransfer}'` after priming.
- **RUM:** Datadog us5 → RUM → app `aeci` → Optimize Vitals (p75 LCP/CLS/INP).
