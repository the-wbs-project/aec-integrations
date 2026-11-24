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
  REVIEW_UPDATE_DECISIONS,
  REVIEW_UPDATE_REASON_MAX,
  reviewUpdateDecisionsFor,
  type AdminReviewUpdate,
  type DecideReviewUpdateInput,
  type ReviewUpdateDecision,
  type ReviewUpdateStatus,
} from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { CONSOLE_FILTER } from '../console/console-filter';
import { CONSOLE_LABEL_CLASS, CONSOLE_TABLE } from '../console/console-table';
import { AdminDangerAction, type AdminDangerConfirmStep } from '../console/danger-action';
import { AdminDisclosureButton } from '../console/disclosure-button';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import {
  QUEUE_BODY_CLASS,
  QUEUE_DETAIL_GRID_CLASS,
  QUEUE_FACTS_CLASS,
  QUEUE_FAILED_CLASS,
  QUEUE_HELP_CLASS,
} from '../reviews/queue-classes';
import { queueFocusAfterRemoval } from '../reviews/queue-focus';
import { AdminReviewUpdatesApi } from './admin-review-updates-api';
import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import { AecIcon } from '../../shared/icon/icon';
import { CONSOLE_NOTICE_CLASS } from '../console/console-detail';

/** One request covers a launch-scale backlog. The API caps `perPage` at 100; we
 *  load the max and say so when the server reports more. */
const QUEUE_PAGE_SIZE = 100;

/** The same threshold the review queue flags at (`admin/reviews/review-queue.ts`). */
const HIGH_TOXICITY_THRESHOLD = 70;

/** The two decisions that need a reason, and so open a form. */
type ReasonedDecision = Exclude<ReviewUpdateDecision, 'approve'>;

/**
 * AECI-1613 / `ADMIN_PANEL_SPEC.md` §5.20: the admin queue for reviewer updates
 * to published reviews, rendered in the `AdminShell` outlet at
 * `/admin/review-updates`. A sibling of `/admin/review-responses`: the same SSR
 * shell plus client fetch, and the same pessimistic inline decision forms.
 *
 * An update is the reviewer's own addition to one of their approved reviews. The
 * original review never changes. Nothing shows on the product page until AECi
 * approves the update (pre-moderation, `STAGE_1_SPEC.md` §4.7a). Each card stacks
 * the original review above the update, so the decision is made with both in view.
 *
 * ── THE BUTTONS COME FROM THE STATE MACHINE ─────────────────────────────────
 * `reviewUpdateDecisionsFor(status)` (`@aeci/shared`) is the table the API
 * enforces: Approve and Reject on a pending update, Remove on an approved one,
 * nothing on rejected or removed.
 *
 * ── REMOVE ASKS FOR A SECOND, DELIBERATE CONFIRM ────────────────────────────
 * Removal is final for that update. Submitting the remove form with a reason
 * locks the reason and shows a labelled confirm group. Only "Remove permanently"
 * sends the `PATCH`. The same inline two-step the reply queue uses. Both reason
 * forms are the shared danger form (`admin/console/danger-action.ts`, AECI-2104).
 *
 * ── THE BADGE ───────────────────────────────────────────────────────────────
 * `pending_review_updates` counts `status = 'pending'`. A successful approve or
 * reject decrements it. A remove does not, and neither does a `409
 * REVIEW_UPDATE_WRONG_STATE`: someone else moved the row first, and the next full
 * visit re-seeds the count.
 *
 * ── THE TABLE (AECI-2102, mock-up 14) ───────────────────────────────────────
 * One console table row per update: product, reviewer, toxicity, submitted and
 * status. The original review, the update and the decision sit in the row's
 * expanded detail. After a decision removes a row, focus moves to the disclosure
 * of the row that took its place, or to the queue heading when none is left. A
 * failed decision moves focus to the row's alert.
 */
@Component({
  selector: 'aec-review-update-queue',
  imports: [
    AdminDangerAction,
    AdminDisclosureButton,
    AecButton,
    AecIcon,
    Chip,
    DatePipe,
    RouterLink,
  ],
  templateUrl: './review-update-queue.html',
})
export class ReviewUpdateQueue {
  private readonly api = inject(AdminReviewUpdatesApi);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly reasonMax = REVIEW_UPDATE_REASON_MAX;

  /** The reason forms' words. The reason is natively capped at `reasonMax`. */
  protected readonly copy = {
    reject: $localize`:@@admin.reviewUpdates.reject:Reject`,
    remove: $localize`:@@admin.reviewUpdates.remove:Remove from the page`,
    rejectLabel: $localize`:@@admin.reviewUpdates.reason.label.reject:Why you are rejecting it (required)`,
    removeLabel: $localize`:@@admin.reviewUpdates.reason.label.remove:Why you are removing it (required)`,
    reasonHelp: $localize`:@@admin.reviewUpdates.reason.help:Shown to the reviewer on their account page. Name the guideline the update breaks, so they know what to change.`,
    missing: $localize`:@@admin.reviewUpdates.reason.missing:Write a reason before you confirm.`,
    rejectConfirm: $localize`:@@admin.reviewUpdates.reject.confirm:Confirm rejection`,
    saving: $localize`:@@admin.reviewUpdates.saving:Saving…`,
    removeConfirm: $localize`:@@admin.reviewUpdates.removeConfirm.confirm:Remove permanently`,
    removing: $localize`:@@admin.reviewUpdates.removing:Removing…`,
    cancel: $localize`:@@admin.reviewUpdates.cancel:Cancel`,
  } as const;

  /** Removal is final for this update, so it takes a second, deliberate step. */
  protected readonly removeStep: AdminDangerConfirmStep = {
    continueLabel: $localize`:@@admin.reviewUpdates.remove.continue:Continue to removal`,
    title: $localize`:@@admin.reviewUpdates.removeConfirm.title:Remove this update permanently?`,
    body: $localize`:@@admin.reviewUpdates.removeConfirm.body:Removal is final. The update comes off the product page, and its ratings stop counting in the product's averages. Nobody can undo it from this screen.`,
    editLabel: $localize`:@@admin.reviewUpdates.removeConfirm.edit:Edit the reason`,
  };

  protected readonly t = CONSOLE_TABLE;
  protected readonly f = CONSOLE_FILTER;
  protected readonly labelClass = CONSOLE_LABEL_CLASS;
  protected readonly noticeClass = CONSOLE_NOTICE_CLASS;
  protected readonly detailGridClass = QUEUE_DETAIL_GRID_CLASS;
  protected readonly bodyClass = QUEUE_BODY_CLASS;
  protected readonly factsClass = QUEUE_FACTS_CLASS;
  protected readonly helpClass = QUEUE_HELP_CLASS;
  protected readonly failedClass = QUEUE_FAILED_CLASS;
  /** The table's columns, for the detail cell's `colspan`. */
  protected readonly columnCount = 6;
  /** Ids of the rows whose detail is open. */
  private readonly openIds = signal<ReadonlySet<string>>(new Set());

  private readonly updates = signal<readonly AdminReviewUpdate[]>([]);
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  protected readonly pendingActionId = signal<string | null>(null);
  /** Which decision is in flight on `pendingActionId` (AECI-2104). A form's busy
   *  label and its hidden status speak only for its own decision, so an Approve
   *  pressed while a reason form is open never reads as that form's action. */
  private readonly pendingDecision = signal<ReviewUpdateDecision | null>(null);

  /** The decision `action` is the one in flight on row `id`. */
  protected busyWith(id: string, action: ReviewUpdateDecision): boolean {
    return this.pendingActionId() === id && this.pendingDecision() === action;
  }
  protected readonly formOpenId = signal<string | null>(null);
  protected readonly formMode = signal<ReasonedDecision | null>(null);
  protected readonly failedActionId = signal<string | null>(null);
  protected readonly failedActionMessage = signal('');
  /** The one polite live region. Rows vanish on success, so the outcome is
   *  announced here, and it stays visible so a sighted operator sees it too. */
  protected readonly liveMessage = signal('');

  protected readonly statusFilter = signal<ReviewUpdateStatus>('pending');

  protected readonly statusOptions: ReadonlyArray<{ key: ReviewUpdateStatus; label: string }> = [
    { key: 'pending', label: $localize`:@@admin.reviewUpdates.filter.pending:Pending` },
    { key: 'approved', label: $localize`:@@admin.reviewUpdates.filter.approved:Approved` },
    { key: 'rejected', label: $localize`:@@admin.reviewUpdates.filter.rejected:Rejected` },
    { key: 'removed', label: $localize`:@@admin.reviewUpdates.filter.removed:Removed` },
  ];

  protected readonly visibleUpdates = computed(() => this.updates());
  protected readonly loadedCount = computed(() => this.updates().length);
  protected readonly truncated = computed(() => this.total() > this.updates().length);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      const res = await this.api.listUpdates({
        status: this.statusFilter(),
        page: 1,
        perPage: QUEUE_PAGE_SIZE,
      });
      this.updates.set(res.data);
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

  protected setStatus(status: ReviewUpdateStatus): void {
    if (this.statusFilter() === status) return;
    this.statusFilter.set(status);
    this.closeForm();
    void this.load();
  }

  // ── Display ──────────────────────────────────────────────────────────────

  protected isOpen(id: string): boolean {
    return this.openIds().has(id);
  }

  protected toggleRow(id: string): void {
    this.openIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The row's name, true open or closed: `aria-expanded` carries the state. */
  protected rowLabel(u: AdminReviewUpdate): string {
    const product = u.product.name;
    const reviewer =
      u.reviewer_email ?? $localize`:@@admin.reviewUpdates.meta.reviewerUnknown:Not available`;
    return $localize`:@@admin.reviewUpdates.row.label:Update to a review of ${product}:product: by ${reviewer}:reviewer:`;
  }

  protected tone(key: AdminStatusKey): ConsoleChipTone {
    return adminStatusTone(key);
  }

  /** The chip tone for an update status. Exhaustive: a new status fails to compile. */
  protected statusTone(status: ReviewUpdateStatus): ConsoleChipTone {
    switch (status) {
      case 'pending':
        return adminStatusTone('pending');
      case 'approved':
        return adminStatusTone('approved');
      case 'rejected':
        return adminStatusTone('rejected');
      case 'removed':
        return adminStatusTone('removed');
    }
  }

  protected statusLabel(status: ReviewUpdateStatus): string {
    return this.statusOptions.find((o) => o.key === status)?.label ?? status;
  }

  protected reviewStatusLabel(status: AdminReviewUpdate['review']['status']): string {
    switch (status) {
      case 'approved':
        return $localize`:@@admin.reviewUpdates.review.status.approved:Approved`;
      case 'pending':
        return $localize`:@@admin.reviewUpdates.review.status.pending:Pending`;
      case 'rejected':
        return $localize`:@@admin.reviewUpdates.review.status.rejected:Rejected`;
      case 'archived':
        return $localize`:@@admin.reviewUpdates.review.status.archived:Archived`;
      case 'removed':
        return $localize`:@@admin.reviewUpdates.review.status.removed:Removed`;
    }
  }

  protected isHighToxicity(score: number | null): boolean {
    return score !== null && score >= HIGH_TOXICITY_THRESHOLD;
  }

  /** Gives the bare number meaning for a screen reader. */
  protected toxicityAriaLabel(score: number | null): string {
    return score === null
      ? $localize`:@@admin.reviewUpdates.toxicity.aria.notScored:Toxicity not scored`
      : $localize`:@@admin.reviewUpdates.toxicity.aria.scored:Toxicity score ${score}:score: of 100`;
  }

  protected rerated(u: AdminReviewUpdate): boolean {
    return u.rating_overall !== null && u.rating_onboarding !== null;
  }

  protected decisionsFor(u: AdminReviewUpdate): readonly ReviewUpdateDecision[] {
    return reviewUpdateDecisionsFor(u.status);
  }

  protected canApprove(u: AdminReviewUpdate): boolean {
    return this.decisionsFor(u).includes('approve');
  }

  protected canReject(u: AdminReviewUpdate): boolean {
    return this.decisionsFor(u).includes('reject');
  }

  protected canRemove(u: AdminReviewUpdate): boolean {
    return this.decisionsFor(u).includes('remove');
  }

  /** The update will not render even if approved: its review left `approved`. */
  protected wontRender(u: AdminReviewUpdate): boolean {
    return u.review.status !== 'approved';
  }

  // ── Decisions ────────────────────────────────────────────────────────────

  /** A reason form opened or closed (its opener, Cancel or Escape). One form is
   *  open at a time. The danger form starts each open clean, focuses its own field
   *  and ignores a close while the row's request runs. */
  protected onFormOpen(id: string, mode: ReasonedDecision, open: boolean): void {
    if (open) {
      this.failedActionId.set(null);
      this.formMode.set(mode);
      this.formOpenId.set(id);
    } else if (this.formOpenId() === id && this.formMode() === mode) {
      this.closeForm();
    }
  }

  protected closeForm(): void {
    this.formOpenId.set(null);
    this.formMode.set(null);
  }

  protected approve(id: string): Promise<void> {
    return this.submit(id, { action: 'approve' });
  }

  /** The danger form checked the reason. For Remove, this is step two's press. */
  protected decide(id: string, action: ReasonedDecision, reason: string): Promise<void> {
    return this.submit(id, { action, reason });
  }

  /** Focus an element of this queue once the next render lands: by id, or by a
   *  selector when the id is not known. */
  private focusAfterRender(elementId: string | undefined, selector?: string): void {
    const query = selector ?? `[id="${elementId}"]`;
    afterNextRender(
      { write: () => this.host.nativeElement.querySelector<HTMLElement>(query)?.focus() },
      { injector: this.injector },
    );
  }

  private async submit(id: string, input: DecideReviewUpdateInput): Promise<void> {
    if (this.pendingActionId()) return;
    const row = this.updates().find((u) => u.id === id);
    if (!row) return;
    // Read before the row is dropped: only a pending update is in the count.
    const wasCounted = row.status === 'pending';
    this.failedActionId.set(null);
    this.pendingActionId.set(id);
    this.pendingDecision.set(input.action);
    try {
      await this.api.decide(id, input);
      this.closeForm();
      this.removeRow(id);
      if (wasCounted && REVIEW_UPDATE_DECISIONS[input.action].from === 'pending') {
        this.summaryStore.decrement('reviewUpdates');
      }
      this.liveMessage.set(announcement(input.action));
    } catch (err) {
      this.handleDecisionError(id, err);
    } finally {
      this.pendingActionId.set(null);
      this.pendingDecision.set(null);
    }
  }

  /** `409 REVIEW_UPDATE_WRONG_STATE`: someone else moved the update first. Say so
   *  and reload, so the list shows the state that won. Anything else is a
   *  retryable failure, shown on the card. */
  private handleDecisionError(id: string, err: unknown): void {
    if (apiErrorCode(err) === 'REVIEW_UPDATE_WRONG_STATE') {
      this.closeForm();
      this.liveMessage.set(
        $localize`:@@admin.reviewUpdates.announce.alreadyChanged:Already changed. That update was decided before your decision reached it, so the list has been reloaded.`,
      );
      void this.load();
      return;
    }
    this.failedActionId.set(id);
    this.failedActionMessage.set(
      $localize`:@@admin.reviewUpdates.action.failed:Something went wrong. Nothing was changed. Please try again.`,
    );
    this.focusAfterRender(`update-${id}-failed`);
  }

  /** Drop a decided row, then move focus by the queues' one rule
   *  (`queueFocusAfterRemoval`): the row that took its place, the heading, or
   *  nowhere when the row was not on screen. */
  private removeRow(id: string): void {
    const index = this.updates().findIndex((u) => u.id === id);
    this.updates.update((list) => list.filter((u) => u.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
    const target = queueFocusAfterRemoval(index, 1, 1, this.updates());
    if (target.kind === 'none') return;
    this.focusAfterRender(
      target.kind === 'heading' ? 'admin-review-updates-heading' : undefined,
      target.kind === 'row' ? `[aria-controls="update-${target.row.id}-detail"]` : undefined,
    );
  }
}

function announcement(action: ReviewUpdateDecision): string {
  switch (action) {
    case 'approve':
      return $localize`:@@admin.reviewUpdates.announce.approved:Update approved. It now shows under the review on the product page.`;
    case 'reject':
      return $localize`:@@admin.reviewUpdates.announce.rejected:Update rejected. The reviewer can see your reason and add a new update.`;
    case 'remove':
      return $localize`:@@admin.reviewUpdates.announce.removed:Update removed from the product page. The reviewer can see your reason.`;
  }
}

/** The `code` from the API's `{ error: { code } }` envelope, or `null`. */
function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const inner = (err.error as { error?: { code?: unknown } } | null | undefined)?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}
