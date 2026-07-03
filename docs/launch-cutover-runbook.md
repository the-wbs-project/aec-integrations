# Launch (DNS) Cutover Runbook — Stage 1 Go-Live

**Owner:** Chris · **Spec:** `STAGE_1_SPEC.md` §11.2 · **Executes:** Phase 7.13 / [AECI-247](https://linear.app/aec-integrations/issue/AECI-247) · **Gate:** Phase 7.12 / [AECI-246](https://linear.app/aec-integrations/issue/AECI-246) (this must be signed off first)
**Companion docs:** `docs/environments.md` (tiers, promotion, DNS), `docs/email.md` (Resend + Supabase SMTP), `docs/waf-rate-limits.md`, `docs/PHASE_7_COMPLETION.md` (launch-readiness verdict + punts F1–F4).

> **What this is.** The one-time procedure to flip the apex (`aecintegrations.com`) + `www` off the static coming-soon **landing** Worker (`apps/landing`) onto the Angular SSR app (`aeci-web-production`), turn on indexing + search-engine pings, and send the waitlist "we're live" broadcast. It is a **forward cutover with no automatic rollback** — the app becomes the production home. Run it only after the AECI-246 launch-readiness gate is signed off.
>
> **This runbook is prepared as the 7.12 deliverable; running it is AECI-247, out of scope for the 7.12 gate.**
>
> **Relationship to AECI-277 (retire `apps/landing`).** Per the locked decision (2026-06-26), the **destructive execution** — bind the apex/`www` to `aeci-web-production`, `git rm apps/landing`, add the operator-notification email to `apps/api/src/routes/landing-forms.ts` while removing the landing Worker's own send, and add the `www`→apex 301 Redirect Rule — lands as **one combined AECI-247 + AECI-277 PR when the launch ceremony is imminent**. This document is the **prepared plan that PR executes from**; it changes no code or DNS by itself.

---

## 1. Preconditions — all must be green before you touch DNS

Do **not** start the cutover until every box below is checked. These are the AECI-246 punts (F1–F4) plus the standing deploy gates.

- [ ] **AECI-246 launch-readiness gate signed off** (`docs/PHASE_7_COMPLETION.md` §7).
- [ ] **F1 — Legal counsel review complete.** All four legal pages (`apps/web/src/content/legal/*.md`) have `effective_date` + `counsel_approved_by` + `counsel_approved_on` set and the "Draft, pending legal review" disclaimer removed (§27 change workflow). Terms / Privacy / Review Guidelines / Listing Accuracy live and correct.
- [ ] **F3 — Deployed-staging full-surface acceptance passed** (home / search / detail / auth / reviews / requests / admin, with real auth): axe AA + Lighthouse + console-clean + the review-submission / claim-correction / admin-moderation flows.
- [ ] **F4 — BrowserStack full real-device sweep + a11y audit passed** (`BROWSERSTACK_*` set; ADR 0012 launch gate).
- [ ] **Production data is present + correct** in `aeci-app-production` D1 (catalog promoted; reviews seeded/real). `demo`→`prod` promote order per `environments.md` already run.
- [ ] **Deploy gates green on the target commit** — CI `deploy.yml` / `promote-to-prod.yml` passed; the dual SSR+API version gate (`scripts/verify-version.sh`: `/api/version` **and** `/_version` == target SHA) is satisfied on `prod.aecintegrations.com`.
- [ ] **Backups / snapshot** of the current landing config noted for rollback (§5).

---

## 2. Provision the launch-only secrets (AECI-246 §F2)

These are unset pre-launch by design — the integrations fail-open/no-op until set. Set them **before** flipping DNS so the first indexed request already pings correctly. CI pushes per-env secrets on the next `promote-to-prod.yml` run (recommended/warn-and-skip; all remain graceful no-ops until set).

| Purpose | Secret(s) | Notes |
|---|---|---|
| IndexNow (7.1) | `INDEXNOW_KEY_PRODUCTION` | **Also host the key file** `<key>.txt` at the site root so IndexNow can verify ownership. |
| Google Indexing (AECI-263) | `GOOGLE_INDEXING_SA_EMAIL_PRODUCTION`, `GOOGLE_INDEXING_SA_PRIVATE_KEY_PRODUCTION` | Service-account `client_email` + PKCS#8 `private_key`. |
| Transactional email (7.5) | `RESEND_API_KEY_PRODUCTION`, `EMAIL_FROM` | Supabase → Resend custom SMTP configured (`docs/email.md`); required for the waitlist broadcast + review/account emails. |
| Product analytics (7.4) | `POSTHOG_KEY` (+ `POSTHOG_HOST`) | Client-only; CSP `connect-src` already allows PostHog (AECI-89). |
| Data-quality digest (7.6) | `DATA_QUALITY_EMAIL_FROM`, `DATA_QUALITY_EMAIL_TO` | Chris + Bill; cron already scheduled on prod. |
| WAF → Datadog (7.7) | `CF_ANALYTICS_API_TOKEN` | Zone Analytics: Read (AECI-262) — for `aeci.waf.ratelimit.blocked`. |
| Toxicity (Phase 5/6 dep) | `ANTHROPIC_API_KEY_PRODUCTION` | AECI-258; fail-open null until set. |
| Search (prod) | `ALGOLIA_APP_ID`, `ALGOLIA_ADMIN_KEY_PRODUCTION` | **Fail-closed** on prod promote — must be set. |

- [ ] All required secrets set (`gh secret set …`) and a `promote-to-prod.yml` run has pushed them to the prod Workers + passed `/api/health`.

---

## 3. Cutover procedure (ordered)

Run top to bottom. Steps 1–3 are config on the prod Worker; step 4 is the DNS flip; step 5 is the broadcast.

1. [ ] **Turn on indexing.** Set the production web Worker's `ALLOW_INDEXING="true"` (removes `x-robots-tag: noindex`, lets the SEO header set + sitemap go crawlable). Re-deploy prod web with the standard `COMMIT_SHA`/`DEPLOYED_AT` vars (CLAUDE.md version-reporting rule).
2. [ ] **Point the API at the apex.** Flip the API Worker's `PUBLIC_SITE_URL` to `https://aecintegrations.com` so promote-time IndexNow / Google pings + canonical/OG absolute URLs use the apex.
3. [ ] **Verify prod on `prod.aecintegrations.com` before moving the apex** — home, search, a detail page, `/legal/*`, `/about`, `/contact` all render; dual version gate green; `robots`/canonical now indexable.
4. [ ] **Move the apex + www onto the app.** Reassign `aecintegrations.com` **and** `www.aecintegrations.com` off the landing Worker (`apps/landing`) onto `aeci-web-production` (Cloudflare custom-domain routes / zone records per `environments.md` §"Cloudflare DNS"). Keep a **`www` → apex 301** so the canonical host is the bare apex. (The landing Worker's `LANDING_CF_HEADERS` continuity was handled in the AECI-275 server-runtime work; the app home already renders the closing-CTA capture + real OG card per AECI-277 parity.)
5. [ ] **Send the waitlist broadcast** (§4) — one-time Resend broadcast to the entire `mailing_list` with the `?ref=waitlist&token=…` link that lights the welcome banner (AECI-243).

---

## 4. Waitlist launch broadcast — drafted, ready to send (AECI-246 AC6)

> Provider is **Resend**, not Loops (the AC wording is stale — AECI-240 / `docs/email.md`). Send to the entire D1 `mailing_list`. Each recipient link carries `?ref=waitlist&token=<per-subscriber-token>` so the on-site welcome banner + `page_views` attribution fire (AECI-243, §11.2). Copy is in AECi editorial voice (`PRODUCT.md`) — trust-first, no hype. Confirm counsel is OK with the launch claims before send.

**Subject:** `AEC Integrations is live — explore the directory`

**Preview text:** `The independent directory of AEC software integrations you waited for.`

**Body (plain-text / Resend template):**

```
Hi there,

Thanks for waiting. AEC Integrations is live.

You can now search and browse the directory of software integrations across
the Architecture, Engineering, and Construction industry — dual-vendor-verified
reviews, AEC-native categories, and no pay-for-placement. Rankings are earned,
never bought.

Explore the directory:
https://aecintegrations.com/?ref=waitlist&token={{token}}

A few places to start:
- Search by the tool you already use
- Browse by category, project phase, or audience
- Read reviews that separate product quality from onboarding experience

As a founding subscriber you'll see a short welcome when you arrive. If you spot
a missing integration or an inaccuracy, there's a request/correction path on
every listing — we'd genuinely like to hear it.

— The AEC Integrations team

You're receiving this because you joined the waitlist at aecintegrations.com.
Unsubscribe: {{unsubscribe_url}}
```

- [ ] Broadcast reviewed (copy + counsel + unsubscribe/CAN-SPAM footer) and sent via Resend.

---

## 5. Post-cutover verification

- [ ] **Apex serves the app** — `https://aecintegrations.com` and `https://www.aecintegrations.com` (301→apex) return the Angular SSR home, not the coming-soon page.
- [ ] **Dual version gate** — `/api/version` and `/_version` both report the target SHA (stale-SSR guard, CLAUDE.md).
- [ ] **Indexable** — `curl -sI https://aecintegrations.com/` shows no `x-robots-tag: noindex`; `/robots.txt` + `/sitemap.xml` are present and reference the apex; canonical/OG are absolute apex URLs.
- [ ] **IndexNow fired** — a promote (or the first crawl-worthy write) records `aeci.indexnow.submit{source:promote,outcome:ok}`; the `<key>.txt` file resolves at the root.
- [ ] **Analytics + email** — a PostHog pageview lands with `locale`/`theme` dims; a test transactional email sends via Resend; the 04:00 UTC data-quality digest arrives next cycle.
- [ ] **RUM CWV** — Datadog RUM (the `aeci` app, us5) shows field LCP/CLS/INP within budget on real apex traffic (re-read after a day of real sample — `PERFORMANCE_AUDIT.md`).
- [ ] **WAF** — `aeci.waf.ratelimit.blocked` reports for the apex host; legitimate review/request submits are not throttled.
- [ ] **Welcome banner** — arriving via a `?ref=waitlist&token=…` link shows the dismissible banner and logs attribution to `page_views`.

---

## 6. Rollback

There is **no automatic rollback** — but the flip is reversible at the DNS layer within minutes if go-live goes wrong:

- **Revert the apex + www** custom-domain routes back to the landing Worker (`apps/landing`) — restores the coming-soon page (still deployed, unchanged). Do this first if the app home is broken at the apex.
- **Re-set `ALLOW_INDEXING="false"`** on prod web and re-deploy if you need to pull the app back out of the index while you fix forward (then request re-crawl once resolved).
- **Hold the broadcast** — do not send §4 until the apex is confirmed healthy (§5); an unsent broadcast is the cheapest rollback.
- Landing lead-capture (`feedback`/`mailing_list`) already writes to D1 via the API Worker (AECI-257), so subscriber capture survives either side of the flip.

---

## 7. Appendix — why the order matters

- **Indexing + `PUBLIC_SITE_URL` before the apex move** so the very first apex request is already crawlable and pings the correct host — avoids a window where the app is at the apex but still `noindex` or pinging `prod.`.
- **`demo` promote before `prod`** (already done pre-launch per `environments.md`) so `demo.aecintegrations.com` reassigns cleanly off the old production Worker without downtime.
- **Broadcast last** so no subscriber can arrive before the apex serves the app.
