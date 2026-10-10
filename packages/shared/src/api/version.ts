import { z } from 'zod';

/**
 * Environment label reported by `GET /api/version`. The fixed literals match
 * the `ENV` `vars` entry declared in each Worker's wrangler config. `development`
 * is what local dev reports (the top-level wrangler block sets it, and the
 * Workers default to it when no `ENV` var is present). The `preview` literal and
 * the `preview-pr-N` shape retired with the per-PR preview tier (AECI-1268).
 */
export const EnvironmentSchema = z.union([
  z.literal('development'),
  z.literal('staging'),
  z.literal('demo'),
  z.literal('production'),
]);

export type Environment = z.infer<typeof EnvironmentSchema>;

/**
 * Contract for `GET /api/version` on both Workers (AECI-74). The endpoint is
 * public-readable, never cached, and used by AECI-71's `promote-to-prod`
 * workflow to verify that staging is at the commit being promoted.
 */
export const VersionResponseSchema = z.object({
  sha: z.string().min(1),
  deployedAt: z.string().datetime(),
  environment: EnvironmentSchema,
});

export type VersionResponse = z.infer<typeof VersionResponseSchema>;
