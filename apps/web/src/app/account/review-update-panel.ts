import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Listbox, Option } from '@angular/aria/listbox';

import {
  ApiErrorCode,
  REVIEW_UPDATE_BODY_MAX,
  REVIEW_UPDATE_BODY_MIN,
  SubmitReviewUpdateSchema,
  type AccountReview,
  type AccountReviewUpdate,
  type SubmitReviewUpdateInput,
} from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../shared/form-field/form-field-classes';
import { AccountApi } from './account-api';
import { ReviewStatusBadge } from './review-status-badge';
import { AecButton } from '../shared/button/button';

/** Why the last submit failed, mapped from the API's error code. */
type SubmitError =
  | 'pending'
  | 'banned'
  | 'suspended'
  | 'rateLimited'
  | 'notFound'
  | 'invalid'
  | 'failed';

/** The client-side field errors, keyed like the schema's issue paths. */
interface FieldErrors {
  body: 'short' | 'long' | null;
  rating_overall: boolean;
  rating_onboarding: boolean;
}

const NO_ERRORS: FieldErrors = { body: null, rating_overall: false, rating_onboarding: false };

/**
 * AECI-1613 (`STAGE_1_SPEC.md` §4.7a): one row's reviewer updates on `/account`
 * "Your reviews". Lists every update the reviewer added to this review, in any
 * status, with its badge, date and the moderator's reason. On an approved review
 * with no update waiting, it offers "Add an update", which opens an inline form.
 *
 * The form is a body textarea with a counter and an optional "Update my ratings"
 * toggle that reveals both star inputs. The ratings go together: both or neither,
 * which `SubmitReviewUpdateSchema` (`@aeci/shared`) checks here before the API
 * checks it again. The stars are the same Angular Aria listbox the review form
 * uses (`reviews/review-form.html`).
 *
 * A new update is `pending`, so on success the form closes and the "Add an
 * update" button stays hidden until AECi decides. The panel emits the new row so
 * the page can append it, and announces the outcome in its own polite region.
 * Browser-only like the rest of `/account`: nothing here runs during SSR.
 */
@Component({
  selector: 'aec-review-update-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecButton, DatePipe, Listbox, Option, ReviewStatusBadge],
  templateUrl: './review-update-panel.html',
})
export class ReviewUpdatePanel {
  private readonly api = inject(AccountApi);
  private readonly analytics = inject(Analytics);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly review = input.required<AccountReview>();
  /** The new pending update, for the page to append to the row. */
  readonly submitted = output<AccountReviewUpdate>();

  protected readonly bodyMin = REVIEW_UPDATE_BODY_MIN;
  protected readonly bodyMax = REVIEW_UPDATE_BODY_MAX;
  protected readonly stars = [1, 2, 3, 4, 5] as const;

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;

  protected readonly formOpen = signal(false);
  protected readonly body = signal('');
  protected readonly rerate = signal(false);
  protected readonly overallSel = signal<number[]>([]);
  protected readonly onboardingSel = signal<number[]>([]);
  protected readonly fieldErrors = signal<FieldErrors>(NO_ERRORS);
  protected readonly submitting = signal(false);
  protected readonly submitError = signal<SubmitError | null>(null);
  /** The panel's polite live region. It outlives the form, so the success
   *  message is still heard after the form closes. */
  protected readonly liveMessage = signal('');

  protected readonly updates = computed<readonly AccountReviewUpdate[]>(
    () => this.review().updates ?? [],
  );
  protected readonly hasPending = computed(() =>
    this.updates().some((u) => u.status === 'pending'),
  );
  /** Only a published review takes an update, and only one waits at a time. */
  protected readonly canAdd = computed(
    () => this.review().status === 'approved' && !this.hasPending(),
  );
  protected readonly bodyLength = computed(() => this.body().trim().length);

  protected readonly ids = computed(() => {
    const id = this.review().id;
    return {
      heading: `review-${id}-updates-heading`,
      form: `review-${id}-update-form`,
      body: `review-${id}-update-body`,
      bodyHint: `review-${id}-update-body-hint`,
      bodyError: `review-${id}-update-body-error`,
      rerate: `review-${id}-update-rerate`,
      overall: `review-${id}-update-overall`,
      overallError: `review-${id}-update-overall-error`,
      onboarding: `review-${id}-update-onboarding`,
      onboardingError: `review-${id}-update-onboarding-error`,
      open: `review-${id}-update-open`,
      list: `review-${id}-updates-list`,
    };
  });

  protected readonly submitErrorMessage = computed(() => {
    switch (this.submitError()) {
      case null:
        return '';
      case 'pending':
        return $localize`:@@account.reviews.update.error.pending:You already have an update waiting for us to check. You can add another once we have decided on it.`;
      case 'banned':
        return $localize`:@@account.reviews.update.error.banned:Your account can no longer post reviews or updates.`;
      case 'suspended':
        return $localize`:@@account.reviews.update.error.suspended:You can't add an update right now, because your company's vendor account is suspended. Check the notice we emailed to your company's owners and billing contact.`;
      case 'rateLimited':
        return $localize`:@@account.reviews.update.error.rateLimited:You've sent too many submissions for now. Wait a while, then send it again. Your text is still here.`;
      case 'notFound':
        return $localize`:@@account.reviews.update.error.notFound:We couldn't find this review, or it is no longer published. Reload the page to see where it stands.`;
      case 'invalid':
        return $localize`:@@account.reviews.update.error.invalid:Check your update and try again.`;
      case 'failed':
        return $localize`:@@account.reviews.update.error.failed:Something went wrong sending your update. Please try again.`;
    }
  });

  /** Screen-reader-only tail of the "Your updates" heading. It names the review,
   *  so each row's updates region has a unique accessible name. */
  protected headingContext(): string {
    const title = this.review().title;
    return $localize`:@@account.reviews.updates.context:to the review “${title}:TITLE:”`;
  }

  /** Accessible name for a star option. Built in TS because the value is dynamic. */
  protected starLabel(n: number): string {
    return n === 1
      ? $localize`:@@reviews.rating.star.one:1 star`
      : $localize`:@@reviews.rating.star.other:${n}:count: stars`;
  }

  protected bodyCounter(): string {
    const count = this.bodyLength();
    const max = REVIEW_UPDATE_BODY_MAX;
    return $localize`:@@account.reviews.update.counter:${count}:COUNT: of ${max}:MAX: characters`;
  }

  protected openForm(): void {
    this.reset();
    this.liveMessage.set('');
    this.formOpen.set(true);
    this.focusAfterRender(this.ids().body);
  }

  protected cancel(): void {
    this.formOpen.set(false);
    this.reset();
    this.focusAfterRender(this.ids().open);
  }

  protected onBodyInput(event: Event): void {
    this.body.set((event.target as HTMLTextAreaElement).value);
    if (this.fieldErrors().body) this.fieldErrors.update((e) => ({ ...e, body: null }));
  }

  protected onRerateChange(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.rerate.set(on);
    if (!on) {
      this.overallSel.set([]);
      this.onboardingSel.set([]);
    }
    this.fieldErrors.update((e) => ({ ...e, rating_overall: false, rating_onboarding: false }));
  }

  protected onOverallChange(): void {
    this.fieldErrors.update((e) => ({ ...e, rating_overall: false }));
  }

  protected onOnboardingChange(): void {
    this.fieldErrors.update((e) => ({ ...e, rating_onboarding: false }));
  }

  protected async submit(): Promise<void> {
    if (this.submitting()) return;
    this.submitError.set(null);
    const input: SubmitReviewUpdateInput = {
      body: this.body(),
      ...(this.rerate()
        ? {
            rating_overall: this.overallSel()[0] ?? null,
            rating_onboarding: this.onboardingSel()[0] ?? null,
          }
        : {}),
    };
    const parsed = SubmitReviewUpdateSchema.safeParse(input);
    // Ticking "Update my ratings" and choosing neither star is not "no re-rate":
    // the reviewer asked to re-rate, so both are required.
    const rerateEmpty =
      this.rerate() && input.rating_overall == null && input.rating_onboarding == null;
    if (!parsed.success || rerateEmpty) {
      const errors = fieldErrorsFrom(parsed.success ? [] : parsed.error.issues, this.bodyLength());
      if (rerateEmpty) {
        errors.rating_overall = true;
        errors.rating_onboarding = true;
      }
      this.fieldErrors.set(errors);
      this.focusAfterRender(this.firstInvalidId(errors));
      return;
    }
    this.fieldErrors.set(NO_ERRORS);
    this.submitting.set(true);
    try {
      const reviewId = this.review().id;
      const res = await this.api.submitReviewUpdate(reviewId, parsed.data);
      const rerated = parsed.data.rating_overall != null;
      this.analytics.reviewUpdateSubmitted({ product_id: this.review().product.id, rerated });
      this.formOpen.set(false);
      this.reset();
      this.liveMessage.set(
        $localize`:@@account.reviews.update.sent:Update sent. We check every update before it shows under your review on the product page.`,
      );
      this.submitted.emit(res.update);
      this.focusAfterRender(`review-update-${res.update.id}`);
    } catch (err) {
      this.submitError.set(submitErrorFrom(err));
    } finally {
      this.submitting.set(false);
    }
  }

  private firstInvalidId(errors: FieldErrors): string {
    const ids = this.ids();
    if (errors.body) return ids.body;
    if (errors.rating_overall) return ids.overall;
    return ids.onboarding;
  }

  private reset(): void {
    this.body.set('');
    this.rerate.set(false);
    this.overallSel.set([]);
    this.onboardingSel.set([]);
    this.fieldErrors.set(NO_ERRORS);
    this.submitError.set(null);
  }

  private focusAfterRender(elementId: string): void {
    afterNextRender(
      {
        write: () =>
          this.host.nativeElement.querySelector<HTMLElement>(`[id="${elementId}"]`)?.focus(),
      },
      { injector: this.injector },
    );
  }
}

function fieldErrorsFrom(
  issues: readonly { path: readonly PropertyKey[] }[],
  bodyLength: number,
): FieldErrors {
  const errors: FieldErrors = { ...NO_ERRORS };
  for (const issue of issues) {
    const key = issue.path[0];
    if (key === 'body') errors.body = bodyLength > REVIEW_UPDATE_BODY_MAX ? 'long' : 'short';
    if (key === 'rating_overall') errors.rating_overall = true;
    if (key === 'rating_onboarding') errors.rating_onboarding = true;
  }
  return errors;
}

function submitErrorFrom(err: unknown): SubmitError {
  if (!(err instanceof HttpErrorResponse)) return 'failed';
  const code = (err.error as { error?: { code?: unknown } } | null)?.error?.code;
  if (code === ApiErrorCode.REVIEW_UPDATE_PENDING) return 'pending';
  if (code === ApiErrorCode.REVIEW_BANNED) return 'banned';
  if (code === ApiErrorCode.VENDOR_SUSPENDED) return 'suspended';
  if (code === ApiErrorCode.RATE_LIMITED || err.status === 429) return 'rateLimited';
  if (err.status === 404) return 'notFound';
  if (err.status === 400) return 'invalid';
  return 'failed';
}
