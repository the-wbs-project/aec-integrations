# Email — transactional sends + magic-link sender (Resend)

Source of truth for AECi email. Governs `STAGE_1_SPEC.md` §11.1 (which originally
said "Loops" — see the decision below). Companion to `CICD_PLAN.md` (secret matrix)
and `AUTH_AND_RLS.md` §8 (the account-deletion erasure the confirmation email pairs
with).

## Provider decision (AECI-240 / Phase 7.5)

§11.1 originally specced **Loops**. The build standardized on **Resend** instead:

- The landing app already shipped a working, tested Resend integration
  (`apps/landing/src/services/email.ts`), so Resend was already the de-facto
  transactional provider and domain-auth (SPF/DKIM/DMARC) was already set up for it.
- Mailboxes are **Microsoft 365** (`@thewbsproject.com` / `@aecintegrations.com`).
- One provider, one verified domain, one mental model beats adding a second vendor.

No Loops client was ever written. The docs (§11.1, `CLAUDE.md`, `CICD_PLAN.md`,
`API_CONTRACTS.md`) were corrected to Resend in this issue. This file is the
decision record; no separate ADR.

## Architecture

- **Transport:** `apps/api/src/lib/email.ts` — a single Resend client in the API
  Worker. Modeled on `lib/toxicity.ts` (the canonical third-party-client posture):
  - **Never throws.** Every failure mode resolves to an `EmailOutcome`
    (`'sent' | 'failed' | 'skipped'`).
  - **Fire-and-forget.** Every call site dispatches via `ctx.waitUntil` so a send
    never blocks (or fails) the action that triggered it (§11.1).
  - **Fail-open / absent-key → `'skipped'`.** No `RESEND_API_KEY` (or no
    `EMAIL_FROM`, or an unresolved recipient) is a silent skip — the expected
    local `dev:bound` / PR-preview state, mirroring `ANTHROPIC_API_KEY` /
    `LINEAR_API_KEY`.
  - `POST https://api.resend.com/emails` (Bearer auth, `from/to/subject/text/html`,
    `AbortSignal.timeout`).
- **Observability:** every attempt emits `aeci.email.send` (count) tagged
  `outcome:sent|failed|skipped` + `template:<id>`; failures also `warn` with
  `source: 'email'`. Telemetry is wrapped so it can never turn a send into a throw.
  **Every send is fail-open, so the telemetry is the only evidence a send was
  attempted at all** — a `'skipped'` outcome leaves no other trace. That backstop is
  **PostHog** (ADR 0024; the Datadog leg was removed at AECI-651). Whichever
  console you are in, the query is the same shape: the `aeci.email.send` count broken
  down by `outcome` and `template`.
- **Recipient emails** for reviewers come from `fetchAuthUserEmails()`
  (`lib/supabase-admin.ts`, the GoTrue Admin API) — D1 has no `auth.users` (ADR
  0016). The submission email uses the verified `session.email` directly; the
  account-deletion email captures `session.email` **before** the `auth.users` row
  is erased. Note this lookup needs `SUPABASE_SERVICE_ROLE_KEY`, which CI pushes to
  the API Worker on staging, demo and production (AECI-530). It still resolves to
  `null` on **PR previews and local dev**, where the key is absent by design
  (`AUTH_AND_RLS.md` §3.1).

## Template catalogue

| `template` id | Trigger / call site | Recipient | Notes |
|---|---|---|---|
| `review-submitted` | `POST /api/reviews` (`routes/reviews.ts`) | reviewer (`session.email`) | "Thanks — your review is in moderation" |
| `review-approved` | `PATCH /api/admin/reviews/:id` approve (`routes/admin-reviews.ts`) | reviewer | links to `/products/{slug}` when `PUBLIC_SITE_URL` set |
| `review-rejected` | `PATCH /api/admin/reviews/:id` reject | reviewer | includes the moderator's reason + a guidelines link |
| `account-deleted` | `DELETE /api/account` (`routes/account.ts`) | the deleted user (captured pre-erasure) | GDPR confirmation |
| `mailing-list-welcome` | `POST /api/subscribe` on a fresh insert or reactivation (`routes/landing-forms.ts`) | the new subscriber (`payload.email`) | Subscriber welcome / first touch (AECI-327). Links to `/products` when `PUBLIC_SITE_URL` set. Not sent on the still-active already-listed no-op. Sibling of the operator `landing-signup` alert. Unsubscribe (AECI-537): with a public host + the subscriber's token, the in-body link and `List-Unsubscribe` header point at the tokenized `/unsubscribe` flow and set RFC 8058 one-click (`List-Unsubscribe-Post`); without them it degrades to the `unsubscribe@<EMAIL_FROM domain>` mailto (see List-Unsubscribe section below). |
| `stuck-request-alert` | reconciliation sweep (`lib/admin-alert.ts` → `lib/reconciliation-sweep.ts`) | `ADMIN_ALERT_EMAIL` | §6.2 persistent-failure digest |
| `landing-signup` | `POST /api/subscribe` on a fresh insert (`routes/landing-forms.ts`) | `ADMIN_ALERT_EMAIL` | Operator "new mailing-list signup" (AECI-247/277 — replaces the retired `apps/landing` Worker's own send). Not sent on the idempotent already-listed no-op. **Screen equivalent since AECI-586: `/admin/audience`.** |
| `landing-feedback` | `POST /api/feedback` (`routes/landing-forms.ts`) | `ADMIN_ALERT_EMAIL` | Operator "new feedback submitted" (AECI-247/277). **Screen equivalent since AECI-586: `/admin/audience` → Feedback inbox, over `GET /api/admin/feedback`.** |
| `claim-submitted-alert` | `POST /api/requests/claim` (`routes/requests.ts`) — post-commit, `ctx.waitUntil`, **claims only** | `CLAIM_ALERT_EMAIL` (the support inbox) | Operator alert that a claim landed, so intake does not depend on someone watching Linear. Operator format (`opsText`/`opsTable`) carrying the claimed target, the submitter's email/name/role, and the two §6.8 admin signals the reviewer would otherwise look up by hand — `domain_match` and the duplicate-probe id — plus links to `/admin/claims` and the listing when `PUBLIC_SITE_URL` is set. **The claimant still gets nothing at submit time** (by design); their only mail is the decision pair below. Corrections deliberately do not alert: they share `createRequest`, but a correction is a low-stakes data fix while a claim asserts control of a listing. |
| `claim-approved` | `PATCH /api/admin/claims/:id` approve (`routes/admin-claims.ts`, AECI-528) | claimant (`submitter_email`) | Names the claimed vendor/product, lists what the account can now do, links to the `/vendor` dashboard when `PUBLIC_SITE_URL` set. Sign-in copy branches on the `invited` (just-provisioned) vs `linked` identity outcome. Verification framed as an account status, never ranking/placement. |
| `claim-rejected` | `PATCH /api/admin/claims/:id` reject | claimant (`submitter_email`) | Neutral by design (§9 AC): names the vendor, states the claim wasn't approved, invites resubmission. The reviewer's decision `reason` is an **internal audit note** (recorded in `audit_log`, admin-visible) and is **never emailed** — so nothing a reviewer types can leak to the claimant. |
| `vendor-seat-invite` | `POST /api/vendor/seats/invites` (`routes/vendor-seat-invites.ts`, AECI-664) — post-commit, `ctx.waitUntil` | the invited colleague (the address the owner typed) | **The only template a CUSTOMER triggers**, which is why that endpoint is the only one on the surface carrying a rate limit (10/vendor/24h). Names the inviter and the company (a cold "you have been granted access" from a directory the recipient may not know is indistinguishable from phishing), states the address the link is bound to (redeeming requires signing in as exactly that address, so saying it up front turns the likeliest failure into an instruction), and says the link expires. Carries the redeem link — safe in a URL because the token identifies an invite and never authorizes one (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11a). No `PUBLIC_SITE_URL` → the whole send is `skipped` rather than mailing an invite with nowhere to act on it. |
| `attestation-silent-counterparty` | daily §7 detector sweep, 10:00 UTC (`lib/attestation-notify.ts` → `lib/attestation-detectors.ts`, AECI-302) | the **silent** slot's vendor seats (unbanned `vendor_admin`, addresses via `fetchAuthUserEmails`) | The counterparty affirmed a data flow and this vendor has not answered for >14d. Copy states outright that one-sided is rendered as one-sided (`STAGE_2_SPEC.md` §8.1(4)), so the nudge informs rather than pressures. Links to the canonical pair page + `/vendor`; both omitted when `PUBLIC_SITE_URL` is unset. |
| `attestation-open-conflict` | same sweep | **both** disputing vendors' seats | Two vendors recorded opposing positions and it has stood >7d. Non-accusatory, mirroring the pair page's "Vendors disagree" treatment — the disagreement is a difference in description, not a defect in either product. Recipients are the *attesting* vendors, not every slot co-owner. |
| `attestation-stale-version` | same sweep | the attesting vendor's seats | An assertion has aged past 12 months with no version data, or still affirms a flow whose deprecated version has passed. The ask is explicitly three-way — re-confirm, add versions, or **withdraw** — because withdraw is a legitimate answer and a confirm-only ask biases the data. |
| `attestation-ops-alert` | same sweep, one email **per finding** | `ADMIN_ALERT_EMAIL` | The AECi-facing half. Two detectors route here and the body names which: `aeci-denied` (a vendor denies a claim AECi seeded — the claim then computes `unverified`, so the correction is invisible on every surface without this) and the ops escalation of `open-conflict`. Operator format (`opsText`/`opsTable`) with the claim + integration ids and the pair-page URL. §7.2 named only the three vendor ids above; the id *is* the metric tag and the catalogue key, so ops mail needs its own. |
| `entitlement-expiring` | daily term-expiry sweep, 11:00 UTC (`lib/entitlement-expiry.ts`, AECI-613) | the vendor's seats (unbanned `vendor_admin`, addresses via `fetchAuthUserEmails`) | The renewal prompt, sent once per term as `period_end` comes within `EXPIRY_WARNING_DAYS` (30). **The money is deliberately absent** — amount, payer, terms and PO reference are admin-side only (`STAGE_2_PAID_TIERS_SPEC.md` §8); this copy says what the status is, when the term ends, and asks the vendor to get in touch. States outright that **nothing changes on its own** (§7.3 — the sweep warns, it never lapses), so the email cannot read as a shut-off notice. Needs `SUPABASE_SERVICE_ROLE_KEY` for the seat addresses, so it resolves `skipped` locally and on PR previews. |
| `entitlement-expiring-admin` | same sweep, one email **per term** | `ADMIN_ALERT_EMAIL` | The operator copy, and the reason there are two ids for one event: the vendor half can degrade to `skipped`, while renewal is an offline, human, invoice-driven act somebody has to actually perform. Operator format (`opsText`/`opsTable`) carrying vendor, tier, term end, **payer and invoice ref** — this is the admin-side surface where the arrangement belongs. The last row is the vendor half's own outcome, named explicitly so "the vendor was told" is never assumed: `skipped` there is the normal local/preview state and a real misconfiguration on a deployed tier. |

**The two `landing-*` operator alerts got a screen behind them for a stronger reason
than the digests did (AECI-586).** A digest is a summary of data that stays in D1
either way, so its screen is a convenience. These two were the **only** record: the
`feedback` table had no read path anywhere in the product, so a filtered, deleted or
undelivered alert was a permanently lost submission, recoverable only by querying D1
by hand. `/admin/audience` makes the table readable and the email a notification
rather than an archive. Both sends are unchanged and still fire, fail-open, on the
same conditions (`ADMIN_PANEL_SPEC.md` §13 **D2** — push and pull are complementary).

Copy is en-US plain text + minimal HTML, built inline in `lib/email.ts` (emails are
not i18n'd at launch — the CLAUDE.md i18n rule is for rendered `apps/web` templates).

### Cron digests (the low-level `sendEmail` layer)

The table above is the **transactional** layer (`sendTransactionalEmail`, one `template`
id each, on the `aeci.email.send` metric). Two **scheduled digests** ride the separate
low-level `sendEmail` transport (`lib/email.ts`, AECI-241) instead — multi-recipient,
their own metric, no `template` tag — so they don't appear above:

| Digest | Cron (UTC) | Builder | Recipient var | Metric | Screen equivalent |
|---|---|---|---|---|---|
| Data-quality report | `0 4 * * *` | `lib/data-quality-email.ts` (`scheduled.ts` `runDataQualityJob`) | `DATA_QUALITY_EMAIL_{FROM,TO}` | `aeci.data_quality.email` | **`/admin/system` → "Run data-quality checks"** (AECI-580) |
| Operator analytics digest (AECI-526) | `0 5 * * *` (05:00 UTC = 12:00 WIB, noon Jakarta) | `lib/analytics-digest.ts` (`scheduled.ts` `runAnalyticsDigestJob`) | `ANALYTICS_DIGEST_EMAIL_TO` — **production only** (sender = shared `EMAIL_FROM`) | `aeci.analytics_digest.email` | **`/admin/overview`** (AECI-576) over `GET /api/admin/overview` (AECI-574). `?day=YYYY-MM-DD` reads any UTC day, defaulting to the digest's prior complete day; `?recompute=1` refreshes the two network-dependent status items and **sends no email** |

**Neither email is retired by its screen** (`ADMIN_PANEL_SPEC.md` §13 **D2**): push and pull are
complementary, and no cron is being removed. What the screen adds is *on demand* — the ten §23.1
checks used to be visible only in the 04:00 send, so a defect fixed at 10:00 could not be confirmed
until the next morning. `GET /api/admin/system?recompute=1` re-runs the suite live and is a **pure
read**: it writes no row and, in particular, **sends no email** (§13 **D8** draws the line at side
effects, not manual-ness). Running a digest *for real* stays deferred.

The analytics digest summarizes the **prior complete UTC day** as a styled HTML email
(with a plain-text fallback): **human** page views + top products (`page_views` where
`is_bot IS NOT 1`), a **Traffic sources** breakdown (human arrivals grouped by
`referrer_source` — LinkedIn / Twitter/X / Google / other search engines / Direct /
Other), new sign-ins (`profiles` created) + total registered users, the live
pending-moderation depth (`reviews` where `status='pending'`), and a **Crawler
activity** section listing every bot/crawler and its crawl count for the day
(`is_bot = 1`, grouped by `bot_name`) — all with day-over-day deltas. The human/bot
split is classified at ingest from the raw User-Agent + Cloudflare ASN
(`lib/bot-classification.ts`), because the CF Pro plan yields no `cf_bot_score` and
`user_id` is never captured; the traffic source is classified from the forwarded
eyeball `Referer` (`lib/referrer-classification.ts`, best-effort — Referrer-Policy
strips it, so external sources under-count) (AECI-526 follow-up). **Read the human count as an upper
bound**: the ASN half of the classifier is a hand-maintained list, and pre-classifier rows (`is_bot IS
NULL`) count as human until the one-time backfill runs — see
[`POST_LAUNCH_MONITORING.md`](./POST_LAUNCH_MONITORING.md#3b-traffic-classification--auditing-the-digests-humans-aeci-526-follow-up)
§3b for the weekly audit and the widen/backfill procedure. Report-only reads; fail-open (absent
key/recipient → `skipped`). The cron runs in **every** deploy env (staging/demo/production)
for liveness, but `ANALYTICS_DIGEST_EMAIL_TO` is set on **production only** —
staging/demo carry synthetic D1 data, so their sends intentionally `skip` (the var is
left unset).

## Secrets & vars

| Name | Kind | Where | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | Wrangler **secret** | API Worker, staging + production | CI pushes it from a **single shared, un-suffixed** `RESEND_API_KEY` GH secret — one Resend account/key spans every env (like `SUPABASE_ANON_KEY`); `deploy.yml`, `promote-to-demo.yml`, and `promote-to-prod.yml` all push the same secret. Graceful warn-and-skip; absent → sends `'skipped'`. |
| `EMAIL_FROM` | plain `var` | API Worker, per env (`wrangler.jsonc`) | Resend `from`; `Name <addr>` on the verified sending domain. **One value on every tier: `AEC Integrations <notifications@aecintegrations.com>`.** |
| `CLAIM_ALERT_EMAIL` | plain `var` | API Worker, per env (`wrangler.jsonc`) | `To:` for `claim-submitted-alert`. **`support@aecintegrations.com` on every tier.** A single address (not a parsed list). Kept separate from `ADMIN_ALERT_EMAIL` so claim intake reaches the shared support inbox while sweep alerts and lead capture keep going to the individual operator. Absent → the alert is a `skipped` no-op and the Linear issue remains the durable record. |
| `DATA_QUALITY_EMAIL_FROM` | plain `var` | API Worker, staging / demo / production (+ the temp `stage2`) | `from` for the daily data-quality digest (AECI-241). **Same address as `EMAIL_FROM`** — see the note below. |
| `PUBLIC_SITE_URL` | plain `var` | API Worker, per env | Builds absolute links in emails; absent → link omitted. |
| `ADMIN_ALERT_EMAIL` | plain `var` | API Worker, staging + production | `To:` for the stuck-request alert, the landing signup/feedback operator notifications (AECI-247/277), the §7 attestation ops alerts (AECI-302 — one per finding; absent → those findings resolve `skipped` and are retried by the next daily sweep, since no ledger row is written), **and** the `entitlement-expiring-admin` term warnings (AECI-613 — absent → the operator half resolves `skipped`, which leaves `expiry_notice_sent_at` unstamped only if the vendor half also failed, so the term is re-warned tomorrow). |

> **Every `_FROM` in the repo is `notifications@aecintegrations.com`, deliberately (2026-08-26).**
> `aecintegrations.com` is the Resend-verified sending domain (§Deliverability below), and it is
> the only domain a `_FROM` may use. Until 2026-08-26 `DATA_QUALITY_EMAIL_FROM` read
> `AECi Data Quality <support@thewbsproject.com>` on **staging, demo and stage2** while production
> already used the `aecintegrations.com` address, and two `wrangler.jsonc` comments asserted that
> `thewbsproject.com` was the verified domain — directly contradicting §Deliverability. That
> divergence is now removed: all four tiers carry the identical address for both vars.
>
> `thewbsproject.com` still appears throughout the repo, but **only as a recipient or a published
> contact** — `ADMIN_ALERT_EMAIL` / `DATA_QUALITY_EMAIL_TO` / `ANALYTICS_DIGEST_EMAIL_TO`
> (`chrisw@`), and the `founders@` / `reviews@` mailto links on the legal and contact pages, which
> are Microsoft 365 mailboxes and never Resend senders. Nothing sends **from** it.

**One-time ops step (not in CI):** provision the keys —

```bash
gh secret set RESEND_API_KEY     # single shared key from the Resend dashboard (all envs)
```

Until these exist, deploys still succeed and email simply no-ops (`'skipped'`).
Local dev: set `RESEND_API_KEY` + `EMAIL_FROM` in `apps/api/.dev.vars` to exercise
real sends (see `.dev.vars.example`).

## Magic-link sender (Supabase Auth → Resend SMTP) — ops, no app code

Supabase Auth sends magic links itself; to send them **from Resend** (rather than
Supabase's rate-limited built-in sender, which 429s `over_email_send_rate_limit`),
configure **custom SMTP** in the Supabase project's dashboard
(Authentication → Emails → SMTP). There is no app code for this.

Per [ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md) there
is now **one** shared auth project across all environments, so custom SMTP is
configured **once**, on that project (ref `ktuhnlypztujpsseujzx`):

- **Host:** `smtp.resend.com`  **Port:** `465` (TLS; `587` STARTTLS also works)
- **Username:** `resend`  **Password:** a Resend API key (`re_…`)
- **Sender:** the `EMAIL_FROM` address/name on the verified domain — use a
  **dedicated subdomain** (e.g. `mail.aecintegrations.com`) so its SPF/MX records
  don't conflict with the apex's Microsoft 365 mail.
- Keep Supabase's default rate limits sane; Resend handles delivery. (The built-in
  sender 429s `over_email_send_rate_limit` — that's why custom SMTP is required.)

### The template itself lives in `docs/email-templates/magic-link.html`

The dashboard is where it **runs**; that file is where it is **reviewed**. Edit both in the
same PR, or the repo copy becomes a lie. Paste it into Authentication → Emails → Magic Link.

What the template does beyond the GoTrue default, and why:

| Element | Why it is there |
|---|---|
| "AEC Integrations" wordmark + brand in the `h1` | An auth email that never names its sender reads as phishing, especially to this audience, who sit behind aggressive corporate mail security. |
| `{{ .Email }}` named in the body | Tells a recipient with several addresses which account the link opens, and is a quiet anti-phishing cue. |
| **A specific expiry** ("60 minutes"), not "shortly" | Vagueness makes people hesitate and then act too late, and every "my link didn't work" is avoidable support load. **This number must match Authentication → Emails → Email OTP Expiration.** `supabase/config.toml`'s `otp_expiry = 3600` mirrors it locally only. |
| Paste-able `{{ .ConfirmationURL }}` under the button | Corporate gateways rewrite or strip buttons routinely; this is the escape hatch. |
| "If you did not request this…" | Anyone can type someone else's address into the sign-in form. That person needs to know it is safe to ignore. |
| VML `roundrect` in an `[if mso]` block | Outlook for Windows does not render a padded `<a>` as a button. |
| `color-scheme: light only` | The email counterpart of the Stage 1 light-only rule (AECI-226). A client hint, not a guarantee. |
| Tables, inline styles, 600px | Email clients, not browsers. No flex, no grid, no classes. |

**Subject line:** `Sign in to AEC Integrations`. It names the brand, which is what makes the
message findable later by search.

**Known gap, deliberately not solved here.** Corporate link scanners (Mimecast, Proofpoint,
Defender) prefetch URLs to inspect them, and a magic link is single-use, so a scanner can
consume the token before the human clicks. The symptom is users reporting "invalid or expired
link" on a first click. The fix is offering the 6-digit `{{ .Token }}` as an alternative
(`otp_length = 6`), which needs an OTP entry route in `apps/web` calling `verifyOtp` — a
feature, not a template edit. Build it if that symptom appears.

**Second known gap: magic links are the only uninstrumented email in the product.** Every send
in `lib/email.ts` emits `aeci.email.send{outcome,template}`; GoTrue mail bypasses that path
entirely, so a delivery failure on the single most important email AECi sends is invisible
outside the Resend dashboard.

`supabase/config.toml` is **local-only** (magic links land in Inbucket at
`:54324` during `supabase start`); deployed SMTP lives in the dashboard.

Custom SMTP is configured at the **project** level, so it carries *every*
GoTrue-originated mail (magic link, confirm signup, recovery, invite) — not just magic
links. Today magic link is the only one AECi actually triggers.

### The vendor-claim account is provisioned WITHOUT a GoTrue email (AECI-527)

When a vendor claim is approved for a claimant who has no account, seam #4b
(`AUTH_AND_RLS.md` §3.1) creates the `auth.users` row with
`POST /auth/v1/admin/users` + `email_confirm: true` — **silently**. No GoTrue invite
email is sent. Onboarding is the `claim-approved` template above (§9 of
`STAGE_2_VENDOR_PORTAL_SPEC.md` / AECI-528) plus the ordinary magic-link login, both
of which we control and instrument.

**Call site (AECI-519 / AECI-528).** The `claim-approved` / `claim-rejected` sends
fire post-commit (`waitUntil`) from `PATCH /api/admin/claims/:id`
(`routes/admin-claims.ts`) — approve and reject respectively, to the claim's
`submitter_email`. AECI-519 shipped the send as an **injectable seam**
(`SendClaimDecisionEmail`) defaulting to a no-op; **AECI-528 injects the real
`lib/email.ts` `sendClaimDecisionEmail`** at the route registration (`index.ts`) and
widened the seam to carry the claimed target's display name (`targetName`, resolved via
`resolveRequestTargets`) + the `invited`/`linked` `identityOutcome` the approved
template branches on. Fail-open like every send: absent `RESEND_API_KEY`/`EMAIL_FROM`
→ `'skipped'`.

**Why not `POST /auth/v1/invite`:** its email links to
`/auth/v1/verify?type=invite&redirect_to=…`, which hands back the session in a URL
**fragment**, and `apps/web`'s `/auth/callback` requires a PKCE `?code=` — so the link
dead-ends. It would also emit **no** `aeci.email.send` metric (GoTrue sends it, not
`lib/email.ts`), so a failure would be invisible. Reconsidering it means clearing all
four of these first:

1. **Customize the "Invite user" template** (Authentication → Emails → Invite user).
   The Supabase default mentions neither AECi nor the vendor being claimed.
2. **Allow-list the `redirect_to`.** Supabase only honours it if it matches the
   project's Redirect-URLs list; otherwise it **silently** falls back to the Site URL
   (see `environments.md`) — so a staging invite would land the claimant on
   demo/prod.
3. **One shared project ⇒ one template and one Site URL for every environment**
   (ADR 0017). Editing the template edits production.
4. **A landing page that consumes a fragment session** (or an `/auth/callback` that
   accepts `token_hash`) — otherwise see the dead-end above.

Also note **DMARC is `p=quarantine` on a young domain** (below): for an *invite* that
is materially worse than for a receipt, because spam-filing blocks onboarding
outright and there'd be no metric to notice. Locally, GoTrue mail lands in Inbucket at
`:54324` during `supabase start`.

## Deliverability

The sending domain (`aecintegrations.com`) must have, in DNS (Resend sends via Amazon SES):

- **SPF** — on the `send.aecintegrations.com` return-path subdomain: `v=spf1 include:amazonses.com ~all` (aligns to the org domain under relaxed DMARC).
- **DKIM** — the `resend._domainkey` record Resend issues; it signs as `d=aecintegrations.com` (DMARC-aligned).
- **DMARC** — a `_dmarc` policy record. Currently `p=quarantine` with a `rua` for aggregate reports. `quarantine` means receivers **junk** on any DMARC doubt.

**Verify the domain in the Resend dashboard before provisioning prod keys**, or every send returns `403 domain not verified` (the app fail-opens, so nothing bounces to the user, but nothing arrives either — the AECI-327 welcome-email symptom).

**Gmail vs. Microsoft 365 placement.** With `p=quarantine` and a brand-new sending domain (no reputation), Gmail will often route mail to **spam** while M365 tenants inbox it — even when SPF/DKIM/DMARC all pass. This is reputation/warm-up, not an auth failure. Levers: consistent low volume + recipient engagement (mark "not spam"), a `List-Unsubscribe` header (below), and DMARC `rua` reports to watch pass/fail per receiver.

**List-Unsubscribe (AECI-537).** The `mailing-list-welcome` template now sets a true one-click opt-out when it has both a public host (`PUBLIC_SITE_URL`) and the subscriber's `unsubscribe_token`:

```
List-Unsubscribe: <https://<host>/api/unsubscribe?token=…>, <mailto:unsubscribe@<sender-domain>?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

The https target is the public SSR host, which forwards `POST /api/unsubscribe` to the private API Worker via the `/api/*` passthrough; the mailto (RFC 2369, derived from the `EMAIL_FROM` domain) is retained as a secondary value. The in-body opt-out link points at the human-facing `/unsubscribe?token=…` page (which confirms, then POSTs the same endpoint). When the host or token is missing, both the header and the in-body link **degrade to the mailto only** — for that path to be actionable, route `unsubscribe@aecintegrations.com` (Cloudflare Email Routing) to an inbox that processes opt-outs. See `POST /api/unsubscribe` in `docs/API_CONTRACTS.md` §6.13 and the `/unsubscribe` page (`apps/web/src/app/unsubscribe/`).

## Testing

- `apps/api/src/lib/email.spec.ts` — mocks `fetch`; asserts each template's POST
  payload + the `sent` / `failed` / `skipped` outcomes (fail-open, never throws).
- `lib/admin-alert.spec.ts` — the sweep seam delegates to the transport.
- `routes/{reviews,admin-reviews,account}.spec.ts` — assert the right send fires
  (mocked `lib/email`) with the correct recipient/payload, and that a send never
  affects the response.
