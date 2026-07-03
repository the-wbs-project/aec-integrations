/**
 * Phase 2.8 taxonomy list endpoints — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 *   GET /api/categories | /api/audiences | /api/phases
 *
 * All three return `{ data: TaxonomyTermWithCount[] }` (`CategoriesListResponseSchema`).
 * Not paginated (the taxonomy is small by design, §3.1). Per-slug detail goes
 * through `createTaxonomyDetailHandler`; the aggregate tree is `createTaxonomyHandler`.
 */

import { CategoriesListResponseSchema, type CategoriesListResponse } from '@aeci/shared';
import { asc } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { taxonomyAudiences, taxonomyCategories, taxonomyPhases } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import {
  audienceTermConfig,
  categoryTermConfig,
  phaseTermConfig,
  toTaxonomyTermWithCount,
  type RawTaxonomyTermRow,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

/** The three facet list endpoints, keyed by URL path segment. */
export type TaxonomyListKind = 'categories' | 'audiences' | 'phases';

export function createTaxonomyListHandler(
  kind: TaxonomyListKind,
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);

    let rows: RawTaxonomyTermRow[];
    switch (kind) {
      case 'categories':
        rows = await db.query.taxonomyCategories.findMany({
          ...categoryTermConfig,
          orderBy: [asc(taxonomyCategories.displayOrder), asc(taxonomyCategories.name)],
        });
        break;
      case 'audiences':
        rows = await db.query.taxonomyAudiences.findMany({
          ...audienceTermConfig,
          orderBy: [asc(taxonomyAudiences.displayOrder), asc(taxonomyAudiences.name)],
        });
        break;
      case 'phases':
        rows = await db.query.taxonomyPhases.findMany({
          ...phaseTermConfig,
          orderBy: [asc(taxonomyPhases.displayOrder), asc(taxonomyPhases.name)],
        });
        break;
    }

    const body: CategoriesListResponse = {
      data: rows.map(toTaxonomyTermWithCount),
    };

    validateResponseInDev(c.env, () => {
      CategoriesListResponseSchema.parse(body);
    });

    return json(body);
  };
}
