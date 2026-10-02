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
 * **Every send names a registry entry (AECI-1199).** `lib/notifications/registry.ts` is
 * the list of everything AECi sends. `template` and `EmailMessage.notification` are typed
 * from it, and `registry-coverage.spec.ts` fails on a sender that names no entry.
 *
 * Observability: every transactional attempt emits the `aeci.email.send` count tagged
 * `outcome:sent|failed|unknown|skipped|suppressed|duplicate` + `template:<id>`, where the id is the
 * registry id. The digests are counted the same way by their cron jobs. Failures also `warn` to the
 * observability plane (`source: 'email'`). Telemetry is wrapped so it can never turn a send
 * into a throw.
 *
 * **Tier delivery policy (AECI-1198).** Both layers run every recipient through
 * `lib/notifications/delivery-policy.ts` before calling Resend. Production sends to
 * anyone. Every other tier, including a missing or unknown `ENV`, sends only to
 * `@thewbsproject.com` and `@aecintegrations.com` addresses and prefixes the subject with
 * the tier (`[staging] …`). A send whose recipient is outside resolves to `'suppressed'`
 * with no fetch, and logs a recipient hash, never the address. BCC addresses go through
 * the same filter.
 *
 * **Send ledger (AECI-1202).** Both layers write one `notification_sends` row per
 * addressed recipient (`lib/notifications/send-ledger.ts`): `skipped`, `suppressed`,
 * `sent` with the Resend message id read from the 2xx body, `failed` on a non-2xx,
 * `unknown` on a timeout or thrown call, or `duplicate` when a `dedupeKey` is already
 * held. A keyed send also carries Resend's `Idempotency-Key` header, with a hash of
 * the body in the key. A transactional send reserves its row before the
 * Resend call and settles it after. Every caller already runs the send inside
 * `waitUntil` or a cron, so the ledger writes add no latency to a route response. A
 * ledger DB error warns and the send goes ahead. BCC copies get no row of their own;
 * the separate operator copy does.
 *
 * **Link tagging (AECI-1209).** A template hands `sendTransactionalEmail` a `render(link)`
 * callback, not finished HTML. The send reserves its ledger row, then renders with a
 * tagger that adds `utm_source=email`, `utm_campaign=<template>` and `n=<row id>` to every
 * site URL the template passes through `link`. See `lib/notifications/link-tag.ts` and
 * `docs/email.md` §Link tagging.
 * **Resend tags (AECI-1222).** Every Resend call, on both layers and the operator copy,
 * carries `tags` `tier` (`tierLabel(env)`) and `notification_id` (the registry id), built by
 * `lib/notifications/resend-tags.ts`. One Resend account serves every tier, so the delivery
 * webhook (`POST /api/webhooks/resend`) uses them to keep only its own tier's events and to
 * name the template. A BCC copy rides the same message, so it carries the same tags.
 *
 * **Sending switches (AECI-1224).** An operator can pause a pausable template, or the support
 * copy, on one tier from `/admin/email` (`lib/notifications/switches.ts`). Both layers read
 * the switches once per send call, in one D1 query, after the `skipped` check. A paused
 * template makes no Resend call, writes a `paused` ledger row per recipient, counts
 * `aeci.email.send{outcome:paused}` and logs a recipient hash. A paused support copy drops
 * the `EMAIL_BCC` blind copy and skips the separate `COPY:`. A failed read fails OPEN: the
 * send goes ahead, and the failure warns and counts `aeci.email.switches.unavailable`.
 */

import {
  orderedPairSlugs,
  type AttestationDetector,
  type RequestKind,
  type RequestTargetType,
} from '@aeci/shared';
import { discardResponseBody } from '@aeci/shared/response-drain';

import { logToPosthog, submitCount } from '../posthog';
import type { Db } from '../db/client';
import type { Env } from '../env';
import type { StuckRequestSummary } from './admin-alert';
import {
  escapeHtml,
  renderEmailHtml,
  renderEmailText,
  type EmailLayout,
  type EmailTableRow,
} from './email-layout';
import { recipientHash, sha256Hex } from './hash';
import {
  isProductionTier,
  partitionRecipients,
  tierLabel,
  tierSubject,
  type DeliveryPolicyEnv,
} from './notifications/delivery-policy';
import {
  getNotification,
  type DigestNotificationId,
  type EmailNotificationId,
  type TransactionalEmailId,
} from './notifications/registry';
import { createLinkTagger, type LinkTagger } from './notifications/link-tag';
import { resendTags } from './notifications/resend-tags';
import { readSendSwitches, SUPPORT_COPY_KEY, type SendSwitches } from './notifications/switches';
import {
  finalizeSend,
  ledgerDb,
  readProviderMessageId,
  recordSend,
  reserveSend,
  type LedgerEntity,
} from './notifications/send-ledger';
import { adminRequestUrl, environmentHost } from './request-links';

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

/**
 * - `sent`: Resend accepted it.
 * - `failed`: Resend answered with a non-2xx status, so it did not take the mail. A
 *   keyed send releases its dedupe key, so a retry can send.
 * - `unknown`: the call timed out or threw after the request may have reached Resend
 *   (AECI-1197 review). The mail may or may not have gone. A keyed send KEEPS its
 *   dedupe key, like a stuck `sending` row, so a retry is a `duplicate` and the
 *   recipient never gets two. Not a delivery a caller can count on, and not a failure
 *   a caller may retry. Each caller documents which way it leans.
 * - `skipped`: nothing to send with (no key, sender or recipient).
 * - `suppressed`: the tier delivery policy refused the recipient (AECI-1198). Only a
 *   non-production tier produces it. Like `skipped`, nothing was sent, so a caller
 *   that records delivery must not count it as delivered.
 * - `duplicate`: the send's `dedupeKey` is already held in `notification_sends`
 *   (AECI-1202), so this send made no Resend call. The earlier send owns delivery.
 *   Not a failure, and not delivered by this call: a caller must not count it as
 *   either. Only a send that passes a `dedupeKey` can produce it.
 * - `paused`: an operator paused this template on this tier (AECI-1224). Nothing was
 *   sent and no dedupe key is held, so a later run can send it after a resume. Like
 *   `suppressed`, a deliberate no-send: not a failure, not a delivery.
 */
export type EmailOutcome =
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'skipped'
  | 'suppressed'
  | 'duplicate'
  | 'paused';

/**
 * Stable template ids: the `template:` metric tag and the `docs/email.md` catalogue key.
 *
 * Derived from the notification registry (AECI-1199), so a template id cannot exist
 * without an entry there. To add a template, add its entry to
 * `lib/notifications/registry.ts` with channel `email` (or `email+portal`). The
 * name stays exported so existing callers compile.
 */
export type EmailTemplate = TransactionalEmailId;

const RESEND_URL = 'https://api.resend.com/emails';

/** The dud unsubscribe token in an operator copy's body. Matches no subscriber. */
const OPERATOR_COPY_TOKEN = 'operator-copy';

/** Cap on how long we wait for Resend before giving up (resolves to `'unknown'`). */
const TIMEOUT_MS = 5000;

/** A rendered email body: the text part and, usually, the HTML part. */
export interface EmailContent {
  text: string;
  html?: string;
}

/**
 * Renders a body with every site link passed through `link` (AECI-1209). Called once
 * the ledger row is reserved, so `link` can carry that row's id as `n`. Pure: it may
 * be called more than once for one send.
 */
export type RenderEmail = (link: LinkTagger) => EmailContent;

/**
 * The body of a send: either `render`, which receives the link tagger, or a static
 * `text`/`html` whose links are never tagged. Every template helper below uses
 * `render`. The static form is for a body with no site link in it.
 */
type SendBody =
  | { render: RenderEmail; text?: never; html?: never }
  | { render?: never; text: string; html?: string };

type SendInput = SendBody & {
  to: string;
  subject: string;
  template: EmailTemplate;
  /** Extra MIME headers (e.g. `List-Unsubscribe`) forwarded to Resend verbatim. Never tagged. */
  headers?: Record<string, string>;
  /**
   * Body for the separate operator copy of a send that carries `List-Unsubscribe`.
   * Same layout as the recipient's body, but rendered with a dud unsubscribe token.
   * Absent on such a send → no operator copy at all. See `sendOperatorCopy`. The copy
   * is its own registry entry, so it names its own id.
   */
  operatorCopy?: { notification: TransactionalEmailId } & SendBody;
  /**
   * Idempotency key for the send ledger (AECI-1202), e.g. `{template}:{entity}:{day}`.
   * A second send with a key that is already held resolves to `'duplicate'` with no
   * Resend call. A failed send releases its key. Absent → never deduplicated.
   */
  dedupeKey?: string;
  /** What the mail is about, stored on the ledger row. */
  entity?: LedgerEntity;
};

/**
 * The ledger fields a per-template helper forwards to {@link sendTransactionalEmail}
 * (AECI-1203). The caller owns the key, because only the caller knows what "the same
 * event" means for its trigger.
 */
export type SendDedupe = Pick<SendInput, 'dedupeKey' | 'entity'>;

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
  const db = ledgerDb(c.env);
  const row = {
    notificationId: input.template,
    recipientHash: await hashRecipient(input.to),
    tier: tierLabel(c.env),
    entity: input.entity,
  };
  if (!apiKey || !from || !input.to) {
    emit(c, 'skipped', input.template);
    await recordSend(db, { ...row, outcome: 'skipped' });
    return 'skipped';
  }

  // The operator's sending switches (AECI-1224): one read, fail-open.
  const switches = await readSendSwitches(db, [input.template, SUPPORT_COPY_KEY]);
  if (!switches.available) {
    warn(c, `sending switches unreadable for ${input.template}, sending anyway`);
    emitSwitchesUnavailable(c, 'transactional');
  }
  if (switches.isPaused(input.template)) {
    await logPaused(console, input.template, c.env, [input.to]);
    emit(c, 'paused', input.template);
    await recordSend(db, { ...row, outcome: 'paused' });
    return 'paused';
  }
  const supportCopy = !switches.isPaused(SUPPORT_COPY_KEY);

  // The tier delivery policy (AECI-1198): outside production, an outside recipient
  // gets nothing. No fetch, so no operator copy either.
  //
  // The rule comes from the registry entry (AECI-1199). Both rules run the same
  // allowlist, on purpose. `production-external` is what the allowlist is for.
  // `any-tier` is operator mail, whose recipients are internal inboxes, so the
  // allowlist passes them on every tier and the result is the same. Keeping one
  // policy means a misconfigured operator var that points outside is still caught.
  // `registry.spec.ts` asserts that every `any-tier` email entry is operator mail.
  const { envRule } = getNotification(input.template);
  if (partitionRecipients(c.env, [input.to]).suppressed.length > 0) {
    await logSuppressed(console, input.template, envRule, c.env, [input.to]);
    emit(c, 'suppressed', input.template);
    await recordSend(db, { ...row, outcome: 'suppressed' });
    return 'suppressed';
  }

  // Reserve before the Resend call (AECI-1202). A held dedupe key means an earlier
  // send owns this mail: no fetch, no operator copy.
  const reservation = await reserveSend(db, { ...row, dedupeKey: input.dedupeKey });
  if (reservation.duplicate) {
    emit(c, 'duplicate', input.template);
    return 'duplicate';
  }
  const subject = tierSubject(c.env, input.subject);

  // A send with an unsubscribe header never blind-copies: a bcc is the same
  // message, so the operator's copy would carry the recipient's one-click opt-out.
  // The operator gets a separate copy instead, after the recipient's send lands.
  const unsubscribable = Boolean(input.headers?.['List-Unsubscribe']);

  const requestBody = (content: EmailContent): string =>
    JSON.stringify({
      from,
      to: input.to,
      ...(unsubscribable ? {} : bccField(c.env, [input.to], supportCopy)),
      subject,
      text: content.text,
      ...(content.html ? { html: content.html } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      tags: resendTags(c.env, input.template),
    });

  // Render now, after the reserve, so every site link carries this send's ledger row
  // id as `n` (AECI-1209). A ledger that failed open gives no id, and the links then
  // carry the two `utm_*` params alone.
  const tagFor = (sendId: number | null): LinkTagger =>
    createLinkTagger({ siteUrl: c.env.PUBLIC_SITE_URL, templateId: input.template, sendId });
  let body: string;
  let untaggedBody: string;
  try {
    body = requestBody(renderBody(input, tagFor(reservation.rowId)));
    untaggedBody = reservation.rowId === null ? body : requestBody(renderBody(input, tagFor(null)));
  } catch (err) {
    // A render bug must not throw out of a send, or leave the key held by a row that
    // never sends. `failed` releases the key, like a refused send.
    warn(
      c,
      `Render of ${input.template} threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    emit(c, 'failed', input.template);
    await finalizeSend(db, reservation.rowId, { outcome: 'failed' });
    return 'failed';
  }

  // Every keyed send carries the header, ledger up or down. Resend dedupes only when
  // both attempts carry the same key, so a header sent only during a ledger outage
  // missed the attempt either side of it. The key holds a hash of the body, so an
  // identical retry dedupes and a re-send with a new body (after a refused send) gets
  // a new key, never a 409. The hash is of the body WITHOUT `n` (AECI-1209): each
  // attempt reserves its own row, so its `n` differs, and an attempt during a ledger
  // outage has none. Hashing the tagged body would give every attempt a new key.
  const idempotencyKey = input.dedupeKey
    ? await resendIdempotencyKey(c.env, input.dedupeKey, untaggedBody)
    : null;
  let providerMessageId: string | null;
  try {
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // An unread body holds its connection, which deadlocks a cron that sends a run
    // of emails (AECI-666). The 2xx branch reads it for the Resend id, to the end.
    // The failure branch does not read it, so it drains.
    if (!res.ok) {
      discardResponseBody(res);
      warn(c, `Resend ${input.template} returned ${res.status}`);
      emit(c, 'failed', input.template);
      await finalizeSend(db, reservation.rowId, { outcome: 'failed' });
      return 'failed';
    }
    providerMessageId = await readProviderMessageId(res);
    emit(c, 'sent', input.template);
  } catch (err) {
    // A timeout (AbortError) or a network error. The request may already have reached
    // Resend, so the mail may be out. `unknown` keeps the dedupe key held, so a retry
    // is a `duplicate`, never a second mail (AECI-1197 review). Non-fatal either way.
    warn(
      c,
      `Resend ${input.template} call did not complete, outcome unknown: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    emit(c, 'unknown', input.template);
    await finalizeSend(db, reservation.rowId, { outcome: 'unknown' });
    return 'unknown';
  }
  await finalizeSend(db, reservation.rowId, { outcome: 'sent', providerMessageId });
  if (unsubscribable) await sendOperatorCopy(c, apiKey, from, input, switches);
  return 'sent';
}

/** The body of a send, from its render callback or its static text. */
function renderBody(body: SendBody, link: LinkTagger): EmailContent {
  if (body.render) return body.render(link);
  return { text: body.text ?? '', ...(body.html ? { html: body.html } : {}) };
}

/**
 * The operator's copy of a send that carries `List-Unsubscribe`, as its own message
 * to the `EMAIL_BCC` list. The subject is prefixed `COPY: `. It has no unsubscribe
 * headers, and its body is the template's `operatorCopy`, rendered with a dud token,
 * so nothing in the operator's inbox can opt the real recipient out. Sent only after
 * the recipient's send succeeded. Never throws, and a failure only warns: the copy
 * is not counted in `aeci.email.send`, which stays one count per recipient send.
 * It does get ledger rows, one per operator address, under its own registry id.
 * Its links carry `utm_source` and `utm_campaign` but no `n` (AECI-1209).
 * A paused support copy (AECI-1224) makes no Resend call and writes `paused` rows instead.
 */
async function sendOperatorCopy(
  c: EmailContext,
  apiKey: string,
  from: string,
  input: SendInput,
  switches: SendSwitches,
): Promise<void> {
  // `bccField` already drops any address the tier policy refuses (AECI-1198). It is asked
  // for the list with the switch on, so a paused copy still records who it skipped.
  const to = bccField(c.env, [input.to], true).bcc;
  if (!to || !input.operatorCopy) return;
  const notification = input.operatorCopy.notification;
  if (switches.isPaused(SUPPORT_COPY_KEY)) {
    await logPaused(console, notification, c.env, to);
    await recordRecipients(ledgerDb(c.env), to, {
      notificationId: notification,
      tier: tierLabel(c.env),
      entity: input.entity,
      outcome: 'paused',
    });
    return;
  }
  // One Resend call to the whole operator list, so there is no per-recipient row
  // before the send and no `n`. The links carry the copy's own id as the campaign
  // (AECI-1209). A render bug records a `failed` copy rather than throwing.
  let content: EmailContent | null = null;
  try {
    content = renderBody(
      input.operatorCopy,
      createLinkTagger({ siteUrl: c.env.PUBLIC_SITE_URL, templateId: notification, sendId: null }),
    );
  } catch (err) {
    warn(c, `Render of ${notification} threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  let outcome: 'sent' | 'failed' | 'unknown' = 'failed';
  let providerMessageId: string | null = null;
  if (content) {
    try {
      const res = await fetch(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to,
          subject: tierSubject(c.env, `COPY: ${input.subject}`),
          text: content.text,
          ...(content.html ? { html: content.html } : {}),
          tags: resendTags(c.env, notification),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        providerMessageId = await readProviderMessageId(res);
        outcome = 'sent';
      } else {
        discardResponseBody(res);
        warn(c, `Resend ${notification} returned ${res.status}`);
      }
    } catch (err) {
      outcome = 'unknown';
      warn(
        c,
        `Resend ${notification} did not complete, outcome unknown: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  await recordRecipients(ledgerDb(c.env), to, {
    notificationId: notification,
    tier: tierLabel(c.env),
    entity: input.entity,
    outcome,
    providerMessageId,
  });
}

// ─── Per-template helpers ──────────────────────────────────────────────────────
// en-US plain copy (emails are not i18n'd at launch — the CLAUDE.md i18n rule is
// for rendered `apps/web` templates). Each builds subject/text/html and returns the
// `EmailOutcome` from the low-level send.

/**
 * What the reviewer submitted, as the submit route holds it after the commit. Feeds both
 * the reviewer's confirmation and the operator's moderation alert, so the two can never
 * describe different reviews.
 */
export interface SubmittedReviewSummary {
  reviewId: string;
  productName: string;
  productSlug: string;
  ratingOverall: number;
  ratingOnboarding: number;
  title: string;
  body: string;
  roleAtCompany: string | null;
  reviewerFirm: string | null;
  yearsUsing: number | null;
  wouldRecommend: 'yes' | 'no' | 'maybe' | null;
}

const REVIEW_ROLE_LABELS: Record<string, string> = {
  practitioner: 'Practitioner',
  manager: 'Manager',
  IT: 'IT',
  exec: 'Executive',
  other: 'Other',
};

const RECOMMEND_LABELS: Record<'yes' | 'no' | 'maybe', string> = {
  yes: 'Yes',
  no: 'No',
  maybe: 'Maybe',
};

/** A review body is up to a few thousand characters. The reviewer's copy shows the
 *  opening so they can recognise it. The operator alert carries it whole. */
const REVIEW_EXCERPT_CHARS = 400;

function excerpt(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max).trimEnd()}…`;
}

/** The labelled facts of a submitted review. Optional fields appear only when given. */
function reviewRows(review: SubmittedReviewSummary, bodyMax: number): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Product', review.productName],
    ['Overall rating', `${review.ratingOverall} of 5`],
    ['Onboarding rating', `${review.ratingOnboarding} of 5`],
    ['Headline', review.title],
    ['Review', excerpt(review.body, bodyMax)],
  ];
  if (review.roleAtCompany) {
    rows.push(['Role', REVIEW_ROLE_LABELS[review.roleAtCompany] ?? review.roleAtCompany]);
  }
  if (review.reviewerFirm) rows.push(['Firm', review.reviewerFirm]);
  if (review.yearsUsing !== null) rows.push(['Years using', String(review.yearsUsing)]);
  if (review.wouldRecommend)
    rows.push(['Would recommend', RECOMMEND_LABELS[review.wouldRecommend]]);
  return rows;
}

/**
 * §11.1 "Review submission confirmation". `to` is the reviewer's verified email
 * (`session.email`); absent → silent skip.
 *
 * On the house layout. It names the product in the subject and heading, and repeats
 * what the reviewer submitted as a detail table, because a reviewer who writes several
 * reviews cannot otherwise tell the confirmations apart. The body is an excerpt here.
 * The CTA is the product page when `PUBLIC_SITE_URL` is set.
 */
export function sendReviewSubmittedEmail(
  c: EmailContext,
  opts: { to: string | undefined; review: SubmittedReviewSummary },
): Promise<EmailOutcome> {
  const { review } = opts;
  const url = productUrl(c.env, review.productSlug);
  const opening = `Thanks for reviewing ${review.productName} on AEC Integrations. Your review is now in moderation.`;
  const openingHtml = `Thanks for reviewing <strong>${escapeHtml(review.productName)}</strong> on AEC Integrations. Your review is now in moderation.`;
  const process =
    "We check every review by hand to keep the directory trustworthy. You'll hear from us again once it's approved and live.";
  const shared = (link: LinkTagger) => ({
    preheader: `We received your review of ${review.productName}.`,
    heading: `Your review of ${review.productName} is in moderation`,
    table: reviewRows(review, REVIEW_EXCERPT_CHARS),
    ...(url ? { cta: { label: `View ${review.productName}`, url: link(url) } } : {}),
  });
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'review-submitted',
    subject: `Your review of ${review.productName} is in moderation`,
    render: (link) => houseBody(shared(link), [opening, process], [openingHtml, process]),
  });
}

/**
 * Operator alert: a review is waiting in the moderation queue. Sent post-commit from
 * `POST /api/reviews`, beside the reviewer's confirmation. Recipient is
 * `ADMIN_ALERT_EMAIL` (the support inbox); absent → `'skipped'`, and the queue at
 * `/admin/reviews` stays the durable record.
 *
 * Carries the whole review and the toxicity score, so the operator can triage from the
 * inbox. The single CTA opens the moderation queue.
 */
export function sendReviewSubmittedAlert(
  c: EmailContext,
  opts: {
    review: SubmittedReviewSummary;
    reviewerEmail: string | undefined;
    /** `null` when the classifier was absent or failed open. */
    toxicityScore: number | null;
  },
): Promise<EmailOutcome> {
  const { review } = opts;
  const base = siteUrl(c.env);
  const host = environmentHost(c.env);
  const reviewer = opts.reviewerEmail?.trim() || 'unknown';
  const rows = reviewRows(review, Number.POSITIVE_INFINITY);
  rows.splice(1, 0, ['Reviewer', reviewer]);
  rows.push([
    'Toxicity score',
    opts.toxicityScore === null ? 'not scored' : String(opts.toxicityScore),
  ]);
  rows.push(['Review id', review.reviewId]);
  if (host) rows.push(['Environment', host]);
  const listing = productUrl(c.env, review.productSlug);

  const intro = `${reviewer} submitted a review of ${review.productName}. It is waiting for moderation.`;
  const introHtml = `${escapeHtml(reviewer)} submitted a review of <strong>${escapeHtml(review.productName)}</strong>. It is waiting for moderation.`;
  const shared = (link: LinkTagger) => ({
    preheader: intro,
    heading: `New review of ${review.productName}`,
    table: listing ? [...rows, ['Listing', link(listing)] as const] : rows,
    ...(base
      ? { cta: { label: 'Open the moderation queue', url: link(`${base}/admin/reviews`) } }
      : {}),
  });
  return sendTransactionalEmail(c, {
    to: c.env.ADMIN_ALERT_EMAIL ?? '',
    template: 'review-submitted-alert',
    subject: `[AECi] New review to moderate: ${review.productName}`,
    render: (link) => houseBody(shared(link), [intro], [introHtml]),
  });
}

/**
 * §11.1 "Review approved". On the house layout; the CTA is the product page when
 * `PUBLIC_SITE_URL` is configured.
 */
export function sendReviewApprovedEmail(
  c: EmailContext,
  opts: { to: string | undefined; productName: string; productSlug: string } & SendDedupe,
): Promise<EmailOutcome> {
  const url = productUrl(c.env, opts.productSlug);
  const opening = `Your review of ${opts.productName} is now published on AEC Integrations.`;
  const openingHtml = `Your review of <strong>${escapeHtml(opts.productName)}</strong> is now published on AEC Integrations.`;
  const thanks = 'Thanks for helping the AEC community choose better software.';
  const shared = (link: LinkTagger) => ({
    preheader: `Your review of ${opts.productName} is live.`,
    heading: `Your review of ${opts.productName} is live`,
    ...(url ? { cta: { label: 'View your review', url: link(url) } } : {}),
  });
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'review-approved',
    subject: `Your review of ${opts.productName} is now live`,
    render: (link) => houseBody(shared(link), [opening, thanks], [openingHtml, thanks]),
    dedupeKey: opts.dedupeKey,
    entity: opts.entity,
  });
}

/**
 * §11.1 "Review rejected — {reason}". On the house layout. Carries the moderator's
 * reason, and the review guidelines become the CTA when `PUBLIC_SITE_URL` is set.
 */
export function sendReviewRejectedEmail(
  c: EmailContext,
  opts: { to: string | undefined; productName: string; reason: string } & SendDedupe,
): Promise<EmailOutcome> {
  const base = siteUrl(c.env);
  const guidelines = base ? `${base}/legal/review-guidelines` : null;
  const opening = `Thanks for your review of ${opts.productName}. Before it can go live it needs a revision.`;
  const openingHtml = `Thanks for your review of <strong>${escapeHtml(opts.productName)}</strong>. Before it can go live it needs a revision.`;
  const reasonText = `Moderator note: ${opts.reason}`;
  const reasonHtml = `<em>${escapeHtml(opts.reason)}</em>`;
  const next = "You're welcome to submit an updated review that follows our review guidelines.";
  const shared = (link: LinkTagger) => ({
    preheader: `Your review of ${opts.productName} needs a revision.`,
    heading: `Your review of ${opts.productName} needs revision`,
    ...(guidelines ? { cta: { label: 'Read the review guidelines', url: link(guidelines) } } : {}),
  });
  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'review-rejected',
    subject: `Your review of ${opts.productName} needs revision`,
    render: (link) =>
      houseBody(shared(link), [opening, reasonText, next], [openingHtml, reasonHtml, next]),
    dedupeKey: opts.dedupeKey,
    entity: opts.entity,
  });
}

/** What the owning vendor's email says about one approved review (AECI-1180). */
export interface PublishedReviewForVendor {
  to: string;
  vendorSlug: string;
  reviewId: string;
  productName: string;
  productSlug: string;
  title: string;
  ratingOverall: number;
  ratingOnboarding: number;
  /** `vendor-review-published:{reviewId}:{profileId}`, one per seat. The caller owns it. */
  dedupeKey: string;
}

/**
 * `vendor-review-published` (AECI-1180 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.12):
 * tells an owning vendor's seat that a review of its product was approved.
 *
 * Sent post-commit from `PATCH /api/admin/reviews/:id` approve, to every unbanned
 * `vendor_admin` seat of every owning vendor, on every plan. On the house layout. It
 * names the product, quotes the review's headline and both ratings, and carries no
 * reviewer data. The one CTA is the product's Reviews screen in the portal, and it
 * is omitted when `PUBLIC_SITE_URL` is unset. The copy never says a plan affects
 * whether the review shows or where the product ranks.
 *
 * The headline is the reviewer's text, so its row is `{ plain: true }` and never
 * links. The ledger row's entity is the review, and the caller's per-seat dedupe key
 * makes a replayed approve a `duplicate` (AECI-1202).
 */
export function sendVendorReviewPublishedEmail(
  c: EmailContext,
  opts: PublishedReviewForVendor,
): Promise<EmailOutcome> {
  const reviews = vendorProductReviewsUrl(c.env, opts.vendorSlug, opts.productSlug);
  const lead = `A new review of ${opts.productName} was approved. It is now published on the product's AEC Integrations listing.`;
  const leadHtml = `A new review of <strong>${escapeHtml(opts.productName)}</strong> was approved. It is now published on the product's AEC Integrations listing.`;
  const where = 'You can read it in full on the Reviews screen of your vendor portal.';
  const shared = (link: LinkTagger) => ({
    preheader: `New review of ${opts.productName}: “${opts.title}”`,
    heading: `New review of ${opts.productName}`,
    table: [
      ['Headline', `“${opts.title}”`, { plain: true }],
      ['Overall rating', `${opts.ratingOverall} of 5`],
      ['Onboarding rating', `${opts.ratingOnboarding} of 5`],
    ] satisfies EmailTableRow[],
    ...(reviews ? { cta: { label: 'Read the review', url: link(reviews) } } : {}),
  });
  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'vendor-review-published',
    subject: `New review of ${opts.productName} on AEC Integrations`,
    render: (link) => houseBody(shared(link), [lead, where], [leadHtml, where]),
    dedupeKey: opts.dedupeKey,
    entity: { type: 'review', id: opts.reviewId },
  });
}

/**
 * §9 "Claim approved" (`STAGE_2_VENDOR_PORTAL_SPEC.md` / AECI-528). The claimant's
 * vendor claim was granted, so their vendor account now has active management access. For an
 * `invited` claimant the account was provisioned silently (no GoTrue invite email, see
 * `createAuthUser`), so this IS the onboarding touch and the sign-in copy explains a
 * first login; a `linked` claimant already has an account. Links to the `/vendor`
 * portal when `PUBLIC_SITE_URL` is set. Recipient is the claim's `submitter_email`;
 * absent → silent skip. Copy stays account-scoped: access is a status, not a
 * product endorsement, and never touches ranking (no pay-for-placement).
 *
 * **The first template on the house layout** (`./email-layout`), which is why it reads
 * as a headline, two short blocks and one Forest button rather than four equal grey
 * paragraphs. The structural change is the CTA: the portal used to be an inline link
 * inside a sentence, and this is the one action the email exists to prompt. Every §9 AC
 * is unchanged — the vendor is named, capabilities are listed, the link appears only
 * when configured, the sign-in line still branches on the identity outcome, and the
 * account-status framing stays aligned with the public label.
 *
 * **Two variants since AECI-1215** (`STAGE_2_PAID_TIERS_SPEC.md` §13.6), one per plan
 * the operator chose. Only the capabilities block differs. Managed keeps the copy
 * above. Free says what a Free seat can do, which is edit company details and the
 * product listing, and names the plan so the claimant is not promised attestations
 * it cannot author. Both share the `claim-approved` template id: it is one event,
 * and the plan is in the audit row.
 */
export function sendClaimApprovedEmail(
  c: EmailContext,
  opts: {
    to: string | undefined;
    vendorName: string;
    invited: boolean;
    plan: 'free' | 'managed';
  },
): Promise<EmailOutcome> {
  const name = opts.vendorName.trim() || 'this vendor';
  const portal = portalUrl(c.env);

  // The button carries the destination, so the sign-in line no longer repeats the URL.
  // Without a portal link there is no button, and the copy has to stand alone.
  const signIn = opts.invited
    ? portal
      ? 'We created an account for your email address. Sign in by requesting a one-time sign-in link.'
      : 'We created an account for your email address. To sign in, request a one-time sign-in link from the AEC Integrations sign-in page.'
    : 'Sign in with your existing account to get started.';

  const accountStatus =
    "An active vendor account means this company can manage its AECi profile. It does not verify product quality or integration accuracy, and it doesn't affect search ranking or placement.";
  const capabilities =
    opts.plan === 'free'
      ? 'Your account is on the Free plan. From your vendor portal you can edit your company details and your product listing.'
      : 'From your vendor portal you can edit the company profile, submit data corrections, and add integration attestations.';

  const opening = `Your vendor account is now active on AEC Integrations and can manage the ${name} listing.`;
  const openingHtml = `Your vendor account is now active on AEC Integrations and can manage the <strong>${escapeHtml(name)}</strong> listing.`;

  const shared = (link: LinkTagger) => ({
    preheader: `Your vendor portal for ${name} is open.`,
    heading: `Your claim for ${name} is approved`,
    ...(portal ? { cta: { label: 'Go to your vendor portal', url: link(portal) } } : {}),
    note: accountStatus,
  });

  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'claim-approved',
    subject: `Your claim for ${name} is approved`,
    render: (link) =>
      houseBody(shared(link), [opening, capabilities, signIn], [openingHtml, capabilities, signIn]),
  });
}

/**
 * §11a "You're invited to manage <vendor> on AEC Integrations" (AECI-664).
 *
 * The one template on this surface sent on a CUSTOMER's command rather than
 * AECi's, which shapes three things:
 *
 * 1. **It names who invited them and which company.** A cold "you have been
 *    granted access" from a directory the recipient may not know is
 *    indistinguishable from phishing; the colleague's name and their own employer
 *    are what make it legible.
 * 2. **It states the address the link is bound to.** Redeeming requires signing in
 *    as exactly that address, so saying it up front turns the most likely failure
 *    (they are signed in as something else) into a instruction rather than a dead
 *    end.
 * 3. **It says the link expires.** An invite is not a standing grant.
 *
 * The token rides in the URL, which is safe here and nowhere else on this
 * surface: it identifies an invite, it does not authorize one. Redeeming demands
 * a signed-in session whose verified email matches, so a forwarded link, a
 * shared-inbox link, or a link a scanner prefetches grants nothing. See
 * `lib/vendor-seat-invites.ts`.
 *
 * Fail-open like every other send: an absent key/sender/recipient, or no
 * `PUBLIC_SITE_URL` to build the link from, is a silent `'skipped'`.
 *
 * **On the house layout since AECI-924, and of the migrated set this is the one that
 * most needed it.** The three points above are all defences against reading as
 * phishing, and the legacy shell undercut every one of them: bare grey paragraphs, no
 * logo, no sender named anywhere but the `From:`, and the redeem link as a naked inline
 * anchor. That is a description of a phishing email. The house shell puts the wordmark
 * in the body twice (image and text), and the redeem link becomes the single Forest CTA
 * with its URL spelled out underneath — which matters more here than anywhere else,
 * because the recipient is being asked to trust a link from a directory they may not
 * know.
 *
 * The binding and expiry lines stay as blocks rather than becoming table rows. They are
 * instructions, not facts to scan.
 */
export function sendVendorSeatInviteEmail(
  c: EmailContext,
  opts: {
    to: string | undefined;
    vendorName: string;
    invitedByName: string | null;
    token: string;
    expiresAt: string;
    /** The first send or an owner's re-send (AECI-927). Same template, two entries. */
    notification?: 'vendor-seat-invite' | 'vendor-seat-invite-resend';
  },
): Promise<EmailOutcome> {
  const name = opts.vendorName.trim() || 'a vendor';
  const link = seatInviteUrl(c.env, opts.token);
  // No link, no email. Mailing "you have been invited" with no way to act on it
  // is worse than silence — it strands the recipient with a claim they cannot
  // verify and no next step.
  if (!link) return Promise.resolve('skipped');

  const inviter = opts.invitedByName?.trim();
  const opening = inviter
    ? `${inviter} invited you to help manage ${name} on AEC Integrations.`
    : `You have been invited to help manage ${name} on AEC Integrations.`;
  const openingHtml = inviter
    ? `${escapeHtml(inviter)} invited you to help manage <strong>${escapeHtml(name)}</strong> on AEC Integrations.`
    : `You have been invited to help manage <strong>${escapeHtml(name)}</strong> on AEC Integrations.`;

  const capabilities =
    'A seat lets you edit the company profile, keep product details current, and add integration attestations.';
  // Was an em dash. The house layout removed this template's sign-off, so this was the
  // last one left, and PRODUCT.md bans them.
  const binding = `The invite is tied to ${opts.to ?? 'this address'}. Sign in with that address to accept it.`;
  const expiry = `This link expires on ${new Date(opts.expiresAt).toUTCString()}.`;

  const shared = (tag: LinkTagger) => ({
    preheader: opening,
    heading: `You're invited to manage ${name}`,
    cta: { label: 'Accept your invite', url: tag(link) },
    note: expiry,
  });

  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: opts.notification ?? 'vendor-seat-invite',
    subject: `You're invited to manage ${name} on AEC Integrations`,
    render: (tag) =>
      houseBody(
        shared(tag),
        [opening, capabilities, binding],
        [openingHtml, capabilities, escapeHtml(binding)],
      ),
  });
}

/**
 * Adapter for the `POST /api/vendor/seats/invites` send seam (AECI-664) — the
 * `sendClaimDecisionEmail` shape. Drops the `EmailOutcome`: the handler fires
 * this through `waitUntil` after the batch has already committed and never reads
 * the result, because a send failure must not un-create a committed invite (the
 * owner can revoke and re-send, and the roster shows it pending either way).
 *
 * Typed structurally so this file doesn't import the route's seam type; the
 * assignability is enforced where it is wired (`index.ts`).
 */
export async function sendSeatInvite(
  c: EmailContext,
  opts: {
    to: string;
    vendorName: string;
    invitedByName: string | null;
    token: string;
    expiresAt: string;
    notification: 'vendor-seat-invite' | 'vendor-seat-invite-resend';
  },
): Promise<void> {
  await sendVendorSeatInviteEmail(c, opts);
}

/**
 * §9 "Claim rejected" (`STAGE_2_VENDOR_PORTAL_SPEC.md` / AECI-528). Deliberately
 * NEUTRAL (the §9 AC): the reviewer's decision `reason` is an INTERNAL audit note —
 * recorded in the `audit_log` (admin-visible), never echoed to the claimant — so
 * nothing a reviewer types can leak. The claimant is told only that the claim
 * wasn't approved, and is invited to resubmit. Recipient is `submitter_email`;
 * absent → skip.
 *
 * **On the house layout since AECI-924.** It is the sibling of `claim-approved`, which
 * AECI-914 migrated, so leaving it behind meant the same claimant got a branded email
 * on approval and an unbranded one on rejection. That asymmetry reads as carelessness
 * precisely where the recipient is already being told no.
 *
 * **It carries NO CTA, deliberately.** The Forest button is the layout's one action,
 * and a rejection has no action to offer that the §9 AC permits: a "Submit a new claim"
 * button would press harder than the copy, which only says resubmission is welcome.
 * A layout with no `cta` renders no button and no paste-able URL, which is the whole
 * shape of this email — heading, two blocks, nothing to click.
 *
 * The reviewer's `reason` is still absent, and the migration must never become the
 * moment it acquires a `note` slot to sit in.
 */
export function sendClaimRejectedEmail(
  c: EmailContext,
  opts: { to: string | undefined; vendorName: string },
): Promise<EmailOutcome> {
  const name = opts.vendorName.trim() || 'this vendor';
  const resubmit =
    "If you represent this vendor, you're welcome to submit a new claim with more detail.";

  const opening = `Thank you for your claim for ${name}. After review, we weren't able to approve it.`;
  const openingHtml = `Thank you for your claim for <strong>${escapeHtml(name)}</strong>. After review, we weren't able to approve it.`;

  const shared = {
    preheader: `We reviewed your claim for ${name}.`,
    heading: `Your claim for ${name} was not approved`,
  };

  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'claim-rejected',
    subject: `Your claim for ${name} was not approved`,
    render: () => houseBody(shared, [opening, resubmit], [openingHtml, resubmit]),
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
    plan?: 'free' | 'managed';
  },
): Promise<void> {
  if (input.decision === 'approved') {
    await sendClaimApprovedEmail(c, {
      to: input.to,
      vendorName: input.targetName,
      invited: input.identityOutcome === 'invited',
      // The route always sets `plan` on approve. Managed is the fallback only so a
      // caller that predates AECI-1215 keeps today's copy.
      plan: input.plan ?? 'managed',
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

// ─── Attestation digests (§7.2 — AECI-302, digest since AECI-1204) ────────────
// Sent by `lib/attestation-notify.ts` after the daily sweep. ONE email per unmuted
// vendor seat per day, listing every due finding for that seat's vendor, and ONE
// ops digest per day to `ADMIN_ALERT_EMAIL`. Before AECI-1204 each finding was its
// own email to every seat, so 40 findings meant 40 emails per seat in one morning,
// on the same Resend account that sends sign-in links.
//
// Copy discipline (§6): never imply that attesting affects ranking or placement,
// never promise how fast a change appears, treat "Verified" strictly as an account
// status, and never quote an attestation note (AECI-1139: an email can be
// forwarded, and no note is public).

/** One due finding as the vendor digest describes it. Product names and slugs are
 *  the snapshot the detector captured, not a live read. */
export interface AttestationDigestFinding {
  detector: AttestationDetector;
  /** The `data_object` name, e.g. "RFIs". */
  dataObject: string;
  /** The endpoint the recipient's vendor owns. */
  product: string;
  /** The other endpoint. */
  counterpart: string;
  /** `integrations.mechanism_name`, when the row has one. */
  mechanismName: string | null;
  /** Both endpoint slugs, for the canonical pair link. */
  pairSlugs: readonly [string, string];
}

/** Most findings the vendor digest lists. The rest are counted and left to the
 *  portal's Messages list, which holds every one of them. */
export const DIGEST_LIST_LIMIT = 25;

/** " through Procore Connector", or nothing when the mechanism is unnamed. */
function viaMechanism(name: string | null): string {
  const trimmed = name?.trim();
  return trimmed ? ` through ${trimmed}` : '';
}

/**
 * The per-detector title and ask. These carry the substance of the four retired
 * per-finding templates (`attestation-silent-counterparty`, `-open-conflict`,
 * `-stale-version`, `-claim-denied`), cut to one line each:
 *
 * - silent-counterparty says plainly that silence renders as silence
 *   (`STAGE_2_SPEC.md` §8.1(4)), so the nudge informs rather than coerces.
 * - open-conflict is non-accusatory: a difference in description, not a defect.
 * - stale-version asks three ways, because "withdraw" is a legitimate answer.
 * - claim-denied states that the flow stays listed as unverified until AECi acts.
 */
function digestItem(f: AttestationDigestFinding): { title: string; ask: string } {
  switch (f.detector) {
    case 'silent-counterparty':
      return {
        title: `${f.counterpart} confirmed ${f.dataObject} with ${f.product}`,
        ask: 'Confirm it if it is accurate, or record your own position. Until both sides confirm, we show it as reported by one company only.',
      };
    case 'open-conflict':
      return {
        title: `You and ${f.counterpart} describe ${f.dataObject} differently`,
        ask: 'If your position has changed, update it. If not, no action is needed. We show the difference rather than picking a side.',
      };
    case 'stale-version':
      return {
        title: `Re-confirm your ${f.dataObject} record for ${f.product}`,
        ask: 'Re-confirm it, add the product versions it applies to, or withdraw it if it no longer holds. Any of the three is a good answer.',
      };
    case 'claim-denied':
      return {
        title: `${f.counterpart} says ${f.dataObject} does not move to ${f.product}`,
        ask: 'If you disagree, record your own position. If you agree, no action is needed. Until we act, the flow stays listed as unverified.',
      };
  }
}

/**
 * The vendor nudge digest (`attestation-digest`, AECI-1204): every due finding for
 * one vendor, to one seat, once a day.
 *
 * - **House layout.** One section per finding (title, the integration, what to do,
 *   the pair page), up to {@link DIGEST_LIST_LIMIT}, then a count of the rest. The
 *   single Forest CTA is the vendor portal, where every finding is listed.
 * - **One-click mute.** With a token and `PUBLIC_SITE_URL`, the footer links to the
 *   `/notifications/mute` confirm page, and the headers carry an RFC 8058 one-click
 *   `List-Unsubscribe` that POSTs `/api/notifications/nudges/mute?token=`. A send
 *   with that header never blind-copies the operator (see `sendTransactionalEmail`),
 *   and this template passes no `operatorCopy`, so the operator gets no copy.
 * - **Dedupe.** The caller passes `attestation-digest:{vendorId}:{profileId}:{day}`,
 *   so a same-day replay is a `duplicate` with no Resend call.
 */
export function sendAttestationDigestEmail(
  c: EmailContext,
  opts: {
    to: string;
    vendorId: string;
    vendorName: string | null;
    findings: readonly AttestationDigestFinding[];
    muteToken: string | null;
    dedupeKey: string;
  },
): Promise<EmailOutcome> {
  const company = opts.vendorName?.trim() || 'your company';
  const total = opts.findings.length;
  const listed = opts.findings.slice(0, DIGEST_LIST_LIMIT);
  const rest = total - listed.length;
  const portal = portalUrl(c.env);
  const base = siteUrl(c.env);
  const token = opts.muteToken;
  const mutePage =
    base && token ? `${base}/notifications/mute?token=${encodeURIComponent(token)}` : null;
  const oneClick =
    base && token
      ? `${base}/api/notifications/nudges/mute?token=${encodeURIComponent(token)}`
      : null;

  const first = listed[0] ? digestItem(listed[0]) : null;
  const subject =
    total === 1 && first ? first.title : `${total} integration records for ${company} need a look`;
  const heading =
    total === 1
      ? 'One integration record needs a look'
      : `${total} integration records need a look`;
  const lead = `Here is what we noticed on the integrations listed for ${company}. Each item says what we saw and what you can do about it.`;

  const sections = (link: LinkTagger) =>
    listed.map((f) => {
      const item = digestItem(f);
      const pair = pairUrl(c.env, f.pairSlugs[0], f.pairSlugs[1]);
      const rows: Array<readonly [string, string]> = [
        ['Integration', `${f.product} and ${f.counterpart}${viaMechanism(f.mechanismName)}`],
        ['What to do', item.ask],
      ];
      if (pair) rows.push(['How it reads now', link(pair)]);
      return { heading: item.title, rows };
    });

  const restText =
    rest > 0
      ? `And ${rest} more ${rest === 1 ? 'record' : 'records'}. Your vendor portal lists every one.`
      : null;
  const note = `You get this daily reminder email because you hold a seat for ${company} on AEC Integrations. Muting it affects your seat only. Seat invites, claim decisions and plan notices still arrive.`;

  // The mute page is an opt-out, so it is never tagged (`link-tag.ts`).
  const shared = (link: LinkTagger) => ({
    preheader: first && total === 1 ? first.title : lead,
    heading,
    sections: sections(link),
    ...(portal ? { cta: { label: 'Open your vendor portal', url: link(portal) } } : {}),
    note,
    ...(mutePage ? { noteLink: { label: 'Mute the daily reminder email', url: mutePage } } : {}),
  });

  const headers: Record<string, string> = {};
  if (oneClick) {
    headers['List-Unsubscribe'] = `<${oneClick}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'attestation-digest',
    subject,
    render: (link) =>
      houseBody(
        shared(link),
        [lead, ...(restText ? [restText] : [])],
        [escapeHtml(lead), ...(restText ? [escapeHtml(restText)] : [])],
      ),
    ...(oneClick ? { headers } : {}),
    dedupeKey: opts.dedupeKey,
    entity: { type: 'vendor', id: opts.vendorId },
  });
}

/** One ops-routed finding as the ops digest lists it. */
export interface AttestationOpsDigestFinding {
  detector: 'claim-denied' | 'open-conflict';
  dataObject: string;
  productA: string;
  productB: string;
  mechanismName: string | null;
  claimId: string;
  integrationId: string;
  pairSlugs: readonly [string, string];
}

/**
 * The AECi-facing half of the sweep (`attestation-ops-digest`, AECI-1204): every
 * ops-routed finding of the day, in ONE email per `ADMIN_ALERT_EMAIL` address. It
 * replaced `attestation-ops-alert`, which sent one email per finding.
 *
 * Two detectors route here, and each section names its own:
 *
 * - `claim-denied`: every voting vendor denies a claim. It then computes
 *   `unverified`, which looks the same as "nobody voted" on every surface, so
 *   without this mail the correction is lost. The counterparty vendor is told in its
 *   own digest.
 * - `open-conflict`: two vendors have disagreed past the threshold. Both are told
 *   in their own digests.
 *
 * No CTA, and no display cap: the action happens in the review app, and an ops row
 * that is not listed here is seen nowhere else. The caller passes
 * `attestation-ops-digest:{day}:{recipient hash}`.
 */
export function sendAttestationOpsDigestEmail(
  c: EmailContext,
  opts: {
    to: string;
    findings: readonly AttestationOpsDigestFinding[];
    dedupeKey: string;
  },
): Promise<EmailOutcome> {
  const total = opts.findings.length;
  const denied = opts.findings.filter((f) => f.detector === 'claim-denied').length;
  const conflicts = total - denied;
  const intro =
    'Today’s attestation findings that need AECi. A denied claim renders as unverified and is invisible on the site until someone corrects the curation. A standing conflict means two vendors still disagree past the notification threshold. Each vendor involved was told in its own digest.';

  const sections = (link: LinkTagger) =>
    opts.findings.map((f) => {
      const pair = pairUrl(c.env, f.pairSlugs[0], f.pairSlugs[1]);
      return {
        heading: `${f.detector === 'claim-denied' ? 'Vendor denied a claim' : 'Unresolved vendor conflict'}: ${f.dataObject} (${f.productA} / ${f.productB})`,
        rows: [
          ['Detector', f.detector],
          ['Mechanism', f.mechanismName?.trim() || '(unnamed)'],
          ['Claim', f.claimId],
          ['Integration', f.integrationId],
          ['Pair page', pair ? link(pair) : '(no PUBLIC_SITE_URL)'],
        ] as const,
      };
    });

  const heading = `Attestation findings: ${denied} denied, ${conflicts} in conflict`;
  const shared = (link: LinkTagger) => ({
    preheader: `${total} attestation ${total === 1 ? 'finding needs' : 'findings need'} AECi.`,
    heading,
    sections: sections(link),
  });

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'attestation-ops-digest',
    subject: `[AECi] ${heading}`,
    render: (link) => houseBody(shared(link), [intro], [escapeHtml(intro)]),
    dedupeKey: opts.dedupeKey,
  });
}

// ─── Entitlement term-expiry warnings (§7.2 — AECI-613) ───────────────────────
// Sent by the daily 11:00 UTC sweep (`lib/entitlement-expiry.ts`). The load-bearing
// copy rule is §7.3's: this is a WARNING, and the system never lapses anything on
// its own. Neither template may imply that vendor access is about to be switched
// off automatically, because it is not — deactivation stays a deliberate admin act
// (§5). Account access is also framed exactly as everywhere else,
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
  const portal = portalUrl(c.env);
  const phrase = expiryPhrase(opts.daysRemaining);
  const past = opts.daysRemaining < 0;

  const lead = past
    ? `Your vendor access term for ${name} on AEC Integrations reached its end date of ${opts.periodEndDay}. That was ${phrase}.`
    : `Your vendor access term for ${name} on AEC Integrations ends ${phrase}, on ${opts.periodEndDay}.`;
  // The reassurance is the point of the whole §7 decision. Say it plainly.
  const noLapse =
    "Nothing changes automatically. We don't switch access off when a term reaches its end date. This is a heads-up so you can decide, not a countdown.";
  const ask = 'To renew, or if the term dates look wrong, just reply to this email.';
  const stance =
    "An active vendor account means this company can manage its AECi profile. It does not verify product quality or integration accuracy, and it doesn't affect search ranking or placement.";

  const render = (link: LinkTagger): EmailContent => {
    const textParagraphs = [lead, noLapse, ask];
    const htmlParagraphs = [
      past
        ? `Your vendor access term for <strong>${escapeHtml(name)}</strong> on AEC Integrations reached its end date of ${escapeHtml(opts.periodEndDay)}. That was ${escapeHtml(phrase)}.`
        : `Your vendor access term for <strong>${escapeHtml(name)}</strong> on AEC Integrations ends ${escapeHtml(phrase)}, on ${escapeHtml(opts.periodEndDay)}.`,
      noLapse,
      ask,
    ];
    if (portal) {
      const tagged = link(portal);
      textParagraphs.push(`Your current status is on your vendor portal: ${tagged}`);
      htmlParagraphs.push(
        `Your current status is on <a href="${escapeHtml(tagged)}">your vendor portal</a>.`,
      );
    }
    textParagraphs.push(stance);
    htmlParagraphs.push(stance);
    return { text: toText(textParagraphs), html: toHtml(htmlParagraphs) };
  };

  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'entitlement-expiring',
    subject: past
      ? `Your vendor access term for ${name} has reached its end date`
      : `Your vendor access term for ${name} ends ${phrase}`,
    render,
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
      ? 'An ACTIVE entitlement is past its term end date. Nothing has been changed — the expiry sweep warns and never lapses (STAGE_2_PAID_TIERS_SPEC.md §7.3). Renew it or clear it deliberately from the vendor page under /admin/vendors.'
      : 'An active entitlement is approaching its term end date. Nothing will change on its own — the expiry sweep warns and never lapses (STAGE_2_PAID_TIERS_SPEC.md §7.3). Renew it or clear it deliberately from the vendor page under /admin/vendors.';

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
  opts: { to: string | undefined; token?: string | null } & SendDedupe,
): Promise<EmailOutcome> {
  const base = siteUrl(c.env);
  const browseUrl = base ? `${base}/products` : null;
  const intro =
    'Thanks for signing up. AEC Integrations is an independent directory and review platform for the software used across architecture, engineering, and construction. No vendor marketing, no pay-for-placement.';
  const what =
    'We organize tools by workflow stage and discipline, the way AEC actually works, not by generic software categories. And we keep product quality separate from onboarding experience, so you can judge software on what matters to your projects.';
  const browseLead =
    "The best next step is to browse the directory: see how tools connect, and where they don't, before you commit.";
  // AECI-1205: this used to promise "We'll also email you as new tools and reviews land
  // in the directory." No newsletter sender exists, so the fallback promises nothing.
  const fallback = browseLead;

  // Tokenized page link + one-click endpoint (preferred), else the mailto opt-out.
  const mailto = unsubscribeMailto(c.env);
  const token = opts.token ?? null;
  const oneClickUrl =
    base && token ? `${base}/api/unsubscribe?token=${encodeURIComponent(token)}` : null;

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

  // The body is rendered twice: once with the subscriber's token, once with a dud
  // for the operator copy. The dud keeps the layout identical, and the unsubscribe
  // page rejects it, so the operator's link cannot opt the subscriber out.
  //
  // Only the browse link is tagged. The unsubscribe page and the mailto are opt-outs,
  // and the tagger would leave them alone anyway (`link-tag.ts`).
  const body = (tok: string | null, link: LinkTagger): EmailContent => {
    const browse = browseUrl ? link(browseUrl) : null;
    const pageUrl = base && tok ? `${base}/unsubscribe?token=${encodeURIComponent(tok)}` : null;
    const unsubText = pageUrl
      ? `You are on the AEC Integrations mailing list. To leave it, unsubscribe here: ${pageUrl}`
      : mailto
        ? `You are on the AEC Integrations mailing list. To leave it, email ${mailto} with the subject unsubscribe.`
        : null;
    const unsubHtml = pageUrl
      ? `You are on the AEC Integrations mailing list. To leave it, <a href="${escapeHtml(pageUrl)}">unsubscribe</a>.`
      : mailto
        ? `You are on the AEC Integrations mailing list. To leave it, <a href="mailto:${escapeHtml(mailto)}?subject=unsubscribe">unsubscribe</a>.`
        : null;
    const textParagraphs = [
      intro,
      what,
      browse ? `${browseLead} Browse the directory: ${browse}` : fallback,
      ...(unsubText ? [unsubText] : []),
    ];
    const htmlParagraphs = [
      intro,
      what,
      browse ? `${browseLead} <a href="${escapeHtml(browse)}">Browse the directory</a>` : fallback,
      ...(unsubHtml ? [unsubHtml] : []),
    ];
    return { text: toText(textParagraphs), html: toHtml(htmlParagraphs) };
  };

  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'mailing-list-welcome',
    subject: 'Welcome to AEC Integrations',
    render: (link) => body(token, link),
    ...(Object.keys(unsubHeaders).length ? { headers: unsubHeaders } : {}),
    operatorCopy: {
      notification: 'mailing-list-welcome-operator-copy',
      render: (link) => body(token ? OPERATOR_COPY_TOKEN : null, link),
    },
    // A duplicate makes no Resend call, so it sends no operator copy either.
    dedupeKey: opts.dedupeKey,
    entity: opts.entity,
  });
}

/**
 * Human-readable gloss for a `StuckRequestSummary.reason`. The raw token is kept
 * beside it — that is what you grep PostHog for — but a bare `no_api_key` in an
 * inbox at 3am is not an instruction.
 */
const STUCK_REASON_HELP: Record<string, string> = {
  no_api_key: 'no LINEAR_API_KEY on this Worker. Set the secret; the next sweep self-heals.',
  http_error: 'Linear rejected the call. The key is likely revoked or under-scoped.',
  graphql_error: 'Linear refused the call. A board, label or project id has drifted.',
  timeout: 'Linear did not answer in time. Usually transient; check status.linear.app.',
  network: 'The call to Linear could not be made. Usually transient.',
  empty_response: 'Linear returned no data. Usually transient.',
  db_error: 'Linear was fine. The D1 read or the link-back write failed.',
  target_missing: 'The claimed product or vendor row is gone. Resolve this request by hand.',
  workflow_missing: 'The request has no workflow_instance row. Resolve this request by hand.',
  retry_errored: 'The retry threw before reaching Linear. See the sweep logs.',
};

/**
 * The request→Linear "persistent failure" admin alert (deferred from AECI-214).
 * Recipient is `ADMIN_ALERT_EMAIL`; called by `lib/admin-alert.ts`.
 *
 * AECI-854 rewrote this. Three things were wrong with the original:
 *
 *   1. It could not say WHY, because the §6.4 retrier returned `void`. "Still
 *      failing after retries" was the most it could manage, which is why the
 *      2026-09-10 stuck-claim incident needed a code read to diagnose.
 *   2. That wording was also sometimes false — a row the sweep could not rebuild
 *      is skipped, never retried, and was reported identically.
 *   3. It was the last operator alert still on the prose format, with
 *      `/admin/requests` as literal text rather than a link.
 *
 * Now: one section per stuck request, the cause and its gloss, and real links when
 * `PUBLIC_SITE_URL` is set. The subject carries the reason when every row shares one,
 * so triage can happen from the inbox list without opening anything.
 *
 * **On the house layout since AECI-924**, through the layout's `sections` (added for
 * this shape: an alert about N things rather than one event). Two changes came with it.
 * `/admin/requests` was a `Request queue` row repeated in every section; it is now the
 * single CTA, which is honest because the queue is one page whatever N is. And the
 * per-row `Listing` link is unchanged, including the rule that it appears only when the
 * target still resolves.
 */
export function sendStuckRequestAdminAlert(
  c: EmailContext,
  opts: { to: string | undefined; rows: readonly StuckRequestSummary[] } & SendDedupe,
): Promise<EmailOutcome> {
  const { rows } = opts;
  const plural = rows.length === 1 ? '' : 's';
  const base = siteUrl(c.env);

  const sections = (link: LinkTagger) =>
    rows.map((r) => {
      const name = r.targetName ?? '(target removed)';
      const detail: Array<[string, string]> = [
        ['Stuck', `${r.kind} ${r.targetType} "${name}"`],
        ['Age', formatStuckAge(r.ageMinutes)],
        ['Cause', describeStuckReason(r)],
        ['Request id', r.requestId],
      ];
      // Only when the target still resolves — a dead link on an alert about a
      // missing row would be its own small lie.
      if (base && r.targetSlug) {
        const path = r.targetType === 'vendor' ? 'vendors' : 'products';
        detail.push(['Listing', link(`${base}/${path}/${r.targetSlug}`)]);
      }
      return { heading: `${name} (${r.kind})`, rows: detail };
    });

  const intro =
    `The reconciliation sweep found ${rows.length} request${plural} whose Linear issue was ` +
    `never created. ${rows.length === 1 ? 'It is' : 'They are'} open with ` +
    `linear_issue_id=null and ${rows.length === 1 ? 'is' : 'are'} being retried every 15 minutes. ` +
    `Nothing is lost, but nobody was notified in Linear.`;

  // One queue for every row, however many there are, so a single CTA is honest here.
  // It replaces the per-row `Request queue` line, which repeated the same URL N times.
  const shared = (link: LinkTagger) => ({
    preheader: `${rows.length} request${plural} never reached Linear.`,
    heading: `${rows.length} request${plural} stuck in the Linear pipeline`,
    sections: sections(link),
    ...(base
      ? { cta: { label: 'Open the request queue', url: link(`${base}/admin/requests`) } }
      : {}),
  });

  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'stuck-request-alert',
    subject: `[AECi] ${rows.length} request${plural} stuck in the Linear pipeline${subjectReasonSuffix(rows)}`,
    render: (link) => houseBody(shared(link), [intro], [escapeHtml(intro)]),
    dedupeKey: opts.dedupeKey,
    entity: opts.entity,
  });
}

/** `62m` under an hour, `3h 10m` above — a four-digit minute count is unreadable. */
function formatStuckAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The raw reason token, its gloss, and whether a retry actually ran. */
function describeStuckReason(row: StuckRequestSummary): string {
  const retryNote = row.retried === false ? ' [not retried: the sweep could not rebuild it]' : '';
  if (!row.reason) return `unknown${retryNote}`;
  const help = STUCK_REASON_HELP[row.reason];
  // Colon, not an em dash: PRODUCT.md bans them and nothing lints this file for it.
  return help ? `${row.reason}${retryNote}: ${help}` : `${row.reason}${retryNote}`;
}

/** One un-started claim ticket, summarised for the founder digest (AECI-862). */
export interface StaleClaimSummary {
  requestId: string;
  kind: RequestKind;
  /** The human ticket key, e.g. `AECI-662`. */
  identifier: string;
  title: string;
  issueUrl: string | null;
  adminUrl: string | null;
  /** The workspace's display name for the state it is stuck in, e.g. "Backlog". */
  stateName: string | null;
  submitterEmail: string;
  targetName: string | null;
  ageMinutes: number;
}

/**
 * Founder escalation: claim tickets that exist in Linear and that nobody has
 * started (AECI-862 / `STAGE_1_PHASE_6_SPEC.md` §6.2).
 *
 * A sibling of `sendStuckRequestAdminAlert` above, and deliberately a SEPARATE
 * message with a separate recipient. That one means the pipeline is broken and
 * goes to the operator who can fix it. This one means the pipeline worked and the
 * humans did not, so it goes to `FOUNDER_ALERT_EMAIL`. Merging them would bury a
 * business-response problem inside an infrastructure alert.
 *
 * Band-throttled by the caller, not here (`lib/alert-bands.ts`): first as the
 * ticket crosses 24 hours, then once a day. Absent `FOUNDER_ALERT_EMAIL` or
 * `RESEND_API_KEY` yields `'skipped'`, like every send in this file.
 *
 * Every row carries both links, because the two answer different questions: the
 * Linear URL is where you accept the work, the admin URL is where you see the
 * claimant's evidence.
 *
 * **On the house layout since AECI-924**, through `sections`. The per-ticket links stay
 * in the rows for the reason just given, and because with N tickets there is no single
 * one to promote to the button. The CTA is `/admin/claims`, the same page whatever N is.
 * `Ticket` also split into `Ticket` + `Title`: they were joined by an em dash PRODUCT.md
 * bans, and they are used differently anyway, since the identifier is what you paste
 * into Linear and the title is what you read.
 */
export function sendStaleClaimTicketAlert(
  c: EmailContext,
  opts: { to: string | undefined; rows: readonly StaleClaimSummary[] } & SendDedupe,
): Promise<EmailOutcome> {
  const { rows } = opts;
  const plural = rows.length === 1 ? '' : 's';

  // `adminUrl` is built upstream (`claim-stale-check.ts`) and is ours, so it is tagged.
  // `issueUrl` is Linear's, off our origin, so the tagger leaves it alone.
  const sections = (link: LinkTagger) =>
    rows.map((r) => {
      const name = r.targetName ?? '(target removed)';
      const detail: Array<[string, string]> = [
        // Two rows, not one joined by an em dash: the identifier is what you paste into
        // Linear and the title is what you read, and PRODUCT.md bans the dash anyway.
        ['Ticket', r.identifier],
        ['Title', r.title],
        ['Waiting', formatStuckAge(r.ageMinutes)],
        ['Still in', r.stateName ?? 'an un-started state'],
        ['Claimant', r.submitterEmail],
        ['Request id', r.requestId],
      ];
      if (r.issueUrl) detail.push(['Linear', r.issueUrl]);
      if (r.adminUrl) detail.push(['Administer', link(r.adminUrl)]);
      return { heading: `${name} (${r.kind})`, rows: detail };
    });

  const intro =
    `${rows.length} claim ticket${plural} ${rows.length === 1 ? 'has' : 'have'} been open for more ` +
    `than 24 hours without anyone starting ${rows.length === 1 ? 'it' : 'them'}. ` +
    `The ticket${plural} exist${rows.length === 1 ? 's' : ''} in Linear and nothing is broken. ` +
    `${rows.length === 1 ? 'A vendor is' : 'Vendors are'} waiting on a reply.`;

  // The per-ticket links stay in the rows: with N tickets there is no single one to
  // promote. The CTA is the queue, which is the same page whatever N is.
  const base = siteUrl(c.env);
  const shared = (link: LinkTagger) => ({
    preheader: `${rows.length} vendor${plural} waiting on a reply.`,
    heading: `${rows.length} claim ticket${plural} un-started after 24 hours`,
    sections: sections(link),
    ...(base ? { cta: { label: 'Open the claim queue', url: link(`${base}/admin/claims`) } } : {}),
  });

  return sendTransactionalEmail(c, {
    to: opts.to ?? '',
    template: 'stale-claim-ticket-alert',
    subject: `[AECi] ${rows.length} claim ticket${plural} un-started after 24h`,
    render: (link) => houseBody(shared(link), [intro], [escapeHtml(intro)]),
    dedupeKey: opts.dedupeKey,
    entity: opts.entity,
  });
}

/** ` (no_api_key)` when every row shares one cause, else empty. Systemic causes are
 *  the common case, and naming one in the subject is the whole triage. */
function subjectReasonSuffix(rows: readonly StuckRequestSummary[]): string {
  const reasons = new Set(rows.map((r) => r.reason ?? 'unknown'));
  if (reasons.size !== 1) return '';
  const [only] = [...reasons];
  return only === 'unknown' ? '' : ` (${only})`;
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

/**
 * Operator alert: a fresh mailing-list signup (`POST /api/subscribe`, on a real
 * insert — not the idempotent already-listed no-op).
 *
 * **On the house layout (`lib/email-layout.ts`), not the old `opsTable()` grid.** The
 * facts move into the layout's `table`, which draws them hairline-separated and links
 * any row whose value is a bare URL — so the `Referrer` row is now clickable instead of
 * being a string the operator copy-pastes. The plain-text part is unchanged: the same
 * `Key: value` block `opsText()` emitted, under the heading.
 *
 * The single Forest CTA is `/admin/audience`, which is this alert's screen equivalent
 * (AECI-586) and the one action it prompts. No `PUBLIC_SITE_URL` means no button, which
 * is the same degradation every other migrated template takes.
 */
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
  } & SendDedupe,
): Promise<EmailOutcome> {
  const rows: Array<[string, string]> = [
    ['Email', opts.email],
    ['Location', `${opts.city ?? '—'}, ${opts.region ?? '—'}, ${opts.country ?? '—'}`],
    ['Organization', opts.asOrganization ?? '—'],
    ['Source', opts.utmSource ?? 'direct'],
    ['Campaign', opts.utmCampaign ?? '—'],
    ['Referrer', opts.referrer ?? '—'],
  ];
  const base = siteUrl(c.env);
  const intro = 'Someone just joined the AEC Integrations mailing list.';
  // The `Referrer` row is a recorded fact, not a link we built, so it is not tagged.
  const shared = (link: LinkTagger) => ({
    preheader: `${opts.email} joined the mailing list.`,
    heading: 'New mailing list signup',
    table: rows,
    ...(base
      ? { cta: { label: 'Open the audience panel', url: link(`${base}/admin/audience`) } }
      : {}),
  });

  return sendTransactionalEmail(c, {
    to: c.env.ADMIN_ALERT_EMAIL ?? '',
    template: 'landing-signup',
    subject: '[AECi] New mailing list signup',
    render: (link) => houseBody(shared(link), [intro], [escapeHtml(intro)]),
    dedupeKey: opts.dedupeKey,
    entity: opts.entity,
  });
}

/**
 * Operator alert: someone submitted a vendor claim (`POST /api/requests/claim`).
 *
 * Fired fire-and-forget via `ctx.waitUntil` AFTER the atomic commit, so a mail
 * failure can never roll back an accepted claim or delay the `201` — same posture as
 * every other send here. Recipient is `CLAIM_ALERT_EMAIL`; absent → `'skipped'`.
 *
 * **It is sequenced after the Linear issue, not beside it (AECI-861).** Until then
 * `createRequest` fired this in a `waitUntil` that raced
 * `createLinearIssueForRequest`, so the mail could not name the issue it was
 * telling you about — the operator got "a claim landed" and then went hunting the
 * board for it. The send site now chains off the create's `LinearIssueOutcome`, so
 * `linearIssueUrl` is populated on the happy path and `null` when creation failed,
 * which the body reports as a pending retry rather than omitting.
 *
 * The `environment` + `adminUrl` pair comes from `lib/request-links.ts`, the same
 * source the Linear description uses (AECI-860), so the ticket and the email can
 * never disagree about which deployment this was.
 *
 * Corrections (`POST /api/requests/correction`) deliberately do NOT alert: they share
 * `createRequest`, but a correction is a low-stakes data fix while a claim asserts
 * control of a listing and starts the verification path. Both still create a Linear
 * issue, which remains the durable record.
 *
 * Carries the two §6.8 admin signals the reviewer would otherwise have to look up —
 * `domain_match` (submitter email domain vs the target vendor's website) and whether
 * this duplicates an open request. en-US, never i18n'd.
 *
 * **On the house layout since AECI-924**, and the first operator alert to be. AECI-914
 * had left all seven of them on `opsTable()` as an open question, on the argument that
 * a data table for one reader is not a brand surface. This one is: it is the first mail
 * a human reads on the claim intake path, and it goes to a shared support inbox where
 * an unbranded `border="1"` grid is indistinguishable from a script's output.
 *
 * Two structural changes came with the shell. The facts move into the layout's `table`,
 * which renders them hairline-separated rather than boxed and links any row whose value
 * is a bare URL. And the `/admin/claims/:id` deep link becomes the single Forest CTA
 * instead of an `Administer` row, because reviewing the claim is the one action this
 * email exists to prompt. No `PUBLIC_SITE_URL` means no button and no link rows, exactly
 * as it previously meant no link rows.
 *
 * The plain-text part is materially unchanged: `renderEmailText` emits the same
 * `Key: value` block `opsText` did, under a heading.
 */
export function sendClaimSubmittedNotification(
  c: EmailContext,
  opts: {
    requestId: string;
    /** Display name of the claimed vendor/product. */
    targetName: string;
    /** `'product'` or `'vendor'` — decides the listing URL below. */
    targetType: RequestTargetType;
    slug: string;
    submitterEmail: string;
    submitterName: string | null;
    submitterRole: string | null;
    /** AECI-847 identity signal: the claimant's own LinkedIn profile, or null when
     *  they skipped the optional field. */
    submitterLinkedinUrl: string | null;
    /** §6.8 signal: `match` | `no_match` | `pending`. */
    domainMatch: string;
    /** §7.2 signal: the id of an open request this appears to duplicate. */
    duplicateOfRequestId: string | null;
    /** AECI-861: the created issue's web permalink, or `null` when creation failed
     *  and the §6.7 sweep still owes a retry. Never omitted — "not created yet" is
     *  itself the thing the operator needs to know. */
    linearIssueUrl?: string | null;
  } & SendDedupe,
): Promise<EmailOutcome> {
  const base = siteUrl(c.env);
  const host = environmentHost(c.env);
  const adminUrl = adminRequestUrl(c.env, 'claim', opts.requestId);
  const rows: Array<[string, string]> = [
    ['Claimed', `${opts.targetName} (${opts.targetType})`],
    ['Submitter', opts.submitterEmail],
    ['Name', opts.submitterName ?? '—'],
    ['Role', opts.submitterRole ?? '—'],
    ['LinkedIn', opts.submitterLinkedinUrl ?? 'not supplied'],
    ['Domain match', opts.domainMatch],
    ['Possible duplicate', opts.duplicateOfRequestId ?? 'no'],
    ['Request id', opts.requestId],
  ];
  if (host) rows.push(['Environment', host]);
  // `LINEAR_API_KEY` is set on production only. On any other tier without it, no
  // retry will ever link the request, so promising one would be false (AECI-1198).
  const linearUnconfigured = !isProductionTier(c.env) && !c.env.LINEAR_API_KEY;
  rows.push([
    'Linear issue',
    opts.linearIssueUrl ??
      (linearUnconfigured
        ? 'not created, Linear is not configured on this tier'
        : 'not created yet. The reconciliation sweep retries it, and the link appears on the request in the admin console. No second email is sent.'),
  ]);
  // The `LinkedIn` row is the claimant's own URL, off our origin, so it is not tagged.
  const linkRows = (link: LinkTagger): Array<[string, string]> => {
    if (!base) return [];
    const path = opts.targetType === 'vendor' ? 'vendors' : 'products';
    return [
      ['Review queue', link(`${base}/admin/claims`)],
      ['Listing', link(`${base}/${path}/${opts.slug}`)],
    ];
  };

  const intro = `${opts.submitterEmail} submitted a claim for ${opts.targetName}.`;
  const introHtml = `${escapeHtml(opts.submitterEmail)} submitted a claim for <strong>${escapeHtml(opts.targetName)}</strong>.`;
  const shared = (link: LinkTagger) => ({
    preheader: intro,
    heading: `New claim for ${opts.targetName}`,
    table: [...rows, ...linkRows(link)],
    ...(adminUrl ? { cta: { label: 'Review the claim', url: link(adminUrl) } } : {}),
  });

  return sendTransactionalEmail(c, {
    to: c.env.CLAIM_ALERT_EMAIL ?? '',
    template: 'claim-submitted-alert',
    subject: `[AECi] New vendor claim: ${opts.targetName}`,
    render: (link) => houseBody(shared(link), [intro], [introHtml]),
    dedupeKey: opts.dedupeKey,
    entity: opts.entity,
  });
}

/** Why a contest reached AECi rather than the owner (§11b.4), for the alert body. */
export type ContestAlertRouteReason =
  | 'owner-field'
  | 'unclaimed'
  | 'owner-seat-lapsed'
  | 'owner-cannot-decide';

const CONTEST_ROUTE_REASON_TEXT: Record<ContestAlertRouteReason, string> = {
  'owner-field': 'Ownership contests always go to AECi',
  unclaimed: 'No vendor has claimed this integration',
  'owner-seat-lapsed': 'The owner has no active seat',
  'owner-cannot-decide': 'The owner cannot decide this field on a connector-powered row',
};

/**
 * Operator alert: a vendor filed an integration field contest that routes to AECi
 * (`POST /api/vendor/integrations/:id/contests`, AECI-1132).
 *
 * Fired fire-and-forget via `ctx.waitUntil` AFTER the submit batch commits, so a mail
 * failure can never roll back the contest or delay the `201`. Only an AECi-routed
 * submit sends it. An owner-routed one already reaches its decider through the portal
 * notification (§11b.8). Recipient is `CLAIM_ALERT_EMAIL`; absent → `'skipped'`.
 *
 * The values arrive already labelled: an `owner` value is a vendor id, and the caller
 * resolves it to a name. `null` renders as `none`, because "nobody owns it" is the fact
 * an owner-unknown contest is about. The single CTA is `/admin/contests`, the queue
 * where AECi decides it. There is no per-contest route, so the contest id row is what
 * the operator matches there.
 */
export function sendContestSubmittedNotification(
  c: EmailContext,
  opts: {
    contestId: string;
    integrationName: string;
    field: string;
    currentValue: string | null;
    proposedValue: string | null;
    reason: string;
    submitterVendorName: string;
    routeReason: ContestAlertRouteReason;
    /** Both endpoint slugs, for the pair-page link, or `null` when unresolved. */
    pairSlugs: readonly [string, string] | null;
  },
): Promise<EmailOutcome> {
  const base = siteUrl(c.env);
  const host = environmentHost(c.env);
  const isOwner = opts.field === 'owner';
  const rows: Array<[string, string]> = [
    ['Integration', opts.integrationName],
    ['Field', opts.field],
    [isOwner ? 'Owner on file' : 'Current value', opts.currentValue ?? 'none'],
    [isOwner ? 'Proposed owner' : 'Proposed value', opts.proposedValue ?? 'none'],
    ['Submitted by', opts.submitterVendorName],
    ['Reason given', opts.reason],
    ['Why AECi decides', CONTEST_ROUTE_REASON_TEXT[opts.routeReason]],
    ['Contest id', opts.contestId],
  ];
  if (host) rows.push(['Environment', host]);
  const pair = opts.pairSlugs ? pairUrl(c.env, opts.pairSlugs[0], opts.pairSlugs[1]) : null;

  const subject = isOwner
    ? `[AECi] Ownership contest: ${opts.integrationName}`
    : `[AECi] Field contest: ${opts.field} on ${opts.integrationName}`;
  const intro = isOwner
    ? `${opts.submitterVendorName} contested who owns ${opts.integrationName}. AECi decides it.`
    : `${opts.submitterVendorName} contested the ${opts.field} of ${opts.integrationName}. AECi decides it.`;
  const introHtml = isOwner
    ? `${escapeHtml(opts.submitterVendorName)} contested who owns <strong>${escapeHtml(opts.integrationName)}</strong>. AECi decides it.`
    : `${escapeHtml(opts.submitterVendorName)} contested the ${escapeHtml(opts.field)} of <strong>${escapeHtml(opts.integrationName)}</strong>. AECi decides it.`;
  const shared = (link: LinkTagger) => ({
    preheader: intro,
    heading: isOwner
      ? `Ownership contest on ${opts.integrationName}`
      : `Field contest on ${opts.integrationName}`,
    table: pair ? [...rows, ['Pair page', link(pair)] as const] : rows,
    ...(base
      ? { cta: { label: 'Open the contest queue', url: link(`${base}/admin/contests`) } }
      : {}),
  });

  return sendTransactionalEmail(c, {
    to: c.env.CLAIM_ALERT_EMAIL ?? '',
    template: 'contest-submitted-alert',
    subject,
    render: (link) => houseBody(shared(link), [intro], [introHtml]),
  });
}

// ─── Protest and decline emails (AECI-1205, §11b.12.10) ──────────────────────
//
// Four templates. Before AECI-1205 every protest event reached a vendor only as a
// portal row, so an owner who did not log in lost its one chance to reply, and AECi
// learned of a protest only by opening `/admin/contests`. The vendor-facing three go
// to every unbanned `vendor_admin` seat of the vendor, one send per seat, and are not
// covered by the attestation nudge mute: each carries a deadline the vendor loses a
// right by missing. Every deadline renders with its time of day in UTC (§11b.12.10).

/** Vendor-facing names for the contestable fields. Raw ids stay in the operator alert. */
const CONTEST_FIELD_LABELS: Record<string, string> = {
  name: 'name',
  mechanism_kind: 'integration type',
  mechanism_name: 'connector name',
  direction: 'data direction',
  description: 'description',
  listing_url: 'listing page',
  docs_url: 'documentation link',
  website: 'website',
  mechanism_url: 'connector link',
  pricing_model: 'pricing model',
  maturity: 'maturity',
  owner: 'owner',
};

function contestFieldLabel(field: string): string {
  return CONTEST_FIELD_LABELS[field] ?? field.replace(/_/g, ' ');
}

const DEADLINE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** An ISO instant as `Oct 15, 2026, 2:30 PM UTC`. A deadline falls at an instant, so
 *  the date alone could be read as the whole day (§11b.12.10). */
export function formatDeadline(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  // Newer ICU puts a narrow no-break space before AM/PM. Plain spaces read the same
  // everywhere, and keep the subject line greppable.
  return `${DEADLINE_FORMAT.format(at).replace(/\s/g, ' ')} UTC`;
}

/** The contest a protest or decline email is about, as the caller resolved it. */
export interface ContestEmailFacts {
  contestId: string;
  integrationName: string;
  field: string;
  currentValue: string | null;
  proposedValue: string | null;
  /** Both endpoint slugs, for the pair-page link, or `null` when unresolved. */
  pairSlugs: readonly [string, string] | null;
}

/** One seat of the vendor a vendor-facing protest email goes to. */
export interface ContestSeatRecipient {
  to: string;
  vendorId: string;
  /** For the `/vendor/{slug}/messages` link. `null` drops the button. */
  vendorSlug: string | null;
  vendorName: string | null;
}

/** The portal page that lists a vendor's field contests (§6.5 Messages), or `null`. */
function vendorMessagesUrl(env: Env, vendorSlug: string | null): string | null {
  const base = siteUrl(env);
  return base && vendorSlug ? `${base}/vendor/${encodeURIComponent(vendorSlug)}/messages` : null;
}

/**
 * The facts table of a vendor-facing contest email. Every value a vendor could have
 * written is `{ plain: true }`, so it never renders as a link (AECI-1197 review). The
 * proposed value is the other vendor's text. The value on record and the integration
 * name can be vendor-edited too, on a vendor-owned row. Only the pair-page URL, which
 * AECi builds, links.
 */
function contestFactRows(env: Env, facts: ContestEmailFacts, link: LinkTagger): EmailTableRow[] {
  const rows: EmailTableRow[] = [
    ['Integration', facts.integrationName, PLAIN],
    ['Field', contestFieldLabel(facts.field)],
    ['Value on record', facts.currentValue ?? 'none', PLAIN],
    ['Proposed value', facts.proposedValue ?? 'none', PLAIN],
  ];
  const pair = facts.pairSlugs ? pairUrl(env, facts.pairSlugs[0], facts.pairSlugs[1]) : null;
  if (pair) rows.push(['Pair page', link(pair)]);
  return rows;
}

/** Row option for a vendor-written value: render it as text, never as a link. */
const PLAIN = { plain: true } as const;

const PROTEST_IS_ADVICE =
  'AEC Integrations reads both sides and gives its view. Its view is advice: the value on record stays unless you change it. Nothing about the review is public.';

/**
 * `contest-protest-opened`: the owner's seats learn that the submitter asked AECi to
 * review a contest the owner declined, or did not answer for 30 days, and that they
 * can reply once before `replyDueAt` (14 days, §11b.12.8).
 *
 * Sent from the protest file route after its batch commits, inside `waitUntil`. The
 * caller's key is `contest-protest-opened:{contestId}:{protestedAt}:{profileId}`, so a
 * replay is a `duplicate`, and a later protest on the same contest is a new send.
 */
export function sendContestProtestOpenedEmail(
  c: EmailContext,
  opts: ContestEmailFacts &
    ContestSeatRecipient & {
      submitterVendorName: string;
      basis: 'declined' | 'silence';
      protestReason: string;
      replyDueAt: string;
      dedupeKey: string;
    },
): Promise<EmailOutcome> {
  const company = opts.vendorName?.trim() || 'your company';
  const field = contestFieldLabel(opts.field);
  const due = formatDeadline(opts.replyDueAt);
  const messages = vendorMessagesUrl(c.env, opts.vendorSlug);
  const why =
    opts.basis === 'silence'
      ? `${opts.submitterVendorName} asked to change the ${field} of ${opts.integrationName}, and ${company} did not answer within 30 days. They have now asked AEC Integrations to review it.`
      : `${opts.submitterVendorName} disagrees with the decision ${company} made on their request to change the ${field} of ${opts.integrationName}. They have asked AEC Integrations to review it.`;
  const reply = `You can reply once, by ${due}. Reply under Field contests in Messages on your vendor portal.`;
  const shared = (link: LinkTagger) => ({
    preheader: `Reply by ${due}.`,
    heading: `Review requested on ${opts.integrationName}`,
    table: [
      ...contestFactRows(c.env, opts, link),
      ['Their reason', opts.protestReason, PLAIN] as const,
      ['Reply by', due] as const,
    ],
    ...(messages ? { cta: { label: 'Reply in Messages', url: link(messages) } } : {}),
    note: `You get this email because you hold a seat for ${company} on AEC Integrations.`,
  });
  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'contest-protest-opened',
    subject: `Reply by ${due}: review requested on ${opts.integrationName}`,
    render: (link) =>
      houseBody(
        shared(link),
        [why, reply, PROTEST_IS_ADVICE],
        [escapeHtml(why), escapeHtml(reply), escapeHtml(PROTEST_IS_ADVICE)],
      ),
    dedupeKey: opts.dedupeKey,
    entity: { type: 'integration_field_challenge', id: opts.contestId },
  });
}

/**
 * `contest-protest-reply-reminder`: the owner has not replied and the reply closes
 * within three days. Sent by the daily `protest_reply_reminder` cron. The caller's key
 * is `contest-protest-reply-reminder:{contestId}:{protestedAt}:{profileId}`, so the
 * three daily runs inside the window send it once per seat.
 */
export function sendContestProtestReplyReminderEmail(
  c: EmailContext,
  opts: ContestEmailFacts &
    ContestSeatRecipient & {
      submitterVendorName: string;
      replyDueAt: string;
      dedupeKey: string;
    },
): Promise<EmailOutcome> {
  const company = opts.vendorName?.trim() || 'your company';
  const field = contestFieldLabel(opts.field);
  const due = formatDeadline(opts.replyDueAt);
  const messages = vendorMessagesUrl(c.env, opts.vendorSlug);
  const lead = `${opts.submitterVendorName} asked AEC Integrations to review a contest on the ${field} of ${opts.integrationName}. ${company} has not replied yet.`;
  const reply = `You can reply once, until ${due}. After that the reply closes, and AEC Integrations decides on what it has.`;
  const shared = (link: LinkTagger) => ({
    preheader: `The reply closes ${due}.`,
    heading: `Your reply closes soon`,
    table: [...contestFactRows(c.env, opts, link), ['Reply by', due] as const],
    ...(messages ? { cta: { label: 'Reply in Messages', url: link(messages) } } : {}),
    note: `You get this email because you hold a seat for ${company} on AEC Integrations.`,
  });
  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'contest-protest-reply-reminder',
    subject: `Reminder: reply by ${due} on ${opts.integrationName}`,
    render: (link) => houseBody(shared(link), [lead, reply], [escapeHtml(lead), escapeHtml(reply)]),
    dedupeKey: opts.dedupeKey,
    entity: { type: 'integration_field_challenge', id: opts.contestId },
  });
}

/**
 * `protest-submitted-alert`: AECi learns a vendor filed a protest, which it must
 * decide in `/admin/contests` (§11b.12.11). Modelled on `contest-submitted-alert`:
 * house layout, a facts table, one CTA to the queue, to `CLAIM_ALERT_EMAIL`. The
 * caller's key is `protest-submitted-alert:{contestId}:{protestedAt}`.
 */
export function sendProtestSubmittedAlert(
  c: EmailContext,
  opts: ContestEmailFacts & {
    submitterVendorName: string;
    ownerVendorName: string;
    basis: 'declined' | 'silence';
    protestReason: string;
    evidenceCount: number;
    replyDueAt: string;
    dedupeKey: string;
  },
): Promise<EmailOutcome> {
  const base = siteUrl(c.env);
  const host = environmentHost(c.env);
  const rows: Array<[string, string]> = [
    ['Integration', opts.integrationName],
    ['Field', opts.field],
    ['Current value', opts.currentValue ?? 'none'],
    ['Proposed value', opts.proposedValue ?? 'none'],
    ['Filed by', opts.submitterVendorName],
    ['Owner', opts.ownerVendorName],
    [
      'Basis',
      opts.basis === 'silence'
        ? 'The owner did not answer the contest within 30 days'
        : 'The owner declined the contest',
    ],
    ['Reason given', opts.protestReason],
    ['Evidence links', String(opts.evidenceCount)],
    ['Owner reply due', formatDeadline(opts.replyDueAt)],
    ['Contest id', opts.contestId],
  ];
  if (host) rows.push(['Environment', host]);
  const pair = opts.pairSlugs ? pairUrl(c.env, opts.pairSlugs[0], opts.pairSlugs[1]) : null;

  const intro = `${opts.submitterVendorName} asked AECi to review the ${opts.field} of ${opts.integrationName}. The owner, ${opts.ownerVendorName}, can reply until the due date. AECi decides it.`;
  const introHtml = `${escapeHtml(opts.submitterVendorName)} asked AECi to review the ${escapeHtml(opts.field)} of <strong>${escapeHtml(opts.integrationName)}</strong>. The owner, ${escapeHtml(opts.ownerVendorName)}, can reply until the due date. AECi decides it.`;
  const shared = (link: LinkTagger) => ({
    preheader: intro,
    heading: `Protest on ${opts.integrationName}`,
    table: pair ? [...rows, ['Pair page', link(pair)] as const] : rows,
    ...(base
      ? { cta: { label: 'Open the contest queue', url: link(`${base}/admin/contests`) } }
      : {}),
  });
  return sendTransactionalEmail(c, {
    to: c.env.CLAIM_ALERT_EMAIL ?? '',
    template: 'protest-submitted-alert',
    subject: `[AECi] Protest: ${opts.field} on ${opts.integrationName}`,
    render: (link) => houseBody(shared(link), [intro], [introHtml]),
    dedupeKey: opts.dedupeKey,
    entity: { type: 'integration_field_challenge', id: opts.contestId },
  });
}

/**
 * `contest-declined-protest-window`: the submitter's seats learn the owner declined
 * their contest, and that they can ask AECi to review it until `protestClosesAt`
 * (30 days, §11b.12.8). Only an OWNER decline sends it: an AECi decline cannot be
 * protested. The caller's key is
 * `contest-declined-protest-window:{contestId}:{profileId}`. A contest is declined at
 * most once, so the contest id is the event.
 */
export function sendContestDeclinedProtestWindowEmail(
  c: EmailContext,
  opts: ContestEmailFacts &
    ContestSeatRecipient & {
      ownerVendorName: string;
      decisionNote: string | null;
      protestClosesAt: string;
      dedupeKey: string;
    },
): Promise<EmailOutcome> {
  const company = opts.vendorName?.trim() || 'your company';
  const field = contestFieldLabel(opts.field);
  const closes = formatDeadline(opts.protestClosesAt);
  const messages = vendorMessagesUrl(c.env, opts.vendorSlug);
  const lead = `${opts.ownerVendorName} declined the request from ${company} to change the ${field} of ${opts.integrationName}. The value on record stays as it is.`;
  const window = `If you disagree, you can ask AEC Integrations to review it until ${closes}, from Field contests in Messages on your vendor portal. Its view is advice, and nothing about the review is public.`;
  const shared = (link: LinkTagger) => ({
    preheader: `You can ask for a review until ${closes}.`,
    heading: `${opts.ownerVendorName} declined your change request`,
    table: [
      ...contestFactRows(c.env, opts, link),
      ['Their note', opts.decisionNote?.trim() || 'none', PLAIN] as const,
      ['Review request closes', closes] as const,
    ],
    ...(messages ? { cta: { label: 'Open Messages', url: link(messages) } } : {}),
    note: `You get this email because you hold a seat for ${company} on AEC Integrations.`,
  });
  return sendTransactionalEmail(c, {
    to: opts.to,
    template: 'contest-declined-protest-window',
    subject: `${opts.ownerVendorName} declined your change request on ${opts.integrationName}`,
    render: (link) =>
      houseBody(shared(link), [lead, window], [escapeHtml(lead), escapeHtml(window)]),
    dedupeKey: opts.dedupeKey,
    entity: { type: 'integration_field_challenge', id: opts.contestId },
  });
}

/**
 * Operator alert: a feedback submission (`POST /api/feedback`).
 *
 * **On the house layout (`lib/email-layout.ts`), not the old `opsTable()` grid**, the same
 * move its sibling `landing-signup` made. The facts ride the layout's `table`, so a bare-URL
 * `Referrer` row links. A `Tools/software` answer that merely mentions a URL stays plain
 * text, because the layout links a value only when the whole value is a URL. The plain-text
 * part is the same `Key: value` block `opsText()` emitted, under the heading.
 *
 * The single Forest CTA is `/admin/audience`, whose Feedback inbox is this alert's screen
 * equivalent (AECI-586). No `PUBLIC_SITE_URL` means no button.
 */
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
  const base = siteUrl(c.env);
  const intro = 'Someone just submitted feedback on AEC Integrations.';
  // The `Referrer` row is a recorded fact, not a link we built, so it is not tagged.
  const shared = (link: LinkTagger) => ({
    preheader: `New feedback from ${opts.email ?? 'an anonymous visitor'}.`,
    heading: 'New feedback submitted',
    table: rows,
    ...(base
      ? { cta: { label: 'Open the feedback inbox', url: link(`${base}/admin/audience`) } }
      : {}),
  });

  return sendTransactionalEmail(c, {
    to: c.env.ADMIN_ALERT_EMAIL ?? '',
    template: 'landing-feedback',
    subject: '[AECi] New feedback submitted',
    render: (link) => houseBody(shared(link), [intro], [escapeHtml(intro)]),
  });
}

// ─── Low-level transport (AECI-241 / Phase 7.6) ─────────────────────────────────
// Used by the two cron digests (`scheduled.ts`). Dependency-free with an injectable
// fetch/logger. It holds no ExecutionContext, so it emits no metric itself: each digest
// job counts `aeci.email.send` through `recordEmailSend`, tagged with its registry id.

export interface EmailMessage {
  /** The digest's registry entry (AECI-1199). Labels the suppression log, and the
   *  caller tags `aeci.email.send` with it through {@link recordEmailSend}. */
  notification: DigestNotificationId;
  from: string;
  /** One or more recipients. */
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

/** The env slice the transport reads. `RESEND_API_KEY` is a per-env Wrangler secret. */
export interface EmailEnv extends DeliveryPolicyEnv {
  RESEND_API_KEY?: string;
  /** Operator copy on every send; see `bccField`. */
  EMAIL_BCC?: string;
  /** The app D1 binding, for the send ledger (AECI-1202). Optional so a bare test env
   *  still sends. The cron passes its whole `Env`, which carries it. */
  DB?: D1Database;
}

/**
 * Send one email via Resend. Returns the outcome instead of throwing:
 *   - `'skipped'` — no API key, or no recipients (fail-open no-op).
 *   - `'failed'`  — Resend returned non-2xx, so it did not take the mail.
 *   - `'unknown'` — the request threw, so the mail may or may not have gone.
 *   - `'sent'`    — accepted by Resend.
 *   - `'suppressed'` — the tier delivery policy refused every recipient (AECI-1198).
 *   - `'paused'` — an operator paused this digest on this tier (AECI-1224).
 * It never returns `'duplicate'`: a digest takes no dedupe key.
 * `telemetry`, when given, counts a failed switches read on `aeci.email.switches.unavailable`.
 * When `env.DB` is present it writes one `notification_sends` row per recipient
 * (AECI-1202): `suppressed` for each refused address, and `sent` (sharing the one
 * Resend id), `failed` or `unknown` for the rest. One Resend call, so no reservation step.
 * Outside production, `to` is filtered to internal addresses and the subject gets the
 * tier prefix. A partly suppressed list still sends to the allowed addresses.
 * The optional `logger` records the reason on skip/fail/suppress (defaults to `console`).
 */
export async function sendEmail(
  env: EmailEnv,
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch,
  logger: Pick<Console, 'warn' | 'error'> = console,
  telemetry?: EmailContext,
): Promise<EmailOutcome> {
  const db = ledgerDb(env);
  const row = { notificationId: message.notification, tier: tierLabel(env) };
  if (!env.RESEND_API_KEY) {
    logger.warn('email: skipped — RESEND_API_KEY not configured');
    await recordRecipients(db, message.to, { ...row, outcome: 'skipped' }, logger);
    return 'skipped';
  }
  if (!message.from || message.to.length === 0) {
    logger.warn('email: skipped — from/to not configured');
    await recordRecipients(db, message.to, { ...row, outcome: 'skipped' }, logger);
    return 'skipped';
  }

  // The operator's sending switches (AECI-1224): one read, fail-open.
  const switches = await readSendSwitches(db, [message.notification, SUPPORT_COPY_KEY]);
  if (!switches.available) {
    logger.warn(`email: sending switches unreadable for ${message.notification}, sending anyway`);
    if (telemetry) emitSwitchesUnavailable(telemetry, 'digest');
  }
  if (switches.isPaused(message.notification)) {
    await logPaused(logger, message.notification, env, message.to);
    await recordRecipients(db, message.to, { ...row, outcome: 'paused' }, logger);
    return 'paused';
  }
  const supportCopy = !switches.isPaused(SUPPORT_COPY_KEY);

  const { allowed: to, suppressed } = partitionRecipients(env, message.to);
  if (suppressed.length > 0) {
    const { envRule } = getNotification(message.notification);
    await logSuppressed(logger, message.notification, envRule, env, suppressed);
    await recordRecipients(db, suppressed, { ...row, outcome: 'suppressed' }, logger);
  }
  if (to.length === 0) return 'suppressed';

  try {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from,
        to,
        ...bccField(env, to, supportCopy),
        subject: tierSubject(env, message.subject),
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        tags: resendTags(env, message.notification),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.error(
        `email: Resend error ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
      await recordRecipients(db, to, { ...row, outcome: 'failed' }, logger);
      return 'failed';
    }
    // Both branches read the body to the end: this one for the Resend id, the one
    // above for the error detail. An unread body holds its connection, which is
    // what deadlocks a cron sending a run of emails (AECI-666).
    const providerMessageId = await readProviderMessageId(res);
    await recordRecipients(db, to, { ...row, outcome: 'sent', providerMessageId }, logger);
    return 'sent';
  } catch (error) {
    // The request may have reached Resend before it threw, so the mail may be out.
    logger.error(
      `email: send threw, outcome unknown — ${error instanceof Error ? error.message : String(error)}`,
    );
    await recordRecipients(db, to, { ...row, outcome: 'unknown' }, logger);
    return 'unknown';
  }
}

/**
 * Write one settled ledger row per recipient (AECI-1202), hashing each bare address.
 * An empty list writes one row with an empty hash, so a send that had nobody to go
 * to still leaves a trace. Never throws.
 */
async function recordRecipients(
  db: Db | null,
  recipients: readonly string[],
  row: {
    notificationId: EmailNotificationId;
    tier: string;
    entity?: LedgerEntity;
    outcome: 'sent' | 'failed' | 'unknown' | 'skipped' | 'suppressed' | 'paused';
    providerMessageId?: string | null;
  },
  logger: Pick<Console, 'warn'> = console,
): Promise<void> {
  if (!db) return;
  const targets = recipients.length > 0 ? recipients : [''];
  for (const address of targets) {
    await recordSend(db, { ...row, recipientHash: await hashRecipient(address) }, logger);
  }
}

/** Resend's documented cap on an `Idempotency-Key`. */
const IDEMPOTENCY_KEY_MAX = 256;

/** Hex chars of the body hash in an `Idempotency-Key`: 64 bits, enough to tell bodies apart. */
const BODY_HASH_HEX = 16;

/**
 * The `Idempotency-Key` header for a keyed send (AECI-1197 review). Resend documents
 * the header on `POST /emails`: up to 256 characters, kept for 24 hours. A repeat with
 * the same key and the same body returns the first send's id and mails nobody. A
 * repeat with a different body is a 409. See `docs/email.md` §Send ledger.
 *
 * The key is `{tier}:{dedupeKey}:{body hash}`. Every tier sends from one Resend
 * account and keys are account-wide, so without the tier a staging digest and the
 * production digest with the same day key would collide. The body hash is the first
 * 16 hex of the SHA-256 of the request body. An identical retry gets the same key and
 * Resend mails nobody. A re-send with a changed body gets a new key, so it is never a
 * 409. A key longer than 256 characters, or with anything outside printable ASCII, is
 * sent as its SHA-256 hex instead.
 *
 * Every keyed send carries it, ledger up or down. It backs up the ledger across an
 * outage, including the attempt just before or just after one.
 */
export async function resendIdempotencyKey(
  env: DeliveryPolicyEnv,
  dedupeKey: string,
  body: string,
): Promise<string> {
  const bodyHash = (await sha256Hex(body)).slice(0, BODY_HASH_HEX);
  const key = `${tierLabel(env)}:${dedupeKey}:${bodyHash}`;
  if (key.length <= IDEMPOTENCY_KEY_MAX && /^[\x21-\x7e]+$/.test(key)) return key;
  return sha256Hex(key);
}

/**
 * The ledger's `recipient_hash` for one address: `recipientHash` of the bare address,
 * or an empty string when there is no address. Never throws: a hashing failure
 * stores an empty string rather than breaking the send.
 */
async function hashRecipient(address: string): Promise<string> {
  if (!address) return '';
  try {
    return await recipientHash(bareAddress(address));
  } catch {
    return '';
  }
}

/**
 * The Resend `bcc` field for one send, from the `EMAIL_BCC` var. Every email AECi
 * sends, through either transport above, blind-copies the operator so they see
 * exactly what users receive. An address already in `to` is dropped, so an
 * operator alert never lands twice. So is any address the tier delivery policy
 * refuses (AECI-1198). Absent or empty → no `bcc` field at all, and so is a paused
 * support copy (`supportCopy: false`, AECI-1224).
 * `sendOperatorCopy` reuses it as the `to` list of its separate copy.
 */
function bccField(
  env: DeliveryPolicyEnv & { EMAIL_BCC?: string },
  to: readonly string[],
  supportCopy: boolean,
): { bcc?: string[] } {
  if (!supportCopy) return {};
  const addressed = new Set(to.map((t) => bareAddress(t)));
  const candidates = parseRecipients(env.EMAIL_BCC).filter((b) => !addressed.has(bareAddress(b)));
  const bcc = partitionRecipients(env, candidates).allowed;
  return bcc.length > 0 ? { bcc } : {};
}

/**
 * Log each recipient the tier delivery policy refused (AECI-1198). The record carries
 * the template, the tier and an unsalted hash of the address, never the address
 * itself. Never throws: a hashing failure must not turn a suppression into a send
 * error.
 */
async function logSuppressed(
  logger: Pick<Console, 'warn'>,
  template: EmailNotificationId,
  envRule: string,
  env: DeliveryPolicyEnv,
  recipients: readonly string[],
): Promise<void> {
  const tier = tierLabel(env);
  for (const address of recipients) {
    try {
      logger.warn('email: suppressed — recipient outside the internal allowlist on this tier', {
        template,
        envRule,
        tier,
        recipientHash: await recipientHash(bareAddress(address)),
      });
    } catch {
      // Logging must never break a send.
    }
  }
}

/**
 * Log each recipient of a send an operator paused (AECI-1224). Like {@link logSuppressed}:
 * the template, the tier and a recipient hash, never the address. Never throws.
 */
async function logPaused(
  logger: Pick<Console, 'warn'>,
  template: EmailNotificationId,
  env: DeliveryPolicyEnv,
  recipients: readonly string[],
): Promise<void> {
  const tier = tierLabel(env);
  for (const address of recipients) {
    try {
      logger.warn('email: paused — an operator switch is off for this template on this tier', {
        template,
        tier,
        recipientHash: await recipientHash(bareAddress(address)),
      });
    } catch {
      // Logging must never break a send.
    }
  }
}

/** `Name <a@b.com>` or `a@b.com` → `a@b.com`, lowercased for comparison. */
function bareAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1]! : value).trim().toLowerCase();
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

/** The vendor portal entry point (`/vendor`, AECI-522) or `null` when
 *  `PUBLIC_SITE_URL` is unset — the claim-approved email then omits the link. */
function portalUrl(env: Env): string | null {
  const base = siteUrl(env);
  return base ? `${base}/vendor` : null;
}

/** A product's Reviews screen in the portal
 *  (`/vendor/:vendorSlug/products/:productSlug/reviews`, §11c.16), or `null` when
 *  `PUBLIC_SITE_URL` is unset. */
function vendorProductReviewsUrl(env: Env, vendorSlug: string, productSlug: string): string | null {
  const base = siteUrl(env);
  return base
    ? `${base}/vendor/${encodeURIComponent(vendorSlug)}/products/${encodeURIComponent(productSlug)}/reviews`
    : null;
}

/**
 * The seat-invite redeem page (AECI-664). `null` when `PUBLIC_SITE_URL` is unset,
 * which makes the whole send `'skipped'` rather than mailing a bare token with
 * nowhere to put it.
 *
 * A PATH segment, not a query param: the portal moved to
 * `/vendor/:vendorSlug/<section>` (§6.2), so `/vendor/invite/<token>` sits beside
 * it as a sibling route registered ahead of `:vendorSlug`, and the anon
 * login-bounce carries the whole deep path through in `?return=` unchanged.
 */
function seatInviteUrl(env: Env, token: string): string | null {
  const base = siteUrl(env);
  return base ? `${base}/vendor/invite/${encodeURIComponent(token)}` : null;
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

/**
 * Both parts of a house-layout body (`./email-layout`). `textBlocks` are plain text,
 * `htmlBlocks` are trusted HTML. Every URL in `shared` must already be tagged.
 */
function houseBody(
  shared: Omit<EmailLayout, 'blocks'>,
  textBlocks: string[],
  htmlBlocks: string[],
): EmailContent {
  return {
    text: renderEmailText({ ...shared, blocks: textBlocks }),
    html: renderEmailHtml({ ...shared, blocks: htmlBlocks }),
  };
}

/**
 * LEGACY formatters — an unbranded `<body>` of `<p>` tags with no card, no wordmark, no
 * button and no footer, at an off-palette `#27272a`.
 *
 * **The house layout is `./email-layout` (`renderEmailHtml` / `renderEmailText`)**, a
 * port of the sign-in email in `docs/email-templates/magic-link.html`. New templates use
 * that. These two remain only for the templates not yet migrated — the three sibling
 * attestation nudges, the review/account/mailing-list templates, and the one remaining
 * operator alert (`entitlement-expiring-admin`);
 * `docs/email.md` (§House layout) carries the migration list.
 *
 * Note the sign-off: the house layout deliberately has none, because its footer wordmark
 * names the sender. It also carries an em dash, which PRODUCT.md bans — the em-dash lint
 * is scoped to `apps/web` (`eslint.config.base.mjs`), so nothing catches it here.
 * Migrating a template off these formatters is what removes it.
 */
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

// `escapeHtml` now lives in `./email-layout` (the layout is what interpolates) and is
// imported at the top of this file, so every call site below is unchanged.

/** Emit the `aeci.email.send` outcome count. Wrapped so a missing `POSTHOG_PROJECT_KEY` /
 *  ExecutionContext can never turn a send into a throw. */
function emit(c: EmailContext, outcome: EmailOutcome, template: EmailNotificationId): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.email.send', 1, [
      `outcome:${outcome}`,
      `template:${template}`,
    ]);
  } catch {
    // Telemetry must never break a send.
  }
}

/**
 * Count one cron digest send on `aeci.email.send`, tagged with its registry id
 * (AECI-1199). `sendEmail` holds no `ExecutionContext`, so the digest jobs in
 * `scheduled.ts` call this beside their own `aeci.*.email` metric. Never throws.
 */
export function recordEmailSend(
  c: EmailContext,
  outcome: EmailOutcome,
  notification: DigestNotificationId,
): void {
  emit(c, outcome, notification);
}

/**
 * Count a failed switches read (AECI-1224). The send went ahead (fail-open); this is how an
 * operator learns a pause may not have held. `layer` is `transactional` or `digest`. Never throws.
 */
function emitSwitchesUnavailable(c: EmailContext, layer: 'transactional' | 'digest'): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.email.switches.unavailable', 1, [
      `layer:${layer}`,
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
