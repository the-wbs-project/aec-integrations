import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  CONNECTOR_DECISION_STATUSES,
  CONNECTOR_MAPPING_CONFIDENCES,
  CONNECTOR_MAPPING_STATUSES,
  HTTPS_URL_MAX_LENGTH,
  HttpsUrlSchema,
  type LinkRef,
  type UpdateConnectorStubMappingInput,
  type VendorConnectorMapping,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import {
  ProductCombobox,
  type ProductComboboxItem,
  type ProductComboboxSearch,
} from '../../shared/product-combobox/product-combobox';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';

import {
  catalogueConfidenceLabel,
  catalogueStatusHelp,
  catalogueStatusLabel,
} from './vendor-catalogue-labels';

/** What a save told the host. `changed: false` is the server's 200 no-op. */
export interface CatalogueMappingSaved {
  readonly mapping: VendorConnectorMapping;
  readonly changed: boolean;
}

/**
 * The save error, in words the vendor can act on. `null` for the one code the host
 * handles itself: `CATALOG_REVIEW_MANAGED` removes the form entirely.
 */
export function catalogueSaveErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'MAPPING_CONFLICT':
      return $localize`:@@vendor.catalogue.error.conflict:This listing already has a match to that product, or already carries a decision that names no product. Edit that one instead.`;
    case 'VALIDATION_FAILED':
      return info.field === 'productId'
        ? $localize`:@@vendor.catalogue.error.product:Choose a product that is published on AEC Integrations, or pick a status that names no product.`
        : $localize`:@@vendor.catalogue.error.invalid:Check the product and the evidence link, then save again.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.catalogue.error.gone:This match no longer exists. Reload the list to see where the listing stands.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.catalogue.error.rate:Too many saves in a short time. Wait a minute and try again.`;
    default:
      break;
  }
  if (info?.status === 401) {
    return $localize`:@@vendor.catalogue.error.session:Your session has ended. Sign in again, then save.`;
  }
  if (info?.status === 403) {
    return $localize`:@@vendor.catalogue.error.forbidden:Your seat cannot edit this catalog.`;
  }
  return $localize`:@@vendor.catalogue.error.generic:Could not save this match. Try again.`;
}

/**
 * Edit one mapping on the seat's own vendor-managed catalogue (AECI-1083,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16), over AECI-724's
 * `PATCH /api/vendor/connector-stub-mappings/:id`.
 *
 * The admin `MappingEditControl`'s shape (the same four fields, the same two-column
 * rule, the same "whoever saves stands behind it" sentence), in the portal's
 * vocabulary and with the portal's field rules: persistent hints wired into
 * `aria-describedby` from first render, the error appended rather than swapped in,
 * and no opacity on a disabled control.
 *
 * ── PESSIMISTIC, ON PURPOSE ─────────────────────────────────────────────────
 * A form-shaped write (`STAGE_2_REALTIME_SPEC.md` §5): nothing changes on screen
 * until the server answers. The PATCH echoes the committed row, which the host
 * splices in, so there is no refetch.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * The host renders this only while the row is being edited, owns focus on open and
 * close, and owns the one case this form cannot show: the catalogue taken back to the
 * review lane mid-edit, which removes every form on the tab ({@link reclaimed}).
 * Success is announced through the portal's single live region; a failure is a
 * `role="alert"` beside the Save button.
 */
@Component({
  selector: 'aec-vendor-connector-mapping-form',
  imports: [AecSelect, ProductCombobox],
  host: { class: 'block' },
  template: `
    <form
      novalidate
      class="mt-3 max-w-2xl space-y-4 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) p-4"
      [attr.aria-label]="formLabel()"
      (submit)="$event.preventDefault(); submit()"
    >
      <div>
        <aec-select
          i18n-label="@@vendor.catalogue.form.status"
          label="Status"
          layout="stacked"
          [options]="statusOptions"
          [value]="status()"
          [idPrefix]="idPrefix() + '-status'"
          [describedBy]="idPrefix() + '-status-hint'"
          (changed)="onStatusChange($event)"
        />
        <p
          [id]="idPrefix() + '-status-hint'"
          class="mt-1 max-w-[52ch] text-xs text-(--text-secondary)"
        >
          {{ statusHelp() }}
        </p>
      </div>

      @if (namesProduct()) {
        <div>
          @if (product(); as p) {
            <p [class]="labelClass" i18n="@@vendor.catalogue.form.product">
              Product on AEC Integrations
            </p>
            <p class="mt-1 flex flex-wrap items-center gap-3 text-sm text-(--text-primary)">
              <span class="font-medium" data-chosen-product>{{ p.name }}</span>
              <button
                #changeButton
                type="button"
                [class]="secondaryButtonClass"
                (click)="clearProduct()"
                [attr.aria-label]="changeProductLabel(p.name)"
                i18n="@@vendor.catalogue.form.product.change"
              >
                Change
              </button>
            </p>
          } @else {
            <label
              [class]="labelClass"
              [attr.for]="idPrefix() + '-product'"
              i18n="@@vendor.catalogue.form.product"
              >Product on AEC Integrations</label
            >
            <aec-product-combobox
              class="mt-1"
              [inputId]="idPrefix() + '-product'"
              [search]="search"
              [describedBy]="productDescribedBy()"
              [invalid]="productError() !== ''"
              (picked)="chooseProduct($event)"
              (announce)="announcer.announce($event)"
            />
            <p
              [id]="idPrefix() + '-product-hint'"
              class="mt-1 max-w-[52ch] text-xs text-(--text-secondary)"
              i18n="@@vendor.catalogue.form.product.hint"
            >
              Search the products published on AEC Integrations by name.
            </p>
            @if (productError()) {
              <p
                [id]="idPrefix() + '-product-error'"
                class="mt-1 text-xs font-medium text-(--status-error)"
              >
                {{ productError() }}
              </p>
            }
          }
        </div>
      }

      <!-- Wrapped: <aec-select> is an inline host, so the form's vertical rhythm
           only reaches it through a block parent. -->
      <div>
        <aec-select
          i18n-label="@@vendor.catalogue.form.confidence"
          label="Confidence"
          layout="stacked"
          [options]="confidenceOptions"
          [value]="confidence()"
          [idPrefix]="idPrefix() + '-confidence'"
          (changed)="confidence.set($event)"
        />
      </div>

      <div>
        <label
          [class]="labelClass"
          [attr.for]="idPrefix() + '-evidence'"
          i18n="@@vendor.catalogue.form.evidence"
          >Evidence link (optional)</label
        >
        <input
          [id]="idPrefix() + '-evidence'"
          type="url"
          inputmode="url"
          autocomplete="off"
          [attr.maxlength]="maxUrlLength"
          [class]="evidenceError() ? inputErrorClass : inputClass"
          [attr.aria-describedby]="evidenceDescribedBy()"
          [attr.aria-invalid]="evidenceError() ? 'true' : null"
          [value]="evidence()"
          (input)="evidence.set(inputValue($event))"
        />
        <p
          [id]="idPrefix() + '-evidence-hint'"
          class="mt-1 max-w-[52ch] text-xs text-(--text-secondary)"
        >
          <strong class="font-semibold text-(--text-primary)"
            ><span i18n="@@vendor.catalogue.form.evidence.rule">Starts with https://.</span></strong
          >{{ ' '
          }}<span i18n="@@vendor.catalogue.form.evidence.hint"
            >A page that shows this listing connects to the product, such as its page in your
            catalog.</span
          >
        </p>
        @if (evidenceError()) {
          <p
            [id]="idPrefix() + '-evidence-error'"
            class="mt-1 text-xs font-medium text-(--status-error)"
          >
            {{ evidenceError() }}
          </p>
        }
      </div>

      <!-- Said out loud: saving is what makes a matched listing count publicly. -->
      <p
        class="max-w-[52ch] text-xs text-(--text-secondary)"
        i18n="@@vendor.catalogue.form.decider"
      >
        Saving records your company as the one who decided. A matched listing then counts toward
        that product's reach on AEC Integrations.
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <button type="submit" [class]="primaryButtonClass" [disabled]="pending()">
          @if (pending()) {
            <span i18n="@@vendor.catalogue.form.saving">Saving…</span>
          } @else {
            <span i18n="@@vendor.catalogue.form.save">Save match</span>
          }
        </button>
        <button
          type="button"
          [class]="secondaryButtonClass"
          [disabled]="pending()"
          (click)="cancelled.emit()"
          i18n="@@vendor.catalogue.form.cancel"
        >
          Cancel
        </button>
      </div>

      @if (failed()) {
        <p class="text-sm font-medium text-(--text-primary)" role="alert" data-save-error>
          {{ failed() }}
        </p>
      }
    </form>
  `,
})
export class VendorConnectorMappingForm {
  private readonly api = inject(VendorApi);
  protected readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  readonly mapping = input.required<VendorConnectorMapping>();
  /** The listing's name, for the form's accessible name and the announcement. */
  readonly listing = input.required<string>();
  /** Stem for the `id` / `for` pairs. One form per mapping row. */
  readonly idPrefix = input.required<string>();

  readonly saved = output<CatalogueMappingSaved>();
  readonly cancelled = output<void>();
  /** `409 CATALOG_REVIEW_MANAGED`: the AECi team took the catalogue back. */
  readonly reclaimed = output<void>();

  // Seeded from the row. The host creates a fresh form per edit and holds background
  // refreshes back while one is open, so the row does not move under the vendor.
  protected readonly status = linkedSignal<string>(() => this.mapping().status);
  protected readonly product = linkedSignal<LinkRef | null>(() => this.mapping().product);
  protected readonly confidence = linkedSignal<string | null>(() => this.mapping().confidence);
  protected readonly evidence = linkedSignal(() => this.mapping().evidence_url ?? '');

  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('changeButton');
  private readonly combobox = viewChild(ProductCombobox);

  /** The public product search, A to Z (AECI-1244). */
  protected readonly search: ProductComboboxSearch = (query) => this.api.searchProducts(query);

  protected readonly pending = signal(false);
  protected readonly failed = signal('');
  protected readonly productError = signal('');
  protected readonly evidenceError = signal('');

  protected readonly maxUrlLength = HTTPS_URL_MAX_LENGTH;

  /** §9a.4: `mapped` / `ruled_out` name a product; the three decisions name none. */
  protected readonly namesProduct = computed(
    () => !(CONNECTOR_DECISION_STATUSES as readonly string[]).includes(this.status()),
  );

  protected readonly statusHelp = computed(() => catalogueStatusHelp(this.status()));

  protected readonly formLabel = computed(
    () => $localize`:@@vendor.catalogue.form.aria:Edit the match for ${this.listing()}:LISTING:`,
  );

  protected readonly productDescribedBy = computed(() => {
    const base = `${this.idPrefix()}-product-hint`;
    return this.productError() ? `${base} ${this.idPrefix()}-product-error` : base;
  });

  protected readonly evidenceDescribedBy = computed(() => {
    const base = `${this.idPrefix()}-evidence-hint`;
    return this.evidenceError() ? `${base} ${this.idPrefix()}-evidence-error` : base;
  });

  protected readonly statusOptions: readonly AecSelectOption[] = CONNECTOR_MAPPING_STATUSES.map(
    (value) => ({ value, label: catalogueStatusLabel(value) }),
  );
  protected readonly confidenceOptions: readonly AecSelectOption[] = [
    { value: null, label: catalogueConfidenceLabel(null) },
    ...CONNECTOR_MAPPING_CONFIDENCES.map((value) => ({
      value,
      label: catalogueConfidenceLabel(value),
    })),
  ];

  protected onStatusChange(value: string | null): void {
    if (value) this.status.set(value);
    this.productError.set('');
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected changeProductLabel(name: string): string {
    return $localize`:@@vendor.catalogue.form.product.changeAria:Change the product, now ${name}:PRODUCT:`;
  }

  protected chooseProduct(p: ProductComboboxItem): void {
    this.product.set({ id: p.id, name: p.name, slug: p.slug });
    this.productError.set('');
    // The picker unmounts, so focus moves to the control that brings it back.
    afterNextRender(() => this.changeButton()?.nativeElement.focus(), { injector: this.injector });
  }

  protected clearProduct(): void {
    this.product.set(null);
    afterNextRender(() => this.combobox()?.focus(), { injector: this.injector });
  }

  protected async submit(): Promise<void> {
    if (this.pending()) return;
    this.failed.set('');
    const namesProduct = this.namesProduct();
    const product = namesProduct ? this.product() : null;
    const evidence = this.evidence().trim();

    this.productError.set(
      namesProduct && !product
        ? $localize`:@@vendor.catalogue.form.product.required:Choose the product, or pick a status that names none.`
        : '',
    );
    this.evidenceError.set(
      evidence !== '' && !HttpsUrlSchema.safeParse(evidence).success
        ? $localize`:@@vendor.catalogue.form.evidence.invalid:Use a full link that starts with https://.`
        : '',
    );
    if (this.productError() || this.evidenceError()) return;

    const body: UpdateConnectorStubMappingInput = {
      status: this.status() as UpdateConnectorStubMappingInput['status'],
      productId: product?.id ?? null,
      confidence: this.confidence() as UpdateConnectorStubMappingInput['confidence'],
      evidenceUrl: evidence === '' ? null : evidence,
    };

    this.pending.set(true);
    try {
      const res = await this.api.updateConnectorMapping(this.mapping().id, body);
      const listing = this.listing();
      this.announcer.announce(
        res.changed
          ? $localize`:@@vendor.catalogue.announce.saved:Match for ${listing}:LISTING: saved.`
          : $localize`:@@vendor.catalogue.announce.unchanged:Nothing changed on the match for ${listing}:LISTING:.`,
      );
      this.saved.emit({ mapping: res.mapping, changed: res.changed });
    } catch (err) {
      if (readVendorApiError(err)?.code === 'CATALOG_REVIEW_MANAGED') {
        this.reclaimed.emit();
        return;
      }
      this.failed.set(catalogueSaveErrorMessage(err));
    } finally {
      this.pending.set(false);
    }
  }

  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** The error tell is the border plus the message, never a dimmed value. The
   *  border colour is an arbitrary-property class because border-colour utilities
   *  lose to the unlayered `*` rule in `styles.css`. */
  protected readonly inputErrorClass =
    'w-full rounded-(--radius-md) border [border-color:var(--status-error)] bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** Disabled is a surface swap, never opacity (DESIGN.md, AECI-982). */
  protected readonly primaryButtonClass =
    'inline-flex min-h-10 items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
  protected readonly secondaryButtonClass =
    'inline-flex min-h-10 shrink-0 items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
}
