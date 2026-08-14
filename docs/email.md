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
| `mailing-list-welcome` | `POST /api/subscribe` on a fresh insert (`routes/landing-forms.ts`) | the new subscriber (`payload.email`) | Subscriber welcome / first touch (AECI-327). Links to `/products` when `PUBLIC_SITE_URL` set. Not sent on the idempotent already-listed no-op. Sibling of the operator `landing-signup` alert. Carries a `List-Unsubscribe` mailto header (`unsubscribe@<EMAIL_FROM domain>`) + a matching in-body opt-out line for deliverability. |
| `stuck-request-alert` | reconciliation sweep (`lib/admin-alert.ts` → `lib/reconciliation-sweep.ts`) | `ADMIN_ALERT_EMAIL` | §6.2 persistent-failure digest |
| `landing-signup` | `POST /api/subscribe` on a fresh insert (`routes/landing-forms.ts`) | `ADMIN_ALERT_EMAIL` | Operator "new mailing-list signup" (AECI-247/277 — replaces the retired `apps/landing` Worker's own send). Not sent on the idempotent already-listed no-op. |
| `landing-feedback` | `POST /api/feedback` (`routes/landing-forms.ts`) | `ADMIN_ALERT_EMAIL` | Operator "new feedback submitted" (AECI-247/277). |
| `claim-approved` | `PATCH /api/admin/claims/:id` approve (`routes/admin-claims.ts`, AECI-528) | claimant (`submitter_email`) | Names the claimed vendor/product, lists what the account can now do, links to the `/vendor` dashboard when `PUBLIC_SITE_URL` set. Sign-in copy branches on the `invited` (just-provisioned) vs `linked` identity outcome. Verification framed as an account status, never ranking/placement. |
| `claim-rejected` | `PATCH /api/admin/claims/:id` reject | claimant (`submitter_email`) | Neutral by design (§9 AC): names the vendor, states the claim wasn't approved, invites resubmission. The reviewer's decision `reason` is an **internal audit note** (recorded in `audit_log`, admin-visible) and is **never emailed** — so nothing a reviewer types can leak to the claimant. |

Copy is en-US plain text + minimal HTML, built inline in `lib/email.ts` (emails are
not i18n'd at launch — the CLAUDE.md i18n rule is for rendered `apps/web` templates).

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

**List-Unsubscribe.** The `mailing-list-welcome` template sets `List-Unsubscribe: <mailto:unsubscribe@<sender-domain>?subject=unsubscribe>` (RFC 2369), derived from the `EMAIL_FROM` domain. For it to be actionable, route `unsubscribe@aecintegrations.com` (Cloudflare Email Routing) to an inbox that processes opt-outs. One-click POST (RFC 8058 `List-Unsubscribe-Post`) is intentionally **not** set: it needs a public unsubscribe endpoint + token and is only required of bulk senders (5000+/day). Add it if/when volume warrants.

## Testing

- `apps/api/src/lib/email.spec.ts` — mocks `fetch`; asserts each template's POST
  payload + the `sent` / `failed` / `skipped` outcomes (fail-open, never throws).
- `lib/admin-alert.spec.ts` — the sweep seam delegates to the transport.
- `routes/{reviews,admin-reviews,account}.spec.ts` — assert the right send fires
  (mocked `lib/email`) with the correct recipient/payload, and that a send never
  affects the response.
