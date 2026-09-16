import { VendorPortalAnnouncer } from '../vendor-announcer';
import { LogoInput } from '../../shared/logo-input/logo-input';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import {
  UpdateVendorProductSchema,
  type TaxonomyResponse,
  type TaxonomyTermWithCount,
  type UpdateVendorProductInput,
  type VendorProduct,
} from '@aeci/shared';

import { InfoHint } from '../../shared/info-hint/info-hint';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorTaxonomyFacetDialog } from './vendor-taxonomy-facet-dialog';

type ProductTextKey =
  | 'description'
  | 'website'
  | 'tool_integrations_url'
  | 'api_docs_url'
  | 'logo_url';
type FacetKey = 'category_slugs' | 'audience_slugs' | 'phase_slugs' | 'trade_slugs';
type Control = 'url' | 'textarea';

interface FieldConfig {
  readonly key: ProductTextKey;
  readonly label: string;
  readonly control: Control;
}

interface FacetConfig {
  readonly key: FacetKey;
  readonly legend: string;
  /** Guidance for the facet as a whole. Every facet carries one (AECI-913):
   *  each is a judgement call the vendor is best placed to make, and the four
   *  calibrations genuinely differ. Trades: most products have none. Phases:
   *  more is usually accurate. Categories: narrower beats broader. Audiences:
   *  the vocabulary mixes disciplines with job titles on one axis, which is not
   *  guessable from the term list alone. Stating one facet's rule and leaving
   *  the others silent implied the silent three had no rule.
   *
   *  Rendered TWICE, at two densities (AECI-915): as an `<aec-info-hint>`
   *  overlay beside the heading on the summary card, and written out in full at
   *  the top of the editor modal — the moment the vendor is actually choosing.
   *  Kept optional because the type allows a future facet to ship before its
   *  copy is written. */
  readonly hint?: string;
}

/** One row of a facet's summary card: a term the product currently carries. */
interface SelectedTerm {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
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
 * Validation is the shared `UpdateVendorProductSchema` (single source of truth,
 * client + server); only changed fields are sent (the endpoint requires ≥1). The
 * PATCH echo re-seeds the baseline so the form settles clean. The confirmation
 * must NOT promise instant search — edits reach Algolia on the nightly sync
 * (≤24h) while SSR repaints immediately (AECI-529).
 *
 * ── TAXONOMY: SUMMARY HERE, EDITING IN A MODAL (AECI-915) ───────────────────
 * The four facets used to render as fieldsets of `aria-pressed` toggle chips —
 * 107 of them, all on screen at once. Reading "what is this tagged as" meant
 * diffing pressed against unpressed across 32 chips, and the per-term
 * `description` seeded by AECI-911 (which exists to separate adjacent terms) had
 * nowhere to go.
 *
 * Now each facet is a summary card in a two-column grid: the facet name, its
 * hint behind an info control, a pencil, and one row per SELECTED term with that
 * term's description behind its own info control. The full vocabulary lives in
 * {@link VendorTaxonomyFacetDialog}.
 *
 * **The modal saves for real, so facet state here can never be dirty.** That is
 * structural, not a convention: {@link selected} is COMPUTED off the baseline,
 * so the only way it moves is a fresh `VendorProduct` — either the input or a
 * PATCH echo. There is no unsaved facet state to lose, which is why the Taxonomy
 * tab has no Save button of its own. See the dialog's class doc for why staging
 * was rejected (`apps/web` has no `CanDeactivate` guard).
 *
 * Vendors assign EXISTING terms only; minting a term is an AECi curation act, so
 * an unknown slug is a 400 server-side.
 *
 * ── UNSAVED EDITS vs. REVALIDATION (AECI-628) ───────────────────────────────
 * Same contract as `vendor-profile-form.ts`, and it now covers the TEXT fields
 * alone: the baseline re-seeds from the input so a clean form tracks the server,
 * and while `hasChanges()` is true the form registers with
 * {@link VendorPortalStore.markDirty} so a fresh `me` payload is stashed rather
 * than applied. The registration is keyed by PRODUCT ID, because the section
 * renders one of these per owned product and a clean sibling must not be able to
 * cancel a dirty one's protection.
 */
@Component({
  selector: 'aec-vendor-product-form',
  imports: [LogoInput, InfoHint, VendorTaxonomyFacetDialog],
  template: `
    <div class="space-y-6">
      <!-- Read-only identity: rename is a correction request, not a vendor edit.
           Suppressed on the Taxonomy tab, where the product's name is already the
           page heading directly above and repeating it reads as a second product. -->
      @if (showFields()) {
        <div
          class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
        >
          <p class="font-display text-lg text-(--text-primary)">{{ product().name }}</p>
          <p class="mt-1 text-xs text-(--text-secondary)">
            <span class="font-mono">/{{ product().slug }}</span>
          </p>
          <p class="mt-2 text-xs text-(--text-secondary)" i18n="@@vendor.product.renameHint">
            To change the product name, file a correction request. Renaming would break its links
            and search entry.
          </p>
        </div>
      }

      <form class="space-y-6" novalidate (submit)="$event.preventDefault(); onSave()">
        @if (updatedElsewhere()) {
          <div
            class="flex flex-wrap items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
          >
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.product.updatedElsewhere">
              This product changed somewhere else while you were editing. Your unsaved changes are
              still here.
            </p>
            <button
              type="button"
              [class]="reloadButtonClass"
              (click)="reloadSection()"
              i18n="@@vendor.product.reloadSection"
            >
              Reload this section
            </button>
          </div>
        }

        @if (!canEdit()) {
          <p
            class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.product.readOnly"
          >
            Editing is paused while your account access is inactive. This product stays published
            exactly as it is, and everything on record is here to read. The account panel on Vendor
            Overview has the renewal path.
          </p>
        }

        @for (cfg of showFields() ? textFields : []; track cfg.key) {
          <div class="space-y-1.5">
            @if (cfg.key === 'logo_url') {
              <aec-logo-input
                [inputId]="fieldId(cfg.key)"
                [value]="model()['logo_url'] ?? ''"
                [readOnly]="!canEdit()"
                [disabled]="saving()"
                (valueChange)="onLogoChange($event)"
                (pendingChange)="logoPending.set($event)"
                (announce)="announcer.announce($event)"
              />
            } @else {
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

        <!--
          Taxonomy: read here, write in the modal. Two columns from the md
          breakpoint up, since each card is now short enough that one per row
          wasted the width.
        -->
        @if (showTaxonomy()) {
          <div class="grid gap-4 md:grid-cols-2">
            @for (facet of facets; track facet.key) {
              <section
                class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) p-4"
              >
                <div class="flex items-start justify-between gap-3">
                  <!-- The info control is a SIBLING of the <h3>, never a child.
                       Its accessible name IS the whole hint paragraph, and an
                       accessible name is computed from descendants, so nesting
                       it would make every facet heading announce as "Categories
                       Pick what your product does, …" in a screen reader's
                       heading list. Nothing lints this; axe cannot see it. -->
                  <div class="flex items-center gap-1.5">
                    <h3 [class]="facetHeadingClass">{{ facet.legend }}</h3>
                    @if (facet.hint; as hint) {
                      <aec-info-hint [text]="hint" width="wide" />
                    }
                  </div>
                  <aec-vendor-taxonomy-facet-dialog
                    [legend]="facet.legend"
                    [hint]="facet.hint"
                    [terms]="termsFor(facet.key)"
                    [selected]="selected()[facet.key]"
                    [maxTerms]="maxTerms"
                    [disabled]="!taxonomyEditable() || taxonomy() === null"
                    [save]="saverFor(facet.key)"
                  />
                </div>

                @if (taxonomy() === null) {
                  <p
                    class="mt-3 text-xs text-(--text-secondary)"
                    i18n="@@vendor.product.taxonomy.loading"
                  >
                    Loading options…
                  </p>
                } @else if (selectedTermsFor(facet.key); as terms) {
                  @if (terms.length === 0) {
                    <p
                      class="mt-3 text-sm text-(--text-secondary)"
                      i18n="@@vendor.product.taxonomy.none"
                    >
                      None selected yet.
                    </p>
                  } @else {
                    <ul class="mt-3 space-y-1.5">
                      @for (term of terms; track term.slug) {
                        <li class="flex items-start gap-1.5 text-sm text-(--text-primary)">
                          <span class="min-w-0">{{ term.name }}</span>
                          @if (term.description; as description) {
                            <aec-info-hint class="mt-0.5" [text]="description" />
                          }
                        </li>
                      }
                    </ul>
                  }
                }
              </section>
            }
          </div>
        }

        <div class="flex flex-wrap items-center gap-4">
          <!-- No Save on the Taxonomy tab: the modal persists on its own, so
               there is nothing here left to submit. -->
          @if (canEdit() && showFields()) {
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
export class VendorProductForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);

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

  /**
   * WHICH half of the form to render (AECI-666) — the product row's Profile and
   * Taxonomy tabs are two projections of this ONE component, not two components.
   *
   * Splitting it for real would mean two dirty-diff implementations racing on one
   * endpoint, and `PATCH /api/vendor/products/:id` both requires ≥1 changed field
   * and re-asserts `product.taxonomy.edit` when facet arrays ride along — so a
   * second implementation is two chances to send an empty PATCH and two places
   * for the field-level gate to drift. Projecting instead keeps one baseline and
   * one reconciliation.
   *
   * That the hidden half cannot go dirty is what makes the submitted PATCH carry
   * only the visible section: `diff()` compares against the baseline, and a field
   * with no control on screen is never edited, so it never appears in the body.
   *
   * `'all'` is the default and is what `vendor-dashboard-single.ts` (the
   * single-page concept, which has no product nav to split along) keeps using.
   */
  readonly section = input<'all' | 'profile' | 'taxonomy'>('all');

  protected readonly showFields = computed(() => this.section() !== 'taxonomy');
  protected readonly showTaxonomy = computed(() => this.section() !== 'profile');

  protected readonly maxTerms = MAX_TERMS_PER_FACET;

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
    {
      key: 'category_slugs',
      legend: $localize`:@@vendor.product.facet.categories:Categories`,
      hint: $localize`:@@vendor.product.facet.categoriesHint:Pick what your product does, not every feature it touches. Most products fit one to three. Where two terms look close, the narrower one is usually right: BIM Authoring creates models, BIM Coordination clashes them.`,
    },
    {
      key: 'audience_slugs',
      legend: $localize`:@@vendor.product.facet.audiences:Audiences`,
      hint: $localize`:@@vendor.product.facet.audiencesHint:Who uses your product day to day, not everyone who benefits from it. The list mixes disciplines like Architecture and MEP Engineering with job titles like Estimator and Superintendent, so pick from both where they apply.`,
    },
    {
      key: 'phase_slugs',
      legend: $localize`:@@vendor.product.facet.phases:Phases`,
      hint: $localize`:@@vendor.product.facet.phasesHint:Where in the project lifecycle your product is used. Unlike trades, more is usually accurate here: if it is used from bidding through closeout, pick every phase in between.`,
    },
    {
      key: 'trade_slugs',
      legend: $localize`:@@vendor.product.facet.trades:Trades`,
      hint: $localize`:@@vendor.product.facet.tradesHint:Pick a trade only where your product does something specific for it: trade-specific features, cost data, templates, takeoff logic, or integrations. Most products have none, and that is the right answer for a general-purpose platform.`,
    },
  ];

  private readonly baseline = signal<VendorProduct | null>(null);
  protected readonly model = signal<Record<string, string>>({});

  /**
   * What the SERVER says this product carries, per facet. Deliberately a
   * `computed` off the baseline rather than a writable signal: the modal saves
   * for real, so there is no such thing as a pending facet edit, and deriving it
   * makes that unrepresentable instead of merely untrue today.
   */
  protected readonly selected = computed<Record<FacetKey, readonly string[]>>(() => {
    const b = this.baseline();
    return {
      category_slugs: b?.category_slugs ?? [],
      audience_slugs: b?.audience_slugs ?? [],
      phase_slugs: b?.phase_slugs ?? [],
      trade_slugs: b?.trade_slugs ?? [],
    };
  });

  protected readonly announcer = inject(VendorPortalAnnouncer);
  protected readonly saving = signal(false);
  protected readonly logoPending = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal(false);

  protected readonly labelClass =
    'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  /** Carries no layout: the heading's info control is a sibling in a wrapper
   *  row, not a child, so the heading itself is only ever the facet name. */
  protected readonly facetHeadingClass =
    'text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
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
  protected readonly reloadButtonClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

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

  /**
   * The submit button's payload — TEXT FIELDS ONLY. Facet arrays are PATCHed by
   * the modal the moment it saves, so including them here would be a second path
   * to the same write with no state left to carry.
   */
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
    return out as UpdateVendorProductInput;
  });

  protected readonly hasChanges = computed(() => Object.keys(this.diff()).length > 0);
  protected readonly hasErrors = computed(() =>
    Object.values(this.fieldErrors()).some((e) => e !== null),
  );
  protected readonly saveDisabled = computed(
    () =>
      !this.canEdit() ||
      this.saving() ||
      this.logoPending() ||
      !this.hasChanges() ||
      this.hasErrors(),
  );

  /** The PATCH asserts `product.edit` before it ever looks at the facet arrays,
   *  so taxonomy is editable only when BOTH capabilities are held. */
  protected readonly taxonomyEditable = computed(() => this.canEdit() && this.canEditTaxonomy());

  /**
   * One stable saver per facet, built once. A method returning a fresh closure
   * would hand the dialog a new input value on every change-detection pass.
   */
  private readonly savers: Record<FacetKey, (slugs: string[]) => Promise<boolean>> = {
    category_slugs: (slugs) => this.saveFacet('category_slugs', slugs),
    audience_slugs: (slugs) => this.saveFacet('audience_slugs', slugs),
    phase_slugs: (slugs) => this.saveFacet('phase_slugs', slugs),
    trade_slugs: (slugs) => this.saveFacet('trade_slugs', slugs),
  };

  /** The store deferred a fresh `me` payload because THIS product form is
   *  holding it. Keyed by product id, so a sibling form's edits do not put a
   *  reload prompt on a product nobody touched. */
  protected readonly updatedElsewhere = computed(() =>
    this.store.isStale('products', this.product().id),
  );

  /** One-shot override for the re-seed guard: see `vendor-profile-form.ts`. */
  private readonly acceptNextPayload = signal(false);

  constructor() {
    // Re-seed from the input whenever the payload changes and there is nothing
    // unsaved to lose.
    effect(() => {
      const p = this.product();
      untracked(() => {
        if (this.hasChanges() && !this.acceptNextPayload()) return;
        this.acceptNextPayload.set(false);
        this.seed(p);
      });
    });

    // Register/withdraw this product's unsaved-edit protection. An in-flight
    // logo upload counts as dirty even though the model has not moved yet: the
    // store would otherwise push a fresh payload mid-upload and the re-seed
    // above would drop the draft the upload is about to land on. Same guard as
    // the profile form.
    effect(() => {
      const dirty = this.hasChanges() || this.logoPending();
      untracked(() => {
        const id = this.product().id;
        if (dirty) this.store.markDirty('products', id);
        else this.store.clearDirty('products', id);
      });
    });
  }

  /** Take the server's copy and drop the unsaved edits. */
  protected reloadSection(): void {
    this.acceptNextPayload.set(true);
    void this.store.reload('products');
  }

  protected fieldId(key: string): string {
    return `vendor-product-${this.product().id}-${key.replace(/_/g, '-')}`;
  }

  protected saverFor(key: FacetKey): (slugs: string[]) => Promise<boolean> {
    return this.savers[key];
  }

  protected termsFor(key: FacetKey): readonly TaxonomyTermWithCount[] {
    const t = this.taxonomy();
    if (!t) return [];
    return key === 'category_slugs'
      ? t.categories
      : key === 'audience_slugs'
        ? t.audiences
        : key === 'phase_slugs'
          ? t.phases
          : // The FULL closed vocabulary, unfiltered by the publication floor.
            // `TRADE_PUBLISH_MIN_PRODUCTS` gates the SEO surfaces, not tagging:
            // hiding an unpublished trade here would make it unreachable
            // forever, since a vendor tagging it is exactly how it reaches the
            // floor in the first place.
            t.trades;
  }

  /**
   * The summary rows for one facet: the terms this product carries, in
   * VOCABULARY order rather than assignment order, so the card does not reshuffle
   * itself after a save.
   *
   * A slug the vocabulary does not know still renders, labelled with the slug —
   * the taxonomy fetch and the product payload are two round-trips and can
   * disagree, and quietly dropping a row would understate what is published.
   */
  protected selectedTermsFor(key: FacetKey): readonly SelectedTerm[] {
    const assigned = new Set(this.selected()[key]);
    if (assigned.size === 0) return [];
    const known = this.termsFor(key);
    const rows: SelectedTerm[] = known
      .filter((t) => assigned.has(t.slug))
      .map((t) => ({ slug: t.slug, name: t.name, description: t.description }));
    const seen = new Set(rows.map((r) => r.slug));
    for (const slug of assigned) {
      if (!seen.has(slug)) rows.push({ slug, name: slug, description: null });
    }
    return rows;
  }

  protected onLogoChange(value: string): void {
    this.model.update((m) => ({ ...m, logo_url: value }));
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

  /**
   * Persist ONE facet's full replacement set, on behalf of the modal. Resolves
   * `false` on any refusal so the modal can keep itself open with the draft
   * intact; the page-level `saveError` stays down, because the message belongs
   * next to the work that failed.
   */
  private async saveFacet(key: FacetKey, slugs: string[]): Promise<boolean> {
    if (!this.taxonomyEditable()) return false;
    this.saved.set(false);
    this.saveError.set(false);
    const parsed = UpdateVendorProductSchema.safeParse({ [key]: slugs });
    if (!parsed.success) return false; // guarded by the modal's cap; defensive
    try {
      const res = await this.api.updateProduct(this.product().id, parsed.data);
      this.applyEcho(res.product);
      this.saved.set(true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Absorb a PATCH echo that only carried a facet change.
   *
   * Re-seeds the baseline (and with it {@link selected}) but leaves the text
   * model alone when it holds unsaved edits — in the `section: 'all'` projection
   * the modal and the text fields share this component, and a full `seed()` here
   * would throw away typing the user never submitted.
   */
  private applyEcho(product: VendorProduct): void {
    const keepText = this.hasChanges();
    if (keepText) this.baseline.set(product);
    else this.seed(product);
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
  }
}
