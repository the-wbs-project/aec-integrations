import {
  Component,
  OnInit,
  inject,
  signal,
  computed,
  DestroyRef,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { Vendor } from '../../types';

@Component({
  selector: 'app-vendors-list',
  imports: [RouterLink, FormsModule],
  template: `
    <div class="page-container--wide">
      <h1 class="page-heading">Vendors</h1>

      <!-- Search -->
      <div class="filter-bar">
        <input
          class="input filter-bar__search"
          type="search"
          placeholder="Search vendors..."
          [value]="searchInput()"
          (input)="onSearchInput($event)"
          aria-label="Search vendors"
        />
      </div>

      <!-- Table -->
      <div class="table-wrapper">
        <table class="table" aria-label="Vendors">
          <thead>
            <tr>
              @for (col of columns; track col.key) {
                <th
                  [class.sortable]="!!col.sortKey"
                  [class.sorted]="col.sortKey && sortColumn() === col.sortKey"
                  (click)="col.sortKey ? toggleSort(col.sortKey) : null"
                  [attr.aria-sort]="getAriaSort(col.sortKey)"
                >
                  {{ col.label }}
                  @if (col.sortKey && sortColumn() === col.sortKey) {
                    <span class="sort-indicator">{{ sortDirection() === 'asc' ? '\u2191' : '\u2193' }}</span>
                  }
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (vendor of vendors(); track vendor.id) {
              <tr>
                <td>
                  <a [routerLink]="['/vendors', vendor.id]" class="vendor-name-link">
                    {{ vendor.companyName }}
                  </a>
                </td>
                <td>{{ vendor.headquarters }}</td>
                <td>{{ vendor.foundedYear }}</td>
                <td>{{ vendor.companySize }}</td>
                <td class="text-center">{{ vendor.employeeCountExact ?? '—' }}</td>
                <td>{{ vendor.fundingStage }}</td>
                <td class="text-center">{{ vendor.githubStarsTotal ?? '—' }}</td>
                <td>
                  @if (vendor.vendorEnrichmentStatus) {
                    <span class="badge badge--neutral">{{ vendor.vendorEnrichmentStatus }}</span>
                  }
                </td>
                <td>{{ vendor.publicPrivate }}</td>
                <td>{{ vendor.parentCompany }}</td>
                <td class="text-center">{{ vendor.toolCount }}</td>
              </tr>
            } @empty {
              <tr>
                <td colspan="11" class="empty-state">
                  @if (loading()) {
                    Loading vendors...
                  } @else {
                    No vendors found.
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
    .page-heading {
      font-size: var(--text-xl);
      font-weight: 500;
      color: var(--color-text-primary);
      margin-bottom: var(--space-5);
    }

    .filter-bar {
      display: flex;
      gap: var(--space-2);
      margin-bottom: var(--space-4);
    }

    .filter-bar__search {
      width: 280px;
    }

    .table-wrapper {
      overflow-x: auto;
      border: 0.5px solid var(--color-border-default);
      border-radius: var(--radius-lg);
      background: var(--color-bg-elevated);
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

    .vendor-name-link {
      font-weight: 500;
      color: var(--color-text-accent);
    }

    .text-center {
      text-align: center;
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
export class VendorsListComponent implements OnInit {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private destroy$ = new Subject<void>();
  private searchSubject = new Subject<string>();

  vendors = signal<Vendor[]>([]);
  total = signal(0);
  offset = signal(0);
  limit = signal(50);
  loading = signal(false);

  sortColumn = signal<string | undefined>(undefined);
  sortDirection = signal<'asc' | 'desc'>('asc');
  searchInput = signal('');
  searchQuery = signal('');

  rangeStart = computed(() => (this.total() === 0 ? 0 : this.offset() + 1));
  rangeEnd = computed(() =>
    Math.min(this.offset() + this.limit(), this.total())
  );

  // Only columns backed by a server-side sort case get a sortKey.
  columns: { key: string; label: string; sortKey?: string }[] = [
    { key: 'companyName', label: 'Company name', sortKey: 'companyName' },
    { key: 'headquarters', label: 'Headquarters' },
    { key: 'foundedYear', label: 'Founded', sortKey: 'foundedYear' },
    { key: 'companySize', label: 'Size' },
    { key: 'employees', label: 'Employees', sortKey: 'employees' },
    { key: 'fundingStage', label: 'Funding stage' },
    { key: 'githubStars', label: 'GitHub ★', sortKey: 'githubStars' },
    { key: 'vendorEnrichmentStatus', label: 'Enrichment' },
    { key: 'publicPrivate', label: 'Public / private' },
    { key: 'parentCompany', label: 'Parent company' },
    { key: 'toolCount', label: 'Tools', sortKey: 'toolCount' },
  ];

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
        this.offset.set(0);
        this.fetchVendors();
      });

    this.fetchVendors();
  }

  fetchVendors(): void {
    this.loading.set(true);
    this.api
      .getVendors({
        offset: this.offset(),
        limit: this.limit(),
        search: this.searchQuery() || undefined,
        sort: this.sortColumn() || undefined,
        direction: this.sortColumn() ? this.sortDirection() : undefined,
      })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: (res) => {
          this.vendors.set(res.data);
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

  toggleSort(sortKey: string): void {
    if (this.sortColumn() === sortKey) {
      if (this.sortDirection() === 'asc') {
        this.sortDirection.set('desc');
      } else {
        this.sortColumn.set(undefined);
        this.sortDirection.set('asc');
      }
    } else {
      this.sortColumn.set(sortKey);
      this.sortDirection.set('asc');
    }
    this.fetchVendors();
  }

  getAriaSort(sortKey?: string): string | null {
    if (!sortKey || this.sortColumn() !== sortKey) return null;
    return this.sortDirection() === 'asc' ? 'ascending' : 'descending';
  }

  prevPage(): void {
    this.offset.set(Math.max(0, this.offset() - this.limit()));
    this.fetchVendors();
  }

  nextPage(): void {
    this.offset.set(this.offset() + this.limit());
    this.fetchVendors();
  }
}
