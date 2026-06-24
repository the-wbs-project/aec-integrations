import { z } from 'zod';

/**
 * Landing lead-capture contracts (ADR 0016 / AECI-257): the pre-launch feedback
 * and mailing-list signup forms served by `apps/landing`.
 *
 * The landing Worker used to POST these straight to Supabase Postgres via
 * PostgREST. Post-D1 cut-over it forwards them over the `env.API` service binding
 * to the API Worker, which persists them to the D1 `feedback` / `mailing_list`
 * tables (`apps/api/src/db/schema.ts`). The geo/enrichment fields are derived
 * server-side from `request.cf` by the landing Worker and carried IN THE BODY,
 * because `request.cf` does not survive the service binding (same constraint the
 * page-view enrichment headers work around — see `api/page-views.ts`). The API
 * Worker trusts them: it has no public ingress (service-binding only) and the
 * landing Worker is the sole caller.
 *
 * Lead-capture is write-once analytics, not domain state, so these inserts are
 * exempt from the §26.1 audit-in-batch invariant (like `page_views`).
 *
 * i18n note: this package is framework-agnostic, so the messages here are plain
 * English for API consumers / logs; the landing forms render their own copy.
 */

/** Cloudflare-derived geo + referrer fields shared by both forms. */
const geoShape = {
  country: z.string().max(255).nullish(),
  city: z.string().max(255).nullish(),
  region: z.string().max(255).nullish(),
  timezone: z.string().max(255).nullish(),
  referrer: z.string().max(2000).nullish(),
};

/** Wire body for `POST /api/feedback`. `features`/`tools` are the free-text
 *  suggestion fields; at least one must be present (mirrors the landing form's
 *  own guard). `email` is optional; when present it must be valid. */
export const FeedbackSubmitSchema = z
  .object({
    features: z.string().max(5000).nullish(),
    tools: z.string().max(5000).nullish(),
    email: z.string().trim().email().max(200).nullish(),
    subscribed: z.boolean().default(false),
    ...geoShape,
  })
  .refine((d) => Boolean(d.features) || Boolean(d.tools), {
    message: 'Provide at least one of features or tools.',
    path: ['features'],
  });
export type FeedbackSubmit = z.infer<typeof FeedbackSubmitSchema>;

/** Wire body for `POST /api/subscribe`. `email` is required and unique
 *  (`mailing_list_email_key`); the rest is best-effort attribution. */
export const SubscribeSubmitSchema = z.object({
  email: z.string().trim().email().max(200),
  as_organization: z.string().max(255).nullish(),
  asn: z.number().int().nullish(),
  metro_code: z.number().int().nullish(),
  utm_source: z.string().max(255).nullish(),
  utm_medium: z.string().max(255).nullish(),
  utm_campaign: z.string().max(255).nullish(),
  ...geoShape,
});
export type SubscribeSubmit = z.infer<typeof SubscribeSubmitSchema>;

/**
 * Response for both endpoints. `created` is `false` only when an
 * `ON CONFLICT DO NOTHING` insert was a no-op (subscribe on an email already on
 * the list) — the landing Worker maps that to its "already on the list" copy.
 * Feedback has no unique constraint, so it always returns `created: true`.
 */
export const LandingSubmitResultSchema = z.object({ created: z.boolean() });
export type LandingSubmitResult = z.infer<typeof LandingSubmitResultSchema>;
