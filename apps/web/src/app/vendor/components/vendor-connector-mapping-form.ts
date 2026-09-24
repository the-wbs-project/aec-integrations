import { Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';

import {
  CONNECTOR_DECISION_STATUSES,
  CONNECTOR_MAPPING_CONFIDENCES,
  CONNECTOR_MAPPING_STATUSES,
  HTTPS_URL_MAX_LENGTH,
  HttpsUrlSchema,
  toVendorConnectorMapping,
  type LinkRef,
  type UpdateConnectorStubMappingInput,
  type VendorConnectorMapping,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
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
        ? $localize`:@@vendor.catalogue.error.product:Choose a product that is published on AECi, or pick a status that names no product.`
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
    return $localize`:@@vendor.catalogue.error.forbidden:Your seat cannot edit this catalogue.`;
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
  imports: [AecSelect],
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
            <p [class]="labelClass" i18n="@@vendor.catalogue.form.product">Product on AECi</p>
            <p class="mt-1 flex flex-wrap items-center gap-3 text-sm text-(--text-primary)">
              <span class="font-medium" data-chosen-product>{{ p.name }}</span>
              <button
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
              >Product on AECi</label
            >
            <div class="mt-1 flex gap-2">
              <input
                [id]="idPrefix() + '-product'"
                type="search"
                autocomplete="off"
                [class]="inputClass"
                [attr.aria-describedby]="productDescribedBy()"
                [attr.aria-invalid]="productError() ? 'true' : null"
                [value]="productQuery()"
                (input)="productQuery.set(inputValue($event))"
                (keydown.enter)="$event.preventDefault(); searchProducts()"
              />
              <button
                type="button"
                [class]="secondaryButtonClass"
                [disabled]="searching()"
                (click)="searchProducts()"
                i18n="@@vendor.catalogue.form.product.find"
              >
                Find
              </button>
            </div>
            <p
              [id]="idPrefix() + '-product-hint'"
              class="mt-1 max-w-[52ch] text-xs text-(--text-secondary)"
            >
              <span i18n="@@vendor.catalogue.form.product.hint"
                >Search the products published on AECi by name.</span
              >
              @if (searchNotice()) {
                {{ ' ' }}<span>{{ searchNotice() }}</span>
              }
            </p>
            @if (productError()) {
              <p
                [id]="idPrefix() + '-product-error'"
                class="mt-1 text-xs font-medium text-(--status-error)"
              >
                {{ productError() }}
              </p>
            }
            @if (results().length > 0) {
              <ul
                class="m-0 mt-2 list-none space-y-1 p-0"
                [attr.aria-label]="resultsLabel"
                data-product-results
              >
                @for (r of results(); track r.id) {
                  <li>
                    <button
                      type="button"
                      class="flex min-h-11 w-full cursor-pointer flex-col items-start rounded-(--radius-sm) px-3 py-2 text-start text-sm text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                      (click)="chooseProduct(r)"
                    >
                      <span class="font-medium">{{ r.name }}</span>
                      <span class="text-xs text-(--text-secondary)">{{ r.slug }}</span>
                    </button>
                  </li>
                }
              </ul>
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
            catalogue.</span
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
        that product's reach on AECi.
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
  private readonly announcer = inject(VendorPortalAnnouncer);

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

  protected readonly productQuery = signal('');
  protected readonly results = signal<readonly LinkRef[]>([]);
  protected readonly searching = signal(false);
  protected readonly searchNotice = signal('');

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

  protected readonly resultsLabel = $localize`:@@vendor.catalogue.form.product.results:Matching products`;

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

  protected async searchProducts(): Promise<void> {
    const query = this.productQuery().trim();
    if (query.length < 2) {
      this.searchNotice.set(
        $localize`:@@vendor.catalogue.form.search.short:Type at least two letters of the name.`,
      );
      return;
    }
    if (this.searching()) return;
    this.searching.set(true);
    this.searchNotice.set('');
    try {
      const page = await this.api.searchProducts(query);
      const found = page.data.map((p) => ({ id: p.id, name: p.name, slug: p.slug }));
      this.results.set(found);
      if (found.length === 0) {
        this.searchNotice.set(
          $localize`:@@vendor.catalogue.form.search.none:No published product matches that name.`,
        );
      }
    } catch {
      this.results.set([]);
      this.searchNotice.set(
        $localize`:@@vendor.catalogue.form.search.failed:The search did not work. Try again.`,
      );
    } finally {
      this.searching.set(false);
    }
  }

  protected chooseProduct(p: LinkRef): void {
    this.product.set(p);
    this.results.set([]);
    this.productQuery.set('');
    this.searchNotice.set('');
    this.productError.set('');
  }

  protected clearProduct(): void {
    this.product.set(null);
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
      this.saved.emit({ mapping: toVendorConnectorMapping(res.mapping), changed: res.changed });
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
