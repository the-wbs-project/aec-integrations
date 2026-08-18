/**
 * Unsubscribe page (`/unsubscribe`, AECI-537). The human-facing destination for
 * the tokenized opt-out link in the `mailing-list-welcome` email
 * (`/unsubscribe?token=…`). The token is the opaque `mailing_list.unsubscribe_token`;
 * confirming POSTs it to `/api/unsubscribe` (proxied to the private API Worker over
 * the service binding), which soft-deletes the subscriber (`unsubscribed_at`).
 *
 * **Confirm, never auto-act.** The page does NOT unsubscribe on load — a GET must
 * never mutate, or an email-security scanner prefetching the link would opt people
 * out. It renders a confirm button and only POSTs from the user's click. (Mail
 * clients that support true one-click use the RFC 8058 `List-Unsubscribe-Post`
 * header, which targets the API endpoint directly, not this page.)
 *
 * **Not cacheable, not indexed.** The URL carries a per-subscriber token, so the
 * route is deliberately absent from `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`
 * (fails closed to `private, no-store`) and the meta sets `robots: noindex`. Because
 * the response is never shared, baking the token into the per-request SSR HTML is
 * safe (contrast the cached-route cookie rule).
 *
 * Light theme only (Stage 1). All strings authored with `i18n`/`$localize`; brand
 * rule: no em dashes.
 */
import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { LandingApi } from '../shared/landing/landing-api';

/**
 * `no-token` — reached without a `?token=` (a bare visit / stripped link).
 * `idle` — token present, awaiting the confirm click.
 * `unsubscribing` — the POST is in flight.
 * `done` — the token matched and the subscriber is now suppressed (`ok:true`).
 * `invalid` — the token matched no one (`ok:false`; an old or malformed link).
 * `error` — the request threw (network/server); retryable.
 */
type UnsubscribeStatus = 'no-token' | 'idle' | 'unsubscribing' | 'done' | 'invalid' | 'error';

const BTN =
  'inline-flex items-center justify-center rounded-(--radius-sm) bg-(--accent-primary) px-5 py-2 font-label text-white transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60';

@Component({
  selector: 'app-unsubscribe',
  imports: [RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- Warm Bone accent band (the Surfaces-Are-Neutral treatment), matching
           /about and /updates. -->
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-2xl px-6 py-16 md:px-8 md:py-20">
          <p class="aec-overline text-(--accent-primary)" i18n="@@app.unsubscribe.eyebrow">
            Mailing list
          </p>

          <!-- A stable bordered card whose inner content swaps by status, so the
               layout does not shift between confirm and result. -->
          <div
            class="mt-4 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-8 md:p-10"
          >
            @switch (status()) {
              @case ('done') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  class="font-display text-3xl font-normal leading-snug text-(--text-primary) outline-none md:text-4xl"
                  i18n="@@app.unsubscribe.done.headline"
                >
                  You've been unsubscribed
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.unsubscribe.done.body"
                >
                  You won't receive any more mailing-list updates from AEC Integrations. You can
                  rejoin any time from the site.
                </p>
                <a
                  routerLink="/products"
                  [class]="btn + ' mt-6'"
                  i18n="@@app.unsubscribe.done.browse"
                >
                  Browse integrations
                </a>
              }
              @case ('invalid') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  class="font-display text-3xl font-normal leading-snug text-(--text-primary) outline-none md:text-4xl"
                  i18n="@@app.unsubscribe.invalid.headline"
                >
                  This link is no longer valid
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.unsubscribe.invalid.body"
                >
                  This unsubscribe link has already been used or has expired. If you're still
                  receiving emails, use the unsubscribe link at the bottom of the most recent one.
                </p>
              }
              @case ('no-token') {
                <h1
                  class="font-display text-3xl font-normal leading-snug text-(--text-primary) md:text-4xl"
                  i18n="@@app.unsubscribe.noToken.headline"
                >
                  Unsubscribe from updates
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.unsubscribe.noToken.body"
                >
                  To unsubscribe, open the unsubscribe link at the bottom of any email we've sent
                  you. That link is tied to your address, so we can remove the right one.
                </p>
              }
              @default {
                <!-- idle / unsubscribing / error: the confirm prompt. -->
                <h1
                  class="font-display text-3xl font-normal leading-snug text-(--text-primary) md:text-4xl"
                  i18n="@@app.unsubscribe.confirm.headline"
                >
                  Unsubscribe from updates?
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.unsubscribe.confirm.body"
                >
                  Confirm below and we'll stop sending you AEC Integrations mailing-list updates.
                </p>
                <button
                  type="button"
                  [disabled]="status() === 'unsubscribing'"
                  [class]="btn + ' mt-6'"
                  (click)="onConfirm()"
                >
                  @if (status() === 'unsubscribing') {
                    <span i18n="@@app.unsubscribe.confirm.pending">Unsubscribing…</span>
                  } @else {
                    <span i18n="@@app.unsubscribe.confirm.action">Unsubscribe</span>
                  }
                </button>

                @if (status() === 'error') {
                  <p
                    #resultHeading
                    tabindex="-1"
                    class="mt-4 text-sm font-medium text-(--text-primary) outline-none"
                    role="alert"
                    i18n="@@app.unsubscribe.error"
                  >
                    Something went wrong. Please try again.
                  </p>
                }
              }
            }
          </div>
        </div>
      </section>
    </div>
  `,
})
export class UnsubscribePage {
  private readonly meta = inject(MetaService);
  private readonly api = inject(LandingApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly btn = BTN;

  /** The opaque token from `?token=`. Read once from the route snapshot (available
   *  under SSR for this routed component). Null → the `no-token` guidance state. */
  private readonly token = this.route.snapshot.queryParamMap.get('token');

  protected readonly status = signal<UnsubscribeStatus>(this.token ? 'idle' : 'no-token');

  /** Move focus to the terminal result (`done`/`invalid`/`error`) so keyboard +
   *  screen-reader users land on the outcome. No-op during SSR (status stays
   *  `idle`/`no-token`, no interaction). */
  private readonly resultHeading = viewChild<ElementRef<HTMLElement>>('resultHeading');

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.unsubscribeTitle:Unsubscribe · AEC Integrations`,
      description: $localize`:@@meta.unsubscribeDescription:Unsubscribe from the AEC Integrations mailing list.`,
      canonical: canonicalUrl('/unsubscribe'),
      noindex: true,
    });

    effect(() => {
      const s = this.status();
      if (s === 'done' || s === 'invalid' || s === 'error') {
        this.resultHeading()?.nativeElement.focus();
      }
    });
  }

  protected async onConfirm(): Promise<void> {
    // Guard: only act with a token and never while a request is in flight.
    if (!this.token || this.status() === 'unsubscribing') return;
    this.status.set('unsubscribing');
    try {
      const result = await this.api.unsubscribe(this.token);
      this.status.set(result.ok ? 'done' : 'invalid');
    } catch {
      // Retryable notice; the confirm button stays available.
      this.status.set('error');
    }
  }
}
