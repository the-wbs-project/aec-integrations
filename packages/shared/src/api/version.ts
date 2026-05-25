import { z } from 'zod';

/**
 * Environment label reported by `GET /api/version`. The fixed literals match
 * the `ENV` `vars` entry declared in each Worker's wrangler config; the
 * `preview-pr-N` shape is reserved for AECI-71's per-PR CI deploys, which will
 * compose the value from `ENV=preview` + an injected PR number. `development`
 * is what the API Worker returns when no `ENV` var is present (i.e., local
 * `wrangler dev` without an `--env` flag).
 */
export const EnvironmentSchema = z.union([
  z.literal('development'),
  z.literal('preview'),
  z.literal('staging'),
  z.literal('production'),
  z.string().regex(/^preview-pr-\d+$/),
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
