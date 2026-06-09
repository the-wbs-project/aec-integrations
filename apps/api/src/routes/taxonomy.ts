/**
 * Phase 2.8 (AECI-54) taxonomy aggregate endpoint.
 *
 *   GET /api/taxonomy → { categories, audiences, phases }
 *
 * Each list ships `TaxonomyTermWithCount[]`. Consumed by the SSR Worker for the
 * flat taxonomy index pages (`/categories`, `/audiences`, `/phases`) and, since
 * AECI-156, by the client-side primary-nav flyouts (desktop bar + mobile
 * overlay). The taxonomy is small (≈30 terms) and rarely changes, so this
 * endpoint is read-through cached in KV with a 5-minute TTL. That TTL is the
 * only staleness bound: there is no active invalidation of this KV key — the
 * AECI-105 promote purge invalidates the edge `taxonomy` cache-tag (the SSR
 * taxonomy pages), not this internal KV entry.
 *
 * The KV binding (`TAXONOMY_KV`) is optional. If absent (e.g. local `wrangler
 * dev` without `--remote`), the handler falls back to a direct Prisma query.
 * This matches the AECI-54 acceptance criterion: "KV-cached if cache is
 * available, otherwise direct Prisma".
 */

import {
  TaxonomyResponseSchema,
  type TaxonomyResponse,
  type TaxonomyTermWithCount,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  categoryTermSelect,
  audienceTermSelect,
  phaseTermSelect,
  toTaxonomyTermWithCount,
} from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

const CACHE_KEY = 'taxonomy:v1';
const CACHE_TTL_SECONDS = 300; // 5 minutes — sole staleness bound; no active KV invalidation (see header).

export function createTaxonomyHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const kv = c.env.TAXONOMY_KV;

    if (kv) {
      const cached = await kv.get(CACHE_KEY, 'json');
      if (cached) {
        const parsed = TaxonomyResponseSchema.safeParse(cached);
        if (parsed.success) {
          return json(parsed.data);
        }
        // Cached value drifted from the schema (e.g. shape evolved across
        // deploys). Fall through to a fresh Prisma fetch + overwrite.
      }
    }

    const prisma = prismaFor(c.env);
    const [categories, audiences, phases] = await Promise.all([
      prisma.taxonomyCategory.findMany({
        select: categoryTermSelect,
        orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
      }),
      prisma.taxonomyAudience.findMany({
        select: audienceTermSelect,
        orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
      }),
      prisma.taxonomyPhase.findMany({
        select: phaseTermSelect,
        orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
      }),
    ]);

    const body: TaxonomyResponse = {
      categories: categories.map(
        (row): TaxonomyTermWithCount => toTaxonomyTermWithCount(row, 'productCategories'),
      ),
      audiences: audiences.map(
        (row): TaxonomyTermWithCount => toTaxonomyTermWithCount(row, 'productAudiences'),
      ),
      phases: phases.map(
        (row): TaxonomyTermWithCount => toTaxonomyTermWithCount(row, 'productPhases'),
      ),
    };

    validateResponseInDev(c.env, () => {
      TaxonomyResponseSchema.parse(body);
    });

    if (kv) {
      // Fire-and-forget — never block the response on the cache write.
      c.executionCtx.waitUntil(
        kv.put(CACHE_KEY, JSON.stringify(body), { expirationTtl: CACHE_TTL_SECONDS }),
      );
    }

    return json(body);
  };
}
