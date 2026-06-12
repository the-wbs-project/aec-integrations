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
 * (replacing the old RxJS `switchMap` race fix) and transitions to the loading
 * state with no value. `data()` does not blank during that reload, though: a
 * `retained` linkedSignal holds the previous response across the in-flight
 * request (so filter/sort/page changes don't flash an empty grid), and only the
 * `pending` signal reflects the in-flight state. `data()` falls back to `null`
 * only on the first load (nothing retained yet) or when the fetch errors.
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
  /**
   * Pagination model.
   *
   * - `'replace'` (default) — each `?page=` navigation swaps in that single page;
   *   the consumer reads `data()` and renders `data().data`. This is the classic
   *   prev/next paginator behaviour; existing consumers are untouched.
   * - `'append'` — pages **accumulate** for the scroll-based listing UX. The
   *   consumer reads `items()` (the flattened, accumulated list) plus
   *   `total()` / `loadedCount()` / `hasMore()` and advances with `loadMore()`.
   *
   * The underlying per-page `httpResource` fetch is **identical** in both modes
   * (same URL, same stable param order), so SSR transfer-cache keying and the
   * per-`?page=` edge cache are unchanged — append just folds each resolved page
   * into a client-side buffer on top of that same fetch.
   */
  mode?: 'replace' | 'append';
}

export interface PaginatedIndex<TResponse extends PaginatedResponse<unknown>> {
  /**
   * Latest response. Retains the previously resolved response while a new
   * request is in flight (so filter/sort/page changes don't blank the grid),
   * and resets to `null` on error. Pair with `pending` for a busy affordance.
   */
  readonly data: Signal<TResponse | null>;
  /** True while a fetch is in flight. Drives a subtle busy/dim state in the grid. */
  readonly pending: Signal<boolean>;
  /** Last fetch error, or `null`. Mutually exclusive with a fresh `data`. */
  readonly error: Signal<unknown>;
  /** Current sort key (for the sortable column header's active state). */
  readonly sort: Signal<string>;
  /** Registered passthrough params currently set in the URL (present values only). */
  readonly params: Signal<Record<string, string>>;
  /**
   * Append-mode only. The flattened, **accumulated** list across every loaded
   * page, retained (not blanked) while a filter/sort reset refetches. In
   * `'replace'` mode this is unused — read `data()` instead.
   */
  readonly items: Signal<TResponse['data']>;
  /** Append-mode only. Total result count from the latest loaded page, or `null` before the first load. */
  readonly total: Signal<number | null>;
  /** Append-mode only. How many items are currently rendered (the accumulated length). */
  readonly loadedCount: Signal<number>;
  /** Append-mode only. The page number of the first item in the buffer (1 on normal entry; drives a truthful "featured lead"). */
  readonly firstPage: Signal<number>;
  /** Append-mode only. The highest page number loaded so far (the next `loadMore` fetches `highestPage + 1`). */
  readonly highestPage: Signal<number>;
  /** Append-mode only. True while more pages remain. */
  readonly hasMore: Signal<boolean>;
  /**
   * Append-mode only. True only while a RESET refetch (sort/filter change) is in
   * flight — false while appending a later page. Drives a dim-on-reset affordance
   * that keeps the accumulated rows bright as the list grows.
   */
  readonly reloading: Signal<boolean>;
  /**
   * Append-mode only. Fetch and append the next page. Paging is internal, so this
   * does NOT navigate — the page number never enters the URL. No-ops while a
   * request is in flight or when `hasMore` is false.
   */
  loadMore(): void;
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

  const mode = config.mode ?? 'replace';

  // Everything that must WIPE the append buffer when it changes: sort + the
  // non-`page` filters (baseParams + passthrough). NOT `page` — advancing the
  // page appends rather than resets.
  const resetKey = computed<string>(() => {
    const qp = queryParamMap();
    const parts: string[] = [`sort=${parseSort(qp.get('sort'))}`];
    const base = config.baseParams?.();
    if (base) {
      for (const key of Object.keys(base).sort()) parts.push(`${key}=${base[key] ?? ''}`);
    }
    for (const key of passthroughParams) parts.push(`${key}=${qp.get(key) ?? ''}`);
    return parts.join('&');
  });

  // Append mode drives paging from this internal signal, NOT the URL — so loading
  // more never writes `?page=` to the address bar. It is seeded from `?page=` on
  // the first evaluation (so SSR of `/products?page=N` — reached by a crawler or
  // a no-JS visitor following the footer's fallback anchor — still renders page N
  // and keeps the crawl trail intact), then advances via `loadMore()` and resets
  // to page 1 whenever `resetKey` changes (a sort/filter change). Replace mode
  // reads `?page=` straight from the URL (the classic prev/next paginator), so
  // this signal is inert there.
  const targetPage = linkedSignal<string, number>({
    source: resetKey,
    // Seed from the URL via the NON-reactive snapshot: reading the
    // `queryParamMap()` signal here would make it a tracked dependency, so an
    // unrelated nav (e.g. the `?view=` cards/table toggle) would reset the buffer
    // to page 1. The snapshot is correct on both the server and the first client
    // evaluation, and the reset is driven solely by `resetKey`.
    computation: (_key, previous) =>
      previous == null ? parsePage(route.snapshot.queryParamMap.get('page')) : 1,
  });

  // Per-page fetch. The request object is rebuilt whenever its inputs change; the
  // resource cancels any in-flight request and reloads. Params are emitted in a
  // stable order (page, perPage, sort, then passthroughs) so the SSR
  // transfer-cache key stays byte-identical across server and client.
  const resource = httpResource<TResponse>(() => {
    if (config.enabled && !config.enabled()) return undefined;
    const qp = queryParamMap();
    const params: Record<string, string | number> = {
      // Append mode advances via the internal `targetPage` signal (URL stays
      // clean); replace mode reads the page straight from `?page=`.
      page: mode === 'append' ? targetPage() : parsePage(qp.get('page')),
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

  // Retains the last resolved response so the grid keeps rendering rows while a
  // filter/sort/page change is in flight — no blank "loading" gap (the "flash"
  // AECI users saw when clicking a facet). `source` is the resource value while
  // it has one and `undefined` during a reload; the computation falls back to
  // the prior retained value so loading never clears the rows. First load still
  // shows the loading branch because `retained` is `null` until the first value.
  const retained = linkedSignal<TResponse | undefined, TResponse | null>({
    source: () => (resource.hasValue() ? resource.value() : undefined),
    computation: (current, previous) => current ?? previous?.value ?? null,
  });

  // `data`/`error` are mutually exclusive: an override (or a real fetch error)
  // masks the retained value so a failure clears stale rows; otherwise `data` is
  // the retained response (kept across reloads), and `error` is the resource's
  // error. `pending` is true whenever a request is in flight.
  const data = computed<TResponse | null>(() =>
    overrideError() != null || resource.error() ? null : retained(),
  );
  const pending = computed<boolean>(() => resource.isLoading());
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

  // --- Append mode -----------------------------------------------------------
  // Opt-in accumulation for the scroll-based listing UX. The single-page
  // `resource` above fetches one page (the `targetPage` signal in append mode);
  // this layer folds each resolved page into a buffer. `mode`, `resetKey`, and
  // `targetPage` are defined above the resource (which reads `targetPage`).

  // The accumulated pages, ascending and de-duped by page number. A pure
  // `linkedSignal` (no `effect`) so it folds correctly during SSR too: read in
  // the template on the server, it computes `[page1]` from the SSR-resolved
  // resource value. Resets to the fresh first page whenever `resetKey` changes.
  const pages = linkedSignal<{ key: string; value: TResponse | undefined }, TResponse[]>({
    source: () => ({
      key: resetKey(),
      value: resource.hasValue() ? resource.value() : undefined,
    }),
    computation: (source, previous) => {
      const value = source.value;
      // Replace mode never accumulates — latest page only (it's unused there, but
      // keep the signal well-defined so reads from either mode are safe).
      if (mode !== 'append') return value ? [value] : (previous?.value ?? []);
      const isReset = previous != null && previous.source.key !== source.key;
      const prior = isReset ? [] : (previous?.value ?? []);
      if (!value) return prior; // reload in flight — keep what we have
      if (prior.some((p) => p.page === value.page)) return prior; // dedupe (hydration double-resolve)
      return [...prior, value].sort((a, b) => a.page - b.page);
    },
  });

  const pagesFlat = computed<TResponse['data']>(
    () => pages().flatMap((p) => p.data) as TResponse['data'],
  );

  // Retains the last non-empty list while a filter/sort reset refetches, so the
  // grid dims rather than blanks — the append-mode analogue of `retained`. The
  // `loading` flag distinguishes "transiently empty mid-reload" (retain previous)
  // from "loaded an empty result set" (show the empty state).
  const displayItems = linkedSignal<
    { flat: TResponse['data']; loading: boolean },
    TResponse['data']
  >({
    source: () => ({ flat: pagesFlat(), loading: resource.isLoading() }),
    computation: (source, previous) => {
      if (source.flat.length > 0) return source.flat;
      if (source.loading) return previous?.value ?? ([] as unknown as TResponse['data']);
      return [] as unknown as TResponse['data'];
    },
  });

  const total = computed<number | null>(() => pages().at(-1)?.total ?? null);
  const loadedCount = computed<number>(() => displayItems().length);
  const firstPage = computed<number>(() => pages()[0]?.page ?? 1);
  const highestPage = computed<number>(() => pages().at(-1)?.page ?? 1);
  // More remains when the highest loaded page is below the last page. Keyed on
  // page index (not buffered item count) so a deep-link to `?page=K` — whose
  // buffer is missing pages 1..K-1 — correctly stops at the last page instead of
  // chasing phantom pages past the end.
  const hasMore = computed<boolean>(() => {
    const totalCount = total();
    if (totalCount == null) return false;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    return highestPage() < totalPages;
  });

  // Append-mode dim signal: true only while a RESET refetch (sort/filter change,
  // which restarts at page 1) is in flight — NOT while appending a later page.
  // Lets the page dim on reset but keep the accumulated rows bright as it grows.
  const reloading = computed<boolean>(() => resource.isLoading() && targetPage() <= 1);

  return {
    data,
    pending,
    error,
    sort,
    params,
    items: displayItems,
    total,
    loadedCount,
    firstPage,
    highestPage,
    hasMore,
    reloading,
    loadMore(): void {
      if (resource.isLoading() || !hasMore()) return;
      // Advance from the highest BUFFERED page, not the last ATTEMPTED one — no
      // router navigation, so the page number never enters the URL. If a prior
      // fetch failed, `targetPage` is already one past the buffer; a blind
      // increment would skip that page forever. Targeting `highestPage() + 1`
      // instead re-requests the gap.
      const next = highestPage() + 1;
      if (targetPage() === next) {
        // The previous attempt at `next` failed (the buffer never advanced).
        // Re-`set`ting an unchanged signal wouldn't re-fire the resource, so
        // retry the same page via an explicit reload.
        resource.reload();
      } else {
        targetPage.set(next);
      }
    },
    onSortChange(key: string): void {
      if (!config.validSorts.has(key)) return;
      void router.navigate([], {
        relativeTo: route,
        // Append mode keeps the page out of the URL (paging is internal, and a
        // sort change resets the buffer to page 1 anyway); replace mode resets
        // `?page=` to 1.
        queryParams: { sort: key, page: mode === 'append' ? null : 1 },
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
