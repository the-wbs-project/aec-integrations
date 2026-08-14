/**
 * Email transport for the API Worker (Resend).
 *
 * Two layers live here:
 *
 *   1. **Transactional templates** (AECI-240 / Phase 7.5, §11.1) — `sendTransactionalEmail`
 *      plus the per-template helpers (review submitted/approved/rejected, account
 *      deletion, the reconcile-sweep admin alert). These ride the Datadog triple
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
 * `outcome:sent|failed|skipped` + `template:<id>`; failures also `warn` to Datadog
 * (`source: 'email'`). Telemetry is wrapped so it can never turn a send into a throw.
 */

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import type { StuckRequestSummary } from './admin-alert';

/**
 * Minimal context a send needs: env (key + sender) plus the Datadog logging triple
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
  | 'claim-rejected';

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
 *  `POST /api/subscribe` on a real insert (not the idempotent already-listed
 *  no-op). Recipient is the new subscriber. Links to the directory when
 *  `PUBLIC_SITE_URL` is configured, otherwise the link is omitted (never a dead
 *  host). Carries a `List-Unsubscribe` mailto header (deliverability + one-click
 *  opt-out UI in Gmail/Apple Mail; keeps this "updates" list off the spam path).
 *  Voice per PRODUCT.md: sentence case, no em dashes, no "verification is live"
 *  claim, no pricing. Draft copy — marketing owns final wording. */
export function sendMailingListWelcomeEmail(
  c: EmailContext,
  opts: { to: string | undefined },
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
  const unsub = unsubscribeMailto(c.env);
  const unsubText = unsub
    ? `To stop these updates, email ${unsub} with the subject unsubscribe.`
    : null;
  const unsubHtml = unsub
    ? `To stop these updates, <a href="mailto:${escapeHtml(unsub)}?subject=unsubscribe">unsubscribe</a>.`
    : null;
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
    // RFC 2369 List-Unsubscribe (mailto). One-click POST (RFC 8058) is intentionally
    // omitted: it needs a public unsubscribe endpoint + token and is only required
    // of bulk senders (5000+/day), which this pre-launch list is not.
    ...(unsub ? { headers: { 'List-Unsubscribe': `<mailto:${unsub}?subject=unsubscribe>` } } : {}),
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

/** Best-effort `warn` to Datadog; wrapped like `emit`. */
function warn(c: EmailContext, message: string): void {
  try {
    logToDatadog(c.executionCtx, c.env, c.req.raw, { level: 'warn', message, source: 'email' });
  } catch {
    console.warn(`email: ${message}`);
  }
}
