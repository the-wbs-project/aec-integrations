import {
  ChangeDetectionStrategy,
  Component,
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

import { LICENSE_RELEASE_REASON_MAX, type VendorBillingLicense } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecIcon } from '../../shared/icon/icon';
import {
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { RowActionsMenu, type RowAction } from '../shared/row-actions-menu';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { licenseActionErrorMessage, licenseActionIsStale } from './vendor-license-action-errors';
import { isReplayedEvent } from '../../core/event-replay';

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
 * The portal's shared row Actions menu (`vendor/shared/row-actions-menu.ts`, lifted
 * from here by AECI-2213): a `BrnPopover` of plain buttons, not an Aria or CDK menu,
 * because either breaks the 1.05 MB initial budget (ADR 0010, amendment 2026-10-16).
 *
 * ── THE DIALOG ─────────────────────────────────────────────────────────────
 * `BrnDialog.open()` runs from the menu's `picked` output, inside the item's click,
 * never from an `effect()` (NG0602). The shared menu moves focus to its trigger and
 * closes first, so the dialog hands focus back to the trigger, not to a destroyed item.
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
    AecButton,
    AecIcon,
    RowActionsMenu,
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
  ],
  template: `
    <div class="flex items-center justify-end gap-3">
      <aec-row-actions-menu
        [label]="triggerLabel()"
        [actions]="menuActions()"
        testId="license-actions"
        (picked)="onSelect($event)"
      />
    </div>

    @if (notice(); as message) {
      <p
        role="alert"
        [class]="errorClass + ' mt-2 ms-auto max-w-[22rem] justify-end text-end'"
        data-testid="license-actions-error"
      >
        {{ message }}
      </p>
    }

    <brn-dialog [role]="'alertdialog'" [autoFocus]="'first-heading'" #releaseDialog="brnDialog">
      <ng-template brnDialogContent>
        <div
          class="aec-dialog max-h-[85vh] w-[min(92vw,32rem)] overflow-y-auto p-6 text-start md:p-8"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              tabindex="-1"
              class="rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
              i18n="@@vendor.billing.release.heading"
            >
              Release subscription
            </h2>
            <button
              aecButton
              variant="ghost"
              iconOnly
              brnDialogClose
              type="button"
              [class]="'-me-2 -mt-2'"
              i18n-aria-label="@@vendor.billing.release.close"
              aria-label="Close"
            >
              <aec-icon name="x" decorative />
            </button>
          </div>

          <p
            brnDialogDescription
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            data-testid="license-release-description"
          >
            {{ description() }}
          </p>

          <form method="dialog" class="mt-6 space-y-6" (submit)="submit($event)" novalidate>
            <fieldset class="mx-0 min-w-0 space-y-3 border-0 p-0">
              <legend class="sr-only" i18n="@@vendor.billing.release.when">
                When should the subscription come off?
              </legend>
              @if (canReleaseAtRenewal()) {
                <label [class]="optionClass" data-testid="license-release-option-renewal">
                  <input
                    type="radio"
                    [name]="id('timing')"
                    value="renewal"
                    [checked]="timing() === 'renewal'"
                    (change)="pick('renewal')"
                    [class]="choiceInputClass + ' mt-1'"
                  />
                  <span>
                    <span
                      class="block text-t-14 font-semibold text-(--text-primary)"
                      i18n="@@vendor.billing.release.renewal"
                      >At renewal</span
                    >
                    <span
                      class="mt-1 block text-t-14 leading-[1.6] font-normal text-(--text-secondary)"
                      i18n="@@vendor.billing.release.renewalHelp"
                      >The subscription stays on the product until the term renews, then comes off.
                      You can undo this until then.</span
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
                    [class]="choiceInputClass + ' mt-1'"
                  />
                  <span>
                    <span
                      class="block text-t-14 font-semibold text-(--text-primary)"
                      i18n="@@vendor.billing.release.now"
                      >Now</span
                    >
                    <span
                      class="mt-1 block text-t-14 leading-[1.6] font-normal text-(--text-secondary)"
                      i18n="@@vendor.billing.release.nowHelp"
                      >AEC Integrations reviews the request. If it is approved, the subscription
                      comes off now.</span
                    >
                  </span>
                </label>
              }
            </fieldset>

            @if (timing() === 'now') {
              <div class="space-y-2">
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
                  Tell us why the subscription should come off now. Up to 1,000 characters.
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

            <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                aecButton
                variant="secondary"
                brnDialogClose
                type="button"
                [disabled]="busy()"
                i18n="@@vendor.billing.release.cancel"
              >
                Cancel
              </button>
              <button
                aecButton
                type="submit"
                [disabled]="busy()"
                [attr.aria-busy]="busy() ? 'true' : null"
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
  private readonly menu = viewChild(RowActionsMenu);

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
    return $localize`:@@vendor.billing.actions.label:Actions for the ${name}:PRODUCT: subscription`;
  });

  protected readonly description = computed(() => {
    const name = this.productName();
    return $localize`:@@vendor.billing.release.description:The subscription comes off ${name}:PRODUCT: and goes back to your pool, and the product goes back to Free.`;
  });

  /** Called by the Billing section after an assign puts this license on a product,
   *  so focus lands here instead of on `<body>` (AECI-1391). */
  focus(): void {
    this.menu()?.focus();
  }

  /** The menu's items: what is already in effect is left out. */
  protected readonly menuActions = computed<readonly RowAction[]>(() => [
    ...(this.canRelease()
      ? [
          {
            id: 'release',
            label: $localize`:@@vendor.billing.actions.release:Release subscription`,
          },
        ]
      : []),
    ...(this.license().release_at_renewal
      ? [{ id: 'keep', label: $localize`:@@vendor.billing.actions.keep:Keep at renewal` }]
      : []),
  ]);

  /** A menu item's click (the shared menu has already focused its trigger and closed):
   *  an event, so opening the dialog here is safe. */
  protected onSelect(picked: string): void {
    const action = picked as MenuAction;
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
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.busy()) return;
    if (this.timing() === 'now') await this.requestNow();
    else await this.releaseAtRenewal();
  }

  private async releaseAtRenewal(): Promise<void> {
    await this.write(
      () => this.api.setReleaseAtRenewal(this.license().id, true),
      'release',
      $localize`:@@vendor.billing.release.on:This subscription will come off its product at renewal.`,
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
        $localize`:@@vendor.billing.release.off:This subscription will renew on its product.`,
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
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  /** A timing option: the shared choice card's look, taller for its help line. */
  protected readonly optionClass =
    'aec-choice-card flex cursor-pointer items-start gap-3 rounded-control border bg-(--surface-base) p-4 text-(--text-primary) has-[:checked]:bg-(--accent-primary-soft)';
}
