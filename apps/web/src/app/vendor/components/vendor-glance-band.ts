import { formatDate } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductClaimCount } from '../overview/vendor-overview-model';

import { VendorViewsTile, type VendorViewsPeriod } from './vendor-views-tile';

/**
 * The overview's glance band (AECI-983): Views, In conflict, and Suggestions
 * about your listing. A two-second read above the "What needs you" list.
 *
 * Presentational. The section computes every figure from `VendorPortalStore`
 * through `vendor-overview-model.ts` and passes it in, and owns the retry.
 *
 * ── VOCABULARY ──────────────────────────────────────────────────────────────
 * `home/home-stats-cards.ts`, the sanctioned three-up figure row: bordered
 * `--surface-raised` cards, a large Source Serif numeral, a quiet line beneath.
 * Not the admin `StatTile`, whose chart hues DESIGN.md keeps inside `/admin`.
 *
 * Three rules on top of it:
 *  - **A zero is never a bare 0.** It renders a sentence ("No conflicts").
 *  - **A non-zero conflict figure is `--status-error`**, a deliberate departure
 *    from the home cards' Forest figures: `conflict` is the one sanctioned red,
 *    and a conflict count that looks like good news defeats the tile. At zero
 *    there is no figure, so red never appears for good news.
 *  - **Hover moves the surface, not the border.** A border-colour utility never
 *    applies here (the unlayered `*` rule in `styles.css`).
 *
 * Every label row is `min-h-9` (the Views toggle's height), and `md:min-h-12` so
 * a label that wraps to two lines at `md` does not push its figure below the rest.
 */
@Component({
  selector: 'aec-vendor-glance-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, VendorViewsTile],
  template: `
    <section class="grid grid-cols-1 gap-4 md:grid-cols-3" [attr.aria-label]="regionLabel">
      <aec-vendor-views-tile (periodChange)="viewsPeriodChange.emit($event)" />

      <!-- In conflict. aria-busy while the integrations read settles; no
           role="status", the shell owns the one announcement channel. -->
      <div [attr.aria-busy]="conflictsLoading()">
        @if (conflictsLoading()) {
          <div [class]="tileClass">
            <div class="flex min-h-9 md:min-h-12 items-center">
              <p [class]="labelClass" i18n="@@vendor.overview.conflict.label">In conflict</p>
            </div>
            <p class="text-sm text-(--text-secondary)" i18n="@@vendor.overview.conflict.loading">
              Checking your data flows…
            </p>
          </div>
        } @else if (conflictsFailed()) {
          <div [class]="tileClass">
            <div class="flex min-h-9 md:min-h-12 items-center">
              <p [class]="labelClass" i18n="@@vendor.overview.conflict.label">In conflict</p>
            </div>
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.overview.conflict.failed">
              Could not load your data flows.
            </p>
            <button
              type="button"
              class="self-start rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              (click)="retry.emit()"
              i18n="@@vendor.overview.conflict.retry"
            >
              Try again
            </button>
          </div>
        } @else {
          <a
            [routerLink]="conflictLink()"
            [queryParams]="conflictTotal() > 0 ? conflictQueryParams : null"
            [class]="tileLinkClass"
            [attr.aria-label]="conflictAria()"
            data-tile="conflict"
          >
            <div class="flex min-h-9 md:min-h-12 items-center">
              <p [class]="labelClass" i18n="@@vendor.overview.conflict.label">In conflict</p>
            </div>
            @if (conflictTotal() > 0) {
              <p [class]="figureClass" class="text-(--status-error)">{{ conflictTotal() }}</p>
              <p class="text-sm text-(--text-secondary)">{{ conflictLine() }}</p>
            } @else {
              <p [class]="zeroClass" i18n="@@vendor.overview.conflict.zero">No conflicts</p>
              <p class="text-sm text-(--text-secondary)" i18n="@@vendor.overview.conflict.zeroLine">
                Nobody has contradicted what you have recorded
              </p>
            }
          </a>
        }
      </div>

      <!-- Suggestions = open corrections. The body and the submitter are off the
           wire, so the copy reports a state and never implies a reply. -->
      <a
        [routerLink]="['..', 'messages']"
        [class]="tileLinkClass"
        [attr.aria-label]="suggestionsAria()"
        data-tile="suggestions"
      >
        <div class="flex min-h-9 md:min-h-12 items-center">
          <p [class]="labelClass" i18n="@@vendor.overview.suggestions.label">
            Suggestions about your listing
          </p>
        </div>
        @if (openCorrections() > 0) {
          <p [class]="figureClass" class="text-(--accent-primary)">{{ openCorrections() }}</p>
          @if (newestLine(); as line) {
            <p class="text-sm text-(--text-secondary)">{{ line }}</p>
          }
        } @else {
          <p [class]="zeroClass" i18n="@@vendor.overview.suggestions.zero">None open</p>
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.overview.suggestions.zeroLine">
            Anyone can suggest a correction from your public pages
          </p>
        }
      </a>
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorGlanceBand {
  private readonly locale = inject(LOCALE_ID);

  /** Distinct conflict claims, vendor-wide (deduped by claim id). */
  readonly conflictTotal = input.required<number>();
  /** Per-product conflict rows, for the line and the link target. */
  readonly conflictProducts = input.required<readonly ProductClaimCount[]>();
  readonly conflictsLoading = input(false);
  readonly conflictsFailed = input(false);

  readonly openCorrections = input.required<number>();
  readonly newestCorrectionAt = input<string | null>(null);

  readonly retry = output<void>();
  readonly viewsPeriodChange = output<VendorViewsPeriod>();

  protected readonly regionLabel = $localize`:@@vendor.overview.glance.aria:Your account at a glance`;

  protected readonly conflictLink = computed<readonly string[]>(() => {
    const first = this.conflictProducts()[0];
    return this.conflictTotal() > 0 && first
      ? ['..', 'products', first.product.slug, 'integrations']
      : ['..', 'products'];
  });

  /** Lands on the Integrations tab filtered to conflicts (AECI-999). */
  protected readonly conflictQueryParams = { status: 'conflict' } as const;

  protected readonly conflictLine = computed(() => {
    const rows = this.conflictProducts();
    if (rows.length === 1) {
      return $localize`:@@vendor.overview.conflict.onProduct:On ${rows[0]!.product.name}:PRODUCT:`;
    }
    return $localize`:@@vendor.overview.conflict.acrossProducts:Across ${rows.length}:COUNT: products`;
  });

  protected readonly conflictAria = computed(() => {
    const total = this.conflictTotal();
    const first = this.conflictProducts()[0];
    if (total === 0 || !first) {
      return $localize`:@@vendor.overview.conflict.aria.zero:No data flows in conflict. Open your products.`;
    }
    return total === 1
      ? $localize`:@@vendor.overview.conflict.aria.one:1 data flow in conflict. Open ${first.product.name}:PRODUCT:.`
      : $localize`:@@vendor.overview.conflict.aria.many:${total}:COUNT: data flows in conflict. Open ${first.product.name}:PRODUCT:.`;
  });

  /**
   * Formatted in UTC, the `vendor-plan-panel` precedent: the SSR Worker runs in
   * UTC and the browser does not, so a zone-local date could differ either side
   * of midnight and trip a hydration mismatch.
   */
  protected readonly newestLine = computed<string | null>(() => {
    const raw = this.newestCorrectionAt();
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    const formatted = formatDate(date, 'MMMM d, y', this.locale, 'UTC');
    return $localize`:@@vendor.overview.suggestions.newest:Newest filed ${formatted}:DATE:`;
  });

  protected readonly suggestionsAria = computed(() => {
    const n = this.openCorrections();
    if (n === 0) {
      return $localize`:@@vendor.overview.suggestions.aria.zero:No suggestions about your listing are open. Open messages.`;
    }
    return n === 1
      ? $localize`:@@vendor.overview.suggestions.aria.one:1 suggestion about your listing is open. Open messages.`
      : $localize`:@@vendor.overview.suggestions.aria.many:${n}:COUNT: suggestions about your listing are open. Open messages.`;
  });

  protected readonly tileClass =
    'flex h-full flex-col gap-2 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6';
  protected readonly tileLinkClass = `${this.tileClass} no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)`;
  protected readonly labelClass = 'text-sm text-(--text-secondary)';
  protected readonly figureClass = 'font-display text-5xl font-semibold tabular-nums';
  protected readonly zeroClass = 'font-display text-2xl font-semibold text-(--text-primary)';
}
