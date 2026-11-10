import { DatePipe, DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
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
  AdminReasonSchema,
  HttpsUrlSchema,
  ListingHideReceivedAtSchema,
  fieldHideFieldsFor,
  isHttpsUrl,
  type AdminFieldHide,
} from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { fieldOverrideLabel } from '../../vendor/components/field-override-labels';
import {
  errorBody,
  loadCorrectableRecords,
  type CorrectableRecord,
} from './admin-field-corrections';
import { AdminVendorsApi } from './admin-vendors-api';
import { todayLocal } from './listing-hide-form';

/** Which inline action is open on one hide. */
type HideAction = { readonly id: string; readonly kind: 'restore' | 'reply' };

/**
 * "Values under review" on `/admin/vendors/:id` (AECI-1238, `ADMIN_PANEL_SPEC.md` §5.7,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.7).
 *
 * AECi received a public source saying one value on a vendor-held record is wrong. Policy:
 * hide it within two business days of receiving the request while AECi checks, and decide
 * within five. The public page shows "Under review" in the value's slot. Hiding is not a
 * finding that the value is false.
 *
 * Two parts, beside Field corrections and on its record picker:
 *
 *   - **The list.** Every active hide on the vendor's records, with the received date, the
 *     hide-by and decide-by dates (server-computed business days), the last status reply,
 *     and an overdue marker once decide-by has passed with no status reply. Restore (the
 *     value stands) and "Record status reply" (audit only) each open an inline form.
 *   - **"Hide a value".** Record, field, source link, received date, the reason shown to
 *     the vendor and an internal note, then an explicit confirm step that says what the
 *     public page will show. No browser dialog.
 *
 * Correcting the value instead is Field corrections: a correction on a hidden field ends
 * the hide in the same write. So does the vendor's own edit of the field.
 */
@Component({
  selector: 'aec-admin-field-hides',
  imports: [DatePipe, NewTabIcon],
  templateUrl: './admin-field-hides.html',
})
export class AdminFieldHides {
  readonly vendorId = input.required<string>();
  readonly vendorName = input.required<string>();
  readonly announce = output<string>();

  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  protected readonly hides = signal<readonly AdminFieldHide[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  /** The instant the list was read, for the overdue marker. Set on each load. */
  protected readonly readAt = signal(0);

  protected readonly records = signal<readonly CorrectableRecord[]>([]);
  protected readonly formOpen = signal(false);
  /** The second step: the admin reviews what will happen, then confirms. */
  protected readonly confirming = signal(false);
  protected readonly recordKey = signal('');
  protected readonly field = signal('');
  protected readonly sourceUrl = signal('');
  protected readonly receivedAt = signal('');
  protected readonly reason = signal('');
  protected readonly internalNote = signal('');
  protected readonly pending = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly sourceError = signal(false);
  protected readonly receivedError = signal(false);
  /** The latest received date the picker offers: today in the operator's own time
   *  zone, as `listing-hide-form.ts` uses. A UTC date would be tomorrow on a US
   *  evening. Re-read each time the form opens. */
  protected readonly today = signal(todayLocal());
  protected readonly reasonError = signal(false);

  protected readonly action = signal<HideAction | null>(null);
  protected readonly actionText = signal('');
  protected readonly actionError = signal<string | null>(null);

  protected readonly reasonMax = ADMIN_REASON_MAX;

  private readonly recordEl = viewChild<ElementRef<HTMLSelectElement>>('recordInput');
  private readonly sourceEl = viewChild<ElementRef<HTMLInputElement>>('sourceInput');
  private readonly receivedEl = viewChild<ElementRef<HTMLInputElement>>('receivedInput');
  private readonly reasonEl = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
  private readonly confirmEl = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly actionEl = viewChild<ElementRef<HTMLTextAreaElement>>('actionInput');

  protected readonly record = computed(
    () => this.records().find((r) => r.key === this.recordKey()) ?? null,
  );

  protected readonly fields = computed<readonly string[]>(() => {
    const record = this.record();
    return record ? fieldHideFieldsFor(record.entityType) : [];
  });

  constructor() {
    afterNextRender(() => void this.loadHides());
  }

  protected async loadHides(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await this.api.listFieldHides(this.vendorId());
      this.hides.set(res.hides);
      this.readAt.set(Date.now());
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Past decide-by with no status reply recorded: the five-day promise is broken. */
  protected overdue(hide: AdminFieldHide): boolean {
    const due = Date.parse(hide.decide_due);
    return !hide.last_status_reply && !Number.isNaN(due) && due < this.readAt();
  }

  protected async openForm(): Promise<void> {
    this.formOpen.set(true);
    this.confirming.set(false);
    this.formError.set(null);
    this.today.set(todayLocal());
    this.receivedAt.set(this.today());
    if (this.records().length === 0) {
      const loaded = await loadCorrectableRecords(this.api, this.vendorId(), this.vendorName());
      this.records.set(loaded.records);
      if (loaded.failed) {
        this.formError.set(
          $localize`:@@admin.fieldHides.error.records:Could not load this vendor's products and integrations. Only the company's values can be hidden for now.`,
        );
      }
    }
    afterNextRender(() => this.recordEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.resetForm();
    afterNextRender(() => this.document.getElementById(this.id('open'))?.focus(), {
      injector: this.injector,
    });
  }

  private resetForm(): void {
    this.confirming.set(false);
    this.recordKey.set('');
    this.field.set('');
    this.sourceUrl.set('');
    this.receivedAt.set('');
    this.reason.set('');
    this.internalNote.set('');
    this.formError.set(null);
    this.sourceError.set(false);
    this.receivedError.set(false);
    this.reasonError.set(false);
  }

  protected onRecord(event: Event): void {
    this.recordKey.set((event.target as HTMLSelectElement).value);
    this.field.set('');
  }

  protected onField(event: Event): void {
    this.field.set((event.target as HTMLSelectElement).value);
  }

  protected onSource(event: Event): void {
    this.sourceUrl.set((event.target as HTMLInputElement).value);
    if (this.sourceError()) this.sourceError.set(false);
  }

  protected onReceived(event: Event): void {
    this.receivedAt.set((event.target as HTMLInputElement).value);
    if (this.receivedError()) this.receivedError.set(false);
  }

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError()) this.reasonError.set(false);
  }

  protected onNote(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  /** Step one: check every input, then show the confirm step. */
  protected review(): void {
    if (this.pending()) return;
    if (!this.record() || !this.field()) {
      this.formError.set(
        $localize`:@@admin.fieldHides.error.pick:Choose the record and the field to hide.`,
      );
      return;
    }
    if (!HttpsUrlSchema.safeParse(this.sourceUrl()).success) {
      this.sourceError.set(true);
      this.sourceEl()?.nativeElement.focus();
      return;
    }
    if (
      !ListingHideReceivedAtSchema.safeParse(this.receivedAt()).success ||
      this.receivedAt().trim() > this.today()
    ) {
      this.receivedError.set(true);
      this.receivedEl()?.nativeElement.focus();
      return;
    }
    if (!AdminReasonSchema.safeParse(this.reason()).success) {
      this.reasonError.set(true);
      this.reasonEl()?.nativeElement.focus();
      return;
    }
    this.formError.set(null);
    this.confirming.set(true);
    afterNextRender(() => this.confirmEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected back(): void {
    this.confirming.set(false);
    afterNextRender(() => this.recordEl()?.nativeElement.focus(), { injector: this.injector });
  }

  /** Step two: hide the value. */
  protected async submit(): Promise<void> {
    const record = this.record();
    if (this.pending() || !record || !this.field()) return;
    this.pending.set(true);
    this.formError.set(null);
    try {
      const res = await this.api.setFieldHide({
        entityType: record.entityType,
        entityId: record.id,
        field: this.field(),
        sourceUrl: this.sourceUrl().trim(),
        receivedAt: this.receivedAt().trim(),
        reason: this.reason().trim(),
        internalNote: this.internalNote(),
      });
      this.hides.update((list) => [res.hide, ...list]);
      this.readAt.set(Date.now());
      this.formOpen.set(false);
      this.resetForm();
      this.announce.emit(
        $localize`:@@admin.fieldHides.announce.hidden:Value hidden. The public page shows it as under review, and the vendor was told, with your reason.`,
      );
      afterNextRender(() => this.document.getElementById(this.id('open'))?.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.confirming.set(false);
      this.formError.set(fieldHideErrorMessage(err));
    } finally {
      this.pending.set(false);
    }
  }

  protected openAction(hide: AdminFieldHide, kind: HideAction['kind']): void {
    this.action.set({ id: hide.id, kind });
    this.actionText.set('');
    this.actionError.set(null);
    afterNextRender(() => this.actionEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeAction(hide: AdminFieldHide): void {
    const kind = this.action()?.kind ?? 'restore';
    this.action.set(null);
    this.actionError.set(null);
    afterNextRender(() => this.document.getElementById(this.triggerId(hide, kind))?.focus(), {
      injector: this.injector,
    });
  }

  protected onActionText(event: Event): void {
    this.actionText.set((event.target as HTMLTextAreaElement).value);
  }

  protected async runAction(hide: AdminFieldHide): Promise<void> {
    const action = this.action();
    if (this.pending() || !action) return;
    if (!AdminReasonSchema.safeParse(this.actionText()).success) {
      this.actionError.set(
        action.kind === 'restore'
          ? $localize`:@@admin.fieldHides.restore.reasonRequired:Enter a reason for the vendor. The vendor reads it in its portal messages.`
          : $localize`:@@admin.fieldHides.reply.noteRequired:Enter what you told the requester.`,
      );
      this.actionEl()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.actionError.set(null);
    try {
      const text = this.actionText().trim();
      if (action.kind === 'restore') {
        await this.api.restoreFieldHide(hide.id, text);
        this.hides.update((list) => list.filter((h) => h.id !== hide.id));
        this.announce.emit(
          $localize`:@@admin.fieldHides.announce.restored:Value restored. It is back on the public page, and the vendor was told why.`,
        );
      } else {
        const res = await this.api.recordFieldHideStatusReply(hide.id, text);
        this.hides.update((list) => list.map((h) => (h.id === hide.id ? res.hide : h)));
        this.announce.emit(
          $localize`:@@admin.fieldHides.announce.reply:Status reply recorded in the audit trail.`,
        );
      }
      this.action.set(null);
      afterNextRender(() => this.document.getElementById(this.id('heading'))?.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.actionError.set(fieldHideErrorMessage(err));
      if (errorBody(err).code === 'FIELD_HIDE_CLEARED') void this.loadHides();
    } finally {
      this.pending.set(false);
    }
  }

  /**
   * The last business day of a window, as a date. The server's due instant is the moment
   * the window has fully passed: midnight in New York after that day (`businessWindowEnd`),
   * so the day shown is the New York date of the instant just before it.
   */
  protected dueDay(iso: string): string {
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return iso;
    return new Intl.DateTimeFormat(this.locale, {
      dateStyle: 'medium',
      timeZone: 'America/New_York',
    }).format(new Date(at - 1));
  }

  /**
   * The received date as typed. An ISO date (`2026-11-02`) is a calendar day, so it is
   * read and shown in UTC. The date pipe would read it as local midnight and shift it a
   * day west of UTC.
   */
  protected receivedDay(value: string): string {
    const at = Date.parse(value);
    if (Number.isNaN(at)) return value;
    return new Intl.DateTimeFormat(this.locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date(at),
    );
  }

  /** https only: a stored value that is anything else renders no link. */
  protected sourceHref(hide: AdminFieldHide): string | null {
    return isHttpsUrl(hide.source_url) ? hide.source_url : null;
  }

  protected fieldLabel(field: string): string {
    return fieldOverrideLabel(field);
  }

  protected entityLabel(type: string): string {
    switch (type) {
      case 'vendor':
        return $localize`:@@admin.fieldHides.entity.vendor:Company`;
      case 'product':
        return $localize`:@@admin.fieldHides.entity.product:Product`;
      default:
        return $localize`:@@admin.fieldHides.entity.integration:Integration`;
    }
  }

  protected isOpen(hide: AdminFieldHide, kind: HideAction['kind']): boolean {
    const action = this.action();
    return action?.id === hide.id && action.kind === kind;
  }

  protected id(part: string): string {
    return `admin-field-hides-${this.vendorId()}-${part}`;
  }

  protected triggerId(hide: AdminFieldHide, kind: HideAction['kind']): string {
    return `admin-field-hide-${kind}-${hide.id}`;
  }

  protected actionFormId(hide: AdminFieldHide, part: string): string {
    return `admin-field-hide-${hide.id}-${part}`;
  }
}

/** One message per refusal the value-hide routes can answer. */
export function fieldHideErrorMessage(err: unknown): string {
  const { code, field } = errorBody(err);
  if (code === 'VALIDATION_FAILED' && field === 'field') {
    return $localize`:@@admin.fieldHides.error.field:This field cannot be hidden on this record. Choose another field.`;
  }
  if (code === 'VALIDATION_FAILED' && field === 'sourceUrl') {
    return $localize`:@@admin.fieldHides.error.source:The source must be a full https:// link.`;
  }
  if (code === 'VALIDATION_FAILED' && field === 'receivedAt') {
    return $localize`:@@admin.fieldHides.error.received:Enter the date the request was received. It cannot be in the future.`;
  }
  switch (code) {
    case 'FIELD_HIDE_ACTIVE':
      return $localize`:@@admin.fieldHides.error.active:This value is already hidden. It is in the list below.`;
    case 'FIELD_HIDE_CLEARED':
      return $localize`:@@admin.fieldHides.error.cleared:This hide has already ended. The list has been reloaded.`;
    case 'FIELD_HIDE_NOT_VENDOR_HELD':
      return $localize`:@@admin.fieldHides.error.notVendorHeld:No vendor holds this record, so the review app and promote write it. Handle the request there instead.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@admin.fieldHides.error.validation:Check the field, the source, the date and the reason. The reason can be up to 1,000 characters.`;
    case 'RATE_LIMITED':
      return $localize`:@@admin.fieldHides.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@admin.fieldHides.error.generic:Could not save the change. Try again.`;
  }
}
