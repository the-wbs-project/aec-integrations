import { DatePipe, DOCUMENT } from '@angular/common';
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
  AdminReasonSchema,
  OWNER_EDITABLE_MECHANISM_KINDS,
  fieldOverrideFieldsFor,
  parseFieldOverrideValue,
  type AdminFieldOverride,
  type FieldOverrideEntityType,
  type FieldOverrideField,
  type FieldOverrideValue,
} from '@aeci/shared';

import { mechanismKindLabel } from '../../search/mechanism-labels';
import { fieldOverrideLabel } from '../../vendor/components/field-override-labels';
import { AdminVendorsApi } from './admin-vendors-api';

/** One record the form can correct: the company, a product, or a held integration. */
export interface CorrectableRecord {
  /** `${entityType}:${id}`, the select's value. */
  readonly key: string;
  readonly entityType: FieldOverrideEntityType;
  readonly id: string;
  readonly label: string;
  /** The two endpoint names, for the `direction` choices. Integrations only. */
  readonly source?: string;
  readonly target?: string;
}

/** How a field's value is entered. */
type ValueControl = 'text' | 'year' | 'ownership' | 'mechanism' | 'direction' | 'textarea';

/**
 * "Field corrections" on `/admin/vendors/:id` (AECI-1237 / `ADMIN_PANEL_SPEC.md` §5.7,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5).
 *
 * Two parts. The active-lock list: every field AEC Integrations corrected and locked on
 * this vendor, its products and the integrations it holds, with a Lift action. And the
 * "Correct a field" form: the record, the field, the new value, the reason shown to the
 * vendor and an optional internal note.
 *
 * Why one panel with a record picker: the admin has no product or integration page.
 * The vendor page is where an operator already acts on a vendor's records (the logo,
 * the retire), so every record the vendor holds is corrected from here.
 *
 * The pattern is the integrations panel's: an explicit second step, an inline form, no
 * browser dialog, pessimistic writes, and one announcement through the page's live
 * region (`announce`). The labels are AECI-1159's.
 */
@Component({
  selector: 'aec-admin-field-corrections',
  imports: [DatePipe],
  templateUrl: './admin-field-corrections.html',
})
export class AdminFieldCorrections {
  readonly vendorId = input.required<string>();
  readonly vendorName = input.required<string>();
  readonly announce = output<string>();

  private readonly api = inject(AdminVendorsApi);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  protected readonly locks = signal<readonly AdminFieldOverride[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  /** The records the form offers, loaded on first open. */
  protected readonly records = signal<readonly CorrectableRecord[]>([]);
  protected readonly formOpen = signal(false);
  protected readonly recordKey = signal('');
  protected readonly field = signal('');
  protected readonly value = signal('');
  protected readonly reason = signal('');
  protected readonly internalNote = signal('');
  protected readonly pending = signal(false);
  protected readonly formError = signal<string | null>(null);
  protected readonly reasonError = signal(false);

  /** The lock whose lift form is open. */
  protected readonly liftFor = signal<string | null>(null);
  protected readonly liftReason = signal('');
  protected readonly liftNote = signal('');
  protected readonly liftError = signal<string | null>(null);

  protected readonly reasonMax = ADMIN_REASON_MAX;
  protected readonly mechanismKinds = OWNER_EDITABLE_MECHANISM_KINDS;

  private readonly recordEl = viewChild<ElementRef<HTMLSelectElement>>('recordInput');
  private readonly reasonEl = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
  private readonly liftReasonEl = viewChild<ElementRef<HTMLTextAreaElement>>('liftReasonInput');

  protected readonly record = computed(
    () => this.records().find((r) => r.key === this.recordKey()) ?? null,
  );

  protected readonly fields = computed<readonly FieldOverrideField[]>(() => {
    const record = this.record();
    return record ? fieldOverrideFieldsFor(record.entityType) : [];
  });

  protected readonly control = computed<ValueControl>(() => controlFor(this.field()));

  constructor() {
    afterNextRender(() => void this.loadLocks());
  }

  protected async loadLocks(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await this.api.listFieldOverrides(this.vendorId());
      this.locks.set(res.overrides);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected async openForm(): Promise<void> {
    this.formOpen.set(true);
    this.formError.set(null);
    this.reasonError.set(false);
    if (this.records().length === 0) await this.loadRecords();
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
    this.recordKey.set('');
    this.field.set('');
    this.value.set('');
    this.reason.set('');
    this.internalNote.set('');
    this.formError.set(null);
    this.reasonError.set(false);
  }

  private async loadRecords(): Promise<void> {
    const company: CorrectableRecord = {
      key: `vendor:${this.vendorId()}`,
      entityType: 'vendor',
      id: this.vendorId(),
      label: $localize`:@@admin.fieldCorrections.record.company:${this.vendorName()}:name: (company)`,
    };
    try {
      const [products, integrations] = await Promise.all([
        this.api.listProducts(this.vendorId(), { page: 1, perPage: 100 }),
        this.api.listIntegrations(this.vendorId(), { page: 1, perPage: 100 }),
      ]);
      this.records.set([
        company,
        ...products.data.map(
          (p): CorrectableRecord => ({
            key: `product:${p.id}`,
            entityType: 'product',
            id: p.id,
            label: $localize`:@@admin.fieldCorrections.record.product:${p.name}:name: (product)`,
          }),
        ),
        ...integrations.data.map((row): CorrectableRecord => {
          const entityType: FieldOverrideEntityType =
            row.anchor === 'evidenced_pair' ? 'connector_evidenced_pair' : 'integration';
          const name = row.name ?? `${row.source.name} ↔ ${row.target.name}`;
          return {
            key: `${entityType}:${row.id}`,
            entityType,
            id: row.id,
            label: $localize`:@@admin.fieldCorrections.record.integration:${name}:name: (integration)`,
            source: row.source.name,
            target: row.target.name,
          };
        }),
      ]);
    } catch {
      this.records.set([company]);
      this.formError.set(
        $localize`:@@admin.fieldCorrections.error.records:Could not load this vendor's products and integrations. Only the company can be corrected for now.`,
      );
    }
  }

  protected onRecord(event: Event): void {
    this.recordKey.set((event.target as HTMLSelectElement).value);
    this.field.set('');
    this.value.set('');
  }

  protected onField(event: Event): void {
    this.field.set((event.target as HTMLSelectElement).value);
    this.value.set('');
  }

  protected onValue(event: Event): void {
    this.value.set((event.target as HTMLInputElement | HTMLSelectElement).value);
  }

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError()) this.reasonError.set(false);
  }

  protected onNote(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async submit(): Promise<void> {
    if (this.pending()) return;
    const record = this.record();
    const field = this.field() as FieldOverrideField;
    if (!record || !field) {
      this.formError.set(
        $localize`:@@admin.fieldCorrections.error.pick:Choose the record and the field to correct.`,
      );
      return;
    }
    const raw = this.value().trim();
    const value: FieldOverrideValue =
      raw === '' ? null : this.control() === 'year' ? Number(raw) : raw;
    const parsed = parseFieldOverrideValue(record.entityType, field, value);
    if (!parsed.ok) {
      this.formError.set(
        $localize`:@@admin.fieldCorrections.error.value:This value is not valid for this field. Use the same format the vendor's own form takes.`,
      );
      return;
    }
    if (!AdminReasonSchema.safeParse(this.reason()).success) {
      this.reasonError.set(true);
      this.reasonEl()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.formError.set(null);
    try {
      const res = await this.api.setFieldOverride({
        entityType: record.entityType,
        entityId: record.id,
        field,
        value: parsed.value,
        reason: this.reason().trim(),
        internalNote: this.internalNote(),
      });
      this.locks.update((list) => [res.override, ...list]);
      this.formOpen.set(false);
      this.resetForm();
      this.announce.emit(
        $localize`:@@admin.fieldCorrections.announce.saved:Field corrected and locked. The vendor was told, with your reason.`,
      );
      afterNextRender(() => this.document.getElementById(this.id('open'))?.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.formError.set(fieldCorrectionErrorMessage(err));
    } finally {
      this.pending.set(false);
    }
  }

  protected openLift(lock: AdminFieldOverride): void {
    this.liftFor.set(lock.id);
    this.liftReason.set('');
    this.liftNote.set('');
    this.liftError.set(null);
    afterNextRender(() => this.liftReasonEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeLift(lock: AdminFieldOverride): void {
    this.liftFor.set(null);
    this.liftError.set(null);
    afterNextRender(() => this.document.getElementById(this.liftTriggerId(lock))?.focus(), {
      injector: this.injector,
    });
  }

  protected onLiftReason(event: Event): void {
    this.liftReason.set((event.target as HTMLTextAreaElement).value);
  }

  protected onLiftNote(event: Event): void {
    this.liftNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async lift(lock: AdminFieldOverride): Promise<void> {
    if (this.pending()) return;
    if (!AdminReasonSchema.safeParse(this.liftReason()).success) {
      this.liftError.set(
        $localize`:@@admin.fieldCorrections.lift.reasonRequired:Enter a reason for the vendor. The vendor reads it in its portal messages.`,
      );
      this.liftReasonEl()?.nativeElement.focus();
      return;
    }
    this.pending.set(true);
    this.liftError.set(null);
    try {
      await this.api.liftFieldOverride(lock.id, this.liftReason().trim(), this.liftNote());
      this.locks.update((list) => list.filter((l) => l.id !== lock.id));
      this.liftFor.set(null);
      this.announce.emit(
        $localize`:@@admin.fieldCorrections.announce.lifted:Lock lifted. The vendor can edit the field again and was told why.`,
      );
      afterNextRender(() => this.document.getElementById(this.id('heading'))?.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.liftError.set(fieldCorrectionErrorMessage(err));
      if (errorCode(err) === 'FIELD_OVERRIDE_LIFTED') void this.loadLocks();
    } finally {
      this.pending.set(false);
    }
  }

  protected fieldLabel(field: string): string {
    return fieldOverrideLabel(field);
  }

  protected entityLabel(type: string): string {
    switch (type) {
      case 'vendor':
        return $localize`:@@admin.fieldCorrections.entity.vendor:Company`;
      case 'product':
        return $localize`:@@admin.fieldCorrections.entity.product:Product`;
      default:
        return $localize`:@@admin.fieldCorrections.entity.integration:Integration`;
    }
  }

  protected valueLabel(value: FieldOverrideValue): string {
    return value === null
      ? $localize`:@@admin.fieldCorrections.value.cleared:Cleared`
      : String(value);
  }

  protected directionOptions(): ReadonlyArray<{ value: string; label: string }> {
    const record = this.record();
    const a = record?.source ?? 'A';
    const b = record?.target ?? 'B';
    return [
      {
        value: 'a_to_b',
        label: $localize`:@@admin.fieldCorrections.direction.aToB:${a}:a: to ${b}:b:`,
      },
      {
        value: 'b_to_a',
        label: $localize`:@@admin.fieldCorrections.direction.bToA:${b}:b: to ${a}:a:`,
      },
      { value: 'both', label: $localize`:@@admin.fieldCorrections.direction.both:Both ways` },
    ];
  }

  protected mechanismLabel(kind: string): string {
    return mechanismKindLabel(kind);
  }

  protected id(part: string): string {
    return `admin-field-corrections-${this.vendorId()}-${part}`;
  }

  protected liftTriggerId(lock: AdminFieldOverride): string {
    return `admin-field-lock-lift-${lock.id}`;
  }

  protected liftFormId(lock: AdminFieldOverride, part: string): string {
    return `admin-field-lock-${lock.id}-${part}`;
  }
}

function controlFor(field: string): ValueControl {
  switch (field) {
    case 'founded_year':
      return 'year';
    case 'public_private':
      return 'ownership';
    case 'mechanism_kind':
      return 'mechanism';
    case 'direction':
      return 'direction';
    case 'description':
      return 'textarea';
    default:
      return 'text';
  }
}

function errorCode(err: unknown): string | null {
  const inner = (err as { error?: { error?: { code?: unknown } } } | null)?.error?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}

/** One message per refusal the two admin routes can answer. */
export function fieldCorrectionErrorMessage(err: unknown): string {
  switch (errorCode(err)) {
    case 'FIELD_OVERRIDE_ACTIVE':
      return $localize`:@@admin.fieldCorrections.error.active:This field is already locked. Lift the lock below before correcting it again.`;
    case 'FIELD_OVERRIDE_LIFTED':
      return $localize`:@@admin.fieldCorrections.error.lifted:This lock was already lifted. The list has been reloaded.`;
    case 'FIELD_OVERRIDE_NOT_VENDOR_HELD':
      return $localize`:@@admin.fieldCorrections.error.notVendorHeld:No vendor holds this record, so the review app and promote write it. Correct it there instead.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@admin.fieldCorrections.error.validation:Check the field, the value and the reason. The reason can be up to 1,000 characters.`;
    case 'RATE_LIMITED':
      return $localize`:@@admin.fieldCorrections.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@admin.fieldCorrections.error.generic:Could not save the change. Try again.`;
  }
}
