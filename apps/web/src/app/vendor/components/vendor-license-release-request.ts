import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  LOCALE_ID,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { LICENSE_RELEASE_REASON_MAX, type VendorBillingLicense } from '@aeci/shared';

import {
  BUTTON_PRIMARY_CLASS,
  BUTTON_SECONDARY_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { licenseActionErrorMessage, licenseActionIsStale } from './vendor-license-action-errors';

/**
 * "Request early unassign" on a live, assigned license (AECI-1391, E5.5;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21; decision 11 and §3 step 8 of
 * `VENDOR_SIGNUP_PROCESS.md`). A license stays on its product until renewal; taking it
 * off sooner is a request AECi approves on `/admin/requests` (`ADMIN_PANEL_SPEC.md`
 * §5.17). The write is `POST /api/vendor/licenses/:id/release-request` (AECI-1373).
 *
 * A modal, not an inline form, because the reason is free text the operator decides
 * on, and the request is rare and deliberate. The pattern is
 * `vendor-seat-invite-dialog.ts`: `BrnDialog.open()` runs from the click handler
 * only, never from an `effect()` (NG0602).
 *
 * With a request already open, the button gives way to "Early unassign requested"
 * and its date: a second ask would `409 RELEASE_REQUEST_OPEN`.
 *
 * Pessimistic: await the write, close the dialog, re-read billing (which now carries
 * `open_release_request`), announce. A failure stays in the dialog, and a `409` or
 * `404` re-reads billing too.
 */
@Component({
  selector: 'aec-vendor-license-release-request',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [BrnDialog, BrnDialogContent, BrnDialogClose, BrnDialogTitle, BrnDialogDescription],
  template: `
    @if (requestedLabel(); as requested) {
      <p
        #requestedLine
        tabindex="-1"
        class="text-sm text-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        data-testid="license-release-requested"
      >
        {{ requested }}
      </p>
    } @else {
      <button
        type="button"
        [class]="triggerClass"
        (click)="open()"
        data-testid="license-release-request-trigger"
      >
        <span i18n="@@vendor.billing.request.trigger">Request early unassign</span>
      </button>

      <brn-dialog>
        <ng-template brnDialogContent>
          <div
            class="max-h-[85vh] w-[min(92vw,32rem)] overflow-y-auto rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6 text-start text-(--text-primary) md:p-8"
          >
            <div class="flex items-start justify-between gap-4">
              <h2
                brnDialogTitle
                class="font-display text-xl font-semibold text-(--text-primary)"
                i18n="@@vendor.billing.request.heading"
              >
                Request early unassign
              </h2>
              <button
                brnDialogClose
                type="button"
                class="-me-1 -mt-1 shrink-0 rounded-(--radius-sm) p-1 text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n-aria-label="@@vendor.billing.request.close"
                aria-label="Close"
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

            <p
              brnDialogDescription
              class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
              data-testid="license-release-request-description"
            >
              {{ description() }}
            </p>

            <form class="mt-6 space-y-4" (submit)="submit($event)" novalidate>
              <div class="space-y-1.5">
                <label
                  [for]="id('reason')"
                  [class]="labelClass"
                  i18n="@@vendor.billing.request.reason"
                  >Reason</label
                >
                <textarea
                  [id]="id('reason')"
                  name="reason"
                  rows="4"
                  required
                  [attr.maxlength]="reasonMax"
                  [value]="reason()"
                  (input)="onInput($event)"
                  [attr.aria-invalid]="error() ? 'true' : null"
                  [attr.aria-describedby]="error() ? id('hint') + ' ' + id('error') : id('hint')"
                  [class]="inputClass"
                  data-testid="license-release-request-reason"
                ></textarea>
                <p [id]="id('hint')" [class]="hintClass" i18n="@@vendor.billing.request.hint">
                  Tell us why the license should come off now. Up to 1,000 characters.
                </p>
                @if (error(); as message) {
                  <p [id]="id('error')" [class]="errorClass" role="alert">{{ message }}</p>
                }
              </div>
              <div class="flex flex-wrap items-center justify-end gap-3">
                <button
                  brnDialogClose
                  type="button"
                  [disabled]="busy()"
                  [class]="secondaryClass"
                  i18n="@@vendor.billing.request.cancel"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  [disabled]="busy()"
                  [attr.aria-busy]="busy() ? 'true' : null"
                  [class]="primaryClass"
                  data-testid="license-release-request-submit"
                >
                  @if (busy()) {
                    <span i18n="@@vendor.billing.request.sending">Sending…</span>
                  } @else {
                    <span i18n="@@vendor.billing.request.send">Send request</span>
                  }
                </button>
              </div>
            </form>
          </div>
        </ng-template>
      </brn-dialog>
    }
  `,
})
export class VendorLicenseReleaseRequest {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly locale = inject(LOCALE_ID);

  /** A live license on a product. */
  readonly license = input.required<VendorBillingLicense>();

  private readonly injector = inject(Injector);
  private readonly dialog = viewChild(BrnDialog);
  /** Where focus lands after a sent request: the trigger it came from is gone. */
  private readonly requestedEl = viewChild<ElementRef<HTMLElement>>('requestedLine');

  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly reasonMax = LICENSE_RELEASE_REASON_MAX;

  protected readonly requestedLabel = computed(() => {
    const open = this.license().open_release_request;
    if (!open) return null;
    const date = formatTermDate(open.created_at, this.locale);
    return $localize`:@@vendor.billing.request.requested:Early unassign requested ${date}:DATE:`;
  });

  protected readonly description = computed(() => {
    const name = this.license().assigned_product?.name ?? '';
    return $localize`:@@vendor.billing.request.description:AEC Integrations reviews the request. If it is approved, the license comes off ${name}:PRODUCT: and goes back to your pool, and the product goes back to Free.`;
  });

  /** From the trigger's click handler only. See the NG0602 note above. */
  protected open(): void {
    this.reason.set('');
    this.error.set(null);
    this.dialog()?.open();
  }

  protected onInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    this.error.set(null);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const reason = this.reason().trim();
    if (reason.length === 0) {
      this.error.set(
        $localize`:@@vendor.billing.request.reasonRequired:Give a reason. AEC Integrations decides on it.`,
      );
      return;
    }
    if (reason.length > LICENSE_RELEASE_REASON_MAX) {
      this.error.set(
        $localize`:@@vendor.billing.error.reason:Give a reason of up to 1,000 characters.`,
      );
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.requestLicenseRelease(this.license().id, reason);
      this.busy.set(false);
      this.dialog()?.close();
      await this.store.reload('billing');
      afterNextRender(() => this.requestedEl()?.nativeElement.focus(), {
        injector: this.injector,
      });
      this.announcer.announce(
        $localize`:@@vendor.billing.request.done:Early unassign requested. AEC Integrations will review it.`,
      );
    } catch (err) {
      this.busy.set(false);
      this.error.set(licenseActionErrorMessage(err, 'request'));
      if (licenseActionIsStale(err)) void this.store.reload('billing');
    }
  }

  protected id(key: string): string {
    return `vendor-license-request-${this.license().id}-${key}`;
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly secondaryClass = `${BUTTON_SECONDARY_CLASS} disabled:cursor-not-allowed disabled:opacity-50`;
  protected readonly triggerClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}
