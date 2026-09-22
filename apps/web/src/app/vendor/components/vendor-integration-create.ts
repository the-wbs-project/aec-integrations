import {
  Component,
  ElementRef,
  InjectionToken,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import {
  CONTEST_VALUE_MAX_LENGTH,
  CreateVendorIntegrationSchema,
  INTEGRATION_EDIT_REQUIRED_FIELDS,
  OWNER_EDITABLE_MECHANISM_KINDS,
  type CreateVendorIntegrationInput,
  type IntegrationEditField,
  type PossibleDuplicateIntegration,
  type ProductListItem,
} from '@aeci/shared';

import { directionHeading } from '../../products/pair-direction-labels';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

import { contestFieldLabel } from './vendor-contest-labels';
import { EDIT_GROUPS } from './vendor-integration-ownership';
import { editValueMessage } from './vendor-integration-ownership-labels';

/**
 * Render the form open on first paint. Provided ONLY by the dev preview
 * (`/preview/vendor-dashboard/products/<slug>/integrations?create=open`), so `npx impeccable detect`, which reads
 * the first render, can see the form. Nothing in the product provides it.
 */
export const VENDOR_CREATE_FORM_START_OPEN = new InjectionToken<boolean>(
  'VENDOR_CREATE_FORM_START_OPEN',
);

type Draft = Record<IntegrationEditField, string>;

const URL_FIELDS: ReadonlySet<IntegrationEditField> = new Set([
  'listing_url',
  'docs_url',
  'website',
  'mechanism_url',
]);

function emptyDraft(): Draft {
  return Object.fromEntries(
    EDIT_GROUPS.flatMap((group) => group.fields).map((field) => [field, '']),
  ) as Draft;
}

/**
 * "Add an integration" on the Integrations tab (AECI-1011 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7 / §6.14).
 *
 * The vendor picks one of its own products, finds the other product by name, and
 * fills in the same standard fields the owner edit uses (`EDIT_GROUPS`, the same
 * labels and the same value rule), so "what an owner may write" reads identically
 * in both forms. The new row is the vendor's from the first moment: born claimed,
 * so promote never writes it, and it goes live with no review step.
 *
 * **Pessimistic.** Nothing changes on screen until the server answers `201`; then
 * the integrations list revalidates and the outcome is announced through the
 * portal's one live region. Duplicates never block (AECI-1003 decision 10): the
 * rows already on record for the chosen pair are listed before submit, from the
 * list the tab already holds, and the server's strong matches are listed after.
 *
 * The type picker leaves out the connector-delivered kinds, which the server
 * refuses (decision 9). Copy is plain; AECI-1023 owns the final wording.
 */
@Component({
  selector: 'aec-vendor-integration-create',
  styles: [':host { display: block; }'],
  template: `
    <div class="space-y-4" data-testid="integration-create">
      <div class="flex flex-wrap items-center gap-3">
        <button
          #trigger
          type="button"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="formId"
          (click)="toggle()"
          [class]="triggerClass"
          data-testid="add-integration"
          i18n="@@vendor.integrationCreate.trigger"
        >
          Add an integration
        </button>
        @if (!open()) {
          <p class="text-xs text-(--text-secondary)" i18n="@@vendor.integrationCreate.teaser">
            List an integration your company offers that is not on record yet.
          </p>
        }
      </div>

      @if (result(); as created) {
        <div
          class="max-w-3xl space-y-2 rounded-(--radius-md) border border-(--border-default) p-4"
          data-testid="create-result"
        >
          <p
            #resultHeading
            tabindex="-1"
            class="text-sm font-semibold text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@vendor.integrationCreate.done.title"
          >
            Your integration is live on the public site.
          </p>
          @if (created.duplicates.length > 0) {
            <p class="text-sm text-(--text-secondary)" i18n="@@vendor.integrationCreate.done.dupes">
              These integrations were already on record for the same two products. If one of them is
              the same integration, tell AEC Integrations through a contest on it, or retire the one
              you just added.
            </p>
            <ul class="space-y-1 text-sm text-(--text-primary)" data-testid="create-duplicates">
              @for (dup of created.duplicates; track dup.id) {
                <li>{{ duplicateLine(dup) }}</li>
              }
            </ul>
          }
          <button
            type="button"
            [class]="secondaryButtonClass"
            (click)="dismissResult()"
            i18n="@@vendor.integrationCreate.done.dismiss"
          >
            Dismiss
          </button>
        </div>
      }

      @if (open()) {
        <form
          [id]="formId"
          class="max-w-3xl space-y-6 rounded-(--radius-md) border border-(--border-default) p-5"
          novalidate
          (submit)="onSubmit($event)"
          aria-labelledby="vendor-create-title"
        >
          <div class="max-w-prose space-y-1">
            <p
              id="vendor-create-title"
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.integrationCreate.title"
            >
              Add an integration
            </p>
            <p
              class="max-w-prose text-xs text-(--text-secondary)"
              i18n="@@vendor.integrationCreate.intro"
            >
              Your company will own this integration. It goes live on the public integration page as
              soon as you add it, with no review step, and the other product's vendor is told.
            </p>
          </div>

          <fieldset class="space-y-4">
            <legend [class]="legendClass" i18n="@@vendor.integrationCreate.group.products">
              The two products
            </legend>

            <div class="max-w-2xl space-y-2">
              <label
                for="vendor-create-own"
                [class]="labelClass"
                i18n="@@vendor.integrationCreate.own.label"
                >Your product</label
              >
              <div class="relative max-w-sm">
                <select
                  id="vendor-create-own"
                  (change)="onOwnProduct(selectValue($event))"
                  [class]="selectClass"
                >
                  @for (product of ownProducts(); track product.id) {
                    <option [value]="product.id" [selected]="product.id === ownProductId()">
                      {{ product.name }}
                    </option>
                  }
                </select>
                <svg
                  class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
            </div>

            <div class="max-w-2xl space-y-2">
              <label
                for="vendor-create-search"
                [class]="labelClass"
                i18n="@@vendor.integrationCreate.search.label"
                >The other product</label
              >
              <div class="flex flex-wrap gap-2">
                <input
                  id="vendor-create-search"
                  type="search"
                  autocomplete="off"
                  [value]="query()"
                  (input)="onQuery(inputValue($event))"
                  (keydown.enter)="onSearch($event)"
                  aria-describedby="vendor-create-search-hint"
                  [class]="inputClass + ' max-w-sm flex-1'"
                />
                <button
                  type="button"
                  [class]="secondaryButtonClass"
                  [disabled]="searching()"
                  (click)="onSearch()"
                  data-testid="create-search"
                  i18n="@@vendor.integrationCreate.search.button"
                >
                  Search
                </button>
              </div>
              <p
                id="vendor-create-search-hint"
                class="max-w-prose text-xs text-(--text-secondary)"
                i18n="@@vendor.integrationCreate.search.hint"
              >
                Search the published catalogue by product name, then choose one result.
              </p>

              @if (searchNotice(); as notice) {
                <p class="text-sm text-(--text-primary)">{{ notice }}</p>
              }
              @if (results().length > 0) {
                <fieldset class="space-y-1" data-testid="create-results">
                  <legend class="sr-only" i18n="@@vendor.integrationCreate.results.legend">
                    Search results
                  </legend>
                  @for (product of results(); track product.id) {
                    <label
                      class="flex cursor-pointer items-center gap-3 rounded-(--radius-sm) px-2 py-1.5 text-sm text-(--text-primary) hover:bg-(--surface-sunken)"
                    >
                      <input
                        type="radio"
                        name="vendor-create-counterpart"
                        [value]="product.id"
                        [checked]="product.id === counterpart()?.id"
                        (change)="onCounterpart(product)"
                        class="accent-(--accent-primary)"
                      />
                      <span>{{ product.name }}</span>
                      @if (product.vendor; as vendor) {
                        <span class="text-xs text-(--text-secondary)">{{ vendor.name }}</span>
                      }
                    </label>
                  }
                </fieldset>
              }
              @if (showError('counterpart')) {
                <p id="vendor-create-counterpart-error" role="alert" [class]="errorClass">
                  {{ counterpartError() }}
                </p>
              }
            </div>

            @if (onRecord().length > 0) {
              <div
                class="max-w-prose space-y-1 rounded-(--radius-sm) bg-(--surface-sunken) p-3"
                data-testid="create-on-record"
              >
                <p class="text-xs font-semibold text-(--text-primary)">{{ onRecordLine() }}</p>
                <ul class="space-y-0.5 text-xs text-(--text-secondary)">
                  @for (row of onRecord(); track row.id) {
                    <li>{{ row.label }}</li>
                  }
                </ul>
              </div>
            }
          </fieldset>

          @for (group of groups; track group.key) {
            <fieldset class="space-y-4">
              <legend [class]="legendClass">{{ groupLabel(group.key) }}</legend>
              @for (field of group.fields; track field) {
                <div class="max-w-2xl space-y-2">
                  <label [for]="fieldId(field)" [class]="labelClass">
                    {{ fieldLabel(field) }}
                    @if (!required(field)) {
                      <span class="font-normal tracking-normal normal-case">{{
                        optionalLabel
                      }}</span>
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
                      [attr.aria-describedby]="showError(field) ? fieldId(field) + '-error' : null"
                      [class]="inputClass"
                    ></textarea>
                  } @else if (field === 'mechanism_kind' || field === 'direction') {
                    <div class="relative max-w-sm">
                      <select
                        [id]="fieldId(field)"
                        (change)="onInput(field, selectValue($event))"
                        [attr.aria-invalid]="showError(field) ? 'true' : null"
                        [attr.aria-describedby]="
                          showError(field) ? fieldId(field) + '-error' : null
                        "
                        [class]="selectClass"
                      >
                        @if (draft()[field] === '') {
                          <option value="" disabled selected>{{ choosePlaceholder }}</option>
                        }
                        @for (option of optionsFor(field); track option.value) {
                          <option
                            [value]="option.value"
                            [selected]="option.value === draft()[field]"
                          >
                            {{ option.label }}
                          </option>
                        }
                      </select>
                      <svg
                        class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
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
                      [attr.aria-describedby]="showError(field) ? fieldId(field) + '-error' : null"
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
            </fieldset>
          }

          <div class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4">
            <button
              type="submit"
              [class]="primaryButtonClass"
              [disabled]="saving()"
              data-testid="create-submit"
            >
              @if (saving()) {
                <span i18n="@@vendor.integrationCreate.saving">Adding…</span>
              } @else {
                <span i18n="@@vendor.integrationCreate.submit">Add integration</span>
              }
            </button>
            <button
              type="button"
              [class]="secondaryButtonClass"
              [disabled]="saving()"
              (click)="close()"
              i18n="@@vendor.integrationCreate.cancel"
            >
              Cancel
            </button>
          </div>

          @if (saveNotice(); as message) {
            <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ message }}</p>
          }
        </form>
      }
    </div>
  `,
})
export class VendorIntegrationCreate {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** The product the tab is filed under, preselected as "your product". */
  readonly contextProductId = input<string | null>(null);

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly resultHeading = viewChild<ElementRef<HTMLElement>>('resultHeading');

  protected readonly groups = EDIT_GROUPS;
  protected readonly formId = 'vendor-create-form';

  protected readonly open = signal(
    inject(VENDOR_CREATE_FORM_START_OPEN, { optional: true }) ?? false,
  );
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);
  protected readonly saveNotice = signal<string | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());

  private readonly chosenOwn = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly searching = signal(false);
  protected readonly searchNotice = signal<string | null>(null);
  protected readonly results = signal<readonly ProductListItem[]>([]);
  protected readonly counterpart = signal<ProductListItem | null>(null);

  protected readonly result = signal<{
    id: string;
    duplicates: readonly PossibleDuplicateIntegration[];
  } | null>(null);

  protected readonly optionalLabel = $localize`:@@vendor.integrationCreate.optional:(optional)`;
  protected readonly choosePlaceholder = $localize`:@@vendor.integrationCreate.choose:Choose a value`;

  protected readonly ownProducts = computed(() => this.store.me()?.products ?? []);

  protected readonly ownProductId = computed(() => {
    const products = this.ownProducts();
    const chosen = this.chosenOwn();
    if (chosen && products.some((p) => p.id === chosen)) return chosen;
    const context = this.contextProductId();
    if (context && products.some((p) => p.id === context)) return context;
    return products[0]?.id ?? null;
  });

  /** Every integration already on record for the chosen pair, from the list the
   *  tab holds. Context before submit, never a block. */
  protected readonly onRecord = computed(() => {
    const own = this.ownProductId();
    const other = this.counterpart()?.id;
    if (!own || !other) return [];
    const seen = new Set<string>();
    const rows: { id: string; label: string }[] = [];
    for (const entry of this.store.integrations() ?? []) {
      if (entry.context_product.id !== own || entry.other_product.id !== other) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const name = entry.name ?? entry.mechanism_name ?? mechanismKindLabel(entry.mechanism_kind);
      const owner = entry.owner?.name;
      rows.push({
        id: entry.id,
        label: owner
          ? $localize`:@@vendor.integrationCreate.onRecord.owned:${name}:name:, offered by ${owner}:owner:`
          : (name ?? ''),
      });
    }
    return rows;
  });

  protected readonly onRecordLine = computed(() => {
    const count = this.onRecord().length;
    return $localize`:@@vendor.integrationCreate.onRecord.title:Already on record for these two products (${count}:count:). You can still add yours.`;
  });

  /** The per-field problems, in the vendor's words. Required fields are checked
   *  only after a submit attempt, so an empty form does not open covered in red. */
  private readonly errors = computed<Partial<Record<IntegrationEditField, string>>>(() => {
    const out: Partial<Record<IntegrationEditField, string>> = {};
    const draft = this.draft();
    for (const field of EDIT_GROUPS.flatMap((group) => group.fields)) {
      const value = draft[field].trim();
      if (value === '') {
        if (this.attempted() && this.required(field)) {
          out[field] =
            $localize`:@@vendor.integrationCreate.error.required:This field is required.`;
        }
        continue;
      }
      const message = editValueMessage(field, value);
      if (message) out[field] = message;
    }
    return out;
  });

  protected readonly counterpartError = computed(() =>
    this.attempted() && !this.counterpart()
      ? $localize`:@@vendor.integrationCreate.error.counterpart:Search for the other product and choose one result.`
      : null,
  );

  protected toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.reset();
    this.result.set(null);
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
    this.saveNotice.set(null);
    this.trigger()?.nativeElement.focus();
  }

  protected dismissResult(): void {
    this.result.set(null);
    this.trigger()?.nativeElement.focus();
  }

  private reset(): void {
    this.draft.set(emptyDraft());
    this.attempted.set(false);
    this.saveNotice.set(null);
    this.query.set('');
    this.results.set([]);
    this.searchNotice.set(null);
    this.counterpart.set(null);
  }

  protected onOwnProduct(id: string): void {
    this.chosenOwn.set(id);
    // The counterpart cannot be the product itself.
    if (this.counterpart()?.id === id) this.counterpart.set(null);
  }

  protected onQuery(value: string): void {
    this.query.set(value);
  }

  protected async onSearch(event?: Event): Promise<void> {
    // Enter in the search box must search, not submit the whole form.
    event?.preventDefault();
    const query = this.query().trim();
    if (query.length < 2) {
      this.searchNotice.set(
        $localize`:@@vendor.integrationCreate.search.short:Type at least two letters of the product name.`,
      );
      return;
    }
    this.searching.set(true);
    this.searchNotice.set(null);
    try {
      const page = await this.api.searchProducts(query);
      const own = this.ownProductId();
      const items = page.data.filter((product) => product.id !== own);
      this.results.set(items);
      this.searchNotice.set(
        items.length === 0
          ? $localize`:@@vendor.integrationCreate.search.none:No published product matches that name.`
          : null,
      );
      this.announcer.announce(
        $localize`:@@vendor.integrationCreate.search.live:${items.length}:count: products found.`,
      );
    } catch {
      this.searchNotice.set(
        $localize`:@@vendor.integrationCreate.search.failed:The search did not work. Try again.`,
      );
    } finally {
      this.searching.set(false);
    }
  }

  protected onCounterpart(product: ProductListItem): void {
    this.counterpart.set(product);
  }

  protected onInput(field: IntegrationEditField, value: string): void {
    this.draft.update((current) => ({ ...current, [field]: value }));
    this.saveNotice.set(null);
  }

  protected errorFor(field: IntegrationEditField): string | null {
    return this.errors()[field] ?? null;
  }

  protected showError(field: IntegrationEditField | 'counterpart'): boolean {
    if (field === 'counterpart') return this.counterpartError() !== null;
    return this.errorFor(field) !== null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.attempted.set(true);
    this.saveNotice.set(null);

    const own = this.ownProductId();
    const other = this.counterpart();
    if (!own || !other || Object.keys(this.errors()).length > 0) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationCreate.error.fix:Fix the fields marked above, then try again.`,
      );
      return;
    }

    const body: CreateVendorIntegrationInput = {
      product_id: own,
      counterpart_product_id: other.id,
    };
    for (const [field, value] of Object.entries(this.draft()) as [IntegrationEditField, string][]) {
      if (value.trim() !== '') body[field] = value.trim();
    }
    if (!CreateVendorIntegrationSchema.safeParse(body).success) {
      this.saveNotice.set(
        $localize`:@@vendor.integrationCreate.error.shape:Check the values, then try again.`,
      );
      return;
    }

    this.saving.set(true);
    try {
      const response = await this.api.createIntegration(body);
      this.saving.set(false);
      this.open.set(false);
      this.result.set({ id: response.integration.id, duplicates: response.possible_duplicates });
      this.announcer.announce(
        response.possible_duplicates.length > 0
          ? $localize`:@@vendor.integrationCreate.live.doneDupes:Your integration is live. Some integrations were already on record for the same two products.`
          : $localize`:@@vendor.integrationCreate.live.done:Your integration is live on the public site.`,
      );
      void this.store.revalidate(['integrations']);
      afterNextRender(() => this.resultHeading()?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.saving.set(false);
      this.saveNotice.set(createErrorMessage(err));
    }
  }

  protected duplicateLine(dup: PossibleDuplicateIntegration): string {
    const name = dup.name ?? dup.mechanism_name ?? mechanismKindLabel(dup.mechanism_kind) ?? '';
    const owner = dup.owner?.name;
    if (dup.retired) {
      return $localize`:@@vendor.integrationCreate.dup.retired:${name}:name: (retired)`;
    }
    return owner
      ? $localize`:@@vendor.integrationCreate.dup.owned:${name}:name:, offered by ${owner}:owner:`
      : $localize`:@@vendor.integrationCreate.dup.noOwner:${name}:name:, no owner on file`;
  }

  protected groupLabel(key: (typeof EDIT_GROUPS)[number]['key']): string {
    switch (key) {
      case 'about':
        return $localize`:@@vendor.integrationCreate.group.about:About the integration`;
      case 'links':
        return $localize`:@@vendor.integrationCreate.group.links:Links`;
      case 'terms':
        return $localize`:@@vendor.integrationCreate.group.terms:Pricing and maturity`;
    }
  }

  protected fieldLabel(field: IntegrationEditField): string {
    return contestFieldLabel(field);
  }

  protected required(field: IntegrationEditField): boolean {
    return INTEGRATION_EDIT_REQUIRED_FIELDS.has(field);
  }

  protected isUrl(field: IntegrationEditField): boolean {
    return URL_FIELDS.has(field);
  }

  protected maxLength(field: IntegrationEditField): number {
    return CONTEST_VALUE_MAX_LENGTH[field];
  }

  protected optionsFor(field: IntegrationEditField): readonly { value: string; label: string }[] {
    if (field === 'mechanism_kind') {
      return OWNER_EDITABLE_MECHANISM_KINDS.map((kind) => ({
        value: kind,
        label: mechanismKindLabel(kind) || kind,
      }));
    }
    const other =
      this.counterpart()?.name ??
      $localize`:@@vendor.integrationCreate.otherPlaceholder:the other product`;
    return (['outbound', 'both', 'inbound'] as const).map((direction) => ({
      value: direction,
      label: directionHeading(direction, other),
    }));
  }

  protected fieldId(field: string): string {
    return `vendor-create-${field}`;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected readonly triggerClass =
    'inline-flex items-center rounded-(--radius-md) border border-(--border-strong) px-4 py-2 text-sm font-semibold text-(--text-primary) transition-colors hover:border-(--accent-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly selectClass =
    'w-full cursor-pointer appearance-none rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) py-2 pe-9 ps-3 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly legendClass = 'mb-3 text-sm font-semibold text-(--text-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly errorClass = 'max-w-prose text-xs font-medium text-(--text-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}

/** The refusals `POST /api/vendor/integrations` can answer, mapped to what to do
 *  next. */
export function createErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'NOT_FOUND':
      return $localize`:@@vendor.integrationCreate.error.notFound:One of the two products is not available to link. Search again and choose another result.`;
    case 'INTEGRATION_INVALID_VALUE':
      return $localize`:@@vendor.integrationCreate.error.invalid:One of the values is not valid for its field. Check the form and try again.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.integrationCreate.error.validation:Check the required fields, then try again.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.integrationCreate.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.integrationCreate.error.generic:Could not add the integration. Try again.`;
  }
}
