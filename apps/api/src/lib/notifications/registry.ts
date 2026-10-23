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
 *     different trigger get their own id with a suffix, for example `-resend` (an
 *     owner's re-send). The exception is a second trigger that shares the first one's
 *     dedupe key, so that at most one of the two ever sends: it keeps the same id.
 *     `claim-submitted-alert` is the one case (the submit and the reconcile sweep). The operator `COPY:` of an unsubscribable
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
 *  AECI-1204 the portal row is written when a seat was emailed or every seat muted or
 *  was refused by the tier policy, so a muted seat's vendor still sees it. A failed or
 *  unconfigured send writes no row, so the next sweep retries it. */
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
 *   - `production-only`: operator email that sends from production alone, to anyone
 *     (AECI-1220). Every other tier suppresses it whatever the recipient, because its
 *     content is only true of production: real traffic, real catalog data, real
 *     vendors waiting. It replaced unsetting a recipient var per tier, once one
 *     `SUPPORT_EMAIL` named the support inbox on every tier.
 *   - `production-and-demo`: the same, but demo sends too (AECI-1220). Demo is the
 *     rehearsal tier with a promoted catalog worth checking. Staging and every other
 *     tier suppress it.
 *   - `any-tier`: no tier gate of its own. For email this is operator mail, whose
 *     recipients are internal inboxes. For a portal row or a Linear write there is no
 *     outbound message for the gate to act on.
 */
export type NotificationEnvRule =
  | 'production-external'
  | 'production-only'
  | 'production-and-demo'
  | 'any-tier';

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
  /**
   * Whether an operator may pause it on one tier from `/admin/email` (AECI-1224,
   * `lib/notifications/switches.ts`). Only an entry sent through `lib/email.ts` (`email`,
   * `email+portal`) may be `true`; `registry.spec.ts` enforces it. Anything security- or
   * obligation-bearing stays `false`. The entry's `note` says why, either way.
   */
  pausable: boolean;
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
    pausable: true,
    doc: CATALOGUE,
    summary: 'Tells a reviewer their review is in moderation.',
    note: 'Pausable: a courtesy receipt. No action or deadline depends on it.',
  },
  'review-submitted-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/reviews (routes/reviews.ts)' },
    envRule: 'any-tier',
    dedupe: 'None.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: CATALOGUE,
    summary: 'Tells SUPPORT_EMAIL a review is waiting for moderation.',
    note: 'Pausable: operator alert. The review waits in /admin/reviews either way.',
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
    pausable: false,
    doc: CATALOGUE,
    summary: 'Tells a reviewer their review was approved.',
    note: 'Always on: a review decision to its author.',
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
    pausable: false,
    doc: CATALOGUE,
    summary: "Tells a reviewer their review needs revision, with the moderator's reason.",
    note: 'Always on: a review decision to its author, with the reason they need to revise.',
  },
  'vendor-review-published': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/reviews/:id (routes/admin-reviews.ts)' },
    envRule: 'production-external',
    dedupe:
      'Key vendor-review-published:{reviewId}:{profileId}, one per seat. A losing concurrent moderation gets 409 REVIEW_ALREADY_MODERATED and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11c.12',
    summary:
      'Tells every unbanned seat of each owning vendor that a review of its product was approved.',
    note: 'Sent beside the portal-review row, on every plan. The attestation nudge mute does not cover it. Always on until ruled: it reached main after AECI-1224 set the pausable list.',
  },
  'account-deleted': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'DELETE /api/account (routes/account.ts)' },
    envRule: 'production-external',
    dedupe: 'None.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: CATALOGUE,
    summary: 'Confirms to a user that their account was deleted.',
    note: 'Always on: confirms an erasure, a legal obligation.',
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
    pausable: true,
    doc: CATALOGUE,
    summary: 'Welcomes a new mailing-list subscriber.',
    note: 'The mailing_list row is a log-class record of the subscription, not of the send. Pausable: a welcome. No obligation rides on it.',
  },
  'mailing-list-welcome-operator-copy': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/subscribe (routes/landing-forms.ts)' },
    envRule: 'any-tier',
    dedupe: 'Sent only after mailing-list-welcome was sent, so a duplicate welcome sends no copy.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/email.md §Architecture',
    summary: 'Sends the EMAIL_BCC list a COPY: of the welcome, with an inert unsubscribe link.',
    note: 'Not counted in aeci.email.send. A failed copy only warns. Always on as an entry: the support-copy switch is its control, not a switch of its own.',
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
    pausable: true,
    doc: CATALOGUE,
    summary: 'Tells SUPPORT_EMAIL someone joined the mailing list.',
    note: 'Pausable: operator alert. /admin/audience lists the subscriber either way.',
  },
  'landing-feedback': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/feedback (routes/landing-forms.ts)' },
    envRule: 'any-tier',
    dedupe: 'None. Every submit sends.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: CATALOGUE,
    summary: 'Tells SUPPORT_EMAIL someone submitted feedback.',
    note: 'The feedback row records the submission, not the send. Pausable: operator alert. /admin/audience lists the feedback either way.',
  },
  'claim-submitted-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/requests/confirm (routes/request-confirmations.ts) or POST /api/requests/claim on the signed-in path (routes/requests.ts); and the */15 request-reconcile sweep (lib/reconciliation-sweep.ts) when its retry creates the issue',
    },
    envRule: 'any-tier',
    dedupe:
      'Claims only, not corrections. Both senders use key claim-submitted-alert:{requestId}, so at most one alert per request. A delivered or unknown submit alert holds the key and the sweep send is a duplicate. A submit alert Resend refused released it, so the sweep send goes out with the issue link.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: CATALOGUE,
    summary: 'Tells SUPPORT_EMAIL a vendor claimed a listing, after the Linear attempt.',
    note: 'LINEAR_API_KEY is set on production only. On staging and demo no issue is created, so the Linear row reads "not created, Linear is not configured on this tier" (AECI-1198). When every product of the claimed vendor is a connector, the body adds "Connector vendor: contact them directly", the same flag as the /admin/claims row (AECI-1367). When the claim was routed to the company\'s owners, the body adds "Sent to the owners at <Company>; AECi steps in on <date>" (AECI-1366). When the submit-time account check stored the claim rejected, the body adds "Rejected automatically: the address already holds a seat on <Company>", or the staff-account wording, and the Linear row says no issue is created (AECI-1420). Pausable: operator alert. The claim waits in /admin/claims either way.',
  },
  'claim-confirm': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/requests/claim (routes/requests.ts) and POST /api/requests/listing (routes/listing-requests.ts), on an anonymous submit or one whose session email is not the typed address',
    },
    envRule: 'production-external',
    dedupe:
      'Key claim-confirm:{pendingId}, so one mail per submit. Plus at most 3 per address per UTC day, counted from notification_sends by recipient hash; over the bound the send is a duplicate row and nothing goes.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/VENDOR_PROGRAM_PAGE_SPEC.md §15.3',
    summary:
      'Asks the typed address to confirm a claim or listing request before it is sent, with a 7-day single-use link to /claims/confirm.',
    note: 'AECI-1435, ADR 0043. Nothing reaches AECi until the link is clicked and the page button pressed. Never blind-copied to the operator list, because the copy would be a second working link. Always on: without it no anonymous claim can be sent at all. A signed-in claimant whose verified email is the typed address skips it.',
  },
  'claim-received': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/requests/confirm (routes/request-confirmations.ts), and POST /api/requests/claim or /listing when the signed-in email is the typed address',
    },
    envRule: 'production-external',
    dedupe:
      'Key claim-received:{recipientHash}:{YYYY-MM-DD}: at most one receipt per address per UTC day, across claims and listing requests. A request has one address and sends once post-commit, so the key is also the per-request bound.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/VENDOR_PROGRAM_PAGE_SPEC.md §15.3',
    summary:
      'Tells the person who sent a claim or a typed-in listing request that we have it, what they claimed, and what happens next.',
    note: "Sent after the operator alert, in the same waitUntil, once the request is in: at confirm for an anonymous visitor (AECI-1435), at submit for a signed-in one whose verified email is the typed address. No link that grants anything: it links the vendor terms they accepted and the help page. Routed variant (AECI-1368) when the company has an owner seat: their team has been asked to confirm the claimant and AECi steps in after 7 days. Always on: it is the claimant's record that they accepted the vendor terms, and the only notice that a claim was sent in their name. The address is typed, not verified, so the daily key bounds what a stranger can make us send to it.",
  },
  'listing-request-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/requests/confirm (routes/request-confirmations.ts) or POST /api/requests/listing on the signed-in path (routes/listing-requests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'Key listing-request-alert:{requestId}, so at most one alert per saved request.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/VENDOR_PROGRAM_PAGE_SPEC.md §15.4',
    summary:
      'Tells SUPPORT_EMAIL a visitor typed in a product or company we do not list, from the claim dialog, with reply-to set to them.',
    note: 'The visitor gets claim-received, bounded per address per day (AECI-1366). Pausable: operator alert. The request waits in /admin/requests either way.',
  },
  'product-request-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/product-requests (routes/vendor-product-requests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'Key product-request-alert:{requestId}, so at most one alert per saved request.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.7.6',
    summary:
      'Tells SUPPORT_EMAIL a seated vendor asked us to add a product it integrates with, with reply-to set to the seat.',
    note: 'Pausable: an operator alert. The request waits in /admin/requests either way.',
  },
  'product-request-decided': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/product-requests/:id (routes/admin-product-requests.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'Key product-request-decided:{requestId}. A request is decided once, so one email per request. A lost concurrent decision rolls back and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.7.6',
    summary:
      'Tells the seat that asked whether AECi added the product, found it already listed, or declined it with the reason.',
    note: 'Always on: a decision, like claim-rejected and the review decisions. One template with three outcome variants. Not sent when the seat is gone, and the portal row is then the record.',
  },
  // AECI-1373 (E4.4): an owner seat asks AECi to take a license off its product early.
  'license-release-request-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/licenses/:id/release-request (routes/vendor-license-release.ts)',
    },
    envRule: 'any-tier',
    dedupe:
      'Key license-release-request-alert:{requestId}, so at most one alert per saved request.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/ADMIN_PANEL_SPEC.md §5.17',
    summary:
      'Tells SUPPORT_EMAIL an owner seat asked to free a license early, with the reason and reply-to set to the seat.',
    note: 'Pausable: an operator alert. The request waits in /admin/requests either way.',
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
    pausable: true,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells SUPPORT_EMAIL a vendor filed a contest that AECi must decide.',
    note: 'Pausable: operator alert. The contest waits in /admin/contests either way.',
  },
  'protest-submitted-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/protest (routes/vendor-contest-protests.ts)',
    },
    envRule: 'any-tier',
    dedupe:
      'Key protest-submitted-alert:{contestId}:{protestedAt}. A replay of the same protest is a duplicate. A later protest on the same contest is a new send.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells SUPPORT_EMAIL a vendor filed a protest that AECi must decide.',
    note: 'Pausable: operator alert. The protest waits in /admin/contests either way.',
  },
  'contest-protest-opened': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/protest (routes/vendor-contest-protests.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'One per seat per protest: key contest-protest-opened:{contestId}:{protestedAt}:{profileId}.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary:
      "Tells the owner's seats a submitter asked AECi to review a contest, with the 14-day reply deadline.",
    note: 'Sent beside the portal-contest-protested row. The attestation nudge mute does not cover it: missing it costs the owner its reply. Always on: carries the 14-day reply deadline.',
  },
  'contest-protest-reply-reminder': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'cron',
      ref: '0 12 protest reply reminder (lib/contest-protest-emails.ts runProtestReplyReminderSweep)',
    },
    envRule: 'production-external',
    dedupe:
      'One per seat per protest: key contest-protest-reply-reminder:{contestId}:{protestedAt}:{profileId}. The daily runs inside the 3-day window send it once.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary:
      "Reminds the owner's seats, 2 to 3 days before the deadline, that they have not replied to a protest.",
    note: 'Skips a protest that has a reply, is no longer open, or is past its deadline. Always on: warns of the reply deadline.',
  },
  'contest-declined-protest-window': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/vendor/contests/:id/decision (routes/vendor-contests.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'One per seat per contest: key contest-declined-protest-window:{contestId}:{profileId}. A contest is declined once.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary:
      "Tells the submitter's seats the owner declined its contest, and until when it can ask AECi to review it.",
    note: 'Owner declines only. An AECi decline cannot be protested and sends nothing. Always on: carries the 30-day protest deadline.',
  },
  'claim-approved': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/claims/:id (routes/admin-claims.ts)' },
    envRule: 'production-external',
    dedupe: 'Re-approving an already-seated claim is a no-op and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §9',
    summary: 'Tells a claimant their claim was approved.',
    note: 'One variant since AECI-1367: every approval lands on Free. It names the vendor and has three blocks: sign in (the button is the sign-in page, never a one-time link; an invited claimant is told the account exists; since AECI-1437 a line says the portal is in the account menu, top left on a phone, or at /vendor), what Free includes, and how Managed works (licenses on the billing account, one per product, bought later from Billing; no price). It ends with one link to /vendor-program, the public vendor page (AECI-1283). Always on: a claim decision, and the first the vendor hears of its seat.',
  },
  'claim-rejected': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/claims/:id (routes/admin-claims.ts), POST /api/vendor/seats/claims/:id/decline and the POST /api/vendor/seats/claims/:id/accept auto-reject (routes/vendor-seat-claims.ts), and the claim auto-reject at POST /api/requests/confirm or the signed-in POST /api/requests/claim (routes/requests.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'Status guard: open or in-review claims only. The submit-time auto-reject adds the key claim-rejected-auto:{recipientHash}:{YYYY-MM-DD}, at most one per address per UTC day, because the address is typed on an anonymous form.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §9',
    summary: 'Tells a claimant their claim was not approved, without the reviewer reason.',
    note: "Reasoned variant (AECI-1420): when the system declines a claim because the address already holds a seat on another company, at submit or on an owner's Accept, the email names that company and says to send the request from a different work address. A staff account is told it cannot hold a vendor seat. The subject is the same. A hand decision by AECi or an owner gets the plain variant, which never carries the reviewer's reason. Sent instead of claim-received at submit. Always on: a claim decision.",
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.5',
    summary: 'Invites a colleague, typed by a vendor owner, to take a seat.',
    note: 'Always on: an invite is the only way the colleague can take the seat.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.9',
    summary: 'Re-sends a pending seat invite.',
    note: 'Same template as vendor-seat-invite. Always on: an owner asked for it again.',
  },
  'claim-owner-review': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/requests/confirm (routes/request-confirmations.ts) or the signed-in POST /api/requests/claim (routes/requests.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'One per owner seat per claim: key claim-owner-review:{requestId}:{profileId}. Per vendor per UTC day, only the first 5 routed claims send it (OWNER_REVIEW_DAILY_LIMIT, a D1 count of routed_to_owners_at); later claims still route and still list in Seats.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.10',
    summary:
      "Asks each unbanned owner seat of a company to accept or decline someone who claimed it, with the claimant's details and the 7-day deadline.",
    note: 'Sent only when the claimed company has an unbanned owner seat, after the claim insert commits. Addresses come from the GoTrue by-id seam (loadVendorOwnerRecipients). The claim route is anonymous, so the daily per-vendor bound caps what a stranger can make us send to a company. Always on: the owners have 7 days to decide, and pausing it would hand every claim to the fallback.',
  },
  'product-proposal-owner-review': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/promote, post-commit hook (routes/promote.ts dispatchPromoteHooks, lib/product-proposal-notify.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'One per owner seat per proposal: key product-proposal-owner-review:{proposalId}:{profileId}. A replayed promote hook finds the key and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §6.22',
    summary:
      'Tells each unbanned owner seat of a company that owns its record that AEC Integrations proposed a new product for it, to accept or decline.',
    note: 'Sent once the promote batch that stored the proposal commits, never on the request. Addresses come from the GoTrue by-id seam (loadVendorOwnerRecipients). Pausable: no deadline rides on it, and the proposal waits on the Proposed products tab whether or not the mail goes.',
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
    pausable: true,
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.4',
    summary: 'Tells SUPPORT_EMAIL which requests are stuck in the Linear pipeline.',
    note: 'LINEAR_API_KEY is set on production only, so every staging and demo request stays unlinked. The sweep skips this email there. The metric and error log still fire (AECI-1198). Pausable: operator alert. The metric and error log still fire.',
  },
  'stale-claim-ticket-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '25 */6 claim-stale-check (lib/claim-stale-check.ts)' },
    envRule: 'production-only',
    dedupe:
      'Stateless bands: 24 hours, then daily. Key stale-claim-ticket-alert:{requestId}:{bandIndex}, one pair per row in the digest.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.4a',
    summary: 'Tells SUPPORT_EMAIL which claim tickets nobody has started after 24 hours.',
    note: 'Production only since AECI-1220. Staging and demo create no Linear issues, so a stale ticket there is a rehearsal row. Before AECI-1220 it went to founders@. Pausable: operator alert.',
  },
  'claim-owner-fallback-alert': {
    channel: 'email',
    audience: 'operator',
    trigger: {
      kind: 'cron',
      ref: '0 14 claim owner fallback (lib/claim-owner-fallback.ts runClaimOwnerFallback)',
    },
    envRule: 'any-tier',
    dedupe:
      'One digest per run, keyed claim-owner-fallback-alert:{sorted requestIds}, so each claim is named once. The run moves the claims out of the routed state in the same batch as their audit rows, so a second run reads nothing and sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11a.10',
    summary:
      "Tells SUPPORT_EMAIL which claims the company's owners left undecided for 7 days, now in the claim queue for AECi.",
    note: 'Sent after the batch commits, so a failed send does not put the claims back with the owners. Pausable: operator digest. The claims wait in /admin/claims either way, and claim-stale-check counts them again.',
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
    pausable: true,
    doc: 'docs/STAGE_2_ATTESTATIONS_SPEC.md §7.2',
    summary:
      'Sends each unmuted vendor seat one daily digest of every due attestation finding for its vendor.',
    note: 'Replaced four per-finding templates in AECI-1204. A due finding gets its portal row when a seat was emailed or every seat was muted or refused by the tier policy. A failed or unconfigured send writes no row, so the next sweep retries it. metadata.emailedSeats says how many seats got it. Never lists a vendor finding on a connector-powered edge (AECI-705). Pausable: a nudge. A pause behaves like a mute: the portal row is still written.',
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
    pausable: true,
    doc: 'docs/STAGE_2_ATTESTATIONS_SPEC.md §7.2',
    summary:
      'Tells SUPPORT_EMAIL about every denied claim and standing conflict of the day, in one email.',
    note: 'Replaced attestation-ops-alert, one email per finding, in AECI-1204. Its notification.sent rows carry vendorId null, so no vendor portal shows them. Pausable: operator digest. The notification.sent rows are still written.',
  },
  'entitlement-expiring': {
    channel: 'email',
    audience: 'external',
    trigger: { kind: 'cron', ref: '0 11 entitlement-expiry sweep (lib/entitlement-expiry.ts)' },
    envRule: 'production-external',
    dedupe:
      'licenses.expiry_notice_sent_at fence: one notice per billing account and end date, 30 days out.',
    ledger: ['notification_sends', 'fence-column'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_PAID_TIERS_SPEC.md §7.2',
    summary:
      "The 30-day notice to a vendor's seats and its billing email: the end date, the license count and products, the list price (left out for an invoice term), any new Managed plan agreement version, and how to opt out or reduce.",
    note: "Always on: warns of the end of a vendor's license term, paid or pilot. Recipients are deduped per address (VENDOR_SIGNUP_PROCESS.md decision 16).",
  },
  'entitlement-expiring-admin': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '0 11 entitlement-expiry sweep (lib/entitlement-expiry.ts)' },
    envRule: 'any-tier',
    dedupe: 'Same fence as entitlement-expiring.',
    ledger: ['notification_sends', 'fence-column'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/STAGE_2_PAID_TIERS_SPEC.md §7.2',
    summary:
      'Tells SUPPORT_EMAIL a vendor term ends soon, with the license count, source and reference.',
    note: 'Pausable: operator alert. The vendor notice alone stamps the fence.',
  },
  'licenses-granted': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/admin/vendors/:id/licenses (routes/admin-licenses.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'Key licenses-granted:{grantId}:{recipient hash}, so one email per address per grant. A replayed grant sends nothing.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/VENDOR_SIGNUP_PROCESS.md §3',
    summary:
      "Tells a vendor's seats and its billing email that AECi granted it N complimentary or invoice Managed licenses, with the end date.",
    note: 'Always on: the vendor learns of its licenses and their end date only here. Wording keyed by source. Stripe wording waits for E9.',
  },
  // AECI-1371 (E4.2). The E6 term-end lapse (AECI-1404) reuses the sender. Its dedupe
  // key differs, but a license ends once, so at most one of the two ever sends about it.
  'managed-ended': {
    channel: 'email',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/licenses/:id action revoke (routes/admin-licenses.ts); and the 0 11 entitlement-expiry cron, its term-end lapse pre-step (lib/license-lapse.ts)',
    },
    envRule: 'production-external',
    dedupe:
      'Revoke: key managed-ended:{licenseId}:{recipient hash}, one email per address per ended license. Lapse: key managed-ended:term:{billingAccountId}:{endsAt}:{cause}:{recipient hash}, one email per address per term and cause.',
    ledger: ['notification_sends'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/VENDOR_SIGNUP_PROCESS.md §3',
    summary:
      "Tells a vendor's seats and its billing email that Managed has ended for one or more products, why, and that their content stays live.",
    note: 'Sent only when an ended license was on a product: an unassigned license changes no plan. A revoke carries the vendor-visible reason. A lapse sends one email per term for the products that lapsed, and a separate one for the products released at renewal. Always on: the vendor learns its product left Managed only here and in portal messages.',
  },

  // ─── Email: cron digests (`sendEmail`) ────────────────────────────────────
  'digest-data-quality': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '0 4 data-quality job (scheduled.ts runDataQualityJob)' },
    envRule: 'production-and-demo',
    dedupe: 'None. Sends on a clean run too, so silence means the cron failed.',
    ledger: ['notification_sends', 'job_runs'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/email.md §Cron digests',
    summary: 'Sends SUPPORT_EMAIL the daily data-quality check results.',
    note: 'Production and demo only since AECI-1220. Before it, staging also sent one a day about synthetic data. Pausable: operator digest. job_runs still records each run, so liveness does not depend on the mail.',
  },
  'digest-analytics': {
    channel: 'email',
    audience: 'operator',
    trigger: { kind: 'cron', ref: '0 5 analytics digest (scheduled.ts runAnalyticsDigestJob)' },
    envRule: 'production-only',
    dedupe: 'None.',
    ledger: ['notification_sends', 'job_runs'],
    optOut: 'none',
    pausable: true,
    doc: 'docs/email.md §Cron digests',
    summary: "Sends SUPPORT_EMAIL the prior day's traffic digest.",
    note: 'Production only: only production traffic is real. Pausable: operator digest. /admin/overview shows the same numbers.',
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
    pausable: false,
    doc: 'docs/email.md §Magic-link sender',
    summary: 'The magic-link or confirm-signup email for anyone who signs in.',
    note: 'Supabase sends it over the Resend SMTP relay. No app code sends it, so the tier gate cannot stop it. It carries no Resend tags. Since AECI-1222 production records its delivery events (tier auth) in notification_delivery_events, matched by subject and sender; no tier records the send itself. Not pausable: Supabase sends it, so no switch here can stop it.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the owner a vendor contested a field on its integration.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the owner a contest on its integration was withdrawn.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the submitter the owner accepted or declined its contest.',
    note: 'A decline carries the 30-day protest deadline. Since AECI-1205 the contest-declined-protest-window email carries it too. Not pausable: a portal row, not email.',
  },
  'portal-contest-decided-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/contests/:id (routes/admin-contests.ts)' },
    envRule: 'any-tier',
    dedupe: 'One row per transition, in the transition batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the submitter AECi accepted or declined its contest.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.8',
    summary: 'Tells the other side of an open contest that a retire closed it.',
    note: 'Not pausable: a portal row, not email.',
  },
  'portal-contest-closed-by-move': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/promote → PromoteWorkflow (routes/promote-contests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per closed contest, in the promote batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.9',
    summary:
      'Tells the submitter a promote moved the edge to a connector and closed its open mechanism_kind contest.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells the owner a submitter asked AECi to review a contest.',
    note: 'Carries the 14-day reply deadline. Since AECI-1205 the contest-protest-opened email carries it too. Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells the submitter the owner replied to its protest.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells the owner a protest on its integration was withdrawn.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.12.10',
    summary: 'Tells both vendors whether AECi upheld or rejected a protest.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.5',
    summary: 'Tells the other endpoint vendors that a vendor now owns an integration.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.6',
    summary: 'Tells the endpoint vendors an integration was retired or restored.',
    note: "On an AECi retire or restore the owner is told too, and since AECI-1159 the owner's row carries AECi's vendor-visible reason. Endpoint vendors' rows stay generic. Not pausable: a portal row, not email.",
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.5.6',
    summary: 'Tells the other endpoint vendors the owner edited an integration.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.7',
    summary: 'Tells the other endpoint vendors a vendor created an integration on their product.',
    note: 'Not pausable: a portal row, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_ATTESTATIONS_SPEC.md §7.6',
    summary: 'Tells a vendor another vendor added a data row to an integration on its product.',
    note: 'Not pausable: a portal row, not email.',
  },
  'portal-review': {
    channel: 'portal',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/reviews/:id (routes/admin-reviews.ts)' },
    envRule: 'any-tier',
    dedupe: 'One row per owning vendor, in the approve batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11c.12',
    summary: 'Tells each owning vendor that a review of its product was approved.',
    note: 'Written for a vendor with no seat too, so the feed is complete once it is seated. A reject writes none. Not pausable: a portal row, not email.',
  },
  'portal-review-response': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/review-responses/:id (routes/admin-review-responses.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per decision, in the decision batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11c.12',
    summary: 'Tells a vendor that AECi approved, rejected or removed its reply to a review.',
    note: 'metadata.event names the decision. Reject and remove carry the reason. No email, as for contests. Not pausable: a portal row, not email.',
  },
  'portal-product-request-decided': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/product-requests/:id (routes/admin-product-requests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per decision, in the decision batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4.7.6',
    summary:
      'Tells a vendor that AECi added, found already listed, or declined a product it asked us to add.',
    note: 'Goes to the requesting vendor on every plan. Carries the decline reason, never an internal note. Not pausable: a portal row, not email.',
  },
  'portal-field-overridden-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/contests/:id (routes/admin-contests.ts)' },
    envRule: 'any-tier',
    dedupe: 'One row per decision, in the decision batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11d',
    summary:
      "Tells an integration's owner that AECi accepted a contest that changed a field it holds, and why. On an Owner accept it tells the old owner it no longer holds the integration.",
    note: 'Sent only when the accept overwrites a value the owner holds, to an owner that is not the submitter. Every plan, no tier rule. Carries the reason, never the internal note. Not pausable: a portal row, not email.',
  },
  'portal-logo-overridden-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/{vendors,products}/:id/logo (routes/logos.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per overwrite, in the write batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11d',
    summary:
      'Tells a vendor that AECi replaced or removed its company logo or a product logo, and why.',
    note: "Goes to the vendor itself, or to the product's holding vendor. None when no vendor holds the record. Every plan, no tier rule. Carries the reason, never the internal note. Not pausable: a portal row, not email.",
  },
  'portal-seat-revoked-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'DELETE /api/admin/vendors/:id/seats/:userId (routes/admin-vendors.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per revoke, in the revoke batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11d',
    summary: "Tells a vendor's remaining seats that AECi removed one of its seats, and why.",
    note: 'Not written when the revoke leaves no seat: nobody could read it, and the audit row is the record. Every plan, no tier rule. Carries the reason, never the internal note. Not pausable: a portal row, not email.',
  },
  'portal-field-corrected-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/admin/field-overrides (routes/admin-field-overrides.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per correction, in the correction batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11d.5',
    summary:
      'Tells a vendor that AECi corrected a field on a record it holds and locked it, with the new value and why.',
    note: 'Goes to the vendor holding the record when the lock was set. None when no vendor holds it, which the route refuses anyway. Every plan, no tier rule. Carries the reason, never the internal note. On a product taxonomy facet (AECI-1382) the value is the term names joined by commas, and no value when AECi removed every term. Not pausable: a portal row, not email.',
  },
  'portal-field-lock-lifted-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'POST /api/admin/field-overrides/:id/lift (routes/admin-field-overrides.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per lift, in the lift batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11d.5',
    summary:
      'Tells a vendor that AECi lifted a field lock, so it can edit the field again, and why.',
    note: 'Goes to the vendor named on the lock when it was set. Every plan, no tier rule. Carries the lift reason, never the internal note. Not pausable: a portal row, not email.',
  },
  // AECI-1371 (E4.2): the admin license revoke.
  'portal-license-revoked-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/licenses/:id action revoke (routes/admin-licenses.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per revoke, in the revoke batch.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/VENDOR_SIGNUP_PROCESS.md §3',
    summary:
      'Tells a vendor that AECi ended one of its Managed licenses now, which product it was on, and why.',
    note: 'Goes to the vendor whose billing account held the license, on every revoke, assigned or not. Carries the reason, never the internal note. The managed-ended email goes too when the license was on a product. Not pausable: a portal row, not email.',
  },
  // AECI-1373 (E4.4): the admin decision on an early-unassign request.
  'portal-license-release-approved-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/license-release-requests/:id (routes/admin-license-release-requests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per approve, in the approve batch. A request is decided once.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/ADMIN_PANEL_SPEC.md §5.17',
    summary:
      'Tells a vendor that AECi took a license off its product early, as it asked, and that the license is back in its pool.',
    note: "Goes to the vendor that asked. Every plan, no tier rule. Echoes the owner's own request reason. Not pausable: a portal row, not email.",
  },
  'portal-license-release-declined-by-aeci': {
    channel: 'portal',
    audience: 'external',
    trigger: {
      kind: 'route',
      ref: 'PATCH /api/admin/license-release-requests/:id (routes/admin-license-release-requests.ts)',
    },
    envRule: 'any-tier',
    dedupe: 'One row per decline, in the decline batch. A request is decided once.',
    ledger: ['audit_log'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/ADMIN_PANEL_SPEC.md §5.17',
    summary:
      'Tells a vendor that AECi declined its early-unassign request, so the license stays on the product until renewal, and why.',
    note: 'Goes to the vendor that asked. Every plan, no tier rule. Carries the decline reason. Not pausable: a portal row, not email.',
  },

  // ─── Linear (Linear then notifies its own subscribers) ────────────────────
  'linear-request-issue': {
    channel: 'linear',
    audience: 'operator',
    trigger: {
      kind: 'route',
      ref: 'POST /api/requests/{claim,correction} (routes/requests.ts), and POST /api/requests/confirm for an anonymous claim (routes/request-confirmations.ts); retried by lib/reconciliation-sweep.ts',
    },
    envRule: 'any-tier',
    dedupe: 'Read-guard on the linked issue id, then a compare-and-set persist.',
    ledger: ['linear-issue-id'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.1',
    summary: 'Files a Linear issue for a vendor claim or correction.',
    note: 'LINEAR_API_KEY is set on production only, so staging and demo file no issues. A claim the submit-time account check stored rejected files no issue, and the sweep never retries it because it reads only open rows (AECI-1420). Not pausable: a Linear write, not email.',
  },
  'linear-request-duplicate-comment': {
    channel: 'linear',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'POST /api/requests/{claim,correction} (routes/requests.ts)' },
    envRule: 'any-tier',
    dedupe: 'Once per issue create.',
    ledger: ['none'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §7.2',
    summary: 'Comments on a new request issue that it may duplicate an open request.',
    note: 'Production only: it needs the issue that linear-request-issue creates. Not pausable: a Linear write, not email.',
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
    pausable: false,
    doc: 'docs/STAGE_2_VENDOR_PORTAL_SPEC.md §11b.6',
    summary: 'Files the REVIEW - issue that carries an accepted contest to the review lane.',
    note: 'LINEAR_API_KEY is set on production only, so staging and demo file no issues. Not pausable: a Linear write, not email.',
  },
  'linear-request-resolution': {
    channel: 'linear',
    audience: 'operator',
    trigger: { kind: 'route', ref: 'PATCH /api/admin/requests/:id (routes/admin-requests.ts)' },
    envRule: 'any-tier',
    dedupe: 'None. Each resolve or reject pushes once.',
    ledger: ['none'],
    optOut: 'none',
    pausable: false,
    doc: 'docs/STAGE_1_PHASE_6_SPEC.md §6.5',
    summary: "Moves a request's Linear issue to Done or Canceled and comments the reason.",
    note: 'The site-linear-sync workflow_transitions row records the sync, not a send. Production only: other tiers have no linked issue to move. Not pausable: a Linear write, not email.',
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

/** The ids an operator may pause (AECI-1224). */
export type PausableNotificationId = {
  [K in NotificationId]: NotificationRegistry[K]['pausable'] extends true ? K : never;
}[NotificationId];

/** Linear writes that notify the AECi team. */
export type LinearNotificationId = NotificationIdFor<'linear'>;

/** The entry for an id. */
export function getNotification<Id extends NotificationId>(id: Id): NotificationRegistry[Id] {
  return NOTIFICATIONS[id];
}
