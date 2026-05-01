import {
  Component,
  OnInit,
  ViewChild,
  inject,
  signal,
  computed,
  DestroyRef,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import {
  GridModule,
  GridComponent,
  SortService,
  VirtualScrollService,
  PageService,
  type PageSettingsModel,
} from '@syncfusion/ej2-angular-grids';
import {
  MultiSelectModule,
  CheckBoxSelectionService,
} from '@syncfusion/ej2-angular-dropdowns';
import { ApiService } from '../../services/api.service';
import { IntegrationSummary } from '../../types';
import { blanksLastComparer } from '../../utils/grid-sort';

/**
 * Grid row that adds flat string fields for the linked-record columns so
 * Syncfusion's sort comparer can apply the blanks-last rule directly on them.
 */
interface IntegrationRow extends IntegrationSummary {
  sourceProductName: string | undefined;
  targetProductName: string | undefined;
  poweredByProductName: string | undefined;
  builtByName: string | undefined;
}

type FilterKey =
  | 'mechanismKind'
  | 'maturity'
  | 'pricingModel'
  | 'direction';

interface ActiveFilter {
  key: FilterKey;
  value: string;
  label: string;
}

const MECHANISM_KIND_ORDER = [
  'native',
  'iPaaS',
  'api',
  'plugin',
  'file-based',
  'webhook',
  'custom',
  'other',
] as const;

const MATURITY_ORDER = ['ga', 'beta', 'deprecated', 'unknown'] as const;
const PRICING_ORDER = ['free', 'paid', 'included', 'unknown'] as const;
const DIRECTION_ORDER = ['one-way', 'two-way', 'unknown'] as const;

@Component({
  selector: 'app-integrations-list',
  imports: [
    CommonModule,
    FormsModule,
    GridModule,
    MultiSelectModule,
    RouterLink,
  ],
  providers: [
    SortService,
    VirtualScrollService,
    PageService,
    CheckBoxSelectionService,
  ],
  templateUrl: './integrations-list.component.html',
  styleUrl: './integrations-list.component.scss',
})
export class IntegrationsListComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private destroy$ = new Subject<void>();
  private searchSubject = new Subject<string>();

  @ViewChild('grid') grid?: GridComponent;

  protected readonly allRows = signal<IntegrationRow[]>([]);
  protected readonly loading = signal(false);

  protected readonly searchInput = signal('');
  protected readonly searchQuery = signal('');
  protected readonly filterMechanismKind = signal<string[]>([]);
  protected readonly filterMaturity = signal<string[]>([]);
  protected readonly filterPricingModel = signal<string[]>([]);
  protected readonly filterDirection = signal<string[]>([]);

  protected readonly checkboxMode = 'CheckBox' as const;

  private readonly gridGetter = () => this.grid;

  protected readonly nameSortComparer = blanksLastComparer(this.gridGetter, 'name');
  protected readonly sourceSortComparer = blanksLastComparer(this.gridGetter, 'sourceProductName');
  protected readonly targetSortComparer = blanksLastComparer(this.gridGetter, 'targetProductName');
  protected readonly mechanismKindSortComparer = blanksLastComparer(this.gridGetter, 'mechanismKind');
  protected readonly poweredBySortComparer = blanksLastComparer(this.gridGetter, 'poweredByProductName');
  protected readonly maturitySortComparer = blanksLastComparer(this.gridGetter, 'maturity');
  protected readonly directionSortComparer = blanksLastComparer(this.gridGetter, 'direction');
  protected readonly builtBySortComparer = blanksLastComparer(this.gridGetter, 'builtByName');

  protected readonly multiselectFields = { text: 'text', value: 'value' };

  protected readonly mechanismKindOptions = computed(() =>
    this.withCounts(MECHANISM_KIND_ORDER, this.mechanismKindCounts()),
  );
  protected readonly maturityOptions = computed(() =>
    this.withCounts(MATURITY_ORDER, this.maturityCounts()),
  );
  protected readonly pricingModelOptions = computed(() =>
    this.withCounts(PRICING_ORDER, this.pricingModelCounts()),
  );
  protected readonly directionOptions = computed(() =>
    this.withCounts(DIRECTION_ORDER, this.directionCounts()),
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

  protected readonly mechanismKindCounts = computed(() =>
    this.countByValue('mechanismKind', (i) => i.mechanismKind),
  );
  protected readonly maturityCounts = computed(() =>
    this.countByValue('maturity', (i) => i.maturity),
  );
  protected readonly pricingModelCounts = computed(() =>
    this.countByValue('pricingModel', (i) => i.pricingModel),
  );
  protected readonly directionCounts = computed(() =>
    this.countByValue('direction', (i) => i.direction),
  );

  protected readonly activeFilters = computed<ActiveFilter[]>(() => {
    const out: ActiveFilter[] = [];
    for (const v of this.filterMechanismKind())
      out.push({ key: 'mechanismKind', value: v, label: `Mechanism: ${v}` });
    for (const v of this.filterMaturity())
      out.push({ key: 'maturity', value: v, label: `Maturity: ${v}` });
    for (const v of this.filterPricingModel())
      out.push({ key: 'pricingModel', value: v, label: `Pricing: ${v}` });
    for (const v of this.filterDirection())
      out.push({ key: 'direction', value: v, label: `Direction: ${v}` });
    return out;
  });

  protected readonly filteredRows = computed<IntegrationRow[]>(() =>
    this.applyFilters({}),
  );

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

    this.fetchIntegrations();
  }

  fetchIntegrations(): void {
    this.loading.set(true);
    this.api
      .getIntegrations({ limit: 0 })
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
    this.filterMechanismKind.set([]);
    this.filterMaturity.set([]);
    this.filterPricingModel.set([]);
    this.filterDirection.set([]);
  }

  private signalFor(key: FilterKey) {
    switch (key) {
      case 'mechanismKind':
        return this.filterMechanismKind;
      case 'maturity':
        return this.filterMaturity;
      case 'pricingModel':
        return this.filterPricingModel;
      case 'direction':
        return this.filterDirection;
    }
  }

  private applyFilters(opts: { skip?: FilterKey }): IntegrationRow[] {
    const search = this.searchQuery().trim().toLowerCase();
    const mechanisms =
      opts.skip === 'mechanismKind' ? [] : this.filterMechanismKind();
    const maturities = opts.skip === 'maturity' ? [] : this.filterMaturity();
    const pricings = opts.skip === 'pricingModel' ? [] : this.filterPricingModel();
    const directions = opts.skip === 'direction' ? [] : this.filterDirection();

    return this.allRows().filter((i) => {
      if (search) {
        const haystack = [
          i.name,
          i.description ?? '',
          i.mechanismName ?? '',
          i.sourceProduct?.name ?? '',
          i.targetProduct?.name ?? '',
          i.poweredByProduct?.name ?? '',
          i.builtBy?.name ?? '',
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      if (
        mechanisms.length &&
        (!i.mechanismKind || !mechanisms.includes(i.mechanismKind))
      )
        return false;
      if (
        maturities.length &&
        (!i.maturity || !maturities.includes(i.maturity))
      )
        return false;
      if (
        pricings.length &&
        (!i.pricingModel || !pricings.includes(i.pricingModel))
      )
        return false;
      if (
        directions.length &&
        (!i.direction || !directions.includes(i.direction))
      )
        return false;
      return true;
    });
  }

  private countByValue(
    key: FilterKey,
    accessor: (i: IntegrationRow) => string | undefined,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const i of this.applyFilters({ skip: key })) {
      const val = accessor(i);
      if (val) counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    return counts;
  }
}

function toRow(i: IntegrationSummary): IntegrationRow {
  return {
    ...i,
    sourceProductName: i.sourceProduct?.name,
    targetProductName: i.targetProduct?.name,
    poweredByProductName: i.poweredByProduct?.name,
    builtByName: i.builtBy?.name,
  };
}
