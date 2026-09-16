import { z } from 'zod';

/**
 * The STORED shape of `products.usefulness` — the "how teams use it" narrative.
 *
 * ── WHY THIS IS ITS OWN MODULE (AECI-963) ────────────────────────────────────
 * It used to live in `./products`, which is the natural home until you notice who
 * else needs it. `./vendor` does, since AECI-963 made the block vendor-editable,
 * and `./vendor` is imported by a LAZY route (`/vendor`). This package is marked
 * `sideEffects: false` precisely so the `export *` barrel tree-shakes (AECI-221 —
 * before that, one value import from a lazy route dragged the whole `api/*`
 * schema set plus the 327 kB zod chunk into the initial graph). Importing
 * `./products` from `./vendor` would undo part of that win, because `./products`
 * reaches `./reviews` and `./logo-read` and nothing on the vendor form needs
 * either.
 *
 * A leaf module with no imports but zod costs nothing and is the same declaration
 * both sides already agreed on. Re-declaring the shape inside `./vendor` would be
 * drift on a contract the public product page renders.
 */

/**
 * One group: the narrative for ONE audience or phase term.
 *
 * `usefulness` is narrative value, NOT a taxonomy facet. Each group elaborates one
 * audience or phase term by `slug`/`name` (same field types as LinkRef, but it
 * carries NO `id` — it is slug-based, not a hydrated LinkRef; do not "fix" this by
 * extending LinkRefSchema). `points` holds >= 1 bullet, in display order.
 *
 * **`name` is server-resolved on every write path and is never caller-supplied.**
 * The public page interpolates it verbatim (`product-usefulness.ts` renders
 * `{{ group.name }}`), so a reader parses it as an AECi taxonomy label. Promote
 * resolves it from the taxonomy row, and so does the vendor PATCH — which is why
 * `VendorUsefulnessSchema` (`./vendor`) accepts `slug` + `points` and nothing else.
 */
export const UsefulnessGroupSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  points: z.array(z.string().min(1)).min(1),
});

export type UsefulnessGroup = z.infer<typeof UsefulnessGroupSchema>;

export const ProductUsefulnessSchema = z.object({
  audiences: z.array(UsefulnessGroupSchema),
  phases: z.array(UsefulnessGroupSchema),
});

export type ProductUsefulness = z.infer<typeof ProductUsefulnessSchema>;
