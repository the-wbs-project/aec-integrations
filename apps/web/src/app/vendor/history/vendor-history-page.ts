import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';

import type { ListVendorHistoryResponse, VendorHistoryItem, VendorHistoryKind } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi, vendorHistoryCsvUrl } from '../vendor-api';

import { VendorHistoryFollowUp } from './vendor-history-follow-up';
import {
  HISTORY_KIND_ORDER,
  describeHistoryAction,
  historyActorLabel,
  historyKindLabel,
  historyPlanLabel,
  humanizeField,
} from './vendor-history-labels';

/** One read: a filter and a page. */
interface HistoryTarget {
  readonly kind: VendorHistoryKind;
  readonly page: number;
}

/** Rows per page. */
export const VENDOR_HISTORY_PAGE_SIZE = 25;

/**
 * `…/history`, the portal's Changes page (AECI-1160, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.19). INTERIM: the per-URL search follow-up column waits on AECI-1187.
 *
 * One page of `GET /api/vendor/history` (AECI-1194), newest first: what changed on
 * the vendor's listing, who changed it, and, on an AECi row, the reason AECi gave.
 * Every plan sees it. The API is ungated and so is this page.
 *
 * Anchor reference: Customer.io's workspace audit log
 * (mobbin.com/screens/5e4f44d9-4c65-4381-8681-d2921df2591e). One sentence per
 * event, the timestamp at the row's end, filters above, export at the top.
 *
 * Read-only and historical. No live cursor: a row, once written, never changes,
 * so a vendor who wants the newest rows reloads or changes the filter.
 */
@Component({
  selector: 'aec-vendor-history-page',
  imports: [DatePipe, VendorHistoryFollowUp],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="vendor-history-heading" data-vendor-history>
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="max-w-[52ch] space-y-2">
          <h2 id="vendor-history-heading" class="m-0">
            <!-- The size lives on the span: styles.css sizes h2 outside any cascade layer. -->
            <span
              class="block font-display text-xl font-semibold text-(--text-primary)"
              i18n="@@vendor.history.heading"
              >Changes</span
            >
          </h2>
          <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.history.intro">
            Every change to your company, products, integrations and seats, newest first. It shows
            who made each change: your team, AECi, or an automatic process.
          </p>
        </div>
        <a [href]="csvUrl()" download [class]="secondaryClass" data-history-csv>
          <svg
            aria-hidden="true"
            class="size-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 3v12" />
            <polyline points="7 10 12 15 17 10" />
            <path d="M5 21h14" />
          </svg>
          <span i18n="@@vendor.history.csv">Download CSV</span>
        </a>
      </div>

      <div
        class="mt-4 max-w-[52ch] space-y-1 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4 text-sm leading-relaxed text-(--text-primary)"
        data-history-banner
      >
        <p i18n="@@vendor.history.banner.start">
          This list starts when change history began. Changes made before then are not listed.
        </p>
        <p class="text-(--text-secondary)" i18n="@@vendor.history.banner.search">
          Search engines decide when they crawl your pages and what they show. A change here is not
          a promise about search results.
        </p>
      </div>

      <div
        class="mt-6 flex flex-wrap gap-2"
        role="group"
        [attr.aria-label]="filterLabel"
        data-history-filter
      >
        @for (k of kinds; track k) {
          <button
            type="button"
            [class]="chipClass"
            [attr.aria-pressed]="kind() === k"
            [attr.data-kind]="k"
            (click)="applyKind(k)"
          >
            {{ kindLabel(k) }}
          </button>
        }
      </div>

      @if (state() === 'failed' && !response()) {
        <div class="mt-6 space-y-2" data-history-failed>
          <!-- The alert wraps the sentence only, so the retry button is not read out with it. -->
          <p class="text-sm text-(--text-primary)" role="alert" i18n="@@vendor.history.failed">
            Could not load your change history.
          </p>
          <button
            type="button"
            [class]="secondaryClass"
            (click)="reload()"
            i18n="@@vendor.history.retry"
          >
            Try again
          </button>
        </div>
      } @else if (!response()) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.history.loading">
          Loading changes…
        </p>
      } @else {
        @if (state() === 'failed') {
          <div
            class="mt-4 flex max-w-[52ch] flex-wrap items-center gap-3 text-sm text-(--text-primary)"
            data-history-refresh-failed
          >
            <span role="alert" i18n="@@vendor.history.refreshFailed"
              >Could not refresh the list. It shows what was loaded last.</span
            >
            <button
              type="button"
              [class]="secondaryClass"
              (click)="reload()"
              i18n="@@vendor.history.retry"
            >
              Try again
            </button>
          </div>
        }

        @if (items().length === 0) {
          <p class="mt-6 max-w-[52ch] text-sm text-(--text-secondary)" data-history-empty>
            {{ emptyMessage() }}
          </p>
        } @else {
          <ol
            class="mt-6 divide-y divide-(--border-default) rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised)"
            [attr.aria-busy]="refreshing() ? 'true' : null"
          >
            @for (item of items(); track item.id) {
              <li
                class="px-5 py-4"
                [attr.data-history-row]="item.id"
                [attr.data-actor]="item.actor_kind"
              >
                <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
                  <p class="min-w-0 break-words text-sm text-(--text-primary)">
                    <span class="font-semibold" data-history-action>{{
                      actionLabel(item.action)
                    }}</span>
                    @if (item.entity_name) {
                      <span class="text-(--text-secondary)">: </span>
                      <span data-history-entity>{{ item.entity_name }}</span>
                    }
                  </p>
                  <time
                    class="shrink-0 text-xs text-(--text-secondary) tabular-nums"
                    [attr.datetime]="item.at"
                    >{{ item.at | date: 'MMM d, y, h:mm a' }}</time
                  >
                </div>

                <dl class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-(--text-secondary)">
                  <div class="flex gap-1">
                    <dt i18n="@@vendor.history.row.who">By</dt>
                    <dd class="font-medium text-(--text-primary)" data-history-actor>
                      {{ actorLabel(item) }}
                    </dd>
                  </div>
                  @if (item.plan; as plan) {
                    <div class="flex gap-1" data-history-plan>
                      <dt i18n="@@vendor.history.row.plan">Plan at the time</dt>
                      <dd class="font-medium text-(--text-primary)">{{ planLabel(item) }}</dd>
                    </div>
                  }
                  @if (item.fields.length > 0) {
                    <div class="flex gap-1" data-history-fields>
                      <dt i18n="@@vendor.history.row.fields">Changed</dt>
                      <dd class="text-(--text-primary)">{{ fieldsLabel(item) }}</dd>
                    </div>
                  }
                </dl>

                @if (item.actor_kind === 'aeci' && item.reason) {
                  <div class="mt-3 max-w-[52ch] border-s-2 ps-3 text-sm" data-history-reason>
                    <p
                      class="text-xs font-semibold text-(--text-secondary)"
                      i18n="@@vendor.history.reason.label"
                    >
                      Reason from AECi
                    </p>
                    <p class="mt-1 whitespace-pre-line break-words text-(--text-primary)">
                      {{ item.reason }}
                    </p>
                  </div>
                }

                <aec-vendor-history-follow-up [item]="item" />
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
                i18n="@@vendor.history.page.prev"
              >
                Previous
              </button>
              <span class="text-sm text-(--text-secondary)" data-history-page>{{
                pageLabel()
              }}</span>
              <button
                type="button"
                [class]="secondaryClass"
                [disabled]="page() >= pageCount()"
                (click)="goToPage(page() + 1)"
                i18n="@@vendor.history.page.next"
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
export class VendorHistoryPage {
  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);

  protected readonly kinds = HISTORY_KIND_ORDER;
  /**
   * The filter and page of the rows ON SCREEN. They move only when a read lands,
   * so the pressed chip and the page label always describe the visible rows. A
   * failed re-read leaves them, and the rows, as they were.
   */
  protected readonly page = signal(1);
  protected readonly kind = signal<VendorHistoryKind>('all');
  protected readonly response = signal<ListVendorHistoryResponse | null>(null);
  protected readonly state = signal<'loading' | 'loaded' | 'failed'>('loading');
  protected readonly refreshing = signal(false);

  /** The read in flight, or the one on screen once it lands or fails. */
  private target: HistoryTarget = { kind: 'all', page: 1 };
  /** The read that failed last. "Try again" repeats it. */
  private failedTarget: HistoryTarget | null = null;
  private ticket = 0;

  protected readonly items = computed(() => this.response()?.data ?? []);
  protected readonly pageCount = computed(() => {
    const r = this.response();
    return r ? Math.max(1, Math.ceil(r.total / r.perPage)) : 1;
  });
  protected readonly pageLabel = computed(
    () =>
      $localize`:@@vendor.history.page.label:Page ${this.page()}:PAGE: of ${this.pageCount()}:COUNT:`,
  );
  protected readonly pagingLabel = $localize`:@@vendor.history.page.aria:Change history pages`;
  protected readonly filterLabel = $localize`:@@vendor.history.filter.aria:Show changes by`;

  /** The CSV twin of what is on screen: same filter, every page. */
  protected readonly csvUrl = computed(() => vendorHistoryCsvUrl({ kind: this.kind() }));

  protected readonly emptyMessage = computed(() =>
    this.kind() === 'all'
      ? $localize`:@@vendor.history.empty:No changes yet. When your team or AECi changes your listing, it shows here.`
      : $localize`:@@vendor.history.empty.filtered:No change matches that filter.`,
  );

  constructor() {
    // Browser only: the list is per-seat data, never part of the cached SSR shell.
    afterNextRender(() => void this.load(this.target, { announce: false }));
  }

  protected actionLabel(action: string): string {
    return describeHistoryAction(action);
  }

  protected actorLabel(item: VendorHistoryItem): string {
    return historyActorLabel(item.actor_kind);
  }

  protected planLabel(item: VendorHistoryItem): string {
    return item.plan ? historyPlanLabel(item.plan) : '';
  }

  protected fieldsLabel(item: VendorHistoryItem): string {
    return item.fields.map(humanizeField).join(', ');
  }

  protected kindLabel(kind: VendorHistoryKind): string {
    return historyKindLabel(kind);
  }

  protected applyKind(kind: VendorHistoryKind): void {
    if (kind === this.target.kind) return;
    void this.load({ kind, page: 1 }, { announce: true });
  }

  protected goToPage(page: number): void {
    const next = Math.min(Math.max(1, page), this.pageCount());
    if (next === this.page() && next === this.target.page) return;
    void this.load({ kind: this.kind(), page: next }, { announce: true });
  }

  protected reload(): void {
    void this.load(this.failedTarget ?? this.target, { announce: this.response() !== null });
  }

  /**
   * Read one page. With rows on screen the read is quiet: the list stays put
   * until the answer lands. A newer read always wins. `kind` and `page` commit
   * only with a response, so a failure cannot leave them describing other rows.
   */
  private async load(target: HistoryTarget, { announce }: { announce: boolean }): Promise<void> {
    const ticket = ++this.ticket;
    this.target = target;
    this.failedTarget = null;
    const quiet = this.response() !== null;
    if (quiet) this.refreshing.set(true);
    else this.state.set('loading');
    try {
      const res = await this.api.listHistory(target.page, VENDOR_HISTORY_PAGE_SIZE, {
        kind: target.kind,
      });
      if (ticket !== this.ticket) return;
      const last = Math.max(1, Math.ceil(res.total / res.perPage));
      if (target.page > last) {
        // The list shrank under us: read the new last page instead.
        void this.load({ kind: target.kind, page: last }, { announce });
        return;
      }
      this.response.set(res);
      this.kind.set(target.kind);
      this.page.set(target.page);
      this.state.set('loaded');
      if (announce) this.announcer.announce(this.shownMessage(res));
    } catch {
      if (ticket !== this.ticket) return;
      // Roll the request back to what is on screen. The chips stay honest, and
      // pressing the same chip again re-reads it.
      this.target = { kind: this.kind(), page: this.page() };
      this.failedTarget = target;
      this.state.set('failed');
    } finally {
      if (ticket === this.ticket) this.refreshing.set(false);
    }
  }

  /** What the portal's one live region says once a filter or page change lands. */
  private shownMessage(res: ListVendorHistoryResponse): string {
    const filter = historyKindLabel(this.kind());
    if (res.total === 0) {
      return $localize`:@@vendor.history.live.empty:${filter}:FILTER:: no changes to show.`;
    }
    return $localize`:@@vendor.history.live.shown:${filter}:FILTER:, page ${this.page()}:PAGE: of ${this.pageCount()}:COUNT:.`;
  }

  /** The integrations tab's filter chip. The pressed colours are the unlayered
   *  `.aec-period[aria-pressed='true']` rule in `styles.css`. */
  protected readonly chipClass =
    'aec-period inline-flex min-h-8 cursor-pointer items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-2.5 py-1 text-xs font-semibold text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  /** Disabled is a surface swap, never opacity (DESIGN.md, AECI-982). */
  protected readonly secondaryClass =
    'inline-flex min-h-10 items-center justify-center gap-2 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
}
