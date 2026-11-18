import { z } from 'zod';

import { ContextDirectionSchema, IntegrationTermSchema } from './integrations';
import { LinkRefSchema, ProductLinkSchema } from './common';

/**
 * `GET /api/products/:slug/integrations/:otherSlug/alternatives` (AECI-341, AECI-1829,
 * AECI-1830; `STAGE_1_5_SPEC.md` §11.3 and §11.4). What the empty pair page shows below
 * its hero: "What you would be moving" and the closest matches.
 *
 * Everything here is read from the two products' own integrations on record. Nothing is
 * inferred about the pair itself, and nothing reads a plan, a license or any paid input.
 *
 * - `moving`: the distinct data objects on each product's integrations, in three groups.
 *   Each group is in the data-object vocabulary's own order (`display_order`, then name).
 * - `lanes`: one per kept product. A match is a product the kept product has an
 *   integration on record with, and that shares at least one category with the other
 *   product. Matches run A to Z by name, the id breaking a tie (ruling R1). A product is
 *   never its own match, and neither of the pair's two products is a match.
 *
 * The page renders the context lane first. Both lanes come in one response so the keep
 * toggle needs no second read, and the cached server HTML is the same for every visitor.
 */

/** One match: a product the kept product connects to. */
export const PairAlternativeMatchSchema = z.object({
  /** The match. `logo_url` is withheld while the match is unclaimed (AECI-1618). */
  product: ProductLinkSchema,
  /** The match's primary vendor name, or `null`. */
  vendor_name: z.string().nullable(),
  review_count: z.number().int().min(0),
  /** `null` under five reviews (§5.5), as on every other public read. */
  rating_overall_avg: z.number().nullable(),
  rating_onboarding_avg: z.number().nullable(),
  /** The match's categories that the other product also carries, in the match's order. */
  shared_categories: z.array(IntegrationTermSchema),
  /** The data objects on the kept product's integrations with this match. */
  data_objects: z.array(IntegrationTermSchema),
  /** The direction those integrations move data, from the kept product's side. */
  direction: ContextDirectionSchema.nullable(),
  /** Whether both companies confirm every listed flow (`integrationAgreement`). A label. */
  confirmed: z.boolean(),
});
export type PairAlternativeMatch = z.infer<typeof PairAlternativeMatchSchema>;

/** One lane: the matches when the reader keeps one of the two products. */
export const PairAlternativeLaneSchema = z.object({
  /** The other product's categories, in its own order: the category anchors. */
  anchors: z.array(LinkRefSchema),
  /** A to Z by name, the id breaking a tie (ruling R1). */
  matches: z.array(PairAlternativeMatchSchema),
});
export type PairAlternativeLane = z.infer<typeof PairAlternativeLaneSchema>;

export const PairAlternativesSchema = z.object({
  moving: z.object({
    context_only: z.array(IntegrationTermSchema),
    both: z.array(IntegrationTermSchema),
    other_only: z.array(IntegrationTermSchema),
  }),
  lanes: z.object({
    /** Keep the URL's first product. */
    context: PairAlternativeLaneSchema,
    /** Keep the URL's second product. */
    other: PairAlternativeLaneSchema,
  }),
});
export type PairAlternatives = z.infer<typeof PairAlternativesSchema>;
