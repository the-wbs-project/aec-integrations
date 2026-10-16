import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { VendorBillingLicense, VendorBillingProduct } from '@aeci/shared';

import { FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { licenseActionErrorMessage, licenseActionIsStale } from './vendor-license-action-errors';

/**
 * Put a live pool license on a product (AECI-1391, E5.5; `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.21). Rendered in the Billing tab's licenses table, in the Actions cell of a live,
 * unassigned license, over `POST /api/vendor/licenses/:id/assign` (E5.2).
 *
 * ── A NATIVE SELECT ─────────────────────────────────────────────────────────
 * The vendor portal's pickers are native `<select>` elements with a visible label
 * (`vendor-not-ours.ts`, `vendor-contest-form.ts`). This follows them. The options
 * are `assignable_products`: owned products with no live license from any vendor.
 * With none, a sentence replaces the control.
 *
 * ── CONFIRM INLINE ──────────────────────────────────────────────────────────
 * Decision 11 of `VENDOR_SIGNUP_PROCESS.md` §2: an assigned license stays on its
 * product until renewal, and moving it is a request to AECi. So "Assign" opens an
 * inline confirmation that says so, and only its own button writes. Focus moves to
 * that button, and back to "Assign" on cancel or on Escape inside the confirmation
 * (ignored while the write runs). The pattern is `vendor-owned-retire.ts`.
 *
 * ── PESSIMISTIC ─────────────────────────────────────────────────────────────
 * Await the write, then re-read billing (`assignable_products` moved) and `/me` (the
 * product's plan is now Managed) through the store's `entitlement` scope, then
 * announce through the shell's one live region. A `409` or `404` also re-reads
 * billing, so the table shows what the server holds.
 *
 * ── FOCUS AFTER A SUCCESS ───────────────────────────────────────────────────
 * The re-read puts the license on a product, so the section swaps this control for
 * the actions menu and destroys the focused button. `assigned` fires as soon as
 * the write succeeds, while this control still exists, and the section moves focus
 * to the menu's trigger once it renders (WCAG 2.4.3).
 */
@Component({
  selector: 'aec-vendor-license-assign',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (products().length === 0) {
      <p
        class="max-w-[16rem] text-start text-xs text-(--text-secondary)"
        data-testid="license-assign-empty"
        i18n="@@vendor.billing.assign.none"
      >
        Every product you own already has a license.
      </p>
    } @else if (!confirming()) {
      <div class="flex flex-wrap items-end justify-end gap-2 text-start">
        <div class="min-w-[12rem]">
          <label
            [for]="id('product')"
            class="block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase"
            i18n="@@vendor.billing.assign.product"
            >Product</label
          >
          <div class="relative mt-1">
            <select
              [id]="id('product')"
              [class]="selectClass"
              [disabled]="busy()"
              (change)="onSelect($event)"
              data-testid="license-assign-select"
            >
              @for (product of products(); track product.id) {
                <option [value]="product.id" [selected]="product.id === selectedId()">
                  {{ product.name }}
                </option>
              }
            </select>
            <svg
              class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>
        <button
          #trigger
          type="button"
          [class]="secondaryClass"
          (click)="openConfirm()"
          data-testid="license-assign-trigger"
        >
          <span i18n="@@vendor.billing.assign.trigger">Assign</span>
        </button>
      </div>
    } @else {
      <div
        role="group"
        [attr.aria-labelledby]="id('title')"
        [attr.aria-describedby]="id('body')"
        class="max-w-[22rem] rounded-(--radius-md) border border-(--border-strong) bg-(--surface-sunken) p-3 text-start"
        (keydown.escape)="onEscape($event)"
        data-testid="license-assign-confirm"
      >
        <p [id]="id('title')" class="text-sm font-semibold text-(--text-primary)">
          {{ confirmTitle() }}
        </p>
        <p [id]="id('body')" class="mt-1 text-xs leading-relaxed text-(--text-secondary)">
          {{ confirmBody() }}
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            #confirm
            type="button"
            [class]="primaryClass"
            [disabled]="busy()"
            [attr.aria-busy]="busy() ? 'true' : null"
            (click)="assign()"
            data-testid="license-assign-submit"
          >
            @if (busy()) {
              <span i18n="@@vendor.billing.assign.assigning">Assigning…</span>
            } @else {
              <span i18n="@@vendor.billing.assign.confirm">Assign license</span>
            }
          </button>
          <button
            type="button"
            [class]="secondaryClass"
            [disabled]="busy()"
            (click)="cancelConfirm()"
            i18n="@@vendor.billing.assign.cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    }
    @if (notice(); as message) {
      <p
        role="alert"
        class="mt-2 max-w-[22rem] text-start text-xs font-medium text-(--text-primary)"
        data-testid="license-assign-error"
      >
        {{ message }}
      </p>
    }
  `,
})
export class VendorLicenseAssign {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** A live license in the pool. The section renders this for no other. */
  readonly license = input.required<VendorBillingLicense>();
  /** `assignable_products` from the billing read. */
  readonly products = input.required<readonly VendorBillingProduct[]>();
  /** The license id, once the write succeeds and before billing is re-read. The
   *  re-read destroys this control, so it cannot emit later. */
  readonly assigned = output<string>();
  /** A stale refusal (`409`/`404`), with its message. The section shows it and
   *  re-reads billing, because the re-read can destroy this control. */
  readonly stale = output<string>();

  /** The picked product. Resets to the first option when the list changes, or
   *  when the picked one has left it. */
  protected readonly selectedId = linkedSignal<readonly VendorBillingProduct[], string | null>({
    source: this.products,
    computation: (products, previous) => {
      const kept = previous?.value;
      if (kept && products.some((p) => p.id === kept)) return kept;
      return products[0]?.id ?? null;
    },
  });

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);

  private readonly triggerEl = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly confirmEl = viewChild<ElementRef<HTMLButtonElement>>('confirm');

  private readonly selected = computed(
    () => this.products().find((p) => p.id === this.selectedId()) ?? null,
  );

  protected readonly confirmTitle = computed(() => {
    const name = this.selected()?.name ?? '';
    return $localize`:@@vendor.billing.assign.confirmTitle:Assign this license to ${name}:PRODUCT:?`;
  });

  protected readonly confirmBody = computed(() => {
    const name = this.selected()?.name ?? '';
    return $localize`:@@vendor.billing.assign.confirmBody:The license stays on ${name}:PRODUCT: until renewal. Taking it off sooner is a request to AEC Integrations.`;
  });

  protected onSelect(event: Event): void {
    this.selectedId.set((event.target as HTMLSelectElement).value);
    this.notice.set(null);
  }

  protected openConfirm(): void {
    if (!this.selected()) return;
    this.notice.set(null);
    this.confirming.set(true);
    afterNextRender(() => this.confirmEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onEscape(event: Event): void {
    if (this.busy()) return;
    event.stopPropagation();
    this.cancelConfirm();
  }

  protected cancelConfirm(): void {
    this.confirming.set(false);
    afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async assign(): Promise<void> {
    const product = this.selected();
    if (this.busy() || !product) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      await this.api.assignLicense(this.license().id, product.id);
      this.assigned.emit(this.license().id);
      // The license now sits on the product, which moves both billing and the
      // product's plan on `/me`. One `entitlement` revalidation covers `/me` and
      // the checklists; the billing reload runs beside it and shares any in-flight
      // read.
      await Promise.all([this.store.reload('billing'), this.store.revalidate(['entitlement'])]);
      this.busy.set(false);
      this.confirming.set(false);
      this.announcer.announce(
        $localize`:@@vendor.billing.assign.done:License assigned. ${product.name}:PRODUCT: is now on the Managed plan.`,
      );
    } catch (err) {
      this.busy.set(false);
      this.confirming.set(false);
      const message = licenseActionErrorMessage(err, 'assign');
      if (licenseActionIsStale(err)) {
        this.stale.emit(message);
        return;
      }
      this.notice.set(message);
      afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
    }
  }

  protected id(key: string): string {
    return `vendor-license-assign-${this.license().id}-${key}`;
  }

  protected readonly selectClass = `${FIELD_INPUT_CLASS} cursor-pointer appearance-none pe-9`;
  protected readonly primaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
