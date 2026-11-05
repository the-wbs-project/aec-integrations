import { DatePipe } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import type { VendorSuspension, VendorTerminationPreview } from '@aeci/shared';

import { AdminVendorSuspensionApi } from './admin-vendor-suspension-api';
import {
  SUSPENSION_BUTTON,
  SUSPENSION_CONFIRM_BUTTON,
  SUSPENSION_INPUT,
  formatCents,
  isStaleError,
  manualGrossCents,
  parseDollarsToCents,
  suspensionErrorMessage,
  terminateBlockedReason,
} from './vendor-suspension-model';

/**
 * Terminate, on an open suspension (AECI-1623). Ends every subscription and refunds the
 * unused term less the logged cost.
 *
 * ── THE OPERATOR CONFIRMS NUMBERS, AND THE SERVER CHECKS THEM ──────────────────
 * The request carries the Stripe refund and the cost total this page showed
 * (`expected_gross_cents`, `expected_cost_cents`). If either moved, the API answers
 * `409 VENDOR_TERMINATION_REFUND_CHANGED` and writes nothing. This control then asks the
 * host to reload and says to check the new numbers. Typed amounts survive the reload.
 *
 * ── THE PREVIEW IS LIVE, AND ONLY A PREVIEW ───────────────────────────────────
 * Stripe cannot say what an invoice-paid subscription paid, so each one gets an input. The
 * statement below it moves as they type ({@link manualGrossCents}). The cost applied never
 * exceeds the refund. The server computes the real statement at commit.
 *
 * It confirms inline, as `ReturnRecordsControl` does. No `BrnDialog` opens from an effect.
 */
@Component({
  selector: 'aec-suspension-terminate',
  imports: [DatePipe],
  templateUrl: './suspension-terminate.html',
})
export class SuspensionTerminate {
  private readonly api = inject(AdminVendorSuspensionApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly vendorId = input.required<string>();
  readonly suspension = input.required<VendorSuspension>();
  /** `null` until the state read that follows a write has landed. */
  readonly preview = input.required<VendorTerminationPreview | null>();
  readonly idPrefix = input.required<string>();

  /** The committed suspension. Refunds are still settling: the host re-reads later. */
  readonly terminated = output<VendorSuspension>();
  /** The API answered 409: the page is behind. */
  readonly stale = output<void>();
  /** The operator asked to read Stripe again. */
  readonly refresh = output<void>();
  readonly announce = output<string>();

  protected readonly buttonClass = SUSPENSION_BUTTON;
  protected readonly confirmClass = SUSPENSION_CONFIRM_BUTTON;
  protected readonly inputClass = SUSPENSION_INPUT;
  protected readonly noReference = $localize`:@@admin.vendors.suspension.terminate.noReference:no reference`;

  protected readonly confirming = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');
  protected readonly showAmountErrors = signal(false);
  /** The typed amounts by license id, as typed. */
  private readonly typed = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly blockedReason = computed(() => terminateBlockedReason(this.suspension()));
  protected readonly stripeDown = computed(() => this.preview()?.available === false);
  protected readonly canAct = computed(
    () => this.suspension().can_terminate && this.preview()?.available === true,
  );

  private readonly manualRows = computed(() => this.preview()?.manual_payments ?? []);

  /** Each row's parsed amount: `null` while it is empty or not a dollar amount. */
  private readonly parsed = computed(
    () =>
      new Map(
        this.manualRows().map((row) => [
          row.license_id,
          parseDollarsToCents(this.typed().get(row.license_id) ?? ''),
        ]),
      ),
  );
  protected readonly amountsComplete = computed(() =>
    [...this.parsed().values()].every((cents) => cents !== null),
  );

  protected readonly statement = computed(() => {
    const preview = this.preview();
    if (!preview?.available) return null;
    const suspendedAt = this.suspension().suspended_at;
    const manualGross = this.manualRows().reduce(
      (sum, row) =>
        sum +
        manualGrossCents(
          this.parsed().get(row.license_id) ?? 0,
          row.starts_at,
          row.ends_at,
          suspendedAt,
        ),
      0,
    );
    const gross = preview.gross_cents + manualGross;
    const applied = Math.min(preview.cost_total_cents, gross);
    return {
      stripeGross: preview.gross_cents,
      manualGross,
      costTotal: preview.cost_total_cents,
      applied,
      refund: gross - applied,
    };
  });

  protected money(cents: number): string {
    return formatCents(cents, this.preview()?.currency ?? 'usd');
  }

  protected amountFor(licenseId: string): string {
    return this.typed().get(licenseId) ?? '';
  }

  protected amountInvalid(licenseId: string): boolean {
    return this.showAmountErrors() && this.parsed().get(licenseId) === null;
  }

  protected onAmountInput(licenseId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.typed.update((current) => new Map(current).set(licenseId, value));
  }

  protected open(): void {
    if (!this.canAct()) return;
    if (!this.amountsComplete()) {
      this.showAmountErrors.set(true);
      this.focus('[aria-invalid="true"]');
      return;
    }
    this.failedMessage.set('');
    this.confirming.set(true);
    this.focus('[data-terminate-warning]');
  }

  protected cancel(): void {
    this.confirming.set(false);
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  protected async confirm(): Promise<void> {
    const preview = this.preview();
    if (this.pending() || !preview || !this.canAct() || !this.amountsComplete()) return;
    this.pending.set(true);
    this.failedMessage.set('');
    try {
      const { suspension } = await this.api.terminate(this.vendorId(), {
        manual_payments: this.manualRows().map((row) => ({
          license_id: row.license_id,
          paid_cents: this.parsed().get(row.license_id) ?? 0,
        })),
        expected_gross_cents: preview.gross_cents,
        expected_cost_cents: preview.cost_total_cents,
      });
      this.confirming.set(false);
      this.terminated.emit(suspension);
      this.announce.emit(
        $localize`:@@admin.vendors.suspension.terminate.announce.done:Vendor terminated. Refunds are settling.`,
      );
    } catch (err) {
      this.confirming.set(false);
      this.failedMessage.set(suspensionErrorMessage(err));
      if (isStaleError(err)) this.stale.emit();
    } finally {
      this.pending.set(false);
    }
  }
}
