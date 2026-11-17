import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';

import { SubscribeSubmitSchema, type FoundVia, type SubscribeSubmit } from '@aeci/shared';

import { AecButton } from '../button/button';
import { BAND_WRAP_CLASS } from '../band-wrap';
import { AecCard } from '../card/card';
import { Analytics } from '../../analytics/analytics';
import { FoundViaField } from '../found-via/found-via-field';
import { LandingApi, buildAttribution } from '../landing/landing-api';
import { isReplayedEvent } from '../../core/event-replay';
import { AecIcon } from '../icon/icon';

interface SubscribeModel {
  email: string;
  /** "How did you find AEC Integrations?" (AECI-1063). `''` = not answered. */
  found_via: '' | FoundVia;
  found_via_detail: string;
}

type SubscribeStatus = 'idle' | 'subscribed' | 'exists' | 'error';

/**
 * The shared mailing-list signup band (AECI-327). Extracted from the former home
 * closing-CTA island (AECI-275) so the same prominent signup can ride the
 * directory + detail pages and stop leaking hard-won traffic. Mounted as a
 * full-bleed sibling above the global site footer on `/products`, the taxonomy
 * browse + index pages, and the product / vendor / integration-pair detail pages.
 * The home does not mount it: the signup left the home in AECI-1564. `/updates`
 * has its own form. Optional trailing content projects into the `<ng-content>` slot.
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
 * (`--accent-warm`) wrapping the form in a white card, Forest subscribe button
 * (Forest-Anchor Rule). The controls take borders, not shadows.
 *
 * `ground="white"` is for a page on the detail band shell (AECI-1778, DESIGN.md §4 "The
 * detail page band shell"), which already has its one Bone band. The band is then white,
 * with a hairline `border-default` rule above it, and the card is unchanged.
 *
 * **Redesign (AECI-1799).** The band sits on the 1328px page wrap (`BAND_WRAP_CLASS`)
 * with the Bone band's rhythm, 64px above and below, 96px from `md`. The card is the
 * shared `aecCard` (24px radius, the card shadow, no hairline), with the home closing
 * card's padding. The headline is the Section role on an inner span, because the
 * unlayered `h2` rule beats a size utility on the element. The field, the button, the
 * words, the validation, the POST and the analytics event are unchanged.
 *
 * **Two columns (AECI-1720 restore).** From `lg` the card splits: the words on the left,
 * the form on the right, so the card never leaves its right half blank. Below `lg` they
 * stack as before. The Subscribe button is enabled until a submit is in flight or done.
 */
@Component({
  selector: 'aec-mailing-list-signup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [AecButton, AecCard, AecIcon, FormField, FoundViaField],
  template: `
    <section [class]="groundClass()">
      <div [class]="wrap">
        <div
          aecCard
          class="p-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)] lg:items-center lg:gap-x-12 lg:p-12"
          data-testid="mailing-list-card"
        >
          <div class="min-w-0">
            <p class="aec-overline text-(--text-secondary)" i18n="@@mailing-list-signup.eyebrow">
              Directory updates
            </p>
            <h2 class="mt-3 max-w-2xl text-(--text-primary)">
              <span
                class="block text-t-36 leading-[1.1] tracking-[-0.02em]"
                i18n="@@mailing-list-signup.headline"
                >Know when new tools and reviews land</span
              >
            </h2>
            <p
              class="mt-4 max-w-xl text-t-16 leading-relaxed text-(--text-secondary)"
              i18n="@@mailing-list-signup.body"
            >
              AEC Integrations is live and still growing. Add your email for occasional updates as
              we expand the directory with new tools, integrations, and reviews.
            </p>
          </div>

          <form class="mt-8 max-w-xl min-w-0 lg:mt-0" novalidate (submit)="onSubmit($event)">
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
                class="aec-field-control min-w-0 flex-1 rounded-control border bg-(--surface-base) px-4 py-2 text-t-16 text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              />
              <button
                aecButton
                type="submit"
                [variant]="subscribed() ? 'secondary' : 'primary'"
                [disabled]="form().submitting() || subscribed()"
              >
                @if (subscribed()) {
                  <aec-icon name="check" decorative [size]="4" />
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
                class="aec-field-error mt-2 text-t-14 font-semibold text-(--status-error)"
                role="alert"
                i18n="@@mailing-list-signup.email.error"
              >
                Enter a valid email address.
              </p>
            }

            <!-- The optional "How did you find us?" question (AECI-1063). It goes
                 in the same POST as the email and never blocks the submit. -->
            <aec-found-via-field
              class="mt-5"
              idPrefix="mailing-list-found-via"
              [value]="form.found_via().value()"
              (valueChange)="form.found_via().value.set($event)"
              [detail]="form.found_via_detail().value()"
              (detailChange)="form.found_via_detail().value.set($event)"
            />

            <!-- Async result: kept in the DOM so the polite live region announces.
                 The notice renders as a bordered callout (the site's existing
                 home-feedback success-notice pattern) so a completed signup is
                 impossible to miss against the card. -->
            <div role="status" aria-live="polite">
              @switch (status()) {
                @case ('subscribed') {
                  <p
                    class="aec-notice-success mt-4 flex items-start gap-2.5 rounded-(--radius-md) border bg-(--accent-primary-soft) px-4 py-3 text-sm font-semibold text-(--accent-primary)"
                  >
                    <span class="mt-0.5 flex shrink-0">
                      <aec-icon name="check" decorative [size]="4" />
                    </span>
                    <span i18n="@@mailing-list-signup.status.subscribed"
                      >You're on the list. We'll email when there's something new.</span
                    >
                  </p>
                }
                @case ('exists') {
                  <p
                    class="aec-notice-neutral mt-4 flex items-start gap-2.5 rounded-(--radius-md) border bg-(--accent-warm) px-4 py-3 text-sm font-semibold text-(--text-primary)"
                  >
                    <span class="mt-0.5 flex shrink-0">
                      <aec-icon name="info" decorative [size]="4" />
                    </span>
                    <span i18n="@@mailing-list-signup.status.exists"
                      >You're already on the list.</span
                    >
                  </p>
                }
                @case ('error') {
                  <p
                    class="aec-notice-error mt-4 flex items-start gap-2.5 rounded-(--radius-md) border bg-(--surface-base) px-4 py-3 text-sm font-semibold text-(--status-error)"
                  >
                    <span class="mt-0.5 flex shrink-0">
                      <aec-icon name="alert-circle" decorative [size]="4" />
                    </span>
                    <span i18n="@@mailing-list-signup.status.error"
                      >Something went wrong. Please try again.</span
                    >
                  </p>
                }
              }
            </div>
          </form>

          <!-- Optional trailing content (e.g. the home page's "suggest a tool" prompt). It
               spans both columns from lg. -->
          <div class="empty:hidden lg:col-span-2">
            <ng-content />
          </div>
        </div>
      </div>
    </section>
  `,
})
export class MailingListSignup {
  private readonly api = inject(LandingApi);
  private readonly analytics = inject(Analytics);

  /** Capture surface for the AECI-326 `mailing_list_signup` conversion event —
   *  the directory + detail mounts keep the default. `'home_closing_cta'` is a
   *  retained value no longer emitted: the home stopped mounting the band in
   *  AECI-1564. */
  readonly source = input('mailing_list_band');

  /** `bone` (default) is the shipped band. `white` keeps a band-shell page to one Bone band. */
  readonly ground = input<'bone' | 'white'>('bone');

  /**
   * The band ground. Bone is the shared Bone band's look (`aec-bone-band` is the
   * unlayered class that gives it an edge under forced colours, as on the detail
   * layout's lead band). The element is not used, so its one-per-page dev check
   * keeps counting only real page bands.
   */
  protected readonly groundClass = computed(() =>
    this.ground() === 'white'
      ? 'block border-t bg-(--surface-base)'
      : 'aec-bone-band block bg-(--accent-warm)',
  );

  /** The page wrap and the band rhythm of `aec-bone-band`: 64px, 96px from `md`. */
  protected readonly wrap = `${BAND_WRAP_CLASS} py-16 md:py-24`;

  private readonly model = signal<SubscribeModel>({
    email: '',
    found_via: '',
    found_via_detail: '',
  });
  protected readonly form = form(this.model, (p) =>
    validateStandardSchema(p, SubscribeSubmitSchema),
  );

  protected readonly status = signal<SubscribeStatus>('idle');

  /** A completed signup flips the button to a confirmed, non-interactive state. */
  protected readonly subscribed = computed(() => this.status() === 'subscribed');

  /** Show the inline email error once the field has been touched (blur/submit) —
   *  but only when it actually holds text. Blurring an empty field (clicked in,
   *  clicked away without typing) marks it touched and technically-invalid, yet
   *  nagging "enter a valid email" on an empty box is noise, not help. */
  protected readonly emailErrorShown = computed(() => {
    const email = this.form.email();
    return (
      email.touched() &&
      (email.value().trim().length > 0 || this.submitAttempted()) &&
      Boolean(email.getError('standardSchema'))
    );
  });

  /**
   * Set by a submit. The button stays enabled while the email is empty or invalid, so it
   * never reads as switched off (AECI-1720 restore: the pale disabled button read as
   * broken). A submit with a bad email shows the inline error and posts nothing.
   */
  private readonly submitAttempted = signal(false);

  protected async onSubmit(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return; // the native default already ran
    event.preventDefault();
    this.status.set('idle');
    this.submitAttempted.set(true);
    await submit(this.form, {
      // A submit with an empty or invalid email posts nothing. Focus moves to the field,
      // so a screen reader hears its error through aria-describedby even on a second
      // try, when the role="alert" line is already on the page and stays silent.
      onInvalid: (f) => f.email().focusBoundControl(),
      action: async (f) => {
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
            this.analytics.mailingListSignup({
              source: this.source(),
              found_via: f().value().found_via || null,
            });
          }
        } catch {
          // Retryable notice, not a ValidationError (which would disable submit).
          this.status.set('error');
        }
        return undefined;
      },
    });
  }

  /** Editing the address clears any terminal notice, so a follow-up email can be
   *  subscribed and the button returns to its default "Subscribe" state. */
  protected onEmailEdit(): void {
    if (this.status() !== 'idle') this.status.set('idle');
    this.submitAttempted.set(false);
  }

  private buildSubscribe(v: SubscribeModel): SubscribeSubmit {
    const { utm_source, utm_medium, utm_campaign, referrer } = buildAttribution();
    return {
      email: v.email.trim(),
      utm_source,
      utm_medium,
      utm_campaign,
      referrer,
      found_via: v.found_via,
      found_via_detail: v.found_via_detail.trim(),
    };
  }
}
