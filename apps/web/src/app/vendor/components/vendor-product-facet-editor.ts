import {
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import {
  UpdateVendorProductSchema,
  VendorUsefulnessSchema,
  type ProductUsefulness,
  type TaxonomyResponse,
  type TaxonomyTermWithCount,
  type UpdateVendorProductInput,
  type VendorProduct,
} from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';
import { vendorIsCatalogueSeat } from '../vendor-capabilities';
import { VendorBulletListEditor, newBullet, type BulletDraft } from './vendor-bullet-list-editor';

/** The four taxonomy facets, each its own product tab (AECI-994). */
export type ProductFacetKind = 'categories' | 'trades' | 'audiences' | 'phases';

type SlugKey = 'category_slugs' | 'trade_slugs' | 'audience_slugs' | 'phase_slugs';
type NarrativeFacet = 'audiences' | 'phases';

interface FacetConfig {
  readonly slugKey: SlugKey;
  readonly vocabulary: keyof TaxonomyResponse;
  readonly legend: string;
  readonly hint: string;
  /** Set for the two facets that carry "How teams use it" points. */
  readonly narrative: NarrativeFacet | null;
}

/** The taxonomy endpoint caps each facet assignment at 10 terms (`termSlugList`). */
export const MAX_TERMS_PER_FACET = 10;
// These mirror `VendorUsefulnessSchema` exactly. A counter that disagrees with
// the validator is worse than no counter.
export const MAX_POINTS_PER_TERM = 8;
export const MAX_POINT_LENGTH = 200;

const FACETS: Readonly<Record<ProductFacetKind, FacetConfig>> = {
  categories: {
    slugKey: 'category_slugs',
    vocabulary: 'categories',
    narrative: null,
    legend: $localize`:@@vendor.product.facet.categories:Categories`,
    hint: $localize`:@@vendor.product.facet.categoriesHint:Pick what your product does, not every feature it touches. Most products fit one to three. Where two terms look close, the narrower one is usually right: BIM Authoring creates models, BIM Coordination clashes them.`,
  },
  trades: {
    slugKey: 'trade_slugs',
    vocabulary: 'trades',
    narrative: null,
    legend: $localize`:@@vendor.product.facet.trades:Trades`,
    hint: $localize`:@@vendor.product.facet.tradesHint:Pick a trade only where your product does something specific for it: trade-specific features, cost data, templates, takeoff logic, or integrations. Most products have none, and that is the right answer for a general-purpose platform.`,
  },
  audiences: {
    slugKey: 'audience_slugs',
    vocabulary: 'audiences',
    narrative: 'audiences',
    legend: $localize`:@@vendor.product.facet.audiences:Audiences`,
    hint: $localize`:@@vendor.product.facet.audiencesHint:Who uses your product day to day, not everyone who benefits from it. The list mixes disciplines like Architecture and MEP Engineering with job titles like Estimator and Superintendent, so pick from both where they apply.`,
  },
  phases: {
    slugKey: 'phase_slugs',
    vocabulary: 'phases',
    narrative: 'phases',
    legend: $localize`:@@vendor.product.facet.phases:Phases`,
    hint: $localize`:@@vendor.product.facet.phasesHint:Where in the project lifecycle your product is used. Unlike trades, more is usually accurate here: if it is used from bidding through closeout, pick every phase in between.`,
  },
};

interface FacetRow {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly checked: boolean;
  /** Only for narrative facets; `null` when the term has no draft list. */
  readonly bullets: readonly BulletDraft[] | null;
}

interface PendingRemoval {
  readonly slug: string;
  readonly name: string;
  readonly points: readonly string[];
}

/**
 * One taxonomy facet of one product, edited inline on its own portal tab
 * (AECI-994 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.12).
 *
 * ── WHAT IT REPLACED ────────────────────────────────────────────────────────
 * AECI-915 put all four facets on one Taxonomy tab as summary cards, each editing
 * in a modal that saved on close. AECI-963 then put "How teams use it" on the
 * Profile tab as two more cards, each editing in a second modal that staged into
 * the text form. Tagging an audience and describing how that audience uses the
 * product were the same decision made in two places. This component makes it one.
 *
 * ── ONE LIST, ONE SAVE ──────────────────────────────────────────────────────
 * The full vocabulary renders inline as a checklist with each term's description.
 * For Audiences and Phases, a ticked term opens a {@link VendorBulletListEditor}
 * beneath it. Nothing persists until Save, which sends ONE
 * `PATCH /api/vendor/products/:id` carrying the facet's slug array and, when the
 * points changed, the complete `usefulness` value. The handler writes both in one
 * `db.batch`, so a tag and its points can never land half-way.
 *
 * Staging is safe here for the reason AECI-963 gave: the draft registers with
 * {@link VendorPortalStore.markDirty}, so a revalidation is stashed rather than
 * trampling it, and the "changed somewhere else" banner covers the rest. The
 * registration owner is `productId:facet`, so the four tabs of the single-page
 * concept never cancel each other's protection.
 *
 * ── POINTS REQUIRE THE TAG ──────────────────────────────────────────────────
 * The portal only offers a point list under a ticked term. Unticking a term that
 * has points opens a confirmation that lists the points being deleted.
 *
 * Promote never had that rule, so an existing product can carry points for a term
 * it is not tagged with. Those rows render unticked WITH their points and a note
 * saying so. Nothing is changed silently: the vendor can tick the term to keep
 * them, or remove them through the same confirmation.
 *
 * ── WHAT THE SERVER SEES ────────────────────────────────────────────────────
 * The wire group is `{ slug, points }` and never `name` (ADR 0033). Blank points
 * are dropped and a term left with none sends no group, because the schema's
 * `.min(1)` floor forbids an empty one. Group order is preserved from the stored
 * value and new groups append, so a clean form is never dirty on seed.
 *
 * The save echo is also spliced into the store's `me`, so the product's other
 * tabs mount on the saved value rather than waiting for the next poll.
 */
@Component({
  selector: 'aec-vendor-product-facet-editor',
  imports: [
    VendorBulletListEditor,
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
  ],
  template: `
    <form class="space-y-5" novalidate (submit)="$event.preventDefault(); onSave()">
      <div class="space-y-2">
        <h3 [id]="headingId()" class="font-display text-lg font-semibold text-(--text-primary)">
          {{ config().legend }}
        </h3>
        <p class="max-w-prose text-sm leading-relaxed text-(--text-secondary)">
          {{ config().hint }}
        </p>
        @if (config().narrative) {
          <p
            class="max-w-prose text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.product.facet.narrativeHint"
          >
            Under each term you tick, add the points that say how that team actually uses your
            product. Short, concrete lines work best. Points publish to your product page as soon as
            you save, with no review.
          </p>
        }
      </div>

      @if (updatedElsewhere()) {
        <div
          class="flex flex-wrap items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
        >
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.product.facet.updatedElsewhere">
            This product changed somewhere else while you were editing. Your unsaved changes are
            still here.
          </p>
          <button
            type="button"
            [class]="secondaryButtonClass"
            (click)="reloadSection()"
            i18n="@@vendor.product.facet.reloadSection"
          >
            Reload this section
          </button>
        </div>
      }

      @if (!canEdit()) {
        @if (catalogueSeat()) {
          <!-- AECI-1082: the catalogue seat never had product editing, so it is not paused. -->
          <p
            class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.product.facet.readOnly.catalogue"
          >
            Product details stay with the AECi team, so this seat cannot edit them. This product
            stays published exactly as it is, and everything on record is here to read.
          </p>
        } @else {
          <p
            class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.product.facet.readOnly"
          >
            Editing is paused while your account access is inactive. This product stays published
            exactly as it is, and everything on record is here to read. The account panel on Vendor
            Overview has the renewal path.
          </p>
        }
      }

      @if (taxonomy() === null) {
        <p class="text-sm text-(--text-secondary)" i18n="@@vendor.product.facet.loading">
          Loading options…
        </p>
      } @else {
        <div
          class="overflow-hidden rounded-(--radius-md) border border-(--border-default) bg-(--surface-base)"
        >
          <fieldset class="border-0 p-0">
            <legend class="sr-only">{{ config().legend }}</legend>
            <ul>
              @for (row of rows(); track row.slug) {
                <li class="border-b border-(--border-default) last:border-b-0">
                  <label [class]="rowLabelClass(row)">
                    <input
                      type="checkbox"
                      class="mt-0.5 h-4 w-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                      [checked]="row.checked"
                      [disabled]="!rowTogglable(row)"
                      (change)="onToggle(row, $event)"
                    />
                    <span class="min-w-0 flex-1 sm:flex sm:items-start sm:gap-4">
                      <span
                        class="block text-sm font-medium text-(--text-primary) sm:w-56 sm:shrink-0"
                        >{{ row.name }}</span
                      >
                      @if (row.description; as d) {
                        <span
                          class="mt-0.5 block text-xs leading-relaxed text-(--text-secondary) sm:mt-0 sm:min-w-0 sm:flex-1"
                          >{{ d }}</span
                        >
                      }
                    </span>
                  </label>

                  <!-- OUTSIDE the label: inputs nested in a label would toggle the
                       checkbox on every click and fold the draft into its name. -->
                  @if (row.bullets !== null && (row.checked || hasPoints(row))) {
                    <div class="space-y-2 px-4 pb-4 ps-11 md:px-5 md:ps-12">
                      @if (!row.checked) {
                        <div class="flex flex-wrap items-center gap-3">
                          <p
                            class="text-xs font-medium text-(--text-primary)"
                            i18n="@@vendor.product.facet.untaggedPoints"
                          >
                            These points show on your product page, but the product is not tagged
                            with this term. Tick it to keep them, or remove them.
                          </p>
                          @if (narrativeEditable()) {
                            <button
                              type="button"
                              [class]="secondaryButtonClass"
                              (click)="requestRemoval(row)"
                              i18n="@@vendor.product.facet.removeUntaggedPoints"
                            >
                              Remove these points
                            </button>
                          }
                        </div>
                      }
                      <p [class]="subLabelClass" i18n="@@vendor.product.facet.pointsLabel">
                        How teams use it
                      </p>
                      <aec-vendor-bullet-list-editor
                        [label]="pointsLabel(row.name)"
                        [bullets]="row.bullets"
                        [maxBullets]="maxPoints"
                        [maxLength]="maxPointLength"
                        [disabled]="!narrativeEditable()"
                        [idPrefix]="idBase() + '-' + row.slug"
                        (bulletsChange)="onBulletsChange(row.slug, $event)"
                      />
                    </div>
                  }
                </li>
              }
            </ul>
          </fieldset>
        </div>
      }

      <div class="flex flex-wrap items-center gap-4">
        @if (canEdit()) {
          <button type="submit" [disabled]="saveDisabled()" [class]="saveButtonClass">
            @if (saving()) {
              <span i18n="@@vendor.product.facet.saving">Saving…</span>
            } @else {
              <span i18n="@@vendor.product.facet.save">Save changes</span>
            }
          </button>
        }
        @if (validationMessage(); as msg) {
          <p class="text-sm font-medium text-(--text-primary)" role="alert">{{ msg }}</p>
        } @else if (saved()) {
          <p
            class="text-sm font-medium text-(--accent-primary)"
            role="status"
            i18n="@@vendor.product.facet.saved"
          >
            Product updated. Your listing shows the change now; search results refresh within a day.
          </p>
        } @else if (saveError()) {
          <p
            class="text-sm font-medium text-(--text-primary)"
            role="alert"
            i18n="@@vendor.product.facet.saveError"
          >
            Something went wrong saving your changes. Please try again.
          </p>
        } @else {
          <p class="text-sm text-(--text-secondary)">{{ counter() }}</p>
        }
      </div>
    </form>

    <brn-dialog [closeOnBackdropClick]="false" (closed)="pendingRemoval.set(null)">
      <ng-template brnDialogContent>
        @if (pendingRemoval(); as removal) {
          <div
            class="flex max-h-[85vh] w-[min(95vw,36rem)] flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) text-(--text-primary) shadow-[0_16px_48px_-8px_rgb(0_0_0/0.18),0_4px_16px_-2px_rgb(0_0_0/0.10)]"
          >
            <div class="shrink-0 p-6 pb-4">
              <h2 brnDialogTitle class="font-display text-xl font-semibold text-(--text-primary)">
                {{ removalHeading(removal.name) }}
              </h2>
              <p
                brnDialogDescription
                class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
                i18n="@@vendor.product.facet.removeDescription"
              >
                These points will be deleted from your product page when you save. You would have to
                write them again to bring them back.
              </p>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto px-6">
              <ul
                class="list-disc space-y-1 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) py-3 ps-8 pe-4"
              >
                @for (point of removal.points; track $index) {
                  <li class="text-sm text-(--text-primary)">{{ point }}</li>
                }
              </ul>
            </div>
            <div class="flex shrink-0 flex-wrap justify-end gap-3 p-6">
              <button
                brnDialogClose
                type="button"
                [class]="secondaryButtonClass"
                i18n="@@vendor.product.facet.removeCancel"
              >
                Keep them
              </button>
              <button
                type="button"
                [class]="saveButtonClass"
                (click)="confirmRemoval()"
                i18n="@@vendor.product.facet.removeConfirm"
              >
                Remove
              </button>
            </div>
          </div>
        }
      </ng-template>
    </brn-dialog>
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductFacetEditor {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  /** The §8.9 connector seat (AECI-1082): its read-only notice is not paused copy. */
  protected readonly catalogueSeat = vendorIsCatalogueSeat(this.store);

  readonly product = input.required<VendorProduct>();
  readonly facet = input.required<ProductFacetKind>();
  /** The full vocabulary; `null` until it loads. */
  readonly taxonomy = input<TaxonomyResponse | null>(null);

  /**
   * The §8 gates, kept field-granular: the PATCH asserts `product.edit` first,
   * then `product.taxonomy.edit` when a slug array rides along and
   * `product.usefulness.edit` when `usefulness` does. All default open.
   */
  readonly canEdit = input<boolean>(true);
  readonly canEditTaxonomy = input<boolean>(true);
  readonly canEditUsefulness = input<boolean>(true);

  protected readonly config = computed(() => FACETS[this.facet()]);
  protected readonly maxPoints = MAX_POINTS_PER_TERM;
  protected readonly maxPointLength = MAX_POINT_LENGTH;

  private readonly dialog = viewChild(BrnDialog);

  private readonly baseline = signal<VendorProduct | null>(null);
  private readonly draftSlugs = signal<ReadonlySet<string>>(new Set());
  /** slug → draft points. Map order is group order on the wire. A key may exist
   *  for an UNticked slug only when promote wrote points for an untagged term. */
  private readonly draftBullets = signal<ReadonlyMap<string, readonly BulletDraft[]>>(new Map());

  protected readonly pendingRemoval = signal<PendingRemoval | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal(false);

  protected readonly subLabelClass =
    'text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  protected readonly secondaryButtonClass =
    'cursor-pointer rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly saveButtonClass =
    'inline-flex cursor-pointer items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

  protected readonly idBase = computed(() => `vendor-product-${this.product().id}-${this.facet()}`);
  protected readonly headingId = computed(() => `${this.idBase()}-heading`);

  protected readonly tagsEditable = computed(() => this.canEdit() && this.canEditTaxonomy());
  protected readonly narrativeEditable = computed(() => this.canEdit() && this.canEditUsefulness());

  private readonly vocabulary = computed<readonly TaxonomyTermWithCount[]>(() => {
    const t = this.taxonomy();
    return t ? (t[this.config().vocabulary] as readonly TaxonomyTermWithCount[]) : [];
  });

  /**
   * Every vocabulary term, then any slug the vocabulary does not know but the
   * product carries (as a tag or as points), labelled with its slug. The taxonomy
   * read is a cached snapshot and promote can mint a term inside that window, so
   * dropping unknown rows would understate what is published and delete it on save.
   */
  protected readonly rows = computed<readonly FacetRow[]>(() => {
    const slugs = this.draftSlugs();
    const bullets = this.draftBullets();
    const narrative = this.config().narrative !== null;
    const storedNames = new Map(this.storedGroups().map((g) => [g.slug, g.name]));
    const row = (slug: string, name: string, description: string | null): FacetRow => ({
      slug,
      name,
      description,
      checked: slugs.has(slug),
      bullets: narrative ? (bullets.get(slug) ?? (slugs.has(slug) ? [] : null)) : null,
    });
    const known = this.vocabulary().map((t) => row(t.slug, t.name, t.description));
    const seen = new Set(known.map((r) => r.slug));
    const extra = [
      ...new Set([
        ...(this.baseline()?.[this.config().slugKey] ?? []),
        ...slugs,
        ...bullets.keys(),
      ]),
    ]
      .filter((slug) => !seen.has(slug))
      .map((slug) => row(slug, storedNames.get(slug) ?? slug, null));
    return [...known, ...extra];
  });

  protected readonly counter = computed(
    () =>
      $localize`:@@vendor.product.facet.counter:${this.draftSlugs().size}:COUNT: of ${MAX_TERMS_PER_FACET}:MAX: selected`,
  );

  /** The groups this facet stores today, from the baseline. */
  private readonly storedGroups = computed(() => {
    const narrative = this.config().narrative;
    return narrative ? (this.baseline()?.usefulness?.[narrative] ?? []) : [];
  });

  /** The stored groups normalised the way a draft is (trimmed, blanks and empty
   *  groups dropped), so a promoted value with stray whitespace is not dirty on
   *  seed. */
  private readonly storedGroupsClean = computed(() =>
    this.storedGroups()
      .map((g) => ({ slug: g.slug, points: g.points.map((p) => p.trim()).filter(Boolean) }))
      .filter((g) => g.points.length > 0),
  );

  /** The draft as wire groups: blank points dropped, empty groups omitted. */
  private readonly draftGroups = computed(() =>
    [...this.draftBullets()]
      .map(([slug, list]) => ({ slug, points: cleanPoints(list) }))
      .filter((g) => g.points.length > 0),
  );

  protected readonly diff = computed<UpdateVendorProductInput>(() => {
    const base = this.baseline();
    const out: Record<string, unknown> = {};
    if (!base) return out as UpdateVendorProductInput;
    const { slugKey, narrative } = this.config();

    const nextSlugs = this.orderedDraftSlugs();
    if (!sameSet(nextSlugs, base[slugKey])) out[slugKey] = nextSlugs;

    if (narrative) {
      const nextGroups = this.draftGroups();
      if (!groupsEqual(this.storedGroupsClean(), nextGroups)) {
        const other = narrative === 'audiences' ? 'phases' : 'audiences';
        const otherGroups = (base.usefulness?.[other] ?? []).map((g) => ({
          slug: g.slug,
          points: [...g.points],
        }));
        const value = { [narrative]: nextGroups, [other]: otherGroups } as {
          audiences: { slug: string; points: string[] }[];
          phases: { slug: string; points: string[] }[];
        };
        out['usefulness'] =
          value.audiences.length === 0 && value.phases.length === 0 ? null : value;
      }
    }
    return out as UpdateVendorProductInput;
  });

  protected readonly hasChanges = computed(() => Object.keys(this.diff()).length > 0);

  /** The one blocking message, if any. Validates only what would be SENT, so an
   *  over-cap value promote already stored never locks the tab. */
  protected readonly validationMessage = computed<string | null>(() => {
    const d = this.diff();
    const slugs = d[this.config().slugKey];
    if (slugs && slugs.length > MAX_TERMS_PER_FACET) {
      return $localize`:@@vendor.product.facet.tooManyTerms:Too many selected. Untick some to get back under ${MAX_TERMS_PER_FACET}:MAX:.`;
    }
    if (d.usefulness && !VendorUsefulnessSchema.safeParse(d.usefulness).success) {
      const tooLong = [...this.draftBullets().values()].some((list) =>
        list.some((b) => b.text.trim().length > MAX_POINT_LENGTH),
      );
      return tooLong
        ? $localize`:@@vendor.product.facet.pointTooLong:A point is too long. Keep each under ${MAX_POINT_LENGTH}:MAX: characters.`
        : $localize`:@@vendor.product.facet.tooManyPoints:Too many points. Keep each term to ${MAX_POINTS_PER_TERM}:MAX: points and ${MAX_TERMS_PER_FACET}:TERMS: terms.`;
    }
    return null;
  });

  protected readonly saveDisabled = computed(
    () =>
      !this.canEdit() || this.saving() || !this.hasChanges() || this.validationMessage() !== null,
  );

  private readonly owner = computed(() => `${this.product().id}:${this.facet()}`);
  protected readonly updatedElsewhere = computed(() =>
    this.store.isStale('products', this.owner()),
  );
  private readonly acceptNextPayload = signal(false);

  constructor() {
    effect(() => {
      const p = this.product();
      this.facet();
      untracked(() => {
        if (this.hasChanges() && !this.acceptNextPayload()) return;
        this.acceptNextPayload.set(false);
        this.seed(p);
      });
    });

    effect((onCleanup) => {
      const dirty = this.hasChanges();
      const owner = this.owner();
      untracked(() => {
        if (dirty) this.store.markDirty('products', owner);
        else this.store.clearDirty('products', owner);
      });
      // A tab switch destroys this editor. Its registration must not outlive it,
      // or the store would hold `me` for a form nobody can see.
      onCleanup(() => untracked(() => this.store.clearDirty('products', owner)));
    });
  }

  protected rowLabelClass(row: FacetRow): string {
    const base = 'flex items-start gap-3 px-4 py-3 transition-colors md:px-5';
    return this.rowTogglable(row) ? `${base} cursor-pointer hover:bg-(--surface-sunken)` : base;
  }

  protected rowTogglable(row: FacetRow): boolean {
    if (!this.tagsEditable() || this.taxonomy() === null) return false;
    return row.checked || this.draftSlugs().size < MAX_TERMS_PER_FACET;
  }

  protected hasPoints(row: FacetRow): boolean {
    return (row.bullets ?? []).some((b) => b.text.trim().length > 0);
  }

  protected pointsLabel(name: string): string {
    return $localize`:@@vendor.product.facet.pointsListLabel:How teams use it: ${name}:TERM:`;
  }

  protected removalHeading(name: string): string {
    return $localize`:@@vendor.product.facet.removeHeading:Remove the points for ${name}:TERM:?`;
  }

  protected onToggle(row: FacetRow, event: Event): void {
    const box = event.target as HTMLInputElement;
    if (row.checked && this.hasPoints(row)) {
      // Hold the tick until the vendor confirms. Opening from the event handler,
      // never an effect: BrnDialog.open() in an effect throws NG0602.
      box.checked = true;
      this.requestRemoval(row);
      return;
    }
    this.draftSlugs.update((s) => {
      const next = new Set(s);
      if (row.checked) next.delete(row.slug);
      else next.add(row.slug);
      return next;
    });
    if (row.checked) this.dropBullets(row.slug);
    this.touched();
  }

  protected requestRemoval(row: FacetRow): void {
    this.pendingRemoval.set({
      slug: row.slug,
      name: row.name,
      points: cleanPoints(row.bullets ?? []),
    });
    this.dialog()?.open();
  }

  protected confirmRemoval(): void {
    const removal = this.pendingRemoval();
    if (!removal) return;
    this.draftSlugs.update((s) => {
      const next = new Set(s);
      next.delete(removal.slug);
      return next;
    });
    this.dropBullets(removal.slug);
    this.touched();
    this.dialog()?.close();
  }

  protected onBulletsChange(slug: string, bullets: readonly BulletDraft[]): void {
    this.draftBullets.update((m) => new Map(m).set(slug, bullets));
    this.touched();
  }

  protected reloadSection(): void {
    this.acceptNextPayload.set(true);
    void this.store.reload('products');
  }

  protected async onSave(): Promise<void> {
    if (this.saveDisabled()) return;
    this.saved.set(false);
    this.saveError.set(false);
    const parsed = UpdateVendorProductSchema.safeParse(this.diff());
    if (!parsed.success) return;
    this.saving.set(true);
    try {
      const res = await this.api.updateProduct(this.product().id, parsed.data);
      this.seed(res.product);
      this.store
        .apply('me', (me) =>
          me
            ? {
                ...me,
                products: me.products.map((p) => (p.id === res.product.id ? res.product : p)),
              }
            : me,
        )
        .commit();
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  private dropBullets(slug: string): void {
    this.draftBullets.update((m) => {
      if (!m.has(slug)) return m;
      const next = new Map(m);
      next.delete(slug);
      return next;
    });
  }

  private touched(): void {
    this.saved.set(false);
    this.saveError.set(false);
  }

  /** The draft slug set in vocabulary order, then unknown slugs. The server
   *  ignores order; a stable one keeps the request body readable in the audit. */
  private orderedDraftSlugs(): string[] {
    const slugs = this.draftSlugs();
    const known = this.vocabulary()
      .map((t) => t.slug)
      .filter((s) => slugs.has(s));
    const knownSet = new Set(known);
    return [...known, ...[...slugs].filter((s) => !knownSet.has(s))];
  }

  private seed(p: VendorProduct): void {
    const { slugKey, narrative } = this.config();
    this.baseline.set(p);
    this.draftSlugs.set(new Set(p[slugKey]));
    const groups: ProductUsefulness['audiences'] = narrative
      ? (p.usefulness?.[narrative] ?? [])
      : [];
    this.draftBullets.set(
      new Map(groups.map((g) => [g.slug, g.points.map((point) => newBullet(point))])),
    );
  }
}

/** Trimmed, non-empty point text, in order. */
function cleanPoints(list: readonly BulletDraft[]): string[] {
  return list.map((b) => b.text.trim()).filter((t) => t.length > 0);
}

/** Order-insensitive set equality over slugs (binary order is fine for an
 *  equality test; AECI-825 leaves slugs on binary ordering). */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * ORDER-SENSITIVE group equality on `slug` and `points`. Order is display order
 * on the public page, so a reorder is a real edit. `name` is ignored: it is
 * server-derived, and a taxonomy rename is not this vendor's change.
 */
function groupsEqual(
  stored: readonly { slug: string; points: readonly string[] }[],
  next: readonly { slug: string; points: readonly string[] }[],
): boolean {
  return (
    stored.length === next.length &&
    stored.every(
      (g, i) =>
        g.slug === next[i]!.slug &&
        g.points.length === next[i]!.points.length &&
        g.points.every((p, j) => p === next[i]!.points[j]),
    )
  );
}
