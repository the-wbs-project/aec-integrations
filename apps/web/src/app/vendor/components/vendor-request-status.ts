import { DatePipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import type { VendorRequestSummary } from '@aeci/shared';

import { Chip, type ChipTone } from '../../shared/chip/chip';

type RequestStatus = VendorRequestSummary['status'];

/**
 * Claim / correction status list for the vendor dashboard (AECI-522). Surfaces
 * the vendor's `vendor_requests` states ("we're looking at it") — a read-only
 * signal. The free-text body and the submitter's identity are deliberately NOT
 * in the payload (a correction may be filed by a member of the public), so this
 * shows only kind + target + status + timestamps.
 *
 * Status is conveyed by the shared chip AND its text label — never colour alone
 * (WCAG 1.4.1). Light theme only.
 */
@Component({
  selector: 'aec-vendor-request-status',
  imports: [Chip, DatePipe],
  template: `
    @if (ordered().length === 0) {
      <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.requests.empty">
        No open claim or correction requests. When someone files one about your listing, its status
        shows here.
      </p>
    } @else {
      <!-- AECI-1812: rows divided by hairlines inside the Messages card, the state on
           the shared chip. -->
      <ul class="divide-y divide-(--border-default) border-t border-(--border-default)">
        @for (r of ordered(); track r.id) {
          <li class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4 last:pb-0">
            <div class="min-w-0">
              <p class="text-sm font-semibold text-(--text-primary)">{{ targetLabel(r) }}</p>
              <p class="mt-1 text-t-13 text-(--text-secondary)">
                <span i18n="@@vendor.requests.filed">Filed</span>
                {{ r.created_at | date: 'mediumDate' }}
                @if (r.resolved_at) {
                  <span aria-hidden="true"> · </span>
                  <span i18n="@@vendor.requests.closed">closed</span>
                  {{ r.resolved_at | date: 'mediumDate' }}
                }
              </p>
            </div>
            <aec-chip class="shrink-0" density="dense" [tone]="tone(r.status)">{{
              statusLabel(r.status)
            }}</aec-chip>
          </li>
        }
      </ul>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorRequestStatus {
  readonly requests = input.required<readonly VendorRequestSummary[]>();

  /** Newest filed first, `id` breaking a same-millisecond tie (AECI-1243). The
   *  API already ships this order; sorting here keeps the list right whatever
   *  the caller passes. Both keys compare in binary: ISO timestamps and ids. */
  protected readonly ordered = computed(() => [...this.requests()].sort(newestFirst));

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

  /** The state's chip tone, the old pill colours on the shared ladder: Forest for
   *  resolved, the strong edge for in review, quiet for not accepted, and the dense
   *  chip's sunken rest for open. */
  protected tone(status: RequestStatus): ChipTone | null {
    switch (status) {
      case 'resolved':
        return 'forest';
      case 'in_review':
        return 'strong';
      case 'rejected':
        return 'quiet';
      case 'open':
        return null;
    }
  }
}

function newestFirst(a: VendorRequestSummary, b: VendorRequestSummary): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
