/**
 * Claim confirm page (`/claims/confirm`, AECI-1435, ADR 0042). The destination of the
 * link in the `claim-confirm` email (`/claims/confirm?token=…`). An anonymous claim or
 * typed-in listing request waits on this page: confirming POSTs the token to
 * `/api/requests/confirm`, which sends the request to AEC Integrations.
 *
 * Modelled on `/unsubscribe` (AECI-537) and `/notifications/mute`, and it keeps their
 * two rules:
 *
 * - **Confirm, never auto-act.** A GET never sends the claim, or a mail scanner that
 *   prefetches the link would send it for the visitor. The page renders one button
 *   and POSTs only on the click.
 * - **Not cacheable, not indexed.** The URL carries a single-use token, so the route
 *   is absent from `ROUTE_CACHE_PATTERNS` (fails closed to `private, no-store`) and
 *   the meta sets `robots: noindex`. The token leaves the address bar after the first
 *   render and is stripped from analytics URLs (`posthog-url-sanitizer.ts`).
 *
 * Results: sent (the receipt copy, routed variant included), already confirmed,
 * rejected, expired, not found, and listing gone. Each failure points back to the
 * vendor program page to start again. Rejected (ruled 2026-10-21) is a claim the
 * AECI-1420 account check refused at confirm: the click proved the mailbox, so the
 * page says why and names the company the address already manages. Light theme only; every string is `i18n` or
 * `$localize`.
 */
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  CLAIM_OWNER_REVIEW_DAYS,
  REQUEST_CONFIRMATION_DAYS,
  type ConfirmRequestResponse,
} from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { RequestsApi } from '../requests/requests-api';

/**
 * `no-token`: reached without `?token=`. `idle`: awaiting the click. `confirming`:
 * the POST is in flight. `confirmed`: this click sent it. `already`: an earlier click
 * did. `rejected`: this click sent a claim the account check refused at once.
 * `expired`: past the 7 days, or the terms changed since. `not-found`: the token
 * matched nothing. `gone`: the claimed listing was removed. `error`: retryable.
 */
type ClaimConfirmStatus =
  | 'no-token'
  | 'idle'
  | 'confirming'
  | 'confirmed'
  | 'already'
  | 'rejected'
  | 'expired'
  | 'not-found'
  | 'gone'
  | 'error';

const BTN =
  'inline-flex items-center justify-center rounded-(--radius-sm) bg-(--accent-primary) px-5 py-2 font-label text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60';

const HEADLINE =
  'font-display text-3xl font-normal leading-snug text-(--text-primary) outline-none md:text-4xl';

const BODY = 'mt-4 text-base leading-relaxed text-(--text-secondary)';

/** The states a refused confirm can land on. */
type FailureStatus = Extract<ClaimConfirmStatus, 'expired' | 'not-found' | 'gone' | 'error'>;

/** Map a refused confirm onto the page state that explains it. */
function failureStatus(err: unknown): FailureStatus {
  if (!(err instanceof HttpErrorResponse)) return 'error';
  const body = err.error as {
    error?: { code?: string; field?: string; details?: Record<string, unknown> };
  } | null;
  const details = body?.error?.details ?? {};
  if (err.status === 404) {
    return details['resource'] === 'request_confirmation' ? 'not-found' : 'gone';
  }
  if (err.status === 422 && details['reason'] === 'expired') return 'expired';
  // The vendor terms changed between the submit and the click, so the acceptance
  // the visitor gave is not the current one. Starting again is the only fix.
  if (err.status === 400 && body?.error?.field === 'version') return 'expired';
  return 'error';
}

@Component({
  selector: 'app-claim-confirm',
  imports: [RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-2xl px-6 py-16 md:px-8 md:py-20">
          <div
            class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-8 md:p-10"
          >
            @switch (status()) {
              @case ('confirmed') {
                @if (result(); as r) {
                  @if (r.kind === 'listing') {
                    <h1
                      #resultHeading
                      tabindex="-1"
                      [class]="headline"
                      i18n="@@claimConfirm.done.listing.headline"
                    >
                      Request sent
                    </h1>
                    <p [class]="body" i18n="@@claimConfirm.done.listing.body">
                      Thanks. We've emailed you a receipt. We'll add
                      <strong class="font-semibold text-(--text-primary)">{{
                        r.company_name
                      }}</strong>
                      to the directory, then write to you so you can finish your claim.
                    </p>
                  } @else {
                    <h1
                      #resultHeading
                      tabindex="-1"
                      [class]="headline"
                      i18n="@@requests.sent.claim.title"
                    >
                      Claim sent
                    </h1>
                    <p [class]="body" i18n="@@claimConfirm.done.claim.body">
                      Thanks for confirming. We've emailed you a receipt.
                    </p>
                    <div
                      class="mt-6 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4"
                    >
                      <p
                        class="text-sm font-bold text-(--text-primary)"
                        i18n="@@requests.sent.next.heading"
                      >
                        What happens next
                      </p>
                      <ol
                        class="mt-2 list-decimal space-y-1 ps-5 text-sm leading-relaxed text-(--text-secondary)"
                      >
                        @if (r.routed) {
                          <li data-testid="claim-confirm-routed">
                            @if (r.company_name; as name) {
                              <ng-container i18n="@@requests.sent.claim.routed"
                                >The team at {{ name }} has been asked to confirm you.</ng-container
                              >
                            } @else {
                              <ng-container i18n="@@requests.sent.claim.routed.unnamed"
                                >The team at this company has been asked to confirm
                                you.</ng-container
                              >
                            }
                          </li>
                          <li i18n="@@requests.sent.claim.routed.accept">
                            If they accept, you get an invitation email to join.
                          </li>
                          <li i18n="@@requests.sent.claim.routed.fallback">
                            If nobody answers within {{ reviewDays }} days, we review your claim and
                            write to you.
                          </li>
                        } @else {
                          <li i18n="@@requests.sent.claim.step1">
                            A person at AEC Integrations reviews every claim. Nothing is granted
                            automatically.
                          </li>
                          <li i18n="@@requests.sent.claim.step2">
                            We check your email domain against your company's website, and your
                            LinkedIn if you added it.
                          </li>
                          <li i18n="@@requests.sent.claim.step3">
                            If we approve it, we email you a link to your vendor portal.
                          </li>
                        }
                      </ol>
                    </div>
                  }
                  <a
                    routerLink="/docs/vendors/claiming-your-listing"
                    class="mt-6 inline-flex text-sm font-bold text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    i18n="@@requests.sent.docsLink"
                    >How claims work</a
                  >
                }
              }
              @case ('rejected') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  [class]="headline"
                  i18n="@@claimConfirm.rejected.headline"
                >
                  We could not accept this claim
                </h1>
                @if (rejected(); as r) {
                  @if (r.reason === 'already_admin') {
                    <p [class]="body" i18n="@@claimConfirm.rejected.admin">
                      This address belongs to an AEC Integrations staff account. Send the claim
                      again from a different work address.
                    </p>
                  } @else if (r.vendor_name; as vendor) {
                    <p [class]="body" i18n="@@claimConfirm.rejected.otherVendor">
                      This address already manages
                      <strong class="font-semibold text-(--text-primary)">{{ vendor }}</strong>
                      on AEC Integrations. Each address can manage one company. Send the claim again
                      from a different work address.
                    </p>
                  } @else {
                    <p [class]="body" i18n="@@claimConfirm.rejected.otherVendor.unnamed">
                      This address already manages another company on AEC Integrations. Each address
                      can manage one company. Send the claim again from a different work address.
                    </p>
                  }
                }
                <p [class]="body" i18n="@@claimConfirm.rejected.emailed">
                  We've emailed you the same details.
                </p>
                <a
                  routerLink="/vendor-program"
                  [class]="btn + ' mt-6'"
                  i18n="@@claimConfirm.restart"
                >
                  Start again
                </a>
              }
              @case ('already') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  [class]="headline"
                  i18n="@@claimConfirm.already.headline"
                >
                  Already confirmed
                </h1>
                <p [class]="body" i18n="@@claimConfirm.already.body">
                  This link was used already, so your request is with us. We'll write to you by
                  email. You don't need to do anything else.
                </p>
              }
              @case ('expired') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  [class]="headline"
                  i18n="@@claimConfirm.expired.headline"
                >
                  This link has expired
                </h1>
                <p [class]="body" i18n="@@claimConfirm.expired.body">
                  Confirm links work for {{ confirmDays }} days. Nothing was sent. Start again and
                  we'll email you a new link.
                </p>
                <a
                  routerLink="/vendor-program"
                  [class]="btn + ' mt-6'"
                  i18n="@@claimConfirm.restart"
                >
                  Start again
                </a>
              }
              @case ('not-found') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  [class]="headline"
                  i18n="@@claimConfirm.notFound.headline"
                >
                  This link is not valid
                </h1>
                <p [class]="body" i18n="@@claimConfirm.notFound.body">
                  Check that you opened the whole link from the email. If it still does not work,
                  start again and we'll email you a new link.
                </p>
                <a
                  routerLink="/vendor-program"
                  [class]="btn + ' mt-6'"
                  i18n="@@claimConfirm.restart"
                >
                  Start again
                </a>
              }
              @case ('gone') {
                <h1
                  #resultHeading
                  tabindex="-1"
                  [class]="headline"
                  i18n="@@claimConfirm.gone.headline"
                >
                  That listing is no longer available
                </h1>
                <p [class]="body" i18n="@@claimConfirm.gone.body">
                  The listing you claimed was removed after you sent the claim, so nothing was sent.
                  Start again and choose Type it in to name your product or company.
                </p>
                <a
                  routerLink="/vendor-program"
                  [class]="btn + ' mt-6'"
                  i18n="@@claimConfirm.restart"
                >
                  Start again
                </a>
              }
              @case ('no-token') {
                <h1 [class]="headline" i18n="@@claimConfirm.noToken.headline">
                  Confirm your claim
                </h1>
                <p [class]="body" i18n="@@claimConfirm.noToken.body">
                  To confirm a claim, open the link in the email we sent you. That link is tied to
                  your request, so we send the right one.
                </p>
              }
              @default {
                <h1 [class]="headline" i18n="@@claimConfirm.confirm.headline">
                  Confirm your claim
                </h1>
                <p [class]="body" i18n="@@claimConfirm.confirm.body">
                  Press the button to send your claim to AEC Integrations. Nothing is sent until you
                  do. If you did not ask for this, close this page.
                </p>
                <button
                  type="button"
                  [disabled]="status() === 'confirming'"
                  [class]="btn + ' mt-6'"
                  (click)="onConfirm()"
                >
                  @if (status() === 'confirming') {
                    <span i18n="@@claimConfirm.confirm.pending">Sending…</span>
                  } @else {
                    <span i18n="@@claimConfirm.confirm.action">Confirm and send</span>
                  }
                </button>

                @if (status() === 'error') {
                  <p
                    #resultHeading
                    tabindex="-1"
                    class="mt-4 text-sm font-medium text-(--text-primary) outline-none"
                    role="alert"
                    i18n="@@claimConfirm.error"
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
export class ClaimConfirmPage {
  private readonly meta = inject(MetaService);
  private readonly api = inject(RequestsApi);
  private readonly analytics = inject(Analytics);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly btn = BTN;
  protected readonly headline = HEADLINE;
  protected readonly body = BODY;
  protected readonly reviewDays = CLAIM_OWNER_REVIEW_DAYS;
  protected readonly confirmDays = REQUEST_CONFIRMATION_DAYS;

  /** The single-use token from `?token=`, read once from the route snapshot. */
  private readonly token = this.route.snapshot.queryParamMap.get('token');

  protected readonly status = signal<ClaimConfirmStatus>(this.token ? 'idle' : 'no-token');
  protected readonly result = signal<ConfirmRequestResponse | null>(null);

  /** The result, narrowed, when the account check refused the claim at confirm. */
  protected readonly rejected = computed(() => {
    const r = this.result();
    return r?.status === 'rejected' ? r : null;
  });

  /** Focus moves to the outcome so keyboard and screen-reader users land on it. */
  private readonly resultHeading = viewChild<ElementRef<HTMLElement>>('resultHeading');

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.claimConfirmTitle:Confirm your claim · AEC Integrations`,
      description: $localize`:@@meta.claimConfirmDescription:Confirm the claim you sent to AEC Integrations.`,
      canonical: canonicalUrl('/claims/confirm'),
      noindex: true,
    });

    // Drop the token from the address bar once it is in component state, through the
    // Router so a cancelled navigation cannot write it back (the `/notifications/mute`
    // reasoning). `afterNextRender` never runs during SSR.
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
      if (s !== 'no-token' && s !== 'idle' && s !== 'confirming') {
        this.resultHeading()?.nativeElement.focus();
      }
    });
  }

  protected async onConfirm(): Promise<void> {
    if (!this.token || this.status() === 'confirming') return;
    this.status.set('confirming');
    try {
      const res = await this.api.confirmRequest(this.token);
      this.result.set(res);
      this.status.set(
        res.status === 'confirmed'
          ? 'confirmed'
          : res.status === 'rejected'
            ? 'rejected'
            : 'already',
      );
      // The outcome only: never `vendor_name`.
      this.analytics.claimConfirmed({ kind: res.kind, outcome: res.status });
    } catch (err) {
      const next = failureStatus(err);
      this.status.set(next);
      this.analytics.claimConfirmed({
        kind: null,
        outcome: next === 'not-found' ? 'not_found' : next,
      });
    }
  }
}
