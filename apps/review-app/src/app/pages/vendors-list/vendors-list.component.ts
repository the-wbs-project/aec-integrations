import {
  Component,
  OnInit,
  ViewChild,
  inject,
  signal,
  computed,
  DestroyRef,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import {
  GridModule,
  GridComponent,
  SortService,
  SelectionService,
  VirtualScrollService,
  PageService,
  ResizeService,
  type SelectionSettingsModel,
  type PageSettingsModel,
  type RowSelectEventArgs,
  type RowDeselectEventArgs,
} from '@syncfusion/ej2-angular-grids';
import {
  MultiSelectModule,
  CheckBoxSelectionService,
} from '@syncfusion/ej2-angular-dropdowns';
import { ApiService } from '../../services/api.service';
import { Vendor } from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { NewVendorDialogComponent } from '../../components/new-vendor-dialog/new-vendor-dialog.component';
import { TierCellComponent } from '../../components/tier-cell/tier-cell.component';
import { TierDetailDialogComponent } from '../../components/tier-detail-dialog/tier-detail-dialog.component';
import { enrichmentVariant } from '../../utils/enrichment';
import { blanksLastComparer } from '../../utils/grid-sort';

interface VendorRow extends Vendor {
  /** Pre-formatted readiness % for the column template (avoids pipe in column). */
  readinessPercent: number | null;
}

type FilterKey =
  | 'companySize'
  | 'publicPrivate'
  | 'fundingStage'
  | 'tier'
  | 'enrichment';

interface ActiveFilter {
  key: FilterKey;
  value: string;
  label: string;
}

// Hardcoded option ordering — kept stable so the dropdowns don't reorder when
// the data shifts. Values match what the API returns from Airtable.
const COMPANY_SIZE_ORDER = [
  '1-10',
  '11-50',
  '51-200',
  '201-1000',
  '1001-5000',
  '5000+',
] as const;

const FUNDING_STAGE_ORDER = [
  'Bootstrapped',
  'Pre-seed',
  'Seed',
  'Series A',
  'Series B',
  'Series C',
  'Series D+',
  'Acquired',
  'Public',
  'Unknown',
] as const;

const ENRICHMENT_ORDER = [
  'enriched',
  'partial',
  'pending',
  'error',
] as const;

// Mirrors tierForScore() in server/workflows/vendor/score.ts.
const TIER_ORDER = [
  'Tier 1',
  'Tier 2',
  'Tier 3',
  'Tier 4',
  'Tier 5',
  'Unscored',
] as const;

@Component({
  selector: 'app-vendors-list',
  imports: [
    CommonModule,
    FormsModule,
    GridModule,
    MultiSelectModule,
    RouterLink,
    EnrichSplitButtonComponent,
    NewVendorDialogComponent,
    TierCellComponent,
    TierDetailDialogComponent,
  ],
  providers: [
    SortService,
    SelectionService,
    VirtualScrollService,
    PageService,
    ResizeService,
    CheckBoxSelectionService,
  ],
  templateUrl: './vendors-list.component.html',
  styleUrl: './vendors-list.component.scss',
})
export class VendorsListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private destroy$ = new Subject<void>();
  private searchSubject = new Subject<string>();

  @ViewChild('grid') grid?: GridComponent;

  protected readonly allRows = signal<VendorRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly selectedIds = signal<string[]>([]);

  // Tier-detail modal state — null means closed.
  protected readonly tierModalVendorId = signal<string | null>(null);
  protected readonly tierModalVendorName = signal<string>('');

  // New-vendor dialog state.
  protected readonly newVendorDialogOpen = signal(false);

  // Filter state — multi-value selections
  protected readonly searchInput = signal('');
  protected readonly searchQuery = signal('');
  protected readonly filterCompanySize = signal<string[]>([]);
  protected readonly filterPublicPrivate = signal<string[]>([]);
  protected readonly filterFundingStage = signal<string[]>([]);
  protected readonly filterTier = signal<string[]>([]);
  protected readonly filterEnrichment = signal<string[]>([]);

  protected readonly checkboxMode = 'CheckBox' as const;

  private readonly gridGetter = () => this.grid;

  /**
   * Sort the Size column by the position of each range in COMPANY_SIZE_ORDER
   * instead of alphabetically (which puts "1001-5000" before "11-50"), with
   * blanks always pinned to the bottom regardless of sort direction.
   */
  protected readonly companySizeSortComparer = blanksLastComparer(
    this.gridGetter,
    'companySize',
    (a, b) => {
      const rank = (v: unknown): number =>
        COMPANY_SIZE_ORDER.indexOf(v as (typeof COMPANY_SIZE_ORDER)[number]);
      return rank(a) - rank(b);
    },
  );

  // Per-column comparers — every sortable column gets one so blanks always
  // pin to the bottom of the visible list regardless of direction.
  protected readonly companyNameSortComparer = blanksLastComparer(this.gridGetter, 'companyName');
  protected readonly headquartersSortComparer = blanksLastComparer(this.gridGetter, 'headquarters');
  protected readonly foundedYearSortComparer = blanksLastComparer(this.gridGetter, 'foundedYear');
  protected readonly vqsScoreSortComparer = blanksLastComparer(this.gridGetter, 'vqsScore');
  protected readonly readinessPercentSortComparer = blanksLastComparer(this.gridGetter, 'readinessPercent');
  protected readonly githubStarsTotalSortComparer = blanksLastComparer(this.gridGetter, 'githubStarsTotal');
  protected readonly vendorEnrichmentStatusSortComparer = blanksLastComparer(this.gridGetter, 'vendorEnrichmentStatus');
  protected readonly toolCountSortComparer = blanksLastComparer(this.gridGetter, 'toolCount');

  /**
   * Bake the count into the `text` field rather than fighting Syncfusion's
   * itemTemplate (which receives wrapped objects for primitive arrays and
   * truncates to "..."). Selection still binds on the stable `value` field.
   */
  protected readonly multiselectFields = { text: 'text', value: 'value' };

  protected readonly companySizeOptions = computed(() =>
    this.withCounts(COMPANY_SIZE_ORDER, this.companySizeCounts()),
  );
  protected readonly fundingStageOptions = computed(() =>
    this.withCounts(FUNDING_STAGE_ORDER, this.fundingStageCounts()),
  );
  protected readonly tierOptions = computed(() =>
    this.withCounts(TIER_ORDER, this.tierCounts()),
  );
  protected readonly enrichmentOptions = computed(() =>
    this.withCounts(ENRICHMENT_ORDER, this.enrichmentCounts()),
  );

  // Public/Private isn't fixed — derive values from the loaded rows.
  protected readonly publicPrivateOptions = computed(() =>
    this.withCounts(
      uniqueSorted(this.allRows().map((v) => v.publicPrivate)),
      this.publicPrivateCounts(),
    ),
  );

  private withCounts(
    values: readonly string[],
    counts: Map<string, number>,
  ): Array<{ value: string; text: string }> {
    return values.map((value) => ({
      value,
      text: `${value} (${counts.get(value) ?? 0})`,
    }));
  }

  // Per-filter counts, scoped to "rows matching every OTHER filter" so the
  // numbers reflect what selecting that option would yield.
  protected readonly companySizeCounts = computed(() =>
    this.countByValue('companySize', (v) => v.companySize),
  );
  protected readonly publicPrivateCounts = computed(() =>
    this.countByValue('publicPrivate', (v) => v.publicPrivate),
  );
  protected readonly fundingStageCounts = computed(() =>
    this.countByValue('fundingStage', (v) => v.fundingStage),
  );
  protected readonly tierCounts = computed(() =>
    this.countByValue('tier', (v) => v.vqsTier),
  );
  protected readonly enrichmentCounts = computed(() =>
    this.countByValue('enrichment', (v) => v.vendorEnrichmentStatus),
  );

  // Active filter pills (one per selected value across all dropdowns).
  protected readonly activeFilters = computed<ActiveFilter[]>(() => {
    const out: ActiveFilter[] = [];
    for (const v of this.filterCompanySize())
      out.push({ key: 'companySize', value: v, label: `Size: ${v}` });
    for (const v of this.filterPublicPrivate())
      out.push({ key: 'publicPrivate', value: v, label: v });
    for (const v of this.filterFundingStage())
      out.push({ key: 'fundingStage', value: v, label: `Stage: ${v}` });
    for (const v of this.filterTier())
      out.push({ key: 'tier', value: v, label: `Tier: ${v}` });
    for (const v of this.filterEnrichment())
      out.push({ key: 'enrichment', value: v, label: `Enrichment: ${v}` });
    return out;
  });

  // Rows after applying all filters — bound to the grid's dataSource.
  protected readonly filteredRows = computed<VendorRow[]>(() =>
    this.applyFilters({}),
  );

  protected readonly selectionSettings: SelectionSettingsModel = {
    type: 'Multiple',
    checkboxOnly: true,
    persistSelection: true,
  };

  /** Virtual-scroll chunk size — larger pages reduce row recycling thrash on long lists. */
  protected readonly pageSettings: PageSettingsModel = {
    pageSize: 100,
  };

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroy$.next();
      this.destroy$.complete();
    });
  }

  ngOnInit(): void {
    this.searchSubject
      .pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe((value) => {
        this.searchQuery.set(value);
      });

    this.fetchVendors();
  }

  fetchVendors(): void {
    this.loading.set(true);
    // limit=0 → server returns the full set; the grid virtualizes client-side.
    this.api
      .getVendors({ limit: 0 })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.allRows.set(res.data.map(toRow));
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
  }

  onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchInput.set(value);
    this.searchSubject.next(value);
  }

  setFilter(key: FilterKey, values: string[] | null | undefined): void {
    const next = Array.isArray(values) ? [...values] : [];
    this.signalFor(key).set(next);
  }

  removeFilter(key: FilterKey, value: string): void {
    const sig = this.signalFor(key);
    sig.set(sig().filter((v) => v !== value));
  }

  clearAllFilters(): void {
    this.filterCompanySize.set([]);
    this.filterPublicPrivate.set([]);
    this.filterFundingStage.set([]);
    this.filterTier.set([]);
    this.filterEnrichment.set([]);
  }

  private signalFor(key: FilterKey) {
    switch (key) {
      case 'companySize':
        return this.filterCompanySize;
      case 'publicPrivate':
        return this.filterPublicPrivate;
      case 'fundingStage':
        return this.filterFundingStage;
      case 'tier':
        return this.filterTier;
      case 'enrichment':
        return this.filterEnrichment;
    }
  }

  /**
   * Apply all filters, optionally skipping one. Used both for the visible
   * grid (`skip = none`) and for option counts (`skip = that option's key`),
   * so each dropdown shows how many rows that option would expose.
   */
  private applyFilters(opts: { skip?: FilterKey }): VendorRow[] {
    const search = this.searchQuery().trim().toLowerCase();
    const sizes = opts.skip === 'companySize' ? [] : this.filterCompanySize();
    const pps =
      opts.skip === 'publicPrivate' ? [] : this.filterPublicPrivate();
    const stages =
      opts.skip === 'fundingStage' ? [] : this.filterFundingStage();
    const tiers = opts.skip === 'tier' ? [] : this.filterTier();
    const enriches =
      opts.skip === 'enrichment' ? [] : this.filterEnrichment();

    return this.allRows().filter((v) => {
      if (search && !v.companyName.toLowerCase().includes(search)) return false;
      if (sizes.length && (!v.companySize || !sizes.includes(v.companySize)))
        return false;
      if (pps.length && (!v.publicPrivate || !pps.includes(v.publicPrivate)))
        return false;
      if (
        stages.length &&
        (!v.fundingStage || !stages.includes(v.fundingStage))
      )
        return false;
      if (tiers.length && (!v.vqsTier || !tiers.includes(v.vqsTier)))
        return false;
      if (
        enriches.length &&
        (!v.vendorEnrichmentStatus ||
          !enriches.includes(v.vendorEnrichmentStatus))
      )
        return false;
      return true;
    });
  }

  private countByValue(
    key: FilterKey,
    accessor: (v: VendorRow) => string | undefined,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const v of this.applyFilters({ skip: key })) {
      const val = accessor(v);
      if (val) counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    return counts;
  }

  onRowSelected(args: RowSelectEventArgs): void {
    this.syncSelection();
    void args;
  }

  onRowDeselected(args: RowDeselectEventArgs): void {
    this.syncSelection();
    void args;
  }

  private syncSelection(): void {
    const records = (this.grid?.getSelectedRecords() ?? []) as VendorRow[];
    this.selectedIds.set(records.map((r) => r.id));
  }

  /** Generic record click — ignore so plain-row clicks don't navigate or toggle selection. */
  onRecordClick(_args: unknown): void {
    // no-op: selection is checkbox-only; navigation is the explicit name link.
  }

  openTierModal(vendorId: string, vendorName: string): void {
    this.tierModalVendorName.set(vendorName);
    this.tierModalVendorId.set(vendorId);
  }

  closeTierModal(): void {
    this.tierModalVendorId.set(null);
    this.tierModalVendorName.set('');
  }

  openNewVendorDialog(): void {
    this.newVendorDialogOpen.set(true);
  }

  closeNewVendorDialog(): void {
    this.newVendorDialogOpen.set(false);
  }

  onVendorCreated(event: { recordId: string }): void {
    // Backend kicks off the orchestrator; navigate to the detail page so the
    // user can watch enrichment populate.
    this.newVendorDialogOpen.set(false);
    this.router.navigate(['/vendors', event.recordId]);
  }

  /** Map an enrichment status string to a badge variant token. */
  enrichmentVariant = enrichmentVariant;
}

function toRow(v: Vendor): VendorRow {
  const pct =
    typeof v.vendorDataCompleteness === 'number'
      ? Math.round(v.vendorDataCompleteness * 100)
      : null;
  return { ...v, readinessPercent: pct };
}

function uniqueSorted(values: Array<string | undefined | null>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
