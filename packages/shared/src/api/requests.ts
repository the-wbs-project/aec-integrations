import { z } from 'zod';

import { HttpsUrlSchema } from './https-url';

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

/** `vendor_requests.kind`. A typed-in listing (`listing_request`, AECI-1293) is
 *  NOT a kind of this table: it lives in `listing_requests`, because admitting it
 *  here would change two CHECKs and a NOT NULL, which is a drizzle-kit recreate of a
 *  table with FK children (`VENDOR_PROGRAM_PAGE_SPEC.md` §15.4). */
export const RequestKindSchema = z.enum(['claim', 'correction']);
export type RequestKind = z.infer<typeof RequestKindSchema>;

/*
 * The "Which plan are you interested in?" question (AECI-1293) was removed by
 * AECI-1365. The claim and listing schemas no longer carry the plan-interest key. Zod
 * strips unknown keys, so an old client that still sends it validates and the key
 * is dropped. The two nullable columns stay in `schema.ts` until E10 drops them.
 */

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
 * Claim-form fields. `body` ("anything we should know") is optional, as in the
 * original spec copy. It was required with a 20-character floor until claimants
 * sent to claim by AECi found it busy work. The column stays NOT NULL, so "not
 * supplied" is stored as the empty string, and `.default('')` keeps the key
 * omittable on the wire. `phone` from the spec mock is dropped — the Phase 2
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
  body: z.string().trim().max(2000, 'Keep this under 2000 characters.').default(''),
  // AECI-1366 (`docs/VENDOR_SIGNUP_PROCESS.md` §4, decision 3): "I represent this
  // company and accept the vendor terms". Required on every claim and listing request:
  // missing or `false` is `400 VALIDATION_FAILED` with `field: 'accepted_terms'`. The
  // version accepted is stamped by the server, never sent by the client.
  accepted_terms: z.literal(true, {
    error: 'Confirm you represent this company and accept the vendor terms.',
  }),
});
export type ClaimForm = z.infer<typeof ClaimFormSchema>;
/** The wire body before defaults: every defaulted key may be omitted. `accepted_terms`
 *  has no default, so it is always sent. */
export type ClaimFormInput = z.input<typeof ClaimFormSchema>;

/** Wire body for `POST /api/requests/claim`. `target_type` still takes `'product'`,
 *  but a claim is on the company (AECI-1364): the API stores it with the product's
 *  vendor as the target and the product in `vendor_requests.context_product_id`. */
export const ClaimRequestSchema = ClaimFormSchema.extend({
  target_type: RequestTargetTypeSchema,
  slug: z.string().min(1),
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

// ─── Listing request (a typed-in listing) ────────────────────────────────────

/**
 * "Not listed? Type it in" in the claim dialog (AECI-1293,
 * `VENDOR_PROGRAM_PAGE_SPEC.md` §15.4). The claim form's fields, unchanged (the same
 * LinkedIn host allowlist, the same optional `body`, here labelled "Additional
 * comments"), plus the listing the visitor typed. There is no target: the product or
 * company is not in the catalog yet, which is the point of the request.
 *
 * `website` is the shared `HttpsUrlSchema` rule (https only, no credentials), capped
 * at 500 like a correction's `source_url`. The admin queue renders it, so the scheme
 * allowlist is what keeps a `javascript:` URL out of an `href`.
 */
export const ListingRequestFormSchema = ClaimFormSchema.extend({
  listing_name: z
    .string()
    .trim()
    .min(1, 'The product or company name is required.')
    .max(200, 'Keep the name under 200 characters.'),
  website: HttpsUrlSchema.max(500, 'Keep the website under 500 characters.'),
});
export type ListingRequestForm = z.infer<typeof ListingRequestFormSchema>;

/** Wire body for `POST /api/requests/listing`. No target: see above. */
export const ListingRequestSchema = ListingRequestFormSchema;
export type ListingRequest = z.infer<typeof ListingRequestSchema>;
export type ListingRequestInput = z.input<typeof ListingRequestSchema>;

// ─── Responses ───────────────────────────────────────────────────────────────

/**
 * Returned by `POST /api/requests/{claim,correction,listing}`.
 *
 * `confirmation_required` (AECI-1435, ADR 0043) is `true` when the claim or listing
 * request is waiting on the typed address: nothing reached the queue yet, and the
 * visitor must click the link we emailed. `request_id` is then the pending id, which
 * becomes the request's id on confirm, so analytics joins still hold. It is `false`
 * when the submit went straight in: a signed-in visitor whose verified email is the
 * typed address, and every correction.
 */
export const RequestSubmitResponseSchema = z.object({
  request_id: z.string().uuid(),
  message: z.string(),
  confirmation_required: z.boolean(),
});
export type RequestSubmitResponse = z.infer<typeof RequestSubmitResponseSchema>;

// ─── POST /api/requests/confirm (AECI-1435) ─────────────────────────────────

/**
 * How long the emailed confirm link works (AECI-1435, ruled 2026-10-21). Shared so the
 * API's expiry, the email copy, the dialog receipt and the confirm page agree.
 */
export const REQUEST_CONFIRMATION_DAYS = 7;

/** What a pending confirmation holds. */
export const RequestConfirmationKindSchema = z.enum(['claim', 'listing']);
export type RequestConfirmationKind = z.infer<typeof RequestConfirmationKindSchema>;

/**
 * Wire body for `POST /api/requests/confirm`: the token from the emailed link. Sent
 * only by the confirm button on `/claims/confirm`, never on page load, because mail
 * scanners fetch the links they are sent. The cap is generous: real tokens are 43
 * characters.
 */
export const ConfirmRequestSchema = z.object({
  token: z.string().trim().min(1, 'The link is missing its token.').max(200),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

/**
 * Why the AECI-1420 account check rejected a claim at confirm. `other_vendor`: the
 * address already holds a seat on another company. `already_admin`: it is an AEC
 * Integrations staff account. The same vocabulary as the API's `ClaimantConflict`.
 */
export const ConfirmRejectionReasonSchema = z.enum(['other_vendor', 'already_admin']);
export type ConfirmRejectionReason = z.infer<typeof ConfirmRejectionReasonSchema>;

/**
 * `200` from `POST /api/requests/confirm`. `confirmed` means this click sent the
 * request. `already_confirmed` means an earlier click did, and nothing was written.
 * `routed` is true when a claim went to the company's owners first (AECI-1368), so
 * the page shows the routed receipt; it is false for a listing and for an
 * `already_confirmed`. `company_name` names the company claimed, or the typed name
 * of a listing, for the receipt copy. Null on `already_confirmed`.
 *
 * `rejected` (ruled 2026-10-21) means this click sent the claim and the AECI-1420
 * account check stored it rejected at once. `reason` says why. `vendor_name` names the
 * company the address already manages on `other_vendor`, null when that row is gone
 * and always null on `already_admin`. The clicker proved the mailbox, so naming it
 * tells them nothing the reasoned `claim-rejected` email does not. A check that could
 * not run is not a rejection: that claim answers `confirmed`.
 *
 * Every other outcome is an error envelope (`API_CONTRACTS.md` §6.7): `404 NOT_FOUND`
 * with `details.resource = 'request_confirmation'` for an unknown token, `422
 * INVALID_STATE_TRANSITION` with `details.reason = 'expired'` past the 7 days, and
 * `404 NOT_FOUND` with `details.resource` `vendor` or `product` when the claimed
 * listing is gone.
 */
const ConfirmRequestBase = {
  kind: RequestConfirmationKindSchema,
  request_id: z.string().uuid(),
  routed: z.boolean(),
  company_name: z.string().nullable(),
};
export const ConfirmRequestResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('confirmed'), ...ConfirmRequestBase }),
  z.object({ status: z.literal('already_confirmed'), ...ConfirmRequestBase }),
  z.object({
    status: z.literal('rejected'),
    ...ConfirmRequestBase,
    kind: z.literal('claim'),
    routed: z.literal(false),
    reason: ConfirmRejectionReasonSchema,
    vendor_name: z.string().nullable(),
  }),
]);
export type ConfirmRequestResponse = z.infer<typeof ConfirmRequestResponseSchema>;

// ─── GET /api/requests/claim-target/:type/:slug ──────────────────────────────

/**
 * The company a claim on `(type, slug)` would land on, and whether it already
 * has a team (AECI-1368, `STAGE_2_VENDOR_PORTAL_SPEC.md` §8.1a and §11a.10).
 *
 * A product resolves to its primary vendor, else any `product_vendors` row: the
 * same company `POST /api/requests/claim` would store. `has_seats` is the one owner
 * predicate, "the vendor has an unbanned owner seat", so it is true exactly when a
 * claim submitted now would be routed to the owners first. The claim form reads it
 * to show the routed disclosure before submit. Public, read-only,
 * `Cache-Control: no-store`.
 */
export const ClaimTargetResponseSchema = z.object({
  vendor_id: z.string().uuid(),
  has_seats: z.boolean(),
});
export type ClaimTargetResponse = z.infer<typeof ClaimTargetResponseSchema>;
