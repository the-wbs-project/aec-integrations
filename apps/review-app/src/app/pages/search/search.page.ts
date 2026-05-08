import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, NgClass } from '@angular/common';
import { finalize } from 'rxjs';
import { ApiService } from '../../services/api.service';
import type {
  AeciSearchEntityType,
  AeciSearchResponse,
  AeciSearchResult,
  AeciSearchSyncResponse,
} from '../../types';

@Component({
  selector: 'app-search-page',
  imports: [FormsModule, DecimalPipe, NgClass],
  templateUrl: './search.page.html',
  styleUrl: './search.page.scss',
})
export class SearchPage {
  private readonly api = inject(ApiService);

  protected readonly query = signal('');
  protected readonly entityType = signal<AeciSearchEntityType | ''>('');
  protected readonly searching = signal(false);
  protected readonly syncing = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly response = signal<AeciSearchResponse | null>(null);
  protected readonly syncResult = signal<AeciSearchSyncResponse | null>(null);

  protected readonly hasQuery = computed(() => this.query().trim().length > 0);
  protected readonly results = computed(() => this.response()?.results ?? []);

  protected search(): void {
    const query = this.query().trim();
    if (!query || this.searching()) return;

    this.error.set(null);
    this.searching.set(true);
    this.api
      .searchAeciCorpus({
        query,
        limit: 10,
        filters: this.entityType()
          ? { entity_type: this.entityType() as AeciSearchEntityType }
          : undefined,
      })
      .pipe(finalize(() => this.searching.set(false)))
      .subscribe({
        next: (res) => this.response.set(res),
        error: (err) => this.error.set(errorMessage(err, 'Search failed')),
      });
  }

  protected syncPilot(): void {
    if (this.syncing()) return;
    this.error.set(null);
    this.syncing.set(true);
    this.api
      .syncAeciSearch({
        products: 25,
        vendors: 10,
        integrations: 25,
        evidence: true,
      })
      .pipe(finalize(() => this.syncing.set(false)))
      .subscribe({
        next: (res) => this.syncResult.set(res),
        error: (err) => this.error.set(errorMessage(err, 'Sync failed')),
      });
  }

  protected entityLabel(result: AeciSearchResult): string {
    switch (result.entityType) {
      case 'product':
        return 'Product';
      case 'vendor':
        return 'Vendor';
      case 'integration':
        return 'Integration';
      case 'evidence':
        return 'Evidence';
      default:
        return 'Result';
    }
  }

  protected entityClass(result: AeciSearchResult): Record<string, boolean> {
    return {
      'result-type--product': result.entityType === 'product',
      'result-type--vendor': result.entityType === 'vendor',
      'result-type--integration': result.entityType === 'integration',
      'result-type--evidence': result.entityType === 'evidence',
    };
  }
}

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const maybe = err as { error?: { details?: string; error?: string }; message?: string };
    return maybe.error?.details ?? maybe.error?.error ?? maybe.message ?? fallback;
  }
  return fallback;
}
