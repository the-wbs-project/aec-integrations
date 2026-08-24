/**
 * Email transport for the API Worker (Resend).
 *
 * Two layers live here:
 *
 *   1. **Transactional templates** (AECI-240 / Phase 7.5, §11.1) — `sendTransactionalEmail`
 *      plus the per-template helpers (review submitted/approved/rejected, account
 *      deletion, the reconcile-sweep admin alert). These ride the telemetry triple
 *      (`EmailContext`) and emit the `aeci.email.send` metric.
 *   2. **Low-level transport** (AECI-241 / Phase 7.6) — `sendEmail` + `parseRecipients`,
 *      a dependency-free `fetch` POST with an injectable fetch/logger, used by the
 *      daily data-quality digest cron (`scheduled.ts`).
 *
 * **Provider note.** `STAGE_1_SPEC.md` §11.1 and the AECI-240 issue originally said
 * "Loops", but the repo standardized on **Resend** (the landing app already ships a
 * tested Resend integration, `apps/landing/src/services/email.ts`) and mailboxes on
 * Microsoft 365. The full decision + template catalogue + the Supabase→Resend SMTP
 * setup for magic links live in `docs/email.md`.
 *
 * Both layers mirror the canonical third-party-client posture (`lib/toxicity.ts` /
 * `LINEAR_API_KEY`):
 *
 *   - **Never throws.** Every failure mode (absent key/sender, no recipient,
 *     non-2xx, network error, timeout) resolves to an `EmailOutcome`, so a send can
 *     never break the action that triggered it. Callers fire it via `ctx.waitUntil`.
 *   - **Absent key → `'skipped'`.** No `RESEND_API_KEY` is the expected local
 *     `dev:bound` / PR-preview state (the secret is staging/prod only), so it
 *     no-ops; only genuine outages warn (mirrors `ANTHROPIC_API_KEY`).
 *   - **Sane timeout** via `AbortSignal.timeout` so a slow provider never hangs the
 *     `waitUntil` budget (transactional layer).
 *
 * Observability: every transactional attempt emits the `aeci.email.send` count tagged
 * `outcome:sent|failed|skipped` + `template:<id>`; failures also `warn` to the observability plane
 * (`source: 'email'`). Telemetry is wrapped so it can never turn a send into a throw.
 */

import { orderedPairSlugs } from '@aeci/shared';

import { logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';
import type { StuckRequestSummary } from './admin-alert';

/**
 * Minimal context a send needs: env (key + sender) plus the telemetry logging triple
 * (`executionCtx`, `env`, `req.raw`). Typed structurally rather than as Hono's
 * `Context` so both a route handler's `c` and the cron-synthesised `AlertContext`
 * (`lib/admin-alert.ts`) are assignable — Hono's `Context` is invariant on its
 * generic, so the nominal form would reject the richer `AuthContext`.
 */
export type EmailContext = {
  env: Env;
  // Only the `waitUntil` slice is needed (best-effort telemetry dispatch), typed
  // structurally so Hono's `Context.executionCtx` fits — Hono's `ExecutionContext`
  // lacks the `tracing` field that @cloudflare/workers-types' now requires.
  executionCtx: { waitUntil(promise: Promise<unknown>): void };
  req: { raw: Request };
};

export type EmailOutcome = 'sent' | 'failed' | 'skipped';

/** Stable template ids — the `template:` metric tag and the `docs/email.md` catalogue. */
export type EmailTemplate =
  | 'review-submitted'
  | 'review-approved'
  | 'review-rejected'
  | 'account-deleted'
  // Mailing-list welcome — the subscriber's first touch (AECI-327). Recipient is
  // the new subscriber; sent by `POST /api/subscribe` on a real insert.
  | 'mailing-list-welcome'
  | 'stuck-request-alert'
  // Operator lead-capture notifications — retire the `apps/landing` Worker's own
  // Resend send (AECI-247/277). Recipient is `ADMIN_ALERT_EMAIL`.
  | 'landing-signup'
  | 'landing-feedback'
  // Stage 2 vendor-portal claim decisions (AECI-528 /
  // `STAGE_2_VENDOR_PORTAL_SPEC.md` §9). Recipient is the claim's `submitter_email`;
  // sent post-commit from `PATCH /api/admin/claims/:id` (approve → approved,
  // reject → rejected).
  | 'claim-approved'
  | 'claim-rejected'
  // Stage 2 attestation detector nudges (AECI-302 /
  // `STAGE_2_ATTESTATIONS_SPEC.md` §7.2). Sent by the daily detector sweep
  // (`lib/attestation-notify.ts`); recipients are the vendor's unbanned
  // `vendor_admin` seats, resolved through `fetchAuthUserEmails`.
  | 'attestation-silent-counterparty'
  | 'attestation-open-conflict'
  | 'attestation-stale-version'
  // The AECi-facing half of the same sweep: the `aeci-denied` correction signal
  // and the ops escalation of an unresolved `open-conflict`. §7.2 named only the
  // three vendor ids above; ops mail needs its own id because the id IS the
  // `template:` metric tag and the `docs/email.md` catalogue key, and an ops
  // alert is a different message to a different audience. Recipient is
  // `ADMIN_ALERT_EMAIL`, one email per finding.
  | 'attestation-ops-alert'
  // Stage 2 entitlement term-expiry WARNINGS (AECI-613 /
  // `STAGE_2_PAID_TIERS_SPEC.md` §7.2). Sent by the daily 11:00 UTC sweep
  // (`lib/entitlement-expiry.ts`). Two ids for one event because the two
  // recipients have different reachability: the vendor copy needs seat addresses
  // from `fetchAuthUserEmails` and therefore `SUPABASE_SERVICE_ROLE_KEY` — present
  // on staging/demo/prod, ABSENT locally and on PR previews, so it degrades to
  // `skipped` — while the operator copy only needs `ADMIN_ALERT_EMAIL` and always
  // lands. Nothing either template describes ever changes on its own: the sweep
  // warns and never lapses (§7.3).
  | 'entitlement-expiring'
  | 'entitlement-expiring-admin';

const RESEND_URL = 'https://api.resend.com/emails';

/** Cap on how long we wait for Resend before giving up (fail-open to `'failed'`). */
const TIMEOUT_MS = 5000;

interface SendInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  template: EmailTemplate;
  /** Extra MIME headers (e.g. `List-Unsubscribe`) forwarded to Resend verbatim. */
  headers?: Record<string, string>;
}

/**
 * Low-level Resend send for the transactional templates. Returns an `EmailOutcome`;
 * **never throws**. An absent `RESEND_API_KEY` / `EMAIL_FROM`, or an empty recipient
 * (an address we couldn't resolve), is a silent `'skipped'`. POST shape matches the
 * landing app's tested `sendNotification` (Bearer auth, `from/to/subject/text/html`).
 */
export async function sendTransactionalEmail(
  c: EmailContext,
  input: SendInput,
): Promise<EmailOutcome> {
  const apiKey = c.env.RESEND_API_KEY;
  const from = c.env.EMAIL_FROM;
  if (!apiKey || !from || !input.to) {
    emit(c, 'skipped', input.template);
    return 'skipped';
  }

  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      warn(c, `Resend ${input.template} returned ${res.status}`);
      emit(c, 'failed', input.template);
      return 'failed';
    }
    emit(c, 'sent', input.template);
    return 'sent';
  } catch (err) {
    // Timeout (AbortError), network failure, or a malformed body — all non-fatal.
    warn(
      c,
      `Resend ${input.template} call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    emit(c, 'failed', input.template);
    return 'failed';
  }
}

// ─── Per-template helpers ──────────────────────────────────────────────────────
// en-US plain copy (emails are not i18n'd at launch — the CLAUDE.md i18n rule is
// for rendered `apps/web` templates). Each builds subject/text/html and returns the
// `EmailOutcome` from the low-level send.

/** §11.1 "Review submission confirmation". `to` is the reviewer's verified email
 *  (`session.email`); absent → silent skip. */
export function sendReviewSubmittedEmail(
  c: EmailContext,
  opts: { to: string | undefined },
): Promise<EmailOutcome> {
  const paragraphs = [
    'Thanks for reviewing software on AEC Integrations.',
    'Your review has been submitted and is now in moderation. We check every review by hand to keep the directory trustworthy.',
    "You'll hear from us again once it's approved and live.",
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'review-submitted',
    subject: 'Thanks — your review is in moderation',
    text: toText(paragraphs),
    html: toHtml(paragraphs),
  });
}

/** §11.1 "Review approved". Links to the product page when `siteUrl` is configured. */
export function sendReviewApprovedEmail(
  c: EmailContext,
  opts: { to: string | undefined; productName: string; productSlug: string },
): Promise<EmailOutcome> {
  const url = productUrl(c.env, opts.productSlug);
  const textParagraphs = [
    `Good news — your review of ${opts.productName} is now published on AEC Integrations.`,
    url ? `View it here: ${url}` : 'Thanks for helping the AEC community choose better software.',
  ];
  const htmlParagraphs = [
    `Good news — your review of <strong>${escapeHtml(opts.productName)}</strong> is now published on AEC Integrations.`,
    url
      ? `<a href="${escapeHtml(url)}">View your review</a>`
      : 'Thanks for helping the AEC community choose better software.',
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'review-approved',
    subject: `Your review of ${opts.productName} is now live`,
    text: toText(textParagraphs),
    html: toHtml(htmlParagraphs),
  });
}

/** §11.1 "Review rejected — {reason}". Includes the moderator's reason + a pointer
 *  to the review guidelines when `siteUrl` is configured. */
export function sendReviewRejectedEmail(
  c: EmailContext,
  opts: { to: string | undefined; productName: string; reason: string },
): Promise<EmailOutcome> {
  const guidelines = siteUrl(c.env) ? `${siteUrl(c.env)}/legal/review-guidelines` : null;
  const textParagraphs = [
    `Thanks for your review of ${opts.productName}. Before it can go live it needs a revision:`,
    opts.reason,
    guidelines
      ? `You're welcome to submit an updated review that follows our review guidelines: ${guidelines}`
      : "You're welcome to submit an updated review that follows our review guidelines.",
  ];
  const htmlParagraphs = [
    `Thanks for your review of <strong>${escapeHtml(opts.productName)}</strong>. Before it can go live it needs a revision:`,
    `<em>${escapeHtml(opts.reason)}</em>`,
    guidelines
      ? `You're welcome to submit an updated review that follows our <a href="${escapeHtml(guidelines)}">review guidelines</a>.`
      : "You're welcome to submit an updated review that follows our review guidelines.",
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'review-rejected',
    subject: `Your review of ${opts.productName} needs revision`,
    text: toText(textParagraphs),
    html: toHtml(htmlParagraphs),
  });
}

/**
 * §9 "Claim approved" (`STAGE_2_VENDOR_PORTAL_SPEC.md` / AECI-528). The claimant's
 * vendor claim was granted — their account is now a verified `vendor_admin`. For an
 * `invited` claimant the account was provisioned silently (no GoTrue invite email, see
 * `createAuthUser`), so this IS the onboarding touch and the sign-in copy explains a
 * first login; a `linked` claimant already has an account. Links to the `/vendor`
 * dashboard when `PUBLIC_SITE_URL` is set. Recipient is the claim's `submitter_email`;
 * absent → silent skip. Copy stays account-scoped: verification is a status, not a
 * product endorsement, and never touches ranking (no pay-for-placement).
 */
export function sendClaimApprovedEmail(
  c: EmailContext,
  opts: { to: string | undefined; vendorName: string; invited: boolean },
): Promise<EmailOutcome> {
  const name = opts.vendorName.trim() || 'this vendor';
  const dashboard = portalUrl(c.env);

  const signInText = opts.invited
    ? dashboard
      ? `We created an account for your email address. To sign in, request a one-time sign-in link at ${dashboard}.`
      : 'We created an account for your email address. To sign in, request a one-time sign-in link from the AEC Integrations sign-in page.'
    : dashboard
      ? `Sign in with your existing account to get started: ${dashboard}.`
      : 'Sign in with your existing account to get started.';
  const signInHtml = opts.invited
    ? dashboard
      ? `We created an account for your email address. To sign in, request a one-time sign-in link at <a href="${escapeHtml(dashboard)}">your vendor dashboard</a>.`
      : 'We created an account for your email address. To sign in, request a one-time sign-in link from the AEC Integrations sign-in page.'
    : dashboard
      ? `<a href="${escapeHtml(dashboard)}">Sign in with your existing account</a> to get started.`
      : 'Sign in with your existing account to get started.';

  const verification =
    "Verification confirms your account represents this vendor. It's an account status, not an endorsement of the product, and it doesn't affect search ranking or placement.";
  const capabilities =
    'You can now edit the vendor profile, submit data corrections, and add integration attestations from your vendor dashboard.';

  const textParagraphs = [
    `Your claim for ${name} has been approved, and your account is now verified on AEC Integrations.`,
    capabilities,
    signInText,
    verification,
  ];
  const htmlParagraphs = [
    `Your claim for <strong>${escapeHtml(name)}</strong> has been approved, and your account is now verified on AEC Integrations.`,
    capabilities,
    signInHtml,
    verification,
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'claim-approved',
    subject: `Your claim for ${name} is approved`,
    text: toText(textParagraphs),
    html: toHtml(htmlParagraphs),
  });
}

/**
 * §9 "Claim rejected" (`STAGE_2_VENDOR_PORTAL_SPEC.md` / AECI-528). Deliberately
 * NEUTRAL (the §9 AC): the reviewer's decision `reason` is an INTERNAL audit note —
 * recorded in the `audit_log` (admin-visible), never echoed to the claimant — so
 * nothing a reviewer types can leak. The claimant is told only that the claim
 * wasn't approved, and is invited to resubmit. Recipient is `submitter_email`;
 * absent → skip.
 */
export function sendClaimRejectedEmail(
  c: EmailContext,
  opts: { to: string | undefined; vendorName: string },
): Promise<EmailOutcome> {
  const name = opts.vendorName.trim() || 'this vendor';
  const resubmit =
    "If you represent this vendor, you're welcome to submit a new claim with more detail.";

  const textParagraphs = [
    `Thank you for your claim for ${name}. After review, we weren't able to approve it.`,
    resubmit,
  ];
  const htmlParagraphs = [
    `Thank you for your claim for <strong>${escapeHtml(name)}</strong>. After review, we weren't able to approve it.`,
    resubmit,
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'claim-rejected',
    subject: `Your claim for ${name} was not approved`,
    text: toText(textParagraphs),
    html: toHtml(htmlParagraphs),
  });
}

/**
 * Adapter for the `PATCH /api/admin/claims/:id` decision-email seam
 * (`SendClaimDecisionEmail` in `routes/admin-claims.ts`, AECI-519/528). Routes a
 * committed decision to the right template and drops the `EmailOutcome` (the handler
 * fires this via `waitUntil` and never reads the result). Typed structurally so this
 * file doesn't import the route's seam type; the assignability to that type is
 * enforced where it's wired (`index.ts`).
 */
export async function sendClaimDecisionEmail(
  c: EmailContext,
  input: {
    decision: 'approved' | 'rejected';
    to: string;
    targetName: string;
    identityOutcome?: 'linked' | 'invited';
  },
): Promise<void> {
  if (input.decision === 'approved') {
    await sendClaimApprovedEmail(c, {
      to: input.to,
      vendorName: input.targetName,
      invited: input.identityOutcome === 'invited',
    });
  } else {
    // Neutral by design — the reviewer's `reason` is an internal audit note and is
    // never passed to the claimant email (see `sendClaimRejectedEmail`).
    await sendClaimRejectedEmail(c, {
      to: input.to,
      vendorName: input.targetName,
    });
  }
}

// ─── Attestation detector nudges (§7.2 — AECI-302) ────────────────────────────
// One email per (finding, recipient address), sent by `lib/attestation-notify.ts`
// after the daily sweep. Copy discipline (§6): never imply that attesting affects
// ranking or placement, never promise how fast a change appears, and treat
// "Verified" strictly as an account status.

/** What every attestation nudge needs to describe the flow it is about. Product
 *  names/slugs are the snapshot the detector captured, not a live read. */
export interface AttestationEmailSubject {
  to: string;
  /** The `data_object` name, e.g. "RFIs". */
  dataObject: string;
  /** The endpoint the recipient owns. */
  product: string;
  /** The other endpoint. */
  counterpart: string;
  /** `integrations.mechanism_name`, when the row has one. */
  mechanismName: string | null;
  /** Both endpoint slugs, for the canonical pair link. */
  pairSlugs: readonly [string, string];
}

/** " through Procore Connector" — or nothing when the mechanism is unnamed. */
function viaMechanism(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? ` through ${trimmed}` : '';
}

/** The two closing lines every vendor nudge shares: where to look, where to act.
 *  Each is omitted (not faked) when `PUBLIC_SITE_URL` is unset. */
function attestationLinks(
  c: EmailContext,
  pairSlugs: readonly [string, string],
): { text: string[]; html: string[] } {
  const pair = pairUrl(c.env, pairSlugs[0], pairSlugs[1]);
  const portal = portalUrl(c.env);
  const text: string[] = [];
  const html: string[] = [];
  if (pair) {
    text.push(`See how it currently reads: ${pair}`);
    html.push(`<a href="${escapeHtml(pair)}">See how it currently reads</a>.`);
  }
  if (portal) {
    text.push(`Update it from your vendor dashboard: ${portal}`);
    html.push(`<a href="${escapeHtml(portal)}">Update it from your vendor dashboard</a>.`);
  }
  return { text, html };
}

/**
 * `silent-counterparty` (§7.1): the counterparty affirmed a flow and this vendor
 * has not answered. The second paragraph is the point of the whole epic — it says
 * plainly that silence is rendered as silence (`STAGE_2_SPEC.md` §8.1(4)), so the
 * nudge is informative rather than coercive.
 */
export function sendAttestationSilentCounterpartyEmail(
  c: EmailContext,
  opts: AttestationEmailSubject,
): Promise<EmailOutcome> {
  const via = viaMechanism(opts.mechanismName);
  const links = attestationLinks(c, opts.pairSlugs);
  const lead = `${opts.counterpart} has confirmed that ${opts.dataObject} moves between ${opts.product} and ${opts.counterpart}${via}. We have not heard from your side yet.`;
  const stance =
    "Until both vendors confirm it, we show this flow as reported by one vendor only. We never present one vendor's word as agreement.";
  const ask =
    'If it is accurate, confirm it. If it is wrong or has changed, say so, and we will show your position alongside theirs.';

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'attestation-silent-counterparty',
    subject: `Confirm how ${opts.dataObject} flows between ${opts.product} and ${opts.counterpart}`,
    text: toText([lead, stance, ask, ...links.text]),
    html: toHtml([
      `<strong>${escapeHtml(opts.counterpart)}</strong> has confirmed that ${escapeHtml(opts.dataObject)} moves between ${escapeHtml(opts.product)} and ${escapeHtml(opts.counterpart)}${escapeHtml(via)}. We have not heard from your side yet.`,
      stance,
      ask,
      ...links.html,
    ]),
  });
}

/**
 * `open-conflict` (§7.1): two vendors have taken opposing positions. Copy is
 * deliberately non-accusatory and mirrors the pair page's "Vendors disagree"
 * treatment (§4.5) — the disagreement is surfaced as a difference in description,
 * not as a defect in either product.
 */
export function sendAttestationOpenConflictEmail(
  c: EmailContext,
  opts: AttestationEmailSubject,
): Promise<EmailOutcome> {
  const via = viaMechanism(opts.mechanismName);
  const links = attestationLinks(c, opts.pairSlugs);
  const lead = `Your account and ${opts.counterpart} have recorded different answers about whether ${opts.dataObject} moves between ${opts.product} and ${opts.counterpart}${via}.`;
  const stance =
    'While the two positions differ, we show the disagreement itself rather than picking a side.';
  const ask =
    'If your position has changed, update it. If it has not, no action is needed and we will keep showing both.';

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'attestation-open-conflict',
    subject: `You and ${opts.counterpart} describe ${opts.dataObject} differently`,
    text: toText([lead, stance, ask, ...links.text]),
    html: toHtml([
      `Your account and <strong>${escapeHtml(opts.counterpart)}</strong> have recorded different answers about whether ${escapeHtml(opts.dataObject)} moves between ${escapeHtml(opts.product)} and ${escapeHtml(opts.counterpart)}${escapeHtml(via)}.`,
      stance,
      ask,
      ...links.html,
    ]),
  });
}

/**
 * `stale-version` (§7.1): an assertion has aged past a year with no version data,
 * or names a version that has since been retired. The ask is explicitly
 * three-way — re-confirm, add versions, or withdraw — because "withdraw" is a
 * legitimate answer and an email that only asks for confirmation biases the data.
 */
export function sendAttestationStaleVersionEmail(
  c: EmailContext,
  opts: AttestationEmailSubject,
): Promise<EmailOutcome> {
  const via = viaMechanism(opts.mechanismName);
  const links = attestationLinks(c, opts.pairSlugs);
  const lead = `Your record that ${opts.dataObject} moves between ${opts.product} and ${opts.counterpart}${via} has not been updated in a while, or names a version that has since been retired.`;
  const ask =
    'Re-confirm it, add the product versions it applies to, or withdraw it if it no longer holds. Any of the three is a good answer.';

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'attestation-stale-version',
    subject: `Re-confirm your ${opts.dataObject} record for ${opts.product}`,
    text: toText([lead, ask, ...links.text]),
    html: toHtml([
      `Your record that ${escapeHtml(opts.dataObject)} moves between <strong>${escapeHtml(opts.product)}</strong> and ${escapeHtml(opts.counterpart)}${escapeHtml(via)} has not been updated in a while, or names a version that has since been retired.`,
      ask,
      ...links.html,
    ]),
  });
}

/**
 * The AECi-facing half of the sweep, one email per finding. Two detectors route
 * here and the body names which:
 *
 * - `aeci-denied` — a vendor denies a claim **AECi** seeded. The claim then
 *   computes `unverified` (§4.2), which is indistinguishable from "nobody voted"
 *   on every surface, so without this mail the correction is simply lost.
 * - `open-conflict` — the §7.1 escalation that accompanies the two vendor nudges.
 *
 * Operator format (`opsText`/`opsTable`), not the vendor prose format: this is a
 * triage record, and every value in it is escaped because product and mechanism
 * names are vendor-supplied.
 */
export function sendAttestationOpsAlertEmail(
  c: EmailContext,
  opts: {
    to: string;
    detector: 'aeci-denied' | 'open-conflict';
    dataObject: string;
    productA: string;
    productB: string;
    mechanismName: string | null;
    claimId: string;
    integrationId: string;
    pairSlugs: readonly [string, string];
  },
): Promise<EmailOutcome> {
  const denied = opts.detector === 'aeci-denied';
  const intro = denied
    ? 'A vendor has denied a claim AECi seeded. A denial-only claim renders as unverified, so it is invisible on the site until someone corrects the curation.'
    : 'Two vendors have been in unresolved disagreement about a claim past the notification threshold. Both have been nudged; this is the ops copy.';

  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Detector', opts.detector],
    ['Data object', opts.dataObject],
    ['Products', `${opts.productA} / ${opts.productB}`],
    ['Mechanism', opts.mechanismName?.trim() || '(unnamed)'],
    ['Claim', opts.claimId],
    ['Integration', opts.integrationId],
    ['Pair page', pairUrl(c.env, opts.pairSlugs[0], opts.pairSlugs[1]) ?? '(no PUBLIC_SITE_URL)'],
  ];

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'attestation-ops-alert',
    subject: denied
      ? `[AECi] Vendor denied a seeded claim: ${opts.dataObject} (${opts.productA} / ${opts.productB})`
      : `[AECi] Unresolved vendor conflict: ${opts.dataObject} (${opts.productA} / ${opts.productB})`,
    text: opsText(intro, rows),
    html: opsTable(intro, rows),
  });
}

// ─── Entitlement term-expiry warnings (§7.2 — AECI-613) ───────────────────────
// Sent by the daily 11:00 UTC sweep (`lib/entitlement-expiry.ts`). The load-bearing
// copy rule is §7.3's: this is a WARNING, and the system never lapses anything on
// its own. Neither template may imply that verification is about to be switched
// off automatically, because it is not — un-verify stays a deliberate admin act
// (§5). Verification is also framed exactly as everywhere else: an account status,
// never an endorsement and never a ranking or placement signal.

/** What both expiry templates need to describe one term. `daysRemaining` is
 *  negative once the term is past its end — the sweep still warns exactly once for
 *  such a row, because "active, and the term ran out" is precisely the state an
 *  operator has to be told about. */
export interface EntitlementExpirySubject {
  to: string;
  vendorName: string;
  /** `YYYY-MM-DD`, the house day-label form (`lib/admin-analytics.ts`). */
  periodEndDay: string;
  /** Whole days from the run's `now` to `period_end`; <= 0 = already past. */
  daysRemaining: number;
}

/** "in 30 days" / "today" / "30 days ago" — the one phrase both bodies branch on. */
function expiryPhrase(daysRemaining: number): string {
  if (daysRemaining > 1) return `in ${daysRemaining} days`;
  if (daysRemaining === 1) return 'tomorrow';
  if (daysRemaining === 0) return 'today';
  if (daysRemaining === -1) return 'yesterday';
  return `${Math.abs(daysRemaining)} days ago`;
}

/**
 * §7.2 `entitlement-expiring` — the vendor's renewal prompt, to the vendor's
 * unbanned `vendor_admin` seats.
 *
 * Degrades to `'skipped'` without `SUPABASE_SERVICE_ROLE_KEY` (no resolvable seat
 * address), which is the expected local / PR-preview state; the admin copy below
 * always lands, so a term is never silently un-warned.
 *
 * The money is deliberately absent. Amount, payer, terms and PO reference are
 * admin-side only (§8) — this email says what the status is and when the term
 * ends, and asks the vendor to get in touch.
 */
export function sendEntitlementExpiringEmail(
  c: EmailContext,
  opts: EntitlementExpirySubject,
): Promise<EmailOutcome> {
  const name = opts.vendorName.trim() || 'your company';
  const dashboard = portalUrl(c.env);
  const phrase = expiryPhrase(opts.daysRemaining);
  const past = opts.daysRemaining < 0;

  const lead = past
    ? `Your verification term for ${name} on AEC Integrations reached its end date of ${opts.periodEndDay} — ${phrase}.`
    : `Your verification term for ${name} on AEC Integrations ends ${phrase}, on ${opts.periodEndDay}.`;
  // The reassurance is the point of the whole §7 decision. Say it plainly.
  const noLapse =
    "Nothing changes automatically. We don't switch verification off when a term reaches its end date — this is a heads-up so you can decide, not a countdown.";
  const ask = 'To renew, or if the term dates look wrong, just reply to this email.';
  const stance =
    "Verification confirms your account represents this vendor. It's an account status, not an endorsement of the product, and it doesn't affect search ranking or placement.";

  const textParagraphs = [lead, noLapse, ask];
  const htmlParagraphs = [
    past
      ? `Your verification term for <strong>${escapeHtml(name)}</strong> on AEC Integrations reached its end date of ${escapeHtml(opts.periodEndDay)} — ${escapeHtml(phrase)}.`
      : `Your verification term for <strong>${escapeHtml(name)}</strong> on AEC Integrations ends ${escapeHtml(phrase)}, on ${escapeHtml(opts.periodEndDay)}.`,
    noLapse,
    ask,
  ];
  if (dashboard) {
    textParagraphs.push(`Your current status is on your vendor dashboard: ${dashboard}`);
    htmlParagraphs.push(
      `Your current status is on <a href="${escapeHtml(dashboard)}">your vendor dashboard</a>.`,
    );
  }
  textParagraphs.push(stance);
  htmlParagraphs.push(stance);

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'entitlement-expiring',
    subject: past
      ? `Your verification term for ${name} has reached its end date`
      : `Your verification term for ${name} ends ${phrase}`,
    text: toText(textParagraphs),
    html: toHtml(htmlParagraphs),
  });
}

/**
 * §7.2 `entitlement-expiring-admin` — the operator copy, to `ADMIN_ALERT_EMAIL`.
 *
 * Exists because the vendor half needs the GoTrue admin seam and can therefore
 * degrade to `skipped`, while renewal is an offline, human, invoice-driven act
 * that someone has to actually perform. Operator format (`opsText`/`opsTable`),
 * and unlike the vendor copy it DOES carry the arrangement — this is the
 * admin-side surface where payer and PO reference belong (§8).
 */
export function sendEntitlementExpiringAdminEmail(
  c: EmailContext,
  opts: {
    to: string;
    vendorName: string;
    vendorSlug: string;
    tier: string;
    periodEndDay: string;
    daysRemaining: number;
    payer: string | null;
    invoiceRef: string | null;
    /** Whether the vendor half of this notice reached anyone. */
    vendorNotice: EmailOutcome;
  },
): Promise<EmailOutcome> {
  const name = opts.vendorName.trim() || opts.vendorSlug;
  const phrase = expiryPhrase(opts.daysRemaining);
  const intro =
    opts.daysRemaining < 0
      ? 'An ACTIVE entitlement is past its term end date. Nothing has been changed — the expiry sweep warns and never lapses (STAGE_2_PAID_TIERS_SPEC.md §7.3). Renew it or clear it deliberately from /admin/claims.'
      : 'An active entitlement is approaching its term end date. Nothing will change on its own — the expiry sweep warns and never lapses (STAGE_2_PAID_TIERS_SPEC.md §7.3). Renew it or clear it deliberately from /admin/claims.';

  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Vendor', `${name} (${opts.vendorSlug})`],
    ['Tier', opts.tier],
    ['Term ends', `${opts.periodEndDay} (${phrase})`],
    ['Payer', opts.payer?.trim() || '(none recorded)'],
    ['Invoice ref', opts.invoiceRef?.trim() || '(none recorded)'],
    // Named explicitly so "the vendor was told" is never assumed. `skipped` here is
    // the normal local/preview state (no SUPABASE_SERVICE_ROLE_KEY) and a real
    // misconfiguration on a deployed tier.
    ['Vendor notice', opts.vendorNotice],
  ];

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'entitlement-expiring-admin',
    subject: `[AECi] Entitlement term ends ${phrase}: ${name}`,
    text: opsText(intro, rows),
    html: opsTable(intro, rows),
  });
}

/** §11.1 "Account deletion confirmation" (deferred from AECI-202). The recipient is
 *  captured from `session.email` BEFORE the `auth.users` row is erased. */
export function sendAccountDeletionEmail(
  c: EmailContext,
  opts: { to: string | undefined },
): Promise<EmailOutcome> {
  const paragraphs = [
    'This confirms that your AEC Integrations account and personal data have been deleted, as you requested.',
    'Any reviews you submitted have been anonymized and kept without your name attached.',
    "If you didn't request this, please reply to this email right away.",
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'account-deleted',
    subject: 'Your AEC Integrations account has been deleted',
    text: toText(paragraphs),
    html: toHtml(paragraphs),
  });
}

/** Derive the `unsubscribe@<sender-domain>` mailbox from `EMAIL_FROM` (e.g.
 *  `AEC Integrations <notifications@aecintegrations.com>` → `unsubscribe@aecintegrations.com`).
 *  Null when the sender has no parseable domain, so the header is simply omitted.
 *  The address must be routed (Cloudflare Email Routing) for opt-outs to be actioned. */
function unsubscribeMailto(env: Env): string | null {
  const domain = env.EMAIL_FROM?.match(/@([A-Za-z0-9.-]+)/)?.[1];
  return domain ? `unsubscribe@${domain}` : null;
}

/** Mailing-list welcome (AECI-327) — the subscriber's first touch, sent by
 *  `POST /api/subscribe` on a real insert / reactivation (not the idempotent
 *  already-listed no-op). Recipient is the new subscriber. Links to the directory
 *  when `PUBLIC_SITE_URL` is configured, otherwise the link is omitted (never a
 *  dead host).
 *
 *  Unsubscribe (AECI-537): when we have a public host AND the subscriber's
 *  `token`, the in-body link points at the `/unsubscribe?token=…` page and the
 *  headers carry a true RFC 8058 one-click opt-out (`List-Unsubscribe-Post` +
 *  an https `List-Unsubscribe` target that hits `POST /api/unsubscribe?token=…`
 *  through the SSR passthrough), with the RFC 2369 `mailto:` as a secondary
 *  value. Without a host/token we fall back to the mailto-only header + link.
 *
 *  Voice per PRODUCT.md: sentence case, no em dashes, no "verification is live"
 *  claim, no pricing. Draft copy — marketing owns final wording. */
export function sendMailingListWelcomeEmail(
  c: EmailContext,
  opts: { to: string | undefined; token?: string | null },
): Promise<EmailOutcome> {
  const base = siteUrl(c.env);
  const browseUrl = base ? `${base}/products` : null;
  const intro =
    'Thanks for signing up. AEC Integrations is an independent directory and review platform for the software used across architecture, engineering, and construction. No vendor marketing, no pay-for-placement.';
  const what =
    'We organize tools by workflow stage and discipline, the way AEC actually works, not by generic software categories. And we keep product quality separate from onboarding experience, so you can judge software on what matters to your projects.';
  const browseLead =
    "The best next step is to browse the directory: see how tools connect, and where they don't, before you commit.";
  const fallback = "We'll also email you as new tools and reviews land in the directory.";

  // Tokenized page link + one-click endpoint (preferred), else the mailto opt-out.
  const mailto = unsubscribeMailto(c.env);
  const token = opts.token ?? null;
  const pageUrl = base && token ? `${base}/unsubscribe?token=${encodeURIComponent(token)}` : null;
  const oneClickUrl =
    base && token ? `${base}/api/unsubscribe?token=${encodeURIComponent(token)}` : null;

  const unsubText = pageUrl
    ? `To stop these updates, unsubscribe here: ${pageUrl}`
    : mailto
      ? `To stop these updates, email ${mailto} with the subject unsubscribe.`
      : null;
  const unsubHtml = pageUrl
    ? `To stop these updates, <a href="${escapeHtml(pageUrl)}">unsubscribe</a>.`
    : mailto
      ? `To stop these updates, <a href="mailto:${escapeHtml(mailto)}?subject=unsubscribe">unsubscribe</a>.`
      : null;

  // List-Unsubscribe: https one-click (RFC 8058) with the mailto as a secondary
  // value when both are available; otherwise whichever single value we have.
  const mailtoValue = mailto ? `<mailto:${mailto}?subject=unsubscribe>` : null;
  const listUnsub = oneClickUrl
    ? mailtoValue
      ? `<${oneClickUrl}>, ${mailtoValue}`
      : `<${oneClickUrl}>`
    : mailtoValue;
  const unsubHeaders: Record<string, string> = {};
  if (listUnsub) unsubHeaders['List-Unsubscribe'] = listUnsub;
  if (oneClickUrl) unsubHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';

  const textParagraphs = [
    intro,
    what,
    browseUrl ? `${browseLead} Browse the directory: ${browseUrl}` : fallback,
    ...(unsubText ? [unsubText] : []),
  ];
  const htmlParagraphs = [
    intro,
    what,
    browseUrl
      ? `${browseLead} <a href="${escapeHtml(browseUrl)}">Browse the directory</a>`
      : fallback,
    ...(unsubHtml ? [unsubHtml] : []),
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'mailing-list-welcome',
    subject: 'Welcome to AEC Integrations',
    text: toText(textParagraphs),
    html: toHtml(htmlParagraphs),
    ...(Object.keys(unsubHeaders).length ? { headers: unsubHeaders } : {}),
  });
}

/** The request→Linear "persistent failure" admin alert (deferred from AECI-214).
 *  Recipient is `ADMIN_ALERT_EMAIL`; called by `lib/admin-alert.ts`. */
export function sendStuckRequestAdminAlert(
  c: EmailContext,
  opts: { to: string | undefined; rows: readonly StuckRequestSummary[] },
): Promise<EmailOutcome> {
  const { rows } = opts;
  const plural = rows.length === 1 ? '' : 's';
  const items = rows.map(
    (r) =>
      `${r.kind} ${r.targetType} "${r.targetName ?? '(target removed)'}" — stuck ${r.ageMinutes}m — ${r.requestId}`,
  );
  const textParagraphs = [
    `The reconciliation sweep found ${rows.length} request${plural} that failed to create a Linear issue and ${rows.length === 1 ? 'is' : 'are'} still failing after retries:`,
    items.join('\n'),
    'These rows are open with linear_issue_id=null. Check /admin/requests.',
  ];
  const htmlParagraphs = [
    `The reconciliation sweep found ${rows.length} request${plural} that failed to create a Linear issue and ${rows.length === 1 ? 'is' : 'are'} still failing after retries:`,
    `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`,
    'These rows are <code>open</code> with <code>linear_issue_id=null</code>. Check <code>/admin/requests</code>.',
  ];
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'stuck-request-alert',
    subject: `[AECi] ${rows.length} request${plural} stuck in the Linear pipeline`,
    text: toText(textParagraphs),
    html: toHtml(htmlParagraphs),
  });
}

// ─── Operator lead-capture notifications (AECI-247/277) ─────────────────────────
// When `apps/landing` retires, its two forms (`/api/subscribe`, `/api/feedback`)
// are served straight by this Worker (via the SSR passthrough), so the operator
// "new signup / new feedback" email the landing Worker used to send moves here.
// Recipient is `ADMIN_ALERT_EMAIL` (the operator address the reconcile-sweep alert
// already uses — no new secret to provision). Fired fire-and-forget via
// `ctx.waitUntil` from `routes/landing-forms.ts`; fail-open like every send.
// Internal ops mail, en-US (not i18n'd — the CLAUDE.md i18n rule is for rendered
// `apps/web` templates).

/** Operator alert: a fresh mailing-list signup (`POST /api/subscribe`, on a real
 *  insert — not the idempotent already-listed no-op). */
export function sendLandingSignupNotification(
  c: EmailContext,
  opts: {
    email: string;
    city: string | null;
    region: string | null;
    country: string | null;
    asOrganization: string | null;
    utmSource: string | null;
    utmCampaign: string | null;
    referrer: string | null;
  },
): Promise<EmailOutcome> {
  const rows: Array<[string, string]> = [
    ['Email', opts.email],
    ['Location', `${opts.city ?? '—'}, ${opts.region ?? '—'}, ${opts.country ?? '—'}`],
    ['Organization', opts.asOrganization ?? '—'],
    ['Source', opts.utmSource ?? 'direct'],
    ['Campaign', opts.utmCampaign ?? '—'],
    ['Referrer', opts.referrer ?? '—'],
  ];
  return sendTransactionalEmail(c, {
    to: c.env.ADMIN_ALERT_EMAIL ?? '',
    template: 'landing-signup',
    subject: '[AECi] New mailing list signup',
    text: opsText('Someone just joined the AEC Integrations mailing list.', rows),
    html: opsTable('Someone just joined the AEC Integrations mailing list.', rows),
  });
}

/** Operator alert: a feedback submission (`POST /api/feedback`). */
export function sendLandingFeedbackNotification(
  c: EmailContext,
  opts: {
    email: string | null;
    features: string | null;
    tools: string | null;
    subscribed: boolean;
    city: string | null;
    region: string | null;
    country: string | null;
    referrer: string | null;
  },
): Promise<EmailOutcome> {
  const rows: Array<[string, string]> = [
    ['From', opts.email ?? '(anonymous)'],
    ['Features requested', opts.features ?? '(none)'],
    ['Tools/software', opts.tools ?? '(none)'],
    ['Subscribed', opts.subscribed ? 'yes' : 'no'],
    ['Location', `${opts.city ?? '—'}, ${opts.region ?? '—'}, ${opts.country ?? '—'}`],
    ['Referrer', opts.referrer ?? '—'],
  ];
  return sendTransactionalEmail(c, {
    to: c.env.ADMIN_ALERT_EMAIL ?? '',
    template: 'landing-feedback',
    subject: '[AECi] New feedback submitted',
    text: opsText('Someone just submitted feedback on AEC Integrations.', rows),
    html: opsTable('Someone just submitted feedback on AEC Integrations.', rows),
  });
}

// ─── Low-level transport (AECI-241 / Phase 7.6) ─────────────────────────────────
// Used by the daily data-quality digest cron (`scheduled.ts`). Dependency-free with
// an injectable fetch/logger; no Datadog metric here (the cron emits its own).

export interface EmailMessage {
  from: string;
  /** One or more recipients. */
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** The env slice the transport reads. `RESEND_API_KEY` is a per-env Wrangler secret. */
export interface EmailEnv {
  RESEND_API_KEY?: string;
}

/**
 * Send one email via Resend. Returns the outcome instead of throwing:
 *   - `'skipped'` — no API key, or no recipients (fail-open no-op).
 *   - `'failed'`  — Resend returned non-2xx or the request threw.
 *   - `'sent'`    — accepted by Resend.
 * The optional `logger` records the reason on skip/fail (defaults to `console`).
 */
export async function sendEmail(
  env: EmailEnv,
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch,
  logger: Pick<Console, 'warn' | 'error'> = console,
): Promise<EmailOutcome> {
  if (!env.RESEND_API_KEY) {
    logger.warn('email: skipped — RESEND_API_KEY not configured');
    return 'skipped';
  }
  if (!message.from || message.to.length === 0) {
    logger.warn('email: skipped — from/to not configured');
    return 'skipped';
  }

  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error(
        `email: Resend error ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
      return 'failed';
    }
    return 'sent';
  } catch (error) {
    logger.error(`email: send threw — ${error instanceof Error ? error.message : String(error)}`);
    return 'failed';
  }
}

/** Parse a comma/semicolon/whitespace-separated recipient var into a clean list. */
export function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ─── Internals ─────────────────────────────────────────────────────────────────

/** Public site base (no trailing slash) or `null` when unconfigured — links are
 *  then omitted rather than pointing at a dead host. */
function siteUrl(env: Env): string | null {
  const url = env.PUBLIC_SITE_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

function productUrl(env: Env, slug: string): string | null {
  const base = siteUrl(env);
  return base ? `${base}/products/${slug}` : null;
}

/** The vendor portal entry point (`/vendor` dashboard, AECI-522) or `null` when
 *  `PUBLIC_SITE_URL` is unset — the claim-approved email then omits the link. */
function portalUrl(env: Env): string | null {
  const base = siteUrl(env);
  return base ? `${base}/vendor` : null;
}

/**
 * The canonical product-pair page for two endpoint slugs
 * (`/products/{context}/integrations/{other}`, Stage 1.5 §7.1 / AECI-297), or
 * `null` when `PUBLIC_SITE_URL` is unset.
 *
 * `orderedPairSlugs` is the shared alphabetical primitive the pair route, the
 * `pair:{min}__{max}` cache tag and the IndexNow submitter all resolve through —
 * so a notification link lands on the same URL those already canonicalised to,
 * rather than on the orientation that happens to be stored on the row.
 */
function pairUrl(env: Env, slugA: string, slugB: string): string | null {
  const base = siteUrl(env);
  if (!base) return null;
  const [context, other] = orderedPairSlugs(slugA, slugB);
  return `${base}/products/${context}/integrations/${other}`;
}

function toText(paragraphs: string[]): string {
  return `${paragraphs.join('\n\n')}\n\n— The AEC Integrations team`;
}

function toHtml(paragraphs: string[]): string {
  const body = [...paragraphs, '— The AEC Integrations team']
    .map((p) => `<p style="margin:0 0 16px">${p}</p>`)
    .join('');
  return `<!doctype html><html lang="en"><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#27272a">${body}</body></html>`;
}

/** Plain-text operator notification: intro line + `Key: value` rows. */
function opsText(intro: string, rows: ReadonlyArray<readonly [string, string]>): string {
  return `${intro}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}`;
}

/** HTML operator notification: intro paragraph + a bordered table. Every cell is
 *  escaped (rows carry user-supplied email / features / tools). */
function opsTable(intro: string, rows: ReadonlyArray<readonly [string, string]>): string {
  const body = rows
    .map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="en"><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#27272a"><p style="margin:0 0 16px">${escapeHtml(intro)}</p><table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse">${body}</table></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Emit the `aeci.email.send` outcome count. Wrapped so a missing `DD_API_KEY` /
 *  ExecutionContext can never turn a send into a throw. */
function emit(c: EmailContext, outcome: EmailOutcome, template: EmailTemplate): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.email.send', 1, [
      `outcome:${outcome}`,
      `template:${template}`,
    ]);
  } catch {
    // Telemetry must never break a send.
  }
}

/** Best-effort `warn` to the observability plane; wrapped like `emit`. */
function warn(c: EmailContext, message: string): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, { level: 'warn', message, source: 'email' });
  } catch {
    console.warn(`email: ${message}`);
  }
}
