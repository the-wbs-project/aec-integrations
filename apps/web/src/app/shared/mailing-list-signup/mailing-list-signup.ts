import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';

import { SubscribeSubmitSchema, type SubscribeSubmit } from '@aeci/shared';

import { Analytics } from '../../analytics/analytics';
import { LandingApi, buildAttribution } from '../landing/landing-api';

interface SubscribeModel {
  email: string;
}

type SubscribeStatus = 'idle' | 'subscribed' | 'exists' | 'error';

/** Shared button classes. The confirmed ("Subscribed") state flips the solid
 *  Forest fill to a Forest-soft treatment (Forest-Anchor Rule: no new accent
 *  color) so a completed signup reads unmistakably as done. */
const BTN_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-(--radius-sm) px-5 py-2 font-label transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed';

/**
 * The shared mailing-list signup band (AECI-327). Extracted from the home
 * closing-CTA island (§4.1 section 9, AECI-275) so the same prominent signup can
 * ride the directory + detail pages, not just the home page, and stop leaking
 * hard-won traffic. Mounted as a full-bleed sibling above the global site footer
 * on `/products`, the taxonomy browse + index pages, and the product / vendor /
 * integration-pair detail pages; the home closing-CTA composes it too
 * (`home/home-closing-cta.ts`), projecting its "suggest a tool" prompt into the
 * trailing `<ng-content>` slot.
 *
 * A client-state island on otherwise static, edge-cache-neutral routes: the SSR
 * HTML is the static form, and the POST only ever fires from a user action against
 * the non-cached `/api/*`, so the cached pages stay visitor-state-neutral. The
 * email Signal Form validates against the shared `SubscribeSubmitSchema`; UTM +
 * referrer ride the body (`buildAttribution`), geo is enriched server-side on
 * trusted headers by the SSR proxy.
 *
 * Design: the chosen concept **b** ("Warm commerce") from
 * `docs/design/unified-home-direction.md` — a full-bleed Bone band
 * (`--accent-warm`) wrapping the form in a bordered `--surface-base` card, Forest
 * subscribe button (Forest-Anchor Rule), borders not shadows.
 */
@Component({
  selector: 'aec-mailing-list-signup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [FormField],
  template: `
    <section class="bg-(--accent-warm)">
      <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
        <div
          class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-8 md:p-10"
        >
          <p class="aec-overline text-(--text-secondary)" i18n="@@mailing-list-signup.eyebrow">
            Directory updates
          </p>
          <h2
            class="mt-3 max-w-2xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
            i18n="@@mailing-list-signup.headline"
          >
            Know when new tools and reviews land
          </h2>
          <p
            class="mt-4 max-w-xl text-base leading-relaxed text-(--text-secondary)"
            i18n="@@mailing-list-signup.body"
          >
            AEC Integrations is live and still growing. Add your email for occasional updates as we
            expand the directory with new tools, integrations, and reviews.
          </p>

          <form class="mt-8 max-w-xl" novalidate (submit)="onSubmit($event)">
            <div class="flex flex-wrap gap-3">
              <label
                class="sr-only"
                for="mailing-list-email"
                i18n="@@mailing-list-signup.email.label"
                >Email address</label
              >
              <input
                id="mailing-list-email"
                type="email"
                autocomplete="email"
                [formField]="form.email"
                (input)="onEmailEdit()"
                i18n-placeholder="@@mailing-list-signup.email.placeholder"
                placeholder="you@yourfirm.com"
                [attr.aria-invalid]="emailErrorShown() ? 'true' : null"
                [attr.aria-describedby]="emailErrorShown() ? 'mailing-list-email-error' : null"
                class="min-w-0 flex-1 rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              />
              <button
                type="submit"
                [disabled]="submitDisabled() || subscribed()"
                [class]="buttonClass()"
              >
                @if (subscribed()) {
                  <svg
                    class="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span i18n="@@mailing-list-signup.subscribed">Subscribed</span>
                } @else if (form().submitting()) {
                  <span i18n="@@mailing-list-signup.subscribing">Subscribing…</span>
                } @else {
                  <span i18n="@@mailing-list-signup.subscribe">Subscribe</span>
                }
              </button>
            </div>

            @if (emailErrorShown()) {
              <p
                id="mailing-list-email-error"
                class="mt-2 text-sm font-medium text-(--text-primary)"
                role="alert"
                i18n="@@mailing-list-signup.email.error"
              >
                Enter a valid email address.
              </p>
            }

            <!-- Async result: kept in the DOM so the polite live region announces. -->
            <p class="mt-3 text-sm text-(--text-primary)" role="status" aria-live="polite">
              @switch (status()) {
                @case ('subscribed') {
                  <span
                    class="font-medium text-(--accent-primary)"
                    i18n="@@mailing-list-signup.status.subscribed"
                    >You're on the list. We'll email when there's something new.</span
                  >
                }
                @case ('exists') {
                  <span i18n="@@mailing-list-signup.status.exists"
                    >You're already on the list.</span
                  >
                }
                @case ('error') {
                  <span i18n="@@mailing-list-signup.status.error"
                    >Something went wrong. Please try again.</span
                  >
                }
              }
            </p>
          </form>

          <!-- Optional trailing content (e.g. the home page's "suggest a tool" prompt). -->
          <ng-content />
        </div>
      </div>
    </section>
  `,
})
export class MailingListSignup {
  private readonly api = inject(LandingApi);
  private readonly analytics = inject(Analytics);

  /** Capture surface for the AECI-326 `mailing_list_signup` conversion event —
   *  the home closing-CTA passes `'home_closing_cta'`; the directory + detail
   *  mounts keep the default so their signups are still tracked, distinctly. */
  readonly source = input('mailing_list_band');

  private readonly model = signal<SubscribeModel>({ email: '' });
  protected readonly form = form(this.model, (p) =>
    validateStandardSchema(p, SubscribeSubmitSchema),
  );

  protected readonly status = signal<SubscribeStatus>('idle');

  /** A completed signup flips the button to a confirmed, non-interactive state. */
  protected readonly subscribed = computed(() => this.status() === 'subscribed');

  /** Show the inline email error once the field has been touched (blur/submit). */
  protected readonly emailErrorShown = computed(
    () => this.form.email().touched() && Boolean(this.form.email().getError('standardSchema')),
  );

  protected readonly submitDisabled = computed(
    () => this.form().invalid() || this.form().submitting(),
  );

  protected readonly buttonClass = computed(() =>
    this.subscribed()
      ? `${BTN_BASE} border border-(--accent-primary) bg-(--accent-primary-soft) text-(--accent-primary)`
      : `${BTN_BASE} bg-(--accent-primary) text-white hover:bg-(--accent-primary-hover) disabled:opacity-60`,
  );

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.status.set('idle');
    await submit(this.form, async (f) => {
      try {
        const result = await this.api.subscribe(this.buildSubscribe(f().value()));
        // Keep the entered email in the field. Clearing it to '' would leave the
        // still-touched field invalid, re-firing the "enter a valid email" error
        // right next to the success message. The confirmed button + live region
        // carry the result; onEmailEdit resets the state if the address changes.
        this.status.set(result.created ? 'subscribed' : 'exists');
        if (result.created) {
          // Track the conversion (AECI-326). Consent-gated + fire-and-forget: it
          // no-ops without consent and never throws into the submit. Only a genuine
          // new signup counts — an already-listed email (created:false) is not.
          this.analytics.mailingListSignup({ source: this.source() });
        }
      } catch {
        // Retryable notice, not a ValidationError (which would disable submit).
        this.status.set('error');
      }
      return undefined;
    });
  }

  /** Editing the address clears any terminal notice, so a follow-up email can be
   *  subscribed and the button returns to its default "Subscribe" state. */
  protected onEmailEdit(): void {
    if (this.status() !== 'idle') this.status.set('idle');
  }

  private buildSubscribe(v: SubscribeModel): SubscribeSubmit {
    const { utm_source, utm_medium, utm_campaign, referrer } = buildAttribution();
    return { email: v.email.trim(), utm_source, utm_medium, utm_campaign, referrer };
  }
}
