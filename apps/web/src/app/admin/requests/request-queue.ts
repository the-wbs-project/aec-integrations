import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';

import type { AdminVendorRequest, ListVendorRequestsQuery } from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminRequestsApi } from './admin-requests-api';

/** One request covers a launch-scale moderation backlog. The API caps `perPage`
 *  at 100; we load the max and surface a note if the server reports more. */
const QUEUE_PAGE_SIZE = 100;

type StatusFilter = 'open' | 'resolved' | 'rejected';

/**
 * AECI-217 / Phase 6.10 — the admin vendor-request moderation queue, rendered in
 * the `AdminShell` layout's outlet at `/admin/requests`. The corrections sibling
 * of `/admin/reviews` (AECI-205) and of `/admin/claims` (AECI-521).
 *
 * Like the reviews queue, the gate + nav SSR via `adminSummaryResolver` (the parent
 * route), so this queue paints its shell during SSR and fetches the list
 * client-side in `afterNextRender` — the same-origin `GET /api/admin/requests`
 * carries the session cookie, which the API Worker's `requireAdmin()` verifies. It
 * never reads cookies or session state directly.
 *
 * The `status` filter is a query param re-fetched server-side (newest-first, with
 * `is_duplicate` / `target` hydration computed by the API). Resolve is a
 * one-click `PATCH`; reject reveals an OPTIONAL reason (the 6.9 API makes it
 * optional for both actions, unlike reviews). A successful action drops the row
 * (it leaves the `open` view) and decrements `AdminSummaryStore`, so the nav
 * badge ticks down without a round-trip.
 *
 * ── THIS QUEUE IS CORRECTIONS ONLY (AECI-922) ────────────────────────────────
 * It carried a `kind` filter — All kinds / Claims / Corrections — defaulting to
 * All, which made it a superset of `/admin/claims`. That was survivable while
 * neither screen had a counter. It stopped being survivable when both got one:
 * the nav shows a count per Operations screen and their SUM on the category
 * trigger, and a Requests count that included claims would put every open claim
 * into that sum twice.
 *
 * So the request always pins `kind: 'correction'` and the filter is gone. Claims
 * are not hidden — `/admin/claims` is the richer surface for them, with duplicate
 * detection, the product-role breakdown, the operator note and the grant/reject
 * actions this screen's generic resolve/reject cannot express. Nothing here could
 * do to a claim what that screen does.
 */
@Component({
  selector: 'aec-request-queue',
  imports: [DatePipe, NewTabIcon, RouterLink],
  templateUrl: './request-queue.html',
})
export class RequestQueue {
  private readonly api = inject(AdminRequestsApi);
  private readonly summaryStore = inject(AdminSummaryStore);

  /** The loaded requests (server order: newest-first). */
  private readonly requests = signal<readonly AdminVendorRequest[]>([]);
  /** Total matching the current filter reported by the server (may exceed loaded). */
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the request whose action is in flight (disables its buttons). */
  protected readonly pendingActionId = signal<string | null>(null);
  /** Id of the request whose reject form is open (one at a time). */
  protected readonly rejectingId = signal<string | null>(null);
  /** The optional reject reason (the API stores it in the audit/transition only). */
  protected readonly rejectReason = signal('');
  /** Id of the request whose last action failed (inline retryable alert). */
  protected readonly failedAction = signal<string | null>(null);
  /** Polite live-region message — the row vanishes on success, so announce it. */
  protected readonly liveMessage = signal('');

  protected readonly statusFilter = signal<StatusFilter>('open');

  protected readonly statusOptions: ReadonlyArray<{ key: StatusFilter; label: string }> = [
    { key: 'open', label: $localize`:@@admin.requests.filter.status.open:Open` },
    { key: 'resolved', label: $localize`:@@admin.requests.filter.status.resolved:Resolved` },
    { key: 'rejected', label: $localize`:@@admin.requests.filter.status.rejected:Rejected` },
  ];

  protected readonly visibleRequests = computed(() => this.requests());
  protected readonly loadedCount = computed(() => this.requests().length);
  /** True when the server reports more rows than we loaded (note shown). */
  protected readonly truncated = computed(() => this.total() > this.requests().length);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    const query: Partial<ListVendorRequestsQuery> = {
      kind: 'correction',
      status: this.statusFilter(),
      page: 1,
      perPage: QUEUE_PAGE_SIZE,
    };
    try {
      const res = await this.api.listRequests(query);
      this.requests.set(res.data);
      this.total.set(res.total);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected retry(): void {
    void this.load();
  }

  protected setStatus(status: StatusFilter): void {
    if (this.statusFilter() === status) return;
    this.statusFilter.set(status);
    this.closeReject();
    void this.load();
  }

  /** Only open / in-review rows can be moderated; terminal rows are read-only. */
  protected isActionable(status: AdminVendorRequest['status']): boolean {
    return status === 'open' || status === 'in_review';
  }

  /** Relative age (e.g. "3 d", "5 h", "12 min"). Browser-only — the list is empty
   *  during SSR, so `Date.now()` is never read server-side. */
  protected age(createdAt: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
    if (minutes < 60) return $localize`:@@admin.requests.age.minutes:${minutes}:COUNT: min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@admin.requests.age.hours:${hours}:COUNT: h`;
    const days = Math.floor(hours / 24);
    return $localize`:@@admin.requests.age.days:${days}:COUNT: d`;
  }

  protected statusLabel(status: AdminVendorRequest['status']): string {
    switch (status) {
      case 'open':
        return $localize`:@@admin.requests.status.open:Open`;
      case 'in_review':
        return $localize`:@@admin.requests.status.inReview:In review`;
      case 'resolved':
        return $localize`:@@admin.requests.status.resolved:Resolved`;
      case 'rejected':
        return $localize`:@@admin.requests.status.rejected:Rejected`;
    }
  }

  /** Non-linked fallback label when the target row is missing (deleted/un-promoted). */
  protected targetFallbackLabel(type: AdminVendorRequest['target_type']): string {
    return type === 'product'
      ? $localize`:@@admin.requests.target.unknownProduct:Unknown product`
      : $localize`:@@admin.requests.target.unknownVendor:Unknown vendor`;
  }

  /** Detail route base for a target — the discriminator picks products vs vendors. */
  protected targetRouterLink(r: AdminVendorRequest): string[] | null {
    if (!r.target) return null;
    return r.target_type === 'product' ? ['/products', r.target.slug] : ['/vendors', r.target.slug];
  }

  // ── Moderation actions ─────────────────────────────────────────────────────

  protected async resolve(id: string): Promise<void> {
    await this.moderate(
      id,
      { action: 'resolve' },
      $localize`:@@admin.requests.announce.resolved:Request resolved.`,
    );
  }

  /** Open the inline reject form for a row (clears the shared optional-reason field). */
  protected openReject(id: string): void {
    this.failedAction.set(null);
    this.rejectReason.set('');
    this.rejectingId.set(id);
  }

  protected closeReject(): void {
    this.rejectingId.set(null);
    this.rejectReason.set('');
  }

  protected onReasonInput(event: Event): void {
    this.rejectReason.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirmReject(id: string): Promise<void> {
    const reason = this.rejectReason().trim();
    await this.moderate(
      id,
      { action: 'reject', ...(reason ? { reason } : {}) },
      $localize`:@@admin.requests.announce.rejected:Request rejected.`,
    );
  }

  /** Shared resolve/reject path: PATCH, then drop the moderated row (it leaves the
   *  `open` view), decrement the nav badge and announce. A 422 means another admin
   *  moderated it first — drop the row WITHOUT decrementing, since that admin's own
   *  action already did (and the count resyncs on the next full visit). Anything
   *  else is a retryable inline failure. */
  private async moderate(
    id: string,
    input: { action: 'resolve' | 'reject'; reason?: string },
    announcement: string,
  ): Promise<void> {
    if (this.pendingActionId()) return;
    // Read the status BEFORE the row is dropped. `pending_requests` counts `open`
    // corrections only, and `isActionable` also admits `in_review` — a status this
    // screen's filter cannot currently select, but decrementing on one would walk
    // the badge below the real backlog with nothing to resync it until the next
    // full visit to /admin.
    const wasOpen = this.requests().find((r) => r.id === id)?.status === 'open';
    this.failedAction.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.moderate(id, input);
      this.rejectingId.set(null);
      this.rejectReason.set('');
      this.removeRow(id);
      if (wasOpen) this.summaryStore.decrement('requests');
      this.liveMessage.set(announcement);
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 422) {
        this.removeRow(id);
        this.rejectingId.set(null);
        this.failedAction.set(null);
        this.liveMessage.set(
          $localize`:@@admin.requests.announce.alreadyModerated:That request was already moderated.`,
        );
      } else {
        this.failedAction.set(id);
      }
    } finally {
      this.pendingActionId.set(null);
    }
  }

  private removeRow(id: string): void {
    this.requests.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
  }
}
