import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  REVIEW_RESPONSE_DECISIONS,
  REVIEW_RESPONSE_REASON_MAX,
  reviewResponseDecisionsFor,
  type AdminReviewResponse,
  type DecideReviewResponseInput,
  type ReviewResponseDecision,
  type ReviewResponseStatus,
} from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminReviewResponsesApi } from './admin-review-responses-api';

/** One request covers a launch-scale backlog. The API caps `perPage` at 100; we
 *  load the max and say so when the server reports more. */
const QUEUE_PAGE_SIZE = 100;

/** The two decisions that need a reason, and so open a form. */
type ReasonedDecision = Exclude<ReviewResponseDecision, 'approve'>;

/** A decision as the buttons build it. `submit` adds the card's version. */
type DecisionWithoutVersion =
  | { decision: 'approve' }
  | { decision: ReasonedDecision; reason: string };

/**
 * AECI-1177 / `ADMIN_PANEL_SPEC.md` §5.13 — the admin queue for vendor replies to
 * reviews, rendered in the `AdminShell` outlet at `/admin/review-responses`. A
 * sibling of `/admin/contests`: the same SSR-shell plus client-fetch shape and the
 * same pessimistic inline decision forms.
 *
 * A reply is a vendor's public answer to one approved review of its product.
 * Nothing shows on the product page until AECi approves it (pre-moderation,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c ruling 1).
 *
 * ── THE BUTTONS COME FROM THE STATE MACHINE ─────────────────────────────────
 * `reviewResponseDecisionsFor(status)` (`@aeci/shared`) is the same table the API
 * enforces: Approve and Reject on a pending reply, Remove on a published one, and
 * nothing on any other status. The screen cannot offer a move the API refuses.
 *
 * ── A REASON IS REQUIRED FOR REJECT AND REMOVE ──────────────────────────────
 * The vendor sees it in the portal (ruling 7). The API refuses an empty reason
 * with `400`, so the form requires one too and says so before it submits.
 *
 * ── REMOVE ASKS FOR A SECOND, DELIBERATE CONFIRM ────────────────────────────
 * A removal is final: the vendor can never reply to that review again (§11c.6).
 * Ruling 2026-10-02 keeps it final and adds a confirm step. Submitting the remove
 * form with a reason does not send anything. It locks the reason and shows a
 * confirm group that says what removal does, with "Remove permanently", "Edit the
 * reason" and "Cancel". Only "Remove permanently" sends the `PATCH`. Focus moves
 * to the group, which is labelled and described by its own text, so a screen
 * reader hears the warning before any button. This is the inline two-step confirm
 * the seat revoke on `/admin/vendors/:id` uses, not a dialog.
 *
 * ── THE BADGE ───────────────────────────────────────────────────────────────
 * `pending_review_responses` counts `status = 'pending'`. A successful approve or
 * reject decrements it. A remove does not, because a published reply was never in
 * the count. A `409 REVIEW_RESPONSE_WRONG_STATE` does not either: someone else
 * moved the row first (another admin, or the vendor editing or withdrawing it),
 * and the next full visit re-seeds the count.
 */
@Component({
  selector: 'aec-review-response-queue',
  imports: [DatePipe, RouterLink],
  templateUrl: './review-response-queue.html',
})
export class ReviewResponseQueue {
  private readonly api = inject(AdminReviewResponsesApi);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly reasonMax = REVIEW_RESPONSE_REASON_MAX;

  /** The loaded replies, in server order (oldest first). */
  private readonly replies = signal<readonly AdminReviewResponse[]>([]);
  /** Rows matching the current filter, as the server reports it. */
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the reply whose decision is in flight (disables its buttons). */
  protected readonly pendingActionId = signal<string | null>(null);
  /** The reply and decision whose reason form is open, one at a time. */
  protected readonly formOpenId = signal<string | null>(null);
  protected readonly formMode = signal<ReasonedDecision | null>(null);
  protected readonly formText = signal('');
  protected readonly reasonMissing = signal(false);
  /** True once a remove form's reason is in and the final confirm is showing. */
  protected readonly removeConfirming = signal(false);
  /** Id and message of the reply whose last decision failed (inline alert). */
  protected readonly failedActionId = signal<string | null>(null);
  protected readonly failedActionMessage = signal('');
  /** The one polite live region. Rows vanish on success, so the outcome is
   *  announced here, and it stays visible so a sighted operator sees it too. */
  protected readonly liveMessage = signal('');

  protected readonly statusFilter = signal<ReviewResponseStatus>('pending');

  protected readonly statusOptions: ReadonlyArray<{ key: ReviewResponseStatus; label: string }> = [
    { key: 'pending', label: $localize`:@@admin.replies.filter.pending:Pending` },
    { key: 'published', label: $localize`:@@admin.replies.filter.published:Published` },
    { key: 'rejected', label: $localize`:@@admin.replies.filter.rejected:Rejected` },
    { key: 'withdrawn', label: $localize`:@@admin.replies.filter.withdrawn:Withdrawn` },
    { key: 'removed', label: $localize`:@@admin.replies.filter.removed:Removed` },
  ];

  protected readonly visibleReplies = computed(() => this.replies());
  protected readonly loadedCount = computed(() => this.replies().length);
  protected readonly truncated = computed(() => this.total() > this.replies().length);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      const res = await this.api.listReplies({
        status: this.statusFilter(),
        page: 1,
        perPage: QUEUE_PAGE_SIZE,
      });
      this.replies.set(res.data);
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

  protected setStatus(status: ReviewResponseStatus): void {
    if (this.statusFilter() === status) return;
    this.statusFilter.set(status);
    this.closeForm();
    void this.load();
  }

  // ── Display ──────────────────────────────────────────────────────────────

  protected statusLabel(status: ReviewResponseStatus): string {
    return this.statusOptions.find((o) => o.key === status)?.label ?? status;
  }

  protected reviewStatusLabel(status: AdminReviewResponse['review']['status']): string {
    switch (status) {
      case 'approved':
        return $localize`:@@admin.replies.review.status.approved:Approved`;
      case 'pending':
        return $localize`:@@admin.replies.review.status.pending:Pending`;
      case 'rejected':
        return $localize`:@@admin.replies.review.status.rejected:Rejected`;
      case 'archived':
        return $localize`:@@admin.replies.review.status.archived:Archived`;
    }
  }

  /** The decisions this reply's status allows, from the shared state machine. */
  protected decisionsFor(r: AdminReviewResponse): readonly ReviewResponseDecision[] {
    return reviewResponseDecisionsFor(r.status);
  }

  protected canApprove(r: AdminReviewResponse): boolean {
    return this.decisionsFor(r).includes('approve');
  }

  protected canReject(r: AdminReviewResponse): boolean {
    return this.decisionsFor(r).includes('reject');
  }

  protected canRemove(r: AdminReviewResponse): boolean {
    return this.decisionsFor(r).includes('remove');
  }

  /** §11c.11: the reply will not render even if approved. */
  protected wontRender(r: AdminReviewResponse): boolean {
    return r.review.status !== 'approved' || !r.vendor_owns_product;
  }

  // ── Decisions ────────────────────────────────────────────────────────────

  protected openForm(id: string, mode: ReasonedDecision): void {
    this.failedActionId.set(null);
    this.formText.set('');
    this.reasonMissing.set(false);
    this.removeConfirming.set(false);
    this.formMode.set(mode);
    this.formOpenId.set(id);
  }

  protected closeForm(): void {
    this.formOpenId.set(null);
    this.formMode.set(null);
    this.formText.set('');
    this.reasonMissing.set(false);
    this.removeConfirming.set(false);
  }

  protected onFormInput(event: Event): void {
    this.formText.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonMissing()) this.reasonMissing.set(false);
  }

  protected approve(id: string): Promise<void> {
    return this.submit(id, { decision: 'approve' });
  }

  protected confirmReasoned(id: string, decision: ReasonedDecision): Promise<void> {
    const reason = this.formText().trim();
    if (reason === '') {
      this.reasonMissing.set(true);
      return Promise.resolve();
    }
    // A removal is final, so the first submit only asks for the deliberate confirm.
    if (decision === 'remove' && !this.removeConfirming()) {
      this.removeConfirming.set(true);
      this.focusAfterRender(`reply-remove-confirm-${id}`);
      return Promise.resolve();
    }
    return this.submit(id, { decision, reason });
  }

  /** Leave the remove confirm and unlock the reason. Sends nothing. */
  protected editRemoveReason(id: string): void {
    this.removeConfirming.set(false);
    this.focusAfterRender(`reply-reason-${id}`);
  }

  private focusAfterRender(elementId: string): void {
    afterNextRender(
      { write: () => this.host.nativeElement.querySelector<HTMLElement>(`#${elementId}`)?.focus() },
      { injector: this.injector },
    );
  }

  private async submit(id: string, decision: DecisionWithoutVersion): Promise<void> {
    if (this.pendingActionId()) return;
    // Read before the row is dropped: only a pending reply is in the count.
    const row = this.replies().find((r) => r.id === id);
    if (!row) return;
    const wasCounted = row.status === 'pending';
    // The version on screen is the version decided on (§11c.7). A vendor edit since
    // the load answers `409 REVIEW_RESPONSE_CHANGED` instead of approving unseen text.
    const input: DecideReviewResponseInput = { ...decision, expected_updated_at: row.updated_at };
    this.failedActionId.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.decide(id, input);
      this.closeForm();
      this.removeRow(id);
      if (wasCounted && REVIEW_RESPONSE_DECISIONS[input.decision].from === 'pending') {
        this.summaryStore.decrement('reviewResponses');
      }
      this.liveMessage.set(announcement(input.decision));
    } catch (err) {
      this.handleDecisionError(id, err);
    } finally {
      this.pendingActionId.set(null);
    }
  }

  /**
   * `409 REVIEW_RESPONSE_WRONG_STATE`: someone else moved the reply first. Say so
   * and reload, so the list shows the state that won.
   * `409 REVIEW_RESPONSE_CHANGED`: the vendor edited or resubmitted the reply after
   * the load. Say so and reload, so the card shows the new text before anyone
   * decides on it. Anything else is a retryable failure, shown on the card.
   */
  private handleDecisionError(id: string, err: unknown): void {
    const code = apiErrorCode(err);
    if (code === 'REVIEW_RESPONSE_CHANGED') {
      this.closeForm();
      this.liveMessage.set(
        $localize`:@@admin.replies.announce.vendorChanged:The vendor changed this reply. Read the new version before deciding.`,
      );
      void this.load();
      return;
    }
    if (code === 'REVIEW_RESPONSE_WRONG_STATE') {
      this.closeForm();
      this.liveMessage.set(
        $localize`:@@admin.replies.announce.alreadyChanged:Already changed. That reply was decided, edited or withdrawn before your decision reached it, so the list has been reloaded.`,
      );
      void this.load();
      return;
    }
    this.failedActionId.set(id);
    this.failedActionMessage.set(
      $localize`:@@admin.replies.action.failed:Something went wrong. Nothing was changed. Please try again.`,
    );
  }

  private removeRow(id: string): void {
    this.replies.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
  }
}

function announcement(decision: ReviewResponseDecision): string {
  switch (decision) {
    case 'approve':
      return $localize`:@@admin.replies.announce.approved:Reply approved. It now shows under the review on the product page.`;
    case 'reject':
      return $localize`:@@admin.replies.announce.rejected:Reply rejected. The vendor can see your reason and resubmit.`;
    case 'remove':
      return $localize`:@@admin.replies.announce.removed:Reply removed from the product page. The vendor can see your reason and cannot reply to that review again.`;
  }
}

/** The `code` from the API's `{ error: { code } }` envelope, or `null`. */
function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const inner = (err.error as { error?: { code?: unknown } } | null | undefined)?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}
