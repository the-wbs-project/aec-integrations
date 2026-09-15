/**
 * The retired-slug → surviving-slug read surface (AECI-978 / `STAGE_3_SPEC.md` §2.6
 * option B; `docs/API_CONTRACTS.md` §3.9).
 *
 *   GET /api/slug-redirects                      — every mapping.
 *   GET /api/slug-redirects/:entity/:fromSlug    — the terminal slug for one.
 *
 * ── WHY THIS IS AN ENDPOINT AND NOT A FIELD ON THE 404 ────────────────────────
 *
 * The obvious alternative was to put `moved_to` in the `NOT_FOUND` envelope that
 * `GET /api/products/:slug` already throws, mirroring how AECI-953 put `moved_to`
 * on the pair payload. It was rejected for two reasons. The pair case can carry it
 * on a **200** — an emptied pair still renders — whereas a retired product has no
 * body at all, so the hint would have to ride an error shape that four other
 * consumers parse structurally. And §2.6 asks for the map to be consulted "only on
 * the not-found branch": a separate call makes that literally true and auditable,
 * where an enriched envelope makes every product read pay for the lookup.
 *
 * The cost is one extra service-binding round trip per detail 404. That is a request
 * we have already decided to fail, the response is `NOT_FOUND_TTL`-cached at the
 * edge, and the reads are a handful of rows on a table with no joins.
 *
 * ── BOTH ARE PUBLIC AND UNAUTHENTICATED ───────────────────────────────────────
 *
 * Same posture as every other read on the Phase 2.8 router. The map holds only what
 * a crawler could derive by following the 301s it already serves, and the list is
 * read by `sitemap.xml`, which is public by definition.
 */

import {
  SlugRedirectsListResponseSchema,
  SlugRedirectSchema,
  type SlugRedirect,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { isSlugRedirectEntity, listSlugRedirects, resolveSlugRedirect } from '../lib/slug-redirect';

/**
 * `GET /api/slug-redirects` — every mapping, unpaginated.
 *
 * Read by `sitemap.xml` (so a retired slug is never advertised) and by the IndexNow
 * drain (so one is never submitted for crawling). Both need the whole `from_slug`
 * set rather than a lookup, and the table is small by construction.
 */
export function createSlugRedirectsListHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);
    const body = { redirects: await listSlugRedirects(db) };
    validateResponseInDev(c.env, () => {
      SlugRedirectsListResponseSchema.parse(body);
    });
    return json(body);
  };
}

/**
 * `GET /api/slug-redirects/:entity/:fromSlug` — the terminal slug of the chain
 * starting at `fromSlug`, or the canonical `NOT_FOUND` envelope.
 *
 * The 404 is the ORDINARY answer here, not an error: the detail resolvers ask about
 * every slug that already missed, and almost all of them are junk. An unknown
 * `:entity` gets the same 404 rather than a 400 — the caller is our own resolver
 * passing its own `entityKind`, so an unknown value is a wiring bug, and answering
 * "no redirect" degrades to the ordinary 404 page instead of a 500.
 */
export function createSlugRedirectResolveHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const entity = c.req.param('entity');
    const fromSlug = c.req.param('fromSlug');
    if (!entity || !fromSlug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing slug redirect key', {
        field: entity ? 'fromSlug' : 'entity',
      });
    }
    if (!isSlugRedirectEntity(entity)) {
      throw notFoundError('slug_redirect', { slug: `${entity}/${fromSlug}` });
    }

    const { db } = dbFor(c.env);
    const toSlug = await resolveSlugRedirect(db, entity, fromSlug);
    if (!toSlug) throw notFoundError('slug_redirect', { slug: `${entity}/${fromSlug}` });

    const body: SlugRedirect = { entity, from_slug: fromSlug, to_slug: toSlug };
    validateResponseInDev(c.env, () => {
      SlugRedirectSchema.parse(body);
    });
    return json(body);
  };
}
