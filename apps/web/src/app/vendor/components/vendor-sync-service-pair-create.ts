import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import {
  CONNECTOR_POWERED_EDIT_FIELDS,
  INTEGRATION_EDIT_MAX_LENGTH,
  INTEGRATION_EDIT_URL_FIELDS,
  SYNC_SERVICE_PAIR_REQUIRED_FIELDS,
  isSyncService,
  orderedPairSlugs,
  type CreateSyncServicePairInput,
  type IntegrationEditField,
} from '@aeci/shared';

import { isReplayedEvent } from '../../core/event-replay';
import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import {
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FIELD_OPTIONAL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import {
  ProductCombobox,
  type ProductComboboxItem,
  type ProductComboboxSearch,
} from '../../shared/product-combobox/product-combobox';
import { CloseOnEscape } from '../shared/close-on-escape';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';
import {
  PORTAL_FIELDSET_CLASS,
  PORTAL_FIELD_CLASS,
  PORTAL_FORM_CLASS,
  PORTAL_FORM_GRID_CLASS,
  PORTAL_FORM_SPAN_CLASS,
  PORTAL_LEGEND_CLASS,
  PORTAL_SAVE_BAR_CLASS,
  PORTAL_SAVE_BUTTON_CLASS,
  PORTAL_SAVE_STATUS_CLASS,
} from '../shared/portal-form';

import { editFieldLabel } from './vendor-contest-labels';
import { EDIT_GROUPS } from './vendor-integration-edit-form';
import { editValueMessage } from './vendor-integration-ownership-labels';

/** The fields a Sync Service pair takes: the owner edit's groups without the type,
 *  which `connector_evidenced_pairs` has no column for. */
type PairField = Exclude<IntegrationEditField, 'mechanism_kind'>;
const PAIR_FIELD_SET = new Set<IntegrationEditField>(CONNECTOR_POWERED_EDIT_FIELDS);
const PAIR_GROUPS = EDIT_GROUPS.map((group) => ({
  key: group.key,
  fields: group.fields.filter((field): field is PairField => PAIR_FIELD_SET.has(field)),
}));
const REQUIRED = new Set<IntegrationEditField>(SYNC_SERVICE_PAIR_REQUIRED_FIELDS);

type Draft = Record<PairField, string>;
type Side = 'first' | 'second';

function emptyDraft(): Draft {
  return Object.fromEntries(
    PAIR_GROUPS.flatMap((group) => group.fields).map((field) => [field, '']),
  ) as Draft;
}

/** The product the tab is filed under, as the portal holds it. */
export interface SyncServiceTabProduct {
  readonly id: string;
  readonly name: string;
  readonly product_role: string;
  readonly connector_kind: string | null;
}

/** Should this product's Integrations tab offer the Sync Service create? Only a Sync
 *  Service: an Integration platform or an unclassified connector never gets it
 *  (ruling 1 of 2026-09-23 stands for them; AECI-1128). */
export function offersSyncServicePairCreate(product: SyncServiceTabProduct | null): boolean {
  return product !== null && isSyncService(product.product_role, product.connector_kind);
}

/**
 * "Add an integration your Sync Service delivers" (AECI-2040, rulings 7 and 11 on
 * AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.7).
 *
 * Mounted on a Sync Service product's Integrations tab, above "Integrations your
 * company offers", where the new pair appears with its data flows panel (AECI-2039).
 * The host renders it only when {@link offersSyncServicePairCreate} is true.
 *
 * The two products are picked with the shared type-ahead `aec-product-combobox`, the
 * same picker the vendor create uses for its other product (the Same-Behavior Rule).
 * Neither needs to be the vendor's, and the Sync Service itself is left out of both.
 * The fields are the owner edit's groups without the type, with the same labels and
 * the same value rule. Pessimistic: the form waits for the `201`, then announces,
 * revalidates `integrations` (which carries the owned rows) and moves focus to the
 * receipt. Each refusal has its own sentence in a `role="alert"`.
 */
@Component({
  selector: 'aec-vendor-sync-service-pair-create',
  imports: [AecButton, AecCard, AecIcon, CloseOnEscape, LogoOrInitial, NewTabIcon, ProductCombobox],
  host: { class: 'block' },
  template: `
    <section class="space-y-4" aria-labelledby="vendor-sync-create-heading" data-sync-create>
      <h2 id="vendor-sync-create-heading" class="m-0">
        <span
          class="block font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.syncCreate.heading"
          >Integrations {{ product().name }} delivers</span
        >
      </h2>
      <p class="text-sm text-(--text-secondary)" i18n="@@vendor.syncCreate.intro.v2">
        You can add an integration that {{ product().name }} delivers between two products on the
        site. Neither product needs to be yours. The vendors of both products are told when you add
        it. Either vendor can remove it from its product page, and then you cannot add it again.
        They can also report that it is not offered, or that a data flow is wrong.
      </p>
      <!-- AECI-2045 QA: the host's summary line (how many pairs, rows and answers). -->
      <ng-content />

      @if (result(); as done) {
        <div
          #receipt
          tabindex="-1"
          aecCard
          class="relative max-w-3xl py-4 ps-6 pe-12 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
          data-testid="sync-create-receipt"
        >
          <p class="text-sm font-semibold text-(--text-primary)" i18n="@@vendor.syncCreate.done">
            Your integration is live on the public site.
          </p>
          <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@vendor.syncCreate.doneNext">
            It is listed below. Add the data it syncs there.
          </p>
          <p class="mt-3">
            <a
              [href]="done.publicPath"
              target="_blank"
              rel="noopener"
              [class]="publicLinkClass"
              data-testid="sync-create-public"
              ><span i18n="@@vendor.syncCreate.viewPublic">View public page</span><aec-new-tab-icon
            /></a>
          </p>
          <button
            aecButton
            variant="ghost"
            type="button"
            class="absolute end-2 top-2"
            (click)="dismiss()"
            i18n="@@vendor.syncCreate.dismiss"
          >
            Dismiss
          </button>
        </div>
      }

      @if (!open()) {
        <button
          #trigger
          aecButton
          variant="secondary"
          type="button"
          aria-controls="vendor-sync-create-form"
          [attr.aria-expanded]="false"
          (click)="openForm()"
          data-testid="sync-create-open"
        >
          {{ triggerLabel() }}
        </button>
      } @else {
        <!-- AECI-2045 QA: the portal form card the ordinary create uses (portal-form.ts):
             fieldsets under overline legends, two columns from 768px, the shared field
             recipe, and the save bar with the primary action and Cancel. -->
        <div aecCard phoneFlush class="max-w-4xl p-6 md:p-8">
          <form
            aecCloseOnEscape
            [escapeBusy]="saving()"
            (escapeCancel)="close()"
            id="vendor-sync-create-form"
            method="dialog"
            [class]="formClass"
            novalidate
            (submit)="onSubmit($event)"
            data-testid="sync-create-form"
          >
            <fieldset [class]="fieldsetClass">
              <legend [class]="legendClass" i18n="@@vendor.syncCreate.products.legend">
                The two products it connects
              </legend>
              <div [class]="gridClass">
                @for (side of sides; track side) {
                  <div [class]="fieldClass">
                    @if (picked()[side]; as chosen) {
                      <p [id]="'vendor-sync-' + side + '-label'" [class]="labelClass">
                        {{ sideLabel(side) }}
                      </p>
                      <div
                        role="group"
                        [attr.aria-labelledby]="'vendor-sync-' + side + '-label'"
                        [class]="productBoxClass"
                        [attr.data-testid]="'sync-create-chosen-' + side"
                      >
                        <aec-logo-or-initial
                          [claimStatus]="'stored'"
                          [src]="chosen.logo_url ?? null"
                          [name]="chosen.name"
                          size="sm"
                        />
                        <span
                          class="min-w-0 flex-1 truncate text-sm font-semibold text-(--text-primary)"
                          >{{ chosen.name }}</span
                        >
                        <button
                          aecButton
                          variant="secondary"
                          compact
                          type="button"
                          [disabled]="saving()"
                          [attr.aria-label]="changeAria(side, chosen.name)"
                          (click)="clearSide(side)"
                          i18n="@@vendor.syncCreate.change"
                        >
                          Change
                        </button>
                      </div>
                    } @else {
                      <label [for]="'vendor-sync-' + side" [class]="labelClass">{{
                        sideLabel(side)
                      }}</label>
                      <aec-product-combobox
                        [inputId]="'vendor-sync-' + side"
                        [search]="search"
                        [exclude]="excludedFor(side)"
                        [invalid]="showSideError(side)"
                        [describedBy]="
                          showSideError(side) ? 'vendor-sync-' + side + '-error' : null
                        "
                        (picked)="pick(side, $event)"
                        (announce)="announcer.announce($event)"
                      />
                      @if (showSideError(side)) {
                        <p
                          [id]="'vendor-sync-' + side + '-error'"
                          role="alert"
                          [class]="errorClass"
                        >
                          {{ pickProductMessage }}
                        </p>
                      }
                    }
                  </div>
                }
              </div>
            </fieldset>

            @for (group of groups; track group.key) {
              <fieldset [class]="fieldsetClass">
                <legend [class]="legendClass">{{ groupLabel(group.key) }}</legend>
                <div [class]="gridClass">
                  @for (field of group.fields; track field) {
                    <div
                      [class]="field === 'description' ? fieldClass + ' ' + spanClass : fieldClass"
                    >
                      <label [for]="fieldId(field)" [class]="labelClass">
                        {{ fieldLabel(field) }}
                        @if (!required(field)) {
                          <span [class]="optionalClass">{{ optionalLabel }}</span>
                        }
                      </label>
                      @if (field === 'description') {
                        <textarea
                          [id]="fieldId(field)"
                          rows="3"
                          [attr.maxlength]="maxLength(field)"
                          [value]="draft()[field]"
                          (input)="onInput(field, inputValue($event))"
                          [attr.aria-invalid]="showError(field) ? 'true' : null"
                          [attr.aria-describedby]="
                            showError(field) ? fieldId(field) + '-error' : null
                          "
                          [class]="inputClass"
                        ></textarea>
                      } @else if (field === 'direction') {
                        <div class="relative">
                          <select
                            [id]="fieldId(field)"
                            (change)="onInput(field, inputValue($event))"
                            [attr.aria-invalid]="showError(field) ? 'true' : null"
                            [attr.aria-describedby]="
                              showError(field) ? fieldId(field) + '-error' : null
                            "
                            [class]="selectClass"
                          >
                            @if (draft().direction === '') {
                              <option value="" disabled selected>{{ choosePlaceholder }}</option>
                            }
                            @for (option of directionOptions(); track option.value) {
                              <option
                                [value]="option.value"
                                [selected]="option.value === draft().direction"
                              >
                                {{ option.label }}
                              </option>
                            }
                          </select>
                          <span [class]="selectChevronClass">
                            <aec-icon name="chevron-down" decorative [size]="4" />
                          </span>
                        </div>
                      } @else {
                        <input
                          [id]="fieldId(field)"
                          [type]="isUrl(field) ? 'url' : 'text'"
                          [attr.inputmode]="isUrl(field) ? 'url' : null"
                          [attr.maxlength]="maxLength(field)"
                          [value]="draft()[field]"
                          (input)="onInput(field, inputValue($event))"
                          [attr.aria-invalid]="showError(field) ? 'true' : null"
                          [attr.aria-describedby]="
                            showError(field) ? fieldId(field) + '-error' : null
                          "
                          [class]="inputClass"
                        />
                      }
                      @if (showError(field)) {
                        <p [id]="fieldId(field) + '-error'" role="alert" [class]="errorClass">
                          {{ errorFor(field) }}
                        </p>
                      }
                    </div>
                  }
                </div>
              </fieldset>
            }

            <p
              class="mt-8 max-w-prose text-sm text-(--text-secondary)"
              i18n="@@vendor.syncCreate.told"
            >
              It goes live on the public site when you add it. The vendors of both products are told
              that you added it.
            </p>

            <div [class]="saveBarClass">
              <div [class]="saveStatusClass">
                @if (saveNotice(); as message) {
                  <p
                    role="alert"
                    class="font-semibold text-(--text-primary)"
                    data-testid="sync-create-notice"
                  >
                    {{ message }}
                  </p>
                }
              </div>
              <button
                aecButton
                type="submit"
                [class]="saveButtonClass"
                [disabled]="saving()"
                data-testid="sync-create-submit"
              >
                @if (saving()) {
                  <span i18n="@@vendor.syncCreate.saving">Adding…</span>
                } @else {
                  <span i18n="@@vendor.syncCreate.submit">Add integration</span>
                }
              </button>
              <button
                aecButton
                variant="secondary"
                type="button"
                [class]="saveButtonClass"
                [disabled]="saving()"
                (click)="close()"
                i18n="@@vendor.syncCreate.cancel"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      }
    </section>
  `,
})
export class VendorSyncServicePairCreate {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  protected readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** The Sync Service product whose tab this is. */
  readonly product = input.required<{ readonly id: string; readonly name: string }>();

  /**
   * AECI-2045 QA. On a `hybrid` Sync Service the tab also offers the ordinary create, so
   * each trigger says what it adds ("Add an integration {product} delivers"). A pure
   * Sync Service offers this one action, labelled "Add an integration".
   */
  readonly hybrid = input(false);

  protected readonly triggerLabel = computed(() => {
    if (!this.hybrid()) return $localize`:@@vendor.syncCreate.open:Add an integration`;
    const name = this.product().name;
    return $localize`:@@vendor.syncCreate.open.hybrid:Add an integration ${name}:name: delivers`;
  });

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly receipt = viewChild<ElementRef<HTMLDivElement>>('receipt');

  protected readonly sides: readonly Side[] = ['first', 'second'];
  protected readonly groups = PAIR_GROUPS;

  protected readonly open = signal(false);
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);
  protected readonly saveNotice = signal<string | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());
  protected readonly picked = signal<Record<Side, ProductComboboxItem | null>>({
    first: null,
    second: null,
  });
  protected readonly result = signal<{ publicPath: string } | null>(null);

  protected readonly search: ProductComboboxSearch = (query) => this.api.searchProducts(query);

  /** The Sync Service itself and the product already chosen on the other side. */
  protected excludedFor(side: Side): readonly string[] {
    const other = this.picked()[side === 'first' ? 'second' : 'first'];
    return other ? [this.product().id, other.id] : [this.product().id];
  }

  private readonly errors = computed<Partial<Record<PairField, string>>>(() => {
    const out: Partial<Record<PairField, string>> = {};
    const draft = this.draft();
    for (const field of PAIR_GROUPS.flatMap((group) => group.fields)) {
      const value = draft[field].trim();
      if (value === '') {
        if (this.attempted() && REQUIRED.has(field)) {
          out[field] = $localize`:@@vendor.syncCreate.error.required:This field is required.`;
        }
        continue;
      }
      const message = editValueMessage(field, value);
      if (message) out[field] = message;
    }
    return out;
  });

  protected readonly directionOptions = computed(() => {
    const first =
      this.picked().first?.name ??
      $localize`:@@vendor.syncCreate.firstPlaceholder:the first product`;
    const second =
      this.picked().second?.name ??
      $localize`:@@vendor.syncCreate.secondPlaceholder:the second product`;
    return [
      {
        value: 'outbound',
        label: $localize`:@@vendor.syncCreate.direction.outbound:${first}:first: sends data to ${second}:second:`,
      },
      {
        value: 'both',
        label: $localize`:@@vendor.syncCreate.direction.both:Both ways`,
      },
      {
        value: 'inbound',
        label: $localize`:@@vendor.syncCreate.direction.inbound:${second}:second: sends data to ${first}:first:`,
      },
    ];
  });

  protected readonly optionalLabel = $localize`:@@vendor.syncCreate.optional:(optional)`;
  protected readonly choosePlaceholder = $localize`:@@vendor.syncCreate.choose:Choose one`;
  protected readonly pickProductMessage = $localize`:@@vendor.syncCreate.error.pick:Choose a product from the list.`;

  protected sideLabel(side: Side): string {
    return side === 'first'
      ? $localize`:@@vendor.syncCreate.first:First product`
      : $localize`:@@vendor.syncCreate.second:Second product`;
  }

  protected changeAria(side: Side, name: string): string {
    return side === 'first'
      ? $localize`:@@vendor.syncCreate.changeFirst:Change the first product, ${name}:name:`
      : $localize`:@@vendor.syncCreate.changeSecond:Change the second product, ${name}:name:`;
  }

  protected showSideError(side: Side): boolean {
    return this.attempted() && this.picked()[side] === null;
  }

  protected groupLabel(key: (typeof EDIT_GROUPS)[number]['key']): string {
    switch (key) {
      case 'about':
        return $localize`:@@vendor.syncCreate.group.about:About the integration`;
      case 'links':
        return $localize`:@@vendor.syncCreate.group.links:Links`;
      case 'terms':
        return $localize`:@@vendor.syncCreate.group.terms:Pricing and maturity`;
    }
  }

  protected fieldLabel(field: PairField): string {
    return editFieldLabel(field);
  }

  protected required(field: PairField): boolean {
    return REQUIRED.has(field);
  }

  protected isUrl(field: PairField): boolean {
    return INTEGRATION_EDIT_URL_FIELDS.has(field);
  }

  protected maxLength(field: PairField): number {
    return INTEGRATION_EDIT_MAX_LENGTH[field];
  }

  protected fieldId(field: string): string {
    return `vendor-sync-create-${field}`;
  }

  protected errorFor(field: PairField): string | null {
    return this.errors()[field] ?? null;
  }

  protected showError(field: PairField): boolean {
    return this.errorFor(field) !== null;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  protected onInput(field: PairField, value: string): void {
    this.draft.update((current) => ({ ...current, [field]: value }));
    this.saveNotice.set(null);
  }

  protected pick(side: Side, product: ProductComboboxItem): void {
    this.picked.update((current) => ({ ...current, [side]: product }));
    this.saveNotice.set(null);
  }

  protected clearSide(side: Side): void {
    this.picked.update((current) => ({ ...current, [side]: null }));
    afterNextRender(() => document.getElementById(`vendor-sync-${side}`)?.focus(), {
      injector: this.injector,
    });
  }

  protected openForm(): void {
    this.result.set(null);
    this.open.set(true);
    afterNextRender(() => document.getElementById('vendor-sync-first')?.focus(), {
      injector: this.injector,
    });
  }

  protected close(): void {
    this.reset();
    this.focusTrigger();
  }

  protected dismiss(): void {
    this.result.set(null);
    this.focusTrigger();
  }

  private reset(): void {
    this.open.set(false);
    this.attempted.set(false);
    this.saveNotice.set(null);
    this.draft.set(emptyDraft());
    this.picked.set({ first: null, second: null });
  }

  private focusTrigger(): void {
    afterNextRender(() => this.trigger()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async onSubmit(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.saving()) return;
    this.attempted.set(true);
    this.saveNotice.set(null);
    const { first, second } = this.picked();
    if (!first || !second || Object.keys(this.errors()).length > 0) {
      this.saveNotice.set(
        $localize`:@@vendor.syncCreate.error.check:Check the fields marked above, then try again.`,
      );
      return;
    }
    const draft = this.draft();
    const body: CreateSyncServicePairInput = {
      connector_product_id: this.product().id,
      product_id: first.id,
      counterpart_product_id: second.id,
    };
    for (const field of PAIR_GROUPS.flatMap((group) => group.fields)) {
      const value = draft[field].trim();
      if (value !== '') body[field] = value;
    }
    this.saving.set(true);
    try {
      await this.api.createSyncServicePair(body);
      const [a, b] = orderedPairSlugs(first.slug, second.slug);
      this.reset();
      this.result.set({ publicPath: `/products/${a}/integrations/${b}` });
      this.announcer.announce(
        $localize`:@@vendor.syncCreate.live.created:Your integration is live on the public site.`,
      );
      await this.store.revalidate(['integrations']);
      afterNextRender(() => this.receipt()?.nativeElement.focus(), { injector: this.injector });
    } catch (err) {
      this.saveNotice.set(syncServicePairErrorMessage(err));
    } finally {
      this.saving.set(false);
    }
  }

  // AECI-2045 QA: the portal form layout (`vendor/shared/portal-form.ts`) and the shared
  // field recipe, as the ordinary create uses them (the Same-Behavior Rule).
  protected readonly formClass = PORTAL_FORM_CLASS;
  protected readonly fieldsetClass = PORTAL_FIELDSET_CLASS;
  protected readonly legendClass = PORTAL_LEGEND_CLASS;
  protected readonly gridClass = PORTAL_FORM_GRID_CLASS;
  protected readonly spanClass = PORTAL_FORM_SPAN_CLASS;
  protected readonly fieldClass = PORTAL_FIELD_CLASS;
  protected readonly saveBarClass = PORTAL_SAVE_BAR_CLASS;
  protected readonly saveStatusClass = PORTAL_SAVE_STATUS_CLASS;
  protected readonly saveButtonClass = PORTAL_SAVE_BUTTON_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly optionalClass = FIELD_OPTIONAL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly selectClass = `${FIELD_INPUT_CLASS} cursor-pointer appearance-none pe-12`;
  protected readonly selectChevronClass =
    'pointer-events-none absolute end-4 top-1/2 flex -translate-y-1/2 text-(--text-secondary)';
  protected readonly errorClass = `max-w-prose ${FIELD_ERROR_CLASS}`;
  /** A chosen product in a box: 44px, the control radius. */
  protected readonly productBoxClass =
    'flex min-h-11 items-center gap-3 rounded-control bg-(--surface-sunken) px-4 py-2';
  protected readonly publicLinkClass =
    'inline-flex items-center gap-1.5 rounded-mark text-sm font-medium text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}

/** The refusals `POST /api/vendor/sync-service-pairs` can answer, mapped to what to
 *  do next. */
export function syncServicePairErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'INTEGRATION_ALREADY_ON_RECORD': {
      const retired = info.details?.['retired'] === true;
      // AECI-2268: an AECi retire cannot be restored from the portal.
      if (retired && info.details?.['retired_by_aeci'] === true) {
        return $localize`:@@vendor.syncCreate.error.onRecordRetiredByAeci:This integration is already on record through your Sync Service, and AEC Integrations retired it. Only AEC Integrations can restore it. To ask about it, email support@aecintegrations.com.`;
      }
      return retired
        ? $localize`:@@vendor.syncCreate.error.onRecordRetired:This integration is already on record through your Sync Service, and it is retired. Restore it from the list below.`
        : $localize`:@@vendor.syncCreate.error.onRecord:This integration is already on record through your Sync Service. Look for it in the list below.`;
    }
    // AECI-2042: a vendor of one of the two products removed this pair from its product.
    case 'INTEGRATION_VETOED':
      return $localize`:@@vendor.syncCreate.error.vetoed.v2:A vendor of one of these products removed this integration from its product, so you cannot add it again. It returns if that vendor withdraws the removal. AEC Integrations can also end a removal in a few cases the Listing Accuracy Policy sets out.`;
    case 'CONNECTOR_NOT_SYNC_SERVICE':
      return $localize`:@@vendor.syncCreate.error.notSync:Only a Sync Service can add the integrations it delivers. Contact AEC Integrations to add this one.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.syncCreate.error.notFound:One of the products is not available to link. Search again and choose another result.`;
    case 'INTEGRATION_INVALID_VALUE':
      return $localize`:@@vendor.syncCreate.error.invalid:One of the values is not valid for its field. Check the form and try again.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.syncCreate.error.validation:Check the required fields, then try again.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.syncCreate.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.syncCreate.error.generic:Could not add the integration. Try again.`;
  }
}
