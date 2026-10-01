# ADR 0037: A notification registry, production-only email and an at-most-once send ledger

- Status: Accepted
- Date: 2026-10-01
- Issue: AECI-1197 (sub-issues AECI-1198 to AECI-1206)
- Supersedes: nothing. It amends `STAGE_2_ATTESTATIONS_SPEC.md` §7.2 and §7.3 (one email per finding becomes one digest per seat) and `STAGE_1_PHASE_6_SPEC.md` §6.1 (the sweep no longer re-sends the claim alert).

## Context

On 2026-10-01 we inventoried every notification the app sends. There were 46: 25 transactional
emails, 2 cron digests, the Supabase sign-in email, 14 vendor portal rows and 4 Linear writes.
Nothing listed them. The inventory found six problems.

- **Non-production tiers emailed real people.** Every tier shares one Supabase Auth project
  (ADR 0017), and staging, demo and local Workers held a live `RESEND_API_KEY`. A staging sweep
  could email a real vendor seat.
- **No list.** A new sender needed no entry anywhere, so the inventory had to be rebuilt by reading
  code.
- **No send record.** 16 of the 25 email types left no trace of the send. The Resend message id was
  drained unread. Nothing in D1 could answer "what did we send to this person".
- **Nudge spam.** The attestation sweep sent one email per finding per seat. Forty findings meant
  forty emails per seat in one morning, on the Resend account that also sends sign-in links.
- **Double sends.** Five paths could send the same email twice: the claim alert (submit and sweep),
  a two-admin review moderation race, the band-throttled stuck and stale alerts on a retry, the
  mailing-list welcome, and the per-finding attestation nudge.
- **Portal-only deadlines.** A protest's 14-day reply deadline and the decline window existed only
  in the vendor portal. Nobody was emailed about them.

## Decision

### 1. External email sends from production only (AECI-1198)

- Production sends to anyone. Every other tier sends only to `thewbsproject.com` and
  `aecintegrations.com`, matched exactly on the domain.
- The allowlist is a code constant in `apps/api/src/lib/notifications/delivery-policy.ts`, not an
  env var, so a misconfigured var cannot widen it.
- **Fail closed.** A missing or unknown `ENV` counts as non-production.
- A refused recipient makes no Resend call. The send returns the new `suppressed` outcome and logs
  a recipient hash, never the address. BCC lists are filtered the same way.
- Non-production subjects carry a `[tier]` prefix, for example `[staging]`.
- **Supabase sign-in mail is outside the gate.** Supabase sends it itself, so this code never sees
  it. `docs/email.md` §Tier delivery policy records the exception.

### 2. The registry is the contract (AECI-1199 to AECI-1201)

- `apps/api/src/lib/notifications/registry.ts` lists every notification. Each entry names its
  channel, audience, trigger, tier rule, dedupe, ledger, opt-out and governing doc section.
- **Every sender must name an entry.** `EmailTemplate` is derived from the registry. The digest
  sender, every `notification.sent` builder and the Linear senders take a registry id.
  `registry-coverage.spec.ts` scans `apps/api/src` and fails on a sender with no id, or an id
  nothing sends.
- `docs/NOTIFICATIONS.md` is generated from the registry by `pnpm docs:notifications`. Root
  `pnpm lint` runs the `--check` mode, so a stale file fails the required lint job.
- A GitHub Action, `.github/workflows/mirror-notifications-doc.yml`, overwrites one Linear Document
  with that file on every merge to `main` that changes it. Edits made in Linear are overwritten.

### 3. A log-class send ledger, at most once (AECI-1202)

- `notification_sends` holds one row per send attempt per recipient, for both Resend transports.
  `docs/DATABASE_SCHEMA.md` §9.9 is the schema.
- **Log-class.** It is exempt from the audit-in-batch invariant under ADR 0022, like `page_views`
  and `job_runs`. Each write is its own statement in its own try/catch.
- **The recipient hash is unsalted.** It is SHA-256 of the trimmed, lowercased address. Support
  answers "what did we send to X" by hashing X. A salt would defeat that lookup.
- **Retention is 400 days**, enforced by the retention prune, the same window as `page_views`.
- **The protocol is reserve, send, finalize.**
  1. Reserve a `sending` row with `INSERT … ON CONFLICT(dedupe_key) DO NOTHING`.
  2. A held key returns `duplicate` and makes no Resend call.
  3. Send, then settle the row to `sent` with the Resend id, or to `failed`.
  4. `failed` releases the key so a retry can send.
  5. A crash between reserve and finalize leaves a `sending` row that still holds the key. It
     blocks a resend.
  6. A ledger DB error fails open. The mail still goes.
- **Why at-most-once and not at-least-once.** A missed email can be sent by hand, and the portal
  row still records the finding. A double email cannot be taken back, and on the shared Resend
  account a complaint spike can put sign-in links at risk. So a crash mid-send loses the mail rather
  than repeating it. The fail-open rule is the one exception: a ledger outage must never stop mail.

### 4. Attestation nudges become one daily digest per seat (AECI-1204)

- The sweep sends one `attestation-digest` per unmuted `vendor_admin` seat per day. It lists every
  due finding, 25 in full and the rest counted. One `attestation-ops-digest` goes to each
  `ADMIN_ALERT_EMAIL` address per day.
- The five per-finding templates are retired: `attestation-silent-counterparty`,
  `attestation-open-conflict`, `attestation-stale-version`, `attestation-claim-denied` and
  `attestation-ops-alert`.
- **A per-seat mute** lives in the new `notification_preferences` table. A seat mutes from the
  Messages page or by the RFC 8058 one-click link, `POST /api/notifications/nudges/mute`, keyed by an
  opaque `mute_token`. The mute covers the digest only. Every change is audited in the same batch.
- **The portal row is written for every due finding whether or not anyone was emailed.** That covers
  a seat that got the digest, and every seat muted or suppressed by the tier policy. The row carries
  `emailedSeats`, and 0 means portal only. **The one exception:** no row is written when no seat got
  the digest and a send failed, or when nothing could be attempted. Then tomorrow's sweep retries.

### 5. The remaining double-send paths close (AECI-1203)

- **Review moderation.** A `changes() = 0` sentinel after the guarded UPDATE rolls the losing batch
  back. The loser answers `409 REVIEW_ALREADY_MODERATED` and sends nothing. Both decision emails
  share the key `review-decision:{reviewId}`.
- **Claim alert.** It is sent once, at submit, keyed `claim-submitted-alert:{requestId}`. The sweep's
  re-send and its `claim-submitted-alert-retry` registry entry are removed.
- **Stuck and stale alerts** are keyed by the sorted set of `{requestId}:{bandIndex}` pairs in the
  digest (`bandDigestKey` in `lib/alert-bands.ts`).
- **Mailing list.** The welcome and the signup alert are keyed per address hash per UTC month.

AECI-1205 then added four emails for the portal-only deadlines, each with its own key:
`contest-protest-opened`, `protest-submitted-alert`, `contest-protest-reply-reminder` and
`contest-declined-protest-window`. The reminder runs on a new daily cron, `protest-reply-reminder`,
the sixteenth. AECI-1206 added three PostHog alerts on `aeci.email.send`, for 18 in total.

## Consequences

- **Staging now shows portal rows with `emailedSeats` 0.** Its seats are outside the allowlist, so
  every digest is suppressed and the rows are written as deliberately not emailed. That is the
  intended reading, not a fault.
- **A `profiles` recreate wipes every mute.** `notification_preferences.profile_id` is
  `ON DELETE CASCADE`. A drizzle-kit recreate of `profiles` fires that cascade, and a wiped mute
  silently emails seats that opted out. `docs/migrations.md` §0 governs any such recreate.
- **A multi-request alert can send one extra email, never lose one.** The key covers the sorted row
  set. If a row clears between a send and its retry inside one window, the retry builds a different
  key and sends the smaller digest.
- **A crashed send is lost.** It shows as a stuck `sending` row in `notification_sends`. Nothing
  re-sends it automatically.
- **Non-production testing needs an internal address.** A tester who wants to see a mail on staging
  must use a seat on one of the two allowlisted domains.
- **The registry must change with the code.** Adding, retiring or re-keying a notification is a
  registry edit plus `pnpm docs:notifications` in the same commit, or lint fails.
- **The Linear Document needs a repository secret and a variable.** Until the operator sets
  `LINEAR_DOCS_MIRROR_API_KEY` and `LINEAR_NOTIFICATIONS_DOC_ID`, each mirror run fails with exit 2.
  The run is not a required check, so it never blocks a merge (`docs/CICD_PLAN.md` §11b).
