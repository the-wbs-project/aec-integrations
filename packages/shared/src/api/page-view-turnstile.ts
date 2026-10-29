/**
 * Turnstile verdict contract (AECI-1457 / AECI-1330), split out of
 * `page-views.ts` on purpose. The browser's `PageViewTracker` imports
 * `isUntrackedRoute` from `page-views.ts`, which keeps that module in the
 * initial bundle, and a Zod builder chain is not provably pure, so esbuild keeps
 * every schema `const` in a kept module (the AECI-955 lesson in
 * `apps/web/angular.json`). Living here, these schemas load only with the lazy
 * Turnstile chunk and on the API.
 */
import { z } from 'zod';

import { TURNSTILE_TOKEN_MAX } from './page-views';

/**
 * The three Cloudflare Turnstile verdicts `page_views.turnstile_verdict` stores
 * (AECI-1457). `pass` and `fail` are siteverify's answer. `unknown` means the check
 * could not run: a timeout, an outage, a spent token. It is never automation
 * evidence. Null on the column, never a fourth value, means no check was attempted.
 */
export const TURNSTILE_VERDICTS = ['pass', 'fail', 'unknown'] as const;

export type TurnstileVerdict = (typeof TURNSTILE_VERDICTS)[number];

/**
 * Body schema for `POST /api/page-views/turnstile` (AECI-1457 / AECI-1330): the
 * verdict for a LANDING view, whose `page_views` row the SSR gateway already wrote.
 *
 * The browser reads the page load's Ray ID from the gateway's `Server-Timing: cfray`
 * entry and runs Turnstile with that ray as `cData`. The API checks the token with
 * siteverify, requires the echoed `cdata` to equal `cf_ray`, and only then updates
 * the arrival row with that `cf_ray`. So a token minted for one page load cannot be
 * spent on another row. `cf_ray` is the same pattern the API accepts on the trusted
 * `x-aeci-cf-ray` header.
 */
export const TurnstileVerdictPostSchema = z.object({
  cf_ray: z.string().regex(/^[0-9a-f]{16}(-[A-Z]{3,4})?$/i),
  token: z.string().min(1).max(TURNSTILE_TOKEN_MAX),
});

export type TurnstileVerdictPost = z.infer<typeof TurnstileVerdictPostSchema>;
