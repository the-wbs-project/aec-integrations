/**
 * SSR prefetch for `/products` (AECI-746).
 *
 * Thin on purpose: the behaviour is in `createPaginatedIndexResolver` and the
 * request shape is in `PRODUCTS_INDEX_REQUEST` — the same object the component
 * spreads into `createPaginatedIndex`, so the prefetched request line and the
 * requested one cannot diverge. Imports nothing from the component module, which
 * is lazy and must stay out of the eager route graph.
 */
import type { ResolveFn } from '@angular/router';

import { createPaginatedIndexResolver } from '../shared/paginated-index/paginated-index.resolver';

import { PRODUCTS_INDEX_REQUEST } from './products-index.config';

export const productsIndexResolver: ResolveFn<boolean> =
  createPaginatedIndexResolver(PRODUCTS_INDEX_REQUEST);
