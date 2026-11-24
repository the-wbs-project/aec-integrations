import { DatePipe } from '@angular/common';
import {
  Component,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type ParamMap, type Params, Router, RouterLink } from '@angular/router';

import { ADMIN_VENDOR_SORT_DEFAULT_ORDER } from '@aeci/shared';
import type { AdminVendorRow, AdminVendorSort, SortOrder } from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { PaginationFooter } from '../../shared/pagination/pagination-footer';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { AdminVendorsApi } from './admin-vendors-api';
import { BrandAssetRemovals } from './brand-asset-removals';
import { isReplayedEvent } from '../../core/event-replay';
import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import { FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { CONSOLE_CAPTION_CLASS, CONSOLE_TABLE } from '../console/console-table';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import {
  CONSOLE_FAILED_TEXT_CLASS,
  CONSOLE_LOAD_FAILED_CLASS,
  CONSOLE_STATUS_LINE_CLASS,
} from '../console/console-detail';

/** Rows per fetch. Scroll appends a page at a time, so this is a chunk size
 *  rather than a "page" the operator ever names. */
const PAGE_SIZE = 25;

/** A tri-state, never a toggle, for the reason `user-list.ts` gives for its Banned
 *  filter: "claimed", "unclaimed" and "don't filter" are three questions. */
type TriFilter = 'any' | 'true' | 'false';

/**
 * `/admin/vendors` — the operator's vendor list (AECI-652 /
 * `STAGE_2_PAID_TIERS_SPEC.md` §5.6), rendered in the `AdminShell` layout outlet.
 *
 * This is the screen whose absence was the whole problem. Until it existed the
 * only path to a vendor's plan ran through a `/admin/claims` card, so a
 * vendor that never filed a claim had no row to act on and concierge onboarding —
 * where AECi approaches the vendor rather than the reverse — could not be done at
 * all.
 *
 * Follows the `/admin/claims` shape: the gate and nav SSR via
 * `adminSummaryResolver` on the parent route; this screen paints its shell during
 * SSR and fetches client-side in `afterNextRender`, where the same-origin
 * `GET /api/admin/vendors` carries the session cookie for `requireAdmin()` to
 * verify. It never reads cookies or session state directly.
 *
 * Unlike the claim queue this one PAGES for real rather than loading
 * `perPage=100` once with a truncation note: a moderation backlog is bounded by
 * how fast humans file, the vendor catalog is not.
 *
 * ── SCROLL, NOT PREV/NEXT ───────────────────────────────────────────────────
 * Paging is **append-mode**: `<aec-pagination-footer>` (the same component the
 * public `/products` and taxonomy listings use) auto-loads the next chunk from an
 * `IntersectionObserver` sentinel, with a real "Load more" button underneath as
 * the keyboard / screen-reader floor. It replaces `<aec-admin-paginator>`, whose
 * Previous/Next buttons made "find the vendor whose name I half-remember" a
 * sequence of discrete round trips with a full repaint each time.
 *
 * Two consequences worth stating because they are easy to get wrong:
 *
 *  - **A filter, search or sort change RESETS the accumulation**, it does not
 *    append to it. `refilter()` clears `vendors` before refetching page 1;
 *    without that, re-sorting would splice a differently-ordered page onto the
 *    rows already on screen and produce duplicates.
 *  - **`page` is now internal.** No page number is displayed and none reaches the
 *    URL; the footer's "Showing X of N" is the position readout, and `total`
 *    still comes from the API's `count()` over the filter, so it describes the
 *    match set rather than what has been loaded.
 *
 * ── A TABLE, AND EVERY COLUMN SORTS ─────────────────────────────────────────
 * The rows were cards. Every field here is short and every row has the same
 * fields, which is the case a table is for: an operator comparing license counts
 * across a page of vendors is scanning a column, and cards made them read a
 * paragraph per row.
 *
 * Sorting is server-side or not offered at all — that rule has not changed, and a
 * header that reordered the rows already loaded while leaving the rest of the
 * catalog alone would be worse than no control, because under scroll paging the
 * operator cannot even see where the reordered set ends. What changed is the API:
 * `AdminVendorSortSchema` + `resolveAdminVendorOrderBy` order by all seven of this
 * table's columns, including the two that are SELECT aliases rather than columns
 * (`licenses`, the live license count, and `products`). AECI-1375 dropped the
 * entitlement and term columns with the entitlement screen. Add a column here and
 * it gets a case there, or it gets no header control.
 *
 * Each key still has a NATURAL direction, which is what an inactive header states
 * and what its first click produces; clicking the ACTIVE header reverses it and
 * sends `order` alongside `sort`. See `shared/sort-header/sort-header.ts` and
 * {@link order}.
 *
 * The Integrations column is gone. An operator on this screen is triaging
 * licenses and seats; the integration count is a catalog fact they act on at
 * `/admin/vendors/:id`, and dropping it also dropped a correlated subquery per
 * row from the query.
 *
 * ── CLAIMED (AECI-1934) ─────────────────────────────────────────────────────
 * A Claimed filter and a sortable Claimed on column, both over
 * `vendors.owned_at` (ADR 0042). Account active is the paid mirror and misses
 * every claimed vendor on the Free plan, which is most of them. The filter is
 * the same `<aec-select>` `/admin/users` uses for Banned. Both screens keep
 * their filters, search and sort in the URL (see {@link queryParams}), and any
 * change here resets to chunk 1.
 */
@Component({
  selector: 'aec-vendor-list',
  imports: [
    AecButton,
    Chip,
    AecSelect,
    BrandAssetRemovals,
    RouterLink,
    PaginationFooter,
    SortHeader,
    DatePipe,
  ],
  templateUrl: './vendor-list.html',
})
export class VendorList {
  private readonly api = inject(AdminVendorsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  // AECI-2112: the console table recipe and its shared pieces (mock-up 14).
  protected readonly t = CONSOLE_TABLE;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly statusLineClass = CONSOLE_STATUS_LINE_CLASS;
  protected readonly loadFailedClass = CONSOLE_LOAD_FAILED_CLASS;
  protected readonly failedTextClass = CONSOLE_FAILED_TEXT_CLASS;

  /** A console chip tone, by the console's word for the status. */
  protected tone(key: AdminStatusKey): ConsoleChipTone {
    return adminStatusTone(key);
  }

  /** Every row loaded so far — chunk 1 plus whatever scroll has appended. */
  protected readonly vendors = signal<readonly AdminVendorRow[]>([]);
  /** Rows matching the FILTER, from the API's `count()` — not rows on screen. */
  protected readonly total = signal(0);
  /** The next chunk to request. Internal: never displayed, never in the URL. */
  private readonly page = signal(1);

  protected readonly loading = signal(true);
  /** A scroll/click append is in flight (chunk 2+). Distinct from `loading`,
   *  which is the first-paint state that replaces the whole table. */
  protected readonly loadingMore = signal(false);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /**
   * The list's state lives in the URL (AECI-1934 review ruling): `search`,
   * `claimed`, `sort` and `order`. It is READ reactively, so reload, Back and a
   * shared link all restore it, and it is WRITTEN by pushing a navigation, the
   * way `admin/audit/audit-log.ts` does. Each change is a history entry, so Back
   * walks back through the operator's filters. A default is left out, so the
   * bare `/admin/vendors` stays canonical. `/admin` is never edge-cached, so no
   * cache key forks. `/admin/users` does the same, with its page added
   * (AECI-1935, `ADMIN_PANEL_SPEC.md` §5.8).
   *
   * A hand-edited junk value reads as the default rather than 400ing the request:
   * a bad link should narrow nothing, not break the screen.
   */
  private readonly queryParams = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });
  private readonly urlState = computed(() => readUrlState(this.queryParams()), {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  /** The committed search term, from the URL: what was last SENT, not what is
   *  being typed. Typing does not refetch; the form's submit does. A
   *  keystroke-per-request search over a `LIKE '%…%'` full scan would be a lot
   *  of scans to answer a question the operator has not finished asking. */
  protected readonly search = computed(() => this.urlState().search);
  protected readonly searchDraft = signal('');

  /**
   * The active sort key. Alphabetical by default, which is also the admin
   * schema's default (`AdminVendorSortSchema`): this is a lookup surface, and an
   * operator arriving to find one vendor starts by scanning names.
   */
  protected readonly sort = computed(() => this.urlState().sort);

  /**
   * The direction in effect for {@link sort}. Absent from the URL means the key's
   * NATURAL direction, so a first render and a bare `?sort=` request agree; a
   * second click on the active header flips it and writes `order`.
   *
   * Held beside the key rather than folded into it because the API takes them as
   * two parameters, and because switching columns must RESET to the new column's
   * natural direction — moving from "Updated ↓" to "Vendor" gives A–Z, not Z–A.
   */
  protected readonly order = computed(() => this.urlState().order);

  /** `owned_at` set (`'true'`), not set (`'false'`), or no filter. */
  protected readonly claimed = computed(() => this.urlState().claimed);

  protected readonly claimedOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.vendors.filter.claimed.any:All vendors` },
    { value: 'true', label: $localize`:@@admin.vendors.filter.claimed.yes:Claimed` },
    { value: 'false', label: $localize`:@@admin.vendors.filter.claimed.no:Unclaimed` },
  ];

  protected readonly isEmpty = computed(() => !this.loading() && this.vendors().length === 0);

  /** More rows exist behind what is on screen. Drives the sentinel + the button. */
  protected readonly hasMore = computed(() => this.vendors().length < this.total());

  /** False until the browser renders. Nothing is fetched during SSR, because the
   *  same-origin read needs the browser's session cookie. */
  private readonly ready = signal(false);

  /** Bumped by every load. A response from a superseded load (a fast Back, say)
   *  is dropped rather than painted over the newer one. */
  private loadSeq = 0;

  constructor() {
    afterNextRender(() => this.ready.set(true));

    // The search box follows the URL, so Back restores the text with the rows.
    effect(() => {
      const search = this.search();
      untracked(() => this.searchDraft.set(search));
    });

    // One fresh load per distinct URL state, including the first. Any change
    // discards the accumulation and refetches from chunk 1: appending across a
    // reordered or refiltered set would duplicate rows.
    effect(() => {
      if (!this.ready()) return;
      this.urlState();
      untracked(() => {
        this.page.set(1);
        this.vendors.set([]);
        void this.load();
      });
    });
  }

  protected onClaimedChange(value: string | null): void {
    const claimed = (value as TriFilter | null) ?? 'any';
    this.navigate({ ...this.urlState(), claimed });
  }

  protected onSearchInput(event: Event): void {
    this.searchDraft.set((event.target as HTMLInputElement).value);
  }

  /** The form's submit. Drops a replayed early submit. The form is `method="dialog"`,
   *  so the native submit did nothing (AECI-1919, `core/event-replay.ts`). */
  protected onSearchSubmit(event: Event): void {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    this.submitSearch();
  }

  protected submitSearch(): void {
    this.navigate({ ...this.urlState(), search: this.searchDraft().trim() });
  }

  protected clearSearch(): void {
    this.searchDraft.set('');
    this.navigate({ ...this.urlState(), search: '' });
  }

  /**
   * The direction to draw on a header — live for the active column, the key's
   * natural direction for every other one, which is also what clicking it will
   * produce. Read from the SHARED map, so the arrow cannot disagree with the
   * ORDER BY the server applies.
   */
  protected directionFor(key: AdminVendorSort): 'ascending' | 'descending' {
    const order = key === this.sort() ? this.order() : ADMIN_VENDOR_SORT_DEFAULT_ORDER[key];
    return order === 'asc' ? 'ascending' : 'descending';
  }

  /** The header emits both halves: an inactive column brings its natural
   *  direction, the active one brings the flip. */
  protected onSortChange(change: { key: string; order: 'asc' | 'desc' }): void {
    const sort = isSortKey(change.key) ? change.key : DEFAULT_SORT;
    this.navigate({ ...this.urlState(), sort, order: change.order });
  }

  /** Scroll sentinel or the "Load more" button: append the next chunk. Guarded
   *  so a sentinel that fires twice before the response lands cannot request the
   *  same chunk (or skip one) — the footer debounces on `pending` too, but the
   *  authority for "is a fetch in flight" belongs here. */
  protected loadMore(): void {
    if (this.loading() || this.loadingMore() || !this.hasMore()) return;
    this.page.update((p) => p + 1);
    void this.load({ append: true });
  }

  /** "Try again". With rows on screen the failure was an append, so resume the
   *  accumulation rather than throwing away what loaded successfully. */
  protected retry(): void {
    if (this.vendors().length > 0) {
      this.loadMore();
      return;
    }
    void this.load();
  }

  /** Push the new state into the URL, defaults left off. The URL effect in the
   *  constructor does the reset and the fetch, so Back takes the same path. */
  private navigate(state: UrlState): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toQueryParams(state),
    });
  }

  private async load({ append = false }: { append?: boolean } = {}): Promise<void> {
    const seq = ++this.loadSeq;
    if (append) this.loadingMore.set(true);
    else this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const search = this.search();
      const claimed = this.claimed();
      const response = await this.api.listVendors({
        page: this.page(),
        perPage: PAGE_SIZE,
        sort: this.sort(),
        order: this.order(),
        ...(search ? { search } : {}),
        ...(claimed === 'any' ? {} : { claimed }),
      });
      if (seq !== this.loadSeq) return;
      this.vendors.update((rows) => (append ? [...rows, ...response.data] : response.data));
      this.total.set(response.total);
      this.liveMessage.set(
        $localize`:@@admin.vendors.announce.loaded:${response.total}:COUNT: vendors match.`,
      );
    } catch {
      if (seq !== this.loadSeq) return;
      this.loadFailed.set(true);
      if (append) {
        // Keep what is already on screen and step the cursor back, so a retry
        // (scroll or click) asks for the chunk that failed rather than the one
        // after it.
        this.page.update((p) => Math.max(1, p - 1));
      } else {
        this.vendors.set([]);
        this.total.set(0);
      }
    } finally {
      if (seq === this.loadSeq) {
        this.loading.set(false);
        this.loadingMore.set(false);
      }
    }
  }
}

// ─── URL state ───────────────────────────────────────────────────────────────

interface UrlState {
  search: string;
  claimed: TriFilter;
  sort: AdminVendorSort;
  order: SortOrder;
}

const DEFAULT_SORT: AdminVendorSort = 'name';

function isSortKey(value: string | null): value is AdminVendorSort {
  return value !== null && Object.hasOwn(ADMIN_VENDOR_SORT_DEFAULT_ORDER, value);
}

/** The URL, sanitised. A junk value reads as its default. An absent `order`
 *  is the sort key's natural direction. */
function readUrlState(params: ParamMap): UrlState {
  const rawSort = params.get('sort');
  const sort = isSortKey(rawSort) ? rawSort : DEFAULT_SORT;
  const rawOrder = params.get('order');
  const order: SortOrder =
    rawOrder === 'asc' || rawOrder === 'desc' ? rawOrder : ADMIN_VENDOR_SORT_DEFAULT_ORDER[sort];
  const rawClaimed = params.get('claimed');
  const claimed: TriFilter = rawClaimed === 'true' || rawClaimed === 'false' ? rawClaimed : 'any';
  return { search: params.get('search')?.trim() ?? '', claimed, sort, order };
}

/** Every key is written, with `null` for a default, so a default DROPS from the
 *  URL rather than lingering from the previous state. */
function toQueryParams(state: UrlState): Params {
  return {
    search: state.search || null,
    claimed: state.claimed === 'any' ? null : state.claimed,
    sort: state.sort === DEFAULT_SORT ? null : state.sort,
    order: state.order === ADMIN_VENDOR_SORT_DEFAULT_ORDER[state.sort] ? null : state.order,
  };
}
