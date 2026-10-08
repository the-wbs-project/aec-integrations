import { ChangeDetectionStrategy, Component, output } from '@angular/core';

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
 * The 1d / 1w / 1m toggle is hidden until there is a figure to window, so the
 * tile says only "Coming soon". AECI-941 brings back a `fieldset` of
 * `aria-pressed` buttons (the admin date-range control in
 * `admin/traffic/traffic.html`, pressed colour from `.aec-period` in
 * `styles.css`), with visible text "1d" and accessible name "1d, last day" so
 * WCAG 2.5.3 Label in Name holds.
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
      <div class="flex min-h-9 md:min-h-12 items-center">
        <p class="text-sm text-(--text-secondary)" i18n="@@vendor.overview.views.label">Views</p>
      </div>
      <p
        class="font-display text-lg font-semibold text-(--text-primary)"
        i18n="@@vendor.overview.views.soon"
        data-views-sentence
      >
        Coming soon
      </p>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorViewsTile {
  /** Never emits while the period toggle is hidden. AECI-941 restores the toggle and fetches on it. */
  readonly periodChange = output<VendorViewsPeriod>();
}
