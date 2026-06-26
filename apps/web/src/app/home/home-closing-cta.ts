import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';

import { SubscribeSubmitSchema, type SubscribeSubmit } from '@aeci/shared';

import { HomeFeedbackDialog } from './home-feedback-dialog';
import { LandingApi, buildAttribution } from './landing-api';

interface SubscribeModel {
  email: string;
}

type SubscribeStatus = 'idle' | 'subscribed' | 'exists' | 'error';

/**
 * §4.1 section 9 — the home's closing CTA + lead-capture island (AECI-275). The
 * successor to the landing funnel: email signup (`POST /api/subscribe`) plus a
 * "suggest a tool / share feedback" entry (`HomeFeedbackDialog` →
 * `POST /api/feedback`). Translated from the chosen concept **b** ("Warm
 * commerce") in `docs/design/unified-home-direction.md` — a full-bleed Bone band
 * (`--accent-warm`) wrapping the form in a bordered `--surface-base` card, Forest
 * subscribe button (Forest-Anchor Rule), borders not shadows.
 *
 * The one client-state surface on an otherwise static, edge-cache-neutral home
 * (§4.1 non-negotiables): the SSR HTML is the static form, and the POST only ever
 * fires from a user action against the non-cached `/api/*`, so the cached `/`
 * stays visitor-state-neutral. The email Signal Form validates against the shared
 * `SubscribeSubmitSchema`; UTM + referrer ride the body (`buildAttribution`), geo
 * is enriched server-side on trusted headers by the SSR proxy.
 *
 * The feedback dialog is `@defer`-loaded on the first "Suggest a tool" click, so
 * BrnDialog + the CDK overlay + the feedback form stay out of the home's initial
 * JS budget until asked for.
 */
@Component({
  selector: 'aec-home-closing-cta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [FormField, HomeFeedbackDialog],
  template: `
    <section class="bg-(--accent-warm)">
      <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
        <div
          class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-8 md:p-10"
        >
          <p class="aec-overline text-(--text-secondary)" i18n="@@home.cta.eyebrow">
            Stay in the loop
          </p>
          <h2
            class="mt-3 max-w-2xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
            i18n="@@home.cta.headline"
          >
            Get notified when we launch
          </h2>
          <p
            class="mt-4 max-w-xl text-base leading-relaxed text-(--text-secondary)"
            i18n="@@home.cta.body"
          >
            We're building this in the open. Drop your email for milestone updates. No spam, just
            progress.
          </p>

          <form class="mt-8 max-w-xl" novalidate (submit)="onSubmit($event)">
            <div class="flex flex-wrap gap-3">
              <label class="sr-only" for="home-cta-email" i18n="@@home.cta.email.label"
                >Email address</label
              >
              <input
                id="home-cta-email"
                type="email"
                autocomplete="email"
                [formField]="form.email"
                i18n-placeholder="@@home.cta.email.placeholder"
                placeholder="you@yourfirm.com"
                [attr.aria-invalid]="emailErrorShown() ? 'true' : null"
                [attr.aria-describedby]="emailErrorShown() ? 'home-cta-email-error' : null"
                class="min-w-0 flex-1 rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              />
              <button
                type="submit"
                [disabled]="submitDisabled()"
                class="rounded-(--radius-sm) bg-(--accent-primary) px-5 py-2 font-label text-white transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60"
              >
                @if (form().submitting()) {
                  <span i18n="@@home.cta.subscribing">Subscribing…</span>
                } @else {
                  <span i18n="@@home.cta.subscribe">Subscribe</span>
                }
              </button>
            </div>

            @if (emailErrorShown()) {
              <p
                id="home-cta-email-error"
                class="mt-2 text-sm font-medium text-(--text-primary)"
                role="alert"
                i18n="@@home.cta.email.error"
              >
                Enter a valid email address.
              </p>
            }

            <!-- Async result: kept in the DOM so the polite live region announces. -->
            <p class="mt-3 text-sm text-(--text-primary)" role="status" aria-live="polite">
              @switch (status()) {
                @case ('subscribed') {
                  <span i18n="@@home.cta.status.subscribed"
                    >You're on the list. We'll be in touch.</span
                  >
                }
                @case ('exists') {
                  <span i18n="@@home.cta.status.exists">You're already on the list.</span>
                }
                @case ('error') {
                  <span i18n="@@home.cta.status.error"
                    >Something went wrong. Please try again.</span
                  >
                }
              }
            </p>
          </form>

          <p class="mt-4 text-sm text-(--text-secondary)">
            <span i18n="@@home.cta.feedback.lead">Think we are missing a tool?</span>
            <button
              type="button"
              (click)="openFeedback()"
              class="ms-1 rounded-sm font-label text-(--accent-primary) underline decoration-1 underline-offset-4 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@home.cta.feedback.action"
            >
              Suggest a tool
            </button>
          </p>
        </div>
      </div>
    </section>

    <!-- Lazy: BrnDialog + overlay + the feedback form load only on first click. -->
    @defer (when feedbackOpen()) {
      <aec-home-feedback-dialog [open]="feedbackOpen()" (closed)="feedbackOpen.set(false)" />
    }
  `,
})
export class HomeClosingCta {
  private readonly api = inject(LandingApi);

  private readonly model = signal<SubscribeModel>({ email: '' });
  protected readonly form = form(this.model, (p) =>
    validateStandardSchema(p, SubscribeSubmitSchema),
  );

  protected readonly status = signal<SubscribeStatus>('idle');

  /** Show the inline email error once the field has been touched (blur/submit). */
  protected readonly emailErrorShown = computed(
    () => this.form.email().touched() && Boolean(this.form.email().getError('standardSchema')),
  );

  protected readonly submitDisabled = computed(
    () => this.form().invalid() || this.form().submitting(),
  );

  /** Drives the `@defer`-loaded feedback dialog. */
  protected readonly feedbackOpen = signal(false);

  protected openFeedback(): void {
    this.feedbackOpen.set(true);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.status.set('idle');
    await submit(this.form, async (f) => {
      try {
        const result = await this.api.subscribe(this.buildSubscribe(f().value()));
        this.status.set(result.created ? 'subscribed' : 'exists');
        if (result.created) this.model.set({ email: '' });
      } catch {
        // Retryable notice, not a ValidationError (which would disable submit).
        this.status.set('error');
      }
      return undefined;
    });
  }

  private buildSubscribe(v: SubscribeModel): SubscribeSubmit {
    const { utm_source, utm_medium, utm_campaign, referrer } = buildAttribution();
    return { email: v.email.trim(), utm_source, utm_medium, utm_campaign, referrer };
  }
}
