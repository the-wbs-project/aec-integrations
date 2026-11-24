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
  viewChild,
} from '@angular/core';

import {
  ABUSE_STAFF_CENTS_PER_MINUTE,
  ADMIN_REASON_MAX,
  type AbuseCostEntry,
  type AbuseCostEntryRequest,
} from '@aeci/shared';

import { AdminVendorSuspensionApi } from './admin-vendor-suspension-api';
import {
  formatCents,
  isStaleError,
  parseDollarsToCents,
  suspensionErrorMessage,
} from './vendor-suspension-model';
import { AecButton } from '../../shared/button/button';
import { AecFormSubmit } from '../../shared/form-field/form-submit';
import {
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { CONSOLE_CAPTION_CLASS, CONSOLE_TABLE } from '../console/console-table';
import { QUEUE_FAILED_CLASS } from '../reviews/queue-classes';
import {
  VENDOR_ACTIONS_CLASS,
  VENDOR_FIELD_CLASS,
  VENDOR_FORM_CLASS,
  VENDOR_PANEL_FORM_CLASS,
} from './vendor-console-classes';

type CostKind = AbuseCostEntry['kind'];

/** `AbuseCostEntryRequestSchema`'s limits, mirrored so the fields stop an over-long value. */
const DESCRIPTION_MAX = 300;
const MINUTES_MAX = 100_000;

/** `YYYY-MM-DD` in UTC, because the API refuses a date after its own UTC today. */
const utcToday = (): string => new Date().toISOString().slice(0, 10);

/**
 * The abuse cost log of one suspension (AECI-1623, counsel's Q13 follow-up). The only source
 * of the cost Terminate deducts, so the server stamps when each entry was logged and an
 * entry is voided, never edited. `readOnly` shows a resolved suspension's log.
 *
 * No heading and no live region: the section owns the heading, `VendorDetail` the region.
 *
 * ── LOOK AND FOCUS (AECI-2124) ──────────────────────────────────────────────
 * A part of the Suspension panel: the console table, a void in the entry's detail row,
 * the add form in place of its secondary opener. Both confirms are primary: a logged
 * cost can be voided, and a void gives back what the entry would have deducted. Cancel
 * and Escape close a form and return focus to its opener. Escape does nothing while the
 * request runs. A refused write focuses its message.
 */
@Component({
  selector: 'aec-suspension-cost-log',
  imports: [AecButton, AecFormSubmit, DatePipe],
  templateUrl: './suspension-cost-log.html',
})
export class SuspensionCostLog {
  private readonly api = inject(AdminVendorSuspensionApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly vendorId = input.required<string>();
  readonly entries = input.required<readonly AbuseCostEntry[]>();
  readonly idPrefix = input.required<string>();
  readonly currency = input('usd');
  readonly readOnly = input(false);

  /** The log changed. The host re-reads the state, because the preview's total moved. */
  readonly changed = output<void>();
  /** The API answered 409: the page is behind. */
  readonly stale = output<void>();
  readonly announce = output<string>();

  protected readonly t = CONSOLE_TABLE;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly choiceClass = CHOICE_INPUT_CLASS;
  protected readonly failedClass = QUEUE_FAILED_CLASS;
  protected readonly formClass = VENDOR_FORM_CLASS;
  protected readonly voidFormClass = VENDOR_PANEL_FORM_CLASS;
  protected readonly fieldClass = VENDOR_FIELD_CLASS;
  protected readonly actionsClass = VENDOR_ACTIONS_CLASS;
  private readonly failedAlert = viewChild<ElementRef<HTMLElement>>('failedAlert');
  private readonly voidFailedAlert = viewChild<ElementRef<HTMLElement>>('voidFailedAlert');
  protected readonly reasonMax = ADMIN_REASON_MAX;
  protected readonly descriptionMax = DESCRIPTION_MAX;
  /** $150 an hour, from the one constant the API charges by. */
  protected readonly hourlyRate = (ABUSE_STAFF_CENTS_PER_MINUTE * 60) / 100;

  // ── Add ────────────────────────────────────────────────────────────────────
  protected readonly formOpen = signal(false);
  protected readonly kindOptions: readonly CostKind[] = ['staff', 'third_party', 'recovery'];
  protected readonly kind = signal<CostKind>('staff');
  protected readonly workDate = signal('');
  protected readonly description = signal('');
  protected readonly quantity = signal('');
  protected readonly showErrors = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');
  protected readonly maxDate = signal(utcToday());

  protected readonly dateValid = computed(() => {
    const date = this.workDate();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= this.maxDate();
  });
  protected readonly descriptionValid = computed(() => this.description().trim().length > 0);
  private readonly minutes = computed(() => {
    const value = this.quantity().trim();
    if (!/^\d+$/.test(value)) return null;
    const minutes = Number(value);
    return minutes > 0 && minutes <= MINUTES_MAX ? minutes : null;
  });
  private readonly amountCents = computed(() => {
    const cents = parseDollarsToCents(this.quantity());
    return cents !== null && cents > 0 ? cents : null;
  });
  protected readonly quantityValid = computed(() =>
    this.kind() === 'staff' ? this.minutes() !== null : this.amountCents() !== null,
  );
  /** What the entry will count for, before it is saved. */
  protected readonly staffPreview = computed(() => {
    const minutes = this.minutes();
    return minutes === null ? null : this.money(minutes * ABUSE_STAFF_CENTS_PER_MINUTE);
  });

  // ── Void ───────────────────────────────────────────────────────────────────
  protected readonly voidingId = signal<string | null>(null);
  protected readonly voidReason = signal('');
  protected readonly voidReasonError = signal(false);
  protected readonly voidPending = signal(false);
  protected readonly voidFailedMessage = signal('');

  protected money(cents: number): string {
    return formatCents(cents, this.currency());
  }

  protected kindLabel(kind: CostKind): string {
    switch (kind) {
      case 'staff':
        return $localize`:@@admin.vendors.suspension.cost.kind.staff:Staff time`;
      case 'third_party':
        return $localize`:@@admin.vendors.suspension.cost.kind.thirdParty:Third-party cost`;
      case 'recovery':
        return $localize`:@@admin.vendors.suspension.cost.kind.recovery:Recovery`;
    }
  }

  protected openForm(): void {
    this.kind.set('staff');
    this.maxDate.set(utcToday());
    this.workDate.set(this.maxDate());
    this.description.set('');
    this.quantity.set('');
    this.showErrors.set(false);
    this.failedMessage.set('');
    this.formOpen.set(true);
    // The opener is gone: focus the form's first field, not the page body.
    this.focusSelector(`[id="${this.idPrefix()}-cost-kind-staff"]`);
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.focusSelector(`[id="${this.idPrefix()}-cost-open"]`);
  }

  /** Escape is Cancel, except while the entry is being logged. */
  protected onEscape(event: Event): void {
    event.stopPropagation();
    if (!this.pending()) this.closeForm();
  }

  /** Escape is the void's Cancel, except while the void runs. */
  protected onVoidEscape(event: Event): void {
    event.stopPropagation();
    if (!this.voidPending()) this.cancelVoid();
  }

  private focusSelector(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onKindChange(kind: CostKind): void {
    this.kind.set(kind);
    // Minutes and dollars are different numbers. Keeping the value would mis-enter one.
    this.quantity.set('');
  }

  protected onInput(field: 'workDate' | 'description' | 'quantity', event: Event): void {
    this[field].set((event.target as HTMLInputElement).value);
  }

  protected async submit(): Promise<void> {
    if (this.pending()) return;
    const body = this.buildEntry();
    if (!body) {
      this.showErrors.set(true);
      afterNextRender(
        () => this.host.nativeElement.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
        { injector: this.injector },
      );
      return;
    }
    this.pending.set(true);
    this.failedMessage.set('');
    try {
      await this.api.addCostEntry(this.vendorId(), body);
      this.formOpen.set(false);
      this.changed.emit();
      this.announce.emit(
        $localize`:@@admin.vendors.suspension.cost.announce.added:Cost entry logged.`,
      );
    } catch (err) {
      this.failedMessage.set(suspensionErrorMessage(err));
      this.focusAfterRender(() => this.failedAlert());
      if (isStaleError(err)) this.stale.emit();
    } finally {
      this.pending.set(false);
    }
  }

  private buildEntry(): AbuseCostEntryRequest | null {
    if (!this.dateValid() || !this.descriptionValid()) return null;
    const common = { work_date: this.workDate(), description: this.description().trim() };
    const kind = this.kind();
    if (kind === 'staff') {
      const minutes = this.minutes();
      return minutes === null ? null : { kind, ...common, minutes };
    }
    const amount_cents = this.amountCents();
    return amount_cents === null ? null : { kind, ...common, amount_cents };
  }

  protected askVoid(entryId: string): void {
    this.voidReason.set('');
    this.voidReasonError.set(false);
    this.voidFailedMessage.set('');
    this.voidingId.set(entryId);
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>(`[id="${this.idPrefix()}-void-reason-${entryId}"]`)
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected cancelVoid(): void {
    const id = this.voidingId();
    this.voidingId.set(null);
    if (id) this.focusSelector(`[id="${this.idPrefix()}-void-open-${id}"]`);
  }

  protected onVoidReasonInput(event: Event): void {
    this.voidReason.set((event.target as HTMLTextAreaElement).value);
    if (this.voidReasonError()) this.voidReasonError.set(false);
  }

  protected async confirmVoid(entryId: string): Promise<void> {
    if (this.voidPending()) return;
    const reason = this.voidReason().trim();
    if (!reason) {
      this.voidReasonError.set(true);
      return;
    }
    this.voidPending.set(true);
    this.voidFailedMessage.set('');
    try {
      await this.api.voidCostEntry(this.vendorId(), entryId, reason);
      this.voidingId.set(null);
      this.changed.emit();
      this.announce.emit(
        $localize`:@@admin.vendors.suspension.cost.announce.voided:Cost entry voided. It no longer counts.`,
      );
    } catch (err) {
      this.voidFailedMessage.set(suspensionErrorMessage(err));
      this.focusAfterRender(() => this.voidFailedAlert());
      if (isStaleError(err)) this.stale.emit();
    } finally {
      this.voidPending.set(false);
    }
  }
}
