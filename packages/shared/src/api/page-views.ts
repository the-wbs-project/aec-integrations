import { z } from 'zod';

/**
 * Body schema for `POST /api/page-views`. Per Phase 2 Spec §7.1 the endpoint
 * is a fire-and-forget capture hook that returns 204 — no-op in Phase 2,
 * writes to `page_views` in Phase 4 once that table lands. The shape kept
 * intentionally lean: a route plus an optional entity reference is enough
 * for Phase 4 to populate the table without retrofitting the client.
 *
 * Supersedes the earlier `TrackPageviewSchema` sketch in docs/API_CONTRACTS.md
 * §6.9 (path + product_id + vendor_id + session_id + referrer), which the
 * Phase 2 Spec replaces.
 */
export const PageViewPayloadSchema = z.object({
  route: z.string().min(1),
  entity_type: z.string().optional(),
  entity_id: z.string().optional(),
});

export type PageViewPayload = z.infer<typeof PageViewPayloadSchema>;
