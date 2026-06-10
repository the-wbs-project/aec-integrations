import { z } from 'zod';

/**
 * Body schema for `POST /api/page-views`. Per Phase 2 Spec §7.1 the endpoint
 * is a fire-and-forget capture hook that returns 204 — a no-op in Phase 2,
 * wired to a real `page_views` insert in Phase 4 (AECI-177). The shape kept
 * intentionally lean: a route plus an optional entity reference is enough for
 * the server to populate the table without retrofitting the client.
 *
 * `entity_id`, when present, is the entity's own UUID (the SSR resolvers attach
 * `entity.id`); the API Worker maps `(entity_type, entity_id)` onto the
 * `product_id` / `vendor_id` foreign keys. The browser tracker omits the entity
 * fields entirely (it only knows the route).
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

/**
 * HTTP header names the SSR Worker uses to forward trusted Cloudflare request
 * context to the API Worker for `page_views` enrichment (AECI-177).
 *
 * `request.cf` (country / colo / asn / bot score) is populated on the inbound
 * eyeball request but does NOT survive the `env.API` service binding, so the
 * SSR Worker copies the needed fields onto these headers before proxying the
 * browser's `POST /api/page-views` (and on its own supplementary `firePageView`
 * call). The SSR Worker is the SOLE writer: on the proxy path it strips any
 * client-supplied copies first (anti-spoof), then sets them from `request.cf`.
 * The API Worker treats them as trusted because it has no public ingress
 * (service-binding only). See docs/API_CONTRACTS.md §6.9.
 */
export const PAGE_VIEW_CF_HEADERS = {
  country: 'x-aeci-cf-country',
  colo: 'x-aeci-cf-colo',
  asn: 'x-aeci-cf-asn',
  botScore: 'x-aeci-cf-bot-score',
} as const;
