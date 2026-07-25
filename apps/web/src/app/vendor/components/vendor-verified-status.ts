import { Component, computed, input } from '@angular/core';

/**
 * Verification-state indicator for the vendor dashboard (AECI-522). Shows the
 * read-only `vendors.verified` bit — the launch-minimum entitlement display (the
 * richer paid-tier display lands with AECI-515; don't block on it).
 *
 * The badge is **AECi-controlled**, never vendor-toggled
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6): a vendor can see whether they're verified
 * but cannot change it here — so this is a status read-out, not a control. The
 * caption says so.
 *
 * Bordered chip, not a fill (DESIGN.md "Borders-Not-Shadows"); the state is
 * conveyed by the tinted border/text token AND the text label — never colour
 * alone (WCAG 1.4.1). Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-verified-status',
  template: `
    <div class="flex flex-col gap-2">
      <span
        class="inline-flex w-fit items-center rounded-(--radius-sm) border px-2.5 py-0.5 text-xs font-semibold tracking-[0.01em]"
        [class]="toneClass()"
        >{{ label() }}</span
      >
      <p class="text-sm leading-relaxed text-(--text-secondary)">
        @if (verified()) {
          <span i18n="@@vendor.verified.caption.verified"
            >Your listing shows a verified badge. Verification is managed by AEC Integrations.</span
          >
        } @else {
          <span i18n="@@vendor.verified.caption.unverified"
            >Your listing is unverified. Verification is arranged with AEC Integrations, not from
            the dashboard.</span
          >
        }
      </p>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorVerifiedStatus {
  readonly verified = input.required<boolean>();

  protected readonly label = computed<string>(() =>
    this.verified()
      ? $localize`:@@vendor.verified.badge.verified:Verified`
      : $localize`:@@vendor.verified.badge.unverified:Unverified`,
  );

  protected readonly toneClass = computed<string>(() =>
    this.verified()
      ? 'border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)'
      : 'border-(--border-default) bg-(--surface-sunken) text-(--text-secondary)',
  );
}
