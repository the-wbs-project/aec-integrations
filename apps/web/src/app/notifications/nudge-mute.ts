/**
 * Mute confirm page (`/notifications/mute`, AECI-1204). The destination of the
 * "Mute these reminders" link in the footer of the daily attestation digest
 * (`/notifications/mute?token=…`). The token is the seat's opaque
 * `notification_preferences.mute_token`. Confirming POSTs it to
 * `/api/notifications/nudges/mute`, which mutes that seat's digest.
 *
 * Modelled on `/unsubscribe` (AECI-537), and it keeps that page's two rules:
 *
 * - **Confirm, never auto-act.** A GET never mutates, or a mail scanner that
 *   prefetches the link would mute the seat. The page renders a button and POSTs
 *   only on the click. Mail clients that support RFC 8058 one-click use the
 *   `List-Unsubscribe-Post` header, which targets the API directly, not this page.
 * - **Not cacheable, not indexed.** The URL carries a per-seat token, so the route
 *   is absent from `ROUTE_CACHE_PATTERNS` (fails closed to `private, no-store`) and
 *   the meta sets `robots: noindex`. The HTML holds no visitor state beyond the
 *   token the visitor brought.
 *
 * Mute only. Turning reminders back on is the Messages page switch, behind a
 * vendor session. Light theme only; every string is `i18n` or `$localize`.
 */
import {
  Component,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { NudgeMuteApi } from './nudge-mute-api';

/**
 * `no-token`: reached without `?token=`. `idle`: awaiting the confirm click.
 * `muting`: the POST is in flight. `done`: muted (`ok: true`). `invalid`: the token
 * matched no seat (`ok: false`). `error`: the request threw; retryable.
 */
type NudgeMuteStatus = 'no-token' | 'idle' | 'muting' | 'done' | 'invalid' | 'error';

const BTN =
  'inline-flex items-center justify-center rounded-(--radius-sm) bg-(--accent-primary) px-5 py-2 font-label text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60';

const HEADLINE =
  'font-display text-3xl font-normal leading-snug text-(--text-primary) outline-none md:text-4xl';

@Component({
  selector: 'app-nudge-mute',
  imports: [RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-2xl px-6 py-16 md:px-8 md:py-20">
          <p class="aec-overline text-(--accent-primary)" i18n="@@app.nudgeMute.eyebrow">
            Daily reminder email
          </p>

          <div
            class="mt-4 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-8 md:p-10"
          >
            @switch (status()) {
              @case ('done') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  [class]="headline"
                  i18n="@@app.nudgeMute.done.headline"
                >
                  Daily reminder email muted
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.nudgeMute.done.body"
                >
                  We won't send the daily reminder email to your seat. Seat invites, claim decisions
                  and plan notices still arrive. To turn it back on, sign in to your vendor portal
                  and open Messages.
                </p>
                <a routerLink="/vendor" [class]="btn + ' mt-6'" i18n="@@app.nudgeMute.done.portal">
                  Open your vendor portal
                </a>
              }
              @case ('invalid') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  [class]="headline"
                  i18n="@@app.nudgeMute.invalid.headline"
                >
                  This link is no longer valid
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.nudgeMute.invalid.body"
                >
                  Use the mute link in your most recent daily reminder email, or sign in to your
                  vendor portal and turn it off under Messages.
                </p>
                <a
                  routerLink="/vendor"
                  [class]="btn + ' mt-6'"
                  i18n="@@app.nudgeMute.invalid.portal"
                >
                  Open your vendor portal
                </a>
              }
              @case ('no-token') {
                <h1 [class]="headline" i18n="@@app.nudgeMute.noToken.headline">
                  Mute the daily reminder email
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.nudgeMute.noToken.body"
                >
                  To mute it, use the link at the bottom of any daily reminder email. That link is
                  tied to your seat, so we mute the right one.
                </p>
              }
              @default {
                <h1 [class]="headline" i18n="@@app.nudgeMute.confirm.headline">
                  Mute the daily reminder email?
                </h1>
                <p
                  class="mt-4 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.nudgeMute.confirm.body"
                >
                  Confirm below and we will stop sending the daily reminder email to your seat. Your
                  colleagues keep theirs. Every reminder still appears under Messages in your vendor
                  portal.
                </p>
                <button
                  type="button"
                  [disabled]="status() === 'muting'"
                  [class]="btn + ' mt-6'"
                  (click)="onConfirm()"
                >
                  @if (status() === 'muting') {
                    <span i18n="@@app.nudgeMute.confirm.pending">Muting…</span>
                  } @else {
                    <span i18n="@@app.nudgeMute.confirm.action">Mute daily reminder email</span>
                  }
                </button>

                @if (status() === 'error') {
                  <p
                    #resultHeading
                    tabindex="-1"
                    class="mt-4 text-sm font-medium text-(--text-primary) outline-none"
                    role="alert"
                    i18n="@@app.nudgeMute.error"
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
export class NudgeMutePage {
  private readonly meta = inject(MetaService);
  private readonly api = inject(NudgeMuteApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly btn = BTN;
  protected readonly headline = HEADLINE;

  /** The opaque token from `?token=`, read once from the route snapshot. */
  private readonly token = this.route.snapshot.queryParamMap.get('token');

  protected readonly status = signal<NudgeMuteStatus>(this.token ? 'idle' : 'no-token');

  /** Focus moves to the outcome so keyboard and screen-reader users land on it. */
  private readonly resultHeading = viewChild<ElementRef<HTMLElement>>('resultHeading');

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.nudgeMuteTitle:Mute the daily reminder email · AEC Integrations`,
      description: $localize`:@@meta.nudgeMuteDescription:Mute the AEC Integrations daily reminder email for your vendor seat.`,
      canonical: canonicalUrl('/notifications/mute'),
      noindex: true,
    });

    // Drop the token from the address bar once it is in component state, so it
    // does not linger in history, a shared screenshot, or a copied URL. The POST
    // still sends the copy held in `token`. `afterNextRender` never runs during
    // SSR, so this is browser-only.
    //
    // It goes through the Router, not `history.replaceState`. The Router keeps its
    // own copy of the URL and writes it back to the address bar on a cancelled or
    // failed navigation, so a raw replace would let the token come back. The route
    // and component stay the same, so nothing re-runs.
    afterNextRender(() => {
      if (!this.token) return;
      void this.router.navigate([], {
        queryParams: { token: null },
        queryParamsHandling: 'merge',
        preserveFragment: true,
        replaceUrl: true,
      });
    });

    effect(() => {
      const s = this.status();
      if (s === 'done' || s === 'invalid' || s === 'error') {
        this.resultHeading()?.nativeElement.focus();
      }
    });
  }

  protected async onConfirm(): Promise<void> {
    if (!this.token || this.status() === 'muting') return;
    this.status.set('muting');
    try {
      const result = await this.api.mute(this.token);
      this.status.set(result.ok ? 'done' : 'invalid');
    } catch {
      this.status.set('error');
    }
  }
}
