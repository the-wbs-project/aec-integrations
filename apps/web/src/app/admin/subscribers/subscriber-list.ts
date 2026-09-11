import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Title } from '@angular/platform-browser';

import {
  ADMIN_SUBSCRIBER_SORT_DEFAULT_ORDER,
  type AdminSubscriberRow,
  type AdminSubscriberStatusFilter,
  type AdminSubscribersSort,
  type SortOrder,
} from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { SortHeader } from '../../shared/sort-header/sort-header';
import { AdminSubscribersApi } from './admin-subscribers-api';

/**
 * Rows per page. The shared `PageQuerySchema` default, and unchanged from it on
 * purpose: unlike `/admin/users` — where every row costs a GoTrue round trip and
 * 24 is exactly four waves — a subscriber row is one D1 column set with no seam
 * behind it, so there is nothing here to tune the number against.
 */
const PER_PAGE = 24;

/**
 * `/admin/subscribers` — the mailing-list roster. AECI-859 / Phase 8.3 P5.2.
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.4.
 *
 * **The screen that answers "who is on the list, and when did they join".**
 * `/admin/audience` (AECI-586) has reported the mailing list since Phase 8.3, but
 * only in aggregate — a count, a growth line, a churn rate, UTM and geography
 * breakdowns. None of those can be read down to a person, so until now the only
 * way to see an individual subscriber was to query D1 directly.
 *
 * Rendered in the `AdminShell` layout's outlet, so the gate and nav SSR via
 * `adminSummaryResolver` on the parent route. This page paints its shell during
 * SSR and fetches in `afterNextRender` — the same-origin read carries the session
 * cookie, which the API Worker's `requireAdmin()` verifies. Same shape as
 * `UserList` (AECI-692), whose table, filters and sort controls this reuses
 * wholesale rather than inventing a second idiom for the same job.
 *
 * ─── Three things this screen is careful about ───────────────────────────────
 *
 * **1. It shows people who left, and says so per row.** The default filter is
 * "everyone", not "active". `unsubscribed_at` is a soft delete — the row stays
 * forever as a suppression record (AECI-537) — so an unsubscribed person is still
 * a fact about the list, and hiding them by default would make the roster
 * disagree with the lifetime `total_ever` printed above it. The `status` column
 * is the disclosure that makes showing them safe.
 *
 * **2. There is no opt-out control, and there should not be one.** The only
 * writer of `unsubscribed_at` is the subscriber, through the tokenized
 * `POST /api/unsubscribe`. An operator button here would let the console suppress
 * a consent record with no evidence the person asked for it, which is a different
 * act from honouring an unsubscribe even though it writes the same column.
 *
 * **3. Empty and "no matches" are different sentences.** A list with no
 * subscribers at all is a state of the product; a filter that matched nothing is
 * a state of the query. Collapsing them would tell an operator who typed a typo
 * that nobody has ever signed up. Same distinction `UserList` draws, applied to a
 * table whose empty case is the one that has actually been live.
 */
@Component({
  selector: 'aec-subscriber-list',
  imports: [RouterLink, AdminPaginator, AecSelect, SortHeader, DatePipe],
  templateUrl: './subscriber-list.html',
})
export class SubscriberList {
  private readonly api = inject(AdminSubscribersApi);
  private readonly titleSvc = inject(Title);

  protected readonly subscribers = signal<readonly AdminSubscriberRow[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly perPage = PER_PAGE;

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /** Lifetime stocks, unfiltered — the numbers the intro line quotes. They come
   *  from the same `subscriberTotals()` the Audience screen renders, so the two
   *  screens cannot disagree about how many people are on the list. */
  protected readonly activeTotal = signal(0);
  protected readonly unsubscribedTotal = signal(0);
  protected readonly lifetimeTotal = signal(0);

  /** The committed search term — what was last SENT, not what is being typed. A
   *  keystroke-per-request search over a `LIKE '%…%'` scan would be a lot of
   *  scans to answer a question the operator has not finished asking. */
  protected readonly search = signal('');
  protected readonly searchDraft = signal('');

  protected readonly status = signal<AdminSubscriberStatusFilter>('all');

  /** The active sort key, and its direction. Component state, not a URL
   *  parameter: this screen takes no incoming links that need to arrive sorted,
   *  and a two-way binding would put a `Router.navigate` on every header click
   *  so the back button walked the operator through their own sort history. */
  protected readonly sort = signal<AdminSubscribersSort>('created_at');
  protected readonly order = signal<SortOrder>(ADMIN_SUBSCRIBER_SORT_DEFAULT_ORDER['created_at']);

  protected readonly statusOptions: readonly AecSelectOption[] = [
    { value: 'all', label: $localize`:@@admin.subscribers.filter.status.all:Everyone` },
    { value: 'active', label: $localize`:@@admin.subscribers.filter.status.active:Subscribed` },
    {
      value: 'unsubscribed',
      label: $localize`:@@admin.subscribers.filter.status.unsubscribed:Unsubscribed`,
    },
  ];

  /** Nobody has ever signed up. A state of the product, not of the query — see
   *  the class doc, point 3. */
  protected readonly isEmpty = computed(() => !this.loading() && this.lifetimeTotal() === 0);

  /** Rows exist, and this filter matched none of them. */
  protected readonly noMatches = computed(
    () => !this.loading() && this.lifetimeTotal() > 0 && this.subscribers().length === 0,
  );

  constructor() {
    this.titleSvc.setTitle(
      $localize`:@@admin.subscribers.metaTitle:Subscribers · Admin · AEC Integrations`,
    );
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

  /** Live for the active column, natural for the other — read from the SHARED
   *  map so the arrow cannot disagree with the server's ORDER BY. The two keys
   *  have DIFFERENT natural directions (newest first, but A before Z), which is
   *  exactly why the map is shared rather than restated here. */
  protected directionFor(key: AdminSubscribersSort): 'ascending' | 'descending' {
    const order = key === this.sort() ? this.order() : ADMIN_SUBSCRIBER_SORT_DEFAULT_ORDER[key];
    return order === 'asc' ? 'ascending' : 'descending';
  }

  protected onSortChange(change: { key: string; order: 'asc' | 'desc' }): void {
    this.sort.set(change.key as AdminSubscribersSort);
    this.order.set(change.order);
    this.refilter();
  }

  protected onStatusChange(value: string | null): void {
    this.status.set((value as AdminSubscriberStatusFilter | null) ?? 'all');
    this.refilter();
  }

  protected goToPage(page: number): void {
    this.page.set(page);
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  /** Any filter change: back to page 1, then refetch. Without it, narrowing a
   *  filter while on page 6 lands the operator on an empty page that looks like
   *  "no results". */
  private refilter(): void {
    this.page.set(1);
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const search = this.search();
      const status = this.status();
      const response = await this.api.listSubscribers({
        page: this.page(),
        perPage: this.perPage,
        sort: this.sort(),
        order: this.order(),
        ...(search ? { search } : {}),
        ...(status === 'all' ? {} : { status }),
      });
      this.subscribers.set(response.data);
      this.total.set(response.total);
      this.activeTotal.set(response.subscribers.active);
      this.unsubscribedTotal.set(response.subscribers.unsubscribed);
      this.lifetimeTotal.set(response.subscribers.total_ever);
      this.liveMessage.set(
        $localize`:@@admin.subscribers.announce.loaded:${response.total}:COUNT: subscribers match.`,
      );
    } catch {
      this.loadFailed.set(true);
      this.subscribers.set([]);
      this.total.set(0);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * The campaign that brought them in, as one line.
   *
   * Empty string, not a placeholder, when nothing was captured: the template
   * renders the "Direct" case itself so the words stay translatable in the file
   * that owns the rest of this screen's copy. An organic signup with no `utm_*`
   * is a real signup, which is why it gets a word rather than a dash.
   */
  protected sourceLabel(row: AdminSubscriberRow): string {
    return [row.utm_source, row.utm_medium, row.utm_campaign].filter(Boolean).join(' · ');
  }

  /** Country, region and city, most specific first, skipping whatever is absent. */
  protected placeLabel(row: AdminSubscriberRow): string {
    return [row.city, row.region, row.country].filter(Boolean).join(', ');
  }
}
