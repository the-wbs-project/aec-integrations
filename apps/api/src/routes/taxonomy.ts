/**
 * Phase 2.8 (AECI-54) taxonomy aggregate endpoint — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 *   GET /api/taxonomy → { categories, audiences, phases, trades }
 *
 * Each list ships `TaxonomyTermWithCount[]` (counts via the per-term `extras`
 * subquery). `trades` (§5.5a / AECI-541) is ungated — sub-floor terms are
 * returned with their real count and each surface applies
 * `TRADE_PUBLISH_MIN_PRODUCTS` itself. Read-through cached in `TAXONOMY_KV`
 * (5-min TTL, the sole staleness bound — no active invalidation of this internal
 * key); a cached value predating a shape change fails `safeParse` and falls
 * through to a fresh fetch, so no key bump is needed. The KV binding is
 * optional: absent (local dev) → a direct DB query.
 */

import { TaxonomyResponseSchema, type TaxonomyResponse } from '@aeci/shared';
import { asc } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import {
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
} from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import {
  audienceTermConfig,
  categoryTermConfig,
  phaseTermConfig,
  toTaxonomyTermWithCount,
  tradeTermConfig,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

const CACHE_KEY = 'taxonomy:v1';
const CACHE_TTL_SECONDS = 300; // 5 minutes — sole staleness bound (see header).

export function createTaxonomyHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const kv = c.env.TAXONOMY_KV;

    if (kv) {
      const cached = await kv.get(CACHE_KEY, 'json');
      if (cached) {
        const parsed = TaxonomyResponseSchema.safeParse(cached);
        if (parsed.success) return json(parsed.data);
        // Cached value drifted from the schema — fall through to a fresh fetch.
      }
    }

    const { db } = dbFor(c.env);
    const [categories, audiences, phases, trades] = await Promise.all([
      db.query.taxonomyCategories.findMany({
        ...categoryTermConfig,
        orderBy: [asc(taxonomyCategories.displayOrder), asc(taxonomyCategories.name)],
      }),
      db.query.taxonomyAudiences.findMany({
        ...audienceTermConfig,
        orderBy: [asc(taxonomyAudiences.displayOrder), asc(taxonomyAudiences.name)],
      }),
      db.query.taxonomyPhases.findMany({
        ...phaseTermConfig,
        orderBy: [asc(taxonomyPhases.displayOrder), asc(taxonomyPhases.name)],
      }),
      db.query.taxonomyTrades.findMany({
        ...tradeTermConfig,
        orderBy: [asc(taxonomyTrades.displayOrder), asc(taxonomyTrades.name)],
      }),
    ]);

    const body: TaxonomyResponse = {
      categories: categories.map(toTaxonomyTermWithCount),
      audiences: audiences.map(toTaxonomyTermWithCount),
      phases: phases.map(toTaxonomyTermWithCount),
      trades: trades.map(toTaxonomyTermWithCount),
    };

    validateResponseInDev(c.env, () => {
      TaxonomyResponseSchema.parse(body);
    });

    if (kv) {
      c.executionCtx.waitUntil(
        kv.put(CACHE_KEY, JSON.stringify(body), { expirationTtl: CACHE_TTL_SECONDS }),
      );
    }

    return json(body);
  };
}
