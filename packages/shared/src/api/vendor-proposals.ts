import { z } from 'zod';

/**
 * The vendor portal's "Proposed products" tab contracts (AECI-1417, E6b.5; ADR 0042,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.22, `API_CONTRACTS.md` §6.14).
 *
 *   GET  /api/vendor/proposals              the open proposals for the seat's vendor
 *   POST /api/vendor/proposals/:id/accept   create the product exactly as proposed
 *   POST /api/vendor/proposals/:id/decline  record the decline
 *
 * All three sit behind `requireVendor()` then `requireSeatOwner()`: a proposal is the
 * owner's decision (ruled 2026-10-19), so a member seat gets `403`.
 *
 * ── WHAT ACCEPT MEANS (rulings B and Q6, 2026-10-19) ─────────────────────────────
 * Accept creates the product exactly as the review app sent it, with every vendor link
 * the payload names, owned and unowned. Nothing is edited on accept: an owner who sees
 * something wrong declines. Taxonomy is find-only against existing terms. A value that
 * names no existing term is dropped, listed on the read with `exists: false`, and
 * returned by the accept in `dropped`. An owner click never mints a term.
 */

/** The facets a proposal names values in. `usefulness` is a "How teams use it" group
 *  keyed on an audience or phase; `extension` is a host product the proposal extends. */
export const PROPOSAL_TERM_FACETS = [
  'category',
  'audience',
  'phase',
  'trade',
  'usefulness',
  'extension',
] as const;
export type ProposalTermFacet = (typeof PROPOSAL_TERM_FACETS)[number];

/** One value the proposal names. `exists: false` means an accept drops it. */
export const VendorProposalTermSchema = z.object({
  facet: z.enum(PROPOSAL_TERM_FACETS),
  /** The value as sent (a term name or slug, a usefulness group key, a host id). */
  value: z.string(),
  /** The stored term it resolves to, for display. `null` when it resolves to none. */
  name: z.string().nullable(),
  exists: z.boolean(),
});
export type VendorProposalTerm = z.infer<typeof VendorProposalTermSchema>;

/** One vendor the proposed product would be linked to. */
export const VendorProposalVendorSchema = z.object({
  id: z.string(),
  /** The stored company name, or the name sent when the row is gone. */
  name: z.string(),
  is_primary: z.boolean(),
  /** Whether the vendor owned its record when the proposal was stored. */
  owned: z.boolean(),
  /** `false` when the vendor row is gone: an accept is refused (`PROPOSAL_VENDOR_MISSING`). */
  exists: z.boolean(),
});
export type VendorProposalVendor = z.infer<typeof VendorProposalVendorSchema>;

/** The longest description excerpt the list returns. */
export const PROPOSAL_DESCRIPTION_EXCERPT_MAX = 400;

export const VendorProposalSchema = z.object({
  id: z.string(),
  proposed_at: z.string(),
  product: z.object({
    name: z.string(),
    /** The first {@link PROPOSAL_DESCRIPTION_EXCERPT_MAX} characters, or `null`. */
    description_excerpt: z.string().nullable(),
    website: z.string().nullable(),
    product_role: z.string(),
  }),
  vendors: z.array(VendorProposalVendorSchema),
  terms: z.array(VendorProposalTermSchema),
});
export type VendorProposal = z.infer<typeof VendorProposalSchema>;

/** The most open proposals one read returns. Oldest beyond it wait for the next read. */
export const VENDOR_PROPOSALS_MAX = 100;

export const ListVendorProposalsResponseSchema = z.object({
  proposals: z.array(VendorProposalSchema),
  truncated: z.boolean(),
});
export type ListVendorProposalsResponse = z.infer<typeof ListVendorProposalsResponseSchema>;

/** A value an accept dropped because it names no existing term. */
export const DroppedProposalTermSchema = z.object({
  facet: z.enum(PROPOSAL_TERM_FACETS),
  value: z.string(),
});
export type DroppedProposalTerm = z.infer<typeof DroppedProposalTermSchema>;

export const AcceptVendorProposalResponseSchema = z.object({
  proposal_id: z.string(),
  product: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  dropped: z.array(DroppedProposalTermSchema),
});
export type AcceptVendorProposalResponse = z.infer<typeof AcceptVendorProposalResponseSchema>;
