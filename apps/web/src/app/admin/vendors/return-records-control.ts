import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import type { AdminReturnRecordsResponse } from '@aeci/shared';

import { CONSOLE_CAPTION_CLASS } from '../console/console-table';
import { AdminDangerAction } from '../console/danger-action';
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
 * It confirms inline on the console's danger form (`AdminDangerAction`, AECI-2124),
 * rather than in a dialog: the reason field is the confirmation, and no `BrnDialog`
 * opens from an effect. The confirm is danger: the return deletes the vendor's open
 * product proposals, and no action brings them back. While seats remain the opener is
 * blocked (`aria-disabled`, still focusable) and described by the sentence that says
 * why. No heading and no live region: `VendorDetail` owns both, and announcements
 * leave through {@link announce}.
 *
 * ── FOCUS (AECI-1994) ───────────────────────────────────────────────────────
 * The danger form owns it: opening focuses the reason, Cancel and Escape return focus
 * to "Return records to AECi", and a refusal focuses its message. Escape does nothing
 * while the request runs.
 */
@Component({
  selector: 'aec-return-records-control',
  imports: [AdminDangerAction, DatePipe],
  templateUrl: './return-records-control.html',
})
export class ReturnRecordsControl {
  private readonly api = inject(AdminVendorsApi);

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

  /** The danger form is open. */
  protected readonly confirming = signal(false);
  /** The internal note as typed, two-way with the danger form. Sent as typed. */
  protected readonly internalNote = signal('');
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal<string | null>(null);
  protected readonly reasonMaxLength = REASON_MAX_LENGTH;
  protected readonly bodyClass = 'max-w-prose text-t-14 text-(--text-primary)';
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;

  // The danger form's words: the messages this control has always carried.
  protected readonly openerLabel = $localize`:@@admin.vendors.returnRecords.action.open:Return records to AECi`;
  protected readonly confirmLabel = $localize`:@@admin.vendors.returnRecords.action.confirm:Return the records`;
  protected readonly busyLabel = $localize`:@@admin.vendors.returnRecords.action.pending:Returning…`;
  protected readonly cancelLabel = $localize`:@@admin.vendors.returnRecords.action.cancel:Cancel`;
  protected readonly warning = $localize`:@@admin.vendors.returnRecords.warning:Use this only when the claim was approved by mistake. AECi takes back the vendor, its products and the integrations it claimed, and promote writes them again. Claims, attestations and subscriptions are kept. A new claim approval is the only way the vendor owns them again.`;
  protected readonly reasonLabel = $localize`:@@admin.vendors.returnRecords.field.reason:Reason (required)`;
  protected readonly reasonHelp = $localize`:@@admin.vendors.returnRecords.field.reasonHint:Recorded in the audit trail. Up to ${REASON_MAX_LENGTH}:INTERPOLATION: characters.`;
  protected readonly reasonRequired = $localize`:@@admin.vendors.returnRecords.field.reasonError:Write a reason before returning the records.`;
  protected readonly noteLabel = $localize`:@@admin.vendors.returnRecords.field.note:Internal note (optional)`;

  protected readonly owned = computed(() => this.ownedAt() !== null);
  protected readonly blockedBySeats = computed(() => this.hasSeats() === true);

  constructor() {
    // A page reused for another vendor starts this control clean: the form closed, no
    // refusal, no note. The keyed `@for` in the template drops the danger form's draft.
    let last: string | null = null;
    effect(() => {
      const id = this.vendorId();
      untracked(() => {
        if (last !== null && last !== id) {
          this.confirming.set(false);
          this.failedMessage.set(null);
          this.internalNote.set('');
        }
        last = id;
      });
    });
  }

  /**
   * The danger form opened or closed (the opener, Cancel, Escape). A refusal belongs to
   * the attempt that earned it, so every open and every close clears it: a reopened form
   * never shows an old refusal (the danger form's parent contract).
   */
  protected onOpenChange(open: boolean): void {
    this.failedMessage.set(null);
    this.confirming.set(open);
  }

  /** The danger form's confirm: a non-empty, trimmed reason. */
  protected async confirm(reason: string): Promise<void> {
    if (this.pending()) return;
    this.failedMessage.set(null);
    this.pending.set(true);
    try {
      const result = await this.api.returnRecords(this.vendorId(), reason, this.internalNote());
      this.pending.set(false);
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
