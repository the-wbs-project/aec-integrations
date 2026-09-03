import { DatePipe } from '@angular/common';
import { Component, LOCALE_ID, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ADMIN_VENDOR_SORT_DEFAULT_ORDER } from '@aeci/shared';
import type { AdminVendorRow, AdminVendorSort, SortOrder } from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { PaginationFooter } from '../../shared/pagination/pagination-footer';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { formatTermDate } from '../entitlement/entitlement-term';
import { AdminVendorsApi } from './admin-vendors-api';

/** Rows per fetch. Scroll appends a page at a time, so this is a chunk size
 *  rather than a "page" the operator ever names. */
const PAGE_SIZE = 25;

/** The verified filter's three states. A tri-state, not a toggle: an operator
 *  auditing entitlements needs "show me the unverified ones" as often as the
 *  inverse, and the API's `verified` param is an explicit `'true'|'false'` enum
 *  precisely so `false` cannot be coerced back into `true` (AECI-691). */
type VerifiedFilter = 'any' | 'true' | 'false';

/**
 * `/admin/vendors` — the operator's vendor list (AECI-652 /
 * `STAGE_2_PAID_TIERS_SPEC.md` §5.6), rendered in the `AdminShell` layout outlet.
 *
 * This is the screen whose absence was the whole problem. Until it existed the
 * only path to a vendor's entitlement ran through a `/admin/claims` card, so a
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
 * fields, which is the case a table is for: an operator comparing entitlement
 * state across a page of vendors is scanning a column, and cards made them read
 * a paragraph per row.
 *
 * Sorting is server-side or not offered at all — that rule has not changed, and a
 * header that reordered the rows already loaded while leaving the rest of the
 * catalog alone would be worse than no control, because under scroll paging the
 * operator cannot even see where the reordered set ends. What changed is the API:
 * `AdminVendorSortSchema` + `resolveAdminVendorOrderBy` now order by all seven of
 * this table's columns, including the two that live on the joined
 * `vendor_entitlements` row (`entitlement`, `term`) and the one that is a SELECT
 * alias rather than a column (`products`). Add a column here and it gets a case
 * there, or it gets no header control.
 *
 * Each key still has a NATURAL direction, which is what an inactive header states
 * and what its first click produces; clicking the ACTIVE header reverses it and
 * sends `order` alongside `sort`. See `shared/sort-header/sort-header.ts` and
 * {@link order}.
 *
 * The Integrations column is gone. An operator on this screen is triaging
 * entitlements and seats; the integration count is a catalog fact they act on at
 * `/admin/vendors/:id`, and dropping it also dropped a correlated subquery per
 * row from the query.
 */
@Component({
  selector: 'aec-vendor-list',
  imports: [RouterLink, PaginationFooter, AecSelect, SortHeader, DatePipe],
  templateUrl: './vendor-list.html',
})
export class VendorList {
  private readonly api = inject(AdminVendorsApi);
  private readonly locale = inject(LOCALE_ID);

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

  /** The committed search term — what was last SENT, not what is being typed.
   *  Typing does not refetch; the form's submit does. A keystroke-per-request
   *  search over a `LIKE '%…%'` full scan would be a lot of scans to answer a
   *  question the operator has not finished asking. */
  protected readonly search = signal('');
  protected readonly searchDraft = signal('');
  protected readonly verified = signal<VerifiedFilter>('any');

  /**
   * The active sort key. Component state, not a URL parameter, matching the
   * console's existing convention (`user-list.ts` documents why its filters do
   * not write back to the URL: a `Router.navigate` per control turns the back
   * button into a walk through the operator's own filter history). `/admin` is
   * never edge-cached, so nothing about the sort forks a cache key either.
   *
   * Alphabetical, which is also the admin schema's default (`AdminVendorSortSchema`):
   * this is a lookup surface, and an operator arriving to find one vendor starts
   * by scanning names.
   */
  protected readonly sort = signal<AdminVendorSort>('name');

  /**
   * The direction in effect for {@link sort}. Starts at the active key's NATURAL
   * direction, so a first render and a bare `?sort=` request agree; a second
   * click on the active header flips it and the request carries `order`.
   *
   * Held beside the key rather than folded into it because the API takes them as
   * two parameters, and because switching columns must RESET to the new column's
   * natural direction — moving from "Updated ↓" to "Vendor" gives A–Z, not Z–A.
   */
  protected readonly order = signal<SortOrder>(ADMIN_VENDOR_SORT_DEFAULT_ORDER['name']);

  protected readonly verifiedOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.vendors.filter.verified.any:Any status` },
    { value: 'true', label: $localize`:@@admin.vendors.filter.verified.yes:Verified` },
    { value: 'false', label: $localize`:@@admin.vendors.filter.verified.no:Not verified` },
  ];

  protected readonly isEmpty = computed(() => !this.loading() && this.vendors().length === 0);

  /** More rows exist behind what is on screen. Drives the sentinel + the button. */
  protected readonly hasMore = computed(() => this.vendors().length < this.total());

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  protected onSearchInput(event: Event): void {
    this.searchDraft.set((event.target as HTMLInputElement).value);
  }

  protected submitSearch(): void {
    this.search.set(this.searchDraft().trim());
    this.refilter();
  }

  protected clearSearch(): void {
    this.searchDraft.set('');
    this.search.set('');
    this.refilter();
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
    this.sort.set(change.key as AdminVendorSort);
    this.order.set(change.order);
    this.refilter();
  }

  protected onVerifiedChange(value: string | null): void {
    this.verified.set((value as VerifiedFilter | null) ?? 'any');
    this.refilter();
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

  /** Any filter, search or sort change: discard the accumulation and refetch
   *  from chunk 1. Appending across a reordered set would duplicate rows. */
  private refilter(): void {
    this.page.set(1);
    this.vendors.set([]);
    void this.load();
  }

  private async load({ append = false }: { append?: boolean } = {}): Promise<void> {
    if (append) this.loadingMore.set(true);
    else this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const search = this.search();
      const verified = this.verified();
      const response = await this.api.listVendors({
        page: this.page(),
        perPage: PAGE_SIZE,
        sort: this.sort(),
        order: this.order(),
        ...(search ? { search } : {}),
        ...(verified === 'any' ? {} : { verified }),
      });
      this.vendors.update((rows) => (append ? [...rows, ...response.data] : response.data));
      this.total.set(response.total);
      this.liveMessage.set(
        $localize`:@@admin.vendors.announce.loaded:${response.total}:COUNT: vendors match.`,
      );
    } catch {
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
      this.loading.set(false);
      this.loadingMore.set(false);
    }
  }

  /**
   * The entitlement readout for a row.
   *
   * `tier`/`status` are `null` together when the vendor has no
   * `vendor_entitlements` row at all — which is the majority, and which is NOT the
   * same as a cleared one. Rendered alongside `verified` rather than instead of
   * it: `verified` is the denormalized mirror, and showing both is how an operator
   * spots drift between them.
   */
  /**
   * The term end, formatted.
   *
   * NOT the `date` pipe: `period_end` is legally a bare `YYYY-MM-DD` (the admin
   * form is an `<input type="date">`), and a date-only string handed to the pipe
   * with `'UTC'` is parsed as LOCAL midnight and then shifted, so west of UTC a
   * term ending on the 1st renders as the 31st. `formatTermDate` pins the
   * calendar case to UTC midnight first. Shared with the two entitlement
   * readouts so all three agree.
   */
  protected termEnds(row: AdminVendorRow): string {
    return row.period_end ? formatTermDate(row.period_end, this.locale) : '';
  }

  protected entitlementLabel(row: AdminVendorRow): string {
    switch (row.status) {
      case 'active':
        return $localize`:@@admin.vendors.ent.active:Entitlement active`;
      case 'pending':
        return $localize`:@@admin.vendors.ent.pending:Arrangement pending`;
      case 'expired':
        return $localize`:@@admin.vendors.ent.expired:Term expired`;
      case 'revoked':
        return $localize`:@@admin.vendors.ent.revoked:Entitlement cleared`;
      default:
        return $localize`:@@admin.vendors.ent.none:No entitlement`;
    }
  }
}
