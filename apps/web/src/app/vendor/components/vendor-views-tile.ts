import { ChangeDetectionStrategy, Component, computed, output, signal } from '@angular/core';

/** The three windows. Each is a run of COMPLETE UTC days
 *  (`docs/VENDOR_PERFORMANCE_SPEC.md` §5.2): `day` is yesterday, not the last
 *  24 hours. */
export type VendorViewsPeriod = 'day' | 'week' | 'month';

/**
 * The overview's Views tile (AECI-983), shipped as a PLACEHOLDER.
 *
 * A real vendor view count needs the `analytics.view` gate, owner-visit
 * exclusion (AECI-934), pair-page attribution (AECI-929), the privacy-policy
 * sentence (AECI-942) and wireframes (AECI-939) first. So this tile makes no
 * server read and shows no number. AECI-941 wires the figure: it binds a count to
 * the tile and listens to {@link periodChange}, without touching the toggle.
 *
 * Accepted trade-off until then: the toggle changes only the sentence.
 *
 * ── THE TOGGLE ──────────────────────────────────────────────────────────────
 * A `fieldset` of `aria-pressed` buttons, the shipped admin date-range control
 * (`admin/traffic/traffic.html`). Angular Aria@22 has no radio group, so ADR 0010
 * offers nothing better for a three-way choice. The pressed colour is the
 * unlayered `.aec-period[aria-pressed='true']` rule in `styles.css`, because a
 * utility toggled by state loses to the resting utilities.
 *
 * Visible text is "1d" and the accessible name is "1d, last day", so WCAG 2.5.3
 * Label in Name holds and speech input can say "click 1d".
 *
 * ── COPY ────────────────────────────────────────────────────────────────────
 * No "Verified" wording and no capability claim (`STAGE_2_5_SPEC.md` §7.1), and
 * no link onward, because there is nowhere to go yet and a link to nothing is a
 * dead end.
 */
@Component({
  selector: 'aec-vendor-views-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="flex h-full flex-col gap-2 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
    >
      <div class="flex min-h-9 md:min-h-12 flex-wrap items-center justify-between gap-3">
        <p class="text-sm text-(--text-secondary)" i18n="@@vendor.overview.views.label">Views</p>
        <fieldset class="m-0 min-w-0 border-0 p-0">
          <legend class="sr-only" i18n="@@vendor.overview.views.legend">Views period</legend>
          <div
            class="flex gap-0.5 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-0.5"
          >
            @for (option of options; track option.key) {
              <button
                type="button"
                class="aec-period inline-flex min-h-7 min-w-8 cursor-pointer items-center justify-center rounded-(--radius-sm) px-2 text-xs font-semibold text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                [attr.aria-pressed]="period() === option.key"
                [attr.aria-label]="option.name"
                (click)="select(option.key)"
              >
                {{ option.short }}
              </button>
            }
          </div>
        </fieldset>
      </div>
      <p class="font-display text-lg font-semibold text-(--text-primary)" data-views-sentence>
        {{ sentence() }}
      </p>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorViewsTile {
  protected readonly period = signal<VendorViewsPeriod>('week');

  /** Emits the chosen window. AECI-941 fetches on it. */
  readonly periodChange = output<VendorViewsPeriod>();

  protected readonly options: readonly {
    key: VendorViewsPeriod;
    short: string;
    name: string;
  }[] = [
    {
      key: 'day',
      short: $localize`:@@vendor.overview.views.period.day.short:1d`,
      name: $localize`:@@vendor.overview.views.period.day.name:1d, last day`,
    },
    {
      key: 'week',
      short: $localize`:@@vendor.overview.views.period.week.short:1w`,
      name: $localize`:@@vendor.overview.views.period.week.name:1w, last 7 days`,
    },
    {
      key: 'month',
      short: $localize`:@@vendor.overview.views.period.month.short:1m`,
      name: $localize`:@@vendor.overview.views.period.month.name:1m, last 30 days`,
    },
  ];

  protected readonly sentence = computed(() => {
    switch (this.period()) {
      case 'day':
        return $localize`:@@vendor.overview.views.soon.day:View counts for the last day are on their way.`;
      case 'month':
        return $localize`:@@vendor.overview.views.soon.month:View counts for the last 30 days are on their way.`;
      default:
        return $localize`:@@vendor.overview.views.soon.week:View counts for the last 7 days are on their way.`;
    }
  });

  protected select(period: VendorViewsPeriod): void {
    if (this.period() === period) return;
    this.period.set(period);
    this.periodChange.emit(period);
  }
}
