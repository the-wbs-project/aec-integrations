/**
 * Browser evidence contract (AECI-1713, epic AECI-1711). Split out of
 * `page-views.ts` for the reason `page-view-turnstile.ts` gives: `page-views.ts`
 * is in the browser's initial bundle, and esbuild keeps every Zod schema `const`
 * in a kept module. The plain constants (`BROWSER_EVIDENCE_VALUES`,
 * `BROWSER_EVIDENCE_URL`) stay in `page-views.ts` so the tracker can use them
 * without this schema.
 */
import { z } from 'zod';

import { TurnstileVerdictPostSchema } from './page-view-turnstile';
import { BROWSER_EVIDENCE_VALUES } from './page-views';

/**
 * Body schema for `POST /api/page-views/browser-evidence`: one word about one page
 * load, joined to that load's `page_views` row by its Ray ID.
 *
 * `cf_ray` is the ray the row was stored under. A landing view reads it from the
 * document's `Server-Timing: cfray` entry. An in-app view reads it from the same
 * entry on its own `POST /api/page-views` response. It reuses the exact Turnstile
 * pattern, which is the pattern the API accepts on the trusted `x-aeci-cf-ray`
 * header. Strict: an unknown key is a 400, so the body can never grow a field
 * that carries more than the one word.
 */
export const BrowserEvidencePostSchema = z
  .object({
    cf_ray: TurnstileVerdictPostSchema.shape.cf_ray,
    evidence: z.enum(BROWSER_EVIDENCE_VALUES),
  })
  .strict();

export type BrowserEvidencePost = z.infer<typeof BrowserEvidencePostSchema>;
