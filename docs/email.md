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
  `outcome:sent|failed|skipped` + `template:<id>`; failures also `warn` to Datadog
  (`source: 'email'`). Telemetry is wrapped so it can never turn a send into a throw.
- **Recipient emails** for reviewers come from `fetchAuthUserEmails()`
  (`lib/supabase-admin.ts`, the GoTrue Admin API) — D1 has no `auth.users` (ADR
  0016). The submission email uses the verified `session.email` directly; the
  account-deletion email captures `session.email` **before** the `auth.users` row
  is erased.

## Template catalogue

| `template` id | Trigger / call site | Recipient | Notes |
|---|---|---|---|
| `review-submitted` | `POST /api/reviews` (`routes/reviews.ts`) | reviewer (`session.email`) | "Thanks — your review is in moderation" |
| `review-approved` | `PATCH /api/admin/reviews/:id` approve (`routes/admin-reviews.ts`) | reviewer | links to `/products/{slug}` when `PUBLIC_SITE_URL` set |
| `review-rejected` | `PATCH /api/admin/reviews/:id` reject | reviewer | includes the moderator's reason + a guidelines link |
| `account-deleted` | `DELETE /api/account` (`routes/account.ts`) | the deleted user (captured pre-erasure) | GDPR confirmation |
| `mailing-list-welcome` | `POST /api/subscribe` on a fresh insert or reactivation (`routes/landing-forms.ts`) | the new subscriber (`payload.email`) | Subscriber welcome / first touch (AECI-327). Links to `/products` when `PUBLIC_SITE_URL` set. Not sent on the still-active already-listed no-op. Sibling of the operator `landing-signup` alert. Unsubscribe (AECI-537): with a public host + the subscriber's token, the in-body link and `List-Unsubscribe` header point at the tokenized `/unsubscribe` flow and set RFC 8058 one-click (`List-Unsubscribe-Post`); without them it degrades to the `unsubscribe@<EMAIL_FROM domain>` mailto (see List-Unsubscribe section below). |
| `stuck-request-alert` | reconciliation sweep (`lib/admin-alert.ts` → `lib/reconciliation-sweep.ts`) | `ADMIN_ALERT_EMAIL` | §6.2 persistent-failure digest |
| `landing-signup` | `POST /api/subscribe` on a fresh insert (`routes/landing-forms.ts`) | `ADMIN_ALERT_EMAIL` | Operator "new mailing-list signup" (AECI-247/277 — replaces the retired `apps/landing` Worker's own send). Not sent on the idempotent already-listed no-op. |
| `landing-feedback` | `POST /api/feedback` (`routes/landing-forms.ts`) | `ADMIN_ALERT_EMAIL` | Operator "new feedback submitted" (AECI-247/277). |

Copy is en-US plain text + minimal HTML, built inline in `lib/email.ts` (emails are
not i18n'd at launch — the CLAUDE.md i18n rule is for rendered `apps/web` templates).

### Cron digests (the low-level `sendEmail` layer)

The table above is the **transactional** layer (`sendTransactionalEmail`, one `template`
id each, on the `aeci.email.send` metric). Two **scheduled digests** ride the separate
low-level `sendEmail` transport (`lib/email.ts`, AECI-241) instead — multi-recipient,
their own metric, no `template` tag — so they don't appear above:

| Digest | Cron (UTC) | Builder | Recipient var | Metric |
|---|---|---|---|---|
| Data-quality report | `0 4 * * *` | `lib/data-quality-email.ts` (`scheduled.ts` `runDataQualityJob`) | `DATA_QUALITY_EMAIL_{FROM,TO}` | `aeci.data_quality.email` |
| Operator analytics digest (AECI-526) | `0 12 * * *` (= 07:00 EST) | `lib/analytics-digest.ts` (`scheduled.ts` `runAnalyticsDigestJob`) | `ANALYTICS_DIGEST_EMAIL_TO` — **production only** (sender = shared `EMAIL_FROM`) | `aeci.analytics_digest.email` |

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
strips it, so external sources under-count) (AECI-526 follow-up). Report-only reads; fail-open (absent
key/recipient → `skipped`). The cron runs in **every** deploy env (staging/demo/production)
for liveness, but `ANALYTICS_DIGEST_EMAIL_TO` is set on **production only** —
staging/demo carry synthetic D1 data, so their sends intentionally `skip` (the var is
left unset).

## Secrets & vars

| Name | Kind | Where | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | Wrangler **secret** | API Worker, staging + production | CI pushes it from a **single shared, un-suffixed** `RESEND_API_KEY` GH secret — one Resend account/key spans every env (like `SUPABASE_ANON_KEY`); `deploy.yml`, `promote-to-demo.yml`, and `promote-to-prod.yml` all push the same secret. Graceful warn-and-skip; absent → sends `'skipped'`. |
| `EMAIL_FROM` | plain `var` | API Worker, per env (`wrangler.jsonc`) | Resend `from`; `Name <addr>` on a verified domain. |
| `PUBLIC_SITE_URL` | plain `var` | API Worker, per env | Builds absolute links in emails; absent → link omitted. |
| `ADMIN_ALERT_EMAIL` | plain `var` | API Worker, staging + production | `To:` for the stuck-request alert **and** the landing signup/feedback operator notifications (AECI-247/277). |

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

`supabase/config.toml` is **local-only** (magic links land in Inbucket at
`:54324` during `supabase start`); deployed SMTP lives in the dashboard.

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
