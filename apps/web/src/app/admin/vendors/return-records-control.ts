import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
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
  viewChild,
} from '@angular/core';

import type { AdminReturnRecordsResponse } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';

/** `AdminReasonSchema`'s cap, mirrored so the field stops an over-long reason. */
const REASON_MAX_LENGTH = 1000;

/**
 * "Return records to AECi" (AECI-1415, ADR 0042, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 * Ownership flips to the vendor at claim approval, and seat loss never moves it
 * back. This control is the ONE way back, for a mistaken approval and nothing else.
 * The API (`POST /api/admin/vendors/:id/return-to-aeci`) refuses while the vendor
 * holds any seat, banned or not. The control shows that rule and disables the
 * button while seats remain, so an operator revokes them first.
 *
 * It confirms inline, the way the seat revoke on the same page does, rather than in
 * a dialog: the reason field is the confirmation, and no `BrnDialog` opens from an
 * effect. No heading and no live region: `VendorDetail` owns both, and
 * announcements leave through {@link announce}.
 */
@Component({
  selector: 'aec-return-records-control',
  imports: [DatePipe],
  templateUrl: './return-records-control.html',
})
export class ReturnRecordsControl {
  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);

  readonly vendorId = input.required<string>();
  /** `vendors.owned_at`: when the vendor's records became its own, or `null`. */
  readonly ownedAt = input.required<string | null>();
  /** Whether the vendor still holds any seat, banned ones included. `null` when the
   *  roster could not be read: the button stays enabled and the API decides. */
  readonly hasSeats = input.required<boolean | null>();
  readonly idPrefix = input.required<string>();
  /** `open_proposal_count` from the vendor read (AECI-1416): the open product
   *  proposals the return deletes. The confirm step names the number when it is not 0. */
  readonly openProposalCount = input<number>(0);

  /** The committed result. The host reloads the page and the audit trail on it. */
  readonly returned = output<AdminReturnRecordsResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly confirming = signal(false);
  protected readonly reason = signal('');
  protected readonly internalNote = signal('');
  protected readonly reasonError = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');
  protected readonly reasonMaxLength = REASON_MAX_LENGTH;

  protected readonly owned = computed(() => this.ownedAt() !== null);
  protected readonly blockedBySeats = computed(() => this.hasSeats() === true);

  private readonly reasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');

  protected open(): void {
    this.failedMessage.set('');
    this.reason.set('');
    this.internalNote.set('');
    this.reasonError.set(false);
    this.confirming.set(true);
    afterNextRender(() => this.reasonInput()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected cancel(): void {
    this.confirming.set(false);
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError()) this.reasonError.set(false);
  }

  protected onNoteInput(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirm(): Promise<void> {
    if (this.pending()) return;
    const reason = this.reason().trim();
    if (!reason) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.failedMessage.set('');
    try {
      const result = await this.api.returnRecords(this.vendorId(), reason, this.internalNote());
      this.confirming.set(false);
      this.returned.emit(result);
      this.announce.emit(
        $localize`:@@admin.vendors.returnRecords.announce.done:Records returned to AECi. Promote writes them again.`,
      );
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }
}

function errorCode(err: HttpErrorResponse): string | null {
  const body = err.error as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === 'string' ? body.error.code : null;
}

/** One sentence per outcome the operator can act on. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = errorCode(err);
    if (code === 'VENDOR_HAS_SEATS') {
      return $localize`:@@admin.vendors.returnRecords.error.seats:This vendor still has a seat. Revoke every seat, banned ones included, then try again. Nothing was changed.`;
    }
    if (code === 'VENDOR_NOT_OWNED') {
      return $localize`:@@admin.vendors.returnRecords.error.notOwned:These records are already AECi's. Reload the page. Nothing was changed.`;
    }
    if (code === 'VENDOR_PROPOSALS_CHANGED') {
      return $localize`:@@admin.vendors.returnRecords.error.proposalsChanged:A new product proposal for this vendor arrived while the request ran, so nothing was saved. Reload and try again.`;
    }
    if (code === 'VENDOR_SEATS_CHANGED') {
      return $localize`:@@admin.vendors.returnRecords.error.changed:This vendor's seats changed while the request ran, so nothing was saved. Reload and try again.`;
    }
    if (err.status === 400) {
      return $localize`:@@admin.vendors.returnRecords.error.invalid:Write a reason of up to ${REASON_MAX_LENGTH}:MAX: characters, then try again.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.returnRecords.error.forbidden:You do not have permission to return this vendor's records.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.vendors.returnRecords.error.vendor:We could not find this vendor. Reload the page.`;
    }
  }
  return $localize`:@@admin.vendors.returnRecords.error.failed:Something went wrong. Please try again.`;
}
