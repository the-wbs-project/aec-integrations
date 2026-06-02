import { PageViewPayloadSchema } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError } from '../errors';
import { noContent } from '../http';

/**
 * `POST /api/page-views` (AECI-55) — fire-and-forget page-view capture hook.
 *
 * **Phase 2: no-op. Phase 4 wires the write.** The handler validates the body
 * against `PageViewPayloadSchema` and returns 204. No `page_views` table and
 * no DB connection in Phase 2 — Phase 4 lands the migration, swaps this body
 * for an insert, and keeps the same Zod schema and 204 response shape so no
 * SSR caller has to be touched.
 *
 * Per Phase 2 Spec §7.1 and `docs/API_CONTRACTS.md` §6.9. Errors are thrown as
 * `ApiError` (bad JSON → `MALFORMED_REQUEST`) / `ZodError` (schema failure →
 * `VALIDATION_FAILED`); the root `onError` (AECI-101) renders them into the
 * canonical §3.3 envelope. `Cache-Control: private, no-store` is applied by
 * `noContent()` on success and by the canonical `json()` on the error path
 * (AECI-43 default). Mirrors the bad-JSON pattern in `routes/promote.ts`.
 */
export function createPageViewsHandler(): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }

    PageViewPayloadSchema.parse(raw);

    return noContent();
  };
}
