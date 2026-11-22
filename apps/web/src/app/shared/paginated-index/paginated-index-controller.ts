import { isPlatformBrowser } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  DestroyRef,
  PLATFORM_ID,
  type Signal,
  TransferState,
  computed,
  effect,
  inject,
  linkedSignal,
  makeStateKey,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationStart, type ParamMap, Router } from '@angular/router';
import { filter } from 'rxjs';

import type { PaginatedResponse } from '@aeci/shared';

import { listingCanonicalPath, servingOrigin } from '../../core/canonical';
import { MetaService, type SetEntityMetaInput } from '../../core/meta.service';
import { apiStateKey } from '../../core/server-api-interceptor';

import {
  HistoryTraversal,
  ListingHistoryStore,
  listingHistoryKey,
  listingPath,
} from './listing-history-store';
import {
  DEFAULT_PER_PAGE,
  type PaginatedIndexRequestConfig,
  buildIndexParams,
  indexRequestLine,
  parseIndexPage,
} from './paginated-index-request';

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
 * SSR (AECI-746 — this paragraph used to describe something that never happened).
 * A relative `/api/...` URL does not fetch during SSR on the edge, so for months
 * these pages server-rendered their ERROR branch to every crawler. The data now
 * arrives by prefetch instead: `createPaginatedIndexResolver` fetches page 1
 * through the service binding during route resolution and parks it in
 * `TransferState`, and `serverApiInterceptor` answers the `httpResource` request
 * from there — on the server, and again on the client so hydration does not
 * refetch. `buildIndexParams()` / `indexRequestLine()` in
 * `paginated-index-request.ts` are the single definition of the request line the
 * two sides agree on; the stable param order is load-bearing for that match.
 * Angular's own HTTP transfer cache is NOT the mechanism here.
 */
export interface PaginatedIndexConfig extends PaginatedIndexRequestConfig {
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
   * The listing's bare path for its self-canonical (`/products`, `/categories/bim`),
   * or `null` while there is none (an unresolved or missing term). When given,
   * the canonical and `og:url` follow `?page=` on every navigation, not only at
   * construction (AECI-1904): the router reuses the component, so a client
   * navigation from `?page=2` to the bare path would otherwise leave the head on
   * `?page=2`. The first run writes the value the server already rendered, so the
   * hydrated head does not drift (ADR 0011).
   */
  canonicalPath?: () => string | null;
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

export type { PaginatedIndexRequestConfig } from './paginated-index-request';

function parsePage(raw: string | null): number {
  return parseIndexPage(raw);
}

/**
 * What starts the append buffer over (AECI-1902): the sort and filters
 * (`resetKey`) and the page the URL starts the listing at.
 */
interface BufferKey {
  reset: string;
  page: number;
}

/** Pages read back from `ListingHistoryStore` for one request line (AECI-1900). */
interface Restored<TResponse> {
  line: string;
  pages: TResponse[];
}

/**
 * The listing page the SSR resolver parked in TransferState for this request
 * line, or `null` when there is none (AECI-1863). Reads without removing it:
 * `serverApiInterceptor` still answers the resource's request from it and
 * spends it there.
 */
function readSeed<TResponse>(
  transferState: TransferState,
  line: string | null,
): { line: string; body: TResponse } | null {
  if (line === null) return null;
  const key = makeStateKey<TResponse>(apiStateKey(line));
  if (!transferState.hasKey(key)) return null;
  const body = transferState.get<TResponse | null>(key, null);
  return body === null ? null : { line, body };
}

export function createPaginatedIndex<TResponse extends PaginatedResponse<unknown>>(
  config: PaginatedIndexConfig,
): PaginatedIndex<TResponse> {
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const meta = inject(MetaService);
  const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  const perPage = config.perPage ?? DEFAULT_PER_PAGE;
  const passthroughParams = config.passthroughParams ?? [];
  const mode = config.mode ?? 'replace';

  // AECI-1900: the rows a Back or Forward lands on. Browser and append mode only:
  // the server has no history, and replace mode has no "Load more" pages to lose.
  const history = isBrowser && mode === 'append' ? inject(ListingHistoryStore) : null;
  const traversal = history ? inject(HistoryTraversal) : null;
  if (history) {
    // Save as the reader leaves each history entry. A filter, sort or view change
    // on this page pushes a new entry and keeps this component, so leaving an
    // entry is a `NavigationStart`, not only a teardown. At that moment every
    // signal below still describes the entry being left.
    router.events
      .pipe(
        filter((e) => e instanceof NavigationStart),
        takeUntilDestroyed(),
      )
      .subscribe(() => saveForHistory());
    // And at teardown, registered before `toSignal` and `httpResource` so it runs
    // before their own, while every signal still reads its live value.
    inject(DestroyRef).onDestroy(() => saveForHistory());
  }

  const parseSort = (raw: string | null): string =>
    raw && config.validSorts.has(raw) ? raw : config.defaultSort;

  if (config.meta) meta.setEntityMeta(config.meta);

  // Active query params as a signal. Emits synchronously on subscribe (the
  // router seeds the current value), so `requireSync` holds.
  const queryParamMap = toSignal(route.queryParamMap, { requireSync: true });

  // AECI-1904: keep the self-canonical on the URL's `?page=`. Append mode never
  // writes `?page=` itself, so this moves only on a real navigation.
  const canonicalPath = config.canonicalPath;
  if (canonicalPath) {
    const origin = servingOrigin();
    effect(() => {
      const path = canonicalPath();
      if (path === null) return;
      meta.setListingCanonical(
        `${origin}${listingCanonicalPath(path, queryParamMap().get('page'))}`,
      );
    });
  }

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

  // The page the URL asks the listing to start at: `?page=`, or 1 when absent.
  // A number, so a navigation that leaves it alone (the `?view=` cards/table
  // toggle) does not notify anything below.
  const urlPage = computed<number>(() => parsePage(queryParamMap().get('page')));

  // Everything that starts the append buffer over: `resetKey` plus the URL's
  // first page (AECI-1902). Before, the first page was read once, when the
  // listing was built. A navigation that kept this component and changed only
  // `?page=` (the header "Browse" link from `/products?page=2` to `/products`,
  // or a Back to `?page=2` across an in-page filter change) left the old pages
  // on screen under the new URL.
  const bufferKey = computed<BufferKey>(() => ({ reset: resetKey(), page: urlPage() }), {
    equal: (a, b) => a.reset === b.reset && a.page === b.page,
  });

  // Append mode drives paging from this internal signal, NOT the URL — so loading
  // more never writes `?page=` to the address bar. It starts at the URL's first
  // page (so SSR of `/products?page=N` — reached by a crawler or a no-JS visitor
  // following the footer's fallback anchor — still renders page N and keeps the
  // crawl trail intact), advances via `loadMore()`, and starts over at the URL's
  // first page whenever `bufferKey` changes. A sort or filter change drops
  // `?page=` (`onSortChange`, `FacetSidebar`), so it starts over at 1. Replace
  // mode reads `?page=` straight from the URL (the classic prev/next paginator),
  // so this signal is inert there.
  const targetPage = linkedSignal<BufferKey, number>({
    source: bufferKey,
    computation: (key) => key.page,
  });

  // Per-page fetch. The request object is rebuilt whenever its inputs change; the
  // resource cancels any in-flight request and reloads. Params are emitted in a
  // stable order (page, perPage, sort, then passthroughs) so the SSR
  // transfer-cache key stays byte-identical across server and client.
  const requestParams = computed<Record<string, string | number> | undefined>(() => {
    if (config.enabled && !config.enabled()) return undefined;
    return buildIndexParams(config, queryParamMap(), {
      // Append mode advances via the internal `targetPage` signal (URL stays
      // clean); replace mode reads the page straight from `?page=`.
      page: mode === 'append' ? targetPage() : parsePage(queryParamMap().get('page')),
    });
  });
  // The request line the resource is asking for now, or `null` while disabled.
  // Built the way the resolver builds its TransferState key.
  const requestLine = computed<string | null>(() => {
    const params = requestParams();
    return params === undefined ? null : indexRequestLine(config, params);
  });

  // AECI-1900: on Back or Forward, the pages this listing showed when the reader
  // left that history entry, so the render is as tall as that page was and the
  // router's own scroll restoration can reach the saved position. Only a history
  // traversal reads the store; a fresh navigation to the same URL fetches.
  //
  // Read twice over. When the listing is built, inside the navigation. And on
  // each later change of request line, because a Back or Forward between two
  // filter or sort states on this page reuses this component: the query changes
  // and nothing is rebuilt. A change with no Back behind it ("Load more", a
  // filter click) finds nothing and fetches as before.
  //
  // Also on each start-over of the buffer (`bufferKey`), even when the request
  // line comes out the same (AECI-1902). `/products?page=2`, the header link to
  // `/products`, "Load more" to page 2, then Back: the line is page 2's both
  // before and after the Back, but the buffer starts over and must be read.
  const initialRestore = readRestored(requestLine());
  const restoreSource = computed<{ line: string | null; key: BufferKey }>(
    () => ({ line: requestLine(), key: bufferKey() }),
    { equal: (a, b) => a.line === b.line && a.key === b.key },
  );
  const restored = linkedSignal<
    { line: string | null; key: BufferKey },
    Restored<TResponse> | null
  >({
    source: restoreSource,
    computation: ({ line }, previous) => {
      if (previous == null) return initialRestore?.line === line ? initialRestore : null;
      return untracked(() => readRestored(line));
    },
  });

  // True while restored pages stand in for the request. The resource asks for
  // nothing meanwhile: the rows on screen stay exactly the ones the reader
  // left, with no refetch that could dim the grid or swap rows under them. Any
  // other change of request line ends it, and the resource fetches as on any
  // other visit.
  const restoreActive = computed<boolean>(() => restored() !== null);

  const resource = httpResource<TResponse>(() => {
    const params = requestParams();
    if (params === undefined || restoreActive()) return undefined;
    return { url: config.apiPath, params };
  });

  // AECI-1863: the page the server rendered, read synchronously on the first
  // client render. `httpResource` hands its first value back on a later
  // microtask, even when `serverApiInterceptor` answers from TransferState. So
  // without this the first client render had no items and took the "Loading
  // products…" branch, and hydration tore the server's grid and footer out of
  // the DOM and put them back about 10ms later. The seed is the same payload
  // the interceptor is about to serve, so the first client render matches the
  // server render. Read only, never removed: the interceptor still spends it.
  // A restored listing has its rows already and never takes the seed.
  const seed =
    isBrowser && initialRestore == null
      ? readSeed<TResponse>(inject(TransferState), requestLine())
      : null;

  // True only while the resource is still fetching the seeded request line for
  // the first time. Any change of request line ends it for good, so a later
  // reload of the same filters dims and shows its busy state as before.
  const seedActive = linkedSignal<string | null, boolean>({
    source: requestLine,
    computation: (line, previous) => previous == null && seed != null && line === seed.line,
  });
  const loading = computed<boolean>(() => resource.isLoading() && !seedActive());

  // The resource's value, or the seed while the resource is still fetching it.
  const current = computed<TResponse | undefined>(() => {
    if (resource.hasValue()) return resource.value();
    return seedActive() && seed != null ? seed.body : undefined;
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
    source: () => current(),
    computation: (current, previous) => current ?? previous?.value ?? null,
  });

  // `data`/`error` are mutually exclusive: an override (or a real fetch error)
  // masks the retained value so a failure clears stale rows; otherwise `data` is
  // the retained response (kept across reloads), and `error` is the resource's
  // error. `pending` is true whenever a request is in flight.
  const data = computed<TResponse | null>(() =>
    overrideError() != null || resource.error() ? null : retained(),
  );
  const pending = computed<boolean>(() => loading());
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
  // resource value. Resets to the fresh first page whenever `bufferKey` changes.
  const pages = linkedSignal<
    {
      key: BufferKey;
      value: TResponse | undefined;
      restored: Restored<TResponse> | null;
    },
    TResponse[]
  >({
    source: () => ({
      key: bufferKey(),
      value: current(),
      restored: restored(),
    }),
    computation: (source, previous) => {
      const value = source.value;
      // Replace mode never accumulates — latest page only (it's unused there, but
      // keep the signal well-defined so reads from either mode are safe).
      if (mode !== 'append') return value ? [value] : (previous?.value ?? []);
      // `bufferKey` keeps its object while nothing in it changes, so identity
      // is the change test.
      const isReset = previous != null && previous.source.key !== source.key;
      // The first evaluation, and every reset, starts from the restored pages
      // when a Back or Forward brought the reader here (AECI-1900), so the
      // render already has every page the reader saw on that history entry.
      const prior = previous == null || isReset ? (source.restored?.pages ?? []) : previous.value;
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
    source: () => ({ flat: pagesFlat(), loading: loading() }),
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
  // or a new `?page=`, which restarts at the URL's first page) is in flight —
  // NOT while appending a later page. Lets the page dim on reset but keep the
  // accumulated rows bright as it grows.
  const reloading = computed<boolean>(() => loading() && targetPage() <= urlPage());

  // --- History restore (AECI-1900) -------------------------------------------

  /** The store entry for this request line on a Back/Forward, or `null`. */
  function readRestored(line: string | null): Restored<TResponse> | null {
    if (!history || !traversal?.isTraversal()) return null;
    if (line === null) return null;
    // The history entry this Back/Forward returns to, so two visits to one URL
    // never share an entry.
    const pages = history.read<TResponse>(
      listingHistoryKey(listingPath(route.snapshot), line),
      traversal.restoredEntryId(),
    );
    return pages === null ? null : { line, pages: [...pages] };
  }

  /**
   * Store the pages on screen as the reader leaves this history entry, keyed by
   * the request line of the first page in the buffer and the entry on screen.
   * That line is the one a Back to this entry builds first (`?page=` sets
   * `targetPage` on every navigation), and that entry is the one it returns
   * to, so the two meet.
   */
  function saveForHistory(): void {
    if (!history || (config.enabled && !config.enabled())) return;
    const loaded = pages();
    const first = loaded[0];
    if (first === undefined) return;
    const line = indexRequestLine(
      config,
      buildIndexParams(config, queryParamMap(), { page: first.page }),
    );
    // The entry on screen may carry a new id after a Back or Forward. Its old
    // id's entries are dead, so they stop holding slots of the bound.
    history.retire(traversal?.retiredEntryId() ?? null);
    history.write(
      listingHistoryKey(listingPath(route.snapshot), line),
      traversal?.currentEntryId() ?? null,
      loaded,
    );
  }

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
      if (loading() || !hasMore()) return;
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
        // Stay in place, as a filter click does (facet-sidebar.ts).
        scroll: 'manual',
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
