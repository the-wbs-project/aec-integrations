import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Phase 2 §11.2 — `TaxonomyBadge`. A chip-style link to a category /
 * discipline / phase browse page. Used by detail-page metadata sidebars
 * (product, vendor, integration) and by `ProductCard` / `IntegrationCard`
 * once those land.
 *
 * Visual spec:
 *   - Surface: `surface-raised` fill (light) / `dark-surface-raised` (dark)
 *   - Border: 0.5px `border-default`, raises to 1px `border-strong` on hover
 *   - Text: `text-primary`, shifts to `accent-primary` on hover (Forest in
 *     light, Dark Forest in dark) — matches the link-color contract from
 *     `DESIGN.md` §"Forest-Anchor Rule"
 *   - Typography: `label` role (Atkinson Hyperlegible 700 / 13px)
 *   - Shape: `rounded.sm` (4px) — chips, not pills (the pill shape is
 *     reserved for vendor-verified badges per the DESIGN.md badge specs)
 *
 * Accessibility:
 *   - Renders as `<a>` so it's keyboard-focusable by default
 *   - Visible focus ring via `:focus-visible` matching the global
 *     focus-ring elevation token
 *   - Visible label text is `[name]` — no aria-label override needed
 *
 * Anchor-Site Rule (DESIGN.md §"Named Rules"): pulled from the same Mobbin
 * reference site selected for the product detail surface — see the
 * `Mobbin anchor:` line on the AECI-57 commit / Linear issue.
 */
export type TaxonomyKind = 'category' | 'discipline' | 'phase';

@Component({
  selector: 'aec-taxonomy-badge',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      [routerLink]="routerLink()"
      class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-bold tracking-[0.01em]
        text-(--text-primary) no-underline transition-colors duration-150
        hover:border-(--border-strong) hover:text-(--accent-primary)
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary)
        focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
    >
      {{ name() }}
    </a>
  `,
  styles: `
    :host {
      display: inline-block;
    }
  `,
})
export class TaxonomyBadge {
  readonly kind = input.required<TaxonomyKind>();
  readonly slug = input.required<string>();
  readonly name = input.required<string>();

  protected readonly routerLink = computed(() => {
    const k = this.kind();
    const s = this.slug();
    switch (k) {
      case 'category':
        return ['/categories', s];
      case 'discipline':
        return ['/disciplines', s];
      case 'phase':
        return ['/phases', s];
    }
  });
}
