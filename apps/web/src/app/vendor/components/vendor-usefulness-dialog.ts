import { Component, computed, input, output, signal, viewChild } from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import type { ProductUsefulness, TaxonomyTermWithCount } from '@aeci/shared';

/** Which half of the value this dialog edits. Mirrors `ProductUsefulness`. */
export type UsefulnessFacet = 'audiences' | 'phases';

/** A draft row: one taxonomy term, plus its bullets as raw textarea text. */
interface DraftRow {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly checked: boolean;
  readonly text: string;
}

/**
 * The pencil beside a "How teams use it" facet heading on the vendor product
 * form, and the modal it opens (AECI-963 / `STAGE_2_5_SPEC.md` §12).
 *
 * ── WHY THIS SHAPE, AND NOT A LIST OF GROUP CARDS ────────────────────────────
 * The obvious design is "a list of groups, each with a term picker and add/remove
 * buttons for its bullets". It was rejected for two reasons. The term picker
 * would be a custom combobox over 36 audiences (Angular Aria 22 ships no
 * `select`), and a bullet list with add/remove/reorder is a micro-UI with its own
 * focus-management and announcement rules — a lot of invented interaction for
 * something the vendor experiences as "write a few lines".
 *
 * Instead this borrows {@link VendorTaxonomyFacetDialog}'s row-per-term shape
 * wholesale: the vocabulary is the list, a native checkbox says "I have something
 * to say about this one", and checking it reveals a textarea holding ONE BULLET
 * PER LINE. That buys three things. The term binding is a native checkbox rather
 * than a custom widget. Reordering bullets is ordinary text editing, which needs
 * no drag affordance and no keyboard alternative to it. And a group with zero
 * points — which `UsefulnessGroupSchema` forbids — is caught by one check instead
 * of being representable at all.
 *
 * The cost is that blank lines and trailing whitespace are the vendor's to make
 * and ours to clean; {@link toPoints} is that cleanup, and it is deliberately
 * total (it can never throw and never produces an empty point).
 *
 * ── IT STAGES. IT DOES NOT PERSIST. ──────────────────────────────────────────
 * This is the one deliberate divergence from the taxonomy dialog next door, whose
 * class doc argues at length that a staging Save would be a lie because
 * `apps/web` has no `CanDeactivate` guard. That argument does not carry here,
 * because this dialog hands its result to the parent form's DIRTY-DIFF, which is
 * protected: `VendorPortalStore.markDirty` stashes incoming payloads and the
 * "changed somewhere else / your unsaved changes are still here" banner covers
 * it. A staged usefulness edit is exactly as safe as a half-typed description,
 * and no safer — which is the standard the rest of this form already sets.
 *
 * Do not "fix" this to match the sibling without re-reading both paragraphs.
 *
 * ── OPEN IS IMPERATIVE ───────────────────────────────────────────────────────
 * `BrnDialog.open()` from the click handler, never an `effect()` — the latter
 * throws NG0602 (hit on AECI-218). Same rule as every other dialog here.
 */
@Component({
  selector: 'aec-vendor-usefulness-dialog',
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
                i18n-aria-label="@@vendor.product.usefulness.editor.close"
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

            <p
              brnDialogDescription
              class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@vendor.product.usefulness.editor.hint"
            >
              Tick a term you have something concrete to say about, then write one short line per
              point. Say what someone in that role actually does with your product, not what it
              could do. This publishes to your product page as soon as you save, with no review.
            </p>
          </div>

          <!-- The scroll container is this DIV and not the fieldset. A fieldset
               given overflow-y:auto reports a scroll range but does not CLIP, so
               rows keep painting past the card's bottom edge (AECI-925). -->
          <div class="min-h-0 flex-1 overflow-y-auto">
            <fieldset class="border-0 p-0">
              <legend class="sr-only">{{ heading() }}</legend>
              <ul>
                @for (row of rows(); track row.slug) {
                  <li class="border-b border-(--border-default) last:border-b-0">
                    <label
                      class="flex cursor-pointer items-start gap-3 px-6 py-3 transition-colors hover:bg-(--surface-sunken) md:px-8"
                    >
                      <input
                        type="checkbox"
                        class="mt-0.5 h-4 w-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        [checked]="row.checked"
                        (change)="toggle(row.slug)"
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

                    @if (row.checked) {
                      <!-- OUTSIDE the label above: nesting a textarea inside a
                           label makes every keystroke's click target toggle the
                           checkbox, and folds the whole draft into the
                           checkbox's accessible name. -->
                      <div class="px-6 pb-4 ps-12 md:px-8 md:ps-14">
                        <label [for]="pointsId(row.slug)" class="sr-only">{{
                          pointsLabel(row.name)
                        }}</label>
                        <textarea
                          [id]="pointsId(row.slug)"
                          rows="3"
                          [value]="row.text"
                          (input)="onPointsInput(row.slug, $event)"
                          [attr.aria-describedby]="pointsId(row.slug) + '-help'"
                          [attr.aria-invalid]="rowError(row) ? 'true' : null"
                          class="w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        ></textarea>
                        @if (rowError(row); as err) {
                          <p
                            [id]="pointsId(row.slug) + '-help'"
                            class="mt-1 text-xs font-medium text-(--text-primary)"
                            role="alert"
                          >
                            {{ err }}
                          </p>
                        } @else {
                          <p
                            [id]="pointsId(row.slug) + '-help'"
                            class="mt-1 text-xs text-(--text-secondary)"
                          >
                            {{ pointsCounter(row) }}
                          </p>
                        }
                      </div>
                    }
                  </li>
                }
              </ul>
            </fieldset>
          </div>

          <div class="shrink-0 border-t border-(--border-default) p-6 md:p-8">
            <div class="flex flex-wrap items-center justify-between gap-4">
              @if (errorMessage(); as err) {
                <p class="text-sm font-medium text-(--text-primary)" role="alert">{{ err }}</p>
              } @else {
                <p class="text-sm text-(--text-secondary)">{{ counter() }}</p>
              }
              <div class="flex flex-wrap items-center gap-3">
                <button
                  brnDialogClose
                  type="button"
                  [class]="cancelClass"
                  i18n="@@vendor.product.usefulness.editor.cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  [disabled]="errorMessage() !== null"
                  [class]="saveClass"
                  (click)="commit()"
                  i18n="@@vendor.product.usefulness.editor.done"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      </ng-template>
    </brn-dialog>
  `,
  /** `contents` would make the trigger AND the zero-size `brn-dialog` separate
   *  flex items of the caller's header row, so `justify-between` would space the
   *  pencil against the dialog element rather than the card edge. */
  styles: [':host { display: inline-flex; }'],
})
export class VendorUsefulnessDialog {
  /** Which half of the value this instance owns. */
  readonly facet = input.required<UsefulnessFacet>();
  /** The facet's display name, e.g. "By audience". */
  readonly legend = input.required<string>();
  /** The FULL vocabulary for this facet, in the curated `/api/taxonomy` order.
   *  Deliberately NOT re-sorted: that order is editorial. */
  readonly terms = input.required<readonly TaxonomyTermWithCount[]>();
  /** The committed value for BOTH facets. Re-read on every open so a save
   *  elsewhere is picked up rather than the draft going stale. */
  readonly value = input.required<ProductUsefulness | null>();
  /** Groups per facet (`VendorUsefulnessSchema`). */
  readonly maxGroups = input.required<number>();
  /** Points per group, and characters per point. */
  readonly maxPoints = input.required<number>();
  readonly maxPointLength = input.required<number>();
  /** No capability, or the vocabulary never loaded. */
  readonly disabled = input<boolean>(false);

  /** The staged replacement for THIS facet. The parent merges it with the other
   *  half and folds the result into its dirty-diff. */
  readonly apply = output<readonly { slug: string; points: string[] }[]>();

  private readonly dialog = viewChild(BrnDialog);

  /** slug → raw textarea text. A slug present here is a checked row, even when
   *  its text is empty — which is precisely the state {@link errorMessage}
   *  blocks, because `points` has a `.min(1)` floor. */
  private readonly draft = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly triggerClass =
    'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-(--radius-sm) border border-(--border-default) text-(--text-secondary) transition-colors hover:border-(--border-strong) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-40';
  protected readonly cancelClass =
    'cursor-pointer rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly saveClass =
    'inline-flex cursor-pointer items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

  protected readonly heading = computed(
    () => $localize`:@@vendor.product.usefulness.editor.heading:Edit ${this.legend()}:FACET:`,
  );
  protected readonly triggerLabel = computed(
    () => $localize`:@@vendor.product.usefulness.editor.trigger:Edit ${this.legend()}:FACET:`,
  );

  protected readonly rows = computed<readonly DraftRow[]>(() => {
    const d = this.draft();
    return this.terms().map((term) => ({
      slug: term.slug,
      name: term.name,
      description: term.description,
      checked: d.has(term.slug),
      text: d.get(term.slug) ?? '',
    }));
  });

  private readonly checkedRows = computed(() => this.rows().filter((r) => r.checked));

  protected readonly counter = computed(
    () =>
      $localize`:@@vendor.product.usefulness.editor.counter:${this.checkedRows().length}:COUNT: of ${this.maxGroups()}:MAX: described`,
  );

  /**
   * The single blocking message, resolved in priority order so the footer never
   * has to show two at once. Every branch mirrors a `VendorUsefulnessSchema`
   * rule, so a draft this accepts is one the server accepts.
   */
  protected readonly errorMessage = computed<string | null>(() => {
    const checked = this.checkedRows();
    if (checked.length > this.maxGroups()) {
      return $localize`:@@vendor.product.usefulness.editor.tooManyGroups:Too many. Untick some to get back under the limit.`;
    }
    for (const row of checked) {
      const err = this.rowError(row);
      if (err)
        return $localize`:@@vendor.product.usefulness.editor.fixRow:${row.name}:TERM: needs attention. ${err}:DETAIL:`;
    }
    return null;
  });

  /** Per-row validity, also used to drive `aria-invalid` on the textarea. */
  protected rowError(row: DraftRow): string | null {
    const points = toPoints(row.text);
    if (points.length === 0) {
      return $localize`:@@vendor.product.usefulness.editor.emptyPoints:Write at least one line, or untick it.`;
    }
    if (points.length > this.maxPoints()) {
      return $localize`:@@vendor.product.usefulness.editor.tooManyPoints:Keep it to ${this.maxPoints()}:MAX: lines or fewer.`;
    }
    if (points.some((p) => p.length > this.maxPointLength())) {
      return $localize`:@@vendor.product.usefulness.editor.pointTooLong:One line is too long. Keep each under ${this.maxPointLength()}:MAX: characters.`;
    }
    return null;
  }

  protected pointsCounter(row: DraftRow): string {
    return $localize`:@@vendor.product.usefulness.editor.pointsCounter:${toPoints(row.text).length}:COUNT: of ${this.maxPoints()}:MAX: lines`;
  }

  protected pointsLabel(name: string): string {
    return $localize`:@@vendor.product.usefulness.editor.pointsLabel:What ${name}:TERM: does with it, one point per line`;
  }

  protected pointsId(slug: string): string {
    return `usefulness-${this.facet()}-${slug}`;
  }

  protected toggle(slug: string): void {
    this.draft.update((d) => {
      const next = new Map(d);
      if (next.has(slug)) next.delete(slug);
      else next.set(slug, '');
      return next;
    });
  }

  protected onPointsInput(slug: string, event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value;
    this.draft.update((d) => new Map(d).set(slug, text));
  }

  /** Seed from the committed value, then open. Imperative on purpose — see the
   *  NG0602 note in the class doc. */
  protected openEditor(): void {
    const groups = this.value()?.[this.facet()] ?? [];
    this.draft.set(new Map(groups.map((g) => [g.slug, g.points.join('\n')])));
    this.dialog()?.open();
  }

  protected commit(): void {
    if (this.errorMessage() !== null) return;
    this.apply.emit(
      this.checkedRows().map((row) => ({ slug: row.slug, points: toPoints(row.text) })),
    );
    this.dialog()?.close();
  }
}

/**
 * One textarea's worth of text → the `points` array.
 *
 * Total by construction: it never throws and never yields an empty string, so a
 * vendor's trailing newline or double-spaced paragraph break cannot produce a
 * point that `UsefulnessGroupSchema`'s `.min(1)` on each entry would reject. An
 * all-whitespace textarea yields `[]`, which is what makes "ticked but empty" a
 * detectable state rather than a silently-dropped group.
 */
export function toPoints(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
