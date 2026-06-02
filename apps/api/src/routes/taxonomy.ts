/**
 * Phase 2.8 (AECI-54) taxonomy aggregate endpoint.
 *
 *   GET /api/taxonomy → { categories, disciplines, phases }
 *
 * Each list ships `TaxonomyTermWithCount[]`. Used by the SSR Worker to render
 * nav, footer, and the flat `/categories` page. The taxonomy is small (≈30
 * terms) and rarely changes, so this endpoint is read-through cached in KV
 * with a 5-minute TTL. Cache invalidation lands in Phase 2.10 (admin/purge);
 * for now the TTL is the staleness bound.
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
  disciplineTermSelect,
  phaseTermSelect,
  toTaxonomyTermWithCount,
} from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

const CACHE_KEY = 'taxonomy:v1';
const CACHE_TTL_SECONDS = 300; // 5 minutes — staleness bound until admin/purge lands (Phase 2.10).

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
    const [categories, disciplines, phases] = await Promise.all([
      prisma.taxonomyCategory.findMany({
        select: categoryTermSelect,
        orderBy: [{ displayOrder: 'asc' as const }, { name: 'asc' as const }],
      }),
      prisma.taxonomyDiscipline.findMany({
        select: disciplineTermSelect,
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
      disciplines: disciplines.map(
        (row): TaxonomyTermWithCount => toTaxonomyTermWithCount(row, 'productDisciplines'),
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
