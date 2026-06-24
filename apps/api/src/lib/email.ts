/**
 * Minimal transactional-email transport for the API Worker (AECI-241 / Phase 7.6).
 *
 * The stack is **Resend** over its REST API (`POST https://api.resend.com/emails`),
 * dependency-free `fetch` — the same proven shape as the landing app
 * (`apps/landing/src/services/email.ts`), so it bundles cleanly into the Worker
 * with no SDK.
 *
 * **Fail-open, never throws.** Mirrors the `lib/admin-alert.ts` / `LINEAR_API_KEY`
 * posture: an absent `RESEND_API_KEY` or unset from/to is the expected state in
 * local `dev:bound` / PR previews, so the send is a logged no-op (`'skipped'`),
 * and a transport error returns `'failed'` rather than propagating. Callers ride
 * `ctx.waitUntil` and emit an outcome metric; a missing email must not break the
 * cron. (Phase 7.5's transactional sender can adopt this same module — the
 * reconciliation sweep's `sendAdminAlert` seam being the obvious next caller.)
 */

export type EmailOutcome = 'sent' | 'failed' | 'skipped';

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

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

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
    const res = await fetchImpl(RESEND_ENDPOINT, {
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
