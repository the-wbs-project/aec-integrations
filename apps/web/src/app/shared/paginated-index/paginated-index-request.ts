/**
 * The request shape of a paginated listing, with no Angular DI attached (AECI-746).
 *
 * Deliberately its own module. `createPaginatedIndexResolver` is imported by
 * `app.routes.ts`, which is EAGER — so anything it can reach transitively lands in
 * the initial bundle. Importing this from `paginated-index-controller.ts` (which
 * pulls `MetaService`, `Router`, `httpResource`, …) or from a component module
 * dragged a lazy route into the eager graph and blew the 1 MB initial budget by
 * ~100 kB. Worse, a config literal that calls `canonicalUrl()` at module scope
 * runs `inject()` outside an injection context during route extraction and fails
 * the build with NG0203.
 *
 * So: request shape here (pure), presentation config next door (`meta`, `mode`,
 * `enabled`), and the two joined by `extends`. Keep this file free of `inject()`,
 * `$localize`, and component imports.
 */

import { HttpParams } from '@angular/common/http';
import type { ParamMap } from '@angular/router';

/** Everything needed to BUILD a listing request — and nothing about rendering it. */
export interface PaginatedIndexRequestConfig {
  /** Service-binding-proxied list endpoint, e.g. `/api/products`. */
  apiPath: string;
  validSorts: ReadonlySet<string>;
  defaultSort: string;
  perPage?: number;
  passthroughParams?: readonly string[];
  baseParams?: () => Record<string, string | undefined>;
}

export const DEFAULT_PER_PAGE = 24;

/** `?page=`, clamped to >= 1. A junk or absent value is page 1. */
export function parseIndexPage(raw: string | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * The ONE definition of a listing request's query params.
 *
 * Shared by `createPaginatedIndex` (which turns it into the `httpResource`
 * request) and `createPaginatedIndexResolver` (which turns it into the SSR fetch
 * and the TransferState key). Two copies of this construction is exactly how the
 * server would prefetch one URL and the client would then ask for a subtly
 * different one — a silent miss that costs a redundant round trip and, worse,
 * looks like it is working.
 *
 * **Key order is part of the contract.** `HttpParams.toString()` preserves
 * insertion order and the resulting request line IS the transfer key, so
 * `page, perPage, sort, …base, …passthrough` must stay stable. Do not "tidy" this
 * into a literal that reorders, and do not sort the keys.
 */
export function buildIndexParams(
  config: PaginatedIndexRequestConfig,
  qp: ParamMap,
  overrides: { page: number },
): Record<string, string | number> {
  const sort = qp.get('sort');
  const params: Record<string, string | number> = {
    page: overrides.page,
    perPage: config.perPage ?? DEFAULT_PER_PAGE,
    sort: sort !== null && config.validSorts.has(sort) ? sort : config.defaultSort,
  };
  // Fixed (non-URL) base params first — e.g. the browse page's locked
  // `{kind}_id` — then the URL passthrough cross-filters.
  const base = config.baseParams?.();
  if (base) {
    for (const key of Object.keys(base)) {
      const value = base[key];
      if (value !== undefined) params[key] = value;
    }
  }
  for (const key of config.passthroughParams ?? []) {
    const value = qp.get(key);
    if (value) params[key] = value;
  }
  return params;
}

/**
 * The exact string `HttpRequest.urlWithParams` will produce for these params.
 *
 * Built with Angular's own `HttpParams` precisely so the encoding cannot drift
 * from the client's — this string is the TransferState key, and a one-character
 * difference turns the whole prefetch into a silent no-op.
 */
export function indexRequestLine(
  config: PaginatedIndexRequestConfig,
  params: Record<string, string | number>,
): string {
  const query = new HttpParams({
    fromObject: params as Record<string, string | number | boolean>,
  }).toString();
  return query.length === 0 ? config.apiPath : `${config.apiPath}?${query}`;
}
