/**
 * Phase 4.4 (AECI-179) home-stats read endpoint.
 *
 *   GET /api/stats/home → HomeStatsResponse
 *
 * Reads the seven `home.*` keys from the `stats_cache` table (written daily by
 * the compute job, 4.3 / AECI-178) and assembles the `HomeStatsResponse` shape
 * (AECI-176). It **never live-aggregates** (docs/STAGE_1_SPEC.md §10) — the
 * cache is the only source.
 *
 * Resilience is the headline requirement: pre-launch (and between the table's
 * creation and the compute job's first run) the cache is sparse, so a missing
 * key — or a cached value that has drifted from its schema across deploys —
 * falls back to a sensible empty default rather than 500ing. Defaults:
 *   - scalars (`total_integrations`, `integrations_added_30d`)          → 0
 *   - single cards (`most_integrated_product`, `most_active_category`)  → null
 *   - lists (`recent_integrations`, `trending_products`,
 *            `recently_added_products`)                                 → []
 * The two card fields are `.nullable()` in `HomeStatsResponseSchema` precisely
 * so there is a valid empty representation (there is no empty-but-valid object
 * with a real UUID). The SSR home route (4.11) branches on `null`.
 *
 * Caching: the response inherits `Cache-Control: private, no-store` from `json`
 * — API responses are never edge-cached (docs/CACHE_STRATEGY.md §4, AECI-43),
 * and there is no `stats` tag in the §2 tag vocabulary. The issue AC's
 * edge-TTL/`stats`-tag wording is superseded by the doc: daily-freshness edge
 * caching lives on the SSR home route, not here.
 */

import {
  STATS_CACHE_KEYS,
  statsCacheValueSchemas,
  HomeStatsResponseSchema,
  type HomeStatsResponse,
} from '@aeci/shared';
import type { Context } from 'hono';
import type { z } from 'zod';

import type { Env } from '../env';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import { getPrisma } from '../prisma';

type HomeKey = Extract<(typeof STATS_CACHE_KEYS)[number], `home.${string}`>;

/** The `home.*` subset of the `stats_cache` keys this endpoint reads. */
const HOME_KEYS = STATS_CACHE_KEYS.filter((key): key is HomeKey => key.startsWith('home.'));

/**
 * Parse a cached value against its per-key schema, falling back to `fallback`
 * when the key is absent (sparse cache) or its value has drifted from the
 * schema (resilience — never 500). `F` is a distinct type param so a card key
 * can default to `null` while its schema's output type stays non-null.
 */
function parseOr<T, F>(schema: z.ZodType<T>, raw: unknown, fallback: F): T | F {
  if (raw === undefined) return fallback;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

export function createStatsHomeHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const prisma = prismaFor(c.env);

    const rows = await prisma.statsCache.findMany({
      where: { key: { in: [...HOME_KEYS] } },
      select: { key: true, value: true },
    });

    const byKey = new Map<string, unknown>(rows.map((row) => [row.key, row.value]));

    const body: HomeStatsResponse = {
      total_integrations: parseOr(
        statsCacheValueSchemas['home.total_integrations'],
        byKey.get('home.total_integrations'),
        0,
      ),
      integrations_added_30d: parseOr(
        statsCacheValueSchemas['home.integrations_added_30d'],
        byKey.get('home.integrations_added_30d'),
        0,
      ),
      most_integrated_product: parseOr(
        statsCacheValueSchemas['home.most_integrated_product'],
        byKey.get('home.most_integrated_product'),
        null,
      ),
      most_active_category: parseOr(
        statsCacheValueSchemas['home.most_active_category'],
        byKey.get('home.most_active_category'),
        null,
      ),
      recent_integrations: parseOr(
        statsCacheValueSchemas['home.recent_integrations'],
        byKey.get('home.recent_integrations'),
        [],
      ),
      trending_products: parseOr(
        statsCacheValueSchemas['home.trending_products'],
        byKey.get('home.trending_products'),
        [],
      ),
      recently_added_products: parseOr(
        statsCacheValueSchemas['home.recently_added_products'],
        byKey.get('home.recently_added_products'),
        [],
      ),
    };

    validateResponseInDev(c.env, () => {
      HomeStatsResponseSchema.parse(body);
    });

    return json(body);
  };
}
