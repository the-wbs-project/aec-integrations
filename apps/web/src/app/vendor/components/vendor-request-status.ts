import { DatePipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import type { VendorRequestSummary } from '@aeci/shared';

type RequestStatus = VendorRequestSummary['status'];

/**
 * Claim / correction status list for the vendor dashboard (AECI-522). Surfaces
 * the vendor's `vendor_requests` states ("we're looking at it") — a read-only
 * signal. The free-text body and the submitter's identity are deliberately NOT
 * in the payload (a correction may be filed by a member of the public), so this
 * shows only kind + target + status + timestamps.
 *
 * Status is conveyed by a bordered pill AND its text label — never colour alone
 * (WCAG 1.4.1). Light theme only.
 */
@Component({
  selector: 'aec-vendor-request-status',
  imports: [DatePipe],
  template: `
    @if (requests().length === 0) {
      <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.requests.empty">
        No open claim or correction requests. When someone files one about your listing, its status
        shows here.
      </p>
    } @else {
      <ul class="flex flex-col gap-3">
        @for (r of requests(); track r.id) {
          <li
            class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-4 py-3"
          >
            <div class="min-w-0">
              <p class="font-label text-sm text-(--text-primary)">{{ targetLabel(r) }}</p>
              <p class="mt-0.5 text-xs text-(--text-secondary)">
                <span i18n="@@vendor.requests.filed">Filed</span>
                {{ r.created_at | date: 'mediumDate' }}
                @if (r.resolved_at) {
                  <span aria-hidden="true"> · </span>
                  <span i18n="@@vendor.requests.closed">closed</span>
                  {{ r.resolved_at | date: 'mediumDate' }}
                }
              </p>
            </div>
            <span
              class="inline-flex shrink-0 items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]"
              [class]="toneClass(r.status)"
              >{{ statusLabel(r.status) }}</span
            >
          </li>
        }
      </ul>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorRequestStatus {
  readonly requests = input.required<readonly VendorRequestSummary[]>();

  /** How many requests are still open/in-review — a small header count. */
  readonly openCount = computed(
    () => this.requests().filter((r) => r.status === 'open' || r.status === 'in_review').length,
  );

  /** A friendly one-line summary of the request. Names are not in the payload
   *  (summary only), so the target is described by kind + type. */
  protected targetLabel(r: VendorRequestSummary): string {
    const target =
      r.target_type === 'vendor'
        ? $localize`:@@vendor.requests.target.vendor:your vendor profile`
        : $localize`:@@vendor.requests.target.product:a product`;
    return r.kind === 'claim'
      ? $localize`:@@vendor.requests.kind.claim:Claim on ${target}:target:`
      : $localize`:@@vendor.requests.kind.correction:Correction to ${target}:target:`;
  }

  protected statusLabel(status: RequestStatus): string {
    switch (status) {
      case 'open':
        return $localize`:@@vendor.requests.status.open:Open`;
      case 'in_review':
        return $localize`:@@vendor.requests.status.inReview:In review`;
      case 'resolved':
        return $localize`:@@vendor.requests.status.resolved:Resolved`;
      case 'rejected':
        return $localize`:@@vendor.requests.status.rejected:Not accepted`;
    }
  }

  protected toneClass(status: RequestStatus): string {
    switch (status) {
      case 'resolved':
        return 'border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)';
      case 'in_review':
        return 'border-(--border-strong) bg-(--surface-raised) text-(--text-primary)';
      case 'rejected':
        return 'border-(--border-strong) bg-(--surface-raised) text-(--text-secondary)';
      default:
        return 'border-(--border-default) bg-(--surface-sunken) text-(--text-secondary)';
    }
  }
}
