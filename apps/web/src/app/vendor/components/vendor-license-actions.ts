import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
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
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { LICENSE_RELEASE_REASON_MAX, type VendorBillingLicense } from '@aeci/shared';

import {
  BUTTON_PRIMARY_CLASS,
  BUTTON_SECONDARY_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { licenseActionErrorMessage, licenseActionIsStale } from './vendor-license-action-errors';

/** When the license comes off its product. */
type ReleaseTiming = 'renewal' | 'now';

type MenuAction = 'release' | 'keep';

/**
 * The actions on a live, assigned license (AECI-1391, E5.5;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21; decision 11 and §3 step 8 of
 * `VENDOR_SIGNUP_PROCESS.md`): one icon button that opens a menu, so the row stays a
 * row. The two ways a license comes off a product live behind "Release license":
 *
 * - **At renewal.** `PATCH /api/vendor/licenses/:id` sets `release_at_renewal`
 *   (E5.2). The vendor decides alone, and "Keep at renewal" in the same menu undoes it.
 * - **Now.** `POST /api/vendor/licenses/:id/release-request` (AECI-1373) asks AECi,
 *   with a reason. AECi approves it on `/admin/requests` (`ADMIN_PANEL_SPEC.md` §5.17).
 *
 * What is already set shows as a Status badge in the table
 * (`vendor-billing-licenses.ts`), not here. An option already in effect is left out
 * of the dialog, and with both in effect "Release license" leaves the menu.
 *
 * ── THE MENU ───────────────────────────────────────────────────────────────
 * A `BrnPopover` holding a list of plain buttons, the pattern of the header's
 * `layout/user-menu.ts`: CDK overlay (so the sideways-scrolling table does not clip
 * it), focus trap, Escape and outside-click close, focus back to the trigger, and
 * `aria-haspopup`/`aria-expanded` on the trigger. No `role="menu"`.
 *
 * Not `@angular/aria/menu` (ADR 0010's row for application menus) and not
 * `@angular/cdk/menu`. The header's eager combobox already imports a module that
 * each of them shares, and esbuild then keeps that whole module in `main`: Aria's
 * menu patterns, or CDK's list key manager (+7.8 kB raw). That cost lands on every
 * public page and breaks the 1.05 MB initial budget. `BrnPopover` is already eager,
 * so this menu adds nothing there. ADR 0010 records the exception.
 *
 * ── THE DIALOG ─────────────────────────────────────────────────────────────
 * `BrnDialog.open()` runs from the menu item's click handler, never from an
 * `effect()` (NG0602). Focus moves to the trigger and the popover closes first, so
 * the dialog hands focus back to the trigger, not to a destroyed menu item.
 *
 * Every write is pessimistic: await it, close the dialog, re-read billing, announce.
 * A failure stays in the dialog. A `409` or `404` closes it and goes to the section
 * as `stale`, because the re-read can remove this control.
 */
@Component({
  selector: 'aec-vendor-license-actions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [
    BrnPopover,
    BrnPopoverContent,
    BrnPopoverTrigger,
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
  ],
  template: `
    <div class="flex items-center justify-end gap-3">
      <button
        #triggerEl
        type="button"
        brnPopoverTrigger
        [brnPopoverTriggerFor]="actionsMenu"
        [attr.aria-label]="triggerLabel()"
        [class]="triggerClass"
        data-testid="license-actions-trigger"
      >
        <svg class="size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
      </button>
    </div>

    <brn-popover #actionsMenu="brnPopover" class="contents" align="end" [sideOffset]="4">
      <ng-template brnPopoverContent>
        <ul
          [attr.aria-label]="triggerLabel()"
          class="m-0 flex min-w-[12rem] list-none flex-col gap-0.5 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-1.5 shadow-lg"
          data-testid="license-actions-menu"
        >
          @if (canRelease()) {
            <li>
              <button
                type="button"
                (click)="onSelect('release')"
                [class]="itemClass"
                data-testid="license-actions-release"
                i18n="@@vendor.billing.actions.release"
              >
                Release license
              </button>
            </li>
          }
          @if (license().release_at_renewal) {
            <li>
              <button
                type="button"
                (click)="onSelect('keep')"
                [class]="itemClass"
                data-testid="license-actions-keep"
                i18n="@@vendor.billing.actions.keep"
              >
                Keep at renewal
              </button>
            </li>
          }
        </ul>
      </ng-template>
    </brn-popover>

    @if (notice(); as message) {
      <p
        role="alert"
        class="mt-2 ms-auto max-w-[22rem] text-end text-xs font-medium text-(--text-primary)"
        data-testid="license-actions-error"
      >
        {{ message }}
      </p>
    }

    <brn-dialog #releaseDialog="brnDialog">
      <ng-template brnDialogContent>
        <div
          class="max-h-[85vh] w-[min(92vw,32rem)] overflow-y-auto rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6 text-start text-(--text-primary) md:p-8"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              class="font-display text-xl font-semibold text-(--text-primary)"
              i18n="@@vendor.billing.release.heading"
            >
              Release license
            </h2>
            <button
              brnDialogClose
              type="button"
              class="-me-1 -mt-1 shrink-0 rounded-(--radius-sm) p-1 text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n-aria-label="@@vendor.billing.release.close"
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
            data-testid="license-release-description"
          >
            {{ description() }}
          </p>

          <form class="mt-6 space-y-5" (submit)="submit($event)" novalidate>
            <fieldset class="space-y-3">
              <legend class="sr-only" i18n="@@vendor.billing.release.when">
                When should the license come off?
              </legend>
              @if (canReleaseAtRenewal()) {
                <label [class]="optionClass" data-testid="license-release-option-renewal">
                  <input
                    type="radio"
                    [name]="id('timing')"
                    value="renewal"
                    [checked]="timing() === 'renewal'"
                    (change)="pick('renewal')"
                    class="mt-0.5 h-4 w-4 shrink-0 accent-(--accent-primary)"
                  />
                  <span>
                    <span
                      class="block text-sm font-medium text-(--text-primary)"
                      i18n="@@vendor.billing.release.renewal"
                      >At renewal</span
                    >
                    <span
                      class="mt-0.5 block text-sm leading-relaxed text-(--text-secondary)"
                      i18n="@@vendor.billing.release.renewalHelp"
                      >The license stays on the product until the term renews, then comes off. You
                      can undo this until then.</span
                    >
                  </span>
                </label>
              }
              @if (canRequestNow()) {
                <label [class]="optionClass" data-testid="license-release-option-now">
                  <input
                    type="radio"
                    [name]="id('timing')"
                    value="now"
                    [checked]="timing() === 'now'"
                    (change)="pick('now')"
                    class="mt-0.5 h-4 w-4 shrink-0 accent-(--accent-primary)"
                  />
                  <span>
                    <span
                      class="block text-sm font-medium text-(--text-primary)"
                      i18n="@@vendor.billing.release.now"
                      >Now</span
                    >
                    <span
                      class="mt-0.5 block text-sm leading-relaxed text-(--text-secondary)"
                      i18n="@@vendor.billing.release.nowHelp"
                      >AEC Integrations reviews the request. If it is approved, the license comes
                      off now.</span
                    >
                  </span>
                </label>
              }
            </fieldset>

            @if (timing() === 'now') {
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
                  [attr.aria-invalid]="reasonInvalid() ? 'true' : null"
                  [attr.aria-describedby]="
                    reasonInvalid() ? id('hint') + ' ' + id('error') : id('hint')
                  "
                  [class]="inputClass"
                  data-testid="license-release-reason"
                ></textarea>
                <p [id]="id('hint')" [class]="hintClass" i18n="@@vendor.billing.request.hint">
                  Tell us why the license should come off now. Up to 1,000 characters.
                </p>
              </div>
            }

            @if (error(); as message) {
              <p
                [id]="id('error')"
                [class]="errorClass"
                role="alert"
                data-testid="license-release-error"
              >
                {{ message }}
              </p>
            }

            <div class="flex flex-wrap items-center justify-end gap-3">
              <button
                brnDialogClose
                type="button"
                [disabled]="busy()"
                [class]="secondaryClass"
                i18n="@@vendor.billing.release.cancel"
              >
                Cancel
              </button>
              <button
                type="submit"
                [disabled]="busy()"
                [attr.aria-busy]="busy() ? 'true' : null"
                [class]="primaryClass"
                data-testid="license-release-submit"
              >
                @if (busy()) {
                  <span i18n="@@vendor.billing.release.saving">Saving…</span>
                } @else if (timing() === 'now') {
                  <span i18n="@@vendor.billing.request.send">Send request</span>
                } @else {
                  <span i18n="@@vendor.billing.release.confirm">Release at renewal</span>
                }
              </button>
            </div>
          </form>
        </div>
      </ng-template>
    </brn-dialog>
  `,
})
export class VendorLicenseActions {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  /** A live license on a product. */
  readonly license = input.required<VendorBillingLicense>();
  /** A stale refusal (`409`/`404`), with its message. The section shows it and
   *  re-reads billing, because the re-read can remove this control. */
  readonly stale = output<string>();

  /** By ref: `BrnPopover` extends `BrnDialog`, so a type query would find the menu. */
  private readonly dialog = viewChild<BrnDialog>('releaseDialog');
  private readonly popover = viewChild(BrnPopover);
  private readonly triggerEl = viewChild<ElementRef<HTMLButtonElement>>('triggerEl');

  protected readonly timing = signal<ReleaseTiming>('renewal');
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** A failed "Keep at renewal", which has no dialog to show it in. */
  protected readonly notice = signal<string | null>(null);
  protected readonly reasonMax = LICENSE_RELEASE_REASON_MAX;

  protected readonly canReleaseAtRenewal = computed(() => !this.license().release_at_renewal);
  protected readonly canRequestNow = computed(() => !this.license().open_release_request);
  protected readonly canRelease = computed(
    () => this.canReleaseAtRenewal() || this.canRequestNow(),
  );
  protected readonly reasonInvalid = computed(
    () => this.timing() === 'now' && this.error() !== null,
  );

  private readonly productName = computed(() => this.license().assigned_product?.name ?? '');

  protected readonly triggerLabel = computed(() => {
    const name = this.productName();
    return $localize`:@@vendor.billing.actions.label:Actions for the ${name}:PRODUCT: license`;
  });

  protected readonly description = computed(() => {
    const name = this.productName();
    return $localize`:@@vendor.billing.release.description:The license comes off ${name}:PRODUCT: and goes back to your pool, and the product goes back to Free.`;
  });

  /** Called by the Billing section after an assign puts this license on a product,
   *  so focus lands here instead of on `<body>` (AECI-1391). */
  focus(): void {
    this.triggerEl()?.nativeElement.focus();
  }

  /** A menu item's click: an event, so opening the dialog here is safe. */
  protected onSelect(action: MenuAction): void {
    // Focus the trigger before the menu goes. The dialog returns focus to whatever
    // held it at open, and the menu item is about to be destroyed.
    this.focus();
    this.popover()?.close();
    this.notice.set(null);
    if (action === 'release') this.openDialog();
    else if (action === 'keep') void this.keep();
  }

  private openDialog(): void {
    this.timing.set(this.canReleaseAtRenewal() ? 'renewal' : 'now');
    this.reason.set('');
    this.error.set(null);
    this.dialog()?.open();
  }

  protected pick(timing: ReleaseTiming): void {
    this.timing.set(timing);
    this.error.set(null);
  }

  protected onInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    this.error.set(null);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    if (this.timing() === 'now') await this.requestNow();
    else await this.releaseAtRenewal();
  }

  private async releaseAtRenewal(): Promise<void> {
    await this.write(
      () => this.api.setReleaseAtRenewal(this.license().id, true),
      'release',
      $localize`:@@vendor.billing.release.on:This license will come off its product at renewal.`,
    );
  }

  private async requestNow(): Promise<void> {
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
    await this.write(
      () => this.api.requestLicenseRelease(this.license().id, reason),
      'request',
      $localize`:@@vendor.billing.request.done:Early unassign requested. AEC Integrations will review it.`,
    );
  }

  /** The dialog's write: pessimistic, and a stale refusal goes to the section. */
  private async write(
    run: () => Promise<unknown>,
    action: 'release' | 'request',
    done: string,
  ): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await run();
      this.busy.set(false);
      this.dialog()?.close();
      await this.store.reload('billing');
      this.announcer.announce(done);
    } catch (err) {
      this.busy.set(false);
      const message = licenseActionErrorMessage(err, action);
      if (licenseActionIsStale(err)) {
        this.dialog()?.close();
        this.stale.emit(message);
        return;
      }
      this.error.set(message);
    }
  }

  /** "Keep at renewal": reversible, so no dialog. */
  private async keep(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.setReleaseAtRenewal(this.license().id, false);
      await this.store.reload('billing');
      this.busy.set(false);
      this.announcer.announce(
        $localize`:@@vendor.billing.release.off:This license will renew on its product.`,
      );
    } catch (err) {
      this.busy.set(false);
      const message = licenseActionErrorMessage(err, 'release');
      if (licenseActionIsStale(err)) {
        this.stale.emit(message);
        return;
      }
      this.notice.set(message);
    }
  }

  protected id(key: string): string {
    return `vendor-license-actions-${this.license().id}-${key}`;
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly secondaryClass = `${BUTTON_SECONDARY_CLASS} disabled:cursor-not-allowed disabled:opacity-50`;
  protected readonly triggerClass =
    'inline-flex size-9 shrink-0 items-center justify-center rounded-(--radius-md) text-(--text-secondary) transition-colors hover:bg-(--surface-sunken) hover:text-(--text-primary) aria-expanded:bg-(--surface-sunken) aria-expanded:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly itemClass =
    'block w-full cursor-pointer rounded-(--radius-sm) px-3 py-2 text-start text-sm text-(--text-primary) outline-none hover:bg-(--surface-sunken) focus:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-(--accent-primary)';
  protected readonly optionClass =
    'flex cursor-pointer items-start gap-3 rounded-(--radius-md) border border-(--border-default) p-4 transition-colors hover:bg-(--surface-sunken) has-[:checked]:bg-(--surface-sunken) has-[:checked]:shadow-[inset_0_0_0_2px_var(--accent-primary)]';
}
