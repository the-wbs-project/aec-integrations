import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminVendorRow } from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
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
 */
@Component({
  selector: 'aec-vendor-list',
  imports: [RouterLink, AdminPaginator, AecSelect],
  templateUrl: './vendor-list.html',
})
export class VendorList {
  private readonly api = inject(AdminVendorsApi);

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
        sort: 'name',
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
