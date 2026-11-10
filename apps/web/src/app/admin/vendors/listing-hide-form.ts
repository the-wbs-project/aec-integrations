import { DOCUMENT, DatePipe } from '@angular/common';
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

import {
  ADMIN_REASON_MAX,
  HTTPS_URL_MAX_LENGTH,
  LISTING_HIDE_KINDS,
  isHttpsUrl,
  type AdminListingHideResponse,
  type ListingHideEntityType,
  type ListingHideKind,
} from '@aeci/shared';

import { listingHideKindLabel } from '../../shared/listing-hide/listing-hide-kind-label';
import { AdminVendorsApi } from './admin-vendors-api';
import {
  SUSPENSION_BUTTON,
  SUSPENSION_CONFIRM_BUTTON,
  SUSPENSION_INPUT,
} from './vendor-suspension-model';

export type ListingHideMode = 'hide' | 'restore';

type Step = 'edit' | 'confirm';

/** The 409s that mean the listing moved under the operator. The host reloads. */
const STALE_CODES = new Set([
  'LISTING_HIDDEN',
  'LISTING_NOT_HIDDEN',
  'LISTING_HIDDEN_WITH_VENDOR',
  'LISTING_CHANGED_WHILE_SAVING',
]);

/**
 * The inline hide or restore form for one listing (AECI-1238,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6, `ADMIN_PANEL_SPEC.md` §5.7). The
 * "Listing visibility" section on the Vendor tab uses it for the company, and the
 * Products tab uses it for one product.
 *
 * Two steps, no browser dialog, the way the integration retire on the same page
 * works. Step 1 takes the fields: for a hide, the kind, the date AECi received the
 * request, the source link (required for a complaint), the reason shown to the
 * vendor and an optional internal note; for a restore, the reason and the note.
 * Step 2 repeats what will be sent, shows the host's projected impact block (the
 * products a company hide also takes down), and only its button sends the request.
 *
 * The form owns the write and its error line. The host owns the live region and
 * the reload: a commit leaves through {@link done}, and a refusal that means the
 * listing changed under the operator leaves through {@link stale}.
 */
@Component({
  selector: 'aec-listing-hide-form',
  imports: [DatePipe],
  templateUrl: './listing-hide-form.html',
})
export class ListingHideForm {
  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  readonly entityType = input.required<ListingHideEntityType>();
  readonly entityId = input.required<string>();
  readonly mode = input.required<ListingHideMode>();
  /** The company or product name, for the confirm step's heading. */
  readonly recordName = input.required<string>();
  readonly idPrefix = input.required<string>();

  /** The write committed. */
  readonly done = output<AdminListingHideResponse>();
  /** The operator closed the form without sending. */
  readonly cancelled = output<void>();
  /** A 409 that means the state moved: the message for the host's live region. */
  readonly stale = output<string>();

  protected readonly kinds = LISTING_HIDE_KINDS;
  protected readonly kindLabel = listingHideKindLabel;
  protected readonly reasonMax = ADMIN_REASON_MAX;
  protected readonly urlMax = HTTPS_URL_MAX_LENGTH;
  protected readonly buttonClass = SUSPENSION_BUTTON;
  protected readonly confirmClass = SUSPENSION_CONFIRM_BUTTON;
  protected readonly inputClass = SUSPENSION_INPUT;

  protected readonly step = signal<Step>('edit');
  protected readonly kind = signal<ListingHideKind | null>(null);
  protected readonly receivedAt = signal(todayLocal());
  protected readonly sourceUrl = signal('');
  protected readonly reason = signal('');
  /** AECi's own note. Never shown to a vendor (§11d.2). */
  protected readonly internalNote = signal('');
  protected readonly showErrors = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  /** The latest date the picker offers: today, in the operator's own time zone. */
  protected readonly today = todayLocal();

  protected readonly kindError = computed(() =>
    this.mode() === 'hide' && this.kind() === null
      ? $localize`:@@admin.listingHide.error.kind:Choose why the listing is hidden.`
      : null,
  );
  protected readonly receivedError = computed(() => {
    if (this.mode() !== 'hide') return null;
    const value = this.receivedAt().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      return $localize`:@@admin.listingHide.error.received:Enter the date AEC Integrations received the request.`;
    }
    if (value > this.today) {
      return $localize`:@@admin.listingHide.error.receivedFuture:The date received cannot be in the future.`;
    }
    return null;
  });
  protected readonly sourceError = computed(() => {
    if (this.mode() !== 'hide') return null;
    const value = this.sourceUrl().trim();
    if (!value) {
      return this.kind() === 'complaint_under_review'
        ? $localize`:@@admin.listingHide.error.sourceRequired:A complaint under review needs the link to the public source.`
        : null;
    }
    return isHttpsUrl(value)
      ? null
      : $localize`:@@admin.listingHide.error.sourceHttps:Use an https:// link.`;
  });
  protected readonly reasonError = computed(() =>
    this.reason().trim()
      ? null
      : $localize`:@@admin.listingHide.error.reason:Enter a reason for the vendor. It reads it in its portal messages.`,
  );
  private readonly firstError = computed<string | null>(() => {
    if (this.kindError()) return 'kind-' + this.kinds[0];
    if (this.receivedError()) return 'received';
    if (this.sourceError()) return 'source';
    if (this.reasonError()) return 'reason';
    return null;
  });

  private readonly confirmHeading = viewChild<ElementRef<HTMLElement>>('confirmHeading');

  constructor() {
    afterNextRender(() => this.focusFirstField());
  }

  protected fieldId(key: string): string {
    return `${this.idPrefix()}-listing-${key}`;
  }

  /** `aria-describedby` for a field: its hint, then its error once errors show. */
  protected describedBy(key: string, error: string | null, hint = false): string | null {
    const ids = [
      hint ? this.fieldId(`${key}-hint`) : null,
      this.showErrors() && error ? this.fieldId(`${key}-error`) : null,
    ].filter((id): id is string => id !== null);
    return ids.length ? ids.join(' ') : null;
  }

  protected onInput(
    field: 'receivedAt' | 'sourceUrl' | 'reason' | 'internalNote',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this[field].set(value);
  }

  protected continue(): void {
    this.showErrors.set(true);
    const first = this.firstError();
    if (first) {
      this.document.getElementById(this.fieldId(first))?.focus();
      return;
    }
    this.failedMessage.set('');
    this.step.set('confirm');
    afterNextRender(() => this.confirmHeading()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected back(): void {
    this.step.set('edit');
    this.failedMessage.set('');
    afterNextRender(() => this.focusFirstField(), { injector: this.injector });
  }

  protected cancel(): void {
    this.cancelled.emit();
  }

  protected async confirm(): Promise<void> {
    if (this.pending()) return;
    this.pending.set(true);
    this.failedMessage.set('');
    try {
      const result = await this.send();
      this.done.emit(result);
    } catch (err) {
      const message = listingHideErrorMessage(err);
      this.failedMessage.set(message);
      if (STALE_CODES.has(errorCode(err) ?? '')) this.stale.emit(message);
    } finally {
      this.pending.set(false);
    }
  }

  private send(): Promise<AdminListingHideResponse> {
    const id = this.entityId();
    const reason = this.reason().trim();
    const note = this.internalNote();
    const vendor = this.entityType() === 'vendor';
    if (this.mode() === 'restore') {
      return vendor
        ? this.api.restoreVendor(id, reason, note)
        : this.api.restoreProduct(id, reason, note);
    }
    const body = {
      kind: this.kind()!,
      reason,
      internalNote: note,
      receivedAt: this.receivedAt().trim(),
      sourceUrl: this.sourceUrl().trim() || null,
    };
    return vendor ? this.api.hideVendor(id, body) : this.api.hideProduct(id, body);
  }

  private focusFirstField(): void {
    const key = this.mode() === 'hide' ? 'kind-' + this.kinds[0] : 'reason';
    this.document.getElementById(this.fieldId(key))?.focus();
  }
}

/** Today as `YYYY-MM-DD` in the browser's own time zone, what a date input shows. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The `code` from the API's `{ error: { code } }` envelope, read structurally
 *  (see `http-status.ts` for why not `instanceof`). */
function errorCode(err: unknown): string | null {
  const inner = (err as { error?: { error?: { code?: unknown } } } | null)?.error?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}

/** One sentence per refusal the four listing routes can answer. */
export function listingHideErrorMessage(err: unknown): string {
  switch (errorCode(err)) {
    case 'LISTING_HIDDEN':
      return $localize`:@@admin.listingHide.error.hidden:This listing is already hidden. The page has been reloaded.`;
    case 'LISTING_NOT_HIDDEN':
      return $localize`:@@admin.listingHide.error.notHidden:This listing is already on the public site. The page has been reloaded.`;
    case 'LISTING_HIDDEN_WITH_VENDOR':
      return $localize`:@@admin.listingHide.error.withVendor:This product is hidden with its company. Restore the company's listing instead. The page has been reloaded.`;
    case 'LISTING_CHANGED_WHILE_SAVING':
      return $localize`:@@admin.listingHide.error.changed:This listing changed while you were saving. Nothing was saved. The page has been reloaded.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@admin.listingHide.error.validation:Check the fields. The reason needs 1 to 1,000 characters, a complaint needs an https:// source link, and the date received cannot be in the future.`;
    case 'RATE_LIMITED':
      return $localize`:@@admin.listingHide.error.rate:Too many requests in a short time. Wait a minute and try again.`;
  }
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 403) {
    return $localize`:@@admin.listingHide.error.forbidden:You do not have permission to change this listing.`;
  }
  if (status === 404) {
    return $localize`:@@admin.listingHide.error.notFound:We could not find this listing. Reload the page.`;
  }
  return $localize`:@@admin.listingHide.error.generic:Could not save the change. Nothing was saved. Try again.`;
}
