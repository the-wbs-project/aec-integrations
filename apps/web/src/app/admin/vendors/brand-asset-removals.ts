import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { ADMIN_REASON_MAX, type BrandAssetRemoval } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';

type HoldAction = 'hold' | 'lift';

/**
 * "Pending brand-asset removals" on `/admin/vendors` (AECI-1618, `ADMIN_PANEL_SPEC.md`
 * §5.7, `STAGE_2_5_SPEC.md` §11). It lists each company whose claim ended and whose
 * vendor-set logos the daily job has not yet removed.
 *
 * A hold delays a removal, and never past `limit_at`. Both dates come from the API, so
 * this screen computes nothing. Hold and lift confirm inline, the way "Return records"
 * does on the vendor page: the reason field is the confirmation.
 *
 * It sits above the vendor table because that table scroll-pages, so anything under it
 * is out of reach. The API returns the whole pending set, so the section has no paging.
 * The set empties at each daily run unless a hold keeps a company on it.
 */
@Component({
  selector: 'aec-brand-asset-removals',
  imports: [DatePipe, RouterLink],
  templateUrl: './brand-asset-removals.html',
})
export class BrandAssetRemovals {
  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);

  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly rows = signal<readonly BrandAssetRemoval[]>([]);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** The one row with its reason form open. */
  protected readonly acting = signal<{ vendorId: string; action: HoldAction } | null>(null);
  protected readonly reason = signal('');
  protected readonly internalNote = signal('');
  protected readonly reasonError = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');
  protected readonly reasonMax = ADMIN_REASON_MAX;
  protected readonly dateFormat = "MMM d, y, HH:mm 'UTC'";

  private readonly reasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const response = await this.api.listBrandAssetRemovals();
      this.rows.set(response.data);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected causeLabel(cause: string | null): string {
    switch (cause) {
      case null:
        return $localize`:@@admin.brandAssets.cause.none:Not recorded`;
      case 'last-seat-revoked':
        return $localize`:@@admin.brandAssets.cause.seatRevoked:Last seat revoked`;
      case 'last-seat-account-erased':
        return $localize`:@@admin.brandAssets.cause.accountErased:Last seat's account erased`;
      case 'banned-seat-granted':
        return $localize`:@@admin.brandAssets.cause.bannedSeat:Seat granted to a banned account`;
      case 'records-returned-to-aeci':
        return $localize`:@@admin.brandAssets.cause.returned:Records returned to AECi`;
      case 'vendor-terminated':
        return $localize`:@@admin.brandAssets.cause.terminated:Vendor terminated`;
      default:
        return cause;
    }
  }

  /** The buttons repeat per row, so each names its company for a screen reader. */
  protected holdLabel(company: string): string {
    return $localize`:@@admin.brandAssets.action.holdLabel:Hold the removal for ${company}:COMPANY:`;
  }

  protected liftLabel(company: string): string {
    return $localize`:@@admin.brandAssets.action.liftLabel:Lift the hold for ${company}:COMPANY:`;
  }

  protected open(vendorId: string, action: HoldAction): void {
    this.acting.set({ vendorId, action });
    this.reason.set('');
    this.internalNote.set('');
    this.reasonError.set(false);
    this.failedMessage.set('');
    afterNextRender(() => this.reasonInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancel(): void {
    this.acting.set(null);
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError()) this.reasonError.set(false);
  }

  protected onNoteInput(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirm(): Promise<void> {
    const acting = this.acting();
    if (!acting || this.pending()) return;
    const reason = this.reason().trim();
    if (!reason) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.failedMessage.set('');
    try {
      if (acting.action === 'hold') {
        await this.api.holdBrandAssets(acting.vendorId, reason, this.internalNote());
        this.announce.emit($localize`:@@admin.brandAssets.announce.held:Removal held.`);
      } else {
        await this.api.liftBrandAssetHold(acting.vendorId, reason, this.internalNote());
        this.announce.emit($localize`:@@admin.brandAssets.announce.lifted:Hold lifted.`);
      }
      this.acting.set(null);
      await this.load();
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }
}

function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = (err.error as { error?: { code?: unknown } } | null)?.error?.code;
    if (code === 'BRAND_ASSETS_NOT_PENDING') {
      return $localize`:@@admin.brandAssets.error.notPending:This company has no removal pending, or it is already held. Reload the page. Nothing was changed.`;
    }
    if (code === 'BRAND_ASSETS_NOT_HELD') {
      return $localize`:@@admin.brandAssets.error.notHeld:This company has no hold to lift. Reload the page. Nothing was changed.`;
    }
    if (err.status === 400) {
      return $localize`:@@admin.brandAssets.error.invalid:Write a reason of up to ${ADMIN_REASON_MAX}:MAX: characters, then try again.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.brandAssets.error.forbidden:You do not have permission to change this hold.`;
    }
  }
  return $localize`:@@admin.brandAssets.error.failed:Something went wrong. Please try again.`;
}
