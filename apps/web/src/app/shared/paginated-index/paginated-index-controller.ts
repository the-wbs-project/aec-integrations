import { httpResource } from '@angular/common/http';
import { type Signal, computed, inject, linkedSignal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type ParamMap, Router } from '@angular/router';

import type { PaginatedResponse } from '@aeci/shared';

import { MetaService, type SetEntityMetaInput } from '../../core/meta.service';

/**
 * Shared mechanism behind the product / vendor / integration index pages
 * (AECI-107). Before this, the three index components each carried a byte-
 * identical copy of the URL-to-fetch-to-state pipeline; any change (a race fix,
 * an a11y tweak to the empty state) had to be hand-applied three times and
 * drifted. This factory owns that logic once. Each entity page keeps only its
 * template (so every `@@{entity}.*` i18n id stays in the concrete template), its
 * API path, response type, sort config, and SEO meta.
 *
 * Why a factory and not an `@Injectable`: a root singleton can't carry the
 * per-entity response generic, and a component-provided injectable would add
 * lifecycle plumbing for no gain. `createPaginatedIndex` is called at field
 * initialization in the consuming component. Field initializers run in an
 * injection context, so `inject()` (and `httpResource()` / `toSignal()`, which
 * inject under the hood) is legal here.
 *
 * Pipeline (Phase 2 Spec sections 7.1/7.3/7.4): drive the fetch from the URL.
 * The active query params are read into a signal (`toSignal(queryParamMap)`),
 * and an `httpResource()` rebuilds its request from that signal — so any change
 * to `?page=` / `?sort=` (and any registered `passthroughParams`) re-fetches.
 * `perPage` defaults to 24 and is hard-clamped at 100 server-side.
 *
 * The resource cancels an in-flight request natively when the params change
 * (replacing the old RxJS `switchMap` race fix), and on every param change it
 * transitions to the loading state with no value — so `data()` resets to `null`
 * under a fresh request without any manual reset.
 *
 * SSR transfer cache: `httpResource()` issues a plain GET via `HttpClient`, so
 * the response is captured in the SSR→client HTTP transfer cache
 * (`withHttpTransferCacheOptions` in `app.config.ts`), keyed by URL + params.
 * Emitting the params in a stable order keeps that key byte-identical between
 * server and client so the client doesn't re-fetch on hydration. (Note: the
 * `id` SSR-cache option is a `resource()` / `rxResource()` feature, not a
 * `httpResource()` one — `httpResource()` relies on the HTTP transfer cache
 * above, which is the mechanism the index pages already used.)
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
  /**
   * Fixed, non-URL filter params merged into every request ahead of the URL
   * passthroughs (AECI-143). Read inside the `httpResource` computation so the
   * fetch re-runs if the returned values change. Powers the taxonomy browse
   * grid: the page locks its own dimension (`{kind}_id=<term.id>`) here while
   * cross-filters ride the URL via `passthroughParams`. `/products` passes none.
   * Keys with an `undefined` value are skipped. The function MUST return a
   * stable key order so the SSR transfer-cache key stays byte-identical across
   * server and client.
   */
  baseParams?: () => Record<string, string | undefined>;
  /**
   * Gate for the fetch (AECI-143). When provided and it returns `false`, the
   * `httpResource` request function returns `undefined` so no request fires and
   * `data()` stays `null`. The taxonomy browse page passes `() => term() !== null`
   * so a 404 (term not found) never fires a spurious whole-catalog `/api/products`
   * query — the grid isn't rendered on a 404, but the controller is still
   * constructed in the page's field initializer. Omitted ⇒ always enabled.
   */
  enabled?: () => boolean;
  /**
   * SEO metadata, set once. The page builds this with per-entity `$localize`.
   * Optional (AECI-143): the taxonomy browse page's meta is owned by its
   * resolver (term name + canonical), so it omits this to avoid clobbering the
   * resolved term meta with a generic index title.
   */
  meta?: SetEntityMetaInput;
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
   * table error, not an inline filter message. Cleared automatically on the
   * next navigation (a new request supersedes it).
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
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const meta = inject(MetaService);

  const perPage = config.perPage ?? DEFAULT_PER_PAGE;
  const passthroughParams = config.passthroughParams ?? [];

  const parseSort = (raw: string | null): string =>
    raw && config.validSorts.has(raw) ? raw : config.defaultSort;

  if (config.meta) meta.setEntityMeta(config.meta);

  // Active query params as a signal. Emits synchronously on subscribe (the
  // router seeds the current value), so `requireSync` holds.
  const queryParamMap = toSignal(route.queryParamMap, { requireSync: true });

  // URL-driven fetch. The request object is rebuilt whenever `queryParamMap`
  // changes; the resource cancels any in-flight request and reloads. Params are
  // emitted in a stable order (page, perPage, sort, then passthroughs) so the
  // SSR transfer-cache key stays byte-identical across server and client.
  const resource = httpResource<TResponse>(() => {
    if (config.enabled && !config.enabled()) return undefined;
    const qp = queryParamMap();
    const params: Record<string, string | number> = {
      page: parsePage(qp.get('page')),
      perPage,
      sort: parseSort(qp.get('sort')),
    };
    // Fixed (non-URL) base params first — e.g. the browse page's locked
    // `{kind}_id` — then the URL passthrough cross-filters. Stable key order
    // keeps the SSR transfer-cache key byte-identical across server + client.
    const base = config.baseParams?.();
    if (base) {
      for (const key of Object.keys(base)) {
        const value = base[key];
        if (value !== undefined) params[key] = value;
      }
    }
    for (const key of passthroughParams) {
      const value = qp.get(key);
      if (value) params[key] = value;
    }
    return { url: config.apiPath, params };
  });

  // Out-of-band error pushed by `setError()`. A `linkedSignal` keyed on the
  // query params resets to `null` on every navigation, so a forced error never
  // outlives the request it was raised against (mirroring the old per-nav
  // error/data reset).
  const overrideError = linkedSignal<ParamMap, unknown>({
    source: queryParamMap,
    computation: () => null,
  });

  // `data`/`error` are mutually exclusive: an override masks the resource value;
  // otherwise `data` is the resolved value (or `null` while loading / in error,
  // since `hasValue()` is false then), and `error` is the resource's error.
  const data = computed<TResponse | null>(() =>
    overrideError() != null ? null : resource.hasValue() ? resource.value() : null,
  );
  const error = computed<unknown>(() => overrideError() ?? resource.error() ?? null);
  const sort = computed<string>(() => parseSort(queryParamMap().get('sort')));
  const params = computed<Record<string, string>>(() => {
    const qp = queryParamMap();
    const next: Record<string, string> = {};
    for (const key of passthroughParams) {
      const value = qp.get(key);
      if (value) next[key] = value;
    }
    return next;
  });

  return {
    data,
    error,
    sort,
    params,
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
      overrideError.set(err);
    },
  };
}
