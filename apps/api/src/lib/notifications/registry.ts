/**
 * The notification registry (AECI-1199): the one list of everything AECi sends.
 *
 * Every sender names an entry here. The types make that so: `sendTransactionalEmail`
 * takes a transactional email id, the cron `sendEmail` takes a digest id, every
 * `notification.sent` audit builder takes a portal (or attestation) id, and every
 * Linear write that notifies a person takes a Linear id. `registry-coverage.spec.ts`
 * scans `apps/api/src` and fails on a sender that names no entry, so a new sender
 * cannot ship without a row here.
 *
 * **Id scheme.**
 *
 *   - Email rows keep their existing `template` ids. The id is the `template:` tag on
 *     the `aeci.email.send` metric. Two triggers that send the same template from a
 *     different trigger get their own id with a suffix: `-retry` (the sweep re-send)
 *     and `-resend` (an owner's re-send). The operator `COPY:` of an unsubscribable
 *     send is `<template>-operator-copy`.
 *   - Cron digests on the low-level `sendEmail` transport are `digest-<name>`.
 *   - Portal-only `notification.sent` rows are `portal-<kind>[-<event>]`.
 *   - Linear writes are `linear-<subject>-<what>`.
 *   - The Supabase sign-in email, which no app code sends, is `supabase-sign-in`.
 *
 * **What the fields describe is TODAY's behaviour.** `dedupe` and `ledger` record what
 * the code does now, including the gaps the 2026-10-01 inventory found. Change an entry
 * in the same commit that changes the behaviour it describes.
 *
 * **Monitoring alerts are not entries.** The PostHog alerts in
 * `observability/posthog/alerts.json` notify the operator about the system, not a
 * person about an event in the product, so they are listed there and not here.
 *
 * This module is pure data with no imports, so anything can depend on it.
 */

/** Where the notification lands. `email+portal` is one notification on both. Since
 *  AECI-1204 the portal row is written whether or not the email went out, so a muted
 *  seat's vendor still sees it. */
export type NotificationChannel = 'email' | 'portal' | 'email+portal' | 'linear' | 'supabase-email';

/** `external` is a person outside AECi. `operator` is an AECi inbox or the AECi team. */
export type NotificationAudience = 'external' | 'operator';

export type NotificationTriggerKind = 'route' | 'cron' | 'sweep' | 'supabase';

/**
 * Which tiers may deliver it.
 *
 *   - `production-external`: email to an outside person sends from production only.
 *     Every other tier sends to the internal allowlist alone (AECI-1198,
 *     `delivery-policy.ts`).
 *   - `any-tier`: no tier gate of its own. For email this is operator mail, whose
 *     recipients are internal inboxes. For a portal row or a Linear write there is no
 *     outbound message for the gate to act on.
 */
export type NotificationEnvRule = 'production-external' | 'any-tier';

/**
 * A durable record that proves this specific send happened, as of today. An entry lists
 * every one that applies. Every Resend email writes `notification_sends` (AECI-1202),
 * and lists it first. The others are older records the sender also keeps: the invite
 * row, the expiry fence, the attestation `notification.sent` row, the digest's
 * `job_runs` detail.
 */
export type NotificationLedger =
  | 'notification_sends'
  | 'audit_log'
  | 'fence-column'
  | 'invite-row'
  | 'job_runs'
  | 'linear-issue-id'
  | 'none';

/**
 * `nudge-mute` is the per-seat mute of the attestation digest (AECI-1204): a portal
 * toggle and a one-click footer link, stored in `notification_preferences`.
 */
export type NotificationOptOut = 'none' | 'mailing-list-unsubscribe' | 'nudge-mute';

export interface NotificationEntry {
  channel: NotificationChannel;
  audience: NotificationAudience;
  trigger: { kind: NotificationTriggerKind; ref: string };
  envRule: NotificationEnvRule;
  /** Today's mechanism that stops a repeat, in words. */
  dedupe: string;
  /** Every durable record of the send. `['none']` when there is none. */
  ledger: readonly NotificationLedger[];
  optOut: NotificationOptOut;
  /** `docs/<file>.md §<number or heading>`. `registry.spec.ts` resolves it. */
  doc: string;
  summary: string;
  note?: string;
}

/** Per-template subject, layout and copy notes. */
const CATALOGUE = 'docs/email.md §Template content notes';

export const NOTIFICATIONS = {
  // ─── Email: transactional (`sendTransactionalEmail`) ──────────────────────
  'review-submitted': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'POST /api/reviews (routes/reviews.ts)' },
    envRule: 'production-external',
    dedupe: 'None on the send. A partial-unique index blocks a duplicate review.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: 'Tells a reviewer their review is in moderation.',
  },
  'review-submitted-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/reviews (routes/reviews.ts)' },
    envRule: 'any-tier',
    dedupe: 'None.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: 'Tells ADMIN_ALERT_EMAIL a review is waiting for moderation.',
  },
  'review-approved': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/reviews/:id (routes/admin-reviews.ts)' },
    envRule: 'production-external',
    dedupe:
      'Key review-decision:{reviewId}, shared with the other decision email: one decision email per review. A losing concurrent moderation gets 409 REVIEW_ALREADY_MODERATED and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: 'Tells a reviewer their review was approved.',
  },
  'review-rejected': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/reviews/:id (routes/admin-reviews.ts)' },
    envRule: 'production-external',
    dedupe:
      'Key review-decision:{reviewId}, shared with the other decision email: one decision email per review. A losing concurrent moderation gets 409 REVIEW_ALREADY_MODERATED and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: "Tells a reviewer their review needs revision, with the moderator's reason.",
  },
  'account-deleted': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'DELETE /api/account (routes/account.ts)' },
    envRule: 'production-external',
    dedupe: 'None.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: 'Confirms to a user that their account was deleted.',
  },
  'mailing-list-welcome': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'POST /api/subscribe (routes/landing-forms.ts)' },
    envRule: 'production-external',
    dedupe:
      'Not sent to an address that is already active. Key mailing-list-welcome:{recipientHash}:{YYYY-MM} (UTC), so an unsubscribe then resubscribe welcomes once per calendar month.',
    ledger: ['notification_sends'],
    optOut: 'mailing-list-unsubscribe',
    doc: CATALOGUE,
    summary: 'Welcomes a new mailing-list subscriber.',
    note: 'The mailing_list row is a log-class record of the subscription, not of the send.',
  },
  'mailing-list-welcome-operator-copy': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/subscribe (routes/landing-forms.ts)' },
    envRule: 'any-tier',
    dedupe: 'Sent only after mailing-list-welcome was sent, so a duplicate welcome sends no copy.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: 'docs/email.md §Architecture',
    summary: 'Sends the EMAIL_BCC list a COPY: of the welcome, with an inert unsubscribe link.',
    note: 'Not counted in aeci.email.send. A failed copy only warns.',
  },
  'landing-signup': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/subscribe (routes/landing-forms.ts)' },
    envRule: 'any-tier',
    dedupe:
      'Not sent for an address that is already active. Key landing-signup:{recipientHash}:{YYYY-MM} (UTC), keyed on the subscriber.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: 'Tells ADMIN_ALERT_EMAIL someone joined the mailing list.',
  },
  'landing-feedback': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/feedback (routes/landing-forms.ts)' },
    envRule: 'any-tier',
    dedupe: 'None. Every submit sends.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: 'Tells ADMIN_ALERT_EMAIL someone submitted feedback.',
    note: 'The feedback row records the submission, not the send.',
  },
  'claim-submitted-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/requests/claim (routes/requests.ts)' },
    envRule: 'any-tier',
    dedupe:
      'Claims only, not corrections. Key claim-submitted-alert:{requestId}. The only claim alert: the sweep does not re-send it.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: CATALOGUE,
    summary: 'Tells CLAIM_ALERT_EMAIL a vendor claimed a listing, after the Linear attempt.',
    note: 'LINEAR_API_KEY is set on production only. On staging and demo no issue is created, so the Linear row reads "not created, Linear is not configured on this tier" (AECI-1198).',
  },
  'contest-submitted-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/integrations/:id/contests (routes/vendor-contests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'None. Sent only when the contest routes to AECi.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells CLAIM_ALERT_EMAIL a vendor filed a contest that AECi must decide.',
  },
  'claim-approved': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/claims/:id (routes/admin-claims.ts)' },
    envRule: 'production-external',
    dedupe: 'Re-approving an already-seated claim is a no-op and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §9',
    summary: 'Tells a claimant their claim was approved.',
  },
  'claim-rejected': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/claims/:id (routes/admin-claims.ts)' },
    envRule: 'production-external',
    dedupe: 'Status guard: open or in-review claims only.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §9',
    summary: 'Tells a claimant their claim was not approved, without the reviewer reason.',
  },
  'vendor-seat-invite': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/seats/invites (routes/vendor-seat-invites.ts)',
    },
    envRule: 'production-external',
    dedupe: '10 per vendor per day, plus a per-vendor burst bucket.',
    ledger: ['notification_sends', 'invite-row'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.5',
    summary: 'Invites a colleague, typed by a vendor owner, to take a seat.',
  },
  'vendor-seat-invite-resend': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/seats/invites/:id/resend (routes/vendor-seat-invites.ts)',
    },
    envRule: 'production-external',
    dedupe: '5-minute cooldown on last_sent_at, 4 sends per invite on send_count.',
    ledger: ['notification_sends', 'invite-row'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.9',
    summary: 'Re-sends a pending seat invite.',
    note: 'Same template as vendor-seat-invite.',
  },
  'stuck-request-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'sweep',
      ref: '*/15 reconciliation sweep (lib/reconciliation-sweep.ts, lib/admin-alert.ts)',
    },
    envRule: 'any-tier',
    dedupe:
      'Stateless age bands: 60 minutes, 6 hours, then daily (lib/alert-bands.ts). Key stuck-request-alert:{requestId}:{bandIndex}, one pair per row in the digest.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.4',
    summary: 'Tells ADMIN_ALERT_EMAIL which requests are stuck in the Linear pipeline.',
    note: 'LINEAR_API_KEY is set on production only, so every staging and demo request stays unlinked. The sweep skips this email there. The metric and error log still fire (AECI-1198).',
  },
  'stale-claim-ticket-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '25 */6 claim-stale-check (lib/claim-stale-check.ts)' },
    envRule: 'any-tier',
    dedupe:
      'Stateless bands: 24 hours, then daily. Key stale-claim-ticket-alert:{requestId}:{bandIndex}, one pair per row in the digest.',
    ledger: ['notification_sends'],
    optOut: 'none',
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.4a',
    summary: 'Tells FOUNDER_ALERT_EMAIL which claim tickets nobody has started after 24 hours.',
    note: 'Production only in practice. Staging and demo create no Linear issues, and FOUNDER_ALERT_EMAIL is unset on demo.',
  },
  'attestation-digest': {
    channel: 'email+portal',
    audience: 'external',
    trigger: { kind: 'cron', ref: '0 10 attestation sweep (lib/attestation-notify.ts)' },
    envRule: 'production-external',
    dedupe:
      'One per seat per day: attestation-digest:{vendorId}:{profileId}:{YYYY-MM-DD}. Each finding is listed once per 30 days per (claim, detector, vendor), read from the notification.sent rows.',
    ledger: ['notification_sends', 'audit_log'],
    optOut: 'nudge-mute',
    doc: 'docs/STAGE_2_ATTESTATIONS_SPEC.md §7.2',
    summary:
      'Sends each unmuted vendor seat one daily digest of every due attestation finding for its vendor.',
    note: 'Replaced four per-finding templates in AECI-1204. Every due finding gets its portal row, emailed or not; metadata.emailedSeats says how many seats got it. Never lists a vendor finding on a connector-powered edge (AECI-705).',
  },
  'attestation-ops-digest': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '0 10 attestation sweep (lib/attestation-notify.ts)' },
    envRule: 'any-tier',
    dedupe:
      'One per address per day: attestation-ops-digest:{YYYY-MM-DD}:{recipient hash}. Each finding is listed once per 30 days per (claim, detector, ~ops).',
    ledger: ['notification_sends', 'audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_ATTESTATIONS_SPEC.md §7.2',
    summary:
      'Tells ADMIN_ALERT_EMAIL about every denied claim and standing conflict of the day, in one email.',
    note: 'Replaced attestation-ops-alert, one email per finding, in AECI-1204. Its notification.sent rows carry vendorId null, so no vendor portal shows them.',
  },
  'entitlement-expiring': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'cron', ref: '0 11 entitlement-expiry sweep (lib/entitlement-expiry.ts)' },
    envRule: 'production-external',
    dedupe: 'expiry_notice_sent_at fence: one notice per term, 30 days out.',
    ledger: ['notification_sends', 'fence-column'],
    optOut: 'none',
    doc: 'docs/STAGE_2_PAID_TIERS_SPEC.md §7.2',
    summary: "Warns a vendor's seats that their plan term ends soon.",
  },
  'entitlement-expiring-admin': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '0 11 entitlement-expiry sweep (lib/entitlement-expiry.ts)' },
    envRule: 'any-tier',
    dedupe: 'Same fence as entitlement-expiring.',
    ledger: ['notification_sends', 'fence-column'],
    optOut: 'none',
    doc: 'docs/STAGE_2_PAID_TIERS_SPEC.md §7.2',
    summary: 'Tells ADMIN_ALERT_EMAIL a vendor term ends soon, with payer and invoice ref.',
  },

  // ─── Email: cron digests (`sendEmail`) ────────────────────────────────────
  'digest-data-quality': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '0 4 data-quality job (scheduled.ts runDataQualityJob)' },
    envRule: 'any-tier',
    dedupe: 'None. Sends on a clean run too, so silence means the cron failed.',
    ledger: ['notification_sends', 'job_runs'],
    optOut: 'none',
    doc: 'docs/email.md §Cron digests',
    summary: 'Sends DATA_QUALITY_EMAIL_TO the daily data-quality check results.',
    note: 'DATA_QUALITY_EMAIL_TO is set on staging, demo and production, so the support inbox gets one a day from each.',
  },
  'digest-analytics': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '0 5 analytics digest (scheduled.ts runAnalyticsDigestJob)' },
    envRule: 'any-tier',
    dedupe: 'None.',
    ledger: ['notification_sends', 'job_runs'],
    optOut: 'none',
    doc: 'docs/email.md §Cron digests',
    summary: "Sends ANALYTICS_DIGEST_EMAIL_TO the prior day's traffic digest.",
    note: 'ANALYTICS_DIGEST_EMAIL_TO is set on production only.',
  },

  // ─── Supabase Auth email ──────────────────────────────────────────────────
  'supabase-sign-in': {
    channel: 'supabase-email',
    audience: 'external',
    trigger: {
      kind: 'supabase',
      ref: 'signInWithOtp (apps/web/src/app/auth/auth.service.ts)',
    },
    envRule: 'any-tier',
    dedupe: "GoTrue's own rate limits.",
    ledger: ['none'],
    optOut: 'none',
    doc: 'docs/email.md §Magic-link sender',
    summary: 'The magic-link or confirm-signup email for anyone who signs in.',
    note: 'Supabase sends it over the Resend SMTP relay. No app code sends it, so the tier gate cannot stop it.',
  },

  // ─── Vendor portal feed (`notification.sent` rows, no email) ──────────────
  'portal-contest-submitted': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/integrations/:id/contests (routes/vendor-contests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per transition, in the transition batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the owner a vendor contested a field on its integration.',
  },
  'portal-contest-withdrawn': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/withdraw (routes/vendor-contests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per transition, in the transition batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the owner a contest on its integration was withdrawn.',
  },
  'portal-contest-decided-by-owner': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/decision (routes/vendor-contests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per transition, in the transition batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the submitter the owner accepted or declined its contest.',
    note: 'A decline carries the 30-day protest deadline, which reaches the vendor only here.',
  },
  'portal-contest-decided-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/contests/:id (routes/admin-contests.ts)' },
    envRule: 'any-tier',
    dedupe: 'One row per transition, in the transition batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the submitter AECi accepted or declined its contest.',
  },
  'portal-contest-closed-by-retire': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/{vendor,admin}/integrations/:id/retire (routes/integration-retire-write.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per closed contest, in the retire batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the other side of an open contest that a retire closed it.',
  },
  'portal-contest-protested': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/protest (routes/vendor-contest-protests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per protest step, in the step batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells the owner a submitter asked AECi to review a contest.',
    note: 'Carries the 14-day reply deadline, which reaches the owner only here.',
  },
  'portal-contest-protest-replied': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/protest/reply (routes/vendor-contest-protests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per protest step, in the step batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells the submitter the owner replied to its protest.',
  },
  'portal-contest-protest-withdrawn': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/protest/withdraw (routes/vendor-contest-protests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per protest step, in the step batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells the owner a protest on its integration was withdrawn.',
  },
  'portal-contest-protest-decided': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/contests/:id/protest (routes/admin-contest-protests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per side, in the decision batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells both vendors whether AECi upheld or rejected a protest.',
  },
  'portal-integration-claim': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/integrations/:id/claim (routes/vendor-integration-claims.ts); owner accept in routes/admin-contests.ts',
    },
    envRule: 'any-tier',
    dedupe: 'One row per recipient, in the claim batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.5',
    summary: 'Tells the other endpoint vendors that a vendor now owns an integration.',
  },
  'portal-integration-retire': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/{vendor,admin}/integrations/:id/{retire,restore} (routes/integration-retire-write.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per recipient, in the write batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.6',
    summary: 'Tells the endpoint vendors an integration was retired or restored.',
  },
  'portal-integration-update': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/vendor/integrations/:id (routes/vendor-integration-edits.ts, routes/vendor-evidenced-pair-edits.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per recipient, in the edit batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.5.6',
    summary: 'Tells the other endpoint vendors the owner edited an integration.',
  },
  'portal-integration-create': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/integrations (routes/vendor-integration-create.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per recipient, in the create batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.7',
    summary: 'Tells the other endpoint vendors a vendor created an integration on their product.',
  },
  'portal-claim-added': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PUT /api/vendor/claims/:claimId/attestation (routes/vendor-attestations.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per recipient, in the attestation batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    doc: 'docs/STAGE_2_ATTESTATIONS_SPEC.md §7.6',
    summary: 'Tells a vendor another vendor added a data row to an integration on its product.',
  },

  // ─── Linear (Linear then notifies its own subscribers) ────────────────────
  'linear-request-issue': {
    channel: 'linear',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/requests/{claim,correction} (routes/requests.ts); retried by lib/reconciliation-sweep.ts',
    },
    envRule: 'any-tier',
    dedupe: 'Read-guard on the linked issue id, then a compare-and-set persist.',
    ledger: ['linear-issue-id'],
    optOut: 'none',
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.1',
    summary: 'Files a Linear issue for a vendor claim or correction.',
    note: 'LINEAR_API_KEY is set on production only, so staging and demo file no issues.',
  },
  'linear-request-duplicate-comment': {
    channel: 'linear',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/requests/{claim,correction} (routes/requests.ts)' },
    envRule: 'any-tier',
    dedupe: 'Once per issue create.',
    ledger: ['none'],
    optOut: 'none',
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §7.2',
    summary: 'Comments on a new request issue that it may duplicate an open request.',
    note: 'Production only: it needs the issue that linear-request-issue creates.',
  },
  'linear-contest-issue': {
    channel: 'linear',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/contests/:id accept (routes/admin-contests.ts); retried by lib/reconciliation-sweep.ts',
    },
    envRule: 'any-tier',
    dedupe: 'Read-guard on the linked issue id, then a compare-and-set persist.',
    ledger: ['linear-issue-id'],
    optOut: 'none',
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.6',
    summary: 'Files the REVIEW - issue that carries an accepted contest to the review lane.',
    note: 'LINEAR_API_KEY is set on production only, so staging and demo file no issues.',
  },
  'linear-request-resolution': {
    channel: 'linear',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/requests/:id (routes/admin-requests.ts)' },
    envRule: 'any-tier',
    dedupe: 'None. Each resolve or reject pushes once.',
    ledger: ['none'],
    optOut: 'none',
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.5',
    summary: "Moves a request's Linear issue to Done or Canceled and comments the reason.",
    note: 'The site-linear-sync workflow_transitions row records the sync, not a send. Production only: other tiers have no linked issue to move.',
  },
} as const satisfies Record<string, NotificationEntry>;

export type NotificationRegistry = typeof NOTIFICATIONS;

/** Every registry id. */
export type NotificationId = keyof NotificationRegistry;

/** The ids whose channel is one of `C`. */
export type NotificationIdFor<C extends NotificationChannel> = {
  [K in NotificationId]: NotificationRegistry[K]['channel'] extends C ? K : never;
}[NotificationId];

/** Every id that sends a Resend email, through either transport. */
export type EmailNotificationId = NotificationIdFor<'email' | 'email+portal'>;

/** The cron digests: the ids the low-level `sendEmail` transport takes. */
export type DigestNotificationId = Extract<EmailNotificationId, `digest-${string}`>;

/** The ids `sendTransactionalEmail` takes. `EmailTemplate` in `lib/email.ts` aliases it. */
export type TransactionalEmailId = Exclude<EmailNotificationId, DigestNotificationId>;

/** The attestation sweep's ids: its `notification.sent` ledger rows name one of these. */
export type AttestationNotificationId = Extract<EmailNotificationId, `attestation-${string}`>;

/** Portal-only `notification.sent` rows. */
export type PortalNotificationId = NotificationIdFor<'portal'>;

/** The contest and protest events of the portal feed. */
export type ContestPortalNotificationId = Extract<PortalNotificationId, `portal-contest-${string}`>;

/** Linear writes that notify the AECi team. */
export type LinearNotificationId = NotificationIdFor<'linear'>;

/** The entry for an id. */
export function getNotification<Id extends NotificationId>(id: Id): NotificationRegistry[Id] {
  return NOTIFICATIONS[id];
}
