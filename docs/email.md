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
| `stuck-request-alert` | reconciliation sweep (`lib/admin-alert.ts` → `lib/reconciliation-sweep.ts`) | `ADMIN_ALERT_EMAIL` | §6.2 persistent-failure digest |

Copy is en-US plain text + minimal HTML, built inline in `lib/email.ts` (emails are
not i18n'd at launch — the CLAUDE.md i18n rule is for rendered `apps/web` templates).

## Secrets & vars

| Name | Kind | Where | Notes |
|---|---|---|---|
| `RESEND_API_KEY` | Wrangler **secret** | API Worker, staging + production | CI pushes it from `RESEND_API_KEY_{STAGING,PRODUCTION}` GH secrets (graceful warn-and-skip, like `ANTHROPIC_API_KEY`). Absent → sends `'skipped'`. |
| `EMAIL_FROM` | plain `var` | API Worker, per env (`wrangler.jsonc`) | Resend `from`; `Name <addr>` on a verified domain. |
| `PUBLIC_SITE_URL` | plain `var` | API Worker, per env | Builds absolute links in emails; absent → link omitted. |
| `ADMIN_ALERT_EMAIL` | plain `var` | API Worker, staging + production | `To:` for the stuck-request alert. |

**One-time ops step (not in CI):** provision the keys —

```bash
gh secret set RESEND_API_KEY_STAGING     # from the Resend dashboard
gh secret set RESEND_API_KEY_PRODUCTION
```

Until these exist, deploys still succeed and email simply no-ops (`'skipped'`).
Local dev: set `RESEND_API_KEY` + `EMAIL_FROM` in `apps/api/.dev.vars` to exercise
real sends (see `.dev.vars.example`).

## Magic-link sender (Supabase Auth → Resend SMTP) — ops, no app code

Supabase Auth sends magic links itself; to send them **from Resend** (rather than
Supabase's rate-limited built-in sender, which 429s `over_email_send_rate_limit`),
configure **custom SMTP** in each Supabase project's dashboard
(Authentication → Emails → SMTP). There is no app code for this.

For **both** projects (dev `dmbygwupskttzsvfzluq`, prod `jgxebjufabtwkcgxjqvk`):

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

The sending domain (`aecintegrations.com`) must have, in DNS:

- **SPF** — include Resend's sending hosts.
- **DKIM** — the CNAME records Resend issues when you verify the domain.
- **DMARC** — a `_dmarc` policy record (start `p=none`, tighten later).

Verify the domain in the Resend dashboard before provisioning prod keys, or sends
will bounce / land in spam.

## Testing

- `apps/api/src/lib/email.spec.ts` — mocks `fetch`; asserts each template's POST
  payload + the `sent` / `failed` / `skipped` outcomes (fail-open, never throws).
- `lib/admin-alert.spec.ts` — the sweep seam delegates to the transport.
- `routes/{reviews,admin-reviews,account}.spec.ts` — assert the right send fires
  (mocked `lib/email`) with the correct recipient/payload, and that a send never
  affects the response.
