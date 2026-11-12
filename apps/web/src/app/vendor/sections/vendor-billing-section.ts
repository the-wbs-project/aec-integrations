import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  afterRenderEffect,
  DOCUMENT,
  computed,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import type {
  AcceptLicenseGrantResponse,
  VendorAgreementAcceptance,
  VendorBillingResponse,
  VendorPendingGrant,
} from '@aeci/shared';

import { formatTermDate } from '../../shared/term-date/format-term-date';
import { acceptanceHref, plansSnapshotHref } from '../components/vendor-agreement-href';
import { VendorBillingEmailForm } from '../components/vendor-billing-email-form';
import { VendorBillingLegalNameForm } from '../components/vendor-billing-legal-name-form';
import { VendorBillingLicenses } from '../components/vendor-billing-licenses';
import { VendorBillingStripePanel } from '../components/vendor-billing-stripe-panel';
import {
  VendorBillingStripeWatch,
  liveLicenseCount,
} from '../components/vendor-billing-stripe-watch';
import { VendorBillingSummary } from '../components/vendor-billing-summary';
import { VendorDocsLink } from '../components/vendor-docs-link';
import { VendorLicenseActions } from '../components/vendor-license-actions';
import { VendorLicenseAssign } from '../components/vendor-license-assign';
import { VendorPendingGrantCard } from '../components/vendor-pending-grant-card';
import { VendorPortalStore } from '../vendor-portal-store';

/** One acceptance row, with its labels and its link built once. */
interface AcceptanceRow {
  readonly acceptance: VendorAgreementAcceptance;
  readonly documentLabel: string;
  /** Where that exact version is readable, or `null` when no page serves it. */
  readonly href: string | null;
  readonly acceptedLabel: string;
  /** A `grant` acceptance (AECI-1615): where and how it was given. `null` otherwise. */
  readonly grantLabel: string | null;
  /** A claim's incorporated policy versions (AECI-1619). `null` unless both are recorded. */
  readonly policiesLabel: string | null;
  /** A checkout or grant row's recorded Plans page (AECI-1619). `null` when none is recorded. */
  readonly plansPage: { readonly label: string; readonly href: string | null } | null;
}

/** "Policies: Listing Accuracy Policy 1.0, Review Guidelines 1.0" on a claim row (AECI-1619). */
function policiesLabel(acceptance: VendorAgreementAcceptance): string | null {
  const listing = acceptance.listing_accuracy_version;
  const reviews = acceptance.review_guidelines_version;
  if (listing === null || reviews === null) return null;
  return $localize`:@@vendor.billing.agreements.policies:Policies: Listing Accuracy Policy ${listing}:LISTING_ACCURACY:, Review Guidelines ${reviews}:REVIEW_GUIDELINES:`;
}

/** "Plans page 1.0", linked to that version's snapshot, on a checkout or grant row (AECI-1619). */
function plansPage(
  acceptance: VendorAgreementAcceptance,
): { readonly label: string; readonly href: string | null } | null {
  const version = acceptance.plans_page_version;
  if (version === null) return null;
  return {
    label: $localize`:@@vendor.billing.agreements.plansPage:Plans page ${version}:VERSION:`,
    href: plansSnapshotHref(version),
  };
}

/** The note under a grant acceptance's document: the source and the method. */
function grantAcceptanceLabel(acceptance: VendorAgreementAcceptance): string | null {
  if (acceptance.source !== 'grant') return null;
  switch (acceptance.method) {
    case 'portal_checkbox':
      return $localize`:@@vendor.billing.grantPending.acceptance.portal:Grant, accepted in the portal`;
    case 'signed_deal': {
      const ref = acceptance.deal_reference;
      return ref
        ? $localize`:@@vendor.billing.grantPending.acceptance.dealRef:Grant, by signed deal ${ref}:REFERENCE:`
        : $localize`:@@vendor.billing.grantPending.acceptance.deal:Grant, by signed deal`;
    }
    default:
      return $localize`:@@vendor.billing.grantPending.acceptance.grant:Grant`;
  }
}

/** The banner above the waiting card after an accept or a stale refusal. */
interface GrantNotice {
  readonly kind: 'accepted' | 'stale';
  readonly title: string;
  readonly lines: readonly string[];
}

function documentLabel(document: string): string {
  switch (document) {
    case 'vendor_terms':
      return $localize`:@@vendor.billing.doc.vendorTerms:Vendor terms`;
    case 'managed_plan':
      return $localize`:@@vendor.billing.doc.managedPlan:Managed plan agreement`;
    default:
      return document;
  }
}

/**
 * `…/billing`: the owner-only Billing tab (AECI-1390, E5.4;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21). The billing email, the company's
 * licenses and the agreements it accepted. A summary card in a right-hand column
 * counts the licenses (`VendorBillingSummary`). A "Learn more" link under the
 * intro opens the Billing help page (AECI-1400, E8.3).
 *
 * ── OWNERS ONLY ─────────────────────────────────────────────────────────────
 * Billing is an owner's act (decision 10). The nav drops the tab for a member seat
 * on `me.seat_owner`; a member who types the URL gets a short note here and NO
 * request, because both reads answer `403` to a member. The bit is a display hint:
 * the API re-checks it through `requireSeatOwner()`.
 *
 * ── STATE ───────────────────────────────────────────────────────────────────
 * The payload lives in {@link VendorPortalStore} (`billing`), loaded once from
 * `afterNextRender` and refetched when the `entitlement` cursor moves, which every
 * license write moves. SSR paints the loading state, so nothing billing-related is
 * ever in server HTML.
 *
 * ── ROW ACTIONS (AECI-1391, E5.5) ───────────────────────────────────────────
 * The licenses table's `rowActions` template: a live pool license gets the assign
 * control, a live assigned one the actions menu ("Release license", at renewal or
 * now), an ended one nothing. Each action is pessimistic and re-reads billing.
 * A successful assign swaps its row's control for the actions menu, so the section
 * moves focus to its trigger once the re-read renders (WCAG 2.4.3).
 *
 * A stale refusal (`409`/`404`: another owner or tab acted first) is the section's,
 * not the control's. The re-read that follows can swap or remove the control that
 * was refused, taking its error line and focus with it. So the control emits
 * `stale`, the section shows the message above the table, re-reads billing, and
 * then moves focus to that message if focus was lost or still in this section.
 *
 * ── PAYING BY CARD (AECI-1502, E9.4) ────────────────────────────────────────
 * When the read says `stripe_checkout_available`, the owner gets the "Pay by card"
 * panel (`VendorBillingStripePanel`) under the billing email: buy through Stripe
 * Checkout with no subscription, or add licenses and open the Customer Portal with
 * one. When it is false (production until the E9 switch-on, amendment R2) the panel
 * is not rendered at all, and neither is the intro's card sentence (AECI-1396).
 *
 * Stripe sends the owner back to `…/billing?checkout=success` or `=cancelled`. The
 * section reads that from `location.search` once after the first render, drops the
 * parameter from the URL (replacing the history entry), and shows a banner. On
 * success, {@link VendorBillingStripeWatch} re-reads billing every 3 s for up to
 * 60 s until the licenses land (ADR 0023: client revalidation, not sockets).
 *
 * ── SUBSCRIPTIONS WAITING FOR YOU (AECI-1615) ───────────────────────────────
 * A subscription AECi grants starts only when an owner accepts it here (counsel Q5).
 * The card under the intro lists `pending_grants`, one `VendorPendingGrantCard` each.
 * An accept or a stale refusal re-reads billing, which removes that grant's card, so
 * the outcome lives in {@link grantNotice} above the card and takes focus, as the
 * stale handling of the licenses table does. A member seat gets no line about pending
 * grants: the billing read is owner-only.
 */
@Component({
  selector: 'aec-vendor-billing-section',
  imports: [
    RouterLink,
    VendorBillingEmailForm,
    VendorBillingLegalNameForm,
    VendorBillingLicenses,
    VendorBillingStripePanel,
    VendorBillingSummary,
    VendorDocsLink,
    VendorLicenseActions,
    VendorLicenseAssign,
    VendorPendingGrantCard,
  ],
  providers: [VendorBillingStripeWatch],
  template: `
    <div [class]="topGridClass()">
      <div>
        <h2
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.section.billing"
        >
          Billing
        </h2>
        @if (!isOwner()) {
          <p
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            data-testid="billing-owners-only"
            i18n="@@vendor.billing.ownersOnly"
          >
            Only account owners manage billing. Ask an owner on the Seats tab if something here
            needs to change.
          </p>
        } @else {
          <p
            class="mt-1 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.billing.intro"
          >
            Your company's Managed subscriptions are held here. Put each one on a product to move
            that product to Managed. Plans change what a listing can show, never where it ranks.
          </p>
          @if (billing()?.stripe_checkout_available && billing()?.billing_account) {
            <p
              class="mt-1 text-sm leading-relaxed text-(--text-secondary)"
              data-testid="billing-intro-card"
              i18n="@@vendor.billing.intro.card"
            >
              You can pay for subscriptions by card below, through Stripe.
            </p>
          }
          <p class="mt-1"><aec-vendor-docs-link page="billing" /></p>

          @if (stripeNotice(); as notice) {
            <div
              class="mt-4 flex items-start justify-between gap-4 rounded-(--radius-md) border border-(--border-default) p-4 text-sm"
              [class]="
                notice.kind === 'cancelled' ? 'bg-(--surface-raised)' : 'bg-(--accent-primary-soft)'
              "
              data-testid="billing-checkout-notice"
            >
              <div class="space-y-2">
                <p
                  class="font-semibold text-(--text-primary)"
                  data-testid="billing-checkout-notice-title"
                >
                  @switch (noticeKey()) {
                    @case ('cancelled') {
                      <ng-container i18n="@@vendor.billing.notice.cancelled.title"
                        >Checkout cancelled</ng-container
                      >
                    }
                    @case ('checkout-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.checkoutWaiting.title"
                        >Checkout complete</ng-container
                      >
                    }
                    @case ('add-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.addWaiting.title"
                        >Stripe accepted the change</ng-container
                      >
                    }
                    @case ('done') {
                      <ng-container i18n="@@vendor.billing.notice.done.title"
                        >Your new subscriptions are here</ng-container
                      >
                    }
                    @case ('timeout') {
                      <ng-container i18n="@@vendor.billing.notice.timeout.title"
                        >Your subscriptions have not arrived yet</ng-container
                      >
                    }
                  }
                </p>
                <p class="text-(--text-secondary)">
                  @switch (noticeKey()) {
                    @case ('cancelled') {
                      <ng-container i18n="@@vendor.billing.notice.cancelled.body"
                        >Nothing was charged. Your subscriptions are as they were.</ng-container
                      >
                    }
                    @case ('checkout-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.waiting.body"
                        >Your new subscriptions appear below as soon as Stripe confirms the payment.
                        This usually takes a few seconds.</ng-container
                      >
                    }
                    @case ('add-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.waiting.body"
                        >Your new subscriptions appear below as soon as Stripe confirms the payment.
                        This usually takes a few seconds.</ng-container
                      >
                    }
                    @case ('done') {
                      <ng-container i18n="@@vendor.billing.notice.done.body"
                        >Each new subscription is in the pool. Put one on a product to move that
                        product to Managed.</ng-container
                      >
                    }
                    @case ('timeout') {
                      <ng-container i18n="@@vendor.billing.notice.timeout.body"
                        >Stripe can take a few minutes to confirm a payment. They will appear here
                        when it does. If they have not arrived within an hour, contact AEC
                        Integrations.</ng-container
                      >
                    }
                  }
                </p>
                @if (noticeKey() === 'timeout') {
                  <button
                    type="button"
                    [class]="retryClass"
                    data-testid="billing-checkout-notice-retry"
                    (click)="watch.retry()"
                    i18n="@@vendor.billing.notice.timeout.retry"
                  >
                    Check again
                  </button>
                }
              </div>
              <button
                type="button"
                class="-me-1 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-(--radius-sm) text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n-aria-label="@@vendor.billing.notice.dismiss"
                aria-label="Dismiss"
                data-testid="billing-checkout-notice-dismiss"
                (click)="watch.dismiss()"
              >
                <svg
                  class="size-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          }

          @if (loading()) {
            <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@vendor.billing.loading">
              Loading billing…
            </p>
          } @else if (failed() && !billing()) {
            <div class="mt-4 flex flex-wrap items-center gap-3">
              <p class="text-sm text-(--text-primary)" i18n="@@vendor.billing.error">
                Could not load billing.
              </p>
              <button
                type="button"
                [class]="retryClass"
                (click)="retry()"
                i18n="@@vendor.billing.retry"
              >
                Try again
              </button>
            </div>
          } @else if (billing(); as b) {
            @if (grantNotice(); as notice) {
              <div
                #grantNoticeEl
                tabindex="-1"
                [attr.role]="notice.kind === 'stale' ? 'alert' : 'status'"
                class="mt-4 rounded-(--radius-md) border border-(--border-default) p-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                [class]="
                  notice.kind === 'stale' ? 'bg-(--surface-raised)' : 'bg-(--accent-primary-soft)'
                "
                data-testid="grant-notice"
              >
                <p class="font-semibold text-(--text-primary)">{{ notice.title }}</p>
                @for (line of notice.lines; track $index) {
                  <p class="mt-1 text-(--text-secondary)">{{ line }}</p>
                }
              </div>
            }
            @if (b.pending_grants.length > 0) {
              <section
                class="mt-6 rounded-(--radius-md) border border-(--border-strong) bg-(--surface-raised) p-5"
                aria-labelledby="vendor-billing-grants-heading"
                data-testid="pending-grants"
              >
                <h3
                  id="vendor-billing-grants-heading"
                  class="font-label text-sm font-semibold text-(--text-primary)"
                  i18n="@@vendor.billing.grantPending.heading"
                >
                  Subscriptions waiting for you
                </h3>
                <p
                  class="mt-1 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                  i18n="@@vendor.billing.grantPending.intro"
                >
                  AEC Integrations granted your company these subscriptions. Each one starts only
                  when an owner accepts the Managed plan agreement for it. Until then, nothing
                  changes on your listings.
                </p>
                <div class="mt-5 divide-y border-t pt-5">
                  @for (grant of b.pending_grants; track grant.id) {
                    <aec-vendor-pending-grant-card
                      [grant]="grant"
                      [prefillTitle]="b.checkout_signer_title"
                      (accepted)="onGrantAccepted(grant, $event)"
                      (stale)="onGrantStale($event)"
                    />
                  }
                </div>
              </section>
            }
            <section class="mt-6" aria-labelledby="vendor-billing-email-heading">
              <h3
                id="vendor-billing-email-heading"
                class="font-label text-sm font-semibold text-(--text-primary)"
                i18n="@@vendor.billing.email.heading"
              >
                Billing email
              </h3>
              <div class="mt-2">
                @if (b.billing_account; as account) {
                  <aec-vendor-billing-email-form [current]="account.billing_email" />
                } @else {
                  <p class="text-sm text-(--text-secondary)" i18n="@@vendor.billing.noAccount">
                    Your company has no billing account yet. Contact AEC Integrations to set one up.
                  </p>
                }
              </div>
            </section>
            <section class="mt-6" aria-labelledby="vendor-billing-legal-name-heading">
              <h3
                id="vendor-billing-legal-name-heading"
                class="font-label text-sm font-semibold text-(--text-primary)"
                i18n="@@vendor.billing.legalName.heading"
              >
                Company legal name
              </h3>
              <div class="mt-2">
                <aec-vendor-billing-legal-name-form [current]="b.legal_name" />
              </div>
            </section>
            @if (b.stripe_checkout_available && b.billing_account) {
              <aec-vendor-billing-stripe-panel class="mt-6" [billing]="b" />
            }
          }
        }
      </div>
      @if (isOwner() && !loading() && billing(); as b) {
        <aec-vendor-billing-summary
          [licenses]="b.licenses"
          [productsOnFree]="b.assignable_products.length"
          [truncated]="b.licenses_truncated"
        />
      }
    </div>

    @if (isOwner() && !loading() && billing(); as b) {
      <section class="mt-8" aria-labelledby="vendor-billing-licenses-heading">
        <h3
          id="vendor-billing-licenses-heading"
          class="font-label text-sm font-semibold text-(--text-primary)"
          i18n="@@vendor.billing.licenses.heading"
        >
          Subscriptions
        </h3>
        @if (staleNotice(); as message) {
          <p
            #staleNoticeEl
            role="alert"
            tabindex="-1"
            class="mt-2 text-sm font-medium text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            data-testid="billing-stale-notice"
          >
            {{ message }}
          </p>
        }
        <div class="mt-3">
          <aec-vendor-billing-licenses
            [licenses]="b.licenses"
            [truncated]="b.licenses_truncated"
            [rowActions]="licenseActions"
          />
          <ng-template #licenseActions let-row>
            @if (row.license.live) {
              @if (row.license.assigned_product) {
                <aec-vendor-license-actions [license]="row.license" (stale)="onStale($event)" />
              } @else {
                <aec-vendor-license-assign
                  [license]="row.license"
                  [products]="b.assignable_products"
                  (assigned)="focusActionsAfterAssign($event)"
                  (stale)="onStale($event)"
                />
              }
            }
          </ng-template>
        </div>
      </section>

      <section class="mt-8" aria-labelledby="vendor-billing-agreements-heading">
        <h3
          id="vendor-billing-agreements-heading"
          class="font-label text-sm font-semibold text-(--text-primary)"
          i18n="@@vendor.billing.agreements.heading"
        >
          Agreements
        </h3>
        <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@vendor.billing.agreements.intro">
          These are the agreements your company accepted.
        </p>
        @if (acceptanceRows().length === 0) {
          <p class="mt-3 text-sm text-(--text-secondary)" i18n="@@vendor.billing.agreements.empty">
            No agreements accepted yet.
          </p>
        } @else {
          <div class="mt-3 overflow-x-auto">
            <table class="w-full min-w-[48rem] table-fixed border-collapse text-sm">
              <caption class="sr-only" i18n="@@vendor.billing.agreements.caption">
                Accepted agreements
              </caption>
              <colgroup>
                <col class="w-[26%]" />
                <col class="w-[10%]" />
                <col class="w-[16%]" />
                <col class="w-[24%]" />
                <col class="w-[24%]" />
              </colgroup>
              <thead>
                <tr class="border-b border-(--border-default) text-(--text-secondary)">
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.doc">
                    Document
                  </th>
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.version">
                    Version
                  </th>
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.accepted">
                    Accepted date
                  </th>
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.by">
                    Accepted by
                  </th>
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.signer">
                    Signer
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (row of acceptanceRows(); track row.acceptance.id) {
                  <tr
                    class="border-b border-(--border-default) last:border-0"
                    data-testid="acceptance-row"
                  >
                    <th scope="row" class="py-3 pe-4 text-start font-normal text-(--text-primary)">
                      {{ row.documentLabel }}
                      @if (row.grantLabel; as grantLabel) {
                        <span
                          class="block text-xs text-(--text-secondary)"
                          data-testid="acceptance-grant"
                          >{{ grantLabel }}</span
                        >
                      }
                      @if (row.policiesLabel; as policies) {
                        <span
                          class="block text-xs text-(--text-secondary)"
                          data-testid="acceptance-policies"
                          >{{ policies }}</span
                        >
                      }
                      @if (row.plansPage; as plans) {
                        @if (plans.href; as plansHref) {
                          <a
                            [routerLink]="plansHref"
                            class="block w-fit text-xs text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                            data-testid="acceptance-plans-page"
                            >{{ plans.label }}</a
                          >
                        } @else {
                          <span
                            class="block text-xs text-(--text-secondary)"
                            data-testid="acceptance-plans-page"
                            >{{ plans.label }}</span
                          >
                        }
                      }
                    </th>
                    <td class="py-3 pe-4 tabular-nums">
                      @if (row.href; as href) {
                        <a
                          [routerLink]="href"
                          class="text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          >{{ row.acceptance.version }}</a
                        >
                      } @else {
                        <span class="text-(--text-secondary)">{{ row.acceptance.version }}</span>
                      }
                    </td>
                    <td class="py-3 pe-4 tabular-nums text-(--text-secondary)">
                      {{ row.acceptedLabel }}
                    </td>
                    <td class="py-3 pe-4 text-(--text-secondary) [overflow-wrap:anywhere]">
                      {{ row.acceptance.email }}
                    </td>
                    <td
                      class="py-3 text-(--text-secondary) [overflow-wrap:anywhere]"
                      data-testid="acceptance-signer"
                    >
                      @if (row.acceptance.signer_name) {
                        <span class="block">{{ row.acceptance.signer_name }}</span>
                      }
                      @if (row.acceptance.signer_title) {
                        <span class="block">{{ row.acceptance.signer_title }}</span>
                      }
                      @if (row.acceptance.company_legal_name) {
                        <span class="block">{{ row.acceptance.company_legal_name }}</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingSection {
  private readonly store = inject(VendorPortalStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  protected readonly watch = inject(VendorBillingStripeWatch);
  protected readonly stripeNotice = this.watch.notice;
  /** The banner's copy key: the phases of a checkout and an add share their lines. */
  protected readonly noticeKey = computed(() => {
    const notice = this.stripeNotice();
    if (!notice) return null;
    if (notice.kind === 'cancelled') return 'cancelled';
    if (notice.phase === 'waiting')
      return notice.kind === 'checkout' ? 'checkout-waiting' : 'add-waiting';
    return notice.phase;
  });

  /**
   * After an assign: the license to focus, and the billing payload the write saw.
   * Focus moves once a newer payload has rendered, then this clears either way.
   */
  private readonly pendingFocus = signal<{
    readonly licenseId: string;
    readonly before: VendorBillingResponse | null;
  } | null>(null);
  /** A stale refusal's message, above the licenses table. It says what happened;
   *  the table below shows the current state. Replaced by the next refusal, and
   *  cleared by a successful assign. */
  protected readonly staleNotice = signal<string | null>(null);
  private readonly staleNoticeEl = viewChild<ElementRef<HTMLElement>>('staleNoticeEl');
  /** The outcome of a grant accept or its stale refusal (AECI-1615). Above the waiting
   *  card, so it survives the re-read that removes the grant. */
  protected readonly grantNotice = signal<GrantNotice | null>(null);
  private readonly grantNoticeEl = viewChild<ElementRef<HTMLElement>>('grantNoticeEl');
  private readonly injector = inject(Injector);
  /** Declared in this template, so the query sees controls stamped into the table. */
  private readonly licenseActions = viewChildren(VendorLicenseActions);

  /** Absent `me` (never on a real route) reads as a member: fail closed. */
  protected readonly isOwner = computed(() => this.store.me()?.seat_owner === true);
  protected readonly billing = this.store.billing;
  protected readonly loading = this.store.billingLoading;
  protected readonly failed = this.store.billingFailed;

  protected readonly acceptanceRows = computed<readonly AcceptanceRow[]>(() =>
    this.store.acceptances().map((acceptance) => ({
      acceptance,
      documentLabel: documentLabel(acceptance.document),
      href: acceptanceHref(acceptance.document, acceptance.version),
      acceptedLabel: formatTermDate(acceptance.accepted_at, this.locale),
      grantLabel: grantAcceptanceLabel(acceptance),
      policiesLabel: policiesLabel(acceptance),
      plansPage: plansPage(acceptance),
    })),
  );

  /** The summary card's column exists only when the card renders, so a member's
   *  note and the loading line keep the full width. */
  protected readonly topGridClass = computed(() =>
    this.isOwner() && !this.loading() && this.billing()
      ? 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-10'
      : 'block',
  );
  protected readonly thClass = 'py-2 pe-4 text-start font-label font-semibold';
  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => {
      if (!this.isOwner()) return;
      const checkout = this.takeCheckoutParam();
      void this.store.ensure('billing').then(() => {
        if (checkout === 'success') this.watch.watch('checkout', liveLicenseCount(this.billing()));
        else if (checkout === 'cancelled') this.watch.cancelled();
      });
    });
    afterRenderEffect(() => {
      const pending = this.pendingFocus();
      if (!pending || this.billing() === pending.before) return;
      const target = this.licenseActions().find((s) => s.license().id === pending.licenseId);
      this.pendingFocus.set(null);
      // Only take focus back from <body> or this section. If the vendor moved on
      // while the re-read ran, leave them where they are.
      const doc = this.host.nativeElement.ownerDocument;
      const active = doc.activeElement;
      const lost = !active || active === doc.body || !active.isConnected;
      if (target && (lost || this.host.nativeElement.contains(active))) target.focus();
    });
  }

  protected focusActionsAfterAssign(licenseId: string): void {
    this.staleNotice.set(null);
    this.pendingFocus.set({ licenseId, before: this.billing() });
  }

  protected async onStale(message: string): Promise<void> {
    this.staleNotice.set(message);
    await this.store.reload('billing');
    this.focusAfterReRead(this.staleNoticeEl);
  }

  /**
   * AECI-1615: a grant accept committed. Its licenses now exist, so re-read billing
   * (the pool gains them, the card loses the grant) and `/me` (a ban-term product is on
   * Managed again). Then say what landed where, with each warning (ruling R6).
   */
  protected async onGrantAccepted(
    grant: VendorPendingGrant,
    result: AcceptLicenseGrantResponse,
  ): Promise<void> {
    const count = result.license_ids.length;
    const names = new Map(grant.items.map((i) => [i.product_id, i.product?.name ?? null]));
    const lines: string[] = [];
    if (grant.kind === 'ban_term') {
      lines.push(
        $localize`:@@vendor.billing.grantPending.done.banTerm:Each subscription is back on its product, so those products are on Managed again.`,
      );
    } else {
      lines.push(
        count === 1
          ? $localize`:@@vendor.billing.grantPending.done.poolOne:The new subscription is in the pool below. Put it on a product to move that product to Managed.`
          : $localize`:@@vendor.billing.grantPending.done.pool:The ${count}:COUNT: new subscriptions are in the pool below. Put each one on a product to move that product to Managed.`,
      );
    }
    for (const warning of result.warnings) {
      const name = names.get(warning.product_id);
      if (warning.code === 'product_not_owned') {
        lines.push(
          name
            ? $localize`:@@vendor.billing.grantPending.done.notOwned:${name}:PRODUCT: is no longer on your account, so its new subscription is in the pool.`
            : $localize`:@@vendor.billing.grantPending.done.notOwnedUnnamed:A product is no longer on your account, so its new subscription is in the pool.`,
        );
        continue;
      }
      lines.push(
        name
          ? $localize`:@@vendor.billing.grantPending.done.licensed:${name}:PRODUCT: already had a subscription, so its new one is in the pool.`
          : $localize`:@@vendor.billing.grantPending.done.licensedUnnamed:A product already had a subscription, so its new one is in the pool.`,
      );
    }
    this.grantNotice.set({
      kind: 'accepted',
      title: $localize`:@@vendor.billing.grantPending.done.title:Subscriptions accepted`,
      lines,
    });
    this.staleNotice.set(null);
    await Promise.all([this.store.reload('billing'), this.store.revalidate(['entitlement'])]);
    this.focusAfterReRead(this.grantNoticeEl);
  }

  /** AECI-1615: the grant is not what this tab showed. Say so, re-read, keep focus. */
  protected async onGrantStale(message: string): Promise<void> {
    this.grantNotice.set({
      kind: 'stale',
      title: $localize`:@@vendor.billing.grantPending.stale.title:This grant changed`,
      lines: [message],
    });
    await this.store.reload('billing');
    this.focusAfterReRead(this.grantNoticeEl);
  }

  /** After a re-read, move focus to a notice when focus was lost or still in this
   *  section (WCAG 2.4.3). If the vendor moved on, leave them where they are. */
  private focusAfterReRead(target: () => ElementRef<HTMLElement> | undefined): void {
    afterNextRender(
      () => {
        const doc = this.host.nativeElement.ownerDocument;
        const active = doc.activeElement;
        const lost = !active || active === doc.body || !active.isConnected;
        if (lost || this.host.nativeElement.contains(active)) {
          target()?.nativeElement.focus();
        }
      },
      { injector: this.injector },
    );
  }

  /**
   * Stripe's return marker, read once from `location.search` and then dropped from
   * the URL so a reload or a shared link never replays the banner. The router does
   * the drop, with `replaceUrl`, so its own URL state stays in step.
   */
  private takeCheckoutParam(): 'success' | 'cancelled' | null {
    const search = this.document.defaultView?.location.search ?? '';
    const value = new URLSearchParams(search).get('checkout');
    if (value === null) return null;
    const tree = this.router.parseUrl(this.router.url);
    delete tree.queryParams['checkout'];
    void this.router.navigateByUrl(tree, { replaceUrl: true });
    return value === 'success' || value === 'cancelled' ? value : null;
  }

  protected retry(): void {
    void this.store.reload('billing');
  }
}
