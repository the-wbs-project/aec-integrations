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
  isFacetOverrideField,
  parseFieldOverrideValue,
  type AdminFieldOverride,
  type FieldOverrideEntityType,
  type FieldOverrideField,
  type FieldOverrideValue,
  type ProductFacetOverrideField,
  type TaxonomyResponse,
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
  /** A connector-powered integration or a pair: `mechanism_kind` is frozen there
   *  (AECI-1040 ruling 5), so the server refuses it and the picker leaves it out. */
  readonly connectorPowered?: boolean;
  /** The product's current term slugs per facet, to pre-tick the terms control
   *  (AECI-1382). Products only. */
  readonly facets?: Readonly<Record<ProductFacetOverrideField, readonly string[]>>;
}

/** How a field's value is entered. `terms` is a facet's checklist (AECI-1382). */
type ValueControl =
  | 'text'
  | 'year'
  | 'ownership'
  | 'mechanism'
  | 'direction'
  | 'textarea'
  | 'terms';

/** The largest term set a facet takes: the vendor rule (`termSlugList`). */
export const MAX_FACET_TERMS = 10;

/** Which `GET /api/taxonomy` list holds a facet's vocabulary. */
const FACET_VOCABULARY: Readonly<Record<ProductFacetOverrideField, keyof TaxonomyResponse>> = {
  category_slugs: 'categories',
  audience_slugs: 'audiences',
  phase_slugs: 'phases',
  trade_slugs: 'trades',
};

/** One row of the terms checklist. */
interface TermOption {
  readonly slug: string;
  readonly name: string;
}

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
  /** The ticked slugs when the field is a facet (AECI-1382). */
  protected readonly terms = signal<ReadonlySet<string>>(new Set());

  /** The four facet vocabularies, loaded once, on first need. */
  private readonly taxonomy = signal<TaxonomyResponse | null>(null);
  protected readonly taxonomyFailed = signal(false);
  protected readonly taxonomyReady = computed(() => this.taxonomy() !== null);
  private taxonomyLoad: Promise<void> | null = null;

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
    return record
      ? fieldOverrideFieldsFor(record.entityType, { connectorPowered: record.connectorPowered })
      : [];
  });

  protected readonly control = computed<ValueControl>(() => controlFor(this.field()));

  protected readonly maxTerms = MAX_FACET_TERMS;

  /**
   * The chosen facet's vocabulary, then any slug the product carries that the
   * vocabulary does not list, labelled with its slug, so a correction never drops a
   * term the admin cannot see.
   */
  protected readonly termOptions = computed<readonly TermOption[]>(() => {
    const field = this.field();
    if (!isFacetOverrideField(field)) return [];
    const known = this.vocabularyFor(field);
    const seen = new Set(known.map((t) => t.slug));
    const extra = [...(this.record()?.facets?.[field] ?? []), ...this.terms()]
      .filter((slug, i, all) => !seen.has(slug) && all.indexOf(slug) === i)
      .map((slug) => ({ slug, name: slug }));
    return [...known, ...extra];
  });

  protected readonly termCounter = computed(
    () =>
      $localize`:@@admin.fieldCorrections.terms.counter:${this.terms().size}:COUNT: of ${MAX_FACET_TERMS}:MAX: selected`,
  );

  constructor() {
    afterNextRender(() => void this.loadLocks());
  }

  protected async loadLocks(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await this.api.listFieldOverrides(this.vendorId());
      this.locks.set(res.overrides);
      // A facet lock's value is a slug set; the vocabulary turns it into names.
      if (res.overrides.some((lock) => Array.isArray(lock.value))) void this.loadTaxonomy();
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
    this.terms.set(new Set());
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
      const vendorId = this.vendorId();
      const [products, integrations] = await Promise.all([
        fetchAllPages((query) => this.api.listProducts(vendorId, query)),
        fetchAllPages((query) => this.api.listIntegrations(vendorId, query)),
      ]);
      this.records.set([
        company,
        ...products.map(
          (p): CorrectableRecord => ({
            key: `product:${p.id}`,
            entityType: 'product',
            id: p.id,
            label: $localize`:@@admin.fieldCorrections.record.product:${p.name}:name: (product)`,
            facets: {
              category_slugs: p.category_slugs,
              audience_slugs: p.audience_slugs,
              phase_slugs: p.phase_slugs,
              trade_slugs: p.trade_slugs,
            },
          }),
        ),
        ...integrations.map((row): CorrectableRecord => {
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
            connectorPowered: row.connector_powered,
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
    this.terms.set(new Set());
  }

  protected onField(event: Event): void {
    const field = (event.target as HTMLSelectElement).value;
    this.field.set(field);
    this.value.set('');
    // A facet starts from the product's current terms, so the admin unticks or
    // ticks the difference rather than rebuilding the set.
    this.terms.set(
      isFacetOverrideField(field) ? new Set(this.record()?.facets?.[field] ?? []) : new Set(),
    );
    if (isFacetOverrideField(field)) void this.loadTaxonomy();
  }

  protected onTerm(slug: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.terms.update((set) => {
      const next = new Set(set);
      if (checked) next.add(slug);
      else next.delete(slug);
      return next;
    });
  }

  /** At the cap, an unticked term cannot be ticked; a ticked one can always be
   *  unticked, so a set promote stored over the cap can be brought back under it. */
  protected termDisabled(slug: string): boolean {
    return this.pending() || (!this.terms().has(slug) && this.terms().size >= MAX_FACET_TERMS);
  }

  /** Loads the vocabulary once. A failure leaves the slugs as labels and says so. */
  protected loadTaxonomy(): Promise<void> {
    if (this.taxonomy()) return Promise.resolve();
    this.taxonomyLoad ??= this.api
      .getTaxonomy()
      .then((t) => {
        this.taxonomy.set(t);
        this.taxonomyFailed.set(false);
      })
      .catch(() => {
        this.taxonomyFailed.set(true);
        this.taxonomyLoad = null;
      });
    return this.taxonomyLoad;
  }

  private vocabularyFor(field: ProductFacetOverrideField): readonly TermOption[] {
    const t = this.taxonomy();
    return t ? t[FACET_VOCABULARY[field]] : [];
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
      this.control() === 'terms'
        ? [...this.terms()]
        : raw === ''
          ? null
          : this.control() === 'year'
            ? Number(raw)
            : raw;
    if (this.control() === 'terms' && this.terms().size > MAX_FACET_TERMS) {
      this.formError.set(
        $localize`:@@admin.fieldCorrections.error.tooManyTerms:Too many terms are ticked. Untick some to get back under ${MAX_FACET_TERMS}:MAX:.`,
      );
      return;
    }
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
      // A facet's set is now AECi's: the next correction on this page (after a lift)
      // pre-ticks it, not the set loaded before this one (AECI-1382).
      if (isFacetOverrideField(field) && Array.isArray(parsed.value)) {
        const slugs = parsed.value;
        this.records.update((list) =>
          list.map((r) =>
            r.key === record.key && r.facets
              ? { ...r, facets: { ...r.facets, [field]: slugs } }
              : r,
          ),
        );
      }
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

  protected valueLabel(lock: AdminFieldOverride): string {
    const { value, field } = lock;
    if (Array.isArray(value)) {
      if (value.length === 0) return $localize`:@@admin.fieldCorrections.value.noTerms:No terms`;
      const names = new Map(
        isFacetOverrideField(field) ? this.vocabularyFor(field).map((t) => [t.slug, t.name]) : [],
      );
      return value.map((slug) => names.get(slug) ?? slug).join(', ');
    }
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

/** The largest page the admin list routes serve (`PageQuerySchema`). */
const PICKER_PAGE_SIZE = 100;

/**
 * Every row of a paged admin list. The picker must offer every record the vendor
 * holds, and the two lists have no search, so it reads `total` from page 1 and
 * walks the rest one page at a time. A large vendor costs a few sequential reads.
 */
export async function fetchAllPages<T>(
  fetchPage: (query: {
    page: number;
    perPage: number;
  }) => Promise<{ data: readonly T[]; total: number }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const res = await fetchPage({ page, perPage: PICKER_PAGE_SIZE });
    rows.push(...res.data);
    if (res.data.length === 0 || rows.length >= res.total) return rows;
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
      return isFacetOverrideField(field) ? 'terms' : 'text';
  }
}

function errorBody(err: unknown): { code: string | null; field: string | null } {
  const inner = (err as { error?: { error?: { code?: unknown; field?: unknown } } } | null)?.error
    ?.error;
  return {
    code: typeof inner?.code === 'string' ? inner.code : null,
    field: typeof inner?.field === 'string' ? inner.field : null,
  };
}

function errorCode(err: unknown): string | null {
  return errorBody(err).code;
}

/** One message per refusal the two admin routes can answer. */
export function fieldCorrectionErrorMessage(err: unknown): string {
  const { code, field } = errorBody(err);
  if (code === 'VALIDATION_FAILED' && field === 'field') {
    return $localize`:@@admin.fieldCorrections.error.field:This field cannot be corrected on this record. Choose another field.`;
  }
  switch (code) {
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
