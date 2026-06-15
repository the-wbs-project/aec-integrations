import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, inject, signal } from '@angular/core';

import type { BannedReviewer } from '@aeci/shared';

import { ReviewerBansApi } from './reviewer-bans-api';

/**
 * AECI-218 / Phase 6.11 — the reviewer-bans management page, rendered in the
 * `AdminShell` layout's outlet at `/admin/reviewers`.
 *
 * It is the home for **unbanning**: the ban *action* is triggered from the
 * review-queue's 3rd-rejection "consider a ban" prompt, but a banned reviewer can
 * only be released here. Like `ReviewQueue`, the gate + nav SSR via the parent
 * `adminSummaryResolver`; this page paints its shell during SSR and fetches the
 * list client-side in `afterNextRender` (`GET /api/admin/reviewers` carries the
 * session cookie, which `requireAdmin()` verifies).
 *
 * Unban is a `PATCH /api/admin/reviewers/:id` `{ action: 'unban' }`; on success the
 * row leaves the list (the reviewer is no longer banned). It is easily reversible
 * (re-ban), so there's no second confirm — just an in-flight disabled state.
 */
@Component({
  selector: 'aec-reviewer-bans',
  imports: [DatePipe],
  templateUrl: './reviewer-bans.html',
})
export class ReviewerBans {
  private readonly api = inject(ReviewerBansApi);

  /** The loaded banned reviewers (server order — newest ban first). */
  protected readonly banned = signal<readonly BannedReviewer[]>([]);
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the reviewer whose unban is in flight (disables its button). */
  protected readonly pendingActionId = signal<string | null>(null);
  /** Last failed unban, keyed to a row so the alert renders inline. */
  protected readonly failedId = signal<string | null>(null);
  /** Polite live-region message — the row vanishes on success, so announce it. */
  protected readonly liveMessage = signal('');

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      const res = await this.api.listBanned({ page: 1, perPage: 100 });
      this.banned.set(res.data);
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

  protected async unban(id: string): Promise<void> {
    if (this.pendingActionId()) return;
    this.failedId.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.ban(id, { action: 'unban' });
      this.banned.update((list) => list.filter((r) => r.reviewer_id !== id));
      this.total.update((n) => Math.max(0, n - 1));
      this.liveMessage.set($localize`:@@admin.reviewers.announce.unbanned:Reviewer unbanned.`);
    } catch (err) {
      // A 422 means the reviewer is no longer banned (raced / already released):
      // drop the row quietly. Anything else is a retryable failure on the row.
      if (err instanceof HttpErrorResponse && err.status === 422) {
        this.banned.update((list) => list.filter((r) => r.reviewer_id !== id));
        this.total.update((n) => Math.max(0, n - 1));
        this.liveMessage.set(
          $localize`:@@admin.reviewers.announce.alreadyUnbanned:That reviewer was already unbanned.`,
        );
      } else {
        this.failedId.set(id);
      }
    } finally {
      this.pendingActionId.set(null);
    }
  }
}
