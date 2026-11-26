import { z } from 'zod';

/**
 * `products.summary` (AECI-2198, `DATABASE_SCHEMA.md` §4.2): the one-line
 * summary the product hero shows in place of the clamped first paragraph of
 * `description`.
 *
 * A leaf module with no imports but zod, for the same reason as `./usefulness`: the
 * lazy `/vendor` chunk (`./vendor`) and promote (`./promote`) both need it, and neither
 * should pull `./products` in to get it.
 *
 * The one validation both write paths share. Promote and the portal trim, collapse every
 * run of whitespace (newlines included) to one space, read an empty result as NULL, and
 * cap the result at 155 characters, the meta-description length
 * (`META_DESCRIPTION_MAX`). The cap lives here only: the column has no CHECK, because a
 * CHECK recreates `products` (`docs/migrations.md` §0).
 */
export const PRODUCT_SUMMARY_MAX = 155;

/** Trim and collapse whitespace to one line. An empty result is NULL. */
export function normalizeSummary(value: string | null | undefined): string | null {
  if (value == null) return null;
  const line = value.replace(/\s+/g, ' ').trim();
  return line === '' ? null : line;
}

/**
 * The write shape: a string normalized by {@link normalizeSummary}, or null.
 * A value over the cap AFTER normalizing is a validation failure, never a truncation.
 * Callers add `.optional()` where omitting the key means "leave it alone".
 */
export const ProductSummarySchema = z
  .string()
  .nullable()
  .transform((value) => normalizeSummary(value))
  .refine((value) => value === null || value.length <= PRODUCT_SUMMARY_MAX, {
    message: `Keep the summary to ${PRODUCT_SUMMARY_MAX} characters or fewer`,
  });
