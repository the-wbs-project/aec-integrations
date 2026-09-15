/**
 * The retired-slug → surviving-slug read (AECI-978 / `STAGE_3_SPEC.md` §2.6 option B).
 *
 * `slug_redirects` is the general map the two hardcoded per-entity 301s asked for.
 * This module is its only reader, and it is consulted **only after a detail read
 * returned nothing** — §2.6 specifies it that way and `db/schema.ts` explains why a
 * live row has to beat a redirect.
 *
 * ── THE CHAIN IS FOLLOWED, NOT STORED FLAT ────────────────────────────────────
 *
 * A product can retire twice: `a` -> `b` today, `b` -> `c` next quarter. Writing the
 * second mapping should not require rewriting the first, because the operator adding
 * it has no reason to go looking for inbound rows — so the walk below follows the
 * chain to its end and the caller 301s straight to the terminal slug. That keeps the
 * reader on ONE redirect rather than a hop-per-rename, which is what search engines
 * and browsers both prefer.
 *
 * ── ONE READ, THEN AN IN-MEMORY WALK ──────────────────────────────────────────
 *
 * The chain is walked over the entity's whole mapping set, read once, rather than a
 * query per link. The table holds one row per retirement we have ever done — a
 * handful — and this runs on a request that has already decided to 404, so a second
 * D1 round trip per hop buys nothing. It also makes the cycle guard exact rather
 * than a round-trip budget.
 *
 * A cycle (`a` -> `b` -> `a`) resolves to `null`, not to the last link before it: a
 * half-followed chain would 301 into a loop that the edge then caches. The
 * `from_slug <> to_slug` CHECK only catches the one-row case; a two-row cycle is
 * perfectly insertable, so the guard has to live here too.
 *
 * Both failure shapes resolve to `null` rather than throwing. The caller's fallback
 * is the ordinary 404, which is exactly where a reader should land when the map
 * cannot answer.
 */

import type { SlugRedirect, SlugRedirectEntity } from '@aeci/shared';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { slugRedirects } from '../db/schema';

/** Runtime membership test for the path param, so an unknown kind 404s rather than
 *  running a query that can only return nothing. */
export function isSlugRedirectEntity(value: string): value is SlugRedirectEntity {
  return value === 'product' || value === 'vendor';
}

/**
 * The surviving slug for `fromSlug`, following the chain, or `null` when the map
 * has nothing for it (the ordinary case — most 404s are junk slugs).
 */
export async function resolveSlugRedirect(
  db: Db,
  entity: SlugRedirectEntity,
  fromSlug: string,
): Promise<string | null> {
  const rows = await db.query.slugRedirects.findMany({
    columns: { fromSlug: true, toSlug: true },
    where: eq(slugRedirects.entity, entity),
  });
  const next = new Map(rows.map((r) => [r.fromSlug, r.toSlug]));

  const seen = new Set<string>([fromSlug]);
  let current = fromSlug;
  let resolved: string | null = null;

  for (;;) {
    const to = next.get(current);
    if (to === undefined) return resolved;
    if (seen.has(to)) return null;
    seen.add(to);
    resolved = to;
    current = to;
  }
}

/**
 * Every mapping, for the callers that need the `from_slug` SET rather than one
 * lookup — the sitemap's exclusion and the IndexNow drain's filter. The table holds
 * a handful of rows by construction (one per retirement we have ever done), so this
 * is an unpaginated read on purpose.
 */
export async function listSlugRedirects(db: Db): Promise<SlugRedirect[]> {
  const rows = await db.query.slugRedirects.findMany({
    columns: { entity: true, fromSlug: true, toSlug: true },
    orderBy: [slugRedirects.entity, slugRedirects.fromSlug],
  });
  return rows.map((r) => ({
    entity: r.entity as SlugRedirectEntity,
    from_slug: r.fromSlug,
    to_slug: r.toSlug,
  }));
}

/** URL path segment per entity kind. The same two the detail routes use. */
const PATH_SEGMENT: Record<SlugRedirectEntity, string> = {
  product: 'products',
  vendor: 'vendors',
};

/**
 * The public URL PATHS that now only redirect, as a set — `/products/{from_slug}`,
 * `/vendors/{from_slug}`.
 *
 * Used by the IndexNow drain to drop a buffered URL rather than ask an engine to
 * crawl a 301. Exact paths only, deliberately: a pair URL that happens to name a
 * retired endpoint (`/products/{retired}/integrations/{other}`) is NOT in here,
 * because pair-page moves are AECI-953's mechanism and it answers its own 301 from
 * `integration_endpoint_moves`. Matching loosely would let this map silently
 * suppress URLs it knows nothing about.
 */
export function retiredSlugPaths(redirects: readonly SlugRedirect[]): Set<string> {
  return new Set(redirects.map((r) => `/${PATH_SEGMENT[r.entity]}/${r.from_slug}`));
}

/**
 * Does this absolute public URL point at a path that now only redirects?
 *
 * Compared on the parsed `pathname`, not by substring: a query string or a differing
 * origin must not change the answer, and `/products/procore-x` must not match a
 * retirement of `/products/procore`. An unparseable URL is treated as NOT retired —
 * the consumer's own transport is the right place for that to fail loudly.
 *
 * Shared by the IndexNow drain and the Google re-crawl queue, which apply the same
 * rule at their own choke points.
 */
export function isRetiredSlugUrl(url: string, retiredPaths: ReadonlySet<string>): boolean {
  try {
    return retiredPaths.has(new URL(url).pathname.replace(/\/+$/, ''));
  } catch {
    return false;
  }
}
