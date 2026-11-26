import { Component, ElementRef, computed, input, model, viewChild } from '@angular/core';

import { unusedAfterPurchase } from '@aeci/shared';

import { AecConsentBox } from '../../shared/form-field/consent-box';
import { CHOICE_INPUT_CLASS, FIELD_ERROR_CLASS } from '../../shared/form-field/form-field-classes';

/**
 * The unused-subscriptions warning on the Pay by card panel and in the Add subscriptions
 * dialog (AECI-1865, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21). It shows when a purchase
 * would leave subscriptions on no product: the ones bought now, plus the ones already in
 * the pool, less the products holding no live subscription (`unusedAfterPurchase`).
 *
 * The text sits in a `role="status"` region that is always in the DOM, so a screen
 * reader hears it when it appears or its numbers change. The box sits outside that
 * region: ticking it changes no text. The parent owns the box's state (`accepted`),
 * clears it when the quantity, interval or count changes, and refuses an unticked submit
 * with `error`. The submit button stays enabled (DESIGN.md "Submit stays enabled").
 */
@Component({
  selector: 'aec-vendor-billing-unused-warning',
  imports: [AecConsentBox],
  template: `
    <div role="status" [attr.id]="idPrefix() + '-unused-text'">
      @if (unused() > 0) {
        <div
          class="aec-notice-neutral max-w-[32rem] space-y-2 rounded-panel border bg-(--accent-warm) p-4 text-t-14 leading-[1.6] text-(--text-primary)"
          data-testid="unused-warning"
        >
          <p>
            @if (productsWithout() === 0) {
              <span i18n="@@vendor.billing.unused.productsNone"
                >Every product you own already has a subscription.</span
              >
            } @else {
              <span i18n="@@vendor.billing.unused.products">{productsWithout(), plural,
                =1 {1 of your products has no subscription.}
                other {{{ productsWithout() }} of your products have no subscription.}
              }</span>
            }
            @if (pool() > 0) {
              {{ ' ' }}
              <span i18n="@@vendor.billing.unused.pool">{pool(), plural,
                =1 {You already have 1 unused subscription in your pool.}
                other {You already have {{ pool() }} unused subscriptions in your pool.}
              }</span>
            }
          </p>
          <p class="font-semibold">
            @if (pool() > 0) {
              <span i18n="@@vendor.billing.unused.afterPool">{unused(), plural,
                =1 {
                  After this purchase, 1 of your subscriptions would not be on any product until you
                  add a product.
                }
                other {
                  After this purchase, {{ unused() }} of your subscriptions would not be on any
                  product until you add products.
                }
              }</span>
              {{ ' ' }}
              <span i18n="@@vendor.billing.unused.payNew">{quantity(), plural,
                =1 {You pay for the new one from today.}
                other {You pay for the new ones from today.}
              }</span>
            } @else if (newUnused() === quantity()) {
              <span i18n="@@vendor.billing.unused.allNew">{newUnused(), plural,
                =1 {
                  This subscription would not be on any product until you add a product. You pay for
                  it from today.
                }
                other {
                  All {{ newUnused() }} of these subscriptions would not be on any product until you
                  add products. You pay for them from today.
                }
              }</span>
            } @else {
              <span i18n="@@vendor.billing.unused.someNew">{newUnused(), plural,
                =1 {
                  1 of these subscriptions would not be on any product until you add a product. You
                  pay for it from today.
                }
                other {
                  {{ newUnused() }} of these subscriptions would not be on any product until you add
                  products. You pay for them from today.
                }
              }</span>
            }
          </p>
        </div>
      }
    </div>
    @if (unused() > 0) {
      <div class="mt-4 space-y-2">
        <div class="flex items-start gap-3">
          <input
            #box
            [id]="idPrefix() + '-unused-box'"
            type="checkbox"
            aecConsent
            [checked]="accepted()"
            aria-required="true"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="
              error()
                ? idPrefix() + '-unused-text ' + idPrefix() + '-unused-error'
                : idPrefix() + '-unused-text'
            "
            [class]="choiceInputClass + ' mt-1'"
            data-testid="unused-box"
            (change)="accepted.set(box.checked)"
          />
          <label
            [attr.for]="idPrefix() + '-unused-box'"
            class="text-sm leading-relaxed text-(--text-primary)"
            i18n="@@vendor.billing.unused.box"
            >{unused(), plural,
              =1 {I understand that 1 subscription will be unused.}
              other {I understand that {{ unused() }} subscriptions will be unused.}
            }</label
          >
        </div>
        @if (error(); as message) {
          <p
            [id]="idPrefix() + '-unused-error'"
            role="alert"
            [class]="errorClass"
            data-testid="unused-error"
          >
            {{ message }}
          </p>
        }
      </div>
    }
  `,
})
export class VendorBillingUnusedWarning {
  /** The parsed quantity, or `null` while the field holds no valid number. */
  readonly quantity = input.required<number | null>();
  /** Live subscriptions in the pool, on no product. */
  readonly pool = input.required<number>();
  /** Products of this vendor's holding no live subscription (`assignable_products`). */
  readonly productsWithout = input.required<number>();
  /** Prefix for the element ids, unique per form. */
  readonly idPrefix = input.required<string>();
  /** The unticked-submit refusal, under the box. */
  readonly error = input<string | null>(null);
  /** Whether the box is ticked. */
  readonly accepted = model(false);

  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');

  /** Zero while the quantity is invalid: the quantity error speaks first. */
  readonly unused = computed(() => {
    const quantity = this.quantity();
    if (quantity === null) return 0;
    return unusedAfterPurchase({
      quantity,
      pool: this.pool(),
      productsWithoutSubscription: this.productsWithout(),
    });
  });

  /** How many of the subscriptions bought now would be on no product. Used only with an
   *  empty pool: with spares in the pool, which ones stay unused is the owner's choice, so
   *  the sentence counts the account's subscriptions instead. */
  protected readonly newUnused = computed(() => Math.min(this.quantity() ?? 0, this.unused()));

  /** Move focus to the box, after an unticked submit or a changed count. */
  focusBox(): void {
    this.box()?.nativeElement.focus();
  }

  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
}
