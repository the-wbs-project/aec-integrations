import { Component, inject, input, signal } from '@angular/core';

import { VendorApi } from './vendor-api';

/**
 * What a seat of a suspended vendor sees instead of the portal (AECI-1623,
 * `VENDOR_SIGNUP_PROCESS.md` §2). `VendorPage` renders it when `vendorMeResolver` or a read
 * in an open portal hears `403 VENDOR_SUSPENDED`.
 *
 * Every portal read is refused, Billing included, so this component reads nothing and the
 * name comes from the 403's `details`. The one call it can make is the Stripe portal link,
 * the single vendor route `requireVendor({ allowSuspended: true })` lets through (ruling 6
 * of 2026-11-05), so a suspended vendor can still cancel by itself. That call answers 403
 * for a seat that is not an owner and 404 for a vendor with no Stripe customer. Both fall
 * back to the same sentence: reply to the notice.
 */
@Component({
  selector: 'aec-vendor-suspended-notice',
  template: `
    <section
      class="mx-auto w-full max-w-6xl px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="vendor-suspended-heading"
    >
      <h1
        id="vendor-suspended-heading"
        class="font-display text-3xl font-semibold tracking-tight md:text-4xl"
        i18n="@@vendor.suspended.heading"
      >
        This vendor account is suspended
      </h1>

      <div class="mt-8 grid gap-8 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div class="space-y-4 text-base text-(--text-secondary)">
          <p i18n="@@vendor.suspended.locked">
            The portal for {{ vendorName() }} is locked for every seat. The public listing stays
            live, and billing is unchanged.
          </p>
          <p i18n="@@vendor.suspended.notice">
            We emailed a notice to the owner seats and the billing email. It names the rule, the
            evidence and how long you have to respond.
          </p>
          <p i18n="@@vendor.suspended.support">
            Questions go to
            <a
              [href]="'mailto:' + supportEmail"
              class="font-medium text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 transition-colors hover:decoration-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >{{ supportEmail }}</a
            >.
          </p>
        </div>

        <div
          class="self-start rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
        >
          <h2 class="text-base font-bold" i18n="@@vendor.suspended.billing.heading">Billing</h2>
          <p class="mt-2 text-sm text-(--text-secondary)" i18n="@@vendor.suspended.billing.body">
            Owner seats can still see invoices and cancel in Stripe.
          </p>
          <button
            type="button"
            class="mt-4 inline-flex cursor-pointer items-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-2 text-sm font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            [disabled]="busy()"
            (click)="openPortal()"
          >
            @if (busy()) {
              <span i18n="@@vendor.suspended.billing.pending">Opening Stripe…</span>
            } @else {
              <span i18n="@@vendor.suspended.billing.action">Manage billing in Stripe</span>
            }
          </button>
          @if (portalFailed()) {
            <p
              class="mt-3 text-sm font-medium text-(--text-primary)"
              role="alert"
              i18n="@@vendor.suspended.billing.fallback"
            >
              We could not open Stripe for this seat. Reply to the notice email to cancel.
            </p>
          }
        </div>
      </div>
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorSuspendedNotice {
  private readonly api = inject(VendorApi);

  readonly vendorName = input.required<string>();

  protected readonly supportEmail = 'support@aecintegrations.com';
  protected readonly busy = signal(false);
  protected readonly portalFailed = signal(false);

  protected async openPortal(): Promise<void> {
    if (this.busy()) return;
    this.portalFailed.set(false);
    this.busy.set(true);
    try {
      const { url } = await this.api.openBillingPortal();
      // Busy stays on: the page is leaving.
      this.redirect(url);
    } catch {
      this.busy.set(false);
      this.portalFailed.set(true);
    }
  }

  /** The full-page move to Stripe. A method so a spec can stand in for it. */
  protected redirect(url: string): void {
    globalThis.location.assign(url);
  }
}
