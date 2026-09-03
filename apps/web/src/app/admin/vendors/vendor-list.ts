import { DatePipe } from '@angular/common';
import { Component, LOCALE_ID, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminVendorRow, VendorSort } from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { formatTermDate } from '../entitlement/entitlement-term';
import { AdminVendorsApi } from './admin-vendors-api';

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
 * Unlike the claim queue this one PAGES for real (`AdminPaginator`) rather than
 * loading `perPage=100` once with a truncation note: a moderation backlog is
 * bounded by how fast humans file, the vendor catalog is not.
 *
 * Every filter change resets to page 1 — the same rule the Activity feed
 * documents. Without it, narrowing a filter while on page 6 lands the operator on
 * an empty page that looks like "no results".
 *
 * ── A TABLE, AND ONLY TWO SORTABLE COLUMNS (AECI-694) ───────────────────────
 * The rows were cards. Every field here is short and every row has the same
 * fields, which is the case a table is for: an operator comparing entitlement
 * state across a page of vendors is scanning a column, and cards made them read
 * a paragraph per row.
 *
 * Sorting is server-side or not offered at all. `AdminVendorsListQuerySchema`
 * takes `VendorSortSchema` (`created | name | updated`), there is no `order`
 * parameter, and `created_at` is not on `AdminVendorRowSchema` so it has no
 * column to hang off. That leaves exactly two sortable headers, Vendor and
 * Updated, and the other five stay plain `<th>` text with no hover state. A
 * header that looked clickable and reordered the 25 rows on this page while
 * leaving the other four thousand alone would be worse than no control: the
 * operator would read "sorted by products" and get a ranking of one page. If
 * more columns should sort, the fix is on the API (`resolveVendorOrderBy` plus
 * the query schema), not here.
 */
@Component({
  selector: 'aec-vendor-list',
  imports: [RouterLink, AdminPaginator, AecSelect, SortHeader, DatePipe],
  templateUrl: './vendor-list.html',
})
export class VendorList {
  private readonly api = inject(AdminVendorsApi);
  private readonly locale = inject(LOCALE_ID);

  protected readonly vendors = signal<readonly AdminVendorRow[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly perPage = PAGE_SIZE;

  protected readonly loading = signal(true);
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
   * Alphabetical rather than the API's `created` default: this is a lookup
   * surface, and an operator arriving to find one vendor starts by scanning
   * names.
   */
  protected readonly sort = signal<VendorSort>('name');

  protected readonly verifiedOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.vendors.filter.verified.any:Any status` },
    { value: 'true', label: $localize`:@@admin.vendors.filter.verified.yes:Verified` },
    { value: 'false', label: $localize`:@@admin.vendors.filter.verified.no:Not verified` },
  ];

  protected readonly isEmpty = computed(() => !this.loading() && this.vendors().length === 0);

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

  /** Direction is fixed per key on the server, so this selects a sort rather
   *  than toggling one. See `shared/sort-header/sort-header.ts`. */
  protected onSortChange(key: string): void {
    this.sort.set(key as VendorSort);
    this.refilter();
  }

  protected onVerifiedChange(value: string | null): void {
    this.verified.set((value as VerifiedFilter | null) ?? 'any');
    this.refilter();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  /** Any filter change: back to page 1, then refetch. */
  private refilter(): void {
    this.page.set(1);
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const search = this.search();
      const verified = this.verified();
      const response = await this.api.listVendors({
        page: this.page(),
        perPage: this.perPage,
        sort: this.sort(),
        ...(search ? { search } : {}),
        ...(verified === 'any' ? {} : { verified }),
      });
      this.vendors.set(response.data);
      this.total.set(response.total);
      this.liveMessage.set(
        $localize`:@@admin.vendors.announce.loaded:${response.total}:COUNT: vendors match.`,
      );
    } catch {
      this.loadFailed.set(true);
      this.vendors.set([]);
      this.total.set(0);
    } finally {
      this.loading.set(false);
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
