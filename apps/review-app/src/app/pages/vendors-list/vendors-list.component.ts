import {
  Component,
  OnInit,
  ViewChild,
  inject,
  signal,
  DestroyRef,
} from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import {
  GridModule,
  GridComponent,
  FilterService,
  SortService,
  SelectionService,
  VirtualScrollService,
  PageService,
  type SelectionSettingsModel,
  type FilterSettingsModel,
  type PageSettingsModel,
  type RowSelectEventArgs,
  type RowDeselectEventArgs,
} from '@syncfusion/ej2-angular-grids';
import { ApiService } from '../../services/api.service';
import { Vendor } from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { enrichmentVariant } from '../../utils/enrichment';

interface VendorRow extends Vendor {
  /** Pre-formatted readiness % for the column template (avoids pipe in column). */
  readinessPercent: number | null;
}

@Component({
  selector: 'app-vendors-list',
  imports: [CommonModule, GridModule, EnrichSplitButtonComponent],
  providers: [
    FilterService,
    SortService,
    SelectionService,
    VirtualScrollService,
    PageService,
  ],
  template: `
    <div class="vendors-page">
      <div class="page-header">
        <h1 class="page-heading">Vendors</h1>
        <div class="page-header__actions">
          @if (selectedIds().length > 0) {
            <span class="selection-count">
              {{ selectedIds().length }} selected
            </span>
          }
          <app-enrich-split-button
            family="vendor"
            [recordIds]="selectedIds()"
            [filteredIds]="allIds()"
          />
        </div>
      </div>

      <div class="vendors-page__grid">
        @if (loading()) {
          <p class="loading-note loading-note--overlay">Loading vendors…</p>
        } @else if (rows().length === 0) {
          <p class="loading-note loading-note--overlay">No vendors found.</p>
        }
        <ejs-grid
          #grid
          [dataSource]="rows()"
          [allowSorting]="true"
          [allowFiltering]="true"
          [allowResizing]="true"
          [filterSettings]="filterSettings"
          [selectionSettings]="selectionSettings"
          [pageSettings]="pageSettings"
          [enableVirtualization]="true"
          [enableHover]="true"
          [enableStickyHeader]="true"
          height="100%"
          rowHeight="40"
          (rowSelected)="onRowSelected($event)"
          (rowDeselected)="onRowDeselected($event)"
          (recordClick)="onRecordClick($event)"
        >
        <e-columns>
          <e-column
            type="checkbox"
            width="46"
            [allowFiltering]="false"
            [allowSorting]="false"
            [allowResizing]="false"
          ></e-column>
          <e-column
            field="companyName"
            headerText="Company"
            width="240"
            clipMode="EllipsisWithTooltip"
          >
            <ng-template #template let-data>
              <a class="vendor-name-link" (click)="goToVendor(data.id, $event)">
                {{ data.companyName }}
              </a>
            </ng-template>
          </e-column>
          <e-column
            field="headquarters"
            headerText="Headquarters"
            width="180"
            clipMode="EllipsisWithTooltip"
          ></e-column>
          <e-column
            field="foundedYear"
            headerText="Founded"
            width="110"
            textAlign="Right"
            type="number"
          ></e-column>
          <e-column
            field="companySize"
            headerText="Size"
            width="140"
            textAlign="Right"
          ></e-column>
          <e-column
            field="employeeCountExact"
            headerText="Employees"
            width="130"
            textAlign="Right"
            type="number"
            format="N0"
          ></e-column>
          <e-column
            field="readinessPercent"
            headerText="Readiness"
            width="130"
            textAlign="Right"
            type="number"
            format="N0"
          >
            <ng-template #template let-data>
              @if (data.readinessPercent !== null) {
                <span>{{ data.readinessPercent }}%</span>
              } @else {
                <span class="empty-cell">—</span>
              }
            </ng-template>
          </e-column>
          <e-column
            field="githubStarsTotal"
            headerText="GitHub ★"
            width="120"
            textAlign="Right"
            type="number"
            format="N0"
          ></e-column>
          <e-column
            field="vendorEnrichmentStatus"
            headerText="Enrichment"
            width="140"
          >
            <ng-template #template let-data>
              @if (data.vendorEnrichmentStatus) {
                <span class="badge" [class]="'badge badge--' + enrichmentVariant(data.vendorEnrichmentStatus)">
                  {{ data.vendorEnrichmentStatus }}
                </span>
              } @else {
                <span class="empty-cell">—</span>
              }
            </ng-template>
          </e-column>
          <e-column
            field="toolCount"
            headerText="Tools"
            width="100"
            textAlign="Right"
            type="number"
            format="N0"
          ></e-column>
        </e-columns>
        </ejs-grid>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      /* Fill the viewport below the 52px sticky shell header. */
      height: calc(100dvh - 52px);
    }

    .vendors-page {
      display: flex;
      flex-direction: column;
      height: 100%;
      max-width: 1440px;
      margin: 0 auto;
      padding: var(--space-6);
      gap: var(--space-5);
    }

    .vendors-page__grid {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      position: relative;
    }

    .vendors-page__grid ejs-grid {
      flex: 1 1 auto;
      min-height: 0;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      flex-shrink: 0;
    }

    .page-heading {
      font-size: var(--text-xl);
      font-weight: 500;
      color: var(--color-text-primary);
      margin: 0;
    }

    .page-header__actions {
      display: flex;
      align-items: center;
      gap: var(--space-3);
    }

    .selection-count {
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
    }

    .vendor-name-link {
      font-weight: 500;
      color: var(--color-text-accent);
      cursor: pointer;
    }

    .vendor-name-link:hover {
      text-decoration: underline;
    }

    .empty-cell { color: var(--color-text-tertiary); }

    .loading-note {
      margin-top: var(--space-3);
      font-size: var(--text-sm);
      color: var(--color-text-secondary);
    }

    /* Sits above the grid's empty body so it's visible during initial load. */
    .loading-note--overlay {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      margin: 0;
      z-index: 1;
      pointer-events: none;
    }
  `,
})
export class VendorsListComponent implements OnInit {
  private api = inject(ApiService);
  private router = inject(Router);
  private destroyRef = inject(DestroyRef);
  private destroy$ = new Subject<void>();

  @ViewChild('grid') grid?: GridComponent;

  protected readonly rows = signal<VendorRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly selectedIds = signal<string[]>([]);

  protected readonly filterSettings: FilterSettingsModel = {
    type: 'Excel',
  };

  protected readonly selectionSettings: SelectionSettingsModel = {
    type: 'Multiple',
    checkboxOnly: true,
    persistSelection: true,
  };

  /** Virtual-scroll chunk size — larger pages reduce row recycling thrash on long lists. */
  protected readonly pageSettings: PageSettingsModel = {
    pageSize: 100,
  };

  /** All currently-loaded vendor IDs — feeds the "Enrich filtered" fallback. */
  protected readonly allIds = (): string[] => this.rows().map((v) => v.id);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroy$.next();
      this.destroy$.complete();
    });
  }

  ngOnInit(): void {
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
          this.rows.set(res.data.map(toRow));
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
        },
      });
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

  /** Native click on the company name cell — route without disturbing checkbox selection. */
  goToVendor(id: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.router.navigate(['/vendors', id]);
  }

  /** Generic record click — ignore so plain-row clicks don't navigate or toggle selection. */
  onRecordClick(_args: unknown): void {
    // no-op: selection is checkbox-only; navigation is the explicit name link.
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
