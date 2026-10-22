import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  type OnInit,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  CreateVendorProductSchema,
  VENDOR_PRODUCT_NAME_MAX,
  type CreateVendorProductInput,
  type TaxonomyResponse,
  type VendorProductDuplicate,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

import { VENDOR_CREATE_FORM_START_OPEN } from './vendor-integration-create';
import { VendorLogoField, type SaveLogo } from './vendor-logo-field';

/** The text fields, in form order. The logo and categories have their own controls. */
const TEXT_FIELDS = ['name', 'description', 'website'] as const;
type TextField = (typeof TEXT_FIELDS)[number];
type Draft = Record<TextField, string>;

const MAX: Readonly<Record<TextField, number>> = {
  name: VENDOR_PRODUCT_NAME_MAX,
  description: 2000,
  website: 2048,
};

/** `termSlugList`'s cap on the create body. */
export const MAX_CREATE_CATEGORIES = 10;

function emptyDraft(): Draft {
  return { name: '', description: '', website: '' };
}

/** What the form-level alert says. `notOwned` carries a link, so the template
 *  renders it rather than a plain string. */
export type ProductCreateNotice = { kind: 'notOwned' } | { kind: 'text'; text: string };

/**
 * "Add a product" on the Products tab (AECI-1424, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §4.8). An owner seat adds a product to its own company through
 * `POST /api/vendor/products`. The product is the company's from the first moment.
 *
 * Owner seats only: the list page mounts this only when `me.seat_owner` is true,
 * and the server refuses a member with a `403` regardless.
 *
 * **Pessimistic.** Nothing changes on screen until the server answers `201`; then
 * the products scope revalidates and the outcome is announced through the portal's
 * one live region. A same-name product or proposal never blocks the create: the
 * server's `possible_duplicates` are listed after, as a warning.
 *
 * The logo control is the portal's own dialog ({@link VendorLogoField}). Its save
 * here only holds the value until the form is submitted.
 *
 * `?create=open` (read from the route snapshot in `ngOnInit`, so the server's first
 * paint has the form open) and the preview's {@link VENDOR_CREATE_FORM_START_OPEN}
 * token both start the form open. The param is removed after hydration so the
 * trigger works again on the same tab.
 */
@Component({
  selector: 'aec-vendor-product-create',
  imports: [RouterLink, VendorLogoField],
  styles: [':host { display: block; }'],
  template: `
    <div class="space-y-4" data-testid="product-create">
      <div class="flex flex-wrap items-center gap-3">
        <button
          #trigger
          type="button"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="formId"
          (click)="toggle()"
          [class]="triggerClass"
          data-testid="add-product"
          i18n="@@vendor.productCreate.trigger"
        >
          Add a product
        </button>
        @if (!open()) {
          <p class="text-xs text-(--text-secondary)" i18n="@@vendor.productCreate.teaser">
            List a product your company makes that is not on the site yet.
          </p>
        }
      </div>

      @if (result(); as created) {
        <div
          class="max-w-3xl space-y-2 rounded-(--radius-md) border border-(--border-default) p-4"
          data-testid="product-create-result"
        >
          <p
            #resultHeading
            tabindex="-1"
            class="text-sm font-semibold text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          >
            {{ doneLine(created.name) }}
          </p>
          <a [routerLink]="[created.slug]" [class]="linkClass" data-testid="product-create-open">{{
            openLine(created.name)
          }}</a>
          @if (created.duplicates.length > 0) {
            <div class="space-y-1 pt-1" data-testid="product-create-duplicates">
              <p class="text-sm text-(--text-primary)" i18n="@@vendor.productCreate.dupes.title">
                Something with the same name was already on record. Both stay as they are.
              </p>
              <ul class="list-disc space-y-1 ps-5 text-sm text-(--text-secondary)">
                @for (dup of created.duplicates; track dup.kind + dup.id) {
                  <li>{{ duplicateLine(dup) }}</li>
                }
              </ul>
            </div>
          }
          <button
            type="button"
            [class]="secondaryButtonClass"
            (click)="dismissResult()"
            i18n="@@vendor.productCreate.done.dismiss"
          >
            Dismiss
          </button>
        </div>
      }

      @if (open()) {
        <div
          [id]="formId"
          role="group"
          aria-labelledby="vendor-product-create-title"
          class="max-w-3xl rounded-(--radius-md) border border-(--border-default) p-5"
          data-testid="product-create-panel"
        >
          <form
            class="space-y-5"
            novalidate
            (submit)="onSubmit($event)"
            aria-labelledby="vendor-product-create-title"
            data-testid="product-create-form"
          >
            <div class="max-w-prose space-y-1">
              <p
                id="vendor-product-create-title"
                class="text-sm font-semibold text-(--text-primary)"
                i18n="@@vendor.productCreate.title"
              >
                Add a product
              </p>
              <p class="text-xs text-(--text-secondary)" i18n="@@vendor.productCreate.intro">
                Your company will own this product. It is listed on the public site as soon as you
                add it.
              </p>
            </div>

            @for (field of textFields; track field) {
              <div class="max-w-2xl space-y-2">
                <label [for]="fieldId(field)" [class]="labelClass">
                  {{ fieldLabel(field) }}
                  @if (field !== 'name') {
                    <span class="font-normal tracking-normal normal-case">{{ optionalLabel }}</span>
                  }
                </label>
                @if (field === 'description') {
                  <textarea
                    [id]="fieldId(field)"
                    rows="3"
                    [attr.maxlength]="max(field)"
                    [value]="draft()[field]"
                    (input)="onInput(field, inputValue($event))"
                    [attr.aria-invalid]="errorFor(field) ? 'true' : null"
                    [attr.aria-describedby]="errorFor(field) ? fieldId(field) + '-error' : null"
                    [class]="inputClass"
                  ></textarea>
                } @else {
                  <input
                    [id]="fieldId(field)"
                    [type]="field === 'website' ? 'url' : 'text'"
                    [attr.inputmode]="field === 'website' ? 'url' : null"
                    [attr.placeholder]="field === 'website' ? 'https://' : null"
                    [attr.maxlength]="max(field)"
                    [value]="draft()[field]"
                    (input)="onInput(field, inputValue($event))"
                    [attr.aria-invalid]="errorFor(field) ? 'true' : null"
                    [attr.aria-describedby]="errorFor(field) ? fieldId(field) + '-error' : null"
                    [attr.aria-required]="field === 'name' ? 'true' : null"
                    [class]="inputClass"
                  />
                }
                @if (errorFor(field); as message) {
                  <p [id]="fieldId(field) + '-error'" role="alert" [class]="errorClass">
                    {{ message }}
                  </p>
                }
              </div>
            }

            <aec-vendor-logo-field
              fieldId="vendor-product-create-logo"
              [logoUrl]="logoUrl()"
              [save]="holdLogo"
              [savedMessage]="logoHeldMessage"
              [removedMessage]="logoClearedMessage"
              (announce)="announcer.announce($event)"
            />

            <fieldset class="space-y-2" aria-describedby="vendor-product-create-categories-hint">
              <legend [class]="labelClass">
                <span i18n="@@vendor.productCreate.field.categories">Categories</span>
                <span class="ms-1 font-normal tracking-normal normal-case">{{
                  optionalLabel
                }}</span>
              </legend>
              <p
                id="vendor-product-create-categories-hint"
                class="max-w-prose text-xs text-(--text-secondary)"
              >
                {{ categoriesHint() }}
              </p>
              @if (categories(); as list) {
                <div class="max-h-72 max-w-2xl overflow-y-auto border-y border-(--border-default)">
                  <ul data-testid="product-create-categories">
                    @for (term of list; track term.slug) {
                      <li class="border-b border-(--border-default) last:border-b-0">
                        <label [class]="rowLabelClass(term.slug)">
                          <input
                            type="checkbox"
                            class="mt-0.5 h-4 w-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                            [checked]="chosen().has(term.slug)"
                            [disabled]="!togglable(term.slug)"
                            (change)="onCategory(term.slug, $event)"
                          />
                          <span class="text-sm font-medium text-(--text-primary)">{{
                            term.name
                          }}</span>
                        </label>
                      </li>
                    }
                  </ul>
                </div>
              } @else if (taxonomyFailed()) {
                <div class="flex flex-wrap items-center gap-3">
                  <p
                    class="text-sm text-(--text-primary)"
                    i18n="@@vendor.productCreate.categories.failed"
                  >
                    Could not load the categories. You can add the product without them.
                  </p>
                  <button
                    type="button"
                    [class]="secondaryButtonClass"
                    (click)="loadTaxonomy()"
                    i18n="@@vendor.productCreate.categories.retry"
                  >
                    Try again
                  </button>
                </div>
              } @else {
                <p
                  class="text-sm text-(--text-secondary)"
                  i18n="@@vendor.productCreate.categories.loading"
                >
                  Loading categories…
                </p>
              }
            </fieldset>

            <p
              class="max-w-prose text-sm text-(--text-secondary)"
              data-testid="product-create-later"
              i18n="@@vendor.productCreate.later"
            >
              Trades, audiences, phases and "How teams use it" are added on the product's own tabs
              once it is listed.
            </p>

            <div class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4">
              <button
                type="submit"
                [class]="primaryButtonClass"
                [disabled]="saving()"
                data-testid="product-create-submit"
              >
                @if (saving()) {
                  <span i18n="@@vendor.productCreate.saving">Adding…</span>
                } @else {
                  <span i18n="@@vendor.productCreate.submit">Add product</span>
                }
              </button>
              <button
                type="button"
                [class]="secondaryButtonClass"
                [disabled]="saving()"
                (click)="close()"
                data-testid="product-create-cancel"
                i18n="@@vendor.productCreate.cancel"
              >
                Cancel
              </button>
            </div>

            @if (notice(); as n) {
              <p
                role="alert"
                class="text-sm font-medium text-(--text-primary)"
                data-testid="product-create-notice"
              >
                @if (n.kind === 'notOwned') {
                  <span i18n="@@vendor.productCreate.error.notOwned"
                    >Your company does not own its records yet, so it cannot add a product from
                    here.
                    <a
                      routerLink="/contact"
                      [class]="linkClass"
                      data-testid="product-create-contact"
                      >Contact us</a
                    >
                    to change that.</span
                  >
                } @else {
                  {{ n.text }}
                }
              </p>
            }
          </form>
        </div>
      }
    </div>
  `,
})
export class VendorProductCreate implements OnInit {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  protected readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** Read `?create=open` from the route. Only the routed Products tab turns it on. */
  readonly deepLink = input(false);

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly resultHeading = viewChild<ElementRef<HTMLElement>>('resultHeading');

  protected readonly formId = 'vendor-product-create-form';
  protected readonly textFields = TEXT_FIELDS;

  protected readonly open = signal(
    inject(VENDOR_CREATE_FORM_START_OPEN, { optional: true }) ?? false,
  );
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);
  protected readonly notice = signal<ProductCreateNotice | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());
  protected readonly logoUrl = signal<string | null>(null);
  protected readonly chosen = signal<ReadonlySet<string>>(new Set());
  protected readonly result = signal<{
    name: string;
    slug: string;
    duplicates: readonly VendorProductDuplicate[];
  } | null>(null);

  private readonly taxonomy = signal<TaxonomyResponse | null>(null);
  protected readonly taxonomyFailed = signal(false);
  private destroyed = false;

  protected readonly categories = computed(() => {
    const taxonomy = this.taxonomy();
    if (!taxonomy) return null;
    return [...taxonomy.categories].sort((a, b) => compareText(a.name, b.name));
  });

  protected readonly optionalLabel = $localize`:@@vendor.productCreate.optional:(optional)`;
  protected readonly logoHeldMessage = $localize`:@@vendor.productCreate.logo.held:Logo chosen. It is saved when you add the product.`;
  protected readonly logoClearedMessage = $localize`:@@vendor.productCreate.logo.cleared:Logo removed from the new product.`;

  protected readonly categoriesHint = computed(() => {
    const count = this.chosen().size;
    const max = MAX_CREATE_CATEGORIES;
    return $localize`:@@vendor.productCreate.categories.hint:Choose up to ${max}:MAX: categories. ${count}:COUNT: chosen.`;
  });

  /** The field problems, in the portal's words, never Zod's. Shown only after a
   *  submit attempt, so an empty form does not open covered in red. */
  private readonly errors = computed<Partial<Record<TextField, string>>>(() => {
    if (!this.attempted()) return {};
    const draft = this.draft();
    const out: Partial<Record<TextField, string>> = {};
    if (draft.name.trim() === '') {
      out.name = $localize`:@@vendor.productCreate.error.name:Enter the product name.`;
    }
    const website = draft.website.trim();
    if (website !== '' && !CreateVendorProductSchema.shape.website.safeParse(website).success) {
      out.website = $localize`:@@vendor.productCreate.error.website:Use a full link that starts with https://, or leave it blank.`;
    }
    return out;
  });

  /** Hold the logo until submit. The dialog's own "saved" copy is swapped for
   *  {@link logoHeldMessage}, so it never claims the listing changed. */
  protected readonly holdLogo: SaveLogo = async (value) => {
    this.logoUrl.set(value);
    return value;
  };

  ngOnInit(): void {
    // The server's first paint: `?create=open` opens the form before hydration.
    if (this.deepLink() && this.route.snapshot.queryParamMap.get('create') === 'open') {
      this.open.set(true);
    }
  }

  constructor() {
    this.destroyRef.onDestroy(() => (this.destroyed = true));
    afterNextRender(() => {
      // Browser-only: the taxonomy is a public read, fetched after hydration.
      void this.loadTaxonomy();
      if (this.deepLink() && this.route.snapshot.queryParamMap.get('create') === 'open') {
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { create: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      }
    });
  }

  async loadTaxonomy(): Promise<void> {
    this.taxonomyFailed.set(false);
    try {
      const taxonomy = await this.api.getTaxonomy();
      if (!this.destroyed) this.taxonomy.set(taxonomy);
    } catch {
      if (!this.destroyed) this.taxonomyFailed.set(true);
    }
  }

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
    this.notice.set(null);
    this.trigger()?.nativeElement.focus();
  }

  protected dismissResult(): void {
    this.result.set(null);
    this.trigger()?.nativeElement.focus();
  }

  private reset(): void {
    this.draft.set(emptyDraft());
    this.logoUrl.set(null);
    this.chosen.set(new Set());
    this.attempted.set(false);
    this.notice.set(null);
  }

  protected onInput(field: TextField, value: string): void {
    this.draft.update((current) => ({ ...current, [field]: value }));
    this.notice.set(null);
  }

  protected onCategory(slug: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.chosen.update((current) => {
      const next = new Set(current);
      if (checked) next.add(slug);
      else next.delete(slug);
      return next;
    });
    this.notice.set(null);
  }

  protected togglable(slug: string): boolean {
    return this.chosen().has(slug) || this.chosen().size < MAX_CREATE_CATEGORIES;
  }

  protected rowLabelClass(slug: string): string {
    const base = 'flex items-start gap-3 px-4 py-2.5 transition-colors';
    return this.togglable(slug) ? `${base} cursor-pointer hover:bg-(--surface-sunken)` : base;
  }

  protected errorFor(field: TextField): string | null {
    return this.errors()[field] ?? null;
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.attempted.set(true);
    this.notice.set(null);

    if (Object.keys(this.errors()).length > 0) {
      this.notice.set({
        kind: 'text',
        text: $localize`:@@vendor.productCreate.error.fix:Fix the fields marked above, then try again.`,
      });
      return;
    }

    const draft = this.draft();
    const body: CreateVendorProductInput = { name: draft.name.trim() };
    if (draft.description.trim() !== '') body.description = draft.description.trim();
    if (draft.website.trim() !== '') body.website = draft.website.trim();
    const logo = this.logoUrl()?.trim();
    if (logo) body.logo_url = logo;
    // Taxonomy order, so the body does not depend on click order.
    const slugs = (this.categories() ?? [])
      .map((term) => term.slug)
      .filter((slug) => this.chosen().has(slug));
    if (slugs.length > 0) body.category_slugs = slugs;

    if (!CreateVendorProductSchema.safeParse(body).success) {
      this.notice.set({
        kind: 'text',
        text: $localize`:@@vendor.productCreate.error.shape:Check the values, then try again.`,
      });
      return;
    }

    this.saving.set(true);
    try {
      const response = await this.api.createProduct(body);
      this.saving.set(false);
      this.open.set(false);
      const { name, slug } = response.product;
      this.result.set({ name, slug, duplicates: response.possible_duplicates });
      this.announcer.announce(
        response.possible_duplicates.length > 0
          ? $localize`:@@vendor.productCreate.live.doneDupes:${name}:NAME: was added to your listing. Something with the same name was already on record.`
          : this.doneLine(name),
      );
      void this.store.revalidate(['products']);
      afterNextRender(() => this.resultHeading()?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.saving.set(false);
      this.notice.set(productCreateErrorNotice(err));
    }
  }

  protected doneLine(name: string): string {
    return $localize`:@@vendor.productCreate.done.title:${name}:NAME: was added to your listing.`;
  }

  protected openLine(name: string): string {
    return $localize`:@@vendor.productCreate.done.open:Open ${name}:NAME:`;
  }

  protected duplicateLine(dup: VendorProductDuplicate): string {
    const name = dup.name;
    return dup.kind === 'product'
      ? $localize`:@@vendor.productCreate.dup.product:A product named ${name}:NAME: is already listed.`
      : $localize`:@@vendor.productCreate.dup.proposal:A proposed product named ${name}:NAME: is waiting on the Proposed products tab.`;
  }

  protected fieldLabel(field: TextField): string {
    switch (field) {
      case 'name':
        return $localize`:@@vendor.productCreate.field.name:Product name`;
      case 'description':
        return $localize`:@@vendor.productCreate.field.description:Description`;
      case 'website':
        return $localize`:@@vendor.productCreate.field.website:Website`;
    }
  }

  protected fieldId(field: TextField): string {
    return `vendor-product-create-${field}`;
  }

  protected max(field: TextField): number {
    return MAX[field];
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected readonly triggerClass =
    'inline-flex items-center rounded-(--radius-md) border border-(--border-strong) px-4 py-2 text-sm font-semibold text-(--text-primary) transition-colors hover:border-(--accent-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly errorClass = 'max-w-prose text-xs font-medium text-(--text-primary)';
  protected readonly linkClass =
    'inline-block rounded-(--radius-sm) text-sm font-medium text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}

/** The refusals `POST /api/vendor/products` can answer, mapped to what to do next. */
export function productCreateErrorNotice(err: unknown): ProductCreateNotice {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'VENDOR_NOT_OWNED':
      return { kind: 'notOwned' };
    case 'SLUG_CONFLICT':
      return {
        kind: 'text',
        text: $localize`:@@vendor.productCreate.error.slug:Another product took this name at the same moment. Try again.`,
      };
    case 'VALIDATION_FAILED':
      return {
        kind: 'text',
        text: $localize`:@@vendor.productCreate.error.validation:Check the fields, then try again.`,
      };
  }
  switch (info?.status) {
    case 403:
      return {
        kind: 'text',
        text: $localize`:@@vendor.productCreate.error.forbidden:Only account owners can add a product.`,
      };
    case 429:
      return {
        kind: 'text',
        text: $localize`:@@vendor.productCreate.error.rate:Too many changes in a short time. Wait a minute and try again.`,
      };
  }
  return {
    kind: 'text',
    text: $localize`:@@vendor.productCreate.error.generic:Could not add the product. Try again.`,
  };
}
