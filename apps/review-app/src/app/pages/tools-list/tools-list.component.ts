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
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import {
  Tool,
  MetaResponse,
  LinkRef,
  PaginatedResponse,
} from '../../types';

@Component({
  selector: 'app-tools-list',
  imports: [RouterLink, FormsModule],
  template: `
    <div class="page-container--wide">
      <div class="page-header">
        <h1 class="page-heading">Tools</h1>
        <a routerLink="/tools/new" class="btn btn--primary btn--sm">+ New tool</a>
      </div>

      <!-- Filter bar -->
      <div class="filter-bar">
        <input
          class="input filter-bar__search"
          type="search"
          placeholder="Search tools..."
          [value]="searchInput()"
          (input)="onSearchInput($event)"
          aria-label="Search tools"
        />
        <select
          class="input filter-bar__select"
          [value]="filterCategory()"
          (change)="onFilterChange('category', $event)"
          aria-label="Filter by category"
        >
          <option value="">All categories</option>
          @for (cat of meta()?.categories ?? []; track cat.id) {
            <option [value]="cat.id">{{ cat.name }}</option>
          }
        </select>
        <select
          class="input filter-bar__select"
          [value]="filterDiscipline()"
          (change)="onFilterChange('discipline', $event)"
          aria-label="Filter by discipline"
        >
          <option value="">All disciplines</option>
          @for (d of meta()?.disciplines ?? []; track d.id) {
            <option [value]="d.id">{{ d.name }}</option>
          }
        </select>
        <select
          class="input filter-bar__select"
          [value]="filterPhase()"
          (change)="onFilterChange('phase', $event)"
          aria-label="Filter by phase"
        >
          <option value="">All phases</option>
          @for (p of meta()?.phases ?? []; track p.id) {
            <option [value]="p.id">{{ p.name }}</option>
          }
        </select>
        <select
          class="input filter-bar__select"
          [value]="filterStatus()"
          (change)="onFilterChange('status', $event)"
          aria-label="Filter by research status"
        >
          <option value="">All statuses</option>
          @for (s of meta()?.researchStatuses ?? []; track s) {
            <option [value]="s">{{ s }}</option>
          }
        </select>
        <select
          class="input filter-bar__select"
          [value]="filterTier()"
          (change)="onFilterChange('tier', $event)"
          aria-label="Filter by priority tier"
        >
          <option value="">All tiers</option>
          @for (t of meta()?.priorityTiers ?? []; track t) {
            <option [value]="t">Tier {{ t }}</option>
          }
        </select>
        <select
          class="input filter-bar__select"
          [value]="filterEnrichment()"
          (change)="onFilterChange('enrichmentStatus', $event)"
          aria-label="Filter by enrichment status"
        >
          <option value="">Any enrichment</option>
          @for (e of meta()?.toolEnrichmentStatuses ?? []; track e) {
            <option [value]="e">{{ e }}</option>
          }
        </select>
      </div>

      <!-- Table -->
      <div class="table-wrapper">
        <table class="table" aria-label="Tools">
          <thead>
            <tr>
              @for (col of columns; track col.key) {
                <th
                  [class.sortable]="col.sortable"
                  [class.sorted]="sortColumn() === col.sortKey"
                  (click)="col.sortable ? toggleSort(col.sortKey!) : null"
                  [attr.aria-sort]="getAriaSort(col.sortKey)"
                >
                  {{ col.label }}
                  @if (col.sortable && sortColumn() === col.sortKey) {
                    <span class="sort-indicator">{{ sortDirection() === 'asc' ? '\u2191' : '\u2193' }}</span>
                  }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (tool of tools(); track tool.id) {
              <tr>
                <td>
                  <a [routerLink]="['/tools', tool.id]" class="tool-name-link">{{ tool.name }}</a>
                </td>
                <td>
                  @for (v of tool.vendors; track v.id; let last = $last) {
                    <a [routerLink]="['/vendors', v.id]">{{ v.name }}</a>{{ last ? '' : ', ' }}
                  }
                </td>
                <td>
                  <span class="chip-list">
                    @for (c of visibleRefs(tool.categories); track c.id) {
                      <span class="badge badge--neutral">{{ c.name }}</span>
                    }
                    @if (overflowRefs(tool.categories); as extra) {
                      <span
                        class="badge badge--neutral pill-overflow"
                        tabindex="0"
                        [attr.aria-label]="extra.length + ' more categories'"
                      >
                        +{{ extra.length }}
                        <span class="pill-overflow__menu" role="tooltip">
                          @for (c of extra; track c.id) {
                            <span class="pill-overflow__item">{{ c.name }}</span>
                          }
                        </span>
                      </span>
                    }
                  </span>
                </td>
                <td>
                  <span class="chip-list">
                    @for (d of visibleRefs(tool.disciplines); track d.id) {
                      <span class="badge badge--neutral">{{ d.name }}</span>
                    }
                    @if (overflowRefs(tool.disciplines); as extra) {
                      <span
                        class="badge badge--neutral pill-overflow"
                        tabindex="0"
                        [attr.aria-label]="extra.length + ' more disciplines'"
                      >
                        +{{ extra.length }}
                        <span class="pill-overflow__menu" role="tooltip">
                          @for (d of extra; track d.id) {
                            <span class="pill-overflow__item">{{ d.name }}</span>
                          }
                        </span>
                      </span>
                    }
                  </span>
                </td>
                <td>
                  <span class="chip-list">
                    @for (p of visibleRefs(tool.phases); track p.id) {
                      <span class="badge badge--neutral">{{ p.name }}</span>
                    }
                    @if (overflowRefs(tool.phases); as extra) {
                      <span
                        class="badge badge--neutral pill-overflow"
                        tabindex="0"
                        [attr.aria-label]="extra.length + ' more phases'"
                      >
                        +{{ extra.length }}
                        <span class="pill-overflow__menu" role="tooltip">
                          @for (p of extra; track p.id) {
                            <span class="pill-overflow__item">{{ p.name }}</span>
                          }
                        </span>
                      </span>
                    }
                  </span>
                </td>
                <td class="text-center">{{ tool.integrationCount }}</td>
                <td class="text-center">
                  @if (tool.priorityTier) {
                    <span class="badge" [class]="tierBadgeClass(tool.priorityTier)">
                      {{ tool.priorityTier }}
                    </span>
                  }
                </td>
                <td class="text-center">{{ tool.priorityScore ?? '—' }}</td>
                <td>
                  @if (tool.toolEnrichmentStatus) {
                    <span class="badge badge--neutral">{{ tool.toolEnrichmentStatus }}</span>
                  }
                </td>
                <td>
                  @if (tool.researchStatus) {
                    <span class="badge" [class]="statusBadgeClass(tool.researchStatus)">
                      {{ tool.researchStatus }}
                    </span>
                  }
                </td>
                <td>
                  @if (tool.website) {
                    <a [href]="tool.website" target="_blank" rel="noopener noreferrer" class="external-link" aria-label="Visit website">
                      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </a>
                  }
                </td>
                <td>
                  @if (tool.hasApiDocs && tool.apiDocsUrl) {
                    <a [href]="tool.apiDocsUrl" target="_blank" rel="noopener noreferrer" class="external-link" aria-label="Visit API docs">
                      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </a>
                  } @else if (tool.hasApiDocs) {
                    <span class="external-link" aria-label="Has API docs">API</span>
                  }
                </td>
                <td>
                  @if (tool.toolIntegrationsUrl) {
                    <a [href]="tool.toolIntegrationsUrl" target="_blank" rel="noopener noreferrer" class="external-link" aria-label="Visit integrations page">
                      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </a>
                  }
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="13" class="empty-state">
                  @if (loading()) {
                    Loading tools...
                  } @else {
                    No tools found matching your filters.
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      @if (total() > 0) {
        <div class="pagination">
          <span class="pagination__info">
            Showing {{ rangeStart() }}–{{ rangeEnd() }} of {{ total() }}
          </span>
          <div class="pagination__controls">
            <button
              class="btn btn--ghost btn--sm"
              [disabled]="offset() === 0"
              (click)="prevPage()"
            >
              Previous
            </button>
            <button
              class="btn btn--ghost btn--sm"
              [disabled]="rangeEnd() >= total()"
              (click)="nextPage()"
            >
              Next
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-5);
    }

    .page-heading {
      font-size: var(--text-xl);
      font-weight: 500;
      color: var(--color-text-primary);
      margin: 0;
    }

    .pill-overflow {
      position: relative;
      cursor: default;
    }

    .pill-overflow__menu {
      display: none;
      position: absolute;
      top: calc(100% + var(--space-1));
      left: 0;
      z-index: 10;
      min-width: 160px;
      max-width: 280px;
      padding: var(--space-2);
      background: var(--color-bg-elevated);
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
    }

    .pill-overflow:hover .pill-overflow__menu,
    .pill-overflow:focus-within .pill-overflow__menu {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }

    .pill-overflow__item {
      font-size: var(--text-xs);
      color: var(--color-text-body);
      white-space: normal;
      line-height: 1.4;
    }

    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
    }

    .filter-bar__search {
      width: 240px;
    }

    .filter-bar__select {
      width: 180px;
    }

    .table-wrapper {
      overflow-x: auto;
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-lg);
      background: var(--color-bg-elevated);
    }

    .table {
      min-width: 900px;
    }

    th.sortable {
      cursor: pointer;
    }

    th.sortable:hover {
      color: var(--color-text-body);
    }

    th.sorted {
      color: var(--color-text-primary);
    }

    .sort-indicator {
      margin-left: var(--space-1);
      font-size: var(--text-xs);
    }

    .tool-name-link {
      font-weight: 500;
      color: var(--color-text-accent);
    }

    .chip-list {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
    }

    .text-center {
      text-align: center;
    }

    .external-link {
      color: var(--color-text-tertiary);
      display: inline-flex;
    }

    .external-link:hover {
      color: var(--color-text-accent);
    }

    .empty-state {
      text-align: center;
      color: var(--color-text-secondary);
      padding: var(--space-10) var(--space-4) !important;
    }

    .pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: var(--space-4);
    }

    .pagination__info {
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
    }

    .pagination__controls {
      display: flex;
      gap: var(--space-2);
    }
  `,
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

  columns = [
    { key: 'name', label: 'Name', sortable: true, sortKey: 'name' },
    { key: 'vendors', label: 'Vendor(s)', sortable: true, sortKey: 'vendor' },
    { key: 'categories', label: 'Categories', sortable: false },
    { key: 'disciplines', label: 'Disciplines', sortable: false },
    { key: 'phases', label: 'Phases', sortable: false },
    {
      key: 'integrationCount',
      label: 'Integrations',
      sortable: true,
      sortKey: 'integrationCount',
    },
    {
      key: 'priorityTier',
      label: 'Tier',
      sortable: true,
      sortKey: 'priorityTier',
    },
    {
      key: 'priorityScore',
      label: 'Priority',
      sortable: true,
      sortKey: 'priorityScore',
    },
    {
      key: 'enrichment',
      label: 'Enrichment',
      sortable: true,
      sortKey: 'enrichmentStatus',
    },
    {
      key: 'researchStatus',
      label: 'Research status',
      sortable: true,
      sortKey: 'researchStatus',
    },
    { key: 'website', label: 'Website', sortable: true, sortKey: 'website' },
    { key: 'apiDocs', label: 'API', sortable: true, sortKey: 'hasApiDocs' },
    {
      key: 'integrationsUrl',
      label: 'Integrations page',
      sortable: true,
      sortKey: 'integrationsUrl',
    },
  ];

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

  prevPage(): void {
    this.offset.set(Math.max(0, this.offset() - this.limit()));
    this.fetchTools();
  }

  nextPage(): void {
    this.offset.set(this.offset() + this.limit());
    this.fetchTools();
  }
}
