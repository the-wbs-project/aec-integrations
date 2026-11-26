import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import {
  CHECKOUT_SIGNER_TITLE_MAX,
  STRIPE_LICENSE_QUANTITY_MAX,
  unusedAfterPurchase,
  type StripeBillingInterval,
  type VendorBillingResponse,
} from '@aeci/shared';
import {
  MANAGED_ANNUAL_PRICE_CENTS,
  MANAGED_LIST_PRICE_CENTS,
  nextRenewalDay,
} from '@aeci/shared/entitlements';

import { legalPath } from '../../legal/legal-manifest';
import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import {
  CHOICE_CARD_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FIELD_LABEL_TYPE_CLASS,
} from '../../shared/form-field/form-field-classes';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { VendorApi } from '../vendor-api';
import { focusIsLost } from '../focus-is-lost';
import { formatPlanPrice } from '../vendor-plan';
import { VendorPortalStore } from '../vendor-portal-store';
import {
  billedIntervalLabel,
  stripeBillingErrorMessage,
  type StripeBillingError,
} from './vendor-billing-stripe-errors';
import { VendorBillingStripeWatch, liveLicenseCount } from './vendor-billing-stripe-watch';
import { isReplayedEvent } from '../../core/event-replay';
import { BILLING_LINK_CLASS } from './vendor-billing-styles';
import { VendorBillingUnusedWarning } from './vendor-billing-unused-warning';

/** Per-license price in cents, by interval. Display only: Stripe bills from its own
 *  prices, resolved by lookup key on the API (`managed_annual`, `managed_monthly`). */
const PRICE_CENTS: Readonly<Record<StripeBillingInterval, number>> = {
  year: MANAGED_ANNUAL_PRICE_CENTS,
  month: MANAGED_LIST_PRICE_CENTS,
};

/** The quantity field's text as a valid license count, or `null`. */
function parseQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= STRIPE_LICENSE_QUANTITY_MAX ? n : null;
}

/**
 * The Billing tab's "Pay by card" panel (AECI-1502, E9.4 of AECI-1339;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21). Owner seats only, and only when the read
 * says `stripe_checkout_available` (amendment R2): the section decides both.
 *
 * ── TWO STATES ──────────────────────────────────────────────────────────────
 * No subscription: a billing-period choice with both list prices, a quantity, the
 * renewal disclosure, the agreement note and "Continue to Stripe". The Managed plan
 * agreement is accepted on Stripe's page, in its required terms box.
 *
 * The disclosure is here because 15 U.S.C. 8403 wants the material terms before billing
 * details are collected, and Stripe documents no slot above its card fields (AECI-1596).
 * Stripe's page repeats it above the Pay button (`renewalDisclosureMessage` in
 * `apps/api/src/routes/vendor-billing-stripe.ts`). Both read `nextRenewalDay`.
 *
 * A subscription (`billing.stripe`): its licenses, interval and period end, an
 * "Add licenses" dialog (quantity only, the same interval, pro-rated now) and
 * "Manage billing in Stripe", the Customer Portal.
 *
 * A lapsed card customer (`stripe` null, `stripe_customer` true) gets the buy form
 * and "Manage billing in Stripe" too: the portal still holds its past invoices and
 * receipts (AECI-1501). The API opens it with the annual config. With no live
 * subscription there is nothing in it to cancel.
 *
 * ── UNUSED SUBSCRIPTIONS (AECI-1865) ────────────────────────────────────────
 * Both forms show {@link VendorBillingUnusedWarning} when the purchase would leave
 * subscriptions on no product, with a required box. The submit stays enabled (DESIGN.md
 * "Submit stays enabled"): an unticked submit shows an error under the box, moves focus
 * there, and sends nothing. A change of quantity, interval or count clears the box. The
 * request carries the count, and the API refuses a count that differs from its own with
 * `409 UNUSED_SUBSCRIPTIONS_UNACKNOWLEDGED`: the panel re-reads billing, keeps the form
 * open, and moves focus to the cleared box.
 *
 * ── REDIRECTS ───────────────────────────────────────────────────────────────
 * Checkout and portal answer with a Stripe URL, and the browser goes there. An
 * accepted add answers `pending`: the licenses land with the webhook, so the panel
 * hands the wait to {@link VendorBillingStripeWatch}, which re-reads billing.
 *
 * ── THE DIALOG ──────────────────────────────────────────────────────────────
 * `BrnDialog.open()` runs from the click handler only, never inside `effect()`
 * (NG0602, the `vendor-seat-invite-dialog.ts` note).
 *
 * The card statement reads THE WBS PROJECT, the account descriptor: subscription
 * Checkout takes no descriptor suffix (ruling R3). The copy says exactly that.
 *
 * ── LOOK (AECI-1812) ────────────────────────────────────────────────────────
 * The panel is the shared white card. "Continue to Stripe" is the page's one primary
 * button and keeps its place after the disclosure, the liability cap and the agreement
 * note. Its disabled and busy guards are unchanged. "Add subscriptions" and "Manage
 * billing in Stripe" open something, so they are secondary. The dialog is the shared
 * dialog surface (`aec-dialog`). Nothing here renders inside a Stripe page or element:
 * Checkout and the Customer Portal are full-page redirects.
 */
@Component({
  selector: 'aec-vendor-billing-stripe-panel',
  imports: [
    AecButton,
    AecCard,
    RouterLink,
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    VendorBillingUnusedWarning,
  ],
  template: `
    <section
      aecCard
      [class]="'p-6'"
      aria-labelledby="vendor-billing-stripe-heading"
      data-testid="billing-stripe-panel"
    >
      @if (billing().stripe; as sub) {
        <h3 id="vendor-billing-stripe-heading" i18n="@@vendor.billing.stripe.sub.heading">
          Your Stripe plan
        </h3>
        <dl class="mt-4 grid gap-x-8 gap-y-4 text-t-14 sm:grid-cols-3">
          <div>
            <dt [class]="dtClass" i18n="@@vendor.billing.stripe.sub.licenses">Subscriptions</dt>
            <dd
              class="font-semibold text-(--text-primary) tabular-nums"
              data-testid="stripe-quantity"
            >
              {{ sub.quantity }}
            </dd>
          </div>
          <div>
            <dt [class]="dtClass" i18n="@@vendor.billing.stripe.sub.interval">Billing</dt>
            <dd class="font-semibold text-(--text-primary)" data-testid="stripe-interval">
              {{ billedLabel() }}
            </dd>
          </div>
          @if (periodEndLabel(); as end) {
            <div>
              <dt [class]="dtClass">
                @if (sub.cancel_at_period_end) {
                  <ng-container i18n="@@vendor.billing.stripe.sub.ends">Ends</ng-container>
                } @else {
                  <ng-container i18n="@@vendor.billing.stripe.sub.renews">Renews</ng-container>
                }
              </dt>
              <dd class="font-semibold text-(--text-primary)">{{ end }}</dd>
            </div>
          }
        </dl>
        @if (sub.cancel_at_period_end) {
          <p
            class="mt-4 max-w-[32rem] text-t-14 leading-[1.6] text-(--text-primary)"
            data-testid="stripe-cancelling"
            i18n="@@vendor.billing.stripe.sub.cancelling"
          >
            Your Stripe plan is set to end and will not renew. If you want to keep it, you will need
            to renew it in Stripe.
          </p>
        }
        @if (!sub.synced) {
          <p
            class="mt-4 max-w-[32rem] text-xs text-(--text-secondary)"
            data-testid="stripe-unsynced"
            i18n="@@vendor.billing.stripe.sub.unsynced"
          >
            Stripe could not be reached just now, so these figures come from the subscriptions we
            hold.
          </p>
        }
        <div class="mt-6 flex flex-wrap gap-3">
          <button
            aecButton
            variant="secondary"
            type="button"
            data-testid="stripe-add-open"
            (click)="openAdd()"
            i18n="@@vendor.billing.stripe.add.open"
          >
            Add subscriptions
          </button>
          <button
            aecButton
            variant="secondary"
            type="button"
            [disabled]="busy() === 'portal'"
            [attr.aria-busy]="busy() === 'portal'"
            data-testid="stripe-portal"
            (click)="portal()"
          >
            @if (busy() === 'portal') {
              <ng-container i18n="@@vendor.billing.stripe.portal.busy"
                >Opening Stripe…</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.billing.stripe.portal"
                >Manage billing in Stripe</ng-container
              >
            }
          </button>
        </div>
        <p [class]="hintClass + ' mt-4'" i18n="@@vendor.billing.stripe.portal.hint">
          Stripe holds your card, invoices and receipts. Card statements read THE WBS PROJECT.
        </p>
        @if (panelError(); as message) {
          <p
            #panelErrorEl
            role="alert"
            tabindex="-1"
            [class]="errorClass + ' mt-4 ' + focusRingClass"
            data-testid="stripe-error"
          >
            {{ message }}
          </p>
        }

        <brn-dialog [role]="'alertdialog'" [autoFocus]="'first-heading'" (closed)="onAddClosed()">
          <ng-template brnDialogContent>
            <form
              method="dialog"
              novalidate
              class="aec-dialog max-h-[85vh] w-[min(92vw,30rem)] overflow-y-auto p-6 md:p-8"
              data-testid="stripe-add-dialog"
              (submit)="add($event)"
            >
              <h2
                brnDialogTitle
                tabindex="-1"
                class="rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                i18n="@@vendor.billing.stripe.add.heading"
              >
                Add subscriptions
              </h2>
              <p
                brnDialogDescription
                class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
                data-testid="stripe-add-intro"
                i18n="@@vendor.billing.stripe.add.intro"
              >
                New subscriptions join your Stripe plan and are billed on the same schedule, at
                {{ unitPriceLabel() }}. Stripe charges your card now for the rest of the current
                period, pro-rated, plus tax where applicable.
              </p>
              <div class="mt-6 space-y-2">
                <label
                  for="vendor-billing-add-quantity"
                  [class]="labelClass"
                  i18n="@@vendor.billing.stripe.quantity"
                >
                  Number of subscriptions
                </label>
                <input
                  #addQuantityEl
                  id="vendor-billing-add-quantity"
                  type="number"
                  inputmode="numeric"
                  min="1"
                  [attr.max]="max"
                  step="1"
                  [class]="inputClass + ' max-w-32'"
                  [value]="addQuantity()"
                  [attr.aria-invalid]="addError() ? 'true' : null"
                  [attr.aria-describedby]="
                    addError()
                      ? 'vendor-billing-add-quantity-hint vendor-billing-add-error'
                      : 'vendor-billing-add-quantity-hint'
                  "
                  data-testid="stripe-add-quantity"
                  (input)="onAddQuantity($event)"
                />
                <p
                  id="vendor-billing-add-quantity-hint"
                  [class]="hintClass"
                  i18n="@@vendor.billing.stripe.quantity.hint"
                >
                  From 1 to 100.
                </p>
                @if (addError(); as message) {
                  <p
                    id="vendor-billing-add-error"
                    role="alert"
                    [class]="errorClass"
                    data-testid="stripe-add-error"
                  >
                    {{ message }}
                  </p>
                }
              </div>
              <aec-vendor-billing-unused-warning
                #addWarning
                class="mt-6 block"
                idPrefix="vendor-billing-add"
                [quantity]="addQuantityValue()"
                [pool]="poolCount()"
                [productsWithout]="productsWithoutCount()"
                [accepted]="addAccepted()"
                [error]="addUnusedError()"
                (acceptedChange)="onAddAccepted($event)"
              />
              <div class="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  aecButton
                  variant="secondary"
                  brnDialogClose
                  type="button"
                  i18n="@@vendor.billing.stripe.add.cancel"
                >
                  Cancel
                </button>
                <button
                  aecButton
                  type="submit"
                  [disabled]="busy() === 'add'"
                  [attr.aria-busy]="busy() === 'add'"
                  data-testid="stripe-add-submit"
                >
                  @if (busy() === 'add') {
                    <ng-container i18n="@@vendor.billing.stripe.add.busy">Adding…</ng-container>
                  } @else {
                    <ng-container i18n="@@vendor.billing.stripe.add.submit"
                      >Add subscriptions</ng-container
                    >
                  }
                </button>
              </div>
            </form>
          </ng-template>
        </brn-dialog>
      } @else {
        <h3 id="vendor-billing-stripe-heading" i18n="@@vendor.billing.stripe.buy.heading">
          Pay by card
        </h3>
        <p
          class="mt-2 text-t-14 leading-[1.6] text-(--text-secondary)"
          i18n="@@vendor.billing.stripe.buy.intro"
        >
          If you want subscriptions of your own, you can pay for them by card through Stripe. Each
          subscription puts one product on Managed.
        </p>
        <form method="dialog" novalidate class="mt-6 space-y-6" (submit)="checkout($event)">
          <fieldset class="mx-0 min-w-0 border-0 p-0">
            <legend [class]="labelClass + ' p-0'" i18n="@@vendor.billing.stripe.interval.legend">
              Billing period
            </legend>
            <div class="mt-2 grid max-w-[32rem] gap-2 sm:grid-cols-2">
              <label [class]="choiceClass" data-testid="stripe-interval-year">
                <input
                  type="radio"
                  name="vendor-billing-interval"
                  value="year"
                  [class]="choiceInputClass"
                  [checked]="interval() === 'year'"
                  (change)="onInterval('year')"
                />
                <span>
                  <span class="block" i18n="@@vendor.billing.stripe.interval.year">Annual</span>
                  <span class="block font-normal text-(--text-secondary)">{{
                    yearPriceLine()
                  }}</span>
                </span>
              </label>
              <label [class]="choiceClass" data-testid="stripe-interval-month">
                <input
                  type="radio"
                  name="vendor-billing-interval"
                  value="month"
                  [class]="choiceInputClass"
                  [checked]="interval() === 'month'"
                  (change)="onInterval('month')"
                />
                <span>
                  <span class="block" i18n="@@vendor.billing.stripe.interval.month">Monthly</span>
                  <span class="block font-normal text-(--text-secondary)">{{
                    monthPriceLine()
                  }}</span>
                </span>
              </label>
            </div>
          </fieldset>

          <div class="space-y-2">
            <label
              for="vendor-billing-buy-quantity"
              [class]="labelClass"
              i18n="@@vendor.billing.stripe.quantity"
            >
              Number of subscriptions
            </label>
            <input
              #buyQuantityEl
              id="vendor-billing-buy-quantity"
              type="number"
              inputmode="numeric"
              min="1"
              [attr.max]="max"
              step="1"
              [class]="inputClass + ' max-w-32'"
              [value]="buyQuantity()"
              [attr.aria-invalid]="quantityError() ? 'true' : null"
              [attr.aria-describedby]="
                quantityError()
                  ? 'vendor-billing-buy-quantity-hint vendor-billing-buy-quantity-error'
                  : 'vendor-billing-buy-quantity-hint'
              "
              data-testid="stripe-buy-quantity"
              (input)="onBuyQuantity($event)"
            />
            <p
              id="vendor-billing-buy-quantity-hint"
              [class]="hintClass"
              i18n="@@vendor.billing.stripe.quantity.hint"
            >
              From 1 to 100.
            </p>
            @if (quantityError(); as message) {
              <p
                id="vendor-billing-buy-quantity-error"
                role="alert"
                [class]="errorClass"
                data-testid="stripe-quantity-error"
              >
                {{ message }}
              </p>
            }
          </div>

          <!-- AECI-1625: the signer's title, recorded with the acceptance. An invited seat
               has no claim to take it from, so the form asks every buyer. -->
          <div class="space-y-2">
            <label
              for="vendor-billing-buy-title"
              [class]="labelClass"
              i18n="@@vendor.billing.stripe.title"
            >
              Your title
            </label>
            <input
              #signerTitleEl
              id="vendor-billing-buy-title"
              type="text"
              autocomplete="organization-title"
              [attr.maxlength]="titleMax"
              [class]="inputClass + ' max-w-md'"
              [value]="signerTitle()"
              [attr.aria-invalid]="titleError() ? 'true' : null"
              [attr.aria-describedby]="
                titleError()
                  ? 'vendor-billing-buy-title-hint vendor-billing-buy-title-error'
                  : 'vendor-billing-buy-title-hint'
              "
              data-testid="stripe-buy-title"
              (input)="onTitleInput($event)"
            />
            <p
              id="vendor-billing-buy-title-hint"
              [class]="hintClass"
              i18n="@@vendor.billing.stripe.title.hint"
            >
              We record your title with your acceptance of the Managed plan agreement.
            </p>
            @if (titleError(); as message) {
              <p
                id="vendor-billing-buy-title-error"
                role="alert"
                [class]="errorClass"
                data-testid="stripe-title-error"
              >
                {{ message }}
              </p>
            }
          </div>

          @if (disclosure(); as text) {
            <p
              class="max-w-[32rem] text-t-14 leading-[1.6] text-(--text-primary)"
              data-testid="stripe-disclosure"
            >
              {{ text }}
            </p>
          }

          <!-- AECI-1617 (counsel Q15): the same words as custom_text.submit on Stripe's page. -->
          <p
            class="max-w-[32rem] text-t-14 leading-[1.6] text-(--text-primary)"
            data-testid="stripe-cap"
            i18n="@@vendor.billing.stripe.cap"
          >
            Our liability under the agreement is limited to the greater of the fees you paid for
            this product's subscription in the twelve months before a claim, or $100, with the
            exceptions stated there. We are not liable for lost profits, lost business, or any
            indirect or consequential loss. See
            <a [routerLink]="agreementHref" [class]="linkClass">"Limit of liability"</a>
            in the agreement.
          </p>

          <p
            class="max-w-[32rem] text-t-14 leading-[1.6] text-(--text-secondary)"
            data-testid="stripe-agreement"
          >
            <ng-container i18n="@@vendor.billing.stripe.agreement">
              On the Stripe page you accept the
              <a [routerLink]="agreementHref" [class]="linkClass">Managed plan agreement</a>
              for these subscriptions.
            </ng-container>
            {{ ' ' }}
            <ng-container i18n="@@vendor.billing.stripe.statement"
              >Card statements read THE WBS PROJECT.</ng-container
            >
          </p>

          <aec-vendor-billing-unused-warning
            #buyWarning
            class="block"
            idPrefix="vendor-billing-buy"
            [quantity]="buyQuantityValue()"
            [pool]="poolCount()"
            [productsWithout]="productsWithoutCount()"
            [accepted]="buyAccepted()"
            [error]="buyUnusedError()"
            (acceptedChange)="onBuyAccepted($event)"
          />

          @if (panelError(); as message) {
            <p
              #panelErrorEl
              role="alert"
              tabindex="-1"
              [class]="errorClass + ' ' + focusRingClass"
              data-testid="stripe-error"
            >
              {{ message }}
            </p>
          }

          <button
            aecButton
            type="submit"
            [disabled]="busy() === 'checkout'"
            [attr.aria-busy]="busy() === 'checkout'"
            data-testid="stripe-checkout"
          >
            @if (busy() === 'checkout') {
              <ng-container i18n="@@vendor.billing.stripe.checkout.busy"
                >Opening Stripe…</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.billing.stripe.checkout"
                >Continue to Stripe</ng-container
              >
            }
          </button>
        </form>
        @if (billing().stripe_customer) {
          <div class="mt-6 border-t border-(--border-default) pt-6" data-testid="stripe-past">
            <p
              class="text-t-14 leading-[1.6] text-(--text-secondary)"
              i18n="@@vendor.billing.stripe.past.intro"
            >
              Your past card invoices and receipts are in Stripe.
            </p>
            <button
              aecButton
              variant="secondary"
              type="button"
              [class]="'mt-4'"
              [disabled]="busy() === 'portal'"
              [attr.aria-busy]="busy() === 'portal'"
              data-testid="stripe-portal"
              (click)="portal()"
            >
              @if (busy() === 'portal') {
                <ng-container i18n="@@vendor.billing.stripe.portal.busy"
                  >Opening Stripe…</ng-container
                >
              } @else {
                <ng-container i18n="@@vendor.billing.stripe.portal"
                  >Manage billing in Stripe</ng-container
                >
              }
            </button>
          </div>
        }
      }
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingStripePanel {
  readonly billing = input.required<VendorBillingResponse>();

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly watch = inject(VendorBillingStripeWatch);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild(BrnDialog);
  private readonly buyQuantityEl = viewChild<ElementRef<HTMLInputElement>>('buyQuantityEl');
  private readonly signerTitleEl = viewChild<ElementRef<HTMLInputElement>>('signerTitleEl');
  private readonly addQuantityEl = viewChild<ElementRef<HTMLInputElement>>('addQuantityEl');
  private readonly buyWarning = viewChild<VendorBillingUnusedWarning>('buyWarning');
  private readonly addWarning = viewChild<VendorBillingUnusedWarning>('addWarning');
  /** The panel's error line. Either branch renders one, so the ref follows the swap. */
  private readonly panelErrorEl = viewChild<ElementRef<HTMLElement>>('panelErrorEl');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly max = STRIPE_LICENSE_QUANTITY_MAX;
  protected readonly agreementHref = legalPath('managed-plan-agreement');

  protected readonly interval = signal<StripeBillingInterval>('year');
  protected readonly buyQuantity = signal('1');
  protected readonly titleMax = CHECKOUT_SIGNER_TITLE_MAX;
  /** This seat's own claim title. A computed, so a billing re-read that returns the same
   *  title (a legal name or billing email save) does not reset what the buyer typed. */
  private readonly prefillTitle = computed(() => this.billing().checkout_signer_title ?? '');
  /** The buyer's title (AECI-1625), pre-filled from this seat's own claim. */
  protected readonly signerTitle = linkedSignal(() => this.prefillTitle());
  /** A missing title on the buy form, under its field. */
  protected readonly titleError = signal<string | null>(null);
  protected readonly addQuantity = signal('1');
  protected readonly busy = signal<'checkout' | 'add' | 'portal' | null>(null);
  /** A refusal of checkout or portal, under the panel's action. */
  protected readonly panelError = signal<string | null>(null);
  /** A bad quantity on the buy form, under its field. */
  protected readonly quantityError = signal<string | null>(null);
  /** A refusal inside the add dialog. */
  protected readonly addError = signal<string | null>(null);

  // ── AECI-1865: the unused-subscriptions warning ─────────────────────────────
  /** The API's own counts from its last `409 UNUSED_SUBSCRIPTIONS_UNACKNOWLEDGED`. They win
   *  over the read until the next purchase or dialog open: the read can lag the API (a
   *  webhook in flight, a Stripe read that failed), and warning from the lagging numbers
   *  would refuse the owner forever. A later change refuses again and refreshes them. */
  private readonly serverCounts = signal<{ pool: number; productsWithout: number } | null>(null);
  /** Subscriptions on no product: the read's full count (`pool_count`), never the capped
   *  license list, with paid ones the webhook has not landed yet. */
  protected readonly poolCount = computed(
    () => this.serverCounts()?.pool ?? this.billing().pool_count,
  );
  /** Products holding no live subscription, from any vendor. */
  protected readonly productsWithoutCount = computed(
    () => this.serverCounts()?.productsWithout ?? this.billing().assignable_products.length,
  );
  protected readonly buyQuantityValue = computed(() => parseQuantity(this.buyQuantity()));
  protected readonly addQuantityValue = computed(() => parseQuantity(this.addQuantity()));
  private unusedFor(quantity: number | null): number {
    if (quantity === null) return 0;
    return unusedAfterPurchase({
      quantity,
      pool: this.poolCount(),
      productsWithoutSubscription: this.productsWithoutCount(),
    });
  }
  private readonly buyUnused = computed(() => this.unusedFor(this.buyQuantityValue()));
  private readonly addUnused = computed(() => this.unusedFor(this.addQuantityValue()));
  /** The buy form's box. A new quantity, interval or count clears it. */
  protected readonly buyAccepted = linkedSignal({
    source: () => `${this.buyQuantity()}|${this.interval()}|${this.buyUnused()}`,
    computation: () => false,
  });
  /** The add dialog's box. A new quantity or count clears it. */
  protected readonly addAccepted = linkedSignal({
    source: () => `${this.addQuantity()}|${this.addUnused()}`,
    computation: () => false,
  });
  /** An unticked submit, or the API's recount, under the box. */
  protected readonly buyUnusedError = signal<string | null>(null);
  protected readonly addUnusedError = signal<string | null>(null);

  private price(cents: number): string {
    return formatPlanPrice(cents, this.locale);
  }

  protected readonly yearPriceLine = computed(
    () =>
      $localize`:@@vendor.billing.stripe.price.year:${this.price(PRICE_CENTS.year)}:PRICE: a year per subscription`,
  );
  protected readonly monthPriceLine = computed(
    () =>
      $localize`:@@vendor.billing.stripe.price.month:${this.price(PRICE_CENTS.month)}:PRICE: a month per subscription`,
  );

  /**
   * Today's charge, the recurring charge, the renewal date, that it renews until
   * cancelled and how to cancel (AECI-1596). Nothing for a bad quantity.
   */
  protected readonly disclosure = computed(() => {
    const n = parseQuantity(this.buyQuantity());
    if (n === null) return null;
    const interval = this.interval();
    const total = this.price(PRICE_CENTS[interval] * n);
    const date = formatTermDate(nextRenewalDay(new Date(), interval), this.locale);
    return interval === 'year'
      ? $localize`:@@vendor.billing.stripe.disclosure.year:Today you pay ${total}:TOTAL:, before any discount and tax. Your Stripe plan then renews automatically at ${total}:TOTAL: a year, next on ${date}:DATE:, until you cancel. To cancel, use Manage billing in Stripe on this tab or email support@aecintegrations.com before the renewal date.`
      : $localize`:@@vendor.billing.stripe.disclosure.month:Today you pay ${total}:TOTAL:, before any discount and tax. Your Stripe plan then renews automatically at ${total}:TOTAL: a month, next on ${date}:DATE:, until you cancel. To cancel, use Manage billing in Stripe on this tab or email support@aecintegrations.com before the renewal date.`;
  });

  protected readonly billedLabel = computed(() => {
    const sub = this.billing().stripe;
    return sub ? billedIntervalLabel(sub.interval) : '';
  });

  protected readonly unitPriceLabel = computed(() => {
    const sub = this.billing().stripe;
    if (!sub) return '';
    return sub.interval === 'year' ? this.yearPriceLine() : this.monthPriceLine();
  });

  protected readonly periodEndLabel = computed(() => {
    const end = this.billing().stripe?.current_period_end;
    return end ? formatTermDate(end, this.locale) : null;
  });

  protected textOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected onBuyQuantity(event: Event): void {
    this.buyQuantity.set(this.textOf(event));
    this.buyUnusedError.set(null);
  }

  protected onInterval(interval: StripeBillingInterval): void {
    this.interval.set(interval);
    this.buyUnusedError.set(null);
  }

  protected onAddQuantity(event: Event): void {
    this.addQuantity.set(this.textOf(event));
    this.addUnusedError.set(null);
  }

  protected onBuyAccepted(accepted: boolean): void {
    this.buyAccepted.set(accepted);
    if (accepted) this.buyUnusedError.set(null);
  }

  protected onAddAccepted(accepted: boolean): void {
    this.addAccepted.set(accepted);
    if (accepted) this.addUnusedError.set(null);
  }

  private unticked(): string {
    return $localize`:@@vendor.billing.stripe.error.unusedBox:Tick the box to confirm you understand that some subscriptions will be unused.`;
  }

  /**
   * After the API's recount (`409 UNUSED_SUBSCRIPTIONS_UNACKNOWLEDGED`): re-read billing
   * so the warning shows the new count, clear the box, and put the message under it.
   * If the re-read leaves nothing unused, the message goes on `fallback` instead.
   */
  private async recount(
    mapped: StripeBillingError,
    form: 'buy' | 'add',
    fallback: (message: string) => void,
  ): Promise<void> {
    const { message } = mapped;
    await this.store.reload('billing');
    if (mapped.counts) this.serverCounts.set(mapped.counts);
    const accepted = form === 'buy' ? this.buyAccepted : this.addAccepted;
    const unused = form === 'buy' ? this.buyUnused() : this.addUnused();
    accepted.set(false);
    if (unused === 0) {
      fallback(message);
      return;
    }
    (form === 'buy' ? this.buyUnusedError : this.addUnusedError).set(message);
    afterNextRender(() => (form === 'buy' ? this.buyWarning() : this.addWarning())?.focusBox(), {
      injector: this.injector,
    });
  }

  protected onTitleInput(event: Event): void {
    this.signerTitle.set(this.textOf(event));
    this.titleError.set(null);
  }

  protected async checkout(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.busy()) return;
    this.panelError.set(null);
    const quantity = parseQuantity(this.buyQuantity());
    if (quantity === null) {
      this.quantityError.set(this.quantityMessage());
      this.buyQuantityEl()?.nativeElement.focus();
      return;
    }
    this.quantityError.set(null);
    const title = this.signerTitle().trim();
    if (title === '') {
      this.titleError.set(
        $localize`:@@vendor.billing.stripe.title.required:Enter your title. We record it with your acceptance.`,
      );
      this.signerTitleEl()?.nativeElement.focus();
      return;
    }
    this.titleError.set(null);
    const unused = this.buyUnused();
    if (unused > 0 && !this.buyAccepted()) {
      this.buyUnusedError.set(this.unticked());
      this.buyWarning()?.focusBox();
      return;
    }
    this.buyUnusedError.set(null);
    this.busy.set('checkout');
    try {
      const { url } = await this.api.startCheckout(
        quantity,
        this.interval(),
        title,
        unused > 0 ? unused : undefined,
      );
      // Busy stays on: the page is leaving.
      this.redirect(url);
    } catch (err) {
      this.busy.set(null);
      const mapped = stripeBillingErrorMessage(err, 'checkout');
      if (mapped.recount) {
        await this.recount(mapped, 'buy', (message) => this.panelError.set(message));
        return;
      }
      await this.fail(err, 'checkout');
    }
  }

  protected async portal(): Promise<void> {
    if (this.busy()) return;
    this.panelError.set(null);
    this.busy.set('portal');
    try {
      const { url } = await this.api.openBillingPortal();
      this.redirect(url);
    } catch (err) {
      this.busy.set(null);
      await this.fail(err, 'portal');
    }
  }

  /** Open the add dialog. From the click handler only (NG0602). */
  protected openAdd(): void {
    this.serverCounts.set(null);
    this.addQuantity.set('1');
    this.addAccepted.set(false);
    this.addUnusedError.set(null);
    this.addError.set(null);
    this.panelError.set(null);
    this.dialog()?.open();
  }

  protected onAddClosed(): void {
    this.addError.set(null);
    this.addUnusedError.set(null);
  }

  protected async add(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.busy()) return;
    const quantity = parseQuantity(this.addQuantity());
    if (quantity === null) {
      this.addError.set(this.quantityMessage());
      this.addQuantityEl()?.nativeElement.focus();
      return;
    }
    this.addError.set(null);
    const unused = this.addUnused();
    if (unused > 0 && !this.addAccepted()) {
      this.addUnusedError.set(this.unticked());
      this.addWarning()?.focusBox();
      return;
    }
    this.addUnusedError.set(null);
    this.busy.set('add');
    const baseline = liveLicenseCount(this.billing());
    try {
      await this.api.addStripeLicenses(quantity, unused > 0 ? unused : undefined);
      this.serverCounts.set(null);
      this.busy.set(null);
      this.dialog()?.close();
      this.watch.watch('add', baseline);
    } catch (err) {
      this.busy.set(null);
      const mapped = stripeBillingErrorMessage(err, 'add');
      if (mapped.recount) {
        await this.recount(mapped, 'add', (message) => this.addError.set(message));
        return;
      }
      if (mapped.stale) {
        // The subscription is not what this tab showed. The re-read can remove the
        // branch that holds this dialog, so close it and keep the message on the
        // panel, which survives the swap.
        this.dialog()?.close();
        this.panelError.set(mapped.message);
        await this.store.reload('billing');
        this.focusPanelError(true);
        return;
      }
      this.addError.set(mapped.message);
      afterNextRender(() => this.addQuantityEl()?.nativeElement.focus(), {
        injector: this.injector,
      });
    }
  }

  private quantityMessage(): string {
    return $localize`:@@vendor.billing.stripe.error.quantity:Enter a number of subscriptions from 1 to 100.`;
  }

  private async fail(err: unknown, action: 'checkout' | 'portal'): Promise<void> {
    const mapped = stripeBillingErrorMessage(err, action);
    this.panelError.set(mapped.message);
    // A 409 means the subscription is not what this tab showed: re-read, so the
    // panel swaps to the controls that fit. The message stays.
    if (!mapped.stale) return;
    await this.store.reload('billing');
    this.focusPanelError();
  }

  /**
   * After a stale re-read, move focus to the panel's error line (WCAG 2.4.3). The
   * swap destroys the control that had focus, which drops it to <body>. As in the
   * section's `onStale`, focus moves only when it was lost or still inside the panel.
   * `fromDialog`: the add dialog renders in an overlay outside the panel and may still
   * hold focus while it closes, so a refusal from it always moves focus.
   */
  private focusPanelError(fromDialog = false): void {
    afterNextRender(
      () => {
        const doc = this.host.nativeElement.ownerDocument;
        const active = doc.activeElement;
        const lost = focusIsLost(doc);
        if (fromDialog || lost || this.host.nativeElement.contains(active)) {
          this.panelErrorEl()?.nativeElement.focus();
        }
      },
      { injector: this.injector },
    );
  }

  /** The full-page move to Stripe. A method so a spec can stand in for it. */
  protected redirect(url: string): void {
    globalThis.location.assign(url);
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly focusRingClass =
    'rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  protected readonly choiceClass = CHOICE_CARD_CLASS;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  protected readonly linkClass = BILLING_LINK_CLASS;
  /** A figure's label in "Your Stripe plan": the Label role. */
  protected readonly dtClass = FIELD_LABEL_TYPE_CLASS;
}
