/**
 * Whether the accessibility statement (`/accessibility`, AECI-1673) is public.
 *
 * **Off until AECI-1687.** The page says "Before major releases we also work
 * through a manual keyboard and screen-reader checklist", and no real VoiceOver or
 * NVDA session has run yet. Counsel's rule (Q40) is to state only what is true
 * on the day the page ships, so the page is built but hidden.
 *
 * This one flag gates every way to reach the page:
 * - the route in `app.routes.ts` (off → the `**` 404);
 * - the footer link (last in the Legal column, `layout/site-footer.ts`);
 * - the `sitemap.xml` entry (`server/sitemap.ts`);
 * - the static-page TTL (`ROUTE_CACHE_PATTERNS`) and `Cache-Tag: route:index`
 *   (`server/cache-tags.ts`), so a 404 is never cached on the 24h static TTL.
 *
 * AECI-1687's last step sets it to `true`. `docs/STAGE_1_SPEC.md` §27.6.
 *
 * Plain TypeScript with no Angular imports, so the SSR server modules can read it.
 * Widened to `boolean`, not the literal `false`, so code gated on it stays type-checked.
 */
export const ACCESSIBILITY_STATEMENT_PUBLISHED = false as boolean;
