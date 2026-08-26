import { z } from 'zod';

import { VendorEntitlementBlockSchema } from './admin-entitlements';
import { PUBLIC_PRIVATE } from './promote';

/**
 * Vendor-portal contracts (`/api/vendor/*`, AECI-520 / Stage 2), behind the
 * `requireVendor()` guard (`apps/api/src/lib/authz.ts`):
 *
 *   GET   /api/vendor/me             — the signed-in vendor's dashboard payload.
 *   PATCH /api/vendor/profile        — edit the caller's own vendor row.
 *   PATCH /api/vendor/products/:id   — edit one product the caller's vendor owns.
 *   GET   /api/vendor/seats          — the vendor's seat roster (read-only).
 *
 * Source of truth: `STAGE_2_VENDOR_PORTAL_SPEC.md` §4 (the surface + the authz
 * seam) and §6 (the dashboard that consumes it), `API_CONTRACTS.md` §6.14.
 *
 * Two invariants these schemas encode, both load-bearing:
 *
 * 1. **The allow-list IS the guard-rail.** Zod strips unknown keys, so a field
 *    that is absent from an `Update*Schema` can never be written by a vendor —
 *    `verified`, `promotion_status`, slugs, names, `admin_notes`, research /
 *    priority / score / VQS columns, and every denormalized count stay
 *    AECi-owned. Adding a field here grants a write; do it deliberately.
 * 2. **No vendor id crosses the wire.** Nothing in this module carries a target
 *    vendor id, because the Worker scopes every read and write by the session's
 *    `vendor_id` (there is no RLS behind it — ADR 0016). `PATCH
 *    /api/vendor/products/:id` takes a product id, and ownership of that product
 *    is proven server-side against the session before anything is written.
 *
 * Clearing vs leaving alone: every editable field is `.nullable().optional()`.
 * An ABSENT key leaves the column untouched; an explicit `null` clears it. The
 * taxonomy arrays are set-replacement — absent leaves the assignment alone, `[]`
 * clears it.
 *
 * i18n note: this package is framework-agnostic (no `$localize`) — the messages
 * below are for API consumers / logs; the Angular dashboard renders its own copy.
 */

// ─── Field primitives ────────────────────────────────────────────────────────

/**
 * A vendor-supplied URL. Stricter than the review app's `z.string().nullish()`
 * (`promote.ts`) because this input is untrusted: `API_CONTRACTS.md` §7.1 —
 * "URLs validated as `http://` or `https://` only". Zod's `.url()` alone accepts
 * `javascript:` and `data:`, which would land in an `href` on a public page.
 */
const editableUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: 'URL must start with http:// or https://',
  });

/** A short editable text column (`API_CONTRACTS.md` §7.2 — 200 chars). */
const shortText = z.string().trim().max(200);

/** A long editable text column (`API_CONTRACTS.md` §7.2 — 2000 chars). */
const longText = z.string().trim().max(2000);

/** A taxonomy term slug (`API_CONTRACTS.md` §7.1 — `[a-z0-9-]+`, max 100). */
const termSlug = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens');

/**
 * A taxonomy assignment: the FULL set for that facet, not a delta. Capped at 10
 * — a product in more than ten categories is a data-quality problem, not a
 * legitimate edit. Vendors may only assign terms that already exist; minting a
 * term stays an AECi curation act, so an unknown slug is a `VALIDATION_FAILED`.
 */
const termSlugList = z.array(termSlug).max(10);

// ─── Entity shapes ───────────────────────────────────────────────────────────

/**
 * The caller's own vendor row, as the portal sees it. A superset of the public
 * `VendorDetail` in the fields the vendor may edit, and it deliberately includes
 * the AECi-owned `verified` bit as READ-ONLY state — the dashboard shows
 * verification status but can never toggle it (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6: "the badge itself is AECi-controlled, not vendor-toggled").
 */
export const VendorAccountSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  company_name: z.string().min(1),
  verified: z.boolean(),

  description: z.string().nullable(),
  website: z.string().nullable(),
  headquarters: z.string().nullable(),
  founded_year: z.number().int().nullable(),
  public_private: z.enum(PUBLIC_PRIVATE).nullable(),
  parent_company: z.string().nullable(),
  contact_email: z.string().nullable(),
  phone_number: z.string().nullable(),
  logo_url: z.string().nullable(),

  linkedin_url: z.string().nullable(),
  x_url: z.string().nullable(),
  facebook_url: z.string().nullable(),
  instagram_url: z.string().nullable(),
  youtube_url: z.string().nullable(),
  crunchbase_url: z.string().nullable(),
  wiki_url: z.string().nullable(),
  github_org: z.string().nullable(),

  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type VendorAccount = z.infer<typeof VendorAccountSchema>;

/**
 * One product the caller's vendor owns (a `product_vendors` join row). Carries
 * the editable content plus the taxonomy assignment, so the dashboard can render
 * an edit form from one payload. `is_primary` mirrors `product_vendors.is_primary`
 * and is AECi-owned. Counts and ratings are read-only context.
 */
export const VendorProductSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  is_primary: z.boolean(),

  description: z.string().nullable(),
  website: z.string().nullable(),
  tool_integrations_url: z.string().nullable(),
  api_docs_url: z.string().nullable(),
  logo_url: z.string().nullable(),

  category_slugs: z.array(z.string()),
  audience_slugs: z.array(z.string()),
  phase_slugs: z.array(z.string()),

  product_role: z.string(),
  integration_count: z.number().int().min(0),
  review_count: z.number().int().min(0),
  updated_at: z.string().datetime(),
});
export type VendorProduct = z.infer<typeof VendorProductSchema>;

/**
 * A claim/correction request touching this vendor or one of its products
 * (`vendor_requests`), so the dashboard can show "we're looking at it". The
 * free-text `body` and the submitter's identity are deliberately NOT here —
 * a correction may be filed by a member of the public, and the vendor has no
 * business reading who or what verbatim.
 */
export const VendorRequestSummarySchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['claim', 'correction']),
  target_type: z.enum(['product', 'vendor']),
  target_id: z.string().uuid(),
  status: z.enum(['open', 'in_review', 'resolved', 'rejected']),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
});
export type VendorRequestSummary = z.infer<typeof VendorRequestSummarySchema>;

/**
 * One seat on this vendor. Multi-seat is flat in ONE sense and no longer flat in
 * another (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6 + §11a): every seat has identical
 * DATA capabilities, but AECI-664 split out an `owner` bit that gates seat
 * management alone. A seat arrives either from an AECi claim grant (owner) or by
 * redeeming an owner's invite (not an owner) — the bound that stops one reviewed
 * human seeding an unbounded chain of unreviewed ones.
 *
 * `email` lives in Supabase `auth.users`, not D1, and is resolved through the
 * privileged admin seam. It degrades to `null` when the service-role key is
 * absent (local dev / PR previews), never a 500.
 *
 * `banned` reflects `profiles.banned_at` — a banned seat still appears on the
 * roster (per-seat ban never touches `vendors.verified`, §7) so co-admins can
 * see why a colleague is locked out.
 */
export const VendorSeatSchema = z.object({
  user_id: z.string().uuid(),
  display_name: z.string().nullable(),
  email: z.string().nullable(),
  banned: z.boolean(),
  created_at: z.string().datetime(),
  /** This seat is the CALLER's own (AECI-664). Server-computed: the roster has no
   *  other way to know, and the surface needs it twice — to label the row "you",
   *  and to hide a Remove button the API would 422 anyway (nobody removes
   *  themselves; leaving is a support conversation, not a button that can strand
   *  a vendor). */
  is_self: z.boolean(),
  /** This seat may invite and remove — `profiles.seat_owner` (§11a). On the
   *  roster so a member can see WHO to ask, which is the whole reason the
   *  non-owner copy can name a person instead of saying "contact support". */
  owner: z.boolean(),
});
export type VendorSeat = z.infer<typeof VendorSeatSchema>;

// ─── GET /api/vendor/me ──────────────────────────────────────────────────────

/**
 * The dashboard payload. One round-trip renders the whole surface: the vendor,
 * everything it owns, the state of any request against it, and how many seats
 * share the account. The seat ROSTER is a separate call (`GET /api/vendor/seats`)
 * because it needs the Supabase email lookup and the dashboard's first paint
 * shouldn't wait on it.
 *
 * `entitlement` (AECI-611, `STAGE_2_PAID_TIERS_SPEC.md` §4) rides along for free:
 * it is built from the session the guard already loaded, so it costs no query.
 * It is REQUIRED — this read is never gated (§4.3), so every caller gets a block,
 * and a lapsed vendor gets the downgraded one rather than a 404 dashboard.
 */
export const VendorMeResponseSchema = z.object({
  vendor: VendorAccountSchema,
  products: z.array(VendorProductSchema),
  requests: z.array(VendorRequestSummarySchema),
  seat_count: z.number().int().min(1),
  entitlement: VendorEntitlementBlockSchema,
});
export type VendorMeResponse = z.infer<typeof VendorMeResponseSchema>;

// ─── PATCH /api/vendor/profile ───────────────────────────────────────────────

/**
 * The vendor-editable fields on `vendors`. Everything absent from this object is
 * AECi-owned — most importantly `slug`, `company_name`, `verified`,
 * `promotion_status`, `admin_notes`, and the VQS scores.
 *
 * `source_url` is excluded on purpose: it records where AECi's own research came
 * from, so letting the subject of that research rewrite it would defeat it.
 */
export const UpdateVendorProfileSchema = z
  .object({
    description: longText.nullable().optional(),
    website: editableUrl.nullable().optional(),
    headquarters: shortText.nullable().optional(),
    founded_year: z.number().int().min(1800).max(2100).nullable().optional(),
    public_private: z.enum(PUBLIC_PRIVATE).nullable().optional(),
    parent_company: shortText.nullable().optional(),
    contact_email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
    phone_number: shortText.nullable().optional(),
    logo_url: editableUrl.nullable().optional(),

    linkedin_url: editableUrl.nullable().optional(),
    x_url: editableUrl.nullable().optional(),
    facebook_url: editableUrl.nullable().optional(),
    instagram_url: editableUrl.nullable().optional(),
    youtube_url: editableUrl.nullable().optional(),
    crunchbase_url: editableUrl.nullable().optional(),
    wiki_url: editableUrl.nullable().optional(),
    github_org: shortText.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Request must change at least one field',
      });
    }
  });
export type UpdateVendorProfileInput = z.infer<typeof UpdateVendorProfileSchema>;

/** `PATCH /api/vendor/profile` echoes the vendor's post-edit state. */
export const UpdateVendorProfileResponseSchema = z.object({ vendor: VendorAccountSchema });
export type UpdateVendorProfileResponse = z.infer<typeof UpdateVendorProfileResponseSchema>;

// ─── PATCH /api/vendor/products/:id ──────────────────────────────────────────

/**
 * The vendor-editable fields on an owned `products` row, plus taxonomy
 * assignment. `name`/`slug` are NOT editable — renaming a product breaks its
 * URL, its Algolia record, and every inbound link, so a rename stays a
 * correction request. `usefulness`, `has_api_docs`, research/priority/score
 * columns, and the denormalized counts are all AECi-owned.
 */
export const UpdateVendorProductSchema = z
  .object({
    description: longText.nullable().optional(),
    website: editableUrl.nullable().optional(),
    tool_integrations_url: editableUrl.nullable().optional(),
    api_docs_url: editableUrl.nullable().optional(),
    logo_url: editableUrl.nullable().optional(),

    category_slugs: termSlugList.optional(),
    audience_slugs: termSlugList.optional(),
    phase_slugs: termSlugList.optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: 'Request must change at least one field',
      });
    }
  });
export type UpdateVendorProductInput = z.infer<typeof UpdateVendorProductSchema>;

/** `PATCH /api/vendor/products/:id` echoes the product's post-edit state. */
export const UpdateVendorProductResponseSchema = z.object({ product: VendorProductSchema });
export type UpdateVendorProductResponse = z.infer<typeof UpdateVendorProductResponseSchema>;

// ─── GET /api/vendor/seats ───────────────────────────────────────────────────

/**
 * A pending seat invite (AECI-664 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a).
 *
 * **The `token` is never in this payload.** The roster is readable by every seat
 * on the vendor, and a token is the redeem handle — putting it here would let any
 * seat redeem an invite addressed to somebody else's mailbox. The only place a
 * token appears is the invite email itself; revoking uses the row `id`.
 *
 * `email` IS here, unlike on `VendorSeat`: an invite has no account behind it
 * yet, so the address is the only thing that identifies it, and the person who
 * typed it already knows it.
 */
export const VendorSeatInviteSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  /** `display_name` of the seat that sent it; `null` once that account is erased
   *  (the FK is `ON DELETE SET NULL` — the invite outlives its sender). */
  invited_by: z.string().nullable(),
  expires_at: z.string().datetime(),
  created_at: z.string().datetime(),
});
export type VendorSeatInvite = z.infer<typeof VendorSeatInviteSchema>;

/**
 * The vendor's seat roster. A bare object — the list is bounded by how many seats
 * a vendor has, so it is never paginated at launch.
 *
 * **Never capability-gated** (`STAGE_2_PAID_TIERS_SPEC.md` §4.3 — an acceptance
 * criterion with its own test): a vendor whose entitlement lapsed must still be
 * able to see and manage who has access.
 */
export const ListVendorSeatsResponseSchema = z.object({
  seats: z.array(VendorSeatSchema),
  /** Live invites (neither accepted nor revoked, not past `expires_at`). */
  pending_invites: z.array(VendorSeatInviteSchema),
  /**
   * Whether the CALLER may invite and remove — `profiles.seat_owner` (§11a).
   * Server-computed and shipped so the UI's enabled state and the 403 its write
   * would get cannot disagree; the surface never re-derives it from the roster.
   */
  can_manage_seats: z.boolean(),
});
export type ListVendorSeatsResponse = z.infer<typeof ListVendorSeatsResponseSchema>;

// ─── POST /api/vendor/seats/invites ──────────────────────────────────────────

/**
 * Invite a colleague. The ONLY field is the address: the vendor is the session's
 * (`requireVendor()`), the sender is the session's, and expiry is server policy.
 * Anything else here would be a client-supplied value on an authorization path.
 */
export const CreateSeatInviteSchema = z.object({
  email: z.string().trim().min(3).max(320).email(),
});
export type CreateSeatInviteInput = z.infer<typeof CreateSeatInviteSchema>;

/** `201` — echoes the created invite so the roster can append without refetching. */
export const CreateSeatInviteResponseSchema = z.object({ invite: VendorSeatInviteSchema });
export type CreateSeatInviteResponse = z.infer<typeof CreateSeatInviteResponseSchema>;

// ─── GET/POST /api/seat-invites/:token ───────────────────────────────────────

/**
 * What the invitee sees BEFORE accepting — deliberately thin.
 *
 * The token is in a URL, so treat everything behind it as semi-public: this
 * names the company and nothing else. No inviter identity, no seat roster, no
 * product list. `email` is echoed because the page has to be able to say *which*
 * address must be signed in, which is exactly the mismatch the redeemer needs
 * explained; it is the address they were already sent the link at.
 *
 * `redeemable` is the server's verdict, not a state machine the client
 * re-implements: `false` covers expired, revoked, already-accepted and
 * signed-in-as-the-wrong-address, with `reason` naming which.
 */
export const SeatInvitePreviewSchema = z.object({
  vendor_name: z.string(),
  email: z.string(),
  expires_at: z.string().datetime(),
  redeemable: z.boolean(),
  reason: z.enum(['ok', 'expired', 'revoked', 'accepted', 'email_mismatch']),
});
export type SeatInvitePreview = z.infer<typeof SeatInvitePreviewSchema>;

/** `POST /api/seat-invites/:token/accept` — where to send the redeemer next. */
export const AcceptSeatInviteResponseSchema = z.object({
  vendor_slug: z.string(),
  vendor_name: z.string(),
});
export type AcceptSeatInviteResponse = z.infer<typeof AcceptSeatInviteResponseSchema>;
