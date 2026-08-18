import { z } from 'zod';

import { MAX_VERSION_SORT_KEY } from '../version-sort';

/**
 * Product-version contracts (`/api/vendor/products/:id/versions`, AECI-607 /
 * Stage 2), behind the `requireVendor()` guard plus the ownership + Verified
 * checks in `apps/api/src/routes/vendor-product-versions.ts`:
 *
 *   GET    /api/vendor/products/:id/versions               — the ordered list.
 *   POST   /api/vendor/products/:id/versions               — create one.
 *   PATCH  /api/vendor/products/:id/versions/:versionId    — edit one.
 *   DELETE /api/vendor/products/:id/versions/:versionId    — remove one (204).
 *
 * Source of truth: `STAGE_2_ATTESTATIONS_SPEC.md` §8, `API_CONTRACTS.md` §6.14.
 *
 * Named `product-versions` and NOT `version` — `./version.ts` is the deploy
 * `GET /api/version` contract, a completely unrelated surface.
 *
 * Three things these schemas encode:
 *
 * 1. **`sort_key` is the ordering, and the label never is.** Version labels do
 *    not sort lexically (`'2026.10' < '2026.9'`), so ordering keys off the
 *    INTEGER `sort_key` — see `@aeci/shared/version-sort`. The server derives it
 *    from the label on create; `sort_key` here is the vendor's escape hatch for
 *    labels the packer cannot read (`"LTS"`, `"Fall release"` both derive 0).
 * 2. **No vendor id, and no product id in a body.** Same invariant as
 *    `./vendor.ts`: the target product comes from the path and its ownership is
 *    proven server-side against the session's vendor before anything is read or
 *    written. A miss is a 404, never a 403.
 * 3. **Absent leaves alone, `null` clears** — the `./vendor.ts` PATCH convention,
 *    with one deliberate twist called out on `UpdateProductVersionSchema`.
 *
 * i18n note: this package is framework-agnostic (no `$localize`) — the messages
 * below are for API consumers / logs; the Angular dashboard renders its own copy.
 */

// ─── Field primitives ────────────────────────────────────────────────────────

/**
 * A version label. Free text on purpose — `2026.1`, `v5.2`, `R2024 SP1` and
 * `2026 Fall` are all real vendor conventions and AECi does not get to impose
 * one. Bounded at 60 characters: this renders in a selector, not a paragraph.
 */
const versionLabel = z.string().trim().min(1).max(60);

/**
 * A calendar date, `YYYY-MM-DD`. Release and sunset are *dates*, not instants —
 * matching the dormant `introduced_at` / `deprecated_at` stamps, whose promote
 * fixtures have always been date-only. Kept as a regex rather than a datetime so
 * a caller cannot smuggle a timezone-bearing instant into a column the UI will
 * render as a day.
 */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be an ISO calendar date (YYYY-MM-DD)');

/**
 * An explicit ordering override. Non-negative, and capped at the same ceiling
 * `deriveVersionSortKey` produces so a hand-set key can never leave the
 * safe-integer range the derived ones live in.
 */
const sortKey = z.number().int().min(0).max(MAX_VERSION_SORT_KEY);

// ─── Entity shape ────────────────────────────────────────────────────────────

/**
 * One version of a product. `sort_key` is exposed deliberately: the vendor
 * dashboard has to show the effective order and let the vendor correct it when
 * the derivation reads a label wrong, and AECI-303's selectors compare on it.
 */
export const ProductVersionSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  label: z.string().min(1),
  /** `YYYY-MM-DD`. Nullable, and therefore never an ordering input. */
  released_at: z.string().nullable(),
  sunset_at: z.string().nullable(),
  sort_key: z.number().int(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type ProductVersion = z.infer<typeof ProductVersionSchema>;

// ─── GET /api/vendor/products/:id/versions ───────────────────────────────────

/**
 * The product's versions, already ordered by `sort_key` (then `created_at`, then
 * `id` — see `compareProductVersions`). A bare object, never paginated: a
 * product's release history is bounded by how many releases it has had.
 */
export const ListProductVersionsResponseSchema = z.object({
  versions: z.array(ProductVersionSchema),
});
export type ListProductVersionsResponse = z.infer<typeof ListProductVersionsResponseSchema>;

// ─── POST / PATCH /api/vendor/products/:id/versions ──────────────────────────

/**
 * Create a version. `sort_key` is **optional**: omit it and the server derives it
 * from `label` (`2026.9` → 20_260_000_900_000). Send it to override a label the
 * derivation cannot read usefully — every digit-free label derives 0, and a
 * product with three of those needs the vendor to say what the order is.
 */
export const CreateProductVersionSchema = z.object({
  label: versionLabel,
  released_at: isoDate.nullable().optional(),
  sunset_at: isoDate.nullable().optional(),
  sort_key: sortKey.optional(),
});
export type CreateProductVersionInput = z.infer<typeof CreateProductVersionSchema>;

/**
 * Edit a version. Absent leaves the column alone; explicit `null` clears it.
 *
 * **`sort_key` never re-derives itself.** Changing `label` alone leaves the key
 * exactly where it was, and `sort_key: null` is the explicit "re-derive from the
 * (new) label" instruction. The alternative — silently re-deriving whenever the
 * label moves — would throw away a deliberate override the moment a vendor fixed
 * a typo in `"Fall release "`. So `null` here does NOT mean "clear the column"
 * (it is NOT NULL); it means "recompute it", which is the only PATCH field on the
 * whole `/api/vendor/*` surface where `null` carries that meaning.
 */
export const UpdateProductVersionSchema = z
  .object({
    label: versionLabel.optional(),
    released_at: isoDate.nullable().optional(),
    sunset_at: isoDate.nullable().optional(),
    sort_key: sortKey.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'Request must change at least one field',
      });
    }
  });
export type UpdateProductVersionInput = z.infer<typeof UpdateProductVersionSchema>;

/** `POST` and `PATCH` both echo the version's post-write state. */
export const ProductVersionResponseSchema = z.object({ version: ProductVersionSchema });
export type ProductVersionResponse = z.infer<typeof ProductVersionResponseSchema>;
