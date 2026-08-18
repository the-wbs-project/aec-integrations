import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorNotification } from '@aeci/shared';

import { VendorApi } from '../vendor-api';

import { detectorTitle } from './vendor-attestation-labels';

/**
 * The in-portal notification list (AECI-606 rendering AECI-302's
 * `GET /api/vendor/notifications`; `STAGE_2_ATTESTATIONS_SPEC.md` §7.2 —
 * "surfaced on the §6 tab").
 *
 * ── WHY IT IS A COLLAPSED DISCLOSURE ────────────────────────────────────────
 * These rows are not live state. The endpoint reads the §7.3 `audit_log` ledger
 * of nudges that were **emailed**, over a 90-day window — "a historical record
 * of a nudge, and it stays accurate even after the underlying claim is
 * re-curated". Rendered prominently, a three-week-old "Vendors disagree" row
 * would sit above a lane whose badge now reads `confirmed`, and the surface
 * would visibly contradict itself. Collapsed, with the framing sentence inside,
 * it is a mail archive — which is what it is. Promoting this to a banner
 * reintroduces the contradiction.
 *
 * Fetches on its own through `VendorApi` (the `vendor-seat-roster.ts` pattern):
 * not Verified-gated, and a failure degrades to a retry rather than taking the
 * tab down.
 */
@Component({
  selector: 'aec-vendor-notifications-list',
  imports: [DatePipe, RouterLink],
  styles: [':host { display: block; }'],
  template: `
    <details class="rounded-(--radius-md) border border-(--border-default) px-4 py-3">
      <summary class="cursor-pointer text-sm font-medium text-(--text-primary)">
        {{ summaryLabel() }}
      </summary>

      <div class="mt-3 space-y-3">
        <p class="text-xs text-(--text-secondary)" i18n="@@vendor.attest.notify.framing">
          What we emailed you about these integrations in the last 90 days. Each note reflects the
          state at the time it was sent.
        </p>

        @if (loading()) {
          <p
            role="status"
            class="text-sm text-(--text-secondary)"
            i18n="@@vendor.attest.notify.loading"
          >
            Loading notifications…
          </p>
        } @else if (failed()) {
          <div class="space-y-2">
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.attest.notify.failed">
              Could not load your notifications.
            </p>
            <button
              type="button"
              [class]="retryClass"
              (click)="load()"
              i18n="@@vendor.attest.notify.retry"
            >
              Try again
            </button>
          </div>
        } @else if (visible().length === 0) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.attest.notify.empty">
            No notifications in the last 90 days.
          </p>
        } @else {
          <ul class="m-0 list-none space-y-3 p-0">
            @for (notification of visible(); track notification.id) {
              <li class="border-t border-(--border-default) pt-3 first:border-t-0 first:pt-0">
                <p class="font-label text-sm text-(--text-primary)">
                  {{ titleFor(notification) }}
                </p>
                <p class="mt-0.5 text-xs text-(--text-secondary)">
                  @if (notification.data_object; as dataObject) {
                    <span>{{ dataObject.name }}</span>
                    <span aria-hidden="true"> · </span>
                  }
                  @if (notification.counterpart_product; as counterpart) {
                    <span>{{ counterpart.name }}</span>
                    <span aria-hidden="true"> · </span>
                  }
                  <span>{{ notification.created_at | date: 'mediumDate' }}</span>
                </p>
                @if (notification.pair_path; as path) {
                  <a
                    [routerLink]="path"
                    class="mt-1 inline-block text-xs font-medium text-(--accent-primary) underline"
                    i18n="@@vendor.attest.notify.viewPair"
                    >View the integration page</a
                  >
                }
              </li>
            }
          </ul>
        }
      </div>
    </details>
  `,
})
export class VendorNotificationsList {
  private readonly api = inject(VendorApi);

  protected readonly notifications = signal<readonly VendorNotification[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  /**
   * `aeci-denied` is an ops signal — its ledger rows carry `vendorId: null`, so
   * the endpoint can never return one to a vendor. Filtering defensively costs
   * nothing and means a future routing change cannot surface an internal
   * correction alert on a vendor's dashboard with an empty title.
   */
  protected readonly visible = computed(() =>
    this.notifications().filter((n) => n.detector !== 'aeci-denied'),
  );

  protected readonly summaryLabel = computed(() => {
    const count = this.visible().length;
    return count === 0
      ? $localize`:@@vendor.attest.notify.summary.empty:Recent notifications`
      : $localize`:@@vendor.attest.notify.summary:Recent notifications (${count}:count:)`;
  });

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected titleFor(notification: VendorNotification): string {
    return detectorTitle(notification.detector);
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await this.api.getNotifications();
      this.notifications.set(res.notifications);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
