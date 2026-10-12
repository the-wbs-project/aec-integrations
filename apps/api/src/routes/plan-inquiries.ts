/**
 * `POST /api/plan-inquiries` (AECI-1279): the "Talk to us about Managed" form on the
 * vendor guide's Plans page and on `/contact?topic=managed`.
 *
 * Public, no session. One insert into `plan_inquiries`, then two fire-and-forget sends
 * in `ctx.waitUntil`:
 *
 *   1. the visitor's receipt (`plan-inquiry-received`), at most one per address per UTC
 *      day. The address is typed, not verified, so the key bounds what a stranger can
 *      make us send to someone else's inbox;
 *   2. the operator alert to `SUPPORT_EMAIL` (`plan-inquiry-alert`), with reply-to set
 *      to the visitor, on every saved inquiry.
 *
 * Both fail open and never change the response.
 *
 * **Honeypot.** A filled `website` field gets the same `201 { received: true }` with
 * nothing saved or sent, so a bot cannot tell it was caught.
 *
 * **No audit row.** Lead capture, like `feedback`: write-once, invisible on every public
 * surface (ADR 0022, the 2026-10-12 amendment; `docs/CODE_REVIEW_EXEMPTIONS.md` EX-002).
 *
 * **Rate limit.** The `token` bucket by IP is registered in `index.ts`. Zone Rule A does
 * not match this path until an operator widens its expression
 * (`docs/waf-rate-limits.md` §1), so the in-Worker limiter is the only cap until then.
 *
 * Geo arrives on the trusted `LANDING_CF_HEADERS`, which the SSR proxy strips and sets
 * for this path as it does for `/api/feedback` (`withForwardedLandingCf`).
 */

import { PlanInquirySubmitSchema, type PlanInquiryResult } from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { planInquiries } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import { sendPlanInquiryAlert, sendPlanInquiryReceivedEmail } from '../lib/email';
import type { DbFactory } from '../lib/handler-utils';
import { recipientHash } from '../lib/hash';
import { parseJsonBody, readLandingCfFromHeaders } from './landing-forms';

/** The display name of each inquiry topic, as the emails print it. */
const PLAN_NAMES = { managed: 'Managed' } as const;

const RECEIVED: PlanInquiryResult = { received: true };

export function createPlanInquiryHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, PlanInquirySubmitSchema);

    // Only a bot fills a field nobody can see. Same answer as a real submit.
    if (payload.website?.trim()) {
      return json(RECEIVED, { status: 201 });
    }

    // Write-once lead capture, never read back in-request, so it stays on the
    // `'first-unconstrained'` default like `feedback` (AECI-250).
    const { db } = dbFor(c.env);
    const cf = readLandingCfFromHeaders(c);
    const details = payload.details?.trim() || null;
    const referrer = payload.referrer ?? null;

    const [row] = await db
      .insert(planInquiries)
      .values({
        topic: payload.topic,
        email: payload.email,
        company: payload.company,
        details,
        country: cf.country,
        city: cf.city,
        region: cf.region,
        timezone: cf.timezone,
        referrer,
      })
      .returning({ id: planInquiries.id });

    const inquiryId = String(row!.id);
    const inquiry = {
      inquiryId,
      planName: PLAN_NAMES[payload.topic],
      email: payload.email,
      company: payload.company,
      details,
    };
    const entity = { type: 'plan_inquiry', id: inquiryId };
    // The key holds the address's hash, never the address (AECI-1203).
    const day = new Date().toISOString().slice(0, 10);
    const receiptKey = `plan-inquiry-received:${await recipientHash(payload.email)}:${day}`;

    c.executionCtx.waitUntil(
      sendPlanInquiryReceivedEmail(c, { inquiry, dedupeKey: receiptKey, entity }),
    );
    c.executionCtx.waitUntil(
      sendPlanInquiryAlert(c, {
        inquiry,
        city: cf.city,
        region: cf.region,
        country: cf.country,
        referrer,
        entity,
      }),
    );

    return json(RECEIVED, { status: 201 });
  };
}
