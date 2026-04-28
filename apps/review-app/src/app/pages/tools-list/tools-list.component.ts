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
import { Tool, MetaResponse, LinkRef } from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { enrichmentVariant } from '../../utils/enrichment';
import { blanksLastComparer } from '../../utils/grid-sort';

interface ToolRow extends Tool {
  /** Lower-cased haystack of vendor names — used by the freeform search. */
  vendorSearch: string;
  /** Lower-cased name for fast case-insensitive search. */
  nameSearch: string;
}

type FilterKey =
  | 'category'
  | 'discipline'
  | 'phase'
  | 'researchStatus'
  | 'priorityTier'
  | 'enrichment';

interface ActiveFilter {
  key: FilterKey;
  value: string;
  label: string;
}

@Component({
  selector: 'app-tools-list',
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    GridModule,
    MultiSelectModule,
    EnrichSplitButtonComponent,
  ],
  providers: [
    SortService,
    SelectionService,
    VirtualScrollService,
    PageService,
    CheckBoxSelectionService,
  ],
  templateUrl: './tools-list.component.html',
  styleUrl: './tools-list.component.scss',
})
export class ToolsListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private destroy$ = new Subject<void>();
  private searchSubject = new Subject<string>();

  @ViewChild('grid') grid?: GridComponent;

  protected readonly allRows = signal<ToolRow[]>([]);
  protected readonly meta = signal<MetaResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly selectedIds = signal<string[]>([]);

  // Filter state — multi-value selections
  protected readonly searchInput = signal('');
  protected readonly searchQuery = signal('');
  protected readonly filterCategory = signal<string[]>([]);
  protected readonly filterDiscipline = signal<string[]>([]);
  protected readonly filterPhase = signal<string[]>([]);
  protected readonly filterResearchStatus = signal<string[]>([]);
  protected readonly filterPriorityTier = signal<string[]>([]);
  protected readonly filterEnrichment = signal<string[]>([]);

  protected readonly checkboxMode = 'CheckBox' as const;

  /**
   * Bake the count into the `text` field rather than fighting Syncfusion's
   * itemTemplate (which receives wrapped objects for primitive arrays and
   * truncates to "..."). Selection still binds on the stable `value` field.
   */
  protected readonly multiselectFields = { text: 'text', value: 'value' };

  // Per-column comparers — every sortable column gets one so blanks always
  // pin to the bottom of the visible list regardless of direction.
  private readonly gridGetter = () => this.grid;
  protected readonly nameSortComparer = blanksLastComparer(this.gridGetter, 'name');
  protected readonly vendorSearchSortComparer = blanksLastComparer(this.gridGetter, 'vendorSearch');
  protected readonly integrationCountSortComparer = blanksLastComparer(this.gridGetter, 'integrationCount');
  protected readonly priorityTierSortComparer = blanksLastComparer(this.gridGetter, 'priorityTier');
  protected readonly researchStatusSortComparer = blanksLastComparer(this.gridGetter, 'researchStatus');
  protected readonly toolEnrichmentStatusSortComparer = blanksLastComparer(this.gridGetter, 'toolEnrichmentStatus');

  // ---- Filter option lists (canonical source = /meta) -------------------
  // Lookups — id → name — for translating active-filter pills back to labels.
  private readonly categoryNameById = computed(
    () => mapBy(this.meta()?.categories ?? []),
  );
  private readonly disciplineNameById = computed(
    () => mapBy(this.meta()?.disciplines ?? []),
  );
  private readonly phaseNameById = computed(
    () => mapBy(this.meta()?.phases ?? []),
  );

  protected readonly categoryOptions = computed(() =>
    this.refsWithCounts(
      this.meta()?.categories ?? [],
      this.categoryCounts(),
    ),
  );
  protected readonly disciplineOptions = computed(() =>
    this.refsWithCounts(
      this.meta()?.disciplines ?? [],
      this.disciplineCounts(),
    ),
  );
  protected readonly phaseOptions = computed(() =>
    this.refsWithCounts(this.meta()?.phases ?? [], this.phaseCounts()),
  );
  protected readonly researchStatusOptions = computed(() =>
    this.stringsWithCounts(
      this.meta()?.researchStatuses ?? [],
      this.researchStatusCounts(),
    ),
  );
  protected readonly priorityTierOptions = computed(() =>
    this.stringsWithCounts(
      this.meta()?.priorityTiers ?? [],
      this.priorityTierCounts(),
      (t) => `Tier ${t}`,
    ),
  );
  protected readonly enrichmentOptions = computed(() =>
    this.stringsWithCounts(
      this.meta()?.toolEnrichmentStatuses ?? [],
      this.enrichmentCounts(),
    ),
  );

  private refsWithCounts(
    refs: LinkRef[],
    counts: Map<string, number>,
  ): Array<{ value: string; text: string }> {
    return refs.map((r) => ({
      value: r.id,
      text: `${r.name} (${counts.get(r.id) ?? 0})`,
    }));
  }

  private stringsWithCounts(
    values: readonly string[],
    counts: Map<string, number>,
    label: (v: string) => string = (v) => v,
  ): Array<{ value: string; text: string }> {
    return values.map((v) => ({
      value: v,
      text: `${label(v)} (${counts.get(v) ?? 0})`,
    }));
  }

  // Per-filter counts, scoped to "rows matching every OTHER filter" so the
  // numbers reflect what selecting that option would yield.
  protected readonly categoryCounts = computed(() =>
    this.countByValues('category', (t) => t.categories.map((c) => c.id)),
  );
  protected readonly disciplineCounts = computed(() =>
    this.countByValues('discipline', (t) => t.disciplines.map((d) => d.id)),
  );
  protected readonly phaseCounts = computed(() =>
    this.countByValues('phase', (t) => t.phases.map((p) => p.id)),
  );
  protected readonly researchStatusCounts = computed(() =>
    this.countByValue('researchStatus', (t) => t.researchStatus),
  );
  protected readonly priorityTierCounts = computed(() =>
    this.countByValue('priorityTier', (t) => t.priorityTier),
  );
  protected readonly enrichmentCounts = computed(() =>
    this.countByValue('enrichment', (t) => t.toolEnrichmentStatus),
  );

  // Active filter pills (one per selected value across all dropdowns).
  protected readonly activeFilters = computed<ActiveFilter[]>(() => {
    const out: ActiveFilter[] = [];
    const cats = this.categoryNameById();
    const disc = this.disciplineNameById();
    const ph = this.phaseNameById();
    for (const v of this.filterCategory())
      out.push({
        key: 'category',
        value: v,
        label: `Category: ${cats.get(v) ?? v}`,
      });
    for (const v of this.filterDiscipline())
      out.push({
        key: 'discipline',
        value: v,
        label: `Discipline: ${disc.get(v) ?? v}`,
      });
    for (const v of this.filterPhase())
      out.push({
        key: 'phase',
        value: v,
        label: `Phase: ${ph.get(v) ?? v}`,
      });
    for (const v of this.filterResearchStatus())
      out.push({ key: 'researchStatus', value: v, label: `Research: ${v}` });
    for (const v of this.filterPriorityTier())
      out.push({ key: 'priorityTier', value: v, label: `Tier ${v}` });
    for (const v of this.filterEnrichment())
      out.push({ key: 'enrichment', value: v, label: `Enrichment: ${v}` });
    return out;
  });

  // Rows after applying all filters — bound to the grid's dataSource.
  protected readonly filteredRows = computed<ToolRow[]>(() =>
    this.applyFilters({}),
  );

  /** IDs feeding the bulk-enrich split-button when no rows are selected. */
  protected readonly filteredIds = computed(() =>
    this.filteredRows().map((t) => t.id),
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

    this.api
      .getMeta()
      .pipe(takeUntil(this.destroy$))
      .subscribe((meta) => this.meta.set(meta));

    this.fetchTools();
  }

  fetchTools(): void {
    this.loading.set(true);
    // limit=0 → server returns the full set; the grid virtualizes client-side.
    this.api
      .getTools({ limit: 0 })
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
    this.filterCategory.set([]);
    this.filterDiscipline.set([]);
    this.filterPhase.set([]);
    this.filterResearchStatus.set([]);
    this.filterPriorityTier.set([]);
    this.filterEnrichment.set([]);
  }

  private signalFor(key: FilterKey) {
    switch (key) {
      case 'category':
        return this.filterCategory;
      case 'discipline':
        return this.filterDiscipline;
      case 'phase':
        return this.filterPhase;
      case 'researchStatus':
        return this.filterResearchStatus;
      case 'priorityTier':
        return this.filterPriorityTier;
      case 'enrichment':
        return this.filterEnrichment;
    }
  }

  /**
   * Apply all filters, optionally skipping one. Used both for the visible
   * grid (`skip = none`) and for option counts (`skip = that option's key`),
   * so each dropdown shows how many rows that option would expose.
   */
  private applyFilters(opts: { skip?: FilterKey }): ToolRow[] {
    const search = this.searchQuery().trim().toLowerCase();
    const cats = opts.skip === 'category' ? [] : this.filterCategory();
    const disc = opts.skip === 'discipline' ? [] : this.filterDiscipline();
    const phs = opts.skip === 'phase' ? [] : this.filterPhase();
    const stats =
      opts.skip === 'researchStatus' ? [] : this.filterResearchStatus();
    const tiers =
      opts.skip === 'priorityTier' ? [] : this.filterPriorityTier();
    const enriches =
      opts.skip === 'enrichment' ? [] : this.filterEnrichment();

    return this.allRows().filter((t) => {
      if (
        search &&
        !t.nameSearch.includes(search) &&
        !t.vendorSearch.includes(search)
      )
        return false;
      if (cats.length && !t.categories.some((c) => cats.includes(c.id)))
        return false;
      if (disc.length && !t.disciplines.some((d) => disc.includes(d.id)))
        return false;
      if (phs.length && !t.phases.some((p) => phs.includes(p.id)))
        return false;
      if (
        stats.length &&
        (!t.researchStatus || !stats.includes(t.researchStatus))
      )
        return false;
      if (
        tiers.length &&
        (!t.priorityTier || !tiers.includes(t.priorityTier))
      )
        return false;
      if (
        enriches.length &&
        (!t.toolEnrichmentStatus ||
          !enriches.includes(t.toolEnrichmentStatus))
      )
        return false;
      return true;
    });
  }

  /** Count by a single string value (researchStatus, tier, enrichment). */
  private countByValue(
    key: FilterKey,
    accessor: (t: ToolRow) => string | undefined,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const t of this.applyFilters({ skip: key })) {
      const val = accessor(t);
      if (val) counts.set(val, (counts.get(val) ?? 0) + 1);
    }
    return counts;
  }

  /** Count by multiple values per row (categories, disciplines, phases). */
  private countByValues(
    key: FilterKey,
    accessor: (t: ToolRow) => string[],
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const t of this.applyFilters({ skip: key })) {
      for (const val of accessor(t)) {
        if (val) counts.set(val, (counts.get(val) ?? 0) + 1);
      }
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
    const records = (this.grid?.getSelectedRecords() ?? []) as ToolRow[];
    this.selectedIds.set(records.map((r) => r.id));
  }

  /** Native click on the tool name cell — route without disturbing checkbox selection. */
  goToTool(id: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.router.navigate(['/tools', id]);
  }

  /** Native click on a vendor link inside a row — route without toggling selection. */
  goToVendor(id: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.router.navigate(['/vendors', id]);
  }

  /** Generic record click — ignore so plain-row clicks don't navigate or toggle selection. */
  onRecordClick(_args: unknown): void {
    // no-op: selection is checkbox-only; navigation is the explicit name link.
  }

  // ---- Badge helpers ----------------------------------------------------
  enrichmentVariant = enrichmentVariant;

  tierBadgeClass(tier: string | undefined | null): string {
    switch (tier) {
      case '1':
        return 'badge--success';
      case '2':
        return 'badge--info';
      case '3':
        return 'badge--warning';
      default:
        return 'badge--neutral';
    }
  }

  statusBadgeClass(status: string | undefined | null): string {
    if (!status) return 'badge--neutral';
    const lower = status.toLowerCase();
    if (lower.includes('complete') || lower.includes('done'))
      return 'badge--success';
    if (lower.includes('progress') || lower.includes('review'))
      return 'badge--warning';
    if (lower.includes('not started') || lower.includes('todo'))
      return 'badge--neutral';
    return 'badge--info';
  }
}

function toRow(t: Tool): ToolRow {
  return {
    ...t,
    nameSearch: (t.name ?? '').toLowerCase(),
    vendorSearch: t.vendors.map((v) => v.name).join(' ').toLowerCase(),
  };
}

function mapBy(refs: LinkRef[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of refs) m.set(r.id, r.name);
  return m;
}
