import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * `VerifiedBadge` (AECI-523) — the public trust-surface indicator for the
 * **AECi-verified vendor account** bit (`vendors.verified`, flipped by the
 * AECI-519 claim grant). Rendered on the SSR detail surfaces wherever a
 * vendor is shown: the vendor detail hero, the product detail "Vendor" card,
 * and the product-pair rail (`STAGE_2_VENDOR_PORTAL_SPEC.md` §8.1).
 *
 * What it means — and what it must NOT be read as: it confirms the vendor's
 * **account** is AECi-verified (they claimed and manage their AECi profile). It
 * is **not** a measure of product quality, an endorsement, a paid-placement, or
 * a ranking signal (no pay-for-placement). Do not conflate it with the
 * `AgreementBadge` "Unverified · AECi" claim/data-flow state, nor with the
 * review/rating anatomy — hence the deliberately distinct **pill** shape, which
 * `DESIGN.md` reserves for exactly this badge (§Badges, kept distinct from the
 * `rounded.sm` integration `badge-verified` and the taxonomy chips).
 *
 * Renders **nothing** when `verified` is false — the free/default "Unverified"
 * baseline on the public surface is the *absence* of the badge (the explicit
 * "Unverified" caption stays a vendor-dashboard concept, `vendor-verified-status.ts`).
 * `:host { display: contents }` keeps an unverified badge from leaving a flex gap.
 *
 * Quiet editorial pill: Forest-soft wash + Forest text + 0.5px Forest border +
 * a shield-check glyph (`DESIGN.md` "Borders-Not-Shadows"). Forest text on
 * `--accent-primary-soft` measures 10.80:1 (AA). Meaning rides on the visible
 * label (`full`) or the `aria-label` (`compact`) — never colour alone
 * (WCAG 1.4.1). Light theme only (Stage 1 / AECI-226).
 *
 * The `compact` variant is icon-only (for dense contexts like the pair rail);
 * `full` shows the label text. AECI-529 reuses this component + copy for the
 * search surfaces.
 */
@Component({
  selector: 'aec-verified-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (verified()) {
      <span
        class="inline-flex items-center rounded-full border border-(--accent-primary)
          bg-(--accent-primary-soft) font-semibold tracking-[0.01em] text-(--accent-primary)"
        [class]="sizeClass()"
        [attr.aria-label]="ariaLabel()"
        [title]="tooltip()"
      >
        <svg
          aria-hidden="true"
          class="shrink-0"
          [class]="iconSizeClass()"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
          />
          <path d="m9 12 2 2 4-4" />
        </svg>
        @if (variant() === 'full') {
          <span i18n="@@verified.badge.label">Verified vendor</span>
        }
      </span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class VerifiedBadge {
  /** The vendor's `vendors.verified` bit. Badge renders only when true. */
  readonly verified = input.required<boolean>();
  /** `full` shows the label; `compact` is icon-only for dense rails. */
  readonly variant = input<'full' | 'compact'>('full');

  /**
   * `full` shows the visible label, which is the accessible name (icon is
   * aria-hidden) — so no `aria-label` (mirrors `TaxonomyBadge`'s null-when-
   * visible-text-suffices pattern). `compact` is icon-only, so it must carry the
   * label as its accessible name.
   */
  protected readonly ariaLabel = computed<string | null>(() =>
    this.variant() === 'compact' ? $localize`:@@verified.badge.label:Verified vendor` : null,
  );

  /** Supplemental hover explanation — deliberately non-overclaiming copy. */
  protected readonly tooltip = computed<string>(
    () =>
      $localize`:@@verified.badge.tooltip:AECi-verified vendor account: the vendor has claimed and manages their AECi profile. Not a rating of product quality or an endorsement.`,
  );

  protected readonly sizeClass = computed<string>(() =>
    this.variant() === 'full' ? 'gap-1.5 px-2.5 py-0.5 text-xs' : 'gap-0 px-1.5 py-1 text-xs',
  );

  protected readonly iconSizeClass = computed<string>(() =>
    this.variant() === 'full' ? 'h-4 w-4' : 'h-3.5 w-3.5',
  );
}
