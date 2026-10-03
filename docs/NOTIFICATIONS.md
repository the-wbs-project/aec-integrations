# Notifications

<!-- Generated from apps/api/src/lib/notifications/registry.ts. Do not edit by hand; run `pnpm docs:notifications`. -->

> Generated from `apps/api/src/lib/notifications/registry.ts`. Do not edit by hand; run `pnpm docs:notifications`.

## What this is

This is the list of every notification AECi sends: email, vendor portal rows and Linear
writes. It is rendered from the notification registry,
`apps/api/src/lib/notifications/registry.ts` (AECI-1199). The registry is the source of
truth. To change a row here, change the registry entry and run
`pnpm docs:notifications`. Root `pnpm lint` fails when this file is stale.

Every merge to `main` that changes this file mirrors it into a Linear Document, through
`.github/workflows/mirror-notifications-doc.yml` (AECI-1201). The Linear copy is read-only
in practice: edits made there are overwritten on the next merge.

Each entry records today's behaviour, including known gaps. Change an entry in the same
commit that changes the behaviour it describes.

**Every sender must name an entry.** The types enforce it, and
`apps/api/src/lib/notifications/registry-coverage.spec.ts` scans `apps/api/src` and fails
on a sender that names no registry id, or on an entry that no code sends.
`registry.spec.ts` checks each entry's shape and that its doc section exists.

| Sender | Takes |
|---|---|
| `sendTransactionalEmail` | `template`, typed as `EmailTemplate`, derived from the email entries |
| `sendEmail` (cron digests) | a required `notification` digest id |
| Every `notification.sent` audit builder | a `notification` id, recorded as `metadata.notificationId` |
| `createLinearIssueForRequest`, `createLinearIssueForContest`, `pushRequestResolutionToLinear` | a `notification` field on the input, carried on their logs |

**The tier rule (AECI-1198).** Email to an outside recipient sends from production only.
Every other tier sends only to the internal allowlist, `thewbsproject.com` and `aecintegrations.com`, matched exactly on the
domain. Anything else is suppressed and counted as `outcome:suppressed`. A missing or
unknown `ENV` counts as non-production. The policy is
`apps/api/src/lib/notifications/delivery-policy.ts`, and `docs/email.md` §Tier delivery
policy is its governing doc.

- `production-external`: email to an outside person. Sent from production only.
- `any-tier`: no gate of its own. For email this is operator mail to internal inboxes. A
  portal row or a Linear write has no outbound message to gate.

**Id scheme.** An email id is its `template:` metric tag. A template sent from a second
trigger gets a suffixed id, such as `-resend` for an owner re-send. A second trigger that
shares the first one's dedupe key keeps the same id, because at most one of them sends:
`claim-submitted-alert` (the submit and the reconcile sweep) is the one case.
The operator `COPY:` of an unsubscribable send is `<template>-operator-copy`. Digests are
`digest-<name>`, portal rows `portal-<kind>[-<event>]`, Linear writes
`linear-<subject>-<what>`.

**Ledger** is the durable record that proves a send happened: `audit_log` (a
`notification.sent` row), `fence-column` (a sent-at column on the entity), `invite-row` (the
seat invite row), `job_runs` (the cron run record), `linear-issue-id` (the issue id stored
on the request or contest), or `none`.

**To add a notification,** add its registry entry first, name the id at the sender, then
run `pnpm docs:notifications` and commit this file.

## Counts

| Channel | Entries |
|---|---|
| `email` | 27 |
| `email+portal` | 1 |
| `supabase-email` | 1 |
| `portal` | 16 |
| `linear` | 4 |
| **Total** | **49** |

## Email (Resend) (`email`, 27)

Resend email from the API Worker. Transactional sends go through `sendTransactionalEmail`,
and the id is the `template:` tag on the `aeci.email.send` metric. The cron digests
(`digest-*`) go through the low-level `sendEmail` transport and count on the same metric.
Transport, house layout, per-template copy notes and secrets are in `docs/email.md`.
Every send writes one `notification_sends` row per recipient, with the Resend message id
on success (AECI-1202, `docs/DATABASE_SCHEMA.md` §9.9).

| Id | Summary | Audience | Trigger | Tier rule | Dedupe | Ledger | Opt-out | Doc | Note |
|---|---|---|---|---|---|---|---|---|---|
| `account-deleted` | Confirms to a user that their account was deleted. | external | route: DELETE /api/account (routes/account.ts) | `production-external` | None. | `notification_sends` | `none` | docs/email.md §Template content notes |  |
| `attestation-ops-digest` | Tells ADMIN_ALERT_EMAIL about every denied claim and standing conflict of the day, in one email. | operator | cron: 0 10 attestation sweep (lib/attestation-notify.ts) | `any-tier` | One per address per day: attestation-ops-digest:{YYYY-MM-DD}:{recipient hash}. Each finding is listed once per 30 days per (claim, detector, ~ops). | `notification_sends`, `audit_log` | `none` | docs/STAGE_2_ATTESTATIONS_SPEC.md §7.2 | Replaced attestation-ops-alert, one email per finding, in AECI-1204. Its notification.sent rows carry vendorId null, so no vendor portal shows them. |
| `claim-approved` | Tells a claimant their claim was approved. | external | route: PATCH /api/admin/claims/:id (routes/admin-claims.ts) | `production-external` | Re-approving an already-seated claim is a no-op and sends nothing. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §9 | Two variants by the plan the operator chose (AECI-1215): Managed lists attestations, Free says the account is on the Free plan. One id, because it is one event. |
| `claim-rejected` | Tells a claimant their claim was not approved, without the reviewer reason. | external | route: PATCH /api/admin/claims/:id (routes/admin-claims.ts) | `production-external` | Status guard: open or in-review claims only. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §9 |  |
| `claim-submitted-alert` | Tells CLAIM_ALERT_EMAIL a vendor claimed a listing, after the Linear attempt. | operator | route: POST /api/requests/claim (routes/requests.ts); and the */15 request-reconcile sweep (lib/reconciliation-sweep.ts) when its retry creates the issue | `any-tier` | Claims only, not corrections. Both senders use key claim-submitted-alert:{requestId}, so at most one alert per request. A delivered or unknown submit alert holds the key and the sweep send is a duplicate. A submit alert Resend refused released it, so the sweep send goes out with the issue link. | `notification_sends` | `none` | docs/email.md §Template content notes | LINEAR_API_KEY is set on production only. On staging and demo no issue is created, so the Linear row reads "not created, Linear is not configured on this tier" (AECI-1198). |
| `contest-declined-protest-window` | Tells the submitter's seats the owner declined its contest, and until when it can ask AECi to review it. | external | route: POST /api/vendor/contests/:id/decision (routes/vendor-contests.ts) | `production-external` | One per seat per contest: key contest-declined-protest-window:{contestId}:{profileId}. A contest is declined once. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 | Owner declines only. An AECi decline cannot be protested and sends nothing. |
| `contest-protest-opened` | Tells the owner's seats a submitter asked AECi to review a contest, with the 14-day reply deadline. | external | route: POST /api/vendor/contests/:id/protest (routes/vendor-contest-protests.ts) | `production-external` | One per seat per protest: key contest-protest-opened:{contestId}:{protestedAt}:{profileId}. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 | Sent beside the portal-contest-protested row. The attestation nudge mute does not cover it: missing it costs the owner its reply. |
| `contest-protest-reply-reminder` | Reminds the owner's seats, 2 to 3 days before the deadline, that they have not replied to a protest. | external | cron: 0 12 protest reply reminder (lib/contest-protest-emails.ts runProtestReplyReminderSweep) | `production-external` | One per seat per protest: key contest-protest-reply-reminder:{contestId}:{protestedAt}:{profileId}. The daily runs inside the 3-day window send it once. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 | Skips a protest that has a reply, is no longer open, or is past its deadline. |
| `contest-submitted-alert` | Tells CLAIM_ALERT_EMAIL a vendor filed a contest that AECi must decide. | operator | route: POST /api/vendor/integrations/:id/contests (routes/vendor-contests.ts) | `any-tier` | None. Sent only when the contest routes to AECi. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8 |  |
| `digest-analytics` | Sends ANALYTICS_DIGEST_EMAIL_TO the prior day's traffic digest. | operator | cron: 0 5 analytics digest (scheduled.ts runAnalyticsDigestJob) | `any-tier` | None. | `notification_sends`, `job_runs` | `none` | docs/email.md §Cron digests | ANALYTICS_DIGEST_EMAIL_TO is set on production only. |
| `digest-data-quality` | Sends DATA_QUALITY_EMAIL_TO the daily data-quality check results. | operator | cron: 0 4 data-quality job (scheduled.ts runDataQualityJob) | `any-tier` | None. Sends on a clean run too, so silence means the cron failed. | `notification_sends`, `job_runs` | `none` | docs/email.md §Cron digests | DATA_QUALITY_EMAIL_TO is set on staging, demo and production, so the support inbox gets one a day from each. |
| `entitlement-expiring` | Warns a vendor's seats that their plan term ends soon. | external | cron: 0 11 entitlement-expiry sweep (lib/entitlement-expiry.ts) | `production-external` | expiry_notice_sent_at fence: one notice per term, 30 days out. | `notification_sends`, `fence-column` | `none` | docs/STAGE_2_PAID_TIERS_SPEC.md §7.2 |  |
| `entitlement-expiring-admin` | Tells ADMIN_ALERT_EMAIL a vendor term ends soon, with payer and invoice ref. | operator | cron: 0 11 entitlement-expiry sweep (lib/entitlement-expiry.ts) | `any-tier` | Same fence as entitlement-expiring. | `notification_sends`, `fence-column` | `none` | docs/STAGE_2_PAID_TIERS_SPEC.md §7.2 |  |
| `landing-feedback` | Tells ADMIN_ALERT_EMAIL someone submitted feedback. | operator | route: POST /api/feedback (routes/landing-forms.ts) | `any-tier` | None. Every submit sends. | `notification_sends` | `none` | docs/email.md §Template content notes | The feedback row records the submission, not the send. |
| `landing-signup` | Tells ADMIN_ALERT_EMAIL someone joined the mailing list. | operator | route: POST /api/subscribe (routes/landing-forms.ts) | `any-tier` | Not sent for an address that is already active. Key landing-signup:{recipientHash}:{YYYY-MM} (UTC), keyed on the subscriber. | `notification_sends` | `none` | docs/email.md §Template content notes |  |
| `mailing-list-welcome` | Welcomes a new mailing-list subscriber. | external | route: POST /api/subscribe (routes/landing-forms.ts) | `production-external` | Not sent to an address that is already active. Key mailing-list-welcome:{recipientHash}:{YYYY-MM} (UTC), so an unsubscribe then resubscribe welcomes once per calendar month. | `notification_sends` | `mailing-list-unsubscribe` | docs/email.md §Template content notes | The mailing_list row is a log-class record of the subscription, not of the send. |
| `mailing-list-welcome-operator-copy` | Sends the EMAIL_BCC list a COPY: of the welcome, with an inert unsubscribe link. | operator | route: POST /api/subscribe (routes/landing-forms.ts) | `any-tier` | Sent only after mailing-list-welcome was sent, so a duplicate welcome sends no copy. | `notification_sends` | `none` | docs/email.md §Architecture | Not counted in aeci.email.send. A failed copy only warns. |
| `protest-submitted-alert` | Tells CLAIM_ALERT_EMAIL a vendor filed a protest that AECi must decide. | operator | route: POST /api/vendor/contests/:id/protest (routes/vendor-contest-protests.ts) | `any-tier` | Key protest-submitted-alert:{contestId}:{protestedAt}. A replay of the same protest is a duplicate. A later protest on the same contest is a new send. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 |  |
| `review-approved` | Tells a reviewer their review was approved. | external | route: PATCH /api/admin/reviews/:id (routes/admin-reviews.ts) | `production-external` | Key review-decision:{reviewId}, shared with the other decision email: one decision email per review. A losing concurrent moderation gets 409 REVIEW_ALREADY_MODERATED and sends nothing. | `notification_sends` | `none` | docs/email.md §Template content notes |  |
| `review-rejected` | Tells a reviewer their review needs revision, with the moderator's reason. | external | route: PATCH /api/admin/reviews/:id (routes/admin-reviews.ts) | `production-external` | Key review-decision:{reviewId}, shared with the other decision email: one decision email per review. A losing concurrent moderation gets 409 REVIEW_ALREADY_MODERATED and sends nothing. | `notification_sends` | `none` | docs/email.md §Template content notes |  |
| `review-submitted` | Tells a reviewer their review is in moderation. | external | route: POST /api/reviews (routes/reviews.ts) | `production-external` | None on the send. A partial-unique index blocks a duplicate review. | `notification_sends` | `none` | docs/email.md §Template content notes |  |
| `review-submitted-alert` | Tells ADMIN_ALERT_EMAIL a review is waiting for moderation. | operator | route: POST /api/reviews (routes/reviews.ts) | `any-tier` | None. | `notification_sends` | `none` | docs/email.md §Template content notes |  |
| `stale-claim-ticket-alert` | Tells FOUNDER_ALERT_EMAIL which claim tickets nobody has started after 24 hours. | operator | cron: 25 */6 claim-stale-check (lib/claim-stale-check.ts) | `any-tier` | Stateless bands: 24 hours, then daily. Key stale-claim-ticket-alert:{requestId}:{bandIndex}, one pair per row in the digest. | `notification_sends` | `none` | docs/STAGE_1_PHASE_6_SPEC.md §6.4a | Production only in practice. Staging and demo create no Linear issues, and FOUNDER_ALERT_EMAIL is unset on demo. |
| `stuck-request-alert` | Tells ADMIN_ALERT_EMAIL which requests are stuck in the Linear pipeline. | operator | sweep: */15 reconciliation sweep (lib/reconciliation-sweep.ts, lib/admin-alert.ts) | `any-tier` | Stateless age bands: 60 minutes, 6 hours, then daily (lib/alert-bands.ts). Key stuck-request-alert:{requestId}:{bandIndex}, one pair per row in the digest. | `notification_sends` | `none` | docs/STAGE_1_PHASE_6_SPEC.md §6.4 | LINEAR_API_KEY is set on production only, so every staging and demo request stays unlinked. The sweep skips this email there. The metric and error log still fire (AECI-1198). |
| `vendor-review-published` | Tells every unbanned seat of each owning vendor that a review of its product was approved. | external | route: PATCH /api/admin/reviews/:id (routes/admin-reviews.ts) | `production-external` | Key vendor-review-published:{reviewId}:{profileId}, one per seat. A losing concurrent moderation gets 409 REVIEW_ALREADY_MODERATED and sends nothing. | `notification_sends` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11c.12 | Sent beside the portal-review row, on every plan. The attestation nudge mute does not cover it. |
| `vendor-seat-invite` | Invites a colleague, typed by a vendor owner, to take a seat. | external | route: POST /api/vendor/seats/invites (routes/vendor-seat-invites.ts) | `production-external` | 10 per vendor per day, plus a per-vendor burst bucket. | `notification_sends`, `invite-row` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.5 |  |
| `vendor-seat-invite-resend` | Re-sends a pending seat invite. | external | route: POST /api/vendor/seats/invites/:id/resend (routes/vendor-seat-invites.ts) | `production-external` | 5-minute cooldown on last_sent_at, 4 sends per invite on send_count. | `notification_sends`, `invite-row` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.9 | Same template as vendor-seat-invite. |

## Email plus vendor portal row (`email+portal`, 1)

One notification on two surfaces: the attestation sweep's daily digest email, plus a
`notification.sent` row per finding that the vendor portal shows. Since AECI-1204 the portal
row is written when a seat was emailed or every seat muted or was refused by the tier
policy. A failed or unconfigured send writes no row, so the next sweep retries it. The
row is the ledger the 30-day dedupe reads.

| Id | Summary | Audience | Trigger | Tier rule | Dedupe | Ledger | Opt-out | Doc | Note |
|---|---|---|---|---|---|---|---|---|---|
| `attestation-digest` | Sends each unmuted vendor seat one daily digest of every due attestation finding for its vendor. | external | cron: 0 10 attestation sweep (lib/attestation-notify.ts) | `production-external` | One per seat per day: attestation-digest:{vendorId}:{profileId}:{YYYY-MM-DD}. Each finding is listed once per 30 days per (claim, detector, vendor), read from the notification.sent rows. | `notification_sends`, `audit_log` | `nudge-mute` | docs/STAGE_2_ATTESTATIONS_SPEC.md §7.2 | Replaced four per-finding templates in AECI-1204. A due finding gets its portal row when a seat was emailed or every seat was muted or refused by the tier policy. A failed or unconfigured send writes no row, so the next sweep retries it. metadata.emailedSeats says how many seats got it. Never lists a vendor finding on a connector-powered edge (AECI-705). |

## Supabase Auth email (`supabase-email`, 1)

Supabase Auth sends this itself, over the Resend SMTP relay. No app code sends it, so the
tier rule cannot stop it and no metric counts it. The template is
`docs/email-templates/magic-link.html`.

| Id | Summary | Audience | Trigger | Tier rule | Dedupe | Ledger | Opt-out | Doc | Note |
|---|---|---|---|---|---|---|---|---|---|
| `supabase-sign-in` | The magic-link or confirm-signup email for anyone who signs in. | external | supabase: signInWithOtp (apps/web/src/app/auth/auth.service.ts) | `any-tier` | GoTrue's own rate limits. | `none` | `none` | docs/email.md §Magic-link sender | Supabase sends it over the Resend SMTP relay. No app code sends it, so the tier gate cannot stop it. |

## Vendor portal feed only (`portal`, 16)

Delivered only as `notification.sent` audit rows, written in the same `db.batch` as the
change that caused them. The row is its own ledger. The vendor portal reads them through
`GET /api/vendor/notifications`, and revalidates on the `GET /api/vendor/updates` cursor.
None of these sends email and none has an opt-out, so a vendor learns of one only by
opening the portal. The portal copy lives in `vendor-notifications-list.ts` and
`vendor-contest-labels.ts` in `apps/web`. Per-side link writes (AECI-1007) send no
notification at all.

| Id | Summary | Audience | Trigger | Tier rule | Dedupe | Ledger | Opt-out | Doc | Note |
|---|---|---|---|---|---|---|---|---|---|
| `portal-claim-added` | Tells a vendor another vendor added a data row to an integration on its product. | external | route: PUT /api/vendor/claims/:claimId/attestation (routes/vendor-attestations.ts) | `any-tier` | One row per recipient, in the attestation batch. | `audit_log` | `none` | docs/STAGE_2_ATTESTATIONS_SPEC.md §7.6 |  |
| `portal-contest-closed-by-retire` | Tells the other side of an open contest that a retire closed it. | external | route: POST /api/{vendor,admin}/integrations/:id/retire (routes/integration-retire-write.ts) | `any-tier` | One row per closed contest, in the retire batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8 |  |
| `portal-contest-decided-by-aeci` | Tells the submitter AECi accepted or declined its contest. | external | route: PATCH /api/admin/contests/:id (routes/admin-contests.ts) | `any-tier` | One row per transition, in the transition batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8 |  |
| `portal-contest-decided-by-owner` | Tells the submitter the owner accepted or declined its contest. | external | route: POST /api/vendor/contests/:id/decision (routes/vendor-contests.ts) | `any-tier` | One row per transition, in the transition batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8 | A decline carries the 30-day protest deadline. Since AECI-1205 the contest-declined-protest-window email carries it too. |
| `portal-contest-protest-decided` | Tells both vendors whether AECi upheld or rejected a protest. | external | route: PATCH /api/admin/contests/:id/protest (routes/admin-contest-protests.ts) | `any-tier` | One row per side, in the decision batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 |  |
| `portal-contest-protest-replied` | Tells the submitter the owner replied to its protest. | external | route: POST /api/vendor/contests/:id/protest/reply (routes/vendor-contest-protests.ts) | `any-tier` | One row per protest step, in the step batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 |  |
| `portal-contest-protest-withdrawn` | Tells the owner a protest on its integration was withdrawn. | external | route: POST /api/vendor/contests/:id/protest/withdraw (routes/vendor-contest-protests.ts) | `any-tier` | One row per protest step, in the step batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 |  |
| `portal-contest-protested` | Tells the owner a submitter asked AECi to review a contest. | external | route: POST /api/vendor/contests/:id/protest (routes/vendor-contest-protests.ts) | `any-tier` | One row per protest step, in the step batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10 | Carries the 14-day reply deadline. Since AECI-1205 the contest-protest-opened email carries it too. |
| `portal-contest-submitted` | Tells the owner a vendor contested a field on its integration. | external | route: POST /api/vendor/integrations/:id/contests (routes/vendor-contests.ts) | `any-tier` | One row per transition, in the transition batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8 |  |
| `portal-contest-withdrawn` | Tells the owner a contest on its integration was withdrawn. | external | route: POST /api/vendor/contests/:id/withdraw (routes/vendor-contests.ts) | `any-tier` | One row per transition, in the transition batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8 |  |
| `portal-integration-claim` | Tells the other endpoint vendors that a vendor now owns an integration. | external | route: POST /api/vendor/integrations/:id/claim (routes/vendor-integration-claims.ts); owner accept in routes/admin-contests.ts | `any-tier` | One row per recipient, in the claim batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.5 |  |
| `portal-integration-create` | Tells the other endpoint vendors a vendor created an integration on their product. | external | route: POST /api/vendor/integrations (routes/vendor-integration-create.ts) | `any-tier` | One row per recipient, in the create batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.7 |  |
| `portal-integration-retire` | Tells the endpoint vendors an integration was retired or restored. | external | route: POST /api/{vendor,admin}/integrations/:id/{retire,restore} (routes/integration-retire-write.ts) | `any-tier` | One row per recipient, in the write batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.6 |  |
| `portal-integration-update` | Tells the other endpoint vendors the owner edited an integration. | external | route: PATCH /api/vendor/integrations/:id (routes/vendor-integration-edits.ts, routes/vendor-evidenced-pair-edits.ts) | `any-tier` | One row per recipient, in the edit batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.5.6 |  |
| `portal-review` | Tells each owning vendor that a review of its product was approved. | external | route: PATCH /api/admin/reviews/:id (routes/admin-reviews.ts) | `any-tier` | One row per owning vendor, in the approve batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11c.12 | Written for a vendor with no seat too, so the feed is complete once it is seated. A reject writes none. |
| `portal-review-response` | Tells a vendor that AECi approved, rejected or removed its reply to a review. | external | route: PATCH /api/admin/review-responses/:id (routes/admin-review-responses.ts) | `any-tier` | One row per decision, in the decision batch. | `audit_log` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11c.12 | metadata.event names the decision. Reject and remove carry the reason. No email, as for contests. |

## Linear (`linear`, 4)

Writes to Linear. Linear then emails or pings whoever is subscribed there, and AECi does
not control that fan-out.

| Id | Summary | Audience | Trigger | Tier rule | Dedupe | Ledger | Opt-out | Doc | Note |
|---|---|---|---|---|---|---|---|---|---|
| `linear-contest-issue` | Files the REVIEW - issue that carries an accepted contest to the review lane. | operator | route: PATCH /api/admin/contests/:id accept (routes/admin-contests.ts); retried by lib/reconciliation-sweep.ts | `any-tier` | Read-guard on the linked issue id, then a compare-and-set persist. | `linear-issue-id` | `none` | docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.6 | LINEAR_API_KEY is set on production only, so staging and demo file no issues. |
| `linear-request-duplicate-comment` | Comments on a new request issue that it may duplicate an open request. | operator | route: POST /api/requests/{claim,correction} (routes/requests.ts) | `any-tier` | Once per issue create. | `none` | `none` | docs/STAGE_1_PHASE_6_SPEC.md §7.2 | Production only: it needs the issue that linear-request-issue creates. |
| `linear-request-issue` | Files a Linear issue for a vendor claim or correction. | operator | route: POST /api/requests/{claim,correction} (routes/requests.ts); retried by lib/reconciliation-sweep.ts | `any-tier` | Read-guard on the linked issue id, then a compare-and-set persist. | `linear-issue-id` | `none` | docs/STAGE_1_PHASE_6_SPEC.md §6.1 | LINEAR_API_KEY is set on production only, so staging and demo file no issues. |
| `linear-request-resolution` | Moves a request's Linear issue to Done or Canceled and comments the reason. | operator | route: PATCH /api/admin/requests/:id (routes/admin-requests.ts) | `any-tier` | None. Each resolve or reject pushes once. | `none` | `none` | docs/STAGE_1_PHASE_6_SPEC.md §6.5 | The site-linear-sync workflow_transitions row records the sync, not a send. Production only: other tiers have no linked issue to move. |

## Monitoring alerts (not product notifications, 18)

These PostHog alerts tell the operator about the system, not a person about an event in
the product, so they are not registry entries. They are defined in
`observability/posthog/alerts.json`. They apply to `prod`. The subscribers are `chrisw@thewbsproject.com`, from
`observability/posthog/project-config.json` (`alertSubscribers`). `docs/OBSERVABILITY.md`
governs them.

| Key | Name | Interval |
|---|---|---|
| `algolia-orphan-cap` | AECi — Algolia orphan sweep capped | hourly |
| `auth-error-rate` | AECi — Auth sign-in error rate > 30% (1 h) | hourly |
| `cron-job-failed` | AECi — Cron job failed (any daily/hourly job) | hourly |
| `data-quality-error` | AECi — Data quality check found ERROR-severity issues | hourly |
| `detail-render-p95` | AECi — p95 detail page render > 1.5 s (1 h) | hourly |
| `email-failure-rate` | AECi — Emails failing to send (> 20% over 24 h, at least 2 failed) | daily |
| `email-suppressed-in-production` | AECi — Live site held back an email (any, 1 h) | hourly |
| `email-volume-spike` | AECi — Far more emails than usual (> 50 in 24 h) | daily |
| `indexnow-failure-rate` | AECi — Search-engine pings refused (> 90% over 72 h) | daily |
| `linear-pipeline-failure` | AECi — Linear pipeline failure rate > 50% (1 h) | hourly |
| `pageviews-write-errors` | AECi — page_views write error rate > 10% (1 h) | hourly |
| `profile-ensure-failed` | AECi — Account record could not be created (any, 1 h) | hourly |
| `reconcile-persistent-stuck` | AECi — Linear reconciliation: persistent stuck requests | hourly |
| `retention-runaway` | AECi — Retention prune runaway (> 5,000 rows/table/day) | hourly |
| `toxicity-outage` | AECi — Toxicity scoring outage (> 50% errors, 1 h) | hourly |
| `waf-ratelimit-spike` | AECi — WAF rate-limit / challenge spike (> 2,000 / 1 h) | hourly |
| `webhook-hmac-failure` | AECi — Linear webhook HMAC failures > 3 (1 h) | hourly |
| `worker-error-rate` | AECi — Worker error rate > 1% (1 h) | hourly |
