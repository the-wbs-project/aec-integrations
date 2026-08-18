/**
 * Landing lead-capture endpoints (ADR 0016 / AECI-257) — Drizzle/D1.
 *
 *   POST /api/feedback   — insert a `feedback` row.
 *   POST /api/subscribe  — insert a `mailing_list` row, idempotent on email.
 *
 * These back the `apps/landing` feedback + mailing-list forms, moved off Supabase
 * Postgres (PostgREST) onto D1. Two callers, two geo-transport paths:
 *   - the legacy `apps/landing` Worker forwards the `request.cf` geo fields IN THE
 *     BODY (it reads them server-side; `request.cf` does not survive the `env.API`
 *     binding — see `@aeci/shared` `api/page-views.ts`);
 *   - the unified home's closing-CTA island (AECI-275) POSTs through the SSR
 *     Worker's `/api/*` passthrough, which forwards the same geo on the trusted
 *     `LANDING_CF_HEADERS` instead. So `readLandingCfFromHeaders` reads a header
 *     when present and the handlers fall back to the body value otherwise. UTM /
 *     referrer always travel in the body. The headers are trusted because the API
 *     Worker has no public ingress and the SSR proxy strips-then-sets them.
 *
 * No audit row: lead-capture is write-once analytics, not a domain state change
 * (§26.1 — same exemption as `page_views`). Reached only over the service binding
 * like every other route — no public ingress (mirrors `/api/requests/*`).
 *
 * Contracts: `FeedbackSubmitSchema` / `SubscribeSubmitSchema` from `@aeci/shared`.
 * Both return `{ created }`: `subscribe` reports `false` when the email is already
 * on the list (the `ON CONFLICT DO NOTHING` insert was a no-op), which the caller
 * maps to its "already on the list" response.
 */

import {
  FeedbackSubmitSchema,
  LANDING_CF_HEADERS,
  SubscribeSubmitSchema,
  UnsubscribeSubmitSchema,
  type LandingSubmitResult,
  type UnsubscribeResult,
} from '@aeci/shared';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { submitCount } from '../datadog';
import { feedback, mailingList } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import {
  sendLandingFeedbackNotification,
  sendLandingSignupNotification,
  sendMailingListWelcomeEmail,
} from '../lib/email';
import { writeDb, type DbFactory } from '../lib/handler-utils';

async function parseJsonBody<T>(c: Context<{ Bindings: Env }>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope.
  return schema.parse(raw);
}

/** Trusted Cloudflare geo forwarded by the SSR proxy on `LANDING_CF_HEADERS`
 *  (AECI-275). Present only on the unified-home island path; the legacy landing
 *  Worker carries the same geo in the body, so the handlers fall back to the body
 *  value when a header is absent. `asn` / `metroCode` are integer columns, parsed
 *  with a finite-number guard so a malformed header degrades to null rather than
 *  writing `NaN`. */
interface LandingCf {
  country: string | null;
  city: string | null;
  region: string | null;
  timezone: string | null;
  asOrganization: string | null;
  asn: number | null;
  metroCode: number | null;
}

function readLandingCfFromHeaders(c: Context<{ Bindings: Env }>): LandingCf {
  const str = (name: string): string | null => {
    const v = c.req.header(name)?.trim();
    return v ? v : null;
  };
  const int = (name: string): number | null => {
    const v = str(name);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    country: str(LANDING_CF_HEADERS.country),
    city: str(LANDING_CF_HEADERS.city),
    region: str(LANDING_CF_HEADERS.region),
    timezone: str(LANDING_CF_HEADERS.timezone),
    asOrganization: str(LANDING_CF_HEADERS.asOrganization),
    asn: int(LANDING_CF_HEADERS.asn),
    metroCode: int(LANDING_CF_HEADERS.metroCode),
  };
}

export function createFeedbackHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, FeedbackSubmitSchema);
    // Write-once analytics, never read back in-request and no caller resumes a
    // session off it — stays on the `'first-unconstrained'` read default (no
    // `first-primary` anchor / `x-d1-bookmark` emit). (AECI-250)
    const { db } = dbFor(c.env);
    const cf = readLandingCfFromHeaders(c);

    // Trusted header geo (island path) wins; body geo (landing path) is the
    // fallback. `feedback` has no asn/metro/as_organization columns. Resolved once
    // so the insert and the operator notification below carry the same values.
    const country = cf.country ?? payload.country ?? null;
    const city = cf.city ?? payload.city ?? null;
    const region = cf.region ?? payload.region ?? null;
    const email = payload.email ?? null;
    const features = payload.features ?? null;
    const tools = payload.tools ?? null;
    const referrer = payload.referrer ?? null;

    await db.insert(feedback).values({
      features,
      tools,
      email,
      subscribed: payload.subscribed,
      country,
      city,
      region,
      timezone: cf.timezone ?? payload.timezone ?? null,
      referrer,
    });

    // Operator "new feedback" notification — retires the `apps/landing` Worker's
    // own Resend send (AECI-247/277). Fire-and-forget after the insert; fail-open
    // (absent RESEND_API_KEY / ADMIN_ALERT_EMAIL → silent skip, never affects 201).
    c.executionCtx.waitUntil(
      sendLandingFeedbackNotification(c, {
        email,
        features,
        tools,
        subscribed: payload.subscribed,
        city,
        region,
        country,
        referrer,
      }),
    );

    return json({ created: true } satisfies LandingSubmitResult, { status: 201 });
  };
}

export function createSubscribeHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, SubscribeSubmitSchema);
    const { db } = writeDb(c, dbFor);
    const cf = readLandingCfFromHeaders(c);

    // Trusted header geo (island path) wins over body geo (landing path); UTM
    // always rides the body. Resolved once so the insert and the operator
    // notification below carry the same values.
    const country = cf.country ?? payload.country ?? null;
    const city = cf.city ?? payload.city ?? null;
    const region = cf.region ?? payload.region ?? null;
    const asOrganization = cf.asOrganization ?? payload.as_organization ?? null;
    const utmSource = payload.utm_source ?? null;
    const utmCampaign = payload.utm_campaign ?? null;
    const referrer = payload.referrer ?? null;

    // `ON CONFLICT DO NOTHING … RETURNING` on the `mailing_list_email_key` unique
    // index: a returned row means we created it; [] means the email was already
    // on the list (idempotent no-op). Same pattern as `auth-profile.ts`. New rows
    // get an opaque unsubscribe token (AECI-537) used by the welcome-email link.
    const newToken = crypto.randomUUID();
    const inserted = await db
      .insert(mailingList)
      .values({
        email: payload.email,
        country,
        city,
        region,
        timezone: cf.timezone ?? payload.timezone ?? null,
        asOrganization,
        asn: cf.asn ?? payload.asn ?? null,
        metroCode: cf.metroCode ?? payload.metro_code ?? null,
        utmSource,
        utmMedium: payload.utm_medium ?? null,
        utmCampaign,
        referrer,
        unsubscribeToken: newToken,
      })
      .onConflictDoNothing({ target: mailingList.email })
      .returning({ id: mailingList.id });

    // Token threaded into the welcome email below (the new row's, or — on a
    // reactivation — the existing row's, so the link stays valid).
    let welcomeToken: string | null = inserted.length > 0 ? newToken : null;

    // Soft-delete reactivation (AECI-537): if the email is already on the list
    // AND currently unsubscribed, clear `unsubscribed_at` back to active and
    // re-welcome. `isNotNull` guards it to opted-out rows only, so an already
    // active email stays a no-op (`created:false` → "already on the list").
    let reactivated = false;
    if (inserted.length === 0) {
      const revived = await db
        .update(mailingList)
        .set({ unsubscribedAt: null })
        .where(and(eq(mailingList.email, payload.email), isNotNull(mailingList.unsubscribedAt)))
        .returning({ token: mailingList.unsubscribeToken });
      if (revived.length > 0) {
        reactivated = true;
        welcomeToken = revived[0].token;
      }
    }

    const created = inserted.length > 0 || reactivated;

    // Two fire-and-forget sends on a real insert or a reactivation, never on the
    // idempotent already-active no-op (matches the landing Worker, which 409'd a
    // dup before sending) so a still-subscribed re-subscribe neither re-alerts
    // nor re-welcomes. Both fail-open on absent secrets (RESEND_API_KEY /
    // recipient) and never affect the response:
    //   1. the operator "new signup" alert to ADMIN_ALERT_EMAIL (retires the
    //      `apps/landing` Worker's own Resend send, AECI-247/277);
    //   2. the subscriber's welcome email — their first touch (AECI-327), now
    //      carrying the tokenized unsubscribe link (AECI-537).
    if (created) {
      c.executionCtx.waitUntil(
        sendLandingSignupNotification(c, {
          email: payload.email,
          city,
          region,
          country,
          asOrganization,
          utmSource,
          utmCampaign,
          referrer,
        }),
      );
      c.executionCtx.waitUntil(
        sendMailingListWelcomeEmail(c, { to: payload.email, token: welcomeToken }),
      );
    }

    // 201 only for a genuinely new row; a reactivation / no-op is 200.
    return json({ created } satisfies LandingSubmitResult, {
      status: inserted.length > 0 ? 201 : 200,
    });
  };
}

/**
 * `POST /api/unsubscribe` (AECI-537) — soft-delete a mailing-list subscriber by
 * their opaque `unsubscribe_token`. Two callers, one handler:
 *   - the `/unsubscribe` page POSTs `{ token }` as JSON;
 *   - the RFC 8058 one-click header POSTs a form body (`List-Unsubscribe=One-Click`)
 *     to `…/api/unsubscribe?token=…` — we read the token from the query and ignore
 *     the body.
 * So the token is read from the query string first, then the JSON body. The write
 * is an idempotent soft-delete (`unsubscribed_at = COALESCE(unsubscribed_at, now)`),
 * keyed on the unique token index; a matched row → `{ ok: true }`, no match →
 * `{ ok: false }` (invalid/expired link — tokens are unguessable, so no membership
 * leak). Like subscribe/feedback this is write-once lead-capture: no `audit_log`
 * row (§26.1 exemption), reached only over the service binding (no public ingress).
 */
export function createUnsubscribeHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const queryToken = c.req.query('token');
    const { token } = queryToken
      ? UnsubscribeSubmitSchema.parse({ token: queryToken })
      : await parseJsonBody(c, UnsubscribeSubmitSchema);

    const { db } = writeDb(c, dbFor);
    const isoNow = new Date().toISOString();

    // Idempotent: set `unsubscribed_at` only if not already set, so a repeat
    // opt-out preserves the original timestamp but still reports ok.
    const updated = await db
      .update(mailingList)
      .set({ unsubscribedAt: sql`COALESCE(${mailingList.unsubscribedAt}, ${isoNow})` })
      .where(eq(mailingList.unsubscribeToken, token))
      .returning({ id: mailingList.id });

    const ok = updated.length > 0;

    // Best-effort lead-capture metric (no audit row). Never breaks the opt-out.
    if (ok) {
      try {
        submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.mailing_list.unsubscribe', 1);
      } catch {
        // Telemetry must never break a request.
      }
    }

    return json({ ok } satisfies UnsubscribeResult, { status: 200 });
  };
}
