/**
 * "Also reject N pending items" for both ban forms (AECI-1949, `ADMIN_PANEL_SPEC.md`
 * §5.8). `/admin/users/:id` and the review queue's ban dialog render this one
 * component, so the two forms behave alike (`DESIGN.md` "The Same-Behavior Rule").
 *
 * The counts come from `GET /api/admin/users/:id`: `counts.reviews.pending` plus
 * `counts.pending_moderation`. The checkbox is shown only when there is something to
 * reject, and it starts checked (ruling of 2026-11-26). The parent owns the value
 * and sends it as `reject_pending`.
 */
import { Component, computed, input, model } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiErrorCode, type AdminUserDetail } from '@aeci/shared';

import { CONSOLE_CAPTION_CLASS } from '../console/console-table';
import { CONSOLE_TEXT_LINK_CLASS } from '../console/console-detail';
import { isStatus } from '../http-status';
import { CHOICE_INPUT_CLASS } from '../../shared/form-field/form-field-classes';

/** What a ban with `reject_pending` would reject, by kind. */
export interface BanPendingCounts {
  reviews: number;
  review_updates: number;
  review_responses: number;
}

/** The counts off the user detail. An older API without `pending_moderation`
 *  reads as zero updates and replies. */
export function banPendingCounts(detail: AdminUserDetail): BanPendingCounts {
  return {
    reviews: detail.counts.reviews.pending,
    review_updates: detail.counts.pending_moderation?.review_updates ?? 0,
    review_responses: detail.counts.pending_moderation?.review_responses ?? 0,
  };
}

export function banPendingTotal(counts: BanPendingCounts | null): number {
  return counts ? counts.reviews + counts.review_updates + counts.review_responses : 0;
}

function errorCode(err: unknown): unknown {
  return (err as { error?: { error?: { code?: unknown } } } | null)?.error?.error?.code;
}

/** `409 BAN_PENDING_CHANGED`: an item moved while the ban ran. Nothing was saved. */
export function isBanPendingChanged(err: unknown): boolean {
  return isStatus(err, 409) && errorCode(err) === ApiErrorCode.BAN_PENDING_CHANGED;
}

/** `422 BAN_REJECT_TOO_MANY`: more pending items than one ban can reject. */
export function isBanRejectTooMany(err: unknown): boolean {
  return isStatus(err, 422) && errorCode(err) === ApiErrorCode.BAN_REJECT_TOO_MANY;
}

@Component({
  selector: 'aec-ban-pending-choice',
  imports: [RouterLink],
  template: `
    @if (total() > 0) {
      <div class="grid gap-1" data-testid="ban-pending-choice">
        <label class="flex min-h-11 items-center gap-2 text-t-14 text-(--text-primary)">
          <input
            type="checkbox"
            data-testid="ban-reject-pending"
            [class]="choiceClass"
            [checked]="checked()"
            [disabled]="disabled()"
            [attr.aria-describedby]="hintId()"
            (change)="onChange($event)"
          />
          <span i18n="@@admin.ban.rejectPending.label">{total(), plural,
            =1 {Also reject 1 pending item}
            other {Also reject {{ total() }} pending items}
          }</span>
        </label>
        <p [id]="hintId()" [class]="captionClass" data-testid="ban-pending-counts">
          @if (links()) {
            <span i18n="@@admin.ban.rejectPending.reviews">Reviews:</span>
            <a
              [routerLink]="['/admin/reviews']"
              [queryParams]="{ account: accountId() }"
              [class]="linkClass"
              >{{ counts()!.reviews }}</a
            >.
            <span i18n="@@admin.ban.rejectPending.updates">Review updates:</span>
            <a
              [routerLink]="['/admin/review-updates']"
              [queryParams]="{ account: accountId() }"
              [class]="linkClass"
              >{{ counts()!.review_updates }}</a
            >.
            <span i18n="@@admin.ban.rejectPending.replies">Vendor replies:</span>
            <a
              [routerLink]="['/admin/review-responses']"
              [queryParams]="{ account: accountId() }"
              [class]="linkClass"
              >{{ counts()!.review_responses }}</a
            >.
          } @else {
            <span i18n="@@admin.ban.rejectPending.countsPlain"
              >Reviews: {{ counts()!.reviews }}. Review updates: {{ counts()!.review_updates }}.
              Vendor replies: {{ counts()!.review_responses }}.</span
            >
          }
          <span i18n="@@admin.ban.rejectPending.hint"
            >Each one is declined with a fixed reason that does not repeat yours. Review updates get
            the usual email. Reviews get none.</span
          >
        </p>
      </div>
    }
  `,
})
export class BanPendingChoice {
  /** `null` while the counts load: nothing renders. */
  readonly counts = input.required<BanPendingCounts | null>();
  readonly accountId = input.required<string>();
  /** The id of the hint, unique per form on the page. */
  readonly hintId = input('ban-pending-hint');
  /** Link each count to its queue filtered to this person. Off in the review
   *  queue's dialog, which already sits on one of those queues. */
  readonly links = input(true);
  readonly disabled = input(false);
  readonly checked = model(true);

  protected readonly total = computed(() => banPendingTotal(this.counts()));
  protected readonly choiceClass = CHOICE_INPUT_CLASS;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly linkClass = CONSOLE_TEXT_LINK_CLASS;

  protected onChange(event: Event): void {
    this.checked.set((event.target as HTMLInputElement).checked);
  }
}
