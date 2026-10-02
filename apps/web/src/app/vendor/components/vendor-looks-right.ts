import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { readVendorApiError } from '../vendor-api-error';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore, type VendorPortalScope } from '../vendor-portal-store';

/** What "Looks right" confirms. One per AECI-1216 route. */
export type LooksRightTarget = 'profile' | 'product' | 'integrations';

/**
 * The "Looks right" button (AECI-1218, `STAGE_2_PAID_TIERS_SPEC.md` §13.8,
 * decision 7). It records "checked, nothing to change" on the company details,
 * one product's details, or one product's integration list.
 *
 * Free on every plan, so it reads no capability. The edit schemas refuse an
 * empty save, so this is the only way to stamp a review without an edit.
 *
 * After the write it revalidates the scopes the write moved, which refetches
 * `GET /api/vendor/me` and every loaded checklist (`STAGE_2_REALTIME_SPEC.md`
 * §2.3). Success is announced through the portal's one live region. A failure
 * stays beside the button as `role="alert"`, the portal's rule for errors.
 *
 * `done` is the checklist step's state, when the caller has it. A checked step
 * keeps its button: pressing it again moves the public "Updated" date, which is
 * the reason to press it.
 */
@Component({
  selector: 'aec-vendor-looks-right',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <button
        type="button"
        [class]="buttonClass"
        [disabled]="saving()"
        [attr.aria-describedby]="error() ? errorId() : null"
        (click)="confirm()"
        data-testid="looks-right"
      >
        @if (saving()) {
          <span i18n="@@vendor.looksRight.saving">Saving…</span>
        } @else {
          <span i18n="@@vendor.looksRight.button">Looks right</span>
        }
      </button>
      @if (showDone()) {
        <span
          class="inline-flex items-center gap-1.5 text-xs font-medium text-(--text-secondary)"
          data-testid="looks-right-done"
        >
          <svg
            aria-hidden="true"
            class="h-3.5 w-3.5 text-(--accent-primary)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span i18n="@@vendor.looksRight.checked">Checked</span>
        </span>
      }
      @if (error(); as msg) {
        <p
          [id]="errorId()"
          role="alert"
          class="basis-full text-xs font-medium text-(--text-primary)"
          data-testid="looks-right-error"
        >
          {{ msg }}
        </p>
      }
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorLooksRight {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  readonly target = input.required<LooksRightTarget>();
  /** Required for the two product targets. */
  readonly productId = input<string | null>(null);
  /** Names the product in the announcement. */
  readonly productName = input<string | null>(null);
  /** The checklist step is already done. */
  readonly done = input(false);

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Pressed successfully in this view, before the checklist refetch lands. */
  private readonly confirmed = signal(false);

  protected readonly showDone = computed(() => this.done() || this.confirmed());
  protected readonly errorId = computed(
    () => `looks-right-${this.target()}-${this.productId() ?? 'company'}-error`,
  );

  protected readonly buttonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-3 py-1.5 text-sm font-semibold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60';

  protected async confirm(): Promise<void> {
    if (this.saving()) return;
    const target = this.target();
    const productId = this.productId();
    if (target !== 'profile' && !productId) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      let scopes: VendorPortalScope[];
      if (target === 'profile') {
        await this.api.reviewProfile();
        scopes = ['profile'];
      } else if (target === 'product') {
        await this.api.reviewProduct(productId!);
        scopes = ['products'];
      } else {
        await this.api.reviewProductIntegrations(productId!);
        scopes = ['products', 'integrations'];
      }
      this.confirmed.set(true);
      this.announcer.announce(this.successMessage(target));
      await this.store.revalidate(scopes);
    } catch (err) {
      this.error.set(this.failureMessage(err));
    } finally {
      this.saving.set(false);
    }
  }

  private successMessage(target: LooksRightTarget): string {
    const name = this.productName();
    switch (target) {
      case 'profile':
        return $localize`:@@vendor.looksRight.done.profile:Company details marked as checked.`;
      case 'product':
        return name
          ? $localize`:@@vendor.looksRight.done.product:${name}:PRODUCT: details marked as checked.`
          : $localize`:@@vendor.looksRight.done.productGeneric:Product details marked as checked.`;
      default:
        return name
          ? $localize`:@@vendor.looksRight.done.integrations:${name}:PRODUCT: integration list marked as checked.`
          : $localize`:@@vendor.looksRight.done.integrationsGeneric:Integration list marked as checked.`;
    }
  }

  private failureMessage(err: unknown): string {
    if (readVendorApiError(err)?.status === 429) {
      return $localize`:@@vendor.looksRight.error.rateLimited:Too many saves in a short time. Wait a minute and try again.`;
    }
    return $localize`:@@vendor.looksRight.error:This could not be saved. Please try again.`;
  }
}
