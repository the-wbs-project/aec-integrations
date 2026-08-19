import { Component, OnInit, computed, inject, input, signal } from '@angular/core';

import {
  UpdateVendorProductSchema,
  type TaxonomyResponse,
  type TaxonomyTermWithCount,
  type UpdateVendorProductInput,
  type VendorProduct,
} from '@aeci/shared';

import { VendorApi } from '../vendor-api';

type ProductTextKey =
  | 'description'
  | 'website'
  | 'tool_integrations_url'
  | 'api_docs_url'
  | 'logo_url';
type FacetKey = 'category_slugs' | 'audience_slugs' | 'phase_slugs';
type Control = 'url' | 'textarea';

interface FieldConfig {
  readonly key: ProductTextKey;
  readonly label: string;
  readonly control: Control;
}

interface FacetConfig {
  readonly key: FacetKey;
  readonly legend: string;
}

/** The taxonomy endpoint caps each facet assignment at 10 terms (`termSlugList`). */
const MAX_TERMS_PER_FACET = 10;

/**
 * Edit-owned-product form for the vendor dashboard (AECI-522), backed by
 * `PATCH /api/vendor/products/:id` (AECI-520). Renders the vendor-editable
 * allow-list only — `name`/`slug` are AECi-owned (a rename breaks the URL, the
 * Algolia record, and every inbound link, so it stays a correction request) and
 * are shown read-only with a hint.
 *
 * Taxonomy is assigned by toggling the existing category/audience/phase terms
 * (vendors assign existing terms only — minting a term is an AECi curation act,
 * so an unknown slug is a 400 server-side). The chips are `aria-pressed` toggle
 * buttons (state conveyed by pressed-state AND the label, never colour alone),
 * fed by `GET /api/taxonomy`. Taxonomy arrays are full-set replacement on save.
 *
 * Validation is the shared `UpdateVendorProductSchema` (single source of truth,
 * client + server); only changed fields are sent (the endpoint requires ≥1). The
 * PATCH echo re-seeds the baseline so the form settles clean. The confirmation
 * must NOT promise instant search — edits reach Algolia on the nightly sync
 * (≤24h) while SSR repaints immediately (AECI-529).
 */
@Component({
  selector: 'aec-vendor-product-form',
  template: `
    <div class="space-y-6">
      <!-- Read-only identity: rename is a correction request, not a vendor edit. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4">
        <p class="font-display text-lg text-(--text-primary)">{{ product().name }}</p>
        <p class="mt-1 text-xs text-(--text-secondary)">
          <span class="font-mono">/{{ product().slug }}</span>
        </p>
        <p class="mt-2 text-xs text-(--text-secondary)" i18n="@@vendor.product.renameHint">
          To change the product name, file a correction request. Renaming would break its links and
          search entry.
        </p>
      </div>

      <form class="space-y-6" novalidate (submit)="$event.preventDefault(); onSave()">
        @if (!canEdit()) {
          <p
            class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.product.readOnly"
          >
            Editing is paused while your verification is not active. This product stays published
            exactly as it is, and everything on record is here to read. The verification panel on
            your dashboard has the renewal path.
          </p>
        }

        @for (cfg of textFields; track cfg.key) {
          <div class="space-y-1.5">
            <label [for]="fieldId(cfg.key)" [class]="labelClass">{{ cfg.label }}</label>
            @if (cfg.control === 'textarea') {
              <textarea
                [id]="fieldId(cfg.key)"
                rows="4"
                [value]="model()[cfg.key]"
                [readOnly]="!canEdit()"
                (input)="onInput(cfg.key, $event)"
                [attr.aria-invalid]="fieldErrors()[cfg.key] ? 'true' : null"
                [attr.aria-describedby]="
                  fieldErrors()[cfg.key] ? fieldId(cfg.key) + '-error' : null
                "
                [class]="controlClass()"
              ></textarea>
            } @else {
              <input
                [id]="fieldId(cfg.key)"
                type="url"
                [value]="model()[cfg.key]"
                [readOnly]="!canEdit()"
                (input)="onInput(cfg.key, $event)"
                [attr.aria-invalid]="fieldErrors()[cfg.key] ? 'true' : null"
                [attr.aria-describedby]="
                  fieldErrors()[cfg.key] ? fieldId(cfg.key) + '-error' : null
                "
                [class]="controlClass()"
              />
            }
            @if (fieldErrors()[cfg.key]; as err) {
              <p
                [id]="fieldId(cfg.key) + '-error'"
                class="text-xs font-medium text-(--text-primary)"
                role="alert"
              >
                {{ err }}
              </p>
            }
          </div>
        }

        <!-- Taxonomy: assign existing terms only, via aria-pressed toggle chips. -->
        @for (facet of facets; track facet.key) {
          <fieldset class="space-y-2 border-0 p-0">
            <legend [class]="labelClass">{{ facet.legend }}</legend>
            @if (taxonomy() === null) {
              <p class="text-xs text-(--text-secondary)" i18n="@@vendor.product.taxonomy.loading">
                Loading options…
              </p>
            } @else {
              <div class="flex flex-wrap gap-2">
                @for (term of termsFor(facet.key); track term.slug) {
                  <button
                    type="button"
                    [disabled]="!taxonomyEditable()"
                    (click)="toggle(facet.key, term.slug)"
                    [attr.aria-pressed]="isSelected(facet.key, term.slug)"
                    [class]="chipClass(isSelected(facet.key, term.slug))"
                  >
                    {{ term.name }}
                  </button>
                }
              </div>
              @if (facetErrors()[facet.key]; as err) {
                <p class="text-xs font-medium text-(--text-primary)" role="alert">{{ err }}</p>
              }
            }
          </fieldset>
        }

        <div class="flex flex-wrap items-center gap-4">
          @if (canEdit()) {
            <button type="submit" [disabled]="saveDisabled()" [class]="saveButtonClass">
              @if (saving()) {
                <span i18n="@@vendor.product.saving">Saving…</span>
              } @else {
                <span i18n="@@vendor.product.save">Save changes</span>
              }
            </button>
          }
          @if (saved()) {
            <p
              class="text-sm font-medium text-(--accent-primary)"
              role="status"
              i18n="@@vendor.product.saved"
            >
              Product updated. Your listing shows the change now; search results refresh within a
              day.
            </p>
          } @else if (saveError()) {
            <p
              class="text-sm font-medium text-(--text-primary)"
              role="alert"
              i18n="@@vendor.product.saveError"
            >
              Something went wrong saving your changes. Please try again.
            </p>
          }
        </div>
      </form>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductForm implements OnInit {
  private readonly api = inject(VendorApi);

  readonly product = input.required<VendorProduct>();
  /** The full taxonomy vocabulary for the pickers; `null` until it loads. */
  readonly taxonomy = input<TaxonomyResponse | null>(null);

  /**
   * The §8 entitlement gate, kept FIELD-granular the way §3.3b requires: the
   * PATCH asserts `product.edit` for the handler and `product.taxonomy.edit`
   * again when facet arrays ride along, so the form mirrors both axes rather
   * than collapsing them to one boolean. Both default open, so existing callers
   * are unchanged; at launch the binary ladder grants them together.
   */
  readonly canEdit = input<boolean>(true);
  readonly canEditTaxonomy = input<boolean>(true);

  protected readonly textFields: readonly FieldConfig[] = [
    {
      key: 'description',
      control: 'textarea',
      label: $localize`:@@vendor.product.field.description:Description`,
    },
    { key: 'website', control: 'url', label: $localize`:@@vendor.product.field.website:Website` },
    {
      key: 'tool_integrations_url',
      control: 'url',
      label: $localize`:@@vendor.product.field.integrationsUrl:Integrations page URL`,
    },
    {
      key: 'api_docs_url',
      control: 'url',
      label: $localize`:@@vendor.product.field.apiDocsUrl:API documentation URL`,
    },
    { key: 'logo_url', control: 'url', label: $localize`:@@vendor.product.field.logoUrl:Logo URL` },
  ];

  protected readonly facets: readonly FacetConfig[] = [
    { key: 'category_slugs', legend: $localize`:@@vendor.product.facet.categories:Categories` },
    { key: 'audience_slugs', legend: $localize`:@@vendor.product.facet.audiences:Audiences` },
    { key: 'phase_slugs', legend: $localize`:@@vendor.product.facet.phases:Phases` },
  ];

  private readonly baseline = signal<VendorProduct | null>(null);
  protected readonly model = signal<Record<string, string>>({});
  protected readonly selected = signal<Record<FacetKey, string[]>>({
    category_slugs: [],
    audience_slugs: [],
    phase_slugs: [],
  });

  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal(false);

  protected readonly labelClass =
    'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  /** Everything but the background, which is the read-only tell. Two `bg-*`
   *  utilities on one element would race on stylesheet order. */
  private readonly inputBase =
    'w-full rounded-(--radius-md) border border-(--border-default) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly controlClass = computed(() =>
    this.canEdit()
      ? `${this.inputBase} bg-(--surface-base)`
      : `${this.inputBase} bg-(--surface-sunken)`,
  );
  protected readonly saveButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

  protected readonly fieldErrors = computed<Record<string, string | null>>(() => {
    const m = this.model();
    const out: Record<string, string | null> = {};
    for (const cfg of this.textFields) {
      const raw = (m[cfg.key] ?? '').trim();
      if (raw === '') {
        out[cfg.key] = null;
        continue;
      }
      const res = UpdateVendorProductSchema.safeParse({ [cfg.key]: raw });
      out[cfg.key] =
        cfg.control === 'url' && !res.success
          ? $localize`:@@vendor.product.error.url:Enter a URL starting with http:// or https://`
          : res.success
            ? null
            : $localize`:@@vendor.product.error.tooLong:This value is too long.`;
    }
    return out;
  });

  protected readonly facetErrors = computed<Record<FacetKey, string | null>>(() => {
    const sel = this.selected();
    const tooMany = $localize`:@@vendor.product.error.tooManyTerms:Choose at most ${MAX_TERMS_PER_FACET}:max: terms.`;
    return {
      category_slugs: sel.category_slugs.length > MAX_TERMS_PER_FACET ? tooMany : null,
      audience_slugs: sel.audience_slugs.length > MAX_TERMS_PER_FACET ? tooMany : null,
      phase_slugs: sel.phase_slugs.length > MAX_TERMS_PER_FACET ? tooMany : null,
    };
  });

  protected readonly diff = computed<UpdateVendorProductInput>(() => {
    const base = this.baseline();
    const out: Record<string, unknown> = {};
    if (!base) return out as UpdateVendorProductInput;
    const m = this.model();
    for (const cfg of this.textFields) {
      const raw = (m[cfg.key] ?? '').trim();
      const next = raw === '' ? null : raw;
      if (next !== ((base[cfg.key] as string | null) ?? null)) out[cfg.key] = next;
    }
    const sel = this.selected();
    for (const facet of this.facets) {
      if (!sameSet(sel[facet.key], base[facet.key])) out[facet.key] = sel[facet.key];
    }
    return out as UpdateVendorProductInput;
  });

  protected readonly hasChanges = computed(() => Object.keys(this.diff()).length > 0);
  protected readonly hasErrors = computed(
    () =>
      Object.values(this.fieldErrors()).some((e) => e !== null) ||
      Object.values(this.facetErrors()).some((e) => e !== null),
  );
  protected readonly saveDisabled = computed(
    () => !this.canEdit() || this.saving() || !this.hasChanges() || this.hasErrors(),
  );

  /** The PATCH asserts `product.edit` before it ever looks at the facet arrays,
   *  so taxonomy is editable only when BOTH capabilities are held. */
  protected readonly taxonomyEditable = computed(() => this.canEdit() && this.canEditTaxonomy());

  protected readonly chipClass = (selected: boolean): string => {
    const base =
      'rounded-(--radius-md) border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-default';
    return selected
      ? `${base} border-(--accent-primary) bg-(--accent-primary) text-(--surface-base)`
      : `${base} border-(--border-default) text-(--text-primary) hover:border-(--border-strong)`;
  };

  ngOnInit(): void {
    this.seed(this.product());
  }

  protected fieldId(key: string): string {
    return `vendor-product-${this.product().id}-${key.replace(/_/g, '-')}`;
  }

  protected termsFor(key: FacetKey): readonly TaxonomyTermWithCount[] {
    const t = this.taxonomy();
    if (!t) return [];
    return key === 'category_slugs'
      ? t.categories
      : key === 'audience_slugs'
        ? t.audiences
        : t.phases;
  }

  protected isSelected(key: FacetKey, slug: string): boolean {
    return this.selected()[key].includes(slug);
  }

  protected toggle(key: FacetKey, slug: string): void {
    if (!this.taxonomyEditable()) return;
    this.selected.update((s) => {
      const cur = s[key];
      const next = cur.includes(slug) ? cur.filter((x) => x !== slug) : [...cur, slug];
      return { ...s, [key]: next };
    });
    this.saved.set(false);
  }

  protected onInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.model.update((m) => ({ ...m, [key]: value }));
    this.saved.set(false);
  }

  protected async onSave(): Promise<void> {
    // Enter from a focused (read-only, still focusable) field submits the form
    // even with no rendered submit button, so guard the handler too.
    if (!this.canEdit()) return;
    this.saved.set(false);
    this.saveError.set(false);
    const parsed = UpdateVendorProductSchema.safeParse(this.diff());
    if (!parsed.success) return; // guarded by saveDisabled; defensive
    this.saving.set(true);
    try {
      const res = await this.api.updateProduct(this.product().id, parsed.data);
      this.seed(res.product);
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  private seed(p: VendorProduct): void {
    this.baseline.set(p);
    this.model.set({
      description: p.description ?? '',
      website: p.website ?? '',
      tool_integrations_url: p.tool_integrations_url ?? '',
      api_docs_url: p.api_docs_url ?? '',
      logo_url: p.logo_url ?? '',
    });
    this.selected.set({
      category_slugs: [...p.category_slugs],
      audience_slugs: [...p.audience_slugs],
      phase_slugs: [...p.phase_slugs],
    });
  }
}

/** Order-insensitive set equality for taxonomy slug arrays. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}
