import {
  Component,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  VENDOR_THREAD_LIST_STATUSES,
  type ListVendorThreadsResponse,
  type VendorThreadListItem,
  type VendorThreadListStatus,
} from '@aeci/shared';

import { formatDay } from '../integration-detail/integration-detail-model';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/** One read: a filter and a page. */
interface ThreadsTarget {
  readonly status: VendorThreadListStatus;
  readonly page: number;
}

/** Rows per page, as on the Changes page. */
export const VENDOR_THREADS_PAGE_SIZE = 25;

/**
 * `…/threads`, the portal's Conversations list (AECI-1551,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15.11).
 *
 * One page of `GET /api/vendor/threads`: every private row thread the company is
 * on, open and closed, newest activity first. Each row names the other company and
 * the data row, says when it last moved, whether it is open or closed, and whether
 * AEC Integrations was asked to look. It links to the thread's permanent page,
 * `…/threads/:threadId`. This list is the path to a thread that outlasts the 90-day
 * notification list, and the only one to a thread whose row was deleted.
 *
 * Paging and filtering copy the Changes page (`history/vendor-history-page.ts`),
 * the portal's other paged list, under the same-behavior rule: filter chips above,
 * Previous / Next below, and the filter and page commit only when a read lands. No
 * message text is read here, so nothing is marked read. Each `threadsRevision` tick
 * re-reads the page on screen quietly.
 */
@Component({
  selector: 'aec-vendor-threads-page',
  imports: [RouterLink],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="vendor-threads-heading" data-vendor-threads>
      <div class="max-w-[52ch] space-y-2">
        <h2 id="vendor-threads-heading" class="m-0">
          <!-- The size lives on the span: styles.css sizes h2 outside any cascade layer. -->
          <span
            class="block font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.threads.heading"
            >Conversations</span
          >
        </h2>
        <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.threads.intro">
          Every private conversation your company has with another company about a data row, open
          and closed, newest first. Only your two companies and AEC Integrations see each one.
        </p>
      </div>

      <div
        class="mt-6 flex flex-wrap gap-2"
        role="group"
        [attr.aria-label]="filterLabel"
        data-threads-filter
      >
        @for (s of statuses; track s) {
          <button
            type="button"
            [class]="chipClass"
            [attr.aria-pressed]="status() === s"
            [attr.data-status]="s"
            (click)="applyStatus(s)"
          >
            {{ statusLabel(s) }}
          </button>
        }
      </div>

      @if (state() === 'failed' && !response()) {
        <div class="mt-6 space-y-2" data-threads-failed>
          <p class="text-sm text-(--text-primary)" role="alert" i18n="@@vendor.threads.failed">
            Could not load your conversations.
          </p>
          <button
            type="button"
            [class]="secondaryClass"
            (click)="reload()"
            i18n="@@vendor.threads.retry"
          >
            Try again
          </button>
        </div>
      } @else if (!response()) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.threads.loading">
          Loading conversations…
        </p>
      } @else {
        @if (state() === 'failed') {
          <div
            class="mt-4 flex max-w-[52ch] flex-wrap items-center gap-3 text-sm text-(--text-primary)"
            data-threads-refresh-failed
          >
            <span role="alert" i18n="@@vendor.threads.refreshFailed"
              >Could not refresh the list. It shows what was loaded last.</span
            >
            <button
              type="button"
              [class]="secondaryClass"
              (click)="reload()"
              i18n="@@vendor.threads.retry"
            >
              Try again
            </button>
          </div>
        }

        @if (items().length === 0) {
          <p class="mt-6 max-w-[52ch] text-sm text-(--text-secondary)" data-threads-empty>
            {{ emptyMessage() }}
          </p>
        } @else {
          <ol
            class="mt-6 divide-y divide-(--border-default) rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised)"
            [attr.aria-busy]="refreshing() ? 'true' : null"
          >
            @for (item of items(); track item.id) {
              <li class="px-5 py-4" [attr.data-thread-row]="item.id">
                <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
                  <a
                    [routerLink]="item.id"
                    class="min-w-0 break-words text-sm font-semibold text-(--accent-primary) underline-offset-4 hover:underline focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    data-thread-link
                    >{{ rowTitle(item) }}</a
                  >
                  <time
                    class="shrink-0 text-xs text-(--text-secondary) tabular-nums"
                    [attr.datetime]="item.last_activity_at"
                    >{{ activityLabel(item) }}</time
                  >
                </div>
                <p class="mt-1 text-xs text-(--text-secondary)">
                  <span class="font-medium text-(--text-primary)" data-thread-state>{{
                    stateLabel(item)
                  }}</span>
                  <span aria-hidden="true"> · </span>
                  <span i18n="@@vendor.threads.row.count">{item.message_count, plural,
                    =1 {1 message}
                    other {{{ item.message_count }} messages}
                  }</span>
                  @if (item.help_requested_at) {
                    <span aria-hidden="true"> · </span>
                    <span data-thread-help i18n="@@vendor.threads.row.help"
                      >AEC Integrations was asked to look</span
                    >
                  }
                </p>
              </li>
            }
          </ol>

          @if (pageCount() > 1) {
            <nav class="mt-6 flex items-center gap-3" [attr.aria-label]="pagingLabel">
              <button
                type="button"
                [class]="secondaryClass"
                [disabled]="page() <= 1"
                (click)="goToPage(page() - 1)"
                i18n="@@vendor.threads.page.prev"
              >
                Previous
              </button>
              <span class="text-sm text-(--text-secondary)" data-threads-page>{{
                pageLabel()
              }}</span>
              <button
                type="button"
                [class]="secondaryClass"
                [disabled]="page() >= pageCount()"
                (click)="goToPage(page() + 1)"
                i18n="@@vendor.threads.page.next"
              >
                Next
              </button>
            </nav>
          }
        }
      }
    </section>
  `,
})
export class VendorThreadsPage {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  protected readonly statuses = VENDOR_THREAD_LIST_STATUSES;
  /** The filter and page of the rows ON SCREEN. They move only when a read lands. */
  protected readonly page = signal(1);
  protected readonly status = signal<VendorThreadListStatus>('all');
  protected readonly response = signal<ListVendorThreadsResponse | null>(null);
  protected readonly state = signal<'loading' | 'loaded' | 'failed'>('loading');
  protected readonly refreshing = signal(false);

  /** The read in flight, or the one on screen once it lands or fails. */
  private target: ThreadsTarget = { status: 'all', page: 1 };
  /** The read that failed last. "Try again" repeats it. */
  private failedTarget: ThreadsTarget | null = null;
  private ticket = 0;

  protected readonly items = computed(() => this.response()?.data ?? []);
  protected readonly pageCount = computed(() => {
    const r = this.response();
    return r ? Math.max(1, Math.ceil(r.total / r.perPage)) : 1;
  });
  protected readonly pageLabel = computed(
    () =>
      $localize`:@@vendor.threads.page.label:Page ${this.page()}:PAGE: of ${this.pageCount()}:COUNT:`,
  );
  protected readonly pagingLabel = $localize`:@@vendor.threads.page.aria:Conversation pages`;
  protected readonly filterLabel = $localize`:@@vendor.threads.filter.aria:Show conversations`;

  protected readonly emptyMessage = computed(() =>
    this.status() === 'all'
      ? $localize`:@@vendor.threads.empty:No conversations yet. When your company or another company writes about a data row, the conversation shows here.`
      : $localize`:@@vendor.threads.empty.filtered:No conversation matches that filter.`,
  );

  constructor() {
    // Browser only: the list is per-seat data, never part of the cached SSR shell.
    afterNextRender(() => void this.load(this.target, { announce: false }));

    // The `threads` cursor moved: re-read the page on screen quietly. The first run
    // is the baseline.
    let seen: number | null = null;
    effect(() => {
      const revision = this.store.threadsRevision();
      if (seen === null) {
        seen = revision;
        return;
      }
      if (revision === seen) return;
      seen = revision;
      untracked(() => {
        if (this.response()) void this.load(this.target, { announce: false });
      });
    });
  }

  protected statusLabel(status: VendorThreadListStatus): string {
    switch (status) {
      case 'all':
        return $localize`:@@vendor.threads.filter.all:All`;
      case 'open':
        return $localize`:@@vendor.threads.filter.open:Open`;
      case 'closed':
        return $localize`:@@vendor.threads.filter.closed:Closed`;
    }
  }

  protected rowTitle(item: VendorThreadListItem): string {
    const company = item.counterparty.name;
    const data = item.data_object?.name;
    return data
      ? $localize`:@@vendor.threads.row.title:Conversation with ${company}:company: about ${data}:data:`
      : $localize`:@@vendor.threads.row.titleUnnamed:Conversation with ${company}:company: about a data row`;
  }

  protected stateLabel(item: VendorThreadListItem): string {
    return item.closed_at
      ? $localize`:@@vendor.threads.row.closed:Closed`
      : $localize`:@@vendor.threads.row.open:Open`;
  }

  protected activityLabel(item: VendorThreadListItem): string {
    const date = formatDay(item.last_activity_at);
    return $localize`:@@vendor.threads.row.activity:Last activity ${date}:date:`;
  }

  protected applyStatus(status: VendorThreadListStatus): void {
    if (status === this.target.status) return;
    void this.load({ status, page: 1 }, { announce: true });
  }

  protected goToPage(page: number): void {
    const next = Math.min(Math.max(1, page), this.pageCount());
    if (next === this.page() && next === this.target.page) return;
    void this.load({ status: this.status(), page: next }, { announce: true });
  }

  protected reload(): void {
    void this.load(this.failedTarget ?? this.target, { announce: this.response() !== null });
  }

  /** Read one page. A newer read always wins, and the filter and page commit only
   *  with a response, as on the Changes page. */
  private async load(target: ThreadsTarget, { announce }: { announce: boolean }): Promise<void> {
    const ticket = ++this.ticket;
    this.target = target;
    this.failedTarget = null;
    const quiet = this.response() !== null;
    if (quiet) this.refreshing.set(true);
    else this.state.set('loading');
    try {
      const res = await this.api.listThreads(target.page, VENDOR_THREADS_PAGE_SIZE, target.status);
      if (ticket !== this.ticket) return;
      const last = Math.max(1, Math.ceil(res.total / res.perPage));
      if (target.page > last) {
        // The list shrank under us: read the new last page instead.
        void this.load({ status: target.status, page: last }, { announce });
        return;
      }
      this.response.set(res);
      this.status.set(target.status);
      this.page.set(target.page);
      this.state.set('loaded');
      if (announce) this.announcer.announce(this.shownMessage(res));
    } catch {
      if (ticket !== this.ticket) return;
      this.target = { status: this.status(), page: this.page() };
      this.failedTarget = target;
      this.state.set('failed');
    } finally {
      if (ticket === this.ticket) this.refreshing.set(false);
    }
  }

  /** What the portal's one live region says once a filter or page change lands. */
  private shownMessage(res: ListVendorThreadsResponse): string {
    const filter = this.statusLabel(this.status());
    if (res.total === 0) {
      return $localize`:@@vendor.threads.live.empty:${filter}:FILTER:: no conversations to show.`;
    }
    return $localize`:@@vendor.threads.live.shown:${filter}:FILTER:, page ${this.page()}:PAGE: of ${this.pageCount()}:COUNT:.`;
  }

  /** The Changes page's filter chip. The pressed colours are the unlayered
   *  `.aec-period[aria-pressed='true']` rule in `styles.css`. */
  protected readonly chipClass =
    'aec-period inline-flex min-h-8 cursor-pointer items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-2.5 py-1 text-xs font-semibold text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  /** Disabled is a surface swap, never opacity (DESIGN.md, AECI-982). */
  protected readonly secondaryClass =
    'inline-flex min-h-10 items-center justify-center gap-2 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
}
