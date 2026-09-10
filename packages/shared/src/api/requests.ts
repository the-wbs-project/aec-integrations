import { z } from 'zod';

/**
 * Vendor-request contracts (AECI-128): the claim & correction submission forms
 * and their server endpoints. These back the first real Signal Forms forms
 * (`apps/web/src/app/requests/`) — see `docs/adr/0009-signal-forms.md`.
 *
 * Source of truth is the `vendor_requests` table (Phase 2 Spec §5.1 /
 * `supabase/migrations/20260524000000_phase_2_vendor_requests.sql`), a
 * loose-polymorphic `(target_type, target_id)` row with `kind ∈ {claim,
 * correction}`. Where `docs/API_CONTRACTS.md` §6.7 used a different field
 * vocabulary (`entity_type/entity_id/what_is_wrong/what_should_it_say`), these
 * schemas align to the real columns instead — the doc drift is flagged for
 * reconciliation (the table is the contract per CLAUDE.md).
 *
 * Two-layer shape per form:
 *   - `*FormSchema` — the user-entered fields only. The Angular form validates
 *     against these client-side via `validateStandardSchema()`, so the rules
 *     here are the single source of truth for both client and server.
 *   - `*RequestSchema = *FormSchema.extend({ target_type, slug })` — the wire
 *     body the API Worker validates. The target is addressed by `(target_type,
 *     slug)` from the route, not user input, and resolved to `target_id`
 *     server-side. Slug (not id) keeps the client free of UUIDs and works
 *     identically whether the form is landed on (SSR) or reached via client-side
 *     navigation from a detail-page CTA (the routes load via `[routerLink]`).
 *
 * i18n note: this package is framework-agnostic (no `$localize`), so the
 * messages below are plain English for API consumers / logs. The Angular form
 * never renders them — it shows `$localize` copy keyed off field validity. See
 * ADR 0009 and `ANGULAR_STYLE_GUIDE.md` §13.
 */

/** Target facet of a request. The table enum is `product | vendor` (no
 *  `integration` — Stage 1 claim/correction covers products + vendors only,
 *  `app.routes.ts:109`). */
export const RequestTargetTypeSchema = z.enum(['product', 'vendor']);
export type RequestTargetType = z.infer<typeof RequestTargetTypeSchema>;

/** `vendor_requests.kind`. */
export const RequestKindSchema = z.enum(['claim', 'correction']);
export type RequestKind = z.infer<typeof RequestKindSchema>;

// ─── Correction ──────────────────────────────────────────────────────────────

/**
 * Correction-form fields. `body` collapses API_CONTRACTS §6.7's separate
 * "what's wrong" / "what it should say" prompts into the single NOT-NULL
 * `vendor_requests.body` column. `source_url` is required at the type level (so
 * the Signal Forms field is a concrete `string`, never `string | undefined`) but
 * accepts an empty string — the user may leave it blank, and the server stores
 * `''` as NULL.
 */
export const CorrectionFormSchema = z.object({
  body: z
    .string()
    .trim()
    .min(20, 'Describe the correction in at least 20 characters.')
    .max(2000, 'Keep the correction under 2000 characters.'),
  source_url: z.union([
    z.literal(''),
    z.string().trim().url('Enter a valid URL (including https://).').max(500),
  ]),
  submitter_email: z
    .string()
    .trim()
    .min(1, 'Your email is required.')
    .email('Enter a valid email address.')
    .max(200),
});
export type CorrectionForm = z.infer<typeof CorrectionFormSchema>;

/** Wire body for `POST /api/requests/correction`. */
export const CorrectionRequestSchema = CorrectionFormSchema.extend({
  target_type: RequestTargetTypeSchema,
  slug: z.string().min(1),
});
export type CorrectionRequest = z.infer<typeof CorrectionRequestSchema>;

// ─── Claim ───────────────────────────────────────────────────────────────────

/**
 * Host allowlist for `submitter_linkedin_url` (AECI-847). A claimant-supplied
 * profile URL is an IDENTITY signal, so it is only worth anything if it points at
 * the site the reviewer is going to read. An unanchored `z.string().url()` would
 * accept the claimant's own marketing page — indistinguishable from evidence, and
 * a paste error would land silently in the admin queue.
 *
 * Matches `linkedin.com` and any subdomain of it, which is what the real profile
 * hosts look like: `www.linkedin.com/in/…`, and the regional mirrors
 * (`uk.linkedin.com`, `de.linkedin.com`) that LinkedIn still serves. Scheme is
 * pinned to `https:` — the value is rendered as an `href` in `/admin/claims`, and
 * a scheme allowlist is the cheapest place to keep a `javascript:` URL out of it.
 */
const LINKEDIN_HOST = 'linkedin.com';

function isLinkedInProfileUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === LINKEDIN_HOST || host.endsWith(`.${LINKEDIN_HOST}`);
}

/**
 * Claim-form fields. `body` ("anything we should know") is required here rather
 * than optional as in the original spec copy: the column is NOT NULL and a claim
 * needs verification context. `phone` from the spec mock is dropped — the Phase 2
 * §5.1 table has no phone column. Both are flagged as table-reconciliation
 * decisions in the PR.
 *
 * `submitter_linkedin_url` (AECI-847) is optional. It resolves to a concrete
 * `string` like `CorrectionFormSchema.source_url` — the Signal Forms field cannot
 * be `string | undefined`, so "not supplied" is the empty string. It differs from
 * `source_url` in carrying `.default('')`, which makes the KEY omittable on the
 * wire: `source_url` shipped with its endpoint, whereas this field is added to an
 * endpoint already in production, and a body that predates it must still validate.
 * The server stores `''` as NULL either way.
 */
export const ClaimFormSchema = z.object({
  submitter_name: z
    .string()
    .trim()
    .min(1, 'Your name is required.')
    .max(200, 'Keep your name under 200 characters.'),
  submitter_email: z
    .string()
    .trim()
    .min(1, 'Your work email is required.')
    .email('Enter a valid email address.')
    .max(200),
  submitter_role: z
    .string()
    .trim()
    .min(1, 'Your role is required.')
    .max(100, 'Keep your role under 100 characters.'),
  // Trim BEFORE the blank check, not as one branch of a `''`-vs-URL union: a
  // pasted value routinely carries a leading or trailing space, and under a union
  // whitespace-only input falls to the URL branch and errors instead of reading as
  // "not supplied".
  submitter_linkedin_url: z
    .string()
    .trim()
    .max(200, 'Keep the LinkedIn URL under 200 characters.')
    .refine(
      (value) => value === '' || isLinkedInProfileUrl(value),
      'Enter a LinkedIn profile URL (https://www.linkedin.com/in/…).',
    )
    .default(''),
  body: z
    .string()
    .trim()
    .min(20, 'Tell us about your connection to this listing (at least 20 characters).')
    .max(2000, 'Keep this under 2000 characters.'),
});
export type ClaimForm = z.infer<typeof ClaimFormSchema>;

/** Wire body for `POST /api/requests/claim`. */
export const ClaimRequestSchema = ClaimFormSchema.extend({
  target_type: RequestTargetTypeSchema,
  slug: z.string().min(1),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

// ─── Responses ───────────────────────────────────────────────────────────────

/** Returned by both `POST /api/requests/{claim,correction}`. */
export const RequestSubmitResponseSchema = z.object({
  request_id: z.string().uuid(),
  message: z.string(),
});
export type RequestSubmitResponse = z.infer<typeof RequestSubmitResponseSchema>;
