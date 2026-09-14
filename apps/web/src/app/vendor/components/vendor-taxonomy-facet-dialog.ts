import { Component, computed, input, signal, viewChild } from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import type { TaxonomyTermWithCount } from '@aeci/shared';

/**
 * The pencil trigger beside a facet heading in the product taxonomy editor, and
 * the modal it opens (AECI-915 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.3).
 *
 * ── WHY A MODAL AT ALL ───────────────────────────────────────────────────────
 * `DESIGN.md` says not to reach for a modal first, so: the four facets carry 107
 * terms between them, and the page used to render every one as a toggle chip.
 * Reading "what is this product tagged as" meant visually diffing 32 pressed-vs-
 * unpressed chips. Splitting read from write lets the page be a short summary and
 * gives the picker enough room to show each term's `description` beside it —
 * which is the whole point, because the descriptions (AECI-911) are written to
 * disambiguate adjacent terms and had nowhere to render in the portal.
 *
 * ── THE ROW IS A `<label>` AROUND A REAL CHECKBOX ────────────────────────────
 * Not `role="checkbox"` on a button. A native input inside its label gives the
 * whole row as a click target, Space to toggle, correct `aria-checked`, and the
 * group semantics of the wrapping `<fieldset>` — all without re-implementing any
 * of it. The term's description sits INSIDE the label, so it is part of the
 * control's accessible name: verbose when tabbing, but it is precisely the
 * information the picker exists to convey, and the alternative (`aria-describedby`
 * on a sibling) would put the description outside the click target.
 *
 * The `<fieldset>` is deliberately NOT the scrolling element (AECI-925). Given
 * `overflow-y: auto` it reports a scroll range and still refuses to clip, so with
 * the full 33-term category vocabulary the rows painted straight down the page
 * past the card's bottom edge. A plain `<div>` wrapper does the scrolling; the
 * fieldset keeps the grouping semantics and nothing else.
 *
 * ── SAVE PERSISTS. IT DOES NOT STAGE. ────────────────────────────────────────
 * {@link save} runs the real `PATCH /api/vendor/products/:id`. A Save that only
 * wrote into the parent form's model would be a lie: `apps/web` has no
 * `CanDeactivate` guard and no `beforeunload` handler, so a vendor could click
 * Save, switch tabs, and lose the edit with nothing said. On failure the modal
 * STAYS OPEN with the draft intact — closing it would discard the work the save
 * just failed to persist.
 *
 * `save` is a function input rather than an output because the outcome has to
 * flow back: an output is fire-and-forget, and this component needs to know
 * whether to close or to show an error. The parent owns the endpoint, the
 * baseline, and the echo; this component owns the draft.
 *
 * ── OPEN IS IMPERATIVE ───────────────────────────────────────────────────────
 * `BrnDialog.open()` from the click handler, never an `effect()` — the latter
 * throws NG0602 (hit on AECI-218). Same rule as `vendor-seat-invite-dialog.ts`.
 */
@Component({
  selector: 'aec-vendor-taxonomy-facet-dialog',
  imports: [BrnDialog, BrnDialogContent, BrnDialogClose, BrnDialogTitle, BrnDialogDescription],
  template: `
    <button
      type="button"
      [disabled]="disabled()"
      [class]="triggerClass"
      [attr.aria-label]="triggerLabel()"
      (click)="openEditor()"
    >
      <svg
        aria-hidden="true"
        class="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
      </svg>
    </button>

    <brn-dialog [closeOnBackdropClick]="false">
      <ng-template brnDialogContent>
        <div
          class="flex max-h-[85vh] w-[min(95vw,60rem)] flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) text-(--text-primary) shadow-[0_16px_48px_-8px_rgb(0_0_0/0.18),0_4px_16px_-2px_rgb(0_0_0/0.10)]"
        >
          <div class="shrink-0 border-b border-(--border-default) p-6 md:p-8">
            <div class="flex items-start justify-between gap-4">
              <h2 brnDialogTitle class="font-display text-xl font-semibold text-(--text-primary)">
                {{ heading() }}
              </h2>
              <button
                brnDialogClose
                type="button"
                class="-me-1 -mt-1 shrink-0 cursor-pointer rounded-(--radius-sm) p-1 text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n-aria-label="@@vendor.product.taxonomy.editor.close"
                aria-label="Close"
              >
                <svg
                  class="size-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- The facet hint, written out in full. On the page behind this it
                 is an info-control overlay; here there is room for it. -->
            @if (hint(); as h) {
              <p
                brnDialogDescription
                class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
              >
                {{ h }}
              </p>
            }
          </div>

          <!-- The scroll container is this DIV, not the fieldset inside it. A
               fieldset given overflow-y:auto reports a scroll range but does not
               CLIP, so the rows keep painting past the card's bottom edge and
               over the page behind it. See the class doc (AECI-925). -->
          <div class="min-h-0 flex-1 overflow-y-auto">
            <fieldset class="border-0 p-0">
              <legend class="sr-only">{{ heading() }}</legend>
              <ul>
                @for (term of terms(); track term.slug) {
                  <li class="border-b border-(--border-default) last:border-b-0">
                    <label
                      class="flex cursor-pointer items-start gap-3 px-6 py-3 transition-colors hover:bg-(--surface-sunken) md:px-8"
                    >
                      <input
                        type="checkbox"
                        class="mt-0.5 h-4 w-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        [checked]="isDrafted(term.slug)"
                        (change)="toggle(term.slug)"
                      />
                      <span class="min-w-0 flex-1 sm:flex sm:items-start sm:gap-4">
                        <span
                          class="block text-sm font-medium text-(--text-primary) sm:w-56 sm:shrink-0"
                          >{{ term.name }}</span
                        >
                        @if (term.description; as d) {
                          <span
                            class="mt-0.5 block text-xs leading-relaxed text-(--text-secondary) sm:mt-0 sm:min-w-0 sm:flex-1"
                            >{{ d }}</span
                          >
                        }
                      </span>
                    </label>
                  </li>
                }
              </ul>
            </fieldset>
          </div>

          <div
            class="shrink-0 border-t border-(--border-default) p-6 md:p-8"
            [class.pt-4]="saveFailed()"
          >
            @if (saveFailed()) {
              <p class="mb-4 text-sm font-medium text-(--text-primary)" role="alert">
                <span i18n="@@vendor.product.taxonomy.editor.error"
                  >Something went wrong saving these. Your choices are still here, so try
                  again.</span
                >
              </p>
            }
            <div class="flex flex-wrap items-center justify-between gap-4">
              @if (overCap()) {
                <p class="text-sm font-medium text-(--text-primary)" role="alert">
                  {{ overCapMessage }}
                </p>
              } @else {
                <p class="text-sm text-(--text-secondary)">{{ counter() }}</p>
              }
              <div class="flex flex-wrap items-center gap-3">
                <button
                  brnDialogClose
                  type="button"
                  [class]="cancelClass"
                  i18n="@@vendor.product.taxonomy.editor.cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  [disabled]="saveDisabled()"
                  [class]="saveClass"
                  (click)="commit()"
                >
                  @if (saving()) {
                    <span i18n="@@vendor.product.taxonomy.editor.saving">Saving…</span>
                  } @else {
                    <span i18n="@@vendor.product.taxonomy.editor.save">Save</span>
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      </ng-template>
    </brn-dialog>
  `,
  /** `contents` would make the trigger AND the (zero-size) `brn-dialog` separate
   *  flex items of the caller's row, so a `justify-between` header would space
   *  the pencil against the dialog element rather than against the card edge. */
  styles: [':host { display: inline-flex; }'],
})
export class VendorTaxonomyFacetDialog {
  /** The facet's display name ("Categories"), used in the heading and the
   *  trigger's accessible name. */
  readonly legend = input.required<string>();
  /** The AECI-913 facet hint. Rendered in full here; tooltipped on the page. */
  readonly hint = input<string | undefined>(undefined);
  /** The FULL vocabulary for this facet, in display order. */
  readonly terms = input.required<readonly TaxonomyTermWithCount[]>();
  /** The committed selection. Re-read on every open, so a save elsewhere is
   *  picked up rather than the draft going stale against the server. */
  readonly selected = input.required<readonly string[]>();
  /** The endpoint's per-facet cap (`termSlugList`). */
  readonly maxTerms = input.required<number>();
  /** No `product.taxonomy.edit` capability, or the vocabulary never loaded. */
  readonly disabled = input<boolean>(false);
  /**
   * Persist the draft. Resolves `true` when it committed. See the class doc for
   * why this is a function input and not an output.
   */
  readonly save = input.required<(slugs: string[]) => Promise<boolean>>();

  private readonly dialog = viewChild(BrnDialog);

  protected readonly draft = signal<readonly string[]>([]);
  protected readonly saving = signal(false);
  protected readonly saveFailed = signal(false);

  protected readonly triggerClass =
    'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) border border-(--border-default) text-(--text-secondary) transition-colors hover:border-(--border-strong) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-40';
  protected readonly cancelClass =
    'cursor-pointer rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly saveClass =
    'inline-flex cursor-pointer items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

  protected readonly heading = computed(
    () => $localize`:@@vendor.product.taxonomy.editor.heading:Edit ${this.legend()}:FACET:`,
  );
  protected readonly triggerLabel = computed(
    () => $localize`:@@vendor.product.taxonomy.editor.trigger:Edit ${this.legend()}:FACET:`,
  );

  protected readonly overCap = computed(() => this.draft().length > this.maxTerms());
  protected readonly overCapMessage = $localize`:@@vendor.product.taxonomy.editor.tooMany:Too many. Remove some to get back under the limit.`;
  protected readonly counter = computed(
    () =>
      $localize`:@@vendor.product.taxonomy.editor.counter:${this.draft().length}:COUNT: of ${this.maxTerms()}:MAX: selected`,
  );

  /** Order-insensitive: reordering the same terms is not an edit. */
  protected readonly dirty = computed(() => !sameSet(this.draft(), this.selected()));
  protected readonly saveDisabled = computed(() => this.saving() || this.overCap());

  protected isDrafted(slug: string): boolean {
    return this.draft().includes(slug);
  }

  protected toggle(slug: string): void {
    this.draft.update((d) => (d.includes(slug) ? d.filter((s) => s !== slug) : [...d, slug]));
    this.saveFailed.set(false);
  }

  /** Seed the draft from the committed set, then open. Imperative on purpose —
   *  see the NG0602 note in the class doc. */
  protected openEditor(): void {
    this.draft.set([...this.selected()]);
    this.saveFailed.set(false);
    this.saving.set(false);
    this.dialog()?.open();
  }

  protected async commit(): Promise<void> {
    if (this.overCap() || this.saving()) return;
    // Nothing changed: close without a PATCH. The endpoint requires at least one
    // changed field, so an empty body would 400.
    if (!this.dirty()) {
      this.dialog()?.close();
      return;
    }
    this.saving.set(true);
    this.saveFailed.set(false);
    try {
      const ok = await this.save()([...this.draft()]);
      if (ok) this.dialog()?.close();
      else this.saveFailed.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}

/**
 * Order-insensitive set equality, byte-identical to the parent form's own
 * `sameSet`. A bare `.sort()` on purpose: these are SLUGS, which AECI-825
 * explicitly leaves on binary ordering, and this is an equality test where any
 * consistent total order gives the same answer.
 */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}
