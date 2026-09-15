import { z } from 'zod';

/**
 * The retired-slug → surviving-slug map (AECI-978 / `STAGE_3_SPEC.md` §2.6 option B,
 * `docs/API_CONTRACTS.md` §3.9).
 *
 * Two read endpoints over one tiny table:
 *
 *   - `GET /api/slug-redirects/:entity/:fromSlug` — the RESOLVE, called by the
 *     product and vendor detail resolvers **only after** their own read returned
 *     nothing. Answers the terminal slug of the chain, or the canonical `NOT_FOUND`
 *     envelope when the map has nothing, which is the ordinary case.
 *   - `GET /api/slug-redirects` — the LIST, called by `sitemap.xml` and the IndexNow
 *     drain so neither advertises a URL that only redirects.
 *
 * `entity` is the detail route the slugs belong to, and the union here mirrors the
 * `slug_redirects_entity_check` in D1 exactly. Widening one without the other is the
 * failure this shared schema exists to make loud.
 */
export const SlugRedirectEntitySchema = z.enum(['product', 'vendor']);

export type SlugRedirectEntity = z.infer<typeof SlugRedirectEntitySchema>;

/**
 * One mapping. `to_slug` on the resolve endpoint is the TERMINAL slug of the chain,
 * not the next hop — a reader should follow one redirect however many times the
 * entity has been retired.
 */
export const SlugRedirectSchema = z.object({
  entity: SlugRedirectEntitySchema,
  from_slug: z.string(),
  to_slug: z.string(),
});

export type SlugRedirect = z.infer<typeof SlugRedirectSchema>;

/**
 * `GET /api/slug-redirects`. Unpaginated on purpose: the table holds one row per
 * retirement we have ever performed, and both callers need the whole `from_slug` set
 * to filter against.
 */
export const SlugRedirectsListResponseSchema = z.object({
  redirects: z.array(SlugRedirectSchema),
});

export type SlugRedirectsListResponse = z.infer<typeof SlugRedirectsListResponseSchema>;
