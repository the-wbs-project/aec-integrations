/**
 * Phase 2.8 (AECI-54) taxonomy detail endpoint factory.
 *
 *   GET /api/categories/:slug   — single category detail with embedded products.
 *   GET /api/disciplines/:slug  — single discipline detail with embedded products.
 *   GET /api/phases/:slug       — single phase detail with embedded products.
 *
 * The three handlers were byte-for-byte identical apart from the Prisma model,
 * the relation/count field, the resource label, and the response schema. This
 * factory parameterises those four points (AECI-120 A6) and is called 3× from
 * `index.ts`. The list endpoint (`GET /api/categories`) stays in
 * `routes/categories.ts` — only the *detail* shape is shared here.
 *
 * No list endpoint for disciplines/phases per Phase 2 Spec §7.1 — those are read
 * via `GET /api/taxonomy` when the SSR Worker needs the whole tree.
 */

import type { Context } from 'hono';

import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  productListSelect,
  taxonomyDetailScalarSelect,
  toProductListItem,
  toTaxonomyTermWithCount,
  type RawTaxonomyDetailRow,
  type TaxonomyCountKey,
} from '../lib/prisma-helpers';
import { getPrisma, type AcceleratedPrisma } from '../prisma';

/** Taxonomy resources that expose a detail endpoint (subset of `ResourceKind`). */
type TaxonomyResource = 'category' | 'discipline' | 'phase';

/** Minimal slice of a Prisma model delegate this handler drives. The dynamic
 * `select` (computed relation key) doesn't fit Prisma's strict per-model select
 * type, so the row is decoded with the same `as RawTaxonomyDetailRow` cast the
 * hand-written handlers used. */
interface TaxonomyDetailDelegate {
  findUnique(args: { where: { slug: string }; select: Record<string, unknown> }): Promise<unknown>;
}

export interface TaxonomyDetailConfig {
  /** Selects the model delegate off the per-request client, e.g. `(p) => p.taxonomyCategory`. */
  delegate: (prisma: AcceleratedPrisma) => unknown;
  /** Relation field on the term — also the `_count` key and the mapper's count key (all identical). */
  relationKey: TaxonomyCountKey;
  /** Resource label for the 400 (`Missing <resource> slug`) and 404 `details.resource`. */
  resource: TaxonomyResource;
  /** Response schema, parsed in non-production via `validateResponseInDev`. */
  schema: { parse(value: unknown): unknown };
}

export function createTaxonomyDetailHandler(
  config: TaxonomyDetailConfig,
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const slug = c.req.param('slug');
    if (!slug) {
      throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${config.resource} slug`, {
        field: 'slug',
      });
    }

    const prisma = prismaFor(c.env);
    const delegate = config.delegate(prisma) as TaxonomyDetailDelegate;
    const row = (await delegate.findUnique({
      where: { slug },
      select: {
        ...taxonomyDetailScalarSelect,
        _count: { select: { [config.relationKey]: true } },
        [config.relationKey]: { select: { product: { select: productListSelect } } },
      },
    })) as RawTaxonomyDetailRow | null;

    if (!row) throw notFoundError(config.resource, { slug });

    const products = (row[config.relationKey] ?? []).map((r) => r.product);

    const body = {
      ...toTaxonomyTermWithCount(row, config.relationKey),
      products: products.map(toProductListItem),
    };

    validateResponseInDev(c.env, () => {
      config.schema.parse(body);
    });

    return json(body);
  };
}
