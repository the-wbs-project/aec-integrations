import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import type { VendorBillingLicense } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { licenseActionErrorMessage, licenseActionIsStale } from './vendor-license-action-errors';

/**
 * The "Release at renewal" switch on a live, assigned license (AECI-1391, E5.5;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21; decision 11 of `VENDOR_SIGNUP_PROCESS.md`
 * §2). Over `PATCH /api/vendor/licenses/:id` (E5.2). The flag is for a product being
 * retired: at renewal the license comes off it, and the product goes back to Free.
 *
 * ── WHY A HAND-ROLLED SWITCH ───────────────────────────────────────────────
 * Angular Aria (ADR 0010) ships no switch, and this writes on activation. So it is
 * a native `<button role="switch">` with `aria-checked`, the pattern of
 * `vendor-nudge-mute-toggle.ts`. Space and Enter come from the native button.
 *
 * ── PESSIMISTIC, WITH THE PENDING STATE SHOWN ──────────────────────────────
 * The switch shows the asked-for state while the write runs (`aria-busy`), so the
 * click has visible feedback. The truth is the license from the billing read: the
 * write is awaited, billing re-read, and only then the pending state dropped. A
 * failure drops it at once, which puts the switch back, and shows the reason.
 */
@Component({
  selector: 'aec-vendor-license-release-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="flex items-start justify-end gap-3 text-start">
      <div class="min-w-0 max-w-[16rem]">
        <p [id]="id('label')" class="text-sm font-medium text-(--text-primary)">
          <span i18n="@@vendor.billing.release.label">Release at renewal</span>
        </p>
        <p
          [id]="id('help')"
          class="mt-0.5 text-xs leading-relaxed text-(--text-secondary)"
          i18n="@@vendor.billing.release.help"
        >
          At renewal the license comes off this product and it goes back to Free. Use it for a
          product you are retiring.
        </p>
      </div>
      <button
        #switchButton
        type="button"
        role="switch"
        [attr.aria-checked]="checked() ? 'true' : 'false'"
        [attr.aria-labelledby]="id('label')"
        [attr.aria-describedby]="id('help')"
        [attr.aria-busy]="busy() ? 'true' : null"
        (click)="toggle()"
        class="relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-(--text-tertiary) transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) aria-checked:bg-(--accent-primary) motion-reduce:transition-none"
        data-testid="license-release-switch"
      >
        <span
          aria-hidden="true"
          class="inline-block h-5 w-5 rounded-full bg-(--surface-base) transition-transform motion-reduce:transition-none"
          [class]="checked() ? 'translate-x-5' : 'translate-x-0.5'"
        ></span>
      </button>
    </div>
    @if (notice(); as message) {
      <p
        role="alert"
        class="mt-2 max-w-[22rem] text-start text-xs font-medium text-(--text-primary)"
        data-testid="license-release-error"
      >
        {{ message }}
      </p>
    }
  `,
})
export class VendorLicenseReleaseSwitch {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  /** A live license on a product. */
  readonly license = input.required<VendorBillingLicense>();

  /** The asked-for value while a write runs; `null` otherwise. */
  private readonly pending = signal<boolean | null>(null);
  protected readonly busy = computed(() => this.pending() !== null);
  protected readonly checked = computed(() => this.pending() ?? this.license().release_at_renewal);
  protected readonly notice = signal<string | null>(null);

  private readonly switchEl = viewChild<ElementRef<HTMLButtonElement>>('switchButton');

  /** Called by the Billing section after an assign puts this license on a product,
   *  so focus lands here instead of on `<body>` (AECI-1391). */
  focus(): void {
    this.switchEl()?.nativeElement.focus();
  }

  protected async toggle(): Promise<void> {
    if (this.busy()) return;
    const next = !this.license().release_at_renewal;
    this.pending.set(next);
    this.notice.set(null);
    try {
      await this.api.setReleaseAtRenewal(this.license().id, next);
      await this.store.reload('billing');
      this.pending.set(null);
      this.announcer.announce(
        next
          ? $localize`:@@vendor.billing.release.on:This license will come off its product at renewal.`
          : $localize`:@@vendor.billing.release.off:This license will renew on its product.`,
      );
    } catch (err) {
      this.pending.set(null);
      this.notice.set(licenseActionErrorMessage(err, 'release'));
      if (licenseActionIsStale(err)) void this.store.reload('billing');
    }
  }

  protected id(key: string): string {
    return `vendor-license-release-${this.license().id}-${key}`;
  }
}
