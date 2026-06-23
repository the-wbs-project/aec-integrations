/**
 * Phase 2.8 (AECI-54) taxonomy detail endpoint factory — Drizzle/D1 (ADR 0016 /
 * AECI-253).
 *
 *   GET /api/categories/:slug | /api/audiences/:slug | /api/phases/:slug
 *
 * The three handlers differ only by facet, so this factory parameterises on
 * `resource` (called 3× from `index.ts`). Each loads the term (+ its product
 * count via `extras`) and the linked promoted products via the relational `with`.
 * Visibility filtering of the embedded products is added in Phase 3 (AECI-254).
 */

import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { taxonomyAudiences, taxonomyCategories, taxonomyPhases } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  audienceTermConfig,
  categoryTermConfig,
  phaseTermConfig,
  productListConfig,
  toProductListItem,
  toTaxonomyTermWithCount,
  type RawProductListRow,
  type RawTaxonomyTermRow,
} from '../lib/drizzle-helpers';
import { reportMissingVendors, validateResponseInDev, type DbFactory } from '../lib/handler-utils';

/** Taxonomy resources that expose a detail endpoint. */
type TaxonomyResource = 'category' | 'audience' | 'phase';

export interface TaxonomyDetailConfig {
  /** Resource label for the 400 (`Missing <resource> slug`) + 404 `details.resource`. */
  resource: TaxonomyResource;
  /** Response schema, parsed in non-production via `validateResponseInDev`. */
  schema: { parse(value: unknown): unknown };
}

export function createTaxonomyDetailHandler(
  config: TaxonomyDetailConfig,
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${config.resource} slug`, {
        field: 'slug',
      });
    }

    const { db } = dbFor(c.env);
    let row: RawTaxonomyTermRow | undefined;
    let products: RawProductListRow[] = [];

    switch (config.resource) {
      case 'category': {
        const r = await db.query.taxonomyCategories.findFirst({
          ...categoryTermConfig,
          with: { productCategories: { with: { product: productListConfig } } },
          where: eq(taxonomyCategories.slug, slug),
        });
        if (r) {
          row = r;
          products = r.productCategories.map((x) => x.product);
        }
        break;
      }
      case 'audience': {
        const r = await db.query.taxonomyAudiences.findFirst({
          ...audienceTermConfig,
          with: { productAudiences: { with: { product: productListConfig } } },
          where: eq(taxonomyAudiences.slug, slug),
        });
        if (r) {
          row = r;
          products = r.productAudiences.map((x) => x.product);
        }
        break;
      }
      case 'phase': {
        const r = await db.query.taxonomyPhases.findFirst({
          ...phaseTermConfig,
          with: { productPhases: { with: { product: productListConfig } } },
          where: eq(taxonomyPhases.slug, slug),
        });
        if (r) {
          row = r;
          products = r.productPhases.map((x) => x.product);
        }
        break;
      }
    }

    if (!row) throw notFoundError(config.resource, { slug });

    const body = {
      ...toTaxonomyTermWithCount(row),
      products: products.map(toProductListItem),
    };

    reportMissingVendors(c, body.products);

    validateResponseInDev(c.env, () => {
      config.schema.parse(body);
    });

    return json(body);
  };
}
