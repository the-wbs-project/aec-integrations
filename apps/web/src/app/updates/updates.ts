/**
 * Updates page (`/updates`, AECI-536). A focused, first-party mailing-list signup
 * destination for LinkedIn posts and other external content — one action, no
 * popups. Reuses the whole existing lead-capture stack: the email Signal Form
 * validates against the shared `SubscribeSubmitSchema`, `LandingApi.subscribe`
 * POSTs same-origin to `/api/subscribe` (proxied to the private API Worker over
 * the service binding), UTM + referrer ride the body via `buildAttribution`, and
 * geo is enriched server-side on the trusted `LANDING_CF_HEADERS`. A genuine new
 * signup (`created:true`) fires the consent-gated `mailing_list_signup` PostHog
 * event tagged `source: 'updates_page'`.
 *
 * It deliberately does NOT reuse the shared `aec-mailing-list-signup` band: that
 * component's copy is fixed, its layout is a full-bleed band above the footer, and
 * its success state is an inline button-flip. This page needs its own focused copy,
 * a **visible** email label, and a success-panel swap ("You're on the list." + a
 * Browse-integrations CTA). Only the ~30 lines of form state-wiring are re-authored;
 * the actual transport/validation/analytics are shared.
 *
 * **Layout:** a two-column hero on the warm Bone band — the pitch (eyebrow,
 * headline, lede, and a short "what to expect" list) on the left, the signup card
 * on the right — so the wide band reads as one composition rather than a lone card
 * against empty space. It collapses to a single column below `lg` (the pitch stacks
 * above the card).
 *
 * **Static + edge-cache / SSR-safe** (like `/about`): the SSR HTML is the static
 * form island and the POST only ever fires from a user action against the
 * non-cached `/api/*`, so the page stays visitor-state-neutral. It carries
 * `Cache-Tag: route:index` with a 24h edge / 1h browser TTL
 * (`ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`), and is indexable, so
 * `setStaticPageMeta` sets title + description + canonical + OG (no `robots`).
 *
 * Light theme only (Stage 1). All strings authored with `i18n`/`$localize`; brand
 * rule: no em dashes.
 */
import { Component, ElementRef, computed, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';

import { SubscribeSubmitSchema, type SubscribeSubmit } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { LandingApi, buildAttribution } from '../shared/landing/landing-api';

interface SubscribeModel {
  email: string;
}

/** `subscribed` swaps the form for the success panel; `exists` / `error` stay
 *  inline beneath the form so the visitor can retry or try another address. */
type SubscribeStatus = 'idle' | 'subscribed' | 'exists' | 'error';

const BTN =
  'inline-flex items-center justify-center rounded-(--radius-sm) bg-(--accent-primary) px-5 py-2 font-label text-white transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60';

@Component({
  selector: 'app-updates',
  imports: [RouterLink, FormField],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- Warm Bone accent band (the Surfaces-Are-Neutral treatment, not a page
           background), matching /about. -->
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <!-- Two-column hero: the pitch on the left, the signup card on the
               right, so the wide band reads as one composition instead of a lone
               card against empty space. Collapses to a single column below lg
               (the pitch stacks above the card). -->
          <div class="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div class="max-w-xl">
              <p class="aec-overline text-(--accent-primary)" i18n="@@app.updates.eyebrow">
                Mailing list
              </p>
              <h1
                class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
                i18n="@@app.updates.headline"
              >
                Get AEC Integrations updates
              </h1>
              <p
                class="mt-5 text-lg leading-relaxed text-(--text-secondary)"
                i18n="@@app.updates.body"
              >
                Occasional updates as AEC Integrations grows. Here's what to expect:
              </p>

              <!-- "What to expect" list. Fills the left column and reinforces the
                   value before the ask; the check glyph is aria-hidden (the text
                   carries the meaning). role="list" restores list semantics under
                   the Tailwind list-style reset (as in home-credibility-strip). -->
              <ul role="list" class="mt-8 flex flex-col gap-4">
                @for (item of expectations; track item.id) {
                  <li class="flex items-start gap-3">
                    <svg
                      class="mt-0.5 h-5 w-5 shrink-0 text-(--accent-primary)"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    <span class="text-base leading-relaxed text-(--text-secondary)">{{
                      item.text
                    }}</span>
                  </li>
                }
              </ul>
            </div>

            <!-- Signup card. A stable bordered container whose inner content swaps
                 form <-> success panel, so the surrounding layout does not shift. -->
            <div
              class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-8 md:p-10"
            >
              @if (subscribed()) {
                <div>
                  <h2
                    #successHeading
                    tabindex="-1"
                    class="font-display text-2xl font-normal leading-snug text-(--text-primary) outline-none md:text-3xl"
                    i18n="@@app.updates.success.headline"
                  >
                    You're on the list.
                  </h2>
                  <p
                    class="mt-3 text-base leading-relaxed text-(--text-secondary)"
                    i18n="@@app.updates.success.body"
                  >
                    We'll send occasional updates as AEC Integrations develops.
                  </p>
                  <a routerLink="/products" [class]="btn" i18n="@@app.updates.success.browse">
                    Browse integrations
                  </a>
                </div>
              } @else {
                <form novalidate (submit)="onSubmit($event)">
                  <label
                    class="block font-label text-sm text-(--text-primary)"
                    for="updates-email"
                    i18n="@@app.updates.email.label"
                    >Email address</label
                  >
                  <div class="mt-2 flex flex-wrap gap-3">
                    <input
                      id="updates-email"
                      type="email"
                      autocomplete="email"
                      [formField]="form.email"
                      (input)="onEmailEdit()"
                      i18n-placeholder="@@app.updates.email.placeholder"
                      placeholder="you@yourfirm.com"
                      [attr.aria-invalid]="emailErrorShown() ? 'true' : null"
                      [attr.aria-describedby]="emailErrorShown() ? 'updates-email-error' : null"
                      class="min-w-0 flex-1 rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    />
                    <button type="submit" [disabled]="submitDisabled()" [class]="btn">
                      @if (form().submitting()) {
                        <span i18n="@@app.updates.submitting">Joining…</span>
                      } @else {
                        <span i18n="@@app.updates.submit">Join the mailing list</span>
                      }
                    </button>
                  </div>

                  @if (emailErrorShown()) {
                    <p
                      id="updates-email-error"
                      class="mt-2 text-sm font-medium text-(--text-primary)"
                      role="alert"
                      i18n="@@app.updates.email.error"
                    >
                      Enter a valid email address.
                    </p>
                  }

                  <!-- Inline non-terminal notices. Kept in the DOM so the polite
                       live region announces on change. -->
                  <p class="mt-3 text-sm text-(--text-primary)" role="status" aria-live="polite">
                    @switch (status()) {
                      @case ('exists') {
                        <span i18n="@@app.updates.status.exists">You're already on the list.</span>
                      }
                      @case ('error') {
                        <span i18n="@@app.updates.status.error"
                          >Something went wrong. Please try again.</span
                        >
                      }
                    }
                  </p>
                </form>
              }
            </div>
          </div>
        </div>
      </section>
    </div>
  `,
})
export class UpdatesPage {
  private readonly meta = inject(MetaService);
  private readonly api = inject(LandingApi);
  private readonly analytics = inject(Analytics);

  protected readonly btn = BTN;

  /** The left-column "what to expect" list. Static copy authored with `$localize`
   *  (the same TS-side i18n idiom as `home-credibility-strip`), rendered through a
   *  single `@for` so the check glyph markup isn't repeated. Derived from the
   *  approved lead-capture copy (expand the directory, comparison + verification,
   *  no spam). No em dashes (brand rule). */
  protected readonly expectations = [
    {
      id: 'integrations',
      text: $localize`:@@app.updates.expect.integrations:New integrations as we expand the directory`,
    },
    {
      id: 'features',
      text: $localize`:@@app.updates.expect.features:Comparison and verification features as they ship`,
    },
    {
      id: 'spam',
      text: $localize`:@@app.updates.expect.spam:No spam, unsubscribe anytime`,
    },
  ];

  private readonly model = signal<SubscribeModel>({ email: '' });
  protected readonly form = form(this.model, (p) =>
    validateStandardSchema(p, SubscribeSubmitSchema),
  );

  protected readonly status = signal<SubscribeStatus>('idle');
  protected readonly subscribed = computed(() => this.status() === 'subscribed');

  /** Inline email error shows only once the field has been touched (blur/submit). */
  protected readonly emailErrorShown = computed(
    () => this.form.email().touched() && Boolean(this.form.email().getError('standardSchema')),
  );

  protected readonly submitDisabled = computed(
    () => this.form().invalid() || this.form().submitting(),
  );

  /** On a successful signup the form is replaced by the confirmation panel; move
   *  focus to its heading so keyboard + screen-reader users land on the result
   *  (the just-clicked submit button has left the DOM). The effect depends on both
   *  `subscribed()` and the `viewChild`, so it re-runs on the render pass where the
   *  heading exists. No-op during SSR (status stays `idle`, no interaction). */
  private readonly successHeading = viewChild<ElementRef<HTMLElement>>('successHeading');

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.updatesTitle:Get updates · AEC Integrations`,
      description: $localize`:@@meta.updatesDescription:Join the AEC Integrations mailing list for occasional updates as we expand the directory and build comparison and verification features.`,
      canonical: canonicalUrl('/updates'),
    });

    effect(() => {
      if (this.subscribed()) this.successHeading()?.nativeElement.focus();
    });
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    this.status.set('idle');
    await submit(this.form, async (f) => {
      try {
        const result = await this.api.subscribe(this.buildSubscribe(f().value()));
        this.status.set(result.created ? 'subscribed' : 'exists');
        if (result.created) {
          // Consent-gated + fire-and-forget conversion event (AECI-326). Only a
          // genuine new signup counts; an already-listed email does not.
          this.analytics.mailingListSignup({ source: 'updates_page' });
        }
      } catch {
        // Retryable notice, not a ValidationError (which would disable submit).
        this.status.set('error');
      }
      return undefined;
    });
  }

  /** Editing the address clears a stale `exists`/`error` notice so a follow-up
   *  address can be submitted cleanly. */
  protected onEmailEdit(): void {
    if (this.status() !== 'idle' && this.status() !== 'subscribed') this.status.set('idle');
  }

  private buildSubscribe(v: SubscribeModel): SubscribeSubmit {
    const { utm_source, utm_medium, utm_campaign, referrer } = buildAttribution();
    return { email: v.email.trim(), utm_source, utm_medium, utm_campaign, referrer };
  }
}
