import { Component, input, output } from '@angular/core';

/**
 * Generic numeric range facet widget (AECI-142): a min/max number-input pair
 * bound to a `connectRange` render-state slice (vendor `founded_year`, §7.2).
 * The index-wide `bounds` become the input placeholders + native min/max; the
 * current `start` seeds the values. Emitting `undefined` for a blank side leaves
 * that bound open.
 *
 * a11y: `<fieldset>`/`<legend>` names the group; each input has an explicit (sr-only)
 * `<label>` tied by `for`/`id` so the min and max fields are distinguishable.
 */
@Component({
  selector: 'aec-search-range-input',
  template: `
    <fieldset class="border-0 p-0">
      <legend
        class="mb-2 text-xs font-semibold tracking-[0.08em] text-(--text-secondary) uppercase"
      >
        {{ label() }}
      </legend>
      <div class="flex items-center gap-2">
        <label class="sr-only" [attr.for]="name() + '-min'" i18n="@@search.range.min"
          >Minimum</label
        >
        <input
          #minInput
          type="number"
          [id]="name() + '-min'"
          class="h-9 w-20 rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-2 text-sm tabular-nums text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          [value]="start()[0] ?? ''"
          [attr.min]="bounds().min ?? null"
          [attr.max]="bounds().max ?? null"
          [attr.placeholder]="bounds().min ?? null"
          (change)="emit(minInput.value, maxInput.value)"
        />
        <span class="text-(--text-secondary)" aria-hidden="true">–</span>
        <label class="sr-only" [attr.for]="name() + '-max'" i18n="@@search.range.max"
          >Maximum</label
        >
        <input
          #maxInput
          type="number"
          [id]="name() + '-max'"
          class="h-9 w-20 rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-2 text-sm tabular-nums text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          [value]="start()[1] ?? ''"
          [attr.min]="bounds().min ?? null"
          [attr.max]="bounds().max ?? null"
          [attr.placeholder]="bounds().max ?? null"
          (change)="emit(minInput.value, maxInput.value)"
        />
      </div>
    </fieldset>
  `,
})
export class SearchRangeInput {
  /** Localized facet heading (e.g. "Founded"). */
  readonly label = input.required<string>();
  /** Unique field id/name prefix (page passes e.g. `vendors:founded_year`). */
  readonly name = input.required<string>();
  /** Index-wide `{ min, max }` bounds for placeholders + native validation. */
  readonly bounds = input.required<{ min?: number; max?: number }>();
  /** Current `[min, max]` refinement. */
  readonly start = input.required<readonly [number | undefined, number | undefined]>();
  /** Emits the new `[min, max]` (either side `undefined` to leave it open). */
  readonly refine = output<[number | undefined, number | undefined]>();

  protected emit(minRaw: string, maxRaw: string): void {
    this.refine.emit([this.parse(minRaw), this.parse(maxRaw)]);
  }

  private parse(raw: string): number | undefined {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
}
