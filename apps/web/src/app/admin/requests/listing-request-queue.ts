import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';

import type { AdminListingRequest } from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { AdminSummaryStore } from '../admin-summary.store';
import { planInterestLabel } from '../claims/plan-interest-label';
import { AdminRequestsApi } from './admin-requests-api';

/** One request covers the backlog. The API caps `perPage` at 100. */
const PAGE_SIZE = 100;

type StatusFilter = 'open' | 'resolved' | 'rejected';

/**
 * Listing requests (AECI-1293, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.5): the second
 * section of `/admin/requests`. A visitor typed a product or company into the claim
 * dialog because the catalog does not list it. Each row shows what they typed, who
 * they are, their plan answer and comments, with Resolve and Reject.
 *
 * Resolving does not create the listing. The operator adds it upstream (the review
 * app, then promote) and emails the submitter to claim it; the support alert's
 * reply-to is the submitter, so that is one reply.
 *
 * The visitor-typed website renders as text with a separate new-tab link, `https://`
 * only by the schema, and `rel="noopener noreferrer nofollow"`, the posture of the
 * correction queue's source link. The list loads client-side in `afterNextRender`,
 * like the corrections above it. A resolve or reject of an open row decrements the
 * Requests badge, which counts open corrections plus open listing requests.
 */
@Component({
  selector: 'aec-listing-request-queue',
  imports: [DatePipe, NewTabIcon],
  host: { class: 'mt-14 block' },
  template: `
    <section aria-labelledby="admin-listing-requests-heading" data-testid="listing-request-queue">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id="admin-listing-requests-heading"
            class="text-lg font-bold text-(--text-primary)"
            i18n="@@admin.listingRequests.heading"
          >
            Listing requests
          </h2>
          <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@admin.listingRequests.lede">
            Products and companies a visitor asked us to add, so they can claim them. Add the
            listing, then reply to the alert email to tell them it is ready.
          </p>
        </div>
        <div
          role="group"
          aria-labelledby="admin-listing-requests-heading"
          class="inline-flex flex-wrap gap-1 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-1"
        >
          @for (opt of statusOptions; track opt.key) {
            <button
              type="button"
              (click)="setStatus(opt.key)"
              [attr.aria-pressed]="status() === opt.key"
              class="rounded-(--radius-sm) px-3 py-1 text-xs font-bold text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) aria-pressed:bg-(--accent-primary) aria-pressed:text-(--surface-base)"
            >
              {{ opt.label }}
            </button>
          }
        </div>
      </div>

      <p class="sr-only" role="status" aria-live="polite">{{ liveMessage() }}</p>

      @if (loading()) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@admin.listingRequests.loading">
          Loading listing requests…
        </p>
      } @else if (loadFailed()) {
        <p class="mt-6 text-sm font-medium text-(--text-primary)" role="alert">
          <span i18n="@@admin.listingRequests.loadFailed">We couldn't load listing requests.</span>
          {{ ' ' }}
          <button
            type="button"
            (click)="load()"
            class="font-semibold text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@admin.requests.retry"
          >
            Try again
          </button>
        </p>
      } @else if (rows().length === 0) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@admin.listingRequests.empty">
          No listing requests match this filter.
        </p>
      } @else {
        @if (truncated()) {
          <p
            class="mt-6 text-xs text-(--text-secondary)"
            data-testid="listing-requests-capped"
            i18n="@@admin.listingRequests.cappedNote"
          >
            Showing the first {{ rows().length }} of {{ total() }} listing requests. Moderate these
            to see the rest.
          </p>
        }
        <ul role="list" class="mt-6 space-y-5">
          @for (r of rows(); track r.id) {
            <li>
              <article
                [attr.aria-labelledby]="'listing-request-' + r.id"
                class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-6"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <h3
                    [id]="'listing-request-' + r.id"
                    class="text-base font-bold text-(--text-primary)"
                  >
                    {{ r.listing_name }}
                  </h3>
                  <span class="shrink-0 text-xs text-(--text-secondary)">{{
                    r.created_at | date: 'medium'
                  }}</span>
                </div>
                <dl
                  class="mt-3 grid gap-x-6 gap-y-1 text-xs text-(--text-secondary) sm:grid-cols-2"
                >
                  <div class="flex flex-wrap gap-1.5">
                    <dt class="font-bold" i18n="@@admin.listingRequests.website">Website</dt>
                    <dd class="break-all">
                      {{ r.website }}
                      <a
                        [href]="r.website"
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        class="ms-1 inline-flex items-center gap-1 font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        ><span i18n="@@admin.listingRequests.open">Open</span> <aec-new-tab-icon
                      /></a>
                    </dd>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    <dt class="font-bold" i18n="@@admin.requests.meta.submitter">Submitter</dt>
                    <dd>
                      {{ r.submitter_email }}
                      @if (r.submitter_name) {
                        <span> · {{ r.submitter_name }}</span>
                      }
                      @if (r.submitter_role) {
                        <span> · {{ r.submitter_role }}</span>
                      }
                    </dd>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    <dt class="font-bold" i18n="@@admin.claims.meta.planInterest">Plan interest</dt>
                    <dd>{{ planInterestLabel(r.plan_interest) }}</dd>
                  </div>
                  @if (r.submitter_linkedin_url) {
                    <div class="flex flex-wrap gap-1.5">
                      <dt class="font-bold" i18n="@@admin.listingRequests.linkedin">LinkedIn</dt>
                      <dd>
                        <a
                          [href]="r.submitter_linkedin_url"
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          class="inline-flex items-center gap-1 font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          ><span i18n="@@admin.listingRequests.profile">Profile</span>
                          <aec-new-tab-icon
                        /></a>
                      </dd>
                    </div>
                  }
                </dl>
                @if (r.body) {
                  <div class="mt-4">
                    <p
                      class="text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
                      i18n="@@admin.claims.comments"
                    >
                      Comments
                    </p>
                    <p
                      class="mt-1 whitespace-pre-line text-sm leading-relaxed text-(--text-secondary)"
                    >
                      {{ r.body }}
                    </p>
                  </div>
                }
                @if (r.status === 'open') {
                  <div class="mt-5 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      (click)="moderate(r, 'resolve')"
                      [disabled]="pendingId() === r.id"
                      class="inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50"
                      i18n="@@admin.requests.resolve"
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      (click)="moderate(r, 'reject')"
                      [disabled]="pendingId() === r.id"
                      class="inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-5 py-2 text-sm font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50"
                      i18n="@@admin.requests.reject"
                    >
                      Reject
                    </button>
                  </div>
                  @if (failedId() === r.id) {
                    <p
                      class="mt-3 text-sm font-medium text-(--text-primary)"
                      role="alert"
                      i18n="@@admin.requests.action.failed"
                    >
                      Something went wrong. Please try again.
                    </p>
                  }
                }
              </article>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ListingRequestQueue {
  private readonly api = inject(AdminRequestsApi);
  private readonly summaryStore = inject(AdminSummaryStore);

  protected readonly planInterestLabel = planInterestLabel;
  protected readonly rows = signal<readonly AdminListingRequest[]>([]);
  /** The server's count for the filter. More than `rows` means the page is capped. */
  protected readonly total = signal(0);
  protected readonly truncated = computed(() => this.total() > this.rows().length);
  /** Bumped per `load()`, so a response for an earlier filter never lands last. */
  private loadSeq = 0;
  protected readonly status = signal<StatusFilter>('open');
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly pendingId = signal<string | null>(null);
  protected readonly failedId = signal<string | null>(null);
  protected readonly liveMessage = signal('');

  protected readonly statusOptions: ReadonlyArray<{ key: StatusFilter; label: string }> = [
    { key: 'open', label: $localize`:@@admin.requests.filter.status.open:Open` },
    { key: 'resolved', label: $localize`:@@admin.requests.filter.status.resolved:Resolved` },
    { key: 'rejected', label: $localize`:@@admin.requests.filter.status.rejected:Rejected` },
  ];

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const res = await this.api.listListingRequests({
        status: this.status(),
        page: 1,
        perPage: PAGE_SIZE,
      });
      if (seq !== this.loadSeq) return;
      this.rows.set(res.data);
      this.total.set(res.total);
    } catch {
      if (seq === this.loadSeq) this.loadFailed.set(true);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  protected setStatus(status: StatusFilter): void {
    if (this.status() === status) return;
    this.status.set(status);
    void this.load();
  }

  /** Resolve or reject. A 422 means another admin got there first: drop the row only. */
  protected async moderate(row: AdminListingRequest, action: 'resolve' | 'reject'): Promise<void> {
    if (this.pendingId()) return;
    this.failedId.set(null);
    this.pendingId.set(row.id);
    try {
      await this.api.moderateListingRequest(row.id, { action });
      this.drop(row.id);
      this.summaryStore.decrement('requests');
      this.liveMessage.set(
        action === 'resolve'
          ? $localize`:@@admin.listingRequests.announce.resolved:Listing request resolved.`
          : $localize`:@@admin.listingRequests.announce.rejected:Listing request rejected.`,
      );
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 422) {
        this.drop(row.id);
        this.liveMessage.set(
          $localize`:@@admin.requests.announce.alreadyModerated:That request was already moderated.`,
        );
      } else {
        this.failedId.set(row.id);
      }
    } finally {
      this.pendingId.set(null);
    }
  }

  private drop(id: string): void {
    this.rows.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
  }
}
