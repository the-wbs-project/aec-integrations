import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminConnectorCatalogRow, ConnectorManagedBy } from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AdminPaginator } from '../admin-paginator';
import { AdminConnectorsApi } from './admin-connectors-api';

const PAGE_SIZE = 25;

type ManagedFilter = 'any' | ConnectorManagedBy;

/**
 * `/admin/connectors` — the connector catalogue list (AECI-722 /
 * `docs/ADMIN_PANEL_SPEC.md` §5.9).
 *
 * The console's first window onto the connector lane. Until this screen the six
 * AECI-714 tables had no reader at all: the review app's unmapped listings — the
 * operator's actual triage backlog — were invisible, and so was the catalogue
 * freshness that `STAGE_2_SPEC.md` §8.9(4) makes this surface answerable for.
 *
 * Follows `/admin/vendors`: the gate and nav SSR via `adminSummaryResolver` on
 * the parent route; this screen paints its shell during SSR and fetches
 * client-side in `afterNextRender`, where the same-origin request carries the
 * session cookie for `requireAdmin()` to verify. It never reads cookies or
 * session state directly.
 *
 * Filters are component state, not URL parameters — the console's convention
 * (`user-list.ts` records why: a `Router.navigate` per control turns the back
 * button into a walk through the operator's own filter history). `/admin` is
 * never edge-cached, so nothing about a filter forks a cache key either.
 */
@Component({
  selector: 'aec-connector-list',
  imports: [RouterLink, AdminPaginator, AecSelect, DatePipe],
  templateUrl: './connector-list.html',
})
export class ConnectorList {
  private readonly api = inject(AdminConnectorsApi);

  protected readonly catalogs = signal<readonly AdminConnectorCatalogRow[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly perPage = PAGE_SIZE;

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /** The committed search term — what was last SENT, not what is being typed. */
  protected readonly search = signal('');
  protected readonly searchDraft = signal('');
  protected readonly managedBy = signal<ManagedFilter>('any');

  protected readonly managedOptions: readonly AecSelectOption[] = [
    { value: 'any', label: $localize`:@@admin.connectors.filter.managed.any:Any lane` },
    {
      value: 'review',
      label: $localize`:@@admin.connectors.filter.managed.review:Review-managed`,
    },
    {
      value: 'vendor',
      label: $localize`:@@admin.connectors.filter.managed.vendor:Vendor-managed`,
    },
  ];

  protected readonly isEmpty = computed(() => !this.loading() && this.catalogs().length === 0);

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

  protected onManagedChange(value: string | null): void {
    this.managedBy.set((value as ManagedFilter | null) ?? 'any');
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
      const managed = this.managedBy();
      const response = await this.api.listCatalogs({
        page: this.page(),
        perPage: this.perPage,
        ...(search ? { search } : {}),
        ...(managed === 'any' ? {} : { managed_by: managed }),
      });
      this.catalogs.set(response.data);
      this.total.set(response.total);
      this.liveMessage.set(
        $localize`:@@admin.connectors.announce.loaded:${response.total}:COUNT: catalogues match.`,
      );
    } catch {
      this.loadFailed.set(true);
      this.catalogs.set([]);
      this.total.set(0);
    } finally {
      this.loading.set(false);
    }
  }

  /** Localized label for the management lane. */
  protected laneLabel(row: AdminConnectorCatalogRow): string {
    return row.managed_by === 'vendor'
      ? $localize`:@@admin.connectors.lane.vendor:Vendor-managed`
      : $localize`:@@admin.connectors.lane.review:Review-managed`;
  }
}
