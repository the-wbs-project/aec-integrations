import { DatePipe } from '@angular/common';
import { Component, afterNextRender, inject, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import type { AdminThreadHelpFilter, AdminThreadRow } from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { threadCompanies, threadStateLabel, threadSubject } from './admin-thread-labels';
import { AdminThreadsApi } from './admin-threads-api';

/** Rows per page: the shared `PageQuerySchema` default, as on `/admin/subscribers`. */
const PER_PAGE = 24;

/**
 * `/admin/threads` — every private row thread between two vendor companies.
 * AECI-1539, `ADMIN_PANEL_SPEC.md` §5.19, `STAGE_2_ATTESTATIONS_SPEC.md` §15.12.
 *
 * **A list, not a queue.** Nothing here waits on AECi: a seat that wants AECi to
 * look presses "Ask AEC Integrations", which emails the support inbox (§15.3). The
 * "Help requested" filter finds those threads. There is no badge and no action.
 *
 * Same shape as `SubscriberList`: SSR paints the shell, `afterNextRender` fetches,
 * an `aec-select` filter returns to page 1, and the shared `aec-admin-paginator`
 * pages. Each row links to `/admin/threads/:id`, where every message is shown.
 */
@Component({
  selector: 'aec-thread-list',
  imports: [AdminPaginator, AecSelect, DatePipe, RouterLink],
  templateUrl: './thread-list.html',
})
export class ThreadList {
  private readonly api = inject(AdminThreadsApi);
  private readonly titleSvc = inject(Title);

  protected readonly threads = signal<readonly AdminThreadRow[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly perPage = PER_PAGE;
  protected readonly help = signal<AdminThreadHelpFilter>('all');

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  protected readonly helpOptions: readonly AecSelectOption[] = [
    { value: 'all', label: $localize`:@@admin.threads.filter.all:All threads` },
    { value: 'requested', label: $localize`:@@admin.threads.filter.requested:Help requested` },
  ];

  protected readonly stateLabel = threadStateLabel;
  protected readonly subject = threadSubject;
  protected readonly companies = threadCompanies;

  constructor() {
    this.titleSvc.setTitle(
      $localize`:@@admin.threads.metaTitle:Row threads · Admin · AEC Integrations`,
    );
    afterNextRender(() => {
      void this.load();
    });
  }

  protected onHelpChange(value: string | null): void {
    this.help.set((value as AdminThreadHelpFilter | null) ?? 'all');
    // A filter change returns to page 1, as on every admin list.
    this.page.set(1);
    void this.load();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const response = await this.api.listThreads({
        page: this.page(),
        perPage: this.perPage,
        ...(this.help() === 'all' ? {} : { help: this.help() }),
      });
      this.threads.set(response.data);
      this.total.set(response.total);
      this.liveMessage.set(
        $localize`:@@admin.threads.announce.loaded:${response.total}:COUNT: threads match.`,
      );
    } catch {
      this.loadFailed.set(true);
      this.threads.set([]);
      this.total.set(0);
    } finally {
      this.loading.set(false);
    }
  }
}
