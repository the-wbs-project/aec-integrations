import { PageViewPayloadSchema } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { badRequest, noContent } from '../http';

/**
 * `POST /api/page-views` (AECI-55) — fire-and-forget page-view capture hook.
 *
 * **Phase 2: no-op. Phase 4 wires the write.** The handler validates the body
 * against `PageViewPayloadSchema` and returns 204. No `page_views` table and
 * no DB connection in Phase 2 — Phase 4 lands the migration, swaps this body
 * for an insert, and keeps the same Zod schema and 204 response shape so no
 * SSR caller has to be touched.
 *
 * Per Phase 2 Spec §7.1 and `docs/API_CONTRACTS.md` §6.9. `Cache-Control:
 * private, no-store` is applied by both `noContent()` and `badRequest()` via
 * the shared http helpers (AECI-43 default).
 */
export function createPageViewsHandler(): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return badRequest('Invalid JSON body');
    }

    const parsed = PageViewPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') || '(root)';
      const message = first?.message ?? 'Invalid request body';
      return badRequest(`Invalid request body: ${path}: ${message}`);
    }

    return noContent();
  };
}
