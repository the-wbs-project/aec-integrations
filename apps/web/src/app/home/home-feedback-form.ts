import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';

import { FeedbackSubmitSchema, type FeedbackSubmit, type SubscribeSubmit } from '@aeci/shared';

import { LandingApi, buildAttribution } from '../shared/landing/landing-api';

/** Standard-schema-validated subset of the feedback form. Only `features` /
 *  `tools` live in the Signal Forms model so `FeedbackSubmitSchema`'s `.refine`
 *  ("at least one of features or tools") drives validity. `email` (optional) and
 *  `subscribed` are held as standalone signals and merged at submit — mirroring
 *  `reviews/review-form.ts`, and sidestepping the empty-string-vs-`.email()` trap
 *  an optional email field in the model would hit. */
interface FeedbackModel {
  features: string;
  tools: string;
}

/** Loose check for the OPTIONAL feedback email — present-but-invalid blocks submit,
 *  empty is fine. The server schemas are the real validators; this is the client
 *  guard, mirroring `review-form`'s manual `parseYears`. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The "suggest a tool / share feedback" form body (AECI-275), ported from the
 * legacy `apps/landing` feedback modal. A standalone component — like
 * `requests/request-form-body.ts` — so it is testable in isolation and so
 * `HomeFeedbackDialog` can `@defer` it (BrnDialog shell stays thin; the form +
 * its second Zod schema load only when the dialog opens).
 *
 * Posts `POST /api/feedback` (`LandingApi`). Parity with the landing: when the
 * visitor ticks the mailing-list opt-in AND gives an email, we ALSO best-effort
 * `POST /api/subscribe` so the opt-in lands in `mailing_list` (the feedback row
 * only records the `subscribed` flag, it doesn't create a list entry). UTM /
 * referrer ride the body via `buildAttribution`; geo is enriched server-side on
 * trusted headers by the SSR proxy. Emits `done` on a successful submit so the
 * host dialog can close.
 */
@Component({
  selector: 'aec-home-feedback-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [FormField],
  template: `
    @if (submitted()) {
      <p
        class="rounded-(--radius-md) border border-(--border-default) bg-(--accent-warm) px-4 py-3 text-sm font-medium text-(--text-primary)"
        role="status"
        aria-live="polite"
        i18n="@@home.feedback.status.success"
      >
        Thanks. We read every suggestion.
      </p>
    } @else {
      <form class="flex flex-col gap-5" novalidate (submit)="onSubmit($event)">
        <!-- Feature ideas -->
        <div class="flex flex-col gap-1.5">
          <label
            for="home-feedback-features"
            class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
            i18n="@@home.feedback.features.label"
            >Features to build</label
          >
          <textarea
            id="home-feedback-features"
            rows="3"
            [formField]="form.features"
            i18n-placeholder="@@home.feedback.features.placeholder"
            placeholder="What capabilities would help your work?"
            [attr.aria-invalid]="atLeastOneError() ? 'true' : null"
            [attr.aria-describedby]="atLeastOneError() ? 'home-feedback-fields-error' : null"
            class="w-full resize-y rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          ></textarea>
        </div>

        <!-- Tool ideas -->
        <div class="flex flex-col gap-1.5">
          <label
            for="home-feedback-tools"
            class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
            i18n="@@home.feedback.tools.label"
            >Tools to cover</label
          >
          <textarea
            id="home-feedback-tools"
            rows="3"
            [formField]="form.tools"
            i18n-placeholder="@@home.feedback.tools.placeholder"
            placeholder="Which AEC tools should we add? e.g. Procore, Bluebeam, Revit"
            [attr.aria-invalid]="atLeastOneError() ? 'true' : null"
            [attr.aria-describedby]="atLeastOneError() ? 'home-feedback-fields-error' : null"
            class="w-full resize-y rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          ></textarea>
        </div>

        @if (atLeastOneError()) {
          <p
            id="home-feedback-fields-error"
            class="-mt-2 text-xs font-medium text-(--text-primary)"
            role="alert"
            i18n="@@home.feedback.fields.error"
          >
            Add at least one feature or tool.
          </p>
        }

        <!-- Email (optional) -->
        <div class="flex flex-col gap-1.5">
          <label
            for="home-feedback-email"
            class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
            i18n="@@home.feedback.email.label"
            >Email (optional)</label
          >
          <input
            id="home-feedback-email"
            type="email"
            autocomplete="email"
            [value]="email()"
            (input)="onEmailInput($event)"
            i18n-placeholder="@@home.feedback.email.placeholder"
            placeholder="you@yourfirm.com"
            [attr.aria-invalid]="emailInvalid() ? 'true' : null"
            [attr.aria-describedby]="emailInvalid() ? 'home-feedback-email-error' : null"
            class="w-full rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          />
          @if (emailInvalid()) {
            <p
              id="home-feedback-email-error"
              class="text-xs font-medium text-(--text-primary)"
              role="alert"
              i18n="@@home.feedback.email.error"
            >
              Enter a valid email address.
            </p>
          }
        </div>

        <!-- Mailing-list opt-in -->
        <label class="flex items-center gap-2.5 text-sm text-(--text-secondary)">
          <input
            type="checkbox"
            [checked]="subscribed()"
            (change)="onSubscribedChange($event)"
            class="size-4 rounded-(--radius-sm) border-(--border-strong) text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          />
          <span i18n="@@home.feedback.optin">Email me launch updates too</span>
        </label>

        <div class="flex items-center gap-4">
          <button
            type="submit"
            [disabled]="submitDisabled()"
            class="rounded-(--radius-sm) bg-(--accent-primary) px-5 py-2 font-label text-white transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60"
          >
            @if (form().submitting()) {
              <span i18n="@@home.feedback.submitting">Sending…</span>
            } @else {
              <span i18n="@@home.feedback.submit">Send feedback</span>
            }
          </button>
        </div>

        @if (submitFailed()) {
          <p
            class="text-sm font-medium text-(--text-primary)"
            role="alert"
            aria-live="polite"
            i18n="@@home.feedback.status.error"
          >
            Something went wrong. Please try again.
          </p>
        }
      </form>
    }
  `,
})
export class HomeFeedbackForm {
  private readonly api = inject(LandingApi);

  /** Emitted on a successful submit so the host dialog can close. */
  readonly done = output<void>();

  private readonly model = signal<FeedbackModel>({ features: '', tools: '' });
  protected readonly form = form(this.model, (p) =>
    validateStandardSchema(p, FeedbackSubmitSchema),
  );

  /** Standalone optional fields (see `FeedbackModel`). */
  protected readonly email = signal('');
  protected readonly subscribed = signal(false);

  protected readonly submitted = signal(false);
  protected readonly submitFailed = signal(false);

  /** The `.refine` ("at least one of features/tools") error, shown once either
   *  field is touched so a pristine form doesn't shout. */
  protected readonly atLeastOneError = computed(
    () =>
      (this.form.features().touched() || this.form.tools().touched()) &&
      Boolean(this.form.features().getError('standardSchema')),
  );

  /** Present-but-invalid optional email. */
  protected readonly emailInvalid = computed(() => {
    const v = this.email().trim();
    return v !== '' && !EMAIL_RE.test(v);
  });

  protected readonly submitDisabled = computed(
    () => this.form().invalid() || this.emailInvalid() || this.form().submitting(),
  );

  protected onEmailInput(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  protected onSubscribedChange(event: Event): void {
    this.subscribed.set((event.target as HTMLInputElement).checked);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.submitFailed.set(false);
    await submit(this.form, async (f) => {
      try {
        await this.api.submitFeedback(this.buildFeedback(f().value()));
        // Parity with the landing: the feedback row only flags `subscribed`; the
        // opt-in itself lands in `mailing_list` via a best-effort piggyback.
        const email = this.email().trim();
        if (this.subscribed() && email) {
          void this.api.subscribe(this.buildSubscribe(email)).catch(() => undefined);
        }
        this.submitted.set(true);
        this.done.emit();
      } catch {
        // Retryable notice, not a ValidationError (which would disable submit).
        this.submitFailed.set(true);
      }
      return undefined;
    });
  }

  private buildFeedback(v: FeedbackModel): FeedbackSubmit {
    const email = this.email().trim();
    const { referrer } = buildAttribution();
    return {
      features: v.features.trim() || undefined,
      tools: v.tools.trim() || undefined,
      ...(email ? { email } : {}),
      subscribed: this.subscribed(),
      referrer,
    };
  }

  private buildSubscribe(email: string): SubscribeSubmit {
    const { utm_source, utm_medium, utm_campaign, referrer } = buildAttribution();
    return { email, utm_source, utm_medium, utm_campaign, referrer };
  }
}
