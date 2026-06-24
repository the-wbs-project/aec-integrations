/**
 * Landing lead-capture endpoints (ADR 0016 / AECI-257) — Drizzle/D1.
 *
 *   POST /api/feedback   — insert a `feedback` row.
 *   POST /api/subscribe  — insert a `mailing_list` row, idempotent on email.
 *
 * These back the `apps/landing` feedback + mailing-list forms, moved off Supabase
 * Postgres (PostgREST) onto D1. The landing Worker forwards the validated form
 * body — including the `request.cf` geo fields, which it reads server-side and
 * carries in the body because `request.cf` does not survive the `env.API` service
 * binding (see `@aeci/shared` `api/page-views.ts`).
 *
 * No audit row: lead-capture is write-once analytics, not a domain state change
 * (§26.1 — same exemption as `page_views`). Reached only over the service binding
 * like every other route — no public ingress (mirrors `/api/requests/*`).
 *
 * Contracts: `FeedbackSubmitSchema` / `SubscribeSubmitSchema` from `@aeci/shared`.
 * Both return `{ created }`: `subscribe` reports `false` when the email is already
 * on the list (the `ON CONFLICT DO NOTHING` insert was a no-op), which the landing
 * Worker maps to its "already on the list" response.
 */

import {
  FeedbackSubmitSchema,
  SubscribeSubmitSchema,
  type LandingSubmitResult,
} from '@aeci/shared';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { feedback, mailingList } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import type { DbFactory } from '../lib/handler-utils';

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

export function createFeedbackHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, FeedbackSubmitSchema);
    const { db } = dbFor(c.env);

    await db.insert(feedback).values({
      features: payload.features ?? null,
      tools: payload.tools ?? null,
      email: payload.email ?? null,
      subscribed: payload.subscribed,
      country: payload.country ?? null,
      city: payload.city ?? null,
      region: payload.region ?? null,
      timezone: payload.timezone ?? null,
      referrer: payload.referrer ?? null,
    });

    return json({ created: true } satisfies LandingSubmitResult, { status: 201 });
  };
}

export function createSubscribeHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, SubscribeSubmitSchema);
    const { db } = dbFor(c.env);

    // `ON CONFLICT DO NOTHING … RETURNING` on the `mailing_list_email_key` unique
    // index: a returned row means we created it; [] means the email was already
    // on the list (idempotent no-op). Same pattern as `auth-profile.ts`.
    const inserted = await db
      .insert(mailingList)
      .values({
        email: payload.email,
        country: payload.country ?? null,
        city: payload.city ?? null,
        region: payload.region ?? null,
        timezone: payload.timezone ?? null,
        asOrganization: payload.as_organization ?? null,
        asn: payload.asn ?? null,
        metroCode: payload.metro_code ?? null,
        utmSource: payload.utm_source ?? null,
        utmMedium: payload.utm_medium ?? null,
        utmCampaign: payload.utm_campaign ?? null,
        referrer: payload.referrer ?? null,
      })
      .onConflictDoNothing({ target: mailingList.email })
      .returning({ id: mailingList.id });

    const created = inserted.length > 0;
    return json({ created } satisfies LandingSubmitResult, { status: created ? 201 : 200 });
  };
}
