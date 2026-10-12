import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormField, form, maxLength, submit, validateStandardSchema } from '@angular/forms/signals';

import { PLAN_INQUIRY_LIMITS, PlanInquirySubmitSchema, type PlanInquirySubmit } from '@aeci/shared';

import { Analytics, type PlanCtaPage, type PlanInquiryPlacement } from '../../analytics/analytics';
import { SessionStatus } from '../../auth/session-status';
import { LandingApi, buildAttribution } from '../landing/landing-api';

/** The fields the visitor fills. The honeypot is held apart, see `website`. */
interface PlanInquiryModel {
  topic: 'managed';
  email: string;
  company: string;
  details: string;
}

/**
 * The "Talk to us about Managed" form (AECI-1279). Rendered in the Plans page dialog
 * (`PlanInquiryDialog`) and inline on `/contact?topic=managed`. Posts
 * `POST /api/plan-inquiries`, which saves the inquiry, sends the visitor a receipt and
 * alerts the support inbox.
 *
 * - **Email prefill.** A signed-in visitor's address fills the field once, through the
 *   one-shot latch `requests/request-form-body.ts` uses, so it never overwrites what
 *   they typed or cleared. `SessionStatus.email()` is `null` in SSR, so the server HTML
 *   stays visitor-neutral.
 * - **Validation** is the shared `PlanInquirySubmitSchema`, through Signal Forms. Errors
 *   show once a field is touched, and every field is touched on submit.
 * - **Honeypot.** A visually hidden `website` field, out of the tab order and hidden
 *   from assistive technology. Only a bot fills it. The server answers it like a real
 *   submit and saves nothing.
 * - **Outcome.** Success swaps the form for a status line. A failed request keeps the
 *   answers and shows a retryable error. Success fires `plan_inquiry_submitted`.
 *
 * Every string is `i18n` / `$localize`. Light only.
 */
@Component({
  selector: 'aec-plan-inquiry-form',
  host: { class: 'block' },
  imports: [FormField],
  template: `
    @if (sent()) {
      <p
        class="rounded-(--radius-md) border border-(--border-default) bg-(--accent-warm) px-4 py-3 text-sm font-medium text-(--text-primary)"
        role="status"
        data-testid="plan-inquiry-success"
        i18n="@@planInquiry.status.success"
      >
        Thanks. We reply to most messages within a couple of business days.
      </p>
    } @else {
      <form class="flex flex-col gap-5" novalidate (submit)="onSubmit($event)">
        <div class="flex flex-col gap-1.5">
          <label
            [for]="idPrefix() + '-email'"
            class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
            i18n="@@planInquiry.email.label"
            >Email</label
          >
          <input
            [id]="idPrefix() + '-email'"
            type="email"
            inputmode="email"
            autocomplete="email"
            [formField]="form.email"
            [attr.aria-invalid]="emailError() ? 'true' : null"
            [attr.aria-describedby]="emailError() ? idPrefix() + '-email-error' : null"
            class="w-full rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          />
          @if (emailError()) {
            <p
              [id]="idPrefix() + '-email-error'"
              class="text-xs font-medium text-(--text-primary)"
              role="alert"
              i18n="@@planInquiry.email.error"
            >
              Enter a valid email address.
            </p>
          }
        </div>

        <div class="flex flex-col gap-1.5">
          <label
            [for]="idPrefix() + '-company'"
            class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
            i18n="@@planInquiry.company.label"
            >Company</label
          >
          <input
            [id]="idPrefix() + '-company'"
            type="text"
            autocomplete="organization"
            [formField]="form.company"
            [attr.aria-invalid]="companyError() ? 'true' : null"
            [attr.aria-describedby]="companyError() ? idPrefix() + '-company-error' : null"
            class="w-full rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          />
          @if (companyError()) {
            <p
              [id]="idPrefix() + '-company-error'"
              class="text-xs font-medium text-(--text-primary)"
              role="alert"
              i18n="@@planInquiry.company.error"
            >
              Enter your company name.
            </p>
          }
        </div>

        <div class="flex flex-col gap-1.5">
          <label
            [for]="idPrefix() + '-details'"
            class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
          >
            <span i18n="@@planInquiry.details.label"
              >Which products, and anything we should know?</span
            >
            <span
              class="font-normal normal-case tracking-normal text-(--text-secondary)"
              i18n="@@planInquiry.details.optional"
            >
              (optional)</span
            >
          </label>
          <textarea
            [id]="idPrefix() + '-details'"
            rows="4"
            [formField]="form.details"
            [attr.aria-invalid]="detailsError() ? 'true' : null"
            [attr.aria-describedby]="detailsError() ? idPrefix() + '-details-error' : null"
            class="w-full resize-y rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          ></textarea>
          @if (detailsError()) {
            <p
              [id]="idPrefix() + '-details-error'"
              class="text-xs font-medium text-(--text-primary)"
              role="alert"
              i18n="@@planInquiry.details.error"
            >
              Keep this under 2,000 characters.
            </p>
          }
        </div>

        <!-- Honeypot: hidden from people and from assistive technology. -->
        <div class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">
          <label [for]="idPrefix() + '-website'" i18n="@@planInquiry.honeypot.label">Website</label>
          <input
            [id]="idPrefix() + '-website'"
            type="text"
            name="website"
            tabindex="-1"
            autocomplete="off"
            [value]="website()"
            (input)="onWebsiteInput($event)"
          />
        </div>

        @if (failed()) {
          <p
            class="text-sm font-medium text-(--text-primary)"
            role="alert"
            data-testid="plan-inquiry-error"
            i18n="@@planInquiry.status.error"
          >
            We could not send that. Check your connection and try again.
          </p>
        }

        <div>
          <button
            type="submit"
            [disabled]="form().submitting()"
            class="rounded-(--radius-md) bg-(--accent-primary) px-5 py-2.5 text-sm font-semibold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60"
          >
            @if (form().submitting()) {
              <span i18n="@@planInquiry.submitting">Sending…</span>
            } @else if (failed()) {
              <span i18n="@@planInquiry.retry">Try again</span>
            } @else {
              <span i18n="@@planInquiry.submit">Send</span>
            }
          </button>
        </div>
      </form>
    }
  `,
})
export class PlanInquiryForm {
  private readonly api = inject(LandingApi);
  private readonly analytics = inject(Analytics);
  private readonly session = inject(SessionStatus);

  /** Which button sent the visitor here, for `plan_inquiry_submitted`. */
  readonly placement = input.required<PlanInquiryPlacement>();
  /**
   * The page of the button that opened the dialog, for `plan_inquiry_submitted`.
   * Left unset on `/contact`, which is no plan page, so the event carries no `page`.
   */
  readonly page = input<PlanCtaPage | undefined>(undefined);
  /** Keeps element ids unique if two forms ever share a page. */
  readonly idPrefix = input('plan-inquiry');

  private readonly model = signal<PlanInquiryModel>({
    topic: 'managed',
    email: '',
    company: '',
    details: '',
  });
  protected readonly form = form(this.model, (p) => {
    validateStandardSchema(p, PlanInquirySubmitSchema);
    // Mirrors the schema's limits onto the native `maxlength` attributes.
    maxLength(p.email, PLAN_INQUIRY_LIMITS.email);
    maxLength(p.company, PLAN_INQUIRY_LIMITS.company);
    maxLength(p.details, PLAN_INQUIRY_LIMITS.details);
  });

  /** The honeypot. Outside the model, so it can never block a real visitor. */
  protected readonly website = signal('');
  protected readonly sent = signal(false);
  protected readonly failed = signal(false);

  protected readonly emailError = computed(
    () => this.form.email().touched() && this.form.email().invalid(),
  );
  protected readonly companyError = computed(
    () => this.form.company().touched() && this.form.company().invalid(),
  );
  protected readonly detailsError = computed(
    () => this.form.details().touched() && this.form.details().invalid(),
  );

  /** One-shot: a later `email()` emission must never overwrite the visitor's own edit. */
  private prefilledEmail = false;

  constructor() {
    effect(() => {
      const email = this.session.email();
      if (!email) return;
      untracked(() => {
        if (this.prefilledEmail || this.model().email) return;
        this.prefilledEmail = true;
        this.model.update((m) => ({ ...m, email }));
      });
    });
  }

  protected onWebsiteInput(event: Event): void {
    this.website.set((event.target as HTMLInputElement).value);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    await submit(this.form, async (f) => {
      this.failed.set(false);
      try {
        await this.api.submitPlanInquiry(this.body(f().value()));
        this.sent.set(true);
        const page = this.page();
        this.analytics.planInquirySubmitted({
          topic: 'managed',
          placement: this.placement(),
          ...(page ? { page } : {}),
        });
      } catch {
        // Retryable: the answers stay, and the button reads "Try again".
        this.failed.set(true);
      }
      return undefined;
    });
  }

  private body(v: PlanInquiryModel): PlanInquirySubmit {
    const details = v.details.trim();
    const website = this.website().trim();
    return {
      topic: v.topic,
      email: v.email.trim(),
      company: v.company.trim(),
      ...(details ? { details } : {}),
      ...(website ? { website } : {}),
      referrer: buildAttribution().referrer,
    };
  }
}
