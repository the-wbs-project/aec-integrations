/**
 * Landing-path parsing for the gateway's arrival write (AECI-1297).
 *
 * Since AECI-1297 the SSR Worker's gateway entrypoint writes every full-document
 * arrival, on an edge-cache HIT and a MISS alike. A HIT never runs the Angular
 * resolvers, so nothing on the request can say which entity the page shows. This
 * parser recovers both halves of what the resolvers used to attach, from the path
 * alone:
 *
 * - `route`: the route PATTERN the resolvers sent (`/products/:slug`), so the
 *   `page_views.path` column keeps its meaning. Every other path is its own route,
 *   which is what the old cacheable-branch fallback sent.
 * - `entity`: which entity table the API should look the slug up in. The spelling
 *   of `type` is the `entity_type` the resolvers sent. The API resolves the id;
 *   the gateway never reads the database.
 *
 * `path` is the concrete path with the locale prefix, query and fragment already
 * stripped. Only an exact detail shape parses as an entity: `/products/acme/review`
 * or `/categories/a/b` is a different page and falls back to the path itself.
 */
import { parsePairPagePath } from './pair-page-path';

/** The single-slug entity kinds a landing path can name. */
export type LandingEntityType = 'product' | 'vendor' | 'category' | 'audience' | 'phase' | 'trade';

export type LandingEntity = { type: LandingEntityType; slug: string } | { type: 'pair' };

export interface LandingPath {
  route: string;
  entity: LandingEntity | null;
}

/** URL segment → entity type. The taxonomy segments match the web app's `KIND_PATH_SEGMENT`. */
const SEGMENT_ENTITY: Readonly<Record<string, LandingEntityType>> = {
  products: 'product',
  vendors: 'vendor',
  categories: 'category',
  audiences: 'audience',
  phases: 'phase',
  trades: 'trade',
};

const PAIR_ROUTE = '/products/:contextSlug/integrations/:otherSlug';
const DETAIL_PATH_RE = /^\/([^/]+)\/([^/]+)$/;

function decodeSlug(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function parseLandingPath(path: string): LandingPath {
  if (parsePairPagePath(path)) return { route: PAIR_ROUTE, entity: { type: 'pair' } };
  const m = path.match(DETAIL_PATH_RE);
  if (m) {
    const segment = m[1]!;
    const type = Object.hasOwn(SEGMENT_ENTITY, segment) ? SEGMENT_ENTITY[segment] : undefined;
    const slug = decodeSlug(m[2]!);
    if (type && slug) return { route: `/${segment}/:slug`, entity: { type, slug } };
  }
  return { route: path, entity: null };
}
