import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  effect,
  DestroyRef,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import {
  Tool,
  MetaResponse,
  LinkRef,
  PaginatedResponse,
} from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';

@Component({
  selector: 'app-tools-list',
  imports: [RouterLink, FormsModule, DecimalPipe, EnrichSplitButtonComponent],
  templateUrl: './tools-list.component.html',
  styleUrl: './tools-list.component.scss',
})
export class ToolsListComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private destroy$ = new Subject<void>();
  private searchSubject = new Subject<string>();

  // State signals
  tools = signal<Tool[]>([]);
  total = signal(0);
  offset = signal(0);
  limit = signal(50);
  loading = signal(false);
  meta = signal<MetaResponse | null>(null);

  sortColumn = signal<string | undefined>(undefined);
  sortDirection = signal<'asc' | 'desc'>('asc');
  searchInput = signal('');
  searchQuery = signal('');
  filterCategory = signal('');
  filterDiscipline = signal('');
  filterPhase = signal('');
  filterStatus = signal('');
  filterTier = signal('');
  filterEnrichment = signal('');

  rangeStart = computed(() => (this.total() === 0 ? 0 : this.offset() + 1));
  rangeEnd = computed(() =>
    Math.min(this.offset() + this.limit(), this.total())
  );

  // IDs of the tools currently in view — feeds the bulk-enrich split-button
  // when the user hasn't selected specific rows.
  filteredIds = computed(() => this.tools().map((t) => t.id));

  columns: Array<{
    key: string;
    label: string;
    sortable: boolean;
    sortKey?: string;
    align?: 'left' | 'center' | 'right';
  }> = [
    { key: 'name', label: 'Name', sortable: true, sortKey: 'name' },
    { key: 'vendors', label: 'Vendor', sortable: true, sortKey: 'vendor' },
    { key: 'categories', label: 'Categories', sortable: false },
    { key: 'phases', label: 'Phases', sortable: false },
    {
      key: 'integrationCount',
      label: 'Integrations',
      sortable: true,
      sortKey: 'integrationCount',
      align: 'right',
    },
    {
      key: 'priority',
      label: 'Priority',
      sortable: true,
      sortKey: 'priorityScore',
      align: 'center',
    },
    {
      key: 'researchStatus',
      label: 'Research',
      sortable: true,
      sortKey: 'researchStatus',
    },
    { key: 'links', label: 'Links', sortable: false, align: 'right' },
  ];

  readonly skeletonRows = Array(8).fill(0);

  // ---- Pill overflow helpers ---------------------------------------------
  static readonly PILL_LIMIT = 3;
  visibleRefs(refs: LinkRef[] | undefined): LinkRef[] {
    if (!refs) return [];
    return refs.slice(0, ToolsListComponent.PILL_LIMIT);
  }
  /** Returns the overflow list, or null when there is no overflow (so @if hides the pill). */
  overflowRefs(refs: LinkRef[] | undefined): LinkRef[] | null {
    if (!refs || refs.length <= ToolsListComponent.PILL_LIMIT) return null;
    return refs.slice(ToolsListComponent.PILL_LIMIT);
  }

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroy$.next();
      this.destroy$.complete();
    });
  }

  ngOnInit(): void {
    // Set up debounced search
    this.searchSubject
      .pipe(debounceTime(300), takeUntil(this.destroy$))
      .subscribe((value) => {
        this.searchQuery.set(value);
        this.offset.set(0);
        this.fetchTools();
      });

    // Load meta options then tools
    this.api.getMeta().subscribe((meta) => {
      this.meta.set(meta);
    });

    this.fetchTools();
  }

  fetchTools(): void {
    this.loading.set(true);
    this.api
      .getTools({
        offset: this.offset(),
        limit: this.limit(),
        search: this.searchQuery() || undefined,
        category: this.filterCategory() || undefined,
        discipline: this.filterDiscipline() || undefined,
        phase: this.filterPhase() || undefined,
        status: this.filterStatus() || undefined,
        tier: this.filterTier() || undefined,
        enrichmentStatus: this.filterEnrichment() || undefined,
        sort: this.sortColumn() || undefined,
        direction: this.sortColumn() ? this.sortDirection() : undefined,
      })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.tools.set(res.data);
          this.total.set(res.total);
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

  onFilterChange(
    filter:
      | 'category'
      | 'discipline'
      | 'phase'
      | 'status'
      | 'tier'
      | 'enrichmentStatus',
    event: Event
  ): void {
    const value = (event.target as HTMLSelectElement).value;
    switch (filter) {
      case 'category':
        this.filterCategory.set(value);
        break;
      case 'discipline':
        this.filterDiscipline.set(value);
        break;
      case 'phase':
        this.filterPhase.set(value);
        break;
      case 'status':
        this.filterStatus.set(value);
        break;
      case 'tier':
        this.filterTier.set(value);
        break;
      case 'enrichmentStatus':
        this.filterEnrichment.set(value);
        break;
    }
    this.offset.set(0);
    this.fetchTools();
  }

  toggleSort(sortKey: string): void {
    if (this.sortColumn() === sortKey) {
      if (this.sortDirection() === 'asc') {
        this.sortDirection.set('desc');
      } else {
        // Reset sort
        this.sortColumn.set(undefined);
        this.sortDirection.set('asc');
      }
    } else {
      this.sortColumn.set(sortKey);
      this.sortDirection.set('asc');
    }
    this.fetchTools();
  }

  getAriaSort(sortKey?: string): string | null {
    if (!sortKey || this.sortColumn() !== sortKey) return null;
    return this.sortDirection() === 'asc' ? 'ascending' : 'descending';
  }

  tierBadgeClass(tier: string): string {
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

  statusBadgeClass(status: string): string {
    const lower = status.toLowerCase();
    if (lower.includes('complete') || lower.includes('done'))
      return 'badge--success';
    if (lower.includes('progress') || lower.includes('review'))
      return 'badge--warning';
    if (lower.includes('not started') || lower.includes('todo'))
      return 'badge--neutral';
    return 'badge--info';
  }

  isEnrichmentComplete(status: string | undefined): boolean {
    if (!status) return false;
    const lower = status.toLowerCase();
    return lower.includes('complete') || lower.includes('enriched') || lower.includes('done');
  }

  prevPage(): void {
    this.offset.set(Math.max(0, this.offset() - this.limit()));
    this.fetchTools();
  }

  nextPage(): void {
    this.offset.set(this.offset() + this.limit());
    this.fetchTools();
  }
}
