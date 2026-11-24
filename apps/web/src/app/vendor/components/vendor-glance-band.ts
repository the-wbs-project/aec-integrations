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

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import { AecIcon } from '../../shared/icon/icon';
import type { ProductClaimCount } from '../overview/vendor-overview-model';

/**
 * The overview's glance band (AECI-983): In conflict, and Suggestions about
 * your listing. A two-second read above the "What needs you" list. The Views
 * tile was removed on 2026-10-13 (Chris): performance reporting has not shipped,
 * so the band shows only the two tiles that carry a figure.
 *
 * Presentational. The section computes every figure from `VendorPortalStore`
 * through `vendor-overview-model.ts` and passes it in, and owns the retry.
 *
 * ── VOCABULARY ──────────────────────────────────────────────────────────────
 * The former home stats cards (since removed from the home), the sanctioned figure row,
 * now on the shared white card (`aecCard`, AECI-1810, mock-up 13): a large Source Serif
 * numeral, a quiet line beneath. Two tiles side by side from 360px, one above the
 * other below it. Not the admin `StatTile`, whose chart hues DESIGN.md keeps inside
 * `/admin`.
 *
 * Rules on top of it:
 *  - **A zero is never a bare 0.** It renders a sentence ("No conflicts").
 *  - **Only a tile with something to do is a link.** At zero the tile is a plain card with a
 *    green check badge; with conflicts it is a link with a red X badge. One
 *    conflicted product links to its filtered Integrations tab, several link to
 *    Products. The Suggestions tile follows the same rule: a link to Messages with an
 *    attention badge when open, a plain check card at none.
 *  - **A non-zero conflict figure is `--status-error`**, a deliberate departure
 *    from the home cards' Forest figures: `conflict` is the one sanctioned red,
 *    and a conflict count that looks like good news defeats the tile. At zero
 *    there is no figure, so red never appears for good news.
 *  - **A link tile lifts on hover** (the interactive card), and its label turns
 *    Forest and underlines. The `group/card` wrapper holds the hover, so the
 *    tile does not flicker as it rises.
 *
 * Every label row is `sm:min-h-11` (two lines), and `min-h-16` (three) on a phone,
 * so a label that wraps does not push its figure below the other tile's.
 */
@Component({
  selector: 'aec-vendor-glance-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AecButton, AecCard, AecIcon],
  template: `
    <section class="grid grid-cols-1 gap-4 min-[360px]:grid-cols-2" [attr.aria-label]="regionLabel">
      <!-- In conflict. aria-busy while the integrations read settles; no
           role="status", the shell owns the one announcement channel. -->
      <div class="group/card" [attr.aria-busy]="conflictsLoading()">
        @if (conflictsLoading()) {
          <div aecCard class="flex h-full flex-col gap-2 p-6">
            <div [class]="labelRowClass">
              <p [class]="labelClass" i18n="@@vendor.overview.conflict.label">In conflict</p>
            </div>
            <p [class]="lineClass" i18n="@@vendor.overview.conflict.loading">
              Checking your data flows…
            </p>
          </div>
        } @else if (conflictsFailed()) {
          <div aecCard class="flex h-full flex-col gap-2 p-6">
            <div [class]="labelRowClass">
              <p [class]="labelClass" i18n="@@vendor.overview.conflict.label">In conflict</p>
            </div>
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.overview.conflict.failed">
              Could not load your data flows.
            </p>
            <button
              aecButton
              variant="secondary"
              compact
              type="button"
              class="self-start"
              (click)="retry.emit()"
              i18n="@@vendor.overview.conflict.retry"
            >
              Try again
            </button>
          </div>
        } @else {
          @if (conflictTotal() > 0) {
            <a
              aecCard
              interactive
              [routerLink]="conflictLink()"
              [queryParams]="conflictQueryParams()"
              class="flex h-full flex-col gap-2 p-6 text-(--text-primary) no-underline"
              [attr.aria-label]="conflictAria()"
              data-tile="conflict"
            >
              <div [class]="labelRowClass">
                <p [class]="labelLinkClass" i18n="@@vendor.overview.conflict.label">In conflict</p>
              </div>
              <div class="flex items-center gap-3">
                <span [class]="badgeClass" class="bg-(--status-error)" aria-hidden="true">
                  <aec-icon name="x" decorative [size]="4" />
                </span>
                <p [class]="figureClass" class="text-(--status-error)">{{ conflictTotal() }}</p>
              </div>
              <p [class]="lineClass">{{ conflictLine() }}</p>
            </a>
          } @else {
            <div aecCard class="flex h-full flex-col gap-2 p-6" data-tile="conflict">
              <div [class]="labelRowClass">
                <p [class]="labelClass" i18n="@@vendor.overview.conflict.label">In conflict</p>
              </div>
              <div class="flex flex-wrap items-center gap-3">
                <span [class]="badgeClass" class="bg-(--accent-primary)" aria-hidden="true">
                  <aec-icon name="check" decorative [size]="4" />
                </span>
                <p [class]="zeroClass" i18n="@@vendor.overview.conflict.zero">No conflicts</p>
              </div>
              <p [class]="lineClass" i18n="@@vendor.overview.conflict.zeroLine">
                Nobody has contradicted what you have recorded
              </p>
            </div>
          }
        }
      </div>

      <!-- Suggestions = open corrections. The body and the submitter are off the
           wire, so the copy reports a state and never implies a reply. -->
      <div class="group/card">
        @if (openCorrections() > 0) {
          <a
            aecCard
            interactive
            [routerLink]="['..', 'messages']"
            class="flex h-full flex-col gap-2 p-6 text-(--text-primary) no-underline"
            [attr.aria-label]="suggestionsAria()"
            data-tile="suggestions"
          >
            <div [class]="labelRowClass">
              <p [class]="labelLinkClass" i18n="@@vendor.overview.suggestions.label">
                Suggestions about your listing
              </p>
            </div>
            <div class="flex items-center gap-3">
              <span [class]="badgeClass" class="bg-(--accent-primary)" aria-hidden="true">
                <aec-icon name="exclamation" decorative [size]="4" />
              </span>
              <p [class]="figureClass" class="text-(--accent-primary)">{{ openCorrections() }}</p>
            </div>
            @if (newestLine(); as line) {
              <p [class]="lineClass">{{ line }}</p>
            }
          </a>
        } @else {
          <div aecCard class="flex h-full flex-col gap-2 p-6" data-tile="suggestions">
            <div [class]="labelRowClass">
              <p [class]="labelClass" i18n="@@vendor.overview.suggestions.label">
                Suggestions about your listing
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-3">
              <span [class]="badgeClass" class="bg-(--accent-primary)" aria-hidden="true">
                <aec-icon name="check" decorative [size]="4" />
              </span>
              <p [class]="zeroClass" i18n="@@vendor.overview.suggestions.zero">None open</p>
            </div>
            <p [class]="lineClass" i18n="@@vendor.overview.suggestions.zeroLine">
              Anyone can suggest a correction from your public pages
            </p>
          </div>
        }
      </div>
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

  protected readonly regionLabel = $localize`:@@vendor.overview.glance.aria:Your account at a glance`;

  /**
   * One conflicted product: straight to its Integrations tab, filtered. Several:
   * the Products list, since one tile cannot link to them all.
   */
  protected readonly conflictLink = computed<readonly string[]>(() => {
    const rows = this.conflictProducts();
    return rows.length === 1
      ? ['..', 'products', rows[0]!.product.slug, 'integrations']
      : ['..', 'products'];
  });

  protected readonly conflictQueryParams = computed(() =>
    this.conflictProducts().length === 1 ? { status: 'disagreement' } : null,
  );

  protected readonly conflictLine = computed(() => {
    const rows = this.conflictProducts();
    if (rows.length === 1) {
      return $localize`:@@vendor.overview.conflict.onProduct:On ${rows[0]!.product.name}:PRODUCT:`;
    }
    return $localize`:@@vendor.overview.conflict.acrossProducts:Across ${rows.length}:COUNT: products`;
  });

  protected readonly conflictAria = computed(() => {
    const total = this.conflictTotal();
    const rows = this.conflictProducts();
    if (rows.length === 1) {
      const name = rows[0]!.product.name;
      return total === 1
        ? $localize`:@@vendor.overview.conflict.aria.one:1 data flow in conflict. Open ${name}:PRODUCT:.`
        : $localize`:@@vendor.overview.conflict.aria.many:${total}:COUNT: data flows in conflict. Open ${name}:PRODUCT:.`;
    }
    return $localize`:@@vendor.overview.conflict.aria.products:${total}:COUNT: data flows in conflict across ${rows.length}:PRODUCTS: products. Open your products.`;
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
    return n === 1
      ? $localize`:@@vendor.overview.suggestions.aria.one:1 suggestion about your listing is open. Open messages.`
      : $localize`:@@vendor.overview.suggestions.aria.many:${n}:COUNT: suggestions about your listing are open. Open messages.`;
  });

  /** The label row holds two lines of label (three on a phone, where the tiles are
   *  narrow), so the figures line up when one label wraps and the other does not. */
  protected readonly labelRowClass = 'flex items-start min-[360px]:min-h-16 sm:min-h-11';
  protected readonly labelClass = 'text-sm font-semibold text-(--text-primary)';
  /** On a link tile the label takes the card title's hover: Forest, underlined. */
  protected readonly labelLinkClass = `${this.labelClass} underline-offset-4 group-hover/card:text-(--accent-primary) group-hover/card:underline`;
  protected readonly badgeClass =
    'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-(--surface-base)';
  protected readonly figureClass = 'font-display text-5xl font-semibold tabular-nums';
  protected readonly zeroClass = 'font-display text-t-20 font-semibold text-(--text-primary)';
  protected readonly lineClass = 'text-t-13 text-(--text-secondary)';
}
