import { HttpClient, HttpParams } from '@angular/common/http';
import { DestroyRef, type Signal, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

import type { PaginatedResponse } from '@aeci/shared';

import { MetaService, type SetEntityMetaInput } from '../../core/meta.service';

/**
 * Shared mechanism behind the product / vendor / integration index pages
 * (AECI-107). Before this, the three index components each carried a byte-
 * identical copy of the URL-to-fetch-to-state pipeline; any change (a
 * `switchMap` race fix, an a11y tweak to the empty state) had to be hand-
 * applied three times and drifted. This factory owns that logic once. Each
 * entity page keeps only its template (so every `@@{entity}.*` i18n id stays in
 * the concrete template), its API path, response type, sort config, and SEO
 * meta.
 *
 * Why a factory and not an `@Injectable`: a root singleton can't carry the
 * per-entity response generic, and a component-provided injectable would add
 * lifecycle plumbing for no gain. `createPaginatedIndex` is called at field
 * initialization in the consuming component. Field initializers run in an
 * injection context, so `inject()` here is legal (and the no-constructor-body
 * `inject()` lint rule, ANGULAR_STYLE_GUIDE section 9, isn't tripped).
 *
 * Pipeline (Phase 2 Spec sections 7.1/7.3/7.4): drive the fetch from the URL.
 * Any change to `?page=` / `?sort=` (and any registered `passthroughParams`)
 * re-fetches. `perPage` defaults to 24 and is hard-clamped at 100 server-side.
 * The request is a plain `http.get(apiPath, { params })`; keeping it byte-
 * identical to the pre-refactor call preserves the SSR transfer-cache key
 * (`withHttpTransferCacheOptions` in `app.config.ts`) so the client doesn't
 * re-fetch on hydration.
 */
export interface PaginatedIndexConfig {
  /** Service-binding-proxied list endpoint, e.g. `/api/products`. */
  apiPath: string;
  /** Sort keys this page accepts; an unknown `?sort=` falls back to `defaultSort`. */
  validSorts: ReadonlySet<string>;
  /** Default sort key (products/vendors: `created`; integrations: `name`). */
  defaultSort: string;
  /** Page size sent to the API. Defaults to 24 (Phase 2 Spec section 7.1). */
  perPage?: number;
  /**
   * Extra query-param keys forwarded from the URL to the API request when
   * present (e.g. integrations' `sourceProductId` / `targetProductId`). Also
   * surfaced via `params()` for the page to drive filter UI state.
   */
  passthroughParams?: readonly string[];
  /** SEO metadata, set once. The page builds this with per-entity `$localize`. */
  meta: SetEntityMetaInput;
}

export interface PaginatedIndex<TResponse> {
  /** Latest response, or `null` while loading / after an error. */
  readonly data: Signal<TResponse | null>;
  /** Last fetch error, or `null`. Mutually exclusive with a fresh `data`. */
  readonly error: Signal<unknown>;
  /** Current sort key (for the sortable column header's active state). */
  readonly sort: Signal<string>;
  /** Registered passthrough params currently set in the URL (present values only). */
  readonly params: Signal<Record<string, string>>;
  /** Activate a sort key: validates, then navigates `?sort=&page=1` (merge). */
  onSortChange(key: string): void;
  /** Navigate to a page: `?page=` (merge). */
  onPageChange(page: number): void;
  /**
   * Merge-navigate arbitrary query params (used by the integrations filter to
   * apply/clear `sourceProductId` / `targetProductId`; `null` removes a param).
   */
  navigateWithParams(params: Record<string, string | number | null>): void;
  /**
   * Surface an out-of-band failure in the shared error state, clearing any
   * stale data so the table shows its error row. Used by the integrations
   * filter when slug resolution (`GET /api/products/:slug`) fails with a
   * non-404: that's a server error, not a "no match", so it must read as the
   * table error, not an inline filter message.
   */
  setError(err: unknown): void;
}

const DEFAULT_PER_PAGE = 24;

function parsePage(raw: string | null): number {
  const parsed = raw === null ? 1 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function createPaginatedIndex<TResponse extends PaginatedResponse<unknown>>(
  config: PaginatedIndexConfig,
): PaginatedIndex<TResponse> {
  const http = inject(HttpClient);
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const destroyRef = inject(DestroyRef);
  const meta = inject(MetaService);

  const perPage = config.perPage ?? DEFAULT_PER_PAGE;
  const passthroughParams = config.passthroughParams ?? [];

  const data = signal<TResponse | null>(null);
  const error = signal<unknown>(null);
  const sort = signal<string>(config.defaultSort);
  const params = signal<Record<string, string>>({});

  const parseSort = (raw: string | null): string =>
    raw && config.validSorts.has(raw) ? raw : config.defaultSort;

  meta.setEntityMeta(config.meta);

  route.queryParamMap
    .pipe(
      tap((queryParams) => {
        sort.set(parseSort(queryParams.get('sort')));
        const next: Record<string, string> = {};
        for (const key of passthroughParams) {
          const value = queryParams.get(key);
          if (value) next[key] = value;
        }
        params.set(next);
        // Reset to the loading state on every navigation so stale data from a
        // prior page never shows under a fresh request (or after an error).
        error.set(null);
        data.set(null);
      }),
      switchMap((queryParams) => {
        let httpParams = new HttpParams()
          .set('page', String(parsePage(queryParams.get('page'))))
          .set('perPage', String(perPage))
          .set('sort', parseSort(queryParams.get('sort')));
        for (const key of passthroughParams) {
          const value = queryParams.get(key);
          if (value) httpParams = httpParams.set(key, value);
        }
        return http.get<TResponse>(config.apiPath, { params: httpParams }).pipe(
          catchError((err: unknown) => {
            error.set(err);
            return of(null);
          }),
        );
      }),
      takeUntilDestroyed(destroyRef),
    )
    .subscribe((response) => {
      if (response) data.set(response);
    });

  return {
    data: data.asReadonly(),
    error: error.asReadonly(),
    sort: sort.asReadonly(),
    params: params.asReadonly(),
    onSortChange(key: string): void {
      if (!config.validSorts.has(key)) return;
      void router.navigate([], {
        relativeTo: route,
        queryParams: { sort: key, page: 1 },
        queryParamsHandling: 'merge',
      });
    },
    onPageChange(page: number): void {
      void router.navigate([], {
        relativeTo: route,
        queryParams: { page },
        queryParamsHandling: 'merge',
      });
    },
    navigateWithParams(queryParams: Record<string, string | number | null>): void {
      void router.navigate([], {
        relativeTo: route,
        queryParams,
        queryParamsHandling: 'merge',
      });
    },
    setError(err: unknown): void {
      data.set(null);
      error.set(err);
    },
  };
}
